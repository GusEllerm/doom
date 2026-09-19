/**
 * M5-06 movement tests — the D009 fly stub is GONE: p_user.c physics
 * (P_Thrust → momentum → P_XYMovement/P_ZMovement) drives every path, and
 * noclip means vanilla noclip (identical physics, checks skipped; D012).
 *
 * Goldens are dual-pinned: (a) exact committed integers (regression trip),
 * (b) independent re-derivation from the ticcmd/table/friction definitions
 * (FORWARDMOVE ×2048 × the 1993 fine-cosine/sine tables × FRICTION 0xe800),
 * so a silent change in any layer trips.
 *
 * The OLD fly-path goldens are MOVED (not deleted) into the
 * "legacy D009 fly path" block below as engine-free arithmetic — they pin
 * what the stub used to compute for the D009→D012 transition review
 * (M5-plan §6 risk note).
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
import { puserGlobals } from '../../src/sim/puser';
import { CF_NOCLIP, MF_NOCLIP, MOVE_THRUST_SCALE } from '../../src/sim/player';
import { emptyInput, FORWARDMOVE, SIDEMOVE, type GameInput } from '../../src/sim/ticcmd';
import { FixedMul } from '../../src/core/fixed';
import { finecosine, finesine } from '../../src/core/tables';
import { ANG45, ANG90, ANGLETOFINESHIFT, FRACUNIT } from '../../src/core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';
import { debugApi, debugSim } from '../../src/debug';

/* ------------------------------------------------------------------ */
/* Fixture boot                                                        */
/* ------------------------------------------------------------------ */

// Explicit start thing: the default fixture dot item is an MF_SOLID barrel
// that would spawn ON the player (the fly path ignored things; physics
// does not). Spawn stays at (128,128) exactly as in the M2 goldens.
const FIX_SPEC: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 200 }],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
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

afterEach(() => {
  puserGlobals.onground = false; // p_user.c file-scope global hygiene
});

const FWD_WALK = FORWARDMOVE[0] * MOVE_THRUST_SCALE; // 25*2048 = 51200
const FWD_RUN = FORWARDMOVE[1] * MOVE_THRUST_SCALE; // 50*2048 = 102400
const SIDE_WALK = SIDEMOVE[0] * MOVE_THRUST_SCALE; // 24*2048 = 49152

/** BigInt FixedMul oracle (exact product, arithmetic >>16, low 32 bits). */
function fxm(a: number, b: number): number {
  return Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
}

/** Per-tic LEGACY fly step from the ticcmd tables — the §M2-07 definition,
 * retained for the historical block below ONLY (the engine no longer does
 * this; D009 closed by M5-06/D012). */
function flyStep(move: number, angle: number, side: number): [number, number] {
  const fF = angle >>> ANGLETOFINESHIFT;
  const fS = ((angle - ANG90) >>> 0) >>> ANGLETOFINESHIFT;
  return [
    FixedMul(move, finecosine[fF]!) + (side ? FixedMul(side, finecosine[fS]!) : 0),
    FixedMul(move, finesine[fF]!) + (side ? FixedMul(side, finesine[fS]!) : 0)
  ];
}

/** Momentum-curve re-derivation (p_user.c thrust + p_mobj.c friction,
 * single substep, no blocking — noclip on an open plane): per tic the
 * stride is the post-thrust momentum, mom then decodes by FRICTION. */
function stride(
  prevMom: number,
  thrust: number
): { step: number; mom: number } {
  const step = (prevMom + thrust) | 0;
  return { step, mom: fxm(step, 0xe800) };
}

/* ------------------------------------------------------------------ */
/* Spawn                                                               */
/* ------------------------------------------------------------------ */

