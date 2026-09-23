/**
 * ui/menu.ts — m_menu.c verbatim model (M9-04, plan §M9-04 / §0.7).
 *
 * The 1993 control panel: item/window tables transcribed from
 * m_menu.c:250-376, the prevMenu navigation idiom (§0.1 — NO push/backup
 * stack), M_Responder's key map byte-for-byte (:1349-1710), the 8-tic
 * skull ticker (:1834), and M_Drawer over the M9-01 vvideo blitter
 * (:1723-1820).
 *
 * DRAW-TEXT VERDICT (source): menu ITEMS are patches (M_NGAME & co.),
 * but TEXT (messages, quit screens) is drawn with the HU font:
 * M_StringWidth/M_StringHeight/M_WriteText (m_menu.c:1243-1319) index
 * `hu_font[c]` = STCFN%.3d lumps and blit via V_DrawPatchDirect. Zero
 * STTNUM/M_TextPrint/M_DrawNum/M_DrawChar use anywhere in m_menu.c
 * (grep; those are Crispy/later-source names, plan §0.1 idiom) —
 * M_WriteText's newline is cy += 12 (:1300), M_StringHeight counts
 * lines with hu_font[0]->height (hu_font[0] = STCFN033 — the
 * HU_FONTSTART glyph, hu_stuff.c:392-414), unknown chars advance 4px
 * (:1257/:1289/:1310).
 *
 * RNG LEDGER FINDING: m_menu.c contains ZERO M_Random() draws (grep
 * clean — quit message/sfx indices are gametic arithmetic,
 * m_menu.c:1105/:1074-1081), so this module adds NOTHING to the
 * M_Random stream. The plan §0.8 ledger line belongs to ST_Ticker
 * (M9-05), not here.
 *
 * MOUSE FINDING (D-0yy refinement): §0.7's "m_menu.c contains ZERO
 * ev_mouse handling" is slightly off — m_menu.c:1397-1437 DOES hold an
 * ev_mouse wheel-emulation branch (±30 accumulators, mousewait). This
 * port keeps the D-0yy design: menuMouse.ts synthesizes vanilla
 * keydown/keyup arrow/Enter pairs consumed by mResponder verbatim, so
 * the ev_mouse branch is intentionally NOT transcribed (deviation).
 *
 * SFX policy D-0xx (CLOSED M10-04): every S_StartSound site is now an
 * event emit via hooks.sfxSink(name). QUIT: I_Quit maps to the D_StartTitle browser
 * target (D-0zz) via the game.ts `startTitle` flow hook.
 *
 * SKILL DOMAIN: vanilla passes 0-based game-skills to
 * G_DeferedInitNew; this port's seam is 1-based (gamemode.ts header), so
 * M_ChooseSkill calls gDeferedInitNew(choice + 1, epi + 1, 1).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

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
  type KeyboardEventPacket,
} from '../input/keyboard';
import type { MenuItemBox } from '../input/menuMouse';
import { lumpPatch, vDrawPatchDirect, FG, type VPatch } from '../render/vvideo';
import type { WadFile } from '../wad/wadfile';
import { sfxSink } from '../sim/hooks';
import { GAME_MODE } from '../sim/gamemode';
import { gDeferedInitNew, gSaveGame, gStartTitle, GS, registerGameFlowHooks } from '../sim/game';
import type { GameState } from '../sim/state';
import { EMPTYSTRING, QLPROMPT, QSAVESPOT, QSPROMPT, SAVEDEAD } from './textdata';

/* ------------------------------------------------------------------ */
/* event alias (the queue's event_t; keyboard.ts packet shape)          */
/* ------------------------------------------------------------------ */

export type MenuEvent = KeyboardEventPacket;

/* ------------------------------------------------------------------ */
/* menu_t / menuitem_t (m_menu.c:138-169)                               */
/* ------------------------------------------------------------------ */

/** m_menu.c:141-155 `menuitem_t`. status: 0 = no cursor, 1 = ok,
 * 2 = arrows ok, -1 = empty row (the tables' `{-1,"",0}` idiom). */
export interface MenuItem {
  status: number;
  /** patch lump name ('' = empty cell) */
  name: string;
  /** choice = menu item #; status 2 ⇒ 0:left, 1:right (NULL for -1 rows) */
  routine: ((choice: number) => void) | null;
  /** hotkey in menu (char code, lowercase; 0 = none) */
  alphaKey: number;
}

/** m_menu.c:157-168 `menu_t` (prevMenu-linked navigation, §0.1). */
export interface Menu {
  numitems: number;
  prevMenu: Menu | null;
  menuitems: MenuItem[];
  routine: (() => void) | null;
  x: number;
  y: number;
  lastOn: number;
  /** debug/test label (not in the C struct) */
  readonly defName: string;
}

const SKULLXOFF = -32; // m_menu.c:132
const LINEHEIGHT = 16; // m_menu.c:133

/** m_menu.c:175 skullName[2] = {"M_SKULL1","M_SKULL2"} */
const skullName = ['M_SKULL1', 'M_SKULL2'] as const;

/* ------------------------------------------------------------------ */
/* d_englsh.h strings (transcribed verbatim, :39-74)                    */
/* ------------------------------------------------------------------ */

const PRESSKEY = 'press a key.'; // :39
const PRESSYN = 'press y or n.'; // :40
const QUITMSG = 'are you sure you want to\nquit this great game?'; // :41
// M11-03: the save/load string block (LOADNET :42, QLOADNET :43,
// QSAVESPOT :44, SAVEDEAD :45, QSPROMPT :46, QLPROMPT :47, EMPTYSTRING
// :75, GGSAVED :135) lives in ./textdata.ts (plan §M11-03 ownership);
// re-exported where the old in-file consts were consumed.
export { EMPTYSTRING, GGSAVED, LOADNET, QLOADNET, QLPROMPT, QSAVESPOT, QSPROMPT, SAVEDEAD } from './textdata';
export const NEWGAME =
  "you can't start a new game\nwhile in a network game.\n\n" + PRESSKEY; // :49-51
const NIGHTMARE =
  "are you sure? this skill level\nisn't even remotely fair.\n\n" + PRESSYN; // :53-55
const SWSTRING =
  'this is the shareware version of doom.\n\nyou need to order the entire trilogy.\n\n' +
  PRESSKEY; // :57-60
const MSGOFF = 'Messages OFF'; // :61
const MSGON = 'Messages ON'; // :62
export const NETEND = "you can't end a netgame!\n\n" + PRESSKEY; // :63
const ENDGAME = 'are you sure you want to end the game?\n\n' + PRESSYN; // :64
const DOSY = '(press y to quit)'; // :66
export const DETAILHI = 'High detail'; // :68
export const DETAILLO = 'Low detail'; // :69
const gammamsg = [
  // :70-74
  'Gamma correction OFF',
  'Gamma correction level 1',
  'Gamma correction level 2',
  'Gamma correction level 3',
  'Gamma correction level 4',
] as const;

/** dstrings.c:35-79 endmsg[NUM_QUITMESSAGES+1] — DOOM1 block + the 22
 * id strings (language==english path, m_menu.c:1105). */
export const NUM_QUITMESSAGES = 22; // dstrings.h:56
const endmsg: readonly string[] = [
  QUITMSG, // DOOM1 (index 0, non-english path)
  "please don't leave, there's more\ndemons to toast!",
  "let's beat it -- this is turning\ninto a bloodbath!",
  "i wouldn't leave if i were you.\ndos is much worse.",
  "you're trying to say you like dos\nbetter than me, right?",
  "don't leave yet -- there's a\ndemon around that corner!",
  'ya know, next time you come in here\ni\'m gonna toast ya.',
  'go ahead and leave. see if i care.',
  // QuitDOOM II messages
  'you want to quit?\nthen, thou hast lost an eighth!',
  "don't go now, there's a \ndimensional shambler waiting\nat the dos prompt!",
  'get outta here and go back\nto your boring programs.',
  "if i were your boss, i'd \n deathmatch ya in a minute!",
  'look, bud. you leave now\nand you forfeit your body count!',
  'just leave. when you come\nback, i\'ll be waiting with a bat.',
  "you're lucky i don't smack\nyou for thinking about leaving.",
  // FinalDOOM?
  'fuck you, pussy!\nget the fuck out!',
  "you quit and i'll jizz\nin your cystholes!",
  "if you leave, i'll make\nthe lord drink my jizz.",
  "hey, ron! can we say\n'fuck' in the game?",
  "i'd leave: this is just\nmore monsters and levels.\nwhat a load.",
  "suck it down, asshole!\nyou're a fucking wimp!",
  "don't quit now! we're \nstill spending your money!",
  // Internal debug. Different style, too.
  'THIS IS NO MESSAGE!\nPage intentionally left blank.',
];

