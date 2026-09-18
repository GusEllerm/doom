// render/solidsegs tests (M3-03): solidsegs insert/merge vs vanilla
// r_bsp.c control flow + live HOM counters.
//
// All hand-derivations below are traced from linuxdoom-1.10 r_bsp.c as
// fetched from id-Software/DOOM (linuxdoom-1.10/r_bsp.c):
//   walk "while (start->last < first-1) start++"  r_bsp.c:113-115 (solid)
//                                                    r_bsp.c:205-207 (pass)
//   "adjacent pixels are touching" => first-1 comparison merges touching
//     ranges; strictly-gapped ranges do NOT (a 1-column gap stays open).
//   insert (entirely visible)      r_bsp.c:117-135 (R_StoreWallRange at :123
//     precedes the newend++ at :124-125 that overflows past solidsegs[32]).
//   fragment above *start          r_bsp.c:137-140
//   bottom contained => return     r_bsp.c:143-146  (fully-covered no-op)
//   fragment between two posts     r_bsp.c:147-160 (loop test `last >=
//     (next+1)->first-1` at :148, store at :151, contained-crunch :154-159)
//   fragment after *next           r_bsp.c:163-166
//   crunch removal loop            r_bsp.c:170-184 — literally
//     `while (next++ != newend) *++start = *next;`, which copies ONE entry too
//     many (reads solidsegs[newend], past the valid ledger). Consequence in
//     every crunch below: one junk entry sits inside the new [.. , newend)
//     window just after the right sentinel's moved position. No walk can ever
//     reach it (the sentinel's last == 0x7fffffff stops every scan first), so
//     assertions cover the reachable prefix and one occlusion probe each.
//   R_ClearClipSegs sentinels      r_bsp.c:245-252: (-0x7fffffff,-1) and
//     (viewwidth, 0x7fffffff), newend = solidsegs+2.
//   MAXDRAWSEGS silent return      r_segs.c:385-387 (r_defs.h:55 = 256)
//   start > stop store range       r_segs.c:389-392 (I_Error, RANGECHECK)
//
// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it } from 'vitest';

import { MAXINT } from '../core/constants';
import {
  clearClipSegs,
  clipPassWallSegment,
  clipSolidWallSegment,
  fragCount,
  fragStart,
  fragStop,
  getRenderCounters,
  MAXSEGS,
  noteBadStoreRange,
  noteDrawsegOverflow,
  resetRenderCounters,
  setSolidsegsDrawseg,
  solidsegsDrawseg,
  solidsegsFirst,
  solidsegsLast,
  solidsegsLength
} from './solidsegs';

const M = MAXINT; // 0x7fffffff — vanilla sentinel bound (r_bsp.c:247-250)
const VW = 320; // default viewwidth

/** Fragments of the last clip call as [start, stop] pairs. */
function frags(): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < fragCount(); i++) out.push([fragStart(i), fragStop(i)]);
  return out;
}

/** Raw ledger window [0, newend) — may include the unreachable junk entry. */
function spans(): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < solidsegsLength(); i++)
    out.push([solidsegsFirst(i), solidsegsLast(i)]);
  return out;
}

/** First n entries only (junk beyond the sentinel is layout, not semantics). */
function spansPrefix(n: number): [number, number][] {
  return spans().slice(0, n);
}

function solid(first: number, last: number): [number, number][] {
  clipSolidWallSegment(first, last);
  return frags();
}

function pass(first: number, last: number): [number, number][] {
  clipPassWallSegment(first, last);
  return frags();
}

beforeEach(() => {
  clearClipSegs(VW);
  resetRenderCounters();
});

