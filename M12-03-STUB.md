# M12-03 STUB — Reachable-exit routes per map + scripted playthroughs

Owns: `tests/fixtures/m12Routes.ts`, `tests/headless/routes.test.ts`, `e2e/m12-playthrough.spec.ts`.
NEVER touches `src/**` (blocked route = FINDING w/ minimal repro, esp. elevator/trigger dead like B-11).

Plan: docs/design/M12-plan.md §M12-03.
- L2: per-map (E1M1..E1M9) deterministic seeded route reaching exit (G_ExitLevel → intermission stats),
  zero unimplementedSpecial hits, sector-movement ledger: every key/switch/plat/door the route touches
  must visibly move something (anti-B-11 teeth).
- L4: E1M1 full playthrough + E1M8 boss route (sector-11 finale math) + one more (E1M2 if B-11-clean else E1M3),
  ending WI/finale, zero console errors.
- Routes sim-clocked in bulk (no rAF); CI-sane runtime.

Status: STARTED. Rebase before finishing (B-11 fixer may move src/sim specials/plats).
