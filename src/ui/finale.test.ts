/**
 * Tests for ui/finale.ts — M9-10 (plan §M9-10 acceptance 2/3 halves:
 * E1M8-exit finale, exact reveal tics, HELP2 hold; the L3 finale goldens
 * live in tests/render/screens.test.ts).
 *
 * Pins: E1TEXT byte-transcription vs the tracked .refs/d_englsh.h:359
 * mirror (sha256 + re-parse incl. the \n count — acceptance 3), the
 * F_StartFinale ep1 pins through the ga_victory drain (M9-03 seam),
 * reveal EXACTNESS (count=(finalecount-10)/TEXTSPEED, ':309' newline
 * cursor (10,10) +11, all 440 chars at t=1330, stage flip at
 * finalecount==1571 == 440*3+250+1), the HELP2 hold-forever (F_Drawer
 * :712-720), and the wipegamestate=-1 sentinel fired exactly once
 * (F_Ticker :244 consumed via takeWipeRequest).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';

import { buildPatchFromColumns } from '../wad/patch';
import { WadFile } from '../wad/wadfile';
import { WadBuilder } from '../../tests/fixtures/wadWriter';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { buildMapFromData } from '../sim/map';
import { loadMap } from '../wad/mapdata';
import {
  GA,
  GS,
  gInitGame,
  gTicker,
  resetGameFlow,
  resetFlowStubHits,
  takeWipeRequest
} from '../sim/game';
import { emptyInput } from '../sim/ticcmd';
import type { GameState } from '../sim/state';
import { FG, screens, vInit } from '../render/vvideo';
import { musicLog, resetGameactionLog, resetSfxStubLog } from '../sim/hooks';
import { gResponderDemo } from './title';

import {
  fDrawer,
  fRegisterFlow,
  fResponder,
  fReset,
  fSetWad,
  fStartFinale,
  fTextWrite,
  fTicker,
  finaleState,
  finaleStubHits,
  resetFinaleStubHits,
  TEXTSPEED,
  TEXTWAIT
} from './finale';
import { E1TEXT } from './textdata';

/* ------------------------------------------------------------------ */
/* fixtures                                                             */
/* ------------------------------------------------------------------ */

function solidPatch(w: number, h: number, fill: number): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < w; c++) cols.push(new Array(h).fill(fill % 256));
  return buildPatchFromColumns(cols, 0, 0);
}

function lumpFill(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 251;
  return h + 1; // 1..251
}

/** Deterministic 4096-byte flat — probe value is a function of (x,y). */
const FLAT_BYTES = new Uint8Array(4096);
for (let i = 0; i < 4096; i++) FLAT_BYTES[i] = ((i * 37) % 251) + 1;
function flatByte(x: number, y: number): number {
  return FLAT_BYTES![(y & 63) * 64 + (x & 63)]!;
}

function finaleWad(): WadFile {
  const b = new WadBuilder('IWAD');
  b.addLump('FLOOR4_8', FLAT_BYTES);
  b.addLump('HELP2', solidPatch(320, 200, lumpFill('HELP2')));
  b.addLump('TITLEPIC', solidPatch(320, 200, lumpFill('TITLEPIC')));
  // hu_font: STCFN%.3d for '!'(33).. '_'(95) (HU_FONTSIZE=63, §0.8)
  for (let c = 33; c <= 95; c++) {
    b.addLump(`STCFN${String(c).padStart(3, '0')}`, solidPatch(6, 8, lumpFill(`STCFN${String(c).padStart(3, '0')}`)));
  }
  const bytes = b.build();
  return WadFile.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
}

const WAD = finaleWad();

const SPEC: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 200 }],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
};

function fixMap(): ReturnType<typeof buildMapFromData> {
  const bytes = buildFixtureMapWad(SPEC);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
}

let st: GameState;

/** Boot straight into the finale at finalecount=0 (F_StartFinale body,
 * with the state-change wipe sentinel pre-consumed so ONLY the
 * :244 forced wipe can appear later). */
function bootFinale(): void {
  st = gInitGame(fixMap());
  fStartFinale(st);
  st.wipegamestate = st.gamestate; // pre-consume the state-change wipe
}

/** Run n F_Ticker tics. */
function tics(n: number): void {
  for (let i = 0; i < n; i++) fTicker(st, emptyInput());
}

function px(x: number, y: number): number {
  return screens[FG]!.data[y * 320 + x]!;
}

beforeEach(() => {
  resetGameFlow();
  resetFlowStubHits();
  resetSfxStubLog();
  resetGameactionLog();
  resetFinaleStubHits();
  fReset(WAD);
  fRegisterFlow(); // re-arm after resetGameFlow (wintermission idiom)
  vInit();
});

/* ------------------------------------------------------------------ */
/* 1. E1TEXT byte-transcription (acceptance 3)                           */
/* ------------------------------------------------------------------ */

