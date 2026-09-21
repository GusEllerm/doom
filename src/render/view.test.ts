// M9-09 — R_ExecuteSetViewSize params (plan §M9-09 acceptance 1).
//
// Pinned source truths (linuxdoom-1.10, verified against the mirror):
//   r_main.c:671-757 R_ExecuteSetViewSize — sb==11 ⇒ 320x200; else
//     scaledviewwidth = sb*32, viewheight = (sb*168/10)&~7 (C integer math);
//     centery = viewheight/2, projection = centerx<<FRACBITS;
//     pspritescale = FRACUNIT*viewwidth/320 (truncating);
//   r_draw.c:696-723 R_InitBuffer — viewwindowx = (320-width)>>1;
//     viewwindowy = width==320 ? 0 : (200-32-height)>>1 (sb10 top-aligned);
//   m_misc.c:279 — shipped default screenblocks = 9;
//   m_menu.c:1154-1173 — M_SizeDisplay range: blocks 3..11.
//
// The viewheight table the plan pins: sb ∈ {11,10,9,6,3} ⇒ 200/168/144/
// 96/48 EXACT (the brief's "200→112" corresponds to no screenblocks value,
// M9-plan §0.11).
//
// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import {
  SCREENBLOCKS_DEFAULT,
  consumeViewSetSizeNeeded,
  executeSetViewSize,
  setViewSize,
  viewSize,
  viewSizeNeeded,
} from './view';

/** Apply an explicit size for a test (leaves the pending flag clear). */
function at(blocks: number): ReturnType<typeof executeSetViewSize> {
  setViewSize(blocks, 0);
  return executeSetViewSize();
}

afterEach(() => {
  // restore the shipped default so suite-order never leaks a resized state
  setViewSize(SCREENBLOCKS_DEFAULT, 0);
  executeSetViewSize();
});

describe('R_ExecuteSetViewSize — viewheight/window table (§M9-09 a1)', () => {
  it('sb ∈ {11,10,9,6,3} ⇒ viewheight 200/168/144/96/48 + exact windowx/y', () => {
    const rows = [
      { sb: 11, w: 320, h: 200, wx: 0, wy: 0 }, // fullscreen: no bar, no border
      { sb: 10, w: 320, h: 168, wx: 0, wy: 0 }, // 320-wide ⇒ TOP-aligned (§0.11)
      { sb: 9, w: 288, h: 144, wx: 16, wy: 12 }, // shipped default (m_misc.c:279)
      { sb: 6, w: 192, h: 96, wx: 64, wy: 36 },
      { sb: 3, w: 96, h: 48, wx: 112, wy: 60 },
    ];
    for (const r of rows) {
      const vs = at(r.sb);
      expect(vs.scaledviewwidth, `sb${r.sb} scaledviewwidth`).toBe(r.w);
      expect(vs.viewwidth, `sb${r.sb} viewwidth (detail 0)`).toBe(r.w);
      expect(vs.viewheight, `sb${r.sb} viewheight`).toBe(r.h);
      expect(vs.viewwindowx, `sb${r.sb} viewwindowx`).toBe(r.wx);
      expect(vs.viewwindowy, `sb${r.sb} viewwindowy`).toBe(r.wy);
      expect(vs.centery, `sb${r.sb} centery`).toBe(r.h / 2);
      expect(vs.centerx, `sb${r.sb} centerx`).toBe(r.w / 2);
      expect(vs.projection, `sb${r.sb} projection`).toBe((r.w / 2) << 16);
      expect(vs.fullscreen, `sb${r.sb} fullscreen flag`).toBe(r.h === 200);
    }
  });

  it('yslope is REBUILT per viewheight (r_main.c:729-734)', () => {
    const full = at(11);
    const sb9 = at(9);
    expect(full.yslope.length).toBe(200);
    expect(sb9.yslope.length).toBe(144);
    // yslope[centery] = FixedDiv(centerxfrac, FRACUNIT/2) = centerxfrac*2
    expect(sb9.yslope[72]).toBe((sb9.centerxfrac * 2) | 0);
    // rows farther from centery have SMALLER slopes, all finite
    for (let i = 1; i < 72; i += 1) {
      expect(sb9.yslope[72 + i]!).toBeLessThan(sb9.yslope[72 + i - 1]!);
      expect(Number.isFinite(sb9.yslope[72 + i]!)).toBe(true);
    }
    // pixel-center bias (verbatim r_main.c): dy = ((i-vh/2)<<16)+FRACUNIT/2
    // — NOT symmetric about centery: row 72-k sits |dy| = k<<16 - 32768
    // from the horizon, row 72+k at k<<16 + 32768 (the +half is added, not
    // abs-mirrored), so the upper row keeps the LARGER slope.
    expect(sb9.yslope[72 - 10]!).toBeGreaterThan(sb9.yslope[72 + 10]!);
  });

  it('distscale + psprite scales follow viewwidth (r_main.c:718-740)', () => {
    const sb9 = at(9);
    expect(sb9.distscale.length).toBe(288);
    // pspritescale = FRACUNIT*288/320, C integer division
    expect(sb9.pspritescale).toBe(Math.floor((FRACUNIT * 288) / 320));
    expect(sb9.pspriteiscale).toBe(Math.floor((FRACUNIT * 320) / 288));
    // sb11: both exactly FRACUNIT (the M4 constants stay valid there)
    const full = at(11);
    expect(full.pspritescale).toBe(FRACUNIT);
    expect(full.pspriteiscale).toBe(FRACUNIT);
  });

  it('the shipped default is screenblocks 9 (m_misc.c:279)', () => {
    expect(SCREENBLOCKS_DEFAULT).toBe(9);
    const vs = viewSize();
    expect(vs.scaledviewwidth).toBe(288);
    expect(vs.viewheight).toBe(144);
  });

  it('R_SetViewSize is DEFERRED; consume fires exactly once (=/- live resize)', () => {
    at(11);
    setViewSize(9, 0);
    expect(viewSizeNeeded()).toBe(true);
    expect(viewSize().scaledviewwidth).toBe(288); // the read applies it
    expect(viewSizeNeeded()).toBe(false);
    expect(consumeViewSetSizeNeeded()).toBe(false); // nothing pending
    setViewSize(6, 0);
    expect(consumeViewSetSizeNeeded()).toBe(true); // d_main.c:198-203 once
    expect(consumeViewSetSizeNeeded()).toBe(false);
    expect(viewSize().scaledviewwidth).toBe(192);
  });
});
