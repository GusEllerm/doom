// render/renderer.ts — frame pipeline: the single renderFrame entry
// ARCHITECTURE §4.1 wires together (r_main.c R_RenderPlayerView). M3-07
// shipped the walls-only subset; M4-07 (§M4-07) makes the frame COMPLETE:
// visplanes replace the black clear, static sprites and masked middles draw.
//
// VANILLA ORDER, PINNED (docs/research/03-bsp-renderer.md §2 "this IS the
// frame", verified against linuxdoom-1.10 r_main.c R_RenderPlayerView, and
// re-read for M4-07):
//
//   R_SetupFrame (player);        → setupView             (this step 1)
//   R_ClearClipSegs ();           → clearClipSegs         (step 2)
//   R_ClearDrawSegs ();           → clearDrawsegs         (step 2)
//   R_ClearPlanes ();             → clearPlanes (clip arrays + visplane
//                                   table + basex/y scale; bsp.walk calls it
//                                   again — idempotent, bsp.ts header)
//   R_ClearSprites ();            → pass.clearSprites     (step 2)
//   validcount++; R_RenderBSPNode (numnodes-1);
//                                 → walker.walk: walls + visplane MARKS
//                                   (segs.ts) + R_AddSprites per subsector
//                                   (bsp addSectorSprites) — nothing here
//                                   draws flats or sprites, it only marks
//                                   and queues                              (step 4)
//   R_DrawPlanes ();              → drawPlanes            (step 5)
//   R_DrawMasked ();              → drawSprites THEN drawMasked (steps 6+7:
//                                   r_things.c:958-989 — vissprites sorted
//                                   back-to-front FIRST (each may draw a
//                                   nearer seg's masked range inline), THEN
//                                   the remaining maskedtexturecol ranges
//                                   of every drawseg NEWEST→OLDEST, THEN
//                                   R_DrawPlayerSprites — psprites are the
//                                   M7-10 opt-in deps.psprites pass)
//
// So: planes draw AFTER the whole world pass but BEFORE sprites, and the
// masked middles draw LAST of the 3D passes (later than the sprites that
// already consumed their near neighbours). The four clears touch disjoint
// state, so their mutual order is immaterial; the three DRAW passes' order
// above is the observable one and is asserted by tests/render/pipeline.test.ts.
//
// Per-frame order (this file):
//   1. setupView — R_SetupFrame half: player mo read EVERY frame (warp/pin →
//      next frame renders from it).
//   2. clears: clearClipSegs + clearDrawsegs + clearPlanes + pass.clearSprites
//      + resetRenderCounters (M3-03 seam).
//   3. (no fb.clear — M3 deviation D is CLOSED: uncovered pixels are genuine
//      void/HOM evidence now, plan §1.2 "fb.clear(0) background REMOVED").
//   4. BSP world pass (walls + plane marks + sprite adds).
//   5. drawPlanes — visplane spans + the sky branch (planes.ts).
//   6. pass.drawSprites — R_SortVisSprites + back-to-front R_DrawSprite.
//   7. drawMasked — leftover masked middles, newest→oldest (masked.ts).
//   8. automap overlay — §4.1.9: when the automap state is active the drawer
//      draws INTO THE SAME index buffer after the 3D passes (vanilla
//      AM_Drawer's AM_clearFB covers the view — same semantics here).
//
// Caching: loadRenderWorld/buildRenderMapView happen ONCE at boot (caller
// owns — see main.ts); this module caches the per-map walker + seg callbacks
// + ViewState in a WeakMap so a steady-state frame allocates nothing beyond
// the returned counters copy. A ctx rebuilds when world/fb/tables identity
// changes (tests reuse one map object across fixtures).
//
// viewz placeholder: viewz = mo.z + 41·FRACUNIT (view.ts); `mo.z === MININT`
// is the sim's ONFLOORZ token (sim/player.ts, P_CalcHeight is M5) — treated
// as floor 0 here. The ONFLOORZ literal is repeated rather than imported:
// the render zone may not import sim modules except sim/state (eslint
// doom/zones/render).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { buildSpriteDefs } from '../wad/sprites';
import type { MapData } from '../wad/types';
import type { WadFile } from '../wad/wadfile';
import { drawAutomap, type AutomapGeom, type AutomapMap, type AutomapPlayer } from './automap';
import { createBspWalker, type BspWalker, type WalkCallbacks } from './bsp';
import { clearDrawsegs } from './drawsegs';
import {
  configureMaskedPass,
  drawMasked,
  renderMaskedSegRange,
  type MaskedContext,
} from './masked';
import { clearPlanes, drawPlanes, setSkyflatnum, type PlaneDrawCtx } from './planes';
import type { Framebuffer } from './framebuffer';
import {
  COLORMAP_ROWS,
  COLORMAP_STRIDE,
  initLightTables,
  type LightTables,
} from './lights';
import type { RenderWorld } from './rdata';
import {
  buildStaticThings,
  installSprites,
  type InstalledSprites,
  type StaticThings,
} from './rthings';
import {
  clearClipSegs,
  getRenderCounters,
  resetRenderCounters,
  type RenderCounters,
} from './solidsegs';
import {
  createPspritePass,
  type PspritePass,
  type PspriteView,
} from './psprites';
import { createSegCallbacks } from './segs';
import {
  createSpritePass,
  installSpritePatches,
  type SpritePass,
  type SpritePatch,
} from './vissprites';
import {
  createViewState,
  setupView,
  VIEWWIDTH,
  type RenderMapView,
  type ViewState,
} from './view';

