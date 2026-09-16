/**
 * Patch (column/post) decoder — M1-04.
 *
 * Byte layout (r_defs.h patch_t): u16LE width, u16LE height, u16LE leftoffset,
 * u16LE topoffset, then u32LE columnofs[width] measured from the lump start.
 *
 * Post layout — validated against the released linuxdoom-1.10 reader code,
 * which is the reference implementation (r_things.c:359-384
 * `R_DrawMaskedColumn`, r_data.c:198-217 `R_DrawColumnInCache`):
 *
 *   [0] topdelta   row of the post's top, measured from the TOP OF THE COLUMN
 *                  (the released loops compute `sprtopscreen + spryscale *
 *                  column->topdelta` / `originy + patch->topdelta` — the
 *                  topdelta is NOT accumulated across posts). 0xFF terminates
 *                  the column (byte -1). R02's "rows below previous post top"
 *                  phrasing and "posts are byte-packed" are corrected here
 *                  against the code and the freedoom1.wad corpus (below).
 *   [1] length     pixel count (0..255).
 *   [2] slack      one unused byte (r_data.c/r_things.c read pixels from +3).
 *   [3..] pixels   `length` palette bytes.
 *   trailing slack  next post starts at `post + length + 4` (the `+3`/`+4`
 *                  pointer arithmetic of the released code). A 4-byte-aligned
 *                  `length + 4` record is why the specs call this "4-byte
 *                  alignment"; R02 §5's "byte-packed, no padding" is wrong for
 *                  real lumps — corpus check on freedoom1.wad (2256 patch-like
 *                  lumps, 166910 columns): with stride +4 the 0xFF terminator
 *                  is found in 100% of columns and no post runs past the lump;
 *                  with byte-packed stride +2 only 34% terminate. Under the
 *                  absolute-topdelta reading no post ever exceeds the patch
 *                  height; with accumulated deltas 34383 posts overshoot and
 *                  all 31003 multi-post columns would be non-monotonic.
 *
 * 0xFF is the terminator, not 0x80 (R02 §5 preamble). 0x80 is an ordinary
 * topdelta (row 128).
 *
 * Representation (contract M1-01 / ARCHITECTURE §4.3, gap G1): each column is
 * a `Uint8Array(height)`, zero-filled first (0 = transparent), then each post
 * writes its bytes at rows top..top+length-1, top→bottom. Posts clipping past
 * the bottom are clipped like vanilla (`count = cacheheight - position`,
 * r_data.c:205-207), never rejected. Structural malformation (bad header,
 * out-of-bounds columnofs, post data past the lump end, missing terminator,
 * zero-progress post) throws a typed PatchDecodeError; the decoder never
 * reads out of bounds.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { DecodedPatch } from './types';

/* ------------------------------------------------------------------ */
/* Typed errors                                                        */
/* ------------------------------------------------------------------ */

/** Base class for every malformed-patch condition thrown by {@link decodePatch}. */
export class PatchDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Header missing, truncated, or holding impossible field values. */
export class PatchHeaderError extends PatchDecodeError {}

/** A `columnofs` entry points outside the post area of the lump. */
export class PatchColumnOffsetError extends PatchDecodeError {}

/** Post stream malformed: data overrun past the lump, missing 0xFF terminator,
 * zero-progress post (topdelta=0, length=0). Never raised for bottom clipping. */
export class PatchPostError extends PatchDecodeError {}

/* ------------------------------------------------------------------ */
/* Constants (r_things.c / r_data.c column walk)                       */
/* ------------------------------------------------------------------ */

/** Column terminator byte: topdelta == 0xFF (r_defs.h:287). NOT 0x80. */
export const POST_TERMINATOR = 0xff;

/** Bytes from a post start to its pixel data (2-byte header + 1 slack). */
export const POST_DATA_OFFSET = 3;

/** Bytes from a post start to the next post: `length + 4`. */
export const POST_STRIDE_EXTRA = 4;

