# ROADMAP

Status legend: [ ] planned, [~] in progress, [x] done, [!] blocked
Refined by the Phase-2 architect; per-milestone leaf plans live in docs/design/M*-plan.md. Test layers (L1-L5) = PROMPT §9 / ARCHITECTURE §6.

## Milestones

| # | Milestone | Demonstrable exit criteria | Depends | Status |
|---|---|---|---|---|
| M0 | Research + architecture + scaffold | `npm run check` + `npm run e2e` green on main; 12/12 research notes; ARCHITECTURE.md accepted; fetch-freedoom checksum-verified (D005); debug-API stub live (L4 first e2e) | — | [~] |
| M1 | WAD & data decoding (plan: M1-plan.md) | Viewer page renders any patch/flat/TEXTURE1-texture/sprite from freedoom1.wad with palette 0 (L4 canvas asserts + L5 screenshot review); all decoders golden-hash unit-tested on synthetic fixtures, IWAD goldens skipIf-gated (L1); fixture-WAD builder green (L1) | M0 | [x] |
| M2 | Map loading + automap + noclip arrow (plan: M2-plan.md) | E1M1 mapdata decoded with R01-quirk goldens (L1); BSP property test + fixed-point oracle green (L1, A-04/A-01); TAB opens automap, keyboard-fly white arrow moves in noclip (L4 real keys, L2 scripted step); automap golden frames incl. E1M1 skipIf (L3) + L5 review | M1 | [x] |
| M3 | Wall renderer | BSP walls w/ upper/lower/middle textures, light buckets + zlight diminishing, solidsegs occlusion; ≥20 sampled viewpoints on fixture+E1M1 with L3 goldens; `state().render.hom == 0` on all; L5 review | M2 | [x] |
| M4 | Planes, sky, masked, things | Floors/ceilings/visplanes, F_SKY1 sky, masked middles drawseg-clipped, static thing sprites 8-rot + clipped vs walls; L3 goldens at viewpoints; HOM=0; L5 review | M3 | [x] |
| M5 | Player physics + input | 35 Hz tics via rAF accumulator (L2 scripted-cmd goldens: momentum/friction/step-up/fall/bob hashes); keyboard + pointer-lock mouse (L4); p_user replaces M2 fly-stub, same collision path as AI | M2 (M3 for visual check) | [x] |
| M6 | Level mechanics | Per-special fixture-map L2 tests: doors/locked keys/lifts/crushers/stairs/switches/teleporters/lights/damage floors/secrets/exits (R05 tables 100% covered); E1M1 integration: reach exit via keys (L4 scripted route) | M5 | [x] |
| M7 | Items & weapons | Every pickup + weapon via state tables; hitscan/projectile/autoaim/splash L2 goldens; powerups + palette flashes visible (L3 viewpoint diffs, L4 fire-weapon keys) | M6 | [ ] |
| M8 | Monsters (+ DEHACKED fullbright task, A-02) | Full Phase-1 roster from state tables; wake on sight/sound, melee/missile, pain/death/gib, infighting, barrels — L2 per-family fixtures + random-site counts; L5 death-state screenshot review | M7 | [ ] |
| M9 | Game flow & UI | Title→skill→play→exit→intermission tally→next map→end screen (all original/Freedoom text); menus keyboard+mouse operable (L4 real clicks/keys, zero console errors); status bar + face + messages (L3 goldens) | M7 | [ ] |
| M10 | Audio (SMF synth task per A-03; MUS behind flag) | SFX with priority/attenuation/panning (L1 mixer unit tests + offline-mix golden buffers); SMF music plays in e2e without console errors; volume settings take effect (L4) | M9 (any sim≥M7) | [ ] |
| M11 | Persistence & options (IndexedDB task per A-10) | F6/F9 + menu save/load round-trip in browser: `state().hash` equals pre-save (L4 in-browser IDB test); bindings/sensitivity/volumes persisted across reload; raw-buffer serialize/deserialize L1 goldens | M9 | [ ] |
| M12 | Full-episode hardening | Every Freedoom P1 map loads + renders at ≥8 sampled viewpoints with HOM=0 and no single-color/anomaly flags (L3 corpus); reachable exit per map (L2/L4 route); scripted playthrough of E1M1 + one map per episode (L4); perf log: 35 Hz sim + 60 fps on mid-range laptop | M1–M11 | [ ] |
| P4 | Fidelity audits (see below) | ≥2 audit rounds; final round with zero high-severity findings; playtest sweep report clean | M12 | [ ] |
| P5 | Release + stretch | DONE_REPORT.md maps every §3 criterion to evidence; README; then stretch milestones below | P4 | [ ] |

## Cross-cutting task placement
- Fixture tooling chain (A-04): T01 (M0 WAD writer) → M1-05 (graphics fixtures) → M2-01/M2-02 (rectangle-spec maps + BSP property test) → feature-per-fixture maps in M5-M8 plans.
- Boundary enforcement (A-06): task **A-INT1** in M1 wave 0 (eslint `no-restricted-imports`/globals zones in `npm run check`); dependency-cruiser revisit at M12 audit only if rule gaps surface.
- Differential fixed-point oracle (A-01): task **A-FX1** in M2 wave 0 (BigInt-oracle + known-vector tests gate all sim math).
- DEHACKED fullbright parser (A-02): one M8 task (`wad/dehacked.ts` + table-build hook).
- SMF synth (A-03): two M10 tasks (SMF→event-list decoder with L1 goldens; subtractive-lite GM synth + scheduler).
- IndexedDB persistence (A-10): one M11 task (`platform/storage.ts` + in-browser e2e).

## Post-M12 (Phase 4) and stretch
- Audit rounds: per-area auditors (renderer, movement, specials, each monster family, weapons, UI, audio, data decoders) diff impl vs research notes → findings become ledger tasks → fix wave → re-audit; repeat until no high-severity findings.
- Playtest sweeps: scripted routes + noclip camera passes over every map; report HOM, texture pops, sprite bleed-through, NaNs, frame drops.
- Performance: profiling task on the heaviest P1 maps (budget < 8 ms/frame, logged in JOURNAL).
- Stretch (in order, each its own milestone run): `.lmp` demo playback; Doom II / Freedoom Phase 2; widescreen + higher resolutions; optional mouselook; GM soundfont for music.

