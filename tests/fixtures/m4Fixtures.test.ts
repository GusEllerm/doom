/**
 * M4-06 — Fixture extension tests: sky, flats, fences, things, panning
 * (docs/design/M4-plan.md §M4-06).
 *
 * Gates:
 *  1. every new map (combined + per-scene WADs) passes mapSelfCheck;
 *  2. committed shas: FLATFIX flats + MASKFIX/SKY composed rasters;
 *  3. thing coordinate/angle/type round-trip (raw THINGS decode);
 *  4. ZERO drift vs the M2 compiler: buildM4MapLumps(WALLFIX_SPEC) is
 *     byte-identical to mapBuilder.buildMapLumps(WALLFIX_SPEC) — the proof
 *     the M3 WALLFIX goldens cannot move;
 *  5. data wiring readable by the renderer: loadRenderWorld resolves
 *     skyflatnum/skyTextureNum/sideMasked/sideOffsetX from these WADs.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { texturesFromWad } from '../../src/wad/texture';
import { WadFile } from '../../src/wad/wadfile';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';

import { buildMapLumps, mapSelfCheck, MapCheckError } from './mapBuilder';
import {
  buildM4FixturesWad,
  buildM4MapLumps,
  buildM4SceneWad,
  FLAT_CHECKER,
  FLAT_EDGETAG,
  FLAT_RAMP,
  FLATFIX_SHA256,
  MASKFIX_COMPOSED_SHA256,
  M4_MAP_NAMES,
  M4_SCENES,
  m4SelfCheck,
  rasterBytes,
  skyColumnDecode,
  skyColumnMarker,
  SKYFIX_COMPOSED_SHA256,
  SKY_TEX_HEIGHT,
  SKY_TEX_WIDTH,
  TEX_MASKED,
  TEX_SKY,
  THINGS_RING_CENTER,
  THINGSFIX_SPEC,
  THING_SHORT,
  THING_TALL,
  type M4Scene
} from './m4Fixtures';
import { WALLFIX_SPEC } from '../render/viewpoints';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const wadOf = (bytes: Uint8Array): WadFile => WadFile.parse(bytes.buffer as ArrayBuffer);
const scenes = Object.keys(M4_MAP_NAMES) as M4Scene[];

describe('M4-06 compiler parity with the M2 model (WALLFIX bytes)', () => {
  const a = buildMapLumps(WALLFIX_SPEC);
  const b = buildM4MapLumps(WALLFIX_SPEC);
  it('same lump set, same order', () => {
    expect(b.map((l) => l.name)).toEqual(a.map((l) => l.name));
  });
  it('every WALLFIX lump byte-identical (M3 goldens cannot move)', () => {
    a.forEach((lump, i) => {
      expect(b[i]!.data, `lump ${lump.name}`).toEqual(lump.data);
    });
  });
});

describe('M4-06 selfCheck round-trip', () => {
  it('all five maps pass mapSelfCheck in the combined WAD', () => {
    const bytes = buildM4FixturesWad();
    for (const s of scenes) {
      expect(() => mapSelfCheck(bytes, M4_MAP_NAMES[s]), s).not.toThrow();
    }
  });
  it('per-scene WADs selfCheck + m4SelfCheck helper agree on counts', () => {
    const combined = buildM4FixturesWad();
    const reports = m4SelfCheck();
    for (const s of scenes) {
      expect(() => mapSelfCheck(buildM4SceneWad(s), M4_MAP_NAMES[s]), s).not.toThrow();
      expect(reports[s].numLines, s).toBe(
        mapSelfCheck(combined, M4_MAP_NAMES[s]).numLines
      );
    }
  });
  it('selfCheck actually runs (bogus map name throws)', () => {
    expect(() => mapSelfCheck(buildM4FixturesWad(), 'NOPE1234')).toThrow(MapCheckError);
  });
  it('deterministic: two builds are byte-identical', () => {
    expect(sha(buildM4FixturesWad())).toBe(sha(buildM4FixturesWad()));
  });
});

describe('M4-06 FLATFIX flats + committed shas', () => {
  it('flat shas match the committed goldens', () => {
    const wad = wadOf(buildM4FixturesWad());
    expect(sha(wad.readLumpByName(FLAT_RAMP))).toBe(FLATFIX_SHA256[FLAT_RAMP]);
    expect(sha(wad.readLumpByName(FLAT_CHECKER))).toBe(FLATFIX_SHA256[FLAT_CHECKER]);
    expect(sha(wad.readLumpByName(FLAT_EDGETAG))).toBe(FLATFIX_SHA256[FLAT_EDGETAG]);
  });
  it('ramp is px = x; checker alternates 144/208 per 8px cell; edgetag corners NW=1 NE=2 SE=3 SW=4 (row 0 north)', () => {
    const wad = wadOf(buildM4FixturesWad());
    const ramp = wad.readLumpByName(FLAT_RAMP);
    const chk = wad.readLumpByName(FLAT_CHECKER);
    const edge = wad.readLumpByName(FLAT_EDGETAG);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        expect(ramp[y * 64 + x], `ramp ${x},${y}`).toBe(x);
        expect(chk[y * 64 + x], `chk ${x},${y}`).toBe(
          ((x >> 3) ^ (y >> 3)) & 1 ? 208 : 144
        );
      }
    }
    const corner = (row: number, col: number): number => edge[row * 64 + col];
    expect([corner(0, 0), corner(0, 63), corner(63, 63), corner(63, 0)]).toEqual([1, 2, 3, 4]);
    expect(corner(31, 31)).toBe(64); // fill
  });
  it('flats are decodable 4096-byte lumps inside F_START/F_END', () => {
    const flats = flatsFromWad(wadOf(buildM4FixturesWad()));
    const names = flats.map((f) => f.name);
    expect(names).toContain(FLAT_RAMP);
    expect(names).toContain(FLAT_CHECKER);
    expect(names).toContain(FLAT_EDGETAG);
    expect(names).toContain('F_SKY1');
    const ramp = flats.find((f) => f.name === FLAT_RAMP)!;
    expect(ramp.bytes.length).toBe(4096);
    expect(ramp.bytes[7 * 64 + 41]).toBe(41); // row-major px = x
  });
});

describe('M4-06 MASKFIX masked texture', () => {
  const wad = wadOf(buildM4FixturesWad());
  const tex = texturesFromWad(wad).get(TEX_MASKED)!;
  it('64x64 composed; sha matches the committed golden', () => {
    expect(tex).toBeDefined();
    expect(tex.width).toBe(64);
    expect(tex.height).toBe(64);
    expect(sha(rasterBytes(tex.columns))).toBe(MASKFIX_COMPOSED_SHA256);
  });
  it('column parity: 0-15/48-63 solid 200; 16-47 EVEN opaque, ODD fully transparent', () => {
    tex.columns.forEach((col, c) => {
      const solid = c < 16 || c >= 48 || c % 2 === 0;
      for (const p of col) expect(p, `col ${c}`).toBe(solid ? 200 : 0);
    });
  });
  it('fence map: sidedefs carry MASKFIX0 in mid AND bottom slots (mapdata-swap shim); rdata marks them masked', () => {
    const md = loadMap(wadOf(buildM4SceneWad('masked')), M4_MAP_NAMES.masked);
    const fenced = md.sideDefs.filter((s) => s.midtexture === TEX_MASKED);
    expect(fenced.length).toBeGreaterThan(0);
    // FINDING pin: mapdata.ts reads "midtexture" from byte 12 (vanilla
    // bottomtexture, doomdata.h). The fixture dual-writes both slots, so
    // this round-trip holds for the current decoder AND a fixed one.
    for (const s of fenced) expect(s.bottomtexture).toBe(TEX_MASKED);
    const world = loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad));
    expect(Array.from(world.sideMasked)).toContain(1);
    expect(world.missingTextures).toEqual([]);
  });
});

describe('M4-06 SKYFIX sky data', () => {
  it('marker codec round-trips every column 0..255', () => {
    for (let c = 0; c < SKY_TEX_WIDTH; c++) {
      const [lo, hi] = skyColumnMarker(c);
      expect(lo, `col ${c} lo`).toBeGreaterThan(0);
      expect(hi, `col ${c} hi`).toBeGreaterThan(0);
      expect(skyColumnDecode(lo, hi), `col ${c}`).toBe(c);
    }
  });
  it('SKY1 texture 256x128 (documented 1024-width deviation), markers composed, sha pinned', () => {
    const wad = wadOf(buildM4FixturesWad());
    const tex = texturesFromWad(wad).get(TEX_SKY)!;
    expect(tex).toBeDefined();
    expect([tex.width, tex.height]).toEqual([SKY_TEX_WIDTH, SKY_TEX_HEIGHT]);
    tex.columns.forEach((col, c) => {
      const [lo, hi] = skyColumnMarker(c);
      col.forEach((p, r) => expect(p, `col ${c} row ${r}`).toBe(r < 64 ? lo : hi));
    });
    expect(sha(rasterBytes(tex.columns))).toBe(SKYFIX_COMPOSED_SHA256);
  });
  it('sky sector parses: ceilingpic name F_SKY1 resolves to a real skyflatnum', () => {
    const bytes = buildM4SceneWad('sky');
    const wad = wadOf(bytes);
    const md = loadMap(wad, M4_MAP_NAMES.sky);
    expect(md.sectors[1]!.ceilingFlat).toBe('F_SKY1');
    const flats = flatsFromWad(wad);
    const world = loadRenderWorld(md, texturesFromWad(wad), flats);
    expect(world.skyflatnum).toBe(flats.findIndex((f) => f.name === 'F_SKY1'));
    expect(world.skyflatnum).toBeGreaterThanOrEqual(0);
    expect(world.skyTextureNum).toBeGreaterThanOrEqual(0);
    // sky room light is 32 — sky stays fullbright via the picnum==skyflatnum
    // branch in drawPlanes (M4-01); fixtures only pin the data here.
    expect(md.sectors[1]!.lightLevel).toBe(32);
  });
});

describe('M4-06 THINGSFIX thing round-trip', () => {
  const wad = wadOf(buildM4SceneWad('things'));
  const raw = loadMap(wad, M4_MAP_NAMES.things).things;
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const rec = (i: number): [number, number, number, number] => [
    v.getInt16(i * 10, true),
    v.getInt16(i * 10 + 2, true),
    v.getInt16(i * 10 + 4, true),
    v.getInt16(i * 10 + 6, true)
  ];
  it('all spec things land in THINGS byte-exact (x, y, angle°, type)', () => {
    const spec = THINGSFIX_SPEC.things!;
    expect(raw.length).toBe(spec.length * 10);
    spec.forEach((t, i) => {
      expect(rec(i), `thing ${i}`).toEqual([t.x, t.y, t.angle ?? 0, t.type]);
    });
  });
  it('octant ring: 8 bearings 45° apart, |r − 160| < 1 around the seeded center', () => {
    const [cx, cy] = THINGS_RING_CENTER;
    for (let k = 0; k < 8; k++) {
      const [x, y, ang, type] = rec(1 + k);
      expect(ang).toBe(k * 45);
      const r = Math.hypot(x - cx, y - cy);
      expect(Math.abs(r - 160), `ring ${k} r=${r}`).toBeLessThan(1);
      const expectType = k === 0 ? THING_TALL : THING_SHORT; // tall/short variant tell
      expect(type).toBe(expectType);
    }
    const [tx, ty, tang, ttype] = rec(9);
    expect([tx, ty, tang, ttype]).toEqual([64, 64, 90, THING_TALL]);
    const [sx, sy, sang, stype] = rec(10);
    expect([sx, sy, sang, stype]).toEqual([448, 64, 270, THING_SHORT]);
  });
  it('things do not perturb the BSP property self-check', () => {
    expect(() => mapSelfCheck(buildM4FixturesWad(), M4_MAP_NAMES.things)).not.toThrow();
  });
});

describe('M4-06 PANFIX sidedef offsets + light variants', () => {
  const wad = wadOf(buildM4SceneWad('panning'));
  const md = loadMap(wad, M4_MAP_NAMES.panning);
  const rooms = M4_SCENES.panning.rooms;
  it('every sidedef referencing room r carries r.wallOffsetX/Y', () => {
    md.sideDefs.forEach((s, i) => {
      const want = s.sector === 0 ? [0, 0] : [
        rooms[s.sector - 1]!.wallOffsetX ?? 0,
        rooms[s.sector - 1]!.wallOffsetY ?? 0
      ];
      expect(s.offset, `sidedef ${i} (sector ${s.sector})`).toEqual(want);
    });
  });
  it('textureoffset reaches rdata sideOffsetX (rowoffset does NOT exist there — pinned)', () => {
    const world = loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad));
    md.sideDefs.forEach((s, i) => {
      expect(world.sideOffsetX[i], `sidedef ${i}`).toBe(s.offset[0] * FRACUNIT);
    });
    expect('sideOffsetY' in world).toBe(false);
  });
  it('light variants 0/128/255 present in SECTORS', () => {
    expect(md.sectors.map((s) => s.lightLevel)).toEqual([0, 0, 128, 255]); // void + rooms
  });
});
