// sim/amon_poss.ts — M8-07 Family A: Zombieman / Shotgun Guy / Imp attack
// actions (linuxdoom-1.10 p_enemy.c, mirror verified 62 .c files, M8-plan
// §0.0; bodies VERBATIM with line cites).
//
// SCOPE (docs/design/M8-plan.md §M8-07 + §0.7, authoritative):
//   A_PosAttack   id 32  p_enemy.c:802-819  POSS S_POSS_ATK2 (info.c:185):
//                          A_FaceTarget → P_AimLineAttack(MISSILERANGE) →
//                          sfx_pistol (:815 — the possessed shoot like a
//                          pistol: hitscan, NO projectile mobj) →
//                          angle += (R−R)<<20 (:816, 2 draws) →
//                          damage = ((R%5)+1)*3 = 3/6/9/12/15 (:817) →
//                          P_LineAttack (:818).
//   A_SPosAttack  id 34  p_enemy.c:821-843  SPOS S_SPOS_ATK2 (info.c:218;
//                          the SPID rows reuse it — fixture-only, §0.12):
//                          sfx_shotgn FIRST (:832, BEFORE the face), face,
//                          ONE aim, then THREE shots (:837-841): jitter
//                          (2 draws) + damage (1) each ⇒ EXACTLY 9 draws
//                          per invocation (plan §0.7), each pellet
//                          3/6/9/12/15 (9..45 total).
//   A_TroopAttack id 53  p_enemy.c:913-932  TROO S_TROO_ATK3 (info.c:454;
//                          mobjinfo TROO meleestate == missilestate ==
//                          S_TROO_ATK1, so ONE body serves both): melee
//                          branch sfx_claw + (R%8+1)*3 = 3..24
//                          P_DamageMobj (:923-926); ELSE
//                          P_SpawnMissile(MT_TROOPSHOT) (:931). MISSILE
//                          TYPE TRUTH (cite required by the brief): the
//                          imp fires MT_TROOPSHOT — the TROOPBALL reading
//                          in the plan shorthand is the same mobj:
//                          mobjinfo MT_TROOPSHOT (info.c:1914, doomednum
//                          −1) spawns S_TBALL1 (the imp fireball;
//                          speed 10*FRACUNIT, damage 3, seesound
//                          sfx_firsht). There is NO MT_TROOPBALL symbol
//                          in 1.10 (grep info.h: MT_TROOPSHOT :1195) and
//                          the MT_FIRE (flame) reading is WRONG — MT_FIRE
//                          is the BFG/environmental flame thing, never an
//                          imp missile.
//   A_CPosAttack  id 51  p_enemy.c:845-863  + A_CPosRefire id 52
//                          p_enemy.c:865-880 — CPOS/SSWV rows, REGISTERED
//                          but UNREACHABLE in Phase 1: doomednum 65/71
//                          appear in ZERO E1M1–E1M9 THINGS (plan §0.12,
//                          re-derived at test time by
//                          tests/headless/monster-census.test.ts).
//
// Damage routing (M8-05 convention): the melee branch calls the port's
// single P_DamageMobj entry (pplayer.ts pPlayerDamage — player branch +
// non-player delegation to p_inter_damage.pDamageMobj) with the EXACT
// vanilla (target, inflictor=actor, source=actor) triple. The hitscan
// branches go through pLineAttack → PTR_ShootTraverse → damageSlot →
// damageBridge (non-player targets live; PLAYER targets are the D-m1
// record-only hold — the family suite installs a player-aware bridge to
// measure monster→player hitscan damage, see amon_poss.test.ts; production
// activation of the player sites is the M8-11 corpus re-derivation).
//
// PRNG ledger (random-sites.ts, same commit): PosAttack 3 (jitter 2 +
// damage 1), SPosAttack 2 OCCURRENCES (jitter 1 + damage 1, executed 3×
// in the loop = 9 runtime draws), CPosAttack 2, CPosRefire 1,
// TroopAttack 1 → 9 occurrences. A_FaceTarget's MF_SHADOW jitter (2
// draws) belongs to p_enemy.ts's ledger line, NOT here.
// SFX ledger (psound_stub SFX_SITE_LEDGER, same commit): pistol 1 +
// shotgn 2 (SPOS + CPOS) + claw 1 → 4 emit statements.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { mobjinfo, MT } from '../wad/info/mobjinfo';
import { ACT, registerAction } from './a_actions';
import { sfxSlot } from './hooks';
import { MISSILERANGE, pSetMobjState, type Mobj } from './p_mobj';
import { aFaceTarget, pCheckMeleeRange } from './p_enemy';
import { pPlayerDamage } from './pplayer';
import { pSpawnMissile } from './pmissiles';
import { pRandom } from './prng';
import { SFX_ID } from './psound_stub';
import { pAimLineAttack, pLineAttack } from './p_shoot';
import { pCheckSight } from './psight';

