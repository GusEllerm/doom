/**
 * M12-02 — every-map L3 render corpus (M12-plan §M12-02): 9 E1 maps ×
 * ≥ 8 analytically-derived viewpoints (118 scenes, viewpointsAllMaps.ts) +
 * 9 contact-sheet montages (one per map) = the goldens set `maps`.
 *
 * Pipeline per scene (walls.test.ts idiom, same production surface):
 *   freedoom1 bytes → WadFile.parse → loadMap(map) →
 *   loadRenderWorld(+flatsFromWad) + buildRenderMapView + buildMapSprites +
 *   initLightTables(COLORMAP) → gInitGame boot → debug-convention WARP
 *   (x/y/z + floor(deg/360·2^32)) → 0 tics → renderFrame ×2 (BYTE-IDENTICAL
 *   required) → sha256(fb.indices) vs goldens/maps/meta.json + EVERY frame
 *   asserts hom == 0 AND visplane/vissprite/opening/drawseg overflow == 0
 *   (the anomaly counters) AND the frame is not single-color (>4 distinct
 *   indices at ≥50 px — renderer.test.ts a2 rule). Crowded viewpoint policy:
 *   a MAXDRAWSEGS/MAXSEGS trip means RE-PICK the viewpoint, never raise caps.
 *
 * Montage pack (D016 human gate, docs/reports/M12-montage.md): per map ONE
 * contact sheet TILING the blessed scene buffers themselves (m9montage
 * idiom — tiles are the SAME buffers the golden case hashed, cell provenance
 * asserted by crop-sha equality, never a file-name enumeration). 4 columns,
 * scale 1 (320×200), 8px 5×7-font label band + 12px title band.
 *
 * Batched/lazy (CI wall time): the WAD is parsed ONCE; per-map bundles build
 * on first touch and are reused across that map's scenes; every scene still
 * pays a fresh gInitGame boot (state isolation, walls convention).
 *
 * WAD-GATED skipIf(!hasWad) — without a wad nothing dumps and the committed
 * goldens stay untouched. Regenerate ONLY via
 *   npm run goldens:update -- --set maps --reason "..."
 * Modes (goldens-update drives): GOLDENS_MODE=update|check, GOLDENS_DUMP_DIR.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { decodeColormap, decodePlaypal } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import { buildMapFromData, type RuntimeMap } from '../../src/sim/map';
import { gInitGame } from '../../src/sim/game';
import { pTeleportMove } from '../../src/sim/pmap';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables, type LightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld, type RenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame, type SpriteTables } from '../../src/render/renderer';
import { buildRenderMapView, type RenderMapView } from '../../src/render/view';

import { degToBam } from './viewpoints';
import { MAP_NAMES, MAP_VIEWS, type MapViewpoint } from './viewpointsAllMaps';

/* ------------------------------------------------------------------ */
/* Paths + wad discovery (walls.test.ts convention)                    */
/* ------------------------------------------------------------------ */

const GOLDENS_DIR = fileURLToPath(new URL('./goldens/maps/', import.meta.url));
const META_PATH = `${GOLDENS_DIR}meta.json`;
const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
const MODE = process.env['GOLDENS_MODE'] ?? '';

function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

const WAD_PATH = findWad();
const hasWad = WAD_PATH !== undefined;

/* ------------------------------------------------------------------ */
/* Bundles: wad parsed once, per-map world built lazily                */
/* ------------------------------------------------------------------ */

interface Bundle {
  readonly sim: RuntimeMap;
  readonly world: RenderWorld;
  readonly view: RenderMapView;
  readonly tables: LightTables;
  readonly sprites: SpriteTables;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

let wad_: WadFile | null = null;
function wad(): WadFile {
  if (WAD_PATH === undefined) throw new Error('no wad (hasWad guard failed)');
  return (wad_ ??= WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH))));
}

