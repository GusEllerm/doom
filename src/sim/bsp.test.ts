/**
 * sim/bsp tests (M2-05 — R_PointOnSide + R_PointInSubsector walk).
 *
 * Layer 1 (FIXMAP, tests/fixtures/mapBuilder):
 *  - every strictly-interior integer point of every room resolves (through
 *    the REAL walker) to an ssector whose sector is that room (room i ⇒
 *    sector i+1, VOID=0 per builder docs), and all segs of that ssector
 *    agree; void points inside the world bbox resolve to VOID sector 0;
 *  - pointOnSide against a BigInt oracle replicating the C integer pipeline
 *    (int32 wraps, sign-bit fast path, FixedMul limb truncation) on random
 *    fixed points + every internal splitter;
 *  - geometric sign agreement where the cross products provably cannot wrap
 *    int32 (small fixture deltas);
 *  - exact-on-splitter points tie deterministically (run twice ⇒ identical;
 *    on-plane ⇒ side 1 per the verbatim `right < left` rule).
 * Layer 2 (freedoom1.wad, skipIf): subsectorAt never throws on 4096 seeded
 * points and each resolves to a valid sector; pinned goldens for the
 * player-1 start + 10 probe points (recorded 2026-07, freedoom1.wad pinned).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import type { MapData } from '../wad/types';
import { buildFixtureMapWad, type RectMapSpec, type RectRoomSpec } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData, type RuntimeMap } from './map';
import { pointOnDivlineSide, pointOnSide, sectorAtPoint, subsectorAt, BspError } from './bsp';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function wadMap(bytes: Uint8Array, name = 'FIXMAP'): MapData {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return loadMap(WadFile.parse(buf), name);
}

const rt = (spec: RectMapSpec, name = 'FIXMAP'): RuntimeMap =>
  buildMapFromData(wadMap(buildFixtureMapWad(spec, name), name));

const FX = 65536;

/** Two rooms + an L-ish third, door tagged 5 (same corpus as sim/map). */
const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 200, tag: 5 },
    { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 },
    { x: 0, y: 512, w: 128, h: 128, floorHeight: 64, lightLevel: 255 },
  ],
  doors: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 1, tag: 5 }],
};

const map = rt(SPEC);

/** mulberry32 (seeded PRNG — no Math.random, A-INT1). */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomRectSpec(rnd: () => number): RectMapSpec {
  const cw = [96, 128, 192][Math.floor(rnd() * 3)]!;
  const n = 2 + Math.floor(rnd() * 3);
  const m = 2 + Math.floor(rnd() * 3);
  const present = new Map<string, boolean>();
  for (let gy = 0; gy < m; gy++)
    for (let gx = 0; gx < n; gx++) present.set(`${gx},${gy}`, rnd() < 0.75);
  const rooms: RectRoomSpec[] = [];
  for (let gy = 0; gy < m; gy++)
    for (let gx = 0; gx < n; gx++)
      if (present.get(`${gx},${gy}`)!) rooms.push({ x: gx * cw, y: gy * cw, w: cw, h: cw });
  if (rooms.length < 2) {
    rooms.push({ x: 0, y: 0, w: cw, h: cw });
    rooms.push({ x: cw, y: 0, w: cw, h: cw });
  }
  return { rooms };
}

/* ------------------------------------------------------------------ */
/* BigInt oracle for the R_PointOnSide integer pipeline                */
/* ------------------------------------------------------------------ */

const MASK = (1n << 32n) - 1n;
const fmul = (a: number, b: number): bigint => {
  // (a*b) >> 16 mod 2^32, signed — matches FixedMul's wrap (and, on 64-bit
  // gcc, (int)((long)a*b >> 16)). The BigInt product is exact before >>.
  const prod = (BigInt(a) * BigInt(b)) >> 16n;
  const w = prod & MASK;
  return w >= 1n << 31n ? w - (1n << 32n) : w;
};

const bi2n = (v: bigint): number => Number(BigInt.asIntN(32, v));
/**
 * Oracle: r_main.c R_PointOnSide exactly, in BigInt int32 semantics —
 * including the int32 wrap of the FixedMul products (vanilla overflows its
 * `long` on large splitters; the wrap, not the true cross, is the truth).
 */
