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
import type { RuntimeMap } from './map';
import { buildThingLinks } from './thinglinks';
import { pPlayerThink } from './puser';
import { pXYMovement, pZMovement } from './pmove';
import { createPlayer, PST_DEAD, PST_REBORN } from './player';
import { createPrngState, mClearRandom } from './prng';
import { emptyInput, gBuildTiccmd, type GameInput } from './ticcmd';
import { createHookSlots } from './hooks';
import { createThinkerArena, pRunThinkers } from './ptick';
import { createMobjRuntime, pRemoveMobj, pRespawnSpecials, pSpawnThings } from './p_mobj';
import { pplayerSoundLog } from './pplayer';
import { mobjinfo } from '../wad/info/mobjinfo';
import { gDoReborn } from './reborn';
import { registerPickupHook, setSpecialRemover, setSpecialSpriteLookup } from './p_inter_pickup';
import { registerAmmoHooks } from './p_ammo';
import { initPlayerInventory } from './p_inter_inventory';
import { stateSprite } from '../wad/info/states';
import { bindPplayerLevel } from './pplayer';
import { pSpawnSpecials, pUpdateSpecials } from './pspec';
import { bindShootWorld } from './p_shoot';
// M7-09: projectile spawns + splash — these modules self-register their
// hook/action slots at module load (psprHooks.spawnPlayerMissile,
// pmapHooks.missileHit/missileThingCheck, mobjHooks.startSound,
// A_Explode/A_BFGSpray); side-effect imports, nothing to call per level.
import './pmissiles';
import './pradius';
// M8-12 PRODUCTION FLIP (the enable the M8-04 NOTE held open): importing
// these five modules self-registers the monster AI + death + family action
// ids AT MODULE LOAD — A_Look/A_Chase/A_FaceTarget + the p_pspr.c:256
// P_NoiseAlert body (p_enemy.ts), A_Pain/A_Scream/A_XScream/A_Fall
// (pdeath.ts), and the family attacks A_PosAttack/A_SPosAttack/A_CPos*/
// A_TroopAttack (amon_poss.ts), A_SargAttack/A_SkullAttack (amon_sarg.ts),
// A_HeadAttack/A_BruisAttack/A_BossDeath (amon_bruiser.ts). Same idiom as
// the M7-09 pmissiles/pradius side-effect imports above; the domain-strict
// a_actions registry already routed every state-table id to a counted
// no-op before the flip, so nothing else changes. The damageBridge
// (p_inter_damage.ts) was already live via pplayer.bindPplayerLevel.
import './p_enemy';
import { aPain, aXScream } from './pdeath';
import { ACT, registerAction } from './a_actions';
import type { Mobj } from './p_mobj';
import './amon_poss';
import './amon_sarg';
import './amon_bruiser';
import {
  createLiveSectors,
  createWminfo,
  hashState,
  type GameState,
  type Skill
} from './state';
import {
  clampNewGame,
  parsFor,
  parseMapName,
  skillToInternal
} from './gamemode';
import { musicSlot, recordGameaction, resetHookSlots } from './hooks';

// M8-12 flip companion (D-m1 note): pdeath.ts registers the GENERIC
// p_enemy.c death/pain bodies into the mobj-domain slots — vanilla has ONE
// shared body per id — so it supersedes pplayer.ts's player-side fills for
// A_Pain (25) and A_XScream (28) (and A_Fall 27, where pdeath's mirror-write
// body is strictly more correct for the real player mobj too). The sim sound
// sink (hooks.sfx via sfxSlot) now carries player pain/gib sounds; the
// player-side observability log (pplayerSoundLog — reset per boot, never
// hashed) stays fed by re-registering the two sound ids as composites BELOW
// any graph that loads game.ts. Token knowledge mirrors pdeath.ts aPain /
// aXScream and the mobjinfo table (MT_PLAYER.painSound = sfx_plpain);
// sfx_slop is A_XScream's fixed gib token.
registerAction(
  ACT.A_Pain,
  (ctx) => {
    const m = ctx as Mobj & { playerRef?: unknown };
    aPain(m);
    const token = mobjinfo[m.type]!.painSound;
    if (m.playerRef !== undefined && token !== '0' && token !== 'sfx_None' && pplayerSoundLog.length < 256) {
      pplayerSoundLog.push({ token, tic: m.rt.state.leveltime });
    }
  },
  'mobj'
);
registerAction(
  ACT.A_XScream,
  (ctx) => {
    const m = ctx as Mobj & { playerRef?: unknown };
    aXScream(m);
    if (m.playerRef !== undefined && pplayerSoundLog.length < 256) {
      pplayerSoundLog.push({ token: 'sfx_slop', tic: m.rt.state.leveltime });
    }
  },
  'mobj'
);