describe('E1TEXT byte transcription (d_englsh.h:359)', () => {
  const SH256 = '0fa66f94c444309badc14cd9f8107a2cd8be218d31dbe17eee545cf72db30ef5';

  /** Re-parse the tracked C mirror: the #define's string literals,
   * concatenated with \n-escapes decoded (the C preprocessor's job).
   * INDEPENDENT of textdata.ts — this is the transcription oracle. */
  function cMirror(): { text: string; literals: number } {
    const p = fileURLToPath(new URL('../../.refs/d_englsh.h', import.meta.url));
    const lines = readFileSync(p, 'utf8').split(/\r?\n/);
    let i = lines.findIndex((l) => /#define\s+E1TEXT/.test(l));
    if (i < 0) throw new Error('E1TEXT define not found in the .refs mirror');
    const lits: string[] = [];
    for (i++; i < lines.length; i++) {
      const mm = lines[i]!.match(/"((?:[^"\\]|\\.)*)"/);
      if (mm === null) break;
      lits.push(mm[1]!);
    }
    return {
      text: lits.join('').replace(/\\(.)/g, (_s, c: string) => (c === 'n' ? '\n' : c)),
      literals: lits.length
    };
  }

  it('equals the re-parsed C multi-literal define, byte for byte', () => {
    const { text, literals } = cMirror();
    expect(literals).toBe(15); // 15 concatenated literals (:359-374)
    expect(E1TEXT).toBe(text);
    expect(E1TEXT.length).toBe(440); // strlen at :241 — the flip math input
    expect((E1TEXT.match(/\n/g) ?? []).length).toBe(15); // the \n count
  });

  it('sha256(E1TEXT) is the pinned digest (UTF-8 bytes)', () => {
    expect(createHash('sha256').update(E1TEXT).digest('hex')).toBe(SH256);
  });

  it('the flip/reveal math constants are the source pins', () => {
    expect(TEXTSPEED).toBe(3); // f_finale.c:55
    expect(TEXTWAIT).toBe(250); // :56
    // E1TEXT stage flip lands at finalecount == 440*3+250+1 == 1571:
    expect(E1TEXT.length * TEXTSPEED + TEXTWAIT + 1).toBe(1571);
  });
});

/* ------------------------------------------------------------------ */
/* 2. ga_victory ⇒ F_StartFinale (M9-03 seam, acceptance 2 half)         */
/* ------------------------------------------------------------------ */

