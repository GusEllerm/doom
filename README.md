# DOOM in the browser — a from-scratch TypeScript port

A clean-room-in-spirit port of the 1993 DOOM engine (the released
`linuxdoom-1.10` source lineage) to the browser: fixed-point game
simulation, software renderer, and all — running in TypeScript, with no
id Software assets shipped or embedded. Licensed **GPL-2.0-or-later**
(see [`LICENSE`](LICENSE) and [`CREDITS.md`](CREDITS.md)).

Game content comes from [Freedoom](https://freedoom.github.io/)
(BSD-3-Clause), fetched or loaded by you at run time. By default this
port runs the shareware policy on Freedoom Phase 1: **episode E1
(E1M1–E1M9)**.

## Play

Prerequisites: Node LTS and npm.

```sh
npm ci
npm run fetch-freedoom   # = node scripts/freedoom/fetch.mjs
                         # downloads freedoom-0.13.0.zip, verifies its
                         # sha256, extracts wads/freedoom1.wad (verified)
npm run dev
```

Open the URL Vite prints (`http://localhost:5173/` by default) and
**click once** — browsers refuse to start audio until a user gesture, so
sound and music arm on your first click. Then play:

* Click the canvas to capture the mouse (Esc releases it, and the browser
  opens the menu); keyboard-only play works too.
* Controls, keys, automap and cheats: **[CONTROLS.md](CONTROLS.md)**.

## What you get (v0.12.0, honest version)

* **Single-player DOOM, episode E1** on Freedoom Phase 1 — title →
  skill → play → intermission tallies → next map → end credits, with the
  original shareware menu behavior (choosing "episode 2" shows the
  classic order-the-trilogy ad page, because that is what 1.10 does).
* **35 Hz fixed-point simulation** — the sim runs the original tic
  loop (`TICRATE = 35`, integer fixed-point math) decoupled from the
  render loop; gameplay does not change with your monitor's refresh
  rate.
* **Software renderer** — BSP wall/flat/sprite pipeline at DOOM's native
  320×200, scaled to your window; automap overlay, status bar, screen
  size (–/=) and gamma (F11).
* **Sound and music** — WebAudio mixer with vanilla priorities and
  panning; music synthesized in-browser from the WAD's SMF lumps.
* **Saves** — 10 slots + quicksave in IndexedDB with a vanilla-shaped
  header; save, close the tab, reopen, load — the level comes back where
  you left it.
* **Demos** — the vanilla demo format is implemented and replays
  byte-shape faithfully *for demos this port records* (driven through the
  test/debug seam — 1.10 has no in-game record key, and loading external
  `.lmp` files is Post-M12); interop with old id demo files is not
  claimed. The attract screen is TITLEPIC-only.
* **Cheats** — the source-verified 1.10 set (`iddqd`, `idmus<nn>`,
  `idclev<ep><map>`, …), folklore duly dead — see
  [docs/reports/M11-cheats.md](docs/reports/M11-cheats.md).

No netgame. No widescreen. Chromium-tested-first (see below).

## FAQ

**Why does sound start only after the first click?**
Autoplay policy: an `AudioContext` cannot start uninvited, so the graph
is built muted and resumed on the first pointer/key gesture
([src/audio/context.ts](src/audio/context.ts)). Everything before that
first click is by design silent — the game itself is running normally.

**Why do the menus only offer E1 (and the ad page)?**
The port pins the shareware policy
([src/sim/gamemode.ts](src/sim/gamemode.ts), `GAME_MODE = 'shareware'`):
episode 1 only, with vanilla's episode-select ad divert. Freedoom
Phase 1 actually contains all 36 maps — the restriction is the policy
constant plus the vanilla episode clamp, not a data limit. Unlocking E2+
is a documented follow-up, not a mystery.

**How do I run the tests?**

```sh
npm run check     # tsc + eslint + vitest unit suites + license audit
npm run e2e       # Playwright end-to-end (chromium; `npx playwright install chromium` once)
node scripts/goldens-update.mjs --check   # render golden drift check
```

Most headless and all render tests want `wads/freedoom1.wad` present —
run `npm run fetch-freedoom` first.

## Build & self-host

```sh
npm run build     # → dist/ (single JS chunk ≈ 182 KB gzipped; cap
                  #    500 KB gz is asserted by e2e/build.spec.ts)
npm run preview   # serves dist/ AND wads/ (like dev)
```

The WAD is never in `dist/` — nothing we ship is copyrighted game
content. To self-host on any static file server:

1. Serve `dist/` as the site root, **and** put a `freedoom1.wad` under
   `<site>/wads/freedoom1.wad` — that is the boot default, or
2. Link with `?wad=<url>` to a WAD anywhere you can CORS from, or
3. Do nothing — when `/wads/freedoom1.wad` 404s the page offers a file
   picker and plays a WAD you select locally (nothing is uploaded).

There is no service worker / PWA: "offline" honestly means the
file-picker path above.

**Browser support:** automated tests run against Chromium first. The
release-time manual matrix for Firefox and Safari (known per-engine
risks: IndexedDB in private mode, autoplay gestures, pointer-lock UX) is
tracked in `docs/release/browser-matrix.md` (M12-08, landing with this
milestone's release pack).

## Project layout

```
src/sim      game simulation: tics, physics, weapons, monsters, specials
src/render   software renderer + automap drawing
src/audio    WebAudio mixer, SFX driver, SMF synth
src/input    keyboard/mouse mapping, the binding store (CONTROLS source of truth)
src/ui       menus, HUD messages, status bar, title/finale screens
src/persist  savegame codec + IndexedDB settings store
src/wad      WAD/texture/sprite/palette decoding (viewer page in src/viewer)
src/core     fixed-point math, constants
src/main.ts  the browser composer: boot, loop, event pump
scripts/     freedoom pin+fetch, golden/census/perf/license tools
tests/, e2e/ vitest suites (headless/render/sim/…) + Playwright specs
docs/        design plans, decisions, journal, reports (cheats, census…)
```

## License & credits

* This program is free software; you can redistribute it and/or modify it
  under the terms of the GNU General Public License as published by the
  Free Software Foundation; either version 2 of the License, or (at your
  option) any later version (**GPL-2.0-or-later**) — full text in
  [`LICENSE`](LICENSE). It is distributed in the hope that it will be
  useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
* **Source offer (GPLv2 §3):** anyone receiving builds of this program
  receives the complete corresponding machine-readable source — the full
  tree at the matching version tag from this repository's public origin,
  reproducible with `npm ci && npm run build`. This offer stands for at
  least three years from the release date.
* **No id Software content** is shipped with or embedded in this
  repository; WADs are user-supplied at run time and `wads/` is asserted
  empty of commits by `scripts/license-audit.mjs`.
* **Freedoom** content © the Freedoom contributors, BSD-3-Clause — full
  attribution and the pinned release checksums in
  [`CREDITS.md`](CREDITS.md).
