/**
 * Dev-only WAD debug viewer (M1-08). Loads an IWAD over HTTP, parses it with
 * the src/wad decoders, and previews flats / patches / TEXTURE1 textures /
 * sprites through PLAYPAL bank palettes (+ optional COLORMAP dimming) into
 * small ImageData canvases. TOOL page: correctness over beauty. No sim/
 * render/engine imports (zone-safe); does not install __doom and never
 * touches the game page.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { decodeFlat } from '../wad/flat';
import { decodePalettes, NUM_PALETTES, NUM_COLORMAP_ROWS } from '../wad/palettes';
import { decodePatch } from '../wad/patch';
import { buildSpriteDefs, frameLetter, type SpriteCensus } from '../wad/sprites';
import { texturesFromWad } from '../wad/texture';
import { WadFile } from '../wad/wadfile';
import { blitColumns, blitFlat, type BlitContext } from './blit';
import {
  buildRows,
  filterRows,
  hexDump,
  looksLikePatchHeader,
  looksLikeFlatName,
  pageSlice,
  type LumpRow,
} from './classify';
import { fetchWad, WadLoadError } from '../platform/wadload';

const PAGE_SIZE = 100;
const HEX_LIMIT = 2048;

interface ViewerState {
  wad: WadFile | null;
  rows: LumpRow[];
  filtered: LumpRow[];
  page: number;
  selected: number; // lump num, -1 none
  census: SpriteCensus | null;
  textureNames: string[];
  textureMap: Map<string, { width: number; height: number; columns: Uint8Array[] }> | null;
  selectedSprite: string | null;
  selectedTexture: string | null;
  base: Uint32Array;
  colormap: Uint8Array | null;
  bank: number;
  lightLevel: number;
  useColormap: boolean;
  rerender: (() => void) | null;
}

const state: ViewerState = {
  wad: null,
  rows: [],
  filtered: [],
  page: 0,
  selected: -1,
  census: null,
  textureNames: [],
  textureMap: null,
  selectedSprite: null,
  selectedTexture: null,
  base: new Uint32Array(NUM_PALETTES * 256),
  colormap: null,
  bank: 0,
  lightLevel: 0, // COLORMAP row 0 = full bright (R02 §3)
  useColormap: false,
  rerender: null,
};

/* ------------------------------------------------------------------ */
/* Tiny DOM helpers                                                     */
/* ------------------------------------------------------------------ */

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'testId') node.dataset['testId'] = v;
    else node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

function byTestId<T extends HTMLElement>(id: string): T {
  const node = document.querySelector<T>(`[data-test-id="${id}"]`);
  if (node === null) throw new Error(`missing [data-test-id="${id}"]`);
  return node;
}

function makeCanvas(w: number, h: number, testId: string, scale = 2): HTMLCanvasElement {
  const c = el('canvas', { testId, width: String(w), height: String(h), class: 'px' });
  c.style.width = `${Math.max(64, w * scale)}px`;
  c.style.height = `${Math.max(64, h * scale)}px`;
  return c;
}

const imageDataOf = new WeakMap<HTMLCanvasElement, ImageData>();

function blitInto(canvas: HTMLCanvasElement): BlitContext {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('2D canvas context unavailable');
  const img = ctx.createImageData(canvas.width, canvas.height);
  imageDataOf.set(canvas, img);
  return {
    data: img.data,
    width: canvas.width,
    height: canvas.height,
    base: state.base,
    bank: state.bank,
    colormapRow: colormapRow(),
  };
}

function commit(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d');
  const img = imageDataOf.get(canvas);
  if (ctx === null || img === undefined) throw new Error('canvas not prepared for blit');
  ctx.putImageData(img, 0, 0);
}

function colormapRow(): Uint8Array | null {
  if (!state.useColormap || state.colormap === null) return null;
  return state.colormap.subarray(state.lightLevel * 256, state.lightLevel * 256 + 256);
}

/* ------------------------------------------------------------------ */
/* Load + status                                                        */
/* ------------------------------------------------------------------ */

function setStatus(kind: 'loading' | 'loaded' | 'missing', detail: string): void {
  const box = byTestId<HTMLElement>('wad-status');
  box.textContent = `${kind}: ${detail}`;
  box.setAttribute('data-state', kind);
  byTestId<HTMLElement>('wad-picker').hidden = kind !== 'missing';
  byTestId<HTMLElement>('wad-loaded').hidden = kind !== 'loaded';
  byTestId<HTMLElement>('wad-missing').hidden = kind !== 'missing';
}

