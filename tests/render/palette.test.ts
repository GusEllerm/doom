/**
 * M7-06 — powerup RENDER effects: palette bank selection + fixedcolormap
 * read-through, on one fixed fixture viewpoint (M7-plan §M7-06 acceptance 2
 * and 4, "L3 pair frames … fixture fallback", "framebuffer bank = 0
 * everywhere pre-powerup (regression: all M3/M4 goldens unchanged)").
 *
 * Three claims, in the order the sources give them:
 *  A. THE PLAYPAL BAND IS A BLIT-TIME FACT, NOT A FRAME FACT.
 *     Vanilla applies the band with I_SetPalette (st_stuff.c:1047-1050) —
 *     the framebuffer keeps holding INDICES. So `fb.indices` for a
 *     pain-flash frame is BYTE-IDENTICAL to the normal frame; only the RGBA
 *     blit differs (PaletteLuts.setBank). This is why M3/M4/M5 indexed
 *     goldens CANNOT move when a band changes, asserted here directly.
 *  B. fixedcolormap IS a frame fact (r_main.c:847-859 → every pass): the
 *     invulnerability row (32 = INVERSECOLORMAP) and the infrared row (1,
 *     "almost full bright") change fb.indices themselves. The fixture uses a
 *     synthetic COLORMAP whose row 32 is a true inversion and row 1 a true
 *     brighten, so the *semantics* are assertable, not just "differs".
 *  C. MF_SHADOW on the PLAYER is invisible in this view: 1.10 draws the
 *     first-person frame from psprites only, and the player's mobj is not in
 *     the map sprite roster — so the fuzz path (vissprites.ts's
 *     drawFuzzColumn, which THROWS until M8) stays unreachable from a
 *     powerup. Asserted, because the alternative is a silent throw later.
 *
 * Fixture-first: the wad halves are skipIf(no wad) and only re-check the
 * same two facts against real PLAYPAL/COLORMAP lumps.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { decodeColormap, decodePlaypal, NUM_PALETTES, PALETTE_SIZE } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame } from '../../src/sim/game';
import { pTeleportMove } from '../../src/sim/pmap';
import { createPlayer } from '../../src/sim/player';
import { IRONTICS, INVULNTICS, PW, P_GivePower, resetPickupState } from '../../src/sim/p_inter_pickup';
import { attachPowerupFields, pPowerThink, paletteBand, type PowerupPlayer } from '../../src/sim/ppalette';
import { MF_SHADOW } from '../../src/sim/thinglinks';
import {
  buildLut,
  drawFuzzColumn,
  FUZZOFF,
  fuzzoffset,
  FUZZTABLE,
  fuzzState,
  Framebuffer,
  PaletteLuts,
  resetFuzzPos
} from '../../src/render/framebuffer';
import { initLightTables, type LightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame, type SpriteTables } from '../../src/render/renderer';
import { buildRenderMapView, type RenderMapView } from '../../src/render/view';
import type { RenderWorld } from '../../src/render/rdata';
import type { TextureDef } from '../../src/wad/types';

import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';
import { fixTexValue } from './viewpoints';

/* ------------------------------------------------------------------ */
/* Fixture: one room, viewed east at a fixed spot                      */
/* ------------------------------------------------------------------ */

const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 512, h: 256, ceilingHeight: 128, lightLevel: 160 },
    { x: 512, y: 0, w: 512, h: 256, ceilingHeight: 128, lightLevel: 32 }
  ],
  things: [{ x: 48, y: 128, angle: 0, type: 1 }]
};

const WARP = { x: 64, y: 128, angleDeg: 0 };

const u8ToBuf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

function fixTexture(name: string): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < 64; c++) {
    const col = new Uint8Array(128);
    for (let r = 0; r < 128; r++) col[r] = fixTexValue(c, r);
    columns.push(col);
  }
  return { name, width: 64, height: 128, patches: [], columns };
}