/* ------------------------------------------------------------------ */
/* file-scope state (m_menu.c:105-136)                                */
/* ------------------------------------------------------------------ */

export interface MenuSeams {
  /** automapactive for the '-'/=' gate (m_menu.c:1527/:1534). */
  automapActive?: () => boolean;
  /** chat_on for the same gate (:1527) — no chat in this build: false. */
  chatOn?: () => boolean;
  /** showMessages (hu_stuff.c global; M9-06 owns the flag, §M9-06 F8). */
  setShowMessages?: (on: boolean) => void;
  showMessages?: () => boolean;
  /** R_SetViewSize (m_menu.c:1161) — M9-09's view-size seam. */
  setViewSize?: (screenblocks: number, detail: number) => void;
  /** I_SetPalette (m_menu.c:1591 gamma) — palette seam (M9-05/09). */
  setPalette?: () => void;
  /** menuMouse arming sink: boxes on menu change, null ⇒ disarm. */
  mouseArm?: (boxes: readonly MenuItemBox[] | null, current: () => number) => void;
  /** M11-03 save-slot read view (m_menu.c:511-536 M_ReadSaveStrings).
   * The persist layer keeps a LAST-KNOWN SNAPSHOT warm (store.listSaves
   * is async; the menu never awaits — D-11b), refreshed pre-open by the
   * M11-05 glue. Absent ⇒ every row reads as a hole (EMPTYSTRING). */
  saveRows?: () => readonly SaveRowView[];
  /** M11-03 M_LoadSelect's G_LoadGame half (m_menu.c:583): the adapter
   * decodes the slot and arms gRequestLoadGame (async, outside the
   * menu). Absent ⇒ counted stub, the menu still closes (:589). */
  requestLoadSlot?: (slot: number) => void;
}

/** One slot face of the injected read view (store.ts SaveRow mirror,
 * structural so src/ui imports NOTHING from src/persist — zone rule). */
export interface SaveRowView {
  description: string;
  empty: boolean;
}

/** Counted stub sites (sfx-free evidence + M10/M9-09 seam placeholders). */
export const menuStubHits = { count: 0, byName: new Map<string, number>() };

export function resetMenuStubHits(): void {
  menuStubHits.count = 0;
  menuStubHits.byName.clear();
}

function menuStub(name: string): void {
  menuStubHits.count++;
  menuStubHits.byName.set(name, (menuStubHits.byName.get(name) ?? 0) + 1);
}

/** The registered seams (main.ts wiring; tests inject). */
export const menuSeams: MenuSeams = {};

/* --- m_menu.c file-scope state -------------------------------------- */

let wad: WadFile | null = null;
let gs: GameState | null = null; // the state the current call runs on

let menuactive = false; // :135
let inhelpscreens = false; // :134 (reset every M_Drawer)
let currentMenu: Menu = null as unknown as Menu; // :178 (set by M_Init)
let itemOn = 0; // :171
let skullAnimCounter = 10; // :172
let whichSkull = 0; // :173
let epi = 0; // :886 (M_Episode's deferred episode index, 0-based)

let messageToPrint = 0; // :111
let messageString = ''; // :112
let messageRoutine: ((ch: number) => void) | null = null; // :113
let messageNeedsInput = false; // :115
let messageLastMenuActive = false; // :114

let quickSaveSlot = -1; // :120 (M11: -1 unset, -2 “pick a slot now”, ≥0 last used)

/* --- M11-03 save-slot strings + string editor (m_menu.c:89-132) ------ */

/** g_game.c:75 SAVESTRINGSIZE (savegamestrings[10][24], m_menu.c:132). */
const SAVESTRINGSIZE = 24;
/** m_menu.c:460 `load_end` — the menu exposes SIX rows (§0.4: the
 * brief’s “ten slots” corrected; the array is 10, only 0..5 are shown). */
const LOAD_END = 6;

/** savegamestrings[10][SAVESTRINGSIZE] (m_menu.c:132). JS strings stand
 * in for the char rows (NUL termination ≡ truncation). */
const savegamestrings: string[] = new Array(10).fill(EMPTYSTRING);

/** m_menu.c:119-123 the string-editor state machine (see the
 * mResponder branch :1453-1490 — the char switch lives there). */
let saveStringEnter = 0; // :119
let saveSlot = 0; // :120
let saveCharIndex = 0; // :121
let saveOldString = ''; // :123 char saveOldString[SAVESTRINGSIZE]

/* option state (m_menu.c decls; defaults = m_misc.c:237/:279/:108)   */
let screenSize = 6; // screenblocks - 3 (M_Init :1854)
let screenblocks = 9; // m_misc.c:279 shipped default
let mouseSensitivity = 5; // m_misc.c default_sensitivity
let detailLevel = 1; // 1 = high detail (m_menu.c:37)
let usegamma = 0; // :44
let sndSfxVolume = 8; // m_misc.c:237 default
let sndMusicVolume = 8; // m_misc.c:238 default

/* ------------------------------------------------------------------ */
/* the tables (m_menu.c:250-443)                                        */
/* ------------------------------------------------------------------ */

/** main_e (m_menu.c:237-244) */
export const main_e = { newgame: 0, options: 1, loadgame: 2, savegame: 3, readthis: 4, quitdoom: 5 } as const;
/** episodes_e (:272-278) */
export const ep_e = { ep1: 0, ep2: 1, ep3: 2, ep4: 3 } as const;
/** newgame_e (:306-312) — `nightmare` also gates M_ChooseSkill (:905) */
export const newg_e = { killthings: 0, toorough: 1, hurtme: 2, violence: 3, nightmare: 4 } as const;
export const nightmare = newg_e.nightmare;
/** options_e (:337-347) */
export const opt_e = {
  endgame: 0, messages: 1, detail: 2, scrnsize: 3, option_empty1: 4,
  mousesens: 5, option_empty2: 6, soundvol: 7,
} as const;
/** sound_e (:420-425) */
export const sound_e = { sfx_vol: 0, sfx_empty1: 1, music_vol: 2, sfx_empty2: 3 } as const;

const ord = (c: string): number => c.charCodeAt(0);
const EMPTY_ROW: MenuItem = { status: -1, name: '', routine: null, alphaKey: 0 };

export const MainMenu: MenuItem[] = [
  // m_menu.c:250-257
  { status: 1, name: 'M_NGAME', routine: mNewGame, alphaKey: ord('n') },
  { status: 1, name: 'M_OPTION', routine: mOptions, alphaKey: ord('o') },
  { status: 1, name: 'M_LOADG', routine: mLoadGame, alphaKey: ord('l') },
  { status: 1, name: 'M_SAVEG', routine: (c) => mSaveGame(c), alphaKey: ord('s') },
  // Another hickup with Special edition.
  { status: 1, name: 'M_RDTHIS', routine: mReadThis, alphaKey: ord('r') },
  { status: 1, name: 'M_QUITG', routine: mQuitDOOM, alphaKey: ord('q') },
];

export const EpisodeMenu: MenuItem[] = [
  // :284-289 — note the vanilla 'k','t','i','t' hotkey set (the 2nd/4th
  // share 't': the forward-then-wrapped scan reaches ep2 first).
  { status: 1, name: 'M_EPI1', routine: (c) => mEpisode(c), alphaKey: ord('k') },
  { status: 1, name: 'M_EPI2', routine: (c) => mEpisode(c), alphaKey: ord('t') },
  { status: 1, name: 'M_EPI3', routine: (c) => mEpisode(c), alphaKey: ord('i') },
  { status: 1, name: 'M_EPI4', routine: (c) => mEpisode(c), alphaKey: ord('t') },
];

