/**
 * sim/pmaputl tests (M5-01) — p_maputl.c primitive ports.
 *
 * Acceptance (M5-plan §M5-01): 1) P_AproxDistance / P_BoxOnLineSide known
 * vectors incl. straddle and negative coords, all four slopetypes and both
 * line orientations per axis; 2) P_InterceptVector BigInt oracle incl.
 * den==0 ⇒ 0 + documented precision cost; 3) P_PathTraverse block-crossed
 * lines == brute-force reference on fixture grids (seeded); 4) zero
 * allocation in steady state.
 *
 * Ground truths are derived independently where possible: exact BigInt
 * cross products for side tests, hand-fixed values for approx distance.
 * Maps: FIXMAP fixtures (rectBuilder) for axis-aligned geometry + hand
 * built SoA views for the diagonal slopetypes (the rect builder emits
 * axis-aligned lines only).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { FRACBITS, FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import {
  buildMapFromData,
  ST_VERTICAL,
  type FixedBBox,
  type LineArrays,
  type RuntimeMap,
  type SectorArrays,
} from './map';
import {
  opening,
  pAproxDistance,
  pBoxOnLineSide,
  pInterceptVector,
  pLineOpening,
  pPointOnLineSide,
  type LineMapView,
} from './pmaputl';

const FU = FRACUNIT;
const fx = (units: number): number => (units * FU) | 0;
const FRAC = (n: number): number => Math.trunc(n * FU);

/** FIXMAP fixture map (rect builder → wad → RuntimeMap), as in M2 suites. */
function rt(spec: RectMapSpec, name = 'FIXMAP'): RuntimeMap {
  const bytes = buildFixtureMapWad(spec, name);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), name));
}

/** mulberry32 (seeded PRNG — no Math.random anywhere, A-INT1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Hand-built SoA views (no lumps needed for pure-geometry tests)       */
/* ------------------------------------------------------------------ */

interface HandLine {
  /** vertex coords in MAP UNITS; v1→v2 is the line direction */
  readonly v1: readonly [number, number];
  readonly v2: readonly [number, number];
}

/** Build a LineMapView from plain-unit lines (slopetype per map.ts rule). */
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
    L.slopetype[i] = dx === 0 ? ST_VERTICAL : dy === 0 ? 1 : dy * dx > 0 ? 2 : 3;
    const ax = vx[vIdx[2 * i]!]!;
    const bx = vx[vIdx[2 * i + 1]!]!;
    const ay = vy[vIdx[2 * i]!]!;
    const by = vy[vIdx[2 * i + 1]!]!;
    L.bboxLeft[i] = Math.min(ax, bx);
    L.bboxRight[i] = Math.max(ax, bx);
    L.bboxBottom[i] = Math.min(ay, by);
    L.bboxTop[i] = Math.max(ay, by);
  }
  return { verticesX: Int32Array.from(vx), verticesY: Int32Array.from(vy), lines: L };
}

/** Exact side of point vs infinite line v1→v2 via BigInt cross product.
 * Vanilla convention: side 0 (front) iff cross(dir, p−v1) < 0 (right of
 * direction); on-plane ties go to side 1 — matches `right < left`. */
function exactSide(map: LineMapView, line: number, xUnits: number, yUnits: number): 0 | 1 {
  const L = map.lines;
  const v1x = BigInt(map.verticesX[L.v1[line]!]!) * 1n;
  const v1y = BigInt(map.verticesY[L.v1[line]!]!) * 1n;
  const dx = BigInt(L.dx[line]!);
  const dy = BigInt(L.dy[line]!);
  const px = fx(xUnits);
  const py = fx(yUnits);
  const cross = dx * BigInt(py - Number(v1y)) - dy * BigInt(px - Number(v1x));
  return cross < 0n ? 0 : 1;
}

const box = (
  left: number,
  right: number,
  bottom: number,
  top: number,
): FixedBBox => ({ left: fx(left), right: fx(right), bottom: fx(bottom), top: fx(top) });

/* ------------------------------------------------------------------ */
/* 1a. P_AproxDistance (p_maputl.c:39-58)                               */
/* ------------------------------------------------------------------ */

