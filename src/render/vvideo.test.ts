/**
 * Tests for the v_video.c primitives — M9-01 (plan §M9-01 acceptance
 * 2/3/4 + the layer/cache plumbing).
 *
 * Acceptance 2 (parity): synthetic patch fixtures built with the PURE
 * patch.ts encoder are blitted through vDrawPatch and compared BYTE-EXACT
 * against a reference composed from patch.ts's DecodedPatch columns,
 * including the leftoffset/topoffset anchor math (v_video.c:220-221).
 * Acceptance 3: vCopyRect BG→FG erase roundtrips the canvas exactly.
 * Acceptance 4: OOB draws warn-and-ignore (counted), never throw.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildPatchFromColumns, decodePatch } from '../wad/patch';
import { PatchPostError } from '../wad/patch';
import { WadFile } from '../wad/wadfile';
import {
  BG,
  FG,
  NUMSCREENS,
  SCREENHEIGHT,
  SCREENWIDTH,
  ST_HEIGHT,
  decodeVPatch,
  dirtyBox,
  lumpPatch,
  lumpPatchStats,
  screens,
  vClearBox,
  vCopyRect,
  vDrawPatch,
  vDrawPatchDirect,
  vDrawPatchFlipped,
  vInit,
  vMarkRect,
  vMemset,
  vVideoStats,
} from './vvideo';

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

/** Deterministic PRNG (xorshift32), same idiom as patch.test.ts. */
function prng(seed: number): () => number {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

/** Layer fill with structured noise so any untouched pixel is detectable. */
function noiseLayer(width: number, height: number, seed: number): Uint8Array {
  const rnd = prng(seed);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < out.length; i += 1) out[i] = 1 + Math.floor(rnd() * 255);
  return out;
}

function rectRegion(layer: Uint8Array, x: number, y: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let r = 0; r < h; r += 1) out.set(layer.subarray((y + r) * SCREENWIDTH + x, (y + r) * SCREENWIDTH + x + w), r * w);
  return out;
}

/** Reference composite from DecodedPatch columns ("0 = transparent", the
 * encoder never emits literal-0 posts for sub-254 fixtures): mirrors the
 * anchored post walk WITHOUT the raw-lump overwrite semantics. */
function referenceComposite(
  dest: Uint8Array,
  x: number,
  y: number,
  patch: ReturnType<typeof decodePatch>,
  mirror = false,
): void {
  const x0 = x - patch.leftOffset;
  const y0 = y - patch.topOffset;
  for (let c = 0; c < patch.width; c += 1) {
    const col = patch.columns[mirror ? patch.width - 1 - c : c]!;
    for (let r = 0; r < patch.height; r += 1) {
      const v = col[r]!;
      if (v !== 0) dest[(y0 + r) * SCREENWIDTH + x0 + c] = v;
    }
  }
}

/** A random medium patch fixture (height < 254 so the encoder emits single
 * posts per run — see the parity caveats in patch.ts's encoder docs). */
function fixturePatch(seed: number, width: number, height: number, leftOffset: number, topOffset: number): Uint8Array {
  const rnd = prng(seed);
  const cols: number[][] = [];
  for (let c = 0; c < width; c += 1) {
    const col: number[] = [];
    for (let r = 0; r < height; r += 1) col.push(rnd() < 0.55 ? 1 + Math.floor(rnd() * 255) : 0);
    cols.push(col);
  }
  return buildPatchFromColumns(cols, leftOffset, topOffset);
}

/* ------------------------------------------------------------------ */

beforeEach(() => {
  vInit();
  vClearBox();
});

describe('screens model (V_Init + ST_Init)', () => {
  it('allocates screens[0..3] 320x200 and screens[4] 320x32 (BG)', () => {
    expect(screens.length).toBe(NUMSCREENS);
    for (let i = 0; i < 4; i += 1) {
      expect(screens[i]!.width).toBe(SCREENWIDTH);
      expect(screens[i]!.height).toBe(SCREENHEIGHT);
    }
    expect(screens[BG]!.width).toBe(SCREENWIDTH);
    expect(screens[BG]!.height).toBe(ST_HEIGHT);
  });

  it('vInit(fb.indices) ALIASES the caller buffer (presentation seam)', () => {
    const indices = new Uint8Array(SCREENWIDTH * SCREENHEIGHT).fill(3);
    vInit(indices);
    expect(screens[FG]!.data).toBe(indices);
    vDrawPatch(160, 8, FG, decodeVPatch(fixturePatch(11, 20, 16, 10, 8), 'X'));
    expect(indices.some((v) => v !== 3)).toBe(true);
  });

  it('vInit rejects a wrong-size fg buffer', () => {
    expect(() => vInit(new Uint8Array(42))).toThrow(RangeError);
  });
});

