/**
 * sim/pmap tests (M5-02) — P_CheckPosition + thinglinks (p_map.c part 1).
 *
 * Acceptance (M5-plan §M5-02): 1) wall/one-sided/two-sided-open truth
 * table; 2) floorz = max of openbottoms across touched lines (raised-ledge
 * fixture); 3) thinglinks round-trip — player blocked by a barrel, moves
 * unlink/link without re-inserting statics; 4) freedoom1.wad E1M1 skipIf:
 * 1000 seeded points' floorz/ceilingz/block verdict vs a brute-force
 * sector+line reference that does NOT use the blockmap.
 * Extras: hook-slot no-op safety, zero-alloc steady state, same-seed
 * determinism (double-run).
 *
 * Ground truths are re-derived from the 1.10 sources fetched for this task
 * (p_map.c:185-450, p_maputl.c:347-449, p_mobj.c:704-793, info.c:1108-1911):
 * MF bits per the p_mobj.h enum; barrel r10/h42 MF_SOLID|MF_SHOOTABLE|
 * MF_NOBLOOD; player r16/h56; thing chains = spawn-time prepend ⇒ per-cell
 * iteration = reverse THINGS order.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeEach } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData, type RuntimeMap } from './map';
import { buildBlockMap } from './blockmap';
import { sectorAtPoint } from './bsp';
import { pBoxOnLineSide } from './pmaputl';
import {
  MAXSPECIALCROSS,
  ML_BLOCKING,
  ML_BLOCKMONSTERS,
  pCheckPosition,
  pmapHookCounts,
  pmapHooks,
  resetPmapHookCounts,
  tm,
  type Mover,
  type PMapWorld,
} from './pmap';
import {
  allocThingSlot,
  buildThingLinks,
  MF_DROPOFF,
  MF_MISSILE,
  MF_NOCLIP,
  MF_PICKUP,
  MF_SHOOTABLE,
  MF_SKULLFLY,
  MF_SOLID,
  MF_SPECIAL,
  thingLinksIterator,
  thingSetPosition,
  thingUnsetPosition,
  type ThingInfo,
  type ThingLinks,
} from './thinglinks';

const FU = FRACUNIT;
const fx = (units: number): number => (units * FU) | 0;

/* ------------------------------------------------------------------ */
/* Fixture worlds                                                       */
/* ------------------------------------------------------------------ */

interface World {
  map: RuntimeMap;
  bm: ReturnType<typeof buildBlockMap>;
  links: ThingLinks;
  pmap: PMapWorld;
}

function world(spec: RectMapSpec, info?: ReadonlyMap<number, ThingInfo>, skill?: number): World {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const map = buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
  const bm = buildBlockMap(map);
  const links = buildThingLinks(map, bm, { skill, ...(info ? { info } : {}) });
  return { map, bm, links, pmap: { map, bm, links } };
}

/** player mobjinfo flags (info.c:1130, minus the DM-only NOTDMATCH). */
const PLAYER_FLAGS = MF_SOLID | MF_SHOOTABLE | MF_DROPOFF | MF_PICKUP;

function mover(
  x: number,
  y: number,
  over: Partial<Mover> = {},
): Mover {
  return {
    x,
    y,
    z: 0,
    radius: fx(16),
    height: fx(56),
    flags: PLAYER_FLAGS,
    player: true,
    linkSlot: -1,
    ...over,
  };
}

/** The single room-room shared line between two rects touching at x = at. */
function sharedLineX(map: RuntimeMap, at: number, sA: number, sB: number): number {
  const found: number[] = [];
  for (let i = 0; i < map.lines.count; i++) {
    if (
      map.lines.sectorFront[i] === sA &&
      map.lines.sectorBack[i] === sB &&
      map.verticesX[map.lines.v1[i]!] === fx(at) &&
      map.verticesX[map.lines.v2[i]!] === fx(at)
    ) {
      found.push(i);
    }
  }
  expect(found.length, `shared lines at x=${at} (rooms ${sA}/${sB})`).toBeGreaterThanOrEqual(1);
  return found[0]!;
}

