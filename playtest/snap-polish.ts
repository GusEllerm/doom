import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results', 'polish');
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

    // Title (no auto-start)
    const t = await ctx.newPage();
    await t.goto(`http://127.0.0.1:${PORT}/`);
    await t.waitForTimeout(800);
    await t.screenshot({ path: join(OUT, '01-title.png') });
    // Title with second item selected
    await t.keyboard.press('ArrowDown');
    await t.waitForTimeout(200);
    await t.screenshot({ path: join(OUT, '02-title-selected2.png') });

    // In-game
    const g = await ctx.newPage();
    await g.goto(`http://127.0.0.1:${PORT}/?headless=1`);
    await g.waitForFunction(() => !!(window as any).__game?.active);
    await g.waitForTimeout(400);
    await g.screenshot({ path: join(OUT, '03-spawn.png') });

    // Engage an enemy
    await g.evaluate(() => {
      const game = (window as any).__game;
      const e = game.active.enemies[0];
      game.player.x = e.x - 2.6; game.player.y = e.y; game.player.angle = 0;
    });
    await g.waitForTimeout(150);
    await g.keyboard.press('KeyF');
    await g.waitForTimeout(80);
    await g.screenshot({ path: join(OUT, '04-combat-hit.png') });

    // Pickup feed
    await g.evaluate(() => {
      const game = (window as any).__game;
      game.player.health = 35; game.player.ammo.pistol = 5;
      const p = game.active.pickups.find((x: any) => !x.taken);
      game.player.x = p.x - 0.1; game.player.y = p.y;
    });
    await g.waitForTimeout(150);
    await g.keyboard.down('KeyW'); await g.waitForTimeout(150); await g.keyboard.up('KeyW');
    await g.waitForTimeout(50);
    await g.screenshot({ path: join(OUT, '05-pickup.png') });

    // Pause menu (simulate by setting input.paused = true).
    // Headless mode doesn't release pointer lock, so we mimic via the input flag.
    await g.evaluate(() => { (window as any).__input.paused = true; });
    await g.waitForTimeout(200);
    await g.screenshot({ path: join(OUT, '06-pause.png') });
    // Navigate to RESTART
    await g.keyboard.press('ArrowDown');
    await g.waitForTimeout(200);
    await g.screenshot({ path: join(OUT, '07-pause-restart.png') });
    await g.evaluate(() => { (window as any).__input.paused = false; });

    // Death screen
    await g.evaluate(() => { (window as any).__game.player.health = 0; });
    await g.waitForTimeout(250);
    await g.screenshot({ path: join(OUT, '08-death.png') });

    // Win screen — fake by setting phase win
    await g.evaluate(() => {
      const game = (window as any).__game;
      game.phase = 'win';
    });
    await g.waitForTimeout(250);
    await g.screenshot({ path: join(OUT, '09-win.png') });

    await browser.close();
    console.log('snapshots in', OUT);
  } finally {
    preview.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