export const NewGameMenu: MenuItem[] = [
  // :315-321
  { status: 1, name: 'M_JKILL', routine: (c) => mChooseSkill(c), alphaKey: ord('i') },
  { status: 1, name: 'M_ROUGH', routine: (c) => mChooseSkill(c), alphaKey: ord('h') },
  { status: 1, name: 'M_HURT', routine: (c) => mChooseSkill(c), alphaKey: ord('h') },
  { status: 1, name: 'M_ULTRA', routine: (c) => mChooseSkill(c), alphaKey: ord('u') },
  { status: 1, name: 'M_NMARE', routine: (c) => mChooseSkill(c), alphaKey: ord('n') },
];

export const OptionsMenu: MenuItem[] = [
  // :365-375 ('-1' rows = EMPTY_ROW; routine 0 in C)
  { status: 1, name: 'M_ENDGAM', routine: mEndGame, alphaKey: ord('e') },
  { status: 1, name: 'M_MESSG', routine: mChangeMessages, alphaKey: ord('m') },
  { status: 1, name: 'M_DETAIL', routine: mChangeDetail, alphaKey: ord('g') },
  { status: 2, name: 'M_SCRNSZ', routine: (c) => mSizeDisplay(c), alphaKey: ord('s') },
  { ...EMPTY_ROW },
  { status: 2, name: 'M_MSENS', routine: (c) => mChangeSensitivity(c), alphaKey: ord('m') },
  { ...EMPTY_ROW },
  { status: 1, name: 'M_SVOL', routine: mSound, alphaKey: ord('s') },
];

export const SoundMenu: MenuItem[] = [
  // :427-32 — the volume thermos (status 2: arrows ok)
  { status: 2, name: 'M_SFXVOL', routine: (c) => mSfxVol(c), alphaKey: ord('s') },
  { ...EMPTY_ROW },
  { status: 2, name: 'M_MUSVOL', routine: (c) => mMusicVol(c), alphaKey: ord('m') },
  { ...EMPTY_ROW },
];

export const ReadMenu1: MenuItem[] = [
  // :391-393 — invisible exit hot-spot for Read This! page 1
  { status: 1, name: '', routine: mReadThis2, alphaKey: 0 },
];

export const ReadMenu2: MenuItem[] = [
  // :406-408
  { status: 1, name: '', routine: mFinishReadThis, alphaKey: 0 },
];

/**
 * LoadMenu (m_menu.c:464-471): SIX rows (§0.4 — load_end = 6, :460;
 * the savegamestrings ARRAY is 10 but the 1.10 menu exposes six). The
 * name patch is "" — the row TEXT is savegamestrings[i], drawn text by
 * M_DrawLoad (:549-552). M_ReadSaveStrings flips status 0/1 per hole
 * (:530/:534) — a 0 row takes Enter nowhere (:1689 `status` guard).
 */
export const LoadMenu: MenuItem[] = [
  { status: 1, name: '', routine: (c) => mLoadSelect(c), alphaKey: ord('1') },
  { status: 1, name: '', routine: (c) => mLoadSelect(c), alphaKey: ord('2') },
  { status: 1, name: '', routine: (c) => mLoadSelect(c), alphaKey: ord('3') },
  { status: 1, name: '', routine: (c) => mLoadSelect(c), alphaKey: ord('4') },
  { status: 1, name: '', routine: (c) => mLoadSelect(c), alphaKey: ord('5') },
  { status: 1, name: '', routine: (c) => mLoadSelect(c), alphaKey: ord('6') },
];

/** SaveMenu (m_menu.c:487-494) — same shape; status stays 1 always
 * (M_ReadSaveStrings only touches LoadMenu), alphaKeys '1'..'6'. */
export const SaveMenu: MenuItem[] = [
  { status: 1, name: '', routine: (c) => mSaveSelect(c), alphaKey: ord('1') },
  { status: 1, name: '', routine: (c) => mSaveSelect(c), alphaKey: ord('2') },
  { status: 1, name: '', routine: (c) => mSaveSelect(c), alphaKey: ord('3') },
  { status: 1, name: '', routine: (c) => mSaveSelect(c), alphaKey: ord('4') },
  { status: 1, name: '', routine: (c) => mSaveSelect(c), alphaKey: ord('5') },
  { status: 1, name: '', routine: (c) => mSaveSelect(c), alphaKey: ord('6') },
];

/* menu_t defs — the prevMenu web is wired below (C's &-references). */
export const MainDef = mkMenu('MainDef', 6, null, MainMenu, mDrawMainMenu, 97, 64, 0); // :259-266
export const EpiDef = mkMenu('EpiDef', 4, MainDef, EpisodeMenu, mDrawEpisode, 48, 63, 0); // :291-299
export const NewDef = mkMenu('NewDef', 5, EpiDef, NewGameMenu, mDrawNewGame, 48, 63, 2); // :323-331 (lastOn hurtme)
export const OptionsDef = mkMenu('OptionsDef', 8, MainDef, OptionsMenu, mDrawOptions, 60, 37, 0); // :377-384
export const ReadDef1 = mkMenu('ReadDef1', 1, MainDef, ReadMenu1, mDrawReadThis1, 280, 185, 0); // :395-402
export const ReadDef2 = mkMenu('ReadDef2', 1, ReadDef1, ReadMenu2, mDrawReadThis2, 330, 175, 0); // :410-417
export const SoundDef = mkMenu('SoundDef', 4, OptionsDef, SoundMenu, mDrawSound, 80, 64, 0); // :434-441
/** LoadDef (m_menu.c:473-482): numitems load_end(6), prevMenu MainDef,
 * x=80 y=54 — M_DrawSaveLoadBorder places the row box at (x-8, y+7)
 * from these coordinates (:563-571). */
export const LoadDef = mkMenu('LoadDef', 6, MainDef, LoadMenu, mDrawLoad, 80, 54, 0);
/** SaveDef (m_menu.c:496-505): identical geometry (M_DrawSave reuses
 * LoadDef.x/.y at :615-617 — verbatim). */
export const SaveDef = mkMenu('SaveDef', 6, MainDef, SaveMenu, mDrawSave, 80, 54, 0);

function mkMenu(
  defName: string, numitems: number, prevMenu: Menu | null,
  menuitems: MenuItem[], routine: () => void, x: number, y: number, lastOn: number,
): Menu {
  return { numitems, prevMenu, menuitems, routine, x, y, lastOn, defName };
}

/* ------------------------------------------------------------------ */
/* debug/e2e accessors — main.ts never needs them                     */
/* ------------------------------------------------------------------ */

export const menuState = {
  menuActive: () => menuactive,
  inHelpScreens: () => inhelpscreens,
  itemOn: () => itemOn,
  whichSkull: () => whichSkull,
  skullAnimCounter: () => skullAnimCounter,
  currentMenuName: () => currentMenu?.defName ?? '(none)',
  messageToPrint: () => messageToPrint,
  messageText: () => messageString,
  epi: () => epi,
  /** M_Drawer's item boxes for menuMouse arming (null ⇒ disarm). */
  itemBoxes: (): MenuItemBox[] | null => {
    if (messageToPrint || !menuactive || !currentMenu) return null;
    const boxes: MenuItemBox[] = [];
    for (let i = 0; i < currentMenu.numitems; i++) {
      boxes.push({ x: currentMenu.x, y: currentMenu.y + i * LINEHEIGHT });
    }
    return boxes;
  },
  screenBlocks: () => screenblocks,
  mouseSensitivity: () => mouseSensitivity,
  detailLevel: () => detailLevel,
  sndVolumes: () => [sndSfxVolume, sndMusicVolume] as const,
  useGamma: () => usegamma,
  /** m_menu.c:90 quickSaveSlot: -1 unset / -2 “pick a slot now” /
   * ≥0 last-used (M_DoSave :637-638 captures the sentinel). */
  quickSaveSlot: () => quickSaveSlot,
  /** savegamestrings[] face (m_menu.c:132). */
  saveStrings: () => savegamestrings.slice(),
  /** string-editor state face (:119-123). */
  saveEdit: () => ({ enter: saveStringEnter, slot: saveSlot, index: saveCharIndex, old: saveOldString }),
};

