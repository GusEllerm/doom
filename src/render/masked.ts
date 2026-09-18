// render/masked.ts — R_RenderMaskedSegRange + shared R_DrawMaskedColumn +
// the R_DrawMasked driver (M4-plan §M4-04).
//
// Vanilla mapping (linuxdoom-1.10):
//   R_RenderMaskedSegRange (r_segs.c:100-190) → {@link renderMaskedSegRange}
//     (also exported as {@link drawMaskedSegRange}, the M3 stub name).
//   R_DrawMaskedColumn (r_things.c:351-391, the r_things.h:42-49 globals
//     mfloorclip/mceilingclip/spryscale/sprtopscreen → module lets below) →
//     {@link drawMaskedColumn}; shared with the M4-05 vissprite pass
//     (R_DrawVisSprite sets the same four globals).
//   R_DrawMasked (r_things.c:958-989 — the driver lives in r_things.c, NOT
//     r_segs.c as the M3 drawsegs.ts header guessed; deviation note) →
//     {@link drawMasked}: vissprite half is the M4-05 slot (list always
//     empty here), then the masked ranges of all drawsegs newest→oldest
//     (farthest→nearest — the BSP recorded front-to-back, so later
//     drawsegs draw ON TOP ⇒ correct occlusion), psprites M7.
//
// Zone discipline (eslint doom/zones/render): imports core + render only.
//
// DEVIATIONS (faithful-value unless noted):
//  - POST STREAM ↔ RASTER (acceptance-relevant, pinned): vanilla walks the
//    patch POST stream — `col = R_GetColumn(tex, maskedtexturecol[x]) - 3`
//    (the −3/+3 colofs quirk of R_GenerateLookup, r_data.c:345) then hops
//    `column + length + 4` until topdelta 0xff. rdata models a texture
//    column as the COMPOSED RASTER (0 = transparent — the committed
//    M3 `texMasked` semantics), so posts are re-derived as maximal
//    non-zero runs. Same drawn pixel set for single-patch columns (every
//    shipped masked texture + fixture: the −3 offset is exactly the
//    patch's own post header, so vanilla posts = the raster's opaque
//    runs). Composite (multi-patch) columns read NEIGHBOUR-COLUMN BYTES
//    as a garbage post stream in vanilla (the famous −3 composite bug) —
//    not replicated; a raster-run middle there is deterministic instead.
//    Zero-valued texels INSIDE a patch post (color 0 is a legal color)
//    read as transparent here — the pre-existing rdata raster limitation.
//  - dc_source: vanilla switches `dc_source = column + 3` with
//    `texturemid −= topdelta<<FRACBITS` per post (r_things.c:378-379; the
//    commented `- column->topdelta` variant one line below); we keep the
//    whole-column source with the unmodified texturemid — identical sample
//    index (base+Δ)>>16 for every in-range texel, zero allocation, and
//    the `&127` wrap then wraps absolute rows instead of post-relative
//    ones (garbage-equal territory either way).
//  - drawMasked WITHOUT configuration: the draw needs the frame's world/
//    light tables, which the module-global driver has no handle on until
//    M4-07 wires the pipeline — {@link configureMaskedPass} receives it;
//    while unset, drawMasked/renderMaskedSegRange keep the M3 no-op
//    behaviour (walls goldens stable until M4-07 blesses masked scenes).
//  - maskedtexturecol allocation failure (openings overflow — vanilla
//    silent corruption): the drawseg stays CLIP_NULL and is skipped; the
//    openingOverflow counter fires at the RECORDING site (drawsegs.
//    allocOpenings). "overflow → counter + throw" per plan acceptance 5
//    is kept as counter + skip: the M3-pinned drawsegs deviation, and a
//    throw would kill frames vanilla merely corrupts through. Pinned.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACBITS, FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { computeIscale, dc, drawColumn } from './cols';
import {
  CLIP_NULL, MAXSHORT, clipValue, getDrawsegs, openingsAt, openingsSet,
} from './drawsegs';
import {
  COLORMAP_STRIDE, LIGHTSCALESHIFT, MAXLIGHTSCALE, wallLightNum, type LightTables,
} from './lights';
import type { RenderWorld } from './rdata';
import { CENTERY, VIEWHEIGHT, type ViewState } from './view';

