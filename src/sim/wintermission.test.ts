/**
 * sim/wintermission tests — M9-07 (plan §M9-07 acceptance).
 *  1) math table: integer-division percents incl. the 0/0 divide-guard
 *     (maxkills/items/secret clamp to 1 — WI_initVariables :1826-1833)
 *     across kill/item/secret combos + the exact sp_state timeline
 *     (golden hash of the counter SoA),
 *  2) accelerate: attack edge ⇒ all counters final + sfx_barexp ×1,
 *     second edge ⇒ sfx_sgcock ×1 ⇒ ShowNextLoc,
 *  3) routing: E1M8 exit never reaches WI (ga_victory pin, §0.3),
 *     E1M9 ⇒ next=3 (E1M4) with the didsecret flag, secret exit
 *     E1M1 ⇒ next=8, worlddone handoff consumed ONCE,
 *  4) animation timing determinism: menu-stream mRandom draws replay
 *     identically (episode 0 = 10 draws per state entry),
 *  5) double-run: two identical sessions ⇒ identical traces.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData } from './map';
import {
  flowStubHits,
  GA,
  gExitLevel,
  gInitGame,
  gSecretExitLevel,
  gTicker,
  GS,
  registerGameFlowHooks,
  resetGameFlow,
  takeWipeRequest
} from './game';
import { gameactionLog, resetGameactionLog, resetSfxStubLog, sfxStubLog } from './hooks';
import { hashState, type GameState } from './state';
import { emptyInput, type GameInput } from './ticcmd';
import { mClearRandom } from './prng';
import { MRANDOM_SITE_CALLS, RANDOM_SITE_CALLS, scanMRandomSites, scanRandomSites } from './random-sites';
import {
  gDoCompleted,
  wiDrawSnapshot,
  wiPeek,
  wiResponder,
  wiResetPlayerFlags,
  wiTicker,
  type WiDrawSnapshot
} from './wintermission';

const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 200 },
    { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 }
  ],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
};

function fixMap(name = 'FIXMAP') {
  const bytes = buildFixtureMapWad(SPEC, name);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), name));
}

function freshState(name = 'E1M1'): GameState {
  return gInitGame(fixMap(name));
}

/** Run n tics (gamestate must already be GS_INTERMISSION). */
function runTics(st: GameState, n: number, plan?: (i: number) => GameInput): void {
  for (let i = 0; i < n; i++) gTicker(st, plan?.(i) ?? emptyInput());
}

function traceHash(trace: readonly WiDrawSnapshot[]): string {
  const h = createHash('sha256');
  for (const s of trace) {
    h.update(
      `${s.phase}|${s.spState}|${s.cntKills}|${s.cntItems}|${s.cntSecret}|` +
        `${s.cntTime}|${s.cntPar}|${s.snlPointerOn ? 1 : 0}|${s.anims.map((a) => a.ctr).join(',')}|`
    );
  }
  return h.digest('hex').slice(0, 16);
}

/** Stage the census the way P_SetupLevel would, exit, drain one tic
 * (that tic is ALSO the WI's tic 1 — gTicker drains BEFORE routing, so
 * bcnt==1 fires inside this call). */
function enterIntermission(
  st: GameState,
  tally: { kills?: number; items?: number; secrets?: number; leveltime?: number },
  secret = false
): void {
  const p = st.players[0]!;
  st.mobjs.totalkills = 100;
  st.mobjs.totalitems = 100;
  st.totalsecret = 1;
  p.killcount = tally.kills ?? 0;
  p.itemcount = tally.items ?? 0;
  st.secretcount = tally.secrets ?? 0;
  if (tally.leveltime !== undefined) st.leveltime = tally.leveltime;
  if (secret) gSecretExitLevel(st);
  else gExitLevel(st);
  gTicker(st, emptyInput());
}

function armHooks(): void {
  // resetGameFlow() wipes the module-load registration (game.ts test
  // seam), so the production registration is re-armed here identically.
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
  armHooks();
});

