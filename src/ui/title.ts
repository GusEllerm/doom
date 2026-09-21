// ui/title.ts — d_main.c attract-mode port, REDUCED (M9-10, plan
// §M9-10 / §0.6): the TITLEPIC page machine (D_PageTicker/D_PageDrawer/
// D_DoAdvanceDemo/D_StartTitle, d_main.c:423-529) + the G_Responder demo
// branch (g_game.c:520-535, "any other key pops up menu if in demos").
//
// REDUCED-ATTRACT BOUNDARY (plan §0.6, quoted): "M9 ships the REDUCED
// attract: TITLEPIC page + any-key→menu via G_Responder demo branch
// (g_game.c:529-541), no demo1/2/3, and D_StartTitle (demosequence=-1)
// as the 'back to title / end game' target." Concretely: the faithful
// d_main.c:467-513 %6 cycle (0 TITLEPIC pagetic=170 · 1 demo1 ·
// 2 CREDIT 200 · 3 demo2 · 4 HELP2 200 · 5 demo3) keeps its COUNTER
// (:465, demosequence=(demosequence+1)%6, non-retail), but every
// reachable page is TITLEPIC with the case-0 pins (:473/:475): the demo
// slots (1/3/5) call the counted gDeferedPlayDemo stub (Post-M12 `.lmp`
// stretch, ROADMAP §Stretch) and the CREDIT/HELP2 pages ride with them
// (§4 "D_DoAdvanceDemo demos" deferred). mus_intro lands at the case-0
// S_StartMusic site (:477) via the D-0xx counted stub.
//
// D-0zz (deviation, DECISIONS-pending): the browser has no process exit,
// so vanilla's I_Quit target (m_menu.c M_QuitResponse 'y' → I_Quit) is
// THIS title screen — Quit-yes and F7-EndGame-yes both arrive through
// the game.ts `startTitle` flow hook (gStartTitle ← menu.ts) and PAGE
// INTO TITLE (visible, testable — not an exit).
//
// WIRING: per-state tic + the advance/start hooks register at module
// load through registerGameFlowHooks (wintermission.ts idiom);
// dRegisterFlow re-arms after a test resetGameFlow. dPageDrawer() is the
// D_Display GS_DEMOSCREEN branch (d_main.c:259 → :434-438) — a single
// V_DrawPatch(0,0,0,pagename) onto the vvideo FG screen, called by the
// display-block owner (renderer-assembly). gResponderDemo() is the
// G_Responder branch for the eventQueue chain (main.ts wiring seam —
// D_ProcessEvents order per §0.6: M_Responder first, this only sees
// events the menu did not eat).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  GA,
  GS,
  registerGameFlowHooks,
  type FlowActFn,
  type FlowTicFn
} from '../sim/game';
import { sfxStub } from '../sim/hooks';
import { PST_LIVE } from '../sim/player';
import { FG, lumpPatch, vDrawPatch } from '../render/vvideo';
import type { WadFile } from '../wad/wadfile';
import type { GameState } from '../sim/state';
import type { KeyboardEventPacket } from '../input/keyboard';
import { mStartControlPanel } from './menu';

/* ------------------------------------------------------------------ */
/* d_main.c globals (:414-416)                                          */
/* ------------------------------------------------------------------ */

/** `int demosequence` — -1 after D_StartTitle (d_main.c:414/:528). */
let demosequence = -1;
/** `int pagetic` — TITLEPIC page: 170 (d_main.c:415/:473). */
let pagetic = 0;
/** `const char* pagename` — "TITLEPIC" on every reachable page (:416/:475). */
let pagename = 'TITLEPIC';

let wad: WadFile | null = null;

/** Counted unreachable sites (menu.ts menuStub idiom). */
export const titleStubHits = { count: 0, byName: new Map<string, number>() };

export function resetTitleStubHits(): void {
  titleStubHits.count = 0;
  titleStubHits.byName.clear();
}

function titleStub(name: string): void {
  titleStubHits.count++;
  titleStubHits.byName.set(name, (titleStubHits.byName.get(name) ?? 0) + 1);
}

