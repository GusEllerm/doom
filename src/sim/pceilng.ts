// sim/pceilng.ts — ceilings incl. crushers (p_ceilng.c — 1.10 filename, NOT
// p_ceiling.c). M6-08: REAL bodies replacing the M6-03 stubs, signatures
// unchanged (pspec.ts registry dispatch is the only call site). Parent:
// M6-plan §M6-08; mover interface = the pplane.ts M6-04 contract.
//
// ---------------------------------------------------------------------------
// SOURCE TRUTH (verified line-by-line against linuxdoom-1.10/p_ceilng.c)
// ---------------------------------------------------------------------------
//  • `ceiling_e` (p_spec.h:479-487) = lowerToFloor 0, raiseToHighest 1,
//    lowerAndCrush 2, crushAndRaise 3, fastCrushAndRaise 4,
//    silentCrushAndRaise 5 (specials-table CEIL mirror). No T_CrushCeiling
//    and no separate crusher thinker exist in 1.10 — the crusher IS
//    T_MoveCeiling's down→up cycle with the crush flag (later-source
//    T_CrushCeiling / ceilingWait / LOW_SLOW_8 idioms do NOT exist here).
//  • Constants p_spec.h:516-518: CEILSPEED = FRACUNIT, MAXCEILINGS = 30.
//    `direction` comment pin (p_spec.h:503): "1 = up, 0 = waiting, -1 =
//    down" — ceilings never WAIT; 0 is the in-stasis sentinel set by
//    EV_CeilingCrushStop together with thinker.function = NULL (the same
//    linked-but-unticked idiom as plats; the `case 0: break;` in
//    T_MoveCeiling is the defensive arm).
//  • EV_DoCeiling switch arms verbatim — the crush FLAG is set true ONLY by
//    fastCrushAndRaise and the silent/crushAndRaise arm. QUIRK PIN:
//    lowerAndCrush (specials 44/72 "Ceiling Crush") inherits crush = false
//    from the init line — the vanilla `case silentCrushAndRaise:
//    case crushAndRaise:` arm FALLS THROUGH to `case lowerAndCrush:
//    case lowerToFloor:`, and lowerAndCrush enters at the shared bottom
//    label WITHOUT the crush=true statement. It therefore never damages:
//    a stuck thing makes T_MovePlane roll back and the ceiling retries at
//    the crushed-slowed CEILSPEED/8 (T_MoveCeiling's crushed arm lists
//    silentCrushAndRaise/crushAndRaise/lowerAndCrush) with ZERO damage
//    slot calls. lowerToFloor: bottom = floor EXACTLY (the `type !=
//    lowerToFloor` +8·F guard), also crush=false.
//  • Fast crusher speed pin: fastCrushAndRaise = CEILSPEED*2 BOTH ways —
//    the crushed-slow arm does NOT list it (never slows to /8) and the
//    down-arrival pastdest arm resets `speed = CEILSPEED` only in the
//    crushAndRaise case (the silent → crushAndRaise → fastCrushAndRaise
//    FALLTHROUGH chain: silent plays sfx_pstop then falls through the
//    speed reset into direction = UP; crushAndRaise resets speed then
//    falls into fast's direction = UP). At the UP arrival the silent type
//    plays sfx_pstop and falls through to `direction = -1` (same
//    fallthrough family). tsconfig noFallthroughCasesInSwitch ⇒ the arms
//    are expressed as equivalent explicit statements (observably
//    identical; this header is the pin).
//  • SFX pin: `if (!(leveltime&7))` sfx_stnmov every 8th tic of BOTH the
//    up and the down move for EVERY type except silentCrushAndRaise;
//    silent additionally plays sfx_pstop at each pastdest turnaround
//    (up→down and down→up). Silent ⇒ sfx slot count stays 0 for stnmov
//    (counter assert per plan §M6-08).
//  • EV_DoCeiling stasis revival (P_ActivateInStasisCeiling) runs ONLY for
//    fastCrushAndRaise / silentCrushAndRaise / crushAndRaise (vanilla
//    switch fallthrough into `default: break`); the revival alone returns
//    rtn = 0 (rtn is set per spawned sector only — same pin as plats).
//    specialdata refuses a second mover while one is live.
//  • EV_CeilingCrushStop (57 W1 / 74 GR): every SAME-TAG, NON-STASIS
//    ceiling saves olddirection, sets direction = 0 and thinker.function
//    = NULL (linked, never ticked); rtn = any stopped. Re-firing a
//    stasis-revivable type (25/73/6/77/141) restores olddirection + fn.
//  • Exit lines: NONE in p_ceilng.c (the bliz crusher exit-line idiom is
//    later-source) — W1 clears ride in the pspec dispatch table (57/25/6/
//    40/44/141 clear:true), GR 72/73/74/77 keep. Pinned in pceilng.test.
//  • Sector specials: P_SpawnSpecials has NO ceiling case at all (13/14
//    are a strobe LIGHT and a door — census verified: ceiling family =
//    the 13 LINE ids 6,25,40,41,43,44,49,57,72,73,74,77,141 only).
//  • `#if 0` pin (inherited via tMovePlane): ceiling UP is NEVER blocked —
//    a rising ceiling pushes things through pThingHeightClip, zero nofit.
//  • `activeceilings[MAXCEILINGS]` is DEFINED here (p_ceilng.c:37) and
//    re-exported by pspec.ts (its P_SpawnSpecials reset indexes the
//    shared array — the M6-06 activeplats ownership precedent; the
//    pspec.ts one-liner swap is the M6-08 integration edit).
//  • Deviation (shared with plats, file-header of pplats.ts): the sector
//    soundorg centroid does not exist — sfxSlot coords are (0,0,0); id/
//    tic/count semantics unaffected.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';
import { sfxSlot } from './hooks';
import {
  pFindHighestCeilingSurrounding,
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
  PLANE_CEILING,
  type PlaneContext,
  type PlaneHost
} from './pplane';
import { CEIL } from './specials-table';

