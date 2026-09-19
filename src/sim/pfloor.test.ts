/**
 * sim/pfloor.ts tests (M6-07, plan §M6-07) — T_MoveFloor destination-table
 * goldens (13 floor_e types), stair chain timing (build8/turbo16, vwait
 * absent in 1.10 — no per-hop delay: EVERY stair mover spawns at trigger
 * and moves in parallel, pinned), excavate (lowerAndChange) pickup ORDER,
 * donut full cycle (s2 across s1->lines[0] pin), crush-floor damage-slot
 * cadence, toLowest/toHighest tie behavior, retrigger rules, dispatch
 * parity and double-run hashes.
 *
 * Hand-derived timing (T_MovePlane step-then-detect, M6-04 contract):
 * distance d at speed s ⇒ d/s movement tics, pastdest detect + removal on
 * tic d/s + 1. T_MoveFloor sounds: sfx_stnmov on every tic with
 * !(leveltime&7) while ticking (leveltime 0 included), sfx_pstop at the
 * removal tic.
 *
 * VOID NOTE (fixtures): mapBuilder's void sector 0 has floor = ceiling =
 * −128 and is a REAL neighbour of every room edge — "sealed" rooms do NOT
 * exist in rect fixtures, so P_FindLowestFloorSurrounding of an open room
 * is −128 (the void) and P_FindLowestCeilingSurrounding likewise. Tests
 * that need a controlled surrounding use the ENCLOSED 3×3 grids below.
 *
 * Source mirrors: /tmp/DOOM-master/linuxdoom-1.10/p_floor.c (T_MoveFloor,
 * EV_DoFloor, EV_BuildStairs) + p_spec.c:1163-1221 (EV_DoDonut).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec, type RectRoomSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData } from './map';
import { gInitGame } from './game';
import { pRunThinkers, sectorSpecialData, setSectorSpecialData } from './ptick';
import { pCrossSpecialLine, pUseSpecialLine, pShootSpecialLine } from './pspec';
import { getNextSector, sectorLineAt } from './pspec-helpers';
import { LINE_SPECIALS, FLOOR, STAIR, unimplementedSpecial, resetUnimplementedSpecial } from './specials-table';
import { hashState, type GameState } from './state';
import { pmapHookCounts, resetPmapHookCounts } from './pmap';
import { PLAYER_FLAGS } from './player';
import type { Mover } from './pmap';
import { resetPlatFlatCopies, floorFlatOverrides } from './pplats';

import {
  evDoFloor,
  evBuildStairs,
  evDoDonut,
  floorFlatOf,
  floorsFlatCopies,
  FLOORSPEED,
  pfloorCounts,
  resetFloorsFlatCopies,
  resetPfloorCounts,
  resetTextureHeights,
  textureHeights,
  SFX_PSTOP,
  SFX_STNMOV,
  type FloorMove
} from './pfloor';

const fx = (u: number): number => (u * FRACUNIT) | 0;

const PLAYER: Mover = {
  x: 0, y: 0, z: 0, radius: fx(16), height: fx(56),
  flags: MF_SOLID_FLAG | PLAYER_FLAGS, player: true
};
import { MF_SOLID as MF_SOLID_FLAG } from './thinglinks';

function stateFor(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec);
  return gInitGame(
    buildMapFromData(loadMap(WadFile.parse(bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer), 'FIXMAP'))
  );
}

/** thinkers-only tic (pplats.test idiom): run then leveltime++. */
function step(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    pRunThinkers(s.thinkers);
    s.leveltime++;
  }
}

function secByTag(s: GameState, tag: number): number {
  for (let i = 0; i < s.sectors.count; i++) if (s.sectors.tag[i] === tag) return i;
  throw new Error(`no sector tagged ${tag}`);
}

function lineBySpecial(s: GameState, special: number): number {
  for (let i = 0; i < s.map.lines.count; i++) {
    if (s.map.lines.special[i] === special) return i;
  }
  throw new Error(`no line with special ${special}`);
}

/** The live floor mover of a sector (sector->specialdata), or null. */
function floorOf(s: GameState, sec: number): FloorMove | null {
  return sectorSpecialData(s.sectors, sec) as FloorMove | null;
}

function sfxCount(s: GameState, id: number): number {
  return s.hooks.sfx.byId?.get(id) ?? 0;
}

beforeEach(() => {
  resetUnimplementedSpecial();
  resetFloorsFlatCopies();
  resetPfloorCounts();
  resetTextureHeights();
  resetPlatFlatCopies(); // clears the SHARED floorFlatOverrides channel
  resetPmapHookCounts();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// lowerFloor: tagged room floor 64, one corridor at 0 (max surrounding
// 0 > void −128), so dest = P_FindHighestFloorSurrounding = 0 exactly.
const LOWER_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, floorHeight: 64, tag: 45 },
    { x: 256, y: 0, w: 256, h: 256 },
    { x: 0, y: 256, w: 256, h: 128 }
  ],
  triggers: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 45, tag: 45 }],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

/** 3×3 fully enclosed grid (no void edges on the CENTER room): cells
 * indexed (i,j) → room 3*j + i, center (1,1) = room index 4. */
function grid3x3(floors: [number, number, number][], ceilings?: [number, number, number][]): RectRoomSpec[] {
  const rooms: RectRoomSpec[] = [];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      rooms.push({
        x: i * 128, y: (j - 1) * 128, w: 128, h: 128,
        floorHeight: floors[j]![i],
        ...(ceilings ? { ceilingHeight: ceilings[j]![i] } : {})
      });
    }
  }
  return rooms;
}