/* ------------------------------------------------------------------ */
/* M_Init / control panel (m_menu.c:1847-1893, :1723-1735, :1807-1812)  */
/* ------------------------------------------------------------------ */

/** The WAD seam: M_* / HELP* / STCFN lumps resolve through it
 * (lumpPatch cache). null ⇒ draws count a stub instead of throwing. */
export function mSetWad(w: WadFile | null): void {
  wad = w;
}

/**
 * M_Init (m_menu.c:1847): globals + the shareware/registered censor
 * `EpiDef.numitems--` (:1866-1874 — shareware FALLS THROUGH from
 * registered in 1.10: BOTH drop the 4th episode; episodes 2/3 stay and
 * branch to the ad screen at M_Episode, §M9-04).
 */
export function mInit(w?: WadFile | null): void {
  if (w !== undefined) wad = w;
  currentMenu = MainDef;
  menuactive = false;
  itemOn = currentMenu.lastOn;
  whichSkull = 0;
  skullAnimCounter = 10;
  screenSize = screenblocks - 3;
  messageToPrint = 0;
  messageString = '';
  messageLastMenuActive = menuactive;
  quickSaveSlot = -1;

  // Here we could catch other version dependencies,
  //  like HELP1/2, and four episodes.
  // switch (gamemode) — shareware falls through to registered (:1861-1874)
  if (GAME_MODE === 'shareware' || GAME_MODE === 'registered') {
    // We need to remove the fourth episode.
    EpiDef.numitems--;
  }
  armMouse();
}

/** Register the d_main.c:382 tic-block M_Ticker hook (game.ts seam —
 * main.ts wiring calls this once; tests call it after resetGameFlow). */
export function mRegisterFlow(): void {
  registerGameFlowHooks({ mTicker: (state) => mTicker(state) });
}

/** M_StartControlPanel (m_menu.c:1723): "intro might call this
 * repeatedly" — resets to MainDef ONLY when the panel was closed. */
export function mStartControlPanel(state?: GameState): void {
  if (state !== undefined) gs = state;
  if (menuactive) return;
  menuactive = true;
  currentMenu = MainDef; // JDC
  itemOn = currentMenu.lastOn; // JDC
  armMouse();
}

/** M_ClearMenus (:1799-1805). */
export function mClearMenus(): void {
  menuactive = false;
  armMouse();
}

/** M_SetupNextMenu (:1824-1829). */
function mSetupNextMenu(menudef: Menu): void {
  currentMenu = menudef;
  itemOn = currentMenu.lastOn;
  armMouse();
}

/** (Re)arm the menu-mouse synthesizer with the CURRENT menu geometry
 * (D-0yy; empty ⇒ disarm). No-op when no sink is registered. */
function armMouse(): void {
  menuSeams.mouseArm?.(menuState.itemBoxes(), () => itemOn);
}

/* ------------------------------------------------------------------ */
/* messages (m_menu.c:1222-1238)                                        */
/* ------------------------------------------------------------------ */

/** M_StartMessage (:1222): arms the message, menuactive = true. */
function mStartMessage(string: string, routine: ((ch: number) => void) | null, input: boolean): void {
  messageLastMenuActive = menuactive;
  messageToPrint = 1;
  messageString = string;
  messageRoutine = routine;
  messageNeedsInput = input;
  menuactive = true;
  armMouse(); // message ⇒ itemBoxes() null ⇒ mouse synth disarmed
  return;
}

/** M_StopMessage (:1234-1238; defined, never called in 1.10 m_menu.c —
 * kept for the M11 save-edit path). */
export function mStopMessage(): void {
  menuactive = messageLastMenuActive;
  messageToPrint = 0;
  armMouse();
}

/* ------------------------------------------------------------------ */
/* selection routines (m_menu.c:864-1105)                               */
/* ------------------------------------------------------------------ */

/** M_NewGame (:874-884): SP single-player ⇒ commercial ? NewDef : EpiDef. */
function mNewGame(): void {
  // netgame is a compile-time false of this build (§4): the NEWGAME
  // message branch is unreachable.
  if (GAME_MODE === 'commercial') mSetupNextMenu(NewDef);
  else mSetupNextMenu(EpiDef);
}

/** M_VerifyNightmare (:895-902) — the nightmare confirmation. */
function mVerifyNightmare(ch: number): void {
  if (ch !== ord('y')) return;
  if (gs) gDeferedInitNew(gs, nightmare + 1, epi + 1, 1); // 1-based seam domain
  mClearMenus();
}

/** M_ChooseSkill (:904-915): skill menu ALWAYS starts map 1 (§0.7). */
function mChooseSkill(choice: number): void {
  if (choice === nightmare) {
    mStartMessage(NIGHTMARE, mVerifyNightmare, true);
    return;
  }
  if (gs) gDeferedInitNew(gs, choice + 1, epi + 1, 1);
  mClearMenus();
}

/**
 * M_Episode (:928-946): the shareware AD divert — choice != 0 (epi 2/3/4
 * — the 4th is censored from the table, §M9-04) does NOT pick a skill
 * menu: it prints SWSTRING ("order the entire trilogy") and diverts to
 * the ReadDef1 ad page, EXACTLY the 1.10 behaviour (plan §0.12 "ad
 * divert" finding CONFIRMED from source).
 */
function mEpisode(choice: number): void {
  if (GAME_MODE === 'shareware' && choice) {
    mStartMessage(SWSTRING, null, false);
    mSetupNextMenu(ReadDef1);
    return;
  }
  // (gamemode == registered && choice > 2) ⇒ choice = 0 (:939-943) —
  // unreached under the shareware policy.
  epi = choice;
  mSetupNextMenu(NewDef);
}

/** M_Options (:1002-1004). */
function mOptions(): void {
  mSetupNextMenu(OptionsDef);
}

/** M_ChangeMessages (:1010-1021): toggles showMessages (M9-06's flag via
 * the seam; the player-message write is the HU queue, player.ts:145). */
function mChangeMessages(): void {
  const show = !(menuSeams.showMessages?.() ?? true);
  menuSeams.setShowMessages?.(show);
  if (gs && gs.players[0]) gs.players[0].message = show ? MSGON : MSGOFF;
  // message_dontfuckwithme = true (hu_stuff.c:69) — M9-06's latch, via
  // the same seam family when registered; counted until then.
  menuStub('message_dontfuckwithme');
}

/** M_EndGameResponse (:992-1000): yes ⇒ D_StartTitle (F7 end-game). */
function mEndGameResponse(ch: number): void {
  if (ch !== ord('y')) return;
  if (currentMenu) currentMenu.lastOn = itemOn;
  mClearMenus();
  if (gs) gStartTitle(gs); // D_StartTitle (g_game.c:525 hook)
}

/** M_EndGame (:1005-1021): !usergame ⇒ sfx_oof; else ENDGAME confirm. */
function mEndGame(): void {
  if (!gs?.usergame) {
    sfxSink('sfx_oof');
    return;
  }
  mStartMessage(ENDGAME, mEndGameResponse, true);
}

/** M_ReadThis / M_ReadThis2 / M_FinishReadThis (:1027-1043). */
function mReadThis(): void {
  mSetupNextMenu(ReadDef1);
}
function mReadThis2(): void {
  mSetupNextMenu(ReadDef2);
}
function mFinishReadThis(): void {
  mSetupNextMenu(MainDef);
}

/** quitsounds[8] (:1054-1063) — episodic (non-commercial) table; the
 * commercial quitsounds2 (:1066) is unreached under the shareware
 * policy. Names flow through hooks.sfxSink (M10-04 event emission). */
