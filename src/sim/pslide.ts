/**
 * sim/pslide.ts — P_SlideMove + P_HitSlideLine (M5-04, p_map.c part 3).
 *
 * Ported verbatim from linuxdoom-1.10 p_map.c:438-555 (globals) and
 * :580-787 (P_HitSlideLine / PTR_SlideTraverse / P_SlideMove), with
 * p_maputl/r_main helpers reused from sim/pmaputl + core/tables:
 *
 *  - P_SlideMove       p_map.c:695-787  ("This is a kludgy mess.")
 *  - P_HitSlideLine    p_map.c:584-630
 *  - PTR_SlideTraverse p_map.c:636-687
 *
 * ## Usage contract (M5-05/M5-06 caller seam)
 *
 * Vanilla calls P_SlideMove ONLY from P_XYMovement (p_mobj.c:158-172) after
 * `P_TryMove(mo, x+xmove, y+ymove)` on the FULL clamped delta has FAILED —
 * that precondition is the caller's job (M5-05 wires it):
 *
 *     if (!P_TryMove(mo, mo.x + xmove, mo.y + ymove)) P_SlideMove(mo);
 *
 * Momentum semantics (pinned from the sources, relevant to M5-05 friction):
 *  - P_SlideMove never touches z, flags or friction. The momentum it leaves
 *    on the mover is the *remainder* projection (FixedMul by
 *    FRACUNIT − hitfrac, then P_HitSlideLine's clipping) — the momentum the
 *    move did NOT spend into the wall, i.e. sliding KEEPS momentum; the
 *    per-tic decay is P_Friction's, which vanilla runs BEFORE the TryMove
 *    (p_mobj.c P_XYMovement) and never inside the slide.
 *  - MF_SLIDE (p_mobj.h:152, value 0x2000) is **not referenced by any
 *    1.10 .c file at all** (grep over linuxdoom-1.10: only the enum and
 *    `ld->slopetype == ST_*` uses of the word SLIDE appear) — the
 *    "MF_SLIDE skips friction" behaviour belongs to later sources
 *    (BOOM/PrBoom+ P_Friction), NOT vanilla. Nothing here branches on it;
 *    M5-05's friction is flag-blind exactly like 1.10's.
 *  - There is NO "15-tic slide loop" in 1.10 (that is a modern-port
 *    feature): the loop in P_SlideMove is the `retry`/hitcount control,
 *    capped at 3 (`++hitcount == 3 ⇒ stairstep`), NOT a tic loop. It runs
 *    entirely within ONE tic.
 *
 * ## Control-flow pins (p_map.c:695-787)
 *  - Corner traces: THREE leading corners only — (lead,lead), (trail,lead),
 *    (lead,trail); the trail/trail corner is NEVER traced (:733-737).
 *  - `mom > 0 ? x+r : x−r` sign test: momentum EXACTLY zero takes the
 *    "−" branch (leadx = x − radius) — pinned at :708-723.
 *  - bestslidefrac initialised FRACUNIT+1; unchanged ⇒ the move "must have
 *    hit the middle" ⇒ stairstep: TryMove(x, y+momy) first, and only on
 *    THAT failure TryMove(x+momx, y) (:742-754; y-attempt-first order).
 *  - 0x800 fudge BEFORE the flush move; a failed flush TryMove also goes to
 *    stairstep; remainder = FRACUNIT − (fudged+0x800), clamped to
 *    [1..FRACUNIT], and `<= 0 ⇒ return` BEFORE any momentum write — the
 *    mover keeps its FULL original momentum in that case (:768-772).
 *  - momentum is written (`mo.momx/y = tmxmove/tmymove`) strictly AFTER
 *    P_HitSlideLine and BEFORE the final TryMove, so a failing final move
 *    retries with the clipped momentum already in place.
 *
 * ## P_HitSlideLine pins (p_map.c:584-630)
 *  - ST_HORIZONTAL ⇒ tmymove = 0 (x untouched); ST_VERTICAL ⇒ tmxmove = 0
 *    (y untouched) — the axis branches return EARLY, no projection.
 *  - projection branch: side==1 flips lineangle by 180°;
 *    `deltaangle > ANG180 ⇒ deltaangle += ANG180` is vanilla's mirror
 *    kludge (the commented-out `I_Error("SlideLine: ang>ANG180")` at :611);
 *    movelen is the OCTAGONAL P_AproxDistance (≤ ~2.9 % longer than
 *    euclidean — vanilla's real slide-length distortion, kept).
 *  - angles are unsigned: all angle arithmetic here is `>>> 0` mod 2^32
 *    (core/fixed angAdd/angSub/angToFine).
 *
 * DEVIATIONS (documented):
 *  - `slidemo`/`tmxmove`/`tmymove`/bestslide* are the {@link slideState}
 *    module singleton (vanilla file-scope globals); pHitSlideLine takes the
 *    map + mover explicitly instead of reading implicit `level`/`slidemo`
 *    (same pattern as pmap's explicit world parameter, M5-02).
 *  - `goto retry` / `goto stairstep` become an explicit `for(;;)` + `break`
 *    (M5-plan §M5-04 "no gotos"); order is identical.
 *  - secondslidefrac/secondslideline are tracked but unread — exactly
 *    vanilla (p_map.c:677-681; dead there too).
 *  - vanilla's I_Error("PTR_SlideTraverse: not a line?") ⇒ thrown
 *    PSlideError (thing intercepts never occur: PT_ADDLINES only).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { ANG180, ANG270, ANG90, FRACUNIT } from "../core/constants";import { angAdd, angSub, angToFine, FixedMul } from "../core/fixed";
import { finecosine, finesine, SlopeDiv, tantoangle } from "../core/tables";
import { ST_HORIZONTAL, ST_VERTICAL } from "./map";
import { pmoveHooks } from "./pmove";
import { MAXSTEP, pTryMove, type Mover, type PMapWorld } from "./pmap";
import {
  pAproxDistance,
  pLineOpening,
  pPathTraverse,
  pPointOnLineSide,
  PT_ADDLINES,
  type Intercept,
  type LineMapView,
} from "./pmaputl";

/** ML_TWOSIDED as the one-sided test is DEVIATED: this port keys
 * front/back off the {@link LineArrays}.sideNumBack == −1 sentinel (the
 * M5-01 rule — the leaked doomdata.h:108 editor bit `4` is NOT the
 * released-WAD two-sided signal), so no ML_ constant is needed here. */

