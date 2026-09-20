// sim/ppalette.ts — powerup countdown + palette band selection (M7-06).
//
// Two source blocks, transcribed verbatim:
//
//  1. p_user.c P_PlayerThink, "Counters, time dependend power ups" +
//     "Handling colormaps" (p_user.c:338-383) — the per-tic power decay,
//     the MF_SHADOW clear on invisibility expiry, and the fixedcolormap
//     select. Called from here as {@link pPowerThink}; P_PlayerThink
//     (puser.ts, M7-03's file) owns the ONE call site (this file is the
//     powerup half of it so M7-06 and M7-03 do not edit the same lines).
//  2. st_stuff.c ST_doPaletteStuff (st_stuff.c:1000-1048) minus the
//     I_SetPalette call: {@link paletteBand} returns the PLAYPAL bank
//     index the platform half feeds to framebuffer.buildLut (DECISIONS
//     D-0xx: band selection is sim-side and deterministic, the ST widget
//     itself is M9).
//
// SOURCE CENSUS (mirror /tmp/DOOM-master/linuxdoom-1.10, 62 .c files):
//  * doomdef.h:214-223 powertype_t — pw_invulnerability, pw_strength,
//    pw_invisibility, pw_ironfeet, pw_allmap, pw_infrared, NUMPOWERS = 6.
//    The TS constants live in p_inter_pickup.ts (PW, M7-04) — imported,
//    never re-declared.
//  * doomdef.h:230-236 powerduration_t — INVULNTICS 30·35, INVISTICS 60·35,
//    INFRATICS 120·35, IRONTICS 60·35 (pw_strength/pw_allmap are set to 1
//    by P_GivePower and are NOT countdown powers: strength counts UP,
//    allmap is a plain flag. Neither is decremented anywhere).
//  * DECAY RULE: every countdown power decays EXACTLY −1 per tic
//    (`if (player->powers[k]) player->powers[k]--;`). There is NO
//    `(gameetic&3)` / multiplayer-slowdown rule in 1.10 — `grep -rn
//    gameetic *.c` returns NOTHING (the `>1 && !(gameetic&3)` form is a
//    later-source-port edit; NOT mirrored). The only `&3`-style gating in
//    the powerup path is the FLICKER gate `>4*32 || &8` (below).
//  * p_user.c:41 `#define INVERSECOLORMAP 32` — invulnerability is the
//    INVERTED colormap row 32 (not a red tint), and infrared is row 1
//    ("almost full bright"); both are gated by
//    `powers[k] > 4*32 || powers[k] & 8`, i.e. the power FLICKERS off for
//    the last ~4 seconds in 8-tic phases (bit 3 of the countdown).
//  * MF_SHADOW: set on PICKUP only (p_inter.c:303, inside P_GivePower) and
//    cleared only when the countdown hits 0 (p_user.c:346-347). No per-tic
//    toggling, no M_RANDOMFLASH anywhere in 1.10 (`grep -rn M_RANDOMFLASH`
//    = 0 hits) — the flicker an invisible player shows is the PSPRITE fuzz
//    gate in r_things.c:716-718, which re-reads the same `>4*32 || &8`
//    condition every frame (render-side, see render/psprites.ts).
//  * damagecount/bonuscount decay −1/tic HERE (p_user.c:355-359).
//    P_DeathThink (p_user.c:196-224) has its OWN damagecount decay paths
//    and early-returns before this block (so a dead player's POWERS do not
//    decay at all — pinned by tests/death; that half is M7-03's file).
//  * Band table (st_stuff.c:71-76): STARTREDPALS 1, NUMREDPALS 8,
//    STARTBONUSPALS 9, NUMBONUSPALS 4, RADIATIONPAL 13 → banks 0..13
//    (wad/palettes NUM_PALETTES = 14). INVULNERABILITY AND INFRARED ARE
//    NOT BANDS: they are the fixedcolormap path above (the red/green
//    "bands" are only damage/berserk, pickup bonus and the radiation suit).
//  * The band precedence is the if/else-if chain order, verbatim:
//    cnt(damage∪berserk-fade) → bonuscount → ironfeet flicker → 0.
//
// Zone rules (A-06): imports sim + wad only; no Math.random, no globals.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Player } from './player';
import { MF_SHADOW } from './thinglinks';
import { initPlayerInventory, type PickupPlayer } from './p_inter_inventory';
import { IRONTICS, INFRATICS, INVISTICS, INVULNTICS, PW } from './p_inter_pickup';

