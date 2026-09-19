// sim/p_pspr.ts — psprite state machine (p_pspr.c TRANSLATION, M7-07).
//
// Mirror: /tmp/DOOM-master/linuxdoom-1.10/p_pspr.c (62-.c mirror check:
// p_pspr.c is THIS file's source of truth; the state rows are transcribed
// verbatim from the same tree's info.c/info.h, weaponinfo from d_items.c).
//
// Scope notes (docs/design/M7-plan.md §M7-07):
//  * LOCAL STATE SHAPE: the M7-01 tables (src/wad/info/{states,weaponinfo})
//    are NOT merged on main, so this module carries a local, statenum-keyed
//    subset `PSPR_STATES` (rows 0..89 = the psprite-relevant range of the
//    967-row states[], indices = info.h statenum_t order, so the info.c
//    `state - states` arithmetic incl. the A_FireCGun
//    `flashstate + psp->state - &states[S_CHAIN1]` trick stays exact) and a
//    local `WEAPONINFO` (d_items.c order). FOLLOW-UP (M7-01 merge): swap
//    these two consts for the generated tables — row shapes are identical,
//    actions move to the a_actions.ts ActionId registry; no call site here
//    changes.
//  * FIRE-DEPENDENCY SLOTS (plan: "fire actions arrive as registry slots"):
//    every call p_pspr.c makes into ANOTHER task's file (P_SetMobjState →
//    M7-02/03, P_AimLineAttack/P_LineAttack/P_BulletSlope → M7-08,
//    P_SpawnPlayerMissile → M7-09, P_NoiseAlert → M8, S_StartSound →
//    M7-06/M10, P_CheckAmmo → M7-05) goes through {@link psprHooks} — typed,
//    counted, faithful-default slots. Registering a replacement changes the
//    BODY, never a call site (hooks.ts idiom).
//  * PLAYER FIELDS: the weapon/psprite fields p_pspr.c reads (psprites,
//    readyweapon, pendingweapon, attackdown, refire, ammo, weaponowned,
//    powers, extralight) do NOT exist on sim/player.ts Player yet (M7-03
//    owns that extension). {@link attachPsprFields} adds them in-place with
//    G_PlayerReborn/G_InitNew defaults (fists+pistol+50 clips,
//    usedown/attackdown true per R08 §10). hashState (sim/state.ts) does not
//    serialize them ⇒ ALL existing goldens stay byte-identical (documented;
//    M7-10 re-bless adds psprite fields to the hash).
//  * CALL SITES (1.10 exact): P_SetupPsprites ← G_InitNew/P_SpawnPlayer
//    path (g_game.c); P_MovePsprites ← P_PlayerThink (p_user.c:381, after
//    the weapon-change/use blocks, leveltime-gated); P_FireWeapon ← the
//    A_WeaponReady/A_ReFire chain. p_user.ts (M5-owned) is NOT edited here:
//    FOLLOW-UP (M7-03) wires `pMovePsprites(p, leveltime)` into
//    pPlayerThink at the p_user.c:381 position.
//
// Zone discipline (eslint doom/zones/sim): imports core + sim only.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  ANG90,
  FINEMASK,
  FRACBITS,
  FRACUNIT,
} from '../core/constants';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import type { Player } from './player';
import { PST_DEAD } from './player';
import type { PrngState } from './prng';
import { pRandom } from './prng';
import { BT_ATTACK } from './ticcmd';

/* ------------------------------------------------------------------ */
/* p_pspr.c defines (#defines)                                         */
/* ------------------------------------------------------------------ */

/** p_pspr.c:37-38 — `#define LOWERSPEED/RAISESPEED FRACUNIT*6`. */
export const LOWERSPEED = 6 * FRACUNIT;
export const RAISESPEED = 6 * FRACUNIT;

/** p_pspr.c:40-41 — off-screen / at-rest screen y. 96 units apart at 6/tic
 * ⇒ raise/lower are EXACTLY 16 tics (R08 §1.3). */
export const WEAPONBOTTOM = 128 * FRACUNIT;
export const WEAPONTOP = 32 * FRACUNIT;

/** p_pspr.c:44 — `#define BFGCELLS 40` (plasma cells per BFG shot). */
export const BFGCELLS = 40;

/** p_local.h:57-58 — fire-action ranges (hitscan internals = M7-08). */
export const MELEERANGE = 64 * FRACUNIT;
export const MISSILERANGE = 32 * 64 * FRACUNIT;

/** p_pspr.h psprnum_t. */
export const PS_WEAPON = 0;
export const PS_FLASH = 1;
export const NUMPSPRITES = 2;

/** doomdef.h weapontype_t (wp_nochange = 10 — after NUMWEAPONS=9). */
export const WP_FIST = 0;
export const WP_PISTOL = 1;
export const WP_SHOTGUN = 2;
export const WP_CHAINGUN = 3;
export const WP_MISSILE = 4;
export const WP_PLASMA = 5;
export const WP_BFG = 6;
export const WP_CHAINSAW = 7;
export const WP_SUPERSHOTGUN = 8;
export const NUMWEAPONS = 9;
export const WP_NOCHANGE = 10;

/** doomdef.h ammotype_t (am_noammo = 5 — after NUMAMMO=4). */
export const AM_CLIP = 0;
export const AM_SHELL = 1;
export const AM_CELL = 2;
export const AM_MISL = 3;
export const NUMAMMO = 4;
export const AM_NOAMMO = 5;

/** doomdef.h powerentype (pw_strength = 0; berserk). */
export const PW_STRENGTH = 0;
export const PW_INVISIBILITY = 1;
export const NUMPOWERS = 6;

/** sounds.h sfxenum_t indices of the sfx p_pspr.c names (M7-06/M10 owns the
 * full table; values pinned against the mirror). */
export const SFX_PISTOL = 1;
export const SFX_SHOTGN = 2;
export const SFX_DSHTGN = 4;
export const SFX_BFG = 9;
export const SFX_SAWUP = 10;
export const SFX_SAWIDL = 11;
export const SFX_SAWFUL = 12;
export const SFX_SAWHIT = 13;
export const SFX_PUNCH = 83;

/** info.h statenum_t — the psprite-relevant subset (indices = info.c
 * states[] row order, 967 rows; see header for the M7-01 swap note). */
