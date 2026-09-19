/**
 * sim/pmap tests (M5-02 + M5-03) — P_CheckPosition + thinglinks +
 * P_TryMove/P_TeleportMove (p_map.c parts 1-2).
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
import { pBoxOnLineSide, pPointOnLineSide } from './pmaputl';
import {
  MAXSPECIALCROSS,
  ML_BLOCKING,
  ML_BLOCKMONSTERS,
  pCheckPosition,
  pmapHookCounts,
  pmapHooks,
  pTeleportMove,
  pTryMove,
  resetPmapHookCounts,
  tm,
  type Mover,
  type PMapWorld,
} from './pmap';
import { pcrossCounts, pcrossHooks, resetPcrossCounts } from './pspec';
import {
  allocThingSlot,
  buildThingLinks,
  MF_DROPOFF,
  MF_FLOAT,
  MF_MISSILE,
  MF_NOCLIP,
  MF_PICKUP,
  MF_SHOOTABLE,
  MF_SKULLFLY,
  MF_SOLID,
  MF_SPECIAL,
  MF_TELEPORT,
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
  resetPcrossCounts();
  delete pmapHooks.touchSpecialThing;
  delete pmapHooks.skullFlyHit;
  delete pmapHooks.missileHit;
  delete pmapHooks.telefrag;
  delete pcrossHooks.crossSpecialLine;
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

/* ------------------------------------------------------------------ */
/* M5-03: P_TryMove height tests (acceptance 1)                         */
/* ------------------------------------------------------------------ */

/* Two rooms touching at x=128; room 2 is the destination geometry. */
function stepRoom(floor: number, ceiling?: number): RectMapSpec {
  return {
    rooms: [
      { x: 0, y: 0, w: 128, h: 128 },
      { x: 128, y: 0, w: 128, h: 128, floorHeight: floor, ...(ceiling === undefined ? {} : { ceilingHeight: ceiling }) },
    ],
    things: [{ x: 32, y: 32, type: 1 }],
  };
}

