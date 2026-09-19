// sim/pmove — p_mobj.c movement core (M5-05): P_XYMovement + P_ZMovement.
//
// Faithful port of linuxdoom-1.10 p_mobj.c:105-341:
//   P_XYMovement (p_mobj.c:114-243) — MAXMOVE(30*FRACUNIT) clamp + the
//     half-split stride loop (NOTE the vanilla quirk: the split triggers
//     only on POSITIVE xmove/ymove > MAXMOVE/2 — negative momentum of full
//     magnitude takes ONE full step; pinned in pmove.test.ts), blocked →
//     player slide slot (M5-04 pslide.ts registers slideMove; default is a
//     documented, counted no-op = momentum survives, position stays at the
//     last accepted substep), missile → sky-hack removal (ceilingline's
//     backsector ceiling is F_SKY1 → P_RemoveMobj slot) or explode,
//     otherwise momentum zero; then the friction block verbatim:
//     CF_NOMOMENTUM debug return, no friction for MF_MISSILE|MF_SKULLFLY,
//     none airborne (z > floorz), the MF_CORPSE "halfway off a step"
//     continue, the STOPSPEED stop (RUN→PLAY revert through the counted
//     state hook — mobj states arrive M7, deviation noted) and the
//     FixedMul(mom, FRICTION=0xe800 = 0.90625) decay;
//   P_ZMovement (p_mobj.c:246-341) — smooth step-up viewheight squash,
//     z += momz, the MF_FLOAT/MF_INFLOAT target-follow (inert until M7
//     floaters; structurally complete), floor clip (SKULLFLY bounce,
//     momz<0 → 0, player hard-landing squat deltaviewheight = momz>>3 for
//     momz < -8*GRAVITY + sfx_oof SOUND SLOT (no-op), z snap to floorz,
//     missile explode), the MF_NOGRAVITY-gated gravity (momz==0 →
//     -2*GRAVITY start, else -= GRAVITY — p_local.h:53 GRAVITY is exactly
//     1*FRACUNIT; 1.10 has NO water/gravity variants), ceiling clip
//     (z = ceilingz - height, positive momz zeroed). Vanilla has no fall
//     damage anywhere in this path (M5-plan §0.2) and NO dropoff special
//     case: walking off a ledge just makes z > floorz at the next P_ZMovement,
//     which starts momz at -2*GRAVITY — the exact transition tic is pinned.
//
// pThingHeightClip (p_map.c:530-561) comes along cheaply (plan §M5-05):
// M6's sector-motion callers get the real clip; it reads {@link tm} right
// after a P_CheckPosition of the thing's own spot, exactly like the C.
//
// Ownership: this file is the ONLY mover-type surface M5-05 touches — the
// momentum/player fields of mobj_t live on {@link MoveMobj} declared HERE
// (pmap.ts Mover stays byte-identical so the parallel M5-04 pslide task
// never conflicts); the {@link PMoveHooks.slideMove} slot defaults to a
// documented no-op until pslide.ts registers itself.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { sectorAtPoint } from './bsp';
import { pAproxDistance } from './pmaputl';
import { pCheckPosition, pTryMove, tm, type Mover, type PMapWorld } from './pmap';
import {
  MF_FLOAT,
  MF_MISSILE,
  MF_NOCLIP,
  MF_NOGRAVITY,
  MF_SKULLFLY,
} from './thinglinks';

/* ------------------------------------------------------------------ */
/* Constants (p_mobj.c:111-112, p_local.h:30-54)                        */
/* ------------------------------------------------------------------ */

