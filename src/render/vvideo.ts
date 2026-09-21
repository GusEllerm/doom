// render/vvideo.ts — v_video.c primitives (M9-01, docs/design/M9-plan.md
// §M9-01 + §0.11): the screens[] model, V_DrawPatch (+ Flipped/Direct),
// V_CopyRect, V_MarkRect and the lumpPatch named-lump decode cache.
//
// Screen array model (§0.11 "explicit fields vs faithful screens[]"): we
// mirror vanilla FAITHFULLY as a length-5 array indexed by `scrn`:
//   screens[0..3] — V_Init (v_video.c:482-493): four 320x200 buffers;
//       [0] = FG (the framebuffer presented by the M2 blit layer),
//       [1]   = R_FillBackScreen back buffer (r_draw.c:731, M9-09),
//       [2..3] wipe stages (f_wipe.c, M9-13).
//   screens[4] — BG (st_lib.h:33 `#define BG 4`), ST_Init (st_stuff.c:1470):
//       320x32 (ST_WIDTH x ST_HEIGHT, st_stuff.h:32-34), the statusbar
//       canvas that V_CopyRect(BG→FG) erases widgets against.
// So `vDrawPatch(x, y, scrn, patch)` keeps vanilla's exact signature.
//
// Integration shape (FINDING): the presentation layer
// (render/framebuffer.ts Framebuffer + blitToCanvas) reads
// `fb.indices` — a 320x200 row-major Uint8Array of PALETTE INDICES, the
// identical pixel model used here. No adapter is needed: `vInit(fb.indices)`
// makes screens[0] ALIAS the Framebuffer's index buffer, so whoever owns
// the Framebuffer keeps presenting untouched (wiring is M9-09's job; this
// module must not touch renderer.ts/view.ts).
//
// Header decode vs M1-06's src/wad/patch.ts: the patch_t layout is the same
// struct (r_defs.h:356-364) and patch.ts's LE field readers are REUSED
// (same error classes + post-walk constants). patch.ts's DecodedPatch
// (columns[], "0 = transparent") cannot drive V_DrawPatch VERBATIM: vanilla
// walks the raw post stream (r_defs.h:285-292) and writes EVERY post byte
// INCLUDING literal 0 pixels, which overwrite the destination. So the
// cache hands out a `VPatch` holding the raw lump bytes (the
// W_CacheLumpName pointer equivalent) and the blitters walk posts
// directly; DecodedPatch stays for pixel-semantics consumers (parity test,
// lump audit in patches2.test.ts).
//
// RANGECHECK policy (plan §M9-01): vanilla's V_DrawPatch range guard
// (:222-233) warns to stderr and RETURNS (no I_Error — "what is up with
// TNT.WAD?"). We keep it ALWAYS ON (no build-time #ifdef in TS) and count
// each ignore in `vVideoStats.rangeCheckIgnored` instead of fprintf.
// V_DrawPatchFlipped shares the behaviour (vanilla :296 I_Errors under
// RANGECHECK; a throw in a UI draw call would abort the frame for a pixel
// glitch, so we degrade like V_DrawPatch — documented deviation).
// V_CopyRect keeps vanilla's fatal `I_Error("Bad V_CopyRect")` (:177-187)
// as a thrown VCopyRectError — call sites pass compile-time widget rects.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { PatchColumnOffsetError, PatchHeaderError, PatchPostError, POST_DATA_OFFSET, POST_TERMINATOR, POST_STRIDE_EXTRA } from '../wad/patch';
import type { WadFile } from '../wad/wadfile';
import { RENDER_HEIGHT, RENDER_WIDTH } from './framebuffer';

/* ------------------------------------------------------------------ */
/* Constants (doomdef.h:110-112, st_lib.h:33-34, st_stuff.h:32-34)     */
/* ------------------------------------------------------------------ */

