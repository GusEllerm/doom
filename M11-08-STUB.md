# M11-08 — persistence golden corpus (STUB)

Owns: `tests/persist/**`, `tests/fixtures/m11Scenarios.ts`, `goldens-update.mjs` persist-set registration.

Scope (plan §M11-08):
1. Cross-map/episode persistence proofs (map-name roll + save timing sites)
2. L1 golden set: save snapshots (bytes via codec) for scenario corpus → `tests/persist/goldens/` (double-run byte-equal, blessed once)
3. THE matrix: save@T → hydrate fresh world → load → run 300 tics == original T..T+300 (through byte codec + store path)
4. Demo+save interplay per plan
5. Corrupt/truncated save battery at store level (codec error paths → UI-visible failures, not throws)

Status: stub committed; bodies land incrementally.
