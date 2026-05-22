import type { Page } from 'playwright';

export interface ScenarioResult {
  name: string;
  ok: boolean;
  error?: string;
  durationMs?: number;
  screenshot?: string;
  consoleErrors?: string[];
  details?: Record<string, unknown>;
}

export interface Scenario {
  name: string;
  run(page: Page): Promise<ScenarioResult>;
}

// Helper: poll a predicate against `window.__game` until true or timeout.
async function waitFor<T>(page: Page, fn: () => T, timeoutMs = 4000, intervalMs = 50): Promise<T> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await page.waitForTimeout(intervalMs);
  }
}

async function holdKey(page: Page, key: string, ms: number) {
  await page.keyboard.down(key);
  await page.waitForTimeout(ms);
  await page.keyboard.up(key);
}

// Snapshot of player state read from the page.
async function snap(page: Page) {
  return page.evaluate(() => {
    const g = (window as any).__game;
    return {
      phase: g.phase,
      x: g.player.x, y: g.player.y, angle: g.player.angle,
      health: g.player.health, armor: g.player.armor,
      ammo: { ...g.player.ammo }, weapon: g.player.weapon,
      enemiesAlive: g.active ? g.active.enemies.filter((e: any) => e.state !== 'dying').length : 0,
      pickupsLeft: g.active ? g.active.pickups.filter((p: any) => !p.taken).length : 0,
      levelIndex: g.levelIndex,
      levelName: g.active ? g.active.level.name : null,
    };
  });
}

const boot: Scenario = {
  name: 'boot',
  async run(page) {
    // headless=1 auto-starts; just wait for active level.
    await waitFor(page, () => (window as any).__game?.phase === 'playing');
    const s = await snap(page);
    if (s.phase !== 'playing') return { name: 'boot', ok: false, error: `phase ${s.phase}` };
    return { name: 'boot', ok: true, details: { level: s.levelName } };
  },
};

const movement: Scenario = {
  name: 'movement',
  async run(page) {
    const before = await snap(page);
    await holdKey(page, 'KeyW', 800);
    const after = await snap(page);
    const dx = after.x - before.x, dy = after.y - before.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) return { name: 'movement', ok: false, error: `moved only ${dist.toFixed(3)} cells` };
    return { name: 'movement', ok: true, details: { dist } };
  },
};

const turning: Scenario = {
  name: 'turning',
  async run(page) {
    const before = await snap(page);
    await holdKey(page, 'ArrowRight', 500);
    const after = await snap(page);
    const dAngle = after.angle - before.angle;
    if (dAngle <= 0.1) return { name: 'turning', ok: false, error: `dAngle=${dAngle.toFixed(3)}` };
    return { name: 'turning', ok: true, details: { dAngle } };
  },
};

const combat: Scenario = {
  name: 'combat',
  async run(page) {
    // Teleport player next to a known enemy and aim at it; fire until it dies.
    const aimed = await page.evaluate(() => {
      const g = (window as any).__game;
      const a = g.active!;
      const alive = a.enemies.filter((e: any) => e.state !== 'dying');
      if (alive.length === 0) return { ok: false, reason: 'no enemies' };
      const e = alive[0];
      // Place player 1.2 cells away on the same y row.
      g.player.x = e.x - 1.2;
      g.player.y = e.y;
      g.player.angle = 0; // facing +x
      g.player.cooldown = 0;
      g.player.ammo.pistol = 99;
      return { ok: true, targetHealth: e.health, aliveBefore: alive.length };
    });
    if (!aimed.ok) return { name: 'combat', ok: false, error: aimed.reason };

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('KeyF');
      await page.waitForTimeout(400);
      const aliveNow = await page.evaluate(() =>
        (window as any).__game.active.enemies.filter((e: any) => e.state !== 'dying').length,
      );
      if (aliveNow < (aimed as any).aliveBefore) {
        return { name: 'combat', ok: true, details: { shots: i + 1 } };
      }
    }
    const s = await snap(page);
    return { name: 'combat', ok: false, error: `target alive after 10 shots, aliveCount=${s.enemiesAlive}` };
  },
};

