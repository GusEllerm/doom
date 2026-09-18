/**
 * M4-07 — full-frame pipeline integration (docs/design/M4-plan.md §M4-07).
 *
 * One `renderFrame` now runs the whole vanilla order (renderer.ts header pins
 * r_main.c R_RenderPlayerView: clears → BSP walls + visplane marks +
 * R_AddSprites → R_DrawPlanes → vissprites → masked middles). This suite is
 * the STRUCTURAL evidence for that integration — deliberately NOT golden
 * shas: the milestone re-bless (the 20 M3 scenes + ≥4 new ones) is M4-08's
 * job ("goldens: re-bless happens M4-08"), so every assertion here is about
 * what the frame is made of, never which bytes an older pipeline produced.
 *
 * Scenes (fixtures need no IWAD):
 *  1. EVERY scene: renderFrame does not throw, both renders are byte-equal
 *     (L3 determinism), and hom / visplaneOverflow / visspriteOverflow /
 *     openingOverflow / drawsegOverflow are all 0 (plan §1.3 — caps are
 *     never raised; a trip here means re-picking, and the assert names it).
 *  2. FLATS (M4FLAT): the checker flat's two values (144 / 208) both reach
 *     the framebuffer ⇒ visplanes really draw (the M3 black gaps are gone).
 *  3. MASKED (M4MASK): with the fence's mid texture removed the SAME
 *     viewpoint is the "far wall" reference; every pixel the fence changes
 *     must be an OPAQUE fence column (never black) and the parity holes
 *     must equal the reference pixel for pixel ⇒ holes show the far wall,
 *     not the void.
 *  4. SKY (M4SKY): the sky room's F_SKY1 ceiling paints the SKY1 column
 *     markers (hi-row values 130..250) ABOVE the horizon, and they are
 *     FULLBRIGHT (identity rows: the raw texture byte survives the light-32
 *     sector — planes.ts's `dc_colormap = colormaps`).
 *  5. THINGS (M4THNG): sprite pixels land at the columns predicted by
 *     R_ProjectSprite's own math (projection/xscale/patch-offset chain) for
 *     every thing inside the FOV, and things outside the FOV paint nothing.
 *  6. E1M1 (skipIf no wad): all eight committed viewpoints smoke-render
 *     clean — counters + determinism only, goldens are M4-08.
 *
 * Light tables are the IDENTITY 34 rows (every colormap maps v→v), so a
 * drawn flat/patch byte reaches the framebuffer unmodified and the asserts
 * above can name exact palette values.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRACBITS, FRACUNIT } from '../../src/core/constants';
import { FixedDiv, FixedMul } from '../../src/core/fixed';
import { buildPatchFromColumns } from '../../src/wad/patch';
import { loadMap } from '../../src/wad/mapdata';
import { texturesFromWad } from '../../src/wad/texture';
import type { TextureDef } from '../../src/wad/types';
import { WadFile } from '../../src/wad/wadfile';

import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables, type LightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld, type RenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame, type FrameCounters, type SpriteTables } from '../../src/render/renderer';
import { THING_SPRITE4, thingTypeIndex } from '../../src/render/rthings';
import { buildRenderMapView, initTextureMapping, type RenderMapView } from '../../src/render/view';

import type { M4MapSpec } from '../fixtures/m4Fixtures';
import { WadBuilder } from '../fixtures/wadWriter';
import { buildFixtureMapWad } from '../fixtures/mapBuilder';
import {
  M4_MAP_NAMES,
  M4_SCENES,
  TEX_MASKED,
  THING_SHORT,
  THING_TALL,
  THINGSFIX_SPEC,
  THINGS_RING_CENTER,
  addM4Graphics,
  buildM4MapLumps,
  buildM4SceneWad,
  SKY_TEX_WIDTH,
  type M4Scene
} from '../fixtures/m4Fixtures';

import {
  WALLFIX_MAP_NAME,
  WALLFIX_SPEC,
  degToBam,
  fixTexValue,
  synthColormapRows,
  VIEWPOINTS,
} from './viewpoints';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Identity COLORMAP (34 rows, every row v→v): drawn bytes land unchanged. */
function identityTables(): LightTables {
  const rows = new Uint8Array(34 * 256);
  for (let i = 0; i < rows.length; i++) rows[i] = i & 255;
  return initLightTables(rows);
}

