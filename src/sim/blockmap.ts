/**
 * sim/blockmap — BLOCKMAP runtime links + P_BlockLinesIterator (M2-05).
 *
 * Vanilla equivalents (linuxdoom-1.10):
 *  - `p_setup.c P_LoadBlockMap` — caches + SHORT-swaps the lump, reads the
 *    i16 header (origin <<FRACBITS, width, height) and clears `blocklinks`.
 *    VERIFIED IN SOURCE: 1.10's `blocklinks` are MOBJ chains ONLY
 *    (p_setup.c:95 "for thing chains"; p_maputl.c P_Link/MoveThinger use
 *    them). The LINEDFS per block are never unrolled at load — every line
 *    query walks the raw blockmap lump words lazily. This module therefore
 *    pre-decodes the raw word lists into per-block linedef-index arrays
 *    ("blockLines"), which is the same data read once, allocation-free at
 *    query time. Deviation documented: contents are bit-identical to the
 *    vanilla lazy walk; nothing observable changes.
 *  - `p_maputl.c P_BlockLinesIterator` — out-of-grid block coords return
 *    "continue" (true) WITHOUT calling the callback; `offset =
 *    *(blockmap + y*bmapwidth+x)` where `blockmap = blockmaplump + 4`, so the
 *    table word at word-index `4 + y*width + x` holds a WORD offset from the
 *    LUMP START; the list at `blockmaplump[offset]` is i16 line indices
 *    terminated by −1 (R01 §13: no padding word before the list section;
 *    empty blocks share one bare [−1] terminator).
 *  - Block index math: callers use `(v - bmaporgx) >> MAPBLOCKSHIFT` with
 *    `MAPBLOCKSHIFT = FRACBITS+7` (p_local.h:40) — NOT an "ADDRSHIFT"
 *    (that name is a later-source/Boom spelling). Our {@link blockIndexOf}
 *    replicates the arithmetic shift as a floor-divide of the exact
 *    difference; see the overflow note there.
 *
 * validcount dedup: vanilla stamps `line->validcount = validcount` inside
 * P_BlockLinesIterator so a line touching several blocks of one query is
 * visited once per query; the query owner bumps the global counter
 * (P_CheckPosition: `validcount++`). We thread that explicitly as
 * {@link BlockScan} over {@link RuntimeMap}.lines.valid (Int32Array, 0 at
 * setup per M2-04). Callers without a scan get raw (no-dedup) iteration —
 * the raw per-block lists never repeat a line within one block (self-check
 * in the fixture builder + R01 §13; vanilla's dedup exists for the bbox
 * loop across blocks).
 *
 * M4 readiness note (line-moving): vanilla 1.10 never moves linedefs
 * between blocks — door/floor thinkers re-check via sector line lists
 * (P_ChangeSector) and blockmap lines are static after load. If a future
 * task needs PrBoom-style P_AddLineToBlockmap/P_UnlinkFromBlockMap, the
 * flat CSR layout below is extendable with per-line block backlinks; that
 * is intentionally NOT built here (YAGNI, plan §M2-05).
 *
 * Determinism: {@link buildBlockMap} allocates once; every iterator is a
 * pure loop over Int32Arrays with zero allocation and no closures per line.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { FRACBITS } from '../core/fixed';
import { MAPBLOCKUNITS } from '../core/constants';
import { blockmapInfo } from '../wad/mapdata';
import type { RuntimeMap } from './map';

// Cell width in fixed point: core/constants spells MAPBLOCKUNITS as
// 128<<FRACBITS (vanilla p_local.h calls THAT MAPBLOCKSIZE; its
// MAPBLOCKUNITS is the bare 128 — watch the naming inversion).

/** MAPBLOCKSHIFT (p_local.h:40) — asserted against the shift of the cell size. */
export const MAPBLOCKSHIFT = FRACBITS + 7;

/**
 * Throw when a BLOCKMAP cannot be decoded faithfully. Vanilla `I_Error`s on
 * malformed headers in W_CacheLumpNum users and would happily walk garbage
 * offsets otherwise; typed errors replace the silent-corruption paths
 * (same policy as MapSetupError in sim/map.ts).
 */
