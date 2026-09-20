// render/psprites.test.ts — M7-07 weapon view layer (r_things.c
// R_DrawPSprite/R_DrawPlayerSprites port; plan §M7-07 acceptance 5).
//
// Synthetic fixtures (wadds rule: L1/L2 behavior on synthetic dumps),
// plus a freedoom1.wad-gated section drawing REAL PISG/PISF-style weapon
// lumps with a HOM=0-style bounds assert. The 3D pipeline never calls this
// module (gun OFF — see psprites.ts header), so goldens stay unmoved; the
// wiring-guard test pins that no renderer file imports psprites.ts yet.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { WadFile } from '../wad/wadfile';
import { buildSpriteDefs } from '../wad/sprites';

import { Framebuffer, RENDER_HEIGHT, RENDER_WIDTH } from './framebuffer';
import { initLightTables } from './lights';
import { installSprites, type InstalledSprites } from './rthings';
import {
  createPspritePass,
  pspriteFuzzCalls,
  resetPspriteFuzzCalls,
  FF_FULLBRIGHT,
  type PspriteView,
} from './psprites';
import { installSpritePatches, type SpritePatch } from './vissprites';
import { createViewState, type ViewState } from './view';

import { synthColormapRows } from '../../tests/render/viewpoints';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

/** w: patch columns value = col+1 (column fingerprint for order asserts). */
function makePatch(width: number, height: number, topOffset = 0): SpritePatch {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < width; c++) {
    columns.push(Uint8Array.from({ length: height }, () => c + 1));
  }
  return {
    width,
    height,
    offsetX: 0,
    widthFixed: (width << 16) | 0,
    topOffsetFixed: (topOffset << 16) | 0,
    columns,
  };
}

interface Fixture {
  fb: Framebuffer;
  view: ViewState;
  pass: ReturnType<typeof createPspritePass>;
  installed: InstalledSprites;
  lights: ReturnType<typeof initLightTables>;
}

/** Two sprites (0: frames A,B; 1: frame A) with lumps 10,11,12.
 *  sprite 0 frame 0 → lump 10 (flip 0), frame 1 → lump 11 (FLIP 1 —
 *  A2A8-style mirror slot), sprite 1 frame 0 → lump 12. */
function fixture(patch: SpritePatch, patchB = patch, patchC = patch): Fixture {
  const lump = new Int32Array(24).fill(-1);
  const flip = new Uint8Array(24);
  lump[0 * 8] = 10; // sprite 0 frame 0 — direct
  lump[1 * 8] = 11;
  flip[1 * 8] = 1; // frame 1 — mirrored slot (A2A8-style)
  lump[2 * 8] = 12; // sprite 1 frame 0
  const installed: InstalledSprites = {
    count: 2,
    name4: ['PIG1', 'PIG2'],
    warnings: [],
    indexOf: new Map([['PIG1', 0], ['PIG2', 1]]),
    frameStart: Int32Array.from([0, 2, 3]),
    frameRotate: new Uint8Array(3),
    lump,
    flip,
  };
  const patches = new Map<number, SpritePatch>([
    [10, patch],
    [11, patchB],
    [12, patchC],
  ]);
  const fb = new Framebuffer();
  const view = createViewState();
  const lights = initLightTables(synthColormapRows());
  const pass = createPspritePass({ fb, view, sprites: installed, patches, lights });
  return { fb, view, pass, installed, lights };
}

const px = (fb: Framebuffer, x: number, y: number) => fb.indices[y * RENDER_WIDTH + x]!;

function pspOf(sprite: number, frame: number, sx: number, sy: number): PspriteView {
  return { sprite, frame, sx, sy };
}

const CTX = { sectorLight: 0, invisibility: 0 };

/* ------------------------------------------------------------------ */
/* 1) Fixed screen position (no world projection)                       */
/* ------------------------------------------------------------------ */