/**
 * G_DeferedPlayDemo stub counter (plan §M9-10): the faithful call SITES
 * are D_DoAdvanceDemo cases 1/3/5 (d_main.c:482/:495/:511, demo1/2/3).
 * `.lmp` playback is Post-M12 stretch (§0.6) — every site lands HERE,
 * counted, never silent; the page cycle then continues on TITLEPIC.
 */
export const gDeferedPlayDemoStub = { count: 0, names: [] as string[] };

/** Read-only view of the d_main.c attract globals (test/debug seam). */
export const titleState = {
  demosequence: () => demosequence,
  pagetic: () => pagetic,
  pagename: () => pagename
};

/** The WAD seam (W_CacheLumpName for the page draw); null ⇒ counted. */
export function dSetWad(w: WadFile | null): void {
  wad = w;
}

/** Reset to the pristine module state (tests; fresh-process mirror). */
export function dReset(w?: WadFile | null): void {
  if (w !== undefined) dSetWad(w);
  demosequence = -1;
  pagetic = 0;
  pagename = 'TITLEPIC';
  gDeferedPlayDemoStub.count = 0;
  gDeferedPlayDemoStub.names.length = 0;
  resetTitleStubHits();
}

/* ------------------------------------------------------------------ */
/* D_StartTitle (d_main.c:525-530) — the title/boot entry               */
/* ------------------------------------------------------------------ */

/**
 * D_StartTitle: gameaction=ga_nothing, demosequence=-1, D_AdvanceDemo
 * (which just sets the advancedemo flag — consumed by the tic block,
 * game.ts gFlowTic, d_main.c:381). Targets:
 *  - BOOT: D_DoomMain's last act is D_StartTitle() (d_main.c:1166) —
 *    whoever wires main.ts calls {@link dInit} for the same effect
 *    (boot → GS_DEMOSCREEN on the first consumed tic);
 *  - F7-EndGame-yes and Quit-yes: menu.ts → gStartTitle → this hook;
 *    Quit-yes is the D-0zz browser mapping (page-into-title, NOT
 *    process-exit — the sandbox has no I_Quit).
 */
export const dStartTitle: FlowActFn = (state) => {
  state.gameaction = GA.nothing; // :527
  demosequence = -1; // :528
  state.advancedemo = true; // :529 D_AdvanceDemo (d_main.c:444-447)
};

/** D_DoomMain tail (d_main.c:1166) — the boot→GS_DEMOSCREEN seam. */
export function dInit(state: GameState): void {
  dStartTitle(state);
}

/* ------------------------------------------------------------------ */
/* D_PageTicker (d_main.c:423-428) — the GS_DEMOSCREEN tic hook         */
/* ------------------------------------------------------------------ */

/** `if (--pagetic < 0) D_AdvanceDemo();` — the page timeout, flag-style
 * (D_AdvanceDemo :444 only sets advancedemo; the body runs in the TIC
 * block before the next G_Ticker, d_main.c:381). */
export const dPageTicker: FlowTicFn = (state) => {
  if (--pagetic < 0) {
    state.advancedemo = true; // D_AdvanceDemo
  }
};

/* ------------------------------------------------------------------ */
/* D_DoAdvanceDemo (d_main.c:454-517) — the advanceDemo hook            */
/* ------------------------------------------------------------------ */

/**
 * D_DoAdvanceDemo head (:456-461) verbatim, then the %6 counter (:465,
 * non-retail). The reduced cycle (§0.6 boundary): demo slots count the
 * gDeferedPlayDemo stub and EVERY page lands TITLEPIC with the case-0
 * pins — pagetic=170 (:473), gamestate=GS_DEMOSCREEN, pagename TITLEPIC
 * (:475); mus_intro at the case-0 music site (:477) via the counted
 * sfx stub. Faithful-but-unreachable: demo1/2/3 (G_DeferedPlayDemo),
 * case-2 CREDIT/200 (:487-490) and case-4 HELP2/200 (:496-509).
 */
