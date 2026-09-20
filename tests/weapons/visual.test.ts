/**
 * M7-10 — weapon visual pack (docs/design/M7-plan.md §M7-10 + §5.5 L5
 * screenshot pack; D016 visual gate): golden FULL-FRAME scenes with the
 * gun RAISED and the MUZZLE FLASH live, subset per weapon family, plus
 * ONE labelled montage contact sheet tiling every weapon/flash sprite
 * frame enumerated from the 967-state table.
 *
 * Pipeline (identical seam to main.ts — the point of this suite):
 *   M7 firing-range fixture (m7Fixtures.weaponRangeSpec, geometry wad-free)
 *   → gInitGame → give/weaponKey/attack script over REAL gTicker tics
 *   → self-syncing capture (raise complete ⇒ pspr sy == WEAPONTOP; flash ⇒
 *     PS_FLASH state != S_NULL; punch ⇒ weapon state != readystate)
 *   → renderFrame ×2 (world pass + psprite pass through
 *     src/pspriteview.ts + renderer deps.psprites — byte-identical pair)
 *   → sha256(fb.indices) vs tests/render/goldens/weapons/meta.json,
 *     hom == 0 + all overflow counters == 0.
 *
 * Sprite/patch/lump truth is the WAD (freedoom1) — the fixture maps carry
 * no graphics, so the whole set is skipIf(!hasWad), exactly like the E1M1
 * wall scenes (goldens-update --set weapons with no wad dumps nothing and
 * leaves committed goldens untouched). WALLS/AUTOMAP goldens are UNAFFECTED
 * by construction: deps.psprites is omitted there, and the renderer's
 * psprite pass only draws when it is present — the regression below asserts
 * the gun-off frame equals the no-psprites frame byte for byte.
 *
 * Modes: GOLDENS_MODE=update (dump only), GOLDENS_MODE=check (dump+assert),
 * plain run (assert vs meta), GOLDENS_DUMP_DIR (the ONLY write path) — the
 * shared goldens-update.mjs convention (see scripts/goldens-update.mjs).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { buildFixtureMapWad } from '../fixtures/mapBuilder';
import { weaponRangeSpec } from '../fixtures/m7Fixtures';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { decodeColormap, decodePlaypal } from '../../src/wad/palettes';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame, gTicker } from '../../src/sim/game';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import type { GameState } from '../../src/sim/state';
import {
  attachPsprFields,
  WEAPONTOP,
  WP_NOCHANGE,
  AM_CELL,
  AM_CLIP,
  AM_SHELL,
  WEAPONINFO
} from '../../src/sim/p_pspr';
import { stateFrame, stateNext, stateSprite, FF_FRAMEMASK } from '../../src/wad/info/states';
import { sprnames } from '../../src/wad/info/sprnames';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame } from '../../src/render/renderer';
import { buildRenderMapView } from '../../src/render/view';
import { frameLump, lookupFrame } from '../../src/render/rthings';
import { buildPspriteFrameInput } from '../../src/pspriteview';
import { fixTexValue } from '../render/viewpoints';

/* ------------------------------------------------------------------ */
/* Paths + wad discovery (walls.test.ts convention)                    */
/* ------------------------------------------------------------------ */

const GOLDENS_DIR = fileURLToPath(new URL('../render/goldens/weapons/', import.meta.url));
const META_PATH = `${GOLDENS_DIR}meta.json`;
const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
const MODE = process.env['GOLDENS_MODE'] ?? '';
if (DUMP_DIR !== null) mkdirSync(DUMP_DIR, { recursive: true });

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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/* ------------------------------------------------------------------ */
/* Bundle: fixture GEOMETRY + freedoom GRAPHICS (wad-gated)            */
/* ------------------------------------------------------------------ */

interface Bundle {
  /** Render-only map data (the sim boots its OWN RuntimeMap per scene). */
  readonly md: ReturnType<typeof loadMap>;
  readonly view: ReturnType<typeof buildRenderMapView>;
  readonly world: ReturnType<typeof loadRenderWorld>;
  readonly tables: ReturnType<typeof initLightTables>;
  readonly sprites: ReturnType<typeof buildMapSprites>;
  readonly colormaps: Uint8Array;
  readonly paletteRgb: number[];
}

let bundle: Bundle | null = null;

/** 64×128 synthetic fixture wall (walls.test.ts fixTexture pattern). */
function fixTexture(name: string): ReturnType<typeof synthTex> {
  return synthTex(name);
}
function synthTex(name: string) {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < 64; c++) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r++) col[r] = fixTexValue(c, r);
    columns.push(col);
  }
  return { name, width: 64, height: 128, patches: [], columns };
}

