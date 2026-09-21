/**
 * Tests for ui/menu.ts — M9-04 (plan §M9-04 acceptance 1-4 + the draw
 * golden of acceptance 5's frame-hash half; the L5 PNG is M9-11/12).
 *
 * Transcription census rows cite m_menu.c lines directly; the responder
 * truth table pins every consumed/passthrough branch of :1349-1710; the
 * ticker pin proves the 8-tic skull (10/18/26… from M_Init's counter 10)
 * with ZERO M_Random draws (state.rng untouched — ledger finding).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { createHash } from 'node:crypto';
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
  gTicker,
  registerGameFlowHooks,
  resetGameFlow,
  resetFlowStubHits,
} from '../sim/game';
import type { GameState } from '../sim/state';
import { FG, screens, vInit } from '../render/vvideo';
import { createMenuMouse } from '../input/menuMouse';
import {
  KEY_BACKSPACE,
  KEY_DOWNARROW,
  KEY_ENTER,
  KEY_EQUALS,
  KEY_ESCAPE,
  KEY_F1,
  KEY_F2,
  KEY_F3,
  KEY_F4,
  KEY_F5,
  KEY_F6,
  KEY_F7,
  KEY_F8,
  KEY_F9,
  KEY_F10,
  KEY_F11,
  KEY_LEFTARROW,
  KEY_MINUS,
  KEY_RIGHTARROW,
  KEY_UPARROW,
} from '../input/keyboard';
import { resetGameactionLog, resetSfxStubLog, sfxStubLog } from '../sim/hooks';

import {
  EpiDef,
  EpisodeMenu,
  MainDef,
  MainMenu,
  NUM_QUITMESSAGES,
  NewDef,
  NewGameMenu,
  OptionsDef,
  OptionsMenu,
  ReadDef1,
  ReadDef2,
  SoundDef,
  SoundMenu,
  menuSeams,
  menuState,
  mInit,
  mRegisterFlow,
  mReset,
  mResponder,
  mDrawer,
  mTicker,
  mStartControlPanel,
  mClearMenus,
} from './menu';

/* ------------------------------------------------------------------ */
/* fixtures                                                             */
/* ------------------------------------------------------------------ */

/** Deterministic patch bytes: uniform fill keyed by the lump name. */
function solidPatch(w: number, h: number, fill: number): Uint8Array {
  const cols: number[][] = [];
  for (let c = 0; c < w; c++) cols.push(new Array(h).fill(fill % 256));
  return buildPatchFromColumns(cols, 0, 0);
}

const M_LUMPS: readonly string[] = [
  // m_menu.c transcribed draw set (§0.12 vanilla subset)
  'M_DOOM', 'M_NEWG', 'M_SKILL', 'M_EPISOD', 'M_OPTTTL', 'M_SVOL',
  'M_NGAME', 'M_OPTION', 'M_LOADG', 'M_SAVEG', 'M_RDTHIS', 'M_QUITG',
  'M_EPI1', 'M_EPI2', 'M_EPI3', 'M_EPI4',
  'M_JKILL', 'M_ROUGH', 'M_HURT', 'M_ULTRA', 'M_NMARE',
  'M_ENDGAM', 'M_MESSG', 'M_DETAIL', 'M_SCRNSZ', 'M_MSENS',
  'M_SFXVOL', 'M_MUSVOL', 'M_GDHIGH', 'M_GDLOW', 'M_MSGOFF', 'M_MSGON',
  'M_THERML', 'M_THERMM', 'M_THERMR', 'M_THERMO',
  'M_SKULL1', 'M_SKULL2',
  'HELP1', 'HELP2',
];

function lumpFill(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 251;
  return h + 1; // 1..251 (never the cleared-screen 0)
}

function menuWad(): WadFile {
  const b = new WadBuilder('IWAD');
  for (const name of M_LUMPS) {
    const big = name === 'HELP1' || name === 'HELP2';
    const skull = name.startsWith('M_SKULL');
    b.addLump(
      name,
      solidPatch(big ? 320 : skull ? 11 : 24, big ? 200 : skull ? 11 : 8, lumpFill(name)),
    );
  }
  for (let c = 33; c <= 95; c++) {
    b.addLump(`STCFN${String(c).padStart(3, '0')}`, solidPatch(5, 8, 17));
  }
  const bytes = b.build();
  return WadFile.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

const WAD = menuWad();

const SPEC: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 200 }],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }],
};

