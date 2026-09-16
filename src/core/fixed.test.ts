/**
 * A-FX1 tests — bit-exact 16.16 fixed point vs a BigInt differential oracle.
 *
 * Oracle semantics (ARCHITECTURE §2.5 / ADR A-01; C originals m_fixed.c,
 * m_fixed.h in linuxdoom-1.10):
 *
 *  - FixedMul: C is literally `((long long)a * (long long)b) >> FRACBITS`
 *    (m_fixed.c). The int64 product of two int32s never overflows int64, so
 *    the shift is exact and unambiguous: arithmetic shift right = floor
 *    division by 2^16 (toward -Infinity, NOT truncation — pin: FixedMul(1,-1)
 *    = -1, whereas double-path truncation would give 0). The `(fixed_t)` cast
 *    then keeps the low 32 bits (x86/gcc implementation-defined wrap, no UB —
 *    the int64 value itself is well-defined). PINNED OVERFLOW CHOICE: the
 *    BigInt oracle mirrors exactly that — floor-shift the exact product, then
 *    wrap mod 2^32 to signed. No saturation; wrap matches gcc x86-64 and the
 *    limb-split implementation. Corner proofs: MININT×MININT >> 16 = 2^46 ->
 *    low32 = 0; MAXINT×MAXINT -> low32 = -65536; MININT×-FRACUNIT -> low32
 *    wraps to MININT.
 *
 *  - FixedDiv: vanilla recipe (m_fixed.c) `if ((abs(a)>>14) >= abs(b)) return
 *    (a^b)<0 ? MININT : MAXINT; else FixedDiv2` where FixedDiv2 computes
 *    `double c = a/b * 65536`, calls I_Error if |c| escapes int32, else
 *    truncates. Two gcc-quirks are PINNED (vanilla `abs()` is a macro and
 *    wraps: abs(MININT) == MININT, negative; `>>` on it is arithmetic):
 *      * b == MININT -> abs(b) == MININT, guard always true -> saturate;
 *      * a == MININT -> abs(a)>>14 == -131072, guard false for every b except
 *        MININT -> double path; when |c| escapes int32 vanilla calls I_Error
 *        (game exits). Deterministic choice here (documented): the TS impl
 *        returns the mod-2^32 wrap of the exact quotient in that case; the
 *        oracle flags those vectors ("c-abort"). With guard-passed random
 *        inputs |c| provably fits (|a|·2^16/|b| < ~2^31), so "c-abort" is
 *        reachable only from a == MININT with |b| < 2^17.
 *      * b == 0 -> guard true (ab == 0 <= aa>>14 ... aa>>14 >= 0 == ab) ->
 *        saturate; 0/0 -> MAXINT. No divide-by-zero trap, exactly like C.
 *
 * BigInt appears ONLY in this test file (§2.5; impl hot paths use the
 * 16-bit limb split). Deterministic vectors from mulberry32 (no Math.random
 * anywhere — repo lint rule).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { MAXINT, MININT } from './constants';
import { FixedDiv, FixedMul, FRACUNIT, angAdd, angSub, angToFine } from './fixed';

/* ------------------------------------------------------------------ */
/* Deterministic PRNG (mulberry32) — seeded, never Math.random         */
/* ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0; // u32; callers |0 for int32
  };
}

/* ------------------------------------------------------------------ */
/* BigInt oracle                                                       */
/* ------------------------------------------------------------------ */

/** Keep low 32 bits of a BigInt, reinterpreted as signed int32 (= C cast). */
function wrap32(v: bigint): number {
  const w = Number(((v % 4294967296n) + 4294967296n) % 4294967296n);
  return w >= 2147483648 ? w - 4294967296 : w;
}

/** Exact model of `(long long)a*b >> 16` cast to fixed_t (see header). */
function oracleFixedMul(a: number, b: number): number {
  return wrap32((BigInt(a) * BigInt(b)) >> 16n);
}

/** C abs() as compiled by gcc: wraps at MININT (stays negative). */
function cAbs(v: number): number {
  return v === MININT ? MININT : v < 0 ? -v : v;
}

interface DivResult {
  /** Deterministic value: exact trunc(a*65536/b) low-32-wrapped. */
  v: number;
  /** True where vanilla C would call I_Error (FixedDiv2 range check). */
  cAbort: boolean;
}

