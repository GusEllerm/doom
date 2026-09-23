// ui/menuSaveLoad.ts — M11-05 (M11-plan §M11-05, §0.4): the save/load slot
// UX in its own module — SaveDef/LoadDef row logic, the M_ReadSaveStrings
// async slot-label refresh, the save-name string editor (m_menu.c:1450-1490
// char switch), the save/load actions (capture→codec→store.put /
// store.get→codec→ga_loadgame), and the quicksave/quickload slot semantics
// (quickSaveSlot -1/-2/-N, m_menu.c:90/:706/:685-712/:729-745).
//
// Ownership note: menu.ts is M11-03's. This module imports NOTHING from
// menu.ts and hands it a patch-list for the wiring points:
//   - F2/F3 rows call saveMenuOpener()/loadMenuOpener()
//   - F6/F9 call quickSave()/quickLoad()
//   - M_Responder routes: saveStringEnter ⇒ saveStringResponder(ev) first
//   - the y/n prompt responder ⇒ quickPromptResponse(state, ch, kind)
//   - quickSaveSlot stays menu.ts's global (M11-03 §0.4); it binds its
//     accessors via bindQuickSlot().
// The d_englsh strings used here are DUPLICATED locally (menu.ts/textdata.ts
// are M11-03's files); the patch-list asks menu.ts to become the single
// source once merged.
//
// Vanilla-truth decisions recorded here (§0.4, m_menu.c read :505-760 this
// task):
//  * description = EXACTLY what the user typed (M_ReadSaveStrings :511-536
//    reads descriptions from disk; M_SaveSelect :653-663 starts blank for a
//    fresh slot). There is NO auto-generated "level name on skill n" string
//    in 1.10 — the brief's question resolves: none.
//  * overwrite confirmation: NONE — M_DoSave :631-638 calls G_SaveGame
//    straight away (only the quicksave PROMPT is a confirm, :677-683).
//  * empty-slot LOAD: M_LoadSelect :578-590 arms G_LoadGame regardless;
//    G_DoLoadGame's M_ReadFile miss ⇒ SILENT return (g_game.c:1211). We
//    resolve the miss async BEFORE arming, so the faithful face is a
//    silent no-op — and NO sfx (vanilla plays none in M_LoadSelect).
//  * six rows exposed (load_end = 6, m_menu.c:451-460) over the 10-slot
//    savegamestrings array (m_menu.c:132).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  KEY_BACKSPACE,
  KEY_ENTER,
  KEY_ESCAPE,
  type KeyboardEventPacket,
} from '../input/keyboard';
import { GS, gRequestLoadGame, gSaveGame } from '../sim/game';
import type { CaptureEvent } from '../sim/hooks';
import type { SaveSnapshot } from '../sim/pSaveg';
import type { GameState } from '../sim/state';
import {
  buildPayload,
  clampDescription,
  decodeSave,
  encodeSave,
  parsePayload,
} from '../persist/codec';
import {
  EMPTY_SLOT_TEXT,
  SAVE_SLOT_COUNT,
  type PersistStore,
} from '../persist/store';

/* ------------------------------------------------------------------ */
/* Constants (§0.4)                                                    */
/* ------------------------------------------------------------------ */

/** load_end = 6 — the menu EXPOSES six rows (m_menu.c:451-460). */
export const LOAD_END = 6;

/** savegamestrings[10][24] (m_menu.c:132) — the backing slot count. */
export const SLOT_COUNT = SAVE_SLOT_COUNT; // 10 (store.ts, §0.4)

/** SAVESTRINGSIZE 24 (g_game.c:75) — via the editor the cap is 22 chars. */
const SAVESTRINGSIZE = 24;
/** m_menu.c:1483 width cap `(SAVESTRINGSIZE-2)*8` px = 176. */
const EDIT_WIDTH_CAP = (SAVESTRINGSIZE - 2) * 8;
/** m_menu.c:1482 `saveCharIndex < SAVESTRINGSIZE-1`. */
const EDIT_INDEX_CAP = SAVESTRINGSIZE - 1;
/** hu_stuff.h:30/:34 HU_FONTSTART..HU_FONTSTART+HU_FONTSIZE-1 = '!'..'_'
 * (33..95 minus guard bound 63) — the editor's printable filter. */
const HU_FONTSTART = 33;
const HU_FONTSIZE = 63;

/* d_englsh.h messages (duplicated from menu.ts's private copies; the
 * patch-list consolidates them into M11-03's textdata.ts once merged). */
