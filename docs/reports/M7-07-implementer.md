# M7-07 report — psprite state machine + weapon view layer

## What landed
- `src/sim/p_pspr.ts` — p_pspr.c TRANSLATION (100% verbatim): P_SetPsprite 0-tic cascade loop, P_FireWeapon, P_BringUpWeapon, P_CheckAmmo(+gate slot), P_MovePsprites, P_SetupPsprites, P_DropWeapon + all A_* bodies incl. CGun `flashstate + state - &states[S_CHAIN1]` index trick.
- M7-01 rewire done after merge: states.ts SoA row-view, weaponinfo.ts consumed, all 22 pspr action bodies registered in the a_actions ActionId registry; P_SetPsprite dispatches through dispatchAction (registry contract honored).
- `src/render/psprites.ts` — R_DrawPSprite/R_DrawPlayerSprites port: fixed screen-space box, clip, flip, FF_FULLBRIGHT live (flash fullbright pin), invis fuzz stubbed, top→bottom draw order, scratch vissprite (no pool). Gun OFF by construction; wiring-guard test fails if renderer.ts ever imports it.
- 31 tests: fist 22-tic / pistol 19-tic cycles, raise/lower 16-tic sy goldens, bob formula re-derivation, chaingun ≤1 fire/tic, missile/BFG latch + tic-20 rocket, prndindex stream pins (1 draw accurate, 3 draws refire), fire-while-lowering silent, double-run determinism.

## Wiring choices
- Not wired (per plan): no puser.ts/renderer.ts edits. `attachPsprFields` adds Player fields in-place (not hashed ⇒ goldens untouched). pSetupPsprites/pMovePsprites/pDropWeapon exported + position documented (p_user.c:381) for M7-03 wiring.
- Hook slots (counted, faithful defaults): aimLineAttack/lineAttack/bulletSlope → M7-08, spawnPlayerMissile → M7-09, noiseAlert → M8, startSound → M7-06/M10, checkAmmo → M7-05 seam, setMobjState → M7-02.

## Deviations
- state.misc1/2 branch kept but dead (weapon rows always 0 — vanilla-identical outcome).
- A_BFGSpray not in pspr table (mobj-side action; M7-09/M8 register it).

## Gates
- tsc + eslint + vitest: 86 files / 1826 tests green.
- Goldens: "no drift" (full --check after merge of current main incl. M6-05b).
- Mirror: p_pspr.c in 62-.c set, untouched.
- Branch: task/M7-07-psprite-t2, 6 commits, merged with main.

## Follow-ups
- M7-03: call pMovePsprites in pPlayerThink; M7-10: pspr fields into hash + gun-on switch blessed.
