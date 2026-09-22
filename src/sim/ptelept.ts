// sim/ptelept.ts — teleporters (p_telept.c). M6-10: REAL body replacing the
// M6-03 stub, signature unchanged (pspec.ts registry dispatch + tests are
// the only call sites). Parent: M6-plan §M6-10.
//
// ---------------------------------------------------------------------------
// SOURCE TRUTH (verified line-by-line against linuxdoom-1.10/p_telept.c —
// the whole file is one function, EV_Teleport; there is NO P_SpawnTeleportFog,
// NO P_FindTeleportSpot and NO destination-list global in 1.10)
// ---------------------------------------------------------------------------
//  • Gates, in this exact order: (1) `thing->flags & MF_MISSILE → return 0`
//    comes BEFORE (2) `side == 1 → return 0` ("Don't teleport if hit back of
//    line, so you can get out of teleporter"). Both are silent: no fog, no
//    sound, no move, no clear. The CROSSING side is passed straight through
//    by P_CrossSpecialLine (p_spec.c:660 `EV_Teleport(line, side, thing)`),
//    so the gate lives HERE, not in the dispatcher.
//  • Destination search (the loop that 1.10 writes inline — no helper):
//      outer: `for (i = 0; i < numsectors; i++) if (sectors[i].tag == tag)`
//      inner: `for (thinker = thinkercap.next; ...)` — the WHOLE active
//             thinker list per matching sector, keeping
//             `thinker->function == P_MobjThinker` && `m->type ==
//             MT_TELEPORTMAN` (doomednum 14) && `m->subsector->sector -
//             sectors == i`.
//    ⇒ SECTOR INDEX ASCENDS FIRST, spawn order (== thinker insertion order
//    for level-start mobjs, P_AddThinker appends at the tail) SECOND: the
//    pick is the first teleportman in the LOWEST-indexed tagged sector that
//    contains any. No `P_FindTeleportSpot`, no random choice, no
//    `sector->thinglist` walk — those are later-source designs.
//  • *** THERE IS NO CANDIDATE-RETRY LOOP ***: `if (!P_TeleportMove (thing,
//    m->x, m->y)) return 0;` — the FIRST candidate blocks the teleport and
//    EV_Teleport fails outright; later destinations (same or later sector)
//    are never examined. (Later sources loop; 1.10 returns.)
//  • The move is `P_TeleportMove` (p_map.c:82, LIVE since M5-04), which
//    never checks walls (no line scan), never checks headroom/fit, and
//    KILLS what stands there via PIT_StompThing →
//    `P_DamageMobj(thing, tmthing, tmthing, 10000)` for MF_SHOOTABLE
//    victims. Non-player stumpers FAIL the move instead (`return false`,
//    "monsters don't stomp things except on boss level"). EV_Teleport
//    touches NO mobj flags: MF_TELEPORT is never set here (it belongs to
//    P_SpecialThing/missile teleports in p_mobj.c, not to this path).
//  • z: `thing->z = thing->floorz;` (the floor P_TeleportMove just wrote —
//    the destination sector's FLOOR, live SoA in this port), then for
//    players `player->viewz = z + viewheight`.
//  • Fog: TWO MT_TFOG mobjs — source at the thing's OLD (x,y,z), and
//    destination at `m->x + 20*finecosine[m->angle>>ANGLETOFINESHIFT]`,
//    `m->y + 20*finesine[...]`, `thing->z` — i.e. the fog stands 20 units
//    IN FRONT of the teleportman along ITS OWN angle. Each is followed by
//    `S_StartSound(fog, sfx_telept)` (emitted at the fog's position).
//  • `if (thing->player) thing->reactiontime = 18;` (reactiontime lives on
//    the MOBJ, not player_t) — then UNCONDITIONALLY `thing->angle =
//    m->angle;` and `thing->momx = thing->momy = thing->momz = 0;` ⇒ the
//    destination teleportman's angle REPLACES the mover's angle FOR PLAYERS
//    TOO (there is no angle preservation and no P_TurnTowards/AngleChange
//    call in 1.10), and `return 1`.
//  • Line specials reaching this function are CROSS-side only — 1.10 has NO
//    use-side teleport case (p_switch.c has none): 39 W1 (clears), 97 GR,
//    125 W1 monster-only (clear inside the !player branch), 126 GR
//    monster-only. The monsterOk ok-list and the monsterOnly branch are
//    pspec.ts registry data (already correct in M6-03); the 1.10
//    `if (!thing->player)` test for 125/126 is data-driven there.
//  • The teleportman's own spawn is skill-gated like every mapthing
//    (p_mobj.c P_SpawnMapThing: `if (!(mthing->options & bit)) return;`), so
//    a destination painted for another skill DOES NOT EXIST as a candidate.
//
// DEVIATIONS (logged; M6-plan §4 D013(c)/(d)):
//  • Destinations are a per-level LIST of doomednum-14 THINGS ({x,y,angle,
//    sector} in THINGS order), not MT_TELEPORTMAN mobjs in the thinker
//    chain (there is no mobj roster pre-M7). Spawn-order equivalence is
//    exact: P_SetupLevel spawns THINGS in order and P_AddThinker appends, so
//    "thinker chain" == "THINGS order" for these mobjs — and the loop shape
//    stays vanilla (sector index outer, list order inner). {@link
//    scanTeleportDest} keeps the verbatim nested scan for the equivalence
//    test against the precomputed per-sector pick.
//  • MT_TFOG visuals arrive with the M7 mobj roster: the two fogs are
//    counted {@link teleportFog} SLOT EVENTS instead (positions exactly as
//    vanilla computes them, incl. the 20-unit dest offset). The
//    S_StartSound half IS the real M6-01 sfxSlot (sfx_telept = 35, emitted
//    at each fog's position, twice per successful teleport).
//  • Telefrag = the p_telept-owned damage-slot call: ptelept self-registers
//    on `pmapHooks.telefrag` (M5-04's documented slot, chain-preserving) and
//    logs `P_DamageMobj(victim, mover, mover, 10000)` THROUGH THE ARMED
//    window of its own P_TeleportMove call only — other P_TeleportMove
//    callers keep M5's no-op default. Victim/source ids are ThingLinks slots
//    (same namespace as pmap.ts's crush damage events; M7 unifies them).
//  • `player->viewz` needs the player_t slice: movers that carry
//    `playerRef` (or live in `state.players`) get it; a bare `Mover`
//    literal with `player: true` has no player_t, so only the reactiontime
//    half of the `if (thing->player)` arms applies (counted, not silent).
//  • The `!netgame && (options & 16)` multiplayer-only-thing skip is not
//    modelled (no netgame in this port) — same omission as
//    thinglinks.ts's spawn filter.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG45 } from '../core/constants';
import { angToFine } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';

