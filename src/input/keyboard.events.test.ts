/**
 * input/keyboard event-level seam tests (M2-09 additive): KEY_MAPENTER
 * (Tab ⇒ doomdef.h KEY_TAB = 9, am_map.c AM_STARTKEY/AM_ENDKEY) must be
 * forwarded as vanilla event_t pairs through options.onEvent — held-state
 * movement semantics stay untouched (the M2-07 tests pin those).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  createKeyboardInput,
  DEFAULT_EVENT_CODES,
  type KeyboardEventLike,
  type KeyboardEventPacket
} from './keyboard';

// ---------------------------------------------------------------------------
// doomdef.h (linuxdoom-1.10) "DOOM keyboard definition" block, transcribed
// INDEPENDENTLY of src/input/keyboard.ts for the M9-02 table test. Verbatim
// from the release source:
//   #define KEY_RIGHTARROW 0xae   #define KEY_LEFTARROW  0xac
//   #define KEY_UPARROW    0xad   #define KEY_DOWNARROW  0xaf
//   #define KEY_ESCAPE     27     #define KEY_ENTER      13
//   #define KEY_TAB        9      #define KEY_BACKSPACE  127
//   #define KEY_F1 (0x80+0x3b) … KEY_F10 (0x80+0x44)
//   #define KEY_F11 (0x80+0x57)  KEY_F12 (0x80+0x58)
//   #define KEY_EQUALS 0x3d      #define KEY_MINUS 0x2d
// Printables are plain (lowercase) ASCII: m_menu.c compares alphaKey ==
// ev->data1 against lowercase letters; the digits are ASCII '0'..'9'.
// ---------------------------------------------------------------------------
const D_DOOMDEF = {
  Escape: 27,
  Enter: 13,
  NumpadEnter: 13,
  Backspace: 127,
  ArrowUp: 0xad,
  ArrowDown: 0xaf,
  ArrowLeft: 0xac,
  ArrowRight: 0xae,
  F1: 0x80 + 0x3b,
  F2: 0x80 + 0x3c,
  F3: 0x80 + 0x3d,
  F4: 0x80 + 0x3e,
  F5: 0x80 + 0x3f,
  F6: 0x80 + 0x40,
  F7: 0x80 + 0x41,
  F8: 0x80 + 0x42,
  F9: 0x80 + 0x43,
  F10: 0x80 + 0x44,
  F11: 0x80 + 0x57,
  F12: 0x80 + 0x58,
  Minus: 0x2d,
  Equal: 0x3d
} as const;

class FakeTarget {
  private readonly handlers = new Map<string, ((e: KeyboardEventLike) => void)[]>();
  readonly prevented: string[] = [];

  addEventListener(type: 'keydown' | 'keyup', h: (e: KeyboardEventLike) => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(h);
    this.handlers.set(type, list);
  }
  removeEventListener(type: 'keydown' | 'keyup', h: (e: KeyboardEventLike) => void): void {
    const list = this.handlers.get(type) ?? [];
    this.handlers.set(type, list.filter((g) => g !== h));
  }
  emit(type: 'keydown' | 'keyup', code: string): void {
    let prevented = false;
    const e: KeyboardEventLike = {
      code,
      preventDefault: () => {
        prevented = true;
      }
    };
    for (const h of this.handlers.get(type) ?? []) h(e);
    if (prevented) this.prevented.push(code);
  }
}

describe('event-level keys (KEY_MAPENTER / Tab)', () => {
  it('DEFAULT_EVENT_CODES maps Tab to KEY_TAB = 9', () => {
    expect(DEFAULT_EVENT_CODES['Tab']).toBe(9);
  });

  it('keydown/keyup of Tab emit vanilla-shaped events with data1=9', () => {
    const got: KeyboardEventPacket[] = [];
    createKeyboardInput({ onEvent: (ev) => got.push(ev) }).keyDown('Tab');
    createKeyboardInput({ onEvent: (ev) => got.push(ev) }).keyUp('Tab');
    expect(got).toEqual([
      { type: 'keydown', data1: 9 },
      { type: 'keyup', data1: 9 }
    ]);
  });

  it('non-table codes stay silent; movement keys do not double-fire', () => {
    const got: KeyboardEventPacket[] = [];
    const k = createKeyboardInput({ onEvent: (ev) => got.push(ev) });
    k.keyDown('ShiftLeft'); // modifiers are not in the M9-02 table
    k.keyUp('ShiftLeft');
    k.keyDown('KeyW');
    k.keyUp('KeyW');
    expect(got).toEqual([]);
    expect(k.downCount()).toBe(0);
  });

  it('M9-02: a bound movement code never fires an event (held split wins)', () => {
    const got: KeyboardEventPacket[] = [];
    const k = createKeyboardInput({ onEvent: (ev) => got.push(ev) });
    k.keyDown('ArrowUp'); // bound → polled held-channel, not queued
    k.keyUp('ArrowUp');
    expect(got).toEqual([]);
    expect(k.isDown('forward')).toBe(false); // up ⇒ cleared
  });

  it('Tab does not register as a held movement key', () => {
    const k = createKeyboardInput({ onEvent: () => undefined });
    k.keyDown('Tab');
    expect(k.downCount()).toBe(0);
    expect(k.sample().forward).toBe(false);
  });

  it('attached: Tab is preventDefault-ed (focus guard) and forwarded', () => {
    const t = new FakeTarget();
    const got: KeyboardEventPacket[] = [];
    const detach = createKeyboardInput({ onEvent: (ev) => got.push(ev) }).attach(t);
    t.emit('keydown', 'Tab');
    t.emit('keyup', 'Tab');
    detach();
    expect(got).toEqual([
      { type: 'keydown', data1: 9 },
      { type: 'keyup', data1: 9 }
    ]);
    expect(t.prevented).toEqual(['Tab']);
  });

  it('M9-02 data1 table: every key M_Responder/G_Responder consumes is'
    + ' byte-identical to the transcribed doomdef.h constants', () => {
    // specials + F-keys straight from the transcription block.
    for (const [code, data1] of Object.entries(D_DOOMDEF)) {
      expect(DEFAULT_EVENT_CODES[code], code).toBe(data1);
    }
    // a-z → lowercase ASCII (menu alphaKey + AM_*/cheat letters).
    for (let c = 0x61; c <= 0x7a; c++) {
      const code = `Key${String.fromCharCode(c - 0x61 + 65)}`;
      expect(DEFAULT_EVENT_CODES[code], code).toBe(c);
    }
    // 0-9 → ASCII '0'..'9' (EpiDef alphaKeys, AM_GOBIGKEY).
    for (let d = 0; d <= 9; d++) {
      expect(DEFAULT_EVENT_CODES[`Digit${d}`], `Digit${d}`).toBe(0x30 + d);
    }
  });

  it('M9-02: F-keys are event-only — queued down+up, never held', () => {
    const got: KeyboardEventPacket[] = [];
    const k = createKeyboardInput({ onEvent: (ev) => got.push(ev) });
    for (const [code, data1] of [
      ['F1', 0xbb],
      ['F2', 0xbc],
      ['F3', 0xbd],
      ['F4', 0xbe],
      ['F7', 0xc1],
      ['F11', 215],
      ['F12', 216]
    ] as const) {
      k.keyDown(code);
      k.keyUp(code);
      expect(k.downCount()).toBe(0);
      expect(k.sample().forward).toBe(false);
      expect(k.sample().turnLeft).toBe(false);
      expect(got.slice(-2)).toEqual([
        { type: 'keydown', data1 },
        { type: 'keyup', data1 }
      ]);
    }
    // 7 F-keys × (down+up) = 14 packets, all keydowns queued in order.
    expect(got.length).toBe(14);
    expect(got.filter((e) => e.type === 'keydown').length).toBe(7);
  });

  it('M9-02: arrows reach the queue with doomdef data1 when unbound'
    + ' (menu-only binding table; held split otherwise — polled)', () => {
    const got: KeyboardEventPacket[] = [];
    // No movement bindings at all (menu mode): arrows are pure events now.
    const k = createKeyboardInput({
      bindings: [{ code: 'KeyE', action: 'use' }],
      onEvent: (ev) => got.push(ev)
    });
    k.keyDown('ArrowDown');
    k.keyUp('ArrowDown');
    expect(got).toEqual([
      { type: 'keydown', data1: D_DOOMDEF.ArrowDown },
      { type: 'keyup', data1: D_DOOMDEF.ArrowDown }
    ]);
    expect(k.downCount()).toBe(0);
    // keyup NEVER eaten (g_game.c:571): the keyup packet is present even
    // though a responder would eat the keydown.
    expect(got[1]?.type).toBe('keyup');
  });

  it('eventCodes override replaces the table', () => {
    const got: KeyboardEventPacket[] = [];
    const k = createKeyboardInput({
      onEvent: (ev) => got.push(ev),
      eventCodes: { f: 0x66 }
    });
    k.keyDown('Tab'); // not in the override ⇒ silent
    k.keyDown('KeyF'); // code 'KeyF' not mapped either
    k.keyDown('f');
    expect(got).toEqual([{ type: 'keydown', data1: 0x66 }]);
  });
});