/* ------------------------------------------------------------------ */
/* A_PosAttack — p_enemy.c:802-819 (action id 32)                        */
/* ------------------------------------------------------------------ */

/**
 * `A_PosAttack(actor)` verbatim: bail without a target; face (shadow
 * target ⇒ 2 draws, p_enemy.ts's ledger); ONE aim over MISSILERANGE; the
 * PISTOL sound; then the single hit with the `<<20` spread and the
 * ((R%5)+1)*3 pistol-class damage. 3 draws of THIS body per invocation
 * (+2 more only when the target is MF_SHADOW).
 */
export function aPosAttack(actor: Mobj): void {
  if (!actor.target) return; // :808-809

  aFaceTarget(actor); // :811
  const angle0 = actor.angle >>> 0; // :812
  const slope = pAimLineAttack(actor, angle0, MISSILERANGE); // :813

  const rt = actor.rt;
  sfxSlot(rt.state.hooks, SFX_ID.sfx_pistol, actor.x, actor.y, actor.z, rt.state.leveltime); // :815
  const rng = rt.state.rng;
  const angle = (angle0 + (((pRandom(rng) - pRandom(rng)) << 20) | 0)) >>> 0; // :816
  const damage = (((pRandom(rng) % 5) + 1) * 3) | 0; // :817 — 3/6/9/12/15
  pLineAttack(actor, angle, MISSILERANGE, slope, damage); // :818
}

/* ------------------------------------------------------------------ */
/* A_SPosAttack — p_enemy.c:821-843 (action id 34)                       */
/* ------------------------------------------------------------------ */

/**
 * `A_SPosAttack(actor)` verbatim: sfx_shotgn BEFORE facing (:832-833 —
 * the shotguy's sound leads the face, unlike A_PosAttack), ONE shared
 * aim slope (:835), then THREE independent pellets (:837-841): each draws
 * jitter 2 + damage 1 ⇒ 9 draws total.
 */
export function aSPosAttack(actor: Mobj): void {
  if (!actor.target) return; // :830-831

  const rt = actor.rt;
  sfxSlot(rt.state.hooks, SFX_ID.sfx_shotgn, actor.x, actor.y, actor.z, rt.state.leveltime); // :832
  aFaceTarget(actor); // :833
  const bangle = actor.angle >>> 0; // :834
  const slope = pAimLineAttack(actor, bangle, MISSILERANGE); // :835

  const rng = rt.state.rng;
  for (let i = 0; i < 3; i++) {
    // :837-841 — angle = bangle + ((R−R)<<20); damage = ((R%5)+1)*3
    const angle = (bangle + (((pRandom(rng) - pRandom(rng)) << 20) | 0)) >>> 0;
    const damage = (((pRandom(rng) % 5) + 1) * 3) | 0;
    pLineAttack(actor, angle, MISSILERANGE, slope, damage);
  }
}

/* ------------------------------------------------------------------ */
/* A_CPosAttack / A_CPosRefire — p_enemy.c:845-863 / :865-880            */
/* (ids 51/52) — registered; FIXTURE-ONLY in Phase 1 (no doomednum 65/   */
/* 71 in E1, plan §0.12 + monster-census.test.ts)                        */
/* ------------------------------------------------------------------ */