const PRESSKEY = 'press a key.'; // d_englsh.h:39
const PRESSYN = 'press y or n.'; // d_englsh.h:40
export const QLOADNET = "you can't quickload during a netgame!\n\n" + PRESSKEY; // :43
export const QSAVESPOT = "you haven't picked a quicksave slot yet!\n\n" + PRESSKEY; // :44
export const SAVEDEAD = "you can't save if you aren't playing!\n\n" + PRESSKEY; // :45
export const LOADNET = "you can't do load while in a net game!\n\n" + PRESSKEY; // :42
/** QSPROMPT/QLPROMPT with the %s slot label interpolated (m_menu.c:709/
 * :742 sprintf(tempstring, QSPROMPT, savegamestrings[quickSaveSlot])). */
export const QSPROMPT = "quicksave over your game named\n\n'%s'?\n\n" + PRESSYN; // :46
export const QLPROMPT = "do you want to quickload the game named\n\n'%s'?\n\n" + PRESSYN; // :47

/** DBP1 section id carrying the JSON SaveSnapshot (D-11a payload). */
export const SNAPSHOT_SECTION = 0;

/* ------------------------------------------------------------------ */
/* Types (frozen by the stub commit)                                   */
/* ------------------------------------------------------------------ */

/** One rendered row. The label matrix (acceptance):
 *  empty  ⇒ EMPTYSTRING "empty slot" (d_englsh.h:75)
 *  filled ⇒ the stored description's text face
 *  error  ⇒ slot unreadable/invalid ⇒ displayed as "empty slot" (vanilla
 *           M_ReadSaveStrings :524-528 open-fail lane) with `error` set. */
export interface SlotRow {
  slot: number;
  empty: boolean;
  description: string;
  /** null unless the row failed validation/read at refresh or load time. */
  error: 'corrupt-record' | 'io-failure' | 'quota-exceeded' | 'codec' | null;
}

/** Structured outcome of every entry point: `message` is the d_englsh text
 * the menu layer should mStartMessage(); `action` carries the
 * M_SetupNextMenu/M_ClearMenus request; `prompt` arms the y/n flow. */
export interface SaveLoadOutcome {
  action?: 'open-save-def' | 'open-load-def' | 'clear-menus' | 'none';
  message?: string;
  messageInput?: 'none' | 'yesno';
  prompt?: 'quicksave' | 'quickload';
  promptText?: string;
}

/** quickSaveSlot seam — menu.ts owns the global (M11-03); bind it there.
 * -1 = none (M_Init :1858), -2 = "pick a slot now" (:706), 0..9 = spot. */
export interface QuickSlotRef {
  get(): number;
  set(v: number): void;
}

/** The string-editor face for the drawer (the "_" cursor of M_DrawSave). */
export interface SaveStringState {
  active: boolean;
  slot: number;
  charIndex: number;
  text: string;
  oldText: string;
}

/** Injected seams (all optional; defaults safe/no-op). */
export interface SaveLoadSeams {
  /** mStartMessage equivalent. */
  message?: (text: string, awaiting: 'yesno' | 'ack') => void;
  /** S_StartSound(NULL, name) equivalent (menu routes it to hooks.sfxSink). */
  sfx?: (name: string) => void;
  /** netgame flag — never true in this port; guards kept faithful. */
  isNetgame?: () => boolean;
}

/* ------------------------------------------------------------------ */
/* Module state (memory-only; resetSaveLoad() clears it — M_Init)       */
/* ------------------------------------------------------------------ */

let store: PersistStore | null = null;
/** savegamestrings[i] face — labels from the last refresh + live edits. */
let slotText: string[] = emptyTexts();
let rows: SlotRow[] = defaultRows();
let generation = 0;
/** Async-safe snapshot pattern: refreshes are sequenced; a late-resolving
 * listing from an EARLIER refresh is dropped (never resurrects stale
 * labels across the event loop). */
let refreshSeq = 0;

let internalQuickValue = -1; // m_menu.c:90/:1858
const internalQuickRef: QuickSlotRef = {
  get: () => internalQuickValue,
  set: (v: number) => {
    internalQuickValue = v;
  },
};
let quickRef: QuickSlotRef = internalQuickRef;

let seams: SaveLoadSeams = {};

// saveStringEnter/saveSlot/saveCharIndex/saveOldString (m_menu.c:137-141)
let saveStringEnter = false;
let saveSlot = 0;
let saveCharIndex = 0;
let saveOldString = '';

