/**
 * M6-13 — L5 MECHANICS-STRIP evidence (M6-plan §M6-13 acceptance 4):
 * scripted SPECIAL-DRIVEN sequences rendered to labelled PNG strips,
 * committed under tests/render/goldens/mechanics/** with meta reason
 * 'M6 door-through evidence'.
 *
 * Door substitution (FINDING, recorded in meta.pipeline): the plan's strip
 * list was door 1 / lift 21 / crusher 6 — the M6-05 door BODY never
 * landed on main (pdoors.ts is still the stub recorder), so a "door
 * opening + player passing through" strip would show a DOOR THAT NEVER
 * MOVES — misleading evidence. The set therefore proves the same claim
 * ("a sector mover runs live, in-frame, under the M6-13 LIVE-SECTOR
 * RENDER WIRING") with the two mover families that ARE live:
 *   m6-lift-through — a W1 plat (cross 10) drops the floor UNDER a
 *       walking player, holds, raises: the player RIDES the special
 *       (walk → floor-down → wait → up), sector floor SoA in caption;
 *   m6-crusher      — a W1 fastCrushAndRaise (cross 6): the player stops
 *       before the hall, its ceiling crushes down and climbs back in
 *       frame, sector ceiling SoA in caption (+ damage-slot cadence);
 *   m6-light-paint  — a W1 light turn-on (cross 13, bright 255): the dark
 *       room ahead JUMPS to full brightness across the crossing frame.
 * All three render through `loadRenderWorld(md, …, state.sectors)` — they
 * would be FLAT (no motion) without the live-sector wiring, doubling as
 * its visual proof.
 *
 * Modes identical to motion.test.ts (GOLDENS_MODE update/check +
 * GOLDENS_DUMP_DIR dump; PNGs blessed ONLY via
 * `node scripts/motion-strip.mjs --set mechanics --reason "..."`).
 *
 * Lint exempt: tests/render/goldens/** is blessed BINARY data.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

import { afterEach, describe, expect, it } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame, gTicker } from '../../src/sim/game';
import { pTeleportMove } from '../../src/sim/pmap';
import { puserGlobals } from '../../src/sim/puser';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame } from '../../src/render/renderer';
import { buildRenderMapView } from '../../src/render/view';

import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';
import { fixTexValue, grayRampPalette, synthColormapRows } from './viewpoints';

import type { GameState } from '../../src/sim/state';
import type { TextureDef } from '../../src/wad/types';
import type { RenderWorld } from '../../src/render/rdata';
import type { RenderMapView } from '../../src/render/view';
import type { LightTables } from '../../src/render/lights';
import type { SpriteTables } from '../../src/render/renderer';
import type { RectRoomSpec, LineTriggerSpec } from '../fixtures/mapBuilder';

/* strip layout — motion.test.ts geometry, carried verbatim (additive set) */
const FW = 320;
const FH = 200;
const COLS = 4;
const GAP = 6;
const CAP_H = 10;
const HEAD_H = 16;
const W = 2 * GAP + COLS * FW + (COLS - 1) * GAP;
const H = HEAD_H + 2 * (FH + CAP_H) + GAP;
const CAPTIONS_PER_ROW = Math.floor((FW - 2) / 4);

const META_PATH = fileURLToPath(new URL('./goldens/mechanics/meta.json', import.meta.url));
const REVIEW_DIR =
  process.env['MECHANICS_RESULTS_DIR'] ??
  fileURLToPath(new URL('../../test-results/mechanics-strip/', import.meta.url));
const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
const MODE = process.env['GOLDENS_MODE'] ?? '';

/* ------------------------------------------------------------------ */
/* 3×5 pixel font (motion.test.ts idiom, carried verbatim — test files */
/* are not import sources)                                             */
/* ------------------------------------------------------------------ */

const FONT: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111',
  '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
  '6': '111100111101111', '7': '111001001001001', '8': '111101111101111',
  '9': '111110111100111', A: '010101111101101', B: '110101110101110',
  C: '011100100101011', D: '110101101101110', E: '111100111100111',
  F: '111100111100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101011', K: '101101110101101',
  L: '100100100100111', M: '101111111101101', N: '110101101101101',
  O: '111101101101111', P: '111101111100100', Q: '111101101111001',
  R: '111101110101101', S: '011100111001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111101101',
  X: '101101010101101', Y: '101101001001010', Z: '111001010100111',
  ' ': '000000000000000', '.': '000000000000010',
  '-': '000000111000000', '=': '000111000111000', '/': '001001010100100',
  '+': '000010111010000', ':': '000010000010000', ',': '000000000010100'
};