describe('WI_Start + hook seam', () => {
  it('exit drains into GS_INTERMISSION via the registered hooks (no stubs)', () => {
    const st = freshState();
    gExitLevel(st);
    gTicker(st, emptyInput());
    expect(st.gamestate).toBe(GS.INTERMISSION);
    expect(st.viewactive).toBe(false);
    expect(flowStubHits.byName.get('ga_completed') ?? 0).toBe(0);
    expect(wiResponder()).toBe(false); // WI_Responder no-op
    expect(st.wipegamestate).not.toBe(st.gamestate); // sentinel armed
    expect(takeWipeRequest(st)).toBe(true);
    expect(takeWipeRequest(st)).toBe(false); // consumed ONCE
  });

  it('E1M8 exit does NOT reach WI (ga_victory pin, §0.3)', () => {
    const st = freshState('E1M8');
    const bcntBefore = wiPeek().bcnt;
    gExitLevel(st);
    gTicker(st, emptyInput());
    expect(st.gamestate).toBe(GS.LEVEL); // victory diverts before wminfo
    expect(wiPeek().bcnt).toBe(bcntBefore); // NO tic ever reached WI
    expect(flowStubHits.byName.get('ga_victory') ?? 0).toBe(1);
    expect(st.wminfo.last).toBe(0); // carrier untouched
  });

  it('E1M9 exit routes next=3 (E1M4) and arms the didsecret flag', () => {
    const st = freshState('E1M9');
    gExitLevel(st);
    gTicker(st, emptyInput());
    expect(st.gamestate).toBe(GS.INTERMISSION);
    expect(st.wminfo.next).toBe(3);
    expect(st.wminfo.last).toBe(8);
    expect(wiDrawSnapshot().didsecret).toBe(true);
  });

  it('secret exit E1M1 routes next=8, didsecret FALSE during the tally', () => {
    const st = freshState('E1M1');
    enterIntermission(st, { kills: 0, leveltime: 0 }, true);
    expect(st.gamestate).toBe(GS.INTERMISSION);
    expect(st.wminfo.next).toBe(8);
    expect(wiDrawSnapshot().didsecret).toBe(false); // set at WorldDone only
  });

  it('par time: E1 row × 35 (g_game.c pars table, §0.3)', () => {
    const st = freshState('E1M3');
    gExitLevel(st);
    gTicker(st, emptyInput());
    expect(st.wminfo.partime).toBe(35 * 120);
  });

  it('G_PlayerFinishLevel clears cards/powers/counts (g_game.c:779)', () => {
    const st = freshState();
    const p = st.players[0]!;
    (p.cards as Int32Array).fill(1);
    p.damagecount = 9;
    p.bonuscount = 7;
    p.mo.flags |= 0x40000; // MF_SHADOW
    gExitLevel(st);
    gTicker(st, emptyInput());
    expect(Array.from(p.cards as Int32Array).every((c) => c === 0)).toBe(true);
    expect(p.damagecount).toBe(0);
    expect(p.bonuscount).toBe(0);
    expect(p.mo.flags & 0x40000).toBe(0);
  });
});