/** Mover slice with momentum — the mobj_t fields P_SlideMove reads/writes.
 * M5-05's real mover carries momx/momy too; this seam extends {@link Mover}
 * without touching pmap.ts (owned by M5-02/03). */
export interface SlideMover extends Mover {
  /** fixed momentum/tic (mobj_t momx, p_mobj.h:226) */
  momx: number;
  momy: number;
}

export class PSlideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PSlideError";
  }
}

/* ------------------------------------------------------------------ */
/* p_map.c file-scope globals for the slide path                        */
/* ------------------------------------------------------------------ */

/**
 * Vanilla globals: slidemo (:53), bestslidefrac/secondslidefrac/
 * bestslideline/secondslideline (:55-58 — initial values 0x40000000 are
 * overwritten before every use, the FRACUNIT+1 init happens in
 * pSlideMove :726), tmxmove/tmymove (:438-443), and the local hitcount.
 * `hitcount` is the retry count of the LAST pSlideMove call (observability
 * for the 3-cap acceptance test; vanilla's is a stack local).
 */
export const slideState = {
  /** slidemo */
  mo: null as SlideMover | null,
  /** bestslidefrac (fixed; FRACUNIT+1 = nothing hit) */
  bestFrac: FRACUNIT + 1,
  /** bestslideline (−1 = NULL) */
  bestLine: -1,
  /** secondslidefrac — written by the tracking kludge, never read (vanilla) */
  secondFrac: 0,
  /** secondslideline — likewise dead in 1.10 */
  secondLine: -1,
  /** tmxmove (fixed) — the slide scratch move P_HitSlideLine clips */
  xmove: 0,
  /** tmymove */
  ymove: 0,
  /** retry count used by the last pSlideMove (1..3) */
  hitcount: 0,
};

/** Active world for PTR_SlideTraverse (vanilla's implicit `level`). */
let world: PMapWorld | null = null;

/* ------------------------------------------------------------------ */
/* R_PointToAngle2(0, 0, x, y) — r_main.c:340-437,378-390               */
/* ------------------------------------------------------------------ */

/**
 * `R_PointToAngle2(0,0,x,y)` verbatim: the eight-octant tantoangle/SlopeDiv
 * switch of R_PointToAngle with viewx=viewy=0, incl. the
 * `(!x)&&(!y) ⇒ 0` early-out and the `ANG90 − 1`/`ANG180 − 1`/`ANG270 − 1`
 * octant-boundary off-by-ones (x==0, y>0 ⇒ ANG90−1, NOT ANG90 — the famous
 * quirk P_HitSlideLine's deltaangle inherits). Unsigned mod-2^32 angle
 * arithmetic via angAdd/angSub; argument magnitudes ≤ 2^31 fixed
 * (SlopeDiv's `num<<3` wraps identically to the C `unsigned` shift).
 */