/* ------------------------------------------------------------------ */
/* Constants (p_user.c / st_stuff.c)                                   */
/* ------------------------------------------------------------------ */

/** p_user.c:41 `#define INVERSECOLORMAP 32` — the COLORMAP lump row index
 * used for invulnerability (inverted palette, NOT red). */
export const INVERSECOLORMAP = 32;
/** p_user.c:376 — infrared "almost full bright" row. */
export const BRIGHTCOLORMAP = 1;

/** p_user.c:365/373, r_things.c:716, st_stuff.c:1040 all spell the flicker
 * gate as the literal `>4*32 || &8`; named here once. Bit 3 of the
 * countdown is the 8-tic phase bit, so the tail of a power flickers. */
export const FLASHLENGTH = 4 * 32;

/** st_stuff.c:71-76 — PLAYPAL bank layout (bank 0 = normal). */
export const STARTREDPALS = 1;
export const NUMREDPALS = 8;
export const STARTBONUSPALS = 9;
export const NUMBONUSPALS = 4;
export const RADIATIONPAL = 13;

/** doomdef.h:230-236 powerduration_t, indexed by powertype_t (the two
 * non-countdown powers carry their P_GivePower value 1). */
export const POWER_TICS: readonly number[] = [
  INVULNTICS, // pw_invulnerability  30·35 = 1050
  1, //          pw_strength         (counts UP, never decays)
  INVISTICS, //  pw_invisibility     60·35 = 2100
  IRONTICS, //   pw_ironfeet         60·35 = 2100
  1, //          pw_allmap           (flag, never decays)
  INFRATICS //   pw_infrared        120·35 = 4200
];

/* ------------------------------------------------------------------ */
/* Field attach (M7-04/M7-07 pattern: player.ts stays M7-03's)         */
/* ------------------------------------------------------------------ */

/** d_player.h `int damagecount` — the ONLY powerup/palette field the merged
 * InventoryFields (p_inter_inventory.ts) does not carry yet; P_DamageMobj
 * (p_inter.c:875-878, `damagecount += damage` clamped to 100; M7 damage) adds to it and {@link pPowerThink} decays
 * it. Declaration merging is avoided for the reason recorded in
 * p_inter_inventory.ts's header. */
export interface PaletteFields {
  damagecount: number;
}

/** Player + everything the powerup/palette layer reads. */
export type PowerupPlayer = PickupPlayer & PaletteFields;

/** Idempotent attach (same guarded idiom as initPlayerInventory). */
export function attachPowerupFields(p: Player): PowerupPlayer {
  const q = initPlayerInventory(p) as PowerupPlayer;
  if (q.damagecount === undefined) q.damagecount = 0;
  return q;
}

/* ------------------------------------------------------------------ */
/* P_PlayerThink powerup half (p_user.c:338-383)                       */
/* ------------------------------------------------------------------ */

/**
 * p_user.c:339-359 "Counters, time dependend power ups" + :361-383
 * "Handling colormaps", in source order. Field-by-field:
 *
 *   strength   counts UP (`++`) while nonzero — it never expires and the
 *              count only feeds the berserk palette fade below;
 *   invulnerability/infrared/ironfeet  `if (p) p--` (never wraps to −1);
 *   invisibility   `if (!--p) mo->flags &= ~MF_SHADOW` — pre-decrement, so
 *              the flag clears on the tic the counter REACHES 0;
 *   damagecount/bonuscount   `if (c) c--`;
 *   fixedcolormap   invuln→32 / infrared→1 / else 0, each gated by the
 *              `>4*32 || &8` flicker test.
 */
