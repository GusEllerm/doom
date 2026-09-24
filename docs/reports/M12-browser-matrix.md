# M12-08 — Browser matrix (Firefox / Safari) + experimental projects

Plan: docs/design/M12-plan.md §M12-08, decision D-12e (**CI stays chromium** —
"multi-engine CI triples wall-time for near-zero signal until someone reports an
engine bug; the manual matrix + env-gated experimental projects are the compliance
surface"). This doc is that compliance surface: what is automated, what a human
must run per engine, and every known-risk with the code that carries it.

## 1. Engine availability probe (this machine, honest record)

Probed with `npx playwright install --dry-run` + `ls ~/Library/Caches/ms-playwright/`
+ `ls /Applications` (date of run in the evidence section):

| Engine | Status | Evidence |
|---|---|---|
| chromium (headless shell + CFT 1243) | INSTALLED — CI/pinned | `chromium-1243`, `chromium_headless_shell-1243` in the ms-playwright cache |
| firefox (playwright build v1543) | **NOT installed** — `firefox-1543` absent from the cache; no Firefox.app | dry-run prints the download URL only; we deliberately do NOT download big browsers (task rule) |
| webkit (Safari engine) | **NOT installed** — `webkit-*` absent; Safari.app exists but playwright uses its OWN WebKit build, not the system Safari | same probe |

Consequence: the experimental `firefox`/`webkit` projects are **gated and skipped
locally** — they were implemented and registered, smoke-listed (`--list` shows them
only under the env gate), but never executed here because execution would require a
~100 MB browser download. This is the documented skip, not a failure.

## 2. Experimental projects (D-12e: opt-in, non-blocking)

`playwright.config.ts` (M12-08 patch onto M12-06's config):

- Default `npm run e2e` ⇒ project list UNCHANGED (chromium + audio + build). Verified:
  `npx playwright test --list` → 73 tests, identical with and without the code change.
- `PW_EXTRA_BROWSERS=firefox npx playwright test` adds `experimental-firefox`;
  `PW_EXTRA_BROWSERS=firefox,webkit` adds both. Only list engines already installed
  (`npx playwright install firefox` / `… webkit`) — an uninstalled engine hard-errors
  with playwright's own install hint.
- Each experimental project runs ONLY the smoke subset — `canvas.spec.ts` (boot →
  titlepic render, zero console errors, `__doom` seam) + `lifts.spec.ts` (one
  playstart-entered PLAY check: world ticks + mover behavior). Audio-flag profiles,
  the build project, perf budgets and soak stay chromium-pinned by design.
  `retries: 1` (experimental = flaky-by-honesty).

## 3. Per-engine known-risk table (plan §0.7 items, with code cites)

| # | Risk surface | Our code (the truth to check against) | Firefox expectation | Safari/WebKit expectation |
|---|---|---|---|---|
| R1 | **Autoplay gesture policy** — boot must stay silent, first gesture unmutes | `src/audio/context.ts` (graph built muted-by-default-until-gesture, `ensureContext()` attempts `resume()`, rejection just leaves `suspended` — never throws); `src/audio/wiring.ts` `attachGestures` (`pointerdown`/`keydown`, `once:true`) | Firefox blocks audio until a gesture like the rest; `AudioContext` constructor without gesture is allowed (state `suspended`) — matches the ladder. Check `about:config` `media.autoplay.blocking_policy` doesn't wedge resume-after-gesture | WebKit NEVER builds an AudioContext before a gesture (older builds hard-throw at construction; newer start `suspended`) — our lazy `ensureContext` only constructs on first gesture, so the designed path holds. Safari additionally ties resume to the SAME event's task — our resume rides the pointerdown/keydown handler, so it is in-gesture |
| R2 | **IndexedDB / private mode** | `src/persist/idb.ts` ladder: absent factory ⇒ `'no-indexeddb'`; throw/SecurityError on open ⇒ `'idb-open-failed'`; both resolve to the memory backend with a typed `reason` — never throw, never console.error (`store.ts` reports `backend:'memory'`, quota stays typed `quota-exceeded`) | Private browsing blocks IDB ⇒ expect the FULL game on the memory backend (saves work in-session, vanish at close). Total Storage Protection ("Block all cookies") blocks IDB even in normal mode — same ladder | Safari Private Mode throws SecurityError / never fires the open request ⇒ `idb-open-failed` path is THE design case (M11-01). Also Safari evicts IDB after ~7 unvisited days — saves may vanish; typed read miss, not corruption |
| R3 | **Pointer lock** | `src/input/mouse.ts`: `canvas.requestPointerLock()` on click-capture, `pointerlockchange` mirrors `locked` (no webkit- prefix anywhere in src — recent Safari is prefix-free since 13.x) | Lock prompt-free; Esc exits, `pointerlockchange` fires — UX per contract. Resist Fingerprinting (`privacy.resistFingerprinting`) zeroes `movementX/Y` — mouse-look dead: documented Firefox foot-gun, no code bug | Safari's pointer-lock UX differs (grant can be delayed; first lock sometimes needs a fresh user gesture) — our locked-mouse input only accrues deltas while `locked`, so a DENIAL degrades to mouse-button-only play, never garbage deltas; verify deltas aren't double-scaled (WebKit movementX quirk under CSS scaling) |
| R4 | **Fullscreen** | NONE — `requestFullscreen` appears nowhere in src (verified by grep); "fullscreen" in code means the status-bar draw (`main.ts:788 stDrawer`). The canvas is CSS-upscaled only | Browser-chrome fullscreen (F11): canvas scales, click→screen mapping via `getBoundingClientRect` (`main.ts:384-389`) stays correct | menu-bar toggle changes viewport height — same rect-based mapping must stay correct; no engine API to fail |
| R5 | **OGG music decode** | `src/audio/musicSelect.ts` `makeOggSource`: fetch `/wads/music/<lump>.ogg` → `decodeAudioData`; ANY failure ⇒ `null` forever ("deterministic silence", zero console noise) — the SMF companion keeps playing | Firefox decodes Ogg/Vorbis natively — expect the OGG companion everywhere | WebKit historically lacks Ogg/Vorbis decode ⇒ `decodeAudioData` rejects ⇒ silence-by-design (SMF only). This is the one place a browser difference is VISIBLE; it must never produce console errors — verify |
| R6 | **31 MB wad fetch (no streaming)** | `src/platform/wadload.ts` `fetchWad`: plain `fetch` + `arrayBuffer()` (whole 28.8 MB in one buffer; sha256 via `crypto.subtle` only when pinned) | fine | fine on modern Safari (the old 1024 MB ArrayBuffer cap folklore is long gone); slow mobile-Safari memory pressure is the only flag — watch for the typed `WadLoadError` fallback UI, not a crash |
| R7 | **`setTargetAtTime` bus ramps** | `src/audio/context.ts` (`BUS_RAMP_TC` anti-zipper ramps on all buses) | supported forever | supported; older WebKit ramps can latch the target — audible only as volume-change lag, watch in the manual pass |
| R8 | **High-DPI canvas** | Fixed 320×200 backing store (`main.ts:176` throws otherwise), CSS 960×600 `image-rendering: pixelated` (`index.html`); `devicePixelRatio` is NEVER read (verified by grep) — engine pixels are resolution-independent | crisp upscale at any DPR; Retina fine | same; Safari zoom/pinching rescales the rect mapping — re-verify click coords (R4) after zoom |

## 4. Manual 15-minute script (run once per engine; findings into §5)

Boot the dev server (`npm run dev`), open `http://127.0.0.1:5173` (needs
`wads/freedoom1.wad`; file picker / `?wad=` path per README).

1. **Boot (1 min)** — titlepic + attract, NO console errors, NO audio yet (R1).
2. **First gesture (1 min)** — click canvas: music starts within the gesture
   (R1); console stays clean.
3. **Play (3 min)** — Esc → New Game → E1; move/shoot/door; mouse-look after a
   click-lock; Esc releases (R3). Firefox only: with resistFingerprinting ON,
   mouse-look is expected DEAD (R3 foot-gun).
4. **Fullscreen + DPI (2 min)** — F11 / green-button; menu squares + automap
   clicks land where drawn (R4/R8).
5. **Save/reload (3 min)** — F2 → Save Game → name → slot; F6 quicksave; reload
   the page; load it back; volumes slider survives reload (R2). Then PRIVATE
   window: same must work IN-SESSION and vanish at close with zero console
   errors (R2 ladder). Safari: also check Settings → clear data path.
6. **Audio on/off (2 min)** — volumes sliders; zero-sfx ⇒ silence, music
   follows; no zipper noise on ramps (R7). Music: if `wads/music/*.ogg` absent,
   SMF-only is the baseline; with OGGs present, Firefox expects the companion,
   Safari may stay SMF-only — the switch itself must be error-free either way (R5).
7. **Stress (3 min)** — 5+ min play, then `?wad=` pointing at a bogus URL:
   typed fallback UI, no crash (R6).

## 5. Results

- **chromium**: `npm run e2e` default run GREEN — **69 passed / 4 skipped / 0 failed**
  (3.4 min; the 4 skips are the pre-existing project-name self-gates).
  Honest flake note: the FIRST run had 1 failure — `audio` project
  `m10-audio.spec.ts:237` (30 s soak, `music.lump != D_E1M1`); isolated re-run and
  the full re-run both passed ⇒ pre-existing flake in the audio profile, NOT
  config-related (the experimental projects were absent from that run's project
  list — `--list` proves it). Flagged here for the P4 flake ledger, out of M12-08 owns.
- **firefox (engine)**: experimental project NOT RUN locally — playwright firefox
  build not installed and big downloads are off the table (§1). Engine coverage is
  the §4 manual script + §3 table. To run the smoke: `npx playwright install
  firefox && PW_EXTRA_BROWSERS=firefox npm run e2e`.
- **webkit/Safari (engine)**: same — `npx playwright install webkit` first, then
  `PW_EXTRA_BROWSERS=webkit` (or the §4 manual script against Safari.app, which
  exercises the SAME engine as the playwright webkit build modulo build skew).

### Findings (append rows; empty = no human session run yet)

| Date | Engine | Item (R#) | Result | Notes |
|---|---|---|---|---|
| — | — | — | — | no manual sessions recorded at M12-08 landing |

## 6. Evidence

- Probe: ms-playwright cache lists only `chromium*`/`ffmpeg`; `npx playwright
  install --dry-run` prints firefox v1543/webkit download URLs for absent builds
  (nothing at the install locations).
- Config gating: `npx playwright test --list` → `Total: 73 tests` (default);
  `PW_EXTRA_BROWSERS=firefox,webkit npx playwright test --list` → 4 additional
  `experimental-*` entries, 0 runs (browsers absent).
- Default-suite runs (chromium): first run 68 passed / 1 failed (audio flake
  above) / 4 skipped; re-run **69 passed / 4 skipped / 0 failed** — logs
  `/tmp/m12-08-e2e-chromium.log`, `/tmp/m12-08-e2e-chromium-rerun.log`.
- Cites verified by grep at landing: `requestFullscreen`/`devicePixelRatio`/
  `webkit` prefixes — zero hits in src; `main.ts:176` 320×200 pin;
  `mouse.ts:155` requestPointerLock; `idb.ts:110-120` degrade ladder;
  `context.ts:281-303` gesture-resume; `musicSelect.ts:604-637` OGG probe.
