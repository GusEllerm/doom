// render/cols.ts — wall column blit: R_DrawColumn + the dc_* globals
// (M3-plan §M3-05). Verbatim port of linuxdoom-1.10/r_draw.c:82-149.
//
// Zone discipline (eslint doom/zones/render): imports core + render only.
// The framebuffer is touched through its raw `indices` Uint8Array —
// framebuffer.ts itself is untouched (M2-09-owned).
//
// Vanilla mapping (r_draw.c, line numbers from the id release):
//   dc_* globals (r_draw.c:84-95)  → the module singleton {@link dc}.
//     DEV (documented): a module-level singleton, mirroring C globals —
//     callers (M3-06 R_StoreWallRange/R_RenderSegLoop) ASSIGN fields then
//     call {@link drawColumn}, exactly like r_segs.c sets dc_x/dc_yl/...
//     then calls colfunc(). Zero allocation per call (acceptance 4); if a
//     re-entrant/masked pass ever needs it, the fields can be saved+restored
//     field-by-field like a vanilla do-while would.
//     `dc.colormap` collapses vanilla's `lighttable_t* dc_colormap` pointer
//     to a BYTE OFFSET into LightTables.colormaps (M3-01 row-offset policy —
//     scalelight entries are already `level*256` offsets).
//     `dc.source` defaults to a shared zero column instead of C's wild
//     pointer, so drawColumn needs no per-call null guard.
//   R_DrawColumn (r_draw.c:105-149), verbatim semantics:
//     count = dc_yh - dc_yl; if (count < 0) return;   // "Zero length,
//       column does not exceed a pixel." — and the do/while(count--) below
//       draws count+1 = yh-yl+1 px, rows yl..yh INCLUSIVE (yh==yl ⇒ 1 px).
//     fracstep = dc_iscale;
//     frac = dc_texturemid + (dc_yl-centery)*fracstep;  // PLAIN int mult —
//       NOT FixedMul: no >>FRACBITS. (yl-centery) is a small int, fracstep
//       is already fixed-point. In JS the exact double product reduced by
//       `|0` (≡ mod 2^32) matches gcc's wrapping int math bit-for-bit.
//     do {
//       *dest = dc_colormap[dc_source[(frac>>FRACBITS)&127]];
//       dest += SCREENWIDTH; frac += fracstep;
//     } while (count--);
//     `frac += fracstep` is wrapping int32 — `(frac + iscale)|0` is the
//     identical mod-2^32 reduction (dc_iscale kept u32 per G12 below; the
//     unsigned-vs-signed bit difference is a multiple of 2^32, invisible
//     under the mod).
//     The `&127` IS in the release source (r_draw.c:140) — it keeps the
//     source index in range on the 128-byte texture columns for NEGATIVE
//     frac (two's-complement AND ≡ non-negative mod 128).
//     OOB screen writes: RANGECHECK is compiled out of release builds and
//     the seg loop already clamps yl/yh to ceilingclip/floorclip; any
//     residual out-of-range index store is silently DROPPED by the typed
//     array (the same documented framebuffer.ts policy). x≥320 spills to
//     the next row exactly like vanilla's flat `dest` math — faithful, not
//     clipped.
//   G12 (M3-plan §3): dc_iscale = 0xffffffffu / (unsigned)rw_scale is
//     `Math.floor(0xffffffff/(scale>>>0))>>>0` — both operands are exact
//     doubles < 2^53; the division's round-off (≤ 2^-21/scale, ulp-bound)
//     is smaller than 1/scale = the minimum distance of 0xffffffff/scale
//     to an integer that 0xffffffff does not exactly hit ⇒ floor() is
//     always the true C quotient (BigInt-pinned in cols.test.ts). Divide-
//     by-zero is SIGFPE in C; scale is clamped [FRACUNIT/256? — no: 256,
//     64*FRACUNIT] by M3-06's R_StoreWallRange — here a raw RangeError.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACBITS } from '../core/constants';
import { RENDER_WIDTH } from './framebuffer';

/* ------------------------------------------------------------------ */
/* dc_* globals (r_draw.c:84-95)                                       */
/* ------------------------------------------------------------------ */

