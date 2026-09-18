/**
 * render/rdata tests (M3-plan §M3-02).
 *
 *  * FIXMAP round-trip: table counts equal MapData, every seg/line/side/
 *    sector slot equals the p_setup.c-derived number (coords/offsets <<16,
 *    angle = SEGS-lump u16 BAM << 16), every sidedef texture name resolves
 *    to an index or the −1 sentinel (blank names ⇒ −1, NOT a miss).
 *  * masked flag: synthetic solid (no transparent pixels) vs fence (fully
 *    transparent columns) — a holed texture counts as masked only where a
 *    TWO-SIDED line carries it as middle texture; one-sided midtex stays
 *    solid (file header of rdata.ts).
 *  * getWallColumn fuzz: 10k seeded (tex, col) draws incl. negative int32
 *    cols and a non-power-of-two width — never out of bounds, col&mask wrap
 *    exact on power-of-two widths, invalid tex ⇒ zero sentinel column.
 *  * sha256 of composed FIXWALL0 column 0 (real decodeTextures pipeline on
 *    buildPatchFromColumns patches + synthTexture1 directory).
 *  * flats + sky (M4-02 §M4-02): F_START-scan flatNum with identity
 *    translation, census F_SKY1 ⇒ skyflatnum ≠ −1, 1024-byte sky-flat
 *    tolerance (never decoded — tag only), SKY1 texture resolution and
 *    getSkyColumn ±wrap via the power-of-two widthmask; flatsFromWad raw
 *    directory positions (zero-size lumps INCLUDED = vanilla numflats).
 *  * skipIf(!hasWad): freedoom1 E1M1 loads every seg; missing-texture list
 *    equals the committed list below (golden); flat/sky goldens — F_START
 *    count, F_SKY1 hash + flatnum, SKY1 width TRUTH (256, not id's 1024)
 *    + column 0 sha256; unknown-flat list empty on E1M1.
 *
 * Inputs are plain structural literals where a full fixture WAD would be
 * overkill — the same M2-09 read-view pattern; loadRenderWorld never
 * mutates its inputs (frozen-ness is asserted once).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { decodeFlat, FLAT_BYTES } from '../wad/flat';
import { loadMap } from '../wad/mapdata';
import { buildPatchFromColumns } from '../wad/patch';
import type { LineDef, MapData, Seg, SectorDef, SideDef, TextureDef, Vertex } from '../wad/types';
import { WadFile } from '../wad/wadfile';
import { texturesFromWad } from '../wad/texture';

import { buildFixtureMapWad } from '../../tests/fixtures/mapBuilder';
import { synthFlat, synthPnames, synthTexture1 } from '../../tests/fixtures/smallWads';
import { WadBuilder } from '../../tests/fixtures/wadWriter';
import { loadRenderWorld, flatsFromWad, ML_TWOSIDED, NO_TEXTURE, type FlatSource, type RenderWorld } from './rdata';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function arrayBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Deterministic composed texture: value = fn(col, row), 0 = transparent. */
function mkTexture(name: string, width: number, height: number, fn: (c: number, r: number) => number): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < width; c += 1) {
    const col = new Uint8Array(height);
    for (let r = 0; r < height; r += 1) col[r] = fn(c, r);
    columns.push(col);
  }
  return { name, width, height, patches: [], columns };
}

function mkVertex(x: number, y: number): Vertex {
  return { x, y };
}

function mkLine(v1: number, v2: number, front: number, back: number, flags = 0): LineDef {
  return { v1, v2, front, back, flags, special: 0, tag: 0 };
}

function mkSide(sector: number, top = '', mid = '', bottom = '', offsetX = 0): SideDef {
  return { sector, toptexture: top, midtexture: mid, bottomtexture: bottom, offset: [offsetX, 0], light: 0 };
}

function mkSeg(v1: number, v2: number, angleBamU16: number, line: number, side: number, offset = 0): Seg {
  return { v1, v2, angle: angleBamU16, line, side, offset };
}

function mkSector(floorLh: number, ceilingLh: number, lightLevel = 192): SectorDef {
  return { floorLh, ceilingLh, floorFlat: 'FLOOR4_8', ceilingFlat: 'F_CEIL1', lightLevel, special: 0, tag: 0 };
}

