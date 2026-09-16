/**
 * Viewer-only indexed→RGBA blit helpers (M1-08). DOM-free: they write into
 * a plain Uint8ClampedArray with the ImageData layout so vitest can cover
 * them under the node environment. Replaced by render/framebuffer.ts when
 * the M3 framebuffer lands (M1-plan §M1-08).
 *
 * Palette model (src/wad/palettes.ts): `base[bank*256 + color]` packed
 * 0xAARRGGBB — little-endian in memory that is [R,G,B,A], exactly ImageData
 * byte order, so an entry can be written across 4 bytes with one Uint32 view.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Blit parameters shared by every renderer. */
export interface BlitContext {
  /** Destination RGBA pixels (target.width*target.height*4). */
  data: Uint8ClampedArray;
  /** Destination size in pixels. */
  width: number;
  height: number;
  /** Decoded PLAYPAL base (14*256 packed RGBA). */
  base: Uint32Array;
  /** PLAYPAL bank (0..13). */
  bank: number;
  /** COLORMAP row (256 entries) applied before the palette, or null. */
  colormapRow: Uint8Array | null;
  /** Clear the destination first (default true). */
  clear?: boolean;
}

/** Resolve one palette index to packed RGBA for the active bank + colormap row. */
export function indexToRgba(
  base: Uint32Array,
  bank: number,
  index: number,
  colormapRow: Uint8Array | null,
): number {
  const color = colormapRow !== null ? (colormapRow[index & 255] as number) : index & 255;
  return base[bank * 256 + color] as number;
}

/**
 * palettes.ts packs 0xAARRGGBB — in little-endian memory that lays out as
 * [B,G,R,A] (asserted in src/wad/palettes.test.ts), but ImageData needs
 * [R,G,B,A]. Swap the R/B halves to get the Uint32 value whose LE bytes are
 * the ImageData order.
 */
export function toImageDataRgba(packed: number): number {
  return (
    (packed & 0xff00ff00) | (((packed & 0xff) << 16) | ((packed >>> 16) & 0xff))
  ) >>> 0;
}

function view32(data: Uint8ClampedArray): Uint32Array {
  // ImageData data is always created over a fresh ArrayBuffer with byteOffset 0.
  return new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2);
}

function clearPixels(data: Uint8ClampedArray, clearColor: number): void {
  const v = view32(data);
  v.fill(clearColor);
}

/** Draw one pixel with bounds clipping (row overflow guarded by callers via column length). */
function put(v: Uint32Array, width: number, x: number, y: number, rgba: number): void {
  if (x < 0 || y < 0 || x >= width) return;
  const o = y * width + x;
  if (o >= 0 && o < v.length) v[o] = rgba >>> 0;
}

/**
 * Blit a row-major index buffer (flats) over the whole target.
 * `pixels.length` must be >= width*height.
 */
export function blitFlat(ctx: BlitContext, pixels: Uint8Array): void {
  if (ctx.clear !== false) clearPixels(ctx.data, 0xff000000);
  const v = view32(ctx.data);
  const { base, bank, colormapRow } = ctx;
  for (let i = 0; i < ctx.width * ctx.height; i++) {
    v[i] = toImageDataRgba(indexToRgba(base, bank, pixels[i] as number, colormapRow));
  }
}

/**
 * Blit column-major indices (patches with transparentZero=0, composed
 * textures) at (x0,y0). `columns[c][r]` is the pixel at (x0+c, y0+r).
 * When transparentZero, index 0 leaves the destination untouched; the
 * caller should pre-clear (clear:true ⇒ opaque black).
 */
export function blitColumns(
  ctx: BlitContext,
  columns: readonly Uint8Array[],
  x0: number,
  y0: number,
  flipX: boolean,
  transparentZero: boolean,
): void {
  if (ctx.clear !== false) clearPixels(ctx.data, 0x00000000); // transparent clear
  const v = view32(ctx.data);
  const { base, bank, colormapRow, width } = ctx;
  for (let c = 0; c < columns.length; c++) {
    const col = columns[c] as Uint8Array;
    const dx = x0 + (flipX ? columns.length - 1 - c : c);
    if (dx < 0 || dx >= width) continue;
    for (let r = 0; r < col.length; r++) {
      const idx = col[r] as number;
      if (transparentZero && idx === 0) continue;
      put(v, width, dx, y0 + r, toImageDataRgba(indexToRgba(base, bank, idx, colormapRow)));
    }
  }
}