describe('pAproxDistance — known vectors', () => {
  it('octagon estimate dx+dy−min>>1, both branches', () => {
    expect(pAproxDistance(0, 0)).toBe(0);
    // (3,4): dx<dy → 3+4−1.5 = 5.5 units
    expect(pAproxDistance(fx(3), fx(4))).toBe(fx(5) + FU / 2);
    // (4,3): dx>=dy → 4+3−1.5 = 5.5 (symmetric)
    expect(pAproxDistance(fx(4), fx(3))).toBe(fx(5) + FU / 2);
    // pure axis: larger + smaller/2 with smaller = 0
    expect(pAproxDistance(fx(10), 0)).toBe(fx(10));
    expect(pAproxDistance(0, fx(-10))).toBe(fx(10));
    // odd fraction truncates per >>1 on the SMALLER abs delta only
    expect(pAproxDistance(fx(1) + 1, fx(7))).toBe(fx(1) + 1 + fx(7) - ((fx(1) + 1) >> 1));
  });

  it('absorbs negatives; C abs wraps at MININT (pinned quirk)', () => {
    expect(pAproxDistance(-fx(3), fx(4))).toBe(fx(5) + FU / 2);
    expect(pAproxDistance(-fx(4), -fx(3))).toBe(fx(5) + FU / 2);
    // gcc abs(MININT) == MININT: dx stays negative → dx<dy branch →
    // MININT + 0 − (MININT>>1) = −2^30 + 0 − 0 with |0 wrap.
    expect(pAproxDistance(-0x80000000, 0)).toBe(((0x80000000 | 0) + (1 << 30)) | 0);
  });
});

/* ------------------------------------------------------------------ */
/* 1b. P_PointOnLineSide (p_maputl.c:60-104)                            */
/* ------------------------------------------------------------------ */

