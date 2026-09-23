// input/mapping.ts — default keyboard binding table (ADR A-09) and the
// held-action → GameInput sampler (M2-07, ARCHITECTURE §4 input mapping).
//
// Source truth (linuxdoom-1.10):
//  - There is NO `ev_turn` event in this source. d_event.h knows
//    ev_keydown/ev_keyup/ev_mouse/ev_joystick only; keyboard turning is
//    state POLLED per tic in G_BuildTiccmd from `gamekeydown[]` (g_game.c
//    :266-329), which G_Responder fills from ev_keydown/ev_keyup
//    (g_game.c:567/572). So a held arrow key = "gamekeydown[key_right]
//    stays true" — no discrete turn impulses, no key-repeat angles. The
//    turnheld ramp (SLOWTURNTICS) lives in G_BuildTiccmd, which our merged
//    sim/ticcmd.ts already ports verbatim.
//  - Vanilla default keys: m_misc.c defaultvars — arrows = key_right/left/
//    up/down, ',' '.' = strafeleft/right, RCTRL fire, SPACE use, RALT
//    strafe-modifier, RSHIFT speed. A-09 layers WASD on top as primary
//    (W/S = up/down — identical to the DOS build's KEY_w/KEY_s; A/D = the
//    vanilla strafeleft/straferight keys, so "A/D strafe" is vanilla-true).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { emptyInput, type GameInput } from '../sim/ticcmd';
import { KEY_DOWNARROW, KEY_LEFTARROW, KEY_RIGHTARROW, KEY_UPARROW } from './keyboard';

/** doomdef.h:276-278 (right-side modifier event codes; the keyboard
 * layer’s DEFAULT_EVENT_CODES owns the polled gamekeydown path — these
 * are the CONFIG values m_misc.c stores, M11-03). */
export const KEY_RSHIFT = 0x80 + 0x36;
export const KEY_RCTRL = 0x80 + 0x1d;
export const KEY_RALT = 0x80 + 0x38;

/** Semantic channels, mirroring sim/ticcmd GameInput (the sim never sees
 * key codes — §3.5-2: input enters only as quantized ticcmds). */
export type InputAction =
  | 'forward'
  | 'backward'
  | 'turnLeft'
  | 'turnRight'
  | 'strafeLeft'
  | 'strafeRight'
  | 'strafe'
  | 'speed'
  | 'attack'
  | 'use';

/**
 * M11-03 (§0.6/D-11d): the default.cfg identity of a binding — the ten
 * key_* variables of m_misc.c defaultvars and their COMPILED defaults
 * (the vanilla key codes G_Responder polls). Absent on A-09 additions
 * (WASD letters): those ride the table but own no config variable.
 */
export interface VanillaVarRef {
  readonly name:
    | 'key_right' | 'key_left' | 'key_up' | 'key_down'
    | 'key_strafeleft' | 'key_straferight'
    | 'key_fire' | 'key_use' | 'key_strafe' | 'key_speed';
  /** the m_misc.c default value (doomdef.h KEY_* / ASCII, doomdef.h:250-278) */
  readonly vanillaKey: number;
  /** source line of the row in the defaultvars table */
  readonly cite: string;
}

export interface KeyBinding {
  /** DOM KeyboardEvent.code (layout-independent physical key). */
  code: string;
  action: InputAction;
  /** present exactly on the ten m_misc.c-owned entries (M11-03). */
  vanilla?: VanillaVarRef;
}

/**
 * A-09 default table: WASD primary + the full vanilla-compat set
 * (m_misc.c defaultvars values). TAB/Escape/F-keys (menu/automap) are
 * event-level bindings owned by M2-08/M2-10, not movement channels.
 * Several codes may share an action; any bound code releases independently.
 */
export const DEFAULT_BINDINGS: readonly KeyBinding[] = [
  // WASD (A-09 primary; W/S match vanilla DOS KEY_w/KEY_s, A/D match the
  // vanilla strafeleft/straferight defaults)
  { code: 'KeyW', action: 'forward' },
  { code: 'KeyS', action: 'backward' },
  { code: 'KeyA', action: 'strafeLeft' },
  { code: 'KeyD', action: 'strafeRight' },
  // vanilla-compat set (m_misc.c defaultvars — the `vanilla` fields are
  // the M11-03 data export: var name + byte-identical default key code)
  { code: 'ArrowUp', action: 'forward', vanilla: { name: 'key_up', vanillaKey: KEY_UPARROW, cite: 'm_misc.c:245' } },
  { code: 'ArrowDown', action: 'backward', vanilla: { name: 'key_down', vanillaKey: KEY_DOWNARROW, cite: 'm_misc.c:246' } },
  { code: 'ArrowLeft', action: 'turnLeft', vanilla: { name: 'key_left', vanillaKey: KEY_LEFTARROW, cite: 'm_misc.c:244' } }, // key_left  = KEY_LEFTARROW
  { code: 'ArrowRight', action: 'turnRight', vanilla: { name: 'key_right', vanillaKey: KEY_RIGHTARROW, cite: 'm_misc.c:243' } }, // key_right = KEY_RIGHTARROW
  { code: 'Comma', action: 'strafeLeft', vanilla: { name: 'key_strafeleft', vanillaKey: 0x2c, cite: "m_misc.c:247 (key_strafeleft = ',')" } },
  { code: 'Period', action: 'strafeRight', vanilla: { name: 'key_straferight', vanillaKey: 0x2e, cite: "m_misc.c:248 (key_straferight = '.')" } },
  { code: 'ControlRight', action: 'attack', vanilla: { name: 'key_fire', vanillaKey: KEY_RCTRL, cite: 'm_misc.c:250' } }, // key_fire  = KEY_RCTRL
  { code: 'Space', action: 'use', vanilla: { name: 'key_use', vanillaKey: 0x20, cite: "m_misc.c:251 (key_use = ' ')" } }, // key_use   = ' '
  { code: 'AltRight', action: 'strafe', vanilla: { name: 'key_strafe', vanillaKey: KEY_RALT, cite: 'm_misc.c:252' } }, // key_strafe = KEY_RALT
  { code: 'ShiftRight', action: 'speed', vanilla: { name: 'key_speed', vanillaKey: KEY_RSHIFT, cite: 'm_misc.c:253' } } // key_speed  = KEY_RSHIFT
];

/** Index a binding list by physical code (later entries win). */
export function bindingsByCode(
  bindings: readonly KeyBinding[] = DEFAULT_BINDINGS
): ReadonlyMap<string, InputAction> {
  const map = new Map<string, InputAction>();
  for (const b of bindings) map.set(b.code, b.action);
  return map;
}

/**
 * Resolve a set of currently-held actions into the per-tic GameInput
 * snapshot — the typed stand-in for one G_BuildTiccmd poll of
 * gamekeydown[]/key_strafe/key_speed (g_game.c:256-329). Arrow keys feed
 * turnLeft/turnRight and the strafe MODIFIER is resolved downstream by
 * gBuildTiccmd exactly like vanilla; comma/period (and A/D) feed the
 * dedicated strafe channels.
 */
export function sampleInput(held: ReadonlySet<InputAction>): GameInput {
  const input = emptyInput();
  input.forward = held.has('forward');
  input.backward = held.has('backward');
  input.turnLeft = held.has('turnLeft');
  input.turnRight = held.has('turnRight');
  input.strafeLeft = held.has('strafeLeft');
  input.strafeRight = held.has('strafeRight');
  input.strafe = held.has('strafe');
  input.speed = held.has('speed');
  input.attack = held.has('attack');
  input.use = held.has('use');
  return input;
}