/** p_mobj.c:111 — below this (with no ticcmd input) momentum stops dead. */
export const STOPSPEED = 0x1000;
/** p_mobj.c:112 — FixedMul factor per ground tic = 0.90625. */
export const FRICTION = 0xe800;
/** p_local.h:53 `#define GRAVITY FRACUNIT` — exactly 1*FRACUNIT. */
export const GRAVITY = FRACUNIT;
/** p_local.h:54 `#define MAXMOVE (30*FRACUNIT)`. */
export const MAXMOVE = 30 * FRACUNIT;
/** p_local.h:30 (MF_FLOAT movers arrive M7; value pinned now). */
export const FLOATSPEED = 4 * FRACUNIT;
/** p_local.h:34 (P_CalcHeight, M5-06, owns the steady-state use). */
export const VIEWHEIGHT = 41 * FRACUNIT;
/** p_mobj.h:173/176 — absent from thinglinks.ts (owned elsewhere), local. */
export const MF_CORPSE = 0x100000;
export const MF_INFLOAT = 0x200000;
/** d_player.h:75 debug cheat (CF_NOCLIP=1, CF_INVISIBLE=2). */
export const CF_NOMOMENTUM = 4;
/** r_data.h SKYFLATNAME — the missile-vs-sky hack compares flat NAMES. */
export const SKYFLATNAME = 'F_SKY1';

/* ------------------------------------------------------------------ */
/* Mover slice (mobj_t fields P_XYMovement/P_ZMovement read/write)      */
/* ------------------------------------------------------------------ */

/** player_t slice: the ticcmd inputs + viewheight bookkeeping p_mobj.c
 * reaches through `mo->player`. p_user.ts (M5-06) will drive these. */
export interface MovePlayerState {
  /** CF_* bits; only CF_NOMOMENTUM is read here (debug sliding kill). */
  cheats: number;
  /** ticcmd_t forwardmove (int8 range) — the "walking frame" stop test. */
  forwardmove: number;
  sidemove: number;
  /** fixed; starts at VIEWHEIGHT, squashed/raised by P_ZMovement. */
  viewheight: number;
  deltaviewheight: number;
}

/**
 * mobj_t movement slice. Extends {@link Mover} (pmap.ts untouched);
 * `playerRef` stands for the C `mobj_t.player` POINTER — set it (and the
 * boolean `player: true` pmap's PIT functions read) for players; leave it
 * undefined for everything else. `target` is the M7 floater link.
 */
export interface MoveMobj extends Mover {
  /** fixed momentum (mobj_t momx/momy/momz, p_mobj.h:242-244). */
  momx: number;
  momy: number;
  momz: number;
  /** required here (SpawnMobj always seeds them; pTryMove keeps them). */
  floorz: number;
  ceilingz: number;
  /** the mo->player pointer slice; `player` boolean must be true in tandem. */
  playerRef?: MovePlayerState;
  /** mobj_t target — MF_FLOAT follow only, M7 territory. */
  target?: MoveMobj;
}

/* ------------------------------------------------------------------ */
/* Typed slots — documented no-ops (M5-04 slide, M7 states/sounds)       */
/* ------------------------------------------------------------------ */

/** Which P_SetMobjState call fired (state numbers are M7's arena). */
export type PMoveState = 'spawnstate' | 'deathstate' | 'play';
export type PMoveSound = 'oof';

export interface PMoveHooks {
  /** p_mobj.c:167 P_SlideMove(mo) for blocked PLAYERS. M5-04's pslide.ts
   * SELF-REGISTERS itself on import (M5-06 wiring); while pslide.ts is not
   * loaded the DEFAULT no-op keeps the momentum and the last accepted
   * position (move aborts this tic, no wall-crumbling) — deterministic and
   * counted, never silent. `world` arrives so the registrant can call
   * pTryMove (p_mobj.c passes the implicit `level`; explicit-world
   * convention per M5-02). */
  slideMove?: (mo: MoveMobj, world: PMapWorld) => void;
  /** p_mobj.c:85-99 P_ExplodeMissile's STATE/SOUND half (deathstate +
   * deathsound). The momentum half (momx=momy=momz=0, MF_MISSILE clear)
   * is pure movement and ALWAYS runs here regardless of registration. */
  explodeMissile?: (mo: MoveMobj) => void;
  /** p_mobj.c:189 P_RemoveMobj — the missile-vs-sky hack (mo dies outright,
   * P_XYMovement returns; nothing happens until M7's thinker arena). */
  removeMobj?: (mo: MoveMobj) => void;
  /** P_SetMobjState call sites that are not explode/removal: skull slam
   * → spawnstate, walk-stop RUN→PLAY revert (p_mobj.c:230). Counted. */
  setMobjState?: (mo: MoveMobj, which: PMoveState) => void;
  /** S_StartSound call sites in this path: sfx_oof hard landing. */
  playSound?: (mo: MoveMobj, sfx: PMoveSound) => void;
}

