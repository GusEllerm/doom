/**
 * sim/pslide tests (M5-04) — P_SlideMove + P_HitSlideLine (p_map.c part 3).
 *
 * Acceptance (M5-plan §M5-04):
 *  1) 45°-into-wall fixture: final position within 1 unit of the wall,
 *     momentum = tangential projection — intercept frac RE-DERIVED by a
 *     BigInt/integer brute-force oracle over every line × the three corner
 *     traces (never the implementation's own bookkeeping);
 *  2) axis-aligned mom ⇒ that component zeroed (both ST_ branches);
 *  3) stairstep fires when the traces hit nothing but TryMove blocks —
 *     dropoff (no-MF_DROPOFF) and solid-thing fixtures (DEVIATION from the
 *     plan's "low-clearance" wording: a low-clearance line ALWAYS blocks
 *     PTR_SlideTraverse's own height tests, so it can never leave
 *     bestslidefrac == FRACUNIT+1; dropoff/thing blocks are the reachable
 *     stairstep paths in 1.10 — see pslide.ts notes);
 *  4) 3-retry cap reachable in a corner fixture (hitcount == 3 asserted,
 *     no infinite loop) + the momentum-zeroed NE corner (both axes);
 *  5) sign table: 4 wall orientations × approach sides (pHitSlideLine
 *     direct) + head-on (both moments ≈ 0, table-quantization pinned).
 * Extras: MF_SLIDE/MF_FLOAT flags are IGNORED by the slide (friction is
 * the caller's — M5-05 note), determinism double-run.
 *
 * Ground truths re-derived from linuxdoom-1.10: p_map.c:580-787,
 * p_maputl.c:556-610 (intercept frac), r_main.c:340-437 (R_PointToAngle
 * octant boundaries), p_mobj.c:158-172 (caller contract), p_mobj.h:152
 * (MF_SLIDE never used by 1.10 .c files).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it, vi } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { SlopeDiv, tantoangle } from '../core/tables';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData, ST_HORIZONTAL, ST_NEGATIVE, ST_POSITIVE, ST_VERTICAL, type LineArrays, type RuntimeMap } from './map';
import type { LineMapView } from './pmaputl';
import { buildBlockMap } from './blockmap';
import { buildThingLinks, MF_DROPOFF, MF_FLOAT, MF_PICKUP, MF_SHOOTABLE, MF_SLIDE, MF_SOLID, type ThingInfo } from './thinglinks';
import { pTryMove, type Mover, type PMapWorld } from './pmap';
import { pHitSlideLine, pSlideMove, pointToAngleOrigin, slideState, type SlideMover } from './pslide';

const FU = FRACUNIT;
const fx = (units: number): number => (units * FU) | 0;

/* ------------------------------------------------------------------ */
/* Fixture worlds (same pattern as pmap.test.ts)                        */
/* ------------------------------------------------------------------ */

function world(spec: RectMapSpec, info?: ReadonlyMap<number, ThingInfo>): PMapWorld {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const map = buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
  const bm = buildBlockMap(map);
  const links = buildThingLinks(map, bm, { skill: 3, ...(info ? { info } : {}) });
  return { map, bm, links };
}

/** player mobjinfo (info.c:1125-1130): r16 h56, DROPOFF|PICKUP. */
const PLAYER_FLAGS = MF_SOLID | MF_SHOOTABLE | MF_DROPOFF | MF_PICKUP;

function slider(x: number, y: number, momx: number, momy: number, over: Partial<SlideMover> = {}): SlideMover {
  return {
    x,
    y,
    z: 0,
    radius: fx(16),
    height: fx(56),
    flags: PLAYER_FLAGS,
    player: true,
    linkSlot: -1,
    momx,
    momy,
    ...over,
  };
}

/* ------------------------------------------------------------------ */
/* Brute-force intercept oracle (independent of the blockmap/DDA and    */
/* of the implementation's own state): every line × the three vanilla   */
/* corner traces, exact integer re-derivation of PIT_AddLineIntercepts  */
/* (p_maputl.c:556-610) + P_InterceptVector (:221-256) recipes.         */
/* ------------------------------------------------------------------ */

/** FixedMul exact: arithmetic >>16 of the true product (truncating floor). */
const bFM = (a: bigint, b: bigint): bigint => (a * b) >> 16n;

