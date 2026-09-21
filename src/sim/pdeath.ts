// sim/pdeath.ts — M8-06 pain/death/corpse action layer (M8-plan §M8-06).
//
// Registers the four remaining E1-required action ids with their exact
// vanilla bodies from p_enemy.c:
//   A_Pain    (id 25, :1577) — S_StartSound(actor, info->painsound), no PRNG
//   A_Scream  (id 33, :1535) — deathsound family variants (podth* %3,
//                             bgdth* %2, SPID/CYB full volume NULL origin)
//   A_XScream (id 28, :1572) — S_StartSound(actor, sfx_slop)
//   A_Fall    (id 27, :1585) — flags &= ~MF_SOLID (corpse becomes steppable)
//
// STUB — bodies pending (this commit scaffolds the module).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ACT, registerAction } from './a_actions';
import type { Mobj } from './p_mobj';

/** STUB */
export function aPain(_actor: Mobj): void {}

/** STUB */
export function aScream(_actor: Mobj): void {}

/** STUB */
export function aXScream(_actor: Mobj): void {}

/** STUB */
export function aFall(_actor: Mobj): void {}

/** Register the four death-layer action ids (p_enemy.ts idiom). */
export function registerDeathActions(): void {
  registerAction(ACT.A_Pain, (ctx) => aPain(ctx as Mobj));
  registerAction(ACT.A_Scream, (ctx) => aScream(ctx as Mobj));
  registerAction(ACT.A_XScream, (ctx) => aXScream(ctx as Mobj));
  registerAction(ACT.A_Fall, (ctx) => aFall(ctx as Mobj));
}

registerDeathActions();
