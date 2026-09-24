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
| M7 | Items & weapons | Every pickup + weapon via state tables; hitscan/projectile/autoaim/splash L2 goldens; powerups + palette flashes visible (L3 viewpoint diffs, L4 fire-weapon keys) | M6 | [x] |
| M8 | Monsters (+ DEHACKED fullbright task, A-02) | Full Phase-1 roster from state tables; wake on sight/sound, melee/missile, pain/death/gib, infighting, barrels — L2 per-family fixtures + random-site counts; L5 death-state screenshot review | M7 | [x] |
| M9 | Game flow & UI | Title→skill→play→exit→intermission tally→next map→end screen (all original/Freedoom text); menus keyboard+mouse operable (L4 real clicks/keys, zero console errors); status bar + face + messages (L3 goldens) | M7 | [x] |
| M10 | Audio (SMF synth task per A-03; MUS behind flag) | SFX with priority/attenuation/panning (L1 mixer unit tests + offline-mix golden buffers); SMF music plays in e2e without console errors; volume settings take effect (L4) | M9 (any sim≥M7) | [x] |
| M11 | Persistence & options (IndexedDB task per A-10) | F6/F9 + menu save/load round-trip in browser: `state().hash` equals pre-save (L4 in-browser IDB test); bindings/sensitivity/volumes persisted across reload; raw-buffer serialize/deserialize L1 goldens | M9 | [x] |
| M12 | Full-episode hardening | Every Freedoom P1 map loads + renders at ≥8 sampled viewpoints with HOM=0 and no single-color/anomaly flags (L3 corpus); reachable exit per map (L2/L4 route); scripted playthrough of E1M1 + one map per episode (L4); perf log: 35 Hz sim + 60 fps on mid-range laptop | M1–M11 | [x] |
| P4 | Fidelity audits (see below) | ≥2 audit rounds; final round with zero high-severity findings; playtest sweep report clean | M12 | [ ] |
| P5 | Release + stretch | DONE_REPORT.md maps every §3 criterion to evidence; README; then stretch milestones below | P4 | [ ] |

## M9 — CLOSED (M9-13 exit sweep green; see STATUS "M9 exit state" + docs/reports/M9-13-exit-sweep.md)
All three M9-preview carry-overs landed: production monster pixels (D018
flipped, M9-09), G_ExitLevel/A_BossDeath → ga_completed → WI routing (M9-03/
08, E1M8⇒finale + E1M9⇒E1M4 pins), damageBridge production wiring (live
combat through the loop; e2e m9-flow). D017 retired; D019-D023 ratified.

## M10 — CLOSED (M10-12 exit sweep green; see STATUS “M10 exit state”)
All exit criteria landed: mixer goldens + 8 offline-mix buffers + E1M1
firefight golden drift-free; the 41-site silent-M9 ledger swapped IN PLACE
(`sfxStub(` outside hooks.ts == 0) with ZERO stream/golden regression
(D-10a proof in tests/audio/regression.test.ts); SMF music plays per level /
title / intermission / finale in e2e with zero console errors ×2; volume
thermos move the real bus gains (L4, D-10d law). D-10a..f closed;
corrections register in DECISIONS.md.

