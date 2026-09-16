/**
 * A-FX1 tests — trig/slope tables vs linuxdoom-1.10 tables.c.
 *
 * Provenance & derivation (read tables.c before writing this; no lore):
 *
 *  - tables.c SHIPS the finished arrays (10240 finesine, 4096 finetangent,
 *    2049 tantoangle); the R_InitTrig generator is not in the release. The
 *    FINE_TRIG closed forms behind the data are
 *        finesine[i]    = 65536 * sin((i + 0.5) * 2pi / 8192)   (half-step
 *                         phase: index i samples angle (i+0.5) fine-steps)
 *        finetangent[i] = -65536 / tan((i + 0.5) * 2pi / 8192)  (cotangent,
 *                         spans 2 quadrants: pi/2 crossing sits at i = 2047.5)
 *        tantoangle[i]  = atan(i / 2048) * 2^32 / 2pi           (BAM; the
 *                         R_PointToAngle slope scale; tan-fit of the data
 *                         shows NO half-step: |tan(arg)·2048 − i| < 1e-4)
 *    The shipped data was built with integer recurrences at 2^28/2^16 fixed
 *    scale, so IEEE-double closed forms reproduce it WITHIN a bound but not
 *    bit-exactly (measured vs tables.c: finesine floor-formula differs in
 *    4110/10240 entries by |Δ| ≤ 2; finetangent relative error ≤ ~1.1e-4
 *    worst at the poles; tantoangle round-formula differs by |Δ| ≤ 16 BAM).
 *    BIT-EXACTNESS IS THEREFORE PINNED BY SHA256 of the comma-joined decimal
 *    data (same recipe used to extract from tables.c; full digests below),
 *    and every entry is additionally checked against the formula bound.
 *    (The brief's "finesine[1]=85, finesine[512]=65536" are Wolfenstein-3D
 *    lore — R03 §1: DOOM has no 512-entry sine table. Real values: 75 and
 *    25102; finesine[2048] = 65535, not 65536, because of the half-step.)
 *
 *  - SHA256(comma-joined decimal, as parsed from tables.c):
 *      finesine    6e59e9f0470bc9bfaf5e38503eec5ff8e9d2352fa3cda41371c48be5f07e217d
 *      finetangent 376b8a0f0fffd227a6feeb8a7864be3aa06d2aa2f35b3614944350ac8c8f7ac6
 *      tantoangle  da27bd0530a1d3416396462fc024fb369a612c5301659f43ae140bee6ec848e5
 *
 *  - SlopeDiv (tables.c, unsigned args): den < 512 -> SLOPERANGE;
 *    ans = (num<<3)/(den>>8) with UNSIGNED 32-bit shifts (num<<3 WRAPS mod
 *    2^32 — pinned below) and unsigned division; clamp to SLOPERANGE=2048.
 *
 * BigInt only in this test file; vectors seeded (mulberry32), no Math.random.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { ANG45, ANG90, ANG180, ANG270, FINEANGLES, SLOPERANGE } from './constants';
import { angToFine } from './fixed';
import { finecosine, finesine, finetangent, SlopeDiv, tantoangle } from './tables';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

const sha256Of = (a: ArrayLike<number> | number[]): string =>
  createHash('sha256')
    .update(Array.from(a).join(','))
    .digest('hex');

const TAU = 2 * Math.PI;
const FINE_STEP = TAU / FINEANGLES; // 2pi/8192

/** Count + worst |delta| of `calc(i) - data[i]` over [0, n). */
function deviation(n: number, data: ArrayLike<number>, calc: (i: number) => number) {
  let diffs = 0;
  let worst = 0;
  let worstAt = -1;
  for (let i = 0; i < n; i++) {
    const d = calc(i) - (data[i] ?? 0);
    if (d !== 0) {
      diffs++;
      if (Math.abs(d) > Math.abs(worst)) {
        worst = d;
        worstAt = i;
      }
    }
  }
  return { diffs, worst, worstAt };
}

/* ------------------------------------------------------------------ */
/* finesine / finecosine                                               */
/* ------------------------------------------------------------------ */

