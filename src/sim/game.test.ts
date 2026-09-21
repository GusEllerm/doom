/**
 * sim/game + sim/state tests (M2-06) — G_InitGame wiring, the §3.2 G_Ticker
 * order (ticcmd → P_PlayerThink → leveltime++ → gametic++), hashState
 * sensitivity, and the M2-06 acceptance determinism contract: identical
 * seed+input scripts ⇒ identical state hash after 1000 tics.
 *
 * Map under test: FIXMAP (tests/fixtures/mapBuilder) — two rooms, default
 * things 1..4 at room 0's centre (128,128), angle 0.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';

import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData } from './map';
import {
  flowStubHits,
  GA,
  GameSetupError,
  gDeferedInitNew,
  gExitLevel,
  gFlowTic,
  gInitGame,
  gRequestAdvanceDemo,
  gSecretExitLevel,
  gTicker,
  gWorldDone,
  GS,
  registerGameFlowHooks,
  resetGameFlow,
  runHeadless,
  takeWipeRequest,
  TICS_PER_SECOND
} from './game';
import { hashState, type GameState } from './state';
import { emptyInput, type GameInput } from './ticcmd';
import { CF_NOCLIP, PST_LIVE } from './player';
import { gameactionLog, resetGameactionLog, resetSfxStubLog, sfxStub, sfxStubLog } from './hooks';

const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 200 },
    { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 }
  ],
  // M5-06: explicit spawn (the default fixture dot item is an MF_SOLID
  // barrel and would spawn INSIDE the player — the D009 fly path ignored
  // things, real physics does not).
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
};

function fixMap(name = 'FIXMAP') {
  const bytes = buildFixtureMapWad(SPEC);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), name));
}

function freshState(): GameState {
  return gInitGame(fixMap());
}

const script =
  (plan: readonly Partial<GameInput>[]) =>
  (_gametic: number, i: number): GameInput => ({
    ...emptyInput(),
    ...plan[i % plan.length]!
  });

/* Goldens recorded 2026-07 from this implementation on FIXMAP. Any change to
 * the ticcmd/player/state math must regenerate + explain these.
 * RE-BLESSED M5-06 (one-time): 'p_user physics replaces D009 fly stub' —
 * every scripted 1000-tic hash moves with real thrust/friction/onground/z
 * (spawn z resolves ONFLOORZ→floor; idle differs for that reason alone).
 * The fixture SPEC also gained an explicit player start (the default dot
 * item is an MF_SOLID barrel that used to spawn INSIDE the player).
 * RE-BLESSED M6-01 (one-time, reason: 'M6 world-state fields'): hashState
 * now serializes the live sector SoA + run globals + thinker arena (§3.4).
 * All three scripted 1000-tic hashes move by the added bytes alone — no
 * player-field or tic-order semantics changed (sectors static, arena
 * empty). */
const GOLDEN_IDLE_1000 = 222082345;
const GOLDEN_SCRIPT_1000 = 4261453639;
const GOLDEN_TURNLEFT_1000 = 3587061596;

describe('gInitGame', () => {
  it('spawns player 0 at the doomednum-1 start, clocks and rng zeroed', () => {
    const s = freshState();
    expect(s.players).toHaveLength(1);
    expect(s.players[0]!.mo.x).toBe(128 << 16);
    expect(s.players[0]!.mo.y).toBe(128 << 16);
    expect(s.players[0]!.mo.angle).toBe(0);
    expect(s.gametic).toBe(0);
    expect(s.leveltime).toBe(0);
    expect(s.rng).toEqual({ rndindex: 0, prndindex: 0 });
    expect(s.skill).toBe(2); // sk_medium default
    expect(s.turnheld).toBe(0);
  });

  it('missing player start → typed GameSetupError', () => {
    const bytes = buildFixtureMapWad({ ...SPEC, things: [{ x: 10, y: 10, type: 2035 }] });
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    expect(() =>
      gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')))
    ).toThrowError(GameSetupError);
  });

  it('runs at 35 Hz (ARCHITECTURE §3.1)', () => {
    expect(TICS_PER_SECOND).toBe(35);
  });
});

