// sim/pplane.test.ts — M6-04 acceptance (plan §M6-04):
//  1) rollback-vs-stay matrix crush × direction × floor/ceiling incl. the
//     double-P_ChangeSector on the pastdest arm (the commented-out
//     `//return crushed;` pin: pastdest is returned even when blocked);
//  2) the ceiling-up `#if 0` pin (never blocked, never rolled back);
//  3) crush damage cadence `!(leveltime&3)` through the M6-01 damage slot
//     (stuck stub thing, MF_DROPPED removal, non-shootable pass-through),
//     blood-spray P_Random stream draws consumed;
//  4) pastdest/crushed/ok vs hand-derived tic tables;
//  5) P_ChangeSector blockbox iteration-vs-brute-force equivalence (seeded)
//     and the vanilla cell-loop visit order pin;
//  6) the live-sector seam: clipping reads the live SoA (M5 pipelines
//     unaffected while static — goldens unmoved, verified by the repo
//     golden --check suite; asserted here for seeding parity).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData, type RuntimeMap } from './map';
import { buildBlockMap } from './blockmap';
import {
  allocThingSlot,
  buildThingLinks,
  thingSetPosition,
  MF_SHOOTABLE,
  MF_SOLID,
  type ThingLinks,
} from './thinglinks';
import {
  MF_DROPPED,
  pChangeSector,
  pCheckPosition,
  pmapHookCounts,
  resetPmapHookCounts,
  tm,
  SectorLiveViewError,
  type Mover,
  type PMapWorld,
} from './pmap';
import { createLiveSectors } from './state';
import { createHookSlots } from './hooks';
import { createPrngState } from './prng';
import {
  DIR_DOWN,
  DIR_UP,
  PLANE_CEILING,
  PLANE_FLOOR,
  makePlaneContext,
  tMovePlane,
  type PlaneContext,
  type PlaneHost,
  type ResultE,
} from './pplane';

const FU = FRACUNIT;
const fx = (units: number): number => (units * FU) | 0;
const TALL = fx(56);
/** mapBuilder emits the VOID dummy sector FIRST (mapBuilder.ts:514) ⇒ room i is
 * sector i+1; every height write/sector arg in this file targets ROOM. */
const ROOM = 1;

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

interface Fixture {
  map: RuntimeMap;
  links: ThingLinks;
  host: PlaneHost;
  ctx: PlaneContext;
  world: PMapWorld;
  /** damageSlot event log */
  hooks: ReturnType<typeof createHookSlots>;
}

function fixture(spec: RectMapSpec): Fixture {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const map = buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
  const bm = buildBlockMap(map);
  const links = buildThingLinks(map, bm);
  const world: PMapWorld = { map, bm, links }; // live view NOT yet wired (lazy)
  resetPmapHookCounts(); // module-global counters are per-fixture in tests
  const host: PlaneHost = {
    pmap: world,
    sectors: createLiveSectors(map),
    hooks: createHookSlots(),
    rng: createPrngState(),
    leveltime: 0,
    players: [],
  };
  return { map, links, host, ctx: makePlaneContext(host), world, hooks: host.hooks };
}

/** One flat 320×128 room, ceiling 128, player start parked in a corner. */
function room(ceilingHeight = 128, floorHeight = 0): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 320, h: 128, ceilingHeight, floorHeight }],
    things: [{ x: 8, y: 8, type: 1 }],
  };
}

/** Room seeded with n barrels of custom height at x = 32 + i*48, y = 64. */
function barrelRow(n: number, ceilingHeight = 128): RectMapSpec & {
  _barrels: { x: number; y: number }[];
} {
  const barrels = Array.from({ length: n }, (_, i) => ({ x: 20 + i * 28, y: 64 }));
  return {
    rooms: [{ x: 0, y: 0, w: 320, h: 128, ceilingHeight }],
    things: [{ x: 8, y: 8, type: 1 }, ...barrels.map((b) => ({ x: b.x, y: b.y, type: 2035 }))],
    _barrels: barrels,
  } as RectMapSpec & { _barrels: { x: number; y: number }[] };
}

/** Set the barrel slots' collision height (mobjinfo stand-in for the test). */
function setThingHeights(f: Fixture, from: number, height: number): void {
  for (let s = from; s < f.links.staticCount; s++) f.links.height[s] = height;
}

/** Run the SAME plane step for `n` tics, threading host.leveltime like a tic
 * loop would; returns the result sequence. */
