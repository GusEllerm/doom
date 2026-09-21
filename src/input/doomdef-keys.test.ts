/**
 * M9-02 data1 table test: DEFAULT_EVENT_CODES vs. the doomdef.h KEY_*
 * constants, transcribed independently here (raw values as they appear in
 * the linuxdoom-1.10 release `doomdef.h` "DOOM keyboard definition" block)
 * so a typo in src/input/keyboard.ts cannot silently agree with itself.
 *
 * Transcription (verbatim from the release source):
 *   #define KEY_RIGHTARROW  0xae
 *   #define KEY_LEFTARROW   0xac
 *   #define KEY_UPARROW     0xad
 *   #define KEY_DOWNARROW   0xaf
 *   #define KEY_ESCAPE      27
 *   #define KEY_ENTER       13
 *   #define KEY_TAB         9
 *   #define KEY_F1          (0x80+0x3b)   ... KEY_F10 (0x80+0x44)
 *   #define KEY_F11         (0x80+0x57)
 *   #define KEY_F12         (0x80+0x58)
 *   #define KEY_BACKSPACE   127
 *   #define KEY_PAUSE       0xff
 *   #define KEY_EQUALS      0x3d
 *   #define KEY_MINUS       0x2d
 * Printable keys are plain ASCII — lowercase for the menu alphaKey/AM
 * letters (m_menu.c `alphaKey == ch`, am_map.c AM_FOLLOWKEY 'f' etc.),
 * ASCII digits for '0'..'9'.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_EVENT_CODES } from './keyboard';

// --- doomdef.h transcription (raw hex/dec as in the header) ----------------
const KEY_RIGHTARROW = 0xae;
const KEY_LEFTARROW = 0xac;
const KEY_UPARROW = 0xad;
const KEY_DOWNARROW = 0xaf;
const KEY_ESCAPE = 27;
const KEY_ENTER = 13;
const KEY_TAB = 9;
const KEY_BACKSPACE = 127;
const KEY_F1 = 0x80 + 0x3b;
const KEY_F2 = 0x80 + 0x3c;
const KEY_F3 = 0x80 + 0x3d;
const KEY_F4 = 0x80 + 0x3e;
const KEY_F5 = 0x80 + 0x3f;
const KEY_F6 = 0x80 + 0x40;
const KEY_F7 = 0x80 + 0x41;
const KEY_F8 = 0x80 + 0x42;
const KEY_F9 = 0x80 + 0x43;
const KEY_F10 = 0x80 + 0x44;
const KEY_F11 = 0x80 + 0x57;
const KEY_F12 = 0x80 + 0x58;
const KEY_EQUALS = 0x3d;
const KEY_MINUS = 0x2d;

describe('doomdef.h KEY_* transcription vs DEFAULT_EVENT_CODES (M9-02)', () => {
  it('special keys carry the doomdef.h data1 values', () => {
    expect(DEFAULT_EVENT_CODES['Escape']).toBe(KEY_ESCAPE);
    expect(DEFAULT_EVENT_CODES['Enter']).toBe(KEY_ENTER);
    expect(DEFAULT_EVENT_CODES['NumpadEnter']).toBe(KEY_ENTER);
    expect(DEFAULT_EVENT_CODES['Tab']).toBe(KEY_TAB);
    expect(DEFAULT_EVENT_CODES['Backspace']).toBe(KEY_BACKSPACE);
    expect(DEFAULT_EVENT_CODES['ArrowUp']).toBe(KEY_UPARROW);
    expect(DEFAULT_EVENT_CODES['ArrowDown']).toBe(KEY_DOWNARROW);
    expect(DEFAULT_EVENT_CODES['ArrowLeft']).toBe(KEY_LEFTARROW);
    expect(DEFAULT_EVENT_CODES['ArrowRight']).toBe(KEY_RIGHTARROW);
    expect(DEFAULT_EVENT_CODES['Minus']).toBe(KEY_MINUS);
    expect(DEFAULT_EVENT_CODES['Equal']).toBe(KEY_EQUALS);
  });

  it('F1-F12 carry the (0x80+scancode) data1 values', () => {
    expect([
      DEFAULT_EVENT_CODES['F1'],
      DEFAULT_EVENT_CODES['F2'],
      DEFAULT_EVENT_CODES['F3'],
      DEFAULT_EVENT_CODES['F4'],
      DEFAULT_EVENT_CODES['F5'],
      DEFAULT_EVENT_CODES['F6'],
      DEFAULT_EVENT_CODES['F7'],
      DEFAULT_EVENT_CODES['F8'],
      DEFAULT_EVENT_CODES['F9'],
      DEFAULT_EVENT_CODES['F10'],
      DEFAULT_EVENT_CODES['F11'],
      DEFAULT_EVENT_CODES['F12']
    ]).toEqual([
      KEY_F1,
      KEY_F2,
      KEY_F3,
      KEY_F4,
      KEY_F5,
      KEY_F6,
      KEY_F7,
      KEY_F8,
      KEY_F9,
      KEY_F10,
      KEY_F11,
      KEY_F12
    ]);
  });

  it('a-z / 0-9 are lowercase-plain-ASCII data1 (alphaKey + AM letters)', () => {
    // The full set M_Responder's alphaKey scan + am_map.c consume:
    for (const [code, ch] of [
      ['KeyN', 'n'],
      ['KeyO', 'o'],
      ['KeyL', 'l'],
      ['KeyS', 's'],
      ['KeyR', 'r'],
      ['KeyQ', 'q'],
      ['KeyF', 'f'],
      ['KeyG', 'g'],
      ['KeyM', 'm'],
      ['KeyC', 'c'],
      ['KeyA', 'a'],
      ['KeyZ', 'z']
    ] as const) {
      expect(DEFAULT_EVENT_CODES[code], code).toBe(ch.charCodeAt(0));
    }
    for (let d = 0; d <= 9; d++) {
      expect(DEFAULT_EVENT_CODES[`Digit${d}`], `Digit${d}`).toBe(
        String(d).charCodeAt(0)
      );
    }
  });
});
