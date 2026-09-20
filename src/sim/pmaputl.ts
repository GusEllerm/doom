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
 *  - Thing-side twins: P_BlockThingsIterator is thinglinks.ts's
 *    {@link thingLinksIterator} and PIT_AddThingIntercepts is ported
 *    (M7-02); PT_ADDTHINGS requires the caller to pass the world's
 *    {@link ThingLinks} and throws {@link PMaputlError} without it.
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

import { FixedDiv, FixedMul, FRACBITS, FRACUNIT } from '../core/fixed';
import { MAXINT } from '../core/constants';
import { MAPBLOCKUNITS } from '../core/constants';
import { pointOnDivlineSide, type DivLine, type Side } from './bsp';
import { blockLinesIterator, MAPBLOCKSHIFT, type BlockMap } from './blockmap';
import { thingLinksIterator, type ThingLinks } from './thinglinks';
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
/** p_local.h:39 MAPBLOCKSIZE — 128 units in fixed point. (Our core
 * constant of the same magnitude is named MAPBLOCKUNITS; vanilla's
 * MAPBLOCKUNITS is the bare 128 — the naming inversion noted in
 * sim/blockmap.ts.) */
const MAPBLOCKSIZE = MAPBLOCKUNITS;

/** p_local.h:42 MAPBTOFRAC = MAPBLOCKSHIFT − FRACBITS = 7. */
const MAPBTOFRAC = MAPBLOCKSHIFT - FRACBITS;

/** PIT_AddLineIntercepts' "two routines" threshold, p_maputl.c:570-573. */
const TRACE_FAR = 16 * FRACUNIT;

export class PMaputlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PMaputlError';
  }
}

/** The minimal map surface the point/box/opening helpers need (SoA views;
 * tests may pass a RuntimeMap or a hand-built subset). */
export type LineMapView = Pick<RuntimeMap, 'verticesX' | 'verticesY' | 'lines'>;
export type OpeningMapView = LineMapView & Pick<RuntimeMap, 'sectors'>;

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

/* ------------------------------------------------------------------ */
/* P_InterceptVector — p_maputl.c:221-256 (`#if 1` branch)             */
/* ------------------------------------------------------------------ */

/**
 * `P_InterceptVector(v2, v1)` verbatim, INCLUDING the `>>8` pre-shifts
 * inside the FixedMul arguments (binding — R04 §14 pt.4: they keep the
 * products inside gcc's 32-bit `long` at the cost of dropping the low 8
 * bits of the shifted operand; do NOT “optimize” them away).
 *
 *  - `den == 0` (parallel OR co-linear) ⇒ 0 — the commented-out
 *    `I_Error("parallel")` of :241 is dead in 1.10.
 *  - `FixedDiv` is core/fixed's, incl. its saturating guard (vanilla
 *    p_maputl calls the very same m_fixed.c FixedDiv).
 *  - Precision cost (pinned by the BigInt oracle test): each `>>8` drops
 *    ≤ 2^8⁄2^16 = 1/256 of a map unit from the shifted delta/origin, and
 *    FixedMul truncates at bit 16 — the returned frac can deviate from
 *    the exact rational intercept by O(2^−8) relative; the oracle asserts
 *    the EXACT shifted-integer recipe (not the ideal rational).
 *
 * Returns the fraction of the way along divline v1 (FRACUNIT = the
 * intersection), possibly negative (behind v1's start) or > FRACUNIT.
 */
export function pInterceptVector(v2: DivLine, v1: DivLine): number {
  const den = (FixedMul((v1.dy >> 8) | 0, v2.dx) - FixedMul((v1.dx >> 8) | 0, v2.dy)) | 0;

  if (den === 0) return 0; // parallel or co-linear (:239-242)

  const num =
    (FixedMul(((v1.x - v2.x) | 0) >> 8, v1.dy) +
      FixedMul(((v2.y - v1.y) | 0) >> 8, v1.dx)) |
    0;

  return FixedDiv(num, den);
}

