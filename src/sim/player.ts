// sim/player.ts — player_t (d_player.h) + the M5-06 player mobj stand-in
// and P_SpawnPlayer (p_mobj.c) subset.
//
// M5-06 (D009 closure): the D009 fly path (pFlyNoclip) and the M2
// P_PlayerThink skeleton are GONE — the real p_user.c think lives in
// sim/puser.ts. `Player` is now the mover-side player_t slice: it extends
// pmove's MovePlayerState (the fields P_XYMovement/P_ZMovement reach
// through `mo->player`), and `Player.mo` extends pmove's MoveMobj (the
// mobj_t kinematic slice), so the shared pmap/pmove/pslide movers and the
// player are ONE object — momentum, floorz/ceilingz and thinglinks slots
// live exactly once (no parallel mobj struct, same rule as M5-03/05).
//
// Fields and constants are named after d_player.h / p_mobj.h / info.c.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACBITS, FRACUNIT } from '../core/fixed';
import { ANG45 } from '../core/constants';
import type { MapThing } from '../wad/mapdata';

import type { MoveMobj, MovePlayerState } from './pmove';
import { createTiccmd, type Ticcmd } from './ticcmd';

/* ------------------------------------------------------------------ */
/* Constants (p_local.h / p_mobj.h / d_player.h / info.c)              */
/* ------------------------------------------------------------------ */

/** p_local.h:34 `#define VIEWHEIGHT (41*FRACUNIT)`. */
export const VIEWHEIGHT = 41 * FRACUNIT;
/** p_local.h:95 `#define ONFLOORZ MININT` — "resolve to actual floor"
 * token. Only ever a constructor argument in vanilla (P_SpawnMobj resolves
 * it at p_mobj.c:522); M5-06 gInitGame does the same at spawn/level start. */
export const ONFLOORZ = -2147483648; // MININT

/** p_mobj.h:150 `MF_NOCLIP = 0x1000`. */
export const MF_NOCLIP = 0x1000;
/** p_mobj.h:142 `MF_NOGRAVITY = 512`. Vanilla 1.10 never sets this from a
 * cheat; D012 keeps the M2 cheat-flag sync (CF_NOCLIP also sets
 * MF_NOGRAVITY) so noclip = identical momentum physics with the checks
 * skipped and gravity off (M5-plan §1.3). */
export const MF_NOGRAVITY = 512;
/** p_mobj.h:135 `MF_JUSTATTACKED = 128` (chainsaw auto-forward in
 * P_PlayerThink; set nowhere until the M7 weapons). */
export const MF_JUSTATTACKED = 128;

/** info.c:1130s mobjinfo[MT_PLAYER].flags (minus MF_NOTDMATCH, a
 * deathmatch-only bit): MF_SOLID|MF_SHOOTABLE|MF_DROPOFF|MF_PICKUP.
 * MF_DROPOFF is what lets the player walk off ledges (p_map.c P_TryMove
 * rule 5, M5-03); MF_PICKUP arms the M7 item touch. */
export const PLAYER_FLAGS = 0x2 | 0x4 | 0x400 | 0x800;
/** info.c MT_PLAYER radius/height: 16*FRACUNIT / 56*FRACUNIT. */
export const PLAYER_RADIUS = 16 * FRACUNIT;
export const PLAYER_HEIGHT = 56 * FRACUNIT;

/** p_user.c P_MovePlayer `cmd->forwardmove*2048` — ticcmd move units →
 * fixed thrust scale (p_user.c P_Thrust argument). */
export const MOVE_THRUST_SCALE = 2048;

/** d_player.h:54-60 `playerstate_t` (PST_LIVE=0, PST_DEAD=1, PST_REBORN=2). */
export const PST_LIVE = 0;
export const PST_DEAD = 1;
export const PST_REBORN = 2;

/** d_player.h:67-74 `cheat_t` bit flags. */
export const CF_NOCLIP = 1;
export const CF_GODMODE = 2;
export const CF_NOMOMENTUM = 4;

/* ------------------------------------------------------------------ */
/* MobjStub — the player's mobj_t slice (a full MoveMobj)              */
/* ------------------------------------------------------------------ */

/**
 * The vanilla `mobj_t` MT_PLAYER slice, as a plain record. States/thinkers
 * still arrive with the M7 arena, but every MOVEMENT field p_mobj.c's
 * P_XYMovement/P_ZMovement touches is here (M5-05's MoveMobj), plus
 * `reactiontime` (p_user.c teleport lockout) and the self `playerRef`
 * standing for `mobj_t.player` (pmove reads/writes Player through it —
 * ONE source of truth for cheats/viewheight/ticcmd mirrors).
 */
