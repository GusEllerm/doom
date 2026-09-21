/**
 * Tests for ui/stlib.ts — the st_lib.c widget primitives (M9-05, plan
 * §M9-05 acceptance 4 + the widget mechanics of §0.8).
 *
 * EVIDENCE MODEL (plan: "reference = an independent per-pixel compose in the
 * test, not bless-of-convenience"): every pixel assertion builds an EXPECTED
 * buffer from patch.ts's INDEPENDENT decode (decodePatch's column model — a
 * different code path from vvideo's raw post walk) starting from a snapshot
 * of the noise FG, applying the widget's documented sequence
 * (BG-erase rect → glyphs right-to-left) with plain index math, then compares
 * the whole FG layer byte-for-byte. Fixtures are uniform-fill patches with no
 * 0-valued pixels, so "0 = transparent" (column model) and "write every post
 * byte" (raw model, pinned in render/vvideo.test.ts) coincide exactly here.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { buildPatchFromColumns, decodePatch } from '../wad/patch';
import { buildWad } from '../../tests/fixtures/wadWriter';
import { WadFile } from '../wad/wadfile';
import { BG, FG, ST_HEIGHT, ST_WIDTH, decodeVPatch, screens, vInit, vMemset } from '../render/vvideo';
import {
  ST_Y,
  StLibError,
  stBinIcon,
  stLibDrawNum,
  stLibInit,
  stLibInitBinIcon,
  stLibInitMultIcon,
  stLibInitNum,
  stLibInitPercent,
  stLibTtminus,
  stLibUpdateBinIcon,
  stLibUpdateMultIcon,
  stLibUpdateNum,
  stLibUpdatePercent,
  stMultIcon,
  stNumber,
  stPercent,
  type StBinIcon,
  type StMultIcon,
  type StNumber,
} from './stlib';

/* ------------------------------------------------------------------ */
/* Fixture patches (uniform fill ⇒ the two decodes agree byte-for-byte) */
/* ------------------------------------------------------------------ */

const W = 320;

/** A solid w x h patch, all pixels `fill` (never 0). */
function solidBytes(w: number, h: number, fill: number, left = 0, top = 0): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < w; c += 1) cols.push(new Array<number>(h).fill(fill));
  return buildPatchFromColumns(cols, left, top);
}

const DW = 8; // digit width
const DH = 10; // digit height
const digitBytes = (d: number): Uint8Array => solidBytes(DW, DH, 100 + d);
const digitLumps = Array.from({ length: 10 }, (_, d) => decodeVPatch(digitBytes(d), `TALL${d}`));
const percentLump = decodeVPatch(solidBytes(10, 10, 77), 'STTPRCNT');

/** A WAD carrying STTMINUS — the only lump STlib_init loads (st_lib.c:49-52). */
function wadWithMinus(): WadFile {
  return WadFile.parse(buildWad([{ name: 'STTMINUS', data: solidBytes(8, 10, 88, 4, 0) }]));
}

function patternBg(): void {
  const bg = screens[BG]!;
  for (let y = 0; y < bg.height; y += 1) {
    for (let x = 0; x < bg.width; x += 1) bg.data[y * bg.width + x] = 30 + ((x + y) % 7);
  }
}

function noiseFg(seed = 5): void {
  const fg = screens[FG]!;
  let s = seed;
  for (let i = 0; i < fg.data.length; i += 1) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    fg.data[i] = 1 + (s % 250);
  }
}

/** The noise FG snapshot every reference starts from. */
let base: Uint8Array;

function refBase(): Uint8Array {
  return base.slice();
}

/** Reference: BG→FG erase of the rect [x0,x0+w) × [y, y+h). */
function refErase(dst: Uint8Array, x0: number, w: number, y: number, h: number): void {
  const bg = screens[BG]!;
  for (let r = 0; r < h; r += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      dst[(y + r) * W + x] = bg.data[(y + r - ST_Y) * W + x]!;
    }
  }
}

/** Reference: blit one patch (patch.ts decode) at (x,y) with its anchors. */
function refBlit(dst: Uint8Array, x: number, y: number, name: string): void {
  const p = decodePatch(bytesOf(name));
  const x0 = x - p.leftOffset;
  const y0 = y - p.topOffset;
  for (let c = 0; c < p.width; c += 1) {
    for (let r = 0; r < p.height; r += 1) {
      const v = p.columns[c]![r]!;
      if (v !== 0) dst[(y0 + r) * W + x0 + c] = v;
    }
  }
}