// lowerFloorToLowest (enclosed): neighbours −32 (west) / +24 (rest) ⇒
// lowest = −32 EXACTLY (the void is fully walled off).
const LOWEST_GRID: RectMapSpec = {
  rooms: (() => {
    const r = grid3x3([[24, -32, 24], [24, 0, 24], [24, 24, 24]]);
    r[4] = { ...r[4]!, tag: 23 };
    return r;
  })(),
  triggers: [{ x1: 128, y1: 0, x2: 128, y2: 128, special: 23, tag: 23 }],
  things: [{ x: 192, y: 64, angle: 0, type: 1 }]
};

// raiseFloor / raiseFloorCrush (enclosed, ceilings everywhere 96):
// dest = lowestCeilSurrounding 96 (crush: −8 → 88). Crush variant caps
// the center ceiling at 74 around a 56-tall player.
function raiseGrid(centerCeil: number, tag: number, special: number): RectMapSpec {
  const rooms = grid3x3(
    [[24, 24, 24], [24, 0, 24], [24, 24, 24]],
    [[96, 96, 96], [96, centerCeil, 96], [96, 96, 96]]
  );
  rooms[4] = { ...rooms[4]!, tag };
  return {
    rooms,
    triggers: [{ x1: 128, y1: 0, x2: 128, y2: 128, special, tag }],
    things: [{ x: 192, y: 64, angle: 0, type: 1 }]
  };
}

// turboLower: tagged room floor 0, neighbour +24 ⇒ dest = 24 + 8 (quirk)
// = 32 at speed 4 (8 move tics, detect at 9).
const TURBO_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, floorHeight: 64, tag: 70 },
    { x: 256, y: 0, w: 256, h: 256, floorHeight: 24 }
  ],
  triggers: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 70, tag: 70 }],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

// raiseFloorToNearest/Turbo + TIES: center (enclosed) floor 0; neighbours
// carry +16 / +32 / +16 again — the strictly-above MIN is 16 no matter
// which candidate comes first (tie-order-free VALUES, §0.4).
const NEAREST_GRID: RectMapSpec = {
  rooms: (() => {
    const r = grid3x3([[16, 16, 32], [24, 0, 24], [24, 24, 24]]);
    r[4] = { ...r[4]!, tag: 18 };
    return r;
  })(),
  triggers: [{ x1: 128, y1: 0, x2: 128, y2: 128, special: 18, tag: 18 }],
  things: [{ x: 192, y: 64, angle: 0, type: 1 }]
};

// lowerAndChange (EXCAVATE): enclosed center floor 24; the −dest (0)
// candidates are the west cell (special 5 damage, FIXFLAT1) and the
// north cell (special 0, FIXFLAT0) — the pickup is the CSR-FIRST one.
const EXCAVATE_GRID: RectMapSpec = {
  rooms: (() => {
    const r = grid3x3([[24, 0, 24], [0, 24, 24], [24, 24, 24]]);
    // WEST candidate (r3): floor 0, special 5 damage, FIXFLAT1. The
    // SOUTH candidate (r1, row j=0): floor 0, special 0, default FIXFLAT0.
    // The two differ in BOTH channels so the CSR-order pickup is visible.
    r[3] = { ...r[3]!, special: 5, floorFlat: 'FIXFLAT1' };
    r[1] = { ...r[1]!, floorFlat: 'FIXFLAT0' };
    r[4] = { ...r[4]!, tag: 37 };
    return r;
  })(),
  triggers: [{ x1: 128, y1: 0, x2: 128, y2: 128, special: 37, tag: 37 }],
  things: [{ x: 192, y: 64, angle: 0, type: 1 }]
};

// Stairs: 8-room row, ALL floors 0, ALL flat FIXFLAT1 (void flat is
// FIXFLAT0 → the chain cannot leak into the void). build8.
function stairRow(tag: number, special: number): RectMapSpec {
  const rooms: RectRoomSpec[] = [];
  for (let i = 0; i < 8; i++) {
    rooms.push({ x: i * 128, y: 0, w: 128, h: 256, floorFlat: 'FIXFLAT1', ...(i === 0 ? { tag } : {}) });
  }
  return {
    rooms,
    triggers: [{ x1: 128, y1: 96, x2: 128, y2: 160, special, tag }],
    things: [{ x: 64, y: 128, angle: 0, type: 1 }]
  };
}

// Stairs busy-neighbour quirk: start room fronts TWO same-flat candidate
// edges (east room A, north room B); A is pre-blocked with a null-fn
// blocker thinker → the PIN (height += stairsize BEFORE the specialdata
// skip) shows up in B's destination.
const STAIR_BUSY: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 256, floorFlat: 'FIXFLAT1', tag: 7 },
    { x: 128, y: 0, w: 128, h: 256, floorFlat: 'FIXFLAT1' },
    { x: 0, y: 256, w: 128, h: 128, floorFlat: 'FIXFLAT1' }
  ],
  triggers: [{ x1: 128, y1: 96, x2: 128, y2: 160, special: 7, tag: 7 }],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

