// sim/pswitch.ts — switch texture swap / buttons / locked doors
// (p_switch.c). M6-03 STUB bodies (see pdoors.ts header; M6-11 replaces
// the bodies — P_UseSpecialLine's FULL dispatcher + P_UseLines +
// switchlist land THERE; the registry-driven routing skeleton lives in
// pspec.ts until then).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { recordLineStub } from './specials-table';
import type { SpecWorld } from './pspec-helpers';
import type { Mover } from './pmap';

/**
 * `P_ChangeSwitchTexture(line, useAgain)` (p_switch.c). The STUB records
 * the call ONLY: the disarm (`if (!useAgain) line->special = 0;`), the
 * switchlist xor-1 swap and the special-11 sfx quirk are the real body's
 * (M6-11) — the registry's switchBefore/gateSwitch/thenSwitch flags in
 * pspec.ts already encode WHEN it is called with which useAgain.
 */
export function pChangeSwitchTexture(
  s: SpecWorld, line: number, useAgain: number
): void {
  recordLineStub(s, 'pChangeSwitchTexture', line, useAgain);
}

/** `EV_DoLockedDoor(line, blazeOpen, thing)` — specials 99/133–137
 * (p_switch.c; the card/skull check + PD_*O message arrive with M6-11). */
export function evDoLockedDoor(
  s: SpecWorld, line: number, type: number, mover: Mover | null
): boolean {
  void mover;
  recordLineStub(s, 'evDoLockedDoor', line, type);
  return false;
}