describe('constants / clearClipSegs (r_bsp.c:245-252)', () => {
  it('MAXSEGS is 32 (r_bsp.c:88 — verified: defined in r_bsp.c, not r_local.h)', () => {
    expect(MAXSEGS).toBe(32);
  });

  it('sentinels are (-0x7fffffff,-1) and (viewwidth,0x7fffffff), newend=2', () => {
    // R_ClearClipSegs assigns exactly these four fields (r_bsp.c:247-250);
    // entries beyond index 1 are untouched by vanilla, so only [0..1] is
    // asserted plus the window size (solidsegsLength = newend - solidsegs).
    expect(spansPrefix(2)).toEqual([
      [-M, -1],
      [VW, M]
    ]);
    expect(solidsegsLength()).toBe(2);
  });

  it('clearClipSegs(viewwidth) parameterizes the right sentinel', () => {
    clearClipSegs(640);
    expect(spansPrefix(2)[1]).toEqual([640, M]);
    // solid(630,639): walk stops at the right sentinel (it always does for
    // spans ending at viewwidth-1 because 639 >= 640-1 fails the :114 walk
    // only via the sentinel's last == M). first 630 < 640 (:117) and
    // last 639 < 639 is FALSE (:119) — so NOT the insert path: the
    // "fragment above *start" branch stores (630, 640-1) and sets
    // start->first = 630 (r_bsp.c:137-140). The right sentinel STRETCHES;
    // the list length never grows for viewwidth-trailing spans.
    expect(solid(630, 639)).toEqual([[630, 639]]);
    expect(solidsegsLength()).toBe(2);
    expect(spansPrefix(2)[1]).toEqual([630, M]);
  });
});

describe('sequence A — insert, fully-covered no-op, left-sentinel stretch, between-posts merge', () => {
  it('traces r_bsp.c:113-184 step by step', () => {
    // A1. First interior span -> INSERT path (r_bsp.c:117-135): walk stops
    // at the right sentinel (-1 < 49 advances past the left sentinel,
    // :113-115); 50 < 320 (:117) and 60 < 319 (:119) -> store(50,60) (:123),
    // shift [start,newend) up, write (50,60) at index 1.
    expect(solid(50, 60)).toEqual([[50, 60]]);
    expect(spansPrefix(3)).toEqual([
      [-M, -1],
      [50, 60],
      [VW, M]
    ]);

    // A2. Identical span -> "Bottom contained in start?" return
    // (r_bsp.c:143-146): walk stops at (50,60) (60 < 49 false), first < 50
    // false (:117), last <= last -> return. Zero fragments, ZERO mutation —
    // the fully-covered no-op R_CheckBBox's early-out leans on (:475-483).
    expect(solid(50, 60)).toEqual([]);
    expect(solid(52, 58)).toEqual([]); // contained anywhere = also :143-146
    expect(spansPrefix(3)).toEqual([
      [-M, -1],
      [50, 60],
      [VW, M]
    ]);

    // A3. Span touching column 0 -> the walk stops at the LEFT sentinel
    // (-1 < 0-1 is FALSE — "adjacent pixels are touching", :113-115).
    // 0 < -0x7fffffff false (:117); 9 <= -1 false (:143); between-posts
    // test 9 >= 50-1 false (:148) -> "fragment after *next" stores
    // (left.last+1, last) = (0, 9) and the left sentinel EXTENDS to
    // last = 9 (r_bsp.c:163-166). No new entry.
    expect(solid(0, 9)).toEqual([[0, 9]]);
    expect(spansPrefix(3)).toEqual([
      [-M, 9],
      [50, 60],
      [VW, M]
    ]);

    // A4. Span (10,49) exactly touching (50,60): walk stops at the extended
    // left sentinel (9 < 9 false — adjacency, :113-115). Between-posts loop:
    // 49 >= 50-1 TRUE (:148) -> store(left.last+1, next.first-1) = (10,49)
    // (:151); next++ -> 49 <= 60 -> left.last = 60 (:158), goto crunch
    // (:159). Crunch removes the swallowed (50,60) post (r_bsp.c:178-181,
    // the literal one-too-many copy): window still size 3, sentinel now at
    // index 1, junk at index 2 (unreachable — probe below).
    expect(solid(10, 49)).toEqual([[10, 49]]);
    expect(spansPrefix(2)).toEqual([
      [-M, 60],
      [VW, M]
    ]);
    expect(solidsegsLength()).toBe(3); // the junk-entry artifact of :178-181
    // Reachability probe: anything ending inside the merged range is fully
    // clipped (walk stops at index 0, :143-146 return).
    expect(solid(30, 55)).toEqual([]);
    expect(getRenderCounters().hom).toBe(0);
  });
});

