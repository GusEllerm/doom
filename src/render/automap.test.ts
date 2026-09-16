/**
 * render/automap tests (M2-09).
 *
 *  * AM_drawFline port vs a naive integer Bresenham (independent classic
 *    dx/dy-error formulation) on 400 seeded random segments — pixel-set
 *    equality — plus exact horizontal/vertical fast-path assertions.
 *  * render-side amClipMline: full-in / full-out / partial-window cases
 *    (partial: every rasterized pixel stays inside the f_w×f_h window).
 *  * drawAutomap on a hand-built three-room read-view: one-sided walls
 *    paint WALLCOLORS+lightlev (=176), the floor-change divider
 *    FDWALLCOLORS+lightlev (=64), a flat two-sided divider stays invisible
 *    (cheating=0), the WHITE (=209) player arrow shows at the expected
 *    screen position and rotates with the player angle, grid ON paints
 *    GRIDCOLORS (=104) at 128-unit block boundaries, and the crosshair
 *    writes the single vanilla flat-index GRAYS pixel.
 *
 * Inputs are plain structural literals: the render zone never imports
 * sim/** (A-INT1); the real sim objects' compatibility with these shapes is
 * typechecked at the src/main.ts call site.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';

import {
  BACKGROUND,
  CDWALLCOLORS,
  FDWALLCOLORS,
  GRIDCOLORS,
  WALLCOLORS,
  WHITE,
  XHAIRCOLORS,
  amClipMline,
  amCxmtof,
  amCymtof,
  amDrawCrosshair,
  amDrawFline,
  amDrawMline,
  amRotateXY,
  drawAutomap,
  PLAYER_ARROW_LINES,
  type AutomapGeom,
  type AutomapMap,
  type AutomapPlayer
} from './automap';
import { Framebuffer } from './framebuffer';

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Naive midpoint rasterizer — deliberately a different formulation from
 * the vanilla port under test: step the dominant axis, other coordinate =
 * round-half-up of the ideal line position (vanilla's d>=0 y-step is
 * exactly round-half-away-from-start on positive magnitudes). */
function naiveBresenham(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  if (dx >= dy) {
    for (let i = 0; i <= dx; i++) {
      plot(x0 + sx * i, y0 + sy * Math.round((dy * i) / dx));
    }
  } else {
    for (let i = 0; i <= dy; i++) {
      plot(x0 + sx * Math.round((dx * i) / dy), y0 + sy * i);
    }
  }
}

function pixelSet(fb: Framebuffer, color: number, w = fb.width, h = fb.height): Set<number> {
  const set = new Set<number>();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (fb.indices[y * w + x] === color) set.add(y * w + x);
    }
  }
  return set;
}

function geom(over: Partial<AutomapGeom> = {}): AutomapGeom {
  return {
    automapactive: true,
    grid: 0,
    cheating: 0,
    lightlev: 0,
    followplayer: 1,
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
    scaleMtof: FRACUNIT, // 1 map unit = 1 px at this window size
    scaleFtom: FRACUNIT,
    markpoints: Array.from({ length: 10 }, () => ({ x: -1, y: -1 })),
    ...over
  };
}

function playerAt(x: number, y: number, angle = 0): AutomapPlayer {
  return { mo: { x: x * FRACUNIT, y: y * FRACUNIT, angle } };
}

/* ------------------------------------------------------------------ */
/* Three-room fixture (units): A(0..256) floor 0 | B(256..512) floor 8  */
/* | C(512..768) floor 8, all ceilings 128. A|B = floor-change,         */
/* B|C = FLAT two-sided, everything else one-sided void walls.          */
/* ------------------------------------------------------------------ */

