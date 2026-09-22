# M9-13 exit sweep — gate results + re-bless ledger

Branch `task/M9-13-exit` @ main 40b6283. All commands run in this worktree on
macOS/arm64, node 22, headless chromium.

## Gate results (all green)

| Gate | Command | Result |
|---|---|---|
| Static+unit | `npm run check` (tsc + eslint + vitest) | **141 files / 2812 passed, 2 skipped** |
| e2e run 1 | `npm run e2e` | **37 passed (39.0s)**, zero console errors |
| e2e run 2 (flake audit) | `npm run e2e` | **37 passed (38.9s)** — consecutive-green holds |
| Goldens drift | `node scripts/goldens-update.mjs --set automap --check` | no drift |
| Goldens drift | `… --set walls --check` | no drift |
| Goldens drift | `… --set weapons --check` | no drift |
| Goldens drift | `… --set screens --check` | no drift |
| Goldens drift | `… --set m9 --check` | no drift |
| Goldens (in-suite) | motion + mechanics sha asserts | green inside `npm run check` (no separate set runner) |
| Mirror 62-.c | `ls /tmp/DOOM-master/linuxdoom-1.10/*.c \| wc -l` | **62** (plan §0.0 pin, re-verified) |

PRNG final reconciliation (plan §M9-13 callout): see
`tests/sim/m9prng.test.ts` — full-scope `scanCallTree` manifest green with
`st_face` + WI streams included; M9-07 WI-anim timing asserts fixed to run on
a LIVE (st_face-advanced) stream — the fresh-stream `mClearRandom` + absolute
`rndindex` asserts in `src/sim/wintermission.test.ts` (M9-07 wave) were the
"fix if not" case the plan predicted; replaced by delta-based + live-shifted
pins (wi_stuff.c:517 ranges are position-invariant).

## Re-bless ledger (every historical reason once; 7 sets, 91 scenes)

| # | Set | Reason (from goldens/*/meta.json) | Scenes |
|---|---|---|---|
| 1 | automap | initial M2-10 baseline | 5 |
| 2 | automap | M5-06: p_user physics replaces D009 fly stub — noclip-follow walk goldens follow the real thrust/friction momentum curve | 5 |
| 3 | walls | initial M3-08 baseline | 20 |
| 4 | walls | M4-08: M4 full-frame baseline (planes+masked+statics) replaces M3 walls-only | 31 |
| 5 | walls | M4-09 masked flush live | 31 |
| 6 | walls | M4-10 sidedef mid/bottom slot decode fix (mapdata vanilla layout) | 31 |
| 7 | walls | **M9-09 D018 flip**: KIND_MONSTER THINGS now draw spawnstate frames — 4 E1M1 viewpoints re-blessed, rest unmoved | 31* |
| 8 | weapons | weapon psprite state coords fixed (spritenum = sprnames index; 4CC in pspriteview seam; montage retiled 3x5 @2x) | 15 |
| 9 | weapons | M7-10 weapon visual pack | 15 |
| 10 | motion | M5-10 motion evidence | 1 |
| 11 | mechanics | M6 door-through evidence | 3 |
| 12 | mechanics | M6-05b door bodies live (+m6-door-through; m6-crusher frames shift: PIT_CheckLine/P_LineOpening read LIVE sector heights) | 4 |
| 13 | mechanics | M8-13 L5: +m8-chase-corner / m8-pain-death / m8-infight monster strips (synthetic plate sprites + live-mobj thinglist composition, x/y captions) | 7 |
| 14 | mechanics | M8-13 L5 (same bless, reworded reason string — the wave ran two blessed passes and history retains both variants on all 7 scenes) | 7* |
| 15 | mechanics | **M9-09 D018 flip**: m8 monster strips render through production deps.mobjs live-mobj overlay + real IWAD sprite art (synthetic plates retired) | 7 |
| 16 | screens | M9-10 new set first bless: TITLEPIC page, finale E1TEXT reveal t=200, HELP2 hold | 4 |
| 17 | m9 | M9-11 initial bless: L3 corpus — statusbar 8-variant matrix + HU message strip + sb9/sb11 pair + title/menu screens + WI tallies/par/sucks/blink + finale 3 phases | 27 |
| 18 | screens | **M9-13 L5 exit pack**: +m9-exit-montage (18 blessed m9 scenes tiled 3x6 at 1x, D016 milestone sheet); the 4 existing screens pages re-ran byte-identical (run-reason stamp, same shas) | 5* |

*Row 7: the reason documents that only the 4 monster-seeing E1M1 frames
actually changed; rows 13/14 are the same M8-13 bless event whose meta reason
string was reworded mid-wave (history retains both). Row 18: the bless tool
stamps the run reason on every scene of the set (the established walls-D018
convention) — only the NEW m9-exit-montage.png is a first bless; the 4
screens pages kept identical shas. **D017 retirement
cross-check: zero golden re-blesses for the death-restart flip** — no
M5-M8 motion/mechanics scripted run crosses a PLAYER death (the only scripted
deaths are monster xdeath in m8-pain-death; the player-restart evidence lives
in src/sim/reborn.test.ts + e2e/m9-flow.spec.ts, not goldens).

## D-list closure check (plan §3)

| Item | Evidence | Status |
|---|---|---|
| D-0xx silent-M9 sfx policy | `sfxStub(` call sites (non-test, outside hooks.ts): menu.ts 28, wintermission.ts 11, finale.ts 1, title.ts 1 = **41 sites**, every vanilla `S_StartSound/S_ChangeMusic` address kept, bodies counted-only | CLOSED (M10 fills bodies in place) |
| D-0yy menu mouse via synthesized arrows | `src/input/menuMouse.ts` wired in `main.ts:224-234` (itemBoxes arm, hover/click/wheel → KEY_UP/DOWN/ENTER pairs) | CLOSED |
| D-0zz quit-yes ⇒ title | `mQuitResponse` (menu.ts:579-585): quitsounds[(gametic>>2)&7] then `gStartTitle` | CLOSED |
| Ad-divert (shareware M_Episode) | menu.ts:509-515 — episode≠0 under shareware ⇒ `mSetupNextMenu(ReadDef1)` (HELP1 ad page), plan §0.7/:919-943 | CLOSED |
| Attract-demo deferral | title.ts — `demosequence` reduced cycle, TITLEPIC-only (no demo1/2/3), any-key→`mStartControlPanel` | CLOSED (Post-M12 .lmp stretch unchanged) |
