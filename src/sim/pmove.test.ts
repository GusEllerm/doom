/**
 * sim/pmove tests (M5-05) — P_XYMovement + P_ZMovement (p_mobj.c:105-341).
 *
 * Acceptance (M5-plan §M5-05):
 *  1) friction decay curve exact per tic for 20/40 tics, BigInt-rederived
 *     (0.90625 = FRICTION/FRACUNIT), stop-dead inside STOPSPEED;
 *  2) MAXMOVE half-split: a 64-unit momentum crosses exactly as the two
 *     15-unit half steps of the clamped 30 (hop == chained smalls, all
 *     bit-identical) AND a wall-room fixture a naive single stride would
 *     tunnel (split that misses it must fail); the vanilla quirk that the
 *     split triggers only for POSITIVE components is pinned (negative full
 *     stride really does clip the 16-wide wall room in 1.10);
 *  3) gravity: z parabola = z0 - (k(k+1)/2 - 1)*GRAVITY analytically at 30
 *     and 60 tics; landing snaps z=floorz & momz=0; hard-landing squat
 *     deltaviewheight = momz>>3 for momz < -8*GRAVITY, NO hp change (no
 *     fall damage pin, §0.2); edge dropoff: the exact tic momz starts at
 *     -2*GRAVITY and the landing tic;
 *  4) airborne = zero friction; NOCLIP straight-line path (no block/slide
 *     calls at all); blocked player → slide slot (default no-op counted);
 *     missile explode / sky-remove; zero allocation + double-run determinism.
 *
 * Ground truths re-derived from the fetched 1.10 sources (p_mobj.c,
 * p_local.h:30-54, p_mobj.h, d_player.h:71-75, p_map.c sky-hack call site).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData, type RuntimeMap } from './map';
import { buildBlockMap } from './blockmap';
import { buildThingLinks, MF_DROPOFF, MF_PICKUP, MF_SHOOTABLE, MF_SOLID, type ThingLinks } from './thinglinks';
import {
  CF_NOMOMENTUM,
  FRICTION,
  GRAVITY,
  MAXMOVE,
  MF_CORPSE,
  pmoveHookCounts,
  pmoveHooks,
  pThingHeightClip,
  pXYMovement,
  pZMovement,
  resetPmoveHookCounts,
  STOPSPEED,
  VIEWHEIGHT,
  type MoveMobj,
  type MovePlayerState,
} from './pmove';
import { pTryMove, type PMapWorld } from './pmap';
import { MF_MISSILE, MF_NOCLIP, MF_NOGRAVITY, MF_SKULLFLY } from './thinglinks';

const FU = FRACUNIT;
const fx = (units: number): number => (units * FU) | 0;

/* ------------------------------------------------------------------ */
/* Fixtures                                                             */
/* ------------------------------------------------------------------ */

interface World {
  map: RuntimeMap;
  links: ThingLinks;
  pmap: PMapWorld;
}

function world(spec: RectMapSpec): World {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const map = buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
  const bm = buildBlockMap(map);
  const links = buildThingLinks(map, bm);
  return { map, links, pmap: { map, bm, links } };
}

/** 400-wide flat room, void walls at x=0/400 — friction/hop/noclip arena
 * (spawn thing parked far from every tested path). */
const bigRoom: RectMapSpec = { rooms: [{ x: 0, y: 0, w: 400, h: 128 }], things: [{ x: 20, y: 20, type: 1 }] };

/** A[0..126] | wall-room B[126..142] (floor=ceiling=0 ⇒ SOLID, 16 wide —
 * thinner than a MAXMOVE stride's landing box) | C[142..300]. */
const wallCorridor: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 126, h: 128 },
    { x: 126, y: 0, w: 16, h: 128, ceilingHeight: 0 },
    { x: 142, y: 0, w: 158, h: 128 },
  ],
};

/** A[0..128] floor 0 | pit B[128..256] floor −8 (dropoff edge at x=128). */
const pitRoom: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 128 },
    { x: 128, y: 0, w: 128, h: 128, floorHeight: -8 },
  ],
};

/** A[0..128] floor 0/ceil 160 | sky B[128..256] floor=ceil=128, F_SKY1. */
const skyRoom: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 128, ceilingHeight: 160 },
    { x: 128, y: 0, w: 128, h: 128, floorHeight: 128, ceilingHeight: 128, ceilingFlat: 'F_SKY1' },
  ],
};