/** Saturating-guard model of m_fixed.c FixedDiv (see header). */
function oracleFixedDiv(a: number, b: number): number | DivResult {
  const A = BigInt(a);
  const B = BigInt(b);
  const aa = BigInt(cAbs(a));
  const ab = BigInt(cAbs(b));
  if ((aa >> 14n) >= ab) {
    return (a ^ b) < 0 ? MININT : MAXINT;
  }
  if (B === 0n) {
    // a == MININT with b == 0: the abs-wrap skips the guard; C computes
    // c = ±Infinity and calls I_Error. Deterministic choice: |0 of ±Inf = 0.
    return { v: 0, cAbort: true };
  }
  const c = (A * 65536n) / B; // BigInt division truncates toward zero = C cast
  return { v: wrap32(c), cAbort: c >= 2147483648n || c < -2147483648n };
}

/* ------------------------------------------------------------------ */
/* Vector generators                                                   */
/* ------------------------------------------------------------------ */

type Pair = readonly [a: number, b: number];

function biasedInt32(rnd: () => number, kind: number): number {
  switch (kind % 5) {
    case 0:
      return rnd() | 0; // uniform int32
    case 1:
      return ((rnd() & 0x3ff) - 512) | 0; // small
    case 2:
      return (1 << (rnd() % 31)) | 0; // power of two
    case 3: {
      const set = [0, 1, -1, 65536, -65536, 131072, MAXINT, MININT, 255, 256] as const;
      return (set[rnd() % 10] ?? 0) | 0;
    }
    default:
      return (rnd() % 2 === 0 ? MAXINT - (rnd() & 0xff) : MININT + (rnd() & 0xff)) | 0;
  }
}

/**
 * Mixed-distribution seeded vectors: uniform int32, small values, powers of
 * two, near-extreme values — exercises guard paths and limb-split corners.
 */