let paletteRgbCache: number[] | null = null;
function paletteRgb(): number[] {
  if (paletteRgbCache === null) {
    const playpal = decodePlaypal(wad().readLumpByName('PLAYPAL')!);
    const out: number[] = [];
    for (let i = 0; i < 256; i++) {
      const rgba = playpal[i]!; // palette 0 = normal
      out.push(rgba & 0xff, (rgba >>> 8) & 0xff, (rgba >>> 16) & 0xff);
    }
    paletteRgbCache = out;
  }
  return paletteRgbCache;
}

const bundleCache = new Map<string, Bundle>();
function mapBundle(map: string): Bundle {
  let b = bundleCache.get(map);
  if (b === undefined) {
    const md = loadMap(wad(), map);
    const view = buildRenderMapView(md);
    b = {
      sim: buildMapFromData(md),
      world: loadRenderWorld(md, texturesFromWad(wad()), flatsFromWad(wad())),
      view,
      tables: initLightTables(decodeColormap(wad().readLumpByName('COLORMAP')!)),
      sprites: buildMapSprites({ md, map: view, wad: wad() })
    };
    bundleCache.set(map, b);
  }
  return b;
}

/* ------------------------------------------------------------------ */
/* Scene render (boot → warp → renderFrame ×2 + per-frame assertions)  */
/* ------------------------------------------------------------------ */

/** Scene buffers kept for the montage tiles ("tile the scenes themselves"). */
const rendered = new Map<string, Uint8Array>();

