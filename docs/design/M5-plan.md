# M5 Plan — Player physics + input (the FEEL milestone)

Status: planned. Parent: docs/ROADMAP.md M5. Inputs: ARCHITECTURE.md §3 (tic loop, A-08) / §6 L2/L4 / §9, R04 §6-§9 (primary: player mobj, thrust/friction/bob, P_CheckPosition/P_TryMove/slide, gravity — re-read this pass), R08 §8 (P_CalcHeight viewheight ramp, p_user.c line refs) + §9 (cheats), R04 §1-§3 (ticcmd/G_BuildTiccmd — already merged in `sim/ticcmd.ts`), g_game.c re-read (mouse/turn constants), M2-plan (D009 fly stub being replaced), M4-plan (predecessor format).
Exit (from ROADMAP): 35 Hz tics via rAF accumulator (L2 scripted-cmd goldens: momentum/friction/step-up/fall/bob hashes); keyboard + pointer-lock mouse (L4); `p_user` replaces the M2 fly-stub; **same collision path as AI** (AI arrives M8 — the path is simply the shared `P_TryMove` every mobj will use).

## 0. Source truths pinned this pass
1. **Movement constants (all verified, g_game.c:174-177 + p_local.h + p_mobj.c):** `forwardmove[2]={0x19,0x32}`, `sidemove[2]={0x18,0x28}`, `angleturn[3]={640,1280,320}`, `MAXPLMOVE=0x32`, `SLOWTURNTICS=6` (already in ticcmd.ts); thrust = `cmd->forwardmove*2048` ⇒ walk **51200**, run **102400** [R04 §7]; `FRICTION 0xe800` (×0.90625/tic), `STOPSPEED 0x1000`, `MAXMOVE 30*FRACUNIT` (half-split stepping), `GRAVITY FRACUNIT`, step/step-down limit = literal **`24*FRACUNIT`**, player r16/h56, `VIEWHEIGHT 41*FRACUNIT` [R04 §6-§9]. Derived terminal walk speed ≈ 546133 ≈ 8.33 u/tic ≈ 291 u/s.
2. **No friction/thrust *tables* in 1.10.** mobjinfo/`info.c` has no friction/thrust columns and there is no sector friction (that's the 1.9+ line); one global `FRICTION` define. **No `P_IsTooFast`, no `P_CheckFallDamage`, no fall damage at all** — `A_Fall` only clears MF_SOLID; hard landings are cosmetic (`deltaviewheight = momz>>3` squat [+ oof sfx, M10]) [R04 §7, §9]. Do NOT port 1.9-era formulas.
3. **`P_TryMove(thing,x,y)`** — 1.10 signature, **no dropoff parameter**; after `P_CheckPosition`: `tmceilingz-tmfloorz < height` ⇒ no; `!(MF_TELEPORT) && tmceilingz - z < height` ⇒ no ("must lower itself"); `!(MF_TELEPORT) && tmfloorz - z > 24*FRACUNIT` ⇒ no (**step-up**; the headroom-above-step check IS this tmceilingz test — no separate search); `!(MF_DROPOFF|MF_FLOAT) && tmfloorz-tmdropoffz > 24*FRACUNIT` ⇒ no (players have MF_DROPOFF ⇒ may walk off ledges) [R04 §8].
4. **`P_CheckPosition`**: seeds `tmfloorz=tmdropoffz=sector.floorheight; tmceilingz=sector.ceilingheight` from `R_PointInSubsector` (→ `bsp.sectorAtPoint`), `validcount++`, `numspechit=0`; `MF_NOCLIP → return true` **after** the z seed (noclip keeps floor/ceiling tracking — matters for z); then **things first** over the box extended by `MAXRADIUS 32*FRACUNIT`, then **lines** unextended via block iterators; `PIT_CheckLine`: bbox reject → `P_BoxOnLineSide != -1` reject → one-sided blocks → `ML_BLOCKING` (monsters also `ML_BLOCKMONSTERS`) → `P_LineOpening` narrows z's; spechit unsorted [R04 §8]. **No specialLine66/69 special case exists in 1.10** (1.9-line folklore); blocking = exactly that rule list, slide blocking = `PTR_SlideTraverse`'s height tests.
5. **Things blocking is new sim state:** `PIT_CheckThing` needs thinglinks blockmap cells — M5 adds a minimal thinglinks grid (static `MF_SOLID` things only: no pickups/MF_SPECIAL touch [M7], no monsters [M8], no missiles). `P_TeleportMove`/`PIT_StompThing` telefrag (players take `P_DamageMobj(…,10000)`) is **not** reachable in M5 (no teleporters — M6); port the function shell so M6 adds no p_map churn.
6. **Slide (`P_SlideMove`, "kludgy mess")** [R04 §8]: 3 leading-corner `P_PathTraverse(PT_ADDLINES)`; `PTR_SlideTraverse` blocks on one-sided-front, `openrange<height`, `opentop-z<height`, `openbottom-z>24*FRACUNIT`; closest `bestslideline` minus fudge `0x800`; `P_HitSlideLine` (axis-aligned ⇒ zero that axis, else project via finesine/cosine deltaangle); `P_TryMove` remainder else `goto retry`, `hitcount==3 → stairstep` (`TryMove(x, y+momy)` else `(x+momx, y)`). `P_InterceptVector` keeps the `>>8` pre-shifts (binding, ARCHITECTURE §3.5.4).
7. **Bob/viewheight (`P_CalcHeight`)** [R04 §7, R08 §8]: `bob = (FixedMul(momx,momx)+FixedMul(momy,momy)) >> 2`, cap `MAXBOB 0x100000`; wave `bob2 = FixedMul(bob/2, finesine[(FINEANGLES/20*leveltime)&FINEMASK])`; viewheight ramps **±FRACUNIT/4 toward (VIEWHEIGHT/2, VIEWHEIGHT]** via `deltaviewheight`; landing sets `deltaviewheight = momz>>3` (P_ZMovement) / `viewheight -= floorz-z; deltaviewheight = (VIEWHEIGHT-viewheight)>>3` (P_MobjThinker step-down); `viewz = z + viewheight + bob2` clamped `ceilingz-4*FRACUNIT`. No `bobmove`/0x0ccccccd (that's the 1994 leak).
8. **Mouse, verified from g_game.c this pass**: `ev_mouse`: `mousex = data2*(mouseSensitivity+5)/10` (default sens 5 ⇒ ×1); per tic in `G_BuildTiccmd`: **`forward += mousey`** (vertical mouse = forward/back!) and `strafe ? side += mousex*2 : cmd->angleturn -= mousex*0x8`, then `mousex = mousey = 0` (consumed once). **1.10 has NO pitch/mouselook** — no m_pitch, no data3-pitch; pin this so nobody "fixes" it. Keyboard turn = `angleturn[tspeed]` + `turnheld/SLOWTURNTICS` ramp, already merged (D009 note 2).
9. **Assets verified in-tree**: rAF accumulator merged (main.ts, A-08 — verify-only task); `blockmap.ts` CSR line iterators (`blockLinesIterator/BoxIterator`); `bsp.subsectorAt/sectorAtPoint`; `sim/map.ts` SoA incl. line flags + bboxes; thinglinks: **none** (M5-02 adds); `GameInput` has no mouse fields (M5-07 adds deltas); `__doom.sim.{stepTics,warp,setNoclip}` e2e hooks live; M2-06 1000-tic determinism golden exists (loop.test.ts) with fly-stub behavior.
10. **Out of M5 (do not stub with fake behavior):** teleporters/sector specials crossing dispatch (M6 — `P_CrossSpecialLine` call site behind a counted stub), noise alert (M8), water/swimming (doesn't exist in 1.10), weapon psprite bob (M7, R08 §1.4 reuses `player.bob` produced here).

## 1. Exit criteria (milestone-level, objectively checkable)
1. `npm run check` green: pmaputl/pmap/pmove/puser/mouse unit suites (BigInt-oracle vectors for FixedMul-heavy slide math; hand-derived friction curves).
2. L2 scripted golden suite ≥10 scenarios (list in §5.2) with committed x/y/z/viewz/bob hashes + independent re-derivation; noclip goldens show the *same momentum curve* as clipped (D009 closure).
3. M2 fly-stub gone: non-noclip movement runs P_Thrust→friction→P_XYMovement→P_TryMove/slide; noclip = same motion, checks skipped, gravity off via the existing cheat-flag sync.
4. L4: keyboard walk-through route e2e on a FIXMAP + injected-mouse turn/walk assertions through the real ev path; platform pointer-lock unit-tested (browser pointer-lock itself = honest L4 subset, §M5-08).
5. 1000-tic determinism hash green with physics ON — **M2-06 goldens re-blessed** where stub behavior legitimately changed (one-time, reason recorded); L5 motion-strip review filed.

## 2. Task graph and parallel waves

| Wave | Tasks (parallel) | Depends |
|---|---|---|
| 1 | M5-01, M5-07 | M4 main (no intra-M5 deps) |
| 2 | M5-02 | M5-01 |
| 3 | M5-03 | M5-02 |
| 4 | M5-04, M5-05 | M5-03 |
| 5 | M5-06 | M5-05 |
| 6 | M5-08, M5-09 | M5-06 (+M5-07) |
| 7 | M5-10 | M5-08, M5-09 |

Reuses as-is: ticcmd/G_BuildTiccmd incl. turn ramp, keyboard mapping (A-09), rAF accumulator, blockmap CSR, bsp point-loc, map SoA, `runHeadless`/`hashState`, viewpoint/golden machinery, mapBuilder fixture maps.

## 3. Tasks

### M5-01 — p_maputl primitives (p_maputl.c)
- Goal sentence: the geometry helpers every later movement check shares — box-vs-line, line opening, intercept-vector — are bit-exact ports with zero allocation.
- Owns: `src/sim/pmaputl.ts`, `src/sim/pmaputl.test.ts`.
- Must not touch: `src/render/**` (renderer keeps its own r_bsp `pointOnSide`, G11), `docs/**`.
- Consumes: core fixed/tables, map SoA, `bsp.pointOnDivlineSide` (exists). Produces: `pAproxDistance`, `pBoxOnLineSide(bbox,line)` (−1 straddle), `pLineOpening(line)` (opentop/openbottom/opentop-precise incl. ML_DONTPEGBOTTOM mid tex? **no** — 1.10 plain min/max per openbottom/opentop, cite R04 §8), `pPointOnLineSide`, `divLineFrom` helper, `pInterceptVector` (`>>8` pre-shifts verbatim), `P_PathTraverse` DDA skeleton over blockmap (MAXINTERCEPTS 128, validcount, PT_ADDLINES callback; things variant unused until M7 — typed callback only).
- Acceptance: 1) P_AproxDistance/BoxOnLineSide known vectors incl. straddle and negative coords; 2) InterceptVector BigInt oracle incl. den==0 ⇒ 0 and the precision cost pinned; 3) PathTraverse on fixture grid visits exactly the block-crossed lines vs a brute-force reference; 4) zero allocation in steady state.
- Verify: `npx vitest run src/sim/pmaputl.test.ts`

