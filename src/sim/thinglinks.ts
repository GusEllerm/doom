// sim/thinglinks — thing blockmap (blocklinks) grid: static thing lists +
// dynamic mover chains. M5-02 (p_map.c part 1 support).
//
// Vanilla truth (verified against linuxdoom-1.10 sources): there is NO
// `P_InitThingLinks`. The `blocklinks[]` mobj chains are filled per-mobj at
// SPAWN time — P_SetupLevel → P_LoadThings records the THINGS array, then
// P_SpawnMapThing (p_mobj.c:708) → P_SpawnMobj → P_SetThingPosition
// (defined in p_maputl.c:395, NOT p_map.c) links each mobj into
// `blocklinks[by*bmapwidth+bx]` (doubly-linked bprev/bnext) and the
// sector thinglist. `blocklinks` itself is only zeroed in P_LoadBlockMap
// ("for thing chains", p_setup.c:94).
//
// This sim has no mobjs yet (M7/M8 roster), so this module builds the grid
// two ways:
//   - static: the THINGS list filtered through a doomednum→{radius,flags}
//     info table, CSR-packed per block at map load (one allocation);
//   - dynamic: vanilla-shaped bprev/bnext chains for movers (the player now,
//     mobjs later) with thingSetPosition/thingUnsetPosition mirroring
//     p_maputl.c verbatim control flow.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { BlockMap } from './blockmap';

/** p_mobj.h MF_* bits (full set; M5-02 honors SOLID/SPECIAL/SHOOTABLE/
 * NOCLIP/NOBLOCKMAP/NOSECTOR; PICKUP/DROPOFF/MISSILE/SKULLFLY slots M7+). */
export const MF_SPECIAL = 1;
export const MF_SOLID = 2;
export const MF_SHOOTABLE = 4;
export const MF_MISSILE = 8;
export const MF_DROPOFF = 0x10;
export const MF_PICKUP = 0x20;
export const MF_NOCLIP = 0x1000;
export const MF_NOSECTOR = 0x400;
export const MF_NOBLOCKMAP = 0x800;

/** Minimum-capacity dynamic chain pool; grow-by-double with the documented
 * "no re-insertion" rule (slots keep identity across moves). */
export interface ThingLinks {
  readonly bm: BlockMap;
  /** CSR bounds over staticThing slots per block cell. */
  readonly blockStart: Int32Array;
  /** Static thing indices per block (THINGS-order stable). */
  readonly blockThings: Int32Array;
  readonly count: number;
  /** Per-slot fixed coords/radius/flags (static + dynamic). */
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly radius: Int32Array;
  readonly flags: Int32Array;
  /** doomednum (0 = dynamic-only slot). */
  readonly doomednum: Int32Array;
  /** 1 = linked into block chains, 0 = unlinked/self-off-grid. */
  linked: Uint8Array;
  /** dynamic chain heads per cell, and slot prev/next (-1 sentinel). */
  cellHead: Int32Array;
  prev: Int32Array;
  next: Int32Array;
}

export function buildThingLinks(): ThingLinks {
  throw new Error('TODO M5-02');
}
