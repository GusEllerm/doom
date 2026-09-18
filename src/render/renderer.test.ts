/**
 * render/renderer.test.ts — M3-07 frame pipeline (headless, no DOM).
 *
 *  1. FIXMAP end-to-end: buildFixtureMapWad → loadMap → loadRenderWorld +
 *     buildRenderMapView → renderFrame ×2 ⇒ BYTE-IDENTICAL index buffers
 *     (determinism, M3-plan L3) and hom == 0 / drawsegOverflow == 0.
 *  2. Pixel bands: the closed fixture room paints a healthy wall band
 *     (well above a mere sliver, strictly below "everything" — floors and
 *     ceilings stay black, deviation D) with a multi-color histogram
 *     (texture + light variation, not a flat fill).
 *  3. Automap-over-3D composition (§4.1.9): with the automap state active
 *     the drawer's pixels land in the buffer (WALLCOLORS-family wall reds
 *     + the WHITE player arrow); with it inactive they never appear.
 *
 * Inputs are plain structural literals (render-zone rule — the render zone
 * never imports sim/**; sim-compatibility is typechecked at main.ts).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { ANG90, FRACUNIT } from '../core/constants';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import type { TextureDef } from '../wad/types';

import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';

import { drawAutomap, WALLCOLORS, WHITE, type AutomapGeom, type AutomapMap } from './automap';
import { Framebuffer } from './framebuffer';
import { loadRenderWorld, type RenderWorld } from './rdata';
import { getRenderCounters, renderFrame, type FramePlayer } from './renderer';
import { buildRenderMapView, type RenderMapView } from './view';

/* ------------------------------------------------------------------ */
/* FIXMAP fixture (bsp.test.ts M3-02 texture pattern)                   */
/* ------------------------------------------------------------------ */

const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 }, // A (light 192) — viewpoint room
    { x: 256, y: 0, w: 256, h: 256, ceilingHeight: 112, lightLevel: 128 }, // B
  ],
  doors: [{ x1: 256, y1: 96, x2: 256, y2: 160 }],
};

function mkTexture(name: string, fn: (c: number, r: number) => number): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < 64; c += 1) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r += 1) col[r] = fn(c, r);
    columns.push(col);
  }
  return { name, width: 64, height: 128, patches: [], columns };
}

/** Overlay-composition fixture texture: indices stay in 1..40 so the
 * automap-only colors (WALLCOLORS 176..191, WHITE 209) can NEVER come from
 * the walls pass — their presence proves the overlay drew. */
const LOWRANGE = (c: number, r: number): number => ((c * 5 + r * 11) % 40) + 1;

interface Fix {
  readonly fb: Framebuffer;
  readonly world: RenderWorld;
  readonly view: RenderMapView;
}

function fixture(tex: (c: number, r: number) => number = (c, r) => ((c * 7 + r * 3) % 255) + 1): Fix {
  const bytes = buildFixtureMapWad(SPEC);
  const wad = WadFile.parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const md = loadMap(wad, 'FIXMAP');
  const textures = new Map<string, TextureDef>([
    ['FIXWALL0', mkTexture('FIXWALL0', tex)], // opaque by construction
    ['DOORFIX0', mkTexture('DOORFIX0', tex)],
  ]);
  return {
    fb: new Framebuffer(),
    world: loadRenderWorld(md, textures),
    view: buildRenderMapView(md),
  };
}

/** Room A centre, facing north at the y=256 wall (floor 0, eye 41). */
function centerPlayer(): FramePlayer {
  return {
    mo: {
      x: (128 * FRACUNIT) | 0,
      y: (128 * FRACUNIT) | 0,
      z: 0,
      angle: ANG90 >>> 0,
    },
  };
}

function histogram(fb: Framebuffer): Map<number, number> {
  const h = new Map<number, number>();
  for (let i = 0; i < fb.indices.length; i++) {
    const v = fb.indices[i]!;
    h.set(v, (h.get(v) ?? 0) + 1);
  }
  return h;
}

const countWhere = (fb: Framebuffer, pred: (v: number) => boolean): number => {
  let n = 0;
  for (let i = 0; i < fb.indices.length; i++) if (pred(fb.indices[i]!)) n++;
  return n;
};

/* ------------------------------------------------------------------ */
/* 1 + 2: walls pipeline — determinism, counters, pixel bands           */
/* ------------------------------------------------------------------ */

