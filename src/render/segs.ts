// render/segs.ts — R_StoreWallRange + R_RenderSegLoop (M3-plan §M3-06;
// linuxdoom-1.10/r_segs.c v1.3) + the R_AddLine→R_StoreWallRange seam
// callbacks over the M3-03 fragment stream. Zone: core + render only.
//
// Vanilla mapping: module globals (r_segs.c:46-92) → closure state of
// createSegCallbacks (dc/drawsegs/clips stay module singletons).
//   R_StoreWallRange (:378-743) → storeWallRange, fed by addSolid/addPass
//     from the solidsegs fragment stream (DEVIATION 3: fragments replace the
//     inline R_StoreWallRange calls of R_Clip{Solid,Pass}WallSegment — r_segs
//     never reads solidsegs ⇒ deferred consumption equivalent; start>stop
//     hom++/skip lives in solidsegs; fragment order = vanilla call order).
//   R_RenderSegLoop (:187-317) → renderSegLoop, HEIGHTBITS 12 (:183).
//   R_ScaleFromGlobalAngle (r_main.c:453-503) verbatim, detailshift 0, clamp
//     [256, 64*FRACUNIT]; R_PointToDist (r_main.c:392-418) local, DBITS 5
//     = FRACBITS−SLOPEBITS (research 03). texturetranslation identity.
//   walllights = scalelight[lightnum] → lightRow via lights.wallLightNum
//     (pancake ±1 truth); bucket = rw_scale>>LIGHTSCALESHIFT clamp 47
//     (:271-276). fixedcolormap ≡ scalelightfixed[i] (R_SetupFrame fills it
//     wholly with fixedcolormap, r_main.c:847-859) — representation only.
//
// DEVIATIONS (faithful-value unless noted):
//  - G13: no ML_MAPPED write (sim-mutation ban).
//  - sky (M4-04 wired): the outdoor height-change hack (:604-609
//    `worldtop = worldhigh` when BOTH ceilings are F_SKY1) and the
//    `!= skyflatnum` guard on the below-viewz markceiling disable
//    (:660-665) are faithful; the sky tag lives in planes.isSkyPic —
//    production must keep planes.setSkyflatnum(world.skyflatnum) wired
//    (M4-07 pipeline), else isSkyPic never matches (−1 placeholder).
//  - visplane marking (:200-228, M4-04): the ceilingplane/floorplane
//    globals (planes.ts) are opened by R_Subsector (bsp.ts); here
//    R_CheckPlane runs (:688-693, before the loop) and the marks write
//    ceilingplane/floorplane->top/bottom[rw_x] via planes.markColumn.
//    DEFENSIVE DEV: markflag true + NULL plane global (vanilla would
//    write through a NULL pointer — unreachable via bsp.ts, whose
//    R_Subsector predicate ≡ the :666-677 disable) ⇒ the write is
//    skipped; same for a never-opened plane in map-less direct-call tests.
//  - rowoffset: only sideOffsetX (textureoffset) exists in rdata; the
//    texturemid `+= rowoffset` (:460, :546-547) reuses it — equal whenever
//    the two sidedef offsets agree (all shipped sidedefs in fixtures);
//    rdata seam gap, follow-up M3-06b/M4.
//  - masked middle = midtexture PRESENCE (:640-646), not transparency;
//    record — masked.ts draws (M4-04).
//  - drawseg SoA + openings refs: drawsegs.ts header (MAXSHORT-init record
//    deviation lives there).
//  - frontsector: sideSector[segSide] (P_GroupLines ⇒ = subsector's for
//    real segs); the map arg switches to exact map.subsectors.sector.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG180, ANG90, FRACBITS, FRACUNIT, MAXINT } from '../core/constants';
import { angSub, FixedDiv, FixedMul, angAdd, angToFine } from '../core/fixed';
import { finesine, finetangent, tantoangle } from '../core/tables';
import { clipPassWallSegment, clipSolidWallSegment, fragStart, fragStop } from './solidsegs';
import {
  initTextureMapping,
  pointToAngle,
  PROJECTION,
  CENTERY,
  VIEWHEIGHT,
  type RenderMapView,
  type ViewState,
} from './view';
import { NO_TEXTURE, type RenderWorld } from './rdata';
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
  CLIP_NEGONE, CLIP_NULL, CLIP_SCREEN, MAXSHORT, SIL_BOTTOM, SIL_BOTH, SIL_TOP,
  allocOpenings, ceilingclip, drawsegAdd, floorclip, getDrawsegs, openingsSet,
  snapshotOpenings,
} from './drawsegs';
import {
  checkPlane, getCeilingplane, getFloorplane, isSkyPic, markColumn, setCeilingplane,
  setFloorplane, type Visplane,
} from './planes';

