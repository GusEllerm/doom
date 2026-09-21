// input/keyboard.ts — DOM keyboard events → held-key state → GameInput
// snapshots per tic (M2-07, ARCHITECTURE §3.1 step 3a).
//
// Faithful model of the linuxdoom-1.10 keyboard path (verified in source —
// there is NO ev_turn anywhere; d_event.h only has ev_keydown/ev_keyup/
// ev_mouse/ev_joystick):
//   i_*  → ev_keydown{key}/ev_keyup{key} → G_Responder sets/clears
//   gamekeydown[data1] (g_game.c:567/572); G_BuildTiccmd POLLS that array
//   once per tic (g_game.c:266-329). Auto-repeat re-sends ev_keydown, which
//   is a no-op store of `true` — so keydown-sets/keyup-clears on a held-key
//   set is bit-identical to vanilla; OS key-repeat contributes nothing
//   beyond the first press. Turning therefore stays discrete-angle-free:
//   the arrow key just keeps its channel true and sim-side G_BuildTiccmd
//   adds the turnheld ramp. See docs report DEVIATIONS for the ev_turn hunt.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { GameInput } from '../sim/ticcmd';

import {
  bindingsByCode,
  sampleInput,
  type InputAction,
  type KeyBinding
} from './mapping';

/** Minimal shape of the DOM events consumed (structurally satisfied by
 * KeyboardEvent; kept narrow so tests run in the node environment). */
export interface KeyboardEventLike {
  code: string;
  /** platform hint; ignored — held-state semantics make repeats harmless,
   * matching vanilla's repeated `gamekeydown[k] = true` stores. */
  repeat?: boolean;
  preventDefault?: () => void;
}

/** Minimal EventTarget surface (window in the browser, any emitter in tests). */
export interface KeyboardTargetLike {
  addEventListener(
    type: 'keydown' | 'keyup',
    listener: (e: KeyboardEventLike) => void
  ): void;
  removeEventListener(
    type: 'keydown' | 'keyup',
    listener: (e: KeyboardEventLike) => void
  ): void;
}

export interface KeyboardInput {
  /** Press a physical key (KeyboardEvent.code). Unbound codes are ignored. */
  keyDown(code: string): void;
  /** Release a physical key; clears its action only if no other bound code
   * holding the same action remains down (W + ArrowUp both = forward). */
  keyUp(code: string): void;
  /** Clear everything (vanilla memset(gamekeydown,0,...), g_game.c:491 —
   * used on focus loss / level (re)start). */
  clear(): void;
  /** Any bound action currently held? */
  isDown(action: InputAction): boolean;
  /** Number of physically down bound keys (debug/e2e introspection). */
  downCount(): number;
  /** Per-tic poll → the GameInput G_BuildTiccmd would read. */
  sample(): GameInput;
  /** Attach to a DOM-like target; returns the detach function. Bound keys
   * get preventDefault() (arrow/space page-scroll guard). */
  attach(target: KeyboardTargetLike): () => void;
}

/**
 * Vanilla KEY_* data1 codes — verbatim transcriptions of the `#define` block
 * in doomdef.h (linuxdoom-1.10, "DOOM keyboard definition"). Arrows are the
 * 0xax set, F-keys are the scancode-based 0x80+base (F11/F12 jump to 0x57/
 * 0x58), KEY_BACKSPACE is DEL (127), Enter is CR (13), Escape is 27.
 * M9-02: transcribed here so the event table and its tests share one truth.
 */
export const KEY_ESCAPE = 27;
export const KEY_ENTER = 13;
export const KEY_TAB = 9;
export const KEY_BACKSPACE = 127;
export const KEY_PAUSE = 0xff;
export const KEY_UPARROW = 0xad;
export const KEY_DOWNARROW = 0xaf;
export const KEY_LEFTARROW = 0xac;
export const KEY_RIGHTARROW = 0xae;
export const KEY_F1 = 0x80 + 0x3b; // 0xbb
export const KEY_F2 = 0x80 + 0x3c;
export const KEY_F3 = 0x80 + 0x3d;
export const KEY_F4 = 0x80 + 0x3e;
export const KEY_F5 = 0x80 + 0x3f;
export const KEY_F6 = 0x80 + 0x40;
export const KEY_F7 = 0x80 + 0x41;
export const KEY_F8 = 0x80 + 0x42;
export const KEY_F9 = 0x80 + 0x43;
export const KEY_F10 = 0x80 + 0x44;
export const KEY_F11 = 0x80 + 0x57;
export const KEY_F12 = 0x80 + 0x58;
export const KEY_EQUALS = 0x3d;
export const KEY_MINUS = 0x2d;

