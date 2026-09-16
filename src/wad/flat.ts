/**
 * Flat (64x64 raw pixel) decoder — M1-06.
 *
 * Facts pinned (R02 §6, R01 §14, M1-plan §M1-06 "first byte top-left"): a
 * flat is exactly 4096 raw palette-index bytes — 64 rows of 64, row-major,
 * first byte top-left, no header and no compression. Vanilla caches them by
 * directory position between F_START/F_END (r_data.c:579-594); name lookup
 * is global last-match (R02 §1 `R_FlatNumForName`), which is the WadFile
 * rule — this decoder just validates + wraps the bytes.
 *
 * Storage order note: the bytes are passed through RAW (identity, a copy),
 * so `pixels[r*64+c]` is row r, column c. types.ts draws DecodedFlat under
 * a stale "column-major" interface comment; that contradicts the pinned
 * fact (M1-plan §M1-01/M1-06: "raw 4096 B, first byte top-left") and the
 * flat-sampler vanilla itself uses (`flat[(y<<6)+x]`, r_plane.c), so raw
 * row-major wins and the contract comment is flagged as a doc bug.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { DecodedFlat } from './types';

/* ------------------------------------------------------------------ */
/* Constants + typed error                                             */
/* ------------------------------------------------------------------ */

/** 64*64 palette indices, row-major (R02 §6). */
export const FLAT_BYTES = 4096;

/** Flat width/height in pixels. */
export const FLAT_SIZE = 64;

/** Thrown when the bytes are not a complete 4096-byte flat. */
export class FlatDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/* ------------------------------------------------------------------ */
/* decodeFlat                                                          */
/* ------------------------------------------------------------------ */

/**
 * Decode a flat lump's bytes into the {@link DecodedFlat} contract. The
 * pixel array is a copy of `bytes` (never aliases the caller's buffer, so
 * a zero-copy WadFile subarray cannot be mutated through it).
 *
 * Throws {@link FlatDecodeError} unless the input is exactly 4096 bytes
 * (R02 §6: every flat lump in freedoom1.wad has size 4096).
 */
export function decodeFlat(bytes: Uint8Array, name: string): DecodedFlat {
  if (bytes.length !== FLAT_BYTES) {
    throw new FlatDecodeError(
      `flat '${name}': expected ${FLAT_BYTES} bytes, got ${bytes.length}`,
    );
  }
  return { name, pixels: new Uint8Array(bytes) };
}
