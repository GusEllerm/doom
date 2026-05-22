import type { Level } from '../world/level';
import type { Enemy } from './enemy';
import { castRay } from '../render/raycaster';

export interface Weapon {
  key: 'pistol' | 'shotgun';
  cooldown: number;
  damage: number;
  spread: number;
  rays: number;
  ammoKey: 'pistol' | 'shotgun';
  ammoPerShot: number;
}

export const WEAPONS: Weapon[] = [
  { key: 'pistol', cooldown: 0.35, damage: 14, spread: 0, rays: 1, ammoKey: 'pistol', ammoPerShot: 1 },
  { key: 'shotgun', cooldown: 0.85, damage: 9, spread: 0.18, rays: 7, ammoKey: 'shotgun', ammoPerShot: 1 },
];

export function rayHitsCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number | null {
  const fx = ox - cx, fy = oy - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 ? t : null;
}

export function fireHitscan(
  lvl: Level,
  enemies: Enemy[],
  ox: number, oy: number,
  dx: number, dy: number,
): { enemy: Enemy; t: number } | null {
  const wallT = castRay(lvl, ox, oy, dx, dy).perpDist;
  let best: { enemy: Enemy; t: number } | null = null;
  for (const e of enemies) {
    if (e.state === 'dying') continue;
    const t = rayHitsCircle(ox, oy, dx, dy, e.x, e.y, 0.35);
    if (t === null || t > wallT) continue;
    if (!best || t < best.t) best = { enemy: e, t };
  }
  return best;
}