import { sectorAtPoint } from './bsp';
import { mapThingAt } from './map';
import { damageSlot, sfxSlot } from './hooks';
import { pTeleportMove, pmapHooks, type Mover } from './pmap';
import { MF_MISSILE } from './thinglinks';

import type { RuntimeMap } from './map';
import type { HookSlots } from './hooks';
import type { PMapWorld } from './pmap';
import type { LiveSectors } from './state';
import type { SpecWorld } from './pspec-helpers';

/* ------------------------------------------------------------------ */
/* p_telept.c / info.c / sounds.h constants                            */
/* ------------------------------------------------------------------ */

/** info.c mobjinfo MT_TELEPORTMAN doomednum (p_spec.h MO_TELEPORTMAN 14). */
export const MT_TELEPORTMAN_DOOMEDNUM = 14;

/** p_telept.c `thing->reactiontime = 18;` */
export const TELEPORT_REACTIONTIME = 18;

/** p_telept.c `m->x+20*finecosine[an]` — 20 map units along the dest angle. */
export const FOG_OFFSET = 20;

/** sounds.h sfxenum_t `sfx_telept` (index counting from sfx_None = 0, the
 * convention pinned by pspec.ts SFX_SWTCHN = 23). */
export const SFX_TELEPT = 35;

/** Memory guard for the fog event log (test instrument, not gameplay). */
export const TELEPORT_LOG_CAP = 4096;

/* ------------------------------------------------------------------ */
/* Call counters + the fog slot (documented deviation)                  */
/* ------------------------------------------------------------------ */