/** sim/player.ts ONFLOORZ (MININT token — see file header for why inline). */
const ONFLOORZ_TOKEN = -2147483648;

/** Structural read-view of the player the renderer needs (the sim Player
 * satisfies it by construction; A-INT1: no sim import from render). */
export interface FramePlayer {
  readonly mo: {
    /** fixed */
    readonly x: number;
    /** fixed */
    readonly y: number;
    /** fixed; ONFLOORZ_TOKEN = "on the floor-0 ground" until M5 physics */
    readonly z?: number;
    /** BAM angle, u32 */
    readonly angle: number;
  };
  /** M5-08 viewz read-through (P_CalcHeight output, fixed). Absent or 0
   * (the sim's "pre-first-tic" spawn pin) ⇒ renderer keeps the
   * z + 41·FRACUNIT placeholder, so frame-0 views stay byte-identical. */
  readonly viewz?: number;
  /** M7-06 read-through: d_player.h `int extralight` in the VANILLA
   * encoding (A_Light0/1/2 write 0/1/2, r_main.c R_SetupFrame adds it to
   * the light number). Absent ⇒ 0 (every pre-M7 frame byte-identical). */
  readonly extralight?: number;
  /** M7-06 read-through: d_player.h `int fixedcolormap` in the VANILLA
   * encoding — 0 means the C NULL pointer (normal lighting), nonzero is
   * the COLORMAP row index (1 = infrared "almost full bright",
   * 32 = INVERSECOLORMAP for invulnerability, p_user.c:362-383). Absent
   * or 0 ⇒ the NULL row (−1 here), so pre-powerup frames stay identical. */
  readonly fixedcolormap?: number;
}

/** Automap overlay bundle (optional dep): `state` is the sim AutomapState
 * (AutomapGeom read-view), `map` the runtime map (AutomapMap read-view),
 * `player` defaults to the frame player when omitted. */
export interface AutomapOverlay {
  readonly state: AutomapGeom;
  readonly map: AutomapMap;
  readonly player?: AutomapPlayer;
}

/**
 * The once-per-map static sprite tables (M4-07 wiring; built by
 * {@link buildMapSprites}): rthings' installed sprite lump table + decoded
 * patches + the mobj-less thing list. rthings' `installSprites` and
 * vissprites' `installSpritePatches` are the expensive halves (lump decode),
 * so they run at map-load exactly once and every frame reuses them
 * ("load render world once", M3-07 pattern).
 */
export interface SpriteTables {
  readonly things: StaticThings;
  readonly sprites: InstalledSprites;
  readonly patches: ReadonlyMap<number, SpritePatch>;
}

/** {@link buildMapSprites} inputs — the same MapData/boot view main.ts
 * already holds plus the lump reader the patch decode needs. */
export interface MapSpriteSource {
  readonly md: MapData;
  readonly map: RenderMapView;
  readonly wad: WadFile;
  /** Menu skill 1..5 for the P_SpawnMapThing filter (rthings default 3). */
  readonly skill?: number;
}

