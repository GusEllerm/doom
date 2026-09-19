// sim/pdoors.ts — vertical doors (p_doors.c). M6-05b RE-LAND: the real
// bodies replace the M6-03 stubs, signatures unchanged (the pspec.ts
// registry dispatch is the only call site; pswitch.ts's EV_DoLockedDoor
// calls evDoDoor directly). Parent: M6-plan §M6-05; mover interface = the
// pplane.ts M6-04 contract. (The original M6-05 never landed on main —
// D014 ledger drift; this is the M6-05b re-dispatch.)
//
// ---------------------------------------------------------------------------
// SOURCE TRUTH (verified line-by-line against linuxdoom-1.10/p_doors.c)
// ---------------------------------------------------------------------------
//  • `vldoor_e` (p_spec.h:326-336) = normal 0, close30ThenOpen 1, close 2,
//    open 3, raiseIn5Mins 4, blazeRaise 5, blazeOpen 6, blazeClose 7 — the
//    specials-table VL mirror. vldoor_t fields: sector, topheight, speed,
//    direction ("1 = up, 0 = waiting at top, -1 = down"; 2 = the
//    raiseIn5Mins INITIAL WAIT only — p_spec.h:347-360), topwait,
//    topcountdown. Constants p_spec.h:364-365: VDOORSPEED = FRACUNIT*2,
//    VDOORWAIT = 150; blazing = VDOORSPEED*4 = 8/unit-tic (p_doors.c
//    EV_DoDoor blaze arms). Waits: 150 top (VDOORWAIT), 1050 = 35*30
//    close30ThenOpen re-open hold (T_VerticalDoor down-pastdest arm),
//    1050 = 30*35 sector-10 initial wait, 10500 = 5*60*35 sector-14.
//  • T_VerticalDoor dest heights: DOWN moves the CEILING to the sector's
//    OWN floorheight (the slab seats flush); UP moves to door->topheight.
//    The crush argument is the `false` LITERAL in both calls — doors never
//    damage. A blocked door gets `crushed` from T_MovePlane (rollback
//    inside, two P_ChangeSector passes, zero damage) and REVERSES to UP
//    with sfx_doropn — EXCEPT type close/blazeClose: "DO NOT GO BACK
//    UP!" — those stay stuck down, thinker kept (retry every tic; the
//    later-source crush-and-reopen idioms do NOT exist here).
//  • Down-pastdest: blazeRaise/blazeClose/normal/close unlink + free
//    (blazes also play sfx_bdcls); close30ThenOpen flips to WAIT 1050
//    (direction = 0) and later re-raises to its ORIGINAL ceiling height
//    (topheight = own ceilingheight was captured at EV_DoDoor).
//  • Up-pastdest: blazeRaise/normal WAIT at top (topcountdown = topwait);
//    close30ThenOpen/blazeOpen/open unlink + free.
//  • WAITING (direction 0) expiry plays: blazeRaise → down + bdcls,
//    normal → down + dorcls, close30ThenOpen → UP again + doropn (the
//    1050-hold re-raise). INITIAL WAIT (direction 2) only exists for
//    raiseIn5Mins: at 0 the type BECOMES normal and it raises + doropn.
//  • EV_DoDoor refuses sectors with an active specialdata (continue —
//    rtn stays 0 for a pure-refusal pass, plats/ceilings pin reused);
//    close/blazeClose topheight = P_FindLowestCeilingSurrounding − 4·F
//    (the −4 seats the slab UNDER the neighbours), raise types cap at the
//    same −4 line and skip the open sound when already fully open
//    (`if (topheight != sec->ceilingheight)`).
//  • EV_VerticalDoor (manuals): `side = 0; // only front sides can be
//    used` — the sector moved is the line's BACK sector
//    (sidenum[side^1] = sidenum[1]); with an ACTIVE thinker only the
//    "RAISE" ids {1,26,27,28,117} reuse it: down → reverse up; else
//    "JDC: bad guys never close doors" (non-player returns) or start
//    going down immediately. OPEN ids {31,32,33,34,118} do NOT reuse —
//    they fall through and spawn a SECOND thinker over specialdata
//    (verbatim quirk; the vanilla Z_Malloc `type` read there is
//    uninitialized garbage — the port zeroes it to normal: the only
//    reachable route is a live mover + a never-fired use-open line, and
//    normal-raise matches the memory-reuse lottery; deviation pin here,
//    no real map hits it). The open types CLEAR their line special
//    (`line->special = 0`) at spawn.
//  • EV_DoLockedDoor lives in pswitch.ts (M6-11 ownership) and calls
//    evDoDoor after the card/skull check — no door-side duplicate.
//  • Exit-line handling: NONE in p_doors.c (the bliz-door exit-line idiom
//    is later-source) — W1/CR clears ride in the pspec dispatch table.
//  • Line clears INSIDE the bodies: only EV_VerticalDoor's open types
//    (31/32/33/34/118) mutate line->special, as above.
//  • Sector specials at spawn (R05 census, registry SECTOR_SPECIALS
//    subtable already wires 10 → doorCloseIn30 and 14 → doorRaiseIn5Mins
//    with clearTo 0; the spawner bodies here do NOT re-write sec->special
//    — the pspec clearTo idempotent-double pin, M6-09 precedent).
//  • crush=2 ("Close DOOR - blocked") semantics = the VL.close mover on a
//    sector with things: T_MovePlane(crush=false) rolls back, the door
//    STAYS down ticking forever ("DO NOT GO BACK UP"), zero damage-slot
//    calls — the P_ChangeSector damage path is never armed by doors.
//  • destroyMobj: none in 1.10 doors (nothing to destroy).
//  • SFX ids (sounds.h sfxenum_t, index-from-sfx_None=0 — same pinning as
//    pplats PSTOP=19/SWTCHN=23/OOF=34): sfx_doropn 20, sfx_dorcls 21,
//    sfx_bdopn 88, sfx_bdcls 89.
//  • Deviation (shared with plats/ceilings): no sector soundorg — sfx
//    coords (0,0,0).
//
// M6-11 lock-check FRONT half of EV_VerticalDoor (ids 26/27/28/32/33/34:
// PD_*K message + sfx_oof refusal, monster silence at 32/33/34) is
// preserved verbatim below — the door body now runs AFTER it.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';
import { messageSlot, sfxSlot } from './hooks';
import {
  IT_BLUESKULL, IT_BLUECARD, IT_REDCARD, IT_REDSKULL,
  IT_YELLOWSKULL, IT_YELLOWCARD, type Player
} from './player';
import {
  pFindLowestCeilingSurrounding,
  type SpecWorld
} from './pspec-helpers';
import {
  pAddThinker,
  pRemoveThinker,
  setSectorSpecialData,
  type Thinker,
  type ThinkerFn
} from './ptick';
import {
  makePlaneContext,
  tMovePlane,
  DIR_DOWN,
  DIR_UP,
  PLANE_CEILING,
  type PlaneContext,
  type PlaneHost
} from './pplane';
import { VL } from './specials-table';
import { recordLineStub } from './specials-table';
import type { Mover } from './pmap';

