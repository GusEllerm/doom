// render/renderer.ts — M3-07 frame pipeline: the single renderFrame entry
// ARCHITECTURE §4.1 wires together (r_main.c R_RenderPlayerView, walls-only
// subset per docs/design/M3-plan.md §M3-07 + §3 deviation D).
//
// Per-frame order (plan §M3-07, §4.1):
//   1. setupView        — R_SetupFrame half: player mo read EVERY frame
//      (warp/pin → next frame renders from it; no stale view state lives
//      here beyond the reused ViewState fields setupView rewrites).
//   2. clearClipSegs + clearDrawsegs + clearClipArrays + counters —
//      R_ClearClipSegs (r_bsp.c) + R_ClearDrawSegs (r_bsp.c) + the clip-
//      array half of R_ClearPlanes (r_plane.c; visplanes skipped, D below)
//      + resetRenderCounters (M3-03 seam).
//   3. fb.clear(0)      — BLACK background replacing R_ClearPlanes/visplane
//      flats. DOCUMENTED DEVIATION (plan §3-D): floor/ceiling gaps show
//      black, NOT HOM (hom counts solidsegs/store failures only); M4's
//      visplanes replace this call.
//   4. BSP wall pass    — walker.walk = R_RenderBSPNode from bspRoot with
//      the M3-06 seg callbacks (storeWallRange → renderSegLoop →
//      drawColumn).
//   5. drawMasked()     — named no-op stub (M3-06 recording only; M4 draws).
//   6. automap overlay  — §4.1.9: when automap state is active the automap
//      drawer draws INTO THE SAME index buffer after the 3D pass (vanilla
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

import { drawAutomap, type AutomapGeom, type AutomapMap, type AutomapPlayer } from './automap';
import { createBspWalker, type BspWalker, type WalkCallbacks } from './bsp';
import { clearClipArrays, clearDrawsegs, drawMasked } from './drawsegs';
import type { Framebuffer } from './framebuffer';
import type { LightTables } from './lights';
import type { RenderWorld } from './rdata';
import {
  clearClipSegs,
  getRenderCounters,
  resetRenderCounters,
  type RenderCounters,
} from './solidsegs';
import { createSegCallbacks } from './segs';
import {
  createViewState,
  setupView,
  VIEWHEIGHT,
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
}

/** Automap overlay bundle (optional dep): `state` is the sim AutomapState
 * (AutomapGeom read-view), `map` the runtime map (AutomapMap read-view),
 * `player` defaults to the frame player when omitted. */
export interface AutomapOverlay {
  readonly state: AutomapGeom;
  readonly map: AutomapMap;
  readonly player?: AutomapPlayer;
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
   * = segs.ts identity tables. */
  readonly tables?: LightTables;
  readonly automap?: AutomapOverlay;
}

/* ------------------------------------------------------------------ */
/* Per-map frame context cache                                          */
/* ------------------------------------------------------------------ */

interface FrameCtx {
  readonly world: RenderWorld;
  readonly fb: Framebuffer;
  /** null = default identity tables (segs.ts). */
  readonly tables: LightTables | null;
  readonly walker: BspWalker;
  readonly view: ViewState;
  readonly cbs: WalkCallbacks;
}

const ctxCache = new WeakMap<RenderMapView, FrameCtx>();

function getCtx(deps: FrameDeps): FrameCtx {
  const tables = deps.tables ?? null;
  let ctx = ctxCache.get(deps.map);
  if (
    ctx === undefined ||
    ctx.world !== deps.world ||
    ctx.fb !== deps.fb ||
    ctx.tables !== tables
  ) {
    const view = createViewState();
    ctx = {
      world: deps.world,
      fb: deps.fb,
      tables,
      walker: createBspWalker(deps.map, deps.world),
      view,
      // undefined tables ⇒ createSegCallbacks' identity default (segs.ts).
      cbs: createSegCallbacks(deps.fb, deps.world, view, deps.map, tables ?? undefined),
    };
    ctxCache.set(deps.map, ctx);
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* renderFrame                                                          */
/* ------------------------------------------------------------------ */

/**
 * One walls-only frame into `deps.fb` (exact order in the file header).
 * Returns the post-frame render counters (hom must be 0 on healthy maps;
 * M3-08 goldens assert it). Deterministic: same world + same player ⇒
 * byte-identical buffer (M3-plan L3).
 */
export function renderFrame(deps: FrameDeps): RenderCounters {
  const ctx = getCtx(deps);

  // 1. R_SetupFrame half — player read fresh every frame (warp takes
  //    effect on the very next frame, no stale view).
  const mo = deps.player.mo;
  const z = mo.z === undefined || mo.z === ONFLOORZ_TOKEN ? 0 : mo.z;
  setupView(ctx.view, { x: mo.x, y: mo.y, z, angle: mo.angle });

  // 2. per-frame clears + counter reset.
  clearClipSegs(VIEWWIDTH);
  clearDrawsegs();
  clearClipArrays(VIEWHEIGHT);
  resetRenderCounters();

  // 3. background (deviation D: black, visplanes land in M4).
  deps.fb.clear(0);

  // 4. R_RenderBSPNode (walker.walk defaults the root to bspRoot(map)).
  ctx.walker.walk(ctx.view, ctx.cbs);

  // 5. masked middles — named no-op stub (M4 draws; recording is live).
  drawMasked();

  // 6. §4.1.9 — automap/HUD overlays draw into the same buffer AFTER the
  // 3D pass; AM_Responder owns the toggle (Tab), state.am gates this.
  const am = deps.automap;
  if (am !== undefined && am.state.automapactive) {
    drawAutomap(deps.fb, am.state, am.map, am.player ?? deps.player);
  }

  return getRenderCounters();
}

/** Re-export the golden-suite/e2e counter entry (plan §M3-07 Produces). */
export { getRenderCounters };