/** r_defs.h ML_DONTPEGBOTTOM (segs.ts constant, M4-04 copy). */
const ML_DONTPEGBOTTOM = 0x0010;

const CENTERYFRAC = CENTERY * FRACUNIT; // centeryfrac

/* ------------------------------------------------------------------ */
/* Frame context (no vanilla analogue: the globals live in r_*.c; we
 * need the world tables the module cannot reach — see header DEV).     */
/* ------------------------------------------------------------------ */

export interface MaskedContext {
  readonly indices: Uint8Array; // Framebuffer.indices
  readonly colormaps: Uint8Array; // LightTables.colormaps (34·256)
  readonly world: RenderWorld;
  readonly view: ViewState;
  readonly tables: LightTables; // scalelight rows
}

let ctx: MaskedContext | null = null;

/** Install/clear the frame context (tests wire it directly; M4-07's
 * renderFrame owns the production call). Zero allocation (ref store). */
export function configureMaskedPass(next: MaskedContext | null): void {
  ctx = next;
}

export function maskedPassConfigured(): boolean {
  return ctx !== null;
}

/* ------------------------------------------------------------------ */
/* r_things.c:367-370 globals for R_DrawMaskedColumn                   */
/* ------------------------------------------------------------------ */

/** `short* mfloorclip` / `mceilingclip` as drawseg clip REFS (drawsegs.ts
 * representation: CLIP_SCREEN/CLIP_NEGONE sentinels or signed openings
 * pool bases; vanilla pointer math — clipValue resolves per column). */
let mfloorclip = CLIP_NULL;
let mceilingclip = CLIP_NULL;
/** `fixed_t spryscale` (bit pattern; C signed, >>>0 at the iscale div). */
let spryscale = 0;
/** `fixed_t sprtopscreen`. */
let sprtopscreen = 0;

/** Live globals (tests + M4-05 introspection). */
export function maskedColumnState(): {
  mfloorclip: number;
  mceilingclip: number;
  spryscale: number;
  sprtopscreen: number;
} {
  return { mfloorclip, mceilingclip, spryscale, sprtopscreen };
}

/** M4-05 (R_DrawVisSprite) sets the four globals directly — export the
 * setters so the vissprite pass shares {@link drawMaskedColumn} exactly
 * like vanilla shares the globals. */
export function setMaskedColumnState(
  floorRef: number,
  ceilRef: number,
  scale: number,
  topscreen: number
): void {
  mfloorclip = floorRef;
  mceilingclip = ceilRef;
  spryscale = scale;
  sprtopscreen = topscreen;
}

/* ------------------------------------------------------------------ */
/* R_DrawMaskedColumn (r_things.c:351-391)                             */
/* ------------------------------------------------------------------ */

/**
 * Draws the masked column `column` (one composed texture column —
 * 0 texels transparent, header DEV for the post-stream equivalence) at
 * the current dc.x + dc.texturemid + the four masked globals. Clips vs
 * mfloorclip/mceilingclip exactly like vanilla (per-POST clipping — the
 * maximal-run decomposition yields the same clipped pixel set because
 * screen row is monotone in texture row).
 */