describe('percent math table (§0.9 integer division + 0/0 guard)', () => {
  interface Row {
    name: string;
    kills: number; maxkills: number;
    items: number; maxitems: number;
    secrets: number; maxsecret: number;
    wantKills: number; wantItems: number; wantSecret: number;
  }
  // Hand-derived floor(count*100/max) with the max clamp (>=1):
  const rows: Row[] = [
    { name: '50/33/0', kills: 50, maxkills: 100, items: 33, maxitems: 100, secrets: 0, maxsecret: 10, wantKills: 50, wantItems: 33, wantSecret: 0 },
    { name: '2/3 trunc', kills: 2, maxkills: 3, items: 1, maxitems: 3, secrets: 1, maxsecret: 3, wantKills: 66, wantItems: 33, wantSecret: 33 },
    { name: '0/0 divide guard', kills: 0, maxkills: 0, items: 0, maxitems: 0, secrets: 0, maxsecret: 0, wantKills: 0, wantItems: 0, wantSecret: 0 },
    { name: '99/66/50', kills: 99, maxkills: 100, items: 67, maxitems: 101, secrets: 1, maxsecret: 2, wantKills: 99, wantItems: 66, wantSecret: 50 },
    { name: 'all 100', kills: 7, maxkills: 7, items: 5, maxitems: 5, secrets: 3, maxsecret: 3, wantKills: 100, wantItems: 100, wantSecret: 100 },
    // kills>0 with maxkills==0: vanilla clamps the DENOMINATOR to 1, the
    // percent legitimately exceeds 100 (never happens with a live census;
    // this is the guard's observable contract).
    { name: 'guard over-100', kills: 3, maxkills: 0, items: 0, maxitems: 4, secrets: 0, maxsecret: 9, wantKills: 300, wantItems: 0, wantSecret: 0 },
    { name: '1/1001 floor', kills: 1, maxkills: 1001, items: 3, maxitems: 7, secrets: 0, maxsecret: 1, wantKills: 0, wantItems: 42, wantSecret: 0 }
  ];

  for (const r of rows) {
    it(`${r.name}: fast-forward finals == hand table`, () => {
      const st = freshState();
      const p = st.players[0]!;
      st.mobjs.totalkills = r.maxkills;
      st.mobjs.totalitems = r.maxitems;
      st.totalsecret = r.maxsecret;
      p.killcount = r.kills;
      p.itemcount = r.items;
      st.secretcount = r.secrets;
      gExitLevel(st);
      gTicker(st, emptyInput());
      gTicker(st, { ...emptyInput(), attack: true }); // FF edge
      const snap = wiDrawSnapshot();
      expect(snap.cntKills, r.name).toBe(r.wantKills);
      expect(snap.cntItems, r.name).toBe(r.wantItems);
      expect(snap.cntSecret, r.name).toBe(r.wantSecret);
      expect(snap.spState).toBe(10);
      expect(sfxStubLog.byName.get('sfx_barexp')).toBe(1); // exactly one
    });
  }

  it('maxkills/items/secret clamp in place (vanilla wbs semantics)', () => {
    const st = freshState();
    st.mobjs.totalkills = 0;
    gExitLevel(st);
    gTicker(st, emptyInput());
    expect(st.wminfo.maxkills).toBe(1);
    expect(st.wminfo.maxitems).toBe(1);
    expect(st.wminfo.maxsecret).toBe(1);
  });
});

describe('sp_state timeline (cnt_pause=35, kills/items +=2, time/par +=3)', () => {
  // Derived tic boundaries for kills=50/100 (26 count tics), items=33/100
  // (17), secrets=0 (1), leveltime=105 (time target 3 → 2 tics), par
  // E1M1=30 min (target 30 → 11 tics gate the end of state 8):
  //  1: 35 | 2: +26 | 3: 35 | 4: +17 | 5: 35 | 6: +1 | 7: 35 | 8: +11 | 9: 35
  // WI tic 1 is enterIntermission's own gTicker (drain precedes routing),
  // so the LOOP-tic boundaries below are one less than the WI tic numbers
  // (35, 61, 96, 113, 148, 149, 184, 195, 230).
  const BOUNDS = [34, 60, 95, 112, 147, 148, 183, 194, 229];

  it('50/33/0% at known counters: exact boundaries + counter-SoA golden', () => {
    const st = freshState();
    enterIntermission(st, { kills: 50, items: 33, secrets: 0, leveltime: 3 * 35 });
    const trace: WiDrawSnapshot[] = [];
    const bounds: number[] = [];
    let prev = wiDrawSnapshot();
    for (let i = 0; i < 500; i++) {
      gTicker(st, emptyInput());
      const s = wiDrawSnapshot();
      trace.push(s);
      if (s.spState !== prev.spState || s.phase !== prev.phase) bounds.push(i + 1);
      prev = s;
      if (s.spState === 10) break; // waits for input from here
    }
    expect(bounds).toEqual(BOUNDS);
    expect(trace.length).toBe(229);
    // golden of the counter SoA (plan acceptance 1)
    expect(traceHash(trace)).toBe(GOLDEN_TIMELINE_HASH);
  });

  it('sfx dots: sfx_pistol on !(bcnt&3) while counting; barexp ×4; music ×1', () => {
    const st = freshState();
    enterIntermission(st, { kills: 50, items: 33, secrets: 0, leveltime: 3 * 35 });
    runTics(st, 195); // through the time stage's barexp
    expect(sfxStubLog.byName.get('sfx_barexp')).toBe(4);
    // bcnt == tic number: state2 36..61 → 36,40,..,60 = 7;
    // state4 97..113 → 100,104,108,112 = 4; state6 149 → 0;
    // state8 185..195 → 188,192 = 2
    expect(sfxStubLog.byName.get('sfx_pistol')).toBe(7 + 4 + 0 + 2);
    expect(sfxStubLog.byName.get('mus_inter')).toBe(1); // bcnt==1, once
  });
});