function threeRoomMap(): AutomapMap {
  const pts: [number, number][] = [
    [0, 0],
    [256, 0],
    [512, 0],
    [768, 0],
    [768, 256],
    [512, 256],
    [256, 256],
    [0, 256]
  ];
  const verticesX = Int32Array.from(pts.map((p) => p[0] * FRACUNIT));
  const verticesY = Int32Array.from(pts.map((p) => p[1] * FRACUNIT));
  const floorHeight = Int32Array.from([0, 8, 8].map((u) => u * FRACUNIT));
  const ceilingHeight = Int32Array.from([128, 128, 128].map((u) => u * FRACUNIT));

  // [v1, v2, frontSector, backSector(-1 = one-sided), special, flags]
  const L: [number, number, number, number, number, number][] = [
    [0, 1, 0, -1, 0, 0], // A bottom
    [1, 6, 0, 1, 0, 0], // A|B divider — floor change
    [6, 7, 0, -1, 0, 0], // A top
    [7, 0, 0, -1, 0, 0], // A left
    [6, 5, 1, -1, 0, 0], // B top
    [5, 4, 1, -1, 0, 0], // C top
    [4, 3, 2, -1, 0, 0], // right wall
    [3, 2, 2, -1, 0, 0], // C bottom
    [2, 5, 1, 2, 0, 0], // B|C divider — FLAT two-sided
    [1, 2, 1, -1, 0, 0] // B+C bottom (one-sided to void; front=sector B)
  ];
  return {
    verticesX,
    verticesY,
    blockmapOriginX: 0,
    blockmapOriginY: 0,
    lines: {
      count: L.length,
      v1: Int32Array.from(L.map((l) => l[0])),
      v2: Int32Array.from(L.map((l) => l[1])),
      flags: Int32Array.from(L.map((l) => l[5])),
      special: Int32Array.from(L.map((l) => l[4])),
      sectorFront: Int32Array.from(L.map((l) => l[2])),
      sectorBack: Int32Array.from(L.map((l) => l[3]))
    },
    sectors: { floorHeight, ceilingHeight }
  };
}

/* ------------------------------------------------------------------ */
/* AM_drawFline port vs naive Bresenham                                 */
/* ------------------------------------------------------------------ */

