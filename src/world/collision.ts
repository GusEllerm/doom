import type { Level } from './level';

export interface Vec2 { x: number; y: number; }

export function tryMove(lvl: Level, pos: Vec2, dx: number, dy: number, radius: number): Vec2 {
  let { x, y } = pos;
  const nx = x + dx;
  if (!collides(lvl, nx, y, radius)) x = nx;
  const ny = y + dy;
  if (!collides(lvl, x, ny, radius)) y = ny;
  return { x, y };
}

function collides(lvl: Level, x: number, y: number, r: number): boolean {
  return lvl.isSolid(x - r, y - r)
    || lvl.isSolid(x + r, y - r)
    || lvl.isSolid(x - r, y + r)
    || lvl.isSolid(x + r, y + r);
}
