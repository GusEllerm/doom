/**
 * render/cols tests (M3-plan §M3-05): R_DrawColumn (r_draw.c:105-149) —
 * the dc_* singleton, the verbatim `frac` walk (frac init PLAIN int mult,
 * no FixedMul; `&127` row mask verbatim from r_draw.c:140), the inclusive
 * do/while(count--) span (rows yl..yh, count+1 px), and the G12 unsigned
 * `0xffffffffu / scale` policy (M3-plan §3), BigInt-pinned.
 *
 * Acceptance: 1) hand-computed 40-px column golden, 2) negative-frac wrap
 * == `&127` C behavior, 3) iscale known vectors, 4) no allocation per
 * call (100k-call smoke: correctness + timing).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { COLORMAP_BYTES } from '../wad/palettes';
import { computeIscale, dc, drawColumn, type Dc } from './cols';
import { RENDER_HEIGHT, RENDER_WIDTH } from './framebuffer';

/* ---- fixtures ------------------------------------------------------ */

/** Synthetic COLORMAP: row r maps c → (c + r) & 255 (row 0 = identity).
 * Offset-bearing consumption (colormaps[off + v]) is exercised everywhere
 * off-row-0 is used — this is the M3-01 LightTables.colormaps shape. */
function synthColormaps(): Uint8Array {
  const cm = new Uint8Array(COLORMAP_BYTES);
  for (let r = 0; r < COLORMAP_BYTES / 256; r++) {
    for (let c = 0; c < 256; c++) cm[r * 256 + c] = (c + r) & 255;
  }
  return cm;
}

/** Synthetic 128-byte wall column: source[i] = (i*7) & 255 (non-identity,
 * wraps at i≥37 → catches any accidental index bleed). */
function synthColumn(): Uint8Array {
  const s = new Uint8Array(128);
  for (let i = 0; i < 128; i++) s[i] = (i * 7) & 255;
  return s;
}

function setupDc(part: Partial<Dc>): void {
  Object.assign(dc, part);
}

const SENTINEL = 0xee;
function freshIndices(): Uint8Array {
  return new Uint8Array(RENDER_WIDTH * RENDER_HEIGHT).fill(SENTINEL);
}

/* ---- 1. hand-computed 40-px column golden -------------------------- */

describe('drawColumn — hand-computed 40-px golden', () => {
  // Setup (all integers, fully derivable by hand):
  //   x=157, yl=90, yh=129 (count = 39 ⇒ 40 px, rows 90..129 INCLUSIVE —
  //   do/while(count--) in r_draw.c:136-145), centery=100,
  //   iscale = 98304 = 1.5<<16 (fixed 1.5), texturemid = 465305
  //   (= 7<<16 | 6553, i.e. 7.10000... in fixed), source = synthColumn
  //   (idx → (idx*7)&255), colormap offset = 256 (row 1: c → c+1).
  //
  // Derivation (plain int math, verbatim r_draw.c:129-131):
  //   frac_0 = texturemid + (yl - centery)*iscale
  //          = 465305 + (90-100)*98304 = 465305 − 983040 = −517735
  //   frac_n = frac_0 + n*98304,  n = 0..39
  //   row_n  = floor(frac_n / 65536)   (arithmetic >>16 — FLOOR, so the
  //            first six entries sit on negative frac)
  //   idx_n  = row_n & 127  (two's-complement AND = non-negative mod 128;
  //            r_draw.c:140 mask, verbatim)
  //   e.g. n=0: −517735/65536 = −7.90 → floor −8 → −8 & 127 = 120
  //        n=1: −419431 → floor −6.40 →  −7 → 121
  //        n=5:  −26215 → floor −0.40 →  −1 → 127  (last negative → wrap)
  //        n=6: +72089  → floor  1.10 →   1 →   1
  //        n=39: +3316121 → floor 50.60 →  50 →  50
  //        n=39: −517735 + 39*98304 = 3_316_121 → floor 50.6 → 50
  // Hand-computed expected source indices (independent of the
  // implementation: derived here on paper/BigInt floor-div, NOT by running
  // cols.ts), pixels then = colormaps[256 + source[idx]] = ((idx*7)&255)+1:
  const EXPECTED_IDX = [
    120, 121, 123, 124, 126, 127, 1, 2, 4, 5, 7, 8, 10, 11, 13, 14, 16, 17,
    19, 20, 22, 23, 25, 26, 28, 29, 31, 32, 34, 35, 37, 38, 40, 41, 43, 44,
    46, 47, 49, 50,
  ];

  it('lands exactly 40 goldened indices at x=157, rows 90..129', () => {
    const cm = synthColormaps();
    const indices = freshIndices();
    setupDc({
      x: 157,
      yl: 90,
      yh: 129,
      iscale: 98304,
      texturemid: 465305,
      source: synthColumn(),
      colormap: 256,
    });
    drawColumn(indices, cm, 100);

    EXPECTED_IDX.forEach((idx, n) => {
      const y = 90 + n;
      expect(indices[y * RENDER_WIDTH + 157], `row ${y}`).toBe(
        ((idx * 7) & 255) + 1 // colormap row 1: c → c+1
      );
    });

    // Nothing outside the inclusive span was touched…
    for (const y of [89, 130]) {
      expect(indices[y * RENDER_WIDTH + 157]).toBe(SENTINEL);
    }
    // …and neither was any other column on the drawn rows.
    for (let x = 0; x < RENDER_WIDTH; x++) {
      if (x === 157) continue;
      expect(indices[100 * RENDER_WIDTH + x]).toBe(SENTINEL);
      expect(indices[129 * RENDER_WIDTH + x]).toBe(SENTINEL);
    }
  });
});

