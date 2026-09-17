/**
 * render/segs.smoke.test.ts — MINIMAL compile-time/pipeline smoke for
 * M3-06 (the real test matrix is M3-06b): a FIXMAP room view through the
 * full bsp walk + seg callbacks must run without throwing and leave the
 * framebuffer non-blank, drawsegs recorded, and hom == 0.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { loadMap } from '../wad/mapdata';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import type { MapData, TextureDef } from '../wad/types';

import { createBspWalker } from './bsp';
import { Framebuffer } from './framebuffer';
import { createSegCallbacks } from './segs';
import { clearClipSegs, getRenderCounters } from './solidsegs';
import { clearClipArrays, clearDrawsegs, drawsegCount } from './drawsegs';
import { loadRenderWorld, type RenderWorld } from './rdata';
import {
  buildRenderMapView,
  createViewState,
  setupView,
  VIEWHEIGHT,
  type RenderMapView,
} from './view';

function mkTexture(name: string, width: number, fn: (c: number, r: number) => number): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < width; c += 1) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r += 1) col[r] = fn(c, r);
    columns.push(col);
  }
  return { name, width, height: 128, patches: [], columns } as unknown as TextureDef;
}

const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 }, // A (light 192)
    { x: 256, y: 0, w: 256, h: 256, ceilingHeight: 112, lightLevel: 128 }, // B window
    { x: 0, y: 256, w: 256, h: 256, floorHeight: 16 }, // C step
  ],
  doors: [{ x1: 256, y1: 96, x2: 256, y2: 160 }],
};

interface Fix {
  md: MapData;
  world: RenderWorld;
  view: RenderMapView;
}

function fixture(): Fix {
  const wad = WadFile.parse(buildFixtureMapWad(SPEC).buffer as ArrayBuffer);
  const md = loadMap(wad, 'FIXMAP');
  const textures = new Map<string, TextureDef>([
    ['FIXWALL0', mkTexture('FIXWALL0', 64, (c, r) => ((c * 7 + r * 3) % 255) + 1)],
    ['DOORFIX0', mkTexture('DOORFIX0', 64, (_c, r) => (r % 255) + 1)],
  ]);
  return { md, world: loadRenderWorld(md, textures), view: buildRenderMapView(md) };
}

describe('segs smoke (M3-06 pipeline; full matrix = M3-06b)', () => {
  const fix = fixture();
  const walker = createBspWalker(fix.view, fix.world);

  it('room view through walk + callbacks: no throw, pixels, drawsegs, hom 0', () => {
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, {
      x: 128 * FRACUNIT,
      y: 128 * FRACUNIT,
      angle: 0x80000000, // face west: one-sided wall at x = 0
    });
    const cb = createSegCallbacks(fb, fix.world, view, fix.view);

    // The per-frame clear trio (M3-07 wires renderFrame; here manual).
    clearClipSegs(320);
    clearDrawsegs();
    clearClipArrays(VIEWHEIGHT);

    expect(() => walker.walk(view, cb)).not.toThrow();

    let painted = 0;
    for (let i = 0; i < fb.indices.length; i++) if (fb.indices[i] !== 0) painted++;
    expect(painted).toBeGreaterThan(0);
    expect(drawsegCount()).toBeGreaterThan(0);
    expect(getRenderCounters().hom).toBe(0);
  });
});