function bundle_(): Bundle {
  if (bundle !== null) return bundle;
  if (WAD_PATH === undefined) throw new Error('no wad (hasWad guard failed)');
  const wad = WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH)));
  const fixWad = WadFile.parse(
    toArrayBuffer(buildFixtureMapWad(weaponRangeSpec([{}]), 'FIXMAP'))
  );
  const md = loadMap(fixWad, 'FIXMAP');
  const view = buildRenderMapView(md);
  const colormapLump = wad.readLumpByName('COLORMAP')!;
  const tables = initLightTables(decodeColormap(colormapLump));
  const playpal = decodePlaypal(wad.readLumpByName('PLAYPAL')!);
  const paletteRgb: number[] = [];
  for (let i = 0; i < 256; i++) {
    const rgba = playpal[i]!;
    paletteRgb.push(rgba & 0xff, (rgba >>> 8) & 0xff, (rgba >>> 16) & 0xff);
  }
  bundle = {
    md,
    view,
    world: loadRenderWorld(md, new Map([['FIXWALL0', fixTexture('FIXWALL0')], ['DOORFIX0', fixTexture('DOORFIX0')]]), flatsFromWad(fixWad)),
    tables,
    sprites: buildMapSprites({ md, map: view, wad }),
    colormaps: tables.colormaps,
    paletteRgb
  };
  return bundle;
}

/* ------------------------------------------------------------------ */
/* Scene table — subset per weapon family                              */
/* ------------------------------------------------------------------ */

interface Scene {
  readonly name: string;
  readonly wp: number; // WP_* index (also the weapon-slot key)
  readonly ammo?: readonly [number, number]; // [AM_*, amount] to give
  readonly mode: 'raise' | 'flash' | 'punch' | 'spin';
}

const SCENES: readonly Scene[] = [
  { name: 'wpn-fist-raise', wp: 0, mode: 'raise' },
  { name: 'wpn-fist-punch', wp: 0, mode: 'punch' },
  { name: 'wpn-pistol-raise', wp: 1, mode: 'raise' },
  { name: 'wpn-pistol-flash', wp: 1, mode: 'flash' },
  { name: 'wpn-shotgun-raise', wp: 2, ammo: [AM_SHELL, 50], mode: 'raise' },
  { name: 'wpn-shotgun-flash', wp: 2, ammo: [AM_SHELL, 50], mode: 'flash' },
  { name: 'wpn-chaingun-raise', wp: 3, ammo: [AM_CLIP, 200], mode: 'raise' },
  { name: 'wpn-chaingun-spin', wp: 3, ammo: [AM_CLIP, 200], mode: 'spin' },
  { name: 'wpn-missile-raise', wp: 4, ammo: [AM_CELL, 200], mode: 'raise' },
  { name: 'wpn-missile-flash', wp: 4, ammo: [AM_CELL, 200], mode: 'flash' },
  { name: 'wpn-plasma-raise', wp: 5, ammo: [AM_CELL, 300], mode: 'raise' },
  { name: 'wpn-plasma-flash', wp: 5, ammo: [AM_CELL, 300], mode: 'flash' },
  { name: 'wpn-bfg-raise', wp: 6, ammo: [AM_CELL, 400], mode: 'raise' },
  { name: 'wpn-bfg-flash', wp: 6, ammo: [AM_CELL, 400], mode: 'flash' }
];

/** Run the scripted boot to the capture tic (self-syncing — the exact tic
 * numbers are the per-weapon suites' business; here only the psprite
 * CONDITION matters, every one is asserted reachable). */
