export interface InputSnapshot {
  forward: number;
  strafe: number;
  yawDelta: number;
  pitchDelta: number;
  fire: boolean;
  interact: boolean;
  weaponSlot: number | null;
}

export interface InputOptions {
  headless?: boolean;
  // Headless mode: skip pointer lock, treat arrow keys as yaw, start unpaused on first input.
}

export class Input {
  private pressed = new Set<string>();
  private mouseDx = 0;
  private mouseDy = 0;
  private fireLatched = false;
  private interactLatched = false;
  private slotLatched: number | null = null;
  paused = true;
  /** When false, clicking the canvas will not request pointer lock. Used to
   * keep the cursor visible on menu/overlay screens. */
  wantsPointerLock = false;
  private headless = false;
  private yawPerArrowKeyPx = 25;

  install(canvas: HTMLCanvasElement, opts: InputOptions = {}) {
    this.headless = !!opts.headless;
    if (this.headless) this.paused = false;
    addEventListener('keydown', (e) => this._press(e.code));
    addEventListener('keyup', (e) => this._release(e.code));
    if (!this.headless) {
      canvas.addEventListener('click', () => {
        if (this.wantsPointerLock) canvas.requestPointerLock();
      });
      document.addEventListener('pointerlockchange', () => {
        this.paused = document.pointerLockElement !== canvas;
      });
      addEventListener('mousemove', (e) => {
        if (!this.paused) this._mouseMove(e.movementX, e.movementY);
      });
      addEventListener('mousedown', (e) => {
        if (!this.paused && e.button === 0) this.fireLatched = true;
      });
    } else {
      // Headless: F key fires (since LMB without pointer lock is awkward to script).
      // Also accept synthetic mousedown for completeness.
      addEventListener('mousedown', (e) => { if (e.button === 0) this.fireLatched = true; });
    }
  }

  _press(code: string) {
    this.pressed.add(code);
    if (code === 'KeyE') this.interactLatched = true;
    if (code === 'Digit1') this.slotLatched = 0;
    if (code === 'Digit2') this.slotLatched = 1;
    if (this.headless && code === 'KeyF') this.fireLatched = true;
  }

  _release(code: string) {
    this.pressed.delete(code);
  }

  _mouseMove(dx: number, dy = 0) {
    this.mouseDx += dx;
    this.mouseDy += dy;
  }

  isDown(code: string): boolean {
    return this.pressed.has(code);
  }

  snapshot(): InputSnapshot {
    const fwd = (this.pressed.has('KeyW') ? 1 : 0) - (this.pressed.has('KeyS') ? 1 : 0);
    const str = (this.pressed.has('KeyD') ? 1 : 0) - (this.pressed.has('KeyA') ? 1 : 0);
    let yaw = this.mouseDx;
    let pitch = this.mouseDy;
    if (this.headless) {
      if (this.pressed.has('ArrowLeft')) yaw -= this.yawPerArrowKeyPx;
      if (this.pressed.has('ArrowRight')) yaw += this.yawPerArrowKeyPx;
    }
    const s: InputSnapshot = {
      forward: fwd,
      strafe: str,
      yawDelta: yaw,
      pitchDelta: pitch,
      fire: this.fireLatched || this.pressed.has('Space'),
      interact: this.interactLatched,
      weaponSlot: this.slotLatched,
    };
    this.mouseDx = 0;
    this.mouseDy = 0;
    this.fireLatched = false;
    this.interactLatched = false;
    this.slotLatched = null;
    return s;
  }
}
