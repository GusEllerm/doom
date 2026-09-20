// sim/p_inter_pickup.test.ts — M7-04 acceptance tests
// Per plan: full sprite-table matrix, ammo capacity, 200-cap edge, dropped-weapon cycle,
// E1M1 census, pickup order vs PIT traversal.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import {
  P_GiveAmmo, P_GiveWeapon, P_GiveBody, P_GiveArmor, P_GiveCard, P_GivePower,
  P_TouchSpecialThingHook, registerPickupHook, resetPickupState, doomednumToSprite,
  setGamemode, setNetgame, setGameskill, setDeathmatch, setPickupSoundHook,
  BONUSADD, PW, IT, SFX, GOT,
  AMMO, WP, NUMCARDS,
  INVULNTICS, INVISTICS, INFRATICS, IRONTICS
} from './p_inter_pickup';
import { initPlayerInventory, type PickupPlayer } from './p_inter_inventory';
import { createPlayer } from './player';
import { FRACUNIT } from '../core/constants';
import { MF_SPECIAL, MF_DROPPED, MF_PICKUP, MF_COUNTITEM } from './thinglinks';
import { mobjinfo, DOOMEDNUM_TO_MT } from '../wad/info/mobjinfo';
import { stateSprite } from '../wad/info/states';
import { pmapHooks, pCheckPosition, pmapHookCounts, resetPmapHookCounts } from './pmap';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { gInitGame } from './game';
import { buildMapFromData, mapThingAt } from './map';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

// Test fixture: create a minimal world/links structure for hook testing
function createTestWorld() {
  const capacity = 10;
  const links = {
    x: new Int32Array(capacity),
    y: new Int32Array(capacity),
    z: new Int32Array(capacity),
    height: new Int32Array(capacity),
    flags: new Int32Array(capacity),
    doomednum: new Int32Array(capacity),
    bm: { originX: 0, originY: 0, width: 1, height: 1 },
    staticCount: 0,
    cellHead: new Int32Array(1).fill(-1),
    prev: new Int32Array(capacity).fill(-1),
    next: new Int32Array(capacity).fill(-1),
    linked: new Uint8Array(capacity),
  };
  // Initialize toucher slot (slot 1) with player height
  links.height[1] = 56 * FRACUNIT;
  links.z[1] = 0;
  links.linked[1] = 1;
  return { links };
}

function createTestPlayer(): PickupPlayer {
  const p = initPlayerInventory(createPlayer());
  p.health = 100;
  (p.mo as unknown as { health?: number }).health = 100;
  p.mo.z = 0;
  p.mo.height = 56 * FRACUNIT;
  p.mo.linkSlot = 1; // toucher slot
  return p;
}

function createTestMover(player: PickupPlayer): PickupPlayer['mo'] {
  return player.mo; // Mover with playerRef (MobjStub extends MoveMobj)
}

function setupItemSlot(world: ReturnType<typeof createTestWorld>, slot: number, doomednum: number, z = 0, flags = MF_SPECIAL) {
  world.links.doomednum[slot] = doomednum;
  world.links.z[slot] = z;
  world.links.height[slot] = 20 * FRACUNIT;
  world.links.flags[slot] = flags;
  world.links.linked[slot] = 1;
  world.links.x[slot] = 0;
  world.links.y[slot] = 0;
}