describe('gTicker order (§3.2)', () => {
  it('stores the built ticcmd on the player, then advances clocks once', () => {
    const s = freshState();
    gTicker(s, { ...emptyInput(), forward: true });
    expect(s.players[0]!.cmd.forwardmove).toBe(25); // forwardmove[0], g_game.c:175
    expect(s.leveltime).toBe(1);
    expect(s.gametic).toBe(1);
  });

  it('held turn integrates via angleturn<<16 with the slow→fast ramp', () => {
    const s = freshState();
    const input = { ...emptyInput(), turnRight: true };
    for (let i = 0; i < 5; i++) gTicker(s, input); // tics 1-5: -320 slow (right = clockwise)
    expect(s.players[0]!.mo.angle).toBe(-(5 * (320 << 16)) >>> 0);
    gTicker(s, input); // tic 6 ramps to -640
    expect(s.players[0]!.mo.angle).toBe((-(5 * (320 << 16)) - (640 << 16)) >>> 0);
  });
});

describe('hashState', () => {
  it('is a stable u32 for equal states and changes with any hashed field', () => {
    const a = freshState();
    const b = freshState();
    expect(hashState(a)).toBe(hashState(b));
    expect(hashState(a)).toBeGreaterThanOrEqual(0);
    expect(hashState(a)).toBeLessThanOrEqual(0xffffffff);

    gTicker(b); // leveltime/gametic move → different hash
    expect(hashState(b)).not.toBe(hashState(a));

    const c = freshState();
    c.players[0]!.mo.x = (c.players[0]!.mo.x + 1) | 0;
    expect(hashState(c)).not.toBe(hashState(a));

    const d = freshState();
    d.rng.prndindex = 1;
    expect(hashState(d)).not.toBe(hashState(a));

    const e = freshState();
    e.players[0]!.cheats = CF_NOCLIP;
    expect(hashState(e)).not.toBe(hashState(a));
  });

  it('golden after 1000 no-input tics', () => {
    expect(runHeadless(freshState(), 1000)).toBe(GOLDEN_IDLE_1000);
  });
});

describe('determinism (M2-06 acceptance)', () => {
  it('same seed + identical 1000-tic input script ⇒ identical hash', () => {
    const plan: Partial<GameInput>[] = [];
    for (let i = 0; i < 1000; i++) {
      plan.push(
        i % 97 < 40
          ? { forward: true, turnRight: i % 7 === 0 }
          : i % 13 === 0
            ? { strafe: true, turnLeft: true, speed: true }
            : {}
      );
    }
    const h1 = runHeadless(freshState(), 1000, script(plan));
    const h2 = runHeadless(freshState(), 1000, script(plan));
    expect(h1).toBe(h2);
    expect(h1).toBe(GOLDEN_SCRIPT_1000);
  });

  it('different input ⇒ different hash (hash actually observes the run)', () => {
    const left = runHeadless(freshState(), 1000, script([{ turnLeft: true }]));
    const right = runHeadless(freshState(), 1000, script([{ turnRight: true }]));
    const idle = runHeadless(freshState(), 1000);
    expect(new Set([left, right, idle]).size).toBe(3);
    expect(left).toBe(GOLDEN_TURNLEFT_1000);
  });

  it('runHeadless composes: first 600 then 400 == straight 1000', () => {
    const s = freshState();
    runHeadless(s, 600);
    const mid = hashState(s);
    const rest = runHeadless(s, 400);
    expect(rest).toBe(GOLDEN_IDLE_1000);
    expect(mid).not.toBe(GOLDEN_IDLE_1000);
  });
});

