/**
 * mapdata decoder tests (M2-03).
 *
 * Layer 1: handcrafted mini-WADs via tests/fixtures/wadWriter — every record
 * type gets a byte-exact known-bytes → expected-struct round trip, every
 * R01 §15 quirk (and the u16-vs-i16 questions of R01 §4-11) gets a dedicated
 * vector, and every malformed shape raises a typed MapDataError.
 * Layer 2: freedoom1.wad goldens (auto-skip when absent) — E1M1 counts,
 * blockmap header, reject size, bbox, sha256 of the decoded record arrays.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildWad } from '../../tests/fixtures/wadWriter';
import {
  blockmapInfo,
  loadMap,
  MapDataError,
  MAP_LUMP_NAMES,
  type MapNode,
  NF_SUBSECTOR,
  nodeRefIndex,
  nodeRefIsSubsector,
  RECORD_SIZE,
  rejectVisible,
  thingAt,
  thingCount,
} from './mapdata';
import { WadFile } from './wadfile';

/* ------------------------------------------------------------------ */
/* Byte-level record builders (handcrafted, byte-exact)                */
/* ------------------------------------------------------------------ */

type Fill = (view: DataView, offset: number) => void;

const s16 =
  (at: number, value: number): Fill =>
  (v, o) =>
    v.setInt16(o + at, value, true);
const u16 =
  (at: number, value: number): Fill =>
  (v, o) =>
    v.setUint16(o + at, value, true);
const str8 =
  (at: number, text: string): Fill =>
  (v, o) => {
    for (let i = 0; i < 8; i++) v.setUint8(o + at + i, i < text.length ? text.charCodeAt(i) : 0);
  };

function recs(recSize: number, fills: Fill[]): Uint8Array {
  const out = new Uint8Array(recSize * fills.length);
  const view = new DataView(out.buffer);
  fills.forEach((f, i) => f(view, i * recSize));
  return out;
}

/** THINGS 10 B: i16 x, y, angle, type, flags (R01 §4). */
const thing = (x: number, y: number, angle: number, type: number, flags: number): Fill => (v, o) => {
  s16(0, x)(v, o);
  s16(2, y)(v, o);
  s16(4, angle)(v, o);
  s16(6, type)(v, o);
  s16(8, flags)(v, o);
};

/** LINEDEFS 14 B (R01 §5). */
const line = (v1: number, v2: number, flags: number, special: number, tag: number, front: number, back: number): Fill => (v, o) => {
  s16(0, v1)(v, o);
  s16(2, v2)(v, o);
  u16(4, flags)(v, o);
  s16(6, special)(v, o);
  s16(8, tag)(v, o);
  s16(10, front)(v, o);
  s16(12, back)(v, o);
};

/** SIDEDEFS 30 B (R01 §6). */
const side = (offsetX: number, offsetY: number, top: string, mid: string, bottom: string, sector: number): Fill => (v, o) => {
  s16(0, offsetX)(v, o);
  s16(2, offsetY)(v, o);
  str8(4, top)(v, o);
  str8(12, mid)(v, o);
  str8(20, bottom)(v, o);
  s16(28, sector)(v, o);
};

const vertex = (x: number, y: number): Fill => (v, o) => {
  s16(0, x)(v, o);
  s16(2, y)(v, o);
};

/** SEGS 12 B: i16 v1, v2, u16 angle BAM, i16 line, side, offset (R01 §8). */
const seg = (v1: number, v2: number, angle: number, ldef: number, s: number, offset: number): Fill => (v, o) => {
  s16(0, v1)(v, o);
  s16(2, v2)(v, o);
  u16(4, angle)(v, o);
  s16(6, ldef)(v, o);
  s16(8, s)(v, o);
  s16(10, offset)(v, o);
};

const ssector = (numsegs: number, firstseg: number): Fill => (v, o) => {
  s16(0, numsegs)(v, o);
  s16(2, firstseg)(v, o);
};

/** NODES 28 B; child bboxes in DISK order [top,bottom,left,right] (§10 + empirical fixup). */
const node = (
  x: number,
  y: number,
  dx: number,
  dy: number,
  rightBox: [number, number, number, number],
  leftBox: [number, number, number, number],
  right: number,
  left: number,
): Fill => (v, o) => {
  s16(0, x)(v, o);
  s16(2, y)(v, o);
  s16(4, dx)(v, o);
  s16(6, dy)(v, o);
  rightBox.forEach((value, k) => s16(8 + k * 2, value)(v, o));
  leftBox.forEach((value, k) => s16(16 + k * 2, value)(v, o));
  u16(24, right)(v, o);
  u16(26, left)(v, o);
};

/** SECTORS 26 B (R01 §11). */
const sector = (floor: number, ceil: number, flat: string, ceilFlat: string, light: number, special: number, tag: number): Fill => (v, o) => {
  s16(0, floor)(v, o);
  s16(2, ceil)(v, o);
  str8(4, flat)(v, o);
  str8(12, ceilFlat)(v, o);
  s16(20, light)(v, o);
  s16(22, special)(v, o);
  s16(24, tag)(v, o);
};

