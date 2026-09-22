/**
 * Types for the window.__doom debug/test API.
 * The API may SET UP scenarios (warp, load map, flags) for tests,
 * but must never stand in for behavior under test (PROMPT.md §9).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { GameInput } from '../sim/ticcmd';
import type { GameState } from '../sim/state';

/* ------------------------------------------------------------------ */
/* state() snapshot (ARCHITECTURE §7 discriminated union)              */
/* ------------------------------------------------------------------ */

/** Before the first successful boot/attach (M2-07: pre-loadMap). */
export interface DebugStatePending {
  ready: false;
  note: string;
}

/**
 * §7 shape with M2-relevant fields real (gametic/leveltime/map/player
 * fixed coords/health/hash) and the not-yet-existing subsystems pinned to
 * documented defaults (gap G9): armor 0, ammo [] (no weapon inventory
 * pre-M7), weapons 0 (bitmask), powerups {}, onGroundSector -1, thinkers 0
 * (no thinker arena pre-M5). `noclip` is the M2 addition mirroring
 * CF_NOCLIP. M3-07: `render.hom` is the LIVE renderer counter
 * (getRenderCounters().hom of the last renderFrame; −1 only while no
 * framebuffer has been attached — pre-boot).
 */
/** d_main.h gamestate_t names (M9-12 seam: was the pinned 'GS_LEVEL' — the
 * M9 flow makes all four states real, so the name tracks the live field;
 * `screen.gamestate` carries the raw number). */
export type DebugGamestateName =
  | 'GS_LEVEL'
  | 'GS_INTERMISSION'
  | 'GS_FINALE'
  | 'GS_DEMOSCREEN';

/** Raw flow flags of the live GameState (M9-12 seam: pure field reads —
 * gamestate/gameaction/paused/usergame/viewactive/advancedemo + the
 * episode/map/skill selectors). */
export interface DebugScreenRead {
  gamestate: number;
  gameaction: number;
  paused: boolean;
  usergame: boolean;
  advancedemo: boolean;
  viewactive: boolean;
  gameepisode: number;
  gamemap: number;
  gameskill: number;
}

/** M9-12 seam: the UI-layer read bundle main.ts supplies through
 * {@link DoomDebugApi.ui} (the attachUiDebug closure — SAME structural
 * discipline as attachRenderDebug: debug.ts imports NOTHING from ui/).
 * Every section is null while its layer is unregistered; `screen` is
 * always present once a sim is attached (plain GameState reads). */
export interface DebugUiRead {
  screen: DebugScreenRead;
  menu: {
    active: boolean;
    inHelpScreens: boolean;
    menuName: string;
    itemOn: number;
    whichSkull: number;
    messageToPrint: number;
    screenBlocks: number;
    mouseSensitivity: number;
    detailLevel: number;
    /** M_Drawer item boxes the menu-mouse synthesizer is armed with
     * (null ⇒ disarmed — messages/help screens). */
    itemBoxes: { x: number; y: number }[] | null;
  } | null;
  hud: {
    /** ST face machine: 0..41 (ST_FACESX/Y = 143/168, 40x41 px lump),
     * null ⇒ statusbar module not attached. */
    faceIndex: number | null;
    faceCount: number;
    /** HU message line (w_message) + the showMessages flag. */
    message: string;
    showMessages: boolean;
    /** statusbar on (ST_Drawer's statusbaron flag). */
    statusbarOn: boolean;
  } | null;
  title: { demosequence: number; pagetic: number; pagename: string } | null;
  finale: { stage: number; count: number } | null;
  wi: {
    active: boolean;
    phase: string;
    bcnt: number;
    epsd: number;
    accelerateStage: number;
    /** wbs.spState (the SP tally counter machine — 10 = all counters done) */
    spState: number;
    last: number;
    next: number;
  } | null;
}

