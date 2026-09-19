// input/mouse.ts — pointer-lock mouse movement → vanilla ev_mouse channel
// (M5-07). Platform-side translation seam: DOM movementX/Y deltas become the
// GameInput.mouseX/mouseY integers G_BuildTiccmd consumes once per tic.
//
// Source truth (linuxdoom-1.10, pinned):
//  * SCALING SITE: g_game.c G_Responder, ev_mouse case (g_game.c:579-580):
//      mousex = ev->data2*(mouseSensitivity+5)/10;
//      mousey = ev->data3*(mouseSensitivity+5)/10;
//    i.e. scaling happens in the GAME EVENT responder on the raw
//    (unscaled-by-sensitivity) event deltas — NOT in any i_* layer loop and
//    NOT in G_BuildTiccmd. 1.10 predates m_config/m_defaults entirely;
//    there is no `mouse_sensitivity` config variable and no m_menu binding
//    in this source tree (the "mouse_sensitivity default 5" figure is the
//    1.10 mouseSensitivity default ⇒ multiplier (5+5)/10 = 1, identity).
//    Per this repo's A-07 platform/sim split the responder sits on the
//    platform side of the divide, so the identical integer expression lives
//    HERE (the translation seam); the sim's GameInput carries already-
//    scaled ints, mirroring how G_BuildTiccmd sees already-scaled mousex.
//  * ONE ev_mouse per tic carrying the raw deltas accumulated since the
//    last tic: the i layer (I_ReadMouse) zeroes its hardware accumulators
//    when it dispatches, and D_ProcessEvents runs inside the tic loop —
//    so we accumulate RAW movementX/Y across events and scale ONCE per tic
//    in sample(), which reproduces "G_Responder scaled one accumulated
//    event" exactly (per-event scaling would truncate N times instead).
//  * CONSUMED ONCE: g_game.c:411 `mousex = mousey = 0;` after G_BuildTiccmd
//    applies them — mirrored by sample()'s drain.
//  * NO PITCH: 1.10 has no m_pitch/mouselook; mouse-Y adds forward/back
//    (g_game.c:405 `forward += mousey`). This module never produces pitch.
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** g_game.c mouseSensitivity default (1.10) — (5+5)/10 = ×1 identity. */
export const DEFAULT_MOUSE_SENSITIVITY = 5;

/**
 * g_game.c:579-580 `d*(mouseSensitivity+5)/10` — C integer division
 * truncates toward zero, mirrored by Math.trunc. `d` is a raw signed
 * device delta; results stay int (trunc) so GameInput mouse channels are
 * plain ints like vanilla's `int mousex`.
 */
export function scaleMouseDelta(d: number, sensitivity: number): number {
  return Math.trunc((d * (sensitivity + 5)) / 10);
}

/** Minimal mousemove shape consumed (structural for MouseEvent). */
export interface MouseMoveEventLike {
  /** Pointer-lock-relative deltas; outside lock browsers report cursor
   * deltas, which vanilla never fed to ev_mouse (mouse only moves the
   * player while captured) — ignored unless locked. */
  movementX: number;
  movementY: number;
}

/** Document-like surface: mousemove + pointerlockchange stream. */
export interface MouseTargetLike {
  addEventListener(
    type: 'mousemove',
    listener: (e: MouseMoveEventLike) => void
  ): void;
  addEventListener(type: 'pointerlockchange', listener: (e: unknown) => void): void;
  removeEventListener(
    type: 'mousemove',
    listener: (e: MouseMoveEventLike) => void
  ): void;
  removeEventListener(
    type: 'pointerlockchange',
    listener: (e: unknown) => void
  ): void;
  /** document.pointerLockElement — non-null while captured (UI-only
   * state; never enters the sim). */
  pointerLockElement?: unknown;
}

/** Canvas-like surface clicked to (re)acquire the pointer lock. */
export interface LockCanvasLike {
  addEventListener(type: 'click', listener: (e: unknown) => void): void;
  removeEventListener(type: 'click', listener: (e: unknown) => void): void;
  requestPointerLock(): void;
}

export interface MouseInput {
  /** Inject a raw (UNSCALED) device delta — the ev_mouse data2/data3
   * seam. Scaled once per tic at sample(). Test/debug/e2e injection
   * point; attach() wires the real mousemove here. */
  motion(dx: number, dy: number): void;
  /** Set captured state (pointerlockchange mirror). Deltas outside the
   * lock are dropped, matching vanilla mouse-only-when-captured. */
  setLocked(locked: boolean): void;
  locked(): boolean;
  /** Raw deltas accumulated but not yet sampled (introspection). */
  pending(): { x: number; y: number };
  /**
   * Per-tic poll → the GameInput mouse channels. Scales the accumulated
   * raw deltas once (one ev_mouse per tic ⇒ one truncation per axis),
   * then DRAINS them — g_game.c:411 `mousex = mousey = 0`, the
   * consumed-once rule. Calling sample() twice in a tic yields zeros.
   */
  sample(): { mouseX: number; mouseY: number };
  /** Reset accumulators + lock state (vanilla g_game.c:493 `mousex =
   * mousey = 0` on level start). */
  clear(): void;
  /** Attach to DOM-likes; returns the detach function. canvas 'click' →
   * requestPointerLock(); document 'pointerlockchange' → locked mirror;
   * document 'mousemove'.movementX/Y → motion(). Escape releasing the
   * lock is browser-native (UI-only, no sim state touched). */
  attach(target: MouseTargetLike, canvas: LockCanvasLike): () => void;
}

export interface MouseInputOptions {
  /** mouseSensitivity for the (sens+5)/10 scale; default 5 (identity). */
  sensitivity?: number;
}

export function createMouseInput(options: MouseInputOptions = {}): MouseInput {
  const sensitivity = options.sensitivity ?? DEFAULT_MOUSE_SENSITIVITY;
  let rawX = 0;
  let rawY = 0;
  let locked = false;

  const self: MouseInput = {
    motion(dx, dy) {
      if (!locked) return;
      rawX += Math.trunc(dx);
      rawY += Math.trunc(dy);
    },
    setLocked(v) {
      locked = v;
    },
    locked() {
      return locked;
    },
    pending() {
      return { x: rawX, y: rawY };
    },
    sample() {
      const mouseX = scaleMouseDelta(rawX, sensitivity);
      const mouseY = scaleMouseDelta(rawY, sensitivity);
      rawX = 0;
      rawY = 0;
      return { mouseX, mouseY };
    },
    clear() {
      rawX = 0;
      rawY = 0;
      locked = false;
    },
    attach(target, canvas) {
      const onMove = (e: MouseMoveEventLike): void => {
        self.motion(e.movementX, e.movementY);
      };
      const onLockChange = (): void => {
        self.setLocked(target.pointerLockElement !== undefined && target.pointerLockElement !== null);
      };
      const onClick = (): void => {
        canvas.requestPointerLock();
      };
      target.addEventListener('mousemove', onMove);
      target.addEventListener('pointerlockchange', onLockChange);
      canvas.addEventListener('click', onClick);
      return () => {
        target.removeEventListener('mousemove', onMove);
        target.removeEventListener('pointerlockchange', onLockChange);
        canvas.removeEventListener('click', onClick);
      };
    }
  };
  return self;
}
