// sim/thinglinks — the thing blockmap ("blocklinks"): static per-block thing
// lists + dynamic mover chains. M5-02 support for p_map.c P_CheckPosition
// (plan M5-plan §M5-02, §M5-plan §0.5).
//
// CONSTRUCTION TRUTH (verified against linuxdoom-1.10 sources): there is NO
// `P_InitThingLinks` / `P_LoadThingLinks`. The `blocklinks[]` arrays are
// `mobj_t*` chain heads allocated + zeroed in `P_LoadBlockMap` (p_setup.c:94
// "for thing chains") and filled per-mobj at SPAWN time: P_SetupLevel →
// P_LoadThings records the THINGS list, then P_SpawnMapThing (p_mobj.c:708)
// → P_SpawnMobj → P_SetThingPosition (defined in p_maputl.c:395 — NOT
// p_map.c) prepends the mobj into `blocklinks[by*bmapwidth+bx]`
// (doubly-linked bprev/bnext) and the sector thinglist. Spawn order is
// THINGS order, so iterating a block's chain yields things in REVERSE
// THINGS order (prepend semantics) — replicated exactly here.
//
// This sim builds the grid two ways (documented deviation, same observable
// contents):
//   - static: the THINGS list filtered through a doomednum→{@link ThingInfo}
//     table, CSR-packed per block once at map load (vanilla spawns the
//     decorations as static mobjs; positions never change, so a CSR array
//     replaces their per-spawn prepend, iteration order identical). M7-02
//     FILLED the deferred fields: the info table is now the FULL mobjinfo[]
//     slice (every spawnable doomednum — items, monsters, decor — with the
//     exact MF_* bits incl. MF_NOBLOCKMAP/MF_SPECIAL), the P_SpawnMapThing
//     solo bit (options & 16, `!netgame`) joined the filter, and
//     {@link ThingLinks.thing} records the source THINGS index per static
//     slot so p_mobj.pSpawnThings binds slot↔mobj 1:1 in spawn order.
//   - dynamic: vanilla-shaped bprev/bnext chains for movers — the player
//     and every spawned mobj (puffs/blood/missiles; MF_NOBLOCKMAP map
//     things get an inert dynamic slot) — with {@link thingSetPosition}/
//     {@link thingUnsetPosition} mirroring p_maputl.c:347-449 control flow.
//
// Sector thinglist links (P_SetThingPosition's MF_NOSECTOR branch) are NOT
// built: their only consumers are P_NoiseAlert/P_ChangeSector/PIT_DamageThings
// (M6/M8 — the crush path iterates the block grid instead). Determinism rule
// (ARCHITECTURE §3.5.5 / M5-plan §M5-02.3): unlink + link never re-inserts
// static entries, so per-block iteration order is invariant across mover
// movement. Static-slot mobjs never move (vanilla-true for decor/items in
// M7); moving a static-slot mobj (monster chase, M8) needs slot promotion —
// documented follow-up; mover mobjs spawn into DYNAMIC slots and P_TryMove
// relinks them every accepted move.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { blockIndexOf } from './blockmap';
import type { BlockMap } from './blockmap';
import { mapThingAt, type RuntimeMap } from './map';
import { sectorAtPoint } from './bsp';
import { mobjinfo, DOOMEDNUM_TO_MT } from '../wad/info/mobjinfo';

/* ------------------------------------------------------------------ */
/* MF_* flags — p_mobj.h:117-200 enum, verbatim values                  */
/* ------------------------------------------------------------------ */

/** p_mobj.h:120-121 "Call P_SpecialThing when touched" / "Blocks" / "Can be hit". */
export const MF_SPECIAL = 1;
export const MF_SOLID = 2;
export const MF_SHOOTABLE = 4;
/** p_mobj.h:123-126 sector/blockmap link opt-outs. */
export const MF_NOSECTOR = 8;
export const MF_NOBLOCKMAP = 16;
/** p_mobj.h:133 MF_NOGRAVITY (value pin for player.ts parity). */
export const MF_NOGRAVITY = 512;
/** p_mobj.h:140-142 movement flags: MF_DROPOFF 0x400, MF_PICKUP 0x800, MF_NOCLIP 0x1000. */
export const MF_DROPOFF = 0x400;
export const MF_PICKUP = 0x800;
export const MF_DROPPED = 0x20000;
export const MF_NOCLIP = 0x1000;
/** p_mobj.h:150 MF_MISSILE. */
export const MF_MISSILE = 0x10000;
/** p_mobj.h:152/155 MF_SLIDE / MF_FLOAT (values pinned for M5-03 TryMove). */
export const MF_SLIDE = 0x2000;
export const MF_FLOAT = 0x4000;
/** p_mobj.h:158 MF_TELEPORT ("no thing left behind / skip step checks"). */
export const MF_TELEPORT = 0x8000;
/** p_mobj.h:156/159 MF_SHADOW / MF_NOBLOOD. */
export const MF_SHADOW = 0x40000;
export const MF_NOBLOOD = 0x80000;
/** p_mobj.h:169/174 MF_COUNTKILL / MF_COUNTITEM. */
export const MF_COUNTKILL = 0x400000;
export const MF_COUNTITEM = 0x800000;
/** p_mobj.h:177 skull in flight. */
export const MF_SKULLFLY = 0x1000000;

