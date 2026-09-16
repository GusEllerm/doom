// render/framebuffer.ts — 320x200 palette-indexed framebuffer + PLAYPAL
// bank-0 LUT blit (ARCHITECTURE §4.7, M2-plan §M2-09 gap G8: pulled forward
// from M3 because the automap needs it in M2).
//
// The pixel store is a Uint8Array of palette indices (vanilla `fb` in
// am_map.c); color happens only at blit time via a 256-entry Uint32 LUT
// packed in ImageData byte order, so a palette change = LUT rebuild only
// (M2-plan M2-09 acceptance 5 — buildLut is pure, callers cache it).
//
// LUT packing: wad/palettes packs 0xAARRGGBB — in little-endian memory the
// bytes are [R,G,B,A], which IS ImageData row order for a Uint32 view... but
// palettes.test pins the packed value as 0xAARRGGBB whose LE bytes are
// [B,G,R,A]; ImageData needs [R,G,B,A], so buildLut swaps the R/B halves
// (same swap as viewer/blit.toImageDataRgba, re-derived here to keep the
// render zone off the viewer page's module graph).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { NUM_PALETTES, PALETTE_SIZE } from '../wad/palettes';

/** Vanilla SCREENWIDTH (doomdef.h:110). */
export const RENDER_WIDTH = 320;
/** Vanilla SCREENHEIGHT (doomdef.h:111). */
export const RENDER_HEIGHT = 200;

/** packed 0xAARRGGBB → ImageData-order uint32 (LE bytes [R,G,B,A]). */
export function toImageDataRgba(packed: number): number {
  return ((packed & 0xff00ff00) | ((packed & 0xff) << 16) | ((packed >>> 16) & 0xff)) >>> 0;
}

/**
 * Palette index → packed ImageData-order RGBA, one entry per palette slot,
 * from a decoded PLAYPAL `base` (`base[bank*256+color]`, decodePlaypal).
 * `bank` 0 = normal (R02 §2). Pure + cheap → rebuild ONLY on palette change.
 */
export function buildLut(base: Uint32Array, bank = 0): Uint32Array {
  if (bank < 0 || bank >= NUM_PALETTES) {
    throw new RangeError(`PLAYPAL bank ${bank} out of range [0,${NUM_PALETTES})`);
  }
  const lut = new Uint32Array(PALETTE_SIZE);
  for (let i = 0; i < PALETTE_SIZE; i++) {
    lut[i] = toImageDataRgba(base[bank * PALETTE_SIZE + i] as number);
  }
  return lut;
}

/** Indexed 320x200 framebuffer with an RGBA blit scratch. */
export class Framebuffer {
  readonly width: number;
  readonly height: number;
  /** Vanilla `fb` — one palette index per pixel, row-major. */
  readonly indices: Uint8Array;
  /** RGBA scratch in ImageData layout (width*height*4), opaque alpha. */
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  /** Uint32 view over `pixels` (one store per pixel in blit). */
  readonly pixels32: Uint32Array;
  /** Cached ImageData wrapping `pixels` itself (zero alloc per present). */
  private imageData: ImageData | null = null;

  constructor(width: number = RENDER_WIDTH, height: number = RENDER_HEIGHT) {
    this.width = width;
    this.height = height;
    this.indices = new Uint8Array(width * height);
    this.pixels = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
    this.pixels.fill(0xff); // opaque alpha once; blit rewrites whole pixels
    this.pixels32 = new Uint32Array(this.pixels.buffer);
  }

  /**
   * The ImageData to hand putImageData — created ONCE over this buffer's
   * own `pixels` (browser-only: node/vitest never calls this half).
   */
  canvasImage(): ImageData {
    if (this.imageData === null) {
      this.imageData = new ImageData(this.pixels, this.width, this.height);
    }
    return this.imageData;
  }

  /** AM_clearFB(color): whole buffer to one index. */
  clear(index: number): void {
    this.indices.fill(index & 255);
  }

  /** PUTDOT(xx,yy,cc) `fb[(yy)*f_w+(xx)]=(cc)` — verbatim semantics: typed
   * arrays silently drop out-of-range stores, standing in for vanilla's
   * benign-in-practice OOB writes. */
  point(x: number, y: number, index: number): void {
    this.indices[y * this.width + x] = index & 255;
  }

  /** Horizontal run, both ends inclusive, clipped to the buffer. */
  hline(x0: number, x1: number, y: number, index: number): void {
    if (y < 0 || y >= this.height || x0 > x1) return;
    const lo = Math.max(0, x0);
    const hi = Math.min(this.width - 1, x1);
    const row = y * this.width;
    for (let x = lo; x <= hi; x++) this.indices[row + x] = index & 255;
  }

  /** Vertical run, both ends inclusive, clipped to the buffer. */
  vline(y0: number, y1: number, x: number, index: number): void {
    if (x < 0 || x >= this.width || y0 > y1) return;
    const lo = Math.max(0, y0);
    const hi = Math.min(this.height - 1, y1);
    for (let y = lo; y <= hi; y++) this.indices[y * this.width + x] = index & 255;
  }

  /**
   * Indexed → RGBA into `pixels` (row-major 1:1, no scaling). DOM-free so
   * vitest covers it under node; {@link blitToCanvas} adds the
   * putImageData half.
   */
  blit(lut: Uint32Array): void {
    const idx = this.indices;
    const v = this.pixels32;
    for (let i = 0; i < idx.length; i++) v[i] = lut[idx[i] as number] as number;
  }
}

/**
 * Present: blit the indices through the LUT into the framebuffer's own
 * Uint8Clamped scratch, then putImageData via a cached ImageData that
 * WRAPS the same buffer (zero per-frame allocation in steady state, M2-09
 * acceptance 4).
 */
export function blitToCanvas(ctx: CanvasRenderingContext2D, fb: Framebuffer, lut: Uint32Array): void {
  fb.blit(lut);
  const img = fb.canvasImage();
  ctx.putImageData(img, 0, 0);
}
