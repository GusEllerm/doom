/**
 * Tests for input/bindStore.ts — M11-03 (plan §M11-03/§0.6, D-11d).
 *
 * The headline acceptance: the exported default table is BYTE-EQUAL to
 * the m_misc.c defaultvars key_* rows (:243-253, re-opened in the
 * restored mirror) — variable names, vanilla key codes (doomdef.h:249-
 * 278), and the A-09 stance that WASD letters ride the table WITHOUT
 * owning a config variable.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_BINDINGS } from './mapping';
import { KEY_RALT, KEY_RCTRL, KEY_RSHIFT } from './mapping';
import {
  bindStore,
  createBindStore,
  KEY_VANILLA_VARS,
  resetBindStore,
  vanillaKeyCode,
} from './bindStore';

/* m_misc.c:243-253 transcribed byte-for-byte (doomdef.h:249-278 codes) */
const M_MISC_DEFAULTS: Readonly<Record<string, number>> = {
  key_right: 0xae, // KEY_RIGHTARROW   m_misc.c:243 / doomdef.h:250
  key_left: 0xac, // KEY_LEFTARROW    m_misc.c:244 / doomdef.h:249
  key_up: 0xad, // KEY_UPARROW      m_misc.c:245 / doomdef.h:252
  key_down: 0xaf, // KEY_DOWNARROW    m_misc.c:246 / doomdef.h:251
  key_strafeleft: 0x2c, // ','              m_misc.c:247
  key_straferight: 0x2e, // '.'              m_misc.c:248
  key_fire: 0x9d, // KEY_RCTRL        m_misc.c:250 / doomdef.h:277
  key_use: 0x20, // ' '              m_misc.c:251
  key_strafe: 0xb8, // KEY_RALT         m_misc.c:252 / doomdef.h:278
  key_speed: 0xb6 // KEY_RSHIFT       m_misc.c:253 / doomdef.h:276
};

beforeEach(() => {
  resetBindStore();
});

describe('default table as DATA (mapping.ts, m_misc.c byte truth)', () => {
  it('exactly the ten m_misc.c variables carry a vanilla face', () => {
    const owned = DEFAULT_BINDINGS.filter((b) => b.vanilla).map((b) => b.vanilla!.name);
    expect(owned.sort()).toEqual(Object.keys(M_MISC_DEFAULTS).sort());
    expect(KEY_VANILLA_VARS).toHaveLength(10);
    expect(KEY_VANILLA_VARS.map((v) => v.cite).every((c) => c.startsWith('m_misc.c:'))).toBe(true);
  });

  it('byte-pin: each variable’s defaultKey == its m_misc.c row', () => {
    for (const v of KEY_VANILLA_VARS) {
      expect(v.defaultKey, v.name).toBe(M_MISC_DEFAULTS[v.name]);
    }
    // the modifier constants themselves (doomdef.h:276-278)
    expect(KEY_RSHIFT).toBe(0xb6);
    expect(KEY_RCTRL).toBe(0x9d);
    expect(KEY_RALT).toBe(0xb8);
  });

  it('A-09 additions own NO variable (WASD letters stay extras)', () => {
    for (const code of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
      expect(DEFAULT_BINDINGS.find((b) => b.code === code)!.vanilla).toBeUndefined();
    }
  });
});

describe('bindStore get/set (the M11-07 mount surface)', () => {
  it('defaults resolve through the table; later-entry-wins preserved', () => {
    expect(bindStore.get('ArrowUp')).toBe('forward');
    expect(bindStore.get('Comma')).toBe('strafeLeft');
    expect(bindStore.codesFor('strafeLeft')).toEqual(['KeyA', 'Comma']);
  });

  it('set replaces in place, unbind removes, reset restores the table', () => {
    bindStore.set('ArrowLeft', 'strafeLeft');
    expect(bindStore.get('ArrowLeft')).toBe('strafeLeft');
    bindStore.unbind('ArrowLeft');
    expect(bindStore.get('ArrowLeft')).toBeUndefined();
    bindStore.reset();
    expect(bindStore.bindings()).toEqual(bindStore.defaults());
  });

  it('replaceAll hydrates a saved table (settings-mount shape)', () => {
    const saved = [{ code: 'KeyE', action: 'use' as const }];
    bindStore.replaceAll(saved);
    expect(bindStore.bindings()).toEqual(saved);
    expect(bindStore.get('Space')).toBeUndefined();
  });
});

describe('configVars — the default.cfg face (key_* variables, §0.6)', () => {
  it('fresh store is byte-equal to the m_misc.c defaults', () => {
    expect(bindStore.configVars()).toEqual(M_MISC_DEFAULTS);
  });

  it('unbind/repurpose reads as 0 (no vanilla face to store)', () => {
    bindStore.unbind('ArrowLeft');
    expect(bindStore.configVars().key_left).toBe(0);
    bindStore.reset();
    bindStore.set('ArrowLeft', 'strafeLeft'); // repurposed, not turning
    expect(bindStore.configVars().key_left).toBe(0);
  });

  it('vanillaKeyCode: table codes + letters via the keyboard transcription', () => {
    expect(vanillaKeyCode('ArrowRight')).toBe(0xae);
    expect(vanillaKeyCode('Space')).toBe(0x20);
    expect(vanillaKeyCode('ControlRight')).toBe(0x9d);
    expect(vanillaKeyCode('KeyQ')).toBe(0x71); // ASCII via DEFAULT_EVENT_CODES
    expect(vanillaKeyCode('F13')).toBe(0); // no vanilla face at all
  });

  it('applyConfigVars re-points channels; unknown codes are skipped', () => {
    const fresh = createBindStore();
    // vanilla-style: key_strafeleft moves from ',' to 'a'
    const r = fresh.applyConfigVars({ key_strafeleft: 0x61 });
    expect(r.applied).toEqual(['key_strafeleft']);
    expect(fresh.get('Comma')).toBeUndefined();
    expect(fresh.get('KeyA')).toBe('strafeLeft');
    // the VARIABLE reads 0 (its default code ',' left the channel) while
    // the ACTION is served by KeyA — the A-09 N:1 shape, documented.
    expect(fresh.configVars().key_strafeleft).toBe(0);
    const bad = fresh.applyConfigVars({ key_fire: 0x01 }); // no DOM face
    expect(bad.skipped).toEqual(['key_fire']);
    expect(fresh.get('ControlRight')).toBe('attack'); // untouched
  });

  it('applyConfigVars restores a default byte exactly (round-trip)', () => {
    const fresh = createBindStore();
    fresh.unbind('ArrowUp');
    expect(fresh.configVars().key_up).toBe(0);
    fresh.applyConfigVars(M_MISC_DEFAULTS);
    expect(fresh.configVars()).toEqual(M_MISC_DEFAULTS);
  });
});
