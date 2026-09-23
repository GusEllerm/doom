# M12-05 — Soak marathon + memory/pool leak audit: measured results

Machine: Apple M5 Pro, node v22.22.1, vitest 5 (threads pool,
single file, `gcForced=true` via the sampler's self-installed forced GC).
Runs below are the FULL live loop (display every tic, main.ts parity),
sim-clocked — wall time is measured, never slept.

Commands:
- DEFAULT (CI): `npx vitest run tests/e2e-soak` → 12 B-0x pins + marathon
  10 sim-min (seed 0x5eed1205), ~40 s wall.
- OPT-IN marathon: `SOAK_MINUTES=30 npx vitest run tests/e2e-soak`
  (`SOAK_SEED=<n>` overrides the seed).

## Default profile — 10 sim-minutes (seed 0x5eed1205)

21,001 tics in 35.7 s wall (589 tics/s). rotations 28 (2 secret exits),
wiEnds 26, finaleVisits 2, forcedReentries 2 (both the faithful
G_DeferedInitNew re-entry after the E1M8 ga_victory CREDIT tail).
Faithful reborns DETECTED: 7 (all injected; the death chain found no
death this seed). deaths 0, menuVisits 17, automapToggles 14.
violations 0 · flowStubs {} (every state had its driver every tic).

| map | occ@setup | thinkers | peak occ | reloads | worst Δ |
|-----|-----------|----------|----------|---------|---------|
| E1M2 | 265 | 283 | 267 | 0 | 0 |
| E1M3 | 302 | 329 | 305 | 0 | 0 |
| E1M4 | 289 | 291 | 290 | 2 | 0 |
| E1M5 | 251 | 254 | 260 | 2 | 0 |
| E1M6 | 364 | 379 | 373 | 0 | 0 |
| E1M7 | 539 | 544 | 540 | 2 | 0 |
| E1M8 | 36  | 36  | 36  | 1 | 0 |
| E1M9 | 284 | 285 | 285 | 0 | 0 |

(E1M1 is the boot level of the instance; every reload of every map lands
BACK IN the post-setup band — Δ 0, exact, not just banded.)

Heap (heapUsed, MB, forced GC at each sample, one sample per sim-minute):
baseline 70.21 → 75.08 76.32 73.43 74.96 73.67 74.10 76.05 75.02 74.50
76.27 — net +6.02, peak +6.12, FLAT after the first sample (warm caches).
PINNED: net < 0.3·min + 5, peak < 0.35·min + 6 (≥30 % margin on these
measurements). Hook-log census at end: gameaction 65, uiSfx 86, music 64,
cheat 0, capture 0 — all ≪ HOOK_LOG_CAP 4096.

## Marathon profile — 30 sim-minutes, run ONCE (seed 0x5eed1205)

63,000 tics in 99.9 s wall (630 tics/s). rotations 77 (5 secret), wiEnds
69, finaleVisits 8, forcedReentries 8 (the 8 finale tails).
Faithful reborns DETECTED: **26** (23 injected + **3 via the death
chain** — deaths at the death camera pressed USE → P_DeathThink
PST_REBORN → G_DoReborn). menuVisits 49, automapToggles 48.
violations 0 · flowStubs {}.

Per-map reload bands (reloads × worst Δ): E1M4 6×0 · E1M5 7×0 · E1M6 5×0
· E1M7 4×0 · E1M8 3×0 · E1M9 1×0 — every one of the 26+ revisits landed
EXACTLY back on the post-setup occupied-slot count and thinker pool.

Heap over 30 samples (MB, GC-forced): baseline 70.21, then 77.40 →
74.39 — oscillating 73.5..76.5 with NO slope: net +4.17, peak +7.19 at
30× the sampling. No monotonic growth = no retention across levels,
reborns, menus or automap visits. Hook census: gameaction 188, uiSfx
236, music 181 — caps clear.

## Seed spread (2-sim-min hardening probes, seeds 0x1/0x3039/0x1869f/0x7)

6 rotations, 2 faithful reborns, 0 violations, flowStubs {} each — the
mechanics are seed-robust (the 10-min default is the pinned gate).

## FINDINGS

**None.** Zero per-tic invariant violations (NaN-free hash inputs,
hash self-consistency, hook caps), zero flowStub hits (WI/finale/page/M
tickers all driven), zero occupied-slot drift across 105 map entries and
33 faithful reborns, heap plateau flat. The mobj arena, the thinker pool,
the slotMobjs/hook-bridge maps and the display statics do NOT leak
across level rotation, faithful reborns, menu visits or the WI/finale
detours. No src change was needed (none allowed): nothing re-blessed.
