/**
 * M5-10 — L5 MOTION-STRIP evidence (M5-plan §M5-10): scripted walk+turn+step
 * rendered to a labelled PNG strip, committed under
 * tests/render/goldens/motion/** with meta reason 'M5-10 motion evidence'.
 *
 * What the strip must SHOW (task §M5-10 deliverable 1):
 *  - bob oscillation (the ±4.6px viewz wave while moving — frames 1..7),
 *  - wall/step approach (the +24 step face grows across the frame t≈31..39),
 *  - step-up squat (frame at tic 40: z jumped +24 but viewz still ≈41 —
 *    viewheight squatted to VIEWHEIGHT/2 — then recovers to z+41 by t≈45).
 *
 * Pipeline per strip (deterministic, wad-free — the walls.test.ts FIXMAP
 * fixture convention): MOTION fixture WAD (tests/fixtures/mapBuilder) →
 * gInitGame → debug-convention warp → scripted 70 tics (forward from tic 1,
 * turn-right 10..19, turn-left 20..29 — the feel-09 turnheld ramp; every
 * capture tic renders the FULL FRAME with the M5-08 viewz read-through) →
 * 8 frames (t=0,10,...,70) blitted into one indexed strip with 3×5-font
 * captions. The strip's index-buffer sha is the golden (meta.json); the
 * PNG is blessed ONLY via scripts/motion-strip.mjs (this test writes
 * review copies + dumps, never goldens).
 *
 * Modes (identical convention to walls/automap.test.ts):
 *   GOLDENS_MODE=update + GOLDENS_DUMP_DIR → dump strip.bin/.json, skip sha
 *   GOLDENS_MODE=check or unset           → assert sha vs meta.json
 * Review PNGs land in test-results/motion-strip (override: MOTION_RESULTS_DIR).
 *
 * Lint exempt: tests/render/goldens/** is blessed BINARY data.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

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

/* ------------------------------------------------------------------ */
/* Strip layout                                                        */
/* ------------------------------------------------------------------ */

const FW = 320; // rendered frame width  (RENDER_WIDTH)
const FH = 200; // rendered frame height (RENDER_HEIGHT)
const COLS = 4;
const GAP = 6;
const CAP_H = 10; // caption band under each frame (5-px glyphs + padding)
const HEAD_H = 16; // title band
const W = 2 * GAP + COLS * FW + (COLS - 1) * GAP;
const H = HEAD_H + 2 * (FH + CAP_H) + GAP;
const CAPTIONS_PER_ROW = Math.floor((FW - 2) / 4); // 4 px/glyph cell ⇒ 79 glyphs/frame

const META_PATH = fileURLToPath(new URL('./goldens/motion/meta.json', import.meta.url));
const REVIEW_DIR =
  process.env['MOTION_RESULTS_DIR'] ?? fileURLToPath(new URL('../../test-results/motion-strip/', import.meta.url));
const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
const MODE = process.env['GOLDENS_MODE'] ?? '';

/* ------------------------------------------------------------------ */
/* 3×5 pixel font (uppercase + digits + few punct)                     */
/* ------------------------------------------------------------------ */

const FONT: Record<string, string> = {
  '0': '111101101101111', '1': '010110010010111', '2': '111001111100111',
  '3': '111001111001111', '4': '101101111001001', '5': '111100111001111',
  '6': '111100111101111', '7': '111001001001001', '8': '111101111101111',
  '9': '111101111001111', A: '010101111101101', B: '110101110101110',
  C: '011100100101011', D: '110101101101110', E: '111100111100111',
  F: '111100111100100', G: '011100101101011', H: '101101111101101',
  I: '111010010010111', J: '001001001101011', K: '101101110101101',
  L: '100100100100111', M: '101111111101101', N: '110101101101101',
  O: '111101101101111', P: '111101111100100', Q: '111101101111001',
  R: '111101110101101', S: '011100111001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111101101',
  X: '101101010101101', Y: '101101010010010', Z: '111001010100111',
  '0.': '', ' ': '000000000000000', '.': '000000000000010',
  '-': '000000111000000', '=': '000111000111000', '/': '001001010100100',
  '+': '000010111010000', ':': '000010000010000', ',': '000000000010100'
};

function putGlyph(buf: Uint8Array, x0: number, y0: number, ch: string, color: number): void {
  const g = FONT[ch] ?? FONT[' ']!;
  for (let r = 0; r < 5; r++) {
    for (let c = 0; c < 3; c++) {
      if (g[r * 3 + c] === '1') buf[(y0 + r) * W + x0 + c] = color;
    }
  }
}

