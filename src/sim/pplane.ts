// sim/pplane.ts — T_MovePlane (p_floor.c core, D013(a) carve-out to its own
// module) + the shared crush model call path (p_map.c P_ChangeSector /
// PIT_ChangeSector, implemented in pmap.ts, re-exported shape below).
// M6-04. Parent: M6-plan §M6-04; the ONE-TIC plane step consumed by all
// four mover families (pdoors M6-05, pplats M6-06, pfloor M6-07, pceilng
// M6-08) — this header is their INTERFACE CONTRACT.
//
// ---------------------------------------------------------------------------
// SOURCE TRUTH (verified line-by-line against linuxdoom-1.10 this pass)
// ---------------------------------------------------------------------------
// T_MovePlane — p_floor.c:48-196. `result_e` = doomdef.h {ok, pastdest,
// crushed}. Structure (all four floorOrCeiling × direction quadrants):
//   • PAST-DEST branch (`height ± speed` overshoots dest): clamp to dest →
//     P_ChangeSector(crush) → on nofit ROLL BACK to lastpos and call
//     P_ChangeSector a SECOND TIME (the undo), and the `//return crushed;`
//     is COMMENTED OUT in all four past-dest arms — the result is
//     `pastdest` EVEN THOUGH the plane is blocked (pin: families see
//     "arrived" and a rolled-back sector; p_floor/p_doors then clear
//     specialdata on a stuck mover, vanilla quirk kept).
//   • MID-MOVE floor DOWN (p_floor.c:70-84) and ceiling DOWN (:134-160):
//     step, on nofit roll back + SECOND P_ChangeSector + return `crushed`
//     — rollback happens whether or not crush is set (the damage still
//     fired inside the first call when crush was set: TWO damage passes on
//     the same tic for a crush-stuck mover, `!(leveltime&3)` permitting).
//   • MID-MOVE floor UP (:96-115) and the ceiling-DOWN arm above: with
//     crush the plane STAYS at the new height (no rollback!) and returns
//     `crushed`; without crush it rolls back (second P_ChangeSector) and
//     returns `crushed`.
//   • CEILING UP mid-move (:167-190): P_ChangeSector IS called (things
//     clip/rise), but the nofit handling is `#if 0`-disabled in the source
//     — ceiling-up NEVER blocks, NEVER rolls back, returns ok. The unused
//     flag is consumed by a void below so the call site stays verbatim.
//
// CRUSH KILL SITE (plan §0.3 open question, RESOLVED): p_map.c
// PIT_ChangeSector:1296-1309 — NOT P_KillMobj. The kill is
// `P_DamageMobj(thing, NULL, NULL, 10)` gated by `crushchange &&
// !(leveltime&3)` (10 damage every 4th tic, world source), plus:
//   • health<=0 corpse → S_GIBS + radius/height 0 (p_map.c:1269-1279 —
//     unreachable pre-M7, counted crushGib; M7 health/damage lands it);
//   • MF_DROPPED thing → P_RemoveMobj (grid unlink here);
//   • non-MF_SHOOTABLE → ignored, keeps checking.
// P_ChangeSector (p_map.c:1320-1345) iterates the sector's P_GroupLines
// BLOCKBOX with a plain x-outer/y-inner P_BlockThingsIterator — NO lines/
// sides loop and NO sector thinglist (both are later-source folklore).
//
// ---------------------------------------------------------------------------
// INTERFACE CONTRACT for M6-05..08 (the four family tasks)
// ---------------------------------------------------------------------------
// Build ONE context per scenario via {@link makePlaneContext} (satisfies
// the GameState shape; family thinker bodies just pass `state`):
//   tMovePlane(ctx, sector, speed, dest, crush, floorOrCeiling, direction)
//     → 'pastdest' | 'crushed' | 'ok' — call it FIRST in every T_* mover,
//        mirroring vanilla (`res = T_MovePlane(...)`); the caller owns the
//        sector SoA fields it must apply on arrival (floortexture/special/
//        newspecial, pdoors wait phases, plat type transitions).
//   ctx.leveltime MUST be the live state.leveltime at tick time — the
//     crush cadence reads `!(ctx.leveltime & 3)` at call time.
//   pChangeSector(ctx, sector, crunch) is exposed for movers that touch a
//     height WITHOUT a plane step (e.g. donutRaise flats / door "snap"
//     cases per family); the T_MovePlane arms already call it.
//   Ceiling-up never blocked (`#if 0` pin) and the pastdest-rollback still
//     returning pastdest are load-bearing for door/plat tic-table goldens.
// Deviations logged (M6-plan §4): crush KILL = damage-slot cadence, not
// death/gibs (M7+M8); blood spray = 4 P_Random draws consumed here, mobj
// visual M7; the dead-corpse gibs branch unreachable pre-M7.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { pChangeSector, type CrushContext, type Mover, type PMapWorld } from './pmap';
import type { HookSlots } from './hooks';
import type { PrngState } from './prng';
import type { LiveSectors } from './state';