function fixMap(): ReturnType<typeof buildMapFromData> {
  const bytes = buildFixtureMapWad(SPEC);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP'));
}

function freshState(): GameState {
  return gInitGame(fixMap());
}

const down = (data1: number): { type: 'keydown'; data1: number } => ({ type: 'keydown', data1 });
const up = (data1: number): { type: 'keyup'; data1: number } => ({ type: 'keyup', data1 });
const ord = (c: string): number => c.charCodeAt(0);

/** Press + release; returns the keydown verdict (keyup must always be
 * false — g_game.c:571 — asserted alongside). */
function press(st: GameState, ch: number): boolean {
  const rc = mResponder(st, down(ch));
  expect(mResponder(st, up(ch))).toBe(false); // keyup NEVER eaten, every row
  return rc;
}

/** Vanilla alphaKey MOVES THE SKULL ONLY (:1660-1685) — then Enter. */
function hotkey(st: GameState, c: string): void {
  press(st, ord(c));
  press(st, KEY_ENTER);
}

let st: GameState;

beforeEach(() => {
  resetSfxStubLog();
  resetGameactionLog();
  resetGameFlow();
  resetFlowStubHits();
  menuSeams.automapActive = undefined;
  menuSeams.showMessages = undefined;
  menuSeams.setShowMessages = undefined;
  menuSeams.mouseArm = undefined;
  st = freshState();
  mReset(WAD);
  mRegisterFlow();
});

/* ------------------------------------------------------------------ */
/* 1. table census vs m_menu.c                                          */
/* ------------------------------------------------------------------ */

