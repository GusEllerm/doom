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
import { drawViewBorder, fillBackScreen } from './borders';
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
  createMobjOverlay,
  installSprites,
  type InstalledSprites,
  type LiveMobjView,
  type MobjOverlay,
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
  consumeViewSetSizeNeeded,
  createViewState,
  setupView,
  viewSize,
  VIEWWIDTH,
  type RenderMapView,
  type ViewState,
} from './view';
import { screens, vInit } from './vvideo';

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
  /**
   * M9-09 LIVE-MOBJ roster (the D018 flip, plan §M9-09): when present,
   * R_AddSprites walks the LIVE thinglist (rthings createMobjOverlay —
   * the mobjs SUPERSEDE the static census, never merge, so nothing is
   * drawn twice: every map thing already spawned an mobj through the
   * P_SpawnMapThing analogue). OMITTED ⇒ the mobj-less static census
   * (every M4-M8 golden stays byte-identical by construction — the
   * overlay stays in useStatic mode).
   */
  readonly mobjs?: Iterable<LiveMobjView>;
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
  /** M9-09: live-mobj thinglist overlay around sprites.things (null ⇒ no
   * sprite pass at all). renderFrame swaps live/static mode per FRAME. */
  readonly overlay: MobjOverlay | null;
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
    // M9-09: the pass draws through the OVERLAY's stable `things`
    // identity; live/static mode is a per-frame field swap inside it.
    const overlay =
      sprites === null ? null : createMobjOverlay(sprites.things, deps.map, sprites.sprites);
    const pass = sprites === null
      ? null
      : createSpritePass({
        fb: deps.fb,
        view,
        world: deps.world,
        lights: tables,
        things: overlay!.things,
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
      overlay,
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

  // 2.5 M9-09 live-mobj roster swap (before the BSP pass so R_AddSprites
  // sees this frame's thinglists; useStatic keeps M4-M8 goldens exact).
  if (deps.mobjs !== undefined) ctx.overlay?.update(deps.mobjs);
  else ctx.overlay?.useStatic();

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

/* ================================================================== */
/* D_Display composition (M9-09 — plan §M9-09, d_main.c:193-330)       */
/* ================================================================== */

/* d_main.h gamestate_t (doomdef.h:128-133) — numeric truth mirrored so
 * the render zone never imports sim/game (A-INT1; the caller passes
 * GameState.gamestate straight through). */
export const GS_LEVEL = 0;
export const GS_INTERMISSION = 1;
export const GS_FINALE = 2;
export const GS_DEMOSCREEN = 3;

/** The d_main.c D_Display globals the composition reads (a structural
 * read-view of the M9-03 GameState fields — the live GameState satisfies
 * it for the flow half; automapactive lives in the automap STATE, so the
 * caller assembles it here). */
export interface DisplayState {
  readonly gamestate: number;
  readonly gametic: number;
  readonly automapactive: boolean;
  readonly viewactive: boolean;
  readonly paused: boolean;
  /** menuactive (d_main.c:285 borderdrawcount gate; M9-04's menu owns the
   * real flag — optional, default false). */
  readonly menuActive?: boolean;
}

/**
 * Registrable per-state drawers ("merged hooks", the game.ts idiom): the
 * UI modules (M9-04..10) are wired by the boot layer WITHOUT the render
 * zone importing them (the zone graph forbids render→ui; the ui modules
 * import render, never the reverse). Every hook is optional; unregistered
 * state drawers are counted in displayStubHits instead of throwing.
 */
export interface DisplayHooks {
  /** ST_Drawer(fullscreen, refresh) — fullscreen ⇔ viewheight==200
   * (d_main.c:252). Draws into screens[0]/BG via ui/stlib's vvideo calls. */
  stDrawer?: (fullscreen: boolean, refresh: boolean) => void;
  /** HU_Drawer (d_main.c:270) — messages overlay AFTER the 3D view. */
  huDrawer?: (automapactive: boolean) => void;
  /** WI_Drawer (GS_INTERMISSION). */
  wiDrawer?: () => void;
  /** F_Drawer (GS_FINALE, M9-10). */
  finaleDrawer?: () => void;
  /** D_PageDrawer = V_DrawPatch(0,0,pagename) (GS_DEMOSCREEN, M9-10). */
  pageDrawer?: () => void;
  /** M_Drawer LAST — "menu is drawn even on top of everything" (:327). */
  mDrawer?: () => void;
  /** M_PAUSE stamp at the view-window top (d_main.c:310-316). */
  pausedPatch?: (x: number, y: number) => void;
}

const displayHooks: DisplayHooks = {};
export const displayStubHits = { count: 0, byName: new Map<string, number>() };

export function resetDisplayStubHits(): void {
  displayStubHits.count = 0;
  displayStubHits.byName.clear();
}

/** Merge drawer implementations into the registry (undefined stays inert). */
export function registerDisplayHooks(h: Partial<DisplayHooks>): void {
  Object.assign(displayHooks, h);
}

export function resetDisplayHooks(): void {
  for (const k of Object.keys(displayHooks) as (keyof DisplayHooks)[]) delete displayHooks[k];
}

/** displayFrame inputs: the full 3D FrameDeps plus the flow read-view and
 * the optional border source (the IWAD holding FLOOR7_2 + brdr_*). */
export interface DisplayDeps extends FrameDeps {
  readonly state: DisplayState;
  readonly borders?: { readonly wad: WadFile };
  /** the wipe sentinel (M9-03 takeWipeRequest) — the melt BODY is M9-01/
   * later wiring; for the composition it only forces the bar refresh. */
  readonly wipe?: boolean;
}

export interface DisplayResult {
  /** the R_RenderPlayerView counters (undefined ⇒ no 3D pass this frame:
   * non-LEVEL state, automap… the automap still overlays inside
   * renderFrame when active, mirroring the merged M2-M8 behavior). */
  readonly counters?: FrameCounters;
  readonly viewheight: number;
  readonly fullscreen: boolean;
  readonly borderDrawn: boolean;
  readonly barRefreshed: boolean;
}

/* D_Display's file-scope statics (d_main.c:196-200). */
let dFulllscreen = false;
let dOldGamestate = -1;
let dBorderDrawCount = 0;
let dMenuActiveState = false;
let dViewActiveState = false;

/** Test/boot hook: forget the statics (equivalent of process start). */
export function resetDisplayStatics(): void {
  dFulllscreen = false;
  dOldGamestate = -1;
  dBorderDrawCount = 0;
  dMenuActiveState = false;
  dViewActiveState = false;
}

/**
 * D_Display (d_main.c:193-330), composition half — no wipes (M9-03 owns
 * the sentinel), no I_* blit calls (platform owns those). Order deviation
 * documented: the ST bar draws AFTER the 3D pass (vanilla draws it before
 * R_RenderPlayerView because the view pass only ever touches the window;
 * our 3D pass is full-buffer, so the DISJOINT bar/border regions paint
 * over it afterwards — pixel-identical result, order-safe by region).
 */
export function displayFrame(deps: DisplayDeps): DisplayResult {
  // screens[0] must alias the framebuffer for every V_* drawer (vvideo
  // header's integration seam). Re-bind only on fb identity change.
  const fg = screens[0];
  if (fg === undefined || fg === null || fg.data !== deps.fb.indices) vInit(deps.fb.indices);

  // 1. setsizeneeded ⇒ R_ExecuteSetViewSize, force background redraw
  //    (oldgamestate = -1), borderdrawcount = 3 (d_main.c:198-203).
  const sizeChanged = consumeViewSetSizeNeeded();
  const vs = viewSize();
  if (sizeChanged) {
    dOldGamestate = -1; // force R_FillBackScreen below, exactly vanilla
    dBorderDrawCount = 3;
  }

  const st = deps.state;

  // 2. per-state drawers (the buffered half — menus/HU draw AFTER in
  //    vanilla's order below; wipe capture is M9-03's sentinel consumer).
  let counters: FrameCounters | undefined;
  let barRefreshed = false;
  let borderDrawn = false;

  if (st.gamestate === GS_LEVEL && st.gametic !== 0) {
    // redrawsbar = wipe || (viewheight != 200 && fullscreen) (d_main.c:
    // 243-246); the ST DRAW itself runs after the 3D pass below (region-
    // disjoint reorder, file comment).
    barRefreshed = deps.wipe === true || (vs.viewheight !== 200 && dFulllscreen);
    dFulllscreen = vs.fullscreen;
  } else if (st.gamestate === GS_INTERMISSION) {
    if (displayHooks.wiDrawer !== undefined) displayHooks.wiDrawer();
    else displayStub('wiDrawer');
  } else if (st.gamestate === GS_FINALE) {
    if (displayHooks.finaleDrawer !== undefined) displayHooks.finaleDrawer();
    else displayStub('finaleDrawer');
  } else if (st.gamestate === GS_DEMOSCREEN) {
    if (displayHooks.pageDrawer !== undefined) displayHooks.pageDrawer();
    else displayStub('pageDrawer');
  }

  // 3. R_RenderPlayerView — the 3D pass (automap overlay lives INSIDE
  //    renderFrame here, the merged M2+ behavior; vanilla skips the view
  //    over the automap, AM_clearFB covering the same pixels).
  if (st.gamestate === GS_LEVEL && st.gametic !== 0) {
    counters = renderFrame(deps);

    // 3b. windowed presentation (port deviation, view.ts header): the
    // 320x200 pass is CROP-BLIT into the view window (the 3D passes keep
    // the fullscreen projection constants; centering is exact on both
    // axes — crop x0 === viewwindowx, the row crop centers centery).
    if (vs.viewheight !== 200 || vs.scaledviewwidth !== 320) {
      cropToWindow(deps.fb, vs.viewwindowx, vs.viewwindowy, vs.viewwidth, vs.viewheight);
    }

    // 4. border bookkeeping (d_main.c:276-296): refill the back screen on
    //    GS_LEVEL entry (or forced resize), then the 3-count erase.
    if (dOldGamestate !== GS_LEVEL) {
      dViewActiveState = false;
      if (deps.borders !== undefined) fillBackScreen(deps.borders.wad);
    }
    if (!st.automapactive && vs.scaledviewwidth !== 320) {
      const menuActive = st.menuActive ?? false;
      if (menuActive || dMenuActiveState || !dViewActiveState) dBorderDrawCount = 3;
      if (dBorderDrawCount > 0) {
        drawViewBorder();
        borderDrawn = true;
        dBorderDrawCount -= 1;
      }
    }

    // 4b. ST_Drawer (reordered AFTER the view/border half: our 3D pass
    // covers the full buffer, so the bar/border regions must paint last;
    // vanilla needs no reorder because its view pass never leaves the
    // window). fullscreen ⇔ viewheight==200 (d_main.c:252).
    if (displayHooks.stDrawer !== undefined) displayHooks.stDrawer(vs.fullscreen, barRefreshed);
    else displayStub('stDrawer');
  }

  // 5. HU_Drawer + paused stamp + M_Drawer last (d_main.c:268-327).
  if (st.gamestate === GS_LEVEL && st.gametic !== 0) {
    if (displayHooks.huDrawer !== undefined) displayHooks.huDrawer(st.automapactive);
    else displayStub('huDrawer');
  }
  if (st.paused) {
    const y = st.automapactive ? 4 : vs.viewwindowy + 4;
    if (displayHooks.pausedPatch !== undefined) {
      displayHooks.pausedPatch(vs.viewwindowx + (vs.scaledviewwidth - 68) / 2, y);
    }
  }
  if (displayHooks.mDrawer !== undefined) displayHooks.mDrawer();

  dMenuActiveState = st.menuActive ?? false;
  dViewActiveState = st.gamestate === GS_LEVEL ? st.viewactive : false;
  dOldGamestate = st.gamestate;

  return {
    counters,
    viewheight: vs.viewheight,
    fullscreen: vs.fullscreen,
    borderDrawn,
    barRefreshed,
  };
}

function displayStub(name: string): void {
  displayStubHits.count += 1;
  displayStubHits.byName.set(name, (displayStubHits.byName.get(name) ?? 0) + 1);
}

/**
 * Crop-blit of the centered (320−w)/2 × (200−h)/2 window into the view
 * window (the port deviation the view.ts header pins). Rows move as
 * whole 320-wide units; direction chosen so a shift never clobbers an
 * unread source row.
 */
function cropToWindow(
  fb: Framebuffer,
  wx: number,
  wy: number,
  w: number,
  h: number,
): void {
  const px = fb.indices;
  const srcX0 = (320 - w) >> 1; // === wx by construction (r_draw math)
  const srcY0 = (200 - h) >> 1;
  const shift = wy - srcY0;
  if (shift === 0) {
    if (srcX0 !== wx) {
      for (let r = 0; r < h; r += 1) {
        const row = r * 320;
        const tmp = px.slice(row + srcX0, row + srcX0 + w);
        px.set(tmp, row + wx);
      }
    }
    return;
  }
  // shift < 0: destination rows ABOVE sources → sweep top-down;
  // shift > 0: below → sweep bottom-up. Row spans never overlap
  // themselves (r ≠ r + shift), a slice+set per row is safe.
  const step = shift < 0 ? 1 : -1;
  for (let r = shift < 0 ? 0 : h - 1; r >= 0 && r < h; r += step) {
    const dst = (wy + r) * 320;
    const src = (srcY0 + r) * 320 + srcX0;
    px.set(px.slice(src, src + w), dst + wx);
  }
}
