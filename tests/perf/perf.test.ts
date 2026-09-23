/**
 * M12-04 node-side perf gate (docs/design/M12-plan.md §M12-04a) — the three
 * fixed scripted scenes (E1M7 heaviest / E1M1 baseline / 40-mobj firefight,
 * see scenes.ts) measured through the SAME loop shape the product uses:
 * one gTicker per 35 Hz tic + one 320×200 renderFrame per displayed frame,
 * p50/p95 asserted against the PINNED budget (budget.ts — D-12a: pinned
 * after the first honest measure, never tuned-to-pass).
 *
 * This file is ALSO the --cpu-prof probe target: scripts/perf-probe.mjs
 * runs it with V8 CPU profiling on and PERF_EVIDENCE=1, so the profiled
 * hot paths are exactly what the gate measures. The evidence JSON
 * (tests/perf/evidence/node-results.json) is written ONLY under that env
 * flag — a plain `vitest run` leaves the tree clean.
 *
 * Run standalone: npx vitest run tests/perf
 * Probe:         node scripts/perf-probe.mjs
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PERF_BUDGET, PERF_METHOD } from './budget';
import { machineInfo, measureScene, type SceneStats } from './measure';
import { buildScenes, hasWad } from './scenes';

const EVIDENCE_PATH = fileURLToPath(
  new URL('./evidence/node-results.json', import.meta.url)
);

const t0 = performance.now();
const built = hasWad ? buildScenes() : null;
const bootMs = performance.now() - t0;

const stats: SceneStats[] = [];

describe.skipIf(!hasWad)('M12-04 node perf — pinned budget', () => {
  for (const [index, label] of ['e1m7', 'e1m1', 'fire40'].entries()) {
    it(`${label}: sim-tic + render-frame p50/p95 within budget`, () => {
      const scene = built!.scenes[index]!;
      expect(scene.name).toBe(label);
      const { stats: s } = measureScene(scene, PERF_METHOD.warmTics, PERF_METHOD.measuredTics);
      stats.push(s);
      expect(s.samples).toBe(PERF_METHOD.measuredTics);
      // Scene sanity (a mis-built scene would silently measure nothing):
      if (label === 'fire40') {
        // E1M1 boots 191 live slots (BUG-combat roster) + the 40 constructed
        expect(s.mobjsAtBoot).toBeGreaterThanOrEqual(191 + 40);
      }
      expect(s.simP50, `sim p50 ${label}`).toBeLessThan(PERF_BUDGET.simP50Ms);
      expect(s.simP95, `sim p95 ${label}`).toBeLessThan(PERF_BUDGET.simP95Ms);
      expect(s.renderP50, `render p50 ${label}`).toBeLessThan(PERF_BUDGET.renderP50Ms);
      expect(s.renderP95, `render p95 ${label}`).toBeLessThan(PERF_BUDGET.renderP95Ms);
      // Whole-frame pair (ARCH §4.8's "the whole frame" reading):
      expect(s.frameP50, `frame p50 ${label}`).toBeLessThan(PERF_BUDGET.simP50Ms);
      expect(s.frameP95, `frame p95 ${label}`).toBeLessThan(PERF_BUDGET.renderP95Ms);
    });
  }

  it('evidence write (PERF_EVIDENCE=1 only)', () => {
    if (process.env['PERF_EVIDENCE'] === undefined) return;
    mkdirSync(fileURLToPath(new URL('./evidence', import.meta.url)), {
      recursive: true
    });
    writeFileSync(
      EVIDENCE_PATH,
      JSON.stringify(
        {
          task: 'M12-04 node probe',
          budget: PERF_BUDGET,
          method: PERF_METHOD,
          bootMs: Math.round(bootMs),
          machine: machineInfo(),
          scenes: stats
        },
        null,
        2
      )
    );
  });
});