/* ------------------------------------------------------------------ */
/* P_LineOpening — p_maputl.c:290-330                                   */
/* ------------------------------------------------------------------ */

/** The four p_maputl.c:294-297 globals (opentight/closing do NOT exist in
 * 1.10 — plain min/max only, M5-plan §M5-01 “no midtex rules here”). */
export interface LineOpening {
  /** fixed */
  opentop: number;
  /** fixed */
  openbottom: number;
  /** fixed, = opentop − openbottom (stale on one-sided early-out!) */
  openrange: number;
  /** fixed, = min(front.floor, back.floor) */
  lowfloor: number;
}

/** Module singleton standing in for the C globals (vanilla semantics:
 * one active opening at a time, read by the caller before the next call). */
export const opening: LineOpening = { opentop: 0, openbottom: 0, openrange: 0, lowfloor: 0 };

/**
 * `P_LineOpening(linedef)` verbatim. One-sided (sideNumBack sentinel −1,
 * standing in for `sidenum[1] == -1`) sets ONLY openrange = 0 and returns —
 * opentop/openbottom/lowfloor keep whatever the previous call left (the
 * vanilla stale-global quirk, pinned by test). Otherwise plain min/max:
 * opentop = min(ceilings), openbottom = max(floors), lowfloor = min(floors),
 * openrange = opentop − openbottom.
 */
export function pLineOpening(map: OpeningMapView, line: number): LineOpening {
  const L = map.lines;
  if (L.sideNumBack[line] === -1) {
    opening.openrange = 0; // single sided line (:305-309)
    return opening;
  }

  const f = L.sectorFront[line]!;
  const b = L.sectorBack[line]!;
  const S = map.sectors;

  opening.opentop =
    S.ceilingHeight[f]! < S.ceilingHeight[b]! ? S.ceilingHeight[f]! : S.ceilingHeight[b]!;

  if (S.floorHeight[f]! > S.floorHeight[b]!) {
    opening.openbottom = S.floorHeight[f]!;
    opening.lowfloor = S.floorHeight[b]!;
  } else {
    opening.openbottom = S.floorHeight[b]!;
    opening.lowfloor = S.floorHeight[f]!;
  }

  opening.openrange = (opening.opentop - opening.openbottom) | 0;
  return opening;
}

/* ------------------------------------------------------------------ */
/* Intercept arena (p_maputl.c:544-549 intercepts[]/intercept_p)        */
/* ------------------------------------------------------------------ */

/** Read-only view of one intercept, valid ONLY during the traverser call
 * (vanilla `intercept_t* in` semantics — copy fields out to keep them). */
export interface Intercept {
  /** fixed fraction of the trace (0..FRACUNIT inside the segment) */
  frac: number;
  isLine: boolean;
  /** linedef index (−1 for things) */
  line: number;
  /** M7-02: ThingLinks slot for thing intercepts (−1 for lines) —
   * PIT_AddThingIntercepts' `d.thing` (p_maputl.c:657-661); consumers
   * (M7-05 ray shot/missile traversers) read this with isLine=false. */
  thing: number;
}

/** Vanilla `traverser_t`: return false to stop the traversal (early out). */
export type Traverser = (in_: Intercept) => boolean;

const interceptFrac = new Int32Array(MAXINTERCEPTS);
const interceptIsLine = new Uint8Array(MAXINTERCEPTS);
const interceptLine = new Int32Array(MAXINTERCEPTS);
/** M7-02 thing intercepts (PT_ADDTHINGS): slot id per entry. */
const interceptThing = new Int32Array(MAXINTERCEPTS);
let interceptP = 0;

/** Module singletons standing in for `trace`/`earlyout` (p_maputl.c:547-549).
 * Only one traversal is active at a time — vanilla's single-threaded rule. */
