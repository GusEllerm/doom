/**
 * sim/p_shoot — M7-08 acceptance tests (docs/design/M7-plan.md §M7-08).
 *
 *  1. AUTOAIM: cone constants pinned (±100*FRACUNIT/160 = ±40960), the
 *     analytic mid-slope of a clean hit, the EXACT cone-edge accept, the
 *     over/under rejects, self-skip, the non-MF_SHOOTABLE pass-over, the
 *     two-sided NARROWING rule (a step raises bottomslope and lifts the
 *     autoaim) and `openbottom >= opentop` ⇒ STOP;
 *  2. P_BulletSlope probe COUNTS (1 / 2 / 3) through the REAL aim — the
 *     probe STRUCTURE is p_pspr.c's (M7-07), the autoaim is M7-08's;
 *  3. SHOOT TRAVERSE: wall hit with the 4-unit pull-back, sky-front
 *     above-ceiling + sky-hack NO-PUFF, thing hit with the 10-unit
 *     pull-back, blood-vs-puff by MF_NOBLOOD, blood STATE by damage,
 *     damageSlot(target, amount, source, tic) args verbatim
 *     P_DamageMobj(target, source, source, damage), and the "damage == 0 is
 *     a test trace that leaves linetarget set" rule;
 *  4. intercept ORDER property vs an independent brute-force reference
 *     (first qualifying thing wins, blocking lines win, MF_SPECIAL items are
 *     passed over);
 *  5. SHOOT-SPECIAL dispatch: the mirror set is p_spec.c:955-1000 — specials
 *     24/46/47 ONLY (there is no "W1 42" shoot case; W1 lines belong to
 *     P_CrossSpecialLine). Every CROSSED special line fires, a BLOCKING
 *     line fires then stops the trace (§0.10c), and the line beyond it does
 *     not fire;
 *  6. per-weapon P_Random STREAM pins (spread draws, the 3 draws per impact
 *     mobj, the plasma flash draw) + the puff/blood state walks;
 *  7. zero-allocation traverse (module-static globals) + double-run hash.
 *
 * Mirror truth: /tmp/DOOM-master/linuxdoom-1.10 p_map.c:785-1088,
 * p_pspr.c:487-700, p_spec.c:955-1000, p_mobj.c:811-862.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { ANG180, ANG90, ANGLETOFINESHIFT, FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';

import { buildMapFromData } from './map';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { gInitGame } from './game';
import { hashState, type GameState, type Skill } from './state';
import { RNDTABLE, mClearRandom } from './prng';
import { MT } from '../wad/info/mobjinfo';
import { S } from '../wad/info/states';

import { MF_SHOOTABLE, MF_SPECIAL } from './thinglinks';
import { MELEERANGE, MISSILERANGE, attackRange, type Mobj } from './p_mobj';
import { pRunThinkers } from './ptick';
import { pspecCounts, resetPspecCounts } from './pspec';

import {
  AM_CELL,
  AM_CLIP,
  AM_MISL,
  AM_SHELL,
  BFGCELLS,
  WP_BFG,
  WP_FIST,
  WP_MISSILE,
  PS_FLASH,
  WEAPONINFO,
  WP_CHAINSAW,
  WP_PLASMA,
  WP_PISTOL,
  WP_SHOTGUN,
  aFireBFG,
  aFireCGun,
  aFireMissile,
  aFirePistol,
  aFirePlasma,
  aFireShotgun,
  aPunch,
  aSaw,
  attachPsprFields,
  bindPsprWorld,
  psprGlobals,
  psprHookCounts,
  psprHooks,
  resetPsprHooks,
  type PsprPlayer,
} from './p_pspr';

import {
  bindShootWorld,
  boundShootWorld,
  linetarget,
  pAimLineAttack,
  pLineAttack,
  rPointToAngle2,
  registerShootPsprHooks,
  resetShootGlobals,
  shootGlobals,
} from './p_shoot';

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const fx = (n: number): number => (n * FRACUNIT) | 0;

/** Fixed values on the impact path carry at most one unit of
 * FixedMul/FixedDiv round-off (the mirror computes dist as
 * FixedMul(attackrange, frac) from an intercept-vector frac). */
const UNIT = FRACUNIT;

function boot(spec: RectMapSpec, skill: Skill = 2): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), skill);
}

/** 512×512 firing range; player 1 at (128,128) facing EAST (angle 0). */
function range(extra: RectMapSpec['things'] = []): GameState {
  return boot({
    rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 160 }],
    things: [{ x: 128, y: 128, angle: 0, type: 1 }, ...extra],
  });
}

const live = (s: GameState): Mobj[] => s.mobjs.mobjs.filter((m) => !m.removed);
const of = (s: GameState, t: number): Mobj[] => live(s).filter((m) => m.type === t);
/** True when a damage entry targeted `m`. The L2 log stores the ThingLinks
 * slot AT DAMAGE TIME (hooks.ts records before dispatching to the M8-05
 * P_DamageMobj body), and the kick that body applies promotes a static
 * THINGS thing to a mover slot exactly once per lifetime
 * (p_inter_damage.ts) — so identity resolves through the runtime slot map,
 * which keeps the pre-promotion id bound to the same mobj. */
function hitIs(s: GameState, e: { thing: number }, m: Mobj): boolean {
  return e.thing === m.linkSlot || s.mobjs.slotMobjs.get(e.thing) === m;
}