export class BlockMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockMapError';
  }
}

/**
 * Decoded blockmap: header + CSR-style per-block linedef lists.
 * Block (bx,by) with `i = by*width + bx` owns {@link blockLines}
 * `[blockStart[i], blockStart[i+1])`, ascending linedef order (the raw lump
 * order within a list, first list wins for shared lines).
 */
export interface BlockMap {
  /** fixed (i16 origin << FRACBITS, vanilla bmaporgx). */
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  /** CSR bounds, length width*height + 1. */
  readonly blockStart: Int32Array;
  /** Concatenated per-block linedef index lists. */
  readonly blockLines: Int32Array;
  /** Total blockmap lump line references incl. per-list duplicates. */
  readonly totalLinks: number;
}

/**
 * Explicit `validcount` domain (vanilla globals threaded through an object):
 * bump {@link stamp} once per query (vanilla `validcount++`), then every
 * iteration during that query skips lines already stamped this round.
 */
export interface BlockScan {
  /** lines.valid Int32Array from the RuntimeMap (0 at setup). */
  readonly valid: Int32Array;
  stamp: number;
}

/**
 * Decode the raw BLOCKMAP lump of {@link RuntimeMap.blockmap} into per-block
 * linedef lists, replicating the vanilla word interpretation: header words
 * 0..3, offset table from word 4 (word offsets from LUMP START), each list
 * i16 entries terminated by −1. Throws {@link BlockMapError} on truncated
 * lists, offsets pointing into the table, or line indices outside the map.
 */
export function buildBlockMap(map: RuntimeMap): BlockMap {
  const bm = blockmapInfo(map.blockmap, `map ${map.name}: BLOCKMAP`);
  const { originX, originY, width, height, words } = bm;
  const tableStart = 4;
  const cellCount = width * height;
  const blockStart = new Int32Array(cellCount + 1);
  // Pass 1: validate offsets + count list lengths (offset < tableEnd = no
  // list data before it ⇒ vanilla would read table words as list entries;
  // R01 §13: real maps always have offsets >= 4 + w*h; we refuse less).
  const tableEnd = tableStart + cellCount;
  let total = 0;
  for (let i = 0; i < cellCount; i++) {
    blockStart[i] = total;
    const off = words[tableStart + i]!;
    if (off < tableEnd || off >= words.length) {
      throw new BlockMapError(
        `map ${map.name}: BLOCKMAP block ${i} offset ${off} outside the list section [${tableEnd}, ${words.length})`,
      );
    }
    let n = 0;
    for (let w = off; ; w++) {
      const word = w < words.length ? words[w] : undefined;
      if (word === -1) break;
      if (word === undefined) {
        throw new BlockMapError(
          `map ${map.name}: BLOCKMAP block ${i} list at word ${off} runs past the lump without a -1 terminator`,
        );
      }
      n++;
    }
    total += n;
  }
  blockStart[cellCount] = total;
  // Pass 2: fill (single allocation; identical walk order → deterministic).
  const blockLines = new Int32Array(total);
  let at = 0;
  for (let i = 0; i < cellCount; i++) {
    const off = words[tableStart + i]!;
    for (let w = off; words[w] !== -1; w++) {
      const line = words[w]!;
      if (line < 0 || line >= map.lines.count) {
        throw new BlockMapError(
          `map ${map.name}: BLOCKMAP block ${i} references linedef ${line} outside [0, ${map.lines.count})`,
        );
      }
      blockLines[at++] = line;
    }
  }
  return {
    originX: (originX << FRACBITS) | 0,
    originY: (originY << FRACBITS) | 0,
    width,
    height,
    blockStart,
    blockLines,
    totalLinks: total,
  };
}

/**
 * Vanilla `(v - bmaporgx) >> MAPBLOCKSHIFT` (arithmetic shift ⇒ floor). As an
 * exact-double floor-divide, which matches C whenever the subtraction does
 * not overflow C's `long` — inputs are int32 fixed coords and origins, so a
 * difference past ±2^31 (a >32768-unit off-map probe) already wrapped in C
 * UB terms; we deliberately do NOT reproduce a 32-bit wrap here because
 * callers compare against the grid bounds immediately after (out-of-grid ⇒
 * no lines either way for any sane probe distance).
 */