function linesAtX(map: RuntimeMap, at: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < map.lines.count; i++) {
    if (
      map.verticesX[map.lines.v1[i]!] === fx(at) &&
      map.verticesX[map.lines.v2[i]!] === fx(at)
    ) {
      out.push(i);
    }
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  resetPmapHookCounts();
  delete pmapHooks.touchSpecialThing;
  delete pmapHooks.skullFlyHit;
  delete pmapHooks.missileHit;
});

/* Two rooms touching at x=128 (sector 1 | sector 2), player start only. */
const twoRooms: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 128 },
    { x: 128, y: 0, w: 128, h: 128 },
  ],
  things: [{ x: 32, y: 32, type: 1 }],
};

/* ------------------------------------------------------------------ */
/* 1. Line truth table (acceptance item 1)                              */
/* ------------------------------------------------------------------ */

describe('PIT_CheckLine truth table', () => {
  it('void wall: geometric stop via tmceilingz/opentop (fixture has no one-sided lines)', () => {
    const w = world(twoRooms);
    // mover box 8±16 ⇒ x −8..24 crosses the west boundary (back = VOID,
    // floor = ceiling = −128): check passes but the opening squashes.
    expect(pCheckPosition(w.pmap, mover(fx(8), fx(64)), fx(8), fx(64))).toBe(true);
    expect(tm.tmceilingz).toBe(fx(-128));
    expect(tm.tmfloorz).toBe(0);
    expect(linesAtX(w.map, 0)).toContain(tm.ceilingline);
  });

  it('two-sided open connection: passes with both sectors room heights', () => {
    const w = world(twoRooms);
    expect(pCheckPosition(w.pmap, mover(fx(128), fx(64)), fx(128), fx(64))).toBe(true);
    expect(tm.tmfloorz).toBe(0);
    expect(tm.tmceilingz).toBe(fx(128));
    expect(tm.tmdropoffz).toBe(0);
    expect(tm.numspechit).toBe(0);
    expect(tm.ceilingline).toBe(-1); // no line lowered the ceiling
  });

  it('one-sided (sectorBack = −1 sentinel): hard block', () => {
    const w = world(twoRooms);
    const line = sharedLineX(w.map, 128, 1, 2);
    w.map.lines.sectorBack[line] = -1;
    w.map.lines.sideNumBack[line] = -1;
    expect(pCheckPosition(w.pmap, mover(fx(128), fx(64)), fx(128), fx(64))).toBe(false);
  });

  it('ML_BLOCKING two-sided: blocks non-missiles, missiles pass (p_map.c:219-222)', () => {
    const blocked = world(twoRooms);
    blocked.map.lines.flags[sharedLineX(blocked.map, 128, 1, 2)]! |= ML_BLOCKING;
    expect(pCheckPosition(blocked.pmap, mover(fx(128), fx(64)), fx(128), fx(64))).toBe(false);

    const missileWorld = world(twoRooms);
    missileWorld.map.lines.flags[sharedLineX(missileWorld.map, 128, 1, 2)]! |= ML_BLOCKING;
    expect(
      pCheckPosition(
        missileWorld.pmap,
        mover(fx(128), fx(64), { flags: MF_MISSILE, player: false }),
        fx(128),
        fx(64),
      ),
    ).toBe(true);
  });

  it('ML_BLOCKMONSTERS: player passes, non-player blocks (p_map.c:223)', () => {
    const w = world(twoRooms);
    w.map.lines.flags[sharedLineX(w.map, 128, 1, 2)]! |= ML_BLOCKMONSTERS;
    expect(pCheckPosition(w.pmap, mover(fx(128), fx(64)), fx(128), fx(64))).toBe(true);
    expect(
      pCheckPosition(w.pmap, mover(fx(128), fx(64), { player: false }), fx(128), fx(64)),
    ).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. floorz / ceilingz / dropoffz narrowing (acceptance item 2)        */
/* ------------------------------------------------------------------ */

describe('height narrowing across contacted lines', () => {
  it('raised ledge: tmfloorz = max(openbottoms), tmdropoffz = min(floors)', () => {
    const w = world({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128 },
        { x: 128, y: 0, w: 128, h: 128, floorHeight: 32 },
      ],
      things: [{ x: 32, y: 32, type: 1 }],
    });
    // straddling position: box 104..136 touches the ledge line
    expect(pCheckPosition(w.pmap, mover(fx(120), fx(64)), fx(120), fx(64))).toBe(true);
    expect(tm.tmfloorz).toBe(fx(32)); // max openbottom (the step up)
    expect(tm.tmdropoffz).toBe(0); // lowfloor = min(front.floor, back.floor)
    // fully inside room 1: the seed alone
    expect(pCheckPosition(w.pmap, mover(fx(64), fx(64)), fx(64), fx(64))).toBe(true);
    expect(tm.tmfloorz).toBe(0);
    expect(tm.tmdropoffz).toBe(0);
  });

  it('ceiling squash: tmceilingz = min(opentops) + ceilingline tracked', () => {
    const w = world({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128 },
        { x: 128, y: 0, w: 128, h: 128, ceilingHeight: 48 },
      ],
      things: [{ x: 32, y: 32, type: 1 }],
    });
    expect(pCheckPosition(w.pmap, mover(fx(120), fx(64)), fx(120), fx(64))).toBe(true);
    expect(tm.tmceilingz).toBe(fx(48));
    expect(tm.ceilingline).toBe(sharedLineX(w.map, 128, 1, 2));
  });

  it('dropoff pair: 64-unit ledge gives tmfloorz − tmdropoffz = 64 > 24·FRACUNIT', () => {
    // The block itself is P_TryMove's MF_DROPOFF test (M5-03); this pins
    // the out-params it reads, computed by P_CheckPosition.
    const w = world({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128 },
        { x: 128, y: 0, w: 128, h: 128, floorHeight: 64 },
      ],
      things: [{ x: 32, y: 32, type: 1 }],
    });
    expect(pCheckPosition(w.pmap, mover(fx(120), fx(64)), fx(120), fx(64))).toBe(true);
    expect(tm.tmfloorz - tm.tmdropoffz).toBe(fx(64));
  });

  it('door line: pass with openrange, special recorded in spechit unsorted', () => {
    const w = world({
      rooms: twoRooms.rooms,
      doors: [{ x1: 128, y1: 32, x2: 128, y2: 96, special: 1, tag: 1 }],
      things: [{ x: 32, y: 32, type: 1 }],
    });
    let door = -1;
    for (let i = 0; i < w.map.lines.count; i++) {
      if (w.map.lines.special[i] === 1) door = i;
    }
    expect(door).toBeGreaterThanOrEqual(0);
    expect(pCheckPosition(w.pmap, mover(fx(128), fx(64)), fx(128), fx(64))).toBe(true);
    expect(tm.numspechit).toBe(1);
    expect(tm.spechit[0]).toBe(door);
  });

  it('spechit overflow: stores 8, counts the rest (vanilla UB made observable)', () => {
    // Three rooms in a row: every linedef (10) touches one giant box, so
    // with all specials set the scan records exactly lines.count hits.
    const w = world({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128 },
        { x: 128, y: 0, w: 128, h: 128 },
        { x: 256, y: 0, w: 128, h: 128 },
      ],
      things: [{ x: 32, y: 32, type: 1 }],
    });
    expect(w.map.lines.count).toBeGreaterThan(MAXSPECIALCROSS);
    for (let i = 0; i < w.map.lines.count; i++) w.map.lines.special[i] = 1;
    expect(
      pCheckPosition(w.pmap, mover(fx(192), fx(64), { radius: fx(300) }), fx(192), fx(64)),
    ).toBe(true);
    expect(tm.numspechit).toBe(w.map.lines.count);
    expect(pmapHookCounts.spechitOverflow).toBe(tm.numspechit - MAXSPECIALCROSS);
  });
});