function putText(buf: Uint8Array, x0: number, y0: number, s: string, color: number): void {
  for (let i = 0; i < s.length; i++) {
    const g = FONT[s[i]!.toUpperCase()] ?? FONT[' ']!;
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 3; c++) {
        if (g[r * 3 + c] === '1') buf[(y0 + r) * W + x0 + i * 4 + c] = color;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Scenes                                                              */
/* ------------------------------------------------------------------ */

interface Scene {
  readonly name: string;
  readonly title: string;
  readonly subtitle: string;
  readonly script: string;
  readonly spec: RectMapSpec;
  /** tagged-sector stat name + getter (SoA field observed by the strip) */
  readonly stat: 'floor' | 'ceiling' | 'light';
  readonly ticCount: number;
  readonly captureTics: readonly number[];
  readonly inputAt: (tic: number, s: GameState) => GameInput;
  readonly warp: { x: number; y: number; angleDeg: number };
  /** reviewer-expectation asserts on the captured stat sequence */
  readonly expect: (stat: readonly number[], frames: readonly FrameRec[]) => void;
}

interface FrameRec {
  tic: number;
  xU: number;
  yU: number;
  zU: number;
  viewzU: number;
  statU: number;
  frameSha: string;
}

const ROOM: Partial<RectRoomSpec> = { ceilingHeight: 128, lightLevel: 192 };

const LIFT_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 512, h: 256, ...ROOM }, // approach corridor
    { x: 512, y: 0, w: 128, h: 256, ...ROOM, tag: 10 }, // the lift
    { x: 640, y: 0, w: 128, h: 256, ...ROOM, floorHeight: -24 }, // sump (dwus lowest-surrounding)
    { x: 512, y: 256, w: 128, h: 64, ...ROOM },
    { x: 512, y: -64, w: 128, h: 64, ...ROOM }
  ],
  triggers: [{ x1: 512, y1: 96, x2: 512, y2: 160, special: 10, tag: 10 } as LineTriggerSpec],
  things: [{ x: 48, y: 128, angle: 0, type: 1 }]
};

const CRUSHER_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, ...ROOM }, // approach
    { x: 256, y: 0, w: 128, h: 256, ...ROOM }, // antechamber (player stops here)
    { x: 384, y: 0, w: 256, h: 256, ...ROOM, tag: 6 } // crusher hall, fully visible
  ],
  triggers: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 6, tag: 6 } as LineTriggerSpec],
  things: [{ x: 48, y: 128, angle: 0, type: 1 }]
};

const LIGHT_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 512, h: 256, ...ROOM },
    { x: 512, y: 0, w: 256, h: 256, ...ROOM, lightLevel: 40, tag: 13 } // dark room ahead
  ],
  triggers: [{ x1: 512, y1: 96, x2: 512, y2: 160, special: 13, tag: 13 } as LineTriggerSpec],
  things: [{ x: 48, y: 128, angle: 0, type: 1 }]
};

const CAP8 = [0, 15, 30, 45, 60, 75, 90, 105];
// lift: cross ≈ tic 63, ride down (12 tics), the 105-tic vanilla
// PLATWAIT=3 hold, raise (12 tics) — see probe timings in M6-13 report.
const CAP_LIFT = [0, 30, 60, 80, 120, 160, 190, 215];