### M5-02 — P_CheckPosition + thinglinks (p_map.c part 1)
- Goal sentence: a candidate position yields the same floorz/ceilingz/dropoffz/block verdict vanilla computes — walls first-class, solid static things via a new thinglinks grid.
- Owns: `src/sim/pmap.ts`, `src/sim/pmap.test.ts`, `src/sim/map.ts` (thinglinks build at map load from thing list; `P_SetThingPosition/UnsetThingPosition` for the player + static list).
- Must not touch: `src/render/**`, `src/sim/blockmap.ts` (consumes iterators).
- Consumes: M5-01, blockmap iterators, `bsp.sectorAtPoint`. Produces: module-static tm-state (tmbbox/tmthing/tmx/tmy/floatok/tmfloorz/tmceilingz/tmdropoffz/ceilingline/spechit[8]/numspechit), `pCheckPosition` faithful order incl. noclip-return-after-seed and MAXRADIUS-extended thing scan, `pitCheckLine` (exact rule list §0.4), `pitCheckThing` (MF_SOLID block; self-skip; MF_SPECIAL/PICKUP path = TODO-counter, items arrive M7), thing spawn grouping at level setup.
- Deps: M5-01.
- Acceptance: 1) wall/one-sided/two-sided-open truth table; 2) floorz = max of openbottoms across touched lines (raised ledge fixture); 3) thinglinks round-trip: player-in-barrel-room blocked, move unlinks/links without thinker re-insertion (determinism rule §3.5.5); 4) E1M1 skipIf: 1000 seeded points' floorz/ceilingz vs brute-force sector+line reference.
- Verify: `npx vitest run src/sim/pmap.test.ts`