/** Vanilla SCREENWIDTH (doomdef.h:110) — same value as RENDER_WIDTH. */
export const SCREENWIDTH = RENDER_WIDTH; // 320
/** Vanilla SCREENHEIGHT (doomdef.h:111) — same value as RENDER_HEIGHT. */
export const SCREENHEIGHT = RENDER_HEIGHT; // 200

/** `#define FG 0` — screens[0], the presented buffer (st_lib.h:34). */
export const FG = 0;
/** `#define BG 4` — screens[4], the 320x32 statusbar canvas (st_lib.h:33). */
export const BG = 4;
/** screens[] length — v_video.c:44 `byte* screens[5]` (scrn is range-checked `< 5`). */
export const NUMSCREENS = 5;

/** ST_HEIGHT = 32*SCREEN_MUL (st_stuff.h:32, SCREEN_MUL=1) — screens[4] rows. */
export const ST_HEIGHT = 32;
/** ST_WIDTH = SCREENWIDTH (st_stuff.h:33). */
export const ST_WIDTH = SCREENWIDTH;

/* ------------------------------------------------------------------ */
/* Layers (the vanilla `byte* screens[i]` + V_Init/ST_Init sizing)      */
/* ------------------------------------------------------------------ */

/** One indexed-pixel screen layer; row-major, stride = `width` (320). */
export interface VLayer {
  readonly width: number;
  readonly height: number;
  /** Palette indices; ALIASES the caller's array when one was supplied. */
  readonly data: Uint8Array;
}

function makeLayer(width: number, height: number, data?: Uint8Array): VLayer {
  if (data !== undefined && data.length !== width * height) {
    throw new RangeError(`vInit: buffer of ${data.length} bytes != ${width}x${height}`);
  }
  return { width, height, data: data ?? new Uint8Array(width * height) };
}

/**
 * The screens[] array (v_video.c:44). Entries exist after {@link vInit};
 * `screens[FG].data` is the same Uint8Array the Framebuffer presents when
 * vInit was given `fb.indices` (indexing matches vanilla's `(unsigned)scrn>4`
 * guard: valid scrn ∈ [0, 5)).
 */
export const screens: (VLayer | null)[] = new Array<VLayer | null>(NUMSCREENS).fill(null);

/**
 * V_Init (v_video.c:482-493) + ST_Init's `screens[4]` allocation
 * (st_stuff.c:1470): four 320x200 layers + the 320x32 BG statusbar canvas.
 * Pass `fgIndices` (e.g. ` framebuffer.indices`) to make screens[0] alias
 * an existing indexed framebuffer instead of allocating (integration seam,
 * see header FINDING). Also resets counters and the dirtybox.
 */
export function vInit(fgIndices?: Uint8Array): void {
  screens[0] = makeLayer(SCREENWIDTH, SCREENHEIGHT, fgIndices);
  screens[1] = makeLayer(SCREENWIDTH, SCREENHEIGHT); // R_FillBackScreen back buffer
  screens[2] = makeLayer(SCREENWIDTH, SCREENHEIGHT); // wipe stage
  screens[3] = makeLayer(SCREENWIDTH, SCREENHEIGHT); // wipe stage
  screens[4] = makeLayer(ST_WIDTH, ST_HEIGHT); // BG — ST_Init
  vClearBox();
  vVideoStats.rangeCheckIgnored = 0;
  vVideoStats.markRectCalls = 0;
}

/* ------------------------------------------------------------------ */
/* Counters (stderr-free evidence for the warn-and-ignore paths)        */
/* ------------------------------------------------------------------ */

export const vVideoStats = {
  /** Times a range-guarded draw/copy was ignored (vanilla fprintf pair). */
  rangeCheckIgnored: 0,
  /** V_MarkRect calls (m_bbox dirtybox updates). */
  markRectCalls: 0,
};

/* ------------------------------------------------------------------ */
/* V_MarkRect / dirtybox (v_video.c:143-155, m_bbox.c)                  */
/* ------------------------------------------------------------------ */

