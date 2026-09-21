// ui/stlib.ts — the statusbar WIDGET LIBRARY, st_lib.c mirrored 1:1
// (M9-05, docs/design/M9-plan.md §M9-05 + §0.8). Owns: st_number_t /
// st_percent_t / st_multicon_t / st_binicon_t and the ten STlib_* routines
// (st_lib.c:49-293). Consumers: ui/statusbar.ts (the widget table).
//
// Faithfulness map (linuxdoom-1.10 st_lib.c, line refs verified against
// /tmp/DOOM-master/linuxdoom-1.10 this session):
//   STlib_init        :49-52  sttminus = W_CacheLumpName("STTMINUS").
//   STlib_initNum     :57-70  x/y/oldnum=0/width/num/on/p.
//   STlib_drawNum     :77-146 right-justified from (x,y): clears
//                           `width` digit boxes BG→FG FIRST (so a 1994
//                           "n/a" erases), width-specific negative clamps
//                           (2 digits ⇒ floor -9, 3 ⇒ -99), `if (!num)`
//                           draws a single '0' at x-w, then the LSB-first
//                           digit loop, then the minus at x-8 (NOT x-w).
//   STlib_updateNum   :152-156 `if (*on) drawNum(...)`.
//   STlib_initPercent :161-174 initNum(width=3) + the % patch.
//   STlib_updatePercent:179-187 the % patch is drawn ONLY on refresh
//                           (the digits clear BG *over* it otherwise).
//   STlib_initMultIcon:192-203 oldinum = -1 ("nothing drawn yet").
//   STlib_updateMultIcon:208-234 draws p[*inum] when the index changes or
//                           on refresh, NEVER for inum == -1, erasing the
//                           OLD icon's anchored box via V_CopyRect(BG→FG)
//                           — the erase uses oldinum's patch geometry.
//   STlib_initBinIcon :239-251 oldval = 0.
//   STlib_updateBinIcon:256-292 on a value flip (or refresh): draw if
//                           true, else BG→FG-erase the anchored box.
//
// C→TS mappings (documented deviations, none behavioural):
//   * `int* num` / `boolean* on` / `int* inum` / `boolean* val` pointers →
//     ACCESSOR CLOSURES (`() => number` / `() => boolean`). The sim objects
//     are live (single-player objects shared by reference), so a closure is
//     the same read-the-latest-value semantics; statusbar.ts also re-points
//     `w_ready.num` per tic exactly where the C assigns `w_ready.num =
//     &largeammo` (st_stuff.c:928-932).
//   * `SHORT(patch->width)` → `patch.width` (decoded once by
//     render/vvideo's VPatch, same byte order).
//   * `I_Error("…y - ST_Y < 0")` → a thrown StLibError (vanilla aborts the
//     process; the TS port's error channel is exceptions). Unreachable for
//     the statusbar widget table (every y ≥ ST_Y); the guards are transcribed
//     because a coordinate typo MUST fail loudly, silently drawing into the
//     BG canvas at a wrapped offset would be far worse.
//   * `boolean* val` → `() => boolean`; `oldval` keeps C's int 0 init but
//     compares with `!==` (C `!=` on 0/1 booleans is identical).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  BG,
  FG,
  SCREENHEIGHT,
  ST_HEIGHT,
  lumpPatch,
  vCopyRect,
  vDrawPatch,
  type VPatch,
} from '../render/vvideo';
import type { WadFile } from '../wad/wadfile';

/* ------------------------------------------------------------------ */
/* Geometry (st_stuff.h:32-34, re-exported for the widget table)        */
/* ------------------------------------------------------------------ */

/** ST_Y = SCREENHEIGHT - ST_HEIGHT = 168 (st_stuff.h:34). Widgets draw at
 * full-screen y; the BG canvas holds the same rows at y - ST_Y. */
export const ST_Y = SCREENHEIGHT - ST_HEIGHT;

/* ------------------------------------------------------------------ */
/* Widget structs (st_lib.h:45-135)                                     */
/* ------------------------------------------------------------------ */

/** st_number_t (st_lib.h:45-74). Upper-right corner of a right-justified
 * number at (x,y), `width` digits max. */
export interface StNumber {
  x: number;
  y: number;
  /** max # of digits (vanilla comment: "max # of digits in number"). */
  width: number;
  /** last number value — written every draw, NEVER read (vanilla keeps the
   * field; diff-drawing is by BG-erase + redraw, not by oldnum). */
  oldnum: number;
  /** `int* num` — the live value. Re-pointed by ST_updateWidgets for the
   * ready-ammo widget (1994 "n/a" vs the ammo slot). */
  num: () => number;
  /** `boolean* on` — the widget-enable flag (st_statusbaron & friends). */
  on: () => boolean;
  /** `patch_t** p` — the digit glyphs, index 0..9. */
  p: readonly (VPatch | null)[];
  /** user data (`int data`) — statusbar stores readyweapon in w_ready. */
  data: number;
}

