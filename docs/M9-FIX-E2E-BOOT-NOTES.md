# M9-FIX: adapt pre-existing e2e specs to TITLEPIC boot

## Problem
M9 changed the default boot flow: the game now boots into the TITLEPIC attract screen
(GS_DEMOSCREEN) instead of dropping straight into E1M1. Specs written before M9
(canvas.spec.ts, possibly automap/monsters/physics/specials/walls/weapons/viewer)
assume legacy boot-into-play: key input is eaten by the title screen ("holding W must
move the player" fails) and pointer-lock / play-mode tests stall on the attract/menu
until their 30s timeouts.

## Repro
`npx playwright test 2>&1 | tee /tmp/e2e-fail.log` — results recorded below after run 1.

## Fix strategy
Adapt PRE-EXISTING specs only, using the seams established by m9-flow.spec.ts: start the
game deterministically via the debug seam / warp (no sleeps, no production auto-start —
boot MUST stay TITLEPIC). Keep each test's original assertion power intact (e.g. the
movement test must still prove W-thrust moves the live player).

## Results
(to be filled in after the failing run and the green runs)
