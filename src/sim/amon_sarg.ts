// SPDX-License-Identifier: GPL-2.0-or-later
// sim/amon_sarg.ts — M8-08 Family B: Demon / Spectre / Lost Soul
// (linuxdoom-1.10 p_enemy.c bodies + the p_map.c PIT skullfly branch +
// the info.c S_SARG_ATK*/S_SKULL_ATK* rows). Mirror re-read THIS pass
// (62 .c files, M8-plan §0.0); the raw source is the arbiter.
//
// SCOPE (docs/design/M8-plan.md §M8-08 + §0.7, authoritative):
//   A_SargAttack   id 54  p_enemy.c:935-948  (SARG S_SARG_ATK3 row,
//                          info.c:623 `{SPR_SARG,6,8,{A_SargAttack},
//                          S_SARG_RUN1}` — MELEE ONLY: A_FaceTarget, then
//                          `if (P_CheckMeleeRange)` dmg ((R%10)+1)*4 =
//                          4..40 (ONE draw). NO attacksound here —
//                          sfx_sgtatk comes from A_Chase's melee branch
//                          (p_enemy.c:728-729), pinned in p_enemy.ts.)
//   A_SkullAttack  id 57  p_enemy.c:1419-1443 (SKULL S_SKULL_ATK2 row,
//                          info.c:726, 4 tics): attacksound, MF_SKULLFLY,
//                          A_FaceTarget, mom = FixedMul(SKULLSPEED =
//                          20*FRACUNIT, fine[cos|sin]), dist =
//                          P_AproxDistance/SKULLSPEED (clamped ≥1), momz
//                          = (dest.z + height/2 − z)/dist. NO draw of its
//                          own (A_FaceTarget's MF_SHADOW pair belongs to
//                          p_enemy.ts's ledger).)
//   skullFlyHit          p_map.c:274-287  (the PIT_CheckThing MF_SKULLFLY
//                          branch, wired through the M5-era
//                          `pmapHooks.skullFlyHit` slot — registered
//                          HERE, chain-preserving, ptelept.ts idiom):
//                          dmg = ((R%8)+1)*info->damage (MT_SKULL damage
//                          3 ⇒ 3..24), P_DamageMobj(thing, skull, skull),
//                          flag cleared, momentum zeroed, state ⇒
//                          spawnstate. ONE draw, ALWAYS.)
//
// ACTION-NAME TRUTH (the brief's open questions, resolved FROM SOURCE):
//  * The demon/spectre melee row's action is **A_SargAttack** (info.c:623).
//    It is NOT A_PainAttack — A_PainAttack (id 64, p_enemy.c:1512) belongs
//    to the PAIN ELEMENTAL (MT_PAIN, doomednum 71, info.c:1681, absent
//    from E1M1-E1M9 per the §0.12 census)
//    and is M9-scope (plan §3 "Deferred": A_PainAttack/A_PainShootSkull/
//    A_PainDie). Same for A_PainDie (id 65, p_enemy.c:1522).
//  * There is NO "A_LostSoulAttack" / A_Skullflight action in 1.10
//    (`grep -n '^void A_' p_enemy.c` — the whole contact-damage half lives
//    in PIT_CheckThing, p_map.c:276, NOT in a state action; MT_SKULL's
//    meleestate is 0 (info.c:1587), so `P_CheckMeleeRange` is never the
//    lost soul's path — its attack is the MISSILE state S_SKULL_ATK1
//    (info.c:1588) which A_Chase enters through P_CheckMissileRange).
//  * `MF_HITTRIGGER` does not exist in 1.10 (`grep MF_HITTRIGGER *.c *.h`
//    = 0 hits) — pinned absent, nothing to implement.
//  * The skull's contact damage multiplies `info->damage` = 3 (info.c:1596
//    mobjinfo MT_SKULL `3, // damage`), i.e. 3..24, and the SAME dice
//    expression is the MF_MISSILE branch's (p_map.c:323-324) — same draw
//    shape, different `info->damage`.
//  * Spectre = MT_SHADOWS (doomednum 58) = the SARG state rows +
//    MF_SHADOW (info.c:1468) — ZERO action diff; the fuzz draw is a
// RENDERER concern (r_things.c:577-580 sets `vis->colormap = NULL` for
//    MF_SHADOW, then R_DrawVisSprite runs R_DrawFuzzColumn), reported as
//    a gap, NOT faked here. Truth found by reading src/render/vissprites
//    .ts: its light block treats the fuzz branch as dead for the M4
//    static roster, so `pColormap` never goes negative and the
//    `drawFuzzColumnUnused()` stub at :516-518 is UNREACHABLE ⇒ a live
//    spectre/lost soul draws FULLY OPAQUE at normal light, silently.
//    The fuzz PRIMITIVE is already exact in framebuffer.ts
//    (`drawFuzzColumn` + `fuzzoffset` + the `fuzzState.pos` global,
//    r_draw.c:285), so only the wiring + a per-frame `resetFuzzState()`
//    are missing. 1.10 has NO translucency anywhere (framebuffer.ts grep
//    pin: translucen/M_TRANMAP/blend = 0 hits) — the spectre is FUZZ,
//    never an alpha blend.
//
// SKULLFLY × MOVEMENT (M8-02 landed in pmove.ts; consumed, never edited)
//  * no friction while flying: `if (flags & (MF_MISSILE|MF_SKULLFLY))
//    return;` — pmove.ts:277 = p_mobj.c:201-202, so momx/momy ride the
//    whole flight at exactly FixedMul(SKULLSPEED, fine*).
//  * z-bounce: BOTH clips flip momz for a flying soul — floor
//    pmove.ts:354 = p_mobj.c:291-294, ceiling pmove.ts:386 =
//    p_mobj.c:337-340 — the lost soul's endless hop.
//  * MF_NOGRAVITY (info.c:1598) keeps momz constant between hits:
//    gravity lives in the `else if (!(flags & MF_NOGRAVITY))` branch,
//    p_mobj.c:320-326 — so the arc never decays.
//  * the MF_FLOAT target-hover block is SKIPPED while flying (the
//    `!(flags & MF_SKULLFLY)` guard on the float branch, p_mobj.c:263 +
//    pmove.ts:343) ⇒ the straight-line charge wins over the smoothing.
//  * if momentum reaches zero with the flag still set (a blocked move
//    with nothing to hit), the `!momx && !momy` branch clears it and
//    resets the state WITHOUT damaging (pmove.ts:209-215 = p_mobj.c:
//    122-128) — and because THIS module's slam already cleared the flag
//    and zeroed the momenta, that branch stays at
//    `pmoveHookCounts.setMobjStateSpawn === 0`: no double spawnstate (the
//    lost soul's spawnstate 585 has its own A_Look, so the circling
//    resumes through the state machine).