const quitsounds = [
  'sfx_pldeth', 'sfx_dmpain', 'sfx_popain', 'sfx_slop',
  'sfx_telept', 'sfx_posit1', 'sfx_posit3', 'sfx_sgtatk',
] as const;

/** M_QuitResponse (:1074-1090): 'y' ⇒ quitsounds[(gametic>>2)&7]
 * (gametic-indexed, NOT random, §0.7) then I_Quit — the browser maps
 * I_Quit to the title screen (D-0zz) through the startTitle hook. */
function mQuitResponse(ch: number): void {
  if (ch !== ord('y')) return;
  const gametic = gs?.gametic ?? 0;
  sfxSink(quitsounds[(gametic >> 2) & 7]!);
  mClearMenus();
  if (gs) gStartTitle(gs); // D-0zz: I_Quit ⇒ title in the browser
}

/** M_QuitDOOM (:1095-1107): language==english ⇒
 * endmsg[(gametic % (NUM_QUITMESSAGES-2)) + 1] + DOSY. */
function mQuitDOOM(): void {
  const gametic = gs?.gametic ?? 0;
  // (language != english ⇒ endmsg[0]) — this build's language is
  // english (d_main default).
  const endstring = endmsg[(gametic % (NUM_QUITMESSAGES - 2)) + 1] + '\n\n' + DOSY;
  mStartMessage(endstring, mQuitResponse, true);
}

/** M_ChangeSensitivity (:1112-1125). */
function mChangeSensitivity(choice: number): void {
  switch (choice) {
    case 0:
      if (mouseSensitivity) mouseSensitivity--;
      break;
    case 1:
      if (mouseSensitivity < 9) mouseSensitivity++;
      break;
  }
}

/** M_ChangeDetail (:1130-1149): toggles detailLevel; the R_SetViewSize
 * + DETAILHI/LO half is COMMENTED OUT in 1.10 (:1143-1148) — verbatim
 * (toggle only + the counted stderr stub). */
function mChangeDetail(): void {
  detailLevel = 1 - detailLevel;
  menuStub('M_ChangeDetail low detail mode n.a.');
}

/** M_SizeDisplay (:1154-1173): screenblocks/screenSize 0..8, then the
 * R_SetViewSize seam (M9-09's view.ts params). */
function mSizeDisplay(choice: number): void {
  switch (choice) {
    case 0:
      if (screenSize > 0) {
        screenblocks--;
        screenSize--;
      }
      break;
    case 1:
      if (screenSize < 8) {
        screenblocks++;
        screenSize++;
      }
      break;
  }
  if (menuSeams.setViewSize) menuSeams.setViewSize(screenblocks, detailLevel);
  else menuStub('R_SetViewSize');
}

/** M_Sound (:811-813). */
function mSound(): void {
  mSetupNextMenu(SoundDef);
}

/** M_SfxVol / M_MusicVol (:815-850): 0..15, S_SetSfxVolume/S_SetMusic
 * Volume = M10 (counted sites). */
function mSfxVol(choice: number): void {
  switch (choice) {
    case 0:
      if (sndSfxVolume) sndSfxVolume--;
      break;
    case 1:
      if (sndSfxVolume < 15) sndSfxVolume++;
      break;
  }
  menuStub('S_SetSfxVolume');
}
function mMusicVol(choice: number): void {
  switch (choice) {
    case 0:
      if (sndMusicVolume) sndMusicVolume--;
      break;
    case 1:
      if (sndMusicVolume < 15) sndMusicVolume++;
      break;
  }
  menuStub('S_SetMusicVolume');
}

/* --- M11-03 bodies (were the M9 “not yet” slots; addresses frozen) --- */

/**
 * M_ReadSaveStrings (m_menu.c:511-536): vanilla opens doomsavN.dsg per
 * row; the async-free port consumes the injected LAST-KNOWN snapshot
 * (§M11-03: pre-opened by the M11-05 glue — the menu never awaits).
 * Hole ⇒ EMPTYSTRING + the LoadMenu row goes status 0 (unselectable,
 * :528-531); file ⇒ 24B description + status 1 (:532-534). load_end
 * rows only — slots 6..9 never surface in the 1.10 menu.
 */
export function mReadSaveStrings(): void {
  const rows = menuSeams.saveRows?.();
  for (let i = 0; i < LOAD_END; i++) {
    const r = rows?.[i];
    if (r === undefined || r.empty) {
      savegamestrings[i] = EMPTYSTRING; // :528
      LoadMenu[i]!.status = 0; // :530
    } else {
      savegamestrings[i] = r.description.slice(0, SAVESTRINGSIZE - 1); // :532 (NUL-terminated 24B field)
      LoadMenu[i]!.status = 1; // :534
    }
  }
}

/** M_DrawLoad (m_menu.c:543-555): M_LOADG title patch at (72,28) + the
 * six bordered string rows. */
function mDrawLoad(): void {
  mDrawPatch('M_LOADG', 72, 28);
  for (let i = 0; i < LOAD_END; i++) {
    mDrawSaveLoadBorder(LoadDef.x, LoadDef.y + LINEHEIGHT * i);
    mWriteText(LoadDef.x, LoadDef.y + LINEHEIGHT * i, savegamestrings[i]!);
  }
}

/** M_DrawSave (m_menu.c:607-626): same geometry (vanilla reads
 * LoadDef.x/.y verbatim at :615-617 — same values) + the CURSOR TRUTH:
 * vanilla has no block cursor — while saveStringEnter it draws the
 * text "_" at the string's right edge (:621-624). */
function mDrawSave(): void {
  mDrawPatch('M_SAVEG', 72, 28);
  for (let i = 0; i < LOAD_END; i++) {
    mDrawSaveLoadBorder(LoadDef.x, LoadDef.y + LINEHEIGHT * i);
    mWriteText(LoadDef.x, LoadDef.y + LINEHEIGHT * i, savegamestrings[i]!);
  }
  if (saveStringEnter) {
    const w = mStringWidth(savegamestrings[saveSlot]!);
    mWriteText(LoadDef.x + w, LoadDef.y + LINEHEIGHT * saveSlot, '_');
  }
}

/** M_DrawSaveLoadBorder (m_menu.c:559-572): M_LSLEFT at x-8, 24×
 * M_LSCNTR advancing 8, M_LSRGHT — all at y+7. (Two-arg in 1.10 — the
 * §0.4 “+24×M_LSCNTR” note describes this loop.) */
function mDrawSaveLoadBorder(x: number, y: number): void {
  mDrawPatch('M_LSLEFT', x - 8, y + 7);
  let xx = x;
  for (let i = 0; i < 24; i++) {
    mDrawPatch('M_LSCNTR', xx, y + 7);
    xx += 8;
  }
  mDrawPatch('M_LSRGHT', xx, y + 7);
}

/** M_LoadSelect (m_menu.c:578-586): G_LoadGame(doomsavN.dsg) — the
 * browser half is async (decode → gRequestLoadGame, D-11b), mounted on
 * seams.requestLoadSlot; then the menu closes unconditionally (:589). */
function mLoadSelect(choice: number): void {
  if (menuSeams.requestLoadSlot) menuSeams.requestLoadSlot(choice);
  else menuStub('G_LoadGame'); // seam not mounted yet (M11-10 boot)
  mClearMenus();
}

/** M_LoadGame (m_menu.c:590-601): netgame ⇒ LOADNET (compile-time
 * false here, §4); SetupNextMenu(LoadDef) THEN M_ReadSaveStrings —
 * verbatim order (:599-600). */
function mLoadGame(choice: number): void {
  void choice; // unused in 1.10 (MainDef passes itemOn=2, ignored)
  mSetupNextMenu(LoadDef);
  mReadSaveStrings();
}

/** M_DoSave (m_menu.c:631-639): the editor’s Enter + the quicksave
 * confirm both land here. G_SaveGame is the two-stage deferral entry
 * (§0.3, g_game.c:1256 — sendsave rides the next ticcmd); the quick-
 * slot sentinel capture is the -2 → slot transition (:637-638). */
export function mDoSave(slot: number): void {
  gSaveGame(slot, savegamestrings[slot]!);
  mClearMenus();
  if (quickSaveSlot === -2) quickSaveSlot = slot; // PICK QUICKSAVE SLOT YET?
}