/* ---- 2. negative-frac &127 wrap ------------------------------------- */

describe('drawColumn — negative frac wrap (&127, r_draw.c:140)', () => {
  // Independent BigInt oracle: bigint >> is arithmetic (floor), bigint &
  // uses two's-complement semantics on negatives — same definition as the
  // C expression `(frac>>FRACBITS)&127` on gcc.
  const oracle = (frac: number | bigint): number =>
    Number((BigInt(frac) >> 16n) & 127n);

  it('single-pixel vectors (yl==yh==centery ⇒ frac0 = texturemid)', () => {
    const cm = synthColormaps();
    const src = synthColumn();
    for (const frac of [0, -1, -65536, -131072, -517735, -2147483648]) {
      const indices = freshIndices();
      setupDc({ x: 10, yl: 100, yh: 100, iscale: 65536, texturemid: frac, source: src, colormap: 0 });
      drawColumn(indices, cm, 100);
      // yh==yl ⇒ count==0 ⇒ do/while runs EXACTLY once (inclusive span).
      expect(oracle(frac), `frac ${frac}`).toBeGreaterThanOrEqual(0);
      expect(indices[100 * RENDER_WIDTH + 10], `frac ${frac}`).toBe(
        src[oracle(frac)]
      );
    }
  });

  it('wraps identically for a span walking through zero', () => {
    // iscale big enough to cross from negative to positive frac mid-column.
    const cm = synthColormaps();
    const src = synthColumn();
    const indices = freshIndices();
    const iscale = 500000; // ≈ 7.6 px steps
    const texturemid = -1_000_000;
    setupDc({ x: 3, yl: 5, yh: 20, iscale, texturemid, source: src, colormap: 0 });
    drawColumn(indices, cm, 100); // (yl-centery)*iscale = -95*500000
    for (let n = 0; n <= 15; n++) {
      const frac = texturemid + (5 - 100 + n) * iscale;
      expect(indices[(5 + n) * RENDER_WIDTH + 3], `n=${n} frac=${frac}`).toBe(
        src[oracle(frac)]
      );
    }
  });

  it('yh < yl draws nothing; int32-exact frac init wrap matches C', () => {
    const indices = freshIndices();
    setupDc({ x: 1, yl: 50, yh: 49, iscale: 65536, texturemid: 0, source: synthColumn(), colormap: 0 });
    drawColumn(indices, synthColormaps(), 100);
    expect(indices.every((v) => v === SENTINEL)).toBe(true);

    // (yl-centery)*iscale exceeds int32: |0 reduction ≡ gcc wraparound.
    // (0-100)*4294967295 = −429496729500; mod 2^32 → int32 −1806376956…
    // assert via the oracle on the C-wrapped value, not a JS float path.
    const cFrac0 = Number((BigInt(0 - 100) * 4294967295n + 7n) % 4294967296n) | 0;
    const idx = freshIndices();
    setupDc({ x: 2, yl: 0, yh: 0, iscale: 4294967295, texturemid: 7, source: synthColumn(), colormap: 0 });
    drawColumn(idx, synthColormaps(), 100);
    expect(idx[0 * RENDER_WIDTH + 2]).toBe(synthColumn()[oracle(cFrac0)]);
  });
});

