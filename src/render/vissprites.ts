// render/vissprites.ts — the static sprite pass (M4-plan §M4-05;
// r_things.c R_AddSprites / R_ProjectSprite / R_SortVisSprites /
// R_DrawSprite / R_DrawVisSprite + the R_DrawMaskedColumn post walker).
//
// Zone discipline (eslint doom/zones/render): imports core + wad TYPES +
// render only.
//
// Vanilla mapping (linuxdoom-1.10 sources, re-read for this task):
//
//  * `R_AddSprites(sec)` (r_things.c:613-642) → {@link SpritePass.addSector-
//    Sprites}: the `sec->validcount == validcount` dedupe (sector split into
//    subsectors is sprite-added once per frame, first/nearest visit wins —
//    validcount is bsp.ts's per-frame `getValidcount()`, the M4-01 seam) +
//    `spritelights = scalelight[clamp((sec->lightlevel >> LIGHTSEGSHIFT) +
//    extralight)]` — NO wall-pancake ±1 rule (r_things.c has no v1/v2 test
//    here; pinned against r_segs.c:122-134) — then the per-sector thing walk
//    ({@link StaticThings.sectorHead}/{@link StaticThings.next}, the merged
//    M4-03 mobj-less `sec->thinglist`).
//  * `R_ProjectSprite(thing)` (r_things.c:443-596) → {@link
//    SpritePass.projectSprite}, verbatim: MINZ 4·FRACUNIT reject, `xscale =
//    FixedDiv(projection, tz)`, the `abs(tx) > (tz<<2)` wide-FOV reject,
//    rot via `rotationFromAngles` (r_things.c:522-523, M4-03 helper) for
//    rotate frames, the patch-header edge math (`tx -= spriteoffset`, `x2 =
//    … - 1`), `iscale = FixedDiv(FRACUNIT, xscale)`, flip ⇒ `xiscale =
//    -iscale`, `startfrac = (width<<16) - 1`, the clipped-column `startfrac
//    += xiscale*(vis->x1-x1)` adjust (plain fixed×int multiply, gcc wrap),
//    `gz = thing z` (= the containing subsector's floor, plan §0.8), `gzt =
//    z + spritetopoffset`, `texturemid = gzt - viewz`.
//    Light (r_things.c:573-595, pinned): `MF_SHADOW → NULL colormap` (fuzz)
//    — DEAD for the M4 static roster (plan §4: no MF_SHADOW map things; the
//    fuzz path is the named stub {@link drawFuzzColumn} below, never
//    reachable); `fixedcolormap` → the fixed row (view.fixedcolormap × 256,
//    the segs.ts representation); `FF_FULLBRIGHT → colormaps` — FULLBRIGHT
//    STAYS OFF until A-02/M8 (plan §4: M4 statics read dark, expected);
//    else `spritelights[xscale >> LIGHTSCALESHIFT]` clamped to
//    MAXLIGHTSCALE-1. So with the M4 roster every vissprite carries a real
//    scalelight row — the −1 "fuzz" sentinel is never stored.
//  * `R_NewVisSprite` (r_things.c:328-335): pool overflow returns the static
//    `overflowsprite`, vissprite_p does NOT advance → the overflow sprite is
//    never in the sorted list, i.e. vanilla SILENTLY DROPS it. Port: same
//    drop + a live `visspriteOverflow` counter (deviation: visibility only;
//    MAXVISSPRITES stays 128, never raised — plan §6).
//  * `R_SortVisSprites` (r_things.c:769-814): selection-pull by ASCENDING
//    scale, each pulled node appended to the sorted tail ⇒ output = stable
//    ascending-by-scale of creation order (strict `<` scan keeps ties in
//    BSP/creation order). Ported as an insertion sort over the index array
//    (identical result: both are stable ascending sorts of the same input;
//    128·128 worst case only on pool-full frames), drawn front-of-list FIRST
//    = back-to-front (r_things.c:966-975).
//  * `R_DrawSprite(spr)` (r_things.c:842-955) → {@link SpritePass.drawSprite},
//    verbatim: clipbot/cliptop −2 init over x1..x2 (module Int16Arrays — the
//    C stack arrays are uninitialized outside [x1,x2] and only that range is
//    consulted); drawseg scan newest→oldest; the
//    `x1>x2s || x2<x1s || (!silhouette && !maskedtexturecol)` skip;
//    `scale = max(scale1,scale2), lowscale = min`; the behind test
//    `scale < spr->scale || (lowscale < spr->scale && !R_PointOnSegSide(gx,
//    gy, curline))` — R_PointOnSegSide (r_main.c:215-275) reads the SEG's
//    own v1/v2 (NOT the linedef), which is what drawsegs.ts stores, so
//    miniseg drawsegs need no special case; behind + maskedtexturecol ⇒
//    R_RenderMaskedSegRange(ds, r1, r2) (injected, default the named
//    drawsegs.ts stub — the real half is M4-04's masked.ts, wired by
//    M4-07); else silhouette &= ~SIL_BOTTOM when `gz >= ds->bsilheight`,
//    &= ~SIL_TOP when `gzt <= ds->tsilheight`, fill clipbot/cliptop from
//    ds->sprbottomclip/sprtopclip where still −2 (clipValue resolves the
//    CLIP_SCREEN/CLIP_NEGONE pointer sentinels — vanilla stores real
//    pointers, see drawsegs.ts header); unclipped defaults clipbot =
//    viewheight, cliptop = −1.
//  * `R_DrawVisSprite` (r_things.c:404-448) + `R_DrawMaskedColumn`
//    (r_things.c:351-387): per screen column, `frac = startfrac; frac +=
//    xiscale`, `texturecolumn = frac>>FRACBITS`; per post RUN:
//    `topscreen = sprtopscreen + spryscale*topdelta` (PLAIN int multiply —
//    NOT FixedMul; verified r_things.c:364), `dc_yl = (topscreen+FRACUNIT-1)
//    >>FRACBITS`, `dc_yh = (bottomscreen-1)>>FRACBITS`, clipped by
//    mfloorclip/mceilingclip, then R_DrawColumn's loop with
//    `dc_texturemid = basetexturemid − (topdelta<<16)` and source = the post
//    bytes (`&127` source-index wrap included, r_draw.c:140). Representation
//    change (ARCHITECTURE §4.3 G1, not a behavior deviation for conforming
//    lumps): posts come from the DECODED columns of wad/patch.ts (0 =
//    transparent, runs = posts) instead of the raw post stream, so a run is
//    found by scanning the decoded column; within a run the decoded bytes
//    equal the post bytes, so the `&127` wrap reads the same pixels (runs
//    > 128 px alias identically; the negative-frac rounding byte is vanilla
//    cache garbage, here deterministically the decoded pixel — documented).
//    Transparency = post gaps = decoded zeros ⇒ pixels under a gap keep
//    whatever the wall/plane pass drew.
//
// Frame order (ARCHITECTURE §4.1 / plan §1.2): clearSprites sits with the
// other per-frame clears BEFORE the BSP walk (vanilla R_ClearSprites is
// step 4 of R_RenderPlayerView); addSectorSprites fires from the bsp.ts
// addSectorSprites callback — vanilla places R_AddSprites in R_Subsector
// BEFORE the seg loop (r_bsp.c:546), which bsp.renderSubsector already
// matches; the DRAW half (sort + back-to-front loop) belongs to
// R_DrawMasked = masked.ts/M4-07 after drawPlanes.
//
// Zero allocation: patch decode is install-time ({@link
// installSpritePatches}); the vissprite pool is pre-allocated SoA; project/
// sort/draw touch only typed arrays and scalars. The per-column run walk
// allocates nothing (subarray-free: the decoded column is indexed directly).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACBITS, FRACUNIT } from '../core/constants';
import { FixedDiv, FixedMul } from '../core/fixed';
import { decodePatch } from '../wad/patch';
import {
  CLIP_NULL,
  clipValue,
  drawsegCount,
  getDrawsegs,
  SIL_BOTTOM,
  SIL_NONE,
  SIL_TOP,
} from './drawsegs';
import { renderMaskedSegRange as stubMaskedSegRange } from './masked';
import type { Framebuffer } from './framebuffer';
import { RENDER_WIDTH } from './framebuffer';
import {
  COLORMAP_STRIDE,
  LIGHTSCALESHIFT,
  LIGHTSEGSHIFT,
  LIGHTLEVELS,
  MAXLIGHTSCALE,
  type LightTables,
} from './lights';
import type { RenderWorld } from './rdata';
import {
  frameFlip,
  frameLump,
  frameRotates,
  lookupFrame,
  rotationFromAngles,
  type InstalledSprites,
  type StaticThings,
} from './rthings';
import { CENTERXFRAC, CENTERY, PROJECTION, VIEWHEIGHT } from './view';
import { pointToAngle, type ViewState } from './view';
import { getValidcount } from './bsp';