const TABLES = identityTables();

interface Bundle {
  readonly world: RenderWorld;
  readonly view: RenderMapView;
  readonly sprites: SpriteTables;
}

/** Synthetic 64×128 fixture texture (walls.test.ts pattern): the M2
 * fixture WAD's own patch lumps are 2×2 sliders that patch.ts cannot decode
 * (m4Fixtures header note), so the WALLFIX scenes supply textures in memory
 * while still taking their FLATS from the wad (F_START → flatsFromWad). */
function fixTexture(name: string): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < 64; c++) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r++) col[r] = fixTexValue(c, r);
    columns.push(col);
  }
  return { name, width: 64, height: 128, patches: [], columns };
}

function bundleFrom(
  bytes: Uint8Array,
  mapName: string,
  textures?: ReadonlyMap<string, TextureDef>
): Bundle {
  const wad = WadFile.parse(toArrayBuffer(bytes));
  const md = loadMap(wad, mapName);
  const view = buildRenderMapView(md);
  return {
    world: loadRenderWorld(
      md,
      textures ?? texturesFromWad(wad),
      flatsFromWad(wad)
    ),
    view,
    sprites: buildMapSprites({ md, map: view, wad }),
  };
}

/** One scene's two renders; returns both buffers + the counters. */
function renderTwice(
  b: Bundle,
  at: { x: number; y: number; z?: number; deg: number },
  tables: LightTables = TABLES
): { a: Uint8Array; b2: Uint8Array; c1: FrameCounters; c2: FrameCounters; fb: Framebuffer } {
  const fb = new Framebuffer();
  const mo = {
    x: (at.x * FRACUNIT) | 0,
    y: (at.y * FRACUNIT) | 0,
    z: at.z === undefined ? 0 : (at.z * FRACUNIT) | 0,
    angle: degToBam(at.deg),
  };
  const deps = {
    fb,
    world: b.world,
    map: b.view,
    player: { mo },
    tables,
    sprites: b.sprites,
  };
  const c1 = renderFrame(deps);
  const a = new Uint8Array(fb.indices);
  const c2 = renderFrame(deps);
  const b2 = new Uint8Array(fb.indices);
  return { a, b2, c1, c2, fb };
}

/** Same, but with the sprite pass deliberately absent (the "no sprites"
 * reference the things scene subtracts to isolate sprite pixels). */
function renderOnceNoSprites(
  b: Bundle,
  at: { x: number; y: number; z?: number; deg: number }
): Uint8Array {
  const fb = new Framebuffer();
  renderFrame({
    fb,
    world: b.world,
    map: b.view,
    player: {
      mo: {
        x: (at.x * FRACUNIT) | 0,
        y: (at.y * FRACUNIT) | 0,
        z: at.z === undefined ? 0 : (at.z * FRACUNIT) | 0,
        angle: degToBam(at.deg),
      },
    },
    tables: TABLES,
  });
  return new Uint8Array(fb.indices);
}

const counterNames = [
  'hom',
  'visplaneOverflow',
  'visspriteOverflow',
  'openingOverflow',
  'drawsegOverflow',
] as const;

function expectCleanCounters(c: FrameCounters, scene: string): void {
  for (const name of counterNames) {
    expect(c[name], `${scene}: ${name} must be 0 (caps are never raised)`).toBe(0);
  }
}

/* ------------------------------------------------------------------ */
/* Scene table (one viewpoint per fixture scene; all deterministic)    */
/* ------------------------------------------------------------------ */

interface Scene {
  readonly name: string;
  readonly bundle: () => Bundle;
  readonly at: { x: number; y: number; z?: number; deg: number };
}

