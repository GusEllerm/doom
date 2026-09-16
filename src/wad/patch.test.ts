/**
 * Tests for the patch (column/post) decoder — M1-04.
 *
 * Handcrafted vectors are built with the PURE {@link buildPatchFromColumns}
 * helper (shared with the M1-05 fixture builder) or raw byte arrays for the
 * malformed cases. Golden section samples three real freedoom1.wad patches
 * (one wall patch from PNAMES, two sprites) and is skipped when the WAD is
 * absent (npm run fetch-freedoom installs it into wads/).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  buildPatchFromColumns,
  decodePatch,
  PatchColumnOffsetError,
  PatchDecodeError,
  PatchHeaderError,
  PatchPostError,
} from './patch';
import { WadFile } from './wadfile';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function cols(...columns: number[][]): Uint8Array[] {
  return columns.map((c) => Uint8Array.from(c));
}

function expectColumns(patch: { columns: Uint8Array[] }, expected: number[][]): void {
  expect(patch.columns.map((c) => Array.from(c))).toEqual(expected);
}

/** Deterministic PRNG (xorshift32) so vector tests are reproducible. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

/* ------------------------------------------------------------------ */
/* round-trip via the pure builder                                    */
/* ------------------------------------------------------------------ */

describe('decodePatch ∘ buildPatchFromColumns round-trip', () => {
  it('round-trips a simple two-column patch', () => {
    const original = cols([0, 1, 2, 0, 3], [4, 0, 0, 5, 0]);
    const patch = decodePatch(buildPatchFromColumns(original));
    expectColumns(patch, [
      [0, 1, 2, 0, 3],
      [4, 0, 0, 5, 0],
    ]);
    expect(patch.width).toBe(2);
    expect(patch.height).toBe(5);
  });

  it('round-trips header fields (leftOffset/topOffset)', () => {
    const bytes = buildPatchFromColumns(cols([1]), 7, 9);
    const patch = decodePatch(bytes);
    expect([patch.width, patch.height, patch.leftOffset, patch.topOffset]).toEqual([1, 1, 7, 9]);
  });

  it('round-trips posts at the top and bottom edges and multi-post columns', () => {
    const original = cols(
      [9, 0, 0, 0, 0, 0, 0, 8], // post at row 0 + post at the last row
      [1, 2, 3, 0, 4, 5, 0, 6], // three posts
    );
    expectColumns(decodePatch(buildPatchFromColumns(original)), [
      [9, 0, 0, 0, 0, 0, 0, 8],
      [1, 2, 3, 0, 4, 5, 0, 6],
    ]);
  });

  it('round-trips runs that force post chains (255-boundary and row-254 cap)', () => {
    // A 300-long opaque run must be chained (length byte max 255, topdelta max 254).
    const tall = new Array<number>(320).fill(0);
    for (let i = 2; i < 302; i += 1) tall[i] = 7;
    // A deep run starting past the topdelta cap (row 300) must start a post at 254.
    const deep = new Array<number>(320).fill(0);
    for (let i = 300; i < 320; i += 1) deep[i] = 9;
    const original = cols(tall, deep, new Array<number>(320).fill(0));
    const patch = decodePatch(buildPatchFromColumns(original));
    expect(patch.height).toBe(320);
    expectColumns(patch, [tall, deep, new Array<number>(320).fill(0)]);
  });

  it('round-trips deterministic pseudo-random columns', () => {
    const rand = prng(0xc0ffee);
    for (let trial = 0; trial < 25; trial += 1) {
      const width = 1 + (rand() % 5);
      const height = 1 + (rand() % 300);
      const density = 1 + (rand() % 40);
      const original: number[][] = [];
      for (let c = 0; c < width; c += 1) {
        const col: number[] = [];
        for (let r = 0; r < height; r += 1) col.push(rand() % density === 0 ? 1 + (rand() % 255) : 0);
        original.push(col);
      }
      const patch = decodePatch(buildPatchFromColumns(original));
      expect(patch.width).toBe(width);
      expect(patch.height).toBe(height);
      expectColumns(patch, original);
    }
  });

  it('encodes an empty patch (zero width) and rejects ragged input', () => {
    const patch = decodePatch(buildPatchFromColumns([]));
    expect(patch.width).toBe(0);
    expect(patch.height).toBe(0);
    expect(patch.columns).toEqual([]);
    expect(() => buildPatchFromColumns(cols([1, 2], [1]))).toThrow(/ragged/);
  });

  it('is pure: input arrays are not mutated', () => {
    const original = cols([0, 1, 2, 0, 3]);
    const snapshot = Array.from(original[0]!);
    buildPatchFromColumns(original);
    expect(Array.from(original[0]!)).toEqual(snapshot);
  });
});

/* ------------------------------------------------------------------ */
/* handcrafted byte vectors (explicit post layout)                     */
/* ------------------------------------------------------------------ */

