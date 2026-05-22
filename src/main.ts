import { startLoop } from './engine/loop';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const BUF_W = 320, BUF_H = 200;
canvas.width = BUF_W;
canvas.height = BUF_H;
ctx.imageSmoothingEnabled = false;

let frames = 0, fps = 0, fpsTimer = 0;

startLoop(
  (_dt) => {
    // sim
  },
  (_alpha) => {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, BUF_W, BUF_H);
    ctx.fillStyle = '#0f0';
    ctx.font = '12px monospace';
    ctx.fillText(`FPS ${fps}`, 4, 14);
    frames++;
    fpsTimer += 1 / 60;
    if (fpsTimer >= 1) {
      fps = frames;
      frames = 0;
      fpsTimer = 0;
    }
  },
);
