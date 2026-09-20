// sim/psight.test.ts — M8-01 acceptance (plan §M8-01):
//  1. seeded BSP-vs-brute differential: 1000 random point pairs, the
//     p_sight.c:159 BSP walk vs a brute-force per-linedef reference using
//     the SAME crossing predicate — 0 mismatches (synthetic maze fixture
//     AND freedoom1.wad E1M1 when the WAD is present);
//  2. P_DivlineSide quirk pins (three-valued side test, incl. the verbatim
//     `x == node->y` typo in the horizontal branch, p_sight.c:75);
//  3. sightcounts[0]/[1] exposed and honest (REJECT trivial-reject path);
//  4. sector soundTarget SoA: zeroed at level load + the P_RecursiveSound
//     semantics of p_enemy.c:106 driven by a TEST-SIDE reference flood
//     (door open/closed + ML_SOUNDBLOCK on/off) through the storage seam —
//     the production flood body lands with M8-04's p_enemy.ts.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { FixedDiv } from '../core/fixed';
import { buildFixtureMapWad, ML_SOUNDBLOCK, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { sectorAtPoint } from './bsp';
import { gInitGame } from './game';
import { createLiveSectors, type GameState, type LiveSectors } from './state';
import { buildMapFromData, type RuntimeMap } from './map';
import { opening, pLineOpening, pInterceptVector, bumpValidcount } from './pmaputl';
import { ML_TWOSIDED, sectorLineAt } from './pspec-helpers';
import {
  divlineSide,
  pCheckSight,
  pSightTrace,
  setSectorSoundTarget,
  sightcounts,
  SOUND_TARGET_NONE,
  type SightPoint,
} from './psight';

const fx = (n: number): number => (n * FRACUNIT) | 0;

function boot(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), 2);
}

function wadMap(bytes: Uint8Array, name: string): RuntimeMap {
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), name));
}

/** Deterministic LCG (seeded; the corpus rule: no Math.random). */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Brute-force reference (per-linedef, same crossing predicate)         */
/* ------------------------------------------------------------------ */

/**
 * Reference LOS: process EVERY linedef the segment crosses (both halves of
 * the P_CrossSubsector :159-177 predicate), one-sided ⇒ block, otherwise
 * narrow the same z-cone. Each line is visited exactly once by construction
 * (no validcount needed). The cone state updates are min/max monotone, so
 * the accept/reject outcome is traversal-order independent — a mismatch
 * against the BSP walk means the WALK missed or mispredicated a line.
 */
function bruteSight(
  map: RuntimeMap,
  live: LiveSectors,
  t1: SightPoint,
  t2: SightPoint,
): boolean {
  const zstart = (t1.z + t1.height - (t1.height >> 2)) | 0;
  let top = ((t2.z + t2.height) - zstart) | 0;
  let bot = (t2.z - zstart) | 0;
  const sdx = (t2.x - t1.x) | 0;
  const sdy = (t2.y - t1.y) | 0;

  for (let line = 0; line < map.lines.count; line++) {
    const v1x = map.verticesX[map.lines.v1[line]!]!;
    const v1y = map.verticesY[map.lines.v1[line]!]!;
    const v2x = map.verticesX[map.lines.v2[line]!]!;
    const v2y = map.verticesY[map.lines.v2[line]!]!;

    if (
      divlineSide(v1x, v1y, t1.x, t1.y, sdx, sdy) ===
      divlineSide(v2x, v2y, t1.x, t1.y, sdx, sdy)
    ) {
      continue; // strace does not cross the line's span
    }
    const ldx = (v2x - v1x) | 0;
    const ldy = (v2y - v1y) | 0;
    if (
      divlineSide(t1.x, t1.y, v1x, v1y, ldx, ldy) ===
      divlineSide(t2.x, t2.y, v1x, v1y, ldx, ldy)
    ) {
      continue; // the segment does not cross the line
    }
    if ((map.lines.flags[line]! & ML_TWOSIDED) === 0) return false;

    const f = map.lines.sectorFront[line]!;
    const b = map.lines.sectorBack[line]!;
    const ff = live.floorZ[f]!;
    const fb = live.floorZ[b]!;
    const cf = live.ceilingZ[f]!;
    const cb = live.ceilingZ[b]!;
    if (ff === fb && cf === cb) continue;

    const opentop = cf < cb ? cf : cb;
    const openbottom = ff > fb ? ff : fb;
    if (openbottom >= opentop) return false;

    const frac = pInterceptVector(
      { x: t1.x, y: t1.y, dx: sdx, dy: sdy },
      { x: v1x, y: v1y, dx: ldx, dy: ldy },
    );
    if (ff !== fb) {
      const slope = FixedDiv((openbottom - zstart) | 0, frac);
      if (slope > bot) bot = slope;
    }
    if (cf !== cb) {
      const slope = FixedDiv((opentop - zstart) | 0, frac);
      if (slope < top) top = slope;
    }
    if (top <= bot) return false;
  }
  return true;
}

