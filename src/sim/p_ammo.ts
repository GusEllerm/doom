// sim/p_ammo.ts — M7-05: ammo economy + weapon switching + P_CheckAmmo.
//
// The ownership/ammo layer between the pickups (M7-04, p_inter_pickup.ts —
// which OWNS P_GiveAmmo/GiveWeapon/GiveBody/GiveArmor/GiveCard/GivePower)
// and the psprite machine (M7-07, p_pspr.ts). This module owns:
//
//   * P_CheckAmmo (p_pspr.c:158-215) — the out-of-ammo auto-switch ladder,
//     registered on p_pspr's typed `checkAmmo` seam (the faithful
//     p_pspr-local default is replaced here per that file's merge note);
//   * the BT_CHANGE weapon-switch block of P_PlayerThink
//     (p_user.c:291-323), registered on puser's `weaponChange` seam;
//   * the p_inter.c `maxammo[NUMAMMO]` capacity table consumed by
//     G_PlayerReborn (g_game.c:830 `p->maxammo[i] = maxammo[i];`).
//
// NOT here: fire-cost consumption (the A_Fire* actions decrement
// player.ammo[] themselves — p_shoot.ts / the fire-actions task), powerup
// counters and durations (parallel powerups task owns the `powers` fields).
//
// 1.10 truth (R08 §5): weapon keys encode into the ticcmd
// (BT_CHANGE | slot<<BT_WEAPONSHIFT, g_game.c:341-347, M7-05 wires the
// G_BuildTiccmd loop); there is NO next/prev cycle loop in 1.10 — slot
// digits are the only switch input, with the fist→chainsaw and (commercial
// only) shotgun→supershotgun slot upgrades.
//
// gamemode encoding (shared with the p_pspr ladder default):
// 0 = shareware, 1 = registered (default; doom1/Freedoom ≈ 1), 2 =
// commercial — `!== 0` gates plasma/BFG, `=== 2` gates the SSG.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  AM_CELL,
  AM_CLIP,
  AM_MISL,
  AM_NOAMMO,
  AM_SHELL,
  BFGCELLS,
  PS_WEAPON,
  WEAPONINFO,
  WP_BFG,
  WP_CHAINSAW,
  WP_CHAINGUN,
  WP_FIST,
  WP_MISSILE,
  WP_NOCHANGE,
  WP_PISTOL,
  WP_PLASMA,
  WP_SHOTGUN,
  WP_SUPERSHOTGUN,
  psprGlobals,
  pSetPsprite,
  registerPsprHook,
  type PsprPlayer,
} from './p_pspr';
import { puserHooks } from './puser';
import { BT_WEAPONMASK, BT_WEAPONSHIFT } from './ticcmd';
import type { Player } from './player';

/* ------------------------------------------------------------------ */
/* Capacity table (p_inter.c:33 `int maxammo[NUMAMMO]`)                 */
/* ------------------------------------------------------------------ */

/** p_inter.c:33 `int maxammo[NUMAMMO] = {200, 50, 300, 50};` —
 * clip/shell/cell/rocket. No episode- or skill-based variants exist in
 * 1.10: skill only DOUBLES pickup amounts in P_GiveAmmo (baby/nightmare,
 * M7-04) and episodes gate nothing in the ammo economy (R08 §10 —
 * "No skill-based starting ammo in 1.10"). Consumed by G_PlayerReborn's
 * reset (g_game.c:830) — a backpack's doubling is therefore LOST on
 * respawn, verbatim. */
export const MAXAMMO: readonly number[] = [200, 50, 300, 50];

/* ------------------------------------------------------------------ */
/* P_CheckAmmo — p_pspr.c:158-215                                       */
/* ------------------------------------------------------------------ */

/**
 * `P_CheckAmmo(player)` verbatim: if the ready weapon's ammo covers ONE
 * shot (BFG 40 cells, super shotgun 2 shells, everything else 1 — and
 * weapons with `am_noammo` always pass) return TRUE unchanged; else walk
 * the preference ladder, set `pendingweapon`, force the ready weapon's
 * `downstate` psprite (A_Lower then brings the chosen weapon up), and
 * return FALSE.
 *
 * Ladder, in source order (R08 §0.4/p_pspr.c:169-208):
 *   plasma  (owned && cell > 0 && gamemode != shareware)
 *   supershotgun (owned && shell > 2 && gamemode == commercial)
 *   chaingun (owned && clip)
 *   shotgun  (owned && shell)
 *   pistol   (clip — NO weaponowned check: it is the fallback weapon)
 *   chainsaw (owned)
 *   missile  (owned && misl)
 *   BFG      (owned && cell > 40 && gamemode != shareware)
 *   fist     (everything failed)
 */
