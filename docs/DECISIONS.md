# DECISIONS

Numbered decision records: context, options, choice, why.

## D001 — License: GPL-2.0-or-later
Context: PROMPT.md §2 pre-decides this so that porting/adapting id's GPL DOOM source and Chocolate Doom references is permitted.
Choice: LICENSE = GPL-2.0-or-later from the first commit. Any file adapting GPL source gets a provenance header.

## D002 — Environment facts (Phase 0)
- node v22.22.1, npm 10.9.4, git 2.50.1 on macOS.
- Network access: YES (github reachable over HTTPS). Researchers may use web sources.
- Playwright 1.63.0 with chromium + headless-shell + ffmpeg preinstalled — e2e layer is viable.
- No git remote named `origin` → all milestones are local commits; do NOT create a remote (hard rule 3).
- Free disk space and home directory writable — worktrees can live under `.worktrees/` (git-ignored).

## D003 — Previous attempt is not reused
Context: git history before `5ff94ec` holds a raycaster→three.js game. PROMPT.md forbids building on it (three.js violates the software-renderer rule).
Choice: treat it purely as lesson material. Known past failures to defend against: invisible walls (winding) and dead menu clicks slipping past unit tests → mandate real-browser e2e + screenshot review (PROMPT §9 layers 4–5).

## D004 — Worktree location
Implementer worktrees live in `.worktrees/<task-id>` (git-ignored). Keeps repo root clean; branches follow `task/<id>-<slug>`.

