// sim/puser.ts — p_user.c movement (M5-06): P_Thrust / P_MovePlayer /
// P_CalcHeight / the real P_PlayerThink. Replaces the D009 fly stub.
//
// STUB (this commit): signatures + constants only; bodies land in the
// implementation commit. See docs/design/M5-plan.md §M5-06.
//
// SPDX-License-Identifier: GPL-2.0-plus

import type { PMapWorld } from './pmap';
import type { Player } from './player';

/** p_user.c:42 `#define MAXBOB 0x100000` (16 pixels of bob). */
export const MAXBOB = 0x100000;

/** p_user.c:51 file-scope `boolean onground;` (set by P_MovePlayer). */
export const puserState = { onground: 0 };

export function pThrust(p: Player, angle: number, move: number): void {
  throw new Error('pThrust: stub');
}

export function pCalcHeight(p: Player, leveltime: number): void {
  throw new Error('pCalcHeight: stub');
}

export function pPlayerThink(world: PMapWorld, p: Player, leveltime: number): void {
  throw new Error('pPlayerThink: stub');
}