export const S_NULL = 0;
export const S_LIGHTDONE = 1;
export const S_PUNCH = 2;
export const S_PUNCHDOWN = 3;
export const S_PUNCHUP = 4;
export const S_PUNCH1 = 5;
export const S_PUNCH2 = 6;
export const S_PUNCH3 = 7;
export const S_PUNCH4 = 8;
export const S_PUNCH5 = 9;
export const S_PISTOL = 10;
export const S_PISTOLDOWN = 11;
export const S_PISTOLUP = 12;
export const S_PISTOL1 = 13;
export const S_PISTOL2 = 14;
export const S_PISTOL3 = 15;
export const S_PISTOL4 = 16;
export const S_PISTOLFLASH = 17;
export const S_SGUN = 18;
export const S_SGUNDOWN = 19;
export const S_SGUNUP = 20;
export const S_SGUN1 = 21;
export const S_SGUN2 = 22;
export const S_SGUN3 = 23;
export const S_SGUN4 = 24;
export const S_SGUN5 = 25;
export const S_SGUN6 = 26;
export const S_SGUN7 = 27;
export const S_SGUN8 = 28;
export const S_SGUN9 = 29;
export const S_SGUNFLASH1 = 30;
export const S_SGUNFLASH2 = 31;
export const S_DSGUN = 32;
export const S_DSGUNDOWN = 33;
export const S_DSGUNUP = 34;
export const S_DSGUN1 = 35;
export const S_DSGUN2 = 36;
export const S_DSGUN3 = 37;
export const S_DSGUN4 = 38;
export const S_DSGUN5 = 39;
export const S_DSGUN6 = 40;
export const S_DSGUN7 = 41;
export const S_DSGUN8 = 42;
export const S_DSGUN9 = 43;
export const S_DSGUN10 = 44;
export const S_DSNR1 = 45;
export const S_DSNR2 = 46;
export const S_DSGUNFLASH1 = 47;
export const S_DSGUNFLASH2 = 48;
export const S_CHAIN = 49;
export const S_CHAINDOWN = 50;
export const S_CHAINUP = 51;
export const S_CHAIN1 = 52;
export const S_CHAIN2 = 53;
export const S_CHAIN3 = 54;
export const S_CHAINFLASH1 = 55;
export const S_CHAINFLASH2 = 56;
export const S_MISSILE = 57;
export const S_MISSILEDOWN = 58;
export const S_MISSILEUP = 59;
export const S_MISSILE1 = 60;
export const S_MISSILE2 = 61;
export const S_MISSILE3 = 62;
export const S_MISSILEFLASH1 = 63;
export const S_MISSILEFLASH2 = 64;
export const S_MISSILEFLASH3 = 65;
export const S_MISSILEFLASH4 = 66;
export const S_SAW = 67;
export const S_SAWB = 68;
export const S_SAWDOWN = 69;
export const S_SAWUP = 70;
export const S_SAW1 = 71;
export const S_SAW2 = 72;
export const S_SAW3 = 73;
export const S_PLASMA = 74;
export const S_PLASMADOWN = 75;
export const S_PLASMAUP = 76;
export const S_PLASMA1 = 77;
export const S_PLASMA2 = 78;
export const S_PLASMAFLASH1 = 79;
export const S_PLASMAFLASH2 = 80;
export const S_BFG = 81;
export const S_BFGDOWN = 82;
export const S_BFGUP = 83;
export const S_BFG1 = 84;
export const S_BFG2 = 85;
export const S_BFG3 = 86;
export const S_BFG4 = 87;
export const S_BFGFLASH1 = 88;
export const S_BFGFLASH2 = 89;

/** info.h — the player attack mobj states p_pspr.c sets through
 * P_SetMobjState (mobj-side states = M7-02/03; only the NUMBERS live here
 * because the call sites are in this file). */
export const S_PLAY = 149;
export const S_PLAY_ATK1 = 154;
export const S_PLAY_ATK2 = 155;

/* ------------------------------------------------------------------ */
/* pspdef_t / player fields (see header for the M7-03 note)            */
/* ------------------------------------------------------------------ */

/** p_pspr.h pspdef_t. `state` is a statenum; 0 = S_NULL = "not active"
 * (vanilla NULL and S_NULL converge to the same observable: the psp stops
 * advancing and draws nothing — P_SetPsprite's `!stnum` removal and the
 * A_Lower/P_SetPsprite(S_NULL) death path both land on 0). */
export interface PspDef {
  state: number;
  tics: number;
  sx: number;
  sy: number;
}

/** The d_player.h player_t fields p_pspr.c reads/writes, absent from
 * sim/player.ts until M7-03 owns the extension. */
export interface PsprFields {
  /** d_player.h `psprite_t psprites[NUMPSPRITES]`. */
  psprites: PspDef[];
  readyweapon: number;
  pendingweapon: number;
  /** boolean in C (d_player.h); `true` after a missile/BFG shot until the
   * fire button releases (p_user.c/G_BuildTiccmd keeps it false-ish). */
  attackdown: boolean;
  refire: number;
  ammo: Int32Array;
  weaponowned: Int32Array;
  powers: Int32Array;
  /** d_player.h `int extralight` — A_Light0/1/2 write, R_DrawPlayerSprites
   * reads (render view layer). */
  extralight: number;
}

export type PsprPlayer = Player & PsprFields;

/** In-place field attach (G_PlayerReborn defaults, R08 §10: fists + pistol
 * + 50 clips; usedown/attackdown start TRUE — usedown belongs to p_user.ts,
 * only attackdown is ours). Idempotent. Tests and the future p_user wiring
 * call this; M7-03 folds the fields into createPlayer and keeps this as the
 * no-op fallback. */
export function attachPsprFields(p: Player): PsprPlayer {
  const q = p as Partial<PsprFields> as PsprPlayer;
  if (q.psprites === undefined) {
    q.psprites = [
      { state: 0, tics: 0, sx: 0, sy: 0 },
      { state: 0, tics: 0, sx: 0, sy: 0 },
    ];
    q.readyweapon = WP_FIST;
    q.pendingweapon = WP_NOCHANGE;
    q.attackdown = true; // G_PlayerReborn: usedown/attackdown = true
    q.refire = 0;
    q.ammo = new Int32Array(NUMAMMO);
    q.weaponowned = new Int32Array(NUMWEAPONS);
    q.powers = new Int32Array(NUMPOWERS);
    q.extralight = 0;
    // G_PlayerReborn weapon init (g_game.c): fists + pistol, 50 clips.
    q.weaponowned[WP_FIST] = 1;
    q.weaponowned[WP_PISTOL] = 1;
    q.ammo[AM_CLIP] = 50;
  }
  return q;
}

/* ------------------------------------------------------------------ */
// info.c states[] — psprite subset (see header; action fields resolved to
// the module functions below). sprite = spritedef_t index, frame carries
// FF_FULLBRIGHT (0x8000, p_pspr.h).
// ------------------------------------------------------------------ */

export type PsprAction = (player: PsprPlayer, psp: PspDef) => void;

export interface PsprStateRow {
  /** spritedef_t index (SPR_PUNG = 2 etc.). */
  readonly sprite: number;
  /** frame | FF_FULLBRIGHT. */
  readonly frame: number;
  /** i16 in the generated tables; -1 = forever, 0 = 0-tic cascade. */
  readonly tics: number;
  /** action, null for {NULL}. */
  readonly action: PsprAction | null;
  /** statenum (0 = S_NULL removes). */
  readonly next: number;
  readonly misc1: number;
  readonly misc2: number;
}

/** Sparse by statenum (rows 0..89; the psprite machine never enters a row
 * above 89 — player/mobj states are M7-02/03 territory). */
export const PSPR_STATES: (PsprStateRow | undefined)[] = [];

/** d_items.c:47-138 weaponinfo[NUMWEAPONS] — verbatim {ammo, up, down,
 * ready, atk, flash}. */
export interface WeaponRow {
  readonly ammo: number;
  readonly upstate: number;
  readonly downstate: number;
  readonly readystate: number;
  readonly atkstate: number;
  readonly flashstate: number;
}