function renderScene(vp: MapViewpoint): Framebuffer {
  const bundle = mapBundle(vp.map);
  const state = gInitGame(bundle.sim);
  const p = state.players[0]!;
  const mo = p.mo;
  // __doom.warp semantics (debug.ts:509-524): P_TeleportMove relinks and
  // refreshes floorz/ceilingz, then z = floorz (ONFLOORZ resolved, NOT the
  // renderer's floor-0 placeholder).
  const moved = pTeleportMove(state.pmap, mo, (vp.x * FRACUNIT) | 0, (vp.y * FRACUNIT) | 0);
  expect(moved, `${vp.name}: warp position landed in solid geometry`);
  mo.z = mo.floorz;
  mo.angle = degToBam(vp.angleDeg);
  const fb = new Framebuffer();
  const deps = { fb, world: bundle.world, map: bundle.view, player: { mo }, tables: bundle.tables, sprites: bundle.sprites };
  const c1 = renderFrame(deps);
  const a = new Uint8Array(fb.indices);
  const c2 = renderFrame(deps);
  for (const [i, c] of [c1, c2].entries()) {
    const n = i + 1;
    expect(c.hom, `${vp.name}: hom must be 0 (render ${n})`).toBe(0);
    expect(c.visplaneOverflow, `${vp.name}: MAXVISPLANES hit (render ${n}) — re-pick or fix, never raise caps`).toBe(0);
    expect(c.visspriteOverflow, `${vp.name}: MAXVISSPRITES hit (render ${n}) — re-pick, never raise caps`).toBe(0);
    expect(c.openingOverflow, `${vp.name}: openings pool overflow (render ${n})`).toBe(0);
    expect(c.drawsegOverflow, `${vp.name}: MAXDRAWSEGS hit (render ${n}) — RE-PICK the viewpoint (plan §M12-02), never raise caps`).toBe(0);
  }
  expect(
    new Uint8Array(fb.indices).every((v, i) => v === a[i]),
    `${vp.name}: same viewpoint rendered twice must be byte-identical (L3)`
  ).toBe(true);
  // anomaly filter (plan §M12-02 "no single-color"): > 4 distinct palette
  // indices at >= 50 px each (renderer.test.ts a2 rule) — a flat/black
  // frame can never pass it.
  const counts = new Map<number, number>();
  for (const v of fb.indices) counts.set(v, (counts.get(v) ?? 0) + 1);
  let distinct = 0;
  for (const [v, n] of counts) if (v !== 0 && (n ?? 0) >= 50) distinct++;
  expect(distinct, `${vp.name}: single-color/anomaly frame (${distinct} distinct colors)`).toBeGreaterThan(4);
  rendered.set(vp.name, new Uint8Array(fb.indices));
  return fb;
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function wadSha256(): string {
  return sha256Of(readFileSync(WAD_PATH!));
}

interface MetaFile {
  schema?: number;
  scenes?: Record<string, { indexSha256?: string; kind?: string }>;
}
function readMeta(): MetaFile {
  if (!existsSync(META_PATH)) {
    throw new Error(`maps goldens meta missing: ${META_PATH} — run npm run goldens:update -- --set maps --reason "..."`);
  }
  return JSON.parse(readFileSync(META_PATH, 'utf8')) as MetaFile;
}

function dump(name: string, fb: { indices: Uint8Array; width: number; height: number }, vp: MapViewpoint | null, kind: string): void {
  if (DUMP_DIR === null) return;
  const base = `${DUMP_DIR}/${name}`;
  writeFileSync(`${base}.bin`, fb.indices);
  writeFileSync(
    `${base}.json`,
    JSON.stringify(
      {
        name,
        kind,
        script: vp?.note ?? 'montage: tiles the blessed scene buffers of this map',
        ...(vp === null
          ? {}
          : { viewpoint: { x: vp.x, y: vp.y, angleDeg: vp.angleDeg } }),
        width: fb.width,
        height: fb.height,
        indexSha256: sha256Of(fb.indices),
        hom: 0, // asserted 0 in renderScene — recorded for the meta trail
        paletteRgb: paletteRgb(),
        wadPath: WAD_PATH,
        wadSha256: wadSha256()
      },
      null,
      2
    ) + '\n'
  );
}

function goldenCase(vp: MapViewpoint): void {
  it(`${vp.name}: hom/anomalies 0, double-render byte-identical, sha vs golden`, () => {
    const fb = renderScene(vp);
    dump(vp.name, fb, vp, 'iwad');
    if (MODE !== 'update') {
      const golden = readMeta().scenes?.[vp.name];
      expect(golden, `golden '${vp.name}' missing from meta.json`).toBeDefined();
      expect(sha256Of(fb.indices), `${vp.name}: index sha drifted from meta.json`).toBe(golden!.indexSha256);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Montage sheets (one per map, tiled from THE scene buffers)          */
/* ------------------------------------------------------------------ */

const TILE_W = 320;
const TILE_H = 200;
const COLS = 4;
const LABEL_H = 8;
const TITLE_H = 12;

/** 5×7 bitmap font (row bytes, bit 4 = leftmost) — m9montage set. */
const FONT: Record<string, readonly number[]> = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e],
  D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f],
  F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f],
  H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e],
  J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x11, 0x11, 0x11, 0x11],
  N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d],
  R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e],
  T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e],
  V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11],
  X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04],
  Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  '0': [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e],
  '1': [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  '2': [0x0e, 0x11, 0x01, 0x06, 0x08, 0x10, 0x1f],
  '3': [0x0e, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0e],
  '4': [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02],
  '5': [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  '6': [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e],
  '7': [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e],
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  '-': [0x00, 0x00, 0x00, 0x1f, 0x00, 0x00, 0x00],
  '.': [0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0x0c]
};

function paintText(buf: Uint8Array, width: number, text: string, x0: number, y0: number): void {
  for (let ch = 0; ch < text.length; ch++) {
    const glyph = FONT[text[ch]!.toUpperCase()];
    if (glyph === undefined) continue;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if ((glyph[r]! & (1 << (4 - c))) === 0) continue;
        const x = x0 + ch * 6 + c;
        const y = y0 + r;
        if (x < 0 || x >= width || y < 0) continue;
        buf[y * width + x] = 255;
      }
    }
  }
}

