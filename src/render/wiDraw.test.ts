/**
 * render/wiDraw tests — M9-07 (plan §M9-07 acceptance 4).
 *  * geometry parity: every drawing routine is exercised against a
 *    synthetic all-known-sizes patch set (digits per-pixel right-justified
 *    LSB-first, colon/sucks placements, LF/EL centering + 5/4 steps,
 *    stat-row lh = 3*h/2 truncation, lnode fits + splat/pointer),
 *  * golden frames on the REAL freedoom1.wad: StatCount at t=1/70/200 and
 *    ShowNextLoc blink-on/off — hashState-style hashes of screens[0].
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildPatchFromColumns } from '../wad/patch';
import { WadFile } from '../wad/wadfile';

import {
  FG,
  SCREENWIDTH,
  decodeVPatch,
  screens,
  vInit,
  vMemset,
  vVideoStats
} from './vvideo';
import {
  mapWiPatches,
  wadWiPatches,
  wiDrawer,
  wiDrawEL,
  wiDrawLF,
  wiDrawNum,
  wiDrawOnLnode,
  wiDrawPercent,
  wiDrawTime,
  wiLoadData,
  wiSlamBackground,
  WI_LNODES,
  wiaName,
  type WiDrawSnapshot,
  type WiGraphics,
  type WiPatchSource
} from './wiDraw';

/* ------------------------------------------------------------------ */
/* synthetic patch set (every size/color known exactly)                */
/* ------------------------------------------------------------------ */

function solid(w: number, h: number, v: number, left = 0, top = 0) {
  const cols = Array.from({ length: w }, () => new Array<number>(h).fill(v));
  return decodeVPatch(buildPatchFromColumns(cols, left, top), 'SYNTH');
}

/** num[0..9]: 3×5, color 10+d. */
function synthNums(): Record<string, ReturnType<typeof decodeVPatch>> {
  const out: Record<string, ReturnType<typeof decodeVPatch>> = {};
  for (let d = 0; d < 10; d++) out[`WINUM${d}`] = solid(3, 5, 10 + d);
  return out;
}

function synthPatches(): Map<string, ReturnType<typeof decodeVPatch>> {
  const m = new Map<string, ReturnType<typeof decodeVPatch>>();
  const put = (n: string, w: number, h: number, v: number, left = 0, top = 0): void => {
    m.set(n, solid(w, h, v, left, top));
  };
  put('WIMAP0', 320, 200, 42); // full-screen background
  for (let i = 0; i < 9; i++) put(`WILV0${i}`, 64, 8, 60 + i); // height 8
  put('WIURH0', 51, 11, 100);
  put('WIURH1', 51, 11, 101);
  put('WISPLAT', 13, 15, 110);
  put('WIPCNT', 17, 5, 120);
  put('WICOLON', 2, 5, 130);
  for (const [k, v] of Object.entries(synthNums())) m.set(k, v);
  put('WIMINUS', 7, 5, 140);
  put('WIF', 60, 8, 150);
  put('WIENTER', 60, 8, 160);
  put('WISCRT2', 30, 5, 170);
  put('WIOSTK', 25, 5, 180);
  put('WIOSTI', 25, 5, 181);
  put('WITIME', 25, 5, 182);
  put('WIPAR', 18, 5, 183);
  put('WISUCKS', 30, 5, 190);
  // episode-0 anim frames: WIA0{ii}{ff}, 8×8, unique colors
  for (let i = 0; i < 10; i++) {
    for (let f = 0; f < 3; f++) {
      m.set(`WIA0${String(i).padStart(2, '0')}${String(f).padStart(2, '0')}`,
        solid(8, 8, 200 + i * 3 + f));
    }
  }
  return m;
}

function synthSource(): WiPatchSource {
  return mapWiPatches(synthPatches());
}

function gAt(x: number, y: number): number {
  return screens[FG]!.data[y * SCREENWIDTH + x]!;
}

function fillRef(x0: number, y0: number, w: number, h: number, v: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) expect(gAt(x0 + x, y0 + y), `(${x0 + x},${y0 + y})`).toBe(v);
  }
}

let src: WiPatchSource;
let g: WiGraphics;

beforeEach(() => {
  vInit();
  src = synthSource();
  g = wiLoadData(src, 0); // draws WIMAP0 (color 42) into screens[1]
});

/* ------------------------------------------------------------------ */
/* background slam                                                    */
/* ------------------------------------------------------------------ */