export const WEAPONINFO: readonly WeaponRow[] = [
  { ammo: AM_NOAMMO, upstate: S_PUNCHUP, downstate: S_PUNCHDOWN, readystate: S_PUNCH, atkstate: S_PUNCH1, flashstate: S_NULL },
  { ammo: AM_CLIP, upstate: S_PISTOLUP, downstate: S_PISTOLDOWN, readystate: S_PISTOL, atkstate: S_PISTOL1, flashstate: S_PISTOLFLASH },
  { ammo: AM_SHELL, upstate: S_SGUNUP, downstate: S_SGUNDOWN, readystate: S_SGUN, atkstate: S_SGUN1, flashstate: S_SGUNFLASH1 },
  { ammo: AM_CLIP, upstate: S_CHAINUP, downstate: S_CHAINDOWN, readystate: S_CHAIN, atkstate: S_CHAIN1, flashstate: S_CHAINFLASH1 },
  { ammo: AM_MISL, upstate: S_MISSILEUP, downstate: S_MISSILEDOWN, readystate: S_MISSILE, atkstate: S_MISSILE1, flashstate: S_MISSILEFLASH1 },
  { ammo: AM_CELL, upstate: S_PLASMAUP, downstate: S_PLASMADOWN, readystate: S_PLASMA, atkstate: S_PLASMA1, flashstate: S_PLASMAFLASH1 },
  { ammo: AM_CELL, upstate: S_BFGUP, downstate: S_BFGDOWN, readystate: S_BFG, atkstate: S_BFG1, flashstate: S_BFGFLASH1 },
  { ammo: AM_NOAMMO, upstate: S_SAWUP, downstate: S_SAWDOWN, readystate: S_SAW, atkstate: S_SAW1, flashstate: S_NULL },
  { ammo: AM_SHELL, upstate: S_DSGUNUP, downstate: S_DSGUNDOWN, readystate: S_DSGUN, atkstate: S_DSGUN1, flashstate: S_DSGUNFLASH1 },
];

/* ------------------------------------------------------------------ */
/* Runtime + hook slots (module-static per the vanilla-globals rule)   */
/* ------------------------------------------------------------------ */

/** The p_pspr.c globals that are NOT function-local: m_random's stream, the
 * p_user-level `leveltime` read by A_WeaponReady, and `bulletslope`.
 * game.ts/puser wiring (M7-03) re-binds every tic; tests bind a literal.
 * Binding is BY REFERENCE — the object stays the GameState's, so hashes and
 * this module see the same prndindex. */
export interface PsprWorld {
  readonly rng: PrngState;
  leveltime: number;
}

let world: PsprWorld | null = null;

export function bindPsprWorld(w: PsprWorld): void {
  world = w;
}

function requireWorld(): PsprWorld {
  if (!world) {
    throw new Error('p_pspr: world not bound (call bindPsprWorld)');
  }
  return world;
}

/** p_pspr.c:767 bulletslope — set by pBulletSlope, read by pGunShot. */
export const psprGlobals = {
  /** p_pspr.c `bulletslope`. */
  bulletslope: 0,
  /** gamemode gate of the P_CheckAmmo ladder (doomstat.h `gamemode`;
   * Freedoom Phase 1 / doom1 ≈ registered=1; commercial=2 arms the SSG
   * rung — plan §6.5 keeps supershotgun dead-coded outside Doom-2). */
  gamemode: 1,
};

/** One call per replacement-sensitive site, for the registration asserts
 * (L2 "slot called once per canonical event" idiom). */
export const psprHookCounts = {
  setMobjState: 0,
  moStateIs: 0,
  aimLineAttack: 0,
  lineAttack: 0,
  bulletSlope: 0,
  spawnPlayerMissile: 0,
  noiseAlert: 0,
  startSound: 0,
  pointToAngle2: 0,
  openShotgun2: 0,
  loadShotgun2: 0,
  closeShotgun2: 0,
};

export function resetPsprHookCounts(): void {
  for (const k of Object.keys(psprHookCounts) as (keyof typeof psprHookCounts)[]) {
    psprHookCounts[k] = 0;
  }
}

/** What P_AimLineAttack/P_LineAttack hand back (linetarget semantics,
 * p_maputl/p_map = M7-08): `hit` is vanilla `linetarget != NULL`; the
 * coordinates feed the turn-to-face code (R_PointToAngle2). */
export interface AimResult {
  readonly slope: number;
  readonly hit: boolean;
}
export interface AttackResult {
  readonly hit: boolean;
  readonly x: number;
  readonly y: number;
}

const NO_HIT: AimResult = { slope: 0, hit: false };
const NO_TARGET: AttackResult = { hit: false, x: 0, y: 0 };

/** Typed side-effect slots, one per foreign-function call site. Defaults
 * are counted NO-OPs (or the faithful local implementation where the logic
 * is p_pspr.c's own — pCheckAmmo, pBulletSlope). Owners REPLACE via
 * {@link registerPsprHook}; the call sites below never move. */
export interface PsprHooks {
  /** P_SetMobjState(player->mo, S_PLAY_ATK1/ATK2) — M7-02/03. */
  setMobjState(p: PsprPlayer, statenum: number): void;
  /** the A_WeaponReady `mo->state == &states[S_PLAY_ATK1/2]` compares —
   * M7-02/03 mobj state table; default false (never in an attack state). */
  moStateIs(p: PsprPlayer, statenum: number): boolean;
  /** P_AimLineAttack (M7-08). Default: miss, slope 0. */
  aimLineAttack(p: PsprPlayer, angle: number, range: number): AimResult;
  /** P_LineAttack (M7-08) — sets `linetarget`, observable as the result. */
  lineAttack(
    p: PsprPlayer,
    angle: number,
    range: number,
    slope: number,
    damage: number,
  ): AttackResult;
  /** P_BulletSlope (p_pspr.c-owned; the REAL autoaim probe is M7-08's
   * p_shoot.ts — register there). Default: faithful 3-probe shell over
   * hooks.aimLineAttack (misses ⇒ slope stays 0). */
  bulletSlope(p: PsprPlayer): number;
  /** P_SpawnPlayerMissile (M7-09). */
  spawnPlayerMissile(p: PsprPlayer, missileType: number): void;
  /** P_NoiseAlert (M8). */
  noiseAlert(p: PsprPlayer): void;
  /** S_StartSound origin=player->mo (M7-06 slot / M10 audio). */
  startSound(p: PsprPlayer, sfxId: number): void;
  /** R_PointToAngle2 to a linetarget (M7-08 registers). Default 0. */
  pointToAngle2(x1: number, y1: number, x2: number, y2: number): number;
  /** P_CheckAmmo — the ammo-economy ladder (M7-05 owns the semantics per
   * plan §M7-05; the faithful default below is retained here so the psprite
   * machine is testable standalone; register the p_ammo.ts one at merge). */
  checkAmmo(p: PsprPlayer): boolean;
}

function defaultHooks(): PsprHooks {
  return {
    setMobjState(p, statenum) {
      psprHookCounts.setMobjState++;
      void p;
      void statenum;
    },
    moStateIs() {
      psprHookCounts.moStateIs++;
      return false;
    },
    aimLineAttack() {
      psprHookCounts.aimLineAttack++;
      return NO_HIT;
    },
    lineAttack() {
      psprHookCounts.lineAttack++;
      return NO_TARGET;
    },
    bulletSlope(p) {
      // Faithful shell of the p_pspr.c probe sequence (M7-08 replaces).
      psprHookCounts.bulletSlope++;
      probeBulletSlope(p, 16 * 64 * FRACUNIT);
      return psprGlobals.bulletslope;
    },
    spawnPlayerMissile() {
      psprHookCounts.spawnPlayerMissile++;
    },
    noiseAlert() {
      psprHookCounts.noiseAlert++;
    },
    startSound() {
      psprHookCounts.startSound++;
    },
    pointToAngle2() {
      psprHookCounts.pointToAngle2++;
      return 0;
    },
    checkAmmo(p) {
      return pCheckAmmoLocal(p);
    },
  };
}

