// Reproduce user-reported "invisible walls" by walking through the real
// title→play flow (not headless), then inspect what's actually drawn and
// whether collision still blocks the player.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results', 'walls');
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
    const errs: string[] = [];
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    p.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });

    await p.goto(`http://127.0.0.1:${PORT}/`);
    await p.waitForTimeout(800);
    await p.screenshot({ path: join(OUT, '01-title.png') });

    // Start game via keyboard (Enter on selected NEW GAME).
    await p.keyboard.down('Enter');
    await p.waitForTimeout(80);
    await p.keyboard.up('Enter');
    await p.waitForTimeout(800);
    await p.screenshot({ path: join(OUT, '02-after-newgame-click.png') });

    // Read state — what does the game think happened?
    const state = await p.evaluate(() => {
      const g = (window as any).__game;
      const a = g.active;
      return {
        phase: g.phase,
        paused: (window as any).__input.paused,
        x: g.player.x, y: g.player.y, angle: g.player.angle, pitch: g.player.pitch,
        level: a?.level.name,
        wallCount: a ? a.level.data.tiles.filter((t: number) => t !== 0).length : null,
        sceneChildren: (() => {
          // Hack: count three.js children to verify the world built.
          const scene = ((window as any).__renderer3d || {}).scene;
          return scene ? scene.children.length : 'no scene exposed';
        })(),
      };
    });
    writeFileSync(join(OUT, 'state.json'), JSON.stringify(state, null, 2));
    console.log('state:', state);
    if (errs.length) console.log('errors:', errs);

    // Force the game into a known position (matches non-headless menu click)
    await p.evaluate(() => {
      const g = (window as any).__game;
      const inp = (window as any).__input;
      // Pretend pointer lock granted
      inp.paused = false;
      inp.wantsPointerLock = true;
      if (g.phase !== 'playing' && g.active === null) {
        // Title still — push directly into game
        g.start();
      }
    });
    await p.waitForTimeout(300);
    await p.screenshot({ path: join(OUT, '03-forced-play.png') });

    // Try to move forward
    const before = await p.evaluate(() => {
      const g = (window as any).__game;
      return { x: g.player.x, y: g.player.y };
    });
    await p.keyboard.down('KeyW'); await p.waitForTimeout(800); await p.keyboard.up('KeyW');
    const after = await p.evaluate(() => {
      const g = (window as any).__game;
      return { x: g.player.x, y: g.player.y };
    });
    console.log('move test: before', before, 'after', after, 'delta', Math.hypot(after.x-before.x, after.y-before.y).toFixed(2));
    await p.screenshot({ path: join(OUT, '04-after-walk.png') });

    // Now slam into a wall direction and see if collision still works.
    await p.evaluate(() => {
      const g = (window as any).__game;
      // Force position 0.5 from west wall, facing west.
      g.player.x = 1.4; g.player.y = 2.5; g.player.angle = Math.PI;
    });
    const wallBefore = await p.evaluate(() => ({ x: (window as any).__game.player.x, y: (window as any).__game.player.y }));
    await p.keyboard.down('KeyW'); await p.waitForTimeout(700); await p.keyboard.up('KeyW');
    const wallAfter = await p.evaluate(() => ({ x: (window as any).__game.player.x, y: (window as any).__game.player.y }));
    console.log('wall test: before', wallBefore, 'after', wallAfter, 'delta x', (wallAfter.x-wallBefore.x).toFixed(3));
    await p.screenshot({ path: join(OUT, '05-vs-wall.png') });

    await browser.close();
    if (errs.length) { console.log('ALL ERRORS:'); errs.forEach((e) => console.log(' ', e)); }
  } finally {
    preview.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