/** Event-level keys: DOM KeyboardEvent.code → vanilla event_t.data1
 * (doomdef.h KEY_* codes / ASCII for printables). These are NOT movement
 * channels — they model the ev_keydown/ev_keyup stream AM_Responder/
 * G_Responder consume (M2-08 seam). Keys bound to a movement action are
 * deliberately absent-or-inert here: bound codes never fire events (the
 * held-channel model already matches vanilla's gamekeydown polling; see
 * DEVIATIONS note for arrows-while-map-open).
 *
 * M9-02 additive: the FULL menu/game-flow key set M_Responder
 * (m_menu.c:1349-1710) + G_Responder consume — Esc/Enter/Backspace/arrows
 * (doomdef.h KEY_*), F1-F12 (event-only: never held, only queued), a-z /
 * 0-9 lowercase-ASCII printables (menu alphaKey scan + cheats + AM keys),
 * '-'/'=' (M_ChangeScreenSize / AM zoom). Values are identical to vanilla
 * event_t.data1: m_menu.c compares `ch = ev->data1` against these exact
 * codes (case KEY_F1 / alphaKey == ch with lowercase letters). */
export const DEFAULT_EVENT_CODES: Readonly<Record<string, number>> = {
  // --- specials (doomdef.h KEY_* constants) ---
  Tab: KEY_TAB, // KEY_MAPENTER (am_map.c AM_STARTKEY/AM_ENDKEY)
  Escape: KEY_ESCAPE, // M_Responder popup/close + message-input cancel
  Enter: KEY_ENTER, // menu fire (case KEY_ENTER), chat send
  NumpadEnter: KEY_ENTER, // same scancode family → CR 13
  Backspace: KEY_BACKSPACE, // prevMenu (case KEY_BACKSPACE, DEL 127)
  ArrowUp: KEY_UPARROW, // menu cycle / movement (polled while bound)
  ArrowDown: KEY_DOWNARROW,
  ArrowLeft: KEY_LEFTARROW, // thermo −/turn (polled while bound)
  ArrowRight: KEY_RIGHTARROW,
  // --- F-keys: event-ONLY (m_menu.c case KEY_F1..F11; KEY_F12 spy in
  // G_Responder). Never bound → never held; always queued. ---
  F1: KEY_F1,
  F2: KEY_F2,
  F3: KEY_F3,
  F4: KEY_F4,
  F5: KEY_F5,
  F6: KEY_F6,
  F7: KEY_F7,
  F8: KEY_F8,
  F9: KEY_F9,
  F10: KEY_F10,
  F11: KEY_F11,
  F12: KEY_F12,
  // --- screensize / automap (KEY_EQUALS/KEY_MINUS are plain ASCII) ---
  Equal: KEY_EQUALS, // '=' (AM_ZOOMINKEY, M_ChangeScreenSize)
  Minus: KEY_MINUS, // '-' (AM_ZOOMOUTKEY, M_ChangeScreenSize)
  // --- printables: lowercase ASCII (m_menu alphaKey table and the
  // G_Responder cheat/AM letters compare lowercase ev->data1) ---
  Digit0: 0x30, // '0' (AM_GOBIGKEY)
  Digit1: 0x31, // '1' (EpiDef alphaKey)
  Digit2: 0x32,
  Digit3: 0x33,
  Digit4: 0x34,
  Digit5: 0x35,
  Digit6: 0x36,
  Digit7: 0x37,
  Digit8: 0x38,
  Digit9: 0x39,
  KeyA: 0x61,
  KeyB: 0x62,
  KeyC: 0x63, // 'c' (AM_CLEARMARKKEY)
  KeyD: 0x64,
  KeyE: 0x65,
  KeyF: 0x66, // 'f' (AM_FOLLOWKEY)
  KeyG: 0x67, // 'g' (AM_GRIDKEY)
  KeyH: 0x68,
  KeyI: 0x69,
  KeyJ: 0x6a,
  KeyK: 0x6b,
  KeyL: 0x6c,
  KeyM: 0x6d, // 'm' (AM_MARKKEY)
  KeyN: 0x6e, // 'n' (MainMenu New Game alphaKey)
  KeyO: 0x6f, // 'o' (OptionsMenu)
  KeyP: 0x70,
  KeyQ: 0x71, // 'q' (M_QUITG alphaKey)
  KeyR: 0x72, // 'r' (M_RDTHIS)
  KeyS: 0x73, // 's' (M_SAVEG)
  KeyT: 0x74,
  KeyU: 0x75,
  KeyV: 0x76,
  KeyW: 0x77,
  KeyX: 0x78,
  KeyY: 0x79,
  KeyZ: 0x7a
};

