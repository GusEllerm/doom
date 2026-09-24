# Release notes — v0.12.0 (finalized at the M12-11 exit sweep, 2026-09-23)

A from-scratch TypeScript port of the 1993 DOOM engine (linuxdoom-1.10
lineage) running in the browser. GPL-2.0-or-later; no id Software assets
shipped — content is user-supplied (default: Freedoom Phase 1,
BSD-3-Clause). Quick start and self-hosting: see `README.md`; keys and
cheats: `CONTROLS.md`.

## Features by milestone

* **M1–M2** — WAD/texture/sprite/palette decoders; map loading; automap.
* **M3–M4** — software renderer: BSP walls, floors/ceilings/visplanes,
  skies, masked middles, 8-rotation thing sprites; 320×200.
* **M5** — 35 Hz fixed-point player physics; keyboard + pointer-lock
  mouse input.
* **M6** — level mechanics: doors, keys, lifts, crushers, stairs,
  switches, teleports, lights, damage floors, secrets, exits.
* **M7** — every pickup, weapon and power-up via the state tables;
  hitscan/projectile combat.
* **M8** — the Phase-1 monster roster: sight/sound wake, infighting,
  pain/death/gib, barrels.
* **M9** — game flow + UI: title, skill select, intermission tallies,
  end sequence, menus (keyboard + mouse), status bar, HUD messages.
* **M10** — audio: SFX mixer (priorities, attenuation, panning) +
  in-browser SMF music synthesis from the WAD's D_* lumps.
* **M11** — persistence: 10 save slots + quicksave in IndexedDB
  (vanilla-shaped header), settings hydration, byte-shape demos, the
  source-verified 1.10 cheat set.
* **M12** — full-episode hardening: every E1 map censused + rendered at
  ≥8 viewpoints with HOM=0, scripted reachable exits for all 9 maps,
  browser playthroughs, measured perf budget, soak/leak suites, license
  audit in `npm run check`, production-build e2e.

## By the numbers (measured at exit; evidence: `docs/reports/M12-exit.md`)

* **12 milestones** of the plan of record closed (M0 research → M12).
* **3574 unit tests** green across 185 files (2 gated skips), incl. a
  license-compliance audit inside `npm run check`.
* **74 Playwright tests in 20 spec files** (chromium + audio-profile +
  production-build projects; 8 golden sets drift-free, incl. the 126-entry
  `maps` set: 117 viewpoints × 9 E1 maps + 9 montage sheets, HOM = 0).
* **9 of 9 E1 maps** censused gap-free, rendered, and scripted to a
  reachable exit; 3 browser playthroughs (E1M1/E1M2/E1M8) + the E1M9
  finale chain.
* **Perf (measured, then pinned — never tuned to pass):** heaviest map
  (E1M7, 539 mobjs) sim p50 0.048 ms/tic, render p50 0.95 ms/frame;
  browser real-rAF worst frame p95 **2.4 ms** against a pinned 8/13 ms
  cap; 60.0 fps / 35.0 Hz sustained over 30 s scenes at 320×200.
* **Bundle: 181,516 B gzipped** game JS (cap 500,000 B), debug seams
  verified absent in the production build.
* **Soak:** 30-sim-minute marathon (63,000 tics, 77 level rotations,
  26 faithful level restarts): zero invariant violations, zero pool/heap
  leaks (flat plateau, no slope).

## Known limitations (stated, not folklore)

* **E1-only.** The shareware policy (`GAME_MODE = 'shareware'`) is
  pinned for this release: episode 1 on Freedoom Phase 1, with vanilla's
  episode-select ad divert. Freedoom Phase 1 carries all 36 maps; E2+
  remains dormant pending pars/verification (decision D-12b).
* **No netgame.** 1.10 netcode is out of scope; source markers are
  retagged "Post-M12 stretch" (decision D-12d).
* **Demos are ours-only.** Recorded demo bytes are vanilla-faithful in
  shape and replay identically *here*; interop with 1990s id demo files
  is unclaimed (decision D-12c).
* **Chromium-tested-first.** Automated tests run on Chromium; Firefox
  and Safari are covered by a manual matrix
  (`docs/reports/M12-browser-matrix.md`, M12-08), not CI (decision D-12e).
* **No offline app.** No service worker/PWA; the honest offline path is
  the file picker / `?wad=` (decision D-12f).
