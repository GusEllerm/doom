import { BUF_W, BUF_H } from './raycaster';
import type { Player } from '../entities/player';
import { WEAPONS } from '../entities/weapons';
import type { Assets } from '../engine/assets';
import { PALETTE, text, metallicStrip } from './theme';

export interface PickupMessage { text: string; t: number; }

export interface HUDState {
  damageFlash: number;
  pickupFeed: PickupMessage[];
  hurtFlashT: number;
  hoveredEnemy: boolean;
  killCount: number;
  hitMarkerT: number;
  wallSparkT: number;
}

const HUD_H = 38;

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
  let feedY = BUF_H - HUD_H - 4;
  for (let i = hud.pickupFeed.length - 1; i >= 0; i--) {
    const m = hud.pickupFeed[i]!;
    const alpha = Math.min(1, m.t / 0.4);
    ctx.font = 'bold 9px monospace';
    const w = ctx.measureText(m.text).width + 14;
    // backdrop tab
    ctx.fillStyle = `rgba(20,10,5,${0.75 * alpha})`;
    ctx.fillRect(4, feedY - 10, w, 12);
    ctx.fillStyle = `rgba(255,210,80,${alpha})`;
    ctx.fillRect(4, feedY - 10, 2, 12);
    text(ctx, m.text, 12, feedY, { size: 9, color: `rgba(255,225,140,${alpha})`, shadow: true });
    feedY -= 14;
  }

  // Crosshair
  const cx = BUF_W / 2, cy = BUF_H / 2 - HUD_H / 2;
  ctx.fillStyle = hud.hoveredEnemy ? PALETTE.bloodHi : PALETTE.bone;
  ctx.fillRect(cx - 1, cy - 6, 2, 4);
  ctx.fillRect(cx - 1, cy + 2, 2, 4);
  ctx.fillRect(cx - 6, cy - 1, 4, 2);
  ctx.fillRect(cx + 2, cy - 1, 4, 2);
  if (hud.hoveredEnemy) {
    ctx.fillStyle = 'rgba(255,40,40,0.25)';
    ctx.fillRect(cx - 7, cy - 7, 14, 14);
  }
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
  if (hud.hitMarkerT > 0) {
    const alpha = Math.min(1, hud.hitMarkerT / 0.2);
    ctx.strokeStyle = `rgba(255,80,80,${alpha})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 8); ctx.lineTo(cx + 8, cy + 8);
    ctx.moveTo(cx + 8, cy - 8); ctx.lineTo(cx - 8, cy + 8);
    ctx.stroke();
  }

  // HUD bar
  const top = BUF_H - HUD_H;
  metallicStrip(ctx, 0, top, BUF_W, HUD_H);

  // Section dividers
  ctx.fillStyle = 'rgba(255,200,160,0.10)';
  const divs = [88, 138, 178, 230];
  for (const d of divs) {
    ctx.fillRect(d, top + 4, 1, HUD_H - 8);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(d + 1, top + 4, 1, HUD_H - 8);
    ctx.fillStyle = 'rgba(255,200,160,0.10)';
  }

  // HEALTH — red, large
  text(ctx, `${Math.max(0, player.health | 0)}%`, 10, top + 24, {
    size: 18, color: PALETTE.bloodHi, shadow: true, outline: true,
  });
  text(ctx, 'HEALTH', 10, top + 33, { size: 7, color: PALETTE.paperLo, weight: 'normal' });

  // ARMOR — cyan
  text(ctx, `${player.armor | 0}%`, 96, top + 24, {
    size: 14, color: PALETTE.cyanHi, shadow: true,
  });
  text(ctx, 'ARMOR', 96, top + 33, { size: 7, color: PALETTE.paperLo, weight: 'normal' });

  // Face portrait (centered between armor and weapon)
  const face = assets.sprite(pickFace(player, hud.hurtFlashT));
  const faceW = 30, faceH = 30;
  const faceX = (BUF_W - faceW) / 2;
  const faceY = top + (HUD_H - faceH) / 2;
  // bezel
  ctx.fillStyle = PALETTE.ink;
  ctx.fillRect(faceX - 3, faceY - 3, faceW + 6, faceH + 6);
  ctx.fillStyle = '#3a2a2e';
  ctx.fillRect(faceX - 2, faceY - 2, faceW + 4, faceH + 4);
  ctx.fillStyle = PALETTE.steelLo;
  ctx.fillRect(faceX - 1, faceY - 1, faceW + 2, faceH + 2);
  // Idle blink
  const blink = (Math.sin(time * 0.7) > 0.985 || Math.sin(time * 0.9 + 2) > 0.985);
  ctx.drawImage(face, faceX, faceY, faceW, faceH);
  if (blink && player.health > 0) {
    ctx.fillStyle = PALETTE.ink;
    ctx.fillRect(faceX + 8, faceY + 14, 4, 2);
    ctx.fillRect(faceX + 18, faceY + 14, 4, 2);
  }

  // AMMO — amber, right cluster
  const w = WEAPONS[player.weapon]!;
  const ammoStr = `${player.ammo[w.ammoKey]}`;
  ctx.font = 'bold 18px monospace';
  const ammoW = ctx.measureText(ammoStr).width;
  text(ctx, ammoStr, BUF_W - 10 - ammoW, top + 24, {
    size: 18, color: PALETTE.amberHi, shadow: true, outline: true,
  });
  text(ctx, 'AMMO', BUF_W - 10 - 28, top + 33, {
    size: 7, color: PALETTE.paperLo, weight: 'normal',
  });

  // WEAPON name + kills (middle-right cluster)
  text(ctx, w.key.toUpperCase(), BUF_W - 78, top + 14, {
    size: 9, color: PALETTE.amberMid,
  });
  text(ctx, `KILLS ${hud.killCount}`, BUF_W - 78, top + 24, {
    size: 7, color: PALETTE.paperLo, weight: 'normal',
  });
  text(ctx, levelName, BUF_W - 78, top + 33, {
    size: 7, color: PALETTE.steelHi, weight: 'normal',
  });
}