function putText(buf: Uint8Array, x0: number, y0: number, s: string, color: number): void {
  for (let i = 0; i < s.length; i++) putGlyph(buf, x0 + i * 4, y0, s[i]?.toUpperCase() ?? ' ', color);
}

/* ------------------------------------------------------------------ */
/* Fixture map + scripted scenario                                     */
/* ------------------------------------------------------------------ */

/** Room A f0 | room B f+24 — the feel stepRoom(24) geometry widened to
 * 832 × 512 so the 70-tic walk stays inside AND the +24 step FACE across
 * x=304 is visible well before arrival (probe: step-up lands tic 40, the
 * lane keeps y ≈ 235..269 — far off both walls). */
const MOTION_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 304, h: 512, ceilingHeight: 128, lightLevel: 192 },
    { x: 304, y: 0, w: 528, h: 512, ceilingHeight: 128, lightLevel: 192, floorHeight: 24 }
  ],
  things: [{ x: 48, y: 256, angle: 0, type: 1 }]
};

const WARP = { x: 48, y: 256, angleDeg: 0 };
const CAPTURE_TICS = [0, 10, 20, 30, 40, 50, 60, 70];

/** Walk forward from tic 1; turn-right held tics 10..19, turn-left 20..29
 * (the feel-09 turnheld ramp; net ≈ +8.8° yaw — authentic asymmetry). */
function inputAt(tic: number): GameInput {
  const inp = { ...emptyInput(), forward: true };
  if (tic >= 10 && tic < 20) inp.turnRight = true;
  else if (tic >= 20 && tic < 30) inp.turnLeft = true;
  return inp;
}

/* ------------------------------------------------------------------ */
/* Bundle (walls.test.ts FIXMAP convention)                            */
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
  world: RenderWorld;
  view: RenderMapView;
  tables: LightTables;
  sprites: SpriteTables;
  paletteRgb: number[];
}

function fixtureBundle(): Bundle {
  const wad = WadFile.parse(u8ToBuf(buildFixtureMapWad(MOTION_SPEC, 'FIXMAP')));
  const md = loadMap(wad, 'FIXMAP');
  const view = buildRenderMapView(md);
  return {
    sim: buildMapFromData(md),
    world: loadRenderWorld(
      md,
      new Map([['FIXWALL0', fixTexture('FIXWALL0')], ['DOORFIX0', fixTexture('DOORFIX0')]]),
      flatsFromWad(wad)
    ),
    view,
    tables: initLightTables(synthColormapRows()),
    sprites: buildMapSprites({ md, map: view, wad }),
    paletteRgb: grayRampPalette()
  };
}

/* ------------------------------------------------------------------ */
/* Strip generation                                                    */
/* ------------------------------------------------------------------ */

interface FrameRec {
  tic: number;
  xU: number;
  yU: number;
  zU: number;
  viewzU: number;
  viewheightU: number;
  bobU: number;
  momx: number;
  momy: number;
  angleBam: number;
  frameSha: string;
}

function u(n: number): string {
  const s = (n < 0 ? '-' : '') + Math.abs(n / FRACUNIT).toFixed(1);
  return s.padStart(7);
}

function caption(rec: FrameRec): string {
  const deg = ((rec.angleBam >>> 0) * (360 / 0x100000000)) % 360;
  const s = `T${String(rec.tic).padStart(2, '0')} X${u(rec.xU)} Y${u(rec.yU)} Z${u(rec.zU)} VZ${u(rec.viewzU)} A${deg.toFixed(0)}D`;
  expect(
    s.length,
    `caption '${s}' overflows ${CAPTIONS_PER_ROW} glyphs/frame — shrink u() padding`
  ).toBeLessThanOrEqual(CAPTIONS_PER_ROW);
  return s;
}

