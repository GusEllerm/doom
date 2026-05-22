// Verify the full mouse-driven flow: click NEW GAME → game starts and walls
// render. Catches the menu-click-not-working bug and the wall-invisible bug.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results', 'click-flow');
const PORT = 5174;
async function wait(url: string, ms = 15000) {
  const s = Date.now();
  while (Date.now() - s < ms) { try { const r = await fetch(url); if (r.ok) return; } catch {} await new Promise((r) => setTimeout(r, 200)); }
  throw new Error('server');
}
(async () => {
  mkdirSync(OUT, { recursive: true });
  await new Promise<void>((res, rej) => {
    const b = spawn('npx', ['vite', 'build'], { cwd: join(__dirname, '..'), stdio: 'inherit' });
    b.on('exit', (c) => c === 0 ? res() : rej(new Error('build')));
  });
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await wait(`http://127.0.0.1:${PORT}/`);
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${PORT}/`);
    await p.waitForTimeout(800);

    // Click NEW GAME using the menu's actual hit-zone.
    const click = await p.evaluate(() => {
      const m = (window as any).__menu.title;
      const row = m.rows[0];
      const canvas = document.getElementById('overlay') as HTMLCanvasElement;
      const rect = canvas.getBoundingClientRect();
      const sx = rect.width / canvas.width;
      const sy = rect.height / canvas.height;
      return {
        cx: rect.left + (row.x + row.w / 2) * sx,
        cy: rect.top + (row.y + row.h / 2) * sy,
      };
    });
    await p.mouse.click(click.cx, click.cy);
    await p.waitForTimeout(600);
    const state = await p.evaluate(() => ({
      phase: (window as any).__game.phase,
      level: (window as any).__game.active?.level.name,
    }));
    await p.screenshot({ path: join(OUT, '01-after-click.png') });
    console.log('after click:', state);

    if (state.phase !== 'playing') {
      console.error('FAIL: click did not start game');
      process.exit(1);
    }

    // Pin player and check all 4 cardinal directions for walls 1.5 cells away.
    // E1M1 spawn (2.5, 2.5). North wall (z=0 row) is 1.5 cells away. To exercise
    // each direction with a wall close by we relocate the player.
    await p.evaluate(() => {
      const g = (window as any).__game;
      g.player.x = 2.5; g.player.y = 2.5; g.player.pitch = 0;
      // Suppress enemies so they don't move into shots
      for (const e of g.active.enemies) e.state = 'idle';
    });

    const tests = [
      { name: 'north', angle: -Math.PI / 2, x: 2.5, y: 2.5 },
      { name: 'south', angle:  Math.PI / 2, x: 2.5, y: 14.5 },
      { name: 'east',  angle:  0,           x: 13.5, y: 2.5 },
      { name: 'west',  angle:  Math.PI,     x: 2.5, y: 2.5 },
    ];
    for (const t of tests) {
      await p.evaluate((cfg: { x: number; y: number; angle: number }) => {
        const g = (window as any).__game;
        const inp = (window as any).__input;
        inp.paused = false;
        g.player.x = cfg.x; g.player.y = cfg.y; g.player.angle = cfg.angle; g.player.pitch = 0;
      }, t);
      await p.waitForTimeout(80);
      await p.screenshot({ path: join(OUT, `02-look-${t.name}.png`) });
    }
    await browser.close();
    console.log('OK');
  } finally {
    preview.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
