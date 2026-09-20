/**
 * M5-09 — L2 scripted-tic FEEL goldens (docs/design/M5-plan.md §M5-09).
 * GameInput streams scripted through gTicker/runHeadless on FIXMAP-style
 * rectangle fixtures + physics-complete maps (step rooms 24/25, 500-drop
 * ledge, slide corner, barrel, low corridors) — the committed-hash evidence
 * layer that pins the *feel* curves: momentum, friction glide, stop tic,
 * strafe straightness, step-up boundary, wall slide, fall/squat/bob-resume,
 * turn+move, noclip parity (D012), thing blocking, viewz clamp, and a
 * 2000-tic marathon route. Every scenario is double-run (two identical
 * boots ⇒ identical hash) and carries a committed hash; where the source
 * formulas allow (p_mobj.c friction recurrence, P_Thrust table basis, the
 * discrete gravity parabola, the turnheld ramp) a BigInt/analytic oracle
 * re-derivation runs ALONGSIDE the hash — hash-only appears exactly once
 * (marathon route), everything else has an independent arithmetic check.
 *
 * Goldens blessed 2026-07 from THIS implementation (post-M5-06 physics);
 * the M5-06 re-blessed files (loop/movement/game goldens) are NOT touched —
 * this suite is NEW evidence, fixtures-only, spec data via feelFixtures.
 * RE-BLESSED M6-01 (one-time, reason: 'M6 world-state fields'): every
 * committed hashState literal here moves by the §3.4 sector-SoA/globals/
 * arena bytes alone — scenario inputs and player math are unchanged.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { afterEach, describe, expect, it } from 'vitest';

import { FINEMASK, FRACUNIT } from '../../src/core/constants';
import { finesine } from '../../src/core/tables';
import { gTicker, runHeadless } from '../../src/sim/game';
import { GRAVITY, pmoveHookCounts, resetPmoveHookCounts } from '../../src/sim/pmove';
import { MAXBOB, puserGlobals, resetPuserHookCounts } from '../../src/sim/puser';
import { slideState } from '../../src/sim/pslide';
import { VIEWHEIGHT } from '../../src/sim/player';
import { hashState } from '../../src/sim/state';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import type { RectMapSpec } from '../fixtures/mapBuilder';

import {
  ARENA,
  BARREL,
  BIGARENA,
  bootFeel,
  curve,
  fx,
  glide,
  in_,
  LEDGE,
  MARATHON,
  ROOM256,
  setNoclip,
  SLIDECORNER,
  stepRoom,
  STOPSPEED,
  thrustVec,
  T_RUN,
  T_SIDE,
  T_WALK,
  warp,
  fmOracle
} from './feelFixtures';

const fwd: GameInput = in_({ forward: true });

/** Boot the spec TWICE, run the identical script, demand equal hashes
 * (M5-plan §M5-09 acceptance 3: determinism double-run everywhere), then
 * return the state + the (now pinned) hash. */
function scripted(
  spec: RectMapSpec,
  tics: number,
  script: (gametic: number) => GameInput
): { h: number; s: ReturnType<typeof bootFeel> } {
  const s = bootFeel(spec);
  const h = runHeadless(s, tics, script);
  const twin = bootFeel(spec);
  expect(runHeadless(twin, tics, script)).toBe(h);
  return { h, s };
}

afterEach(() => {
  puserGlobals.onground = false; // p_user.c file-scope global hygiene
  resetPuserHookCounts();
  resetPmoveHookCounts();
});

/* ================================================================== */
/* 1. WALK FORWARD — full accel curve, 20/35 tics (ARENA) + 70/140     */
/*    (BIGARENA, wall-free). Derivation: mom ← (mom + T·cos)<<0 × 0xe800 */
/*    per p_mobj.c:241-242; stride = post-thrust momentum. Terminal     */
/*    fixed point T/(1−0.90625) = 546133 ≈ 8.33 u/tic.                  */
/* ================================================================== */

