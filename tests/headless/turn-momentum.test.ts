/**
 * B-09 turn-momentum invariants (docs/BUGS.md B-09: "turning feels like
 * gaining forward momentum"). Pure-sim theorem suite through the FULL gTicker
 * stack (input → G_BuildTiccmd → P_MovePlayer → P_Thrust → P_XYMovement),
 * dual-pinned against independent BigInt re-derivations of the p_user.c /
 * p_mobj.c streams. Vanilla theorem: momx/momy are WORLD-frame (mobj_t
 * fields, p_mobj.h:242-244); turning writes ONLY mobj angle (p_user.c:135
 * `mo->angle += cmd->angleturn<<16`) — the momentum vector NEVER follows
 * the view; P_Thrust (p_user.c:57-68) adds thrust at the CURRENT angle and
 * P_XYMovement (p_mobj.c:114-243) friction-decays it (FixedMul FRICTION
 * 0xe800) with zero rotation. Any growth/rotation of mom during angle-only
 * tics is a deviation; these four specs pin all four reported angles on the
 * bug (rest-turn, at-speed-turn, turn+thrust stream, mouse-heavy session).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { ANG90, FRACUNIT } from '../../src/core/constants';
import { finecosine, finesine } from '../../src/core/tables';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';

import { gInitGame, gTicker } from '../../src/sim/game';
import { buildMapFromData } from '../../src/sim/map';
import { pTeleportMove } from '../../src/sim/pmap';
import { ANGLETURN, emptyInput, FORWARDMOVE, SLOWTURNTICS, type GameInput, type Ticcmd } from '../../src/sim/ticcmd';
import { MOVE_THRUST_SCALE, type Player } from '../../src/sim/player';
import type { GameState } from '../../src/sim/state';

const fx = (n: number): number => (n * FRACUNIT) | 0;

/** BigInt oracle of core/fixed FixedMul (exact product, arithmetic >>16, low 32). */
function fixedMulOracle(a: number, b: number): number {
  return Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
}

const FM = 0xe800; // p_mobj.c:112 FRICTION

/** Open friction arena, spawn mid-room so nothing ever blocks (same shape
 * as puser.test.ts ARENA). */
const ARENA: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 1024, h: 1024, ceilingHeight: 400, lightLevel: 200 }],
  things: [{ x: 512, y: 512, angle: 0, type: 1 }]
};

