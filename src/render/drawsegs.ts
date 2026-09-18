// render/drawsegs.ts — drawseg ledger + openings pool + masked-pass stubs
// (M3-plan §M3-06; r_segs.c R_StoreWallRange state + r_defs.h drawseg_s,
// r_bsp.c R_ClearDrawSegs).
//
// Zone discipline (eslint doom/zones/render): imports core + render only.
//
// Vanilla mapping (linuxdoom-1.10 sources; r_segs.c v1.3):
//   drawseg_t (r_defs.h:322-347)      → SoA arrays below (ARCHITECTURE §4.2),
//     MAXDRAWSEGS 256 (r_defs.h:55) with the `if (ds_p == &drawsegs[MAXDRAWSEGS])
//     return;` silent overflow (r_segs.c:385-387) → solidsegs.noteDrawsegOverflow
//     (M3-03 counter; acceptance 5).
//   openings pool (r_plane.c `#define MAXOPENINGS SCREENWIDTH*64` — pinned by
//     docs/research/03-bsp-renderer.md §"constants" = 320*64 = 20480 shorts)
//     + `lastopening`. Vanilla has NO bounds check on the memcpy/alloc sites
//     (r_segs.c:533-535, :718-733) — a silent-memory-corruption class bug we
//     cannot replicate safely: allocOpenings() returns −1 on overflow, the
//     caller skips the snapshot and `openingsOverflows` counts it
//     (documented deviation; vanilla never reaches it on shipped maps —
//     256 drawsegs × 320 px worst case exceeds 20480, but vanilla's MAXSEGS=32
//     occlusion ledger bounds real stores far below that).
//   sprtopclip/sprbottomclip/maskedtexturecol ("adjusted so [x1] is first
//     value", r_defs.h:343-346)  →  Int32 refs: absolute index into the
//     openings pool such that ref[x] = openings[refBase + x] exactly like the
//     C `lastopening - start` pointer. The two static arrays vanilla assigns
//     instead of pool pointers — screenheightarray (all viewheight) and
//     negonearray (all −1) — get the sentinel codes CLIP_SCREEN/CLIP_NEGONE
//     (DEVIATION, representation only: vanilla stores real pointers; value
//     semantics identical). NULL = CLIP_NULL.
//   screenheightarray/negonearray: defined next to the openings pool; vanilla
//     fills screenheightarray[i]=viewheight in R_ExecuteSetViewSize
//     (r_main.c:727); negonearray is −1-filled at init (never in the frame
//     path). Filled once here + re-filled by clearClipArrays().
//   ceilingclip/floorclip (r_main.c/r_segs.c globals): reset EVERY frame by
//     R_ClearPlanes (r_plane.c; docs/research/03 §frame flow: "floorclip[i] =
//     viewheight; ceilingclip[i] = −1" — note the names: ceilingclip is the
//     BOTTOM edge of the already-claimed upper region and floorclip the TOP
//     edge of the lower one, so the OPEN initial state is ceilingclip=−1,
//     floorclip=viewheight; the fully-solid state R_RenderSegLoop writes for
//     one-sided segs is the inverted pair ceilingclip=viewheight,
//     floorclip=−1 — r_segs.c:288-289). M3 skips R_ClearPlanes (no visplanes,
//     plan §3 deviation D), so {@link clearClipArrays} exposes exactly that
//     per-frame reset for M3-07's renderFrame.
//
// M3-06a REVIEW VERDICT (segs.ts port consumed this draft; r_segs.c audit):
//  - drawseg SoA fields ↔ r_defs.h drawseg_s: complete, no gaps. The
//    drawsegAdd bsil/tsil pre-set (MININT/MAXINT) differs from vanilla's
//    zeroed-static reuse, but every path that SETS a silhouette bit also
//    sets its height (:466-524, :476-481), and heights are only consulted
//    under that bit (M4 sprite pass) — unobservable, kept.
//  - openings/lastopening/snapshotOpenings match the `lastopening - start`
//    pointer arithmetic + memcpy(2*(rw_stopx-start)) widths exactly as used
//    by storeWallRange; maskedtexturecol MAXSHORT-init stands in for
//    vanilla's never-read garbage (header Deviations) — faithful.
//  - clearClipArrays/clearDrawsegs per-frame reset verified end-to-end by
//    segs.ts (occlusion + silhouettes + full-screen draw in the smoke).
//  - No fixes required; draft integrated unchanged.
//
// Masked middle (plan §M3-06): allocation + per-column texturecolumn
// recording live in segs.ts; the DRAW half is deferred:
//   R_RenderMaskedSegRange / R_DrawMasked (r_segs.c:96-176, :741+) — M4
//     consumes the recorded snapshot. {@link drawMasked} and
//     {@link drawMaskedSegRange} are named NO-OP stubs (plan: "drawMasked()
//     no-op stub, M4 consumes the snapshot ... drawMaskedSegRange stub noted").
//
// Deviations:
//  - maskedtexturecol region is MAXSHORT-initialized at allocation. Vanilla
//    never memsets openings (the RANGECHECK builds never observably consult a
//    non-written column; the consumption pass R_RenderMaskedSegRange sets
//    MAXSHORT after drawing). Deterministic + matching the != MAXSHORT
//    sentinel semantics (plan §M3-06 wording); documented deviation.
//  - ds_p is an index; `ds_p++` = {@link drawsegAdd}.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { MAXINT } from '../core/constants';
import { RENDER_WIDTH } from './framebuffer';
import { noteDrawsegOverflow, noteOpeningOverflow } from './solidsegs';

