import type { Level } from './level';

export type DoorState = 'closed' | 'opening' | 'open';

interface Door { state: DoorState; t: number; }

const OPEN_TIME = 0.6;

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

  isBlocking(x: number, y: number): boolean {
    const d = this.map.get(this.key(x, y));
    return !!d && d.state !== 'open';
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

  update(dt: number) {
    for (const d of this.map.values()) {
      if (d.state === 'opening') {
        d.t += dt;
        if (d.t >= OPEN_TIME) d.state = 'open';
      }
    }
  }
}