function runTics(
  f: Fixture,
  n: number,
  step: (tic: number) => ResultE,
  startTic = 0
): ResultE[] {
  const out: ResultE[] = [];
  for (let i = 0; i < n; i++) {
    f.host.leveltime = startTic + i;
    out.push(step(startTic + i));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1a. Result matrix — empty sector (no crushing involved)              */
/* ------------------------------------------------------------------ */

describe('T_MovePlane result matrix (empty sector)', () => {
  const cases: readonly { name: string; foc: number; dir: number; from: number; dest: number }[] = [
    { name: 'floor down', foc: PLANE_FLOOR, dir: DIR_DOWN, from: 128, dest: 0 },
    { name: 'floor up', foc: PLANE_FLOOR, dir: DIR_UP, from: 0, dest: 128 },
    { name: 'ceiling down', foc: PLANE_CEILING, dir: DIR_DOWN, from: 128, dest: 0 },
    { name: 'ceiling up', foc: PLANE_CEILING, dir: DIR_UP, from: 0, dest: 128 },
  ];

  for (const c of cases) {
    it(`${c.name}: ${c.from}→${c.dest} at 16/tic = 8×ok then pastdest`, () => {
      const f = fixture(room());
      if (c.foc === PLANE_FLOOR) f.host.sectors.floorZ[ROOM] = fx(c.from);
      else f.host.sectors.ceilingZ[ROOM] = fx(c.from);
      const heightAt = (): number =>
        c.foc === PLANE_FLOOR ? f.host.sectors.floorZ[ROOM]! : f.host.sectors.ceilingZ[ROOM]!;

      const step = (): ResultE =>
        tMovePlane(f.ctx, ROOM, fx(16), fx(c.dest), false, c.foc, c.dir);

      // hand-derived table: 8 stepping tics (128−16k never passes 0 until
      // k=8 lands exactly, `−speed < dest` still false), then the clamp arm
      // reports pastdest on the 9th call.
      const results = runTics(f, 9, step);
      expect(results.slice(0, 8)).toEqual(Array(8).fill('ok'));
      expect(results[8]).toBe('pastdest');
      expect(heightAt()).toBe(fx(c.dest));
      expect(f.hooks.damage.count).toBe(0);
    });

    it(`${c.name}: dest === current height reports pastdest immediately`, () => {
      const f = fixture(room());
      if (c.foc === PLANE_FLOOR) f.host.sectors.floorZ[ROOM] = fx(c.from);
      else f.host.sectors.ceilingZ[ROOM] = fx(c.from);
      const dest = c.from; // already there
      expect(tMovePlane(f.ctx, ROOM, fx(16), fx(dest), false, c.foc, c.dir)).toBe('pastdest');
    });
  }
});

/* ------------------------------------------------------------------ */
/* 1b. Rollback-vs-stay matrix with a stuck stub thing                  */
/* ------------------------------------------------------------------ */

describe('T_MovePlane rollback-vs-stay matrix (blocked sector)', () => {
  it('ceiling DOWN mid-move, crush=false: crushed + ROLLBACK + no damage', () => {
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, TALL);
    f.host.leveltime = 0; // cadence-open tic: damage WOULD fire if crush were on
    // descend to 48 (fits: 48 ≥ 56? 48 < 56 → this step is the failing one)
    f.host.sectors.ceilingZ[ROOM] = fx(48);
    const res = tMovePlane(f.ctx, ROOM, fx(8), fx(0), false, PLANE_CEILING, DIR_DOWN);
    expect(res).toBe('crushed');
    expect(f.host.sectors.ceilingZ[ROOM]).toBe(fx(48)); // rolled back
    expect(f.hooks.damage.count).toBe(0); // crush=false → no damage pass
  });

  it('ceiling DOWN mid-move, crush=true: crushed + STAYS at new height + 1 damage', () => {
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, TALL);
    f.host.sectors.ceilingZ[ROOM] = fx(48);
    f.host.leveltime = 0;
    const res = tMovePlane(f.ctx, ROOM, fx(8), fx(0), true, PLANE_CEILING, DIR_DOWN);
    expect(res).toBe('crushed');
    expect(f.host.sectors.ceilingZ[ROOM]).toBe(fx(40)); // crush-and-stay (no rollback)
    expect(f.hooks.damage.entries).toHaveLength(1);
    expect(f.hooks.damage.entries[0]).toMatchObject({ thing: 0, amount: 10, source: null, tic: 0 });
    expect(f.ctx.rng.prndindex).toBe(4); // 4 blood draws (p_map.c:1303-1308)
  });

  it('ceiling DOWN pastdest, crush=true: rollback, SECOND P_ChangeSector, pastdest', () => {
    // p_floor.c ceiling-down past-dest arm with the `//return crushed;` pin:
    // blocked AT dest still returns pastdest and rolls back. Height 48: the
    // gap fails at dest 44 but FITS again at the rolled-back lastpos 48 —
    // so the second P_ChangeSector pass is the clip UNDO (no damage).
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, fx(48));
    f.host.sectors.ceilingZ[ROOM] = fx(48);
    f.host.leveltime = 0;
    const res = tMovePlane(f.ctx, ROOM, fx(16), fx(44), true, PLANE_CEILING, DIR_DOWN);
    expect(res).toBe('pastdest'); // ← the commented-out `return crushed` pin
    expect(f.host.sectors.ceilingZ[ROOM]).toBe(fx(48)); // rolled back to lastpos
    // Double P_ChangeSector: first pass (at 44: nofit → damage at tic 0),
    // second pass at the RESTORED height (fits → clip undo, no damage).
    expect(f.hooks.damage.entries).toHaveLength(1);
    expect(f.hooks.damage.count).toBe(1);
  });

  it('floor UP mid-move, crush=false: crushed + ROLLBACK', () => {
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, TALL);
    f.host.sectors.floorZ[ROOM] = fx(64); // gap = 128−64 = 64 ≥ 56 fits; +8 → 56 fits!
    // go two steps: 64→72 gap 56 (fits, >=), 72→80 gap 48 blocks
    expect(tMovePlane(f.ctx, ROOM, fx(8), fx(200), false, PLANE_FLOOR, DIR_UP)).toBe('ok');
    f.host.leveltime = 1;
    expect(tMovePlane(f.ctx, ROOM, fx(8), fx(200), false, PLANE_FLOOR, DIR_UP)).toBe('crushed');
    expect(f.host.sectors.floorZ[ROOM]).toBe(fx(72)); // rolled back
  });

  it('floor UP mid-move, crush=true: crushed + STAYS (crush-return before rollback)', () => {
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, TALL);
    f.host.sectors.floorZ[ROOM] = fx(72);
    f.host.leveltime = 4; // cadence-open
    expect(tMovePlane(f.ctx, ROOM, fx(8), fx(200), true, PLANE_FLOOR, DIR_UP)).toBe('crushed');
    expect(f.host.sectors.floorZ[ROOM]).toBe(fx(80)); // stays (no rollback arm reached)
    expect(f.hooks.damage.count).toBe(1);
  });

  it('floor DOWN mid-move with a blocker: ALWAYS rolls back (no crush-stay arm)', () => {
    // p_floor.c floor-down arm has NO `if (crush) return crushed;` shortcut:
    // even crush=true rolls back (damage still fired in the first pass).
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, TALL);
    // hang the thing from a low ceiling so lowering the floor strands it:
    // z floats (ceilingz-height), floor drops, gap stays ceiling-floor...
    // Simplest guaranteed floor-down nofit: floor BELOW thing? P_ThingHeightClip
    // fails iff ceiling−floor < height — so set the ceiling low first.
    f.host.sectors.ceilingZ[ROOM] = fx(40); // gap 40 < 56 — everything fails to fit
    f.host.leveltime = 0;
    expect(tMovePlane(f.ctx, ROOM, fx(8), fx(-1000), true, PLANE_FLOOR, DIR_DOWN)).toBe('crushed');
    expect(f.host.sectors.floorZ[ROOM]).toBe(0); // rolled back
    // Both P_ChangeSector passes still fail to fit (ceiling 40 the whole
    // time) → damaged TWICE on the same open tic: p_map.c has no per-tic
    // dedup, 2 events is the vanilla truth.
    expect(f.hooks.damage.count).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Ceiling-up `#if 0` pin                                            */
/* ------------------------------------------------------------------ */

describe('ceiling-up never blocks (p_floor.c #if 0 pin)', () => {
  it('blocked, crush=false: result ok, NO rollback, height advanced', () => {
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, fx(256));
    f.host.sectors.ceilingZ[ROOM] = 0;
    f.host.leveltime = 0;
    const res = tMovePlane(f.ctx, ROOM, fx(8), fx(200), false, PLANE_CEILING, DIR_UP);
    expect(res).toBe('ok'); // nofit was TRUE (sectorCrush consumed it) but ignored
    expect(f.host.sectors.ceilingZ[ROOM]).toBe(fx(8)); // never rolled back
    expect(f.hooks.damage.count).toBe(0);
  });

  it('blocked, crush=true: damage still fires (P_ChangeSector runs), still ok, no rollback', () => {
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, fx(256));
    f.host.sectors.ceilingZ[ROOM] = 0;
    f.host.leveltime = 0;
    const res = tMovePlane(f.ctx, ROOM, fx(8), fx(200), true, PLANE_CEILING, DIR_UP);
    expect(res).toBe('ok');
    expect(f.host.sectors.ceilingZ[ROOM]).toBe(fx(8));
    expect(f.hooks.damage.count).toBe(1);
  });

  it('pastdest arm still rolls back like every other arm', () => {
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, fx(256));
    f.host.sectors.ceilingZ[ROOM] = fx(120);
    f.host.leveltime = 0;
    expect(tMovePlane(f.ctx, ROOM, fx(16), fx(128), false, PLANE_CEILING, DIR_UP)).toBe('pastdest');
    expect(f.host.sectors.ceilingZ[ROOM]).toBe(fx(120)); // blocked → rolled back, pastdest
  });
});