export const pmoveHooks: PMoveHooks = {};

/** Bookkeeping for every slot call (absent or present); reset in tests,
 * never read by hashes — same convention as pmapHookCounts. */
export const pmoveHookCounts = {
  slideMove: 0,
  explodeMissile: 0,
  missileRemoved: 0,
  setMobjStateSpawn: 0,
  setMobjStatePlay: 0,
  playSoundOof: 0,
};

export function resetPmoveHookCounts(): void {
  pmoveHookCounts.slideMove = 0;
  pmoveHookCounts.explodeMissile = 0;
  pmoveHookCounts.missileRemoved = 0;
  pmoveHookCounts.setMobjStateSpawn = 0;
  pmoveHookCounts.setMobjStatePlay = 0;
  pmoveHookCounts.playSoundOof = 0;
}

/* ------------------------------------------------------------------ */
/* P_XYMovement — p_mobj.c:105-243                                      */
/* ------------------------------------------------------------------ */

/** C `xmove/2` on fixed_t: truncation toward ZERO (differs from `>>1` for
 * negatives — the split branch's half-step must not floor). */
function halfTrunc(v: number): number {
  return (v / 2) | 0;
}

/** The sky hack (p_mobj.c:172-181): the global `ceilingline` (from the
 * just-failed P_CheckPosition inside pTryMove) has a backsector whose
 * CEILING pic is F_SKY1. */
function blockedOnSky(world_: PMapWorld): boolean {
  const line = tm.ceilingline;
  if (line < 0) return false;
  const back = world_.map.lines.sectorBack[line];
  if (back === undefined || back < 0) return false;
  return world_.map.sectors.ceilingFlat[back] === SKYFLATNAME;
}

/** P_ExplodeMissile's always-run momentum half (p_mobj.c:88,97) + the
 * M7 state/sound slot. */
function explodeMissile(mo: MoveMobj): void {
  mo.momx = 0;
  mo.momy = 0;
  mo.momz = 0;
  pmoveHookCounts.explodeMissile++;
  pmoveHooks.explodeMissile?.(mo); // deathstate + deathsound (M7)
  mo.flags &= ~MF_MISSILE; // AFTER the hook: vanilla clears it in-body
}

/**
 * `P_XYMovement(mo)` — verbatim control flow, p_mobj.c:114.
 * Zero allocation: no closures, no temporaries beyond locals; the split
 * loop runs at most 5 iterations (30*FRACUNIT halved until ≤ 15*FRACUNIT).
 */