### M5-03 — P_TryMove + P_TeleportMove shell (p_map.c part 2)
- Goal sentence: movement is accepted/rejected by vanilla's exact four height tests with step-up and dropoff edges at 24 units, and positions link on success.
- Owns: `src/sim/pmap.ts` (extension), `pmap.test.ts` additions, `src/sim/pcross.stub.ts` (counted `P_CrossSpecialLine` stub — real dispatch M6; spechit side-change scan still runs so the counter is the only gap).
- Consumes: M5-02. Produces: `pTryMove` (floatok=false → CheckPosition → four checks → unset/set position → spechit crossing loop), `pTeleportMove` (box seed + `PIT_StompThing` telefrag path: players take 10000 damage — dead code until M6 teleporters, unit-tested directly), noclip passthrough (flags skip the check block, floorz/ceilingz still update).
- Deps: M5-02.
- Acceptance: 1) 24-unit step accepted, 25 rejected, 24 accepted **only if** headroom `tmceilingz-z ≥ 56` (the §0.3 check, fixture with low ceiling over step ⇒ rejected); 2) ledge rule: player walks off (MF_DROPOFF), non-DROPOFF stub thing refuses; 3) cross into new subsector fires the spechit stub exactly once per crossed special line (count assert — side-flip logic tested via teleport-adjacent fixture); 4) `hashState` unaffected by position change ordering (unset-then-set order pinned).
- Verify: `npx vitest run src/sim/pmap.test.ts`

