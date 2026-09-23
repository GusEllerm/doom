/**
 * M12-04 PINNED frame budget (docs/design/M12-plan.md §M12-04c, D-12a:
 * measure-then-pin — the proposal p50 ≤ 8 ms / p95 ≤ 13 ms from
 * ARCHITECTURE §4.8 was MEASURED first on this repo's engine, then frozen;
 * it is NOT tuned-to-pass, and nothing was tuned-to-it either: the profile
 * showed no violation, so zero optimization commits landed in M12-04).
 *
 * MEASURED (2026-09, Apple M5 Pro laptop, node v22 + headless chromium,
 * 320×200; node = 400 tic+frame pairs/scene, browser = 30 s live windows —
 * full tables in tests/perf/evidence/{node,browser}-results.json, carried
 * to JOURNAL by the M12-04 report):
 *
 *   scene    node sim p50/p95   node render p50/p95   browser tic p50/p95   browser frame p50/p95
 *   e1m7        0.05 / 0.09        0.95 / 1.08            0.2 / 0.4            1.0 / 1.8   (ms)
 *   e1m1        0.02 / 0.03        0.98 / 1.05            0.1 / 0.2            1.3 / 2.3
 *   fire40      0.05 / 0.16        1.12 / 1.39            0.1 / 0.3            1.5 / 2.4
 *
 * (browser timing granularity: chromium clamps performance.now to 0.1 ms —
 * the values are honest lower bounds of each stream.)
 *
 * HEADROOM DECISION (D-12a): worst measured p95 is 2.4 ms ≈ 18 % of the
 * 13 ms cap (max single frame 2.7 ms ≈ 21 %); we KEEP the proposal values as the hard caps (frozen targets,
 * no tightening to measured values — the caps must absorb CI noise, GC and
 * slower "mid-range laptop class" machines, per §4.8's own machine note).
 * Re-measure (never re-tune) in Post-M12 if a real machine reports a
 * violation; changing a cap is a DECISIONS event, not a test edit.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Whole-frame (ARCH §4.8) budget halves, applied per measured stream.
 * "sim" = one 35 Hz tic of world+UI tickers; "render" = one 320×200 frame
 * pass (node: renderFrame; browser: render(), displayFrame + RGBA blit
 * included). The browser's numbers ride `performance.now` deltas recorded
 * platform-side by the loop itself (`__doom.state().perf`, M12-04). */
export const PERF_BUDGET = {
  /** proposal p50 ≤ 8 ms (ARCH §4.8), frozen after measurement */
  simP50Ms: 8,
  /** proposal p95 ≤ 13 ms, frozen after measurement */
  simP95Ms: 13,
  renderP50Ms: 8,
  renderP95Ms: 13
} as const;

/** Measurement discipline shared by the node suite and the e2e spec. */
export const PERF_METHOD = {
  /** unmeasured warm-up tic+frame pairs per node scene (JIT + wake-up) */
  warmTics: 40,
  /** measured tic+frame pairs per node scene (≈11.4 s of sim clock) */
  measuredTics: 400,
  /** live-loop window per browser scene (plan: 30 s; 60 fps ≈ 1800 frames,
   * 35 Hz ≈ 1050 tics — the 8192-entry perf ring never wraps in-window) */
  browserWindowMs: 30_000,
  /** browser settle before the window (boot drain + JIT + monster wake) */
  browserWarmMs: 4_000
} as const;
