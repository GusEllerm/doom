# M7-01 salvage notes (t2 branch)

Salvage of stopped agent branch `task/M7-01-states` (tip `ea3c701`).

- Recovered from the stopped tip: generated `src/wad/info/{states,mobjinfo,weaponinfo,sprnames}.ts`
  and the `ActionId` registry + switch in `src/sim/a_actions.ts` (transcribed from the
  `/tmp/DOOM-full` `info.c` / `d_items.c` mirror).
- This branch `task/M7-01-states-t2` starts from that tip; finishing work (census/parity
  tests, frame-bit decode, advance-helper semantics, gate green) continues here.
- Owned paths (docs/design/M7-plan.md §M7-01): `src/wad/info/{states,mobjinfo,weaponinfo,sprnames}.ts`,
  `src/sim/a_actions.ts`, `src/wad/info/states.test.ts`. Nothing under `docs/**`.
- Parallel salvages own `p_doors*` (M6-05b) and `p_pspr.ts`/`psprites.ts` (M7-07) — zero overlap.

## Outcome (t2)

(to be filled)