/* ------------------------------------------------------------------ */
/* 3. Crush cadence golden + DROPPED/non-shootable branches             */
/* ------------------------------------------------------------------ */

describe('crush model (PIT_ChangeSector via the damage slot)', () => {
  it('stuck crusher: damage only on !(leveltime&3) tics, 4 P_Random per event', () => {
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, TALL);
    f.host.sectors.ceilingZ[ROOM] = fx(48); // every step from here fails to fit
    const results = runTics(f, 16, () =>
      tMovePlane(f.ctx, ROOM, fx(8), fx(0), true, PLANE_CEILING, DIR_DOWN)
    );
    // Hand-derived: crush-and-stay arms until the past-dest clamp arm.
    // 48→40..8 stay-crushed, at 8: 8−8=0 < 0? NO → step to 0, fails, stay;
    // next call 0−8 < 0 → clamp arm: rollback(0)→pastdest forever after.
    expect(results.slice(0, 6)).toEqual(Array(6).fill('crushed'));
    expect(results[6]).toBe('pastdest');
    expect(results.slice(6)).toEqual(Array(10).fill('pastdest'));
    // Damage tics: the crush arm (1 call/tic) at t=0..5 (cadence tics 0,4),
    // the clamp arm (rollback → 2nd pass fits again at lastpos 0? gap 0−0 →
    // still blocked → 2nd pass damages too at open tics 8,12).
    const tics = f.hooks.damage.entries.map((e) => e.tic);
    expect(tics.filter((t) => t % 4 === 0)).toEqual(tics); // ONLY cadence tics
    expect(tics).toEqual([0, 4, 8, 8, 12, 12]);
    expect(f.hooks.damage.entries.every((e) => e.amount === 10 && e.source === null)).toBe(true);
    expect(pmapHookCounts.crushBlood).toBe(f.hooks.damage.count);
    expect(f.ctx.rng.prndindex).toBe(4 * f.hooks.damage.count);
    // The kill model (M6-plan §4): damage SLOT only — no death/gibs pre-M7.
    expect(pmapHookCounts.crushGib).toBe(0);
  });
  it('MF_DROPPED thing is removed (kept checking, never blocks, no damage)', () => {
    const f = fixture(barrelRow(2));
    setThingHeights(f, 0, TALL);
    // slot 0 = dropped item (shootable+dropped), slot 1 = barrel blocker
    f.links.flags[0] = MF_SOLID | MF_SHOOTABLE | MF_DROPPED;
    f.host.sectors.ceilingZ[ROOM] = fx(32); // gap 32 < 42: everything fails to fit
    f.host.leveltime = 0;
    const res = pChangeSector(f.ctx, ROOM, true);
    expect(res).toBe(true); // the barrel blocked
    expect(pmapHookCounts.crushDroppedRemoved).toBe(1);
    expect(f.links.linked[0]).toBe(0); // unlinked from the grid
    expect(f.links.flags[0]! & (MF_SOLID | MF_SHOOTABLE)).toBe(0);
    expect(f.hooks.damage.entries.map((e) => e.thing)).toEqual([1]); // barrel only
    // A repeat pass no longer sees the removed thing:
    const before = f.hooks.damage.count;
    expect(pChangeSector(f.ctx, ROOM, true)).toBe(true);
    expect(f.hooks.damage.count).toBe(before + 1);
  });
  it('non-shootable thing passes: no damage, no block (bloody-gibs branch)', () => {
    const f = fixture(barrelRow(1));
    setThingHeights(f, 0, fx(56));
    f.links.flags[0] = MF_SOLID; // decor: solid, NOT shootable
    f.host.sectors.ceilingZ[ROOM] = fx(40);
    f.host.leveltime = 0;
    expect(pChangeSector(f.ctx, ROOM, true)).toBe(false); // nothing blocked
    expect(f.hooks.damage.count).toBe(0);
    expect(pmapHookCounts.crushClipOk).toBe(0); // failed the clip, passed the gate
  });
});

