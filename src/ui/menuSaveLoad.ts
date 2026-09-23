// ui/menuSaveLoad.ts — M11-05 (M11-plan §M11-05, §0.4): the save/load slot
// UX in its own module — SaveDef/LoadDef row logic, the M_ReadSaveStrings
// async slot-label refresh, the save-name string editor (m_menu.c:1450-1490
// char switch), the save/load actions (capture→codec→store.put /
// store.get→codec→ga_loadgame), and the quicksave/quickload slot semantics
// (quickSaveSlot -1/-2/-N, m_menu.c:90/:706/:685-712/:729-745).
//
// Ownership note: menu.ts is M11-03's. This module consumes NOTHING from
// menu.ts (no imports) and hands menu.ts a patch-list (see
// docs/reports note in the M11-05 delivery) for the wiring points:
//   - F2/F3 rows call saveMenuOpener()/loadMenuOpener()
//   - F6/F9 call quickSave()/quickLoad()
//   - M_Responder routes: saveStringEnter ⇒ saveStringResponder(ev) first
//   - the y/n prompt responder ⇒ quickPromptResponse(ch)
//   - quickSaveSlot stays menu.ts's global; it binds it via bindQuickSlot()
//
// API SURFACE (frozen by this stub; bodies land incrementally).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { GameState } from '../sim/state';
import type { KeyboardEventPacket } from '../input/keyboard';
import type { CaptureEvent } from '../sim/hooks';
import type { PersistStore } from '../persist/store';

/** Number of menu rows exposed by SaveDef/LoadDef — load_end = 6
 * (m_menu.c:451-460, plan §0.4). The backing array is 10
 * (savegamestrings[10][24], m_menu.c:132); rows 6..9 exist in the store but
 * are NOT menu rows. */
export const LOAD_END = 6;

/** savegamestrings[10][24] (m_menu.c:132). */
export const SLOT_COUNT = 10;

/** One rendered row. The label matrix (acceptance):
 *  empty  ⇒ EMPTYSTRING "empty slot" (d_englsh.h:75)
 *  filled ⇒ the stored 24B description's text face
 *  error  ⇒ the slot's bytes/store failed validation ⇒ displayed as
 *           "empty slot" with error set (vanilla: unreadable file ⇒ the
 *           EMPTYSTRING lane of M_ReadSaveStrings :524-528). */
export interface SlotRow {
  slot: number;
  empty: boolean;
  description: string;
  /** null unless the row exists but its record/store read failed. */
  error: 'corrupt-record' | 'io-failure' | 'quota-exceeded' | 'codec' | null;
}

/** Structured outcome of every entry point: `message` is the d_englsh text
 * (if any) the menu layer should mStartMessage(); `openSaveDef` /
 * `openLoadDef` are the M_SetupNextMenu requests; `prompt` arms the y/n
 * flow (QSPROMPT/QLPROMPT with the slot label interpolated). */
export interface SaveLoadOutcome {
  action?: 'open-save-def' | 'open-load-def' | 'clear-menus' | 'none';
  message?: string;
  messageInput?: 'none' | 'yesno';
  prompt?: 'quicksave' | 'quickload';
  promptText?: string;
}

/** quickSaveSlot seam — menu.ts owns the global (M11-03 §0.4); bind it
 * there. Default is a module-private slot so this module is testable and
 * usable before the menu.ts patch-list lands. -1 = none, -2 = "pick a slot
 * now" (m_menu.c:706), 0..9 = the spot. */
export interface QuickSlotRef {
  get(): number;
  set(v: number): void;
}

/** The string-editor face for the menu drawer (the "_" cursor of
 * M_DrawSave/M_DrawLoad, m_menu.c:~660-676). */
export interface SaveStringState {
  active: boolean;
  slot: number;
  charIndex: number;
  text: string;
  oldText: string;
}

/** Injected seams (all optional; defaults are no-ops/safe). */
export interface SaveLoadSeams {
  /** mStartMessage equivalent (text + whether y/n input is awaited). */
  message?: (text: string, awaiting: 'yesno' | 'ack') => void;
  /** S_StartSound(NULL, name) equivalent — routes to hooks.sfxSink. */
  sfx?: (name: string) => void;
  /** netgame flag (never true in this port; guards kept faithful). */
  isNetgame?: () => boolean;
}

/** Bind the persistence store read-view (store.ts). Refreshes labels. */
export function bindStore(store: PersistStore | null): void {
  void store;
  throw new Error('M11-05 stub');
}
export async function refreshSlotLabels(): Promise<SlotRow[]> {
  throw new Error('M11-05 stub');
}
export function slotRows(): readonly SlotRow[] {
  throw new Error('M11-05 stub');
}
/** Monotonic counter — the async-safe snapshot pattern: refreshes swap the
 * row array atomically and bump this; the drawer renders the last swap. */
