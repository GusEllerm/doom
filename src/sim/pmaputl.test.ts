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

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import {
  buildMapFromData,
  ST_VERTICAL,
  type FixedBBox,
  type LineArrays,
  type RuntimeMap,
} from './map';
import {
  pAproxDistance,
  pBoxOnLineSide,
  pPointOnLineSide,
  type LineMapView,
} from './pmaputl';

const FU = FRACUNIT;
const fx = (units: number): number => (units * FU) | 0;

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
    const bytes = buildFixtureMapWad(spec, 'FIXMAP');
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const map: RuntimeMap = buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
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