/** BLOCKMAP (R01 §13): WORD-addressed offset table + −1-terminated lists. */
function buildBlockmap(originX: number, originY: number, width: number, height: number, lists: number[][]): Uint8Array {
  const cells = width * height;
  if (lists.length !== cells) throw new Error('one list per block');
  const total = 4 + cells + lists.reduce((n, l) => n + l.length + 1, 0);
  const out = new Uint8Array(total * 2);
  const v = new DataView(out.buffer);
  v.setInt16(0, originX, true);
  v.setInt16(2, originY, true);
  v.setInt16(4, width, true);
  v.setInt16(6, height, true);
  let w = 4 + cells;
  lists.forEach((list, i) => {
    v.setUint16(8 + i * 2, w, true); // u16 WORD offset from lump start
    for (const ref of list) {
      v.setInt16(w * 2, ref, true);
      w++;
    }
    v.setInt16(w * 2, -1, true); // i16 terminator
    w++;
  });
  return out;
}

/* ------------------------------------------------------------------ */
/* Mini-map WAD builder (a valid 128×128 square room)                  */
/* ------------------------------------------------------------------ */

interface MiniMap {
  things: Uint8Array;
  lindefs: Uint8Array;
  sidedefs: Uint8Array;
  vertexes: Uint8Array;
  segs: Uint8Array;
  ssectors: Uint8Array;
  nodes: Uint8Array;
  sectors: Uint8Array;
  reject: Uint8Array;
  blockmap: Uint8Array;
}

function miniLumps(): MiniMap {
  return {
    things: recs(10, [thing(0, 64, 90, 1, 3), thing(64, 64, 0, 2005, 1)]),
    lindefs: recs(14, [
      line(0, 1, 0, 0, 0, 0, -1),
      line(1, 2, 2, 1, 66, 1, -1),
      line(2, 3, 4, 2, 0, 2, -1),
      line(3, 0, 0, 0, 0, 3, -1),
    ]),
    sidedefs: recs(30, [
      side(-1, -2, 'STARTAN3', '-', '-', 0),
      side(0, 0, 'BIGDOOR1', '-', '-', 0),
      side(0, 0, 'STONE3', 'TR-1', 'ASK', 0),
      side(3, 4, '-', 'MID1', '-', 0),
    ]),
    vertexes: recs(4, [vertex(0, 0), vertex(128, 0), vertex(128, 128), vertex(0, 128)]),
    segs: recs(12, [
      seg(0, 1, 0, 0, 0, 0),
      seg(1, 2, 16384, 1, 0, 0),
      seg(2, 3, 32768, 2, 0, 0),
      seg(3, 0, 49152, 3, 0, 1),
    ]),
    ssectors: recs(4, [ssector(4, 0)]),
    nodes: new Uint8Array(0),
    sectors: recs(26, [sector(0, 128, 'FLOOR4_8', 'CEIL3_5', 192, 9, 66)]),
    reject: new Uint8Array([0]),
    blockmap: buildBlockmap(-128, -128, 1, 1, [[0, 1, 2, 3]]),
  };
}

function miniWad(overrides: Partial<MiniMap> = {}, marker = 'E1M1'): ArrayBuffer {
  const lumps = { ...miniLumps(), ...overrides };
  return buildWad([
    { name: marker, data: undefined },
    { name: 'THINGS', data: lumps.things },
    { name: 'LINEDEFS', data: lumps.lindefs },
    { name: 'SIDEDEFS', data: lumps.sidedefs },
    { name: 'VERTEXES', data: lumps.vertexes },
    { name: 'SEGS', data: lumps.segs },
    { name: 'SSECTORS', data: lumps.ssectors },
    { name: 'NODES', data: lumps.nodes },
    { name: 'SECTORS', data: lumps.sectors },
    { name: 'REJECT', data: lumps.reject },
    { name: 'BLOCKMAP', data: lumps.blockmap },
  ]);
}

function miniMap(overrides: Partial<MiniMap> = {}, marker = 'E1M1') {
  return loadMap(WadFile.parse(miniWad(overrides, marker)), marker);
}

/** 4 wall lines all fronting sidedef 0 (for single-sidedef overrides). */
const linesToSide0 = recs(14, [
  line(0, 1, 0, 0, 0, 0, -1),
  line(1, 2, 0, 0, 0, 0, -1),
  line(2, 3, 0, 0, 0, 0, -1),
  line(3, 0, 0, 0, 0, 0, -1),
]);

/* ------------------------------------------------------------------ */
/* Record round trips: known bytes → expected struct                   */
/* ------------------------------------------------------------------ */

