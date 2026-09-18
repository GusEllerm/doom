/**
 * M4-05 — static sprite pass (M4-plan §M4-05 acceptance).
 *
 *  1. Projection vectors: fixture thing 256 units straight ahead — xscale,
 *     screen x1/x2, texturemid and the exact drawn box hand-derived (the
 *     tz/scale chain goes through the pinned core trig tables, so the
 *     literals below are derived ONCE from those tables and hard-written —
 *     a silent scale change breaks the literals, not just the formula).
 *     MINZ reject live.
 *  2. Rotation/flip: 8 viewpoints around a rotating-rot fixture barrel
 *     (rot = (ang − thingang + 9·(ANG45/2)) >> 29 recomputed per case) pick
 *     the right lump; the mirror-pair slots (BAR1A2A8-style) carry
 *     xiscale < 0 + startfrac = (width<<16)−1, incl. the u32 wrap case.
 *     The flipped frames sample the SAME lump in reversed texel order —
 *     vanilla's half-texel mirror bias (startfrac = width<<16 − 1) pinned
 *     by formula, not by pixel equality with the direct frame.
 *  3. Post gaps (decoded transparent rows) leave the pixels beneath
 *     untouched; opaque runs draw the colormap-mapped patch value
 *     (spritelights = scalelight[lightnum] row — no pancake rule).
 *  4. Occlusion: a projected thing behind a one-sided wall draws NOTHING
 *     (SIL_BOTH ⇒ clipbot = negonearray); behind a RAISED-FLOOR pass-seg
 *     (SIL_BOTTOM, r_segs.c:489-497 — a lower BACK ceiling gives sil 0 in
 *     vanilla, planes hide that case) the rows from the sprbottomclip
 *     snapshot down are clipped; a masked drawseg BEHIND the sprite
 *     triggers the injected R_RenderMaskedSegRange over the intersecting
 *     columns instead of clipping (synthetic drawseg — see test note).
 *  5. z-order (ascending scale ⇒ nearer drawn LAST), 128-pool overflow
 *     counter liveness, validcount dedupe.
 *  6. E1M1 (skipIf): vissprite lists bounded, overflow 0, per viewpoints.ts
 *     iwad scene (reuse table, no goldens here).
 *
 * Frame wiring here previews M4-07's renderFrame (clears → walk with seg
 * callbacks + addSectorSprites → drawSprites); the plane draw is absent by
 * design, which keeps every "nothing drawn" pixel comparison exact.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { FixedDiv, FixedMul } from '../core/fixed';
import { buildPatchFromColumns } from '../wad/patch';
import { loadMap } from '../wad/mapdata';
import { buildSpriteDefs } from '../wad/sprites';
import { texturesFromWad } from '../wad/texture';
import type { WadFile } from '../wad/wadfile';
import { WadFile as WadFileCls } from '../wad/wadfile';
import type { MapData, TextureDef } from '../wad/types';

import { WadBuilder } from '../../tests/fixtures/wadWriter';
import { buildMapLumps, type RectMapSpec } from '../../tests/fixtures/mapBuilder';

import { createBspWalker } from './bsp';
import { clearClipArrays, clearDrawsegs, clipValue, drawsegAdd, drawsegCount, getDrawsegs } from './drawsegs';
import { Framebuffer } from './framebuffer';
import { initLightTables } from './lights';
import { loadRenderWorld, type RenderWorld } from './rdata';
import { clearClipSegs, resetRenderCounters } from './solidsegs';
import { createSegCallbacks } from './segs';
import {
  buildRenderMapView,
  createViewState,
  setupView,
  VIEWHEIGHT,
  type RenderMapView,
} from './view';
import { buildStaticThings, installSprites, type InstalledSprites, type StaticThings } from './rthings';
import { createSpritePass, installSpritePatches, type SpritePatch } from './vissprites';

import { degToBam, synthColormapRows, VIEWPOINTS } from '../../tests/render/viewpoints';

/* ------------------------------------------------------------------ */
/* Fixture WAD: map lumps + a BAR1 8-rotation ring + a COL1 rot-0 lump  */
/* ------------------------------------------------------------------ */