export const psprHooks: PsprHooks = defaultHooks();

/** Replace one slot body (owners: p_ammo.ts→checkAmmo, p_shoot.ts→
 * aimLineAttack/lineAttack/bulletSlope/pointToAngle2, p_mobj/pplayer→
 * setMobjState/moStateIs, p_mobj missiles→spawnPlayerMissile, M8→
 * noiseAlert, M7-06→startSound). */
export function registerPsprHook<K extends keyof PsprHooks>(
  name: K,
  fn: PsprHooks[K],
): void {
  psprHooks[name] = fn;
}

/** Restore every slot to the counted default (test isolation). */
export function resetPsprHooks(): void {
  Object.assign(psprHooks, defaultHooks());
  resetPsprHookCounts();
  psprGlobals.bulletslope = 0;
}

/* ------------------------------------------------------------------ */
/* P_SetPsprite (p_pspr.c:56-96)                                       */
/* ------------------------------------------------------------------ */

function rowOf(stnum: number): PsprStateRow {
  const row = PSPR_STATES[stnum];
  if (!row) {
    throw new Error(
      `P_SetPsprite: state ${stnum} outside the local pspr table ` +
        '(M7-01 tables not merged — see p_pspr.ts header)',
    );
  }
  return row;
}

/**
 * P_SetPsprite — action-on-entry, 0-tic cascade loop (`do … while
 * (!psp->tics)`), stnum 0 removes the psprite. EXACT structure; the only
 * encoding difference is state-as-statenum (see PspDef).
 */
export function pSetPsprite(p: PsprPlayer, position: number, stnum: number): void {
  const psp = p.psprites[position]!;

  for (;;) {
    if (!stnum) {
      // object removed itself
      psp.state = 0;
      break;
    }

    const state = rowOf(stnum);
    psp.state = stnum;
    psp.tics = state.tics; // could be 0

    if (state.misc1) {
      // coordinate set
      psp.sx = (state.misc1 << FRACBITS) | 0;
      psp.sy = (state.misc2 << FRACBITS) | 0;
    }

    // Call action routine. Modified handling.
    if (state.action) {
      state.action(p, psp);
      if (!psp.state) break;
    }

    stnum = rowOf(psp.state).next;

    // an initial state of 0 could cycle through
    if (psp.tics) break;
  }
}

/* ------------------------------------------------------------------ */
/* P_CalcSwing (p_pspr.c:99-121) — DEAD CODE in 1.10 (no callers, R08  */
/* §1.4); transcribed for mirror completeness, never invoked.          */
/* ------------------------------------------------------------------ */

export const psprSwing = { swingx: 0, swingy: 0 };

/** @internal dead in vanilla — exported ONLY as the named dead-code proof. */
export function pCalcSwing(p: PsprPlayer): void {
  const swing = p.bob;
  const w = requireWorld();

  let angle = ((8192 / 70) * w.leveltime) & FINEMASK;
  psprSwing.swingx = FixedMul(swing, finesine[angle]!);

  angle = ((8192 / 70) * w.leveltime + 8192 / 2) & FINEMASK;
  psprSwing.swingy = -FixedMul(psprSwing.swingx, finesine[angle]!) | 0;
}

/* ------------------------------------------------------------------ */
/* P_BringUpWeapon / P_FireWeapon / P_DropWeapon / P_SetupPsprites /   */
/* P_MovePsprites                                                      */
/* ------------------------------------------------------------------ */

/** p_pspr.c:135-152 — starts bringing the pending weapon up from the
 * bottom; uses player. */
export function pBringUpWeapon(p: PsprPlayer): void {
  if (p.pendingweapon === WP_NOCHANGE) p.pendingweapon = p.readyweapon;

  if (p.pendingweapon === WP_CHAINSAW) psprHooks.startSound(p, SFX_SAWUP);

  const newstate = WEAPONINFO[p.pendingweapon]!.upstate;

  p.pendingweapon = WP_NOCHANGE;
  p.psprites[PS_WEAPON]!.sy = WEAPONBOTTOM;

  pSetPsprite(p, PS_WEAPON, newstate);
}

/** p_pspr.c:158-215 P_CheckAmmo — the ladder (plasma→ssg→chaingun→shotgun→
 * pistol→chainsaw→missile→BFG→fist) + forced downstate. GATED: the
 * authoritative copy moves to p_ammo.ts at M7-05 (register via
 * registerPsprHook('checkAmmo', …)); this faithful default keeps the
 * machine standalone-testable. */
