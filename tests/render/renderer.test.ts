/**
 * M9-09 — renderer D_Display composition + windowed view + live-mobj
 * sprite pass (plan §M9-09 acceptance 2/3/4).
 *
 *  a1 is pinned in src/render/view.test.ts (the viewheight table).
 *  a2: HOM=0 + no-single-color at 4 sampled E1M1 viewpoints, screenblocks
 *      9 WITH the status bar composited (L3-style frame assertions; the
 *      committed PNG corpus belongs to M9-11 — hashes here are the
 *      determinism pin).
 *  a3: monsters render + clip: fixture maps prove visible/occluded/
 *      clipped sprite pixels AND the live-mobj overlay (D018 flip)
 *      SUPERSEDES the static census — never double-draws.
 *  a4: hom == 0 across the screenblocks sweep {11,10,9,6,3}.
 *
 * Borders (borders.ts) are exercised here too: fillBackScreen needs the
 * real FLOOR7_2/brdr_* lumps ⇒ the back-screen CONTENT assertions ride
 * the IWAD skipIf; the gate + erase geometry run on synthetic layers.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { decodeColormap } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import type { TextureDef } from '../../src/wad/types';
import { buildPatchFromColumns } from '../../src/wad/patch';
import { sprnames } from '../../src/wad/info/sprnames';
import { MF } from '../../src/wad/info/mobjinfo';
import { buildMapLumps, type RectMapSpec } from '../fixtures/mapBuilder';
import { WadBuilder } from '../fixtures/wadWriter';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import {
  GS_DEMOSCREEN,
  GS_FINALE,
  GS_INTERMISSION,
  GS_LEVEL,
  buildMapSprites,
  displayFrame,
  displayStubHits,
  registerDisplayHooks,
  renderFrame,
  resetDisplayHooks,
  resetDisplayStatics,
  resetDisplayStubHits,
  type DisplayState,
  type SpriteTables,
} from '../../src/render/renderer';
import { buildRenderMapView, executeSetViewSize, setViewSize } from '../../src/render/view';
import {
  borderStats,
  drawViewBorder,
  fillBackScreen,
  resetBorderStats,
} from '../../src/render/borders';
import { lumpPatch, screens, vInit, vVideoStats } from '../../src/render/vvideo';
import { stDrawer, stInit, stRefreshBackground, stStart, stStop } from '../../src/ui/statusbar';
import type { LiveMobjView } from '../../src/render/rthings';
import type { RenderWorld } from '../../src/render/rdata';
import type { LightTables } from '../../src/render/lights';
import type { RenderMapView } from '../../src/render/view';
import { degToBam, synthColormapRows } from './viewpoints';

/* ------------------------------------------------------------------ */
/* Wad discovery                                                       */
/* ------------------------------------------------------------------ */

const WAD_PATH = [
  process.env['DOOM_WAD'],
  process.env['FREEDOOM1_WAD'],
  fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url)),
].find((p): p is string => p !== undefined && existsSync(p));
const hasWad = WAD_PATH !== undefined;

function iwad(): WadFile {
  const b = readFileSync(WAD_PATH!);
  return WadFile.parse(
    b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer,
  );
}

function toBuf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/* ------------------------------------------------------------------ */
/* FIXMAP boot (mapBuilder + a solid-index monster roster)             */
/* ------------------------------------------------------------------ */

const MON_INDEX = 199; // plate index (fixture walls live in 32..231 — see
// fixTexValue; the identity colormap row keeps it exact)

function solidPatch(w: number, h: number, index: number): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < w; c++) cols.push(new Array<number>(h).fill(index));
  return buildPatchFromColumns(cols, w >> 1, h - 1);
}

function mapWad(spec: RectMapSpec, monsterRoster: readonly string[]): WadFile {
  const wb = new WadBuilder('IWAD');
  wb.addLumpMarker('S_START');
  for (const n of monsterRoster) wb.addLump(n, solidPatch(24, 56, MON_INDEX));
  wb.addLumpMarker('S_END');
  wb.addLumpMarker('FIXMAP');
  for (const lump of buildMapLumps(spec)) wb.addLump(lump.name, lump.data);
  return WadFile.parse(toBuf(wb.build()));
}

interface Fx {
  wad: WadFile;
  world: RenderWorld;
  view: RenderMapView;
  tables: LightTables;
  sprites: SpriteTables;
}

