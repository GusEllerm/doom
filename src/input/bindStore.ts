// input/bindStore.ts — the keyboard binding table as DATA (M11-03).
//
// Plan §M11-03/§0.6 (D-11d): 1.10 has NO bind menu — the configurable
// keys are EXACTLY the ten `key_*` variables of m_misc.c defaultvars
// (:243-253, read by M_LoadDefaults, written at quit by M_SaveDefaults).
// This module makes A-09’s table (input/mapping.ts — the behavior side,
// unchanged) readable/writable as data and exposes the default.cfg face
// (configVars/applyConfigVars) that M11-07 persists; the IDB hookup is
// M11-07’s (settings.ts → bindStore), NOT here.
//
// Byte truth (doomdef.h:250-278, verified in the restored mirror):
//   KEY_RIGHTARROW 0xae (:250) · KEY_LEFTARROW 0xac (:249)
//   KEY_UPARROW 0xad · KEY_DOWNARROW 0xaf · ',' 0x2c · '.' 0x2e
//   KEY_RCTRL 0x80+0x1d=0x9d (:277) · ' ' 0x20
//   KEY_RALT 0x80+0x38=0xb8 (:278) · KEY_RSHIFT 0x80+0x36=0xb6 (:276)
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { DEFAULT_EVENT_CODES } from './keyboard';
import {
  DEFAULT_BINDINGS,
  KEY_RALT,
  KEY_RCTRL,
  KEY_RSHIFT,
  type InputAction,
  type KeyBinding,
  type VanillaVarRef,
} from './mapping';

/** The ten default.cfg key_* variables, extracted from the DEFAULT_
 * BINDINGS rows that own them (vanillaKey + cite ride the data). */
export interface VanillaBindVar {
  readonly name: VanillaVarRef['name'];
  /** the DOM physical key this variable’s default value denotes */
  readonly domCode: string;
  /** the movement/action channel the variable gates */
  readonly channel: InputAction;
  /** m_misc.c:243-253 default value (the byte pinned by tests) */
  readonly defaultKey: number;
  readonly cite: string;
}

export const KEY_VANILLA_VARS: readonly VanillaBindVar[] = DEFAULT_BINDINGS.flatMap(
  (b) =>
    b.vanilla
      ? [{ name: b.vanilla.name, domCode: b.code, channel: b.action, defaultKey: b.vanilla.vanillaKey, cite: b.vanilla.cite }]
      : []
);

/** DOM code → vanilla key code (the units default.cfg stores). Covers
 * the codes the table can hold: event specials/letters/digits via the
 * keyboard layer’s transcription plus the polled modifiers (a code with
 * no vanilla face reports 0 = “not a config key”). */
const DOM_TO_VANILLA: ReadonlyMap<string, number> = new Map([
  ...Object.entries(DEFAULT_EVENT_CODES),
  ['Space', 0x20], // ' '
  ['Comma', 0x2c], // ','
  ['Period', 0x2e], // '.'
  ['ControlRight', KEY_RCTRL],
  ['AltRight', KEY_RALT],
  ['ShiftRight', KEY_RSHIFT]
]);

export function vanillaKeyCode(code: string): number {
  return DOM_TO_VANILLA.get(code) ?? 0;
}

/** Inverse (first-wins in insertion order) for applyConfigVars. */
const VANILLA_TO_DOM: ReadonlyMap<number, string> = (() => {
  const m = new Map<number, string>();
  for (const [code, key] of [...DOM_TO_VANILLA].reverse()) m.set(key, code);
  return m;
})();

/** The mutable binding set + the default.cfg face. Pure in-memory:
 * NOTHING here touches IndexedDB (that mount is M11-07’s settings.ts). */
export interface BindStore {
  /** the m_misc.c + A-09 default table (data, cite-annotated) */
  defaults(): readonly KeyBinding[];
  /** current effective table (table order = resolution order) */
  bindings(): readonly KeyBinding[];
  /** action for a physical code (later match wins, bindingsByCode) */
  get(code: string): InputAction | undefined;
  codesFor(action: InputAction): readonly string[];
  /** add/replace the binding for a physical code */
  set(code: string, action: InputAction): void;
  /** remove every binding for a physical code */
  unbind(code: string): void;
  /** wholesale replace (settings hydration — M11-07 mount point) */
  replaceAll(bindings: readonly KeyBinding[]): void;
  /** back to DEFAULT_BINDINGS */
  reset(): void;
  /** the ten key_* variables (default.cfg values, §0.6): the vanilla
   * code of each variable’s default DOM code while that code still
   * serves the variable’s channel; 0 = unbound/repurposed */
  configVars(): Record<string, number>;
  /** write the variables back (boot hydration); codes with no DOM face
   * are skipped and reported. Returns the applied variable names. */
  applyConfigVars(vars: Readonly<Record<string, number>>): {
    applied: string[];
    skipped: string[];
  };
}

export function createBindStore(seed: readonly KeyBinding[] = DEFAULT_BINDINGS): BindStore {
  let table: KeyBinding[] = seed.map((b) => ({ ...b }));

  const store: BindStore = {
    defaults: () => DEFAULT_BINDINGS,
    bindings: () => table.map((b) => ({ ...b })),
    get: (code) => table.find((b) => b.code === code)?.action,
    codesFor: (action) => table.filter((b) => b.action === action).map((b) => b.code),
    set: (code, action) => {
      const hit = table.find((b) => b.code === code);
      if (hit) hit.action = action;
      else table.push({ code, action });
    },
    unbind: (code) => {
      table = table.filter((b) => b.code !== code);
    },
    replaceAll: (bindings) => {
      table = bindings.map((b) => ({ ...b }));
    },
    reset: () => {
      table = DEFAULT_BINDINGS.map((b) => ({ ...b }));
    },
    configVars: () => {
      const out: Record<string, number> = {};
      for (const v of KEY_VANILLA_VARS) {
        const cur = table.find((b) => b.code === v.domCode);
        out[v.name] = cur !== undefined && cur.action === v.channel ? vanillaKeyCode(v.domCode) : 0;
      }
      return out;
    },
    applyConfigVars: (vars) => {
      const applied: string[] = [];
      const skipped: string[] = [];
      for (const v of KEY_VANILLA_VARS) {
        const val = vars[v.name];
        if (val === undefined) continue;
        if (val === v.defaultKey) {
          store.set(v.domCode, v.channel);
          applied.push(v.name);
          continue;
        }
        const dom = val === 0 ? undefined : VANILLA_TO_DOM.get(val);
        if (dom === undefined) {
          skipped.push(v.name);
          continue;
        }
        // re-point the channel: the variable’s default code leaves, the
        // new code arrives (vanilla keeps exactly one key per action).
        const old = table.find((b) => b.code === v.domCode);
        if (old && old.action === v.channel) table = table.filter((b) => b !== old);
        store.set(dom, v.channel);
        applied.push(v.name);
      }
      return { applied, skipped };
    }
  };
  return store;
}

/** Process-wide store the boot/settings mount uses (tests reset it). */
export const bindStore: BindStore = createBindStore();

/** Test seam: back to the m_misc.c + A-09 defaults. */
export function resetBindStore(): void {
  bindStore.reset();
}

/** Back-compat with the stub first commit. */
export function bindStoreDefaults(): readonly KeyBinding[] {
  return DEFAULT_BINDINGS;
}
