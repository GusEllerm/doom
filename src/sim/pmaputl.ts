/**
 * sim/pmaputl — `p_maputl.c` movement/collision utilities (M5-01).
 *
 * Verbatim ports from the canonical id Software linuxdoom-1.10 sources
 * (github.com/id-Software/DOOM, linuxdoom-1.10/p_maputl.c; the file was
 * MISSING from this machine's /tmp/DOOM-master checkout, so line citations
 * below are against the canonical release, cross-checked against R04 §8
 * which verified the same ranges earlier):
 *
 *  - P_AproxDistance        p_maputl.c:39-58
 *  - P_PointOnLineSide      p_maputl.c:60-104   (NOTE: the FRACBITS form,
 *      which is R_PointOnSide's products WITHOUT the sign-bit fast path —
 *      NOT identical to P_PointOnDivlineSide's `>>8` form)
 *  - P_BoxOnLineSide        p_maputl.c:106-157  (−1 when the box straddles;
 *      lives HERE, not in r_main.c — verified; m_bbox.h enum order is
 *      BOXTOP=0, BOXBOTTOM=1, BOXLEFT=2, BOXRIGHT=3)
 *  - P_PointOnDivlineSide   p_maputl.c:155-203  — REUSED from
 *      sim/bsp.ts `pointOnDivlineSide` (the G11-duplicated `>>8` form;
 *      identical operation, consumed rather than re-ported)
 *  - P_MakeDivline          p_maputl.c:208-217  (as {@link divLineFrom})
 *  - P_InterceptVector      p_maputl.c:221-256  (`#if 1` branch only; the
 *      `>>8` pre-shifts inside FixedMul/FixedDiv are binding, R04 §14 pt.4)
 *  - P_LineOpening          p_maputl.c:290-330  (globals opentop/
 *      openbottom/openrange/lowfloor at :294-297)
 *  - P_BlockLinesIterator   p_maputl.c:465-505  — REUSED from
 *      sim/blockmap.ts (merged there in M2-05 with the validcount scan)
 *  - PIT_AddLineIntercepts  p_maputl.c:556-610
 *  - P_TraverseIntercepts   p_maputl.c:677-735
 *  - P_PathTraverse         p_maputl.c:737-879
 *
 * DEVIATIONS (documented, this task):
 *  - `P_ClosestPointOnLine` does NOT exist in 1.10's p_maputl.c (later
 *    sources only) — nothing to port.
 *  - `P_LineOpening` has exactly opentop/openbottom/openrange/lowfloor in
 *    1.10; there is NO `opentight`/`closing` field (those are later-source
 *    additions) and the ML_DONTPEGBOTTOM mid-texture rule does not exist
 *    here — plain min/max per the source.
 *  - Thing-side twins (P_SetThingPosition / P_BlockThingsIterator /
 *    PIT_AddThingIntercepts) need mobj links that arrive in M5-02/M7 —
 *    PT_ADDTHINGS therefore throws {@link PMaputlError} instead of
 *    silently iterating nothing (vanilla would compile it against
 *    blocklinks[]; there is no blocklinks grid on the sim side yet).
 *  - The intercept arena is fixed MAXINTERCEPTS=128; vanilla overflows it
 *    into adjacent globals (UB). We throw a typed error instead
 *    (same policy as MapSetupError).
 *  - The one-sided test in P_LineOpening/PIT_AddLineIntercepts keys off
 *    sideNumBack/sectorBack == −1 (the M2-04 sentinel for sidenum[1] == −1)
 *    instead of a NULL backsector pointer.
 *  - validcount: vanilla's single global is a shared counter here
 *    ({@link bumpValidcount}) threaded through blockmap.ts's explicit
 *    {@link BlockScan} — every validcount consumer (this module, M5-02's
 *    P_CheckPosition) MUST take numbers from the same counter.
 *
 * Determinism / allocation: all per-traversal state is module-level
 * arenas and scalars (mirroring vanilla's file-scope globals, the same
 * single-threaded assumption R04 §14 makes); steady-state calls allocate
 * nothing — divlines are written into caller- or module-scratch records,
 * the arena is parallel typed arrays, and no closures are created per
 * line or per intercept.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { FixedMul, FRACBITS } from '../core/fixed';
import type { Side } from './bsp';
import {
  ST_HORIZONTAL,
  ST_POSITIVE,
  ST_VERTICAL,
  type FixedBBox,
  type RuntimeMap,
} from './map';

/* ------------------------------------------------------------------ */
/* Constants (p_local.h / m_bbox.h spellings)                           */
/* ------------------------------------------------------------------ */

/** p_local.h:154 MAXINTERCEPTS. */
export const MAXINTERCEPTS = 128;

/** p_local.h:178-180 P_PathTraverse flags. */
export const PT_ADDLINES = 1;
export const PT_ADDTHINGS = 2;
export const PT_EARLYOUT = 4;

/** Thrown where vanilla would do nothing sane (UB / unimplemented path). */
export class PMaputlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PMaputlError';
  }
}

/** The minimal map surface the point/box/opening helpers need (SoA views;
 * tests may pass a RuntimeMap or a hand-built subset). */
export type LineMapView = Pick<RuntimeMap, 'verticesX' | 'verticesY' | 'lines'>;

/** Mutable divline_t scratch (bsp's DivLine fields are readonly). */
export interface DivLineMut {
  x: number;
  y: number;
  dx: number;
  dy: number;
}

/** C `abs()` on int32, wrapping at MININT exactly like gcc's abs(). */
function abs32(v: number): number {
  return v === -0x80000000 ? v : v < 0 ? -v : v;
}

/* ------------------------------------------------------------------ */
/* validcount (vanilla global, p_maputl.c/p_map.c shared domain)        */
/* ------------------------------------------------------------------ */

