// sim/pdeath.ts — M8-06 pain/death/corpse action layer (M8-plan §M8-06).
//
// Registers the four remaining E1-required action ids with their exact
// vanilla bodies from p_enemy.c (mirror verified this pass):
//   A_Pain    (id 25, p_enemy.c:1577-1581) — S_StartSound(actor,
//             info->painsound) when nonzero. NO PRNG draw.
//   A_Scream  (id 33, p_enemy.c:1535-1569) — the deathsound family switch
//             over the CONSECUTIVE sounds.h ids: podth1..3 (59..61) ⇒
//             sfx_podth1 + P_Random()%3 (:1544-1548), bgdth1..2 (62..63) ⇒
//             sfx_bgdth1 + P_Random()%2 (:1550-1552), default = the plain
//             deathsound (:1554-1556), `case 0` returns silently (:1540);
//             then the boss full-volume form S_StartSound(NULL, sound) for
//             MT_SPIDER/MT_CYBORG (:1561-1567) vs. the actor-origin emit.
//   A_XScream (id 28, p_enemy.c:1572-1575) — S_StartSound(actor, sfx_slop).
//   A_Fall    (id 27, p_enemy.c:1585-1591) — flags &= ~MF_SOLID; "actor is
//             on ground, it can be walked over". NO PRNG draw.
//
// SHRINK TRUTH (plan §M8-06 asks WHO shrinks the corpse): the M8-05 core.
// P_KillMobj's body (p_inter.c:668; corpse block p_inter.c:676-681 —
// `flags |= MF_CORPSE|MF_DROPOFF; height >>= 2;`) runs the flag/height
// bookkeeping BEFORE P_SetMobjState(deathstate) (:721/:725), i.e. at kill
// time — implemented in p_inter_damage.ts pKillMobj (its :116-120). This
// module's actions NEVER touch height: A_Scream/A_XScream are sound-only
// and A_Fall ONLY clears MF_SOLID (vanilla has no other corpse writer).
// Consequence pinned in pdeath.test.ts: between kill and the A_Fall state
// row the corpse is MF_CORPSE|MF_SOLID with height/4 — still SOLID-blocked
// to movement, exactly like the source.
//
// The MF_SOLID clear goes through p_mobj.writeFlags (pSetMobjFlags): the
// line-attack/blockmap traverse reads the ThingLinks mirror (pmap.ts:331,
// M8-05 audit lesson), so a raw field write would keep blocking shots AND
// movement from the mirror's side.
//
// SFX ledger (psound_stub SFX_SITE_LEDGER): A_Pain 1 + A_Scream 2 (NULL
// full-volume + origin) + A_XScream 1 = 4 hook emits. PRNG ledger
// (random-sites RANDOM_SITE_CALLS): A_Scream's two variant selects = 2
// occurrences (0 draws in A_Pain/A_XScream/A_Fall — pinned behaviourally).
//
// Zone rules (A-06): sim zone, imports sim + wad tables only.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { mobjinfo, MT } from '../wad/info/mobjinfo';
import { MF_SOLID } from './thinglinks';
import { ACT, registerAction } from './a_actions';
import { pSetMobjFlags, type Mobj } from './p_mobj';
import { pRandom } from './prng';
import { sfxSlot } from './hooks';
import { resolveSfxId, SFX_ID } from './psound_stub';

/* ------------------------------------------------------------------ */
/* A_Pain — p_enemy.c:1577-1581 (action id 25)                          */
/* ------------------------------------------------------------------ */

/**
 * `A_Pain(actor)`: `if (actor->info->painsound) S_StartSound(actor,
 * painsound)` — the ONLY pain sound in 1.10 (P_DamageMobj itself emits
 * nothing; psound_stub header note). No PRNG. Player mobjs share the body
 * via MT_PLAYER.painSound = sfx_plpain (25).
 */
export function aPain(actor: Mobj): void {
  const token = mobjinfo[actor.type]!.painSound; // :1579
  if (token === '0' || token === 'sfx_None') return; // :1578 if (painsound)
  const rt = actor.rt;
  sfxSlot(rt.state.hooks, resolveSfxId(token), actor.x, actor.y, actor.z, rt.state.leveltime);
}