/* ------------------------------------------------------------------ */
/* Constants (r_defs.h / r_plane.c / r_segs.c)                         */
/* ------------------------------------------------------------------ */

/** r_defs.h:55 — MAXDRAWSEGS 256. */
export const MAXDRAWSEGS = 256;

/** r_defs.h:50-53 — silhouette codes. */
export const SIL_NONE = 0;
export const SIL_BOTTOM = 1;
export const SIL_TOP = 2;
export const SIL_BOTH = 3;

/** r_plane.c `#define MAXOPENINGS SCREENWIDTH*64` (research doc §constants). */
export const MAXOPENINGS = RENDER_WIDTH * 64;

/** C MAXSHORT (r_segs.c maskedtexturecol sentinel; RANGECHECK.h/limits). */
export const MAXSHORT = 0x7fff;

/** Sprite-clip ref representation (see file header). */
export const CLIP_NULL = -1;
export const CLIP_SCREEN = -2; // screenheightarray (all viewheight)
export const CLIP_NEGONE = -3; // negonearray (all −1)
//   >= 0 (or any value outside the sentinel set): SIGNED openings-pool ref
//     (ref[x] = openings[refBase + x]; FIX-M3-06c — vanilla pointer math
//     `lastopening - start` is legitimately NEGATIVE whenever the pool base
//     sits below the start column; only allocation failure skips the store,
//     sign never does. Edge collision kept: a true ref of exactly −1..−3 is
//     read as the matching sentinel — astronomically rare (needs base within
//     3 shorts below start) and unreachable on shipped maps; sentinel set
//     unchanged per clipValue contract.)

/* ------------------------------------------------------------------ */
/* drawseg SoA (ARCHITECTURE §4.2)                                     */
/* ------------------------------------------------------------------ */

export interface DrawsegSoA {
  readonly count: number;
  /** ds_p — drawsegs written this frame (index one past the last). */
  readonly x1: Int32Array;
  readonly x2: Int32Array;
  /** seg_t index (curline) the drawseg records. */
  readonly seg: Int32Array;
  readonly scale1: Int32Array;
  readonly scale2: Int32Array;
  readonly scalestep: Int32Array;
  readonly silhouette: Int32Array;
  /** fixed; MAXINT/MININT sentinels per r_segs.c:476-524. */
  readonly bsilheight: Int32Array;
  readonly tsilheight: Int32Array;
  /** signed openings ref (may be < 0; header), CLIP_NULL = none. */
  readonly sprtopclip: Int32Array;
  readonly sprbottomclip: Int32Array;
  /** signed openings base for maskedtexturecol (may be < 0), CLIP_NULL = none. */
  readonly maskedcol: Int32Array;
}

