/**
 * M9-10 golden set `screens` (plan §M9-10 acceptance 4 + the D016 human-
 * eyes montage pack): the three full-screen 320×200 pages the title/
 * finale drawer seams produce — TITLEPIC page, finale TEXT at tic 200
 * (63 revealed steps of E1TEXT over the FLOOR4_8 flood), and the HELP2
 * hold frame. Pixels are the vvideo FG screen (screens[0]), NOT the 3D
 * framebuffer: the drawers are the D_Display GS_DEMOSCREEN/GS_FINALE
 * branches (d_main.c:259 → :434-438, f_finale.c:700), so the golden IS
 * the frame those branches will compose once renderer wiring lands
 * (banked in SALVAGE-NOTES-M9-10-audit.md).
 *
 * Pipeline (goldens-update --set screens):
 *   boot E1M1 (gInitGame) → [dInit + gFlowTic | fStartFinale + F_Ticker×N]
 *   → drawer seam → sha256(screens[FG]) (double-draw byte-equal)
 *   + montage (3 scenes tiled 3×2 at 2×, 5×7 labels, cell provenance
 *   asserted against the cached scene buffers — M7-11 rework idiom).
 * WAD-GATED (skipIf no wad): TITLEPIC/HELP2/FLOOR4_8/STCFN come from the
 * pinned freedoom1.wad; without one nothing dumps and committed goldens
 * stay untouched.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { WadFile } from '../../src/wad/wadfile';
import { loadMap } from '../../src/wad/mapdata';
import { decodePlaypal } from '../../src/wad/palettes';
import { buildMapFromData } from '../../src/sim/map';
import { gFlowTic, gInitGame, resetGameFlow } from '../../src/sim/game';
import { emptyInput } from '../../src/sim/ticcmd';
import type { GameState } from '../../src/sim/state';
import { FG, screens, vInit } from '../../src/render/vvideo';
import { dInit, dPageDrawer, dRegisterFlow, dReset, dSetWad } from '../../src/ui/title';
import {
  fDrawer,
  fRegisterFlow,
  fReset,
  fSetWad,
  fStartFinale,
  fTicker
} from '../../src/ui/finale';

/* ------------------------------------------------------------------ */
/* wad + modes                                                          */
/* ------------------------------------------------------------------ */

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

const GOLDENS_DIR = fileURLToPath(new URL('./goldens/screens/', import.meta.url));
const META_PATH = `${GOLDENS_DIR}meta.json`;
const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
const MODE = process.env['GOLDENS_MODE'] ?? '';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

function sha256Of(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

interface Bundle {
  wad: WadFile;
  sim: ReturnType<typeof buildMapFromData>;
  paletteRgb: number[];
}

let bundle: Bundle | null = null;
function bundle_(): Bundle {
  if (bundle === null) {
    if (WAD_PATH === undefined) throw new Error('no wad (hasWad guard failed)');
    const wad = WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH)));
    const playpal = decodePlaypal(wad.readLumpByName('PLAYPAL')!);
    const paletteRgb: number[] = [];
    for (let i = 0; i < 256; i++) {
      const rgba = playpal[i]!; // palette 0 = normal (patches are full-bright)
      paletteRgb.push(rgba & 0xff, (rgba >>> 8) & 0xff, (rgba >>> 16) & 0xff);
    }
    bundle = { wad, sim: buildMapFromData(loadMap(wad, 'E1M1')), paletteRgb };
  }
  return bundle;
}

/* ------------------------------------------------------------------ */
/* scenes (each a fresh boot through the drawer seams)                  */
/* ------------------------------------------------------------------ */

type Scene = 'title-pic' | 'finale-text-200' | 'finale-help2';

const SCENES: Scene[] = ['title-pic', 'finale-text-200', 'finale-help2'];

const SCRIPT: Record<Scene, string> = {
  'title-pic':
    'gInitGame -> dInit (D_StartTitle) -> gFlowTic (D_DoAdvanceDemo: TITLEPIC, pagetic 170) -> dPageDrawer',
  'finale-text-200':
    'gInitGame -> fStartFinale (FLOOR4_8 + E1TEXT) -> F_Ticker x200 -> fDrawer stage 0 (63 reveal steps at (10,10))',
  'finale-help2':
    'gInitGame -> fStartFinale -> F_Ticker x1571 (flip at >440*3+250: stage 1, wipegamestate -1) -> fDrawer HELP2 forever'
};