export interface DebugStateLive {
  ready: true;
  gametic: number;
  leveltime: number;
  map: string;
  gamestate: DebugGamestateName;
  player: {
    /** fixed (mo->x) */
    x: number;
    /** fixed */
    y: number;
    /** fixed (ONFLOORZ until P_CalcHeight) */
    z: number;
    /** M5-08: fixed eye height (P_CalcHeight; 0 pinned pre-first-tic) */
    viewz: number;
    /** M5-08: fixed bob accumulator (P_CalcHeight |mom|^2>>2, MAXBOB cap) */
    bob: number;
    /** degrees [0,360) derived from the BAM angle */
    angleDeg: number;
    health: number;
    armor: number;
    ammo: number[];
    weapons: number;
    powerups: Record<string, number>;
    onGroundSector: number;
    noclip: boolean;
    /** M6-11: player.cards[NUMCARDS] (doomdef card_t slot order: blue
     * card, yellow card, red card, blue skull, yellow skull, red skull);
     * 0/1 per slot, debug giveCard until the M7 pickups (D013(f)). */
    cards: number[];
    /** M7-11c (direct): d_player.h readyweapon (WP_* enum). Live once the
     * inventory fields attach (initPlayerInventory / G_PlayerReborn). */
    readyweapon: number;
    /** d_player.h pendingweapon (wp_no_change = -1? uses P_AMMO_ enum values;
     * see p_ammo.ts) */
    pendingweapon: number;
    /** psprites[NUMPSPRITES] state numbers (slot 0 = weapon, 1 = flash)
     * for the weapon-raise/fire e2e assertions (p_pspr.ts PsprFields). */
    pspr: { slot: number; state: number; sx: number; sy: number }[];
  };
  sectors: { count: number };
  thinkers: { count: number };
  /** M8-12 (M8-plan §M8-12): live monster roll-up over the MF_COUNTKILL
   * thinkers of THIS level (barrels counted separately, items excluded).
   * Read live at snapshot time — pure observability, nothing here is
   * hashed and no existing field changes meaning. */
  monsters: DebugMonsters;
  /** M3-07/M4-07: the LIVE renderer health counters of the last renderFrame
   * (all −1 only while no framebuffer has been attached — pre-boot).
   * `hom` is the solidsegs/store failure count; the four overflow counters
   * are the vanilla fatal-cap cases the port turns into counted events
   * (M4-plan §4): MAXDRAWSEGS, MAXVISPLANES, MAXVISSPRITES, MAXOPENINGS. */
  render: {
    hom: number;
    visplaneOverflow: number;
    visspriteOverflow: number;
    openingOverflow: number;
    drawsegOverflow: number;
  };
  /** §3.4 hashState() */
  hash: number;
  /** M9-12 seam: raw flow flags of the live GameState (see
   * DebugScreenRead; pure reads, nothing hashed). */
  screen: DebugScreenRead;
}

/** One monster view (M8-plan §M8-12 `state().mobjs` field list:
 * type, health, state, target, movedir, movecount, flags + coords). */
export interface DebugMonsterView {
  /** MT_* index (mobjinfo array order) */
  type: number;
  /** fixed */
  x: number;
  /** fixed */
  y: number;
  health: number;
  /** states[] index (S_* enum) */
  state: number;
  /** p_mobj.h movedir (0-7, DI_NODIR = -1 pre-chase) */
  movedir: number;
  /** p_mobj.h movecount (A_Chase new-direction timer) */
  movecount: number;
  /** raw MF_* flags */
  flags: number;
  /** decoded subset relevant to the M8 suites (corpse walk-over, wake) */
  flagsLite: {
    solid: boolean;
    shootable: boolean;
    shadow: boolean;
    ambush: boolean;
    corpse: boolean;
  };
  /** actor->target ThingLinks slot (null = no target) */
  targetSlot: number | null;
  /** true when actor->target IS player 0's mobj (A_Look wake proof) */
  targetPlayer: boolean;
}

export interface DebugMonsters {
  /** MF_COUNTKILL, non-barrel, health > 0, not removed */
  alive: number;
  /** alive count keyed by MT_* index */
  byType: Record<number, number>;
  /** living MT_BARREL count (MF_COUNTKILL too, excluded from `alive`) */
  barrels: number;
  /** d_player.h players[0].killcount (the intermission counter) */
  killcount: number;
  /** first entry of `mobjs` (thinker/spawn order), or null */
  first: DebugMonsterView | null;
  /** every non-removed MF_COUNTKILL monster mobj (CORPSES INCLUDED —
   * health <= 0 until the S_NULL removal), spawn order, capped at 128 */
  mobjs: DebugMonsterView[];
}

export type DebugStateSnapshot = DebugStatePending | DebugStateLive;

export interface CaptureResult {
  width: number;
  height: number;
  /** 8-bit palette indices (320*200) — the REAL rendered framebuffer copy
   * once the platform boot attached the render source (M3-07); all zeros
   * only before boot. */
  indices: Uint8Array;
}

/* ------------------------------------------------------------------ */
/* sim sub-API (M2-07): direct deterministic-core access for tests/e2e */
/* ------------------------------------------------------------------ */

