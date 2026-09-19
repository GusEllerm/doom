// sim/pplats.ts — plats/lifts (p_plats.c). M6-06: REAL bodies replacing the
// M6-03 stubs, signatures unchanged (pspec.ts registry dispatch + tests are
// the only call sites). Parent: M6-plan §M6-06.
//
// ---------------------------------------------------------------------------
// SOURCE TRUTH (verified line-by-line against linuxdoom-1.10/p_plats.c)
// ---------------------------------------------------------------------------
//  • `plat_e` (p_spec.h:261-269): up=0, down=1, waiting=2, in_stasis=3 —
//    so `plat->status = P_Random()&1` (EV_DoPlat perpetualRaise) is
//    UP(0)-or-DOWN(1), NOT up-or-stasis (enum-order pin; later-source
//    reorderings irrelevant here).
//  • `plattype_e`: perpetualRaise=0, downWaitUpStay=1, raiseAndChange=2,
//    raiseToNearestAndChange=3, blazeDWUS=4 (specials-table PLAT mirror).
//  • Constants p_spec.h:304-306: PLATWAIT=3 (⇒ wait 35*PLATWAIT=105),
//    PLATSPEED=FRACUNIT, MAXPLATS=30.
//  • Speeds (EV_DoPlat switch, verbatim): raiseToNearestAndChange and
//    raiseAndChange = PLATSPEED/2; downWaitUpStay = PLATSPEED*4;
//    blazeDWUS = PLATSPEED*8; perpetualRaise = PLATSPEED. PIN: 1.10
//    blazeDWUS waits the FULL 105 tics and raises at the SAME speed 8
//    both ways — the prboom family (LOW_SLOW_8/FAST_WAIT/10-tic blaze
//    waits, up-speed×3) does NOT exist in this source. `LOW_SLOW_8` et
//    al. are not 1.10 identifiers (p_local.h carries only floor/ceiling
//    speeds); pinned type list = the five plattype_e values above.
//  • crush: EV_DoPlat sets `plat->crush = false` for EVERY type and
//    T_PlatRaise passes `false` explicitly on the down move — plats
//    NEVER crush (pplane contract: down = crush=false hard-coded; up =
//    plat->crush === false, so a blocked rise returns 'crushed' from
//    T_MovePlane and the plat turns around (up→down), zero damage).
//  • T_PlatRaise `case waiting: if (!--count) { status = floor==low ? up
//    : down; pstart; }` FALLS THROUGH to `case in_stasis: break;` (kept).
//  • Stasis (54/89): EV_StopPlat saves oldstatus, sets in_stasis and
//    thinker.function=NULL (linked, never ticked — ptick.ts `fn=null`
//    idiom); P_ActivateInStasis (perpetualRaise re-fire) restores
//    oldstatus + the fn.
//  • DWUS/blaze/raise&Change self-remove at the up-arrival pastdest via
//    P_RemoveActivePlat (specialdata clear + P_RemoveThinker).
//  • raiseToNearestAndChange: floorpic copy from the use line's front
//    side's sector AND `sec->special = 0` — "NO MORE DAMAGE, IF
//    APPLICABLE" quirk, applied at TRIGGER time (p_plats.c:207).
//  • `activeplats[MAXPLATS]` is DEFINED here (p_plats.c:41) and re-export
//    by pspec.ts (stasis scans + P_SpawnSpecials reset live there).
//  • 1.10 has NO exit-line handling in T_PlatRaise (the bliz exit-line
//    idiom is later-source) and NO P_SpawnPlat / plat sector spawner —
//    P_SpawnSpecials' only plat duty is the activeplats reset (M6-03
//    wired; nothing to add here).
//  • Deviation (logged M6-06): `S_StartSound((mobj_t*)&sector->soundorg)`
//    — the port has no sector soundorg centroid; the sfx SLOT is called
//    with coords (0,0,0), count/id/tic semantics unaffected.
//  • floorpic copy: the live sector SoA (M6-01) has no mutable flat
//    channel (flat is not hashed), so the copy is recorded in
//    {@link floorFlatOverrides}/{@link platFlatCopies} — the renderer
//    seam / D013 carve-out picks it up when flats go live (M6-07 donut
//    shares the gap; FOLLOW-UP). `sec->special = 0` IS applied live.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';
import { sfxSlot } from './hooks';
import { pRandom } from './prng';
import {
  pFindHighestFloorSurrounding,
  pFindLowestFloorSurrounding,
  pFindNextHighestFloor,
  pFindSectorFromLineTag,
  type SpecWorld
} from './pspec-helpers';
import {
  pAddThinker,
  pRemoveThinker,
  sectorSpecialData,
  setSectorSpecialData,
  type Thinker,
  type ThinkerFn
} from './ptick';
import {
  makePlaneContext,
  tMovePlane,
  DIR_DOWN,
  DIR_UP,
  PLANE_FLOOR,
  type PlaneContext,
  type PlaneHost
} from './pplane';
import { PLAT } from './specials-table';

