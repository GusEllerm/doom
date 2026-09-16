// sim/player.ts — minimal player_t + mobj stand-in and the M2 subset of
// P_SpawnPlayer (p_mobj.c) / P_PlayerThink (p_user.c).
//
// The vanilla `mobj_t` is a full thinker/state-machine object; M2 needs only
// the kinematic fields P_MovePlayer touches, so Player.mo is a plain record
// (`MobjStub`) — mobj states/thinkers arrive with physics (M2-07+) and
// monsters (M5). Fields and constants are named after d_player.h / p_mobj.h.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { angAdd, FRACBITS, FRACUNIT } from '../core/fixed';
import { ANG45 } from '../core/constants';
import type { MapThing } from '../wad/mapdata';

import { createTiccmd, type Ticcmd } from './ticcmd';

/* ------------------------------------------------------------------ */
/* Constants (p_local.h / p_mobj.h / d_player.h)                       */
/* ------------------------------------------------------------------ */

/** p_local.h:34 `#define VIEWHEIGHT (41*FRACUNIT)`. */
export const VIEWHEIGHT = 41 * FRACUNIT;
/** p_local.h:95 `#define ONFLOORZ MININT` — "resolve to actual floor" token. */
export const ONFLOORZ = -2147483648; // MININT

/** p_mobj.h:150 `MF_NOCLIP = 0x1000`. */
export const MF_NOCLIP = 0x1000;

/** d_player.h:54-60 `playerstate_t` (PST_LIVE=0, PST_DEAD=1, PST_REBORN=2). */
export const PST_LIVE = 0;
export const PST_DEAD = 1;
export const PST_REBORN = 2;

/** d_player.h:67-74 `cheat_t` bit flags. */
export const CF_NOCLIP = 1;
export const CF_GODMODE = 2;
export const CF_NOMOMENTUM = 4;

/* ------------------------------------------------------------------ */
/* MobjStub — the kinematic slice of mobj_t M2 uses                    */
/* ------------------------------------------------------------------ */

export interface MobjStub {
  /** fixed */
  x: number;
  /** fixed */
  y: number;
  /** fixed (ONFLOORZ until P_CalcHeight/physics land in M2-07). */
  z: number;
  /** BAM angle, u32-normalized (angle_t is `unsigned`; never `|0`). */
  angle: number;
  /** MF_* bits (p_mobj.h); only MF_NOCLIP is honored in M2. */
  flags: number;
  /** fixed momentum — vanilla lives on mobj_t (p_user.c P_Thrust). 0 until M2-07. */
  momX: number;
  /** fixed */
  momY: number;
  /** p_user.c: teleport lockout countdown (P_MovePlayer skip). */
  reactiontime: number;
}

/* ------------------------------------------------------------------ */
/* player_t (d_player.h:83+) — M2 subset                               */
/* ------------------------------------------------------------------ */

export interface Player {
  mo: MobjStub;
  /** playerstate_t (PST_*). */
  playerstate: number;
  /** d_player.h: `ticcmd_t cmd` — last command consumed by P_PlayerThink. */
  cmd: Ticcmd;
  /** fixed — eyes height (P_CalcHeight fills in M2-07; vanilla starts at mo z + viewheight). */
  viewz: number;
  /** fixed — VIEWHEIGHT (d_player.h viewheight). */
  viewheight: number;
  /** fixed — bob/squat speed; 0 until M2-07. */
  deltaviewheight: number;
  /** fixed — bob accumulator; 0 until M2-07. */
  bob: number;
  /** vanilla `int health` (spawn value 100, players[] init in g_game.c:1390s). */
  health: number;
  /** d_player.h `int cheats` — CF_* bits. */
  cheats: number;
}

export function createPlayer(): Player {
  return {
    mo: {
      x: 0,
      y: 0,
      z: ONFLOORZ,
      angle: 0,
      flags: 0,
      momX: 0,
      momY: 0,
      reactiontime: 0
    },
    playerstate: PST_LIVE,
    cmd: createTiccmd(),
    viewz: 0,
    viewheight: VIEWHEIGHT,
    deltaviewheight: 0,
    bob: 0,
    health: 100,
    cheats: 0
  };
}

/* ------------------------------------------------------------------ */
/* P_SpawnPlayer (p_mobj.c) — subset                                   */
/* ------------------------------------------------------------------ */

/**
 * p_mobj.c `P_SpawnPlayer` for a single-player game, minus mobj states,
 * psprites and the ST/HU wakeups:
 *   x/y  = thing->x << FRACBITS, thing->y << FRACBITS   (p_mobj.c: x = ... << FRACBITS)
 *   z    = ONFLOORZ                                     (resolved by P_CalcHeight later)
 *   angle = ANG45 * (thing->angle / 45)  (p_mobj.c P_SpawnPlayer). thing angle
 *     is signed degrees (R01 §4); C computes `ANG45 * (angle/45)` in `unsigned`
 *     after truncating integer division — reproduced with Math.trunc + imul
 *     mod 2^32, so e.g. 90° → ANG90, 270° → ANG270, -90° → ANG270.
 */
export function pSpawnPlayer(p: Player, thing: MapThing): void {
  p.mo.x = (thing.x << FRACBITS) | 0;
  p.mo.y = (thing.y << FRACBITS) | 0;
  p.mo.z = ONFLOORZ;
  p.mo.angle = Math.imul(ANG45, Math.trunc(thing.angle / 45)) >>> 0;
  p.playerstate = PST_LIVE;
  p.cmd = createTiccmd();
  p.viewheight = VIEWHEIGHT;
  // mo->z stays ONFLOORZ until P_CalcHeight (M2-07); viewz pinned at 0 so
  // the hash is fully determined by spawn + tics.
  p.viewz = 0;
}

/* ------------------------------------------------------------------ */
/* P_PlayerThink (p_user.c) — skeleton                                 */
/* ------------------------------------------------------------------ */

/**
 * p_user.c `P_PlayerThink` for M2: the noclip cheat flag sync (verbatim
 * structure, p_user.c: player->mo->flags |= / &= ~MF_NOCLIP) and the
 * reactiontime-gated `P_MovePlayer` angle integration
 * `mo->angle += (cmd->angleturn << 16)` (p_user.c P_MovePlayer — the `<<16`
 * is exact: angleturn is int16, BAM wraps mod 2^32).
 *
 * NOT done here (deferred, on purpose):
 *  - P_Thrust momentum from forwardmove/sidemove → M2-07 (this task keeps
 *    momX/momY at 0; only `cmd` is stored/consumed);
 *  - P_CalcHeight / sector specials / weapon change / dead player think.
 */
export function pPlayerThink(p: Player): void {
  // fixme: do this in the cheat code (p_user.c)
  if (p.cheats & CF_NOCLIP) p.mo.flags |= MF_NOCLIP;
  else p.mo.flags &= ~MF_NOCLIP;

  if (p.playerstate !== PST_LIVE) return; // P_DeathThink: later milestone

  // Reactiontime prevents movement for a bit after a teleport (p_user.c).
  if (p.mo.reactiontime) p.mo.reactiontime--;
  else pMovePlayer(p);
}

/** p_user.c P_MovePlayer — angle part only (thrust is M2-07). */
function pMovePlayer(p: Player): void {
  const cmd = p.cmd;
  // vanilla: player->mo->angle += (cmd->angleturn<<16);  (angle_t unsigned)
  p.mo.angle = angAdd(p.mo.angle, (cmd.angleturn << 16) >>> 0);
  // P_Thrust(mo->angle, cmd->forwardmove*2048) etc. → M2-07.
}
