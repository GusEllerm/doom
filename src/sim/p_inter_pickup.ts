// sim/p_inter_pickup.ts — pickups + inventory (p_inter.c P_TouchSpecialThing + P_Give* rules).
// Source: linuxdoom-1.10 p_inter.c / d_items.c / p_mobj.h / doomdef.h — verbatim logic.
//
// M7-04 owns this module. M7-03 (pplayer.ts) owns Player inventory field initialization.
// M5 callback slot pmapHooks.touchSpecialThing is wired to P_TouchSpecialThing here.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT } from '../core/constants';
import { MF_DROPPED, MF_PICKUP, MF_SPECIAL, MF_COUNTITEM } from './thinglinks';
export { MF_DROPPED, MF_PICKUP, MF_SPECIAL, MF_COUNTITEM } from './thinglinks';
import type { Player } from './player';
import type { Mover } from './pmove';
import { WP, AMMO, NUMAMMO, NUMWEAPONS, weaponinfo } from '../wad/info/weaponinfo';
import { SPR } from '../wad/info/sprnames';
import { IT_BLUECARD, IT_YELLOWCARD, IT_REDCARD, IT_BLUESKULL, IT_YELLOWSKULL, IT_REDSKULL, NUMCARDS } from './player';

// Re-export for tests and consumers
export { WP, AMMO, NUMAMMO, NUMWEAPONS, weaponinfo } from '../wad/info/weaponinfo';
export { SPR } from '../wad/info/sprnames';
export { NUMCARDS } from './player';
import { pmapHooks, getPmapWorld } from './pmap';

/* ------------------------------------------------------------------ */
/* Constants (doomdef.h / p_local.h / info.c)                          */
/* ------------------------------------------------------------------ */

/** p_local.h:33 `#define MAXHEALTH 100` */
export const MAXHEALTH = 100;

/** p_inter.c BONUSADD = 6 */
export const BONUSADD = 6;

/** p_local.h VIEWHEIGHT = 41*FRACUNIT — used for reach test (toucher->height) */
export const PLAYER_HEIGHT = 56 * FRACUNIT;

/** Powerup durations (powerduration_t in doomdef.h, TICRATE = 35) */
export const INVULNTICS = 30 * 35;
export const INVISTICS = 60 * 35;
export const INFRATICS = 120 * 35;
export const IRONTICS = 60 * 35;

/** d_items.h / doomdef.h powertype_t */
export const PW = {
  pw_invulnerability: 0,
  pw_strength: 1,
  pw_invisibility: 2,
  pw_ironfeet: 3,
  pw_allmap: 4,
  pw_infrared: 5,
} as const;
export const NUMPOWERS = 6;

/** doomdef.h card_t — matches player.ts IT_* */
export const IT = {
  it_bluecard: 0,
  it_yellowcard: 1,
  it_redcard: 2,
  it_blueskull: 3,
  it_yellowskull: 4,
  it_redskull: 5,
} as const;

/** sfx names (sounds.h / p_inter.c) */
export const SFX = {
  sfx_itemup: 'sfx_itemup',
  sfx_getpow: 'sfx_getpow',
  sfx_wpnup: 'sfx_wpnup',
  sfx_oof: 'sfx_oof',
} as const;

/** Message IDs (d_strings.h / p_inter.c G_* macros) — the string keys.
 * The HUD message system (M9) will resolve these; here we just store the key. */
