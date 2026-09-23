/**
 * sim/pDemo tests — M11-06 (M11-plan §M11-06, §0.5, D-11c/D-11e):
 *  - the GOLDEN PROPERTY: scripted same-seed run RECORDED to demo bytes
 *    ⇒ replay ⇒ per-500-tic hashState identity with the original run
 *    (D-11c: no checksum exists in 1.10 — determinism is certified HERE);
 *  - header byte-exactness (independent literal, §0.5) + DEMOMARKER +
 *    size accounting (plan §4-4: the (len-14)%4 structure PROVES no
 *    per-tic checksum byte exists);
 *  - the write-rewind-read quantization (identity is by construction);
 *  - truncation mid-tic ⇒ G_CheckDemoStatus lane ⇒ advance-demo route,
 *    graceful (no throw);
 *  - VERSION-byte guard (:1589-1595) and the wrong-skill/episode guard
 *    site (inside G_InitNew ⇒ gamemode.ts clampNewGame, g_game.c:1367).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData, type RuntimeMap } from './map';
import {
  GA,
  gFlowTic,
  gInitGame,
  gTicker,
  registerGameFlowHooks,
  resetFlowStubHits,
  resetGameFlow,
  resetSaveFlow,
  flowStubHits
} from './game';
import { hashState, type GameState } from './state';
import { emptyInput, type GameInput } from './ticcmd';
import {
  DEMOMARKER,
  DEMO_HEADER_SIZE,
  demoBytes,
  demoFlow,
  demoPlaying,
  demoRecording,
  gBeginRecording,
  gCheckDemoStatus,
  gDeferedPlayDemo,
  gReadDemoTiccmd,
  gRecordDemo,
  gRequestStopRecord,
  gStartRecordDemo,
  gWriteDemoTiccmd,
  netDemo,
  resetDemo
} from './pDemo';
import {
  captureLog,
  registerCaptureSink,
  resetCaptureLog,
  resetSfxStubLog,
  type CaptureEvent
} from './hooks';

/* ------------------------------------------------------------------ */
/* Fixture + harness (pSaveg.test.ts idiom)                            */
/* ------------------------------------------------------------------ */

const WAD = buildFixtureMapWad({
  rooms: [
    { x: 0, y: 0, w: 512, h: 512 }, // 0: player start (wide: real motion)
    { x: 512, y: 0, w: 256, h: 256 } // 1: extra volume
  ],
  things: [
    { x: 64, y: 64, angle: 0, type: 1 },
    { x: 300, y: 300, type: 3004 }, // possessed (AI churn = P_Random draws)
    { x: 350, y: 120, type: 3004 },
    { x: 128, y: 400, type: 2045 } // stimpack
  ]
});
const WAD_BUF = WAD.buffer.slice(
  WAD.byteOffset,
  WAD.byteOffset + WAD.byteLength
) as ArrayBuffer;

function fixMap(): RuntimeMap {
  return buildMapFromData(loadMap(WadFile.parse(WAD_BUF), 'FIXMAP'));
}

function boot(): GameState {
  const s = gInitGame(fixMap());
  expect(demoPlaying()).toBe(false);
  return s;
}

/** Scripted input with turns (angleturn bytes), moves, fire pulses. */
function script(i: number): GameInput {
  const p = Math.floor(i / 100) % 7;
  return {
    ...emptyInput(),
    forward: p === 0 || p === 2 || p === 4,
    backward: p === 3,
    turnRight: p === 2,
    turnLeft: p === 5,
    strafeRight: p === 4,
    speed: p === 6,
    attack: i % 35 < 3
  };
}

/** Record `tics` tics of `script`, return {state, bytes, hashes}. */
function recordedRun(tics: number, marks: number[]) {
  const s = boot();
  gStartRecordDemo(s, 'unit');
  const hashes: number[] = [];
  for (let i = 0; i < tics; i++) {
    gTicker(s, script(i));
    if (marks.includes(i + 1)) hashes.push(hashState(s));
  }
  gRequestStopRecord(); // 'q' at the NEXT write site (:1508)
  gTicker(s, script(tics));
  expect(demoRecording()).toBe(false);
  const bytes = demoBytes();
  expect(bytes).not.toBeNull();
  return { s, bytes: bytes!, hashes };
}

/** Replay into a fresh boot; returns per-mark hashes + end info. */
function replayRun(bytes: Uint8Array, tics: number, marks: number[]) {
  const r = boot();
  gDeferedPlayDemo(r, bytes);
  expect(r.gameaction).toBe(GA.playdemo);
  const hashes: number[] = [];
  let endedAt = -1;
  for (let i = 0; i < tics + 1; i++) {
    gTicker(r, emptyInput());
    if (!demoPlaying() && endedAt < 0) endedAt = i;
    if (demoPlaying() && marks.includes(i + 1)) hashes.push(hashState(r));
  }
  return { r, hashes, endedAt };
}

