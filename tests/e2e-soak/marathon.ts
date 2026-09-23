/**
 * M12-05 — SOAK MARATHON ENGINE: seeded-PRNG random-input soak + level
 * rotation + memory/pool leak audit, on the main.ts-parity live loop
 * (harness.ts). The BUGS.md standing lesson ("exit sweeps should add a
 * live-session soak test") banked at milestone scale.
 *
 * WHAT RUNS (plan §M12-05, one honest live instance):
 *  - SEEDED INPUT: splitmix64 drives the A-09 key table (move/strafe/run/
 *    fire/use/weapon-slot keys) + automap toggles + menu visits (ESC in,
 *    arrows, ESC out — ENTER is NEVER injected: the main menu's row 0 is
 *    New Game and the Options menu's row 0 is End Game (m_menu.c:250/:365)
 *    and the harness has no cursor readback to avoid them; arrow-wandering
 *    exercises M_Responder/M_Ticker/menusaved statics without firing a
 *    routine). The harness zeroes the ticcmd while the menu panel is open
 *    (main.ts:437 / g_game.c:569-573 parity) — menu visits therefore add
 *    display-tics without sim-drift, exactly like the browser.
 *  - LEVEL ROTATION via the FAITHFUL exit latch (pexit D013(e) seam the
 *    harness drains → G_ExitLevel/G_SecretExitLevel → WI → G_DoWorldDone →
 *    next map through the harness levelLoader → the main.ts:492-501
 *    level-rebuild guard fires on the new state.map IDENTITY). E1M7 gets a
 *    coin-flip SECRET exit (both WI shapes), E1M8's exit rides ga_victory
 *    → the GS.FINALE drawer, and the attract tail is exited with a faithful
 *    G_DeferedInitNew re-entry (counted, reported).
 *  - FAITHFUL REBORNS: every {@link REBORN_EVERY} tics the engine sets
 *    playerstate=PST_REBORN mid-level — the gTicker step-1 pass calls
 *    gDoReborn (g_game.c:924: gameaction=ga_loadlevel ⇒ P_SetupLevel
 *    rebuilds the thinker arena + mobj runtime IN THE SAME TIC). Natural
 *    deaths rejoin the count through the faithful death chain (the
 *    generator's USE key re-animates at the death camera; a >DEAD_STUCK
 *    hold force-presses it). A reborn is DETECTED as a same-gamemap map-
 *    object reload (never assumed from the intent).
 *  - PER-TIC INVARIANTS (every tic unless noted): no NaN/∞ in the hash
 *    inputs (player mobj words + viewz/health every tic; every live
 *    thinker's hashWords every 32 tics), hash self-consistency (hashState
 *    twice ⇒ equal — the hash must stay side-effect-free/deterministic)
 *    every 8 tics, hook-log caps vs HOOK_LOG_CAP every 256 tics, plus the
 *    run-end flowStub census (WI/finale/page/M tickers are ALL registered
 *    — any stub hit means a state entered WITHOUT its driver: FINDING).
 *  - MEMORY AUDIT: per-level occupied-mobj-slot census + live-thinker
 *    count baselined at first sight of a map; every RELOAD of a map
 *    (rotation revisit or faithful reborn) must land back in the
 *    post-setup band — the leak perimeter for the two arenas + the
 *    slotMobjs/hook-bridge maps. v8 heapUsed sampled with a forced GC at
 *    every sim-minute (gc() when the runner exposes it) — growth beyond
 *    the pinned threshold = FINDING, retained-object profile attached.
 *
 * THE RUN IS SIM-CLOCKED: wall time is measured and REPORTED, never
 * slept; N sim-minutes = N*35*60 tics of the full live loop (display
 * every tic — one rAF cycle per tic like main.ts, not fast-forward).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import * as v8 from 'node:v8';
import * as vm from 'node:vm';
import { setViewSize } from '../../src/render/view';
import { flowStubHits, gDeferedInitNew, GS, resetFlowStubHits } from '../../src/sim/game';
import { PST_REBORN } from '../../src/sim/player';
import { thinkerCount } from '../../src/sim/ptick';
import { hashState } from '../../src/sim/state';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { mapNameFor } from '../../src/sim/gamemode';
import {
  captureLog,
  cheatLog,
  gameactionLog,
  HOOK_LOG_CAP,
  musicLog,
  sfxStubLog,
  uiSfxLog,
  resetCaptureLog,
  resetCheatLog,
  resetGameactionLog,
  resetSfxStubLog
} from '../../src/sim/hooks';
import { wiPeek, wiResetPlayerFlags } from '../../src/sim/wintermission';
import { menuState, resetMenuStubHits, menuStubHits } from '../../src/ui/menu';
import { createLiveSoak, resetSoakModules, type LiveSoak } from './harness';

/* ------------------------------------------------------------------ */
/* splitmix64 (Steele et al. / the FastSplitMixNL family) — seeded,     */
/* deterministic, no host entropy. One 64-bit draw per internal call.   */
/* ------------------------------------------------------------------ */

