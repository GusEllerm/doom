/**
 * M2-01 tests — grid BSP splitter (see bspSplit.ts for conventions).
 *
 * All expectations are pinned to R01 §8/§9/§10 record conventions.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  BAM_E,
  BAM_N,
  BAM_S,
  BAM_W,
  BspSplitError,
  DegenerateSegmentError,
  NF_SUBSECTOR,
  NODE_SIZE,
  NonAxisAlignedSegmentError,
  SEG_SIZE,
  SEG_TWOSIDED,
  SSECTOR_SIZE,
  buildGridNodes,
  type GridPartition,
  type WallSegment
} from './bspSplit';

// ---------------------------------------------------------------------------
// Decoders (byte records are the output contract — tests read them back).
// ---------------------------------------------------------------------------

interface RawSeg {
  v1: number;
  v2: number;
  angle: number;
  linedef: number;
  side: number;
  offset: number;
}
interface RawSsector {
  numsegs: number;
  firstseg: number;
}
interface RawNode {
  x: number;
  y: number;
  dx: number;
  dy: number;
  bbox: [number, number, number, number][]; // [child][minx,miny,maxx,maxy]
  children: [number, number];
}

function decodeSegs(bytes: Uint8Array): RawSeg[] {
  expect(bytes.length % SEG_SIZE).toBe(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: RawSeg[] = [];
  for (let i = 0; i * SEG_SIZE < bytes.length; i++) {
    const o = i * SEG_SIZE;
    out.push({
      v1: view.getInt16(o, true),
      v2: view.getInt16(o + 2, true),
      angle: view.getUint16(o + 4, true),
      linedef: view.getInt16(o + 6, true),
      side: view.getInt16(o + 8, true),
      offset: view.getInt16(o + 10, true)
    });
  }
  return out;
}

function decodeSsectors(bytes: Uint8Array): RawSsector[] {
  expect(bytes.length % SSECTOR_SIZE).toBe(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: RawSsector[] = [];
  for (let i = 0; i * SSECTOR_SIZE < bytes.length; i++) {
    out.push({
      numsegs: view.getInt16(i * SSECTOR_SIZE, true),
      firstseg: view.getInt16(i * SSECTOR_SIZE + 2, true)
    });
  }
  return out;
}

function decodeNodes(bytes: Uint8Array): RawNode[] {
  expect(bytes.length % NODE_SIZE).toBe(0);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: RawNode[] = [];
  for (let i = 0; i * NODE_SIZE < bytes.length; i++) {
    const o = i * NODE_SIZE;
    const bbox: [number, number, number, number][] = [];
    for (let c = 0; c < 2; c++) {
      // disk order per child = [top, bottom, left, right] (m_bbox.h /
      // p_setup.c); tuple order here stays [minx, miny, maxx, maxy].
      bbox.push([
        view.getInt16(o + 12 + c * 8, true), // left
        view.getInt16(o + 10 + c * 8, true), // bottom
        view.getInt16(o + 14 + c * 8, true), // right
        view.getInt16(o + 8 + c * 8, true) // top
      ]);
    }
    out.push({
      x: view.getInt16(o, true),
      y: view.getInt16(o + 2, true),
      dx: view.getInt16(o + 4, true),
      dy: view.getInt16(o + 6, true),
      bbox,
      children: [view.getUint16(o + 24, true), view.getUint16(o + 26, true)]
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// mulberry32 (seeded PRNG — no Math.random anywhere in these tests).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 + a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 + t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Fixture generator: random axis-aligned grid of cells → wall segments.
// Outer walls are one-sided with their FRONT facing the map interior; internal
// walls between different-sector cells are two-sided.
// ---------------------------------------------------------------------------

interface GridCase {
  partition: GridPartition;
  cells: { cx: number; cy: number }[]; // cell centers (for walker sampling)
  cellCount: number;
}

/** CW cell traversal seen from inside means: front = right of direction. */
function gridCase(rnd: () => number, nx: number, ny: number, cs: number, twoSectorCheckerboard = false): GridCase {
  const sectorOf: number[][] = [];
  let maxSector = 0;
  for (let i = 0; i < nx; i++) {
    sectorOf.push([]);
    for (let j = 0; j < ny; j++) {
      const s = twoSectorCheckerboard ? (i + j) % 2 : Math.floor(rnd() * 4);
      sectorOf[i]!.push(s);
      maxSector = Math.max(maxSector, s);
    }
  }
  const segments: WallSegment[] = [];
  let linedef = 0;
  const cells: { cx: number; cy: number }[] = [];
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      cells.push({ cx: (i + 0.5) * cs, cy: (j + 0.5) * cs });
      const x0 = i * cs;
      const y0 = j * cs;
      const x1 = (i + 1) * cs;
      const y1 = (j + 1) * cs;
      // Outer (one-sided) edges, front pointing into the cell.
      if (j === 0) segments.push({ x1, y1: y0, x2: x0, y2: y0, linedef: linedef++, flags: 0 }); // south, runs W
      if (i === nx - 1) segments.push({ x1, y1, x2: x1, y2: y0, linedef: linedef++, flags: 0 }); // east, runs S
      if (j === ny - 1) segments.push({ x1: x0, y1, x2: x1, y2: y1, linedef: linedef++, flags: 0 }); // north, runs E
      if (i === 0) segments.push({ x1: x0, y1: y0, x2: x0, y2: y1, linedef: linedef++, flags: 0 }); // west, runs N
      // Internal two-sided edges (only where the sectors differ).
      if (i + 1 < nx && sectorOf[i]![j] !== sectorOf[i + 1]![j]) {
        segments.push({ x1, y1: y0, x2: x1, y2: y1, linedef: linedef++, flags: SEG_TWOSIDED }); // vertical, runs N
      }
      if (j + 1 < ny && sectorOf[i]![j] !== sectorOf[i]![j + 1]) {
        segments.push({ x1: x0, y1, x2: x1, y2: y1, linedef: linedef++, flags: SEG_TWOSIDED }); // horizontal, runs E
      }
    }
  }
  return {
    partition: {
      segments,
      sectorCount: maxSector + 1,
      worldBbox: [0, 0, nx * cs, ny * cs]
    },
    cells,
    cellCount: nx * ny
  };
}