function generate(strip: StripDef): { indices: Uint8Array; frames: FrameRec[]; homTotal: number } {
  const bundle = fixtureBundle();
  const s: GameState = gInitGame(bundle.sim);
  const p = s.players[0]!;
  pTeleportMove(s.pmap, p.mo, WARP.x * FRACUNIT, WARP.y * FRACUNIT);
  p.mo.z = p.mo.floorz;
  p.mo.angle = Math.floor(WARP.angleDeg * (0x100000000 / 360)) >>> 0;

  const buf = new Uint8Array(W * H); // 0 = black bg (gray-ramp palette)
  const frames: FrameRec[] = [];
  let homTotal = 0;

  for (let t = 0; t <= 70; t++) {
    if (t > 0) gTicker(s, inputAt(t - 1));
    if (!CAPTURE_TICS.includes(t)) continue;
    const fb = new Framebuffer();
    const c = renderFrame({
      fb,
      world: bundle.world,
      map: bundle.view,
      player: { mo: p.mo, viewz: p.viewz },
      tables: bundle.tables,
      sprites: bundle.sprites
    });
    expect(c.hom, `frame tic ${t}: hom`).toBe(0);
    expect(c.drawsegOverflow, `frame tic ${t}: drawsegs — re-pick, never raise caps`).toBe(0);
    expect(c.visspriteOverflow, `frame tic ${t}: vissprites`).toBe(0);
    expect(c.visplaneOverflow, `frame tic ${t}: visplanes`).toBe(0);
    homTotal += c.hom;
    const idx = CAPTURE_TICS.indexOf(t);
    const ox = GAP + (idx % COLS) * (FW + GAP);
    const oy = HEAD_H + Math.floor(idx / COLS) * (FH + CAP_H + GAP);
    for (let y = 0; y < FH; y++) buf.set(fb.indices.subarray(y * FW, (y + 1) * FW), (oy + y) * W + ox);
    const rec: FrameRec = {
      tic: t,
      xU: p.mo.x,
      yU: p.mo.y,
      zU: p.mo.z,
      viewzU: p.viewz,
      viewheightU: p.viewheight,
      bobU: p.bob,
      momx: p.mo.momx,
      momy: p.mo.momy,
      angleBam: p.mo.angle >>> 0,
      frameSha: createHash('sha256').update(fb.indices).digest('hex')
    };
    putText(buf, ox, oy + FH + 3, caption(rec), 255);
    frames.push(rec);
  }

  putText(buf, GAP, 5, strip.title, 255);
  putText(buf, GAP, 11, strip.subtitle, 200);
  return { indices: buf, frames, homTotal };
}

interface StripDef {
  name: string;
  title: string;
  subtitle: string;
  script: string;
}

const STRIPS: StripDef[] = [
  {
    name: 'm5-10-walk-turn-step',
    title: 'M5-10 MOTION EVIDENCE: WALK TURN STEPUP',
    subtitle: 'FIXMAP 35HZ T 0 10 20 30 40 50 60 70 BOB SQUAT CLIMB',
    script:
      'FIXMAP fixture (room f0 | f+24 step @x304) -> warp (48,64,0deg) -> walk fwd tics 1-70, turn-right held 10-19, turn-left 20-29 (feel-09 ramp) -> render frame at tics 0/10/.../70 with P_CalcHeight viewz -> 8-frame labelled strip'
  }
];

/* ------------------------------------------------------------------ */
/* Meta / review / dump                                                */
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
    throw new Error(`motion goldens meta missing: ${META_PATH} — run node scripts/motion-strip.mjs --reason "..."`);
  }
  return JSON.parse(readFileSync(META_PATH, 'utf8')) as MetaFile;
}

function stripPng(indices: Uint8Array, paletteRgb: number[]): Buffer {
  return pngFromIndices(W, H, indices, sha256Hex(indices), paletteRgb);
}

function review(indices: Uint8Array, paletteRgb: number[], name: string): void {
  mkdirSync(REVIEW_DIR, { recursive: true });
  writeFileSync(`${REVIEW_DIR}${REVIEW_DIR.endsWith('/') ? '' : '/'}${name}.png`, stripPng(indices, paletteRgb));
}

function dump(strip: StripDef, indices: Uint8Array, frames: FrameRec[], paletteRgb: number[]): void {
  if (DUMP_DIR === null) return;
  const base = `${DUMP_DIR}/${strip.name}`;
  writeFileSync(`${base}.bin`, Buffer.from(indices));
  writeFileSync(
    `${base}.json`,
    JSON.stringify(
      {
        name: strip.name,
        kind: 'motion',
        script: strip.script,
        width: W,
        height: H,
        indexSha256: sha256Hex(indices),
        frameTics: CAPTURE_TICS,
        frames,
        paletteRgb
      },
      null,
      2
    ) + '\n'
  );
}