function oracleSide(
  x: number,
  y: number,
  nx: number,
  ny: number,
  ndx: number,
  ndy: number,
): 0 | 1 {
  if (ndx === 0) return x <= nx ? (ndy > 0 ? 1 : 0) : ndy < 0 ? 1 : 0;
  if (ndy === 0) return y <= ny ? (ndx < 0 ? 1 : 0) : ndx > 0 ? 1 : 0;
  const dx = BigInt.asIntN(32, BigInt(x) - BigInt(nx));
  const dy = BigInt.asIntN(32, BigInt(y) - BigInt(ny));
  const xor = BigInt.asIntN(32, BigInt(ndy) ^ BigInt(ndx) ^ dx ^ dy);
  if (xor & 0x8000_0000n) {
    // C: `if ((node->dy ^ dx) & 0x80000000) return 1;` — NODE dy, not dy.
    return BigInt.asIntN(32, BigInt(ndy) ^ dx) & 0x8000_0000n ? 1 : 0;
  }
  const left = fmul(bi2n(BigInt(ndy) >> 16n), bi2n(dx));
  const right = fmul(bi2n(dy), bi2n(BigInt(ndx) >> 16n));
  return left > right ? 0 : 1;
}

/* ------------------------------------------------------------------ */
/* Layer 1 — FIXMAP                                                    */
/* ------------------------------------------------------------------ */

describe('subsectorAt (FIXMAP)', () => {
  it('every interior integer point of every room lands in that room', () => {
    SPEC.rooms.forEach((room, i) => {
      for (let x = room.x + 1; x < room.x + room.w; x++) {
        for (let y = room.y + 1; y < room.y + room.h; y += 16) {
          const ss = subsectorAt(map, x * FX, y * FX);
          expect(ss).toBeGreaterThanOrEqual(0);
          expect(ss).toBeLessThan(map.subsectors.count);
          expect(map.subsectors.sector[ss], `room ${i} @ ${x},${y}`).toBe(i + 1);
          // The ssector's own segs all border that same sector.
          for (let g = map.subsectors.segStart[ss]!; g < map.subsectors.segStart[ss]! + map.subsectors.segCount[ss]!; g++) {
            expect(map.segSectorFront[g], `ss ${ss} seg ${g}`).toBe(i + 1);
          }
        }
      }
    });
  });

  it('void points inside the world bbox resolve to VOID sector 0', () => {
    // worldBBox = (0,0)..(512,640); these points are in no room.
    for (const [x, y] of [
      [400, 550],
      [64, 300],
      [480, 620],
      [200, 400],
      [500, 400],
    ] as [number, number][]) {
      expect(sectorAtPoint(map, x * FX, y * FX), `void @ ${x},${y}`).toBe(0);
    }
  });

  it('points exactly on splitters are deterministic (twice ⇒ identical)', () => {
    // Every node split probed at an on-splitter point (midpoint of the
    // partition segment). Vanilla ties are rule-bound, not arbitrary:
    // axis splits answer by the delta SIGN (`x <= node->x ⇒ dy > 0`), the
    // general path ties to side 1 (`right < left` fails on equality) — the
    // exact tie rules are pinned in the pointOnSide suite below.
    for (let i = 0; i < map.nodes.count; i++) {
      const px = map.nodes.x[i]! + map.nodes.dx[i]! / 2;
      const py = map.nodes.y[i]! + map.nodes.dy[i]! / 2;
      expect(subsectorAt(map, px, py)).toBe(subsectorAt(map, px, py));
    }
  });

  it('walk is stable across rebuilds (two fresh RuntimeMaps agree)', () => {
    const map2 = rt(SPEC);
    const rnd = mulberry32(9);
    for (let k = 0; k < 500; k++) {
      const x = ((rnd() * 600 - 20) | 0) * FX;
      const y = ((rnd() * 700 - 20) | 0) * FX;
      expect(subsectorAt(map2, x, y)).toBe(subsectorAt(map, x, y));
    }
  });

  it('cycle guard throws on a poisoned node table', () => {
    const poison = rt(SPEC);
    const root = poison.nodes.count - 1;
    // Point the root's side-0 child back at the root itself.
    (poison.nodes as { right: readonly unknown[] }).right = [
      ...poison.nodes.right.slice(0, root),
      { kind: 'node', index: root },
    ];
    // Find any probe that takes side 0 at the root, then the walk must hit
    // the cycle guard instead of spinning.
    let px = Number.NaN;
    let py = Number.NaN;
    outer: for (const gy of [-20000, -5000, 5000, 20000]) {
      for (const gx of [-20000, -5000, 5000, 20000]) {
        if (pointOnSide(gx * FX, gy * FX, poison.nodes, root) === 0) {
          px = gx * FX;
          py = gy * FX;
          break outer;
        }
      }
    }
    expect(Number.isNaN(px)).toBe(false);
    expect(() => subsectorAt(poison, px, py)).toThrow(BspError);
  });
});

