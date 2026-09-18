/**
 * render/planes tests (M4-plan §M4-01) — visplane engine acceptance:
 *  1. R_FindPlane merge / sky-collapse / R_CheckPlane copy-split vectors,
 *     INCLUDING the non-shrunk source plane (§0.2 pinned truth) and the
 *     all-unset-intersection widen;
 *  2. R_MakeSpans emits every row-span EXACTLY ONCE across adjacent columns
 *     (analytic 2-plane overlap: 6-column staircase, per-cell coverage
 *     reconstruction from the R_MapPlane emit log) + the pure 4-loop edge
 *     vectors read from r_plane.c:358-386 (loop1 closes t1..b1, loop4 arms
 *     b2..b1+1 — loops 2/3 fire only on b1-b2 regressions);
 *  3. R_MapPlane texel goldens vs a BigInt oracle at the KNOWN
 *     yslope/distscale tables (themselves BigInt-pinned here against
 *     R_ExecuteSetViewSize), flat spot = row-major 64·64 per §0.5;
 *  4. a ceiling plane marked ATOP a floor plane wins per pixel (creation
 *     order = draw order, later paints over earlier);
 *  5. MAXVISPLANES 128 liveness: 129th R_FindPlane AND a checkPlane split
 *     on a full table raise the typed error AND bump
 *     getRenderCounters().visplaneOverflow (M3-03 counter pattern; vanilla
 *     I_Error / silent corruption respectively — documented deviation).
 *
 * Plus: R_ClearPlanes state vectors, the sky-texture branch of
 * R_DrawPlanes (§0.3: fullbright colormaps[0], iscale = pspriteiscale,
 * texturemid = 100·FRACUNIT, angle >> 22), and the picnum ≥ 0 placeholder
 * guard (NO_FLAT −1 must NEVER collapse into the sky plane).
 *
 * Test isolation: resetPlanesForTests() before every case — production
 * never clears `bottom` (vanilla BSS/stale semantics, planes.ts header);
 * tests that care about the stale-bottom edge set it explicitly.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { ANG90, ANGLETOFINESHIFT, FRACUNIT } from '../core/constants';
import { FixedDiv } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import { COLORMAP_BYTES } from '../wad/palettes';
import { MAXLIGHTZ, initLightTables } from './lights';
import {
  ANGLETOSKYSHIFT,
  MAXVISPLANES,
  NO_FLAT,
  SKYTEXTUREMID,
  VisplaneOverflowError,
  checkPlane,
  clearPlanes,
  drawPlanes,
  findPlane,
  getCeilingplane,
  getFloorplane,
  makeSpans,
  markColumn,
  planeAt,
  planeBottom,
  planeCount,
  planeHeight,
  planeLight,
  planeMaxx,
  planeMinx,
  planePic,
  planeTop,
  planesDebugState,
  resetPlanesForTests,
  setCeilingplane,
  setFloorplane,
  setSkyflatnum,
  type PlaneDrawCtx,
  type Visplane,
} from './planes';
import { getRenderCounters, resetRenderCounters } from './solidsegs';
import { ceilingclip, floorclip } from './drawsegs';
import {
  CENTERXFRAC,
  VIEWHEIGHT,
  VIEWWIDTH,
  createViewState,
  initTextureMapping,
  setupView,
  type ViewState,
} from './view';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

const B = (n: number): bigint => BigInt(n);
const MASK32 = 0xffffffffn;

/** int32 from any BigInt (mod 2^32, signed) — gcc's truncation. */
function i32(b: bigint): number {
  const m = ((b % (MASK32 + 1n)) + MASK32 + 1n) % (MASK32 + 1n);
  return Number(m > 0x7fffffffn ? m - (MASK32 + 1n) : m);
}

/** m_fixed.c FixedMul via EXACT 64-bit product: (a*b) >> 16, low 32 bits.
 * (BigInt >> is arithmetic floor — matches C >> on the signed product.) */
function bigFixedMul(a: number, b: number): number {
  return i32((B(a) * B(b)) >> 16n);
}

/** FixedDiv double path (guards verified non-firing for the inputs here). */
function bigFixedDiv(a: number, b: number): number {
  return i32((B(a) * B(FRACUNIT)) / B(b)); // exact-quotient trunc toward 0
}