export const teleportCounts = {
  /** EV_Teleport entries (every call, incl. rejected ones). */
  evTeleport: 0,
  /** successful teleports (the `return 1` path). */
  teleported: 0,
  /** dispatcher handed no thing (cross/use always have one in 1.10). */
  noThing: 0,
  /** MF_MISSILE gate (`return 0` first). */
  missileRejected: 0,
  /** `side == 1` gate (`return 0` second). */
  backSideRejected: 0,
  /** P_TeleportMove refused (occupied dest for a non-stomper, or a
   * MAPERROR-class failure) — vanilla `return 0`, no retry. */
  blocked: 0,
  /** no teleportman anywhere in a tagged sector. */
  noDestination: 0,
  /** PIT_StompThing telefrags attributed to a teleport in progress. */
  telefrag: 0,
  /** the telefrag hook fired while no teleport was armed (other
   * P_TeleportMove callers — never the damage slot, but counted). */
  telefragUnarmed: 0,
  /** `thing->player` true but no player_t slice reachable (viewz skipped). */
  playerSliceMissing: 0
};

export function resetTeleportCounts(): void {
  for (const k of Object.keys(teleportCounts)) {
    teleportCounts[k as keyof typeof teleportCounts] = 0;
  }
  teleportFog.count = 0;
  teleportFog.entries.length = 0;
}

/** One MT_TFOG spawn (M7 replaces the event with the mobj; positions are
 * already the vanilla ones). */
export interface TeleportFogEvent {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  /** 'source' = the thing's old position, 'dest' = 20 units in front of the
   * teleportman at the mover's new z. */
  readonly at: 'source' | 'dest';
  readonly tic: number;
}

export const teleportFog = {
  count: 0,
  entries: [] as TeleportFogEvent[]
};

function spawnFog(
  s: SpecWorld, x: number, y: number, z: number, at: 'source' | 'dest'
): void {
  teleportFog.count++;
  if (teleportFog.entries.length < TELEPORT_LOG_CAP) {
    teleportFog.entries.push({ x, y, z, at, tic: s.leveltime });
  }
  // S_StartSound (fog, sfx_telept) — the sound belongs to the FOG mobj, so
  // it emits at the fog position (both source and destination fogs sound).
  sfxSlot(s.hooks, SFX_TELEPT, x, y, z, s.leveltime);
}

/* ------------------------------------------------------------------ */
/* Teleport-destination list (deviation: THINGS-derived, not thinkers)  */
/* ------------------------------------------------------------------ */

/** One MT_TELEPORTMAN spawn: fixed coords, BAM angle (P_SpawnMapThing's
 * `ANG45 * (angle/45)` truncation), the subsector's sector, and the THINGS
 * record index (= spawn/thinker order rank). */
export interface TeleportDest {
  readonly x: number;
  readonly y: number;
  /** angle_t (BAM, u32) */
  readonly angle: number;
  readonly sector: number;
  readonly thingIndex: number;
}

export interface TeleportDestinations {
  /** spawn (THINGS) order — the thinker-chain stand-in. */
  readonly dests: readonly TeleportDest[];
  /** sector → FIRST dest of that sector in spawn order, −1 = none. Exactly
   * equivalent to the verbatim inner scan (see {@link scanTeleportDest}). */
  readonly firstInSector: Int32Array;
  /** doomednum-14 records skipped by the skill gate (diagnostic). */
  readonly skippedSkill: number;
}

/** A mover as EV_Teleport sees it: the Mover slice plus the mobj_t fields
 * p_telept.c writes (angle/momentum/reactiontime) and the player_t half
 * reachable through `playerRef` (or `state.players[]`). */
export interface TeleportMover extends Mover {
  /** angle_t (BAM, u32). */
  angle?: number;
  momx?: number;
  momy?: number;
  momz?: number;
  /** mobj_t reactiontime (p_mobj.h), NOT player_t. */
  reactiontime?: number;
  playerRef?: { viewz?: number; viewheight?: number };
}

interface TeleportHost {
  readonly pmap?: PMapWorld;
  readonly sectors?: LiveSectors;
  readonly skill?: number;
  readonly players?: readonly {
    readonly mo: TeleportMover;
    viewz?: number;
    viewheight?: number;
  }[];
}

const destCache = new WeakMap<SpecWorld, TeleportDestinations>();
const worldCache = new WeakMap<SpecWorld, PMapWorld>();

/** p_mobj.c:737-748 spawn-skill bit (same mapping as thinglinks.ts):
 * sk_baby(0)/sk_easy(1) → 1, sk_medium(2) → 2, sk_hard(3) → 1<<2 = 4,
 * sk_nightmare(4) → 4 (p_mobj.c:743 `else if (gameskill == sk_nightmare)
 * bit = 4;`). The previous `skill === 1 ? 1 : … : 1 << (skill - 1)` made
 * skill 0 compute `1 << -1` — JS masks the shift count mod 32 (→ 1<<31,
 * negative), so the AND never matched and EVERY destination was filtered
 * out at Come get some! (B-10 filter-family audit). */