/** M_SaveSelect (m_menu.c:644-654): arm the char interceptor, snapshot
 * the row for ESC-revert, and clear a fresh EMPTYSTRING to "" so the
 * user types over it; saveCharIndex = strlen. (No quickSaveSlot
 * capture here — M_DoSave owns it, :637.) */
function mSaveSelect(choice: number): void {
  saveStringEnter = 1; // "we are going to be intercepting all chars"
  saveSlot = choice;
  saveOldString = savegamestrings[choice]!;
  if (savegamestrings[choice] === EMPTYSTRING) savegamestrings[choice] = '';
  saveCharIndex = savegamestrings[choice]!.length;
}

/** M_SaveGame (m_menu.c:656-671): !usergame ⇒ SAVEDEAD (the “not
 * playing” message — NOT sfx_oof, that half is M_QuickSave’s :691-695);
 * gamestate != GS_LEVEL ⇒ silent return (:663-666, the “// UNUSED”
 * SAVE-not-here guard); else SaveDef + the slot strings. */
function mSaveGame(choice: number): void {
  void choice; // unused in 1.10 (F2 calls M_SaveGame(0))
  if (!gs?.usergame) {
    mStartMessage(SAVEDEAD, null, false);
    return;
  }
  if (gs.gamestate !== GS.LEVEL) return; // :663-666
  mSetupNextMenu(SaveDef);
  mReadSaveStrings();
}

/** M_QuickSaveResponse (m_menu.c:679-688): the QSPROMPT y/n — 'y'
 * fires M_DoSave on the remembered slot. DEVIATION (documented, sfx
 * ledger): vanilla’s response-local S_StartSound(:686) is MERGED into
 * the message branch’s same-tic sfx_swtchx emission (:1507, transcribed
 * above) — same sound, same tic, one sink event (the M10-04 site
 * ledger pins the emitter census). */
function mQuickSaveResponse(ch: number): void {
  if (ch !== ord('y')) return;
  mDoSave(quickSaveSlot);
}

/**
 * M_QuickSave (m_menu.c:689-714) — the F6 body. Truths (§0.4):
 *  - !usergame ⇒ sfx_oof; gamestate != GS_LEVEL ⇒ SILENT return.
 *  - quickSaveSlot < 0 (first F6 of the session, -1 from M_Init :1858
 *    — the global is memory, never persisted, §0.8): open SaveDef and
 *    arm quickSaveSlot = -2 “means to pick a slot now” (:706); the
 *    capture happens later in M_DoSave (:637-638).
 *  - else the QSPROMPT y/n over the slot’s name (sprintf %s, :709).
 * The literal `quickSaveSlot == -2` QSPROMPT shape below the -2 branch
 * is how 1.10 reads: a fresh -2 can only arrive via the < 0 branch,
 * so the prompt fires for REAL slots (≥0) only — transcribed, not
 * “fixed”.
 */
function mQuickSave(): void {
  if (!gs?.usergame) {
    sfxSink('sfx_oof');
    return;
  }
  if (gs.gamestate !== GS.LEVEL) return; // :697-700 silent
  if (quickSaveSlot < 0) {
    mStartControlPanel();
    mReadSaveStrings();
    mSetupNextMenu(SaveDef);
    quickSaveSlot = -2; // means to pick a slot now (:706)
    return;
  }
  mStartMessage(sprintf(QSPROMPT, savegamestrings[quickSaveSlot]!), mQuickSaveResponse, true);
}

/** M_QuickLoadResponse (m_menu.c:718-726): 'y' ⇒ M_LoadSelect on the
 * remembered slot (its :723 S_StartSound merges into the message
 * branch’s same-tic emission — see mQuickSaveResponse’s note). */
function mQuickLoadResponse(ch: number): void {
  if (ch !== ord('y')) return;
  mLoadSelect(quickSaveSlot);
}

/**
 * M_QuickLoad (m_menu.c:727-746) — the F9 body. netgame ⇒ QLOADNET
 * (compile-time false, §4); quickSaveSlot < 0 ⇒ QSAVESPOT (:736-739,
 * “QSAVESPOT if never saved” — -1 AND an unpicked -2 both land here);
 * else the QLPROMPT y/n over the slot name (:741-742).
 */
function mQuickLoad(): void {
  if (quickSaveSlot < 0) {
    mStartMessage(QSAVESPOT, null, false);
    return;
  }
  mStartMessage(sprintf(QLPROMPT, savegamestrings[quickSaveSlot]!), mQuickLoadResponse, true);
}

/** C sprintf stand-in for the two single-%s prompts (QSPROMPT/
 * QLPROMPT, d_englsh.h:46-47). */
function sprintf(fmt: string, s: string): string {
  return fmt.replace('%s', s);
}

/* ------------------------------------------------------------------ */
/* draw routines (m_menu.c:856-808 + helpers)                           */
/* ------------------------------------------------------------------ */

/** W_CacheLumpName + V_DrawPatchDirect (x,y,0,lump) (M9-01 seam). */
function mDrawPatch(name: string, x: number, y: number): void {
  if (wad === null) {
    menuStub(`draw:${name}`);
    return;
  }
  vDrawPatchDirect(x, y, FG, lumpPatch(wad, name));
}

function mDrawThermo(x: number, y: number, thermWidth: number, thermDot: number): void {
  // m_menu.c:1181-1198
  let xx = x;
  mDrawPatch('M_THERML', xx, y);
  xx += 8;
  for (let i = 0; i < thermWidth; i++) {
    mDrawPatch('M_THERMM', xx, y);
    xx += 8;
  }
  mDrawPatch('M_THERMR', xx, y);
  mDrawPatch('M_THERMO', x + 8 + thermDot * 8, y);
}

const detailNames = ['M_GDHIGH', 'M_GDLOW'] as const; // :953
const msgNames = ['M_MSGOFF', 'M_MSGON'] as const; // :954

function mDrawMainMenu(): void {
  // :856-859
  mDrawPatch('M_DOOM', 94, 2);
}

function mDrawNewGame(): void {
  // :864-868
  mDrawPatch('M_NEWG', 96, 14);
  mDrawPatch('M_SKILL', 54, 38);
}

function mDrawEpisode(): void {
  // :889-892
  mDrawPatch('M_EPISOD', 54, 38);
}

function mDrawOptions(): void {
  // :959-974
  mDrawPatch('M_OPTTTL', 108, 15);
  mDrawPatch(detailNames[detailLevel & 1]!, OptionsDef.x + 175, OptionsDef.y + LINEHEIGHT * opt_e.detail);
  mDrawPatch(msgNames[(menuSeams.showMessages?.() ?? true) ? 1 : 0]!, OptionsDef.x + 120, OptionsDef.y + LINEHEIGHT * opt_e.messages);
  mDrawThermo(OptionsDef.x, OptionsDef.y + LINEHEIGHT * (opt_e.mousesens + 1), 10, mouseSensitivity);
  mDrawThermo(OptionsDef.x, OptionsDef.y + LINEHEIGHT * (opt_e.scrnsize + 1), 9, screenSize);
}

function mDrawSound(): void {
  // :800-809
  mDrawPatch('M_SVOL', 60, 38);
  mDrawThermo(SoundDef.x, SoundDef.y + LINEHEIGHT * (sound_e.sfx_vol + 1), 16, sndSfxVolume);
  mDrawThermo(SoundDef.x, SoundDef.y + LINEHEIGHT * (sound_e.music_vol + 1), 16, sndMusicVolume);
}

/** M_DrawReadThis1 (:751-770): the "quick hack to fix romero bug" —
 * shareware/registered/retail ⇒ HELP1 full-screen, commercial HELP. */
function mDrawReadThis1(): void {
  inhelpscreens = true;
  if (GAME_MODE === 'commercial') mDrawPatch('HELP', 0, 0);
  else mDrawPatch('HELP1', 0, 0);
}

/** M_DrawReadThis2 (:776-792): retail/commercial CREDIT, else HELP2
 * (shareware page 2 = HELP2, §0.7). */
