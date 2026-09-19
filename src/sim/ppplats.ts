// sim/ppplats.ts — plats/lifts (p_plats.c). M6-03 STUB bodies (see
// pdoors.ts header; M6-06 replaces the bodies, signatures fixed here).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { recordLineStub } from './specials-table';
import type { SpecWorld } from './pspec-helpers';

/** `EV_DoPlat(line, plattype_e, amount)` (p_plats.c). */
export function evDoPlat(
  s: SpecWorld, line: number, type: number, amount: number
): boolean {
  recordLineStub(s, 'evDoPlat', line, type, amount);
  return false;
}

/** `EV_StopPlat(line)` — specials 54/89 (void return in 1.10). */
export function evStopPlat(s: SpecWorld, line: number): boolean {
  recordLineStub(s, 'evStopPlat', line, 0);
  return true; // void in vanilla — treated as "reached the case"
}
