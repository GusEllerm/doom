// sim/pmap — p_map.c part 1 (M5-02): P_CheckPosition + thinglinks scan.
//
// Faithful port of linuxdoom-1.10 p_map.c movement-clipping queries:
//   P_CheckPosition (p_map.c:374-450) with the EXACT 1.10 order —
//     seed from the subsector sector, noclip-return AFTER the seed, things
//     FIRST over the MAXRADIUS-extended box, lines unextended;
//   PIT_CheckLine  (p_map.c:189-249) — bbox reject, P_BoxOnLineSide,
//     one-sided block, ML_BLOCKING / ML_BLOCKMONSTERS (missiles pass),
//     P_LineOpening narrowing of tmceilingz/tmfloorz/tmdropoffz, unsorted
//     spechit[];
//   PIT_CheckThing (p_map.c:252-345) — radius+radius box distance test,
//     self-skip, and the MF_SOLID block. The MF_SKULLFLY / MF_MISSILE /
//     MF_SPECIAL(+MF_PICKUP→P_TouchSpecialThing) branches cannot have real
//     actors before M7/M8: they are CALL SLOTS ({@link pmapHooks}) that are
//     no-op-safe by design (counter + vanilla return-shape), so the branch
//     structure here is complete and later milestones only register hooks.
//
// Module-static tm-state (tmbbox/tmthing/tmx/tmy/floatok/tmfloorz/
// tmceilingz/tmdropoffz/ceilingline/spechit[8]/numspechit) mirrors the
// p_map.c globals verbatim; the PIT_* functions are module-level visitors
// reading that state exactly like the C callbacks — zero allocation and no
// closures per query (pmap.test.ts pins it).
//
// Thing blocks truth (see thinglinks.ts header): vanilla `blocklinks` are
// built at spawn by P_SetThingPosition (p_maputl.c), never by a dedicated
// init; here static THINGS are CSR-linked at map load and movers use the
// vanilla-shaped chains.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { MAXRADIUS } from './map';
import { blockIndexOf, blockLinesBoxIterator } from './blockmap';
import type { RuntimeMap } from './map';
import type { BlockMap } from './blockmap';
import { sectorAtPoint } from './bsp';
import { bumpValidcount, pBoxOnLineSide, pLineOpening } from './pmaputl';
import {
  MF_MISSILE,
  MF_NOCLIP,
  MF_PICKUP,
  MF_SHOOTABLE,
  MF_SKULLFLY,
  MF_SOLID,
  MF_SPECIAL,
  thingLinksIterator,
  type ThingLinks,
} from './thinglinks';

/** p_map.c:69 `#define MAXSPECIALCROSS 8`. */
export const MAXSPECIALCROSS = 8;

/** doomdata.h:101/104 linedef option bits used by PIT_CheckLine. */
export const ML_BLOCKING = 1;
export const ML_BLOCKMONSTERS = 2;

/* ------------------------------------------------------------------ */
/* Mover + world views (the mobj_t / globals the C entry points read)   */
/* ------------------------------------------------------------------ */

/**
 * mobj_t slice P_CheckPosition touches. The player's `MobjStub` (M5-06
 * wires it) plus radius/height from mobjinfo[MT_PLAYER] (info.c:1125-1130:
 * r 16, h 56, MF_DROPOFF|MF_PICKUP on players).
 */
export interface Mover {
  /** fixed */
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  /** MF_* bits (p_mobj.h). */
  flags: number;
  /** vanilla `mobj_t.player != NULL` — disables the ML_BLOCKMONSTERS test. */
  player?: boolean;
  /** ThingLinks slot standing for this mover (PIT_CheckThing's pointer
   * self-skip `thing == tmthing`); −1/undefined = not in the grid. */
  linkSlot?: number;
}

/** Everything the clipping queries read (built once per level). */
export interface PMapWorld {
  readonly map: RuntimeMap;
  readonly bm: BlockMap;
  readonly links: ThingLinks;
}

/* ------------------------------------------------------------------ */
/* Typed callback slots — the M6/M7/M8 territory (documented no-ops)    */
/* ------------------------------------------------------------------ */

