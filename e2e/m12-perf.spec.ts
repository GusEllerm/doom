/**
 * M12-04 browser-side perf gate (docs/design/M12-plan.md §M12-04b) — the
 * REAL rAF loop (no fake clocks): three fixed scenes, 30 s each at the
 * 320×200 render target, timed by the loop itself (main.ts records
 * performance.now deltas around its own stepTic()/render() calls; the
 * sim stays performance/Date-free — A-06) and read back through the ADDITIVE
 * `__doom.state().perf` debug counters. p50/p95 asserted against the SAME
 * pinned constants as the node suite (tests/perf/budget.ts; D-12a pinned
 * after the first honest measure, never tuned-to-pass).
 *
 * Scenes (setup mirrors tests/perf/scenes.ts so node and browser numbers
 * mean the same thing):
 *   e1m1   — baseline: deterministic new-game drain (playstart recipe);
 *   e1m7   — heaviest E1 map: the same drain aimed at gamemap 7;
 *   fire40 — 40 mobjs constructed around the E1M1 spawn via the arena seam
 *            (dynamic import of p_mobj.ts from the DEV server — the same
 *            module instance the loop runs; m11-persist's /src/*.ts URL
 *            precedent), fire held + god mode so the firefight outlives
 *            the pistol ammo.
 *
 * The rAF sanity assertions (frames ≈ 60 Hz, tics ≈ 35 Hz over the window)
 * prove the numbers come from a live loop, not a stalled page. Evidence
 * JSON (window stats + machine class) lands in tests/perf/evidence/
 * browser-results.json under PERF_EVIDENCE=1 only.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import { PERF_BUDGET, PERF_METHOD } from '../tests/perf/budget';
import { percentile } from '../tests/perf/measure';
import { enterPlay } from './playstart';

/** The perf view of state() — the M12-04 additive block (debug.ts widens
 * the §7 snapshot through a cast, same discipline as the M11-10 persist
 * seam, so types/debug.ts stays untouched). */
interface PerfSnapshot {
  map: string;
  leveltime: number;
  gamestate: string;
  perf: {
    tics: number;
    frames: number;
    capacity: number;
    ticMs: number[];
    frameMs: number[];
  };
}

const SCENES = ['e1m7', 'e1m1', 'fire40'] as const;
type Scene = (typeof SCENES)[number];

async function boot(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, {
    timeout: 60_000
  });
}

/** Land a scene on the LIVE loop, returning at GS_LEVEL with the loop
 * running — everything after this call is pure live-window time. */
async function setupScene(page: Page, scene: Scene): Promise<void> {
  await boot(page);
  if (scene === 'e1m7') {
    // The playstart drain aimed at E1M7 (the same M_ChooseSkill fields,
    // map 7; main.ts's B-04 identity guard rebuilds the render world on
    // the first live frame after the level load).
    await page.evaluate(() => {
      const api = window.__doom!;
      api.pause(true);
      const st = api.sim.getState()!;
      st.gametic = 0;
      st.advancedemo = false;
      st.gameskill = 3;
      st.gameepisode = 1;
      st.gamemap = 7;
      st.gameaction = 2; // ga_newgame
      api.sim.runTics(1); // scripted drain → G_InitNew → P_SetupLevel E1M7
      api.popInput();
      api.pause(false);
    });
    await page.waitForFunction(
      () => (window.__doom!.state() as unknown as PerfSnapshot).map === 'E1M7',
      null,
      { timeout: 30_000 }
    );
    return;
  }
  await enterPlay(page); // E1M1, deterministic (1,1) landing, loop live
  if (scene === 'fire40') {
    const census = await page.evaluate(async () => {
      const api = window.__doom!;
      api.pause(true);
      const st = api.sim.getState()!;
      // Arena seam: pSpawnMobj loaded from the DEV server URL — the same
      // module record the main graph already imported (browser ESM cache;
      // m11-persist's /src/persist/settings.ts precedent for URL-loading
      // repo modules). A non-literal specifier keeps it untyped on purpose.
      const url: string = '/src/sim/p_mobj.ts';
      const mtUrl: string = '/src/wad/info/mobjinfo.ts';
      const pm = (await import(/* @vite-ignore */ url)) as {
        pSpawnMobj: (rt: unknown, x: number, y: number, z: number, type: number) => unknown;
        ONFLOORZ: number;
      };
      const { MT } = (await import(/* @vite-ignore */ mtUrl)) as {
        MT: Record<string, number>;
      };
      const mix = [MT.MT_POSSESSED!, MT.MT_SHOTGUY!, MT.MT_TROOP!];
      for (let i = 0; i < 40; i++) {
        // identical ring math to tests/perf/scenes.ts (E1M1 spawn courtyard)
        const theta = ((i / 39) * 200 - 100) * (Math.PI / 180);
        const r = 256 + (i % 4) * 128;
        pm.pSpawnMobj(
          st.mobjs,
          Math.round(-416 + r * Math.cos(theta)) << 16,
          Math.round(256 + r * Math.sin(theta)) << 16,
          pm.ONFLOORZ,
          mix[i % 3]!
        );
      }
      const inv = st.players[0] as unknown as { ammo?: Uint32Array | number[] };
      if (inv.ammo !== undefined) inv.ammo[0] = 255;
      api.god(true); // the firefight must outlive the window
      api.popInput();
      api.pause(false);
      return st.mobjs.mobjs.filter((m) => !m.removed).length;
    });
    expect(census, '40 constructed mobjs landed on the E1M1 roster').toBeGreaterThanOrEqual(
      191 + 40
    );
  }
}