function slotOf(s: GameState, t: number): number {
  const m = of(s, t)[0];
  if (!m) throw new Error(`fixture has no live MT ${t}`);
  return m.linkSlot;
}

/** Bind the shoot world AND the pspr world (one shared rng), return shooter. */
function shooter(s: GameState): PsprPlayer {
  bindShootWorld(s);
  const p = attachPsprFields(s.players[0]!);
  bindPsprWorld({ rng: s.rng, leveltime: s.leveltime });
  return p;
}

const nearFixed = (a: number, b: number, tol = UNIT >> 2): void => {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
};
const nearSlope = (a: number, b: number, tol = 256): void => {
  expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);
};

beforeEach(() => {
  resetPsprHooks(); // counted no-op defaults…
  registerShootPsprHooks(); // …then re-install M7-08's three slots
  resetShootGlobals();
  resetPspecCounts();
  attackRange.value = MISSILERANGE;
  bindShootWorld(null);
});

/* ================================================================== */
/* 1. Autoaim — the view cone                                          */
/* ================================================================== */

describe('P_AimLineAttack — autoaim cone (p_map.c:812-905, 1020-1053)', () => {
  it('cone constants are ±(100*FRACUNIT/160); eye = z + height/2 + 8', () => {
    const s = range();
    const p = shooter(s);
    expect(pAimLineAttack(p.mo, ANG90, MISSILERANGE)).toBe(0);
    const g = shootGlobals();
    expect(((100 * FRACUNIT) / 160) | 0).toBe(40960);
    expect(g.topslope).toBe(40960);
    expect(g.bottomslope).toBe(-40960);
    expect(g.attackrange).toBe(MISSILERANGE);
    expect(g.shootz).toBe(fx(36)); // floor 0 + 56/2 + 8
    expect(linetarget.active).toBe(false);
  });

  it('clean hit aims the analytic mid of the thing box', () => {
    const s = range([{ x: 320, y: 128, angle: 0, type: 2035 }]); // barrel
    const p = shooter(s);
    const slope = pAimLineAttack(p.mo, p.mo.angle, MISSILERANGE);
    // The horizontal trace crosses the corner-to-corner crossection AT the
    // thing origin ⇒ dist = 192: top (42−36)/192 = +2048, bottom
    // (0−36)/192 = −12288, both inside the cone ⇒ mid = −5120.
    nearSlope(slope, -5120, 16);
    expect(linetarget.slot).toBe(slotOf(s, MT.MT_BARREL));
  });

  it('the shooter is never its own target (all four quadrants)', () => {
    const s = range();
    const p = shooter(s);
    expect(p.mo.flags & MF_SHOOTABLE).not.toBe(0);
    for (const ang of [0, ANG90, ANG180, (3 * ANG90) >>> 0]) {
      expect(pAimLineAttack(p.mo, ang, MISSILERANGE)).toBe(0);
      expect(linetarget.active).toBe(false);
    }
  });

  it('passes OVER a non-MF_SHOOTABLE thing and keeps going', () => {
    const s = range([{ x: 256, y: 128, angle: 0, type: 2014 }]); // medikit
    const p = shooter(s);
    // M7-03: the player IS a live mobj now — exclude it from the fixture
    // roster (pre-M7-03 this assertion counted only spawned things).
    const fixtures = live(s).filter((m) => m.type !== MT.MT_PLAYER);
    expect(fixtures).toHaveLength(1); // the shooter's own mobj is not in the roster
    expect(fixtures[0]!.flags & MF_SPECIAL).not.toBe(0);
    expect(fixtures[0]!.flags & MF_SHOOTABLE).toBe(0);
    expect(pAimLineAttack(p.mo, p.mo.angle, MISSILERANGE)).toBe(0);
    expect(linetarget.active).toBe(false);
    // The follow-up shot puffs on the FAR wall (512 − 4): the item did not
    // stop the trace.
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 0);
    expect(of(s, MT.MT_PUFF)).toHaveLength(1);
    nearFixed(of(s, MT.MT_PUFF)[0]!.x, fx(508));
  });

  it('EXACT cone edge: a zombie 32 units out tops AT +40960 and is aimed', () => {
    const s = range([{ x: 160, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    // (56−36)/32 = +0.625 == topslope exactly (the reject test is a strict
    // `<`), the bottom edge clamps UP to −40960 ⇒ mirrored edges ⇒ slope 0.
    nearSlope(pAimLineAttack(p.mo, p.mo.angle, MISSILERANGE), 0, 16);
    expect(linetarget.active).toBe(true);
  });

  it('rejects a thing wholly UNDER the cone (shot goes over it)', () => {
    // Room B sits 128 units BELOW the player's floor; its zombie's TOP is
    // under the cone's lower edge at close range.
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, floorHeight: 0 },
        { x: 256, y: 0, w: 256, h: 256, floorHeight: -128 },
      ],
      things: [
        { x: 64, y: 128, angle: 0, type: 1 },
        { x: 320, y: 128, angle: 0, type: 3004 }, // 256 units out
      ],
    });
    const p = shooter(s);
    // openbottom = max(0,−128) = 0 ⇒ bottomslope = (0−36)/192 = −0.1875;
    // the zombie's top slope = (−128+56−36)/256 = −0.421875 < bottomslope
    // ⇒ "the shot goes over" ⇒ pass over, no target.
    expect(pAimLineAttack(p.mo, p.mo.angle, MISSILERANGE)).toBe(0);
    expect(linetarget.active).toBe(false);
    // Steeper manual slopes do not rescue it either: the shot meets the
    // pit's floor edge first (openbottom 0 ⇒ −0.1875 is the steepest
    // passable slope, and the box needs ≤ −0.42) — so it puffs on the step.
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, -FRACUNIT / 2, 5);
    expect(of(s, MT.MT_BLOOD)).toHaveLength(0);
    nearFixed(of(s, MT.MT_PUFF)[0]!.x, fx(252));
  });

  it('two-sided narrowing: a step RAISES bottomslope and lifts the autoaim', () => {
    // Both rooms ceiling 256 ⇒ openbottom 128 < opentop 256, so the trace
    // continues; the step line is 192 units out ⇒ bottomslope := 92/192.
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, floorHeight: 0, ceilingHeight: 256 },
        { x: 256, y: 0, w: 256, h: 256, floorHeight: 128, ceilingHeight: 256 },
      ],
      things: [
        { x: 64, y: 128, angle: 0, type: 1 },
        { x: 320, y: 128, angle: 0, type: 3004 }, // on the step, 256 out
      ],
    });
    const p = shooter(s);
    const slope = pAimLineAttack(p.mo, p.mo.angle, MISSILERANGE);
    expect(linetarget.active).toBe(true);
    nearSlope(shootGlobals().bottomslope, 31403, 512);
    // thingtop (148)/256 = +0.578125 stays (under topslope); thingbottom
    // (92)/256 = +0.359375 falls BELOW the narrowed band ⇒ clamps UP to it
    // ⇒ mid ≈ +0.52865 ≈ 34644. Without the lip the mid would be +0.46875 =
    // 30720: the narrowing is what lifts the shot over the step.
    expect(slope).toBeGreaterThan(shootGlobals().bottomslope);
    nearSlope(slope, 34644, 512);
  });

  it('openbottom >= opentop STOPS the trace (full-height step)', () => {
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, floorHeight: 0 },
        { x: 256, y: 0, w: 256, h: 256, floorHeight: 128 },
      ],
      things: [
        { x: 64, y: 128, angle: 0, type: 1 },
        { x: 320, y: 128, angle: 0, type: 3004 },
      ],
    });
    const p = shooter(s);
    expect(pAimLineAttack(p.mo, p.mo.angle, MISSILERANGE)).toBe(0);
    expect(linetarget.active).toBe(false);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 0);
    expect(of(s, MT.MT_BLOOD)).toHaveLength(0);
    nearFixed(of(s, MT.MT_PUFF)[0]!.x, fx(252)); // step − 4
  });

  it('manual slopes pass OVER / UNDER a thing (p_map.c:872-880)', () => {
    const s = range([{ x: 320, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    // The box spans −0.1875 … +0.1042 at 192 units: shoot past it both ways.
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, fx(1), 5); // over
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, fx(-1), 5); // under
    expect(of(s, MT.MT_BLOOD)).toHaveLength(0);
    expect(of(s, MT.MT_PUFF)).toHaveLength(2);
    expect(s.hooks.damage.count).toBe(0);
  });
});

