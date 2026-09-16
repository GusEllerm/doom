// sim/prng.ts — vanilla DOOM random streams (m_random.c, linuxdoom-1.10).
//
// m_random.c is NOT an LCG generator at runtime: `M_Random`/`P_Random` are
// index-walkers over a fixed 256-byte lookup table `rndtable` (m_random.c:31).
// The two streams differ only by their independent index counters
// (`rndindex` for presentation, `prndindex` for gameplay; ARCHITECTURE §3.3,
// R04 §5). The table below is transcribed VERBATIM from m_random.c:31-51
// (14 values/row except the last row of 4; 256 total).
//
// State is carried explicitly (`PrngState`) so headless harnesses can run
// independent worlds; the vanilla file-scope globals `rndindex`/`prndindex`
// (m_random.c:53-54) map 1:1 onto these fields.
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** m_random.c:31-51 `unsigned char rndtable[256]` — exact transcription. */
export const RNDTABLE: readonly number[] = [
  0, 8, 109, 220, 222, 241, 149, 107, 75, 248, 254, 140, 16, 66,
  74, 21, 211, 47, 80, 242, 154, 27, 205, 128, 161, 89, 77, 36,
  95, 110, 85, 48, 212, 140, 211, 249, 22, 79, 200, 50, 28, 188,
  52, 140, 202, 120, 68, 145, 62, 70, 184, 190, 91, 197, 152, 224,
  149, 104, 25, 178, 252, 182, 202, 182, 141, 197, 4, 81, 181, 242,
  145, 42, 39, 227, 156, 198, 225, 193, 219, 93, 122, 175, 249, 0,
  175, 143, 70, 239, 46, 246, 163, 53, 163, 109, 168, 135, 2, 235,
  25, 92, 20, 145, 138, 77, 69, 166, 78, 176, 173, 212, 166, 113,
  94, 161, 41, 50, 239, 49, 111, 164, 70, 60, 2, 37, 171, 75,
  136, 156, 11, 56, 42, 146, 138, 229, 73, 146, 77, 61, 98, 196,
  135, 106, 63, 197, 195, 86, 96, 203, 113, 101, 170, 247, 181, 113,
  80, 250, 108, 7, 255, 237, 129, 226, 79, 107, 112, 166, 103, 241,
  24, 223, 239, 120, 198, 58, 60, 82, 128, 3, 184, 66, 143, 224,
  145, 224, 81, 206, 163, 45, 63, 90, 168, 114, 59, 33, 159, 95,
  28, 139, 123, 98, 125, 196, 15, 70, 194, 253, 54, 14, 109, 226,
  71, 17, 161, 93, 186, 87, 244, 138, 20, 52, 123, 251, 26, 36,
  17, 46, 52, 231, 232, 76, 31, 221, 84, 37, 216, 165, 212, 106,
  197, 242, 98, 43, 39, 175, 254, 145, 190, 84, 118, 222, 187, 136,
  120, 163, 236, 249
];

/** Vanilla file-scope counters `rndindex` / `prndindex` (m_random.c:53-54). */
export interface PrngState {
  /** m_random.c `rndindex` — M_Random stream (presentation RNG). */
  rndindex: number;
  /** m_random.c `prndindex` — P_Random stream (gameplay RNG). */
  prndindex: number;
}

/** Both indices start at 0 at program load; `M_ClearRandom` re-zeros them. */
export function createPrngState(): PrngState {
  return { rndindex: 0, prndindex: 0 };
}

/**
 * m_random.c:57-61 `P_Random` — gameplay stream (ARCHITECTURE §3.3: all
 * gameplay randomness uses this one). Returns 0-255.
 */
export function pRandom(s: PrngState): number {
  s.prndindex = (s.prndindex + 1) & 0xff; // m_random.c:59
  return RNDTABLE[s.prndindex]!;
}

/**
 * m_random.c:63-67 `M_Random` — presentation stream (SFX pitch, status face).
 * Returns 0-255. NEVER call from gameplay logic.
 */
export function mRandom(s: PrngState): number {
  s.rndindex = (s.rndindex + 1) & 0xff; // m_random.c:65
  return RNDTABLE[s.rndindex]!;
}

/** m_random.c:69-72 `M_ClearRandom` (`rndindex = prndindex = 0`). */
export function mClearRandom(s: PrngState): void {
  s.rndindex = 0;
  s.prndindex = 0;
}