describe('feel-01 walk-forward accel curve', () => {
  const pins: ReadonlyArray<[number, RectMapSpec, number, number]> = [
    [20, ARENA, 2186604783, 39934747],
    [35, ARENA, 3861037851, 47557778],
    [70, BIGARENA, 2288443767, 167172207],
    [140, BIGARENA, 1113780842, 205395002]
  ];
  for (const [tics, spec, hash, pinX] of pins) {
    it(`${tics} tics: hash + per-tic BigInt curve`, () => {
      const startX = spec === ARENA ? 512 << 16 : 2048 << 16;
      const startY = startX;
      const c = curve(tics, startX, startY, () => thrustVec(T_WALK, 0));
      const s = bootFeel(spec);
      for (let t = 0; t < tics; t++) {
        gTicker(s, fwd);
        expect(s.players[0]!.mo.x).toBe(c.x[t]); // lockstep, tic by tic
        expect(s.players[0]!.mo.momx).toBe(c.momx[t]);
      }
      const p = s.players[0]!;
      expect([runHeadlessDoubleRun(spec, tics), p.mo.x]).toEqual([hash, pinX]);
      expect(p.mo.y).toBe(c.y.at(-1));
      // the 1993 tables' angle-0 quirk: 25*2048*65535>>16 = 51199, +19/tic drift
      expect(thrustVec(T_WALK, 0)).toEqual([51199, 19]);
    });
  }
  it('terminal walk momentum converges (never quite 546133)', () => {
    const s = bootFeel(BIGARENA);
    runHeadless(s, 140, () => fwd);
    expect(s.players[0]!.mo.momx).toBeLessThan(546133);
    expect(s.players[0]!.mo.momx).toBeGreaterThan(494000);
  });
});

/** Determinism-checked single hash (scenario 1 uses it inside the table). */
function runHeadlessDoubleRun(spec: RectMapSpec, tics: number): number {
  const a = bootFeel(spec);
  const h = runHeadless(a, tics, () => fwd);
  const b = bootFeel(spec);
  expect(runHeadless(b, tics, () => fwd)).toBe(h);
  return h;
}

/* ================================================================== */
/* 2. WALK-THEN-RELEASE — friction glide + STOPSPEED stop tic.         */
/*    pXYMovement moves by CURRENT mom, then zeroes BOTH axes when     */
/*    |mom| < STOPSPEED 0x1000 (glide oracle = same rule, BigInt).     */
/* ================================================================== */

describe('feel-02 friction glide after release', () => {
  it('20-tic walk + release: glide 4505303, stops at release-tic 49', () => {
    const s = bootFeel(ARENA);
    runHeadless(s, 20, () => fwd);
    const p = s.players[0]!;
    const x0 = p.mo.x;
    const [m0x, m0y] = [p.mo.momx, p.mo.momy];
    expect([m0x, m0y]).toEqual([425816, 154]); // == feel-01 20-tic curve

    let stopTic = -1;
    for (let t = 1; t <= 60; t++) {
      gTicker(s, emptyInput());
      if (stopTic < 0 && p.mo.momx === 0 && p.mo.momy === 0) stopTic = t;
    }
    const g = glide(m0x, m0y); // independent re-derivation
    expect(stopTic).toBe(49); // STOPSPEED stop tic PIN
    expect(g.stopTic).toBe(stopTic);
    expect(p.mo.x - x0).toBe(g.dx); // 4505303 fixed ≈ 68.7 units of glide
    expect(g.dx).toBe(4505303);
    const twin = bootFeel(ARENA);
    runHeadless(twin, 20, () => fwd);
    expect(runHeadless(twin, 60)).toBe(1452708559);
    expect(hashState(s)).toBe(1452708559);
  });
});

/* ================================================================== */
/* 3. RUN (speed button) — same curve at forwardmove 0x32 ⇒ thrust     */
/*    102400; terminal stride ~16.7 u/tic still < MAXMOVE (no split).  */
/* ================================================================== */

describe('feel-03 run (speed) curve', () => {
  it('20 tics run: hash + BigInt curve at thrust 102400', () => {
    const c = curve(20, 512 << 16, 512 << 16, () => thrustVec(T_RUN, 0));
    const { h, s } = scripted(ARENA, 20, () => in_({ forward: true, speed: true }));
    expect(h).toBe(4060847548);
    const p = s.players[0]!;
    expect([p.mo.x, p.mo.momx]).toEqual([c.x.at(-1), c.momx.at(-1)]);
    expect(thrustVec(T_RUN, 0)).toEqual([102398, 39]); // FORWARDMOVE[1]×2048
    expect(p.mo.momx).toBeGreaterThan(2 * 425816 - 100); // ≈ 2× the walk mom
  });
});

