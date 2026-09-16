/**
 * render/framebuffer tests (M2-09): LUT packing + clear/point/hline/vline
 * correctness + indexed→RGBA blit. Pure data, no canvas (node env).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { paletteToRgba } from '../wad/palettes';
import {
  buildLut,
  Framebuffer,
  RENDER_HEIGHT,
  RENDER_WIDTH,
  toImageDataRgba
} from './framebuffer';

describe('toImageDataRgba / buildLut', () => {
  it('swaps packed 0xAARRGGBB to ImageData byte order [R,G,B,A]', () => {
    // packed value 0xFFRRGGBB little-endian bytes are [B,G,R,A]; the LUT
    // entry's LE bytes must be [R,G,B,A].
    const packed = paletteToRgba(0x11, 0x22, 0x33); // 0xFF112233
    expect(packed).toBe(0xff112233);
    const swapped = toImageDataRgba(packed);
    const bytes = new Uint8Array(new Uint32Array([swapped]).buffer);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x11, 0x22, 0x33, 0xff]);
  });

  it('builds a 256-entry LUT from PLAYPAL bank 0 with per-bank offset', () => {
    const base = new Uint32Array(14 * 256);
    for (let bank = 0; bank < 14; bank++) {
      for (let i = 0; i < 256; i++) base[bank * 256 + i] = paletteToRgba(i, bank, 0);
    }
    const lut = buildLut(base, 0);
    expect(lut.length).toBe(256);
    for (let i = 0; i < 256; i++) {
      const bytes = new Uint8Array(new Uint32Array([lut[i] as number]).buffer);
      expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([i, 0, 0, 0xff]);
    }
    const lut3 = buildLut(base, 3);
    const b = new Uint8Array(new Uint32Array([lut3[7]!]).buffer);
    expect([b[0], b[1], b[2]]).toEqual([7, 3, 0]);
    expect(() => buildLut(base, 14)).toThrow(RangeError);
    expect(() => buildLut(base, -1)).toThrow(RangeError);
  });
});

describe('Framebuffer', () => {
  it('clear fills the whole index buffer', () => {
    const fb = new Framebuffer();
    expect(fb.indices.length).toBe(RENDER_WIDTH * RENDER_HEIGHT);
    fb.clear(42);
    expect(fb.indices.every((v) => v === 42)).toBe(true);
  });

  it('point writes one index; typed-array OOB drops (in-range wrap = vanilla PUTDOT)', () => {
    const fb = new Framebuffer();
    fb.point(5, 7, 9);
    expect(fb.indices[7 * RENDER_WIDTH + 5]).toBe(9);
    fb.point(-1, 0, 3); // index -1 ⇒ dropped
    fb.point(0, RENDER_HEIGHT, 3); // index 64000 ⇒ dropped
    expect(fb.indices.some((v) => v === 3)).toBe(false);
    // fb[y*f_w+x] has no bounds check in vanilla either: a past-the-edge x
    // lands on the next row (wrap), which the fuck-guarded fline never does.
    fb.point(RENDER_WIDTH, 0, 3);
    expect(fb.indices[RENDER_WIDTH]).toBe(3); // row 1, col 0 — documented quirk
  });

  it('hline is inclusive and clips; reversed/below-area rows are no-ops', () => {
    const fb = new Framebuffer();
    fb.hline(3, 6, 2, 5);
    for (let x = 3; x <= 6; x++) expect(fb.indices[2 * RENDER_WIDTH + x]).toBe(5);
    expect(fb.indices[2 * RENDER_WIDTH + 2]).toBe(0);
    expect(fb.indices[2 * RENDER_WIDTH + 7]).toBe(0);
    fb.hline(RENDER_WIDTH - 2, RENDER_WIDTH + 5, 0, 1); // clipped right
    expect(fb.indices[RENDER_WIDTH - 1]).toBe(1);
    fb.hline(10, 4, 0, 7); // inverted ⇒ no-op
    fb.hline(0, 10, -1, 7); // off-canvas row ⇒ no-op
    expect(fb.indices.every((v) => v !== 7)).toBe(true);
  });

  it('vline is inclusive and clips', () => {
    const fb = new Framebuffer();
    fb.vline(4, 8, 3, 6);
    for (let y = 4; y <= 8; y++) expect(fb.indices[y * RENDER_WIDTH + 3]).toBe(6);
    expect(fb.indices[3 * RENDER_WIDTH + 3]).toBe(0);
    fb.vline(RENDER_HEIGHT - 2, RENDER_HEIGHT + 4, 0, 2); // clipped bottom
    expect(fb.indices[(RENDER_HEIGHT - 1) * RENDER_WIDTH]).toBe(2);
    fb.vline(9, 1, 0, 8); // inverted ⇒ no-op
    fb.vline(0, 5, -1, 8); // off-canvas column ⇒ no-op
    expect(fb.indices.some((v) => v === 8)).toBe(false);
  });

  it('blit maps indices through the LUT into RGBA bytes (zero stays at LUT[0])', () => {
    const base = new Uint32Array(14 * 256);
    for (let i = 0; i < 256; i++) base[i] = paletteToRgba(i, 255 - i, i ^ 0x5a);
    const lut = buildLut(base, 0);
    const fb = new Framebuffer();
    fb.clear(0);
    fb.point(1, 0, 176);
    fb.point(2, 0, 255);
    fb.blit(lut);
    const px = (x: number, y: number): number[] => {
      const o = (y * RENDER_WIDTH + x) * 4;
      return [fb.pixels[o]!, fb.pixels[o + 1]!, fb.pixels[o + 2]!, fb.pixels[o + 3]!];
    };
    const expect176 = [176, 255 - 176, 176 ^ 0x5a, 255];
    expect(fb.pixels.length).toBe(RENDER_WIDTH * RENDER_HEIGHT * 4);
    expect(px(1, 0)).toEqual(expect176);
    const expect255 = [255, 0, 255 ^ 0x5a, 255];
    expect(px(2, 0)).toEqual(expect255);
    // untouched pixel = LUT[0] of a cleared buffer — but blit rewrites ALL
    // pixels, so even the clear-index pixel comes from the LUT:
    expect(px(0, 5)).toEqual([0, 255, 0 ^ 0x5a, 255]);
    expect(lut.length).toBe(256);
  });

  it('keeps default 320x200 geometry', () => {
    const fb = new Framebuffer();
    expect(fb.width).toBe(320);
    expect(fb.height).toBe(200);
  });
});
