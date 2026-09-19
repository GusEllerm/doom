# M6-07 salvage notes (t2 branch)

Salvage of stopped agent branch `task/M6-07-floors`.

- Branch tip recovered: `pfloor.ts` LIVE (T_MoveFloor / EV_DoFloor / EV_BuildStairs from p_floor.c; EV_DoDonut from p_spec.c) + registry floors subtable fill + WIP `pfloor.test.ts` (870 lines, killed mid-writing).
- This branch `task/M6-07-floors-t2` starts from the stopped tip; work continues here.
- Plan: docs/design/M6-plan.md §M6-07 (stair timing goldens, excavate, donut full cycle via live plat code, crush cadence, ties, retrigger, double-run hashes).

## Outcome (t2)

- RECOVERED: pfloor.ts + registry fill were already complete — the “remaining throw” was only the intentional pmap/players world guard (pfloor.ts:199). No p_floor.c/p_spec.c body was missing.
- FINISHED (test side, all in pfloor.test.ts):
  - fixture triggers moved inside single room edges (mapBuilder rule) + players centred in rooms;
  - LOWER_SPEC north-room floor 0 (highest-surrounding dest = 0 pin);
  - tic-0-step timing corrected everywhere (first thinker tic runs at leveltime 0);
  - crush scenario: dest = min(96, own ceil 74) − 8 = 66 (cap BEFORE the −8) — 12 damage events tics 20..64, pastdest pair at tic 66 damages 0 (66&3=2);
  - donut fixture push-order pin: east ring cell pushed FIRST so it FRONTS every edge — otherwise EV_DoDonut’s verbatim `backsector != s1` scan picks s2 itself as s3 (orientation quirk of mapBuilder’s earlier-room-fronts rule);
  - parity test fires each special while its world is the LAST bound (pCrossSpecialLine dispatches through the module bind);
  - census: S1 140 (raiseFloor512, p_switch.c:508) added to the floor ids → 39+4+1 (plan’s “38” missed it; registry already routed it).
- GATES: npm run check green (tsc+eslint+vitest 1163), goldens --check no drift, motion strips no drift, playwright e2e 14 passed.
