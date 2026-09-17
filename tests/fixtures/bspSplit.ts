/**
 * M2-01 — Grid BSP splitter for fixture maps (ARCHITECTURE A-04, M2-plan §M2-01).
 *
 * Pure, deterministic geometry: an axis-aligned rectangle partition (the shape
 * every FixtureSpec-derived map has, ARCHITECTURE §6.1) becomes vanilla
 * SEGS/SSECTORS/NODES byte records in the exact R01 §8/§9/§10 layouts, ready
 * for M2-02 to drop into a fixture WAD. NO wad writing happens here.
 *
 * Record layouts pinned by R01 (little-endian):
 *   SEGS  12 B: i16 v1, i16 v2, u16 angle(BAM), i16 linedef, i16 side, i16 offset
 *   SSECT  4 B: i16 numsegs, i16 firstseg           (segs contiguous per ssector)
 *   NODES  28 B: i16 x, y, dx, dy, i16 bbox[2][4] (per child: top, bottom,
 *               left, right — m_bbox.h order, p_setup.c P_LoadNodes),
 *               u16 children[2]
 *               child bit15 (0x8000 = NF_SUBSECTOR) set ⇒ index into SSECTORS.
 *   Child 0 is the FRONT/right side of the partition vector (x,y)→(x+dx,y+dy),
 *   child 1 the BACK/left side (R01 §10). Walker rule used by tests:
 *   cross(d, p − start) < 0 ⇒ p is on the front/right side, else back/left.
 *
 * Algorithm ("grid-recursive splitter", M2-plan §M2-01 / A-04): recursively
 * split rectangular regions. Splitter lines are taken from the INPUT WALL
 * SEGMENTS themselves (never from generic grid lines); the split axis is the
 * region's LONGEST axis first, and the chosen line is the candidate closest to
 * the region midpoint (balance → log2-style depth bound on uniform grids).
 * Regions stay rectangles (all splits axis-aligned) so leaves are trivially
 * convex subsectors. A region with no strictly-interior candidate wall line
 * becomes a subsector.
 *
 * Seg rules (R01 §8 direction rule, verified against E1M1):
 *   - side 0 ⇒ seg runs along the linedef direction (FRONT = right of travel,
 *     normal (dy,−dx) of the unit direction); side 1 ⇒ reversed.
 *   - Two-sided linedefs produce segs on BOTH sides (one per adjacent region);
 *     one-sided linedefs only a front seg in the region their front faces
 *     (minisegs are not emitted — freedoom maps have none, R01 §8; a region
 *     bounded only by the BACK of a one-sided wall gets no seg there).
 *   - One seg per side per region, by construction: each leaf clips every
 *     linedef against its rectangle exactly once (dedup for free).
 *   - Split endpoints get new vertices (R01 §7): this module owns the vertex
 *     table (deduped by coordinate, first-use order) and returns it so M2-02
 *     can emit VERTEXES with matching indices.
 *
 * Ordering is stable/deterministic: recursion visits child0 (front) before
 * child1 (back); subsectors (and their contiguous seg runs) are numbered in
 * that preorder; nodes are numbered postorder, so every child node index is
 * smaller than its parent's. No Math.random, no clock, no I/O.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** SEGS record size in bytes (R01 §8). */
export const SEG_SIZE = 12;
/** SSECTORS record size in bytes (R01 §9). */
export const SSECTOR_SIZE = 4;
/** NODES record size in bytes (R01 §10). */
export const NODE_SIZE = 28;
/** NODES child bit: value & this ⇒ index into SSECTORS (R01 §10, NF_SUBSECTOR). */
export const NF_SUBSECTOR = 0x8000;

/** BAM angles of the four axis directions (R01 §8: 65536 = 360°). */
export const BAM_E = 0;
export const BAM_N = 16384;
export const BAM_W = 32768;
export const BAM_S = 49152;