/* ================================================================== */
/* 4. STRAFE-ONLY (no turn keys) — thrust on the angle−ANG90 basis     */
/*    (p_user.c:164, unsigned wrap == ANG270 at angle 0), sidemove     */
/*    0x18. Straightness: the cross-axis displacement is ONLY the      */
/*    finecosine[24576] table quirk (±1 fixed per thrust) — pinned.    */
/* ================================================================== */

describe('feel-04 strafe straightness', () => {
  it('strafeRight 20: hash + curve on the angle−90 basis', () => {
    const basis = (0 - (1 << 30)) >>> 0; // 0 − ANG90 ≡ ANG270
    const c = curve(20, 512 << 16, 512 << 16, () => thrustVec(T_SIDE, basis));
    const { h, s } = scripted(ARENA, 20, () => in_({ strafeRight: true }));
    expect(h).toBe(2943759802);
    const p = s.players[0]!;
    expect([p.mo.x, p.mo.y, p.mo.momx, p.mo.momy]).toEqual([
      c.x.at(-1), c.y.at(-1), c.momx.at(-1), c.momy.at(-1)
    ]);
    expect([p.mo.x - (512 << 16), p.mo.y - (512 << 16)]).toEqual([2191, -6125326]);
  });
  it('strafeLeft 20: mirrored hash + drift-free straightness', () => {
    const { h, s } = scripted(ARENA, 20, () => in_({ strafeLeft: true }));
    expect(h).toBe(2980329305);
    const p = s.players[0]!;
    // FixedMul floor-truncation is not bit-mirror: the x-drink is ±2 fixed/tic
    expect([p.mo.x - (512 << 16), p.mo.y - (512 << 16)]).toEqual([-2436, 6125103]);
    // straightness property: cross-axis drift < 1/16 of a pixel over 20 tics
    expect(Math.abs(p.mo.x - (512 << 16))).toBeLessThan(FRACUNIT / 16 + 4);
  });
  it('right-20/left-20 loop: net drift pinned (time-asymmetry, not chaos)', () => {
    const { h, s } = scripted(ARENA, 40, (g) =>
      g < 20 ? in_({ strafeRight: true }) : in_({ strafeLeft: true })
    );
    expect(h).toBe(814650316);
    const p = s.players[0]!;
    // x (cross-axis) cancels to 1107 fixed; y keeps the −57u of geometric
    // asymmetry: momentum reversal decays through the OLD displacement while
    // the reverse thrust ramps — exact for the friction recurrence, hash +
    // the two 20-tic one-way pins above re-derive both legs.
    expect([p.mo.x - (512 << 16), p.mo.y - (512 << 16)]).toEqual([1107, -3751933]);
  });
});

/* ================================================================== */
/* 5. STEP-UP 24 WALL (continuous walk) — P_TryMove rule 4 is          */
/*    `tmfloorz − z > 24*FRACUNIT`: +24 passes (NOT >), +25 blocks.    */
/*    Over/under boundary tics pinned on both sides.                   */
/* ================================================================== */