/* ================================================================== */
/* 2. Shoot traverse — impacts                                         */
/* ================================================================== */

describe('PTR_ShootTraverse — hit resolution (p_map.c:910-1013)', () => {
  it('wall hit: 4-unit pull-back, slope-raised z, one puff, no damage', () => {
    const s = range();
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 5);
    const puff = of(s, MT.MT_PUFF);
    expect(puff).toHaveLength(1);
    nearFixed(puff[0]!.x, fx(508));
    // finesine[0] is 25, not 0 (tables.c:220 — the port's table is
    // byte-identical), so an "east" trace drifts +25/65536 per unit.
    nearFixed(puff[0]!.y, fx(128) + FixedMul(fx(380), 25), 4096);
    expect(puff[0]!.state).toBe(S.S_PUFF1);
    expect(puff[0]!.momz).toBe(FRACUNIT);
    // P_SpawnPuff jitters z by (P_Random()-P_Random())<<10 — under 4 units.
    expect(Math.abs(puff[0]!.z - fx(36))).toBeLessThan(4 * FRACUNIT);
    expect(s.hooks.damage.count).toBe(0);
  });

  it('wall hit UP a slope: z rises by slope × (range·frac)', () => {
    const s = range();
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, FRACUNIT / 2, 5);
    nearFixed(of(s, MT.MT_PUFF)[0]!.z, fx(36) + FixedMul(FRACUNIT / 2, fx(380)), 4 * UNIT);
  });

  it('thing hit: 10-unit pull-back, blood, and the exact damageSlot args', () => {
    const s = range([{ x: 320, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 15);
    const blood = of(s, MT.MT_BLOOD);
    expect(blood).toHaveLength(1);
    nearFixed(blood[0]!.x, fx(310));
    nearFixed(blood[0]!.y, fx(128), 8192);
    expect(of(s, MT.MT_PUFF)).toHaveLength(0);
    expect(s.hooks.damage.count).toBe(1);
    expect(hitIs(s, s.hooks.damage.entries[0]!, of(s, MT.MT_POSSESSED)[0]!)).toBe(
      true,
    ); // the victim the trace resolved
    expect(s.hooks.damage.entries[0]).toMatchObject({
      amount: 15,
      source: p.mo.linkSlot,
      tic: s.leveltime,
    });
  });

  it('MF_NOBLOOD target (barrel) puffs instead of bleeding', () => {
    const s = range([{ x: 320, y: 128, angle: 0, type: 2035 }]);
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 20);
    expect(of(s, MT.MT_BLOOD)).toHaveLength(0);
    nearFixed(of(s, MT.MT_PUFF)[0]!.x, fx(310));
    expect(s.hooks.damage.count).toBe(1);
  });

  it('blood STATE by damage: 13+ ⇒ S_BLOOD1, 9..12 ⇒ 2, <9 ⇒ 3', () => {
    for (const [dmg, state] of [
      [20, S.S_BLOOD1],
      [12, S.S_BLOOD2],
      [9, S.S_BLOOD2],
      [8, S.S_BLOOD3],
      [1, S.S_BLOOD3],
    ] as const) {
      const s = range([{ x: 320, y: 128, angle: 0, type: 3004 }]);
      const p = shooter(s);
      pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, dmg);
      expect(of(s, MT.MT_BLOOD)[0]!.state).toBe(state);
    }
  });

  it('damage 0 = test trace: impacts still spawn, NOTHING is damaged', () => {
    const s = range([{ x: 320, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    expect(pAimLineAttack(p.mo, p.mo.angle, MISSILERANGE)).not.toBe(0);
    expect(linetarget.active).toBe(true);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 0);
    expect(s.hooks.damage.count).toBe(0);
    expect(of(s, MT.MT_BLOOD)).toHaveLength(1);
    // P_LineAttack never CLEARS linetarget (only P_AimLineAttack zeroes it).
    expect(linetarget.active).toBe(true);
  });

  it('sky-front wall above the impact: NO puff at all', () => {
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 512, h: 512, ceilingHeight: 128, ceilingFlat: 'F_SKY1' }],
      things: [{ x: 128, y: 128, angle: 0, type: 1 }],
    });
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, FRACUNIT, 5); // 45° up
    expect(of(s, MT.MT_PUFF)).toHaveLength(0);
    // The SAME shot flat into the same sky wall DOES puff (z under the
    // ceiling) ⇒ the branch is the ceiling test, not the sky test.
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 5);
    expect(of(s, MT.MT_PUFF)).toHaveLength(1);
  });

  it('sky-hack wall (both sides F_SKY1): NO puff even at eye height', () => {
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, ceilingFlat: 'F_SKY1' },
        { x: 256, y: 0, w: 256, h: 256, ceilingFlat: 'F_SKY1' },
      ],
      things: [{ x: 64, y: 128, angle: 0, type: 1 }],
    });
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, fx(300), 0, 5); // stops on the shared line
    expect(of(s, MT.MT_PUFF)).toHaveLength(0);
  });

  it('a shot into empty space spawns nothing', () => {
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 512, h: 512 }],
      things: [{ x: 128, y: 128, angle: 90, type: 1 }], // faces NORTH
    });
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, fx(8), 0, 5); // ends in mid-air
    // (M7-03) the player mobj is always live — the shot itself must spawn nothing
    expect(live(s).filter((m) => m.type !== MT.MT_PLAYER)).toHaveLength(0);
  });
});

