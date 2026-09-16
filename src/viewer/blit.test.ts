/**
 * Unit tests for the viewer's indexed→RGBA blits (M1-08 acceptance 4):
 * palette packing order (BGRA-in-memory → ImageData RGBA), colormap
 * translation, transparency, mirroring, clipping.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';
import { blitColumns, blitFlat, indexToRgba, toImageDataRgba, type BlitContext } from './blit';

function fakeBase(): Uint32Array {
  // Bank b, entry i packs 0xFF RR GG BB with R = i+7b, G = 255-i, B = 2i.
  const base = new Uint32Array(14 * 256);
  for (let bank = 0; bank < 14; bank++) {
    for (let i = 0; i < 256; i++) {
      const r = (i + bank * 7) & 255;
      base[bank * 256 + i] = ((0xff << 24) | (r << 16) | (((255 - i) & 255) << 8) | ((i * 2) & 255)) >>> 0;
    }
  }
  return base;
}

function target(w: number, h: number): { data: Uint8ClampedArray; width: number; height: number } {
  return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
}

function ctxFor(
  t: { data: Uint8ClampedArray; width: number; height: number },
  over: Partial<BlitContext> = {},
): BlitContext {
  return { ...t, base: fakeBase(), bank: 0, colormapRow: null, ...over };
}

function u32(data: Uint8ClampedArray, pixel: number): number {
  return new DataView(data.buffer).getUint32(pixel * 4, true);
}

/** The Uint32 value whose little-endian bytes equal palette entry `i`'s [R,G,B,A]. */
function imagePix(i: number): number {
  return toImageDataRgba(fakeBase()[i] as number);
}

describe('indexToRgba + channel order', () => {
  it('reads bank*256+color from the packed table', () => {
    const base = fakeBase();
    expect(indexToRgba(base, 0, 5, null)).toBe(base[5] as number);
    expect(indexToRgba(base, 3, 200, null)).toBe(base[3 * 256 + 200] as number);
  });
  it('applies a colormap row before the palette', () => {
    const base = fakeBase();
    const row = new Uint8Array(256).fill(9);
    expect(indexToRgba(base, 2, 77, row)).toBe(base[2 * 256 + 9] as number);
  });
  it('toImageDataRgba reorders packed [B,G,R,A] memory into [R,G,B,A]', () => {
    const packed = fakeBase()[17] as number; // 0xFF RR GG BB
    const swapped = toImageDataRgba(packed);
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setUint32(0, swapped, true);
    expect(bytes[0]).toBe((packed >>> 16) & 0xff); // R
    expect(bytes[1]).toBe((packed >>> 8) & 0xff); // G
    expect(bytes[2]).toBe(packed & 0xff); // B
    expect(bytes[3]).toBe(255); // A
  });
});

describe('blitFlat', () => {
  it('writes palette colors row-major with opaque alpha', () => {
    const t = target(2, 2);
    blitFlat(ctxFor(t), Uint8Array.from([0, 1, 2, 255]));
    for (let i = 0; i < 4; i++) expect(u32(t.data, i)).toBe(imagePix([0, 1, 2, 255][i] as number));
    const last = new Uint8Array(t.data.buffer).slice(12, 16);
    expect([...last]).toEqual([
      ((fakeBase()[255] as number) >>> 16) & 0xff,
      ((fakeBase()[255] as number) >>> 8) & 0xff,
      (fakeBase()[255] as number) & 0xff,
      255,
    ]);
  });
  it('honors a colormap row', () => {
    const t = target(1, 1);
    const row = new Uint8Array(256).fill(42);
    blitFlat(ctxFor(t, { colormapRow: row }), Uint8Array.from([7]));
    expect(u32(t.data, 0)).toBe(imagePix(42));
  });
});

describe('blitColumns', () => {
  it('treats index 0 as transparent (keeps cleared dest)', () => {
    const t = target(2, 1);
    blitColumns(ctxFor(t), [Uint8Array.from([0, 3]), Uint8Array.from([1, 0])], 0, 0, false, true);
    expect(u32(t.data, 0)).toBe(0); // transparent clear + skipped pixel
    expect(u32(t.data, 1)).toBe(imagePix(1)); // (1,0) col1 row0; col1 row0=1, row1 clipped
  });
  it('maps column-major into row-major destinations', () => {
    const t = target(2, 2);
    blitColumns(ctxFor(t), [Uint8Array.from([1, 2]), Uint8Array.from([3, 4])], 0, 0, false, true);
    expect(u32(t.data, 0)).toBe(imagePix(1)); // (0,0) col0 row0
    expect(u32(t.data, 2)).toBe(imagePix(2)); // (0,1) col0 row1
    expect(u32(t.data, 1)).toBe(imagePix(3));
    expect(u32(t.data, 3)).toBe(imagePix(4));
  });
  it('mirrors columns when flipX', () => {
    const t = target(2, 1);
    blitColumns(ctxFor(t), [Uint8Array.from([5]), Uint8Array.from([9])], 0, 0, true, true);
    expect(u32(t.data, 0)).toBe(imagePix(9));
    expect(u32(t.data, 1)).toBe(imagePix(5));
  });
  it('clips rows/columns past the destination without OOB writes', () => {
    const t = target(2, 2);
    blitColumns(
      ctxFor(t),
      [Uint8Array.from([1, 1, 1, 1]), Uint8Array.from([1, 1, 1, 1])],
      1,
      1,
      false,
      true,
    );
    expect(u32(t.data, 3)).toBe(imagePix(1)); // (1,1)
    expect(t.data).toHaveLength(16);
  });
  it('paints index 0 opaque when transparentZero is false', () => {
    const t = target(1, 1);
    blitColumns(ctxFor(t), [Uint8Array.from([0])], 0, 0, false, false);
    expect(u32(t.data, 0)).toBe(imagePix(0));
  });
});