const M64 = (1n << 64n) - 1n;

export class Splitmix64 {
  private x: bigint;
  constructor(seed: number | bigint) {
    this.x = (typeof seed === 'bigint' ? seed : BigInt(seed >>> 0)) & M64;
  }
  next(): bigint {
    this.x = (this.x + 0x9e3779b97f4a7c15n) & M64;
    let z = this.x;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & M64;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & M64;
    return z ^ (z >> 31n);
  }
  /** uniform [0, n) */
  int(n: number): number {
    return Number(this.next() % BigInt(n));
  }
  /** true with probability num/den */
  chance(num: number, den: number): boolean {
    return this.int(den) < num;
  }
}

/* ------------------------------------------------------------------ */
/* Tunables (sim tics)                                                  */
/* ------------------------------------------------------------------ */

export const TICRATE = 35;
/** exit latch once a level has run this long (long enough for specials +
 * mobj churn + menu/automap visits to actually happen per level) */
export const LEVEL_MIN_TICS = 550;
/** faithful-reborn injection cadence (≈ every 55 s of sim time) */
export const REBORN_EVERY = 1950;
/** held-dead tics before the engine force-presses USE */
export const DEAD_STUCK = 90;
/** non-LEVEL tics tolerated before the forced-reentry recovery */
export const STUCK_RECOVERY = 1600;
/** menu visit cadence + length windows */
const MENU_EVERY = [700, 1400] as const;
const MENU_LEN = [40, 160] as const;
/** automap on-length window */
const AM_LEN = [80, 400] as const;

/* ------------------------------------------------------------------ */
/* Report shape                                                         */
/* ------------------------------------------------------------------ */

export interface LevelCensusRow {
  readonly map: string;
  readonly entryTic: number;
  readonly occupiedAtEntry: number;
  readonly thinkersAtEntry: number;
  readonly peakOccupied: number;
  readonly reloads: number;
  readonly reloadOccupiedDelta: number; // worst |occ - baseline| at reload
}

export interface MarathonReport {
  readonly simMinutes: number;
  readonly simTics: number;
  readonly wallMs: number;
  readonly ticsPerWallSecond: number;
  readonly gcForced: boolean;
  readonly levels: LevelCensusRow[];
  readonly mapOrder: string[];
  readonly rotations: number;
  readonly secretExits: number;
  readonly wiEnds: number;
  readonly finaleVisits: number;
  readonly forcedReentries: number;
  readonly faithfulReborns: number; // same-map reloads (detected)
  readonly deathReborns: number; //   …of which arrived via PST_DEAD
  readonly injectedReborns: number; // intents (ground truth for the ≥5 gate)
  readonly menuVisits: number;
  readonly automapToggles: number;
  readonly deaths: number;
  readonly flowStubs: Record<string, number>;
  readonly logCaps: { name: string; count: number; entries: number }[];
  readonly heapSamplesMb: number[];
  readonly heapBaselineMb: number;
  readonly heapDeltaMb: number;
  readonly heapPeakDeltaMb: number;
  readonly violations: string[];
}

/* ------------------------------------------------------------------ */
/* The engine                                                           */
/* ------------------------------------------------------------------ */