/** st_percent_t (st_lib.h:77-84): a number widget + the '%' glyph. */
export interface StPercent {
  n: StNumber;
  p: VPatch | null;
}

/** st_multicon_t (st_lib.h:87-110): one icon out of a table, index live. */
export interface StMultIcon {
  x: number;
  y: number;
  /** last icon number; -1 = nothing on screen yet (init value). */
  oldinum: number;
  /** `int* inum` — live index; -1 means "draw nothing". */
  inum: () => number;
  on: () => boolean;
  p: readonly (VPatch | null)[];
  data: number;
}

/** st_binicon_t (st_lib.h:113-135): show/hide one icon by a boolean. */
export interface StBinIcon {
  x: number;
  y: number;
  /** last icon value (C `int oldval`, init 0). */
  oldval: number;
  /** `boolean* val`. */
  val: () => boolean;
  on: () => boolean;
  p: VPatch | null;
  data: number;
}

/** Vanilla I_Error on a widget rect that escapes the statusbar band. */
export class StLibError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StLibError';
  }
}

/* ------------------------------------------------------------------ */
/* STlib_init — the STTMINUS lump (st_lib.c:44-52)                      */
/* ------------------------------------------------------------------ */

/** `static patch_t* sttminus` (st_lib.c:44): the minus glyph, cached by
 * STlib_init (called from ST_initData, st_stuff.c:1300). */
let sttminus: VPatch | null = null;

/** STlib_init (st_lib.c:49-52): load + store STTMINUS. */
export function stLibInit(wad: WadFile): void {
  sttminus = lumpPatch(wad, 'STTMINUS');
}

/** Test/inspection accessor for the cached minus glyph. */
export function stLibTtminus(): VPatch | null {
  return sttminus;
}

/* ------------------------------------------------------------------ */
/* Number widget (st_lib.c:57-156)                                     */
/* ------------------------------------------------------------------ */

/** STlib_initNum (st_lib.c:57-70). */
export function stLibInitNum(
  n: StNumber,
  x: number,
  y: number,
  pl: readonly (VPatch | null)[],
  num: () => number,
  on: () => boolean,
  width: number,
): void {
  n.x = x;
  n.y = y;
  n.oldnum = 0;
  n.width = width;
  n.num = num;
  n.on = on;
  n.p = pl;
  n.data = 0; // C leaves it uninitialised; zero keeps the struct deterministic.
}

/** STlib_drawNum (st_lib.c:77-146). The `refresh` argument is part of the
 * vanilla signature but the body never reads it (the widget always BG-erases
 * and redraws) — kept for call-site parity. */
export function stLibDrawNum(n: StNumber, refresh: boolean): void {
  void refresh;
  let numdigits = n.width;
  let num = n.num();

  const w = n.p[0]!.width; // SHORT(n->p[0]->width)
  const h = n.p[0]!.height;
  let x = n.x;

  n.oldnum = n.num();

  const neg = num < 0 ? 1 : 0;

  if (neg) {
    if (numdigits === 2 && num < -9) num = -9;
    else if (numdigits === 3 && num < -99) num = -99;

    num = -num;
  }

  // clear the area
  x = n.x - numdigits * w;

  if (n.y - ST_Y < 0) throw new StLibError('drawNum: n->y - ST_Y < 0');

  vCopyRect(x, n.y - ST_Y, BG, w * numdigits, h, x, n.y, FG);

  // if non-number, do not draw it
  if (num === 1994) return;

  x = n.x;

  // in the special case of 0, you draw 0
  if (!num) vDrawPatch(x - w, n.y, FG, n.p[0]!);

  // draw the new number
  while (num && numdigits-- > 0) {
    x -= w;
    vDrawPatch(x, n.y, FG, n.p[num % 10]!);
    num = Math.floor(num / 10);
  }

  // draw a minus sign if necessary
  if (neg) {
    if (sttminus === null) {
      throw new StLibError('drawNum: STTMINUS not loaded (call stLibInit)');
    }
    vDrawPatch(x - 8, n.y, FG, sttminus);
  }
}

/** STlib_updateNum (st_lib.c:152-156). */
export function stLibUpdateNum(n: StNumber, refresh: boolean): void {
  if (n.on()) stLibDrawNum(n, refresh);
}

/* ------------------------------------------------------------------ */
/* Percent widget (st_lib.c:161-187)                                   */
/* ------------------------------------------------------------------ */