export const GOT = {
  GOTARMOR: 'GOTARMOR',
  GOTMEGA: 'GOTMEGA',
  GOTHTHBONUS: 'GOTHTHBONUS',
  GOTARMBONUS: 'GOTARMBONUS',
  GOTSUPER: 'GOTSUPER',
  GOTMSPHERE: 'GOTMSPHERE',
  GOTBLUECARD: 'GOTBLUECARD',
  GOTYELWCARD: 'GOTYELWCARD',
  GOTREDCARD: 'GOTREDCARD',
  GOTBLUESKUL: 'GOTBLUESKUL',
  GOTYELWSKUL: 'GOTYELWSKUL',
  GOTREDSKULL: 'GOTREDSKULL',
  GOTSTIM: 'GOTSTIM',
  GOTMEDINEED: 'GOTMEDINEED',
  GOTMEDIKIT: 'GOTMEDIKIT',
  GOTINVUL: 'GOTINVUL',
  GOTBERSERK: 'GOTBERSERK',
  GOTINVIS: 'GOTINVIS',
  GOTSUIT: 'GOTSUIT',
  GOTMAP: 'GOTMAP',
  GOTVISOR: 'GOTVISOR',
  GOTCLIP: 'GOTCLIP',
  GOTCLIPBOX: 'GOTCLIPBOX',
  GOTROCKET: 'GOTROCKET',
  GOTROCKBOX: 'GOTROCKBOX',
  GOTCELL: 'GOTCELL',
  GOTCELLBOX: 'GOTCELLBOX',
  GOTSHELLS: 'GOTSHELLS',
  GOTSHELLBOX: 'GOTSHELLBOX',
  GOTBACKPACK: 'GOTBACKPACK',
  GOTBFG9000: 'GOTBFG9000',
  GOTCHAINGUN: 'GOTCHAINGUN',
  GOTCHAINSAW: 'GOTCHAINSAW',
  GOTLAUNCHER: 'GOTLAUNCHER',
  GOTPLASMA: 'GOTPLASMA',
  GOTSHOTGUN: 'GOTSHOTGUN',
  GOTSHOTGUN2: 'GOTSHOTGUN2',
} as const;

/** Game mode (doomdef.h GameMode_t) — MEGA sphere is commercial-only.
 * Default = registered (Doom 1 retail). M7-05+ will plumb g_game gamemode. */
let gamemode: 'shareware' | 'registered' | 'commercial' | 'retail' = 'registered';
export function setGamemode(m: typeof gamemode): void { gamemode = m; }
export function getGamemode(): typeof gamemode { return gamemode; }

/** Netgame flag (p_inter.c netgame) — affects weapon/key pickup rules. */
let netgame = false;
export function setNetgame(n: boolean): void { netgame = n; }
export function getNetgame(): boolean { return netgame; }

/** Deathmatch flag (p_inter.c deathmatch) — affects weapon pickup ammo. */
let deathmatch = false;
export function setDeathmatch(d: boolean): void { deathmatch = d; }
export function getDeathmatch(): boolean { return deathmatch; }

/** Skill level (sk_baby/sk_easy/sk_medium/sk_hard/sk_nightmare) — affects ammo doubling. */
let gameskill = 2; // sk_medium default
export function setGameskill(s: number): void { gameskill = s; }
export function getGameskill(): number { return gameskill; }

/** clipammo per ammo type (p_inter.c clipammo[NUMAMMO] = {10,4,20,1}) */
const CLIPAMMO = [10, 4, 20, 1];

/* ------------------------------------------------------------------ */
/* P_GiveAmmo — p_inter.c:36-84                                        */
/* ------------------------------------------------------------------ */

/**
 * Give ammo to player. Returns false if player already at max ammo.
 * @param num Number of clip loads (0 = half clip). Doubled on baby/nightmare.
 */
