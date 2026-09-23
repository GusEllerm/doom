// ui/finale.ts — f_finale.c endgame port (M9-10, plan §M9-10 / §0.10).
//
// Scope (plan §0.10 + §4): EPISODIC ep1 only. F_StartFinale's shareware/
// registered/retail arm (f_finale.c:105-135) with the ep1 pins —
// finaleflat "FLOOR4_8" + finaletext E1TEXT (d_englsh.h:359, compiled-in,
// NO endgame lump) + mus_victor via hooks.musicSlot('finale', true) (M10-04 swap; consumer M10-08); the
// commercial arm (:137-186, C1-C6 texts, mus_read_m), F_StartCast, the
// cast ticker/responder/drawer and F_BunnyScroll are ABSENT by plan (§4
// "commercial/Doom-2 finale branches … code-shipped-but-unreached" — here
// intentionally not shipped: GAME_MODE is pinned 'shareware' and
// G_InitNew clamps episode to 1, so every omitted branch is statically
// unreachable). Episodes 2-4 (:113-127, SFLR6_1/MFLR8_4/MFLR8_3 + E2-E4
// TEXTS) land as COUNTED stubs, never silent.
//
// REVEAL MATH (source pins, f_finale.c):
//   TEXTSPEED 3 / TEXTWAIT 250            (:55-56)
//   characters drawn = (finalecount - 10) / TEXTSPEED, floor, ≥0
//                                          (F_TextWrite :297-299)
//   stage flip when !finalestage && finalecount > strlen*TEXTSPEED+TEXTWAIT
//     -> finalecount=0; finalestage=1; wipegamestate=-1  (F_Ticker :241-247)
//   For E1TEXT (440 chars): all glyphs on screen at finalecount ≥ 1330,
//   HELP2 stage + forced wipe at finalecount == 1571 (440*3+250+1).
//
// Stage-1 draw (F_Drawer :700-737): shareware ep1 ⇒ HELP2 patch FOREVER
// (:715-720, retail's CREDIT unreachable) — no timeout, no key exit;
// onward = the control panel (M_Responder runs in every gamestate) or
// M_EndGame/F7-yes ⇒ D_StartTitle (title.ts). F_Responder (:196-202) is
// transcribed as the constant-false it is for stages 0/1 (stage 2 absent).
//
// DRAWS: screens[FG] through the M9-01 vvideo seam only (never touches
// renderer/wiDraw internals); the flat tile is the vanilla 64×64 row
// memcpy flood (F_TextWrite :277-292). Who calls fTicker/fDrawer: the
// game.ts flow-hook registry (finaleTicker/startTitle idiom — module-load
// registration below) and the display block (renderer-assembly wiring).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { GA, GS, registerGameFlowHooks, type FlowActFn, type FlowTicFn } from '../sim/game';
import { musicSlot } from '../sim/hooks';
import { decodeFlat } from '../wad/flat';
import { lumpPatch, screens, FG, SCREENWIDTH, SCREENHEIGHT, vDrawPatch, vMarkRect, type VPatch } from '../render/vvideo';
import type { WadFile } from '../wad/wadfile';
import { HU_FONTSIZE, HU_FONTSTART } from './humessage';

import { E1TEXT } from './textdata';

/* ------------------------------------------------------------------ */
/* f_finale.c constants (:55-56)                                        */
/* ------------------------------------------------------------------ */

/** `#define TEXTSPEED 3` — one glyph every 3 tics (:55). */
export const TEXTSPEED = 3;
/** `#define TEXTWAIT 250` — post-text pause before the art screen (:56). */
export const TEXTWAIT = 250;

/* ------------------------------------------------------------------ */
/* module globals (f_finale.c:48-87)                                    */
/* ------------------------------------------------------------------ */