/** `A_CPosAttack(actor)` verbatim: one A_SPosAttack-style pellet per tic
 * (the refire row keeps the chain alive). 3 draws. */
export function aCPosAttack(actor: Mobj): void {
  if (!actor.target) return; // :853-854

  const rt = actor.rt;
  sfxSlot(rt.state.hooks, SFX_ID.sfx_shotgn, actor.x, actor.y, actor.z, rt.state.leveltime); // :855
  aFaceTarget(actor); // :856
  const bangle = actor.angle >>> 0; // :857
  const slope = pAimLineAttack(actor, bangle, MISSILERANGE); // :858

  const rng = rt.state.rng;
  const angle = (bangle + (((pRandom(rng) - pRandom(rng)) << 20) | 0)) >>> 0; // :860
  const damage = (((pRandom(rng) % 5) + 1) * 3) | 0; // :861
  pLineAttack(actor, angle, MISSILERANGE, slope, damage); // :862
}

/**
 * `A_CPosRefire(actor)` verbatim: keep firing unless the target got out
 * of sight — face, the `P_Random() < 40` "keep firing, do nothing" gate,
 * else (dead target or lost sight) fall back to the SEESTATE.
 */
export function aCPosRefire(actor: Mobj): void {
  aFaceTarget(actor); // :867

  if (pRandom(actor.rt.state.rng) < 40) return; // :869-870

  if (
    !actor.target ||
    actor.target.health <= 0 ||
    !pCheckSight(actor.rt, actor, actor.target)
  ) {
    pSetMobjState(actor, mobjinfo[actor.type]!.seeState); // :872-878
  }
}

/* ------------------------------------------------------------------ */
/* A_TroopAttack — p_enemy.c:913-932 (action id 53)                      */
/* ------------------------------------------------------------------ */

/**
 * `A_TroopAttack(actor)` verbatim: face; in melee range ⇒ sfx_claw +
 * the (R%8+1)*3 claw (3..24) through P_DamageMobj with the exact
 * (target, actor, actor) triple; otherwise launch the MT_TROOPSHOT
 * fireball (:931 — the ONE missile type this body knows; MT_FIRE is NOT
 * it, see the header's MISSILE TYPE TRUTH note).
 */
export function aTroopAttack(actor: Mobj): void {
  if (!actor.target) return; // :919-920

  aFaceTarget(actor); // :921

  if (pCheckMeleeRange(actor)) {
    // :923-926
    const rt = actor.rt;
    sfxSlot(rt.state.hooks, SFX_ID.sfx_claw, actor.x, actor.y, actor.z, rt.state.leveltime); // :923
    const damage = (((pRandom(rt.state.rng) % 8) + 1) * 3) | 0; // :924 — 3..24
    pPlayerDamage(actor.target, actor, actor, damage); // :925 P_DamageMobj
    return; // :926
  }

  // launch a missile — MT_TROOPSHOT (p_enemy.c:931)
  pSpawnMissile(actor.rt, actor, actor.target, MT.MT_TROOPSHOT);
}

/* ------------------------------------------------------------------ */
/* Registration (pdeath.ts idiom — importing this module registers the    */
/* five Family A ids under the MOBJ domain; game.ts's enable stays the     */
/* M8-11 flip). The ctx casts are (mobj) — the weapon/psprite machine       */
/* can never reach them (a_actions.ts cross-domain guard).                  */
/* ------------------------------------------------------------------ */

export function registerFamilyAActions(): void {
  registerAction(ACT.A_PosAttack, (ctx) => aPosAttack(ctx as Mobj), 'mobj'); // id 32
  registerAction(ACT.A_SPosAttack, (ctx) => aSPosAttack(ctx as Mobj), 'mobj'); // id 34
  registerAction(ACT.A_CPosAttack, (ctx) => aCPosAttack(ctx as Mobj), 'mobj'); // id 51
  registerAction(ACT.A_CPosRefire, (ctx) => aCPosRefire(ctx as Mobj), 'mobj'); // id 52
  registerAction(ACT.A_TroopAttack, (ctx) => aTroopAttack(ctx as Mobj), 'mobj'); // id 53
}

registerFamilyAActions();