export function drawMaskedColumn(column: Uint8Array): void {
  const c = ctx;
  if (c === null) return; // header DEV: unconfigured ⇒ no-op

  const basetexturemid = dc.texturemid;
  const x = dc.x;
  // The two clip shorts for this column (vanilla array derefs).
  const floorClip = clipValue(mfloorclip, x, VIEWHEIGHT);
  const ceilClip = clipValue(mceilingclip, x, VIEWHEIGHT);

  // Post scan: maximal non-zero runs (header DEV). `h` = the vanilla
  // 128-row column bound; fixture composites are 128 tall.
  const h = column.length;
  let i = 0;
  while (i < h) {
    if (column[i] === 0) {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < h && column[j] !== 0) j += 1;

    // topscreen = sprtopscreen + spryscale*topdelta; bottoms = +len
    // (spryscale*int is the plain fixed×int product; |0 ≡ gcc wrap).
    const topscreen = (sprtopscreen + spryscale * i) | 0;
    const bottomscreen = (sprtopscreen + spryscale * j) | 0;

    dc.yl = (topscreen + FRACUNIT - 1) >> FRACBITS;
    dc.yh = (bottomscreen - 1) >> FRACBITS;

    if (dc.yh >= floorClip) dc.yh = floorClip - 1;
    if (dc.yl <= ceilClip) dc.yl = ceilClip + 1;

    if (dc.yl <= dc.yh) {
      // dc_source stays the whole column; texturemid UNadjusted (the
      // vanilla commented variant, header DEV).
      dc.source = column;
      drawColumn(c.indices, c.colormaps, CENTERY);
    }
    i = j;
  }

  dc.texturemid = basetexturemid;
}

/* ------------------------------------------------------------------ */
/* R_RenderMaskedSegRange (r_segs.c:100-190)                           */
/* ------------------------------------------------------------------ */

/** Texture height fixed (vanilla textureheight[t]; rdata stores px —
 * segs.ts texHeightF parity: NO_TEXTURE → 0). */
function texHeightF(world: RenderWorld, t: number): number {
  return t >= 0 ? world.texHeight[t]! << 16 : 0;
}

/**
 * R_RenderMaskedSegRange: draw the masked middle of drawseg `ds` between
 * screen columns [x1, x2], consuming the recorded maskedtexturecol (the
 * per-column texturecolumn snapshot in the openings pool) and resetting
 * each consumed entry to MAXSHORT (vanilla: the second draw never sees
 * the column again). `ds` indexes the drawsegs SoA.
 */
