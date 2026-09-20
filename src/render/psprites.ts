// render/psprites.ts — the weapon view layer (r_things.c R_DrawPSprite +
// R_DrawPlayerSprites TRANSLATION, M7-07).
//
// Mirror facts (linuxdoom-1.10 r_things.c:644-775, re-read for this task):
//  * `R_DrawPSprite(psp)` (r_things.c:644-762): sprite/frame → lump/flip
//    (frame slot 0, psprites never rotate), `tx = sx - 160*FRACUNIT`,
//    `tx -= spriteoffset`, x1/x2 through `FixedMul(tx, pspritescale)` (a
//    psprite is screen-SPACE fixed — no world projection, no clipping vs
//    the world: R_DrawPlayerSprites sets `mfloorclip = screenheightarray`
//    (full height) and `mceilingclip = negonearray`, so the post-walk clip
//    degenerates to the screen bounds), `texturemid = (BASEYCENTER<<16) +
//    FRACUNIT/2 - (sy - spritetopoffset)`, `scale = pspritescale
//    <<detailshift` (detailshift = 0 always here), flip ⇒ `xiscale =
//    -pspriteiscale`, `startfrac = width<<16 - 1`.
//  * psprite geometry (r_main.c:722-723 R_ExecuteSetViewSize):
//    `pspritescale = FRACUNIT*viewwidth/SCREENWIDTH` = FRACUNIT at the
//    fixed 320 width (this port has no detailshift/hi-res branch — M3 set),
//    `pspriteiscale = FRACUNIT`.
//  * Colormap ladder (r_things.c:712-731): invisibility power (`>4*32 ||
//    &8`) ⇒ fuzz (NULL colormap); `fixedcolormap` ⇒ that row;
//    `frame & FF_FULLBRIGHT` ⇒ colormaps row 0 (FULLBRIGHT IS LIVE here —
//    unlike the M4 static roster, flash states carry the bit in their
//    info.c frames); else `spritelights[MAXLIGHTSCALE-1]` — the row from
//    R_DrawPlayerSprites: `(player sector lightlevel >> LIGHTSEGSHIFT) +
//    extralight`, clamped [0, LIGHTLEVELS).
//  * `R_DrawPlayerSprites` (r_things.c:764-790): loop psprites[], draw the
//    active ones — LAST in the frame (r_things.c:985, after the world
//    sprites + masked middles): the gun draws OVER the world. (The plan
//    §M7-07 phrase "drawn before world sprites" is the one point where the
//    mirror disagrees; the mirror wins — draw order documented here.)
//  * The vissprite is vanilla's stack `avis`: ONE scratch record, drawn
//    immediately — no pool slot, no sort (psprites never enter the
//    R_SortVisSprites list).
//
// Wiring status (M7-10): renderer.ts is the single call site — the frame's
// OPTIONAL `deps.psprites` (src/pspriteview.ts resolves the sim rows) makes
// `drawPlayerSprites` the LAST 3D pass, r_things.c:985-true. The dep is
// OMITTED everywhere else, so every pre-M7-10 golden is untouched by
// construction (golden gate) and the shape is pinned by psprites.test.ts's
// wiring-guard.
//
// Zone discipline: imports core + wad TYPES + render (no sim/p_pspr — the
// caller resolves psprite STATE rows into {sprite, frame} pairs; this zone
// may not import sim modules except sim/state, eslint doom/zones/render).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACBITS, FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import type { Framebuffer } from './framebuffer';
import { RENDER_HEIGHT, RENDER_WIDTH } from './framebuffer';
import { COLORMAP_STRIDE, LIGHTLEVELS, MAXLIGHTSCALE, type LightTables } from './lights';
import { frameLump, frameFlip, lookupFrame, type InstalledSprites } from './rthings';
import { CENTERXFRAC, CENTERY } from './view';
import type { SpritePatch } from './vissprites';
import type { ViewState } from './view';

/* ------------------------------------------------------------------ */
/* r_things.c defines                                                  */
/* ------------------------------------------------------------------ */

/** r_things.c:47 — `#define BASEYCENTER 100`. */
export const BASEYCENTER = 100;

/** r_main.c:722-723 at viewwidth == SCREENWIDTH, detailshift = 0. */
export const PSPRITESCALE = FRACUNIT;
export const PSPRITEISCALE = FRACUNIT;

/** p_pspr.h frame flag (psprite frames carry the fullbright bit). */
export const FF_FULLBRIGHT = 0x8000;
export const FF_FRAMEMASK = 0x7fff;