### M5-04 — P_SlideMove + P_HitSlideLine (p_map.c part 3)
- Goal sentence: a blocked momentum move ends flush against the wall moving along it — the three-corner traverse, 0x800 fudge, and 3-retry stairstep exactly as the comment says ("kludgy mess").
- Owns: `src/sim/pslide.ts`, `src/sim/pslide.test.ts`.
- Consumes: M5-01 (PathTraverse, InterceptVector), M5-03 (TryMove). Produces: `pSlideMove` (corner order per R04 §8, secondslide tracking, `bestslidefrac == FRACUNIT+1 ⇒ stairstep`), `ptSlideTraverse` (height tests verbatim), `pHitSlideLine` (both axis-aligned branches + projection branch), retry/hitcount==3 control flow as explicit loop (no gotos).
- Deps: M5-03.
- Acceptance: 1) 45°-into-wall fixture: final position within 1 unit of the wall, momentum = tangential projection (BigInt re-derivation); 2) axis-aligned mom ⇒ that component zeroed; 3) stairstep fires when the trace hits nothing but TryMove blocked (low-clearance fixture); 4) 3-retry cap reachable in a corner fixture (counter assert, no infinite loop); 5) sign table: all 4 wall orientations × approach sides (slide-vector signs — top risk).
- Verify: `npx vitest run src/sim/pslide.test.ts`