/** 0 = text, 1 = art screen (2 = cast — ABSENT, §4). */
let finalestage = 0;
let finalecount = 0;
/** lump NAME of the tile background (ep1: 'FLOOR4_8', :111). */
let finaleflat = '';
let finaletext: string | null = null;

let wad: WadFile | null = null;
let flatCache: { name: string; pixels: Uint8Array } | null = null;

/** The HU font cache (hu_font[] — same STCFN lumps as humessage/menu). */
const huFont: (VPatch | null)[] = new Array(HU_FONTSIZE).fill(null);

/** Counted unreachable sites (ep2-4 arms; never silent — §4 idiom). */
export const finaleStubHits = { count: 0, byName: new Map<string, number>() };

export function resetFinaleStubHits(): void {
  finaleStubHits.count = 0;
  finaleStubHits.byName.clear();
}

function finaleStub(name: string): void {
  finaleStubHits.count++;
  finaleStubHits.byName.set(name, (finaleStubHits.byName.get(name) ?? 0) + 1);
}

/** Read-only view of the f_finale.c globals (test/debug seam). */
export const finaleState = {
  finalestage: () => finalestage,
  finalecount: () => finalecount,
  finaleflat: () => finaleflat,
  finaletext: () => finaletext,
  /** chars the LAST fDrawer()/fTextWrite() drew (F_TextWrite reveal) */
  lastDrawn: () => lastDrawn
};

/** The WAD seam (W_CacheLumpName equivalent); null ⇒ draws count stubs. */
export function fSetWad(w: WadFile | null): void {
  wad = w;
}

/** Reset to the pristine module state (tests; mirrors a fresh process). */
export function fReset(w?: WadFile | null): void {
  if (w !== undefined) fSetWad(w);
  finalestage = 0;
  finalecount = 0;
  finaleflat = '';
  finaletext = null;
  flatCache = null;
  huFont.fill(null);
  lastDrawn = 0;
  resetFinaleStubHits();
}

/* ------------------------------------------------------------------ */
/* F_StartFinale (f_finale.c:96-192)                                    */
/* ------------------------------------------------------------------ */

/**
 * F_StartFinale: ga_nothing, GS_FINALE, viewactive=false
 * (:98-101 — the automapactive=false half :101 lives with the automap
 * state, the display block never draws it outside GS_LEVEL), then the
 * gamemode switch. Only the shareware/registered/retail arm (:107-135)
 * ships; ep1 = FLOOR4_8 + E1TEXT + mus_victor (S_ChangeMusic loop,
 * M10-04 musicSlot swap). The commercial arm + cast (:137-186/:330+) are §4-
 * absent; ep2-4 arms count a stub (shareware clamp makes them
 * unreachable — pin, not dead code).
 */
export const fStartFinale: FlowActFn = (state) => {
  state.gameaction = GA.nothing; // :98 (the drain has cleared it as well)
  state.gamestate = GS.FINALE;
  state.viewactive = false; // :100
  // :101 automapactive = false — automap state seam (display wiring).

  // shareware/registered/retail arm (gamemode==commercial is §4-absent;
  // gamemode.ts pins GAME_MODE='shareware' + G_InitNew clamps ep≤1).
  switch (state.gameepisode) {
    case 1: // :109-113
      musicSlot('finale', true); // :110 S_ChangeMusic(mus_victor, true) — M10-04 swap
      finaleflat = 'FLOOR4_8';
      finaletext = E1TEXT;
      break;
    case 2: // :115-117 — unreachable: GAME_MODE shareware clamps ep to 1
    case 3: // :119-121
    case 4: // :123-125
      finaleStub(`finale-episode-${state.gameepisode}`);
      finaleflat = 'FLOOR4_8';
      finaletext = E1TEXT;
      break;
    default: // :128-129 "// Ouch."
      finaleStub(`finale-episode-${state.gameepisode}`);
      finaleflat = '';
      finaletext = null;
      break;
  }

  finalestage = 0; // :188
  finalecount = 0; // :189
  flatCache = null;
  huFont.fill(null);
  lastDrawn = 0;
};