/** STlib_initPercent (st_lib.c:161-174): the number is always 3 wide. */
export function stLibInitPercent(
  p: StPercent,
  x: number,
  y: number,
  pl: readonly (VPatch | null)[],
  num: () => number,
  on: () => boolean,
  percent: VPatch | null,
): void {
  stLibInitNum(p.n, x, y, pl, num, on, 3);
  p.p = percent;
}

/** STlib_updatePercent (st_lib.c:179-187): the '%' glyph only on refresh —
 * the digit pass BG-erases its own box, which would wipe the sign. */
export function stLibUpdatePercent(per: StPercent, refresh: boolean): void {
  if (refresh && per.n.on() && per.p !== null) vDrawPatch(per.n.x, per.n.y, FG, per.p);

  stLibUpdateNum(per.n, refresh);
}

/* ------------------------------------------------------------------ */
/* Multiple-icon widget (st_lib.c:192-234)                             */
/* ------------------------------------------------------------------ */

/** STlib_initMultIcon (st_lib.c:192-203). */
export function stLibInitMultIcon(
  i: StMultIcon,
  x: number,
  y: number,
  il: readonly (VPatch | null)[],
  inum: () => number,
  on: () => boolean,
): void {
  i.x = x;
  i.y = y;
  i.oldinum = -1;
  i.inum = inum;
  i.on = on;
  i.p = il;
  i.data = 0;
}

/** STlib_updateMultIcon (st_lib.c:208-234). */
export function stLibUpdateMultIcon(mi: StMultIcon, refresh: boolean): void {
  if (mi.on() && (mi.oldinum !== mi.inum() || refresh) && mi.inum() !== -1) {
    if (mi.oldinum !== -1) {
      const old = mi.p[mi.oldinum];
      if (old === null || old === undefined) {
        throw new StLibError(`updateMultIcon: no patch for oldinum ${mi.oldinum}`);
      }
      const x = mi.x - old.leftOffset;
      const y = mi.y - old.topOffset;

      if (y - ST_Y < 0) throw new StLibError('updateMultIcon: y - ST_Y < 0');

      vCopyRect(x, y - ST_Y, BG, old.width, old.height, x, y, FG);
    }
    const cur = mi.p[mi.inum()];
    if (cur === null || cur === undefined) {
      throw new StLibError(`updateMultIcon: no patch for inum ${mi.inum()}`);
    }
    vDrawPatch(mi.x, mi.y, FG, cur);
    mi.oldinum = mi.inum();
  }
}

/* ------------------------------------------------------------------ */
/* Binary-icon widget (st_lib.c:239-292)                               */
/* ------------------------------------------------------------------ */

/** STlib_initBinIcon (st_lib.c:239-251). */
export function stLibInitBinIcon(
  b: StBinIcon,
  x: number,
  y: number,
  i: VPatch | null,
  val: () => boolean,
  on: () => boolean,
): void {
  b.x = x;
  b.y = y;
  b.oldval = 0;
  b.val = val;
  b.on = on;
  b.p = i;
  b.data = 0;
}

/** STlib_updateBinIcon (st_lib.c:256-292). */
export function stLibUpdateBinIcon(bi: StBinIcon, refresh: boolean): void {
  const v = bi.val();
  if (bi.on() && (bi.oldval !== (v ? 1 : 0) || refresh)) {
    if (bi.p === null) throw new StLibError('updateBinIcon: no icon patch');
    const x = bi.x - bi.p.leftOffset;
    const y = bi.y - bi.p.topOffset;

    if (y - ST_Y < 0) throw new StLibError('updateBinIcon: y - ST_Y < 0');

    if (v) vDrawPatch(bi.x, bi.y, FG, bi.p);
    else vCopyRect(x, y - ST_Y, BG, bi.p.width, bi.p.height, x, y, FG);

    bi.oldval = v ? 1 : 0;
  }
}

/** Fresh, empty number widget (the C structs are statics; TS allocates). */
export function stNumber(): StNumber {
  return { x: 0, y: 0, width: 0, oldnum: 0, num: () => 0, on: () => false, p: [], data: 0 };
}

/** Fresh percent widget wrapping a fresh number widget. */
export function stPercent(): StPercent {
  return { n: stNumber(), p: null };
}

/** Fresh multicon widget. */
export function stMultIcon(): StMultIcon {
  return { x: 0, y: 0, oldinum: -1, inum: () => -1, on: () => false, p: [], data: 0 };
}

/** Fresh binicon widget. */
export function stBinIcon(): StBinIcon {
  return { x: 0, y: 0, oldval: 0, val: () => false, on: () => false, p: null, data: 0 };
}