const captureErrorLedger: string[] = [];
let writeChain: Promise<void> = Promise.resolve();

function emptyTexts(): string[] {
  return Array.from({ length: SLOT_COUNT }, () => EMPTY_SLOT_TEXT);
}

function defaultRows(): SlotRow[] {
  return Array.from({ length: SLOT_COUNT }, (_, slot) => ({
    slot,
    empty: true,
    description: EMPTY_SLOT_TEXT,
    error: null,
  }));
}

/* ------------------------------------------------------------------ */
/* Binding + slot list (M_ReadSaveStrings, m_menu.c:511-536)            */
/* ------------------------------------------------------------------ */

/** Bind the persistence store read-view; rebinding refreshes immediately. */
export function bindStore(next: PersistStore | null): void {
  store = next;
  void refreshSlotLabels();
}

/** M_ReadSaveStrings: per slot, try the record, else EMPTYSTRING. The
 * store NEVER rejects, so the loop is total; a still-open editor keeps its
 * own slot (vanilla can never refresh mid-typing — sync I/O — so skipping
 * the edited slot is the faithful async adaptation). */
export async function refreshSlotLabels(): Promise<SlotRow[]> {
  const seq = ++refreshSeq;
  if (store === null) {
    adoptRows(defaultRows(), -1);
    return rows;
  }
  const next: SlotRow[] = [];
  for (let slot = 0; slot < SLOT_COUNT; slot++) {
    const result = await store.loadGame(slot);
    if (result.ok) {
      next.push({
        slot,
        empty: false,
        description: result.value.description,
        error: null,
      });
    } else if (result.error.code === 'empty-slot') {
      next.push(emptyRow(slot));
    } else {
      // corrupt-record / io-failure / invalid-slot: the open-fail lane —
      // displayed as EMPTYSTRING, error tagged for the drawer/tests.
      next.push({ ...emptyRow(slot), error: mapErrorCode(result.error.code) });
    }
  }
  adoptRows(next, seq);
  return rows;
}

function adoptRows(next: SlotRow[], seq: number): void {
  // Out-of-order guard: a stale listing (older seq still in flight) must
  // not overwrite a newer one. seq -1 = the unbound path (always adopt).
  if (seq !== -1 && seq !== refreshSeq) return;
  rows = next;
  generation++;
  for (const row of next) {
    if (saveStringEnter && row.slot === saveSlot) continue; // typing — keep the edit
    slotText[row.slot] = row.empty ? EMPTY_SLOT_TEXT : row.description;
  }
}

function emptyRow(slot: number): SlotRow {
  return { slot, empty: true, description: EMPTY_SLOT_TEXT, error: null };
}

function mapErrorCode(
  code: string
): Exclude<SlotRow['error'], null> {
  switch (code) {
    case 'corrupt-record':
      return 'corrupt-record';
    case 'quota-exceeded':
      return 'quota-exceeded';
    case 'invalid-slot':
      return 'io-failure';
    default:
      return 'io-failure';
  }
}

/** The 10 rows (rows 6..9 exist in the array but are NOT SaveDef/LoadDef
 * rows — LOAD_END = 6 is the drawer's slice, m_menu.c:451-460). */
export function slotRows(): readonly SlotRow[] {
  return rows;
}

/** Monotonic swap counter — the drawer re-reads slotRows() when it moves
 * (async-safe snapshot pattern). */
export function labelsGeneration(): number {
  return generation;
}

/* ------------------------------------------------------------------ */
/* quickSaveSlot (m_menu.c:90)                                         */
/* ------------------------------------------------------------------ */

export function bindQuickSlot(ref: QuickSlotRef): void {
  quickRef = ref;
}

export function getQuickSaveSlot(): number {
  return quickRef.get();
}

export function setQuickSaveSlot(v: number): void {
  quickRef.set(v);
}

export function setSeams(next: SaveLoadSeams): void {
  seams = next;
}

/* ------------------------------------------------------------------ */
/* Row openers (M_SaveGame :644-657, M_LoadGame :594-603)               */
/* ------------------------------------------------------------------ */

export function saveMenuOpener(state: GameState): SaveLoadOutcome {
  if (!state.usergame) {
    return withMessage(SAVEDEAD, 'none'); // :646-650
  }
  if (state.gamestate !== GS.LEVEL) {
    return { action: 'none' }; // :652 silent
  }
  void refreshSlotLabels(); // M_ReadSaveStrings :656 — async
  return { action: 'open-save-def' };
}