describe('sequence B — fragment between two posts, touching merge, contained probe', () => {
  it('fills a 1-column-touching gap in one fragment (r_bsp.c:147-160)', () => {
    expect(solid(20, 29)).toEqual([[20, 29]]); // insert, :117-135
    expect(solid(40, 49)).toEqual([[40, 49]]); // insert before sentinel
    expect(spansPrefix(4)).toEqual([
      [-M, -1],
      [20, 29],
      [40, 49],
      [VW, M]
    ]);

    // solid(30,39): walk: -1 < 29 advances, 29 < 29 FALSE -> start=(20,29)
    // (:113-115 adjacency is what makes 30-1==29 STOP here, not the next
    // post). 30 < 20 false (:117); 39 <= 29 false (:143); loop:
    // 39 >= 40-1 TRUE -> store(29+1, 39) (:151) = exactly (30,39); next++
    // -> 39 <= 49 -> start->last = 49 (:158) + crunch (:178-184).
    expect(solid(30, 39)).toEqual([[30, 39]]);
    expect(spansPrefix(3)).toEqual([
      [-M, -1],
      [20, 49],
      [VW, M]
    ]);

    // Contained probe over the merged span: zero fragments (r_bsp.c:143-146).
    expect(solid(25, 45)).toEqual([]);
    expect(spansPrefix(3)).toEqual([
      [-M, -1],
      [20, 49],
      [VW, M]
    ]);
  });

  it('a strict 1-column gap is NOT touching (first-1 comparison, :114)', () => {
    solid(20, 29);
    solid(31, 39); // gap at column 30: 29 < 31-1 == TRUE -> walk ADVANCES
    expect(spansPrefix(4)).toEqual([
      [-M, -1],
      [20, 29],
      [31, 39],
      [VW, M]
    ]);
    // Bridging span (30,30): walk stops at (20,29) (29 < 29 false); loop
    // 30 >= 31-1 TRUE -> store(30, 30) (:151); 30 <= 39 -> merge, crunch.
    expect(solid(30, 30)).toEqual([[30, 30]]);
    expect(spansPrefix(3)).toEqual([
      [-M, -1],
      [20, 39],
      [VW, M]
    ]);
  });
});

describe('sequence C — span swallowing three posts: between + between + after', () => {
  it('reports (15,19),(25,29),(35,36) and leaves one merged span (:147-166)', () => {
    solid(10, 14);
    solid(20, 24);
    solid(30, 34);
    expect(solidsegsLength()).toBe(5);

    // solid(12,36): walk stops at (10,14) (14 < 11 false, :113-115).
    // 12 < 10 false (:117); 36 <= 14 false (:143). Loop:
    //   36 >= 20-1 -> store(14+1, 19)  (:151)
    //   36 <= 24? no; 36 >= 30-1 -> store(24+1, 29)
    //   36 <= 34? no; 36 >= 320-1? NO -> loop exits at :148.
    // "fragment after *next": store(34+1, 36) = (35,36) (:163-166),
    // start->last = 36 (:166), crunch removes the two swallowed posts
    // (:178-184, newend = i + (end-j) + 1 = 1 + 2 + 1 = 4, sentinel moved to
    // index 2, junk at 3).
    expect(solid(12, 36)).toEqual([
      [15, 19],
      [25, 29],
      [35, 36]
    ]);
    expect(spansPrefix(3)).toEqual([
      [-M, -1],
      [10, 36],
      [VW, M]
    ]);
    expect(solidsegsLength()).toBe(4);
    expect(getRenderCounters().hom).toBe(0);
  });
});

describe('sequence D — right-sentinel stretch and full-screen clip', () => {
  it('viewwidth-trailing span stretches right sentinel without inserting', () => {
    // solid(310,319): walk advances past left sentinel (-1 < 309) and stops
    // at right (M < 309 false). 310 < 320 TRUE (:117), 319 < 319 FALSE
    // (:119) -> fragment-above: store(310, 320-1) (:138) then
    // start->first = 310 (:140); 319 <= M -> return (:143-146). Length 2.
    expect(solid(310, 319)).toEqual([[310, 319]]);
    expect(spansPrefix(2)).toEqual([
      [-M, -1],
      [310, M]
    ]);

    // solid(200,319): stops at the stretched right sentinel; 200 < 310,
    // 319 < 309 false -> store(200, 309), right.first = 200. Still no insert.
    expect(solid(200, 319)).toEqual([[200, 309]]);
    expect(spansPrefix(2)).toEqual([
      [-M, -1],
      [200, M]
    ]);
    expect(solidsegsLength()).toBe(2);
  });

  it('full-screen span turns the left sentinel into the cover-everything entry', () => {
    // solid(0,319) on a fresh ledger: walk stops at left sentinel
    // (-1 < -1 false). 0 < -M false; 319 <= -1 false; loop: 319 >= 320-1
    // TRUE -> store(-1+1, 320-1) = (0,319) (:151); next++ -> 319 <= M
    // -> left.last = M (:158), crunch (:170-184): end = 0 + (2-1) + 1 = 2.
    // Left sentinel now covers everything: every later clip returns false
    // at :143-146 with the walk stopping at index 0.
    expect(solid(0, 319)).toEqual([[0, 319]]);
    expect(solidsegsFirst(0)).toBe(-M);
    expect(solidsegsLast(0)).toBe(M);
    expect(solid(5, 10)).toEqual([]);
    expect(solid(0, 319)).toEqual([]);
    expect(pass(50, 60)).toEqual([]);
    expect(solidsegsLength()).toBe(2);
    expect(getRenderCounters().hom).toBe(0); // junk slot at index 1 is inert
  });
});