/**
 * Vanilla `dirtybox` (v_video.c:46) kept with M_ClearBox/M_AddToBox
 * semantics in integer pixel units: [LEFT, RIGHT, BOTTOM, TOP] (m_bbox.h
 * layout, fixed units divided away). NO-OP SEMANTICS for us: the automap
 * (render/automap.ts) redraws fully every frame, so nothing consumes the
 * box — it is maintained + exposed for parity/debug only (plan: "no-op-or-
 * AM" — AM-recompute side effect intentionally NOT wired).
 */
export const dirtyBox = [Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER];

/** M_ClearBox (m_bbox.c:36-40). */
export function vClearBox(): void {
  dirtyBox[0] = Number.MAX_SAFE_INTEGER;
  dirtyBox[1] = Number.MIN_SAFE_INTEGER;
  dirtyBox[2] = Number.MAX_SAFE_INTEGER;
  dirtyBox[3] = Number.MIN_SAFE_INTEGER;
}

/**
 * V_MarkRect (v_video.c:143-155): grow the dirtybox to (x,y) and
 * (x+width-1, y+height-1) via M_AddToBox. Zero drawing cost.
 */
export function vMarkRect(x: number, y: number, width: number, height: number): void {
  vVideoStats.markRectCalls += 1;
  addToBox(x, y);
  addToBox(x + width - 1, y + height - 1);
}

function addToBox(x: number, y: number): void {
  if (x < dirtyBox[0]!) dirtyBox[0] = x;
  else if (x > dirtyBox[1]!) dirtyBox[1] = x;
  if (y < dirtyBox[2]!) dirtyBox[2] = y;
  else if (y > dirtyBox[3]!) dirtyBox[3] = y;
}

/* ------------------------------------------------------------------ */
/* VPatch — the W_CacheLumpName'd patch_t pointer                       */
/* ------------------------------------------------------------------ */

/**
 * A cached patch lump: raw bytes (header + columnofs + post streams, read
 * in place exactly like the C blitters do) plus the parsed header so the
 * blit never re-reads it. `columnofs` entries are absolute byte offsets
 * into `bytes` (they already are, in the lump format — r_data.c caches the
 * lump unmolested and the blitters add them to the patch pointer).
 */
export interface VPatch {
  /** Lump name ('' for anonymous fixtures). */
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly leftOffset: number;
  readonly topOffset: number;
  /** Full lump bytes (header + posts). */
  readonly bytes: Uint8Array;
  /** Post-area entry points, length = width. */
  readonly columnofs: readonly number[];
}

/**
 * Header decode + columnofs sanity — the same reads, bounds and typed
 * errors as src/wad/patch.ts (patch.ts walks posts into columns; this does
 * NOT, keeping the raw post stream for the verbatim blit; the two agree on
 * every header field, pinned by the parity test in vvideo.test.ts).
 * Throws PatchHeaderError / PatchColumnOffsetError.
 */
