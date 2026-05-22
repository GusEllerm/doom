import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results', 'three-d');
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
    await p.screenshot({ path: join(OUT, '01-title.png') });

    const g = await ctx.newPage();
    await g.goto(`http://127.0.0.1:${PORT}/?headless=1`);
    await g.waitForFunction(() => !!(window as any).__game?.active);
    await g.waitForTimeout(500);
    await g.screenshot({ path: join(OUT, '02-spawn.png') });

    // Walk forward a bit
    await g.keyboard.down('KeyW'); await g.waitForTimeout(600); await g.keyboard.up('KeyW');
    await g.screenshot({ path: join(OUT, '03-walked.png') });

    // Look at an enemy from medium range
    await g.evaluate(() => {
      const game = (window as any).__game;
      const e = game.active.enemies[0];
      game.player.x = e.x - 4; game.player.y = e.y; game.player.angle = 0; game.player.pitch = 0;
    });
    await g.waitForTimeout(200);
    await g.screenshot({ path: join(OUT, '04-enemy-range.png') });

    // Look up
    await g.evaluate(() => { (window as any).__game.player.pitch = -0.4; });
    await g.waitForTimeout(150);
    await g.screenshot({ path: join(OUT, '05-look-up.png') });

    // Look down
    await g.evaluate(() => { (window as any).__game.player.pitch = 0.4; });
    await g.waitForTimeout(150);
    await g.screenshot({ path: join(OUT, '06-look-down.png') });

    // Pause
    await g.evaluate(() => { (window as any).__input.paused = true; });
    await g.waitForTimeout(150);
    await g.screenshot({ path: join(OUT, '07-pause.png') });

    await browser.close();
    console.log('done');
  } finally {
    preview.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