export function pCheckAmmoLocal(p: PsprPlayer): boolean {
  const ammo = WEAPONINFO[p.readyweapon]!.ammo;

  // Minimal amount for one shot varies.
  let count: number;
  if (p.readyweapon === WP_BFG) count = BFGCELLS;
  else if (p.readyweapon === WP_SUPERSHOTGUN) count = 2; // Double barrel.
  else count = 1; // Regular.

  // Some do not need ammunition anyway. Return if sufficient.
  if (ammo === AM_NOAMMO || p.ammo[ammo]! >= count) return true;

  // Out of ammo, pick a weapon to change to. Preferences are set here.
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

/** p_pspr.c:220-233 — fire entry: ammo gate, S_PLAY_ATK1, atkstate, noise. */
export function pFireWeapon(p: PsprPlayer): void {
  if (!psprHooks.checkAmmo(p)) return;

  psprHooks.setMobjState(p, S_PLAY_ATK1); // P_SetMobjState
  const newstate = WEAPONINFO[p.readyweapon]!.atkstate;
  pSetPsprite(p, PS_WEAPON, newstate);
  psprHooks.noiseAlert(p); // P_NoiseAlert — M8
}

/** p_pspr.c:238-245 — player died, put the weapon away. */
export function pDropWeapon(p: PsprPlayer): void {
  pSetPsprite(p, PS_WEAPON, WEAPONINFO[p.readyweapon]!.downstate);
}

/** p_pspr.c:829-842 — start of level for each player: clear, spawn gun. */
export function pSetupPsprites(p: PsprPlayer): void {
  // remove all psprites
  for (let i = 0; i < NUMPSPRITES; i++) p.psprites[i]!.state = 0;

  // spawn the gun
  p.pendingweapon = p.readyweapon;
  pBringUpWeapon(p);
}

/** p_pspr.c:847-875 — called every tic by P_PlayerThink (p_user.c:381).
 * `leveltime` is threaded by the caller (vanilla global); the module world
 * keeps it for A_WeaponReady. */
export function pMovePsprites(p: PsprPlayer, leveltime?: number): void {
  if (leveltime !== undefined) requireWorld().leveltime = leveltime;

  for (let i = 0; i < NUMPSPRITES; i++) {
    const psp = p.psprites[i]!;
    // a null state means not active
    if (psp.state) {
      // drop tic count and possibly change state
      // a -1 tic count never changes
      if (psp.tics !== -1) {
        psp.tics--;
        if (!psp.tics) pSetPsprite(p, i, rowOf(psp.state).next);
      }
    }
  }

  p.psprites[PS_FLASH]!.sx = p.psprites[PS_WEAPON]!.sx;
  p.psprites[PS_FLASH]!.sy = p.psprites[PS_WEAPON]!.sy;
}

/* ------------------------------------------------------------------ */
/* State actions (p_pspr.c order)                                      */
/* ------------------------------------------------------------------ */

/** p_pspr.c:255-300 — ready state: exit attack state, saw idle sound,
 * weapon-change/dead bail, fire check (missile/BFG latch), bob. */
export function aWeaponReady(p: PsprPlayer, psp: PspDef): void {
  // get out of attack state
  if (psprHooks.moStateIs(p, S_PLAY_ATK1) || psprHooks.moStateIs(p, S_PLAY_ATK2)) {
    psprHooks.setMobjState(p, S_PLAY); // P_SetMobjState(mo, S_PLAY)
  }

  if (p.readyweapon === WP_CHAINSAW && psp.state === S_SAW) {
    psprHooks.startSound(p, SFX_SAWIDL);
  }

  // check for change — if player is dead, put the weapon away
  if (p.pendingweapon !== WP_NOCHANGE || !p.health) {
    // change weapon (pending weapon should already be validated)
    const newstate = WEAPONINFO[p.readyweapon]!.downstate;
    pSetPsprite(p, PS_WEAPON, newstate);
    return;
  }

  // check for fire — the missile launcher and bfg do not auto fire
  if (p.cmd.buttons & BT_ATTACK) {
    if (!p.attackdown || (p.readyweapon !== WP_MISSILE && p.readyweapon !== WP_BFG)) {
      p.attackdown = true;
      pFireWeapon(p);
      return;
    }
  } else {
    p.attackdown = false;
  }

  // bob the weapon based on movement speed (R08 §1.4 — the ONLY bob site)
  const w = requireWorld();
  let angle = (128 * w.leveltime) & FINEMASK;
  psp.sx = (FRACUNIT + FixedMul(p.bob, finecosine[angle]!)) | 0;
  angle &= 8192 / 2 - 1;
  psp.sy = (WEAPONTOP + FixedMul(p.bob, finesine[angle]!)) | 0;
}

/** p_pspr.c:307-324 — hold-to-refire; `refire` counts the hold so only the
 * FIRST shot of a press is accurate (P_GunShot). */
export function aReFire(p: PsprPlayer, psp: PspDef): void {
  void psp;
  // check for fire (if a weaponchange is pending, let it go through
  // instead of refire)
  if (
    p.cmd.buttons & BT_ATTACK &&
    p.pendingweapon === WP_NOCHANGE &&
    p.health
  ) {
    p.refire++;
    pFireWeapon(p);
  } else {
    p.refire = 0;
    psprHooks.checkAmmo(p);
  }
}

/** p_pspr.c:326-337 (the #if 0 S_DSNR1 branch stays commented: never). */
export function aCheckReload(p: PsprPlayer, psp: PspDef): void {
  void psp;
  psprHooks.checkAmmo(p);
  // #if 0 — if (player->ammo[am_shell]<2) P_SetPsprite(ps_weapon,S_DSNR1)
}

/** p_pspr.c:396-425 — lower, change at bottom, dead stays down. */
export function aLower(p: PsprPlayer, psp: PspDef): void {
  psp.sy = (psp.sy + LOWERSPEED) | 0;

  // Is already down.
  if (psp.sy < WEAPONBOTTOM) return;

  // Player is dead.
  if (p.playerstate === PST_DEAD) {
    psp.sy = WEAPONBOTTOM;
    // don't bring weapon back up
    return;
  }

  // The old weapon has been lowered off the screen, so change the weapon
  // and start raising it.
  if (!p.health) {
    // Player is dead, so keep the weapon off screen.
    pSetPsprite(p, PS_WEAPON, S_NULL);
    return;
  }

  p.readyweapon = p.pendingweapon;

  pBringUpWeapon(p);
}

/** p_pspr.c:433-451 — raise, ready at top. */
export function aRaise(p: PsprPlayer, psp: PspDef): void {
  psp.sy = (psp.sy - RAISESPEED) | 0;

  if (psp.sy > WEAPONTOP) return;

  psp.sy = WEAPONTOP;

  // The weapon has been raised all the way, so change to the ready state.
  const newstate = WEAPONINFO[p.readyweapon]!.readystate;

  pSetPsprite(p, PS_WEAPON, newstate);
}

/** p_pspr.c:458-464 — set S_PLAY_ATK2 and start the flash psprite. */
export function aGunFlash(p: PsprPlayer, psp: PspDef): void {
  void psp;
  psprHooks.setMobjState(p, S_PLAY_ATK2);
  pSetPsprite(p, PS_FLASH, WEAPONINFO[p.readyweapon]!.flashstate);
}

/* ---------------- WEAPON ATTACKS ------------------------------------ */

/** p_pspr.c:352-380 A_Punch — even 2..20 (berserk ×10), jitter <<18,
 * MELEERANGE, turn-to-face on hit. */
export function aPunch(p: PsprPlayer, psp: PspDef): void {
  void psp;
  const rng = requireWorld().rng;

  let damage = (pRandom(rng) % 10 + 1) << 1;

  if (p.powers[PW_STRENGTH]!) damage *= 10;

  let angle = p.mo.angle;
  angle = (angle + ((pRandom(rng) - pRandom(rng)) << 18)) >>> 0;

  const aim = psprHooks.aimLineAttack(p, angle, MELEERANGE);
  const hit = psprHooks.lineAttack(p, angle, MELEERANGE, aim.slope, damage);

  // turn to face target
  if (hit.hit) {
    psprHooks.startSound(p, SFX_PUNCH);
    p.mo.angle = psprHooks.pointToAngle2(p.mo.x, p.mo.y, hit.x, hit.y) >>> 0;
  }
}

/** p_pspr.c:385-432 A_Saw — 2..20 odd, MELEERANGE+1 ("so the puff doesn't
 * skip the flash"), max-turn-toward-target, MF_JUSTATTACKED (the lunge is
 * p_user.ts's M5 chainsaw block; the flag itself is mobj-side = M7-02, so
 * the write lives there — count-only until then). */
export function aSaw(p: PsprPlayer, psp: PspDef): void {
  void psp;
  const rng = requireWorld().rng;

  const damage = 2 * (pRandom(rng) % 10 + 1);
  let angle = p.mo.angle;
  angle = (angle + ((pRandom(rng) - pRandom(rng)) << 18)) >>> 0;

  // use meleerange + 1 se the puff doesn't skip the flash
  const aim = psprHooks.aimLineAttack(p, angle, MELEERANGE + 1);
  const hit = psprHooks.lineAttack(p, angle, MELEERANGE + 1, aim.slope, damage);

  if (!hit.hit) {
    psprHooks.startSound(p, SFX_SAWFUL);
    return;
  }
  psprHooks.startSound(p, SFX_SAWHIT);

  // turn to face target (C's unsigned wrap kept with >>>0)
  const ANG180 = 0x80000000;
  const ANG90_20 = Math.trunc(ANG90 / 20); // 53687091
  const ANG90_21 = Math.trunc(ANG90 / 21); // 51130563
  angle = psprHooks.pointToAngle2(p.mo.x, p.mo.y, hit.x, hit.y) >>> 0;
  const diff = (angle - p.mo.angle) >>> 0;
  if (diff > ANG180) {
    // C: `diff < -ANG90/20` — unsigned compare against the wrapped
    // negative constant (0xFD1C…C7D range); reproduced exactly:
    if (diff < (-ANG90_20 >>> 0)) p.mo.angle = (angle + ANG90_21) >>> 0;
    else p.mo.angle = (p.mo.angle - ANG90_20) >>> 0;
  } else {
    if (diff > ANG90_20) p.mo.angle = (angle - ANG90_21) >>> 0;
    else p.mo.angle = (p.mo.angle + ANG90_20) >>> 0;
  }
  // player->mo->flags |= MF_JUSTATTACKED — mobj flags live on the Player's
  // MobjStub (p_move/p_mobj own the bit write; M7-02 registers):
  p.mo.flags |= MF_JUSTATTACKED_LOCAL;
}

/** p_mobj.h MF_JUSTATTACKED = 128 (repeated constant — p_mobj.ts is
 * M7-02-owned). */
const MF_JUSTATTACKED_LOCAL = 128;

/** p_pspr.c:521-534 A_FireMissile. */
export function aFireMissile(p: PsprPlayer, psp: PspDef): void {
  void psp;
  p.ammo[WEAPONINFO[p.readyweapon]!.ammo]!--;
  psprHooks.spawnPlayerMissile(p, MT_ROCKET_LOCAL); // MT_ROCKET
}

/** p_pspr.c:453-460 A_FireBFG. */
export function aFireBFG(p: PsprPlayer, psp: PspDef): void {
  void psp;
  p.ammo[WEAPONINFO[p.readyweapon]!.ammo]! -= BFGCELLS;
  psprHooks.spawnPlayerMissile(p, MT_BFG_LOCAL); // MT_BFG
}

/** p_pspr.c:465-480 A_FirePlasma — random flash variant
 * `flashstate+(P_Random()&1)`. */
export function aFirePlasma(p: PsprPlayer, psp: PspDef): void {
  void psp;
  const rng = requireWorld().rng;
  p.ammo[WEAPONINFO[p.readyweapon]!.ammo]!--;

  pSetPsprite(
    p,
    PS_FLASH,
    WEAPONINFO[p.readyweapon]!.flashstate + (pRandom(rng) & 1),
  );

  psprHooks.spawnPlayerMissile(p, MT_PLASMA_LOCAL); // MT_PLASMA
}

// mobjtype_t indices of the missiles A_Fire* spawns (info.h enum order —
// repeated constants; p_mobj.ts = M7-02 owns the enum).
const MT_ROCKET_LOCAL = 33;
const MT_PLASMA_LOCAL = 34;
const MT_BFG_LOCAL = 35;

/** p_pspr.c:487-500 P_BulletSlope — sets `bulletslope` via the probe order
 * an, an+1<<26, an−2<<26. The real P_AimLineAttack (autoaim, slope) registers
 * from p_shoot.ts at M7-08; the probe STRUCTURE is p_pspr.c's own and stays
 * here — the C `if (!linetarget)` nesting is written against the hook
 * result so the probe COUNT is exact (1, 2 or 3 aim calls). */
function probeBulletSlope(p: PsprPlayer, range: number): void {
  // (probes below mirror p_pspr.c P_BulletSlope exactly)
  const first = psprHooks.aimLineAttack(p, p.mo.angle >>> 0, range);
  psprGlobals.bulletslope = first.slope;
  if (!first.hit) {
    const an2 = (p.mo.angle + (1 << 26)) >>> 0;
    const second = psprHooks.aimLineAttack(p, an2, range);
    psprGlobals.bulletslope = second.slope;
    if (!second.hit) {
      const an3 = (an2 - (2 << 26)) >>> 0;
      const third = psprHooks.aimLineAttack(p, an3, range);
      psprGlobals.bulletslope = third.slope;
    }
  }
}

/** p_pspr.c:505-519 P_GunShot — damage 5·(1|2|3), jitter <<18 unless
 * accurate, MISSILERANGE with bulletslope. */
export function pGunShot(p: PsprPlayer, accurate: boolean): void {
  const rng = requireWorld().rng;
  const damage = 5 * (pRandom(rng) % 3 + 1);
  let angle = p.mo.angle;

  if (!accurate) angle = (angle + ((pRandom(rng) - pRandom(rng)) << 18)) >>> 0;

  psprHooks.lineAttack(p, angle >>> 0, MISSILERANGE, psprGlobals.bulletslope, damage);
}

/** p_pspr.c:525-544 A_FirePistol. */
export function aFirePistol(p: PsprPlayer, psp: PspDef): void {
  void psp;
  psprHooks.startSound(p, SFX_PISTOL);

  psprHooks.setMobjState(p, S_PLAY_ATK2);
  p.ammo[WEAPONINFO[p.readyweapon]!.ammo]!--;

  pSetPsprite(p, PS_FLASH, WEAPONINFO[p.readyweapon]!.flashstate);

  psprHooks.bulletSlope(p);
  pGunShot(p, !p.refire);
}

/** p_pspr.c:549-572 A_FireShotgun — 7 unaccurate pellets. */
export function aFireShotgun(p: PsprPlayer, psp: PspDef): void {
  void psp;
  psprHooks.startSound(p, SFX_SHOTGN);
  psprHooks.setMobjState(p, S_PLAY_ATK2);

  p.ammo[WEAPONINFO[p.readyweapon]!.ammo]!--;

  pSetPsprite(p, PS_FLASH, WEAPONINFO[p.readyweapon]!.flashstate);

  psprHooks.bulletSlope(p);

  for (let i = 0; i < 7; i++) pGunShot(p, false);
}

/** p_pspr.c:577-610 A_FireShotgun2 — 20 pellets, jitter <<19 + vertical
 * `slope + ((P_Random()-P_Random())<<5)`, ammo −2. (Supershotgun stays
 * dead-coded outside Doom-2 — plan §6.5 — but the table references it.) */
export function aFireShotgun2(p: PsprPlayer, psp: PspDef): void {
  void psp;
  const rng = requireWorld().rng;
  psprHooks.startSound(p, SFX_DSHTGN);
  psprHooks.setMobjState(p, S_PLAY_ATK2);

  p.ammo[WEAPONINFO[p.readyweapon]!.ammo]! -= 2;

  pSetPsprite(p, PS_FLASH, WEAPONINFO[p.readyweapon]!.flashstate);

  psprHooks.bulletSlope(p);

  for (let i = 0; i < 20; i++) {
    const damage = 5 * (pRandom(rng) % 3 + 1);
    let angle = p.mo.angle;
    angle = (angle + ((pRandom(rng) - pRandom(rng)) << 19)) >>> 0;
    psprHooks.lineAttack(
      p,
      angle >>> 0,
      MISSILERANGE,
      (psprGlobals.bulletslope + ((pRandom(rng) - pRandom(rng)) << 5)) | 0,
      damage,
    );
  }
}

/** p_pspr.c:615-638 A_FireCGun — empty-gun early-out BEFORE the ammo read
 * side effects; flash variant via the state−&states[S_CHAIN1] trick (exact
 * because PSPR_STATES is keyed by real statenums). */
export function aFireCGun(p: PsprPlayer, psp: PspDef): void {
  psprHooks.startSound(p, SFX_PISTOL);

  if (!p.ammo[WEAPONINFO[p.readyweapon]!.ammo]) return;

  psprHooks.setMobjState(p, S_PLAY_ATK2);
  p.ammo[WEAPONINFO[p.readyweapon]!.ammo]!--;

  pSetPsprite(
    p,
    PS_FLASH,
    WEAPONINFO[p.readyweapon]!.flashstate + psp.state - S_CHAIN1,
  );

  psprHooks.bulletSlope(p);

  pGunShot(p, !p.refire);
}

/** p_pspr.c:645-652 — A_Light0/1/2: muzzle-flash view light. */
export function aLight0(p: PsprPlayer, psp: PspDef): void {
  void psp;
  p.extralight = 0;
}
export function aLight1(p: PsprPlayer, psp: PspDef): void {
  void psp;
  p.extralight = 1;
}
export function aLight2(p: PsprPlayer, psp: PspDef): void {
  void psp;
  p.extralight = 2;
}

/** p_pspr.c:694-700 A_BFGsound. */
export function aBFGsound(p: PsprPlayer, psp: PspDef): void {
  void psp;
  psprHooks.startSound(p, SFX_BFG);
}

/** p_enemy.c:1778-1805 (M8 file) — named counted stubs; only the
 * supershotgun chain (dead-coded) references them. */
export function aOpenShotgun2(p: PsprPlayer, psp: PspDef): void {
  void p;
  void psp;
  psprHookCounts.openShotgun2++;
}
export function aLoadShotgun2(p: PsprPlayer, psp: PspDef): void {
  void p;
  void psp;
  psprHookCounts.loadShotgun2++;
}
export function aCloseShotgun2(p: PsprPlayer, psp: PspDef): void {
  void p;
  void psp;
  psprHookCounts.closeShotgun2++;
  // sfx_dbcls + A_ReFire (p_enemy.c) — dormant with the SSG gate; wires
  // with the M8 roster.
}

/* A_BFGSpray (p_pspr.c:660-691) is an MOBJ state action (S_BFGLAND3) — its
 * state row lives in the mobj half of the tables; plan §M7-09/M8 owns the
 * body. Not transcribed here (no psprite call site). */

/* ------------------------------------------------------------------ */
/* PSPR_STATES table build (info.c rows 0..89, verbatim fields)        */
/* ------------------------------------------------------------------ */

const R = (
  sprite: number,
  frame: number,
  tics: number,
  action: PsprAction | null,
  next: number,
): PsprStateRow => ({ sprite, frame, tics, action, next, misc1: 0, misc2: 0 });

// SPR_* (spritedef_t indices of the weapon sprites):
const SPR_SHTG = 1;
const SPR_PUNG = 2;
const SPR_PISG = 3;
const SPR_PISF = 4;
const SPR_SHTF = 5;
const SPR_SHT2 = 6;
const SPR_CHGG = 7;
const SPR_CHGF = 8;
const SPR_MISG = 9;
const SPR_MISF = 10;
const SPR_SAWG = 11;
const SPR_PLSG = 12;
const SPR_PLSF = 13;
const SPR_BFGG = 14;
const SPR_BFGF = 15;

/** p_pspr.h FF_FULLBRIGHT. */
export const FF_FULLBRIGHT = 0x8000;
/** p_pspr.h FF_FRAMEMASK. */
export const FF_FRAMEMASK = 0x7fff;

// info.c states[] rows 0..89 (spritedef/frame/tics/action/next), info.c
// comment ordering — see /tmp mirror; every row misc1=misc2=0 (the
// coordinate-set branch of P_SetPsprite is vacuous for weapon states).
PSPR_STATES[S_NULL] = R(0, 0, 1, null, S_NULL); // SPR_TROO — "removed"
PSPR_STATES[S_LIGHTDONE] = R(SPR_SHTG, 4, 0, aLight0, S_NULL);
PSPR_STATES[S_PUNCH] = R(SPR_PUNG, 0, 1, aWeaponReady, S_PUNCH);
PSPR_STATES[S_PUNCHDOWN] = R(SPR_PUNG, 0, 1, aLower, S_PUNCHDOWN);
PSPR_STATES[S_PUNCHUP] = R(SPR_PUNG, 0, 1, aRaise, S_PUNCHUP);
PSPR_STATES[S_PUNCH1] = R(SPR_PUNG, 1, 4, null, S_PUNCH2);
PSPR_STATES[S_PUNCH2] = R(SPR_PUNG, 2, 4, aPunch, S_PUNCH3);
PSPR_STATES[S_PUNCH3] = R(SPR_PUNG, 3, 5, null, S_PUNCH4);
PSPR_STATES[S_PUNCH4] = R(SPR_PUNG, 2, 4, null, S_PUNCH5);
PSPR_STATES[S_PUNCH5] = R(SPR_PUNG, 1, 5, aReFire, S_PUNCH);
PSPR_STATES[S_PISTOL] = R(SPR_PISG, 0, 1, aWeaponReady, S_PISTOL);
PSPR_STATES[S_PISTOLDOWN] = R(SPR_PISG, 0, 1, aLower, S_PISTOLDOWN);
PSPR_STATES[S_PISTOLUP] = R(SPR_PISG, 0, 1, aRaise, S_PISTOLUP);
PSPR_STATES[S_PISTOL1] = R(SPR_PISG, 0, 4, null, S_PISTOL2);
PSPR_STATES[S_PISTOL2] = R(SPR_PISG, 1, 6, aFirePistol, S_PISTOL3);
PSPR_STATES[S_PISTOL3] = R(SPR_PISG, 2, 4, null, S_PISTOL4);
PSPR_STATES[S_PISTOL4] = R(SPR_PISG, 1, 5, aReFire, S_PISTOL);
PSPR_STATES[S_PISTOLFLASH] = R(SPR_PISF, FF_FULLBRIGHT | 0, 7, aLight1, S_LIGHTDONE);
PSPR_STATES[S_SGUN] = R(SPR_SHTG, 0, 1, aWeaponReady, S_SGUN);
PSPR_STATES[S_SGUNDOWN] = R(SPR_SHTG, 0, 1, aLower, S_SGUNDOWN);
PSPR_STATES[S_SGUNUP] = R(SPR_SHTG, 0, 1, aRaise, S_SGUNUP);
PSPR_STATES[S_SGUN1] = R(SPR_SHTG, 0, 3, null, S_SGUN2);
PSPR_STATES[S_SGUN2] = R(SPR_SHTG, 0, 7, aFireShotgun, S_SGUN3);
PSPR_STATES[S_SGUN3] = R(SPR_SHTG, 1, 5, null, S_SGUN4);
PSPR_STATES[S_SGUN4] = R(SPR_SHTG, 2, 5, null, S_SGUN5);
PSPR_STATES[S_SGUN5] = R(SPR_SHTG, 3, 4, null, S_SGUN6);
PSPR_STATES[S_SGUN6] = R(SPR_SHTG, 2, 5, null, S_SGUN7);
PSPR_STATES[S_SGUN7] = R(SPR_SHTG, 1, 5, null, S_SGUN8);
PSPR_STATES[S_SGUN8] = R(SPR_SHTG, 0, 3, null, S_SGUN9);
PSPR_STATES[S_SGUN9] = R(SPR_SHTG, 0, 7, aReFire, S_SGUN);
PSPR_STATES[S_SGUNFLASH1] = R(SPR_SHTF, FF_FULLBRIGHT | 0, 4, aLight1, S_SGUNFLASH2);
PSPR_STATES[S_SGUNFLASH2] = R(SPR_SHTF, FF_FULLBRIGHT | 1, 3, aLight2, S_LIGHTDONE);
PSPR_STATES[S_DSGUN] = R(SPR_SHT2, 0, 1, aWeaponReady, S_DSGUN);
PSPR_STATES[S_DSGUNDOWN] = R(SPR_SHT2, 0, 1, aLower, S_DSGUNDOWN);
PSPR_STATES[S_DSGUNUP] = R(SPR_SHT2, 0, 1, aRaise, S_DSGUNUP);
PSPR_STATES[S_DSGUN1] = R(SPR_SHT2, 0, 3, null, S_DSGUN2);
PSPR_STATES[S_DSGUN2] = R(SPR_SHT2, 0, 7, aFireShotgun2, S_DSGUN3);
PSPR_STATES[S_DSGUN3] = R(SPR_SHT2, 1, 7, null, S_DSGUN4);
PSPR_STATES[S_DSGUN4] = R(SPR_SHT2, 2, 7, aCheckReload, S_DSGUN5);
PSPR_STATES[S_DSGUN5] = R(SPR_SHT2, 3, 7, aOpenShotgun2, S_DSGUN6);
PSPR_STATES[S_DSGUN6] = R(SPR_SHT2, 4, 7, null, S_DSGUN7);
PSPR_STATES[S_DSGUN7] = R(SPR_SHT2, 5, 7, aLoadShotgun2, S_DSGUN8);
PSPR_STATES[S_DSGUN8] = R(SPR_SHT2, 6, 6, null, S_DSGUN9);
PSPR_STATES[S_DSGUN9] = R(SPR_SHT2, 7, 6, aCloseShotgun2, S_DSGUN10);
PSPR_STATES[S_DSGUN10] = R(SPR_SHT2, 0, 5, aReFire, S_DSGUN);
PSPR_STATES[S_DSNR1] = R(SPR_SHT2, 1, 7, null, S_DSNR2);
PSPR_STATES[S_DSNR2] = R(SPR_SHT2, 0, 3, null, S_DSGUNDOWN);
PSPR_STATES[S_DSGUNFLASH1] = R(SPR_SHT2, FF_FULLBRIGHT | 8, 5, aLight1, S_DSGUNFLASH2);
PSPR_STATES[S_DSGUNFLASH2] = R(SPR_SHT2, FF_FULLBRIGHT | 9, 4, aLight2, S_LIGHTDONE);
PSPR_STATES[S_CHAIN] = R(SPR_CHGG, 0, 1, aWeaponReady, S_CHAIN);
PSPR_STATES[S_CHAINDOWN] = R(SPR_CHGG, 0, 1, aLower, S_CHAINDOWN);
PSPR_STATES[S_CHAINUP] = R(SPR_CHGG, 0, 1, aRaise, S_CHAINUP);
PSPR_STATES[S_CHAIN1] = R(SPR_CHGG, 0, 4, aFireCGun, S_CHAIN2);
PSPR_STATES[S_CHAIN2] = R(SPR_CHGG, 1, 4, aFireCGun, S_CHAIN3);
PSPR_STATES[S_CHAIN3] = R(SPR_CHGG, 1, 0, aReFire, S_CHAIN);
PSPR_STATES[S_CHAINFLASH1] = R(SPR_CHGF, FF_FULLBRIGHT | 0, 5, aLight1, S_LIGHTDONE);
PSPR_STATES[S_CHAINFLASH2] = R(SPR_CHGF, FF_FULLBRIGHT | 1, 5, aLight2, S_LIGHTDONE);
PSPR_STATES[S_MISSILE] = R(SPR_MISG, 0, 1, aWeaponReady, S_MISSILE);
PSPR_STATES[S_MISSILEDOWN] = R(SPR_MISG, 0, 1, aLower, S_MISSILEDOWN);
PSPR_STATES[S_MISSILEUP] = R(SPR_MISG, 0, 1, aRaise, S_MISSILEUP);
PSPR_STATES[S_MISSILE1] = R(SPR_MISG, 1, 8, aGunFlash, S_MISSILE2);
PSPR_STATES[S_MISSILE2] = R(SPR_MISG, 1, 12, aFireMissile, S_MISSILE3);
PSPR_STATES[S_MISSILE3] = R(SPR_MISG, 1, 0, aReFire, S_MISSILE);
PSPR_STATES[S_MISSILEFLASH1] = R(SPR_MISF, FF_FULLBRIGHT | 0, 3, aLight1, S_MISSILEFLASH2);
PSPR_STATES[S_MISSILEFLASH2] = R(SPR_MISF, FF_FULLBRIGHT | 1, 4, null, S_MISSILEFLASH3);
PSPR_STATES[S_MISSILEFLASH3] = R(SPR_MISF, FF_FULLBRIGHT | 2, 4, aLight2, S_MISSILEFLASH4);
PSPR_STATES[S_MISSILEFLASH4] = R(SPR_MISF, FF_FULLBRIGHT | 3, 4, aLight2, S_LIGHTDONE);
PSPR_STATES[S_SAW] = R(SPR_SAWG, 2, 4, aWeaponReady, S_SAWB);
PSPR_STATES[S_SAWB] = R(SPR_SAWG, 3, 4, aWeaponReady, S_SAW);
PSPR_STATES[S_SAWDOWN] = R(SPR_SAWG, 2, 1, aLower, S_SAWDOWN);
PSPR_STATES[S_SAWUP] = R(SPR_SAWG, 2, 1, aRaise, S_SAWUP);
PSPR_STATES[S_SAW1] = R(SPR_SAWG, 0, 4, aSaw, S_SAW2);
PSPR_STATES[S_SAW2] = R(SPR_SAWG, 1, 4, aSaw, S_SAW3);
PSPR_STATES[S_SAW3] = R(SPR_SAWG, 1, 0, aReFire, S_SAW);
PSPR_STATES[S_PLASMA] = R(SPR_PLSG, 0, 1, aWeaponReady, S_PLASMA);
PSPR_STATES[S_PLASMADOWN] = R(SPR_PLSG, 0, 1, aLower, S_PLASMADOWN);
PSPR_STATES[S_PLASMAUP] = R(SPR_PLSG, 0, 1, aRaise, S_PLASMAUP);
PSPR_STATES[S_PLASMA1] = R(SPR_PLSG, 0, 3, aFirePlasma, S_PLASMA2);
PSPR_STATES[S_PLASMA2] = R(SPR_PLSG, 1, 20, aReFire, S_PLASMA);
PSPR_STATES[S_PLASMAFLASH1] = R(SPR_PLSF, FF_FULLBRIGHT | 0, 4, aLight1, S_LIGHTDONE);
PSPR_STATES[S_PLASMAFLASH2] = R(SPR_PLSF, FF_FULLBRIGHT | 1, 4, aLight1, S_LIGHTDONE);
PSPR_STATES[S_BFG] = R(SPR_BFGG, 0, 1, aWeaponReady, S_BFG);
PSPR_STATES[S_BFGDOWN] = R(SPR_BFGG, 0, 1, aLower, S_BFGDOWN);
PSPR_STATES[S_BFGUP] = R(SPR_BFGG, 0, 1, aRaise, S_BFGUP);
PSPR_STATES[S_BFG1] = R(SPR_BFGG, 0, 20, aBFGsound, S_BFG2);
PSPR_STATES[S_BFG2] = R(SPR_BFGG, 1, 10, aGunFlash, S_BFG3);
PSPR_STATES[S_BFG3] = R(SPR_BFGG, 1, 10, aFireBFG, S_BFG4);
PSPR_STATES[S_BFG4] = R(SPR_BFGG, 1, 20, aReFire, S_BFG);
PSPR_STATES[S_BFGFLASH1] = R(SPR_BFGF, FF_FULLBRIGHT | 0, 11, aLight1, S_BFGFLASH2);
PSPR_STATES[S_BFGFLASH2] = R(SPR_BFGF, FF_FULLBRIGHT | 1, 6, aLight2, S_LIGHTDONE);