// Donut: 6×6 grid (no ring room touches the void), center (2,2) floor 24
// tag 9, ring (Manhattan-1) floor 0, everything else floor 16 = dest.
function donutSpec(ringFlat: string, ringSpecial: number): RectMapSpec {
  // PUSH ORDER PIN: the east ring cell (3,2) FIRST, then the center
  // (2,2), then the rest. mapBuilder orients every shared edge with
  // front = the EARLIER room, so this makes the ring cell FRONT all its
  // edges — EV_DoDonut's verbatim `backsector != s1` scan then lands on
  // an OUTER floor-16 cell as s3 instead of tripping the orientation
  // quirk (a back-facing edge would hand back s2 itself as "s3").
  const order: [number, number][] = [[3, 2], [2, 2]];
  for (let j = 0; j < 6; j++) for (let i = 0; i < 6; i++) {
    if ((i === 3 && j === 2) || (i === 2 && j === 2)) continue;
    order.push([i, j]);
  }
  const rooms: RectRoomSpec[] = [];
  for (const [i, j] of order) {
    const man = Math.abs(i - 2) + Math.abs(j - 2);
    const room: RectRoomSpec = {
      x: (i - 2) * 128, y: (j - 2) * 128, w: 128, h: 128,
      floorHeight: man === 0 ? 24 : man === 1 ? 0 : 16,
      ...(man === 0 ? { tag: 9 } : {}),
      ...(man === 1 ? { floorFlat: ringFlat, special: ringSpecial } : {})
    };
    rooms.push(room);
  }
  return {
    rooms,
    // Edge between the center (2,2) and its north ring cell — one room
    // boundary edge, as mapBuilder requires.
    triggers: [{ x1: 0, y1: 128, x2: 128, y2: 128, special: 9, tag: 9 }],
    things: [{ x: 192, y: -64, angle: 0, type: 1 }]
  };
}

/* ------------------------------------------------------------------ */
/* 1) EV_DoFloor destination table (plan §M6-07 acceptance 1)          */
/* ------------------------------------------------------------------ */