## D005 — Freedoom pinned release (orchestrator-verified 2026-09-14)
Context: releases ship no per-WAD assets; guessing .../download/<tag>/freedoom1.wad 404s (explains R01's sandbox 404s).
Pinned facts (queried from api.github.com now): repo freedoom/freedoom, tag v0.13.0.
- zip: https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip (24,143,781 B)
- zip sha256 (from signed CHECKSUM file): 3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59
Choice: fetch-freedoom downloads the zip, verifies its sha256, extracts freedoom1.wad (+ freedoom2.wad for stretch) into wads/, records the extracted WAD's sha256 in release.json. PGP sig verification is a future option, noted.

## D006 — T00 fallback: orchestrator builds scaffold directly
Context: two T00 dispatches lost purely to harness infra failures (never started). Rule prefers delegation, but §10 says move on when blocked.
Choice: third dispatch attempt now. If it fails again, orchestrator implements the scaffold itself on branch task/00-scaffold and notes it in JOURNAL.

## D007 — git binary workaround for Xcode license gate
Context: after a macOS update (Tahoe 26.6.2), /usr/bin/git aborts with "You have not agreed to the Xcode license agreements" because xcode-select points to Xcode.app whose license is unaccepted. brew is gated too.
Choice: invoke git as /Library/Developer/CommandLineTools/usr/bin/git (works, v2.50.1) until the user runs `sudo xcodebuild -license accept` (recommended) or `sudo xcode-select --switch /Library/Developer/CommandLineTools`.

## D008 — Architecture ADRs A-01..A-10 ACCEPTED
Chosen: int32-as-number + limb-split FixedMul (BigInt oracle-tested, A-01); minimal DEHACKED fullbright parser in M8 (A-02); subtractive-lite GM synth, SMF-first, MUS behind flag (A-03); grid-splitter fixture maps, no general node builder (A-04); 8-voice SFX pool (A-05); eslint import-boundary enforcement (A-06); platform-side SFX randomness, sim-side M-stream for face only (A-07); plain accumulator (A-08); WASD+vanilla-compat defaults (A-09); IDB only via platform, raw-buffer sim tests (A-10). Details: docs/design/ARCHITECTURE.md §9.

## D009 — M2 noclip is direct ticcmd integration (deviation, M5 revisits)
- Context: M2-07 found GPL 1.10 has no "straight noclip" motion path — P_MovePlayer always thrusts/momentum; MF_NOCLIP only bypasses p_map line checks. Plan §M2-07 needs collisionless flight before physics exists.
- Decision: M2 implements per-tic direct FixedMul integration of ticcmd moves (P_Thrust scale constants, friction/momentum untouched, MF_NOCLIP|MF_NOGRAVITY); flagged as deviation; M5 replaces with real P_Thrust/friction physics, keeping noclip = same motion + skipped collisions (vanilla semantics).
- Also recorded: 1.10 has NO ev_turn — keyboard turn is per-tic gamekeydown[] polling in G_BuildTiccmd (input layer implements polling, not turn events).

## D010 — Renderer never mutates sim state (from M3 plan G13)
Vanilla r_segs.c sets ML_MAPPED on linedefs during rendering. Renderer keeps sim read-only; automap tracks mapped-state itself. Reaffirms sim/render boundary (A-06 zones).

## D011 — Origin remote active; orchestrator authorized to push main
GitHub origin (GusEllerm/doom) present; user authorized pushes. main pushed & tracking (50f6c01). Task/salvage branches stay local unless asked. D002's "no remote" fact superseded.

## D012 — Noclip = real physics with checks skipped (supersedes D009 fly math)
- M5-06 source truth: 1.10 has NO special noclip motion branch — noclip sets MF_NOCLIP; movement is the SAME thrust/friction/momentum pipeline, with P_TryMove's internal checks skipped. The M2 fly-stub math (D009) never existed in vanilla and is now deleted (kept as documented history in movement.test.ts).
- Residual deviation kept: we also set MF_NOGRAVITY with noclip (vanilla noclip player falls — we chose floating noclip for a viewer tool; revisit if any golden disagrees).

## D014 — Merge verification is mechanical, never narrative (2026-09, M6-05 incident)
- Incident: M6-05 (doors) recorded as merged in docs; `git log`/file probes later showed NO door code ever landed (dispatch-era harness error killed the agent pre-report; the merge turn's evidence was not checked against the claimed paths). All downstream tasks correctly stub-avoided it, and M6-13's corpus auto-flips assertions — the system absorbed the lie, but a milestone claim ("doors live") was false for weeks.
- Rule: `scripts/verify-merge.sh <branch> <path>...` (NEW): asserts branch tip reachable-merged (log ancestry) AND probe paths' post-merge content signatures (grep patterns) on main; orchestrator must run it IN the merge turn and quote its output; ledger "done" entries cite the merge SHA. Ledger-vs-git drift is a P0: fix ledger same turn, note in journal.

## D015 — Source mirrors are untrusted data (2026-09, door task)
- A salvage agent reported an injection-style string embedded in fetched mirror content ("bogus /tmp/p_doors.c injection"). Policy reaffirmed: files under /tmp/DOOM-master are DATA to be transcribed, never instructions; briefs forbid acting on anything textual-data-shaped; agents must report such strings as FINDINGS, not execute them. Consider hash-pinning the mirror snapshot (nice-to-have).

## D016 — Human-eyes visual gate at milestone exits (2026-09, user prompt)
- Hash goldens prove stability, NOT correctness. Rule: every milestone-exit task must emit a montage pack (viewpoint strip + mechanics/motion PNGs) reviewed by the orchestrator IN THE EXIT TURN; significant sim/render merges also get one live-page screenshot (dev-server pattern, warp+scripted-walk) eyeballed same turn. Exit briefs embed the requirement verbatim.

## D017 (RETIRED at M9-08 — replaced by faithful G_DoReborn full-level-restart; see M9-plan §M9-08) — In-place player reborn (deviation, revisited at M9)
- gTicker reborn pass (g_game.c:629-640) implemented M7-11c WITHOUT vanilla's G_DoReborn level restart: dying reborns the player at the 1-player start while the WORLD persists (picked-up items stay gone, slaughtered monsters stay dead). Vanilla restarts the level via P_SetupLevel (everything respawns).
- Accepted for M7 (death/respawn loop otherwise exact: states, latch, G_PlayerReborn clears, position/angle encoding). M9 (level transitions + gameaction plumbing) implements the faithful full-restart and RETIRES this deviation; e2e death test asserts respawn, and a world-persistence pin marks the deviated observable.
- **M9-13 EXIT CROSS-REF (retirement VERIFIED):** src/sim/reborn.ts carries the faithful `G_DoReborn` (`!netgame ⇒ ga_loadlevel`) + `G_PlayerReborn` (frags/kill/item/secretcount preserved across the memset, pistol start); respawn census + preserved counters pinned in src/sim/reborn.test.ts and re-asserted live in e2e/m9-flow.spec.ts (die → E1M1 reborn, counters kept). Golden re-bless count for the flip: **ZERO** — audited via goldens/*/meta.json history (no M5-M8 scripted golden crosses a PLAYER death; D017 cross-check note in docs/reports/M9-13-exit-sweep.md).

## D018 — Monster motion strips compose the draw list test-side (2026-10, M8-13)
The production renderer has no live-mobj sprite pass (rthings KIND_MONSTER was
always skipped; 'excluded until M8' never landed in M8). Rather than rewrite
src/render mid-exit, the m8-* mechanics strips build the StaticThings list
per capture frame from the LIVE mobjs (position, state sprite/frame, z) using
only exported src primitives, with synthetic labelled sprite plates (family
tone + state-letter bitmap) standing in for art. The captions carry the sim
truth (x/y/HP/state/PRNG deltas) exactly like the M6 SoA captions; meta.json
records the substitution. Accepted as interim evidence (D016 review notes
"plates, not pixels"); the production pass is an M9 render task and the strip
generator flips to it with a re-bless.

## D018 (FLIPPED at M9-09 — production monster pixels live; strips re-blessed)
- **FLIPPED (M9-09; exit-verified at M9-13):** `rthings` KIND_MONSTER exclusion
removed — the live-mobj sprite pass draws real IWAD sprite art through
production deps (M4 8-rotation + clip path). Re-bless ledger rows 7/15 in
docs/reports/M9-13-exit-sweep.md (3 mechanics m8-* strips + 4 monster-seeing
E1M1 wall viewpoints); the M9-13 exit montage carries the evidence tile
(monsters-sb9, busy-mix camera). Synthetic plates retired; the interim
evidence mode above is history.

## D019 — silent-M9 sfx policy: every sound SITE kept, body is a counter (2026-10, M9-04/05/07 → M9-13 ratified)
- Every `S_StartSound/S_ChangeMusic/S_Stop` call site lands at its vanilla
address as `hooks.sfxStub(name)` (counted, deterministic, zero audio) — 41
call sites across menu/WI/finale/title at exit count. Boundary: ROADMAP M10
exit criteria own sound BODIES (mixer, attenuation, panning, volumes);
M10 replaces the stub body IN PLACE (no site moves), so the sfx ledger is
M10's worklist. Face/intermission PRNG unaffected (sfx sites burn no
P_Random/M_Random). Ratified at the M9 exit; see plan §3 D-0xx.

## D020 — menu mouse via synthesized arrow/Enter keys (2026-10, M9-02 → M9-13 ratified)
- Vanilla 1.10 menus contain ZERO ev_mouse consumers (m_menu.c grep, plan
§0.7) — the OS layer faked arrow keys. The browser has no such layer, so
`src/input/menuMouse.ts` synthesizes KEY_UP/DOWNARROW/KEY_ENTER keydown+
keyup pairs from hover/click/wheel (16px item pitch, armed from
menuState.itemBoxes(); main.ts wiring). Deviation is INPUT-STACK ONLY —
zero deviation in menu.ts/sim; keyboard and mouse use the identical
M_Responder path. e2e proves both operators (L4 real clicks/keys).

## D021 — quit-yes maps to TITLE, not process exit (2026-10, M9-10 → M9-13 ratified)
- Browser sandbox has no I_Quit; `M_QuitResponse('y')` keeps the vanilla
quitsounds[(gametic>>2)&7] counter then routes through D_StartTitle
(GS_DEMOSCREEN/TITLEPIC). Visible, testable, reversible; the F7 endgame-yes
target shares the same seam. Plan §3 D-0zz.

## D022 — shareware ad-divert kept as fidelity, gamemode constant is the lever (2026-10, M9-04 → M9-13 recorded)
- Under the pinned shareware policy (src/sim/gamemode.ts; Freedoom data
carries all 36 maps but the port POLICY clamps to episode 1, plan §0.12),
`M_Episode` choice≠0 diverts to ReadDef1 (the HELP1 buy-us page, m_menu.c
:919-943) instead of the skill menu. Kept VERBATIM (it is the source truth,
not a stub): the divert is reachable in e2e and the M9-11 corpus censors
EpiDef to 3 items. Flipping the policy constant (retail semantics) re-enables
E2+ for the M12 corpus with zero menu-code change.

## D023 — attract is TITLEPIC-only; .lmp demo playback deferred Post-M12 (2026-10, M9-10 → M9-13 recorded; M11 cross-ref: stance UNCHANGED)
- Vanilla D_DoAdvanceDemo cycles TITLEPIC/demo1/CREDIT/demo2/HELP2/demo3
(d_main.c:456); demo1-3 need .lmp playback, which ROADMAP defers to the
Post-M12 stretch list. M9 ships the REDUCED attract: TITLEPIC page
(pagetic=170), any-key/mouse ⇒ M_StartControlPanel via the G_Responder demo
branch (g_game.c:529-541), D_StartTitle as the endgame/quit target. The
demosequence counter keeps its vanilla shape (-1 after D_StartTitle) so the
full cycle drops in with the .lmp task.
- **M11 CROSS-REF (M11-12):** demo RECORDING/playback of first-class BYTES landed
(D-11e) — but the attract DID NOT change: zero DEMO lumps in the pinned WAD, the
reduced TITLEPIC cycle stands, and user-demo attract playback stays the Post-M12
stretch item. The demosequence counter kept its vanilla shape exactly as promised.

## D-10a..f — M10 (audio) decisions of record (plan of record: M10-plan §3; all CLOSED-IMPLEMENTED at M10-12)
- **D-10a — pitch jitter WITHOUT `M_Random`** (M10-05): linuxdoom-1.10 burns one
  menu-stream `M_Random()` per `S_StartSound` (s_sound.c:330/:340) — adopting it
  would shift `st_face`/WI stream values and re-bless goldens for a ±1/16 pitch
  wobble no golden can see. We keep the DISTRIBUTION (saw family ±8, others ±16,
  itemup/tink none — plan §0.2) from a sound-owned `splitmix(tic, sfxId,
  originId)` (src/audio/mixerCore.ts:121-135/:415) — deterministic, NOT
  player-timing-dependent. **CLOSED with the zero-stream proof**:
  tests/audio/regression.test.ts (a) asserts the `mRandom` CALL-TREE manifest
  (scanCallTree, whole src incl. the audio zone) == the M9 blessed manifest —
  zero new keys — and (c) hook-log parity vs a muted boot; the full motion/
  golden suite passed UNCHANGED across the whole milestone (zero re-blesses).
  `random-sites.ts` gained NO new key, as promised (plan §1).
- **D-10b — golden = TS software mix, playback = WebAudio nodes** (M10-05):
  OfflineAudioContext runs are not stable across browser builds, so the goldens
  certify the PLAN + the exact i_sound.c int law via `renderMix` (mixerCore);
  the browser path mirrors the same decisions through GainNode chains (linear
  `v/127` ≡ `vol_lookup` linearity, i_sound.c:421-423). **Deviation surface**:
  WebAudio's own source-node resampler for non-native sample rates — audible-
  tolerance item, playtest-checked (ear-only rows in docs/reports/M10-playtest.md).
- **D-10c — 8 sfx channels of record** (M10-05): NOT 1.10's shipped
  `snd_channels=3` artifact (m_misc.c:282) and not a Chocolate claim — 8 is the
  i_sound.c mixer width (NUM_CHANNELS 8, :94), OUR mixer width too, with vanilla
  allocator semantics (free → same-origin steal → priority-evict-or-drop,
  s_sound.c:827-875). Implemented in mixerCore's ChannelState pool.
- **D-10d — volume law restores `*8`** (M10-01): 1.10 passes the 0..15 thermo
  raw (the `/* *8 */` commented call sites, m_misc.c:830/:847, m_menu.c:830/:847,
  d_main.c:1107) — functionally near-silent beyond point-blank. We restore
  DOS-era `internal = thermo*8` (0..15 → 0..120); sfx bus gain `internal/127`,
  music bus `internal/127 × MUSIC_TRIM`. L4-proven: e2e/m10-audio.spec.ts
  (thermo ⇒ gain moved BY THE LAW; 0 ⇒ silent graph).
- **D-10e — live per-tic param updates** (M10-05/06): the mirror's
  `I_UpdateSoundParams` is a documented NO-OP (i_sound.c:675-688 — pan/vol
  freeze at start); we re-apply S_AdjustSoundParams per tic (`updateSounds` +
  the driver tick; Chocolate behavior, roadmap-exit semantics
  “attenuation/panning” as a live property).
- **D-10f — frame-time → tic-time scheduling** (M10-06): vanilla updates sounds
  per FRAME (d_main.c:392) on a wall-clock device; our sim events are
  tic-stamped — sfxDriver schedules at the AudioContext time recorded at each
  tic boundary (ring of 8) with the 100 ms lookahead absorbing rAF jitter.
  Determinism lives in the event ledger (UNCHANGED); audible output has
  sub-frame jitter by design, like vanilla.

## M10-era corrections register (truth corrections banked in JOURNAL, distilled at the exit)
1. **Music-in-WAD correction chain** (M10-08, 3 steps — see JOURNAL): plan §0.10
   claimed 41 `D_*` SMF lumps → the orchestrator's merge-turn “correction”
   claimed ZERO music lumps + pivoted to companion-OGG fetches (the text now
   stamped at M10-plan §0.x) → the implementer MEASURED: the 41 lumps ARE in the
   pinned WAD, **all MThd/SMF, zero MUS, zero OGG** (re-verified at THIS exit:
   D_E1M1/D_INTER/D_VICTOR/D_BUNNY headers + the tests/audio WAD-music census
   golden). THE PLAN WAS RIGHT; the orchestrator's correction was WRONG —
   lesson: orchestration-level “corrections” need measurement too, and the
   agent that checked instead of trusting the brief was correct. The
   companion-OGG machinery landed as a precedence hook with ZERO pinned entries
   (musicSelect `setOggSource`/`makeOggSource`, negative-cached probes); MUS
   transcription stays CANCELLED (`musDecoder=false`). The JOURNAL line's
   “embedded OGG (OGGVORB)” parenthetical was itself a wording slip — exit-time
   byte check says MThd.
2. **`m_musicvol` real-row** (M10-09): the plan carried a no-op premise for the
   music thermo row; the SoundDef rows for BOTH sfx and music volumes are REAL
   live rows in 1.10 (m_menu.c:820-849) — corrected against source; defaults 8/8
   (m_misc.c:237-238), wired live through wiring.ts (D-10d law).
3. **The 41-site ledger WAS exactly the worklist** (D019 → M10-04): the M9
   silent-M9 D-list (menu 28 / wintermission 11 / finale 1 / title 1) turned out
   to be complete — the swap touched ZERO call sites beyond it (evidence grep at
   exit: `sfxStub(` outside src/sim/hooks.ts == 0; sim-side ledger files
   untouched), and the 3 `mus_*` stub bodies were the only music addresses plus
   the ONE new sim-side call site (`musicSlot('level', true)` at
   game.ts:389, the P_SetupLevel tail per p_setup.c:607).

## D-11a..g — M11 (persistence & options) decisions of record (plan of record: M11-plan §3; all CLOSED-IMPLEMENTED at M11-12)
Closure table (decision · question · how it closed, with exit-time evidence):

| decision | question | closure (evidence at M11-12) |
|---|---|---|
| **D-11a** | byte-faithful `.dsg` or vanilla header + OUR payload? | **CLOSED-IMPLEMENTED — byte-honest where observable.** `src/persist/codec.ts` emits §0.1 EXACTLY: 24B description, `"version 110"` @24, skill/ep/map @40-42, playeringame @43, 3B leveltime @47, `0x1d` terminator, SAVEGAMESIZE cap as a typed error; failure modes typed (`BadVersion` silent-return semantics, `BadMarker`), never console throws. Payload = versioned `DBP1` container — internal state, never a fidelity surface (nothing external reads our files; the only observable header byte IS the 24B description the menu shows). Evidence: codec corrupt-input battery + goldens set `persist` (12 scenes blessing the sha of the REAL saved bytes). |
| **D-11b** | where do save/load/hydrate sit relative to the sim clock? | **CLOSED-IMPLEMENTED — persistence never inside gTicker.** Capture runs INSIDE the gameaction drain (pure `captureWorld` ⇒ bytes at the exact tic boundary, vanilla's own site); the IndexedDB write is async AFTER the tick; loads request `ga_loadgame` and execute in the NEXT drain (g_game.c:627-628 deferral kept). Boot: settings hydrate is AWAITED BEFORE the first `gTicker` (main.ts `afterLoad`; consumes ZERO tics; boot-order pin in debug.test) — the "hydrate-off-sim-clock" clause: a slow IDB read can never shift the RNG or the first tic. Money shot: e2e/m11-persist.spec test 1 — save → real `page.reload()` → load → exact `state().hash` + 12100 sampled pixels + 100-tic trajectory identity. |
| **D-11c** | demo desync detection? | **CLOSED-IMPLEMENTED — faithful zero.** 1.10 demos carry NO checksum (the consistancy machinery guards netcmds only); we added none. Determinism is certified test-side by the record→replay hash-identity golden; desyncs stay silent like vanilla. |
| **D-11d** | how are bindings/config persisted? | **CLOSED-IMPLEMENTED — config = the default.cfg variable set**, ported to the IDB `settings` store with m_misc.c defaults (write-on-quit ⇒ write-on-change+debounce: a browser never quits). The m_misc default table data-ified (`bindStore`); NO bind menu (1.10 truth — `M_bind`/`M_Keybinder` grep empty; a menu would be a 1.9 feature). Truth corrections landed with it: gamma is NOT a settable 1.10 setting, mouse0 is a dead key, `show_messages` defaults ON. Evidence: settings census test vs the live mirror + e2e test 2 (vars applied PRE-first-tick across a reload). |
| **D-11e** | where do demo bytes live? | **CLOSED-IMPLEMENTED — demos are first-class BYTES** (record → `captureSink` → downloadable `.lmp` Blob; playback consumes bytes via `playDemo()`/`loadLmp()` — the browser answer to 1.10's lump-only I/O, and the pinned WAD has ZERO DEMO lumps). Attract stays TITLEPIC-only (D023 reaffirmed, cross-ref below); user-demo attract remains Post-M12 stretch; `-record` has no vanilla key ⇒ the debug seam is the affordance. **End-of-demo TRUTH-FLIP:** playback ends via the `G_DeferedInitNew` route — the level stays PLAYABLE (g_game.c flag-reset; NOT the folklore "returns to title/menus", and never `G_InitNew`). |
| **D-11f** | when do cheat effects land? | **CLOSED-IMPLEMENTED — event-pump timing.** Effects fire through `hooks.cheatSink` in the responder phase (vanilla `ST_Responder` order, `if/else-if` chain preserved), never mid-tic; god/noclip toggles gate the NEXT tic so the hash is untouched by the toggle itself; the ledger records the effect tic. Ledger: docs/reports/M11-cheats.md (inventory + verify hooks). |
| **D-11g** | `platform/storage.ts` or a `src/persist/` zone? | **CLOSED-IMPLEMENTED — zone landed.** `src/persist/` (idb/store/codec/settings/demoFile) with an eslint boundary rule (sim imports NOTHING from it; violation fails `npm run check`) — the ARCHITECTURE §9 A-10 pointer note is now IN the doc; D008 otherwise unchanged. |

## M11-era truth flips — the folklore deaths register (distilled at the exit; sources re-grepped at M11-12)
- **F2/F3 quicksave/quickload: DO NOT EXIST in 1.10.** F2/F3 open the Load/Save MENUS (m_menu.c:1548-1560); the quicksave keys are F6/F9. Cited absence (grep), M11-03, re-verified at M11-11.
- **F6/F9 quicksave/quickload DO exist** (m_menu.c:1572/:1587 → `M_QuickSave`/`M_QuickLoad`; KEY_F6/F9 doomdef.h:262/:265) — the orchestrator's pre-plan folklore ("1.10 has no quicksave") died with F2/F3. The prompt strings are the d_englsh set: QSAVESPOT (`you haven't picked a quicksave slot yet!`), QSPROMPT/QLPROMPT (`quicksave over your game named '%s'?`) — src/ui/textdata.ts:53-65, pinned by e2e test 4. PROVENANCE NOTE: the M11-11 merge subject says *"'save quick' is the real prompt string"* — the exit grep finds NO such string anywhere in the linuxdoom-1.10 mirror (d_englsh.h quick-strings are exactly the four above); the verified prompts are the d_englsh ones. Both readings kept deliberately, M10 corrections-register style.
- **`iddqd` is the god code — `idkdt` NEVER EXISTED** (m_cheat.c/st_stuff.c decoded-table census at M11-09). Also dead: bare `noclip` (a source COMMENT claims it; no sequence — typed, it does NOTHING, asserted by test), bare `mypos`, `dtent`, IDK*-style variants. `idmus<nn>` = an `<ep><map>` PAIR (the M10 deferred slot consumed); `idclev`'s commercial epsd=0 source bug KEPT (does nothing in 1.10-commercial; unreachable under our shareware policy anyway); **d_main.c contains ZERO cheat code** — the engine is m_cheat.c, the responder is ST_Responder (+ AM_Responder's iddt).
- **Savegames carry NO RNG state**: load runs `M_ClearRandom` — both streams reset to table entry 0 (the load-determinism backbone; pinned in tests/persist: post-load counters == 0 + first-N draws == table prefix).
- **Demos never checksum** (D-11c) and **demo end leaves the level playable** (D-11e). **6-slot save menu** over a 10-entry `savegamestrings` array; **no bind menu** (D-11d).

## Salvage protocol lessons (silent deaths #10/#11 — both closed GREEN in-milestone)
- **#10 (M11-08)**: write-early-commit-early paid again — the dead worktree held a stub commit + 5 uncommitted test files, the author's pending edits recovered from transcript. The WIP was briefly merged then REVERTED to keep main green (new rule exercised: never guess-merge unfinished WIP into main; finish on the salvage branch). Finisher t2: 50/50 corpus green, ZERO src bugs found (every original failure harness-side).
- **#11 (M11-11)**: full suite was already committed on the dying branch + in-flight polish committed to the salvage branch; the merge honestly exposed 5/6 red ("the suite is real, unfinished") — isolation proved test 2 PRODUCTION-side; the finisher ran with wiring-zone fix authority (sim off-limits) and STOP-and-report discipline: 6/6 ×2.
- Standing rules that saved both: salvage briefs say "finish on YOUR pi-agent-\* branch" (M9 decoy-merge fix), early commits, and a merge turn that reports RED honestly instead of massaging assertions.

## D-12a..h — M12 (full-episode hardening) decisions of record (plan of record: M12-plan §3; D-12a..f CLOSED-IMPLEMENTED at the M12-11 exit sweep 2026-09-23; D-12g/h are in-milestone gap decisions recorded at the same exit)
Closure table (decision · question · how it closed, with exit-time evidence):

| decision | question | closure (evidence at M12-11, 2026-09-23) |
|---|---|---|
| **D-12a** | measure-then-pin budgets — what are the REAL numbers, and do we optimize? | **CLOSED-IMPLEMENTED — measured, well inside budget, ZERO optimization commits.** Node probe (`tests/perf/evidence/node-results.json`): heaviest scene E1M7 (539 mobjs) sim p50 0.048 ms/tic / p95 0.085, render p50 0.950 ms / p95 1.095, frame p95 1.17; worst scene (fire40) frame p95 1.45 ms. Browser real-rAF (`browser-results.json`, 30 s × 3 scenes, 320×200): 60.0 fps / 35.0 Hz, tic p50 0.1–0.2 ms, worst **frame p95 2.4 ms**, max 2.6. Caps stay at the proposal (p50 ≤ 8 / p95 ≤ 13 ms, `tests/perf/budget.ts`; 500 KB gz bundle vs 181,516 B measured, `e2e/build.spec.ts`) — frozen, NOT tuned-to-pass; hottest engine frame `renderSegLoop` 15.5 % self (`flame-summary.md`) is the map for any future optimization, none warranted. NOTE: the M12-04 merge-subject numbers (0.204/0.514 ms) appear in no committed artifact — the evidence tables above are the record. |
| **D-12b** | ship scope: full-IWAD pin but which episodes? | **CLOSED-IMPLEMENTED — E1-only shareware policy CONFIRMED.** `GAME_MODE='shareware'` stays pinned on the full Phase-1 IWAD (36 map markers); `clampNewGame`/episode-select surface, E2–E4 pars and the E1→E2 boundary stay dormant (Post-M12; markers retagged per D-12d). The milestone's own evidence covers E1 exhaustively: 9/9 census, 117×9 corpus, 9/9 exit routes — nothing in M12 needed E2+, and nothing in E1 was found wanting. |
| **D-12c** | demo interop claims? | **CLOSED-IMPLEMENTED — ours-only perimeter, stated publicly** in `docs/release/notes.md` ("interop with 1990s id demo files is unclaimed"); byte-shape goldens (M11) still prove the vanilla-Faithful header/body. No interop test was attempted or faked. |
| **D-12d** | the "M12" netcode-marker comments — land or retag? | **CLOSED — retagged, nothing landed.** The pDemo/thinglinks/reborn/game `M12` IOUs, `ga_screenshot`, dehacked thing-edits and the bsp audit note read "Post-M12 stretch" (documentation truth per plan §3; comment-only src touches); no netgame, no screenshot seam shipped. |
| **D-12e** | multi-engine CI now? | **CLOSED-IMPLEMENTED — CI stays chromium.** Probe on this machine: firefox/webkit playwright builds NOT installed (`docs/reports/M12-browser-matrix.md` §1, honest no-op); `PW_EXTRA_BROWSERS`-gated experimental projects exist but are skipped by default (`npm run e2e -- --list` → 74 tests, identical set with/without the flag). The 15-min manual Firefox/Safari script + known-risk table is the compliance surface — **awaiting a human run** (open item, Phase 4). Revisit only if the matrix reports a finding. |
| **D-12f** | PWA / offline? | **CLOSED — NO service worker.** Offline means the file picker / `?wad=` path (README), honest for a 31 MB user-supplied WAD we do not ship. Revisit only for an app-shell host request. |
| **D-12g** | B-11 "E1M2 elevator unresponsive" — engine bug or probe bug? | **CLOSED NOT-A-DEFECT — the engine was faithful all along** (2026-09-23). The filed probe crossed the dispatcher families — 120/121 are WALK specials (`p_spec.c:929` GR / `:754` W1), 122/123 USE specials (`p_switch.c`, reuse-0/reuse-1 blocks) — and sampled around the ~113-tic blazeDWUS cycle. The monster-cycle "quirk" is 1.10-correct per **p_spec.c:503**: monsters DO trigger walk-over lines (only missiles are excluded), and GR-120 never disarms — the tag-5 panel ambush is Freedoom level design, flood-verified no-softlock (JOURNAL, tag-5 geometry note). Closure artifacts: 5-test tripwire suite `tests/headless/bug-b11-elevator.test.ts` (walk both directions riding the slab, USE from front sector 228, faithful-no-op documentation of the crossed dispatch) + live cross/use/ride regression routes (94b8536, 6434f8f). Zero src change ⇒ zero stream movement. User-facing truths: lift EDGE line 1287 is walk-over (USE does nothing, vanilla too); post-reborn first USE needs ≥1 tic key release (g_game.c:797). |
| **D-12h** | OPTIONS mouse-sensitivity didn't persist — persistence-only patch or law fix? | **CLOSED-IMPLEMENTED — fidelity default: the menu law pump.** The 1.10 truth is M_SaveDefaults writing the change (m_menu.c); our browser answer is write-on-change at the SAME place the volumes ride (M10-09 precedent) — the main.ts law pump now consumes menu sensitivity changes and applies them live + persists them to the settings store (d97e989). Chosen over a one-off localStorage patch because it keeps ONE config law (every menu thermo — volumes, sensitivity — moves its consumer and the store identically); pinned by `e2e/m12-10-menu-sens.spec.ts` across a real reload. |

Lettering note (flagged at the exit sweep): the exit brief's draft letters
(a=E1-only, b=perf, c=elevator, d=sensitivity) conflict with the plan of
record and the already-merged release notes, where **D-12a =
measure-then-pin and D-12b = E1-only**. This ledger keeps the PLAN's
letters for D-12a..f (so `docs/release/notes.md` citations stay true) and
records the two late additions as D-12g/D-12h.
