// core/fixed.ts — exact 16.16 fixed-point + binary-angle helpers for int32-as-
// number (ARCHITECTURE §2.5, ADR A-01; C originals m_fixed.c / tables.h).
//
// Contract: every argument is a frozen int32 (|0-normalized); every result is
// int32 (|0) unless documented u32 (>>>0, BAM angles). No BigInt here — the
// BigInt reference implementation lives in fixed.test.ts as a differential
// oracle (lint-visible: BigInt appears only in *.test.ts).

import { ANGLETOFINESHIFT, FRACBITS, FRACUNIT, MAXINT, MININT } from './constants';

// Re-exported so call sites read like the C (`FixedMul` + `>>FRACBITS`).
export { FRACBITS, FRACUNIT };

// (a * b) >> 16, arithmetic shift of the exact 64-bit product, then C's
// (int) cast = keep low 32 bits. Exact via 16-bit limb split (§2.5):
//   a*b = a1*b1*2^32 + (a1*b0 + a0*b1)*2^16 + a0*b0,  0 <= a0*b0 < 2^32
// so (a*b)>>16 = a1*b1*2^16 + (a1*b0 + a0*b1) + floor(a0*b0 / 2^16), a sum of
// three exactly-representable doubles (< 2^33 in magnitude); `|0` then wraps
// mod 2^32 exactly like the C long->int truncation.
// Overflow wrap (pinned against the BigInt oracle in fixed.test.ts):
//   MININT*MININT >> 16 = 2^46 -> low 32 bits = 0
//   MAXINT*MAXINT >> 16 = 2^46 - 2^17 + ... -> low 32 bits = -65536... (see test)
// i.e. results beyond int32 wrap silently, matching x86 gcc.
export function FixedMul(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >> 16;
  const b0 = b & 0xffff;
  const b1 = b >> 16;
  return (Math.imul(a1, b1) << 16) + (a1 * b0 + a0 * b1) + (Math.imul(a0, b0) >>> 16) | 0;
}

// m_fixed.c FixedDiv, saturating guard verbatim:
//   if ((abs(a) >> 14) >= abs(b)) return (a^b) < 0 ? MININT : MAXINT;
//   return (fixed_t)(((double)a / (double)b) * FRACUNIT);   // truncation
//
// Two C-semantics details the literal §2.5 sketch (`Math.abs(a) >> 14 >=
// Math.abs(b)`) misses at b == MININT, corrected here (gcc abs() wraps):
//   * abs32(): C's abs(MININT) is MININT (negative!), not +2^31. With
//     Math.abs(b), FixedDiv(x, MININT) would take the double path; in C the
//     guard `>= -2147483648` is (almost) always true and saturates.
//   * the `>> 14` on the (possibly negative) abs(a) is arithmetic, so
//     abs(MININT) >> 14 == -131072.
// FixedDiv(x, 0) therefore saturates (0/0 -> MAXINT), matching C.
// Documented non-crash divergence: for a == MININT where the guard does not
// fire (any b except MININT and |b| <= 131072-adjacent cases) the double `c`
// escapes int32; C calls I_Error (game exits). Here we return the `|0` wrap —
// inputs that vanilla aborts on are marked as such in the oracle test.
export function FixedDiv(a: number, b: number): number {
  const aa = a === MININT ? MININT : a < 0 ? -a : a; // C abs (wraps at MININT)
  const ab = b === MININT ? MININT : b < 0 ? -b : b;
  if ((aa >> 14) >= ab) return (a ^ b) < 0 ? MININT : MAXINT;
  return Math.trunc((a / b) * FRACUNIT) | 0; // same IEEE ops as FixedDiv2's double path
}

// Plain int32 add/sub with wrap (C `fixed_t` + / -). §2.5: `+ |0`.
export function FixedAdd(a: number, b: number): number {
  return (a + b) | 0;
}

export function FixedSub(a: number, b: number): number {
  return (a - b) | 0;
}

// Arithmetic shift, = C `v >> n` on signed int (sign-filling).
export function FixedShift(v: number, n: number): number {
  return v >> n;
}

// --- binary angles (tables.h: angle_t is `unsigned`, circle = 2^32) ----
// §2.5: BAM values are carried u32-normalized (>>>0); C's unsigned + and -
// wrap mod 2^32, which is exactly (a +- b) >>> 0 for |a|,|b| < 2^53.

export function angAdd(a: number, b: number): number {
  return (a + b) >>> 0;
}

export function angSub(a: number, b: number): number {
  return (a - b) >>> 0;
}

// tables.h ANGLETOFINESHIFT = 19; C indexes with `ang >> 19` where ang is
// `unsigned` -> JS `ang >>> 19` (0..8191 for u32-normalized ang).
export function angToFine(ang: number): number {
  return (ang >>> 0) >>> ANGLETOFINESHIFT;
}