const HEADER_BYTES = 8;

/* ------------------------------------------------------------------ */
/* decodePatch                                                         */
/* ------------------------------------------------------------------ */

/**
 * Decode a patch-format lump (wall patch, sprite, interface graphic) into the
 * typed {@link DecodedPatch} contract: `columns[c][r]` is the palette index at
 * column `c`, row `r` (0 = transparent), rows contiguous top→bottom.
 *
 * Zero-width patches decode to `columns: []`; zero-height patches to `width`
 * empty columns (post streams still walked, nothing writable).
 *
 * Throws a {@link PatchDecodeError} subclass on malformed input; never reads
 * outside `bytes`.
 */
export function decodePatch(bytes: Uint8Array): DecodedPatch {
  const len = bytes.length;
  if (len < HEADER_BYTES) {
    throw new PatchHeaderError(`patch header truncated: ${len} bytes < ${HEADER_BYTES}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getInt16(0, true);
  const height = view.getInt16(2, true);
  const leftOffset = view.getInt16(4, true);
  const topOffset = view.getInt16(6, true);
  if (width < 0 || height < 0) {
    throw new PatchHeaderError(`patch header impossible dimensions: width=${width} height=${height}`);
  }
  if (len < HEADER_BYTES + width * 4) {
    throw new PatchHeaderError(
      `columnofs table truncated: ${len} bytes < ${HEADER_BYTES + width * 4} (width=${width})`,
    );
  }

  const columns: Uint8Array[] = [];
  for (let c = 0; c < width; c += 1) {
    const column = new Uint8Array(height); // zero-fill: 0 = transparent (G1)
    const ofs = view.getUint32(HEADER_BYTES + c * 4, true);
    if (ofs < HEADER_BYTES || ofs >= len) {
      throw new PatchColumnOffsetError(
        `column ${c} offset ${ofs} out of bounds (lump length ${len})`,
      );
    }
    readColumn(bytes, ofs, column, c);
    columns.push(column);
  }

  return { width, height, leftOffset, topOffset, columns };
}

/** Follow one column's post stream into `column` (vanilla walk, see file header). */
function readColumn(bytes: Uint8Array, start: number, column: Uint8Array, columnIndex: number): void {
  const height = column.length;
  const len = bytes.length;
  let p = start;
  for (;;) {
    if (p >= len) {
      throw new PatchPostError(
        `column ${columnIndex}: lump ended before 0xFF terminator (offset ${p}, length ${len})`,
      );
    }
    const top = bytes[p] as number;
    if (top === POST_TERMINATOR) break;
    if (p + 1 >= len) {
      throw new PatchPostError(`column ${columnIndex}: post header truncated at offset ${p}`);
    }
    const length = bytes[p + 1] as number;
    if (top === 0 && length === 0) {
      throw new PatchPostError(`column ${columnIndex}: zero post (topdelta=0, length=0) at offset ${p}`);
    }
    const dataStart = p + POST_DATA_OFFSET;
    if (dataStart + length > len) {
      throw new PatchPostError(
        `column ${columnIndex}: post at ${p} reads ${length} bytes past lump end (${len})`,
      );
    }
    const writable = Math.min(length, Math.max(0, height - top)); // vanilla clip, never error
    if (writable > 0) {
      column.set(bytes.subarray(dataStart, dataStart + writable), top);
    }
    p += length + POST_STRIDE_EXTRA;
  }
}

/* ------------------------------------------------------------------ */
/* buildPatchFromColumns (PURE encoder)                                */
/* ------------------------------------------------------------------ */

/**
 * PURE builder: encode column strips into canonical patch-format bytes that
 * {@link decodePatch} reads back exactly (transparent = 0). Needed by this
 * module's round-trip tests AND the M1-05 fixture-WAD builder — keep it pure
 * and side-effect free; input arrays are never mutated.
 *
 * Emitted posts use the real-lump layout the decoder implements:
 * `topdelta | length | slack 0 | pixels[length] | slack 0`, next post at
 * `+length+4`, column ended with `0xFF 0x00`.
 *
 * Encoding rules:
 * - each maximal run of non-zero pixels becomes one post, except that posts
 *   cannot start at/after row 254 (absolute topdelta &lt; 0xFF) or span more
 *   than 255 rows, so long/deep runs chain into 2..3 posts; a post then also
 *   (re)writes the transparent rows under its top — writing 0 leaves pixels
 *   transparent, so the round-trip stays exact;
 * - pixels past row 508 (topdelta 254 + length 255) are not encodable in the
 *   format at all (vanilla included); an input column with non-zero pixels
 *   there throws;
 * - an all-zero column encodes to just the terminator.
 *
 * Because real formats cannot place a single-post top below row 254 either,
 * opaque pixels in rows ≥ 254 of a tall column are (like vanilla) expressed
 * via these pivot chains; a column meant to be fully opaque in every row
 * simply uses non-zero pixels everywhere. Pixel value 0 means transparent, so
 * tests/fixtures should use 1..255 for visible pixels.
 *
 * `columns` must be rectangular; `[]` encodes a legal 0×0 patch. Vanilla
 * sprite convention (R02 §5/§8) is `leftOffset = width >> 1`,
 * `topOffset = height`; wall patches typically 0 — callers choose.
 */
export function buildPatchFromColumns(
  columns: readonly (readonly number[])[] | readonly Uint8Array[],
  leftOffset = 0,
  topOffset = 0,
): Uint8Array {
  const width = columns.length;
  const height = width === 0 ? 0 : columns[0]!.length;
  for (const col of columns) {
    if (col.length !== height) {
      throw new Error(`buildPatchFromColumns: ragged columns (${col.length} !== ${height})`);
    }
  }
  if (width > 0xffff || height > 0xffff) {
    throw new Error(`buildPatchFromColumns: dimensions ${width}x${height} exceed int16 range`);
  }

  const base = HEADER_BYTES + width * 4;
  const data: number[] = [];
  const offsets: number[] = [];
  for (const col of columns) {
    offsets.push(base + data.length);
    encodeColumn(col, data);
  }

  const out = new Uint8Array(base + data.length);
  const view = new DataView(out.buffer);
  view.setInt16(0, width, true);
  view.setInt16(2, height, true);
  view.setInt16(4, leftOffset, true);
  view.setInt16(6, topOffset, true);
  for (let c = 0; c < width; c += 1) {
    view.setUint32(HEADER_BYTES + c * 4, offsets[c] as number, true);
  }
  out.set(data, base);
  return out;
}

/** Append one column's post bytes to `out` (used by buildPatchFromColumns). */
function encodeColumn(col: ArrayLike<number>, out: number[]): void {
  const MAX_TOP = 254; // absolute topdelta must stay below the 0xFF terminator
  const MAX_LEN = 255; // length byte
  const height = col.length;
  let r = 0;
  while (r < height) {
    if (col[r] === 0) {
      r += 1;
      continue;
    }
    let end = r;
    while (end < height && col[end] !== 0) end += 1;
    if (end > MAX_TOP + MAX_LEN) {
      throw new Error(
        `buildPatchFromColumns: run reaching row ${end - 1} exceeds the encodable maximum (row ${MAX_TOP + MAX_LEN - 1}: topdelta <= 254, length <= 255)`,
      );
    }
    let pos = r;
    while (pos < end) {
      const top = Math.min(pos, MAX_TOP);
      const length = Math.min(end, top + MAX_LEN) - top; // >= 1, <= 255
      out.push(top, length, 0); // leading slack: pixels start at +3 (vanilla read)
      for (let i = 0; i < length; i += 1) out.push(col[top + i] as number);
      out.push(0); // trailing slack
      pos = top + length;
    }
    r = end;
  }
  out.push(POST_TERMINATOR, 0);
}
