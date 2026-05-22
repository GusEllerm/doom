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

export interface HitscanResult {
  enemy: Enemy | null;
  t: number;          // distance traveled by the ray (wall or enemy)
  wallT: number;      // distance to wall
}

const ENEMY_HIT_RADIUS = 0.42;
const AIM_ASSIST_RADIUS = 0.7; // ~3° at 5 cells; only kicks in if direct ray misses

export function fireHitscan(
  lvl: Level,
  enemies: Enemy[],
  ox: number, oy: number,
  dx: number, dy: number,
): HitscanResult {
  const wallT = castRay(lvl, ox, oy, dx, dy).perpDist;
  // 1. Direct hit pass.
  let best: { enemy: Enemy; t: number } | null = null;
  for (const e of enemies) {
    if (e.state === 'dying') continue;
    const t = rayHitsCircle(ox, oy, dx, dy, e.x, e.y, ENEMY_HIT_RADIUS);
    if (t === null || t > wallT) continue;
    if (!best || t < best.t) best = { enemy: e, t };
  }
  if (best) return { enemy: best.enemy, t: best.t, wallT };

  // 2. Aim-assist pass: forgive a near-miss within AIM_ASSIST_RADIUS, but only
  //    pick the closest near-miss whose enemy has unobstructed line-of-sight.
  let assist: { enemy: Enemy; t: number } | null = null;
  for (const e of enemies) {
    if (e.state === 'dying') continue;
    const t = rayHitsCircle(ox, oy, dx, dy, e.x, e.y, AIM_ASSIST_RADIUS);
    if (t === null || t > wallT) continue;
    // Sanity check LOS so we don't assist through walls.
    const ddx = e.x - ox, ddy = e.y - oy;
    const dist = Math.hypot(ddx, ddy);
    if (dist < 0.001) continue;
    const losT = castRay(lvl, ox, oy, ddx / dist, ddy / dist).perpDist;
    if (losT < dist - 0.05) continue;
    if (!assist || t < assist.t) assist = { enemy: e, t: dist };
  }
  if (assist) return { enemy: assist.enemy, t: assist.t, wallT };
  return { enemy: null, t: wallT, wallT };
}