/** Shared placeholder for `dc.source` (see {@link Dc}); never drawn with in
 * practice — callers set a real column from getWallColumn (M3-02). */
const EMPTY_COLUMN = new Uint8Array(128);

/** One-to-one port of the r_draw.c dc_* global block. Field semantics:
 * r_segs.c R_StoreWallRange (M3-06 will fill them). */
export interface Dc {
  /** Screen column (r_draw.c `int dc_x`). */
  x: number;
  /** First/last row INCLUSIVE (`int dc_yl` / `int dc_yh`). */
  yl: number;
  yh: number;
  /** `fixed_t dc_iscale` — stored u32 (G12 result of the unsigned div;
   * C would sign-reinterpret ≥2^31 values, mod-2^32-equivalent here). */
  iscale: number;
  /** `fixed_t dc_texturemid` — texture u row at centery (fixed). */
  texturemid: number;
  /** `byte* dc_source` — one 128-row texture column (getWallColumn). */
  source: Uint8Array;
  /** `lighttable_t* dc_colormap` as a byte offset into the 34*256
   * LightTables.colormaps table (M3-01 policy; = level*256). */
  colormap: number;
}

/** The module singleton (vanilla-globals pattern; see file header). */
export const dc: Dc = {
  x: 0,
  yl: 0,
  yh: -1,
  iscale: 0,
  texturemid: 0,
  source: EMPTY_COLUMN,
  colormap: 0,
};

/* ------------------------------------------------------------------ */
/* dc_iscale = 0xffffffffu / (unsigned)scale   (r_segs.c:276, G12)     */
/* ------------------------------------------------------------------ */

/**
 * The exact unsigned integer quotient `floor(0xffffffff / scale)`,
 * returned u32. `scale` must be an integer in [1, 0xffffffff] — the
 * [256, 64*FRACUNIT] clamping lives with R_ScaleFromGlobalAngle in
 * M3-06, NOT here. RangeError stands in for vanilla's SIGFPE at 0.
 */
export function computeIscale(scale: number): number {
  if (!Number.isInteger(scale) || scale < 1 || scale > 0xffffffff) {
    throw new RangeError(`dc_iscale divisor ${scale} not an integer in [1, 0xffffffff]`);
  }
  return Math.floor(0xffffffff / scale) >>> 0;
}

/* ------------------------------------------------------------------ */
/* R_DrawColumn (r_draw.c:105-149)                                     */
/* ------------------------------------------------------------------ */

/**
 * Draws column `dc.x`, rows `dc.yl..dc.yh` inclusive, from
 * `dc.source[(dc_texturemid + (dc_yl-centery)*dc_iscale + n*dc_iscale)>>16
 * & 127]` through the colormap row at `dc.colormap`, into the framebuffer
 * index buffer. Zero allocation per call (acceptance 4): locals only, no
 * closures/objects/arrays; `dc` fields must be set by the caller first.
 *
 * @param indices   Framebuffer.indices (320 px rows, row-major).
 * @param colormaps LightTables.colormaps (34*256 bytes; dc.colormap is an
 *                  offset into it).
 * @param centery   view centre row (M3-04 `centery` = viewheight/2 = 100);
 *                  passed in — view config, not r_draw state.
 */
export function drawColumn(
  indices: Uint8Array,
  colormaps: Uint8Array,
  centery: number
): void {
  let count = dc.yh - dc.yl;
  // r_draw.c:112-115 — "Zero length, column does not exceed a pixel."
  if (count < 0) return;

  const x = dc.x;
  const src = dc.source;
  const cmap = dc.colormap;
  const iscale = dc.iscale;

  // frac = dc_texturemid + (dc_yl-centery)*dc_iscale — plain int math
  // (r_draw.c:131), wrapped to int32 exactly like gcc's signed overflow.
  let frac = (dc.texturemid + (dc.yl - centery) * iscale) | 0;

  let y = dc.yl;
  do {
    // *dest = dc_colormap[dc_source[(frac>>FRACBITS)&127]]  (r_draw.c:140)
    indices[y * RENDER_WIDTH + x] =
      colormaps[cmap + (src[(frac >> FRACBITS) & 127] as number)] as number;
    y++;
    frac = (frac + iscale) | 0;
  } while (count--);
}
