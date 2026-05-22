import { BUF_W, BUF_H } from './raycaster';
import { PALETTE, text, centeredText, makeEmbers, updateEmbers, renderEmbers, skullBullet, bevelPanel, type EmberField } from './theme';
import type { Menu } from '../game/menu';

const titleEmbers: EmberField = makeEmbers(40, BUF_W, BUF_H);
const winEmbers: EmberField = makeEmbers(25, BUF_W, BUF_H);
const deathEmbers: EmberField = makeEmbers(20, BUF_W, BUF_H);

export function tickEmbers(dt: number) {
  updateEmbers(titleEmbers, dt, BUF_W, BUF_H);
  updateEmbers(winEmbers, dt, BUF_W, BUF_H);
  updateEmbers(deathEmbers, dt, BUF_W, BUF_H);
}

function backdrop(ctx: CanvasRenderingContext2D, time: number, hue: 'red' | 'green' | 'amber') {
  const stops = hue === 'red'
    ? ['#0a0306', '#2a0808', PALETTE.bloodLo]
    : hue === 'green'
    ? ['#040c04', '#0a3010', PALETTE.bileLo]
    : ['#100804', '#2a1a08', PALETTE.amberLo];
  const g = ctx.createLinearGradient(0, 0, 0, BUF_H);
  g.addColorStop(0, stops[0]!);
  g.addColorStop(0.6, stops[1]!);
  g.addColorStop(1, stops[2]!);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, BUF_W, BUF_H);
  // Scanlines
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  for (let y = 0; y < BUF_H; y += 2) ctx.fillRect(0, y, BUF_W, 1);
  // Pulse vignette
  const pulse = 0.5 + 0.5 * Math.sin(time * 1.6);
  const v = ctx.createRadialGradient(BUF_W / 2, BUF_H / 2, 30, BUF_W / 2, BUF_H / 2, 220);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, `rgba(0,0,0,${0.45 + pulse * 0.15})`);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, BUF_W, BUF_H);
}

function doomLogo(ctx: CanvasRenderingContext2D, time: number) {
  const cx = BUF_W / 2;
  const y = 64;
  // Shadow drop
  ctx.font = 'bold 56px monospace';
  const w = ctx.measureText('DOOM').width;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillText('DOOM', cx - w / 2 + 4, y + 4);
  // Outline
  ctx.lineWidth = 5;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = PALETTE.ink;
  ctx.strokeText('DOOM', cx - w / 2, y);
  // Fill — vertical gradient red→amber, pulsing slightly
  const pulse = 0.5 + 0.5 * Math.sin(time * 1.4);
  const grad = ctx.createLinearGradient(0, y - 36, 0, y + 4);
  grad.addColorStop(0, `rgba(255,${120 + pulse * 30 | 0},80,1)`);
  grad.addColorStop(0.55, PALETTE.bloodHi);
  grad.addColorStop(1, PALETTE.bloodLo);
  ctx.fillStyle = grad;
  ctx.fillText('DOOM', cx - w / 2, y);
  // Drips
  ctx.fillStyle = PALETTE.bloodMid;
  ctx.fillRect(cx - w / 2 + 10, y + 4, 3, 8);
  ctx.fillRect(cx + 12, y + 4, 2, 6);
  ctx.fillRect(cx + w / 2 - 14, y + 4, 3, 10);
}