export function pXYMovement(world_: PMapWorld, mo: MoveMobj): void {
  if (!mo.momx && !mo.momy) {
    if (mo.flags & MF_SKULLFLY) {
      // the skull slammed into something (p_mobj.c:117-123)
      mo.flags &= ~MF_SKULLFLY;
      mo.momx = 0;
      mo.momy = 0;
      mo.momz = 0;
      pmoveHookCounts.setMobjStateSpawn++; // spawnstate (M7 arena)
      pmoveHooks.setMobjState?.(mo, 'spawnstate');
    }
    return;
  }

  const player = mo.playerRef; // `mo->player`

  if (mo.momx > MAXMOVE) mo.momx = MAXMOVE;
  else if (mo.momx < -MAXMOVE) mo.momx = -MAXMOVE;

  if (mo.momy > MAXMOVE) mo.momy = MAXMOVE;
  else if (mo.momy < -MAXMOVE) mo.momy = -MAXMOVE;

  let xmove = mo.momx;
  let ymove = mo.momy;

  do {
    let ptryx: number;
    let ptryy: number;
    if (xmove > MAXMOVE / 2 || ymove > MAXMOVE / 2) {
      ptryx = (mo.x + halfTrunc(xmove)) | 0;
      ptryy = (mo.y + halfTrunc(ymove)) | 0;
      xmove >>= 1;
      ymove >>= 1;
    } else {
      ptryx = (mo.x + xmove) | 0;
      ptryy = (mo.y + ymove) | 0;
      xmove = 0;
      ymove = 0;
    }

    if (!pTryMove(world_, mo, ptryx, ptryy)) {
      // blocked move
      if (player) {
        // try to slide along it — M5-04 pslide.ts; no-op default (see
        // PMoveHooks.slideMove) keeps pos/momentum, counted.
        pmoveHookCounts.slideMove++;
        pmoveHooks.slideMove?.(mo, world_);
      } else if (mo.flags & MF_MISSILE) {
        // explode a missile — first the sky hack (p_mobj.c:172-178)
        if (blockedOnSky(world_)) {
          pmoveHookCounts.missileRemoved++;
          pmoveHooks.removeMobj?.(mo);
          return;
        }
        explodeMissile(mo);
      } else {
        mo.momx = 0;
        mo.momy = 0;
      }
    }
  } while (xmove || ymove);

  // slow down (p_mobj.c:200-243)
  if (player && player.cheats & CF_NOMOMENTUM) {
    // debug option for no sliding at all
    mo.momx = 0;
    mo.momy = 0;
    return;
  }

  if (mo.flags & (MF_MISSILE | MF_SKULLFLY)) return; // no friction for missiles ever

  if (mo.z > mo.floorz) return; // no friction when airborne

  if (mo.flags & MF_CORPSE) {
    // do not stop sliding if halfway off a step with some momentum
    if (
      mo.momx > FRACUNIT / 4 ||
      mo.momx < -FRACUNIT / 4 ||
      mo.momy > FRACUNIT / 4 ||
      mo.momy < -FRACUNIT / 4
    ) {
      if (
        mo.floorz !== world_.map.sectors.floorHeight[sectorAtPoint(world_.map, mo.x, mo.y)]!
      ) {
        return;
      }
    }
  }

  if (
    mo.momx > -STOPSPEED &&
    mo.momx < STOPSPEED &&
    mo.momy > -STOPSPEED &&
    mo.momy < STOPSPEED &&
    (!player || (player.forwardmove === 0 && player.sidemove === 0))
  ) {
    // if in a walking frame, stop moving — the (state - states) - S_PLAY_RUN1
    // < 4 window test is M7's state arena; the hook + counter record that the
    // call site fired (deviation: whether the player was actually mid-RUN is
    // unknowable without states, so the revert fires on every full stop).
    if (player) {
      pmoveHookCounts.setMobjStatePlay++;
      pmoveHooks.setMobjState?.(mo, 'play');
    }
    mo.momx = 0;
    mo.momy = 0;
  } else {
    mo.momx = FixedMul(mo.momx, FRICTION);
    mo.momy = FixedMul(mo.momy, FRICTION);
  }
}

/* ------------------------------------------------------------------ */
/* P_ZMovement — p_mobj.c:246-341                                       */
/* ------------------------------------------------------------------ */

/**
 * `P_ZMovement(mo)` — verbatim (see header). Reads no map data: floorz /
 * ceilingz were published by the last successful {@link pTryMove}. 1.10
 * has no water and no fall damage on this path (M5-plan §0.2 pins it).
 */