/* ------------------------------------------------------------------ */
/* 4. Crusher tic table (family-facing contract)                        */
/* ------------------------------------------------------------------ */

describe('pastdest/crushed/ok vs hand-derived tic table', () => {
  it('empty crusher hall 128→0 @8: 15×ok → crushed?no → 16th steps to 0, 17th pastdest', () => {
    const f = fixture(room());
    const results = runTics(f, 17, () =>
      tMovePlane(f.ctx, ROOM, fx(8), fx(0), false, PLANE_CEILING, DIR_DOWN)
    );
    expect(results.filter((r) => r === 'ok')).toHaveLength(16);
    expect(results[16]).toBe('pastdest');
    expect(f.host.sectors.ceilingZ[ROOM]).toBe(0);
  });

  it('door-shaped step: 168 units @2 = 84 ok then pastdest (M6-05 timing input)', () => {
    const f = fixture(room());
    f.host.sectors.ceilingZ[ROOM] = 0;
    let ok = 0;
    for (let i = 0; i < 200; i++) {
      f.host.leveltime = i;
      const r = tMovePlane(f.ctx, ROOM, fx(2), fx(168), false, PLANE_CEILING, DIR_UP);
      if (r === 'ok') ok++;
      else {
        expect(r).toBe('pastdest');
        break;
      }
    }
    expect(ok).toBe(84);
    expect(f.host.sectors.ceilingZ[ROOM]).toBe(fx(168));
  });
});

