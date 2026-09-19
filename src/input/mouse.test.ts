/**
 * input/mouse tests (M5-07) — the pointer-lock translation seam and the
 * vanilla mouse math, pinned from linuxdoom-1.10 g_game.c:
 *  - scaling SITE: G_Responder ev_mouse (g_game.c:579-580)
 *    `mousex = ev->data2*(mouseSensitivity+5)/10` — game-side (platform
 *    side of our A-07 split), C int division truncates TOWARD ZERO;
 *  - one ev_mouse per tic carrying the raw deltas accumulated since the
 *    last I_ReadMouse dispatch ⇒ scale ONCE per tic in sample();
 *  - consumed once: g_game.c:411 `mousex = mousey = 0` after applying
 *    `forward += mousey` (405) and the strafe/turn split (407-409);
 *  - NO PITCH: mouse-y is forward/back (g_game.c:405); 1.10 has no
 *    m_pitch/mouselook anywhere.
 * Pointer-lock plumbing is exercised with FAKE pointer-lock event objects
 * (headless-chromium real pointer lock is unreliable — M5-plan §6; the
 * translation seam carries the load, real lock is the honest L4 subset).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { describe, expect, it } from 'vitest';

import {
  createMouseInput,
  DEFAULT_MOUSE_SENSITIVITY,
  scaleMouseDelta,
  type LockCanvasLike,
  type MouseTargetLike
} from './mouse';
import { emptyInput, gBuildTiccmd, MAXPLMOVE, type GameInput } from '../sim/ticcmd';

/* ------------------------------------------------------------------ */
/* Fake pointer-lock DOM (no real pointer lock anywhere)                */
/* ------------------------------------------------------------------ */

interface FakeDom {
  /** one object satisfies BOTH listener roles (document + canvas share it) */
  node: MouseTargetLike & LockCanvasLike;
  lockRequests: number;
  /** flip lock state + fire pointerlockchange, like the browser does */
  emitLockChange(locked: boolean): void;
  emitMove(movementX: number, movementY: number): void;
  emitClick(): void;
}

function fakeDom(): FakeDom {
  const listeners: Record<string, ((e: unknown) => void)[]> = {
    mousemove: [],
    pointerlockchange: [],
    click: []
  };
  const doc = { pointerLockElement: null as unknown };
  const self: FakeDom = {
    node: {
      get pointerLockElement(): unknown {
        return doc.pointerLockElement;
      },
      addEventListener(type: string, l: (e: unknown) => void) {
        (listeners[type] ??= []).push(l);
      },
      removeEventListener(type: string, l: (e: unknown) => void) {
        const arr = listeners[type];
        if (arr !== undefined) {
          const i = arr.indexOf(l);
          if (i >= 0) arr.splice(i, 1);
        }
      },
      requestPointerLock() {
        self.lockRequests++;
      }
    } as unknown as MouseTargetLike & LockCanvasLike,
    lockRequests: 0,
    emitLockChange(locked: boolean) {
      doc.pointerLockElement = locked ? {} : null;
      fire('pointerlockchange');
    },
    emitMove(movementX: number, movementY: number) {
      fire('mousemove', { movementX, movementY });
    },
    emitClick() {
      fire('click');
    }
  };
  function fire(type: string, e: unknown = {}): void {
    for (const l of [...(listeners[type] ?? [])]) l(e);
  }
  return self;
}

/* ------------------------------------------------------------------ */
/* 1. Sensitivity math — g_game.c:579-580 golden                        */
/* ------------------------------------------------------------------ */

describe('scaleMouseDelta (g_game.c:579-580 (d*(mouseSensitivity+5)/10))', () => {
  it('default sensitivity 5 ⇒ identity ×1 (the pinned 1.10 default)', () => {
    expect(DEFAULT_MOUSE_SENSITIVITY).toBe(5);
    expect(scaleMouseDelta(25, 5)).toBe(25);
    expect(scaleMouseDelta(-25, 5)).toBe(-25);
    expect(scaleMouseDelta(0, 5)).toBe(0);
  });

  it('C integer division truncates TOWARD ZERO (not floor)', () => {
    // sens 0 ⇒ (d*5)/10: 3*5/10 = 1.5 → 1;  -3*5/10 = -1.5 → -1 (floor would
    // give -2 — that would NOT match C).
    expect(scaleMouseDelta(3, 0)).toBe(1);
    expect(scaleMouseDelta(-3, 0)).toBe(-1);
    // sens 15 ⇒ (d*20)/10 = 2d exact.
    expect(scaleMouseDelta(-7, 15)).toBe(-14);
    // sens 1 ⇒ (d*6)/10: 7*6=42/10=4.2→4; negative mirror.
    expect(scaleMouseDelta(7, 1)).toBe(4);
    expect(scaleMouseDelta(-7, 1)).toBe(-4);
  });
});