const trace: DivLineMut = { x: 0, y: 0, dx: 0, dy: 0 };
let earlyout = false;
/** The linedef view PIT_AddLineIntercepts reads (vanilla implicit state). */
let activeMap: LineMapView | null = null;
const dlScratch: DivLineMut = { x: 0, y: 0, dx: 0, dy: 0 };
const view: Intercept = { frac: 0, isLine: false, line: -1, thing: -1 };
const scan: { valid: Int32Array; stamp: number } = { valid: new Int32Array(0), stamp: 0 };

/** Read the current trace divline (slide traverse, M5-04, reads these). */
export function pathTrace(): Readonly<DivLineMut> {
  return trace;
}

/* ------------------------------------------------------------------ */
/* PIT_AddLineIntercepts — p_maputl.c:556-610                           */
/* ------------------------------------------------------------------ */

/**
 * `PIT_AddLineIntercepts(ld)` verbatim (line index instead of pointer).
 * The "avoid precision problems with two routines" branch picks
 * {@link pointOnDivlineSide} on the line endpoints for traces longer than
 * 16 units, {@link pPointOnLineSide} on the trace endpoints otherwise
 * (p_maputl.c:570-582). earlyout fires only on truly one-sided lines
 * (sectorBack sentinel −1 ⇔ vanilla `!ld->backsector`).
 */
function pitAddLineIntercepts(line: number): boolean {
  const map = activeMap!;
  const L = map.lines;

  let s1: Side;
  let s2: Side;
  if (
    trace.dx > TRACE_FAR ||
    trace.dy > TRACE_FAR ||
    trace.dx < -TRACE_FAR ||
    trace.dy < -TRACE_FAR
  ) {
    s1 = pointOnDivlineSide(map.verticesX[L.v1[line]!]!, map.verticesY[L.v1[line]!]!, trace);
    s2 = pointOnDivlineSide(map.verticesX[L.v2[line]!]!, map.verticesY[L.v2[line]!]!, trace);
  } else {
    s1 = pPointOnLineSide(map, trace.x, trace.y, line);
    s2 = pPointOnLineSide(map, (trace.x + trace.dx) | 0, (trace.y + trace.dy) | 0, line);
  }

  if (s1 === s2) return true; // line isn't crossed

  // hit the line
  divLineFrom(map, line, dlScratch);
  const frac = pInterceptVector(trace, dlScratch);

  if (frac < 0) return true; // behind source

  // try to early out the check
  if (earlyout && frac < FRACUNIT && L.sectorBack[line] === -1) {
    return false; // stop checking
  }

  if (interceptP === MAXINTERCEPTS) {
    throw new PMaputlError('P_PathTraverse: MAXINTERCEPTS overflow');
  }
  interceptFrac[interceptP] = frac;
  interceptIsLine[interceptP] = 1;
  interceptLine[interceptP] = line;
  interceptThing[interceptP] = -1;
  interceptP++;

  return true; // continue
}

/* ------------------------------------------------------------------ */
/* PIT_AddThingIntercepts — p_maputl.c:615-675 (M7-02)                  */
/* ------------------------------------------------------------------ */

/** The thing grid PIT_AddThingIntercepts reads (vanilla implicit blocklinks). */
let activeLinks: ThingLinks | null = null;

/**
 * `PIT_AddThingIntercepts(thing)` verbatim (argument = ThingLinks slot):
 * the corner-to-corner crossection diagonal (tracepositive picks the
 * corner pair), sides against the trace divline, divline from the
 * crossed corner pair, frac < 0 ⇒ behind. No MF_NOBLOCKMAP test needed:
 * inert things never enter the chains (thinglinks.ts), exactly like
 * vanilla's blocklinks. NO validcount dedup — a thing bordering two
 * visited blocks yields two intercepts, as in the C original.
 */
