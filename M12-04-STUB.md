# M12-04 STUB — Perf: measure, then pin the frame budget

Owner: perf implementer (wave 2). Plan: docs/design/M12-plan.md §M12-04.

Owns (per §1):
- `tests/perf/**` (node-side perf suite + pinned constants)
- `e2e/m12-perf.spec.ts` (browser rAF 30 s scenes)
- `scripts/perf-probe.mjs` (node-side scripted-scene probe, --cpu-prof)

Explicitly NOT owned: `src/render/**` hot-path edits (wave-3 fix task only if the
profile shows a budget violation). `src/**` touch allowed ONLY for ADDITIVE
`__doom.state().perf` read counters (timing platform-side; sim stays pure per A-06).

Scenes (fixed, scripted):
1. E1M7 — heaviest map (§0.1 census: 714 things / 4337 lines)
2. E1M1 — baseline
3. 40-mobj firefight — constructed via arena seams

Measure: sim-tic ms + render-frame ms, p50/p95, node + browser(320x200, rAF, 30 s).
Budget proposal (D-12a): p50 <= 8 ms / p95 <= 13 ms — PINNED after first honest
measure; measured values + headroom decision carried to JOURNAL at exit.
NO optimization commits in this task (measure + profile artifacts only).

Gates: `npx vitest run tests/perf` green; `npx playwright test e2e/m12-perf.spec.ts`
green; `npm run check` green.
