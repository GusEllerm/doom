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

import { describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';

import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData } from './map';
import { GameSetupError, gInitGame, gTicker, runHeadless, TICS_PER_SECOND } from './game';
import { hashState, type GameState } from './state';
import { emptyInput, type GameInput } from './ticcmd';
import { CF_NOCLIP } from './player';

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
 * item is an MF_SOLID barrel that used to spawn INSIDE the player). */
const GOLDEN_IDLE_1000 = 4202744993;
const GOLDEN_SCRIPT_1000 = 2889435375;
const GOLDEN_TURNLEFT_1000 = 3987467428;

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