/** FixedDiv 1.10 for |a| < |b| (slide fracs): trunc toward zero. */
function bFixedDiv(a: bigint, b: bigint): number {
  const q = (a * 65536n) / b; // BigInt division truncs toward zero == C double path for these ranges
  return Number(q);
}

/** P_PointOnLineSide exact (incl. on-plane ⇒ side 1 fast-path conventions). */
function oracleSide(map: RuntimeMap, x: number, y: number, line: number): 0 | 1 {
  const L = map.lines;
  const ldx = L.dx[line]!;
  const ldy = L.dy[line]!;
  const v1x = map.verticesX[L.v1[line]!]!;
  const v1y = map.verticesY[L.v1[line]!]!;
  if (ldx === 0) return x <= v1x ? (ldy > 0 ? 1 : 0) : ldy < 0 ? 1 : 0;
  if (ldy === 0) return y <= v1y ? (ldx < 0 ? 1 : 0) : ldx > 0 ? 1 : 0;
  const left = bFM(BigInt(ldy >> 16), BigInt((x - v1x) | 0)); // FM(ldy>>FRACBITS, dx)
  const right = bFM(BigInt(ldy), BigInt(ldx >> 16)); // FM(dy, ldx>>FRACBITS)
  return right < left ? 0 : 1;
}

/** PIT_AddLineIntercepts + P_InterceptVector for one trace vs one line;
 * returns the intercept frac when the trace CROSSES the (infinite) line
 * with frac >= 0, else null. Reproduces the `>>8` recipes with BigInt. */
function oracleFrac(map: RuntimeMap, tx: number, ty: number, tdx: number, tdy: number, line: number): number | null {
  const s1 = oracleSide(map, tx, ty, line);
  const s2 = oracleSide(map, (tx + tdx) | 0, (ty + tdy) | 0, line);
  if (s1 === s2) return null;
  const L = map.lines;
  const vx = BigInt(map.verticesX[L.v1[line]!]!);
  const vy = BigInt(map.verticesY[L.v1[line]!]!);
  const dx = BigInt(L.dx[line]!);
  const dy = BigInt(L.dy[line]!);
  const den = bFM(dy >> 8n, BigInt(tdx)) - bFM(dx >> 8n, BigInt(tdy));
  if (den === 0n) return 0;
  const num =
    bFM(((vx - BigInt(tx)) >> 8n), dy) + bFM(((BigInt(ty) - vy) >> 8n), dx);
  const frac = bFixedDiv(num, den);
  return frac < 0 || frac > 0x10000 ? null : frac; // behind source / beyond segment end (P_TraverseIntercepts maxfrac)
}

/** PTR_SlideTraverse's blocking verdict per line (p_map.c:641-664),
 * openings re-derived straight from the SECTORS lump SoA. */
function oracleBlocks(map: RuntimeMap, mo: SlideMover, line: number): boolean {
  const L = map.lines;
  if (L.sideNumBack[line] === -1) {
    // one-sided: blocks only when hit from the front side ("don't hit the
    // back side" test reads the MOVER's position, not the trace's)
    return oracleSide(map, mo.x, mo.y, line) === 0;
  }
  const f = L.sectorFront[line]!;
  const b = L.sectorBack[line]!;
  const S = map.sectors;
  const opentop = Math.min(S.ceilingHeight[f]!, S.ceilingHeight[b]!);
  const openbottom = Math.max(S.floorHeight[f]!, S.floorHeight[b]!);
  const openrange = (opentop - openbottom) | 0;
  return (
    openrange < mo.height ||
    (opentop - mo.z) * 1 < mo.height ||
    (openbottom - mo.z) * 1 > 24 * 65536
  );
}

/** The vanilla three-corner traces (p_map.c:713-737) — trail/trail NEVER
 * traced — returning the best (lowest) intercept frac + its line. */
