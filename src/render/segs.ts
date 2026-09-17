// render/segs.ts — R_StoreWallRange + R_RenderSegLoop (M3-plan §M3-06;
// linuxdoom-1.10/r_segs.c v1.3) + the R_AddLine→R_StoreWallRange seam
// callbacks over the M3-03 fragment stream.
//
// Zone discipline (eslint doom/zones/render): imports core + render only.
//
// Vanilla mapping (r_segs.c, line refs from the id release):
//   module globals (r_segs.c:46-92)   → closure state of createSegCallbacks
//     (per-walk instance; dc/drawsegs/clips stay module singletons).
//   R_StoreWallRange (:378-743)       → {@link storeWallRange} (via addSolid/
//     addPass fragments of DEVIATION 3, solidsegs.ts: fragments replace the
//     inline R_StoreWallRange calls of R_ClipSolid/PassWallSegment — the
//     r_segs.c side never reads solidsegs, so deferred consumption is
//     equivalent; start>stop hom++/skip lives in solidsegs).
//   R_RenderSegLoop (:187-317)        → {@link renderSegLoop}, HEIGHTBITS 12.
//   R_ScaleFromGlobalAngle (r_main.c:453-503) → {@link scaleFromGlobalAngle};
//     detailshift fixed 0; scale clamp [256, 64*FRACUNIT] verbatim.
//   R_PointToDist (r_main.c:392-418)  → local pointToDist (DBITS 5 =
//     FRACBITS-SLOPEBITS, docs/research/03 §R_PointToDist).
//   texturetranslation identity (no TEXTURE1 translation in M3).
//   walllights = scalelight[lightnum] → lightrow via lights.wallLightNum
//     (pancake ±1 + clamp source truth); per-column bucket
//     index = rw_scale>>LIGHTSCALESHIFT clamped MAXLIGHTSCALE-1 (:271-276).
//     fixedcolormap: vanilla points walllights at scalelightfixed, which
//     R_SetupFrame fills entirely with fixedcolormap (r_main.c:847-859) —
//     reading scalelightfixed[i] ≡ fixedcolormap itself, so we use
//     view.fixedcolormap*COLORMAP_STRIDE directly (representation only).
//
// DEVIATIONS (all documented, faithful-value):
//  - G13: no ML_MAPPED write (sim-mutation ban, M3-plan §G13).
//  - skyflatnum: RenderWorld carries no flat indices (flats are M4), so the
//    "outdoor height-change hack" (r_segs.c:604-609) and the
//    `ceilingpic != skyflatnum` guard (:660-665) evaluate as never-sky —
//    markceiling simply drops when ceilingheight <= viewz.
//  - visplane marking: M3 has no visplanes (plan §3 D), so the
//    ceilingplane->top/bottom writes (:200-228) land in the flat scratch
//    column arrays {@link markCeilingTop}…{@link markFloorBottom} instead;
//    clip-array updates (ceilingclip/floorclip) are faithful. R_CheckPlane
//    not ported (no-op for one map).
//  - sidedef rowoffset: RenderWorld exposes only sideOffsetX (textureoffset);
//    rw_offset uses it faithfully (r_segs.c:635) and the texturemid
//    += rowoffset adds (:460, :546-547) reuse the same value — identical
//    whenever a sidedef's two offsets agree (all fixtures); rdata seam gap,
//    follow-up M3-06b/M4.
//  - masked middle detection: 1.10 keys on midtexture PRESENCE
//    (r_segs.c:640-646); we record whenever sideMidTex != NO_TEXTURE —
//    same set (presence), drawMasked stays a no-op stub (M4 draws).
//  - drawseg_t SoA + openings pool refs: see drawsegs.ts file header.
//  - seg frontsector: vanilla reads it off the seg (P_GroupLines ⇒ = the
//    subsector's sector for real segs); we use map.subsectors when the map
//    arg is given, else sideSector[segSide] (equal for all real segs;
//    minisegs only classify as solids through bsp.ts anyway).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG180, ANG90, FRACBITS, FRACUNIT, MAXINT } from '../core/constants';
import { angSub, FixedDiv, FixedMul, angAdd, angToFine } from '../core/fixed';
import { finesine, finetangent, tantoangle } from '../core/tables';
import {
  clipPassWallSegment,
  clipSolidWallSegment,
  fragStart,
  fragStop,
} from './solidsegs';
import {
  initTextureMapping,
  pointToAngle,
  PROJECTION,
  CENTERY,
  VIEWHEIGHT,
  type RenderMapView,
  type ViewState,
} from './view';
import { ML_TWOSIDED, NO_TEXTURE, type RenderWorld } from './rdata';
import { computeIscale, dc, drawColumn } from './cols';
import {
  COLORMAP_STRIDE,
  LIGHTSCALESHIFT,
  MAXLIGHTSCALE,
  initLightTables,
  wallLightNum,
  type LightTables,
} from './lights';
import type { Framebuffer } from './framebuffer';
import type { WalkCallbacks } from './bsp';
import {
  CLIP_NEGONE,
  CLIP_NULL,
  CLIP_SCREEN,
  MAXSHORT,
  SIL_BOTTOM,
  SIL_BOTH,
  SIL_TOP,
  allocOpenings,
  ceilingclip,
  drawsegAdd,
  floorclip,
  getDrawsegs,
  openingsSet,
  snapshotOpenings,
} from './drawsegs';

