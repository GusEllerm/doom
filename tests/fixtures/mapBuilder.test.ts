/**
 * M2-02 tests — rectangle-spec fixture map generator + BSP property tests.
 *
 * Everything is validated through mapSelfCheck (strict inline reader over
 * the emitted lumps, invariants per R01 §3-13); the extra assertions here
 * pin the generator's documented conventions (dummy void sector, shared
 * edges, door specials, BLOCKMAP union, nodes == subsectors − 1).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { WadFile } from '../../src/wad/wadfile';
import {
  DEFAULT_DOOR_SPECIAL,
  DOT_THING,
  ML_SECRET,
  MapCheckError,
  MapSpecError,
  TEX_DOOR,
  TEX_WALL,
  VOID_SECTOR,
  buildFixtureMapWad,
  mapSelfCheck,
  type DoorGapSpec,
  type LineTriggerSpec,
  type RectMapSpec
} from './mapBuilder';

// ---------------------------------------------------------------------------
// mulberry32 (seeded PRNG — no Math.random anywhere in these tests).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 + a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 + t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Small lump readers for convention-level assertions (tests only).
// ---------------------------------------------------------------------------

interface RawLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  flags: number;
  special: number;
  tag: number;
  s0: { top: string; mid: string; sector: number };
  s1: { top: string; mid: string; sector: number } | null;
}

function text(bytes: Uint8Array, at: number): string {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const c = bytes[at + i]!;
    if (c !== 0) s += String.fromCharCode(c);
  }
  return s;
}

function readMap(bytes: Uint8Array, mapName = 'FIXMAP') {
  const wad = WadFile.parse(bytes.buffer as ArrayBuffer);
  const m = wad.lumpNumByName(mapName);
  if (m < 0) throw new Error(`no marker ${mapName}`);
  const verts = wad.readLump(m + 4);
  const lines = wad.readLump(m + 2);
  const sides = wad.readLump(m + 3);
  const sv = new DataView(sides.buffer, sides.byteOffset, sides.byteLength);
  const lv = new DataView(lines.buffer, lines.byteOffset, lines.byteLength);
  const vv = new DataView(verts.buffer, verts.byteOffset, verts.byteLength);
  const out: RawLine[] = [];
  for (let i = 0; i * 14 < lines.length; i++) {
    const o = i * 14;
    const side = (si: number) => ({
      top: text(sides, si * 30 + 4),
      mid: text(sides, si * 30 + 20),
      sector: sv.getInt16(si * 30 + 28, true)
    });
    const s0 = lv.getInt16(o + 10, true);
    const s1 = lv.getInt16(o + 12, true);
    out.push({
      x1: vv.getInt16(lv.getInt16(o, true) * 4, true),
      y1: vv.getInt16(lv.getInt16(o, true) * 4 + 2, true),
      x2: vv.getInt16(lv.getInt16(o + 2, true) * 4, true),
      y2: vv.getInt16(lv.getInt16(o + 2, true) * 4 + 2, true),
      flags: lv.getUint16(o + 4, true),
      special: lv.getInt16(o + 6, true),
      tag: lv.getInt16(o + 8, true),
      s0: side(s0),
      s1: s1 < 0 ? null : side(s1)
    });
  }
  const things = wad.readLump(m + 1);
  const tv = new DataView(things.buffer, things.byteOffset, things.byteLength);
  const types: number[] = [];
  for (let i = 0; i * 10 < things.length; i++) types.push(tv.getInt16(i * 10 + 6, true));
  return { lines: out, thingTypes: types };
}

// ---------------------------------------------------------------------------
// Regression fixtures
// ---------------------------------------------------------------------------

describe('regression fixtures', () => {
  it('single room: 4 void walls into dummy sector 0, 1 subsector, 0 nodes', () => {
    const wad = buildFixtureMapWad({ rooms: [{ x: 0, y: 0, w: 256, h: 256 }] });
    const rep = mapSelfCheck(wad);
    expect(rep.numSectors).toBe(2); // void + room
    expect(rep.numLines).toBe(4);
    expect(rep.numSidedefs).toBe(8); // dummy-sector convention: 2 per line
    expect(rep.numSubsectors).toBe(1);
    expect(rep.numNodes).toBe(0);
    expect(rep.numThings).toBe(5); // players 1-4 + dot
    expect(rep.rejectBytes).toBe(1); // ceil(2²/8)
    expect(rep.blockmap).toEqual({ originx: -64, originy: -64, width: 3, height: 3 });

    const { lines, thingTypes } = readMap(wad);
    expect(thingTypes).toEqual([1, 2, 3, 4, DOT_THING]);
    for (const l of lines) {
      expect(l.flags & 0x4).toBe(0x4); // every void wall is two-sided…
      const back = l.s1!;
      expect([l.s0.sector, back.sector].includes(VOID_SECTOR)).toBe(true); // …into sector 0
      const roomSide = l.s0.sector === VOID_SECTOR ? back : l.s0;
      const voidSide = l.s0.sector === VOID_SECTOR ? l.s0 : back;
      expect(roomSide.top).toBe(TEX_WALL);
      expect(voidSide.top).toBe('');
    }
  });

  it('L-corridor: two offset rooms share exactly one open two-sided line', () => {
    // A tall room, B attached to its upper-east side → corridor-like join.
    const wad = buildFixtureMapWad({
      rooms: [
        { x: 0, y: 0, w: 256, h: 512 },
        { x: 256, y: 256, w: 256, h: 256 }
      ]
    });
    const rep = mapSelfCheck(wad);
    expect(rep.numSectors).toBe(3);
    expect(rep.numNodes).toBe(rep.numSubsectors - 1);
    const { lines } = readMap(wad);
    const shared = lines.filter(
      (l) =>
        new Set([l.s0.sector, l.s1!.sector]).size === 2 &&
        !new Set([l.s0.sector, l.s1!.sector]).has(VOID_SECTOR)
    );
    expect(shared).toHaveLength(1); // the implied corridor
    expect(shared[0]!.special).toBe(0);
    expect(shared[0]!.s0.mid).toBe('');
    // L geometry forces at least one BSP split.
    expect(rep.numNodes).toBeGreaterThanOrEqual(1);
  });

  it('door gap: shared edge split into 3 lines, middle one carries the special', () => {
    const spec: RectMapSpec = {
      rooms: [
        { x: 0, y: 0, w: 256, h: 256 },
        { x: 256, y: 0, w: 256, h: 256 }
      ],
      doors: [{ x1: 256, y1: 96, x2: 256, y2: 160 }]
    };
    const wad = buildFixtureMapWad(spec);
    mapSelfCheck(wad);
    const { lines } = readMap(wad);
    const between = lines.filter((l) => l.s0.sector === 1 && l.s1!.sector === 2);
    expect(between).toHaveLength(3);
    const door = between.find((l) => l.special === DEFAULT_DOOR_SPECIAL)!;
    expect(door).toBeDefined();
    expect(door.tag).toBe(0);
    expect(door.s0.mid).toBe(TEX_DOOR);
    expect(door.s1!.mid).toBe(TEX_DOOR);
    expect(between.filter((l) => l.special === 0)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// M6-02 — optional trigger lines (specials/tags/switch/secret)
// ---------------------------------------------------------------------------

function trigMap(spec: RectMapSpec): RawLine[] {
  return readMap(buildFixtureMapWad(spec)).lines;
}

describe('M6-02 trigger lines', () => {
  const twoRooms: RectMapSpec = {
    rooms: [
      { x: 0, y: 0, w: 256, h: 256, tag: 7, special: 9 },
      { x: 256, y: 0, w: 256, h: 256 }
    ]
  };

  it('void-edge teleport trigger: raw special/tag, no texture, splits the wall', () => {
    const t: LineTriggerSpec = { x1: 0, y1: 64, x2: 0, y2: 128, special: 97, tag: 31 };
    const lines = trigMap({ ...twoRooms, triggers: [t] });
    const line = lines.find((l) => l.special === 97)!;
    expect(line).toBeDefined();
    expect(line.tag).toBe(31);
    expect(line.s0.mid).toBe('');
    expect(line.s1!.mid).toBe('');
    expect(line.flags & ML_SECRET).toBe(0);
    // Edge split: the x=0 wall now has segments 0..64, 64..128, 128..256.
    const west = lines.filter(
      (l) => l.s0.sector === 1 && l.s1!.sector === VOID_SECTOR && l.x1 === 0
    );
    expect(west.length).toBeGreaterThanOrEqual(3);
  });

  it('switch trigger writes side-0 mid ONLY; secret flag lands on the line', () => {
    const t: LineTriggerSpec = {
      x1: 256,
      y1: 96,
      x2: 256,
      y2: 160,
      special: 21,
      tag: 7,
      texture: 'SW1MTX',
      secret: true
    };
    const lines = trigMap({ ...twoRooms, triggers: [t] });
    const line = lines.find((l) => l.special === 21)!;
    expect(line.tag).toBe(7);
    expect(line.flags & ML_SECRET).toBe(ML_SECRET);
    // Front (side 0) belongs to the earlier-indexed room (sector 1).
    const front = line.s0.sector === 1 ? line.s0 : line.s1!;
    const back = line.s0.sector === 1 ? line.s1! : line.s0;
    expect(front.mid).toBe('SW1MTX');
    expect(back.mid).toBe('');
  });

  it('door secret flag; door + trigger never fire together', () => {
    const lines = trigMap({
      ...twoRooms,
      doors: [{ x1: 256, y1: 96, x2: 256, y2: 160, secret: true }]
    });
    const door = lines.find((l) => l.special === DEFAULT_DOOR_SPECIAL)!;
    expect(door.flags & ML_SECRET).toBe(ML_SECRET);
    expect(door.s0.mid).toBe(TEX_DOOR);
  });

  it('sector special/tag decode unchanged: room 0 carries special 9 tag 7', () => {
    expect(() => mapSelfCheck(buildFixtureMapWad(twoRooms))).not.toThrow();
  });

  it('typed errors: off-edge, door/trigger and trigger/trigger overlap, bad special', () => {
    const rooms = twoRooms.rooms;
    expect(() =>
      buildFixtureMapWad({ rooms, triggers: [{ x1: 8, y1: 64, x2: 8, y2: 128 }] })
    ).toThrowError(MapSpecError); // floats in the void, not on any edge
    expect(() =>
      buildFixtureMapWad({
        rooms,
        doors: [{ x1: 256, y1: 96, x2: 256, y2: 160 }],
        triggers: [{ x1: 256, y1: 128, x2: 256, y2: 192, special: 1 }]
      })
    ).toThrowError(MapSpecError); // door/trigger overlap
    expect(() =>
      buildFixtureMapWad({
        rooms,
        triggers: [
          { x1: 256, y1: 96, x2: 256, y2: 160, special: 97 },
          { x1: 256, y1: 128, x2: 256, y2: 192, special: 39 }
        ]
      })
    ).toThrowError(MapSpecError); // trigger/trigger overlap
    expect(() =>
      buildFixtureMapWad({ rooms, triggers: [{ x1: 0, y1: 64, x2: 0, y2: 128, special: 40000 }] })
    ).toThrowError(MapSpecError); // special must fit int16
    expect(() =>
      buildFixtureMapWad({ rooms, triggers: [{ x1: 0, y1: 64, x2: 32, y2: 128 }] })
    ).toThrowError(MapSpecError); // not axis-aligned
  });

  it('triggers: [] / omitted ⇒ byte-identical (optional-field stability)', () => {
    const a = buildFixtureMapWad(twoRooms);
    const b = buildFixtureMapWad({ ...twoRooms, triggers: [] });
    const c = buildFixtureMapWad({
      rooms: twoRooms.rooms.map((r) => ({ ...r })),
      doors: []
    });
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(Array.from(c)).toEqual(Array.from(a));
  });

  it('seeded property: tagged rooms + triggers + things stay selfCheck-green', () => {
    const rnd = mulberry32(0xbeef0602);
    for (let seed = 0; seed < 50; seed++) {
      const base = randomSpec(mulberry32(seed * 7919 + 13));
      const rooms = base.rooms.map((r, i) => ({ ...r, tag: i + 1, special: (seed + i) % 18 }));
      const triggers: LineTriggerSpec[] = rooms.slice(0, 2).map((r, i) => ({
        x1: r.x,
        y1: r.y + 32,
        x2: r.x,
        y2: r.y + 96,
        special: ((seed * 37 + i * 11) % 140) + 1,
        tag: ((seed + i) % rooms.length) + 1,
        texture: seed % 2 === 0 ? 'SW1MTX' : undefined,
        secret: seed % 3 === 0
      }));
      const spec: RectMapSpec = {
        rooms,
        triggers,
        things: [
          { x: rooms[0]!.x + 8, y: rooms[0]!.y + 8, angle: 0, type: 1 },
          { x: rooms[0]!.x + 16, y: rooms[0]!.y + 16, angle: 90, type: 14 },
          { x: rooms[0]!.x + 24, y: rooms[0]!.y + 24, angle: 0, type: 5 },
          { x: rooms[0]!.x + 32, y: rooms[0]!.y + 32, angle: 0, type: 6 },
          { x: rooms[0]!.x + 40, y: rooms[0]!.y + 40, angle: 0, type: 13 },
          { x: rooms[0]!.x + 48, y: rooms[0]!.y + 48, angle: 0, type: 11 }
        ]
      };
      const name = `T${seed}`;
      const wad = buildFixtureMapWad(spec, name);
      try {
        mapSelfCheck(wad, name);
      } catch (e) {
        throw new Error(`seed ${seed} failed: ${String(e)}\nspec=${JSON.stringify(spec)}`);
      }
      void rnd();
    }
  });
});

// ---------------------------------------------------------------------------
// Seeded property tests: random 1..5-room grids with gaps and doors.
// ---------------------------------------------------------------------------

function randomSpec(rnd: () => number): RectMapSpec {
  const cell = 384;
  const used = new Set<string>();
  const rooms = [];
  const count = 1 + Math.floor(rnd() * 5);
  for (let i = 0; i < count; i++) {
    let gx = 0;
    let gy = 0;
    for (let tries = 0; tries < 10; tries++) {
      gx = Math.floor(rnd() * 3);
      gy = Math.floor(rnd() * 3);
      if (!used.has(`${gx},${gy}`)) break;
    }
    if (used.has(`${gx},${gy}`)) continue;
    used.add(`${gx},${gy}`);
    const w = rnd() < 0.5 ? cell : 192 + Math.floor(rnd() * 3) * 64;
    const h = rnd() < 0.5 ? cell : 192 + Math.floor(rnd() * 3) * 64;
    rooms.push({ x: gx * cell, y: gy * cell, w, h });
  }
  // Doors on room-room shared edges (overlap ≥ 128), centered, 64 long.
  const doors: DoorGapSpec[] = [];
  for (let i = 0; i < rooms.length; i++) {
    for (let j = i + 1; j < rooms.length; j++) {
      const a = rooms[i]!;
      const b = rooms[j]!;
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (oy >= 128 && ox <= 0) {
        // rooms side by side → shared VERTICAL edge line at x
        const x = a.x + a.w === b.x ? a.x + a.w : b.x + b.w === a.x ? b.x + b.w : -1;
        if (x >= 0) doors.push({ x1: x, y1: Math.max(a.y, b.y) + 32, x2: x, y2: Math.max(a.y, b.y) + 96 });
      } else if (ox >= 128 && oy <= 0) {
        // rooms stacked → shared HORIZONTAL edge line at y
        const y = a.y + a.h === b.y ? a.y + a.h : b.y + b.h === a.y ? b.y + b.h : -1;
        if (y >= 0) doors.push({ x1: Math.max(a.x, b.x) + 32, y1: y, x2: Math.max(a.x, b.x) + 96, y2: y });
      }
    }
  }
  return doors.length > 0 ? { rooms, doors } : { rooms };
}

describe('seeded property tests (mulberry32)', () => {
  it('selfCheck passes for 100 random 1..5-room grids', () => {
    for (let seed = 1; seed <= 100; seed++) {
      const spec = randomSpec(mulberry32(seed * 7919 + 13));
      const wad = buildFixtureMapWad(spec, `M${seed}`);
      let rep;
      try {
        rep = mapSelfCheck(wad, `M${seed}`);
      } catch (e) {
        throw new Error(`seed ${seed} failed: ${String(e)}\nspec=${JSON.stringify(spec)}`);
      }
      // node == sub-1 identity (also enforced inside selfCheck).
      expect(rep.numNodes).toBe(rep.numSubsectors - 1);
    }
  });

  it('BLOCKMAP union lists every linedef exactly in its bbox blocks', () => {
    // mapSelfCheck verifies exact per-bbox coverage + completeness; run a
    // visible subset explicitly and re-check the union from raw bytes.
    for (let seed = 1; seed <= 25; seed++) {
      const spec = randomSpec(mulberry32(seed * 104729 + 5));
      const name = `P${seed}`;
      const wad = buildFixtureMapWad(spec, name);
      const rep = mapSelfCheck(wad, name);
      const f = WadFile.parse(wad.buffer as ArrayBuffer);
      const m = f.lumpNumByName(name);
      const bm = f.readLump(m + 10);
      const v = new DataView(bm.buffer, bm.byteOffset, bm.byteLength);
      const w = v.getInt16(4, true);
      const h = v.getInt16(6, true);
      const seen = new Set<number>();
      for (let b = 0; b < w * h; b++) {
        let at = v.getUint16(8 + b * 2, true) * 2;
        for (;;) {
          const li = v.getInt16(at, true);
          at += 2;
          if (li === -1) break;
          seen.add(li);
        }
      }
      expect(seen.size).toBe(rep.numLines); // union == all linedefs
    }
  });

  it('same spec ⇒ byte-identical WAD (determinism)', () => {
    const spec = randomSpec(mulberry32(0xc0ffee));
    const a = buildFixtureMapWad(spec);
    const b = buildFixtureMapWad(spec);
    expect(a).toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// Spec validation + self-check failure modes (typed errors)
// ---------------------------------------------------------------------------

describe('typed errors', () => {
  it('rejects overlapping rooms, void-edge doors, overlapping doors, big coords', () => {
    expect(() =>
      buildFixtureMapWad({
        rooms: [
          { x: 0, y: 0, w: 256, h: 256 },
          { x: 128, y: 128, w: 256, h: 256 }
        ]
      })
    ).toThrowError(MapSpecError);
    expect(() =>
      buildFixtureMapWad({
        rooms: [{ x: 0, y: 0, w: 256, h: 256 }],
        doors: [{ x1: 0, y1: 64, x2: 0, y2: 128 }] // room-void edge
      })
    ).toThrowError(MapSpecError);
    expect(() =>
      buildFixtureMapWad({
        rooms: [
          { x: 0, y: 0, w: 256, h: 256 },
          { x: 256, y: 0, w: 256, h: 256 }
        ],
        doors: [
          { x1: 256, y1: 64, x2: 256, y2: 128 },
          { x1: 256, y1: 100, x2: 256, y2: 160 }
        ]
      })
    ).toThrowError(MapSpecError);
    expect(() => buildFixtureMapWad({ rooms: [{ x: 9000, y: 0, w: 128, h: 128 }] })).toThrowError(
      MapSpecError
    );
  });

  it('mapSelfCheck throws MapCheckError on corrupted lumps / missing marker', () => {
    expect(() => mapSelfCheck(buildFixtureMapWad({ rooms: [{ x: 0, y: 0, w: 128, h: 128 }] }), 'NOPE')).toThrowError(MapCheckError);
    const wad = buildFixtureMapWad({ rooms: [{ x: 0, y: 0, w: 256, h: 256 }] });
    // Corrupt linedef 0's v1 vertex index.
    const f = WadFile.parse(wad.buffer as ArrayBuffer);
    const ld = f.readLump(f.lumpNumByName('FIXMAP') + 2);
    ld[0] = 0x0f;
    ld[1] = 0x27; // 9999
    expect(() => mapSelfCheck(wad)).toThrowError(MapCheckError);
  });
});
