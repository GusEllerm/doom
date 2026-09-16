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

export interface KeyBinding {
  /** DOM KeyboardEvent.code (layout-independent physical key). */
  code: string;
  action: InputAction;
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
  // vanilla-compat set (m_misc.c defaultvars)
  { code: 'ArrowUp', action: 'forward' },
  { code: 'ArrowDown', action: 'backward' },
  { code: 'ArrowLeft', action: 'turnLeft' }, // key_left  = KEY_LEFTARROW
  { code: 'ArrowRight', action: 'turnRight' }, // key_right = KEY_RIGHTARROW
  { code: 'Comma', action: 'strafeLeft' }, // key_strafeleft  = ','
  { code: 'Period', action: 'strafeRight' }, // key_straferight = '.'
  { code: 'ControlRight', action: 'attack' }, // key_fire  = KEY_RCTRL
  { code: 'Space', action: 'use' }, // key_use   = ' '
  { code: 'AltRight', action: 'strafe' }, // key_strafe = KEY_RALT
  { code: 'ShiftRight', action: 'speed' } // key_speed  = KEY_RSHIFT
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
