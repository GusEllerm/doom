// SPDX-License-Identifier: GPL-2.0-or-later
// core/constants.ts — shared constants named by ARCHITECTURE §2 / §2.5.
// Source: tables.h, m_fixed.h, doomdef.h, p_maputl.c (linuxdoom-1.10, R03 §1,
// R04 §4). Angle constants are BAM values written u32-safe: in C they are
// `unsigned` literals; here they are plain non-negative doubles ≤ 0xffffffff,
// so any `|0` coercion would be WRONG for ANG180/ANG270 — keep them >>>0 and
// combine only with the >>>0 angle helpers in fixed.ts.

// --- fixed point (m_fixed.h) -------------------------------------------
export const FRACBITS = 16;
export const FRACUNIT = 65536; // 1 << FRACBITS
export const FRACMASK = 0xffff;

// --- binary angles (tables.h) ------------------------------------------
// Full circle = 2^32. ANG_FULL ("a whole circle") is 0 in BAM arithmetic:
// adding it is a no-op; these constants are used with angAdd/angSub (>>>0).
export const ANG45 = 0x20000000 >>> 0;
export const ANG90 = 0x40000000 >>> 0;
export const ANG180 = 0x80000000 >>> 0; // 2147483648 — never `|0` this
export const ANG270 = 0xc0000000 >>> 0; // 3221225472 — never `|0` this
export const ANG_FULL = 0x00000000 >>> 0;
export const ANG_MAX = 0xffffffff >>> 0; // 4294967295

export const FINEANGLES = 8192;
export const FINEMASK = FINEANGLES - 1;
export const ANGLETOFINESHIFT = 19; // tables.h "0x100000000 to 0x2000"

// tables.h SLOPERANGE (tantable/SlopeDiv range)
export const SLOPERANGE = 2048;

// --- blockmap / clock (doomdef.h, p_maputl.c) --------------------------
export const MAPBLOCKSIZE = 128; // 128 map units per blockmap cell
export const MAPBLOCKUNITS = 128 * FRACUNIT; // 8388608
export const TICRATE = 35;

// --- int32 extremes (used by the FixedDiv saturating guard) ------------
export const MAXINT = 0x7fffffff; //  2147483647
export const MININT = -0x80000000; // -2147483648