const SCENES: Scene[] = [
  {
    name: 'm6-lift-through',
    title: 'M6 LIFT THROUGH: WALK TRIGGER RIDE',
    subtitle: 'CROSS 10 DWUS PLAT LIVE-SECTOR RENDER SF=FLOORZ',
    script:
      'FIXMAP lift (corridor | tagged plat f0, sump f-24) -> warp (48,128,0deg) -> walk fwd until x≥520 (cross W1 plat trigger @x512 ~tic 63), momentum-stop ON the shaft -> floor -24 under the rider, PLATWAIT 105, raise -> player RIDES the special (SF/Z captions) -> 8 frames t=0/30/60/80/120/160/190/215',
    spec: LIFT_SPEC,
    stat: 'floor',
    ticCount: 215,
    captureTics: CAP_LIFT,
    inputAt: (t, st) => ({ ...emptyInput(), forward: st.players[0]!.mo.x < 460 * FRACUNIT }),
    warp: { x: 48, y: 128, angleDeg: 0 },
    expect: (stat, frames) => {
      // floor goes DOWN under the rider, HOLDS (vanilla PLATWAIT=3), rises
      const f0 = frames[0]!;
      const f7 = frames[7]!;
      expect(f0.statU).toBe(0);
      expect(Math.min(...stat)).toBe(-24 * FRACUNIT);
      expect(frames[3]!.statU).toBe(-24 * FRACUNIT); // down by tic 80
      expect(frames[5]!.statU).toBe(-24 * FRACUNIT); // still holding at tic 160
      expect(f7.statU).toBe(0); // home up by tic 215
      expect(f7.zU).toBe(0); // the rider came back up with it
    }
  },
  {
    name: 'm6-crusher',
    title: 'M6 CRUSHER: W1 FASTCRUSH AND RAISE',
    subtitle: 'CROSS 6 FAST CRUSH HALL SC=CEILINGZ LIVE-SECTOR RENDER',
    script:
      'FIXMAP crusher (corridor | antechamber | tagged hall c128) -> warp (48,128,0deg) -> walk fwd <=45 tics, cross W1 fastCrushAndRaise trigger @x256 -> STOP in antechamber, hall ceiling crushes down (8/tic) and climbs (2/tic) in view (SC caption) -> 8 frames t=0..105',
    spec: CRUSHER_SPEC,
    stat: 'ceiling',
    ticCount: 105,
    captureTics: CAP8,
    inputAt: (t, st) => ({ ...emptyInput(), forward: st.players[0]!.mo.x < 300 * FRACUNIT }),
    warp: { x: 48, y: 128, angleDeg: 0 },
    expect: (stat) => {
      expect(Math.min(...stat)).toBeLessThanOrEqual(40 * FRACUNIT); // crushed deep
      expect(Math.max(...stat)).toBeGreaterThanOrEqual(120 * FRACUNIT); // climbed back
    }
  },
  {
    name: 'm6-light-paint',
    title: 'M6 LIGHT PAINT: W1 TURN IT ON',
    subtitle: 'CROSS 13 BRIGHT 255 LIVE LIGHT SOA SL=LIGHT',
    script:
      'FIXMAP light (corridor | tagged room light 40) -> warp (48,128,0deg) -> walk fwd <=105 tics, cross W1 lightOn(255) trigger @x512 (~tic 66) -> tagged light SoA 40→255, room ahead repaints at full brightness (SL caption) -> 8 frames t=0..105',
    spec: LIGHT_SPEC,
    stat: 'light',
    ticCount: 105,
    captureTics: CAP8,
    inputAt: () => ({ ...emptyInput(), forward: true }),
    warp: { x: 48, y: 128, angleDeg: 0 },
    expect: (stat, frames) => {
      expect(frames[0]!.statU).toBe(40 * FRACUNIT);
      expect(stat[stat.length - 1]).toBe(255 * FRACUNIT);
      expect(new Set(stat).size).toBeGreaterThanOrEqual(2);
    }
  }
];

/* ------------------------------------------------------------------ */
/* Bundle — THE M6-13 LIVE-SECTOR WIRING IS THE POINT                  */
/* ------------------------------------------------------------------ */

const u8ToBuf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function fixTexture(name: string): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < 64; c++) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r++) col[r] = fixTexValue(c, r);
    columns.push(col);
  }
  return { name, width: 64, height: 128, patches: [], columns };
}

interface Bundle {
  sim: ReturnType<typeof buildMapFromData>;
  world: RenderWorld; // STATIC tables (the pre-M6-13 baseline for the wiring proof)
  textures: Map<string, TextureDef>;
  view: RenderMapView;
  tables: LightTables;
  sprites: SpriteTables;
  paletteRgb: number[];
  md: ReturnType<typeof loadMap>;
}

function fixtureBundle(spec: RectMapSpec): Bundle {
  const wad = WadFile.parse(u8ToBuf(buildFixtureMapWad(spec, 'MECH')));
  const md = loadMap(wad, 'MECH');
  const view = buildRenderMapView(md);
  const textures = new Map([
    ['FIXWALL0', fixTexture('FIXWALL0')],
    ['DOORFIX0', fixTexture('DOORFIX0')]
  ]);
  const sim = buildMapFromData(md);
  return {
    sim,
    world: loadRenderWorld(md, textures, flatsFromWad(wad)),
    textures,
    view,
    tables: initLightTables(synthColormapRows()),
    sprites: buildMapSprites({ md, map: view, wad }),
    paletteRgb: grayRampPalette(),
    md
  };
}

function statOf(scene: Scene, s: GameState, taggedSec: number): number {
  return scene.stat === 'floor'
    ? s.sectors.floorZ[taggedSec]!
    : scene.stat === 'ceiling'
      ? s.sectors.ceilingZ[taggedSec]!
      : s.sectors.light[taggedSec]! * FRACUNIT;
}