export function pointToAngleOrigin(x: number, y: number): number {
  if (x === 0 && y === 0) return 0; // r_main.c:343-345

  if (x >= 0) {
    if (y >= 0) {
      if (x > y) return tantoangle[SlopeDiv(y, x)]!; // octant 0
      return angSub(angSub(ANG90, 1), tantoangle[SlopeDiv(x, y)]!); // octant 1
    }
    const ny = -y;
    if (x > ny) return angSub(0, tantoangle[SlopeDiv(ny, x)]!); // octant 8
    return angAdd(ANG270, tantoangle[SlopeDiv(x, ny)]!); // octant 7
  }
  const nx = -x;
  if (y >= 0) {
    if (nx > y) return angSub(angSub(ANG180, 1), tantoangle[SlopeDiv(y, nx)]!); // octant 3
    return angAdd(ANG90, tantoangle[SlopeDiv(nx, y)]!); // octant 2
  }
  const ny = -y;
  if (nx > ny) return angAdd(ANG180, tantoangle[SlopeDiv(ny, nx)]!); // octant 4
  return angSub(angSub(ANG270, 1), tantoangle[SlopeDiv(nx, ny)]!); // octant 5
}

/* ------------------------------------------------------------------ */
/* P_HitSlideLine — p_map.c:584-630                                     */
/* ------------------------------------------------------------------ */

/**
 * `P_HitSlideLine(ld)` — clips the {@link slideState}.xmove/ymove scratch
 * so the next move slides along `line`. Reads the mover's position for the
 * front/back test (vanilla `slidemo`). DEVIATION: map + mover are explicit
 * parameters (vanilla implicit globals); behaviour identical.
 */
export function pHitSlideLine(map: LineMapView, mo: Mover, line: number): void {
  const L = map.lines;

  if (L.slopetype[line] === ST_HORIZONTAL) {
    slideState.ymove = 0;
    return;
  }
  if (L.slopetype[line] === ST_VERTICAL) {
    slideState.xmove = 0;
    return;
  }

  const side = pPointOnLineSide(map, mo.x, mo.y, line);

  let lineangle = pointToAngleOrigin(L.dx[line]!, L.dy[line]!);
  if (side === 1) lineangle = angAdd(lineangle, ANG180);

  const moveangle = pointToAngleOrigin(slideState.xmove, slideState.ymove);
  let deltaangle = angSub(moveangle, lineangle);
  if (deltaangle > ANG180) deltaangle = angAdd(deltaangle, ANG180); // :611 mirror kludge

  const movelen = pAproxDistance(slideState.xmove, slideState.ymove);
  const newlen = FixedMul(movelen, finecosine[angToFine(deltaangle)]!);

  slideState.xmove = FixedMul(newlen, finecosine[angToFine(lineangle)]!);
  slideState.ymove = FixedMul(newlen, finesine[angToFine(lineangle)]!);
}

/* ------------------------------------------------------------------ */
/* PTR_SlideTraverse — p_map.c:636-687                                  */
/* ------------------------------------------------------------------ */

/**
 * `PTR_SlideTraverse(in)` — traverser over PT_ADDLINES intercepts. Height
 * tests verbatim (:653-664) with NO flag tests (MF_TELEPORT/MF_NOCLIP
 * shortcuts exist only inside P_TryMove; vanilla never slides noclip movers
 * because TryMove cannot fail for them). Blocking lines record the nearest
 * hit (second-line tracking :677-681, dead in 1.10) and STOP the walk.
 */
function ptrSlideTraverse(in_: Intercept): boolean {
  const w = world!;
  const mo = slideState.mo!;
  const L = w.map.lines;
  const line = in_.line;

  if (!in_.isLine) throw new PSlideError("PTR_SlideTraverse: not a line?");

  let blocked: boolean;
  if (L.sideNumBack[line] === -1) {
    // one-sided (vanilla `!(li->flags & ML_TWOSIDED)`; sentinel convention
    // per p_maputl M5-01 — see ML_TWOSIDED note above)
    if (pPointOnLineSide(w.map, mo.x, mo.y, line)) return true; // don't hit the back side
    blocked = true;
  } else {
    const op = pLineOpening(w.map, line, w.sectors);
    blocked =
      ((op.openrange | 0) < mo.height || // doesn't fit
        ((op.opentop - mo.z) | 0) < mo.height || // mobj is too high
        ((op.openbottom - mo.z) | 0) > MAXSTEP); // too big a step up (24*FRACUNIT)
    if (!blocked) return true; // this line doesn't block movement
  }

  // the line does block movement, see if it is closer than best so far
  if (in_.frac < slideState.bestFrac) {
    slideState.secondFrac = slideState.bestFrac;
    slideState.secondLine = slideState.bestLine;
    slideState.bestFrac = in_.frac;
    slideState.bestLine = line;
  }
  return false; // stop
}

