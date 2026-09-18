// drawsegs.ts units — the openings-ref representation (FIX-M4-09).
//
// The drawseg clip/maskedtexturecol fields store vanilla's `lastopening -
// start` POINTER DIFFERENCE plus the NULL/screenheightarray/negonearray
// sentinels in ONE Int32. Vanilla can never confuse the two (a pointer is
// never "the number -1"); an Int32 can, so the sentinel codes must live
// outside the range a ref can take. That aliasing is FIX-M4-09: the first
// masked drawseg of a frame stores `0 - rw_x === -1`, which used to BE
// CLIP_NULL, so R_DrawMasked's final flush (`if (ds->maskedtexturecol)`)
// skipped it and the masked middle was never drawn or consumed.
//
// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from "vitest";

import { RENDER_WIDTH } from "./framebuffer";
import {
  CLIP_NEGONE, CLIP_NULL, CLIP_SCREEN, MAXOPENINGS, allocOpenings, clipValue,
  drawsegAdd, getDrawsegs, openingsAt, openingsSet, openingsUsed, snapshotOpenings,
} from "./drawsegs";

/** Every value vanilla's `lastopening - start` can take. */
const REF_MIN = -(RENDER_WIDTH - 1);
const REF_MAX = MAXOPENINGS;

describe("drawsegs openings refs (FIX-M4-09)", () => {
  it("sentinel codes are unreachable by a real ref", () => {
    for (const sentinel of [CLIP_NULL, CLIP_SCREEN, CLIP_NEGONE]) {
      expect(sentinel, `sentinel ${sentinel} below every ref`).toBeLessThan(REF_MIN);
      expect(sentinel, `sentinel ${sentinel} above no ref`).toBeLessThan(REF_MAX);
    }
    // The historical collision, pinned as impossible-by-construction now.
    expect([CLIP_NULL, CLIP_SCREEN, CLIP_NEGONE]).not.toContain(-1);
    expect([CLIP_NULL, CLIP_SCREEN, CLIP_NEGONE]).not.toContain(-2);
    expect([CLIP_NULL, CLIP_SCREEN, CLIP_NEGONE]).not.toContain(-3);
  });

  it("a negative ref is a ref: resolved against the pool, never as a sentinel", () => {
    // Vanilla's masked-middle allocation of a frame's first drawseg:
    // base 0, start 1 ⇒ ref -1.
    const start = 1;
    const base = allocOpenings(start + 1); // pool [0, 2)
    expect(base).toBe(0);
    openingsSet(0, 1234);
    openingsSet(1, 4321);
    const ref = base - start; // -1
    expect(ref).toBe(-1);
    expect(ref).not.toBe(CLIP_NULL);
    expect(openingsAt(ref + 1)).toBe(1234);
    expect(openingsAt(ref + 2)).toBe(4321);
    expect(clipValue(ref, 1, 200)).toBe(1234);

    // The two static-array sentinels keep their value semantics.
    expect(clipValue(CLIP_SCREEN, 5, 200)).toBe(200);
    expect(clipValue(CLIP_NEGONE, 5, 200)).toBe(-1);
  });

  it("snapshotOpenings hands back the signed difference (pool watermark moves)", () => {
    const used = openingsUsed();
    const src = new Int16Array(4).fill(7);
    const ref = snapshotOpenings(src, 2, 2);
    expect(ref).toBe(used - 2);
    expect(openingsUsed()).toBe(used + 2);
    expect(openingsAt((ref as number) + 2)).toBe(7);

    // An unallocated drawseg field stays CLIP_NULL (never a stale ref).
    const i = drawsegAdd(0);
    const d = getDrawsegs();
    expect(d.maskedcol[i]!).toBe(CLIP_NULL);
    expect(d.sprtopclip[i]!).toBe(CLIP_NULL);
    expect(d.sprbottomclip[i]!).toBe(CLIP_NULL);
  });
});