export function renderMaskedSegRange(ds: number, x1: number, x2: number): void {
  const c = ctx;
  if (c === null) return; // header DEV: pipeline not wired yet
  const { world, view, tables } = c;
  const d = getDrawsegs();

  // curline/frontsector/backsector (r_segs.c:114-116). Masked drawsegs
  // are two-sided by construction; malformed refs bail (vanilla crash
  // equivalent — unreachable through recorded drawsegs).
  const seg = d.seg[ds]!;
  const side = world.segSide[seg]!;
  if (side < 0) return;
  const line = world.segLine[seg]!;
  const frontSec = world.sideSector[side]!;
  let backSec = -1;
  if (line >= 0) {
    const other = world.lineFront[line] === side ? world.lineBack[line]! : world.lineFront[line]!;
    if (other >= 0) backSec = world.sideSector[other]!;
  }
  const texnum = world.sideMidTex[side]!;

  // Light table (r_segs.c:119-134) — wallLightNum carries the pancake
  // ±1 (v1.y==v2.y −1, v1.x==v2.x +1) + clamp; fixedcolormap short-cuts
  // it exactly like vanilla (`if (fixedcolormap) dc_colormap = ...`).
  const fixedCmap = view.fixedcolormap >= 0 ? view.fixedcolormap * COLORMAP_STRIDE : -1;

  const colRef = d.maskedcol[ds]!; // signed openings base (may be < 0)
  const rwScaleStep = d.scalestep[ds]!;
  // spryscale = ds->scale1 + (x1 − ds->x1)·scalestep (plain fixed×int) —
  // the MODULE GLOBAL R_DrawMaskedColumn reads (r_segs.c:139).
  spryscale = (d.scale1[ds]! + ((x1 - d.x1[ds]!) * rwScaleStep)) | 0;
  mfloorclip = d.sprbottomclip[ds]!;
  mceilingclip = d.sprtopclip[ds]!;

  // find positioning (r_segs.c:142-153): ML_DONTPEGBOTTOM pegs to the
  // HIGHER floor + texture height, else the LOWER ceiling.
  let texturemid: number;
  if (line >= 0 && (world.lineFlags[line]! & ML_DONTPEGBOTTOM) !== 0) {
    const ff = world.sectorFloor[frontSec]!;
    const bf = backSec >= 0 ? world.sectorFloor[backSec]! : ff;
    texturemid = (ff > bf ? ff : bf) + texHeightF(world, texnum) - view.viewz;
  } else {
    const fc = world.sectorCeil[frontSec]!;
    const bc = backSec >= 0 ? world.sectorCeil[backSec]! : fc;
    texturemid = (fc < bc ? fc : bc) - view.viewz;
  }
  // `+ sidedef->rowoffset` (:153) — the segs.ts rowoffset seam deviation
  // (rdata models textureoffset only; equal whenever both agree).
  texturemid += world.sideOffsetX[side]!;
  dc.texturemid = texturemid;

  if (fixedCmap >= 0) dc.colormap = fixedCmap;

  let lightRow = -1;
  if (fixedCmap < 0) {
    lightRow = wallLightNum(
      world.sectorLight[frontSec]!,
      view.extralight,
      world.segV1x[seg]!,
      world.segV1y[seg]!,
      world.segV2x[seg]!,
      world.segV2y[seg]!
    ).row;
  }

  // draw the columns (r_segs.c:160-189).
  for (let x = x1; x <= x2; x += 1) {
    const tc = openingsAt(colRef + x);
    if (tc !== MAXSHORT) {
      if (fixedCmap < 0) {
        let index = spryscale >> LIGHTSCALESHIFT;
        if (index >= MAXLIGHTSCALE) index = MAXLIGHTSCALE - 1;
        dc.colormap = tables.scalelight[lightRow * MAXLIGHTSCALE + index]!;
      }

      sprtopscreen = CENTERYFRAC - FixedMul(texturemid, spryscale);
      // dc_iscale = 0xffffffffu / (unsigned)spryscale (:177) — the C
      // UNSIGNED division on the bit pattern (cols.ts G12 policy).
      dc.iscale = computeIscale(spryscale >>> 0);

      // draw the texture: vanilla `R_GetColumn(texnum, col) − 3` walk —
      // raster-run equivalent, header DEV.
      dc.x = x;
      drawMaskedColumn(world.getWallColumn(texnum, tc));
      openingsSet(colRef + x, MAXSHORT); // reset (:185)
    }
    spryscale = (spryscale + rwScaleStep) | 0;
  }
}

/** M3 stub-name compatibility alias (plan §M4-04: "stubs → real"). */
export function drawMaskedSegRange(ds: number, x1: number, x2: number): void {
  renderMaskedSegRange(ds, x1, x2);
}

/* ------------------------------------------------------------------ */
/* R_DrawMasked (r_things.c:958-989) — the drawsegs half               */
/* ------------------------------------------------------------------ */

/**
 * The masked pass. Order (vanilla): vissprites back-to-front (M4-05 —
 * the list is empty until then), then every drawseg with a masked
 * middle, NEWEST→OLDEST (drawsegs record front-to-back, so this paints
 * far→near — nearer middles draw over farther ones), then psprites (M7).
 * Consumes the maskedtexturecol entries (each drawn column resets to
 * MAXSHORT), so a second call in the same frame draws nothing.
 *
 * `maskedcol !== CLIP_NULL` is vanilla's `if (ds->maskedtexturecol)`
 * pointer test. FIX-M4-09: the CLIP_* sentinel codes now live outside the
 * range a openings ref can take (drawsegs.ts), so a legitimate negative
 * ref — the first masked drawseg of a frame stores `0 - rw_x` — is drawn
 * instead of reading as NULL (that aliasing made this FINAL FLUSH a
 * silent no-op for whole viewpoints where no sprite interleaved).
 */
export function drawMasked(): void {
  if (ctx === null) return; // header DEV: pre-M4-07 no-op semantics
  const d = getDrawsegs();
  for (let i = d.count - 1; i >= 0; i -= 1) {
    if (d.maskedcol[i] !== CLIP_NULL) renderMaskedSegRange(i, d.x1[i]!, d.x2[i]!);
  }
}