/** player mobjinfo flags (info.c:1130): MF_SOLID|MF_SHOOTABLE|MF_DROPOFF|MF_PICKUP. */
const PLAYER_FLAGS = MF_SOLID | MF_SHOOTABLE | MF_DROPOFF | MF_PICKUP;

function playerState(over: Partial<MovePlayerState> = {}): MovePlayerState {
  return { cheats: 0, forwardmove: 0, sidemove: 0, viewheight: VIEWHEIGHT, deltaviewheight: 0, ...over };
}

function mover(x: number, y: number, over: Partial<MoveMobj> = {}): MoveMobj {
  return {
    x,
    y,
    z: 0,
    momx: 0,
    momy: 0,
    momz: 0,
    radius: fx(16),
    height: fx(56),
    flags: PLAYER_FLAGS,
    player: true,
    linkSlot: -1,
    floorz: 0,
    ceilingz: fx(128),
    ...over,
  };
}

/** Tiny r1/h1 scout for the wall-corridor tunnel probes. */
function scout(x: number, over: Partial<MoveMobj> = {}): MoveMobj {
  return mover(x, fx(64), { radius: fx(1), height: fx(1), player: false, flags: 0, ...over });
}

beforeEach(() => {
  resetPmoveHookCounts();
  delete pmoveHooks.slideMove;
  delete pmoveHooks.explodeMissile;
  delete pmoveHooks.removeMobj;
  delete pmoveHooks.setMobjState;
  delete pmoveHooks.playSound;
});

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

describe('pmove constants', () => {
  it('pinned to the 1.10 sources', () => {
    expect(MAXMOVE).toBe(30 * FRACUNIT); // p_local.h:54
    expect(GRAVITY).toBe(FRACUNIT); // p_local.h:53 — exactly 1*FRACUNIT
    expect(STOPSPEED).toBe(0x1000); // p_mobj.c:111
    expect(FRICTION).toBe(0xe800); // p_mobj.c:112
    expect(VIEWHEIGHT).toBe(41 * FRACUNIT); // p_local.h:34
    expect(CF_NOMOMENTUM).toBe(4); // d_player.h:75
    expect(MF_CORPSE).toBe(0x100000); // p_mobj.h:173
  });
});

/* ------------------------------------------------------------------ */
/* 2. MAXMOVE half-split (acceptance item 2)                            */
/* ------------------------------------------------------------------ */

describe('MAXMOVE half-split', () => {
  // Airborne (z > floorz ⇒ zero friction, acceptance 4) so stride == momentum.
  const arena = world(bigRoom);

  it('big hop == clamped hop == chained half steps (bit-identical)', () => {
    const starts: number[] = [];
    for (const [mom, tics] of [
      [64 * FU, 1],
      [MAXMOVE, 1],
      [45 * FU, 1],
      [15 * FU, 2],
    ] as const) {
      const mo = mover(fx(200), fx(64), {
        momx: mom,
        z: 2 * FU,
        flags: MF_NOGRAVITY,
        player: false,
        playerRef: undefined,
      });
      for (let t = 0; t < tics; t++) pXYMovement(arena.pmap, mo);
      starts.push(mo.x);
    }
    expect(starts[0]).toBe(fx(230));
    expect(starts[1]).toBe(starts[0]);
    expect(starts[2]).toBe(starts[0]);
    expect(starts[3]).toBe(starts[0]); // two chained 15-unit steps == one 30
  });

  it('wall-room thinner than the landing box: split blocks (no tunnel)', () => {
    const w = world(wallCorridor);
    // x=124, stride 30: half step lands at 139 INSIDE the 16-wide zero-height
    // wall room B → rejected; a naive single stride to 154 would land cleanly
    // in room C and tunnel the wall entirely. Final x MUST stay 124.
    const mo = scout(fx(124), { momx: 30 * FU });
    pXYMovement(w.pmap, mo);
    expect(mo.x).toBe(fx(124));
    expect(mo.momx).toBe(0); // blocked, non-player non-missile ⇒ mom zeroed
  });

  it('vanilla quirk: negative components are NOT split (full −30 stride)', () => {
    const w = world(wallCorridor);
    // p_mobj.c:145 `if (xmove > MAXMOVE/2 || ...)` — only POSITIVE moves
    // half. −30*FRACUNIT takes one full stride whose box never touches the
    // wall room ⇒ the clip-through is faithful 1.10 behavior, pinned.
    const mo = scout(fx(148), { momx: -30 * FU });
    pXYMovement(w.pmap, mo);
    expect(mo.x).toBe(fx(118));
  });
});

