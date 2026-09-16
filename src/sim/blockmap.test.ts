/**
 * sim/blockmap tests (M2-05 — BLOCKMAP links + P_BlockLinesIterator).
 *
 * Layer 1: FIXMAP fixtures — every block holds EXACTLY the linedefs whose
 * bbox touches the cell (test-local brute force), the CSR decode matches an
 * independent lazy walk of the raw lump words (vanilla interpretation),
 * vanilla bbox/early-out loop math replays identically, validcount scans
 * visit every line exactly once, and malformed lumps throw typed errors.
 * Seeded property over 5 random room-grid specs (mulberry32).
 * Layer 2: freedoom1.wad E1M1 (skipIf) — grid/origin header pins, union of
 * all blocks == every linedef, pinned total link count + pinned sample
 * blocks. Goldens recorded 2026-07 against the pinned freedoom1.wad.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import type { MapData } from '../wad/types';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData, type RuntimeMap } from './map';
import {
  blockIndexOf,
  blockLinesBoxIterator,
  blockLinesInBox,
  blockLinesIterator,
  buildBlockMap,
  BlockMapError,
  type BlockMap,
} from './blockmap';

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
const BLOCK = 128;

/**
 * Test-local brute force: the blocks linedef `i`'s VERTEX bbox touches,
 * floor((coord − origin)/128) per axis endpoint (the fixture builder's
 * documented rule, R01 §13 — integer-unit coords).
 */
function expectedBlocks(map: RuntimeMap, i: number): [number, number][] {
  const x1 = map.verticesX[map.lines.v1[i]!]! / FX;
  const x2 = map.verticesX[map.lines.v2[i]!]! / FX;
  const y1 = map.verticesY[map.lines.v1[i]!]! / FX;
  const y2 = map.verticesY[map.lines.v2[i]!]! / FX;
  const xl = Math.floor((Math.min(x1, x2) - map.blockmapOriginX / FX) / BLOCK);
  const xh = Math.floor((Math.max(x1, x2) - map.blockmapOriginX / FX) / BLOCK);
  const yl = Math.floor((Math.min(y1, y2) - map.blockmapOriginY / FX) / BLOCK);
  const yh = Math.floor((Math.max(y1, y2) - map.blockmapOriginY / FX) / BLOCK);
  const out: [number, number][] = [];
  for (let bx = xl; bx <= xh; bx++) for (let by = yl; by <= yh; by++) out.push([bx, by]);
  return out;
}

/** Iterate every cell of the grid (vanilla x-outer/y-inner), collect per block. */
function everyBlock(bm: BlockMap, onVisit?: (line: number, bx: number, by: number) => void) {
  const byBlock = new Map<number, Set<number>>(); // blockKey → lines
  for (let bx = 0; bx < bm.width; bx++) {
    for (let by = 0; by < bm.height; by++) {
      const key = by * bm.width + bx;
      const set = new Set<number>();
      blockLinesIterator(bm, bx, by, (l) => {
        set.add(l);
        onVisit?.(l, bx, by);
        return true;
      });
      byBlock.set(key, set);
    }
  }
  return byBlock;
}

/** Assert per-block contents == brute-force bbox membership (all blocks). */
function expectExactMembership(map: RuntimeMap, bm: BlockMap) {
  const got = everyBlock(bm);
  for (let i = 0; i < map.lines.count; i++) {
    const touched = new Set(expectedBlocks(map, i).map(([bx, by]) => by * bm.width + bx));
    for (let b = 0; b < bm.width * bm.height; b++) {
      expect(got.get(b)!.has(i), `line ${i} in block ${b}`).toBe(touched.has(b));
    }
  }
}