/* ------------------------------------------------------------------ */
/* M9-03 — gameaction drain + gamestate routing + deferred-init        */
/* plumbing (plan §M9-03 acceptance 1-5). FIXMAP fixture; the flow     */
/* registry is module-global (M8 self-import idiom), so every test     */
/* resets it + the recorders.                                          */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe('M9-03 game flow', () => {
  beforeEach(() => {
    resetGameFlow();
    resetGameactionLog();
    resetSfxStubLog();
  });
  afterEach(() => resetGameFlow());

  // Acceptance 1: gDeferedInitNew(2,1,1) from GS_DEMOSCREEN drains to a
  // REAL LEVEL LOAD in ONE gTicker call — while-loop semantics
  // (ga_newgame → G_DoNewGame → G_InitNew → ga_loadlevel continuation →
  // G_DoLoadLevel → P_SetupLevel) on the SAME GameState identity.
  it('acceptance 1: deferred init drains to a level load in one gTicker', () => {
    const s = freshState();
    const identity = s;
    s.gamestate = GS.DEMOSCREEN;
    s.wipegamestate = GS.DEMOSCREEN;
    let loaded: { ep: number; map: number } | null = null;
    registerGameFlowHooks({
      levelLoader: (_st, ep, map) => {
        loaded = { ep, map };
        return fixMap('FIXMAP');
      }
    });

    gDeferedInitNew(s, 2, 1, 1);
    expect(s.gameaction).toBe(GA.newgame);

    gTicker(s); // ONE call

    expect(loaded).toEqual({ ep: 1, map: 1 });
    expect(identity).toBe(s); // in-place reload, identity preserved
    expect(s.gamestate).toBe(GS.LEVEL);
    expect(s.gameaction).toBe(GA.nothing);
    expect(s.leveltime).toBe(1); // the loaded level is LIVE-ticked this tic
    expect(s.gametic).toBe(1);
    expect(s.players[0]!.playerstate).toBe(PST_LIVE); // spawned via PST_REBORN (§0.4)
    expect(s.players[0]!.mo.x).toBe(128 << 16); // the fixture start
    expect(s.gameepisode).toBe(1);
    expect(s.gamemap).toBe(1);
    expect(s.gameskill).toBe(2);
    expect(s.usergame).toBe(true);
    expect(s.viewactive).toBe(true);
    expect(s.paused).toBe(false);
    // Drain legs (hooks.gameactionLog): the NEWGAME leg — G_InitNew
    // calls G_DoLoadLevel DIRECTLY (g_game.c:1457), not via a second
    // gameaction value, and the whole chain lands inside this one
    // while-loop pass.
    expect(gameactionLog.entries.map((e) => e.action)).toEqual([GA.newgame]);
  });

});

// Acceptance 2: ZERO re-bless. Fresh gInitGame E1M1, 2000 no-input
// tics — byte-equals the value captured from main (pre-M9-03) code:
// the flow fields are off-hash and the GS_LEVEL body + boot sequence
// moved unchanged into gSetupLevel/gLevelTicker.
describe.skipIf(!hasWad)('M9-03 acceptance 2 — E1M1 hash stability', () => {
  it('E1M1 2000-tic hash byte-equals the M8 golden (zero re-bless)', () => {
    const bytes = readFileSync(WAD_PATH);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const mk = () => gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
    const h1 = runHeadless(mk(), 2000);
    const h2 = runHeadless(mk(), 2000);
    expect(h1).toBe(h2);
    // Captured 2026-09 from this implementation (freedoom1.wad pinned
    // release, scripts/freedoom) on main BEFORE the M9-03 plumbing —
    // deliberately NOT recorded from the new code: equality here IS the
    // no-re-bless regression proof (the FIXMAP 1000-tic goldens above
    // cover the boot refactor in-suite too).
    expect(h1).toBe(47732065);
  });
});