/* ------------------------------------------------------------------ */
/* Constants (r_things.c / r_defs.h)                                   */
/* ------------------------------------------------------------------ */

/** r_things.c — `#define MAXVISSPRITES 128` (via r_defs.h vissprite list). */
export const MAXVISSPRITES = 128;

/** r_things.c:46 — MINZ = FRACUNIT*4 (`tz < MINZ` ⇒ behind the view plane). */
export const MINZ = 4 * FRACUNIT;

/** The decoded-pixel sentinel for out-of-post reads (see header). */
const TRANSPARENT = 0;

/* ------------------------------------------------------------------ */
/* Patch table (R_InitSpriteDefs' spriteoffset/spritewidth/             */
/* spritetopoffset arrays + the cached patch data R_DrawVisSprite uses) */
/* ------------------------------------------------------------------ */

/** One decoded sprite lump: patch header (fixed-unit sprite*offset twins) +
 * decoded columns (wad/patch.ts contract: 0 = transparent, runs = posts). */
export interface SpritePatch {
  readonly width: number;
  readonly height: number;
  /** `spriteoffset[lump] = leftoffset << FRACBITS` (r_things.c:158). */
  readonly offsetX: number;
  /** `spritewidth[lump] = width << FRACBITS`. */
  readonly widthFixed: number;
  /** `spritetopoffset[lump] = topoffset << FRACBITS`. */
  readonly topOffsetFixed: number;
  /** Decoded columns, `columns[c][r]` palette byte, 0 = post gap. */
  readonly columns: readonly Uint8Array[];
}