function runScene(scene: Scene): Uint8Array {
  const b = bundle_();
  resetGameFlow();
  dReset(b.wad);
  fReset(b.wad);
  dRegisterFlow();
  fRegisterFlow();
  vInit();
  const st: GameState = gInitGame(b.sim);
  dSetWad(b.wad);
  fSetWad(b.wad);
  const draw = (): void => {
    if (scene === 'title-pic') dPageDrawer();
    else fDrawer();
  };
  if (scene === 'title-pic') {
    dInit(st); // D_StartTitle: arms advancedemo (d_main.c:1166 tail)
    gFlowTic(st); // tic block consumes it (d_main.c:381 → :454)
  } else {
    fStartFinale(st); // F_StartFinale :96-135 (finalecount = 0)
    const n = scene === 'finale-text-200' ? 200 : 1571;
    for (let t = 0; t < n; t++) fTicker(st, emptyInput()); // F_Ticker
  }
  draw();
  const a = screens[FG]!.data.slice();
  draw(); // determinism: the same state redrawn is byte-identical
  const c = screens[FG]!.data;
  expect(sha256Of(a), `${scene}: double-draw byte-identical`).toBe(sha256Of(c));
  return a;
}

/* ------------------------------------------------------------------ */
/* montage (D016 pack): tiles THE scene buffers, M7-11 rework idiom     */
/* ------------------------------------------------------------------ */

const MONT_COLS = 3;
const MONT_SCALE = 2;
const MONT_LABEL_H = 16;
const MONT_TITLE = 'M9-10 SCREENS 3 SCENES 2X';

/** 5×7 bitmap font (row bytes, bit 4 = leftmost), as visual.test.ts. */
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
  '9': [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c]
};

function paintText(
  buf: Uint8Array,
  width: number,
  height: number,
  text: string,
  x0: number,
  y0: number
): void {
  for (let ch = 0; ch < text.length; ch++) {
    const glyph = FONT[text[ch]!.toUpperCase()];
    if (glyph === undefined) continue;
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 5; c++) {
        if ((glyph[r]! & (1 << (4 - c))) === 0) continue;
        for (let dy = 0; dy < MONT_SCALE; dy++) {
          for (let dx = 0; dx < MONT_SCALE; dx++) {
            const x = x0 + ch * 6 * MONT_SCALE + c * MONT_SCALE + dx;
            const y = y0 + r * MONT_SCALE + dy;
            if (x < 0 || x >= width || y < 0 || y >= height) continue;
            buf[y * width + x] = 255; // white
          }
        }
      }
    }
  }
}

const sceneCache = new Map<string, Uint8Array>();
function sceneFrame(scene: Scene): Uint8Array {
  let hit = sceneCache.get(scene);
  if (hit === undefined) {
    hit = runScene(scene);
    sceneCache.set(scene, hit);
  }
  return hit;
}

function buildMontage(): {
  buf: Uint8Array;
  width: number;
  height: number;
  cells: { name: string; x: number; y: number; w: number; h: number }[];
} {
  const cellW = 320 * MONT_SCALE;
  const cellH = 200 * MONT_SCALE;
  const tileH = cellH + MONT_LABEL_H;
  const rows = Math.ceil((SCENES.length + 1) / MONT_COLS); // + title cell
  const width = MONT_COLS * cellW;
  const height = rows * tileH;
  const buf = new Uint8Array(width * height);
  const cells: { name: string; x: number; y: number; w: number; h: number }[] = [];
  SCENES.forEach((scene, i) => {
    const src = sceneFrame(scene);
    const tx = (i % MONT_COLS) * cellW;
    const ty = Math.floor(i / MONT_COLS) * tileH;
    paintText(buf, width, height, scene.replace(/-/g, ' '), tx + 4, ty + 1);
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 320; x++) {
        const v = src[y * 320 + x]!;
        if (v === 0) continue; // black gutter shows through transparent 0
        const px = tx + x * MONT_SCALE;
        const py = ty + MONT_LABEL_H + y * MONT_SCALE;
        for (let dy = 0; dy < MONT_SCALE; dy++) {
          const row = (py + dy) * width;
          buf[row + px] = v;
          buf[row + px + 1] = v;
        }
      }
    }
    cells.push({ name: scene, x: tx, y: ty + MONT_LABEL_H, w: cellW, h: cellH });
  });
  const ti = SCENES.length;
  paintText(
    buf,
    width,
    height,
    MONT_TITLE,
    (ti % MONT_COLS) * cellW + 8,
    Math.floor(ti / MONT_COLS) * tileH + MONT_LABEL_H + cellH / 2 - 7
  );
  return { buf, width, height, cells };
}