let count = 0;

const x1 = new Int32Array(MAXDRAWSEGS);
const x2 = new Int32Array(MAXDRAWSEGS);
const seg = new Int32Array(MAXDRAWSEGS);
const scale1 = new Int32Array(MAXDRAWSEGS);
const scale2 = new Int32Array(MAXDRAWSEGS);
const scalestep = new Int32Array(MAXDRAWSEGS);
const silhouette = new Int32Array(MAXDRAWSEGS);
const bsilheight = new Int32Array(MAXDRAWSEGS);
const tsilheight = new Int32Array(MAXDRAWSEGS);
const sprtopclip = new Int32Array(MAXDRAWSEGS);
const sprbottomclip = new Int32Array(MAXDRAWSEGS);
const maskedcol = new Int32Array(MAXDRAWSEGS).fill(CLIP_NULL);

let openingsOverflows = 0;

/* ------------------------------------------------------------------ */
/* Openings pool + static clip arrays (r_plane.c / r_main.c globals)   */
/* ------------------------------------------------------------------ */

/** `short openings[MAXOPENINGS]` — Int16 = C short (2's complement, matches
 * memcpy of the short-typed ceiling/floor clip arrays). */
const openings = new Int16Array(MAXOPENINGS);

/** r_main.c global `short screenheightarray[SCREENWIDTH]` (all viewheight). */
export const screenheightarray = new Int16Array(RENDER_WIDTH);

/** `short negonearray[SCREENWIDTH]` (all −1). */
export const negonearray = new Int16Array(RENDER_WIDTH).fill(-1);

/** r_segs.c `int lastopening` — pool water mark (absolute index). */
let lastopening = 0;

/** r_segs.c per-column clip globals (short [SCREENWIDTH]). */
export const ceilingclip = new Int16Array(RENDER_WIDTH);
export const floorclip = new Int16Array(RENDER_WIDTH);

/**
 * R_ClearDrawSegs (r_bsp.c:68-71) + the openings-pool water-mark reset
 * (vanilla resets lastopening with the plane/sprite state at init; M3
 * resets it per frame — same steady state, deterministic; see header).
 */
export function clearDrawsegs(): void {
  count = 0;
  lastopening = 0;
  openingsOverflows = 0;
}

/**
 * The clip-array half of R_ClearPlanes (r_plane.c) — M3 skips visplanes but
 * MUST still seed the column clips (file header semantics): open state
 * ceilingclip = −1, floorclip = viewheight. Also (re)seeds the two static
 * thing-clip arrays (r_main.c:727 `screenheightarray[i] = viewheight`).
 */
export function clearClipArrays(viewheight: number): void {
  ceilingclip.fill(-1);
  floorclip.fill(viewheight);
  screenheightarray.fill(viewheight);
  negonearray.fill(-1);
}

/** Allocate `n` shorts from the pool. −1 + counter bump on overflow
 * (vanilla: silent corruption; us: skip + count — see header). */
export function allocOpenings(n: number): number {
  if (lastopening + n > MAXOPENINGS) {
    openingsOverflows++;
    noteOpeningOverflow(); // M4-01: same event via the getRenderCounters API
    return -1;
  }
  const base = lastopening;
  lastopening += n;
  return base;
}

/** Raw pool access (segs.ts + tests). */
export function openingsAt(i: number): number {
  return openings[i] ?? 0;
}

export function openingsSet(i: number, v: number): void {
  openings[i] = v;
}