async function readPerf(page: Page): Promise<PerfSnapshot & { ready?: boolean }> {
  return page.evaluate(() => {
    const s = window.__doom!.state() as unknown as PerfSnapshot;
    if (s.perf === undefined) throw new Error('state().perf missing (platform counters)');
    return s;
  });
}

interface SceneResult {
  scene: string;
  map: string;
  frames: number;
  tics: number;
  fpsEstimate: number;
  hzEstimate: number;
  ticP50: number;
  ticP95: number;
  frameP50: number;
  frameP95: number;
  frameMax: number;
}

test.describe('M12-04 browser perf — real rAF, pinned budget', () => {
  test.describe.configure({ timeout: 240_000 });
  const results: SceneResult[] = [];

  for (const scene of SCENES) {
    test(`${scene}: 30 s live loop within budget`, async ({ page }) => {
      const consoleErrors: string[] = [];
      page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
      page.on('pageerror', (e) => consoleErrors.push(String(e)));

      await setupScene(page, scene);
      await page.waitForTimeout(PERF_METHOD.browserWarmMs); // JIT + wake-up

      const fire = scene === 'fire40';
      if (fire) await page.keyboard.down('Control'); // held fire

      const base = await readPerf(page);
      const t0 = Date.now();
      await page.waitForTimeout(PERF_METHOD.browserWindowMs);
      const wallMs = Date.now() - t0;
      if (fire) await page.keyboard.up('Control');
      const post = await readPerf(page);

      expect(post.map, 'same map across the window').toBe(base.map);
      const frames = post.perf.frames - base.perf.frames;
      const tics = post.perf.tics - base.perf.tics;
      expect(frames, 'rAF alive in window').toBeGreaterThan(300);
      expect(frames, 'perf ring wrapped mid-window (short the window?)').toBeLessThanOrEqual(
        post.perf.capacity
      );
      // Live-loop sanity: ~60 fps and 35 Hz over the window (±25%).
      const fps = (frames * 1000) / wallMs;
      const hz = (tics * 1000) / wallMs;
      expect(fps, 'rAF frame rate').toBeGreaterThan(45);
      expect(hz, 'sim tic rate').toBeGreaterThan(26);
      expect(hz, 'sim tic rate (no double-pump)').toBeLessThan(44);

      const winFrame = post.perf.frameMs.slice(-Math.min(frames, post.perf.frameMs.length));
      const winTic = post.perf.ticMs.slice(-Math.min(tics, post.perf.ticMs.length));
      const ticP50 = percentile(winTic, 0.5);
      const ticP95 = percentile(winTic, 0.95);
      const frameP50 = percentile(winFrame, 0.5);
      const frameP95 = percentile(winFrame, 0.95);
      expect(ticP50, `sim tic p50 ${scene}`).toBeLessThan(PERF_BUDGET.simP50Ms);
      expect(ticP95, `sim tic p95 ${scene}`).toBeLessThan(PERF_BUDGET.simP95Ms);
      expect(frameP50, `frame p50 ${scene}`).toBeLessThan(PERF_BUDGET.renderP50Ms);
      expect(frameP95, `frame p95 ${scene}`).toBeLessThan(PERF_BUDGET.renderP95Ms);

      expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
      results.push({
        scene,
        map: post.map,
        frames,
        tics,
        fpsEstimate: fps,
        hzEstimate: hz,
        ticP50,
        ticP95,
        frameP50,
        frameP95,
        frameMax: percentile(winFrame, 1)
      });
    });
  }

  test.afterAll(() => {
    if (process.env['PERF_EVIDENCE'] === undefined || results.length === 0) return;
    const dir = fileURLToPath(new URL('../tests/perf/evidence', import.meta.url));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      `${dir}/browser-results.json`,
      JSON.stringify(
        {
          task: 'M12-04 browser probe (real rAF, 320×200, 30 s/scene)',
          budget: PERF_BUDGET,
          method: PERF_METHOD,
          machine: {
            platform: os.platform(),
            arch: os.arch(),
            cpu: os.cpus()[0]?.model ?? 'unknown',
            node: process.version,
            browser: 'headless chromium (playwright)',
            date: new Date().toISOString()
          },
          scenes: results
        },
        null,
        2
      )
    );
  });
});
