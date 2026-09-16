/**
 * M2-07 movement tests — noclip fly integration, keyboard-channel-driven
 * turning, debug-API wiring, determinism with motion (ARCHITECTURE §7
 * layer 2, M2-plan §M2-07).
 *
 * Goldens are dual-pinned: (a) exact committed integers (regression trip),
 * and (b) an independent re-derivation from the ticcmd/FixedMul definitions
 * (FORWARDMOVE table × p_user.c's ×2048 scale × tables.ts trig), so a
 * silent change in either layer trips.
 *
 * noclip OFF is a DOCUMENTED PLACEHOLDER: vanilla movement needs
 * P_Thrust+friction+P_CheckPosition (M4 collisions / M5 physics), so the
 * OFF path must show EXACTLY zero translation; only the ON path has
 * movement goldens.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame, gTicker, runHeadless } from '../../src/sim/game';
import { hashState } from '../../src/sim/state';
import {
  CF_NOCLIP,
  MF_NOCLIP,
  MOVE_THRUST_SCALE,
  pPlayerThink
} from '../../src/sim/player';
import { emptyInput, FORWARDMOVE, SIDEMOVE, type GameInput } from '../../src/sim/ticcmd';
import { FixedMul } from '../../src/core/fixed';
import { finecosine, finesine } from '../../src/core/tables';
import { ANG45, ANG90, ANGLETOFINESHIFT } from '../../src/core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';
import { debugApi, debugSim } from '../../src/debug';

/* ------------------------------------------------------------------ */
/* Fixture boot                                                        */
/* ------------------------------------------------------------------ */

const FIX_SPEC: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 200 }]
};