/** Run 1000 seeded pairs; returns the mismatch count. */
function differential(map: RuntimeMap, seed: number): number {
  const live = createLiveSectors(map);
  const rnd = makeRng(seed);
  const bb = map.mapBBox;
  const spanX = bb.right - bb.left;
  const spanY = bb.top - bb.bottom;
  let mismatches = 0;
  for (let i = 0; i < 1000; i++) {
    const t1: SightPoint = {
      x: (bb.left + Math.floor(rnd() * spanX)) | 0,
      y: (bb.bottom + Math.floor(rnd() * spanY)) | 0,
      z: fx(Math.floor(rnd() * 512) - 128),
      height: fx(16 + Math.floor(rnd() * 48)),
    };
    const t2: SightPoint = {
      x: (bb.left + Math.floor(rnd() * spanX)) | 0,
      y: (bb.bottom + Math.floor(rnd() * spanY)) | 0,
      z: fx(Math.floor(rnd() * 512) - 128),
      height: fx(16 + Math.floor(rnd() * 48)),
    };
    if (pSightTrace(map, live, t1, t2) !== bruteSight(map, live, t1, t2)) mismatches++;
  }
  return mismatches;
}

/** Four-room grid, staggered floors/ceilings, four doors: mixed one/two
 * sided geometry with open-range occluders on every LOS a pair can take. */
const GRID: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 512, h: 512 },
    { x: 512, y: 0, w: 512, h: 512, ceilingHeight: 160 },
    { x: 0, y: 512, w: 512, h: 512, floorHeight: 64 },
    { x: 512, y: 512, w: 512, h: 512, floorHeight: 64, ceilingHeight: 192 },
  ],
  doors: [
    { x1: 512, y1: 200, x2: 512, y2: 312, special: 0 },
    { x1: 200, y1: 512, x2: 312, y2: 512, special: 0 },
    { x1: 640, y1: 512, x2: 752, y2: 512, special: 0 },
    { x1: 512, y1: 700, x2: 512, y2: 812, special: 0 },
  ],
};

/* ------------------------------------------------------------------ */
/* 1. P_DivlineSide quirks (p_sight.c:55-89)                            */
/* ------------------------------------------------------------------ */

describe('P_DivlineSide — p_sight.c:55 verbatim', () => {
  test('vertical partition (dx==0): on/exact, both dy signs, both x sides', () => {
    // partition at x=100 pointing north (dy>0): front side is x>100
    expect(divlineSide(fx(100), fx(7), fx(100), fx(3), 0, fx(64))).toBe(2);
    expect(divlineSide(fx(99), fx(7), fx(100), fx(3), 0, fx(64))).toBe(1);
    expect(divlineSide(fx(101), fx(7), fx(100), fx(3), 0, fx(64))).toBe(0);
    // dy<0 flips both branches (the boolean returns)
    expect(divlineSide(fx(99), fx(7), fx(100), fx(3), 0, -fx(64))).toBe(0);
    expect(divlineSide(fx(101), fx(7), fx(100), fx(3), 0, -fx(64))).toBe(1);
  });

  test('horizontal partition (dy==0): VERBATIM x==node->y typo kept', () => {
    // partition origin (10, 20) pointing east. The vanilla "on" test at
    // p_sight.c:75 compares the QUERY X against the origin Y (20):
    expect(divlineSide(fx(20), fx(999), fx(10), fx(20), fx(64), 0)).toBe(2);
    // …and a point whose x equals the origin X is NOT special:
    expect(divlineSide(fx(10), fx(21), fx(10), fx(20), fx(64), 0)).not.toBe(2);
    // dx>0: y<=20 ⇒ back(1)? `return node->dx < 0` → 0; above ⇒ dx>0 → 1
    expect(divlineSide(fx(30), fx(20), fx(10), fx(20), fx(64), 0)).toBe(0);
    expect(divlineSide(fx(30), fx(21), fx(10), fx(20), fx(64), 0)).toBe(1);
    // dx<0 mirrors
    expect(divlineSide(fx(30), fx(20), fx(10), fx(20), -fx(64), 0)).toBe(1);
    expect(divlineSide(fx(30), fx(21), fx(10), fx(20), -fx(64), 0)).toBe(0);
  });

  test('general partition: front/back/on via the pure-integer cross product', () => {
    // 45° line from (0,0) delta (64,64): point (10, 20) is left/back,
    // (40, 5) right/front, (10, 10) exactly ON (left == right).
    expect(divlineSide(fx(10), fx(20), 0, 0, fx(64), fx(64))).toBe(1);
    expect(divlineSide(fx(40), fx(5), 0, 0, fx(64), fx(64))).toBe(0);
    expect(divlineSide(fx(10), fx(10), 0, 0, fx(64), fx(64))).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 2. BSP walk vs brute force (plan acceptance 1)                       */
/* ------------------------------------------------------------------ */

describe('P_CrossBSPNode vs brute force (1000 seeded pairs, 0 mismatch)', () => {
  test('synthetic 4-room door grid (seed 0x1993_0501)', () => {
    expect(differential(boot(GRID).map, 0x19930501)).toBe(0);
  });

  test('solid one-sided wall blocks; same room sees', () => {
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 512, y: 0, w: 256, h: 256 }, // disjoint: void + walls between
      ],
    });
    const map = s.map;
    const live = s.sectors;
    const a: SightPoint = { x: fx(64), y: fx(64), z: fx(41), height: fx(56) };
    const b: SightPoint = { x: fx(576), y: fx(64), z: fx(41), height: fx(56) };
    expect(pSightTrace(map, live, a, b)).toBe(false); // one-sided wall stops
    expect(pSightTrace(map, live, a, { x: fx(200), y: fx(200), z: fx(41), height: fx(56) })).toBe(true);
  });

  const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
  const hasWad = existsSync(WAD_PATH);

  describe.skipIf(!hasWad)('freedoom1.wad E1M1', () => {
    test('1000 seeded pairs, 0 mismatches (seed 0x1993_0502)', () => {
      const map = wadMap(new Uint8Array(readFileSync(WAD_PATH)), 'E1M1');
      expect(differential(map, 0x19930502)).toBe(0);
    });
  });
});