/* ------------------------------------------------------------------ */
/* F_Ticker (f_finale.c:207-254)                                        */
/* ------------------------------------------------------------------ */

/**
 * F_Ticker. The commercial skip-after-50 block (:211-225) and the
 * `gamemap == 30 ⇒ F_StartCast` + commercial early-return (:230-238) are
 * §4-absent (shareware falls straight through to the episodic tail);
 * `gameepisode == 3 ⇒ mus_bunny` (:247-248) is §4-deferred (ep1 only).
 * The episodic truth, verbatim shape (:227/:241-247):
 *   finalecount++;
 *   if (!finalestage && finalecount > strlen*TEXTSPEED + TEXTWAIT)
 *     { finalecount = 0; finalestage = 1; wipegamestate = -1; }
 */
export const fTicker: FlowTicFn = (state) => {
  finalecount++; // :227

  if (finalestage === 0 && finaletext !== null && finalecount > finaletext.length * TEXTSPEED + TEXTWAIT) {
    finalecount = 0; // :242
    finalestage = 1; // :243
    state.wipegamestate = -1; // :244 — force a wipe (takeWipeRequest melts)
    // :245-246 gameepisode==3 ⇒ F_BunnyScroll stage 2 — §4-absent.
  }
};

/* ------------------------------------------------------------------ */
/* F_Responder (f_finale.c:196-202)                                     */
/* ------------------------------------------------------------------ */

/**
 * F_Responder: eats events ONLY in stage 2 (the cast, §4-absent), so this
 * is the transcribed constant false — the finale never eats keys; the
 * onward path is M_Responder (Esc/F-keys) over the top, per §0.10. The
 * event argument is moot (no consumer once F_CastResponder is absent —
 * wiResponder() precedent); the shape `finalestage === 2` stays visible.
 */
export function fResponder(): boolean {
  return finalestage === 2; // :198 — stage 2 never happens (cast absent)
}

/* ------------------------------------------------------------------ */
/* F_Drawer / F_TextWrite (f_finale.c:700-737 / :261-327)               */
/* ------------------------------------------------------------------ */

let lastDrawn = 0;

/**
 * F_Drawer (:700): stage 0 → F_TextWrite; stage 1 → the art screen:
 * ep1 non-retail ⇒ HELP2 forever (:712-720 — CREDIT is retail-only,
 * unreachable under the shareware pin). Stage 2 (cast) absent.
 */
export function fDrawer(): void {
  if (finalestage === 0) {
    fTextWrite();
    return;
  }
  // F_Drawer stage-1 switch (:708-733), shareware ep1 arm only:
  drawScreenPatch('HELP2'); // :719-720
}

/** V_DrawPatch(0,0,0, W_CacheLumpName(name)) + counted missing wad. */
function drawScreenPatch(name: string): void {
  if (wad === null) {
    finaleStub(`draw:${name}`);
    return;
  }
  vDrawPatch(0, 0, FG, lumpPatch(wad, name));
}

/**
 * F_TextWrite (:261): erase the whole screen to a 64×64 tile flood of
 * finaleflat (the raw-bytes memcpy loop :277-292 — 320 % 64 == 0, the
 * SCREENWIDTH&63 tail branch :288-292 is dead at this resolution, kept
 * for shape), V_MarkRect the full screen (:294), then reveal the text.
 */