/* ------------------------------------------------------------------ */
/* p_ceilng.c / p_spec.h constants                                     */
/* ------------------------------------------------------------------ */

/** p_spec.h:518 MAXCEILINGS. */
export const MAXCEILINGS = 30;

/** p_spec.h:516 CEILSPEED. */
export const CEILSPEED = FRACUNIT;

/** sounds.h sfxenum ids (index-from-sfx_None=0, same pinning as
 * pplats.ts / pspec.ts SFX_SWTCHN=23). */
export const SFX_PSTOP = 19;
export const SFX_STNMOV = 22;

/* ------------------------------------------------------------------ */
/* ceiling_t + the activeceilings global                               */
/* ------------------------------------------------------------------ */

/** Vanilla ceiling_t payload (p_spec.h:493-510) hung off the thinker
 * object itself (vanilla embeds thinker_t at offset 0 — one object lives
 * in the arena AND activeceilings; hashWords carries the state). */
export interface CeilingState {
  sector: number;
  bottomheight: number;
  topheight: number;
  speed: number;
  crush: boolean;
  /** 1 up / 0 in-stasis / -1 down (p_spec.h:503 comment pin — "waiting"
   * never occurs for ceilings). */
  direction: number;
  tag: number;
  olddirection: number;
  type: number;
  /** the T_MoveCeiling closure — P_ActivateInStasisCeiling restores
   * thinker.fn from it (vanilla rewrites the function pointer). */
  revive: ThinkerFn;
}

export type Ceiling = Thinker & CeilingState;

/** `ceiling_t* activeceilings[MAXCEILINGS]` (p_ceilng.c:37). Typed
 * Thinker|null so pspec.ts's level reset can clear/inject plain thinker
 * shapes; the family casts to Ceiling. */
export const activeCeilings: (Thinker | null)[] =
  new Array<Thinker | null>(MAXCEILINGS).fill(null);

/** Vanilla `I_Error("P_AddActiveCeiling: no more ceilings!")` /
 * `P_RemoveActiveCeiling: can't find ceiling!` slots — counted (same
 * idiom as pplatsCounts). */