/* ================================================================== */
/* 3. Bullet-slope probe order through the real autoaim                */
/* ================================================================== */

describe('P_BulletSlope — 1 / 2 / 3 probe counts (p_pspr.c:487-500)', () => {
  /** The probes fan ±5.625° (1<<26 BAM) around the player angle, so a
   * target 300 units out sits ~29.4 units off-axis for the middle ray. */
  function probeAt(ty: number): { s: GameState; p: PsprPlayer } {
    const s = range([{ x: 426, y: ty, angle: 0, type: 3004 }]);
    const p = shooter(s);
    psprGlobals.bulletslope = 0;
    psprHookCounts.aimLineAttack = 0;
    return { s, p };
  }

  it('direct hit ⇒ exactly ONE probe', () => {
    const s = range([{ x: 320, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    psprHookCounts.aimLineAttack = 0;
    psprHooks.bulletSlope(p);
    expect(psprHookCounts.aimLineAttack).toBe(1);
    expect(linetarget.active).toBe(true);
  });

  it('forward miss + upper probe hit ⇒ TWO probes', () => {
    const { p } = probeAt(157); // +5.625° ray goes through the thing
    psprHooks.bulletSlope(p);
    expect(psprHookCounts.aimLineAttack).toBe(2);
    expect(linetarget.active).toBe(true);
    expect(psprGlobals.bulletslope).not.toBe(0);
  });

  it('two forward misses ⇒ THREE probes, and the −5.625° ray is the hit', () => {
    const { p } = probeAt(99); // −5.625° ray goes through the thing
    psprHooks.bulletSlope(p);
    expect(psprHookCounts.aimLineAttack).toBe(3);
    expect(linetarget.active).toBe(true);
  });

  it('nothing to aim at ⇒ three probes and bulletslope stays 0', () => {
    const s = range();
    const p = shooter(s);
    psprGlobals.bulletslope = 7;
    psprHookCounts.aimLineAttack = 0;
    psprHooks.bulletSlope(p);
    expect(psprHookCounts.aimLineAttack).toBe(3);
    expect(psprGlobals.bulletslope).toBe(0);
  });
});

/* ================================================================== */
/* 4. Intercept ORDER property vs brute force                          */
/* ================================================================== */

describe('intercept order — first qualifying target wins (p_map.c:1099-1135)', () => {
  const FAN = [
    { x: 190, y: 128, type: 2035 }, // barrel dead ahead, close
    { x: 240, y: 150, type: 3004 }, // zombie, upper-left of the beam
    { x: 300, y: 106, type: 3004 }, // zombie, lower-right
    { x: 400, y: 128, type: 2035 }, // barrel behind the first
    { x: 360, y: 170, type: 2014 }, // medikit: MF_SPECIAL, passed over
  ];

  /** Independent brute force: the nearest SHOOTABLE thing whose 45°
   * corner-to-corner crossection the trace crosses, using PIT_AddThingIntercepts'
   * OWN diagonal choice — `tracepositive = (dx ^ dy) > 0` picks the corner
   * pair — but computed with exact rational arithmetic instead of the
   * blockmap walk. */
  function bruteTarget(x1: number, y1: number, x2: number, y2: number) {
    let best: { x: number; y: number } | null = null;
    let bestFrac = Infinity;
    // All in MAP UNITS (the reference is scale-free; PIT's tracepositive
    // only looks at the sign bits, which units and fixed agree on).
    const tdx = x2 - x1;
    const tdy = y2 - y1;
    const positive = (tdx ^ tdy) > 0; // PIT tracepositive
    for (const t of FAN) {
      if (t.type === 2014) continue; // MF_SPECIAL: never MF_SHOOTABLE
      const r = t.type === 2035 ? 10 : 20;
      const [ax, ay, bx, by] = positive
        ? [t.x - r, t.y + r, t.x + r, t.y - r]
        : [t.x - r, t.y - r, t.x + r, t.y + r];
      // PIT_AddThingIntercepts straddles the CROSSECTION ENDPOINTS against
      // the trace divline (P_PointOnDivlineSide(x1,y1,&trace)), then keeps
      // the intercept when 0 < frac <= 1 along the trace.
      const d1 = Math.sign(tdx * (ay - y1) - tdy * (ax - x1));
      const d2 = Math.sign(tdx * (by - y1) - tdy * (bx - x1));
      if (d1 === d2 || d1 === 0 || d2 === 0) continue;
      // s·D − t·E = A − P1  ⇒  s = ((A−P1) × E) / (D × E)
      const den = tdx * (by - ay) - tdy * (bx - ax);
      if (den === 0) continue; // parallel
      const frac = ((ax - x1) * (by - ay) - (ay - y1) * (bx - ax)) / den;
      if (frac > 0 && frac <= 1 && frac < bestFrac) {
        bestFrac = frac;
        best = { x: t.x, y: t.y };
      }
    }
    return best;
  }

  it('across a 120-angle fan the damaged thing IS the brute target', () => {
    const s = range(FAN);
    const p = shooter(s);
    // M8-05: the fan runs 120 traces over the SAME things, and a dead
    // monster's corpse is no longer MF_SHOOTABLE (P_KillMobj clears the flag
    // through the ThingLinks mirror, so PIT_CheckThing / the line-attack
    // traverse skip it exactly like p_map.c's `!(th->flags & MF_SHOOTABLE)`)
    // ⇒ volleys after the kill fly OVER the corpse. bruteTarget walks the
    // live FAN geometry, so the victims are pinned immortal (m7Fixtures'
    // convention): this test measures intercept GEOMETRY, not death.
    for (const m of live(s)) if (m.flags & MF_SHOOTABLE) m.health = 1 << 20;
    let hitsChecked = 0;
    for (let deg = 0; deg < 360; deg += 3) {
      const ang = Math.round((deg / 360) * 0x100000000) >>> 0;
      s.hooks.damage.count = 0;
      s.hooks.damage.entries.length = 0;
      pLineAttack(p.mo, ang, MISSILERANGE, 0, 7);
      const fine = ang >>> ANGLETOFINESHIFT; // tables are FINEANGLES/rev with shift 19
      const x2 = 128 + (((MISSILERANGE >> 16) * finecosine[fine]!) >> 16);
      const y2 = 128 + (((MISSILERANGE >> 16) * finesine[fine]!) >> 16);
      const want = bruteTarget(128, 128, x2, y2);
      if (!want) {
        expect(s.hooks.damage.count, `angle ${deg}° should miss`).toBe(0);
        continue;
      }
      const m = live(s).find((mm) => mm.x === fx(want.x) && mm.y === fx(want.y));
      expect(m, `brute target ${want.x},${want.y} exists`).toBeDefined();
      if (s.hooks.damage.count > 0) {
        expect(hitIs(s, s.hooks.damage.entries[0]!, m!), `angle ${deg}°`).toBe(true);
        hitsChecked++;
      }
    }
    expect(hitsChecked).toBeGreaterThan(12); // the fan really exercised hits
  });

  it('a blocking wall in front wins over the thing behind it', () => {
    // Room B's floor (200) is above room A's ceiling (128): openbottom 200
    // >= opentop 128 ⇒ the shared line is solid to the shot.
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, floorHeight: 0, ceilingHeight: 128 },
        { x: 256, y: 0, w: 256, h: 256, floorHeight: 200, ceilingHeight: 328 },
      ],
      things: [
        { x: 64, y: 128, angle: 0, type: 1 },
        { x: 320, y: 128, angle: 0, type: 3004 },
      ],
    });
    const p = shooter(s);
    expect(pAimLineAttack(p.mo, p.mo.angle, MISSILERANGE)).toBe(0);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 15);
    expect(s.hooks.damage.count).toBe(0);
    expect(of(s, MT.MT_BLOOD)).toHaveLength(0);
    expect(of(s, MT.MT_PUFF)).toHaveLength(1); // puff ON the wall
  });

  it('nearest shootable first: the far barrel survives', () => {
    const s = range([
      { x: 300, y: 128, angle: 0, type: 2035 },
      { x: 400, y: 128, angle: 0, type: 2035 },
    ]);
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 20);
    expect(s.hooks.damage.count).toBe(1);
    const near = live(s)
      .filter((m) => m.type === MT.MT_BARREL)
      .sort((a, b) => a.x - b.x)[0]!;
    expect(hitIs(s, s.hooks.damage.entries[0]!, near)).toBe(true);
  });

  it('items are passed over, the shootable behind them is hit', () => {
    const s = range([
      { x: 200, y: 128, angle: 0, type: 2014 },
      { x: 320, y: 128, angle: 0, type: 3004 },
    ]);
    const p = shooter(s);
    const slope = pAimLineAttack(p.mo, p.mo.angle, MISSILERANGE);
    expect(linetarget.slot).toBe(slotOf(s, MT.MT_POSSESSED));
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, slope, 15);
    expect(s.hooks.damage.count).toBe(1);
    expect(of(s, MT.MT_BLOOD)).toHaveLength(1);
  });
});