/** Fixed simulation rate (ARCHITECTURE §3.1: 35 Hz; = TICRATE). */
export const TICS_PER_SECOND = TICRATE;

/* ------------------------------------------------------------------ */
/* M9-03 game-flow vocabulary (d_main.h / d_event.h)                    */
/* ------------------------------------------------------------------ */

/** d_main.h `gamestate_t` (M9-plan §0.2 routing table). */
export const GS = {
  LEVEL: 0,
  INTERMISSION: 1,
  FINALE: 2,
  DEMOSCREEN: 3
} as const;

/** d_event.h:55-65 `gameaction_t` (drain table §0.2). */
export const GA = {
  nothing: 0,
  loadlevel: 1,
  newgame: 2,
  loadgame: 3,
  savegame: 4,
  playdemo: 5,
  completed: 6,
  victory: 7,
  worlddone: 8,
  screenshot: 9
} as const;

/* ------------------------------------------------------------------ */
/* M9-03 registrable flow hooks (M8 self-import idiom)                  */
/* ------------------------------------------------------------------ */

/**
 * Module-level hook registry (M8 self-import idiom, mirroring the
 * a_actions/specials-table registries): a LATER module (wintermission.ts
 * M9-07, finale/title.ts M9-10, menu.ts M9-04) imports game.ts and calls
 * {@link registerGameFlowHooks} at module load — game.ts imports NOTHING
 * of them, so those tasks never re-edit game.ts. Whoever loads the module
 * (main.ts wiring / a test import) activates the hook.
 */
export type FlowTicFn = (state: GameState, input: GameInput) => void;
export type FlowActFn = (state: GameState) => void;
/** (episode, map) → ready RuntimeMap, or null when unresolvable (the
 * WAD seam lives in main.ts; game.ts stays WAD-agnostic). */
export type LevelLoaderFn = (
  state: GameState, episode: number, map: number
) => RuntimeMap | null;

export interface GameFlowHooks {
  /** GS_INTERMISSION per-tic driver — WI_Ticker (M9-07). */
  wiTicker?: FlowTicFn;
  /** GS_FINALE per-tic driver — F_Ticker (M9-10). */
  finaleTicker?: FlowTicFn;
  /** GS_DEMOSCREEN per-tic driver — D_PageTicker (M9-10). */
  pageTicker?: FlowTicFn;
  /** advancedemo flag consumer — D_DoAdvanceDemo (M9-10 reduced attract). */
  advanceDemo?: FlowActFn;
  /** d_main.c:382 tic-block M_Ticker (M9-04 menu skull). */
  mTicker?: FlowActFn;
  /** ga_completed case — G_DoCompleted wminfo fill + routing (M9-07/08). */
  doCompleted?: FlowActFn;
  /** ga_victory case — F_StartFinale (M9-10). */
  startFinale?: FlowActFn;
  /** D_StartTitle (M9-10; F7-end/quit target). */
  startTitle?: FlowActFn;
  /** Display-block wipe start (d_main.c:216-222; the f_wipe body is the
   * M9-01/09 vvideo seam) — called ONCE per sentinel consumption. */
  wipe?: (gamestate: number) => void;
  /** G_DoLoadLevel map source (main.ts WAD wiring; tests register a
   * fixture loader). */
  levelLoader?: LevelLoaderFn;
}

const flowHooks: GameFlowHooks = {};

/** Merge hook implementations into the registry (undefined values in a
 * partial leave existing entries untouched). */
export function registerGameFlowHooks(h: Partial<GameFlowHooks>): void {
  Object.assign(flowHooks, h);
}

/** Unregistered-handler recorder — the M8 unimplementedSpecial guard-
 * counter idiom (specials-table.ts): EVERY hit counts, nothing throws,
 * and the caller's while-loop never spins (see gDrainGameAction). */
