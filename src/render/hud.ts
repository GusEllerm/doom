import { BUF_W, BUF_H } from './raycaster';
import type { Player } from '../entities/player';
import { WEAPONS } from '../entities/weapons';
import type { Assets } from '../engine/assets';

export interface PickupMessage { text: string; t: number; }

export interface HUDState {
  damageFlash: number;
  pickupFeed: PickupMessage[];
  hurtFlashT: number;
  hoveredEnemy: boolean;
  killCount: number;
  hitMarkerT: number;     // red X on crosshair when a shot lands
  wallSparkT: number;     // yellow spark when a shot hits a wall
}

const HUD_H = 36;

function pickFace(player: Player, hurtFlashT: number): string {
  if (player.health <= 0) return 'face_dead';
  if (hurtFlashT > 0) return 'face_hurt';
  if (player.health <= 10) return 'face_10';
  if (player.health <= 25) return 'face_25';
  if (player.health <= 50) return 'face_50';
  if (player.health <= 75) return 'face_75';
  return 'face_100';
}

export function renderHUD(
  ctx: CanvasRenderingContext2D,
  player: Player,
  hud: HUDState,
  assets: Assets,
  levelName: string,
  time: number,
) {
  // Full-screen tints
  if (hud.damageFlash > 0) {
    ctx.fillStyle = `rgba(180,0,0,${Math.min(0.45, hud.damageFlash)})`;
    ctx.fillRect(0, 0, BUF_W, BUF_H);
  }

  // Pickup feed (above HUD, bottom-left)
  let feedY = BUF_H - HUD_H - 6;
  ctx.font = '8px monospace';
  for (let i = hud.pickupFeed.length - 1; i >= 0; i--) {
    const m = hud.pickupFeed[i]!;
    const alpha = Math.min(1, m.t / 0.4);
    ctx.fillStyle = `rgba(0,0,0,${0.55 * alpha})`;
    const w = ctx.measureText(m.text).width + 8;
    ctx.fillRect(6, feedY - 8, w, 10);
    ctx.fillStyle = `rgba(255,220,120,${alpha})`;
    ctx.fillText(m.text, 10, feedY - 1);
    feedY -= 12;
  }

  // Crosshair (red on enemy hover; grows during cooldown for fire readiness)
  const cx = BUF_W / 2, cy = BUF_H / 2 - HUD_H / 2;
  ctx.fillStyle = hud.hoveredEnemy ? '#ff3030' : '#fff';
  ctx.fillRect(cx - 1, cy - 6, 2, 4);
  ctx.fillRect(cx - 1, cy + 2, 2, 4);
  ctx.fillRect(cx - 6, cy - 1, 4, 2);
  ctx.fillRect(cx + 2, cy - 1, 4, 2);
  if (hud.hoveredEnemy) {
    ctx.fillStyle = 'rgba(255,40,40,0.25)';
    ctx.fillRect(cx - 7, cy - 7, 14, 14);
  }
  // Yellow wall-impact spark (a brief puff at the crosshair on miss)
  if (hud.wallSparkT > 0) {
    const alpha = Math.min(1, hud.wallSparkT / 0.15);
    ctx.fillStyle = `rgba(255,220,80,${alpha * 0.8})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 5 + (1 - alpha) * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(255,255,220,${alpha})`;
    ctx.beginPath();
    ctx.arc(cx, cy, 2, 0, Math.PI * 2);
    ctx.fill();
  }
  // Red hit-marker X when a shot lands on an enemy
  if (hud.hitMarkerT > 0) {
    const alpha = Math.min(1, hud.hitMarkerT / 0.2);
    ctx.strokeStyle = `rgba(255,80,80,${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 8); ctx.lineTo(cx + 8, cy + 8);
    ctx.moveTo(cx + 8, cy - 8); ctx.lineTo(cx - 8, cy + 8);
    ctx.stroke();
  }

  // HUD bar background
  const top = BUF_H - HUD_H;
  const grad = ctx.createLinearGradient(0, top, 0, BUF_H);
  grad.addColorStop(0, '#1a1418');
  grad.addColorStop(1, '#0a070a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, top, BUF_W, HUD_H);
  // bevel
  ctx.fillStyle = '#3a2a2a'; ctx.fillRect(0, top, BUF_W, 1);
  ctx.fillStyle = 'rgba(255,200,160,0.07)'; ctx.fillRect(0, top + 1, BUF_W, 1);

  // Face portrait — centered
  const face = assets.sprite(pickFace(player, hud.hurtFlashT));
  const faceW = 28, faceH = 28;
  const faceX = (BUF_W - faceW) / 2;
  const faceY = top + (HUD_H - faceH) / 2;
  ctx.fillStyle = '#000';
  ctx.fillRect(faceX - 2, faceY - 2, faceW + 4, faceH + 4);
  ctx.fillStyle = '#444';
  ctx.fillRect(faceX - 1, faceY - 1, faceW + 2, faceH + 2);
  ctx.drawImage(face, faceX, faceY, faceW, faceH);

  // Left cluster: HEALTH + ARMOR
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#ff3030';
  ctx.fillText(`${Math.max(0, player.health | 0)}%`, 14, top + 18);
  ctx.font = '7px monospace'; ctx.fillStyle = '#aaa';
  ctx.fillText('HEALTH', 14, top + 28);

  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#40c0ff';
  ctx.fillText(`${player.armor | 0}%`, 66, top + 18);
  ctx.font = '7px monospace'; ctx.fillStyle = '#aaa';
  ctx.fillText('ARMOR', 66, top + 28);

  // Right cluster: AMMO + WEAPON
  const w = WEAPONS[player.weapon]!;
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = '#ffd040';
  const ammoStr = `${player.ammo[w.ammoKey]}`;
  const ammoW = ctx.measureText(ammoStr).width;
  ctx.fillText(ammoStr, BUF_W - 14 - ammoW, top + 18);
  ctx.font = '7px monospace'; ctx.fillStyle = '#aaa';
  ctx.fillText('AMMO', BUF_W - 14 - 28, top + 28);

  // Weapon name
  ctx.font = 'bold 9px monospace';
  ctx.fillStyle = '#ffd070';
  const wn = w.key.toUpperCase();
  const wnW = ctx.measureText(wn).width;
  ctx.fillText(wn, BUF_W - 14 - wnW - 60, top + 14);
  ctx.font = '7px monospace'; ctx.fillStyle = '#888';
  ctx.fillText(`KILLS ${hud.killCount}`, BUF_W - 14 - 60, top + 28);

  // Level name strip (top-right while in level, fades after 4s)
  void levelName; void time;
}