function pitAddThingIntercepts(slot: number): boolean {
  const links = activeLinks!;
  const tracepositive = (trace.dx ^ trace.dy) > 0;

  // check a corner to corner crossection for hit
  const x1 = (links.x[slot]! - links.radius[slot]!) | 0;
  const x2 = (links.x[slot]! + links.radius[slot]!) | 0;
  const y1 = tracepositive
    ? (links.y[slot]! + links.radius[slot]!) | 0
    : (links.y[slot]! - links.radius[slot]!) | 0;
  const y2 = tracepositive
    ? (links.y[slot]! - links.radius[slot]!) | 0
    : (links.y[slot]! + links.radius[slot]!) | 0;

  const s1 = pointOnDivlineSide(x1, y1, trace);
  const s2 = pointOnDivlineSide(x2, y2, trace);
  if (s1 === s2) return true; // line isn't crossed

  dlScratch.x = x1;
  dlScratch.y = y1;
  dlScratch.dx = (x2 - x1) | 0;
  dlScratch.dy = (y2 - y1) | 0;

  const frac = pInterceptVector(trace, dlScratch);
  if (frac < 0) return true; // behind source

  if (interceptP === MAXINTERCEPTS) {
    throw new PMaputlError('P_PathTraverse: MAXINTERCEPTS overflow');
  }
  interceptFrac[interceptP] = frac;
  interceptIsLine[interceptP] = 0;
  interceptLine[interceptP] = -1;
  interceptThing[interceptP] = slot;
  interceptP++;

  return true; // keep going
}

/* ------------------------------------------------------------------ */
/* P_TraverseIntercepts — p_maputl.c:677-735                            */
/* ------------------------------------------------------------------ */

/**
 * `P_TraverseIntercepts(func, maxfrac)` verbatim: repeatedly pick the
 * LOWEST-index intercept with the smallest frac (strict `<` scan ⇒ ties go
 * to insertion order — the exact ordering rule later traversers rely on),
 * stop when the next frac exceeds maxfrac, and poison consumed entries
 * with MAXINT.
 */
export function pTraverseIntercepts(trav: Traverser, maxfrac: number): boolean {
  let count = interceptP;
  let inIdx = 0;

  while (count-- > 0) {
    let dist = MAXINT;
    for (let s = 0; s < interceptP; s++) {
      if (interceptFrac[s]! < dist) {
        dist = interceptFrac[s]!;
        inIdx = s;
      }
    }

    if (dist > maxfrac) return true; // checked everything in range

    view.frac = dist;
    view.isLine = interceptIsLine[inIdx] === 1;
    view.line = interceptLine[inIdx]!;
    view.thing = interceptThing[inIdx]!;
    if (!trav(view)) return false; // don't bother going farther

    interceptFrac[inIdx] = MAXINT;
  }

  return true; // everything was traversed
}

/* ------------------------------------------------------------------ */
/* P_PathTraverse — p_maputl.c:737-879                                  */
/* ------------------------------------------------------------------ */

/**
 * `P_PathTraverse(x1,y1,x2,y2,flags,trav)` verbatim: blockmap DDA over the
 * 128-unit grid (MAPBLOCKSHIFT/MAPBTOFRAC FixedDiv steps, 64-iteration
 * round-off guard), `validcount++` dedup through blockmap.ts's
 * {@link BlockScan}, PT_EARLYOUT ⇔ earlyout, then
 * {@link pTraverseIntercepts} at FRACUNIT. Fixed-point coords in.
 *
 * Deviations: PT_ADDTHINGS without a supplied {@link ThingLinks} grid
 * throws (M7-02 wired the real {@link pitAddThingIntercepts} — pass the
 * world's links as the trailing argument); the MAXINTERCEPTS arena throws
 * instead of corrupting memory.
 */