export const flowStubHits = { count: 0, byName: new Map<string, number>() };

export function resetFlowStubHits(): void {
  flowStubHits.count = 0;
  flowStubHits.byName.clear();
}

function flowStub(name: string): void {
  flowStubHits.count++;
  flowStubHits.byName.set(name, (flowStubHits.byName.get(name) ?? 0) + 1);
}

/** Test seam: clear the whole flow registry + recorder (gates rerun with
 * a clean slate; production wiring registers once at boot). */
export function resetGameFlow(): void {
  for (const k of Object.keys(flowHooks) as (keyof GameFlowHooks)[]) delete flowHooks[k];
  resetFlowStubHits();
}

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
 *  - M7-03: the player spawns as a REAL MT_PLAYER mobj at the player-start
 *    thing's THINGS-lump position (p_mobj.c P_SpawnMapThing → doomednum 1
 *    → P_SpawnPlayer → P_SpawnMobj), wired through
 *    {@link bindPplayerLevel} → `mobjs.playerSpawnFn`. The mobj's thinker
 *    (P_MobjThinker, M7-02 arena) IS its mover from here on — the M5
 *    manual P_XYMovement/P_ZMovement loop in {@link gTicker} is gone.
 */
export function gInitGame(map: RuntimeMap, skill: Skill = 2): GameState {
  const start = map.playerStarts[0];
  if (!start) {
    throw new GameSetupError(`map ${map.name}: no player 1 start (doomednum 1)`);
  }
  const parsed = parseMapName(map.name);
  const player = createPlayer();
  // M7-04: d_player.h inventory fields (ammo/maxammo/armor/…) must exist
  // before the first touch can reach P_Give*. Guarded attach — defers to
  // the canonical G_PlayerReborn init M7-03 wires (pplayer); until then
  // the pickup layer sees zeroed fields, never undefined.
  initPlayerInventory(player);
  // M7-05 (g_game.c:1440-1442): "First level load forces PST_REBORN" —
  // P_SpawnPlayer's PST_REBORN branch (p_mobj.c:656 via pplayer) runs
  // G_PlayerReborn DURING pSpawnThings below, so the new-game start set is
  // the verbatim g_game.c:820-830 one (pistol+fists raised, 50 clips,
  // maxammo table) instead of the attach-time fists placeholder. Values
  // otherwise match (createPlayer fields == the memset+restore list), so
  // every blessed hash stays byte-identical (weapon fields are off-hash).
  player.playerstate = PST_REBORN;

  // M9-03: map/pmap/sectors/thinkers/mobjs are installed by gSetupLevel
  // below (the SAME body G_DoLoadLevel reruns on a level reload) — the
  // null placeholders are the documented back-reference idiom already
  // used for `mobjs` (never observable in between).
  const state: GameState = {
    map,
    pmap: null as unknown as GameState['pmap'],
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
    sectors: null as unknown as GameState['sectors'],
    thinkers: null as unknown as GameState['thinkers'],
    hooks: createHookSlots(),
    exitRequest: 'none',
    totalsecret: 0, // P_SpawnSpecials sector-9 pass (M6-03) counts this
    secretcount: 0,
    specialexit: false,
    // M9-03 flow fields: boot = straight into a live level (the deferred
    // route is gDeferedInitNew below). wipegamestate == gamestate ⇒ no
    // first-frame melt (d_main.c:451 forces -1 only on a RELOAD).
    gamestate: GS.LEVEL,
    wipegamestate: GS.LEVEL,
    gameaction: GA.nothing,
    gamemap: parsed?.map ?? 1,
    gameepisode: parsed?.episode ?? 1,
    gameskill: skill + 1, // 1-based deferred-init domain (gamemode.ts)
    usergame: true, // g_game.c:1440 (single-player boot)
    paused: false,
    viewactive: true, // g_game.c:806 (G_DoLoadLevel)
    advancedemo: false,
    wminfo: createWminfo(parsFor(parsed?.episode ?? 1)),
    // M7-02: placeholder replaced immediately below (the runtime
    // back-references the state; never observable in between).
    mobjs: null as unknown as GameState['mobjs']
  };
  gSetupLevel(state, map, true);
  return state;
}