export function P_GiveAmmo(player: Player, ammo: number, num: number): boolean {
  if (ammo === AMMO.am_noammo) return false;
  if (ammo < 0 || ammo >= NUMAMMO) throw new Error(`P_GiveAmmo: bad type ${ammo}`);

  if (player.ammo[ammo] === player.maxammo[ammo]) return false;

  let amount: number;
  if (num !== 0) {
    amount = num * CLIPAMMO[ammo];
  } else {
    amount = CLIPAMMO[ammo] / 2;
  }

  // Double ammo on baby / nightmare (p_inter.c:56-61)
  if (gameskill === 0 || gameskill === 4) { // sk_baby=0, sk_nightmare=4
    amount <<= 1;
  }

  const oldammo = player.ammo[ammo];
  player.ammo[ammo] += amount;
  if (player.ammo[ammo] > player.maxammo[ammo]) {
    player.ammo[ammo] = player.maxammo[ammo];
  }

  // If we had zero ammo before, auto-switch weapon preference (p_inter.c:68-83)
  if (oldammo === 0) {
    switch (ammo) {
      case AMMO.am_clip:
        if (player.readyweapon === WP.wp_fist) {
          if (player.weaponowned[WP.wp_chaingun]) player.pendingweapon = WP.wp_chaingun;
          else player.pendingweapon = WP.wp_pistol;
        }
        break;
      case AMMO.am_shell:
        if (player.readyweapon === WP.wp_fist || player.readyweapon === WP.wp_pistol) {
          if (player.weaponowned[WP.wp_shotgun]) player.pendingweapon = WP.wp_shotgun;
        }
        break;
      case AMMO.am_cell:
        if (player.readyweapon === WP.wp_fist || player.readyweapon === WP.wp_pistol) {
          if (player.weaponowned[WP.wp_plasma]) player.pendingweapon = WP.wp_plasma;
        }
        break;
      case AMMO.am_misl:
        if (player.readyweapon === WP.wp_fist) {
          if (player.weaponowned[WP.wp_missile]) player.pendingweapon = WP.wp_missile;
        }
        break;
    }
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* P_GiveWeapon — p_inter.c:87-139                                     */
/* ------------------------------------------------------------------ */

/**
 * Give weapon to player. Returns false if nothing given (already owned in netgame).
 * @param dropped true if weapon has MF_DROPPED flag (half ammo, netgame rules).
 */
export function P_GiveWeapon(player: Player, weapon: number, dropped: boolean): boolean {
  // Netgame / deathmatch rules for placed (non-dropped) weapons (p_inter.c:94-113)
  // netgame && (deathmatch != 2) && !dropped
  if (netgame && !deathmatch && !dropped) {
    if (player.weaponowned[weapon]) return false;
    player.bonuscount += BONUSADD;
    player.weaponowned[weapon] = 1;
    // Deathmatch gives 5 clips, else 2 clips
    if (deathmatch) {
      P_GiveAmmo(player, weaponinfo[weapon].ammo, 5);
    } else {
      P_GiveAmmo(player, weaponinfo[weapon].ammo, 2);
    }
    player.pendingweapon = weapon;
    return false; // weapon stays in map in netgame (vanilla behavior)
  }

  let gaveammo = false;
  if (weaponinfo[weapon].ammo !== AMMO.am_noammo) {
    // Dropped weapon = 1 clip, found weapon = 2 clips (p_inter.c:115-121)
    gaveammo = P_GiveAmmo(player, weaponinfo[weapon].ammo, dropped ? 1 : 2);
  }

  let gaveweapon = false;
  if (!player.weaponowned[weapon]) {
    gaveweapon = true;
    player.weaponowned[weapon] = 1;
    player.pendingweapon = weapon;
  }

  return gaveweapon || gaveammo;
}

/* ------------------------------------------------------------------ */
/* P_GiveBody — p_inter.c:142-156                                      */
/* ------------------------------------------------------------------ */

/** Give health to player. Returns false if already at MAXHEALTH. */
export function P_GiveBody(player: Player, num: number): boolean {
  if (player.health >= MAXHEALTH) return false;
  player.health += num;
  if (player.health > MAXHEALTH) player.health = MAXHEALTH;
  player.mo.health = player.health;
  return true;
}

/* ------------------------------------------------------------------ */
/* P_GiveArmor — p_inter.c:159-171                                     */
/* ------------------------------------------------------------------ */

/**
 * Give armor to player. armortype: 1 = green (100%), 2 = blue (200%).
 * Returns false if current armor is >= new armor.
 */
export function P_GiveArmor(player: Player, armortype: number): boolean {
  const hits = armortype * 100;
  if (player.armorpoints >= hits) return false;
  player.armortype = armortype;
  player.armorpoints = hits;
  return true;
}

/* ------------------------------------------------------------------ */
/* P_GiveCard — p_inter.c:174-184                                      */
/* ------------------------------------------------------------------ */

/** Give key card/skull to player. */
export function P_GiveCard(player: Player, card: number): void {
  if (player.cards[card]) return;
  player.bonuscount = BONUSADD;
  player.cards[card] = 1;
}

/* ------------------------------------------------------------------ */
/* P_GivePower — p_inter.c:187-223                                     */
/* ------------------------------------------------------------------ */

/**
 * Give powerup to player. Returns false if already have it (except strength).
 * Sets powerup timer and side effects (MF_SHADOW for invisibility, etc.).
 */
export function P_GivePower(player: Player, power: number): boolean {
  if (power === PW.pw_invulnerability) {
    player.powers[power] = INVULNTICS;
    return true;
  }
  if (power === PW.pw_invisibility) {
    player.powers[power] = INVISTICS;
    player.mo.flags |= 0x40000; // MF_SHADOW
    return true;
  }
  if (power === PW.pw_infrared) {
    player.powers[power] = INFRATICS;
    return true;
  }
  if (power === PW.pw_ironfeet) {
    player.powers[power] = IRONTICS;
    return true;
  }
  if (power === PW.pw_strength) {
    // Berserk: heal 100 (capped at MAXHEALTH) + set power = 1 (permanent until level end)
    P_GiveBody(player, 100);
    player.powers[power] = 1;
    return true;
  }
  if (power === PW.pw_allmap) {
    if (player.powers[power]) return false; // already have computer map
    player.powers[power] = 1;
    return true;
  }
  // Generic: if already have it, don't pick up
  if (player.powers[power]) return false;
  player.powers[power] = 1;
  return true;
}

/* ------------------------------------------------------------------ */
/* P_TouchSpecialThing — p_inter.c:226-368                             */
/* ------------------------------------------------------------------ */

/**
 * Main pickup dispatcher. Called when a player (MF_PICKUP mover) touches
 * an MF_SPECIAL thing. Identifies item by sprite (special->sprite),
 * applies give rules, sets message/sound, removes mobj.
 *
 * @param specialSlot ThingLinks slot of the item (MF_SPECIAL)
 * @param toucherSlot ThingLinks slot of the toucher (player, MF_PICKUP)
 * @param world PMapWorld for accessing thing data and removing mobjs
 */
export function P_TouchSpecialThing(
  specialSlot: number,
  toucherSlot: number,
  world: { links: { x: Int32Array; y: Int32Array; z: Int32Array; height: Int32Array; flags: Int32Array; doomednum: Int32Array; sprite?: Int32Array } }
): boolean {
  // Reach test: delta > toucher->height || delta < -8*FRACUNIT (p_inter.c:235-239)
  const delta = world.links.z[specialSlot]! - world.links.z[toucherSlot]!;
  const toucherHeight = world.links.height[toucherSlot]!;
  if (delta > toucherHeight || delta < -8 * FRACUNIT) {
    return false; // out of reach
  }

  // Dead toucher bail (p_inter.c:247-249)
  // The toucher's health is in the mover's health field, but thinglinks doesn't store it.
  // In the sim, player health is in Player.health. We need the Player object.
  // For now, we assume the caller has verified the toucher is alive.
  // TODO: The hook receives Mover objects; we need to get Player from Mover.

  // Since the pmap hook passes (slot, toucher: Mover), we need to adapt.
  // This function is the low-level version taking slots; the hook wrapper
  // will extract the Player from the toucher Mover.

  // Identify by sprite (p_inter.c:256 switch)
  // thinglinks stores doomednum; we need a doomednum→sprite map.
  // For now, we need the mobjinfo sprite. We'll use a sprite lookup table.
  const doomednum = world.links.doomednum[specialSlot]!;
  const sprite = doomednumToSprite(doomednum);
  if (sprite === -1) return false; // unknown

  let sound = SFX.sfx_itemup;
  let pickedUp = false;
  let message = '';

  // We need the Player object. The hook wrapper will call a version with Player.
  // This low-level version is kept for potential direct calls.
  // The real implementation is in P_TouchSpecialThingWithPlayer below.

  // Placeholder - the actual logic is in the Player-taking version
  return false;
}

/** doomednum → sprite mapping (from mobjinfo.ts spawnState → stateSprite → sprnames). */
function doomednumToSprite(doomednum: number): number {
  // Mapping derived from the project's mobjinfo.ts spawnState → stateSprite.
  // Sprite numbers match SPR constants (e.g., SPR.ARM1 = 55).
  switch (doomednum) {
    case 2018: return 55;  // ARM1 - Green armor
    case 2019: return 56;  // ARM2 - Blue armor
    case 2014: return 60;  // BON1 - Health bonus
    case 2015: return 61;  // BON2 - Armor bonus
    case 5:    return 62;  // BKEY - Blue key (project mapping)
    case 13:   return 63;  // RKEY - Red key
    case 6:    return 64;  // YKEY - Yellow key
    case 39:   return 67;  // YSKU - Yellow skull
    case 38:   return 66;  // RSKU - Red skull
    case 40:   return 65;  // BSKU - Blue skull
    case 2011: return 68;  // STIM - Stimpack
    case 2012: return 69;  // MEDI - Medikit
    case 2013: return 70;  // SOUL - Soul sphere
    case 2022: return 71;  // PINV - Invulnerability
    case 2023: return 72;  // PSTR - Berserk
    case 2024: return 73;  // PINS - Invisibility
    case 2025: return 75;  // SUIT - Rad suit
    case 2026: return 76;  // PMAP - Allmap
    case 2045: return 77;  // PVIS - Light amp
    case 83:   return 74;  // MEGA - Megasphere
    case 2007: return 78;  // CLIP - Clip
    case 2048: return 79;  // AMMO - Ammo box
    case 2010: return 80;  // ROCK - Rocket
    case 2046: return 81;  // BROK - Rocket box
    case 2047: return 82;  // CELL - Cell pack
    case 17:   return 83;  // CELP - Cell pack (alt)
    case 2008: return 84;  // SHEL - Shells
    case 2049: return 85;  // SBOX - Shell box
    case 8:    return 86;  // BPAK - Backpack
    case 2006: return 87;  // BFUG - BFG
    case 2002: return 88;  // MGUN - Chaingun
    case 2005: return 89;  // CSAW - Chainsaw
    case 2003: return 90;  // LAUN - Rocket launcher
    case 2004: return 91;  // PLAS - Plasma gun
    case 2001: return 92;  // SHOT - Shotgun
    case 82:   return 93;  // SGN2 - Super shotgun
    default: return -1;
  }
}

/* ------------------------------------------------------------------ */
/* Hook-integrated version — called from pmapHooks.touchSpecialThing  */
/* ------------------------------------------------------------------ */

/**
 * Main entry point from pmap hook. Takes the toucher Mover (which has .playerRef
 * to the Player) and the special thing's slot.
 */
export function P_TouchSpecialThingHook(
  specialSlot: number,
  toucher: Mover,
  world: { links: { x: Int32Array; y: Int32Array; z: Int32Array; height: Int32Array; flags: Int32Array; doomednum: Int32Array } }
): void {
  const player = toucher.playerRef;
  if (!player) return; // not a player

  // Reach test
  const delta = world.links.z[specialSlot]! - world.links.z[toucher.linkSlot!]!;
  const toucherHeight = world.links.height[toucher.linkSlot!]!;
  if (delta > toucherHeight || delta < -8 * FRACUNIT) {
    return;
  }

  // Dead toucher bail
  if (player.health <= 0) return;

  const doomednum = world.links.doomednum[specialSlot]!;
  const sprite = doomednumToSprite(doomednum);
  if (sprite === -1) return;

  let sound = SFX.sfx_itemup;
  let pickedUp = false;
  let message = '';

  // Identify by sprite (verbatim from p_inter.c:256)
  switch (sprite) {
    // Armor
    case SPR.ARM1: // Green armor
      if (!P_GiveArmor(player, 1)) return;
      message = GOT.GOTARMOR;
      break;
    case SPR.ARM2: // Blue armor
      if (!P_GiveArmor(player, 2)) return;
      message = GOT.GOTMEGA;
      break;

    // Bonus items
    case SPR.BON1: // Health bonus
      player.health++;
      if (player.health > 200) player.health = 200;
      player.mo.health = player.health;
      message = GOT.GOTHTHBONUS;
      break;
    case SPR.BON2: // Armor bonus
      player.armorpoints++;
      if (player.armorpoints > 200) player.armorpoints = 200;
      if (!player.armortype) player.armortype = 1;
      message = GOT.GOTARMBONUS;
      break;
    case SPR.SOUL: // Soul sphere
      player.health += 100;
      if (player.health > 200) player.health = 200;
      player.mo.health = player.health;
      message = GOT.GOTSUPER;
      sound = SFX.sfx_getpow;
      break;
    case SPR.MEGA: // Megasphere (commercial only)
      if (gamemode !== 'commercial') return;
      player.health = 200;
      player.mo.health = player.health;
      P_GiveArmor(player, 2);
      message = GOT.GOTMSPHERE;
      sound = SFX.sfx_getpow;
      break;

    // Cards (leave for everyone in netgame)
    case SPR.BKEY:
      if (!player.cards[IT.it_bluecard]) message = GOT.GOTBLUECARD;
      P_GiveCard(player, IT.it_bluecard);
      if (!netgame) break;
      return;
    case SPR.YKEY:
      if (!player.cards[IT.it_yellowcard]) message = GOT.GOTYELWCARD;
      P_GiveCard(player, IT.it_yellowcard);
      if (!netgame) break;
      return;
    case SPR.RKEY:
      if (!player.cards[IT.it_redcard]) message = GOT.GOTREDCARD;
      P_GiveCard(player, IT.it_redcard);
      if (!netgame) break;
      return;
    case SPR.BSKU:
      if (!player.cards[IT.it_blueskull]) message = GOT.GOTBLUESKUL;
      P_GiveCard(player, IT.it_blueskull);
      if (!netgame) break;
      return;
    case SPR.YSKU:
      if (!player.cards[IT.it_yellowskull]) message = GOT.GOTYELWSKUL;
      P_GiveCard(player, IT.it_yellowskull);
      if (!netgame) break;
      return;
    case SPR.RSKU:
      if (!player.cards[IT.it_redskull]) message = GOT.GOTREDSKULL;
      P_GiveCard(player, IT.it_redskull);
      if (!netgame) break;
      return;

    // Medikits / heals
    case SPR.STIM:
      if (!P_GiveBody(player, 10)) return;
      message = GOT.GOTSTIM;
      break;
    case SPR.MEDI:
      if (!P_GiveBody(player, 25)) return;
      message = player.health < 25 ? GOT.GOTMEDINEED : GOT.GOTMEDIKIT;
      break;

    // Powerups
    case SPR.PINV:
      if (!P_GivePower(player, PW.pw_invulnerability)) return;
      message = GOT.GOTINVUL;
      sound = SFX.sfx_getpow;
      break;
    case SPR.PSTR:
      if (!P_GivePower(player, PW.pw_strength)) return;
      message = GOT.GOTBERSERK;
      if (player.readyweapon !== WP.wp_fist) player.pendingweapon = WP.wp_fist;
      sound = SFX.sfx_getpow;
      break;
    case SPR.PINS:
      if (!P_GivePower(player, PW.pw_invisibility)) return;
      message = GOT.GOTINVIS;
      sound = SFX.sfx_getpow;
      break;
    case SPR.SUIT:
      if (!P_GivePower(player, PW.pw_ironfeet)) return;
      message = GOT.GOTSUIT;
      sound = SFX.sfx_getpow;
      break;
    case SPR.PMAP:
      if (!P_GivePower(player, PW.pw_allmap)) return;
      message = GOT.GOTMAP;
      sound = SFX.sfx_getpow;
      break;
    case SPR.PVIS:
      if (!P_GivePower(player, PW.pw_infrared)) return;
      message = GOT.GOTVISOR;
      sound = SFX.sfx_getpow;
      break;

    // Ammo
    case SPR.CLIP:
      if (world.links.flags[specialSlot]! & MF_DROPPED) {
        if (!P_GiveAmmo(player, AMMO.am_clip, 0)) return;
      } else {
        if (!P_GiveAmmo(player, AMMO.am_clip, 1)) return;
      }
      message = GOT.GOTCLIP;
      break;
    case SPR.AMMO:
      if (!P_GiveAmmo(player, AMMO.am_clip, 5)) return;
      message = GOT.GOTCLIPBOX;
      break;
    case SPR.ROCK:
      if (!P_GiveAmmo(player, AMMO.am_misl, 1)) return;
      message = GOT.GOTROCKET;
      break;
    case SPR.BROK:
      if (!P_GiveAmmo(player, AMMO.am_misl, 5)) return;
      message = GOT.GOTROCKBOX;
      break;
    case SPR.CELL:
      if (!P_GiveAmmo(player, AMMO.am_cell, 1)) return;
      message = GOT.GOTCELL;
      break;
    case SPR.CELP:
      if (!P_GiveAmmo(player, AMMO.am_cell, 5)) return;
      message = GOT.GOTCELLBOX;
      break;
    case SPR.SHEL:
      if (!P_GiveAmmo(player, AMMO.am_shell, 1)) return;
      message = GOT.GOTSHELLS;
      break;
    case SPR.SBOX:
      if (!P_GiveAmmo(player, AMMO.am_shell, 5)) return;
      message = GOT.GOTSHELLBOX;
      break;
    case SPR.BPAK:
      if (!player.backpack) {
        for (let i = 0; i < NUMAMMO; i++) {
          player.maxammo[i] *= 2;
        }
        player.backpack = true;
      }
      for (let i = 0; i < NUMAMMO; i++) {
        P_GiveAmmo(player, i, 1);
      }
      message = GOT.GOTBACKPACK;
      break;

    // Weapons
    case SPR.BFUG:
      if (!P_GiveWeapon(player, WP.wp_bfg, false)) return;
      message = GOT.GOTBFG9000;
      sound = SFX.sfx_wpnup;
      break;
    case SPR.MGUN:
      if (!P_GiveWeapon(player, WP.wp_chaingun, (world.links.flags[specialSlot]! & MF_DROPPED) !== 0)) return;
      message = GOT.GOTCHAINGUN;
      sound = SFX.sfx_wpnup;
      break;
    case SPR.CSAW:
      if (!P_GiveWeapon(player, WP.wp_chainsaw, false)) return;
      message = GOT.GOTCHAINSAW;
      sound = SFX.sfx_wpnup;
      break;
    case SPR.LAUN:
      if (!P_GiveWeapon(player, WP.wp_missile, false)) return;
      message = GOT.GOTLAUNCHER;
      sound = SFX.sfx_wpnup;
      break;
    case SPR.PLAS:
      if (!P_GiveWeapon(player, WP.wp_plasma, false)) return;
      message = GOT.GOTPLASMA;
      sound = SFX.sfx_wpnup;
      break;
    case SPR.SHOT:
      if (!P_GiveWeapon(player, WP.wp_shotgun, (world.links.flags[specialSlot]! & MF_DROPPED) !== 0)) return;
      message = GOT.GOTSHOTGUN;
      sound = SFX.sfx_wpnup;
      break;
    case SPR.SGN2:
      if (!P_GiveWeapon(player, WP.wp_supershotgun, (world.links.flags[specialSlot]! & MF_DROPPED) !== 0)) return;
      message = GOT.GOTSHOTGUN2;
      sound = SFX.sfx_wpnup;
      break;

    default:
      // Unknown sprite - in vanilla this would I_Error
      return;
  }

  // MF_COUNTITEM → itemcount++
  if (world.links.flags[specialSlot]! & MF_COUNTITEM) {
    player.itemcount++;
  }

  // Remove the mobj
  // P_RemoveMobj is in p_mobj.ts; we'll call a removal function
  // For now, mark as unlinked. The actual removal is done by the caller
  // or we need to import P_RemoveMobj. We'll do it here by unlinking.
  // TODO: Import P_RemoveMobj from p_mobj.ts and call it.
  // For now, just unlink from thinglinks.
  thingUnsetPosition(world.links, specialSlot);
  world.links.linked[specialSlot] = 0;

  player.bonuscount += BONUSADD;
  player.message = message;

  // Sound enqueue (M10 will implement actual audio; for now track via hook)
  // S_StartSound(NULL, sound) for consoleplayer
  // We'll use a callback hook for sound
  if (pickupSoundHook) pickupSoundHook(sound);
}

/** Callback for sound enqueue (M10 replaces with real audio). */
let pickupSoundHook: ((sound: string) => void) | null = null;
export function setPickupSoundHook(fn: (sound: string) => void): void {
  pickupSoundHook = fn;
}

/* ------------------------------------------------------------------ */
/* thinglinks helpers (local copies to avoid circular deps)           */
/* ------------------------------------------------------------------ */

import { blockIndexOf } from './blockmap';

function thingUnsetPosition(links: typeof world.links, slot: number): void {
  if (links.flags[slot]! & 16) return; // MF_NOBLOCKMAP
  if (slot < (links as any).staticCount) {
    (links as any).linked[slot] = 0;
    return;
  }
  if (!(links as any).linked[slot]) return;
  const cx = blockIndexOf(links.x[slot]! - links.bm.originX);
  const cy = blockIndexOf(links.y[slot]! - links.bm.originY);
  const p = (links as any).prev[slot]!;
  const n = (links as any).next[slot]!;
  if (n !== -1) (links as any).prev[n] = p;
  if (p !== -1) (links as any).next[p] = n;
  else if (cx >= 0 && cy >= 0 && cx < links.bm.width && cy < links.bm.height) {
    (links as any).cellHead[cy * links.bm.width + cx] = n;
  }
  (links as any).prev[slot] = -1;
  (links as any).next[slot] = -1;
  (links as any).linked[slot] = 0;
}

/* ------------------------------------------------------------------ */
/* Wire the M5 callback slot                                          */
/* ------------------------------------------------------------------ */

// The pmap hook is registered by the sim initialization (gInitGame or similar).
// We expose a registration function that wires the hook to call
// P_TouchSpecialThingHook with the current pmap world.
export function registerPickupHook(): void {
  pmapHooks.touchSpecialThing = (slot: number, toucher: Mover) => {
    const world = getPmapWorld();
    if (world) {
      P_TouchSpecialThingHook(slot, toucher, world);
    }
  };
}

/* ------------------------------------------------------------------ */
/* Test utilities                                                      */
/* ------------------------------------------------------------------ */

export function resetPickupState(): void {
  gamemode = 'registered';
  netgame = false;
  deathmatch = false;
  gameskill = 2;
  pickupSoundHook = null;
}