describe('M9-03 game flow (drain/routing detail)', () => {
  beforeEach(() => {
    resetGameFlow();
    resetGameactionLog();
    resetSfxStubLog();
  });
  afterEach(() => resetGameFlow());

  // Acceptance 3: gameaction NEVER survives a completed gTicker — for
  // every exported setter AND every d_event.h value, registered or not.
  it('acceptance 3: no gameaction survives a completed gTicker', () => {
    const boot = () => {
      resetGameFlow();
      registerGameFlowHooks({ levelLoader: () => fixMap('FIXMAP') });
      return freshState();
    };
    let s = boot();
    gDeferedInitNew(s, 3, 1, 1);
    gTicker(s);
    expect(s.gameaction).toBe(GA.nothing);

    s = boot();
    gExitLevel(s);
    expect(s.specialexit).toBe(false); // g_game.c:1004 (secretexit=false)
    gTicker(s);
    expect(s.gameaction).toBe(GA.nothing);
    expect(flowStubHits.byName.get('ga_completed')).toBe(1); // unregistered ⇒ counted stub

    s = boot();
    gSecretExitLevel(s);
    expect(s.specialexit).toBe(true);
    gTicker(s);
    expect(s.gameaction).toBe(GA.nothing);

    s = boot();
    gWorldDone(s); // built-in case: gamestate=GS_LEVEL, load (no next-routing yet)
    gTicker(s);
    expect(s.gameaction).toBe(GA.nothing);

    // Every remaining d_event.h value drains to nothing (counted stubs
    // for the §4 M11/M12 actions + ga_victory pre-M9-10).
    s = boot();
    for (const action of [GA.victory, GA.loadgame, GA.savegame, GA.playdemo, GA.screenshot]) {
      s.gameaction = action;
      gTicker(s);
      expect(s.gameaction, `ga_${action}`).toBe(GA.nothing);
    }
    expect(flowStubHits.byName.get('ga_victory')).toBe(1);
  });

  // Guard-counter idiom (mirrors M8's unimplementedSpecial): a
  // pathological handler that RE-ARMS gameaction forever is cut after
  // the bounded drain, counted, never a frozen headless run.
  it('drain guard cuts a re-arming handler (no infinite while)', () => {
    const s = freshState();
    registerGameFlowHooks({ doCompleted: (st) => { st.gameaction = GA.completed; } });
    s.gameaction = GA.completed;
    gTicker(s);
    expect(s.gameaction).toBe(GA.nothing);
    expect(flowStubHits.byName.get('gameaction-loop')).toBe(1);
    // 16 iterations max + the forced cut (17 records: 16 + the guard tic
    // sees the re-armed action once more before the break).
    expect(gameactionLog.count).toBeLessThanOrEqual(17);
  });

  // Acceptance 4 (through the real path): clamps observable after one
  // drain — gDeferedInitNew(6,5,12) ⇒ gameskill 5 / ep 1 / map 9.
  it('acceptance 4: G_InitNew clamps run on the deferred-init path', () => {
    const s = freshState();
    s.gamestate = GS.DEMOSCREEN;
    registerGameFlowHooks({ levelLoader: () => fixMap('FIXMAP') });
    gDeferedInitNew(s, 6, 5, 12);
    gTicker(s);
    expect(s.gameskill).toBe(5); // 6 → sk_nightmare (1-based domain)
    expect(s.skill).toBe(4); // internal 0-based nightmare
    expect(s.gameepisode).toBe(1); // shareware clamp (GAME_MODE)
    expect(s.gamemap).toBe(9); // 12 → 9
    expect(s.gamestate).toBe(GS.LEVEL);
  });

  // Acceptance 5: the wipe sentinel is consumed EXACTLY ONCE per state
  // change (d_main.c:196-222) — including the g_game.c:451 reload force.
  it('acceptance 5: wipe sentinel consumed once per change', () => {
    const s = freshState();
    expect(s.wipegamestate).toBe(s.gamestate);
    expect(takeWipeRequest(s)).toBe(false); // no change ⇒ no wipe

    s.gamestate = GS.FINALE;
    expect(takeWipeRequest(s)).toBe(true); // consuming read
    expect(takeWipeRequest(s)).toBe(false); // same state ⇒ stays false
    expect(s.wipegamestate).toBe(GS.FINALE);

    s.gamestate = GS.DEMOSCREEN; // menu opens on the title
    expect(takeWipeRequest(s)).toBe(true);
    expect(takeWipeRequest(s)).toBe(false);

    // DEMOSCREEN → LEVEL transition: sentinel differs ⇒ exactly one
    // consumption (no -1 force here: g_game.c:451 forces the melt only
    // for a LEVEL→LEVEL reload, wipegamestate === GS_LEVEL).
    registerGameFlowHooks({ levelLoader: () => fixMap('FIXMAP') });
    gDeferedInitNew(s, 3, 1, 1);
    gTicker(s); // → GS_LEVEL
    expect(s.gamestate).toBe(GS.LEVEL);
    expect(takeWipeRequest(s)).toBe(true);
    expect(takeWipeRequest(s)).toBe(false);

    // The g_game.c:451 force: a same-state (GS_LEVEL) reload arms the
    // sentinel with -1 and the display block consumes it once.
    const lv = freshState();
    expect(lv.wipegamestate).toBe(GS.LEVEL);
    gDeferedInitNew(lv, 3, 1, 1);
    gTicker(lv);
    expect(lv.wipegamestate).toBe(-1); // armed by G_DoLoadLevel, unconsumed
    expect(takeWipeRequest(lv)).toBe(true);
    expect(lv.wipegamestate).toBe(GS.LEVEL);
    expect(takeWipeRequest(lv)).toBe(false);
  });

  it('per-state ticker routing via registrable hooks (§0.2)', () => {
    const s = freshState();
    // Unregistered GS_INTERMISSION: counted stub, clocks tick, no crash,
    // the level body does NOT run (leveltime frozen).
    s.gamestate = GS.INTERMISSION;
    gTicker(s);
    expect(flowStubHits.byName.get('wiTicker')).toBe(1);
    expect(s.leveltime).toBe(0);
    expect(s.gametic).toBe(1);

    let ticced = 0;
    registerGameFlowHooks({ wiTicker: () => { ticced++; } });
    gTicker(s);
    gTicker(s);
    expect(ticced).toBe(2);
    expect(s.leveltime).toBe(0); // still no P_Ticker while off GS_LEVEL
    expect(s.gameaction).toBe(GA.nothing);

    // GS_FINALE / GS_DEMOSCREEN route to their own hooks; the GS_LEVEL
    // body resumes (and ONLY resumes) on GS_LEVEL.
    s.gamestate = GS.FINALE;
    gTicker(s);
    expect(flowStubHits.byName.get('finaleTicker')).toBe(1);
    s.gamestate = GS.DEMOSCREEN;
    let paged = 0;
    registerGameFlowHooks({ pageTicker: () => { paged++; } });
    gTicker(s);
    expect(paged).toBe(1);
    s.gamestate = GS.LEVEL;
    gTicker(s);
    expect(s.leveltime).toBe(1);
  });

  it('tic block: advancedemo flag + M_Ticker slot (d_main.c:381-383)', () => {
    const s = freshState();
    // Unregistered attract consumer: flag consumed + counted (no spin).
    gRequestAdvanceDemo(s);
    expect(s.advancedemo).toBe(true);
    gFlowTic(s);
    expect(s.advancedemo).toBe(false);
    expect(flowStubHits.byName.get('advanceDemo')).toBe(1);

    let skulled = 0;
    let demoed = 0;
    registerGameFlowHooks({
      advanceDemo: () => { demoed++; },
      mTicker: () => { skulled++; }
    });
    gRequestAdvanceDemo(s);
    gFlowTic(s);
    gFlowTic(s);
    expect(demoed).toBe(1); // the flag, not every tic
    expect(skulled).toBe(2); // M_Ticker runs every tic
  });

  it('hooks.ts additive seams: sfxStub counter + gameactionLog', () => {
    sfxStub('sfx_swtchn');
    sfxStub('sfx_swtchn');
    sfxStub('sfx_pistol');
    expect(sfxStubLog.count).toBe(3);
    expect(sfxStubLog.byName.get('sfx_swtchn')).toBe(2);
    expect(sfxStubLog.byName.get('sfx_pistol')).toBe(1);
    resetSfxStubLog();
    expect(sfxStubLog.count).toBe(0);

    const s = freshState();
    registerGameFlowHooks({ levelLoader: () => fixMap('FIXMAP') });
    gDeferedInitNew(s, 3, 1, 1);
    gTicker(s);
    expect(gameactionLog.count).toBe(1); // ga_newgame (loadlevel leg is a direct call)
    expect(gameactionLog.entries[0]!.action).toBe(GA.newgame);
    expect(gameactionLog.entries[0]!.gametic).toBe(0);
  });

  it('booted-state flow fields default to a live level (no behavior move)', () => {
    const s = freshState();
    expect(s.gamestate).toBe(GS.LEVEL);
    expect(s.gameaction).toBe(GA.nothing);
    expect(s.paused).toBe(false);
    expect(s.viewactive).toBe(true);
    expect(s.usergame).toBe(true);
    expect(s.advancedemo).toBe(false);
    expect(s.wipegamestate).toBe(GS.LEVEL);
    expect(s.wminfo.type).toBe('sp');
    expect(s.wminfo.pars).toEqual([30, 75, 120, 90, 165, 180, 180, 30, 165]);
    expect(s.gameskill).toBe(3); // boot skill 2 (0-based) ⇒ 3 (1-based domain)
  });
});