/**
 * P_SetupLevel equivalent — the half of gInitGame that (re)loads a level
 * onto an EXISTING GameState identity (identity preservation is the
 * g_game.c:445 G_DoLoadLevel contract: debug/main references stay valid).
 * The statement order is the former gInitGame tail VERBATIM (mobj runtime
 * → hook registrations → binds → [M_ClearRandom] → thing spawns →
 * specials → hitscan bind), so the boot hash is byte-untouched.
 *
 * `clearRandom` pins the g_game.c:1414 call position for the BOOT load
 * only (M9-03 acceptance 2); G_InitNew reruns M_ClearRandom itself
 * (§0.4/G_InitNew below) and a plain level RELOAD must NOT reseed the
 * PRNG streams mid-run (g_game.c clears at InitNew, never at load).
 */
function gSetupLevel(state: GameState, map: RuntimeMap, clearRandom: boolean): void {
  state.map = map;
  const bm = buildBlockMap(map);
  const links = buildThingLinks(map, bm, { skill: state.skill });
  state.pmap = { map, bm, links };
  state.sectors = createLiveSectors(map);
  state.thinkers = createThinkerArena(); // P_InitThinkers (p_tick.c:71)
  state.leveltime = 0; // P_SetupLevel (p_setup.c)
  state.totalsecret = 0; // P_SetupLevel totalsecret = 0 (g_game.c)
  state.wminfo.totaltime = 0; // g_game.c: P_SetupLevel zeroes wminfo.totaltime
  // p_setup.c:597-601 `players[i].killcount = players[i].secretcount =
  // players[i].itemcount = 0` — per-level tally counters reset on EVERY
  // load (death reload included: G_PlayerReborn's preserve/restore pair
  // then preserves ZERO; its preservation is only observable on the
  // netgame respawn path, M12). secretcount is the game-level
  // player->secretcount proxy (state.ts:190) — same zeroing verdict.
  for (const p of state.players) {
    p.killcount = 0;
    p.itemcount = 0;
  }
  state.secretcount = 0;
  resetHookSlots(state.hooks); // entry logs fresh; bodies/bridges STAY
  state.mobjs = createMobjRuntime(state);
  // M7-04 pickups: fill the M5-02 PIT_CheckThing touch slot against THIS
  // level's mobj runtime. ThingLinks carries no sprite/thinker reference,
  // so the p_inter sprite switch and the P_RemoveMobj tail resolve through
  // the two seams (lazy: they read rt.slotMobjs at touch time).
  registerPickupHook();
  // M7-05: authoritative P_CheckAmmo ladder (p_pspr `checkAmmo` seam) +
  // the BT_CHANGE weapon-switch block (puser `weaponChange` seam).
  registerAmmoHooks();
  const mobjRt = state.mobjs;
  setSpecialSpriteLookup((slot) => {
    const m = mobjRt.slotMobjs.get(slot);
    return m && !m.removed ? stateSprite[m.state]! : -1;
  });
  setSpecialRemover((slot) => {
    const m = mobjRt.slotMobjs.get(slot);
    if (!m || m.removed) return false;
    pRemoveMobj(m);
    return true;
  });
  // M7-03: registers mobjs.playerSpawnFn (real P_SpawnPlayer; spawns the
  // player mobj DURING pSpawnThings below — vanilla P_LoadThings order,
  // so the thinker-arena position of the player mobj is exact), binds the
  // p_pspr world and the player-side action/hook registrations. MUST run
  // before pSpawnThings.
  bindPplayerLevel(state);
  if (clearRandom) mClearRandom(state.rng); // g_game.c:1414
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
  // M7-08 hitscan world bind (plan §M7-08 owns "the game-boot bind"). Two
  // effects, both side-effect-free at boot: (a) importing p_shoot.ts runs
  // its module-load `registerPsprHook` block, so the p_pspr.ts A_Fire*/
  // A_Punch/A_Saw call sites reach the REAL P_AimLineAttack/P_LineAttack/
  // R_PointToAngle2 instead of the counted no-op defaults; (b) the bound
  // level lets the traversers walk this map's blockmap + ThingLinks grid.
  // Nothing traverses until a weapon actually fires (the psprite machine
  // is ticked by puser.ts / M7-03), so no boot-time draw and no hash move.
  bindShootWorld(state);
  // M10-08: the ONE new audio call site of the milestone — S_Start()'s
  // music selection at the TAIL of P_SetupLevel (p_setup.c:607,
  // s_sound.c:202-248; M10-plan §0.6/§M10-08). Event-only (musicLog +
  // live listener; zero PRNG, zero sim state — the audio consumer
  // src/audio/musicSelect.ts resolves episode/map through its seam).
  musicSlot('level', true); // level music ALWAYS loops (s_sound.c:245)
}

