// sim/p_inter_inventory.ts — additive inventory fields for Player (M7-04/M7-03 seam).
// Declaration merging adds the d_player.h inventory fields to the Player interface
// owned by M7-03 (pplayer.ts / player.ts). M7-03's createPlayer() initializes them.
// This module provides only the TypeScript surface; runtime initialization lives in M7-03.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Player } from './player';
import { NUMAMMO, NUMWEAPONS, NUMCARDS } from '../wad/info/weaponinfo';
import { NUMPOWERS } from './p_inter_pickup';

declare module './player' {
  interface Player {
    // Ammo / max ammo (d_player.h: int ammo[NUMAMMO], maxammo[NUMAMMO])
    ammo: Int32Array;
    maxammo: Int32Array;

    // Weapon ownership (d_player.h: boolean weaponowned[NUMWEAPONS])
    weaponowned: Uint8Array;

    // Ready / pending weapon (d_player.h: weapontype_t readyweapon, pendingweapon)
    readyweapon: number;
    pendingweapon: number;

    // Powerup timers (d_player.h: int powers[NUMPOWERS])
    powers: Int32Array;

    // Armor (d_player.h: int armorpoints, armortype)
    armorpoints: number;
    armortype: number;

    // Backpack flag (d_player.h: boolean backpack)
    backpack: boolean;

    // Bonus / count fields (d_player.h: int bonuscount, itemcount, secretcount, killcount)
    bonuscount: number;
    itemcount: number;
    secretcount: number;
    killcount: number;

    // Attack/refire state (d_player.h: boolean attackdown; int refire)
    attackdown: boolean;
    refire: number;

    // Render effects (d_player.h: int extralight, fixedcolormap)
    extralight: number;
    fixedcolormap: number;

    // Attacker reference (d_player.h: player_t* attacker)
    attacker: Player | null;
  }
}

// Runtime initialization helper — called by M7-03 createPlayer().
// Kept here so the field list stays in one place.
export function initPlayerInventory(p: Player): void {
  p.ammo = new Int32Array(NUMAMMO);
  p.maxammo = new Int32Array([200, 50, 300, 50]); // clip, shell, cell, misl
  p.weaponowned = new Uint8Array(NUMWEAPONS);
  p.weaponowned[0] = 1; // fist always owned
  p.readyweapon = 0; // wp_fist
  p.pendingweapon = 0; // wp_fist
  p.powers = new Int32Array(NUMPOWERS);
  p.armorpoints = 0;
  p.armortype = 0;
  p.backpack = false;
  p.bonuscount = 0;
  p.itemcount = 0;
  p.secretcount = 0;
  p.killcount = 0;
  p.attackdown = false;
  p.refire = 0;
  p.extralight = 0;
  p.fixedcolormap = 0;
  p.attacker = null;
}