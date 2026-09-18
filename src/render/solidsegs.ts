// render/solidsegs.ts — M3-03: the horizontal occlusion ledger + HOM counters.
//
// Faithful port of linuxdoom-1.10 r_bsp.c:
//   cliprange_t {first,last}        r_bsp.c:79-86
//   #define MAXSEGS 32              r_bsp.c:88   (VERIFIED: in r_bsp.c, NOT r_local.h)
//   solidsegs[MAXSEGS] + newend     r_bsp.c:91-92 (static/BSS zero-initialized)
//   R_ClipSolidWallSegment          r_bsp.c:98-186
//   R_ClipPassWallSegment           r_bsp.c:197-238
//   R_ClearClipSegs                 r_bsp.c:245-252
//   R_CheckBBox fully-covered walk  r_bsp.c:475-483  (M3-04 consumes via the
//                                     raw accessors below; it walks with the
//                                     same "adjacent pixels are touching" rule)
//   R_AddLine dispatch              r_bsp.c:351/355 — pass segs call with
//                                     (x1, x2-1), solid segs likewise; caller
//                                     guarantees first <= last.
// Counters also cover r_segs.c:
//   MAXDRAWSEGS(256) silent return  r_segs.c:385-387, r_defs.h:55  → drawsegOverflow
//   start > stop store range        r_segs.c:389-392 (I_Error, #ifdef RANGECHECK)
//                                     → hom++ (deviation, see noteBadStoreRange)
//
// Storage layout (ARCHITECTURE §4.2): one Int32Array of {first,last,drawsegRef}
// triples. Vanilla's struct is {first,last} only — solidsegs in 1.10 carry no
// drawseg pointer at all (that was the pre-1.2 linked-list clipsegs); the
// third slot is our addition so M3-06 can attach drawseg indices. Struct
// assignments (`*next = *(next-1)` etc.) copy all three slots; slot 2 of a
// freshly inserted span is -1 (no drawseg yet — M3-06 fills it after its
// R_StoreWallRange), and merges move refs with their entries (last-touch
// semantics belong to the setter, not to the ledger).
//
// Junk entries past the right sentinel: the crunch loop
// `while (next++ != newend) *++start = *next;` (r_bsp.c:178-181) executes
// (newend - next) bodies while only (newend - 1 - next) posts actually move —
// it always copies ONE entry too many, reading `solidsegs[newend]`, one
// element past the valid ledger, and the surviving newend is one larger than
// the entries it moved. So a vanilla list may carry a junk entry at
// newend-1 with the right sentinel at newend-2. Nothing can ever observe it:
// every walk's stop test fires on the right sentinel (last == 0x7fffffff)
// before reaching the junk. The literal loop is kept below; our
// out-of-bounds slot read yields 0/stale residue instead of vanilla's
// adjacent BSS globals — unobservable either way.
//
// DEVIATIONS (per M3-plan §M3-03; see report):
// 1. MAXSEGS insert overflow: vanilla 1.10 has NO guard — `newend++`
//    (r_bsp.c:125) writes past solidsegs[31] (r_bsp.c:92) = silent memory
//    corruption (not I_Error as the task note guessed). We stop the insert and
//    raise hom++ (+ solidsegDrops++) instead. The fragment is still reported,
//    mirroring that vanilla calls R_StoreWallRange BEFORE the overflow write
//    (r_bsp.c:123 precedes :124-125) — drawn pixels with no occlusion record
//    is exactly the HOM the counter means.
// 2. Inverted store range (start > stop) inside fragment emission: vanilla
//    I_Error under #ifdef RANGECHECK (r_segs.c:389-392; ships disabled) —
//    we hom++ and drop that fragment unconditionally.
// 3. Vanilla clip functions return void and call R_StoreWallRange inline;
//    ours return the fragment list (count + fragStart/fragStop) for M3-06 to
//    store. Reporting order is identical to the C call order.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { MAXINT } from '../core/constants';

/** r_bsp.c:88 (`#define MAXSEGS 32`). */
export const MAXSEGS = 32;

/** Vanilla default viewwidth (doomdef.h SCREENWIDTH 320; viewwidth is set in
 * R_ExecuteSetViewSize, r_main.c — detailshift 0 ⇒ 320). */