/** r_segs.c:183-184 (`#define HEIGHTBITS 12`, HEIGHTUNIT 1<<12). */
const HEIGHTBITS = 12;
const HEIGHTUNIT = 1 << HEIGHTBITS;
/** r_defs.h lineDefBitEnum bits (rdata owns ML_TWOSIDED). */
const ML_DONTPEGTOP = 0x0008;
const ML_DONTPEGBOTTOM = 0x0010;
/** m_fixed.h DBITS = FRACBITS - SLOPEBITS = 5 (research doc 03). */
const DBITS = 5;
const CENTERYFRAC = CENTERY * FRACUNIT; // centeryfrac (viewheight/2)

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

/* Visplane targets of THIS seg (r_segs.c ceilingplane/floorplane globals
 * read after the R_CheckPlane calls; null = nothing to mark — header
 * DEFENSIVE DEV). Refreshed per storeWallRange. */
let ceilingMarkPlane: Visplane | null = null;
let floorMarkPlane: Visplane | null = null;

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
  let rwAngle1 = 0; // angle_t (r_bsp.c:283)
  let frontSec = 0;
  let backSec = -1;
  let line = -1;
  let side = -1;
  let segTextured = false, markFloor = false, markCeiling = false, maskedTexture = false;
  let midTexture = NO_TEXTURE, topTexture = NO_TEXTURE, bottomTexture = NO_TEXTURE;
  let rwNormalAngle = 0, rwX = 0, rwStopX = 0, rwCenterAngle = 0;
  let rwOffset = 0, rwDistance = 0, rwScale = 0, rwScaleStep = 0;
  let rwMidTextureMid = 0, rwTopTextureMid = 0, rwBottomTextureMid = 0;
  let worldtop = 0, worldbottom = 0, worldhigh = 0, worldlow = 0;
  let pixHigh = 0, pixLow = 0, pixHighStep = 0, pixLowStep = 0;
  let topFrac = 0, topStep = 0, bottomFrac = 0, bottomStep = 0;
  let lightRow = 0;
  let fixedCmap = -1; // ≥0 = dc.colormap offset when view.fixedcolormap set
  let maskedBase = 0; // openings ref (signed base−rwX, vanilla pointer math; may be < 0)
  let maskedRecord = false; // maskedtexturecol allocated (FIX-M3-06c: refs are signed)

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
    const v1x = world.segV1x[curSeg]!, v1y = world.segV1y[curSeg]!;
    const v2x = world.segV2x[curSeg]!, v2y = world.segV2y[curSeg]!;
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
    ds.x1[di] = rwX = start; ds.x2[di] = stop; rwStopX = stop + 1;
    ds.scale1[di] = rwScale = scaleFromGlobalAngle(angAdd(view.viewangle, xtoviewangle[start]!));
    if (stop > start) {
      ds.scale2[di] = scaleFromGlobalAngle(angAdd(view.viewangle, xtoviewangle[stop]!));
      rwScaleStep = (ds.scale2[di]! - rwScale) / (stop - start) | 0; // C trunc
      ds.scalestep[di] = rwScaleStep;
    } else {
      ds.scale2[di] = ds.scale1[di];
      // vanilla leaves rw_scalestep STALE; 0 is step of scale1==scale2
      rwScaleStep = 0;
    }
    worldtop = world.sectorCeil[frontSec]! - view.viewz;
    worldbottom = world.sectorFloor[frontSec]! - view.viewz;
    midTexture = topTexture = bottomTexture = NO_TEXTURE;
    maskedTexture = false;
    maskedRecord = false;
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
        ds.silhouette[di] = SIL_BOTTOM; ds.bsilheight[di] = world.sectorFloor[frontSec]!;
      } else if (world.sectorFloor[backSec]! > view.viewz) {
        ds.silhouette[di] = SIL_BOTTOM; ds.bsilheight[di] = MAXINT;
      }
      if (world.sectorCeil[frontSec]! < world.sectorCeil[backSec]!) {
        ds.silhouette[di] |= SIL_TOP; ds.tsilheight[di] = world.sectorCeil[frontSec]!;
      } else if (world.sectorCeil[backSec]! < view.viewz) {
        ds.silhouette[di] |= SIL_TOP; ds.tsilheight[di] = -MAXINT - 1;
      }
      if (world.sectorCeil[backSec]! <= world.sectorFloor[frontSec]!) {
        ds.sprbottomclip[di] = CLIP_NEGONE;
        ds.bsilheight[di] = MAXINT; ds.silhouette[di] |= SIL_BOTTOM;
      }
      if (world.sectorFloor[backSec]! >= world.sectorCeil[frontSec]!) {
        ds.sprtopclip[di] = CLIP_SCREEN;
        ds.tsilheight[di] = -MAXINT - 1; ds.silhouette[di] |= SIL_TOP;
      }
      worldhigh = world.sectorCeil[backSec]! - view.viewz;
      worldlow = world.sectorFloor[backSec]! - view.viewz;
      // hack to allow height changes in outdoor areas (:602-607, M4-04):
      // both ceilings F_SKY1 ⇒ worldtop = worldhigh.
      if (
        isSkyPic(world.sectorCeilPic[frontSec]!) &&
        isSkyPic(world.sectorCeilPic[backSec]!)
      ) {
        worldtop = worldhigh;
      }
      markFloor =
        worldlow !== worldbottom ||
        world.sectorFloorPic[backSec] !== world.sectorFloorPic[frontSec] ||
        world.sectorLight[backSec] !== world.sectorLight[frontSec]; // pic cmp: −1 unresolved ⇒ equal (no-flats builds)
      markCeiling =
        worldhigh !== worldtop ||
        world.sectorCeilPic[backSec] !== world.sectorCeilPic[frontSec] ||
        world.sectorLight[backSec] !== world.sectorLight[frontSec];
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
        rwBottomTextureMid = flags & ML_DONTPEGBOTTOM ? worldtop : worldlow;
      }
      rwTopTextureMid += rowOff;
      rwBottomTextureMid += rowOff;
      // masked midtexture allocation (:640-646; presence, not transparency)
      if (side >= 0 && world.sideMidTex[side] !== NO_TEXTURE) {
        maskedTexture = true;
        const n = rwStopX - rwX;
        const base = allocOpenings(n);
        // FIX-M3-06c: maskedtexturecol = lastopening - rw_x (:611) is a
        // SIGNED pointer difference — the base is routinely BELOW rw_x.
        // Only allocation failure (our overflow deviation) skips recording.
        if (base >= 0) {
          maskedBase = base - rwX;
          maskedRecord = true;
          ds.maskedcol[di] = maskedBase;
          for (let x = start; x <= stop; x++) openingsSet(base + x - start, MAXSHORT);
        }
      }
    }
    segTextured = midTexture >= 0 || topTexture >= 0 || bottomTexture >= 0 || maskedTexture;
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
        lightRow = wallLightNum(world.sectorLight[frontSec]!, view.extralight, v1x, v1y, v2x, v2y).row;
      }
    }
    // Planes on the wrong side of the view plane are invisible (:666-677).
    if (world.sectorFloor[frontSec]! >= view.viewz) markFloor = false;
    // `&& ceilingpic != skyflatnum` guard (:672) — a sky ceiling keeps
    // marking even below the viewz (M4-04; M3 dropped it, header).
    if (world.sectorCeil[frontSec]! <= view.viewz && !isSkyPic(world.sectorCeilPic[frontSec]!)) {
      markCeiling = false;
    }
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
    // R_CheckPlane over the seg span (:688-693) — `ceilingplane`/
    // `floorplane` are the planes R_Subsector opened (planes.ts globals);
    // a split-by-copy returns the fresh plane to mark going forward.
    // NULL global + mark flag: vanilla NULL write — unreachable via bsp
    // (header DEFENSIVE DEV) — skip the marks.
    ceilingMarkPlane = null;
    floorMarkPlane = null;
    if (markCeiling) {
      const pl = getCeilingplane();
      if (pl !== null) {
        const next = checkPlane(pl, rwX, rwStopX - 1);
        setCeilingplane(next);
        ceilingMarkPlane = next;
      }
    }
    if (markFloor) {
      const pl = getFloorplane();
      if (pl !== null) {
        const next = checkPlane(pl, rwX, rwStopX - 1);
        setFloorplane(next);
        floorMarkPlane = next;
      }
    }

    renderSegLoop();
    // Save sprite clipping info (:716-739). snapshotOpenings returns the
    // signed lastopening - start (:716-733) or null on allocation failure
    // (our overflow deviation) — a NEGATIVE ref is vanilla-normal (:611).
    const n = rwStopX - start;
    if (((ds.silhouette[di]! & SIL_TOP) !== 0 || maskedTexture) && ds.sprtopclip[di] === CLIP_NULL) {
      const ref = snapshotOpenings(ceilingclip, start, n);
      if (ref !== null) ds.sprtopclip[di] = ref;
    }
    if (((ds.silhouette[di]! & SIL_BOTTOM) !== 0 || maskedTexture) && ds.sprbottomclip[di] === CLIP_NULL) {
      const ref = snapshotOpenings(floorclip, start, n);
      if (ref !== null) ds.sprbottomclip[di] = ref;
    }
    if (maskedTexture && (ds.silhouette[di]! & SIL_TOP) === 0) { ds.silhouette[di] |= SIL_TOP; ds.tsilheight[di] = -MAXINT - 1; }
    if (maskedTexture && (ds.silhouette[di]! & SIL_BOTTOM) === 0) { ds.silhouette[di] |= SIL_BOTTOM; ds.bsilheight[di] = MAXINT; }
    // ds_p++ is drawsegAdd's count++ (called first — see overflow note).
  }

  /** R_RenderSegLoop (r_segs.c:187-317); rw_x advances to rw_stopx. */
  function renderSegLoop(): void {
    for (; rwX < rwStopX; rwX++) {
      // mark floor / ceiling areas
      let yl = (topFrac + HEIGHTUNIT - 1) >> HEIGHTBITS;
      if (yl < ceilingclip[rwX]! + 1) yl = ceilingclip[rwX]! + 1;
      if (markCeiling) {
        let top = ceilingclip[rwX]! + 1;
        // DEV (faithful-value): vanilla can store a NEGATIVE top here
        // (untextured band ⇒ ceilingclip = yl−1 < 0, r_segs.c:266) and
        // R_MakeSpans then indexes spanstart out of bounds — undefined
        // behavior we cannot port. Clamping to row 0 is the screen-clipped
        // value (rows < 0 never draw a pixel); the Uint8 mark store would
        // otherwise wrap mod 256 into a bogus mark.
        if (top < 0) top = 0;
        let bottom = yl - 1;
        if (bottom >= floorclip[rwX]!) bottom = floorclip[rwX]! - 1;
        if (top <= bottom) {
          if (ceilingMarkPlane !== null) markColumn(ceilingMarkPlane, rwX, top, bottom);
        }
      }
      let yh = bottomFrac >> HEIGHTBITS;
      if (yh >= floorclip[rwX]!) yh = floorclip[rwX]! - 1;
      if (markFloor) {
        let top = yh + 1;
        const bottom = floorclip[rwX]! - 1;
        if (top <= ceilingclip[rwX]!) top = ceilingclip[rwX]! + 1;
        if (top <= bottom) {
          if (floorMarkPlane !== null) markColumn(floorMarkPlane, rwX, top, bottom);
        }
      }
      let texturecolumn = 0;
      if (segTextured) {
        const angle = (rwCenterAngle + xtoviewangle[rwX]!) >>> 19;
        texturecolumn = rwOffset - FixedMul(finetangent[angle]!, rwDistance);
        texturecolumn >>= FRACBITS;
        let index = rwScale >> LIGHTSCALESHIFT;
        if (index >= MAXLIGHTSCALE) index = MAXLIGHTSCALE - 1;
        dc.colormap =
          fixedCmap >= 0 ? fixedCmap : tables.scalelight[lightRow * MAXLIGHTSCALE + index]!;
        dc.x = rwX; dc.iscale = computeIscale(rwScale);
      }
      if (midTexture >= 0) {
        // single sided line
        dc.yl = yl; dc.yh = yh; dc.texturemid = rwMidTextureMid;
        dc.source = world.getWallColumn(midTexture, texturecolumn);
        drawColumn(indices, colormaps, CENTERY);
        ceilingclip[rwX] = VIEWHEIGHT; floorclip[rwX] = -1;
      } else {
        // two sided line
        if (topTexture >= 0) {
          let mid = pixHigh >> HEIGHTBITS;
          pixHigh += pixHighStep;
          if (mid >= floorclip[rwX]!) mid = floorclip[rwX]! - 1;
          if (mid >= yl) {
            dc.yl = yl; dc.yh = mid; dc.texturemid = rwTopTextureMid;
            dc.source = world.getWallColumn(topTexture, texturecolumn);
            drawColumn(indices, colormaps, CENTERY); ceilingclip[rwX] = mid;
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
            dc.yl = mid; dc.yh = yh; dc.texturemid = rwBottomTextureMid;
            dc.source = world.getWallColumn(bottomTexture, texturecolumn);
            drawColumn(indices, colormaps, CENTERY); floorclip[rwX] = mid;
          } else {
            floorclip[rwX] = yh + 1;
          }
        } else if (markFloor) {
          floorclip[rwX] = yh + 1;
        }
        // save texturecol for backdrawing of the masked mid texture
        // (maskedtexturecol[rw_x] = texturecolumn, r_segs.c:356 — signed ref,
        // FIX-M3-06c: gated on successful allocation, not on ref sign)
        if (maskedTexture && maskedRecord) openingsSet(maskedBase + rwX, texturecolumn);
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
      if (map === undefined && side >= 0) frontSec = world.sideSector[side]!;
      backSec = -1;
      if (line >= 0) {
        const other = world.lineFront[line] === side ? world.lineBack[line]! : world.lineFront[line]!;
        if (other >= 0) backSec = world.sideSector[other]!;
      }
    },
  };
}

/** drawMasked — re-export (M4-04: the driver lives in masked.ts). */
export { drawMasked } from './masked';
