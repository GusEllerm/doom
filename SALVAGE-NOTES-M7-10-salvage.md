# SALVAGE NOTES — M7-10 finish (continues from tip 5f49d15)

Continues branch task/M7-10-suites (dead agent left 6 commits: fixtures, harness, all per-weapon suites, shared-stream suite). Notes stub committed first per protocol.

## Pending work
1. Run full suite set now: `npx vitest run tests/weapons` + `npm run check` — repair any red (truth-from-source: /tmp/DOOM-master/linuxdoom-1.10, 62 .c files verified).
2. Deliver missing visual pack (plan §M7-10 + D016 visual gate): tests/render/goldens/weapons/** scenes with gun raised + muzzle flash (subset per weapon family), wiring live psprite data into the golden render pipeline (wire sim state seam into golden pipeline/main.ts). NEW scenes only — existing wall goldens stay byte-identical (gun off in those scenes' state). Plus ONE montage contact-sheet PNG (all weapon frames tiled, labelled) under goldens/weapons/ with meta reason 'M7-10 weapon visual pack'.
3. Exit sweep report: every M7 plan acceptance item vs state (done/partial + why).

## Rules
- NEVER touch docs/** (read-only).
- src/** minimal-fix-only, with regression tests.
- Gates: full vitest green; npm run check green; npm run e2e green; goldens --check ALL sets incl. new weapons set.

## Outcome (2026-09-20)
- Suites: all green as found; the 3 red files on the fresh worktree were a
  MISSING wads/freedoom1.wad (worktree artifact), fixed by a read-only symlink.
  No test/fixture repair needed. Wiring flip: psprites.test.ts "gun OFF" pin
  rewritten to pin the opt-in deps.psprites shape (mirror truth r_things.c:985).
- Wiring: renderer.ts gains OPTIONAL deps.psprites (drawn after drawMasked,
  before automap — vanilla order); NEW src/pspriteview.ts resolves sim pspdefs
  via the 967-state table (sector light via sim/bsp, powers[2] invisibility);
  main.ts render() passes it every frame. Absent dep ⇒ byte-identical legacy
  frames — walls/automap goldens --check: no drift.
- Visual pack: tests/weapons/visual.test.ts (wad-gated, freedoom sprites over
  M7 fixture maps) — 14 scenes + montage; blessed under
  tests/render/goldens/weapons/ with meta reason "M7-10 weapon visual pack".
  L5 note: freedoom's 4CC art differs from doom1 (PUNG→SARG, MISG→APBX,
  BFGG→ARM1, SHTG→SPOS/POSS) — graphics-naming-only (plan §6 risk 5), the
  state-machine behavior is identical; findings belong in docs/TASKS.md at
  M7-11 (docs/** off-limits here).
