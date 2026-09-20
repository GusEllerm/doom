// sim/p_enemy.ts — M8-04 AI core: the monster brain (linuxdoom-1.10
// p_enemy.c, sha fea20b31a98061abe6dae84ed11116daff7fbd51, 2008 lines;
// mirror verified 62 .c files, M8-plan §0.0).
//
// SCOPE (M8-plan §M8-04 + §0.2–0.5): the functions this task owns, VERBATIM
// with line cites into the pinned mirror:
//   P_RecursiveSound   p_enemy.c:106   (sector sound flood)
//   P_NoiseAlert       p_enemy.c:159   (single call site: p_pspr.c:256
//                          P_FireWeapon → psprHooks.noiseAlert, wired here)
//   P_CheckMeleeRange  p_enemy.c:174
//   P_CheckMissileRange p_enemy.c:197
//   P_Move             p_enemy.c:272   (+ xspeed/yspeed LUT :264 —
//                          raw-int speed × fixed LUT, Math.imul, NOT FixedMul:
//                          info.c stores speed as a RAW int, §0.5 pin)
//   P_TryWalk          p_enemy.c:349   (movecount = P_Random()&15 on success)
//   P_NewChaseDir      p_enemy.c:363   (opposite[] :70 / diags[] :77; swap
//                          draw ALWAYS taken; search-direction draw :448)
//   P_LookForPlayers   p_enemy.c:499   (lastlook ring (lastlook-1)&3 stop,
//                          c++==2 bail, 180° gate w/ MELEERANGE override;
//                          the `sector` local is DEAD in 1.10)
//   A_Look             p_enemy.c:604   (threshold=0 every tic; soundtarget
//                          MF_SHOOTABLE + MF_AMBUSH sight-only rule; seesound
//                          posit%3 / bgsit%2 draws; SPIDER/CYBORG full volume)
//   A_Chase            p_enemy.c:672   (exact 10-step order per §0.4;
//                          MF_JUSTATTACKED 0x80 — the brief's "JUSTATTACK"
//                          does not exist; movecount missile gate; netgame
//                          retarget; activesound P_Random()<3)
//   A_FaceTarget       p_enemy.c:782   (clears MF_AMBUSH; MF_SHADOW target
//                          ⇒ 2 draws (P_Random()-P_Random())<<21)
//
// PRNG ledger additions this file will carry (random-sites.ts, SAME commit
// as the call sites per §0.13): TryWalk 1, NewChaseDir swap 1 + search 1,
// A_Look seesound 2, A_Chase activesound 1, A_FaceTarget shadow 2,
// P_CheckMissileRange 1 → 9 pRandom( occurrences.
// SFX ledger (psound_stub SFX_SITE_LEDGER): A_Look 2 (NULL-full-vol +
// actor), A_Chase attacksound 1, activesound 1 → 4 sfxSlot( occurrences.
//
// Deviations / pins to resolve during implementation:
//  - fastparm: no d_main source in the port (single-player, no params) ⇒
//    constant false, documented at each A_Chase gate.
//  - netgame: rt.netgame (false everywhere pre-M9).
//  - P_NoiseAlert wiring: wired HERE (p_enemy.c function per owns), the
//    plan §0.13 line assigning the psprHooks.noiseAlert BODY to M8-05 is
//    superseded — the body IS a p_enemy.c function; M8-05 keeps the
//    damageBridge/p_kill side.
//  - spechit monster-use (P_Move door opening): pTryMove leaves tm.numspechit
//    set on a failed move; P_Move walks it DESCENDING (while(numspechit--))
//    calling pUseSpecialLine(actor, ld, 0) — monster gates already live in
//    pspec.ts's USE table (monsterUseOk, ML_SECRET veto), M6-03.
//  - goldens: idle monsters stay frozen unless soundtarget/sight wakes them
//    (existing E1M1 fixtures must not start draws — verified at gate time).
//
// SPDX-License-Identifier: GPL-2.0-or-later

export {}; // placeholder — functions land in incremental commits (salvage protocol)
