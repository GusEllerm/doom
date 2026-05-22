import { BUF_W, BUF_H } from './raycaster';
import type { Player } from '../entities/player';
import { WEAPONS } from '../entities/weapons';

export function renderHUD(ctx: CanvasRenderingContext2D, player: Player, damageFlash: number) {
  if (damageFlash > 0) {
    ctx.fillStyle = `rgba(180,0,0,${Math.min(0.5, damageFlash)})`;
    ctx.fillRect(0, 0, BUF_W, BUF_H);
  }
  const h = 28;
  ctx.fillStyle = '#0c0c10';
  ctx.fillRect(0, BUF_H - h, BUF_W, h);
  ctx.fillStyle = '#444';
  ctx.fillRect(0, BUF_H - h, BUF_W, 1);
  ctx.font = '10px monospace';
  ctx.fillStyle = '#ff4040';
  ctx.fillText(`HP ${Math.max(0, player.health | 0)}`, 8, BUF_H - 10);
  ctx.fillStyle = '#40c0ff';
  ctx.fillText(`AR ${player.armor | 0}`, 64, BUF_H - 10);
  const w = WEAPONS[player.weapon]!;
  ctx.fillStyle = '#ffd040';
  ctx.fillText(`${w.key.toUpperCase()} ${player.ammo[w.ammoKey]}`, 120, BUF_H - 10);
  // Crosshair
  ctx.fillStyle = '#fff';
  ctx.fillRect(BUF_W / 2 - 1, BUF_H / 2 - 14, 2, 4);
  ctx.fillRect(BUF_W / 2 - 1, BUF_H / 2 + 10, 2, 4);
  ctx.fillRect(BUF_W / 2 - 14, BUF_H / 2 - 1, 4, 2);
  ctx.fillRect(BUF_W / 2 + 10, BUF_H / 2 - 1, 4, 2);
}