function afterLoad(buf: ArrayBuffer, source: string): void {
  let wad: WadFile;
  try {
    wad = WadFile.parse(buf);
  } catch (err) {
    setStatus('missing', `parse failed for ${source}: ${String(err)}`);
    return;
  }
  state.wad = wad;
  if (wad.has('PLAYPAL')) {
    const colormap = wad.has('COLORMAP') ? wad.readLumpByName('COLORMAP') : null;
    const pals = decodePalettes(wad.readLumpByName('PLAYPAL'), colormap ?? new Uint8Array(NUM_COLORMAP_ROWS * 256).fill(0));
    // Without COLORMAP, use identity rows so the toggle still works as no-op.
    state.base = pals.base;
    state.colormap = colormap !== null ? pals.colormapRows : identityColormap();
  }
  state.rows = buildRows(
    lumpCount(wad),
    (i) => wad.lumpName(i),
    (i) => wad.readLump(i).byteLength,
  );
  state.filtered = state.rows;
  ensureCensus();
  byTestId<HTMLElement>('lump-count').textContent = String(state.rows.length);
  setStatus('loaded', `${source} — ${state.rows.length} lumps (${wad.identification})`);
  renderLumpPage();
  const params = new URLSearchParams(location.search);
  const lumpName = params.get('lump');
  if (lumpName !== null) selectLumpByName(lumpName);
  const spriteName = params.get('sprite');
  if (spriteName !== null) openSprite(spriteName.toUpperCase());
  const textureName = params.get('texture');
  if (textureName !== null) openTexture(textureName.toUpperCase());
}

function identityColormap(): Uint8Array {
  const rows = new Uint8Array(NUM_COLORMAP_ROWS * 256);
  for (let r = 0; r < NUM_COLORMAP_ROWS; r++) {
    for (let i = 0; i < 256; i++) rows[r * 256 + i] = i;
  }
  return rows;
}

function lumpCount(wad: WadFile): number {
  // WadFile exposes dir indexing via lumpNumAt; probe-count is O(n) but the
  // directory is small — the entries array itself is private.
  let n = 0;
  while (wad.lumpNumAt(n) >= 0) n++;
  return n;
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const url = params.get('wad') ?? '/wads/freedoom1.wad';
  setStatus('loading', url);
  try {
    const buf = await fetchWad(url);
    afterLoad(buf, url);
  } catch (err) {
    if (!(err instanceof WadLoadError)) throw err; // parse/decoder bugs may throw — surfaced as text below
    setStatus('missing', `${url} not available (${err.message}). Pick a WAD file:`);
  }
}

/* ------------------------------------------------------------------ */
/* Lump table                                                           */
/* ------------------------------------------------------------------ */

function renderLumpPage(): void {
  const tbody = byTestId<HTMLElement>('lump-rows');
  const wad = state.wad;
  tbody.replaceChildren();
  const win = pageSlice(state.filtered.length, state.page, PAGE_SIZE);
  state.page = win.page;
  byTestId<HTMLElement>('lump-page').textContent = `page ${win.page + 1}/${win.pageCount}`;
  if (wad === null) return;
  for (const row of state.filtered.slice(win.start, win.end)) {
    const tr = el('tr', { testId: 'lump-row', class: row.num === state.selected ? 'sel' : '' });
    const nameBtn = el('td', {}, '');
    const button = el('button', { testId: 'lump-select', 'data-lump-name': row.name }, row.name);
    button.addEventListener('click', () => selectLumpByName(row.name));
    nameBtn.replaceChildren(button);
    tr.replaceChildren(
      el('td', {}, String(row.num)),
      nameBtn,
      el('td', {}, String(row.size)),
      el('td', {}, row.kind),
    );
    tbody.appendChild(tr);
  }
}

function selectLumpByName(name: string): void {
  const wad = state.wad;
  if (wad === null) return;
  const num = wad.lumpNumByName(name);
  if (num < 0) return;
  state.selected = num;
  showLumpPreview(num);
  renderLumpPage();
}

/* ------------------------------------------------------------------ */
/* Preview panel                                                        */
/* ------------------------------------------------------------------ */