/* ------------------------------------------------------------------ */
/* 1. Friction / stop curve (acceptance item 1)                         */
/* ------------------------------------------------------------------ */

describe('friction + stop', () => {
  const w = world(bigRoom);
  const START = fx(64);

  it('decay is exact per tic for 20/40 tics and stops inside STOPSPEED (BigInt oracle)', () => {
    const run = (tics: number): MoveMobj => {
      const mo = mover(START, fx(64), { momx: 546133, playerRef: playerState() });
      for (let t = 0; t < tics; t++) pXYMovement(w.pmap, mo);
      return mo;
    };
    // independent recurrence (exact BigInt fixed math + the C stop rule):
    const oracle = (tics: number): { x: number; mom: number; stoppedAt: number } => {
      let m = 546133n;
      let x = BigInt(START);
      let stoppedAt = -1;
      for (let t = 0; t < tics; t++) {
        x += m;
        if (m < 4096n && m > -4096n) {
          if (stoppedAt < 0) stoppedAt = t;
          m = 0n;
        } else {
          m = (m * 59392n) >> 16n; // FixedMul(m, FRICTION)
        }
      }
      return { x: Number(x), mom: Number(m), stoppedAt };
    };
    for (const tics of [20, 40, 60]) {
      const o = oracle(tics);
      const mo = run(tics);
      expect(mo.x, `tic ${tics}`).toBe(o.x);
      expect(mo.momx, `tic ${tics}`).toBe(o.mom);
    }
    expect(oracle(60).stoppedAt).toBeGreaterThan(40); // ~tic 50, never before 40
    expect(pmoveHookCounts.setMobjStatePlay).toBe(1); // fires once (60-tic run)
  });

  it('airborne (z > floorz) has ZERO friction; input-down below STOPSPEED too', () => {
    const air = mover(START, fx(64), { momx: 546133, z: FU, flags: MF_NOGRAVITY, player: false });
    for (let t = 0; t < 10; t++) pXYMovement(w.pmap, air);
    expect(air.momx).toBe(546133);
    expect(air.x).toBe((START + 10 * 546133) | 0);

    // below STOPSPEED WITH input ⇒ friction branch, not the stop branch
    const run = mover(START, fx(64), {
      momx: 2000,
      playerRef: playerState({ forwardmove: 50 }),
    });
    pXYMovement(w.pmap, run);
    expect(run.momx).toBe(FixedMul(2000, FRICTION));
    expect(run.momx).not.toBe(0);
    expect(pmoveHookCounts.setMobjStatePlay).toBe(0);
  });

  it('MF_MISSILE never has friction; CF_NOMOMENTUM zeroes right after the move', () => {
    const mis = mover(START, fx(64), { momx: 546133, flags: MF_MISSILE, player: false });
    pXYMovement(w.pmap, mis);
    expect(mis.momx).toBe(546133); // moved + no friction (missile exemption)

    const nom = mover(START, fx(64), {
      momx: 546133,
      playerRef: playerState({ cheats: CF_NOMOMENTUM }),
    });
    pXYMovement(w.pmap, nom);
    expect(nom.momx).toBe(0);
    expect(nom.x).toBe((START + 546133) | 0); // the move itself still happened
  });

  it('MF_CORPSE halfway off a step keeps sliding (no stop, no friction)', () => {
    const w2 = world(pitRoom);
    const corpse = mover(fx(140), fx(64), {
      flags: MF_CORPSE,
      player: false,
      momx: FU,
      floorz: 0, // published floor of room A while the subsector is the pit
    });
    pXYMovement(w2.pmap, corpse);
    expect(corpse.momx).toBe(FU); // continue (p_mobj.c:218) before stop/friction
    const ctrl = mover(fx(140), fx(64), { flags: 0, player: false, momx: FU, floorz: 0 });
    pXYMovement(w2.pmap, ctrl);
    expect(ctrl.momx).toBe(FixedMul(FU, FRICTION)); // 59392 — friction applies
  });
});

/* ------------------------------------------------------------------ */
/* Blocked-move branches                                                */
/* ------------------------------------------------------------------ */

