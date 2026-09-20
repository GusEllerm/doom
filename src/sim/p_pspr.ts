// sim/p_pspr.ts — psprite state machine (p_pspr.c TRANSLATION, M7-07).
//
// Mirror: /tmp/DOOM-master/linuxdoom-1.10/p_pspr.c (62-.c mirror check:
// p_pspr.c is THIS file's source of truth; the state rows are transcribed
// verbatim from the same tree's info.c/info.h, weaponinfo from d_items.c).
//
// Scope notes (docs/design/M7-plan.md §M7-07):
//  * TABLES CONSUMED (M7-01 MERGED): states/frames/tics/next/misc come from
//    src/wad/info/states.ts (the generated 967-row SoA — real statenums, so
//    the info.c `state - states` arithmetic incl. the A_FireCGun
//    `flashstate + psp->state - &states[S_CHAIN1]` trick is exact) and
//    weapon states dispatch through the src/sim/a_actions.ts ActionId
//    REGISTRY ({@link registerAction}/{@link dispatchAction}) — this module
//    registers the 22 p_pspr.c bodies at load; the mobj machine (M7-02/03)
//    sees the SAME ids. `PSPR_STATES` is a row-view cached over the SoA.
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
import { ACT, dispatchAction, registerAction } from './a_actions';
import {
  AMMO,
  NUMWEAPONS as NUMWEAPONS_T,
  WP,
  weaponinfo as weaponinfoT,
} from '../wad/info/weaponinfo';
import {
  NUMSTATES,
  S,
  stateAction,
  stateFrame,
  stateMisc1,
  stateMisc2,
  stateNext,
  stateSprite,
  stateTics,
} from '../wad/info/states';

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
export const WP_FIST = WP.wp_fist;
export const WP_PISTOL = WP.wp_pistol;
export const WP_SHOTGUN = WP.wp_shotgun;
export const WP_CHAINGUN = WP.wp_chaingun;
export const WP_MISSILE = WP.wp_missile;
export const WP_PLASMA = WP.wp_plasma;
export const WP_BFG = WP.wp_bfg;
export const WP_CHAINSAW = WP.wp_chainsaw;
export const WP_SUPERSHOTGUN = WP.wp_supershotgun;
export const WP_NOCHANGE = WP.wp_nochange;

