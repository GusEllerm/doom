import { BUF_W, BUF_H } from './raycaster';

// Animated background helper — diagonal demonic gradient with subtle scrolling.
function backdrop(ctx: CanvasRenderingContext2D, time: number, hue: 'red' | 'green' | 'amber') {
  const palette = hue === 'red'
    ? ['#1a0000', '#3a0808', '#6a1010']
    : hue === 'green'
    ? ['#001a00', '#083a08', '#106a10']
    : ['#1a1408', '#3a2a08', '#5a4010'];
  const grad = ctx.createLinearGradient(0, 0, 0, BUF_H);
  grad.addColorStop(0, palette[0]!);
  grad.addColorStop(0.6, palette[1]!);
  grad.addColorStop(1, palette[2]!);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, BUF_W, BUF_H);

  // Scanlines
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  for (let y = 0; y < BUF_H; y += 2) ctx.fillRect(0, y, BUF_W, 1);

  // Pulse vignette
  const pulse = 0.5 + 0.5 * Math.sin(time * 2);
  const v = ctx.createRadialGradient(BUF_W / 2, BUF_H / 2, 40, BUF_W / 2, BUF_H / 2, 200);
  v.addColorStop(0, 'rgba(0,0,0,0)');
  v.addColorStop(1, `rgba(0,0,0,${0.35 + pulse * 0.2})`);
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, BUF_W, BUF_H);
}

function bigText(ctx: CanvasRenderingContext2D, text: string, y: number, color: string, size = 36) {
  ctx.font = `bold ${size}px monospace`;
  // Drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  const w = ctx.measureText(text).width;
  ctx.fillText(text, (BUF_W - w) / 2 + 2, y + 2);
  // Outline
  ctx.strokeStyle = '#000'; ctx.lineWidth = 3;
  ctx.strokeText(text, (BUF_W - w) / 2, y);
  ctx.fillStyle = color;
  ctx.fillText(text, (BUF_W - w) / 2, y);
}

function smallText(ctx: CanvasRenderingContext2D, text: string, y: number, color: string, size = 10) {
  ctx.font = `${size}px monospace`;
  const w = ctx.measureText(text).width;
  ctx.fillStyle = color;
  ctx.fillText(text, (BUF_W - w) / 2, y);
}

export function renderTitle(ctx: CanvasRenderingContext2D, time: number) {
  backdrop(ctx, time, 'red');
  bigText(ctx, 'DOOM', 80, '#ff3030', 48);
  bigText(ctx, 'BROWSER EDITION', 110, '#ffaa40', 14);

  // Controls panel
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(60, 130, BUF_W - 120, 40);
  ctx.strokeStyle = '#7a1010'; ctx.lineWidth = 1;
  ctx.strokeRect(60, 130, BUF_W - 120, 40);
  ctx.font = '8px monospace';
  ctx.fillStyle = '#dcd0c0';
  const lines = [
    '[WASD] move   [MOUSE] aim   [LMB] fire',
    '[E] doors   [1/2] weapons   [ESC] release mouse',
  ];
  for (let i = 0; i < lines.length; i++) {
    const lw = ctx.measureText(lines[i]!).width;
    ctx.fillText(lines[i]!, (BUF_W - lw) / 2, 146 + i * 12);
  }

  // Press fire prompt — pulsing
  const blink = (Math.sin(time * 5) + 1) / 2;
  ctx.fillStyle = `rgba(255,${Math.floor(180 + blink * 75)},80,${0.6 + blink * 0.4})`;
  smallText(ctx, 'CLICK / FIRE TO BEGIN', 188, ctx.fillStyle as string, 11);
}

export function renderDeath(ctx: CanvasRenderingContext2D, time: number, killCount: number, levelName: string) {
  backdrop(ctx, time, 'red');
  // Heavy red wash
  ctx.fillStyle = 'rgba(80,0,0,0.45)';
  ctx.fillRect(0, 0, BUF_W, BUF_H);
  bigText(ctx, 'YOU DIED', 90, '#ff4040', 36);
  smallText(ctx, levelName, 112, '#bbb');
  smallText(ctx, `Kills: ${killCount}`, 128, '#ccc');
  const blink = (Math.sin(time * 4) + 1) / 2;
  ctx.fillStyle = `rgba(255,200,80,${0.5 + blink * 0.5})`;
  smallText(ctx, 'CLICK TO TRY AGAIN', 160, ctx.fillStyle as string, 11);
}

export function renderWin(ctx: CanvasRenderingContext2D, time: number, killCount: number) {
  backdrop(ctx, time, 'green');
  bigText(ctx, 'VICTORY', 80, '#90ff90', 38);
  smallText(ctx, 'You have escaped the foundry.', 110, '#cfeacc');
  smallText(ctx, `Total kills: ${killCount}`, 128, '#cfeacc');
  const blink = (Math.sin(time * 4) + 1) / 2;
  ctx.fillStyle = `rgba(200,255,180,${0.5 + blink * 0.5})`;
  smallText(ctx, 'CLICK FOR TITLE', 160, ctx.fillStyle as string, 11);
}

export function renderPause(ctx: CanvasRenderingContext2D) {
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(0, 0, BUF_W, BUF_H);
  bigText(ctx, 'PAUSED', 70, '#ffd060', 28);
  ctx.font = '9px monospace';
  ctx.fillStyle = '#ddd';
  const lines = [
    'WASD   — move / strafe',
    'MOUSE  — aim',
    'LMB    — fire weapon',
    'E      — open door',
    '1 / 2  — pistol / shotgun',
    'ESC    — release mouse',
  ];
  for (let i = 0; i < lines.length; i++) {
    const w = ctx.measureText(lines[i]!).width;
    ctx.fillText(lines[i]!, (BUF_W - w) / 2, 105 + i * 12);
  }
  ctx.fillStyle = '#aaa';
  const r = 'Click to resume';
  const rw = ctx.measureText(r).width;
  ctx.fillText(r, (BUF_W - rw) / 2, 190);
}

export function renderLevelIntro(ctx: CanvasRenderingContext2D, name: string, fade: number) {
  const alpha = Math.min(1, fade);
  ctx.fillStyle = `rgba(0,0,0,${0.5 * alpha})`;
  ctx.fillRect(0, BUF_H / 2 - 30, BUF_W, 40);
  ctx.font = 'bold 14px monospace';
  ctx.fillStyle = `rgba(255,210,120,${alpha})`;
  const w = ctx.measureText(name).width;
  ctx.fillText(name, (BUF_W - w) / 2, BUF_H / 2 - 6);
  ctx.font = '8px monospace';
  ctx.fillStyle = `rgba(220,200,180,${alpha * 0.8})`;
  const sub = 'Rip and tear';
  const sw = ctx.measureText(sub).width;
  ctx.fillText(sub, (BUF_W - sw) / 2, BUF_H / 2 + 6);
}