const SPR_W = 8; // fixture sprite width (leftoffset 4)

/** Patch columns: value = `lumpIdx*16 + col + 1` (non-zero, per-column so
 * the flip/texel-order tests are meaningful). `hole` blanks the middle 12
 * rows (post gap ⇒ decoded zeros). */
function spriteCols(lumpIdx: number, width: number, height: number, hole = false): number[][] {
  const cols: number[][] = [];
  for (let c = 0; c < width; c++) {
    const col: number[] = [];
    for (let r = 0; r < height; r++) {
      const gap = hole && r >= height / 2 - 6 && r < height / 2 + 6;
      col.push(gap ? 0 : lumpIdx * 16 + c + 1);
    }
    cols.push(col);
  }
  return cols;
}

function spriteLump(lumpIdx: number, width: number, height: number, hole = false): Uint8Array {
  // Sprite convention (R02 §5/§8, pinned by patch.ts docstring):
  // leftoffset = width>>1, topoffset = height (the floor-anchored gzt).
  return buildPatchFromColumns(spriteCols(lumpIdx, width, height, hole), width >> 1, height);
}

const SPR_H = 56; // gzt = 56<<16 at floor 0

/**
 * Fixture WAD: S_START ring BAR1A1 / A2A8 / A3A7 / A4A6 / A5 (slots 0..7 ⇒
 * lumps [0,1,2,3,4,3,2,1], flip on slots 5..7) + COL1A0 (rot=0, lump idx 6).
 * Wall textures are NOT in the wad (walls.test.ts pattern: synthetic
 * in-memory TextureDefs; the fixture patch lumps there are directory-only).
 */
function buildWad(mapLumps: { name: string; data: Uint8Array }[], h: number, col1Hole: boolean): Uint8Array {
  const wad = new WadBuilder('IWAD');
  wad.addLumpMarker('S_START');
  wad.addLump('BAR1A1', spriteLump(0, SPR_W, h));
  wad.addLump('BAR1A2A8', spriteLump(1, SPR_W, h));
  wad.addLump('BAR1A3A7', spriteLump(2, SPR_W, h));
  wad.addLump('BAR1A4A6', spriteLump(3, SPR_W, h));
  wad.addLump('BAR1A5', spriteLump(4, SPR_W, h));
  wad.addLump('COL1A0', spriteLump(6, SPR_W, SPR_H, col1Hole));
  wad.addLumpMarker('S_END');
  wad.addLumpMarker('FIXMAP');
  for (const lump of mapLumps) wad.addLump(lump.name, lump.data);
  return wad.build();
}

/** Fixture wall textures: values avoid 0; DOORFIX0 carries a transparent
 * band ⇒ texMasked=1 ⇒ door lines record maskedtexturecol (recording is
 * M3-06's; M4-05 only needs the snapshot to exist). */
function fixTexture(name: string, hole: boolean): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < 64; c++) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r++) col[r] = hole && r >= 48 && r < 80 ? 0 : ((c * 16 + r) % 200) + 32;
    columns.push(col);
  }
  return { name, width: 64, height: 128, patches: [], columns } as unknown as TextureDef;
}
const FIX_TEXTURES = new Map<string, TextureDef>([
  ['FIXWALL0', fixTexture('FIXWALL0', false)],
  ['DOORFIX0', fixTexture('DOORFIX0', true)],
]);

function wadOf(wadBytes: Uint8Array): WadFile {
  return WadFileCls.parse(wadBytes.buffer as ArrayBuffer);
}

const T = synthColormapRows();
const TABLES = initLightTables(T);

interface Fix {
  md: MapData;
  world: RenderWorld;
  view: RenderMapView;
  rmap: InstalledSprites;
  patches: ReadonlyMap<number, SpritePatch>;
  things: StaticThings;
}

function makeFix(spec: RectMapSpec, h = SPR_H, col1Hole = false): Fix {
  const wad = wadOf(buildWad(buildMapLumps(spec), h, col1Hole));
  const md = loadMap(wad, 'FIXMAP');
  const rmap = installSprites(buildSpriteDefs(wad));
  const patches = installSpritePatches(rmap, (n) => wad.readLump(n));
  const view = buildRenderMapView(md);
  const things = buildStaticThings(md, view, rmap);
  return { md, world: loadRenderWorld(md, FIX_TEXTURES), view, rmap, patches, things };
}

