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

import { buildBlockMap } from './blockmap';
import { sectorAtPoint } from './bsp';
import type { RuntimeMap } from './map';
import { buildThingLinks, allocThingSlot, thingSetPosition } from './thinglinks';
import { pXYMovement, pZMovement } from './pmove';
import { pPlayerThink } from './puser';
import { createPlayer, ONFLOORZ, pSpawnPlayer } from './player';
import { createPrngState, mClearRandom } from './prng';
import { emptyInput, gBuildTiccmd, type GameInput } from './ticcmd';
import { createHookSlots } from './hooks';
import { createThinkerArena, pRunThinkers } from './ptick';
import { createMobjRuntime, pRespawnSpecials, pSpawnThings } from './p_mobj';
import { pSpawnSpecials, pUpdateSpecials } from './pspec';
import { createLiveSectors, hashState, type GameState, type Skill } from './state';

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
 *    P_SpawnMapThing → doomednum 1 → P_SpawnPlayer), completed by the
 *    P_SpawnMobj tail (M5-06): floorz/ceilingz from the spawn subsector +
 *    the ONFLOORZ resolution of p_mobj.c:519-522, and the P_SetThingPosition
 *    thinglinks slot the shared mover path relinks every P_TryMove.
 */
export function gInitGame(map: RuntimeMap, skill: Skill = 2): GameState {
  const start = map.playerStarts[0];
  if (!start) {
    throw new GameSetupError(`map ${map.name}: no player 1 start (doomednum 1)`);
  }
  const player = createPlayer();
  pSpawnPlayer(player, start);

  const bm = buildBlockMap(map);
  const links = buildThingLinks(map, bm, { skill });
  const pmap = { map, bm, links };

  // p_mobj.c:519-526 (P_SpawnMobj tail): subsector floors/ceilings become
  // the mobj's, THEN the ONFLOORZ token resolves to the actual floor.
  const sector = sectorAtPoint(map, player.mo.x, player.mo.y);
  player.mo.floorz = map.sectors.floorHeight[sector]!;
  player.mo.ceilingz = map.sectors.ceilingHeight[sector]!;
  if (player.mo.z === ONFLOORZ) player.mo.z = player.mo.floorz;

  // P_SetThingPosition for the player mobj (M5-06: dynamic thinglinks
  // slot — PIT_CheckThing's self-skip is then slot identity, D012).
  const slot = allocThingSlot(links, player.mo.radius, player.mo.height, player.mo.flags);
  player.mo.linkSlot = slot;
  thingSetPosition(links, slot, player.mo.x, player.mo.y);

  const state: GameState = {
    map,
    pmap,
    players: [player],
    gametic: 0,
    leveltime: 0,
    turnheld: 0,
    rng: createPrngState(),
    skill,
    // M6-01 live world. Fresh arena per level = P_InitThinkers
    // (p_tick.c:71, called from G_DeferedInitNew/P_SetupLevel); fresh
    // hook-slot logs; live sector SoA value-copied from the load-time
    // arrays (state.ts header: authority + renderer seam story).
    sectors: createLiveSectors(map),
    thinkers: createThinkerArena(),
    hooks: createHookSlots(),
    exitRequest: 'none',
    totalsecret: 0, // P_SpawnSpecials sector-9 pass (M6-03) counts this
    secretcount: 0,
    specialexit: false,
    // M7-02: placeholder replaced immediately below (the runtime
    // back-references the state; never observable in between).
    mobjs: null as unknown as GameState['mobjs']
  };
  state.mobjs = createMobjRuntime(state);
  mClearRandom(state.rng); // g_game.c:1414
  // M7-02 thing spawn pass — 1.10 site: P_SetupLevel → P_LoadThings →
  // P_SpawnMapThing (p_setup.c:346) BEFORE P_SpawnSpecials, in THINGS
  // order, AFTER M_ClearRandom (so the per-mobj P_Random() draws —
  // lastlook + the spawn-tics jitter — sit exactly where vanilla's do).
  // The thinker arena order rule follows: map-thing mobjs first, specials
  // after (p_mobj.ts header). deathmatch starts are captured here too.
  pSpawnThings(state.mobjs);
  // P_SpawnSpecials — 1.10 site: P_SetupLevel → P_SpawnSpecials
  // (p_setup.c); M6-03 sector-9 totalsecret pass + special-48 line
  // collection + list inits + family-stub spawn calls (M6-plan §0.3).
  pSpawnSpecials(state);
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
 *  5. `gamestate == GS_LEVEL`: P_Ticker (p_tick.c order, ARCHITECTURE §3.2,
 *     M6-01): P_PlayerThink per player → P_RunThinkers (thinker arena)
 *     → P_UpdateSpecials (M6-01 counted no-op; M6-03 body) →
 *     P_RespawnSpecials (level respawn = M9, no-op) → `leveltime++`.
 *  The paused / menu-pause gates of p_tick.c:140-152 are M9 (no `paused`
 *  source exists yet).
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

  // 5: GS_LEVEL → P_Ticker (p_tick.c order, M5-06 + M6-01): P_PlayerThink
  // for ALL players, THEN P_RunThinkers — the player's mobj thinker IS the
  // M5-05 P_XYMovement + P_ZMovement pair run at the all-players position
  // (the player mobj enters the arena with M7 mobjs; the after-all-players
  // order is kept so multi-player thinker interleaving never needs a
  // re-bless — the arena is empty for M5 scenarios, so this is order-
  // identical to M5-06).
  for (const p of state.players) pPlayerThink(state.pmap, p, state.leveltime);
  for (const p of state.players) {
    pXYMovement(state.pmap, p.mo);
    pZMovement(p.mo);
  }
  pRunThinkers(state.thinkers); // p_tick.c P_RunThinkers (M6-01 arena;
  // M7-02: the map-thing/mover mobj thinkers live HERE, in arena order)
  pUpdateSpecials(state); // p_spec.c button/scroll tick (M6-03 body)
  // P_RespawnSpecials (p_mobj.c:589) — item-respawn queue drain; the
  // deathmatch!=2 early return is taken in SP (queue still maintained by
  // P_RemoveMobj, p_mobj.pRespawnSpecials).
  pRespawnSpecials(state.mobjs);
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