export function fTextWrite(): void {
  const data = screens[FG]?.data;
  if (data === undefined) {
    finaleStub('draw:no-screen');
    return;
  }
  const flat = flatPixels();
  if (flat !== null) {
    for (let y = 0; y < SCREENHEIGHT; y++) {
      let dest = y * SCREENWIDTH;
      const row = (y & 63) << 6; // src + ((y&63)<<6) (:281)
      for (let x = 0; x < SCREENWIDTH / 64; x++) {
        data.set(flat.subarray(row, row + 64), dest);
        dest += 64;
      }
      if (SCREENWIDTH & 63) {
        data.set(flat.subarray(row, row + (SCREENWIDTH & 63)), dest);
        dest += SCREENWIDTH & 63;
      }
    }
  }
  vMarkRect(0, 0, SCREENWIDTH, SCREENHEIGHT); // :294

  // text reveal (:296-325) — cursor (10,10), one char per `count` step,
  // '\n' ⇒ cx=10 / cy+=11 (:307-311), toupper, unknown glyph ⇒ cx+=4.
  let cx = 10;
  let cy = 10;
  let count = Math.floor((finalecount - 10) / TEXTSPEED); // :297
  if (count < 0) count = 0; // :299
  lastDrawn = 0;
  if (finaletext === null) return;
  const text = finaletext;
  let i = 0;
  for (; count > 0; count--) {
    if (i >= text.length) break; // c == 0 (NUL) ⇒ break (:304-305)
    const ch = text.charCodeAt(i++);
    if (ch === 10 /* '\n' */) {
      cx = 10; // :309
      cy += 11; // :310 — THE +11-per-newline pin
      continue;
    }
    // toupper(c) - HU_FONTSTART (:313) — ASCII-only like the C toupper
    const upper = ch >= 97 && ch <= 122 ? ch - 32 : ch;
    const k = upper - HU_FONTSTART;
    if (k < 0 || k > HU_FONTSIZE) {
      cx += 4; // :314-317 — the verbatim `> HU_FONTSIZE` bound kept
      continue;
    }
    const p = fontChar(k);
    if (p === null) {
      // Deviation pin: vanilla's `k > HU_FONTSIZE` allows k == 63 and
      // then reads hu_font[63] OUT OF ARRAY (a latent 1.10 bug — no such
      // glyph index exists). We degrade like the rangecheck idiom:
      // counted, advance 4, never scribble or throw mid-draw.
      finaleStub('font-index-63');
      cx += 4;
      continue;
    }
    if (cx + p.width > SCREENWIDTH) break; // :320-321
    vDrawPatch(cx, cy, FG, p); // :322 (hu_font draws V_DrawPatch, not Direct)
    cx += p.width; // :323
    lastDrawn = i;
  }
}

/** W_CacheLumpName(finaleflat) — raw 4096 flat bytes, decoded-validated. */
function flatPixels(): Uint8Array | null {
  if (wad === null || finaleflat === '') {
    finaleStub(finaleflat === '' ? 'finale:no-flat' : 'finale:no-wad');
    return null;
  }
  if (flatCache === null || flatCache.name !== finaleflat) {
    try {
      flatCache = { name: finaleflat, pixels: decodeFlat(wad.readLumpByName(finaleflat), finaleflat).pixels };
    } catch {
      finaleStub(`flat-missing:${finaleflat}`);
      return null;
    }
  }
  return flatCache.pixels;
}

/** hu_font[c] (hu_stuff.c) — STCFN%.3d through the vvideo lumpPatch cache. */
function fontChar(idx: number): VPatch | null {
  if (wad === null) return null;
  const p = huFont[idx];
  if (p !== null && p !== undefined) return p;
  const patch = lumpPatch(wad, `STCFN${String(idx + HU_FONTSTART).padStart(3, '0')}`);
  huFont[idx] = patch;
  return patch;
}

/* ------------------------------------------------------------------ */
/* M9-03 registrable-hook registration (wintermission.ts module-load    */
/* idiom; dRegisterFlow re-arms after test resetGameFlow).              */
/* ------------------------------------------------------------------ */

/** Register the GS_FINALE tic + ga_victory hooks (game.ts seams). */
export function fRegisterFlow(): void {
  registerGameFlowHooks({ finaleTicker: fTicker, startFinale: fStartFinale });
}

fRegisterFlow();
