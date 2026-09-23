# STATUS

## Current phase
Phase 3, M11 COMPLETE (persistence & options). Merged: T00, R01–R12, M1–M11
all tasks (plans + ledgers in docs/design, docs/TASKS.md). 11/12 milestones —
M12 (full-episode hardening) is next.

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
1. M12 planning: full-episode hardening — every-map sampled-viewpoint render
   corpus, reachable-exit routes, scripted playthroughs, perf gate (< 8
   ms/frame logged), release-docs seed (see ROADMAP "M12 preview").
2. Human playtest sign-offs pending: M10 ear session (MUSIC_TRIM, audible
   distance) + M11 hands session (docs/reports/M11-playtest.md).

## Environment quirks
- git via /Library/Developer/CommandLineTools/usr/bin/git until Xcode license accepted by user (D007).
- /tmp source mirror (linuxdoom-1.10): gutted by OS temp cleanup during M11 planning, RE-RESTORED from the canonical tarball — 62-`.c` gate re-verified at M11 planning AND green at this exit (`ls *.c | wc -l` == 62).