/* ------------------------------------------------------------------ */
/* result_e + the floorOrCeiling/direction constants (doomdef.h/p_local.h) */
/* ------------------------------------------------------------------ */

/** doomdef.h `result_e { ok, pastdest, crushed }` (numeric order 0/1/2 is
 * irrelevant — the port uses the names). */
export type ResultE = 'ok' | 'crushed' | 'pastdest';

/** p_local.h `floorOrCeiling` parameter: 0 = FLOOR, 1 = CEILING. */
export const PLANE_FLOOR = 0;
export const PLANE_CEILING = 1;

/** thinker `direction` fields: -1 = down, +1 = up (all four families). */
export const DIR_DOWN = -1;
export const DIR_UP = 1;

/** The mover-side context (see file header for the contract). Identical to
 * the pmap CrushContext; aliased so family tasks import one name. */
export type PlaneContext = CrushContext;

/** Structural host view (GameState satisfies it; kept structural so this
 * module never imports game.ts). `players[].mo` becomes the slot-indexed
 * mover registry so live movers (the player) clip with their authoritative
 * floorz/z instead of the SoA scratch materialisation. */
export interface PlaneHost {
  readonly pmap: PMapWorld;
  readonly sectors: LiveSectors;
  readonly hooks: HookSlots;
  readonly rng: PrngState;
  leveltime: number;
  readonly players: readonly { readonly mo: Mover }[];
}

/**
 * Build (or refresh) the plane context for a live run: wires the live
 * sector view onto the clipping world lazily (pmap.ts pChangeSector) and
 * indexes `host.players[].mo` by ThingLinks slot. Re-read `ctx.leveltime =
 * state.leveltime` per tic if the host is stepped externally; the
 * makePlaneContext-once-per-scenario idiom keeps that honest via a getter.
 */
export function makePlaneContext(host: PlaneHost): PlaneContext {
  const movers: (Mover | null)[] = [];
  for (const p of host.players) {
    const slot = p.mo.linkSlot;
    if (slot !== undefined && slot >= 0) movers[slot] = p.mo;
  }
  return {
    world: host.pmap,
    sectors: host.sectors,
    hooks: host.hooks,
    rng: host.rng,
    get leveltime() {
      return host.leveltime;
    },
    set leveltime(v: number) {
      host.leveltime = v;
    },
    movers,
  };
}

/* ------------------------------------------------------------------ */
/* T_MovePlane — p_floor.c:48-196                                       */
/* ------------------------------------------------------------------ */

/**
 * `T_MovePlane(sector, speed, dest, crush, floorOrCeiling, direction)` —
 * verbatim control flow (see the SOURCE TRUTH block in the header; every
 * branch, rollback and the `#if 0` is annotated at its site). Heights read
 * and written through the LIVE sector SoA (vanilla's `sector->floorheight`
 * / `->ceilingheight`); fixed-point int32 arithmetic via the typed arrays.
 */