/** doomdef.h ammotype_t (am_noammo = 5 — after NUMAMMO=4). */
export const AM_CLIP = AMMO.am_clip;
export const AM_SHELL = AMMO.am_shell;
export const AM_CELL = AMMO.am_cell;
export const AM_MISL = AMMO.am_misl;
export const NUMAMMO = 4;
export const AM_NOAMMO = AMMO.am_noammo;

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
export const S_NULL = S.S_NULL;
export const S_LIGHTDONE = S.S_LIGHTDONE;
export const S_PUNCH = S.S_PUNCH;
export const S_PUNCHDOWN = S.S_PUNCHDOWN;
export const S_PUNCHUP = S.S_PUNCHUP;
export const S_PUNCH1 = S.S_PUNCH1;
export const S_PUNCH2 = S.S_PUNCH2;
export const S_PUNCH3 = S.S_PUNCH3;
export const S_PUNCH4 = S.S_PUNCH4;
export const S_PUNCH5 = S.S_PUNCH5;
export const S_PISTOL = S.S_PISTOL;
export const S_PISTOLDOWN = S.S_PISTOLDOWN;
export const S_PISTOLUP = S.S_PISTOLUP;
export const S_PISTOL1 = S.S_PISTOL1;
export const S_PISTOL2 = S.S_PISTOL2;
export const S_PISTOL3 = S.S_PISTOL3;
export const S_PISTOL4 = S.S_PISTOL4;
export const S_PISTOLFLASH = S.S_PISTOLFLASH;
export const S_SGUN = S.S_SGUN;
export const S_SGUNDOWN = S.S_SGUNDOWN;
export const S_SGUNUP = S.S_SGUNUP;
export const S_SGUN1 = S.S_SGUN1;
export const S_SGUN2 = S.S_SGUN2;
export const S_SGUN3 = S.S_SGUN3;
export const S_SGUN4 = S.S_SGUN4;
export const S_SGUN5 = S.S_SGUN5;
export const S_SGUN6 = S.S_SGUN6;
export const S_SGUN7 = S.S_SGUN7;
export const S_SGUN8 = S.S_SGUN8;
export const S_SGUN9 = S.S_SGUN9;
export const S_SGUNFLASH1 = S.S_SGUNFLASH1;
export const S_SGUNFLASH2 = S.S_SGUNFLASH2;
export const S_DSGUN = S.S_DSGUN;
export const S_DSGUNDOWN = S.S_DSGUNDOWN;
export const S_DSGUNUP = S.S_DSGUNUP;
export const S_DSGUN1 = S.S_DSGUN1;
export const S_DSGUN2 = S.S_DSGUN2;
export const S_DSGUN3 = S.S_DSGUN3;
export const S_DSGUN4 = S.S_DSGUN4;
export const S_DSGUN5 = S.S_DSGUN5;
export const S_DSGUN6 = S.S_DSGUN6;
export const S_DSGUN7 = S.S_DSGUN7;
export const S_DSGUN8 = S.S_DSGUN8;
export const S_DSGUN9 = S.S_DSGUN9;
export const S_DSGUN10 = S.S_DSGUN10;
export const S_DSNR1 = S.S_DSNR1;
export const S_DSNR2 = S.S_DSNR2;
export const S_DSGUNFLASH1 = S.S_DSGUNFLASH1;
export const S_DSGUNFLASH2 = S.S_DSGUNFLASH2;
export const S_CHAIN = S.S_CHAIN;
export const S_CHAINDOWN = S.S_CHAINDOWN;
export const S_CHAINUP = S.S_CHAINUP;
export const S_CHAIN1 = S.S_CHAIN1;
export const S_CHAIN2 = S.S_CHAIN2;
export const S_CHAIN3 = S.S_CHAIN3;
export const S_CHAINFLASH1 = S.S_CHAINFLASH1;
export const S_CHAINFLASH2 = S.S_CHAINFLASH2;
export const S_MISSILE = S.S_MISSILE;
export const S_MISSILEDOWN = S.S_MISSILEDOWN;
export const S_MISSILEUP = S.S_MISSILEUP;
export const S_MISSILE1 = S.S_MISSILE1;
export const S_MISSILE2 = S.S_MISSILE2;
export const S_MISSILE3 = S.S_MISSILE3;
export const S_MISSILEFLASH1 = S.S_MISSILEFLASH1;
export const S_MISSILEFLASH2 = S.S_MISSILEFLASH2;
export const S_MISSILEFLASH3 = S.S_MISSILEFLASH3;
export const S_MISSILEFLASH4 = S.S_MISSILEFLASH4;
export const S_SAW = S.S_SAW;
export const S_SAWB = S.S_SAWB;
export const S_SAWDOWN = S.S_SAWDOWN;
export const S_SAWUP = S.S_SAWUP;
export const S_SAW1 = S.S_SAW1;
export const S_SAW2 = S.S_SAW2;
export const S_SAW3 = S.S_SAW3;
export const S_PLASMA = S.S_PLASMA;
export const S_PLASMADOWN = S.S_PLASMADOWN;
export const S_PLASMAUP = S.S_PLASMAUP;
export const S_PLASMA1 = S.S_PLASMA1;
export const S_PLASMA2 = S.S_PLASMA2;
export const S_PLASMAFLASH1 = S.S_PLASMAFLASH1;
export const S_PLASMAFLASH2 = S.S_PLASMAFLASH2;
export const S_BFG = S.S_BFG;
export const S_BFGDOWN = S.S_BFGDOWN;
export const S_BFGUP = S.S_BFGUP;
export const S_BFG1 = S.S_BFG1;
export const S_BFG2 = S.S_BFG2;
export const S_BFG3 = S.S_BFG3;
export const S_BFG4 = S.S_BFG4;
export const S_BFGFLASH1 = S.S_BFGFLASH1;
export const S_BFGFLASH2 = S.S_BFGFLASH2;

/** info.h — the player attack mobj states p_pspr.c sets through
 * P_SetMobjState (mobj-side states = M7-02/03; only the NUMBERS live here
 * because the call sites are in this file). */
export const S_PLAY = S.S_PLAY;
export const S_PLAY_ATK1 = S.S_PLAY_ATK1;
export const S_PLAY_ATK2 = S.S_PLAY_ATK2;

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
  /** a_actions.ts ActionId (0 = {NULL} — never dispatched). */
  readonly actionId: number;
  /** statenum (0 = S_NULL removes). */
  readonly next: number;
  readonly misc1: number;
  readonly misc2: number;
}

