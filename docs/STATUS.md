# STATUS

## Current phase
Phase 3, M9 COMPLETE (game flow & UI). Merged: T00, R01–R12, M1–M9 all tasks
(plans + ledgers in docs/design, docs/TASKS.md).

## M9 exit state (M9-13)
- Gates: `npm run check` 141 files / 2812 tests green, `npm run e2e` 37 green
  TWICE consecutive (boot-flip e2e adaptation held), goldens --check
  drift-free on automap/walls/weapons/screens/m9 (+motion/mechanics
  in-suite); mirror 62-.c re-verified. Full table + RE-BLESS LEDGER
  (18 reasons, 7 sets, 91 scenes): docs/reports/M9-13-exit-sweep.md.
- THE WHOLE LOOP: TITLEPIC → skill → play → menu (keys+mouse, D020) → exit →
  WI tally/par → E1M2 → death→FAITHFUL level restart (D017 RETIRED) → F7 →
  title (D021). e2e/m9-flow.spec.ts + 8 legacy specs enter play via the
  deterministic m9-flow seams (M9-fix).
- Production pixels: sb9 windowed default + borders, statusbar/face/HU live,
  LIVE monsters (D018 FLIPPED). L5 pack: goldens/screens/m9-exit-montage.png
  (18 blessed scenes tiled 3x6 — D016 review artifact of THIS exit).
- PRNG final: FULL-SCOPE manifest (scanCallTree, whole src tree, both
  streams) green; `st_face` = 1 M_Random/GS_LEVEL tic + WI +10/state-entry
  pinned ON THE LIVE STREAM (tests/sim/m9prng.test.ts; M9-07 fresh-stream
  timing asserts fixed — the §M9-13 callout was REAL).
- D-list CLOSED: silent-M9 sfx 41 sites kept (D019), mouse-synth (D020),
  title-as-quit-target (D021), ad-divert fidelity (D022), TITLEPIC-only
  attract (D023).
- FINDINGS rollup: intermission canvas is 320x240 (WI_STARTY=168); HU queue
  drops NEWEST (M9-06); finale reveal = 250+3n tics and F_StartFinale is
  SILENT (M9-10 — music slots are counters); face priority chain incl. the
  aim-frame-0 idle draw + 17-tic straight-face clock (M9-05); par row gate
  is `wbs->epsd < 3` (wi_stuff.c:1683-1686, re-measured at exit) — E1 under
  the shareware policy ALWAYS shows the par row (wi-time-par golden); the
  M9-07 journal line "par NEVER displayed in 1.10" is RETRACTED (true only
  for epsd ≥ 3, unreachable under this policy);
  secret exit ⇒ E1M9 unconditional.

## Next actions
1. M10 planning (audio: SFX bodies at the 41 kept sites + SMF synth A-03) —
   carry-overs in ROADMAP 'M10 preview'.
2. Orchestrator: merge task/M9-13-exit, re-run the full gate on main.

## Environment quirks
- git via /Library/Developer/CommandLineTools/usr/bin/git until Xcode license accepted by user (D007).
