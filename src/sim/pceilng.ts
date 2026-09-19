// sim/pceilng.ts — ceilings/crushers (p_ceilng.c — 1.10 filename, NOT
// p_ceiling.c). M6-03 STUB bodies (see pdoors.ts header; M6-08 replaces).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { recordLineStub } from './specials-table';
import type { SpecWorld } from './pspec-helpers';

/** `EV_DoCeiling(line, ceiling_e)` (p_ceilng.c). */
export function evDoCeiling(s: SpecWorld, line: number, type: number): boolean {
  recordLineStub(s, 'evDoCeiling', line, type);
  return false;
}

/** `EV_CeilingCrushStop(line)` — specials 57/74 (p_ceilng.c stasis). */
export function evCeilingCrushStop(s: SpecWorld, line: number): boolean {
  recordLineStub(s, 'evCeilingCrushStop', line, 0);
  return false;
}