/* ------------------------------------------------------------------ */
/* p_plats.c / p_spec.h constants                                      */
/* ------------------------------------------------------------------ */

/** p_spec.h:306 MAXPLATS. */
export const MAXPLATS = 30;

/** p_spec.h:304-305. */
export const PLATWAIT = 3;
export const PLATSPEED = FRACUNIT;

/** p_spec.h plat_e (up, down, waiting, in_stasis). */
export const PLAT_UP = 0;
export const PLAT_DOWN = 1;
export const PLAT_WAITING = 2;
export const PLAT_IN_STASIS = 3;

/** sounds.h sfxenum ids, index-from-sfx_None=0 convention pinned by
 * pspec.ts SFX_SWTCHN=23 (sfx_pstart/pstop/stnmov are 23−5/23−4/23−1). */
export const SFX_PSTART = 18;
export const SFX_PSTOP = 19;
export const SFX_STNMOV = 22;

/* ------------------------------------------------------------------ */
/* plat_t + the activeplats global                                     */
/* ------------------------------------------------------------------ */

/** Vanilla plat_t payload, hung off the thinker object itself (vanilla
 * embeds thinker_t at offset 0 — the same object lives in the arena AND
 * activeplats, and hashWords carries the state to hashState). */
export interface PlatState {
  sector: number;
  speed: number;
  low: number;
  high: number;
  wait: number;
  count: number;
  status: number;
  oldstatus: number;
  crush: boolean;
  tag: number;
  type: number;
  /** the T_PlatRaise closure — P_ActivateInStasis restores thinker.fn
   * from it (vanilla rewrites the function pointer). */
  revive: ThinkerFn;
}

export type Plat = Thinker & PlatState;

/** `plat_t* activeplats[MAXPLATS]` (p_plats.c:41). Typed Thinker|null so
 * pspec.ts's level-reset (and its unit tests) can clear/inject plain
 * thinker shapes; the family casts to Plat (every entry it stores is one). */
export const activePlats: (Thinker | null)[] =
  new Array<Thinker | null>(MAXPLATS).fill(null);

/** Overflow bookkeeping (vanilla `I_Error("P_AddActivePlat: no more
 * plats!")` / `P_RemoveActivePlat: can't find plat!` slots — counted,
 * same idiom as pspecCounts.linespecialOverflow). */
export const pplatsCounts = {
  addOverflow: 0,
  removeNotFound: 0
};
export function resetPplatsCounts(): void {
  pplatsCounts.addOverflow = 0;
  pplatsCounts.removeNotFound = 0;
}

/* ------------------------------------------------------------------ */
/* floorpic copy channel (deviation, file header)                      */
/* ------------------------------------------------------------------ */

/** Live `sec->floorpic = <other sector>` overrides recorded at trigger
 * time (raiseAndChange/raiseToNearestAndChange). Map = live sector index
 * → flat name; deterministic, iteration order is insertion. */
export const floorFlatOverrides = new Map<number, string>();
/** Capped event log for L2 assertions (sector, source sector, tic). */
export const platFlatCopies: { count: number; entries: {
  sector: number; from: number; tic: number
}[] } = { count: 0, entries: [] };