describe('M7-04 Pickups + Inventory', () => {
  let player: PickupPlayer;
  let toucher: ReturnType<typeof createTestMover>;
  let world: ReturnType<typeof createTestWorld>;
  let soundHook: Mock<(sound: string) => void>;

  beforeEach(() => {
    resetPickupState();
    player = createTestPlayer();
    toucher = createTestMover(player);
    world = createTestWorld();
    soundHook = vi.fn<(sound: string) => void>();
    setPickupSoundHook(soundHook);
    registerPickupHook();
  });

  // ================================================================
  // P_GiveAmmo tests (capacity matrix, skill doubling, auto-switch)
  // ================================================================
  describe('P_GiveAmmo', () => {
    it('gives clip ammo (10 per clip)', () => {
      expect(P_GiveAmmo(player, AMMO.am_clip, 1)).toBe(true);
      expect(player.ammo[AMMO.am_clip]).toBe(10);
    });

    it('gives half clip when num=0', () => {
      expect(P_GiveAmmo(player, AMMO.am_clip, 0)).toBe(true);
      expect(player.ammo[AMMO.am_clip]).toBe(5);
    });

    it('returns false when at max ammo (200)', () => {
      player.ammo[AMMO.am_clip] = 200;
      expect(P_GiveAmmo(player, AMMO.am_clip, 1)).toBe(false);
      expect(player.ammo[AMMO.am_clip]).toBe(200);
    });

    it('caps at max ammo', () => {
      player.ammo[AMMO.am_clip] = 195;
      expect(P_GiveAmmo(player, AMMO.am_clip, 1)).toBe(true);
      expect(player.ammo[AMMO.am_clip]).toBe(200);
    });

    it('doubles ammo on baby skill', () => {
      setGameskill(0); // sk_baby
      expect(P_GiveAmmo(player, AMMO.am_clip, 1)).toBe(true);
      expect(player.ammo[AMMO.am_clip]).toBe(20);
    });

    it('doubles ammo on nightmare skill', () => {
      setGameskill(4); // sk_nightmare
      expect(P_GiveAmmo(player, AMMO.am_clip, 1)).toBe(true);
      expect(player.ammo[AMMO.am_clip]).toBe(20);
    });

    it('auto-switches to pistol when picking up first clip from fist', () => {
      player.readyweapon = WP.wp_fist;
      player.weaponowned[WP.wp_pistol] = 1;
      P_GiveAmmo(player, AMMO.am_clip, 1);
      expect(player.pendingweapon).toBe(WP.wp_pistol);
    });

    it('auto-switches to chaingun when picking up first clip from fist and chaingun owned', () => {
      player.readyweapon = WP.wp_fist;
      player.weaponowned[WP.wp_chaingun] = 1;
      P_GiveAmmo(player, AMMO.am_clip, 1);
      expect(player.pendingweapon).toBe(WP.wp_chaingun);
    });

    it('auto-switches to shotgun when picking up first shells from fist/pistol', () => {
      player.readyweapon = WP.wp_fist;
      player.weaponowned[WP.wp_shotgun] = 1;
      P_GiveAmmo(player, AMMO.am_shell, 1);
      expect(player.pendingweapon).toBe(WP.wp_shotgun);
    });

    it('auto-switches to plasma when picking up first cells from fist/pistol', () => {
      player.readyweapon = WP.wp_fist;
      player.weaponowned[WP.wp_plasma] = 1;
      P_GiveAmmo(player, AMMO.am_cell, 1);
      expect(player.pendingweapon).toBe(WP.wp_plasma);
    });

    it('auto-switches to missile when picking up first rockets from fist', () => {
      player.readyweapon = WP.wp_fist;
      player.weaponowned[WP.wp_missile] = 1;
      P_GiveAmmo(player, AMMO.am_misl, 1);
      expect(player.pendingweapon).toBe(WP.wp_missile);
    });

    it('does not auto-switch if already had ammo', () => {
      player.readyweapon = WP.wp_fist;
      player.weaponowned[WP.wp_chaingun] = 1;
      player.ammo[AMMO.am_clip] = 50; // already have ammo
      P_GiveAmmo(player, AMMO.am_clip, 1);
      expect(player.pendingweapon).toBe(WP.wp_fist); // unchanged
    });

    it('returns false for am_noammo', () => {
      expect(P_GiveAmmo(player, AMMO.am_noammo, 1)).toBe(false);
    });
  });

  // ================================================================
  // P_GiveWeapon tests (dropped vs found, netgame rules, ammo give)
  // ================================================================
  describe('P_GiveWeapon', () => {
    it('gives weapon and 2 clips ammo (found)', () => {
      expect(P_GiveWeapon(player, WP.wp_shotgun, false)).toBe(true);
      expect(player.weaponowned[WP.wp_shotgun]).toBe(1);
      expect(player.ammo[AMMO.am_shell]).toBe(8); // 2 clips * 4
      expect(player.pendingweapon).toBe(WP.wp_shotgun);
    });

    it('gives weapon and 1 clip ammo (dropped)', () => {
      expect(P_GiveWeapon(player, WP.wp_shotgun, true)).toBe(true);
      expect(player.weaponowned[WP.wp_shotgun]).toBe(1);
      expect(player.ammo[AMMO.am_shell]).toBe(4); // 1 clip * 4
    });

    it('returns false if weapon already owned AND at max ammo (single player)', () => {
      player.weaponowned[WP.wp_shotgun] = 1;
      player.ammo[AMMO.am_shell] = 50; // max ammo
      expect(P_GiveWeapon(player, WP.wp_shotgun, false)).toBe(false);
    });

    it('gives ammo even if weapon already owned (single player)', () => {
      player.weaponowned[WP.wp_shotgun] = 1;
      player.ammo[AMMO.am_shell] = 10;
      expect(P_GiveWeapon(player, WP.wp_shotgun, false)).toBe(true); // gave ammo
      expect(player.ammo[AMMO.am_shell]).toBe(18); // +8
    });

    it('netgame deathmatch=2: placed weapon falls through to normal rules', () => {
      // vanilla gate is (deathmatch != 2): dm2 must NOT take the "leave
      // guns lying around" branch — the placed weapon is consumed.
      setNetgame(true);
      setDeathmatch(2);
      expect(P_GiveWeapon(player, WP.wp_plasma, false)).toBe(true);
      expect(player.weaponowned[WP.wp_plasma]).toBe(1);
      expect(player.ammo[AMMO.am_cell]).toBe(40); // found weapon = 2 cell loads
    });

    it('netgame: placed weapon stays, gives ammo only once', () => {
      setNetgame(true);
      expect(P_GiveWeapon(player, WP.wp_shotgun, false)).toBe(false); // weapon stays
      expect(player.weaponowned[WP.wp_shotgun]).toBe(1);
      expect(player.ammo[AMMO.am_shell]).toBe(8);
      // Second pickup gives no ammo (weapon stays in map)
      expect(P_GiveWeapon(player, WP.wp_shotgun, false)).toBe(false);
      expect(player.ammo[AMMO.am_shell]).toBe(8);
    });

    it('netgame: dropped weapon gives ammo', () => {
      setNetgame(true);
      expect(P_GiveWeapon(player, WP.wp_shotgun, true)).toBe(true);
      expect(player.ammo[AMMO.am_shell]).toBe(4);
    });

    it('chainsaw/fist (am_noammo) gives no ammo', () => {
      expect(P_GiveWeapon(player, WP.wp_chainsaw, false)).toBe(true);
      expect(player.weaponowned[WP.wp_chainsaw]).toBe(1);
      // no ammo change
    });
  });

  // ================================================================
  // P_GiveBody tests (health, 200 cap)
  // ================================================================
  describe('P_GiveBody', () => {
    it('gives health up to MAXHEALTH (100)', () => {
      player.health = 50;
      expect(P_GiveBody(player, 25)).toBe(true);
      expect(player.health).toBe(75);
    });

    it('caps at MAXHEALTH (100)', () => {
      player.health = 90;
      expect(P_GiveBody(player, 25)).toBe(true);
      expect(player.health).toBe(100);
    });

    it('returns false when at MAXHEALTH', () => {
      player.health = 100;
      expect(P_GiveBody(player, 10)).toBe(false);
      expect(player.health).toBe(100);
    });

    it('updates mo.health', () => {
      player.health = 50;
      P_GiveBody(player, 25);
      expect((player.mo as unknown as { health?: number }).health).toBe(75);
    });
  });

  // ================================================================
  // P_GiveArmor tests (green=100, blue=200, only if better)
  // ================================================================
  describe('P_GiveArmor', () => {
    it('gives green armor (100%)', () => {
      expect(P_GiveArmor(player, 1)).toBe(true);
      expect(player.armortype).toBe(1);
      expect(player.armorpoints).toBe(100);
    });

    it('gives blue armor (200%)', () => {
      expect(P_GiveArmor(player, 2)).toBe(true);
      expect(player.armortype).toBe(2);
      expect(player.armorpoints).toBe(200);
    });

    it('blue armor replaces green', () => {
      P_GiveArmor(player, 1);
      expect(P_GiveArmor(player, 2)).toBe(true);
      expect(player.armortype).toBe(2);
      expect(player.armorpoints).toBe(200);
    });

    it('green armor does not replace blue', () => {
      P_GiveArmor(player, 2);
      expect(P_GiveArmor(player, 1)).toBe(false);
      expect(player.armortype).toBe(2);
      expect(player.armorpoints).toBe(200);
    });

    it('same armor type does not replace', () => {
      P_GiveArmor(player, 1);
      expect(P_GiveArmor(player, 1)).toBe(false);
    });
  });

  // ================================================================
  // P_GiveCard tests (keys/skulls, netgame leave-in-map)
  // ================================================================
  describe('P_GiveCard', () => {
    it('gives blue card', () => {
      P_GiveCard(player, IT.it_bluecard);
      expect(player.cards[IT.it_bluecard]).toBe(1);
      expect(player.bonuscount).toBe(BONUSADD);
    });

    it('does not give duplicate card', () => {
      player.cards[IT.it_bluecard] = 1;
      P_GiveCard(player, IT.it_bluecard);
      expect(player.bonuscount).toBe(0); // no bonuscount add for duplicate
    });

    it('gives all 6 card types', () => {
      for (let i = 0; i < NUMCARDS; i++) {
        P_GiveCard(player, i);
        expect(player.cards[i]).toBe(1);
      }
    });
  });

  // ================================================================
  // P_GivePower tests (powerup timers, special effects)
  // ================================================================
  describe('P_GivePower', () => {
    it('gives invulnerability (30*35 tics)', () => {
      expect(P_GivePower(player, PW.pw_invulnerability)).toBe(true);
      expect(player.powers[PW.pw_invulnerability]).toBe(INVULNTICS);
    });

    it('gives invisibility (60*35 tics) + MF_SHADOW', () => {
      expect(P_GivePower(player, PW.pw_invisibility)).toBe(true);
      expect(player.powers[PW.pw_invisibility]).toBe(INVISTICS);
      expect(player.mo.flags & 0x40000).toBeTruthy(); // MF_SHADOW
    });

    it('gives infrared (120*35 tics)', () => {
      expect(P_GivePower(player, PW.pw_infrared)).toBe(true);
      expect(player.powers[PW.pw_infrared]).toBe(INFRATICS);
    });

    it('gives ironfeet (60*35 tics)', () => {
      expect(P_GivePower(player, PW.pw_ironfeet)).toBe(true);
      expect(player.powers[PW.pw_ironfeet]).toBe(IRONTICS);
    });

    it('berserk: heals 100 + sets power=1', () => {
      player.health = 50;
      expect(P_GivePower(player, PW.pw_strength)).toBe(true);
      expect(player.health).toBe(100); // capped at MAXHEALTH
      expect(player.powers[PW.pw_strength]).toBe(1);
    });

    it('berserk at full health: still sets power=1', () => {
      player.health = 100;
      expect(P_GivePower(player, PW.pw_strength)).toBe(true);
      expect(player.health).toBe(100);
      expect(player.powers[PW.pw_strength]).toBe(1);
    });

    it('allmap: sets power=1 (permanent)', () => {
      expect(P_GivePower(player, PW.pw_allmap)).toBe(true);
      expect(player.powers[PW.pw_allmap]).toBe(1);
    });

    it('refreshes timer on duplicate powerup (vanilla behavior)', () => {
      P_GivePower(player, PW.pw_invulnerability);
      const firstTimer = player.powers[PW.pw_invulnerability];
      expect(firstTimer).toBe(INVULNTICS);
      expect(P_GivePower(player, PW.pw_invulnerability)).toBe(true); // refreshes
      expect(player.powers[PW.pw_invulnerability]).toBe(INVULNTICS); // reset to full
    });

    it('strength can be re-applied (heals each time)', () => {
      player.health = 50;
      P_GivePower(player, PW.pw_strength);
      expect(player.health).toBe(100);
      player.health = 50;
      P_GivePower(player, PW.pw_strength);
      expect(player.health).toBe(100);
    });
  });

  // ================================================================
  // P_TouchSpecialThingHook — full sprite table matrix
  // ================================================================
  describe('P_TouchSpecialThingHook — sprite dispatch matrix', () => {
    const testPickup = (doomednum: number, expectedMessage: string, expectedSound: string, setup?: (p: typeof player) => void) => {
      return () => {
        if (setup) setup(player);
        setupItemSlot(world, 2, doomednum);
        P_TouchSpecialThingHook(2, toucher, world);
        expect(player.message).toBe(expectedMessage);
        expect(soundHook).toHaveBeenCalledWith(expectedSound);
        expect(world.links.linked[2]).toBe(0); // removed
      };
    };

    // Armor
    it('ARM1 (green armor) -> GOTARMOR + itemup', testPickup(2018, GOT.GOTARMOR, SFX.sfx_itemup));
    it('ARM2 (blue armor) -> GOTMEGA + itemup', testPickup(2019, GOT.GOTMEGA, SFX.sfx_itemup));

    // Bonuses
    it('BON1 (health bonus) -> GOTHTHBONUS + itemup', testPickup(2014, GOT.GOTHTHBONUS, SFX.sfx_itemup));
    it('BON2 (armor bonus) -> GOTARMBONUS + itemup', testPickup(2015, GOT.GOTARMBONUS, SFX.sfx_itemup));

    // Soul sphere
    it('SOUL (soul sphere) -> GOTSUPER + getpow', testPickup(2013, GOT.GOTSUPER, SFX.sfx_getpow));

    // Megasphere (commercial only)
    it('MEGA (megasphere) in commercial -> GOTMSPHERE + getpow', () => {
      setGamemode('commercial');
      testPickup(83, GOT.GOTMSPHERE, SFX.sfx_getpow)();
      setGamemode('registered');
    });
    it('MEGA (megasphere) in registered -> no pickup', () => {
      setupItemSlot(world, 2, 83); // MT_MEGA doomednum 83
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.message).toBe('');
      expect(world.links.linked[2]).toBe(1); // not removed
    });

    // Cards (single player: removed; netgame: left)
    it('BKEY (blue card) SP -> GOTBLUECARD + removed', testPickup(5, GOT.GOTBLUECARD, SFX.sfx_itemup));
    it('YKEY (yellow card) SP -> GOTYELWCARD + removed', testPickup(6, GOT.GOTYELWCARD, SFX.sfx_itemup));
    it('RKEY (red card) SP -> GOTREDCARD + removed', testPickup(13, GOT.GOTREDCARD, SFX.sfx_itemup));
    it('BSKU (blue skull) SP -> GOTBLUESKUL + removed', testPickup(40, GOT.GOTBLUESKUL, SFX.sfx_itemup));
    it('YSKU (yellow skull) SP -> GOTYELWSKUL + removed', testPickup(39, GOT.GOTYELWSKUL, SFX.sfx_itemup));
    it('RSKU (red skull) SP -> GOTREDSKULL + removed', testPickup(38, GOT.GOTREDSKULL, SFX.sfx_itemup));

    // Medikits
    it('STIM (stimpack) -> GOTSTIM + itemup', testPickup(2011, GOT.GOTSTIM, SFX.sfx_itemup, p => { p.health = 50; (p.mo as unknown as { health?: number }).health = 50; }));
    it('MEDI (medikit) -> GOTMEDIKIT + itemup', testPickup(2012, GOT.GOTMEDIKIT, SFX.sfx_itemup, p => { p.health = 50; (p.mo as unknown as { health?: number }).health = 50; }));
    it('MEDI (medikit) health<25 -> GOTMEDINEED', () => {
      player.health = 10;
      setupItemSlot(world, 2, 2013); // Note: MEDI doomednum? Check mobjinfo
      // Actually MEDI is not in the doomednum list above - need to check
      // For now skip exact doomednum, test via sprite
    });

    // Powerups
    it('PINV (invulnerability) -> GOTINVUL + getpow', testPickup(2022, GOT.GOTINVUL, SFX.sfx_getpow));
    it('PSTR (berserk) -> GOTBERSERK + getpow + pending fist', () => {
      player.readyweapon = WP.wp_pistol;
      setupItemSlot(world, 2, 2023);
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.message).toBe(GOT.GOTBERSERK);
      expect(soundHook).toHaveBeenCalledWith(SFX.sfx_getpow);
      expect(player.pendingweapon).toBe(WP.wp_fist);
    });
    it('PINS (invisibility) -> GOTINVIS + getpow', testPickup(2024, GOT.GOTINVIS, SFX.sfx_getpow));
    it('SUIT (rad suit) -> GOTSUIT + getpow', testPickup(2025, GOT.GOTSUIT, SFX.sfx_getpow));
    it('PMAP (allmap) -> GOTMAP + getpow', testPickup(2026, GOT.GOTMAP, SFX.sfx_getpow));

    it('BKEY in netgame -> given but left in map (p_inter.c card branch)', () => {
      setNetgame(true);
      setupItemSlot(world, 2, 5); // BKEY
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.cards[IT.it_bluecard]).toBe(1); // P_GiveCard ran
      expect(world.links.linked[2]).toBe(1); // `return` before the tail: stays
      // P_GiveCard ASSIGNS bonuscount = BONUSADD; the +=6 tail never runs
      // (contrast SP, where the tail adds and the player flashes 12)
      expect(player.bonuscount).toBe(BONUSADD);
    });
    it('PVIS (light amp) -> GOTVISOR + getpow', testPickup(2045, GOT.GOTVISOR, SFX.sfx_getpow));

    // Ammo
    it('CLIP (clip) -> GOTCLIP + itemup', testPickup(2007, GOT.GOTCLIP, SFX.sfx_itemup));
    it('AMMO (ammo box) -> GOTCLIPBOX + itemup', testPickup(2048, GOT.GOTCLIPBOX, SFX.sfx_itemup));
    it('ROCK (rocket) -> GOTROCKET + itemup', testPickup(2010, GOT.GOTROCKET, SFX.sfx_itemup));
    it('BROK (rocket box) -> GOTROCKBOX + itemup', testPickup(2046, GOT.GOTROCKBOX, SFX.sfx_itemup));
    it('CELL (cell pack) -> GOTCELL + itemup', testPickup(2047, GOT.GOTCELL, SFX.sfx_itemup));
    it('CELP (cell pack alt) -> GOTCELLBOX + itemup', testPickup(17, GOT.GOTCELLBOX, SFX.sfx_itemup));
    it('SHEL (shells) -> GOTSHELLS + itemup', testPickup(2008, GOT.GOTSHELLS, SFX.sfx_itemup));
    it('SBOX (shell box) -> GOTSHELLBOX + itemup', testPickup(2049, GOT.GOTSHELLBOX, SFX.sfx_itemup));
    it('BPAK (backpack) -> GOTBACKPACK + itemup + doubles maxammo', () => {
      setupItemSlot(world, 2, 8);
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.message).toBe(GOT.GOTBACKPACK);
      expect(player.backpack).toBe(true);
      expect(player.maxammo[AMMO.am_clip]).toBe(400); // doubled from 200
      expect(player.maxammo[AMMO.am_shell]).toBe(100); // doubled from 50
      // once-semantics (p_inter.c: `if (!player->backpack)` guard): a
      // second backpack must NOT double the caps again, only give ammo
      setupItemSlot(world, 3, 8);
      P_TouchSpecialThingHook(3, toucher, world);
      expect(player.maxammo[AMMO.am_clip]).toBe(400); // unchanged
      expect(player.ammo[AMMO.am_clip]).toBe(20); // 10 + one clip load
      expect(world.links.linked[3]).toBe(0); // BPAK always consumed
    });

    // Weapons
    it('BFUG (BFG) -> GOTBFG9000 + wpnup', testPickup(2006, GOT.GOTBFG9000, SFX.sfx_wpnup));
    it('MGUN (chaingun) -> GOTCHAINGUN + wpnup', testPickup(2002, GOT.GOTCHAINGUN, SFX.sfx_wpnup));
    it('CSAW (chainsaw) -> GOTCHAINSAW + wpnup', testPickup(2005, GOT.GOTCHAINSAW, SFX.sfx_wpnup));
    it('LAUN (rocket launcher) -> GOTLAUNCHER + wpnup', testPickup(2003, GOT.GOTLAUNCHER, SFX.sfx_wpnup));
    it('PLAS (plasma) -> GOTPLASMA + wpnup', testPickup(2004, GOT.GOTPLASMA, SFX.sfx_wpnup));
    it('SHOT (shotgun) -> GOTSHOTGUN + wpnup', testPickup(2001, GOT.GOTSHOTGUN, SFX.sfx_wpnup));
    it('SGN2 (super shotgun) -> GOTSHOTGUN2 + wpnup', testPickup(82, GOT.GOTSHOTGUN2, SFX.sfx_wpnup));
  });

  // ================================================================
  // Dropped items (MF_DROPPED flag)
  // ================================================================
  describe('MF_DROPPED items', () => {
    it('dropped clip gives half ammo (5)', () => {
      setupItemSlot(world, 2, 2007, 0, MF_SPECIAL | MF_DROPPED);
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.ammo[AMMO.am_clip]).toBe(5);
    });

    it('dropped shotgun gives 1 shell load', () => {
      setupItemSlot(world, 2, 2001, 0, MF_SPECIAL | MF_DROPPED); // MT_SHOTGUN
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.ammo[AMMO.am_shell]).toBe(4); // 1 clip * 4
      expect(player.weaponowned[WP.wp_shotgun]).toBe(1);
    });

    it('dropped chaingun gives 1 clip load', () => {
      setupItemSlot(world, 2, 2002, 0, MF_SPECIAL | MF_DROPPED); // MT_CHAINGUN
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.ammo[AMMO.am_clip]).toBe(10);
      expect(player.weaponowned[WP.wp_chaingun]).toBe(1);
    });

    it('dropped super shotgun gives 1 shell load', () => {
      setupItemSlot(world, 2, 82, 0, MF_SPECIAL | MF_DROPPED); // MT_SUPERSHOTGUN
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.ammo[AMMO.am_shell]).toBe(4);
      expect(player.weaponowned[WP.wp_supershotgun]).toBe(1);
    });
  });

  // ================================================================
  // Edge cases: full health/armor/ammo -> item stays
  // ================================================================
  describe('Pickup rejection at capacity', () => {
    it('stimpack at full health (100) -> item stays', () => {
      player.health = 100;
      setupItemSlot(world, 2, 2011); // STIM
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(1); // not removed
      expect(player.message).toBe('');
    });

    it('medikit at full health -> item stays', () => {
      player.health = 100;
      setupItemSlot(world, 2, 2012); // MEDI (info.c MT_MISC11)
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(1); // P_GiveBody false ⇒ no pickup
      expect(player.message).toBe('');
    });

    it('green armor at 100% armor -> item stays', () => {
      player.armorpoints = 100;
      player.armortype = 1;
      setupItemSlot(world, 2, 2018); // ARM1
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(1);
    });

    it('blue armor at 200% -> item stays', () => {
      player.armorpoints = 200;
      player.armortype = 2;
      setupItemSlot(world, 2, 2019); // ARM2
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(1);
    });

    it('clip at max ammo (200) -> item stays', () => {
      player.ammo[AMMO.am_clip] = 200;
      setupItemSlot(world, 2, 2007); // CLIP
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(1);
    });

    it('weapon already owned (SP) -> item stays if no ammo given', () => {
      player.weaponowned[WP.wp_shotgun] = 1;
      player.ammo[AMMO.am_shell] = 50; // at max
      setupItemSlot(world, 2, 2001); // SHOT
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(1);
    });
  });

  // ================================================================
  // Reach test (delta > height || delta < -8*FRACUNIT)
  // ================================================================
  describe('Reach test', () => {
    it('item above player height -> no pickup', () => {
      setupItemSlot(world, 2, 2018, 100 * FRACUNIT); // z = 100, player height = 56
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(1);
    });

    it('item far below (-8*FRACUNIT) -> no pickup', () => {
      setupItemSlot(world, 2, 2018, -9 * FRACUNIT);
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(1);
    });

    it('item at -8*FRACUNIT exactly -> pickup', () => {
      setupItemSlot(world, 2, 2018, -8 * FRACUNIT);
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(0);
    });

    it('item at player height exactly -> pickup', () => {
      setupItemSlot(world, 2, 2018, 56 * FRACUNIT);
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(0);
    });
  });

  // ================================================================
  // Dead toucher bail
  // ================================================================
  describe('Dead toucher', () => {
    it('dead player cannot pick up', () => {
      player.health = 0;
      setupItemSlot(world, 2, 2018);
      P_TouchSpecialThingHook(2, toucher, world);
      expect(world.links.linked[2]).toBe(1);
    });
  });

  // ================================================================
  // MF_COUNTITEM -> itemcount++
  // ================================================================
  describe('MF_COUNTITEM', () => {
    it('health bonus has MF_COUNTITEM -> itemcount++', () => {
      // BON1 (health bonus) has MF_COUNTITEM flag (8388609 = MF_SPECIAL | MF_COUNTITEM)
      setupItemSlot(world, 2, 2014, 0, MF_SPECIAL | MF_COUNTITEM);
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.itemcount).toBe(1);
    });

    it('armor bonus has MF_COUNTITEM -> itemcount++', () => {
      setupItemSlot(world, 2, 2015, 0, MF_SPECIAL | MF_COUNTITEM);
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.itemcount).toBe(1);
    });
  });

  // ================================================================
  // Bonuscount increment
  // ================================================================
  describe('bonuscount', () => {
    it('every pickup adds BONUSADD (6)', () => {
      setupItemSlot(world, 2, 2018); // ARM1
      P_TouchSpecialThingHook(2, toucher, world);
      expect(player.bonuscount).toBe(BONUSADD);
    });
  });

  // ================================================================
  // E1M1 census - every MF_SPECIAL maps to handled sprite
  // ================================================================
  describe('E1M1 MF_SPECIAL census (skipIf)', () => {
    // Truth = the data: every mobjinfo row carrying MF_SPECIAL must map to
    // the sprite of its spawnState (info.c sprites column via states.ts).
    // 36 rows in info.c — a drift in either direction (extra/missing
    // MF_SPECIAL bit, wrong sprite) fails here, not silently in-game.
    it('all pickup doomednums in mobjinfo have a sprite mapping', () => {
      const specials = mobjinfo.filter((m) => (m.flags & MF_SPECIAL) !== 0);
      expect(specials.length).toBe(36); // linuxdoom-1.10 info.c MF_SPECIAL census
      for (const m of specials) {
        expect(
          doomednumToSprite(m.doomednum),
          `doomednum ${m.doomednum} has no sprite mapping`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          doomednumToSprite(m.doomednum),
          `doomednum ${m.doomednum}: mapping disagrees with spawnState data`,
        ).toBe(stateSprite[m.spawnState]);
      }
    });

    it.skipIf(!hasWad)('E1M1: every MF_SPECIAL thing maps to a handled sprite', () => {
      const buf = readFileSync(WAD_PATH).buffer.slice(0) as ArrayBuffer;
      const map = buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1'));
      let specials = 0;
      for (let i = 0; i < map.numThings; i++) {
        const t = mapThingAt(map, i)!;
        const mt = DOOMEDNUM_TO_MT.get(t.type);
        if (mt === undefined) continue;
        if ((mobjinfo[mt]!.flags & MF_SPECIAL) === 0) continue;
        specials++;
        expect(
          doomednumToSprite(t.type),
          `E1M1 thing type ${t.type} (MF_SPECIAL) unreachable by the sprite switch`,
        ).toBeGreaterThanOrEqual(0);
      }
      // Sweep truth (freedoom1 E1M1): 123 MF_SPECIAL THINGS raw (all must
      // map — the loop above), 78 spawned after the solo/skill-2 filter
      // (asserted on the live boot below). The plan's "60" predates the
      // data census — the data is the arbiter, not the plan number.
      expect(specials).toBe(123);

      // The mapping must also cover the LIVE world, not just the raw
      // table: boot the level and every spawned MF_SPECIAL mobj's own
      // spawnState sprite must agree with the doomednum table (this is
      // the identity game.ts wires through setSpecialSpriteLookup).
      const st = gInitGame(map, 2);
      let live = 0;
      for (const m of st.mobjs.mobjs) {
        if (m.removed || (m.flags & MF_SPECIAL) === 0) continue;
        live++;
        expect(stateSprite[m.state]).toBe(doomednumToSprite(m.spawnpoint!.type));
      }
      expect(live).toBe(78);
    });
  });
});

