/**
 * input/mapping tests (M2-07): the A-09 default table (WASD primary + the
 * vanilla m_misc.c defaultvars set) and the GameInput sampler.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  bindingsByCode,
  DEFAULT_BINDINGS,
  sampleInput,
  type InputAction
} from './mapping';

const ALL: readonly InputAction[] = [
  'forward',
  'backward',
  'turnLeft',
  'turnRight',
  'strafeLeft',
  'strafeRight',
  'strafe',
  'speed',
  'attack',
  'use'
];

describe('A-09 default bindings', () => {
  it('maps the WASD set: W/S forward/back, A/D strafe (vanilla-true)', () => {
    const m = bindingsByCode();
    expect(m.get('KeyW')).toBe('forward');
    expect(m.get('KeyS')).toBe('backward');
    expect(m.get('KeyA')).toBe('strafeLeft');
    expect(m.get('KeyD')).toBe('strafeRight');
  });

  it('maps the vanilla-compat set (m_misc.c defaultvars)', () => {
    const m = bindingsByCode();
    expect(m.get('ArrowUp')).toBe('forward'); // key_up = KEY_UPARROW
    expect(m.get('ArrowDown')).toBe('backward'); // key_down
    expect(m.get('ArrowLeft')).toBe('turnLeft'); // key_left  (TURN key)
    expect(m.get('ArrowRight')).toBe('turnRight'); // key_right (TURN key)
    expect(m.get('Comma')).toBe('strafeLeft'); // ',' = key_strafeleft
    expect(m.get('Period')).toBe('strafeRight'); // '.' = key_straferight
    expect(m.get('ControlRight')).toBe('attack'); // KEY_RCTRL = key_fire
    expect(m.get('Space')).toBe('use'); // ' ' = key_use
    expect(m.get('AltRight')).toBe('strafe'); // KEY_RALT = key_strafe
    expect(m.get('ShiftRight')).toBe('speed'); // KEY_RSHIFT = key_speed
  });

  it('covers every semantic channel at least once', () => {
    const covered = new Set(DEFAULT_BINDINGS.map((b) => b.action));
    for (const a of ALL) expect(covered.has(a), a).toBe(true);
  });

  it('turns stay separate channels from strafes (strafe MODIFIER handled in G_BuildTiccmd)', () => {
    expect(bindingsByCode().get('ArrowLeft')).toBe('turnLeft');
    expect(bindingsByCode().get('KeyA')).toBe('strafeLeft');
  });
});

describe('sampleInput', () => {
  it('empty set yields the all-false snapshot', () => {
    expect(sampleInput(new Set())).toEqual({
      forward: false,
      backward: false,
      turnLeft: false,
      turnRight: false,
      strafeLeft: false,
      strafeRight: false,
      strafe: false,
      speed: false,
      attack: false,
      use: false,
      // M5-07: keyboard-only snapshot ⇒ mouse channels idle (0 deltas).
      mouseX: 0,
      mouseY: 0
    });
  });

  it('projects held actions 1:1 onto the GameInput channels', () => {
    const held = new Set<InputAction>(['forward', 'turnRight', 'speed']);
    const s = sampleInput(held);
    expect(s.forward).toBe(true);
    expect(s.turnRight).toBe(true);
    expect(s.speed).toBe(true);
    expect(s.turnLeft).toBe(false);
    expect(s.strafe).toBe(false);
  });
});