function buildMontage(map: string): {
  buf: Uint8Array;
  width: number;
  height: number;
  cells: { name: string; x: number; y: number }[];
} {
  const vps = MAP_VIEWS.filter((v) => v.map === map);
  const rows = Math.ceil(vps.length / COLS);
  const width = COLS * TILE_W;
  const height = TITLE_H + rows * (TILE_H + LABEL_H);
  const buf = new Uint8Array(width * height);
  const cells: { name: string; x: number; y: number }[] = [];
  vps.forEach((vp, i) => {
    const src = rendered.get(vp.name);
    if (src === undefined) throw new Error(`montage tile '${vp.name}' not rendered yet`);
    const tx = (i % COLS) * TILE_W;
    const ty = TITLE_H + Math.floor(i / COLS) * (TILE_H + LABEL_H);
    paintText(buf, width, vp.name.slice(5), tx + 4, ty + 1); // strip 'e1mN-'
    for (let y = 0; y < TILE_H; y++) {
      const drow = (ty + LABEL_H + y) * width;
      for (let x = 0; x < TILE_W; x++) {
        const v = src[y * TILE_W + x]!;
        if (v === 0) continue;
        buf[drow + tx + x] = v;
      }
    }
    cells.push({ name: vp.name, x: tx, y: ty + LABEL_H });
  });
  paintText(buf, width, `M12 ${map} L3 CORPUS`, 8, 3);
  return { buf, width, height, cells };
}

function montageCase(map: string): void {
  const name = `${map.toLowerCase()}-montage`;
  it(`${name}: cells byte-equal the scene buffers, sha vs golden`, () => {
    const sheet = buildMontage(map);
    let painted = 0;
    for (const v of sheet.buf) if (v !== 0) painted += 1;
    expect(painted, `${name}: montage must not be blank`).toBeGreaterThan(50000);
    // PROVENANCE: every tile region (non-gutter pixels) == the exact bytes
    // the golden case hashed — tiled FROM the scenes, not enumerated.
    for (const cell of sheet.cells) {
      const src = rendered.get(cell.name)!;
      let mismatches = 0;
      for (let y = 0; y < TILE_H; y++) {
        for (let x = 0; x < TILE_W; x++) {
          const s = src[y * TILE_W + x]!;
          const t = sheet.buf[(cell.y + y) * sheet.width + cell.x + x]!;
          if (s !== 0 && s !== t) mismatches++;
        }
      }
      expect(mismatches, `${cell.name}: tile region drifted from its scene buffer`).toBe(0);
    }
    dump(name, { indices: sheet.buf, width: sheet.width, height: sheet.height }, null, 'montage');
    if (MODE !== 'update') {
      const golden = readMeta().scenes?.[name];
      expect(golden, `golden '${name}' missing from meta.json`).toBeDefined();
      expect(sha256Of(sheet.buf), `${name}: index sha drifted from meta.json`).toBe(golden!.indexSha256);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe.skipIf(!hasWad)('maps goldens — freedoom1 E1M1..E1M9 (skipIf no wad)', () => {
  for (const map of MAP_NAMES) {
    describe(` ${map}`, () => {
      for (const vp of MAP_VIEWS.filter((v) => v.map === map)) goldenCase(vp);
    });
  }
  for (const map of MAP_NAMES) montageCase(map);
});

describe('maps golden harness self-checks', () => {
  it('viewpoint table: 9 maps, >= 8 views each (plan gate), >= 72 total, names unique', () => {
    expect(new Set(MAP_VIEWS.map((v) => v.map)).size).toBe(9);
    for (const map of MAP_NAMES) {
      expect(MAP_VIEWS.filter((v) => v.map === map).length, `${map}: >= 8 viewpoints`).toBeGreaterThanOrEqual(8);
    }
    expect(MAP_VIEWS.length, 'plan gate: >= 72 goldens before montages').toBeGreaterThanOrEqual(72);
    expect(new Set(MAP_VIEWS.map((v) => v.name)).size, 'scene names unique').toBe(MAP_VIEWS.length);
  });
  it.skipIf(!hasWad)('IWAD scenes run against a discovered wad', () => {
    expect(WAD_PATH).toBeDefined();
  });
});