/** memcpy(lastopening, src+start, 2*n) + advance; returns the SIGNED ref
 * `base - start` (vanilla `lastopening - start` pointer difference — may be
 * negative; FIX-M3-06c), or null on overflow (vanilla: silent corruption). */
export function snapshotOpenings(src: Int16Array, start: number, n: number): number | null {
  const base = allocOpenings(n);
  if (base < 0) return null;
  for (let i = 0; i < n; i++) openings[base + i] = src[start + i] ?? 0;
  return base - start;
}

/** Resolve a sprite clip ref at column x to its short value. */
export function clipValue(ref: number, x: number, viewheight: number): number {
  if (ref === CLIP_SCREEN) return viewheight;
  if (ref === CLIP_NEGONE) return -1;
  if (ref === CLIP_NULL) return 0; // vanilla: NULL deref — never consulted
  return openings[ref + x] ?? 0;
}

/* ------------------------------------------------------------------ */
/* ds_p management                                                     */
/* ------------------------------------------------------------------ */

/**
 * Allocate the next drawseg (`ds_p++`, r_segs.c:743) with the MAXDRAWSEGS
 * silent-return guard (r_segs.c:385-387 → noteDrawsegOverflow, acceptance 5).
 * Returns the index, or −1 when full — caller returns without storing.
 */
export function drawsegAdd(segIdx: number): number {
  if (count >= MAXDRAWSEGS) {
    noteDrawsegOverflow();
    return -1;
  }
  const i = count;
  seg[i] = segIdx;
  x1[i] = 0;
  x2[i] = 0;
  scale1[i] = 0;
  scale2[i] = 0;
  scalestep[i] = 0;
  silhouette[i] = SIL_NONE;
  bsilheight[i] = MININT_SENTINEL;
  tsilheight[i] = MAXINT_SENTINEL;
  sprtopclip[i] = CLIP_NULL;
  sprbottomclip[i] = CLIP_NULL;
  maskedcol[i] = CLIP_NULL;
  count++;
  return i;
}

// r_segs.c ds_p->bsilheight/tsilheight sentinels (C MAXINT/MININT).
export const MAXINT_SENTINEL = MAXINT;
export const MININT_SENTINEL = -MAXINT - 1;

/* ------------------------------------------------------------------ */
/* Inspection (tests + M4 sprite pass)                                 */
/* ------------------------------------------------------------------ */

export function drawsegCount(): number {
  return count;
}

export function getDrawsegs(): DrawsegSoA {
  return {
    count,
    x1,
    x2,
    seg,
    scale1,
    scale2,
    scalestep,
    silhouette,
    bsilheight,
    tsilheight,
    sprtopclip,
    sprbottomclip,
    maskedcol,
  };
}

/** maskedtexturecol[x] for drawseg `i` (MAXSHORT = never written). */
export function maskedTexturecol(i: number, x: number): number {
  const base = maskedcol[i];
  if (base === undefined || base === CLIP_NULL) return MAXSHORT;
  return openings[base + x] ?? MAXSHORT;
}

/** Pool water mark (tests). */
export function openingsUsed(): number {
  return lastopening;
}

/** Overflow counter (see allocOpenings deviation). */
export function openingsOverflowCount(): number {
  return openingsOverflows;
}

/* ------------------------------------------------------------------ */
/* Masked pass — IMPLEMENTED IN masked.ts (M4-04)                       */
/* ------------------------------------------------------------------ */

// M3 shipped drawMasked/drawMaskedSegRange as named NO-OP stubs here.
// M4-04 implemented them in masked.ts (the plan's owner of
// R_RenderMaskedSegRange; the driver R_DrawMasked actually lives in
// r_things.c:958, not r_segs.c as this header guessed — the reverse
// drawseg sweep is faithful there). Consumers import from './masked'.
// The openings pool primitives above (openingsAt/openingsSet/clipValue +
// the drawseg SoA) are exactly what that module consumes.
