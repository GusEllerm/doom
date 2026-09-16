/**
 * Types for the window.__doom debug/test API.
 * The API may SET UP scenarios (warp, load map, flags) for tests,
 * but must never stand in for behavior under test (PROMPT.md §9).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export interface DebugStateSnapshot {
  /** Placeholder shape until the simulation exists (M5+). */
  ready: false;
  note: string;
}

export interface CaptureResult {
  width: number;
  height: number;
  /** 8-bit palette indices (320*200) once the renderer exists; zeros until then. */
  indices: Uint8Array;
}

export interface DoomDebugApi {
  /** Load a map by name (e.g. "E1M1") and start playing it. */
  loadMap(mapName: string): void;
  /** Move the player (fixed-point units; angle in degrees). */
  warp(x: number, y: number, z?: number, angleDeg?: number): void;
  /** Toggle/read god mode. Returns current state. */
  god(enabled?: boolean): boolean;
  /** Toggle/read noclip. Returns current state. */
  noclip(enabled?: boolean): boolean;
  /** Advance the simulation exactly n tics (35 Hz). */
  step(tics: number): void;
  /** Pause/unpause. Returns current paused state. */
  pause(paused?: boolean): boolean;
  /** Read-only snapshot of simulation state. */
  state(): DebugStateSnapshot;
  /** Grab the current 320x200 indexed framebuffer. */
  capture(): CaptureResult;
}
