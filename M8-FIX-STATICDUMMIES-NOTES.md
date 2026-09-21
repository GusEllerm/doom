# task/M8-fix-staticdummies — failing-test note (baseline @ ded7085)

Post-M8-12 (monster AI live via game.ts importing p_enemy/pdeath/amon_*) the
L2 suites that boot wad-free fixtures with MT_POSSESSED dummies go red: the
dummies WAKE ON SIGHT at the first tic, chase, and leave the pinned geometry
(punches miss; draw windows shift). 17 failing tests, 8 files:

- tests/weapons/fist.test.ts — 4 fail (single press, hold, berserk, turn-to-face)
- tests/weapons/pistol.test.ts — 2 (single press, hold-to-refire)
- tests/weapons/shotgun.test.ts — 2 (switch + volley, hold)
- tests/weapons/rocket.test.ts — 2 (direct + splash, hold)
- tests/weapons/plasma.test.ts — 2 (one press, hold)
- tests/weapons/chaingun.test.ts — 2 (switch + 30 tics, hold 80)
- tests/weapons/bfg.test.ts — 1 (spray at 64 units)
- src/sim/pradius.test.ts — 2 (A_BFGSpray timing, STREAM PIN)

Production behavior is correct (e2e monsters wake/chase/kill green); the
test scaffolding wrongly assumed the dummies were static. Fix is harness
only: a mobj-domain AI gate seam (hooks.aiGate) consulted ONLY by the
mobj state-action dispatch in p_mobj.ts for the AI-churn actions
A_Look/A_Chase, set true by the failing fixtures' boot helpers. Zero
production behavior when unset; p_enemy/monsters suites keep AI ON.
