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

## Final report (all three rooted, fixed, pinned)

### B-01 — "the square within the viewport gets eaten away as the game progresses"

**Root cause (compositor, d_main.c:276-296 mis-port).** Vanilla's border
bookkeeping is a 3-frame `borderdrawcount` ERASE, which is sufficient
only because `R_RenderPlayerView` NEVER LEAVES THE VIEW WINDOW — outside
the window, pixels are set once and persist forever. Our M9-09 reorder
runs a FULL-RES 3D pass + `cropToWindow`, so the ring is dirtied EVERY
frame: frames 1-3 show the border, frame 4 onward silently shows raw
UNCROPPED 3D in the ring (content offset 16 rows against the cropped
window content), and every menu/resize/level-entry trigger flashes the
3-count border back before the 3D eats it again — precisely the reported
"eaten away as the game progresses". Automap flavour: `AM_clearFB`
covers the full buffer; the crop then stamped a 16-row-shifted duplicate
square in the middle of the map.

**Fix (`ae34cc3`)**: windowed LEVEL frames restore the ring from the back
screen EVERY frame (`drawViewBorder`, replacing the 3-count statics),
and the window crop is gated `!automapactive` (vanilla automap is
full-screen over the bar). Soak probe on the bug build: ringBad 4/4 from
t=5 at every screenblock → 0 everywhere after the fix.

### B-05 — "the palette flash gets stuck" (confirmed pre-flight, see above)

**Fix (`51f371a`)**: `pPowerThink` wired at its one faithful call site
(puser.ts, after `P_MovePsprites`, per p_user.c:334-359). Side effects
all faithful and now LIVE: `fixedcolormap` invuln inversion reaches the
renderer (m9 `bar-god-invul` golden re-blessed — the inverted view is
the vanilla image; every other m9 scene byte-stable), berserk `strength`
counts up (p_user.c:339), timed powers expire.

### B-06 — "face flickers, then the whole bar is gone"

**Root cause**: same reorder class as B-01. The compositor dirties the
bar rows every frame (3D pass full-buffer, rows restored BG→FG), but
vanilla's STlib widget diff-draw redraws multicons/binicons/%-sign ONLY
on VALUE change (st_lib.c:208-234/:256-292/:179-187) — vanilla can
afford that because its FG bar persists between frames. Ours erased the
face/ARMS/keys every frame and never re-drew them until the value
happened to change: the always-redrawn NUMBERS survived (digits clear
+draw unconditionally), the face flickered exactly on its 17-tic re-roll
and stayed blank in between → "flickers, then gone".

**Fix (`989aa95`)**: windowed frames force `refresh=true` in the
ST_Drawer gate (the refresh path re-draws every widget over the fresh
BG; its per-widget erase is itself a BG→FG copy — pixel-identical to
vanilla's persisted bar). Wipe keeps its force; fullscreen has no bar.

### Collateral surfaced by the wiring (all faithful-first)

* `aPunch` read `powers[0]` for berserk — index 0 is
  `pw_invulnerability` in doomdef.h (verified against the enum);
  `PW_STRENGTH` is now 1 (p_pspr.ts), matching this repo's own PW table.
  The mix-up only "worked" because powers never decayed. fist.test now
  pins the right slot.
* ironfeet unit pins use a persistent countdown (IRONTICS-scale) —
  `= 1` survived 96 tics only through the no-decay bug.
* e2e automap/walls expectations aligned to the FIXED compositor (map
  reds band 2738∈[900,3200); automap frame identity pinned over rows
  0..167; the 3D round-trip diff excludes ST-owned bar rows — the idle
  face legitimately re-rolls every 17 tics, previously frozen by B-06).

### Regression coverage

`tests/e2e-soak/soak.test.ts` — 12 per-frame invariants on the live loop
(harness.ts = main.ts order, statics carried forward; extended with
`setAutomap`/`am`). Every bug's pre-fix measurement is documented at
its test (latched damagecount, ringBad from frame 5, faceBox==BG every
non-change frame, crop stamps under automap via `displayStatics.cropCalls`).

### Gates (final)

* soak suite: 12/12
* vitest: 2825 passed / 2 skipped (143 files)
* `npm run check` (tsc + eslint + vitest): green
* goldens `--check`: no drift (all sets)
* `npx playwright test`: 37/37
* `docs/**`: untouched (`git diff 03bd281..HEAD -- docs/` empty)

