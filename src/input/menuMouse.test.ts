/**
 * input/menuMouse.ts unit tests (M9-02 acceptance 3).
 * Geometry mirrors M_Drawer: MainMenu-style column, items at (x, y+i*16),
 * LINEHEIGHT 16 (m_menu.c:133). Synth output must be vanilla ev_keydown/
 * ev_keyup pairs with doomdef.h data1 (KEY_UPARROW 0xad / KEY_DOWNARROW
 * 0xaf / KEY_ENTER 13) — the OS-layer trick from the §0.7 mouse finding.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import { KEY_DOWNARROW, KEY_ENTER, KEY_UPARROW } from './keyboard';
import { createMenuMouse, MENU_LINE_HEIGHT, type MenuItemBox } from './menuMouse';
import type { KeyboardEventPacket } from './keyboard';

/** 6 items at x=8, first y=63 (EpiDef/NewDef column position, m_menu.c). */
const boxes6: readonly MenuItemBox[] = Array.from({ length: 6 }, (_, i) => ({
  x: 8,
  y: 63 + i * MENU_LINE_HEIGHT,
  w: 160
}));

function makeMouse() {
  const got: KeyboardEventPacket[] = [];
  const mm = createMenuMouse({ onEvent: (ev) => got.push(ev) });
  mm.setItems(boxes6);
  return { mm, got };
}

/** Center of the row under test (x-span inside box, y mid-row). */
const atRow = (i: number): { x: number; y: number } => ({ x: 80, y: 63 + i * 16 + 8 });

const down = (key: number): KeyboardEventPacket => ({ type: 'keydown', data1: key });
const up = (key: number): KeyboardEventPacket => ({ type: 'keyup', data1: key });

describe('menuMouse: armed hover/wheel/click → synthesized vanilla keys', () => {
  it('arm with 6 boxes, hover row 3 ⇒ 3 KEY_DOWNARROW pairs; click ⇒ Enter pair', () => {
    const { mm, got } = makeMouse();
    expect(mm.armed()).toBe(true);
    const p = atRow(3);
    mm.hover(p.x, p.y);
    expect(got).toEqual([
      down(KEY_DOWNARROW),
      up(KEY_DOWNARROW),
      down(KEY_DOWNARROW),
      up(KEY_DOWNARROW),
      down(KEY_DOWNARROW),
      up(KEY_DOWNARROW)
    ]);
    expect(mm.index()).toBe(3);
    // click on the same row ⇒ no extra arrows, just the Enter pair.
    got.length = 0;
    mm.click(p.x, p.y);
    expect(got).toEqual([down(KEY_ENTER), up(KEY_ENTER)]);
  });

  it('hover back up synthesizes KEY_UPARROW pairs; data1 = doomdef codes', () => {
    const { mm, got } = makeMouse();
    mm.hover(atRow(4).x, atRow(4).y); // 0→4: four downs
    expect(got.filter((e) => e.type === 'keydown').every((e) => e.data1 === KEY_DOWNARROW)).toBe(true);
    got.length = 0;
    mm.hover(atRow(1).x, atRow(1).y); // 4→1: three ups
    expect(got).toEqual([
      down(KEY_UPARROW),
      up(KEY_UPARROW),
      down(KEY_UPARROW),
      up(KEY_UPARROW),
      down(KEY_UPARROW),
      up(KEY_UPARROW)
    ]);
    expect(mm.index()).toBe(1);
  });

  it('wheel is exactly ±1 row per notch', () => {
    const { mm, got } = makeMouse();
    mm.wheel(0, 0, 120); // wheel down ⇒ one DOWNARROW pair
    expect(got).toEqual([down(KEY_DOWNARROW), up(KEY_DOWNARROW)]);
    expect(mm.index()).toBe(1);
    got.length = 0;
    mm.wheel(0, 0, -120); // wheel up ⇒ one UPARROW pair
    expect(got).toEqual([down(KEY_UPARROW), up(KEY_UPARROW)]);
    expect(mm.index()).toBe(0);
  });

  it('click aligns then fires: hover elsewhere + click row 2 from 0', () => {
    const { mm, got } = makeMouse();
    mm.click(atRow(2).x, atRow(2).y);
    expect(got).toEqual([
      down(KEY_DOWNARROW),
      up(KEY_DOWNARROW),
      down(KEY_DOWNARROW),
      up(KEY_DOWNARROW),
      down(KEY_ENTER),
      up(KEY_ENTER)
    ]);
  });

  it('click outside any box fires nothing; non-left buttons ignored', () => {
    const { mm, got } = makeMouse();
    mm.click(80, 5, 0); // above row 0
    mm.click(atRow(0).x, atRow(0).y, 2); // right click
    expect(got).toEqual([]);
  });

  it('disarmed (empty boxes) ⇒ total silence for hover/wheel/click', () => {
    const { mm, got } = makeMouse();
    mm.setItems([]);
    expect(mm.armed()).toBe(false);
    mm.hover(atRow(3).x, atRow(3).y);
    mm.wheel(0, 0, 120);
    mm.click(atRow(1).x, atRow(1).y);
    expect(got).toEqual([]);
  });

  it('keyup always paired with its keydown (never-eaten, g_game.c:571)', () => {
    const { mm, got } = makeMouse();
    mm.hover(atRow(5).x, atRow(5).y);
    mm.click(atRow(5).x, atRow(5).y);
    mm.wheel(0, 0, -120);
    for (let i = 0; i < got.length; i += 2) {
      expect(got[i]?.type).toBe('keydown');
      expect(got[i + 1]?.type).toBe('keyup');
      expect(got[i + 1]?.data1).toBe(got[i]?.data1);
    }
  });

  it('currentIndex getter keeps external (keyboard) moves in sync', () => {
    let menuItemOn = 0;
    const got: KeyboardEventPacket[] = [];
    const mm = createMenuMouse({
      onEvent: (ev) => got.push(ev),
      currentIndex: () => menuItemOn
    });
    mm.setItems(boxes6);
    menuItemOn = 4; // skull moved by keyboard, not by us
    mm.hover(atRow(2).x, atRow(2).y); // 4→2: two ups, not four
    expect(got).toEqual([down(KEY_UPARROW), up(KEY_UPARROW), down(KEY_UPARROW), up(KEY_UPARROW)]);
  });
});