describe('F_StartFinale through the gameaction drain (:96-135)', () => {
  it('E1M8 exit: ga_victory case runs the ep1 pins in-tic', () => {
    st = gInitGame(fixMap());
    st.gameaction = GA.victory; // G_DoCompleted's E1M8 pin (§0.3)
    gTicker(st); // drain (:544 ga_victory) THEN the per-state driver
    expect(st.gameaction).toBe(GA.nothing); // :98
    expect(st.gamestate).toBe(GS.FINALE);
    expect(st.viewactive).toBe(false); // :100
    expect(finaleState.finaleflat()).toBe('FLOOR4_8'); // :111
    expect(finaleState.finaletext()).toBe(E1TEXT); // :112 ← E1TEXT
    expect(finaleState.finalestage()).toBe(0); // :188
    expect(finaleState.finalecount()).toBe(1); // :189 reset, then F_Ticker++
    expect(musicLog.byId?.get('finale')).toBe(1); // :110 (M10-04 swap)
  });

  it('routing: every GS_FINALE gTicker tic lands on F_Ticker exactly once', () => {
    bootFinale();
    gTicker(st);
    gTicker(st);
    expect(finaleState.finalecount()).toBe(2);
  });

  it('ep2-4 arms are COUNTED stubs, never silent (§4)', () => {
    st = gInitGame(fixMap());
    st.gameepisode = 2; // unreachable under the shareware clamp — shape pin
    fStartFinale(st);
    expect(finaleStubHits.byName.get('finale-episode-2')).toBe(1);
    expect(musicLog.byId?.get('finale') ?? 0).toBe(0); // :110 ep1 site
  });

  it('F_Responder is the transcribed constant false (stages 0/1)', () => {
    bootFinale();
    expect(fResponder()).toBe(false); // :198 stage-2-only eater, cast absent
    tics(1600); // stage 1
    expect(fResponder()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Reveal-tic exactness (F_TextWrite :297-299, acceptance 2)          */
/* ------------------------------------------------------------------ */

describe('reveal tics (count = (finalecount-10)/3)', () => {
  it('nothing before tic 13; the first glyph lands exactly there (:297-299)', () => {
    bootFinale();
    tics(12); // count = floor(2/3) = 0 — floor, not ceil
    fDrawer();
    expect(finaleState.lastDrawn()).toBe(0);
    tics(1); // finalecount 13 → floor((13-10)/3) = 1 → 'O'
    fDrawer();
    expect(finaleState.lastDrawn()).toBe(1);
    expect(px(10, 10)).toBe(lumpFill('STCFN079')); // 'O' at the (10,10) cursor
  });

  it('tic 200 draws exactly 63 steps: line 1 mid-cursor + space advance', () => {
    bootFinale();
    tics(200);
    expect(finaleState.finalecount()).toBe(200);
    fDrawer();
    expect(finaleState.lastDrawn()).toBe(63); // floor((200-10)/3)
    // "Once" = 4 steps (6px fixture glyphs), step 5 = ' ' ⇒ cx+=4 (:314-317):
    expect(px(34, 10)).toBe(flatByte(34, 10)); // the 4-px gap stays flat
    expect(px(38, 10)).toBe(lumpFill('STCFN089')); // 'Y' of "you"
  });

  it('newline: cursor resets to x=10 and y += 11 (:309-310)', () => {
    bootFinale();
    // Line 1 = 34 chars + '\n' = 35 steps; step 36 starts line 2.
    tics(10 + 3 * 35); // count 35 — the newline step, line 2 not yet drawn
    fDrawer();
    expect(px(10, 21)).toBe(flatByte(10, 21));
    tics(3); // count 36 → 'c'→'C' of "clean" at (10, 21)
    fDrawer();
    expect(px(10, 21)).toBe(lumpFill('STCFN067'));
    expect(px(10, 10)).toBe(lumpFill('STCFN079')); // line 1 still drawn (full redraw)
  });

  it('the last glyph (index 439 steps) lands at tic 1327 and the tail adds none', () => {
    bootFinale();
    tics(1326); // count 438 — the final '!' (step 439) not yet drawn
    fDrawer();
    expect(px(98, 164)).toBe(flatByte(98, 164)); // "Inferno!" '!'
    tics(1); // 1327 = 10+3*439 — last character on screen (index 439 drawn,
    fDrawer(); //   step 440 is the terminating '\n' → lastDrawn stays 439)
    expect(px(98, 164)).toBe(lumpFill('STCFN033'));
    expect(finaleState.lastDrawn()).toBe(439);
    tics(103); // 1430 — the TEXTWAIT tail draws NOTHING more (NUL break;
    fDrawer(); //   vanilla would walk past the terminator — banked below)
    expect(finaleState.lastDrawn()).toBe(439);
  });

  it('the last text line sits at cy = 10 + 14*11 = 164 (15 lines)', () => {
    bootFinale();
    tics(1330);
    fDrawer();
    expect(px(10, 164)).not.toBe(flatByte(10, 164)); // 's' of "sequel," drawn
  });
});

/* ------------------------------------------------------------------ */
/* 4. Stage flip + wipe sentinel + HELP2 forever (F_Ticker :241-247)     */
/* ------------------------------------------------------------------ */

describe('stage flip / HELP2 hold (acceptance 2)', () => {
  it('flip is EXACT: not at 1570, at finalecount==1571 (> strlen*3+250)', () => {
    bootFinale();
    tics(1570);
    expect(finaleState.finalestage()).toBe(0);
    expect(st.gamestate).toBe(GS.FINALE);
    expect(st.wipegamestate).not.toBe(-1);
    tics(1);
    expect(finaleState.finalestage()).toBe(1); // :243
    expect(finaleState.finalecount()).toBe(0); // :242
    expect(st.wipegamestate).toBe(-1); // :244 — the forced wipe
  });

  it('the wipe sentinel is consumed EXACTLY ONCE', () => {
    bootFinale();
    tics(1571);
    expect(takeWipeRequest(st)).toBe(true); // melts once (d_main.c:216)
    expect(takeWipeRequest(st)).toBe(false);
    tics(500);
    expect(takeWipeRequest(st)).toBe(false); // no re-arm: !finalestage guard
  });

  it('HELP2 draws forever — 20k further tics never leave stage 1 (:712-720)', () => {
    bootFinale();
    tics(1571);
    fDrawer();
    const help = lumpFill('HELP2');
    expect(screens[FG]!.data.every((v) => v === help)).toBe(true);
    tics(20000);
    expect(finaleState.finalestage()).toBe(1); // no timeout, no self-exit
    fDrawer();
    expect(screens[FG]!.data.every((v) => v === help)).toBe(true);
  });

  it('stage 0 flood = the raw FLOOR4_8 64x64 tile of the WHOLE screen (:277-292)', () => {
    bootFinale();
    fTextWrite(); // finalecount 0 → pure flood, no glyphs
    let ok = true;
    for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
      if (px(x, y) !== flatByte(x, y)) ok = false;
    }
    expect(ok).toBe(true); // 320 % 64 == 0: seamless tiling
  });

  it('no wad ⇒ the HELP2 draw is counted, never throws', () => {
    bootFinale();
    fSetWad(null);
    tics(1571);
    fDrawer();
    expect(finaleStubHits.byName.get('draw:HELP2')).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 5. title seam cross-check: the finale is NOT the demo screen          */
/* ------------------------------------------------------------------ */

describe('gResponderDemo on the finale (g_game.c:520-535 guard)', () => {
  it('keydown in GS_FINALE is NOT eaten by the demo branch', () => {
    bootFinale();
    expect(gResponderDemo(st, { type: 'keydown', data1: 27 })).toBe(false);
    // (the finale's onward path is M_Responder over the top — §0.10)
  });
});
