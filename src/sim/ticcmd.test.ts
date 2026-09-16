/**
 * sim/ticcmd tests (M2-06) — G_BuildTiccmd vectors pinned from
 * g_game.c:223+ (tables at g_game.c:171-179, SLOWTURNTICS ramp at
 * g_game.c:265-276, clamps at g_game.c:371-379) and the `<<16` angle
 * scaling (d_ticcmd.h:39 "short angleturn; <<16 for angle delta", applied
 * by p_user.c P_MovePlayer).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  ANGLETURN,
  BT_ATTACK,
  BT_USE,
  emptyInput,
  FORWARDMOVE,
  gBuildTiccmd,
  MAXPLMOVE,
  SIDEMOVE,
  SLOWTURNTICS,
  type GameInput,
  type TurnheldState
} from './ticcmd';

const inp = (over: Partial<GameInput> = {}): GameInput => ({ ...emptyInput(), ...over });
const freshTurn = (): TurnheldState => ({ turnheld: 0 });

describe('tuning constants (g_game.c:171-179)', () => {
  it('match the C initializers verbatim', () => {
    expect(FORWARDMOVE).toEqual([0x19, 0x32]); // 25, 50
    expect(SIDEMOVE).toEqual([0x18, 0x28]); // 24, 40
    expect(ANGLETURN).toEqual([640, 1280, 320]);
    expect(SLOWTURNTICS).toBe(6);
    expect(MAXPLMOVE).toBe(50); // = forwardmove[1]
  });
});

describe('G_BuildTiccmd movement vectors', () => {
  it('no input → all-zero command', () => {
    expect(gBuildTiccmd(inp(), freshTurn())).toEqual({
      forwardmove: 0,
      sidemove: 0,
      angleturn: 0,
      buttons: 0
    });
  });

  it('forward walk = forwardmove[0] = 25; run = forwardmove[1] = 50', () => {
    expect(gBuildTiccmd(inp({ forward: true }), freshTurn()).forwardmove).toBe(25);
    expect(gBuildTiccmd(inp({ forward: true, speed: true }), freshTurn()).forwardmove).toBe(50);
    expect(gBuildTiccmd(inp({ backward: true }), freshTurn()).forwardmove).toBe(-25);
  });

  it('forward+back cancel (g_game.c "let movement keys cancel each other out")', () => {
    expect(gBuildTiccmd(inp({ forward: true, backward: true }), freshTurn()).forwardmove).toBe(0);
  });

  it('strafe modifier turns left/right into sidemove[speed]', () => {
    const s = gBuildTiccmd(inp({ turnRight: true, strafe: true }), freshTurn());
    expect(s.sidemove).toBe(24);
    expect(s.angleturn).toBe(0); // no turn while strafing
    expect(gBuildTiccmd(inp({ turnLeft: true, strafe: true, speed: true }), freshTurn()).sidemove)
      .toBe(-40);
  });

  it('dedicated strafe keys add to side regardless of turn behaviour', () => {
    const s = gBuildTiccmd(inp({ strafeRight: true, forward: true }), freshTurn());
    expect(s).toMatchObject({ forwardmove: 25, sidemove: 24 });
  });

  it('both turn keys held cancel (±angleturn[tspeed])', () => {
    const t = freshTurn();
    for (let i = 0; i < 10; i++) gBuildTiccmd(inp({ turnLeft: true, turnRight: true }), t);
    expect(gBuildTiccmd(inp({ turnLeft: true, turnRight: true }), t).angleturn).toBe(0);
  });
});

describe('G_BuildTiccmd turn acceleration (g_game.c:265-276)', () => {
  it('first 5 held tics slow (320), tic 6+ normal (640), run key → 1280', () => {
    const t = freshTurn();
    const seq = Array.from({ length: 8 }, () => gBuildTiccmd(inp({ turnRight: true }), t).angleturn);
    // turnheld is incremented BEFORE the check: values 1..5 are < SLOWTURNTICS
    expect(seq).toEqual([320, 320, 320, 320, 320, 640, 640, 640].map((v) => -v));
    // negative: right turns DOWN (g_game.c:299 `cmd->angleturn -= angleturn[tspeed]`)
    const t2 = freshTurn();
    for (let i = 0; i < 10; i++) gBuildTiccmd(inp({ turnLeft: true, speed: true }), t2);
    expect(gBuildTiccmd(inp({ turnLeft: true, speed: true }), t2).angleturn).toBe(1280);
  });

  it('release resets turnheld (next press starts slow again)', () => {
    const t = freshTurn();
    for (let i = 0; i < 10; i++) gBuildTiccmd(inp({ turnRight: true }), t);
    gBuildTiccmd(inp(), t); // one tic of no turn key → turnheld = 0
    expect(t.turnheld).toBe(0);
    expect(gBuildTiccmd(inp({ turnRight: true }), t).angleturn).toBe(-320);
  });
});

describe('G_BuildTiccmd clamps and buttons', () => {
  it('forward+strafe-right (both MAXPLMOVE contributors) clamp to ±50 each axis', () => {
    // run: forward 50, side 40 (+ turnRight as strafe adds 40 more side → 80)
    const s = gBuildTiccmd(
      inp({ forward: true, strafeRight: true, turnRight: true, strafe: true, speed: true }),
      freshTurn()
    );
    expect(s.forwardmove).toBe(50);
    expect(s.sidemove).toBe(MAXPLMOVE); // 40 + 40 = 80 clamped to 50
  });

  it('attack/use map to BT_ATTACK/BT_USE bits (d_event.h:75-77)', () => {
    expect(gBuildTiccmd(inp({ attack: true }), freshTurn()).buttons).toBe(BT_ATTACK);
    expect(gBuildTiccmd(inp({ use: true }), freshTurn()).buttons).toBe(BT_USE);
    expect(gBuildTiccmd(inp({ attack: true, use: true }), freshTurn()).buttons).toBe(BT_ATTACK | BT_USE);
  });
});

describe('angleturn → BAM scaling (d_ticcmd.h:39 + p_user.c P_MovePlayer)', () => {
  it('angleturn << 16 gives the exact BAM delta per tic', () => {
    // 640 << 16 = 41_943_040 BAM/tic; 1° = 2^32/360 = 11_930_464.71 BAM.
    expect(640 << 16).toBe(41943040);
    expect(320 << 16).toBe(20971520);
    expect(1280 << 16).toBe(83886080);
    // a full turn at normal speed takes 2^32 / (640<<16) = 102.4 tics
    expect((640 << 16) / 4294967296 * 360).toBeCloseTo(3.515625, 10);
    // full 360° at normal turn takes 2^32 / (640<<16) = 102.4 tics
    expect(2 ** 32 / (640 << 16)).toBeCloseTo(102.4, 10);
  });
});