const pickup: Scenario = {
  name: 'pickup',
  async run(page) {
    const setup = await page.evaluate(() => {
      const g = (window as any).__game;
      const a = g.active!;
      const p = a.pickups.find((x: any) => !x.taken);
      if (!p) return { ok: false, reason: 'no pickup' };
      // Lower player stats so any pickup can detectably change them.
      g.player.health = 40;
      g.player.armor = 0;
      g.player.ammo.pistol = 5;
      g.player.ammo.shotgun = 0;
      g.player.x = p.x - 0.2;
      g.player.y = p.y;
      const before = { health: g.player.health, armor: g.player.armor, ammo: { ...g.player.ammo } };
      return { ok: true, kind: p.kind, before, pickupsBefore: a.pickups.filter((x: any) => !x.taken).length };
    });
    if (!setup.ok) return { name: 'pickup', ok: false, error: setup.reason };

    // Step a tiny bit forward to trigger the radius check.
    await holdKey(page, 'KeyW', 150);

    const after = await snap(page);
    const kind = (setup as any).kind as string;
    const before = (setup as any).before as { health: number; armor: number; ammo: { pistol: number; shotgun: number } };
    const pickupsBefore = (setup as any).pickupsBefore as number;
    if (after.pickupsLeft >= pickupsBefore) {
      return { name: 'pickup', ok: false, error: `pickup not consumed (kind=${kind}, before=${pickupsBefore}, after=${after.pickupsLeft})` };
    }
    let changed = false;
    if (kind === 'health' && after.health > before.health) changed = true;
    if (kind === 'armor' && after.armor > before.armor) changed = true;
    if (kind === 'pistol_ammo' && after.ammo.pistol > before.ammo.pistol) changed = true;
    if (kind === 'shotgun_ammo' && after.ammo.shotgun > before.ammo.shotgun) changed = true;
    if (!changed) return { name: 'pickup', ok: false, error: `stats unchanged for ${kind}` };
    return { name: 'pickup', ok: true, details: { kind } };
  },
};

const door: Scenario = {
  name: 'door',
  async run(page) {
    const setup = await page.evaluate(() => {
      const g = (window as any).__game;
      const a = g.active!;
      // Find a door tile in the grid.
      const tiles = a.level.data.tiles as number[];
      const w = a.level.width;
      let idx = tiles.findIndex((t: number) => t === 9);
      if (idx < 0) return { ok: false, reason: 'no door in this level' };
      const dx = idx % w, dy = Math.floor(idx / w);
      // Park player one cell away from the door.
      g.player.x = dx + 0.5;
      g.player.y = dy + 1.5;
      const blockingBefore = a.doors.isBlocking(dx, dy);
      return { ok: true, dx, dy, blockingBefore };
    });
    if (!setup.ok) return { name: 'door', ok: false, error: setup.reason };

    await page.keyboard.press('KeyE');
    await page.waitForTimeout(1200); // wait for door to finish opening (0.6s)

    const blockingAfter = await page.evaluate(({ dx, dy }: { dx: number; dy: number }) => {
      const g = (window as any).__game;
      return g.active.doors.isBlocking(dx, dy);
    }, { dx: (setup as any).dx as number, dy: (setup as any).dy as number });
    if (blockingAfter) return { name: 'door', ok: false, error: 'door still blocking after open' };
    return { name: 'door', ok: true };
  },
};

const exit: Scenario = {
  name: 'exit',
  async run(page) {
    const setup = await page.evaluate(() => {
      const g = (window as any).__game;
      const a = g.active!;
      const tiles = a.level.data.tiles as number[];
      const w = a.level.width;
      const idx = tiles.findIndex((t: number) => t === 100);
      if (idx < 0) return { ok: false, reason: 'no exit pad' };
      const ex = idx % w, ey = Math.floor(idx / w);
      g.player.x = ex + 0.5;
      g.player.y = ey + 0.5;
      return { ok: true, levelBefore: g.levelIndex };
    });
    if (!setup.ok) return { name: 'exit', ok: false, error: setup.reason };
    // Need a tick to fire the exit trigger.
    await page.waitForTimeout(200);
    const s = await snap(page);
    if (s.levelIndex === (setup as any).levelBefore) {
      return { name: 'exit', ok: false, error: `still on level ${s.levelIndex}` };
    }
    return { name: 'exit', ok: true, details: { newLevel: s.levelName } };
  },
};

const death: Scenario = {
  name: 'death',
  async run(page) {
    await page.evaluate(() => {
      const g = (window as any).__game;
      g.player.health = 5;
    });
    // Wait long enough for an enemy to attack (or just zero-out)
    await page.evaluate(() => { (window as any).__game.player.health = 0; });
    await page.waitForTimeout(120);
    const s = await snap(page);
    if (s.phase !== 'dead') return { name: 'death', ok: false, error: `phase=${s.phase}` };
    return { name: 'death', ok: true };
  },
};

const fps: Scenario = {
  name: 'fps',
  async run(page) {
    // Use a string-form evaluate to avoid tsx/swc helper injection.
    const fps = await page.evaluate<number>(`new Promise((resolve) => {
      let frames = 0;
      const start = performance.now();
      const tick = () => {
        frames++;
        if (performance.now() - start >= 1000) resolve(frames);
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })`);
    if (fps < 30) return { name: 'fps', ok: false, error: `${fps} fps` };
    return { name: 'fps', ok: true, details: { fps } };
  },
};

export const scenarios: Scenario[] = [
  boot,
  movement,
  turning,
  combat,
  pickup,
  door,
  exit,
  death,
  fps,
];