describe('renderFrame (M3-07): FIXMAP walls pipeline', () => {
  it('renders twice BYTE-IDENTICAL with hom == 0 and healthy pixel bands', () => {
    const fix = fixture();
    const player = centerPlayer();
    const deps = { fb: fix.fb, world: fix.world, map: fix.view, player };

    const counters1 = renderFrame(deps);
    const first = fbCopy(fix.fb);
    const counters2 = renderFrame(deps);
    const second = fbCopy(fix.fb);

    // Determinism (acceptance 5 / L3): identical bytes across renders.
    expect(Array.from(first)).toEqual(Array.from(second));

    // Hom-free: both the return value and the live counter are clean.
    expect(counters1).toEqual({ hom: 0, drawsegOverflow: 0, solidsegDrops: 0 });
    expect(counters2.hom).toBe(0);
    expect(getRenderCounters().hom).toBe(0);

    // Pixel bands: the enclosed room is fully boxed in by VOID-facing
    // boundary lines (floor+ceiling change ⇒ upper/lower bands cover every
    // column — mapBuilder fixture semantics), so the walls pass paints the
    // overwhelming majority of the frame; require > 50 % non-black AND a
    // rich multi-value histogram (texture + light variation, not a flat
    // fill). True floor/ceiling FLATS stay black (deviation D — M4).
    const hist = histogram(fix.fb);
    const black = hist.get(0) ?? 0;
    const nonBlack = fix.fb.indices.length - black;
    expect(nonBlack).toBeGreaterThan(32000);
    expect(nonBlack).toBeLessThanOrEqual(64000);
    let distinct = 0;
    for (const [value, n] of hist) if (value !== 0 && n >= 50) distinct++;
    expect(distinct).toBeGreaterThan(10); // textured + lit, not a flat fill
  });
});

function fbCopy(fb: Framebuffer): Uint8Array {
  return new Uint8Array(fb.indices);
}

/* ------------------------------------------------------------------ */
/* 3: automap overlay composition (§4.1.9)                              */
/* ------------------------------------------------------------------ */

/** Hand-built read-view map (render-zone literals, automap.test.ts shape):
 * a mapped 256×256 box + one one-sided interior line. */
function automapBox(): AutomapMap {
  const v = (units: number): number => (units * FRACUNIT) | 0;
  return {
    verticesX: new Int32Array([v(0), v(256), v(256), v(0)]),
    verticesY: new Int32Array([v(0), v(0), v(256), v(256)]),
    blockmapOriginX: 0,
    blockmapOriginY: 0,
    lines: {
      count: 4,
      v1: new Int32Array([0, 1, 2, 3]),
      v2: new Int32Array([1, 2, 3, 0]),
      flags: new Int32Array([256, 256, 256, 256]), // ML_MAPPED
      special: new Int32Array([0, 0, 0, 0]),
      sectorFront: new Int32Array([0, 0, 0, 0]),
      sectorBack: new Int32Array([-1, -1, -1, -1]), // one-sided ⇒ drawn
    },
    sectors: {
      floorHeight: new Int32Array([0]),
      ceilingHeight: new Int32Array([v(128)]),
    },
  };
}

function automapGeom(automapactive: boolean): AutomapGeom {
  return {
    automapactive,
    grid: 0,
    cheating: 0,
    lightlev: 0,
    followplayer: 0,
    fX: 0,
    fY: 0,
    fW: 320,
    fH: 168,
    mX: 0,
    mY: 0,
    mX2: 320 * FRACUNIT,
    mY2: 168 * FRACUNIT,
    mW: 320 * FRACUNIT,
    mH: 168 * FRACUNIT,
    scaleMtof: FRACUNIT,
    scaleFtom: FRACUNIT,
    markpoints: Array.from({ length: 10 }, () => ({ x: -1, y: -1 })),
  };
}

describe('renderFrame (M3-07): automap overlay over the 3D pass (§4.1.9)', () => {
  it('automap pixels land ONLY when the state is active; 3D pass runs first', () => {
    const fix = fixture(LOWRANGE);
    const player = centerPlayer();
    const amMap = automapBox();

    // Inactive state ⇒ pure walls frame (no automap colors anywhere).
    renderFrame({
      fb: fix.fb,
      world: fix.world,
      map: fix.view,
      player,
      automap: { state: automapGeom(false), map: amMap, player: { mo: { x: 128 * FRACUNIT, y: 128 * FRACUNIT, angle: 0 } } },
    });
    const wallsReds = countWhere(fix.fb, (v) => v >= WALLCOLORS && v < WALLCOLORS + 16);
    const wallsWhite = countWhere(fix.fb, (v) => v === WHITE);
    expect(wallsReds).toBe(0);
    expect(wallsWhite).toBe(0);

    // Active state ⇒ the SAME entry composes the automap afterwards:
    // WALLCOLORS-family line pixels + the WHITE arrow must be present.
    const counters = renderFrame({
      fb: fix.fb,
      world: fix.world,
      map: fix.view,
      player,
      automap: { state: automapGeom(true), map: amMap, player: { mo: { x: 128 * FRACUNIT, y: 128 * FRACUNIT, angle: 0 } } },
    });
    const amReds = countWhere(fix.fb, (v) => v >= WALLCOLORS && v < WALLCOLORS + 16);
    const amWhite = countWhere(fix.fb, (v) => v === WHITE);
    expect(amReds, 'automap wall lines must be present when active').toBeGreaterThan(100);
    expect(amWhite, 'player arrow must be present when active').toBeGreaterThan(0);
    expect(counters.hom, '3D pass ran even under the overlay').toBe(0);

    // The overlay is the LAST pass: the drawer alone (same inputs) yields
    // the same automap pixels — i.e. the 3D pass ran BEFORE it, not after.
    const probe = new Framebuffer();
    drawAutomap(probe, automapGeom(true), amMap, { mo: { x: 128 * FRACUNIT, y: 128 * FRACUNIT, angle: 0 } });
    expect(countWhere(probe, (v) => v >= WALLCOLORS && v < WALLCOLORS + 16)).toBe(amReds);
  });
});
