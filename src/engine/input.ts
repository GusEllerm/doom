export interface InputSnapshot {
  forward: number;
  strafe: number;
  yawDelta: number;
  fire: boolean;
  interact: boolean;
  weaponSlot: number | null;
}

export class Input {
  private pressed = new Set<string>();
  private mouseDx = 0;
  private fireLatched = false;
  private interactLatched = false;
  private slotLatched: number | null = null;
  paused = true; // start paused until user clicks canvas to grant pointer lock

  install(canvas: HTMLCanvasElement) {
    addEventListener('keydown', (e) => this._press(e.code));
    addEventListener('keyup', (e) => this._release(e.code));
    canvas.addEventListener('click', () => canvas.requestPointerLock());
    document.addEventListener('pointerlockchange', () => {
      this.paused = document.pointerLockElement !== canvas;
    });
    addEventListener('mousemove', (e) => {
      if (!this.paused) this._mouseMove(e.movementX);
    });
    addEventListener('mousedown', (e) => {
      if (!this.paused && e.button === 0) this.fireLatched = true;
    });
  }

  _press(code: string) {
    this.pressed.add(code);
    if (code === 'KeyE') this.interactLatched = true;
    if (code === 'Digit1') this.slotLatched = 0;
    if (code === 'Digit2') this.slotLatched = 1;
  }

  _release(code: string) {
    this.pressed.delete(code);
  }

  _mouseMove(dx: number) {
    this.mouseDx += dx;
  }

  isDown(code: string): boolean {
    return this.pressed.has(code);
  }

  snapshot(): InputSnapshot {
    const fwd = (this.pressed.has('KeyW') ? 1 : 0) - (this.pressed.has('KeyS') ? 1 : 0);
    const str = (this.pressed.has('KeyD') ? 1 : 0) - (this.pressed.has('KeyA') ? 1 : 0);
    const s: InputSnapshot = {
      forward: fwd,
      strafe: str,
      yawDelta: this.mouseDx,
      fire: this.fireLatched || this.pressed.has('Space'),
      interact: this.interactLatched,
      weaponSlot: this.slotLatched,
    };
    this.mouseDx = 0;
    this.fireLatched = false;
    this.interactLatched = false;
    this.slotLatched = null;
    return s;
  }
}