function reach(scene: Scene): { s: GameState; captured: string } {
  // Fresh sim per scene; the render map is the separate, read-only md.
  const simWad = WadFile.parse(
    toArrayBuffer(buildFixtureMapWad(weaponRangeSpec([{}]), 'FIXMAP'))
  );
  const s = gInitGame(buildMapFromData(loadMap(simWad, 'FIXMAP')));
  const p = attachPsprFields(s.players[0]!);
  p.weaponowned[scene.wp] = 1;
  if (scene.ammo !== undefined) p.ammo[scene.ammo[0]] = scene.ammo[1];

  const NOIN: GameInput = emptyInput();
  const pspOf = (i: number): { state: number; sy: number } => p.psprites![i]!;

  // Phase 0: spawn weapon raised (G_InitNew pistol; P_SetupPsprites
  // lower→bring-up from the spawn tic — the pistol suite's tic-14 firing
  // pins this window).
  let tic = 0;
  for (; tic < 300; tic++) {
    gTicker(s, NOIN);
    if (p.pendingweapon === WP_NOCHANGE && pspOf(0)!.sy === WEAPONTOP) break;
  }
  expect(tic, `${scene.name}: spawn weapon never raised`).toBeLessThan(300);

  // Phase 1: switch (ONE slot-key press once raised — the chaingun-suite
  // convention) and wait for the target weapon's raise to complete.
  if (!(p.readyweapon === scene.wp && p.pendingweapon === WP_NOCHANGE)) {
    gTicker(s, { ...NOIN, weaponKey: scene.wp });
    tic++;
    for (; tic < 600; tic++) {
      gTicker(s, NOIN);
      if (
        p.readyweapon === scene.wp &&
        p.pendingweapon === WP_NOCHANGE &&
        pspOf(0)!.sy === WEAPONTOP
      )
        break;
    }
    expect(tic, `${scene.name}: weapon ${scene.wp} never raised`).toBeLessThan(600);
  }

  // Phase 2: mode-specific advance to the capture tic.
  const ready = WEAPONINFO[scene.wp]!.readystate;
  if (scene.mode === 'raise') {
    return { s, captured: `raised @tic ${tic}` };
  }
  const fire: GameInput = { ...NOIN, attack: true };
  if (scene.mode === 'punch') {
    const end = tic + 200;
    for (; tic < end; tic++) {
      gTicker(s, fire);
      if (pspOf(0)!.state !== ready) break;
    }
    expect(pspOf(0)!.state, `${scene.name}: punch never entered atk state`).not.toBe(ready);
    return { s, captured: `punch state ${pspOf(0)!.state}` };
  }
  // flash/spin: hold attack until the flash psprite lights…
  const lit = tic + 300;
  for (; tic < lit; tic++) {
    gTicker(s, fire);
    if (pspOf(1)!.state !== 0) break;
  }
  expect(pspOf(1)!.state, `${scene.name}: flash psprite never lit`).not.toBe(0);
  // …spin adds 12 tics of hold: mid-spin frames (A/B/C cycling) + flash.
  if (scene.mode === 'spin') {
    for (let k = 0; k < 12; k++) gTicker(s, fire);
  }
  return { s, captured: `mode ${scene.mode} @tic ${tic} (flash ${pspOf(1)!.state})` };
}

/* ------------------------------------------------------------------ */
/* Render + golden plumbing                                            */
/* ------------------------------------------------------------------ */

function frameDeps(s: GameState, b: Bundle, fb: Framebuffer, withGun: boolean) {
  return {
    fb,
    world: b.world,
    map: b.view,
    player: s.players[0]!,
    tables: b.tables,
    sprites: b.sprites,
    ...(withGun ? { psprites: buildPspriteFrameInput(s.map, s.players[0]!) } : {})
  };
}

function assertHealthy(c: { hom: number; visplaneOverflow: number; visspriteOverflow: number; openingOverflow: number; drawsegOverflow: number }, tag: string): void {
  expect(c.hom, `${tag}: hom must be 0`).toBe(0);
  expect(c.visplaneOverflow, `${tag}: MAXVISPLANES`).toBe(0);
  expect(c.visspriteOverflow, `${tag}: MAXVISSPRITES`).toBe(0);
  expect(c.openingOverflow, `${tag}: openings overflow`).toBe(0);
  expect(c.drawsegOverflow, `${tag}: MAXDRAWSEGS`).toBe(0);
}

/** Double-render the live state (walls.test.ts renderScene convention). */
function renderSim(s: GameState, withGun: boolean): { fb: Framebuffer; bytesA: Uint8Array; bytesB: Uint8Array } {
  const b = bundle_();
  const fb = new Framebuffer();
  const deps = frameDeps(s, b, fb, withGun);
  assertHealthy(renderFrame(deps), 'render 1');
  const bytesA = new Uint8Array(fb.indices);
  assertHealthy(renderFrame(deps), 'render 2');
  return { fb, bytesA, bytesB: new Uint8Array(fb.indices) };
}

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

interface MetaFile {
  scenes?: Record<string, { indexSha256?: string }>;
}