describe('record round trips', () => {
  it('decodes all mini-map lumps into the §2.2 structs (spec → lumps → decode)', () => {
    const md = miniMap();
    expect(md.name).toBe('E1M1');
    expect([
      thingCount(md),
      md.lineDefs.length,
      md.sideDefs.length,
      md.vertices.length,
      md.segs.length,
      md.ssectors.length,
      md.nodes.length,
      md.sectors.length,
    ]).toEqual([2, 4, 4, 4, 4, 1, 0, 1]);
    expect(thingAt(md, 0)).toEqual({ x: 0, y: 64, angle: 90, type: 1, flags: 3 });
    expect(thingAt(md, 1)).toEqual({ x: 64, y: 64, angle: 0, type: 2005, flags: 1 });
    expect(md.vertices[0]).toEqual({ x: 0, y: 0 });
    expect(md.vertices[3]).toEqual({ x: 0, y: 128 });
    expect(md.lineDefs[1]).toEqual({ v1: 1, v2: 2, front: 1, back: -1, flags: 2, special: 1, tag: 66 });
    expect(md.sideDefs[0]).toEqual({
      sector: 0,
      toptexture: 'STARTAN3',
      midtexture: '-',
      bottomtexture: '-',
      offset: [-1, -2],
      light: 0,
    });
    expect(md.segs[2]).toEqual({ v1: 2, v2: 3, angle: 32768, line: 2, side: 0, offset: 0 });
    expect(md.ssectors[0]).toEqual({ numsegs: 4, firstseg: 0 });
    expect(md.sectors[0]).toEqual({
      floorLh: 0,
      ceilingLh: 128,
      floorFlat: 'FLOOR4_8',
      ceilingFlat: 'CEIL3_5',
      lightLevel: 192,
      special: 9,
      tag: 66,
    });
    // spec round trip: counts, lights, specials, tags all match the input
    expect(md.sectors.map((s) => [s.lightLevel, s.special, s.tag])).toEqual([[192, 9, 66]]);
    expect(md.reject).toEqual(new Uint8Array([0]));
    expect(md.things).toBeInstanceOf(Uint8Array); // raw records per contract
    expect(md.blockmap).toBeInstanceOf(Uint8Array);
  });

  it('THINGS are raw 10 B records; thingAt bounds-checked', () => {
    const md = miniMap();
    expect(md.things.byteLength).toBe(20);
    expect([md.things[0], md.things[1], md.things[2], md.things[3]]).toEqual([0x00, 0x00, 0x40, 0x00]); // (0,64) LE
    expect(() => thingAt(md, 2)).toThrow(MapDataError);
    expect(() => thingAt(md, -1)).toThrow(MapDataError);
  });

  it('record sizes 10/14/30/4/12/4/28/26 B + ML_* lump order (R01 §3-11)', () => {
    expect(RECORD_SIZE).toEqual({ THINGS: 10, LINEDEFS: 14, SIDEDEFS: 30, VERTEXES: 4, SEGS: 12, SSECTORS: 4, NODES: 28, SECTORS: 26 });
    expect(MAP_LUMP_NAMES).toEqual(['THINGS', 'LINEDEFS', 'SIDEDEFS', 'VERTEXES', 'SEGS', 'SSECTORS', 'NODES', 'SECTORS', 'REJECT', 'BLOCKMAP']);
  });

  it('sidedef pins field offsets byte-for-byte', () => {
    const bytes = new Uint8Array(30);
    const v = new DataView(bytes.buffer);
    v.setInt16(0, -258, true); // textureoffset
    v.setInt16(2, 77, true); // rowoffset
    bytes.set([...'TOPTEX01'].map((c) => c.charCodeAt(0)), 4); // full 8, no NUL
    bytes.set([...'MID2'].map((c) => c.charCodeAt(0)), 12); // trailing NULs
    // bottomtexture bytes 20..27 stay 0x00 → empty name
    v.setInt16(28, 0, true);
    const md = miniMap({ sidedefs: bytes, lindefs: linesToSide0 });
    expect(md.sideDefs[0]).toEqual({
      sector: 0,
      toptexture: 'TOPTEX01',
      midtexture: 'MID2',
      bottomtexture: '',
      offset: [-258, 77],
      light: 0,
    });
  });
});

/* ------------------------------------------------------------------ */
/* R01 §15 quirk vectors                                               */
/* ------------------------------------------------------------------ */