function oracleBestSlide(map: RuntimeMap, mo: SlideMover): { frac: number; line: number } | null {
  const leadx = mo.momx > 0 ? (mo.x + mo.radius) | 0 : (mo.x - mo.radius) | 0;
  const trailx = mo.momx > 0 ? (mo.x - mo.radius) | 0 : (mo.x + mo.radius) | 0;
  const leady = mo.momy > 0 ? (mo.y + mo.radius) | 0 : (mo.y - mo.radius) | 0;
  const traily = mo.momy > 0 ? (mo.y - mo.radius) | 0 : (mo.y + mo.radius) | 0;
  let best: { frac: number; line: number } | null = null;
  for (const [sx, sy] of [
    [leadx, leady],
    [trailx, leady],
    [leadx, traily],
  ] as const) {
    for (let line = 0; line < map.lines.count; line++) {
      if (!oracleBlocks(map, mo, line)) continue;
      const f = oracleFrac(map, sx, sy, mo.momx, mo.momy, line);
      if (f !== null && (best === null || f < best.frac)) best = { frac: f, line };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Hand-built LineMapView for pure pHitSlideLine tests                  */
/* ------------------------------------------------------------------ */

interface HandLine {
  readonly v1: readonly [number, number];
  readonly v2: readonly [number, number];
}

function handMap(lines: readonly HandLine[]): LineMapView {
  const vx: number[] = [];
  const vy: number[] = [];
  const dedupe = new Map<string, number>();
  const vIdx: number[] = [];
  for (const l of lines) {
    for (const v of [l.v1, l.v2]) {
      const key = `${v[0]},${v[1]}`;
      let i = dedupe.get(key);
      if (i === undefined) {
        i = vx.length;
        dedupe.set(key, i);
        vx.push(fx(v[0]));
        vy.push(fx(v[1]));
      }
      vIdx.push(i);
    }
  }
  const n = lines.length;
  const arr = (f: (i: number) => number): Int32Array => {
    const a = new Int32Array(n);
    for (let i = 0; i < n; i++) a[i] = f(i);
    return a;
  };
  const L = {
    count: n,
    v1: arr((i) => vIdx[2 * i]!),
    v2: arr((i) => vIdx[2 * i + 1]!),
    dx: arr((i) => (vx[vIdx[2 * i + 1]!]! - vx[vIdx[2 * i]!]!) | 0),
    dy: arr((i) => (vy[vIdx[2 * i + 1]!]! - vy[vIdx[2 * i]!]!) | 0),
    slopetype: new Uint8Array(n),
    bboxLeft: new Int32Array(n),
    bboxRight: new Int32Array(n),
    bboxTop: new Int32Array(n),
    bboxBottom: new Int32Array(n),
    flags: new Int32Array(n),
    special: new Int32Array(n),
    tag: new Int32Array(n),
    sideFront: new Int32Array(n),
    sideBack: new Int32Array(n).fill(-1),
    sectorFront: new Int32Array(n),
    sectorBack: new Int32Array(n).fill(-1),
    valid: new Int32Array(n),
    sideNumFront: new Int32Array(n),
    sideNumBack: new Int32Array(n).fill(-1),
  } as LineArrays;
  for (let i = 0; i < n; i++) {
    const dx = L.dx[i]!;
    const dy = L.dy[i]!;
    L.slopetype[i] = dx === 0 ? ST_VERTICAL : dy === 0 ? ST_HORIZONTAL : dy * dx > 0 ? ST_POSITIVE : ST_NEGATIVE;
  }
  return { verticesX: Int32Array.from(vx), verticesY: Int32Array.from(vy), lines: L };
}

/* ------------------------------------------------------------------ */
/* 5a. pHitSlideLine — sign table: 4 wall orientations × sides          */
/* ------------------------------------------------------------------ */

describe('pHitSlideLine — sign table (wall orientations × approach sides)', () => {
  const m = handMap([
    { v1: [100, -64], v2: [100, 64] }, // 0: vertical, direction north (dy>0)
    { v1: [100, 64], v2: [100, -64] }, // 1: vertical, direction south
    { v1: [-64, -50], v2: [64, -50] }, // 2: horizontal, direction east
    { v1: [64, -50], v2: [-64, -50] }, // 3: horizontal, direction west
    { v1: [0, 0], v2: [128, 128] }, // 4: ST_POSITIVE diagonal
    { v1: [0, 128], v2: [128, 0] }, // 5: ST_NEGATIVE diagonal
  ]);
  expect(m.lines.slopetype.join()).toBe(
    [ST_VERTICAL, ST_VERTICAL, ST_HORIZONTAL, ST_HORIZONTAL, ST_POSITIVE, ST_NEGATIVE].join(),
  );

  const hit = (line: number, px: number, py: number, mx: number, my: number): [number, number] => {
    const mo: Mover = { x: fx(px), y: fx(py), z: 0, radius: fx(16), height: fx(56), flags: 0 };
    slideState.xmove = fx(mx);
    slideState.ymove = fx(my);
    pHitSlideLine(m, mo, line);
    return [slideState.xmove, slideState.ymove];
  };

  it('ST_VERTICAL both directions and both sides: xmove zeroed, ymove untouched', () => {
    for (const line of [0, 1]) {
      expect(hit(line, 110, 0, 6, 6)).toEqual([0, fx(6)]); // front (east), mom NE
      expect(hit(line, 90, 0, -6, 6)).toEqual([0, fx(6)]); // back (west), mom NW
      expect(hit(line, 110, 0, 6, -6)).toEqual([0, fx(-6)]);
    }
  });

  it('ST_HORIZONTAL both directions and both sides: ymove zeroed, xmove untouched', () => {
    for (const line of [2, 3]) {
      expect(hit(line, 0, -40, 6, 6)).toEqual([fx(6), 0]);
      expect(hit(line, 0, -60, 6, -6)).toEqual([fx(6), 0]);
      expect(hit(line, 0, -40, -6, 6)).toEqual([fx(-6), 0]);
    }
  });

  it('ST_POSITIVE wall: slide-vector signs from both sides, |x|≈|y| tangential', () => {
    // side 0 (below-right of (0,0)→(128,128)); mom north → slides NE along wall
    const [ax, ay] = hit(4, 150, 100, 0, 6);
    expect(ax).toBeGreaterThan(0);
    expect(ay).toBeGreaterThan(0);
    // 45° quantization at index 1024 makes fc/fs differ by ~0.0004 of unity ⇒
    // |x| vs |y| spread ≈ 0.005 units (400 fixed) — LUT reality, pinned.
    expect(Math.abs(ax - ay)).toBeLessThanOrEqual(400);
    expect(Math.abs(ax - fx(3))).toBeLessThanOrEqual(400); // ≈ movelen·cos²45 = 3 units
    // side 1 (above-left); mom south → slides SW along the wall (exact tangent)
    const [bx, by] = hit(4, 100, 150, 0, -6);
    expect(bx).toBeLessThan(0);
    expect(by).toBeLessThan(0);
    expect(Math.abs(bx - by)).toBeLessThanOrEqual(400);
  });

  it('back-side-style approach (deltaangle > ANG180) mirrors the tangent — :611 kludge', () => {
    // wall 4, mover side 0, mom EAST: a real trace could never report this
    // line for this momentum (moving away from it), but IF bestslideline is
    // ever such a line (vanilla corners do), the mirror maps t → −t.
    const [ax, ay] = hit(4, 150, 100, 6, 0);
    expect(ax).toBeLessThan(0);
    expect(ay).toBeLessThan(0);
  });

  it('ST_NEGATIVE wall: slide-vector signs from both sides', () => {
    // (0,128)→(128,0): direction SE; FRONT (side 0) = the ORIGIN side (x+y<128).
    // side 0: mom north → NW along the wall (x<0, y>0)
    const [ax, ay] = hit(5, 40, 40, 0, 6);
    expect(ax).toBeLessThan(0);
    expect(ay).toBeGreaterThan(0);
    expect(Math.abs(ax + ay)).toBeLessThanOrEqual(400);
    expect(Math.abs(ax - fx(-3))).toBeLessThanOrEqual(400);
    // side 1 (x+y > 128): mom south → SE along the wall
    const [bx, by] = hit(5, 100, 100, 0, -6);
    expect(bx).toBeGreaterThan(0);
    expect(by).toBeLessThan(0);
  });

  it('head-on into the diagonal (both sides): both moments killed (≤ 0.004 units)', () => {
    // normal (−1,+1) from side 0 and (+1,−1) from side 1 — deltaangle lands on
    // the ANG90±1 table quantization at an octant boundary: the result is NOT
    // bit-exact zero but |value| ≤ 256 fixed (finecosine[2048] = −50, the
    // half-step LUT quirk) — momentum is dead for gameplay purposes.
    expect(hit(4, 150, 100, -4, 4).every((v) => Math.abs(v) <= 256)).toBe(true);
    expect(hit(4, 100, 150, 4, -4).every((v) => Math.abs(v) <= 256)).toBe(true);
  });

  it('analytic tangential speed: result matches (m·u)u within the octagonal-movelen envelope', () => {
    // pAproxDistance is the OCTAGONAL estimate (up to +6 % at 45° — vanilla's
    // real slide distortion, kept); angles quantize by the tan-LUT. Envelope:
    // |result − exact| ≤ 6.5 % of |mom| + 8 fixed, direction exact.
    const cases: [number, number, number, number][] = [
      [4, 150, 100, 90], // wall 4 side 0, mom north (real trace would hit)
      [4, 100, 150, 270], // wall 4 side 1, mom south
      [5, 40, 40, 90], // wall 5 side 0, mom north
      [5, 100, 100, 270], // wall 5 side 1, mom south
    ];
    for (const [line, px, py, deg] of cases) {
      const mo: Mover = { x: fx(px), y: fx(py), z: 0, radius: fx(16), height: fx(56), flags: 0 };
      const mom = fx(6);
      slideState.xmove = Math.round(mom * Math.cos((deg * Math.PI) / 180));
      slideState.ymove = Math.round(mom * Math.sin((deg * Math.PI) / 180));
      const inx = slideState.xmove;
      const iny = slideState.ymove;
      pHitSlideLine(m, mo, line);
      const ux = m.lines.dx[line]! / Math.hypot(m.lines.dx[line]!, m.lines.dy[line]!);
      const uy = m.lines.dy[line]! / Math.hypot(m.lines.dx[line]!, m.lines.dy[line]!);
      const k = (inx * ux + iny * uy); // (m·u)
      const ex = k * ux;
      const ey = k * uy;
      const tol = Math.abs(mom) * 0.065 + 8;
      expect(Math.abs(slideState.xmove - ex), `${line}/${deg} x`).toBeLessThanOrEqual(tol);
      expect(Math.abs(slideState.ymove - ey), `${line}/${deg} y`).toBeLessThanOrEqual(tol);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 5b. pointToAngleOrigin — octant-boundary pins (r_main.c:340-437)     */
/* ------------------------------------------------------------------ */

describe('pointToAngleOrigin — R_PointToAngle2(0,0,x,y) quirks', () => {
  it('pure axes take the octant-1/3/5/7 branches: ANG90−1 etc., NOT ANG90', () => {
    expect(pointToAngleOrigin(0, fx(1))).toBe(0x40000000 - 1); // ANG90 − 1
    expect(pointToAngleOrigin(fx(1), 0)).toBe(0); // octant 0, SlopeDiv(0,·)=0
    expect(pointToAngleOrigin(0, -fx(1))).toBe(0xc0000000); // ANG270 + 0
    expect(pointToAngleOrigin(-fx(1), 0)).toBe((0x80000000 - 1) >>> 0); // ANG180 − 1
    expect(pointToAngleOrigin(0, 0)).toBe(0); // :343 early-out
  });
  it('octants agree with the table recipe for mixed vectors', () => {
    const pins: [number, number][] = [
      [fx(3), fx(1)],
      [fx(1), fx(3)],
      [-fx(3), fx(1)],
      [-fx(1), -fx(3)],
      [fx(1), -fx(3)],
    ];
    for (const [x, y] of pins) {
      const ax = x >= 0 ? x : -x;
      const ay = y >= 0 ? y : -y;
      const t = ax > ay ? tantoangle[SlopeDiv(ay, ax)]! : tantoangle[SlopeDiv(ax, ay)]!;
      // re-derive quadrant form independently from core tables only
      let expect0: number;
      if (x >= 0 && y >= 0) expect0 = ax > ay ? t : 0x40000000 - 1 - t;
      else if (x >= 0) expect0 = ax > ay ? (0 - t) >>> 0 : 0xc0000000 + t;
      else if (y >= 0) expect0 = ax > ay ? 0x80000000 - 1 - t : 0x40000000 + t;
      else expect0 = ax > ay ? 0x80000000 + t : 0xc0000000 - 1 - t;
      expect(pointToAngleOrigin(x, y)).toBe(expect0 >>> 0);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 1+2. Integration: 45° into a wall (wall-internal room, mom ≤ 16u     */
/* so PIT uses the short side test — traces stay inside the blockmap)   */
/* ------------------------------------------------------------------ */

const ROOM1: RectMapSpec = { rooms: [{ x: 0, y: 0, w: 512, h: 512 }] };

describe('pSlideMove — 45° into a wall (acceptance 1 + 2)', () => {
  it('lands flush (<1 unit) with mom = tangential, frac oracle-re-derived', () => {
    const w = world(ROOM1);
    const mo = slider(fx(494), fx(250), fx(10), fx(10));

    // precondition (M5-05 call contract): the full TryMove FAILED first
    expect(pTryMove(w, mo, (mo.x + mo.momx) | 0, (mo.y + mo.momy) | 0)).toBe(false);
    expect(mo.x).toBe(fx(494)); // failed TryMove moved nothing

    const best = oracleBestSlide(w.map, mo);
    expect(best, 'oracle finds the east wall').not.toBeNull();
    const f = best!.frac; // exact-recipe re-derivation of the intercept

    pSlideMove(w, mo);

    // position = x0 + FM(mom, f−0x800) (flush leg), then tangential-only leg
    const adv = f - 0x800;
    const rem = ((FU - f) | 0) >>> 0;
    expect(mo.x).toBe((fx(494) + FixedMul(fx(10), adv)) | 0);
    expect(mo.y).toBe((fx(250) + FixedMul(fx(10), adv) + FixedMul(fx(10), rem)) | 0);

    // flush: right bbox edge within [0,1) units of x=512
    const gap = fx(512) - (mo.x + mo.radius);
    expect(gap).toBeGreaterThanOrEqual(0);
    expect(gap).toBeLessThan(FU);

    // momentum = tangential projection: ST_VERTICAL wall zeroes x, keeps
    // FM(momy, remainder) exactly (BigInt-oracle frac, not impl state)
    expect(mo.momx).toBe(0);
    expect(mo.momy).toBe(FixedMul(fx(10), rem));
    expect(mo.momy).toBeGreaterThan(fx(7)); // ≈ 8 units of the original 10 kept
    expect(slideState.hitcount).toBe(1);
  });

  it('axis-aligned mom east into the wall: momx zeroed (ST_VERTICAL branch)', () => {
    const w = world(ROOM1);
    const mo = slider(fx(495.5), fx(250), fx(8), 0);
    expect(pTryMove(w, mo, (mo.x + mo.momx) | 0, mo.y)).toBe(false);
    pSlideMove(w, mo);
    expect(mo.momx).toBe(0);
    expect(mo.momy).toBe(0);
    // momy was 0 ⇒ remainder is a no-op move; final x = fudge flush only
    expect(mo.x + mo.radius).toBeLessThanOrEqual(fx(512));
    expect(fx(512) - (mo.x + mo.radius)).toBeLessThan(FU);
  });

  it('axis-aligned mom north into the wall: momy zeroed (ST_HORIZONTAL branch)', () => {
    const w = world(ROOM1);
    const mo = slider(fx(250), fx(495.5), 0, fx(6));
    expect(pTryMove(w, mo, mo.x, (mo.y + mo.momy) | 0)).toBe(false);
    pSlideMove(w, mo);
    expect(mo.momy).toBe(0);
    expect(mo.x).toBe(fx(250));
    expect(fx(512) - (mo.y + mo.radius)).toBeLessThan(FU);
  });

  it('momy EXACTLY zero takes the vanilla "else" corner branch (lead on − side)', () => {
    // pin: momx>0, momy==0 ⇒ leady = y − radius / traily = y + radius
    // (p_map.c:708-724) — the slide still resolves identically along the wall
    const w = world(ROOM1);
    const mo = slider(fx(495.5), fx(250), fx(8), 0);
    pSlideMove(w, mo);
    expect(mo.momx).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Stairstep (traces hit nothing, TryMove still blocks)              */
/* ------------------------------------------------------------------ */

describe('pSlideMove — stairstep', () => {
  it('dropoff, no-MF_DROPOFF mover: BOTH legs attempted, nothing moves', () => {
    const w = world({
      rooms: [
        { x: 0, y: 0, w: 512, h: 512 },
        { x: 512, y: 0, w: 512, h: 512, floorHeight: -64 },
      ],
    });
    const mo = slider(fx(498), fx(250), fx(10), fx(10), { flags: MF_SOLID | MF_SHOOTABLE }); // NO MF_DROPOFF
    expect(pTryMove(w, mo, (mo.x + mo.momx) | 0, (mo.y + mo.momy) | 0)).toBe(false);

    const best = oracleBestSlide(w.map, mo);
    expect(best, 'the shared line does NOT block the slide trace').toBeNull();

    pSlideMove(w, mo);
    // y-leg (498, 260) dropoff-blocked, then x-leg (508, 250) dropoff-blocked
    expect(mo.x).toBe(fx(498));
    expect(mo.y).toBe(fx(250));
    expect(mo.momx).toBe(fx(10)); // momentum untouched (stairstep never clips)
    expect(mo.momy).toBe(fx(10));
    expect(slideState.hitcount).toBe(1);
  });

  it('solid thing blocks: y-leg first (fails), x-leg lands (order pin)', () => {
    const w = world({ rooms: [{ x: 0, y: 0, w: 512, h: 512 }], things: [{ x: 128, y: 128, type: 2035 }] });
    const mo = slider(fx(140), fx(101.5), fx(12), fx(8));
    // full move blocked by the barrel (dist test: |dx|<26 ∧ |dy|<26)
    expect(pTryMove(w, mo, (mo.x + mo.momx) | 0, (mo.y + mo.momy) | 0)).toBe(false);
    expect(oracleBestSlide(w.map, mo)).toBeNull(); // lines: nothing crossed

    pSlideMove(w, mo);
    // y-leg (140, 110) still overlaps (dx=12, dy=18 both < 26) → fails;
    // x-leg (152, 101.5) has dy = 26.5 ≥ 26 → succeeds. y-first order pinned.
    expect(mo.x).toBe((fx(140) + fx(12)) | 0);
    expect(mo.y).toBe(fx(101.5));
  });

  it('mover WITH MF_DROPOFF takes the same ledge via a normal slide (contrast)', () => {
    const w = world({
      rooms: [
        { x: 0, y: 0, w: 512, h: 512 },
        { x: 512, y: 0, w: 512, h: 512, floorHeight: -64 },
      ],
    });
    const mo = slider(fx(498), fx(250), fx(10), fx(10)); // player flags include DROPOFF
    expect(pTryMove(w, mo, (mo.x + mo.momx) | 0, (mo.y + mo.momy) | 0)).toBe(true);
    // (no slide needed at all — the DROPOFF edge of §M5-03 stays M5-03's)
  });
});

/* ------------------------------------------------------------------ */
/* 4. Corner fixtures: both-axis momentum kill + the 3-retry cap        */
/* ------------------------------------------------------------------ */

describe('pSlideMove — corner cases (acceptance 4)', () => {
  it('NE corner at 45°: both momentum axes end zero, no wall penetration', () => {
    const w = world(ROOM1);
    const mo = slider(fx(495.5), fx(495.5), fx(8), fx(8));
    expect(pTryMove(w, mo, (mo.x + mo.momx) | 0, (mo.y + mo.momy) | 0)).toBe(false);
    pSlideMove(w, mo);
    expect(mo.momx).toBe(0);
    expect(mo.momy).toBe(0);
    expect(mo.x + mo.radius).toBeLessThanOrEqual(fx(512));
    expect(mo.y + mo.radius).toBeLessThanOrEqual(fx(512));
    expect(slideState.hitcount).toBeLessThanOrEqual(3);
  });

  it('shallow NE corner scrape: converges, never hangs, stays in the room', () => {
    // mom mostly along the east wall with a slight north bias. Iteration 1
    // clips at the east wall, the north-bound remainder fails against the
    // north wall, iteration 2 re-clips and its slide degenerates to a
    // zero-move TryMove at the mover's own position (clipped momx is 0) —
    // vanilla exits at hitcount 2 here; the 3-cap is proven by the scripted
    // test below.
    const w = world(ROOM1);
    const mo = slider(fx(495.5), fx(495.9), fx(10), fx(1));
    expect(pTryMove(w, mo, (mo.x + mo.momx) | 0, (mo.y + mo.momy) | 0)).toBe(false);

    pSlideMove(w, mo); // must RETURN, never hang

    expect(slideState.hitcount).toBeLessThanOrEqual(3);
    expect(mo.x + mo.radius).toBeLessThanOrEqual(fx(512));
    expect(mo.y + mo.radius).toBeLessThanOrEqual(fx(512));
    expect(mo.momx).toBe(0); // east-wall clip stuck
  });
});

/* ------------------------------------------------------------------ */
/* 4b. hitcount == 3 cap — scripted TryMove seam (control-flow proof)   */
/* ------------------------------------------------------------------ */

// DEVIATION (pinned): with the GRID-ONLY fixture BSP (A-04: diagonal walls
// impossible) the cap is geometrically unreachable by wall geometry alone —
// every retry momentum is axis-aligned, so iteration 2's slide against the
// second wall degenerates to a zero-move TryMove that always succeeds
// (hitcount == 2 in every rect-corner probe; vanilla needs the projection
// branch to livelock). The cap and the no-infinite-loop contract are
// therefore verified with scripted P_TryMove verdicts while the traces,
// positions and momentum algebra stay fully real.
const capCtl = vi.hoisted(() => ({
  failOn: null as number[] | null,
  calls: 0,
}));

vi.mock('./pmap', async (importOriginal) => {
  const real = await importOriginal<typeof import('./pmap')>();
  return {
    ...real,
    pTryMove: (
      w: Parameters<typeof real.pTryMove>[0],
      mo: Parameters<typeof real.pTryMove>[1],
      x: number,
      y: number,
    ) => {
      capCtl.calls++;
      if (capCtl.failOn !== null && capCtl.failOn.includes(capCtl.calls)) return false;
      return real.pTryMove(w, mo, x, y);
    },
  };
});

describe('pSlideMove — hitcount == 3 cap (scripted TryMove, acceptance 4)', () => {
  it('two consecutive blocked slides ⇒ third iteration stairsteps immediately', () => {
    const w = world(ROOM1);
    const mo = slider(fx(495.5), fx(495.9), fx(10), fx(1));
    capCtl.calls = 0;
    // call order: 1 fudge(iter1) real-OK, 2 slide(iter1) FAIL, 3 fudge(iter2)
    // real-OK, 4 slide(iter2) FAIL, 5/6 stairstep legs FAIL ⇒ no movement
    capCtl.failOn = [2, 4, 5, 6];

    pSlideMove(w, mo);

    expect(slideState.hitcount).toBe(3); // cap path taken — loop did not spin
    expect(capCtl.calls).toBe(6); // fudge,slide,fudge,slide,stairstep,stairstep
    capCtl.failOn = null;
    // both fudge legs landed flush; both stairstep legs were refused
    expect(mo.x + mo.radius).toBeLessThanOrEqual(fx(512));
    expect(mo.y + mo.radius).toBeLessThanOrEqual(fx(512));
    expect(mo.momx).toBe(0); // iteration-2's HitSlideLine clip already written
  });
});

/* ------------------------------------------------------------------ */
/* Flags + determinism                                                  */
/* ------------------------------------------------------------------ */

describe('pSlideMove — flags are irrelevant to the slide (M5-05 friction note)', () => {
  it('MF_SLIDE|MF_FLOAT mover slides bit-identically to a plain mover', () => {
    // 1.10 P_SlideMove/P_HitSlideLine/PTR_SlideTraverse branch on NO flag —
    // MF_SLIDE (p_mobj.h:152) is referenced by no 1.10 .c file at all;
    // friction is P_XYMovement's (p_mobj.c), i.e. the CALLER's (M5-05).
    const w1 = world(ROOM1);
    const a = slider(fx(494), fx(250), fx(10), fx(10));
    pSlideMove(w1, a);
    const w2 = world(ROOM1);
    const b = slider(fx(494), fx(250), fx(10), fx(10), { flags: PLAYER_FLAGS | MF_SLIDE | MF_FLOAT });
    pSlideMove(w2, b);
    expect([b.x, b.y, b.momx, b.momy]).toEqual([a.x, a.y, a.momx, a.momy]);
  });

  it('determinism: identical inputs ⇒ identical outputs (double run)', () => {
    const run = (): [number, number, number, number, number] => {
      const w = world(ROOM1);
      const mo = slider(fx(495.5), fx(495.9), fx(10), fx(1));
      pSlideMove(w, mo);
      return [mo.x, mo.y, mo.momx, mo.momy, slideState.hitcount];
    };
    expect(run()).toEqual(run());
  });
});