const cached: Record<string, Bundle | undefined> = {};

function m4Bundle(scene: M4Scene): Bundle {
  return (cached[M4_MAP_NAMES[scene]] ??= bundleFrom(buildM4SceneWad(scene), M4_MAP_NAMES[scene]));
}

/** M4THNG + a synthesized S_START roster (the combined fixture WAD ships no
 * sprite lumps — vissprites.test.ts pattern): BAR1 frame A with a real
 * 8-slot rotation ring (5 lumps, XY mirrors) + BON1A0, values ≡ 0 mod 3 so
 * no sprite pixel can be confused with a 144/208 checker flat or a 200
 * fence column. */
const SPR_W = 12;
const SPR_H = 40;
function spriteLump(idx: number, hole = false): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < SPR_W; c++) {
    const col: number[] = [];
    for (let r = 0; r < SPR_H; r++) {
      const gap = hole && r < 4; // bottom post gap ⇒ those rows keep the flat
      col.push(gap ? 0 : ((idx * 37 + c * 7 + r * 3) % 84) * 3 + 3);
    }
    cols.push(col);
  }
  // Sprite convention (R02 §5/§8, patch.ts docstring): leftoffset = w/2,
  // topoffset = h (floor-anchored gzt).
  return buildPatchFromColumns(cols, SPR_W >> 1, SPR_H);
}

function thingsWad(): Uint8Array {
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
}

const SCENES: readonly Scene[] = [
  { name: 'WALLFIX (M3 fixture)', bundle: () => (cached[WALLFIX_MAP_NAME] ??= bundleFrom(buildFixtureMapWad(WALLFIX_SPEC, WALLFIX_MAP_NAME), WALLFIX_MAP_NAME, new Map([['FIXWALL0', fixTexture('FIXWALL0')], ['DOORFIX0', fixTexture('DOORFIX0')]]))), at: { x: 160, y: 160, deg: 45 } },
  { name: 'M4FLAT', bundle: () => m4Bundle('flats'), at: { x: 256, y: 128, deg: 90 } },
  { name: 'M4MASK', bundle: () => m4Bundle('masked'), at: { x: 128, y: 128, deg: 0 } },
  { name: 'M4SKY', bundle: () => m4Bundle('sky'), at: { x: 256, y: 256, deg: 90 } },
  { name: 'M4THNG', bundle: () => (cached.M4THNG ??= bundleFrom(thingsWad(), M4_MAP_NAMES.things)), at: { x: THINGS_RING_CENTER[0], y: THINGS_RING_CENTER[1], deg: 0 } },
  { name: 'M4PAN', bundle: () => m4Bundle('panning'), at: { x: 128, y: 128, deg: 90 } },
];

/* ------------------------------------------------------------------ */
/* 1. Every scene: no-throw, determinism, clean counters               */
/* ------------------------------------------------------------------ */