/* ------------------------------------------------------------------ */
/* ThingInfo table — the mobjinfo.c slice the grid needs                */
/* ------------------------------------------------------------------ */

/** mobjinfo_t subset for linkage: fixed radius/height + MF_* bits. */
export interface ThingInfo {
  /** fixed */
  readonly radius: number;
  /** fixed */
  readonly height: number;
  readonly flags: number;
}

/**
 * doomednum → spawn info — M7-02 FILLED (the M5-03 "deferred fields for
 * M7"): the full mobjinfo[] slice. First doomednum match = vanilla
 * P_SpawnMapThing's linear-scan semantics (p_mobj.c:756-758, doomednum −1
 * excluded, info.c order), so grid flags/radius/height are the exact
 * p_mobj.h bitsets the PIT visitors need (MF_SPECIAL items non-blocking +
 * touch, MF_NOBLOCKMAP markers inert, barrels MF_SOLID|MF_SHOOTABLE|MF_NOBLOOD
 * per info.c:1888-1911).
 */
export const DEFAULT_THING_INFO: ReadonlyMap<number, ThingInfo> = new Map(
  [...DOOMEDNUM_TO_MT].map(([doomednum, mt]): [number, ThingInfo] => {
    const info = mobjinfo[mt]!;
    return [doomednum, { radius: info.radius, height: info.height, flags: info.flags }];
  }),
);

/** Vanilla spawn skill bit (p_mobj.c:737-745): baby(sk_baby=0)→1, baby-as-1
 * alias too, nightmare=4, else 1<<(skill-1). */
export function skillBit(skill: number): number {
  return skill === 0 || skill === 1 ? 1 : skill >= 4 ? 4 : 1 << (skill - 1);
}

/** MTF_* option bits (R01 §4 / p_mobj.c:740,792): bit 16 = "not in single
 * player" (skipped when !netgame), bit 8 = MTF_AMBUSH. */
export const MTF_AMBUSH = 8;
export const MTF_NOTSINGLEPLAYER = 16;

/* ------------------------------------------------------------------ */
/* ThingLinks storage                                                   */
/* ------------------------------------------------------------------ */

/**
 * Per-block thing lists over a shared slot arena ([0, staticCount) = static
 * THINGS spawns in THINGS order; [staticCount, capacity) = dynamic mover
 * slots). Block (bx,by) cell index `by*bm.width+bx` — same grid as the
 * linedef blockmap ({@link BlockMap} dims reused verbatim).
 *
 * Static slots live ONLY in the {@link blockThings} CSR (iteration order =
 * reverse THINGS order = vanilla prepend-chain order); dynamic slots live
 * ONLY in the {@link cellHead}/{@link prev}/{@link next} chains. Per cell
 * the visit order is dynamic-chain-then-static-CSR, which equals vanilla's
 * chain (dynamic things were linked AFTER the static spawns, so they sit in
 * front of the static prefix).
 */
export interface ThingLinks {
  readonly bm: BlockMap;
  /** slots currently allocated (static + dynamic + free tail). */
  capacity: number;
  readonly staticCount: number;
  /** next free dynamic slot ([nextDynamic, capacity) is unused). */
  nextDynamic: number;

  /* The slot arena arrays are replaced wholesale by growThingLinks() —
   * contents of existing slots are preserved, identities are not (never
   * hold a subarray across a spawn). */

