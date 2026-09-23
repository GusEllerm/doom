# B-11 STUB (in progress)

Bug-fixer session working BUGS.md B-11 — E1M2 blazing platform (tag 14, sector 124)
never engages via trigger lines 350 (sp 123) / 1287 (sp 120).

Plan:
1. Reproduce headless (E1M2 load, direct pCrossSpecialLine(350)/pUseSpecialLine(1287), 200 tics).
2. Root-cause vs p_spec.c enclosing-function truth (use vs cross switch sections).
3. Fix + regression tests (repro green + live-route test).