describe('feel-05 step-up 24 boundary', () => {
  it('over a +24 step: z rises at tic 10 (bbox flush at the line), z+24, squat+recover', () => {
    const s = bootFeel(stepRoom(24));
    let stepTic = -1;
    let snapX = 0;
    let snapVh = 0;
    let snapDvh = 0;
    for (let t = 1; t <= 40; t++) {
      gTicker(s, fwd);
      const p = s.players[0]!;
      if (stepTic < 0 && p.mo.z === 24 * FRACUNIT) {
        stepTic = t;
        snapX = p.mo.x;
        snapVh = p.viewheight;
        snapDvh = p.deltaviewheight;
      }
    }
    const p = s.players[0]!;
    expect(stepTic).toBe(10);
    // analytic boundary: step fires the FIRST tic the bbox reaches the line:
    // x + 16*FRACUNIT ≥ 256*FRACUNIT ⇒ x = 15786154 (> 240<<16 − stride)
    expect(snapX).toBe(15786154);
    expect(snapX + 16 * FRACUNIT).toBeGreaterThanOrEqual(256 * FRACUNIT);
    // pZMovement "smooth step up": viewheight −= floorz−z (=24), dvh = (41−17)>>3
    expect(snapVh).toBe(17 * FRACUNIT);
    expect(snapDvh).toBe((VIEWHEIGHT - 17 * FRACUNIT) >> 3);
    expect(p.mo.z).toBe(24 * FRACUNIT); // z+24 PIN
    const twin = bootFeel(stepRoom(24));
    expect(runHeadless(twin, 40, () => fwd)).toBe(824126521);
    expect(hashState(s)).toBe(824126521);
  });
  it('against a +25 step: blocked flush below 240, z stays 0', () => {
    const { h, s } = scripted(stepRoom(25), 40, () => fwd);
    expect(h).toBe(2075566235);
    const p = s.players[0]!;
    expect(p.mo.z).toBe(0);
    expect(p.mo.x).toBeLessThan(240 * FRACUNIT); // 25 > MAXSTEP ⇒ never mounts
    expect(p.mo.x).toBe(15726973); // last accepted stride (< 240<<16 by 0.025)
    expect(pmoveHookCounts.slideMove).toBeGreaterThan(0); // slide fires, dies on the step line
  });
});

/* ================================================================== */
/* 6. SLIDE ALONG A WALL — 45° approach to the high wall, corner       */
/*    round-trip. Pins the M5-04 follow-up: P_SlideMove never livelocks */
/*    (hitcount reaches 3 = stairstep NEVER in this scenario) and the   */
/*    player ends inside the far room. Derivation: axis-aligned        */
/*    P_HitSlideLine zeroes only the into-wall axis.                    */
/* ================================================================== */

describe('feel-06 45° wall slide + corner round-trip', () => {
  it('150 tics forward: first block tic 20, flush within the 0x800 fudge, corner at tic 46', () => {
    resetPmoveHookCounts();
    const s = bootFeel(SLIDECORNER);
    let firstBlocked = -1;
    let cornerTic = -1;
    let minGap = 1 << 30;
    const hitcounts = new Set<number>();
    for (let t = 1; t <= 150; t++) {
      gTicker(s, fwd);
      hitcounts.add(slideState.hitcount);
      const p = s.players[0]!;
      if (firstBlocked < 0 && pmoveHookCounts.slideMove > 0) firstBlocked = t;
      if (p.mo.y < 112 * FRACUNIT) minGap = Math.min(minGap, 112 * FRACUNIT - p.mo.x);
      if (cornerTic < 0 && p.mo.x > 144 * FRACUNIT && p.mo.y > 128 * FRACUNIT) cornerTic = t;
    }
    const p = s.players[0]!;
    expect(firstBlocked).toBe(20);
    expect(minGap).toBe(10100); // flush: last slide step landed 0.15u shy of 112
    expect(minGap).toBeLessThan(FRACUNIT / 4); // glued to the wall, no tunneling
    expect(cornerTic).toBe(46); // rounded the (128,128) corner into room E
    expect(hitcounts.has(3)).toBe(false); // no stairstep ⇒ NO LIVELOCK
    expect(pmoveHookCounts.slideMove).toBe(112);
    expect([p.mo.x, p.mo.y]).toEqual([25164724, 15727712]); // NE corner of E
    const twin = bootFeel(SLIDECORNER);
    expect(runHeadless(twin, 150, () => fwd)).toBe(546394290);
    expect(hashState(s)).toBe(546394290);
  });
});

/* ================================================================== */
/* 7. FALL 500 INTO THE PIT — walk off the ledge: no damage, landing   */
/*    squat (deltaviewheight = momz>>3), bob resume. Analytic: the     */
/*    discrete gravity parabola drop(k) = G·k(k+3)/2 (momz starts at   */
/*    −2·GRAVITY, p_mobj.c) ⇒ drop ≥ 500 at k = 31; land tic = fall + */
/*    31 EXACTLY. No P_CheckFallDamage exists in 1.10 (M5-plan §0.2).  */
/* ================================================================== */