export function blockIndexOf(deltaFixed: number): number {
  return Math.floor(deltaFixed / MAPBLOCKUNITS);
}

/** Block cell containing fixed point (x,y); may be out of grid. */
export function blockIndexOfPoint(bm: BlockMap, x: number, y: number): [number, number] {
  return [blockIndexOf(x - bm.originX), blockIndexOf(y - bm.originY)];
}

function inGrid(bm: BlockMap, bx: number, by: number): boolean {
  return bx >= 0 && by >= 0 && bx < bm.width && by < bm.height;
}

/**
 * `p_maputl.c P_BlockLinesIterator` for ONE block. Visit gets the linedef
 * index; return false from `visit` to stop (returns false). Out-of-grid
 * coords call nothing and return true — vanilla's silent early-out. With a
 * {@link BlockScan}, lines already stamped with the current scan are skipped
 * and each visited line is stamped (vanilla validcount).
 *
 * Allocation-free: no closure created; `visit` is the caller's.
 */
export function blockLinesIterator(
  bm: BlockMap,
  bx: number,
  by: number,
  visit: (line: number) => boolean,
  scan?: BlockScan,
): boolean {
  if (!inGrid(bm, bx, by)) return true; // vanilla bounds early-out
  const i = by * bm.width + bx;
  const end = bm.blockStart[i + 1]!;
  for (let k = bm.blockStart[i]!; k < end; k++) {
    const line = bm.blockLines[k]!;
    if (scan) {
      if (scan.valid[line] === scan.stamp) continue; // already checked
      scan.valid[line] = scan.stamp;
    }
    if (!visit(line)) return false;
  }
  return true;
}

/**
 * Iterate every linedef whose BLOCKMAP listing falls in the block range
 * [xl,xh]×[yl,yh], in vanilla's loop order: x OUTER, y INNER, each block a
 * {@link blockLinesIterator} call (so out-of-grid cells in the range are
 * skipped silently, exactly like P_CheckPosition's `for (bx..) for (by..)`).
 * Returns false iff `visit` stopped early. Pass a {@link BlockScan} for the
 * vanilla one-visit-per-query semantics across overlapping blocks.
 */
export function blockLinesBoxIterator(
  bm: BlockMap,
  xl: number,
  xh: number,
  yl: number,
  yh: number,
  visit: (line: number) => boolean,
  scan?: BlockScan,
): boolean {
  for (let bx = xl; bx <= xh; bx++) {
    for (let by = yl; by <= yh; by++) {
      if (!blockLinesIterator(bm, bx, by, visit, scan)) return false;
    }
  }
  return true;
}

/**
 * P_CheckPosition's linedef-loop math for a fixed-point bbox
 * (left/right/top/bottom, vanilla tmbbox order):
 * `xl = (boxLeft - bmaporgx) >> MAPBLOCKSHIFT` etc. — NO MAXRADIUS margin
 * and NO clamping (the margin+clamp variants belong to the thing loops of
 * M5, p_map.c:155-157/420-423). Feeds {@link blockLinesBoxIterator}.
 */
export function blockLinesInBox(
  bm: BlockMap,
  boxLeft: number,
  boxRight: number,
  boxTop: number,
  boxBottom: number,
  visit: (line: number) => boolean,
  scan?: BlockScan,
): boolean {
  return blockLinesBoxIterator(
    bm,
    blockIndexOf(boxLeft - bm.originX),
    blockIndexOf(boxRight - bm.originX),
    blockIndexOf(boxBottom - bm.originY),
    blockIndexOf(boxTop - bm.originY),
    visit,
    scan,
  );
}

/** All lines listed in the single block containing fixed point (x,y). */
export function blockLinesAtPoint(
  bm: BlockMap,
  x: number,
  y: number,
  visit: (line: number) => boolean,
  scan?: BlockScan,
): boolean {
  const [bx, by] = blockIndexOfPoint(bm, x, y);
  return blockLinesIterator(bm, bx, by, visit, scan);
}
