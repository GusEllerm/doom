import { BUF_W, BUF_H } from './raycaster';
import type { Player } from '../entities/player';
import { WEAPONS } from '../entities/weapons';
import type { Assets } from '../engine/assets';

export function renderViewmodel(
  ctx: CanvasRenderingContext2D,
  player: Player,
  time: number,
  assets: Assets,
) {
  const w = WEAPONS[player.weapon]!;
  const img = assets.sprite(w.key);
  const bob = player.moving ? Math.sin(time * 9) * 3 : 0;
  const sway = player.moving ? Math.cos(time * 4.5) * 2 : 0;
  const recoil = Math.max(0, player.cooldown / w.cooldown) * 14;
  const drawW = img.width;
  const drawH = img.height;
  const x = (BUF_W - drawW) / 2 + sway;
  const y = BUF_H - 28 - drawH + recoil + bob;
  ctx.drawImage(img, x, y);
  // Muzzle flash
  if (player.cooldown > w.cooldown - 0.08 && player.cooldown > 0) {
    ctx.fillStyle = 'rgba(255,220,80,0.85)';
    const fx = BUF_W / 2;
    const fy = y + 12;
    ctx.beginPath();
    ctx.arc(fx, fy, 10, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,200,0.85)';
    ctx.beginPath();
    ctx.arc(fx, fy, 5, 0, Math.PI * 2);
    ctx.fill();
  }
}
