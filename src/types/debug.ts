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
export interface DebugStateLive {
  ready: true;
  gametic: number;
  leveltime: number;
  map: string;
  gamestate: 'GS_LEVEL';
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
  };
  sectors: { count: number };
  thinkers: { count: number };
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
  /** Direct sim-core surface (M2-07): state access, noclip, tic stepping. */
  sim: SimDebugApi;
}