### M5-05 — P_XYMovement + P_ZMovement (p_mobj.c movement)
- Goal sentence: momentum per tic obeys the friction/stopping/gravity constants — the curve that *is* the Doom feel — with MAXMOVE splitting and blocked→slide wiring.
- Owns: `src/sim/pmove.ts`, `src/sim/pmove.test.ts`.
- Consumes: M5-03/04, core tables. Produces: constants STOPSPEED/FRICTION/GRAVITY/MAXMOVE; `pXYMovement` (clamp+half-split loop, `z <= floorz` onground gate is in p_user; player blocked → slide; player not-moving-keys+`|mom|<STOPSPEED` ⇒ mom=0 incl. the RUN-state revert via a state-hook no-op (mobj states arrive M7 — deviation noted)), `pZMovement` (gravity −GRAVITY/−2·GRAVITY start, land: momz=0, z=floorz, squat `deltaviewheight=momz>>3` when `momz < -8*FRACUNIT`, ceiling bump; **no fall damage** §0.2), `pThingHeightClip` (needed by M6 later, cheap here).
- Deps: M5-03, M5-04.
- Acceptance: 1) BigInt-recomputed friction curves: walk accel to ≈546133 asymptote and 0.90625 decay-to-STOPSPEED stop, exact integer per tic for 20/40 tics; 2) MAXMOVE split: mom=64 units crosses exactly as two half steps (blockmap correctness fixture — a split that misses a wall must fail); 3) fall: 100-unit drop lands z==floorz, squat value golden, no HP change (no-damage pin); 4) airborne has zero friction and no air thrust (gate lives in p_user, tested here end-to-end).
- Verify: `npx vitest run src/sim/pmove.test.ts`

### M5-06 — p_user.c replaces the fly stub (D009 closure)
- Goal sentence: the player is now a real vanilla mover — thrust, onground-gated inputs, reactiontime, bob and viewheight — and noclip means exactly what vanilla means.
- Owns: `src/sim/puser.ts` (new: `pThrust`, `pMovePlayer`, `pCalcHeight`, `pPlayerThink` real body), rewrites in `src/sim/player.ts` (delete D009 fly path; keep MobjStub until thinker arena needs it), `src/sim/game.ts` (P_Ticker order per §3.2 stays; wire playerThink), `src/sim/player.test.ts`, `docs/DECISIONS.md` (**add D012**: "M5 replaces D009 fly path: noclip = identical P_Thrust/friction/momentum physics with MF_NOCLIP skipping P_CheckPosition/TryMove checks and MF_NOGRAVITY from the existing cheat-flag sync; D009 marked closed/historical").
- Consumes: M5-05. Produces: `P_Thrust` verbatim (finecosine/sine at `angle>>ANGLETOFINESHIFT`), `P_MovePlayer` (angle += `cmd.angleturn<<16` first, onground = `z <= floorz`, ×2048 thrusts, `ang-ANG90` strafe, S_PLAY→RUN1 hook no-op), reactiontime decrement gate (spawn 18), `P_CalcHeight` per §0.7 (also fixes M3's `viewz = z + 41·FRACUNIT` placeholder via puser export consumed by render/view.ts read-through).
- Deps: M5-05.
- Acceptance: 1) ticcmd stream → position goldens replacing the fly-path table in movement.test.ts (dual-pinned: committed hash + re-derivation); 2) noclip ON vs OFF same thrust/friction curve on empty map (same mom trajectory, only wall behavior differs); 3) reactiontime 18 tics of no-thrust post-warp (test warp sets 0 — documented); 4) viewz never above `ceilingz-4·FRACUNIT`; bob == 0 standing, matches re-derived `finesine[(FINEANGLES/20*leveltime)&FINEMASK]` wave walking; 5) `hashState` 1000-tic re-bless (M2-06, one-time reason).
- Verify: `npx vitest run src/sim/player.test.ts tests/headless/movement.test.ts`