/** Base class for every typed failure this module throws. */
export class BspSplitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** A zero-length (degenerate) input wall segment. */
export class DegenerateSegmentError extends BspSplitError {
  constructor(readonly linedef: number) {
    super(`degenerate zero-length wall segment for linedef ${linedef}`);
  }
}

/** A non-axis-aligned input wall segment (A-04: fixture maps are grids only). */
export class NonAxisAlignedSegmentError extends BspSplitError {
  constructor(readonly linedef: number) {
    super(`non-axis-aligned wall segment for linedef ${linedef} (grid splitter only)`);
  }
}

/** One input wall segment (a linedef's geometry) in integer map units. */
export interface WallSegment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  /** Index into the future LINEDEFS table (also the stable ordering key). */
  readonly linedef: number;
  /**
   * Bit flags. `SEG_TWOSIDED` ⇒ the linedef has a back sidedef, so segs are
   * produced on BOTH sides of the wall.
   */
  readonly flags: number;
}

/** Flag bit: linedef is two-sided (both front and back sidedefs exist). */
export const SEG_TWOSIDED = 1;

/** Full input for the splitter (what M2-02's rectangle compiler produces). */
export interface GridPartition {
  readonly segments: readonly WallSegment[];
  readonly sectorCount: number;
  /** World bbox [minx, miny, maxx, maxy] — the root region. */
  readonly worldBbox: readonly [number, number, number, number];
}