/** Minimal MapData literal with caller-supplied tables. */
function mkMap(parts: {
  vertices: Vertex[];
  lineDefs: LineDef[];
  sideDefs: SideDef[];
  segs: Seg[];
  sectors: SectorDef[];
  name?: string;
}): MapData {
  return {
    name: parts.name ?? 'FIXSYN',
    things: new Uint8Array(0),
    lineDefs: parts.lineDefs,
    sideDefs: parts.sideDefs,
    vertices: parts.vertices,
    segs: parts.segs,
    ssectors: [],
    nodes: [],
    sectors: parts.sectors,
    reject: new Uint8Array(0),
    blockmap: new Uint8Array(0),
  };
}

/* ------------------------------------------------------------------ */
/* 1. FIXMAP round-trip (fixture WAD map lumps + composed texture map) */
/* ------------------------------------------------------------------ */

const FIX_SPEC = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 192 },
    { x: 256, y: 0, w: 256, h: 256, floorHeight: 8, lightLevel: 200 },
  ],
  doors: [{ x1: 256, y1: 64, x2: 256, y2: 128, special: 1 }],
};

function fixtureWorld(): { md: MapData; world: RenderWorld } {
  const bytes = buildFixtureMapWad(FIX_SPEC);
  const wad = WadFile.parse(arrayBuf(bytes));
  const md = loadMap(wad, 'FIXMAP');
  // The fixture sidedefs reference FIXWALL0/DOORFIX0; supply composed defs
  // directly (the fixture's 2x2 synthPatch lumps are not decodable post
  // format — see report follow-up; graphics are covered by group 4).
  const textures = new Map<string, TextureDef>([
    ['FIXWALL0', mkTexture('FIXWALL0', 64, 128, () => 9)],
    ['DOORFIX0', mkTexture('DOORFIX0', 64, 128, () => 11)],
  ]);
  return { md, world: loadRenderWorld(md, textures) };
}

