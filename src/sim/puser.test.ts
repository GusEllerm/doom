/**
 * sim/puser tests (M5-06) — p_user.c physics end-to-end through gTicker
 * (P_PlayerThink → P_XYMovement/P_ZMovement in p_tick.c order), dual-pinned
 * against independent BigInt re-derivations of the friction/thrust/bob
 * curves (M5-plan §M5-06 acceptance).
 *
 * Curve math (from the sources, NOT from this implementation):
 *   per tic (P_PlayerThink thrust → P_CalcHeight → thinker move+friction),
 *   with momentum m and the 1993 tables (finesine[0]=25, finecosine[0]=65535):
 *     mom += FixedMul(T, trig[ang>>19])             (P_Thrust)
 *     stride = mom (post-thrust)                    (the bob input too)
 *     x += stride                                   (single substep < MAXMOVE/2)
 *     mom = FixedMul(mom, 0xe800)                   (friction, per axis)
 *   Terminal stride = T / (1 − 0.90625) = 546133 ≈ 8.33 units/tic (walk).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ANG45, ANG90, ANG270, FINEMASK, FRACUNIT } from '../core/constants';
import { finecosine, finesine } from '../core/tables';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';

import { gInitGame, gTicker } from './game';
import { buildMapFromData } from './map';
import { pTeleportMove } from './pmap';
import { GRAVITY, pmoveHookCounts, resetPmoveHookCounts } from './pmove';
import { pCalcHeight, pThrust, puserGlobals, resetPuserHookCounts } from './puser';
import {
  CF_NOCLIP,
  createPlayer,
  MF_NOGRAVITY,
  MOVE_THRUST_SCALE,
  VIEWHEIGHT
} from './player';
import { hashState, type GameState } from './state';
import { emptyInput, FORWARDMOVE, SIDEMOVE, type GameInput } from './ticcmd';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const fx = (n: number): number => (n * FRACUNIT) | 0;

/** BigInt oracle of core/fixed FixedMul: exact product, arithmetic >>16, low 32. */
function fixedMulOracle(a: number, b: number): number {
  return Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
}

const FM = 0xe800; // FRICTION
const T_WALK = FORWARDMOVE[0] * MOVE_THRUST_SCALE; // 51200
const T_RUN = FORWARDMOVE[1] * MOVE_THRUST_SCALE; // 102400
// angle-0 thrust vectors straight from the tables (the 1993 tables give the
// east stride a +19 low-bit y drift — this is vanilla, pinned by M2 goldens):
const THRUST_WALK_X = fixedMulOracle(T_WALK, finecosine[0]!); // 51199
const THRUST_WALK_Y = fixedMulOracle(T_WALK, finesine[0]!); // 19

function boot(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

/** debug-warp semantics: real P_TeleportMove + destination-floor z. */
function warp(s: GameState, xUnits: number, yUnits: number, zUnits?: number): void {
  const p = s.players[0]!;
  pTeleportMove(s.pmap, p.mo, fx(xUnits), fx(yUnits));
  p.mo.z = zUnits === undefined ? p.mo.floorz : fx(zUnits);
}

const input = (over: Partial<GameInput>): GameInput => ({ ...emptyInput(), ...over });

/** Walk curve from spawn (angle 0): returns per-tic {mx,my,x,y} post-friction. */
function walkCurve(
  tics: number,
  startX: number,
  startY: number,
  thrustX = THRUST_WALK_X,
  thrustY = THRUST_WALK_Y
): { momx: number; momy: number; x: number; y: number; histX: number[] } {
  let mx = 0;
  let my = 0;
  let x = startX;
  let y = startY;
  const histX: number[] = [];
  for (let t = 0; t < tics; t++) {
    x = (x + mx + thrustX) | 0; // stride = post-thrust momentum
    y = (y + my + thrustY) | 0;
    mx = fixedMulOracle((mx + thrustX) | 0, FM);
    my = fixedMulOracle((my + thrustY) | 0, FM);
    histX.push(x);
  }
  return { momx: mx, momy: my, x, y, histX };
}

/** Open friction arena (spawn mid-room so nothing ever blocks; NO default
 * dot item — the M5-02 thinglinks barrel is MF_SOLID and would park ON the
 * spawn; ceiling 400 so fall tests can warp high without a ceiling bump). */
const ARENA: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 1024, h: 1024, ceilingHeight: 400, lightLevel: 200 }],
  things: [{ x: 512, y: 512, angle: 0, type: 1 }]
};
/** A[0..128] spawn corridor | pit B[128..256] floor −8 (east walk). */
const PIT: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 128, lightLevel: 200 },
    { x: 128, y: 0, w: 128, h: 128, lightLevel: 200, floorHeight: -8 }
  ],
  things: [{ x: 32, y: 64, angle: 0, type: 1 }]
};
/** Low-but-walkable corridor: ceiling 56 == player height (the classic
 * low-clearance case; a SHORTER room is impassable — P_TryMove rule 1). */