/** colormaps where byte at (row,col) = (row + col) & 255 — the drawn
 * pixel reveals WHICH light row was selected (zlight/fixedcolormap
 * selection is observable, not just the texel). */
function distinctRowsColormaps(): Uint8Array {
  const c = new Uint8Array(COLORMAP_BYTES);
  for (let i = 0; i < c.length; i += 1) c[i] = ((i >> 8) + (i & 255)) & 255;
  return c;
}

const tables = initLightTables(distinctRowsColormaps());

/** flat[p] = (p*7)&255 — 7 is odd ⇒ invertible mod 256 (collision-free
 * for the ≤256 distinct spots any test row walk touches… sanity anyway). */
function rampFlat(): Uint8Array {
  const f = new Uint8Array(4096);
  for (let p = 0; p < 4096; p += 1) f[p] = Math.imul(p, 7) & 255;
  return f;
}
const RAMP_A = rampFlat();
const RAMP_B = (() => {
  const f = new Uint8Array(4096);
  for (let p = 0; p < 4096; p += 1) f[p] = (Math.imul(p, 7) + 1) & 255; // +1 tag
  return f;
})();

const flatByPic = (pic: number): Uint8Array | undefined =>
  pic === 1 ? RAMP_A : pic === 2 ? RAMP_B : pic === NO_FLAT ? RAMP_A : undefined;

function makeCtx(
  view: ViewState,
  indices: Uint8Array,
  extra: Partial<PlaneDrawCtx> = {}
): PlaneDrawCtx {
  return { view, indices, tables, getFlat: flatByPic, ...extra };
}

function spawnView(x = 0, y = 0, angle = 0, z = 0): ViewState {
  const v = createViewState();
  setupView(v, { x: x | 0, y: y | 0, angle: angle >>> 0, z });
  return v;
}

function allocDistinctPlanes(n: number, pic = NO_FLAT, light = 160): Visplane[] {
  const out: Visplane[] = [];
  for (let i = 0; i < n; i += 1) out.push(findPlane(i * FRACUNIT, pic, light));
  return out;
}

/** Vanilla R_RenderSegLoop marking flow: R_CheckPlane for the drawn range
 * (updates minx/maxx or splits), then the top/bottom writes. topFor/bottom-
 * For default to constants. Returns the plane that owns the marks. */
function markSpan(
  pl: Visplane,
  x1: number,
  x2: number,
  top: number | ((x: number) => number) = 5,
  bottom: number | ((x: number) => number) = 10
): Visplane {
  const p = checkPlane(pl, x1, x2);
  for (let x = x1; x <= x2; x += 1) {
    markColumn(
      p,
      x,
      typeof top === 'number' ? top : top(x),
      typeof bottom === 'number' ? bottom : bottom(x)
    );
  }
  return p;
}

beforeEach(() => {
  resetPlanesForTests();
  resetRenderCounters();
});

/* ------------------------------------------------------------------ */
/* R_ClearPlanes                                                      */
/* ------------------------------------------------------------------ */