import { ANGLETOFINESHIFT, FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import { mobjinfo } from '../wad/info/mobjinfo';

import { ACT, registerAction } from './a_actions';
import { aFaceTarget, pCheckMeleeRange } from './p_enemy';
import { sfxSlot } from './hooks';
import { pmapHooks, type Mover } from './pmap';
import { pAproxDistance } from './pmaputl';
import { asMobj, pSetMobjFlags, pSetMobjState, type Mobj } from './p_mobj';
import { pRandom } from './prng';
import { resolveSfxId } from './psound_stub';
import { pPlayerDamage } from './pplayer';
import { MF_SKULLFLY } from './thinglinks';
import type { MoveMobj } from './pmove';

/** p_enemy.c:1417 `#define SKULLSPEED (20*FRACUNIT)`. */
export const SKULLSPEED = 20 * FRACUNIT;

/* ------------------------------------------------------------------ */
/* A_SargAttack — p_enemy.c:935-948 (action id 54)                      */
/* ------------------------------------------------------------------ */

/**
 * `A_SargAttack(actor)` verbatim: bail without a target (:939),
 * `A_FaceTarget` (:942 — the MF_SHADOW jitter pair belongs to
 * p_enemy.ts), and ONLY inside the `P_CheckMeleeRange` gate (:943) the
 * single draw `((P_Random()%10)+1)*4` (4..40) into
 * `P_DamageMobj(target, actor, actor, d)` (:945-946). There is NO missile
 * branch and NO sound here — MT_SERGEANT/MT_SHADOWS have
 * `missilestate = 0` (info.c:1432/1458), so out of melee range A_Chase
 * simply chases (`P_CheckMissileRange` never runs for them: no missile
 * state at p_enemy.c:736-748).
 */
export function aSargAttack(actor: Mobj): void {
  if (!actor.target) return; // :939 (`if (!actor->target) return;` — nothing else)

  aFaceTarget(actor); // :942

  if (pCheckMeleeRange(actor)) {
    // :945 — one draw, 4..40. (`%` on the raw table byte, exactly `P_Random()%10`.)
    const damage = (((pRandom(actor.rt.state.rng) % 10) + 1) * 4) | 0;
    pPlayerDamage(actor.target, actor, actor, damage); // :946
  }
}

/* ------------------------------------------------------------------ */
/* A_SkullAttack — p_enemy.c:1419-1443 (action id 57)                   */
/* ------------------------------------------------------------------ */

/**
 * `A_SkullAttack(actor)` verbatim: bail without a target (:1425),
 * `flags |= MF_SKULLFLY` (:1427 — through `pSetMobjFlags` so the ThingLinks
 * mirror PIT reads stays true), `S_StartSound(actor, attacksound)` (:1429,
 * sfx_sklatk; sound id 0 ⇒ S_StartSound's own `if (!sound_id) return`),
 * `A_FaceTarget` (:1431), then the momentum:
 * `FixedMul(SKULLSPEED, finecosine/finesine[angle>>ANGLETOFINESHIFT])`
 * (:1433-1434) and `momz = (dest->z + (dest->height>>1) − z) / dist`
 * with `dist = P_AproxDistance/SKULLSPEED` clamped to ≥1 (:1436-1441) —
 * plain int32 fixed/int division, C-truncated toward zero (Math.trunc).
 * NO PRNG draw of its own.
 *
 * STATE INTERPLAY (the brief's "target lock A_Look/A_Chase interplay"):
 * this row is MT_SKULL's MISSILE state (info.c:1588), entered by A_Chase
 * through P_CheckMissileRange (which has the live `MT_SKULL ⇒ dist >>= 1`
 * tweak, p_enemy.c:239-245 ⇒ lost souls fire at close range). ATK2 is 4
 * tics and its nextstate is ATK3→ATK4↺ (info.c:727-728, `NULL` actions)
 * — the skull keeps flying (momx/momy constant, no friction, z-bounce)
 * until a slam lands, and it NEVER re-enters A_Chase/A_Look in between;
 * only the slam (or death) breaks the loop.
 */
export function aSkullAttack(actor: Mobj): void {
  if (!actor.target) return; // :1425
  const dest = actor.target; // :1427 `dest = actor->target;`

  pSetMobjFlags(actor, actor.flags | MF_SKULLFLY); // :1428

  const atk = mobjinfo[actor.type]!.attackSound; // :1429
  if (atk !== '0' && atk !== 'sfx_None') {
    sfxSlot(
      actor.rt.state.hooks,
      resolveSfxId(atk),
      actor.x,
      actor.y,
      actor.z,
      actor.rt.state.leveltime,
    );
  }

  aFaceTarget(actor); // :1431

  const an = actor.angle >>> ANGLETOFINESHIFT; // :1432
  actor.momx = FixedMul(SKULLSPEED, finecosine[an]!); // :1433
  actor.momy = FixedMul(SKULLSPEED, finesine[an]!); // :1434

  let dist = Math.trunc(
    pAproxDistance((dest.x - actor.x) | 0, (dest.y - actor.y) | 0) / SKULLSPEED,
  ); // :1436-1437 (fixed / fixed ⇒ plain tic count)
  if (dist < 1) dist = 1; // :1439

  const dz = ((dest.z + (dest.height >> 1)) | 0) - actor.z; // :1441 numerator
  actor.momz = Math.trunc(dz / dist) | 0; // :1441 (C `/` truncates toward zero)
}

/* ------------------------------------------------------------------ */
/* The MF_SKULLFLY slam — p_map.c:274-287 (pmapHooks.skullFlyHit)       */
/* ------------------------------------------------------------------ */

/**
 * `PIT_CheckThing`'s skullfly branch, verbatim: ONE draw
 * `((P_Random()%8)+1)*tmthing->info->damage` (MT_SKULL damage 3 ⇒ 3..24)
 * taken UNCONDITIONALLY (even when the victim does not resolve — vanilla
 * always has a `thing`), `P_DamageMobj(thing, tmthing, tmthing, damage)`
 * (both inflictor and source are the SKULL — so a slam on a monster IS
 * the §0.8 infighting trigger: `target->target = skull`,
 * `threshold = BASETHRESHOLD`), then MF_SKULLFLY cleared, momentum zeroed
 * and `P_SetMobjState(tmthing, spawnstate)` (:281-285) — the "return to
 * idle circling" half; pmap.ts already returns false ("stop moving").
 *
 * The MF_SKULLFLY live-read guard at the top mirrors p_map.c:276 (see the
 * FINDING note in the header): the flag is read live in vanilla, so a
 * second thing in the same cell never re-slams.
 */
export function skullFlyHit(slot: number, attacker: Mover): void {
  const skull = asMobj(attacker as unknown as MoveMobj);
  if (!skull || skull.removed) return; // counted no-op (pmissiles idiom)

  if ((skull.flags & MF_SKULLFLY) === 0) return; // p_map.c:276 live read

  const damage =
    (((pRandom(skull.rt.state.rng) % 8) + 1) * mobjinfo[skull.type]!.damage) | 0; // :278

  const victim = skull.rt.slotMobjs.get(slot); // the `thing` argument
  if (victim && !victim.removed) pPlayerDamage(victim, skull, skull, damage); // :280

  pSetMobjFlags(skull, skull.flags & ~MF_SKULLFLY); // :282
  skull.momx = 0; // :283
  skull.momy = 0;
  skull.momz = 0;
  pSetMobjState(skull, mobjinfo[skull.type]!.spawnState); // :284
}

/* ------------------------------------------------------------------ */
/* Registration (self-import idiom — pdeath.ts/p_enemy.ts pattern)      */
/* ------------------------------------------------------------------ */

/**
 * Bind ids 54/57 and the skullfly PIT slot. `A_Scream` is NOT registered
 * here — it belongs to M8-06 (pdeath.ts) and the family's death chains
 * consume that registration (the lost soul's DIE2 row is `A_Scream` with
 * deathsound `sfx_firxpl`, pdeath.test.ts table row MT_SKULL).
 * The skullfly slot CHAINS any previous occupant (ptelept.ts idiom) so a
 * test-local recorder installed earlier still sees the visit; importing
 * this module registers, `game.ts`'s production flip stays M8-11's.
 */
export function registerFamilyBActions(): void {
  registerAction(ACT.A_SargAttack, (ctx) => aSargAttack(ctx as Mobj));
  registerAction(ACT.A_SkullAttack, (ctx) => aSkullAttack(ctx as Mobj));

  const prior = pmapHooks.skullFlyHit;
  pmapHooks.skullFlyHit = (slot: number, attacker: Mover): void => {
    prior?.(slot, attacker);
    skullFlyHit(slot, attacker);
  };
}

registerFamilyBActions();