describe('spawn state', () => {
  it('FIXMAP player 1 at (128,128) fixed, angle 0, z resolved to the floor', () => {
    const s = buildState();
    expect(s.players[0]!.mo.x).toBe(SPAWN_X);
    expect(s.players[0]!.mo.y).toBe(SPAWN_Y);
    expect(s.players[0]!.mo.angle).toBe(0);
    // M5-06: P_SpawnMobj tail — ONFLOORZ resolved at level boot, not a tic
    // of stub-frozen z (M2) any more.
    expect(s.players[0]!.mo.z).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* LEGACY D009 fly path — historical arithmetic (engine removed)       */
/* ------------------------------------------------------------------ */

describe('legacy D009 fly path (HISTORICAL — arithmetic only, engine gone)', () => {
  // D009 (M2-07) integrated the ticcmd DIRECTLY per tic with no momentum:
  //   x += FixedMul(forwardmove*2048, finecosine) + strafe twin
  // The goldens below pin that formula (and what the stub produced) for
  // the transition record; the ENGINE now runs the momentum curve (the
  // "noclip = vanilla momentum" blocks below). See docs DECISIONS D009 →
  // D012 and the M5-plan §6 re-bless note.
  it('fly formula still evaluates to the M2-07 committed steps', () => {
    expect(flyStep(FWD_WALK, 0, 0)).toEqual([51199, 19]);
    expect(flyStep(FWD_RUN, 0, 0)).toEqual([102398, 39]);
    // what the stub engine produced (M2 goldens, superseded — NOT asserted
    // against the engine): walk-35-at-angle-0 landed at (10180573, 8389273)
    // and noclip-OFF never translated at all.
    expect([SPAWN_X + 35 * 51199, SPAWN_Y + 35 * 19]).toEqual([10180573, 8389273]);
  });
});

/* ------------------------------------------------------------------ */
/* noclip = vanilla: the momentum curve goldens (D009 closure)         */
/* ------------------------------------------------------------------ */

describe('noclip walk goldens (P_Thrust + friction — same curve as clipped)', () => {
  it('35 tics of walk-forward at angle 0/45/90 match the curve + goldens', () => {
    const goldens: readonly { angle: number; x: number; y: number }[] = [
      { angle: 0, x: 22391954, y: 8393671 },
      { angle: ANG45, x: 18286581, y: 18294217 },
      { angle: ANG90, x: 8383007, y: 22391954 }
    ];
    for (const g of goldens) {
      const s = buildState();
      s.players[0]!.cheats |= CF_NOCLIP;
      s.players[0]!.mo.angle = g.angle >>> 0;
      runHeadless(s, 35, () => input({ forward: true }));
      const p = s.players[0]!.mo;
      expect([p.x, p.y], `golden angle ${g.angle >>> 0}`).toEqual([g.x, g.y]);

      // Independent re-derivation (thrust via tables, friction 0xe800):
      const c = finecosine[g.angle >>> ANGLETOFINESHIFT]!;
      const sN = finesine[g.angle >>> ANGLETOFINESHIFT]!;
      let mx = 0;
      let my = 0;
      let x = SPAWN_X;
      let y = SPAWN_Y;
      for (let t = 0; t < 35; t++) {
        const sx = stride(mx, fxm(FWD_WALK, c));
        const sy = stride(my, fxm(FWD_WALK, sN));
        x = (x + sx.step) | 0;
        y = (y + sy.step) | 0;
        mx = sx.mom;
        my = sy.mom;
      }
      expect([p.x, p.y], `re-derived angle ${g.angle >>> 0}`).toEqual([x, y]);
      // momentum lives now (the fly stub never had any):
      expect(p.momx).toBe(mx);
      expect(p.momy).toBe(my);
      expect(mx !== 0 || my !== 0).toBe(true);
    }
  });

  it('run key doubles the thrust (FORWARDMOVE[1], angle 0) + MAXMOVE split', () => {
    const s = buildState();
    s.players[0]!.cheats |= CF_NOCLIP;
    runHeadless(s, 35, () => input({ forward: true, speed: true }));
    expect([s.players[0]!.mo.x, s.players[0]!.mo.y]).toEqual([36395394, 8399147]);
    // run strides exceed MAXMOVE/2 late in the run → the p_mobj.c half-split
    // moves them (position identical to the single-step curve on open ground)
    let mx = 0;
    let x = SPAWN_X;
    for (let t = 0; t < 35; t++) {
      const sx = stride(mx, fxm(FWD_RUN, finecosine[0]!));
      // MAXMOVE/2 half-split (p_mobj.c, positive-only quirk): the odd unit
      // of a positive stride > 15*FRACUNIT is lost to the two floor-halves.
      x = (x + (sx.step > 15 * FRACUNIT ? sx.step - (sx.step & 1) : sx.step)) | 0;
      mx = sx.mom;
    }
    expect(s.players[0]!.mo.x).toBe(x);
  });

  it('strafe-right 35 tics at angle 0/45/90 uses the exact angle-ANG90 basis', () => {
    const goldens: readonly { angle: number; x: number; y: number }[] = [
      { angle: 0, x: 8393399, y: -5055106 },
      { angle: ANG45, x: 17897877, y: -1114085 },
      { angle: ANG90, x: 21831814, y: 8393399 }
    ];
    for (const g of goldens) {
      const s = buildState();
      s.players[0]!.cheats |= CF_NOCLIP;
      s.players[0]!.mo.angle = g.angle >>> 0;
      runHeadless(s, 35, () => input({ strafeRight: true }));
      expect([s.players[0]!.mo.x, s.players[0]!.mo.y], `strafe ${g.angle >>> 0}`).toEqual([
        g.x,
        g.y
      ]);
      const fS = ((g.angle - ANG90) >>> 0) >>> ANGLETOFINESHIFT;
      let mx = 0;
      let my = 0;
      let x = SPAWN_X;
      let y = SPAWN_Y;
      for (let t = 0; t < 35; t++) {
        const sx = stride(mx, fxm(SIDE_WALK, finecosine[fS]!));
        const sy = stride(my, fxm(SIDE_WALK, finesine[fS]!));
        x = (x + sx.step) | 0;
        y = (y + sy.step) | 0;
        mx = sx.mom;
        my = sy.mom;
      }
      expect([s.players[0]!.mo.x, s.players[0]!.mo.y], `strafe re-derived ${g.angle >>> 0}`).toEqual([x, y]);
    }
  });

  it('forward+turn-right 35 tics: turn FIRST, thrust at the NEW angle', () => {
    const s = buildState();
    s.players[0]!.cheats |= CF_NOCLIP;
    runHeadless(s, 35, () => input({ forward: true, turnRight: true }));
    expect([s.players[0]!.mo.x, s.players[0]!.mo.y, s.players[0]!.mo.angle]).toEqual([
      17125346, 37509, 2931818496
    ]);

    // turnheld ramp (5×320 slow, then 640) + per-tic thrust/friction.
    let angle = 0;
    let mx = 0;
    let my = 0;
    let x = SPAWN_X;
    let y = SPAWN_Y;
    for (let t = 0; t < 35; t++) {
      angle = (angle + ((-(t < 5 ? 320 : 640)) << 16)) >>> 0;
      const sx = stride(mx, fxm(FWD_WALK, finecosine[angle >>> ANGLETOFINESHIFT]!));
      const sy = stride(my, fxm(FWD_WALK, finesine[angle >>> ANGLETOFINESHIFT]!));
      x = (x + sx.step) | 0;
      y = (y + sy.step) | 0;
      mx = sx.mom;
      my = sy.mom;
    }
    expect([s.players[0]!.mo.x, s.players[0]!.mo.y]).toEqual([x, y]);
  });
});

/* ------------------------------------------------------------------ */
/* noclip OFF is now the SAME physics (walls aside)                    */
/* ------------------------------------------------------------------ */

describe('noclip OFF = real physics (D009 placeholder gone)', () => {
  it('35-tic forward walk clipped by the FIXMAP east wall: pins + viewz', () => {
    const s = buildState();
    const h = runHeadless(s, 35, () => input({ forward: true }));
    const p = s.players[0]!.mo;
    expect(p.x).toBe(15726887); // flush against the void wall (≈240u − ε)
    expect(p.y).toBe(8392243); // the +19/tic table drift rides along
    expect(h).toBe(169379333); // RE-BLESSED M6-01 'M6 world-state fields' (was M5-06)
    // viewz from P_CalcHeight now, not the 0 placeholder: z(0) + 41 + wave
    expect(s.players[0]!.viewz).toBeGreaterThanOrEqual(40 * FRACUNIT);
    expect(s.players[0]!.viewz).toBeLessThanOrEqual(49 * FRACUNIT);
  });

  it('noclip ON vs OFF same thrust (same mom) until the wall differs them', () => {
    const off = buildState();
    const on = buildState();
    on.players[0]!.cheats |= CF_NOCLIP;
    for (let t = 0; t < 10; t++) {
      gTicker(off, input({ forward: true }));
      gTicker(on, input({ forward: true }));
      expect(on.players[0]!.mo.momx).toBe(off.players[0]!.mo.momx);
      expect(on.players[0]!.mo.x).toBe(off.players[0]!.mo.x); // still no wall yet
    }
    for (let t = 0; t < 25; t++) {
      gTicker(off, input({ forward: true }));
      gTicker(on, input({ forward: true }));
    }
    expect(on.players[0]!.mo.x).toBeGreaterThan(off.players[0]!.mo.x); // through it
    expect(on.players[0]!.mo.flags & MF_NOCLIP).toBe(MF_NOCLIP);
    expect(off.players[0]!.mo.flags & MF_NOCLIP).toBe(0);
  });

  it('CF_NOCLIP toggles MF_NOCLIP on the mobj every tic (p_user.c sync)', () => {
    const s = buildState();
    const p = s.players[0]!;
    expect(p.mo.flags & MF_NOCLIP).toBe(0);
    p.cheats |= CF_NOCLIP;
    gTicker(s);
    expect(p.mo.flags & MF_NOCLIP).toBe(MF_NOCLIP);
    p.cheats = 0;
    gTicker(s);
    expect(p.mo.flags & MF_NOCLIP).toBe(0);
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
    expect(h1).toBe(515888135); // RE-BLESSED M6-01 'M6 world-state fields' (was M5-06)
    expect([a.players[0]!.mo.x, a.players[0]!.mo.y]).toEqual([-25465553, -39676152]);
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
    expect([a.players[0]!.mo.x, a.players[0]!.mo.y]).not.toEqual([-416 << 16, 256 << 16]);
    // golden RE-BLESSED M5-06 (physics replaces D009) then M6-01
    // (one-time, reason: 'M6 world-state fields' — §3.4 sector/globals/arena bytes)
    // then M6-03 (one-time, reason: 'P_SpawnSpecials at load' — sector-
    // special spawn clears + totalsecret at gInitGame): 2368943012 → 1563175793.
    // then M6-09 (one-time, reason: 'sector-light specials live' — E1M1
    // light thinkers spawn at load, draw P_Random and tick live lights):
    // 1563175793 → 1350827061.
    expect(h1).toBe(1350827061);
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

  it('warp teleports (fix coords + z resolved) + angleDeg→BAM; state() mirrors', () => {
    const s = debugSim.attach(buildState());
    debugSim.warp(-416 << 16, 256 << 16, undefined, 90);
    const p = s.players[0]!;
    expect([p.mo.x, p.mo.y]).toEqual([-27262976, 16777216]);
    expect(p.mo.angle).toBe(0x40000000);
    expect(p.mo.z).toBe(p.mo.floorz); // M5-06: warp resolves the floor (VOID −128 here)
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