  /** fixed coords; static slots = spawn pos (x<<FRACBITS, p_mobj.c:776). */
  x: Int32Array;
  y: Int32Array;
  /** fixed — spawn floor resolution (P_SpawnMobj ONFLOORZ ⇒ sector floor, p_mobj.c:522). */
  z: Int32Array;
  radius: Int32Array;
  height: Int32Array;
  flags: Int32Array;
  /** THINGS `type` (0 = dynamic slot without spawn point). */
  doomednum: Int32Array;
  /** M7-02: source THINGS record index per static slot (−1 for dynamic
   * slots) — the slot↔thing binding pSpawnThings walks in spawn order. */
  thing: Int32Array;

  /** 1 = in the block chains/CSR right now (vanilla "valid" link state). */
  linked: Uint8Array;
  /** dynamic chain head per cell, −1 = empty (grid-sized; never grows). */
  cellHead: Int32Array;
  /** dynamic chain links per slot, −1 sentinel (bprev/bnext). */
  prev: Int32Array;
  next: Int32Array;

  /** CSR bounds per cell over {@link blockThings} (length cells+1). */
  readonly blockStart: Int32Array;
  /** static slot ids per block, iteration order = reverse THINGS order. */
  readonly blockThings: Int32Array;

  /** THINGS whose doomednum has no table entry (M7 fills the roster). */
  readonly skippedUnknown: number;
}

export interface BuildThingLinksOptions {
  readonly info?: ReadonlyMap<number, ThingInfo>;
  /** gameskill 1..4; default 3 (HMP, the p_setup default skill). */
  readonly skill?: number;
  /** dynamic slots reserved for movers (player + telefrags); default 16. */
  readonly dynamicCapacity?: number;
  /** vanilla `netgame` spawn flag (P_SpawnMapThing's `options & 16` solo
   * skip, p_mobj.c:740). Default false = single player. */
  readonly netgame?: boolean;
}

/**
 * P_SetupLevel-side thing spawn grouping (see header comment for the
 * vanilla truth): decode THINGS → filter starts/skill/unknown → link into
 * the block grid. One allocation pass (counts + fill), deterministic
 * (THINGS order, reverse fill per cell), zero allocation afterwards.
 */