function seededPairs(seed: number, count: number): Pair[] {
  const rnd = mulberry32(seed);
  const out: Pair[] = [];
  for (let i = 0; i < count; i++) {
    const fa = biasedInt32(rnd, rnd());
    const fb = biasedInt32(rnd, rnd());
    out.push([fa | 0, fb | 0]);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* FixedMul                                                            */
/* ------------------------------------------------------------------ */

const MUL_COUNT = 100_000;

describe('FixedMul vs BigInt oracle (exact floor-shift, low-32 wrap)', () => {
  it(`matches the oracle on ${MUL_COUNT} seeded vectors`, () => {
    const pairs = seededPairs(0x5eed1e, MUL_COUNT);
    expect(pairs).toHaveLength(MUL_COUNT);
    let mismatches = 0;
    let first: unknown = null;
    for (const [a, b] of pairs) {
      const got = FixedMul(a, b);
      const want = oracleFixedMul(a, b);
      if (got !== want) {
        if (mismatches++ === 0) first = { a, b, got, want };
      }
    }
    expect(first).toBeNull();
    expect(mismatches).toBe(0);
  });

  it('int32-normalized and floor (not trunc) on negative products', () => {
    // Pin floor semantics of C's int64 >>: 1 * -1 = -1/65536 -> floor = -1.
    expect(FixedMul(1, -1)).toBe(-1);
    expect(FixedMul(-1, 65535)).toBe(-1);
    expect(FixedMul(1, 1)).toBe(0);
    expect(FixedMul(-1, -1)).toBe(0);
    for (const [a, b] of seededPairs(0xa11ce, 5000)) {
      expect(Number.isInteger(FixedMul(a, b))).toBe(true);
    }
  });

  it('pinned corner vectors (overflow wrap semantics, see header)', () => {
    const corners: ReadonlyArray<readonly [Pair, number]> = [
      [[MININT, MININT], 0], // 2^62 >>16 = 2^46 -> low32 0
      [[MININT, -1], 32768], // +2^31 >>16 = 2^15 (in range, no wrap)
      [[MAXINT, MAXINT], -65536], // (2^31-1)^2 >>16 = 2^46-2^16 -> low32 -65536
      [[MININT, 1], -32768], // -2^31 >>16 = -2^15 (arithmetic shift, fits)
      [[MAXINT, 1], 32767], // (2^31-1) >>16 = 2^15-1
      [[MININT, FRACUNIT], MININT], // -2^47 >>16 = -2^31 = MININT (fits)
      [[MININT, -FRACUNIT], MININT], // +2^47 >>16 = +2^31 -> low32 wraps MININT
      [[MAXINT, FRACUNIT], MAXINT],
      [[FRACUNIT, FRACUNIT], FRACUNIT], // 1.0 × 1.0 = 1.0 = 65536 fixed
      [[-FRACUNIT, FRACUNIT], -FRACUNIT],
      [[-FRACUNIT, -FRACUNIT], FRACUNIT],
      [[FRACUNIT, 0], 0],
      [[0, MININT], 0],
      [[0, -1], 0],
    ] as const;
    for (const [[a, b], want] of corners) {
      expect(FixedMul(a, b), `FixedMul(${a}, ${b})`).toBe(want);
      expect(oracleFixedMul(a, b), `oracle(${a}, ${b})`).toBe(want);
    }
    // -0 inputs normalize (never produces -0 out):
    expect(Object.is(FixedMul(-0, FRACUNIT), 0)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* FixedDiv                                                            */
/* ------------------------------------------------------------------ */

const DIV_COUNT = 4000; // 2000 uniform + 2000 small-denominator (guard-heavy)

describe('FixedDiv vs BigInt oracle (saturating guard, m_fixed.c)', () => {
  it(`matches the oracle on ${DIV_COUNT} seeded vectors`, () => {
    const pairs: Pair[] = [
      ...seededPairs(0xd1c0, DIV_COUNT / 2),
      ...seededPairs(0xd1c1, DIV_COUNT / 2).map(
        ([a, b]): Pair => [a, b === 0 ? 0 : (b % 4097) | 0], // bias: |b| <= 4096
      ),
    ];
    expect(pairs).toHaveLength(DIV_COUNT);
    let mismatches = 0;
    let first: unknown = null;
    let saturated = 0;
    let cAborts = 0;
    for (const [a, b] of pairs) {
      const got = FixedDiv(a, b);
      const o = oracleFixedDiv(a, b);
      const want = typeof o === 'number' ? o : o.v;
      if (typeof o === 'number') saturated++;
      else if (o.cAbort) cAborts++;
      if (typeof o === 'object' && o.v !== got) {
        if (mismatches++ === 0) first = { a, b, got, want };
      } else if (typeof o === 'number' && o !== got) {
        if (mismatches++ === 0) first = { a, b, got, want };
      }
    }
    expect(first).toBeNull();
    expect(mismatches).toBe(0);
    expect(saturated).toBeGreaterThan(0); // guard path exercised
    expect(cAborts).toBeGreaterThan(0); // MININT-numerator I_Error cases exist
  });

  it('pinned corner table (saturation + div-by-zero + c-abort cases)', () => {
    // [a, b, expected, cAbort] — cAbort = vanilla would I_Error; we wrap.
    const corners: ReadonlyArray<readonly [number, number, number, boolean]> = [
      [0, 0, MAXINT, false], // 0/0 -> MAXINT (guard, no trap)
      [1, 0, MAXINT, false],
      [-1, 0, MININT, false],
      [65536, 0, MAXINT, false],
      [0, 1, 0, false],
      [0, -1, 0, false],
      [0, MININT, MININT, false], // abs(MININT) wraps negative -> guard -> sign
      [1, MININT, MININT, false],
      [-1, MININT, MAXINT, false],
      [MININT, MININT, MAXINT, false], // same sign -> saturate MAXINT
      [MAXINT, MAXINT, 65536, false],
      [MAXINT, 1, MAXINT, false], // guard: (MAXINT>>14) >= 1 -> saturate
      [MININT, MAXINT, -65536, false],
      [MININT, 65536, MININT, false], // c == -2^31 exactly: in range, no abort
      [MININT, 131072, -1073741824, false],
      [MININT, -1, 0, true], // c = +2^47 -> C: I_Error; we wrap low32 -> 0
      [MININT, 1, 0, true],
      [MININT, -65536, MININT, true], // c = +2^31 -> C: I_Error; wrap -> MININT
      [FRACUNIT, FRACUNIT, 65536, false],
    ] as const;
    for (const [a, b, want, cAbort] of corners) {
      const o = oracleFixedDiv(a, b);
      expect(typeof o === 'object' ? o.cAbort : false, `cAbort(${a}, ${b})`).toBe(cAbort);
      const got = FixedDiv(a, b);
      expect(got, `FixedDiv(${a}, ${b})`).toBe(want);
      expect(typeof o === 'number' ? o : o.v, `oracle(${a}, ${b})`).toBe(want);
    }
  });
});

/* ------------------------------------------------------------------ */
/* BAM angle helpers (>>>0 wrap discipline, §2.5)                       */
/* ------------------------------------------------------------------ */

describe('angle ops (u32 wrap)', () => {
  it('wrap, index mapping', () => {
    expect(angAdd(0xc0000000, 0x80000000)).toBe(0x40000000); // 270+180 = 90
    expect(angSub(0, 1)).toBe(0xffffffff);
    expect(angToFine(0x80000000)).toBe(4096); // 180 deg -> finesine index
    expect(angToFine(0xffffffff)).toBe(8191);
    expect(angToFine(angAdd(0x20000000, 0x40000000))).toBe(3072); // 135 deg
  });
});
