// Quick: park player in front of a door, open it, snapshot three frames
// of the opening animation.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results', 'door');
const PORT = 5174;

async function waitForServer(url: string, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
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
    await waitForServer(`http://127.0.0.1:${PORT}/`);
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PORT}/?headless=1`);
    await page.waitForFunction(() => !!(window as any).__game?.active);
    // Park in front of door at (7,2)
    await page.evaluate(() => {
      const g = (window as any).__game;
      g.player.x = 7.5; g.player.y = 3.7; g.player.angle = -Math.PI / 2;
    });
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(OUT, '0-closed.png') });

    await page.keyboard.press('KeyE');
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT, '1-opening-25.png') });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT, '2-opening-50.png') });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT, '3-opening-75.png') });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(OUT, '4-open.png') });
    await browser.close();
    console.log('done');
  } finally {
    preview.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