/* ------------------------------------------------------------------ */
/* G_Ticker (g_game.c:605) — one tic                                   */
/* ------------------------------------------------------------------ */

/**
 * Advance `state` exactly one tic with the platform-supplied input snapshot.
 * §3.2/g_game.c:605 order (M9-03 completes steps 2 and 5):
 *  1. reborn pass (g_game.c:613-614) — {@link gDoReborn} (M9-08: faithful
 *     `gameaction = ga_loadlevel`; the level RELOADS through the step-2
 *     drain in the SAME tic — D017 retired, plan §0.5);
 *  2. gameaction drain (g_game.c:621-649) — the while-loop switch,
 *     {@link gDrainGameAction}; gameaction NEVER survives a completed
 *     gTicker (acceptance 3 — handlers clear it up front, and the
 *     guard-counter idiom catches unregistered ones);
 *  3. build the ticcmd and copy it into `player.cmd` (vanilla copies from the
 *     netcmds ring; single-player builds directly, same slot semantics);
 *  4. special buttons (pause/save BT_SPECIAL) — no buttons source yet:
 *     in-game pause sets `state.paused` directly (menu/M9-04+), the
 *     p_tick.c:140 gate lives in gLevelTicker;
 *  5. per-state driver (§0.2 routing table): GS_LEVEL → P_Ticker body
 *     below; GS_INTERMISSION/GS_FINALE/GS_DEMOSCREEN → the registrable
 *     hooks (wiTicker M9-07 / finaleTicker+pageTicker M9-10) — an
 *     UNregistered state handler is a counted flowStub hit, never a
 *     crash or a spin (guard-counter idiom).
 *
 * `gametic++` (vanilla d_main.c:383-385 right after G_Ticker) is folded in
 * here so the headless loop cannot forget it — it runs for EVERY gamestate
 * exactly like vanilla.
 */