export const dDoAdvanceDemo: FlowActFn = (state) => {
  state.players[0]!.playerstate = PST_LIVE; // :456 (consoleplayer, SP)
  state.advancedemo = false; // :457
  state.usergame = false; // :458 "no save / end game here"
  state.paused = false; // :459
  state.gameaction = GA.nothing; // :460

  demosequence = (demosequence + 1) % 6; // :465 (gamemode != retail)

  switch (demosequence) {
    case 0: // TITLEPIC (:468-478)
      sfxStub('mus_intro'); // :477 S_StartMusic(mus_intro) — D-0xx
      break;
    case 1: // demo1 (:480-483)
      deferPlayDemo('demo1');
      break;
    case 2: // CREDIT (:485-490) — deferred with the demos (§0.6)
      titleStub('page:CREDIT');
      break;
    case 3: // demo2 (:492-494)
      deferPlayDemo('demo2');
      break;
    case 4: // HELP2 page, registered arm (:496-509) — deferred with demos
      titleStub('page:HELP2');
      break;
    case 5: // demo3 (:510-512)
      deferPlayDemo('demo3');
      break;
  }

  // Reduced-attract page landing (TITLEPIC-only cycle, §0.6):
  pagetic = 170; // :473
  state.gamestate = GS.DEMOSCREEN; // :474
  pagename = 'TITLEPIC'; // :475
};

/** G_DeferedPlayDemo site (g_game.c deferred-demo arm §4; stub counter). */
function deferPlayDemo(name: string): void {
  gDeferedPlayDemoStub.count++;
  gDeferedPlayDemoStub.names.push(name);
}

/* ------------------------------------------------------------------ */
/* D_PageDrawer (d_main.c:434-438) — the display-block seam             */
/* ------------------------------------------------------------------ */

/** `V_DrawPatch(0,0,0, W_CacheLumpName(pagename, PU_CACHE))` — called
 * once per frame by the D_Display GS_DEMOSCREEN branch (:259). */
export function dPageDrawer(): void {
  if (wad === null) {
    titleStub(`draw:${pagename}`);
    return;
  }
  vDrawPatch(0, 0, FG, lumpPatch(wad, pagename));
}

/* ------------------------------------------------------------------ */
/* G_Responder demo branch (g_game.c:520-535) — responder-chain seam    */
/* ------------------------------------------------------------------ */

/** The branch's event domain: keydown/keyup packets (keyboard.ts) plus
 * the ev_mouse BUTTON half (data1 = button bits); motion-only mouse
 * packets are synthesized as keys by menuMouse.ts (D-0yy) and never
 * reach this shape. */
export type TitleEvent = KeyboardEventPacket | { readonly type: 'mouse'; readonly data1: number };

/**
 * G_Responder's demo/title branch, verbatim (:522-535):
 *   if (gameaction == ga_nothing && !singledemo &&
 *       (demoplayback || gamestate == GS_DEMOSCREEN)) {
 *     if (ev_keydown || (ev_mouse && data1)) { M_StartControlPanel(); return true; }
 *     return false; }        // keyups NEVER eaten (g_game.c:571)
 * singledemo/demoplayback are constants-false in this build (`.lmp` =
 * Post-M12), so the guard reduces to the GS_DEMOSCREEN test. NOT eaten
 * outside the guard — everything else falls through to the chain (the
 * F12 spy half :507-517 is GS_LEVEL-only, M9-12 wiring).
 */
export function gResponderDemo(state: GameState, ev: TitleEvent): boolean {
  if (
    state.gameaction === GA.nothing &&
    (state.gamestate === GS.DEMOSCREEN /* demoplayback: false (§0.6) */)
  ) {
    if (ev.type === 'keydown' || (ev.type === 'mouse' && ev.data1 !== 0)) {
      mStartControlPanel(state); // g_game.c:529
      return true;
    }
    return false;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* M9-03 registrable-hook registration (module load, wintermission      */
/* idiom; dRegisterFlow re-arms after a test resetGameFlow).            */
/* ------------------------------------------------------------------ */

/** Register the GS_DEMOSCREEN tic, advanceDemo and startTitle hooks. */
export function dRegisterFlow(): void {
  registerGameFlowHooks({
    pageTicker: dPageTicker,
    advanceDemo: dDoAdvanceDemo,
    startTitle: dStartTitle
  });
}

dRegisterFlow();
