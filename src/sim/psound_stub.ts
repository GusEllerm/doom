// sim/psound_stub.ts — sfx id table + S_StartSound enqueue slot (M7-06).
//
// M10 owns real audio (s_sound.c channels, i_sound.c). Until then the ONLY
// observable half of S_StartSound is the counted M6-01 hook slot
// (sim/hooks.ts `sfxSlot`, SfxEvent {id,x,y,z,tic}) — this module supplies
// what that slot was missing: (a) the sounds.h sfxenum_t NUMBER for every
// sfx_* token the port already carries as a string (mobjinfo sounds,
// p_inter_pickup's pickup `sound` variable, p_pspr's hand-pinned SFX_*), and
// (b) the S_StartSound(origin, sfx_id) envelope — origin coords for a mobj,
// (0,0,0) for the NULL origin vanilla uses for listener-position sounds
// (s_sound.c S_StartSound: `origin == NULL ⇒ 0,0,0`).
//
// The table is GENERATED-VERIFIED against the mirror, not transcribed by
// hand: order = sounds.h enum, sfx_None = 0 … sfx_radio = 108, NUMSFX = 109.
// Cross-checks against the pins already on main: p_pspr.ts SFX_PISTOL 1 /
// SFX_SHOTGN 2 / SFX_DSHTGN 4 / SFX_SAWHIT 13 / SFX_PUNCH 83,
// pdoors.ts SFX_DOROPN 20 / SFX_DORCLS 21 / SFX_BDOPN 88 / SFX_BDCLS 89 /
// SFX_OOF 34, pswitch.ts SFX_SWTCHN 23, ptelept.ts SFX_TELEPT 35 — all
// match this table (they stay where they are; nothing moved).
//
// SITE LEDGER (plan §M7-06 acceptance 3 — "fire/pickup/explode sites
// enumerated"). `grep -n S_StartSound` over the mirror's 62 .c files:
//   LIVE in this port today (call sites exist and reach sfxSlot):
//     pdoors.ts     door / blast door               20 doropn, 21 dorcls,
//                                                    88 bdopn, 89 bdcls, 34 oof
//     pplats.ts     plat start/stop/move             18 pstart, 19 pstop,
//                                                    22 stnmov
//     pswitch.ts    switch use / fail / locked        23 swtchn, 24 swtchx,
//                                                    34 oof, 81 noway
//     pspec.ts      crossed switch                    23 swtchn
//     ptelept.ts    teleport                          35 telept
//     p_inter_pickup.ts (M7-04) pickup tail           32 itemup, 33 wpnup,
//                                                    93 getpow ← bridged here
//   NOT YET EMITTED (owner task pins the site; enumerated, not faked):
//     weapon fire   p_pspr.c A_Fire*/A_Saw/A_WeaponReady — the SFX_* ids are
//                   already pinned in p_pspr.ts (1 pistol, 2 shotgn, 4 dshtgn,
//                   9 bfg, 10-13 saw*, 14 rlaunc, 86 chgun) but p_pspr does not
//                   call the slot yet (M7-07's file, untouched here)
//     impacts       p_map.c:1104 sfx_noway (81), PTR_ShootTraverse puff /
//                   blood sfx_slop (31) — M7-08
//     explosions    p_mobj.c:103 deathsound, A_Explode — sfx_barexp (82),
//                   sfx_rxplod (15), sfx_firxpl (17) — M7-09/M8
//     player pain   NOT in p_inter.c: `grep -c sfx_ p_inter.c` = 17 and
//                   P_DamageMobj calls S_StartSound NOWHERE — the hurt sound
//                   comes from the state action A_Pain (p_enemy.c:1576-1580)
//                   reading mobjinfo MT_PLAYER.painSound = sfx_plpain (25);
//                   P_KillMobj's deathsound half is p_mobj.c:103 (M7-02/03)
//     P_NoiseAlert  EXISTS in 1.10 (p_enemy.c:159, called by p_pspr.c:256 in
//                   P_FireWeapon and by A_Look/A_Chase wakes) — noise is
//                   itself an S_StartSound-free thinker scan; M7-plan §0
//                   keeps the call sites as counted stubs (M8)
//   NO powerup-specific sfx EXISTS in 1.10: powers borrow sfx_getpow (93) at
//   pickup only (p_inter.c:406/416/492/501/508/515/522/529), with sfx_itemup
//   (32) as the default tail and sfx_wpnup (33) for weapons. No activation,
//   expiry or tick sound anywhere — and sfx_sit is not a powerup sound at all
//   (`grep sfx_sit` = 0 hits; the *sit ids are the monster sit-up family
//   sfx_posit1-3/sfx_bgsit1-2).
//
// Zone rules (A-06): sim zone, imports sim only.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { sfxSlot, type HookSlots } from './hooks';
import { setPickupSoundHook } from './p_inter_pickup';