describe('table census (m_menu.c:250-443)', () => {
  it('MainMenu: 6 items, patches + hotkeys (:250-266)', () => {
    expect(MainMenu.map((i) => i.name)).toEqual([
      'M_NGAME', 'M_OPTION', 'M_LOADG', 'M_SAVEG', 'M_RDTHIS', 'M_QUITG',
    ]);
    expect(MainMenu.map((i) => i.status)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(MainMenu.map((i) => String.fromCharCode(i.alphaKey))).toEqual([
      'n', 'o', 'l', 's', 'r', 'q',
    ]);
    expect([MainDef.x, MainDef.y]).toEqual([97, 64]);
    expect(MainDef.prevMenu).toBe(null);
    expect(MainDef.lastOn).toBe(0);
    expect(MainDef.numitems).toBe(6);
  });

  it('EpisodeMenu: 4 rows, k/t/i/t, (48,63) prevMenu=Main; censor ⇒ 3 (:284-299, :1861-1874)', () => {
    expect(EpisodeMenu.map((i) => i.name)).toEqual(['M_EPI1', 'M_EPI2', 'M_EPI3', 'M_EPI4']);
    expect(EpisodeMenu.map((i) => String.fromCharCode(i.alphaKey))).toEqual(['k', 't', 'i', 't']);
    expect([EpiDef.x, EpiDef.y]).toEqual([48, 63]);
    expect(EpiDef.prevMenu).toBe(MainDef);
    // shareware falls through to registered in M_Init: numitems-- ⇒ 3
    expect(EpiDef.numitems).toBe(3);
  });

  it('NewGameMenu: 5 skills, lastOn=hurtme=2, prevMenu=EpiDef (:315-331)', () => {
    expect(NewGameMenu.map((i) => i.name)).toEqual([
      'M_JKILL', 'M_ROUGH', 'M_HURT', 'M_ULTRA', 'M_NMARE',
    ]);
    expect([NewDef.x, NewDef.y]).toEqual([48, 63]);
    expect(NewDef.lastOn).toBe(2); // hurtme
    expect(NewDef.prevMenu).toBe(EpiDef);
  });

  it('OptionsMenu: 8 rows incl. two status -1 empties; thermo rows 3/5 (:352-384)', () => {
    expect(OptionsMenu.length).toBe(8);
    expect(OptionsMenu.map((i) => i.status)).toEqual([1, 1, 1, 2, -1, 2, -1, 1]);
    expect(OptionsMenu[4]!.routine).toBe(null);
    expect(OptionsMenu[6]!.routine).toBe(null);
    expect(OptionsMenu[4]!.name).toBe('');
    expect([OptionsDef.x, OptionsDef.y]).toEqual([60, 37]);
    expect(OptionsDef.prevMenu).toBe(MainDef);
  });

  it('SoundMenu: 2 thermos + empties, (80,64) prevMenu=OptionsDef (:427-441)', () => {
    expect(SoundMenu.map((i) => i.status)).toEqual([2, -1, 2, -1]);
    expect([SoundDef.x, SoundDef.y]).toEqual([80, 64]);
    expect(SoundDef.prevMenu).toBe(OptionsDef);
  });

  it('ReadDef1/2: 1 empty-named hot-spot row, 280/185 + 330/175 (:391-417)', () => {
    expect(ReadDef1.menuitems[0]!.name).toBe('');
    expect([ReadDef1.x, ReadDef1.y]).toEqual([280, 185]);
    expect(ReadDef1.prevMenu).toBe(MainDef);
    expect([ReadDef2.x, ReadDef2.y]).toEqual([330, 175]);
    expect(ReadDef2.prevMenu).toBe(ReadDef1);
  });

  it('dstrings census: NUM_QUITMESSAGES == 22 (dstrings.h:56)', () => {
    expect(NUM_QUITMESSAGES).toBe(22);
  });
});

/* ------------------------------------------------------------------ */
/* 2. prevMenu navigation lifecycle (§0.1 — no push stack)               */
/* ------------------------------------------------------------------ */

describe('menu stack lifecycle (prevMenu chain)', () => {
  it('Esc popup ⇒ Main(lastOn); StartControlPanel idempotent while open', () => {
    expect(press(st, KEY_ESCAPE)).toBe(true);
    expect(menuState.menuActive()).toBe(true);
    expect(menuState.currentMenuName()).toBe('MainDef');
    press(st, KEY_DOWNARROW); // itemOn 1
    mStartControlPanel(st); // "intro might call this repeatedly" :1723
    expect(menuState.currentMenuName()).toBe('MainDef');
    expect(menuState.itemOn()).toBe(1); // NOT reset — already active
  });

  it('NewGame → EpiDef → (choice 0) → NewDef; Backspace restores lastOn', () => {
    press(st, KEY_ESCAPE);
    press(st, KEY_ENTER); // row 0 = newgame fires
    expect(menuState.currentMenuName()).toBe('EpiDef');
    press(st, KEY_ENTER); // M_Episode(0) ⇒ NewDef (epi=0)
    expect(menuState.currentMenuName()).toBe('NewDef');
    expect(menuState.itemOn()).toBe(2); // NewDef.lastOn = hurtme
    expect(menuState.epi()).toBe(0);
    press(st, KEY_DOWNARROW); // violence
    press(st, KEY_BACKSPACE); // NewDef→EpiDef, lastOn restored
    expect(menuState.currentMenuName()).toBe('EpiDef');
    expect(menuState.itemOn()).toBe(0); // EpiDef.lastOn from the Enter above
    expect(sfxStubLog.byName.get('sfx_swtchn')).toBe(2); // popup + backspace
    expect(sfxStubLog.byName.get('sfx_pistol')).toBe(2); // two Enters fired items
  });

  it('Esc closes from anywhere (menuactive=false + sfx_swtchx)', () => {
    press(st, KEY_ESCAPE);
    hotkey(st, 'o');
    expect(menuState.currentMenuName()).toBe('OptionsDef');
    expect(press(st, KEY_ESCAPE)).toBe(true);
    expect(menuState.menuActive()).toBe(false);
    expect(sfxStubLog.byName.get('sfx_swtchx')).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 3. responder truth table (m_menu.c:1349-1710)                         */
/* ------------------------------------------------------------------ */

describe('M_Responder truth table', () => {
  it('keyup is NEVER eaten — even mid-menu on live keys', () => {
    press(st, KEY_ESCAPE);
    for (const k of [KEY_UPARROW, KEY_DOWNARROW, KEY_ENTER, KEY_ESCAPE, KEY_BACKSPACE]) {
      expect(mResponder(st, up(k))).toBe(false);
    }
    expect(menuState.menuActive()).toBe(true); // up-ESC did not close
  });

  it('outside menu: only the F/-/=/ESC rows consume; others pass through', () => {
    // '-'/'=' are gated by automapactive/chat_on (:1527/:1534):
    menuSeams.automapActive = () => true;
    expect(mResponder(st, down(KEY_MINUS))).toBe(false);
    expect(mResponder(st, down(KEY_EQUALS))).toBe(false);
    menuSeams.automapActive = undefined;
    expect(mResponder(st, down(KEY_MINUS))).toBe(true);
    expect(mResponder(st, down(KEY_EQUALS))).toBe(true);
    const passthrough: number[] = [
      ord('w'), ord(' '), KEY_UPARROW, KEY_DOWNARROW, KEY_LEFTARROW,
      KEY_RIGHTARROW, KEY_ENTER, KEY_BACKSPACE, ord('n'),
    ];
    for (const k of passthrough) {
      expect(mResponder(st, down(k))).toBe(false);
    }
    expect(menuState.menuActive()).toBe(false); // nothing opened
  });

  it('every no-panel F-key consumes and does its vanilla action', () => {
    st.usergame = true;
    expect(press(st, KEY_F1)).toBe(true); // help: panel ON, ReadDef1 (shareware)
    expect(menuState.currentMenuName()).toBe('ReadDef1');
    expect(menuState.itemOn()).toBe(0);
    mClearMenus();
    expect(press(st, KEY_F2)).toBe(true); // M11 stub message armed
    expect(menuState.messageToPrint()).toBe(1);
    press(st, ord('x')); // non-input message: any key closes
    mClearMenus();
    expect(press(st, KEY_F3)).toBe(true);
    press(st, ord('x'));
    mClearMenus();
    expect(press(st, KEY_F4)).toBe(true); // sound volume menu
    expect(menuState.currentMenuName()).toBe('SoundDef');
    expect(menuState.itemOn()).toBe(0); // sfx_vol
    mClearMenus();
    const det0 = menuState.detailLevel();
    expect(press(st, KEY_F5)).toBe(true);
    expect(menuState.detailLevel()).toBe(1 - det0); // :1130 toggle only
    expect(press(st, KEY_F6)).toBe(true); // quicksave M11 stub
    press(st, ord('x'));
    mClearMenus();
    expect(press(st, KEY_F7)).toBe(true); // end-game confirm armed
    expect(menuState.messageText()).toContain('end the game');
    press(st, ord('n')); // NO ⇒ no title jump
    mClearMenus();
    const msgs0 = st.players[0]!.message;
    expect(press(st, KEY_F8)).toBe(true); // toggle messages, panel untouched
    expect(st.players[0]!.message).not.toBe(msgs0);
    expect(menuState.menuActive()).toBe(false);
    expect(press(st, KEY_F9)).toBe(true); // quickload stub message
    press(st, ord('x'));
    mClearMenus();
    expect(press(st, KEY_F10)).toBe(true); // quit confirm armed
    press(st, ord('n'));
    const g0 = menuState.useGamma();
    expect(press(st, KEY_F11)).toBe(true);
    expect(menuState.useGamma()).toBe(g0 === 4 ? 0 : g0 + 1);
    expect(st.players[0]!.message).toMatch(/^Gamma correction/);
  });

  it('within menu: arrows/enter/esc/backspace always consume', () => {
    press(st, KEY_ESCAPE);
    expect(mResponder(st, down(KEY_UPARROW))).toBe(true);
    expect(mResponder(st, down(KEY_DOWNARROW))).toBe(true);
    expect(mResponder(st, down(KEY_LEFTARROW))).toBe(true);
    expect(mResponder(st, down(KEY_RIGHTARROW))).toBe(true);
    expect(mResponder(st, down(KEY_ENTER))).toBe(true); // fired newgame row
    expect(mResponder(st, down(KEY_BACKSPACE))).toBe(true); // Main.prevMenu null
    expect(menuState.menuActive()).toBe(true);
  });

  it('status -1 cycling skips empty rows, sfx_pstop per hop (:1612-1643)', () => {
    press(st, KEY_ESCAPE);
    hotkey(st, 'o');
    expect(menuState.itemOn()).toBe(0); // OptionsDef.lastOn
    press(st, KEY_DOWNARROW);
    press(st, KEY_DOWNARROW);
    press(st, KEY_DOWNARROW); // → 3
    expect(menuState.itemOn()).toBe(3);
    press(st, KEY_DOWNARROW); // 3→(4: -1)→5 — TWO pstop hops
    expect(menuState.itemOn()).toBe(5);
    press(st, KEY_UPARROW); // 5→(4)→3
    expect(menuState.itemOn()).toBe(3);
    press(st, KEY_DOWNARROW); // 3→5
    press(st, KEY_DOWNARROW); // 5→(6:-1)→7
    expect(menuState.itemOn()).toBe(7);
    press(st, KEY_DOWNARROW); // wrap → 0 (:1614)
    expect(menuState.itemOn()).toBe(0);
  });

  it('alphaKey moves the SKULL (forward-then-wrapped), case-sensitive (:1660-1685)', () => {
    press(st, KEY_ESCAPE);
    expect(press(st, ord('o'))).toBe(true); // skull 0→1, NO fire
    expect(menuState.currentMenuName()).toBe('MainDef');
    expect(menuState.itemOn()).toBe(1);
    expect(press(st, ord('O'))).toBe(false); // uppercase never matches
    expect(press(st, ord('n'))).toBe(true); // forward: 1→...none; wrap 0→0
    expect(menuState.itemOn()).toBe(0);
  });

  it('alphaKey wrap in the skill menu: u forward, i wrapped (:1670-1685)', () => {
    press(st, KEY_ESCAPE);
    press(st, KEY_ENTER); // newgame ⇒ EpiDef
    press(st, KEY_ENTER); // episode 1 ⇒ NewDef lastOn 2
    expect(menuState.currentMenuName()).toBe('NewDef');
    expect(menuState.itemOn()).toBe(2);
    expect(press(st, ord('u'))).toBe(true); // forward 3.. ⇒ row 3
    expect(menuState.itemOn()).toBe(3);
    expect(press(st, ord('i'))).toBe(true); // forward 4 ('n') no ⇒ wrap row 0
    expect(menuState.itemOn()).toBe(0);
    expect(press(st, ord('q'))).toBe(false); // no 'q' hotkey here
  });

  it('thermo rows: ←/→ adjust + sfx_stnmov; Enter fires RIGHT (:1645-1668)', () => {
    press(st, KEY_F4);
    const v0 = menuState.sndVolumes()[0];
    expect(menuState.itemOn()).toBe(0);
    press(st, KEY_RIGHTARROW);
    expect(menuState.sndVolumes()[0]).toBe(v0 + 1);
    expect(sfxStubLog.byName.get('sfx_stnmov')).toBe(1);
    press(st, KEY_LEFTARROW);
    expect(menuState.sndVolumes()[0]).toBe(v0);
    press(st, KEY_ENTER); // status 2 ⇒ routine(1)
    expect(menuState.sndVolumes()[0]).toBe(v0 + 1);
    press(st, KEY_DOWNARROW); // empty row 1 is SKIPPED by the cycle (:1617)
    expect(menuState.itemOn()).toBe(2); // lands on music_vol
    press(st, KEY_LEFTARROW); // music row: music vol down
    expect(menuState.sndVolumes()[1]).toBe(menuState.sndVolumes()[1]);
    expect(menuState.sndVolumes()[0]).toBe(v0 + 1);
  });

  it('input-message gate: only space/n/y/ESC pass (needsInput), then sfx_swtchx', () => {
    st.usergame = true;
    press(st, KEY_F7); // ENDGAME, needsInput=true
    for (const k of [ord('x'), KEY_ENTER, KEY_BACKSPACE, KEY_DOWNARROW, ord('a')]) {
      expect(mResponder(st, down(k))).toBe(false);
    }
    expect(menuState.messageToPrint()).toBe(1);
    expect(press(st, KEY_ESCAPE)).toBe(true); // cancels; ch != 'y' ⇒ no fire
    expect(menuState.menuActive()).toBe(false);
    let titles = 0;
    registerGameFlowHooks({ startTitle: () => titles++ });
    press(st, KEY_F7);
    expect(press(st, ord(' '))).toBe(true); // accepted, not 'y'
    expect(titles).toBe(0);
    press(st, KEY_F7);
    expect(press(st, ord('n'))).toBe(true);
    expect(titles).toBe(0);
    press(st, KEY_F7);
    expect(press(st, ord('y'))).toBe(true); // M_EndGameResponse ⇒ D_StartTitle
    expect(titles).toBe(1);
    expect(menuState.menuActive()).toBe(false);
    expect(sfxStubLog.byName.get('sfx_swtchx')).toBe(4); // every message dismissal
  });

  it('quit: gametic-indexed endmsg + DOSY; y ⇒ quitsounds[(gametic>>2)&7] + title', () => {
    st.gametic = 8; // english path: endmsg[(8 % 20) + 1] = endmsg[9]
    expect(press(st, KEY_F10)).toBe(true);
    expect(menuState.messageText()).toContain('(press y to quit)');
    expect(menuState.messageText().startsWith("don't go now")).toBe(true);
    let titles = 0;
    registerGameFlowHooks({ startTitle: () => titles++ });
    press(st, ord('y')); // D-0zz: I_Quit ⇒ title
    expect(sfxStubLog.byName.get('sfx_popain')).toBe(1); // quitsounds[2]
    expect(titles).toBe(1);
    expect(menuState.menuActive()).toBe(false);
  });

  it('!usergame: F7 end-game ⇒ sfx_oof, no message (m_menu.c:1007-1010)', () => {
    st.usergame = false;
    expect(press(st, KEY_F7)).toBe(true);
    expect(menuState.messageToPrint()).toBe(0);
    expect(sfxStubLog.byName.get('sfx_oof')).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4. ticker: skull every 8 tics from init 10; NO PRNG draws             */
/* ------------------------------------------------------------------ */

describe('M_Ticker (m_menu.c:1834)', () => {
  it('toggles at tics 10, 18, 26… with ZERO M_Random draws', () => {
    const rng0 = { ...st.rng };
    const flips: number[] = [];
    let prev = menuState.whichSkull();
    for (let t = 1; t <= 26; t++) {
      mTicker(st);
      if (menuState.whichSkull() !== prev) {
        flips.push(t);
        prev = menuState.whichSkull();
      }
    }
    expect(flips).toEqual([10, 18, 26]);
    expect(st.rng).toEqual(rng0); // ledger: menu burns NO mRandom
  });

  it('gFlowTic (d_main.c:382 seam) drives it once per tic', () => {
    mInit(WAD); // skullAnimCounter = 10
    for (let t = 0; t < 10; t++) gFlowTic(st);
    expect(menuState.whichSkull()).toBe(1);
    for (let t = 0; t < 7; t++) gFlowTic(st);
    expect(menuState.whichSkull()).toBe(1);
    gFlowTic(st); // tic 18
    expect(menuState.whichSkull()).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 5. shareware censor + episode ad divert (:919-943, §0.7/§0.12)        */
/* ------------------------------------------------------------------ */

describe('episode policy (shareware)', () => {
  it('↓ cycle shows 3 rows; choice!=0 ⇒ SWSTRING ad + ReadDef1 (NOT skill menu)', () => {
    press(st, KEY_ESCAPE);
    press(st, KEY_ENTER); // ⇒ EpiDef
    expect(menuState.currentMenuName()).toBe('EpiDef');
    let maxOn = 0;
    for (let i = 0; i < 4; i++) {
      press(st, KEY_DOWNARROW);
      maxOn = Math.max(maxOn, menuState.itemOn());
    }
    expect(maxOn).toBe(2); // 3 items: wraps 0..2, NEVER row 3
    press(st, KEY_ENTER); // M_Episode(2): shareware ad divert
    expect(menuState.currentMenuName()).toBe('ReadDef1');
    expect(menuState.messageText()).toContain('shareware version of doom');
    expect(menuState.messageText()).toContain('order the entire trilogy');
    press(st, ord('x')); // non-input message closes — vanilla :1499
    expect(menuState.menuActive()).toBe(false); // forces false (quirk, pinned)
    expect(menuState.currentMenuName()).toBe('ReadDef1'); // the ad page stays current
    // The ad page only DRAWS while the panel is open: F1 opens ReadDef1
    press(st, KEY_F1);
    mDrawer();
    expect(menuState.inHelpScreens()).toBe(true); // HELP1 page
  });

  it("hotkey 'i' reaches row 3's routine — the ad path too (censor is display-side)", () => {
    press(st, KEY_ESCAPE);
    press(st, KEY_ENTER); // EpiDef
    press(st, ord('i')); // skull → row 2 (ep3)
    expect(menuState.itemOn()).toBe(2);
    press(st, KEY_ENTER);
    expect(menuState.currentMenuName()).toBe('ReadDef1'); // ad (choice 2 != 0)
  });

  it('episode 0 selects NewDef with epi = 0 (skill ⇒ G_DeferedInitNew(…,1,1))', () => {
    press(st, KEY_ESCAPE);
    press(st, KEY_ENTER); // EpiDef row0
    press(st, KEY_BACKSPACE); // down to row 0 via wrap? Main→ use Enter path
    expect(menuState.currentMenuName()).toBe('MainDef');
    press(st, KEY_ENTER); // newgame again
    press(st, KEY_ENTER); // episode 1
    expect(menuState.epi()).toBe(0);
    expect(menuState.currentMenuName()).toBe('NewDef');
  });
});

/* ------------------------------------------------------------------ */
/* 6. skill select → deferred init drains in ONE gTicker                 */
/* ------------------------------------------------------------------ */

describe('skill select wiring (M9-03 plumbing)', () => {
  const toNightmare = (): void => {
    press(st, KEY_ESCAPE);
    press(st, ord('n')); // skull → newgame row
    press(st, KEY_ENTER); // ⇒ EpiDef
    press(st, ord('k')); // skull → episode 1 row (deterministic)
    press(st, KEY_ENTER); // ⇒ NewDef
    press(st, ord('n')); // wrapped scan ⇒ nightmare row (4) whatever lastOn
    expect(menuState.itemOn()).toBe(4);
  };

  it('Enter on nightmare ⇒ NIGHTMARE verify; only y fires the deferred init', () => {
    toNightmare();
    expect(menuState.itemOn()).toBe(4);
    press(st, KEY_ENTER);
    expect(menuState.messageToPrint()).toBe(1);
    expect(menuState.messageText()).toContain('remotely fair');
    expect(st.gameaction).toBe(GA.nothing);
    press(st, ord('n')); // cancel
    expect(st.gameaction).toBe(GA.nothing);
    toNightmare();
    press(st, KEY_ENTER);
    press(st, ord('y'));
    expect(st.gameaction).toBe(GA.newgame);
    expect(st.gameskill).toBe(5); // 1-based domain (gamemode.ts)
    expect(st.gameepisode).toBe(1);
    expect(st.gamemap).toBe(1); // skill menu ALWAYS map 1 (§0.7)
    expect(menuState.menuActive()).toBe(false);
  });

  it('the deferred init drains to a LEVEL load in ONE gTicker', () => {
    st.gamestate = GS.DEMOSCREEN;
    st.wipegamestate = GS.DEMOSCREEN;
    const loaded: Array<{ ep: number; map: number }> = [];
    registerGameFlowHooks({
      levelLoader: (_s, ep, map) => {
        loaded.push({ ep, map });
        return fixMap();
      },
    });
    press(st, KEY_ESCAPE);
    press(st, KEY_ENTER); // newgame
    press(st, KEY_ENTER); // episode 1
    press(st, KEY_UPARROW); // itemOn 1 = rough (skill 2)
    press(st, KEY_ENTER);
    expect(st.gameaction).toBe(GA.newgame);
    gTicker(st); // ONE call: ga_newgame → G_DoNewGame → level load
    expect(st.gameaction).toBe(GA.nothing);
    expect(st.gamestate).toBe(GS.LEVEL);
    expect(loaded).toEqual([{ ep: 1, map: 1 }]);
    expect(st.gameskill).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* 7. mouse-only navigation via the menuMouse synth (D-0yy)              */
/* ------------------------------------------------------------------ */

describe('menu mouse synth nav (M9-02 seam)', () => {
  let evs: { type: 'keydown' | 'keyup'; data1: number }[];
  let mm: ReturnType<typeof createMenuMouse>;

  beforeEach(() => {
    evs = [];
    mm = createMenuMouse({
      onEvent: (e) => evs.push(e),
      currentIndex: () => menuState.itemOn(),
    });
    menuSeams.mouseArm = (boxes) => mm.setItems(boxes ?? []);
  });

  const pump = (): void => {
    const q = evs;
    evs = [];
    for (const e of q) mResponder(st, e);
  };

  it('arming follows the menu lifecycle; hover reaches EVERY Main item', () => {
    mStartControlPanel(st);
    expect(mm.armed()).toBe(true);
    for (let i = 0; i < 6; i++) {
      mm.hover(MainDef.x + 4, MainDef.y + i * 16 + 8);
      pump();
      expect(menuState.itemOn()).toBe(i);
    }
    mClearMenus();
    expect(mm.armed()).toBe(false);
  });

  it('click fires Enter on the hovered row (newgame ⇒ EpiDef)', () => {
    mStartControlPanel(st);
    mm.click(MainDef.x + 4, MainDef.y + 8);
    pump();
    expect(menuState.currentMenuName()).toBe('EpiDef');
  });

  it('wheel = ±1 row', () => {
    mStartControlPanel(st);
    mm.wheel(0, 0, +100);
    pump();
    expect(menuState.itemOn()).toBe(1);
    mm.wheel(0, 0, -100);
    pump();
    expect(menuState.itemOn()).toBe(0);
  });

  it('messages disarm the boxes (no phantom rows)', () => {
    mStartControlPanel(st);
    expect(mm.armed()).toBe(true);
    press(st, ord('q')); // skull → quit row
    press(st, KEY_ENTER); // M_QuitDOOM ⇒ message armed
    expect(mm.armed()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 8. drawer over vvideo: frame-hash golden + spot pixels (acc. 5)       */
/* ------------------------------------------------------------------ */

function fgHash(): string {
  return createHash('sha256').update(screens[FG]!.data).digest('hex');
}

const px = (idx: Uint8Array, x: number, y: number): number => idx[y * 320 + x]!;

/** Deterministic golden captured from THIS implementation (synthetic
 * menu WAD, MainDef frame, skull 0): any table/routine/geometry change
 * re-keys it (cites travel with the diff). */
const GOLDEN_MAIN_FRAME =
  '7242772a7dd48cded9aa3969eb8f39c8c230162b3a6deb3888f2dc925ad4694e';

describe('M_Drawer (vvideo integration)', () => {
  it('Main screen frame: draw golden + item/skull spot pixels', () => {
    vInit();
    mStartControlPanel(st);
    mDrawer();
    expect(fgHash()).toBe(GOLDEN_MAIN_FRAME);
    const idx = screens[FG]!.data;
    // M_DOOM header at (94,2) (:858), items at (97, 64+i*16) (:1785-1793)
    expect(px(idx, 94 + 2, 2 + 2)).toBe(lumpFill('M_DOOM'));
    expect(px(idx, 97 + 2, 64 + 2)).toBe(lumpFill('M_NGAME'));
    expect(px(idx, 97 + 2, 64 + 16 * 5 + 2)).toBe(lumpFill('M_QUITG'));
    // skull: (x + SKULLXOFF, menuY - 5 + itemOn*16) (:1796-1798)
    expect(px(idx, 97 - 32 + 2, 64 - 5 + 2)).toBe(lumpFill('M_SKULL1'));
    expect(px(idx, 97 - 32 + 2, 64 - 5 + 16 * 5 + 2)).toBe(0); // row 5 dark
    expect(px(idx, 10, 190)).toBe(0); // untouched field
  });

  it('message path: centered STCFN lines only (no menu patches)', () => {
    vInit();
    st.usergame = true;
    press(st, KEY_F7); // ENDGAME message, needsInput
    mDrawer();
    const idx = screens[FG]!.data;
    let ink = 0;
    for (let i = 0; i < idx.length; i++) if (idx[i] !== 0) ink++;
    expect(ink).toBeGreaterThan(100); // glyph pixels (fill 17)
    let centreInk = false; // the centered lines straddle the screen centre
    for (let x = 100; x < 220 && !centreInk; x++) {
      for (let y = 92; y < 108 && !centreInk; y++) if (idx[y * 320 + x] === 17) centreInk = true;
    }
    expect(centreInk).toBe(true);
  });

  it('options thermos + detail/msg state pixels at the m_menu.c rows', () => {
    vInit();
    press(st, KEY_ESCAPE);
    hotkey(st, 'o');
    mDrawer();
    const idx = screens[FG]!.data;
    expect(px(idx, 108 + 2, 15 + 2)).toBe(lumpFill('M_OPTTTL')); // :961
    // mousesens thermo: y = 37 + 16*(5+1), M_THERML at x=60 (:1181-1198)
    expect(px(idx, 60 + 2, 37 + 96 + 2)).toBe(lumpFill('M_THERML'));
    expect(px(idx, 68 + 5 * 8 + 2, 37 + 96 + 2)).toBe(lumpFill('M_THERMO')); // dot at 5
    // detail lump detailNames[detailLevel] at x+175 row 2 — the 1.10 table
    // is [0]=HIGH/[1]=LOW so the DEFAULT detailLevel 1 draws M_GDLOW
    // (m_menu.c:953/:964 — quirk transcribed, not corrected).
    expect(px(idx, 60 + 175 + 2, 37 + 32 + 2)).toBe(lumpFill('M_GDLOW'));
    // messages msgNames[showMessages] at x+120 row 1 (showMessages=1 ON)
    expect(px(idx, 60 + 120 + 2, 37 + 16 + 2)).toBe(lumpFill('M_MSGON'));
  });
});