/** One ACTIVE psprite resolved for drawing: the caller (M7-07 wiring)
 * reads sim psprite state + state-table sprite/frame; null = inactive
 * (vanilla `psp->state == NULL`). sx/sy are the pspdef fixed coords. */
export interface PspriteView {
  readonly sprite: number;
  readonly frame: number;
  readonly sx: number;
  readonly sy: number;
}

export interface PspritePassOptions {
  readonly fb: Framebuffer;
  readonly view: ViewState;
  readonly sprites: InstalledSprites;
  readonly patches: ReadonlyMap<number, SpritePatch>;
  readonly lights: LightTables;
  /** R_DrawFuzzColumn half (invisibility psprite shadow). Default: NAMED
   * STUB — counted, draws nothing (M7-06/08 territory; vanilla fuzz for
   * the PLAYER psprites under a powerup invisibility). */
  readonly drawFuzzColumn?: () => void;
}

/** Per-frame inputs R_DrawPlayerSprites pulls from viewplayer. */
export interface PspriteFrameCtx {
  /** sector lightlevel of the player's subsector sector. */
  readonly sectorLight: number;
  /** player->powers[pw_invisibility] (vanilla gate `>4*32 || &8`). */
  readonly invisibility: number;
}

/** The scratch vissprite (vanilla `avis`) — exposed read-only for tests
 * (L2/L3 assertions on what WOULD be drawn); no pool, no sort. */
export interface PspriteScratch {
  x1: number;
  x2: number;
  texturemid: number;
  scale: number;
  xiscale: number;
  startfrac: number;
  patch: number;
  /** colormaps byte offset; -1 = fuzz (shadow draw). */
  colormap: number;
  /** columns drawn this frame (drawSprite calls that passed the clip). */
  drawn: number;
}

export interface PspritePass {
  /** R_DrawPlayerSprites: select the spritelights row, draw each active
   * psprite (index order = weapon then flash, vanilla psp loop order). */
  drawPlayerSprites(psprites: readonly (PspriteView | null)[], ctx: PspriteFrameCtx): void;
  /** R_DrawPSprite for one resolved psprite (exported for tests). */
  drawPsprite(psp: PspriteView, spritelightsRow: number, invis: number): void;
  readonly scratch: PspriteScratch;
}

/**
 * One psprite pass. `view`/`fb`/`lights` are read live per frame
 * (setupView semantics, same idiom as vissprites.ts).
 */