export function buildThingLinks(
  map: RuntimeMap,
  bm: BlockMap,
  opts: BuildThingLinksOptions = {},
): ThingLinks {
  const info = opts.info ?? DEFAULT_THING_INFO;
  const bit = skillBit(opts.skill ?? 3);
  const netgame = opts.netgame ?? false;
  const cells = bm.width * bm.height;

  // Pass 1: spawnable statics, THINGS order.
  const spawnX: number[] = [];
  const spawnY: number[] = [];
  const spawnZ: number[] = [];
  const spawnR: number[] = [];
  const spawnH: number[] = [];
  const spawnF: number[] = [];
  const spawnT: number[] = [];
  const spawnCell: number[] = [];
  const spawnRec: number[] = [];
  let skippedUnknown = 0;
  for (let i = 0; i < map.numThings; i++) {
    const t = mapThingAt(map, i);
    if (t.type <= 4 || t.type === 11) continue; // start machinery, no mobj
    if (!netgame && (t.flags & MTF_NOTSINGLEPLAYER) !== 0) continue; // solo skip (p_mobj.c:740)
    if (!(t.flags & bit)) continue; // skill-gated spawn (p_mobj.c:744)
    const inf = info.get(t.type);
    if (!inf) {
      skippedUnknown++; // vanilla: I_Error("Unknown type"); M7 table completes
      continue;
    }
    if (inf.flags & MF_NOBLOCKMAP) continue; // inert: never in blocklinks
    const x = (t.x << 16) | 0;
    const y = (t.y << 16) | 0;
    const cx = blockIndexOf(x - bm.originX);
    const cy = blockIndexOf(y - bm.originY);
    // P_GroupLines-style in-grid guard lives in the link step; an off-grid
    // spawn keeps a slot but links nowhere (p_maputl.c:427-431).
    const cell = cx >= 0 && cy >= 0 && cx < bm.width && cy < bm.height ? cy * bm.width + cx : -1;
    spawnX.push(x);
    spawnY.push(y);
    // ONFLOORZ resolution (p_mobj.c:517-523): subsector floor height.
    spawnZ.push(map.sectors.floorHeight[sectorAtPoint(map, x, y)]!);
    spawnR.push(inf.radius);
    spawnH.push(inf.height);
    spawnF.push(inf.flags);
    spawnT.push(t.type);
    spawnRec.push(i);
    spawnCell.push(cell);
  }

  const staticCount = spawnX.length;
  const capacity = staticCount + (opts.dynamicCapacity ?? 16);

  // CSR counts per cell (in-grid statics only), filled in REVERSE spawn
  // order so per-cell iteration matches vanilla's prepend chains.
  const blockStart = new Int32Array(cells + 1);
  for (let i = 0; i < staticCount; i++) {
    const c = spawnCell[i]!;
    if (c >= 0) blockStart[c + 1]!++;
  }
  for (let c = 0; c < cells; c++) blockStart[c + 1]! += blockStart[c]!;
  const blockThings = new Int32Array(blockStart[cells]!);
  const at = Int32Array.from(blockStart.subarray(0, cells)); // write cursor
  for (let i = staticCount - 1; i >= 0; i--) {
    const c = spawnCell[i]!;
    if (c < 0) continue;
    blockThings[at[c]!++] = i;
  }

  const arena = (minusFill = false): Int32Array =>
    minusFill ? new Int32Array(capacity).fill(-1) : new Int32Array(capacity);
  const x = new Int32Array(capacity);
  const y = new Int32Array(capacity);
  const z = new Int32Array(capacity);
  const radius = new Int32Array(capacity);
  const height = new Int32Array(capacity);
  const flags = new Int32Array(capacity);
  const doomednum = new Int32Array(capacity);
  const thing = new Int32Array(capacity).fill(-1);
  for (let i = 0; i < staticCount; i++) {
    x[i] = spawnX[i]!;
    y[i] = spawnY[i]!;
    z[i] = spawnZ[i]!;
    radius[i] = spawnR[i]!;
    height[i] = spawnH[i]!;
    flags[i] = spawnF[i]!;
    doomednum[i] = spawnT[i]!;
    thing[i] = spawnRec[i]!;
  }

  const links: ThingLinks = {
    bm,
    capacity,
    staticCount,
    nextDynamic: staticCount,
    x,
    y,
    z,
    radius,
    height,
    flags,
    doomednum,
    thing,
    linked: new Uint8Array(capacity),
    cellHead: new Int32Array(cells).fill(-1),
    prev: arena(true),
    next: arena(true),
    blockStart,
    blockThings,
    skippedUnknown,
  };
  for (let i = 0; i < staticCount; i++) {
    links.linked[i] = spawnCell[i]! >= 0 ? 1 : 0;
  }
  return links;
}

/* ------------------------------------------------------------------ */
/* Dynamic slots — p_maputl.c P_SetThingPosition / P_UnsetThingPosition */
/* ------------------------------------------------------------------ */

/**
 * Reserve a dynamic (mover) slot, unlinked. Grows the arena by doubling
 * when full — allocation happens at spawn only, never inside a query
 * (documented: vanilla `Z_Malloc`s each mobj at spawn too).
 */
export function allocThingSlot(
  links: ThingLinks,
  radius: number,
  height: number,
  flags: number,
): number {
  if (links.capacity <= links.nextDynamic) growThingLinks(links);
  const slot = links.nextDynamic++; // never reuse: vanilla Z_Mallocs per mobj too
  links.x[slot] = 0;
  links.y[slot] = 0;
  links.z[slot] = 0;
  links.radius[slot] = radius;
  links.height[slot] = height;
  links.flags[slot] = flags;
  links.doomednum[slot] = 0;
  links.thing[slot] = -1;
  links.linked[slot] = 0;
  links.prev[slot] = -1;
  links.next[slot] = -1;
  return slot;
}

function growThingLinks(links: ThingLinks): void {
  const next = Math.max(links.capacity * 2, links.staticCount + 1);
  const grow = (src: Int32Array, minusFill = false): Int32Array => {
    const a = minusFill ? new Int32Array(next).fill(-1) : new Int32Array(next);
    a.set(src);
    return a;
  };
  links.x = grow(links.x);
  links.y = grow(links.y);
  links.z = grow(links.z);
  links.radius = grow(links.radius);
  links.height = grow(links.height);
  links.flags = grow(links.flags);
  links.doomednum = grow(links.doomednum);
  links.thing = grow(links.thing, true);
  links.prev = grow(links.prev, true);
  links.next = grow(links.next, true);
  const linked = new Uint8Array(next);
  linked.set(links.linked);
  links.linked = linked;
  links.capacity = next;
}