export function pZMovement(mo: MoveMobj): void {
  const player = mo.playerRef;

  // check for smooth step up
  if (player && mo.z < mo.floorz) {
    player.viewheight = (player.viewheight - ((mo.floorz - mo.z) | 0)) | 0;
    player.deltaviewheight = ((VIEWHEIGHT - player.viewheight) >> 3) | 0;
  }

  // adjust height
  mo.z = (mo.z + mo.momz) | 0;

  if (mo.flags & MF_FLOAT && mo.target) {
    // float down towards target if too close (p_mobj.c:259-276, M7 floaters)
    if (!(mo.flags & MF_SKULLFLY) && !(mo.flags & MF_INFLOAT)) {
      const dist = pAproxDistance((mo.x - mo.target.x) | 0, (mo.y - mo.target.y) | 0);
      const delta = ((mo.target.z + ((mo.height >> 1) | 0)) - mo.z) | 0;
      if (delta < 0 && dist < -(Math.imul(delta, 3) | 0)) mo.z = (mo.z - FLOATSPEED) | 0;
      else if (delta > 0 && dist < (Math.imul(delta, 3) | 0)) mo.z = (mo.z + FLOATSPEED) | 0;
    }
  }

  // clip movement
  if (mo.z <= mo.floorz) {
    // hit the floor
    if (mo.flags & MF_SKULLFLY) {
      // the skull slammed into something
      mo.momz = -mo.momz | 0;
    }

    if (mo.momz < 0) {
      if (player && mo.momz < -(GRAVITY * 8)) {
        // Squat down for a moment after hitting the ground (hard);
        // S_StartSound(mo, sfx_oof) — counted slot, silent until the M9
        // audio layer. NO hp change anywhere: vanilla has no fall damage.
        player.deltaviewheight = (mo.momz >> 3) | 0;
        pmoveHookCounts.playSoundOof++;
        pmoveHooks.playSound?.(mo, 'oof');
      }
      mo.momz = 0;
    }
    mo.z = mo.floorz;

    if ((mo.flags & MF_MISSILE) && !(mo.flags & MF_NOCLIP)) {
      explodeMissile(mo);
      return;
    }
  } else if (!(mo.flags & MF_NOGRAVITY)) {
    if (mo.momz === 0) mo.momz = -(GRAVITY * 2);
    else mo.momz = (mo.momz - GRAVITY) | 0;
  }

  if (((mo.z + mo.height) | 0) > mo.ceilingz) {
    // hit the ceiling
    if (mo.momz > 0) mo.momz = 0;
    mo.z = (mo.ceilingz - mo.height) | 0;

    if (mo.flags & MF_SKULLFLY) {
      // the skull slammed into something
      mo.momz = -mo.momz | 0;
    }

    if ((mo.flags & MF_MISSILE) && !(mo.flags & MF_NOCLIP)) {
      explodeMissile(mo);
      return;
    }
  }
}

/* ------------------------------------------------------------------ */
/* P_ThingHeightClip — p_map.c:530-561 (M6 consumer, cheap here)         */
/* ------------------------------------------------------------------ */

/**
 * Re-check the thing's own spot after a sector height change: republish
 * floorz/ceilingz from the tm state a fresh {@link pCheckPosition} fills,
 * rise with the floor when resting on it, otherwise only get pushed down
 * by the ceiling. False ⇒ doesn't fit (z left at the LOWEST it can be —
 * vanilla's crush path is p_map.c PIT_ChangeFloor, M6).
 */
export function pThingHeightClip(world_: PMapWorld, thing: MoveMobj): boolean {
  const onfloor = thing.z === thing.floorz;

  pCheckPosition(world_, thing, thing.x, thing.y); // P_CheckPosition(thing, x, y)

  thing.floorz = tm.tmfloorz;
  thing.ceilingz = tm.tmceilingz;

  if (onfloor) {
    // walking monsters rise and fall with the floor
    thing.z = thing.floorz;
  } else {
    // don't adjust a floating monster unless forced to
    if (((thing.z + thing.height) | 0) > thing.ceilingz) {
      thing.z = (thing.ceilingz - thing.height) | 0;
    }
  }

  return ((thing.ceilingz - thing.floorz) | 0) >= thing.height;
}