export function loadMenuOpener(state: GameState): SaveLoadOutcome {
  void state; // vanilla M_LoadGame checks only netgame (this port: never)
  if (seams.isNetgame?.() === true) {
    return withMessage(LOADNET, 'none'); // :596-600
  }
  void refreshSlotLabels(); // :602
  return { action: 'open-load-def' };
}

function withMessage(text: string, action: SaveLoadOutcome['action']): SaveLoadOutcome {
  seams.message?.(text, 'ack');
  return { action: action ?? 'none', message: text, messageInput: 'none' };
}

/* ------------------------------------------------------------------ */
/* Load action (M_LoadSelect :578-590)                                 */
/* ------------------------------------------------------------------ */

/** store.get → codec → payload → {@link gRequestLoadGame} (ga_loadgame
 * drains NEXT tic, §0.3) + the M_ClearMenus request. Every failure lane is
 * the faithful SILENT no-op (vanilla G_DoLoadGame :1211-1217 silent
 * return; the marker lane is I_Error, ours a typed ledger row — D-11b)
 * with NO sfx (M_LoadSelect plays none). M_ClearMenus is UNCONDITIONAL
 * (:584-585 — file success is not consulted), so every lane returns
 * `clear-menus`: the menu close never waits on async I/O. */
export async function loadSlot(
  state: GameState,
  slot: number
): Promise<SaveLoadOutcome> {
  if (store === null || !Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
    return { action: 'clear-menus' }; // arm-anyway + clear (:584-585)
  }
  const result = await store.loadGame(slot);
  if (!result.ok) {
    if (result.error.code !== 'empty-slot') {
      markRow(slot, mapErrorCode(result.error.code));
    }
    return { action: 'clear-menus' };
  }
  const snap = snapshotFromBytes(result.value.bytes);
  if (snap === null) {
    markRow(slot, 'codec');
    return { action: 'clear-menus' };
  }
  gRequestLoadGame(state, snap);
  return { action: 'clear-menus' };
}

function snapshotFromBytes(bytes: Uint8Array): SaveSnapshot | null {
  const dec = decodeSave(bytes);
  if (!dec.ok) return null;
  const pay = parsePayload(dec.payload);
  if (!pay.ok) return null;
  const section = pay.sections.find((s) => s.id === SNAPSHOT_SECTION);
  if (section === undefined) return null;
  let snap: SaveSnapshot | null = null;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(section.bytes)) as SaveSnapshot;
    if (
      parsed.format === 1 &&
      typeof parsed.header?.skill === 'number' &&
      typeof parsed.header?.episode === 'number' &&
      typeof parsed.header?.map === 'number'
    ) {
      snap = parsed;
    }
  } catch {
    snap = null;
  }
  return snap;
}

function markRow(slot: number, error: Exclude<SlotRow['error'], null>): void {
  if (slot < 0 || slot >= SLOT_COUNT) return;
  rows = rows.map((r) => (r.slot === slot ? { ...r, error } : r));
  generation++;
}

/* ------------------------------------------------------------------ */
/* Save-name editor (M_SaveSelect :653-663 + M_Responder :1450-1490)    */
/* ------------------------------------------------------------------ */

export function selectSaveSlot(slot: number): void {
  saveStringEnter = true; // :656 "we are going to be intercepting all chars"
  saveSlot = slot;
  saveOldString = slotText[slot] ?? EMPTY_SLOT_TEXT; // :658
  if ((slotText[slot] ?? '') === EMPTY_SLOT_TEXT) {
    slotText[slot] = ''; // :659-660 blank a never-named slot
  }
  saveCharIndex = (slotText[slot] ?? '').length; // :661
}

export function saveStringState(): SaveStringState {
  return {
    active: saveStringEnter,
    slot: saveSlot,
    charIndex: saveCharIndex,
    text: slotText[saveSlot] ?? '',
    oldText: saveOldString,
  };
}

/** The saveStringEnter char switch. Keyup ⇒ NOT consumed (M_Responder
 * :1441-1448: ch stays -1 ⇒ `return false` before the switch). */