describe('finesine (Int32Array 10240, tables.c verbatim)', () => {
  it('is exactly the tables.c data (SHA256 pin)', () => {
    expect(finesine).toHaveLength(10240);
    expect(sha256Of(finesine)).toBe(
      '6e59e9f0470bc9bfaf5e38503eec5ff8e9d2352fa3cda41371c48be5f07e217d',
    );
  });

  it('known vectors from tables.c data', () => {
    // (Brief's 85/512/65536 triple is Wolf3D lore; see header. Actuals:)
    expect(finesine[0]).toBe(25); // FRACUNIT*sin(0.5 * 2pi/8192) floor
    expect(finesine[1]).toBe(75);
    expect(finesine[512]).toBe(25102);
    expect(finesine[1024]).toBe(46358); // ~sin(45°)·65536, half-step off
    expect(finesine[2047]).toBe(65535);
    expect(finesine[2048]).toBe(65535); // cos(0.5 step), NOT 65536
    expect(finesine[4096]).toBe(-25);
    // Range over one revolution: never reaches ±65536 (half-step phase).
    expect(Math.max(...Array.from(finesine.subarray(0, 8192)))).toBe(65535);
    expect(Math.min(...Array.from(finesine.subarray(0, 8192)))).toBe(-65535);
  });

  it('every entry within ±2 of floor(65536*sin((i+0.5)*2pi/8192))', () => {
    const d = deviation(10240, finesine, (i) => Math.floor(Math.sin((i + 0.5) * FINE_STEP) * 65536));
    expect(d.diffs).toBeGreaterThan(0); // recurrence-vs-double (header): expect mismatches
    expect(Math.abs(d.worst)).toBeLessThanOrEqual(2);
  });

  it('second revolution (8192..10239) repeats 0..2047 within the bound', () => {
    const d = deviation(2048, finesine.subarray(8192), (i) => finesine[i] ?? 0);
    expect(Math.abs(d.worst)).toBeLessThanOrEqual(2);
  });

  it('finecosine === finesine.subarray(2048) (r_main.c alias)', () => {
    expect(finecosine.length).toBe(10240 - FINEANGLES / 4);
    expect(finecosine.buffer === finesine.buffer).toBe(true);
    expect(finecosine.byteOffset).toBe((FINEANGLES / 4) * 4);
    for (let i = 0; i < finecosine.length; i++) expect(finecosine[i]).toBe(finesine[i + 2048]);
    // formula cross-check: finecosine[i] ~ 65536*cos((i+0.5)*step), ±2
    const d = deviation(finecosine.length, finecosine, (i) =>
      Math.floor(Math.cos((i + 0.5) * FINE_STEP) * 65536),
    );
    expect(Math.abs(d.worst)).toBeLessThanOrEqual(2);
  });

  it('BAM angle -> finesine index (ANGLETOFINESHIFT = 19)', () => {
    expect(angToFine(ANG90)).toBe(2048);
    expect(finesine[angToFine(ANG90)]).toBe(65535); // sin(90° - halfstep)
    expect(finesine[angToFine(ANG180)]).toBe(-25);
    expect(finesine[angToFine(ANG270)]).toBe(-65535);
    expect(finecosine[angToFine(ANG90)]).toBe(-25); // cos(90° - halfstep)
  });
});

/* ------------------------------------------------------------------ */
/* finetangent                                                         */
/* ------------------------------------------------------------------ */

describe('finetangent (4096, cotangent over 2 quadrants)', () => {
  it('is exactly the tables.c data (SHA256 pin) + pins', () => {
    expect(finetangent).toHaveLength(4096);
    expect(sha256Of(finetangent)).toBe(
      '376b8a0f0fffd227a6feeb8a7864be3aa06d2aa2f35b3614944350ac8c8f7ac6',
    );
    expect(finetangent[0]).toBe(-170910304);
    expect(finetangent[2047]).toBe(-25);
    expect(finetangent[2048]).toBe(25);
    expect(finetangent[4095]).toBe(170910304);
  });

  it('exact antisymmetry + strict monotonicity (whole table)', () => {
    for (let i = 0; i < 4096; i++) expect(finetangent[4095 - i]).toBe(-(finetangent[i] ?? 0));
    for (let i = 1; i < 4096; i++) expect(finetangent[i]).toBeGreaterThan(finetangent[i - 1] ?? 0);
  });

  it('every entry within the generation bound of -65536/tan((i+0.5)*step)', () => {
    const d = deviation(4096, finetangent, (i) =>
      Math.trunc(-65536 / Math.tan((i + 0.5) * FINE_STEP)),
    );
    expect(Math.abs(d.worst)).toBeLessThanOrEqual(19000); // pole amplification; rel err ~1.1e-4
    // Relative bound holds everywhere:
    for (let i = 0; i < 4096; i++) {
      const want = Math.trunc(-65536 / Math.tan((i + 0.5) * FINE_STEP));
      expect(Math.abs((finetangent[i] ?? 0) - want)).toBeLessThanOrEqual(Math.max(2, Math.abs(want) * 1.5e-4));
    }
  });
});