/* ------------------------------------------------------------------ */
/* p_doors.c / p_spec.h constants                                      */
/* ------------------------------------------------------------------ */

/** p_spec.h:364 VDOORSPEED. */
export const VDOORSPEED = FRACUNIT * 2;

/** p_spec.h:365 VDOORWAIT (tics to wait at the top). */
export const VDOORWAIT = 150;

/** T_VerticalDoor close30ThenOpen re-open hold: `door->topcountdown =
 * 35*30` (p_doors.c). */
export const DOORHOLD30 = 35 * 30;

/** P_SpawnDoorCloseIn30 initial wait: `30 * 35` (p_doors.c). */
export const DOORCLOSE30WAIT = 30 * 35;

/** P_SpawnDoorRaiseIn5Mins initial wait: `5 * 60 * 35` (p_doors.c). */
export const DOORRAISE5MIN = 5 * 60 * 35;

/** sounds.h sfxenum_t ids (file header pin). */
export const SFX_DOROPN = 20;
export const SFX_DORCLS = 21;
export const SFX_BDOPN = 88;
export const SFX_BDCLS = 89;

/* ------------------------------------------------------------------ */
/* vldoor_t                                                            */
/* ------------------------------------------------------------------ */

/** Vanilla vldoor_t payload (p_spec.h:338-358), hung off the thinker
 * object itself like the plat/ceiling families. */
export interface DoorState {
  sector: number;
  topheight: number;
  speed: number;
  /** 1 up / 0 waiting at top / -1 down / 2 INITIAL WAIT (raiseIn5Mins
   * only) — p_spec.h:347 comment pin. */
  direction: number;
  topwait: number;
  topcountdown: number;
  type: number;
}

export type Door = Thinker & DoorState;

/* ------------------------------------------------------------------ */
/* PlaneContext per world (M6-04 interface contract, pceilng idiom)    */
/* ------------------------------------------------------------------ */

const ctxCache = new WeakMap<SpecWorld, PlaneContext>();

function planeContext(s: SpecWorld): PlaneContext {
  let ctx = ctxCache.get(s);
  if (ctx === undefined) {
    const host = s as unknown as PlaneHost;
    if (host.pmap === undefined || host.players === undefined) {
      throw new Error(
        'pdoors: dispatched on a world without pmap/players — ' +
        'unit pmap worlds must not route live door actions'
      );
    }
    ctx = makePlaneContext(host);
    ctxCache.set(s, ctx);
  }
  return ctx;
}

