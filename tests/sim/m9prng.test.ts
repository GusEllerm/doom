/**
 * M9-13 — PRNG FINAL RECONCILIATION (plan §M9-13 task 1 / §0.8-0.9 ledger
 * rules; M9-plan.md is AUTHORITATIVE: "PRNG final reconciliation
 * (`st_face` M_Random + WI streams included — the ST_Ticker draw shifts ALL
 * menu-stream numbers: WI anim timing asserts in M9-07 use the LIVE stream,
 * not a fresh one)").
 *
 * Two halves:
 *  1. FULL-SCOPE MANIFEST — a recursive scan of the WHOLE src/ tree for
 *     `mRandom(` call occurrences (every subtree: sim, ui, render, input,
 *     root files), asserted EQUAL to MRANDOM_SITE_CALLS_ALL in both
 *     directions: the `st_face` draw (ui/statusbar.ts, st_stuff.c:965) and
 *     the WI stream draws (sim/wintermission.ts, wi_stuff.c:517/:521/:560)
 *     are IN. The same full-scope idiom pins `pRandom`: the sim-tree ledger
 *     remapped to src-relative keys must match the recursive scan, so a
 *     P_Random draw outside src/sim can only exist if ledgered.
 *  2. LIVE-STREAM TIMING — the M9-07 callout: a session driven EXACTLY like
 *     the production loop (gTicker + the GS_LEVEL stTicker half of
 *     main.ts:377-381) enters the intermission with a MENU stream already
 *     advanced by `st_face` (1 draw/GS_LEVEL tic — st_stuff.c:965, the
 *     unconditional draw the plan §0.9 warned "changes every downstream WI
 *     animation draw"). Asserted on that LIVE stream: the +10-per-state-
 *     entry WI_initAnimatedBack counts, the anim-offset ranges (1..12), the
 *     stream silence across the tally/ShowNextLoc loops (no ANIM_RANDOM
 *     member in epsd0), and the stream ledger arithmetic
 *     (level tics + 2 entries = total draws).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';
import { buildMapFromData } from '../../src/sim/map';
import {
  gExitLevel,
  gInitGame,
  gTicker,
  GS,
  registerGameFlowHooks,
  resetGameFlow
} from '../../src/sim/game';
import { resetGameactionLog, resetSfxStubLog } from '../../src/sim/hooks';
import type { GameState } from '../../src/sim/state';
import { emptyInput } from '../../src/sim/ticcmd';
import {
  MRANDOM_SITE_CALLS,
  MRANDOM_SITE_CALLS_ALL,
  RANDOM_SITE_CALLS,
  scanCallTree,
  scanMRandomSites,
  scanRandomSites
} from '../../src/sim/random-sites';
import {
  gDoCompleted,
  wiPeek,
  wiResetPlayerFlags,
  wiTicker
} from '../../src/sim/wintermission';
import { stResetAll, stStats, stTicker, type StContext, type StPlayerView } from '../../src/ui/statusbar';

const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 200 },
    { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 }
  ],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
};

function fixMap(name = 'E1M1'): ReturnType<typeof buildMapFromData> {
  const bytes = buildFixtureMapWad(SPEC, name);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), name));
}

function armHooks(): void {
  registerGameFlowHooks({
    levelLoader: (_s, episode, map) => fixMap(`E${episode}M${map}`),
    wiTicker,
    doCompleted: gDoCompleted
  });
}

beforeEach(() => {
  resetGameFlow();
  resetSfxStubLog();
  resetGameactionLog();
  wiResetPlayerFlags();
  stResetAll(); // statusbar.ts module statics (stTicker is module-global C code)
  armHooks();
});

/* ------------------------------------------------------------------ */
/* 1. Full-scope manifest (every src subtree, both streams)            */
/* ------------------------------------------------------------------ */

describe('M9-13 PRNG manifest — full scope, both directions', () => {
  it('mRandom: recursive whole-src scan == MRANDOM_SITE_CALLS_ALL (st_face + wi streams IN)', () => {
    // Whole tree: an mRandom( occurrence ANYWHERE in src (outside prng.ts)
    // must be ledgered; a stale entry fails the same test.
    expect(scanCallTree('mRandom')).toEqual({ ...MRANDOM_SITE_CALLS_ALL });
    // The two named M9 additions are present with their exact counts:
    expect(MRANDOM_SITE_CALLS_ALL['ui/statusbar.ts']).toBe(1); // st_face
    expect(MRANDOM_SITE_CALLS_ALL['sim/wintermission.ts']).toBe(3); // wi_anim
    // Cross-consistency with the per-tree manifest the M9-05/M9-07 tests
    // compare against (same draws, file-name keys).
    expect(scanMRandomSites()).toEqual({ ...MRANDOM_SITE_CALLS });
    const flat = (m: Record<string, number>): number =>
      Object.values(m).reduce((a, v) => a + v, 0);
    expect(flat(scanCallTree('mRandom'))).toBe(flat({ ...MRANDOM_SITE_CALLS }));
  });

  it('pRandom: recursive whole-src scan == sim ledger remapped (no draws outside sim)', () => {
    const simMapped: Record<string, number> = {};
    for (const [file, n] of Object.entries(RANDOM_SITE_CALLS)) simMapped[`sim/${file}`] = n;
    expect(scanCallTree('pRandom')).toEqual(simMapped);
    // …and the M7-era per-directory ledger stays byte-equal (mirror 62-.c
    // rule: the ledger describes the CALL SITES, the scan is the audit).
    expect(scanRandomSites()).toEqual({ ...RANDOM_SITE_CALLS });
  });
});