export function renderTitle(ctx: CanvasRenderingContext2D, time: number, menu: Menu) {
  backdrop(ctx, time, 'red');
  renderEmbers(ctx, titleEmbers);
  doomLogo(ctx, time);
  centeredText(ctx, 'BROWSER  EDITION', BUF_W / 2, 86, {
    size: 9, color: PALETTE.amberHi, shadow: true,
  });

  // Menu
  const menuTopY = 122;
  const itemH = 18;
  for (let i = 0; i < menu.list.length; i++) {
    const item = menu.list[i]!;
    const y = menuTopY + i * itemH;
    const selected = i === menu.selected;
    if (selected) {
      // Selection chrome — skull bullets on each side, slight glow.
      const w = 160;
      const x = (BUF_W - w) / 2;
      ctx.fillStyle = 'rgba(255,48,48,0.18)';
      ctx.fillRect(x, y - 11, w, 16);
      ctx.fillStyle = 'rgba(255,48,48,0.6)';
      ctx.fillRect(x, y - 11, w, 1);
      ctx.fillRect(x, y + 4, w, 1);
      skullBullet(ctx, x + 10, y - 3, 4, PALETTE.bloodHi);
      skullBullet(ctx, x + w - 10, y - 3, 4, PALETTE.bloodHi);
    }
    centeredText(ctx, item.label, BUF_W / 2, y, {
      size: 12,
      color: item.disabled ? PALETTE.paperLo : selected ? PALETTE.bone : PALETTE.paperHi,
      shadow: true,
      outline: selected,
    });
  }

  // Footer hint
  centeredText(ctx, '↑↓ select   ENTER / LMB confirm', BUF_W / 2, BUF_H - 18, {
    size: 8, color: PALETTE.paperLo,
  });
  centeredText(ctx, 'WASD move · MOUSE aim · LMB fire · E doors · 1/2 weapons', BUF_W / 2, BUF_H - 6, {
    size: 8, color: PALETTE.paperLo,
  });
}

interface EndStats {
  killCount: number;
  shotsFired: number;
  shotsHit: number;
  timeSeconds: number;
  levelName: string;
}

function statsBlock(ctx: CanvasRenderingContext2D, stats: EndStats, topY: number) {
  const w = 200, h = 60;
  const x = (BUF_W - w) / 2, y = topY;
  bevelPanel(ctx, x, y, w, h);
  ctx.font = '9px monospace';
  const acc = stats.shotsFired ? Math.round(stats.shotsHit / stats.shotsFired * 100) : 0;
  const mins = Math.floor(stats.timeSeconds / 60);
  const secs = Math.floor(stats.timeSeconds % 60).toString().padStart(2, '0');
  const lines = [
    ['KILLS',    `${stats.killCount}`],
    ['ACCURACY', `${acc}%`],
    ['TIME',     `${mins}:${secs}`],
  ];
  for (let i = 0; i < lines.length; i++) {
    const [label, value] = lines[i]!;
    text(ctx, label!, x + 14, y + 16 + i * 14, { size: 9, color: PALETTE.paperLo, weight: 'normal' });
    text(ctx, value!, x + w - 14 - ctx.measureText(value!).width, y + 16 + i * 14, { size: 9, color: PALETTE.bone });
  }
}

export function renderDeath(ctx: CanvasRenderingContext2D, time: number, stats: EndStats) {
  backdrop(ctx, time, 'red');
  renderEmbers(ctx, deathEmbers);
  ctx.fillStyle = 'rgba(80,0,0,0.4)';
  ctx.fillRect(0, 0, BUF_W, BUF_H);

  // Big YOU DIED with shadow + outline
  ctx.font = 'bold 38px monospace';
  const t = 'YOU DIED';
  const tw = ctx.measureText(t).width;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillText(t, (BUF_W - tw) / 2 + 3, 70);
  ctx.lineWidth = 4; ctx.lineJoin = 'round';
  ctx.strokeStyle = PALETTE.ink;
  ctx.strokeText(t, (BUF_W - tw) / 2, 70);
  const grad = ctx.createLinearGradient(0, 38, 0, 78);
  grad.addColorStop(0, '#ff8060');
  grad.addColorStop(1, PALETTE.bloodMid);
  ctx.fillStyle = grad;
  ctx.fillText(t, (BUF_W - tw) / 2, 70);

  centeredText(ctx, stats.levelName, BUF_W / 2, 84, { size: 9, color: PALETTE.paperHi });
  statsBlock(ctx, stats, 96);

  const blink = (Math.sin(time * 3.5) + 1) / 2;
  centeredText(ctx, 'CLICK / FIRE TO TRY AGAIN', BUF_W / 2, BUF_H - 14, {
    size: 10, color: `rgba(255,210,90,${0.55 + blink * 0.45})`, shadow: true,
  });
}