describe('accelerate (WI_checkForAccelerate :1470)', () => {
  it('edge #1 in state 2 ⇒ finals + barexp ×1; hold never re-edges; edge #2 ⇒ ShowNextLoc', () => {
    const st = freshState();
    enterIntermission(st, { kills: 50, items: 33, secrets: 1, leveltime: 3 * 35 });
    runTics(st, 39); // mid state 2
    gTicker(st, { ...emptyInput(), attack: true }); // edge #1
    const s = wiDrawSnapshot();
    expect(s.spState).toBe(10);
    expect(s.cntKills).toBe(50);
    expect(s.cntItems).toBe(33);
    expect(s.cntSecret).toBe(100);
    expect(s.cntTime).toBe(3);
    expect(s.cntPar).toBe(30);
    expect(sfxStubLog.byName.get('sfx_barexp')).toBe(1); // exactly one
    gTicker(st, { ...emptyInput(), attack: true }); // held ⇒ no edge
    expect(wiDrawSnapshot().phase).toBe('StatCount');
    gTicker(st, emptyInput()); // release
    gTicker(st, { ...emptyInput(), attack: true }); // edge #2
    expect(sfxStubLog.byName.get('sfx_sgcock')).toBe(1);
    gTicker(st, emptyInput());
    expect(wiDrawSnapshot().phase).toBe('ShowNextLoc');
  });

  it('use button edges once; held across 60 tics never re-edges', () => {
    const st = freshState();
    enterIntermission(st, { kills: 10, leveltime: 35 });
    for (let i = 0; i < 60; i++) gTicker(st, { ...emptyInput(), use: true });
    expect(wiPeek().spState).toBe(10); // edge at the first tic
    expect(wiPeek().accelerateStage).toBe(0);
    expect(wiPeek().phase).toBe('StatCount');
    expect(sfxStubLog.byName.get('sfx_sgcock') === undefined).toBe(true);
  });
});

/** Fast path: FF edge, release, edge again ⇒ ShowNextLoc. */
function toShowNextLoc(st: GameState): void {
  gTicker(st, { ...emptyInput(), attack: true });
  gTicker(st, emptyInput());
  gTicker(st, { ...emptyInput(), attack: true });
  gTicker(st, emptyInput());
  expect(wiDrawSnapshot().phase).toBe('ShowNextLoc');
}

