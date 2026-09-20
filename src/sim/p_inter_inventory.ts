// sim/p_inter_inventory.ts — d_player.h inventory fields for the pickup
// layer (M7-04). Follows the p_pspr.ts (M7-07) precedent: Player (owned by
// player.ts; field init owned by M7-03's createPlayer/G_PlayerReborn) does
// not carry the inventory fields yet, so the pickup code narrows through an
// INTERSECTION type + an idempotent attach helper. Declaration merging was
// tried first and rejected: it forces the fields onto every Player literal
// (player.ts createPlayer) and collides with p_pspr's PsprFields types
// (weaponowned Uint8Array vs Int32Array ⇒ `never` intersections in
// p_pspr/puser/psectorspecial).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Player } from './player';
import { NUMAMMO, NUMWEAPONS } from '../wad/info/weaponinfo';
import { NUMPOWERS } from './p_pspr';

/** d_player.h player_t inventory slice (the fields p_inter.c reads/writes).
 * Field names/types match PsprFields (p_pspr.ts) where they overlap, so
 * `PickupPlayer & PsprPlayer` stays well-typed for the M7-05/M7-07 bridge. */
export interface InventoryFields {
  /** d_player.h: int ammo[NUMAMMO], maxammo[NUMAMMO] */
  ammo: Int32Array;
  maxammo: Int32Array;
  /** d_player.h: boolean weaponowned[NUMWEAPONS] (Int32Array per PsprFields) */
  weaponowned: Int32Array;
  /** d_player.h: weapontype_t readyweapon, pendingweapon */
  readyweapon: number;
  pendingweapon: number;
  /** d_player.h: int powers[NUMPOWERS] */
  powers: Int32Array;
  /** d_player.h: int armorpoints, armortype */
  armorpoints: number;
  armortype: number;
  /** d_player.h: boolean backpack */
  backpack: boolean;
  /** d_player.h: int bonuscount, itemcount, secretcount, killcount (M9 HUD
   * stat counters land here; intermission consumes them) */
  bonuscount: number;
  itemcount: number;
  secretcount: number;
  killcount: number;
  /** d_player.h: boolean attackdown; int refire */
  attackdown: boolean;
  refire: number;
  /** d_player.h: int extralight, fixedcolormap */
  extralight: number;
  fixedcolormap: number;
  /** d_player.h: player_t* attacker */
  attacker: Player | null;
}

/** Player + inventory fields — the shape every P_Give* / P_TouchSpecialThing
 * entry point takes. */
export type PickupPlayer = Player & InventoryFields;

/**
 * In-place field attach (guarded/idempotent, mirroring
 * p_pspr.attachPsprFields). Defaults are bare-struct zeros + fists-only.
 * The CANONICAL spawn init is G_PlayerReborn (M7-03 createPlayer: fists +
 * pistol + 50 clips — R08 §10); this attach exists so the pickup code is
 * crash-safe the moment a touch can happen, and DEFERS (the guard) once
 * M7-03/attachPsprFields initialize the fields themselves.
 */
export function initPlayerInventory(p: Player): PickupPlayer {
  const q = p as unknown as PickupPlayer;
  if (q.ammo !== undefined) return q; // M7-03 init already ran — defer
  q.ammo = new Int32Array(NUMAMMO);
  q.maxammo = new Int32Array([200, 50, 300, 50]); // clip, shell, cell, misl (p_inter.c:33)
  q.weaponowned = new Int32Array(NUMWEAPONS);
  q.weaponowned[0] = 1; // fist always owned
  q.readyweapon = 0; // wp_fist
  q.pendingweapon = 0; // wp_fist
  q.powers = new Int32Array(NUMPOWERS);
  q.armorpoints = 0;
  q.armortype = 0;
  q.backpack = false;
  q.bonuscount = 0;
  q.itemcount = 0;
  q.secretcount = 0;
  q.killcount = 0;
  q.attackdown = false;
  q.refire = 0;
  q.extralight = 0;
  q.fixedcolormap = 0;
  q.attacker = null;
  return q;
}
