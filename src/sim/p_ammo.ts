// sim/p_ammo.ts — M7-05: ammo economy + weapon switching + P_CheckAmmo.
//
// Owns (M7-plan §M7-05): the real P_CheckAmmo ladder (p_pspr.c:158-215)
// replacing p_pspr's local placeholder via the psprHooks seam, the
// BT_CHANGE weapon-switch block of P_PlayerThink (p_user.c:291-323), and
// the new-game / G_PlayerReborn weapon+ammo start init (g_game.c).
//
// P_GiveAmmo/GiveWeapon/GiveBody/GiveArmor live in p_inter_pickup.ts
// (M7-04 landed them); this module wires the economy they feed.
//
// SPDX-License-Identifier: GPL-2.0-or-later

export {}; // TODO(M7-05): implementation in progress