/**
 * p_map.c call sites whose real bodies do not exist before M7 (items) /
 * M8 (monsters, missiles): P_TouchSpecialThing, the skull-smash damage +
 * state reset, and the missile hit (P_DamageMobj + explode). Registering a
 * hook REPLACES the vanilla return-shape fallback; while unregistered the
 * port performs the vanilla control flow minus the side effect
 * (thing not removed/damaged) and bumps the matching counter, so
 * behavior is deterministic and the gap is measurable, never silent.
 */
export interface PMapHooks {
  /** p_map.c:332 P_TouchSpecialThing(thing, tmthing) — items arrive M7. */
  touchSpecialThing?: (slot: number, toucher: Mover) => void;
  /** p_map.c:277-286 skull smash: damage + momentum reset, M8. */
  skullFlyHit?: (slot: number, attacker: Mover) => void;
  /** p_map.c:325-329 missile hit damage/explode, M7/M8. */
  missileHit?: (slot: number, source: Mover) => void;
}

export const pmapHooks: PMapHooks = {};

/** Counts for every hook (absent or present) + the spechit overflow note. */
export const pmapHookCounts = {
  touchSpecialThing: 0,
  skullFlyHit: 0,
  missileHit: 0,
  /** writes past spechit[0..7] (vanilla: silent memory corruption — here:
   * the extra lines simply are not stored, numspechit still counts them). */
  spechitOverflow: 0,
};

export function resetPmapHookCounts(): void {
  pmapHookCounts.touchSpecialThing = 0;
  pmapHookCounts.skullFlyHit = 0;
  pmapHookCounts.missileHit = 0;
  pmapHookCounts.spechitOverflow = 0;
}

/* ------------------------------------------------------------------ */
/* tm globals (p_map.c:47-71)                                           */
/* ------------------------------------------------------------------ */

/**
 * The p_map.c module globals as one mutable singleton. `bbox` is a
 * {@link FixedBBox}-shaped scratch (pBoxOnLineSide's argument order)
 * standing for `tmbbox[4]` — BOXTOP=0… mapping is by field name.
 * Values are only meaningful between a pCheckPosition call and the next
 * one (vanilla semantics; P_TryMove reads them in M5-03).
 */
export const tm = {
  /** tmbbox: left/right/top/bottom (fixed) */
  bbox: { left: 0, right: 0, top: 0, bottom: 0 },
  /** tmthing (null before the first query) */
  thing: null as Mover | null,
  /** tmflags */
  flags: 0,
  /** tmx/tmy (fixed) */
  x: 0,
  y: 0,
  /** "move would be ok if within tmfloorz - tmceilingz" (set by M5-03). */
  floatok: false,
  tmfloorz: 0,
  tmceilingz: 0,
  tmdropoffz: 0,
  /** ceilingline: line index that last lowered tmceilingz, −1 = NULL */
  ceilingline: -1,
  /** spechit[MAXSPECIALCROSS] (line indices) */
  spechit: new Int32Array(MAXSPECIALCROSS),
  /** numspechit — may exceed the slot count; slots past 7 hold stale data
   * (vanilla reads garbage; we count via pmapHookCounts.spechitOverflow). */
  numspechit: 0,
};

/** active world for the PIT visitors (vanilla's implicit `level` globals). */
let world: PMapWorld | null = null;

/** validcount threading: same counter domain as p_maputl (M5-01 note). */
const scan: { valid: Int32Array; stamp: number } = { valid: new Int32Array(0), stamp: 0 };

/** C `abs()` on int32 (wraps at MININT — same reading as pmaputl). */
function abs32(v: number): number {
  return v === -0x80000000 ? v : v < 0 ? -v : v;
}

/* ------------------------------------------------------------------ */
/* PIT_CheckLine — p_map.c:185-249                                      */
/* ------------------------------------------------------------------ */

/**
 * `PIT_CheckLine(ld)` verbatim (argument = linedef index). Reads tm.*,
 * narrows tmceilingz/tmfloorz/tmdropoffz, records special lines unsorted.
 * Returns false = STOP the scan (wall). No dropoff/ML_TWOSIDED-opening
 * logic lives in this function in 1.10 — the "blockmap dropoff" test is
 * P_TryMove's `tmfloorz − tmdropoffz` (M5-03), and there is no
 * special-line-66/69 case (M5-plan §0.4).
 */
