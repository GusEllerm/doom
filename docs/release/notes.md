# Release notes — v0.12.0 (skeleton; finalized with the tag by M12-10)

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
  (`docs/release/browser-matrix.md`, M12-08), not CI (decision D-12e).
* **No offline app.** No service worker/PWA; the honest offline path is
  the file picker / `?wad=` (decision D-12f).
