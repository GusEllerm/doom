# STATUS

## Current phase
Phase 3 COMPLETE, Phase 4 next (fidelity audits + playtest sweeps). **12/12
milestones closed** — M12 (full-episode hardening) landed 2026-09-23;
release v0.12.0 notes finalized (docs/release/notes.md).

## M12 exit state (M12-11)
- Gates fresh at exit: `npm run check` **185 files / 3574 tests** green (2
  skips; license-audit in-chain PASS), `npm run e2e -- --list` **74 tests /
  20 files** (chromium + audio + build; experimental firefox/webkit gated
  off, D-12e), goldens drift-free on ALL 8 sets incl. the new `maps` set
  (126 entries = 117 viewpoints × 9 E1 maps + 9 montage sheets, HOM=0 —
  allMaps suite re-run standalone: 128 green).
- **EVERY MAP REAL**: census ZERO gaps 9/9 (M12-census.md); render corpus
  117×9 D016-reviewed; exit routes 9/9 with per-tic trigger ledgers (the
  anti-B-11 teeth) + L4 playthroughs E1M1/E1M2/E1M8; E1M8 TRUTH: pinned
  WAD finale = W1 ring + ga_victory (no barons — faithful).
- **PERF = MEASURED, THEN PINNED** (D-12a): E1M7 sim p50 0.048 ms/tic,
  render p50 0.95 ms; browser worst frame p95 2.4 ms vs pinned 8/13 ms;
  60.0 fps/35.0 Hz sustained. Zero optimization commits — the profile is
  the deliverable. Bundle 181,516 B gz vs 500 KB cap, seams absent.
- **SOAK 0-LEAK**: 30-sim-min marathon, 63,000 tics, 77 rotations, 26
  faithful reborns, heap plateau flat, Δ0 reload bands (RESULTS.md).
- B-11 elevator saga CLOSED not-a-defect (D-12g); sensitivity persistence
  fixed in-milestone (D-12h). Release docs + license gate landed.


## M11 exit state (M11-12)
- Gates (fresh at exit): `npm run check` 179 files / **3380 tests** green (2
  skips), `npm run e2e` **59 green** (4 project-scoped skips; the ×2-
  consecutive hold carried from M11-11's finisher — this sweep ran once, green),
  goldens `--check` drift-free on ALL sets: automap 5 / walls 31 / weapons 15
  / screens 5 / m9 27 / audio 13 / **persist 12** (first milestone with the
  persist set; byte-sha of the REAL saved bytes, matrix = save@T → cold
  hydrate → 300-tic continuation equality).
- **SAVES LIVE**: vanilla-header codec (24B description, `"version 110"`,
  `0x1d`, SAVEGAMESIZE cap; typed BadVersion/BadMarker) + `DBP1` payload —
  THE MONEY SHOT: save → real `page.reload()` → load → exact `state().hash` +
  12100 sampled pixels + 100-tic trajectory identity (e2e test 1). Thinker
  fidelity per p_saveg.c (players→world→mobj-thinkers→7 special classes;
  doors/plats/crushers mid-move survive — mover-at-save goldens). Load ⇒ RNG
  streams reset (`M_ClearRandom` truth) — the reload-determinism backbone.
- **SETTINGS LIVE**: default.cfg ≡ IndexedDB (41-row m_misc.c census, defaults
  byte-equal; write-on-change; hydrate OFF the sim clock, applied pre-first-
  tic — volumes/binds/sensitivity proven across a real reload; fail-closed
  ladder: blocked IDB boots silent-clean on the memory backend).
- **CHEATS LIVE** (source inventory, not folklore): iddqd/idfa/idkfa/
  idspispopd/idclip/idbehold*/idchoppers/idmus(ep,map)/idmypos/idclev/iddt —
  typed-stream SCRAMBLE matcher at the ST_Responder slot; folklore exorcised
  (no F2/F3 quicksave — F6/F9 exist; `idkdt`/bare-`noclip`/`mypos`/`dtent`
  tested to do NOTHING); cheats ride the savegame (player_t payload).
- **DEMOS LIVE as bytes**: 13B header + 4B/player/tic + DEMOMARKER, record→
  replay hash identity, downloadable `.lmp`; demo END leaves the level
  PLAYABLE (`G_DeferedInitNew` truth — the folklore "back to title" died).
- **SALVAGE #10 + #11 both CLOSED GREEN** (the milestone's other story): two
  silent-death worktrees (M11-08 corpus, M11-11 e2e) recovered via
  salvage-branch + finisher — 50/50 and 6/6×2, ZERO src bugs from #10, one
  wiring-zone production fix from #11. Protocol lessons in DECISIONS.md.
- D-11a..g CLOSED-IMPLEMENTED + folklore deaths register in DECISIONS.md;
  D023 reaffirmed (attract unchanged, zero DEMO lumps in the pinned WAD).

## Next actions
1. **Phase 4**: per-area fidelity audits (renderer/movement/specials/
   monster families/weapons/UI/audio/decoders) against the research notes,
   findings → ledger tasks → fix wave → re-audit; playtest sweeps reuse
   THIS milestone's route/soak/perf harnesses (see ROADMAP "Post-M12").
2. Human sign-offs pending: M10 ear + M11 hands playtest checklists,
   M12 montage re-view (docs/VISUAL-REVIEW.md), firefox/webkit manual
   matrix (docs/reports/M12-browser-matrix.md).

## Environment quirks
- git via /Library/Developer/CommandLineTools/usr/bin/git until Xcode license accepted by user (D007).
- /tmp source mirror (linuxdoom-1.10): gutted by OS temp cleanup during M11 planning, RE-RESTORED from the canonical tarball — 62-`.c` gate re-verified at M11 planning AND green at this exit (`ls *.c | wc -l` == 62).