export function pitCheckLine(line: number): boolean {
  const w = world!;
  const L = w.map.lines;

  // bbox reject first (p_map.c:193-197)
  if (
    tm.bbox.right <= L.bboxLeft[line]! ||
    tm.bbox.left >= L.bboxRight[line]! ||
    tm.bbox.top <= L.bboxBottom[line]! ||
    tm.bbox.bottom >= L.bboxTop[line]!
  ) {
    return true;
  }
  if (pBoxOnLineSide(w.map, tm.bbox, line) !== -1) return true;

  // A line has been hit. One-sided ⇒ solid (p_map.c:215-216).
  if (L.sectorBack[line] === -1) return false;

  if (!(tm.flags & MF_MISSILE)) {
    if (L.flags[line]! & ML_BLOCKING) return false; // explicitly blocking everything
    if (!tm.thing?.player && L.flags[line]! & ML_BLOCKMONSTERS) return false; // monsters only
  }

  // set openrange, opentop, openbottom; adjust floor/ceiling heights
  // (p_map.c:230-241 — min/max narrowing, ceilingline tracked for the
  // sky-hack missile rule, unused until M7 missiles)
  const op = pLineOpening(w.map, line);
  if (op.opentop < tm.tmceilingz) {
    tm.tmceilingz = op.opentop;
    tm.ceilingline = line;
  }
  if (op.openbottom > tm.tmfloorz) tm.tmfloorz = op.openbottom;
  if (op.lowfloor < tm.tmdropoffz) tm.tmdropoffz = op.lowfloor;

  // keep track of special lines, NOT sorted by order (p_map.c:243-247)
  if (L.special[line]!) {
    if (tm.numspechit < MAXSPECIALCROSS) tm.spechit[tm.numspechit] = line;
    else pmapHookCounts.spechitOverflow++;
    tm.numspechit++;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* PIT_CheckThing — p_map.c:252-345                                     */
/* ------------------------------------------------------------------ */

/**
 * `PIT_CheckThing(thing)` — argument = ThingLinks slot. M5-02 blocking is
 * `!(flags & MF_SOLID)`; the missile/skull/pickup branches route through
 * {@link pmapHooks} (documented no-op-safe deviations above). The
 * same-species missile rule (MT_KNIGHT↔MT_BRUISER equivalence) needs the
 * M7 mobjtype roster — slots carry no type yet beyond spawn doomednum, so
 * that sub-branch is deferred with the missile damage hook (never
 * reachable in M5: no MF_MISSILE movers exist).
 */
export function pitCheckThing(slot: number): boolean {
  const w = world!;
  const thing = tm.thing!;
  const flags = w.links.flags[slot]!;

  // inert decor skips the whole test (p_map.c:259-260)
  if (!(flags & (MF_SOLID | MF_SPECIAL | MF_SHOOTABLE))) return true;

  const blockdist = (w.links.radius[slot]! + thing.radius) | 0;
  if (abs32(w.links.x[slot]! - tm.x) >= blockdist || abs32(w.links.y[slot]! - tm.y) >= blockdist) {
    return true; // didn't hit it
  }

  // don't clip against self (vanilla pointer identity = slot identity)
  if (slot === (thing.linkSlot ?? -1)) return true;

  if (tm.flags & MF_SKULLFLY) {
    // p_map.c:276-288: damage, clear flag, zero momentum, respawn state —
    // all actors+damage are M8; the STOP semantics (false) are faithful.
    pmapHookCounts.skullFlyHit++;
    pmapHooks.skullFlyHit?.(slot, thing);
    return false;
  }

  if (tm.flags & MF_MISSILE) {
    // over / under (p_map.c:295-298) — faithful with z/height on both sides
    if (thing.z > ((w.links.z[slot]! + w.links.height[slot]!) | 0)) return true; // overhead
    if (((thing.z + thing.height) | 0) < w.links.z[slot]!) return true; // underneath
    if (!(flags & MF_SHOOTABLE)) return !(flags & MF_SOLID); // no damage done
    pmapHookCounts.missileHit++;
    pmapHooks.missileHit?.(slot, thing);
    return false; // don't traverse any more
  }

  if (flags & MF_SPECIAL) {
    // p_map.c:331-338: P_TouchSpecialThing may DELETE the item — until the
    // M7 item roster the no-op fallback leaves it in place, so the
    // observable difference is only "pickup did not happen" (countered).
    pmapHookCounts.touchSpecialThing++;
    if (tm.flags & MF_PICKUP) pmapHooks.touchSpecialThing?.(slot, thing);
    return !(flags & MF_SOLID);
  }

  return !(flags & MF_SOLID);
}

/* ------------------------------------------------------------------ */
/* P_CheckPosition — p_map.c:351-450                                    */
/* ------------------------------------------------------------------ */

/**
 * `P_CheckPosition(thing, x, y)` verbatim, including the exact 1.10 order:
 *  1. tmthing/tmflags/tmx/tmy + radius box `tmbbox`;
 *  2. seed tmfloorz = tmdropoffz = sector.floorheight and
 *     tmceilingz = sector.ceilingheight from R_PointInSubsector
 *     (= {@link sectorAtPoint});
 *  3. `validcount++` (shared pmaputl counter) and numspechit = 0;
 *  4. MF_NOCLIP ⇒ return true AFTER the seed — noclip keeps tracking
 *     floor/ceiling (matters for z, M5-plan §0.4);
 *  5. THINGS FIRST over the box extended by MAXRADIUS (blocklinks are
 *     origin-point grouped — thinglinks.ts), then LINES unextended, both
 *     with x OUTER / y INNER loops over the block range.
 * Out-params live in {@link tm}. Allocation-free in steady state.
 */
export function pCheckPosition(world_: PMapWorld, thing: Mover, x: number, y: number): boolean {
  world = world_;
  tm.thing = thing;
  tm.flags = thing.flags;
  tm.x = x;
  tm.y = y;

  const r = thing.radius;
  tm.bbox.top = (y + r) | 0;
  tm.bbox.bottom = (y - r) | 0;
  tm.bbox.right = (x + r) | 0;
  tm.bbox.left = (x - r) | 0;

  const sector = sectorAtPoint(world_.map, x, y);
  tm.ceilingline = -1; // ceilingline = NULL (sky-hack tracker)

  const S = world_.map.sectors;
  tm.tmfloorz = S.floorHeight[sector]!;
  tm.tmdropoffz = tm.tmfloorz;
  tm.tmceilingz = S.ceilingHeight[sector]!;

  scan.valid = world_.map.lines.valid;
  scan.stamp = bumpValidcount(); // validcount++
  tm.numspechit = 0;

  if (tm.flags & MF_NOCLIP) return true;

  // Check things first, possibly picking things up. The bounding box is
  // extended by MAXRADIUS because mobj_ts are grouped into mapblocks
  // based on their ORIGIN point (p_map.c:420-429).
  const links = world_.links;
  const orgX = links.bm.originX;
  const orgY = links.bm.originY;
  const txl = blockIndexOf((tm.bbox.left - orgX - MAXRADIUS) | 0);
  const txh = blockIndexOf((tm.bbox.right - orgX + MAXRADIUS) | 0);
  const tyl = blockIndexOf((tm.bbox.bottom - orgY - MAXRADIUS) | 0);
  const tyh = blockIndexOf((tm.bbox.top - orgY + MAXRADIUS) | 0);
  for (let bx = txl; bx <= txh; bx++) {
    for (let by = tyl; by <= tyh; by++) {
      if (!thingLinksIterator(links, bx, by, pitCheckThing)) return false;
    }
  }

  // check lines, unextended box (p_map.c:434-443; blockLinesBoxIterator
  // is the same x-outer/y-inner ordering, validcount-deduped).
  if (
    !blockLinesBoxIterator(
      world_.bm,
      blockIndexOf((tm.bbox.left - orgX) | 0),
      blockIndexOf((tm.bbox.right - orgX) | 0),
      blockIndexOf((tm.bbox.bottom - orgY) | 0),
      blockIndexOf((tm.bbox.top - orgY) | 0),
      pitCheckLine,
      scan,
    )
  ) {
    return false;
  }

  return true;
}