describe('quirk vectors (R01 §15)', () => {
  it('Q1: data lumps resolve BY INDEX from the marker; later decoy names ignored', () => {
    const good = miniLumps();
    const buf = buildWad([
      { name: 'E1M1', data: undefined },
      { name: 'THINGS', data: good.things },
      { name: 'LINEDEFS', data: good.lindefs },
      { name: 'SIDEDEFS', data: good.sidedefs },
      { name: 'VERTEXES', data: good.vertexes },
      { name: 'SEGS', data: good.segs },
      { name: 'SSECTORS', data: good.ssectors },
      { name: 'NODES', data: good.nodes },
      { name: 'SECTORS', data: good.sectors },
      { name: 'REJECT', data: good.reject },
      { name: 'BLOCKMAP', data: good.blockmap },
      // LATER lumps redefining the same data names (vanilla last-name-wins
      // lookup would find THESE): by-index resolution must ignore them.
      { name: 'S_START', data: undefined },
      { name: 'THINGS', data: recs(10, [thing(9999, 9999, 9999, 9999, 1)]) },
      { name: 'S_END', data: undefined },
    ]);
    const w = WadFile.parse(buf);
    expect(w.lumpNumByName('THINGS')).toBe(12); // proof the decoy WINS by name
    expect(thingAt(loadMap(w, 'E1M1'), 0)).toEqual({ x: 0, y: 64, angle: 90, type: 1, flags: 3 });
  });

  it('Q1b: both marker patterns E1M1/MAP01 work (R01 §17); last marker wins', () => {
    const md = miniMap({}, 'MAP01');
    expect(md.name).toBe('MAP01');
    expect(md.lineDefs.length).toBe(4);
    const lumps = miniLumps();
    const second = { ...lumps, things: recs(10, [thing(1, 2, 45, 1, 1)]) };
    const order = Object.keys(lumps) as (keyof MiniMap)[];
    const asLumps = (m: MiniMap) => order.map((k, i) => ({ name: MAP_LUMP_NAMES[i]!, data: m[k] }));
    const buf = buildWad([
      { name: 'E1M1', data: undefined },
      ...asLumps(lumps),
      { name: 'E1M1', data: undefined },
      ...asLumps(second),
    ]);
    const w = WadFile.parse(buf);
    expect(loadMap(w, 'E1M1').name).toBe('E1M1');
    expect(thingAt(loadMap(w, 'E1M1'), 0)).toEqual({ x: 1, y: 2, angle: 45, type: 1, flags: 1 });
  });

  it('Q2: marker lookup case-insensitive incl. raw lowercase dir bytes (R01 §15.2)', () => {
    const bytes = new Uint8Array(miniWad());
    const dv = new DataView(bytes.buffer);
    const dir = dv.getInt32(8, true);
    for (let i = 0; i < 4; i++) bytes[dir + 8 + i] = 'e1m1'.charCodeAt(i)!;
    const wad = WadFile.parse(bytes.buffer as ArrayBuffer);
    expect(loadMap(wad, 'E1M1').name).toBe('E1M1');
    expect(loadMap(wad, 'e1m1').name).toBe('E1M1');
  });

  it('Q3: sidenum[1] 0xFFFF decodes to −1, never 65535 (R01 §15.3)', () => {
    const md = miniMap();
    expect(md.lineDefs.map((l) => l.back)).toEqual([-1, -1, -1, -1]);
  });

  it('Q3b: seg linedef 0xFFFF is a −1 miniseg, not 65535', () => {
    const md = miniMap({
      segs: recs(12, [seg(0, 1, 0, 0xffff, 0, 0), seg(1, 0, 32768, 0, 1, 5)]),
      ssectors: recs(4, [ssector(2, 0)]),
    });
    expect(md.segs[0]!.line).toBe(-1);
    expect(md.segs[1]).toEqual({ v1: 1, v2: 0, angle: 32768, line: 0, side: 1, offset: 5 });
  });

  it('Q4: BLOCKMAP offsets are WORD offsets from the lump start (R01 §15.4)', () => {
    // Hand-built 2×1 grid: table words 4..5, block 0 list at WORD 6 (byte 12),
    // block 1 at WORD 10 (byte 20) — a bytes-vs-words mix-up would mis-locate.
    const raw = new Uint8Array(24);
    const v = new DataView(raw.buffer);
    v.setInt16(0, 0, true);
    v.setInt16(2, 0, true);
    v.setInt16(4, 2, true);
    v.setInt16(6, 1, true);
    v.setUint16(8, 6, true);
    v.setUint16(10, 10, true);
    v.setInt16(12, 3, true);
    v.setInt16(14, -1, true);
    v.setInt16(20, 2, true);
    v.setInt16(22, -1, true);
    const md = miniMap({ blockmap: raw });
    const info = blockmapInfo(md);
    expect([info.originX, info.originY, info.width, info.height]).toEqual([0, 0, 2, 1]);
    expect(info.view.getUint16(8, true)).toBe(6);
    expect(info.view.getUint16(10, true)).toBe(10);
    expect([info.words[6], info.words[10]]).toEqual([3, 2]);
    // standard builder too: lists −1-terminated, offsets ≥ 4+cells
    const bm = buildBlockmap(-128, -128, 2, 2, [[0], [1, 2], [], [3]]);
    expect(() => miniMap({ blockmap: bm })).not.toThrow();
  });

  it('Q5: REJECT is LINEAR s1·n + s2 bits; short/oversize reads clamp visible (R01 §12)', () => {
    const two = recs(26, [sector(0, 64, 'A', 'B', 0, 0, 0), sector(0, 64, 'A', 'B', 0, 0, 0)]);
    const md2 = miniMap({ sectors: two, reject: new Uint8Array([0b0000_0010]) });
    expect([rejectVisible(md2, 0, 0), rejectVisible(md2, 0, 1), rejectVisible(md2, 1, 0), rejectVisible(md2, 1, 1)]).toEqual([true, false, true, true]);
    // n=3: bit(2,2) sits at pnum 8 — byte 1. A ROW-padded layout would put it
    // in byte 2 (absent → visible), so invisibility here pins LINEAR packing.
    const three = recs(26, [sector(0, 1, 'A', 'B', 0, 0, 0), sector(0, 1, 'A', 'B', 0, 0, 0), sector(0, 1, 'A', 'B', 0, 0, 0)]);
    const md3 = miniMap({ sectors: three, reject: new Uint8Array([0b0010_0000, 0b0000_0001]) });
    expect(rejectVisible(md3, 1, 2)).toBe(false); // pnum 5
    expect(rejectVisible(md3, 2, 1)).toBe(true); //  pnum 7 — bit 7 clear
    expect(rejectVisible(md3, 2, 2)).toBe(false); // pnum 8 → byte 1 bit 0
    expect(rejectVisible(md3, 0, 2)).toBe(true);
    const mdShort = miniMap({ sectors: three, reject: new Uint8Array([0, 0]) }); // < ceil(9/8)…2 bytes fine, bit absent
    expect(rejectVisible(mdShort, 2, 2)).toBe(true);
    const mdEmpty = miniMap({ sectors: three, reject: new Uint8Array(0) });
    expect(rejectVisible(mdEmpty, 2, 2)).toBe(true); // clamp = visible
    expect(rejectVisible(md3, 9, 0)).toBe(true); // out-of-range sector = visible
    expect(rejectVisible(md3, -1, 0)).toBe(true);
  });

  it('seg angle is u16 BAM: 64442 stays 64442, not −11094 (R01 §8)', () => {
    const md = miniMap({
      segs: recs(12, [seg(0, 1, 64442, 0, 0, 0), seg(1, 0, 65535, 0, 1, 0)]),
      ssectors: recs(4, [ssector(2, 0)]),
    });
    expect(md.segs[0]!.angle).toBe(64442);
    expect(md.segs[1]!.angle).toBe(65535);
  });

  it('NODES child refs keep raw u16; 0x8000 splits subsector vs node (R01 §10)', () => {
    const md = miniMap({
      nodes: recs(28, [node(368, 1296, 0, -32, [1472, 1264, 256, 368], [1472, 1296, 368, 448], NF_SUBSECTOR | 1, NF_SUBSECTOR | 2)]),
      ssectors: recs(4, [ssector(1, 0), ssector(1, 1), ssector(1, 2)]),
    });
    const n = md.nodes[0] as MapNode;
    expect(n.right).toBe(32769);
    expect(nodeRefIsSubsector(n.right)).toBe(true);
    expect(nodeRefIndex(n.right)).toBe(1);
    expect([nodeRefIsSubsector(41), nodeRefIndex(41)]).toEqual([false, 41]);
    expect([n.splitx, n.splity, n.dx, n.dy]).toEqual([368, 1296, 0, -32]);
  });

  it('NODES child bbox disk order is top,bottom,left,right (empirical; R01 §10 field order is wrong)', () => {
    const md = miniMap({
      nodes: recs(28, [node(0, 0, 64, 0, [300, 100, 20, 50], [-10, -40, -70, -20], NF_SUBSECTOR, NF_SUBSECTOR | 1)]),
      ssectors: recs(4, [ssector(1, 0), ssector(1, 1)]),
    });
    const n = md.nodes[0] as MapNode;
    expect(n.bbox).toEqual({ left: 20, bottom: 100, right: 50, top: 300 });
    expect(n.rightBBox).toBe(n.bbox); // contract bbox = right child
    expect(n.leftBBox).toEqual({ left: -70, bottom: -40, right: -20, top: -10 });
  });

  it('THINGS angle/flags read SIGNED — mapthing_t is 5×i16 (R01 §4)', () => {
    // 0xE100 raw: u16 would say 57600, i16 says −7936. Vanilla SHORT() = i16.
    const md = miniMap({ things: recs(10, [thing(5, -5, 0xe100, 3004, 0xffff)]) });
    expect(thingAt(md, 0)).toEqual({ x: 5, y: -5, angle: -7936, type: 3004, flags: -1 });
    // Observed E1M1 range (0…315) makes both readings identical in practice.
  });

  it('SIDEDEF offsets are int16; SideDef.light is unused 0 (§2.2, R01 §6)', () => {
    const md = miniMap({ sidedefs: recs(30, [side(-34, 32767, 'A', '', '', 0)]), lindefs: linesToSide0 });
    expect(md.sideDefs[0]!.offset).toEqual([-34, 32767]);
    expect(md.sideDefs[0]!.light).toBe(0);
  });

  it('LINEDEF flags are u16 bitfields; special/tag int16 (R01 §5)', () => {
    const md = miniMap({
      lindefs: recs(14, [line(0, 1, 0xffff, -255, 32767, 0, -1)]),
      // keep every other lump consistent with a ONE-line map:
      segs: recs(12, [seg(0, 1, 0, 0, 0, 0), seg(1, 2, 0, 0, 0, 1), seg(2, 3, 0, 0, 0, 0), seg(3, 0, 0, 0, 0, 1)]),
      blockmap: buildBlockmap(-128, -128, 1, 1, [[0]]),
    });
    expect(md.lineDefs[0]).toEqual({ v1: 0, v2: 1, front: 0, back: -1, flags: 65535, special: -255, tag: 32767 });
  });

  it('SECTORS light/special/tag are int16 (R01 §11); flats trimmed + uppercased', () => {
    const md = miniMap({ sectors: recs(26, [sector(-32768, 32767, 'flat5 ', 'F_SKY1', 255, -1, 32767)]) });
    expect(md.sectors[0]).toEqual({
      floorLh: -32768,
      ceilingLh: 32767,
      floorFlat: 'FLAT5',
      ceilingFlat: 'F_SKY1',
      lightLevel: 255,
      special: -1,
      tag: 32767,
    });
  });

  it('SSECTORS are i16 numsegs/firstseg; empty subsectors allowed (R01 §9)', () => {
    const md = miniMap({
      ssectors: recs(4, [ssector(0, 0), ssector(2, 2)]),
    });
    expect(md.ssectors).toEqual([{ numsegs: 0, firstseg: 0 }, { numsegs: 2, firstseg: 2 }]);
  });

  it('getUint16 is never used on −1-capable fields (acceptance grep rule)', () => {
    const src = readFileSync(fileURLToPath(new URL('./mapdata.ts', import.meta.url)), 'utf8');
    const allowed = /\bflags\b|\bangle\b|\bright\b|\bleft\b|\(4 \+ b\) \* 2\b/;
    const offenders = src
      .split('\n')
      .filter((l) => l.includes('getUint16') && !l.trim().startsWith('*') && !allowed.test(l));
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Malformed → typed errors                                            */
/* ------------------------------------------------------------------ */

describe('malformed maps raise MapDataError', () => {
  it('missing marker', () => {
    expect(() => loadMap(WadFile.parse(buildWad([])), 'E1M1')).toThrow(MapDataError);
    expect(() => loadMap(WadFile.parse(buildWad([])), 'E1M1')).toThrow(/marker lump not found/);
  });

  it('partial trailing records', () => {
    expect(() => miniMap({ things: new Uint8Array(21) })).toThrow(/THINGS size 21 not a multiple of 10/);
    expect(() => miniMap({ lindefs: new Uint8Array(15) })).toThrow(/LINEDEFS size 15 not a multiple of 14/);
  });

  it('map lumps running past the directory end', () => {
    const buf = buildWad([{ name: 'E1M1', data: undefined }, { name: 'THINGS', data: miniLumps().things }]);
    expect(() => loadMap(WadFile.parse(buf), 'E1M1')).toThrow(/LINEDEFS' missing/);
  });

  it('out-of-range cross references: vertex / sidedef / sector / seg', () => {
    expect(() => miniMap({ lindefs: recs(14, [line(4, 0, 0, 0, 0, 0, -1)]) })).toThrow(/LINEDEFS\[0]\.v1 4 out of range/);
    expect(() => miniMap({ lindefs: recs(14, [line(0, -2, 0, 0, 0, 0, -1)]) })).toThrow(/v2 -2 out of range/);
    expect(() => miniMap({ lindefs: recs(14, [line(0, 1, 0, 0, 0, 4, -1)]) })).toThrow(/sidenum\[0] 4 out of range/);
    expect(() => miniMap({ lindefs: recs(14, [line(0, 1, 0, 0, 0, 0, 9)]) })).toThrow(/sidenum\[1] 9 neither -1/);
    expect(() => miniMap({ lindefs: recs(14, [line(0, 1, 0, 0, 0, 0, -2)]) })).toThrow(/sidenum\[1] -2 neither -1/);
    expect(() => miniMap({ sidedefs: recs(30, [side(0, 0, '-', '-', '-', 1)]) })).toThrow(/SIDEDEFS\[0]\.sector 1 out of range/);
    expect(() => miniMap({ segs: recs(12, [seg(0, 9, 0, 0, 0, 0)]) })).toThrow(/SEGS\[0]\.v2 9 out of range/);
    expect(() => miniMap({ segs: recs(12, [seg(0, 1, 0, 4, 0, 0)]), ssectors: recs(4, [ssector(1, 0)]) })).toThrow(/SEGS\[0]\.linedef 4 neither/);
    expect(() => miniMap({ segs: recs(12, [seg(0, 1, 0, -2, 0, 0)]), ssectors: recs(4, [ssector(1, 0)]) })).toThrow(/linedef -2 neither/);
  });

  it('ssector ranges and node child refs', () => {
    expect(() => miniMap({ ssectors: recs(4, [ssector(5, 0)]) })).toThrow(/past 4 segs/);
    expect(() => miniMap({ ssectors: recs(4, [ssector(4, 1)]) })).toThrow(/past 4 segs/);
    const lumps = miniLumps();
    lumps.nodes = recs(28, [node(0, 0, 1, 0, [1, 0, 0, 1], [1, 0, 0, 1], 7, 0)]);
    expect(() => miniMap(lumps)).toThrow(/NODES\[0] child ref 7 out of range \[0, 1\)/);
    lumps.nodes = recs(28, [node(0, 0, 1, 0, [1, 0, 0, 1], [1, 0, 0, 1], NF_SUBSECTOR | 9, 0)]);
    expect(() => miniMap(lumps)).toThrow(/subsector ref \d+ & 0x7fff out of range \[0, 1\)/);
    lumps.nodes = recs(28, [node(0, 0, 1, 0, [1, 0, 0, 1], [1, 0, 0, 1], 0, NF_SUBSECTOR)]);
    expect(() => miniMap(lumps)).not.toThrow();
  });

  it('blockmap: short header, bad dims, bogus offsets, unterminated/bad lists', () => {
    expect(() => miniMap({ blockmap: new Uint8Array(10) })).toThrow(/too small/);
    const zeroDims = buildBlockmap(0, 0, 1, 1, [[]]);
    new DataView(zeroDims.buffer).setInt16(4, 0, true); // width := 0
    expect(() => miniMap({ blockmap: zeroDims })).toThrow(/bad grid dims/);
    // offset pointing back into the offset table
    const backRef = buildBlockmap(0, 0, 1, 1, [[]]);
    new DataView(backRef.buffer).setUint16(8, 2, true); // offset := word 2 (< 5)
    expect(() => miniMap({ blockmap: backRef })).toThrow(/outside the line section/);
    // offset past the lump end
    const farRef = buildBlockmap(0, 0, 1, 1, [[]]);
    new DataView(farRef.buffer).setUint16(8, 4000, true);
    expect(() => miniMap({ blockmap: farRef })).toThrow(/outside the line section/);
    // list without a −1 terminator running past the end
    const unterminated = new Uint8Array(12);
    const uv = new DataView(unterminated.buffer);
    uv.setInt16(4, 1, true);
    uv.setInt16(6, 1, true);
    uv.setUint16(8, 5, true);
    uv.setInt16(10, 0, true); // last word: line 0, not −1 → next step past EOF
    expect(() => miniMap({ blockmap: unterminated })).toThrow(/past the lump end/);
    // terminated but referencing line 99 (only 4 lines exist)
    expect(() => miniMap({ blockmap: buildBlockmap(0, 0, 1, 1, [[99]]) })).toThrow(/references line 99 out of range/);
    expect(() => blockmapInfo(new Uint8Array(8))).toThrow(MapDataError);
  });
});

/* ------------------------------------------------------------------ */
/* freedoom1.wad goldens (auto-skip when absent)                       */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad E1M1 goldens', () => {
  let cached: WadFile | undefined;
  function wad(): WadFile {
    cached ??= WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer);
    return cached;
  }

  // Recorded 2026-07 from wads/freedoom1.wad (v0.13.0, sha256 7323bcc1…703d,
  // pinned in scripts/freedoom/release.json). Counts match R01 §3 exactly;
  // serializations are Int32Array field tuples per record, little-endian.
  const SHA = {
    things: 'aba298a7ee10d4964053c382540641efc6e2dd7331d1fff19ab67ffbe142669b', // x,y,angle,type,flags
    lineDefs: 'bdd57c0758027f252c7f4ea647f4de36b728022746257e4c22e322b3f41811dc', // v1,v2,front,back,flags,special,tag
    sideDefs: '1ebd539b8cbed03cd257ac65fbec902956498c4a2217f9d96abdc06bd6624049', // offsetX,offsetY,sector
    vertices: 'd14ca0678f7b32ddc3da3aa1b6a0c21e274c6f79b589fd599373a8dbcc3d5a06', // x,y
    segs: '9bb8f297aaa440a165a7ee77992efc11a41c474cba6771a7db13a776543d4883', // v1,v2,angle,line,side,offset
    ssectors: 'bfad46debf3b245e199a606add7e09a5bdcf16b073ab030adf2a690204a3fef8', // numsegs,firstseg
    nodes: '390b2838799490dc190e7d3cadd911dabb09d5384af2a31c6b971b6c5c08ae83', // x,y,dx,dy,rb(l,b,r,t),lb(l,b,r,t),right,left
    sectors: 'b7dd08da8d9a9ebb081d2259950311656bed0c2c3df00eb57e721fbde3da6794', // floor,ceil,light,special,tag
  };
  const sha = (nums: number[]): string =>
    createHash('sha256').update(Buffer.from(Int32Array.from(nums).buffer)).digest('hex');

  it('decodes all lumps with the R01 §3 counts and record-array shas', () => {
    const md = loadMap(wad(), 'E1M1');
    expect([
      thingCount(md),
      md.lineDefs.length,
      md.sideDefs.length,
      md.vertices.length,
      md.segs.length,
      md.ssectors.length,
      md.nodes.length,
      md.sectors.length,
    ]).toEqual([292, 1175, 1829, 1196, 2057, 682, 681, 182]);
    expect(sha(Array.from({ length: thingCount(md) }, (_, i) => { const t = thingAt(md, i); return [t.x, t.y, t.angle, t.type, t.flags]; }).flat())).toBe(SHA.things);
    expect(sha(md.lineDefs.flatMap((l) => [l.v1, l.v2, l.front, l.back, l.flags, l.special, l.tag]))).toBe(SHA.lineDefs);
    expect(sha(md.sideDefs.flatMap((s) => [...s.offset, s.sector]))).toBe(SHA.sideDefs);
    expect(sha(md.vertices.flatMap((v) => [v.x, v.y]))).toBe(SHA.vertices);
    expect(sha(md.segs.flatMap((s) => [s.v1, s.v2, s.angle, s.line, s.side, s.offset]))).toBe(SHA.segs);
    expect(sha(md.ssectors.flatMap((s) => [s.numsegs, s.firstseg]))).toBe(SHA.ssectors);
    expect(sha(md.nodes.flatMap((nn) => { const n = nn as MapNode; return [n.splitx, n.splity, n.dx, n.dy, n.rightBBox.left, n.rightBBox.bottom, n.rightBBox.right, n.rightBBox.top, n.leftBBox.left, n.leftBBox.bottom, n.leftBBox.right, n.leftBBox.top, n.right, n.left]; }))).toBe(SHA.nodes);
    expect(sha(md.sectors.flatMap((s) => [s.floorLh, s.ceilingLh, s.lightLevel, s.special, s.tag]))).toBe(SHA.sectors);
  });

  it('map bbox = VERTEXES min/max (nodes[0] boxes are content-tight, recorded)', () => {
    const md = loadMap(wad(), 'E1M1');
    let left = Infinity, bottom = Infinity, right = -Infinity, top = -Infinity;
    for (const v of md.vertices) {
      left = Math.min(left, v.x);
      bottom = Math.min(bottom, v.y);
      right = Math.max(right, v.x);
      top = Math.max(top, v.y);
    }
    expect([left, bottom, right, top]).toEqual([-704, -1064, 3248, 2336]);
    const n0 = md.nodes[0] as MapNode;
    expect([n0.splitx, n0.splity, n0.dx, n0.dy, n0.right, n0.left]).toEqual([368, 1296, 0, -32, 0x8001, 0x8002]); // R01 §10
    expect(n0.rightBBox).toEqual({ left: 256, bottom: 1264, right: 368, top: 1472 });
    expect(n0.leftBBox).toEqual({ left: 368, bottom: 1296, right: 448, top: 1472 });
  });

  it('blockmap origin (−712,−1072), 32×27, every list −1-terminated', () => {
    const md = loadMap(wad(), 'E1M1'); // loadMap itself throws on any bad list
    const bm = blockmapInfo(md);
    expect([bm.originX, bm.originY, bm.width, bm.height]).toEqual([-712, -1072, 32, 27]);
    expect(md.blockmap.byteLength).toBe(7528); // 3764 words = 4 hdr + 864 table + 2900 lists
    let terminated = 0;
    for (let b = 0; b < bm.width * bm.height; b++) {
      const start = bm.view.getUint16((4 + b) * 2, true);
      expect(start).toBeGreaterThanOrEqual(4 + bm.width * bm.height); // no padding gap (R01 §13)
      let w = start;
      while (bm.words[w] !== -1) w++;
      terminated++;
    }
    expect(terminated).toBe(864);
  });

  it('reject = ceil(182²/8) = 4141 bytes, pinned visibility bits', () => {
    const md = loadMap(wad(), 'E1M1');
    expect(md.reject.byteLength).toBe(4141);
    expect(rejectVisible(md, 0, 0)).toBe(true);
    expect(rejectVisible(md, 0, 1)).toBe(true);
    expect(rejectVisible(md, 3, 17)).toBe(false); // linear pnum 3·182+17 = 563
    expect(rejectVisible(md, 0, 181)).toBe(true);
    expect(rejectVisible(md, 181, 0)).toBe(true);
  });

  it('spot checks: 521 one-sided, 654 ML_TWOSIDED, 0 minisegs, struct samples', () => {
    const md = loadMap(wad(), 'E1M1');
    expect(md.lineDefs.filter((l) => l.back === -1).length).toBe(521); // R01 §5
    expect(md.lineDefs.filter((l) => (l.flags & 0x004) !== 0).length).toBe(654);
    expect(md.segs.filter((s) => s.line === -1).length).toBe(0); // R01 §8: freedoom has none
    expect(md.segs.some((s) => s.angle > 32767)).toBe(true); // u16 BAM up to 64442
    expect(md.ssectors[0]).toEqual({ numsegs: 3, firstseg: 0 }); // R01 §9 (3,0),(3,3),(3,6)…
    expect(md.ssectors[1]).toEqual({ numsegs: 3, firstseg: 3 });
    expect(thingAt(md, 0)).toEqual({ x: 1712, y: 1088, angle: 270, type: 2015, flags: 1 });
    expect(md.sectors[0]).toEqual({
      floorLh: -160,
      ceilingLh: 376,
      floorFlat: 'RROCK18',
      ceilingFlat: 'CEIL5_1',
      lightLevel: 202,
      special: 0,
      tag: 0,
    });
    expect(md.sideDefs.some((s) => s.sector === 181)).toBe(true); // R01 §6 max sector ref
  });

  it('all 36 E1M1..E4M9 maps decode without error (R01 §3)', () => {
    const w = wad();
    let decoded = 0;
    for (const ep of [1, 2, 3, 4]) {
      for (const m of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        loadMap(w, `E${ep}M${m}`);
        decoded++;
      }
    }
    expect(decoded).toBe(36);
  });
});
