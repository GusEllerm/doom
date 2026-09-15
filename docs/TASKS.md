# TASKS

Task ledger. Status: planned | dispatched | in-review | merged | blocked | failed-attempt-N.
Ids are stable; never renumber.

| ID | Title | Milestone | Depends | Status | Branch | Verification |
|---|---|---|---|---|---|---|
 | R01 | Research: WAD container + map lumps | M0 | — | dispatched | agent bf9d13fd | — |
 | R02 | Research: graphics data (PLAYPAL/COLORMAP/patches/flats/textures/sprites/anims) | M0 | — | done | docs/research/02-graphics-data.md | committed; verified vs id source |
| R03 | Research: BSP renderer | M0 | — | done | docs/research/03-bsp-renderer.md | committed 9187736 |
 | R04 | Research: simulation core (tic loop, fixed point, physics, blockmap, PRNG) | M0 | — | dispatched | agent aeafe550 | — |
 | R05 | Research: line/sector specials | M0 | — | dispatched | agent 95fb9480 | — |
 | R06 | Research: map objects / state tables (info model) | M0 | — | dispatched | agent f35ed03a | — |
 | R07 | Research: monster AI | M0 | — | dispatched | agent 10a87a80 | — |
 | R08 | Research: weapons + player | M0 | — | dispatched | agent 12c44d88 | — |
 | R09 | Research: UI (menus, status bar, automap, intermission, fonts, messages) | M0 | — | dispatched | agent 79e5040d | — |
 | R10 | Research: audio (DMX sounds, MUS, channels) | M0 | — | dispatched | agent d2ac3cd0 | — |
 | R11 | Research: persistence (savegames, demos) | M0 | — | dispatched | agent 0ecad421 | — |
 | R12 | Research: Freedoom (fetch, license, pinned release + SHA-256, map list, deltas) | M0 | — | dispatched | agent 7dd7d4c5 | — |
 | T00 | Scaffold: Vite+TS, check/e2e scripts, fetch-freedoom, debug API stub, first e2e, LICENSE, gitignore | M0 | — | dispatched | agent 4976fe0c | — |
| T01 | Test fixture tooling: WAD writer + tiny synthetic map builder | M0 | T00 | planned | — | — |

Future tasks will be added as architects decompose milestones.
