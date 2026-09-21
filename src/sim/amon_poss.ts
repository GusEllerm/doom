// sim/amon_poss.ts — M8-07 Family A: Zombieman / Shotgun Guy / Imp attack
// actions (linuxdoom-1.10 p_enemy.c bodies + info.c S_POSS_ATK*/S_SPOS_ATK*/
// S_TROO_ATK3/S_CPOS_ATK* rows). SCAFFOLD — bodies land in follow-up commits.
//
// SCOPE (docs/design/M8-plan.md §M8-07 + §0.7, authoritative):
//   A_PosAttack    id 32  p_enemy.c:802  (POSS S_POSS_ATK2 — hitscan pistol
//                          analog: A_FaceTarget, P_AimLineAttack(MISSILERANGE),
//                          sfx_pistol, angle += (R-R)<<20, dmg ((R%5)+1)*3,
//                          P_LineAttack)
//   A_SPosAttack   id 34  p_enemy.c:821  (SPOS S_SPOS_ATK2 — sfx_shotgn then
//                          THREE (angle-jitter 2 draws + dmg 1 draw) shots =
//                          9 draws; also shared by SPID rows, fixture-only)
//   A_TroopAttack  id 53  p_enemy.c:913  (TROO S_TROO_ATK3, melee AND missile
//                          state: melee sfx_claw + (R%8+1)*3 via damage
//                          bridge, else P_SpawnMissile(MT_TROOPSHOT))
//   A_CPosAttack   id 51  p_enemy.c:845  (fixture-only: no doomednum 65 in
//                          E1 per §0.12/monster-census)
//   A_CPosRefire   id 52  p_enemy.c:865  (fixture-only, same)
//
// PLUS the id27 domain-disambiguation fix handed off by M8-06 (journal
// 2026-09-23): the state-action resolver must be DOMAIN-AWARE — ActionId 27
// is A_Fall for the mobj machine (p_enemy.c:1585, mobj ctx) while the
// weapon/psprite machine's id-27 identity (the weapon-lowering "A_WeaponFall"
// reading from the M8-06 note) must never execute the mobj A_Fall body.
//
// Owns: src/sim/amon_poss.ts (+ amon_poss.test.ts). Consumes: p_enemy.ts
// (aFaceTarget/pCheckMeleeRange/pCheckMissileRange), p_shoot.ts
// (pAimLineAttack/pLineAttack), pmissiles.ts (pSpawnMissile),
// p_inter_damage.ts (pDamageMobj via the bridge), psound_stub (SFX sites).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ACT, registerAction } from './a_actions';

/** Registration (self-import idiom — importing this module registers the
 * Family A action ids). TODO (next commit): verbatim bodies + sfx sites. */
export function registerFamilyAActions(): void {
  // placeholder registration order — bodies arrive with the implementation
  // commits (pdeath.ts idiom: register at import, game.ts flip is M8-11's).
  void ACT;
  void registerAction;
}

registerFamilyAActions();
