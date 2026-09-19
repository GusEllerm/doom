// sim/pfloor.ts — floors/stairs/donut (p_floor.c). M6-03 STUB bodies (see
// pdoors.ts header; M6-07 replaces the bodies). EV_DoDonut lives here even
// though 1.10 keeps it in p_spec.c — ownership carve-out D013(b), same
// call semantics.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { recordLineStub } from './specials-table';
import type { SpecWorld } from './pspec-helpers';

/** `EV_DoFloor(line, floor_e)` (p_floor.c). */
export function evDoFloor(s: SpecWorld, line: number, type: number): boolean {
  recordLineStub(s, 'evDoFloor', line, type);
  return false;
}

/** `EV_BuildStairs(line, stair_e)` (p_floor.c). */
export function evBuildStairs(s: SpecWorld, line: number, type: number): boolean {
  recordLineStub(s, 'evBuildStairs', line, type);
  return false;
}

/** `EV_DoDonut(line)` — 1.10 p_spec.c, implemented in pfloor.ts (D013(b)). */
export function evDoDonut(s: SpecWorld, line: number): boolean {
  recordLineStub(s, 'evDoDonut', line, 0);
  return false;
}