/** Sparse by statenum (rows 0..89; the psprite machine never enters a row
 * above 89 — player/mobj states are M7-02/03 territory). */
export const PSPR_STATES: PsprStateRow[] = [];

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

/** d_items.c rows — the generated weaponinfo.ts table, key-renamed for the
 * p_pspr.c call sites (values identical; parity pinned in the tests). */
export const WEAPONINFO: readonly WeaponRow[] = weaponinfoT.map((w) => ({
  ammo: w.ammo,
  upstate: w.upState,
  downstate: w.downState,
  readystate: w.readyState,
  atkstate: w.atkState,
  flashstate: w.flashState,
}));

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

    // Call action routine. Modified handling. — M7-01 registry dispatch
    // (a_actions.ts); the pspr machine owns the ctx cast (ActionFn doc).
    if (state.actionId) {
      psprActionCtx.player = p;
      psprActionCtx.psp = psp;
      dispatchAction(state.actionId, psprActionCtx);
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
/* ActionId registry: the p_pspr.c bodies register at module load      */
/* ------------------------------------------------------------------ */

/** ActionFn context for psprite actions (caller-owned cast per the
 * a_actions.ts contract). ONE reused record — dispatch sites fill it in
 * place (vanilla passed (player, psp) directly; the registry erases to
 * unknown). Registered wrappers read it AT ENTRY only, so nested
 * SetPsprite cascades (A_Lower → BringUp → SetPsprite) are safe. */
export interface PsprActionCtx {
  player: PsprPlayer;
  psp: PspDef;
}

const psprActionCtx = {} as PsprActionCtx;

/** Wrap a (player, psp) body as an ActionFn. */
const W =
  (fn: PsprAction) =>
    (ctx: unknown): void => {
      const c = ctx as PsprActionCtx;
      fn(c.player, c.psp);
    };

registerAction(ACT.A_Light0, W(aLight0));
registerAction(ACT.A_WeaponReady, W(aWeaponReady));
registerAction(ACT.A_Lower, W(aLower));
registerAction(ACT.A_Raise, W(aRaise));
registerAction(ACT.A_Punch, W(aPunch));
registerAction(ACT.A_ReFire, W(aReFire));
registerAction(ACT.A_FirePistol, W(aFirePistol));
registerAction(ACT.A_Light1, W(aLight1));
registerAction(ACT.A_FireShotgun, W(aFireShotgun));
registerAction(ACT.A_Light2, W(aLight2));
registerAction(ACT.A_FireShotgun2, W(aFireShotgun2));
registerAction(ACT.A_CheckReload, W(aCheckReload));
registerAction(ACT.A_OpenShotgun2, W(aOpenShotgun2));
registerAction(ACT.A_LoadShotgun2, W(aLoadShotgun2));
registerAction(ACT.A_CloseShotgun2, W(aCloseShotgun2));
registerAction(ACT.A_FireCGun, W(aFireCGun));
registerAction(ACT.A_GunFlash, W(aGunFlash));
registerAction(ACT.A_FireMissile, W(aFireMissile));
registerAction(ACT.A_Saw, W(aSaw));
registerAction(ACT.A_FirePlasma, W(aFirePlasma));
registerAction(ACT.A_BFGsound, W(aBFGsound));
registerAction(ACT.A_FireBFG, W(aFireBFG));
// A_BFGSpray (ACT 23) is an MOBJ state action (S_BFGLAND3) — M7-09/M8
// registers that body; the pspr table never dispatches it.

/* ------------------------------------------------------------------ */
/* PSPR_STATES row view over the generated states.ts SoA               */
/* ------------------------------------------------------------------ */

for (let i = 0; i < NUMSTATES; i++) {
  PSPR_STATES[i] = {
    sprite: stateSprite[i]!,
    frame: stateFrame[i]!,
    tics: stateTics[i]!,
    actionId: stateAction[i]!,
    next: stateNext[i]!,
    misc1: stateMisc1[i]!,
    misc2: stateMisc2[i]!,
  };
}

/** p_pspr.h FF_FULLBRIGHT / FF_FRAMEMASK (re-exported from the tables). */
export { FF_FULLBRIGHT, FF_FRAMEMASK } from '../wad/info/states';

/** NUMWEAPONS re-export (weaponinfo.ts is the authority). */
export const NUMWEAPONS = NUMWEAPONS_T;

