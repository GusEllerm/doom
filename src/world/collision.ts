import type { Level } from './level';
import type { Doors } from './doors';

export interface Vec2 { x: number; y: number; }

export function tryMove(lvl: Level, pos: Vec2, dx: number, dy: number, radius: number, doors?: Doors): Vec2 {
  let { x, y } = pos;
  const nx = x + dx;
  if (!collides(lvl, nx, y, radius, doors)) x = nx;
  const ny = y + dy;
  if (!collides(lvl, x, ny, radius, doors)) y = ny;
  return { x, y };
}

function collides(lvl: Level, x: number, y: number, r: number, doors?: Doors): boolean {
  return isBlocked(lvl, x - r, y - r, doors)
    || isBlocked(lvl, x + r, y - r, doors)
    || isBlocked(lvl, x - r, y + r, doors)
    || isBlocked(lvl, x + r, y + r, doors);
}

function isBlocked(lvl: Level, x: number, y: number, doors?: Doors): boolean {
  const tile = lvl.tileAt(x, y);
  if (tile === 9) return doors ? doors.isBlocking(x, y) : true;
  return lvl.isSolid(x, y);
}