function showLumpPreview(num: number): void {
  const wad = state.wad;
  if (wad === null) return;
  const name = wad.lumpName(num);
  const bytes = wad.readLump(num);
  const info = byTestId<HTMLElement>('preview-info');
  const gfx = byTestId<HTMLElement>('preview-graphic');
  gfx.replaceChildren();
  byTestId<HTMLElement>('preview-name').textContent =
    `#${num} ${name} (${bytes.byteLength} bytes)`;

  let detail = '';
  const spriteSite = state.census?.lumpToSprite.get(num);
  if (spriteSite !== undefined && spriteSite !== null) {
    const def = (state.census as SpriteCensus).sprites[spriteSite.sprite];
    detail = `sprite ${def?.name4 ?? '?'} frame ${frameLetter(spriteSite.frame)} rot ${spriteSite.rot}${spriteSite.flip ? ' (mirrored)' : ''}`;
    const canvas = makeCanvas(1, 1, 'preview-canvas');
    gfx.appendChild(canvas);
    drawPatchLump(canvas, num, spriteSite.flip);
  } else if (bytes.byteLength === 4096 && looksLikeFlatName(name)) {
    detail = 'flat 64x64';
    const flat = decodeFlat(bytes, name);
    const canvas = makeCanvas(64, 64, 'preview-canvas');
    gfx.appendChild(canvas);
    const b = blitInto(canvas);
    blitFlat(b, flat.pixels);
    commit(canvas);
  } else if (bytes.byteLength >= 16 && looksLikePatchHeader(bytes)) {
    try {
      const patch = decodePatch(bytes);
      detail = `patch ${patch.width}x${patch.height} offsets ${patch.leftOffset},${patch.topOffset}`;
      const canvas = makeCanvas(Math.max(1, patch.width), Math.max(1, patch.height), 'preview-canvas');
      gfx.appendChild(canvas);
      const b = blitInto(canvas);
      blitColumns(b, patch.columns, 0, 0, false, true);
      commit(canvas);
    } catch {
      detail = bytes.byteLength === 4096 ? 'flat 64x64 (by size)' : 'not a graphic';
      if (bytes.byteLength === 4096) {
        const flat = decodeFlat(bytes, name);
        const canvas = makeCanvas(64, 64, 'preview-canvas');
        gfx.appendChild(canvas);
        const b = blitInto(canvas);
        blitFlat(b, flat.pixels);
        commit(canvas);
      }
    }
  } else {
    detail = 'not a graphic (hex only)';
  }
  info.textContent = detail;
  byTestId<HTMLElement>('hex-preview').textContent = hexDump(bytes, HEX_LIMIT);
  state.rerender = () => showLumpPreview(num);
}

function drawPatchLump(canvas: HTMLCanvasElement, lumpNum: number, flip: boolean): void {
  const wad = state.wad;
  if (wad === null) return;
  const patch = decodePatch(wad.readLump(lumpNum));
  canvas.width = Math.max(1, patch.width);
  canvas.height = Math.max(1, patch.height);
  canvas.style.width = `${Math.max(64, patch.width * 2)}px`;
  canvas.style.height = `${Math.max(64, patch.height * 2)}px`;
  const b = blitInto(canvas);
  blitColumns(b, patch.columns, 0, 0, flip, true);
  commit(canvas);
}

/* ------------------------------------------------------------------ */
/* Textures tab                                                         */
/* ------------------------------------------------------------------ */

function ensureTextures(): void {
  const wad = state.wad;
  if (wad === null || state.textureMap !== null) return;
  const map = texturesFromWad(wad);
  state.textureMap = map as ViewerState['textureMap'];
  state.textureNames = [...map.keys()].sort();
  renderTextureList('');
}

function renderTextureList(query: string): void {
  const box = byTestId<HTMLElement>('texture-rows');
  box.replaceChildren();
  const q = query.trim().toUpperCase();
  for (const name of state.textureNames) {
    if (q !== '' && !name.includes(q)) continue;
    const def = state.textureMap?.get(name);
    const row = el('button', { testId: 'texture-row' }, `${name} ${def?.width ?? '?'}x${def?.height ?? '?'}`);
    row.addEventListener('click', () => openTexture(name));
    box.appendChild(row);
  }
}

function openTexture(name: string): void {
  ensureTextures();
  showTab('textures');
  const def = state.textureMap?.get(name);
  if (def === undefined) return;
  state.selectedTexture = name;
  const gfx = byTestId<HTMLElement>('texture-preview');
  gfx.replaceChildren();
  byTestId<HTMLElement>('texture-name').textContent = name;
  const canvas = makeCanvas(def.width, def.height, 'texture-canvas', 1);
  gfx.appendChild(canvas);
  const b = blitInto(canvas);
  blitColumns(b, def.columns, 0, 0, false, true);
  commit(canvas);
  state.rerender = () => openTexture(name);
}

/* ------------------------------------------------------------------ */
/* Sprites tab                                                          */
/* ------------------------------------------------------------------ */

function ensureCensus(): SpriteCensus | null {
  if (state.census === null && state.wad !== null) {
    state.census = buildSpriteDefs(state.wad);
    byTestId<HTMLElement>('sprite-warnings').textContent =
      state.census.warnings.length === 0
        ? ''
        : `warnings: ${state.census.warnings.length}`;
  }
  return state.census;
}