describe('sequence E — clipPassWallSegment reports fragments, NEVER inserts (r_bsp.c:197-238)', () => {
  it('pass segs leave the ledger byte-identical', () => {
    solid(50, 60);
    const before = spans();
    const lenBefore = solidsegsLength();
    const refsBefore = spans().map((_, i) => solidsegsDrawseg(i));

    // pass(0,319): walk stops at left sentinel (-1 < -1 false, :205-207);
    // 0 < -M false; 319 <= -1 false; loop (:226): 319 >= 50-1 -> store(0,49)
    // (:229); start++ -> 319 <= 60 false; 319 >= 320-1 -> store(61,319);
    // start++ -> 319 <= M -> RETURN (:232-233). Pure read of solidsegs —
    // the function assigns nothing, so occlusion from prior solids stands.
    expect(pass(0, 319)).toEqual([
      [0, 49],
      [61, 319]
    ]);
    expect(spans()).toEqual(before);
    expect(solidsegsLength()).toBe(lenBefore);
    expect(spans().map((_, i) => solidsegsDrawseg(i))).toEqual(refsBefore);

    // Fully-covered pass span -> zero fragments, still no mutation.
    expect(pass(50, 60)).toEqual([]);
    expect(spans()).toEqual(before);

    // Span overlapping the solid band from both sides: fragment-above
    // (49,49) (:219) + fragment-after (61,61) (:237). No insert branch
    // exists in the pass function at all.
    expect(pass(49, 61)).toEqual([
      [49, 49],
      [61, 61]
    ]);
    expect(spans()).toEqual(before);
    expect(solidsegsLength()).toBe(lenBefore);
  });
});

describe('sequence F — MAXSEGS overflow injection: hom counter liveness', () => {
  it('33 disjoint spans -> fragments reported, inserts beyond 30 drop, hom > 0', () => {
    // Spans (4k+1, 4k+2), k = 0..32: pairwise gapped by >= 2 columns, so
    // every clip takes the INSERT branch (:117-135 — walk always runs to
    // the right sentinel since no existing last >= first-1). Vanilla
    // grows newend one per span from 2; at newend == MAXSEGS(32) the next
    // insert's `newend++` (:124-125) writes past solidsegs[31] (:92) —
    // 1.10 has NO guard there (memory corruption, not I_Error as the task
    // note guessed). Our DEVIATION 1: fragment still reported (vanilla's
    // R_StoreWallRange at :123 precedes the overflowing write), insert
    // dropped, hom++ + solidsegDrops++.
    for (let k = 0; k < 33; k++) {
      const f = 4 * k + 1;
      expect(solid(f, f + 1)).toEqual([[f, f + 1]]); // fragments always land
      expect(solidsegsLength()).toBeLessThanOrEqual(MAXSEGS);
    }
    // Inserts succeed while end < 32: spans k=0..29 take end 2 -> 32.
    // k=30,31,32 find end == 32 -> dropped: 3 overflows.
    const c = getRenderCounters();
    expect(c.hom).toBe(3);
    expect(c.hom).toBeGreaterThan(0);
    expect(c.solidsegDrops).toBe(3);
    expect(c.drawsegOverflow).toBe(0); // counted separately (M3-plan §M3-03)
    expect(solidsegsLength()).toBe(MAXSEGS);
  });
});