function mDrawReadThis2(): void {
  inhelpscreens = true;
  if (GAME_MODE === 'retail' || GAME_MODE === 'commercial') mDrawPatch('CREDIT', 0, 0);
  else mDrawPatch('HELP2', 0, 0);
}

/* ------------------------------------------------------------------ */
/* the HU-font text path (m_menu.c:1243-1319)                           */
/* ------------------------------------------------------------------ */

const HU_FONTSTART = 33; // hu_stuff.h:30 '!'
const HU_FONTEND = 95; // :31 '_'
const HU_FONTSIZE = HU_FONTEND - HU_FONTSTART + 1; // 63
const SCREENWIDTH = 320; // v_video.h (locally, avoids the render cycle)

const huFont: (VPatch | null)[] = new Array(HU_FONTSIZE).fill(null);

function fontChar(c: number): VPatch | null {
  if (wad === null) return null;
  const idx = c - HU_FONTSTART;
  if (idx < 0 || idx >= HU_FONTSIZE) return null;
  let p = huFont[idx];
  if (p === undefined || p === null) {
    p = lumpPatch(wad, `STCFN${String(c).padStart(3, '0')}`);
    huFont[idx] = p;
  }
  return p;
}

const upper = (c: number): number => (c >= 97 && c <= 122 ? c - 32 : c);

/** M_StringWidth (:1243-1259). */
function mStringWidth(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; i++) {
    const c = upper(s.charCodeAt(i)) - HU_FONTSTART;
    if (c < 0 || c >= HU_FONTSIZE) w += 4;
    else w += fontChar(HU_FONTSTART + c)?.width ?? 0;
  }
  return w;
}

/** M_StringHeight (:1264-1275) — height = hu_font[0] (STCFN033). */
function mStringHeight(s: string): number {
  const height = fontChar(HU_FONTSTART)?.height ?? 0;
  let h = height;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) h += height;
  return h;
}

/** M_WriteText (:1280-1319): 1 char per loop, '\n' ⇒ cx=x, cy+=12,
 * right edge break at SCREENWIDTH, unknown chars +4. */
function mWriteText(x: number, y: number, s: string): void {
  let cx = x;
  let cy = y;
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c === 10) {
      cx = x;
      cy += 12;
      continue;
    }
    c = upper(c) - HU_FONTSTART;
    if (c < 0 || c >= HU_FONTSIZE) {
      cx += 4;
      continue;
    }
    const p = fontChar(HU_FONTSTART + c);
    if (p === null) {
      cx += 4;
      continue;
    }
    if (cx + p.width > SCREENWIDTH) break;
    vDrawPatchDirect(cx, cy, FG, p);
    cx += p.width;
  }
}

/* ------------------------------------------------------------------ */
/* M_Ticker (m_menu.c:1834-1841)                                        */
/* ------------------------------------------------------------------ */

/**
 * The skull animation: alternates every 8 tics (init 10 ⇒ first flip at
 * tics 10, 18, 26… from mInit). NO M_Random draw — see header ledger
 * finding. d_main.c:382 calls it EVERY tic (menuactive or not), mirrored
 * via the game.ts `mTicker` flow hook (gFlowTic).
 */
export function mTicker(state?: GameState): void {
  if (state !== undefined) gs = state;
  if (--skullAnimCounter <= 0) {
    whichSkull ^= 1;
    skullAnimCounter = 8;
  }
}

/* ------------------------------------------------------------------ */
/* M_Drawer (m_menu.c:1740-1817)                                        */
/* ------------------------------------------------------------------ */

/**
 * Called after the view has been rendered, but before it has been
 * blitted (d_main.c:327 — "menu is drawn even on top of everything").
 */
export function mDrawer(): void {
  inhelpscreens = false;

  // Horiz. & Vertically center string and print it.
  if (messageToPrint) {
    let y = 100 - Math.trunc(mStringHeight(messageString) / 2);
    let start = 0;
    while (start < messageString.length) {
      const nl = messageString.indexOf('\n', start);
      const line = nl < 0 ? messageString.slice(start) : messageString.slice(start, nl);
      start = nl < 0 ? messageString.length : nl + 1;
      const x = 160 - Math.trunc(mStringWidth(line) / 2);
      mWriteText(x, y, line);
      y += fontChar(HU_FONTSTART)?.height ?? 0; // SHORT(hu_font[0]->height)
    }
    armMouse(); // message ⇒ no item boxes
    return;
  }

  if (!menuactive) return;

  currentMenu.routine?.(); // call Draw routine

  // DRAW MENU: item patches at x, y + i*16
  const y0 = currentMenu.y;
  let y = y0;
  const max = currentMenu.numitems;
  for (let i = 0; i < max; i++) {
    if (currentMenu.menuitems[i]!.name.length > 0) {
      mDrawPatch(currentMenu.menuitems[i]!.name, currentMenu.x, y);
    }
    y += LINEHEIGHT;
  }

  // DRAW SKULL
  mDrawPatch(skullName[whichSkull]!, currentMenu.x + SKULLXOFF, y0 - 5 + itemOn * LINEHEIGHT);
  armMouse();
}

/* ------------------------------------------------------------------ */
/* M_Responder (m_menu.c:1349-1710)                                     */
/* ------------------------------------------------------------------ */

/**
 * D_ProcessEvents runs this FIRST (d_main.c:161, §0.6): consumed events
 * never reach the automap/game responders. Key UP is never eaten
 * (g_game.c:571): ev_keyup returns false. The joystick branch (:1363-1395)
 * is §4-out (no joystick), the ev_mouse branch (:1397-1437) is replaced
 * by the D-0yy synthesizer (see header finding).
 */