describe('R_DrawPSprite geometry', () => {
  it('sx=160 centers the 4-wide patch at x 160..163, sy lands the 3-high box', () => {
    const { fb, pass, view } = fixture(makePatch(4, 3));
    view.fixedcolormap = 0; // identity row — geometry test, lighting elsewhere
    // sx 160F, sy 32 (WEAPONTOP) + topoffset 0:
    // texturemid = 100F + 0.5F − 32F = 68.5F ⇒ sprtopscreen = 31.5F ⇒ y 32..34
    // (offsetX 0 fixture ⇒ box starts AT x1 = 160, width 4 ⇒ 160..163).
    pass.drawPlayerSprites([pspOf(0, 0, 160 * FRACUNIT, 32 * FRACUNIT)], CTX);
    for (let x = 160; x <= 163; x++) {
      for (let y = 32; y <= 34; y++) {
        expect(px(fb, x, y), `(${x},${y})`).toBe(x - 159); // col value c+1
      }
    }
    expect(px(fb, 159, 33)).toBe(0); // outside left
    expect(px(fb, 164, 33)).toBe(0); // outside right
    expect(px(fb, 160, 31)).toBe(0); // above
    expect(px(fb, 160, 35)).toBe(0); // below
    expect(pass.scratch.x1).toBe(160);
    expect(pass.scratch.x2).toBe(163);
    expect(pass.scratch.scale).toBe(FRACUNIT); // pspritescale @ 320
  });

  it('sx bob moves the box rigidly (weapon-space x, no perspective)', () => {
    const { fb, pass, view } = fixture(makePatch(4, 3));
    view.fixedcolormap = 0;
    pass.drawPlayerSprites([pspOf(0, 0, 162 * FRACUNIT, 32 * FRACUNIT)], CTX);
    expect(pass.scratch.x1).toBe(162);
    expect(pass.scratch.x2).toBe(165);
    expect(px(fb, 164, 33)).toBe(3); // texel 2 of the shifted box
  });

  it('off the right / left side ⇒ not drawn', () => {
    const { fb, pass } = fixture(makePatch(4, 3));
    pass.drawPlayerSprites([pspOf(0, 0, 400 * FRACUNIT, 32 * FRACUNIT)], CTX);
    expect(pass.scratch.drawn).toBe(0);
    pass.drawPlayerSprites([pspOf(0, 0, -80 * FRACUNIT, 32 * FRACUNIT)], CTX);
    expect(pass.scratch.drawn).toBe(0);
    expect(fb.indices.every((v) => v === 0)).toBe(true);
  });

  it('clips to screen bounds (mfloorclip/mceilingclip degeneracy ⇒ 0..199)', () => {
    const { fb, pass } = fixture(makePatch(4, 300, 0)); // taller than screen
    pass.drawPlayerSprites([pspOf(0, 0, 160 * FRACUNIT, -100 * FRACUNIT)], CTX);
    expect(pass.scratch.drawn).toBeGreaterThan(0);
    // no writes outside the framebuffer rows, top rows written (y=0):
    expect(px(fb, 160, 0)).toBe(1);
    // row count bounded: every column drew ≤ RENDER_HEIGHT rows.
    let written = 0;
    for (let y = 0; y < RENDER_HEIGHT; y++) for (let x = 0; x < RENDER_WIDTH; x++) if (px(fb, x, y)) written++;
    expect(written).toBeLessThanOrEqual(4 * RENDER_HEIGHT);
  });

  it('flip slot mirrors the same lump (xiscale negative, startfrac wF−1)', () => {
    const { pass } = fixture(makePatch(4, 3), makePatch(4, 3));
    pass.drawPlayerSprites([pspOf(0, 1, 160 * FRACUNIT, 32 * FRACUNIT)], CTX);
    expect(pass.scratch.xiscale).toBe(-FRACUNIT);
    expect(pass.scratch.startfrac).toBe((4 << 16) - 1);
  });
});

/* ------------------------------------------------------------------ */
/* 2) Colormap ladder (flash fullbright, fixedcolormap, extralight)     */
/* ------------------------------------------------------------------ */

