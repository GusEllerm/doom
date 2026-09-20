// sim/pplayer.ts — M7-03: player mobj states, pain/death flow, reborn.
//
// Sources (verbatim targets):
//   p_mobj.c  P_SpawnPlayer (:642-703) — real MT_PLAYER mobj via P_SpawnMobj,
//             player/mobj link, PST_REBORN -> G_PlayerReborn branch.
//   p_mobj.c  P_MobjThinker player mobj (M7-02 arena; state/tics machine).
//   p_user.c  P_DeathThink (:180-232) — deathcam: viewheight sink, attacker
//             turn-to-killer (ANG5), damagecount fade, BT_USE -> PST_REBORN.
//   p_inter.c P_KillMobj (:668-764) PLAYER branch — MF_SOLID off, PST_DEAD,
//             P_DropWeapon hook (M7-04), XDIE vs DIE by health threshold.
//   p_inter.c P_DamageMobj (:775-947) PLAYER pain half — godmode gate,
//             pain-chance P_Random() < 255 draw, MF_JUSTHIT, S_PLAY_PAIN.
//   g_game.c  G_PlayerReborn (:800-831) — the respawn clears list.
//   p_enemy.c A_Pain / A_PlayerScream / A_Fall / A_XScream (player death
//             chain actions; sfx via the M7-06 seam until it exists).
//
// Ownership: plan §M7-03 — this file + player-side A_* fills only.
// p_inter.ts (P_DamageMobj body, P_DropWeapon, armor, pickups) is M7-04.
//
// SPDX-License-Identifier: GPL-2.0-or-later

export const M7_03_STUB = true;