describe('loadRenderWorld FIXMAP round-trip', () => {
  const { md, world } = fixtureWorld();

  it('table counts equal the decoded MapData counts', () => {
    expect(world.mapName).toBe('FIXMAP');
    expect(world.numSegs).toBe(md.segs.length);
    expect(world.numLines).toBe(md.lineDefs.length);
    expect(world.numSides).toBe(md.sideDefs.length);
    expect(world.numSectors).toBe(md.sectors.length);
    expect(world.missingTextures).toEqual([]);
  });

  it('seg slots are the p_setup.c numbers: verts<<16, BAM u16<<16, resolved sidedef', () => {
    for (let i = 0; i < world.numSegs; i += 1) {
      const sg = md.segs[i]!;
      const v1 = md.vertices[sg.v1]!;
      const v2 = md.vertices[sg.v2]!;
      expect(world.segV1x[i]).toBe((v1.x * FRACUNIT) | 0);
      expect(world.segV1y[i]).toBe((v1.y * FRACUNIT) | 0);
      expect(world.segV2x[i]).toBe((v2.x * FRACUNIT) | 0);
      expect(world.segV2y[i]).toBe((v2.y * FRACUNIT) | 0);
      // angle from the SEGS lump (R01 §8), NOT an atan2 recompute.
      expect(world.segAngle[i]).toBe((sg.angle & 0xffff) * 0x10000);
      expect(world.segOffset[i]).toBe((sg.offset * FRACUNIT) | 0);
      expect(world.segLine[i]).toBe(sg.line);
      const line = sg.line >= 0 ? md.lineDefs[sg.line]! : null;
      const expectSide = line === null ? NO_TEXTURE : sg.side === 0 ? line.front : line.back;
      expect(world.segSide[i]).toBe(expectSide);
    }
  });

  it('line/side/sector slots carry coords<<16, sidenums and fixed heights', () => {
    for (let i = 0; i < world.numLines; i += 1) {
      const ld = md.lineDefs[i]!;
      expect(world.lineX1[i]).toBe((md.vertices[ld.v1]!.x * FRACUNIT) | 0);
      expect(world.lineY2[i]).toBe((md.vertices[ld.v2]!.y * FRACUNIT) | 0);
      expect(world.lineFront[i]).toBe(ld.front);
      expect(world.lineBack[i]).toBe(ld.back);
      expect(world.lineFlags[i]).toBe(ld.flags & 0xffff);
      // two-sided ⇔ (ML_TWOSIDED set && back sidenum present) on this map
      expect((ld.flags & ML_TWOSIDED) !== 0).toBe(ld.back >= 0);
    }
    for (let i = 0; i < world.numSides; i += 1) {
      expect(world.sideOffsetX[i]).toBe((md.sideDefs[i]!.offset[0] * FRACUNIT) | 0);
      expect(world.sideSector[i]).toBe(md.sideDefs[i]!.sector);
    }
    for (let i = 0; i < world.numSectors; i += 1) {
      expect(world.sectorFloor[i]).toBe((md.sectors[i]!.floorLh * FRACUNIT) | 0);
      expect(world.sectorCeil[i]).toBe((md.sectors[i]!.ceilingLh * FRACUNIT) | 0);
      expect(world.sectorLight[i]).toBe(md.sectors[i]!.lightLevel);
    }
  });

  it('every sidedef texture name resolves or is the −1 sentinel; blanks are not misses', () => {
    for (let s = 0; s < md.sideDefs.length; s += 1) {
      const sd = md.sideDefs[s]!;
      for (const [name, slot] of [
        [sd.toptexture, world.sideTopTex[s]!],
        [sd.midtexture, world.sideMidTex[s]!],
        [sd.bottomtexture, world.sideBotTex[s]!],
      ] as const) {
        if (name === '') {
          expect(slot).toBe(NO_TEXTURE);
        } else {
          expect(slot).toBeGreaterThanOrEqual(0);
          expect(world.textureNames[slot]!.toUpperCase()).toBe(name);
        }
      }
    }
    // the fixture's blank-texture sidedefs still exercise the −1 sentinel,
    // and the door gap paints DOORFIX0 as bottom texture (mapBuilder rule)
    expect(Array.from(world.sideBotTex).filter((t) => t !== NO_TEXTURE).length).toBeGreaterThan(0);
  });

  it('is deterministic: a second load produces byte-identical tables', () => {
    const again = fixtureWorld().world;
    const sha = (w: RenderWorld): string =>
      createHash('sha256')
        .update(new Uint8Array(w.segV1x.buffer, w.segV1x.byteOffset, w.segV1x.byteLength))
        .update(new Uint8Array(w.segAngle.buffer, w.segAngle.byteOffset, w.segAngle.byteLength))
        .update(new Uint8Array(w.sideMidTex.buffer, w.sideMidTex.byteOffset, w.sideMidTex.byteLength))
        .digest('hex');
    expect(sha(again)).toBe(sha(world));
  });

  it('flatNum without a flat table degrades to −1 for every name', () => {
    expect(world.flatNum('FLOOR4_8')).toBe(-1);
    expect(world.flatNum('F_SKY1')).toBe(-1);
  });
});

/* ------------------------------------------------------------------ */
/* 2. masked flag: synthetic solid vs fence                           */
/* ------------------------------------------------------------------ */