function fixture(spec: RectMapSpec, monsterRoster: readonly string[]): Fx {
  const wad = mapWad(spec, monsterRoster);
  const md = loadMap(wad, 'FIXMAP');
  const view = buildRenderMapView(md);
  const columns: Uint8Array[] = [];
  for (let c = 0; c < 64; c++) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r++) col[r] = ((c * 16 + r) % 200) + 32;
    columns.push(col);
  }
  const textures = new Map<string, TextureDef>([
    ['FIXWALL0', { name: 'FIXWALL0', width: 64, height: 128, patches: [], columns }],
  ]);
  return {
    wad,
    world: loadRenderWorld(md, textures),
    view,
    tables: initLightTables(synthColormapRows()),
    sprites: buildMapSprites({ md, map: view, wad }),
  };
}

/* ------------------------------------------------------------------ */
/* Pixel helpers + display-state factory                               */
/* ------------------------------------------------------------------ */

function distinctIndices(fb: Framebuffer, from = 0, to = 320 * 200): number {
  const seen = new Uint8Array(256);
  let n = 0;
  for (let i = from; i < to; i++) {
    const v = fb.indices[i]!;
    if (seen[v] === 0) {
      seen[v] = 1;
      n += 1;
    }
  }
  return n;
}

function distinctSlice(data: Uint8Array, from: number, to: number): number {
  const seen = new Set<number>();
  for (let i = from; i < to; i++) seen.add(data[i]!);
  return seen.size;
}

function sha(fb: Framebuffer): string {
  return createHash('sha256').update(fb.indices).digest('hex');
}

const displayState = (over: Partial<DisplayState> = {}): DisplayState => ({
  gamestate: GS_LEVEL,
  gametic: 1,
  automapactive: false,
  viewactive: true,
  paused: false,
  ...over,
});

const playerAt = (x: number, y: number, deg: number) => ({
  mo: { x: (x * FRACUNIT) | 0, y: (y * FRACUNIT) | 0, angle: degToBam(deg) },
});

beforeEach(() => {
  resetDisplayHooks();
  resetDisplayStatics();
  resetDisplayStubHits();
  resetBorderStats();
});

/* ================================================================== */
/* 1. displayFrame composition order + state switch (no WAD needed)    */
/* ================================================================== */

describe('displayFrame — D_Display order + state switch (d_main.c:193-330)', () => {
  const spec: RectMapSpec = {
    rooms: [{ x: 0, y: 0, w: 256, h: 256, ceilingHeight: 128, lightLevel: 192 }],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }],
  };
  const fx = fixture(spec, []);

  const depsFor = (state: DisplayState, fb = new Framebuffer()) => ({
    fb,
    world: fx.world,
    map: fx.view,
    player: playerAt(64, 64, 0),
    tables: fx.tables,
    sprites: fx.sprites,
    state,
  });

  it('GS_LEVEL: hooks run st → hu → menu; viewheight 200 ⇒ fullscreen flag', () => {
    const order: string[] = [];
    let barFullscreen: boolean | undefined;
    registerDisplayHooks({
      stDrawer: (fullscreen) => {
        order.push('st');
        barFullscreen = fullscreen;
      },
      huDrawer: () => order.push('hu'),
      mDrawer: () => order.push('menu'),
    });
    setViewSize(11, 0);
    executeSetViewSize();
    const r = displayFrame(depsFor(displayState()));
    expect(r.counters, 'the 3D pass ran').toBeDefined();
    expect(barFullscreen).toBe(true);
    expect(order).toEqual(['st', 'hu', 'menu']); // M_Drawer LAST (:327)
  });

  it('per-state drawers route exactly once; unregistered drawers are stubs', () => {
    const seen: string[] = [];
    registerDisplayHooks({ wiDrawer: () => seen.push('wi') });
    displayFrame(depsFor(displayState({ gamestate: GS_INTERMISSION })));
    displayFrame(depsFor(displayState({ gamestate: GS_FINALE })));
    displayFrame(depsFor(displayState({ gamestate: GS_DEMOSCREEN })));
    expect(seen, 'one wiDrawer call per intermission frame').toEqual(['wi']);
    expect(displayStubHits.byName.get('finaleDrawer')).toBe(1);
    expect(displayStubHits.byName.get('pageDrawer')).toBe(1);
    const r = displayFrame(depsFor(displayState({ gamestate: GS_INTERMISSION })));
    expect(seen).toEqual(['wi', 'wi']);
    expect(r.counters, 'no 3D pass outside GS_LEVEL').toBeUndefined();
  });

  it('paused stamps M_PAUSE at viewwindowx+(w-68)/2, viewwindowy+4 (:310)', () => {
    const spots: [number, number][] = [];
    registerDisplayHooks({ pausedPatch: (x, y) => spots.push([x, y]) });
    setViewSize(9, 0);
    executeSetViewSize();
    displayFrame(depsFor(displayState({ paused: true })));
    expect(spots).toEqual([[16 + (288 - 68) / 2, 12 + 4]]);
    setViewSize(11, 0);
    executeSetViewSize();
  });

  it('gametic 0 draws no 3D/HU/ST (vanilla `if (!gametic) break`)', () => {
    let calls = 0;
    registerDisplayHooks({ stDrawer: () => calls++, huDrawer: () => calls++ });
    const r = displayFrame(depsFor(displayState({ gametic: 0 })));
    expect(r.counters).toBeUndefined();
    expect(calls).toBe(0);
  });
});