/* ------------------------------------------------------------------ */
/* A_Scream — p_enemy.c:1535-1569 (action id 33)                        */
/* ------------------------------------------------------------------ */

/**
 * `A_Scream(actor)`: the deathsound switch (:1540-1557) over the source's
 * CONSECUTIVE enum ids, then the boss volume split (:1560-1567). The
 * variant select draws happen ONLY in the matching family branch (the
 * default row draws NOTHING) — stream order pinned in the test.
 */
export function aScream(actor: Mobj): void {
  const rt = actor.rt;
  const sound0 = resolveSfxId(mobjinfo[actor.type]!.deathSound); // :1539
  if (sound0 === 0) return; // :1540 case 0: return
  let sound = sound0; // :1554-1556 default: sound = info->deathsound
  if (
    sound0 === SFX_ID.sfx_podth1 ||
    sound0 === SFX_ID.sfx_podth2 ||
    sound0 === SFX_ID.sfx_podth3
  ) {
    sound = (SFX_ID.sfx_podth1 + (pRandom(rt.state.rng) % 3)) | 0; // :1547
  } else if (sound0 === SFX_ID.sfx_bgdth1 || sound0 === SFX_ID.sfx_bgdth2) {
    sound = SFX_ID.sfx_bgdth1 + (pRandom(rt.state.rng) % 2); // :1551
  }
  if (actor.type === MT.MT_SPIDER || actor.type === MT.MT_CYBORG) {
    sfxSlot(rt.state.hooks, sound, 0, 0, 0, rt.state.leveltime); // :1561-1565 full volume
  } else {
    sfxSlot(rt.state.hooks, sound, actor.x, actor.y, actor.z, rt.state.leveltime); // :1567
  }
}

/* ------------------------------------------------------------------ */
/* A_XScream — p_enemy.c:1572-1575 (action id 28)                       */
/* ------------------------------------------------------------------ */

/** `A_XScream(actor)`: the gib sound, unconditional, actor-origin. */
export function aXScream(actor: Mobj): void {
  const rt = actor.rt;
  sfxSlot(rt.state.hooks, SFX_ID.sfx_slop, actor.x, actor.y, actor.z, rt.state.leveltime); // :1574
}

/* ------------------------------------------------------------------ */
/* A_Fall — p_enemy.c:1585-1591 (action id 27)                          */
/* ------------------------------------------------------------------ */

/**
 * `A_Fall(actor)`: "actor is on ground, it can be walked over" — the ONLY
 * write is the MF_SOLID clear (through the ThingLinks mirror; the corpse
 * stays MF_CORPSE|MF_DROPOFF, keeps height/4, and is never removed until
 * the S_NULL row). No PRNG, no sound — a silent row.
 */
export function aFall(actor: Mobj): void {
  pSetMobjFlags(actor, actor.flags & ~MF_SOLID); // :1588
}

/* ------------------------------------------------------------------ */
/* Registration (p_enemy.ts idiom — importing this module registers the
/* four action ids; game.ts enable stays a later-task decision)          */
/* ------------------------------------------------------------------ */

export function registerDeathActions(): void {
  // M8-07 id27 domain fix: bodies cast ctx to Mobj, so they register under
  // the MOBJ domain — the weapon/psprite machine can never execute them
  // (cross-domain guard in a_actions.resolve; the id-27 weapon-side slot
  // keeps its own identity, which vanilla never dispatches: pspr-reachable
  // rows use ids 1..22 only).
  registerAction(ACT.A_Pain, (ctx) => aPain(ctx as Mobj), 'mobj');
  registerAction(ACT.A_Scream, (ctx) => aScream(ctx as Mobj), 'mobj');
  registerAction(ACT.A_XScream, (ctx) => aXScream(ctx as Mobj), 'mobj');
  registerAction(ACT.A_Fall, (ctx) => aFall(ctx as Mobj), 'mobj');
}

registerDeathActions();