/* ------------------------------------------------------------------ */
/* 2. LIVE-stream WI timing (M9-07 callout fix, plan §M9-13)           */
/* ------------------------------------------------------------------ */

// < 256 so the rndindex arithmetic below never wraps the 256-entry rndtable
// (mRandom advances `rndindex = (rndindex + 1) & 255`).
const LEVEL_TICS = 120;

describe('M9-13 LIVE-stream intermission (st_face-advanced menu stream)', () => {
  it('st_face counts 1/tic on GS_LEVEL tics; WI entries draw +10/+10 ON TOP of the live base', () => {
    const st: GameState = gInitGame(fixMap('E1M1'));
    // gInitGame runs M_ClearRandom (g_game.c:1414) — both streams zeroed.
    expect(st.rng.rndindex).toBe(0);

    // Production tic shape (main.ts:367-381): gTicker, THEN the GS_LEVEL
    // stTicker half — the st_face draw the WI asserts must live with.
    const ctx: StContext = {
      rng: st.rng,
      player: st.players[0] as unknown as StPlayerView,
    };
    for (let t = 0; t < LEVEL_TICS; t += 1) {
      gTicker(st, emptyInput());
      if (st.gamestate === GS.LEVEL) stTicker(ctx);
    }
    expect(st.gamestate).toBe(GS.LEVEL);
    expect(st.rng.rndindex).toBe(LEVEL_TICS); // EXACTLY one draw/tic
    expect(stStats.tickerCalls).toBe(LEVEL_TICS);

    // Exit on the LIVE stream (freshState-zeroed tests could not show this).
    const p = st.players[0]!;
    st.mobjs.totalkills = 20;
    st.mobjs.totalitems = 10;
    st.totalsecret = 1;
    p.killcount = 10;
    p.itemcount = 3;
    gExitLevel(st);
    gTicker(st, emptyInput()); // ga_completed drain: WI_Start entry 1
    expect(st.gamestate).toBe(GS.INTERMISSION);
    expect(st.rng.rndindex).toBe(LEVEL_TICS + 10); // +10, NOT ==10

    // Anim offsets: LIVE-stream positions still honour the 1..12 window
    // (nexttic = bcnt+1 + M_Random()%11, wi_stuff.c:517 — range-invariant).
    const offs = wiPeek().anim.map((r) => r.nexttic);
    expect(offs.length).toBe(10); // NUMANIMS[0] = 10 (wi_stuff.c:292)
    expect(Math.min(...offs)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...offs)).toBeLessThanOrEqual(12);

    // Tally loop draws NOTHING (ANIM_RANDOM membership empty for epsd0):
    const base = st.rng.rndindex;
    for (let t = 0; t < 60; t += 1) gTicker(st, emptyInput());
    expect(st.rng.rndindex).toBe(base);

    // Fast-forward ⇒ ShowNextLoc entry 2: +10 more, then silence again.
    gTicker(st, { ...emptyInput(), attack: true });
    gTicker(st, emptyInput());
    gTicker(st, { ...emptyInput(), attack: true });
    expect(st.rng.rndindex).toBe(LEVEL_TICS + 20);
    for (let t = 0; t < 220; t += 1) gTicker(st, emptyInput()); // → NoState → worlddone
    expect(st.gamestate).toBe(GS.LEVEL);
    expect(st.gamemap).toBe(2);
    expect(st.rng.rndindex).toBe(LEVEL_TICS + 20); // DoWorldDone path draws 0

    // Back on the live bar: st_face arithmetic resumes from the LIVE base.
    for (let t = 0; t < 50; t += 1) {
      gTicker(st, emptyInput());
      if (st.gamestate === GS.LEVEL) stTicker(ctx);
    }
    expect(st.rng.rndindex).toBe(LEVEL_TICS + 20 + 50);
  });

  it('stream-position invariance: identical TIMELINE on a fresh vs live-advanced stream', () => {
    // The WI counter machine consumes NO randomness — so the sp_state
    // timeline is stream-independent by construction; this pins it so no
    // future edit can bake fresh-stream timing (the §M9-13 callout).
    const play = (liveShift: number): string => {
      resetGameFlow();
      wiResetPlayerFlags();
      resetSfxStubLog();
      armHooks();
      const st: GameState = gInitGame(fixMap('E1M1'));
      const ctx: StContext = { rng: st.rng, player: st.players[0] as unknown as StPlayerView };
      for (let t = 0; t < liveShift; t += 1) {
        gTicker(st, emptyInput());
        if (st.gamestate === GS.LEVEL) stTicker(ctx);
      }
      const p = st.players[0]!;
      st.mobjs.totalkills = 20;
      st.mobjs.totalitems = 10;
      st.totalsecret = 1;
      p.killcount = 10;
      p.itemcount = 3;
      st.leveltime = 175;
      gExitLevel(st);
      const trace: string[] = [];
      for (let t = 0; t < 500 && st.gamestate === GS.INTERMISSION; t += 1) {
        gTicker(st, emptyInput());
        const w = wiPeek();
        trace.push(`${w.spState}|${w.cntKills}|${w.cntItems}|${w.cntSecret}|${w.cntTime}|${w.cntPar}`);
      }
      return trace.join('\n');
    };
    const fresh = play(0);
    const live = play(211); // an odd shift NO base-0 assertion could fake
    expect(live).toBe(fresh);
  });
});
