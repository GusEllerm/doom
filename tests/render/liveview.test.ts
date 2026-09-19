/**
 * M6-01 acceptance 4 — LIVE-VIEW wiring proof: the renderer boots through
 * the M6 state (gInitGame now layers the mutable live sector SoA + thinker
 * arena + hook slots into GameState) yet its pixels are UNMOVED: for the
 * committed E1M1 viewpoints (tests/render/viewpoints.ts) the frame sha
 * equals the UNTOUCHED walls golden (tests/render/goldens/walls/meta.json),
 * because the render pass reads its own static load-time copy
 * (loadRenderWorld ← md.sectors, render/rdata.ts) and nothing live.
 *
 * The suite proves the two halves of "identical-while-static":
 *   1. state.sectors (live SoA) is value-equal to map.sectors (static) on
 *      a freshly booted level — so live-vs-static reads cannot differ yet;
 *   2. renderFrame bytes match the committed goldens exactly (double render
 *      byte-identical, hom/overflow 0) — no M6-01 wiring drift.
 *
 * This file ADDS no golden of its own (goldens unmoved); it only re-renders
 * committed scenes. skipIf(no wad), discovery like walls.test.ts.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FRACUNIT, MININT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { decodeColormap } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame } from '../../src/sim/game';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame } from '../../src/render/renderer';
import { buildRenderMapView } from '../../src/render/view';

import { VIEWPOINTS, degToBam, type Viewpoint } from './viewpoints';

function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

const WAD_PATH = findWad();
const hasWad = WAD_PATH !== undefined;

const META_PATH = fileURLToPath(
  new URL('./goldens/walls/meta.json', import.meta.url)
);

const SCENES = ['e1m1-spawn-east', 'e1m1-atrium', 'e1m1-busy-yard'];

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

interface Bundle {
  sim: ReturnType<typeof buildMapFromData>;
  world: ReturnType<typeof loadRenderWorld>;
  view: ReturnType<typeof buildRenderMapView>;
  tables: ReturnType<typeof initLightTables>;
  sprites: ReturnType<typeof buildMapSprites>;
}

let bundle: Bundle | null = null;
function e1m1Bundle(): Bundle {
  if (bundle === null) {
    if (WAD_PATH === undefined) throw new Error('no wad (hasWad guard failed)');
    const wad = WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH)));
    const md = loadMap(wad, 'E1M1');
    const view = buildRenderMapView(md);
    bundle = {
      sim: buildMapFromData(md),
      world: loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad)),
      view,
      tables: initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')!)),
      sprites: buildMapSprites({ md, map: view, wad })
    };
  }
  return bundle;
}

const sha256Of = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!hasWad)('M6-01 live-view wiring — E1M1 goldens unmoved', () => {
  it('live sector SoA is value-equal to the static load-time arrays', () => {
    const b = e1m1Bundle();
    const state = gInitGame(b.sim);
    expect(state.sectors.count).toBe(b.sim.sectors.count);
    expect(Array.from(state.sectors.floorZ)).toEqual(
      Array.from(b.sim.sectors.floorHeight)
    );
    expect(Array.from(state.sectors.ceilingZ)).toEqual(
      Array.from(b.sim.sectors.ceilingHeight)
    );
    expect(Array.from(state.sectors.light)).toEqual(
      Array.from(b.sim.sectors.lightLevel)
    );
    expect(Array.from(state.sectors.special)).toEqual(
      Array.from(b.sim.sectors.special)
    );
  });

  for (const name of SCENES) {
    it(`${name}: frame bytes identical to the UNMOVED walls golden`, () => {
      const vp = VIEWPOINTS.find((v: Viewpoint) => v.name === name)!;
      expect(vp, `viewpoint ${name} present`).toBeDefined();
      const b = e1m1Bundle();
      const state = gInitGame(b.sim); // boots WITH live world layers
      const mo = state.players[0]!.mo;
      mo.x = (vp.x * FRACUNIT) | 0;
      mo.y = (vp.y * FRACUNIT) | 0;
      mo.z = vp.z === undefined ? MININT : (vp.z * FRACUNIT) | 0;
      mo.angle = degToBam(vp.angleDeg);
      const fb = new Framebuffer();
      const deps = {
        fb, world: b.world, map: b.view, player: { mo },
        tables: b.tables, sprites: b.sprites
      };
      const c1 = renderFrame(deps);
      const bytesA = new Uint8Array(fb.indices);
      const c2 = renderFrame(deps);
      const bytesB = new Uint8Array(fb.indices);
      expect(sha256Of(bytesA)).toBe(sha256Of(bytesB)); // deterministic
      for (const c of [c1, c2]) {
        expect(c.hom).toBe(0);
        expect(c.visplaneOverflow).toBe(0);
        expect(c.visspriteOverflow).toBe(0);
        expect(c.openingOverflow).toBe(0);
        expect(c.drawsegOverflow).toBe(0);
      }
      const meta = JSON.parse(readFileSync(META_PATH, 'utf8')) as {
        scenes: Record<string, { indexSha256: string }>;
      };
      const golden = meta.scenes[name];
      expect(golden, `walls golden '${name}' present`).toBeDefined();
      expect(
        sha256Of(bytesA),
        `${name}: M6-01 state wiring moved a frame — goldens must be unmoved`
      ).toBe(golden!.indexSha256);
    });
  }
});
