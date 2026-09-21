// input/menuMouse.ts — menu-mode mouse → arrow/Enter key synthesis (M9-02,
// plan §0.7 mouse finding, decision D-0yy).
//
// Source truth (linuxdoom-1.10 m_menu.c): M_Responder contains ZERO
// ev_mouse handling — vanilla "menu mouse" is the OS layer faking key
// events: hovering an item sent the right number of KEY_UPARROW/
// KEY_DOWNARROW keydown/keyup pairs to move the skull, and a click sent
// KEY_ENTER. We mirror exactly that trick in the browser input layer, so
// sim/menu code stays a zero-deviation port: the synthesizer emits
// vanilla-shaped ev_keydown/ev_keyup pairs and nothing else.
//
// Geometry: M_Drawer draws item i at (menu.x, menu.y + i*16) with
// LINEHEIGHT = 16 (m_menu.c:133). The caller hands us the per-item boxes
// (or menu x/y + count; box height defaults to 16), and we do the row math.
//
// keyup-never-eaten (g_game.c:571): every synthesized keydown is paired
// with its keyup, always.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  KEY_DOWNARROW,
  KEY_ENTER,
  KEY_UPARROW,
  type KeyboardEventPacket
} from './keyboard';

/** One menu item's screen box in the 320x200 space (M_Drawer item pitch 16;
 * `w`/`h` optional — hit-testing then spans the row, `h` defaults to 16). */
export interface MenuItemBox {
  readonly x: number;
  readonly y: number;
  readonly w?: number;
  readonly h?: number;
}

export interface MenuMouseOptions {
  /** Queue the synthesized vanilla event_t pair (D_ProcessEvents side). */
  onEvent: (ev: KeyboardEventPacket) => void;
  /** LINEHEIGHT (m_menu.c:133); 16 by default. */
  itemHeight?: number;
  /** Read the menu's current itemOn so external moves (keys!) stay in sync. */
  currentIndex?: () => number;
}

export interface MenuMouse {
  /** Arm with the current menu's item boxes (empty array ⇒ disarm). */
  setItems(boxes: readonly MenuItemBox[]): void;
  /** Menu layer active? (disarmed ⇒ total silence, events pass to game). */
  armed(): boolean;
  /** Mouse motion in screen coords: hover moves the skull (arrows). */
  hover(x: number, y: number): void;
  /** Mouse button click: Enter on the row under the cursor (a click on
   * empty screen space does nothing — no vanilla key is queued). */
  click(x: number, y: number, button?: number): void;
  /** Wheel: exactly ±1 row per notch (one KEY_UP/DOWNARROW pair). */
  wheel(x: number, y: number, deltaY: number): void;
  /** Sync from the menu layer (itemOn changed via keys/messages). */
  setIndex(i: number): void;
  /** Current tracked item index. */
  index(): number;
}

/** Default row hit-box height: m_menu.c LINEHEIGHT. */
export const MENU_LINE_HEIGHT = 16;

export function createMenuMouse(options: MenuMouseOptions): MenuMouse {
  const itemHeight = options.itemHeight ?? MENU_LINE_HEIGHT;
  let boxes: readonly MenuItemBox[] = [];
  let idx = options.currentIndex ? options.currentIndex() : 0;

  const press = (key: number): void => {
    // Full keydown+keyup pair: the responder chain eats the keydown and
    // always sees the keyup (g_game.c:571 never-eat-keyups).
    options.onEvent({ type: 'keydown', data1: key });
    options.onEvent({ type: 'keyup', data1: key });
  };

  /** Row under (x,y) or -1. x-span: box.w when given, else the row. */
  const hitRow = (x: number, y: number): number => {
    let i = 0;
    for (const b of boxes) {
      const h = b.h ?? itemHeight;
      const xOk = b.w === undefined || (x >= b.x && x < b.x + b.w);
      if (xOk && y >= b.y && y < b.y + h) return i;
      i++;
    }
    return -1;
  };

  /** Move the selection to `row` by pressing arrows — the OS-layer trick:
   * numitems is unknown here, so a plain cycle (m_menu.c :1624-:1643 wraps
   * itemOn at the ends) needs exactly |row - idx| presses in one direction. */
  const moveTo = (row: number): void => {
    const cur = options.currentIndex ? options.currentIndex() : idx;
    idx = cur;
    if (row < 0 || row === cur) return;
    const key = row > cur ? KEY_DOWNARROW : KEY_UPARROW;
    for (let i = Math.abs(row - cur); i > 0; i--) press(key);
    idx = row;
  };

  return {
    setItems: (next): void => {
      boxes = next;
      idx = options.currentIndex ? options.currentIndex() : 0;
    },
    armed: () => boxes.length > 0,
    hover: (x, y): void => {
      if (boxes.length === 0) return;
      moveTo(hitRow(x, y));
    },
    click: (x, y, button = 0): void => {
      if (boxes.length === 0 || button !== 0) return; // left button only
      const row = hitRow(x, y);
      if (row < 0) return; // click on empty space ⇒ nothing to fire
      moveTo(row);
      press(KEY_ENTER); // M_Responder case KEY_ENTER ⇒ fire routine
    },
    wheel: (_x, _y, deltaY): void => {
      if (boxes.length === 0) return;
      idx = options.currentIndex ? options.currentIndex() : idx;
      // One notch = one row, vanilla menu-wheel convention: up ⇒ UPARROW.
      press(deltaY < 0 ? KEY_UPARROW : KEY_DOWNARROW);
      const n = boxes.length;
      const d = deltaY < 0 ? -1 : 1;
      idx = ((idx + d) % n + n) % n; // track the wrap M_Responder performs
    },
    setIndex: (i): void => {
      idx = i;
    },
    index: () => (options.currentIndex ? options.currentIndex() : idx)
  };
}
