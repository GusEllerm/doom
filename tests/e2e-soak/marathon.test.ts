/**
 * M12-05 — SOAK MARATHON + MEMORY/POOL LEAK AUDIT (the BUGS.md debt).
 *
 * DEFAULT PROFILE: 10 SIM-minutes (21,000 tics of the full live loop —
 * sim-clocked, wall time is measured not slept) with the seeded splitmix
 * input generator, level rotation through the faithful exit latch, menu
 * visits, automap visits, and faithful reborns every ~55 sim-seconds.
 *
 * OPT-IN MARATHON PROFILE: `SOAK_MINUTES=30 npx vitest run tests/e2e-soak`
 * (30 sim-minutes; heap sampled with a forced GC every sim-minute — the
 * sampler self-installs the forced GC (globalThis.gc or the V8-flag
 * route, reported as gcForced) so NO special runner flags are needed).
 *
 * MEMORY THRESHOLDS: pinned-after-measure (D-12a discipline) — the
 * measured numbers live in tests/e2e-soak/RESULTS.md and the JOURNAL
 * entry; the constants below are the pinned caps, violation = FINDING
 * (retained-object profile attached per plan).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { HOOK_LOG_CAP } from '../../src/sim/hooks';
import { hasWad } from './harness';
import { TICRATE, runMarathon, type MarathonReport } from './marathon';

const d = describe.skipIf(!hasWad);

const SIM_MINUTES = Number(process.env['SOAK_MINUTES'] ?? 10);
const SEED = Number(process.env['SOAK_SEED'] ?? 0x5eed1205);

/* ---- pinned thresholds (measured on the 10-min default profile, this
 * pass — see RESULTS.md; scaled linearly with the run length) ---- */
const E1_ALL = [
  'E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9'
];

d('M12-05 soak marathon + memory/pool leak audit', () => {
  it(
    `marathon: ${SIM_MINUTES} sim-minutes seeded soak (seed 0x${SEED.toString(16)})`,
    { timeout: SIM_MINUTES * 60_000 * 8 },
    () => {
      const r = runMarathon(SIM_MINUTES, SEED);
      report(r);

      // — the run happened (sim-clocked honesty: the tics are REAL tics
      // of the live loop; wall/throughput are reported, never asserted-to)
      expect(r.simTics).toBeGreaterThanOrEqual(SIM_MINUTES * TICRATE * 60 - 2);
      expect(r.mapOrder.length).toBeGreaterThanOrEqual(Math.max(4, SIM_MINUTES));

      // — coverage: rotation reached real E1 maps, both WI shapes, finale
      const maps = new Set(r.levels.map((l) => l.map));
      for (const m of maps) expect(E1_ALL).toContain(m);
      expect(maps.size).toBeGreaterThanOrEqual(6);
      expect(r.rotations).toBeGreaterThanOrEqual(Math.max(8, Math.floor(SIM_MINUTES * 1.2)));
      expect(r.wiEnds).toBeGreaterThanOrEqual(r.rotations - r.finaleVisits - 2);
      expect(r.secretExits + r.forcedReentries).toBeGreaterThanOrEqual(1);

      // — FAITHFUL-REBORN GATE: ≥5 detected same-map P_SetupLevel reloads,
      // each landing back EXACTLY in the post-setup arena band (the
      // per-reload delta violation above; asserted here as the pin).
      expect(r.faithfulReborns).toBeGreaterThanOrEqual(5);
      const reloaded = r.levels.filter((l) => l.reloads > 0);
      expect(reloaded.length).toBeGreaterThan(0);
      for (const l of reloaded) {
        expect(l.reloadOccupiedDelta).toBe(0);
      }

      // — per-tic invariants raised NOTHING
      expect(r.violations).toEqual([]);

      // — no state was ever entered without its driver (all tickers live)
      expect(r.flowStubs).toEqual({});

      // — hook-log caps
      for (const l of r.logCaps) expect(l.entries).toBeLessThanOrEqual(HOOK_LOG_CAP);

      // — heap growth (v8 heapUsed, GC-forced sampling every sim-minute).
      // PINNED AFTER MEASURE (D-12a): the 10-min default measured
      // baseline 70.2 MB → net +6.0 MB, peak +6.1 MB, a FLAT plateau
      // after the first sample (per-minute samples in RESULTS.md — no
      // monotonic slope = the arenas/Maps do not retain across levels).
      // Caps below carry a >30 % margin on that measurement; exceeding
      // them = FINDING with a retained-object profile attached.
      const perMin = SIM_MINUTES;
      expect(r.heapDeltaMb).toBeLessThan(0.3 * perMin + 5); // net (meas 6.0 @10)
      expect(r.heapPeakDeltaMb).toBeLessThan(0.35 * perMin + 6); // peak (meas 6.1 @10)
    }
  );
});

function report(r: MarathonReport): void {
  const line = (s: string): void => console.log(s);
  line('');
  line(`M12-05 MARATHON  seed=0x${SEED.toString(16)}  ${r.simMinutes} sim-min ` +
    `(${r.simTics} tics)  wall ${(r.wallMs / 1000).toFixed(1)} s ` +
    `(${r.ticsPerWallSecond} tics/s)  gcForced=${r.gcForced}`);
  line(`rotations=${r.rotations} secretExits=${r.secretExits} wiEnds=${r.wiEnds} ` +
    `finaleVisits=${r.finaleVisits} forcedReentries=${r.forcedReentries}`);
  line(`faithfulReborns=${r.faithfulReborns} (injected=${r.injectedReborns}, ` +
    `viaDeath=${r.deathReborns}) deaths=${r.deaths} menuVisits=${r.menuVisits} ` +
    `automapToggles=${r.automapToggles}`);
  line(`map order: ${r.mapOrder.join(' ')}`);
  line('level census (map entryTic occ tk peak reloads worstΔ):');
  for (const l of r.levels) {
    line(`  ${l.map.padEnd(5)} ${String(l.entryTic).padStart(7)} ` +
      `${String(l.occupiedAtEntry).padStart(5)} ${String(l.thinkersAtEntry).padStart(5)} ` +
      `${String(l.peakOccupied).padStart(5)} ${String(l.reloads).padStart(3)} ` +
      `${String(l.reloadOccupiedDelta).padStart(4)}`);
  }
  line(`heap Mb baseline=${r.heapBaselineMb} delta=${r.heapDeltaMb} ` +
    `peakDelta=${r.heapPeakDeltaMb}`);
  line(`heap samples: ${r.heapSamplesMb.join(' ')}`);
  line(`hook logs: ${r.logCaps.map((l) => `${l.name} ${l.count}/${l.entries}`).join('  ')}`);
  line(`flowStubs: ${JSON.stringify(r.flowStubs)}`);
  line(`violations (${r.violations.length}): ${r.violations.slice(0, 8).join(' | ')}`);
  line('');
}