/* ------------------------------------------------------------------ */
/* Constants (r_segs.c / r_defs.h)                                     */
/* ------------------------------------------------------------------ */

/** r_segs.c:183-184 (`#define HEIGHTBITS 12`, HEIGHTUNIT 1<<12). */
const HEIGHTBITS = 12;
const HEIGHTUNIT = 1 << HEIGHTBITS;

/** r_defs.h lineDefBitEnum (map-format bits; ML_TWOSIDED shared w/ rdata). */
const ML_DONTPEGTOP = 0x0008;
const ML_DONTPEGBOTTOM = 0x0010;
export { ML_TWOSIDED };

/** m_fixed.h DBITS = FRACBITS - SLOPEBITS = 5 (research doc 03). */
const DBITS = 5;

const CENTERYFRAC = CENTERY * FRACUNIT; // centeryfrac (r_main.c, viewheight/2)

/** Default light tables when the caller has none: identity 34 rows. */
let defaultTables: LightTables | undefined;
function getDefaultTables(): LightTables {
  if (defaultTables === undefined) {
    const rows = new Uint8Array(34 * COLORMAP_STRIDE);
    for (let i = 0; i < rows.length; i++) rows[i] = i & 255;
    defaultTables = initLightTables(rows);
  }
  return defaultTables;
}

/* Visplane-marking scratch (header DEVIATION: replaces ceilingplane/
 * floorplane->top/bottom writes; M4 replaces with real visplanes). */
export const markCeilingTop = new Int32Array(320);
export const markCeilingBottom = new Int32Array(320);
export const markFloorTop = new Int32Array(320);
export const markFloorBottom = new Int32Array(320);

/* ------------------------------------------------------------------ */
/* createSegCallbacks                                                  */
/* ------------------------------------------------------------------ */

/**
 * The M3-06 wall-pass callbacks: `addSolid`/`addPass` feed the M3-03
 * fragment stream into storeWallRange → renderSegLoop (one drawseg + pixel
 * run per fragment, vanilla call order). `map` (optional) enables the exact
 * R_Subsector frontsector; `tables` defaults to an identity-colormap set —
 * M3-07's renderFrame passes the wad's.
 */