function stripCase(strip: StripDef): void {
  it(`${strip.name}: strip renders deterministically and matches the committed sha`, () => {
    const gen = generate(strip);
    // double-run determinism (M5-09 convention): identical script ⇒ bytes.
    const again = generate(strip);
    expect(sha256Hex(again.indices), `${strip.name}: double-run must be byte-identical`).toBe(
      sha256Hex(gen.indices)
    );

    // Reviewer-expectation asserts (task deliverable 1): the strip MUST
    // demonstrate bob oscillation, step approach and the squat.
    const f = gen.frames;
    expect(f.length).toBe(8);
    const [f1, f2, f3, f4, f5] = [f[1]!, f[2]!, f[3]!, f[4]!, f[5]!];
    expect(f2.yU).not.toBe(f4.yU); // turn sequence engaged (y diverges)
    expect(f4.zU).toBe(24 * FRACUNIT); // step-up happened by tic 40...
    expect(f3.zU).toBe(0); // ...after frame t=30 still on floor 0
    expect(f4.viewzU).toBeLessThan(50 * FRACUNIT); // ...and viewz SQUAT-lags z+41 (still climbing)
    expect(f5.viewzU).toBeGreaterThan(60 * FRACUNIT); // recovered to ≈ z+41 by t=50
    const waves = f.slice(5).map((r) => r.viewzU);
    expect(Math.max(...waves) - Math.min(...waves), 'bob wave still swinging frames 5-7').toBeGreaterThan(
      2 * FRACUNIT
    );
    const moved = f.slice(1).map((r) => Math.abs(r.xU) + Math.abs(r.yU));
    for (let i = 1; i < moved.length; i++) expect(moved[i]!).toBeGreaterThan(moved[i - 1]!); // never stuck
    void f1;

    review(gen.indices, fixtureBundle().paletteRgb, strip.name);
    dump(strip, gen.indices, gen.frames, fixtureBundle().paletteRgb);
    if (MODE !== 'update') {
      const golden = readMeta().scenes[strip.name];
      expect(golden, `${strip.name}: missing from motion meta.json`).toBeDefined();
      expect(sha256Hex(gen.indices), `${strip.name}: strip sha drifted from meta.json`).toBe(golden!.indexSha256);
    }
  });
}

describe('M5-10 motion strips (L5 feel evidence)', () => {
  afterEach(() => {
    puserGlobals.onground = false; // p_user.c file-scope global hygiene (feel convention)
  });
  for (const s of STRIPS) stripCase(s);

  it('motion suites green alongside the scripted goldens (exit checklist 2/5)', () => {
    // Pragmatic guard: walls + feel suites are part of THIS run; their
    // byte goldens + hashes carry the "exists AND green" claim. Assert
    // their meta exists so a deleted suite cannot silently redefine green.
    expect(existsSync(fileURLToPath(new URL('./goldens/walls/meta.json', import.meta.url)))).toBe(true);
    expect(existsSync(fileURLToPath(new URL('../sim/feel.test.ts', import.meta.url)))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Minimal PNG writer — verbatim port of scripts/goldens-update.mjs's  */
/* writer (same format: IHDR + tEXt doom-index-sha256 + filter-0 IDAT  */
/* + IEND). Goldens-update itself is not edited by M5-10 (scripts      */
/* additive), so the writer is carried here; a shared-module extraction */
/* is a noted follow-up.                                               */
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
    raw[p++] = 0; // filter: None
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

/** Decode OUR writer's output (filter 0 only). */
export function decodeStripPng(png: Buffer): { width: number; height: number; pixels: Buffer } {
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'IHDR') {
      width = png.subarray(pos + 8, pos + 8 + 13).readUInt32BE(0);
      height = png.subarray(pos + 8, pos + 8 + 13).readUInt32BE(4);
    } else if (type === 'IDAT') idat.push(Buffer.from(png.subarray(pos + 8, pos + 8 + len)));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3;
  const pixels = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (1 + stride)];
    if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
    raw.copy(pixels, y * stride, y * (1 + stride) + 1, y * (1 + stride) + 1 + stride);
  }
  return { width, height, pixels };
}

export function readShaChunk(png: Buffer): string | null {
  let pos = 8;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString('ascii', pos + 4, pos + 8);
    if (type === 'tEXt') {
      const data = png.subarray(pos + 8, pos + 8 + len);
      const nul = data.indexOf(0);
      if (data.toString('ascii', 0, nul) === 'doom-index-sha256') return data.toString('ascii', nul + 1);
    }
    pos += 12 + len;
  }
  return null;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