/* ================================================================== */
/* 5. Shoot specials (p_spec.c:955-1000: 24 / 46 / 47 only)            */
/* ================================================================== */

describe('P_ShootSpecialLine dispatch (M6 interplay, §0.10c)', () => {
  /** Three rooms in a row; both shared edges carry shootable specials. */
  function twoOpenSpecialLines(): GameState {
    return boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 512 },
        { x: 256, y: 0, w: 256, h: 512 },
        { x: 512, y: 0, w: 256, h: 512 },
      ],
      triggers: [
        { x1: 256, y1: 64, x2: 256, y2: 448, special: 46, tag: 1 },
        { x1: 512, y1: 64, x2: 512, y2: 448, special: 46, tag: 2 },
      ],
      things: [{ x: 128, y: 256, angle: 0, type: 1 }],
    });
  }

  it('a crossed special line fires the dispatch', () => {
    const s = twoOpenSpecialLines();
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, fx(300), 0, 0);
    expect(pspecCounts.shootSpecialLine).toBe(1);
  });

  it('TWO crossed special lines fire TWICE (each line, in passing order)', () => {
    const s = twoOpenSpecialLines();
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, fx(500), 0, 0);
    expect(pspecCounts.shootSpecialLine).toBe(2);
  });

  it('a BLOCKING special line fires first, then stops the trace (§0.10c)', () => {
    // The shared edge is two-sided but CLOSED to the shot (room B's floor
    // 200 >= room A's ceiling 128): the dispatch still runs BEFORE the
    // openbottom/opentop block test, so the switch fires and the shot
    // puffs on the line.
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, floorHeight: 0, ceilingHeight: 128 },
        { x: 256, y: 0, w: 256, h: 256, floorHeight: 200, ceilingHeight: 328 },
      ],
      triggers: [{ x1: 256, y1: 64, x2: 256, y2: 192, special: 46, tag: 1 }],
      things: [{ x: 64, y: 128, angle: 0, type: 1 }],
    });
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 0);
    expect(pspecCounts.shootSpecialLine).toBe(1);
    expect(of(s, MT.MT_PUFF)).toHaveLength(1);
    nearFixed(of(s, MT.MT_PUFF)[0]!.x, fx(252));
  });

  it('a plain (special 0) line fires nothing', () => {
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, floorHeight: 0, ceilingHeight: 128 },
        { x: 256, y: 0, w: 256, h: 256, floorHeight: 200, ceilingHeight: 328 },
      ],
      triggers: [{ x1: 256, y1: 64, x2: 256, y2: 192, special: 0 }],
      things: [{ x: 64, y: 128, angle: 0, type: 1 }],
    });
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 0);
    expect(pspecCounts.shootSpecialLine).toBe(0);
    expect(of(s, MT.MT_PUFF)).toHaveLength(1);
    nearFixed(of(s, MT.MT_PUFF)[0]!.x, fx(252));
  });
});

