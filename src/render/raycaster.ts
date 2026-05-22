import type { Level } from '../world/level';

export const BUF_W = 320;
export const BUF_H = 200;

export interface RayHit {
  perpDist: number;
  tile: number;
  side: 0 | 1;
  wallX: number;
}

export function castRay(lvl: Level, px: number, py: number, rdx: number, rdy: number): RayHit {
  let mapX = Math.floor(px), mapY = Math.floor(py);
  const rx = rdx === 0 ? 1e-30 : rdx;
  const ry = rdy === 0 ? 1e-30 : rdy;
  const deltaDistX = Math.abs(1 / rx);
  const deltaDistY = Math.abs(1 / ry);
  const stepX = rx < 0 ? -1 : 1;
  const stepY = ry < 0 ? -1 : 1;
  let sideDistX = rx < 0 ? (px - mapX) * deltaDistX : (mapX + 1 - px) * deltaDistX;
  let sideDistY = ry < 0 ? (py - mapY) * deltaDistY : (mapY + 1 - py) * deltaDistY;
  let side: 0 | 1 = 0;
  for (let i = 0; i < 128; i++) {
    if (sideDistX < sideDistY) { sideDistX += deltaDistX; mapX += stepX; side = 0; }
    else { sideDistY += deltaDistY; mapY += stepY; side = 1; }
    if (lvl.isSolid(mapX + 0.5, mapY + 0.5)) {
      const perp = side === 0
        ? (mapX - px + (1 - stepX) / 2) / rx
        : (mapY - py + (1 - stepY) / 2) / ry;
      const wallHit = side === 0 ? py + perp * ry : px + perp * rx;
      const wallX = wallHit - Math.floor(wallHit);
      return { perpDist: Math.max(0.0001, perp), tile: lvl.tileAt(mapX, mapY), side, wallX };
    }
  }
  return { perpDist: 64, tile: 0, side: 0, wallX: 0 };
}

export function renderWalls(
  ctx: CanvasRenderingContext2D,
  lvl: Level,
  px: number, py: number, angle: number,
  fov = Math.PI / 3,
  depth?: Float32Array,
) {
  const planeLen = Math.tan(fov / 2);
  const dirX = Math.cos(angle), dirY = Math.sin(angle);
  const planeX = -dirY * planeLen, planeY = dirX * planeLen;
  ctx.fillStyle = '#3a3a3a';
  ctx.fillRect(0, 0, BUF_W, BUF_H / 2);
  ctx.fillStyle = '#202020';
  ctx.fillRect(0, BUF_H / 2, BUF_W, BUF_H / 2);
  for (let x = 0; x < BUF_W; x++) {
    const cam = 2 * x / BUF_W - 1;
    const rdx = dirX + planeX * cam;
    const rdy = dirY + planeY * cam;
    const hit = castRay(lvl, px, py, rdx, rdy);
    if (depth) depth[x] = hit.perpDist;
    const h = Math.min(BUF_H * 4, Math.floor(BUF_H / hit.perpDist));
    const top = Math.floor((BUF_H - h) / 2);
    const shade = hit.side === 1 ? 0.7 : 1.0;
    const base = hit.tile === 1 ? 180 : 120;
    const c = Math.floor(Math.min(255, base * shade / Math.max(0.6, hit.perpDist * 0.25)));
    ctx.fillStyle = `rgb(${c},${c},${c})`;
    ctx.fillRect(x, top, 1, h);
  }
}
