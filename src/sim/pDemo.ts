// sim/pDemo.ts — M11-06 demo record/playback (g_game.c:1489-1688 port).
// STUB (first-action commit): API surface frozen, bodies land incrementally.
//
// Format truth (M11-plan §0.5): header = 13 bytes (G_BeginRecording
// g_game.c:1549-1570), body = 4 bytes per playing player per tic
// (G_ReadDemoTiccmd :1491-1503), end marker DEMOMARKER=0x80 (:1489).
// NO checksum, NO desync detection in 1.10 (D-11c).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { GameState } from './state';
import type { Ticcmd } from './ticcmd';

/** doomdef.h:33 VERSION (= the savegame header's, persist/codec.ts). */
export const VERSION = 110;
/** g_game.c:1489 `#define DEMOMARKER 0x80`. */
export const DEMOMARKER = 0x80;
/** g_game.c:1549-1570 header size (VERSION..playeringame[0..3]). */
export const DEMO_HEADER_SIZE = 13;
/** g_game.c:1538 `-maxdemo` default (bytes). */
export const MAXDEMO = 0x20000;

/** Outcome of one gWriteDemoTiccmd call (g_game.c:1506-1523 lanes). */
export type WriteOutcome = 'ok' | 'quit' | 'full';
/** Outcome of one gReadDemoTiccmd call (g_game.c:1491-1503 lanes). */
export type ReadOutcome = 'ok' | 'end';
/** What gCheckDemoStatus just ended (g_game.c:1647-1688 branches). */
export type CheckOutcome = 'none' | 'recorded' | 'playend';

/** The 13-byte header as a struct (§0.5). */
export interface DemoHeader {
  version: number;
  skill: number;
  episode: number;
  map: number;
  deathmatch: number;
  respawnparm: number;
  fastparm: number;
  nomonsters: number;
  consoleplayer: number;
  playeringame: boolean[];
}

/** Observability counters (NEVER hashed; M11-10 mirrors into state().persist). */
export const demoFlow: {
  recordsDone: number;
  playsDone: number;
  lastRecordTic: number;
  lastPlayEndTic: number;
  versionWarnings: number;
} = {
  recordsDone: 0,
  playsDone: 0,
  lastRecordTic: -1,
  lastPlayEndTic: -1,
  versionWarnings: 0
};

/** Reset module statics + counters (test isolation; mirrors resetSaveFlow). */
export function resetDemo(): void {
  /* TODO M11-06 */
}

export function demoRecording(): boolean {
  return false; // TODO M11-06
}

export function demoPlaying(): boolean {
  return false; // TODO M11-06
}

/** demoFlow counter read helper for tests. */
export function demoVersionWarnings(): number {
  return demoFlow.versionWarnings;
}

/** Last finished recording's bytes (null before any). */
export function demoBytes(): Uint8Array | null {
  return null; // TODO M11-06
}

/** g_game.c:1530-1546 G_RecordDemo (buffer + demorecording=true). */
export function gRecordDemo(name = 'demosave1', maxdemoKb?: number): void {
  void name; void maxdemoKb; // TODO M11-06
}

/** g_game.c:1549-1570 G_BeginRecording (13-byte header). */
export function gBeginRecording(state: GameState): void {
  void state; // TODO M11-06
}

/** d_main.c:356-357 pair: G_RecordDemo + G_BeginRecording. */
export function gStartRecordDemo(state: GameState, name?: string, maxdemoKb?: number): void {
  gRecordDemo(name, maxdemoKb);
  gBeginRecording(state);
}

/** Platform 'q'-key mount (g_game.c:1508 gamekeydown['q']). */
export function gRequestStopRecord(): void {
  // TODO M11-06
}

/** g_game.c:1506-1523 write-rewind-read trick (mutates cmd). */
export function gWriteDemoTiccmd(state: GameState, cmd: Ticcmd): WriteOutcome {
  void state; void cmd; // TODO M11-06
  return 'ok';
}

/** g_game.c:1491-1503 read into cmd (marker/end-of-bytes ⇒ 'end', cmd
 * unchanged — vanilla retention). */
export function gReadDemoTiccmd(state: GameState, cmd: Ticcmd): ReadOutcome {
  void state; void cmd; // TODO M11-06
  return 'ok';
}

/** g_game.c:1647-1688 (record branch: marker + bytes out via
 * captureSink('demo'); playback branch: flag reset; caller routes the
 * D_AdvanceDemo half). */
export function gCheckDemoStatus(state: GameState): CheckOutcome {
  void state; // TODO M11-06
  return 'none';
}

/** g_game.c:1576-1580 G_DeferedPlayDemo (arms ga_playdemo). */
export function gDeferedPlayDemo(state: GameState, bytes: Uint8Array): void {
  void state; void bytes; // TODO M11-06
}

/** g_game.c:1582-1625 G_DoPlayDemo (drain body; `initNew` is game.ts's
 * gInitNew injected to keep the import graph acyclic). */
export function gDoPlayDemo(
  state: GameState,
  initNew: (s: GameState, skill: number, ep: number, map: number) => void
): boolean {
  void state; void initNew; // TODO M11-06
  return false;
}