/* ------------------------------------------------------------------ */
/* 5. P_ChangeSector iteration order vs brute force (seeded)            */
/* ------------------------------------------------------------------ */

/** Deterministic xorshift32 (test-local; Math.random is banned §3.5). */
function xorshift(seed: number): () => number {
  let s = seed | 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s |= 0; s ^= s >>> 17; s ^= s << 5; s |= 0;
    return (s >>> 0) / 0x100000000;
  };
}

describe('P_ChangeSector blockbox loop', () => {
  it('seeded property: nofit + damage set == brute-force all-things scan (40 seeds)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = xorshift(seed * 7919);
      const n = 3 + Math.floor(rnd() * 5);
      const spec = barrelRow(n);
      const f = fixture(spec);
      setThingHeights(f, 0, fx(56));
      const newCeil = fx(Math.floor(rnd() * 96)); // random post-change ceiling
      f.host.sectors.ceilingZ[ROOM] = newCeil;
      f.host.leveltime = 0;
      resetPmapHookCounts();
      const got = pChangeSector(f.ctx, ROOM, false);

      // Brute force (independent of the grid): single-sector fixture ⇒ the
      // clip formula is ceiling − floor ≥ height per thing.
      let want = false;
      const blocked: number[] = [];
      for (let s = 0; s < f.links.staticCount; s++) {
        if (((newCeil - f.host.sectors.floorZ[ROOM]!) | 0) < f.links.height[s]!) {
          want = true;
          blocked.push(s);
        }
      }
      expect(got, `seed ${seed} nofit`).toBe(want);
      expect(f.hooks.damage.count, `seed ${seed} damage 0 (crush off)`).toBe(0);

      // crush ON at an open tic: exactly the blocked set damaged once.
      if (seed % 3 === 0) {
        f.host.sectors.ceilingZ[ROOM] = newCeil + fx(200); // fit again
        resetPmapHookCounts();
        f.host.sectors.ceilingZ[ROOM] = newCeil;
        f.host.leveltime = 0;
        pChangeSector(f.ctx, ROOM, true);
        expect(new Set(f.hooks.damage.entries.map((e) => e.thing)), `seed ${seed} ids`).toEqual(
          new Set(blocked)
        );
      }
    }
  });

  it('visit order pin: x-outer/y-inner cell loop over the blockbox, dynamic chain first', () => {
    // Two barrels far apart (different block columns) + one dynamic mover:
    // vanilla visits per cell (dynamic chain then static CSR), x outer / y
    // inner, so the damage ORDER is cell-major, not THINGS-major.
    const spec: RectMapSpec = {
      rooms: [{ x: 0, y: 0, w: 320, h: 128 }],
      things: [
        { x: 8, y: 8, type: 1 },
        { x: 300, y: 64, type: 2035 }, // THINGS order: right barrel FIRST…
        { x: 20, y: 64, type: 2035 }, // …left barrel second
      ],
    };
    const f = fixture(spec);
    // mover in the same left-hand cell as slot 2 (dynamic chains visit first)
    const slot = allocThingSlot(f.links, fx(16), fx(56), MF_SOLID | MF_SHOOTABLE);
    thingSetPosition(f.links, slot, fx(24), fx(64));
    f.host.sectors.ceilingZ[ROOM] = fx(40);
    f.host.leveltime = 0;
    pChangeSector(f.ctx, ROOM, true);
    const ids = f.hooks.damage.entries.map((e) => e.thing);
    // left cell (x block 0) before right cell; within it: dynamic slot then
    // static CSR (reverse THINGS order ⇒ slot 2 before slot 1).
    expect(ids).toEqual([slot, 1, 0]);
  });
});