export function gTicker(state: GameState, input: GameInput = emptyInput()): void {
  // 1: reborn pass (g_game.c:613-614) — M9-08: playerstate == PST_REBORN
  // ⇒ G_DoReborn (g_game.c:924). Single-player (!netgame) is
  // `gameaction = ga_loadlevel` (:928): the LEVEL restarts from scratch
  // through the step-2 drain below in THIS tic (G_DoLoadLevel →
  // P_SetupLevel — monsters, items, specials and the per-level counters
  // all respawn; the player respawns pistol-start at the 1-player start
  // via the P_SpawnPlayer PST_REBORN branch). D017's in-place deviation
  // retired here per plan §0.5; netgame respawn branch = M12 (§4).
  for (const p of state.players) {
    if (p.playerstate === PST_REBORN) gDoReborn(state);
  }

  // 2: gameaction drain (g_game.c:621-649) — only when an action is
  // pending (fast path keeps the blessed-tic cost at one comparison).
  if (state.gameaction !== GA.nothing) gDrainGameAction(state);

  // 3: G_BuildTiccmd → players[0].cmd (consoleplayer).
  const cmd = gBuildTiccmd(input, state);
  for (const p of state.players) p.cmd = cmd;

  // 4: special buttons (pause/save) — none (see header).

  // 5: per-state driver (§0.2).
  switch (state.gamestate) {
    case GS.LEVEL: {
      // GS_LEVEL → P_Ticker (p_tick.c order, M5-06 + M6-01 + M7-03):
      // P_PlayerThink for ALL players, THEN P_RunThinkers. Since M7-03
      // the player's mobj IS an arena thinker — but the MOVEMENT half of
      // P_MobjThinker (the M5-06 P_XYMovement/P_ZMovement pair) still
      // runs HERE, before P_RunThinkers: the blessed M5 tick moved the
      // player before every mover, and specials crossed by that
      // movement (P_CrossSpecialLine spawning door/crusher movers) must
      // therefore reach the arena while it is NOT running —
      // direct-insert, present in this tic's snapshot — exactly like
      // M5/M6. Inside the arena the player entry ticks only the mobj
      // STATE (pplayer.ts); vanilla's strict single-list order (movers
      // before the post-P_SetupLevel player thinker) is DOCUMENTED as
      // intentionally not matched here — keeping the blessed hashes
      // outranks it (docs/reports/M7-03-implementer.md).
      // p_tick.c:140-152 paused gate (M9-03 wiring): while paused the
      // ENTIRE thinker half is skipped but `leveltime++` still runs
      // (faithful P_Ticker: clocks tick, world sleeps).
      if (!state.paused) {
        for (const p of state.players) {
          pPlayerThink(state.pmap, p, state.leveltime);
          pXYMovement(state.pmap, p.mo); // momentum set by P_MovePlayer above
          pZMovement(p.mo);
        }
        pRunThinkers(state.thinkers); // p_tick.c P_RunThinkers (M6-01 arena;
        // M7-02: the map-thing/mover mobj thinkers live HERE, in arena order;
        // M7-03: the player's entry ticks its mobj STATE only — the
        // state/channel is excludeFromHash, so its in-run phase is invisible
        // to the blessed hashes).
        pUpdateSpecials(state); // p_spec.c button/scroll tick (M6-03 body)
        // P_RespawnSpecials (p_mobj.c:589) — item-respawn queue drain; the
        // deathmatch!=2 early return is taken in SP (queue still maintained by
        // P_RemoveMobj, p_mobj.pRespawnSpecials).
        pRespawnSpecials(state.mobjs);
      }
      state.leveltime++; // p_tick.c P_Ticker tail
      break;
    }
    case GS.INTERMISSION:
      gRouteTic('wiTicker', flowHooks.wiTicker, state, input); // M9-07
      break;
    case GS.FINALE:
      gRouteTic('finaleTicker', flowHooks.finaleTicker, state, input); // M9-10
      break;
    case GS.DEMOSCREEN:
      gRouteTic('pageTicker', flowHooks.pageTicker, state, input); // M9-10
      break;
    default:
      flowStub(`gamestate_${state.gamestate}`);
  }

  state.gametic++; // d_main.c tic loop tail
}

/** Per-state tic routing: registered hook body, else counted stub (the
 * state machine never stalls the clock or spins — §0.2). */
function gRouteTic(
  name: string, fn: FlowTicFn | undefined, state: GameState, input: GameInput
): void {
  if (fn !== undefined) fn(state, input);
  else flowStub(name);
}

/* ------------------------------------------------------------------ */
/* gameaction drain + deferred init (g_game.c:605-649/:1333-1357)       */
/* ------------------------------------------------------------------ */

/** while-loop guard (M8 unimplementedSpecial guard-counter idiom): the
 * 1.10 chain is bounded (newgame→loadlevel is the longest legal two-step;
 * d_event.h lists 9 actions) — a handler that RE-arms forever is a bug,
 * caught as a counted `gameaction-loop` stub + forced clear instead of a
 * frozen headless run. */
const GAMEACTION_MAX_DRAIN = 16;

/** g_game.c:621-649 — the switch drain. EVERY drained action lands in
 * hooks.gameactionLog; gameaction is cleared BEFORE the handler body runs
 * (each vanilla G_DoX clears it first), which is what makes acceptance 3
 * ("never survives a completed gTicker") structural, not aspirational. */
function gDrainGameAction(state: GameState): void {
  let guard = 0;
  while (state.gameaction !== GA.nothing) {
    const action = state.gameaction;
    if (++guard > GAMEACTION_MAX_DRAIN) {
      flowStub('gameaction-loop');
      state.gameaction = GA.nothing;
      break;
    }
    recordGameaction(action, state.gametic);
    state.gameaction = GA.nothing; // the G_DoX heads do this (g_game.c:1339…)
    switch (action) {
      case GA.loadlevel:
        gDoLoadLevel(state);
        break;
      case GA.newgame:
        gDoNewGame(state);
        break;
      case GA.completed:
        // G_DoCompleted (g_game.c:1020 — wminfo fill, E1M8⇒ga_victory,
        // WI_Start): the faithful body is M9-07/08; until registered it
        // is a counted stub, and the level keeps ticking (D013(e) exit-
        // latch semantics preserved for the existing M6 corpora).
        if (flowHooks.doCompleted) flowHooks.doCompleted(state);
        else flowStub('ga_completed');
        break;
      case GA.victory:
        if (flowHooks.startFinale) flowHooks.startFinale(state); // M9-10
        else flowStub('ga_victory');
        break;
      case GA.worlddone:
        gDoWorldDone(state);
        break;
      default:
        // ga_loadgame/ga_savegame/ga_playdemo/ga_screenshot — §4
        // registered stubs (M11/M12).
        flowStub(`ga_${action}`);
    }
  }
}

