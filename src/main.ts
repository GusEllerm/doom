import { startLoop } from './engine/loop';
import { Input } from './engine/input';
import { renderWalls, BUF_W, BUF_H } from './render/raycaster';
import { renderSprites } from './render/sprites';
import { renderHUD } from './render/hud';
import { renderViewmodel } from './render/viewmodel';
import { loadAssets } from './engine/assets';
import { manifest, tileTextureKey } from './assets/manifest';
import { Game } from './game/state';
import { LEVELS } from './world/levels';
import { updatePickups } from './world/triggers';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
canvas.width = BUF_W;
canvas.height = BUF_H;
ctx.imageSmoothingEnabled = false;

const assets = loadAssets(manifest);
const input = new Input();
input.install(canvas);
const game = new Game(LEVELS);
game.start();

const depth = new Float32Array(BUF_W);
const textureFor = (tile: number) => assets.texture(tileTextureKey[tile] ?? 'brick');

let frames = 0, fps = 0, fpsAcc = 0;

function isSolidForRaycast(_x: number, _y: number, tile: number): boolean {
  if (tile === 0) return false;
  if (tile === 9) return game.active ? game.active.doors.isBlocking(_x, _y) : true;
  if (tile >= 100) return false;
  return true;
}

startLoop(
  (dt) => {
    game.time += dt;
    if (input.paused) return;
    const snap = input.snapshot();

    if (game.phase === 'title') {
      if (snap.fire) game.start();
      return;
    }
    if (game.phase === 'dead') {
      if (snap.fire) game.restart();
      return;
    }
    if (game.phase === 'win') {
      if (snap.fire) game.toTitle();
      return;
    }

    const a = game.active!;
    game.player.update(dt, snap, a.level, a.enemies, a.doors);
    for (const e of a.enemies) e.update(dt, a.level, game.player, a.doors);
    for (let i = a.enemies.length - 1; i >= 0; i--) {
      if (a.enemies[i]!.dead) a.enemies.splice(i, 1);
    }
    updatePickups(a.pickups, game.player);
    a.doors.update(dt);

    // Exit trigger
    const exitTile = a.level.tileAt(game.player.x, game.player.y);
    if (exitTile === 100) game.advanceLevel();

    if (game.player.health < game.prevHealth) game.damageFlash = 1.0;
    game.prevHealth = game.player.health;
    game.damageFlash = Math.max(0, game.damageFlash - dt * 2);

    if (game.player.health <= 0) game.phase = 'dead';
  },
  () => {
    if (game.phase === 'title') {
      drawCenteredScreen('DOOM', 'Click to start', '#f44');
    } else if (game.phase === 'win') {
      drawCenteredScreen('YOU WIN', 'Click to return to title', '#4f4');
    } else if (!game.active) {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, BUF_W, BUF_H);
    } else {
      const a = game.active;
      renderWalls(ctx, a.level, game.player.x, game.player.y, game.player.angle, {
        depth, textureFor, isSolid: isSolidForRaycast,
      });
      const sprites = [
        ...a.enemies.map((e) => ({ x: e.x, y: e.y, img: assets.sprite(e.spriteKey) })),
        ...a.pickups.filter((p) => !p.taken).map((p) => ({ x: p.x, y: p.y, img: assets.sprite(p.spriteKey), vOffset: 0.25 })),
      ];
      renderSprites(ctx, sprites, game.player.x, game.player.y, game.player.angle, depth);
      renderViewmodel(ctx, game.player, game.time, assets);
      renderHUD(ctx, game.player, game.damageFlash);

      if (game.phase === 'dead') {
        ctx.fillStyle = 'rgba(60,0,0,0.7)';
        ctx.fillRect(0, 0, BUF_W, BUF_H);
        ctx.fillStyle = '#fff'; ctx.font = '20px monospace';
        ctx.fillText('YOU DIED', BUF_W / 2 - 50, BUF_H / 2 - 8);
        ctx.font = '10px monospace';
        ctx.fillText('Click to restart level', BUF_W / 2 - 60, BUF_H / 2 + 10);
      } else if (input.paused) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, 0, BUF_W, BUF_H);
        ctx.fillStyle = '#fff'; ctx.font = '12px monospace';
        ctx.fillText('Click to play', 124, 100);
      }
    }

    ctx.fillStyle = '#0f0';
    ctx.font = '10px monospace';
    ctx.fillText(`FPS ${fps}`, 4, 12);
    frames++;
    fpsAcc += 1 / 60;
    if (fpsAcc >= 1) { fps = frames; frames = 0; fpsAcc = 0; }
  },
);

function drawCenteredScreen(title: string, sub: string, color: string) {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, BUF_W, BUF_H);
  ctx.fillStyle = color; ctx.font = 'bold 28px monospace';
  const tw = ctx.measureText(title).width;
  ctx.fillText(title, (BUF_W - tw) / 2, BUF_H / 2 - 8);
  ctx.fillStyle = '#aaa'; ctx.font = '10px monospace';
  const sw = ctx.measureText(sub).width;
  ctx.fillText(sub, (BUF_W - sw) / 2, BUF_H / 2 + 14);
}