describe('ShowNextLoc → NoState → G_WorldDone (consumed ONCE)', () => {
  it('blink: snl_pointeron = (cnt & 31) < 20', () => {
    const st = freshState();
    enterIntermission(st, { kills: 0, leveltime: 0 });
    toShowNextLoc(st);
    const blinks: boolean[] = [];
    for (let i = 0; i < 138; i++) {
      blinks.push(wiDrawSnapshot().snlPointerOn);
      gTicker(st, emptyInput());
    }
    // Samples: cnt 139 (already landed by toShowNextLoc's 4th tic) then
    // 138..2 after each further update — snl_pointeron = (cnt & 31) < 20.
    const want = Array.from({ length: 138 }, (_, i) => 139 - i).filter(
      (c) => (c & 31) < 20
    ).length;
    expect(blinks.filter((b) => b).length).toBe(want);
    expect(blinks[0]).toBe(true); // (139 & 31) = 15 < 20
    expect(wiPeek().phase).toBe('ShowNextLoc'); // cnt == 1
    gTicker(st, emptyInput()); // lands on 0 ⇒ NoState
    expect(wiPeek().phase).toBe('NoState');
  });

  it('NoState end ⇒ gWorldDone observed exactly once; next map loads', () => {
    const st = freshState();
    enterIntermission(st, { kills: 0, leveltime: 0 });
    toShowNextLoc(st);
    let guard = 0;
    while (wiPeek().active && guard++ < 400) gTicker(st, emptyInput());
    expect(wiPeek().active).toBe(false); // WI_End ran (endCount)
    expect(wiPeek().endCount).toBe(1);
    gTicker(st, emptyInput()); // drain ga_worlddone (logged at drain time)
    expect(gameactionLog.entries.filter((e) => e.action === GA.worlddone).length).toBe(1);
    expect(st.gamestate).toBe(GS.LEVEL);
    expect(st.gamemap).toBe(2); // next=1 ⇒ map 2
    expect(st.viewactive).toBe(true);
    runTics(st, 15);
    // carrier consumed once: never re-fires (NoState cnt went negative —
    // faithful vanilla guard)
    expect(gameactionLog.entries.filter((e) => e.action === GA.worlddone).length).toBe(1);
  });

  it('E1M9 full flow without input burn: tally ⇒ E1M4 live', () => {
    const st = freshState('E1M9');
    enterIntermission(st, { kills: 20, leveltime: 70 });
    expect(wiDrawSnapshot().didsecret).toBe(true);
    let guard = 0;
    while (wiPeek().spState !== 10 && guard++ < 400) gTicker(st, emptyInput());
    expect(guard).toBeLessThan(400);
    // already sp_state 10: ONE edge enters ShowNextLoc (no fast-forward)
    gTicker(st, { ...emptyInput(), attack: true });
    gTicker(st, emptyInput()); // release
    expect(wiDrawSnapshot().phase).toBe('ShowNextLoc');
    runTics(st, 150); // ShowNextLoc 140 + NoState 10
    expect(wiPeek().active).toBe(false);
    gTicker(st, emptyInput());
    expect(st.gamestate).toBe(GS.LEVEL);
    expect(st.gamemap).toBe(4);
    expect(st.map.name).toBe('E1M4');
  });

  it('secret flow: E1M1 --secret--> E1M9 live; didsecret survives to next tally', () => {
    const st = freshState('E1M1');
    enterIntermission(st, { kills: 0, leveltime: 0 }, true);
    expect(wiPeek().next).toBe(8);
    gTicker(st, { ...emptyInput(), use: true }); // FF edge
    gTicker(st, emptyInput()); // release
    gTicker(st, { ...emptyInput(), use: true }); // ⇒ ShowNextLoc
    expect(wiDrawSnapshot().phase).toBe('ShowNextLoc');
    runTics(st, 150);
    gTicker(st, emptyInput());
    expect(st.gamestate).toBe(GS.LEVEL);
    expect(st.gamemap).toBe(9);
    expect(st.map.name).toBe('E1M9');
    expect(wiPeek().didsecretPlayer).toBe(true); // G_WorldDone half
    // and exiting E1M9 shows didsecret=TRUE in the tally (splat on level 8)
    gExitLevel(st);
    gTicker(st, emptyInput());
    expect(wiDrawSnapshot().didsecret).toBe(true);
    expect(st.wminfo.next).toBe(3);
  });
});