export function decodeVPatch(bytes: Uint8Array, name = ''): VPatch {
  const len = bytes.length;
  if (len < 8) {
    throw new PatchHeaderError(`patch header truncated: ${len} bytes < 8`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getInt16(0, true);
  const height = view.getInt16(2, true);
  const leftOffset = view.getInt16(4, true);
  const topOffset = view.getInt16(6, true);
  if (width < 0 || height < 0) {
    throw new PatchHeaderError(`patch header impossible dimensions: width=${width} height=${height}`);
  }
  if (len < 8 + width * 4) {
    throw new PatchHeaderError(
      `columnofs table truncated: ${len} bytes < ${8 + width * 4} (width=${width})`,
    );
  }
  const columnofs: number[] = [];
  for (let c = 0; c < width; c += 1) {
    const ofs = view.getUint32(8 + c * 4, true);
    if (ofs < 8 || ofs >= len) {
      throw new PatchColumnOffsetError(
        `column ${c} offset ${ofs} out of bounds (lump length ${len})`,
      );
    }
    columnofs.push(ofs);
  }
  return { name, width, height, leftOffset, topOffset, bytes, columnofs };
}

/* ------------------------------------------------------------------ */
/* lumpPatch — named-lump decode cache (PU_STATIC equivalent)           */
/* ------------------------------------------------------------------ */

const patchCache = new WeakMap<WadFile, Map<string, VPatch>>();

/** Cache-hit counter for {@link lumpPatch} (tests assert decode-once). */
export const lumpPatchStats = { hits: 0, decodes: 0 };

/**
 * W_CacheLumpName("NAME") + header decode, memoised per WadFile
 * (PU_STATIC, no eviction needed at 320x200 — plan §M9-01). Throws like
 * {@link decodeVPatch}; unknown lump name throws RangeError (WadFile).
 */
export function lumpPatch(wad: WadFile, name: string): VPatch {
  let byName = patchCache.get(wad);
  if (byName === undefined) {
    byName = new Map();
    patchCache.set(wad, byName);
  }
  const key = name.toUpperCase();
  const hit = byName.get(key);
  if (hit !== undefined) {
    lumpPatchStats.hits += 1;
    return hit;
  }
  const patch = decodeVPatch(wad.readLumpByName(name), key);
  byName.set(key, patch);
  lumpPatchStats.decodes += 1;
  return patch;
}

/* ------------------------------------------------------------------ */
/* Patch blitters (v_video.c:204 / :271 / :337)                         */
/* ------------------------------------------------------------------ */

/**
 * V_DrawPatch (v_video.c:204-263) verbatim: anchor by left/topoffset,
 * per-column walk of the raw post stream, every post byte written
 * (including literal 0), destination stride = layer width (vanilla's
 * SCREENWIDTH), post stride = length+4, 0xFF terminates a column.
 * Out-of-range x/y/scrn warn-and-ignore (counted, no throw — :222-233).
 * A MALFORMED post stream (data past the lump end / no terminator before
 * EOF) throws the same PatchPostError as patch.ts: the UI corpus is fully
 * audited in patches2.test.ts, and vanilla's "read garbage past a lump"
 * has no TS equivalent.
 */
export function vDrawPatch(x: number, y: number, scrn: number, patch: VPatch): void {
  drawPatch(x, y, scrn, patch, false, true);
}

/**
 * V_DrawPatchFlipped (v_video.c:271-330): horizontal mirror — the column
 * loop feeds `columnofs[w-1-col]` while dest columns run left→right (the
 * face-turn/mirrored-icon path). Same anchors, same post walk. Deviation
 * note: vanilla I_Errors on the range check (:296); we warn-and-ignore
 * like vDrawPatch.
 */
export function vDrawPatchFlipped(x: number, y: number, scrn: number, patch: VPatch): void {
  drawPatch(x, y, scrn, patch, true, true);
}

/**
 * V_DrawPatchDirect (v_video.c:337-399): in the released source the DOS
 * plane-write body is commented out and the function just calls
 * V_DrawPatch. Plan §M9-01 pins the DIRECT semantics: same pixels, NO
 * MarkRect (the commented-out body's V_MarkRect call is itself commented,
 * :369) — implemented as the shared core with marking off.
 */
export function vDrawPatchDirect(x: number, y: number, scrn: number, patch: VPatch): void {
  drawPatch(x, y, scrn, patch, false, false);
}

function drawPatch(x: number, y: number, scrn: number, patch: VPatch, flipped: boolean, mark: boolean): void {
  const layer = scrn >= 0 && scrn < NUMSCREENS ? screens[scrn] : null;
  if (layer === null) {
    vVideoStats.rangeCheckIgnored += 1; // vanilla: (unsigned)scrn>4
    return;
  }
  x -= patch.leftOffset;
  y -= patch.topOffset;
  // Vanilla bounds the SCREEN (320x200 constants); we also bound the BG
  // layer's 32 rows so a UI bug cannot scribble past screens[4] — every
  // ST call site fits (ST_HEIGHT patches at y=0), so this never fires in
  // faithful usage.
  if (
    x < 0 ||
    x + patch.width > layer.width ||
    y < 0 ||
    y + patch.height > layer.height
  ) {
    vVideoStats.rangeCheckIgnored += 1;
    return;
  }

  if (mark && scrn === FG) {
    vMarkRect(x, y, patch.width, patch.height); // vanilla: `if (!scrn)`
  }

  const bytes = patch.bytes;
  const data = layer.data;
  const w = patch.width;
  for (let col = 0; col < w; col += 1) {
    let p = patch.columnofs[flipped ? w - 1 - col : col]!;
    for (;;) {
      if (p + 2 > bytes.length) {
        throw new PatchPostError(
          `patch '${patch.name}' column ${col}: post stream ran off the lump at ${p} (length ${bytes.length})`,
        );
      }
      const top = bytes[p]!;
      if (top === POST_TERMINATOR) break;
      const length = bytes[p + 1]!;
      const src = p + POST_DATA_OFFSET;
      if (src + length > bytes.length) {
        throw new PatchPostError(
          `patch '${patch.name}' column ${col}: post at ${p} reads ${length} bytes past lump end (${bytes.length})`,
        );
      }
      // Vanilla writes blindly (dest += SCREENWIDTH per pixel); typed-array
      // stores past the buffer are the benign-OOB equivalent already used
      // by Framebuffer.point. We iterate clipped to the patch's own height
      // (posts never exceed it — audited corpus) so well-formed draws are
      // fully in-bounds anyway.
      let di = (y + top) * layer.width + x + col;
      for (let n = 0; n < length; n += 1) {
        if (di >= 0 && di < data.length) data[di] = bytes[src + n]!;
        di += layer.width;
      }
      p += length + POST_STRIDE_EXTRA;
    }
  }
}

/* ------------------------------------------------------------------ */
/* V_CopyRect (v_video.c:158-192)                                       */
/* ------------------------------------------------------------------ */

/** Vanilla `I_Error("Bad V_CopyRect")` (v_video.c:185). */
export class VCopyRectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VCopyRectError';
  }
}