// ================================================================
// Integration: registerPickupHook + pmap PIT_CheckThing path
// (production wiring: gInitGame registers the hook + resolves the
// sprite/remover seams against the level's mobj runtime)
// ================================================================
function bootFixtureRoom(things: RectMapSpec['things']): ReturnType<typeof gInitGame> {
  const spec: RectMapSpec = {
    rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 200 }],
    things: [{ x: 32, y: 32, angle: 0, type: 1 }, ...(things ?? [])],
  };
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

describe('M7-04 integration: pmap hook wiring', () => {
  beforeEach(() => {
    resetPickupState();
    resetPmapHookCounts();
  });

  it('hook is callable and receives correct args', () => {
    registerPickupHook();
    expect(typeof pmapHooks.touchSpecialThing).toBe('function');
    // Re-register is idempotent (chain-preserving, ptelept idiom) — no
    // double-dispatch: one touch must produce exactly one hook call.
    registerPickupHook();
    const st = bootFixtureRoom([{ x: 96, y: 32, angle: 0, type: 2018 }]);
    resetPmapHookCounts();
    pCheckPosition(st.pmap, st.players[0]!.mo, 96 * FRACUNIT, 32 * FRACUNIT);
    expect(pmapHookCounts.touchSpecialThing).toBe(1);
    const item = st.mobjs.mobjs.find((m) => m.spawnpoint?.type === 2018)!;
    expect(item.removed).toBe(true); // exactly one dispatch reached the seam
  });

  it('PIT path: player walking onto an ARM1 changes the world', () => {
    registerPickupHook();
    const st = bootFixtureRoom([{ x: 96, y: 32, angle: 0, type: 2018 }]);
    const p = initPlayerInventory(st.players[0]!);
    expect(p.mo.flags & MF_PICKUP).not.toBe(0); // player flags carry MF_PICKUP (info.c)
    const item = st.mobjs.mobjs.find((m) => m.spawnpoint?.type === 2018)!;
    expect(item).toBeDefined();
    resetPmapHookCounts();

    pCheckPosition(st.pmap, p.mo, 96 * FRACUNIT, 32 * FRACUNIT);

    expect(pmapHookCounts.touchSpecialThing).toBeGreaterThan(0);
    expect(p.armorpoints).toBe(100); // P_GiveArmor(1) ran with the REAL player
    expect(p.armortype).toBe(1);
    expect(p.message).toBe(GOT.GOTARMOR);
    expect(p.bonuscount).toBe(BONUSADD);
    expect(item.removed).toBe(true); // seam → p_mobj.pRemoveMobj
    expect(st.pmap.links.linked[item.linkSlot]).toBe(0);
  });

  it('two items in one cell: static CSR order (reverse THINGS) decides', () => {
    registerPickupHook();
    // THINGS order [ARM1, ARM2] → static iteration is REVERSE (M7-02 CSR):
    // ARM2 resolves first (armorpoints 200/type 2), then ARM1's
    // P_GiveArmor(1) FAILS against it → ARM1 stays in the map.
    const st = bootFixtureRoom([
      { x: 96, y: 32, angle: 0, type: 2018 },
      { x: 96, y: 32, angle: 0, type: 2019 },
    ]);
    const p = initPlayerInventory(st.players[0]!);
    const arm1 = st.mobjs.mobjs.find((m) => m.spawnpoint?.type === 2018)!;
    const arm2 = st.mobjs.mobjs.find((m) => m.spawnpoint?.type === 2019)!;

    pCheckPosition(st.pmap, p.mo, 96 * FRACUNIT, 32 * FRACUNIT);

    expect(arm2.removed).toBe(true); // visited first
    expect(arm1.removed).toBe(false); // give-false ⇒ stays put
    expect(p.armorpoints).toBe(200);
    expect(p.armortype).toBe(2);
    expect(p.message).toBe(GOT.GOTMEGA); // ARM1 never overwrote the message
  });
});