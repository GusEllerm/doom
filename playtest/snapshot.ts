// One-off: open the game, snapshot a few representative scenes so I can
// visually inspect changes. Writes PNGs to playtest/results/snapshots/.
//
// Run: npx tsx playtest/snapshot.ts

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results', 'snapshots');
const PORT = 5174;

async function waitForServer(url: string, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server failed');
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const b = spawn('npx', ['vite', 'build'], { cwd: join(__dirname, '..'), stdio: 'inherit' });
    b.on('exit', (c) => c === 0 ? resolve() : reject(new Error('build')));
  });
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`);
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 800, height: 500 }, deviceScaleFactor: 2 });

    // Title screen
    const titlePage = await ctx.newPage();
    await titlePage.goto(`http://127.0.0.1:${PORT}/`);
    await titlePage.waitForTimeout(800);
    await titlePage.screenshot({ path: join(OUT, 'title.png') });

    // In-level shots
    const gamePage = await ctx.newPage();
    await gamePage.goto(`http://127.0.0.1:${PORT}/?headless=1`);
    await gamePage.waitForFunction(() => !!(window as any).__game?.active);
    await gamePage.waitForTimeout(500);
    await gamePage.screenshot({ path: join(OUT, 'level-spawn.png') });

    // Look at an enemy
    await gamePage.evaluate(() => {
      const g = (window as any).__game;
      const e = g.active.enemies[0];
      g.player.x = e.x - 2.5; g.player.y = e.y; g.player.angle = 0;
    });
    await gamePage.waitForTimeout(400);
    await gamePage.screenshot({ path: join(OUT, 'level-enemy.png') });

    // Fire a shot for muzzle flash
    await gamePage.keyboard.press('KeyF');
    await gamePage.waitForTimeout(80);
    await gamePage.screenshot({ path: join(OUT, 'level-fire.png') });

    // Pickup feed sample: trigger a pickup
    await gamePage.evaluate(() => {
      const g = (window as any).__game;
      const p = g.active.pickups.find((x: any) => !x.taken);
      g.player.health = 30; g.player.armor = 0;
      g.player.ammo.pistol = 8; g.player.ammo.shotgun = 0;
      g.player.x = p.x - 0.1; g.player.y = p.y;
    });
    await gamePage.waitForTimeout(150);
    await gamePage.keyboard.down('KeyW');
    await gamePage.waitForTimeout(180);
    await gamePage.keyboard.up('KeyW');
    await gamePage.screenshot({ path: join(OUT, 'pickup-feed.png') });

    // Death screen
    await gamePage.evaluate(() => { (window as any).__game.player.health = 0; });
    await gamePage.waitForTimeout(200);
    await gamePage.screenshot({ path: join(OUT, 'death.png') });

    await browser.close();
    console.log('Snapshots written to', OUT);
  } finally {
    preview.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
