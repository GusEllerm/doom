# M7-01 salvage notes (t2 branch)

Salvage of stopped agent branch `task/M7-01-states` (tip `ea3c701`).

- Recovered from the stopped tip: generated `src/wad/info/{states,mobjinfo,weaponinfo,sprnames}.ts`
  and the `ActionId` registry + switch in `src/sim/a_actions.ts` (transcribed from the
  linuxdoom-1.10 mirror `info.c` / `d_items.c`).
- This branch `task/M7-01-states-t2` starts from that tip; finishing work (census/parity
  tests, frame-bit decode, advance-helper semantics, gate green) happens here.
- Owned paths (docs/design/M7-plan.md §M7-01): `src/wad/info/{states,mobjinfo,weaponinfo,sprnames}.ts`,
  `src/sim/a_actions.ts`, `src/wad/info/states.test.ts`. Nothing under `docs/**`.
- Mirror check: `/tmp/DOOM-full` and `/tmp/DOOM-master/linuxdoom-1.10` are byte-identical
  (62 `.c` each; `info.c` sha256 `e09631527669…`), so either serves as the reference tree.
- Parallel salvages own `p_doors*` (M6-05b) and `p_pspr.ts`/`psprites.ts` (M7-07) — zero
  overlap: this branch touches only the four info tables, `a_actions.ts` (+ its new test),
  one `tests/` parity test and one dev script.
- Plan §M7-01 acceptance 3 (absorb-if-M6): M6 landed NO state table (nothing outside
  `src/wad/info/` defines states/mobj data; `render/rthings.ts` carries a hand-rolled
  doomednum→sprite subset from M4). So this task EXTENDS the tree, adding
  `tests/info-tables.test.ts` to pin parity against that subset.

## Outcome (t2)

- RECOVERED (already complete at `ea3c701`, now machine-verified): the 967-row SoA states
  table + `S` map, 137-row mobjinfo + `MT`/`MF`/`DOOMEDNUM_TO_MT`, 138-name sprnames,
  9-row weaponinfo, and the 75-id ActionId registry (ACT/ACTION_NAMES/total switch/slot
  recorder). `states.test.ts` was still the `expect(1).toBe(1)` placeholder and tsc was red.
- FIXED (real defects, found by row-by-row diff vs the mirror, not by the stale placeholder):
  - `weaponinfo.ts` doomdef.h enum values: `NUMAMMO` precedes `am_noammo` (so am_noammo = 5,
    NUMAMMO = 4, not 4/5) and `NUMWEAPONS` precedes `wp_nochange` (= 10, not 9) — the
    fist/chainsaw rows now carry `am_noammo`. **Downstream note for M7-07/M8:** use the
    `AMMO`/`WP` constants, never the literals; `am_noammo` is never a `maxammo[]` index.
  - tsc red: `mobjinfo.ts` doomednum-map tuple mutability and `states.ts` `stateNext[state]`
    under `noUncheckedIndexedAccess`.
  - `StateRow` gained its `id` (row identity; `stateAdvance` returned an anonymous row before).
- FINISHED (tests, all green):
  - `scripts/extract-info-tables.mjs` (dev tool): parses the mirror's `info.c` states[] +
    mobjinfo[], `info.h` enums/sprnames[] and `d_items.c` weaponinfo[] into the canonical row
    strings `states.test.ts` digests; `--digests` prints full-table + per-family digests and
    the action order/counts; `DOOM_MIRROR=<path> npx vitest run src/wad/info/states.test.ts`
    additionally diffs every row live.
  - `src/wad/info/states.test.ts` (25 tests): counts 967/137/138/9, four whole-table digests,
    180-family census (rows + content digest each), ~40 spot vectors over 6 family groups
    (player, weapon pspr, monster death/pain/gore, item MF_SPECIAL frames, effects, sentinel —
    ≥6 sampled per group incl. `S_EXPLODE1`, `S_BEXP4`, `S_PUFF3`, `S_PLAY_ATK2` = 32773),
    frame-bit decode (`FF_FULLBRIGHT` 0x8000 / `FF_FRAMEMASK`, the 32768+n literals, the
    S_VILE_HEAL1..3 above-Z quirk, lump-name round-trip through `wad/sprites.ts`),
    doomdef.h enum-value traps, doomednum first-match map, MF_* values, and the
    deliberately-wrong control (6 single-field corruptions + dropped/duplicated-row
    controls → digest AND census both fail, so the digests are provably non-vacuous).
  - `src/sim/a_actions.test.ts` (6 tests): manifest completeness machine test — 75 ids,
    unique names, first-appearance order == `SOURCE_ACTION_ORDER`, per-action row counts
    `counts === SOURCE_ACTION_ROW_COUNTS` and Σ = 967 (no unreferenced/unused id),
    total switch (unknown id throws), recorder/manifest surface.
  - `tests/info-tables.test.ts` (3 tests): cross-zone parity with `render/rthings.ts`
    `THING_SPRITE4`/`THING_FRAMES`/`THING_KINDS` (118 doomednums, sprite 4CC + spawnstate
    frame decoded through `FF_FRAMEMASK`), same doomednum set both sides, marker classes.
  - Advance helpers (`setStateChain`/`stateAdvance`/`maxPureChainLength`): the 8 source
    0-tic rows (1, 54, 62, 73, 255, 335, 339, 711) terminate in ≤2 pure steps;
    `S_LIGHTDONE` removes; the `S_CHAIN3`/`S_MISSILE3`/`S_SAW3` ready-state cascades;
    monster 0-tic entries (A_VileStart/A_FaceTarget/A_PainAttack); action tic-override
    contract; the `MAX_STATE_CHAIN` guard where vanilla would hang; run-cycle /
    forever-tics / death-to-S_NULL walks.

## Evidence

- Full-table row diff vs the mirror (`DOOM_MIRROR=…`, both mirror copies): states 967,
  mobjinfo 137, sprnames 138, weaponinfo 9 — 0 differing rows; digests
  `34ccd2d247595b2f` / `42837e8b83635128` / `a0482fc583f518f3` / `b8edf93159f9218f`.
- Negative control on the real table (one frame word `32773→32772` at S_PLAY_ATK2,
  reverted): 4 tests fail, naming `S_PLAY: content digest drift` and the exact row.
- Gates: `npx vitest run src/wad/info/states.test.ts src/sim/a_actions.test.ts tests/info-tables.test.ts`
  → 34 passed; `npm run check` (tsc + eslint + vitest) → 82 files, 1764 passed, 1 skipped
  (the mirror-diff test, needs `DOOM_MIRROR`).

## Follow-ups

- M7-02/07: bind ActionId bodies (`registerAction`) — the recorder
  (`unimplementedActions()`) is the gap meter; M7-07 must read `weaponinfo` state ids
  through the table, and note `wp_nochange === 10`.
- Whoever indexes sounds (`M7-06` sfx slot): 15 mobjinfo sound slots hold the source
  literal `'0'` (C null = silence), not `'sfx_None'` — census-pinned.
- `render/rthings.ts` keeps its own doomednum subset; when M7-02 spawns real mobjs, that
  table should be re-derived from `mobjinfo.ts` (the parity test here is the tripwire).
- The `MAX_STATE_CHAIN` 1024 cap is a documented deviation from vanilla (which would hang);
  revisit if a 0-tic loop is ever introduced by an action body.