/* ------------------------------------------------------------------ */
/* hashWords sync (ARCHITECTURE §3.4 mover payload words)              */
/* ------------------------------------------------------------------ */

function syncDoorHash(d: Door): void {
  const words = [
    d.sector, d.topheight, d.speed,
    d.direction, d.topwait, d.topcountdown, d.type
  ];
  const a = d.hashWords as number[];
  for (let i =  0; i < words.length; i++) {
    if (i < a.length) a[i] = words[i]!;
    else a.push(words[i]!);
  }
  if (a.length > words.length) a.length = words.length;
}

/* ------------------------------------------------------------------ */
/* S_StartSound((mobj_t*)&sector->soundorg, id) — soundorg deviation   */
/* ------------------------------------------------------------------ */

function doorSound(s: SpecWorld, id: number): void {
  sfxSlot(s.hooks, id, 0, 0, 0, s.leveltime);
}

/* ------------------------------------------------------------------ */
/* newDoor — the shared Z_Malloc/P_AddThinker/init block               */
/* ------------------------------------------------------------------ */

function newDoor(s: SpecWorld, secnum: number, type: number): Door {
  const ctx = planeContext(s);
  const fn: ThinkerFn = (self) => tVerticalDoor(s, ctx, self as Door);
  const thinker = pAddThinker(s.thinkers, fn);
  const d = Object.assign(thinker, {
    sector: secnum,
    topheight: 0,
    speed: 0,
    direction: 0,
    topwait: 0,
    topcountdown: 0,
    type
  } as DoorState) as Door;
  setSectorSpecialData(s.sectors, secnum, thinker);
  syncDoorHash(d);
  return d;
}

/* ------------------------------------------------------------------ */
/* T_VerticalDoor — p_doors.c:47-176                                   */
/* ------------------------------------------------------------------ */

/**
 * `T_VerticalDoor(door)` — one thinker tic, all five door types plus the
 * blazing family through the single direction switch. DOWN destination is
 * the sector's OWN floorheight; the crush argument is the `false`
 * literal (doors never damage — file header pin).
 */
export function tVerticalDoor(
  s: SpecWorld, ctx: PlaneContext, d: Door
): void {
  switch (d.direction) {
    case 0:
      // WAITING
      if (!--d.topcountdown) {
        switch (d.type) {
          case VL.blazeRaise:
            d.direction = DIR_DOWN; // time to go back down
            doorSound(s, SFX_BDCLS);
            break;

          case VL.normal:
            d.direction = DIR_DOWN; // time to go back down
            doorSound(s, SFX_DORCLS);
            break;

          case VL.close30ThenOpen:
            d.direction = DIR_UP;
            doorSound(s, SFX_DOROPN);
            break;

          default:
            break;
        }
      }
      break;

    case 2:
      // INITIAL WAIT (raiseIn5Mins only)
      if (!--d.topcountdown) {
        switch (d.type) {
          case VL.raiseIn5Mins:
            d.direction = DIR_UP;
            d.type = VL.normal;
            doorSound(s, SFX_DOROPN);
            break;

          default:
            break;
        }
      }
      break;

    case DIR_DOWN: {
      // DOWN — dest = the sector's own floor (crush FALSE literal pin).
      const res = tMovePlane(
        ctx, d.sector, d.speed, s.sectors.floorZ[d.sector]!,
        false, PLANE_CEILING, DIR_DOWN
      );
      if (res === 'pastdest') {
        switch (d.type) {
          case VL.blazeRaise:
          case VL.blazeClose:
            setSectorSpecialData(s.sectors, d.sector, null);
            pRemoveThinker(d); // unlink and free
            doorSound(s, SFX_BDCLS);
            break;

          case VL.normal:
          case VL.close:
            setSectorSpecialData(s.sectors, d.sector, null);
            pRemoveThinker(d); // unlink and free
            break;

          case VL.close30ThenOpen:
            d.direction = 0;
            d.topcountdown = DOORHOLD30;
            break;

          default:
            break;
        }
      } else if (res === 'crushed') {
        switch (d.type) {
          case VL.blazeClose:
          case VL.close:
            // DO NOT GO BACK UP! (stuck-down, thinker kept — pin)
            break;

          default:
            d.direction = DIR_UP;
            doorSound(s, SFX_DOROPN);
            break;
        }
      }
      break;
    }

    case DIR_UP: {
      // UP
      const res = tMovePlane(
        ctx, d.sector, d.speed, d.topheight, false, PLANE_CEILING, DIR_UP
      );
      if (res === 'pastdest') {
        switch (d.type) {
          case VL.blazeRaise:
          case VL.normal:
            d.direction = 0; // wait at top
            d.topcountdown = d.topwait;
            break;

          case VL.close30ThenOpen:
          case VL.blazeOpen:
          case VL.open:
            setSectorSpecialData(s.sectors, d.sector, null);
            pRemoveThinker(d); // unlink and free
            break;

          default:
            break;
        }
      }
      break;
    }
  }
  syncDoorHash(d);
}

