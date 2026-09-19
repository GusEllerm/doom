// sim/pmove — p_mobj.c movement core (M5-05): P_XYMovement + P_ZMovement.
// Stub — signatures + constants pinned; bodies land in the implementation
// commit. See docs/design/M5-plan.md §M5-05.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';
import type { Mover, PMapWorld } from './pmap';

/** p_mobj.c:111 */
export const STOPSPEED = 0x1000;
/** p_mobj.c:112 */
export const FRICTION = 0xe800;
/** p_local.h:53 */
export const GRAVITY = FRACUNIT;
/** p_local.h:54 */
export const MAXMOVE = 30 * FRACUNIT;
/** p_local.h:30 (floaters arrive M7; pinned here) */
export const FLOATSPEED = 4 * FRACUNIT;
/** p_local.h:34 */
export const VIEWHEIGHT = 41 * FRACUNIT;

/** Full mobj_t movement slice (Mover + momentum; pmove.ts owns the type so
 * pmap.ts stays untouched — M5-04 pslide runs in parallel). */
export interface MoveMobj extends Mover {
  momx: number;
  momy: number;
  momz: number;
  floorz: number;
  ceilingz: number;
}

/** P_XYMovement — stub, throws until implemented. */
export function pXYMovement(world_: PMapWorld, mo: MoveMobj): void {
  void world_;
  void mo;
  throw new Error('pXYMovement: not implemented');
}

/** P_ZMovement — stub, throws until implemented. */
export function pZMovement(mo: MoveMobj): void {
  void mo;
  throw new Error('pZMovement: not implemented');
}