function renderSpriteList(query: string): void {
  const census = ensureCensus();
  const box = byTestId<HTMLElement>('sprite-rows');
  box.replaceChildren();
  if (census === null) return;
  const q = query.trim().toUpperCase();
  for (const def of census.sprites) {
    if (q !== '' && !def.name4.includes(q)) continue;
    const row = el('button', { testId: 'sprite-row' }, def.name4);
    row.addEventListener('click', () => openSprite(def.name4));
    box.appendChild(row);
  }
}

function openSprite(name4: string): void {
  const census = ensureCensus();
  if (census === null) return;
  showTab('sprites');
  const def = census.byName.get(name4);
  if (def === undefined) return;
  state.selectedSprite = name4;
  byTestId<HTMLElement>('sprite-name').textContent = name4;
  const grid = byTestId<HTMLElement>('sprite-grid');
  grid.replaceChildren();
  for (let f = 0; f < def.frames.length; f++) {
    const frame = def.frames[f];
    if (frame === undefined) continue;
    for (let rot = 0; rot < 8; rot++) {
      const lump = frame.lump[rot];
      if (lump === undefined || lump < 0 || (!frame.rotate && rot > 0)) continue; // rot-0-only frames: single cell
      const flip = frame.flip[rot] === 1;
      const cell = el('div', { class: 'cell' }, `${frameLetter(f)}${rot + 1}${flip ? 'm' : ''}`);
      const canvas = makeCanvas(1, 1, 'sprite-cell');
      cell.appendChild(canvas);
      drawPatchLump(canvas, lump, flip);
      grid.appendChild(cell);
    }
  }
  state.rerender = () => openSprite(name4);
}

/* ------------------------------------------------------------------ */
/* Tabs + wiring                                                        */
/* ------------------------------------------------------------------ */

type TabName = 'lumps' | 'textures' | 'sprites';

function showTab(tab: TabName): void {
  for (const name of ['lumps', 'textures', 'sprites'] as const) {
    byTestId<HTMLElement>(`panel-${name}`).hidden = name !== tab;
    byTestId<HTMLElement>(`tab-${name}`).classList.toggle('active', name === tab);
  }
  if (tab === 'textures') ensureTextures();
  if (tab === 'sprites') renderSpriteList('');
}

function wire(): void {
  byTestId<HTMLElement>('tab-lumps').addEventListener('click', () => showTab('lumps'));
  byTestId<HTMLElement>('tab-textures').addEventListener('click', () => showTab('textures'));
  byTestId<HTMLElement>('tab-sprites').addEventListener('click', () => showTab('sprites'));

  const filter = byTestId<HTMLInputElement>('lump-filter');
  filter.addEventListener('input', () => {
    state.filtered = filterRows(state.rows, filter.value);
    state.page = 0;
    renderLumpPage();
  });
  byTestId<HTMLElement>('lump-prev').addEventListener('click', () => {
    state.page -= 1;
    renderLumpPage();
  });
  byTestId<HTMLElement>('lump-next').addEventListener('click', () => {
    state.page += 1;
    renderLumpPage();
  });

  const textureFilter = byTestId<HTMLInputElement>('texture-filter');
  textureFilter.addEventListener('input', () => renderTextureList(textureFilter.value));
  const spriteFilter = byTestId<HTMLInputElement>('sprite-filter');
  spriteFilter.addEventListener('input', () => renderSpriteList(spriteFilter.value));

  const bank = byTestId<HTMLInputElement>('palette-bank');
  bank.addEventListener('input', () => {
    state.bank = Number(bank.value);
    byTestId<HTMLElement>('palette-bank-value').textContent = String(state.bank);
    state.rerender?.();
  });
  const light = byTestId<HTMLInputElement>('light-level');
  light.addEventListener('input', () => {
    state.lightLevel = Number(light.value);
    byTestId<HTMLElement>('light-level-value').textContent = String(state.lightLevel);
    state.rerender?.();
  });
  const cm = byTestId<HTMLInputElement>('colormap-toggle');
  cm.addEventListener('change', () => {
    state.useColormap = cm.checked;
    state.rerender?.();
  });

  const picker = byTestId<HTMLInputElement>('wad-file');
  picker.addEventListener('change', () => {
    const file = picker.files?.[0];
    if (file === undefined) return;
    setStatus('loading', file.name);
    void file.arrayBuffer().then((buf) => afterLoad(buf, `file:${file.name}`));
  });
}

wire();
showTab('lumps');
void start();
