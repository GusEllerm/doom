/**
 * M3-08/M4-08 — viewpoint golden suite (M3-plan §M3-08; M4-plan §M4-08
 * re-bless: the milestone's L3 evidence — ≥26 blessed FULL-FRAME scenes
 * (planes + masked middles + static sprites), byte goldens, PNGs and
 * hom == 0 + every overflow counter == 0 on every one).
 *
 * Deterministic full pipeline per scene (M4-07 order, same surface as
 * main.ts boot):
 *   WALLFIX / M4-06 fixture map / freedoom1 E1M1 bytes → WadFile.parse →
 *   loadMap → loadRenderWorld(+flatsFromWad) + buildRenderMapView +
 *   buildMapSprites + gInitGame (boot) →
 *   debug-convention WARP (x/y/z units + floor(deg/360·2^32) — viewpoints.ts)
 *   → 0 tics → renderFrame ×2 (BYTE-IDENTICAL buffers required) →
 *   sha256(fb.indices) vs tests/render/goldens/walls/meta.json + the live
 *   counters hom == 0 AND visplane/vissprite/opening/drawseg overflow == 0
 *   (M4 plan §1.3; the M3-03/M4-01/M4-05 overflow-injection units stay the
 *   counter-liveness regressions).
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
 * Fixture scenes need NO wad: WALLFIX textures are the deterministic
 * synthetic TextureDefs (viewpoints.ts fixTexValue), the M4-06 maps ship
 * their own TEXTURE1/flats in buildM4SceneWad (the things map gets the
 * synthesized S_START BAR1/BON1 roster — pipeline.test.ts pattern), and
 * fixture lights run through initLightTables on the synthetic COLORMAP
 * ramp — real wad tables only for iwad scenes (COLORMAP/PLAYPAL lumps).
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
import { flatsFromWad, loadRenderWorld, type RenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame, type SpriteTables } from '../../src/render/renderer';
import { buildRenderMapView, type RenderMapView } from '../../src/render/view';

import { buildFixtureMapWad } from '../fixtures/mapBuilder';
import { buildPatchFromColumns } from '../../src/wad/patch';
import {
  M4_MAP_NAMES,
  THINGSFIX_SPEC,
  addM4Graphics,
  buildM4MapLumps,
  buildM4SceneWad,
  type M4Scene
} from '../fixtures/m4Fixtures';
import { WadBuilder } from '../fixtures/wadWriter';
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
  /** M4-07 full-frame surface: static things + sprite lumps (M3 goldens
   * predate planes/sprites — the M4 re-bless renders the SAME pipeline as
   * main.ts: flats via flatsFromWad + sprites via buildMapSprites). */
  readonly sprites: SpriteTables;
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
    const view = buildRenderMapView(md);
    fixBundle = {
      sim: buildMapFromData(md),
      world: loadRenderWorld(
        md,
        new Map([['FIXWALL0', fixTexture('FIXWALL0')], ['DOORFIX0', fixTexture('DOORFIX0')]]),
        flatsFromWad(wad) // FIXFLAT0/1 (mapBuilder F_START) — the M4 plane draws
      ),
      view,
      tables: initLightTables(synthColormapRows()),
      sprites: buildMapSprites({ md, map: view, wad }), // no things, no S_START
      paletteRgb: grayRampPalette()
    };
  }
  return fixBundle;
}

/* ------------------------------------------------------------------ */
/* M4-08 fixture bundles (M4-06 maps; the kind:'fixture' + fixtureMap   */
/* scenes). Masks/sky/pan maps boot straight off buildM4SceneWad; the   */
/* things map additionally needs a synthesized S_START roster (the      */
/* combined fixture WAD ships no sprite lumps — pipeline.test.ts        */
/* pattern, duplicated here because pipeline.test.ts is not owned).     */
/* ------------------------------------------------------------------ */

function m4Bundle(scene: M4Scene): Bundle {
  return m4Cache[M4_MAP_NAMES[scene]] ??= bundleFromM4Wad(buildM4SceneWad(scene), M4_MAP_NAMES[scene]);
}
const m4Cache: Record<string, Bundle | undefined> = {};

function bundleFromM4Wad(bytes: Uint8Array, mapName: string): Bundle {
  const wad = WadFile.parse(toArrayBuffer(bytes));
  const md = loadMap(wad, mapName);
  const view = buildRenderMapView(md);
  return {
    sim: buildMapFromData(md),
    world: loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad)),
    view,
    tables: initLightTables(synthColormapRows()),
    sprites: buildMapSprites({ md, map: view, wad }),
    paletteRgb: grayRampPalette()
  };
}

/** 12×40 synthetic BAR1/BON1 lumps (pipeline.test.ts values ≡ 0 mod 3 so
 * no sprite pixel can masquerade as a flat or fence byte); the BAR1 ring
 * of 5 lumps carries the real XY-mirror pairs (A2A8/A3A7/A4A6). */
const SPR_W = 12;
const SPR_H = 40;
function spriteLump(idx: number, hole = false): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < SPR_W; c++) {
    const col: number[] = [];
    for (let r = 0; r < SPR_H; r++) {
      const gap = hole && r < 4;
      col.push(gap ? 0 : ((idx * 37 + c * 7 + r * 3) % 84) * 3 + 3);
    }
    cols.push(col);
  }
  // Sprite convention (R02 §5/§8): leftoffset = w/2, topoffset = h.
  return buildPatchFromColumns(cols, SPR_W >> 1, SPR_H);
}