/** G_DeferedInitNew (g_game.c:1333): store d_skill/d_episode/d_map and
 * defer — the menu code must NEVER call G_InitNew mid-tic (§0.4). The
 * skill argument is the 1-based deferred-init domain (M9-04 menu calls
 * `gDeferedInitNew(5, epi + 1, 1)` for nightmare). */
export function gDeferedInitNew(
  state: GameState, skill: number, episode: number, map: number
): void {
  state.gameskill = skill;
  state.gameepisode = episode;
  state.gamemap = map;
  state.gameaction = GA.newgame;
}

/** G_ExitLevel (g_game.c:1002-1006): secretexit=false; ga_completed.
 * NOTE: the pspec/pwitch call sites still ride the M6 pexit.ts proxy
 * (exitRequest latch, D013(e)); M9-08 rewires them to THIS body. */
export function gExitLevel(state: GameState): void {
  state.specialexit = false; // g_game.c:1004 (specialexit IS secretexit)
  state.gameaction = GA.completed;
}

/** G_SecretExitLevel (g_game.c:1009-1017; Doom-1 path — the commercial
 * guard is unreached under the shareware policy, D013(g)). */
export function gSecretExitLevel(state: GameState): void {
  state.specialexit = true; // g_game.c:1015
  state.gameaction = GA.completed;
}

/** G_WorldDone (g_game.c:1147): the WI tally hands control back. */
export function gWorldDone(state: GameState): void {
  state.gameaction = GA.worlddone;
}

/** G_DoNewGame (g_game.c:1345): force the single-player truth values.
 * The fields the port has no storage for (demoplayback/netgame/
 * deathmatch/respawnparm/fastparm/nomonsters) are compile-time-false
 * constants of this build — the §0.4 "truth" they'd be set to already
 * holds; consoleplayer=0 is the players[0]-is-consoleplayer invariant. */
function gDoNewGame(state: GameState): void {
  state.usergame = true;
  state.paused = false;
  gInitNew(state, state.gameskill, state.gameepisode, state.gamemap);
}

/** G_InitNew (g_game.c:1365): the §0.4 clamp table (gamemode.ts),
 * usergame/paused truth, `playerstate = PST_REBORN` for ALL players
 * (:1423 — the first level load spawns via the PST_REBORN pass, §0.4),
 * the g_game.c:1414 M_ClearRandom, then G_DoLoadLevel. The nightmare/
 * fastparm state-tics bookkeeping (:1404-1420) is unreachable: this
 * port has no -fast/respawn parms (§4). */
export function gInitNew(
  state: GameState, skill: number, episode: number, map: number
): void {
  const c = clampNewGame(skill, episode, map);
  state.gameskill = c.skill; // 1-based domain (acceptance 4: 6→5)
  state.skill = skillToInternal(c.skill) as Skill; // 0-based build world
  state.gameepisode = c.episode;
  state.gamemap = c.map;
  state.usergame = true; // g_game.c:1440
  state.paused = false;
  for (const p of state.players) p.playerstate = PST_REBORN; // :1423
  mClearRandom(state.rng); // g_game.c:1414 (BOTH PRNGs — menu-stream pin)
  gDoLoadLevel(state);
}

/** G_DoLoadLevel (g_game.c:445): wipe-force sentinel, gamestate=GS_LEVEL,
 * paused=false/viewactive=true (:490-497 input half is the main.ts seam,
 * M9-08 owns the input clear), and the in-place P_SetupLevel via
 * {@link gSetupLevel}. The map bytes come from the registered
 * `levelLoader` (WAD seam — main.ts); unresolved loads are counted stubs
 * (the tic keeps ticking the OLD level — never a crash, never a spin). */