describe('vMarkRect / dirtybox', () => {
  it('grows the box via M_AddToBox to (x,y)..(x+w-1,y+h-1)', () => {
    vClearBox();
    vMarkRect(10, 20, 5, 5);
    expect(dirtyBox[0]).toBe(10); // LEFT
    expect(dirtyBox[1]).toBe(14); // RIGHT
    expect(dirtyBox[2]).toBe(20); // BOTTOM
    expect(dirtyBox[3]).toBe(24); // TOP
    vMarkRect(2, 30, 1, 1);
    expect(dirtyBox[0]).toBe(2);
    expect(dirtyBox[3]).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 2: blit parity vs the patch.ts reference decode           */
/* ------------------------------------------------------------------ */

describe('vDrawPatch parity vs patch.ts decode (acceptance 2)', () => {
  const cases = [
    { seed: 0x51, x: 100, y: 40, w: 24, h: 17, lo: 12, to: 17 },
    { seed: 0x77b, x: 160, y: 100, w: 41, h: 56, lo: 20, to: 30 }, // anchored off-center
    { seed: 0xbeef, x: 250, y: 190, w: 30, h: 12, lo: 15, to: 12 }, // near the SE corner
  ];
  for (const c of cases) {
    it(`byte-exact at ${c.x},${c.y} (anchor lo=${c.lo} to=${c.to})`, () => {
      const bytes = fixturePatch(c.seed, c.w, c.h, c.lo, c.to);
      const reference = decodePatch(bytes);
      const want = noiseLayer(SCREENWIDTH, SCREENHEIGHT, 7);
      referenceComposite(want, c.x, c.y, reference);

      vInit(want);
      vDrawPatch(c.x, c.y, FG, decodeVPatch(bytes, 'FIX'));
      expect(screens[FG]!.data).toEqual(want);

      // Header decode agreement (patch.ts vs decodeVPatch)
      const vp = decodeVPatch(bytes, 'FIX');
      expect([vp.width, vp.height, vp.leftOffset, vp.topOffset]).toEqual([
        reference.width,
        reference.height,
        reference.leftOffset,
        reference.topOffset,
      ]);
      expect(vp.columnofs.length).toBe(reference.width);
    });
  }

  it('Flipped mirrors the columns (V_DrawPatchFlipped)', () => {
    const bytes = fixturePatch(0x1234, 33, 21, 8, 21);
    const reference = decodePatch(bytes);
    const want = noiseLayer(SCREENWIDTH, SCREENHEIGHT, 9);
    referenceComposite(want, 150, 90, reference, true);
    vInit(want);
    vDrawPatchFlipped(150, 90, FG, decodeVPatch(bytes, 'FLIP'));
    expect(screens[FG]!.data).toEqual(want);
  });

  it('Direct paints the same pixels but skips V_MarkRect', () => {
    const bytes = fixturePatch(0x2345, 28, 14, 14, 14);
    const want = noiseLayer(SCREENWIDTH, SCREENHEIGHT, 13);
    referenceComposite(want, 120, 60, decodePatch(bytes));
    vInit(want);
    vDrawPatchDirect(120, 60, FG, decodeVPatch(bytes, 'DIR'));
    expect(screens[FG]!.data).toEqual(want);
    expect(vVideoStats.markRectCalls).toBe(0); // plan §M9-01 "no MarkRect"
    vDrawPatch(120, 60, FG, decodeVPatch(bytes, 'DIR'));
    expect(vVideoStats.markRectCalls).toBe(1);
  });

  it('draws only to screens[scrn]; BG never marks', () => {
    const bytes = fixturePatch(0x34, 16, 10, 8, 10);
    const fg = noiseLayer(SCREENWIDTH, SCREENHEIGHT, 21);
    const fgCopy = fg.slice();
    vInit(fg);
    vDrawPatch(8, 10, BG, decodeVPatch(bytes, 'B'));
    expect(screens[FG]!.data).toEqual(fgCopy); // FG untouched
    expect(vVideoStats.markRectCalls).toBe(0); // vanilla: `if (!scrn)`
    expect(some(screens[BG]!.data, (v) => v !== 0)).toBe(true);
  });

  it('post pixels are written VERBATIM (literal 0 overwrites, not transparency)', () => {
    // Hand-built 1x2 patch: one post [5, 0] at topdelta 0 — vanilla writes
    // the 0 byte too; the DecodedPatch model could not express this.
    const bytes = new Uint8Array([
      1, 0, 2, 0, 0, 0, 0, 0, // w=1 h=2 lo=0 to=0
      12, 0, 0, 0, // columnofs[0] = 12
      0, 2, 0, 5, 0, // post: top 0, len 2, slack, pixels 5,0
      0, // trailing slack (next post at +length+4)
      0xff, 0, // terminator
    ]);
    vMemset(FG, 77);
    vDrawPatch(3, 4, FG, decodeVPatch(bytes, 'LIT0'));
    expect(screens[FG]!.data[4 * SCREENWIDTH + 3]).toBe(5);
    expect(screens[FG]!.data[5 * SCREENWIDTH + 3]).toBe(0); // 77 OVERWRITTEN
  });

  it('malformed post stream (run past lump end) throws PatchPostError', () => {
    const bytes = new Uint8Array([
      1, 0, 1, 0, 0, 0, 0, 0,
      12, 0, 0, 0,
      0, 200, 0, 1, 2, // post claims 200 px, only 2 remain
    ]);
    expect(() => vDrawPatch(0, 0, FG, decodeVPatch(bytes, 'BAD'))).toThrow(PatchPostError);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 4: RANGECHECK warn-and-ignore, counted                    */
/* ------------------------------------------------------------------ */

describe('range checks (acceptance 4)', () => {
  it('OOB patch draws: no throw, no pixels, no mark, warning counted', () => {
    const bytes = fixturePatch(0x42, 32, 32, 16, 32);
    const before = screens[FG]!.data.slice();
    const m0 = vVideoStats.markRectCalls;
    const i0 = vVideoStats.rangeCheckIgnored;
    vDrawPatch(-1, 100, FG, decodeVPatch(bytes, 'L')); // x<0 after anchor
    vDrawPatch(310, 100, FG, decodeVPatch(bytes, 'R')); // x+w>320
    vDrawPatch(160, 210, FG, decodeVPatch(bytes, 'D')); // y+h>200
    vDrawPatch(160, 0, 42, decodeVPatch(bytes, 'S')); // scrn>4
    vDrawPatch(160, 0, -1, decodeVPatch(bytes, 'S'));
    expect(vVideoStats.rangeCheckIgnored).toBe(i0 + 5);
    expect(screens[FG]!.data).toEqual(before);
    expect(vVideoStats.markRectCalls).toBe(m0);
  });

  it('BG draws taller than 32 rows are ignored (screens[4] overflow guard)', () => {
    const bytes = fixturePatch(0x43, 8, 40, 4, 40);
    const i0 = vVideoStats.rangeCheckIgnored;
    vDrawPatch(0, 40, BG, decodeVPatch(bytes, 'TALL')); // y0=0, 0+40 > 32
    expect(vVideoStats.rangeCheckIgnored).toBe(i0 + 1);
    expect(some(screens[BG]!.data, (v) => v !== 0)).toBe(false);
  });

  it('vCopyRect OOB is fatal (vanilla I_Error), not silent', () => {
    expect(() => vCopyRect(0, 0, FG, 320, 32, 0, 175, FG)).toThrow(/Bad V_CopyRect/);
    expect(() => vCopyRect(0, 0, FG, 320, 32, 0, 0, 9)).toThrow(/Bad V_CopyRect/);
  });
});

/* ------------------------------------------------------------------ */
/* Acceptance 3: vCopyRect BG→FG erase roundtrip                        */
/* ------------------------------------------------------------------ */

describe('vCopyRect (v_video.c:158-192)', () => {
  it('BG→FG widget erase restores the background EXACTLY (roundtrip)', () => {
    // Compose the bar background into BG exactly like ST_refreshBackground
    // (st_stuff.c:499-514): flood + a patch, then BG→FG at (0,168).
    const bar = fixturePatch(0x55, 48, 32, 0, 32);
    screens[BG]!.data.fill(66);
    vDrawPatch(200, 32, BG, decodeVPatch(bar, 'BAR'));
    vCopyRect(0, 0, BG, SCREENWIDTH, ST_HEIGHT, 0, SCREENHEIGHT - ST_HEIGHT, FG);
    const clean = rectRegion(screens[FG]!.data, 0, 168, SCREENWIDTH, ST_HEIGHT);

    // Scribble widgets over the bar area of FG...
    screens[FG]!.data.set(noiseLayer(SCREENWIDTH, ST_HEIGHT, 0x99), 168 * SCREENWIDTH);
    vDrawPatch(10, 200, FG, decodeVPatch(fixturePatch(0x56, 16, 32, 8, 32), 'W'));
    // ...and erase with the vanilla primitive.
    vCopyRect(0, 0, BG, SCREENWIDTH, ST_HEIGHT, 0, SCREENHEIGHT - ST_HEIGHT, FG);
    expect(rectRegion(screens[FG]!.data, 0, 168, SCREENWIDTH, ST_HEIGHT)).toEqual(clean);
  });

  it('copies between any layers incl. FG→FG shift, marks destination', () => {
    vMemset(FG, 0);
    screens[FG]!.data.set(noiseLayer(64, 32, 0x777), 0); // noise block top-left
    const m0 = vVideoStats.markRectCalls;
    vCopyRect(0, 0, FG, 64, 32, 100, 50, FG);
    expect(rectRegion(screens[FG]!.data, 100, 50, 64, 32)).toEqual(rectRegion(screens[FG]!.data, 0, 0, 64, 32));
    expect(vVideoStats.markRectCalls).toBe(m0 + 1);
  });
});

/* ------------------------------------------------------------------ */
/* lumpPatch cache + decodeVPatch header errors                        */
/* ------------------------------------------------------------------ */

describe('decodeVPatch errors', () => {
  it('rejects truncated headers and wild columnofs', () => {
    expect(() => decodeVPatch(new Uint8Array(4))).toThrow(/header truncated/);
    expect(() => decodeVPatch(new Uint8Array([0xff, 0xff, 1, 0, 0, 0, 0, 0]))).toThrow(/impossible dimensions/);
    expect(() => decodeVPatch(new Uint8Array([1, 0, 1, 0, 0, 0, 0, 0, 200, 0, 0, 0]))).toThrow(/offset .* out of bounds/);
  });
});

const WAD_PATH = process.env.FREEDOOM1_WAD ?? fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('lumpPatch on freedoom1.wad', () => {
  const wad: WadFile | null = hasWad ? WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer) : null;

  it('caches per name (decode once, case-insensitive, same object)', () => {
    const d0 = lumpPatchStats.decodes;
    const h0 = lumpPatchStats.hits;
    const p1 = lumpPatch(wad!, 'STBAR');
    const p2 = lumpPatch(wad!, 'stbar');
    expect(p1).toBe(p2);
    expect(lumpPatchStats.decodes).toBe(d0 + 1);
    expect(lumpPatchStats.hits).toBe(h0 + 1);
    expect(p1.name).toBe('STBAR');
    expect(p1.width).toBe(320); // STBAR spans the bar (st_stuff.h ST_WIDTH)
    expect(p1.height).toBe(32);
  });

  it('a real bar blit is byte-identical to the patch.ts column model modulo literal-0 posts (spot: STARMS)', () => {
    // Cross-module agreement spot: decodeVPatch header == decodePatch header.
    const vp = lumpPatch(wad!, 'STARMS');
    const dp = decodePatch(wad!.readLumpByName('STARMS'));
    expect([vp.width, vp.height, vp.leftOffset, vp.topOffset]).toEqual([dp.width, dp.height, dp.leftOffset, dp.topOffset]);
    expect(createHash('sha256').update(vp.bytes).digest('hex')).toBe(
      createHash('sha256').update(wad!.readLumpByName('STARMS')).digest('hex'),
    );
  });
});

function some(buf: Uint8Array, pred: (v: number, i: number) => boolean): boolean {
  for (let i = 0; i < buf.length; i += 1) if (pred(buf[i]!, i)) return true;
  return false;
}