/* ------------------------------------------------------------------ */
/* 6. Live-sector seam + mover registry                                 */
/* ------------------------------------------------------------------ */

describe('live SoA seam', () => {
  it('createLiveSectors starts value-identical to the static SoA (goldens safe)', () => {
    const f = fixture(room(160, 12));
    expect(Array.from(f.host.sectors.floorZ)).toEqual(Array.from(f.map.sectors.floorHeight));
    expect(Array.from(f.host.sectors.ceilingZ)).toEqual(Array.from(f.map.sectors.ceilingHeight));
  });

  it('pCheckPosition seeds from the LIVE arrays once wired (heights drive clipping)', () => {
    const f = fixture(room());
    f.world.sectors = f.host.sectors;
    f.host.sectors.ceilingZ[ROOM] = fx(200);
    f.host.sectors.floorZ[ROOM] = fx(4);
    const probe: Mover = { x: fx(160), y: fx(64), z: 0, radius: fx(16), height: fx(56), flags: 0 };
    pCheckPosition(f.world, probe, probe.x, probe.y);
    expect(tm.tmceilingz).toBe(fx(200));
    expect(tm.tmfloorz).toBe(fx(4));
  });

  it('pChangeSector wires the live view lazily and rejects a mismatch', () => {
    const f = fixture(room());
    expect(f.world.sectors).toBeUndefined();
    pChangeSector(f.ctx, ROOM, false);
    expect(f.world.sectors).toBe(f.host.sectors);
    const other = createLiveSectors(f.map);
    const alien: PlaneContext = { ...f.ctx, sectors: other };
    expect(() => pChangeSector(alien, ROOM, false)).toThrow(SectorLiveViewError);
  });

  it('registered movers clip via the MOVER object (floorz/ceilingz/z + z mirrored to SoA)', () => {
    const f = fixture(room());
    const mo: Mover = {
      x: fx(160), y: fx(64), z: 0, radius: fx(16), height: fx(56),
      flags: MF_SOLID | MF_SHOOTABLE, floorz: 0, ceilingz: fx(128),
    };
    const slot = allocThingSlot(f.links, mo.radius, mo.height, mo.flags);
    mo.linkSlot = slot;
    thingSetPosition(f.links, slot, mo.x, mo.y);
    const host: PlaneHost = { ...f.host, players: [{ mo }] };
    const ctx = makePlaneContext(host);
    f.host.sectors.ceilingZ[ROOM] = fx(40); // gap 40 < 56
    ctx.leveltime = 0;
    expect(pChangeSector(ctx, ROOM, true)).toBe(true);
    expect(mo.floorz).toBe(0);
    expect(mo.ceilingz).toBe(fx(40));
    expect(mo.z).toBe(0); // onfloor ⇒ rides the floor (unchanged here)
    expect(f.links.z[slot]).toBe(0); // SoA mirror updated
    expect(f.hooks.damage.entries[0]!.thing).toBe(slot);
  });
});
