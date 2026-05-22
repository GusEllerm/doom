import type { ActiveLevel } from '../game/state';
import type { Player } from '../entities/player';
import { BUF_W, BUF_H } from './raycaster';
import { spriteCameraTransform } from './sprites';

export interface DebugState {
  enabled: boolean;
  lastShot: { ox: number; oy: number; dx: number; dy: number; t: number; hit: boolean } | null;
  frameTimes: number[]; // ring of recent frame ms
}

export const debug: DebugState = {
  enabled: false,
  lastShot: null,
  frameTimes: [],
};

export function recordFrame(ms: number) {
  debug.frameTimes.push(ms);
  if (debug.frameTimes.length > 120) debug.frameTimes.shift();
}

export function renderDebug(
  ctx: CanvasRenderingContext2D,
  a: ActiveLevel,
  player: Player,
  depth: Float32Array,
  fov: number,
) {
  if (!debug.enabled) return;
  renderMinimap(ctx, a, player);
  renderHitboxes(ctx, a, player, depth, fov);
  renderShotRay(ctx, player);
  renderFrameGraph(ctx);
}

function renderMinimap(ctx: CanvasRenderingContext2D, a: ActiveLevel, player: Player) {
  const cell = 4;
  const w = a.level.width * cell, h = a.level.height * cell;
  const ox = BUF_W - w - 4, oy = 4;
  // background
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(ox - 2, oy - 2, w + 4, h + 4);
  for (let y = 0; y < a.level.height; y++) {
    for (let x = 0; x < a.level.width; x++) {
      const t = a.level.tileAt(x, y);
      if (t === 0) continue;
      if (t === 100) ctx.fillStyle = '#0f0';
      else if (t === 9) ctx.fillStyle = a.doors.isBlocking(x, y) ? '#fa0' : '#440';
      else if (t === 2) ctx.fillStyle = '#88a';
      else ctx.fillStyle = '#a85';
      ctx.fillRect(ox + x * cell, oy + y * cell, cell, cell);
    }
  }
  // enemies
  for (const e of a.enemies) {
    ctx.fillStyle = e.state === 'dying' ? '#444'
      : e.state === 'attack' ? '#f44'
      : e.state === 'chase' ? '#f80'
      : '#888';
    ctx.fillRect(ox + e.x * cell - 1, oy + e.y * cell - 1, 3, 3);
  }
  // pickups
  ctx.fillStyle = '#0ff';
  for (const p of a.pickups) if (!p.taken) {
    ctx.fillRect(ox + p.x * cell - 1, oy + p.y * cell - 1, 2, 2);
  }
  // player + facing
  const px = ox + player.x * cell, py = oy + player.y * cell;
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(px, py);
  ctx.lineTo(px + Math.cos(player.angle) * 8, py + Math.sin(player.angle) * 8);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(px - 1, py - 1, 3, 3);
}

function renderHitboxes(
  ctx: CanvasRenderingContext2D,
  a: ActiveLevel,
  player: Player,
  depth: Float32Array,
  fov: number,
) {
  const planeLen = Math.tan(fov / 2);
  ctx.lineWidth = 1;
  for (const e of a.enemies) {
    if (e.state === 'dying') continue;
    const cam = spriteCameraTransform(e.x, e.y, player.x, player.y, player.angle);
    if (cam.z <= 0.1) continue;
    const screenX = (BUF_W / 2) * (1 + (cam.x / planeLen) / cam.z);
    const size = BUF_H / cam.z;
    // hit-radius circle on screen
    const radiusPx = 0.35 * size;
    ctx.strokeStyle = e.state === 'attack' ? '#f33' : e.state === 'chase' ? '#fa0' : '#0f0';
    if (Math.floor(screenX) >= 0 && Math.floor(screenX) < BUF_W) {
      const occluded = cam.z > depth[Math.floor(screenX)]!;
      ctx.globalAlpha = occluded ? 0.3 : 0.85;
    }
    ctx.beginPath();
    ctx.arc(screenX, BUF_H / 2, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = '8px monospace';
    ctx.fillText(`${e.kind} ${e.health|0}hp`, screenX - 20, BUF_H / 2 - radiusPx - 4);
  }
}

function renderShotRay(ctx: CanvasRenderingContext2D, _player: Player) {
  if (!debug.lastShot) return;
  const age = performance.now() / 1000 - debug.lastShot.t;
  if (age > 1.2) return;
  const alpha = 1 - age / 1.2;
  ctx.fillStyle = `rgba(${debug.lastShot.hit ? '255,80,80' : '255,255,80'},${alpha})`;
  ctx.fillRect(BUF_W / 2 - 1, BUF_H / 2 - 1, 2, 2);
}

function renderFrameGraph(ctx: CanvasRenderingContext2D) {
  const w = 100, h = 30;
  const ox = 4, oy = BUF_H - 28 - h - 4;
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(ox, oy, w, h);
  ctx.fillStyle = '#444';
  ctx.fillRect(ox, oy + h - h * 16.6 / 33, w, 1); // 60fps reference line
  for (let i = 0; i < debug.frameTimes.length; i++) {
    const ms = debug.frameTimes[i]!;
    const x = ox + i * (w / 120);
    const barH = Math.min(h, h * ms / 33);
    ctx.fillStyle = ms > 22 ? '#f33' : ms > 18 ? '#fa0' : '#0f0';
    ctx.fillRect(x, oy + h - barH, w / 120 + 0.5, barH);
  }
  ctx.fillStyle = '#0f0';
  ctx.font = '7px monospace';
  ctx.fillText('frame ms', ox + 2, oy + 8);
}
