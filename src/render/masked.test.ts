/**
 * M4-04 acceptance — plane marking + masked middle drawing.
 *
 *  1. MARKING (fixture: two rooms, different floor AND ceiling heights +
 *     different flats + light ⇒ markfloor/markceiling fire per r_segs.c
 *     :537-558). Mark ranges vs the hand-computed `centery − h·scale`
 *     chain (segs.test.ts chain; the perpendicular boundary sits 128
 *     units from the eye ⇒ rw_scale = 160/128 = 1.25 exactly):
 *       viewpoint A (in the floor-0/ceil-128 room facing the boundary,
 *       eye viewz 41; front = A):
 *         floor plane (h=0, FLATA, 192) col 160 = [152, 199]:
 *           yh = floor line 100 + 41·1.25 = 151.25 → 151 (bottomfrac
 *           chain: (409600 + 209920) >> 12), top = yh+1, bottom =
 *           floorclip−1 = 200−1 (mark BEFORE the seg's own updates).
 *         floor plane (h=16, FLATB, 160) col 160 bottom = 151 — written
 *           by room B's FAR wall (x=512, distance 384) through the
 *           boundary opening, clamped by the boundary seg's floorclip =
 *           yh+1 = 152 (no bottom texture ⇒ the mark branch updates the
 *           clip). Its top = that wall's own floor line 100+25·0.41667 ≈
 *           110 → 111 (table-quantized ⇒ asserted as a range).
 *         ceiling plane (h=96, CLATB, 160) col 160 top = 0 (vanilla's
 *           negative ceilingclip = −10 clamped — segs.ts pinned DEV),
 *           bottom = the B wall's ceiling line ≈ 77 (range).
 *         ceiling plane (h=128) col 160 NEVER marked (line row
 *           100−87·1.25 = −8.75 ⇒ bottom < top).
 *       viewpoint B: the boundary seg itself is the mark author:
 *         ceiling plane (h=96) [0, 31] (yl = ((128000+4095)>>12) = 32),
 *         floor plane (h=16) [132, 199] (bottomfrac 537600 → yh 131).
 *     EXACTLY-ONCE: across ALL planes no (column,row) is marked twice in
 *     any frame — the clip math's whole purpose.
 *  2. SKY COLLAPSE: two sectors (ceilings 128/160, LIGHT 192/64) both
 *     F_SKY1 ⇒ findPlane's collapse (height=0, light=0) merges ALL
 *     ceiling marks into ONE plane (§0.3).
 *  3. SKY GUARD (r_segs.c:672 `&& ceilingpic != skyflatnum`): a sky
 *     ceiling BELOW viewz keeps marking (centre column [0,133] for
 *     ceiling 64 vs eye 91 at distance 128: yl = ceil(100+27·1.25)+ =
 *     134); the identical non-sky room opens no ceiling plane at all.
 *  4. MASKED (hand map, eye (160,128) facing west, single subsector ⇒
 *     draw order = segs table order: occluder x=128, fence x=80, far
 *     wall x=0):
 *       fence scale 160/80 = 2.0, texturemid = (128−41)<<16 ⇒ texel r at
 *       row −74 + 2r; texels 0-39 & 60-127 = 200, 40-59 holes;
 *       occluder (1-sided mid=120) removes its projection span from the
 *       fence drawseg EXACTLY at the fragment boundary; holes reveal the
 *       EARLIER-DRAWN farther wall (77) / untouched 0 above it; the
 *       consumed maskedtexturecol resets to MAXSHORT; a second
 *       drawMasked() draws nothing.
 *  5. Counters (hom/visplaneOverflow/openingOverflow/drawsegOverflow)
 *     stay 0 on every fixture frame.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { ANG180, FRACUNIT } from '../core/constants';
import { loadMap } from '../wad/mapdata';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import type { LineDef, MapData, Seg, SectorDef, SideDef, TextureDef, Vertex } from '../wad/types';

import { createBspWalker } from './bsp';
import { Framebuffer, RENDER_WIDTH } from './framebuffer';
import { createSegCallbacks } from './segs';
import {
  clearClipArrays, clearDrawsegs, clipValue, drawsegCount, getDrawsegs, maskedTexturecol,
  CLIP_NULL,
} from './drawsegs';
import { clearClipSegs, getRenderCounters, resetRenderCounters } from './solidsegs';
import { loadRenderWorld, type FlatSource, type RenderWorld } from './rdata';
import { configureMaskedPass, drawMasked } from './masked';
import {
  getSkyflatnum, planeAt, planeBottom, planeCount, planeHeight, planeLight, planePic,
  planeTop, resetPlanesForTests, setSkyflatnum,
} from './planes';
import { initLightTables, type LightTables } from './lights';
import {
  buildRenderMapView, createViewState, setupView, VIEWHEIGHT,
  type RenderMapView, type ViewState,
} from './view';

const F = (v: number): number => (v * FRACUNIT) | 0;

/* ------------------------------------------------------------------ */
/* Shared helpers                                                     */
/* ------------------------------------------------------------------ */