export interface SimDebugApi {
  /** Attach the live GameState the sim/debug surface drives (wired by the
   * platform boot or directly by headless tests; returns it back). */
  attach(state: GameState): GameState;
  /** Detach (state() reports ready:false afterwards). */
  detach(): void;
  /** The live GameState object itself (null until attached). Read freely;
   * writes belong to runTics/setNoclip/warp. */
  getState(): GameState | null;
  /** Set/clear CF_NOCLIP on player 0 (cheat-equivalent path, §7); returns
   * the resulting state. Also mirrors the per-tic flag sync
   * (p_user.c) so it is visible before the next tic. */
  setNoclip(enabled: boolean): boolean;
  /** Read CF_NOCLIP on player 0. */
  getNoclip(): boolean;
  /**
   * M6-11 debug card grant (D013(f)): set `player 0 .cards[index] = 1`
   * (P_GiveCard semantics, p_inter.c — until M7's P_TouchSpecialThing
   * pickups replace it). index = doomdef.h card_t slot (0 blue card,
   * 1 yellow, 2 red, 3 blue skull, 4 yellow skull, 5 red skull); returns
   * the resulting 6-slot array. Throws RangeError on a bad index.
   */
  giveCard(index: number): number[];
  /** P_GiveWeapon(player, weapon, dropped=false) debug channel (M7-11c):
   * the scripted e2e needs weapons without routing item mobjs onto the
   * player; real pickups remain the gameplay path. */
  giveWeapon(weapon: number): boolean;
  /** P_KillPlayer debug channel (M7-11c): scripted death without a
   * damage source; respawn flows through the BT_USE latch. */
  killPlayer(): 'ok';
  /** Run exactly n tics (G_Ticker path, §3.2) with the given input snapshot
   * (or the sticky setInput override, else empty); returns hashState(). */
  runTics(tics: number, input?: Partial<GameInput> | null): number;
  /** Sticky input override applied to every later runTics/tic until reset
   * (e2e scripted-input hook; null clears it). */
  setInput(input: Partial<GameInput> | null): void;
  /** Teleport semantics (§7): direct fixed-set + angleDeg→BAM, z defaults
   * to the ONFLOORZ token. Requires an attached state. */
  warp(x: number, y: number, z?: number, angleDeg?: number): void;
  /** Current GameInput produced by the sticky override (debug introspection). */
  getInput(): GameInput | null;
  /** M5-08: inject a RAW (unscaled) device delta into the live ev_mouse
   * accumulator — the same queue the pointer-lock mousemove path feeds
   * (input/mouse.ts motion()). Sensitivity scaling + once-per-tic drain
   * happen at the tic boundary exactly like the real device path. */
  injectMouse(dx: number, dy: number): void;
}

export interface DoomDebugApi {
  /** Load map by name ('E1M1'|'MAP01') and enter GS_LEVEL at the start position. Throws on unknown map. */
  loadMap(mapName: string): void;
  /** Teleport player 0 (teleport-move semantics, noclip-safe): fixed-point x/y, optional fixed z and BAM degrees [0,360). Setup only — never substitutes for movement-under-test. */
  warp(x: number, y: number, z?: number, angleDeg?: number): void;
  /** set/get CF_GODMODE (cheat-equivalent path). Returns resulting state. */
  god(enabled?: boolean): boolean;
  /** set/get CF_NOCLIP. Returns resulting state. */
  noclip(enabled?: boolean): boolean;
  /** Run exactly n tics through the §3.2 path with empty input (or scripted cmds); pauses sim during call; returns hashState() after the last tic. */
  step(tics: number): number;
  /** set/get menu-pause equivalent (sim freeze; rendering continues). Returns state. */
  pause(paused?: boolean): boolean;
  /** Read-only snapshot of simulation state. */
  state(): DebugStateSnapshot;
  /** Grab the current 320x200 indexed framebuffer. */
  capture(): CaptureResult;
  /** M6-13 FINDING 3 seam: pop (drain + discard) input accumulated
   * BETWEEN scripted phases while the sim was paused — queued vanilla
   * key events (D_ProcessEvents queue, d_main.c) and unsampled raw mouse
   * deltas. Prevents a held/queued event from flooding the first live
   * tics after `pause(false)`. Returns what was dropped; null when the
   * main.ts input wiring is absent (headless/tests). */
  popInput(): { events: number; mouse: { x: number; y: number } } | null;
  /** M8-fix static-dummy seam (hooks.aiGate): true installs the mobj AI
   * gate on the attached state's hook slots — the A_Look/A_Chase state
   * actions then skip dispatch (dummies stay STAND/static; pain, death and
   * the damage bridge keep running), false clears it (production AI).
   * Returns the new gate state; false when no simulation is attached. */
  aiGate(on: boolean): boolean;
  /** Direct sim-core surface (M2-07): state access, noclip, tic stepping. */
  sim: SimDebugApi;
  /**
   * M9-12 seam: the UI-layer read bundle (menu stack / HUD face+message /
   * title demosequence / finale stage / intermission counters) plus the
   * raw screen flags. main.ts supplies it through attachUiDebug as a
   * plain closure — debug.ts holds NO ui import (attachRenderDebug
   * discipline). null when the boot wiring is absent (headless/tests).
   */
  ui(): DebugUiRead | null;
}