export function tMovePlane(
  ctx: PlaneContext,
  sector: number,
  speed: number,
  dest: number,
  crush: boolean,
  floorOrCeiling: number,
  direction: number
): ResultE {
  const S = ctx.sectors;
  let flag: boolean;
  let lastpos: number;

  switch (floorOrCeiling) {
    case PLANE_FLOOR:
      // FLOOR
      switch (direction) {
        case DIR_DOWN:
          // DOWN — p_floor.c:66-92
          if (((S.floorZ[sector]! - speed) | 0) < dest) {
            lastpos = S.floorZ[sector]!;
            S.floorZ[sector] = dest;
            flag = pChangeSector(ctx, sector, crush);
            if (flag) {
              S.floorZ[sector] = lastpos;
              pChangeSector(ctx, sector, crush);
              //return crushed;              ← commented out in 1.10 (pin)
            }
            return 'pastdest';
          } else {
            lastpos = S.floorZ[sector]!;
            S.floorZ[sector] = (S.floorZ[sector]! - speed) | 0;
            flag = pChangeSector(ctx, sector, crush);
            if (flag) {
              S.floorZ[sector] = lastpos;
              pChangeSector(ctx, sector, crush);
              return 'crushed';
            }
          }
          break;

        case DIR_UP:
          // UP — p_floor.c:94-122
          if (((S.floorZ[sector]! + speed) | 0) > dest) {
            lastpos = S.floorZ[sector]!;
            S.floorZ[sector] = dest;
            flag = pChangeSector(ctx, sector, crush);
            if (flag) {
              S.floorZ[sector] = lastpos;
              pChangeSector(ctx, sector, crush);
              //return crushed;              ← commented out in 1.10 (pin)
            }
            return 'pastdest';
          } else {
            // COULD GET CRUSHED
            lastpos = S.floorZ[sector]!;
            S.floorZ[sector] = (S.floorZ[sector]! + speed) | 0;
            flag = pChangeSector(ctx, sector, crush);
            if (flag) {
              if (crush) return 'crushed'; // crush: plane STAYS at the new height
              S.floorZ[sector] = lastpos;
              pChangeSector(ctx, sector, crush);
              return 'crushed';
            }
          }
          break;
      }
      break;

    case PLANE_CEILING:
      // CEILING
      switch (direction) {
        case DIR_DOWN:
          // DOWN — p_floor.c:131-160
          if (((S.ceilingZ[sector]! - speed) | 0) < dest) {
            lastpos = S.ceilingZ[sector]!;
            S.ceilingZ[sector] = dest;
            flag = pChangeSector(ctx, sector, crush);
            if (flag) {
              S.ceilingZ[sector] = lastpos;
              pChangeSector(ctx, sector, crush);
              //return crushed;              ← commented out in 1.10 (pin)
            }
            return 'pastdest';
          } else {
            // COULD GET CRUSHED
            lastpos = S.ceilingZ[sector]!;
            S.ceilingZ[sector] = (S.ceilingZ[sector]! - speed) | 0;
            flag = pChangeSector(ctx, sector, crush);
            if (flag) {
              if (crush) return 'crushed'; // crush: plane STAYS at the new height
              S.ceilingZ[sector] = lastpos;
              pChangeSector(ctx, sector, crush);
              return 'crushed';
            }
          }
          break;

        case DIR_UP:
          // UP — p_floor.c:162-188
          if (((S.ceilingZ[sector]! + speed) | 0) > dest) {
            lastpos = S.ceilingZ[sector]!;
            S.ceilingZ[sector] = dest;
            flag = pChangeSector(ctx, sector, crush);
            if (flag) {
              S.ceilingZ[sector] = lastpos;
              pChangeSector(ctx, sector, crush);
              //return crushed;              ← commented out in 1.10 (pin)
            }
            return 'pastdest';
          } else {
            lastpos = S.ceilingZ[sector]!;
            S.ceilingZ[sector] = (S.ceilingZ[sector]! + speed) | 0;
            flag = pChangeSector(ctx, sector, crush);
            // UNUSED — the nofit arm is `#if 0` in p_floor.c:178-185:
            // ceiling-up NEVER blocks, NEVER rolls back. The call above
            // still runs (things clip and rise); pin so nobody "completes"
            // the disabled block:
            void flag;
          }
          break;
      }
      break;
  }

  return 'ok';
}

/** Re-export so family tasks import the whole plane interface from here
 * (pChangeSector semantics + crush model documented in pmap.ts). */
export { pChangeSector, type CrushContext } from './pmap';