export function pPathTraverse(
  map: LineMapView,
  bm: BlockMap,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  flags: number,
  trav: Traverser,
  links?: ThingLinks,
): boolean {
  earlyout = (flags & PT_EARLYOUT) !== 0;

  scan.valid = map.lines.valid;
  scan.stamp = bumpValidcount(); // vanilla `validcount++`
  interceptP = 0;
  activeMap = map;
  activeLinks = links ?? null;

  if (((x1 - bm.originX) & (MAPBLOCKSIZE - 1)) === 0) x1 = (x1 + FRACUNIT) | 0; // don't side exactly on a line
  if (((y1 - bm.originY) & (MAPBLOCKSIZE - 1)) === 0) y1 = (y1 + FRACUNIT) | 0;

  trace.x = x1;
  trace.y = y1;
  trace.dx = (x2 - x1) | 0;
  trace.dy = (y2 - y1) | 0;

  x1 = (x1 - bm.originX) | 0;
  y1 = (y1 - bm.originY) | 0;
  const xt1 = x1 >> MAPBLOCKSHIFT;
  const yt1 = y1 >> MAPBLOCKSHIFT;

  x2 = (x2 - bm.originX) | 0;
  y2 = (y2 - bm.originY) | 0;
  const xt2 = x2 >> MAPBLOCKSHIFT;
  const yt2 = y2 >> MAPBLOCKSHIFT;

  let mapxstep: number;
  let partial: number;
  let ystep: number;
  if (xt2 > xt1) {
    mapxstep = 1;
    partial = (FRACUNIT - ((x1 >> MAPBTOFRAC) & (FRACUNIT - 1))) | 0;
    ystep = FixedDiv((y2 - y1) | 0, abs32((x2 - x1) | 0));
  } else if (xt2 < xt1) {
    mapxstep = -1;
    partial = (x1 >> MAPBTOFRAC) & (FRACUNIT - 1);
    ystep = FixedDiv((y2 - y1) | 0, abs32((x2 - x1) | 0));
  } else {
    mapxstep = 0;
    partial = FRACUNIT;
    ystep = 256 * FRACUNIT;
  }
  let yintercept = ((y1 >> MAPBTOFRAC) + FixedMul(partial, ystep)) | 0;

  let mapystep: number;
  let xstep: number;
  if (yt2 > yt1) {
    mapystep = 1;
    partial = (FRACUNIT - ((y1 >> MAPBTOFRAC) & (FRACUNIT - 1))) | 0;
    xstep = FixedDiv((x2 - x1) | 0, abs32((y2 - y1) | 0));
  } else if (yt2 < yt1) {
    mapystep = -1;
    partial = (y1 >> MAPBTOFRAC) & (FRACUNIT - 1);
    xstep = FixedDiv((x2 - x1) | 0, abs32((y2 - y1) | 0));
  } else {
    mapystep = 0;
    partial = FRACUNIT;
    xstep = 256 * FRACUNIT;
  }
  let xintercept = ((x1 >> MAPBTOFRAC) + FixedMul(partial, xstep)) | 0;

  // Step through map blocks (count guards a round-off skipping the break).
  let mapx = xt1;
  let mapy = yt1;

  for (let count = 0; count < 64; count++) {
    if (flags & PT_ADDLINES) {
      if (!blockLinesIterator(bm, mapx, mapy, pitAddLineIntercepts, scan)) {
        return false; // early out
      }
    }

    if (flags & PT_ADDTHINGS) {
      if (!activeLinks) {
        throw new PMaputlError('P_PathTraverse: PT_ADDTHINGS needs the ThingLinks grid (M7-02)');
      }
      if (!thingLinksIterator(activeLinks, mapx, mapy, pitAddThingIntercepts)) {
        return false; // early out
      }
    }

    if (mapx === xt2 && mapy === yt2) {
      break;
    }

    if ((yintercept >> FRACBITS) === mapy) {
      yintercept = (yintercept + ystep) | 0;
      mapx += mapxstep;
    } else if ((xintercept >> FRACBITS) === mapx) {
      xintercept = (xintercept + xstep) | 0;
      mapy += mapystep;
    }
  }

  // go through the sorted list
  return pTraverseIntercepts(trav, FRACUNIT);
}