/* ------------------------------------------------------------------ */
/* 3. REJECT + sightcounts (plan acceptance 3)                          */
/* ------------------------------------------------------------------ */

describe('P_CheckSight REJECT path + sightcounts[0]/[1]', () => {
  test('trivial reject counts [0]; traced counts [1]; both exposed', () => {
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 512, h: 512 },
        { x: 512, y: 0, w: 512, h: 512 },
      ],
      doors: [{ x1: 512, y1: 200, x2: 512, y2: 312, special: 0 }],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }],
    });
    const map = s.map;
    // The fixture REJECT is all zero (fully visible); patch the one bit for
    // (sector of a → sector of b) to exercise the trivial-reject branch.
    const a: SightPoint = { x: fx(128), y: fx(256), z: fx(41), height: fx(56) };
    const b: SightPoint = { x: fx(640), y: fx(256), z: fx(41), height: fx(56) };
    const s1 = sectorAtPoint(map, a.x, a.y);
    const s2 = sectorAtPoint(map, b.x, b.y);
    const pnum = s1 * map.sectors.count + s2;

    sightcounts.fill(0);
    expect(pCheckSight(s.mobjs, a, b)).toBe(true); // straight through the door gap
    expect(sightcounts[0]!).toBe(0);
    expect(sightcounts[1]!).toBe(1);

    const byte = pnum >> 3;
    const bit = 1 << (pnum & 7);
    map.reject[byte] = (map.reject[byte]! | bit) & 0xff;
    expect(pCheckSight(s.mobjs, a, b)).toBe(false);
    expect(sightcounts[0]!).toBe(1);
    expect(sightcounts[1]!).toBe(1); // the traced count did NOT move

    map.reject[byte] = (map.reject[byte]! & ~bit) & 0xff;
    expect(pCheckSight(s.mobjs, a, b)).toBe(true);
    expect(sightcounts[1]!).toBe(2);
  });

  test('sight is PRNG-free: repeated calls do not touch the rng', () => {
    const s = boot({ rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 160 }] });
    const before = s.rng.prndindex;
    for (let i = 0; i < 64; i++) {
      pCheckSight(s.mobjs, { x: fx(64), y: fx(64), z: fx(41), height: fx(56) }, {
        x: fx(400),
        y: fx(400),
        z: fx(41),
        height: fx(56),
      });
    }
    expect(s.rng.prndindex).toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* 4. sector soundTarget seam (plan acceptance 4)                       */
/* ------------------------------------------------------------------ */

/**
 * TEST-SIDE reference flood = p_enemy.c:106-149 P_RecursiveSound verbatim
 * (the production body lands in M8-04's p_enemy.ts and writes through the
 * SAME seam/fields; this helper exists until then — see psight.ts bottom).
 */