/** The fixture bytes behind a reference blit (digit by index, else by name). */
const byteStore = new Map<string, Uint8Array>();
function bytesOf(key: string): Uint8Array {
  const hit = byteStore.get(key);
  if (hit === undefined) throw new Error(`no fixture bytes for ${key}`);
  return hit;
}
function register(key: string, bytes: Uint8Array): string {
  byteStore.set(key, bytes);
  return key;
}

/** The digit sequence drawNum emits (LSB-first, truncated to `width`) —
 * recomputed independently of the module under test. */
function digitPlan(n: number, width: number): { digs: number[]; neg: boolean } {
  const neg = n < 0;
  let num = Math.abs(n);
  if (neg && width === 2 && n < -9) num = 9;
  else if (neg && width === 3 && n < -99) num = 99;
  const digs: number[] = [];
  let w = width;
  while (num && w-- > 0) {
    digs.push(num % 10);
    num = Math.floor(num / 10);
  }
  return { digs, neg };
}

const DIGIT_KEYS = Array.from({ length: 10 }, (_, d) => register(`digit${d}`, digitBytes(d)));
const MINUS_KEY = register('minus', solidBytes(8, 10, 88, 4, 0));
const PERCENT_KEY = register('percent', solidBytes(10, 10, 77));
const KEY_BYTES = Array.from({ length: 6 }, (_, i) => solidBytes(7, 5, 110 + i));
const KEY_LUMPS = KEY_BYTES.map((b, i) => decodeVPatch(b, `KEY${i}`));
const KEY_KEYS = KEY_BYTES.map((b, i) => register(`key${i}`, b));