describe('feel-07 500-unit fall, squat, bob resume', () => {
  it('health untouched, land at fallTic+31, squat −4u then ramp back to 41', () => {
    resetPmoveHookCounts();
    const s = bootFeel(LEDGE);
    let fallTic = -1;
    let landTic = -1;
    let recTic = -1;
    let landDvh = 0;
    for (let t = 1; t <= 120; t++) {
      gTicker(s, fwd);
      const p = s.players[0]!;
      if (fallTic < 0 && p.mo.z > p.mo.floorz) fallTic = t;
      if (landTic < 0 && fallTic > 0 && p.mo.floorz === fx(-500) && p.mo.z === p.mo.floorz) {
        landTic = t;
        landDvh = p.deltaviewheight;
      }
      if (landTic > 0 && recTic < 0 && p.viewheight === VIEWHEIGHT && p.deltaviewheight === 0) recTic = t;
    }
    const p = s.players[0]!;
    expect([fallTic, landTic]).toEqual([22, 53]);
    expect(landTic - fallTic).toBe(31); // k(k+3)/2 ≥ 500 ⇔ k = 31 — analytic
    expect(landDvh).toBe(-4 * FRACUNIT); // momz at landing = −32·G ⇒ >>3 = −4u
    expect(pmoveHookCounts.playSoundOof).toBe(1); // cosmetic oof slot; ZERO hp paths
    expect(p.health).toBe(100); // no fall damage in 1.10 — pinned
    expect(recTic).toBe(73); // squat + FRACUNIT/4 ramp back to 41
    expect(p.mo.z).toBe(fx(-500));
    // bob resumed (walking again → nonzero bob, capped curve intact)
    expect(p.bob).toBeGreaterThan(0);
    // free-fall samples equal the discrete parabola EXACTLY: end of fallTic
    // the floor drops (z still 0), then drop(k) = G·k(k+3)/2 (momz = −2G,−3G…)
    const probe = bootFeel(LEDGE);
    for (let t = 1; t <= 22; t++) gTicker(probe, fwd);
    expect([probe.players[0]!.mo.z, probe.players[0]!.mo.floorz]).toEqual([0, fx(-500)]);
    for (let k = 1; k <= 30; k++) {
      gTicker(probe, fwd);
      expect(probe.players[0]!.mo.z).toBe(-Math.floor((GRAVITY * k * (k + 3)) / 2));
    }
    const twin = bootFeel(LEDGE);
    expect(runHeadless(twin, 120, () => fwd)).toBe(4141819775);
    expect(hashState(s)).toBe(4141819775);
  });
});

/* ================================================================== */
/* 8. BOB 60 TICS — viewz = z + viewheight + FixedMul(bob/2,          */
/*    finesine[(FINEANGLES/20)·leveltime]) with MAXBOB 0x100000 cap.   */
/*    Fully analytic from the momentum curve + the finesine table.     */
/* ================================================================== */

describe('feel-08 bob wave 60 tics', () => {
  it('per-tic viewz == z+41+wave, MAXBOB cap engaged, wave spans 41±8', () => {
    const s = bootFeel(ARENA);
    let mx = 0;
    let my = 0;
    let minV = 1 << 30;
    let maxV = -(1 << 30);
    for (let t = 1; t <= 60; t++) {
      gTicker(s, fwd);
      const p = s.players[0]!;
      const [tx, ty] = thrustVec(T_WALK, 0);
      const strideX = (mx + tx) | 0; // momentum P_CalcHeight sees (post-thrust)
      const strideY = (my + ty) | 0;
      mx = fmOracle(strideX, 0xe800);
      my = fmOracle(strideY, 0xe800);
      let bob = (fmOracle(strideX, strideX) + fmOracle(strideY, strideY)) | 0;
      bob = (bob >> 2) | 0;
      if (bob > MAXBOB) bob = MAXBOB;
      // p_tick order: P_CalcHeight sees leveltime = t−1 (incremented after);
      // `bob/2` is fixed_t division (truncation BEFORE the multiply).
      const wave = fmOracle((bob / 2) | 0, finesine[(409 * (t - 1)) & FINEMASK]!);
      expect(p.viewz).toBe(p.mo.z + VIEWHEIGHT + wave); // exact per-tic wave
      minV = Math.min(minV, p.viewz);
      maxV = Math.max(maxV, p.viewz);
    }
    const p = s.players[0]!;
    expect(p.bob).toBe(MAXBOB); // walking momentum CAPS the bob (0x100000)
    expect([minV, maxV]).toEqual([2162760, 3211152]); // span ⊂ 41±8 (amplitude bob/2 ≤ 8u)
    expect(maxV - VIEWHEIGHT).toBeLessThanOrEqual(MAXBOB / 2);
    expect(minV - VIEWHEIGHT).toBeGreaterThanOrEqual(-MAXBOB / 2);
    const twin = bootFeel(ARENA);
    expect(runHeadless(twin, 60, () => fwd)).toBe(2300162272);
    expect(hashState(s)).toBe(2300162272);
  });
});