describe('animation timing determinism (wi_anim mRandom ledger)', () => {
  it('epsd0: 10 anims with random offsets (bcnt+1 + mRandom%11)', () => {
    const st = freshState();
    mClearRandom(st.rng);
    enterIntermission(st, { kills: 0, leveltime: 0 });
    const snap = wiDrawSnapshot();
    expect(snap.anims.length).toBe(10);
    const offs = wiPeek().anim.map((r) => r.nexttic);
    // initAnimatedBack ran at bcnt==0 (WI_Start): nexttic ∈ 1..11; an
    // anim whose offset landed on 1 already LOOPED at bcnt==1 (the one
    // gTicker) → nexttic == 1 + period == 12. Deterministic either way.
    expect(Math.min(...offs)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...offs)).toBeLessThanOrEqual(12);
    expect(offs.every((o) => offs.includes(o))).toBe(true);
  });

  it('menu-stream draws only: pRandom ledger byte-quiet, rndindex moved', () => {
    const st = freshState();
    const before = hashState(st);
    enterIntermission(st, { kills: 0, leveltime: 0 });
    expect(hashState(st)).not.toBe(before); // rndindex advanced (hashed)
    expect(RANDOM_SITE_CALLS['wintermission.ts'] === undefined).toBe(true);
    // the sim (P_Random) ledger is byte-quiet in BOTH directions…
    expect(scanRandomSites()).toEqual({ ...RANDOM_SITE_CALLS });
    // …and the menu-stream (wi_anim) ledger matches the code.
    expect(scanMRandomSites()).toEqual({ ...MRANDOM_SITE_CALLS });
  });

  it('epsd0 tally draws exactly 10 menu-stream numbers per state entry', () => {
    // WI_initAnimatedBack: one mRandom per ANIM_ALWAYS anim. Counting the
    // rndindex delta proves the runtime draw count (the plan §0.9 ledger).
    const st = freshState();
    mClearRandom(st.rng);
    enterIntermission(st, { kills: 0, leveltime: 0 });
    expect(st.rng.rndindex).toBe(10); // entry 1: WI_initStats
    gTicker(st, { ...emptyInput(), attack: true }); // fast-forward
    gTicker(st, emptyInput());
    gTicker(st, { ...emptyInput(), attack: true }); // ⇒ ShowNextLoc
    expect(st.rng.rndindex).toBe(20); // entry 2: WI_initShowNextLoc
    // no ANIM_RANDOM table member ⇒ the ShowNextLoc/NoState loops draw 0
    const before = st.rng.rndindex;
    runTics(st, 150);
    expect(st.rng.rndindex).toBe(before);
  });
});

describe('draw-golden cross-pin (mirrors render/wiDraw.test.ts frames)', () => {
  it('counter SoA at tics 1/70/200 of the draw-golden tally', () => {
    // The freedoom1 golden frames (kills 10/max 20, items 3/max 10,
    // secrets 0/1, leveltime 500, E1M1 par 30) are driven from the
    // EXACT counters this state machine produces at those tics.
    const st = freshState('E1M1');
    const p = st.players[0]!;
    st.mobjs.totalkills = 20;
    st.mobjs.totalitems = 10;
    st.totalsecret = 1;
    p.killcount = 10;
    p.itemcount = 3;
    st.secretcount = 0;
    st.leveltime = 500;
    gExitLevel(st);
    const soa = (s: WiDrawSnapshot) =>
      [s.spState, s.cntKills, s.cntItems, s.cntSecret, s.cntTime, s.cntPar];
    gTicker(st, emptyInput()); // tic 1
    expect(soa(wiDrawSnapshot())).toEqual([1, -1, -1, -1, -1, -1]);
    for (let i = 0; i < 69; i++) gTicker(st, emptyInput()); // → tic 70
    expect(soa(wiDrawSnapshot())).toEqual([3, 50, -1, -1, -1, -1]);
    for (let i = 0; i < 130; i++) gTicker(st, emptyInput()); // → tic 200
    expect(soa(wiDrawSnapshot())).toEqual([9, 50, 30, 0, 14, 30]);
  });
});

describe('double-run determinism', () => {
  it('two identical scripted sessions ⇒ identical traces', () => {
    const play = (): string => {
      resetGameFlow();
      wiResetPlayerFlags();
      resetSfxStubLog();
      armHooks();
      const st = freshState();
      mClearRandom(st.rng);
      enterIntermission(st, { kills: 47, items: 12, secrets: 1, leveltime: 9 * 35 + 7 });
      const trace: WiDrawSnapshot[] = [];
      for (let t = 0; t < 600 && !(st.gamestate === GS.LEVEL && trace.length > 0); t++) {
        const input: GameInput =
          t === 180 || t === 182
            ? { ...emptyInput(), attack: true }
            : emptyInput();
        gTicker(st, input);
        trace.push(wiDrawSnapshot());
      }
      expect(st.gamestate).toBe(GS.LEVEL); // the session fully completed
      return traceHash(trace);
    };
    expect(play()).toBe(play());
  });
});

// Golden recorded 2026-07 from this implementation (M9-07): sha256-tag of
// the per-tic counter SoA (phase|sp_state|cnt_*|snl|anim ctrs) for the
// 50/33/0% timeline, tics 1..230, ending on sp_state 10.
const GOLDEN_TIMELINE_HASH = '109d440bc51d33a5';
