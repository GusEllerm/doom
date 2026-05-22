import { startLoop } from './engine/loop';
import { Input } from './engine/input';
import { Player } from './entities/player';
import { Enemy } from './entities/enemy';
import { devLevel } from './world/devLevel';
import { renderWalls, BUF_W, BUF_H } from './render/raycaster';
import { renderSprites } from './render/sprites';
import { renderHUD } from './render/hud';
import { renderViewmodel } from './render/viewmodel';
import { loadAssets } from './engine/assets';
import { manifest, tileTextureKey } from './assets/manifest';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
canvas.width = BUF_W;
canvas.height = BUF_H;
ctx.imageSmoothingEnabled = false;

const assets = loadAssets(manifest);
const input = new Input();
input.install(canvas);
const player = new Player(1.5, 1.5, 0);
const depth = new Float32Array(BUF_W);

const enemies: Enemy[] = [
  new Enemy(5.5, 5.5, 'imp', { onPlayerHit: (d) => player.takeDamage(d) }),
  new Enemy(8.5, 2.5, 'grunt', { onPlayerHit: (d) => player.takeDamage(d) }),
];

const textureFor = (tile: number) => assets.texture(tileTextureKey[tile] ?? 'brick');

let frames = 0, fps = 0, fpsAcc = 0;
let time = 0;
let damageFlash = 0;
let prevHealth = player.health;

startLoop(
  (dt) => {
    time += dt;
    if (input.paused) return;
    const snap = input.snapshot();
    player.update(dt, snap, devLevel, enemies);
    for (const e of enemies) e.update(dt, devLevel, player);
    for (let i = enemies.length - 1; i >= 0; i--) {
      if (enemies[i]!.dead) enemies.splice(i, 1);
    }
    if (player.health < prevHealth) damageFlash = 1.0;
    prevHealth = player.health;
    damageFlash = Math.max(0, damageFlash - dt * 2);
  },
  () => {
    renderWalls(ctx, devLevel, player.x, player.y, player.angle, { depth, textureFor });
    const sprites = enemies.map((e) => ({ x: e.x, y: e.y, img: assets.sprite(e.spriteKey) }));
    renderSprites(ctx, sprites, player.x, player.y, player.angle, depth);
    renderViewmodel(ctx, player, time, assets);
    renderHUD(ctx, player, damageFlash);
    if (input.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, BUF_W, BUF_H);
      ctx.fillStyle = '#fff';
      ctx.font = '12px monospace';
      ctx.fillText('Click to play', 124, 100);
    }
    ctx.fillStyle = '#0f0';
    ctx.font = '10px monospace';
    ctx.fillText(`FPS ${fps}`, 4, 12);
    frames++;
    fpsAcc += 1 / 60;
    if (fpsAcc >= 1) { fps = frames; frames = 0; fpsAcc = 0; }
  },
);
