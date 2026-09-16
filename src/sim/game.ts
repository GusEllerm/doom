// sim/game.ts — G_InitGame / G_Ticker / runHeadless (g_game.c skeleton,
// ARCHITECTURE §3.1-§3.2). This is the ONLY place the sim advances (§3.5-1).
//
// G_Ticker follows the §3.2 per-tic order; the branches that have no M2
// subject (reborn pass, gameaction drain, demo, netgame consistency,
// GS_INTERMISSION & friends) are documented stubs so later tasks extend the
// same skeleton rather than invent a driver.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { TICRATE } from '../core/constants';

import type { RuntimeMap } from './map';
import { createPlayer, pPlayerThink, pSpawnPlayer } from './player';
import { createPrngState, mClearRandom } from './prng';
import { emptyInput, gBuildTiccmd, type GameInput } from './ticcmd';
import { hashState, type GameState, type Skill } from './state';

/** Fixed simulation rate (ARCHITECTURE §3.1: 35 Hz; = TICRATE). */
export const TICS_PER_SECOND = TICRATE;

export class GameSetupError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'GameSetupError';
  }
}

/* ------------------------------------------------------------------ */
/* G_InitGame (G_InitNew + G_DoLoadLevel subset: g_game.c:1365+)       */
/* ------------------------------------------------------------------ */

/**
 * Build a fresh `GameState` on an already-built {@link RuntimeMap}:
 *  - one playing player slot (vanilla `playeringame[0] = true`; netgame
 *    flag false, §"netgame=false");
 *  - `M_ClearRandom()` (g_game.c G_InitNew calls it at g_game.c:1414);
 *  - spawn via {@link pSpawnPlayer} at `playerstarts[0]` (p_mobj.c
 *    P_SpawnMapThing → doomednum 1 → P_SpawnPlayer).
 */
export function gInitGame(map: RuntimeMap, skill: Skill = 2): GameState {
  const start = map.playerStarts[0];
  if (!start) {
    throw new GameSetupError(`map ${map.name}: no player 1 start (doomednum 1)`);
  }
  const player = createPlayer();
  pSpawnPlayer(player, start);

  const state: GameState = {
    map,
    players: [player],
    gametic: 0,
    leveltime: 0,
    turnheld: 0,
    rng: createPrngState(),
    skill
  };
  mClearRandom(state.rng); // g_game.c:1414
  return state;
}

/* ------------------------------------------------------------------ */
/* G_Ticker (g_game.c:605) — one tic                                   */
/* ------------------------------------------------------------------ */

/**
 * Advance `state` exactly one tic with the platform-supplied input snapshot.
 * §3.2 order:
 *  1. reborn pass — no PST_REBORN players exist pre-M5 (no-op);
 *  2. gameaction drain — no gameaction sources yet (no-op);
 *  3. build the ticcmd and copy it into `player.cmd` (vanilla copies from the
 *     netcmds ring; single-player builds directly, same slot semantics);
 *  4. special buttons — none in M2 (no-op);
 *  5. `gamestate == GS_LEVEL`: P_Ticker = P_PlayerThink per player, then
 *     `leveltime++` (P_RunThinkers/P_UpdateSpecials arrive in later tasks).
 *
 * `gametic++` (vanilla d_main.c:383-385 right after G_Ticker) is folded in
 * here so the headless loop cannot forget it.
 */
export function gTicker(state: GameState, input: GameInput = emptyInput()): void {
  // 1-2: reborn / gameaction drains — empty skeletons, see header.

  // 3: G_BuildTiccmd → players[0].cmd (consoleplayer).
  const cmd = gBuildTiccmd(input, state);
  for (const p of state.players) p.cmd = cmd;

  // 4: special buttons (pause/save) — none.

  // 5: GS_LEVEL → P_Ticker.
  for (const p of state.players) pPlayerThink(p);
  state.leveltime++; // p_tick.c P_Ticker tail

  state.gametic++; // d_main.c tic loop tail
}

/* ------------------------------------------------------------------ */
/* Headless harness (ARCHITECTURE §7 layer 2)                          */
/* ------------------------------------------------------------------ */

/**
 * Pure scripted loop: run exactly `tics` tics, asking `inputFn(gametic, tic)
 * ` for the input snapshot each tic (defaults to no input). Returns
 * `hashState()` after the last tic — the golden-hook for sim tests and
 * `__doom.step(n)`.
 */
export function runHeadless(
  state: GameState,
  tics: number,
  inputFn: (gametic: number, ticIndex: number) => GameInput = () => emptyInput()
): number {
  for (let i = 0; i < tics; i++) {
    gTicker(state, inputFn(state.gametic, i));
  }
  return hashState(state);
}