describe('M4-07 pipeline — fixture scenes', () => {
  for (const scene of SCENES) {
    it(`${scene.name}: renders, double-render byte-identical, all counters 0`, () => {
      let out: ReturnType<typeof renderTwice> | undefined;
      expect(() => {
        out = renderTwice(scene.bundle(), scene.at);
      }, `${scene.name}: renderFrame must not throw`).not.toThrow();
      const r = out as unknown as ReturnType<typeof renderTwice>;
      expect(Array.from(r.a), `${scene.name}: render #1 vs #2 must be byte-equal`).toEqual(Array.from(r.b2));
      expectCleanCounters(r.c1, scene.name);
      expectCleanCounters(r.c2, scene.name);
    });
  }

  it('fixture frames are no longer black-void frames (planes/sprites fill in)', () => {
    for (const scene of SCENES) {
      const { fb } = renderTwice(scene.bundle(), scene.at);
      let nonBlack = 0;
      for (const v of fb.indices) if (v !== 0) nonBlack++;
      expect(nonBlack, `${scene.name}: frame must not be a black/void frame`).toBeGreaterThan(30000);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 2. Flats: visplanes really draw                                    */
/* ------------------------------------------------------------------ */

describe('M4-07 pipeline — flats replace the black clear (M4FLAT)', () => {
  it('the checker flat reaches the framebuffer (both 144 and 208)', () => {
    const scene = SCENES.find((s) => s.name === 'M4FLAT')!;
    const { fb } = renderTwice(scene.bundle(), scene.at);
    const seen = new Set<number>();
    for (const v of fb.indices) seen.add(v);
    // FLTCHK0 = 8-px checker of 144/208 (m4Fixtures synthFlatChecker) —
    // identity colormaps ⇒ the raw flat bytes must be present verbatim.
    expect(seen.has(144), 'checker flat value A missing').toBe(true);
    expect(seen.has(208), 'checker flat value B missing').toBe(true);
  });

  it('below-horizon band is textured, not black (no fb.clear background)', () => {
    const scene = SCENES.find((s) => s.name === 'M4FLAT')!;
    const { fb } = renderTwice(scene.bundle(), scene.at);
    let black = 0;
    for (let r = 150; r < 200; r++) for (let c = 0; c < 320; c++) if (fb.indices[r * 320 + c] === 0) black++;
    // 50 rows × 320 = 16000 pixels of floor: at most a few seam columns
    // (flat value 0 exists in FLTRAMP0 column 0), never the M3 all-black.
    expect(black, 'floor band must be flat-textured, not the old black clear').toBeLessThan(1500);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Masked middles: parity holes show the FAR wall, not black        */
/* ------------------------------------------------------------------ */

describe('M4-07 pipeline — masked middles (M4MASK)', () => {
  // maskedCleanBundle() below builds the same map WITHOUT the fence mid
  // texture: the identical viewpoint then shows exactly what is behind the
  // fence (the shared line is a noDraw identical-sector line in that
  // variant, so nothing else in the frame moves).
  it('hole columns equal the fence-free reference; opaque columns paint the fence', () => {
    const scene = SCENES.find((s) => s.name === 'M4MASK')!;
    const withFence = renderTwice(scene.bundle(), scene.at).a;
    const ref = renderTwice(maskedCleanBundle(), scene.at).a;

    let fencePixels = 0;
    let blackPainted = 0;
    let holesKeptReference = 0;
    let referencePixels = 0;
    for (let i = 0; i < withFence.length; i++) {
      const now = withFence[i]!;
      const was = ref[i]!;
      if (was !== 0) referencePixels++;
      if (now === was) {
        if (was !== 0) holesKeptReference++;
        continue;
      }
      fencePixels++;
      if (now === 0) blackPainted++;
    }
    // The masked pass painted a real band…
    expect(fencePixels, 'masked middle must paint columns').toBeGreaterThan(2000);
    // …never with black (the M3 stub left MAXSHORT ⇒ nothing/void)…
    expect(blackPainted, 'masked middle must never paint black').toBe(0);
    // …and where its texture has holes the earlier far-wall pixel survives.
    expect(holesKeptReference, 'parity holes must keep the far wall').toBeGreaterThan(1000);
    expect(referencePixels, 'reference frame must be a real frame').toBeGreaterThan(30000);
  });
});

/* ------------------------------------------------------------------ */
/* 4. Sky: F_SKY1 ceilings draw the SKY1 column, fullbright            */
/* ------------------------------------------------------------------ */

describe('M4-07 pipeline — sky (M4SKY)', () => {
  it('sky columns map by view angle and stay fullbright', () => {
    const scene = SCENES.find((s) => s.name === 'M4SKY')!;
    // DIMMING rows this time: if the sky pass applied sector light (the
    // room is lit 32 ⇒ lightnum 2), every byte below would come back
    // scaled and the exact comparisons would fail. planes.ts's sky branch
    // uses colormaps[0] ("Sky is allways full bright", r_plane.c:405).
    const dim = initLightTables(synthColormapRows());
    const { fb } = renderTwice(scene.bundle(), scene.at, dim);

    // Expected byte per screen column, from the pinned sky math:
    //   angle  = (viewangle + xtoviewangle[x]) >> ANGLETOSKYSHIFT(22)
    //   column = angle & (fixture SKY1 width 256 − 1)   (rdata.getSkyColumn)
    //   row    = skytexturemid + (y − centery)·pspriteiscale = y  (1:1 tie)
    //   byte   = m4Fixtures skyPatch low half: (column & 15) + 1
    const { xtoviewangle } = initTextureMapping();
    const viewangle = degToBam(scene.at.deg);
    let checked = 0;
    for (let x = 0; x < 320; x += 7) {
      const column =
        (((viewangle + xtoviewangle[x]!) >>> 0) >>> 22) & (SKY_TEX_WIDTH - 1);
      const want = (column & 15) + 1;
      for (const y of [0, 5, 12, 20, 30, 40]) {
        const got = fb.indices[y * 320 + x]!;
        expect(got, `sky byte at r${y}c${x} (sky column ${column})`).toBe(want);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(250);

    // And the sky really occupies the band above the horizon (the fixture
    // ceiling is 128 tall at 256 units ⇒ the sky plane's marks run 0..45).
    let skyPixels = 0;
    for (let y = 0; y < 45; y++) for (let x = 0; x < 320; x++) if (fb.indices[y * 320 + x] !== 0) skyPixels++;
    expect(skyPixels, 'sky band above the horizon must be painted').toBeGreaterThan(45 * 320 * 0.98);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Things: sprite pixels at the predicted octant columns            */
/* ------------------------------------------------------------------ */

describe('M4-07 pipeline — static things (M4THNG)', () => {
  /** Signed angle (radians) between the view direction and the eye→point
   * bearing — the FOV classifier (clipangle is ±45° at FIELDOFVIEW 2048). */
  function angleDelta(px: number, py: number, vx: number, vy: number, vangle: number): number {
    const bearing = Math.atan2(py - vy, px - vx);
    const dir = ((vangle >>> 0) / 4294967296) * Math.PI * 2;
    let d = bearing - dir;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    return d;
  }

  /** R_ProjectSprite's own projection chain (r_things.c:443-548), reduced to
   * the screen-center column of one thing: tz → xscale → tx → column. */
  function predictedColumn(
    vx: number,
    vy: number,
    vangle: number,
    tx: number,
    ty: number
  ): { column: number; tz: number; xscale: number } | null {
    const dx = (tx - vx) | 0;
    const dy = (ty - vy) | 0;
    // Same tables/view math setupView stores on the ViewState (finesine /
    // finecosine at viewangle>>ANGLETOFINESHIFT); recomputed here with
    // Math so the test is an independent oracle.
    const ang = (vangle >>> 0) / 4294967296 * Math.PI * 2;
    const sinv = Math.round(Math.sin(ang) * 65536);
    const cosv = Math.round(Math.cos(ang) * 65536);
    const gxt = FixedMul(dx, cosv);
    const gyt = -FixedMul(dy, sinv);
    const tz = (gxt - gyt) | 0;
    if (tz < 4 * FRACUNIT) return null;
    const xscale = FixedDiv(160 * FRACUNIT, tz);
    const gxt2 = -FixedMul(dx, sinv);
    const gyt2 = FixedMul(dy, cosv);
    const tx0 = -(gyt2 + gxt2) | 0;
    const column = (160 * FRACUNIT + FixedMul(tx0, xscale)) >> FRACBITS;
    return { column, tz, xscale };
  }

  // The octant ring (bearings 0/45/…/315 from the room centre) plus the
  // 45°-half-FOV make two viewpoints cover every R_ProjectSprite exit:
  //  deg 0   — one thing dead ahead (bearing 45 is half-FOV off…): the
  //            bearings 45 / 315 / 315 land inside ±45° ⇒ drawn;
  //  deg 22.5 — nothing centred, one thing at delta ≈ +22°, the rest either
  //            at |delta| ≈ 67° (the `abs(tx) > tz<<2` wide-FOV reject, so
  //            they project OFF screen) or behind the view plane (MINZ).
  function classify(bundle: Bundle, at: { x: number; y: number; deg: number }) {
    const vx = (at.x * FRACUNIT) | 0;
    const vy = (at.y * FRACUNIT) | 0;
    const vangle = degToBam(at.deg);
    const t = bundle.sprites.things;
    const inFov: { thing: number; column: number; half: number }[] = [];
    const offScreen: { thing: number; column: number }[] = [];
    let behindView = 0;
    for (let k = 0; k < t.count; k++) {
      const p = predictedColumn(vx, vy, vangle, t.x[k]!, t.y[k]!);
      if (p === null) {
        behindView += 1; // tz < MINZ (r_things.c:452) — never pooled
        continue;
      }
      const half = Math.ceil((SPR_W >> 1) * (p.xscale / FRACUNIT)) + 2;
      const delta = angleDelta(t.x[k]!, t.y[k]!, vx, vy, vangle);
      if (Math.abs(delta) <= Math.PI / 4 + 0.06) inFov.push({ thing: k, column: p.column, half });
      else offScreen.push({ thing: k, column: p.column });
    }
    return { inFov, offScreen, behindView };
  }

  function changedPixels(a: Uint8Array, b: Uint8Array): { row: number; col: number }[] {
    const out: { row: number; col: number }[] = [];
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) out.push({ row: Math.floor(i / 320), col: i % 320 });
    return out;
  }

  const VIEW_FRONT = { x: THINGS_RING_CENTER[0], y: THINGS_RING_CENTER[1], deg: 0 };
  const VIEW_EDGE = { x: THINGS_RING_CENTER[0], y: THINGS_RING_CENTER[1], deg: 22.5 };

  it('sprite pixels land at the predicted octant columns', () => {
    const bundle = SCENES.find((s) => s.name === 'M4THNG')!.bundle();
    // The sprite roster must actually resolve (no missing-sprite skips).
    expect(bundle.sprites.things.skipped.missingSprite, 'fixture sprites must install').toBe(0);
    // 8 ring items + the pair, minus the two 3001 rows: doomednum 3001 is
    // the TROOP spawn (KIND_MONSTER ⇒ excluded until M8, plan §4).
    expect(bundle.sprites.things.skipped.monster, 'monster doomednums skipped').toBe(2);
    expect(bundle.sprites.things.count, 'ring + pair − 2 monster rows').toBe(8);
    expect(bundle.sprites.things.unknownTypes, 'no unknown doomednums').toEqual([]);

    const cls = classify(bundle, VIEW_FRONT);
    expect(cls.inFov.length, 'things inside the FOV').toBeGreaterThanOrEqual(3);

    const changed = changedPixels(renderTwice(bundle, VIEW_FRONT).a, renderOnceNoSprites(bundle, VIEW_FRONT));
    expect(changed.length, 'sprites must draw pixels').toBeGreaterThan(500);
    for (const px of changed) {
      const near = cls.inFov.some((pr) => Math.abs(px.col - pr.column) <= pr.half);
      expect(near, `sprite pixel r${px.row}c${px.col} is not near any predicted column`).toBe(true);
    }
    for (const pr of cls.inFov) {
      const hits = changed.filter((c) => Math.abs(c.col - pr.column) <= pr.half).length;
      expect(hits, `thing ${pr.thing} (column ${pr.column}) drew no pixels`).toBeGreaterThan(10);
    }
  });

  it('things outside the FOV project off screen and add no pixels', () => {
    const bundle = SCENES.find((s) => s.name === 'M4THNG')!.bundle();
    const cls = classify(bundle, VIEW_EDGE);
    expect(cls.inFov.length, 'one thing off-centre inside the FOV').toBeGreaterThanOrEqual(1);
    expect(cls.offScreen.length, 'things in front but outside the FOV').toBeGreaterThanOrEqual(1);
    expect(cls.behindView, 'things behind the view plane').toBeGreaterThanOrEqual(1);

    // The wide-FOV rejects must land outside 0..319 (r_things.c:478), and
    // nothing they touch may change.
    const changed = changedPixels(renderTwice(bundle, VIEW_EDGE).a, renderOnceNoSprites(bundle, VIEW_EDGE));
    for (const o of cls.offScreen) {
      const hits = changed.filter((c) => Math.abs(c.col - o.column) <= 1).length;
      const off = o.column < 0 || o.column >= 320;
      expect(
        off || hits === 0,
        `out-of-FOV thing ${o.thing} projects to column ${o.column} and must draw nothing`
      ).toBe(true);
    }
    // Every changed column still belongs to an in-FOV thing (no leak from
    // the rejected ones).
    for (const px of changed) {
      expect(
        cls.inFov.some((pr) => Math.abs(px.col - pr.column) <= pr.half),
        `sprite pixel r${px.row}c${px.col} belongs to no in-FOV thing`
      ).toBe(true);
    }
  });

  it('the table maps the doomednums the fixture uses', () => {
    // m4Fixtures calls 3001 "barrel-family", but info.c has doomednum 3001
    // = MT_TROOP (a monster) and 2035 = the explosive BARREL. The fixture's
    // drawable statics are therefore all BAR1, and the two 3001 rows are
    // skipped as monsters (plan §4: invisible until M8).
    expect(THING_SPRITE4[thingTypeIndex(THING_SHORT)!]).toBe('BAR1');
    expect(THING_SPRITE4[thingTypeIndex(THING_TALL)!]).toBe('TROO');
  });
});

/* ------------------------------------------------------------------ */
/* 6. E1M1 smoke (structure only — goldens are M4-08)                  */
/* ------------------------------------------------------------------ */

function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url)),
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

const WAD_PATH = findWad();

describe.skipIf(WAD_PATH === undefined)('M4-07 pipeline — freedoom1 E1M1 smoke (skipIf no wad)', () => {
  let bundle: Bundle | undefined;
  const e1m1 = (): Bundle => {
    if (bundle === undefined) {
      if (WAD_PATH === undefined) throw new Error('no wad (guard failed)');
      bundle = bundleFrom(Uint8Array.from(readFileSync(WAD_PATH)), 'E1M1');
    }
    return bundle;
  };

  for (const vp of VIEWPOINTS.filter((v) => v.kind === 'iwad')) {
    it(`${vp.name}: full-frame smoke — counters clean, double-render identical`, () => {
      const r = renderTwice(e1m1(), { x: vp.x, y: vp.y, ...(vp.z === undefined ? {} : { z: vp.z }), deg: vp.angleDeg });
      expect(Array.from(r.a), `${vp.name}: determinism`).toEqual(Array.from(r.b2));
      expectCleanCounters(r.c1, vp.name);
      expectCleanCounters(r.c2, vp.name);
      let nonBlack = 0;
      for (const v of r.fb.indices) if (v !== 0) nonBlack++;
      expect(nonBlack, `${vp.name}: must not be a void frame`).toBeGreaterThan(2000);
    });
  }
});

/* ------------------------------------------------------------------ */
/* M4MASK reference variant (fence mid texture removed)                */
/* ------------------------------------------------------------------ */

function maskedCleanBundle(): Bundle {
  const spec = M4_SCENES.masked;
  const clean: M4MapSpec = {
    rooms: spec.rooms.map((r) => ({ ...r, midTexture: undefined })),
  };
  const wad = new WadBuilder('IWAD');
  addM4Graphics(wad);
  wad.addLumpMarker(M4_MAP_NAMES.masked);
  for (const lump of buildM4MapLumps(clean)) wad.addLump(lump.name, lump.data);
  return (cached['M4MASK-CLEAN'] ??= bundleFrom(wad.build(), M4_MAP_NAMES.masked));
}

void TEX_MASKED;