// ONE identity light table object for the whole file (pixel == texel
// value; segs.ts default-table parity) — seg callbacks and the masked
// context must share it (vanilla module-global scalelight parity).
let sharedTables: LightTables | undefined;
function tables(): LightTables {
  if (sharedTables === undefined) {
    const rows = new Uint8Array(34 * 256);
    for (let i = 0; i < rows.length; i++) rows[i] = i & 255;
    sharedTables = initLightTables(rows);
  }
  return sharedTables;
}

function mkTex(name: string, width: number, fn: (c: number, r: number) => number): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < width; c++) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r++) col[r] = fn(c, r);
    columns.push(col);
  }
  return { name, width, height: 128, patches: [], columns } as unknown as TextureDef;
}

/** Flat stub lumps (contents never sampled — no drawPlanes in this file). */
function mkFlat(name: string, v: number): FlatSource {
  return { name, bytes: new Uint8Array(4096).fill(v) };
}
function mkSkyFlat(): FlatSource {
  return { name: 'F_SKY1', bytes: new Uint8Array(1024) }; // id-style dummy
}

interface World3 {
  md: MapData;
  world: RenderWorld;
  map: RenderMapView;
}

function world3(md: MapData, textures: Map<string, TextureDef>, flats: FlatSource[] = []): World3 {
  return { md, world: loadRenderWorld(md, textures, flats), map: buildRenderMapView(md) };
}

interface Pose { x: number; y: number; z?: number; angle: number }

/** One frame: clear trio + counters + black bg, then the BSP walk (walk
 * runs validcount++ / R_ClearPlanes internally — bsp.ts, M4-01 seam). */
function frame(w: World3, fb: Framebuffer, pose: Pose): ViewState {
  const view = createViewState();
  setupView(view, {
    x: F(pose.x), y: F(pose.y), z: pose.z === undefined ? 0 : F(pose.z), angle: pose.angle,
  });
  const cb = createSegCallbacks(fb, w.world, view, w.map, tables());
  configureMaskedPass({ indices: fb.indices, colormaps: tables().colormaps, world: w.world, view, tables: tables() });
  clearClipSegs(RENDER_WIDTH);
  clearDrawsegs();
  clearClipArrays(VIEWHEIGHT);
  resetRenderCounters();
  fb.clear(0);
  createBspWalker(w.map, w.world).walk(view, cb);
  return view;
}

function px(fb: Framebuffer, col: number, row: number): number {
  return fb.indices[row * RENDER_WIDTH + col]!;
}

/** No (column,row) may be marked by two planes (0xff = unmarked; a
 * bottom < top pair is an empty/unmarked slot). */