function goldenCase(scene: Scene): void {
  it(`${scene.name}: raised/flash psprite golden (double-render identical, sha vs meta)`, () => {
    const { s, captured } = reach(scene);
    const { fb, bytesA, bytesB } = renderSim(s, true);
    expect(sha256Of(bytesA), `${scene.name}: same state rendered twice must be byte-identical`).toBe(
      sha256Of(bytesB)
    );
    const sha = sha256Of(fb.indices);
    if (DUMP_DIR !== null) {
      const b = bundle_();
      writeFileSync(`${DUMP_DIR}/${scene.name}.bin`, fb.indices);
      writeFileSync(
        `${DUMP_DIR}/${scene.name}.json`,
        JSON.stringify(
          {
            name: scene.name,
            kind: 'weapon-script',
            script: `${captured} — gInitGame→give→weaponKey→(attack)→capture`,
            width: fb.width,
            height: fb.height,
            indexSha256: sha,
            hom: 0,
            paletteRgb: b.paletteRgb
          },
          null,
          2
        ) + '\n'
      );
    }
    if (MODE !== 'update') {
      const meta = existsSync(META_PATH)
        ? (JSON.parse(readFileSync(META_PATH, 'utf8')) as MetaFile)
        : {};
      expect(meta.scenes?.[scene.name]?.indexSha256, `${scene.name}: sha vs committed golden`).toBe(sha);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Montage contact sheet                                               */
/* ------------------------------------------------------------------ */

/** 5×7 bitmap font (row bytes, bit 4 = leftmost). */
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

/** Enumerate every weapon/flash (sprite, frame) pair the 967-state table
 * exposes for the nine weaponinfo chains: full chain walks of the
 * up/down/ready/atk states and of each flash chain head, PLUS the single
 * variant rows the +N arithmetic of A_FirePlasma (`flashstate+(P_Random()&1)`)
 * and A_FireCGun (`flashstate + psp->state - &states[S_CHAIN1]`) can reach. */
function weaponFrameRoster(): { sprite: number; frame: number }[] {
  const pairs: { sprite: number; frame: number }[] = [];
  const seen = new Set<number>();
  const add = (sprite: number, frame: number): void => {
    if (sprite === 0) return; // SPR_NONE
    const key = sprite * 32 + frame;
    if (seen.has(key)) return;
    seen.add(key);
    pairs.push({ sprite, frame });
  };
  const walk = (start: number): void => {
    const visited = new Set<number>();
    let s = start;
    while (s > 0 && s < 967 && !visited.has(s)) {
      visited.add(s);
      add(stateSprite[s]!, stateFrame[s]! & FF_FRAMEMASK);
      s = stateNext[s]!;
    }
  };
  const walkFlash = (start: number): void => {
    const base = stateSprite[start]!;
    const visited = new Set<number>();
    let s = start;
    while (s > 0 && s < 967 && !visited.has(s)) {
      visited.add(s);
      if (stateSprite[s] !== base) break; // chain left the flash sprite ⇒ left the flash
      add(stateSprite[s]!, stateFrame[s]! & FF_FRAMEMASK);
      s = stateNext[s]!;
    }
    // The +N arithmetic of A_FirePlasma/A_FireCGun reaches the NEXT rows
    // and they carry the SAME flash sprite — rows beyond that boundary are
    // other states (S_ tables pack states contiguously), not variants.
    for (const k of [1, 2]) {
      const row = start + k;
      if (row < 967 && stateSprite[row] === base) add(stateSprite[row]!, stateFrame[row]! & FF_FRAMEMASK);
    }
  };
  for (const w of WEAPONINFO) {
    walk(w.upstate);
    walk(w.downstate);
    walk(w.readystate);
    walk(w.atkstate);
    if (w.flashstate !== 0) walkFlash(w.flashstate);
  }
  pairs.sort((a, b) => a.sprite - b.sprite || a.frame - b.frame);
  return pairs;
}

const TILE_W = 88;
const TILE_H = 72;
const MONT_COLS = 4;

/** Contact sheet: tiles on black, fullbright (colormap row 0 — the same
 * ladder rung a FF_FULLBRIGHT psprite frame uses), 5×7 label per tile. */
function buildMontage(): { buf: Uint8Array; width: number; height: number; tiles: number } {
  const b = bundle_();
  const roster = weaponFrameRoster();
  const rows = Math.max(1, Math.ceil(roster.length / MONT_COLS));
  const width = MONT_COLS * TILE_W;
  const height = rows * TILE_H;
  const buf = new Uint8Array(width * height); // 0 = black void
  let tiles = 0;
  roster.forEach((f, i) => {
    const gf = lookupFrame(b.sprites.sprites, f.sprite, f.frame);
    if (gf < 0) return;
    const lump = frameLump(b.sprites.sprites, gf, 0);
    if (lump < 0) return; // no mirror art for this frame (e.g. dead-coded)
    const patch = b.sprites.patches.get(lump);
    if (patch === undefined || patch.width === 0) return;
    const tx = (i % MONT_COLS) * TILE_W;
    const ty = Math.floor(i / MONT_COLS) * TILE_H;
    tiles += 1;
    // Label band (12 px, sprite drawn from ty+12): the 6-char lump-style
    // name (4CC + frame letter + rot0/skew0) printed HORIZONAL, 5×7 font.
    const paint = (glyph: readonly number[], x0: number, y0: number): void => {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 5; c++) {
          if ((glyph[r]! & (1 << (4 - c))) === 0) continue;
          const x = x0 + c;
          const y = y0 + r;
          if (x < 0 || x >= width || y < 0 || y >= height) continue;
          buf[y * width + x] = 255; // white
        }
      }
    };
    const label = `${sprnames[f.sprite] ?? '????'}${String.fromCharCode(65 + f.frame)}0`;
    for (let ch = 0; ch < label.length; ch++) {
      const glyph = FONT[label[ch] ?? ''];
      if (glyph !== undefined) paint(glyph, tx + 2 + ch * 6, ty + 2);
    }
    const x0 = tx + ((TILE_W - patch.width) >> 1);
    const y0 = ty + 12 + ((TILE_H - 12 - patch.height) >> 1);
    for (let c = 0; c < patch.width; c++) {
      const x = x0 + c;
      if (x < 0 || x >= width) continue;
      const col = patch.columns[c]!;
      for (let r = 0; r < patch.height; r++) {
        const src = col[r]!;
        if (src === 0) continue;
        const y = y0 + r;
        if (y < 0 || y >= height) continue;
        buf[y * width + x] = b.colormaps[src]!; // colormap row 0 = fullbright
      }
    }
  });
  return { buf, width, height, tiles };
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe.skipIf(!hasWad)('M7-10 weapon visual pack (goldens/weapons)', () => {
  for (const scene of SCENES) goldenCase(scene);

  it('montage: labelled contact sheet of every weapon/flash frame', () => {
    const { buf, width, height, tiles } = buildMontage();
    expect(tiles, 'contact sheet must tile real mirror frames').toBeGreaterThanOrEqual(15);
    let painted = 0;
    for (const v of buf) if (v !== 0) painted += 1;
    expect(painted, 'montage must not be blank').toBeGreaterThan(2000);
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
            script: 'state-table-enumerated weapon/flash frames, 5x7 labels, fullbright row',
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
        ? (JSON.parse(readFileSync(META_PATH, 'utf8')) as MetaFile)
        : {};
      expect(meta.scenes?.['montage']?.indexSha256, 'montage sha vs committed golden').toBe(sha);
    }
  });

  it('regression: gun-off frame == no-deps.psprites frame byte-identical (walls sets safe)', () => {
    // A raised pistol must CHANGE the frame (the pass is live), while the
    // identical scene rendered without deps.psprites equals the world-only
    // buffer — the exact construction that keeps every pre-M7 golden fixed.
    const { s } = reach({ name: 'reg', wp: 1, mode: 'raise' });
    const on = renderSim(s, true);
    const off = renderSim(s, false);
    let diff = 0;
    for (let i = 0; i < on.fb.indices.length; i++) {
      if (on.fb.indices[i] !== off.fb.indices[i]) diff += 1;
    }
    expect(diff, 'raised pistol must paint view pixels').toBeGreaterThan(200);
    const offAgain = renderSim(s, false);
    expect(sha256Of(off.bytesA)).toBe(sha256Of(offAgain.bytesA));
  });

  it('roster sanity: every weaponinfo chain sprite is in the montage enumeration', () => {
    const roster = weaponFrameRoster();
    const sprites = new Set(roster.map((r) => r.sprite));
    for (const w of WEAPONINFO) {
      for (const st of [w.upstate, w.downstate, w.readystate, w.atkstate]) {
        if (st > 0 && stateSprite[st] !== 0) expect(sprites.has(stateSprite[st]!)).toBe(true);
      }
    }
  });
});

/** Bundle-less guard (runs with no wad): the roster needs tables only. */
describe('M7-10 visual-pack roster (wad-free)', () => {
  it('enumeration is deterministic and non-empty without a wad', () => {
    const a = weaponFrameRoster();
    expect(a.length).toBeGreaterThan(10);
    expect(weaponFrameRoster()).toEqual(a);
  });
});
