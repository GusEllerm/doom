// wad/info/weaponinfo.ts — weaponinfo[NUMWEAPONS] of d_items.c
// (linuxdoom-1.10, d_items.c:47-138), transcribed verbatim; R08 §2.1.
// Enum orders from doomdef.h: weaponindex_t wp_fist..wp_supershotgun
// (wp_nochange=9), ammo_t am_clip/am_shell/am_cell/am_misl/am_noammo.
// Supershotgun stays dead-coded for Doom 1 / Freedoom Phase 1 (M7-plan §6.5).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** doomdef.h:180-195 weapontype_t. Values are the C values: `NUMWEAPONS` sits
 *  BEFORE `wp_nochange`, so wp_nochange is 10 (doomdef.h:189-193). */
export const WP = {
  wp_fist: 0,
  wp_pistol: 1,
  wp_shotgun: 2,
  wp_chaingun: 3,
  wp_missile: 4,
  wp_plasma: 5,
  wp_bfg: 6,
  wp_chainsaw: 7,
  wp_supershotgun: 8,
  wp_nochange: 10,
} as const
/** doomdef.h:191 NUMWEAPONS (weapon slots, NOT including wp_nochange). */
export const NUMWEAPONS = 9

/** doomdef.h:201-209 ammotype_t. Values are the C values: `NUMAMMO` sits
 *  BEFORE `am_noammo`, so am_noammo is 5 (d_items.c's fist/chainsaw rows
 *  carry am_noammo, never used as a maxammo[]/clipammo[] index — those
 *  arrays are NUMAMMO=4 long, guarded by the ammo!=am_noammo tests). */
export const AMMO = {
  am_clip: 0,
  am_shell: 1,
  am_cell: 2,
  am_misl: 3,
  am_noammo: 5,
} as const
/** doomdef.h:206 NUMAMMO (ammunition kinds, NOT including am_noammo). */
export const NUMAMMO = 4

/** weaponinfo_t — ammo type + the five psprite state chains. */
export interface WeaponInfo {
  ammo: number
  upState: number
  downState: number
  readyState: number
  atkState: number
  flashState: number
}

export const weaponinfo: readonly WeaponInfo[] = [
  { ammo: AMMO.am_noammo, upState: 4, downState: 3, readyState: 2, atkState: 5, flashState: 0 },
  { ammo: 0, upState: 12, downState: 11, readyState: 10, atkState: 13, flashState: 17 },
  { ammo: 1, upState: 20, downState: 19, readyState: 18, atkState: 21, flashState: 30 },
  { ammo: 0, upState: 51, downState: 50, readyState: 49, atkState: 52, flashState: 55 },
  { ammo: 3, upState: 59, downState: 58, readyState: 57, atkState: 60, flashState: 63 },
  { ammo: 2, upState: 76, downState: 75, readyState: 74, atkState: 77, flashState: 79 },
  { ammo: 2, upState: 83, downState: 82, readyState: 81, atkState: 84, flashState: 88 },
  { ammo: AMMO.am_noammo, upState: 70, downState: 69, readyState: 67, atkState: 71, flashState: 0 },
  { ammo: 1, upState: 34, downState: 33, readyState: 32, atkState: 35, flashState: 47 },
]