/** mulberry32 (seeded PRNG — no Math.random anywhere, A-INT1). */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random non-overlapping rooms on a cell grid + central door gaps eastward. */
function randomRectSpec(rnd: () => number): RectMapSpec {
  const cw = [96, 128, 192][Math.floor(rnd() * 3)]!;
  const n = 2 + Math.floor(rnd() * 3); // 2..4 columns
  const m = 2 + Math.floor(rnd() * 3);
  const present = new Map<string, boolean>();
  for (let gy = 0; gy < m; gy++)
    for (let gx = 0; gx < n; gx++) present.set(`${gx},${gy}`, rnd() < 0.75);
  const live = (gx: number, gy: number): boolean => present.get(`${gx},${gy}`)!;
  const rooms: RectMapSpec['rooms'] = [];
  for (let gy = 0; gy < m; gy++)
    for (let gx = 0; gx < n; gx++)
      if (live(gx, gy))
        rooms.push({
          x: gx * cw,
          y: gy * cw,
          w: cw,
          h: cw,
          lightLevel: 64 + Math.floor(rnd() * 192),
        });
  if (rooms.length < 2) {
    rooms.push({ x: 0, y: 0, w: cw, h: cw });
    rooms.push({ x: cw, y: 0, w: cw, h: cw });
  }
  const doors: RectMapSpec['doors'] = [];
  for (let gy = 0; gy < m; gy++)
    for (let gx = 0; gx + 1 < n; gx++)
      if (live(gx, gy) && live(gx + 1, gy) && rnd() < 0.5)
        doors.push({
          x1: (gx + 1) * cw,
          y1: gy * cw + Math.floor(cw / 4),
          x2: (gx + 1) * cw,
          y2: gy * cw + Math.floor(cw / 2),
          special: 1,
        });
  return { rooms, doors };
}

/* ------------------------------------------------------------------ */
/* Layer 1 — fixture maps                                              */
/* ------------------------------------------------------------------ */

/** Two rooms + an L-ish third, door tagged 5; blockmap origin = min−64. */
const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 200, tag: 5 },
    { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 },
    { x: 0, y: 512, w: 128, h: 128, floorHeight: 64, lightLevel: 255 },
  ],
  doors: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 1, tag: 5 }],
};

const map = rt(SPEC);
const bm = buildBlockMap(map);