export function saveStringResponder(
  state: GameState,
  ev: KeyboardEventPacket
): { consumed: boolean; outcome: SaveLoadOutcome } {
  if (!saveStringEnter) return { consumed: false, outcome: { action: 'none' } };
  if (ev.type !== 'keydown') return { consumed: false, outcome: { action: 'none' } };
  const none: SaveLoadOutcome = { action: 'none' };
  let ch = ev.data1;
  switch (ch) {
    case KEY_BACKSPACE: // :1453-1459
      if (saveCharIndex > 0) {
        saveCharIndex--;
        slotText[saveSlot] = (slotText[saveSlot] ?? '').slice(0, saveCharIndex);
      }
      return { consumed: true, outcome: none };
    case KEY_ESCAPE: // :1461-1464 revert
      saveStringEnter = false;
      slotText[saveSlot] = saveOldString;
      saveCharIndex = saveOldString.length;
      return { consumed: true, outcome: none };
    case KEY_ENTER: {
      // :1466-1470: save ONLY when the string is non-empty; the menu
      // stays open on an empty Enter (vanilla keeps SaveDef up).
      saveStringEnter = false;
      if ((slotText[saveSlot] ?? '').length > 0) {
        return { consumed: true, outcome: doSave(state, saveSlot) };
      }
      return { consumed: true, outcome: none };
    }
    default: {
      // :1473-1486: toupper; ' ' always passes, other chars must be in
      // the HU font range; caps: index < 23 AND width < 176 px.
      ch = upperAscii(ch);
      if (ch !== 32 && (ch - HU_FONTSTART < 0 || ch - HU_FONTSTART >= HU_FONTSIZE)) {
        return { consumed: true, outcome: none };
      }
      const text = slotText[saveSlot] ?? '';
      if (
        ch >= 32 &&
        ch <= 127 &&
        saveCharIndex < EDIT_INDEX_CAP &&
        text.length * 8 < EDIT_WIDTH_CAP
      ) {
        slotText[saveSlot] = text + String.fromCharCode(ch);
        saveCharIndex++;
      }
      return { consumed: true, outcome: none };
    }
  }
}

function upperAscii(ch: number): number {
  return ch >= 97 && ch <= 122 ? ch - 32 : ch;
}

/* ------------------------------------------------------------------ */
/* Save action (M_DoSave :631-638) + quickslot capture (:706)           */
/* ------------------------------------------------------------------ */

/** G_SaveGame(slot, savegamestrings[slot]) — the DEFERRED half only
 * (§0.3): the capture→codec→store.put lands via the capture sink when the
 * drain executes G_DoSaveGame. Overwrite confirmation: NONE in vanilla
 * (:631-638 goes straight through). The -2 sentinel resolves here. */
export function doSave(state: GameState, slot: number): SaveLoadOutcome {
  void state; // G_SaveGame takes slot+description only (g_game.c:1256)
  gSaveGame(slot, slotText[slot] ?? '');
  if (quickRef.get() === -2) {
    // PICK QUICKSAVE SLOT YET? (:704-706)
    quickRef.set(slot);
  }
  return { action: 'clear-menus' };
}

/* ------------------------------------------------------------------ */
/* Quicksave / Quickload (M_QuickSave :685-712, :729-745)              */
/* ------------------------------------------------------------------ */

export function quickSave(state: GameState): SaveLoadOutcome {
  if (!state.usergame) {
    seams.sfx?.('sfx_oof'); // :687-691 — sfx only, NO message
    return { action: 'none' };
  }
  if (state.gamestate !== GS.LEVEL) return { action: 'none' }; // :693
  const slot = quickRef.get();
  if (slot < 0) {
    // :695-701: open SaveDef, arm "pick a slot now".
    void refreshSlotLabels(); // M_ReadSaveStrings :697
    quickRef.set(-2);
    return { action: 'open-save-def' };
  }
  return promptFor('quicksave', slot);
}

export function quickLoad(state: GameState): SaveLoadOutcome {
  void state; // M_QuickLoad guards on netgame/slot only (m_menu.c:729-745)
  if (seams.isNetgame?.() === true) {
    return withMessage(QLOADNET, 'none'); // :731-735
  }
  const slot = quickRef.get();
  if (slot < 0) {
    return withMessage(QSAVESPOT, 'none'); // :737-740
  }
  return promptFor('quickload', slot);
}

function promptFor(kind: 'quicksave' | 'quickload', slot: number): SaveLoadOutcome {
  const label = slotText[slot] ?? EMPTY_SLOT_TEXT;
  const text = (kind === 'quicksave' ? QSPROMPT : QLPROMPT).replace('%s', label);
  seams.message?.(text, 'yesno');
  return {
    action: 'none',
    message: text,
    messageInput: 'yesno',
    prompt: kind,
    promptText: text,
  };
}

/** M_QuickSaveResponse :677-683 / M_QuickLoadResponse :721-727 — 'y' acts
 * (M_DoSave/M_LoadSelect + sfx_swtchx); anything else cancels silently. */
