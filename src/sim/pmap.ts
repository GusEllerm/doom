// sim/pmap — p_map.c part 1 (M5-02): P_CheckPosition + thinglinks.
//
// Module-static tm-state (tmbbox/tmthing/tmx/tmy/floatok/tmfloorz/
// tmceilingz/tmdropoffz/ceilingline/spechit[8]/numspechit) mirrors the
// p_map.c globals verbatim; PIT_CheckLine / PIT_CheckThing are module-level
// visitor functions reading that state exactly like the C callbacks do —
// zero allocation, zero closures per query.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { BlockMap } from './blockmap';
import type { RuntimeMap } from './map';
import type { ThingLinks } from './thinglinks';

/** MAXSPECIALCROSS (p_map.c:69). */
export const MAXSPECIALCROSS = 8;

/** Mover slice consumed by P_CheckPosition (mobj_t subset; the player's
 * MobjStub satisfies it). */
export interface Mover {
  x: number;
  y: number;
  z: number;
  radius: number;
  height: number;
  flags: number;
  /** truthy for players: disables the ML_BLOCKMONSTERS test. */
  player?: boolean;
}

/** World the movement clipping reads. */
export interface PMapWorld {
  readonly map: RuntimeMap;
  readonly bm: BlockMap;
  readonly links: ThingLinks;
}

export function pCheckPosition(
  world: PMapWorld,
  thing: Mover,
  x: number,
  y: number,
): boolean {
  void world;
  void thing;
  void x;
  void y;
  throw new Error('TODO M5-02');
}