describe('buildBlockMap (FIXMAP)', () => {
  it('header matches the RuntimeMap blockmap fields', () => {
    expect(bm.originX).toBe(map.blockmapOriginX);
    expect(bm.originY).toBe(map.blockmapOriginY);
    expect(bm.width).toBe(map.blockmapWidth);
    expect(bm.height).toBe(map.blockmapHeight);
    const minXUnits = Math.min(...Array.from(map.verticesX)) / FX;
    expect(bm.originX).toBe((minXUnits - 64) * FX);
  });

  it('CSR decode == independent lazy walk of the raw lump words', () => {
    // Vanilla P_LoadBlockMap/P_BlockLinesIterator interpretation, re-read
    // straight from the bytes (Int16Array view, word offsets from lump
    // start, lists terminated by -1) — deliberately NOT reusing
    // buildBlockMap's passes.
    const raw = map.blockmap;
    const words = new Int16Array(
      raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
    );
    for (let by = 0; by < bm.height; by++) {
      for (let bx = 0; bx < bm.width; bx++) {
        const off = words[4 + by * bm.width + bx]!;
        const start = bm.blockStart[by * bm.width + bx]!;
        let n = 0;
        for (let w = off; words[w] !== -1; w++) {
          expect(bm.blockLines[start + n]).toBe(words[w]);
          n++;
        }
        expect(bm.blockStart[by * bm.width + bx + 1] - start).toBe(n);
      }
    }
  });

  it('every block holds exactly the lines whose bbox touches the cell', () => {
    expectExactMembership(map, bm);
  });

  it('each line is listed once per touched block (multiplicity)', () => {
    let sum = 0;
    for (let i = 0; i < map.lines.count; i++) sum += expectedBlocks(map, i).length;
    expect(bm.totalLinks).toBe(sum);
  });

  it('iterator over all cells visits every line ≥1× and only correct ones', () => {
    const visits = new Map<number, number>();
    everyBlock(bm, (l) => visits.set(l, (visits.get(l) ?? 0) + 1));
    for (let i = 0; i < map.lines.count; i++) {
      expect(visits.get(i), `line ${i}`).toBe(expectedBlocks(map, i).length);
    }
    expect(visits.size).toBe(map.lines.count);
  });

  it('validcount scan visits every line exactly once per stamp', () => {
    const scan = { valid: map.lines.valid, stamp: 777 };
    const seen: number[] = [];
    blockLinesBoxIterator(
      bm,
      0,
      bm.width - 1,
      0,
      bm.height - 1,
      (l) => (seen.push(l), true),
      scan,
    );
    expect(seen).toHaveLength(map.lines.count);
    expect(new Set(seen).size).toBe(map.lines.count);
    // Same stamp again: everything already stamped → zero visits (vanilla
    // validcount semantics; the query OWNER bumps the stamp).
    const again: number[] = [];
    blockLinesBoxIterator(
      bm,
      0,
      bm.width - 1,
      0,
      bm.height - 1,
      (l) => (again.push(l), true),
      scan,
    );
    expect(again).toHaveLength(0);
    scan.stamp++;
    const third: number[] = [];
    blockLinesBoxIterator(
      bm,
      0,
      bm.width - 1,
      0,
      bm.height - 1,
      (l) => (third.push(l), true),
      scan,
    );
    expect(third).toHaveLength(map.lines.count);
  });

  it('vanilla loop order: x OUTER, y INNER (P_CheckPosition nesting)', () => {
    const manual: number[] = [];
    for (let bx = 0; bx < bm.width; bx++)
      for (let by = 0; by < bm.height; by++)
        blockLinesIterator(bm, bx, by, (l) => (manual.push(l), true));
    const boxed: number[] = [];
    blockLinesBoxIterator(bm, 0, bm.width - 1, 0, bm.height - 1, (l) => (boxed.push(l), true));
    expect(boxed).toEqual(manual);
    expect(boxed.length).toBe(bm.totalLinks);
  });

  it('out-of-grid blocks early-out silently (return true, no visit)', () => {
    for (const [bx, by] of [
      [-1, 0],
      [0, -1],
      [bm.width, 5],
      [7, bm.height],
      [12345, -9999],
    ]) {
      let hits = 0;
      expect(blockLinesIterator(bm, bx, by, () => (hits++, true))).toBe(true);
      expect(hits).toBe(0);
    }
    // Out-of-grid cells inside a bbox range contribute nothing but cost
    // nothing either (vanilla: the loop runs, the iterator early-outs).
    let hits = 0;
    expect(blockLinesBoxIterator(bm, -2, 1, -2, 1, () => (hits++, true))).toBe(true);
    expect(hits).toBeGreaterThan(0);
  });

  it('visit=false stops the scan immediately (early-out ordering)', () => {
    const seen: number[] = [];
    expect(
      blockLinesBoxIterator(bm, 0, bm.width - 1, 0, bm.height - 1, (l) => {
        seen.push(l);
        return seen.length < 3;
      }),
    ).toBe(false);
    expect(seen).toHaveLength(3);
  });

  it('blockLinesInBox replays P_CheckPosition line-loop math', () => {
    // A one-point box at line 0's bbox min corner covers its block and must
    // visit line 0 (its bbox certainly touches that cell).
    const x0 = map.lines.bboxLeft[0]!;
    const y0 = map.lines.bboxBottom[0]!;
    const seen: number[] = [];
    expect(blockLinesInBox(bm, x0, x0, y0, y0, (l) => (seen.push(l), true))).toBe(true);
    expect(seen).toContain(0);
    // (v - bmaporgx) >> MAPBLOCKSHIFT with floor semantics, both signs:
    expect(blockIndexOf(x0 - bm.originX)).toBe(
      Math.floor(x0 / FX / BLOCK - bm.originX / FX / BLOCK),
    );
    expect(blockIndexOf(0)).toBe(0);
    expect(blockIndexOf(-1)).toBe(-1);
    expect(blockIndexOf(-BLOCK * FX - 1)).toBe(-2);
    // A box 20000 units away is off-grid: zero visits, "continue" return.
    const far = 20000 * FX;
    let touched = false;
    expect(blockLinesInBox(bm, far, far, far, far, () => (touched = true, false))).toBe(true);
    expect(touched).toBe(false);
  });

  it('typed errors on malformed raw lumps', () => {
    const patch = (fn: (w: Int16Array) => void): (() => void) => {
      const m2 = { ...map, blockmap: new Uint8Array(map.blockmap) };
      fn(new Int16Array(m2.blockmap.buffer));
      return () => buildBlockMap(m2);
    };
    expect(patch((w) => (w[4] = 2))).toThrow(BlockMapError); // offset into header/table
    expect(patch((w) => (w[4] = 65000))).toThrow(BlockMapError); // offset past lump end

    // Unterminated list: erase EVERY -1 word, then walk block 0's list.
    const m3 = { ...map, blockmap: new Uint8Array(map.blockmap) };
    const w3 = new Int16Array(m3.blockmap.buffer);
    for (let i = 4; i < w3.length; i++) if (w3[i] === -1) w3[i] = 7;
    expect(() => buildBlockMap(m3)).toThrow(/terminator/);

    // Out-of-range linedef index in block 0's list.
    const m4 = { ...map, blockmap: new Uint8Array(map.blockmap) };
    const w4 = new Int16Array(m4.blockmap.buffer);
    const o4 = w4[4]!;
    expect(w4[o4]).not.toBe(-1); // fixture block 0 has ≥1 entry
    w4[o4] = 30000;
    expect(() => buildBlockMap(m4)).toThrow(/outside/);
  });
});

