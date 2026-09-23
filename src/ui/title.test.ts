/**
 * Tests for ui/title.ts — M9-10 (plan §M9-10 acceptance 1/2-half:
 * boot→TITLEPIC + first-key-arms-menu verified at UNIT level here, in
 * the browser by e2e M9-12; the L3 title golden lives in finale.test.ts's
 * golden block).
 *
 * Pins: D_StartTitle (d_main.c:525-530) flag shape, the %6 counter with
 * the reduced TITLEPIC-only landing (pagetic=170 :473), D_PageTicker's
 * exact 171-tic timeout (:423-427), the G_Responder demo branch truth
 * table (g_game.c:520-535: keydown/mouse-button eaten ON the demo
 * screen, keyups and everything else NEVER eaten), and the D-0zz
 * quit/endgame-yes → title route through the game.ts startTitle hook.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
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
  gFlowTic,
  gInitGame,
  gStartTitle,
  gTicker,
  takeWipeRequest,
  resetFlowStubHits,
  resetGameFlow
} from '../sim/game';
import type { GameState } from '../sim/state';
import { FG, screens, vInit } from '../render/vvideo';
import { musicLog, resetGameactionLog, resetSfxStubLog } from '../sim/hooks';
import { mReset, menuState } from './menu';

import {
  dInit,
  dPageDrawer,
  dRegisterFlow,
  dReset,
  dSetWad,
  dStartTitle,
  gDeferedPlayDemoStub,
  gResponderDemo,
  titleState,
  titleStubHits,
  resetTitleStubHits
} from './title';

/* ------------------------------------------------------------------ */
/* fixtures                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic patch bytes: uniform fill keyed by the lump name. */
function solidPatch(w: number, h: number, fill: number): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < w; c++) cols.push(new Array(h).fill(fill % 256));
  return buildPatchFromColumns(cols, 0, 0);
}

function lumpFill(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 251;
  return h + 1; // 1..251 (never the cleared-screen 0)
}

function titleWad(): WadFile {
  const b = new WadBuilder('IWAD');
  for (const name of ['TITLEPIC', 'HELP2']) {
    b.addLump(name, solidPatch(320, 200, lumpFill(name)));
  }
  const bytes = b.build();
  return WadFile.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  );
}

const WAD = titleWad();

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

/** boot exactly like the wiring seam will: D_DoomMain tail = D_StartTitle
 * + one tic block consumed (d_main.c:1166 → :381 → :454). */
function bootToTitle(): void {
  st = gInitGame(fixMap());
  dInit(st);
  gFlowTic(st);
}

beforeEach(() => {
  resetGameFlow();
  resetFlowStubHits();
  resetSfxStubLog();
  resetGameactionLog();
  resetTitleStubHits();
  dReset(WAD);
  dRegisterFlow(); // re-arm after resetGameFlow (mRegisterFlow idiom)
  mReset(WAD);
  vInit();
});

/* ------------------------------------------------------------------ */
/* 1. boot → GS_DEMOSCREEN with the TITLEPIC page (acceptance 1)        */
/* ------------------------------------------------------------------ */

describe('D_StartTitle boot (d_main.c:1166 → :525-530 → :454-475)', () => {
  it('dInit only ARMS the flag — the tic block consumes it (d_main.c:381)', () => {
    st = gInitGame(fixMap());
    dInit(st);
    expect(st.advancedemo).toBe(true);
    expect(st.gamestate).toBe(GS.LEVEL); // the flip happens in the body
    gFlowTic(st);
    expect(st.advancedemo).toBe(false);
    expect(st.gamestate).toBe(GS.DEMOSCREEN);
    expect(st.gameaction).toBe(GA.nothing);
    expect(titleState.demosequence()).toBe(0); // -1+1 mod 6
    expect(titleState.pagename()).toBe('TITLEPIC');
    expect(titleState.pagetic()).toBe(170); // :473 pin (pre-tic)
    expect(st.usergame).toBe(false); // :458 "no save / end game here"
    expect(st.paused).toBe(false);
    expect(st.players[0]!.playerstate).toBe(0); // PST_LIVE (:456)
    expect(musicLog.byId?.get('title')).toBe(1); // :477 S_StartMusic (M10-04)
  });

  it('D_PageTicker decrements every GS_DEMOSCREEN tic (gTicker routing)', () => {
    bootToTitle();
    gTicker(st);
    expect(titleState.pagetic()).toBe(169);
    expect(st.gametic).toBe(1);
  });

  it('page timeout is EXACT: advancedemo arms on the 171st tic (:423-427)', () => {
    bootToTitle(); // pagetic = 170 after the page tic block
    let tics = 0;
    while (!st.advancedemo && tics < 300) {
      gTicker(st);
      tics++;
    }
    expect(tics).toBe(171); // 170 → 0, the 171st goes < 0
    expect(titleState.pagetic()).toBe(-1);
  });

  it('reduced cycle: TITLEPIC-only, %6 counter faithful, stubs counted (§0.6)', () => {
    bootToTitle(); // demosequence 0 consumed in the boot tic block
    // Drive the remaining cycle slots directly (flag setter seam):
    for (let pass = 1; pass <= 4; pass++) {
      st.advancedemo = true;
      gFlowTic(st);
      expect(st.gamestate).toBe(GS.DEMOSCREEN);
      expect(titleState.pagename()).toBe('TITLEPIC');
      expect(titleState.pagetic()).toBe(170);
      expect(titleState.demosequence()).toBe(pass);
    }
    expect(titleState.demosequence()).toBe(4);
    expect(gDeferedPlayDemoStub.count).toBe(2); // demo1 + demo2 (:482/:495)
    expect(gDeferedPlayDemoStub.names).toEqual(['demo1', 'demo2']);
    expect(titleStubHits.byName.get('page:CREDIT')).toBe(1); // :487-490
  });
});