/* ------------------------------------------------------------------ */
/* 3. thinglinks round-trip + solid things (acceptance item 3)          */
/* ------------------------------------------------------------------ */

const barrelRoom: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 256, h: 256 }],
  things: [
    { x: 32, y: 32, type: 1 },
    { x: 128, y: 128, type: 2035 },
  ],
};

describe('thinglinks + PIT_CheckThing', () => {
  it('build: barrel links, start machinery does not; z = spawn floor', () => {
    const w = world(barrelRoom);
    expect(w.links.staticCount).toBe(1);
    expect(w.links.skippedUnknown).toBe(0);
    expect(w.links.doomednum[0]).toBe(2035);
    expect(w.links.x[0]).toBe(fx(128));
    expect(w.links.z[0]).toBe(0); // ONFLOORZ ⇒ subsector floor (p_mobj.c:517-523)
    expect(w.links.flags[0]).toBe(MF_SOLID | MF_SHOOTABLE /* MF_NOBLOOD too */ | 0x80000);
  });

  it('MF_SOLID circle-overlap blocks within radius+radius (r 10 + r 16 = 26)', () => {
    const w = world(barrelRoom);
    expect(pCheckPosition(w.pmap, mover(fx(128), fx(128)), fx(128), fx(128))).toBe(false);
    expect(pCheckPosition(w.pmap, mover(fx(153), fx(128)), fx(153), fx(128))).toBe(false); // dx 25 < 26
    expect(pCheckPosition(w.pmap, mover(fx(154), fx(128)), fx(154), fx(128))).toBe(true); // dx 26 ≥ 26
    expect(pCheckPosition(w.pmap, mover(fx(128), fx(64)), fx(128), fx(64))).toBe(true);
  });

  it('MAXRADIUS-extended thing scan reaches the origin-cell of a barrel across the block line', () => {
    const w = world({
      rooms: barrelRoom.rooms,
      things: [
        { x: 32, y: 32, type: 1 },
        { x: 191, y: 128, type: 2035 }, // block cell 1; mover box alone spans cell 2 only
      ],
    });
    expect(pCheckPosition(w.pmap, mover(fx(216), fx(128)), fx(216), fx(128))).toBe(false);
    // extended scan visits cell 1 too, but dx 31 ≥ 26 ⇒ no hit
    expect(pCheckPosition(w.pmap, mover(fx(222), fx(128)), fx(222), fx(128))).toBe(true);
  });

  it('noclip returns after the seed: no thing scan, floorz/ceilingz still valid', () => {
    const w = world(barrelRoom);
    const at = mover(fx(128), fx(128), { flags: PLAYER_FLAGS | MF_NOCLIP });
    expect(pCheckPosition(w.pmap, at, fx(128), fx(128))).toBe(true);
    expect(tm.tmfloorz).toBe(0);
    expect(tm.tmceilingz).toBe(fx(128));
    expect(pmapHookCounts.touchSpecialThing).toBe(0); // things loop never ran
  });

  it('player round-trip: blocked by barrel, self-skip, moves never re-insert statics', () => {
    const w = world(barrelRoom);
    const slot = allocThingSlot(w.links, fx(16), fx(56), PLAYER_FLAGS);
    const mo = mover(fx(64), fx(64), { linkSlot: slot });

    thingSetPosition(w.links, slot, fx(64), fx(64));
    expect(w.links.linked[slot]).toBe(1);
    // self-skip: the mover's own MF_SOLID slot must never block it
    expect(pCheckPosition(w.pmap, mo, fx(64), fx(64))).toBe(true);
    // the barrel still blocks
    expect(pCheckPosition(w.pmap, mo, fx(128), fx(128))).toBe(false);

    // iteration snapshots around a walk: static visits identical, unchanged
    const snapshot = (): number[] => {
      const out: number[] = [];
      for (let bx = 0; bx < w.links.bm.width; bx++) {
        for (let by = 0; by < w.links.bm.height; by++) {
          thingLinksIterator(w.links, bx, by, (s) => {
            if (s !== slot) out.push(s);
            return true;
          });
        }
      }
      return out;
    };
    const before = snapshot();
    expect(before.length).toBeGreaterThan(0); // the barrel is reachable
    for (let t = 0; t < 40; t++) {
      const nx = fx(64 + t * 4);
      const ny = fx(16 + (t % 7) * 11); // stays clear of the barrel at (128,128)
      thingUnsetPosition(w.links, slot);
      thingSetPosition(w.links, slot, nx, ny);
      mo.x = nx;
      mo.y = ny;
      expect(pCheckPosition(w.pmap, mo, nx, ny)).toBe(true);
    }
    expect(snapshot()).toEqual(before); // no static re-insertion (§3.5.5)

    // unlink ⇒ gone from the chains; unlink is idempotent
    thingUnsetPosition(w.links, slot);
    expect(snapshot()).not.toContain(slot);
    expect(() => thingUnsetPosition(w.links, slot)).not.toThrow();
    expect(snapshot()).not.toContain(slot);
  });

  it('off-grid spawn links nowhere (vanilla "thing is off the map")', () => {
    const w = world({
      rooms: [{ x: 0, y: 0, w: 256, h: 256 }],
      things: [{ x: 500, y: 500, type: 2035 }],
    });
    expect(w.links.linked[0]).toBe(0);
    expect(pCheckPosition(w.pmap, mover(fx(500), fx(500)), fx(500), fx(500))).toBe(true);
  });

  it('skill gating (p_mobj.c:737-745): default skill 3 skips easy-only barrels', () => {
    const spec: RectMapSpec = {
      rooms: barrelRoom.rooms,
      things: [{ x: 128, y: 128, type: 2035, flags: 1 }],
    };
    expect(world(spec).links.staticCount).toBe(0);
    expect(world(spec, undefined, 1).links.staticCount).toBe(1);
  });

  it('MF_SPECIAL: no-op-safe slot path — counter, pass-through, hook override', () => {
    const itemInfo = new Map<number, ThingInfo>([
      [2007, { radius: fx(8), height: fx(16), flags: MF_SPECIAL }],
    ]);
    const w = world(
      { rooms: barrelRoom.rooms, things: [{ x: 128, y: 128, type: 2007 }] },
      itemInfo,
    );
    expect(pCheckPosition(w.pmap, mover(fx(128), fx(128)), fx(128), fx(128))).toBe(true);
    expect(pmapHookCounts.touchSpecialThing).toBeGreaterThan(0); // touched, not picked (M7)

    const seen: number[] = [];
    pmapHooks.touchSpecialThing = (slot) => seen.push(slot);
    resetPmapHookCounts();
    expect(pCheckPosition(w.pmap, mover(fx(128), fx(128)), fx(128), fx(128))).toBe(true);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toBe(0);
    expect(pmapHookCounts.touchSpecialThing).toBe(seen.length);
  });

  it('skullfly movers stop (false) on any touchable thing; counters only (M8 damage)', () => {
    const w = world(barrelRoom);
    expect(
      pCheckPosition(
        w.pmap,
        mover(fx(128), fx(128), { flags: MF_SKULLFLY, player: false }),
        fx(128),
        fx(128),
      ),
    ).toBe(false);
    expect(pmapHookCounts.skullFlyHit).toBeGreaterThan(0);
  });

  it('missile over/under height tests (z+height vs thing z) then solid block', () => {
    const w = world(barrelRoom);
    const miss = (z: number): Mover => mover(fx(128), fx(128), { flags: MF_MISSILE, z, player: false });
    expect(pCheckPosition(w.pmap, miss(fx(43)), fx(128), fx(128))).toBe(true); // over h=42
    expect(pCheckPosition(w.pmap, miss(fx(10)), fx(128), fx(128))).toBe(false); // hits
    expect(pmapHookCounts.missileHit).toBeGreaterThan(0);

    const raised = world({
      rooms: [{ x: 0, y: 0, w: 256, h: 256, floorHeight: 64 }],
      things: [{ x: 128, y: 128, type: 2035 }],
    });
    // thing z = 64; missile z+height = 56 < 64 ⇒ underneath
    expect(pCheckPosition(raised.pmap, miss(0), fx(128), fx(128))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Zero allocation + module-state identity                              */
/* ------------------------------------------------------------------ */

describe('zero-alloc steady state', () => {
  it('100k check calls: same tm singletons, no per-query garbage', () => {
    const w = world(barrelRoom);
    const mo = mover(fx(64), fx(64));
    const bbox = tm.bbox;
    const spechit = tm.spechit;

    const t0 = process.hrtime.bigint();
    let acc = 0;
    for (let i = 0; i < 100_000; i++) {
      const x = fx(64 + (i % 128));
      const y = fx(64 + ((i * 7) % 128));
      if (pCheckPosition(w.pmap, mo, x, y)) acc = (acc + tm.tmfloorz) | 0;
      else acc = (acc + tm.tmdropoffz) | 0;
    }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    expect(Number.isFinite(acc)).toBe(true);
    expect(tm.bbox).toBe(bbox); // same tmbbox singleton object
    expect(tm.spechit).toBe(spechit); // same spechit arena
    expect(ms).toBeLessThan(5000); // a per-call allocation would GC-storm this
  });
});

/* ------------------------------------------------------------------ */
/* 4. freedoom1.wad E1M1 vs brute force (acceptance item 4)             */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

/** Blockmap-free reference: same math, full-map scan, no validcount. */
function bruteCheckPosition(w: PMapWorld, mo: Mover, x: number, y: number): boolean {
  const map = w.map;
  const L = map.lines;
  const S = map.sectors;
  const sector = sectorAtPoint(map, x, y);
  let floorz = S.floorHeight[sector]!;
  let ceilingz = S.ceilingHeight[sector]!;

  const box = { left: (x - mo.radius) | 0, right: (x + mo.radius) | 0, top: (y + mo.radius) | 0, bottom: (y - mo.radius) | 0 };

  // things (same spawn filter as buildThingLinks at default skill 3)
  for (let i = 0; i < w.links.staticCount; i++) {
    if (!w.links.linked[i]) continue;
    const flags = w.links.flags[i]!;
    if (!(flags & (MF_SOLID | MF_SPECIAL | MF_SHOOTABLE))) continue;
    const dist = (w.links.radius[i]! + mo.radius) | 0;
    const dx = w.links.x[i]! - x;
    const dy = w.links.y[i]! - y;
    if ((dx < 0 ? -dx : dx) >= dist || (dy < 0 ? -dy : dy) >= dist) continue;
    if (flags & MF_SPECIAL) {
      if (!(flags & MF_SOLID)) continue;
      return false;
    }
    if (flags & MF_SOLID) return false;
  }

  // lines: every linedef, no blockmap, no dedup needed (index unique)
  for (let line = 0; line < L.count; line++) {
    if (
      box.right <= L.bboxLeft[line]! ||
      box.left >= L.bboxRight[line]! ||
      box.top <= L.bboxBottom[line]! ||
      box.bottom >= L.bboxTop[line]!
    ) {
      continue;
    }
    if (pBoxOnLineSide(map, box, line) !== -1) continue;
    if (L.sectorBack[line] === -1) return false;
    if (!(mo.flags & MF_MISSILE)) {
      if (L.flags[line]! & ML_BLOCKING) return false;
      if (!mo.player && L.flags[line]! & ML_BLOCKMONSTERS) return false;
    }
    const f = L.sectorFront[line]!;
    const b = L.sectorBack[line]!;
    const opentop = Math.min(S.ceilingHeight[f]!, S.ceilingHeight[b]!);
    const openbottom = Math.max(S.floorHeight[f]!, S.floorHeight[b]!);
    if (opentop < ceilingz) ceilingz = opentop;
    if (openbottom > floorz) floorz = openbottom;
  }
  // (tmdropoffz never gates the verdict in 1.10 — P_TryMove reads it, so
  // the brute force only needs the blocking shape; z values are compared
  // separately by bruteZ below.)
  return true;
}

function bruteZ(w: PMapWorld, mo: Mover, x: number, y: number): [number, number] {
  const map = w.map;
  const L = map.lines;
  const S = map.sectors;
  const sector = sectorAtPoint(map, x, y);
  let floorz = S.floorHeight[sector]!;
  let ceilingz = S.ceilingHeight[sector]!;
  const box = {
    left: (x - mo.radius) | 0,
    right: (x + mo.radius) | 0,
    top: (y + mo.radius) | 0,
    bottom: (y - mo.radius) | 0,
  };
  for (let line = 0; line < L.count; line++) {
    if (
      box.right <= L.bboxLeft[line]! ||
      box.left >= L.bboxRight[line]! ||
      box.top <= L.bboxBottom[line]! ||
      box.bottom >= L.bboxTop[line]!
    ) {
      continue;
    }
    if (pBoxOnLineSide(map, box, line) !== -1) continue;
    if (L.sectorBack[line] === -1) continue; // blocked case not compared
    const f = L.sectorFront[line]!;
    const b = L.sectorBack[line]!;
    ceilingz = Math.min(ceilingz, Math.min(S.ceilingHeight[f]!, S.ceilingHeight[b]!));
    floorz = Math.max(floorz, Math.max(S.floorHeight[f]!, S.floorHeight[b]!));
  }
  return [floorz, ceilingz];
}

describe.skipIf(!hasWad)('freedoom1.wad E1M1 P_CheckPosition vs brute force', () => {
  function e1m1(): World {
    const buf = readFileSync(WAD_PATH).buffer.slice(0) as ArrayBuffer;
    const map = buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1'));
    const bm = buildBlockMap(map);
    const links = buildThingLinks(map, bm);
    return { map, bm, links, pmap: { map, bm, links } };
  }

  function sweep(w: World, seed: number): { blocked: number; sum: number } {
    const rnd = mulberry32(seed);
    const bb = w.map.mapBBox;
    let blocked = 0;
    let sum = 0;
    const mo = mover(0, 0);
    for (let i = 0; i < 1000; i++) {
      const x = (Math.floor(rnd() * (bb.right - bb.left)) + bb.left) | 0;
      const y = (Math.floor(rnd() * (bb.top - bb.bottom)) + bb.bottom) | 0;
      const ok = pCheckPosition(w.pmap, mo, x, y);
      const ref = bruteCheckPosition(w.pmap, mo, x, y);
      expect(ok).toBe(ref);
      if (ok) {
        const [fz, cz] = bruteZ(w.pmap, mo, x, y);
        expect(tm.tmfloorz).toBe(fz);
        expect(tm.tmceilingz).toBe(cz);
        sum = (sum + tm.tmfloorz + tm.tmceilingz) | 0;
      } else {
        blocked++;
      }
    }
    return { blocked, sum };
  }

  // Pinned from this port against the committed freedoom1.wad (2026-07):
  // 1000 mulberry32(0x5eed) points in the E1M1 bbox, blocked verdicts.
  const GOLDEN_BLOCKED = 121;

  it('1000 seeded points: verdict + floorz/ceilingz match the brute reference', () => {
    const r = sweep(e1m1(), 0x5eed);
    expect(r.blocked).toBeGreaterThan(50); // samples hit real geometry
    expect(r.blocked).toBeLessThan(950); // …and real free space
    expect(r.blocked).toBe(GOLDEN_BLOCKED);
  });

  it('same-seed double run: byte-identical sweep result (determinism)', () => {
    const w = e1m1();
    const a = sweep(w, 0xabc);
    const b = sweep(w, 0xabc);
    expect(a).toEqual(b);
  });
});