describe('blockmap property (seeded room grids)', () => {
  for (const seed of [11, 222, 3333, 44_444, 555_555]) {
    it(`spec seed ${seed}: exact membership + full-coverage union`, () => {
      const spec = randomRectSpec(mulberry32(seed));
      const m = rt(spec, `FX${seed}`);
      const b = buildBlockMap(m);
      expectExactMembership(m, b);
      const union = new Set<number>();
      everyBlock(b, (l) => void union.add(l));
      expect(union.size).toBe(m.lines.count);
      // With a scan: exactly one visit per line across the whole grid,
      // including off-grid cells at the range edges.
      const scan = { valid: m.lines.valid, stamp: seed | 0 };
      const seen: number[] = [];
      blockLinesBoxIterator(b, -1, b.width, -1, b.height, (l) => (seen.push(l), true), scan);
      expect(seen).toHaveLength(m.lines.count);
      expect(new Set(seen).size).toBe(m.lines.count);
    });
  }
});

/* ------------------------------------------------------------------ */
/* Layer 2 — freedoom1.wad E1M1 (skipIf)                               */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad E1M1 blockmap goldens', () => {
  const e1m1 = (): RuntimeMap => buildMapFromData(wadMap(new Uint8Array(readFileSync(WAD_PATH)), 'E1M1'));

  // Recorded 2026-07 against the pinned freedoom1.wad.
  it('header: 32×27 grid, origin (−712,−1072) (R01 §13)', () => {
    const b = buildBlockMap(e1m1());
    expect(b.width).toBe(32);
    expect(b.height).toBe(27);
    expect(b.originX).toBe(-712 * FX);
    expect(b.originY).toBe(-1072 * FX);
  });

  it('union of all blocks == every linedef; total link count pinned', () => {
    const m = e1m1();
    const b = buildBlockMap(m);
    expect(m.lines.count).toBe(1175);
    expect(b.totalLinks).toBe(2928); // golden: sum of block list lengths
    const union = new Set<number>();
    let visits = 0;
    for (let bx = 0; bx < b.width; bx++)
      for (let by = 0; by < b.height; by++)
        blockLinesIterator(b, bx, by, (l) => (union.add(l), visits++, true));
    expect(union.size).toBe(1175);
    expect(visits).toBe(2928);
    // With a validcount scan, every line is visited exactly once.
    const scan = { valid: m.lines.valid, stamp: 31337 };
    const once: number[] = [];
    blockLinesBoxIterator(b, 0, b.width - 1, 0, b.height - 1, (l) => (once.push(l), true), scan);
    expect(once).toHaveLength(1175);
    expect(new Set(once).size).toBe(1175);
  });

  it('sample blocks pinned', () => {
    const b = buildBlockMap(e1m1());
    const at = (bx: number, by: number): number[] => {
      const out: number[] = [];
      blockLinesIterator(b, bx, by, (l) => (out.push(l), true));
      return out;
    };
    expect(at(0, 0)).toEqual([0]);
    expect(at(16, 13)).toEqual([0, 105]);
  });
});