/* ================================================================== */
/* 9. TURN WHILE MOVING — thrust angle integrates FIRST (p_user.c     */
/*    order) with the g_game.c turnheld ramp (5 slow tics × 320, then  */
/*    640 while held); glide while turning with no forward. Full       */
/*    BigInt re-derivation of the combined trajectory.                 */
/* ================================================================== */

describe('feel-09 turn-while-moving combined trajectory', () => {
  it('10 fwd, 20 fwd+right, 10 right-only: hash + per-tic angle×thrust curve', () => {
    const script = (g: number): GameInput =>
      g < 10 ? fwd : g < 30 ? in_({ forward: true, turnRight: true }) : in_({ turnRight: true });
    // Oracle: turnheld ramps only while a turn key is held ⇒ slow (320) for
    // tics 11-15 (turnheld 1..5 < 6), 640 for tics 16-40; right = −angle.
    let angle = 0;
    let mx = 0;
    let my = 0;
    let x = 512 << 16;
    let y = 512 << 16;
    for (let t = 0; t < 40; t++) {
      const turn = t < 10 ? 0 : t < 15 ? 320 : 640;
      angle = (angle - ((turn << 16) >>> 0)) >>> 0;
      const [tx, ty] = t < 30 ? thrustVec(T_WALK, angle) : [0, 0];
      const dx = (mx + tx) | 0;
      const dy = (my + ty) | 0;
      x = (x + dx) | 0;
      y = (y + dy) | 0;
      mx = fmOracle(dx, 0xe800);
      my = fmOracle(dy, 0xe800);
    }
    const { h, s } = scripted(ARENA, 40, script);
    expect(h).toBe(3716806388);
    const p = s.players[0]!;
    expect([p.mo.x, p.mo.y]).toEqual([x, y]);
    expect(p.mo.angle).toBe((-(5 * 320 + 25 * 640) << 16) >>> 0); // = 3141533696
    expect(p.mo.angle).toBe(3141533696);
  });
});

/* ================================================================== */
/* 10. NOCLIP MOMENTUM PARITY (D012 regression) — noclip = the SAME    */
/*     physics with the position CHECKS skipped: momentum follows the  */
/*     open-ground curve through the wall, position equals the         */
/*     clipped player until the wall, then keeps going; floorz/ceilz   */
/*     z-seeding still runs (z stays 0 on the flat).                   */
/* ================================================================== */

describe('feel-10 noclip momentum parity (D012)', () => {
  it('wall walk: identical pre-wall positions, same momentum curve, wall at tic 22', () => {
    const n = bootFeel(ROOM256);
    setNoclip(n, true);
    const c = bootFeel(ROOM256);
    const openCurve = curve(30, 128 << 16, 128 << 16, () => thrustVec(T_WALK, 0));
    let crossTic = -1;
    for (let t = 1; t <= 30; t++) {
      gTicker(n, fwd);
      gTicker(c, fwd);
      const pn = n.players[0]!;
      const pc = c.players[0]!;
      expect(pn.mo.momx).toBe(openCurve.momx[t - 1]); // parity THROUGH the wall
      expect(pn.mo.momy).toBe(openCurve.momy[t - 1]);
      if (pc.mo.x === pn.mo.x) expect(pn.mo.x).toBe(openCurve.x[t - 1]); // pre-wall identity
      if (crossTic < 0 && pn.mo.x > 240 * FRACUNIT) crossTic = t;
    }
    expect(crossTic).toBe(22);
    const [pn, pc] = [n.players[0]!.mo, c.players[0]!.mo];
    expect(pn.x).toBe(19768430); // walked 10 units THROUGH the wall
    expect(pn.x).toBeGreaterThan(pc.x);
    expect(pc.x).toBe(15726887); // clipped: pinned flush at 240−16
    expect(n.players[0]!.mo.z).toBe(0); // NOCLIP z-seed still tracks floorz
    const n2 = bootFeel(ROOM256);
    setNoclip(n2, true);
    expect(runHeadless(n2, 30, () => fwd)).toBe(1179467731);
    expect(hashState(n)).toBe(1179467731);
    expect(runHeadlessDoubleRun(ROOM256, 30)).toBe(3771421214); // clipped twin
  });
});