function generate(scene: Scene): { indices: Uint8Array; frames: FrameRec[]; stat: number[] } {
  const bundle = fixtureBundle(scene.spec);
  const s: GameState = gInitGame(bundle.sim);
  // THE wiring: the render world's sector SoA IS this state's live SoA.
  const world = loadRenderWorld(bundle.md, bundle.textures, [], s.sectors);
  const p = s.players[0]!;
  pTeleportMove(s.pmap, p.mo, scene.warp.x * FRACUNIT, scene.warp.y * FRACUNIT);
  p.mo.z = p.mo.floorz;
  p.mo.angle = Math.floor(scene.warp.angleDeg * (0x100000000 / 360)) >>> 0;

  let taggedSec = -1;
  for (let i = 0; i < s.map.sectors.count; i++) if (s.map.sectors.tag[i] !== 0) taggedSec = i;
  expect(taggedSec, `${scene.name}: tagged sector exists`).toBeGreaterThan(0);

  const buf = new Uint8Array(W * H);
  const frames: FrameRec[] = [];
  const stat: number[] = [];

  for (let t = 0; t <= scene.ticCount; t++) {
    if (t > 0) gTicker(s, scene.inputAt(t - 1, s));
    if (!scene.captureTics.includes(t)) continue;
    const fb = new Framebuffer();
    const c = renderFrame({
      fb, world, map: bundle.view, player: { mo: p.mo, viewz: p.viewz },
      tables: bundle.tables, sprites: bundle.sprites
    });
    expect(c.hom, `tic ${t}: hom`).toBe(0);
    expect(c.drawsegOverflow, `tic ${t}: drawsegs`).toBe(0);
    expect(c.visspriteOverflow, `tic ${t}: vissprites`).toBe(0);
    expect(c.visplaneOverflow, `tic ${t}: visplanes`).toBe(0);
    expect(c.openingOverflow, `tic ${t}: openings`).toBe(0);
    const idx = scene.captureTics.indexOf(t);
    const ox = GAP + (idx % COLS) * (FW + GAP);
    const oy = HEAD_H + Math.floor(idx / COLS) * (FH + CAP_H + GAP);
    for (let y = 0; y < FH; y++) buf.set(fb.indices.subarray(y * FW, (y + 1) * FW), (oy + y) * W + ox);
    const st = statOf(scene, s, taggedSec);
    stat.push(st);
    const rec: FrameRec = {
      tic: t, xU: p.mo.x, yU: p.mo.y, zU: p.mo.z, viewzU: p.viewz, statU: st,
      frameSha: createHash('sha256').update(fb.indices).digest('hex')
    };
    const cap =
      `T${String(t).padStart(3, '0')} X${u(rec.xU)} Z${u(rec.zU)} ${scene.stat[0]!.toUpperCase()}${u(st)}`;
    expect(cap.length, `caption '${cap}' width`).toBeLessThanOrEqual(CAPTIONS_PER_ROW);
    putText(buf, ox, oy + FH + 3, cap, 255);
    frames.push(rec);
  }
  putText(buf, GAP, 5, scene.title, 255);
  putText(buf, GAP, 11, scene.subtitle, 200);
  return { indices: buf, frames, stat };
}

function u(n: number): string {
  const s = (n < 0 ? '-' : '') + Math.abs(n / FRACUNIT).toFixed(1);
  return s.padStart(7);
}

/* ------------------------------------------------------------------ */
/* meta / review / dump (motion protocol)                              */
/* ------------------------------------------------------------------ */

interface MetaScene {
  kind: string;
  script: string;
  reason: string;
  updatedAt: string;
  png: string;
  width: number;
  height: number;
  frameTics: number[];
  frames: FrameRec[];
  indexSha256: string;
}
interface MetaFile {
  schema: number;
  generator: string;
  set: string;
  pipeline: string;
  scenes: Record<string, MetaScene>;
}

function readMeta(): MetaFile {
  if (!existsSync(META_PATH)) {
    throw new Error(
      `mechanics goldens meta missing: ${META_PATH} — run node scripts/motion-strip.mjs --set mechanics --reason "..."`
    );
  }
  return JSON.parse(readFileSync(META_PATH, 'utf8')) as MetaFile;
}

function review(indices: Uint8Array, paletteRgb: number[], name: string): void {
  mkdirSync(REVIEW_DIR, { recursive: true });
  writeFileSync(`${REVIEW_DIR}/${name}.png`, pngFromIndices(W, H, indices, sha256Hex(indices), paletteRgb));
}