const LOW: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 512, h: 128, ceilingHeight: 56, lightLevel: 200 }],
  things: [{ x: 32, y: 64, angle: 0, type: 1 }]
};
/** A[0..126] | solid wall B[126..142] (floor=ceiling=0) | C[142..300]. */
const WALLED: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 126, h: 128, lightLevel: 200 },
    { x: 126, y: 0, w: 16, h: 128, lightLevel: 200, ceilingHeight: 0 },
    { x: 142, y: 0, w: 158, h: 128, lightLevel: 200 }
  ],
  things: [{ x: 32, y: 64, angle: 0, type: 1 }]
};

afterEach(() => {
  puserGlobals.onground = false; // reset the p_user.c file-scope global
  resetPuserHookCounts();
  resetPmoveHookCounts();
});

/* ------------------------------------------------------------------ */
/* P_Thrust — p_user.c:57-68 vector set                                */
/* ------------------------------------------------------------------ */

describe('P_Thrust (finecosine/finesine basis, p_user.c verbatim)', () => {
  it('mom += FixedMul(move, trig[angle>>19]); position NEVER touched', () => {
    for (const angle of [0, ANG90, ANG45, ANG270, 0xffffffff >>> 0]) {
      const p = createPlayer();
      pThrust(p, angle, T_WALK);
      const fine = angle >>> 19;
      expect(p.mo.momx, `momx @${angle >>> 0}`).toBe(fixedMulOracle(T_WALK, finecosine[fine]!));
      expect(p.mo.momy, `momy @${angle >>> 0}`).toBe(fixedMulOracle(T_WALK, finesine[fine]!));
      expect(p.mo.x + p.mo.y).toBe(0);
    }
    // committed spot values (east: the 65535-table quirk + the +19 drift):
    const e = createPlayer();
    pThrust(e, 0, T_WALK);
    expect([e.mo.momx, e.mo.momy]).toEqual([51199, 19]);
    const n = createPlayer();
    pThrust(n, ANG90, T_WALK);
    expect([n.mo.momx, n.mo.momy]).toEqual([-20, 51199]);
  });

  it('strafe basis angle−ANG90 wraps u32 identically to +ANG270 (p_user.c:164)', () => {
    const a = createPlayer();
    const b = createPlayer();
    pThrust(a, (0 - ANG90) >>> 0, SIDEMOVE[0] * MOVE_THRUST_SCALE);
    pThrust(b, ANG270, SIDEMOVE[0] * MOVE_THRUST_SCALE);
    expect([b.mo.momx, b.mo.momy]).toEqual([a.mo.momx, a.mo.momy]);
  });
});

/* ------------------------------------------------------------------ */
/* Walk/run friction curves (M5-plan §M5-06 acceptance 1)              */
/* ------------------------------------------------------------------ */

