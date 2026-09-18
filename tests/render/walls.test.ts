/**
 * M3-08 — viewpoint golden suite (docs/design/M3-plan.md §M3-08, the
 * milestone's L3 evidence: ≥20 committed 3D frames with byte goldens,
 * PNGs and hom == 0 on every one).
 *
 * Deterministic full pipeline per scene:
 *   WALLFIX (buildFixtureMapWad) or freedoom1 E1M1 bytes → WadFile.parse →
 *   loadMap → loadRenderWorld + buildRenderMapView + gInitGame (boot) →
 *   debug-convention WARP (x/y/z units + floor(deg/360·2^32) — viewpoints.ts)
 *   → 0 tics → renderFrame ×2 (BYTE-IDENTICAL buffers required) →
 *   sha256(fb.indices) vs tests/render/goldens/walls/meta.json + the live
 *   counters hom == 0 AND drawsegOverflow == 0 (plan acceptance 4; the
 *   M3-03 overflow-injection unit stays the counter-liveness regression).
 *
 * Crowded-viewpoint policy (plan §5 risk): if a scene ever trips
 * MAXDRAWSEGS/MAXSEGS the assert names it — the fix is RE-PICKING the
 * viewpoint, never raising caps. None of the committed scenes trips them
 * (all dso == 0 at bless time).
 *
 * Goldens regenerate ONLY via `npm run goldens:update -- --set walls
 * --reason "..."` (scripts/goldens-update.mjs — blesses PNGs too, palette
 * embedded per dump). Modes (script-driven, same as automap.test.ts):
 *   GOLDENS_MODE=update → dump, skip meta asserts (regen run)
 *   GOLDENS_MODE=check  → dump AND assert (--check drift mode)
 *   GOLDENS_DUMP_DIR    → dump target (the ONLY write path; the test never
 *                         mutates goldens).
 *
 * E1M1 scenes are skipIf(!hasWad): wad located via $DOOM_WAD,
 * $FREEDOOM1_WAD or <repo>/wads/freedoom1.wad (like automap.test.ts).
 * Fixture scenes need NO wad: textures are the deterministic synthetic
 * TextureDefs (viewpoints.ts fixTexValue) and lights run through
 * initLightTables on the synthetic COLORMAP ramp — real wad tables only
 * for iwad scenes (COLORMAP/PLAYPAL lumps).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FRACUNIT, MININT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { decodeColormap, decodePlaypal } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import type { TextureDef } from '../../src/wad/types';
import { buildMapFromData, type RuntimeMap } from '../../src/sim/map';
import { gInitGame } from '../../src/sim/game';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables, type LightTables } from '../../src/render/lights';
import { loadRenderWorld, type RenderWorld } from '../../src/render/rdata';
import { renderFrame } from '../../src/render/renderer';
import { buildRenderMapView, type RenderMapView } from '../../src/render/view';

import { buildFixtureMapWad } from '../fixtures/mapBuilder';
import {
  VIEWPOINTS,
  WALLFIX_MAP_NAME,
  WALLFIX_SPEC,
  degToBam,
  fixTexValue,
  grayRampPalette,
  synthColormapRows,
  type Viewpoint
} from './viewpoints';

/* ------------------------------------------------------------------ */
/* Paths + wad discovery                                              */
/* ------------------------------------------------------------------ */

const GOLDENS_DIR = fileURLToPath(new URL('./goldens/walls/', import.meta.url));
const META_PATH = `${GOLDENS_DIR}meta.json`;
const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
const MODE = process.env['GOLDENS_MODE'] ?? '';

/** Candidate IWAD paths, first existing wins (worktrees may lack wads/). */
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

/* ------------------------------------------------------------------ */
/* Per-map boot bundles (built once, reused across scenes)             */
/* ------------------------------------------------------------------ */

interface Bundle {
  readonly sim: RuntimeMap;
  readonly world: RenderWorld;
  readonly view: RenderMapView;
  readonly tables: LightTables;
  /** PNG-review palette (768 ints, RGB triples) for the dumps. */
  readonly paletteRgb: number[];
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Synthetic 64×128 fixture texture (M3-07 renderer.test.ts pattern): the
 * fixture wad's own TEXTURE1 patches are 2-px slivers (smallWads), useless
 * as wall art — the synthetic pattern spans values 32..231 so every
 * colormap bucket is reachable. */
function fixTexture(name: string): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < 64; c++) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r++) col[r] = fixTexValue(c, r);
    columns.push(col);
  }
  return { name, width: 64, height: 128, patches: [], columns };
}