export const DEFAULT_VIEWWIDTH = 320;

const STRIDE = 3; // {first, last} (r_bsp.c:79-86) + drawseg ref (§4.2)
const FIRST = 0;
const LAST = 1;
const DSREF = 2;

// Static storage: vanilla `cliprange_t solidsegs[MAXSEGS]` is BSS-zeroed
// (r_bsp.c:92); Int32Array zero-initializes identically, and R_ClearClipSegs
// (r_bsp.c:245-252) only ever rewrites entries 0-1 — junk past the sentinel
// persists frame to frame exactly like the C static.
const segs = new Int32Array(MAXSEGS * STRIDE);

/** newend — index one past the last valid seg (r_bsp.c:91). */
let end = 0;

// Fragment scratch, reused per call (zero allocation in the clip path).
// Max fragments per call = 1 (above) + ≤ end-2 (between) + 1 (after) < 2*MAXSEGS.
const frags = new Int32Array(2 * (MAXSEGS + 2));
let nfrags = 0;

const counters = {
  hom: 0,
  drawsegOverflow: 0,
  solidsegDrops: 0,
  visplaneOverflow: 0,
  openingOverflow: 0,
};

/** Public snapshot of the render health counters (debug.ts / goldens read
 * this via getRenderCounters; returns a copy). visplaneOverflow/opening-
 * Overflow added M4-01 (same live-counter API, plan §M4-01). */
export interface RenderCounters {
  hom: number;
  drawsegOverflow: number;
  solidsegDrops: number;
  /** MAXVISPLANES 128 hit (vanilla `I_Error("R_FindPlane: no more
   * visplanes")` — port: counter + typed throw, planes.ts). */
  visplaneOverflow: number;
  /** openings pool exhaustion (vanilla silent static corruption, MAXOPENINGS
   * SCREENWIDTH*64) — incremented by drawsegs.ts allocOpenings. */
  openingOverflow: number;
}

// --- storage helpers (struct assignment = 3-slot copy) ---------------------

function at(i: number, slot: number): number {
  // `?? 0`: out-of-window reads (the crunch loop's literal past-the-end
  // source slot, see header) coerce to 0; vanilla reads adjacent BSS there.
  return segs[i * STRIDE + slot] ?? 0;
}

function put(i: number, slot: number, v: number): void {
  segs[i * STRIDE + slot] = v;
}

/** `*dst = *src` of cliprange_t (+ ref slot). */
function copyEntry(src: number, dst: number): void {
  const b0 = src * STRIDE;
  const b1 = dst * STRIDE;
  for (let k = 0; k < STRIDE; k++) segs[b1 + k] = segs[b0 + k] ?? 0;
}

/**
 * The R_StoreWallRange call site of the clip functions (r_bsp.c:123/138/151/
 * 164 solid, :214/219/229/237 pass). Records the fragment for M3-06; an
 * inverted range is the r_segs.c:390 "Bad R_RenderWallRange" case — vanilla
 * I_Error (RANGECHECK builds), us hom++ + skip (DEVIATION 2).
 */
function storeWallRange(start: number, stop: number): void {
  if (start > stop) {
    counters.hom++;
    return;
  }
  frags[nfrags * 2] = start;
  frags[nfrags * 2 + 1] = stop;
  nfrags++;
}

// --- R_ClearClipSegs (r_bsp.c:245-252) --------------------------------------

/**
 * Sentinels: (−0x7fffffff, −1) left, (viewwidth, 0x7fffffff) right,
 * newend = solidsegs+2. Vanilla literals are ∓0x7fffffff (not INT_MIN);
 * MAXINT (core/constants) is 0x7fffffff. Entries past index 1 are NOT
 * cleared — faithful to the C static.
 */
export function clearClipSegs(viewwidth: number = DEFAULT_VIEWWIDTH): void {
  put(0, FIRST, -MAXINT);
  put(0, LAST, -1);
  put(0, DSREF, -1);
  put(1, FIRST, viewwidth);
  put(1, LAST, MAXINT);
  put(1, DSREF, -1);
  end = 2;
}