/**
 * Decode every distinct sprite lump of an installed table EXACTLY ONCE at
 * map-load time (vanilla caches lumps lazily at draw with PU_CACHE — the
 * pixel contents are identical; ours never re-decodes, so a frame cannot
 * fail on a lump that decoded fine). Throws the typed PatchDecodeError of
 * wad/patch.ts on a malformed lump (vanilla: W_CacheLumpNum cannot fail).
 */
export function installSpritePatches(
  tables: InstalledSprites,
  readLump: (lumpnum: number) => Uint8Array,
): ReadonlyMap<number, SpritePatch> {
  const out = new Map<number, SpritePatch>();
  for (let lumpnum = 0; lumpnum < tables.lump.length; lumpnum += 1) {
    const num = tables.lump[lumpnum]!;
    if (num < 0 || out.has(num)) continue;
    const p = decodePatch(readLump(num));
    out.set(num, {
      width: p.width,
      height: p.height,
      offsetX: (p.leftOffset << FRACBITS) | 0,
      widthFixed: (p.width << FRACBITS) | 0,
      topOffsetFixed: (p.topOffset << FRACBITS) | 0,
      columns: p.columns,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* SpritePass — one map's sprite state + the per-frame entry points     */
/* ------------------------------------------------------------------ */

export interface SpritePassOptions {
  readonly fb: Framebuffer;
  readonly view: ViewState;
  readonly world: RenderWorld;
  readonly things: StaticThings;
  readonly sprites: InstalledSprites;
  readonly patches: ReadonlyMap<number, SpritePatch>;
  readonly lights: LightTables;
  /**
   * R_RenderMaskedSegRange call site of R_DrawSprite (nearer-than-sprite
   * masked segs drawn first). Default: the drawsegs.ts NAMED STUB (M4-04
   * owns the real half in masked.ts; M4-07 wires the real function in).
   */
  readonly renderMaskedSegRange?: (ds: number, x1: number, x2: number) => void;
}

export interface SpritePool {
  readonly count: number;
  readonly x1: Int32Array;
  readonly x2: Int32Array;
  readonly scale: Int32Array;
  readonly gx: Int32Array;
  readonly gy: Int32Array;
  readonly gz: Int32Array;
  readonly gzt: Int32Array;
  readonly texturemid: Int32Array;
  readonly startfrac: Int32Array;
  readonly xiscale: Int32Array;
  /** sprite lump directory number (vanilla `vis->patch`). */
  readonly patch: Int32Array;
  /** dc.colormap byte offset into LightTables.colormaps; −1 = fuzz (never
   * stored by the M4 static roster — see file header). */
  readonly colormap: Int32Array;
  /** Sort order (index i draws the pool slot sortOrder[i]). */
  readonly sortOrder: Int32Array;
}

export interface SpritePass {
  /** R_ClearSprites (r_main.c frame step 4): pool reset + counter reset. */
  clearSprites(): void;
  /** R_AddSprites — the bsp.ts addSectorSprites callback. */
  addSectorSprites(sector: number): void;
  /** R_ProjectSprite for one StaticThings record (exported for tests). */
  projectSprite(thing: number): void;
  /** R_SortVisSprites. */
  sortVisSprites(): void;
  /** R_DrawSprite for pool slot `i`. */
  drawSprite(i: number): void;
  /** The vissprite half of R_DrawMasked: sort + draw back-to-front. */
  drawSprites(): void;
  readonly pool: SpritePool;
  /** MAXVISSPRITES drops this frame (reset by clearSprites). */
  visspriteOverflow(): number;
}

/**
 * One map's sprite pass. `view`/`fb`/`lights` objects are reused and
 * re-setup per frame by the caller (setupView semantics); the pass reads
 * them live.
 */
export function createSpritePass(opts: SpritePassOptions): SpritePass {
  const { view, world, things, sprites, lights, patches } = opts;
  const indices = opts.fb.indices;
  const colormaps = lights.colormaps;
  const renderMaskedSegRange = opts.renderMaskedSegRange ?? stubMaskedSegRange;

  /* ---- vissprite_t[] (r_defs.h) → SoA pool ---- */
  const pX1 = new Int32Array(MAXVISSPRITES);
  const pX2 = new Int32Array(MAXVISSPRITES);
  const pScale = new Int32Array(MAXVISSPRITES);
  const pGx = new Int32Array(MAXVISSPRITES);
  const pGy = new Int32Array(MAXVISSPRITES);
  const pGz = new Int32Array(MAXVISSPRITES);
  const pGzt = new Int32Array(MAXVISSPRITES);
  const pTexturemid = new Int32Array(MAXVISSPRITES);
  const pStartfrac = new Int32Array(MAXVISSPRITES);
  const pXiscale = new Int32Array(MAXVISSPRITES);
  const pPatch = new Int32Array(MAXVISSPRITES);
  const pColormap = new Int32Array(MAXVISSPRITES);
  const pPatchRef: (SpritePatch | undefined)[] = new Array(MAXVISSPRITES).fill(undefined);
  const sortOrder = new Int32Array(MAXVISSPRITES);

  let count = 0; // vissprite_p
  let overflow = 0;

  /* ---- R_AddSprites state ---- */
  const sectorValid = new Int32Array(world.numSectors); // sec->validcount
  let spritelightsRow = 0; // scalelight row selected per sector

  /* ---- R_DrawSprite scratch (short clipbot[SCREENWIDTH]/cliptop[]) ---- */
  const clipbot = new Int16Array(RENDER_WIDTH);
  const cliptop = new Int16Array(RENDER_WIDTH);

  const drawsegs = getDrawsegs(); // live SoA view (arrays never replaced)

  /* ------------------------------------------------------------------ */
  /* R_ProjectSprite (r_things.c:443-596)                              */
  /* ------------------------------------------------------------------ */
  function projectSprite(k: number): void {
    const trX = (things.x[k]! - view.viewx) | 0;
    const trY = (things.y[k]! - view.viewy) | 0;

    const gxt = FixedMul(trX, view.viewcos);
    const gyt = -FixedMul(trY, view.viewsin);
    const tz = (gxt - gyt) | 0;
    if (tz < MINZ) return; // behind the view plane

    const xscale = FixedDiv(PROJECTION, tz);

    const gxt2 = -FixedMul(trX, view.viewsin);
    const gyt2 = FixedMul(trY, view.viewcos);
    const tx0 = -(gyt2 + gxt2) | 0;
    if (Math.abs(tx0) > (tz << 2)) return; // too far off the side

    // View selection (r_things.c:509-533) — M4-03 rot helpers.
    const gf = lookupFrame(sprites, things.spriteNum[k]!, things.frame[k]!);
    if (gf < 0) return; // vanilla RANGECHECK I_Error; census hole ⇒ nothing
    const rot = frameRotates(sprites, gf)
      ? rotationFromAngles(pointToAngle(view, things.x[k]!, things.y[k]!), things.angle[k]!)
      : 0;
    const lump = frameLump(sprites, gf, rot);
    if (lump < 0) return; // absent slot (census tolerance; vanilla I_Errors)
    const flip = frameFlip(sprites, gf, rot);
    const patch = patches.get(lump);
    if (patch === undefined || patch.width === 0) return; // no pixels

    // Edges of the shape (r_things.c:535-548) — spriteoffset/spritewidth.
    let tx = (tx0 - patch.offsetX) | 0;
    const x1 = (CENTERXFRAC + FixedMul(tx, xscale)) >> FRACBITS;
    if (x1 > RENDER_WIDTH) return; // off the right side
    tx = (tx + patch.widthFixed) | 0;
    const x2 = ((CENTERXFRAC + FixedMul(tx, xscale)) >> FRACBITS) - 1;
    if (x2 < 0) return; // off the left side

    if (count === MAXVISSPRITES) {
      // Vanilla: returns &overflowsprite, vissprite_p unchanged → silently
      // dropped; us: dropped + counted (deviation: visibility only).
      overflow += 1;
      return;
    }
    const i = count++;

    const iscale = FixedDiv(FRACUNIT, xscale);
    const gzt = (things.floorZ[k]! + patch.topOffsetFixed) | 0;

    pScale[i] = xscale; // scale = xscale<<detailshift, detailshift = 0
    pGx[i] = things.x[k]!;
    pGy[i] = things.y[k]!;
    pGz[i] = things.floorZ[k]!;
    pGzt[i] = gzt;
    pTexturemid[i] = (gzt - view.viewz) | 0;
    pX1[i] = x1 < 0 ? 0 : x1;
    pX2[i] = x2 >= RENDER_WIDTH ? RENDER_WIDTH - 1 : x2;
    pXiscale[i] = flip ? -iscale : iscale;
    pStartfrac[i] = flip ? patch.widthFixed - 1 : 0;
    if (pX1[i]! > x1) pStartfrac[i] = (pStartfrac[i]! + pXiscale[i]! * (pX1[i]! - x1)) | 0;
    pPatch[i] = lump;
    pPatchRef[i] = patch;

    // Light (r_things.c:573-595; fuzz + fullbright dead per file header).
    pColormap[i] =
      view.fixedcolormap >= 0
        ? view.fixedcolormap * COLORMAP_STRIDE
        : lights.scalelight[spritelightsRow * MAXLIGHTSCALE + colIndex(xscale)]!;
  }

  /** `index = xscale >> LIGHTSCALESHIFT; if (index >= MAXLIGHTSCALE) 47`. */
  function colIndex(xscale: number): number {
    const idx = xscale >> LIGHTSCALESHIFT; // xscale >= 0 (tz >= MINZ guard)
    return idx >= MAXLIGHTSCALE ? MAXLIGHTSCALE - 1 : idx;
  }

  /* ------------------------------------------------------------------ */
  /* R_AddSprites (r_things.c:613-642)                                 */
  /* ------------------------------------------------------------------ */
  function addSectorSprites(sector: number): void {
    const vc = getValidcount();
    if (sectorValid[sector] === vc) return; // already added this frame
    sectorValid[sector] = vc;

    const lightnum = (world.sectorLight[sector]! >> LIGHTSEGSHIFT) + view.extralight;
    spritelightsRow = lightnum < 0 ? 0 : lightnum >= LIGHTLEVELS ? LIGHTLEVELS - 1 : lightnum;

    for (let k = things.sectorHead[sector]!; k !== -1; k = things.next[k]!) {
      projectSprite(k);
    }
  }

  /* ------------------------------------------------------------------ */
  /* R_SortVisSprites (r_things.c:769-814)                             */
  /* ------------------------------------------------------------------ */
  function sortVisSprites(): void {
    // Stable insertion sort by ascending scale == vanilla's selection-pull
    // result (ties keep creation order; strict > shifts).
    for (let i = 0; i < count; i += 1) {
      const s = pScale[i]!;
      let j = i - 1;
      while (j >= 0 && pScale[sortOrder[j]!]! > s) {
        sortOrder[j + 1] = sortOrder[j]!;
        j -= 1;
      }
      sortOrder[j + 1] = i;
    }
  }

  /* ------------------------------------------------------------------ */
  /* R_PointOnSegSide (r_main.c:215-275) — seg v1/v2 (NOT the linedef) */
  /* ------------------------------------------------------------------ */
  function pointOnSegSide(x: number, y: number, seg: number): 0 | 1 {
    const lx = world.segV1x[seg]!;
    const ly = world.segV1y[seg]!;
    const ldx = (world.segV2x[seg]! - lx) | 0;
    const ldy = (world.segV2y[seg]! - ly) | 0;

    if (ldx === 0) {
      if (x <= lx) return ldy > 0 ? 1 : 0;
      return ldy < 0 ? 1 : 0;
    }
    if (ldy === 0) {
      if (y <= ly) return ldx < 0 ? 1 : 0;
      return ldx > 0 ? 1 : 0;
    }

    const dx = (x - lx) | 0;
    const dy = (y - ly) | 0;

    // Try to quickly decide by looking at sign bits.
    if ((ldy ^ ldx ^ dx ^ dy) & 0x80000000) {
      if ((ldy ^ dx) & 0x80000000) return 1; // (left is negative)
      return 0;
    }

    const left = FixedMul(ldy >> FRACBITS, dx);
    const right = FixedMul(dy, ldx >> FRACBITS);
    return right < left ? 0 : 1; // front side : back
  }

  /* ------------------------------------------------------------------ */
  /* R_DrawSprite (r_things.c:842-955) + R_DrawVisSprite post stream    */
  /* ------------------------------------------------------------------ */
  function drawSprite(i: number): void {
    const sx1 = pX1[i]!;
    const sx2 = pX2[i]!;
    if (sx1 > sx2) return;
    const patch = pPatchRef[i];
    if (patch === undefined) return;

    for (let x = sx1; x <= sx2; x += 1) {
      clipbot[x] = -2;
      cliptop[x] = -2;
    }

    const sprScale = pScale[i]!;
    const gz = pGz[i]!;
    const gzt = pGzt[i]!;
    const n = drawsegCount();
    for (let d = n - 1; d >= 0; d -= 1) {
      const dx1 = drawsegs.x1[d]!;
      const dx2 = drawsegs.x2[d]!;
      if (dx1 > sx2 || dx2 < sx1) continue;
      const sil0 = drawsegs.silhouette[d]!;
      const masked = drawsegs.maskedcol[d]!;
      if (sil0 === SIL_NONE && masked === CLIP_NULL) continue; // covers nothing

      const r1 = dx1 < sx1 ? sx1 : dx1;
      const r2 = dx2 > sx2 ? sx2 : dx2;

      const s1 = drawsegs.scale1[d]!;
      const s2 = drawsegs.scale2[d]!;
      const scale = s1 > s2 ? s1 : s2;
      const lowscale = s1 > s2 ? s2 : s1;

      if (scale < sprScale || (lowscale < sprScale && !pointOnSegSide(pGx[i]!, pGy[i]!, drawsegs.seg[d]!))) {
        // seg is BEHIND the sprite: paint its masked range first (vanilla
        // R_RenderMaskedSegRange), draw nothing else here.
        if (masked !== CLIP_NULL) renderMaskedSegRange(d, r1, r2);
        continue;
      }

      let sil = sil0;
      if (gz >= drawsegs.bsilheight[d]!) sil &= ~SIL_BOTTOM;
      if (gzt <= drawsegs.tsilheight[d]!) sil &= ~SIL_TOP;

      const topRef = drawsegs.sprtopclip[d]!;
      const botRef = drawsegs.sprbottomclip[d]!;
      if (sil === 1) {
        for (let x = r1; x <= r2; x += 1)
          if (clipbot[x] === -2) clipbot[x] = clipValue(botRef, x, VIEWHEIGHT);
      } else if (sil === 2) {
        for (let x = r1; x <= r2; x += 1)
          if (cliptop[x] === -2) cliptop[x] = clipValue(topRef, x, VIEWHEIGHT);
      } else if (sil === 3) {
        for (let x = r1; x <= r2; x += 1) {
          if (clipbot[x] === -2) clipbot[x] = clipValue(botRef, x, VIEWHEIGHT);
          if (cliptop[x] === -2) cliptop[x] = clipValue(topRef, x, VIEWHEIGHT);
        }
      }
    }

    for (let x = sx1; x <= sx2; x += 1) {
      if (clipbot[x] === -2) clipbot[x] = VIEWHEIGHT; // unclipped columns
      if (cliptop[x] === -2) cliptop[x] = -1;
    }

    drawVisSprite(i, patch);
  }

  /** R_DrawVisSprite + the R_DrawMaskedColumn post walk (see file header). */
  function drawVisSprite(i: number, patch: SpritePatch): void {
    const cmap = pColormap[i]!;
    if (cmap < 0) {
      // NULL colormap = shadow draw. UNREACHABLE for the static roster
      // (no MF_SHADOW things — plan §4); drawFuzzColumnUnused is the named
      // stub M8 replaces. Never silently draws.
      drawFuzzColumnUnused();
      return;
    }
    const xiscale = pXiscale[i]!;
    const iscale = Math.abs(xiscale);
    const texturemid = pTexturemid[i]!;
    const scale = pScale[i]!;
    const sprtopscreen = ((CENTERY << FRACBITS) - FixedMul(texturemid, scale)) | 0;
    let frac = pStartfrac[i]!;

    const height = patch.height;
    for (let x = pX1[i]!; x <= pX2[i]!; x += 1, frac = (frac + xiscale) | 0) {
      const tc = frac >> FRACBITS;
      if (tc < 0 || tc >= patch.width) continue; // vanilla RANGECHECK abort
      const col = patch.columns[tc]!;

      // Post runs = maximal non-zero runs of the decoded column (0 = post
      // gap → nothing drawn there, walls beneath survive).
      let r = 0;
      while (r < height) {
        if (col[r] === TRANSPARENT) {
          r += 1;
          continue;
        }
        let end = r + 1;
        while (end < height && col[end] !== TRANSPARENT) end += 1;

        const topscreen = (sprtopscreen + scale * r) | 0; // PLAIN multiply
        const bottomscreen = (topscreen + scale * (end - r)) | 0;
        let yl = (topscreen + FRACUNIT - 1) >> FRACBITS;
        let yh = (bottomscreen - 1) >> FRACBITS;
        if (yh >= clipbot[x]!) yh = clipbot[x]! - 1;
        if (yl <= cliptop[x]!) yl = cliptop[x]! + 1;
        if (yl <= yh) {
          // R_DrawColumn loop with dc_texturemid = basetexturemid − (r<<16)
          // and post-relative source (see header for the decoded-column
          // equivalence, &127 wrap included).
          let f = (texturemid - ((r << 16) | 0) + (yl - CENTERY) * iscale) | 0;
          let y = yl;
          let rem = yh - yl;
          do {
            const src = (col[r + ((f >> FRACBITS) & 127)] ?? TRANSPARENT) as number;
            indices[y * RENDER_WIDTH + x] = colormaps[cmap + src]!;
            y += 1;
            f = (f + iscale) | 0;
            rem -= 1;
          } while (rem >= 0);
        }
        r = end;
      }
    }
  }

  const pool: SpritePool = {
    get count() {
      return count;
    },
    x1: pX1,
    x2: pX2,
    scale: pScale,
    gx: pGx,
    gy: pGy,
    gz: pGz,
    gzt: pGzt,
    texturemid: pTexturemid,
    startfrac: pStartfrac,
    xiscale: pXiscale,
    patch: pPatch,
    colormap: pColormap,
    sortOrder,
  };

  return {
    clearSprites(): void {
      count = 0; // vissprite_p = vissprites
      overflow = 0;
    },
    addSectorSprites,
    projectSprite,
    sortVisSprites,
    drawSprite,
    drawSprites(): void {
      sortVisSprites();
      for (let n = 0; n < count; n += 1) drawSprite(sortOrder[n]!);
    },
    pool,
    visspriteOverflow(): number {
      return overflow;
    },
  };
}

/**
 * Named FUZZ stub (R_DrawFuzzColumn, r_draw.c) — reachable only via a
 * NULL-colormap vissprite, which the M4 static roster never produces
 * (no MF_SHADOW map things — plan §4/M8). Throws so an accidental static
 * shadow thing fails loudly instead of drawing nothing silently.
 */
export function drawFuzzColumnUnused(): never {
  throw new Error('vissprites: MF_SHADOW fuzz draw is not implemented until M8');
}