/** Synthetic COLORMAP with SEMANTIC rows 1/32 (see header claim B):
 *  - rows 0..31: the fixture dimming ladder (viewpoints.synthColormapRows
 *    shape — every row monotonically darkens toward index 1),
 *  - row 1:      "almost full bright" — index v stays v (row 0 is identity
 *    in the ladder too, and vanilla's row 1 is the second-brightest map),
 *  - row 32:     INVERSECOLORMAP as a real inversion (v → 255−v, black 0
 *    stays black so the void does not light up),
 *  - row 33:     clone of 0 (unused). */
function semanticColormap(): Uint8Array {
  const rows = new Uint8Array(34 * 256);
  for (let k = 0; k < 32; k++) {
    for (let v = 0; v < 256; v++) {
      rows[k * 256 + v] = k === 0 || v === 0 ? v : Math.max(1, Math.round((v * (32 - k)) / 32));
    }
  }
  for (let v = 0; v < 256; v++) {
    rows[32 * 256 + v] = v === 0 ? 0 : 255 - v; // inverted
    rows[33 * 256 + v] = v; // identity, unused
  }
  return rows;
}

/** Synthetic PLAYPAL: bank b, index i → a colour that is unique per
 * (b,i) and clearly separated between banks. */
function synthPlaypal(): Uint32Array {
  const base = new Uint32Array(NUM_PALETTES * PALETTE_SIZE);
  for (let b = 0; b < NUM_PALETTES; b++) {
    for (let i = 0; i < PALETTE_SIZE; i++) {
      base[b * PALETTE_SIZE + i] =
        (0xff000000 | (b << 12) | (i << 3) | ((b * 7 + i) & 7)) >>> 0;
    }
  }
  return base;
}

interface Bundle {
  md: ReturnType<typeof loadMap>;
  world: RenderWorld;
  view: RenderMapView;
  tables: LightTables;
  sprites: SpriteTables;
  sim: ReturnType<typeof buildMapFromData>;
}

let fixture: Bundle | null = null;

function fixtureBundle(): Bundle {
  if (fixture === null) {
    const wad = WadFile.parse(u8ToBuf(buildFixtureMapWad(SPEC, 'PALFIX')));
    const md = loadMap(wad, 'PALFIX');
    const view = buildRenderMapView(md);
    const textures = new Map([
      ['FIXWALL0', fixTexture('FIXWALL0')],
      ['DOORFIX0', fixTexture('DOORFIX0')]
    ]);
    fixture = {
      md,
      view,
      sim: buildMapFromData(md),
      world: loadRenderWorld(md, textures, flatsFromWad(wad)),
      tables: initLightTables(semanticColormap()),
      sprites: buildMapSprites({ md, map: view, wad })
    };
  }
  return fixture;
}

function bootPlayer(): PowerupPlayer {
  resetPickupState();
  const state = gInitGame(fixtureBundle().sim);
  const p = attachPowerupFields(state.players[0]!);
  pTeleportMove(state.pmap, p.mo, WARP.x * FRACUNIT, WARP.y * FRACUNIT);
  p.mo.z = p.mo.floorz;
  p.mo.angle = Math.floor(WARP.angleDeg * (0x100000000 / 360)) >>> 0;
  return p;
}

/** Render one frame from the fixed viewpoint. The powerup fields go in as
 * the renderer's read-through (renderer.ts FramePlayer, r_main.c
 * R_SetupFrame), never as a render-side re-derivation. */
function render(p: PowerupPlayer): Framebuffer {
  const b = fixtureBundle();
  const fb = new Framebuffer();
  const c = renderFrame({
    fb,
    world: b.world,
    map: b.view,
    player: {
      mo: p.mo,
      viewz: p.viewz,
      extralight: p.extralight,
      fixedcolormap: p.fixedcolormap
    },
    tables: b.tables,
    sprites: b.sprites
  });
  expect(c.hom).toBe(0);
  expect(c.drawsegOverflow).toBe(0);
  expect(c.visspriteOverflow).toBe(0);
  expect(c.visplaneOverflow).toBe(0);
  expect(c.openingOverflow).toBe(0);
  return fb;
}