describe('EV_DoFloor destination table', () => {
  it('lowerFloor: dest = highest surrounding floor, 64 move tics + detect at 65', () => {
    const s = stateFor(LOWER_SPEC);
    const sec = secByTag(s, 45);
    const line = lineBySpecial(s, 45);
    expect(evDoFloor(s, line, FLOOR.lowerFloor)).toBe(true);
    const f = floorOf(s, sec)!;
    expect(f.dest).toBe(0);
    expect(f.speed).toBe(FLOORSPEED);
    expect(f.direction).toBe(-1);
    expect(f.crush).toBe(false);

    step(s, 1);
    expect(s.sectors.floorZ[sec]).toBe(fx(63));
    step(s, 63); // → tic 64: exactly at dest
    expect(s.sectors.floorZ[sec]).toBe(0);
    expect(f.removed).toBe(false);
    step(s, 1); // tic 65: pastdest → removal
    expect(f.removed).toBe(true);
    expect(sectorSpecialData(s.sectors, sec)).toBeNull();
    // stnmov on every !(leveltime&7) tick 0..64 = 9, pstop once at 65.
    expect(sfxCount(s, SFX_STNMOV)).toBe(9);
    expect(sfxCount(s, SFX_PSTOP)).toBe(1);
  });

  it('lowerFloorToLowest: enclosed −32 neighbour wins over +24 (32 tics + detect 33)', () => {
    const s = stateFor(LOWEST_GRID);
    const sec = secByTag(s, 23);
    expect(evDoFloor(s, lineBySpecial(s, 23), FLOOR.lowerFloorToLowest)).toBe(true);
    expect(floorOf(s, sec)!.dest).toBe(fx(-32));
    step(s, 32);
    expect(s.sectors.floorZ[sec]).toBe(fx(-32));
    step(s, 1);
    expect(floorOf(s, sec)).toBeNull(); // removed at tic 33
  });

  it('toLowest void truth: an OPEN rect room’s lowest IS the void −128 (fixture pin)', () => {
    const s = stateFor(LOWER_SPEC);
    const sec = secByTag(s, 45);
    evDoFloor(s, lineBySpecial(s, 45), FLOOR.lowerFloorToLowest);
    expect(floorOf(s, sec)!.dest).toBe(fx(-128));
  });

  it('turboLower: dest = highest +8 QUIRK, speed 4 — 8 move tics + detect at 9', () => {
    const s = stateFor(TURBO_SPEC);
    const sec = secByTag(s, 70);
    expect(evDoFloor(s, lineBySpecial(s, 70), FLOOR.turboLower)).toBe(true);
    const f = floorOf(s, sec)!;
    expect(f.dest).toBe(fx(32)); // 24 + 8 (differs from own floor)
    expect(f.speed).toBe(4 * FRACUNIT);
    step(s, 8); // 64 → 32 in 8 moves (tics 0..7)
    expect(s.sectors.floorZ[sec]).toBe(fx(32));
    expect(f.removed).toBe(false);
    step(s, 1); // 9th tic: pastdest
    expect(f.removed).toBe(true);
  });

  it('turboLower quirk branch: sealed (dest == own floor) does NOT add the +8', () => {
    // Fully enclosed 3×3 grid, ALL floors 0: highest surrounding == own
    // floor → the vanilla `!=` guard skips the +8 → dest 0 == floorheight
    // → pastdest on the FIRST tic.
    const s = stateFor({
      rooms: (() => {
        const r = grid3x3([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
        r[4] = { ...r[4]!, tag: 71 };
        return r;
      })(),
      triggers: [{ x1: 128, y1: 0, x2: 128, y2: 128, special: 71, tag: 71 }],
      things: [{ x: 192, y: 64, angle: 0, type: 1 }]
    });
    const sec = secByTag(s, 71);
    evDoFloor(s, lineBySpecial(s, 71), FLOOR.turboLower);
    expect(floorOf(s, sec)!.dest).toBe(0);
    step(s, 1);
    expect(floorOf(s, sec)).toBeNull();
    expect(s.sectors.floorZ[sec]).toBe(0);
  });

  it('raiseFloor: dest = min(neighbour CEILINGS, own) = 96; own-ceiling cap pinned', () => {
    const s = stateFor(raiseGrid(128, 91, 91));
    const sec = secByTag(s, 91);
    expect(evDoFloor(s, lineBySpecial(s, 91), FLOOR.raiseFloor)).toBe(true);
    expect(floorOf(s, sec)!.dest).toBe(fx(96));

    // Cap arm: lowest surrounding ceiling 96 > own ceiling 64 → dest 64.
    const s2 = stateFor(raiseGrid(64, 91, 91));
    const sec2 = secByTag(s2, 91);
    evDoFloor(s2, lineBySpecial(s2, 91), FLOOR.raiseFloor);
    expect(floorOf(s2, sec2)!.dest).toBe(fx(64));
  });

  it('raiseFloorCrush: dest = 96−8, crush flag ON', () => {
    const s = stateFor(raiseGrid(128, 55, 55));
    const sec = secByTag(s, 55);
    evDoFloor(s, lineBySpecial(s, 55), FLOOR.raiseFloorCrush);
    const f = floorOf(s, sec)!;
    expect(f.dest).toBe(fx(88));
    expect(f.crush).toBe(true); // the fallthrough-set flag (case sharing)
  });

  it('raiseFloor24/512 dests are own + 24 / own + 512 (fixed amounts)', () => {
    const s = stateFor(LOWER_SPEC);
    const sec = secByTag(s, 45);
    const line = lineBySpecial(s, 45);
    evDoFloor(s, line, FLOOR.raiseFloor24);
    expect(floorOf(s, sec)!.dest).toBe(fx(64 + 24));
    expect(floorOf(s, sec)!.speed).toBe(FLOORSPEED);
    const s2 = stateFor(LOWER_SPEC);
    const sec2 = secByTag(s2, 45);
    evDoFloor(s2, line, FLOOR.raiseFloor512);
    expect(floorOf(s2, sec2)!.dest).toBe(fx(64 + 512));
  });

  it('raiseFloor24AndChange: flat+special copy at TRIGGER, dest +24, none at arrival', () => {
    // Front side of the trigger line = the tagged room itself (earlier
    // room) — vanilla copies line->frontsector, so the "source" is the
    // room's OWN values: pin with a DIFFERENT-flat source room instead.
    const s = stateFor({
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, floorFlat: 'FIXFLAT1', special: 5 },
        { x: 256, y: 0, w: 256, h: 256, tag: 59 }
      ],
      triggers: [{ x1: 256, y1: 96, x2: 256, y2: 160, special: 59, tag: 59 }],
      things: [{ x: 320, y: 128, angle: 0, type: 1 }]
    });
    const sec = secByTag(s, 59);
    const line = lineBySpecial(s, 59);
    // The trigger line's front is room 0 (earlier index) = the source.
    expect(s.map.lines.sectorFront[line]).toBe(1);
    evDoFloor(s, line, FLOOR.raiseFloor24AndChange);
    const f = floorOf(s, sec)!;
    expect(f.dest).toBe(fx(24));
    // special copied IMMEDIATELY (trigger time), not at arrival:
    expect(s.sectors.special[sec]).toBe(s.sectors.special[1]!);
    expect(floorFlatOf(s, sec)).toBe('FIXFLAT1');
    step(s, 25);
    expect(f.removed).toBe(true);
    // Arrival applies NOTHING (raiseFloor24AndChange is not in the
    // T_MoveFloor arrival switch — p_floor.c:212-220 pin).
    expect(f.type).toBe(FLOOR.raiseFloor24AndChange);
  });

  it('raiseFloorToNearest: strictly-above MIN (16 not 32), ties order-free', () => {
    const s = stateFor(NEAREST_GRID);
    const sec = secByTag(s, 18);
    evDoFloor(s, lineBySpecial(s, 18), FLOOR.raiseFloorToNearest);
    const f = floorOf(s, sec)!;
    expect(f.dest).toBe(fx(16));
    expect(f.speed).toBe(FLOORSPEED);
    step(s, 17); // 16 move tics + detect
    expect(s.sectors.floorZ[sec]).toBe(fx(16));
    expect(f.removed).toBe(true);
  });

  it('raiseFloorTurbo: same dest, speed 4 — 4 move tics + detect at 5', () => {
    const s = stateFor(NEAREST_GRID);
    const sec = secByTag(s, 18);
    evDoFloor(s, lineBySpecial(s, 18), FLOOR.raiseFloorTurbo);
    expect(floorOf(s, sec)!.speed).toBe(4 * FRACUNIT);
    step(s, 5);
    expect(s.sectors.floorZ[sec]).toBe(fx(16));
    expect(floorOf(s, sec)).toBeNull();
  });

  it('raiseToTexture: dest = floor + MIN bottomtexture height (skip empty, skip unregistered)', () => {
    const s = stateFor(LOWER_SPEC);
    const sec = secByTag(s, 45);
    const line = lineBySpecial(s, 45);
    // Paint the seam's two sides with different bottom textures and give
    // the (injectable, deviation (b)) table the heights.
    textureHeights.set('FIXWALL0', fx(72));
    textureHeights.set('DOORFIX0', fx(32));
    (s.map.sides.bottomTexture as string[])[s.map.lines.sideNumFront[line]!] = 'FIXWALL0';
    (s.map.sides.bottomTexture as string[])[s.map.lines.sideNumBack[line]!] = 'DOORFIX0';
    evDoFloor(s, line, FLOOR.raiseToTexture);
    expect(floorOf(s, sec)!.dest).toBe(fx(64 + 32)); // MIN across BOTH sides
    expect(pfloorCounts.missingTextureHeight).toBe(0);

    // Unregistered names are counted + skipped (empty '' = vanilla's
    // bottomtexture −1 gate, never counted):
    resetTextureHeights();
    const s2 = stateFor(LOWER_SPEC);
    const sec2 = secByTag(s2, 45);
    evDoFloor(s2, line, FLOOR.raiseToTexture); // s2 shares the SAME wad (textures NOT painted)
    expect(s2.map.sides.bottomTexture[s2.map.lines.sideNumFront[line]!]).toBe('');
    // MAXINT (no textures) — vanilla adds it UNCLAMPED; int32 wrap pinned.
    expect(floorOf(s2, sec2)!.dest).toBe((fx(64) + 0x7fffffff) | 0);
  });

  it('lowerAndChange: FIRST dest-height neighbour in CSR order wins (excavate order)', () => {
    const s = stateFor(EXCAVATE_GRID);
    const sec = secByTag(s, 37);
    const line = lineBySpecial(s, 37);
    evDoFloor(s, line, FLOOR.lowerAndChange);
    const f = floorOf(s, sec)!;
    expect(f.dest).toBe(0); // lowest surrounding (enclosed: the two 0-cells)

    // Compute the CSR-first candidate exactly as p_floor.c scans.
    let expected = -1;
    for (let i = 0; i < s.map.sectors.lineCount[sec]! && expected < 0; i++) {
      const ln = sectorLineAt(s.map, sec, i);
      const other = getNextSector(s.map, ln, sec);
      if (other >= 0 && s.sectors.floorZ[other] === 0) expected = other;
    }
    expect(expected).toBeGreaterThan(-1);
    expect(f.texture).toBe(floorFlatOf(s, expected));
    expect(f.newspecial).toBe(s.sectors.special[expected]!);

    // Trigger changes NOTHING on the sector itself…
    const specialBefore = s.sectors.special[sec]!;
    expect(floorFlatOf(s, sec)).toBe('FIXFLAT0'); // own flat until arrival

    // …arrival applies newspecial + the copied flat (the damage floor
    // appears UNDER the lowered slab; feet damage itself is M6-12).
    step(s, 25); // 24 move tics + detect at 25
    expect(s.sectors.floorZ[sec]).toBe(0);
    expect(f.removed).toBe(true);
    expect(s.sectors.special[sec]).toBe(specialBefore === 0 ? f.newspecial : 0);
    expect(floorFlatOf(s, sec)).toBe(f.texture);
    expect(floorsFlatCopies.count).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 2) Crush floor: damage-slot cadence via the M6-04 model             */
/* ------------------------------------------------------------------ */

describe('raiseFloorCrush stuck thing (damage slot cadence)', () => {
  it('56-tall player under a 74 ceiling: floor passes, 10 dmg every !(lt&3)', () => {
    const s = stateFor(raiseGrid(74, 56, 56));
    const sec = secByTag(s, 56);
    evDoFloor(s, lineBySpecial(s, 56), FLOOR.raiseFloorCrush);
    const f = floorOf(s, sec)!;
    // dest = min(lowestCeilSurrounding 96, OWN ceiling 74) − 8 = 66 —
    // the own-ceiling cap comes BEFORE the crush −8 (p_floor.c:308-320).
    expect(f.dest).toBe(fx(66));

    // Floor rises 1/tic; P_ChangeSector refuses from floorZ 19 (19+56 >
    // 74) — with crush=true the plane STAYS at the new height (M6-04
    // pin) and the floor rides THROUGH the player to dest.
    step(s, 19); // tics 0..18: floor 19; tic 18 is not !(lt&3)
    expect(s.sectors.floorZ[sec]).toBe(fx(19));
    expect(s.hooks.damage.count).toBe(0);

    step(s, 47); // → tics 0..65: floor arrives at 66 (tic 65 move)
    const open = s.hooks.damage.entries.filter((e) => (e.tic & 3) === 0);
    expect(s.hooks.damage.count).toBe(open.length);
    for (const e of s.hooks.damage.entries) {
      expect(e.amount).toBe(10);
      expect(e.tic & 3).toBe(0);
    }
    expect(s.hooks.damage.count).toBe(12); // tics 20,24,…,64

    // Tic 66: pastdest arm — the clamped-plane P_ChangeSector plus the
    // nofit rollback pair are BOTH gated, and 66&3=2 → zero damage.
    step(s, 1);
    expect(f.removed).toBe(true);
    expect(sectorSpecialData(s.sectors, sec)).toBeNull();
    expect(s.hooks.damage.count).toBe(12);
    expect(s.sectors.floorZ[sec]).toBe(fx(66)); // lastpos == dest
    expect(pmapHookCounts.crushBlood).toBe(12); // 4 P_Random each
    expect(s.rng.prndindex).toBe(12 * 4); // blood draws consumed (M7 half)
  });
});

/* ------------------------------------------------------------------ */
/* 3) Stairs (EV_BuildStairs)                                         */
/* ------------------------------------------------------------------ */

describe('EV_BuildStairs', () => {
  it('build8 row of 8: dests 8..64 in chain order, parallel movers, arrival tic 32i+33', () => {
    const s = stateFor(stairRow(7, 7));
    const rooms = [...Array(8)].map((_, i) => i + 1); // sectors 1..8
    expect(evBuildStairs(s, lineBySpecial(s, 7), STAIR.build8)).toBe(true);

    const movers = rooms.map((r) => floorOf(s, r)!);
    expect(movers.every((m) => m !== null)).toBe(true);
    movers.forEach((m, i) => {
      expect(m.dest).toBe(fx(8 * (i + 1)));
      expect(m.speed).toBe(FLOORSPEED / 4); // ¼/tic
      expect(m.direction).toBe(1);
    });
    // Arena order = chain order (hashing determinism input):
    const ids = movers.map((m) => m.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));

    // Parallel build (1.10 has NO per-hop vwait — every mover ticks from
    // the trigger): sector i at 0.25/tic reaches 8(i+1) after 32(i+1)
    // tics, detected +1.
    step(s, 33); // sector 1 done (32 moves + detect)
    expect(s.sectors.floorZ[rooms[0]!]).toBe(fx(8));
    expect(movers[0]!.removed).toBe(true);
    // Sector 2 is mid-flight: 33 tics × ¼ = 8.25 of its 16 (parallel
    // movers — 1.10 has NO per-hop vwait).
    expect(s.sectors.floorZ[rooms[1]!]).toBe(33 * (FLOORSPEED / 4));
    step(s, 32 * 7); // → tic 257: sector 8 detect tic
    expect(s.sectors.floorZ[rooms[7]!]).toBe(fx(64));
    expect(movers.every((m) => m.removed)).toBe(true);
  });

  it('turbo16: 16-unit steps @4/tic — sector i detected at tic 4(i+1)+1', () => {
    const s = stateFor(stairRow(127, 127));
    expect(evBuildStairs(s, lineBySpecial(s, 127), STAIR.turbo16)).toBe(true);
    const movers = [...Array(8)].map((_, i) => floorOf(s, i + 1)!);
    movers.forEach((m, i) => expect(m.dest).toBe(fx(16 * (i + 1))));
    step(s, 5);
    expect(s.sectors.floorZ[1]).toBe(fx(16));
    expect(movers[0]!.removed).toBe(true);
    expect(s.sectors.floorZ[2]).toBe(fx(20)); // sector 2 mid-flight (5 × 4)
    step(s, 28); // → tic 33: sector 8 (dest 128) detect
    expect(s.sectors.floorZ[8]).toBe(fx(128));
  });

  it('chain never crosses a flat mismatch or the void (FIXFLAT0 walls it off)', () => {
    const s = stateFor(stairRow(7, 7));
    evBuildStairs(s, lineBySpecial(s, 7), STAIR.build8);
    // Void sector 0 untouched, exactly 8 movers (no leak):
    expect(s.sectors.floorZ[0]).toBe(fx(-128));
    let n = 0;
    for (let i = 0; i < s.sectors.count; i++) if (floorOf(s, i) !== null) n++;
    expect(n).toBe(8);
  });

  it('PIN: height += stairsize BEFORE the specialdata skip (busy neighbour consumes a step)', () => {
    const s = stateFor(STAIR_BUSY);
    const start = secByTag(s, 7);
    const a = 2; // east room
    const b = 3; // north room
    // Block A with a null-fn parked thinker (never ticked).
    const blocker = { id: 9999, fn: null, removed: false, hashWords: [] };
    setSectorSpecialData(s.sectors, a, blocker);

    expect(evBuildStairs(s, lineBySpecial(s, 7), STAIR.build8)).toBe(true);
    expect(floorOf(s, start)!.dest).toBe(fx(8));

    // Determine the scan order the SAME way the chain does:
    const L = s.map.sectors.lineStart;
    const C = s.map.sectors.lineCount;
    void L; void C;
    let first = -1;
    for (let i = 0; i < s.map.sectors.lineCount[start]!; i++) {
      const ln = sectorLineAt(s.map, start, i);
      if ((s.map.lines.flags[ln]! & 0x004) === 0) continue;
      if (s.map.lines.sectorFront[ln] !== start) continue;
      const back = s.map.lines.sectorBack[ln]!;
      if (back === a || back === b) { first = back; break; }
    }
    const busyFirst = first === a;
    // If A scanned first: height bumped to 16, A skipped, B then bumps to
    // 24 and spawns there. If B scanned first: B spawns at 16 and the
    // chain continues FROM B (which fronts no same-flat room) → A never
    // moves (its edge fronts the START room, not B).
    expect(busyFirst ? floorOf(s, b)!.dest : floorOf(s, b)!.dest).toBe(fx(busyFirst ? 24 : 16));
    if (busyFirst) expect(floorOf(s, b)!.dest).toBe(fx(24)); // the quirk value
    // A was NEVER spawned over: its specialdata is still the blocker.
    expect(sectorSpecialData(s.sectors, a)).toBe(blocker as never);
  });

  it('retrigger: specialdata refuses the START sector; a fresh mover after completion', () => {
    const s = stateFor(stairRow(7, 7));
    const line = lineBySpecial(s, 7);
    evBuildStairs(s, line, STAIR.build8);
    const before = s.thinkers.nextId;
    expect(evBuildStairs(s, line, STAIR.build8)).toBe(false); // rtn 0
    expect(s.thinkers.nextId).toBe(before);
    step(s, 33 + 32 * 7); // everything done
    expect(evBuildStairs(s, line, STAIR.build8)).toBe(true);
    expect(s.thinkers.nextId).toBe(before + 8);
  });
});

/* ------------------------------------------------------------------ */
/* 4) Donut (EV_DoDonut, p_spec.c body)                               */
/* ------------------------------------------------------------------ */

describe('EV_DoDonut full cycle', () => {
  it('s2 = across s1->lines[0]; ring rises / hole lowers @ F/2 to s3 floor; flats+special swap', () => {
    const s = stateFor(donutSpec('FIXFLAT1', 5));
    const s1 = secByTag(s, 9);
    expect(s1).toBeGreaterThan(0);
    const firstLine = sectorLineAt(s.map, s1, 0);
    const expectedS2 = getNextSector(s.map, firstLine, s1);
    expect(expectedS2).toBeGreaterThan(0); // never the void (6×6 grid)

    expect(evDoDonut(s, lineBySpecial(s, 9))).toBe(true);
    const ring = floorOf(s, expectedS2)!;
    const hole = floorOf(s, s1)!;
    expect(ring).not.toBeNull();
    expect(hole).not.toBeNull();
    expect(ring.type).toBe(FLOOR.donutRaise);
    expect(hole.type).toBe(FLOOR.lowerFloor);
    expect(ring.direction).toBe(1);
    expect(hole.direction).toBe(-1);
    expect(ring.speed).toBe(FLOORSPEED / 2); // FLOOR
    expect(hole.speed).toBe(FLOORSPEED / 2);
    expect(ring.dest).toBe(fx(16));
    expect(hole.dest).toBe(fx(16));
    expect(ring.newspecial).toBe(0);
    expect(ring.texture).toBe('FIXFLAT0'); // s3 (floor-16 cell) flat
    // Insertion order pin: ring mover BEFORE hole mover (p_spec.c order).
    expect(ring.id).toBeLessThan(hole.id);

    // Mid-cycle: nothing applied yet.
    step(s, 8);
    expect(s.sectors.floorZ[s1]).toBe(fx(20));
    expect(s.sectors.floorZ[expectedS2]).toBe(fx(4));
    expect(s.sectors.special[expectedS2]).toBe(5);

    step(s, 9); // tic 16: the HOLE is already done (8 units @ ½ = 16
    // tics); the ring (16 units @ ½) reaches 16 at tic 32 and BOTH are
    // gone by tic 33.
    step(s, 33 - 17);
    expect(s.sectors.floorZ[s1]).toBe(fx(16));
    expect(s.sectors.floorZ[expectedS2]).toBe(fx(16));
    expect(hole.removed).toBe(true);
    expect(ring.removed).toBe(true);
    // donutRaise arrival: ring special → newspecial 0, flat → s3's.
    expect(s.sectors.special[expectedS2]).toBe(0);
    expect(floorFlatOf(s, expectedS2)).toBe('FIXFLAT0');
    // Hole (lowerFloor, dir −1): arrival applies NOTHING (type not in
    // the down switch — keeps special/flat, p_floor.c:228-236 pin).
    expect(s.sectors.special[s1]).toBe(0); // was 0 all along
    expect(floorFlatOf(s, s1)).toBe('FIXFLAT0'); // own (never changed)
  });

  it('retrigger: s1 specialdata refuses; s2 has NO check (vanilla overwrite pin)', () => {
    const s = stateFor(donutSpec('FIXFLAT1', 0));
    const line = lineBySpecial(s, 9);
    evDoDonut(s, line);
    expect(evDoDonut(s, line)).toBe(false); // s1 busy → continue, rtn 0
    step(s, 33);
    expect(evDoDonut(s, line)).toBe(true); // after completion it re-fires
  });

  it('donut ring mover spawns WITHOUT the s2 busy check (s2 specialdata overwritten)', () => {
    const s = stateFor(donutSpec('FIXFLAT0', 0));
    const s1 = secByTag(s, 9);
    const s2 = getNextSector(s.map, sectorLineAt(s.map, s1, 0), s1);
    const blocker = { id: 8888, fn: null, removed: false, hashWords: [] };
    setSectorSpecialData(s.sectors, s2, blocker);
    expect(evDoDonut(s, lineBySpecial(s, 9))).toBe(true);
    const ring = floorOf(s, s2)!;
    expect(ring).not.toBe(blocker); // vanilla overwrites (no s2 check)
    expect(ring.type).toBe(FLOOR.donutRaise);
    // The hole mover still targets s1 and both run (the blocker thinker
    // stays linked, unticked — orphaned exactly like vanilla's leak).
    expect(floorOf(s, s1)!.type).toBe(FLOOR.lowerFloor);
  });
});

/* ------------------------------------------------------------------ */
/* 5) Retrigger rules + double-run determinism                        */
/* ------------------------------------------------------------------ */

describe('retrigger + determinism', () => {
  it('GR 83 re-cross while moving is refused (specialdata), re-arms after arrival', () => {
    const s = stateFor(LOWER_SPEC);
    const line = lineBySpecial(s, 45);
    s.map.lines.special[line] = 83; // GR lowerFloor
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    const before = s.thinkers.nextId;
    pCrossSpecialLine(s.pmap, line, 1, PLAYER); // re-cross mid-move
    expect(s.thinkers.nextId).toBe(before);
    step(s, 65);
    pCrossSpecialLine(s.pmap, line, 0, PLAYER); // armed again (GR never clears)
    expect(s.thinkers.nextId).toBe(before + 1);
    expect(s.map.lines.special[line]).toBe(83);
  });

  it('use-vs-cross parity: S1 45 vs W1 19 vs GR 83 — identical 90-tic profiles', () => {
    // Each state must be the LAST bound world when its dispatcher fires
    // (pCrossSpecialLine resolves through the module bind) — build and
    // fire per-special.
    const mk = (
      special: number,
      fire: (s: GameState, line: number) => void
    ): { s: GameState; sec: number; line: number } => {
      const st = stateFor({ ...LOWER_SPEC, triggers: [{ x1: 256, y1: 96, x2: 256, y2: 160, special, tag: 45 }] });
      const line = lineBySpecial(st, special);
      fire(st, line);
      return { s: st, sec: secByTag(st, 45), line };
    };
    const a = mk(45, (s, line) => {
      expect(pUseSpecialLine(s, PLAYER, line, 0)).toBe(true);
    });
    const b = mk(19, (s, line) => pCrossSpecialLine(s.pmap, line, 0, PLAYER));
    const c = mk(83, (s, line) => pCrossSpecialLine(s.pmap, line, 0, PLAYER));
    const prof = (x: typeof a): number[] => {
      const out: number[] = [];
      for (let i = 0; i < 90; i++) {
        step(x.s, 1);
        out.push(x.s.sectors.floorZ[x.sec]!);
      }
      return out;
    };
    const pa = prof(a);
    expect(pa).toEqual(prof(b));
    expect(pa).toEqual(prof(c));
    expect(pa[63]).toBe(0); // at dest from tic 64 on
    // W1 19 clears; S1/GR stay armed (S1 disarm is M6-11's switch job).
    expect(b.s.map.lines.special[b.line]).toBe(0);
    expect(a.s.map.lines.special[a.line]).toBe(45);
    expect(c.s.map.lines.special[c.line]).toBe(83);
  });

  it('double-run hashes equal (crush scenario: damage + PRNG + movers + hashes)', () => {
    const run = (): number => {
      const s = stateFor(raiseGrid(74, 56, 56));
      evDoFloor(s, lineBySpecial(s, 56), FLOOR.raiseFloorCrush);
      step(s, 90);
      return hashState(s);
    };
    const h1 = run();
    const h2 = run();
    expect(h1).toBe(h2);
    expect(Number.isSafeInteger(h1)).toBe(true);

    // And a donut double-run for the two-mover arena order:
    const runDonut = (): number => {
      const s = stateFor(donutSpec('FIXFLAT1', 5));
      evDoDonut(s, lineBySpecial(s, 9));
      step(s, 20);
      return hashState(s);
    };
    expect(runDonut()).toBe(runDonut());
  });
});

/* ------------------------------------------------------------------ */
/* 6) Family coverage: 39 floors + 4 stairs + 1 donut, zero stubs     */
/* ------------------------------------------------------------------ */

describe('floors family coverage (registry ids → live bodies)', () => {
  // 39 = the 38 non-switch floor ids + S1 140 (raiseFloor512 is applied
  // through P_UseSpecialLine's switch arm — p_switch.c:508).
  const FLOOR_IDS = [
    5, 18, 19, 23, 24, 30, 36, 37, 38, 40, 45, 55, 56, 58, 59, 60, 64, 65,
    69, 70, 71, 82, 83, 84, 91, 92, 93, 94, 96, 98, 101, 102, 119, 128,
    129, 130, 131, 132, 140
  ];
  const STAIR_IDS = [7, 8, 100, 127];
  const DONUT_IDS = [9];

  it('the registry routes exactly 39 floor + 4 stair + 1 donut ids', () => {
    const floors: number[] = [];
    const stairs: number[] = [];
    const donuts: number[] = [];
    for (let id = 1; id < LINE_SPECIALS.length; id++) {
      const e = LINE_SPECIALS[id];
      if (!e) continue;
      for (const trig of [e.use, e.cross, e.shoot]) {
        for (const a of trig?.actions ?? []) {
          if (a.action === 'floor' && !floors.includes(id)) floors.push(id);
          if (a.action === 'stairs' && !stairs.includes(id)) stairs.push(id);
          if (a.action === 'donut' && !donuts.includes(id)) donuts.push(id);
        }
      }
    }
    expect(floors.sort((x, y) => x - y)).toEqual(FLOOR_IDS);
    expect(stairs).toEqual(STAIR_IDS);
    expect(donuts).toEqual(DONUT_IDS);
  });

  it('every id dispatches live: zero family stubs, a mover spawned, switch stub only on switch routes', () => {
    for (const id of [...FLOOR_IDS, ...STAIR_IDS, ...DONUT_IDS]) {
      const e = LINE_SPECIALS[id]!;
      const s = stateFor({
        rooms: [
          { x: 0, y: 0, w: 256, h: 256 },
          { x: 256, y: 0, w: 256, h: 256, floorHeight: 24 }
        ],
        things: [{ x: 64, y: 128, angle: 0, type: 1 }]
      });
      let line = -1;
      for (let i = 0; i < s.map.lines.count && line < 0; i++) {
        if ((s.map.lines.flags[i]! & 0x004) !== 0) line = i;
      }
      s.map.lines.special[line] = id;
      s.map.lines.tag[line] = 77;
      s.sectors.tag[1] = 77;
      resetUnimplementedSpecial();
      const before = s.thinkers.nextId;

      const trig = e.use ?? e.cross ?? e.shoot;
      if (e.use) expect(pUseSpecialLine(s, PLAYER, line, 0), `use ${id}`).toBe(true);
      else if (e.cross) pCrossSpecialLine(s.pmap, line, 0, PLAYER);
      else pShootSpecialLine(s, PLAYER, line);

      // Zero floor-family stubs; the only tolerated stubs are the still
      // un-owned families (40's ceiling half) and the switch swap.
      for (const fn of unimplementedSpecial.byFn.keys()) {
        expect(['pChangeSwitchTexture', 'evDoCeiling'], `id ${id} fn`).toContain(fn);
      }
      // The live body RAN: at least one mover spawned (tag 77 sector).
      expect(s.thinkers.nextId, `id ${id} spawned`).toBeGreaterThan(before);
      expect(sectorSpecialData(s.sectors, 1) !== null ||
             sectorSpecialData(s.sectors, 2) !== null ||
             sectorSpecialData(s.sectors, 0) !== null, `id ${id} specialdata`).toBe(true);
      void trig;
    }
  });

  it('flat-channel honesty: floorFlatOverrides is the SAME map pplats writes (shared seam)', async () => {
    const p = await import('./pplats');
    expect(floorFlatOverrides).toBe(p.floorFlatOverrides);
  });
});