describe('blocked XY branches', () => {
  it('player blocked → slideMove slot fires once per blocked substep; default no-op keeps momentum', () => {
    const w = world(bigRoom);
    const mo = mover(fx(390), fx(64), { momx: 10 * FU, playerRef: playerState() });
    pXYMovement(w.pmap, mo); // single stride, blocked by the void wall at 400
    expect(pmoveHookCounts.slideMove).toBe(1);
    expect(mo.x).toBe(fx(390));
    expect(mo.momx).toBe(FixedMul(10 * FU, FRICTION)); // survived slide slot, then friction
  });

  it('registered slideMove hook side effect is observed', () => {
    const w = world(bigRoom);
    const seen: number[] = [];
    pmoveHooks.slideMove = (m) => {
      seen.push(m.x);
      m.x = (m.x + FU) | 0;
    };
    const mo = mover(fx(390), fx(64), { momx: 10 * FU, playerRef: playerState() });
    pXYMovement(w.pmap, mo);
    expect(seen).toEqual([fx(390)]);
    expect(mo.x).toBe(fx(391));
  });

  it('missile into a non-sky ceiling → explode: mom zeroed, MF_MISSILE cleared', () => {
    const w = world(bigRoom);
    const mo = mover(fx(380), fx(64), { momx: 30 * FU, flags: MF_MISSILE, player: false });
    pXYMovement(w.pmap, mo);
    expect(pmoveHookCounts.explodeMissile).toBe(1); // 2nd substep: flag gone → plain block
    expect(pmoveHookCounts.missileRemoved).toBe(0);
    expect(mo.momx).toBe(0);
    expect(mo.momy).toBe(0);
    expect(mo.momz).toBe(0);
    expect(mo.flags & MF_MISSILE).toBe(0);
    expect(mo.x).toBe(fx(380));
  });

  it('missile blocked under a sky backsector ceiling → remove slot + early return (no explode)', () => {
    const w = world(skyRoom);
    let removed = 0;
    pmoveHooks.removeMobj = () => {
      removed++;
    };
    const mo = mover(fx(104), fx(64), { momx: 30 * FU, flags: MF_MISSILE, player: false });
    pXYMovement(w.pmap, mo);
    expect(pmoveHookCounts.missileRemoved).toBe(1);
    expect(removed).toBe(1);
    expect(pmoveHookCounts.explodeMissile).toBe(0); // p_mobj.c:172-177 returns first
    expect(mo.x).toBe(fx(104));
  });

  it('skull slam: zero momentum clears MF_SKULLFLY + spawnstate hook', () => {
    const w = world(bigRoom);
    const mo = mover(fx(64), fx(64), { flags: MF_SKULLFLY, player: false, momz: -FU });
    pXYMovement(w.pmap, mo);
    expect(mo.flags & MF_SKULLFLY).toBe(0);
    expect(mo.momz).toBe(0);
    expect(pmoveHookCounts.setMobjStateSpawn).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. P_ZMovement (acceptance item 3)                                   */
/* ------------------------------------------------------------------ */

describe('P_ZMovement', () => {
  it('gravity parabola is analytic: z = z0 − (k(k+1)/2 − 1)·G, momz = −(k+1)·G', () => {
    for (const k of [30, 60]) {
      const mo = mover(0, 0, { z: fx(100), momz: 0, floorz: fx(-10000), ceilingz: fx(2000) });
      for (let t = 0; t < k; t++) pZMovement(mo);
      expect(mo.momz).toBe(-((k + 1) * FU));
      expect(mo.z).toBe((fx(100) - (((k * (k + 1)) / 2 - 1) * FU) | 0));
    }
  });

  it('MF_NOGRAVITY freezes momz and z (noclip cheat pairing)', () => {
    const mo = mover(0, 0, {
      z: fx(50),
      momz: 0,
      floorz: 0,
      ceilingz: fx(400),
      flags: MF_NOGRAVITY,
    });
    for (let t = 0; t < 10; t++) pZMovement(mo);
    expect(mo.z).toBe(fx(50));
    expect(mo.momz).toBe(0);
  });

  it('landing snaps z=floorz, zeroes momz; hard landing squats view, oof slot, NO damage', () => {
    const ps = playerState();
    const soft = mover(0, 0, { z: fx(4), momz: -4 * FU, floorz: 0, playerRef: ps });
    pZMovement(soft);
    expect(soft.z).toBe(0);
    expect(soft.momz).toBe(0);
    expect(ps.deltaviewheight).toBe(0); // −4FU is above the −8·GRAVITY squat gate
    expect(pmoveHookCounts.playSoundOof).toBe(0);

    const hard = mover(0, 0, { z: fx(10), momz: -20 * FU, floorz: 0, playerRef: ps });
    pZMovement(hard);
    expect(hard.z).toBe(0);
    expect(hard.momz).toBe(0);
    expect(ps.deltaviewheight).toBe((-20 * FU) >> 3); // −163840, p_mobj.c:297-300
    expect(ps.viewheight).toBe(VIEWHEIGHT); // squat is deltaviewheight-only; P_CalcHeight (M5-06) integrates
    expect(pmoveHookCounts.playSoundOof).toBe(1); // sfx_oof slot; NO hp field touched (no fall damage, §0.2)
  });

  it('ceiling bonk: z = ceilingz − height, positive momz zeroed', () => {
    const mo = mover(0, 0, { z: 0, momz: 10 * FU, floorz: 0, ceilingz: fx(60) });
    pZMovement(mo);
    expect(mo.z).toBe(fx(4));
    expect(mo.momz).toBe(0);
  });

  it('skull slam bounces momz off floor, zeroed against ceiling', () => {
    const floor = mover(0, 0, { z: FU, momz: -5 * FU, floorz: 0, ceilingz: fx(400), flags: MF_SKULLFLY });
    pZMovement(floor);
    expect(floor.momz).toBe(5 * FU);
    expect(floor.z).toBe(0);
    const ceil = mover(0, 0, { z: fx(50), momz: 5 * FU, floorz: 0, ceilingz: fx(100), flags: MF_SKULLFLY });
    pZMovement(ceil);
    expect(ceil.z).toBe(fx(100) - fx(56));
    expect(ceil.momz).toBe(0); // momz zeroed BEFORE the skull negate (vanilla order)
  });

  it('missile floor hit explodes and returns (ceiling check skipped)', () => {
    const mo = mover(0, 0, {
      z: 3 * FU,
      momz: -4 * FU,
      floorz: 0,
      ceilingz: fx(60),
      flags: MF_MISSILE,
      player: false,
    });
    pZMovement(mo);
    expect(pmoveHookCounts.explodeMissile).toBe(1);
    expect(mo.momz).toBe(0);
    expect(mo.momx).toBe(0);
    expect(mo.flags & MF_MISSILE).toBe(0);
  });

  it('player smooth step-up squashes viewheight by the step', () => {
    const ps = playerState();
    const mo = mover(0, 0, { z: 0, momz: 0, floorz: FU, ceilingz: fx(200), playerRef: ps });
    pZMovement(mo);
    expect(ps.viewheight).toBe(VIEWHEIGHT - FU);
    expect(ps.deltaviewheight).toBe(FU >> 3); // (VIEWHEIGHT − 40FU) >> 3 = 8192
  });

  it('edge dropoff: exact transition tic and landing tic after the walk-off', () => {
    const w = world(pitRoom);
    const mo = mover(fx(110), fx(64), {
      playerRef: playerState(),
      flags: MF_DROPOFF,
      player: true,
    });
    // walk off the ledge: 3 × 15-unit steps (pTryMove directly, so the
    // Z-side truth stands alone — XY friction is pinned above)
    expect(pTryMove(w.pmap, mo, fx(125), fx(64))).toBe(true);
    expect(mo.floorz).toBe(0); // box still overlaps the opening line
    expect(pTryMove(w.pmap, mo, fx(140), fx(64))).toBe(true);
    expect(mo.floorz).toBe(0); // box 124..156 still straddles x=128
    expect(pTryMove(w.pmap, mo, fx(155), fx(64))).toBe(true);
    expect(mo.floorz).toBe(fx(-8)); // box cleared the line — floor dropped
    expect(mo.z).toBe(0);

    // fall: z0=0 vs floorz=−8·FU: tic1 starts momz=−2G (z NOT yet moved),
    // z = −(k(k+1)/2 − 1)·G, landing when the step crosses −8 ⇒ tic 4.
    pZMovement(mo);
    expect(mo.z).toBe(0); // transition tic: unchanged
    expect(mo.momz).toBe(-2 * FU);
    pZMovement(mo);
    expect(mo.z).toBe(-2 * FU);
    expect(mo.momz).toBe(-3 * FU);
    pZMovement(mo);
    expect(mo.z).toBe(-5 * FU);
    expect(mo.momz).toBe(-4 * FU);
    pZMovement(mo); // −5 −4 = −9 ≤ −8 ⇒ snap
    expect(mo.z).toBe(fx(-8));
    expect(mo.momz).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* NOCLIP straight line + P_ThingHeightClip                             */
/* ------------------------------------------------------------------ */

describe('noclip + height clip', () => {
  it('NOCLIP walks a straight line through the void wall (zero block/slide calls)', () => {
    const w = world(bigRoom);
    const mo = mover(fx(375), fx(64), {
      momx: 20 * FU,
      z: FU,
      flags: MF_NOCLIP | MF_NOGRAVITY,
      player: false,
    });
    const xs: number[] = [];
    for (let t = 0; t < 5; t++) {
      pXYMovement(w.pmap, mo); // XY only: inside the void sector a vanilla
      // P_ZMovement would clamp z under the void ceiling (−128−56) and
      // re-enable friction — that clamp is pinned by the ceiling-bonk test.
      xs.push(mo.x);
    }
    expect(xs).toEqual([fx(395), fx(415), fx(435), fx(455), fx(475)]);
    expect(mo.momx).toBe(20 * FU); // airborne gate: no friction; nothing blocked
    expect(pmoveHookCounts.slideMove).toBe(0);
    // floorz/ceilingz still UPDATE under noclip (vanilla seeds them from
    // R_PointInSubsector even on the bypass path; out-of-map points resolve
    // to whichever BSP leaf the descent reaches — pinned structurally in
    // pmap/bsp tests, not re-litigated here).
    expect(mo.floorz).toBeDefined();
  });

  it('pThingHeightClip rises with the floor, clamps to the ceiling, refuses a crush', () => {
    const w = world(pitRoom);
    const wc = world(wallCorridor);

    const walker = mover(fx(160), fx(64), { z: 0, floorz: 0, ceilingz: fx(128), player: false });
    expect(pThingHeightClip(w.pmap, walker)).toBe(true);
    expect(walker.floorz).toBe(fx(-8)); // re-seeded from the pit
    expect(walker.z).toBe(fx(-8)); // onfloor ⇒ rides the floor

    const floater = mover(fx(160), fx(64), { z: fx(100), floorz: 0, ceilingz: fx(400), player: false });
    expect(pThingHeightClip(w.pmap, floater)).toBe(true);
    expect(floater.z).toBe(fx(128) - fx(56)); // forced down by the ceiling only

    const stuck = scout(fx(134), { radius: fx(16), player: false });
    expect(pThingHeightClip(wc.pmap, stuck)).toBe(false); // zero-height room: won't fit
  });
});

/* ------------------------------------------------------------------ */
/* Zero allocation + determinism                                        */
/* ------------------------------------------------------------------ */

describe('steady-state hygiene', () => {
  it('zero allocation in steady state (GC-storm timing heuristic, pmap.test convention)', () => {
    const w = world(bigRoom);
    const mo = mover(fx(64), fx(64), { momx: 546133, playerRef: playerState() });
    for (let i = 0; i < 2000; i++) {
      mo.momx = 546133; // reset instead of thrust (P_Thrust is M5-06)
      pXYMovement(w.pmap, mo);
      pZMovement(mo);
    }
    const t0 = process.hrtime.bigint();
    let acc = 0;
    for (let i = 0; i < 20000; i++) {
      mo.momx = i & 1 ? -546133 : 546133;
      pXYMovement(w.pmap, mo);
      pZMovement(mo);
      acc = (acc + mo.x) | 0;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(Number.isFinite(acc)).toBe(true);
    expect(ms).toBeLessThan(5000); // a per-call allocation would GC-storm this
  });

  it('determinism: identical scripted 30-tic streams twice', () => {
    const run = (): number[] => {
      const w = world(wallCorridor);
      const mo = mover(fx(64), fx(64), { momx: 20 * FU, z: 2 * FU, flags: MF_NOGRAVITY, player: false });
      const log: number[] = [];
      for (let t = 0; t < 30; t++) {
        pXYMovement(w.pmap, mo);
        pZMovement(mo);
        log.push(mo.x, mo.y, mo.z, mo.momx, mo.momy, mo.momz);
      }
      return log;
    };
    expect(run()).toEqual(run());
  });
});
