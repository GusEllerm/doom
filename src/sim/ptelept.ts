// sim/ptelept.ts — teleporters (p_telept.c). M6-03 STUB body (see
// pdoors.ts header; M6-10 replaces the body, signature fixed here).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { recordLineStub } from './specials-table';
import type { SpecWorld } from './pspec-helpers';
import type { Mover } from './pmap';

/**
 * `EV_Teleport(line, side, thing)` (p_telept.c). The dispatcher passes the
 * CROSSING side (p_spec.c hands `side` straight through; the `side == 1`
 * no-op gate is INSIDE the body, R05 §11 — so the stub records it and the
 * M6-03 test pins the wiring; the gate body itself is M6-10).
 */
export function evTeleport(
  s: SpecWorld, line: number, side: number, mover: Mover | null
): boolean {
  void mover;
  recordLineStub(s, 'evTeleport', line, side);
  return false;
}