/**
 * Build the once-per-map sprite bundle for one map (plan §M4-07 "world build
 * extends": census → installSprites → installSpritePatches → the static
 * thing list). Omitted from {@link FrameDeps} the frame simply has no
 * sprites (the pre-M4-07 surface); rdata's flat/sky indices are NOT built
 * here — they are part of loadRenderWorld(flatsFromWad(wad)).
 */
export function buildMapSprites(src: MapSpriteSource): SpriteTables {
  const census = buildSpriteDefs(src.wad);
  const sprites = installSprites(census);
  return {
    sprites,
    patches: installSpritePatches(sprites, (n) => src.wad.readLump(n)),
    things: buildStaticThings(
      src.md,
      src.map,
      sprites,
      src.skill === undefined ? {} : { skill: src.skill }
    ),
  };
}

/** Per-frame deps bundle (main.ts builds it once at boot and reuses the
 * object; only `player` state and `automap` matter per frame). */
export interface FrameDeps {
  readonly fb: Framebuffer;
  /** loadRenderWorld output — built once at boot (never per frame). */
  readonly world: RenderWorld;
  /** buildRenderMapView output — same boot-time build. */
  readonly map: RenderMapView;
  readonly player: FramePlayer;
  /** Wad light tables (initLightTables(decodeColormap(COLORMAP))); default
   * = identity rows (zlight/scalelight still real — planes/sprites need
   * rows even when a test has no COLORMAP lump). */
  readonly tables?: LightTables;
  readonly automap?: AutomapOverlay;
  /** M4-07 static sprite pass; omitted ⇒ no sprite pass at all. */
  readonly sprites?: SpriteTables;
  /** M7-10 psprite pass (R_DrawPlayerSprites — gun/muzzle-flash layer):
   * the CALLER resolves the sim pspdefs into PspriteView rows (psprites.ts
   * header contract — src/pspriteview.ts is the shared seam). OMITTED ⇒ no
   * psprite pass at all, so every pre-M7-10 golden/frame is byte-identical
   * by construction; when present the pass draws LAST of the 3D passes
   * (r_things.c:985, after drawMasked, before the automap overlay). */
  readonly psprites?: PspriteFrameInput;
}

/** Per-frame psprite bundle (views row order = vanilla psp loop order:
 * weapon then flash; null = inactive `psp->state == NULL`). */
export interface PspriteFrameInput {
  readonly views: readonly (PspriteView | null)[];
  /** lightlevel of the player's subsector's sector (R_DrawPlayerSprites
   * spritelights row selection). */
  readonly sectorLight: number;
  /** player->powers[pw_invisibility] (vanilla gate `>4*32 || &8`). */
  readonly invisibility?: number;
}

/** renderFrame's return: the solidsegs/plane counters plus the pass-local
 * vissprite drop count (MAXVISSPRITES analogue, r_things.c R_NewVisSprite). */
export interface FrameCounters extends RenderCounters {
  visspriteOverflow: number;
}

/* ------------------------------------------------------------------ */
/* Per-map frame context cache                                          */
/* ------------------------------------------------------------------ */

interface FrameCtx {
  readonly world: RenderWorld;
  readonly fb: Framebuffer;
  /** Resolved identity fallback tables when the caller supplied none (the
   * same 34 identity rows segs.ts defaults to — zlight/scalelight stay
   * real so planes/sprites always have rows). */
  readonly tables: LightTables;
  readonly walker: BspWalker;
  readonly view: ViewState;
  readonly cbs: WalkCallbacks;
  /** null ⇒ no sprite pass (deps.sprites omitted). */
  readonly sprites: SpriteTables | null;
  readonly pass: SpritePass | null;
  /** null ⇒ no psprite pass (sprites absent — the pass needs the patch
   * decode; deps.psprites presence is checked per FRAME, not here, since
   * the views change every frame without any identity to cache on). */
  readonly pspPass: PspritePass | null;
  /** Reinstalled as masked.ts' frame context every frame (ref store, zero
   * alloc; masked.ts owns the draw's globals). */
  readonly maskedCtx: MaskedContext;
  /** Reused R_DrawPlanes context (drawPlanes reads it per call). */
  readonly planeCtx: PlaneDrawCtx;
}