/* ================================================================== */
/* 6. Weapon fire: P_Random stream pins                                */
/* ================================================================== */

describe('weapon fire streams (p_pspr.c spread + p_mobj.c impact draws)', () => {
  // Draw accounting, mirror-pinned: P_SpawnMobj draws ONCE per mobj
  // (p_mobj.c:506 `mobj->lastlook = P_Random() % MAXPLAYERS`), P_SpawnPuff/
  // Blood add 2 (the `(P_Random()-P_Random())<<10` z jitter) + 1 (the
  // `tics -= P_Random()&3` clamp) ⇒ 4 per impact; pGunShot draws 1 (damage)
  // or 3 (damage + the ±<<18 spread pair, p_pspr.c:633-637).
  const IMPACT_DRAWS = 4;

  function gun(weapon: number, extra: RectMapSpec['things'] = []) {
    const s = range(extra);
    const p = shooter(s);
    p.readyweapon = weapon;
    p.pendingweapon = weapon;
    p.weaponowned[weapon] = 1;
    p.ammo[AM_CLIP] = 50;
    p.ammo[AM_SHELL] = 20;
    p.ammo[AM_CELL] = 200;
    mClearRandom(s.rng);
    return { s, p };
  }
  const psp = (p: PsprPlayer) => p.psprites[0]!;
  const draws = (s: GameState, before: number): number => (s.rng.prndindex - before) & 255;

  it('pistol, first shot: 1 damage draw + one impact = 5', () => {
    const { s, p } = gun(WP_PISTOL);
    p.refire = 0;
    const before = s.rng.prndindex;
    aFirePistol(p, psp(p));
    expect(of(s, MT.MT_PUFF)).toHaveLength(1);
    expect(draws(s, before)).toBe(1 + IMPACT_DRAWS);
    expect(p.ammo[AM_CLIP]).toBe(49);
  });

  it('pistol, refire: the ±jitter pair adds exactly 2 draws', () => {
    const { s, p } = gun(WP_PISTOL);
    p.refire = 1;
    const before = s.rng.prndindex;
    aFirePistol(p, psp(p));
    expect(draws(s, before)).toBe(3 + IMPACT_DRAWS);
  });

  it('shotgun: 7 unaccurate pellets ⇒ 21 spread draws + 4 per impact', () => {
    const { s, p } = gun(WP_SHOTGUN);
    const before = s.rng.prndindex;
    aFireShotgun(p, psp(p));
    const impacts = of(s, MT.MT_PUFF).length + of(s, MT.MT_BLOOD).length;
    expect(impacts).toBeLessThanOrEqual(7);
    expect(draws(s, before)).toBe(21 + IMPACT_DRAWS * impacts);
    expect(p.ammo[AM_SHELL]).toBe(19);
  });

  it('CHAINGUN GAP (M7-07, documented): A_FireCGun never fires', () => {
    // weaponinfo[wp_chaingun].ammo == am_noammo (5). Vanilla reads
    // player->ammo[4] — i.e. one past ammo[NUMAMMO] into oldammo[0], so the
    // `if (!ammo[...]) return` guard is (luckily) false and the gun fires.
    // The port's ammo is an Int32Array(NUMAMMO), so index 5 is undefined ⇒
    // the guard is TRUE ⇒ the chaingun NEVER fires (0 draws, no impact).
    // Pinned here so the gap is visible; the fix is p_pspr.ts's business
    // (guard on `ammo !== am_noammo`), not M7-08's.
    const { s, p } = gun(WP_CHAINSAW);
    const before = s.rng.prndindex;
    aFireCGun(p, psp(p));
    expect(draws(s, before)).toBe(0);
    expect(of(s, MT.MT_PUFF)).toHaveLength(0);
    expect(p.ammo[AM_CELL]).toBe(200);
  });

  it('plasma: ONE draw for the flash variant, no hitscan damage', () => {
    const { s, p } = gun(WP_PLASMA);
    const before = s.rng.prndindex;
    // P_Random pre-increments (m_random.c:59) ⇒ the draw IS RNDTABLE[before+1].
    const wantFlash = WEAPONINFO[WP_PLASMA]!.flashstate + (RNDTABLE[(before + 1) & 255]! & 1);
    aFirePlasma(p, psp(p));
    expect(draws(s, before)).toBe(1);
    expect(p.psprites[PS_FLASH]!.state).toBe(wantFlash);
    expect(p.ammo[AM_CELL]).toBe(199);
    expect(s.hooks.damage.count).toBe(0);
    expect(psprHookCounts.spawnPlayerMissile).toBe(1); // M7-09 deferral
  });

  it('rocket and BFG: no P_Random at all (projectiles are M7-09)', () => {
    const a = gun(WP_MISSILE);
    a.p.ammo[AM_MISL] = 5;
    const before = a.s.rng.prndindex;
    aFireMissile(a.p, psp(a.p));
    expect(a.s.rng.prndindex).toBe(before);
    expect(a.p.ammo[AM_MISL]).toBe(4);
    expect(psprHookCounts.spawnPlayerMissile).toBe(1);

    const b = gun(WP_BFG);
    b.p.ammo[AM_CELL] = 50;
    const beforeB = b.s.rng.prndindex;
    aFireBFG(b.p, psp(b.p));
    expect(b.s.rng.prndindex).toBe(beforeB);
    expect(b.p.ammo[AM_CELL]).toBe(50 - BFGCELLS);
    expect(psprHookCounts.spawnPlayerMissile).toBe(2);
  });

  it('fists: damage+jitter draws, MELEERANGE, even damage, target turn', () => {
    const { s, p } = gun(WP_FIST, [{ x: 160, y: 145, angle: 0, type: 3004 }]);
    const before = s.rng.prndindex;
    const damageDraw = RNDTABLE[(before + 1) & 255]!; // P_Random pre-increments
    aPunch(p, psp(p));
    // blood counts as an impact, +1 for the victim's painChance roll
    // (p_inter.c:894) inside the live damage body — M8-05.
    expect(draws(s, before)).toBe(3 + IMPACT_DRAWS + 1);
    expect(attackRange.value).toBe(MELEERANGE);
    expect(s.hooks.damage.entries[0]!.amount).toBe(((damageDraw % 10) + 1) << 1);
    expect(s.hooks.damage.entries[0]!.amount % 2).toBe(0);
    expect(of(s, MT.MT_BLOOD)).toHaveLength(1);
  });

  it('a punch into a wall within MELEERANGE puffs the S_PUFF3 variant', () => {
    // Player 62 units from the east wall: the melee trace terminates on it.
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 512, h: 512 }],
      things: [{ x: 450, y: 128, angle: 0, type: 1 }],
    });
    const p = shooter(s);
    mClearRandom(s.rng);
    aPunch(p, psp(p));
    expect(attackRange.value).toBe(MELEERANGE);
    const puff = of(s, MT.MT_PUFF);
    expect(puff).toHaveLength(1);
    expect(puff[0]!.state).toBe(S.S_PUFF3); // "don't make punches spark"
    expect(s.hooks.damage.count).toBe(0); // a wall punch damages nothing
  });

  it('chainsaw melee uses MELEERANGE+1 (so the puff does not skip the flash)', () => {
    const { s, p } = gun(WP_CHAINSAW, [{ x: 160, y: 128, angle: 0, type: 3004 }]);
    mClearRandom(s.rng);
    aSaw(p, psp(p));
    expect(attackRange.value).toBe(MELEERANGE + 1);
    expect(of(s, MT.MT_BLOOD)).toHaveLength(1);
    expect(s.hooks.damage.count).toBe(1);
  });

  it('A_Punch turns the player to face the target (R_PointToAngle2)', () => {
    const { p } = gun(WP_FIST, [{ x: 160, y: 145, angle: 0, type: 3004 }]);
    const before = p.mo.angle;
    aPunch(p, psp(p));
    expect(psprHookCounts.pointToAngle2).toBeGreaterThan(0);
    expect(p.mo.angle).not.toBe(before);
    // R_PointToAngle2 itself — the four axes.
    expect(rPointToAngle2(0, 0, FRACUNIT, 0)).toBe(0);
    // Dead-north keeps vanilla's ±1 BAM: ang90 − R_PointToAngleInverse(0)
    // and the binary search bottoms out at 1, not 0 (pslide.ts pinned it).
    expect(rPointToAngle2(0, 0, 0, FRACUNIT)).toBe(ANG90 - 1);
    expect(rPointToAngle2(0, 0, -FRACUNIT, 0)).toBe((ANG180 - 1) >>> 0); // same −1
  });
});

