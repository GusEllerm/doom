# Visual Review Board

Images that exist to be judged by human eyes (D016 gate). Open any with
`open -a Preview <path>` or double-click. Verdicts: paste back file paths +
"pass / fail + what looks wrong" — I log them in the table below.

Base dir: `/Users/gusellerm/Projects/doom/`

## Tier 1 — E1M1 real-world views (highest signal)

Criteria: correct perspective (verticals converge to eye height, no
stair-stepping wall joins); textures aligned to walls, no HOM (no garbage
bleeding across sectors); lighting matches room brightness; floor/ceiling
flats tile without seams; sprites stand ON the floor, upright, correctly
scaled (a zombie ≈ door-height, not postage-stamp or giant); sky only where
sky sectors exist.

| # | File | What to check | My pass | Your pass |
|---|------|---------------|---------|-----------|
| 1 | `tests/render/goldens/walls/e1m1-spawn-east.png` | spawn corridor: techwalls aligned, no gaps | ✓ (M3) | |
| 2 | `tests/render/goldens/walls/e1m1-atrium.png` | multi-height atrium + light variation | ✓ (M3) | |
| 3 | `tests/render/goldens/walls/e1m1-court-sky.png` | sky ONLY above sky-ceiling sectors; horizon clean | ✓ (M4) | |
| 4 | `tests/render/goldens/walls/e1m1-court-things.png` | items/barrels/monsters on ground, size ladder plausible | ✓ (M4) | |
| 5 | `tests/render/goldens/walls/e1m1-doorway-midtex.png` | middle-texture doorway: see-through above, solid below | ✓ (M3) | |
| 6 | `tests/render/goldens/walls/e1m1-busy-mix.png` | dense scene stress: no overlaps/flicker artifacts | ✗ never eyeballed | |
| 7 | `tests/render/goldens/walls/e1m1-vista-corridor.png` | long-corridor light falloff (COLORMAPS darkening) | ✗ | |

## Tier 2 — motion & mechanics strips (temporal behavior)

Criteria: read left→right as time; motion should feel DOOM (accel not
teleport; bob gentle ±~5px; machines cycle smoothly); labels/stats in-frame.

| # | File | What to check | My pass | Your pass |
|---|------|---------------|---------|-----------|
| 8 | `tests/render/goldens/motion/m5-10-walk-turn-step.png` | walk accel, bob wave, step-up squat on 24-unit ledge | ✓ (M5) | |
| 9 | `tests/render/goldens/mechanics/m6-door-through.png` | door rises → player passes → door shuts | ✗ (added at M6-05b, unreviewed) | |
| 10 | `tests/render/goldens/mechanics/m6-lift-through.png` | lift floor carries rider smoothly | ✗ | |
| 11 | `tests/render/goldens/mechanics/m6-crusher.png` | ceiling crush cycle, damage window visible | ✓ (M6 audit) | |
| 12 | `tests/render/goldens/mechanics/m6-light-paint.png` | strobe on/off duty cycle readable frame-to-frame | ✓ (M6 audit) | |

## Tier 3 — weapons (BEING REBLESSED — do not review yet)

M7-11 is fixing wrong sprites/positions (the "same blob centered" bug you
found). When the fix merges: `montage.png` must tile the 15 scene views
bottom-anchored (gun occupies bottom ~⅓, slightly right of center), and
every weapon visually distinct.

| # | File | Status |
|---|------|--------|
| 13 | `tests/render/goldens/weapons/montage.png` | BROKEN (monster sprites) — rework in progress |
| 14 | `tests/render/goldens/weapons/wpn-*.png` (15 files) | captured broken render — re-bless pending, then review round |

## Tier 4 — fixture geometry (sanity only; noise textures are intentional)

Fix textures/flats are generated test patterns, NOT game art. Judge
geometry/alignment only: wall joins watertight, panning offsets visible,
masked fences see-through-correct, sky room sky-correct.

| # | File | What to check |
|---|------|---------------|
| 15 | `tests/render/goldens/walls/fix-a-n.png` … `fix-d-w.png` (12 files) | box-room joins, no slivers |
| 16 | `tests/render/goldens/walls/fixmask-back.png` / `fixmask-fence.png` | masked draw |
| 17 | `tests/render/goldens/walls/fixsky-room.png` / `fixsky-seam.png` | sky seam continuity |
| 18 | `tests/render/goldens/walls/fixpan-panned.png` / `fixpan-rowskip.png` | texture alignment per offsets |

## Automap

Criteria: one-colored line work, player arrow + triangle trail, things as
dots (M3 features); free/pan/zoom modes as labelled.

| # | File | My pass | Your pass |
|---|------|---------|-----------|
| 19 | `tests/render/goldens/automap/e1m1-spawn-tab-20tics.png` | ✓ (M2) | |
| 20 | `tests/render/goldens/automap/e1m1-follow-noclip-forward-35.png` | ✓ (M2) | |
| 21 | `tests/render/goldens/automap/fix-free-panzoom-31.png` | ✓ (M2) | |

## Live browser shots (regenerable, not goldens)

Not stored in-repo. I regenerate on request (walk script + screenshot,
zero-console-error asserted). Useful for "does it FEEL right" checks:
walking feel, firing, menu-less boot look. Ask and I'll attach paths
(`/tmp/visual-*.png`).

## Logging format

Reply like: `#6 fail — garbage wedge bottom-left` or
`tests/render/goldens/walls/e1m1-busy-mix.png: looks off, sprites float`.
Each fail becomes a tracked investigation; findings beat goldens — the
goldens get re-blessed only with a source-explained cause.
