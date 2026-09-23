/**
 * M12-04 measurement helpers (node side) — percentile math + the scene
 * timing loop shared by tests/perf/perf.test.ts and the --cpu-prof probe
 * run (scripts/perf-probe.mjs drives THIS suite, so the profiled code path
 * is the gated code path).
 *
 * Timing lives here, platform-side (A-06: the sim never sees
 * performance/Date); the scenes themselves (tests/perf/scenes.ts) are pure
 * construction. Percentile convention: sorted-copy index
 * floor(q * n) clamped to n-1 (nearest-rank, slightly pessimistic —
 * documented so node and e2e agree; the e2e spec imports THESE functions).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { performance } from 'node:perf_hooks';
import * as os from 'node:os';

import { gTicker } from '../../src/sim/game';
import { renderFrame } from '../../src/render/renderer';
import type { PerfScene } from './scenes';

export interface SceneStats {
  name: string;
  mobjsAtBoot: number;
  samples: number;
  simP50: number;
  simP95: number;
  simMax: number;
  renderP50: number;
  renderP95: number;
  renderMax: number;
  /** per-tic pair (sim + render) — the whole-frame analog of the browser */
  frameP50: number;
  frameP95: number;
  frameMax: number;
}

/** Nearest-rank percentile on a sorted copy (q in [0,1]). */
export function percentile(samples: readonly number[], q: number): number {
  if (samples.length === 0) return 0;
  const s = [...samples].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(q * s.length));
  return s[i]!;
}

/**
 * Run `warm` + `measured` tic+frame pairs over one scene — the node mirror
 * of main.ts's loop (one gTicker per 35 Hz tic, one 320×200 renderFrame
 * per displayed frame, 1:1 here since every simulated tic is shown).
 * Determinism: the scene's scripted input drives every tic; nothing here
 * feeds back into the sim.
 */
export function measureScene(
  scene: PerfScene,
  warm: number,
  measured: number
): { stats: SceneStats; simMs: number[]; renderMs: number[] } {
  const simMs: number[] = [];
  const renderMs: number[] = [];
  const pair = (m: boolean): void => {
    const t0 = performance.now();
    gTicker(scene.state, scene.ticInput(scene.state.gametic));
    const t1 = performance.now();
    renderFrame(scene.deps);
    const t2 = performance.now();
    if (m) {
      simMs.push(t1 - t0);
      renderMs.push(t2 - t1);
    }
  };
  for (let i = 0; i < warm; i++) pair(false);
  for (let i = 0; i < measured; i++) pair(true);
  const frameMs = simMs.map((s, i) => s + renderMs[i]!);
  return {
    stats: {
      name: scene.name,
      mobjsAtBoot: scene.mobjsAtBoot,
      samples: simMs.length,
      simP50: percentile(simMs, 0.5),
      simP95: percentile(simMs, 0.95),
      simMax: percentile(simMs, 1),
      renderP50: percentile(renderMs, 0.5),
      renderP95: percentile(renderMs, 0.95),
      renderMax: percentile(renderMs, 1),
      frameP50: percentile(frameMs, 0.5),
      frameP95: percentile(frameMs, 0.95),
      frameMax: percentile(frameMs, 1)
    },
    simMs,
    renderMs
  };
}

/** Machine banner recorded into every evidence JSON (D-12a honesty). */
export function machineInfo(): Record<string, string | number> {
  return {
    platform: os.platform(),
    arch: os.arch(),
    cpu: os.cpus()[0]?.model ?? 'unknown',
    cores: os.cpus().length,
    node: process.version,
    date: new Date().toISOString()
  };
}
