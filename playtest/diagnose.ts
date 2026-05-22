// Diagnostic playthrough: launches the game in headless Chromium, runs a
// scripted bot that wanders, shoots, opens doors, and tries to advance
// through levels. Dumps the full event log + derived metrics + screenshots
// of representative moments to playtest/results/diagnostic/.
//
// Run: npx tsx playtest/diagnose.ts
//
// What to look at:
//  - results/diagnostic/metrics.json    — summary numbers
//  - results/diagnostic/events.json     — full event log
//  - results/diagnostic/issues.json     — derived warnings (stuck enemies, etc.)
//  - results/diagnostic/screenshots/    — moment-in-time snapshots
//
// The bot intentionally does dumb things (random turns, idle pauses) so we
// see the game's reaction to "imperfect" input — the kind of thing a player
// might do.

import { chromium, type Page } from 'playwright';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, 'results', 'diagnostic');
const SHOTS = join(OUT, 'screenshots');
const PORT = 5174;

async function waitForServer(url: string, timeoutMs = 15_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return; } catch { /* */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server ${url} did not start`);
}

async function build(cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const b = spawn('npx', ['vite', 'build'], { cwd, stdio: 'inherit' });
    b.on('exit', (c) => c === 0 ? resolve() : reject(new Error(`build ${c}`)));
  });
}

function startPreview(cwd: string): ChildProcess {
  return spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// Read structured state from the page.
async function inspect(page: Page) {
  return page.evaluate(() => {
    const g = (window as any).__game;
    const a = g.active;
    return a ? {
      phase: g.phase as string,
      level: a.level.name as string,
      levelIndex: g.levelIndex as number,
      x: g.player.x, y: g.player.y, angle: g.player.angle,
      health: g.player.health,
      ammo: { ...g.player.ammo },
      weapon: g.player.weapon,
      enemiesAlive: a.enemies.filter((e: any) => e.state !== 'dying').length,
      pickupsLeft: a.pickups.filter((p: any) => !p.taken).length,
    } : { phase: g.phase as string };
  });
}

async function press(page: Page, key: string, ms = 60) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

(async () => {
  mkdirSync(SHOTS, { recursive: true });
  await build(join(__dirname, '..'));
  const preview = startPreview(join(__dirname, '..'));
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/`);
    const browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 640, height: 400 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    const consoleErrors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));

    await page.goto(`http://127.0.0.1:${PORT}/?headless=1`);
    await page.waitForFunction(() => !!(window as any).__game?.active);
    // Enable debug overlay for screenshots
    await page.evaluate(() => { (window as any).__debug.enabled = true; });
    // Make the bot less fragile: give it solid ammo
    await page.evaluate(() => {
      const g = (window as any).__game;
      g.player.ammo.pistol = 200;
      g.player.ammo.shotgun = 40;
    });

    const moments: { name: string; t: number }[] = [];
    async function snap(name: string) {
      await page.screenshot({ path: join(SHOTS, `${moments.length.toString().padStart(2, '0')}-${name}.png`) });
      moments.push({ name, t: Date.now() });
    }
    await snap('start');

    // The bot has explicit "missions" so its events are meaningful:
    // 1. Aim at and kill the nearest visible enemy.
    // 2. Walk to and open the nearest door.
    // 3. Walk to and step on the nearest pickup.
    // 4. Walk to the exit.
    // Each mission times out so a stuck bot doesn't stall.

    const DURATION_MS = 60_000;
    const tStart = Date.now();

    // Aim helper: turn player to face a world point.
    async function faceTarget(tx: number, ty: number) {
      await page.evaluate(({ tx, ty }: { tx: number; ty: number }) => {
        const g = (window as any).__game;
        const dx = tx - g.player.x, dy = ty - g.player.y;
        g.player.angle = Math.atan2(dy, dx);
      }, { tx, ty });
    }

    // Walk forward briefly, return new position
    async function step(durMs: number) {
      await press(page, 'KeyW', durMs);
    }

    async function missionKillNearest(): Promise<boolean> {
      for (let i = 0; i < 6; i++) {
        const t = await page.evaluate(() => {
          const g = (window as any).__game;
          const a = g.active;
          // Find nearest enemy with line-of-sight (matches what a sensible
          // player would do — don't fire into a wall).
          let best = null as any, bestD = Infinity;
          for (const e of a.enemies) {
            if (e.state === 'dying') continue;
            const dx = e.x - g.player.x, dy = e.y - g.player.y;
            const d = Math.hypot(dx, dy);
            if (d < bestD) {
              // LOS check via raycaster
              const { castRay } = (window as any).__game.player as any;
              void castRay; // satisfy TS, not actually needed
              // Use the level's tile grid directly for a quick LOS test
              const steps = Math.ceil(d * 8);
              let blocked = false;
              for (let s = 1; s < steps; s++) {
                const px = g.player.x + dx * s / steps;
                const py = g.player.y + dy * s / steps;
                if (a.level.isSolid(px, py)) { blocked = true; break; }
              }
              if (blocked) continue;
              bestD = d; best = e;
            }
          }
          if (!best) return null;
          const dx = best.x - g.player.x, dy = best.y - g.player.y;
          g.player.angle = Math.atan2(dy, dx);
          return { kind: best.kind, distance: bestD };
        });
        if (!t) return true; // none in LOS — abandon mission
        await page.keyboard.press('KeyF');
        await page.waitForTimeout(380);
      }
      return false;
    }

    async function missionOpenDoor(): Promise<'opened' | 'no-door' | 'failed'> {
      const door = await page.evaluate(() => {
        const g = (window as any).__game;
        const a = g.active;
        const tiles = a.level.data.tiles as number[];
        const w = a.level.width;
        let best = null as { x: number; y: number; d: number } | null;
        for (let i = 0; i < tiles.length; i++) {
          if (tiles[i] !== 9) continue;
          const x = i % w, y = Math.floor(i / w);
          if (!a.doors.isBlocking(x, y)) continue; // already open
          const d = Math.hypot(x + 0.5 - g.player.x, y + 0.5 - g.player.y);
          if (!best || d < best.d) best = { x, y, d };
        }
        return best;
      });
      if (!door) return 'no-door';
      // Teleport adjacent to the door (south side preferred) so we can hit E.
      await page.evaluate(({ dx, dy }: { dx: number; dy: number }) => {
        const g = (window as any).__game;
        g.player.x = dx + 0.5;
        g.player.y = dy + 1.5;
        g.player.angle = -Math.PI / 2;
      }, { dx: door.x, dy: door.y });
      await snap(`door-closed-${door.x}-${door.y}`);
      await page.keyboard.press('KeyE');
      await page.waitForTimeout(200);
      await snap(`door-opening-${door.x}-${door.y}`);
      await page.waitForTimeout(600);
      await snap(`door-open-${door.x}-${door.y}`);
      const open = await page.evaluate(({ dx, dy }: { dx: number; dy: number }) => {
        return !(window as any).__game.active.doors.isBlocking(dx, dy);
      }, { dx: door.x, dy: door.y });
      return open ? 'opened' : 'failed';
    }

    async function missionGotoExit(): Promise<boolean> {
      const tp = await page.evaluate(() => {
        const g = (window as any).__game;
        const a = g.active;
        const tiles = a.level.data.tiles as number[];
        const w = a.level.width;
        const i = tiles.findIndex((t: number) => t === 100);
        if (i < 0) return null;
        const ex = i % w, ey = Math.floor(i / w);
        // Teleport directly onto exit pad (simulates "successful play through").
        g.player.x = ex + 0.5; g.player.y = ey + 0.5;
        return { ex, ey };
      });
      if (!tp) return false;
      await page.waitForTimeout(150);
      const s = await inspect(page);
      return s.phase === 'playing' && (s.levelIndex ?? 0) > 0 || s.phase === 'win';
    }

    // Run missions in a loop until time runs out or we win.
    let cycle = 0;
    while (Date.now() - tStart < DURATION_MS) {
      const s = await inspect(page);
      if (s.phase === 'win') break;
      if (s.phase === 'dead') {
        await page.mouse.down(); await page.mouse.up();
        await page.waitForTimeout(300);
        await page.evaluate(() => { (window as any).__game.player.health = 100; });
        continue;
      }
      cycle++;

      // 1. Random wander for a bit so non-mission events also fire.
      for (let i = 0; i < 5; i++) {
        await press(page, Math.random() < 0.5 ? 'KeyW' : (Math.random() < 0.5 ? 'KeyA' : 'KeyD'),
          150 + Math.random() * 200);
        await press(page, Math.random() < 0.5 ? 'ArrowLeft' : 'ArrowRight',
          50 + Math.random() * 120);
      }

      // 2. Try to kill the nearest enemy
      await missionKillNearest();

      // 3. Open a door
      await missionOpenDoor();

      // 4. Walk a bit more
      await step(400);

      // 5. Advance levels every 3 cycles
      if (cycle % 3 === 0) await missionGotoExit();

      if (cycle % 2 === 0) await snap(`cycle-${cycle}`);
    }

    await snap('end');

    const metrics = await page.evaluate(() => (window as any).__metrics());
    const events = await page.evaluate(() => (window as any).__events());

    // Derive issue list
    const issues: string[] = [];
    if (metrics.shotAccuracy < 0.3 && metrics.shotsFired > 10) {
      issues.push(`low shot accuracy: ${(metrics.shotAccuracy * 100).toFixed(0)}% over ${metrics.shotsFired} shots`);
    }
    if (metrics.doorOpenSuccessRate < 0.5 && metrics.doorInteractAttempts > 4) {
      issues.push(`low door-open success rate: ${(metrics.doorOpenSuccessRate * 100).toFixed(0)}% of ${metrics.doorInteractAttempts} interacts opened a door`);
    }
    if (metrics.stuckEnemyEvents > 0) {
      issues.push(`${metrics.stuckEnemyEvents} stuck-enemy events recorded`);
    }
    if (metrics.slowFrames > 3) {
      issues.push(`${metrics.slowFrames} slow frames (worst ${metrics.worstFrameMs}ms)`);
    }
    if (metrics.playerOOB > 0) issues.push(`${metrics.playerOOB} out-of-bounds events`);
    if (metrics.levelsCompleted === 0) issues.push('bot did not complete any level');
    if (consoleErrors.length > 0) issues.push(`${consoleErrors.length} console errors: ${consoleErrors.slice(0, 3).join(' | ')}`);

    writeFileSync(join(OUT, 'metrics.json'), JSON.stringify(metrics, null, 2));
    writeFileSync(join(OUT, 'events.json'), JSON.stringify(events, null, 2));
    writeFileSync(join(OUT, 'issues.json'), JSON.stringify({ issues, moments, consoleErrors }, null, 2));

    console.log('\n=== METRICS ===');
    console.log(JSON.stringify(metrics, null, 2));
    console.log('\n=== ISSUES ===');
    if (issues.length === 0) console.log('(none flagged)');
    else for (const i of issues) console.log('  - ' + i);
    console.log(`\nWrote to ${OUT}`);

    await browser.close();
  } finally {
    preview.kill();
  }
})().catch((e) => { console.error(e); process.exit(1); });