/* ================================================================== */
/* 11. BARREL BLOCK — MF_SOLID thing (doomednum 2035, r10) via         */
/*     thinglinks: the walk stops with the r16 player box never        */
/*     overlapping (|dx| < 26 ⇒ block), flush at 96.875 = last         */
/*     accepted stride BEFORE the 102 boundary; noclip passes through. */
/* ================================================================== */

describe('feel-11 solid thing blocks (barrel)', () => {
  it('non-noclip: flush under the 102 boundary forever; noclip walks through', () => {
    const { h, s } = scripted(BARREL, 40, () => fwd);
    // M7-02 re-bless 1942444525 → 3533663931: mobjs in world state — the
    // barrel is now a live mobj thinker in the arena (payload words + the
    // spawn-time P_Random draw). Positions/momentum below UNCHANGED.
    expect(h).toBe(3533663931);
    const p = s.players[0]!;
    expect(p.mo.x).toBe(6348970);
    expect(p.mo.x).toBeLessThan(102 * FRACUNIT); // bbox right edge < 128−10 ⇒ |dx|<26 never met
    expect(p.mo.momx).toBeGreaterThan(400000); // momentum KEPT building while pinned

    const n = bootFeel(BARREL);
    setNoclip(n, true);
    const hn = runHeadless(n, 40, () => fwd);
    const n2 = bootFeel(BARREL);
    setNoclip(n2, true);
    expect(runHeadless(n2, 40, () => fwd)).toBe(hn);
    // M7-02 re-bless 436575480 → 641724918: mobjs in world state (same
    // reason as the pinned branch above; the walk-through path itself is
    // byte-identical — x below unchanged).
    expect(hn).toBe(641724918);
    expect(n.players[0]!.mo.x).toBe(20862794); // past the barrel, past the room
  });
});

/* ================================================================== */
/* 12. LOW CORRIDOR — P_TryMove rule 1 (`tmceilingz − tmfloorz <      */
/*     height`) boundary: ceiling 56 == player height walks EXACTLY   */
/*     like open ground (56 < 56 is false); ceiling 55 freezes the    */
/*     player at the spawn (every move fails rule 1; z even clips to   */
/*     ceilingz−height under the crush). viewz clamp ceilingz−4 is     */
/*     provably dormant in any ≥56-clearance space (z+41+8 ≤ f+49 <    */
/*     f+52) — pinned via the never-exceed assert.                     */
/* ================================================================== */

describe('feel-12 low ceiling rule-1 boundary + viewz clamp', () => {
  const low = (ceil: number): RectMapSpec => ({
    rooms: [{ x: 0, y: 0, w: 512, h: 128, ceilingHeight: ceil, lightLevel: 200 }],
    things: [{ x: 32, y: 64, angle: 0, type: 1 }]
  });
  it('ceiling 56 walkable: x == the open-ground curve, viewz never past 52', () => {
    const c = curve(60, 32 << 16, 64 << 16, () => thrustVec(T_WALK, 0));
    const s = bootFeel(low(56));
    let maxV = -(1 << 30);
    for (let t = 0; t < 60; t++) {
      gTicker(s, fwd);
      expect(s.players[0]!.mo.x).toBe(c.x[t]); // rule-1 boundary costs NOTHING
      maxV = Math.max(maxV, s.players[0]!.viewz);
    }
    expect(maxV).toBeLessThanOrEqual(52 * FRACUNIT); // viewz ≤ ceilingz−4 clamp bound
    expect(maxV).toBe(3211152); // wave peak < 49u ⇒ the clamp is provably dormant (header)
    const twin = bootFeel(low(56));
    expect(runHeadless(twin, 60, () => fwd)).toBe(2570629723);
    expect(hashState(s)).toBe(2570629723);
  });
  it('ceiling 55: frozen at the spawn (rule 1 blocks every move)', () => {
    const { h, s } = scripted(low(55), 60, () => fwd);
    expect(h).toBe(4145970399);
    const p = s.players[0]!;
    expect(p.mo.x).toBe(32 << 16); // never moved
    expect(p.mo.z).toBe(-1 * FRACUNIT); // z clipped to ceilingz−height (55−56)
    expect(pmoveHookCounts.slideMove).toBeGreaterThan(0); // blocked ⇒ slide tried, no line helps
  });
});