let fixBundle: Bundle | null = null;
function fixtureBundle(): Bundle {
  if (fixBundle === null) {
    const wad = WadFile.parse(toArrayBuffer(buildFixtureMapWad(WALLFIX_SPEC, WALLFIX_MAP_NAME)));
    const md = loadMap(wad, WALLFIX_MAP_NAME);
    fixBundle = {
      sim: buildMapFromData(md),
      world: loadRenderWorld(md, new Map([['FIXWALL0', fixTexture('FIXWALL0')], ['DOORFIX0', fixTexture('DOORFIX0')]])),
      view: buildRenderMapView(md),
      tables: initLightTables(synthColormapRows()),
      paletteRgb: grayRampPalette()
    };
  }
  return fixBundle;
}

let iwadBundle: Bundle | null = null;
function iwadBundle_(): Bundle {
  if (WAD_PATH === undefined) throw new Error('no wad (hasWad guard failed)');
  if (iwadBundle === null) {
    const wad = WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH)));
    const md = loadMap(wad, 'E1M1');
    const playpal = decodePlaypal(wad.readLumpByName('PLAYPAL')!);
    const paletteRgb: number[] = [];
    for (let i = 0; i < 256; i++) {
      const rgba = playpal[i]!; // palette 0 = normal
      paletteRgb.push(rgba & 0xff, (rgba >>> 8) & 0xff, (rgba >>> 16) & 0xff);
    }
    iwadBundle = {
      sim: buildMapFromData(md),
      world: loadRenderWorld(md, texturesFromWad(wad)),
      view: buildRenderMapView(md),
      tables: initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')!)),
      paletteRgb
    };
  }
  return iwadBundle;
}

/* ------------------------------------------------------------------ */
/* Pipeline                                                            */
/* ------------------------------------------------------------------ */

/** boot (gInitGame) → warp (debug convention, 0 tics) → render ×2. */
function renderScene(vp: Viewpoint): { fb: Framebuffer; bytesA: Uint8Array; bytesB: Uint8Array; hom: number; dso: number } {
  const bundle = vp.kind === 'fixture' ? fixtureBundle() : iwadBundle_();
  const state = gInitGame(bundle.sim);
  const mo = state.players[0]!.mo;
  // __doom.warp semantics: fixed coords, ONFLOORZ token when z omitted.
  mo.x = (vp.x * FRACUNIT) | 0;
  mo.y = (vp.y * FRACUNIT) | 0;
  mo.z = vp.z === undefined ? MININT /* ONFLOORZ */ : (vp.z * FRACUNIT) | 0;
  mo.angle = degToBam(vp.angleDeg);
  const fb = new Framebuffer();
  const deps = { fb, world: bundle.world, map: bundle.view, player: { mo }, tables: bundle.tables };
  const c1 = renderFrame(deps);
  const bytesA = new Uint8Array(fb.indices);
  const c2 = renderFrame(deps);
  const bytesB = new Uint8Array(fb.indices);
  expect(c1.hom, `${vp.name}: hom must be 0 (post-frame copy)`).toBe(0);
  expect(c1.drawsegOverflow, `${vp.name}: MAXDRAWSEGS hit — RE-PICK the viewpoint (plan §5), never raise caps`).toBe(0);
  expect(c2.hom, `${vp.name}: hom must be 0 (2nd render)`).toBe(0);
  expect(c2.drawsegOverflow, `${vp.name}: dso must be 0 (2nd render)`).toBe(0);
  return { fb, bytesA, bytesB, hom: c2.hom, dso: c2.drawsegOverflow };
}

const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

interface MetaFile {
  schema?: number;
  scenes?: Record<string, { indexSha256?: string; kind?: string; script?: string }>;
}