function buildState(): ReturnType<typeof gInitGame> {
  const bytes = buildFixtureMapWad(FIX_SPEC);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

const SPAWN_X = 8388608; // 128 << 16 (FIXMAP room centre start)
const SPAWN_Y = 8388608;

const input = (over: Partial<GameInput>): GameInput => ({ ...emptyInput(), ...over });

const FWD_WALK = FORWARDMOVE[0] * MOVE_THRUST_SCALE; // 25*2048 = 51200
const FWD_RUN = FORWARDMOVE[1] * MOVE_THRUST_SCALE; // 50*2048 = 102400
const SIDE_WALK = SIDEMOVE[0] * MOVE_THRUST_SCALE; // 24*2048 = 49152

/** Per-tic fly step from the ticcmd tables — the §M2-07 definition. */
function flyStep(move: number, angle: number, side: number): [number, number] {
  const fF = angle >>> ANGLETOFINESHIFT;
  const fS = ((angle - ANG90) >>> 0) >>> ANGLETOFINESHIFT;
  return [
    FixedMul(move, finecosine[fF]!) + (side ? FixedMul(side, finecosine[fS]!) : 0),
    FixedMul(move, finesine[fF]!) + (side ? FixedMul(side, finesine[fS]!) : 0)
  ];
}

/* ------------------------------------------------------------------ */
/* Golden fly vectors (noclip ON, constant angle)                      */
/* ------------------------------------------------------------------ */

describe('noclip fly goldens (p_user.c-scaled direct integration)', () => {
  it('spawns FIXMAP player 1 at (128,128) fixed, angle 0', () => {
    const s = buildState();
    expect(s.players[0]!.mo.x).toBe(SPAWN_X);
    expect(s.players[0]!.mo.y).toBe(SPAWN_Y);
    expect(s.players[0]!.mo.angle).toBe(0);
  });

  it('35 tics of walk-forward at angle 0/45/90 match the pinned exact sums', () => {
    const goldens: readonly { angle: number; x: number; y: number; stepX: number; stepY: number }[] = [
      { angle: 0, x: 10180573, y: 8389273, stepX: 51199, stepY: 19 },
      { angle: ANG45, x: 9655223, y: 9656203, stepX: 36189, stepY: 36217 },
      { angle: ANG90, x: 8387908, y: 10180573, stepX: -20, stepY: 51199 }
    ];
    for (const g of goldens) {
      const s = buildState();
      s.players[0]!.cheats |= CF_NOCLIP;
      s.players[0]!.mo.angle = g.angle;
      const [dx, dy] = flyStep(FWD_WALK, g.angle, 0);
      expect([dx, dy], `step at angle ${g.angle}`).toEqual([g.stepX, g.stepY]);
      const h = runHeadless(s, 35, () => input({ forward: true }));
      expect(s.players[0]!.mo.x, `x at angle ${g.angle}`).toBe(SPAWN_X + 35 * dx);
      expect(s.players[0]!.mo.y, `y at angle ${g.angle}`).toBe(SPAWN_Y + 35 * dy);
      expect([s.players[0]!.mo.x, s.players[0]!.mo.y], `golden angle ${g.angle}`).toEqual([g.x, g.y]);
      expect(h).toBe(hashState(s));
      // fly path never touches momentum
      expect(s.players[0]!.mo.momX).toBe(0);
      expect(s.players[0]!.mo.momY).toBe(0);
    }
  });

  it('run key doubles the walk step (FORWARDMOVE[1] scale, angle 0)', () => {
    const s = buildState();
    s.players[0]!.cheats |= CF_NOCLIP;
    runHeadless(s, 35, () => input({ forward: true, speed: true }));
    expect([s.players[0]!.mo.x, s.players[0]!.mo.y]).toEqual([11972538, 8389973]);
    expect(flyStep(FWD_RUN, 0, 0)).toEqual([102398, 39]);
  });

  it('strafe-right 35 tics at angle 0/45/90 uses the exact angle-ANG90 basis', () => {
    const goldens: readonly { angle: number; x: number; y: number }[] = [
      { angle: 0, x: 8389238, y: 6668288 },
      { angle: ANG45, x: 9605488, y: 7172603 },
      { angle: ANG90, x: 10108893, y: 8389238 }
    ];
    for (const g of goldens) {
      const s = buildState();
      s.players[0]!.cheats |= CF_NOCLIP;
      s.players[0]!.mo.angle = g.angle;
      const [dx, dy] = flyStep(0, g.angle, SIDE_WALK);
      runHeadless(s, 35, () => input({ strafeRight: true }));
      expect([s.players[0]!.mo.x, s.players[0]!.mo.y], `strafe angle ${g.angle}`).toEqual([
        SPAWN_X + 35 * dx,
        SPAWN_Y + 35 * dy
      ]);
      expect([s.players[0]!.mo.x, s.players[0]!.mo.y], `golden strafe ${g.angle}`).toEqual([g.x, g.y]);
    }
  });

  it('forward+turn-right 35 tics integrates turn by turn (5 slow + 30 normal ramp)', () => {
    const s = buildState();
    s.players[0]!.cheats |= CF_NOCLIP;
    runHeadless(s, 35, () => input({ forward: true, turnRight: true }));

    // Independent re-derivation: G_BuildTiccmd's turnheld ramp (loop.test
    // golden) applied BEFORE each tic's step (p_user.c order).
    let angle = 0;
    let ex = SPAWN_X;
    let ey = SPAWN_Y;
    for (let tic = 0; tic < 35; tic++) {
      angle = (angle + ((-(tic < 5 ? 320 : 640)) << 16)) >>> 0;
      const [dx, dy] = flyStep(FWD_WALK, angle, 0);
      ex = (ex + dx) | 0;
      ey = (ey + dy) | 0;
    }
    expect(s.players[0]!.mo.x).toBe(ex);
    expect(s.players[0]!.mo.y).toBe(ey);
    expect([s.players[0]!.mo.x, s.players[0]!.mo.y, s.players[0]!.mo.angle]).toEqual([
      9240965, 7178907, 2931818496
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* noclip OFF placeholder + divergence                                 */
/* ------------------------------------------------------------------ */

describe('noclip OFF placeholder (motion arrives with M4/M5 physics)', () => {
  it('identical forward script: OFF never translates, hashes diverge', () => {
    const off = buildState();
    const hOff = runHeadless(off, 35, () => input({ forward: true }));
    expect([off.players[0]!.mo.x, off.players[0]!.mo.y]).toEqual([SPAWN_X, SPAWN_Y]);

    const on = buildState();
    on.players[0]!.cheats |= CF_NOCLIP;
    const hOn = runHeadless(on, 35, () => input({ forward: true }));
    expect(on.players[0]!.mo.x).not.toBe(SPAWN_X);

    expect(hOff).toBe(982937193); // pinned angle-free/off-path identity
    expect(hOn).toBe(3658367640); // pinned noclip-ON hash
    expect(hOff).not.toBe(hOn);

    // OFF + turning: angle integrates (M2-06 path untouched), position fixed
    const t = buildState();
    runHeadless(t, 20, () => input({ forward: true, turnRight: true }));
    expect([t.players[0]!.mo.x, t.players[0]!.mo.y]).toEqual([SPAWN_X, SPAWN_Y]);
    expect(t.players[0]!.mo.angle).not.toBe(0);
  });

  it('CF_NOCLIP toggles MF_NOCLIP on the mobj every tic (p_user.c sync)', () => {
    const s = buildState();
    const p = s.players[0]!;
    expect(p.mo.flags & MF_NOCLIP).toBe(0);
    p.cheats |= CF_NOCLIP;
    pPlayerThink(p);
    expect(p.mo.flags & MF_NOCLIP).toBe(MF_NOCLIP);
  });
});

/* ------------------------------------------------------------------ */
/* Determinism with motion (extends the M2-06 harness)                 */
/* ------------------------------------------------------------------ */

describe('1000-tic determinism with noclip movement', () => {
  const scripted = (g: number): GameInput =>
    g % 7 === 0
      ? input({ turnRight: true })
      : g % 3 === 0
        ? input({ backward: true })
        : input({ forward: true });

  it('two identical input streams hash identically + golden hash', () => {
    const a = buildState();
    const b = buildState();
    a.players[0]!.cheats |= CF_NOCLIP;
    b.players[0]!.cheats |= CF_NOCLIP;
    const h1 = runHeadless(a, 1000, scripted);
    const h2 = runHeadless(b, 1000, scripted);
    expect(h1).toBe(h2);
    expect(h1).toBe(2314677956); // golden recorded from this implementation
    expect([a.players[0]!.mo.x, a.players[0]!.mo.y]).toEqual([5176195, 3983219]);
    expect(a.gametic).toBe(1000);
    expect(a.leveltime).toBe(1000);
  });

  const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
  const hasWad = existsSync(WAD_PATH);

  it.skipIf(!hasWad)('freedoom1 E1M1: 1000 noclip tics deterministic with goldens', () => {
    const bytes = readFileSync(WAD_PATH);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const mk = () => {
      const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
      s.players[0]!.cheats |= CF_NOCLIP;
      return s;
    };
    const a = mk();
    const b = mk();
    const h1 = runHeadless(a, 1000, scripted);
    const h2 = runHeadless(b, 1000, scripted);
    expect(h1).toBe(h2);
    expect(h1).toBe(hashState(b));
    // moved off the (-416,256) spawn (forward/back/turn script, noclip flies
    // through E1M1 walls — no collision yet by design)
    expect([a.players[0]!.mo.x, a.players[0]!.mo.y]).not.toEqual([-416 << 16, 256 << 16]);
    // golden recorded from this implementation on freedoom1.wad
    expect(h1).toBe(3659787626);
  });
});

/* ------------------------------------------------------------------ */
/* Debug sim API (same code path as the harness)                       */
/* ------------------------------------------------------------------ */

describe('debug sim API (window.__doom.sim surface, node-attached)', () => {
  afterEach(() => debugSim.detach());

  it('setNoclip sets CF_NOCLIP + mirrors the mobj flag immediately', () => {
    const s = debugSim.attach(buildState());
    expect(debugSim.setNoclip(true)).toBe(true);
    expect(s.players[0]!.cheats & CF_NOCLIP).toBe(CF_NOCLIP);
    expect(s.players[0]!.mo.flags & MF_NOCLIP).toBe(MF_NOCLIP);
    expect(debugSim.getNoclip()).toBe(true);
    expect(debugSim.setNoclip(false)).toBe(false);
    expect(s.players[0]!.mo.flags & MF_NOCLIP).toBe(0);
  });

  it('runTics(35, {forward}) equals the manual gTicker loop (same path)', () => {
    const a = debugSim.attach(buildState());
    debugSim.setNoclip(true);
    const hApi = debugSim.runTics(35, { forward: true });

    const b = buildState();
    b.players[0]!.cheats |= CF_NOCLIP;
    for (let i = 0; i < 35; i++) gTicker(b, input({ forward: true }));
    expect(hApi).toBe(hashState(b));
    expect(a.players[0]!.mo.x).toBe(b.players[0]!.mo.x);
  });

  it('setInput override is sticky and drives runTics', () => {
    const s = debugSim.attach(buildState());
    debugSim.setNoclip(true);
    debugSim.setInput({ turnRight: true });
    const h1 = debugSim.runTics(10);
    debugSim.runTics(10); // still the same sticky input
    expect(debugSim.getInput()).toEqual(input({ turnRight: true }));
    const b = buildState();
    b.players[0]!.cheats |= CF_NOCLIP;
    const h2 = runHeadless(b, 20, () => input({ turnRight: true }));
    expect(h1).not.toBe(h2); // 10 vs 20 tics differ
    expect(hashState(s)).toBe(h2); // 2 sticky tics == 2 explicit ones
    debugSim.setInput(null);
    expect(debugSim.getInput()).toBeNull();
  });

  it('warp sets fixed coords + angleDeg→BAM; state() mirrors them', () => {
    const s = debugSim.attach(buildState());
    debugSim.warp(-416 << 16, 256 << 16, undefined, 90);
    const p = s.players[0]!;
    expect([p.mo.x, p.mo.y]).toEqual([-27262976, 16777216]);
    expect(p.mo.angle).toBe(0x40000000);
    const st = debugSim.getState();
    expect(st).toBe(s);
  });

  it('state() reports ready snapshot with fixed values + hash', () => {
    const s = debugSim.attach(buildState());
    debugSim.setNoclip(true);
    debugSim.runTics(5, { forward: true });
    const snap = debugApi.state();
    expect(snap.ready).toBe(true);
    if (!snap.ready) return;
    expect(snap.map).toBe('FIXMAP');
    expect(snap.gametic).toBe(5);
    expect(snap.leveltime).toBe(5);
    expect(snap.player.x).toBe(s.players[0]!.mo.x);
    expect(snap.player.y).toBe(s.players[0]!.mo.y);
    expect(snap.player.noclip).toBe(true);
    expect(snap.hash).toBe(hashState(s));
    debugSim.detach();
    expect(debugApi.state().ready).toBe(false);
  });
});