function skillBit(skill: number): number {
  return skill === 0 || skill === 1 ? 1 : skill >= 4 ? 4 : 1 << (skill - 1);
}

/**
 * The MT_TELEPORTMAN roster for a level: doomednum-14 THINGS in THINGS
 * order, skill-filtered exactly like P_SpawnMapThing. Built once per world
 * (lazy on first teleport — contents and order are the same list a
 * P_SetupLevel-side spawn pass would produce, deviation logged above).
 */
export function buildTeleportDests(
  map: RuntimeMap, skill: number
): TeleportDestinations {
  const bit = skillBit(skill);
  const dests: TeleportDest[] = [];
  let skippedSkill = 0;
  for (let i = 0; i < map.numThings; i++) {
    const t = mapThingAt(map, i);
    if (t.type !== MT_TELEPORTMAN_DOOMEDNUM) continue;
    if (!(t.flags & bit)) {
      skippedSkill++; // p_mobj.c:744 — the mobj never exists for this skill
      continue;
    }
    const x = (t.x << 16) | 0;
    const y = (t.y << 16) | 0;
    dests.push({
      x,
      y,
      // P_SpawnMapThing: `mobj->angle = ANG45 * (mthing->angle/45);` —
      // truncating division, so 30° → ANG0 and -90° → ANG270.
      angle: Math.imul(ANG45, Math.trunc(t.angle / 45)) >>> 0,
      sector: sectorAtPoint(map, x, y),
      thingIndex: i
    });
  }
  const firstInSector = new Int32Array(map.sectors.count).fill(-1);
  for (let k = 0; k < dests.length; k++) {
    const d = dests[k]!;
    if (d.sector >= 0 && d.sector < firstInSector.length && firstInSector[d.sector] === -1) {
      firstInSector[d.sector] = k;
    }
  }
  return Object.freeze({ dests: Object.freeze(dests), firstInSector, skippedSkill });
}

/** The destination list for a live world (cached per world object). */
export function teleportDestinations(s: SpecWorld): TeleportDestinations {
  let d = destCache.get(s);
  if (d === undefined) {
    d = buildTeleportDests(s.map, (s as unknown as TeleportHost).skill ?? 2);
    destCache.set(s, d);
  }
  return d;
}

/**
 * The clipping world for P_TeleportMove (cached per specials world). The
 * M6-04 live-height view is wired lazily and idempotently onto it, so the
 * floor P_TeleportMove writes is the CURRENT floor, not the load-time one
 * (same seam pplane.ts/pmap.ts use).
 */
function teleportWorld(s: SpecWorld): PMapWorld {
  let w = worldCache.get(s);
  if (w === undefined) {
    const host = s as unknown as TeleportHost;
    if (!host.pmap) {
      throw new Error('ptelept: specials world has no clipping world (pmap)');
    }
    w = host.pmap;
    if (w.sectors === undefined) w.sectors = s.sectors;
    worldCache.set(s, w);
  }
  return w;
}

/**
 * The VERBATIM EV_Teleport inner scan (p_telept.c's
 * `for (thinker = thinkercap.next; ...)` chain walk, sector-filtered).
 * Returns the candidate index or −1. Kept for the selection-equivalence
 * acceptance test against {@link TeleportDestinations.firstInSector}.
 */
export function scanTeleportDest(
  dests: readonly TeleportDest[], sector: number
): number {
  for (let k = 0; k < dests.length; k++) {
    // `thinker->function != P_MobjThinker → continue` has no analogue in the
    // list (every entry IS an mobj stand-in); type and sector filters stay.
    if (dests[k]!.sector !== sector) continue;
    return k;
  }
  return -1;
}

/* ------------------------------------------------------------------ */
/* Telefrag: the P_DamageMobj call site inside P_TeleportMove           */
/* ------------------------------------------------------------------ */

interface FragContext {
  readonly hooks: HookSlots;
  /** ThingLinks slot of the stumper (the teleporting mover) — the
   * P_DamageMobj `source` (== inflictor in vanilla), null when off-grid. */
  readonly source: number | null;
  readonly tic: number;
}

let fragContext: FragContext | null = null;
let hookInstalled = false;

/** p_map.c:108 `P_DamageMobj (thing, tmthing, tmthing, 10000)`. */
function onTelefrag(slot: number): void {
  if (fragContext === null) {
    teleportCounts.telefragUnarmed++;
    return;
  }
  teleportCounts.telefrag++;
  damageSlot(fragContext.hooks, slot, 10000, fragContext.source, fragContext.tic);
}