/* ------------------------------------------------------------------ */
/* 2. first keypress arms the menu (G_Responder branch, acceptance 1)   */
/* ------------------------------------------------------------------ */

describe('G_Responder demo branch (g_game.c:520-535)', () => {
  it('keydown ON the demo screen ⇒ M_StartControlPanel + eaten', () => {
    bootToTitle();
    expect(menuState.menuActive()).toBe(false);
    expect(gResponderDemo(st, { type: 'keydown', data1: 27 })).toBe(true);
    expect(menuState.menuActive()).toBe(true); // :529 — the first key arms
  });

  it('mouse button-down eaten too; motion-only (data1=0) is not', () => {
    bootToTitle();
    expect(gResponderDemo(st, { type: 'mouse', data1: 0 })).toBe(false);
    expect(menuState.menuActive()).toBe(false);
    expect(gResponderDemo(st, { type: 'mouse', data1: 1 })).toBe(true);
    expect(menuState.menuActive()).toBe(true);
  });

  it('keyup NEVER eaten (g_game.c:571); outside the guard nothing eaten', () => {
    bootToTitle();
    expect(gResponderDemo(st, { type: 'keyup', data1: 27 })).toBe(false);
    // not on the demo screen (GS_LEVEL): pass-through
    st.gamestate = GS.LEVEL;
    expect(gResponderDemo(st, { type: 'keydown', data1: 27 })).toBe(false);
    expect(menuState.menuActive()).toBe(false);
    // pending gameaction ⇒ guard false (:522), even on the demo screen
    st.gamestate = GS.DEMOSCREEN;
    st.gameaction = GA.completed;
    expect(gResponderDemo(st, { type: 'keydown', data1: 27 })).toBe(false);
    expect(menuState.menuActive()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 3. D_PageDrawer (d_main.c:434-438) — the display seam                */
/* ------------------------------------------------------------------ */

describe('D_PageDrawer', () => {
  it('draws pagename (TITLEPIC) at (0,0) of screens[FG]', () => {
    bootToTitle();
    dPageDrawer();
    const fill = lumpFill('TITLEPIC');
    expect(screens[FG]!.data.every((v) => v === fill)).toBe(true);
  });

  it('no wad ⇒ counted, never throws', () => {
    dSetWad(null);
    dPageDrawer();
    expect(titleStubHits.byName.get('draw:TITLEPIC')).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4. quit-yes / endgame-yes ⇒ title (D-0zz, acceptance 2 half)         */
/* ------------------------------------------------------------------ */

describe('D_StartTitle as the quit/endgame target (D-0zz)', () => {
  it('from GS_FINALE: gStartTitle (menu.ts seam) pages into the title', () => {
    bootToTitle();
    st.gamestate = GS.FINALE; // e.g. HELP2 held after E1M8
    st.wipegamestate = GS.FINALE;
    gStartTitle(st); // menu.ts M_QuitResponse/M_EndGameResponse call THIS
    expect(titleState.demosequence()).toBe(-1); // :528
    gFlowTic(st); // next tic block: D_DoAdvanceDemo (:381)
    expect(st.gamestate).toBe(GS.DEMOSCREEN);
    expect(st.usergame).toBe(false);
    expect(titleState.pagename()).toBe('TITLEPIC');
    expect(dPageDrawer()).toBeUndefined();
    // the state-change wipe sentinel fires exactly once (d_main.c:216):
    expect(takeWipeRequest(st)).toBe(true);
    expect(takeWipeRequest(st)).toBe(false);
  });

  it('dStartTitle is the SAME body registered as the startTitle hook', () => {
    bootToTitle();
    st.gamestate = GS.LEVEL;
    st.advancedemo = false;
    dStartTitle(st);
    expect(st.advancedemo).toBe(true);
    expect(titleState.demosequence()).toBe(-1);
  });
});