describe('walk acceleration curve to the 546133 asymptote', () => {
  it('20 tics of walk: mom/x/y match the BigInt curve exactly', () => {
    const s = boot(ARENA);
    for (let t = 0; t < 20; t++) gTicker(s, input({ forward: true }));
    const p = s.players[0]!;
    const c = walkCurve(20, 512 << 16, 512 << 16);
    expect(p.mo.momx).toBe(c.momx);
    expect(p.mo.momy).toBe(c.momy);
    expect(p.mo.x).toBe(c.x);
    expect(p.mo.y).toBe(c.y);
    // committed golden (independent of the oracle helper):
    expect([p.mo.x, p.mo.y, p.mo.momx, p.mo.momy]).toEqual([
      39934747, 33556735, 425816, 154
    ]);
  });

  it('terminal momx: friction fixed point reached (walk 60 tics, run 35)', () => {
    const s = boot(ARENA);
    const r = boot(ARENA);
    let m = 0;
    for (let t = 0; t < 60; t++) {
      gTicker(s, input({ forward: true }));
      m = fixedMulOracle((m + THRUST_WALK_X) | 0, FM);
    }
    expect(s.players[0]!.mo.momx).toBe(m); // recurrence == engine, step for step
    expect(m).toBe(493572); // converging toward 495232 (never quite reached)
    // run 35 tics stay inside the 1024 arena (terminal stride would hit the
    // wall by tic ~45); stride > MAXMOVE/2 exercises the half-split loop.
    let mrun = 0;
    for (let t = 0; t < 35; t++) {
      gTicker(r, input({ forward: true, speed: true }));
      mrun = fixedMulOracle((mrun + fixedMulOracle(T_RUN, finecosine[0]!)) | 0, FM);
    }
    expect(r.players[0]!.mo.momx).toBe(mrun);
  });

  it('release stops dead after the 0.90625 decay (< STOPSPEED ⇒ mom = 0)', () => {
    const s = boot(ARENA);
    for (let t = 0; t < 20; t++) gTicker(s, input({ forward: true }));
    const x0 = s.players[0]!.mo.x;
    const y0 = s.players[0]!.mo.y;
    for (let t = 0; t < 60; t++) gTicker(s, emptyInput());
    const p = s.players[0]!;
    expect([p.mo.momx, p.mo.momy]).toEqual([0, 0]); // STOPSPEED zeroing

    // Glide re-derived from the exact stop rule: the tic moves by CURRENT
    // mom first (pXYMovement moves before its friction test), then either
    // friction (any axis ≥ STOPSPEED) or the instant zeroing.
    const c = walkCurve(20, 0, 0);
    let gx = c.momx;
    let gy = c.momy;
    let total = 0;
    while (gx !== 0 || gy !== 0) {
      total = (total + gx) | 0;
      if (Math.abs(gx) < 0x1000 && Math.abs(gy) < 0x1000) {
        gx = 0;
        gy = 0;
      } else {
        gx = fixedMulOracle(gx, FM);
        gy = fixedMulOracle(gy, FM);
      }
    }
    expect(p.mo.x - x0).toBe(total); // ~35 units of glide
    void y0;
  });
});

/* ------------------------------------------------------------------ */
/* Strafe + turn-and-move                                              */
/* ------------------------------------------------------------------ */

