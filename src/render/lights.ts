// render/lights.ts — light LUTs (M3-01): R_InitLightTables + the
// R_ExecuteSetViewSize scalelight rebuild (r_main.c:614-642, 744-759) plus the
// R_StoreWallRange pancake lightnum adjust (r_segs.c:122-134). R03 §10, R02 §4.
//
// Table representation: vanilla `lighttable_t*` are byte POINTERS into the
// `colormaps` blob; we store the row byte-OFFSET (`level * 256`) in
// Uint32Arrays, so a consumer hits `colormaps[tables.zlight[i*MAXLIGHTZ + j] + pixel]`.
//
// `colormaps` source-of-truth (R_InitColormaps — it lives in r_data.c:631-643,
// NOT r_main.c): the COLORMAP lump (34 rows x 256 = 8704 B) is malloc'd
// lump-length+255 and read VERBATIM at a 256-aligned pointer. There is NO
// "32 replicated rows" build step — colormaps IS the 34-row lump: rows 0..31
// light levels, row 32 = INVERSECOLORMAP (invulnerability, p_user.c:41),
// row 33 unreferenced padding (R02 §3). We therefore pass the caller's
// 34*256 rows straight through (identity, like the C pointer) instead of the
// brief's "32*256" — the extra 2 rows cost nothing and keep `fixedcolormap`
// (R_SetupFrame: colormaps + player->fixedcolormap*256, r_main.c:849-851)
// addressable in M4/M5.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FixedDiv, FRACUNIT } from '../core/fixed';
import { COLORMAP_BYTES, NUM_COLORMAP_ROWS } from '../wad/palettes';
import { RENDER_WIDTH } from './framebuffer';

// --- Constants (r_main.h:69-75, r_main.h:84, r_main.c:612) ------------------

/** r_main.h:69 — number of lightnum buckets (sector lightlevel>>4 + extralight). */
export const LIGHTLEVELS = 16;
/** r_main.h:70 — lightlevel >> n to bucket (16 sector-lightlevels per bucket). */
export const LIGHTSEGSHIFT = 4;
/** r_main.h:72 — columns in a scalelight row (rw_scale>>12 index cap). */
export const MAXLIGHTSCALE = 48;
/** r_main.h:73 — wall/sprite projected-scale bucket shift. */
export const LIGHTSCALESHIFT = 12;
/** r_main.h:74 — columns in a zlight row (flat distance index cap). */
export const MAXLIGHTZ = 128;
/** r_main.h:75 — flat distance bucket shift (distance>>20). */
export const LIGHTZSHIFT = 20;
/** r_main.h:84 — light rows in `colormaps` addressable by the tables (clamps). */
export const NUMCOLORMAPS = 32;
/** r_main.c:612 — distance→darkness divisor in both table chains. */
export const DISTMAP = 2;
/** COLORMAP lump rows carried in `colormaps` (0..31 light, 32 inverse, 33 pad). */
export const COLORMAP_ROWS = NUM_COLORMAP_ROWS;
/** Bytes per colormap row (one `lighttable_t` remap). */
export const COLORMAP_STRIDE = 256;

/**
 * Vanilla `colormaps` + the three pointer tables, as byte offsets into
 * `colormaps`. zlight/scalelight are row-major [LIGHTLEVELS][MAX*].
 */
export interface LightTables {
  /** The 34*256 COLORMAP rows (identity pass-through — see header). */
  colormaps: Uint8Array;
  /** r_main.c zlight[LIGHTLEVELS][MAXLIGHTZ] — flats (consumed by M4 planes). */
  zlight: Uint32Array; // LIGHTLEVELS * MAXLIGHTZ
  /** r_main.c scalelight[LIGHTLEVELS][MAXLIGHTSCALE] — walls + sprites. */
  scalelight: Uint32Array; // LIGHTLEVELS * MAXLIGHTSCALE
  /**
   * r_main.c scalelightfixed[MAXLIGHTSCALE] (r_main.c:117) — NOT filled by
   * R_InitLightTables/R_ExecuteSetViewSize; R_SetupFrame overwrites ALL
   * entries with `fixedcolormap` when the player is invulnerable/pumped
   * (r_main.c:847-859). Vanilla leaves it uninitialized otherwise (garbage
   * never read while fixedcolormap == 0); we zero it for determinism
   * (documented deviation — no vanilla-visible behavior change).
   */
  scalelightfixed: Uint32Array;
}