// ---------------------------------------------------------------------------
// Tree helpers over decoded records.
// ---------------------------------------------------------------------------

interface Tree {
  segs: RawSeg[];
  ssectors: RawSsector[];
  nodes: RawNode[];
  xs: number[];
  ys: number[];
  root: number | null; // node index, or null when the map is one leaf
}

function loadTree(result: ReturnType<typeof buildGridNodes>): Tree {
  const segs = decodeSegs(result.segs);
  const ssectors = decodeSsectors(result.ssectors);
  const nodes = decodeNodes(result.nodes);
  const xs = result.vertices.map((v) => v.x);
  const ys = result.vertices.map((v) => v.y);
  let root: number | null = nodes.length > 0 ? nodes.length - 1 : null;
  if (nodes.length > 0) {
    const referenced = new Set<number>();
    for (const n of nodes)
      for (const c of n.children) if ((c & NF_SUBSECTOR) === 0) referenced.add(c);
    const unreferenced = nodes.map((_, i) => i).filter((i) => !referenced.has(i));
    expect(unreferenced.length, 'exactly one unreferenced root node').toBe(1);
    root = unreferenced[0]!;
  }
  return { segs, ssectors, nodes, xs, ys, root };
}

/** All seg endpoint coordinates contained in a child reference's subtree. */
function subtreePoints(t: Tree, ref: number): { x: number; y: number }[] {
  if ((ref & NF_SUBSECTOR) !== 0) {
    const ss = t.ssectors[ref & 0x7fff]!;
    const pts: { x: number; y: number }[] = [];
    for (let i = ss.firstseg; i < ss.firstseg + ss.numsegs; i++) {
      const s = t.segs[i]!;
      pts.push({ x: t.xs[s.v1]!, y: t.ys[s.v1]! });
      pts.push({ x: t.xs[s.v2]!, y: t.ys[s.v2]! });
    }
    return pts;
  }
  const n = t.nodes[ref]!;
  return [...subtreePoints(t, n.children[0]), ...subtreePoints(t, n.children[1])];
}