describe('amDrawFline (AM_drawFline port)', () => {
  it('matches naive integer Bresenham on 400 seeded random segments', () => {
    const rnd = lcg(0x51aba);
    for (let i = 0; i < 400; i++) {
      const w = 40;
      const h = 30;
      const ax = Math.floor(rnd() * w);
      const ay = Math.floor(rnd() * h);
      const bx = Math.floor(rnd() * w);
      const by = Math.floor(rnd() * h);
      const fb = new Framebuffer(w, h);
      expect(amDrawFline(fb, ax, ay, bx, by, 7, w, h)).toBeGreaterThan(0);
      const expected = new Set<number>();
      naiveBresenham(ax, ay, bx, by, (x, y) => expected.add(y * w + x));
      expect(pixelSet(fb, 7)).toEqual(expected);
    }
  });

  it('paints exact runs on the horizontal and vertical cases', () => {
    const fb = new Framebuffer(32, 32);
    expect(amDrawFline(fb, 3, 5, 20, 5, 1, 32, 32)).toBe(18);
    for (let x = 3; x <= 20; x++) expect(fb.indices[5 * 32 + x]).toBe(1);
    expect([...fb.indices].filter((v) => v === 1).length).toBe(18);

    const fb2 = new Framebuffer(32, 32);
    expect(amDrawFline(fb2, 7, 9, 7, 2, 2, 32, 32)).toBe(8); // sy=-1 path
    for (let y = 2; y <= 9; y++) expect(fb2.indices[y * 32 + 7]).toBe(2);
    expect([...fb2.indices].filter((v) => v === 2).length).toBe(8);

    const pt = new Framebuffer(8, 8);
    expect(amDrawFline(pt, 4, 4, 4, 4, 5, 8, 8)).toBe(1); // degenerate
  });

  it('the `fuck` guard skips silently when an endpoint is off-screen', () => {
    const fb = new Framebuffer(16, 16);
    expect(amDrawFline(fb, -1, 0, 5, 5, 9, 16, 16)).toBe(0);
    expect(amDrawFline(fb, 0, 0, 16, 5, 9, 16, 16)).toBe(0);
    expect([...fb.indices].every((v) => v === BACKGROUND)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* amClipMline (render port)                                            */
/* ------------------------------------------------------------------ */

describe('amClipMline (render port)', () => {
  it('accepts fully-inside segments (endpoint transform is exact)', () => {
    const g = geom();
    expect(amClipMline(g, 0, 0, 100 * FRACUNIT, 50 * FRACUNIT)).toBe(true);
    expect(amCxmtof(g, 100 * FRACUNIT)).toBe(100);
    expect(amCymtof(g, 50 * FRACUNIT)).toBe(g.fH - 50);
  });

  it('rejects trivially-outside segments on every side', () => {
    const g = geom();
    expect(amClipMline(g, -200 * FRACUNIT, 0, -100 * FRACUNIT, 10 * FRACUNIT)).toBe(false);
    expect(amClipMline(g, 400 * FRACUNIT, 0, 500 * FRACUNIT, 10 * FRACUNIT)).toBe(false);
    expect(amClipMline(g, 0, -300 * FRACUNIT, 10 * FRACUNIT, -200 * FRACUNIT)).toBe(false);
    expect(amClipMline(g, 0, 400 * FRACUNIT, 10 * FRACUNIT, 500 * FRACUNIT)).toBe(false);
  });

  it('seeded sweep: accepted lines rasterize only inside the fb window', () => {
    const rnd = lcg(0xc1ed);
    const g = geom();
    let accepted = 0;
    for (let i = 0; i < 300; i++) {
      const ax = ((rnd() * 2000 - 800) | 0) * FRACUNIT;
      const ay = ((rnd() * 1200 - 500) | 0) * FRACUNIT;
      const bx = ((rnd() * 2000 - 800) | 0) * FRACUNIT;
      const by = ((rnd() * 1200 - 500) | 0) * FRACUNIT;
      const fb = new Framebuffer(320, 200);
      if (amClipMline(g, ax, ay, bx, by)) {
        accepted++;
        // amDrawMline re-clips internally; use it and inspect the paint:
        const probe = { fb, painted: false };
        void probe;
        amDrawMline(fb, g, ax, ay, bx, by, 200);
        // all painted rows below f_h (rows f_h..199) must stay clear:
        for (let y = g.fH; y < 200; y++) {
          for (let x = 0; x < 320; x++) {
            if (fb.indices[y * 320 + x] === 200) throw new Error(`row ${y} polluted`);
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(30); // the sweep really covered the window
  });
});

/* ------------------------------------------------------------------ */
/* drawAutomap: colors, arrow, grid, crosshair                          */
/* ------------------------------------------------------------------ */

describe('drawAutomap (three-room fixture)', () => {
  const map = threeRoomMap();
  const spawn = playerAt(128, 128, 0);
  const followGeom = (px = 128, py = 128): AutomapGeom =>
    geom({
      mX: (px - 160) * FRACUNIT,
      mY: (py - 84) * FRACUNIT,
      mX2: (px + 160) * FRACUNIT,
      mY2: (py + 84) * FRACUNIT
    });

  function draw(p: AutomapPlayer, over: Partial<AutomapGeom> = {}): Framebuffer {
    const fb = new Framebuffer();
    const base = p === spawn ? followGeom() : followGeom(p.mo.x / FRACUNIT, p.mo.y / FRACUNIT);
    expect(drawAutomap(fb, { ...base, ...over }, map, p)).toBe(true);
    return fb;
  }

  it('one-sided walls paint WALLCOLORS+lightlev (red family)', () => {
    const fb = draw(spawn);
    const reds = [...fb.indices].filter((v) => v >= WALLCOLORS && v < WALLCOLORS + 16).length;
    expect(WALLCOLORS).toBe(176);
    // Visible in the 320x168 window at 1:1: room A's left edge (168 px of
    // the x=0 wall clipped to the window rows); top/bottom edges are out of
    // the y ∈ [44,212] view.
    expect(reds).toBe(168);
  });

  it('floor-change divider paints FDWALLCOLORS+lightlev (BROWNS family)', () => {
    expect(FDWALLCOLORS).toBe(64);
    const fb = draw(spawn);
    // divider x=256 → screen x = 256 - (128-160) = 288, rows across the room
    for (let y = 40; y <= 120; y++) expect(fb.indices[y * 320 + 288]).toBe(FDWALLCOLORS);
    const browns = [...fb.indices].filter((v) => v >= FDWALLCOLORS && v < FDWALLCOLORS + 16).length;
    expect(browns).toBeGreaterThan(50);
  });

  it('flat two-sided divider is invisible with cheating=0', () => {
    // Pan the window to straddle the B|C divider (x=512).
    const fb = draw(playerAt(400, 128));
    const x = 512 - (400 - 160); // screen col of the divider
    let colored = 0;
    for (let y = 40; y <= 120; y++) {
      const v = fb.indices[y * 320 + x]!;
      if (v !== BACKGROUND && v !== WHITE && v !== XHAIRCOLORS) colored++;
    }
    expect(colored).toBe(0);
    // …and the A|B floor-change line on the same frame is visible (control):
    const ctrlX = 256 - (400 - 160);
    let control = 0;
    for (let y = 40; y <= 120; y++) if (fb.indices[y * 320 + ctrlX] === FDWALLCOLORS) control++;
    expect(control).toBeGreaterThan(50);
  });

  it('ceiling-change family never paints on this equal-ceiling fixture', () => {
    const fb = draw(spawn);
    expect(CDWALLCOLORS).toBe(231);
    expect([...fb.indices].some((v) => v >= CDWALLCOLORS && v < CDWALLCOLORS + 1)).toBe(false);
  });

  it('player arrow: WHITE pixels at the expected screen position', () => {
    const fb = draw(spawn);
    const whites = pixelSet(fb, WHITE);
    expect(WHITE).toBe(209);
    expect(whites.size).toBeGreaterThan(20);
    // player (128,128) → screen (160, 84); angle 0 ⇒ shaft along row 84
    // from x=144 (tail −R+R/8) to x=178 (tip +R), R = (8·16)/7 ≈ 18 px:
    expect(whites.has(84 * 320 + 178)).toBe(true); // tip
    expect(whites.has(84 * 320 + 144)).toBe(true); // tail
    // vanilla draw ORDER quirk: the crosshair point lands exactly on the
    // arrow center (fb index (f_w*(f_h+1))/2 = row 84, col 160) and wins:
    expect(fb.indices[84 * 320 + 160]).toBe(XHAIRCOLORS);
    // barb vertices off the shaft row exist too:
    expect(whites.has((84 - 4) * 320 + (178 - 9))).toBe(true); // R/2 barb
  });

  it('arrow rotates with the player angle (north ⇒ tip above center)', () => {
    const fb = draw(playerAt(128, 128, 0x40000000)); // ANG90
    const whites = pixelSet(fb, WHITE);
    const R = ((8 * 16 * FRACUNIT) / 7) | 0;
    const tip = amRotateXY(R, 0, 0x40000000);
    // Vanilla table artifact kept: finecosine[2048] = -25 (the 180° table
    // step), so the north tip lands one px LEFT of the center column.
    expect(Math.abs(tip[0])).toBeLessThan(1000);
    expect(tip[1]).toBeGreaterThan(R - 100);
    const tipX = 160 + (tip[0] >> 16);
    const tipY = 84 - (tip[1] >> 16);
    expect(tipX).toBe(159); // 160 + floor(-457/65536) = 159 (truncation quirk)
    expect(tipY).toBe(66);
    expect(whites.has(tipY * 320 + tipX)).toBe(true);
    // shaft vertical: mid-shaft white, east direction empty:
    expect(whites.has(70 * 320 + 159) || whites.has(70 * 320 + 160)).toBe(true);
    expect(whites.has(84 * 320 + 170)).toBe(false);
  });

  it('grid ON paints GRIDCOLORS at every MAPBLOCKUNITS boundary', () => {
    const fb = draw(spawn, { grid: 1 });
    const g = followGeom();
    // C-truncated start advance (am_map.c % quirk): window x ∈ [-32,288],
    // y ∈ [44,212] ⇒ first vertical line at x=128 (screen 160) and first
    // horizontal at y=128 (fb row 84).
    const sx = amCxmtof(g, 128 * FRACUNIT);
    expect(sx).toBe(160);
    let vhits = 0;
    for (let y = 20; y < 160; y++) if (fb.indices[y * 320 + sx] === GRIDCOLORS) vhits++;
    expect(vhits).toBeGreaterThan(80); // full column minus arrow/wall overlap
    let hits = 0;
    for (let x = 100; x < 140; x++) if (fb.indices[84 * 320 + x] === GRIDCOLORS) hits++;
    expect(hits).toBe(40); // grid row away from the arrow/walls stays pure
  });

  it('crosshair: the single vanilla flat-index pixel is GRAYS', () => {
    const fb = new Framebuffer();
    const g = geom();
    amDrawCrosshair(fb, g);
    expect(fb.indices[(g.fW * (g.fH + 1)) / 2]).toBe(XHAIRCOLORS);
    expect([...fb.indices].filter((v) => v !== BACKGROUND).length).toBe(1);
  });

  it('returns false and leaves the buffer alone when the map is off', () => {
    const fb = new Framebuffer();
    fb.clear(3);
    expect(drawAutomap(fb, geom({ automapactive: false }), map, spawn)).toBe(false);
    expect([...fb.indices].every((v) => v === 3)).toBe(true);
  });
});

describe('PLAYER_ARROW_LINES', () => {
  it('is the 7-segment am_map.c player_arrow', () => {
    expect(PLAYER_ARROW_LINES.length).toBe(7 * 4);
  });
});