export function createPspritePass(opts: PspritePassOptions): PspritePass {
  const { fb, view, sprites, lights } = opts;
  const indices = fb.indices;
  const colormaps = lights.colormaps;
  const drawFuzz = opts.drawFuzzColumn ?? fuzzStub;

  const scratch: PspriteScratch = {
    x1: 0,
    x2: 0,
    texturemid: 0,
    scale: PSPRITESCALE,
    xiscale: PSPRITEISCALE,
    startfrac: 0,
    patch: -1,
    colormap: 0,
    drawn: 0,
  };

  /** R_DrawVisSprite + the R_DrawMaskedColumn post walk on the decoded
   * columns (vissprites.ts idiom: 0 = post gap). The mfloorclip/
   * mceilingclip degeneracy (screenheightarray / negonearray) collapses
   * the clip to [0, RENDER_HEIGHT-1]. */
  function drawVisSprite(patch: SpritePatch, cmapOff: number, fuzz: boolean): void {
    if (fuzz) {
      drawFuzz();
      return;
    }
    const iscale = PSPRITEISCALE; // |xiscale| with the full-width scale
    const texturemid = scratch.texturemid;
    const scale = scratch.scale;
    const sprtopscreen = ((CENTERY << FRACBITS) - FixedMul(texturemid, scale)) | 0;
    let frac = scratch.startfrac;
    const xiscale = scratch.xiscale;
    const height = patch.height;

    for (let x = scratch.x1; x <= scratch.x2; x += 1, frac = (frac + xiscale) | 0) {
      const tc = frac >> FRACBITS;
      if (tc < 0 || tc >= patch.width) continue; // vanilla RANGECHECK abort
      const col = patch.columns[tc]!;

      let r = 0;
      while (r < height) {
        if (col[r] === 0) {
          r += 1;
          continue;
        }
        let end = r + 1;
        while (end < height && col[end] !== 0) end += 1;

        const topscreen = (sprtopscreen + scale * r) | 0; // PLAIN multiply
        const bottomscreen = (topscreen + scale * (end - r)) | 0;
        let yl = (topscreen + FRACUNIT - 1) >> FRACBITS;
        let yh = (bottomscreen - 1) >> FRACBITS;
        if (yh >= RENDER_HEIGHT) yh = RENDER_HEIGHT - 1; // mfloorclip=viewheight
        if (yl <= -1) yl = 0; //                mceilingclip=negonearray
        if (yl <= yh) {
          let f = (texturemid - ((r << 16) | 0) + (yl - CENTERY) * iscale) | 0;
          let y = yl;
          let rem = yh - yl;
          do {
            const src = col[r + ((f >> FRACBITS) & 127)] ?? 0;
            indices[y * RENDER_WIDTH + x] = colormaps[cmapOff + src]!;
            y += 1;
            f = (f + iscale) | 0;
            rem -= 1;
          } while (rem >= 0);
          scratch.drawn += 1;
        }
        r = end;
      }
    }
  }

  function drawPsprite(psp: PspriteView, spritelightsRow: number, invis: number): void {
    // decide which patch to use (R_DrawPSprite: sprdef + frame slot 0)
    const gf = lookupFrame(sprites, psp.sprite, psp.frame & FF_FRAMEMASK);
    if (gf < 0) return; // vanilla RANGECHECK I_Error; absent ⇒ nothing
    const lump = frameLump(sprites, gf, 0);
    if (lump < 0) return;
    const flip = frameFlip(sprites, gf, 0);
    const patch = opts.patches.get(lump);
    if (patch === undefined || patch.width === 0) return;

    // calculate edges of the shape
    let tx = (psp.sx - 160 * FRACUNIT) | 0;
    tx = (tx - patch.offsetX) | 0;
    const x1 = (CENTERXFRAC + FixedMul(tx, PSPRITESCALE)) >> FRACBITS;
    if (x1 > RENDER_WIDTH) return; // off the right side

    tx = (tx + patch.widthFixed) | 0;
    const x2 = ((CENTERXFRAC + FixedMul(tx, PSPRITESCALE)) >> FRACBITS) - 1;
    if (x2 < 0) return; // off the left side

    // store into the scratch vissprite (vanilla `avis`)
    scratch.patch = lump;
    scratch.texturemid =
      (BASEYCENTER << FRACBITS) + FRACUNIT / 2 - (psp.sy - patch.topOffsetFixed);
    scratch.x1 = x1 < 0 ? 0 : x1;
    scratch.x2 = x2 >= RENDER_WIDTH ? RENDER_WIDTH - 1 : x2;
    scratch.scale = PSPRITESCALE; // <<detailshift, detailshift = 0
    scratch.xiscale = flip ? -PSPRITEISCALE : PSPRITEISCALE;
    scratch.startfrac = flip ? patch.widthFixed - 1 : 0;
    if (scratch.x1 > x1) {
      scratch.startfrac = (scratch.startfrac + scratch.xiscale * (scratch.x1 - x1)) | 0;
    }

    // colormap ladder (r_things.c:712-731)
    const fuzz = invis > 4 * 32 || (invis & 8) !== 0;
    if (fuzz) {
      scratch.colormap = -1; // shadow draw
    } else if (view.fixedcolormap >= 0) {
      scratch.colormap = view.fixedcolormap * COLORMAP_STRIDE;
    } else if ((psp.frame & FF_FULLBRIGHT) !== 0) {
      scratch.colormap = 0; // colormaps row 0 — FULLBRIGHT LIVE for psprites
    } else {
      scratch.colormap =
        lights.scalelight[spritelightsRow * MAXLIGHTSCALE + (MAXLIGHTSCALE - 1)]!;
    }

    drawVisSprite(patch, fuzz ? 0 : scratch.colormap, fuzz);
  }

  return {
    drawPlayerSprites(psprites, ctx): void {
      // get light level (r_things.c:769-778): sector light + extralight
      const lightnum = (ctx.sectorLight >> 4) + view.extralight;
      const row = lightnum < 0 ? 0 : lightnum >= LIGHTLEVELS ? LIGHTLEVELS - 1 : lightnum;
      scratch.drawn = 0;
      for (const psp of psprites) {
        if (psp) drawPsprite(psp, row, ctx.invisibility);
      }
    },
    drawPsprite,
    scratch,
  };
}

/** Named fuzz stub (M7-06/08 replace): counted no-op — the shadow psprite
 * never silently draws nothing under an invisibility until it is wired. */
let fuzzCount = 0;
function fuzzStub(): void {
  fuzzCount += 1;
}
export function pspriteFuzzCalls(): number {
  return fuzzCount;
}
export function resetPspriteFuzzCalls(): void {
  fuzzCount = 0;
}
