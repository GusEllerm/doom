/**
 * M12-04 probe entry (node, single process) — the module the CPU-profiled
 * region runs: builds the three fixed scenes and measures them through the
 * SAME helpers tests/perf/perf.test.ts gates on, and throws a
 * `BUDGET VIOLATION` listing if any measured p50/p95 exceeds the pinned
 * budget (the probe is the profile + attribution surface; the vitest gate
 * is the pass/fail home).
 *
 * Loaded via vite ssrLoadModule by scripts/perf-probe.mjs, which wraps
 * runProbe() in a Profiler.start/stop window. NO vitest here — one
 * process, one profile, exactly the gated code path.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { PERF_BUDGET, PERF_METHOD } from './budget';
import { machineInfo, measureScene, type SceneStats } from './measure';
import { buildScenes, hasWad } from './scenes';

export interface ProbeResult {
  budget: typeof PERF_BUDGET;
  method: typeof PERF_METHOD;
  bootMs: number;
  machine: Record<string, string | number>;
  scenes: SceneStats[];
}

export function runProbe(): ProbeResult {
  if (!hasWad) throw new Error('perf probe requires wads/freedoom1.wad');
  const t0 = performance.now();
  const { scenes } = buildScenes();
  const bootMs = performance.now() - t0;
  const stats = scenes.map((s) =>
    measureScene(s, PERF_METHOD.warmTics, PERF_METHOD.measuredTics).stats
  );
  const violations: string[] = [];
  for (const s of stats) {
    if (s.simP50 >= PERF_BUDGET.simP50Ms) violations.push(`${s.name} simP50 ${s.simP50.toFixed(2)}`);
    if (s.simP95 >= PERF_BUDGET.simP95Ms) violations.push(`${s.name} simP95 ${s.simP95.toFixed(2)}`);
    if (s.renderP50 >= PERF_BUDGET.renderP50Ms)
      violations.push(`${s.name} renderP50 ${s.renderP50.toFixed(2)}`);
    if (s.renderP95 >= PERF_BUDGET.renderP95Ms)
      violations.push(`${s.name} renderP95 ${s.renderP95.toFixed(2)}`);
  }
  if (violations.length > 0) {
    throw new Error(`BUDGET VIOLATION (pin = proposal, D-12a — profile hot paths above):\n  ${violations.join('\n  ')}`);
  }
  return {
    budget: PERF_BUDGET,
    method: PERF_METHOD,
    bootMs: Math.round(bootMs),
    machine: machineInfo(),
    scenes: stats
  };
}