/**
 * V_CopyRect (v_video.c:158-192): the widget-erase primitive —
 * `vCopyRect(ST_X, 0, BG, ST_WIDTH, ST_HEIGHT, ST_X, ST_Y, FG)`
 * (st_stuff.c:509). Rows of `width` bytes, stride = each layer's width
 * (320 for every layer). Marks the destination rect; the range guard is
 * FATAL (vanilla I_Error, not the patch warn-and-ignore).
 */
export function vCopyRect(
  srcx: number,
  srcy: number,
  srcscrn: number,
  width: number,
  height: number,
  destx: number,
  desty: number,
  destscrn: number,
): void {
  const srcLayer = srcscrn >= 0 && srcscrn < NUMSCREENS ? screens[srcscrn] : null;
  const dstLayer = destscrn >= 0 && destscrn < NUMSCREENS ? screens[destscrn] : null;
  if (
    srcLayer === null ||
    dstLayer === null ||
    srcx < 0 ||
    srcx + width > srcLayer.width ||
    srcy < 0 ||
    srcy + height > srcLayer.height ||
    destx < 0 ||
    destx + width > dstLayer.width ||
    desty < 0 ||
    desty + height > dstLayer.height
  ) {
    throw new VCopyRectError(
      `Bad V_CopyRect ${srcx},${srcy} s${srcscrn} ${width}x${height} -> ${destx},${desty} s${destscrn}`,
    );
  }
  vMarkRect(destx, desty, width, height);
  for (let row = 0; row < height; row += 1) {
    const s = (srcy + row) * srcLayer.width + srcx;
    const d = (desty + row) * dstLayer.width + destx;
    dstLayer.data.set(srcLayer.data.subarray(s, s + width), d);
  }
}

/** Whole-layer fill (widget tests / background flood helper; not a v_video export). */
export function vMemset(scrn: number, index: number): void {
  const layer = screens[scrn];
  if (layer === null) {
    throw new RangeError(`vMemset: no screen layer ${scrn}`);
  }
  layer.data.fill(index & 0xff);
}