/* ================================================================== */
/* 13. MARATHON 2000-TIC ROUTE — deterministic scripted route crossing */
/*     every M5 movement surface: walls (slides), the +24 step, the    */
/*     −64 ledge (air + landing squat), strafe/run/turn phases.        */
/*     Double-run stability + one HASH-ONLY route pin (2000 tics of   */
/*     interleaved collisions defy a closed-form oracle by design;     */
/*     every leg it interleaves is analytic in scenarios 1-12).        */
/* ================================================================== */

describe('feel-13 marathon 2000-tic route', () => {
  const phases: ReadonlyArray<[number, GameInput]> = [
    [200, fwd],
    [14, in_({ turnLeft: true })],
    [150, in_({ backward: true, speed: true })],
    [300, emptyInput()],
    [600, in_({ forward: true, turnRight: true })],
    [300, fwd],
    [336, in_({ strafeRight: true, speed: true })]
  ];
  const script = (g: number): GameInput => {
    let r = g;
    for (const [len, inp] of phases) {
      if (r < len) return inp;
      r -= len;
    }
    return emptyInput(); // unreachable: phases sum to 1900 + 100 idle tail
  };
  it('double-run stable + covers step-up, ledge fall, oof, slides', () => {
    resetPmoveHookCounts();
    const s = bootFeel(MARATHON);
    let airTics = 0;
    let maxFloor = -(1 << 30);
    let minFloor = 1 << 30;
    for (let t = 0; t < 2000; t++) {
      gTicker(s, script(t));
      const p = s.players[0]!;
      if (p.mo.z > p.mo.floorz) airTics++;
      maxFloor = Math.max(maxFloor, p.mo.floorz);
      minFloor = Math.min(minFloor, p.mo.floorz);
    }
    expect(maxFloor).toBe(24 * FRACUNIT); // stepped up into the +24 room
    expect(minFloor).toBe(-64 * FRACUNIT); // dropped into the −64 pit
    expect(airTics).toBe(16); // one ledge fall: k(k+3)/2 ≥ 64 ⇔ k = 10…16 tics air
    expect(pmoveHookCounts.playSoundOof).toBe(1); // landed (hard, squat) once
    expect(pmoveHookCounts.slideMove).toBeGreaterThan(500); // walls were slid on
    const h = hashState(s);
    const twin = bootFeel(MARATHON);
    expect(runHeadless(twin, 2000, script)).toBe(h);
    expect(h).toBe(2916867642);
  });
});

/* ================================================================== */
/* Sanity: the warp helper matches a real spawn (no invisible state).  */
/* ================================================================== */

describe('feel-harness sanity', () => {
  it('warp = P_TeleportMove semantics: floor-snapped z, thinglinks updated', () => {
    const s = bootFeel(ARENA);
    warp(s, 700, 700);
    const p = s.players[0]!;
    expect([p.mo.x, p.mo.y, p.mo.z, p.mo.floorz]).toEqual([
      700 * FRACUNIT, 700 * FRACUNIT, 0, 0
    ]);
    expect(s.players[0]!.mo.momx).toBe(0);
  });
  it('constants used by the oracles are the 1993 values', () => {
    expect(T_WALK).toBe(0x19 * 2048);
    expect(T_RUN).toBe(0x32 * 2048);
    expect(T_SIDE).toBe(0x18 * 2048);
    expect(STOPSPEED).toBe(0x1000);
  });
});