beforeEach(() => {
  resetGameFlow();
  resetFlowStubHits();
  resetSaveFlow();
  resetDemo();
  resetCaptureLog();
  resetSfxStubLog();
  registerCaptureSink(null);
  registerGameFlowHooks({ levelLoader: () => fixMap() });
});
afterEach(() => {
  resetGameFlow();
  registerCaptureSink(null);
  resetDemo();
});

describe('pDemo — golden property (record → replay → hash identity)', () => {
  it('1500-tic scripted run: per-500-tic hashes replay-identical', () => {
    const marks = [500, 1000, 1500];
    const rec = recordedRun(1500, marks);
    const rep = replayRun(rec.bytes, 1500, marks);
    expect(rep.hashes.length).toBe(marks.length);
    expect(rep.hashes).toEqual(rec.hashes);
    // demo accounting: header + 4B/tic + marker; no checksum (§4-4).
    expect(rec.bytes.length).toBe(DEMO_HEADER_SIZE + 4 * 1500 + 1);
    expect((rec.bytes.length - (DEMO_HEADER_SIZE + 1)) % 4).toBe(0);
    expect(rec.bytes[rec.bytes.length - 1]).toBe(DEMOMARKER);
    // replay ended on the marker right after the scripted tics
    expect(rep.endedAt).toBe(1500);
    expect(demoPlaying()).toBe(false);
    expect(demoFlow.playsDone).toBe(1);
  });

  it('identity holds across a mid-run mark pattern (211 tics)', () => {
    const marks = [53, 106, 159, 211];
    const rec = recordedRun(211, marks);
    const rep = replayRun(rec.bytes, 211, marks);
    expect(rep.hashes).toEqual(rec.hashes);
  });

  it('write-rewind-read: the live run consumed the QUANTIZED angleturn', () => {
    // angleturn 640 → byte (640+128)>>8 = 3 → re-read 3<<8 = 768 (the
    // recorded world saw 768 — replay reads the same ⇒ identity).
    const s = boot();
    gStartRecordDemo(s, 'q');
    const cmd = { forwardmove: 50, sidemove: -24, angleturn: 640, buttons: 1 };
    expect(gWriteDemoTiccmd(s, cmd)).toBe('ok');
    expect(cmd).toEqual({ forwardmove: 50, sidemove: -24, angleturn: 768, buttons: 1 });
    const b = demoBytes; // (no end yet) — inspect via a stop
    void b;
    gCheckDemoStatus(s);
    const bytes = demoBytes()!.slice(DEMO_HEADER_SIZE, DEMO_HEADER_SIZE + 4);
    expect(Array.from(bytes)).toEqual([50, 232, 3, 1]);
  });
});

describe('pDemo — header (§0.5)', () => {
  it('recorded header is the 13-byte literal (version/skill/ep/map/flags)', () => {
    const s = boot(); // gInitGame default skill 2 ⇒ gameskill 3
    gStartRecordDemo(s, 'hdr');
    gCheckDemoStatus(s);
    expect(Array.from(demoBytes()!.slice(0, 13))).toEqual([
      110, 3, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0
    ]);
  });

  it('playeringame[1] ⇒ netdemo flag (:1611-1615)', () => {
    const s = boot();
    gDeferedPlayDemo(s, demoWithHeader([110, 3, 1, 1, 0, 0, 0, 0, 0, 1, 1, 0, 0], [0, 0, 0, 0]));
    gTicker(s, emptyInput());
    expect(netDemo()).toBe(true);
    expect(demoPlaying()).toBe(true);
    gCheckDemoStatus(s);
    expect(netDemo()).toBe(false);
  });
});