export function pCheckAmmo(p: PsprPlayer): boolean {
  const ammo = WEAPONINFO[p.readyweapon]!.ammo;

  // Minimal amount for one shot varies.
  let count: number;
  if (p.readyweapon === WP_BFG) count = BFGCELLS;
  else if (p.readyweapon === WP_SUPERSHOTGUN) count = 2; // Double barrel.
  else count = 1; // Regular.

  // Some do not need ammunition anyway. Return if sufficient.
  if (ammo === AM_NOAMMO || p.ammo[ammo]! >= count) return true;

  // Out of ammo, pick a weapon to change to. Preferences are set here.
  // (The do-while is vestigial: every branch assigns — pinned faithful.)
  do {
    if (p.weaponowned[WP_PLASMA]! && p.ammo[AM_CELL]! && psprGlobals.gamemode !== 0) {
      p.pendingweapon = WP_PLASMA;
    } else if (
      p.weaponowned[WP_SUPERSHOTGUN]! &&
      p.ammo[AM_SHELL]! > 2 &&
      psprGlobals.gamemode === 2
    ) {
      p.pendingweapon = WP_SUPERSHOTGUN;
    } else if (p.weaponowned[WP_CHAINGUN]! && p.ammo[AM_CLIP]!) {
      p.pendingweapon = WP_CHAINGUN;
    } else if (p.weaponowned[WP_SHOTGUN]! && p.ammo[AM_SHELL]!) {
      p.pendingweapon = WP_SHOTGUN;
    } else if (p.ammo[AM_CLIP]!) {
      p.pendingweapon = WP_PISTOL;
    } else if (p.weaponowned[WP_CHAINSAW]!) {
      p.pendingweapon = WP_CHAINSAW;
    } else if (p.weaponowned[WP_MISSILE]! && p.ammo[AM_MISL]!) {
      p.pendingweapon = WP_MISSILE;
    } else if (
      p.weaponowned[WP_BFG]! &&
      p.ammo[AM_CELL]! > 40 &&
      psprGlobals.gamemode !== 0
    ) {
      p.pendingweapon = WP_BFG;
    } else {
      // If everything fails.
      p.pendingweapon = WP_FIST;
    }
  } while (p.pendingweapon === WP_NOCHANGE);

  // Now set appropriate weapon overlay.
  pSetPsprite(p, PS_WEAPON, WEAPONINFO[p.readyweapon]!.downstate);

  return false;
}

/* ------------------------------------------------------------------ */
/* BT_CHANGE weapon switch — p_user.c:291-323                            */
/* ------------------------------------------------------------------ */

/**
 * The `if (cmd->buttons & BT_CHANGE)` block of P_PlayerThink, verbatim
 * ("The actual changing of a weapon is done when the weapon psprite can do
 * it — read: not in the middle of an attack", p_user.c:294-296): decode the
 * slot from BT_WEAPONMASK, apply the fist→chainsaw upgrade (p_user.c:297-
 * 305) and the commercial-only shotgun→supershotgun upgrade (p_user.c:307-
 * 314), then set `pendingweapon` iff owned, different, and not plasma/BFG
 * while gamemode is shareware ("even if cheated"). Lowering/raising is
 * deferred to A_WeaponReady — setting pendingweapon mid-raise/mid-fire is
 * therefore ALWAYS legal and just re-targets the raise machine.
 *
 * There is no next/prev cycling in 1.10 (R08 §5.1) — nothing to skip.
 */
export function pWeaponChange(p: PsprPlayer): void {
  const cmd = p.cmd;
  let newweapon = (cmd.buttons & BT_WEAPONMASK) >> BT_WEAPONSHIFT;

  if (newweapon === WP_FIST && p.weaponowned[WP_CHAINSAW]! && p.readyweapon !== WP_CHAINSAW) {
    newweapon = WP_CHAINSAW;
  }

  if (
    psprGlobals.gamemode === 2 && // `commercial`
    p.weaponowned[WP_SUPERSHOTGUN]! &&
    newweapon === WP_SHOTGUN &&
    p.readyweapon !== WP_SUPERSHOTGUN
  ) {
    newweapon = WP_SUPERSHOTGUN;
  }

  if (p.weaponowned[newweapon]! && newweapon !== p.readyweapon) {
    // Do not go to plasma or BFG in shareware, even if cheated.
    if ((newweapon !== WP_PLASMA && newweapon !== WP_BFG) || psprGlobals.gamemode !== 0) {
      p.pendingweapon = newweapon;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Seam registration (game.ts gInitGame calls this, M7-04 precedent)     */
/* ------------------------------------------------------------------ */

/** Replace p_pspr's default ladder (standalone-testable copy) with this
 * module's authoritative one and bind the p_user.ts BT_CHANGE seam.
 * Idempotent; tests may call resetPsprHooks()/resetPuserHookCounts() and
 * re-register. */
export function registerAmmoHooks(): void {
  registerPsprHook('checkAmmo', pCheckAmmo);
  puserHooks.weaponChange = (p: Player) => {
    pWeaponChange(p as PsprPlayer);
  };
}

/** Rebind the gamemode gate (doomstat.h `gamemode`; shared with the
 * p_pspr.ts ladder default via psprGlobals — ONE source). */
export function setAmmoGamemode(mode: 0 | 1 | 2): void {
  psprGlobals.gamemode = mode;
}