function assertMarksExactlyOnce(label: string): void {
  const seen = new Set<number>();
  for (let p = 0; p < planeCount(); p++) {
    const pl = planeAt(p);
    for (let x = 0; x < RENDER_WIDTH; x++) {
      const t = planeTop(pl, x);
      if (t === 0xff) continue;
      const b = planeBottom(pl, x);
      if (b < t) continue;
      for (let y = t; y <= b; y++) {
        const key = x * 256 + y;
        expect(seen.has(key), `${label}: (col ${x}, row ${y}) marked twice`).toBe(false);
        seen.add(key);
      }
    }
  }
}

function countersZero(label: string): void {
  const c = getRenderCounters();
  expect(c.hom, `${label}:hom`).toBe(0);
  expect(c.visplaneOverflow, `${label}:visplaneOverflow`).toBe(0);
  expect(c.openingOverflow, `${label}:openingOverflow`).toBe(0);
  expect(c.drawsegOverflow, `${label}:drawsegOverflow`).toBe(0);
}

function findPlane3(h: number, pic: number, light: number): number {
  for (let p = 0; p < planeCount(); p++) {
    if (planeHeight(planeAt(p)) === h && planePic(planeAt(p)) === pic &&
        planeLight(planeAt(p)) === light) return p;
  }
  return -1;
}

function wallTex(): Map<string, TextureDef> {
  return new Map([['FIXWALL0', mkTex('FIXWALL0', 64, (c, r) => ((c * 7 + r * 3) % 255) + 1)]]);
}

/* ------------------------------------------------------------------ */
/* 1. Marking — mapBuilder two rooms                                  */
/* ------------------------------------------------------------------ */

const MARK_SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, floorHeight: 0, ceilingHeight: 128, lightLevel: 192,
      floorFlat: 'FLATA', ceilingFlat: 'CLATA' },
    { x: 256, y: 0, w: 256, h: 256, floorHeight: 16, ceilingHeight: 96, lightLevel: 160,
      floorFlat: 'FLATB', ceilingFlat: 'CLATB' },
  ],
};

describe('M4-04 plane marking (two-room fixture)', () => {
  const w = world3(
    loadMap(WadFile.parse(buildFixtureMapWad(MARK_SPEC).buffer as ArrayBuffer), 'FIXMAP'),
    wallTex(),
    [mkFlat('FLATA', 1), mkFlat('FLATB', 2), mkFlat('CLATA', 3), mkFlat('CLATB', 4)]
  );
  const fb = new Framebuffer();

  it('viewpoint A: floor spans hand-computed, ceiling fallthroughs hold, exactly-once', () => {
    resetPlanesForTests();
    frame(w, fb, { x: 128, y: 128, angle: 0 });

    const p0 = findPlane3(F(0), w.world.flatNum('FLATA'), 192);
    expect(p0, 'front floor plane (h 0, FLATA, 192) exists').toBeGreaterThanOrEqual(0);
    expect(planeTop(planeAt(p0), 160)).toBe(152); // yh = 151 = (409600+209920)>>12
    expect(planeBottom(planeAt(p0), 160)).toBe(199); // floorclip(initial 200) − 1

    const p16 = findPlane3(F(16), w.world.flatNum('FLATB'), 160);
    expect(p16, 'back floor plane (h 16, FLATB, 160) exists').toBeGreaterThanOrEqual(0);
    // Marked by B's FAR wall (distance 384, scale 0.41667) through the
    // opening: bottom = boundary floorclip−1 = 151 EXACT, top ≈ 111.
    expect(planeTop(planeAt(p16), 160)).toBeGreaterThanOrEqual(105);
    expect(planeTop(planeAt(p16), 160)).toBeLessThanOrEqual(120);
    expect(planeBottom(planeAt(p16), 160)).toBe(151);

    const p96 = findPlane3(F(96), w.world.flatNum('CLATB'), 160);
    expect(p96, 'back ceiling plane (h 96, CLATB, 160) exists').toBeGreaterThanOrEqual(0);
    expect(planeTop(planeAt(p96), 160)).toBe(0); // negative vanilla top clamped (§ header DEV)
    expect(planeBottom(planeAt(p96), 160)).toBeGreaterThanOrEqual(70);
    expect(planeBottom(planeAt(p96), 160)).toBeLessThanOrEqual(84);

    const p128 = findPlane3(F(128), w.world.flatNum('CLATA'), 192);
    if (p128 >= 0) {
      // Front ceiling line 100 − 87·1.25 < 0 ⇒ nothing marks at col 160.
      expect(planeTop(planeAt(p128), 160)).toBe(0xff);
    }
    assertMarksExactlyOnce('viewA');
    countersZero('viewA');
  });

  it('viewpoint B: boundary seg marks ceiling [0,31] + floor [132,199] at col 160', () => {
    resetPlanesForTests();
    frame(w, fb, { x: 384, y: 128, angle: ANG180 });

    const pc = findPlane3(F(96), w.world.flatNum('CLATB'), 160);
    expect(pc, 'front ceiling plane (h 96, CLATB, 160)').toBeGreaterThanOrEqual(0);
    expect(planeTop(planeAt(pc), 160)).toBe(0);
    expect(planeBottom(planeAt(pc), 160)).toBe(31); // yl = (128000+4095)>>12 = 32

    const p16 = findPlane3(F(16), w.world.flatNum('FLATB'), 160);
    expect(planeTop(planeAt(p16), 160)).toBe(132); // yh = 537600>>12 = 131
    expect(planeBottom(planeAt(p16), 160)).toBe(199);

    // NOTE viewB: the boundary is a transparent two-sided line — the far
    // room's ceiling/floor planes legitimately mark parts of the band
    // (vanilla-correct); the band check is replaced by the exactly-once
    // scan plus the two EXACT authored ranges above.
    assertMarksExactlyOnce('viewB');
    countersZero('viewB');
  });
});