/* ================================================================== */
/* 2. borders.ts — gate + erase geometry (synthetic back screen)       */
/* ================================================================== */

describe('borders — R_FillBackScreen/R_DrawViewBorder (r_draw.c:731-880)', () => {
  beforeEach(() => {
    vInit(new Uint8Array(320 * 200));
  });

  it('fullscreen (sb11): drawViewBorder is a NO-OP (:839 early return)', () => {
    setViewSize(11, 0);
    executeSetViewSize();
    drawViewBorder();
    expect(borderStats.drawViewBorder).toBe(0);
    expect(borderStats.videoEraseBytes).toBe(0);
    setViewSize(9, 0);
    executeSetViewSize();
  });

  it('sb9: the three R_VideoErase blocks cover exactly the border area', () => {
    setViewSize(9, 0);
    executeSetViewSize();
    const back = screens[1]!;
    for (let y = 0; y < 200; y++) back.data.fill(y & 1 ? 77 : 88, y * 320, (y + 1) * 320);
    const fg = screens[0]!;
    fg.data.fill(0);
    drawViewBorder();
    // top(+side) + bottom(+side) blocks + 2*side per interior row
    const expected = (12 * 320 + 16) * 2 + 2 * 16 * (144 - 1);
    expect(borderStats.videoEraseBytes).toBe(expected);
    expect(vVideoStats.markRectCalls).toBe(1); // the "?" V_MarkRect
    expect(fg.data[0]).toBe(88); // row 0 (even) copied
    expect(fg.data[13 * 320 + 0]).toBe(77); // window row 13, left strip (odd)
    expect(fg.data[13 * 320 + 200]).toBe(0); // INSIDE the window: untouched
    expect(fg.data[170 * 320 + 100]).toBe(0); // bar rows NOT erased (ST owns them)
  });
});

/* ================================================================== */
/* 3. Monsters render + clip (acceptance 3) — FIXMAP, no WAD needed    */
/* ================================================================== */