// --- R_ClipSolidWallSegment (r_bsp.c:98-186) --------------------------------

/**
 * Clip-and-insert a solid span [first, last] (inclusive, caller-ordered;
 * R_AddLine passes x1, x2-1 — r_bsp.c:355). Returns the fragment count
 * (DEVIATION 3); fragments are the exact sequence vanilla hands to
 * R_StoreWallRange, in order. Fragments of an OCCLUDED ledger
 * (MAXSEGS overflow) are still reported — DEVIATION 1.
 */
export function clipSolidWallSegment(first: number, last: number): number {
  nfrags = 0;

  // Find the first range that touches the range
  //  (adjacent pixels are touching).            — r_bsp.c:112-115
  let i = 0;
  while (at(i, LAST) < first - 1) i++;

  if (first < at(i, FIRST)) {
    if (last < at(i, FIRST) - 1) {
      // Post is entirely visible (above start),
      //  so insert a new clippost.               — r_bsp.c:117-135
      storeWallRange(first, last); // r_bsp.c:123
      if (end >= MAXSEGS) {
        // DEVIATION 1: vanilla does `next = newend; newend++` here
        // (r_bsp.c:124-125) with no bounds test — out-of-bounds static
        // corruption. We keep the fragment report and drop the insert.
        counters.hom++;
        counters.solidsegDrops++;
        return nfrags;
      }
      let n = end; // next = newend
      end++; //      newend++
      while (n !== i) {
        copyEntry(n - 1, n); // *next = *(next-1)   — r_bsp.c:127-131
        n--;
      }
      put(i, FIRST, first); // next->first/last = first/last — r_bsp.c:132-134
      put(i, LAST, last);
      put(i, DSREF, -1); // new span: drawseg attached later by M3-06
      return nfrags;
    }

    // There is a fragment above *start.          — r_bsp.c:137-140
    storeWallRange(first, at(i, FIRST) - 1); // r_bsp.c:138
    put(i, FIRST, first); // adjust the clip size — r_bsp.c:140
  }

  // Bottom contained in start?                   — r_bsp.c:143-146
  // (The fully-covered no-op R_CheckBBox's fast path leans on.)
  if (last <= at(i, LAST)) return nfrags;

  let j = i; // next = start                      — r_bsp.c:147
  let crunched = false;
  while (last >= at(j + 1, FIRST) - 1) {
    // There is a fragment between two posts.     — r_bsp.c:148-151
    storeWallRange(at(j, LAST) + 1, at(j + 1, FIRST) - 1); // r_bsp.c:151
    j++;
    if (last <= at(j, LAST)) {
      // Bottom is contained in next.             — r_bsp.c:154-159
      put(i, LAST, at(j, LAST)); // r_bsp.c:158
      crunched = true;
      break; // goto crunch
    }
  }
  if (!crunched) {
    // There is a fragment after *next.           — r_bsp.c:163-166
    storeWallRange(at(j, LAST) + 1, last); // r_bsp.c:164
    put(i, LAST, last); // r_bsp.c:166
  }

  // Remove start+1 to next from the clip list,
  //  because start now covers their area.        — r_bsp.c:170
  if (j === i) return nfrags; // r_bsp.c:171-175

  let d = i;
  let s = j;
  while (s !== end) {
    // Literal `while (next++ != newend) *++start = *next;` (r_bsp.c:178-181):
    // the compare consumes s==end-1, then the body reads *end — vanilla's
    // one-past-the-end copy. Our typed array yields 0/last-residue there,
    // unobservable by any walk (see header note).
    s++;
    d++;
    copyEntry(s, d); // *++start = *next
  }
  end = d + 1; // newend = start+1                — r_bsp.c:184

  return nfrags;
}

// --- R_ClipPassWallSegment (r_bsp.c:197-238) --------------------------------

/**
 * Clip a see-through (window/pass) span: identical fragment reporting,
 * NO insertion and NO list mutation (r_bsp.c:197-238 assigns nothing).
 */