export function runMarathon(simMinutes: number, seed: number): MarathonReport {
  const totalTics = simMinutes * TICRATE * 60;
  resetSoakModules();
  resetFlowStubHits();
  resetGameactionLog();
  resetCheatLog();
  resetCaptureLog();
  resetSfxStubLog();
  resetMenuStubHits();
  wiResetPlayerFlags();
  setViewSize(10, 0); // windowed (320×144): status bar + borders in play

  const soak: LiveSoak = createLiveSoak();
  const state = soak.state;
  const rng = new Splitmix64(seed);
  const violations: string[] = [];
  const fail = (m: string): void => {
    if (violations.length < 50) violations.push(`tic ${state.gametic}: ${m}`);
  };

  /* ---- seeded input generator (A-09 key table) ---- */
  let forceUseNext = false; // death-camera USE backstop (P_DeathThink :225)
  const inputFn = (): GameInput => {
    const mv = rng.next();
    const ac = rng.next();
    // movement bits carved out of one draw (deterministic field split)
    const fwd = Number(mv & 1023n) < 320; // ~31 % forward
    const back = !fwd && Number((mv >> 10n) & 1023n) < 90;
    const turnL = Number((mv >> 20n) & 1023n) < 300;
    const turnR = !turnL && Number((mv >> 30n) & 1023n) < 300;
    const strafe = Number((mv >> 40n) & 1023n) < 110;
    const strafeL = strafe && Number((mv >> 50n) & 3n) === 1;
    const strafeR = strafe && !strafeL && Number((mv >> 52n) & 3n) !== 0;
    const run = Number((mv >> 54n) & 1023n) < 500; // ~49 % speed key
    const firing = Number(ac & 4095n) < 1100; // ~27 % fire duty
    const use = Number((ac >> 12n) & 4095n) < 330 || forceUseNext;
    forceUseNext = false;
    const wSlot = Number((ac >> 24n) & 4095n) < 140; // ~3.4 % weapon key
    return {
      ...emptyInput(),
      forward: fwd,
      backward: back,
      turnLeft: turnL && !strafeL,
      turnRight: turnR && !strafeR,
      strafeLeft: strafeL,
      strafeRight: strafeR,
      strafe,
      speed: run,
      attack: firing,
      use,
      weaponKey: wSlot ? rng.int(8) : undefined
    };
  };
  soak.setInput(inputFn);

  /* ---- menu visit machine (ESC/arrows only — see header) ---- */
  let menuPhase: 'idle' | 'open' | 'roam' | 'close' = 'idle';
  let menuTicsLeft = 0;
  let nextMenuTic = 400 + rng.int(400);
  let menuVisits = 0;
  const menuTic = (tic: number): void => {
    switch (menuPhase) {
      case 'idle':
        if (tic >= nextMenuTic && state.gamestate === GS.LEVEL) {
          menuPhase = 'open';
          menuVisits += 1;
        }
        break;
      case 'open':
        soak.menuKey(27); // ESC → main menu
        menuPhase = 'roam';
        menuTicsLeft = MENU_LEN[0] + rng.int(MENU_LEN[1] - MENU_LEN[0]);
        break;
      case 'roam':
        if (menuTicsLeft-- <= 0) {
          menuPhase = 'close';
          break;
        }
        if (rng.chance(6, 100)) soak.menuKey(rng.chance(1, 2) ? 200 : 208);
        if (!menuState.menuActive()) menuPhase = 'idle'; // vanished (e.g. level change)
        break;
      case 'close':
        soak.menuKey(27);
        if (!menuState.menuActive()) {
          menuPhase = 'idle';
          nextMenuTic = tic + MENU_EVERY[0] + rng.int(MENU_EVERY[1] - MENU_EVERY[0]);
        } else if (menuTicsLeft-- < -30) {
          fail('menu refused to close after 30 ESCs'); // stuck statics = FINDING
          menuPhase = 'idle';
        }
        break;
    }
  };

  /* ---- automap machine ---- */
  let amOn = false;
  let amTicsLeft = 0;
  let automapToggles = 0;
  const automapTic = (): void => {
    if (state.gamestate !== GS.LEVEL) return;
    if (!amOn && rng.chance(1, 900)) {
      amOn = true;
      automapToggles += 1;
      amTicsLeft = AM_LEN[0] + rng.int(AM_LEN[1] - AM_LEN[0]);
      soak.setAutomap(true);
    } else if (amOn && --amTicsLeft <= 0) {
      amOn = false;
      soak.setAutomap(false);
    }
  };

  /* ---- rotation + census bookkeeping ---- */
  const rows = new Map<string, LevelCensusRow>();
  const rowTouch = (name: string, occ: number, tk: number, tic: number): LevelCensusRow => {
    let r = rows.get(name);
    if (r === undefined) {
      r = {
        map: name, entryTic: tic, occupiedAtEntry: occ, thinkersAtEntry: tk,
        peakOccupied: occ, reloads: 0, reloadOccupiedDelta: 0
      };
      rows.set(name, r);
    }
    return r;
  };
  const occupiedMobjs = (): number => {
    let n = 0;
    for (const m of state.mobjs.mobjs) if (!m.removed) n += 1;
    return n;
  };
  const mapOrder: string[] = [];
  const currentMapName = (): string => mapNameFor(state.gameepisode, state.gamemap);

  let lastMapRef: unknown = state.map;
  let exitLatched = false;
  let exitLatchedTic = -1;
  let lastLevelMapRef = state.map;
  let lastLevelName = currentMapName();
  let rotations = 0;
  let secretExits = 0;
  let faithfulReborns = 0;
  let deathReborns = 0;
  let injectedReborns = 0;
  let finaleVisits = 0;
  let forcedReentries = 0;
  let deaths = 0;
  let wasDead = false;
  let recentlyDead = false; // set at the death camera, consumed by the reload
  let deadTics = 0;
  let lastGameState = state.gamestate;
  let nonLevelTics = 0;
  const wiEnds0 = wiPeek().endCount;

  const rotationTic = (tic: number): void => {
    // (a) exit latch: the faithful pexit seam — the harness drains this at
    // the NEXT stepTic head into G_ExitLevel/G_SecretExitLevel.
    if (
      !exitLatched && state.gamestate === GS.LEVEL && !menuState.menuActive() &&
      state.leveltime >= LEVEL_MIN_TICS
    ) {
      // E1M7: coin-flip secret exit (WI's two shapes); E1M9's natural
      // next is E1M4 (g_game.c:1101) — the chain keeps moving.
      const secret = state.gamemap === 7 && rng.chance(1, 2);
      state.exitRequest = secret ? 'secret' : 'normal';
      if (secret) secretExits += 1;
      exitLatched = true;
      exitLatchedTic = tic;
    }
    if (exitLatched && tic - exitLatchedTic > STUCK_RECOVERY + 600) {
      fail('exit latch never produced a new level');
      exitLatched = false;
    }

    // (b) faithful reborn injection (gTicker step-1 → gDoReborn).
    if (
      tic > 0 && tic % REBORN_EVERY === 0 && state.gamestate === GS.LEVEL &&
      !exitLatched && !menuState.menuActive() && state.players[0]!.playerstate === 0
    ) {
      state.players[0]!.playerstate = PST_REBORN;
      injectedReborns += 1;
    }

    // (c) death watch — the generator's USE re-animates the death camera
    // (P_DeathThink: BT_USE ⇒ PST_REBORN); a stuck corpse is force-pressed.
    const dead = state.players[0]!.playerstate === 1;
    if (dead && !wasDead) deaths += 1;
    if (dead) {
      deadTics += 1;
      recentlyDead = true;
      if (deadTics > DEAD_STUCK) forceUseNext = true; // P_DeathThink BT_USE latch
    } else deadTics = 0;
    wasDead = dead;

    // (d) map-identity watcher: NEW LEVEL (rotation) vs SAME-MAP RELOAD
    // (faithful reborn — the ≥5 census gate lands here, DETECTED not assumed).
    if (state.map !== lastMapRef) {
      lastMapRef = state.map;
      const name = currentMapName();
      const occ = occupiedMobjs();
      const tk = thinkerCount(state.thinkers);
      mapOrder.push(`${tic}→${name}`);
      if (state.gamestate === GS.LEVEL) {
        if (name === lastLevelName && state.leveltime <= 1) {
          // same-map reload = faithful reborn restart (P_SetupLevel rebuilt
          // the arenas IN TIC); it must land back in the post-setup band.
          faithfulReborns += 1;
          if (recentlyDead) {
            deathReborns += 1;
            recentlyDead = false;
          }
          const base = rowTouch(name, occ, tk, tic);
          const d = Math.abs(occ - base.occupiedAtEntry);
          base.reloads += 1;
          base.reloadOccupiedDelta = Math.max(base.reloadOccupiedDelta, d);
          if (d > 0) {
            fail(`reborn ${name}: occupied ${occ} vs post-setup band ${base.occupiedAtEntry}`);
          }
          if (tk !== base.thinkersAtEntry) {
            fail(`reborn ${name}: thinker pool ${tk} vs post-setup ${base.thinkersAtEntry}`);
          }
        } else {
          rotations += 1;
          recentlyDead = false;
          const first = !rows.has(name);
          const r = rowTouch(name, occ, tk, tic);
          if (!first && occ !== r.occupiedAtEntry) {
            // rotation revisit after another level: post-setup band again.
            fail(`revisit ${name}: occupied ${occ} vs post-setup band ${r.occupiedAtEntry}`);
          }
        }
        lastLevelName = name;
        lastLevelMapRef = state.map;
        exitLatched = false;
      }
    }

    // (e) non-LEVEL bookkeeping + stuck recovery (finale/attract tails).
    if (state.gamestate !== GS.LEVEL) {
      nonLevelTics += 1;
      if (state.gamestate !== lastGameState) {
        if (state.gamestate === GS.FINALE) finaleVisits += 1;
        lastLevelName = currentMapName(); // name at next LEVEL entry is the recovery target
      }
      if (nonLevelTics > STUCK_RECOVERY) {
        // finale tail / attract (no D_AdvanceDemo wad demos, D023): the
        // faithful re-entry is a deferred G_InitNew (New Game, E1).
        const nextMap = (state.gamemap % 9) + 1;
        gDeferedInitNew(state, 3, 1, nextMap);
        forcedReentries += 1;
        nonLevelTics = 0;
      }
    } else {
      nonLevelTics = 0;
    }
    lastGameState = state.gamestate;
  };

  /* ---- per-tic invariants ---- */
  let hashChecks = 0;
  const invariants = (tic: number): void => {
    const p = state.players[0]!;
    const mo = p.mo;
    if (
      !Number.isInteger(mo.x) || !Number.isInteger(mo.y) || !Number.isInteger(mo.z) ||
      !Number.isInteger(mo.momx) || !Number.isInteger(mo.momy) ||
      !Number.isInteger(mo.angle) || !Number.isInteger(p.viewz) ||
      !Number.isInteger(p.health)
    ) {
      fail(`NaN/non-int in player hash inputs x=${mo.x} y=${mo.y} z=${mo.z}`);
    }
    if (tic % 8 === 0) {
      const h1 = hashState(state);
      const h2 = hashState(state);
      hashChecks += 1;
      if (h1 !== h2) fail(`hash not self-consistent (${h1} vs ${h2})`);
    }
    if (tic % 32 === 0) {
      for (const t of state.thinkers.entries.values()) {
        if (t.removed) continue;
        for (const w of t.hashWords) {
          if (!Number.isInteger(w)) {
            fail(`non-int thinker word in thinker #${t.id}: ${w}`);
            break;
          }
        }
      }
    }
    if (tic % 256 === 0) {
      for (const log of [gameactionLog, cheatLog, captureLog, uiSfxLog, musicLog]) {
        if (log.entries.length > HOOK_LOG_CAP) fail(`hook log capped over: ${log.count}`);
      }
      // live occupancy census (peak band per current level)
      const r = rows.get(currentMapName());
      if (r !== undefined) r.peakOccupied = Math.max(r.peakOccupied, occupiedMobjs());
      // frames ring: the sampler keeps the LAST frame only — the array
      // itself must not be what the heap-growth check ends up measuring.
      if (soak.frames.length > 4) soak.frames.length = 4;
    }
  };

  /* ---- heap sampler (forced GC — the runner-agnostic way: globalThis.gc
   * when launched with --expose-gc, else the memlab trick: flip the V8
   * flag at runtime and pull the per-isolate gc out of a fresh context) ---- */
  let gc: (() => void) | undefined = (globalThis as { gc?: () => void }).gc;
  if (typeof gc !== 'function') {
    try {
      v8.setFlagsFromString('--expose-gc');
      const g = vm.runInNewContext('gc');
      if (typeof g === 'function') gc = g as () => void;
    } catch {
      gc = undefined; // honest: no forced GC available, sampler degrades
    }
  }
  const gcForced = gc !== undefined;
  const heap = (): number => {
    gc?.();
    gc?.();
    return process.memoryUsage().heapUsed / (1024 * 1024);
  };
  const heapSamplesMb: number[] = [];
  const sampleEvery = TICRATE * 60; // one sim minute
  const heapBaselineMb = heap();
  heapSamplesMb.push(heapBaselineMb);
  let nextHeapTic = sampleEvery;

  /* ---- the loop ---- */
  const t0 = performance.now();
  let tic = state.gametic;
  for (; tic < totalTics;) {
    soak.cycle(1); // ONE rAF-equivalent: tic + display (main.ts order)
    const now = state.gametic;
    if (now <= tic) break; // guard: the loop must advance the clock
    tic = now;
    menuTic(tic);
    automapTic();
    rotationTic(tic);
    invariants(tic);
    if (tic >= nextHeapTic) {
      heapSamplesMb.push(heap());
      nextHeapTic += sampleEvery;
    }
  }
  const wallMs = performance.now() - t0;

  // leave the menu closed: an honest end drain (the visit machine may have
  // been cut mid-visit by the tic budget — one ESC + tic until down).
  for (let i = 0; i < 16 && menuState.menuActive(); i += 1) {
    soak.menuKey(27);
    soak.cycle(1);
  }

  /* ---- end census ---- */
  const finalHeap = heap();
  const delta = heapSamplesMb.map((v) => v - heapBaselineMb);
  const logCaps = [
    { name: 'gameactionLog', count: gameactionLog.count, entries: gameactionLog.entries.length },
    { name: 'cheatLog', count: cheatLog.count, entries: cheatLog.entries.length },
    { name: 'captureLog', count: captureLog.count, entries: captureLog.entries.length },
    { name: 'uiSfxLog', count: uiSfxLog.count, entries: uiSfxLog.entries.length },
    { name: 'musicLog', count: musicLog.count, entries: musicLog.entries.length },
    { name: 'sfxStubLog', count: sfxStubLog.count, entries: sfxStubLog.byName.size }
  ];
  if (menuState.menuActive()) fail('menu left active at the end of the run');
  if (menuStubHits.count > 0) fail(`menuStubHits: ${[...menuStubHits.byName.keys()]}`);

  return {
    simMinutes,
    simTics: state.gametic,
    wallMs: Math.round(wallMs),
    ticsPerWallSecond: Math.round(state.gametic / (wallMs / 1000)),
    gcForced,
    levels: [...rows.values()],
    mapOrder,
    rotations,
    secretExits,
    wiEnds: wiPeek().endCount - wiEnds0,
    finaleVisits,
    forcedReentries,
    faithfulReborns,
    deathReborns,
    injectedReborns,
    menuVisits,
    automapToggles,
    deaths,
    flowStubs: Object.fromEntries(flowStubHits.byName),
    logCaps,
    heapSamplesMb: heapSamplesMb.map((v) => Math.round(v * 100) / 100),
    heapBaselineMb: Math.round(heapBaselineMb * 100) / 100,
    heapDeltaMb: Math.round((finalHeap - heapBaselineMb) * 100) / 100,
    heapPeakDeltaMb: Math.round(Math.max(...delta) * 100) / 100,
    violations
  };
}