/* ------------------------------------------------------------------ */
/* P_SlideMove — p_map.c:695-787                                        */
/* ------------------------------------------------------------------ */

/**
 * `P_SlideMove(mo)` — the momx/momy move is bad (caller's P_TryMove on the
 * full delta failed); move flush to the first blocking line (−0x800 fudge)
 * and slide along it with the remainder momentum. `goto retry`/`goto
 * stairstep` become the explicit loop + trailing block below; the hitcount
 * cap of 3 prevents infinite corner loops.
 */
export function pSlideMove(world_: PMapWorld, mo: SlideMover): void {
  world = world_;
  slideState.mo = mo;
  let hitcount = 0;

  // `retry:` — C increments hitcount at the loop head and stairsteps at 3.
  for (;;) {
    hitcount++;
    if (hitcount === 3) break; // :710 — don't loop forever

    // trace along the three leading corners (:713-724). mom == 0 takes the
    // ELSE branch (lead on the − side) — pinned vanilla sign test.
    const leadx = (mo.momx > 0 ? mo.x + mo.radius : mo.x - mo.radius) | 0;
    const trailx = (mo.momx > 0 ? mo.x - mo.radius : mo.x + mo.radius) | 0;
    const leady = (mo.momy > 0 ? mo.y + mo.radius : mo.y - mo.radius) | 0;
    const traily = (mo.momy > 0 ? mo.y - mo.radius : mo.y + mo.radius) | 0;

    slideState.bestFrac = FRACUNIT + 1;

    const map = world_.map;
    pPathTraverse(map, world_.bm, leadx, leady, (leadx + mo.momx) | 0, (leady + mo.momy) | 0, PT_ADDLINES, ptrSlideTraverse);
    pPathTraverse(map, world_.bm, trailx, leady, (trailx + mo.momx) | 0, (leady + mo.momy) | 0, PT_ADDLINES, ptrSlideTraverse);
    pPathTraverse(map, world_.bm, leadx, traily, (leadx + mo.momx) | 0, (traily + mo.momy) | 0, PT_ADDLINES, ptrSlideTraverse);

    if (slideState.bestFrac === FRACUNIT + 1) break; // :742 — hit the middle ⇒ stairstep

    // fudge a bit to make sure it doesn't hit (:760)
    slideState.bestFrac = (slideState.bestFrac - 0x800) | 0;
    if (slideState.bestFrac > 0) {
      const newx = FixedMul(mo.momx, slideState.bestFrac);
      const newy = FixedMul(mo.momy, slideState.bestFrac);
      if (!pTryMove(world_, mo, (mo.x + newx) | 0, (mo.y + newy) | 0)) break; // ⇒ stairstep
    }

    // Now continue along the wall. First calculate remainder (:770-776).
    let frac = (FRACUNIT - (slideState.bestFrac + 0x800)) | 0;
    if (frac > FRACUNIT) frac = FRACUNIT;
    if (frac <= 0) {
      slideState.hitcount = hitcount; // momentum UNCHANGED — vanilla returns here
      return; // :772
    }

    slideState.xmove = FixedMul(mo.momx, frac);
    slideState.ymove = FixedMul(mo.momy, frac);

    pHitSlideLine(world_.map, mo, slideState.bestLine); // clip the moves

    mo.momx = slideState.xmove;
    mo.momy = slideState.ymove;

    slideState.hitcount = hitcount;
    if (!pTryMove(world_, mo, (mo.x + slideState.xmove) | 0, (mo.y + slideState.ymove) | 0)) {
      continue; // retry:
    }
    return;
  }

  // stairstep: (:743-754) try the y leg first, x only on its failure.
  slideState.hitcount = hitcount;
  if (!pTryMove(world_, mo, mo.x, (mo.y + mo.momy) | 0)) {
    pTryMove(world_, mo, (mo.x + mo.momx) | 0, mo.y);
  }
}

/* ------------------------------------------------------------------ */
/* M5-06 caller-seam self-registration (see "Usage contract" header)   */
/* ------------------------------------------------------------------ */

// p_mobj.c calls P_SlideMove directly from P_XYMovement; this port keeps
// that as the typed hook slot (M5-05), and importing THIS module is what
// fulfils the contract — ??= so a test that installed its own probe hook
// first is never overwritten.
pmoveHooks.slideMove ??= (mo, world_) => pSlideMove(world_, mo);
