# task/BUG-display — debug-finisher notes (B-01 / B-05 / B-06)

Resumed from the dead agent's branch tip `f7d48d1` (live-soak harness
scaffold + scratch trace + B-05 pin). Rebase posture: rather than a
textual rebase (its two commits edit `docs/BUGS.md`, which this task must
NEVER touch — main grew its own triage ledger at `094b20b`), the branch's
NON-DOCS content is carried forward onto current main (`03bd281`) as an
explicit "carry" commit, and all further work lands incrementally on top
of branch `task/BUG-display-finish`. `docs/**` is untouched throughout.

## B-05 pre-flight (confirmed before running anything)

The dead commit message claims "damagecount never decays — pPowerThink
unwired". Source check:

* VANILLA decay site is `P_PlayerThink`, "Counters, time dependend power
  ups": linuxdoom-1.10 p_user.c:336-359 — `if (player->damagecount)
  player->damagecount--;` / same for `bonuscount` (p_user.c:355-359),
  AFTER `P_MovePsprites` (:334), and the power countdowns live in the
  SAME block. **REFUTED variant:** there is no `pPowerThink` function in
  vanilla — the block is inline in P_PlayerThink. **CONFIRMED claim:**
  OUR port's transcription of that block (`sim/ppalette.ts pPowerThink`,
  header "P_PlayerThink owns the ONE call site") has ZERO call sites in
  `src/` (grep: only the file itself + tests). `src/sim/puser.ts`
  pPlayerThink ends with the comment "powerup counters (p_user.c:336-360):
  no subjects yet — … intentionally absent, not faked" — the M7-06 wiring
  never landed. Net: in the LIVE game `damagecount`, `bonuscount` AND the
  timed powers (invuln/invis/ironfeet/infrared) never tick down;
  `ST_doPaletteStuff` (`paletteBand`) therefore latches the last red/amber
  band forever. (P_DeathThink's own decay paths exist pplayer.ts:427/434 —
  the p_user.c:196-224 halves — they are NOT the alive-player decay.)

B-01 / B-06: continuing the dead agent's soak-trace method below.
