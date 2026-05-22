import { startLoop } from './engine/loop';
import { Input } from './engine/input';
import { Player } from './entities/player';
import { devLevel } from './world/devLevel';
import { renderWalls, BUF_W, BUF_H } from './render/raycaster';
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

const textureFor = (tile: number) => assets.texture(tileTextureKey[tile] ?? 'brick');

let frames = 0, fps = 0, fpsAcc = 0;

startLoop(
  (dt) => {
    if (input.paused) return;
    const snap = input.snapshot();
    player.update(dt, snap, devLevel);
  },
  () => {
    renderWalls(ctx, devLevel, player.x, player.y, player.angle, { depth, textureFor });
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