export function pPowerThink(p: PowerupPlayer): void {
  const pw = p.powers;

  // Strength counts up to diminish fade.
  const strength = pw[PW.pw_strength]!;
  if (strength) pw[PW.pw_strength] = strength + 1;

  const invuln = pw[PW.pw_invulnerability]!;
  if (invuln) pw[PW.pw_invulnerability] = invuln - 1;

  const invis = pw[PW.pw_invisibility]!;
  if (invis) {
    // Pre-decrement in C (`if (!--powers[pw_invisibility])`): the shadow
    // flag clears on the tic the counter REACHES 0.
    const left = invis - 1;
    pw[PW.pw_invisibility] = left;
    if (!left) p.mo.flags &= ~MF_SHADOW;
  }

  const infra = pw[PW.pw_infrared]!;
  if (infra) pw[PW.pw_infrared] = infra - 1;

  const iron = pw[PW.pw_ironfeet]!;
  if (iron) pw[PW.pw_ironfeet] = iron - 1;

  if (p.damagecount) p.damagecount--;

  if (p.bonuscount) p.bonuscount--;

  p.fixedcolormap = pFixedColormap(p);
}

/** p_user.c:362-383 as a pure function (test + seam surface). */
export function pFixedColormap(p: PowerupPlayer): number {
  const invuln = p.powers[PW.pw_invulnerability]!;
  if (invuln) {
    return invuln > FLASHLENGTH || invuln & 8 ? INVERSECOLORMAP : 0;
  }
  const infra = p.powers[PW.pw_infrared]!;
  if (infra) {
    return infra > FLASHLENGTH || infra & 8 ? BRIGHTCOLORMAP : 0;
  }
  return 0;
}

/** r_things.c:716-718 — the psprite fuzz gate for an invisible player
 * (renderer reads this through PspriteFrameCtx.invisibility; exported so
 * the render harness does not re-derive the rule). */
export function invisibilityFuzz(tics: number): boolean {
  return tics > FLASHLENGTH || (tics & 8) !== 0;
}

/* ------------------------------------------------------------------ */
/* ST_doPaletteStuff band math (st_stuff.c:1000-1048)                  */
/* ------------------------------------------------------------------ */

/** The three values ST_doPaletteStuff reads off `plyr`. Player and
 * PowerupPlayer both satisfy it. */
export interface PaletteSource {
  readonly damagecount: number;
  readonly bonuscount: number;
  readonly powers: ArrayLike<number>;
}

/**
 * The palette bank index (0..13) ST_doPaletteStuff would hand I_SetPalette,
 * verbatim including the berserk fade `bzc = 12 - (powers[pw_strength]>>6)`
 * folded into `cnt` (it RAISES cnt, it does not replace it: `if (bzc > cnt)
 * cnt = bzc`), the `(cnt+7)>>3` bank mapping, the clamp-then-offset order
 * (`>= NUMREDPALS → NUMREDPALS-1` BEFORE `+= STARTREDPALS`), and the
 * if/else-if precedence (damage beats bonus beats radiation suit beats 0).
 *
 * `bzc` goes negative once powers[pw_strength] ≥ 768 tics (≈22 s) of berserk,
 * after which only a real damagecount can light a red bank — vanilla's
 * "slowly fade the berzerk out" comment.
 */
export function paletteBand(p: PaletteSource): number {
  let cnt = p.damagecount;

  if (p.powers[PW.pw_strength]!) {
    // slowly fade the berzerk out
    const bzc = 12 - (p.powers[PW.pw_strength]! >> 6);
    if (bzc > cnt) cnt = bzc;
  }

  if (cnt) {
    let palette = (cnt + 7) >> 3;
    if (palette >= NUMREDPALS) palette = NUMREDPALS - 1;
    palette += STARTREDPALS;
    return palette;
  }

  if (p.bonuscount) {
    let palette = (p.bonuscount + 7) >> 3;
    if (palette >= NUMBONUSPALS) palette = NUMBONUSPALS - 1;
    palette += STARTBONUSPALS;
    return palette;
  }

  const iron = p.powers[PW.pw_ironfeet]!;
  if (iron > FLASHLENGTH || iron & 8) {
    return RADIATIONPAL;
  }

  return 0;
}

/** Renderer-side encoding of `player->fixedcolormap`: the render seam uses
 * −1 for the C NULL pointer (`fixedcolormap = 0`) and the row index
 * otherwise (view.ts ViewState.fixedcolormap contract). */
export function fixedColormapView(fixedcolormap: number): number {
  return fixedcolormap ? fixedcolormap : -1;
}
