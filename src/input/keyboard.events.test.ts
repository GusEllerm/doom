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

  it('unbound, uneventful keys stay silent; movement keys do not double-fire', () => {
    const got: KeyboardEventPacket[] = [];
    const k = createKeyboardInput({ onEvent: (ev) => got.push(ev) });
    k.keyDown('KeyQ');
    k.keyUp('KeyQ');
    k.keyDown('KeyW');
    k.keyUp('KeyW');
    expect(got).toEqual([]);
    expect(k.downCount()).toBe(0);
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