/* ------------------------------------------------------------------ */
/* 2+3. Sky: collapse + guard                                         */
/* ------------------------------------------------------------------ */

describe('M4-04 sky planes (F_SKY1 wiring)', () => {
  const fb = new Framebuffer();

  it('two sky sectors (different height AND light) collapse into ONE plane', () => {
    const spec: RectMapSpec = {
      rooms: [
        { x: 0, y: 0, w: 256, h: 256, ceilingHeight: 128, lightLevel: 192,
          ceilingFlat: 'F_SKY1', floorFlat: 'FLATA' },
        { x: 256, y: 0, w: 256, h: 256, ceilingHeight: 160, lightLevel: 64,
          ceilingFlat: 'F_SKY1', floorFlat: 'FLATB' },
      ],
    };
    const w = world3(
      loadMap(WadFile.parse(buildFixtureMapWad(spec).buffer as ArrayBuffer), 'FIXMAP'),
      wallTex(),
      [mkFlat('FLATA', 1), mkFlat('FLATB', 2), mkSkyFlat()]
    );
    expect(w.world.skyflatnum, 'F_SKY1 resolved').toBeGreaterThanOrEqual(0);
    resetPlanesForTests();
    setSkyflatnum(w.world.skyflatnum); // the production wiring M4-07 repeats
    frame(w, fb, { x: 128, y: 128, angle: 0 });

    const skies: number[] = [];
    for (let p = 0; p < planeCount(); p++) {
      if (planePic(planeAt(p)) === getSkyflatnum()) skies.push(p);
    }
    expect(skies.length, 'ALL sky ceilings (h 128 l 192 + h 160 l 64) merged').toBe(1);
    const sky = planeAt(skies[0]!);
    expect(planeHeight(sky), 'sky collapse height=0').toBe(0);
    expect(planeLight(sky), 'sky collapse light=0').toBe(0);
    let anyMark = false;
    for (let x = 0; x < RENDER_WIDTH; x++) if (planeTop(sky, x) !== 0xff) anyMark = true;
    expect(anyMark, 'the sky plane carries ceiling marks').toBe(true);
    assertMarksExactlyOnce('sky-collapse');
    countersZero('sky-collapse');
  });

  // r_segs.c:672 guard — hand-built single-wall room, ceiling 64, eye 91.
  it('sky ceiling BELOW viewz still marks; the identical non-sky room does not', () => {
    const build = (ceilFlat: string): World3 => {
      const vertices: Vertex[] = [
        { x: 256, y: 0 },  // 0
        { x: 256, y: 256 }, // 1 — v1=1→v2=0 travels SOUTH ⇒ front = WEST
      ];
      const sectors: SectorDef[] = [
        { floorLh: 0, ceilingLh: 64, floorFlat: 'FLATA', ceilingFlat: ceilFlat,
          lightLevel: 192, special: 0, tag: 0 },
      ];
      const sides: SideDef[] = [
        { sector: 0, toptexture: '', midtexture: '', bottomtexture: '', offset: [0, 0], light: 0 },
      ];
      const lines: LineDef[] = [
        { v1: 1, v2: 0, front: 0, back: -1, flags: 0, special: 0, tag: 0 },
      ];
      const segs: Seg[] = [
        { v1: 1, v2: 0, angle: 0xc000, line: 0, side: 0, offset: 0 }, // south = 270°
      ];
      const md: MapData = {
        name: 'SKYFIX', things: new Uint8Array(0), lineDefs: lines, sideDefs: sides,
        vertices, segs, ssectors: [{ numsegs: 1, firstseg: 0 }], nodes: [], sectors,
        reject: new Uint8Array(0), blockmap: new Uint8Array(0),
      };
      return world3(md, new Map(), [mkFlat('FLATA', 1), mkFlat('CLATX', 9), mkSkyFlat()]);
    };
    const skyW = build('F_SKY1');
    const flatW = build('CLATX');

    resetPlanesForTests();
    setSkyflatnum(skyW.world.skyflatnum);
    frame(skyW, fb, { x: 128, y: 128, z: 50, angle: 0 }); // viewz = 91 > 64
    let skyP = -1;
    for (let p = 0; p < planeCount(); p++) {
      if (planePic(planeAt(p)) === getSkyflatnum()) skyP = p;
    }
    expect(skyP, 'sky ceiling below viewz OPENS a plane (bsp §0.4 clause)').toBeGreaterThanOrEqual(0);
    expect(planeTop(planeAt(skyP), 160), 'guard: marked despite ceiling ≤ viewz').toBe(0);
    expect(planeBottom(planeAt(skyP), 160), 'yl = ceil(100 + 27·1.25) = 134').toBe(133);
    assertMarksExactlyOnce('sky-guard');
    countersZero('sky-guard');

    resetPlanesForTests();
    frame(flatW, fb, { x: 128, y: 128, z: 50, angle: 0 });
    let ceilPlanes = 0;
    for (let p = 0; p < planeCount(); p++) if (planeHeight(planeAt(p)) === F(64)) ceilPlanes++;
    expect(ceilPlanes, 'non-sky ceiling at/below viewz opens NO plane').toBe(0);
    assertMarksExactlyOnce('flat-control');
    countersZero('flat-control');
  });
});