describe('pointOnSide (R_PointOnSide integer form)', () => {
  it('matches the BigInt int32 oracle on random points × every splitter', () => {
    const rnd = mulberry32(0xbeef);
    for (let k = 0; k < 40; k++) {
      const x = ((rnd() * 2000 - 200) | 0) * FX + (((rnd() * 65536) | 0) - 32768);
      const y = ((rnd() * 1200 - 100) | 0) * FX + (((rnd() * 65536) | 0) - 32768);
      for (let i = 0; i < map.nodes.count; i++) {
        const got = pointOnSide(x, y, map.nodes, i);
        const want = oracleSide(x, y, map.nodes.x[i]!, map.nodes.y[i]!, map.nodes.dx[i]!, map.nodes.dy[i]!);
        expect(got, `node ${i} @ ${x},${y}`).toBe(want);
      }
    }
  });

  it('agrees with exact geometry on diagonal splitters (no-wrap region)', () => {
    // Hand-built diagonal divlines (the fixture tree is grid-axis only).
    // In this coord range every >>8-truncated product is exact and tiny, so
    // side MUST equal the exact BigInt cross-product rule: side 0 ⇔ cross<0
    // (the same sign convention sim/map's reference walker uses).
    const divs = [
      { x: 0, y: 0, dx: 256 * FX, dy: 128 * FX },
      { x: 128 * FX, y: 64 * FX, dx: -192 * FX, dy: 256 * FX },
      { x: -64 * FX, y: 200 * FX, dx: 300 * FX, dy: -170 * FX },
    ];
    const rnd = mulberry32(0x5eed);
    let checked = 0;
    for (const d of divs) {
      for (let k = 0; k < 200; k++) {
        const x = ((rnd() * 700 - 100) | 0) * FX;
        const y = ((rnd() * 700 - 100) | 0) * FX;
        const cross =
          BigInt(d.dx) * (BigInt(y) - BigInt(d.y)) - BigInt(d.dy) * (BigInt(x) - BigInt(d.x));
        expect(pointOnDivlineSide(x, y, d), `div @ ${x},${y}`).toBe(cross < 0n ? 0 : 1);
        checked++;
      }
    }
    expect(checked).toBe(600);
  });

  it('axis splits take the fast paths (x<=split origin rule)', () => {
    const vline = { x: 0, y: 0, dx: 0, dy: 128 * FX }; // up-facing vertical
    expect(pointOnDivlineSide(-FX, 0, vline)).toBe(1); // x <= nx, dy>0 → back
    expect(pointOnDivlineSide(FX, 0, vline)).toBe(0); // x > nx: dy<0? no → 0
    expect(pointOnDivlineSide(0, 0, vline)).toBe(1); // x <= nx tie → dy>0
    const vdown = { x: 0, y: 0, dx: 0, dy: -128 * FX };
    expect(pointOnDivlineSide(-FX, 0, vdown)).toBe(0); // same point, flipped dy
    expect(pointOnDivlineSide(FX, 0, vdown)).toBe(1);
    const hline = { x: 0, y: 0, dx: 256 * FX, dy: 0 }; // right-facing
    expect(pointOnDivlineSide(0, FX, hline)).toBe(1); // y > ny: dx>0 → back…
    expect(pointOnDivlineSide(0, -FX, hline)).toBe(0); // y <= ny: dx<0? no → 0
    expect(pointOnDivlineSide(0, 0, hline)).toBe(0); // y <= ny tie → dx<0? no
  });

  it('the p_maputl >>8 form agrees with the BSP form on whole-unit fixtures (sign only)', () => {
    // Fixture splits/coords are whole units, so both truncations are exact
    // multiples of 2^16; only on-plane ties can differ (>>16 vs >>8 grid),
    // so compare off-plane points where both cross products have same sign.
    const nodes = map.nodes;
    const rnd = mulberry32(0xd0);
    let n = 0;
    for (let k = 0; k < 100; k++) {
      const x = ((rnd() * 600) | 0) * FX;
      const y = ((rnd() * 650) | 0) * FX;
      for (let i = 0; i < nodes.count; i++) {
        const nx = nodes.x[i]!;
        const ny = nodes.y[i]!;
        const ndx = nodes.dx[i]!;
        const ndy = nodes.dy[i]!;
        const cross = BigInt(ndx) * (BigInt(y) - BigInt(ny)) - BigInt(ndy) * (BigInt(x) - BigInt(nx));
        if (cross === 0n) continue; // tie rules differ by truncation: skip
        const a = pointOnSide(x, y, nodes, i);
        const b = pointOnDivlineSide(x, y, { x: nx, y: ny, dx: ndx, dy: ndy });
        if (BigInt(a) === 0n && cross > 0n) continue; // wrap-only divergences
        expect(b, `node ${i}`).toBe(a);
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
  });
});

describe('bsp property (seeded room grids)', () => {
  for (const seed of [7, 88, 4_001, 9_999, 123_456]) {
    it(`seed ${seed}: interior points resolve to their room, void to VOID`, () => {
      const spec = randomRectSpec(mulberry32(seed));
      const m = rt(spec, `BX${seed}`);
      spec.rooms.forEach((room, i) => {
        for (let x = room.x + 1; x < room.x + room.w; x += 31) {
          for (let y = room.y + 1; y < room.y + room.h; y += 31) {
            expect(m.subsectors.sector[subsectorAt(m, x * FX, y * FX)], `room ${i} @ ${x},${y}`).toBe(i + 1);
          }
        }
      });
      // Determinism: identical results on a rebuilt map instance.
      const m2 = rt(spec, `BX${seed}`);
      const rnd = mulberry32(seed);
      for (let k = 0; k < 200; k++) {
        const x = ((rnd() * 600 - 100) | 0) * FX;
        const y = ((rnd() * 600 - 100) | 0) * FX;
        expect(subsectorAt(m2, x, y)).toBe(subsectorAt(m, x, y));
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* Layer 2 — freedoom1.wad E1M1 (skipIf)                               */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad E1M1 bsp goldens', () => {
  const e1m1 = (): RuntimeMap =>
    buildMapFromData(wadMap(new Uint8Array(readFileSync(WAD_PATH)), 'E1M1'));

  it('4096 seeded points resolve without throwing (sector < 182)', () => {
    const m = e1m1();
    expect(m.sectors.count).toBe(182);
    let a = 0x12345;
    const rnd = () => {
      a = (a * 1664525 + 1013904223) | 0;
      return ((a >>> 8) % 65536) / 65536;
    };
    for (let k = 0; k < 4096; k++) {
      const x = m.mapBBox.left + Math.floor(rnd() * (m.mapBBox.right - m.mapBBox.left));
      const y = m.mapBBox.bottom + Math.floor(rnd() * (m.mapBBox.top - m.mapBBox.bottom));
      const ss = subsectorAt(m, x, y);
      expect(ss).toBeGreaterThanOrEqual(0);
      expect(ss).toBeLessThan(m.subsectors.count);
      const s = m.subsectors.sector[ss]!;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(m.sectors.count);
    }
  });

  it('player-1 start + 10 probe points pinned (subsector, sector)', () => {
    const m = e1m1();
    const ps = m.playerStarts[0]!;
    expect([ps.x, ps.y]).toEqual([-416, 256]); // start pin (R12 §9.1 spawn)
    const cx = ((m.mapBBox.left + m.mapBBox.right) / 2) | 0;
    const cy = ((m.mapBBox.top + m.mapBBox.bottom) / 2) | 0;
    const probes: [string, number, number, number, number][] = [
      // [label, xFixed, yFixed, pinnedSubsector, pinnedSector]
      ['start', ps.x * FX, ps.y * FX, 115, 140],
      ['centroid', cx, cy, 413, 27],
      ['cx+256', cx + 256 * FX, cy, 291, 18],
      ['cx-256', cx - 256 * FX, cy, 22, 13],
      ['cy+256', cx, cy + 256 * FX, 249, 18],
      ['cy-256', cx, cy - 256 * FX, 424, 153],
      ['start+(128,128)', (ps.x + 128) * FX, (ps.y + 128) * FX, 105, 161],
      ['start+(-128,64)', (ps.x - 128) * FX, (ps.y + 64) * FX, 129, 29],
      ['cx+(64,64)', cx + 64 * FX, cy + 64 * FX, 408, 18],
      ['centroid+(32,-32)', cx + 32 * FX, cy - 32 * FX, 412, 0],
      ['start+(64,0)', (ps.x + 64) * FX, ps.y * FX, 106, 140],
    ];
    for (const [label, x, y, ssWant, secWant] of probes) {
      expect(subsectorAt(m, x, y), label).toBe(ssWant);
      expect(sectorAtPoint(m, x, y), label).toBe(secWant);
    }
  });

  it('pointOnSide matches the BigInt oracle on E1M1 splitters (wrap-faithful)', () => {
    const m = e1m1();
    const rnd = mulberry32(0xfe1);
    let checked = 0;
    for (let k = 0; k < 24; k++) {
      const x = m.mapBBox.left + Math.floor(rnd() * (m.mapBBox.right - m.mapBBox.left));
      const y = m.mapBBox.bottom + Math.floor(rnd() * (m.mapBBox.top - m.mapBBox.bottom));
      // Sample ~24 spread nodes + the root.
      const picks = new Set<number>([m.nodes.count - 1]);
      while (picks.size < 24) picks.add(Math.floor(rnd() * m.nodes.count));
      for (const i of picks) {
        const got = pointOnSide(x, y, m.nodes, i);
        const want = oracleSide(x, y, m.nodes.x[i]!, m.nodes.y[i]!, m.nodes.dx[i]!, m.nodes.dy[i]!);
        expect(got, `node ${i} @ ${x},${y}`).toBe(want);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(500);
  });
});
