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
| M2-08 | Automap state machine | M2 | M2-06 | done | merged a7b595b | 454 tests |
| M2-09 | Automap renderer + arrow | M2 | M2-05,M2-08 | done | merged c5272e8 | 5/5 e2e |
| M2-10 | Golden automap frames + M2 e2e | M2 | M2-09 | done | merged 410d974 | goldens+check green |

## M3 tasks

| ID | Title | Milestone | Deps | Status |
|---|---|---|---|---|
| M3-01 | Light tables (zlight/scalelight/colormaps) | M3 | — | done (merged c9b51c9, green) |
| M3-02 | Render world load (segs SoA, textures, columns) | M3 | — | done (merged, green) |
| M3-03 | solidsegs + HOM counters | M3 | — | done (merged, 17 tests) |
| M3-04 | BSP walk + view setup | M3 | M3-01/02/03 | done (merged, 19 tests) |
| M3-05 | Wall column blit (R_DrawColumn) | M3 | M3-01/02 | done (merged, 13 tests) |
| M3-06a | StoreWallRange/RenderSegLoop port (+drawsegs audit) | M3 | M3-02..05 | done (merged) |
| M3-06b | Seg renderer test matrix + integration goldens-smoke | M3 | M3-06a | done (merged, 17 pass/1 skip→FIX-M3-06c) |
| M3-07 | Frame pipeline + boot + viewpoint debug API | M3 | M3-06 | done (merged, 7 e2e green) |
| M3-08 | Viewpoint goldens (20+) + HOM + L5 | M3 | M3-07 | done (merged, 20 goldens, all gates green) |
| M3-06c | FIX: negative-base openings refs (segs.ts) | M3 | M3-06b | done (merged 2dfa365; 588/588, 0 skips) |

## M4 tasks

| ID | Title | Milestone | Deps | Status |
|---|---|---|---|---|
| M4-01 | Visplane engine (r_plane.c) | M4 | M3 stack | done (merged, 48 tests) |
| M4-02 | Flat/sky data wiring | M4 | — | done (merged, 24 tests) |
| M4-03 | Static thing/sprite tables | M4 | — | done (merged, 25 tests) |
| M4-04 | Plane marking + drawMasked | M4 | M4-01/02 | done (merged) |
| M4-05 | Static sprite pass (R_AddSprites/DrawVisSprite) | M4 | M4-03 | done (merged f47160f + fixup) |
| M4-06 | Fixture extension (sky/fences/things/panning) | M4 | M4-01..03 | done (merged) |
| M4-07 | Full-frame pipeline integration | M4 | M4-04/05 | done (merged e258081) |
| M4-08 | Goldens re-bless (≥24) + L5 | M4 | M4-07 | done (merged) |
| M4-09 | FIX: openings-ref sentinel collision (masked flush) | M4 | M4-08 | done (merged) |
| M4-10 | FIX: sidedef mid/bottom slot decode (mapdata) | M4 | M4-09 | done (merged) — M2-03 era bug root-caused |

## M5 tasks

| ID | Title | Milestone | Deps | Status |
|---|---|---|---|---|
| M5-01 | p_maputl primitives | M5 | — | done (merged) |
| M5-02 | P_CheckPosition + thinglinks | M5 | M5-01 | done (merged) |
| M5-03 | P_TryMove + TeleportMove shell | M5 | M5-02 | done (merged) |
| M5-04 | P_SlideMove + HitSlideLine | M5 | M5-03 | done (merged) |
| M5-05 | P_XYMovement + P_ZMovement | M5 | M5-03 | done (merged) |
| M5-06 | p_user replaces fly stub (D009 close) | M5 | M5-05 | done (merged) |
| M5-07 | Mouse input (pointer-lock platform + ticcmd) | M5 | — | done (merged) |
| M5-08 | Live-page integration + L4 e2e | M5 | M5-06/07 | done (merged) |
| M5-09 | L2 scripted-tic feel goldens | M5 | M5-06 | done (merged, 23 tests) |
| M5-10 | M5 exit + L5 motion review | M5 | M5-08/09 | done (merged) |

## M6 tasks

| ID | Title | Milestone | Deps | Status |
|---|---|---|---|---|
| M6-01 | Thinker arena + live world + hook slots | M6 | M5 | done (merged, 1001 tests) |
| M6-02 | Fixture specials/tags/things | M6 | — | done (merged, 143 fixture tests) |
| M6-05 | Vertical doors (37 ids) | M6 | M6-03/04 | done (merged — verified) |
| M6-06 | Plats/lifts (21 ids) | M6 | M6-03/04 | done (merged) |
| M6-07 | Floors/stairs/donut (43 ids) | M6 | M6-03/04 | done (merged t2, salvage) |
| M6-08 | Ceilings incl crushers (13 ids) | M6 | M6-03/04 | done (merged t2, 19 tests) |
| M6-09 | Lights + sector light specials | M6 | M6-03 | done (merged; headless goldens re-blessed w/ reason) |
| M6-10 | Teleporters (4 ids) | M6 | M6-03 | done (merged, 32 tests) |
| M6-11 | Switches/locked doors/cards | M6 | M6-05/09 | done (merged; registry manifest complete) |
| M6-12 | Sector specials at feet + exits | M6 | M6-03/04 | done (merged, 19 tests) |
| M6-13 | Fixture corpus + E1M1 route e2e + L5 | M6 | all | done (merged — verified) |

## M7 tasks

| ID | Title | Milestone | Deps | Status |
|---|---|---|---|---|
| M7-01 | State-table infra + ActionId registry | M7 | M5/M6 | done (merged 78d38d2, 1764 tests) |
| M7-07 | Psprite state machine + weapon view layer | M7 | M5/M6 | done (merged, verified — gun layer live) |
| M7-02 | mobj runtime + ZMISC + thinglinks fill | M7 | M7-01 | done (merged, verified) |
| M7-03..11 | (see docs/design/M7-plan.md) | M7 | waves | planned |
| M7-03 | Player states, pain/death, reborn | M7 | M7-01/02 | done (merged, verified — third time lucky) |
| M7-04 | Pickups + inventory | M7 | M7-02 | done (merged, verified) |
| M7-08 | Hitscan aim/attack/traverse | M7 | M7-02/07 | done (merged, verified) |
| M7-05 | Ammo economy + weapon switching | M7 | M7-02/03/04 | dispatched (agent 98462a18) |
| M7-06 | Powerup render effects + palettes | M7 | M7-02/04 | done (merged, verified) |