describe('pDemo — end/status lanes', () => {
  it('demo end routes through the advancedemo flag (D023 title route)', () => {
    let titled = 0;
    registerGameFlowHooks({ advanceDemo: () => { titled++; } });
    const rec = recordedRun(40, []);
    const r = boot();
    gDeferedPlayDemo(r, rec.bytes);
    for (let i = 0; i < 44; i++) {
      gTicker(r, emptyInput());
      if (!demoPlaying()) break; // end consumed mid-tic (drain tic keeps it on)
    }
    expect(demoPlaying()).toBe(false);
    expect(r.advancedemo).toBe(true); // D_AdvanceDemo half armed
    gFlowTic(r); // tic-block consumer (d_main.c:381-383)
    expect(titled).toBe(1);
    expect(r.advancedemo).toBe(false);
    expect(demoFlow.playsDone).toBe(1);
    expect(r.usergame).toBe(true); // :1617 inverse on end
  });

  it('truncation MID-TIC is graceful: end lane, no throw, flags reset', () => {
    const rec = recordedRun(30, []);
    const cut = rec.bytes.slice(0, DEMO_HEADER_SIZE + 4 * 10 + 2); // mid-tic
    const r = boot();
    gDeferedPlayDemo(r, cut);
    for (let i = 0; i < 15; i++) gTicker(r, emptyInput());
    expect(demoPlaying()).toBe(false); // ended at tic 10, gracefully
    expect(r.advancedemo).toBe(true);
    expect(demoFlow.playsDone).toBe(1);
    // and the world still runs normally afterwards (title not required)
    expect(() => gTicker(r, emptyInput())).not.toThrow();
  });

  it('truncation EXACTLY at a tic boundary (no marker) ends cleanly', () => {
    const rec = recordedRun(30, []);
    const cut = rec.bytes.slice(0, DEMO_HEADER_SIZE + 4 * 10);
    const rep = replayRun(cut, 12, []);
    expect(rep.endedAt).toBe(10);
    expect(demoFlow.playsDone).toBe(1);
  });

  it("'q' stop: marker appended, bytes out via captureSink kind 'demo'", () => {
    const events: CaptureEvent[] = [];
    registerCaptureSink((e) => events.push(e));
    const rec = recordedRun(20, []);
    expect(rec.bytes.length).toBe(DEMO_HEADER_SIZE + 4 * 20 + 1);
    expect(events.length).toBe(1);
    expect(events[0]!.kind).toBe('demo');
    expect(events[0]!.description).toBe('unit.lmp'); // demoname + .lmp (:1536)
    expect((events[0]!.snapshot as Uint8Array).length).toBe(rec.bytes.length);
    expect(captureLog.entries.at(-1)!.kind).toBe('demo');
    expect(demoFlow.recordsDone).toBe(1);
  });

  it('buffer-full guard (demoend-16) stops recording via the same API', () => {
    const s = boot();
    gRecordDemo('tiny', 1); // 1024B buffer (≡ -maxdemo 1)
    gBeginRecording(s);
    const cmd = { forwardmove: 0, sidemove: 0, angleturn: 0, buttons: 0 };
    let out = 'ok' as string;
    for (let i = 0; i < 400 && out === 'ok'; i++) out = gWriteDemoTiccmd(s, cmd);
    expect(out).toBe('full');
    expect(gCheckDemoStatus(s)).toBe('recorded');
    const b = demoBytes()!;
    expect(b.length).toBeLessThanOrEqual(1024);
    expect(b[b.length - 1]).toBe(DEMOMARKER);
  });
});

describe('pDemo — guard sites', () => {
  it('VERSION-byte mismatch: drop + count, game keeps running (:1589-1595)', () => {
    const s = boot();
    const before = hashState(s);
    gDeferedPlayDemo(s, demoWithHeader([109, 3, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0], [1, 2, 3, 4]));
    gTicker(s, emptyInput());
    expect(s.gameaction).toBe(GA.nothing);
    expect(demoPlaying()).toBe(false);
    expect(demoFlow.versionWarnings).toBe(1);
    expect(s.usergame).toBe(true); // NOT the playback half — live game
    expect(hashState(s)).not.toBe(before); // normal tic progressed
    expect(flowStubHits.byName.has('ga_5')).toBe(false); // real case, not stub
  });

  it('wrong skill/episode: the guard site is gInitNew ⇒ clampNewGame', () => {
    // skill 6 → 5 (g_game.c:1367-1398 clamp table, gamemode.ts:63-65);
    // episode 9 → maxEpisode (g_game.c:1371-1377 half, gamemode.ts:66-69).
    const s = boot();
    gDeferedPlayDemo(s, demoWithHeader([110, 6, 9, 3, 0, 0, 0, 0, 0, 1, 0, 0, 0], []));
    gTicker(s, emptyInput());
    expect(s.gameskill).toBe(5);
    expect(s.gameepisode).toBeGreaterThanOrEqual(1);
    expect(s.gameepisode).toBeLessThanOrEqual(1); // freedoom/shareware policy
    expect(s.gamemap).toBe(3);
    gCheckDemoStatus(s);
  });

  it('demo bytes carry BT_SPECIAL save slots decoded by the SAME loop (§0.3)', () => {
    // Hand-built: one tic with BT_SPECIAL|BTS_SAVEGAME|slot1<<2 = 136.
    const bytes = demoWithHeader([110, 3, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0], [0, 0, 0, 134]);
    const r = boot();
    gDeferedPlayDemo(r, bytes);
    gTicker(r, emptyInput()); // drain arms playback + reads the special cmd
    expect(r.gameaction).toBe(GA.savegame); // decoded by the SAME loop
    gTicker(r, emptyInput()); // drain saves; marker ends the demo here
    expect(captureLog.entries.at(-1)!.kind).toBe('save');
    gCheckDemoStatus(r);
  });
});

/* helpers */
function demoWithHeader(header: number[], body: number[]): Uint8Array {
  return Uint8Array.of(...header, ...body, DEMOMARKER);
}