export function mResponder(state: GameState, ev: MenuEvent): boolean {
  gs = state;
  let ch = -1;

  if (ev.type === 'keydown') {
    ch = ev.data1; // :1439-1442 (ev_keydown ⇒ ch = data1; keyup: never)
  }

  if (ch === -1) return false; // :1445-1447 — THE keyup-never-eaten line

  // Save Game string input (:1453-1490) — M11-03: while M_SaveSelect
  // armed the editor, EVERY keydown is consumed (the `return true` at
  // :1490), before the message branch and before the alpha scan.
  if (saveStringEnter) {
    switch (ch) {
      case KEY_BACKSPACE: // :1457-1462
        if (saveCharIndex > 0) {
          saveCharIndex--;
          savegamestrings[saveSlot] = savegamestrings[saveSlot]!.slice(0, saveCharIndex); // [i] = 0
        }
        break;
      case KEY_ESCAPE: // :1464-1467 — revert, menu stays open
        saveStringEnter = 0;
        savegamestrings[saveSlot] = saveOldString;
        break;
      case KEY_ENTER: // :1469-1474 — commit only a NON-EMPTY row
        saveStringEnter = 0;
        if (savegamestrings[saveSlot]!.length > 0) mDoSave(saveSlot);
        break;
      default: // :1476-1487 the char switch
        // toupper, then the HU-font gate: printable 33..95 only —
        // space (32) excepted (vanilla’s `if (ch != 32)` :1479-1481).
        ch = upper(ch);
        if (ch !== 32 && (ch - HU_FONTSTART < 0 || ch - HU_FONTSTART >= HU_FONTSIZE)) break;
        // caps: index < SAVESTRINGSIZE-1 (23 — vanilla’s bound, NOT
        // -2) AND the drawn width below (SAVESTRINGSIZE-2)*8 = 176 px
        // (:1483-1485; with no WAD mounted M_StringWidth is 0 and the
        // index cap alone binds — like a fontless vanilla).
        if (
          ch >= 32 && ch <= 127 &&
          saveCharIndex < SAVESTRINGSIZE - 1 &&
          mStringWidth(savegamestrings[saveSlot]!) < (SAVESTRINGSIZE - 2) * 8
        ) {
          savegamestrings[saveSlot] =
            savegamestrings[saveSlot]!.slice(0, saveCharIndex) + String.fromCharCode(ch);
          saveCharIndex++;
        }
        break;
    }
    return true; // :1490 — consume everything while editing
  }

  // Take care of any messages that need input (:1489-1502)
  if (messageToPrint) {
    if (
      messageNeedsInput &&
      !(ch === ord(' ') || ch === ord('n') || ch === ord('y') || ch === KEY_ESCAPE)
    ) {
      return false;
    }
    menuactive = messageLastMenuActive;
    messageToPrint = 0;
    messageRoutine?.(ch);
    menuactive = false;
    sfxSink('sfx_swtchx');
    return true;
  }

  // devparm && F1 ⇒ G_ScreenShot (:1504-1508) — devparm false (§4 M12
  // screenshot), branch unreachable.

  // F-Keys (:1512-1596) — only while the panel is closed
  if (!menuactive) {
    switch (ch) {
      case KEY_MINUS: // Screen size down
        if (menuSeams.automapActive?.() || menuSeams.chatOn?.()) return false;
        mSizeDisplay(0);
        sfxSink('sfx_stnmov');
        return true;

      case KEY_EQUALS: // Screen size up
        if (menuSeams.automapActive?.() || menuSeams.chatOn?.()) return false;
        mSizeDisplay(1);
        sfxSink('sfx_stnmov');
        return true;

      case KEY_F1: {
        // Help key
        mStartControlPanel();
        // retail ⇒ ReadDef2, else ReadDef1 (:1527-1530)
        currentMenu = GAME_MODE === 'retail' ? ReadDef2 : ReadDef1;
        itemOn = 0;
        sfxSink('sfx_swtchn');
        armMouse();
        return true;
      }

      case KEY_F2: // Save (M11 slot)
        mStartControlPanel();
        sfxSink('sfx_swtchn');
        mSaveGame(0);
        armMouse();
        return true;

      case KEY_F3: // Load (M11-03 live)
        mStartControlPanel();
        sfxSink('sfx_swtchn');
        mLoadGame(0);
        armMouse();
        return true;

      case KEY_F4: // Sound Volume
        mStartControlPanel();
        currentMenu = SoundDef;
        itemOn = sound_e.sfx_vol;
        sfxSink('sfx_swtchn');
        armMouse();
        return true;

      case KEY_F5: // Detail toggle
        mChangeDetail();
        sfxSink('sfx_swtchn');
        return true;

      case KEY_F6: // Quicksave (M11)
        sfxSink('sfx_swtchn');
        mQuickSave();
        armMouse();
        return true;

      case KEY_F7: // End game
        sfxSink('sfx_swtchn');
        mEndGame();
        return true;

      case KEY_F8: // Toggle messages (flag = M9-06's, seam)
        mChangeMessages();
        sfxSink('sfx_swtchn');
        return true;

      case KEY_F9: // Quickload (M11)
        sfxSink('sfx_swtchn');
        mQuickLoad();
        armMouse();
        return true;

      case KEY_F10: // Quit DOOM
        sfxSink('sfx_swtchn');
        mQuitDOOM();
        return true;

      case KEY_F11: {
        // gamma toggle (:1587-1594)
        usegamma++;
        if (usegamma > 4) usegamma = 0;
        if (state.players[0]) state.players[0].message = gammamsg[usegamma]!;
        if (menuSeams.setPalette) menuSeams.setPalette();
        else menuStub('I_SetPalette');
        return true;
      }
      default:
        break;
    }
  }

  // Pop-up menu? (:1598-1606)
  if (!menuactive) {
    if (ch === KEY_ESCAPE) {
      mStartControlPanel();
      sfxSink('sfx_swtchn');
      armMouse();
      return true;
    }
    return false;
  }

  // Keys usable within menu (:1609-1703)
  const items = currentMenu.menuitems;
  switch (ch) {
    case KEY_DOWNARROW:
      do {
        if (itemOn + 1 > currentMenu.numitems - 1) itemOn = 0;
        else itemOn++;
        sfxSink('sfx_pstop');
      } while (items[itemOn]!.status === -1);
      armMouse();
      return true;

    case KEY_UPARROW:
      do {
        if (!itemOn) itemOn = currentMenu.numitems - 1;
        else itemOn--;
        sfxSink('sfx_pstop');
      } while (items[itemOn]!.status === -1);
      armMouse();
      return true;

    case KEY_LEFTARROW:
      if (items[itemOn]!.routine && items[itemOn]!.status === 2) {
        sfxSink('sfx_stnmov');
        items[itemOn]!.routine!(0);
        armMouse();
      }
      return true;

    case KEY_RIGHTARROW:
      if (items[itemOn]!.routine && items[itemOn]!.status === 2) {
        sfxSink('sfx_stnmov');
        items[itemOn]!.routine!(1);
        armMouse();
      }
      return true;

    case KEY_ENTER:
      if (items[itemOn]!.routine && items[itemOn]!.status) {
        currentMenu.lastOn = itemOn;
        if (items[itemOn]!.status === 2) {
          items[itemOn]!.routine!(1); // right arrow
          sfxSink('sfx_stnmov');
        } else {
          items[itemOn]!.routine!(itemOn);
          sfxSink('sfx_pistol');
        }
        armMouse();
      }
      return true;

    case KEY_ESCAPE:
      currentMenu.lastOn = itemOn;
      mClearMenus();
      sfxSink('sfx_swtchx');
      return true;

    case KEY_BACKSPACE:
      currentMenu.lastOn = itemOn;
      if (currentMenu.prevMenu) {
        currentMenu = currentMenu.prevMenu;
        itemOn = currentMenu.lastOn;
        sfxSink('sfx_swtchn');
        armMouse();
      }
      return true;

    default: {
      // alphaKey scan: forward from itemOn+1, then wrapped 0..itemOn
      // (:1670-1685; the scan is CASE-SENSITIVE like vanilla — the
      // keyboard layer queues lowercase ASCII for letters).
      for (let i = itemOn + 1; i < currentMenu.numitems; i++) {
        if (items[i]!.alphaKey === ch) {
          itemOn = i;
          sfxSink('sfx_pstop');
          armMouse();
          return true;
        }
      }
      for (let i = 0; i <= itemOn; i++) {
        if (items[i]!.alphaKey === ch) {
          itemOn = i;
          sfxSink('sfx_pstop');
          armMouse();
          return true;
        }
      }
      break;
    }
  }

  return false;
}

/* ------------------------------------------------------------------ */
/* test seam: full re-init (vanilla boot ⇒ M_Init once)                 */
/* ------------------------------------------------------------------ */

/** Re-run the module globals to boot state (tests + hot reload; the
 * table censors re-apply, prevMenu webs rebuilt by re-declaration). */
export function mReset(w?: WadFile | null): void {
  MainDef.numitems = 6;
  MainDef.y = 64;
  MainDef.prevMenu = null;
  EpiDef.numitems = 4;
  NewDef.prevMenu = EpiDef;
  // C tables are static per-process: restore every mutated lastOn too.
  MainDef.lastOn = 0;
  EpiDef.lastOn = ep_e.ep1;
  NewDef.lastOn = newg_e.hurtme;
  OptionsDef.lastOn = 0;
  SoundDef.lastOn = 0;
  ReadDef1.lastOn = 0;
  ReadDef2.lastOn = 0;
  ReadDef1.x = 280;
  ReadDef1.y = 185;
  ReadMenu1[0]!.routine = mReadThis2;
  screenblocks = 9;
  mouseSensitivity = 5;
  detailLevel = 1;
  usegamma = 0;
  sndSfxVolume = 8;
  sndMusicVolume = 8;
  epi = 0;
  // M11-03 save/load statics (the C tables are static per-process too).
  for (let i = 0; i < savegamestrings.length; i++) savegamestrings[i] = EMPTYSTRING;
  for (const it of LoadMenu) it.status = 1; // M_ReadSaveStrings’ edits
  quickSaveSlot = -1; // re-applied by mInit below (:1858)
  saveStringEnter = 0;
  saveSlot = 0;
  saveCharIndex = 0;
  saveOldString = '';
  LoadDef.lastOn = 0;
  SaveDef.lastOn = 0;
  gs = null;
  mInit(w);
}
