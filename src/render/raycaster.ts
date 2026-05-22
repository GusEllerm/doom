import type { Level } from '../world/level';
import type { RawTexture } from './textureCache';

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

export interface RenderOptions {
  fov?: number;
  depth?: Float32Array;
  textureFor: (tile: number) => HTMLImageElement;
  isSolid?: (x: number, y: number, tile: number) => boolean;
  floor: RawTexture;
  ceiling: RawTexture;
  frameBuffer: ImageData; // 320x200 RGBA buffer for floor/ceil + scratch
}

export function renderScene(
  ctx: CanvasRenderingContext2D,
  lvl: Level,
  px: number, py: number, angle: number,
  opts: RenderOptions,
) {
  const fov = opts.fov ?? Math.PI / 3;
  const planeLen = Math.tan(fov / 2);
  const dirX = Math.cos(angle), dirY = Math.sin(angle);
  const planeX = -dirY * planeLen, planeY = dirX * planeLen;

  renderFloorCeiling(opts.frameBuffer, px, py, dirX, dirY, planeX, planeY, opts.floor, opts.ceiling);
  ctx.putImageData(opts.frameBuffer, 0, 0);
  renderWalls(ctx, lvl, px, py, dirX, dirY, planeX, planeY, opts);
}

function renderFloorCeiling(
  fb: ImageData,
  px: number, py: number,
  dirX: number, dirY: number,
  planeX: number, planeY: number,
  floor: RawTexture, ceiling: RawTexture,
) {
  const data = fb.data;
  const halfH = BUF_H / 2;
  const rayDirX0 = dirX - planeX, rayDirY0 = dirY - planeY;
  const rayDirX1 = dirX + planeX, rayDirY1 = dirY + planeY;
  const tw = floor.w, th = floor.h;
  const cw = ceiling.w, ch = ceiling.h;
  const tMask = tw - 1, tMaskY = th - 1;
  const cMask = cw - 1, cMaskY = ch - 1;

  for (let y = Math.floor(halfH) + 1; y < BUF_H; y++) {
    const p = y - halfH;
    const rowDist = halfH / p; // assumes camera at half-cell-height
    const stepX = rowDist * (rayDirX1 - rayDirX0) / BUF_W;
    const stepY = rowDist * (rayDirY1 - rayDirY0) / BUF_W;
    let worldX = px + rowDist * rayDirX0;
    let worldY = py + rowDist * rayDirY0;
    // Distance shading
    const fog = Math.min(0.85, rowDist * 0.10);
    const litMul = 1 - fog;

    const floorRow = y * BUF_W * 4;
    const ceilRow = (BUF_H - y - 1) * BUF_W * 4;

    for (let x = 0; x < BUF_W; x++) {
      const fx = (Math.floor(worldX * tw) & tMask);
      const fy = (Math.floor(worldY * th) & tMaskY);
      const fSrc = (fy * tw + fx) * 4;
      const cx = (Math.floor(worldX * cw) & cMask);
      const cy = (Math.floor(worldY * ch) & cMaskY);
      const cSrc = (cy * cw + cx) * 4;

      const di = floorRow + x * 4;
      data[di + 0] = floor.data[fSrc + 0]! * litMul;
      data[di + 1] = floor.data[fSrc + 1]! * litMul;
      data[di + 2] = floor.data[fSrc + 2]! * litMul;
      data[di + 3] = 255;

      const ci = ceilRow + x * 4;
      data[ci + 0] = ceiling.data[cSrc + 0]! * litMul;
      data[ci + 1] = ceiling.data[cSrc + 1]! * litMul;
      data[ci + 2] = ceiling.data[cSrc + 2]! * litMul;
      data[ci + 3] = 255;

      worldX += stepX;
      worldY += stepY;
    }
  }

  // The horizon row (y == halfH) gets the ceiling-side fill from the adjacent row.
  const horizon = Math.floor(halfH);
  const above = (horizon - 1) * BUF_W * 4;
  const at = horizon * BUF_W * 4;
  for (let i = 0; i < BUF_W * 4; i++) data[at + i] = data[above + i]!;
}

function renderWalls(
  ctx: CanvasRenderingContext2D,
  lvl: Level,
  px: number, py: number,
  dirX: number, dirY: number,
  planeX: number, planeY: number,
  opts: RenderOptions,
) {
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
    const fog = Math.min(0.85, hit.perpDist * 0.06);
    if (fog > 0) {
      ctx.fillStyle = `rgba(0,0,0,${fog})`;
      ctx.fillRect(x, top, 1, h);
    }
  }
}

// Backwards-compat shim: old `renderWalls` callsite signature.
// Kept so existing tests/imports don't break.
export function renderWalls_legacy(
  ctx: CanvasRenderingContext2D,
  lvl: Level,
  px: number, py: number, angle: number,
  opts: { fov?: number; depth?: Float32Array; textureFor: (tile: number) => HTMLImageElement; isSolid?: (x: number, y: number, tile: number) => boolean },
) {
  const fov = opts.fov ?? Math.PI / 3;
  const planeLen = Math.tan(fov / 2);
  const dirX = Math.cos(angle), dirY = Math.sin(angle);
  const planeX = -dirY * planeLen, planeY = dirX * planeLen;
  ctx.fillStyle = '#2a2a30'; ctx.fillRect(0, 0, BUF_W, BUF_H / 2);
  ctx.fillStyle = '#1a1410'; ctx.fillRect(0, BUF_H / 2, BUF_W, BUF_H / 2);
  renderWalls(ctx, lvl, px, py, dirX, dirY, planeX, planeY, {
    ...opts,
    floor: { w: 1, h: 1, data: new Uint8ClampedArray(4) },
    ceiling: { w: 1, h: 1, data: new Uint8ClampedArray(4) },
    frameBuffer: ctx.createImageData(BUF_W, BUF_H),
  });
}