function thingsBundle(): Bundle {
  return (m4Cache.M4THNG_SPROUTED ??= (() => {
    const wadBytes = (() => {
      const wad = new WadBuilder('IWAD');
      addM4Graphics(wad);
      wad.addLumpMarker('S_START');
      wad.addLump('BAR1A1', spriteLump(1));
      wad.addLump('BAR1A2A8', spriteLump(2));
      wad.addLump('BAR1A3A7', spriteLump(3));
      wad.addLump('BAR1A4A6', spriteLump(4));
      wad.addLump('BAR1A5', spriteLump(5));
      wad.addLump('BON1A0', spriteLump(6, true));
      wad.addLumpMarker('S_END');
      wad.addLumpMarker(M4_MAP_NAMES.things);
      for (const lump of buildM4MapLumps(THINGSFIX_SPEC)) wad.addLump(lump.name, lump.data);
      return wad.build();
    })();
    return bundleFromM4Wad(wadBytes, M4_MAP_NAMES.things);
  })());
}

function fixtureBundleFor(vp: Viewpoint): Bundle {
  switch (vp.fixtureMap ?? 'wallfix') {
    case 'wallfix':
      return fixtureBundle();
    case 'm4-mask':
      return m4Bundle('masked');
    case 'm4-sky':
      return m4Bundle('sky');
    case 'm4-things':
      return thingsBundle();
    case 'm4-pan':
      return m4Bundle('panning');
  }
}

let iwadBundle: Bundle | null = null;
function iwadBundle_(): Bundle {
  if (WAD_PATH === undefined) throw new Error('no wad (hasWad guard failed)');
  if (iwadBundle === null) {
    const wad = WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH)));
    const md = loadMap(wad, 'E1M1');
    const view = buildRenderMapView(md);
    const playpal = decodePlaypal(wad.readLumpByName('PLAYPAL')!);
    const paletteRgb: number[] = [];
    for (let i = 0; i < 256; i++) {
      const rgba = playpal[i]!; // palette 0 = normal
      paletteRgb.push(rgba & 0xff, (rgba >>> 8) & 0xff, (rgba >>> 16) & 0xff);
    }
    iwadBundle = {
      sim: buildMapFromData(md),
      world: loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad)),
      view,
      tables: initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')!)),
      sprites: buildMapSprites({ md, map: view, wad }),
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
  const bundle = vp.kind === 'fixture' ? fixtureBundleFor(vp) : iwadBundle_();
  const state = gInitGame(bundle.sim);
  const mo = state.players[0]!.mo;
  // __doom.warp semantics: fixed coords, ONFLOORZ token when z omitted.
  mo.x = (vp.x * FRACUNIT) | 0;
  mo.y = (vp.y * FRACUNIT) | 0;
  mo.z = vp.z === undefined ? MININT /* ONFLOORZ */ : (vp.z * FRACUNIT) | 0;
  mo.angle = degToBam(vp.angleDeg);
  const fb = new Framebuffer();
  const deps = { fb, world: bundle.world, map: bundle.view, player: { mo }, tables: bundle.tables, sprites: bundle.sprites };
  const c1 = renderFrame(deps);
  const bytesA = new Uint8Array(fb.indices);
  const c2 = renderFrame(deps);
  const bytesB = new Uint8Array(fb.indices);
  for (const [i, c] of [c1, c2].entries()) {
    const n = i + 1;
    expect(c.hom, `${vp.name}: hom must be 0 (render ${n})`).toBe(0);
    expect(c.visplaneOverflow, `${vp.name}: MAXVISPLANES hit (render ${n}) — re-pick or fix, never raise caps`).toBe(0);
    expect(c.visspriteOverflow, `${vp.name}: MAXVISSPRITES hit (render ${n}) — re-pick, never raise caps`).toBe(0);
    expect(c.openingOverflow, `${vp.name}: openings pool overflow (render ${n})`).toBe(0);
    expect(c.drawsegOverflow, `${vp.name}: MAXDRAWSEGS hit (render ${n}) — RE-PICK the viewpoint (plan §5), never raise caps`).toBe(0);
  }
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
  const bundle = vp.kind === 'fixture' ? fixtureBundleFor(vp) : iwadBundle_();
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

describe('walls goldens — WALLFIX fixture (M3-08 scenes, M4-08 re-blessed)', () => {
  for (const vp of VIEWPOINTS.filter((v) => v.kind === 'fixture' && (v.fixtureMap ?? 'wallfix') === 'wallfix')) goldenCase(vp);
});

describe('walls goldens — M4 fixture maps (M4-08: masked/sky/things/panning)', () => {
  for (const vp of VIEWPOINTS.filter((v) => v.kind === 'fixture' && (v.fixtureMap ?? 'wallfix') !== 'wallfix')) goldenCase(vp);
});

describe.skipIf(!hasWad)('walls goldens — freedoom1 E1M1 (skipIf no wad)', () => {
  for (const vp of VIEWPOINTS.filter((v) => v.kind === 'iwad')) goldenCase(vp);
});

describe('walls golden harness self-checks', () => {
  it('scene table: >=26 scenes, fixtures >=12, iwad >=12 (M4-08 gate)', () => {
    expect(VIEWPOINTS.length, 'M4 plan: >=24 blessed frames; task: >=26').toBeGreaterThanOrEqual(26);
    expect(VIEWPOINTS.filter((v) => v.kind === 'fixture').length).toBeGreaterThanOrEqual(12);
    expect(VIEWPOINTS.filter((v) => v.kind === 'iwad').length).toBeGreaterThanOrEqual(12);
    expect(VIEWPOINTS.filter((v) => v.kind === 'fixture' && v.fixtureMap !== undefined && v.fixtureMap !== 'wallfix').length, 'M4 fixture maps (masked/sky/things/pan)').toBeGreaterThanOrEqual(4);
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