export function clipPassWallSegment(first: number, last: number): number {
  nfrags = 0;

  // Find the first range that touches the range
  //  (adjacent pixels are touching).             — r_bsp.c:204-207
  let i = 0;
  while (at(i, LAST) < first - 1) i++;

  if (first < at(i, FIRST)) {
    if (last < at(i, FIRST) - 1) {
      // Post is entirely visible (above start).  — r_bsp.c:210-216
      storeWallRange(first, last); // r_bsp.c:214
      return nfrags;
    }

    // There is a fragment above *start.          — r_bsp.c:218-219
    storeWallRange(first, at(i, FIRST) - 1); // r_bsp.c:219
  }

  // Bottom contained in start?                   — r_bsp.c:222-224
  if (last <= at(i, LAST)) return nfrags;

  while (last >= at(i + 1, FIRST) - 1) {
    // There is a fragment between two posts.     — r_bsp.c:226-234
    storeWallRange(at(i, LAST) + 1, at(i + 1, FIRST) - 1); // r_bsp.c:229
    i++;
    if (last <= at(i, LAST)) return nfrags; // r_bsp.c:232-233
  }

  // There is a fragment after *next.             — r_bsp.c:236-237
  storeWallRange(at(i, LAST) + 1, last); // r_bsp.c:237

  return nfrags;
}

// --- fragment output (the R_StoreWallRange stream, M3-06 consumes) ----------

/** Fragments reported by the last clip call. */
export function fragCount(): number {
  return nfrags;
}

/** inclusive fragment start (== R_StoreWallRange `start` arg) */
export function fragStart(i: number): number {
  return frags[i * 2] ?? 0;
}

/** inclusive fragment stop (== R_StoreWallRange `stop` arg) */
export function fragStop(i: number): number {
  return frags[i * 2 + 1] ?? 0;
}

// --- ledger inspection (M3-04 R_CheckBBox + M3-06 + tests) ------------------

/** Valid entry count (newend − solidsegs). */
export function solidsegsLength(): number {
  return end;
}

export function solidsegsFirst(i: number): number {
  return at(i, FIRST);
}

export function solidsegsLast(i: number): number {
  return at(i, LAST);
}

/** Drawseg ref slot (ARCHITECTURE §4.2; -1 = unattached; maintained by M3-06). */
export function solidsegsDrawseg(i: number): number {
  return at(i, DSREF);
}

export function setSolidsegsDrawseg(i: number, ref: number): void {
  put(i, DSREF, ref);
}

// --- counters (M3-plan §M3-03; debug.ts state().render.hom) ------------------

/** Live counter snapshot (copy). */
export function getRenderCounters(): RenderCounters {
  return { ...counters };
}

/** Zero all counters (per-frame reset in M3-07 renderFrame). */
export function resetRenderCounters(): void {
  counters.hom = 0;
  counters.drawsegOverflow = 0;
  counters.solidsegDrops = 0;
  counters.visplaneOverflow = 0;
  counters.openingOverflow = 0;
}

/**
 * MAXDRAWSEGS 256 silent return (r_segs.c:385-387, r_defs.h:55) — called by
 * M3-06's storeWallRange. Counted separately from hom so hom means
 * occlusion-loss specifically (M3-plan §M3-03).
 */
export function noteDrawsegOverflow(): void {
  counters.drawsegOverflow++;
}

/** MAXVISPLANES 128 (vanilla I_Error, r_plane.c R_FindPlane) — planes.ts
 * bumps this live counter and throws a typed error (M4-01 deviation). */
export function noteVisplaneOverflow(): void {
  counters.visplaneOverflow++;
}

/** Openings-pool exhaustion (drawsegs.ts allocOpenings; vanilla: silent
 * corruption of the static `openings` array) — M4-01 route into the same
 * counters API; drawsegs.openingsOverflowCount stays as the legacy alias. */
export function noteOpeningOverflow(): void {
  counters.openingOverflow++;
}

/**
 * Guard for a store range with start > stop — the r_segs.c:389-392
 * "Bad R_RenderWallRange" I_Error case (RANGECHECK-gated in vanilla).
 * hom++ (DEVIATION 2) and return false so the caller skips the store;
 * true = range ok.
 */
export function noteBadStoreRange(start: number, stop: number): boolean {
  if (start > stop) {
    counters.hom++;
    return false;
  }
  return true;
}
