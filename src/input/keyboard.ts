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

export interface KeyboardOptions {
  bindings?: readonly KeyBinding[];
  /** Auto-attach at construction (browser wiring). */
  target?: KeyboardTargetLike;
}

export function createKeyboardInput(options: KeyboardOptions = {}): KeyboardInput {
  const byCode = bindingsByCode(options.bindings);
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
    if (action === undefined) return;
    downCodes.add(code);
    let codes = held.get(action);
    if (!codes) held.set(action, (codes = new Set()));
    codes.add(code); // repeat re-store = vanilla `gamekeydown[k] = true`
  };

  const keyUp = (code: string): void => {
    const action = byCode.get(code);
    if (action === undefined) return;
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
      if (byCode.has(e.code)) e.preventDefault?.();
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