## M11 — CLOSED (M11-12 exit sweep green; see STATUS "M11 exit state" + DECISIONS D-11a..g)
Every exit criterion landed: menu save/load + F6/F9 across a REAL page reload
with exact `state().hash` + pixel + trajectory identity (e2e money shot); the
vanilla-header `DBP1` codec + 12-scene raw-buffer golden corpus; the
default.cfg ≡ IndexedDB settings store (volumes/binds/sensitivity applied
PRE-first-tick across reloads); demo record→replay hash identity (no checksum,
like vanilla); the full source-verified 1.10 cheat set live on the real page
(idmus slot consumed); attract unchanged (D023 reaffirmed). Two silent-death
salvages (#10 M11-08, #11 M11-11) both closed green.

## M12 — CLOSED (M12-11 exit sweep green; see STATUS "M12 exit state" + docs/reports/M12-exit.md)
Nine maps censused zero-gap, 117-viewpoint × 9-map L3 corpus (HOM=0, D016
reviewed), 9/9 scripted exit routes + L4 playthroughs, 30-min soak 0-leak,
perf measured-then-pinned (worst browser frame p95 2.4 ms vs 13 ms cap, zero
optimization commits), 181,516 B gz production build, license audit as a
check-gate — Phase 4 (fidelity audits + playtests) is next.

## M12 preview (post-M11 carry-overs the exit sweep recorded)
- **Every-map render corpus (THE milestone):** every Freedoom Phase 1 map
  loaded + rendered at ≥8 sampled viewpoints, HOM == 0, no single-color /
  anomaly flags (L3); per-map structural audits (subsector/blockmap sanity).
- **Reachable exit per map** (L2/L4 scripted route) + scripted playthrough of
  E1M1 and one map per episode in the browser (L4).
- **Perf gate:** profiled log — 35 Hz sim + 60 fps on a mid-range laptop over
  the heaviest P1 maps (budget < 8 ms/frame, logged in JOURNAL).
- **Release docs seed:** README + evidence skeleton that P5's DONE_REPORT
  grows from.
- **Carried, still deferred (counted, none new-console):** chat sfx +
  `HU_dequeueChatChar` (netgame-only input; singleplayer never reaches it);
  bind-menu UI (D-11d, 1.9 feature with no 1.10 truth); netgame save
  semantics + `M_EndGame` confirm variants; user-demo ATTRACT playback
  (D023/ROADMAP stretch — the bytes machinery already exists); pause
  affordance (latch ported, unwired by design); the human-ears M10 playtest
  and the human-hands M11 playtest checklists (docs/reports/) want sign-off
  sessions — they exist precisely for the two things automation cannot see.

## M11 preview (post-M10 carry-overs the exit sweep recorded)
- **Persistence (A-10)**: F6/F9 + menu save/load round-trip in browser
  (`state().hash` equals pre-save, in-browser IDB e2e); raw-buffer
  serialize/deserialize L1 goldens. R11’s tagged-binary design is the base.
- **Key bindings + sensitivity** menu (M_bind/M_ControlPanel rows) — bindings
  and sensitivity persisted across reload (volumes ride the SAME save).
- **Volume PERSISTENCE rides saves**: M10 ships SESSION-ONLY volumes
  (plan §3 deferred note — default.cfg ≡ IndexedDB is explicitly M11 scope).
- **Cheats**: the idmus<nn> music-switch slot is reserved at the M9 cheat
  deferral note; chat sfx (hu_stuff radio/tink — the sfx_radio path) joins
  the cheat/chat suite.
- **Demos**: the attract keeps the full D_DoAdvanceDemo shape (D023) —
  demo-recording plumbing lands with the .lmp playback task (playback
  remains Post-M12 stretch per ROADMAP stretch list); title-music one-shot
  re-arm already matches the cycle.
- **Pause-music: N/A-faithful** — vanilla 1.10’s S_PauseSound call site is
  dead code (no pause key; g_game.c:705-712 unreachable). The sPause/
  sResumeMusic latch is PORTED (M10-08) but unwired by design; `__doom
  .pause()` keeps music playing. If M11 adds a pause affordance, the latch
  attaches at that seam (e2e/m10-audio.spec.ts header states this openly —
  not silently passed).

## M10 preview (post-M9 carry-overs the exit sweep recorded)
- **SFX bodies at the 41 kept sites** (`hooks.sfxStub` → real mixer): the
silent-M9 ledger (docs/reports/M9-13-exit-sweep.md D-list) IS the worklist;
D-0xx boundary = sites never move, bodies land in place. Priority/
attenuation/panning per S_StartSound (sfx.c/p_sfx.c), volumes wired to the
SoundDef thermos state (currently stored, silent).
- **Music**: mus_intro (title), mus_victor (finale), mus_read/mus_nlink
slots are sfxStub counters already at their vanilla call addresses
(title.ts/finale.ts/wintermission.ts); SMF synth per A-03, MUS behind flag.
- **Quit-yes target** is D_StartTitle (D021) — if M10+ adds a real page-
exit/reload affordance it attaches at the same mQuitResponse seam.
- Menu mouse + keyboard stay as-is (D020); volume/sensitivity persistence
is M11 (IndexedDB A-10), cheats + save/load + chat remain registered
no-op stubs until M11.

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