describe('WI_slamBackground', () => {
  it('copies screens[1] into FG byte-exact + marks the full rect', () => {
    const marksBefore = vVideoStats.markRectCalls;
    vMemset(FG, 7); // poison FG
    wiSlamBackground();
    expect(gAt(0, 0)).toBe(42);
    expect(gAt(319, 199)).toBe(42);
    expect(screens[FG]!.data.every((v) => v === 42)).toBe(true);
    expect(vVideoStats.markRectCalls).toBe(marksBefore + 1);
  });
});

/* ------------------------------------------------------------------ */
/* WI_drawNum — per-pixel right-justified digit parity                 */
/* ------------------------------------------------------------------ */

describe('WI_drawNum per-pixel parity', () => {
  it('n=12: ones digit at x-3, tens at x-6 (LSB-first), returns left edge', () => {
    vMemset(FG, 0);
    vMemset(1, 0);
    const nx = wiDrawNum(g, 100, 10, 12, -1);
    expect(nx).toBe(94);
    fillRef(97, 10, 3, 5, 12); // digit '2'
    fillRef(94, 10, 3, 5, 11); // digit '1'
    expect(gAt(93, 12)).toBe(0); // nothing left of the tens digit
    expect(gAt(100, 12)).toBe(0); // nothing at/after x
  });

  it('n=0 is one digit; digits=2 forces the leading zero', () => {
    vMemset(FG, 0);
    expect(wiDrawNum(g, 100, 0, 0, -1)).toBe(97);
    fillRef(97, 0, 3, 5, 10);
    expect(gAt(96, 2)).toBe(0);

    vMemset(FG, 0);
    expect(wiDrawNum(g, 100, 0, 0, 2)).toBe(94);
    fillRef(97, 0, 3, 5, 10);
    fillRef(94, 0, 3, 5, 10);
  });

  it('n=123 spans three cells; n=-12 adds the minus at x-8', () => {
    vMemset(FG, 0);
    expect(wiDrawNum(g, 100, 20, 123, -1)).toBe(91);
    fillRef(97, 20, 3, 5, 13);
    fillRef(94, 20, 3, 5, 12);
    fillRef(91, 20, 3, 5, 11);

    vMemset(FG, 0);
    expect(wiDrawNum(g, 100, 30, -12, -1)).toBe(86);
    fillRef(97, 30, 3, 5, 12);
    fillRef(94, 30, 3, 5, 11);
    fillRef(86, 30, 7, 5, 140); // minus at 94-8
  });

  it('1994 is the "n/a" sentinel: nothing drawn, returns 0', () => {
    vMemset(FG, 0);
    expect(wiDrawNum(g, 100, 40, 1994, 3)).toBe(0);
    expect(screens[FG]!.data.every((v) => v === 0)).toBe(true);
  });
});