const ctxCache = new WeakMap<RenderMapView, FrameCtx>();

/** segs.ts' private default (identity 34 rows) is needed here too now that
 * the plane/sprite passes require a LightTables object. */
let fallbackTables: LightTables | undefined;
function defaultLightTables(): LightTables {
  if (fallbackTables === undefined) {
    const rows = new Uint8Array(COLORMAP_ROWS * COLORMAP_STRIDE);
    for (let i = 0; i < rows.length; i += 1) rows[i] = i & 255;
    fallbackTables = initLightTables(rows);
  }
  return fallbackTables;
}

function sameSprites(a: SpriteTables | null, b: SpriteTables | undefined): boolean {
  if (a === null) return b === undefined;
  return (
    b !== undefined &&
    a.things === b.things &&
    a.sprites === b.sprites &&
    a.patches === b.patches
  );
}

function getCtx(deps: FrameDeps): FrameCtx {
  const tables = deps.tables ?? defaultLightTables();
  let ctx = ctxCache.get(deps.map);
  if (
    ctx === undefined ||
    ctx.world !== deps.world ||
    ctx.fb !== deps.fb ||
    ctx.tables !== tables ||
    !sameSprites(ctx.sprites, deps.sprites)
  ) {
    const view = createViewState();
    const segs = createSegCallbacks(deps.fb, deps.world, view, deps.map, tables);
    const sprites = deps.sprites ?? null;
    const pass = sprites === null
      ? null
      : createSpritePass({
        fb: deps.fb,
        view,
        world: deps.world,
        lights: tables,
        things: sprites.things,
        sprites: sprites.sprites,
        patches: sprites.patches,
        // M4-04's real R_RenderMaskedSegRange (vissprites.ts defaults to a
        // named stub — this is the wiring point plan §M4-05 left open).
        renderMaskedSegRange,
      });
    // planes.ts keeps skyflatnum in module state (r_sky.h global); rdata
    // resolved it per world (g_game.c:454) and segs.ts/bsp.ts compare
    // against it — the wiring point is here (segs.ts header note).
    setSkyflatnum(deps.world.skyflatnum);
    ctx = {
      world: deps.world,
      fb: deps.fb,
      tables,
      walker: createBspWalker(deps.map, deps.world),
      view,
      pspPass:
        sprites === null
          ? null
          : createPspritePass({
            fb: deps.fb,
            view,
            sprites: sprites.sprites,
            patches: sprites.patches,
            lights: tables,
          }),
      // The BSP callbacks: segs (solidsegs + storeWallRange + seg loop)
      // plus R_AddSprites at the R_Subsector call site (r_bsp.c:546, BEFORE
      // the seg loop — bsp.renderSubsector already places it there).
      cbs: sprites === null
        ? segs
        : { ...segs, addSectorSprites: (sector: number): void => pass!.addSectorSprites(sector) },
      sprites,
      pass,
      maskedCtx: {
        indices: deps.fb.indices,
        colormaps: tables.colormaps,
        world: deps.world,
        view,
        tables,
      },
      planeCtx: {
        view,
        indices: deps.fb.indices,
        tables,
        getFlat: (picnum: number): Uint8Array => deps.world.getFlatPixels(picnum),
        getSkyColumn: (angle1024: number): Uint8Array => deps.world.getSkyColumn(angle1024),
      },
    };
    ctxCache.set(deps.map, ctx);
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* renderFrame                                                          */
/* ------------------------------------------------------------------ */

/**
 * One full frame into `deps.fb` (exact order + the pinned vanilla call sites
 * in the file header). Returns the post-frame counters — hom and all four
 * overflow counters must be 0 on healthy maps (M4-plan §1.3). Deterministic:
 * same world + tables + player ⇒ byte-identical buffer (L3).
 */
export function renderFrame(deps: FrameDeps): FrameCounters {
  const ctx = getCtx(deps);

  // 1. R_SetupFrame half — player read fresh every frame (warp takes
  //    effect on the very next frame, no stale view).
  const mo = deps.player.mo;
  const z = mo.z === undefined || mo.z === ONFLOORZ_TOKEN ? 0 : mo.z;
  // M5-08 viewz read-through: once P_CalcHeight has written player.viewz
  // (nonzero — 0 is the documented spawn pin until the first tic), the eye
  // height carries bob/squat/ceiling-clamp verbatim. Pre-first-tic frames
  // fall back to the z+41<<16 placeholder — frame-0 goldens unmoved.
  const vz = deps.player.viewz;
  setupView(ctx.view, {
    x: mo.x,
    y: mo.y,
    z,
    angle: mo.angle,
    viewz: vz !== undefined && vz !== 0 ? vz : undefined,
    // M7-06 powerup read-through (r_main.c:847-859): the sim carries the
    // vanilla 0 = NULL encoding, the ViewState the −1 sentinel.
    extralight: deps.player.extralight ?? 0,
    fixedcolormap:
      deps.player.fixedcolormap !== undefined && deps.player.fixedcolormap !== 0
        ? deps.player.fixedcolormap
        : -1,
  });

  // 2. R_ClearClipSegs / R_ClearDrawSegs / R_ClearPlanes (clip arrays +
  //    visplane table + base x/y scales; bsp.walk repeats it idempotently)
  //    / R_ClearSprites, then the counter reset (M3-03 seam).
  clearClipSegs(VIEWWIDTH);
  clearDrawsegs();
  clearPlanes(ctx.view);
  ctx.pass?.clearSprites();
  resetRenderCounters();

  // 3. M3 deviation D CLOSED — no fb.clear(0). Anything left unpainted by a
  //    plane, wall, sprite or masked middle is the genuine void (sky/black),
  //    never a cleared background.

  // 4. The masked pass reads the world/view/tables through this context
  //    (masked.ts holds no refs of its own between frames).
  configureMaskedPass(ctx.maskedCtx);

  // 5. R_RenderBSPNode (walker.walk defaults the root to bspRoot(map)) —
  //    walls + visplane marks + R_AddSprites. validcount++ lives in bsp.walk
  //    (the r_main.c:862 analogue).
  ctx.walker.walk(ctx.view, ctx.cbs);

  // 6. R_DrawPlanes — visplane spans (flats through zlight, sky per column).
  drawPlanes(ctx.planeCtx);

  // 7. R_DrawMasked: half 1 = vissprites sorted ascending scale and drawn
  //    back-to-front (each R_DrawSprite may paint a NEARER seg's masked
  //    range inline); half 2 = every leftover maskedtexturecol range,
  //    drawsegs newest→oldest. (Half 3, psprites, is the opt-in pass below.)
  ctx.pass?.drawSprites();
  drawMasked();

  // 7.5 R_DrawPlayerSprites (M7-10 wiring of the M7-07 layer): the psprite
  // pass draws LAST of the 3D passes — the gun draws OVER the world. Omitted
  // deps.psprites ⇒ byte-identical pre-M7 frames (every legacy golden).
  if (deps.psprites !== undefined && ctx.pspPass !== null) {
    ctx.pspPass.drawPlayerSprites(deps.psprites.views, {
      sectorLight: deps.psprites.sectorLight,
      invisibility: deps.psprites.invisibility ?? 0,
    });
  }

  // 8. §4.1.9 — automap/HUD overlays draw into the same buffer AFTER the
  // 3D passes; AM_Responder owns the toggle (Tab), state.am gates this.
  const am = deps.automap;
  if (am !== undefined && am.state.automapactive) {
    drawAutomap(deps.fb, am.state, am.map, am.player ?? deps.player);
  }

  lastVisspriteOverflow = ctx.pass?.visspriteOverflow() ?? 0;
  return { ...getRenderCounters(), visspriteOverflow: lastVisspriteOverflow };
}

let lastVisspriteOverflow = 0;

/** Live counters for the debug/e2e surface (ARCHITECTURE §7 state().render):
 * the solidsegs/plane counters are frame-live; the vissprite drop count is
 * snapshotted from the last completed frame (the pass zeroes it in its own
 * clear step, so reading it outside a frame needs this seam — vissprites.ts
 * is not M4-07-owned). */
export function getFrameCounters(): FrameCounters {
  return { ...getRenderCounters(), visspriteOverflow: lastVisspriteOverflow };
}

/** Re-export the golden-suite/e2e counter entry (plan §M3-07 Produces). */
export { getRenderCounters };
