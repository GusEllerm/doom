# M7-08 salvage notes (t2 branch)

Salvage of stopped agent branch `task/M7-08-hitscan` (tip `e192210`).

- Recovered from the dead tip: `src/sim/p_shoot.ts` COMMITTED LIVE —
  `PTR_AimTraverse` / `PTR_ShootTraverse` (p_map.c:812-1013 verbatim),
  `P_AimLineAttack` / `P_LineAttack` (p_map.c:1020-1088 verbatim), the
  shoot-special dispatch FIRST in the line branch (before the two-sided /
  block test, M6-plan §0.10c), the `hitline` helper (4-unit pull-back +
  sky/sky-hack no-puff), the thing branch (over/under, 10-unit pull-back,
  MF_NOBLOOD ⇒ puff else blood, damageSlot arg shape), the
  vanilla-globals block (module statics; `attackrange` shares the
  p_mobj.ts cell), and the pspr hook registration
  (`aimLineAttack` / `lineAttack` / `pointToAngle2`).
- This branch `task/M7-08-hitscan-t2` starts from that tip; finishing work
  here: world binding at game boot, the `p_shoot.test.ts` acceptance matrix
  (cone edges, BulletSlope probe order, wall/thing pull-back, sky no-puff,
  blood variants, special-line crossing order, zero-alloc globals),
  per-weapon P_Random stream pins incl. puff draws, double-run.
- Owned paths (docs/design/M7-plan.md §M7-08): `src/sim/p_shoot.ts`(+test)
  and the game-boot bind. `pmaputl` thing-intercept is CONSUMED, not
  edited (M7-02 owns); `p_pspr.ts` pspr machine merged (M7-07) exposes
  hook seams only — ZERO edits there; `pplayer.ts` / `p_inter*` /
  `p_ammo.ts` belong to parallel t2 salvage agents — zero edits there.
  Nothing under `docs/**`.
- Mirror check: `ls /tmp/DOOM-master/linuxdoom-1.10/*.c | wc -l` == 62 ✔
  (p_map.c / p_mobj.c / p_pspr.c present as reference; p_inter.c/p_spec.c
  per research notes R06/R07/R08 as the arbiter).