describe('WI_drawPercent / WI_drawTime', () => {
  it('percent: patch at x, digits END at x; negative draws nothing', () => {
    vMemset(FG, 0);
    wiDrawPercent(g, 270, 50, 33);
    fillRef(270, 50, 17, 5, 120); // WIPCNT
    fillRef(267, 50, 3, 5, 13); // '3' ones
    fillRef(264, 50, 3, 5, 13); // '3' tens
    expect(gAt(263, 52)).toBe(0);

    vMemset(FG, 0);
    wiDrawPercent(g, 270, 50, -1);
    expect(screens[FG]!.data.every((v) => v === 0)).toBe(true);
  });

  it('time t=0: two digits + the div==60 colon', () => {
    vMemset(FG, 0);
    wiDrawTime(g, 100, 168, 0);
    fillRef(97, 168, 3, 5, 10);
    fillRef(94, 168, 3, 5, 10);
    fillRef(92, 168, 2, 5, 130); // colon at 94-3+... = drawNum-return(94) - colonW(2)
  });

  it('time t=60: "01:00" — colon separates, minutes left of it', () => {
    vMemset(FG, 0);
    wiDrawTime(g, 100, 168, 60);
    fillRef(97, 168, 3, 5, 10); // seconds tens…
    fillRef(94, 168, 3, 5, 10); // …ones (both '0')
    fillRef(92, 168, 2, 5, 130); // colon
    fillRef(89, 168, 3, 5, 11); // minute '1'
    fillRef(86, 168, 3, 5, 10); // leading zero
    expect(gAt(85, 170)).toBe(0);
  });

  it('time > 61*59 draws WISUCKS right-justified at x', () => {
    vMemset(FG, 0);
    wiDrawTime(g, 300, 168, 61 * 59 + 1);
    fillRef(270, 168, 30, 5, 190);
    expect(gAt(269, 170)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* LF / EL geometry                                                   */
/* ------------------------------------------------------------------ */

describe('WI_drawLF / WI_drawEL', () => {
  it('level name centered at y=2, then 5*height/4 step to WIF/WILV', () => {
    vMemset(FG, 0);
    wiDrawLF(g, { ...snapOf({ last: 2, next: 0 }) });
    fillRef((320 - 64) / 2, 2, 64, 8, 62); // WILV02
    fillRef((320 - 60) / 2, 2 + Math.trunc((5 * 8) / 4), 60, 8, 150); // WIF @ y=12
  });

  it('"Entering" first, then the NEXT level name', () => {
    vMemset(FG, 0);
    wiDrawEL(g, { ...snapOf({ last: 0, next: 5 }) });
    fillRef((320 - 60) / 2, 2, 60, 8, 160); // WIENTER
    fillRef((320 - 64) / 2, 12, 64, 8, 65); // WILV05
  });
});

/* ------------------------------------------------------------------ */
/* lnode placement (fits-first + splat/pointer)                        */
/* ------------------------------------------------------------------ */

describe('WI_drawOnLnode', () => {
  it('draws c[0] when it fits at lnodes[epsd][n]', () => {
    vMemset(FG, 0);
    const snap = snapOf({ epsd: 0, next: 0 });
    wiDrawOnLnode(snap, 0, [g.splat]);
    const [lx, ly] = WI_LNODES[0]![0]!;
    expect([lx, ly]).toEqual([185, 164]);
    fillRef(185, 164, 13, 15, 110);
  });

  it('falls through to c[1] when c[0] does not fit (left < 0)', () => {
    vMemset(FG, 0);
    const big = solid(400, 20, 99, 300, 0); // left = x-300 < 0 at node 0
    const snap = snapOf({ epsd: 0 });
    const [lx, ly] = WI_LNODES[0]![0]!;
    // c[0] unfit → c[1] (a small patch) is chosen
    wiDrawOnLnode(snap, 0, [big, g.yah[0]]);
    fillRef(lx, ly, 51, 11, 100);
  });
});

/* ------------------------------------------------------------------ */
/* WI_Drawer via the LIVE snapshot (sim-driven StatCount)               */
/* ------------------------------------------------------------------ */

function snapOf(
  over: Partial<Pick<WiDrawSnapshot, 'last' | 'next' | 'epsd'>> = {}
): WiDrawSnapshot {
  // Snapshot literal (the layout tests pin only the fields the drawer
  // path under test consumes).
  return {
    phase: 'StatCount',
    spState: 1,
    cntKills: -1,
    cntItems: -1,
    cntSecret: -1,
    cntTime: -1,
    cntPar: -1,
    snlPointerOn: false,
    didsecret: false,
    epsd: 0,
    last: 0,
    next: 0,
    anims: Array.from({ length: 10 }, () => ({ x: 0, y: 0, ctr: -1 })),
    ...over
  };
}

describe('WI_Drawer — StatCount layout (labels, lh = 3*num.h/2)', () => {
  it('draws LF + the five labels; negative counters draw no digits', () => {
    vMemset(FG, 0);
    expect(wiDrawer(src, snapOf())).toBe(true);
    // bg slam (WIMAP0 synth = 42 everywhere)
    expect(gAt(5, 5)).toBe(42);
    // WILV00 + WIF
    fillRef((320 - 64) / 2, 2, 64, 8, 60);
    // lh = trunc(3*5/2) = 7
    fillRef(50, 50, 25, 5, 180); // kills
    fillRef(50, 57, 25, 5, 181); // items
    fillRef(50, 64, 30, 5, 170); // scrt (WISCRT2)
    fillRef(16, 168, 25, 5, 182); // time
    fillRef(176, 168, 18, 5, 183); // par (epsd 0 < 3)
    // percent sign NOT drawn (cnt < 0 → WI_drawPercent returns early)
    expect(gAt(270, 52)).toBe(42); // still the bg
    // time digits absent (t<0)
    expect(gAt(144, 170)).toBe(42);
  });
});

// The layout test drives the real WI_Drawer dispatch with a snapshot
// literal — the render side consumes the snapshot, never the sim module
// (zone rule; the production glue `wiDrawer(src, wiDrawSnapshot())` lives
// where main.ts / M9-09 may legally import both zones).

/* ------------------------------------------------------------------ */
/* real-WAD golden frames (snapshot literals — zone rule: render tests
 * never import sim; the counter values are the LIVE sim values of the
 * M9-07 tally (kills 10/20, items 3/10, secrets 0/1, leveltime 500,
 * E1M1 par 30) at WI tics 1/70/200, pinned identically in
 * sim/wintermission.test.ts). The epsd0 anim ctr values are irrelevant
 * to the pixels on the pinned freedoom1.wad (every WIA* frame is a
 * 13-byte 1×1 EMPTY patch — DATA FINDING, report) — the real epsd0
 * anim locations are used for shape fidelity.
 * ------------------------------------------------------------------ */

const EPSD0_LOCS: readonly (readonly [number, number])[] = [
  [224, 104], [184, 160], [112, 136], [72, 112], [88, 96],
  [64, 48], [192, 40], [136, 16], [80, 16], [64, 24]
];

function tallySnap(over: Partial<WiDrawSnapshot>): WiDrawSnapshot {
  return {
    phase: 'StatCount',
    spState: 1,
    cntKills: -1,
    cntItems: -1,
    cntSecret: -1,
    cntTime: -1,
    cntPar: -1,
    snlPointerOn: false,
    didsecret: false,
    epsd: 0,
    last: 0,
    next: 1,
    anims: EPSD0_LOCS.map(([x, y]) => ({ x, y, ctr: 0 })),
    ...over
  };
}

function frameHash(): string {
  return createHash('sha256').update(screens[FG]!.data).digest('hex').slice(0, 16);
}

const WAD_PATH =
  process.env.FREEDOOM1_WAD ?? fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe('freedoom1.wad draw goldens', () => {
  const wad: WadFile | null = hasWad
    ? WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer)
    : null;

  it('StatCount t=1/70/200 + ShowNextLoc blink pair', () => {
    if (wad === null) return; // no pinned wad ⇒ nothing to paint
    vInit();
    const wsrc = wadWiPatches(wad);

    // t=1 (sp_state 1 pause: every counter still -1 — nothing drawn but
    // the map + Finished! + labels)
    wiDrawer(wsrc, tallySnap({}));
    const h1 = frameHash();
    // t=70 (state 3 pause: kills landed at 50)
    wiDrawer(wsrc, tallySnap({ spState: 3, cntKills: 50 }));
    const h70 = frameHash();
    // t=200 (state 9 pause: all finals; time 14 s, par 30 s)
    wiDrawer(wsrc, tallySnap({ spState: 9, cntKills: 50, cntItems: 30, cntSecret: 0, cntTime: 14, cntPar: 30 }));
    const h200 = frameHash();

    expect(h1).toBe(GOLDEN_T1);
    expect(h70).toBe(GOLDEN_T70);
    expect(h200).toBe(GOLDEN_T200);

    // ShowNextLoc blink — DATA FINDING (report FINDINGS): the pinned
    // freedoom1.wad ships WIURH0/1, WISPLAT and ALL 58 WIA anim frames as
    // 13-byte 1×1 EMPTY patches (terminator-only post chains; WIMAP0 and
    // WILV* are real), so blink-on/off paint IDENTICAL pixels on this
    // data — the pointer STATE (sim-side snl_pointeron, pinned in
    // sim/wintermission.test.ts) is the observable; the identical-frame
    // consequence is asserted here, not papered over.
    wiDrawer(wsrc, { ...tallySnap({ phase: 'ShowNextLoc' }), phase: 'ShowNextLoc', snlPointerOn: true });
    const blinkOn = frameHash();
    wiDrawer(wsrc, { ...tallySnap({ phase: 'ShowNextLoc' }), phase: 'ShowNextLoc', snlPointerOn: false });
    expect(blinkOn).toBe(frameHash());
    // splats + entering-line: last=0 ⇒ splat on node 0, EL for map 2
    wiDrawer(wsrc, { ...tallySnap({}), phase: 'ShowNextLoc', snlPointerOn: false });
    expect(frameHash()).toBe(blinkOn); // splat empty too on this wad
  });
});

// Goldens recorded 2026-07 against the pinned wads/freedoom1.wad (M9-07).
const GOLDEN_T1 = '843c8211a8f9bb93';
const GOLDEN_T70 = '9ac44b1b158c97a7';
const GOLDEN_T200 = '647b253fa39c9c60';

/* wiaName sanity (the %.2d-space-padding vs zero-padding FINDING) */
describe('WIA name builder', () => {
  it('zero-pads both indices (measured lump names)', () => {
    expect(wiaName(0, 0, 0)).toBe('WIA00000');
    expect(wiaName(0, 9, 2)).toBe('WIA00902');
    expect(wiaName(1, 8, 0)).toBe('WIA10400'); // the anims[1][4] hack
  });
});