/* ------------------------------------------------------------------ */
/* tantoangle + SlopeDiv (R_PointToAngle machinery)                    */
/* ------------------------------------------------------------------ */

describe('tantoangle (2049, atan slope LUT) + SlopeDiv', () => {
  it('is exactly the tables.c data (SHA256 pin) + pins', () => {
    expect(tantoangle).toHaveLength(SLOPERANGE + 1);
    expect(sha256Of(tantoangle)).toBe(
      'da27bd0530a1d3416396462fc024fb369a612c5301659f43ae140bee6ec848e5',
    );
    expect(tantoangle[0]).toBe(0);
    expect(tantoangle[1]).toBe(333772);
    expect(tantoangle[SLOPERANGE]).toBe(536870912); // atan(1) = 45° BAM
    expect(tantoangle[SLOPERANGE]).toBe(ANG45); // atan(1) = 45° = 2^32/8 BAM
  });

  it('strictly monotonic + within bound of BAM(atan(i/2048)) (all entries)', () => {
    for (let i = 1; i <= SLOPERANGE; i++) expect(tantoangle[i]).toBeGreaterThan(tantoangle[i - 1] ?? 0);
    const d = deviation(SLOPERANGE + 1, tantoangle, (i) =>
      Math.round(Math.atan(i / SLOPERANGE) * 0x100000000 / TAU),
    );
    expect(Math.abs(d.worst)).toBeLessThanOrEqual(32); // ~1.3e-7 rad, integer recurrence
  });

  it('SlopeDiv matches the C unsigned recipe (2004 seeded + corners)', () => {
    // C: if (den < 512) return 2048; ans = floor(((num<<3) mod 2^32) / (den>>>8));
    const oracle = (num: number, den: number): number => {
      const denU = BigInt(den >>> 0);
      if (denU < 512n) return SLOPERANGE;
      const ans = BigInt((num << 3) >>> 0) / (denU >> 8n);
      return ans <= 2048n ? Number(ans) : SLOPERANGE;
    };
    const rnd = mulberry32(0x5e0a); // seeded
    const pairs: Array<[number, number]> = [];
    for (let i = 0; i < 2000; i++) {
      const num = rnd();
      const den = ([rnd(), rnd() & 0x3ff, 1 << (rnd() % 24), 0, 512, 65536][rnd() % 6] ?? 0) >>> 0;
      pairs.push([num, den]);
    }
    pairs.push([0, 0], [1, 511], [1 << 20, 1 << 16], [0x20000000, 0x10000], [65536, 65536], [512, 512]);
    for (const [num, den] of pairs) {
      expect(SlopeDiv(num, den), `SlopeDiv(${num >>> 0}, ${den >>> 0})`).toBe(oracle(num, den));
    }
    // Documented C behaviors pinned explicitly:
    expect(SlopeDiv(0, 0)).toBe(SLOPERANGE); // den<512 guard (no trap)
    expect(SlopeDiv(1 << 20, 1 << 16)).toBe(SLOPERANGE); // 32768 -> clamped
    expect(SlopeDiv(0x20000000, 0x10000)).toBe(0); // (num<<3) unsigned-WRAPS to 0
    expect(SlopeDiv(65536, 65536)).toBe(2048); // 45° slope -> tantoangle[2048]
  });

  it('integration: SlopeDiv -> tantoangle tracks atan2 within slope quantization', () => {
    const rnd = mulberry32(0x17a9e0);
    const stepBam = Math.round(Math.atan(1 / SLOPERANGE) * 0x100000000 / TAU);
    // SlopeDiv's `den >> 8` truncation adds relative slope error <= ~2^-16;
    // keep dx >= 2^20 so the bound stays one slope-step + epsilon (1.2 steps).
    const bound = Math.ceil(stepBam * 1.2) + 64;
    let checked = 0;
    for (let i = 0; i < 500; i++) {
      const dx = 0x100000 + (rnd() % 0xf00000); // [2^20, 2^24) fixed
      const dy = rnd() % (dx + 1); // 0 .. dx (octant 1: slope <= 1)
      const s = SlopeDiv(dy, dx);
      if (s === SLOPERANGE && dy * 2048 > dx) continue; // clamped beyond table
      const bam = (Math.atan(dy / dx) * 0x100000000) / TAU;
      expect(Math.abs(bam - (tantoangle[s] ?? 0))).toBeLessThanOrEqual(bound);
      checked++;
    }
    expect(checked).toBeGreaterThan(400);
  });
});