### M5-07 — Mouse input: pointer-lock platform layer + ticcmd merge
- Goal sentence: captured-mouse deltas become vanilla `ev_mouse` events with sensitivity scaling, consumed once per tic — turn by mouse-x, forward by mouse-y, **no pitch ever**.
- Owns: `src/input/mouse.ts` + tests, `GameInput` extension (`mouseX/mouseY: int deltas since last tic`), `gBuildTiccmd` mouse section (port g_game.c order: `forward += mousey` before clamp, strafe/turn split, then zero), `src/main.ts`/platform pointer-lock (canvas click → `requestPointerLock`, `mousemove.movementX/Y` → event queue `ev_mouse`; Esc exits lock — UI-only, no sim state).
- Must not touch: `src/sim/pmap*` etc., `docs/**` (DECISIONS via M5-06 only).
- Acceptance: 1) sensitivity math `(d*(5+5)/10)*0x8` per-tic golden incl. integer truncation and negative deltas; 2) mouse-y adds to forward and clamps at MAXPLMOVE with keys (g_game.c order pin: add-then-clamp); 3) deltas consumed-once (two tics from one event don't double-move); 4) pointer-lock plumbing unit-tested at the event-translation seam (fake PointerLock events — headless chromium pointer lock is unreliable, §6); 5) zero sim import in platform path (A-06 lint).
- Verify: `npx vitest run src/input/mouse.test.ts src/sim/ticcmd.test.ts`

### M5-08 — Live-page integration + L4 e2e
- Goal sentence: on the real page, keyboard+mouse actually move the player through E1M1 at 35 Hz with the accumulator, and tests can drive the same channels deterministically.
- Owns: `e2e/player.spec.ts` (new), `e2e/walls.spec.ts` (viewz expectations), `src/main.ts` (mouse wiring land; rAF loop verify-only), `src/debug.ts`/`types/debug.ts` (`sim.injectMouse(dx,dy)` test hook feeding the same queue; `state().player.{x,y,z,viewz,bob}` read-out).
- Deps: M5-06, M5-07.
- Acceptance: 1) FIXMAP route: real KeyW keydown e2e ⇒ `state().player.x/y` changes and after ~35 tics ≈ derived walk distance; stop ⇒ decays to stop within ≤1 unit of expected; 2) `injectMouse(+100,0)` ⇒ angleturn right, `injectMouse(0,-50)` ⇒ forward (vanilla sign pinned in test); 3) E1M1 skipIf: spawn, walk 100 tics toward east, no wall penetration (x delta < corridor width) + walls render sane from the moved position; 4) determinism: same scripted stream via `sim.stepTics` twice ⇒ identical hash; zero console errors everywhere.
- Verify: `npm run e2e -- e2e/player.spec.ts e2e/walls.spec.ts`

### M5-09 — L2 scripted-tic golden suite (the feel evidence)
- Goal sentence: ≥10 committed-hash scenarios pin the physics curves so any constant typo trips CI, each dual-derived (BigInt/oracle re-implementation, not self-referential).
- Owns: `tests/headless/physics.test.ts`, `tests/fixtures/physfix.ts` (fixture map specs: step rooms 24/25, pit room, friction arena, low-ceiling step), `tests/headless/loop.test.ts` (re-bless edit only).
- Scenarios (hashes over scripted tic streams; x/y/z/viewz/bob/leveltime): 1 walk-20t, 2 walk-stop-40t friction curve, 3 run-20t, 4 strafe-20t (`sidemove 0x18` curve differs), 5 step-up-24 (z+24 pinned), 6 high-wall-block+slide (position flush to wall), 7 fall-into-void-land (no damage, squat), 8 bob-60t (viewz wave), 9 turn-ramp-then-walk (tspeed switch at t=6 × thrust angle), 10 noclip-walk (same momentum, wall clipped through), 11 barrel-block (solid thing blocks; non-noclip), 12 ceiling-squat (low corridor viewz clamp).
- Deps: M5-06.
- Acceptance: 1) all hashes committed + re-derived independently in-test; 2) M2-06 1000-tic golden re-blessed once with physics ON (reason: "M5 physics replaces D009 fly stub"); 3) determinism double-run everywhere; 4) fixture maps BSP-green under the property test.
- Verify: `npx vitest run tests/headless/physics.test.ts tests/headless/loop.test.ts`

