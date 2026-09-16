/**
 * sim/blockmap — BLOCKMAP runtime links + P_BlockLinesIterator (M2-05).
 * STUB — implementation lands in the next commit.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { RuntimeMap } from './map';

/** Decoded blockmap: header + per-block linedef-index lists. */
export interface BlockMap {
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
}

/** Decode the raw BLOCKMAP lump of a RuntimeMap into per-block lists. */
export function buildBlockMap(_map: RuntimeMap): BlockMap {
  throw new Error('not implemented');
}
