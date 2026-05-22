import { BUF_W, BUF_H } from './raycaster';

export interface CamSpace { x: number; z: number; }

export function spriteCameraTransform(sx: number, sy: number, px: number, py: number, angle: number): CamSpace {
  const dx = sx - px, dy = sy - py;
  // Rotate world vector by -angle to get camera space.
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  // Camera looks along +x in world; in cam space, z is forward (along camera dir), x is lateral.
  // For angle=0 (facing +x), camera-x = world dy (lateral), camera-z = world dx (forward).
  return {
    x: dx * sin + dy * cos, // lateral (sign chosen to match dirX/planeX convention)
    z: dx * cos - dy * sin, // forward
  };
}

export interface RenderableSprite { x: number; y: number; img: HTMLImageElement; vOffset?: number; }

export function renderSprites(
  ctx: CanvasRenderingContext2D,
  sprites: RenderableSprite[],
  px: number, py: number, angle: number,
  depth: Float32Array,
  fov = Math.PI / 3,
) {
  const planeLen = Math.tan(fov / 2);
  const enriched = sprites.map((s) => {
    const c = spriteCameraTransform(s.x, s.y, px, py, angle);
    return { s, c };
  }).filter((e) => e.c.z > 0.1)
    .sort((a, b) => b.c.z - a.c.z);

  for (const { s, c } of enriched) {
    const screenX = Math.floor((BUF_W / 2) * (1 + (c.x / planeLen) / c.z));
    const size = Math.floor(BUF_H / c.z);
    if (size < 1) continue;
    const vOffset = (s.vOffset ?? 0) * size;
    const top = Math.floor((BUF_H - size) / 2 + vOffset);
    const left = screenX - Math.floor(size / 2);
    for (let col = 0; col < size; col++) {
      const sx = left + col;
      if (sx < 0 || sx >= BUF_W) continue;
      if (c.z > depth[sx]!) continue;
      const tx = Math.min(s.img.width - 1, Math.max(0, Math.floor((col / size) * s.img.width)));
      ctx.drawImage(s.img, tx, 0, 1, s.img.height, sx, top, 1, size);
    }
  }
}