/**
 * `P_SetThingPosition` (p_maputl.c:395-449) for a dynamic slot: write the
 * fixed x/y (vanilla sets `thing->x/y` before calling — deviation: no mobj
 * struct yet, so the coords arrive here) and PREPEND into the cell chain.
 * MF_NOBLOCKMAP slots stay inert; off-grid positions unlink (vanilla "thing
 * is off the map" branch). Static slots never move (throw): their CSR cell
 * membership is fixed at map load, and moving one would violate the
 * no-reinsertion determinism rule this module exists to guarantee.
 */
export function thingSetPosition(links: ThingLinks, slot: number, x: number, y: number): void {
  if (slot < links.staticCount) {
    throw new ThingLinksError(
      `static thing slot ${slot} cannot be repositioned (mover links are M7 thinkers)`,
    );
  }
  links.x[slot] = x;
  links.y[slot] = y;
  if (links.flags[slot]! & MF_NOBLOCKMAP) return;
  const cx = blockIndexOf(x - links.bm.originX);
  const cy = blockIndexOf(y - links.bm.originY);
  if (cx >= 0 && cy >= 0 && cx < links.bm.width && cy < links.bm.height) {
    const head = links.cellHead[cy * links.bm.width + cx]!;
    links.prev[slot] = -1;
    links.next[slot] = head;
    if (head !== -1) links.prev[head] = slot;
    links.cellHead[cy * links.bm.width + cx] = slot;
    links.linked[slot] = 1;
  } else {
    links.prev[slot] = -1;
    links.next[slot] = -1;
    links.linked[slot] = 0;
  }
}

/**
 * `P_UnsetThingPosition` (p_maputl.c:347-382) for a dynamic slot: splice
 * out of the cell chain. Idempotent — the vanilla `bprev/bnext` tests are
 * replaced by the {@link ThingLinks.linked} flag (deviation note: vanilla
 * relies on caller discipline and corrupts the head if called twice; the
 * P_TryMove unset-then-set order never does, and the flag makes the
 * no-op-by-default path provably safe for the sim).
 */
export function thingUnsetPosition(links: ThingLinks, slot: number): void {
  if (links.flags[slot]! & MF_NOBLOCKMAP) return;
  if (slot < links.staticCount) {
    links.linked[slot] = 0; // CSR entries are skipped while unlinked
    return;
  }
  if (!links.linked[slot]) return;
  const cx = blockIndexOf(links.x[slot]! - links.bm.originX);
  const cy = blockIndexOf(links.y[slot]! - links.bm.originY);
  const p = links.prev[slot]!;
  const n = links.next[slot]!;
  if (n !== -1) links.prev[n] = p;
  if (p !== -1) links.next[p] = n;
  else if (cx >= 0 && cy >= 0 && cx < links.bm.width && cy < links.bm.height) {
    links.cellHead[cy * links.bm.width + cx] = n;
  }
  links.prev[slot] = -1;
  links.next[slot] = -1;
  links.linked[slot] = 0;
}

/* ------------------------------------------------------------------ */
/* Iteration — p_maputl.c P_BlockThingsIterator                         */
/* ------------------------------------------------------------------ */

/**
 * `P_BlockThingsIterator(bx,by,PIT_CheckThing)` for one cell: dynamic chain
 * head-first, then the static CSR range; `visit(slot)` returning false
 * stops (returns false). Out-of-grid cells visit nothing (vanilla's
 * `if (x >= bmapwidth || y >= bmapheight) return true;`). No validcount
 * dedup — exactly like the C original, a thing touching two blocks IS
 * visited twice per query (MAXRADIUS-extension loops rely on the PIT
 * distance test to make the repeats harmless).
 */
export function thingLinksIterator(
  links: ThingLinks,
  bx: number,
  by: number,
  visit: (slot: number) => boolean,
): boolean {
  if (bx < 0 || by < 0 || bx >= links.bm.width || by >= links.bm.height) return true;
  const cell = by * links.bm.width + bx;
  for (let slot = links.cellHead[cell]!; slot !== -1; slot = links.next[slot]!) {
    if (!visit(slot)) return false;
  }
  const end = links.blockStart[cell + 1]!;
  for (let k = links.blockStart[cell]!; k < end; k++) {
    const slot = links.blockThings[k]!;
    if (links.linked[slot] === 0) continue;
    if (!visit(slot)) return false;
  }
  return true;
}

export class ThingLinksError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThingLinksError';
  }
}