function gDoLoadLevel(state: GameState): void {
  if (state.wipegamestate === GS.LEVEL) state.wipegamestate = -1; // :451
  if (flowHooks.levelLoader === undefined) {
    flowStub('level-loader');
    return;
  }
  const map = flowHooks.levelLoader(state, state.gameepisode, state.gamemap);
  if (map === null) {
    flowStub('level-load-fail');
    return;
  }
  const parsed = parseMapName(map.name);
  if (parsed) {
    state.gameepisode = parsed.episode;
    state.gamemap = parsed.map;
  }
  state.gamestate = GS.LEVEL; // g_game.c:461
  state.paused = false; // :497 (sendpause/paused = false half)
  state.viewactive = true; // g_game.c:806
  // g_game.c:477-483: a player still flagged PST_DEAD at a load joins the
  // reborn spawn (the death chain arrives PST_REBORN already — the pass
  // consumed the latch; this half covers loads armed while dead, e.g. an
  // exit latched in the death tic) + the per-load frags memset.
  for (const p of state.players) {
    if (p.playerstate === PST_DEAD) p.playerstate = PST_REBORN; // :479-481
    p.frags.fill(0); // :482 memset(players[i].frags,0,…)
  }
  gSetupLevel(state, map, false);
}

/** G_DoWorldDone (g_game.c:1172): gamestate=GS_LEVEL;
 * gamemap = wminfo.next + 1 (§0.3); G_DoLoadLevel. The wminfo.next
 * ROUTING itself (secretexit⇒8 / map9⇒home-table / gamemap) is filled by
 * the G_DoCompleted body — M9-07/08 register it via the `doCompleted`
 * hook; the carrier defaults (next=0 ⇒ map 1) keep the plumbing testable
 * today. */
function gDoWorldDone(state: GameState): void {
  state.gamestate = GS.LEVEL;
  state.gamemap = state.wminfo.next + 1;
  gDoLoadLevel(state);
}

/* ------------------------------------------------------------------ */
/* d_main.c frame/tic seams (§0.6) — called by main.ts, NOT by gTicker  */
/* ------------------------------------------------------------------ */

/**
 * Tic-block preamble (d_main.c:381-383): consume the `advancedemo` flag
 * (D_DoAdvanceDemo — M9-10's reduced TITLEPIC attract) and run M_Ticker
 * (M9-04 menu skull). Runs ONCE per tic, BEFORE G_Ticker, exactly where
 * the 1.10 tic block does. M_Ticker before any menu registers is a silent
 * no-op (menuactive=false ⇒ vanilla's body returns immediately).
 */
export function gFlowTic(state: GameState): void {
  if (state.advancedemo) {
    state.advancedemo = false;
    if (flowHooks.advanceDemo) flowHooks.advanceDemo(state);
    else flowStub('advanceDemo');
  }
  flowHooks.mTicker?.(state);
}

/**
 * Display-block wipe sentinel (d_main.c:196-222): returns true EXACTLY
 * ONCE per gamestate change (also covers the g_game.c:451 -1 force),
 * consuming it: wipegamestate := gamestate, then the registered `wipe`
 * hook (renderer seam — the f_wipe melt body lands with M9-01/09).
 */
export function takeWipeRequest(state: GameState): boolean {
  if (state.wipegamestate === state.gamestate) return false;
  state.wipegamestate = state.gamestate;
  flowHooks.wipe?.(state.gamestate);
  return true;
}

/** D_StartTitle (g_game.c:525) half: demosequence reset lives with the
 * M9-10 title module (hook `startTitle`); unregistered ⇒ counted stub. */
export function gStartTitle(state: GameState): void {
  if (flowHooks.startTitle) flowHooks.startTitle(state);
  else flowStub('startTitle');
}

/** Request the d_main attract advance (d_main.c sets advancedemo=1 on the
 * page-timeout; M9-10 owns the timeout, this is the setter seam). */
export function gRequestAdvanceDemo(state: GameState): void {
  state.advancedemo = true;
}

// M9-08: gDoRebornInPlace (the D017 in-place deviation body) is DELETED.
// The reborn pass now routes through reborn.ts gDoReborn → ga_loadlevel
// (plan §0.5; docs/DECISIONS.md D017 retires at M9 — docs task transcribes).

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
