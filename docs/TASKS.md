# TASKS

Task ledger. Status: planned | dispatched | in-review | merged | blocked | failed-attempt-N.
Ids are stable; never renumber.

| ID | Title | Milestone | Depends | Status | Branch | Verification |
|---|---|---|---|---|---|---|
 | R01 | Research: WAD container + map lumps | M0 | — | done | docs/research/01-wad-container.md | committed; verified vs id source + freedoom E1M1 |
 | R02 | Research: graphics data (PLAYPAL/COLORMAP/patches/flats/textures/sprites/anims) | M0 | — | done | docs/research/02-graphics-data.md | committed; verified vs id source |

 | R04 | Research: simulation core (tic loop, fixed point, physics, blockmap, PRNG) | M0 | — | done | docs/research/04-simulation-core.md | committed; verified vs id source |
 | R05 | Research: line/sector specials | M0 | — | done | agent 95fb9480 | verified |
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

## M1/M2 + cross-cutting tasks (from docs/design/M1-plan.md, M2-plan.md — full briefs live there)
| ID | Title | Milestone | Depends | Status | Branch | Verification |
|---|---|---|---|---|---|---|
| M1-01 | Contract: wad types + decode signatures | M1 | — | done (merged 89bdb7b) | — | — |
| A-INT1 | ESLint import-boundary zones | M1 | — | done (merged 886b852) | — | — |
| A-FX1 | core/fixed.ts + BigInt-oracle tests | M2(w0) | M1-01(loose) | done | merged 0e77c58 | oracle-green |
| M1-02 | WadFile parse/lookup | M1 | M1-01 | done | merged | green on main |
| M1-03 | PLAYPAL/COLORMAP decoders | M1 | M1-01 | planned | agent a5389860 | — |
| M1-04 | Patch decoder | M1 | M1-01 | done | merged 553e3b7 | green |
| M1-05 | Fixture-WAD micro-builder | M1 | M1-01 | done | merged | green on main |
| M1-06 | Flat + TEXTURE1/PNAMES decoders | M1 | M1-04,M1-05 | done | merged (M1-06 merge commit) | goldens ran |
| M1-07 | Sprite definition loader | M1 | M1-02,M1-05 | done | merged 24a7d1e | goldens ran |
| M1-08 | Debug viewer page | M1 | M1-02..07 | done | merged | e2e green |
| M1-09 | IWAD goldens + viewer e2e | M1 | M1-08 | done | merged d57944a | 301/301, 0 skips |
| M2-01 | Grid BSP splitter (fixtures) | M2 | M1-05 | done | merged 1491c41 | green |
| M2-02 | Rectangle-spec map generator + BSP property test | M2 | M2-01 | done | merged | green |
| M2-03 | mapdata lump decoder | M2 | M1-02,M2-02 | done | merged 0bcadcf | 33 tests, E1M1 goldens |
| M2-04 | Sim map setup (p_setup) | M2 | M2-03 | done | merged | 20 tests |
| M2-05 | Blockmap runtime + BSP point loc | M2 | M2-04 | done | merged | green |
| M2-06 | Sim skeleton + headless harness | M2 | M2-04 | done | merged | 361 tests green |
| M2-07 | Noclip fly movement + debug wiring | M2 | M2-05,M2-06 | done | merged | 392 tests |
| M2-08 | Automap state machine | M2 | M2-06 | dispatched (agent d62d873b) | — | — |
| M2-09 | Automap renderer + arrow | M2 | M2-05,M2-08 | planned | — | — |
| M2-10 | Golden automap frames + M2 e2e | M2 | M2-09 | planned | — | — |