describe('masked middle flag', () => {
  // vertices/lines layout: three parallel walls sharing vertex pair 0-1.
  //  S0: fence middle, ONE-sided  (solid path — masked must stay 0)
  //  S1: fence middle, TWO-sided  (masked = 1)
  //  S2: solid middle, TWO-sided  (masked = 0 — no transparent pixels)
  //  S5: unknown texture name     (−1 + miss record, masked 0)
  //  S6: '-NOPE' name            (vanilla NoTexture marker: −1, NO miss)
  const SOLID = mkTexture('SOLIDTEX', 64, 128, () => 7); // never 0
  const FENCE = mkTexture('FENCETEX', 64, 128, (c) => (c % 2 === 0 ? 7 : 0)); // holed
  const textures = new Map<string, TextureDef>([
    ['SOLIDTEX', SOLID],
    ['FENCETEX', FENCE],
  ]);
  const world = loadRenderWorld(
    mkMap({
      vertices: [mkVertex(0, 0), mkVertex(128, 0)],
      sectors: [mkSector(0, 128), mkSector(0, 128), mkSector(0, 128)],
      lineDefs: [
        mkLine(0, 1, 0, -1), // one-sided fence
        mkLine(0, 1, 1, 3, ML_TWOSIDED), // two-sided fence
        mkLine(0, 1, 2, 4, ML_TWOSIDED), // two-sided solid mid
        mkLine(0, 1, 5, -1), // unresolvable mid name
        mkLine(0, 1, 6, -1), // '-'-prefixed NoTexture name
      ],
      sideDefs: [
        mkSide(0, '', 'FENCETEX'),
        mkSide(0, '', 'FENCETEX'),
        mkSide(0, '', 'SOLIDTEX'),
        mkSide(1),
        mkSide(2),
        mkSide(0, '', 'NOSUCHTE'),
        mkSide(0, '', '-NOTEX'),
      ],
      segs: [mkSeg(0, 1, 0, 0, 0), mkSeg(0, 1, 0, 1, 0), mkSeg(0, 1, 0, 2, 0), mkSeg(0, 1, 0, 3, 0), mkSeg(0, 1, 0, 4, 0)],
    }),
    textures,
  );

  it('texture scan: solid 0, fence 1 (transparent columns exist)', () => {
    expect(world.texMasked[0]).toBe(0); // SOLIDTEX
    expect(world.texMasked[1]).toBe(1); // FENCETEX
  });

  it('sidedef flag: only the two-sided fence sidedef is masked', () => {
    expect(Array.from(world.sideMasked)).toEqual([0, 1, 0, 0, 0, 0, 0]);
  });

  it('unresolvable names land in missingTextures once, slot −1; \'-\' names are not misses', () => {
    expect(world.missingTextures).toEqual(['NOSUCHTE']);
    expect(world.sideMidTex[5]).toBe(NO_TEXTURE);
    expect(world.sideMidTex[6]).toBe(NO_TEXTURE); // vanilla '-' NoTexture marker
  });
});

/* ------------------------------------------------------------------ */
/* 3. getWallColumn fuzz (10k, incl. negative cols, odd widths)        */
/* ------------------------------------------------------------------ */

