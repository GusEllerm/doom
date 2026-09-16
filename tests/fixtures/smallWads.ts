/**
 * Small hand-defined fixture content (M1-05): tiny but byte-VALID graphics so
 * decoder tests never need a real WAD. Every generator is deterministic for
 * its arguments, so golden hashes built on top of it are reproducible.
 *
 * Layout constants come from R01 §14: flats are exactly 4096 bytes, patch
 * headers are 4×int16 + width×int32 columnofs with columnofs[i] authoritative
 * (R01 §14 patches row), PNAMES is int32 count + 8-byte names (stride 8),
 * TEXTURE1 records use the vanilla "struct on disk" shape (22-byte header,
 * width@12, height@14, patchcount@20, patches@22, R01 §14).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { WadBuilder } from './wadWriter';

/** Deterministic byte source (xorshift-style LCG; seed 0 disallowed). */
export function synthBytes(length: number, seed = 1): Uint8Array {
  if (seed === 0) throw new RangeError('seed must be non-zero');
  let s = seed | 0;
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    out[i] = s & 0xff;
  }
  return out;
}

/**
 * Columnar patch (R01 §14): one full-height post per column + 0xFF
 * terminator. columnofs values are exact, so trailing align bytes are simply
 * absent — legal because columnofs is authoritative. pixels is column-major,
 * length width*height.
 */
export function synthPatch(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height) {
    throw new RangeError(`patch pixel count ${pixels.length} != ${width}x${height}`);
  }
  const columnSize = 2 + height + 1; // topdelta+length + pixels + 0xFF terminator
  const size = 8 + 4 * width + width * columnSize;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setInt16(0, width, true);
  view.setInt16(2, height, true);
  view.setInt16(4, width >> 1, true); // leftoffset
  view.setInt16(6, height >> 1, true); // topoffset
  for (let c = 0; c < width; c++) {
    const colStart = 8 + 4 * width + c * columnSize;
    view.setInt32(8 + c * 4, colStart, true);
    out[colStart] = 0; // topdelta
    out[colStart + 1] = height; // length
    out.set(pixels.subarray(c * height, (c + 1) * height), colStart + 2);
    out[colStart + 2 + height] = 0xff; // end of column
  }
  return out;
}

/** The canonical tiny 2x2 patch used across tests. */
export function patch2x2(seed = 0x5eed): Uint8Array {
  return synthPatch(2, 2, synthBytes(4, seed));
}

/** Exactly 4096 bytes of flat data (64x64 palettized, R01 §14). */
export function synthFlat(seed = 0xf1a4): Uint8Array {
  return synthBytes(4096, seed);
}

/** PNAMES lump: int32 count + count × 8-byte names (R01 §14, stride 8). */
export function synthPnames(names: string[]): Uint8Array {
  const out = new Uint8Array(4 + 8 * names.length);
  new DataView(out.buffer).setInt32(0, names.length, true);
  names.forEach((name, i) => {
    const upper = name.toUpperCase();
    if (upper.length > 8) throw new RangeError(`pname too long: ${name}`);
    for (let c = 0; c < upper.length; c++) out[4 + i * 8 + c] = upper.charCodeAt(c);
  });
  return out;
}

export interface TextureSpec {
  name: string;
  width: number;
  height: number;
  /** Patch entries: [x, y, pnamesIndex]. */
  patches: [number, number, number][];
}

/** One vanilla TEXTURE1 "struct on disk" record (R01 §14 offsets). */
function textureRecord(spec: TextureSpec): Uint8Array {
  const size = 22 + 10 * spec.patches.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  const upper = spec.name.toUpperCase();
  if (upper.length > 8) throw new RangeError(`texture name too long: ${spec.name}`);
  for (let c = 0; c < upper.length; c++) out[c] = upper.charCodeAt(c);
  view.setInt16(12, spec.width, true);
  view.setInt16(14, spec.height, true);
  view.setInt16(20, spec.patches.length, true);
  spec.patches.forEach(([x, y, patch], i) => {
    const at = 22 + i * 10;
    view.setInt16(at, x, true);
    view.setInt16(at + 2, y, true);
    view.setInt16(at + 4, patch, true);
    // stepdir (at+6) and colormap (at+8) stay 0
  });
  return out;
}

/** TEXTURE1 lump: int32 count + int32 record offsets + records (R01 §14). */
export function synthTexture1(specs: TextureSpec[]): Uint8Array {
  const records = specs.map(textureRecord);
  const size = 4 + 4 * specs.length + records.reduce((n, r) => n + r.length, 0);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  view.setInt32(0, specs.length, true);
  let cursor = 4 + 4 * specs.length;
  specs.forEach((_, i) => {
    view.setInt32(4 + i * 4, cursor, true);
    out.set(records[i]!, cursor);
    cursor += records[i]!.length;
  });
  return out;
}

/** One 2-patch TEXTURE1 + matching PNAMES pair for texture-decoder tests. */
export function synthTexturePair(): { texture1: Uint8Array; pnames: Uint8Array } {
  const pnames = synthPnames(['FIXP0', 'FIXP1']);
  const texture1 = synthTexture1([
    {
      name: 'FIXTEX0',
      width: 64,
      height: 32,
      patches: [
        [0, 0, 0],
        [32, 0, 1],
      ],
    },
  ]);
  return { texture1, pnames };
}

/**
 * The standard small fixture IWAD: TEXTURE1/PNAMES pair, one 4096-byte flat
 * between F_START/F_END, a 2x2 patch in P_START/P_END, two S_START/S_END
 * sprite frames with a zero-size marker between them (exercises lumpRange
 * marker skipping) plus a DS* dummy. Fully deterministic.
 */
export function buildSmallWad(): Uint8Array {
  const wad = new WadBuilder('IWAD');
  const { texture1, pnames } = synthTexturePair();
  wad.addLump('TEXTURE1', texture1);
  wad.addLump('PNAMES', pnames);
  wad.addLumpMarker('F_START');
  wad.addLump('FIXFLAT', synthFlat());
  wad.addLumpMarker('F_END');
  wad.addLumpMarker('P_START');
  wad.addLump('FIXP0', patch2x2(0x5e0));
  wad.addLump('FIXP1', patch2x2(0x5e1));
  wad.addLumpMarker('P_END');
  wad.addLumpMarker('S_START');
  wad.addLump('BON1A0', patch2x2(0x5a0)); // 1 rotation (0 = all angles)
  wad.addLumpMarker('S_FIX0'); // zero-size marker inside the sprite range
  wad.addLump('PLAYA2A8', patch2x2(0x5a1)); // mirrored pair name
  wad.addLumpMarker('S_END');
  wad.addLump('DSFIX', synthBytes(37, 0xd5)); // DS* dummy sound
  return wad.build();
}