export const pceilngCounts = {
  addOverflow: 0,
  removeNotFound: 0
};
export function resetPceilngCounts(): void {
  pceilngCounts.addOverflow = 0;
  pceilngCounts.removeNotFound = 0;
}

/* ------------------------------------------------------------------ */
/* PlaneContext per world (M6-04 interface contract)                   */
/* ------------------------------------------------------------------ */

const ctxCache = new WeakMap<SpecWorld, PlaneContext>();

function planeContext(s: SpecWorld): PlaneContext {
  let ctx = ctxCache.get(s);
  if (ctx === undefined) {
    const host = s as unknown as PlaneHost;
    if (host.pmap === undefined || host.players === undefined) {
      throw new Error(
        'pceilng: dispatched on a world without pmap/players — ' +
        'unit pmap worlds must not route live ceiling actions'
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

function syncCeilingHash(c: Ceiling): void {
  const words = [
    c.sector, c.speed, c.bottomheight, c.topheight,
    c.direction, c.olddirection, c.tag, c.type, c.crush ? 1 : 0
  ];
  const a = c.hashWords as number[];
  for (let i = 0; i < words.length; i++) {
    if (i < a.length) a[i] = words[i]!;
    else a.push(words[i]!);
  }
  if (a.length > words.length) a.length = words.length;
}

/* ------------------------------------------------------------------ */
/* S_StartSound((mobj_t*)&sector->soundorg, id) — soundorg deviation   */
/* ------------------------------------------------------------------ */

function ceilSound(s: SpecWorld, id: number): void {
  sfxSlot(s.hooks, id, 0, 0, 0, s.leveltime);
}

/* ------------------------------------------------------------------ */
/* T_MoveCeiling (p_ceilng.c:41-167, vanilla name T_MoveCeiling)       */
/* ------------------------------------------------------------------ */

/** `T_MoveCeiling(ceiling)` — one thinker tic. The three vanilla
 * fallthrough chains are expanded into equivalent explicit statements
 * (tsconfig noFallthroughCasesInSwitch; the fallthrough family is pinned
 * in the file header). */
export function tMoveCeiling(s: SpecWorld, ctx: PlaneContext, c: Ceiling): void {
  switch (c.direction) {
    case 0:
      // IN STASIS (defensive arm — fn is NULL while in stasis, so the
      // arena never routes here; p_ceilng.c `case 0: break;`).
      break;

    case DIR_UP: {
      // UP — crush flag NOT passed (vanilla `false` literal): ceiling-up
      // never blocks anyway (pplane `#if 0` pin).
      const res = tMovePlane(
        ctx, c.sector, c.speed, c.topheight, false, PLANE_CEILING, DIR_UP
      );

      if (!(s.leveltime & 7) && c.type !== CEIL.silentCrushAndRaise) {
        ceilSound(s, SFX_STNMOV);
      }

      if (res === 'pastdest') {
        switch (c.type) {
          case CEIL.raiseToHighest:
            pRemoveActiveCeiling(s, c);
            break;

          // silentCrushAndRaise: sfx_pstop, FALLS THROUGH to the
          // direction = -1 arm (p_ceilng.c:97-106).
          case CEIL.silentCrushAndRaise:
            ceilSound(s, SFX_PSTOP);
            c.direction = DIR_DOWN;
            break;

          case CEIL.fastCrushAndRaise:
          case CEIL.crushAndRaise:
            c.direction = DIR_DOWN;
            break;

          default:
            break;
        }
      }
      break;
    }

    case DIR_DOWN: {
      // DOWN — crush flag from the mover.
      const res = tMovePlane(
        ctx, c.sector, c.speed, c.bottomheight, c.crush, PLANE_CEILING, DIR_DOWN
      );

      if (!(s.leveltime & 7) && c.type !== CEIL.silentCrushAndRaise) {
        ceilSound(s, SFX_STNMOV);
      }

      if (res === 'pastdest') {
        switch (c.type) {
          // The pstop → speed-reset → direction=UP fallthrough chain
          // (p_ceilng.c:124-133): silent plays pstop AND takes both the
          // crushAndRaise speed reset and the fast direction arm.
          case CEIL.silentCrushAndRaise:
            ceilSound(s, SFX_PSTOP);
            c.speed = CEILSPEED;
            c.direction = DIR_UP;
            break;

          case CEIL.crushAndRaise:
            c.speed = CEILSPEED; // undo any crushed slowdown
            c.direction = DIR_UP;
            break;

          case CEIL.fastCrushAndRaise:
            c.direction = DIR_UP; // speed STAYS 2× (pin: not in the reset)
            break;

          case CEIL.lowerAndCrush:
          case CEIL.lowerToFloor:
            pRemoveActiveCeiling(s, c);
            break;

          default:
            break;
        }
      } else if (res === 'crushed') {
        // Crush-slow arm (p_ceilng.c:146-157): silent/crushAndRaise/
        // lowerAndCrush drop to CEILSPEED/8. fastCrushAndRaise is NOT
        // listed (fast crushers never slow down — pin).
        switch (c.type) {
          case CEIL.silentCrushAndRaise:
          case CEIL.crushAndRaise:
          case CEIL.lowerAndCrush:
            c.speed = (CEILSPEED / 8) | 0;
            break;

          default:
            break;
        }
      }
      break;
    }
  }
  syncCeilingHash(c);
}

/* ------------------------------------------------------------------ */
/* EV_DoCeiling (p_ceilng.c:173-249)                                   */
/* ------------------------------------------------------------------ */

/**
 * `EV_DoCeiling(line, ceiling_e)` — vanilla returns rtn=1 per spawned
 * sector; a pure stasis revival returns false (pin, same family as the
 * plats pin). The `ceiling->crush = false` init runs BEFORE the type
 * switch — which is why lowerAndCrush carries crush=false (file header
 * quirk pin).
 */
export function evDoCeiling(s: SpecWorld, line: number, type: number): boolean {
  const ctx = planeContext(s);
  const tag = s.map.lines.tag[line]!;

  // Reactivate in-stasis ceilings… for certain types (fallthrough into
  // `default: break` — only the three crusher types revive, p_ceilng.c
  // :186-195).
  if (
    type === CEIL.fastCrushAndRaise ||
    type === CEIL.silentCrushAndRaise ||
    type === CEIL.crushAndRaise
  ) {
    pActivateInStasisCeiling(s, tag);
  }

  let rtn = 0;
  let secnum = -1;
  while ((secnum = pFindSectorFromLineTag(s, line, secnum)) >= 0) {
    if (sectorSpecialData(s.sectors, secnum) !== null) continue;

    // new ceiling thinker
    rtn = 1;
    const fn: ThinkerFn = (self) => tMoveCeiling(s, ctx, self as Ceiling);
    const thinker = pAddThinker(s.thinkers, fn);
    const c = Object.assign(thinker, {
      sector: secnum,
      bottomheight: 0,
      topheight: 0,
      speed: 0,
      crush: false, // vanilla init BEFORE the switch (the 44/72 quirk)
      direction: 0,
      tag,
      olddirection: 0,
      type,
      revive: fn
    } as CeilingState) as Ceiling;
    setSectorSpecialData(s.sectors, secnum, thinker);

    const floorZ = s.sectors.floorZ[secnum]!;
    switch (type) {
      case CEIL.fastCrushAndRaise:
        c.crush = true;
        c.topheight = s.sectors.ceilingZ[secnum]!;
        c.bottomheight = (floorZ + 8 * FRACUNIT) | 0;
        c.direction = DIR_DOWN;
        c.speed = (CEILSPEED * 2) | 0;
        break;

      // silent/crushAndRaise set crush+top then FALL THROUGH to the shared
      // bottom/speed label (expressed explicitly — file header pin).
      case CEIL.silentCrushAndRaise:
      case CEIL.crushAndRaise:
        c.crush = true;
        c.topheight = s.sectors.ceilingZ[secnum]!;
        c.bottomheight = (floorZ + 8 * FRACUNIT) | 0;
        c.direction = DIR_DOWN;
        c.speed = CEILSPEED;
        break;

      // lowerAndCrush: crush STAYS false (quirk pin — never damages).
      case CEIL.lowerAndCrush:
        c.bottomheight = (floorZ + 8 * FRACUNIT) | 0;
        c.direction = DIR_DOWN;
        c.speed = CEILSPEED;
        break;

      case CEIL.lowerToFloor:
        c.bottomheight = floorZ; // NO +8 (the `type != lowerToFloor` guard)
        c.direction = DIR_DOWN;
        c.speed = CEILSPEED;
        break;

      case CEIL.raiseToHighest:
        c.topheight = pFindHighestCeilingSurrounding(s, secnum);
        c.direction = DIR_UP;
        c.speed = CEILSPEED;
        break;
    }

    c.tag = secTagOf(s, secnum);
    syncCeilingHash(c);
    pAddActiveCeiling(s, c);
  }
  return rtn !== 0;
}

/** `ceiling->tag = sec->tag` — the SECTOR's tag (not the line's; the
 * stasis scan matches tags through it). */
function secTagOf(s: SpecWorld, secnum: number): number {
  return s.sectors.tag[secnum]!;
}

/* ------------------------------------------------------------------ */
/* P_AddActiveCeiling / P_RemoveActiveCeiling (p_ceilng.c:254-290)     */
/* ------------------------------------------------------------------ */

/** `P_AddActiveCeiling(c)` — first empty slot; overflow counted (vanilla
 * I_Error). */
export function pAddActiveCeiling(_s: SpecWorld, ceiling: Ceiling): void {
  for (let i = 0; i < MAXCEILINGS; i++) {
    if (activeCeilings[i] === null) {
      activeCeilings[i] = ceiling;
      return;
    }
  }
  pceilngCounts.addOverflow++; // I_Error("P_AddActiveCeiling: no more ceilings!")
}

/** `P_RemoveActiveCeiling(c)` — clears the sector's specialdata, removes
 * the thinker (lazy sentinel) and frees the slot. */
export function pRemoveActiveCeiling(s: SpecWorld, ceiling: Ceiling): void {
  for (let i = 0; i < MAXCEILINGS; i++) {
    if (ceiling === activeCeilings[i]) {
      setSectorSpecialData(s.sectors, ceiling.sector, null);
      pRemoveThinker(ceiling as Thinker);
      activeCeilings[i] = null;
      return;
    }
  }
  pceilngCounts.removeNotFound++; // I_Error(…: can't find ceiling!)
}

/* ------------------------------------------------------------------ */
/* Stasis: P_ActivateInStasisCeiling / EV_CeilingCrushStop             */
/*            (p_ceilng.c:295-335)                                     */
/* ------------------------------------------------------------------ */

/** `P_ActivateInStasisCeiling(line)` — revive same-tag parked ceilings. */
export function pActivateInStasisCeiling(_s: SpecWorld, tag: number): void {
  for (let i = 0; i < MAXCEILINGS; i++) {
    const c = activeCeilings[i] as Ceiling | null;
    if (c !== null && c.tag === tag && c.direction === 0) {
      c.direction = c.olddirection;
      c.fn = c.revive;
      syncCeilingHash(c);
    }
  }
}

/** `EV_CeilingCrushStop(line)` — specials 57 (W1) / 74 (GR). Returns the
 * vanilla rtn (any mover stopped); the dispatchers ignore it (no use-side
 * gate for these ids). */
export function evCeilingCrushStop(s: SpecWorld, line: number): boolean {
  const tag = s.map.lines.tag[line]!;
  let rtn = 0;
  for (let i = 0; i < MAXCEILINGS; i++) {
    const c = activeCeilings[i] as Ceiling | null;
    if (c !== null && c.tag === tag && c.direction !== 0) {
      c.olddirection = c.direction;
      c.fn = null; // linked but never ticked (ptick stasis idiom)
      c.direction = 0; // in-stasis
      syncCeilingHash(c);
      rtn = 1;
    }
  }
  return rtn !== 0;
}