/* ------------------------------------------------------------------ */
/* tests                                                                */
/* ------------------------------------------------------------------ */

function goldenCase(scene: Scene): void {
  it(`${scene}: full-screen drawer frame (double-draw equal, sha vs meta)`, () => {
    const buf = sceneFrame(scene);
    const sha = sha256Of(buf);
    if (DUMP_DIR !== null) {
      const b = bundle_();
      writeFileSync(`${DUMP_DIR}/${scene}.bin`, buf);
      writeFileSync(
        `${DUMP_DIR}/${scene}.json`,
        JSON.stringify(
          {
            name: scene,
            kind: 'screen-script',
            script: SCRIPT[scene],
            width: 320,
            height: 200,
            indexSha256: sha,
            paletteRgb: b.paletteRgb
          },
          null,
          2
        ) + '\n'
      );
    }
    if (MODE !== 'update') {
      const meta = existsSync(META_PATH)
        ? (JSON.parse(readFileSync(META_PATH, 'utf8')) as {
            scenes?: Record<string, { indexSha256?: string }>;
          })
        : {};
      expect(meta.scenes?.[scene]?.indexSha256, `${scene}: sha vs committed golden`).toBe(sha);
    }
  });
}

describe.skipIf(!hasWad)('M9-10 screens golden set (goldens/screens)', () => {
  for (const scene of SCENES) goldenCase(scene);

  it('montage: contact sheet TILING the scene frames (3x2, 2x)', () => {
    const { buf, width, height, cells } = buildMontage();
    expect(cells.length, 'one tile per scene').toBe(SCENES.length);
    let painted = 0;
    for (const v of buf) if (v !== 0) painted += 1;
    expect(painted, 'montage must not be blank').toBeGreaterThan(2000);
    // PROVENANCE: every cell IS the blessed scene upscaled ×2.
    for (const cell of cells) {
      const src = sceneFrame(cell.name as Scene);
      for (let y = 0; y < 200; y += 2) {
        for (let x = 0; x < 320; x += 2) {
          const v = src[y * 320 + x]!;
          const px = cell.x + x * MONT_SCALE;
          const py = cell.y + y * MONT_SCALE;
          expect(buf[py * width + px], `${cell.name} cell (${x},${y})`).toBe(v);
          if (v !== 0) {
            expect(buf[py * width + px + 1], `${cell.name} cell (${x},${y})+1`).toBe(v);
            expect(buf[(py + 1) * width + px], `${cell.name} cell (${x},${y})+row`).toBe(v);
          }
        }
      }
    }
    const sha = sha256Of(buf);
    if (DUMP_DIR !== null) {
      const b = bundle_();
      writeFileSync(`${DUMP_DIR}/montage.bin`, buf);
      writeFileSync(
        `${DUMP_DIR}/montage.json`,
        JSON.stringify(
          {
            name: 'montage',
            kind: 'montage',
            script: 'scene-frame contact sheet: 3 screens tiled 3x2, 2x nearest-neighbour, 2x 5x7 labels (D016 pack)',
            width,
            height,
            indexSha256: sha,
            paletteRgb: b.paletteRgb
          },
          null,
          2
        ) + '\n'
      );
    }
    if (MODE !== 'update') {
      const meta = existsSync(META_PATH)
        ? (JSON.parse(readFileSync(META_PATH, 'utf8')) as {
            scenes?: Record<string, { indexSha256?: string }>;
          })
        : {};
      if (meta.scenes?.['montage'] !== undefined) {
        expect(meta.scenes['montage'].indexSha256, 'montage sha vs committed').toBe(sha);
      }
    }
  });
});