describe('monsters render + clip (D018 flip + M4 rotation/clipping)', () => {
  const ROSTER = ['TROOA0'];

  const OPEN_SPEC: RectMapSpec = {
    rooms: [{ x: 0, y: 0, w: 704, h: 256, ceilingHeight: 128, lightLevel: 192 }],
    things: [
      { x: 64, y: 128, angle: 0, type: 1 },
      { x: 512, y: 128, angle: 0, type: 3001 }, // MT_TROOP (KIND_MONSTER)
    ],
  };
  // Sealed-room occlusion: the bottom-right room shares its ENTIRE y=128
  // edge with the corridor (solid) — nothing sees through.
  const SEALED_SPEC: RectMapSpec = {
    rooms: [
      { x: 0, y: 0, w: 704, h: 128, ceilingHeight: 128, lightLevel: 192 },
      { x: 448, y: 128, w: 256, h: 128, ceilingHeight: 128, lightLevel: 192 },
    ],
    things: [
      { x: 128, y: 64, angle: 0, type: 1 },
      { x: 600, y: 64, angle: 0, type: 3001 }, // corridor: visible
      { x: 600, y: 192, angle: 0, type: 3001 }, // sealed room: occluded
    ],
  };
  const CORRIDOR_ONLY_SPEC: RectMapSpec = {
    rooms: SEALED_SPEC.rooms,
    things: [SEALED_SPEC.things![0]!, { x: 600, y: 64, angle: 0, type: 3001 }],
  };
  // Head clip: crawl-space ceiling 40 over the sight line — the plate
  // spans z 0..56, so everything above 40 must clip (upper wall).
  const CRAWL_SPEC: RectMapSpec = {
    rooms: [
      { x: 0, y: 0, w: 352, h: 256, ceilingHeight: 48, lightLevel: 192 },
      { x: 352, y: 0, w: 352, h: 256, ceilingHeight: 128, lightLevel: 192 },
    ],
    things: [
      { x: 128, y: 128, angle: 0, type: 1 },
      { x: 560, y: 128, angle: 0, type: 3001 },
    ],
  };
  const OPEN128_SPEC: RectMapSpec = {
    rooms: [{ x: 0, y: 0, w: 704, h: 256, ceilingHeight: 128, lightLevel: 192 }],
    things: [
      { x: 128, y: 128, angle: 0, type: 1 },
      { x: 560, y: 128, angle: 0, type: 3001 },
    ],
  };

  function renderFx(
    fx: Fx,
    px: number,
    py: number,
    deg: number,
    mobjs?: Iterable<LiveMobjView>,
  ): Framebuffer {
    const fb = new Framebuffer();
    const c = renderFrame({
      fb,
      world: fx.world,
      map: fx.view,
      player: playerAt(px, py, deg),
      tables: fx.tables,
      sprites: fx.sprites,
      ...(mobjs === undefined ? {} : { mobjs }),
    });
    expect(c.hom, 'hom stays 0 with monsters drawn').toBe(0);
    return fb;
  }

  /** Pixels the monster plate CHANGED vs an empty-map frame (index-agnostic
   * oracle: spritelights run through the synthetic colormap rows, so the
   * drawn index is a function of light, not the plate constant). */
  function diffCount(a: Framebuffer, b: Framebuffer): number {
    let n = 0;
    for (let i = 0; i < a.indices.length; i++) if (a.indices[i] !== b.indices[i]) n += 1;
    return n;
  }

  /** Fixture identical to `spec` minus every type-3001 thing (the
   * monster-free baseline frame). */
  function emptyTwin(spec: RectMapSpec): Fx {
    return fixture(
      {
        rooms: spec.rooms,
        things: (spec.things ?? []).filter((t) => t.type !== 3001),
      },
      ROSTER,
    );
  }

  it('static mode: KIND_MONSTER THINGS draw (spawnstate frame)', () => {
    const fx = fixture(OPEN_SPEC, ROSTER);
    expect(fx.sprites.things.skipped.monster, 'no monster rows skipped any more').toBe(0);
    const fb = renderFx(fx, 64, 128, 0);
    const empty = renderFx(emptyTwin(OPEN_SPEC), 64, 128, 0);
    expect(diffCount(fb, empty), 'monster pixels').toBeGreaterThan(100);
  });

  it('full occlusion: the sealed-room monster contributes ZERO pixels', () => {
    const sealed = renderFx(fixture(SEALED_SPEC, ROSTER), 128, 64, 0);
    const only = renderFx(fixture(CORRIDOR_ONLY_SPEC, ROSTER), 128, 64, 0);
    const empty = renderFx(emptyTwin(SEALED_SPEC), 128, 64, 0);
    expect(diffCount(only, empty), 'the corridor monster is drawn').toBeGreaterThan(100);
    expect(sha(sealed), 'occluded monster adds nothing').toBe(sha(only));
  });

  it('sprite clipping: a 40-high ceiling cuts the plate at its z=40 line', () => {
    const empty = renderFx(emptyTwin(OPEN128_SPEC), 128, 128, 0);
    const open = renderFx(fixture(OPEN128_SPEC, ROSTER), 128, 128, 0);
    const clipped = renderFx(fixture(CRAWL_SPEC, ROSTER), 128, 128, 0);
    const emptyCrawl = renderFx(emptyTwin(CRAWL_SPEC), 128, 128, 0);
    const openCount = diffCount(open, empty);
    const clipCount = diffCount(clipped, emptyCrawl);
    expect(openCount, 'open room: full plate').toBeGreaterThan(150);
    expect(clipCount, 'crawl space: SOMETHING still draws').toBeGreaterThan(0);
    expect(clipCount, 'head section MUST be clipped').toBeLessThan(openCount);
  });

  it('live overlay SUPERSEDES the census (D018: no double-draw) + filters', () => {
    const live = (over: Partial<LiveMobjView> = {}): LiveMobjView => ({
      x: (256 * FRACUNIT) | 0,
      y: (128 * FRACUNIT) | 0,
      z: 0,
      angle: 0,
      sprite: sprnames.indexOf('TROO'),
      frame: 0,
      flags: MF.MF_SOLID | MF.MF_COUNTKILL,
      ...over,
    });
    // Map WITH a static monster at (512,128) + live mobj at (256,128):
    const withStatic = fixture(OPEN_SPEC, ROSTER);
    // The SAME map with the monster THING removed:
    const noStatic = fixture(
      { rooms: OPEN_SPEC.rooms, things: [{ x: 64, y: 128, angle: 0, type: 1 }] },
      ROSTER,
    );
    const roster = [
      live(),
      live({ removed: true }), // skipped
      live({ playerRef: {} }), // skipped
      live({ flags: MF.MF_NOSECTOR }), // skipped
      live({ sprite: sprnames.indexOf('BSHE') }), // no lumps ⇒ skipped
    ];
    const a = renderFx(withStatic, 64, 128, 0, roster);
    const b = renderFx(noStatic, 64, 128, 0, roster);
    const empty = renderFx(noStatic, 64, 128, 0);
    expect(diffCount(a, empty), 'the live monster draws').toBeGreaterThan(200);
    expect(sha(a), 'census monster rows are SUPERSEDED, never merged').toBe(sha(b));
  });

  it('live monster Z rides the mobj z (flyers float over the floor)', () => {
    const fx = fixture(
      { rooms: OPEN_SPEC.rooms, things: [{ x: 64, y: 128, angle: 0, type: 1 }] },
      ROSTER,
    );
    const ground = renderFx(fx, 64, 128, 0, [
      { x: 512 * FRACUNIT, y: 128 * FRACUNIT, z: 0, angle: 0, sprite: sprnames.indexOf('TROO'), frame: 0, flags: MF.MF_SOLID },
    ]);
    const flying = renderFx(fx, 64, 128, 0, [
      { x: 512 * FRACUNIT, y: 128 * FRACUNIT, z: 64 * FRACUNIT, angle: 0, sprite: sprnames.indexOf('TROO'), frame: 0, flags: MF.MF_SOLID | MF.MF_NOGRAVITY },
    ]);
    expect(sha(ground)).not.toBe(sha(flying));
  });
});

