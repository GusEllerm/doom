# STATUS

## Current phase
Phase 3, M8 COMPLETE (monsters + DEHACKED fullbright). Merged: T00, R01–R12,
M1–M8 all tasks (plans + ledgers in docs/design, docs/TASKS.md).

## M8 exit state (M8-13)
- Gates: `npm run check` 2476 green, `npm run e2e` 27 green, goldens +
  motion + mechanics sets drift-free (`--check`).
- L5 mechanics strips: +m8-chase-corner / m8-pain-death / m8-infight
  (tests/render/goldens/mechanics, meta reason 'M8-13 L5'; human-eyes
  review per D016 — plates are synthetic, captions carry the sim truth).
- NEW pacing envelope suite: tests/headless/m8-pacing.test.ts — derived
  floor (2 POSS @512: death ≥137), derived ceiling (6 SARG melee: ≤146),
  skill monotonicity (melee rig exact-equal 1–4, baby strictly later),
  reaction floor (wake+28/+38), every bound cited, measurements blessed.
- NAMING: MT_TROOPSHOT is the canonical imp-fireball name (code + tests +
  table agree); the old journal claim 'imp missile = MT_FIRE' was WRONG —
  MT_FIRE = explosion flame FX (mobjinfo row 4); doomednum 58 = MT_SHADOWS.
- FINDINGS: production renderer draws NO monsters (KIND_MONSTER 'excluded
  until M8') → strips compose the thing list test-side (D018); same-species
  missiles explode WITHOUT damage (pmissiles.ts:205-215) — infight strips
  need a species pair; POSS/SPOS have no meleestate (mobjinfo meleeState 0).

## Next actions
1. M9 planning (game flow & UI) + the three carry-overs in ROADMAP 'M9 preview'.
2. Orchestrator: merge task/M8-13-exit, re-run the full gate on main.

## Environment quirks
- git via /Library/Developer/CommandLineTools/usr/bin/git until Xcode license accepted by user (D007).
- Infra failure waves have killed agents repeatedly: keep dispatches scoped, write-early, commit-often.

## M8 COMPLETE — monster AI
- 13/13 tasks; sight tracer, AI core, damage/kill/infight, 3 families, DEHACKED fullbrights, live e2e, pacing envelopes
- Gates: ~2450 unit + 27 e2e, marathon determinism (4.6M steps), goldens drift-free, strips reviewed
- TRUTH bank added: painChance 200 always-pained; P_PushMobs mass rules; A_Fall@death+24; MT_HEADSHOT/BRUISERSHOT; tag-666 E1 exit; no FLOATBOB in 1.10; NoiseAlert from attack-actions only