describe('R_DrawPSprite colormap ladder', () => {
  it('normal psprite uses spritelights[sectorLight>>4 + extralight]', () => {
    const { fb, pass, view, lights } = fixture(makePatch(4, 3));
    view.extralight = 2;
    pass.drawPlayerSprites([pspOf(0, 0, 160 * FRACUNIT, 32 * FRACUNIT)], {
      sectorLight: 160, // row = 10 + 2
      invisibility: 0,
    });
    // row select is the scalelight TABLE entry (r_main.c R_ExecuteSetViewSize
    // level ramp — not a flat row*k offset), consumed at column 47.
    expect(pass.scratch.colormap).toBe(lights.scalelight[12 * 48 + 47]);
    expect(px(fb, 160, 33)).toBe(lights.colormaps[pass.scratch.colormap + 1]!);
  });

  it('FF_FULLBRIGHT flash draws with colormaps row 0 even in a dark sector', () => {
    const { fb, pass } = fixture(makePatch(4, 3));
    pass.drawPlayerSprites([pspOf(0, FF_FULLBRIGHT | 0, 160 * FRACUNIT, 32 * FRACUNIT)], {
      sectorLight: 0,
      invisibility: 0,
    });
    expect(pass.scratch.colormap).toBe(0);
    expect(px(fb, 160, 33)).toBe(1); // identity row
    expect(px(fb, 163, 33)).toBe(4); // identity row, texel 3
  });

  it('fixedcolormap wins over the sector row; invisibility wins over all', () => {
    const { fb, pass, view, lights } = fixture(makePatch(4, 3));
    resetPspriteFuzzCalls();
    view.fixedcolormap = 5; // pain-flash inverse etc.
    pass.drawPlayerSprites([pspOf(0, 0, 160 * FRACUNIT, 32 * FRACUNIT)], CTX);
    expect(pass.scratch.colormap).toBe(5 * 256);
    expect(px(fb, 160, 33)).toBe(lights.colormaps[5 * 256 + 1]!);

    pass.drawPlayerSprites([pspOf(0, 0, 160 * FRACUNIT, 32 * FRACUNIT)], {
      sectorLight: 0,
      invisibility: 4 * 32 + 1,
    });
    expect(pass.scratch.colormap).toBe(-1); // shadow draw
    expect(pspriteFuzzCalls()).toBe(1); // counted named stub, nothing drawn
  });

  it('two active psprites draw in loop order (weapon then flash on top)', () => {
    const { fb, pass, view } = fixture(makePatch(4, 3), makePatch(4, 3), makePatch(4, 3));
    view.fixedcolormap = 0;
    // weapon sprite 0 lump 10 values 1..4; flash sprite 1 lump 12 same.
    pass.drawPlayerSprites(
      [pspOf(0, 0, 160 * FRACUNIT, 32 * FRACUNIT), pspOf(1, 0, 160 * FRACUNIT, 32 * FRACUNIT)],
      CTX,
    );
    expect(pass.scratch.drawn).toBe(8); // 4 posts x 2 psprites
    expect(px(fb, 160, 33)).toBe(1); // flash overwrote the SAME box (identity)
    expect(px(fb, 163, 33)).toBe(4);
  });
});

/* ------------------------------------------------------------------ */
/* 3) Wiring guard: gun OFF ⇒ existing goldens structurally unmoved     */
/* ------------------------------------------------------------------ */

describe('renderer integration status', () => {
  it('no renderer module imports psprites.ts yet (gun OFF)', async () => {
    const src = readFileSync(fileURLToPath(new URL('./renderer.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/from '\.\/psprites'/);
    const fs = await import('node:fs');
    for (const f of ['view.ts', 'rdata.ts', 'vissprites.ts', 'bsp.ts']) {
      expect(fs.readFileSync(new URL(`./${f}`, import.meta.url), 'utf8')).not.toMatch(
        /from '\.\/psprites'/,
      );
    }
  });
});

/* ------------------------------------------------------------------ */
/* 4) Real WAD sprites (freedoom1.wad, auto-skip when absent)           */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad weapon psprites', () => {
  it('mid-anim pistol frames + flash draw in-bounds, HOM=0 (no writes off-box)', () => {
    const wad = WadFile.parse(
      new Uint8Array(readFileSync(WAD_PATH)).buffer as ArrayBuffer,
    );
    const installed = installSprites(buildSpriteDefs(wad));
    const patches = installSpritePatches(installed, (n) => wad.readLump(n));
    const fb = new Framebuffer();
    const view = createViewState();
    const lights = initLightTables(synthColormapRows());
    const pass = createPspritePass({ fb, view, sprites: installed, patches, lights });

    // PISG/PISF — Freedoom uses the doom1 4CCs (R12).
    const pisg = installed.name4.indexOf('PISG');
    const pisf = installed.name4.indexOf('PISF');
    expect(pisg).toBeGreaterThanOrEqual(0);
    expect(pisf).toBeGreaterThanOrEqual(0);

    for (const [sprite, frame, sx, sy] of [
      [pisg, 0, 160 * FRACUNIT, 32 * FRACUNIT], // ready (bob 0)
      [pisg, 1, 161 * FRACUNIT, 38 * FRACUNIT], // firing frame
      [pisf, FF_FULLBRIGHT | 0, 160 * FRACUNIT, 32 * FRACUNIT], // muzzle flash
    ] as [number, number, number, number][]) {
      fb.indices.fill(0);
      pass.drawPlayerSprites([pspOf(sprite, frame, sx, sy)], CTX);
      const x1 = pass.scratch.x1;
      const x2 = pass.scratch.x2;
      expect(pass.scratch.drawn, `frame ${frame}`).toBeGreaterThan(0);
      // HOM=0-style: every written pixel lies inside the projected box.
      for (let y = 0; y < RENDER_HEIGHT; y++) {
        for (let x = 0; x < RENDER_WIDTH; x++) {
          if (fb.indices[y * RENDER_WIDTH + x] !== 0) {
            expect(x, `stray write (${x},${y})`).toBeGreaterThanOrEqual(x1);
            expect(x, `stray write (${x},${y})`).toBeLessThanOrEqual(x2);
          }
        }
      }
    }
  });
});