describe('getWallColumn', () => {
  const WIDTHS = [1, 2, 3, 4, 7, 8, 65, 128]; // 3/7/65 deliberately non-power-of-two
  const HEIGHT = 16;
  const textures = new Map<string, TextureDef>(
    WIDTHS.map((w, i) => [`W${w}`, mkTexture(`W${w}`, w, HEIGHT, (c, r) => (i * 97 + c * 31 + r * 17) & 0xff)]),
  );
  const world = loadRenderWorld(
    mkMap({ vertices: [mkVertex(0, 0), mkVertex(1, 0)], sectors: [mkSector(0, 1)], lineDefs: [], sideDefs: [], segs: [] }),
    textures,
  );

  it('10k seeded draws (neg int32 cols incl.) never read out of bounds', () => {
    const rnd = lcg(0x5eed1);
    for (let i = 0; i < 10000; i += 1) {
      const t = (rnd() * world.numTextures) | 0;
      const col = (rnd() * 0x100000000) | 0; // full int32 incl. negatives
      const column = world.getWallColumn(t, col);
      expect(column.length).toBe(world.texHeight[t]); // exact, never OOB
      const c = col & (WIDTHS[t]! - 1); // col&mask wrap (vanilla texturewidthmask)
      expect(c).toBeLessThan(WIDTHS[t]!);
      for (let r = 0; r < HEIGHT; r += 1) {
        expect(column[r]).toBe((t * 97 + c * 31 + r * 17) & 0xff);
      }
    }
  });

  it('power-of-two widths wrap with +width multiples exactly', () => {
    const rnd = lcg(0x5eed2);
    for (const t of [0, 1, 3, 5, 7]) {
      const w = WIDTHS[t]!;
      expect(w & (w - 1)).toBe(0); // power-of-two sanity
      for (let i = 0; i < 50; i += 1) {
        const col = (rnd() * 2000) | 0;
        const a = world.getWallColumn(t, col);
        const b = world.getWallColumn(t, col + w * (1 + ((rnd() * 5) | 0)));
        expect(Array.from(b)).toEqual(Array.from(a));
      }
    }
  });

  it('invalid texture indices (−1 sentinel, OOR, NaN) yield the zero 128-tall column', () => {
    for (const bad of [NO_TEXTURE, -99999, world.numTextures, world.numTextures + 77, NaN]) {
      const column = world.getWallColumn(bad, 5);
      expect(column.length).toBe(128);
      expect(column.every((p) => p === 0)).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4. composed FIXWALL0 through the REAL decodeTextures pipeline       */
/* ------------------------------------------------------------------ */

describe('composed FIXWALL0 golden', () => {
  // 64x128 texture: FIXPA (64 wide, value ((c*7 + r*3) % 255) + 1) at x=0,
  // FIXPB (32 wide, ((c*5 + r*11) % 255) + 1) overwriting columns 32..63.
  const fixpa: number[][] = [];
  for (let c = 0; c < 64; c += 1) {
    fixpa.push(Array.from({ length: 128 }, (_, r) => ((c * 7 + r * 3) % 255) + 1));
  }
  const fixpb: number[][] = [];
  for (let c = 0; c < 32; c += 1) {
    fixpb.push(Array.from({ length: 128 }, (_, r) => ((c * 5 + r * 11) % 255) + 1));
  }
  const wadBytes = new WadBuilder('IWAD')
    .addLump(
      'TEXTURE1',
      synthTexture1([
        { name: 'FIXWALL0', width: 64, height: 128, patches: [[0, 0, 0], [32, 0, 1]] },
      ]),
    )
    .addLump('PNAMES', synthPnames(['FIXPA', 'FIXPB']))
    .addLumpMarker('P_START')
    .addLump('FIXPA', buildPatchFromColumns(fixpa))
    .addLump('FIXPB', buildPatchFromColumns(fixpb))
    .addLumpMarker('P_END')
    .build();

  it('column 0 matches the committed sha256; stitch lands at originx=32', () => {
    const world = loadRenderWorld(
      mkMap({ vertices: [], sectors: [], lineDefs: [], sideDefs: [], segs: [] }),
      texturesFromWad(WadFile.parse(arrayBuf(wadBytes))),
    );
    const tex = world.textureNames.indexOf('FIXWALL0');
    expect(tex).toBe(0);
    expect(world.texWidth[tex]).toBe(64);
    expect(world.texWidthMask[tex]).toBe(63);
    expect(world.texHeight[tex]).toBe(128);
    expect(world.texMasked[tex]).toBe(0); // fully covered ⇒ no transparent pixel
    const col0 = world.getWallColumn(tex, 0);
    expect(createHash('sha256').update(col0).digest('hex')).toBe(
      '0c78f3a089e6cecc454ae9b7a5b3be4fbcda549ebd9962e1585ce802d1163747',
    );
    expect(Array.from(col0)).toEqual(Array.from({ length: 128 }, (_, r) => ((r * 3) % 255) + 1));
    // column 32 = FIXPB column 0 (patch stitch at originx 32), column 31 = FIXPA 31
    expect(Array.from(world.getWallColumn(tex, 32))).toEqual(
      Array.from({ length: 128 }, (_, r) => ((r * 11) % 255) + 1),
    );
    expect(world.getWallColumn(tex, 31)[5]).toBe(fixpa[31]![5]);
    // width wrap: col 64+0 ≡ col 0, negative −1 ≡ 63
    expect(Array.from(world.getWallColumn(tex, 64))).toEqual(Array.from(col0));
    expect(Array.from(world.getWallColumn(tex, -1))).toEqual(
      Array.from(world.getWallColumn(tex, 63)),
    );
  });
});

/* ------------------------------------------------------------------ */
/* 5. freedoom1 E1M1 (skipIf no wad)                                  */
/* ------------------------------------------------------------------ */

/** Candidate IWAD paths, first existing wins (worktrees may lack wads/). */
function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url)),
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

const WAD_PATH = findWad();
const hasWad = WAD_PATH !== undefined;

/** Committed missing-texture list for freedoom1 E1M1 sidedefs. EMPTY:
 * every non-blank, non-'-' sidedef texture name resolves in
 * TEXTURE1/TEXTURE2 ('-…' names are vanilla's NoTexture marker —
 * r_data.c:692-697 — not misses; E1M1 does reference '-', as vanilla
 * tolerated silently). */
const E1M1_MISSING_TEXTURES: readonly string[] = [];

describe.skipIf(!hasWad)('freedoom1.wad E1M1 render-world load', () => {
  it('all segs load and the missing-texture list matches the committed one', () => {
    const wad = WadFile.parse(readFileSync(WAD_PATH!).buffer as ArrayBuffer);
    const md = loadMap(wad, 'E1M1');
    const world = loadRenderWorld(md, texturesFromWad(wad));

    expect(world.numSegs).toBe(md.segs.length);
    expect(world.numSegs).toBeGreaterThan(1300); // E1M1 is ~1.4k segs
    expect(world.missingTextures).toEqual(E1M1_MISSING_TEXTURES);

    for (let i = 0; i < world.numSegs; i += 1) {
      const sg = md.segs[i]!;
      // every table slot finite, coords = vertex table << 16, angle = BAM<<16
      expect(Number.isFinite(world.segV1x[i]!)).toBe(true);
      expect(world.segV1x[i]).toBe((md.vertices[sg.v1]!.x * FRACUNIT) | 0);
      expect(world.segV2y[i]).toBe((md.vertices[sg.v2]!.y * FRACUNIT) | 0);
      expect(world.segAngle[i]! / 0x10000).toBe(sg.angle & 0xffff);
      // sidedef slot = front/back per seg side (no minisegs on this map)
      const line = md.lineDefs[sg.line]!;
      expect(world.segSide[i]).toBe(sg.side === 0 ? line.front : line.back);
    }
    // sanity: texture tables populated, masked middles exist on this map
    expect(world.numTextures).toBeGreaterThan(300); // freedoom TEXTURE1+2
    expect(world.numTextures).toBe(world.textureNames.length);
    let masked = 0;
    for (let i = 0; i < world.numSides; i += 1) masked += world.sideMasked[i]!;
    expect(masked).toBeGreaterThan(0); // E1M1 has two-sided fence middles
  });
});

/* ------------------------------------------------------------------ */
/* 6. flats + sky wiring (M4-02: R_InitFlats + sky texture)            */
/* ------------------------------------------------------------------ */

describe('flat/sky data wiring (M4-02)', () => {
  const SKY_W = 256; // synthetic sky width; freedoom1 truth below, id's is 1024
  const A = synthFlat(0xa11a);
  const B = synthFlat(0xb0b0);
  const SKYDUMMY = new Uint8Array(1024); // id-style F_SKY1: NOT 4096 bytes

  const mkFlats = (): FlatSource[] => [
    { name: 'FLATA', bytes: A },
    { name: 'flatb', bytes: B }, // lowercase dir name: lookup is case-insens
    { name: 'F_SKY1', bytes: SKYDUMMY },
  ];
  const textures = new Map<string, TextureDef>([
    ['SOLID0', mkTexture('SOLID0', 64, 128, () => 3)],
    ['SKY1', mkTexture('SKY1', SKY_W, 128, (c, r) => ((c * 7 + r) % 255) + 1)],
  ]);
  const mkEmptyMap = (): MapData =>
    mkMap({
      vertices: [mkVertex(0, 0), mkVertex(1, 0)],
      sectors: [mkSector(0, 1)],
      lineDefs: [],
      sideDefs: [],
      segs: [],
    });
  const world = loadRenderWorld(mkEmptyMap(), textures, mkFlats());

  /* -- acceptance 1: census — F_SKY1 present ⇒ skyflatnum ≠ −1 ------- */
  it('census: identity translation, F_SKY1 index = skyflatnum ≠ −1', () => {
    expect(world.numFlats).toBe(3);
    expect(world.flatNames).toEqual(['FLATA', 'FLATB', 'F_SKY1']);
    expect(world.flatNum('FLATA')).toBe(0);
    expect(world.flatNum('FLATB')).toBe(1); // dir-case-insensitive
    expect(world.flatNum('f_sky1')).toBe(2);
    expect(world.skyflatnum).toBe(2); // tag-only index (g_game.c:454)
    expect(world.skyflatnum).not.toBe(-1);
    expect(world.missingFlats).toEqual([]); // sky lookups are not sector misses
  });

  it('duplicate flat names: LAST directory match wins (vanilla reverse scan)', () => {
    const dup = loadRenderWorld(mkEmptyMap(), textures, [
      { name: 'DUP', bytes: A },
      { name: 'OTHER', bytes: B },
      { name: 'DUP', bytes: B },
    ]);
    expect(dup.flatNum('DUP')).toBe(2);
  });

  /* -- acceptance 4: unknown name ⇒ −1 + warn list, recorded once ---- */
  it('unknown names: −1 + de-duplicated missingFlats warn list', () => {
    expect(world.flatNum('NOPE1')).toBe(-1);
    expect(world.flatNum('NOPE1')).toBe(-1);
    expect(world.flatNum('nope2')).toBe(-1);
    expect(world.missingFlats).toEqual(['NOPE1', 'NOPE2']);
  });

  it('getFlatPixels: raw decode passthrough; bad size / OOB ⇒ zero sentinel', () => {
    expect(world.getFlatPixels(0)).toEqual(A);
    expect(world.getFlatPixels(1)).toEqual(B);
    expect(world.getFlatPixels(0)).toBe(world.getFlatPixels(0)); // cached
    // F_SKY1 dummy tolerated WITHOUT throwing (never drawn: sky guard):
    expect(world.getFlatPixels(world.skyflatnum)).toEqual(new Uint8Array(FLAT_BYTES));
    expect(world.getFlatPixels(-1)).toEqual(new Uint8Array(FLAT_BYTES));
    expect(world.getFlatPixels(9999)).toEqual(new Uint8Array(FLAT_BYTES));
    // sanity: a real 4096 flat does decode through wad/flat unchanged
    expect(decodeFlat(A, 'FLATA').pixels).toEqual(A);
  });

  /* -- sky texture + acceptance 3: wrap for ±out-of-range angles ----- */
  it('skyTextureNum = SKY1 directory index; getSkyColumn wraps ±via widthmask', () => {
    expect(world.skyTextureNum).toBe(1);
    for (const k of [0, 1, 255, 256, 1023, 1024, 1025, 4096, 917504, 2 ** 30]) {
      expect(world.getSkyColumn(k)).toBe(world.getWallColumn(world.skyTextureNum, k & (SKY_W - 1)));
    }
    expect(world.getSkyColumn(-1)).toBe(world.getSkyColumn(SKY_W - 1));
    expect(world.getSkyColumn(-257)).toBe(world.getSkyColumn(255));
    expect(world.getSkyColumn(1024 + 3)).toBe(world.getSkyColumn(3));
    expect(world.getSkyColumn(256)).toBe(world.getSkyColumn(0));
    expect(world.getSkyColumn(-(2 ** 31))).toBe(world.getSkyColumn(0)); // int32 MIN
  });

  it('no SKY1 texture: skyTextureNum −1, getSkyColumn → zero column', () => {
    const w = loadRenderWorld(mkEmptyMap(), new Map([['SOLID0', mkTexture('SOLID0', 64, 128, () => 3)]]), mkFlats());
    expect(w.skyTextureNum).toBe(-1);
    expect(w.getSkyColumn(5)).toEqual(new Uint8Array(128));
  });

  /* -- flatsFromWad: raw F_START/F_END directory positions ----------- */
  it('flatsFromWad: raw dir order incl. zero-size lumps (vanilla numflats); markers absent ⇒ []', () => {
    const bytes = arrayBuf(
      new WadBuilder()
        .addLump('GIMMICK', new Uint8Array(8))
        .addLumpMarker('F_START')
        .addLump('FLATA', A)
        .addLump('EMPTY0', new Uint8Array(0)) // vanilla counts it as a flat
        .addLump('F_SKY1', SKYDUMMY)
        .addLumpMarker('F_END')
        .build(),
    );
    const wad = WadFile.parse(bytes);
    const flats = flatsFromWad(wad);
    expect(flats.length).toBe(3); // raw count lastflat-firstflat+1 = 3
    expect(wad.lumpRange('F_START', 'F_END').length).toBe(2); // lumpRange skips EMPTY0
    const w = loadRenderWorld(mkEmptyMap(), textures, flats);
    expect(w.flatNames).toEqual(['FLATA', 'EMPTY0', 'F_SKY1']);
    expect(w.skyflatnum).toBe(2); // lumpnum − firstflat, zero-size lump counted
    expect(w.flatNum('FLATA')).toBe(0);
    expect(flatsFromWad(WadFile.parse(arrayBuf(new WadBuilder().addLump('X', new Uint8Array(4)).build())))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 7. freedoom1 flat/sky goldens (skipIf no wad)                       */
/* ------------------------------------------------------------------ */

describe.skipIf(!hasWad)('freedoom1.wad flat/sky goldens (M4-02)', () => {
  const wad = hasWad ? WadFile.parse(readFileSync(WAD_PATH!).buffer as ArrayBuffer) : null;
  const world = wad ? loadRenderWorld(loadMap(wad, 'E1M1'), texturesFromWad(wad), flatsFromWad(wad)) : null;

  it('F_START census: vanilla numflats 246, skyflatnum 120, F_SKY1 hash', () => {
    expect(wad!.lumpRange('F_START', 'F_END').length).toBe(240); // zero-size skips
    expect(world!.numFlats).toBe(246); // vanilla raw count (F_END−F_START−1)
    expect(world!.skyflatnum).toBe(120);
    expect(world!.skyflatnum).not.toBe(-1); // census acceptance
    expect(world!.flatNum('F_SKY1')).toBe(120);
    // Recorded 2026-09 from wads/freedoom1.wad (v0.13.0): the F_SKY1 lump
    // IS 4096 bytes in freedoom (id WADs carry smaller dummies).
    expect(createHash('sha256').update(wad!.readLump(wad!.lumpNumByName('F_SKY1'))).digest('hex')).toBe(
      '46427ffa69b1764b3ca0c6bef51a09865dd503e457a06f41cb3eb27305de8d7f',
    );
  });

  it('SKY1 texture TRUTH: width 256 (NOT 1024 as plan assumed), col0 sha golden', () => {
    const sky = world!.skyTextureNum;
    expect(sky).toBeGreaterThanOrEqual(0);
    expect(world!.textureNames[sky]!).toBe('SKY1');
    // TRUTH PINNED 2026-09: freedoom1.wad SKY1 is 256 px wide (id DOOM's
    // is 1024). Still power-of-two ⇒ the vanilla & (width−1) wrap is exact.
    expect(world!.texWidth[sky]).toBe(256);
    expect(world!.texWidthMask[sky]).toBe(255);
    expect(createHash('sha256').update(world!.getSkyColumn(0)).digest('hex')).toBe(
      'b6d3488800ad99319737859696c37c45f69577a6f08f6c1eb6efcc41effff979',
    );
    // wrap vectors on the real texture (buckets are angle>>22 ⇒ 0…1023):
    expect(world!.getSkyColumn(256)).toBe(world!.getSkyColumn(0));
    expect(world!.getSkyColumn(-1)).toBe(world!.getSkyColumn(255));
    expect(world!.getSkyColumn(1024 + 3)).toBe(world!.getSkyColumn(3));
    expect(world!.getSkyColumn(1023)).toBe(world!.getWallColumn(sky, 255));
  });

  it('E1M1 flat census: every sector flat resolves; missingFlats EMPTY', () => {
    const md = loadMap(wad!, 'E1M1');
    for (const s of md.sectors) {
      expect(world!.flatNum(s.floorFlat)).not.toBe(-1);
      expect(world!.flatNum(s.ceilingFlat)).not.toBe(-1);
    }
    expect(world!.missingFlats).toEqual([]); // committed: empty on E1M1
  });
});