describe('strafe pair vectors + turn+move combined', () => {
  it('strafeRight/strafeLeft mirror within ±1 (angle−ANG90 basis, floor-trunc)', () => {
    const a = boot(ARENA);
    const b = boot(ARENA);
    for (let t = 0; t < 10; t++) {
      gTicker(a, input({ strafeRight: true }));
      gTicker(b, input({ strafeLeft: true }));
    }
    const pa = a.players[0]!.mo;
    const pb = b.players[0]!.mo;
    // FixedMul floor-truncation is asymmetric (fxm(−x,F) = fxm(x,F) with a
    // −1 tail per odd step → bounded geometric drift), not bit-mirror:
    expect(Math.abs(pa.x + pb.x - 2 * (512 << 16))).toBeLessThanOrEqual(256);
    expect(Math.abs(pa.y + pb.y - 2 * (512 << 16))).toBeLessThanOrEqual(256);
    expect(Math.abs(pa.momx + pb.momx)).toBeLessThanOrEqual(16);
    expect(Math.abs(pa.momy + pb.momy)).toBeLessThanOrEqual(16);
  });

  it('turn+forward 35 tics: thrust angle integrates FIRST, curve per-tic', () => {
    const s = boot(ARENA);
    for (let t = 0; t < 35; t++) gTicker(s, input({ forward: true, turnRight: true }));
    const p = s.players[0]!;

    // Re-derivation: G_BuildTiccmd turnheld ramp (5×320 then 640, right =
    // negative) + p_user.c order (angle first, then thrust at NEW angle).
    let angle = 0;
    let mx = 0;
    let my = 0;
    let x = 512 << 16;
    let y = 512 << 16;
    for (let t = 0; t < 35; t++) {
      angle = (angle + ((-(t < 5 ? 320 : 640)) << 16)) >>> 0;
      const dx = (mx + fixedMulOracle(T_WALK, finecosine[angle >>> 19]!)) | 0;
      const dy = (my + fixedMulOracle(T_WALK, finesine[angle >>> 19]!)) | 0;
      x = (x + dx) | 0;
      y = (y + dy) | 0;
      mx = fixedMulOracle(dx, FM);
      my = fixedMulOracle(dy, FM);
    }
    expect(p.mo.x).toBe(x);
    expect(p.mo.y).toBe(y);
    expect(p.mo.angle).toBe(2931818496);
  });
});

/* ------------------------------------------------------------------ */
/* Bob / viewheight (P_CalcHeight)                                     */
/* ------------------------------------------------------------------ */