const thingAt = (x: number, y: number, type: number, angle = 0) => ({ x, y, type, angle });

const ROOM_A: RectMapSpec['rooms'][number] = { x: 0, y: 0, w: 512, h: 512 };

/** Geometry fixture: one BAR1 (2035) at (384,256) — viewer (128,256) faces
 * east at EXACTLY 256 map units distance. */
function geoFix(): Fix {
  return makeFix({ rooms: [ROOM_A], things: [thingAt(384, 256, 2035)] });
}

/** Rotation-ring fixture: BAR1 at the (256,256) room centre. */
function ringFix(): Fix {
  return makeFix({ rooms: [ROOM_A], things: [thingAt(256, 256, 2035)] });
}

/* ------------------------------------------------------------------ */
/* Pipeline harness (previews the M4-07 frame order)                    */
/* ------------------------------------------------------------------ */

interface Pipeline {
  fb: Framebuffer;
  pass: ReturnType<typeof createSpritePass>;
  walk(cfg: { x: number; y: number; angle: number }): void;
}

function pipeline(fx: Fix, renderMaskedSegRange?: (ds: number, x1: number, x2: number) => void): Pipeline {
  const fb = new Framebuffer();
  const view = createViewState();
  const segs = createSegCallbacks(fb, fx.world, view, fx.view, TABLES);
  const pass = createSpritePass({
    fb,
    view,
    world: fx.world,
    things: fx.things,
    sprites: fx.rmap,
    patches: fx.patches,
    lights: TABLES,
    ...(renderMaskedSegRange ? { renderMaskedSegRange } : {}),
  });
  const walker = createBspWalker(fx.view, fx.world);
  const cb = { ...segs, addSectorSprites: (s: number) => pass.addSectorSprites(s) };
  return {
    fb,
    pass,
    walk(cfg) {
      setupView(view, { x: cfg.x * FRACUNIT, y: cfg.y * FRACUNIT, angle: cfg.angle });
      fb.clear(0); // test-only background (planes are M4-07's; keeps frames comparable)
      clearClipSegs(320);
      clearDrawsegs();
      clearClipArrays(VIEWHEIGHT);
      resetRenderCounters();
      pass.clearSprites();
      walker.walk(view, cb);
    },
  };
}

function projectOnly(p: Pipeline, k: number): void {
  p.pass.clearSprites();
  p.pass.projectSprite(k);
}

const snapshot = (fb: Framebuffer): Uint8Array => fb.indices.slice();
function diffBox(a: Uint8Array, b: Uint8Array): { x1: number; x2: number; y1: number; y2: number } | null {
  let x1 = 320, x2 = -1, y1 = 200, y2 = -1;
  for (let y = 0; y < 200; y++) {
    for (let x = 0; x < 320; x++) {
      if (a[y * 320 + x] !== b[y * 320 + x]) {
        if (x < x1) x1 = x;
        if (x > x2) x2 = x;
        if (y < y1) y1 = y;
        if (y > y2) y2 = y;
      }
    }
  }
  return x2 < 0 ? null : { x1, x2, y1, y2 };
}

/** spritelights pixel expectation: sector light 192 ⇒ lightnum 12 (NO
 * pancake rule — pinned against wallLightNum), index = xscale>>12. */
function lit(sx: number, texVal: number): number {
  const idx = Math.min(sx >> 12, 47);
  return T[TABLES.scalelight[12 * 48 + idx]! + texVal]!;
}

/* ------------------------------------------------------------------ */
/* 1. Projection vectors                                               */
/* ------------------------------------------------------------------ */