/** Recursively verify side property + bbox correctness; returns max depth. */
function checkNode(t: Tree, ni: number, depth: number, maxDepth: { v: number }): void {
  maxDepth.v = Math.max(maxDepth.v, depth);
  const n = t.nodes[ni]!;
  for (let c = 0; c < 2; c++) {
    const pts = subtreePoints(t, n.children[c]!);
    const box = n.bbox[c]!;
    for (const p of pts) {
      // bbox CONTAINMENT: the child's geometry lies inside its box.
      expect(p.x, `node ${ni} child ${c} minx`).toBeGreaterThanOrEqual(box[0]);
      expect(p.y, `node ${ni} child ${c} miny`).toBeGreaterThanOrEqual(box[1]);
      expect(p.x, `node ${ni} child ${c} maxx`).toBeLessThanOrEqual(box[2]);
      expect(p.y, `node ${ni} child ${c} maxy`).toBeLessThanOrEqual(box[3]);
      // SIDE PROPERTY: every point in the child subtree lies on the child's
      // side of the partition vector (cross < 0 ⇒ front/right, > 0 ⇒ back/left,
      // == 0 ⇒ on the line, legal on both sides because split-line segs exist
      // in both children).
      const cross = n.dx * (p.y - n.y) - n.dy * (p.x - n.x);
      if (c === 0) expect(cross, `front side of node ${ni}`).toBeLessThanOrEqual(0);
      else expect(cross, `back side of node ${ni}`).toBeGreaterThanOrEqual(0);
    }
    const ref = n.children[c]!;
    if ((ref & NF_SUBSECTOR) === 0) {
      // Exactness: a node's stored box (in this slot) == union of the child
      // node's own two child boxes (bboxes are exact min/max of children).
      const k = t.nodes[ref]!;
      expect(box).toEqual(unionBox(k.bbox[0]!, k.bbox[1]!));
      checkNode(t, ref, depth + 1, maxDepth);
    }
  }
}

