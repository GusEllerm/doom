/**
 * Platform entry point: draws the deterministic placeholder into the
 * 320x200 canvas. The simulation itself arrives in later milestones.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { installDebugApi } from './debug';
import { placeholderPixel, RENDER_HEIGHT, RENDER_WIDTH } from './placeholder';

const canvas = document.getElementById('game');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('missing <canvas id="game">');
}
const maybeCtx = canvas.getContext('2d');
if (maybeCtx === null) {
  throw new Error('2D canvas context unavailable');
}
const ctx: CanvasRenderingContext2D = maybeCtx;
if (canvas.width !== RENDER_WIDTH || canvas.height !== RENDER_HEIGHT) {
  throw new Error('canvas must be 320x200');
}

const frame = ctx.createImageData(RENDER_WIDTH, RENDER_HEIGHT);
const data = frame.data;
for (let i = 3; i < data.length; i += 4) {
  data[i] = 255; // alpha
}

let tick = 0;

function draw(): void {
  for (let y = 0; y < RENDER_HEIGHT; y++) {
    for (let x = 0; x < RENDER_WIDTH; x++) {
      const [r, g, b] = placeholderPixel(x, y, tick);
      const i = (y * RENDER_WIDTH + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
    }
  }
  ctx.putImageData(frame, 0, 0);
  tick = (tick + 1) % 256;
}

function loop(): void {
  requestAnimationFrame(loop);
}

installDebugApi();
// Paint synchronously so the canvas is never blank, even before the first
// animation frame (headless browsers can delay rAF).
draw();
requestAnimationFrame(loop);