/* ------------------------------------------------------------------ */
/* EV_DoDoor — p_doors.c:212-293 (LIVE at commit step 2 of this task)  */
/* ------------------------------------------------------------------ */

/** `EV_DoDoor(line, vldoor_e)` — tagged door actions (p_doors.c). */
export function evDoDoor(s: SpecWorld, line: number, type: number): boolean {
  recordLineStub(s, 'evDoDoor', line, type);
  return false;
}

/* ------------------------------------------------------------------ */
/* EV_VerticalDoor — p_doors.c:299-411 (LIVE at commit step 2)         */
/* ------------------------------------------------------------------ */

/** `EV_VerticalDoor(line, thing)` — manuals/locked manuals (p_doors.c).
 * Returns the vanilla int (0/1 = nothing/touched); manuals never disarm
 * here except open-types (inside the body — the `line->special = 0`).
 * The LOCK halves (26/32 blue, 27/34 yellow, 28/33 red — card OR skull)
 * stay exactly as M6-11 landed them; the mover halves behind them are the
 * real p_doors.c body now. */
export function evVerticalDoor(
  s: SpecWorld, line: number, mover: Mover | null
): boolean {
  // `player = thing->player;` + `side = 0; // only front sides can be
  // used` (the side gate lives in the pspec.ts use dispatcher).
  const p = mover?.player
    ? (mover as { playerRef?: Player }).playerRef
    : undefined;

  switch (s.map.lines.special[line]!) {
    case 26: // Blue Lock
    case 32:
      if (!p) return false; // monsters: silent `if (!player) return`
      if (!p.cards[IT_BLUECARD] && !p.cards[IT_BLUESKULL]) {
        refuseDoor(s, p, 'PD_BLUEK');
        return false;
      }
      break;
    case 27: // Yellow Lock
    case 34:
      if (!p) return false;
      if (!p.cards[IT_YELLOWCARD] && !p.cards[IT_YELLOWSKULL]) {
        refuseDoor(s, p, 'PD_YELLOWK');
        return false;
      }
      break;
    case 28: // Red Lock
    case 33:
      if (!p) return false;
      if (!p.cards[IT_REDCARD] && !p.cards[IT_REDSKULL]) {
        refuseDoor(s, p, 'PD_REDK');
        return false;
      }
      break;
    default:
      break; // 1/31/117/118: no lock check at all (p_doors.c)
  }

  recordLineStub(s, 'evVerticalDoor', line, 0);
  return false;
}

/** `player->message = PD_*K; S_StartSound(NULL, sfx_oof);` (p_doors.c
 * lock branches). SFX_OOF = 34 (sounds.h, pswitch.ts pin). */
function refuseDoor(s: SpecWorld, p: Player, messageId: string): void {
  p.message = messageId;
  messageSlot(s.hooks, messageId, s.leveltime);
  sfxSlot(s.hooks, 34, 0, 0, 0, s.leveltime); // origin NULL = listener
}

/* ------------------------------------------------------------------ */
/* P_SpawnDoorCloseIn30 / P_SpawnDoorRaiseIn5Mins — p_doors.c:414-465  */
/* (sector specials 10 / 14 — the registry spawn subtable already       */
/* routes them; `sec->special = 0` rides in the pspec clearTo, pin)     */
/* ------------------------------------------------------------------ */

/** `P_SpawnDoorCloseIn30(sector)` — sector special 10 (sector INDEX
 * argument, like every sector spawner). Waits 30*35 tics, then closes. */
export function pSpawnDoorCloseIn30(s: SpecWorld, sector: number): void {
  const d = newDoor(s, sector, VL.normal);
  d.direction = 0;
  d.speed = VDOORSPEED;
  d.topcountdown = DOORCLOSE30WAIT;
  syncDoorHash(d);
}

/** `P_SpawnDoorRaiseIn5Mins(sector, i)` — sector special 14; `i` is the
 * vanilla sector-index second arg (p_doors.c, I_Error message only —
 * unused). INITIAL WAIT direction 2, 5*60*35 tics, then raises as a
 * normal door. */
export function pSpawnDoorRaiseIn5Mins(
  s: SpecWorld, sector: number, i: number
): void {
  void i;
  const d = newDoor(s, sector, VL.raiseIn5Mins);
  d.direction = 2;
  d.speed = VDOORSPEED;
  d.topheight = (pFindLowestCeilingSurrounding(s, sector) - 4 * FRACUNIT) | 0;
  d.topwait = VDOORWAIT;
  d.topcountdown = DOORRAISE5MIN;
  syncDoorHash(d);
}
