// sim/pdoors.ts — vertical doors (p_doors.c). M6-03 STUB bodies: the
// registry routes hit these slots, record unimplementedSpecial and report
// "nothing moved" (false), reproducing the vanilla control flow where a
// failed action leaves switches armed (M6-plan §M6-03). M6-05 replaces
// THIS FILE's bodies keeping the exact signatures below; M6-09 edits only
// the spawn cases of pspec.ts, not these entry points.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { recordLineStub, recordSectorStub } from './specials-table';
import type { SpecWorld } from './pspec-helpers';
import type { Mover } from './pmap';

/** `EV_DoDoor(line, vldoor_e)` — tagged door actions (p_doors.c). */
export function evDoDoor(s: SpecWorld, line: number, type: number): boolean {
  recordLineStub(s, 'evDoDoor', line, type);
  return false;
}

/** `EV_VerticalDoor(line, thing)` — manual/locked manual doors (p_doors.c).
 * Returns the vanilla int (0/1 = nothing/touched); manuals never disarm
 * here except open-types (inside the real body, M6-05). */
export function evVerticalDoor(
  s: SpecWorld, line: number, mover: Mover | null
): boolean {
  void mover;
  recordLineStub(s, 'evVerticalDoor', line, 0);
  return false;
}

/** `P_SpawnDoorCloseIn30(sector)` — sector special 10 (sector INDEX
 * argument, like every sector spawner). */
export function pSpawnDoorCloseIn30(s: SpecWorld, sector: number): void {
  recordSectorStub(s, 'pSpawnDoorCloseIn30', sector, 0);
}

/** `P_SpawnDoorRaiseIn5Mins(sector, i)` — sector special 14; `i` is the
 * vanilla sector-index second arg (p_doors.c), carried in the stub log. */
export function pSpawnDoorRaiseIn5Mins(
  s: SpecWorld, sector: number, i: number
): void {
  recordSectorStub(s, 'pSpawnDoorRaiseIn5Mins', sector, i);
}