/** Chain-preserving, first-call-only registration on M5-04's telefrag slot
 * (deferred out of module init: pmap.ts ↔ pspec.ts ↔ ptelept.ts is a cycle,
 * so module bodies must not read each other's consts). */
function ensureTelefragHook(): void {
  if (hookInstalled) return;
  hookInstalled = true;
  const prior = pmapHooks.telefrag;
  pmapHooks.telefrag = (slot: number, stumper: Mover): void => {
    prior?.(slot, stumper);
    onTelefrag(slot);
  };
}

/* ------------------------------------------------------------------ */
/* EV_Teleport — p_telept.c, verbatim control flow                      */
/* ------------------------------------------------------------------ */

/** The player_t stand-in for a mover (`thing->player`'s target): the
 * `playerRef` pointer slice if the mover carries one, else the entry of
 * `state.players` whose mo IS this mover. */
function playerT(s: SpecWorld, m: TeleportMover):
  { viewz?: number; viewheight?: number } | null {
  if (m.playerRef) return m.playerRef;
  const host = s as unknown as TeleportHost;
  const players = host.players;
  if (!players) return null;
  for (const p of players) {
    if (p.mo === (m as unknown as TeleportMover)) return p;
  }
  return null;
}

/**
 * `EV_Teleport(line, side, thing)` — returns the C int as boolean (the
 * dispatcher ignores it; the registry's S1/SR switch gate never applies:
 * all four teleport ids are cross-side).
 */
export function evTeleport(
  s: SpecWorld, line: number, side: number, mover: Mover | null
): boolean {
  teleportCounts.evTeleport++;

  if (mover === null) {
    teleportCounts.noThing++;
    return false;
  }
  // don't teleport missiles — p_telept.c's FIRST test
  if ((mover.flags & MF_MISSILE) !== 0) {
    teleportCounts.missileRejected++;
    return false;
  }
  // Don't teleport if hit back of line, so you can get out of teleporter.
  if (side === 1) {
    teleportCounts.backSideRejected++;
    return false;
  }

  const thing = mover as TeleportMover;
  const tag = s.map.lines.tag[line] ?? 0;
  const { dests, firstInSector } = teleportDestinations(s);
  const world = teleportWorld(s);
  ensureTelefragHook();

  const oldx = thing.x;
  const oldy = thing.y;
  const oldz = thing.z;

  // outer: sectors in index order; inner: the thinker chain (== spawn order
  // here, deviation note in the header).
  for (let i = 0, n = s.sectors.count; i < n; i++) {
    if (s.sectors.tag[i] !== tag) continue;
    const k = firstInSector[i]!;
    if (k < 0) continue; // no teleportman in this sector — next tagged sector
    const m = dests[k]!;

    // one attempt only: vanilla `return 0` on failure, never a retry.
    const link = thing.linkSlot;
    fragContext = {
      hooks: s.hooks,
      source: link === undefined || link < 0 ? null : link,
      tic: s.leveltime
    };
    let moved: boolean;
    try {
      moved = pTeleportMove(world, thing, m.x, m.y);
    } finally {
      fragContext = null;
    }
    if (!moved) {
      teleportCounts.blocked++;
      return false;
    }

    thing.z = thing.floorz ?? thing.z; // fixme: not needed? (verbatim)
    const player = thing.player === true ? playerT(s, thing) : null;
    if (thing.player === true) {
      if (player) player.viewz = (thing.z + (player.viewheight ?? 0)) | 0;
      else teleportCounts.playerSliceMissing++;
    }

    // spawn teleport fog at source and destination
    spawnFog(s, oldx, oldy, oldz, 'source');
    const an = angToFine(m.angle);
    spawnFog(
      s,
      (m.x + Math.imul(FOG_OFFSET, finecosine[an]!)) | 0,
      (m.y + Math.imul(FOG_OFFSET, finesine[an]!)) | 0,
      thing.z,
      'dest'
    );

    // don't move for a bit (mobj reactiontime, players only)
    if (thing.player === true) thing.reactiontime = TELEPORT_REACTIONTIME;

    thing.angle = m.angle;
    thing.momx = 0;
    thing.momy = 0;
    thing.momz = 0;
    teleportCounts.teleported++;
    return true;
  }

  teleportCounts.noDestination++;
  return false;
}
