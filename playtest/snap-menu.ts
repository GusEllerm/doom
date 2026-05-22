import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results', 'menu');
const PORT = 5174;
async function wait(url: string, ms = 15000) {
  const s = Date.now();
  while (Date.now() - s < ms) {
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
    await wait(`http://127.0.0.1:${PORT}/`);
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    const p = await ctx.newPage();
    await p.goto(`http://127.0.0.1:${PORT}/`);
    await p.waitForTimeout(800);
    await p.screenshot({ path: join(OUT, '01-title.png') });
    async function tap(key: string) {
      await p.keyboard.down(key);
      await p.waitForTimeout(80);
      await p.keyboard.up(key);
      await p.waitForTimeout(80);
    }
    // Navigate down to CONTROLS
    await tap('ArrowDown');
    await p.screenshot({ path: join(OUT, '02-controls-selected.png') });
    // Confirm to open controls overlay
    await tap('Enter');
    await p.screenshot({ path: join(OUT, '03-controls-panel.png') });
    // Esc to close
    await tap('Escape');
    await p.screenshot({ path: join(OUT, '04-back-to-title.png') });
    await browser.close();
    console.log('ok');
  } finally {
    preview.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