export interface MobjStub extends MoveMobj {
  /** mobj_t angle (p_mobj.h:222), BAM, u32-normalized (angle_t is
   * `unsigned`; never `|0`) — P_MovePlayer integrates it (p_user.c:140). */
  angle: number;
  /** vanilla `mobj_t.player` — always the owning Player for a player mo. */
  playerRef: Player;
  /** p_user.c: teleport lockout countdown (P_MovePlayer skip). MT_PLAYER
   * mobjinfo reactiontime = 0 (info.c:1114) — only teleports set 18 (M6). */
  reactiontime: number;
}

/* ------------------------------------------------------------------ */
/* player_t (d_player.h:83+) — M5 slice                                */
/* ------------------------------------------------------------------ */

/**
 * The mover-relevant player_t. Extends {@link MovePlayerState}: `cheats`,
 * `viewheight`, `deltaviewheight` are canonical HERE (pmove writes them
 * through `mo.playerRef` = this object), and `forwardmove`/`sidemove` are
 * per-tic mirrors of `cmd` — vanilla reads `player->cmd.forwardmove` in
 * p_mobj.c's stop test; the mirror is refreshed at the top of
 * {@link pPlayerThink} (puser.ts) every tic, so they are never stale.
 */
export interface Player extends MovePlayerState {
  mo: MobjStub;
  /** playerstate_t (PST_*). */
  playerstate: number;
  /** d_player.h: `ticcmd_t cmd` — last command consumed by P_PlayerThink. */
  cmd: Ticcmd;
  /** fixed — eyes height, written by puser.pCalcHeight every think
   * (p_user.c); spawn value 0 until the first tic (vanilla leaves it
   * untouched in P_SpawnPlayer; pinned so hashes stay determined). */
  viewz: number;
  /** fixed — bob accumulator (P_CalcHeight, p_user.c):
   * `FixedMul(momx,momx)+FixedMul(momy,momy) >> 2`, capped MAXBOB. */
  bob: number;
  /** vanilla `int health` (spawn value 100, players[] init in g_game.c:1390s). */
  health: number;
  /** d_player.h `int cheats` — CF_* bits. */
  cheats: number;
}

export function createPlayer(): Player {
  const p: Player = {
    mo: {
      x: 0,
      y: 0,
      z: ONFLOORZ,
      radius: PLAYER_RADIUS,
      height: PLAYER_HEIGHT,
      angle: 0,
      flags: PLAYER_FLAGS,
      player: true,
      linkSlot: -1,
      momx: 0,
      momy: 0,
      momz: 0,
      floorz: 0,
      ceilingz: 0,
      reactiontime: 0,
      playerRef: null as unknown as Player // back-reference below (mobj_t.player)
    } as MobjStub,
    playerstate: PST_LIVE,
    cmd: createTiccmd(),
    viewz: 0,
    viewheight: VIEWHEIGHT,
    deltaviewheight: 0,
    forwardmove: 0,
    sidemove: 0,
    bob: 0,
    health: 100,
    cheats: 0
  };
  (p.mo as MobjStub).playerRef = p;
  return p;
}

/* ------------------------------------------------------------------ */
/* P_SpawnPlayer (p_mobj.c) — subset                                   */
/* ------------------------------------------------------------------ */

/**
 * p_mobj.c `P_SpawnPlayer` for a single-player game, minus mobj states,
 * psprites and the ST/HU wakeups:
 *   x/y  = thing->x << FRACBITS, thing->y << FRACBITS   (p_mobj.c: x = ... << FRACBITS)
 *   z    = ONFLOORZ                                     (resolved to the
 *          sector floor by gInitGame exactly like P_SpawnMobj, p_mobj.c:522)
 *   angle = ANG45 * (thing->angle / 45)  (p_mobj.c P_SpawnPlayer). thing angle
 *     is signed degrees (R01 §4); C computes `ANG45 * (angle/45)` in `unsigned`
 *     after truncating integer division — reproduced with Math.trunc + imul
 *     mod 2^32, so e.g. 90° → ANG90, 270° → ANG270, -90° → ANG270.
 */
export function pSpawnPlayer(p: Player, thing: MapThing): void {
  p.mo.x = (thing.x << FRACBITS) | 0;
  p.mo.y = (thing.y << FRACBITS) | 0;
  p.mo.z = ONFLOORZ; // gInitGame resolves it via the spawn subsector (M5-06)
  p.mo.momx = 0;
  p.mo.momy = 0;
  p.mo.momz = 0;
  p.mo.angle = Math.imul(ANG45, Math.trunc(thing.angle / 45)) >>> 0;
  p.playerstate = PST_LIVE;
  p.cmd = createTiccmd();
  p.forwardmove = 0;
  p.sidemove = 0;
  p.viewheight = VIEWHEIGHT;
  p.deltaviewheight = 0;
  p.bob = 0;
  // viewz pinned at 0 until the first P_CalcHeight (p_user.c leaves it
  // untouched in P_SpawnPlayer; the pin keeps the spawn hash determined).
  p.viewz = 0;
}