function u8(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

describe('decodePatch handcrafted vectors', () => {
  it('decodes a 2-column patch with slack/alignment bytes between columns', () => {
    // Header 16 B; col0 @16: one post (td=0 len=2, slack, data @+3, trailing slack,
    // stride 2+4=6), terminator FF 00 @22..23; 3 alignment bytes @24..26 that are
    // never read (columnofs is authoritative); col1 @27: empty column (FF terminator).
    const bytes = u8(
      2, 0, // width
      3, 0, // height
      1, 0, // leftoffset
      2, 0, // topoffset
      16, 0, 0, 0, // columnofs[0]
      27, 0, 0, 0, // columnofs[1]
      0, 2, 0, 10, 11, 0, // post: row 0, len 2, slack, 10 11, trailing slack
      0xff, 0x00, // col0 terminator
      0x61, 0x62, 0x63, // 3 alignment bytes between columns
      0xff, 0x00, // col1 terminator
    );
    const patch = decodePatch(bytes);
    expect([patch.width, patch.height, patch.leftOffset, patch.topOffset]).toEqual([2, 3, 1, 2]);
    expectColumns(patch, [[10, 11, 0], [0, 0, 0]]);
  });

  it('walks a column with several posts using stride length+4', () => {
    // height 6: post@row1 len2, post@row5 len1, terminator.
    const bytes = u8(
      1, 0, 6, 0, 0, 0, 0, 0, //
      16, 0, 0, 0, // columnofs[0] = 16
      0, 0, 0, 0, // filler between table and posts (never read)
      1, 2, 0, 20, 21, 0, // row 1, len 2
      5, 1, 0, 22, 0, // row 5, len 1
      0xff, 0,
    );
    expectColumns(decodePatch(bytes), [[0, 20, 21, 0, 0, 22]]);
  });

  it('treats 0x80 as an ordinary topdelta (row 128), 0xFF as the terminator', () => {
    const column = new Array<number>(130).fill(0);
    column[128] = 0x2a;
    const bytes = buildPatchFromColumns([Uint8Array.from(column)], 0, 0);
    const decoded = decodePatch(bytes);
    expectColumns(decoded, [column]);
    // Explicitly: the encoded post header must carry topdelta byte 0x80, not FF.
    expect(bytes[12]).toBe(0x80);
  });

  it('clips a post that overflows past the patch height (vanilla stance: clip, not error)', () => {
    // height 4, post at row 2 claiming 10 bytes — 2 readable + clip, no error.
    const bytes = u8(
      1, 0, 4, 0, 0, 0, 0, 0, //
      16, 0, 0, 0, 0, 0, 0, 0, //
      2, 10, 0, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 0, //
      0xff, 0,
    );
    expectColumns(decodePatch(bytes), [[0, 0, 30, 31]]);
  });

  it('decodes zero-width patches to empty columns and zero-height to empty strips', () => {
    const zeroWidth = u8(0, 0, 5, 0, 0, 0, 0, 0);
    expect(decodePatch(zeroWidth).columns).toEqual([]);
    const zeroHeight = u8(1, 0, 0, 0, 0, 0, 0, 0, 8, 0, 0, 0, 0xff, 0);
    const patch = decodePatch(zeroHeight);
    expect([patch.width, patch.height]).toEqual([1, 0]);
    expectColumns(patch, [[]]);
  });
});

/* ------------------------------------------------------------------ */
/* malformed inputs (typed errors, never OOB reads)                    */
/* ------------------------------------------------------------------ */

describe('decodePatch malformed inputs', () => {
  it('rejects a too-short header', () => {
    expect(() => decodePatch(u8(1, 0, 2, 0))).toThrowError(PatchHeaderError);
    expect(() => decodePatch(u8(1, 0, 2, 0))).toThrowError(PatchDecodeError);
    expect(() => decodePatch(new Uint8Array(0))).toThrowError(PatchHeaderError);
  });

  it('rejects negative dimensions and a truncated columnofs table', () => {
    const negative = u8(0xff, 0xff, 2, 0, 0, 0, 0, 0); // width = -1
    expect(() => decodePatch(negative)).toThrowError(PatchHeaderError);
    const truncatedTable = u8(4, 0, 1, 0, 0, 0, 0, 0, 16, 0, 0, 0); // width 4, only 1 offset
    expect(() => decodePatch(truncatedTable)).toThrowError(PatchHeaderError);
  });

  it('rejects column offsets pointing into the header or past the lump end', () => {
    const intoHeader = u8(1, 0, 1, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0xff, 0);
    expect(() => decodePatch(intoHeader)).toThrowError(PatchColumnOffsetError);
    const pastEnd = u8(1, 0, 1, 0, 0, 0, 0, 0, 99, 0, 0, 0, 0xff, 0);
    expect(() => decodePatch(pastEnd)).toThrowError(PatchColumnOffsetError);
  });

  it('rejects a post whose data runs past the lump end', () => {
    const bytes = u8(1, 0, 8, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 200, 201, 202);
    expect(() => decodePatch(bytes)).toThrowError(PatchPostError);
  });

  it('rejects a column that runs out of bytes before the 0xFF terminator', () => {
    const bytes = u8(1, 0, 8, 0, 0, 0, 0, 0, 12, 0, 0, 0, 1, 2, 0, 5, 6, 7, 0);
    expect(() => decodePatch(bytes)).toThrowError(PatchPostError);
  });

  it('rejects a zero-progress post (topdelta 0, length 0)', () => {
    const bytes = u8(1, 0, 8, 0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0);
    expect(() => decodePatch(bytes)).toThrowError(PatchPostError);
  });

  it('never reads out of bounds on a truncated post header', () => {
    const bytes = u8(1, 0, 8, 0, 0, 0, 0, 0, 12, 0, 0, 0, 3, 4); // post header cut by EOF
    expect(() => decodePatch(bytes)).toThrowError(PatchPostError);
  });
});

/* ------------------------------------------------------------------ */
/* freedoom1.wad goldens (skipped when the WAD is absent)              */
/* ------------------------------------------------------------------ */

const WAD_PATH = process.env.FREEDOOM1_WAD ?? fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad goldens', () => {
  const wad: WadFile | null = hasWad ? WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer) : null;

  function shaOfPatchColumns(name: string): {
    width: number; height: number; leftOffset: number; topOffset: number; sha256: string;
  } {
    const patch = decodePatch(wad!.readLumpByName(name));
    const joined = new Uint8Array(patch.width * patch.height);
    for (let c = 0; c < patch.width; c += 1) joined.set(patch.columns[c]!, c * patch.height);
    return {
      width: patch.width,
      height: patch.height,
      leftOffset: patch.leftOffset,
      topOffset: patch.topOffset,
      sha256: createHash('sha256').update(joined).digest('hex'),
    };
  }

  // Recorded 2026-07 from wads/freedoom1.wad (sha256 7323bcc1…703d, v0.13.0
  // pinned in scripts/freedoom/release.json). BOSSA1 dimensions match R02 §5
  // (w=49 h=69 left=24 top=69). WALL00_3 is a PNAMES wall patch; PLAYA1/BOSSA1
  // are S_START sprites.
  const GOLDEN: Record<string, { width: number; height: number; leftOffset: number; topOffset: number; sha256: string }> = {
    WALL00_3: {
      width: 16,
      height: 128,
      leftOffset: 8,
      topOffset: 123,
      sha256: 'f2bdf067c09848524c32f81453b05114ac92fa6e9667999bffe5e8b686213de1',
    },
    PLAYA1: {
      width: 36,
      height: 56,
      leftOffset: 18,
      topOffset: 54,
      sha256: '886a7aee7791390626a18b6f88bb1868f61c569e6e249b865703a0347477c52e',
    },
    BOSSA1: {
      width: 49,
      height: 69,
      leftOffset: 24,
      topOffset: 69,
      sha256: 'd8f2a8b31ad60df30b88e3a7e79d0736d929a3c88d738de205d0f3e3d981ad00',
    },
  };

  for (const [name, expected] of Object.entries(GOLDEN)) {
    it(`decodes ${name} to the golden shape + column-bytes sha256`, () => {
      expect(shaOfPatchColumns(name)).toEqual(expected);
    });
  }

  it('decodes every plausible patch lump without throwing (corpus sweep)', () => {
    let decoded = 0;
    for (let num = 0; ; num += 1) {
      const info = wad!.lumpNumAt(num) >= 0 ? wad!.lumpInfo(num) : null;
      if (info === null) break;
      let bytes: Uint8Array;
      try {
        bytes = wad!.readLump(num);
      } catch {
        break;
      }
      if (bytes.length < 16 || bytes.length > 200000) continue;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const w = view.getInt16(0, true);
      const h = view.getInt16(2, true);
      if (w <= 0 || h <= 0 || w > 1024 || h > 1024) continue;
      let looksLikePatch = true;
      for (let c = 0; c < w; c += 1) {
        const off = view.getUint32(8 + c * 4, true);
        if (off < 8 + w * 4 || off >= bytes.length) {
          looksLikePatch = false;
          break;
        }
      }
      if (!looksLikePatch) continue;
      try {
        decodePatch(bytes);
        decoded += 1;
      } catch (err) {
        throw new Error(`corpus lump ${info.name} (#${num}) failed: ${String(err)}`);
      }
    }
    expect(decoded).toBeGreaterThan(2000); // freedoom1 has ~2250 patch-format lumps
  });
});