/** R_InitLightTables z-chain, verbatim (r_main.c:614-642). Static — view-size independent. */
function initZlight(): Uint32Array {
  const z = new Uint32Array(LIGHTLEVELS * MAXLIGHTZ);
  for (let i = 0; i < LIGHTLEVELS; i++) {
    // r_main.c:626 — integer chain, left-assoc: ((15-i)*2)*32/16 = (15-i)*4.
    const startmap = (((LIGHTLEVELS - 1 - i) * 2) * NUMCOLORMAPS) / LIGHTLEVELS;
    for (let j = 0; j < MAXLIGHTZ; j++) {
      // r_main.c:629-630: FixedDiv((SCREENWIDTH/2*FRACUNIT), (j+1)<<LIGHTZSHIFT)
      // then scale >>= LIGHTSCALESHIFT. core/fixed FixedDiv IS the vanilla
      // m_fixed.c FixedDiv2 (saturating guard + trunc(a/b*FRACUNIT)) — no
      // float shortcut; guard never fires for these inputs (verified:
      // abs(a)>>14 = 640 < abs(b) for all j).
      let scale = FixedDiv((RENDER_WIDTH / 2) * FRACUNIT, (j + 1) << LIGHTZSHIFT);
      scale >>= LIGHTSCALESHIFT; // scale >= 0 here → arithmetic shift = floor
      // r_main.c:631: `scale / DISTMAP` — C integer division on non-negative.
      let level = startmap - Math.floor(scale / DISTMAP);
      // r_main.c:633-638 clamp.
      if (level < 0) level = 0;
      if (level >= NUMCOLORMAPS) level = NUMCOLORMAPS - 1;
      z[i * MAXLIGHTZ + j] = level * COLORMAP_STRIDE;
    }
  }
  return z;
}

/**
 * The scalelight block of R_ExecuteSetViewSize (r_main.c:744-759), rebuilt
 * in place. We fix detailshift = 0 (full-res renderer) and take `viewwidth`
 * as a parameter; the game currently always passes the full RENDER_WIDTH.
 */
export function executeSetViewSize(tables: LightTables, viewwidth: number): LightTables {
  if (!Number.isInteger(viewwidth) || viewwidth <= 0) {
    throw new RangeError(`viewwidth ${viewwidth} must be a positive integer`);
  }
  for (let i = 0; i < LIGHTLEVELS; i++) {
    const startmap = (((LIGHTLEVELS - 1 - i) * 2) * NUMCOLORMAPS) / LIGHTLEVELS;
    for (let j = 0; j < MAXLIGHTSCALE; j++) {
      // r_main.c:750 — `j*SCREENWIDTH/(viewwidth<<detailshift)/DISTMAP`, left-
      // assoc C integer divisions, each truncating. detailshift fixed 0.
      const step = Math.floor(Math.floor((j * RENDER_WIDTH) / viewwidth) / DISTMAP);
      let level = startmap - step;
      if (level < 0) level = 0;
      if (level >= NUMCOLORMAPS) level = NUMCOLORMAPS - 1;
      tables.scalelight[i * MAXLIGHTSCALE + j] = level * COLORMAP_STRIDE;
    }
  }
  return tables;
}

/**
 * R_InitLightTables + first scalelight fill at the fixed full-res view.
 * `colormapRows` = 34*256 COLORMAP bytes (wad/palettes decodeColormap output).
 */
export function initLightTables(
  colormapRows: Uint8Array,
  viewwidth: number = RENDER_WIDTH
): LightTables {
  if (colormapRows.length !== COLORMAP_BYTES) {
    throw new RangeError(
      `colormapRows must be exactly ${COLORMAP_BYTES} bytes (34*256), got ${colormapRows.length}`
    );
  }
  const tables: LightTables = {
    colormaps: colormapRows, // vanilla identity: colormaps = the lump pointer
    zlight: initZlight(),
    scalelight: new Uint32Array(LIGHTLEVELS * MAXLIGHTSCALE),
    scalelightfixed: new Uint32Array(MAXLIGHTSCALE), // see LightTables note
  };
  return executeSetViewSize(tables, viewwidth);
}

/**
 * R_StoreWallRange lightnum selection (r_segs.c:122-134).
 * `lightnum` = bucket before clamp (tests the pancake ±1 raw); `row` is the
 * scalelight row vanilla would point `walllights` at (lightnum<0 → row 0,
 * lightnum>=LIGHTLEVELS → row 15, else lightnum).
 * Pancake truth: horizontal (v1.y == v2.y) −1, ELSE vertical (v1.x == v2.x)
 * +1 — the `else` means an axis-aligned-zero-length line takes the −1 branch.
 */
export function wallLightNum(
  sectorLight: number,
  extralight: number,
  v1x: number,
  v1y: number,
  v2x: number,
  v2y: number
): { lightnum: number; row: number } {
  let lightnum = (sectorLight >> LIGHTSEGSHIFT) + extralight;
  if (v1y === v2y) lightnum--;
  else if (v1x === v2x) lightnum++;
  const row = lightnum < 0 ? 0 : lightnum >= LIGHTLEVELS ? LIGHTLEVELS - 1 : lightnum;
  return { lightnum, row };
}
