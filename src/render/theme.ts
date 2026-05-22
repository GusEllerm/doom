// Centralized visual identity. Touched by every screen / HUD element so the
// game feels like one game rather than a stack of separately-styled widgets.

export const PALETTE = {
  // Hot reds — used for blood, danger, "DOOM" headline, hit feedback.
  bloodHi: '#ff3030',
  bloodMid: '#c01a1a',
  bloodLo: '#5a0808',
  // Amber — used for ammo, prompts, accents.
  amberHi: '#ffd040',
  amberMid: '#c8941c',
  amberLo: '#5a4010',
  // Sickly green — used for armor, win screen, exit pads.
  bileHi: '#90ff90',
  bileMid: '#3a9a3a',
  bileLo: '#0a3a0a',
  // Cool blue — used for armor in HUD, info text.
  cyanHi: '#40c0ff',
  cyanMid: '#1a72b8',
  // Greys — chrome / panels / borders.
  steelHi: '#7a7280',
  steelMid: '#403a48',
  steelLo: '#1a161e',
  // Background paper / dim text.
  paperHi: '#dcd0c0',
  paperLo: '#776a5a',
  // True black/white.
  ink: '#0a0608',
  bone: '#fff8e8',
};

export interface DrawText {
  size: number;
  color: string;
  shadow?: boolean;
  outline?: boolean;
  weight?: 'bold' | 'normal';
}

export function text(ctx: CanvasRenderingContext2D, str: string, x: number, y: number, opts: DrawText) {
  ctx.font = `${opts.weight ?? 'bold'} ${opts.size}px monospace`;
  if (opts.shadow) {
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillText(str, x + 1, y + 1);
  }
  if (opts.outline) {
    ctx.strokeStyle = PALETTE.ink;
    ctx.lineWidth = Math.max(2, opts.size / 8);
    ctx.lineJoin = 'round';
    ctx.strokeText(str, x, y);
  }
  ctx.fillStyle = opts.color;
  ctx.fillText(str, x, y);
}

export function centeredText(
  ctx: CanvasRenderingContext2D, str: string, cx: number, y: number, opts: DrawText,
) {
  ctx.font = `${opts.weight ?? 'bold'} ${opts.size}px monospace`;
  const w = ctx.measureText(str).width;
  text(ctx, str, cx - w / 2, y, opts);
}

/** Beveled panel: dark interior + light top/left edge + dark bottom/right edge. */
export function bevelPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, '#1c1820');
  g.addColorStop(1, '#0a0608');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = 'rgba(255,210,170,0.10)';
  ctx.fillRect(x, y, w, 1);
  ctx.fillRect(x, y, 1, h);
  ctx.fillStyle = 'rgba(0,0,0,0.7)';
  ctx.fillRect(x, y + h - 1, w, 1);
  ctx.fillRect(x + w - 1, y, 1, h);
}

/** Metallic strip background — for HUD and toolbars. */
export function metallicStrip(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const g = ctx.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0.0, '#231d22');
  g.addColorStop(0.18, '#3a2f36');
  g.addColorStop(0.5, '#1a1418');
  g.addColorStop(1.0, '#070406');
  ctx.fillStyle = g;
  ctx.fillRect(x, y, w, h);
  // Rivets along the edge
  ctx.fillStyle = '#4a3a3e';
  for (let i = x + 6; i < x + w - 6; i += 18) {
    ctx.fillRect(i, y + 2, 2, 2);
    ctx.fillRect(i, y + h - 4, 2, 2);
  }
  // Top highlight
  ctx.fillStyle = 'rgba(255,200,160,0.18)';
  ctx.fillRect(x, y, w, 1);
  ctx.fillStyle = PALETTE.bloodLo;
  ctx.fillRect(x, y + 1, w, 1);
}

/** A small skull glyph drawn from primitives. Decorative bullet. */
export function skullBullet(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PALETTE.ink;
  const e = Math.max(1, size * 0.28);
  ctx.fillRect(x - size * 0.45, y - size * 0.15, e, e);
  ctx.fillRect(x + size * 0.20, y - size * 0.15, e, e);
  ctx.fillRect(x - size * 0.4, y + size * 0.25, size * 0.8, size * 0.18);
}

/** Drifting ember particles — used by atmospheric screens. */
export interface EmberField { particles: { x: number; y: number; vy: number; vx: number; size: number; life: number; }[]; }

export function makeEmbers(count: number, w: number, h: number): EmberField {
  const f: EmberField = { particles: [] };
  for (let i = 0; i < count; i++) {
    f.particles.push({
      x: Math.random() * w,
      y: h + Math.random() * 30,
      vy: -(15 + Math.random() * 25),
      vx: (Math.random() - 0.5) * 6,
      size: 1 + Math.random() * 1.5,
      life: 2 + Math.random() * 3,
    });
  }
  return f;
}

export function updateEmbers(f: EmberField, dt: number, w: number, h: number) {
  for (const p of f.particles) {
    p.y += p.vy * dt;
    p.x += p.vx * dt + Math.sin(p.y * 0.05) * 0.2;
    p.life -= dt;
    if (p.life <= 0 || p.y < -10) {
      p.x = Math.random() * w;
      p.y = h + 5;
      p.vy = -(15 + Math.random() * 25);
      p.vx = (Math.random() - 0.5) * 6;
      p.size = 1 + Math.random() * 1.5;
      p.life = 2 + Math.random() * 3;
    }
  }
}

export function renderEmbers(ctx: CanvasRenderingContext2D, f: EmberField) {
  for (const p of f.particles) {
    const a = Math.max(0, Math.min(1, p.life / 3));
    ctx.fillStyle = `rgba(255,${Math.floor(120 + a * 130)},${Math.floor(40 + a * 40)},${a * 0.9})`;
    ctx.fillRect(p.x | 0, p.y | 0, p.size, p.size);
  }
}