function boot(): GameState {
  const bytes = buildFixtureMapWad(ARENA, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

function warp(s: GameState, xUnits: number, yUnits: number): void {
  const p = s.players[0]!;
  pTeleportMove(s.pmap, p.mo, fx(xUnits), fx(yUnits));
  p.mo.z = p.mo.floorz;
}

const input = (over: Partial<GameInput>): GameInput => ({ ...emptyInput(), ...over });

/** Per-tic sample of the exact fields these theorems quantify. */
interface Snap {
  momx: number;
  momy: number;
  x: number;
  y: number;
  angle: number;
  cmd: Ticcmd;
}

function snap(p: Player): Snap {
  return {
    momx: p.mo.momx,
    momy: p.mo.momy,
    x: p.mo.x,
    y: p.mo.y,
    angle: p.mo.angle,
    cmd: { ...p.cmd },
  };
}

/** g_game.c:265-276 turnheld ramp for a key HELD from tic 1: increment
 * BEFORE the compare (g_game.c:267-271 then :273), so tics 1..5 are slow
 * 320 (turnheld 1..5 < SLOWTURNTICS), tic 6+ ANGLETURN[speed] — same ramp
 * pinned by tests/headless/loop.test.ts. */
function angleturnKeyRamp(t: number, speed: boolean): number {
  const tspeed = t < SLOWTURNTICS ? 2 : speed ? 1 : 0;
  return ANGLETURN[tspeed]!;
}

/** p_mobj.c:204-243 walking-frame stop: both axes inside ±STOPSPEED and no
 * move input ⇒ momentum hard-zero, else friction fold. Applied to the
 * pre-move momentum each tic. */
function stopOrFriction(ex: number, ey: number): [number, number] {
  if (Math.abs(ex) < 0x1000 && Math.abs(ey) < 0x1000) return [0, 0];
  return [fixedMulOracle(ex, FM), fixedMulOracle(ey, FM)];
}

describe('B-09 turn-momentum invariants (world-frame mom; turning never moves)', () => {
  it('(a) at rest, angle-only tics: mom stays EXACTLY 0, position EXACTLY fixed', () => {
    const s = boot();
    const p = s.players[0]!;
    warp(s, 512, 512);
    const s0 = snap(p);
    let ang = s0.angle;
    for (let t = 1; t <= 100; t++) {
      gTicker(s, input({ turnLeft: true }));
      const s1 = snap(p);
      expect(s1.momx, `momx @tic ${t}`).toBe(0);
      expect(s1.momy, `momy @tic ${t}`).toBe(0);
      expect(s1.x, `x @tic ${t}`).toBe(s0.x);
      expect(s1.y, `y @tic ${t}`).toBe(s0.y);
      ang = (ang + ((angleturnKeyRamp(t, false) << 16) >>> 0)) >>> 0; // p_user.c:135
      expect(s1.angle, `angle @tic ${t}`).toBe(ang);
      // no phantom input: turn keys fill ONLY angleturn (g_game.c:265-307)
      expect(s1.cmd.forwardmove).toBe(0);
      expect(s1.cmd.sidemove).toBe(0);
    }
  });

  it('(b) at speed, angle-only tics: mom vector EXACT friction-only invariant', () => {
    const s = boot();
    const p = s.players[0]!;
    warp(s, 400, 512);
    for (let t = 0; t < 20; t++) gTicker(s, input({ forward: true })); // walk east
    let ex = p.mo.momx;
    let ey = p.mo.momy;
    let x = p.mo.x;
    let y = p.mo.y;
    for (let t = 1; t <= 30; t++) {
      // p_mobj.c: stride == current momentum (no thrust this tic), then the
      // STOPSPEED/friction block — direction-preserving by construction;
      // the vector must NOT rotate toward the (turning) view.
      x = (x + ex) | 0;
      y = (y + ey) | 0;
      [ex, ey] = stopOrFriction(ex, ey);
      gTicker(s, input({ turnLeft: true }));
      const s1 = snap(p);
      expect([s1.momx, s1.momy], `mom @tic ${t}`).toEqual([ex, ey]);
      expect([s1.x, s1.y], `pos @tic ${t}`).toEqual([x, y]);
    }
  });

  it('(c) turn+hold-forward: momentum stream == thrust re-derived at the post-turn angle, EXACT per tic', () => {
    const s = boot();
    const p = s.players[0]!;
    warp(s, 300, 512);
    const T = 24;
    let ang = p.mo.angle;
    let mx = 0;
    let my = 0;
    for (let t = 1; t <= T; t++) {
      // p_user.c:135 angle FIRST, then P_Thrust at the NEW angle (:151-155),
      // then P_XYMovement friction (p_mobj.c:229-242). One angleturn per tic.
      ang = (ang + ((angleturnKeyRamp(t, true) << 16) >>> 0)) >>> 0;
      const fine = ang >>> 19;
      const tx = fixedMulOracle(FORWARDMOVE[1]! * MOVE_THRUST_SCALE, finecosine[fine]!);
      const ty = fixedMulOracle(FORWARDMOVE[1]! * MOVE_THRUST_SCALE, finesine[fine]!);
      mx = fixedMulOracle((mx + tx) | 0, FM);
      my = fixedMulOracle((my + ty) | 0, FM);
      gTicker(s, input({ forward: true, speed: true, turnLeft: true }));
      const s1 = snap(p);
      expect(s1.angle, `angle @tic ${t}`).toBe(ang);
      expect([s1.momx, s1.momy], `mom @tic ${t}`).toEqual([mx, my]);
    }
  });

  it('(d) mouse-heavy session: mouse turns move ONLY the angle; mom == friction stream', () => {
    const s = boot();
    const p = s.players[0]!;
    warp(s, 350, 512);
    for (let t = 0; t < 20; t++) gTicker(s, input({ forward: true })); // to speed
    let ex = p.mo.momx;
    let ey = p.mo.momy;
    let ang = p.mo.angle;
    for (let t = 1; t <= 25; t++) {
      gTicker(s, input({ mouseX: t % 2 === 0 ? 12 : -7 })); // flick back and forth
      const s1 = snap(p);
      // g_game.c:405-409: mouseX lands in angleturn ONLY (no strafe mod);
      // forward/side channels must be pristine zero.
      expect(s1.cmd.forwardmove, `fwd @tic ${t}`).toBe(0);
      expect(s1.cmd.sidemove, `side @tic ${t}`).toBe(0);
      ang = (ang + (((-(t % 2 === 0 ? 12 : -7) * 0x8) << 16) >>> 0)) >>> 0;
      expect(s1.angle >>> 0, `angle @tic ${t}`).toBe(ang);
      [ex, ey] = stopOrFriction(ex, ey); // forwardmove==0 ⇒ stop-check first
      expect([s1.momx, s1.momy], `mom @tic ${t} (friction stream)`).toEqual([ex, ey]);
    }
  });

  it('(d2) mouse-Y stays the vanilla forward channel and NEVER rides the turn: pure mousex produces zero thrust', () => {
    // g_game.c:405 `forward += mousey` — 1.10 mouse-Y == forward/back
    // (NO pitch). The B-09 lesson pinned: mouseX must contribute NOTHING
    // to forwardmove/sidemove, whatever the turn magnitude.
    const s = boot();
    const p = s.players[0]!;
    warp(s, 512, 512);
    for (const dx of [1, 63, 500, -200]) {
      gTicker(s, input({ mouseX: dx }));
      expect(p.cmd.forwardmove, `fwd for mouseX=${dx}`).toBe(0);
      expect(p.cmd.sidemove, `side for mouseX=${dx}`).toBe(0);
      expect(p.mo.momx).toBe(0);
      expect(p.mo.momy).toBe(0);
    }
    // and mouse-Y alone DOES the vanilla forward thrust (not broken by the
    // turn plumbing): one kick tic == one thrust step (see physics.spec (2))
    const mx0 = p.mo.momx;
    gTicker(s, input({ mouseY: 25 }));
    expect(p.mo.momx).toBeGreaterThan(mx0);
    expect(ANG90 > 0).toBe(true); // constants import guard
  });
});
