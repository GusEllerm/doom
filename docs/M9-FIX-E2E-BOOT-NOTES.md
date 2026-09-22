# M9-fix: adapt pre-existing e2e specs to TITLEPIC boot

## Problem
M9 changed the default boot flow: the game now boots into the TITLEPIC attract screen
(GS_DEMOSCREEN) instead of dropping straight into E1M1. Specs written before M9
(canvas.spec.ts, automap/monsters/physics/specials/walls/weapons) assumed boot-into-play:
key input is eaten by the title screen ("holding W must move the player" fails) and
world tics NEVER run in GS_DEMOSCREEN, so park/runTo watchers and scripted runTics
streams stall or freeze (the 30 s+ timeouts).

## Repro (pre-fix, branch base 905b1dd)
`npx playwright test 2>&1 | tee /tmp/e2e-fail.log` → **20 failed / 17 passed (7.5 m)**:
- automap ×2 — title-frame pixels; 'holding W must move the player (state() delta)' == 0;
- monsters ×4 — park-at-leveltime-40 `page.evaluate` timeouts (leveltime frozen at 0);
- physics ×6 — runTics no-ops (bob never reaches MAXBOB, -5241503 wall pin unchanged,
  'canvas click must request the pointer lock' — M9-12 silences lock outside live play),
  runTo(40) timeouts;
- specials ×3 — scripted USE/walk streams moved nothing ('S1 exit fired' == 'none');
- walls ×1 — 'Tab must change the frame' (Tab eaten by the attract);
- weapons ×4 — psprite/ammo machines frozen.
canvas/viewer/m9-flow green (title canvas is non-blank; viewer is a separate page).

## Failure-cause verification
GS_DEMOSCREEN `gTicker` step 5 runs no world thinker (world + leveltime frozen) and the
wiring's G_Responder demo branch eats keys until the menu arms; requestPointerLock is
deliberately not called outside GS_LEVEL (M9-12). Verified live via the repro above.

Two follow-on flakes found and killed during the fix (both NEW-clock artifacts):
1. Double-run determinism (monsters/physics) flaked ~50%: the real-keys menu walk burns
   wall-clock LIVE tics, and `gametic` is a hashed §3.4 field — pages diverged by ±1 tic
   (measured: parked (40, 48/49) pairs). Fix inside enterPlay (below): hashed trio
   pinned at exactly (leveltime, gametic) == (1, 1), rndindex re-zeroed by the drain's
   M_ClearRandom — measured identical (40, 40, ri 39, pi 76) across 5 boots.
2. automap byte-exact Tab restore flaked ~50% (hash pair 94a41fb4/b3c8dc40 — pixel-dumped
   to a 578-px diff inside the ST face rect): the face widget paints its art at the first
   idle redraw (~tic 17) and re-rolls blink poses whose art differs (~tic 100);
   wall-clock-sampled settled/restored pairs straddle those boundaries once enterPlay —
   not the page load — starts the world clock. Fixed by pinning every sample in TICS
   (runTo same-frame-pause pattern) inside a paused window.

## Files fixed (e2e only; production untouched — boot stays TITLEPIC)
- e2e/playstart.ts (NEW) — `enterPlay(page)`: pause the stepper, zero `gametic`
  (the legacy clock anchor; the attract's tics are history), clear the armed
  `advancedemo`, set the EXACT M_ChooseSkill fields — G_DeferedInitNew(skill 3 = Hurt me
  == the legacy default, E1M1, `gameaction = ga_newgame`) — and drain it on ONE scripted
  `runTics(1)`. (1, 1) / LEVEL / E1M1 asserted in-page; popInput; loop handed back.
  No sleeps; the real-keys menu walk stays guarded by m9-flow stage 2 (untouched).
- e2e/automap.spec.ts — boot = enterPlay + runTo-pinned settle (24, Tab, 28); test 1's
  Tab round-trip pinned via runTo(34)/runTo(40); test 2 resumes the live loop after the
  now-paused boot. W-thrust movement assertions unchanged (state() delta + pixels + hash).
- e2e/monsters.spec.ts, e2e/physics.spec.ts, e2e/specials.spec.ts, e2e/walls.spec.ts,
  e2e/weapons.spec.ts — one `await enterPlay(page)` in each boot (specials before its
  freeze; nothing else touched).
- canvas.spec.ts — NO change needed (non-blank + debug-API assertions hold on TITLEPIC).

## Adaptation pattern
m9-flow's determinism policy, scripted: enter the game through the G_DeferedInitNew →
scripted-drain seam (the same field writes the menu makes), then let each spec's existing
watchers/pins do what they always did — every wait is a state seam, zero sleeps added.

## Gates
- `npx playwright test` GATE run 1: **37 passed (39.1 s)**; GATE run 2 (consecutive):
  **37 passed (38.8 s)** — plus 4 more green full runs during diagnosis (was 20 failed /
  17 passed / 7.5 m at repro).
- `npm run check` exit 0: tsc + eslint clean, vitest **140 files / 2808 passed | 2 skipped**.