function readMeta(): MetaFile {
  if (!existsSync(META_PATH)) {
    throw new Error(`walls goldens meta missing: ${META_PATH} — run npm run goldens:update -- --set walls --reason "..."`);
  }
  return JSON.parse(readFileSync(META_PATH, 'utf8')) as MetaFile;
}

function wadSha256(): string | null {
  if (WAD_PATH === undefined) return null;
  return sha256Of(readFileSync(WAD_PATH));
}

function dump(vp: Viewpoint, fb: Framebuffer): void {
  if (DUMP_DIR === null) return;
  const bundle = vp.kind === 'fixture' ? fixtureBundle() : iwadBundle_();
  const base = `${DUMP_DIR}/${vp.name}`;
  writeFileSync(`${base}.bin`, fb.indices);
  writeFileSync(
    `${base}.json`,
    JSON.stringify(
      {
        name: vp.name,
        kind: vp.kind,
        script: vp.script,
        viewpoint: { x: vp.x, y: vp.y, ...(vp.z === undefined ? {} : { z: vp.z }), angleDeg: vp.angleDeg },
        width: fb.width,
        height: fb.height,
        indexSha256: sha256Of(fb.indices),
        hom: 0, // asserted 0 in renderScene — recorded for the meta trail
        paletteRgb: bundle.paletteRgb,
        wadPath: vp.kind === 'iwad' ? (WAD_PATH ?? null) : null,
        wadSha256: vp.kind === 'iwad' ? wadSha256() : null
      },
      null,
      2
    ) + '\n'
  );
}

function goldenCase(vp: Viewpoint): void {
  it(`${vp.name}: double-render byte-identical, hom/dso == 0, sha matches the committed golden`, () => {
    const { fb, bytesA, bytesB } = renderScene(vp);
    const shaA = sha256Of(bytesA);
    expect(shaA, `${vp.name}: same viewpoint rendered twice must be byte-identical (L3)`).toBe(sha256Of(bytesB));
    dump(vp, fb);
    if (MODE !== 'update') {
      const meta = readMeta();
      const golden = meta.scenes?.[vp.name];
      expect(golden, `golden '${vp.name}' missing from meta.json`).toBeDefined();
      expect(shaA, `${vp.name}: index sha drifted from meta.json`).toBe(golden!.indexSha256);
    }
  });
}

/* ------------------------------------------------------------------ */
/* Tests                                                               */
/* ------------------------------------------------------------------ */

describe('walls goldens — WALLFIX fixture (M3-08)', () => {
  for (const vp of VIEWPOINTS.filter((v) => v.kind === 'fixture')) goldenCase(vp);
});

describe.skipIf(!hasWad)('walls goldens — freedoom1 E1M1 (skipIf no wad)', () => {
  for (const vp of VIEWPOINTS.filter((v) => v.kind === 'iwad')) goldenCase(vp);
});

describe('walls golden harness self-checks', () => {
  it('scene table: >=20 scenes, both maps >=8', () => {
    expect(VIEWPOINTS.length).toBeGreaterThanOrEqual(20);
    expect(VIEWPOINTS.filter((v) => v.kind === 'fixture').length).toBeGreaterThanOrEqual(8);
    expect(VIEWPOINTS.filter((v) => v.kind === 'iwad').length).toBeGreaterThanOrEqual(8);
    expect(new Set(VIEWPOINTS.map((v) => v.name)).size, 'scene names unique').toBe(VIEWPOINTS.length);
  });

  it('fixture frames are non-blank and multi-color (walls drew, not a flat fill)', () => {
    const { fb } = renderScene(VIEWPOINTS.find((v) => v.name === 'fix-d-n')!);
    const counts = new Map<number, number>();
    for (const v of fb.indices) counts.set(v, (counts.get(v) ?? 0) + 1);
    const nonBlack = fb.indices.length - (counts.get(0) ?? 0);
    expect(nonBlack, 'walls must paint the frame').toBeGreaterThan(30000);
    let distinct = 0;
    for (const [v, n] of counts) if (v !== 0 && n >= 50) distinct++;
    expect(distinct, 'textured + lit, not a flat fill').toBeGreaterThan(10);
  });

  it.skipIf(!hasWad)('IWAD scenes run against a discovered wad', () => {
    expect(WAD_PATH).toBeDefined();
  });
});
