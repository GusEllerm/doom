/**
 * Flat (64x64 raw pixel) decoder — M1-06.
 *
 * Facts pinned (R02 §6, R01 §14): a flat is exactly 4096 raw palette-index
 * bytes, row-major, first byte top-left; no header, no compression.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { DecodedFlat } from './types';

/** Thrown for malformed flat data (wrong size). */
export class FlatDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Decode one 4096-byte flat lump. Unimplemented (M1-06 WIP). */
export function decodeFlat(_bytes: Uint8Array, _name: string): DecodedFlat {
  throw new Error('unimplemented');
}