export function resetPlatFlatCopies(): void {
  floorFlatOverrides.clear();
  platFlatCopies.count = 0;
  platFlatCopies.entries.length = 0;
}

/* ------------------------------------------------------------------ */
/* PlaneContext per world (M6-04 interface contract)                    */
/* ------------------------------------------------------------------ */

const ctxCache = new WeakMap<SpecWorld, PlaneContext>();

function planeContext(s: SpecWorld): PlaneContext {
  let ctx = ctxCache.get(s);
  if (ctx === undefined) {
    const host = s as unknown as PlaneHost;
    if (host.pmap === undefined || host.players === undefined) {
      throw new Error(
        'pplats: dispatched on a world without pmap/players — ' +
        'unit pmap worlds must not route live plat actions'
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

function syncPlatHash(p: Plat): void {
  const words = [
    p.sector, p.speed, p.low, p.high, p.wait, p.count,
    p.status, p.oldstatus, p.tag, p.type, p.crush ? 1 : 0
  ];
  const a = p.hashWords as number[];
  for (let i = 0; i < words.length; i++) {
    if (i < a.length) a[i] = words[i]!;
    else a.push(words[i]!);
  }
  if (a.length > words.length) a.length = words.length;
}

/* ------------------------------------------------------------------ */
/* S_StartSound((mobj_t*)&sector->soundorg, id) — soundorg deviation   */
/* ------------------------------------------------------------------ */

function platSound(s: SpecWorld, id: number): void {
  sfxSlot(s.hooks, id, 0, 0, 0, s.leveltime);
}

/* ------------------------------------------------------------------ */
/* T_PlatRaise (p_plats.c:46-141)                                      */
/* ------------------------------------------------------------------ */

/** `T_PlatRaise(plat)` — one thinker tic, verbatim switch/branching. */
export function tPlatRaise(s: SpecWorld, ctx: PlaneContext, p: Plat): void {
  switch (p.status) {
    case PLAT_UP: {
      const res = tMovePlane(
        ctx, p.sector, p.speed, p.high, p.crush, PLANE_FLOOR, DIR_UP
      );

      if (p.type === PLAT.raiseAndChange || p.type === PLAT.raiseToNearestAndChange) {
        // sfx_stnmov every 8th tic while a "change" plat rises (p_plats.c:55).
        if (!(s.leveltime & 7)) platSound(s, SFX_STNMOV);
      }

      if (res === 'crushed' && !p.crush) {
        // Blocked rise (a thing under the slab): turn around, no crush —
        // plats never damage (file header).
        p.count = p.wait;
        p.status = PLAT_DOWN;
        platSound(s, SFX_PSTART);
      } else if (res === 'pastdest') {
        p.count = p.wait;
        p.status = PLAT_WAITING;
        platSound(s, SFX_PSTOP);

        switch (p.type) {
          case PLAT.blazeDWUS:
          case PLAT.downWaitUpStay:
          case PLAT.raiseAndChange:
          case PLAT.raiseToNearestAndChange:
            pRemoveActivePlat(s, p);
            break;
          default:
            break;
        }
      }
      break;
    }

    case PLAT_DOWN: {
      // crush=false HARD-CODED in vanilla (p_plats.c:103).
      const res = tMovePlane(
        ctx, p.sector, p.speed, p.low, false, PLANE_FLOOR, DIR_DOWN
      );
      if (res === 'pastdest') {
        p.count = p.wait;
        p.status = PLAT_WAITING;
        platSound(s, SFX_PSTOP);
      }
      break;
    }

    case PLAT_WAITING:
      if (!--p.count) {
        if (s.sectors.floorZ[p.sector] === p.low) p.status = PLAT_UP;
        else p.status = PLAT_DOWN;
        platSound(s, SFX_PSTART);
      }
    // Pin: vanilla `case waiting:` FALLS THROUGH to the empty
    // `case in_stasis: break;` (p_plats.c:133-135) — observable behavior
    // is identical to this break, so the literal fallthrough is not
    // reproduced (TS7029/eslint no-fallthrough stay green).
    break;
    case PLAT_IN_STASIS:
      break;
  }
  syncPlatHash(p);
}

/* ------------------------------------------------------------------ */
/* EV_DoPlat (p_plats.c:148-270)                                       */
/* ------------------------------------------------------------------ */

/**
 * `EV_DoPlat(line, plattype_e, amount)` — returns `rtn` (any sector got a
 * new/revived mover… vanilla sets rtn=1 per spawned sector only; the
 * stasis revival alone returns 0 — pinned, later sources differ).
 * `amount` is used ONLY by raiseAndChange (units, p_plats.c:216); the
 * registry pins amount=1 for special 62 (p_switch.c case 62) and DWUS
 * ignores it — parity asserted in pplats.test.
 */
export function evDoPlat(
  s: SpecWorld, line: number, type: number, amount: number
): boolean {
  const ctx = planeContext(s);
  const tag = s.map.lines.tag[line]!;

  // Activate all <type> plats that are in_stasis (p_plats.c:167-175).
  if (type === PLAT.perpetualRaise) pActivateInStasis(s, tag);

  let rtn = 0;
  let secnum = -1;
  while ((secnum = pFindSectorFromLineTag(s, line, secnum)) >= 0) {
    if (sectorSpecialData(s.sectors, secnum) !== null) continue;

    // Find lowest & highest floors around sector.
    rtn = 1;
    const fn: ThinkerFn = (self) => tPlatRaise(s, ctx, self as Plat);
    const thinker = pAddThinker(s.thinkers, fn);
    const p = Object.assign(thinker, {
      sector: secnum,
      speed: 0,
      low: s.sectors.floorZ[secnum]!,
      high: s.sectors.floorZ[secnum]!,
      wait: 0,
      count: 0,
      status: PLAT_UP,
      oldstatus: PLAT_UP,
      crush: false, // every plat type: plats never crush (file header)
      tag,
      type,
      revive: fn
    } as PlatState) as Plat;
    setSectorSpecialData(s.sectors, secnum, thinker);

    switch (type) {
      case PLAT.raiseToNearestAndChange: {
        p.speed = PLATSPEED / 2 | 0; // PLATSPEED/2 (fixed-point exact)
        copyFloorpicFrom(s, p, line);
        p.high = pFindNextHighestFloor(s, secnum, s.sectors.floorZ[secnum]!);
        p.wait = 0;
        p.status = PLAT_UP;
        // NO MORE DAMAGE, IF APPLICABLE (p_plats.c:207).
        s.sectors.special[secnum] = 0;
        platSound(s, SFX_STNMOV);
        break;
      }

      case PLAT.raiseAndChange: {
        p.speed = PLATSPEED / 2 | 0;
        copyFloorpicFrom(s, p, line);
        p.high = (s.sectors.floorZ[secnum]! + amount * FRACUNIT) | 0;
        p.wait = 0;
        p.status = PLAT_UP;
        platSound(s, SFX_STNMOV);
        break;
      }

      case PLAT.downWaitUpStay: {
        p.speed = (PLATSPEED * 4) | 0;
        p.low = pFindLowestFloorSurrounding(s, secnum);
        if (p.low > s.sectors.floorZ[secnum]!) p.low = s.sectors.floorZ[secnum]!;
        p.high = s.sectors.floorZ[secnum]!;
        p.wait = 35 * PLATWAIT; // 105
        p.status = PLAT_DOWN;
        platSound(s, SFX_PSTART);
        break;
      }

      case PLAT.blazeDWUS: {
        p.speed = (PLATSPEED * 8) | 0;
        p.low = pFindLowestFloorSurrounding(s, secnum);
        if (p.low > s.sectors.floorZ[secnum]!) p.low = s.sectors.floorZ[secnum]!;
        p.high = s.sectors.floorZ[secnum]!;
        p.wait = 35 * PLATWAIT; // 1.10 pin: blaze waits the FULL 105
        p.status = PLAT_DOWN;
        platSound(s, SFX_PSTART);
        break;
      }

      case PLAT.perpetualRaise: {
        p.speed = PLATSPEED;
        p.low = pFindLowestFloorSurrounding(s, secnum);
        if (p.low > s.sectors.floorZ[secnum]!) p.low = s.sectors.floorZ[secnum]!;
        p.high = pFindHighestFloorSurrounding(s, secnum);
        if (p.high < s.sectors.floorZ[secnum]!) p.high = s.sectors.floorZ[secnum]!;
        p.wait = 35 * PLATWAIT;
        // plat_e pin: up=0, down=1 ⇒ the &1 picks UP(0) or DOWN(1).
        p.status = pRandom(s.rng) & 1;
        platSound(s, SFX_PSTART);
        break;
      }
    }
    syncPlatHash(p);
    pAddActivePlat(s, p);
  }
  return rtn !== 0;
}

/** `sec->floorpic = sides[line->sidenum[0]].sector->floorpic` — the use
 * line's front side's sector's floor flat (1.10 sidedefs alias their
 * front sector). Recorded per the file-header deviation. */
function copyFloorpicFrom(s: SpecWorld, p: Plat, line: number): void {
  const from = s.map.lines.sectorFront[line]!;
  const flat = s.map.sectors.floorFlat[from]!;
  floorFlatOverrides.set(p.sector, flat);
  platFlatCopies.count++;
  if (platFlatCopies.entries.length < 4096) {
    platFlatCopies.entries.push({ sector: p.sector, from, tic: s.leveltime });
  }
}

/* ------------------------------------------------------------------ */
/* Stasis: P_ActivateInStasis / EV_StopPlat (p_plats.c:272-303)        */
/* ------------------------------------------------------------------ */

/** `P_ActivateInStasis(tag)` — revive matching parked plats (perpetual
 * re-fire only; EV_DoPlat never spawns over the still-set specialdata). */
export function pActivateInStasis(_s: SpecWorld, tag: number): void {
  for (let i = 0; i < MAXPLATS; i++) {
    const p = activePlats[i] as Plat | null;
    if (p !== null && p.tag === tag && p.status === PLAT_IN_STASIS) {
      p.status = p.oldstatus;
      p.fn = p.revive;
      syncPlatHash(p);
    }
  }
}

/** `EV_StopPlat(line)` — specials 54/89. Void in vanilla; the port keeps
 * the stub's `true` ("reached the case") so p_use switch arming is
 * unchanged. */
export function evStopPlat(s: SpecWorld, line: number): boolean {
  const tag = s.map.lines.tag[line]!;
  for (let j = 0; j < MAXPLATS; j++) {
    const p = activePlats[j] as Plat | null;
    if (p !== null && p.status !== PLAT_IN_STASIS && p.tag === tag) {
      p.oldstatus = p.status;
      p.status = PLAT_IN_STASIS;
      p.fn = null; // linked but never ticked (ptick stasis idiom)
      syncPlatHash(p);
    }
  }
  return true; // void in vanilla — treated as "reached the case"
}

/* ------------------------------------------------------------------ */
/* P_AddActivePlat / P_RemoveActivePlat (p_plats.c:305-335)            */
/* ------------------------------------------------------------------ */

/** `P_AddActivePlat(plat)` — first empty slot; overflow counted (vanilla
 * I_Error). */
export function pAddActivePlat(_s: SpecWorld, plat: Plat): void {
  for (let i = 0; i < MAXPLATS; i++) {
    if (activePlats[i] === null) {
      activePlats[i] = plat;
      return;
    }
  }
  pplatsCounts.addOverflow++; // I_Error("P_AddActivePlat: no more plats!")
}

/** `P_RemoveActivePlat(plat)` — clears the sector's specialdata, removes
 * the thinker (lazy sentinel) and frees the slot. */
export function pRemoveActivePlat(s: SpecWorld, plat: Plat): void {
  for (let i = 0; i < MAXPLATS; i++) {
    if (plat === activePlats[i]) {
      setSectorSpecialData(s.sectors, plat.sector, null);
      pRemoveThinker(plat);
      activePlats[i] = null;
      return;
    }
  }
  pplatsCounts.removeNotFound++; // I_Error("P_RemoveActivePlat: can't find plat!")
}