let validcount = 0;

/** Vanilla `++validcount` — returns the new stamp for a {@link BlockScan}.
 * M5-02's P_CheckPosition must use THIS counter so cross-query dedup keeps
 * the vanilla semantics. */
export function bumpValidcount(): number {
  validcount = (validcount + 1) | 0;
  return validcount;
}

/* ------------------------------------------------------------------ */
/* P_AproxDistance — p_maputl.c:39-58                                   */
/* ------------------------------------------------------------------ */

/**
 * `P_AproxDistance`: octagon-ish distance estimate, `dx+dy−min(dx,dy)>>1`
 * on the absolute deltas. `abs` is C's (wraps at MININT — pinned by test;
 * vanilla reads the negative value straight into the `<` comparison).
 */
export function pAproxDistance(dx: number, dy: number): number {
  dx = abs32(dx);
  dy = abs32(dy);
  if (dx < dy) return (dx + dy - (dx >> 1)) | 0;
  return (dx + dy - (dy >> 1)) | 0;
}

/* ------------------------------------------------------------------ */
/* P_PointOnLineSide — p_maputl.c:60-104                                */
/* ------------------------------------------------------------------ */

/**
 * `P_PointOnLineSide(x, y, line)` verbatim: axis fast paths, then the
 * `FixedMul(line->dy>>FRACBITS, dx)` / `FixedMul(dy, line->dx>>FRACBITS)`
 * cross-product. Unlike R_PointOnSide there is NO sign-bit fast path, and
 * unlike {@link pointOnDivlineSide} the pre-shift is FRACBITS (whole-unit
 * deltas), so this is the *short-trace* routine PIT_AddLineIntercepts
 * picks under 16 units. On-plane points tie to side 1 (`right < left`).
 */
export function pPointOnLineSide(map: LineMapView, x: number, y: number, line: number): Side {
  const L = map.lines;
  const ldx = L.dx[line]!;
  const ldy = L.dy[line]!;
  const v1x = map.verticesX[L.v1[line]!]!;
  const v1y = map.verticesY[L.v1[line]!]!;

  if (ldx === 0) {
    if (x <= v1x) return (ldy > 0 ? 1 : 0) as Side;
    return (ldy < 0 ? 1 : 0) as Side;
  }
  if (ldy === 0) {
    if (y <= v1y) return (ldx < 0 ? 1 : 0) as Side;
    return (ldx > 0 ? 1 : 0) as Side;
  }

  const dx = (x - v1x) | 0; // C long sub == int32 wrap
  const dy = (y - v1y) | 0;

  const left = FixedMul(ldy >> FRACBITS, dx);
  const right = FixedMul(dy, ldx >> FRACBITS);
  return right < left ? 0 : 1; // front : back
}

/* ------------------------------------------------------------------ */
/* P_BoxOnLineSide — p_maputl.c:106-157                                 */
/* ------------------------------------------------------------------ */

/**
 * `P_BoxOnLineSide(tmbox, ld)` verbatim — line treated as INFINITE;
 * returns side 0/1 or −1 when the box straddles. tmbox field mapping from
 * the m_bbox.h order BOXTOP=0/BOXBOTTOM=1/BOXLEFT=2/BOXRIGHT=3 onto the
 * named {@link FixedBBox}; the diagonal corners probed for the sloped
 * cases are LEFT/TOP + RIGHT/BOTTOM (positive) and RIGHT/TOP + LEFT/
 * BOTTOM (negative), exactly as the switch spells them.
 */
export function pBoxOnLineSide(
  map: LineMapView,
  box: FixedBBox,
  line: number,
): -1 | 0 | 1 {
  const L = map.lines;
  const v1x = map.verticesX[L.v1[line]!]!;
  const v1y = map.verticesY[L.v1[line]!]!;
  let p1: number;
  let p2: number;

  switch (L.slopetype[line]!) {
    case ST_HORIZONTAL:
      p1 = box.top > v1y ? 1 : 0;
      p2 = box.bottom > v1y ? 1 : 0;
      if (L.dx[line]! < 0) {
        p1 ^= 1;
        p2 ^= 1;
      }
      break;

    case ST_VERTICAL:
      p1 = box.right < v1x ? 1 : 0;
      p2 = box.left < v1x ? 1 : 0;
      if (L.dy[line]! < 0) {
        p1 ^= 1;
        p2 ^= 1;
      }
      break;

    case ST_POSITIVE:
      p1 = pPointOnLineSide(map, box.left, box.top, line);
      p2 = pPointOnLineSide(map, box.right, box.bottom, line);
      break;

    default:
      // ST_NEGATIVE
      p1 = pPointOnLineSide(map, box.right, box.top, line);
      p2 = pPointOnLineSide(map, box.left, box.bottom, line);
      break;
  }

  if (p1 === p2) return p1 as 0 | 1;
  return -1;
}

/* ------------------------------------------------------------------ */
/* P_MakeDivline — p_maputl.c:208-217                                   */
/* ------------------------------------------------------------------ */

/**
 * `P_MakeDivline(li, dl)`: fill (optionally allocate, for cold call sites)
 * a {@link DivLine} from linedef `line`. Hot paths pass their own scratch
 * record — the function itself never allocates when `out` is given.
 */
export function divLineFrom(map: LineMapView, line: number, out?: DivLineMut): DivLineMut {
  const L = map.lines;
  const dl = out ?? { x: 0, y: 0, dx: 0, dy: 0 };
  dl.x = map.verticesX[L.v1[line]!]!;
  dl.y = map.verticesY[L.v1[line]!]!;
  dl.dx = L.dx[line]!;
  dl.dy = L.dy[line]!;
  return dl;
}