/** Reference compose of STlib_drawNum(n) over the noise FG. */
function refNumber(x: number, y: number, n: number, width: number): Uint8Array {
  const dst = refBase();
  refErase(dst, x - width * DW, width * DW, y, DH);
  if (n === 1994) return dst;
  if (n === 0) refBlit(dst, x - DW, y, DIGIT_KEYS[0]!);
  const plan = digitPlan(n, width);
  let px = x;
  for (const d of plan.digs) {
    px -= DW;
    refBlit(dst, px, y, DIGIT_KEYS[d]!);
  }
  if (plan.neg) refBlit(dst, px - 8, y, MINUS_KEY);
  return dst;
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

let value = 0;
let enabled = true;

function mkNum(x: number, y: number, width: number): StNumber {
  const n = stNumber();
  stLibInitNum(
    n,
    x,
    y,
    digitLumps,
    () => value,
    () => enabled,
    width,
  );
  return n;
}

function reset(fg: 'noise' | 'clear' = 'noise'): Uint8Array {
  vInit();
  patternBg();
  noiseFg();
  if (fg === 'clear') vMemset(FG, 0);
  base = screens[FG]!.data.slice();
  return base;
}

beforeEach(() => {
  reset();
  value = 0;
  enabled = true;
  stLibInit(wadWithMinus());
});

/* ------------------------------------------------------------------ */
/* Struct initialisation (st_lib.c:57-70, 161-174, 192-203, 239-251)    */
/* ------------------------------------------------------------------ */

describe('widget initialisation', () => {
  it('initNum stores x/y/width, oldnum 0 and the live accessors', () => {
    value = 42;
    const n = mkNum(44, 171, 3);
    expect([n.x, n.y, n.width, n.oldnum]).toEqual([44, 171, 3, 0]);
    expect(n.num()).toBe(42);
    expect(n.on()).toBe(true);
    expect(n.p.length).toBe(10);
    expect(n.p[0]!.width).toBe(DW);
  });

  it('initNum keeps the widget LIVE: the num accessor is re-read per draw', () => {
    const n = mkNum(120, 171, 3);
    value = 5;
    stLibDrawNum(n, false);
    const want7 = refBase();
    refErase(want7, 120 - 3 * DW, 3 * DW, 171, DH);
    refBlit(want7, 120 - DW, 171, DIGIT_KEYS[7]!);
    value = 7;
    stLibDrawNum(n, false);
    expect(screens[FG]!.data).toEqual(want7);
  });

  it('initPercent forces width 3 and keeps the % glyph', () => {
    const p = stPercent();
    stLibInitPercent(p, 90, 171, digitLumps, () => value, () => enabled, percentLump);
    expect(p.n.width).toBe(3);
    expect(p.p!.name).toBe('STTPRCNT');
  });

  it('initMultIcon starts at oldinum -1 (nothing on screen yet)', () => {
    const mi = stMultIcon();
    stLibInitMultIcon(mi, 239, 171, digitLumps, () => 2, () => true);
    expect(mi.oldinum).toBe(-1);
  });

  it('initBinIcon starts at oldval 0 (C `int oldval = 0`)', () => {
    const bi = stBinIcon();
    stLibInitBinIcon(bi, 104, 168, decodeVPatch(solidBytes(6, 6, 201), 'ICON'), () => false, () => true);
    expect(bi.oldval).toBe(0);
  });

  it('stLibInit caches the STTMINUS lump (st_lib.c:49-52)', () => {
    const p = stLibTtminus();
    expect(p!.name).toBe('STTMINUS');
    expect([p!.leftOffset, p!.topOffset]).toEqual([4, 0]);
    expect(stLibTtminus()).toBe(p); // the W_CacheLumpName memoisation semantics
  });
});

/* ------------------------------------------------------------------ */
/* Number draws (st_lib.c:77-146)                                      */
/* ------------------------------------------------------------------ */

describe('drawNum (st_lib.c:77-146)', () => {
  const x = 120;
  const y = 171;

  it('0 draws a SINGLE "0" at x-w after BG-erasing the 3-digit box', () => {
    value = 0;
    const want = refNumber(x, y, 0, 3);
    stLibDrawNum(mkNum(x, y, 3), false);
    expect(screens[FG]!.data).toEqual(want);
  });

  it('1994 erases and draws NOTHING (the "n/a" skip, :120)', () => {
    value = 1994;
    const want = refNumber(x, y, 1994, 3);
    stLibDrawNum(mkNum(x, y, 3), false);
    expect(screens[FG]!.data).toEqual(want);
    // Concretely: the box is the BG pattern, and no digit fill appears.
    const bg = screens[BG]!;
    for (let r = 0; r < DH; r += 1) {
      for (let c = 0; c < 3 * DW; c += 1) {
        const got = screens[FG]!.data[(y + r) * W + x - 3 * DW + c];
        expect(got).toBe(bg.data[(y + r - ST_Y) * W + x - 3 * DW + c]);
      }
    }
  });

  it('7 draws one right-justified glyph; the freed boxes are BG', () => {
    value = 7;
    stLibDrawNum(mkNum(x, y, 3), false);
    expect(screens[FG]!.data).toEqual(refNumber(x, y, 7, 3));
  });

  it('1234 with width 3 shows 234 (LSB-first loop, digits truncated)', () => {
    value = 1234;
    stLibDrawNum(mkNum(x, y, 3), false);
    expect(digitPlan(1234, 3).digs).toEqual([4, 3, 2]);
    expect(screens[FG]!.data).toEqual(refNumber(x, y, 1234, 3));
  });

  it('-42 draws "42" plus the minus at (last digit x) − 8 (:145)', () => {
    value = -42;
    stLibDrawNum(mkNum(x, y, 3), false);
    const want = refNumber(x, y, -42, 3);
    expect(screens[FG]!.data).toEqual(want);
    // The minus's own pixels sit at (x-2w) - 8 + leftOffset columns; a minus
    // fill byte must appear there and NOWHERE at x-8 (the naive reading).
    // anchored box = (x-2w) - 8 - leftOffset .. +width  → 92..99 at x=120, w=8
    const minusCol = x - 2 * DW - 8 - 4 + 3;
    expect(want[y * W + minusCol]).toBe(88);
    // …and the naive reading (a minus anchored at x-8) is NOT what got drawn
    expect(want[y * W + (x - 8 - 4 + 3)]).not.toBe(88);
  });

  it('width-2 clamps −123 to −9 before drawing (:101-104)', () => {
    value = -123;
    stLibDrawNum(mkNum(x, y, 2), false);
    expect(screens[FG]!.data).toEqual(refNumber(x, y, -9, 2));
  });

  it('width-3 clamps −1234 to −99 (:101-104)', () => {
    value = -1234;
    stLibDrawNum(mkNum(x, y, 3), false);
    expect(screens[FG]!.data).toEqual(refNumber(x, y, -99, 3));
  });

  it('refresh is IGNORED by drawNum (vanilla never reads the argument)', () => {
    value = 906;
    stLibDrawNum(mkNum(x, y, 3), false);
    const a = screens[FG]!.data.slice();
    reset();
    value = 906;
    stLibDrawNum(mkNum(x, y, 3), true);
    expect(a).toEqual(refNumber(x, y, 906, 3));
    expect(screens[FG]!.data).toEqual(a);
  });

  it('updateNum respects the `on` flag (st_lib.c:152-156)', () => {
    value = 5150;
    enabled = false;
    const before = screens[FG]!.data.slice();
    stLibUpdateNum(mkNum(x, y, 3), false);
    expect(screens[FG]!.data).toEqual(before);
    enabled = true;
    stLibUpdateNum(mkNum(x, y, 3), false);
    expect(screens[FG]!.data).toEqual(refNumber(x, y, 5150, 3));
  });

  it('a widget above the bar throws instead of wrapping (:112-114)', () => {
    value = 5;
    expect(() => stLibDrawNum(mkNum(x, ST_Y - 1, 3), false)).toThrow(StLibError);
  });

  it('oldnum mirrors the value but never gates the draw', () => {
    value = 111;
    const n = mkNum(x, y, 3);
    stLibDrawNum(n, false);
    expect(n.oldnum).toBe(111);
    const want = screens[FG]!.data.slice();
    stLibDrawNum(n, false); // same value: vanilla redraws identically
    expect(screens[FG]!.data).toEqual(want);
  });
});

/* ------------------------------------------------------------------ */
/* Percent widget (st_lib.c:161-187)                                   */
/* ------------------------------------------------------------------ */

describe('updatePercent (st_lib.c:161-187)', () => {
  const x = 90;
  const y = 171;

  it('refresh=false draws the digits and NO percent sign', () => {
    value = 76;
    const p = stPercent();
    stLibInitPercent(p, x, y, digitLumps, () => value, () => enabled, percentLump);
    stLibUpdatePercent(p, false);
    expect(screens[FG]!.data).toEqual(refNumber(x, y, 76, 3));
  });

  it('refresh=true draws the % FIRST at (n.x, n.y), then the digits', () => {
    value = 76;
    const p = stPercent();
    stLibInitPercent(p, x, y, digitLumps, () => value, () => enabled, percentLump);
    stLibUpdatePercent(p, true);
    const want = refNumber(x, y, 76, 3); // digits last — they never overlap
    refBlit(want, x, y, PERCENT_KEY); // the sign lives to the RIGHT of x
    expect(screens[FG]!.data).toEqual(want);
  });

  it('a disabled widget draws neither sign nor digits', () => {
    value = 100;
    enabled = false;
    const p = stPercent();
    stLibInitPercent(p, 221, 171, digitLumps, () => value, () => enabled, percentLump);
    const before = screens[FG]!.data.slice();
    stLibUpdatePercent(p, true);
    expect(screens[FG]!.data).toEqual(before);
  });
});

/* ------------------------------------------------------------------ */
/* Multicon widget (st_lib.c:208-234)                                  */
/* ------------------------------------------------------------------ */

describe('updateMultIcon (st_lib.c:208-234)', () => {
  let index = -1;

  const mk = (): StMultIcon => {
    const mi = stMultIcon();
    stLibInitMultIcon(mi, 239, 171, KEY_LUMPS, () => index, () => true);
    return mi;
  };

  it('index -1 draws nothing and leaves oldinum at -1', () => {
    index = -1;
    const mi = mk();
    const before = screens[FG]!.data.slice();
    stLibUpdateMultIcon(mi, false);
    expect(screens[FG]!.data).toEqual(before);
    expect(mi.oldinum).toBe(-1);
  });

  it('the FIRST draw paints without erasing (oldinum was -1)', () => {
    index = 4;
    const mi = mk();
    stLibUpdateMultIcon(mi, false);
    const want = refBase();
    refBlit(want, 239, 171, KEY_KEYS[4]!);
    expect(screens[FG]!.data).toEqual(want);
    expect(mi.oldinum).toBe(4);
  });

  it('an index change erases the OLD icon box from BG, then draws the new', () => {
    const mi = mk();
    index = 1;
    stLibUpdateMultIcon(mi, false);
    index = 4;
    stLibUpdateMultIcon(mi, false);
    // The erase restores BG exactly under the old box, so the net effect over
    // a clean FG is: BG-erase the box + draw the new icon.
    const want = refBase();
    refErase(want, 239, 7, 171, 5);
    refBlit(want, 239, 171, KEY_KEYS[4]!);
    expect(screens[FG]!.data).toEqual(want);
    expect(mi.oldinum).toBe(4);
  });

  it('refresh with an UNCHANGED index redraws the same icon', () => {
    index = 3;
    const mi = mk();
    stLibUpdateMultIcon(mi, false);
    vMemset(FG, 12);
    base = new Uint8Array(W * 200).fill(12);
    stLibUpdateMultIcon(mi, true);
    const want = base.slice();
    refBlit(want, 239, 171, KEY_KEYS[3]!);
    expect(screens[FG]!.data).toEqual(want);
  });

  it('the erase box uses the OLD patch geometry (left/top offsets)', () => {
    const aBytes = solidBytes(6, 6, 201, 3, 2);
    const bBytes = solidBytes(9, 4, 202, 1, 1);
    const ka = register('off-a', aBytes);
    const kb = register('off-b', bBytes);
    let idx = 0;
    const mi = stMultIcon();
    stLibInitMultIcon(mi, 250, 178, [decodeVPatch(aBytes, 'A'), decodeVPatch(bBytes, 'B')], () => idx, () => true);
    stLibUpdateMultIcon(mi, false); // draws A at its anchor
    idx = 1;
    stLibUpdateMultIcon(mi, false); // erases A's ANCHORED box, draws B
    const want = refBase();
    refBlit(want, 250, 178, ka);
    refErase(want, 250 - 3, 6, 178 - 2, 6);
    refBlit(want, 250, 178, kb);
    expect(screens[FG]!.data).toEqual(want);
  });

  it('a multicon above the bar throws on the erase path', () => {
    let idx = 0;
    const mi = stMultIcon();
    const patches = [decodeVPatch(solidBytes(6, 6, 201), 'A'), decodeVPatch(solidBytes(6, 6, 202), 'B')];
    stLibInitMultIcon(mi, 250, ST_Y - 1, patches, () => idx, () => true);
    stLibUpdateMultIcon(mi, false); // first draw: no erase ⇒ no throw
    idx = 1;
    expect(() => stLibUpdateMultIcon(mi, false)).toThrow(StLibError);
  });
});

/* ------------------------------------------------------------------ */
/* Binicon widget (st_lib.c:256-292)                                   */
/* ------------------------------------------------------------------ */

describe('updateBinIcon (st_lib.c:256-292)', () => {
  const armsBytes = solidBytes(38, 32, 33);
  const arms = decodeVPatch(armsBytes, 'STARMS');
  const armsKey = register('arms', armsBytes);
  let val = false;

  const mk = (): StBinIcon => {
    const bi = stBinIcon();
    stLibInitBinIcon(bi, 104, 168, arms, () => val, () => true);
    return bi;
  };

  it('false→true draws the icon', () => {
    val = true;
    const bi = mk();
    stLibUpdateBinIcon(bi, false);
    expect(bi.oldval).toBe(1);
    const want = refBase();
    refBlit(want, 104, 168, armsKey);
    expect(screens[FG]!.data).toEqual(want);
  });

  it('true→false BG-erases the anchored box', () => {
    val = true;
    const bi = mk();
    stLibUpdateBinIcon(bi, false);
    val = false;
    stLibUpdateBinIcon(bi, false);
    expect(bi.oldval).toBe(0);
    const want = refBase();
    refErase(want, 104, 38, 168, 32);
    expect(screens[FG]!.data).toEqual(want);
  });

  it('an unchanged value without refresh touches nothing', () => {
    val = true;
    const bi = mk();
    stLibUpdateBinIcon(bi, false);
    vMemset(FG, 9);
    stLibUpdateBinIcon(bi, false);
    expect(screens[FG]!.data).toEqual(new Uint8Array(W * 200).fill(9));
  });

  it('refresh forces the redraw even with the same value', () => {
    val = false;
    const bi = mk();
    vMemset(FG, 9);
    base = new Uint8Array(W * 200).fill(9);
    stLibUpdateBinIcon(bi, true);
    const want = base.slice();
    refErase(want, 104, 38, 168, 32);
    expect(screens[FG]!.data).toEqual(want);
  });

  it('a binicon above the bar throws (:277-279)', () => {
    val = true;
    const bi = stBinIcon();
    stLibInitBinIcon(bi, 104, ST_Y - 1, arms, () => val, () => true);
    expect(() => stLibUpdateBinIcon(bi, false)).toThrow(StLibError);
  });
});

/* ------------------------------------------------------------------ */
/* Fixture/geometry sanity                                             */
/* ------------------------------------------------------------------ */

describe('geometry', () => {
  it('ST_Y is row 168 and screens[4] is the 320x32 band', () => {
    expect(ST_Y).toBe(168);
    expect([screens[BG]!.width, screens[BG]!.height]).toEqual([ST_WIDTH, ST_HEIGHT]);
  });
});