describe('P_CalcHeight bob + viewheight (M5-plan §0.7)', () => {
  it('standing: bob == 0, viewz == z + 41*FRACUNIT (no wave)', () => {
    const s = boot(ARENA);
    for (let t = 0; t < 10; t++) gTicker(s, emptyInput());
    const p = s.players[0]!;
    expect(p.bob).toBe(0);
    expect(p.viewheight).toBe(VIEWHEIGHT);
    expect(p.viewz).toBe(p.mo.z + VIEWHEIGHT);
    expect(p.viewz).toBe(41 * FRACUNIT); // FIX floors are 0
  });

  it('walking 60 tics: viewz wave == z+41+FixedMul(bob/2, finesine[409*t&8191])', () => {
    const s = boot(ARENA);
    let mx = 0;
    let my = 0;
    let maxBob = 0;
    for (let t = 0; t < 60; t++) {
      gTicker(s, input({ forward: true }));
      const p = s.players[0]!;
      const sx = (mx + THRUST_WALK_X) | 0; // momentum P_CalcHeight sees
      const sy = (my + THRUST_WALK_Y) | 0;
      mx = fixedMulOracle(sx, FM);
      my = fixedMulOracle(sy, FM);
      let bob = (fixedMulOracle(sx, sx) + fixedMulOracle(sy, sy)) | 0;
      bob = (bob >> 2) | 0;
      if (bob > 0x100000) bob = 0x100000;
      maxBob = Math.max(maxBob, bob);
      const angle = Math.imul(409, t) & FINEMASK; // (FINEANGLES/20*leveltime)&FINEMASK
      const bob2 = fixedMulOracle((bob / 2) | 0, finesine[angle]!); // C trunc div
      expect(p.bob, `bob t=${t}`).toBe(bob);
      expect(p.viewz, `viewz t=${t}`).toBe((p.mo.z + VIEWHEIGHT + bob2) | 0);
    }
    expect(maxBob).toBe(0x100000); // the MAXBOB cap is reached while running…
    // amplitude spot values (table re-derivation, engine-free):
    // (the 1993 table's sin 90° cell is 65535, not 65536 — 8 units minus 1)
    expect(fixedMulOracle(0x100000 / 2, finesine[2048]!)).toBe(524280);
    expect(fixedMulOracle(0x100000 / 2, finesine[6144]!)).toBe(-524280);
    expect(fixedMulOracle(0x100000 / 2, finesine[0]!)).toBe((8 * 25) | 0); // sin(0)=25/65536
  });

  it('bob caps at MAXBOB 0x100000 for absurd momentum (direct)', () => {
    const p = createPlayer();
    p.mo.momx = 30 * FRACUNIT;
    p.mo.momy = 30 * FRACUNIT;
    p.mo.ceilingz = 128 * FRACUNIT;
    puserGlobals.onground = true;
    pCalcHeight(p, 0);
    expect(p.bob).toBe(0x100000);
  });

  it('viewz stays below the ceiling in the low (56-high) corridor', () => {
    const s = boot(LOW);
    for (let t = 0; t < 30; t++) {
      gTicker(s, input({ forward: true, speed: true }));
      const p = s.players[0]!;
      // The ceilingz−4 clamp line is a DEFENSIVE guard: pTryMove/pZMovement
      // already guarantee z ≤ ceilingz−56, and viewheight+bob ≤ 41+8 keeps
      // viewz ≤ ceilingz−7 — it can only fire on an inconsistent z.
      expect(p.viewz, `t=${t}`).toBeLessThanOrEqual(p.mo.ceilingz - 4 * FRACUNIT);
      expect(p.mo.x, `walks normally t=${t}`).toBeGreaterThan(32 * FRACUNIT);
    }
  });

  it('the clamp fires when fed an inconsistent z (direct guard)', () => {
    const p = createPlayer();
    p.mo.z = 124 * FRACUNIT; // z + 41 would be 165…
    p.mo.ceilingz = 128 * FRACUNIT;
    puserGlobals.onground = true;
    pCalcHeight(p, 5); // 409*5 = 2045 ≈ sin 90° → tiny positive bob add
    expect(p.viewz).toBe(p.mo.ceilingz - 4 * FRACUNIT); // clamped: 128−4 = 124
  });
});

/* ------------------------------------------------------------------ */
/* Ground / fall / land (onground gate, squat, dropoff)                 */
/* ------------------------------------------------------------------ */