describe('R_ClearPlanes (r_plane.c:206-235)', () => {
  it('seeds clips, zeroes the plane list + cachedheight, sets base scales', () => {
    floorclip.fill(7);
    ceilingclip.fill(9);
    planesDebugState().cachedheight.fill(123);
    const view = spawnView(0, 0, 0x3b9aca00); // arbitrary angle
    clearPlanes(view);

    expect(floorclip.every((v) => v === VIEWHEIGHT)).toBe(true);
    expect(ceilingclip.every((v) => v === -1)).toBe(true);
    expect(planeCount()).toBe(0);
    expect(getFloorplane()).toBeNull();
    expect(getCeilingplane()).toBeNull();
    expect(planesDebugState().cachedheight.every((v) => v === 0)).toBe(true);

    // basexscale/baseyscale = ±FixedDiv(fine|cos/sine[(viewangle−ANG90)>>19],
    // centerxfrac) — reference via the same tables, independent expression.
    const a = ((view.viewangle - ANG90) >>> 0) >>> ANGLETOFINESHIFT;
    expect(planesDebugState().basexscale).toBe(FixedDiv(finecosine[a]!, CENTERXFRAC));
    expect(planesDebugState().baseyscale).toBe(-FixedDiv(finesine[a]!, CENTERXFRAC));
  });

  it('planes opened before the clear are gone; handles are re-allocated fresh', () => {
    const p = findPlane(64 * FRACUNIT, 1, 128);
    markSpan(p, 12, 12, 40, 90);
    expect(planeCount()).toBe(1);
    clearPlanes(spawnView());
    expect(planeCount()).toBe(0);
    const q = findPlane(64 * FRACUNIT, 1, 128);
    expect(q.idx).toBe(0); // creation order restarts
    expect(planeTop(q, 12)).toBe(0xff); // memset on allocation
    void planeMinx(p); // (source handle now refers to the NEW slot — vanilla alias)
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 1 — R_FindPlane + R_CheckPlane                           */
/* ------------------------------------------------------------------ */

describe('R_FindPlane (acceptance 1)', () => {
  it('merges on the exact (height,pic,light) triple — each field alone splits', () => {
    const a = findPlane(64 * FRACUNIT, 1, 160);
    expect(findPlane(64 * FRACUNIT, 1, 160).idx).toBe(a.idx); // merge
    const h = findPlane(65 * FRACUNIT, 1, 160);
    const p = findPlane(64 * FRACUNIT, 2, 160);
    const l = findPlane(64 * FRACUNIT, 1, 144);
    expect(new Set([a.idx, h.idx, p.idx, l.idx]).size).toBe(4);
    expect(planeCount()).toBe(4);
  });

  it('new plane starts minx=SCREENWIDTH, maxx=−1 with top memset 0xff', () => {
    const a = findPlane(0, 1, 128);
    expect(planeMinx(a)).toBe(320);
    expect(planeMaxx(a)).toBe(-1);
    for (let x = 0; x < 320; x += 37) expect(planeTop(a, x)).toBe(0xff);
  });

  it('sky collapse: sky pic forces height=0/light=0 and merges ALL skys', () => {
    setSkyflatnum(5);
    const s1 = findPlane(128 * FRACUNIT, 5, 192);
    expect(planeHeight(s1)).toBe(0); // collapsed
    expect(planeLight(s1)).toBe(0);
    expect(planePic(s1)).toBe(5); // pic kept — the merge key IS the sky tag
    expect(findPlane(64 * FRACUNIT, 5, 0).idx).toBe(s1.idx); // any height/light
    expect(findPlane(0, 5, 255).idx).toBe(s1.idx);
    // a NON-sky pic never collapses, even at height 0 / light 0:
    const g = findPlane(128 * FRACUNIT, 1, 192);
    expect(g.idx).not.toBe(s1.idx);
    expect(planeHeight(g)).toBe(128 * FRACUNIT);
  });

  it('placeholder guard: NO_FLAT (−1) picnum NEVER collapses (M4-02 seam)', () => {
    // unwired skyflatnum (−1) must not match the −1 placeholder picnum:
    const a = findPlane(64 * FRACUNIT, NO_FLAT, 160);
    expect(planeHeight(a)).toBe(64 * FRACUNIT);
    expect(planeLight(a)).toBe(160);
    // wired skyflatnum: still no match for −1.
    setSkyflatnum(9);
    const b = findPlane(64 * FRACUNIT, NO_FLAT, 160);
    expect(b.idx).toBe(a.idx); // plain merge, NOT the sky plane
  });
});

describe('R_CheckPlane (acceptance 1: copy-split, source NOT shrunk)', () => {
  function markedPlane(): Visplane {
    const pl = findPlane(32 * FRACUNIT, 1, 128);
    return markSpan(pl, 10, 20, 50, 60); // widens [320,−1] ⇒ [10,20] + marks
  }

  it('all-unset intersection ⇒ SAME plane widened to the union', () => {
    const pl = findPlane(32 * FRACUNIT, 1, 128); // unmarked
    const same = checkPlane(pl, 10, 20);
    expect(same.idx).toBe(pl.idx);
    expect(planeMinx(pl)).toBe(10);
    expect(planeMaxx(pl)).toBe(20);
    const wider = checkPlane(pl, 5, 30); // intersection 10..20 all 0xff
    expect(wider.idx).toBe(pl.idx);
    expect([planeMinx(pl), planeMaxx(pl)]).toEqual([5, 30]);
    expect(planeCount()).toBe(1);
  });

  it('marked intersection ⇒ COPY-split: attrs copied, source range UNCHANGED', () => {
    const pl = markedPlane();
    const n = checkPlane(pl, 5, 30); // top[15] marked in the intersection
    expect(n.idx).not.toBe(pl.idx);
    expect(planeCount()).toBe(2);
    // attributes copied verbatim (the §0.2 copy-split truth):
    expect([planeHeight(n), planePic(n), planeLight(n)]).toEqual([
      planeHeight(pl),
      planePic(pl),
      planeLight(pl),
    ]);
    expect([planeMinx(n), planeMaxx(n)]).toEqual([5, 30]);
    // NON-SHRUNK SOURCE: pl keeps [10,20] + its marks (not unioned):
    expect([planeMinx(pl), planeMaxx(pl)]).toEqual([10, 20]);
    expect(planeTop(pl, 15)).toBe(50);
    expect(planeTop(pl, 10)).toBe(50);
    // new slot is memset 0xff across the FULL width (not just its range):
    for (let x = 0; x < 320; x += 29) expect(planeTop(n, x)).toBe(0xff);
  });

  it('split with start INSIDE the marked range: new owns [start,stop]', () => {
    const pl = findPlane(0, 1, 0);
    markSpan(pl, 10, 20, 1, 2);
    const n = checkPlane(pl, 0, 12); // intersection 10..12 marked ⇒ split
    expect(n.idx).not.toBe(pl.idx);
    expect([planeMinx(n), planeMaxx(n)]).toEqual([0, 12]);
    expect([planeMinx(pl), planeMaxx(pl)]).toEqual([10, 20]); // not shrunk
  });

  it('disjoint extension (intrl > intrh): loop vacates ⇒ widen, same plane', () => {
    const pl = findPlane(0, 1, 0);
    markSpan(pl, 100, 110, 5, 6);
    const n = checkPlane(pl, 0, 50); // stop(50) < minx(100): intrh=50 < intrl=100
    expect(n.idx).toBe(pl.idx);
    expect([planeMinx(pl), planeMaxx(pl)]).toEqual([0, 110]);
    expect(planeCount()).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 2 — R_MakeSpans exactly-once                             */
/* ------------------------------------------------------------------ */

describe('R_MakeSpans (acceptance 2)', () => {
  it('pure 4-loop vectors: loop1 closes t1..b1 at x−1, loop4 arms b2..b1+1', () => {
    const emit: [number, number, number][] = [];
    // t2 jumps up: rows 100..110 close; loop4 arms b2 down to max(t2,b1+1)
    // ⇒ rows 120..130 (t2 = 120 binds before b1+1 = 111).
    makeSpans(10, 100, 110, 120, 130, (y, x1, x2) => emit.push([y, x1, x2]));
    expect(emit.length).toBe(11); // rows 100..110 (t1 <= b1 inclusive)
    for (let y = 100; y <= 110; y += 1) expect(emit[y - 100][0]).toBe(y);
    expect(emit.every(([, , x2]) => x2 === 9)).toBe(true); // x−1
    expect(planesDebugState().spanstart.slice(120, 131).every((v) => v === 10)).toBe(true);
    expect(planesDebugState().spanstart.slice(111, 120).every((v) => v === 0)).toBe(true);
    // loop2/3 fire only on regressions: b1/b2 monotonic here ⇒ no extra.
  });

  it('staircase overlap: every marked cell of a 2-range plane covered ONCE', () => {
    const view = spawnView();
    clearPlanes(view);
    const pl = findPlane(0, NO_FLAT, 128);
    const spans: [number, number, number][] = [];
    // columns 0..4: rows 100..110; columns 5..9: rows 105..115 (overlap band).
    markSpan(
      pl,
      0,
      9,
      (x) => (x <= 4 ? 100 : 105),
      (x) => (x <= 4 ? 110 : 115)
    );
    const indices = new Uint8Array(VIEWWIDTH * VIEWHEIGHT).fill(0xee);
    drawPlanes(makeCtx(view, indices, { onMapPlane: (_p, y, x1, x2) => spans.push([y, x1, x2]) }));

    // Expected analytic spans (hand-traced from the 4 loops):
    //  rows 100..104 close at x=5 ⇒ [0,4]; rows 105..110 stay open through
    //  the overlap ⇒ closed at x=10 ⇒ [0,9]; rows 111..115 armed at x=5 ⇒
    //  [5,9]. Exactly-once = every (row,column) marked cell appears once.
    const expected = new Map<string, 0>();
    for (let x = 0; x <= 9; x += 1) {
      const t = x <= 4 ? 100 : 105;
      const b = x <= 4 ? 110 : 115;
      for (let y = t; y <= b; y += 1) expected.set(`${y},${x}`, 0);
    }
    const coverage = new Map<string, number>();
    for (const [y, x1, x2] of spans) {
      expect(x2).toBeGreaterThanOrEqual(x1); // never inverted
      for (let x = x1; x <= x2; x += 1) {
        const k = `${y},${x}`;
        coverage.set(k, (coverage.get(k) ?? 0) + 1);
      }
    }
    expect(coverage.size).toBe(expected.size); // every marked cell drawn…
    for (const k of expected.keys()) expect(coverage.get(k)).toBe(1); // …exactly once
  });

  it('span closure uses spanstart from the ARMING column, not the closing one', () => {
    const view = spawnView();
    clearPlanes(view);
    const pl = findPlane(0, NO_FLAT, 128);
    markSpan(pl, 20, 25, 90, 90); // single row
    const spans: [number, number, number][] = [];
    const indices = new Uint8Array(VIEWWIDTH * VIEWHEIGHT);
    drawPlanes(makeCtx(view, indices, { onMapPlane: (_p, y, x1, x2) => spans.push([y, x1, x2]) }));
    expect(spans).toEqual([[90, 20, 25]]); // ONE span [arming, closing−1]
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 3 — R_MapPlane texel goldens vs BigInt oracle            */
/* ------------------------------------------------------------------ */

describe('R_MapPlane goldens vs BigInt oracle (acceptance 3)', () => {
  const MAP = initTextureMapping();

  it('yslope/distscale match the R_ExecuteSetViewSize BigInt reference', () => {
    for (let i = 0; i < VIEWHEIGHT; i += 1) {
      let dy = (((i - VIEWHEIGHT / 2) << 16) + FRACUNIT / 2) | 0;
      if (dy < 0) dy = -dy;
      expect(MAP.yslope[i]).toBe(bigFixedDiv(CENTERXFRAC, dy));
    }
    for (let x = 0; x < VIEWWIDTH; x += 1) {
      const cosadj = Math.abs(finecosine[MAP.xtoviewangle[x]! >>> ANGLETOFINESHIFT]!);
      expect(cosadj).toBeGreaterThan(0); // no SIGFPE inputs at full res
      expect(MAP.distscale[x]).toBe(bigFixedDiv(FRACUNIT, cosadj));
    }
    expect(MAP.pspriteiscale).toBe(FRACUNIT);
  });

  it('every floor texel pixel equals the oracle (distance/steps/spot/zlight row)', () => {
    const view = spawnView(96 * FRACUNIT, (40 * FRACUNIT) | 0, 0x12345678);
    clearPlanes(view);
    const pl = findPlane(0, NO_FLAT, 128); // floor height 0, light 128
    markSpan(pl, 50, 270, 150, 180);
    const indices = new Uint8Array(VIEWWIDTH * VIEWHEIGHT).fill(0xee);
    drawPlanes(makeCtx(view, indices));

    // --- independent oracle (BigInt FixedMul on the KNOWN tables) ---
    const planeheight = Math.abs(0 - view.viewz); // floor 0, viewz = 41<<16
    expect(planeheight).toBe(41 * FRACUNIT);
    const dbg = planesDebugState();
    const a0 = ((view.viewangle - ANG90) >>> 0) >>> ANGLETOFINESHIFT;
    const bxs = bigFixedDiv(finecosine[a0]!, CENTERXFRAC);
    const bys = i32(-B(bigFixedDiv(finesine[a0]!, CENTERXFRAC)));
    expect(dbg.basexscale).toBe(bxs);
    expect(dbg.baseyscale).toBe(bys);

    const lightRow = (128 >> 4) * MAXLIGHTZ; // lightlevel 128 ⇒ row 8
    const check = (y: number, x: number, x1: number): void => {
      const dist = bigFixedMul(planeheight, MAP.yslope[y]!);
      const xstep = bigFixedMul(dist, bxs);
      const ystep = bigFixedMul(dist, bys);
      const length = bigFixedMul(dist, MAP.distscale[x1]!);
      const ang = ((view.viewangle + MAP.xtoviewangle[x1]!) >>> 0) >>> ANGLETOFINESHIFT;
      const xfrac = i32(B(view.viewx) + B(bigFixedMul(finecosine[ang]!, length)));
      const yfrac = i32(-B(view.viewy) - B(bigFixedMul(finesine[ang]!, length)));
      const d = BigInt(x - x1);
      const xf = i32(B(xfrac) + d * B(xstep));
      const yf = i32(B(yfrac) + d * B(ystep));
      const spot = (((yf >> (16 - 6)) & (63 * 64)) + ((xf >> 16) & 63)) | 0;
      let zindex = dist >> 20; // LIGHTZSHIFT = 20
      if (zindex >= MAXLIGHTZ) zindex = MAXLIGHTZ - 1;
      const cmapLevel = tables.zlight[lightRow + zindex]! >> 8; // level*256 → level
      const expected = (cmapLevel + RAMP_A[spot]!) & 255;
      expect(indices[y * VIEWWIDTH + x]).toBe(expected);
      // cache golden (per-y distance computed once, exactly the oracle):
      expect(dbg.cacheddistance[y]).toBe(dist);
    };

    // x1 = spanstart = 50 (arming column) for every row of this plane:
    for (const [y, x] of [
      [150, 50],
      [150, 51],
      [163, 97],
      [170, 200],
      [180, 270],
    ] as const) {
      check(y, x, 50);
    }
    // Rows OUTSIDE the marks stay untouched:
    for (const y of [149, 181]) {
      expect(indices[y * VIEWWIDTH + 100]).toBe(0xee);
    }
  });

  it('per-y cache: second frame with the SAME planeheight reuses distance', () => {
    const view = spawnView(0, 0, 1234);
    clearPlanes(view);
    const pl = findPlane(64 * FRACUNIT, NO_FLAT, 160);
    markSpan(pl, 0, 20, 120, 125);
    const indices = new Uint8Array(VIEWWIDTH * VIEWHEIGHT);
    drawPlanes(makeCtx(view, indices));
    const d170 = planesDebugState().cacheddistance[170]; // untouched row stays 0
    expect(planesDebugState().cachedheight[170]).toBe(0);
    void d170;
    const before = planesDebugState().cacheddistance[120]!;
    drawPlanes(makeCtx(view, indices)); // same planeheight ⇒ cached path
    expect(planesDebugState().cacheddistance[120]).toBe(before);
    // different planeheight ⇒ recompute (vanilla `planeheight != cachedheight[y]`):
    const pl2 = findPlane(65 * FRACUNIT, NO_FLAT, 160);
    markSpan(pl2, 0, 20, 120, 125);
    drawPlanes(makeCtx(view, indices));
    expect(planesDebugState().cacheddistance[120]).not.toBe(before);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 4 — ceiling marked atop floor wins per pixel             */
/* ------------------------------------------------------------------ */

describe('draw order = creation order (acceptance 4)', () => {
  // Same height, different pics ⇒ distinct planes with IDENTICAL mapping
  // geometry ⇒ the oracle spot of both planes at (y,x) is the same texel;
  // RAMP_B = RAMP_A + 1 makes the winner directly observable in the LSB.
  const H = 64 * FRACUNIT;
  function runBoth(order: 'floor-first' | 'ceil-first'): {
    indices: Uint8Array;
    view: ViewState;
  } {
    const view = spawnView(96 * FRACUNIT, (40 * FRACUNIT) | 0, 0x0badc0de);
    clearPlanes(view);
    const mkFloor = (): Visplane => findPlane(H, 1, 128);
    const mkCeil = (): Visplane => findPlane(H, 2, 128);
    const [floor, ceil] =
      order === 'floor-first' ? [mkFloor(), mkCeil()] : [mkCeil(), mkFloor()];
    markSpan(floor, 40, 60, 130, 150); // both planes mark the SAME cells
    markSpan(ceil, 40, 60, 130, 150); // ("ceiling marked atop floor")
    const indices = new Uint8Array(VIEWWIDTH * VIEWHEIGHT).fill(0xee);
    drawPlanes(makeCtx(view, indices));
    return { indices, view };
  }

  /** Oracle texel of the shared geometry at (y,x), span-armed at x1=40. */
  function oracleFlat(view: ViewState, y: number, x: number): number {
    const m = initTextureMapping();
    const x1 = 40;
    const planeheight = Math.abs(H - view.viewz);
    const dist = bigFixedMul(planeheight, m.yslope[y]!);
    const a0 = ((view.viewangle - ANG90) >>> 0) >>> ANGLETOFINESHIFT;
    const bxs = bigFixedDiv(finecosine[a0]!, CENTERXFRAC);
    const bys = i32(-B(bigFixedDiv(finesine[a0]!, CENTERXFRAC)));
    const xstep = bigFixedMul(dist, bxs);
    const ystep = bigFixedMul(dist, bys);
    const length = bigFixedMul(dist, m.distscale[x1]!);
    const ang = ((view.viewangle + m.xtoviewangle[x1]!) >>> 0) >>> ANGLETOFINESHIFT;
    const xfrac = i32(B(view.viewx) + B(bigFixedMul(finecosine[ang]!, length)));
    const yfrac = i32(-B(view.viewy) - B(bigFixedMul(finesine[ang]!, length)));
    const d = BigInt(x - x1);
    const xf = i32(B(xfrac) + d * B(xstep));
    const yf = i32(B(yfrac) + d * B(ystep));
    const spot = (((yf >> (16 - 6)) & (63 * 64)) + ((xf >> 16) & 63)) | 0;
    let zindex = dist >> 20;
    if (zindex >= MAXLIGHTZ) zindex = MAXLIGHTZ - 1;
    return ((tables.zlight[(128 >> 4) * MAXLIGHTZ + zindex]! >> 8) + RAMP_A[spot]!) & 255;
  }

  it('ceiling opened AFTER the floor wins every shared pixel (drawn last)', () => {
    const { indices, view } = runBoth('floor-first');
    for (const y of [130, 140, 150]) {
      for (const x of [40, 45, 60]) {
        // winner = RAMP_B = floor value + 1 (mod 256): later plane paints.
        expect(indices[y * VIEWWIDTH + x]).toBe((oracleFlat(view, y, x) + 1) & 255);
      }
    }
    expect(indices[129 * VIEWWIDTH + 50]).toBe(0xee); // outside marks: void
  });

  it('reversed creation order ⇒ the OTHER plane wins (pure draw-order rule)', () => {
    const { indices, view } = runBoth('ceil-first');
    for (const y of [130, 140, 150]) {
      for (const x of [40, 45, 60]) {
        expect(indices[y * VIEWWIDTH + x]).toBe(oracleFlat(view, y, x)); // RAMP_A now last
      }
    }
  });

  it('unmarked planes (minx > maxx) contribute nothing', () => {
    const view = spawnView();
    clearPlanes(view);
    findPlane(0, 1, 128); // opened but never marked (no seg drew it)
    const indices = new Uint8Array(VIEWWIDTH * VIEWHEIGHT).fill(7);
    const spans: unknown[] = [];
    drawPlanes(makeCtx(view, indices, { onMapPlane: (...a) => spans.push(a) }));
    expect(spans.length).toBe(0);
    expect(indices.every((v) => v === 7)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 5 — MAXVISPLANES 128 liveness                            */
/* ------------------------------------------------------------------ */

describe('visplane overflow (acceptance 5: counter + typed throw)', () => {
  it('the 129th distinct R_FindPlane throws + bumps visplaneOverflow', () => {
    allocDistinctPlanes(MAXVISPLANES);
    expect(planeCount()).toBe(128);
    expect(() => findPlane(9999 * FRACUNIT, 3, 0)).toThrow(VisplaneOverflowError);
    expect(getRenderCounters().visplaneOverflow).toBe(1);
    expect(planeCount()).toBe(128); // table state untouched
  });

  it('checkPlane split on a FULL table: same counter (vanilla: silent overrun)', () => {
    const ps = allocDistinctPlanes(MAXVISPLANES);
    checkPlane(ps[0]!, 5, 5); // widen path needs no slot — ok on a full table
    markColumn(ps[0]!, 5, 10, 20);
    expect(() => checkPlane(ps[0]!, 0, 10)).toThrow(VisplaneOverflowError);
    expect(getRenderCounters().visplaneOverflow).toBe(1);
    expect(planeCount()).toBe(MAXVISPLANES);
  });

  it('merge/split within budget does NOT touch the counter', () => {
    allocDistinctPlanes(127);
    expect(findPlane(5 * FRACUNIT, 7, 7).idx).toBeGreaterThanOrEqual(0);
    expect(getRenderCounters().visplaneOverflow).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Sky branch (plan §0.3)                                              */
/* ------------------------------------------------------------------ */

describe('R_DrawPlanes sky branch (§0.3 textured sky)', () => {
  it('per-column: angle = (viewangle+xtoviewangle[x])>>22, fullbright, mid 100', () => {
    setSkyflatnum(5);
    const view = spawnView(0, 0, 0x55555555);
    clearPlanes(view);
    const sky = findPlane(128 * FRACUNIT, 5, 192); // collapses to (0,·,0)
    markSpan(sky, 100, 120, 90, 95);
    const indices = new Uint8Array(VIEWWIDTH * VIEWHEIGHT).fill(0xee);
    const skyColumn = (a: number): Uint8Array => {
      const c = new Uint8Array(128);
      for (let r = 0; r < 128; r += 1) c[r] = (a + r * 3) & 255;
      return c;
    };
    const seen: number[] = [];
    drawPlanes(
      makeCtx(view, indices, {
        getSkyColumn: (a) => {
          seen.push(a);
          return skyColumn(a);
        },
      })
    );
    expect(seen.length).toBe(21);
    let k = 0;
    for (let x = 100; x <= 120; x += 1) {
      const angle = seen[k]!;
      expect(angle).toBe(((view.viewangle + MAPX.xtoviewangle[x]!) >>> 0) >>> ANGLETOSKYSHIFT);
      // texel row r = (100·FRACUNIT + (90−100)·FRACUNIT + n·FRACUNIT)>>16
      //             = 90…95 ⇒ value = (angle + row·3) & 255; fullbright row 0.
      for (let y = 90; y <= 95; y += 1) {
        expect(indices[y * VIEWWIDTH + x]).toBe((angle + y * 3) & 255);
      }
      expect(indices[89 * VIEWWIDTH + x]).toBe(0xee); // unmarked rows untouched
      k += 1;
    }
    expect(SKYTEXTUREMID).toBe(100 * FRACUNIT);
  });

  it('no sky provider wired ⇒ sky plane draws nothing (M4-04 seam)', () => {
    setSkyflatnum(5);
    const view = spawnView();
    clearPlanes(view);
    const sky = findPlane(0, 5, 0);
    markSpan(sky, 10, 20, 5, 10);
    const indices = new Uint8Array(VIEWWIDTH * VIEWHEIGHT).fill(9);
    drawPlanes(makeCtx(view, indices));
    expect(indices.every((v) => v === 9)).toBe(true);
  });
});

const MAPX = initTextureMapping();

/* ------------------------------------------------------------------ */
/* Seam: floor/ceilingplane globals                                    */
/* ------------------------------------------------------------------ */

describe('floorplane/ceilingplane globals (bsp.ts writes these)', () => {
  it('set/get round-trip; findPlane results are stable handles', () => {
    const a = findPlane(0, NO_FLAT, 0);
    setFloorplane(a);
    const c = findPlane(FRACUNIT * 200, NO_FLAT, 0);
    setCeilingplane(c);
    expect(getFloorplane()?.idx).toBe(a.idx);
    expect(getCeilingplane()?.idx).toBe(c.idx);
    expect(findPlane(0, NO_FLAT, 0).idx).toBe(planeAt(a.idx).idx);
    setFloorplane(null);
    setCeilingplane(null);
    expect(getFloorplane()).toBeNull();
    expect(getCeilingplane()).toBeNull();
    expect(planeBottom(a, 0)).toBe(0); // bottoms NEVER memset (BSS parity)
  });
});
