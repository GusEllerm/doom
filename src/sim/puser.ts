// sim/puser.ts — p_user.c player physics (M5-06, closes D009).
//
// Faithful port of linuxdoom-1.10 p_user.c:
//   P_Thrust      (:57-68)  — mom += FixedMul(move, finecosine/sine[angle>>19])
//   P_CalcHeight  (:74-127) — bob from |mom|² (>>2, cap MAXBOB=0x100000),
//     finesine wave at (FINEANGLES/20*leveltime)&FINEMASK, viewheight ramp
//     via deltaviewheight (±FRACUNIT/4 toward (VIEWHEIGHT/2, VIEWHEIGHT]),
//     viewz = z + viewheight + bob clamped to ceilingz-4*FRACUNIT. The
//     `!onground || CF_NOMOMENTUM` branch's SECOND z+VIEWHEIGHT write
//     (:99-105 — it overwrites the clamp, vanilla's real bug/quirk) kept.
//   P_MovePlayer  (:133-163) — angle += cmd.angleturn<<16 FIRST, then
//     onground = (z <= floorz) gates BOTH thrusts (no air control in 1.10);
//     strafe basis is angle-ANG90 (unsigned wrap); the S_PLAY→S_PLAY_RUN1
//     state write is the counted no-op hook (mobj states arrive M7).
//   P_PlayerThink (:246-268) — CF_NOCLIP→MF_NOCLIP flag sync every tic +
//     MF_JUSTATTACKED chainsaw override + reactiontime gate + P_CalcHeight.
//
// D009 closure (D012): the M2-07 noclip FLY path is DELETED. Vanilla has
// NO noclip branch in p_user.c — noclip is purely the MF_NOCLIP flag's
// effect inside p_map.c (P_CheckPosition returns true AFTER the floor/
// ceiling z seed): identical P_Thrust/friction/momentum curve, only the
// clipping checks are skipped. The only deliberate addition over 1.10 is
// that the cheat-flag sync also mirrors MF_NOGRAVITY (M2 behavior kept via
// D012, so noclip never falls; vanilla 1.10 would apply gravity there).
//
// Thinker placement (p_tick.c P_Ticker): P_PlayerThink runs for ALL
// players, THEN P_RunThinkers moves the mobjs — game.ts mirrors that with
// the pXYMovement/pZMovement loop right after pPlayerThink (M5-05).
//
// Out of scope on this path (counted or documented, per M5-plan §0.10):
// P_DeathThink (needs R_PointToAngle2/psprites); P_PlayerInSpecialSector
// was the M5 gap — LIVE since M6-12 (call site below, body in pspec.ts
// mirroring p_spec.c:1009). Weapon change / P_UseLines / P_MovePsprites /
// powerups: M7.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG90, ANGLETOFINESHIFT, FINEMASK, FRACUNIT } from '../core/constants';
import { angAdd, FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';

import { sectorAtPoint } from './bsp';
import type { PMapWorld } from './pmap';
import './pslide'; // M5-06: loads pslide's self-registration of pmoveHooks.slideMove
import { boundSpecialsWorld, feetCounts, pPlayerInSpecialSector } from './pspec';
import {
  CF_NOMOMENTUM,
  CF_NOCLIP,
  MF_JUSTATTACKED,
  MF_NOCLIP,
  MF_NOGRAVITY,
  MOVE_THRUST_SCALE,
  PST_DEAD,
  PST_LIVE,
  VIEWHEIGHT,
  type Player
} from './player';

/* ------------------------------------------------------------------ */
/* Constants / globals (p_user.c:42-51)                                 */
/* ------------------------------------------------------------------ */

/** p_user.c:42 `#define MAXBOB 0x100000` — "16 pixels of bob". */
export const MAXBOB = 0x100000;

/** p_user.c:51 file-scope `boolean onground;` — written by P_MovePlayer
 * (:158) and P_DeathThink (:197) only; P_CalcHeight reads it, so under a
 * reactiontime freeze it legitimately retains last tics value (verbatim). */
export const puserGlobals = { onground: false };

/** Counted call sites with no M5 subject (same convention as the pmap/
 * pmove hook counters; never hashed). */
export const puserHookCounts = {
  /** p_user.c:165-168 P_SetMobjState(mo, S_PLAY_RUN1) while moving. */
  setMobjStateRun: 0,
  /** p_user.c:274-275 P_PlayerInSpecialSector — LIVE since M6-12: fires
   * exactly when the vanilla call-site gate fires (live sector special
   * nonzero); unbound unit worlds count the static read (gap recorded in
   * pspec.feetCounts.unbound). */
  playerInSpecialSector: 0,
  /** p_user.c:266 P_DeathThink (M7+). */
  deathThink: 0
};

export function resetPuserHookCounts(): void {
  puserHookCounts.setMobjStateRun = 0;
  puserHookCounts.playerInSpecialSector = 0;
  puserHookCounts.deathThink = 0;
}

/* ------------------------------------------------------------------ */
/* P_Thrust — p_user.c:57-68                                            */
/* ------------------------------------------------------------------ */

/**
 * `P_Thrust(player, angle, move)` verbatim: `angle >>= ANGLETOFINESHIFT`
 * is an UNSIGNED shift (angle_t), then mom += FixedMul(move, trig).
 * No NOCLIP test — thrust is flag-blind in vanilla.
 */
export function pThrust(p: Player, angle: number, move: number): void {
  const fine = angle >>> ANGLETOFINESHIFT;
  p.mo.momx = (p.mo.momx + FixedMul(move, finecosine[fine]!)) | 0;
  p.mo.momy = (p.mo.momy + FixedMul(move, finesine[fine]!)) | 0;
}

/* ------------------------------------------------------------------ */
/* P_CalcHeight — p_user.c:74-127                                       */
/* ------------------------------------------------------------------ */

/** p_user.c:108 `angle = (FINEANGLES/20*leveltime)&FINEMASK` — C computes
 * FINEANGLES/20 as the INTEGER 409 first. */
const BOB_ANGLE_STEP = (8192 / 20) | 0;

/**
 * `P_CalcHeight(player)` verbatim incl. the two quirks pinned in the file
 * header (double viewz write in the airborne branch; the FRACUNIT/4
 * deltaviewheight ramp with its `if (!deltaviewheight) = 1` overflow guard).
 * `leveltime` arrives as a parameter (vanilla reads the p_tick.c global).
 */
export function pCalcHeight(p: Player, leveltime: number): void {
  const mo = p.mo;

  // Regular movement bobbing (needed for the gun swing even airborne).
  p.bob = (FixedMul(mo.momx, mo.momx) + FixedMul(mo.momy, mo.momy)) | 0;
  p.bob = (p.bob >> 2) | 0; // C: player->bob >>= 2 (arithmetic, value >= 0 here)
  if (p.bob > MAXBOB) p.bob = MAXBOB;

  if ((p.cheats & CF_NOMOMENTUM) !== 0 || !puserGlobals.onground) {
    p.viewz = (mo.z + VIEWHEIGHT) | 0;
    if (p.viewz > ((mo.ceilingz - 4 * FRACUNIT) | 0)) {
      p.viewz = (mo.ceilingz - 4 * FRACUNIT) | 0;
    }
    // ...and the unconditional overwrite (p_user.c:104) — kept EXACT.
    p.viewz = (mo.z + p.viewheight) | 0;
    return;
  }

  const angle = Math.imul(BOB_ANGLE_STEP, leveltime | 0) & FINEMASK;
  // `player->bob/2` is fixed_t division by 2 (bob >= 0 → >> 1 identical).
  const bob = FixedMul((p.bob / 2) | 0, finesine[angle]!);

  // move viewheight
  if (p.playerstate === PST_LIVE) {
    p.viewheight = (p.viewheight + p.deltaviewheight) | 0;

    if (p.viewheight > VIEWHEIGHT) {
      p.viewheight = VIEWHEIGHT;
      p.deltaviewheight = 0;
    }

    if (p.viewheight < VIEWHEIGHT / 2) {
      p.viewheight = VIEWHEIGHT / 2;
      if (p.deltaviewheight <= 0) p.deltaviewheight = 1;
    }

    if (p.deltaviewheight) {
      p.deltaviewheight = (p.deltaviewheight + FRACUNIT / 4) | 0;
      if (!p.deltaviewheight) p.deltaviewheight = 1;
    }
  }

  p.viewz = (mo.z + p.viewheight + bob) | 0;

  if (p.viewz > ((mo.ceilingz - 4 * FRACUNIT) | 0)) {
    p.viewz = (mo.ceilingz - 4 * FRACUNIT) | 0;
  }
}

/* ------------------------------------------------------------------ */
/* P_MovePlayer — p_user.c:133-163                                      */
/* ------------------------------------------------------------------ */

/**
 * `P_MovePlayer(player)` verbatim (states aside): turn FIRST
 * (`mo->angle += cmd->angleturn << 16`, u32 BAM), then the onground gate
 * — `onground = (mo->z <= mo->floorz)` is p_user.c's OWN definition of
 * grounded (not a thinker flag) — then the two thrusts at ×2048, strafe
 * on the `angle-ANG90` basis (unsigned wrap kept).
 */
export function pMovePlayer(p: Player): void {
  const cmd = p.cmd;

  p.mo.angle = angAdd(p.mo.angle, (cmd.angleturn << 16) >>> 0);

  // Do not let the player control movement if not onground.
  puserGlobals.onground = p.mo.z <= p.mo.floorz;

  if (cmd.forwardmove && puserGlobals.onground) {
    pThrust(p, p.mo.angle, (cmd.forwardmove * MOVE_THRUST_SCALE) | 0);
  }
  if (cmd.sidemove && puserGlobals.onground) {
    pThrust(p, (p.mo.angle - ANG90) >>> 0, (cmd.sidemove * MOVE_THRUST_SCALE) | 0);
  }

  if ((cmd.forwardmove || cmd.sidemove) /* && mo->state == &states[S_PLAY] */) {
    // P_SetMobjState(mo, S_PLAY_RUN1) — the state arena is M7; the check
    // would fire on the standing state only, so the port cannot know it:
    // counted here on EVERY moving tic (deviation noted; bob/viewheight
    // are state-blind, so physics is unaffected).
    puserHookCounts.setMobjStateRun++;
  }
}

/* ------------------------------------------------------------------ */
/* P_PlayerThink — p_user.c:246-268 (+ the M5-live slice of 268-386)    */
/* ------------------------------------------------------------------ */

/**
 * `P_PlayerThink(player)` — the M5-live subset: noclip flag sync,
 * MF_JUSTATTACKED chainsaw override, dead-player guard, reactiontime gate
 * + P_MovePlayer + P_CalcHeight + the special-sector READ (dispatch
 * counted, M6). The weapon-change / use / psprite / powerup blocks have
 * no M5 subject and are NOT stubbed with fake behavior (M5-plan §0.10).
 *
 * `leveltime` is the p_tick.c global threaded through by game.ts.
 */
export function pPlayerThink(world: PMapWorld, p: Player, leveltime: number): void {
  // fixme: do this in the cheat code (p_user.c) — + MF_NOGRAVITY mirror
  // per D012 (deviation: 1.10 syncs MF_NOCLIP only; noclip here never
  // falls, momentum physics stay IDENTICAL otherwise).
  if (p.cheats & CF_NOCLIP) p.mo.flags |= MF_NOCLIP | MF_NOGRAVITY;
  else p.mo.flags &= ~(MF_NOCLIP | MF_NOGRAVITY);

  // p_mobj.c reads player->cmd.forwardmove/sidemove through mo->player —
  // refresh the mirror every tic BEFORE any mover can run.
  p.forwardmove = p.cmd.forwardmove;
  p.sidemove = p.cmd.sidemove;

  // chain saw run forward (p_user.c:256-262; MF_JUSTATTACKED is set by no
  // M5 code — faithful structure kept so M7 weapons land without churn).
  if (p.mo.flags & MF_JUSTATTACKED) {
    p.cmd.angleturn = 0;
    p.cmd.forwardmove = (0xc800 / 512) | 0; // = 25 (vanilla integer division)
    p.cmd.sidemove = 0;
    p.mo.flags &= ~MF_JUSTATTACKED;
    p.forwardmove = p.cmd.forwardmove;
    p.sidemove = p.cmd.sidemove;
  }

  if (p.playerstate === PST_DEAD) {
    // P_DeathThink (p_user.c:180-239): viewheight-to-floor fall, look-at-
    // killer turn, reborn-on-use — all need states/psprites (M7).
    puserHookCounts.deathThink++;
    return;
  }

  // Move around. Reactiontime is used to prevent movement for a bit
  // after a teleport (p_user.c:272-277). Teleports set 18 (p_telept.c) —
  // MT_PLAYER mobjinfo reactiontime is 0, so spawns are never frozen.
  if (p.mo.reactiontime) p.mo.reactiontime--;
  else pMovePlayer(p);

  pCalcHeight(p, leveltime);

  // if (player->mo->subsector->sector->special)
  //     P_PlayerInSpecialSector (player);          — p_user.c:274-275.
  // M6-12: the gate reads the LIVE sector special (vanilla's sector->special
  // IS the live field — a found secret zeroes itself and stops firing);
  // the body mirrors p_spec.c:1009 in pspec.ts. Unit PMapWorlds with no
  // bound GameState keep the static-special count (feetCounts.unbound).
  const feetSector = sectorAtPoint(world.map, p.mo.x, p.mo.y);
  const specials = boundSpecialsWorld();
  if (specials && specials.map === world.map) {
    if (specials.sectors.special[feetSector]!) {
      puserHookCounts.playerInSpecialSector++;
      pPlayerInSpecialSector(specials, p, feetSector);
    }
  } else if (world.map.sectors.special[feetSector]!) {
    puserHookCounts.playerInSpecialSector++;
    feetCounts.unbound++;
  }

  // BT_CHANGE weapon select, BT_USE P_UseLines, P_MovePsprites, powerup
  // counters: no M5 subjects (M6/M7) — intentionally absent, not faked.
}