describe('per-tic sensitivity golden (d*(5+5)/10)*0x8 → angleturn', () => {
  it('positive raw delta at default sens: 25 ⇒ angleturn -25*0x8 = -200', () => {
    const m = createMouseInput();
    m.setLocked(true);
    m.motion(25, 0);
    const { mouseX, mouseY } = m.sample();
    const cmd = gBuildTiccmd({ ...emptyInput(), mouseX, mouseY }, { turnheld: 0 });
    expect(cmd.angleturn).toBe(-200); // g_game.c:409, right = angle down
    expect(cmd.forwardmove).toBe(0); // NO PITCH: mouseX never touches z
  });

  it('negative deltas keep sign through truncation: -7 ⇒ angleturn +56', () => {
    const m = createMouseInput({ sensitivity: 1 });
    m.setLocked(true);
    m.motion(-7, 0); // -7*(1+5)/10 = -4.2 → -4 (toward zero)
    const { mouseX } = m.sample();
    expect(mouseX).toBe(-4);
    const cmd = gBuildTiccmd({ ...emptyInput(), mouseX, mouseY: 0 }, { turnheld: 0 });
    expect(cmd.angleturn).toBe(32); // -(-4*0x8)
  });
});

/* ------------------------------------------------------------------ */
/* 2. Accumulate raw, scale ONCE per tic (one ev_mouse per tic)          */
/* ------------------------------------------------------------------ */

describe('sample() scales accumulated raw deltas once per tic', () => {
  it('two raw events sum BEFORE scaling (i-layer accumulation + G_Responder scale)', () => {
    const m = createMouseInput({ sensitivity: 0 });
    m.setLocked(true);
    m.motion(3, 0);
    m.motion(3, 0);
    // per-tic: trunc(6*5/10) = 3. Per-EVENT scaling would give 1+1 = 2 —
    // this golden pins the accumulation site (raw sum, one truncation).
    expect(m.sample()).toEqual({ mouseX: 3, mouseY: 0 });
  });

  it('deltas are CONSUMED ONCE (g_game.c:411): second sample is zero', () => {
    const m = createMouseInput();
    m.setLocked(true);
    m.motion(10, -4);
    expect(m.sample()).toEqual({ mouseX: 10, mouseY: -4 });
    expect(m.sample()).toEqual({ mouseX: 0, mouseY: 0 });
    // and the player does not keep moving on the next tic:
    const cmd = gBuildTiccmd({ ...emptyInput(), mouseX: 0, mouseY: 0 }, { turnheld: 0 });
    expect(cmd).toEqual({ forwardmove: 0, sidemove: 0, angleturn: 0, buttons: 0 });
  });

  it('uncaptured motion is dropped (vanilla: mouse events only while captured)', () => {
    const m = createMouseInput();
    m.motion(100, 100);
    expect(m.pending()).toEqual({ x: 0, y: 0 });
    expect(m.sample()).toEqual({ mouseX: 0, mouseY: 0 });
  });

  it('clear() drains and unlocks (g_game.c:493 level-start reset)', () => {
    const m = createMouseInput();
    m.setLocked(true);
    m.motion(5, 5);
    m.clear();
    expect(m.locked()).toBe(false);
    expect(m.pending()).toEqual({ x: 0, y: 0 });
  });
});

/* ------------------------------------------------------------------ */
/* 3. Fake pointer-lock translation seam (no real pointer lock)          */
/* ------------------------------------------------------------------ */