/* ------------------------------------------------------------------ */
/* 4. Masked middle — fence + nearer occluder (hand map)              */
/* ------------------------------------------------------------------ */

function fenceWorld(): World3 {
  // Eye (160,128) facing west. Draw order = segs table order (ONE
  // subsector): occluder (x=128, nearer), fence (x=80), far wall (x=0).
  const vertices: Vertex[] = [
    { x: 0, y: 64 },    // 0 far wall v1
    { x: 0, y: 192 },   // 1 far wall v2
    { x: 80, y: 64 },   // 2 fence v1
    { x: 80, y: 192 },  // 3 fence v2
    { x: 128, y: 144 }, // 4 occluder v1
    { x: 128, y: 192 }, // 5 occluder v2
  ];
  const sector: SectorDef = {
    floorLh: 0, ceilingLh: 128, floorFlat: 'FLATA', ceilingFlat: 'CLATA',
    lightLevel: 192, special: 0, tag: 0,
  };
  const sectors: SectorDef[] = [
    { ...sector },
    { floorLh: 0, ceilingLh: 128, floorFlat: 'FLATA', ceilingFlat: 'CLATA',
      lightLevel: 192, special: 0, tag: 0 },
  ];
  const sides: SideDef[] = [
    { sector: 0, toptexture: '', midtexture: 'FIXWALL0', bottomtexture: '', offset: [0, 0], light: 0 }, // far
    { sector: 0, toptexture: '', midtexture: 'FIXWALL1', bottomtexture: '', offset: [0, 0], light: 0 }, // occluder
    { sector: 0, toptexture: '', midtexture: 'FENCE0', bottomtexture: '', offset: [0, 0], light: 0 },  // fence front
    { sector: 1, toptexture: '', midtexture: '', bottomtexture: '', offset: [0, 0], light: 0 },        // fence back
  ];
  const lines: LineDef[] = [
    { v1: 0, v2: 1, front: 0, back: -1, flags: 0, special: 0, tag: 0 },      // far (1-sided)
    { v1: 4, v2: 5, front: 1, back: -1, flags: 0, special: 0, tag: 0 },      // occluder (1-sided)
    { v1: 2, v2: 3, front: 2, back: 3, flags: 0x0004, special: 0, tag: 0 },  // fence (2-sided)
  ];
  const NORTH = 0x4000;
  const segs: Seg[] = [
    { v1: 4, v2: 5, angle: NORTH, line: 1, side: 0, offset: 0 }, // nearer first
    { v1: 2, v2: 3, angle: NORTH, line: 2, side: 0, offset: 0 },
    { v1: 0, v2: 1, angle: NORTH, line: 0, side: 0, offset: 0 },
  ];
  const md: MapData = {
    name: 'FENCEFIX', things: new Uint8Array(0), lineDefs: lines, sideDefs: sides,
    vertices, segs, ssectors: [{ numsegs: 3, firstseg: 0 }], nodes: [], sectors,
    reject: new Uint8Array(0), blockmap: new Uint8Array(0),
  };
  return world3(
    md,
    new Map([
      ['FIXWALL0', mkTex('FIXWALL0', 64, () => 77)],  // far wall — 77
      ['FIXWALL1', mkTex('FIXWALL1', 64, () => 120)], // occluder — 120
      ['FENCE0', mkTex('FENCE0', 64, (_c, r) => (r >= 40 && r < 60 ? 0 : 200))], // holes 40-59
    ])
  );
}

