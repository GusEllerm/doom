import type { LevelJSON } from './types';

export class Level {
  constructor(public readonly data: LevelJSON) {}
  get width() { return this.data.width; }
  get height() { return this.data.height; }
  get name() { return this.data.name; }

  tileAt(x: number, y: number): number {
    const ix = x | 0, iy = y | 0;
    if (ix < 0 || iy < 0 || ix >= this.width || iy >= this.height) return 1;
    return this.data.tiles[iy * this.width + ix] ?? 1;
  }

  isSolid(x: number, y: number): boolean {
    const t = this.tileAt(x, y);
    // 0 = empty, 1-99 = solid walls/doors, 100+ = pass-through (exit, decals)
    return t !== 0 && t < 100;
  }
}

export function parseLevel(j: LevelJSON): Level {
  if (!Number.isInteger(j.width) || !Number.isInteger(j.height) || j.width <= 0 || j.height <= 0) {
    throw new Error('invalid level dimensions');
  }
  if (j.tiles.length !== j.width * j.height) {
    throw new Error(`tile count ${j.tiles.length} != ${j.width * j.height}`);
  }
  return new Level(j);
}
