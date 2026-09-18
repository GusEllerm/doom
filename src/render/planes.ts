// render/planes.ts — visplane engine (M4-plan §M4-01; r_plane.c port).
//
// Vanilla mapping (linuxdoom-1.10 r_plane.c + r_local.h/r_defs.h):
//   MAXVISPLANES 128 (r_local.h) — vanilla `I_Error("R_FindPlane: no more
//     visplanes")`. PORT DEVIATION: live counter (counters.visplaneOverflow,
//     same API as drawsegOverflow) + typed {@link VisplaneOverflowError};
//     R_CheckPlane's SPLIT path has NO vanilla bounds check at all (it
//     writes lastvisplane++ straight into the static array — silent
//     corruption past slot 127); here it is counted + thrown identically.
//   visplane_t (r_defs.h:473-480) → struct-of-arrays: heights/pics/lights/
//     minx/maxx Int32Arrays + tops/bottoms Uint8Array(128*320) with 0xff =
//     "unset" (the C `memset(check->top,0xff,…)`). ONLY `top` is memset at
//     allocation — `bottom` is never cleared by vanilla (BSS-zero first
//     frame, STALE afterwards); the persistent Uint8Array reproduces that
//     byte-for-byte, including R_MakeSpans' reads of bottom[minx-1] /
//     bottom[maxx+1] outside the marked range.
//   R_ClearPlanes — floorclip[i]=viewheight / ceilingclip[i]=-1 (the same
//     Int16Arrays drawsegs.ts exposes — single source of truth), last-
//     visplane=0, cachedheight memset, basexscale/baseyscale from
//     (viewangle−ANG90)>>ANGLETOFINESHIFT (unit scale at SCREENWIDTH/2).
//     lastopening is drawsegs.ts's share of the clear (clearDrawsegs).
//   R_FindPlane — 3 args (NO scrolling-flat special in 1.10); sky collapse
//     `height=0, lightlevel=0` when picnum is the sky tag; linear merge
//     scan over creation order; new plane: minx=320, maxx=-1, top memset
//     0xff. DEVIATION (placeholder-safe): the sky test is guarded by
//     picnum >= 0 — until M4-02 wires real flat indices the BSP seam
//     passes picnum −1, which must NOT collapse into the sky plane.
//   R_CheckPlane — COPY-split (height/pic/light) into a new slot with
//     minx=start/maxx=stop + memset top; SOURCE PLANE NOT SHRUNKEN (the
//     union update happens only on the all-unset-intersection path). The
//     non-shrunk source keeps owning its old [minx,maxx] marks; the copy
//     re-marks its own range later — both planes draw, per-column last
//     (creation order) wins. Pinned in planes.test.ts.
//   R_MakeSpans — verbatim 4-loop span bookkeeping (spanstart is NOT
//     cleared per frame, matching the C static).
//   R_DrawPlanes — creation order; skip minx>maxx; sky branch per column
//     (dc_iscale = pspriteiscale>>detailshift = FRACUNIT, dc_colormap =
//     colormaps ⇒ offset 0 fullbright, dc_texturemid = skytexturemid =
//     100·FRACUNIT (R_InitSkyMap), angle = (viewangle+xtoviewangle[x]) >>
//     ANGLETOSKYSHIFT(22) ⇒ 1024 columns = full circle, r_sky.h + §0.3);
//     regular branch: planeheight=abs(height−viewz), light=clamp((light-
//     level>>LIGHTSEGSHIFT)+extralight,0,15), planezlight = zlight[light]
//     (M3-01 tables), sentinels top[maxx+1]/top[minx−1] = 0xff, MakeSpans
//     loop x=minx..maxx+1.
//   R_MapPlane — cachedheight/distance/xstep/ystep per y; FixedMul math
//     verbatim; `ds_yfrac = -viewy − FixedMul(finesine[angle], length)`
//     (the −viewy sign quirk is REAL, keep it); zindex = distance>>
//     LIGHTZSHIFT clamped MAXLIGHTZ−1; fixedcolormap read-through.
//   R_DrawSpan (r_draw.c:520-563, the ACTIVE fixed-point version — the
//     position/step packed variant is `#if 0` UNUSED) inlined: spot =
//     ((yfrac>>(16−6))&(63·64)) + ((xfrac>>16)&63), row-major 64·64 tile —
//     matches wad/flat.ts decodeFlat exactly (§0.5).
//
// OOB policy (documented): the C struct's pad1..pad4 absorb top[minx−1]/
// top[maxx+1] writes at the screen edges; SoA has no pads, so out-of-range
// sentinel WRITES are SKIPPED and out-of-range sentinel READS read 0xff
// (top) / 0 (bottom) — vanilla's pad contents are uninitialised garbage
// anyway; the 0xff choice makes edge spans close deterministically.
//
// Seam status (M4-01): per-column MARKS still live in segs.ts' flat scratch
// (markCeilingTop/…); M4-04 rewires R_RenderSegLoop to {@link checkPlane}+
// {@link markColumn} on the live {@link getFloorplane}/{@link getCeiling-
// plane} handles. {@link drawPlanes}'s sky column provider + flat provider
// are injected (rdata wiring lands with M4-02/M4-04).
//
// Zone discipline (eslint doom/zones/render): core + render imports only.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG90, ANGLETOFINESHIFT, FRACUNIT } from '../core/constants';
import { FixedDiv, FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import { dc, drawColumn } from './cols';
import { ceilingclip, floorclip } from './drawsegs';
import {
  COLORMAP_STRIDE,
  LIGHTLEVELS,
  LIGHTSEGSHIFT,
  LIGHTZSHIFT,
  MAXLIGHTZ,
  type LightTables,
} from './lights';
import { noteVisplaneOverflow } from './solidsegs';
import {
  CENTERXFRAC,
  CENTERY,
  VIEWHEIGHT,
  VIEWWIDTH,
  initTextureMapping,
  type TextureMapping,
  type ViewState,
} from './view';

/* ------------------------------------------------------------------ */
/* Constants + typed overflow                                          */
/* ------------------------------------------------------------------ */

/** r_local.h: `#define MAXVISPLANES 128`. */
export const MAXVISPLANES = 128;

/** r_sky.h: `#define ANGLETOSKYSHIFT 22` (2^32 >> 22 = 1024 columns). */
export const ANGLETOSKYSHIFT = 22;

/** r_data.c R_InitSkyMap: `skytexturemid = 100*FRACUNIT` (one line). */
export const SKYTEXTUREMID = 100 * FRACUNIT;

/** Sentinel picnum = "no flat index yet" (rdata flatNum stub, M4-02). */
export const NO_FLAT = -1;

/** Thrown when the visplane table is full (vanilla I_Error, §0.2). The
 * live counter (getRenderCounters().visplaneOverflow) is bumped FIRST. */
export class VisplaneOverflowError extends Error {
  constructor(at: number) {
    super(`R_FindPlane: no more visplanes (${at})`);
    this.name = 'VisplaneOverflowError';
  }
}

/* ------------------------------------------------------------------ */
/* visplanes (SoA) + the floor/ceilingplane globals                    */
/* ------------------------------------------------------------------ */

const heights = new Int32Array(MAXVISPLANES);
const pics = new Int32Array(MAXVISPLANES);
const lights = new Int32Array(MAXVISPLANES);
const minxs = new Int32Array(MAXVISPLANES);
const maxxs = new Int32Array(MAXVISPLANES);
/** `short visplane_t::top/bottom [SCREENWIDTH]` — 0xff = unset. bottom is
 * NEVER cleared (vanilla BSS/stale semantics), zero-initialised at boot. */
const tops = new Uint8Array(MAXVISPLANES * VIEWWIDTH);
const bottoms = new Uint8Array(MAXVISPLANES * VIEWWIDTH);

let visplaneCount = 0; // lastvisplane − visplanes

/** Opaque index handle (vanilla visplane_t*); pooled objects, zero alloc. */
export interface Visplane {
  readonly idx: number;
}

const handlePool: Visplane[] = [];

function handle(i: number): Visplane {
  let h = handlePool[i];
  if (h === undefined) {
    h = { idx: i };
    handlePool[i] = h;
  }
  return h;
}

let floorplane: Visplane | null = null;
let ceilingplane: Visplane | null = null;

export function getFloorplane(): Visplane | null {
  return floorplane;
}
export function getCeilingplane(): Visplane | null {
  return ceilingplane;
}
export function setFloorplane(pl: Visplane | null): void {
  floorplane = pl;
}
export function setCeilingplane(pl: Visplane | null): void {
  ceilingplane = pl;
}

/** r_sky.h/g_game.c: `skyflatnum = R_FlatNumForName("F_SKY1")` — a TAG
 * only (M4-02 wires the real index; default −1 never matches, see the
 * picnum>=0 guard in findPlane's collapse test). */
let skyflatnum = NO_FLAT;
export function getSkyflatnum(): number {
  return skyflatnum;
}
export function setSkyflatnum(n: number): void {
  skyflatnum = n;
}

/** Vanilla `picnum == skyflatnum` with the placeholder guard of the file
 * header: a NO_FLAT (−1) picnum is NEVER sky, and an unwired (−1) skyflat-
 * num matches nothing. Identical to vanilla once M4-02 wires real flat
 * indices (all ≥ 0). */
export function isSkyPic(picnum: number): boolean {
  return picnum >= 0 && picnum === skyflatnum;
}

/** Live plane count (lastvisplane − visplanes). */
export function planeCount(): number {
  return visplaneCount;
}

/** Handle for slot i (< planeCount()). */
export function planeAt(i: number): Visplane {
  return handle(i);
}

export function planeHeight(pl: Visplane): number {
  return heights[pl.idx]!;
}
export function planePic(pl: Visplane): number {
  return pics[pl.idx]!;
}
export function planeLight(pl: Visplane): number {
  return lights[pl.idx]!;
}
export function planeMinx(pl: Visplane): number {
  return minxs[pl.idx]!;
}
export function planeMaxx(pl: Visplane): number {
  return maxxs[pl.idx]!;
}
export function planeTop(pl: Visplane, x: number): number {
  return tops[pl.idx * VIEWWIDTH + x]!;
}
export function planeBottom(pl: Visplane, x: number): number {
  return bottoms[pl.idx * VIEWWIDTH + x]!;
}

/** The R_RenderSegLoop mark write (`ceilingplane->top[rw_x] = yl; …bottom
 * [rw_x] = yh;`, r_segs.c:200-228) — M4-04 rewires segs.ts to this. */
export function markColumn(pl: Visplane, x: number, top: number, bottom: number): void {
  const b = pl.idx * VIEWWIDTH + x;
  tops[b] = top;
  bottoms[b] = bottom;
}

/* ------------------------------------------------------------------ */
/* R_ClearPlanes                                                       */
/* ------------------------------------------------------------------ */

// texture mapping globals (r_plane.c:381-394)
let basexscale = 0;
let baseyscale = 0;
const cachedheight = new Int32Array(VIEWHEIGHT);
const cacheddistance = new Int32Array(VIEWHEIGHT);
const cachedxstep = new Int32Array(VIEWHEIGHT);
const cachedystep = new Int32Array(VIEWHEIGHT);

/** R_ClearPlanes (r_plane.c:206-235) — beginning of frame. `view` supplies
 * viewangle for the base scales. Zero alloc (fills + arithmetic only). */
export function clearPlanes(view: ViewState): void {
  for (let i = 0; i < VIEWWIDTH; i += 1) {
    floorclip[i] = VIEWHEIGHT;
    ceilingclip[i] = -1;
  }

  visplaneCount = 0; // lastvisplane = visplanes
  floorplane = null; // (NULL until R_Subsector opens them)
  ceilingplane = null;

  cachedheight.fill(0); // memset(cachedheight, 0, sizeof)

  // angle = (viewangle − ANG90) >> ANGLETOFINESHIFT; unit scale at
  // SCREENWIDTH/2 distance.
  const angle = ((view.viewangle - ANG90) >>> 0) >>> ANGLETOFINESHIFT;
  basexscale = FixedDiv(finecosine[angle]!, CENTERXFRAC);
  baseyscale = -FixedDiv(finesine[angle]!, CENTERXFRAC);
}

/* ------------------------------------------------------------------ */
/* R_FindPlane / R_CheckPlane                                          */
/* ------------------------------------------------------------------ */

/** R_FindPlane (r_plane.c:241-285). Merge on (height,pic,light) with sky
 * collapse; MAXVISPLANES → counter + typed throw (deviation, header). */
export function findPlane(height: number, picnum: number, lightlevel: number): Visplane {
  if (isSkyPic(picnum)) {
    height = 0; // all skys map together
    lightlevel = 0;
  }

  for (let i = 0; i < visplaneCount; i += 1) {
    if (height === heights[i] && picnum === pics[i] && lightlevel === lights[i]) {
      return handle(i);
    }
  }

  if (visplaneCount === MAXVISPLANES) {
    noteVisplaneOverflow();
    throw new VisplaneOverflowError(MAXVISPLANES);
  }

  const p = visplaneCount++;
  heights[p] = height;
  pics[p] = picnum;
  lights[p] = lightlevel;
  minxs[p] = VIEWWIDTH; // SCREENWIDTH
  maxxs[p] = -1;
  tops.fill(0xff, p * VIEWWIDTH, (p + 1) * VIEWWIDTH);
  return handle(p);
}

/** R_CheckPlane (r_plane.c:291-352) — extend `pl` to [start,stop] or
 * COPY-split a new plane. SOURCE NOT SHRUNKEN (header/pinned). Returns the
 * plane to mark going forward. */
export function checkPlane(pl: Visplane, start: number, stop: number): Visplane {
  const i = pl.idx;
  let intrl: number;
  let unionl: number;
  if (start < minxs[i]!) {
    intrl = minxs[i]!;
    unionl = start;
  } else {
    unionl = minxs[i]!;
    intrl = start;
  }

  let intrh: number;
  let unionh: number;
  if (stop > maxxs[i]!) {
    intrh = maxxs[i]!;
    unionh = stop;
  } else {
    unionh = maxxs[i]!;
    intrh = stop;
  }

  const base = i * VIEWWIDTH;
  let x = intrl;
  for (; x <= intrh; x += 1) {
    if (tops[base + x] !== 0xff) break;
  }

  if (x > intrh) {
    // no marks in the intersection — use the same one, widen.
    minxs[i] = unionl;
    maxxs[i] = unionh;
    return pl;
  }

  // make a new visplane (COPY — pl keeps its range and marks).
  if (visplaneCount === MAXVISPLANES) {
    noteVisplaneOverflow();
    throw new VisplaneOverflowError(MAXVISPLANES);
  }
  const n = visplaneCount++;
  heights[n] = heights[i]!;
  pics[n] = pics[i]!;
  lights[n] = lights[i]!;
  minxs[n] = start;
  maxxs[n] = stop;
  tops.fill(0xff, n * VIEWWIDTH, (n + 1) * VIEWWIDTH);
  return handle(n);
}

/* ------------------------------------------------------------------ */
/* ds_* span globals + R_MapPlane/R_DrawSpan (r_draw.c:500-563)        */
/* ------------------------------------------------------------------ */

const EMPTY_FLAT = new Uint8Array(4096);

// current regular-plane state (vanilla: set per plane in R_DrawPlanes).
let curFlat: Uint8Array = EMPTY_FLAT; // ds_source
let curPlaneheight = 0; // planeheight (fixed, abs)
let curZrow = 0; // planezlight = zlight[light] row offset
let curView: ViewState | null = null;
let curIndices: Uint8Array | null = null;
let curColormaps: Uint8Array = EMPTY_FLAT; // colormaps (34*256)
let curTables: LightTables | null = null;
let curMap: TextureMapping | null = null;
// test-introspection seam (null in production; set from PlaneDrawCtx):
let curEmit: ((pl: number, y: number, x1: number, x2: number) => void) | null = null;
let curEmitPl = -1;

/** R_MapPlane (r_plane.c:101-186) — the BASIC PRIMITIVE. Uses the current
 * regular-plane state set up by {@link drawPlanes}; per-y distance/step
 * caching verbatim (recompute iff planeheight != cachedheight[y]). */
function mapPlane(y: number, x1: number, x2: number): void {
  const view = curView!;
  const mapping = curMap!;

  let distance: number;
  if (curPlaneheight !== cachedheight[y]!) {
    cachedheight[y] = curPlaneheight;
    distance = cacheddistance[y] = FixedMul(curPlaneheight, mapping.yslope[y]!);
    cachedxstep[y] = FixedMul(distance, basexscale);
    cachedystep[y] = FixedMul(distance, baseyscale);
  } else {
    distance = cacheddistance[y]!;
  }
  const xstep = cachedxstep[y]!;
  const ystep = cachedystep[y]!;

  const length = FixedMul(distance, mapping.distscale[x1]!);
  // angle = (viewangle + xtoviewangle[x1]) >> ANGLETOFINESHIFT (u32 wrap).
  const angle = ((view.viewangle + mapping.xtoviewangle[x1]!) >>> 0) >>> ANGLETOFINESHIFT;
  const xfrac = (view.viewx + FixedMul(finecosine[angle]!, length)) | 0;
  const yfrac = ((-view.viewy | 0) - FixedMul(finesine[angle]!, length)) | 0; // −viewy quirk

  let colormap: number;
  if (view.fixedcolormap >= 0) {
    // fixedcolormap row index → byte offset (segs.ts:302 representation).
    colormap = view.fixedcolormap * COLORMAP_STRIDE;
  } else {
    let index = distance >> LIGHTZSHIFT;
    if (index >= MAXLIGHTZ) index = MAXLIGHTZ - 1;
    colormap = curTables!.zlight[curZrow + index]!;
  }

  if (curEmit !== null) curEmit(curEmitPl, y, x1, x2);

  // --- R_DrawSpan inline (r_draw.c:520-563; the `#if 0` variant unused) ---
  const indices = curIndices!;
  const colormaps = curColormaps;
  const src = curFlat;
  const row = y * VIEWWIDTH;
  let xf = xfrac;
  let yf = yfrac;
  let dest = x1;
  let count = x2 - x1;
  do {
    // Current texture index in u,v (row-major 64·64, wad/flat.ts parity).
    const spot = ((yf >> (16 - 6)) & (63 * 64)) + ((xf >> 16) & 63);
    // Lookup pixel from flat texture tile, re-index using light/colormap.
    const px = src[spot];
    if (px !== undefined) indices[row + dest] = colormaps[colormap + px]!;
    xf = (xf + xstep) | 0;
    yf = (yf + ystep) | 0;
    dest += 1;
  } while (count-- > 0);
}

/** R_MakeSpans (r_plane.c:358-386) verbatim. Exported for the exactly-
 * once acceptance probe with an explicit `emit`; drawPlanes uses its
 * bound default (emit = R_MapPlane on the current plane). */
export function makeSpans(
  x: number,
  t1: number,
  b1: number,
  t2: number,
  b2: number,
  emit?: (y: number, x1: number, x2: number) => void
): void {
  const draw = emit ?? ((y: number, sx1: number, sx2: number): void => mapPlane(y, sx1, sx2));
  while (t1 < t2 && t1 <= b1) {
    draw(t1, spanstart[t1]!, x - 1);
    t1 += 1;
  }
  while (b1 > b2 && b1 >= t1) {
    draw(b1, spanstart[b1]!, x - 1);
    b1 -= 1;
  }
  while (t2 < t1 && t2 <= b2) {
    spanstart[t2] = x;
    t2 += 1;
  }
  while (b2 > b1 && b2 >= t2) {
    spanstart[b2] = x;
    b2 -= 1;
  }
}

/** spanstart (r_plane.c:369 — NOT cleared per frame, C static parity). */
const spanstart = new Int32Array(VIEWHEIGHT);

/* ------------------------------------------------------------------ */
/* R_DrawPlanes                                                        */
/* ------------------------------------------------------------------ */

/** One frame's plane pass. `getFlat` resolves a plane's picnum to a
 * row-major 4096-byte flat (M4-02 rdata.getFlatPixels; −1/unresolved ⇒
 * silent zero flat — deterministic placeholder, never drawn in goldens).
 * `getSkyColumn` resolves one of the 1024 sky-texture columns (M4-02
 * rdata.getSkyColumn); omitted ⇒ sky planes contribute no pixels (M4-04
 * wires it). `onMapPlane` is a test-introspection seam (zero cost null). */
export interface PlaneDrawCtx {
  readonly view: ViewState;
  readonly indices: Uint8Array; // Framebuffer.indices
  readonly tables: LightTables; // zlight + colormaps
  readonly getFlat: (picnum: number) => Uint8Array | undefined;
  readonly getSkyColumn?: (angle1024: number) => Uint8Array;
  readonly onMapPlane?: (pl: number, y: number, x1: number, x2: number) => void;
}

/** R_DrawPlanes (r_plane.c:435-528), creation order — nearer planes were
 * opened first by the front-to-back BSP walk and LATER planes paint over
 * earlier ones per column/pixel (the ceiling-marked-atop-floor winner). */
export function drawPlanes(ctx: PlaneDrawCtx): void {
  const mapping = initTextureMapping();
  curView = ctx.view;
  curIndices = ctx.indices;
  curColormaps = ctx.tables.colormaps;
  curTables = ctx.tables;
  curMap = mapping;
  curEmit = ctx.onMapPlane ? (pl, y, x1, x2) => ctx.onMapPlane!(pl, y, x1, x2) : null;

  for (let i = 0; i < visplaneCount; i += 1) {
    if (minxs[i]! > maxxs[i]!) continue;

    curEmitPl = i;

    // --- sky flat (§0.3: textured visplane, not a flat draw) ---
    if (isSkyPic(pics[i]!)) {
      const getSky = ctx.getSkyColumn;
      if (getSky === undefined) continue; // pre-M4-02 wiring
      dc.iscale = mapping.pspriteiscale >> 0; // >>detailshift, detail=0
      // Sky is always drawn full bright (colormaps[0]) — INVUL-immune.
      dc.colormap = 0;
      dc.texturemid = SKYTEXTUREMID;
      const b = i * VIEWWIDTH;
      for (let x = minxs[i]!; x <= maxxs[i]!; x += 1) {
        dc.yl = tops[b + x]!;
        dc.yh = bottoms[b + x]!;
        if (dc.yl <= dc.yh) {
          const angle = ((ctx.view.viewangle + mapping.xtoviewangle[x]!) >>> 0) >>> ANGLETOSKYSHIFT;
          dc.x = x;
          dc.source = getSky(angle & 1023);
          drawColumn(ctx.indices, ctx.tables.colormaps, CENTERY);
        }
      }
      continue;
    }

    // --- regular flat ---
    curFlat = ctx.getFlat(pics[i]!) ?? EMPTY_FLAT;
    curPlaneheight = Math.abs(heights[i]! - ctx.view.viewz);

    let light = (lights[i]! >> LIGHTSEGSHIFT) + ctx.view.extralight;
    if (light >= LIGHTLEVELS) light = LIGHTLEVELS - 1;
    if (light < 0) light = 0;
    curZrow = light * MAXLIGHTZ;

    const b = i * VIEWWIDTH;
    // pl->top[maxx+1] = 0xff; pl->top[minx−1] = 0xff; (pads omitted —
    // out-of-screen sentinel writes skipped, header note).
    if (maxxs[i]! + 1 < VIEWWIDTH) tops[b + maxxs[i]! + 1] = 0xff;
    if (minxs[i]! - 1 >= 0) tops[b + minxs[i]! - 1] = 0xff;

    const stop = maxxs[i]! + 1;
    for (let x = minxs[i]!; x <= stop; x += 1) {
      makeSpans(
        x,
        markAt(tops, b, x - 1, 0xff),
        markAt(bottoms, b, x - 1, 0),
        markAt(tops, b, x, 0xff),
        markAt(bottoms, b, x, 0)
      );
    }
  }

  curEmit = null;
  curEmitPl = -1;
}

/** Sentinel-safe mark read: index outside 0..319 reads the unset value
 * (top 0xff / bottom 0) — header OOB policy. */
function markAt(arr: Uint8Array, base: number, x: number, unset: number): number {
  return x >= 0 && x < VIEWWIDTH ? arr[base + x]! : unset;
}

/* ------------------------------------------------------------------ */
/* Debug/test introspection                                            */
/* ------------------------------------------------------------------ */

/** Live plane-math globals (R_MapPlane cache + base scales) for golden
 * tests; returns the live typed arrays (no copy). */
export function planesDebugState(): {
  readonly basexscale: number;
  readonly baseyscale: number;
  readonly cachedheight: Int32Array;
  readonly cacheddistance: Int32Array;
  readonly cachedxstep: Int32Array;
  readonly cachedystep: Int32Array;
  readonly spanstart: Int32Array;
} {
  return {
    get basexscale() {
      return basexscale;
    },
    get baseyscale() {
      return baseyscale;
    },
    cachedheight,
    cacheddistance,
    cachedxstep,
    cachedystep,
    spanstart,
  };
}

/** Zero ALL visplane state including cross-frame residue (bottoms, span-
 * start, caches) — test isolation helper; production never calls it
 * (vanilla keeps the residue). */
export function resetPlanesForTests(): void {
  visplaneCount = 0;
  floorplane = null;
  ceilingplane = null;
  skyflatnum = NO_FLAT;
  heights.fill(0);
  pics.fill(0);
  lights.fill(0);
  minxs.fill(0);
  maxxs.fill(0);
  tops.fill(0);
  bottoms.fill(0);
  cachedheight.fill(0);
  cacheddistance.fill(0);
  cachedxstep.fill(0);
  cachedystep.fill(0);
  spanstart.fill(0);
  basexscale = 0;
  baseyscale = 0;
}