/** sounds.h sfxenum_t (order-exact; 0..108, NUMSFX = 109). */
export const SFX_ID = {
  sfx_None: 0,
  sfx_pistol: 1,
  sfx_shotgn: 2,
  sfx_sgcock: 3,
  sfx_dshtgn: 4,
  sfx_dbopn: 5,
  sfx_dbcls: 6,
  sfx_dbload: 7,
  sfx_plasma: 8,
  sfx_bfg: 9,
  sfx_sawup: 10,
  sfx_sawidl: 11,
  sfx_sawful: 12,
  sfx_sawhit: 13,
  sfx_rlaunc: 14,
  sfx_rxplod: 15,
  sfx_firsht: 16,
  sfx_firxpl: 17,
  sfx_pstart: 18,
  sfx_pstop: 19,
  sfx_doropn: 20,
  sfx_dorcls: 21,
  sfx_stnmov: 22,
  sfx_swtchn: 23,
  sfx_swtchx: 24,
  sfx_plpain: 25,
  sfx_dmpain: 26,
  sfx_popain: 27,
  sfx_vipain: 28,
  sfx_mnpain: 29,
  sfx_pepain: 30,
  sfx_slop: 31,
  sfx_itemup: 32,
  sfx_wpnup: 33,
  sfx_oof: 34,
  sfx_telept: 35,
  sfx_posit1: 36,
  sfx_posit2: 37,
  sfx_posit3: 38,
  sfx_bgsit1: 39,
  sfx_bgsit2: 40,
  sfx_sgtsit: 41,
  sfx_cacsit: 42,
  sfx_brssit: 43,
  sfx_cybsit: 44,
  sfx_spisit: 45,
  sfx_bspsit: 46,
  sfx_kntsit: 47,
  sfx_vilsit: 48,
  sfx_mansit: 49,
  sfx_pesit: 50,
  sfx_sklatk: 51,
  sfx_sgtatk: 52,
  sfx_skepch: 53,
  sfx_vilatk: 54,
  sfx_claw: 55,
  sfx_skeswg: 56,
  sfx_pldeth: 57,
  sfx_pdiehi: 58,
  sfx_podth1: 59,
  sfx_podth2: 60,
  sfx_podth3: 61,
  sfx_bgdth1: 62,
  sfx_bgdth2: 63,
  sfx_sgtdth: 64,
  sfx_cacdth: 65,
  sfx_skldth: 66,
  sfx_brsdth: 67,
  sfx_cybdth: 68,
  sfx_spidth: 69,
  sfx_bspdth: 70,
  sfx_vildth: 71,
  sfx_kntdth: 72,
  sfx_pedth: 73,
  sfx_skedth: 74,
  sfx_posact: 75,
  sfx_bgact: 76,
  sfx_dmact: 77,
  sfx_bspact: 78,
  sfx_bspwlk: 79,
  sfx_vilact: 80,
  sfx_noway: 81,
  sfx_barexp: 82,
  sfx_punch: 83,
  sfx_hoof: 84,
  sfx_metal: 85,
  sfx_chgun: 86,
  sfx_tink: 87,
  sfx_bdopn: 88,
  sfx_bdcls: 89,
  sfx_itmbk: 90,
  sfx_flame: 91,
  sfx_flamst: 92,
  sfx_getpow: 93,
  sfx_bospit: 94,
  sfx_boscub: 95,
  sfx_bossit: 96,
  sfx_bospn: 97,
  sfx_bosdth: 98,
  sfx_manatk: 99,
  sfx_mandth: 100,
  sfx_sssit: 101,
  sfx_ssdth: 102,
  sfx_keenpn: 103,
  sfx_keendt: 104,
  sfx_skeact: 105,
  sfx_skesit: 106,
  sfx_skeatk: 107,
  sfx_radio: 108,} as const;

/** sounds.h NUMSFX. */
export const NUMSFX = 109;

/** The string tokens the port carries (mobjinfo sounds use these, plus the
 * literal '0' where info.c writes a bare 0 = no sound). */
export function resolveSfxId(token: string): number {
  if (token === '0') return 0; // info.c writes a bare `0` in 15 mobjinfo slots
  const id = (SFX_ID as Record<string, number>)[token];
  if (id === undefined) throw new Error(`resolveSfxId: not an sfxenum_t name: ${token}`);
  return id;
}

/** Read-view of an origin mobj (mobj_t x/y/z). */
export interface SfxOrigin {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * S_StartSound(origin, sfx_id) — the enqueue half only (M10 replaces the
 * body with the channel mixer; call sites never change, M6-plan §0.10).
 * `origin = null` is vanilla's listener-position form (S_StartSound(NULL, …)
 * for the consoleplayer's own sounds — the pickup tail, door oof, menu).
 */
export function sStartSound(
  h: HookSlots,
  id: number,
  origin: SfxOrigin | null,
  tic: number
): void {
  sfxSlot(h, id, origin ? origin.x : 0, origin ? origin.y : 0, origin ? origin.z : 0, tic);
}

/**
 * Bridge the M7-04 pickup sound tail (a string token) onto the numeric hook
 * slot. Installed by the game bootstrap; reset by resetPickupHooks().
 * `origin = NULL` verbatim (p_inter.c:655 S_StartSound(NULL, sound)).
 */
export function installPickupSfxBridge(h: HookSlots, getTic: () => number): void {
  setPickupSoundHook((token: string) => {
    sStartSound(h, resolveSfxId(token), null, getTic());
  });
}