describe('onground gate + P_ZMovement integration', () => {
  it('airborne: NO thrust at all, gravity parabola −2,−3,…, landing snaps z', () => {
    const s = boot(ARENA);
    warp(s, 512, 512, 100);
    const p = s.players[0]!;
    let momz = 0;
    let z = 100 * FRACUNIT;
    for (let t = 0; t < 14; t++) {
      gTicker(s, input({ forward: true, speed: true }));
      // P_ZMovement order: z += momz FIRST (momz is 0 on the first tic →
      // z unchanged), floor test, THEN the gravity start/update.
      z = (z + momz) | 0;
      if (z <= 0) {
        z = 0;
        momz = 0;
      } else {
        momz = momz === 0 ? -2 * GRAVITY : (momz - GRAVITY) | 0;
      }
      expect(p.mo.z, `t=${t}`).toBe(z);
      expect(p.mo.momx, `no air thrust t=${t}`).toBe(0);
      if (z === 0) break;
    }
    expect(p.mo.z).toBe(0);
    expect(p.mo.momz).toBe(0);
  });

  it('landing from 100 units: squat golden deltaviewheight=momz>>3, NO damage, one oof', () => {
    const s = boot(ARENA);
    warp(s, 512, 512, 100);
    let t = 0;
    do {
      gTicker(s, emptyInput());
      t++;
    } while ((s.players[0]!.mo.z > s.players[0]!.mo.floorz || s.players[0]!.mo.momz !== 0) && t < 100);
    const p = s.players[0]!;
    expect(t).toBe(14); // z(t) = 100 − Σ(2..t) ≤ 0 first at t=14 (−4 < 0)
    expect(p.mo.z).toBe(0);
    expect(p.health).toBe(100); // vanilla has NO fall damage
    expect(p.deltaviewheight).toBe((-14 * FRACUNIT) >> 3); // = −114688 (pinned)
    expect(p.viewheight).toBe(VIEWHEIGHT); // squat applies NEXT P_CalcHeight
    gTicker(s, emptyInput());
    expect(p.viewheight).toBe(VIEWHEIGHT - 114688); // squatting
    expect(pmoveHookCounts.playSoundOof).toBe(1);
  });

  it('dropoff → fall → land → bob resumes: 40-tic walk-off-the-ledge', () => {
    const s = boot(PIT);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let t = 0; t < 40; t++) {
      gTicker(s, input({ forward: true }));
      xs.push(s.players[0]!.mo.x);
      zs.push(s.players[0]!.mo.z);
    }
    const p = s.players[0]!;

    // Phase 1 (grounded) re-derived: walk curve from (32,64).
    const c = walkCurve(11, 32 << 16, 64 << 16);
    expect(xs[10]).toBe(c.histX[10]!); // still ON the ledge at tic 11
    expect(zs[10]).toBe(0);
    expect(s.players[0]!.mo.x > 200 * FRACUNIT).toBe(true); // crossed the pit

    // Phase 2/3: over the edge at some tic e (floorz −8 first reads ≤ x−16
    // past 128): z strictly decreasing while falling, lands exactly on −8:
    const zLand = zs.findIndex((z) => z === -8 * FRACUNIT);
    expect(zLand).toBe(24);
    for (let t = 13; t < zLand; t++)
      if (zs[t]! < 0) expect(zs[t]! < zs[t - 1]!, `falling t=${t}`).toBe(true);
    expect(p.mo.z).toBe(-8 * FRACUNIT);
    expect(p.mo.momz).toBe(0);
    expect(p.health).toBe(100);

    // Phase 4: momentum never froze mid-fall in x (thrust gate aside —
    // momx was frozen at the ledge value while airborne, then resumed).
    expect(p.mo.z).toBe(-8 * FRACUNIT);
    expect(p.bob).toBeGreaterThan(0); // bob resuming — still walking on ice…
    expect(p.deltaviewheight).toBeGreaterThanOrEqual(0); // soft landing: no squat
    // committed spots (from THIS implementation; phase logic derived above;
    // t≈34 the pit's FAR wall slides away the x momentum — see WALLED test):
    expect(xs[0]).toBe((32 << 16) + 51199); // first stride = table thrust
    expect(zs[24]).toBe(-8 * FRACUNIT); // landed on the pit floor at tic 25
    expect(Math.abs(p.mo.y - (64 << 16))).toBeLessThan(FRACUNIT); // +19 drift only
  });

  it('onground false ⇒ P_CalcHeight takes the no-wave branch (viewz = z+viewheight)', () => {
    const s = boot(ARENA);
    warp(s, 512, 512, 100);
    gTicker(s, emptyInput());
    const p = s.players[0]!;
    expect(p.bob).toBe(0);
    // P_CalcHeight ran BEFORE this tic's ZMovement — z was still 100 there:
    expect(p.viewz).toBe((100 * FRACUNIT + VIEWHEIGHT) | 0);
  });
});

/* ------------------------------------------------------------------ */
/* noclip = vanilla semantics (D009 closure / D012)                    */
/* ------------------------------------------------------------------ */