function dump(scene: Scene, indices: Uint8Array, frames: FrameRec[], paletteRgb: number[]): void {
  if (DUMP_DIR === null) return;
  const base = `${DUMP_DIR}/${scene.name}`;
  writeFileSync(`${base}.bin`, Buffer.from(indices));
  writeFileSync(
    `${base}.json`,
    JSON.stringify(
      {
        name: scene.name,
        kind: 'mechanics',
        script: scene.script,
        width: W,
        height: H,
        indexSha256: sha256Hex(indices),
        frameTics: scene.captureTics,
        frames,
        paletteRgb
      },
      null,
      2
    ) + '\n'
  );
}

function sceneCase(scene: Scene): void {
  it(`${scene.name}: mechanics strip renders deterministically vs committed sha`, () => {
    const gen = generate(scene);
    const again = generate(scene);
    expect(sha256Hex(again.indices), `${scene.name}: double-run byte-identical`).toBe(
      sha256Hex(gen.indices)
    );
    expect(gen.frames.length).toBe(8);
    scene.expect(gen.stat, gen.frames);
    review(gen.indices, grayRampPalette(), scene.name);
    dump(scene, gen.indices, gen.frames, grayRampPalette());
    if (MODE !== 'update') {
      const golden = readMeta().scenes[scene.name];
      expect(golden, `${scene.name}: missing from mechanics meta.json`).toBeDefined();
      expect(sha256Hex(gen.indices), `${scene.name}: strip sha drifted from meta.json`).toBe(
        golden!.indexSha256
      );
    }
  });
}

describe('M6-13 mechanics strips (L5 specials-driven evidence)', () => {
  afterEach(() => {
    puserGlobals.onground = false; // p_user.c global hygiene (feel convention)
  });
  for (const s of SCENES) sceneCase(s);

  it('live-sector wiring proof: without state.sectors the lift frame NEVER moves', () => {
    const scene = SCENES[0]!;
    const bundle = fixtureBundle(scene.spec);
    const s = gInitGame(bundle.sim);
    // static world (pre-M6-13): the plat SoA moves, the RENDER cannot see it
    const p = s.players[0]!;
    pTeleportMove(s.pmap, p.mo, scene.warp.x * FRACUNIT, scene.warp.y * FRACUNIT);
    p.mo.z = p.mo.floorz;
    p.mo.angle = 0;
    const frameOf = (world: RenderWorld): Uint8Array => {
      const fb = new Framebuffer();
      renderFrame({
        fb, world, map: bundle.view, player: { mo: p.mo, viewz: p.viewz },
        tables: bundle.tables, sprites: bundle.sprites
      });
      return new Uint8Array(fb.indices);
    };
    // one player pose, TWO tables: same tic, same player — the ONLY
    // difference is whether the world's sector SoA is the live one.
    for (let t = 0; t < 70; t++) gTicker(s, { ...emptyInput(), forward: true });
    expect(
      s.sectors.floorZ.find((f, i) => f !== s.map.sectors.floorHeight[i]! && i > 0),
      'lift SoA actually moved by tic 70'
    ).toBeDefined();
    const staticFrame = frameOf(bundle.world);
    const liveWorld = loadRenderWorld(bundle.md, bundle.textures, [], s.sectors);
    const liveFrame = frameOf(liveWorld);
    expect(
      Buffer.from(liveFrame).equals(Buffer.from(staticFrame)),
      'same pose: live-sector frame MUST differ from the static-table frame'
    ).toBe(false);
    // …and the static read is still self-consistent (deterministic replay)
    expect(Buffer.from(frameOf(bundle.world)).equals(Buffer.from(staticFrame))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Minimal PNG writer (motion.test.ts / goldens-update.mjs verbatim    */
/* idiom — scripts remain additive-only).                              */
/* ------------------------------------------------------------------ */

function crc32(buf: Buffer | Uint8Array): number {
  const table = ((crc32 as unknown as { t?: Int32Array }).t ??= (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ (buf[i] ?? 0)) & 255]! ^ (c >>> 8);
  return (~c >>> 0) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function pngFromIndices(width: number, height: number, indices: Uint8Array, sha: string, paletteRgb: number[]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0;
    for (let x = 0; x < width; x++) {
      const i = indices[y * width + x] ?? 0;
      raw[p++] = paletteRgb[i * 3]!;
      raw[p++] = paletteRgb[i * 3 + 1]!;
      raw[p++] = paletteRgb[i * 3 + 2]!;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('tEXt', Buffer.concat([Buffer.from('doom-index-sha256\0', 'ascii'), Buffer.from(sha, 'ascii')])),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
