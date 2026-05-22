import type { Level } from '../world/level';

export const BUF_W = 320;
export const BUF_H = 200;

export interface RayHit {
  perpDist: number;
  tile: number;
  side: 0 | 1;
  wallX: number;
}

export function castRay(lvl: Level, px: number, py: number, rdx: number, rdy: number, isSolid?: (x: number, y: number, tile: number) => boolean): RayHit {
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
    const tile = lvl.tileAt(mapX, mapY);
    const solid = isSolid
      ? isSolid(mapX, mapY, tile)
      : (tile !== 0 && tile < 100);
    if (solid) {
      const perp = side === 0
        ? (mapX - px + (1 - stepX) / 2) / rx
        : (mapY - py + (1 - stepY) / 2) / ry;
      const wallHit = side === 0 ? py + perp * ry : px + perp * rx;
      const wallX = wallHit - Math.floor(wallHit);
      return { perpDist: Math.max(0.0001, perp), tile, side, wallX };
    }
  }
  return { perpDist: 64, tile: 0, side: 0, wallX: 0 };
}

export interface RenderWallsOptions {
  fov?: number;
  depth?: Float32Array;
  textureFor: (tile: number) => HTMLImageElement;
  isSolid?: (x: number, y: number, tile: number) => boolean;
}

export function renderWalls(
  ctx: CanvasRenderingContext2D,
  lvl: Level,
  px: number, py: number, angle: number,
  opts: RenderWallsOptions,
) {
  const fov = opts.fov ?? Math.PI / 3;
  const planeLen = Math.tan(fov / 2);
  const dirX = Math.cos(angle), dirY = Math.sin(angle);
  const planeX = -dirY * planeLen, planeY = dirX * planeLen;
  // Ceiling
  ctx.fillStyle = '#2a2a30';
  ctx.fillRect(0, 0, BUF_W, BUF_H / 2);
  // Floor
  ctx.fillStyle = '#1a1410';
  ctx.fillRect(0, BUF_H / 2, BUF_W, BUF_H / 2);

  for (let x = 0; x < BUF_W; x++) {
    const cam = 2 * x / BUF_W - 1;
    const rdx = dirX + planeX * cam;
    const rdy = dirY + planeY * cam;
    const hit = castRay(lvl, px, py, rdx, rdy, opts.isSolid);
    if (opts.depth) opts.depth[x] = hit.perpDist;
    const h = Math.min(BUF_H * 4, Math.floor(BUF_H / hit.perpDist));
    const top = Math.floor((BUF_H - h) / 2);
    const img = opts.textureFor(hit.tile);
    const tx = Math.min(img.width - 1, Math.max(0, Math.floor(hit.wallX * img.width)));
    ctx.drawImage(img, tx, 0, 1, img.height, x, top, 1, h);
    if (hit.side === 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(x, top, 1, h);
    }
    // Distance fog
    const fog = Math.min(0.75, hit.perpDist * 0.04);
    if (fog > 0) {
      ctx.fillStyle = `rgba(0,0,0,${fog})`;
      ctx.fillRect(x, top, 1, h);
    }
  }
}