export function renderWin(ctx: CanvasRenderingContext2D, time: number, stats: EndStats) {
  backdrop(ctx, time, 'green');
  renderEmbers(ctx, winEmbers);

  ctx.font = 'bold 40px monospace';
  const t = 'VICTORY';
  const tw = ctx.measureText(t).width;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillText(t, (BUF_W - tw) / 2 + 3, 64);
  ctx.lineWidth = 4; ctx.lineJoin = 'round';
  ctx.strokeStyle = PALETTE.ink;
  ctx.strokeText(t, (BUF_W - tw) / 2, 64);
  const grad = ctx.createLinearGradient(0, 32, 0, 72);
  grad.addColorStop(0, '#d0ffd0');
  grad.addColorStop(1, PALETTE.bileMid);
  ctx.fillStyle = grad;
  ctx.fillText(t, (BUF_W - tw) / 2, 64);

  centeredText(ctx, 'The foundry burns behind you.', BUF_W / 2, 84, {
    size: 9, color: PALETTE.paperHi,
  });
  statsBlock(ctx, stats, 96);

  const blink = (Math.sin(time * 3) + 1) / 2;
  centeredText(ctx, 'CLICK / FIRE FOR TITLE', BUF_W / 2, BUF_H - 14, {
    size: 10, color: `rgba(200,255,170,${0.55 + blink * 0.45})`, shadow: true,
  });
}

export function renderPause(ctx: CanvasRenderingContext2D, menu: Menu) {
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, BUF_W, BUF_H);
  // Banner
  ctx.font = 'bold 22px monospace';
  const t = 'PAUSED';
  const tw = ctx.measureText(t).width;
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillText(t, (BUF_W - tw) / 2 + 2, 50);
  ctx.lineWidth = 3; ctx.lineJoin = 'round';
  ctx.strokeStyle = PALETTE.ink;
  ctx.strokeText(t, (BUF_W - tw) / 2, 50);
  ctx.fillStyle = PALETTE.amberHi;
  ctx.fillText(t, (BUF_W - tw) / 2, 50);

  const itemH = 16;
  const topY = 74;
  for (let i = 0; i < menu.list.length; i++) {
    const item = menu.list[i]!;
    const y = topY + i * itemH;
    const selected = i === menu.selected;
    if (selected) {
      const w = 150;
      const x = (BUF_W - w) / 2;
      ctx.fillStyle = 'rgba(255,210,80,0.16)';
      ctx.fillRect(x, y - 10, w, 14);
      skullBullet(ctx, x + 10, y - 3, 3, PALETTE.amberHi);
      skullBullet(ctx, x + w - 10, y - 3, 3, PALETTE.amberHi);
    }
    centeredText(ctx, item.label, BUF_W / 2, y, {
      size: 11,
      color: item.disabled ? PALETTE.paperLo : selected ? PALETTE.bone : PALETTE.paperHi,
      shadow: true,
    });
  }

  // Controls reference
  const refY = topY + menu.list.length * itemH + 18;
  centeredText(ctx, 'CONTROLS', BUF_W / 2, refY, { size: 8, color: PALETTE.amberMid });
  const lines = [
    '[WASD] move   [MOUSE] aim   [LMB] fire',
    '[E] doors   [1/2] weapons   [F1] debug',
  ];
  for (let i = 0; i < lines.length; i++) {
    centeredText(ctx, lines[i]!, BUF_W / 2, refY + 12 + i * 10, {
      size: 8, color: PALETTE.paperLo, weight: 'normal',
    });
  }
}

export function renderLevelIntro(ctx: CanvasRenderingContext2D, name: string, fade: number) {
  const alpha = Math.min(1, fade);
  // Vignette band
  const g = ctx.createLinearGradient(0, BUF_H / 2 - 26, 0, BUF_H / 2 + 14);
  g.addColorStop(0, `rgba(0,0,0,0)`);
  g.addColorStop(0.4, `rgba(0,0,0,${0.65 * alpha})`);
  g.addColorStop(1, `rgba(0,0,0,0)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, BUF_H / 2 - 30, BUF_W, 44);
  centeredText(ctx, name, BUF_W / 2, BUF_H / 2 - 8, {
    size: 14, color: `rgba(255,210,120,${alpha})`, shadow: true, outline: true,
  });
  centeredText(ctx, 'RIP AND TEAR', BUF_W / 2, BUF_H / 2 + 6, {
    size: 8, color: `rgba(220,200,180,${alpha * 0.85})`,
  });
}