function floodSound(s: GameState, startSector: number, targetSlot: number): void {
  const stamp = bumpValidcount(); // P_NoiseAlert's validcount++
  const map = s.map;
  const walk = (sec: number, soundblocks: number): void => {
    if (map.sectors.valid[sec] === stamp && map.sectors.soundTraversed[sec]! <= soundblocks + 1) {
      return; // already flooded
    }
    map.sectors.valid[sec] = stamp;
    map.sectors.soundTraversed[sec] = soundblocks + 1;
    setSectorSoundTarget(map, sec, targetSlot);
    for (let k = 0; k < map.sectors.lineCount[sec]!; k++) {
      const line = sectorLineAt(map, sec, k);
      if ((map.lines.flags[line]! & ML_TWOSIDED) === 0) continue;
      pLineOpening(map, line, s.sectors);
      if (opening.openrange <= 0) continue; // closed door
      const other =
        map.lines.sectorFront[line] === sec
          ? map.lines.sectorBack[line]!
          : map.lines.sectorFront[line]!;
      if ((map.lines.flags[line]! & ML_SOUNDBLOCK) !== 0) {
        if (soundblocks === 0) walk(other, 1); // a sound-blocked hop: once
      } else {
        walk(other, soundblocks);
      }
    }
  };
  walk(startSector, 0);
}

function row(sector: { soundBlock: boolean }): RectMapSpec {
  return {
    rooms: [
      { x: 0, y: 0, w: 256, h: 512 },
      { x: 256, y: 0, w: 256, h: 512 },
      { x: 512, y: 0, w: 256, h: 512 },
    ],
    // full-edge “doors”: the builder makes every room-room edge segment
    // two-sided, so spanning the whole edge is what puts ML_SOUNDBLOCK on
    // ALL the crossing segments (no sound leak beside a partial gap).
    doors: [
      { x1: 256, y1: 0, x2: 256, y2: 512, special: 0, soundBlock: sector.soundBlock },
      { x1: 512, y1: 0, x2: 512, y2: 512, special: 0, soundBlock: sector.soundBlock },
    ],
  };
}

describe('sector soundTarget (sector_t soundtarget, p_enemy.c:140)', () => {
  test('zeroed at level load: every sector starts SOUND_TARGET_NONE', () => {
    const s = boot(row({ soundBlock: false }));
    const t = s.map.sectors.soundTarget;
    expect(Array.from(t).every((v) => v === SOUND_TARGET_NONE)).toBe(true);
  });

  test('open door floods across; soundtarget written in both sectors', () => {
    const s = boot(row({ soundBlock: false }));
    floodSound(s, 1, 42);
    expect(s.map.sectors.soundTarget[1]!).toBe(42);
    expect(s.map.sectors.soundTarget[2]!).toBe(42);
    expect(s.map.sectors.soundTraversed[1]!).toBe(1);
    expect(s.map.sectors.soundTraversed[2]!).toBe(1);
  });

  test('closed door (openrange 0) blocks the flood — far sector untouched', () => {
    // Room 2 with ceiling AT its floor = a shut door for P_LineOpening.
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 512 },
        { x: 256, y: 0, w: 256, h: 512, ceilingHeight: 0 },
      ],
      doors: [{ x1: 256, y1: 0, x2: 256, y2: 512, special: 0 }],
    });
    floodSound(s, 1, 7);
    expect(s.map.sectors.soundTarget[1]!).toBe(7);
    expect(s.map.sectors.soundTarget[2]!).toBe(SOUND_TARGET_NONE);
    expect(s.map.sectors.soundTraversed[2]!).toBe(0);
  });

  test('ML_SOUNDBLOCK on: recurses the blocked hop ONCE, no further', () => {
    const s = boot(row({ soundBlock: true }));
    floodSound(s, 1, 9);
    expect(s.map.sectors.soundTarget[1]!).toBe(9); // origin, unblocked
    expect(s.map.sectors.soundTraversed[1]!).toBe(1);
    expect(s.map.sectors.soundTarget[2]!).toBe(9); // one blocked hop
    expect(s.map.sectors.soundTraversed[2]!).toBe(2); // soundblocks+1
    // From the soundblocked sector, blocked lines do NOT recurse again:
    expect(s.map.sectors.soundTarget[3]!).toBe(SOUND_TARGET_NONE);
    expect(s.map.sectors.soundTraversed[3]!).toBe(0);
  });

  test('ML_SOUNDBLOCK off: whole row alerted at soundblocks 0', () => {
    const s = boot(row({ soundBlock: false }));
    floodSound(s, 1, 9);
    for (const sec of [1, 2, 3]) {
      expect(s.map.sectors.soundTarget[sec]!).toBe(9);
      expect(s.map.sectors.soundTraversed[sec]!).toBe(1);
    }
  });
});