export function createSegCallbacks(
  fb: Framebuffer,
  world: RenderWorld,
  view: ViewState,
  map?: RenderMapView,
  tables: LightTables = getDefaultTables()
): WalkCallbacks {
  const ds = getDrawsegs(); // live view of the SoA (arrays never replaced)
  const { xtoviewangle } = initTextureMapping();
  const indices = fb.indices;
  const colormaps = tables.colormaps;

  /* r_segs.c module globals → closure state (file header). */
  let curSeg = -1;
  let rwAngle1 = 0; // angle_t
  let frontSec = -1;
  let backSec = -1;
  let line = -1;
  let side = -1;
  // segtextured/markfloor/markceiling/maskedtexture + toptexture etc.
  let segTextured = false;
  let markFloor = false;
  let markCeiling = false;
  let maskedTexture = false;
  let midTexture = NO_TEXTURE;
  let topTexture = NO_TEXTURE;
  let bottomTexture = NO_TEXTURE;
  let rwNormalAngle = 0;
  let rwX = 0;
  let rwStopX = 0;
  let rwCenterAngle = 0;
  let rwOffset = 0;
  let rwDistance = 0;
  let rwScale = 0;
  let rwScaleStep = 0;
  let rwMidTextureMid = 0;
  let rwTopTextureMid = 0;
  let rwBottomTextureMid = 0;
  let worldtop = 0;
  let worldbottom = 0;
  let worldhigh = 0;
  let worldlow = 0;
  let pixHigh = 0;
  let pixLow = 0;
  let pixHighStep = 0;
  let pixLowStep = 0;
  let topFrac = 0;
  let topStep = 0;
  let bottomFrac = 0;
  let bottomStep = 0;
  let lightRow = 0;
  let fixedCmap = -1; // ≥0 = dc.colormap offset when view.fixedcolormap set
  let maskedBase = -1; // openings base for maskedtexturecol

  // R_PointToDist (r_main.c:392-418); hyp of v1 from the eye.
  function pointToDist(x: number, y: number): number {
    let dx = Math.abs(x - view.viewx) | 0;
    let dy = Math.abs(y - view.viewy) | 0;
    if (dy > dx) {
      const t = dx;
      dx = dy;
      dy = t;
    }
    const angle = (tantoangle[FixedDiv(dy, dx) >> DBITS]! + ANG90) >>> 19;
    return FixedDiv(dx, finesine[angle]!);
  }

  /** vanilla textureheight[t] = height<<FRACBITS; rdata stores pixels
   * (deviation note in header); NO_TEXTURE (−1) → 0 like dummy texture 0. */
  function texHeightF(t: number): number {
    return t >= 0 ? world.texHeight[t]! << 16 : 0;
  }

  // R_ScaleFromGlobalAngle (r_main.c:453-503), rw_distance pre-set.
  function scaleFromGlobalAngle(visangle: number): number {
    const anglea = angAdd(ANG90, angSub(visangle, view.viewangle));
    const angleb = angAdd(ANG90, angSub(visangle, rwNormalAngle));
    const sinea = finesine[angToFine(anglea)]!;
    const sineb = finesine[angToFine(angleb)]!;
    const num = FixedMul(PROJECTION, sineb); // <<detailshift(0)
    const den = FixedMul(rwDistance, sinea);
    if (den > num >> 16) {
      let scale = FixedDiv(num, den);
      if (scale > 64 * FRACUNIT) scale = 64 * FRACUNIT;
      else if (scale < 256) scale = 256;
      return scale;
    }
    return 64 * FRACUNIT;
  }

  /** R_StoreWallRange (r_segs.c:378-743); [start, stop] inclusive. */
  function storeWallRange(start: number, stop: number): void {
    // ds_p == &drawsegs[MAXDRAWSEGS] silent return (:385-387).
    const di = drawsegAdd(curSeg);
    if (di < 0) return;

    const v1x = world.segV1x[curSeg]!;
    const v1y = world.segV1y[curSeg]!;
    const v2x = world.segV2x[curSeg]!;
    const v2y = world.segV2y[curSeg]!;
    const flags = line >= 0 ? world.lineFlags[line]! : 0;

    // rw_distance for the scale calc (:401-411). C abs() on the u32 diff ≡
    // min(d, -d) unsigned; both > ANG90 clamp paths identical.
    rwNormalAngle = angAdd(world.segAngle[curSeg]!, ANG90);
    let offsetAngle = angSub(rwNormalAngle, rwAngle1);
    if ((offsetAngle | 0) < 0) offsetAngle = (-(offsetAngle | 0)) >>> 0;
    if (offsetAngle > ANG90) offsetAngle = ANG90;
    const distangle = angSub(ANG90, offsetAngle);
    const hyp = pointToDist(v1x, v1y);
    rwDistance = FixedMul(hyp, finesine[angToFine(distangle)]!);

    ds.x1[di] = rwX = start;
    ds.x2[di] = stop;
    rwStopX = stop + 1;

    ds.scale1[di] = rwScale = scaleFromGlobalAngle(
      angAdd(view.viewangle, xtoviewangle[start]!)
    );
    if (stop > start) {
      ds.scale2[di] = scaleFromGlobalAngle(angAdd(view.viewangle, xtoviewangle[stop]!));
      rwScaleStep = (ds.scale2[di]! - rwScale) / (stop - start) | 0; // C trunc
      ds.scalestep[di] = rwScaleStep;
    } else {
      ds.scale2[di] = ds.scale1[di];
      rwScaleStep = 0; // vanilla leaves rw_scalestep STALE here; 0 = the
      // mathematically implied step of scale1==scale2 (deviation, unseen:
      // every consumer derives scale2 from the step or vice versa)
    }

    worldtop = world.sectorCeil[frontSec]! - view.viewz;
    worldbottom = world.sectorFloor[frontSec]! - view.viewz;

    midTexture = topTexture = bottomTexture = NO_TEXTURE;
    maskedTexture = false;
    maskedBase = -1;

    const rowOff = side >= 0 ? world.sideOffsetX[side]! : 0;
    if (backSec < 0) {
      // single sided line (:440-464)
      midTexture = side >= 0 ? world.sideMidTex[side]! : NO_TEXTURE;
      markFloor = markCeiling = true;
      rwMidTextureMid =
        flags & ML_DONTPEGBOTTOM
          ? (world.sectorFloor[frontSec]! + texHeightF(midTexture)) - view.viewz
          : worldtop;
      rwMidTextureMid += rowOff;
      ds.silhouette[di] = SIL_BOTH;
      ds.sprtopclip[di] = CLIP_SCREEN; // screenheightarray
      ds.sprbottomclip[di] = CLIP_NEGONE; // negonearray
      ds.bsilheight[di] = MAXINT;
      ds.tsilheight[di] = -MAXINT - 1;
    } else {
      // two sided line (:466-524)
      ds.silhouette[di] = 0;
      ds.sprtopclip[di] = CLIP_NULL;
      ds.sprbottomclip[di] = CLIP_NULL;
      if (world.sectorFloor[frontSec]! > world.sectorFloor[backSec]!) {
        ds.silhouette[di] = SIL_BOTTOM;
        ds.bsilheight[di] = world.sectorFloor[frontSec]!;
      } else if (world.sectorFloor[backSec]! > view.viewz) {
        ds.silhouette[di] = SIL_BOTTOM;
        ds.bsilheight[di] = MAXINT;
      }
      if (world.sectorCeil[frontSec]! < world.sectorCeil[backSec]!) {
        ds.silhouette[di] |= SIL_TOP;
        ds.tsilheight[di] = world.sectorCeil[frontSec]!;
      } else if (world.sectorCeil[backSec]! < view.viewz) {
        ds.silhouette[di] |= SIL_TOP;
        ds.tsilheight[di] = -MAXINT - 1;
      }
      if (world.sectorCeil[backSec]! <= world.sectorFloor[frontSec]!) {
        ds.sprbottomclip[di] = CLIP_NEGONE;
        ds.bsilheight[di] = MAXINT;
        ds.silhouette[di] |= SIL_BOTTOM;
      }
      if (world.sectorFloor[backSec]! >= world.sectorCeil[frontSec]!) {
        ds.sprtopclip[di] = CLIP_SCREEN;
        ds.tsilheight[di] = -MAXINT - 1;
        ds.silhouette[di] |= SIL_TOP;
      }

      worldhigh = world.sectorCeil[backSec]! - view.viewz;
      worldlow = world.sectorFloor[backSec]! - view.viewz;

      // sky hack (r_segs.c:604-609): never-sky (header DEVIATION).
      markFloor =
        worldlow !== worldbottom ||
        world.sectorLight[backSec] !== world.sectorLight[frontSec]; // flat cmp: −1 stubs ⇒ equal
      markCeiling =
        worldhigh !== worldtop || world.sectorLight[backSec] !== world.sectorLight[frontSec];

      if (
        world.sectorCeil[backSec]! <= world.sectorFloor[frontSec]! ||
        world.sectorFloor[backSec]! >= world.sectorCeil[frontSec]!
      ) {
        markCeiling = markFloor = true; // closed door
      }

      if (worldhigh < worldtop) {
        topTexture = side >= 0 ? world.sideTopTex[side]! : NO_TEXTURE;
        rwTopTextureMid =
          flags & ML_DONTPEGTOP
            ? worldtop
            : world.sectorCeil[backSec]! + texHeightF(topTexture) - view.viewz;
      }
      if (worldlow > worldbottom) {
        bottomTexture = side >= 0 ? world.sideBotTex[side]! : NO_TEXTURE;
        rwBottomTextureMid =
          flags & ML_DONTPEGBOTTOM ? worldtop : worldlow;
      }
      rwTopTextureMid += rowOff;
      rwBottomTextureMid += rowOff;

      // masked midtexture allocation (:640-646; presence, not transparency)
      if (side >= 0 && world.sideMidTex[side] !== NO_TEXTURE) {
        maskedTexture = true;
        const n = rwStopX - rwX;
        const base = allocOpenings(n);
        if (base >= 0) {
          maskedBase = base - rwX;
          ds.maskedcol[di] = maskedBase;
          for (let x = start; x <= stop; x++) openingsSet(base + x - start, MAXSHORT);
        }
      }
    }

    segTextured =
      midTexture >= 0 || topTexture >= 0 || bottomTexture >= 0 || maskedTexture;
    if (segTextured) {
      // rw_offset tangent sign rule (:626-648).
      let oa = angSub(rwNormalAngle, rwAngle1);
      if (oa > ANG180) oa = (0 - oa) >>> 0;
      if (oa > ANG90) oa = ANG90;
      rwOffset = FixedMul(hyp, finesine[angToFine(oa)]!);
      if (angSub(rwNormalAngle, rwAngle1) < ANG180) rwOffset = -rwOffset;
      rwOffset =
        (rwOffset + (side >= 0 ? world.sideOffsetX[side]! : 0) +
          (curSeg >= 0 ? world.segOffset[curSeg]! : 0)) | 0; // C fixed_t wrap
      rwCenterAngle = (ANG90 + view.viewangle - rwNormalAngle) >>> 0;

      fixedCmap = view.fixedcolormap >= 0 ? view.fixedcolormap * COLORMAP_STRIDE : -1;
      if (fixedCmap < 0) {
        lightRow = wallLightNum(
          world.sectorLight[frontSec]!,
          view.extralight,
          v1x,
          v1y,
          v2x,
          v2y
        ).row;
      }
    }

    // Planes on the wrong side of the view plane are invisible (:666-677).
    if (world.sectorFloor[frontSec]! >= view.viewz) markFloor = false;
    // `&& ceilingpic != skyflatnum` (r_segs.c:660-665) — never-sky, so the
    // disable fires unconditionally (header DEVIATION).
    if (world.sectorCeil[frontSec]! <= view.viewz) markCeiling = false;

    // Incremental stepping values (:680-703); R_CheckPlane skipped (M3).
    worldtop >>= 4;
    worldbottom >>= 4;

    topStep = -FixedMul(rwScaleStep, worldtop);
    topFrac = (CENTERYFRAC >> 4) - FixedMul(worldtop, rwScale);
    bottomStep = -FixedMul(rwScaleStep, worldbottom);
    bottomFrac = (CENTERYFRAC >> 4) - FixedMul(worldbottom, rwScale);

    if (backSec >= 0) {
      worldhigh >>= 4;
      worldlow >>= 4;
      if (worldhigh < worldtop) {
        pixHigh = (CENTERYFRAC >> 4) - FixedMul(worldhigh, rwScale);
        pixHighStep = -FixedMul(rwScaleStep, worldhigh);
      }
      if (worldlow > worldbottom) {
        pixLow = (CENTERYFRAC >> 4) - FixedMul(worldlow, rwScale);
        pixLowStep = -FixedMul(rwScaleStep, worldlow);
      }
    }

    renderSegLoop();

    // Save sprite clipping info (:716-739).
    const n = rwStopX - start;
    if ((ds.silhouette[di]! & SIL_TOP) !== 0 || maskedTexture) {
      if (ds.sprtopclip[di] === CLIP_NULL) {
        const ref = snapshotOpenings(ceilingclip, start, n);
        if (ref >= 0) ds.sprtopclip[di] = ref;
      }
    }
    if ((ds.silhouette[di]! & SIL_BOTTOM) !== 0 || maskedTexture) {
      if (ds.sprbottomclip[di] === CLIP_NULL) {
        const ref = snapshotOpenings(floorclip, start, n);
        if (ref >= 0) ds.sprbottomclip[di] = ref;
      }
    }
    if (maskedTexture && (ds.silhouette[di]! & SIL_TOP) === 0) {
      ds.silhouette[di] |= SIL_TOP;
      ds.tsilheight[di] = -MAXINT - 1;
    }
    if (maskedTexture && (ds.silhouette[di]! & SIL_BOTTOM) === 0) {
      ds.silhouette[di] |= SIL_BOTTOM;
      ds.bsilheight[di] = MAXINT;
    }
    // ds_p++ is drawsegAdd's count++ (called first — see overflow note).
  }

  /** R_RenderSegLoop (r_segs.c:187-317); rw_x advances to rw_stopx. */
  function renderSegLoop(): void {
    for (; rwX < rwStopX; rwX++) {
      // mark floor / ceiling areas
      let yl = (topFrac + HEIGHTUNIT - 1) >> HEIGHTBITS;
      if (yl < ceilingclip[rwX]! + 1) yl = ceilingclip[rwX]! + 1;

      if (markCeiling) {
        const top = ceilingclip[rwX]! + 1;
        let bottom = yl - 1;
        if (bottom >= floorclip[rwX]!) bottom = floorclip[rwX]! - 1;
        if (top <= bottom) {
          markCeilingTop[rwX] = top; // visplane scratch (header DEVIATION)
          markCeilingBottom[rwX] = bottom;
        }
      }

      let yh = bottomFrac >> HEIGHTBITS;
      if (yh >= floorclip[rwX]!) yh = floorclip[rwX]! - 1;

      if (markFloor) {
        let top = yh + 1;
        const bottom = floorclip[rwX]! - 1;
        if (top <= ceilingclip[rwX]!) top = ceilingclip[rwX]! + 1;
        if (top <= bottom) {
          markFloorTop[rwX] = top;
          markFloorBottom[rwX] = bottom;
        }
      }

      let texturecolumn = 0;
      if (segTextured) {
        const angle = (rwCenterAngle + xtoviewangle[rwX]!) >>> 19;
        texturecolumn = rwOffset - FixedMul(finetangent[angle]!, rwDistance);
        texturecolumn >>= FRACBITS;

        let index = rwScale >> LIGHTSCALESHIFT;
        if (index >= MAXLIGHTSCALE) index = MAXLIGHTSCALE - 1;
        dc.colormap = fixedCmap >= 0 ? fixedCmap : tables.scalelight[lightRow * MAXLIGHTSCALE + index]!;
        dc.x = rwX;
        dc.iscale = computeIscale(rwScale);
      }

      if (midTexture >= 0) {
        // single sided line
        dc.yl = yl;
        dc.yh = yh;
        dc.texturemid = rwMidTextureMid;
        dc.source = world.getWallColumn(midTexture, texturecolumn);
        drawColumn(indices, colormaps, CENTERY);
        ceilingclip[rwX] = VIEWHEIGHT;
        floorclip[rwX] = -1;
      } else {
        // two sided line
        if (topTexture >= 0) {
          let mid = pixHigh >> HEIGHTBITS;
          pixHigh += pixHighStep;
          if (mid >= floorclip[rwX]!) mid = floorclip[rwX]! - 1;
          if (mid >= yl) {
            dc.yl = yl;
            dc.yh = mid;
            dc.texturemid = rwTopTextureMid;
            dc.source = world.getWallColumn(topTexture, texturecolumn);
            drawColumn(indices, colormaps, CENTERY);
            ceilingclip[rwX] = mid;
          } else {
            ceilingclip[rwX] = yl - 1;
          }
        } else if (markCeiling) {
          ceilingclip[rwX] = yl - 1;
        }

        if (bottomTexture >= 0) {
          let mid = (pixLow + HEIGHTUNIT - 1) >> HEIGHTBITS;
          pixLow += pixLowStep;
          if (mid <= ceilingclip[rwX]!) mid = ceilingclip[rwX]! + 1;
          if (mid <= yh) {
            dc.yl = mid;
            dc.yh = yh;
            dc.texturemid = rwBottomTextureMid;
            dc.source = world.getWallColumn(bottomTexture, texturecolumn);
            drawColumn(indices, colormaps, CENTERY);
            floorclip[rwX] = mid;
          } else {
            floorclip[rwX] = yh + 1;
          }
        } else if (markFloor) {
          floorclip[rwX] = yh + 1;
        }

        if (maskedTexture && maskedBase >= 0) {
          openingsSet(maskedBase + rwX, texturecolumn); // save texturecol
        }
      }

      rwScale += rwScaleStep;
      topFrac += topStep;
      bottomFrac += bottomStep;
    }
  }

  function storeFragments(count: number): void {
    for (let i = 0; i < count; i++) storeWallRange(fragStart(i), fragStop(i));
  }

  return {
    addSolid(first: number, last: number): void {
      storeFragments(clipSolidWallSegment(first, last));
    },
    addPass(first: number, last: number): void {
      storeFragments(clipPassWallSegment(first, last));
    },
    onSubsector(ss: number): void {
      if (map !== undefined) frontSec = map.subsectors.sector[ss]!;
    },
    onSegReached(seg: number): void {
      curSeg = seg;
      rwAngle1 = pointToAngle(view, world.segV1x[seg]!, world.segV1y[seg]!); // r_bsp.c:283
      line = world.segLine[seg]!;
      side = world.segSide[seg]!;
      if (map === undefined) {
        frontSec = side >= 0 ? world.sideSector[side]! : frontSec;
      }
      backSec = -1;
      if (line >= 0) {
        const other =
          world.lineFront[line] === side ? world.lineBack[line]! : world.lineFront[line]!;
        if (other >= 0) backSec = world.sideSector[other]!;
      }
    },
  };
}

/** drawMasked — named no-op re-export (M4 draws; lives in drawsegs.ts). */
export { drawMasked } from './drawsegs';