describe('projectSprite — hand-derived vectors (r_things.c R_ProjectSprite)', () => {
  const fx = geoFix();
  const p = pipeline(fx);

  // Derivation (core trig tables pinned by core/tables.test.ts): angle 0 ⇒
  // viewcos = finecosine[0] = 65535 ⇒ tz = FixedMul(256<<16, 65535) =
  // 16776960; xscale = FixedDiv(160<<16, 16776960) = 40960.
  const TZ = FixedMul(256 * FRACUNIT, 65535);
  const S = FixedDiv(160 * FRACUNIT, TZ);

  it('256 units due east: xscale/x1/x2/gz/gzt/texturemid + φ=180 ⇒ rot 4', () => {
    expect(S).toBe(40960); // literal tripwire for the derivation above
    p.walk({ x: 128, y: 256, angle: degToBam(0) });
    const pool = p.pass.pool;
    expect(pool.count).toBe(1);
    expect(pool.scale[0]).toBe(40960);
    // 160 − 4·(40960/65536) = 157.5 ⇒ x1 = 157; right edge 162.5 ⇒ x2 = 161
    expect(pool.x1[0]).toBe(157);
    expect(pool.x2[0]).toBe(161);
    expect(pool.gz[0]).toBe(0); // floor 0 (ONFLOORZ, plan §0.8)
    expect(pool.gzt[0]).toBe(SPR_H * FRACUNIT); // z + spritetopoffset
    expect(pool.texturemid[0]).toBe(SPR_H * FRACUNIT - 41 * FRACUNIT); // gzt − viewz
    // Viewer due west facing east: ang(view→thing) = 0, rot = (0+bias)>>>29
    // = 4 (the .5-truncating bin) ⇒ BAR1A5 slot, no flip.
    expect(pool.xiscale[0]!).toBeGreaterThan(0);
    expect(pool.startfrac[0]).toBe(0);
  });

  it('thing behind the view plane: tz < MINZ rejects before the pool', () => {
    p.walk({ x: 448, y: 256, angle: degToBam(0) }); // thing lies WEST, view EAST
    expect(p.pass.pool.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Rotation + flip across 8 viewpoints                              */
/* ------------------------------------------------------------------ */

describe('rotation selection — 8 positions around the fixture barrel', () => {
  const fx = ringFix();
  const p = pipeline(fx);
  // Viewer at polar φ around the thing (thingangle 0), facing the thing.
  // ang (view→thing) = facing = φ+180; rot = (ang + 0x90000000) >>> 29.
  // Slots: 0:A1 1:A2 2:A3 3:A4 4:A5 5:A4-flip 6:A3-flip 7:A2-flip.
  const CASES = [
    { phi: 0, vx: 384, vy: 256, ang: 180 },
    { phi: 45, vx: 346, vy: 346, ang: 225 },
    { phi: 90, vx: 256, vy: 384, ang: 270 },
    { phi: 135, vx: 166, vy: 346, ang: 315 },
    { phi: 180, vx: 128, vy: 256, ang: 0 },
    { phi: 225, vx: 166, vy: 166, ang: 45 },
    { phi: 270, vx: 256, vy: 128, ang: 90 },
    { phi: 315, vx: 346, vy: 166, ang: 135 }, // wrap: 0x60000000 + bias > 2^32
  ];
  const SLOT_LUMP = [0, 1, 2, 3, 4, 3, 2, 1];
  const SLOT_FLIP = [0, 0, 0, 0, 0, 1, 1, 1];

  for (const c of CASES) {
    const rot = ((((c.ang / 360) * 4294967296) >>> 0) + 0x90000000) >>> 29;
    const lumpIdx = SLOT_LUMP[rot]!;
    const flip = SLOT_FLIP[rot]!;
    it(`viewer at φ=${c.phi}° ⇒ rot ${rot} ⇒ lump idx ${lumpIdx}, flip ${flip}`, () => {
      p.walk({ x: c.vx, y: c.vy, angle: degToBam(c.ang) });
      const pool = p.pass.pool;
      expect(pool.count).toBe(1);
      expect(pool.xiscale[0]! < 0).toBe(flip === 1);
      expect(pool.startfrac[0] === (SPR_W << 16) - 1).toBe(flip === 1);
      // Pixel identity: every drawn pixel value is lumpIdx·16 + texcol + 1
      // through the light row ⇒ collect the distinct drawn values and match
      // them to the expected lump band (mod the colormap row).
      p.pass.drawSprites();
      const drawn = new Set<number>();
      const x1 = pool.x1[0]!, x2 = pool.x2[0]!;
      for (let x = x1; x <= x2; x++) drawn.add(p.fb.indices[100 * 320 + x]!);
      // Values of row 100 must ALL come from the expected lump band.
      const band = [...drawn];
      expect(band.length).toBeGreaterThan(0);
      for (const v of band) {
        // Invert the monotone light row on the band 16·lumpIdx+1 .. +8.
        const match = spriteCols(lumpIdx, SPR_W, SPR_H)
          .map((col) => col[0]!)
          .map((raw) => lit(pool.scale[0]!, raw));
        expect(match).toContain(v);
      }
    });
  }

  it('flip samples the same lump in reversed texel order (vanilla bias)', () => {
    // φ=90 ⇒ rot 2 (BAR1A3 direct); φ=270 ⇒ rot 6 (same lump, flipped).
    // Both views sit 128 units away; the tables make tz exact here
    // (sin/cos at the N/S cardinals), xscale = 81920, x1/x2 = 155..164.
    p.walk({ x: 256, y: 384, angle: degToBam(270) });
    const pool = p.pass.pool;
    expect(pool.count).toBe(1);
    expect(pool.xiscale[0]!).toBeGreaterThan(0);
    const x1 = pool.x1[0]!, x2 = pool.x2[0]!;
    const iscale = FixedDiv(FRACUNIT, pool.scale[0]!);
    p.pass.drawSprites();
    const direct: number[] = [];
    for (let x = x1; x <= x2; x++) direct.push(p.fb.indices[100 * 320 + x]!);
    // Direct texel order at row 100:
    const tcD = direct.map((_, i) => (i * iscale) >> 16);
    expect(tcD).toEqual(direct.map((v) => invTex(v, 2)));

    p.walk({ x: 256, y: 128, angle: degToBam(90) });
    const pool2 = p.pass.pool;
    expect(pool2.xiscale[0]!).toBeLessThan(0);
    expect(pool2.scale[0]).toBe(pool.scale[0]);
    expect(pool2.x1[0]).toBe(x1);
    expect(pool2.x2[0]).toBe(x2);
    p.pass.drawSprites();
    for (let x = x1; x <= x2; x++) {
      const i = x - x1;
      // startfrac = (width<<16)−1, xiscale = −iscale (r_things.c:560-566):
      const tcF = ((SPR_W << 16) - 1 - i * iscale) >> 16;
      expect(p.fb.indices[100 * 320 + x]).toBe(lit(pool2.scale[0]!, 2 * 16 + tcF + 1));
    }
    // And it is the DIRECT sequence reversed-at-texel-level up to vanilla's
    // half-texel bias: monotone decreasing.
    const seq: number[] = [];
    for (let x = x1; x <= x2; x++) seq.push(((SPR_W << 16) - 1 - (x - x1) * iscale) >> 16);
    for (let i = 1; i < seq.length; i++) expect(seq[i]!).toBeLessThanOrEqual(seq[i - 1]!);
  });
});

/** Invert the (monotone, per light row) colormap on one lump band: find the
 * band texel value whose lit() output equals v. */
function invTex(v: number, lumpIdx: number): number {
  for (let t = 0; t < SPR_W; t++) {
    if (lit(81920, lumpIdx * 16 + t + 1) === v) return t;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* 3. Pixel placement + post gaps                                      */
/* ------------------------------------------------------------------ */

describe('drawVisSprite — pixel placement and transparency', () => {
  it('solid sprite paints exactly columns 157..161 × rows 91..125', () => {
    // 256-unit geometry (S = 40960, iscale = 104857): columns 157..161;
    // sprtopscreen = 6553600 − 15·40960 ⇒ yl = 91, yh = 125 (35 rows =
    // 56·0.625 exactly). Values: texels [0,1,3,4,6] ⇒ lump A5 band 65,66,
    // 68,69,71 through the light row.
    const fx = geoFix();
    const p3 = pipeline(fx);
    p3.walk({ x: 128, y: 256, angle: degToBam(0) });
    const pool = p3.pass.pool;
    const sx = pool.scale[0]!;
    const iscale = FixedDiv(FRACUNIT, sx);
    const before = snapshot(p3.fb);
    p3.pass.drawSprites();
    const box = diffBox(before, p3.fb.indices);
    expect(box).not.toBeNull();
    expect(box!.x1).toBe(157);
    expect(box!.x2).toBe(161);
    expect(box!.y1).toBe(91);
    expect(box!.y2).toBe(125);
    for (let y = 0; y < 200; y++) {
      for (let x = 0; x < 320; x++) {
        if (x < 157 || x > 161 || y < 91 || y > 125) {
          expect(p3.fb.indices[y * 320 + x]).toBe(before[y * 320 + x]);
        }
      }
    }
    // Per-column texel identity at a mid row:
    for (let x = 157; x <= 161; x++) {
      const tc = ((x - 157) * iscale) >> 16;
      expect(p3.fb.indices[108 * 320 + x]).toBe(lit(sx, 4 * 16 + tc + 1));
    }
  });

  it('post gaps preserve the pixels beneath; opaque runs draw', () => {
    const fx = makeFix({ rooms: [ROOM_A], things: [thingAt(384, 256, 30)] }, SPR_H, true);
    const p3 = pipeline(fx);
    p3.walk({ x: 128, y: 256, angle: degToBam(0) });
    const pool = p3.pass.pool;
    expect(pool.count).toBe(1);
    const sx = pool.scale[0]!;
    const before = snapshot(p3.fb);
    p3.pass.drawSprites();
    const after = p3.fb.indices;
    expect(diffBox(before, after)).not.toBeNull();
    // sprtopscreen = centeryfrac − scale·texturemid; gap rows 22..33 of the
    // 56-tall patch ⇒ the untouched band is [run0 bottom+1, run1 top−1]:
    const sprtop = (100 * FRACUNIT - FixedMul(15 * FRACUNIT, sx)) | 0;
    const run0Bottom = (sprtop + sx * 22 - 1) >> 16;
    const run1Top = (sprtop + sx * 34 + FRACUNIT - 1) >> 16;
    for (let y = run0Bottom + 1; y < run1Top; y++) {
      for (let x = pool.x1[0]!; x <= pool.x2[0]!; x++) {
        expect(after[y * 320 + x]).toBe(before[y * 320 + x]);
      }
    }
    const box = diffBox(before, after)!;
    expect(box.y1).toBeLessThanOrEqual(run0Bottom);
    expect(box.y2).toBeGreaterThanOrEqual(run1Top);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Occlusion + drawseg clipping                                     */
/* ------------------------------------------------------------------ */

describe('drawSprite — drawseg clipping (r_things.c R_DrawSprite)', () => {
  it('thing fully behind a one-sided VOID wall draws nothing', () => {
    const fx = makeFix({ rooms: [ROOM_A], things: [thingAt(700, 256, 2035)] });
    const p4 = pipeline(fx);
    p4.walk({ x: 448, y: 256, angle: degToBam(0) });
    projectOnly(p4, 0);
    expect(p4.pass.pool.count).toBe(1);
    expect(drawsegCount()).toBeGreaterThan(0);
    const before = snapshot(p4.fb);
    p4.pass.drawSprites();
    expect(diffBox(before, p4.fb.indices)).toBeNull();
  });

  it('pass-seg (raised floor): bottom rows clipped by the sprbottomclip snapshot', () => {
    // B floor 64 > viewz ⇒ SIL_BOTTOM, bsilheight MAXINT (r_segs.c:493-497).
    // The 96-tall barrel stands on the LOWER side (gz 0 < MAXINT ⇒ BOTTOM
    // kept) ⇒ rows from the floorclip snapshot down are clipped. NOTE: a
    // lower BACK *ceiling* would give silhouette 0 in vanilla (r_segs.c:
    // 499-509 checks front < back) — the ceiling case is plane territory
    // (M4-07), not a clip seg.
    const fx = makeFix(
      { rooms: [ROOM_A, { x: 512, y: 0, w: 512, h: 512, floorHeight: 64 }], things: [thingAt(768, 256, 2035)] },
      96,
    );
    const p4 = pipeline(fx, () => {
      throw new Error('no masked drawsegs expected in the step fixture');
    });
    p4.walk({ x: 256, y: 256, angle: degToBam(0) });
    projectOnly(p4, 0);
    const pool = p4.pass.pool;
    expect(pool.count).toBe(1);
    expect(pool.gz[0]).toBe(64 * FRACUNIT); // stands ON the platform
    const before = snapshot(p4.fb);
    p4.pass.drawSprites();
    const box = diffBox(before, p4.fb.indices);
    expect(box).not.toBeNull();
    // The step drawseg: BOTTOM sil covering the centre column with a scale
    // NOT behind the sprite (the far one-sided walls also cover it, but
    // they sit BEHIND ⇒ masked-less ⇒ skip in the same branch vanilla does).
    const ds = getDrawsegs();
    const cx = (pool.x1[0]! + pool.x2[0]!) >> 1;
    let step = -1;
    for (let d = 0; d < ds.count; d++) {
      const front = Math.max(ds.scale1[d]!, ds.scale2[d]!);
      if (ds.x1[d]! <= cx && cx <= ds.x2[d]! && (ds.silhouette[d]! & 1) !== 0 && front > pool.scale[0]!)
        step = d;
    }
    expect(step).toBeGreaterThanOrEqual(0);
    const clipBot = clipValue(ds.sprbottomclip[step]!, cx, VIEWHEIGHT);
    expect(clipBot).toBeGreaterThan(box!.y1);
    expect(box!.y2).toBeLessThan(clipBot);
    for (let y = clipBot; y < VIEWHEIGHT; y++) {
      for (let x = pool.x1[0]!; x <= pool.x2[0]!; x++) {
        expect(p4.fb.indices[y * 320 + x]).toBe(before[y * 320 + x]);
      }
    }
  });

  it('masked drawseg BEHIND the sprite ⇒ renderMaskedSegRange, no clip', () => {
    // The drawseg is injected directly: the SAME-HEIGHT masked door line
    // never reaches R_StoreWallRange through the merged bsp classification
    // (identical heights + identical light ⇒ the noDraw path fires before
    // the midTex check can matter for this geometry — flagged to M4-04,
    // who own the same-height masked scenario). R_DrawSprite consumes
    // drawsegs entries, so the contract asserted here is identical.
    const fx = geoFix();
    const calls: { ds: number; x1: number; x2: number }[] = [];
    const p4 = pipeline(fx, (dsN, x1, x2) => calls.push({ ds: dsN, x1, x2 }));
    p4.walk({ x: 128, y: 256, angle: degToBam(0) });
    const pool = p4.pass.pool;
    expect(pool.count).toBe(1);
    const ds = getDrawsegs();
    const d = drawsegAdd(0); // silhouette NONE, clips NULL (drawsegs.ts defaults)
    ds.x1[d] = pool.x1[0]! - 2;
    ds.x2[d] = pool.x2[0]! + 2;
    ds.scale1[d] = pool.scale[0]! - 1; // strictly BEHIND
    ds.scale2[d] = pool.scale[0]! - 1;
    ds.maskedcol[d] = 0; // non-NULL maskedtexturecol "pointer"
    const before = snapshot(p4.fb);
    p4.pass.drawSprites();
    expect(calls.length).toBe(1); // wall drawsegs: behind+unmasked ⇒ continue
    expect(calls[0]!.ds).toBe(d);
    expect(calls[0]!.x1).toBe(Math.max(ds.x1[d]!, pool.x1[0]!));
    expect(calls[0]!.x2).toBe(Math.min(ds.x2[d]!, pool.x2[0]!));
    // Sprites drew AFTER (stub draws nothing): pixels changed, unclipped.
    expect(diffBox(before, p4.fb.indices)).not.toBeNull();
    expect(diffBox(before, p4.fb.indices)!.y2).toBe(125); // full height kept
  });
});

/* ------------------------------------------------------------------ */
/* 5. Sort order, overflow, validcount                                 */
/* ------------------------------------------------------------------ */

describe('sort / pool / validcount', () => {
  it('two overlapping things: ascending scale sort, nearer draws LAST', () => {
    const fx = makeFix({
      rooms: [ROOM_A],
      things: [thingAt(320, 250, 30), thingAt(384, 250, 2035)], // COL1 near, BAR1 far
    });
    const p5 = pipeline(fx);
    p5.walk({ x: 160, y: 250, angle: degToBam(0) });
    const pool = p5.pass.pool;
    expect(pool.count).toBe(2);
    p5.pass.sortVisSprites();
    const a = pool.sortOrder[0]!;
    const b = pool.sortOrder[1]!;
    expect(pool.scale[a]!).toBeLessThan(pool.scale[b]!); // far FIRST
    p5.pass.drawSprites();
    // Column 160, a row in both spans ⇒ the NEAR COL1 band (6·16+t+1).
    const v = p5.fb.indices[100 * 320 + 160]!;
    const near = pool.sortOrder[1]!;
    const iscale = FixedDiv(FRACUNIT, pool.scale[near]!);
    const tc = ((160 - pool.x1[near]!) * iscale) >> 16;
    expect(v).toBe(lit(pool.scale[near]!, 6 * 16 + tc + 1));
  });

  it('128-pool overflow is counted; draw still runs', () => {
    const things = [];
    for (let row = 0; row < 3; row++) {
      for (let i = 0; i < 80; i++) {
        things.push(thingAt(320 + row * 128, 412 + Math.round(i * 2.5), 2035));
      }
    }
    const fx = makeFix({ rooms: [{ x: 0, y: 0, w: 1024, h: 1024 }], things });
    const p5 = pipeline(fx);
    p5.walk({ x: 64, y: 512, angle: degToBam(0) });
    expect(p5.pass.pool.count).toBe(128);
    expect(p5.pass.visspriteOverflow()).toBeGreaterThan(0);
    expect(() => p5.pass.drawSprites()).not.toThrow();
  });

  it('validcount: one sector across many subsectors adds each thing once', () => {
    const fx = makeFix({
      rooms: [ROOM_A],
      things: [thingAt(384, 200, 2035), thingAt(384, 300, 30)],
    });
    const p5 = pipeline(fx);
    p5.walk({ x: 256, y: 256, angle: degToBam(0) });
    expect(p5.pass.pool.count).toBe(2); // callback fired per subsector; deduped
  });
});

/* ------------------------------------------------------------------ */
/* 6. E1M1 census (skipIf)                                             */
/* ------------------------------------------------------------------ */

function iwadPath(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url)),
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

const iwad = iwadPath();
describe.skipIf(iwad === undefined)('E1M1 vissprite census (skipIf no IWAD)', () => {
  it('every iwad viewpoint: bounded list, overflow 0, draw runs', () => {
    const wad = wadOf(readFileSync(iwad!));
    const md = loadMap(wad, 'E1M1');
    const rmap = installSprites(buildSpriteDefs(wad));
    const patches = installSpritePatches(rmap, (n) => wad.readLump(n));
    const view = buildRenderMapView(md);
    const things = buildStaticThings(md, view, rmap);
    const world = loadRenderWorld(md, texturesFromWad(wad));
    const fb = new Framebuffer();
    const viewState = createViewState();
    const pass = createSpritePass({
      fb,
      view: viewState,
      world,
      things,
      sprites: rmap,
      patches,
      lights: TABLES,
    });
    const walker = createBspWalker(view, world);
    const cb = {
      ...createSegCallbacks(fb, world, viewState, view, TABLES),
      addSectorSprites: (s: number) => pass.addSectorSprites(s),
    };
    let total = 0;
    for (const scene of VIEWPOINTS.filter((v) => v.kind === 'iwad')) {
      setupView(viewState, {
        x: scene.x * FRACUNIT,
        y: scene.y * FRACUNIT,
        angle: degToBam(scene.angleDeg),
      });
      clearClipSegs(320);
      clearDrawsegs();
      clearClipArrays(VIEWHEIGHT);
      resetRenderCounters();
      pass.clearSprites();
      walker.walk(viewState, cb);
      expect(pass.visspriteOverflow(), scene.name).toBe(0);
      expect(pass.pool.count, scene.name).toBeLessThanOrEqual(128);
      expect(() => pass.drawSprites()).not.toThrow();
      total += pass.pool.count;
    }
    expect(total).toBeGreaterThan(0);
  });
});