describe('noclip true semantics (no fly branch — physics identical)', () => {
  it('empty map: noclip ON vs OFF ⇒ identical mom/x/y/viewz every tic', () => {
    const on = boot(ARENA);
    const off = boot(ARENA);
    on.players[0]!.cheats |= CF_NOCLIP;
    for (let t = 0; t < 40; t++) {
      const cmd = input({ forward: true, strafeRight: t % 3 === 0, speed: t > 20 });
      gTicker(on, cmd);
      gTicker(off, cmd);
      const a = on.players[0]!;
      const b = off.players[0]!;
      expect([a.mo.momx, a.mo.momy, a.mo.x, a.mo.y, a.viewz]).toEqual([
        b.mo.momx,
        b.mo.momy,
        b.mo.x,
        b.mo.y,
        b.viewz
      ]);
    }
    expect(on.players[0]!.mo.x).toBe(off.players[0]!.mo.x); // never blocked — identical
  });

  it('wall: clipped stops/slides, noclip keeps the SAME curve and passes through', () => {
    const off = boot(WALLED);
    const on = boot(WALLED);
    on.players[0]!.cheats |= CF_NOCLIP;
    for (let t = 0; t < 10; t++) {
      gTicker(off, input({ forward: true }));
      gTicker(on, input({ forward: true }));
    }
    expect(on.players[0]!.mo.momx).toBe(off.players[0]!.mo.momx); // pre-wall identical
    for (let t = 0; t < 30; t++) {
      gTicker(off, input({ forward: true }));
      gTicker(on, input({ forward: true }));
    }
    expect(on.players[0]!.mo.x).toBeGreaterThan(142 * FRACUNIT); // through the wall
    expect(off.players[0]!.mo.x).toBeLessThan(126 * FRACUNIT); // blocked + slid
    expect(on.players[0]!.mo.flags & MF_NOGRAVITY).toBe(MF_NOGRAVITY);
    expect(on.players[0]!.mo.z).toBe(0); // noclip never falls (D012 mirror)
  });

  it('noclip z still tracks floors (CheckPosition seeds BEFORE its early return)', () => {
    const s = boot(PIT);
    s.players[0]!.cheats |= CF_NOCLIP;
    warp(s, 200, 64); // over the pit sector (floor −8), lifted to stay free
    s.players[0]!.mo.z = 0;
    expect(s.players[0]!.mo.floorz).toBe(-8 * FRACUNIT);
    for (let t = 0; t < 10; t++) gTicker(s, emptyInput());
    expect(s.players[0]!.mo.z).toBe(0); // NOGRAVITY: never falls, floor tracked
    expect(s.players[0]!.viewz).toBe(VIEWHEIGHT);
  });
});

/* ------------------------------------------------------------------ */
/* Reactiontime + 1000-tic marathon                                    */
/* ------------------------------------------------------------------ */

describe('reactiontime + 1000-tic stability with physics ON', () => {
  it('MT_PLAYER reactiontime 0: spawn is never frozen (info.c:1114)', () => {
    const s = boot(ARENA);
    expect(s.players[0]!.mo.reactiontime).toBe(0);
    gTicker(s, input({ forward: true }));
    expect(s.players[0]!.mo.momx).toBe(fixedMulOracle(THRUST_WALK_X, FM)); // post-friction
  });

  it('1000-tic walk/run/turn marathon hash: double-run stable', () => {
    const scripted = (g: number): GameInput =>
      g % 7 === 0
        ? input({ turnRight: true })
        : g % 3 === 0
          ? input({ backward: true })
          : g % 11 === 0
            ? input({ forward: true, speed: true })
            : input({ forward: true });
    const run = (): number => {
      const s = boot(ARENA);
      for (let i = 0; i < 1000; i++) gTicker(s, scripted(s.gametic));
      return hashState(s);
    };
    const h1 = run();
    const h2 = run();
    expect(h1).toBe(h2);
  });

  const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
  it.skipIf(!existsSync(WAD_PATH))('freedoom1 E1M1 1000-tic clipped walk: double-run stable', () => {
    const bytes = readFileSync(WAD_PATH);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer;
    const mk = () => gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
    const script = (g: number): GameInput =>
      g % 5 < 3 ? input({ forward: true }) : input({ turnRight: true });
    const run = (): number => {
      const s = mk();
      for (let i = 0; i < 1000; i++) gTicker(s, script(s.gametic));
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});