function unionBox(
  a: [number, number, number, number],
  b: [number, number, number, number]
): [number, number, number, number] {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

/** Vanilla-style descent: returns the subsector index containing (px,py). */
function pointInSubsector(t: Tree, px: number, py: number): { ssub: number; bbox: [number, number, number, number] } {
  let ni: number | null = t.root;
  let bbox: [number, number, number, number] = [-32768, -32768, 32767, 32767];
  if (ni === null) return { ssub: 0, bbox };
  for (;;) {
    const n = t.nodes[ni]!;
    const cross = n.dx * (py - n.y) - n.dy * (px - n.x);
    const ref: number = cross < 0 ? n.children[0]! : n.children[1]!;
    bbox = (cross < 0 ? n.bbox[0] : n.bbox[1])!;
    if ((ref & NF_SUBSECTOR) !== 0) return { ssub: ref & 0x7fff, bbox };
    ni = ref;
  }
}

// ===========================================================================
// (a) Single square room — hand-derived from the R01 conventions.
//
// Map: 128×128 square, world bbox (0,0)-(128,128), ONE sector, four one-sided
// boundary linedefs. Direction rule (R01 §8): side-0 segs travel a→b and the
// FRONT is the RIGHT of travel (right = rotate direction clockwise:
// (dx,dy)→(dy,−dx)). To face inward we therefore traverse the square
// CLOCKWISE:
//   ld0 west  wall: (0,0)→(0,128)     dir N ⇒ right = E = interior ✓ angle 16384
//   ld1 north wall: (0,128)→(128,128) dir E ⇒ right = S = interior ✓ angle 0
//   ld2 east  wall: (128,128)→(128,0) dir S ⇒ right = W = interior ✓ angle 49152
//   ld3 south wall: (128,0)→(0,0)     dir W ⇒ right = N = interior ✓ angle 32768
//
// BSP: no wall strictly crosses the root region ⇒ no split at all:
//   NODES     : 0 records (0 bytes)      — leaf count 1, nodes = leaves−1 = 0 ✓
//   SSECTORS  : 1 record: (numsegs=4, firstseg=0)
//   SEGS      : 4 records, one per linedef in linedef order, all side 0,
//               offset 0 (seg v1 == linedef v1, R01 §8 offset definition).
//   VERTEXES  : insertion order from seg emission:
//               0=(0,0) 1=(0,128) 2=(128,128) 3=(128,0)
//               (ld1 reuses v1=(0,128)=1; ld2 reuses (128,128)=2; ld3 reuses
//                (128,0)=3 and (0,0)=0). So segs are
//               (0,1,N),(1,2,E),(2,3,S),(3,0,W) — (v1,v2,angle) per R01 §8.
// ===========================================================================
describe('single square room (hand-derived per R01)', () => {
  const partition: GridPartition = {
    sectorCount: 1,
    worldBbox: [0, 0, 128, 128],
    segments: [
      { x1: 0, y1: 0, x2: 0, y2: 128, linedef: 0, flags: 0 },
      { x1: 0, y1: 128, x2: 128, y2: 128, linedef: 1, flags: 0 },
      { x1: 128, y1: 128, x2: 128, y2: 0, linedef: 2, flags: 0 },
      { x1: 128, y1: 0, x2: 0, y2: 0, linedef: 3, flags: 0 }
    ]
  };

  it('emits exactly the hand-derived records', () => {
    const r = buildGridNodes(partition);
    expect(r.segs.length).toBe(4 * SEG_SIZE);
    expect(r.ssectors.length).toBe(SSECTOR_SIZE);
    expect(r.nodes.length).toBe(0);
    expect(r.vertices).toEqual([
      { x: 0, y: 0 },
      { x: 0, y: 128 },
      { x: 128, y: 128 },
      { x: 128, y: 0 }
    ]);
    expect(decodeSsectors(r.ssectors)).toEqual([{ numsegs: 4, firstseg: 0 }]);
    expect(decodeSegs(r.segs)).toEqual([
      { v1: 0, v2: 1, angle: BAM_N, linedef: 0, side: 0, offset: 0 },
      { v1: 1, v2: 2, angle: BAM_E, linedef: 1, side: 0, offset: 0 },
      { v1: 2, v2: 3, angle: BAM_S, linedef: 2, side: 0, offset: 0 },
      { v1: 3, v2: 0, angle: BAM_W, linedef: 3, side: 0, offset: 0 }
    ]);
  });

  it('is byte-deterministic across runs', () => {
    const a = buildGridNodes(partition);
    const b = buildGridNodes(partition);
    expect([...a.segs]).toEqual([...b.segs]);
    expect([...a.ssectors]).toEqual([...b.ssectors]);
    expect([...a.nodes]).toEqual([...b.nodes]);
  });
});

// ===========================================================================
// (b) 2×2 grid of rooms: four cells of 128, every internal line two-sided.
// Derivation: 4 leaves (one room each) ⇒ 3 nodes (binary-tree identity).
// Root splits vertical at x=128 (square ⇒ longest axis = x, mid = 128);
// each column splits horizontally at y=128. Internal linedefs must show up
// with a side-0 seg on one side and a side-1 seg on the other (both sides).
// ===========================================================================
describe('2x2 grid of rooms', () => {
  // Outer walls per cell would duplicate geometry between cells of the same
  // world border; build the canonical 8 boundary walls + 2 internal runs.
  const segments: WallSegment[] = [
    // boundary, clockwise-inward
    { x1: 0, y1: 0, x2: 0, y2: 256, linedef: 0, flags: 0 }, // west, N
    { x1: 0, y1: 256, x2: 256, y2: 256, linedef: 1, flags: 0 }, // north, E
    { x1: 256, y1: 256, x2: 256, y2: 0, linedef: 2, flags: 0 }, // east, S
    { x1: 256, y1: 0, x2: 0, y2: 0, linedef: 3, flags: 0 }, // south, W
    // internal, two-sided
    { x1: 128, y1: 0, x2: 128, y2: 256, linedef: 4, flags: SEG_TWOSIDED }, // vertical, N
    { x1: 0, y1: 128, x2: 256, y2: 128, linedef: 5, flags: SEG_TWOSIDED } // horizontal, E
  ];
  const partition: GridPartition = { segments, sectorCount: 4, worldBbox: [0, 0, 256, 256] };

  it('produces 4 subsectors and 3 nodes with both-side segs', () => {
    const r = buildGridNodes(partition);
    const t = loadTree(r);
    expect(t.ssectors.length).toBe(4);
    expect(t.nodes.length).toBe(3);
    expect(t.nodes.length).toBe(t.ssectors.length - 1);
    // contiguous seg tiling, 4 segs per room
    let cursor = 0;
    for (const ss of t.ssectors) {
      expect(ss.firstseg).toBe(cursor);
      expect(ss.numsegs).toBe(4);
      cursor += ss.numsegs;
    }
    expect(t.segs.length).toBe(16);
    // every internal linedef appears on BOTH sides
    for (const ld of [4, 5]) {
      const sides = new Set(t.segs.filter((s) => s.linedef === ld).map((s) => s.side));
      expect([...sides].sort()).toEqual([0, 1]);
    }
    // side-1 segs run against the linedef direction (R01 §8): internal
    // vertical runs N as side 0 ⇒ its side-1 segs must carry angle S.
    for (const s of t.segs.filter((s) => s.linedef === 4)) {
      expect(s.angle).toBe(s.side === 0 ? BAM_N : BAM_S);
    }
    checkTreeBasics(t);
    // Exact cell rectangles per child box: root (node 2) splits x=128 with
    // child0=east column, child1=west; each column node splits y=128.
    const [eastRef, westRef] = t.nodes[2]!.children;
    expect(t.nodes[2]!.bbox[0]).toEqual([128, 0, 256, 256]);
    expect(t.nodes[2]!.bbox[1]).toEqual([0, 0, 128, 256]);
    expect(t.nodes[eastRef!]!.bbox[0]).toEqual([128, 0, 256, 128]); // front = south
    expect(t.nodes[eastRef!]!.bbox[1]).toEqual([128, 128, 256, 256]);
    expect(t.nodes[westRef!]!.bbox[0]).toEqual([0, 0, 128, 128]);
    expect(t.nodes[westRef!]!.bbox[1]).toEqual([0, 128, 128, 256]);
  });
});

function checkTreeBasics(t: Tree): void {
  // Every subsector referenced exactly once; angles are axis BAM quadrants.
  const refs: number[] = [];
  for (const n of t.nodes) refs.push(...n.children);
  if (t.root === null) refs.push(NF_SUBSECTOR);
  const leafRefs = refs.filter((c) => (c & NF_SUBSECTOR) !== 0);
  expect(new Set(leafRefs).size).toBe(t.ssectors.length);
  for (const s of t.segs) expect([BAM_E, BAM_N, BAM_W, BAM_S]).toContain(s.angle);
}

// ===========================================================================
// (c) BSP property test over seeded random axis-aligned grids (mulberry32).
// ===========================================================================
describe('BSP property test (seeded random grids)', () => {
  const SEEDS = 64;
  let totalNodes = 0;
  let totalLeaves = 0;
  let totalSamples = 0;

  for (let seed = 1; seed <= SEEDS; seed++) {
    it(`seed ${seed}: side property, bbox exactness, tree identities`, () => {
      const rnd = mulberry32(seed * 7919 + 13);
      const nx = 2 + Math.floor(rnd() * 5); // 2..6 cells
      const ny = 2 + Math.floor(rnd() * 5);
      const cs = [64, 96, 128][Math.floor(rnd() * 3)]!;
      const { partition, cells } = gridCase(rnd, nx, ny, cs);
      const r = buildGridNodes(partition);
      const t = loadTree(r);

      expect(r.segs.length % SEG_SIZE).toBe(0);
      expect(r.ssectors.length % SSECTOR_SIZE).toBe(0);
      expect(r.nodes.length % NODE_SIZE).toBe(0);

      // Binary-tree identities: nodes == leaves − 1 (⇒ leaves ≥ nodes − 1 too).
      expect(t.nodes.length).toBe(t.ssectors.length - 1);
      // Subsector mapping: every subsector is referenced exactly once.
      checkTreeBasics(t);

      if (t.root !== null) checkNode(t, t.root, 0, { v: 0 });

      // Walker sampling: every cell center resolves to a subsector whose bbox
      // contains it (and whose segs are non-empty).
      for (const c of cells) {
        const { ssub, bbox } = pointInSubsector(t, c.cx, c.cy);
        expect(ssub).toBeLessThan(t.ssectors.length);
        expect(t.ssectors[ssub]!.numsegs).toBeGreaterThanOrEqual(0);
        expect(bbox[0]).toBeLessThanOrEqual(c.cx);
        expect(bbox[1]).toBeLessThanOrEqual(c.cy);
        expect(bbox[2]).toBeGreaterThanOrEqual(c.cx);
        expect(bbox[3]).toBeGreaterThanOrEqual(c.cy);
        totalSamples++;
      }
      expect(t.ssectors.length).toBeLessThanOrEqual(cells.length);
      totalNodes += t.nodes.length;
      totalLeaves += t.ssectors.length;
    });
  }

  it('exercised a meaningful corpus', () => {
    // Sanity on the aggregate counters accumulated above (they are read by
    // the report; the assertions here fail loudly if seeds were skipped).
    expect(totalSamples).toBeGreaterThan(200);
    expect(totalNodes).toBe(totalLeaves - SEEDS);
  });

  it('32x32 checkerboard: depth ≤ 2·log2(32)+2 and nodes = subs − 1', () => {
    const { partition } = gridCase(mulberry32(1), 32, 32, 128, true);
    const r = buildGridNodes(partition);
    const t = loadTree(r);
    expect(t.nodes.length).toBe(t.ssectors.length - 1);
    if (t.root !== null) {
      const maxDepth = { v: 0 };
      checkNode(t, t.root, 0, maxDepth);
      // Longest-axis-first, midpoint-balanced splitting halves both extents
      // every two levels: 32 cells ⇒ ≤ 2·log2(32) = 10 levels (+2 slack).
      expect(maxDepth.v).toBeLessThanOrEqual(2 * Math.ceil(Math.log2(32)) + 2);
    }
  });
});

// ===========================================================================
// (d) Edge cases: typed errors.
// ===========================================================================
describe('edge cases', () => {
  it('rejects a zero-length segment with a typed error', () => {
    expect(() =>
      buildGridNodes({
        sectorCount: 1,
        worldBbox: [0, 0, 128, 128],
        segments: [{ x1: 64, y1: 64, x2: 64, y2: 64, linedef: 0, flags: 0 }]
      })
    ).toThrow(DegenerateSegmentError);
    try {
      buildGridNodes({
        sectorCount: 1,
        worldBbox: [0, 0, 128, 128],
        segments: [{ x1: 64, y1: 64, x2: 64, y2: 64, linedef: 7, flags: 0 }]
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BspSplitError);
      expect((e as DegenerateSegmentError).linedef).toBe(7);
    }
  });

  it('rejects a diagonal segment (grid splitter only)', () => {
    expect(() =>
      buildGridNodes({
        sectorCount: 1,
        worldBbox: [0, 0, 128, 128],
        segments: [{ x1: 0, y1: 0, x2: 128, y2: 128, linedef: 0, flags: 0 }]
      })
    ).toThrow(NonAxisAlignedSegmentError);
  });

  it('rejects an empty world bbox and non-positive sectorCount', () => {
    expect(() =>
      buildGridNodes({ sectorCount: 1, worldBbox: [0, 0, 0, 128], segments: [] })
    ).toThrow(BspSplitError);
    expect(() =>
      buildGridNodes({ sectorCount: 0, worldBbox: [0, 0, 128, 128], segments: [] })
    ).toThrow(BspSplitError);
  });
});