export function quickPromptResponse(
  state: GameState,
  ch: number,
  kind: 'quicksave' | 'quickload'
): SaveLoadOutcome {
  const none: SaveLoadOutcome = { action: 'none' };
  if (ch !== 121 /* 'y' */) return none; // vanilla compares the raw 'y'
  const slot = quickRef.get();
  if (kind === 'quicksave') {
    seams.sfx?.('sfx_swtchx'); // :681 (after M_DoSave; sfx is sync-face)
    return doSave(state, slot);
  }
  seams.sfx?.('sfx_swtchx'); // :725
  void loadSlot(state, slot); // async; the outcome lands via the drain
  return { action: 'clear-menus' };
}

/* ------------------------------------------------------------------ */
/* Composer glue: capture sink → codec → store.put                     */
/* ------------------------------------------------------------------ */

/** A captureSink handler for the SAVE kind: snapshot → DBP1 JSON payload
 * → codec.encodeSave (§0.1 header) → store.saveGame → label refresh.
 * Fire-and-forget with a counted error ledger (M11-10 mounts it; other
 * kinds — 'load'/'load-rejected'/'demo' — pass through untouched). */
export function createCaptureHandler(
  target: PersistStore
): (e: CaptureEvent) => void {
  return (e: CaptureEvent): void => {
    if (e.kind !== 'save') return;
    writeChain = writeChain
      .then(async () => {
        const snap = e.snapshot as SaveSnapshot;
        const payload = buildPayload([
          {
            id: SNAPSHOT_SECTION,
            bytes: new TextEncoder().encode(JSON.stringify(snap)),
          },
        ]);
        const enc = encodeSave(
          {
            description: clampDescription(e.description),
            // byte 40 = vanilla gameskill (0-based, sk_baby..sk_nightmare,
            // §0.1); the snapshot header carries the 1-based deferred-init
            // domain (pSaveg.ts) — convert for the display mirror. The
            // LOAD path never reads these bytes (the snapshot drives
            // gInitNew), so no inverse is needed here.
            skill: clamp0(snap.header.skill - 1),
            episode: snap.header.episode,
            map: snap.header.map,
            playeringame: [
              snap.header.playeringame[0] ?? 0,
              snap.header.playeringame[1] ?? 0,
              snap.header.playeringame[2] ?? 0,
              snap.header.playeringame[3] ?? 0,
            ],
            leveltime: snap.header.leveltime,
          },
          payload
        );
        if (!enc.ok) {
          captureErrorLedger.push(`codec: ${enc.failure.kind}`);
          return;
        }
        const res = await target.saveGame(e.slot, enc.bytes, {
          description: clampDescription(e.description),
          gameInfo: {
            skill: clamp0(snap.header.skill - 1),
            episode: snap.header.episode,
            map: snap.header.map,
            leveltime: snap.header.leveltime,
          },
        });
        if (!res.ok) {
          captureErrorLedger.push(`store: ${res.error.code}`);
          return;
        }
        await refreshSlotLabels(); // rows track the listing (async pattern)
      })
      .catch((err: unknown) => {
        captureErrorLedger.push(
          err instanceof Error ? `store: ${err.message}` : 'store: unknown'
        );
      });
  };
}

function clamp0(v: number): number {
  return Number.isInteger(v) && v >= 0 && v <= 4 ? v : 0;
}

/** Counted error ledger (fire-and-forget writes never throw across the
 * async boundary — same never-throw ladder as store.ts). */
export function captureErrors(): readonly string[] {
  return captureErrorLedger;
}

/** Await every queued write (tests: "all writes landed"). */
export async function flushWrites(): Promise<void> {
  // Two hops so continuations chained during the flush also land.
  await writeChain;
  await writeChain;
}

/* ------------------------------------------------------------------ */
/* M_Init half (m_menu.c:1858 quickSaveSlot = -1)                       */
/* ------------------------------------------------------------------ */

export function resetSaveLoad(): void {
  store = null;
  quickRef = internalQuickRef; // unbind menu.ts's seam too (M_Init)
  quickRef.set(-1);
  slotText = emptyTexts();
  rows = defaultRows();
  generation++;
  refreshSeq++;
  saveStringEnter = false;
  saveSlot = 0;
  saveCharIndex = 0;
  saveOldString = '';
  seams = {};
  captureErrorLedger.length = 0;
  writeChain = Promise.resolve();
}