/* ================================================================== */
/* 7. Impact mobj lifetime, zero-alloc, determinism                    */
/* ================================================================== */

describe('impact mobjs + determinism', () => {
  it('puff walks S_PUFF1→2→3→4 and is removed at state end', () => {
    const s = range();
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 5);
    const puff = of(s, MT.MT_PUFF)[0]!;
    expect(puff.state).toBe(S.S_PUFF1);
    const seen = [puff.state];
    for (let t = 0; t < 32 && !puff.removed; t++) {
      pRunThinkers(s.thinkers);
      if (!puff.removed) seen.push(puff.state);
    }
    expect(puff.removed).toBe(true);
    expect(seen).toContain(S.S_PUFF2);
    expect(seen).toContain(S.S_PUFF3);
    expect(seen).toContain(S.S_PUFF4);
    expect(of(s, MT.MT_PUFF)).toHaveLength(0);
  });

  it('blood rises at 2·FRACUNIT and dies on its own state end', () => {
    const s = range([{ x: 320, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    pLineAttack(p.mo, p.mo.angle, MISSILERANGE, 0, 20);
    const blood = of(s, MT.MT_BLOOD)[0]!;
    expect(blood.momz).toBe(2 * FRACUNIT);
    for (let t = 0; t < 64 && !blood.removed; t++) pRunThinkers(s.thinkers);
    expect(blood.removed).toBe(true);
  });

  it('zero allocation on the traverse path (module-static globals)', () => {
    const s = range([{ x: 320, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 20_000; i++) {
      pAimLineAttack(p.mo, (i * 2654435761) >>> 0, MISSILERANGE);
      pLineAttack(p.mo, (i * 2654435761) >>> 0, MISSILERANGE, 0, 0);
      if ((i & 63) === 0) pRunThinkers(s.thinkers); // recycle the puffs
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    expect(ms).toBeLessThan(10_000); // per-call garbage would GC-storm this
    expect(boundShootWorld()).toBe(s);
    expect(shootGlobals().attackrange).toBe(MISSILERANGE);
  });

  it('double-run: 400 scripted shots give the identical hash', () => {
    const run = (s: GameState): number => {
      const p = shooter(s);
      mClearRandom(s.rng);
      for (let t = 0; t < 400; t++) {
        if (t % 4 === 0) pLineAttack(p.mo, (t * 400009) >>> 0, MISSILERANGE, 0, 7);
        pRunThinkers(s.thinkers);
        s.leveltime++;
      }
      return hashState(s);
    };
    const mk = (): GameState =>
      range([
        { x: 300, y: 128, angle: 0, type: 2035 },
        { x: 360, y: 170, angle: 0, type: 3004 },
        { x: 420, y: 90, angle: 0, type: 3004 },
      ]);
    expect(run(mk())).toBe(run(mk()));
  });
});