describe('P_TryMove step-up / height tests', () => {
  it('24-unit step accepted; floorz/ceilingz written, z untouched', () => {
    const w = world(stepRoom(24));
    const mo = mover(fx(112), fx(64));
    expect(pTryMove(w.pmap, mo, fx(128), fx(64))).toBe(true);
    expect(tm.floatok).toBe(true);
    expect(mo.x).toBe(fx(128));
    expect(mo.floorz).toBe(fx(24));
    expect(mo.ceilingz).toBe(fx(128));
    expect(mo.z).toBe(0); // TryMove never moves z (P_ZMovement, M5-05)
  });

  it('25-unit step rejected (too big a step up); nothing written', () => {
    const w = world(stepRoom(25));
    const mo = mover(fx(112), fx(64));
    expect(pTryMove(w.pmap, mo, fx(128), fx(64))).toBe(false);
    expect(tm.floatok).toBe(true); // floatok flips before checks 2-4 (p_map.c)
    expect(mo.x).toBe(fx(112));
    expect(mo.floorz).toBeUndefined();
  });

  it('destination does not fit at all: floor 24 ceiling 55 ⇒ rejected (range < h56)', () => {
    const w = world(stepRoom(24, 55));
    expect(pTryMove(w.pmap, mover(fx(112), fx(64)), fx(128), fx(64))).toBe(false);
  });

  it('headroom over the step: ceiling 80 (opentop-floor = 56) accepted, 79 rejected', () => {
    expect(pTryMove(world(stepRoom(24, 80)).pmap, mover(fx(112), fx(64)), fx(128), fx(64))).toBe(true);
    expect(pTryMove(world(stepRoom(24, 79)).pmap, mover(fx(112), fx(64)), fx(128), fx(64))).toBe(false);
  });

  it('must-lower-itself boundary (z above dest floor): ceiling 60 rejects z=10, 66 accepts', () => {
    // dest floor 0 range 60 ≥ 56 passes the fit test, but ceiling - z = 50 < 56
    const low = world(stepRoom(0, 60));
    const mo = mover(fx(112), fx(64), { z: fx(10) });
    expect(pTryMove(low.pmap, mo, fx(128), fx(64))).toBe(false);
    expect(tm.floatok).toBe(true);
    const ok = world(stepRoom(0, 66));
    expect(pTryMove(ok.pmap, mover(fx(112), fx(64), { z: fx(10) }), fx(128), fx(64))).toBe(true);
  });

  it('MF_TELEPORT skips the lowering/step/dropoff tests but not the fit test or wall scan', () => {
    const w = world(stepRoom(25)); // plain 25-step: rejected without MF_TELEPORT
    const ghost = mover(fx(112), fx(64), { flags: PLAYER_FLAGS | MF_TELEPORT });
    expect(pTryMove(w.pmap, ghost, fx(128), fx(64))).toBe(true);
    expect(ghost.floorz).toBe(fx(25));
    // the unconditional fit test (check 1) still applies to MF_TELEPORT:
    const tight = world(stepRoom(25, 55)); // range 30 < 56
    expect(
      pTryMove(tight.pmap, mover(fx(112), fx(64), { flags: PLAYER_FLAGS | MF_TELEPORT }), fx(128), fx(64)),
    ).toBe(false);
    const line = sharedLineX(w.map, 128, 1, 2);
    w.map.lines.sectorBack[line] = -1; // one-sided: CheckPosition still blocks
    expect(pTryMove(w.pmap, ghost, fx(128), fx(64))).toBe(false);
  });

  it('ML_BLOCKING wall vector + thing block short-circuit before the height tests', () => {
    const w = world(stepRoom(0));
    w.map.lines.flags[sharedLineX(w.map, 128, 1, 2)]! |= ML_BLOCKING;
    expect(pTryMove(w.pmap, mover(fx(128), fx(64)), fx(128), fx(64))).toBe(false);
    const b = world(barrelRoom);
    expect(pTryMove(b.pmap, mover(fx(64), fx(64)), fx(128), fx(128))).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* M5-03: dropoff rules (acceptance 2)                                  */
/* ------------------------------------------------------------------ */

/* Room A raised 64, room B floor 0 — the ledge line at x=128. */
const ledgeRooms: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 128, floorHeight: 64 },
    { x: 128, y: 0, w: 128, h: 128 },
  ],
  things: [{ x: 32, y: 32, type: 1 }],
};

describe('P_TryMove dropoff rules', () => {
  it('MF_DROPOFF player walks off the 64-unit ledge (tmfloorz−tmdropoffz = 64)', () => {
    const w = world(ledgeRooms);
    const mo = mover(fx(112), fx(64), { z: fx(64) });
    expect(pTryMove(w.pmap, mo, fx(136), fx(64))).toBe(true);
    expect(mo.floorz).toBe(fx(64)); // straddling box still sees the high floor
    expect(tm.tmfloorz - tm.tmdropoffz).toBe(fx(64));
  });

  it('non-DROPOFF/non-FLOAT thing refuses the same ledge; MF_FLOAT accepts', () => {
    const w = world(ledgeRooms);
    const grunt = { flags: MF_SOLID | MF_SHOOTABLE, player: false, z: fx(64) };
    expect(pTryMove(w.pmap, mover(fx(112), fx(64), grunt), fx(136), fx(64))).toBe(false);
    const floater = mover(fx(112), fx(64), { flags: MF_SOLID | MF_FLOAT, player: false, z: fx(64) });
    expect(pTryMove(w.pmap, floater, fx(136), fx(64))).toBe(true);
  });

  it('the dropoff edge is pure tmfloorz−tmdropoffz: no linedef flag participates (1.10 has no ML_BLOCKMAP float edge)', () => {
    const w = world(ledgeRooms);
    const line = sharedLineX(w.map, 128, 1, 2);
    w.map.lines.flags[line]! |= 8; // ML_DONTPEGTOP-era bit; no BF/ML_BLOCKMAP float semantics exist in 1.10
    expect(pTryMove(w.pmap, mover(fx(112), fx(64), { z: fx(64) }), fx(136), fx(64))).toBe(true);
    expect(
      pTryMove(w.pmap, mover(fx(112), fx(64), { flags: MF_SOLID, player: false, z: fx(64) }), fx(136), fx(64)),
    ).toBe(false);
    // ML_BLOCKING still hard-blocks for the normal reason (not the drop test)
    const w2 = world(ledgeRooms);
    w2.map.lines.flags[sharedLineX(w2.map, 128, 1, 2)]! |= ML_BLOCKING;
    expect(pTryMove(w2.pmap, mover(fx(112), fx(64), { z: fx(64) }), fx(136), fx(64))).toBe(false);
  });

  it('noclip bypasses all four checks yet keeps floorz/ceilingz tracking + relink', () => {
    const w = world(ledgeRooms);
    const mo = mover(fx(112), fx(64), { flags: PLAYER_FLAGS | MF_NOCLIP, z: fx(64) });
    expect(pTryMove(w.pmap, mo, fx(200), fx(2000))).toBe(true); // through walls, off-map-ish
    expect(mo.x).toBe(fx(200));
    expect(mo.floorz).toBeDefined();
    expect(mo.ceilingz).toBeDefined();
    expect(tm.floatok).toBe(false); // check block skipped entirely
  });
});

/* ------------------------------------------------------------------ */
/* M5-03: special-line crossing call site (acceptance 3)                */
/* ------------------------------------------------------------------ */

function specialWorld(): { w: World; line: number } {
  const w = world(twoRooms);
  const line = sharedLineX(w.map, 128, 1, 2);
  w.map.lines.special[line] = 1;
  return { w, line };
}

describe('P_TryMove spechit crossing → P_CrossSpecialLine stub', () => {
  it('one crossing = exactly one call with the OLD side; numspechit ends −1', () => {
    const { w, line } = specialWorld();
    const calls: [number, number][] = [];
    pcrossHooks.crossSpecialLine = (l, side) => calls.push([l, side]);
    expect(pTryMove(w.pmap, mover(fx(112), fx(64)), fx(140), fx(64))).toBe(true); // box straddles
    expect(pcrossCounts.crossSpecialLine).toBe(1);
    expect(calls).toEqual([[line, pPointOnLineSide(w.map, fx(112), fx(64), line)]]);
    expect(tm.numspechit).toBe(-1); // `while (numspechit--)` exit state
  });

  it('spechit touched without a side flip: loop ran, zero calls', () => {
    const { w } = specialWorld();
    expect(pTryMove(w.pmap, mover(fx(112), fx(64)), fx(120), fx(64))).toBe(true);
    expect(pcrossCounts.crossSpecialLine).toBe(0);
    expect(tm.numspechit).toBe(-1);
  });

  it('approach-then-cross walk: fires once total across the two legs', () => {
    const { w } = specialWorld();
    const n0 = pcrossCounts.crossSpecialLine;
    const mo = mover(fx(112), fx(64));
    expect(pTryMove(w.pmap, mo, fx(120), fx(64))).toBe(true);
    expect(pTryMove(w.pmap, mo, fx(136), fx(64))).toBe(true);
    expect(pcrossCounts.crossSpecialLine - n0).toBe(1);
  });

  it('parallel walk never contacts the line: no spechit, no call', () => {
    const { w } = specialWorld();
    expect(pTryMove(w.pmap, mover(fx(145), fx(64)), fx(145), fx(80))).toBe(true);
    expect(tm.numspechit).toBe(-1);
    expect(pcrossCounts.crossSpecialLine).toBe(0);
  });

  it('MF_TELEPORT mover crosses physically but the dispatch is skipped (counter stays)', () => {
    const { w } = specialWorld();
    const ghost = mover(fx(112), fx(64), { flags: PLAYER_FLAGS | MF_TELEPORT });
    expect(pTryMove(w.pmap, ghost, fx(140), fx(64))).toBe(true);
    expect(pcrossCounts.crossSpecialLine).toBe(0);
    expect(tm.numspechit).toBe(1); // loop never ran: spechit list left as seeded
  });

  it('noclip mover: no scan, no dispatch, counter 0', () => {
    const { w } = specialWorld();
    const mo = mover(fx(112), fx(64), { flags: PLAYER_FLAGS | MF_NOCLIP });
    expect(pTryMove(w.pmap, mo, fx(144), fx(64))).toBe(true);
    expect(pcrossCounts.crossSpecialLine).toBe(0);
    expect(tm.numspechit).toBe(0); // noclip returned before the line scan
  });

  it('P_TeleportMove never dispatches crossings (spechit not even collected)', () => {
    const { w } = specialWorld();
    expect(pTeleportMove(w.pmap, mover(fx(112), fx(64)), fx(144), fx(64))).toBe(true);
    expect(pcrossCounts.crossSpecialLine).toBe(0);
    expect(tm.numspechit).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* M5-03: relink order + blocked-attempt inertness (acceptance 4)       */
/* ------------------------------------------------------------------ */

describe('P_TryMove relinking', () => {
  /** Visit order + coords over every cell (chain-shape fingerprint). */
  const fingerprint = (links: ThingLinks): string[] => {
    const out: string[] = [];
    for (let bx = 0; bx < links.bm.width; bx++) {
      for (let by = 0; by < links.bm.height; by++) {
        thingLinksIterator(links, bx, by, (s) => {
          out.push(`${bx},${by}:${s}@${links.x[s]},${links.y[s]}`);
          return true;
        });
      }
    }
    return out;
  };

  it('unset-then-set order == direct unset/set order: identical chains (hashState sees one position)', () => {
    const a = world(barrelRoom);
    const slotA = allocThingSlot(a.links, fx(16), fx(56), PLAYER_FLAGS);
    const moA = mover(fx(64), fx(64), { linkSlot: slotA });
    thingSetPosition(a.links, slotA, fx(64), fx(64));

    const b = world(barrelRoom);
    const slotB = allocThingSlot(b.links, fx(16), fx(56), PLAYER_FLAGS);
    thingSetPosition(b.links, slotB, fx(64), fx(64));

    for (let t = 0; t < 40; t++) {
      const nx = fx(40 + ((t * 13) % 180));
      const ny = fx(32 + ((t * 29) % 40)); // stays clear of the barrel at (128,128)
      expect(pTryMove(a.pmap, moA, nx, ny)).toBe(true);
      thingUnsetPosition(b.links, slotB);
      thingSetPosition(b.links, slotB, nx, ny);
    }
    expect(fingerprint(a.links)).toEqual(fingerprint(b.links));
    expect(a.links.linked[slotA]).toBe(1);
  });

  it('blocked TryMove: position, floorz and links untouched', () => {
    const w = world(barrelRoom);
    const slot = allocThingSlot(w.links, fx(16), fx(56), PLAYER_FLAGS);
    const mo = mover(fx(64), fx(64), { linkSlot: slot });
    thingSetPosition(w.links, slot, fx(64), fx(64));
    expect(pTryMove(w.pmap, mo, fx(128), fx(128))).toBe(false); // barrel
    expect(mo.x).toBe(fx(64));
    expect(mo.floorz).toBeUndefined();
    expect(w.links.x[slot]).toBe(fx(64));
    expect(w.links.linked[slot]).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* M5-03: P_TeleportMove + PIT_StompThing (telefrag shell)              */
/* ------------------------------------------------------------------ */

describe('P_TeleportMove', () => {
  it('ignores walls entirely; writes floorz/ceilingz of the destination; z untouched', () => {
    const w = world({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128 },
        { x: 192, y: 0, w: 128, h: 128, floorHeight: 16, ceilingHeight: 96 },
      ],
      things: [{ x: 32, y: 32, type: 1 }],
    });
    const mo = mover(fx(64), fx(64), { z: fx(999) });
    expect(pTeleportMove(w.pmap, mo, fx(256), fx(64))).toBe(true); // across the wall gap
    expect(mo.x).toBe(fx(256));
    expect(mo.floorz).toBe(fx(16));
    expect(mo.ceilingz).toBe(fx(96));
    expect(mo.z).toBe(fx(999)); // momentum/z: vanilla clears nothing here
  });

  it('player telefrags: counter + typed hook fire, victim survives (no-op default), move succeeds', () => {
    const w = world(barrelRoom);
    const seen: number[] = [];
    pmapHooks.telefrag = (slot) => seen.push(slot);
    expect(pTeleportMove(w.pmap, mover(fx(64), fx(64)), fx(128), fx(128))).toBe(true);
    expect(pmapHookCounts.telefrag).toBe(1);
    expect(seen).toEqual([0]); // barrel slot
    expect(w.links.linked[0]).toBe(1); // "killed" thing stays in place until M6/M8
    expect(w.links.x[0]).toBe(fx(128));
    // contrast: the same spot via TryMove is blocked (MF_SOLID)
    expect(pTryMove(w.pmap, mover(fx(64), fx(64)), fx(128), fx(128))).toBe(false);
  });

  it('non-player stomp fails off map 30: nothing moves or relinks', () => {
    const w = world(barrelRoom);
    const slot = allocThingSlot(w.links, fx(16), fx(56), MF_SOLID | MF_SHOOTABLE);
    const mo = mover(fx(64), fx(64), { flags: MF_SOLID | MF_SHOOTABLE, player: false, linkSlot: slot });
    thingSetPosition(w.links, slot, fx(64), fx(64));
    expect(pTeleportMove(w.pmap, mo, fx(128), fx(128))).toBe(false);
    expect(mo.x).toBe(fx(64));
    expect(w.links.x[slot]).toBe(fx(64));
    expect(pmapHookCounts.telefrag).toBe(0);
  });

  it('gamemap 30 exception pinned: non-player stomp succeeds + telefrags there', () => {
    const base = world(barrelRoom);
    const w: PMapWorld = { map: base.map, bm: base.bm, links: base.links, gamemap: 30 };
    const mo = mover(fx(64), fx(64), { flags: MF_SOLID | MF_SHOOTABLE, player: false });
    expect(pTeleportMove(w, mo, fx(128), fx(128))).toBe(true);
    expect(pmapHookCounts.telefrag).toBe(1);
  });

  it('non-shootable solid does NOT block a teleport (PIT_StompThing ignores it)', () => {
    const solidBarrel = new Map<number, ThingInfo>([
      [2035, { radius: fx(10), height: fx(42), flags: MF_SOLID }],
    ]);
    const w = world(barrelRoom, solidBarrel);
    expect(pTeleportMove(w.pmap, mover(fx(64), fx(64)), fx(128), fx(128))).toBe(true);
    expect(pmapHookCounts.telefrag).toBe(0);
  });

  it('MF_NOCLIP does not skip the stomp scan (unlike P_CheckPosition)', () => {
    const w = world(barrelRoom);
    const mo = mover(fx(64), fx(64), { flags: PLAYER_FLAGS | MF_NOCLIP });
    expect(pTeleportMove(w.pmap, mo, fx(128), fx(128))).toBe(true);
    expect(pmapHookCounts.telefrag).toBe(1);
  });

  it('self-slot is skipped: teleport onto own position succeeds without stomping self', () => {
    const w = world(barrelRoom);
    const slot = allocThingSlot(w.links, fx(16), fx(56), PLAYER_FLAGS);
    const mo = mover(fx(64), fx(64), { linkSlot: slot });
    thingSetPosition(w.links, slot, fx(64), fx(64));
    expect(pTeleportMove(w.pmap, mo, fx(66), fx(64))).toBe(true);
    expect(pmapHookCounts.telefrag).toBe(0);
    expect(w.links.x[slot]).toBe(fx(66));
  });
});

/* ------------------------------------------------------------------ */
/* M5-03: 1000-call scripted TryMove walk determinism                   */
/* ------------------------------------------------------------------ */

describe('1000-step scripted TryMove determinism', () => {
  function walk(seed: number): number {
    const w = world(barrelRoom);
    const slot = allocThingSlot(w.links, fx(16), fx(56), PLAYER_FLAGS);
    const mo = mover(fx(64), fx(64), { linkSlot: slot });
    thingSetPosition(w.links, slot, fx(64), fx(64));
    const rnd = mulberry32(seed);
    let acc = 0x811c9dc5 | 0;
    const mix = (v: number): void => {
      acc = Math.imul(acc ^ v, 0x01000193) | 0;
    };
    let moved = 0;
    let blocked = 0;
    for (let t = 0; t < 1000; t++) {
      const nx = fx(32 + Math.floor(rnd() * 192));
      const ny = fx(32 + Math.floor(rnd() * 192));
      if (pTryMove(w.pmap, mo, nx, ny)) moved++;
      else blocked++;
      mix(mo.x);
      mix(mo.y);
      mix(mo.floorz ?? -1);
      mix(mo.ceilingz ?? -1);
      mix(w.links.x[slot]!);
      mix(w.links.y[slot]!);
    }
    mix(moved);
    mix(blocked);
    mix(pcrossCounts.crossSpecialLine);
    return acc;
  }

  // Blessed from this port (2026-07), 1000 mulberry32(0x51df) hops in the
  // 256-unit barrel room (same-seed double run equal at bless time).
  const GOLDEN = -38303909;

  it('golden hash + same-seed double run identical', () => {
    const a = walk(0x51df);
    expect(a).toBe(walk(0x51df));
    expect(a).toBe(GOLDEN);
  });
});