/* ================================================================== */
/* 4. E1M1 (skipIf): sb sweep hom==0 (a4) + 4 viewpoints w/ bar (a2)   */
/* ================================================================== */

describe.skipIf(!hasWad)('E1M1 windowed composition — sb sweep + statusbar (a2/a4)', () => {
  const wad = iwad();
  const md = loadMap(wad, 'E1M1');
  const view = buildRenderMapView(md);
  const world = loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad));
  const tables = initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')));
  const sprites = buildMapSprites({ md, map: view, wad });

  vInit(new Uint8Array(320 * 200)); // ST_Init needs screens[4]
  stInit(wad);

  const fakePlayer = {
    health: 100,
    bonuscount: 0,
    damagecount: 0,
    readyweapon: 1,
    attackdown: false,
    cheats: 0,
    powers: new Array<number>(8).fill(0),
    ammo: [0, 0, 0, 0] as number[],
    maxammo: [10, 50, 300, 500] as number[],
    weaponowned: [1, 1, 0, 0, 0, 0, 0, 0] as number[],
    cards: [0, 0, 0, 0, 0, 0] as number[],
    armorpoints: 0,
    frags: new Array<number>(4).fill(0),
    mo: { x: 0, y: 0, angle: 0 },
    attacker: null,
  };

  const VIEWPOINTS4 = [
    { name: 'spawn-east', x: -416, y: 256, deg: 0 },
    { name: 'busy-mix', x: 2400, y: 1152, deg: 180 },
    { name: 'atrium', x: 1472, y: 1088, deg: 270 },
    { name: 'vista-corridor', x: 960, y: -192, deg: 0 },
  ] as const;

  const depsFor = (vp: { x: number; y: number; deg: number }, fb: Framebuffer) => ({
    fb,
    world,
    map: view,
    player: playerAt(vp.x, vp.y, vp.deg),
    tables,
    sprites,
    state: displayState(),
    borders: { wad },
  });

  afterEach(() => {
    setViewSize(9, 0);
    executeSetViewSize();
  });

  it('acceptance 4: hom == 0 across the screenblocks sweep {11,10,9,6,3}', () => {
    for (const sb of [11, 10, 9, 6, 3]) {
      setViewSize(sb, 0);
      executeSetViewSize();
      for (const vp of VIEWPOINTS4) {
        resetDisplayStatics();
        const r = displayFrame(depsFor(vp, new Framebuffer()));
        expect(r.counters!.hom, `sb${sb} ${vp.name}: hom`).toBe(0);
        expect(r.counters!.visspriteOverflow, `sb${sb} ${vp.name}: vissprites`).toBe(0);
      }
    }
  });

  it('acceptance 2: sb9 + statusbar — hom 0, no single color, bar composited, deterministic', () => {
    setViewSize(9, 0);
    executeSetViewSize();
    const stCtx = { rng: { rndindex: 0, prndindex: 0 }, player: fakePlayer };
    // REORDER CONTRACT (renderer.ts DisplayHooks.stDrawer): the 3D pass
    // dirties the bar rows, so the wiring restores BG→FG every windowed
    // frame — exactly vanilla's ST_refreshBackground copy, WITHOUT the
    // refresh flag (widget diff/erase semantics stay vanilla-faithful).
    registerDisplayHooks({
      stDrawer: (fullscreen, refresh) => {
        if (!fullscreen) stRefreshBackground(stCtx);
        stDrawer(stCtx, fullscreen, refresh);
      },
    });
    for (const vp of VIEWPOINTS4) {
      const fbA = new Framebuffer();
      const fbB = new Framebuffer();
      resetDisplayStatics();
      stStart(stCtx); // fresh widget oldvals (the ST_Start of a level load)
      const rA = displayFrame(depsFor(vp, fbA));
      resetDisplayStatics();
      stStart(stCtx);
      displayFrame(depsFor(vp, fbB));
      expect(rA.counters!.hom, `${vp.name}: hom`).toBe(0);
      expect(sha(fbA), `${vp.name}: determinism`).toBe(sha(fbB));
      expect(distinctIndices(fbA), `${vp.name}: no single-color frame`).toBeGreaterThan(4);
      expect(
        distinctIndices(fbA, 168 * 320, 200 * 320),
        `${vp.name}: statusbar region must carry STBAR art`,
      ).toBeGreaterThan(2);
      expect(borderStats.fillBackScreen, `${vp.name}: back screen filled`).toBeGreaterThan(0);
    }
    stStop();
  });

  it('fillBackScreen stamps FLOOR7_2 + the brdr_* frame (r_draw.c:731-830)', () => {
    setViewSize(9, 0);
    executeSetViewSize();
    vInit(new Uint8Array(320 * 200));
    fillBackScreen(wad);
    const back = screens[1]!;
    let stamp = 0;
    for (let y = 4; y < 12; y++) {
      for (let x = 8; x < 16; x++) if (back.data[y * 320 + x]! !== 0) stamp += 1;
    }
    expect(stamp, 'brdr_tl pixels in the back screen').toBeGreaterThan(0);
    expect(distinctSlice(back.data, 100 * 320, 100 * 320 + 16), 'FLOOR7_2 tiling').toBeGreaterThan(1);
    expect(() => lumpPatch(wad, 'brdr_tl')).not.toThrow();
  });

  it('the sb9 window shows the 3D view, NOT the back screen (crop blit ran)', () => {
    setViewSize(9, 0);
    executeSetViewSize();
    vInit(new Uint8Array(320 * 200));
    fillBackScreen(wad);
    const fb = new Framebuffer();
    const r = displayFrame(depsFor(VIEWPOINTS4[1], fb));
    expect(r.counters!.hom).toBe(0);
    // window interior column 160 row 84 (horizon center) must be scene
    // content; the margin at column 4 is border/back-screen territory.
    const mid = fb.indices[84 * 320 + 160]!;
    const margin = fb.indices[84 * 320 + 4]!;
    expect(mid, 'window center shows the 3D pass').not.toBe(0);
    expect(margin === screens[1]!.data[84 * 320 + 4]!, 'margin == back screen').toBe(true);
  });
});
