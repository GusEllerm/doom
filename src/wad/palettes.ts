/**
 * PLAYPAL / COLORMAP decoders (M1-03).
 *
 * Facts pinned from R02 §2-3 (docs/research/02-graphics-data.md):
 * - PLAYPAL = 14 palettes x 768 bytes = 14 x 256 RGB triples, values 0-255
 *   (DOOM is NOT the 0-254 HEXEN scheme; there is no gamma in the file —
 *   gamma lives in the video layer). Only the 14-palette layout is accepted;
 *   anything else (e.g. the 4-palette HEXEN variant) is a typed error.
 * - Palette row usage: 0 = normal, 1..8 = red pain (damage/berserk),
 *   9..12 = gold bonus pickup, 13 = radiation-suit green. There is no
 *   quad-damage palette in Doom 1; invulnerability uses COLORMAP row 32.
 * - COLORMAP = 34 rows x 256 bytes = 8704 (rows 0..31 light levels,
 *   row 32 = invulnerability inverse map, row 33 unreferenced by 1.10).
 *
 * Indexed color stays INDEXED at this layer: pixels in the framebuffer are
 * palette indices; RGBA conversion happens only here (palette rows) and in
 * the M3+ blit LUT.
 *
 * RGBA packing convention (ARCHITECTURE §2 / M1-plan §M1-03 acceptance 3):
 * entries are `0xAARRGGBB` held in a little-endian `Uint32Array`. Stored
 * little-endian this is byte order [R, G, B, A] in memory, i.e. it matches
 * `ImageData`/`Uint8ClampedArray` RGBA layout byte-for-byte, so the blit can
 * `new Uint8ClampedArray(u32.buffer)` with no per-pixel packing. Alpha is
 * always 0xFF (palette data has no alpha channel).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { Palettes } from './types';

/* ------------------------------------------------------------------ */
/* Constants (R02 §2-3)                                                */
/* ------------------------------------------------------------------ */

export const NUM_PALETTES = 14;
export const PALETTE_SIZE = 256;
/** 14 * 256 * 3 = 10752 bytes. */
export const PLAYPAL_BYTES = NUM_PALETTES * PALETTE_SIZE * 3;
/** 32 light rows + row 32 inverse + row 33 (unreferenced in Doom 1). */
export const NUM_COLORMAP_ROWS = 34;
/** 34 * 256 = 8704 bytes. */
export const COLORMAP_BYTES = NUM_COLORMAP_ROWS * PALETTE_SIZE;

/** Palette row indices (st_stuff.c ST_doPaletteStuff, R02 §2). */
export const PAL_NORMAL = 0;
export const START_RED_PALS = 1;
export const NUM_RED_PALS = 8;
export const START_BONUS_PALS = 9;
export const NUM_BONUS_PALS = 4;
export const RADIATION_PAL = 13;

/* ------------------------------------------------------------------ */
/* Typed error                                                         */
/* ------------------------------------------------------------------ */

/** Thrown for malformed PLAYPAL/COLORMAP data (size or index errors). */
export class PaletteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaletteError';
  }
}

/* ------------------------------------------------------------------ */
/* Decoders                                                            */
/* ------------------------------------------------------------------ */

/**
 * Pack 0xAARRGGBB (little-endian Uint32 ⇒ in-memory [R,G,B,A], matching
 * ImageData; see file header).
 */
export function paletteToRgba(r: number, g: number, b: number): number {
  return ((0xff << 24) | (r << 16) | (g << 8) | b) >>> 0;
}

/**
 * Decode a PLAYPAL lump into 14*256 packed RGBA entries.
 * `base[palette * 256 + color]`; palette 0 = normal (R02 §2).
 * Throws {@link PaletteError} unless the lump is exactly 14*768 bytes
 * (the 3/4-palette HEXEN layout is NOT supported).
 */
export function decodePlaypal(bytes: Uint8Array): Uint32Array {
  if (bytes.byteLength !== PLAYPAL_BYTES) {
    throw new PaletteError(
      `PLAYPAL must be exactly ${PLAYPAL_BYTES} bytes (14x768), got ${bytes.byteLength}`,
    );
  }
  // DataView gives bounds-checked, undefined-free reads over any view.
  const src = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = new Uint32Array(NUM_PALETTES * PALETTE_SIZE);
  for (let i = 0; i < base.length; i++) {
    const o = i * 3;
    base[i] = paletteToRgba(src.getUint8(o), src.getUint8(o + 1), src.getUint8(o + 2));
  }
  return base;
}

/**
 * Decode a COLORMAP lump: a defensive copy of the 34*256 index-translation
 * rows. `colormapRows[row * 256 + color]` → palette index. Rows 0..31 are
 * light levels (0 = full bright), row 32 is the invulnerability inverse map
 * (R02 §3). Throws {@link PaletteError} unless exactly 34*256 bytes.
 */
export function decodeColormap(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== COLORMAP_BYTES) {
    throw new PaletteError(
      `COLORMAP must be exactly ${COLORMAP_BYTES} bytes (34x256), got ${bytes.byteLength}`,
    );
  }
  return bytes.slice();
}

/** Decode both lumps into the shared {@link Palettes} contract (M1-01). */
export function decodePalettes(playpal: Uint8Array, colormap: Uint8Array): Palettes {
  return { base: decodePlaypal(playpal), colormapRows: decodeColormap(colormap) };
}

/**
 * Read one packed RGBA entry from a decoded palette (M1-plan §M1-03).
 * `index` spans all rows: `palette * 256 + color`. Throws
 * {@link PaletteError} for out-of-range/non-integer indices.
 */
export function rgbaAt(base: Uint32Array, index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= base.length) {
    throw new PaletteError(`palette index out of range: ${index} (0..${base.length - 1})`);
  }
  const value = base[index];
  if (value === undefined) {
    // Defensive: unreachable after the range check above.
    throw new PaletteError(`palette index unreadable: ${index}`);
  }
  return value;
}
