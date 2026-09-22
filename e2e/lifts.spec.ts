/**
 * B-04 — live elevator ride on the REAL rAF loop: lifts are stateful and
 * the frame tracks the sim mid-transit.
 *
 * The bug this spec guards (live-only, invisible to per-frame goldens):
 * main.ts keyed the render-world rebuild on state.map NAME, while the
 * New-Game drain (gSetupLevel, game.ts:320) replaces state.map AND
 * state.sectors with the name equal — the display block kept reading the
 * boot-time sector SoA. On screen: the lift "never stayed down" (heights
 * frozen) and mid-ride the live viewz dropped below the stale floor planes
 * = the "elevator glitches the screen" artifact (camera under the floor:
 * inverted plane bands; every render counter stayed 0 — NOT visplane HOM).
 *
 * Assertions (E1M1's real elevators — GR-88 line 593 / SR-62 line 594 on
 * sector 98, floor 12 → -124 → up):
 *  • stateful trace: down 34 tics, park ≥105 tics at -124 (500-tic
 *    persistence checked post-cycle), up, parked at 12 forever;
 *  • retrigger correctness: GR/SR lines keep their specials (88/62) —
 *    no consume-on-activate;
 *  • pixel-class: state().render counters all 0 on every sampled frame;
 *  • SYNC PROBE (the decisive one): mid-pause, snapshot the canvas, then
 *    write the live sector floorZ directly — the canvas MUST repaint the
 *    change (fixed: the world shares the live SoA; broken: canvas frozen,
 *    which is exactly what the name-keyed rebuild did).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test } from '@playwright/test';

import { enterPlay } from './playstart';

const rawHash = (page: import('@playwright/test').Page): Promise<string> =>
  page.evaluate(() => {
    const c = window.__doom!.capture();
    let h = 2166136261;
    for (let i = 0; i < c.indices.length; i++) h = ((h ^ c.indices[i]!) * 16777619) >>> 0;
    return h.toString(16);
  });

/** Settle: the cross-level WIPE advances per DRAW (vanilla D_Display
 * timing) — frames transiently differ after any load. Poll until three
 * consecutive draws agree before asserting anything about pixels. */
async function stableHash(page: import('@playwright/test').Page): Promise<string> {
  let prev = '';
  let same = 0;
  for (let i = 0; i < 120; i++) {
    const h = await rawHash(page);
    same = h === prev ? same + 1 : 0;
    if (same >= 2) return h;
    prev = h;
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    );
  }
  throw new Error('frame never stabilized (wipe/animation loop?)');
}

test('E1M1 elevator: stateful ride + live display sync (B-04)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/?test=1');
  await page.waitForFunction(() => window.__doom?.state?.().ready === true);
  await enterPlay(page);

  await page.evaluate(() => window.__doom!.pause(true)); // deterministic tics
  await page.evaluate(() => window.__doom!.sim.warp(32 * 65536, 256 * 65536, undefined, 0));

  // walk east across line 596 (GR-88) — the lift triggers and we ride
  const phases = await page.evaluate(() => {
    const api = window.__doom!;
    const st = () => api.sim.getState()!;
    const rows: Array<[number | string, number]> = [];
    api.popInput();
    api.sim.runTics(8, { forward: true }); // cross x=64, plat spawns
    for (let i = 0; i < 8; i++) api.sim.runTics(1, { forward: false });
    rows.push([st().leveltime, (st().sectors.floorZ[98]! >> 16)]);
    api.sim.runTics(30); // to/below
    rows.push(['down-done', (st().sectors.floorZ[98]! >> 16)]);
    api.sim.runTics(80); // deep in the 105-tic wait
    rows.push(['wait', (st().sectors.floorZ[98]! >> 16)]);
    return rows;
  });
  expect(phases[1]![1], 'bottom reached (down phase complete)').toBe(-124);
  expect(phases[2]![1], 'still parked ~90 tics into the 105-tic wait').toBe(-124);

  // mid-pause the canvas must TRACK the live SoA (decisive staleness
  // probe). With the pre-fix NAME key the render world still points at
  // the boot-time SoA: the live floorZ below changes NOTHING on screen
  // (canvasB === canvasA once the wipe settles) — the exact "lifts are
  // not stateful" failure. Fixed: the rebuild is identity-keyed, the
  // world shares state.sectors, the write repaints.
  const canvasA = await stableHash(page);
  const countersA = await page.evaluate(() => {
    const s = window.__doom!.state();
    if (!s.ready) throw new Error('state not ready');
    return s.render;
  });
  expect(countersA.hom, 'hom stays 0 mid-wait').toBe(0);
  expect(countersA.visplaneOverflow).toBe(0);
  await page.evaluate(() => {
    window.__doom!.sim.getState()!.sectors.floorZ[98] = 12 * 65536; // teleport the floor
  });
  const canvasB = await stableHash(page);
  expect(canvasB, 'render world shares state.sectors (B-04 stale-world guard)').not.toBe(canvasA);
  await page.evaluate(() => {
    window.__doom!.sim.getState()!.sectors.floorZ[98] = -124 * 65536; // restore
  });

  // let the cycle finish (wait expiry → up → self-remove), then 500-tic
  // persistence; retrigger probes ride the GR/SR rules on the way.
  const done = await page.evaluate(async () => {
    const api = window.__doom!;
    api.popInput();
    api.sim.runTics(260); // remaining wait + rise + removal
    const st = api.sim.getState()!;
    const mid = st.sectors.floorZ[98]! >> 16;
    api.sim.runTics(500);
    const after = st.sectors.floorZ[98]! >> 16;
    const sd = st.sectors.specialData[98] !== null && st.sectors.specialData[98] !== undefined;
    // GR/SR lines never consume on activate
    const l593 = st.map.lines.special[593];
    const l594 = st.map.lines.special[594];
    return { mid, after, sd, l593, l594, lt: st.leveltime };
  });
  expect(done.mid).toBe(12);
  expect(done.after, '500-tic persistence: parked at 12, no oscillator').toBe(12);
  expect(done.sd, 'specialdata cleared after self-removal').toBe(false);
  expect(done.l593, 'GR-88 keeps its special (never clears on cross)').toBe(88);
  expect(done.l594, 'SR-62 keeps its special (useAgain=1)').toBe(62);

  const counters = await page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const s = window.__doom!.state();
    if (!s.ready) throw new Error('state not ready');
    return s.render;
  });
  expect(counters.hom).toBe(0);
  expect(counters.visplaneOverflow).toBe(0);
  expect(counters.visspriteOverflow).toBe(0);

  // and the loop keeps running clean
  await page.evaluate(() => window.__doom!.pause(false));
  await page.waitForTimeout(250);
  const st = await page.evaluate(() => {
    const s = window.__doom!.sim.getState()!;
    return { lt: s.leveltime, gs: s.gamestate };
  });
  expect(st.gs).toBe(0);
  expect(st.lt).toBeGreaterThan(0);

  expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
});
