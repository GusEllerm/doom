/**
 * sim/prng tests (M2-06) — table fidelity + golden stream values + stream
 * independence + M_ClearRandom. Goldens taken from the two independent
 * index walks over the verbatim m_random.c:31-51 table.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  createPrngState,
  mClearRandom,
  mRandom,
  pRandom,
  RNDTABLE,
  type PrngState
} from './prng';

/** Reference walk of the C source itself (m_random.c:57-67). */
function walk(table: readonly number[], start: number, n: number): number[] {
  let idx = start;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    idx = (idx + 1) & 0xff;
    out.push(table[idx]!);
  }
  return out;
}

describe('RNDTABLE', () => {
  it('has exactly 256 byte values', () => {
    expect(RNDTABLE).toHaveLength(256);
    for (const v of RNDTABLE) expect(v).toBeTypeOf('number');
    expect(RNDTABLE.every((v) => Number.isInteger(v) && v >= 0 && v <= 255)).toBe(true);
  });

  it('matches the verbatim first/last rows of m_random.c:31-51', () => {
    // First two rows verbatim from the C source (m_random.c:32-33):
    //   0, 8, 109, 220, 222, 241, 149, 107, 75, 248, 254, 140, 16, 66,
    //   74, 21, 211, 47, 80, 242, 154, 27, 205, 128, 161, 89, 77, 36,
    expect(RNDTABLE.slice(0, 28)).toEqual([
      0, 8, 109, 220, 222, 241, 149, 107, 75, 248, 254, 140, 16, 66,
      74, 21, 211, 47, 80, 242, 154, 27, 205, 128, 161, 89, 77, 36
    ]);
    // Last line (m_random.c:50): 120, 163, 236, 249
    expect(RNDTABLE.slice(252)).toEqual([120, 163, 236, 249]);
  });
});

describe('M_Random / P_Random streams', () => {
  it('M_Random golden: first 8 values from a fresh state (rndtable[1..8])', () => {
    const s = createPrngState();
    // m_random.c:65-66 advances BEFORE indexing → first hit is rndtable[1].
    const got = Array.from({ length: 8 }, () => mRandom(s));
    expect(got).toEqual(walk(RNDTABLE, 0, 8));
    expect(got).toEqual([8, 109, 220, 222, 241, 149, 107, 75]);
    expect(s.rndindex).toBe(8);
  });

  it('P_Random golden: same table, own index (first value also 8, independent counters)', () => {
    const s = createPrngState();
    const got = Array.from({ length: 8 }, () => pRandom(s));
    expect(got).toEqual([8, 109, 220, 222, 241, 149, 107, 75]);
    expect(s.prndindex).toBe(8);
    expect(s.rndindex).toBe(0); // untouched stream (m_random.c:53-54)
  });

  it('streams are independent: draining M does not shift P', () => {
    const a = createPrngState();
    const b = createPrngState();
    for (let i = 0; i < 100; i++) mRandom(a); // 100 M draws
    expect(pRandom(a)).toBe(pRandom(b)); // P unaffected by M usage
    expect(a.rndindex).toBe(100 & 0xff);
  });

  it('indices wrap mod 256 exactly (256 draws land on rndindex 0 again)', () => {
    const s = createPrngState();
    for (let i = 0; i < 256; i++) mRandom(s);
    expect(s.rndindex).toBe(0);
    expect(mRandom(s)).toBe(RNDTABLE[1]); // cycle repeats
  });

  it('M_ClearRandom resets both indices and the stream replays identically', () => {
    const s = createPrngState();
    for (let i = 0; i < 37; i++) {
      mRandom(s);
      pRandom(s);
    }
    mClearRandom(s);
    expect(s).toEqual({ rndindex: 0, prndindex: 0 });
    const fresh: PrngState = createPrngState();
    for (let i = 0; i < 50; i++) {
      expect(mRandom(s)).toBe(mRandom(fresh));
      expect(pRandom(s)).toBe(pRandom(fresh));
    }
  });
});