/** Splitter output: R01 byte records + the vertex table (for M2-02). */
export interface GridNodesResult {
  /** SEGS lump bytes (length divisible by 12). */
  readonly segs: Uint8Array;
  /** SSECTORS lump bytes (length divisible by 4). */
  readonly ssectors: Uint8Array;
  /** NODES lump bytes (length divisible by 28; empty for a single-leaf map). */
  readonly nodes: Uint8Array;
  /** VERTEXES coordinates (index == seg v1/v2 value); split points included. */
  readonly vertices: readonly { readonly x: number; readonly y: number }[];
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface BuiltSeg {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  linedef: number;
  side: 0 | 1;
  offset: number;
}

type Built =
  | { kind: 'leaf'; segs: BuiltSeg[]; bbox: Rect }
  | {
      kind: 'node';
      split: { x: number; y: number; dx: number; dy: number };
      front: Built;
      back: Built;
    };

function isTwoSided(seg: WallSegment): boolean {
  return (seg.flags & SEG_TWOSIDED) !== 0;
}

/**
 * Does the half-plane whose OUTWARD normal is `n` (one of ±x/±y, always
 * perpendicular to the wall line at coordinate `c`) contain interior points
 * of region `r`? `axis` = whether the WALL is vertical ('v', line at x=c) or
 * horizontal ('h', line at y=c).
 */
function sideInRegion(nx: number, ny: number, c: number, r: Rect, axis: 'v' | 'h'): boolean {
  if (axis === 'v') {
    if (nx > 0) return r.x1 > c;
    if (nx < 0) return r.x0 < c;
    return false; // unreachable: vertical walls have ±x normals here
  }
  if (ny > 0) return r.y1 > c;
  if (ny < 0) return r.y0 < c;
  return false;
}

/**
 * Build one seg (ax,ay)→(bx,by) for `side` of linedef segment `seg`, enforcing
 * the R01 §8 direction rule: side 0 travels along the linedef direction,
 * side 1 against it. offset = signed map-unit distance measured ALONG THE
 * LINEDEF direction from linedef v1 to the seg's v1 (R01 §8 wording).
 */
function mkSeg(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  seg: WallSegment,
  side: 0 | 1,
  dx: number,
  dy: number
): BuiltSeg {
  let v1x = ax;
  let v1y = ay;
  let v2x = bx;
  let v2y = by;
  const along = Math.sign(v2x - v1x) * dx + Math.sign(v2y - v1y) * dy;
  if (along !== (side === 0 ? 1 : -1)) {
    v1x = bx;
    v1y = by;
    v2x = ax;
    v2y = ay;
  }
  const offset = (v1x - seg.x1) * dx + (v1y - seg.y1) * dy;
  return { ax: v1x, ay: v1y, bx: v2x, by: v2y, linedef: seg.linedef, side, offset };
}

/**
 * Clip one wall segment against region `r` and produce the seg(s) belonging to
 * the region. A side's seg exists iff the region has interior points on that
 * side of the wall line (strictly interior ⇒ both sides; on a region border ⇒
 * only the inside side). Back segs require SEG_TWOSIDED.
 */
function segsInRegion(seg: WallSegment, r: Rect): BuiltSeg[] {
  const dx = Math.sign(seg.x2 - seg.x1);
  const dy = Math.sign(seg.y2 - seg.y1);
  // FRONT (side 0) faces right of the linedef direction: normal (dy, −dx).
  const n0x = dy;
  const n0y = -dx;

  if (dx !== 0) {
    // horizontal wall at y = seg.y1, running ±x
    const y = seg.y1;
    if (y < r.y0 || y > r.y1) return [];
    const x0 = Math.max(Math.min(seg.x1, seg.x2), r.x0);
    const x1 = Math.min(Math.max(seg.x1, seg.x2), r.x1);
    if (x0 >= x1) return [];
    const out: BuiltSeg[] = [];
    if (sideInRegion(n0x, n0y, y, r, 'h')) out.push(mkSeg(x0, y, x1, y, seg, 0, dx, dy));
    if (isTwoSided(seg) && sideInRegion(-n0x, -n0y, y, r, 'h'))
      out.push(mkSeg(x1, y, x0, y, seg, 1, dx, dy));
    return out;
  }
  // vertical wall at x = seg.x1, running ±y
  const x = seg.x1;
  if (x < r.x0 || x > r.x1) return [];
  const y0 = Math.max(Math.min(seg.y1, seg.y2), r.y0);
  const y1 = Math.min(Math.max(seg.y1, seg.y2), r.y1);
  if (y0 >= y1) return [];
  const out: BuiltSeg[] = [];
  if (sideInRegion(n0x, n0y, x, r, 'v')) out.push(mkSeg(x, y0, x, y1, seg, 0, dx, dy));
  if (isTwoSided(seg) && sideInRegion(-n0x, -n0y, x, r, 'v'))
    out.push(mkSeg(x, y1, x, y0, seg, 1, dx, dy));
  return out;
}

/**
 * Pick the splitter line for region `r` from the INPUT segments: prefer lines
 * perpendicular to the region's longest axis ("longest-axis-first"); among
 * candidates whose wall actually crosses the region interior, the one closest
 * to the region midpoint. null ⇒ no wall crosses the region ⇒ leaf.
 * "Actually crosses" = the wall LINE is strictly inside the region along the
 * split axis AND the wall's extent along the other axis overlaps the region
 * (otherwise the split would be an artifact of an unrelated row's wall).
 */
function findSplit(
  segments: readonly WallSegment[],
  r: Rect
): { vertical: boolean; c: number } | null {
  const scan = (wantVertical: boolean): { vertical: boolean; c: number } | null => {
    const lo = wantVertical ? r.x0 : r.y0;
    const hi = wantVertical ? r.x1 : r.y1;
    if (hi - lo <= 1) return null;
    const mid = (lo + hi) / 2;
    let best: number | null = null;
    let bestDist = Infinity;
    for (const s of segments) {
      const vertical = s.x1 === s.x2;
      if (vertical !== wantVertical) continue;
      const c = wantVertical ? s.x1 : s.y1;
      if (c <= lo || c >= hi) continue; // must strictly split the region
      const overlap = wantVertical
        ? Math.min(Math.max(s.y1, s.y2), r.y1) - Math.max(Math.min(s.y1, s.y2), r.y0)
        : Math.min(Math.max(s.x1, s.x2), r.x1) - Math.max(Math.min(s.x1, s.x2), r.x0);
      if (overlap <= 0) continue; // wall exists but not across THIS region
      const d = Math.abs(c - mid);
      if (d < bestDist) {
        bestDist = d;
        best = c;
      }
    }
    return best === null ? null : { vertical: wantVertical, c: best };
  };
  const verticalFirst = r.x1 - r.x0 >= r.y1 - r.y0;
  return (verticalFirst ? scan(true) : scan(false)) ?? (verticalFirst ? scan(false) : scan(true));
}

function build(segments: readonly WallSegment[], r: Rect): Built {
  const split = findSplit(segments, r);
  if (split === null) {
    const segs: BuiltSeg[] = [];
    for (const s of segments) for (const g of segsInRegion(s, r)) segs.push(g);
    // Leaf bbox = the region rectangle itself: the exact bounds of the
    // subsector REGION (all its segs lie on/in it; node bboxes are the exact
    // union of the children's boxes). Using seg bounds instead would shrink
    // whenever a region edge has no wall on either side (two same-sector
    // cells meet beyond the last split) — vanilla avoids that with minisege,
    // which freedoom-style fixtures never need for the walker.
    return { kind: 'leaf', segs, bbox: { ...r } };
  }
  const { vertical, c } = split;
  // Split vector convention (child 0 = front/right of the vector, R01 §10):
  //   vertical split at x=c ⇒ vector points north (dy>0): front = x > c (east);
  //   horizontal split at y=c ⇒ vector points east (dx>0): front = y < c (south).
  const frontRect: Rect = vertical
    ? { x0: c, y0: r.y0, x1: r.x1, y1: r.y1 }
    : { x0: r.x0, y0: r.y0, x1: r.x1, y1: c };
  const backRect: Rect = vertical
    ? { x0: r.x0, y0: r.y0, x1: c, y1: r.y1 }
    : { x0: r.x0, y0: c, x1: r.x1, y1: r.y1 };
  return {
    kind: 'node',
    split: vertical
      ? { x: c, y: r.y0, dx: 0, dy: r.y1 - r.y0 }
      : { x: r.x0, y: c, dx: r.x1 - r.x0, dy: 0 },
    front: build(segments, frontRect), // visited FIRST ⇒ lower subsector numbers
    back: build(segments, backRect)
  };
}

function angleFor(ax: number, ay: number, bx: number, by: number): number {
  if (bx > ax) return BAM_E;
  if (bx < ax) return BAM_W;
  return by > ay ? BAM_N : BAM_S;
}

function encode(
  tree: Built,
  vertices: { x: number; y: number }[],
  vertexIndex: Map<string, number>
): { segs: Uint8Array; ssectors: Uint8Array; nodes: Uint8Array } {
  const segBytes: number[] = [];
  const ssecBytes: number[] = [];
  const nodeBytes: number[] = [];
  let leafCursor = 0;
  const vertexOf = (x: number, y: number): number => {
    const key = `${x},${y}`;
    let i = vertexIndex.get(key);
    if (i === undefined) {
      i = vertices.length;
      vertices.push({ x, y });
      vertexIndex.set(key, i);
    }
    return i;
  };
  // Postorder emit: children serialized (and numbered) before the parent.
  const visit = (b: Built): { childRef: number; bbox: Rect } => {
    if (b.kind === 'leaf') {
      const subsectorIndex = leafCursor++;
      const firstseg = segBytes.length / SEG_SIZE;
      for (const g of b.segs) {
        const v = new DataView(new ArrayBuffer(SEG_SIZE));
        v.setInt16(0, vertexOf(g.ax, g.ay), true);
        v.setInt16(2, vertexOf(g.bx, g.by), true);
        v.setUint16(4, angleFor(g.ax, g.ay, g.bx, g.by) & 0xffff, true);
        v.setInt16(6, g.linedef, true);
        v.setInt16(8, g.side, true);
        v.setInt16(10, g.offset, true);
        for (let i = 0; i < SEG_SIZE; i++) segBytes.push(v.getUint8(i));
      }
      const s = new DataView(new ArrayBuffer(SSECTOR_SIZE));
      s.setInt16(0, b.segs.length, true);
      s.setInt16(2, firstseg, true);
      for (let i = 0; i < SSECTOR_SIZE; i++) ssecBytes.push(s.getUint8(i));
      return { childRef: NF_SUBSECTOR | subsectorIndex, bbox: b.bbox };
    }
    const f = visit(b.front);
    const k = visit(b.back);
    const bbox = {
      x0: Math.min(f.bbox.x0, k.bbox.x0),
      y0: Math.min(f.bbox.y0, k.bbox.y0),
      x1: Math.max(f.bbox.x1, k.bbox.x1),
      y1: Math.max(f.bbox.y1, k.bbox.y1)
    };
    const v = new DataView(new ArrayBuffer(NODE_SIZE));
    v.setInt16(0, b.split.x, true);
    v.setInt16(2, b.split.y, true);
    v.setInt16(4, b.split.dx, true);
    v.setInt16(6, b.split.dy, true);
    for (const [c, box] of [
      [0, f.bbox],
      [1, k.bbox]
    ] as const) {
      // Vanilla NODES child bbox order = m_bbox.h enum order
      // [BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT] (p_setup.c reads bbox[j][k]
      // in that order; mapdata.ts decodes the same). FIX: was
      // [x0,y0,x1,y1], which decoded as garbage child boxes for the BSP
      // renderer (M3-04 R_CheckBBox).
      const o = 8 + c * 8;
      v.setInt16(o + 0, box.y1, true); // top
      v.setInt16(o + 2, box.y0, true); // bottom
      v.setInt16(o + 4, box.x0, true); // left
      v.setInt16(o + 6, box.x1, true); // right
    }
    v.setUint16(24, f.childRef, true);
    v.setUint16(26, k.childRef, true);
    const nodeIndex = nodeBytes.length / NODE_SIZE;
    for (let i = 0; i < NODE_SIZE; i++) nodeBytes.push(v.getUint8(i));
    return { childRef: nodeIndex, bbox };
  };
  visit(tree);
  return {
    segs: Uint8Array.from(segBytes),
    ssectors: Uint8Array.from(ssecBytes),
    nodes: Uint8Array.from(nodeBytes)
  };
}

/** Validate the partition input, throwing the typed errors above. */
function validate(partition: GridPartition): void {
  const [x0, y0, x1, y1] = partition.worldBbox;
  if (![x0, y0, x1, y1].every(Number.isInteger) || x0 >= x1 || y0 >= y1) {
    throw new BspSplitError('worldBbox must be integer [minx,miny,maxx,maxy] with min<max');
  }
  if (!Number.isInteger(partition.sectorCount) || partition.sectorCount < 1) {
    throw new BspSplitError('sectorCount must be an integer >= 1');
  }
  for (const s of partition.segments) {
    if (!Number.isInteger(s.linedef) || s.linedef < 0) {
      throw new BspSplitError(`linedef index must be a non-negative integer (got ${s.linedef})`);
    }
    const dx = s.x2 - s.x1;
    const dy = s.y2 - s.y1;
    if (dx === 0 && dy === 0) throw new DegenerateSegmentError(s.linedef);
    if (dx !== 0 && dy !== 0) throw new NonAxisAlignedSegmentError(s.linedef);
  }
}

/**
 * Build SEGS/SSECTORS/NODES records for an axis-aligned rectangle partition.
 * Deterministic: identical input ⇒ byte-identical output.
 */
export function buildGridNodes(partition: GridPartition): GridNodesResult {
  validate(partition);
  const [x0, y0, x1, y1] = partition.worldBbox;
  // Stable processing order: ascending linedef index (input order breaks ties).
  const segments = partition.segments
    .map((s, i) => ({ s, i }))
    .sort((a, b) => a.s.linedef - b.s.linedef || a.i - b.i)
    .map(({ s }) => s);
  const tree = build(segments, { x0, y0, x1, y1 });
  const vertices: { x: number; y: number }[] = [];
  const out = encode(tree, vertices, new Map());
  return { ...out, vertices };
}