/** Vanilla-shaped key event handed to options.onEvent.
 *
 * keyup semantics (g_game.c:571-577): ev_keyup is NEVER eaten — every keyup
 * this layer emits must reach every responder (G_Responder `return false`
 * on keyups so gamekeydown[] clears even with the menu open). This seam
 * therefore always forwards keyup packets in full pairs with their keydown;
 * consuming/eating is the responder chain's decision, not the input
 * layer's (menuMouse.ts follows the same rule for synthesized keys). */
export interface KeyboardEventPacket {
  readonly type: 'keydown' | 'keyup';
  /** event_t.data1 */
  readonly data1: number;
}

export interface KeyboardOptions {
  bindings?: readonly KeyBinding[];
  /** Auto-attach at construction (browser wiring). */
  target?: KeyboardTargetLike;
  /** M2-09 additive: event-level keys (Tab ⇒ KEY_MAPENTER) forwarded as
   * vanilla event_t pairs; caller queues/drains them (D_ProcessEvents). */
  onEvent?: (ev: KeyboardEventPacket) => void;
  /** Override of the DEFAULT_EVENT_CODES table (tests). */
  eventCodes?: Readonly<Record<string, number>>;
}

export function createKeyboardInput(options: KeyboardOptions = {}): KeyboardInput {
  const byCode = bindingsByCode(options.bindings);
  const eventCodes = options.eventCodes ?? DEFAULT_EVENT_CODES;
  const fire = (type: 'keydown' | 'keyup', code: string): void => {
    const data1 = eventCodes[code];
    if (data1 !== undefined) options.onEvent?.({ type, data1 });
  };
  // action → set of physically down codes for that action (multi-binding
  // safe: releasing KeyW must not clear `forward` while ArrowUp is held).
  const held = new Map<InputAction, Set<string>>();
  const downCodes = new Set<string>();

  const heldActions = (): Set<InputAction> => {
    const out = new Set<InputAction>();
    for (const [action, codes] of held) if (codes.size) out.add(action);
    return out;
  };

  const keyDown = (code: string): void => {
    const action = byCode.get(code);
    if (action === undefined) {
      fire('keydown', code); // event-level key (Tab etc.) — no held channel
      return;
    }
    downCodes.add(code);
    let codes = held.get(action);
    if (!codes) held.set(action, (codes = new Set()));
    codes.add(code); // repeat re-store = vanilla `gamekeydown[k] = true`
  };

  const keyUp = (code: string): void => {
    const action = byCode.get(code);
    if (action === undefined) {
      fire('keyup', code);
      return;
    }
    downCodes.delete(code);
    held.get(action)?.delete(code);
  };

  const clear = (): void => {
    downCodes.clear();
    for (const codes of held.values()) codes.clear();
  };

  let attachedTarget: KeyboardTargetLike | null = null;
  const attach = (target: KeyboardTargetLike): (() => void) => {
    const onDown = (e: KeyboardEventLike): void => {
      if (byCode.has(e.code) || eventCodes[e.code] !== undefined) {
        e.preventDefault?.(); // arrow/page-scroll guard + Tab focus guard
      }
      keyDown(e.code);
    };
    const onUp = (e: KeyboardEventLike): void => keyUp(e.code);
    target.addEventListener('keydown', onDown);
    target.addEventListener('keyup', onUp);
    attachedTarget = target;
    return () => {
      target.removeEventListener('keydown', onDown);
      target.removeEventListener('keyup', onUp);
      if (attachedTarget === target) attachedTarget = null;
      clear(); // stale keys must not survive a detach
    };
  };

  const api: KeyboardInput = {
    keyDown,
    keyUp,
    clear,
    isDown: (action) => (held.get(action)?.size ?? 0) > 0,
    downCount: () => downCodes.size,
    sample: () => sampleInput(heldActions()),
    attach
  };

  if (options.target) attach(options.target);
  return api;
}