export function labelsGeneration(): number {
  throw new Error('M11-05 stub');
}
export function bindQuickSlot(ref: QuickSlotRef): void {
  void ref;
  throw new Error('M11-05 stub');
}
export function getQuickSaveSlot(): number {
  throw new Error('M11-05 stub');
}
export function setQuickSaveSlot(v: number): void {
  void v;
  throw new Error('M11-05 stub');
}
export function setSeams(seams: SaveLoadSeams): void {
  void seams;
  throw new Error('M11-05 stub');
}

/** M_SaveGame (m_menu.c:644-657): SAVEDEAD when !usergame, silent return
 * when gamestate != GS_LEVEL, else open SaveDef + M_ReadSaveStrings. */
export function saveMenuOpener(state: GameState): SaveLoadOutcome {
  void state;
  throw new Error('M11-05 stub');
}
/** M_LoadGame (m_menu.c:594-603): LOADNET when netgame, else open LoadDef
 * + refresh. */
export function loadMenuOpener(state: GameState): SaveLoadOutcome {
  void state;
  throw new Error('M11-05 stub');
}
/** M_LoadSelect (m_menu.c:578-590): store.get → codec → gRequestLoadGame
 * (deferred ga_loadgame) + clear-menus request. Empty slot ⇒ silent
 * no-op (vanilla: G_DoLoadGame's M_ReadFile failure ⇒ silent return,
 * g_game.c:1211). */
export function loadSlot(state: GameState, slot: number): Promise<SaveLoadOutcome> {
  void state;
  void slot;
  throw new Error('M11-05 stub');
}
/** M_SaveSelect (m_menu.c:653-663): arm the string editor (snapshot
 * saveOldString; EMPTYSTRING blanked for editing). */
export function selectSaveSlot(slot: number): void {
  void slot;
  throw new Error('M11-05 stub');
}
export function saveStringState(): SaveStringState {
  throw new Error('M11-05 stub');
}
/** The saveStringEnter char switch (M_Responder :1450-1490): backspace,
 * ESC revert, Enter ⇒ M_DoSave (only when the string is non-empty,
 * :1472-1475), default = printable append ≤ SAVESTRINGSIZE-2 chars /
 * ≤ (SAVESTRINGSIZE-2)*8 px. Returns true when consumed. */
export function saveStringResponder(
  _state: GameState,
  _ev: KeyboardEventPacket
): { consumed: boolean; outcome: SaveLoadOutcome } {
  throw new Error('M11-05 stub');
}
/** M_DoSave (m_menu.c:631-638): G_SaveGame(slot, label) + the -2 quickslot
 * capture (:706); overwrite confirmation: NONE in vanilla (cite). */
export function doSave(state: GameState, slot: number): SaveLoadOutcome {
  void state;
  void slot;
  throw new Error('M11-05 stub');
}
/** M_QuickSave (m_menu.c:685-712) / M_QuickLoad (:729-745). */
export function quickSave(state: GameState): SaveLoadOutcome {
  void state;
  throw new Error('M11-05 stub');
}
export function quickLoad(state: GameState): SaveLoadOutcome {
  void state;
  throw new Error('M11-05 stub');
}
/** M_QuickSaveResponse / M_QuickLoadResponse (:677-683/:721-727): 'y' ⇒
 * act + sfx_swtchx, anything else ⇒ cancel. */
export function quickPromptResponse(
  state: GameState,
  ch: number,
  kind: 'quicksave' | 'quickload'
): SaveLoadOutcome {
  void state;
  void ch;
  void kind;
  throw new Error('M11-05 stub');
}
/** Composer glue: a captureSink handler for kind 'save' — encode
 * (codec §0.1 header + DBP1 JSON payload) → store.put → label refresh;
 * fire-and-forget with a counted error ledger; other kinds pass through. */
export function createCaptureHandler(
  store: PersistStore
): (e: CaptureEvent) => void {
  void store;
  throw new Error('M11-05 stub');
}
export function captureErrors(): readonly string[] {
  throw new Error('M11-05 stub');
}
/** Pending async write chain (await in tests = "all writes landed"). */
export function flushWrites(): Promise<void> {
  throw new Error('M11-05 stub');
}

/** M_Init half (m_menu.c:1858): quickSaveSlot=-1, labels → EMPTYSTRING,
 * editor disarmed. Keeps NO store reference. */
export function resetSaveLoad(): void {
  throw new Error('M11-05 stub');
}