describe('sequence G — drawseg ref slots travel with struct copies', () => {
  it('insert-shift and crunch move the Int32Array triples, r_bsp.c:127-131/178-181', () => {
    // G1: insert (50,60) -> index 1, fresh ref -1; M3-06-style attach 7.
    solid(50, 60);
    expect(solidsegsDrawseg(1)).toBe(-1);
    setSolidsegsDrawseg(1, 7);

    // G2: insert (200,210) shifts [right sentinel] up; ref slot rides with
    // its entry ((50,60)+ref7 is NOT moved — the shift starts at the walk
    // stop index, r_bsp.c:127-131); the new span starts unattached.
    solid(200, 210);
    expect(spansPrefix(4)).toEqual([
      [-M, -1],
      [50, 60],
      [200, 210],
      [VW, M]
    ]);
    expect([solidsegsDrawseg(1), solidsegsDrawseg(2)]).toEqual([7, -1]);
    setSolidsegsDrawseg(2, 8);

    // G3: solid(70,190) hits the INSERT branch at the (200,210) entry
    // (walk: 60 < 69 advances past (50,60), :113-115; 70 < 200 and
    // 190 < 199, :117/:119): shift of indices 2..3 keeps refs glued.
    expect(solid(70, 190)).toEqual([[70, 190]]);
    expect(spansPrefix(5)).toEqual([
      [-M, -1],
      [50, 60],
      [70, 190],
      [200, 210],
      [VW, M]
    ]);
    expect([solidsegsDrawseg(1), solidsegsDrawseg(2), solidsegsDrawseg(3)]).toEqual([
      7,
      -1,
      8
    ]);

    // G4: span (60,201) swallows indices 2..3: between-post fragments
    // (61,69) and (191,199) (:151 twice), 201 <= 210 -> start->last = 210
    // (:158); crunch (:178-184) moves the sentinel down and leaves the
    // usual inert junk slot inside the window; the surviving merged entry
    // keeps *its* incumbent ref (7) — ref maintenance is the setter's
    // business (last-touch by M3-06), the ledger only ever MOVES slots.
    expect(solid(60, 201)).toEqual([
      [61, 69],
      [191, 199]
    ]);
    expect(spansPrefix(3)).toEqual([
      [-M, -1],
      [50, 210],
      [VW, M]
    ]);
    expect(solidsegsDrawseg(1)).toBe(7);
    expect(solidsegsLength()).toBe(4); // junk artifact of the literal loop
    expect(solid(100, 150)).toEqual([]); // occlusion still intact
  });
});

describe('H — R_CheckBBox fully-covered walk works on the raw accessors (r_bsp.c:475-483)', () => {
  it('the bbox early-out stop test terminates on our storage', () => {
    solid(20, 29);
    // Vanilla: `start = solidsegs; while (start->last < sx2) start++;`
    // then `sx1 >= start->first && sx2 <= start->last` -> return false.
    const covered = (sx1: number, sx2: number): boolean => {
      let i = 0;
      while (solidsegsLast(i) < sx2) i++;
      return sx1 >= solidsegsFirst(i) && sx2 <= solidsegsLast(i);
    };
    expect(covered(20, 29)).toBe(true); // fully covered -> skip bbox
    expect(covered(19, 29)).toBe(false); // column 19 still open
    expect(covered(20, 30)).toBe(false);
  });
});

describe('counters — separation + store-range guards', () => {
  it('noteDrawsegOverflow counts MAXDRAWSEGS separately from hom (r_segs.c:385-387)', () => {
    noteDrawsegOverflow();
    noteDrawsegOverflow();
    expect(getRenderCounters()).toEqual({
      hom: 0,
      drawsegOverflow: 2,
      solidsegDrops: 0,
      visplaneOverflow: 0,
      openingOverflow: 0,
    });
  });

  it('noteBadStoreRange flags start > stop with hom++ (r_segs.c:389-392 deviation)', () => {
    expect(noteBadStoreRange(10, 5)).toBe(false);
    expect(getRenderCounters().hom).toBe(1);
    expect(noteBadStoreRange(10, 10)).toBe(true);
    expect(noteBadStoreRange(4, 9)).toBe(true);
    expect(getRenderCounters().hom).toBe(1); // ok ranges do not increment
  });

  it('resetRenderCounters zeroes all five (M4-01 adds visplane/opening)', () => {
    noteDrawsegOverflow();
    solid(0, 319); // full screen -> no overflow path
    expect(solid(5, 6)).toEqual([]);
    resetRenderCounters();
    expect(getRenderCounters()).toEqual({ hom: 0, drawsegOverflow: 0, solidsegDrops: 0, visplaneOverflow: 0, openingOverflow: 0 });
  });

  it('getRenderCounters returns a detached snapshot', () => {
    const snap = getRenderCounters();
    snap.hom = 999;
    expect(getRenderCounters().hom).toBe(0);
  });
});