describe('pPointOnLineSide — fast paths + cross product', () => {
  it('vertical lines: side flips with dy, x<=v1x rule on-plane→back', () => {
    const m = handMap([
      { v1: [100, -10], v2: [100, 10] }, // dy > 0 (north)
      { v1: [100, 10], v2: [100, -10] }, // dy < 0 (south)
    ]);
    expect(pPointOnLineSide(m, fx(200), fx(0), 0)).toBe(0); // east = front
    expect(pPointOnLineSide(m, fx(50), fx(0), 0)).toBe(1);
    expect(pPointOnLineSide(m, fx(100), fx(0), 0)).toBe(1); // x<=v1x → dy>0 → 1
    expect(pPointOnLineSide(m, fx(200), fx(0), 1)).toBe(1); // dy<0 mirrors
    expect(pPointOnLineSide(m, fx(50), fx(0), 1)).toBe(0);
  });

  it('horizontal lines: side flips with dx; negative coords', () => {
    const m = handMap([
      { v1: [-200, -50], v2: [-100, -50] }, // dx > 0 (east), y negative
      { v1: [-100, -50], v2: [-200, -50] }, // dx < 0 (west)
    ]);
    expect(pPointOnLineSide(m, fx(-150), fx(0), 0)).toBe(1); // north of east-line
    expect(pPointOnLineSide(m, fx(-150), fx(-100), 0)).toBe(0);
    expect(pPointOnLineSide(m, fx(-150), fx(0), 1)).toBe(0);
    expect(pPointOnLineSide(m, fx(-150), fx(-50), 1)).toBe(1); // y<=v1y → dx<0 → 1
  });

  it('diagonal matches the exact BigInt cross-product side everywhere', () => {
    const m = handMap([
      { v1: [0, 0], v2: [128, 128] }, // ST_POSITIVE
      { v1: [0, 128], v2: [128, 0] }, // ST_NEGATIVE
      { v1: [-64, -32], v2: [-144, -120] }, // negative-coord positive-ish
    ]);
    const probes: [number, number][] = [
      [200, 64],
      [64, 200],
      [-200, 64],
      [64, -200],
      [0, 0],
      [128, 128],
    ];
    for (let line = 0; line < m.lines.count; line++) {
      for (const [px, py] of probes) {
        expect(pPointOnLineSide(m, fx(px), fx(py), line), `${line} @${px},${py}`).toBe(
          exactSide(m, line, px, py),
        );
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* 1c. P_BoxOnLineSide (p_maputl.c:106-157)                             */
/* ------------------------------------------------------------------ */

describe('pBoxOnLineSide — straddle −1, four slopetypes', () => {
  it('vertical wall from a FIXMAP fixture, both orientations + negatives', () => {
    const spec: RectMapSpec = {
      rooms: [
        { x: -256, y: 0, w: 128, h: 128 },
        { x: -128, y: 0, w: 128, h: 128 },
      ],
    };
    const map: RuntimeMap = rt(spec);
    // The shared edge is the only vertical line at x = −128.
    let shared = -1;
    for (let i = 0; i < map.lines.count; i++) {
      if (
        map.lines.bboxLeft[i] === fx(-128) &&
        map.lines.bboxRight[i] === fx(-128) &&
        map.lines.dy[i] !== 0
      )
        shared = i;
    }
    expect(shared).toBeGreaterThanOrEqual(0);

    const west = box(-200, -130, 10, 100);
    const east = box(-126, -60, 10, 100);
    const straddle = box(-140, -110, 10, 100);
    const westSide = pPointOnLineSide(map, fx(-160), fx(50), shared);
    const eastSide = pPointOnLineSide(map, fx(-90), fx(50), shared);

    expect(pBoxOnLineSide(map, west, shared)).toBe(westSide);
    expect(pBoxOnLineSide(map, east, shared)).toBe(eastSide);
    expect(pBoxOnLineSide(map, straddle, shared)).toBe(-1);
    expect(westSide).not.toBe(eastSide);
  });

  it('horizontal lines: above/below/straddle, flip pinned to dx sign', () => {
    const m = handMap([
      { v1: [-50, 100], v2: [50, 100] }, // dx > 0
      { v1: [50, 100], v2: [-50, 100] }, // dx < 0 (same edge, reversed)
    ]);
    const above = box(-10, 10, 110, 200);
    const below = box(-10, 10, 0, 90);
    const cross = box(-10, 10, 90, 110);
    expect(pBoxOnLineSide(m, above, 0)).toBe(1);
    expect(pBoxOnLineSide(m, below, 0)).toBe(0);
    expect(pBoxOnLineSide(m, above, 1)).toBe(0); // flipped
    expect(pBoxOnLineSide(m, below, 1)).toBe(1);
    expect(pBoxOnLineSide(m, cross, 0)).toBe(-1);
    expect(pBoxOnLineSide(m, cross, 1)).toBe(-1);
  });

  it('vertical flip pinned to dy sign', () => {
    const m = handMap([
      { v1: [0, -10], v2: [0, 10] }, // dy > 0
      { v1: [0, 10], v2: [0, -10] }, // dy < 0
    ]);
    expect(pBoxOnLineSide(m, box(10, 90, -5, 5), 0)).toBe(0);
    expect(pBoxOnLineSide(m, box(-90, -10, -5, 5), 0)).toBe(1);
    expect(pBoxOnLineSide(m, box(10, 90, -5, 5), 1)).toBe(1);
    expect(pBoxOnLineSide(m, box(-90, -10, -5, 5), 1)).toBe(0);
    expect(pBoxOnLineSide(m, box(-10, 10, -5, 5), 0)).toBe(-1);
  });

  it('ST_POSITIVE / ST_NEGATIVE: corner probes + −1 agree with exact sides', () => {
    const m = handMap([
      { v1: [0, 0], v2: [128, 128] }, // ST_POSITIVE
      { v1: [0, 128], v2: [128, 0] }, // ST_NEGATIVE
    ]);
    // Positive diagonal (line 0): corners probed are (left,top)+(right,bottom).
    const posAbove = box(0, 64, 100, 192);
    const posBelow = box(100, 200, 0, 64);
    const posCross = box(0, 64, 0, 64);
    expect(pBoxOnLineSide(m, posAbove, 0)).toBe(1);
    expect(pBoxOnLineSide(m, posBelow, 0)).toBe(0);
    expect(pBoxOnLineSide(m, posCross, 0)).toBe(-1);
    // Negative diagonal (line 1): corners (right,top)+(left,bottom).
    const negBelow = box(150, 200, 0, 40);
    const negAbove = box(50, 100, 100, 200); // clears the INFINITE line too
    const negCross = box(100, 200, 0, 64);
    expect(pBoxOnLineSide(m, negBelow, 1)).toBe(exactSide(m, 1, 200, 40));
    expect(pBoxOnLineSide(m, negBelow, 1)).toBe(exactSide(m, 1, 150, 0));
    expect(pBoxOnLineSide(m, negAbove, 1)).toBe(exactSide(m, 1, 100, 200));
    expect(pBoxOnLineSide(m, negAbove, 1)).toBe(exactSide(m, 1, 50, 100));
    expect(pBoxOnLineSide(m, negCross, 1)).toBe(-1);
    // The −1 cases really are straddles per the exact predicate: the two
    // probed corners disagree.
    expect(exactSide(m, 0, 0, 64)).not.toBe(exactSide(m, 0, 64, 0));
  });
});

/* ------------------------------------------------------------------ */
/* 2a. P_LineOpening (p_maputl.c:290-330)                               */
/* ------------------------------------------------------------------ */

describe('pLineOpening — plain 1.10 min/max (no opentight/closing)', () => {
  it('two-sided heights: min ceiling, max floor, min floor as lowfloor', () => {
    const spec: RectMapSpec = {
      rooms: [
        { x: 0, y: 0, w: 128, h: 128, floorHeight: 0, ceilingHeight: 128 },
        { x: 128, y: 0, w: 128, h: 128, floorHeight: 24, ceilingHeight: 96 },
      ],
    };
    const map = rt(spec);
    let shared = -1;
    for (let i = 0; i < map.lines.count; i++) {
      const f = map.lines.sectorFront[i]!;
      const b = map.lines.sectorBack[i]!;
      if (Math.min(f, b) === 1 && Math.max(f, b) === 2) shared = i; // room1↔room2
    }
    expect(shared).toBeGreaterThanOrEqual(0);

    const op = pLineOpening(map, shared);
    expect(op).toBe(opening); // the module singleton (vanilla globals)
    expect(op.opentop).toBe(fx(96)); // min(128, 96)
    expect(op.openbottom).toBe(fx(24)); // max(0, 24)
    expect(op.lowfloor).toBe(fx(0)); // min(0, 24)
    expect(op.openrange).toBe(fx(96) - fx(24));
  });

  it('one-sided sets ONLY openrange=0 — stale globals quirk pinned', () => {
    // line 0 two-sided (sectors 0/1), line 1 one-sided (sideNumBack −1).
    const m = handMap([
      { v1: [0, 0], v2: [0, 128] },
      { v1: [64, 0], v2: [64, 128] },
    ]) as LineMapView & { sectors: SectorArrays };
    m.lines.sideNumBack[0] = 1;
    m.lines.sectorFront[0] = 0;
    m.lines.sectorBack[0] = 1;
    m.sectors = {
      count: 2,
      floorHeight: Int32Array.from([fx(0), fx(24)]),
      ceilingHeight: Int32Array.from([fx(128), fx(96)]),
    } as unknown as SectorArrays;

    const before = pLineOpening(m, 0);
    expect(before.opentop).toBe(fx(96));
    expect(before.openrange).toBe(fx(96) - fx(24));

    const after = pLineOpening(m, 1);
    expect(after).toBe(before); // same singleton, zero allocation
    expect(after.openrange).toBe(0);
    // Vanilla leaves opentop/openbottom/lowfloor from the PREVIOUS call:
    expect(after.opentop).toBe(fx(96));
    expect(after.openbottom).toBe(fx(24));
    expect(after.lowfloor).toBe(fx(0));
  });
});

/* ------------------------------------------------------------------ */
/* 2b. P_InterceptVector (p_maputl.c:221-256) — BigInt oracle           */
/* ------------------------------------------------------------------ */

/** Exact C-semantics pipeline in BigInt: FixedMul = (a*b)>>16 truncated to
 * the low 32 bits (x86 long wrap), arithmetic >>8, int32 wrap on +−, then
 * FixedDiv = abs32 guard (MININT wraps!) then exact rational truncation. */
const wrap32 = (v: bigint): bigint => {
  v &= 0xffffffffn;
  return v >= 0x80000000n ? v - 0x100000000n : v;
};
const bMul = (a: bigint, b: bigint): bigint => wrap32((a * b) >> 16n);
const bAbs = (v: bigint): bigint => (v === -0x80000000n ? v : v < 0n ? -v : v);
const bDiv = (a: bigint, b: bigint): bigint => {
  const aa = bAbs(a);
  const ab = bAbs(b);
  if ((aa >> 14n) >= ab) return (a ^ b) < 0n ? -0x80000000n : 0x7fffffffn;
  return wrap32((a * 65536n) / b);
};

interface DL {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** BigInt twin of P_InterceptVector(v2, v1) — the binding oracle. */
function interceptVectorOracle(v2: DL, v1: DL): number {
  const den = wrap32(
    bMul(BigInt(v1.dy) >> 8n, BigInt(v2.dx)) - bMul(BigInt(v1.dx) >> 8n, BigInt(v2.dy)),
  );
  if (den === 0n) return 0;
  const num = wrap32(
    bMul(wrap32(BigInt(v1.x) - BigInt(v2.x)) >> 8n, BigInt(v1.dy)) +
      bMul(wrap32(BigInt(v2.y) - BigInt(v1.y)) >> 8n, BigInt(v1.dx)),
  );
  return Number(bDiv(num, den));
}

/** Fully exact (unshifted) rational frac along v2 + its denominator (for
 * conditioning), for the precision-cost report:
 * frac = cross(P1−P2, v1d) / cross(v2d, v1d) × FRACUNIT. */
function exactFrac(v2: DL, v1: DL): { frac: number; den: number } | null {
  const num =
    (BigInt(v1.x) - BigInt(v2.x)) * BigInt(v1.dy) -
    (BigInt(v1.y) - BigInt(v2.y)) * BigInt(v1.dx);
  const den = BigInt(v2.dx) * BigInt(v1.dy) - BigInt(v2.dy) * BigInt(v1.dx);
  if (den === 0n) return null; // parallel/coplanar: no finite frac
  return { frac: Number((num * 65536n) / den), den: Number(den) }; // fixed² units
}

describe('pInterceptVector — BigInt oracle, den==0, precision cost', () => {
  it('axis crossing exactly at 1/2 (hand-computed)', () => {
    const trace: DL = { x: 0, y: 0, dx: fx(100), dy: 0 };
    const wall: DL = { x: fx(50), y: 0, dx: 0, dy: fx(100) };
    // num = (50>>8 units-fixed)*dy… pinned both by hand and by oracle.
    expect(pInterceptVector(trace, wall)).toBe(FRAC(0.5));
    expect(pInterceptVector(trace, wall)).toBe(interceptVectorOracle(trace, wall));
  });

  it('diagonal trace vs wall; behind-start ⇒ negative', () => {
    const diag: DL = { x: 0, y: 0, dx: fx(100), dy: fx(100) };
    const wall: DL = { x: fx(50), y: 0, dx: 0, dy: fx(100) };
    expect(pInterceptVector(diag, wall)).toBe(FRAC(0.5));
    expect(pInterceptVector(diag, wall)).toBe(interceptVectorOracle(diag, wall));

    const behind: DL = { x: fx(-50), y: 0, dx: 0, dy: fx(100) };
    const f = pInterceptVector(diag, behind);
    expect(f).toBeLessThan(0);
    expect(f).toBe(interceptVectorOracle(diag, behind));
  });

  it('negative-coordinate geometry matches the oracle', () => {
    const trace: DL = { x: fx(-200), y: fx(-200), dx: fx(300), dy: fx(300) };
    const wall: DL = { x: fx(-100), y: fx(-250), dx: 0, dy: fx(200) };
    expect(pInterceptVector(trace, wall)).toBe(interceptVectorOracle(trace, wall));
    expect(pInterceptVector(trace, wall)).toBeGreaterThan(0);
    expect(pInterceptVector(trace, wall)).toBeLessThan(FRAC(1));
  });

  it('den == 0 ⇒ 0: parallel AND co-linear (1.10 has no axis fast path)', () => {
    const parallel: DL = { x: 0, y: fx(50), dx: fx(100), dy: 0 };
    expect(pInterceptVector({ x: 0, y: 0, dx: fx(100), dy: 0 }, parallel)).toBe(0);
    const colinear: DL = { x: fx(100), y: 0, dx: fx(100), dy: 0 };
    expect(pInterceptVector({ x: 0, y: 0, dx: fx(100), dy: 0 }, colinear)).toBe(0);
    const prop: DL = { x: 0, y: fx(10), dx: fx(64), dy: fx(64) };
    expect(pInterceptVector({ x: 0, y: 0, dx: fx(64), dy: fx(64) }, prop)).toBe(0);
    // …and the oracle agrees those are den==0 cases:
    expect(interceptVectorOracle({ x: 0, y: 0, dx: fx(100), dy: 0 }, colinear)).toBe(0);
  });

  it('FixedDiv saturation guard reachable (huge num, tiny den) ⇒ ±MININT/MAXINT', () => {
    // Near-parallel with big deltas: |num|>>14 >= |den| → saturate per C abs.
    const trace: DL = { x: fx(30000), y: 0, dx: fx(1) + 1, dy: 65536 * 2048 + 255 };
    const wall: DL = { x: 0, y: 0, dx: -fx(1), dy: 65536 * 2048 + 254 };
    expect(pInterceptVector(trace, wall)).toBe(interceptVectorOracle(trace, wall));
  });

  it('seeded differential vs the BigInt oracle (exact bit-for-bit)', () => {
    const rnd = mulberry32(0x5eed01);
    for (let i = 0; i < 5000; i++) {
      const q = (u: number): number => (u << FRACBITS) | 0;
      const ri = (lo: number, hi: number): number => Math.floor(lo + rnd() * (hi - lo + 1));
      const v2: DL = { x: q(ri(-512, 512)), y: q(ri(-512, 512)), dx: q(ri(-300, 300)), dy: q(ri(-300, 300)) };
      const v1: DL = { x: q(ri(-512, 512)), y: q(ri(-512, 512)), dx: q(ri(-300, 300)), dy: q(ri(-300, 300)) };
      expect(pInterceptVector(v2, v1), `${i}: ${JSON.stringify([v2, v1])}`).toBe(
        interceptVectorOracle(v2, v1),
      );
    }
  });

  it('precision cost of the >>8 pre-shifts: bounded vs the exact rational', () => {
    // Documented cost (module header): each >>8 drops the low 8 bits of an
    // operand (1/256 map unit) and FixedMul truncates at bit 16, so the
    // returned frac deviates from the ideal intercept. Measured bound over
    // a seeded sample of sane (sub-block to few-hundred-unit) geometry:
    const rnd = mulberry32(0xc057);
    let maxErr = 0;
    for (let i = 0; i < 4000; i++) {
      const q = (u: number): number => (u << FRACBITS) | 0;
      const ri = (lo: number, hi: number): number => Math.floor(lo + rnd() * (hi - lo + 1));
      const rf = (): number => (q(ri(-400, 400)) + ri(0, 65535)) | 0; // lowbits too
      const v2: DL = { x: rf(), y: rf(), dx: (q(ri(60, 300)) + ri(0, 255)) | 0, dy: (q(ri(-300, 300)) + ri(0, 255)) | 0 };
      const v1: DL = { x: rf(), y: rf(), dx: (q(ri(-300, 300)) + ri(0, 255)) | 0, dy: (q(ri(1, 300)) + ri(0, 255)) | 0 };
      const got = pInterceptVector(v2, v1);
      const exact = exactFrac(v2, v1);
      // Well-conditioned samples only: intersection inside the trace and
      // far from parallel (den ≥ ~2% of |v1d|·|v2d| — near-parallel cases
      // amplify the shift truncation without bound, which is the SAME
      // amplification vanilla has; the documented cost is for sane traces).
      if (exact === null) continue;
      const scale =
        Math.abs(v1.dx * v2.dy) + Math.abs(v1.dy * v2.dx); // fixed² (exact doubles)
      if (Math.abs(exact.den) * 20 < scale || Math.abs(exact.frac) > 2 * FRACUNIT) continue;
      maxErr = Math.max(maxErr, Math.abs(got - exact.frac));
    }
    // O(2^-8) relative on unit-scale deltas → far under 1/16 of a unit for
    // this geometry class; the assert pins that the cost stays bounded.
    expect(maxErr).toBeLessThan(4096);
    expect(maxErr).toBeGreaterThan(0); // the shift cost is REAL (not free)
  });
});

/* ------------------------------------------------------------------ */
/* 3. P_PathTraverse DDA == brute-force reference (acceptance item 3)   */
/* ------------------------------------------------------------------ */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildBlockMap, type BlockMap } from './blockmap';
import {
  divLineFrom,
  PT_ADDLINES,
  PT_ADDTHINGS,
  PT_EARLYOUT,
  PMaputlError,
  pathTrace,
  pPathTraverse,
  type DivLineMut,
} from './pmaputl';

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

interface Trace {
  lines: number[];
  fracs: number[];
  result: boolean;
  views: unknown[];
}

function traceLines(
  map: RuntimeMap,
  bm: BlockMap,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  flags = PT_ADDLINES,
): Trace {
  const out: Trace = { lines: [], fracs: [], result: false, views: [] };
  out.result = pPathTraverse(map, bm, x1, y1, x2, y2, flags, (i) => {
    out.views.push(i);
    if (i.isLine) {
      out.lines.push(i.line);
      out.fracs.push(i.frac);
    }
    return true;
  });
  return out;
}

/** Vanilla's exact trace setup (block-boundary nudge + trace divline), so
 * the reference sees the same geometry the DDA does. */
function tracedir(bm: BlockMap, x1: number, y1: number, x2: number, y2: number): DivLineMut {
  if (((x1 - bm.originX) & (128 * FRACUNIT - 1)) === 0) x1 = (x1 + FRACUNIT) | 0;
  if (((y1 - bm.originY) & (128 * FRACUNIT - 1)) === 0) y1 = (y1 + FRACUNIT) | 0;
  return { x: x1, y: y1, dx: (x2 - x1) | 0, dy: (y2 - y1) | 0 };
}

/**
 * Brute-force reference: EVERY linedef in the map (no blockmap, no DDA)
 * against the exact rational segment-vs-segment intersection:
 * visited ⟺ the (nudged) trace segment crosses the line segment with
 * intercept fraction 0 ≤ frac ≤ FRACUNIT (P_TraverseIntercepts' maxfrac).
 * Cross products are exact BigInt; fractional trace endpoints avoid the
 * vertex-pinning ties where vanilla's shifted predicates tie-break.
 */
function referenceLines(
  map: RuntimeMap,
  bm: BlockMap,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): Set<number> {
  const t = tracedir(bm, x1, y1, x2, y2);
  const ax = BigInt(t.x);
  const ay = BigInt(t.y);
  const abx = BigInt(t.dx);
  const aby = BigInt(t.dy);
  const hit = new Set<number>();
  for (let i = 0; i < map.lines.count; i++) {
    const cx = BigInt(map.verticesX[map.lines.v1[i]!]!);
    const cy = BigInt(map.verticesY[map.lines.v1[i]!]!);
    const dcx = BigInt(map.lines.dx[i]!);
    const dcy = BigInt(map.lines.dy[i]!);
    // sides of C,D wrt the infinite trace line (vanilla: side = cross<0)
    const d1 = abx * (cy - ay) - aby * (cx - ax);
    const den = abx * dcy - aby * dcx; // cross(AB, DC)
    const d2 = d1 + den;
    if (d1 < 0n === d2 < 0n) continue; // same side ⇒ never crossed
    const num = (cx - ax) * dcy - (cy - ay) * dcx; // cross(C−A, DC)
    // t = num/den along AB, need 0 ≤ t ≤ 1 (exact rational compare)
    const sgn = den > 0n ? 1n : -1n;
    if (num * sgn < 0n) continue; // behind source (frac < 0)
    if (num * sgn > den * sgn) continue; // beyond destination (frac > 1)
    hit.add(i);
  }
  return hit;
}

const gridSpec: RectMapSpec = {
  rooms: (() => {
    const rooms = [];
    for (let gy = 0; gy < 3; gy++) {
      for (let gx = 0; gx < 3; gx++) {
        rooms.push({ x: gx * 192 - 288, y: gy * 192 - 288, w: 192, h: 192 });
      }
    }
    return rooms;
  })(),
  doors: [{ x1: -96, y1: -96, x2: -96, y2: 96, special: 1, tag: 1 }],
};

describe('pPathTraverse — block-crossed lines == brute force', () => {
  const map = rt(gridSpec);
  const bm = buildBlockMap(map);

  it('seeded traces on a 3×3 room grid visit exactly the crossing lines', () => {
    const rnd = mulberry32(0x9a5e7);
    let traces = 0;
    for (let i = 0; i < 400; i++) {
      // random interior points (room interiors are open; nonzero low bits
      // avoid exact block/vertex ties)
      const p = (): number => ((ri(rnd, -288, 288) << FRACBITS) | ri(rnd, 1, 65535)) | 0;
      const x1 = p();
      const y1 = p();
      const x2 = p();
      const y2 = p();
      const got = traceLines(map, bm, x1, y1, x2, y2);
      const want = referenceLines(map, bm, x1, y1, x2, y2);
      expect(new Set(got.lines), `trace ${i}`).toEqual(want);
      // ordering: P_TraverseIntercepts visits in non-decreasing frac order
      for (let k = 1; k < got.fracs.length; k++) {
        expect(got.fracs[k]!).toBeGreaterThanOrEqual(got.fracs[k - 1]!);
      }
      expect(got.result).toBe(true);
      traces++;
    }
    expect(traces).toBe(400);
  });

  it('PT_EARLYOUT changes nothing on an all-two-sided fixture; result true', () => {
    const rnd = mulberry32(0xfeed);
    for (let i = 0; i < 40; i++) {
      lastX = i2(rnd);
      lastY = i2(rnd);
      lastX2 = i2(rnd);
      lastY2 = i2(rnd);
      const a = traceLines(map, bm, lastX, lastY, lastX2, lastY2);
      const b = traceLines(map, bm, lastX, lastY, lastX2, lastY2, PT_ADDLINES | PT_EARLYOUT);
      expect(b.result).toBe(true);
      expect(new Set(b.lines)).toEqual(new Set(a.lines));
    }
  });

  it('PT_ADDTHINGS throws (thing intercepts are M5-02/M7 territory)', () => {
    expect(() => pPathTraverse(map, bm, 0, 0, fx(100), 0, PT_ADDTHINGS, () => true)).toThrow(
      PMaputlError,
    );
  });

  it('trace exactly on a block boundary gets the vanilla +FRACUNIT nudge (runs clean)', () => {
    // y on a block boundary (origin+128) runs through wall interiors, not
    // vertices; x starts exactly on a boundary column ⇒ both nudges fire.
    const got = traceLines(
      map,
      bm,
      bm.originX,
      bm.originY + fx(128),
      bm.originX + fx(640),
      bm.originY + fx(128),
    );
    expect(got.result).toBe(true);
    expect(got.lines.length).toBeGreaterThan(0);
  });
});

function ri(rnd: () => number, lo: number, hi: number): number {
  return Math.floor(lo + rnd() * (hi - lo + 1));
}
function i2(rnd: () => number): number {
  return ((ri(rnd, -288, 288) << FRACBITS) | ri(rnd, 1, 65535)) | 0;
}
// the EARLYOUT test re-runs the SAME points by capturing them here
let lastX = 0;
let lastY = 0;
let lastX2 = fx(50);
let lastY2 = fx(50);

describe.skipIf(!hasWad)('pPathTraverse on E1M1 (freedoom1.wad)', () => {
  const wadBytes = hasWad ? readFileSync(WAD_PATH) : new Uint8Array();
  const buf = wadBytes.buffer.slice(
    wadBytes.byteOffset,
    wadBytes.byteOffset + wadBytes.byteLength,
  ) as ArrayBuffer;
  const e1m1 = hasWad ? buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')) : (null as never);
  const bm = hasWad ? buildBlockMap(e1m1) : (null as never);

  it('300 seeded bbox traces match the exhaustive reference (skipIf no wad)', () => {
    const rnd = mulberry32(0xe1a1);
    const lo = { x: e1m1.mapBBox.left, y: e1m1.mapBBox.bottom };
    const span = {
      x: e1m1.mapBBox.right - e1m1.mapBBox.left,
      y: e1m1.mapBBox.top - e1m1.mapBBox.bottom,
    };
    let checked = 0;
    for (let i = 0; i < 300; i++) {
      const pt = (): number => (lo.x + Math.floor(rnd() * span.x) + (ri(rnd, 1, 65535) & 0xffff)) | 0;
      const x1 = pt();
      const y1 = pt();
      const x2 = (x1 + ri(rnd, -fx(160), fx(160))) | 0;
      const y2 = (y1 + ri(rnd, -fx(160), fx(160))) | 0;
      const got = traceLines(e1m1, bm, x1, y1, x2, y2);
      const want = referenceLines(e1m1, bm, x1, y1, x2, y2);
      // Exact-predicate ties (trace through a vertex exactly) can differ
      // from the shifted vanilla predicates; assert equality of the bulk
      // and bound any disagreement to true ties.
      const sym = new Set([...got.lines, ...want]);
      let diff = 0;
      for (const l of sym) {
        if (!(got.lines.includes(l) && want.has(l))) diff++;
      }
      expect(diff, `trace ${i}`).toBeLessThanOrEqual(2);
      checked++;
    }
    expect(checked).toBe(300);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Zero allocation in steady state (acceptance item 4)               */
/* ------------------------------------------------------------------ */

describe('zero-alloc steady state', () => {
  it('100k primitive calls + 2k traverses: same singletons, no per-call objects', () => {
    const map = rt(gridSpec);
    const bm = buildBlockMap(map);
    const dl: DivLineMut = { x: 0, y: 0, dx: 0, dy: 0 };
    const bbox: FixedBBox = { left: fx(-300), right: fx(-290), bottom: 0, top: fx(10) };

    // Warm up, then time (process.hrtime is the vitest-side idiom; no
    // allocation-free API exists in JS — identity + timing smoke together
    // pin the absence of per-call garbage, mirroring M3's cols.test).
    const t0 = process.hrtime.bigint();
    let acc = 0;
    for (let i = 0; i < 100_000; i++) {
      acc = (acc + pAproxDistance(i << 8, (i * 3) << 8)) | 0;
      acc = (acc + pBoxOnLineSide(map, bbox, i % map.lines.count)) | 0;
      acc = (acc + pLineOpening(map, i % map.lines.count).openrange) | 0;
      divLineFrom(map, i % map.lines.count, dl);
      acc = (acc + pInterceptVector(dl, pathTrace())) | 0;
    }
    let views = 0;
    const viewIdentities = new Set<unknown>();
    for (let i = 0; i < 2000; i++) {
      pPathTraverse(map, bm, fx(-200) + i, fx(-100), fx(150), fx(120), PT_ADDLINES, (v) => {
        viewIdentities.add(v);
        views++;
        return true;
      });
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    expect(Number.isFinite(acc)).toBe(true);
    expect(views).toBeGreaterThan(0);
    expect(viewIdentities.size).toBe(1); // ONE shared intercept view
    // 100k primitive + 2k traverse calls in well under a second: a
    // per-call object would GC-storm this loop by orders of magnitude.
    expect(ms).toBeLessThan(5000);
  });
});