describe('pointer-lock translation seam (FAKE events, M5-plan §6)', () => {
  it('canvas click → requestPointerLock()', () => {
    const dom = fakeDom();
    const m = createMouseInput();
    m.attach(dom.node, dom.node);
    dom.emitClick();
    expect(dom.lockRequests).toBe(1);
  });

  it('pointerlockchange mirrors locked state; mousemove feeds only while locked', () => {
    const dom = fakeDom();
    const m = createMouseInput();
    m.attach(dom.node, dom.node);
    dom.emitMove(9, 9); // not locked yet
    expect(m.pending()).toEqual({ x: 0, y: 0 });
    dom.emitLockChange(true);
    expect(m.locked()).toBe(true);
    dom.emitMove(9, -3);
    expect(m.pending()).toEqual({ x: 9, y: -3 });
    dom.emitLockChange(false); // Esc released the lock (browser-native, UI-only)
    expect(m.locked()).toBe(false);
    dom.emitMove(500, 500);
    expect(m.pending()).toEqual({ x: 9, y: -3 }); // still dropped
    expect(m.sample()).toEqual({ mouseX: 9, mouseY: -3 });
  });

  it('detach stops all listeners', () => {
    const dom = fakeDom();
    const m = createMouseInput();
    const detach = m.attach(dom.node, dom.node);
    detach();
    dom.emitLockChange(true);
    dom.emitMove(7, 7);
    dom.emitClick();
    expect(m.locked()).toBe(false);
    expect(m.pending()).toEqual({ x: 0, y: 0 });
    expect(dom.lockRequests).toBe(0);
  });

  it('full chain: locked mousemove → per-tic sample → ticcmd (turn + forward)', () => {
    const dom = fakeDom();
    const m = createMouseInput();
    m.attach(dom.node, dom.node);
    dom.emitLockChange(true);
    dom.emitMove(12, 8);
    dom.emitMove(-2, 1);
    const { mouseX, mouseY } = m.sample();
    expect(mouseX).toBe(10); // raw 12 + (-2), default sens ×1, ONE truncation
    expect(m.sample()).toEqual({ mouseX: 0, mouseY: 0 }); // consumed once
    const cmd = gBuildTiccmd({ ...emptyInput(), mouseX, mouseY }, { turnheld: 0 });
    expect(cmd.angleturn).toBe(-80); // -10*0x8
    expect(cmd.forwardmove).toBe(9); // 8+1, mouse-y = forward, NO pitch
    // strafe modifier routes mouseX to sidemove*2 instead (g_game.c:407)
    const cmdS = gBuildTiccmd(
      { ...emptyInput(), strafe: true, mouseX: 10, mouseY: 0 },
      { turnheld: 0 }
    );
    expect(cmdS.sidemove).toBe(20);
    expect(cmdS.angleturn).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 4. add-then-clamp order pinned vs keys (g_game.c:403-379)             */
/* ------------------------------------------------------------------ */

describe('gBuildTiccmd mouse/key interplay (add-then-clamp)', () => {
  const cmd = (over: Partial<GameInput>) =>
    gBuildTiccmd({ ...emptyInput(), ...over }, { turnheld: 0 });

  it('mouse-y joins forward BEFORE the clamp: key(25)+mouse(10)=35', () => {
    expect(cmd({ forward: true, mouseY: 10 }).forwardmove).toBe(35);
  });

  it('key(25)+mouse(25) hits exactly MAXPLMOVE; mouse(100) clamps to it', () => {
    expect(MAXPLMOVE).toBe(50);
    expect(cmd({ forward: true, mouseY: 25 }).forwardmove).toBe(50);
    expect(cmd({ forward: true, mouseY: 100 }).forwardmove).toBe(MAXPLMOVE);
    expect(cmd({ mouseY: -100 }).forwardmove).toBe(-MAXPLMOVE);
    // backward key + big mouse-y: net 75 → clamp +50 (order: add, then clamp)
    expect(cmd({ backward: true, mouseY: 100 }).forwardmove).toBe(50);
  });

  it('mouse-x with keys never exceeds int16 angleturn wrap (C short store)', () => {
    // turnRight key + mouse: fresh turnheld ⇒ SLOWTURNTICS ramp uses
    // ANGLETURN[2]=320, then angleturn -= mousex*0x8 on top (g_game.c:409)
    const c = cmd({ turnRight: true, mouseX: 100 });
    expect(c.angleturn).toBe(-320 - 800);
    // pathological delta wraps like C's `short` store: 4160*8 = 33280 →
    // angleturn -33280 → int16 wrap ≡ 32256 (matches C truncation to short)
    const c2 = cmd({ mouseX: 4160 });
    expect(c2.angleturn).toBe(32256);
  });
});