const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const countDiff = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
};
const brighterCount = (a: ArrayLike<number>, b: ArrayLike<number>): number => {
  let n = 0;
  for (let i = 0; i < a.length; i++) if ((a[i] as number) > (b[i] as number)) n++;
  return n;
};

/* ------------------------------------------------------------------ */
/* A. The band is a blit-time fact                                     */
/* ------------------------------------------------------------------ */

describe('M7-06 A — PLAYPAL band select (blit time, indices untouched)', () => {
  it('bank is 0 everywhere pre-powerup and no LUT rebuild ever happens', () => {
    const p = bootPlayer();
    const luts = new PaletteLuts(synthPlaypal());
    for (let tic = 0; tic < 60; tic++) {
      pPowerThink(p); // normal frame: no powers, no counts
      expect(paletteBand(p)).toBe(0);
      expect(luts.setBank(paletteBand(p))).toBe(false);
    }
    expect(luts.bank).toBe(0);
    expect(luts.changes, 'zero I_SetPalette calls').toBe(0);
    expect(luts.lut).toEqual(buildLut(luts.base, 0));
  });

  it('a pain flash changes the RGBA blit and NOT ONE INDEX byte', () => {
    const p = bootPlayer();
    const plain = render(p);
    const base = plain.indices.slice();
    const luts = new PaletteLuts(synthPlaypal());
    luts.setBank(paletteBand(p));
    plain.blit(luts.lut);
    const rgba0 = plain.pixels32.slice();

    p.damagecount = 64; // p_inter.c:875-878 (damage 64 → cnt 64)
    expect(paletteBand(p)).toBe(8); // (64+7)>>3 = 8 → clamp 7 → +1
    const flashed = render(p); // geometry/lighting untouched by a band
    expect(sha(flashed.indices)).toBe(sha(base)); // ← goldens cannot move
    expect(luts.setBank(paletteBand(p))).toBe(true);
    expect(luts.changes).toBe(1);
    flashed.blit(luts.lut);
    expect(countDiff(flashed.pixels32, rgba0)).toBeGreaterThan(1000);
    expect(sha(flashed.indices)).toBe(sha(render(bootPlayer()).indices));
  });

  it('every reachable band blits differently from bank 0 (radiation suit 13)', () => {
    const luts = new PaletteLuts(synthPlaypal());
    const fb = new Framebuffer();
    fb.indices.fill(17);
    fb.blit(luts.select(0));
    const ref = fb.pixels32.slice();
    for (const bank of [2, 5, 8, 10, 12, 13]) {
      fb.blit(luts.select(bank));
      expect(countDiff(fb.pixels32, ref), `bank ${bank} vs 0`).toBe(fb.indices.length);
    }
    // Bank LUTs are cached: 6 selects + bank 0 = 7 builds, no rebuilds.
    expect(() => luts.select(NUM_PALETTES)).toThrow(RangeError);
  });

  it('the suit band flickers the blit on the 8-tic phases (p_user.c gate)', () => {
    const p = bootPlayer();
    const luts = new PaletteLuts(synthPlaypal());
    P_GivePower(p, PW.pw_ironfeet); // 2100 tics
    let transitions = 0;
    let prev = paletteBand(p);
    luts.setBank(prev);
    for (let tic = 0; tic < IRONTICS; tic++) {
      pPowerThink(p);
      const band = paletteBand(p);
      if (band !== prev) {
        transitions++;
        prev = band;
      }
      const changed = band !== luts.bank; // evaluate BEFORE the swap
      expect(luts.setBank(band)).toBe(changed);
    }
    // Band 13 holds solid while the countdown is > 4*32 (1972 of the 2100
    // tics); the tail is the `&8` phases: t=128 is the ONE dark tic inside
    // the `>` arm's neighbour, then 16 alternating 8-tic blocks to t=1 —
    // 1 (129→128 dark) + 16 block boundaries = 17 flips, and luts.changes is
    // one MORE again (the initial 0→13 select).
    expect(luts.changes).toBe(transitions + 1);
    expect(transitions).toBe(17);
    expect(prev).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* B. fixedcolormap is a frame fact                                    */
/* ------------------------------------------------------------------ */

describe('M7-06 B — fixedcolormap read-through (r_main.c:847-859)', () => {
  it('invulnerability inverts the frame (row 32 = INVERSECOLORMAP)', () => {
    const p = bootPlayer();
    const plain = render(p);
    P_GivePower(p, PW.pw_invulnerability);
    pPowerThink(p); // p_user.c:362-383 sets fixedcolormap = 32
    expect(p.fixedcolormap).toBe(32);
    const inv = render(p);
    const diff = countDiff(inv.indices, plain.indices);
    expect(diff, 'the whole drawn area flips').toBeGreaterThan(8000);
    // Semantic half: on the synthetic inverse row, dark pixels go bright.
    expect(brighterCount(inv.indices, plain.indices), 'dark → light').toBeGreaterThan(diff / 2);
    // Double run: same state, byte-identical frame.
    expect(sha(render(p).indices)).toBe(sha(inv.indices));
  });

  it('infrared brightens it (row 1, `almost full bright`)', () => {
    const p = bootPlayer();
    const plain = render(p);
    P_GivePower(p, PW.pw_infrared);
    pPowerThink(p);
    expect(p.fixedcolormap).toBe(1);
    const infra = render(p);
    // The dim fixture room (light 32 ahead) must come up; nothing dims.
    expect(brighterCount(infra.indices, plain.indices)).toBeGreaterThan(1000);
    expect(countDiff(infra.indices, plain.indices)).toBeGreaterThan(1000);
    // Row 1 of the synthetic ladder is the identity for v=0 and ≈v above,
    // so every pixel of the bright frame is ≥ its normal-frame twin.
    let dimmed = 0;
    for (let i = 0; i < infra.indices.length; i++) {
      if ((infra.indices[i] as number) < (plain.indices[i] as number)) dimmed++;
    }
    expect(dimmed, 'infrared never darkens a pixel').toBe(0);
  });

  it('the flicker phases really do blink the frame near expiry', () => {
    const p = bootPlayer();
    const plain = render(p);
    P_GivePower(p, PW.pw_invulnerability);
    for (let tic = 0; tic < 1050 - 129; tic++) pPowerThink(p); // → 129 tics
    expect(p.fixedcolormap).toBe(32);
    const lit = render(p);
    pPowerThink(p); // → 128: `>` arm false, bit3 clear
    expect(p.fixedcolormap).toBe(0);
    const dark = render(p);
    expect(sha(dark.indices), 'dark phase = the normal frame').toBe(sha(plain.indices));
    expect(countDiff(lit.indices, dark.indices)).toBeGreaterThan(8000);
  });

  it('extralight reaches the same seam (A_Light* half, M7-07 writes it)', () => {
    const p = bootPlayer();
    const plain = render(p);
    p.extralight = 2;
    const lit = render(p);
    // Direction of the row walk is the port's lightnum→startmap arithmetic
    // (lights.ts) and A_Light's owner is M7-07; the claim pinned here is
    // only that extralight REACHES the light selection at all.
    expect(countDiff(lit.indices, plain.indices)).toBeGreaterThan(1000);
    expect(sha(render(p).indices)).toBe(sha(lit.indices));
  });
});

/* ------------------------------------------------------------------ */
/* C. MF_SHADOW on the player does not reach the world pass            */
/* ------------------------------------------------------------------ */

describe('M7-06 C — MF_SHADOW on the local player', () => {
  it('invisible player: world frame unchanged, fuzz draw never reached', () => {
    const p = bootPlayer();
    const plain = render(p);
    P_GivePower(p, PW.pw_invisibility);
    expect(p.mo.flags & MF_SHADOW).toBe(MF_SHADOW);
    const shadow = render(p); // would throw if a shadow vissprite appeared
    expect(sha(shadow.indices)).toBe(sha(plain.indices));
    // And it stays that way for the whole countdown: the flag alone changes
    // nothing about the first-person view (r_things.c:716 fuzzes PSPRITES,
    // which live in render/psprites.ts, not in the world pass).
    for (let tic = 0; tic < 400; tic++) pPowerThink(p);
    expect(render(p).indices.length).toBe(plain.indices.length);
    expect(p.mo.flags & MF_SHADOW).toBe(MF_SHADOW);
  });
});

/* ------------------------------------------------------------------ */
/* C2. The fuzz column: 1.10's ONLY shadow mechanism                   */
/* ------------------------------------------------------------------ */

describe('M7-06 C2 — R_DrawFuzzColumn (r_draw.c:283-365), no translucency', () => {
  /** COLORMAP stand-in: 34 rows, row 6 = the fuzz map (here: −40 clamped, so
   * the smear is visible in the assertions), every other row identity. */
  function fuzzColormaps(): Uint8Array {
    const rows = new Uint8Array(34 * 256);
    for (let k = 0; k < 34; k++) {
      for (let v = 0; v < 256; v++) rows[k * 256 + v] = v;
    }
    for (let v = 0; v < 256; v++) rows[6 * 256 + v] = v < 40 ? 0 : v - 40;
    return rows;
  }

  it('reads the framebuffer ONE ROW up/down through colormap 6, in table order', () => {
    expect(fuzzoffset.length).toBe(FUZZTABLE);
    expect(FUZZOFF).toBe(320); // ±SCREENWIDTH, i.e. a ROW neighbour
    const maps = fuzzColormaps();
    const fb = new Framebuffer();
    for (let y = 0; y < fb.height; y++) {
      for (let x = 0; x < fb.width; x++) fb.indices[y * fb.width + x] = (y * 3 + 50) & 255;
    }
    resetFuzzPos();
    const before = fb.indices.slice();
    drawFuzzColumn(fb, maps, 100, 20, 79);
    expect(fuzzState.pos, '60 pixels drawn, the table wrapped exactly once')
      .toBe(60 % FUZZTABLE);
    // Pixel 1 (table slot 0 = +FUZZOFF): the neighbour row (21) is untouched
    // when it is read, so the value is exactly maps[6*256 + before[...]].
    const w = fb.width;
    expect(fb.indices[20 * w + 100]).toBe(maps[6 * 256 + (before[21 * w + 100] as number)]);
    // Pixel 2 (slot 1 = −FUZZOFF) reads row 20 — which this SAME pass has
    // already fuzzed. Vanilla reads the LIVE framebuffer too (r_draw.c:358
    // indexes `dest`, not a copy), so the fuzz chains downward on an UP
    // offset: assert that, because a "cleaner" implementation would differ.
    expect(fb.indices[21 * w + 100]).toBe(maps[6 * 256 + (fb.indices[20 * w + 100] as number)]);

    // Every written pixel is in the row-6 image of the pre-pass values (the
    // fuzz never invents a colour: it is a copy + a fixed map, no blending),
    // and most pixels came from a neighbour row (the smear).
    const image = new Set<number>();
    for (let v = 0; v < 256; v++) image.add(maps[6 * 256 + v] as number);
    let smeared = 0;
    for (let y = 20; y <= 79; y++) {
      const got = fb.indices[y * w + 100] as number;
      expect(image.has(got), `y ${y} left the fuzz colormap`).toBe(true);
      if (got !== (before[y * w + 100] as number)) smeared++;
    }
    expect(smeared, 'the visible effect is a vertical smear').toBeGreaterThan(40);
    // The offsets really are whole-row steps (±SCREENWIDTH, never ±1).
    expect(new Set(fuzzoffset.map((o) => Math.abs(o) % w))).toEqual(new Set([0]));
  });

  it('border adjust + zero-length guard are verbatim', () => {
    const maps = fuzzColormaps();
    const fb = new Framebuffer();
    fb.indices.fill(200);
    resetFuzzPos();
    const before = fb.indices.slice();
    drawFuzzColumn(fb, maps, 5, 10, 9); // count < 0 → return
    expect(sha(fb.indices)).toBe(sha(before));
    // yl=0 → 1 and yh=199 → 198: the first and last rows are never written.
    resetFuzzPos();
    drawFuzzColumn(fb, maps, 5, 0, fb.height - 1);
    expect(fb.indices[5]).toBe(200);
    expect(fb.indices[(fb.height - 1) * fb.width + 5]).toBe(200);
    expect(fb.indices[fb.width + 5]).toBeLessThan(200);
  });

  it('fuzzpos is a frame-global: the same column fuzzes differently later', () => {
    const maps = fuzzColormaps();
    const mk = (): Framebuffer => {
      const fb = new Framebuffer();
      fb.indices.fill(128);
      return fb;
    };
    resetFuzzPos();
    const a = mk();
    drawFuzzColumn(a, maps, 3, 10, 14);
    resetFuzzPos();
    drawFuzzColumn(mk(), maps, 3, 10, 14); // burn the same 6 positions
    const b = mk();
    drawFuzzColumn(b, maps, 3, 10, 14); // …then fuzz again from pos 5
    expect(sha(a.indices)).not.toBe(sha(b.indices));
  });
});

/* ------------------------------------------------------------------ */
/* D. The same two facts on real lumps (skipIf no wad)                 */
/* ------------------------------------------------------------------ */

function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url))
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

const WAD_PATH = findWad();

describe.skipIf(WAD_PATH === undefined)('M7-06 D — iwad lumps (real PLAYPAL/COLORMAP)', () => {
  /** Boot E1M1, script the powerup fields onto the live player, render. */
  function e1m1Powerup(apply: (p: PowerupPlayer) => void): Framebuffer {
    const wad = WadFile.parse(toArrayBuffer(readFileSync(WAD_PATH as string)));
    const md = loadMap(wad, 'E1M1');
    const view = buildRenderMapView(md);
    const state = gInitGame(buildMapFromData(md));
    const pl = attachPowerupFields(state.players[0]!);
    apply(pl);
    pPowerThink(pl); // the P_PlayerThink powerup half, exactly once
    const fb = new Framebuffer();
    const c = renderFrame({
      fb,
      world: loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad), state.sectors),
      map: view,
      player: { mo: pl.mo, viewz: pl.viewz, extralight: pl.extralight, fixedcolormap: pl.fixedcolormap },
      tables: initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')!)),
      sprites: buildMapSprites({ md, map: view, wad })
    });
    expect(c.hom).toBe(0);
    // Real PLAYPAL: the band is applied at blit, and it must not have
    // touched a single index byte (claim A on real data).
    const plain = new Framebuffer();
    plain.indices.set(fb.indices);
    const luts = new PaletteLuts(decodePlaypal(wad.readLumpByName('PLAYPAL')!));
    
    plain.blit(luts.lut);
    fb.blit(luts.select(0));
    expect(sha(fb.indices)).toBe(sha(plain.indices));
    return fb;
  }

  it('berserk + pain flash + suit + bonus all land their banks on real data', () => {
    const cases: [string, (p: PowerupPlayer) => void, number][] = [
      ['berserk fade', (q) => (q.powers[PW.pw_strength] = 1), 3],
      ['pain flash', (q) => (q.damagecount = 32), 5],
      ['pickup bonus', (q) => (q.bonuscount = 6), 10],
      ['radiation suit', (q) => (q.powers[PW.pw_ironfeet] = IRONTICS), 13]
    ];
    for (const [name, apply, band] of cases) {
      const probe = attachPowerupFields(createPlayer());
      apply(probe);
      expect(paletteBand(probe), name).toBe(band);
      expect(() => e1m1Powerup(apply), name).not.toThrow();
    }
  });

  it('invulnerability flips E1M1 pixels through the real INVERSECOLORMAP row', () => {
    const lit = e1m1Powerup((q) => (q.powers[PW.pw_invulnerability] = INVULNTICS));
    const dim = e1m1Powerup(() => undefined);
    expect(countDiff(lit.indices, dim.indices)).toBeGreaterThan(1000);
  });
});

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