/* ---- 3. iscale known vectors (G12) ---------------------------------- */

describe('computeIscale — floor(0xffffffff/scale) (G12)', () => {
  const vec: Array<[number, number]> = [
    [256, 16777215], // 0xffffffff/0x100
    [64 * FRACUNIT, 1023], // 4194304 → 1023.99… → 1023
    [FRACUNIT, 65535], // 65535.99984 → 65535 (NOT 65536 — vanilla drift)
    [1, 4294967295],
    [3, 1431655765],
    [500000, 8589],
    [4294967295, 1],
  ];
  for (const [scale, want] of vec) {
    it(`scale ${scale} → iscale ${want}`, () => {
      expect(computeIscale(scale)).toBe(want);
      // BigInt exact quotient is the definition of the policy (M3-plan §3).
      expect(computeIscale(scale)).toBe(Number(0xffffffffn / BigInt(scale)));
    });
  }
  it('rejects 0 (vanilla SIGFPE) and out-of-domain inputs; clamps are M3-06', () => {
    for (const s of [0, -1, 2 ** 32, 1.5, Number.NaN]) {
      expect(() => computeIscale(s)).toThrow(RangeError);
    }
  });
});

/* ---- 4. no allocation per call (smoke) ------------------------------ */

describe('drawColumn — zero-alloc smoke (100k calls)', () => {
  it('100k full-height columns: correct + fast + same buffers', () => {
    const cm = synthColormaps();
    const src = synthColumn();
    const indices = freshIndices();
    setupDc({ x: 42, yl: 0, yh: RENDER_HEIGHT - 1, iscale: 0x12345, texturemid: 3 * FRACUNIT, source: src, colormap: 5 * 256 });

    // Wall-clock via process.hrtime — test-only perf smoke (eslint bans
    // performance/Date in src/**; process.hrtime is the vitest-side idiom).
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 100_000; i++) drawColumn(indices, cm, 100);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;

    // Same dc singleton, same buffers in and out (no hidden reallocation).
    expect(dc.source).toBe(src);
    expect(indices.length).toBe(RENDER_WIDTH * RENDER_HEIGHT);

    // Correctness of the final call (independent BigInt walk).
    const frac0 = (3 * FRACUNIT + (0 - 100) * 0x12345) | 0;
    let f = frac0;
    for (let y = 0; y < RENDER_HEIGHT; y++) {
      const idx = Number((BigInt(f) >> 16n) & 127n);
      expect(indices[y * RENDER_WIDTH + 42], `row ${y}`).toBe(
        colormapsRow5(src[idx] as number)
      );
      f = (f + 0x12345) | 0;
    }

    // 100k × 200-px columns ≈ 20M inner iterations; a per-pixel
    // allocation would blow this up by orders of magnitude.
    expect(ms, `100k columns took ${ms.toFixed(0)}ms`).toBeLessThan(2000);
  });
});

/** colormap row 5 of synthColormaps: c → (c + 5) & 255. */
function colormapsRow5(c: number): number {
  return (c + 5) & 255;
}
