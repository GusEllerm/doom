import type { Level } from './level';

export type DoorState = 'closed' | 'opening' | 'open';

interface Door { state: DoorState; t: number; }

export const DOOR_OPEN_TIME = 0.6;

export class Doors {
  private map = new Map<string, Door>();

  constructor(lvl: Level) {
    for (let y = 0; y < lvl.height; y++) for (let x = 0; x < lvl.width; x++) {
      if (lvl.tileAt(x, y) === 9) {
        this.map.set(this.key(x, y), { state: 'closed', t: 0 });
      }
    }
  }

  private key(x: number, y: number) { return `${x | 0},${y | 0}`; }

  get(x: number, y: number): Door | undefined {
    return this.map.get(this.key(x, y));
  }

  isBlocking(x: number, y: number): boolean {
    const d = this.map.get(this.key(x, y));
    return !!d && d.state !== 'open';
  }

  /** 0 = closed, 1 = fully open. Used to slide the door upward visually. */
  openRatio(x: number, y: number): number {
    const d = this.map.get(this.key(x, y));
    if (!d) return 1;
    if (d.state === 'closed') return 0;
    if (d.state === 'open') return 1;
    return Math.min(1, d.t / DOOR_OPEN_TIME);
  }

  tryOpen(x: number, y: number): boolean {
    const d = this.map.get(this.key(x, y));
    if (d && d.state === 'closed') { d.state = 'opening'; d.t = 0; return true; }
    return false;
  }

  /** Open the first closed door adjacent (4-neighbour) to (px, py). */
  tryOpenNear(px: number, py: number): boolean {
    const cx = Math.floor(px), cy = Math.floor(py);
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (this.tryOpen(cx + dx, cy + dy)) return true;
    }
    return false;
  }

  /** True if any door at all is within ~1 cell of (px, py). Used by telemetry
   * to distinguish "no door near" from "door near but didn't open". */
  hasDoorNear(px: number, py: number): boolean {
    const cx = Math.floor(px), cy = Math.floor(py);
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      if (this.map.has(this.key(cx + dx, cy + dy))) return true;
    }
    return false;
  }

  update(dt: number) {
    for (const d of this.map.values()) {
      if (d.state === 'opening') {
        d.t += dt;
        if (d.t >= DOOR_OPEN_TIME) d.state = 'open';
      }
    }
  }
}