describe('M4-04 masked middles (fence + nearer occluder)', () => {
  const w = fenceWorld();
  const fb = new Framebuffer();

  // Locate the fence drawseg (side 2, masked) + the occluder one (side 1).
  function drawsegIds(): { fence: number; occl: number } {
    const d = getDrawsegs();
    let fence = -1;
    let occl = -1;
    for (let i = 0; i < drawsegCount(); i++) {
      const side = w.world.segSide[d.seg[i]!]!;
      if (side === 2 && d.maskedcol[i] !== CLIP_NULL) fence = i; // ref may be NEGATIVE (signed pool diff)
      if (side === 1) occl = i;
    }
    return { fence, occl };
  }

  it('draws ONLY fence pixels: holes transparent to the earlier buffer, nothing above/below', () => {
    resetPlanesForTests();
    frame(w, fb, { x: 160, y: 128, angle: ANG180 });
    drawMasked();

    // Centre column 160 (fence perpendicular distance 80 ⇒ scale 2.0;
    // texel r ⇒ row −74 + 2r; far wall rows 13..141 at scale 1.0).
    expect(px(fb, 160, 3), 'texel run 0-39 ⇒ fence 200').toBe(200);
    expect(px(fb, 160, 7), 'hole above the far wall ⇒ untouched 0').toBe(0);
    expect(px(fb, 160, 25), 'hole ⇒ far wall 77 shows THROUGH the fence').toBe(77);
    expect(px(fb, 160, 100), 'texel run 60-127 ⇒ fence 200').toBe(200);
    expect(px(fb, 160, 150), 'fence past the far wall bottom still 200').toBe(200);
    expect(px(fb, 160, 185), 'below the texture (row 181 end): nothing').toBe(0);
    expect(px(fb, 160, 199)).toBe(0);
    // First non-fence row from the top = the hole band start (row 6):
    let firstNon = -1;
    for (let r = 0; r < 199; r++) if (px(fb, 160, r) !== 200) { firstNon = r; break; }
    expect(firstNon, 'fence texture is unbroken up to the hole band').toBeGreaterThanOrEqual(5);
    expect(firstNon).toBeLessThanOrEqual(7);
  });

  it('nearer occluder removes exactly its span; consumed entries reset to MAXSHORT', () => {
    resetPlanesForTests();
    frame(w, fb, { x: 160, y: 128, angle: ANG180 });

    const { fence, occl } = drawsegIds();
    expect(fence, 'fence drawseg recorded').toBeGreaterThanOrEqual(0);
    expect(occl, 'occluder drawseg recorded').toBeGreaterThanOrEqual(0);
    const d = getDrawsegs();

    // The occluder's SOLID fragment and the fence's pass fragment meet at
    // one column: the occluder removed EXACTLY its span from the fence.
    expect(
      d.x2[fence]! + 1 === d.x1[occl]! || d.x2[occl]! + 1 === d.x1[fence]!,
      `adjacent fragments (fence [${d.x1[fence]}..${d.x2[fence]}], occluder [${d.x1[occl]}..${d.x2[occl]}])`
    ).toBe(true);
    expect(d.x1[fence]!).toBeLessThan(160);
    expect(d.x2[fence]!).toBeGreaterThan(160);

    // Opening snapshot at the clear centre column: fully OPEN (no
    // silhouettes: identical sectors + forced-masked ±sentinels).
    expect(clipValue(d.sprtopclip[fence]!, 160, VIEWHEIGHT)).toBe(-1);
    expect(clipValue(d.sprbottomclip[fence]!, 160, VIEWHEIGHT)).toBe(VIEWHEIGHT);

    drawMasked();

    // Not one fence pixel (200) inside the occluder's columns...
    for (let x = d.x1[occl]!; x <= d.x2[occl]!; x++) {
      for (let r = 0; r < VIEWHEIGHT; r++) {
        expect(px(fb, x, r), `col ${x} row ${r} in the occluder span`).not.toBe(200);
      }
    }
    // ...and outside the fence projection entirely: column 300.
    for (let r = 0; r < VIEWHEIGHT; r++) expect(px(fb, 300, r)).not.toBe(200);

    for (let x = d.x1[fence]!; x <= d.x2[fence]!; x++) {
      expect(maskedTexturecol(fence, x), `maskedtexturecol[${x}]`).toBe(0x7fff);
    }
    countersZero('masked');
  });

  it('drawMasked is idempotent — second call draws nothing (all MAXSHORT)', () => {
    resetPlanesForTests();
    frame(w, fb, { x: 160, y: 128, angle: ANG180 });
    drawMasked();
    const first = fb.indices.slice();
    drawMasked();
    expect(fb.indices).toEqual(first);
  });

  it('unconfigured masked pass keeps the M3 no-op semantics (goldens stable)', () => {
    configureMaskedPass(null);
    resetPlanesForTests();
    const before = fb.indices.slice();
    frame(w, fb, { x: 160, y: 128, angle: ANG180 }); // frame() configures...
    const mid = fb.indices.slice();
    configureMaskedPass(null); // ...this call un-configures BEFORE drawMasked
    expect(() => drawMasked()).not.toThrow();
    expect(fb.indices).toEqual(mid);
    void before;
  });
});