### M5-10 — L5 feel review + exit sweep
- Goal sentence: humans confirm it *feels* Doom — motion PNG strips and a checklist against R04/R08, findings filed.
- Owns: `scripts/motion-strip.mjs` (boot→step scripted tics→capture per 5 tics→labelled PNG strip; reuses golden dump machinery), `test-results/` outputs, `docs/TASKS.md` (findings), `docs/JOURNAL.md` (review entry).
- Deps: M5-08, M5-09.
- Acceptance: 1) three strips (walk+stop, step+drop, strafe+slide; FIXMAP) and one E1M1-skipIf walk strip reviewed vs checklist: acceleration ramp visible (no instant speed), glide after release ~1 s, steps smooth (no stair-jitter), bob ≈ sinusoidal ≤16 px, no wall sticking/jitter on slide, viewheight constant on flat ground; 2) full `npm run check && npm run e2e && goldens --check` green on integrated main; 3) findings → docs/TASKS.md; 4) D012 in DECISIONS, M2-plan D009 deviation annotated closed.
- Verify: `npm run check && npm run e2e`

## 4. Deviations, decisions, gaps found this pass
- **D012** (drafted here; M5-06 files it in DECISIONS): closes D009 — real physics replaces the fly path; noclip redefined to vanilla semantics (same motion, skipped checks, flag-driven no-gravity).
- RUN-state revert / spawn viewheight: mobj states absent until M7 → state-hook no-ops with counters; bob/viewheight themselves are faithful (they don't read state).
- `P_CrossSpecialLine` = counted stub (M6); the teleportMove/telefrag shell is unreachable until M6 teleporters; `P_NoiseAlert` untouched (M8); weapon psprite bob deferred (M7) reusing `player.bob`.
- Mouse: vertical mouse maps to **forward** per 1.10 §0.8 (no mouselook exists); an optional invert/freelook toggle is a stated post-DONE stretch (ROADMAP) — defaults stay vanilla-faithful.
- `state.ts` hash: viewz/bob/viewheight added to the hashed field list (L2 goldens depend on them) — one-time golden re-bless flagged in M5-09.
- Thinglinks grid is sim-side new state; M4's render-side static-thing list stays independent (M8's full mobj roster will subsume both — noted for the M12 audit).

## 5. Exit verification (run on integrated main)
1. `npm run check` — all M1-M5 suites; BigInt friction/intercept vectors green.
2. L2 evidence (≥10): the 12 scenarios of M5-09 + re-blessed 1000-tic determinism hash; noclip==clipped-momentum assert.
3. L4: `e2e/player.spec.ts` (real keys, injected mouse, E1M1 no-penetration) + walls/automap/viewer specs unchanged-or-updated-with-reason; zero console errors.
4. Pointer-lock honesty note in JOURNAL: browser-level lock asserted only as translation-unit + API surface; movement proven via the event-queue seam.
5. L5: M5-09 strips reviewed vs the §M5-10 checklist (R04 §7/§9, R08 §8); findings filed; D012 merged.

## 6. Risks
- **Constant transcription** (0xe800, 0x1000, 24·FRACUNIT, ×2048, MAXMOVE split): a single wrong digit changes every hash — mitigated by dual-derivation goldens and the §0.1 pinned table; R04 §7 transcripts (not 1.9 folklore) are the arbiter.
- **Step-up headroom edge**: the `tmceilingz - z < height` test uses the *destination* position's ceiling; getting the low-ceiling-over-step case wrong is the classic "climbing into ceilings" bug — dedicated fixture (scenario: M5-03 acceptance 1).
- **Slide vector signs / P_HitSlideLine projection**: the 4-orientation × side matrix in M5-04 acceptance 5 exists because sign flips show as corner-jitter only at real frame rates; e2e slide route is the backstop.
- **Bob × turn interaction**: bob depends on mom magnitude while turning re-aims thrust every tic — a wrong `angleturn<<16` sign poisons both; scenario 9 pins the combined curve.
- **e2e pointer-lock flakiness in headless chromium**: never gate on real lock acquisition — injected `ev_mouse` + translation unit tests carry the load (accepted L4 subset, §5.4).
- **M2-06 re-bless**: physics changes the 1000-tic hash by design — one-time re-bless with reason, plus the OLD fly-path goldens moved (not deleted) so the transition stays reviewable.
