# Live-play bug ledger (user field report, post-M9)

Source: human play session on dev server (vite, wads/freedoom1.wad), 22 Sep.
All reproduced-or-not statuses maintained here. Headless suites were green —
this is the *persistent live-state* bug class the frame-rebuild goldens can't
see (each golden builds a fresh harness; the browser keeps mutable state across
frames and screens).

| ID | Symptom (user words) | Class | Hypotheses | Status |
|---|---|---|---|---|
| B-01 | "smaller square within the viewport, gets smaller as the game progresses" | display loop | view-window rect recomputed with wrong deltas per frame (R_ExecuteSetViewSize drift?), psprite scale state, or wipe-rect leftover; shrinks => accumulating state | CLOSED: per-tic R_ExecuteSetViewSize violated d_main on-change rule (accumulating border math); +sb3 48px viewheight bug |
| B-02 | "unable to kill enemies; gun shoots but nothing dies" | combat live path | live aim (mouse yaw vs P_AimLineAttack?), or hitscan tracer misses live mobjs, or bridge dispatch differs under real-time tick cadence (worked in scripted e2e kills) | CLOSED: netgame/DM start markers spawned as real mobjs (invisible hitscan sponges) |
| B-03 | "remains on the ground on first level" | content truth | census-verified: E1M1 has NO decor doomednums (vanilla E1M1 has none either) => must be a port artifact (item drawing death-state sprite? corpse-position leak? deco-shot sprites?) | CLOSED: same marker bug — DM/netgame starts rendered as corpse-frames |
| B-04 | elevator glitch + not stateful | renderer staleness | ROOT CAUSE: display rebuild keyed by MAP NAME; New Game/reborn swaps SoA with same name -> renderer drew boot-time arrays (lifts frozen/glitched); plat logic audited VANILLA-EXACT (DWUS 4/tic, wait 105, GR-88/SR-62) | FIXED (identity-key rebuild + per-IWAD hoist) |
| B-05 | "damage/pickup flash stays that color, never reverts" | palette loop | flash tics never decay in live loop (ST_Ticker? palette posted per-frame without decay), or PlayPal vs FixedColormap stuck | CLOSED: P_PlayerThink counter-decay unwired (damage/bonus/bonuscount 2xP_Random parity — vanilla stream restored) |
| B-06 | "UI elements flicker and eventually disappear (face)" | display loop | statusbar BG-canvas double-buffer discipline: draw-once/erase-every-frame mismatch under rAF (works in harness which redraws fully) | CLOSED: stale-SoA identity class (draw-block variant) + texture/flat patch hoist |

Related process lesson: e2e canvas/motion specs pass because they warp+script;
real-time unpaused sessions explore state the specs never hold. Exit sweeps
should add a **live-session soak test** (run dev-realistic rAF loop for N real
seconds, assert state invariants + screenshot diffs over time).

Fixes: reference this ledger; update Status column with evidence per fix.

## Round 2 (second field report, post-fix build)
| ID | Symptom | Status |
|---|---|---|
| B-07 | Monsters never move/attack visibly in live play (though player takes proximity damage) | CLOSED: D018 flip never wired in production (DisplayDeps.mobjs undefined -> fixture snapshot drawn); fresh-array threading |
| B-08 | Player still cannot damage/kill monsters via shooting in live play (worked for agent's harness-level ticcmd kill test) | CLOSED: same root (shots hit TRUE positions of frozen-rendered mobjs; killdoor opened invisibly); live-combat pixel spec added |

Class note: harness (game.ts + scripted runTics) says combat+AI work; the REAL rAF/real-time browser path disagrees. All prior AI/combat specs use runTics/warp seams — none drive a genuine 35Hz rAF session with real input into monsters. Gap: **browser-live soak spec**.
| B-09 | Turning left/right feels like gaining forward momentum | CLOSED: physics clean (mom-invariance theorems); rAF dx-batching fixed (per-tic apportionment, capture-time clamp) |
| B-10 | Only ~1 enemy findable in E1M1 live; kill-door unopenable (user: "spawning outside the level"?) | NO DEFECT: browser census proves 32/32 spawn at WAD positions across all 5 skills; E1M1 hides most hostiles behind the blue-key route; kill-door needs 80% clears. Per-skill census specs added |

## B-11 E1M2 blazing platform (tag 14, sector 124) never engages — RESOLVED (probe artifact; lift works via every live route)

Reported: E1M2 elevator doesn't respond, level can't be completed.

**Resolution (B-11 fixer):** the engine is FAITHFUL; the filed probe swapped
the dispatchers. SOURCE TRUTH for the blaze family: `p_spec.c:492`
(P_CrossSpecialLine — the function the probe's "enclosing-function question"
was about) contains case 120 at p_spec.c:929 (GR, no clear) and case 121 at
:754 (W1, clear); cases 122/123 live in P_UseSpecialLine (p_switch.c:276 —
122 at :479 reuse-0 block, 123 at :616 reuse-1 block). So CROSS(350)/sp 123
and USE(1287)/sp 120 are by-design no-ops (pCrossSpecialLine has no CROSS
route for 123; pUseSpecialLine has no USE route for 120) — "sector NEVER
moves, special stays 123" was measuring the wrong switch, not a defect.
Registry specials-table.ts ids 120/121/122/123 already mirror the C; plat
machinery (pplats.ts blazeDWUS: low=clamped lowest-surround −16, high=40,
speed 8, wait 105 — p_plats.c) is correct. Verified live routes, all green
in tests/headless/bug-b11-elevator.test.ts: walk-over of GR line 1287 (both
directions) descends sector 124 to −16 and back to 40 incl. riding the slab;
USE of SR line 350 from its FRONT sector 228 (and from corridor 60 through
the non-special line 1337) engages the cycle; direct route-correct dispatch
works. User-facing note: pressing USE never triggers the lift edge (line
1287 is a WALK-over GR special — vanilla too); from spawn, one must release
the use key for ≥1 tic before the first press fires (G_PlayerReborn arms
usedown, g_game.c:797). Zero src change ⇒ zero PRNG-stream/golden movement.
FOLLOW-UP (owned by the M12-03 route-corpus work, NOT here): E1M2's
instance-level live routes were covered by no suite — census drives TYPE
coverage, not per-map instances.

**Probe-misreport mechanism (per-tic re-test, M12-03 evidence @0bf3c54 +
this suite):** the original probe sampled sector 124 only BEFORE/AFTER the
fire+200-tic window. blazeDWUS completes its ENTIRE down-wait-up cycle in
~7+105+7 = ~119 tics (< 200) — the cycle runs to completion BETWEEN the two
samples, so floor@check reads 40 again and the lift "never moved". Per-tic
sampling disproves it: tests/headless/bug-b11-elevator.test.ts asserts a
PER-TIC minimum floor (the tripwire) — sector 124 walks 40→24→…→−16 and
back to 40 on BOTH live routes (walk-over GR 1287 incl. riding the slab;
USE SR 350 from reachable front/corridor positions), matching the merged
M12-03 routes.test.ts / m12-playthrough.spec.ts ledgers. NOT-A-DEFECT:
no src change; the only faithful no-ops are cross-of-123 and use-of-120
(wrong-family dispatches — see SOURCE TRUTH above). Live-path checks that
could have hidden a gap all pass: use-trace geometry from the ledge-60/
slot-228 reachable positions reaches L350 through the non-special line
1337 (no premature useNoWay), and L1287 needs no use at all (W/GR family
are walk-triggered; USE on it is a vanilla no-op).

Orchestrator triage (direct-dispatch probe, headless E1M2, deterministic):
- Sector 124 (tag 14, floor=40, ceil=168, single tag14 sector) is a blazing DWUS lift.
- Its trigger lines: 350 (sp 123, front 228 floor −16) and 1287 (sp 120, front 219 floor 48).
- Lowest surrounding floor = −16 ⇒ vanilla EV_DoPlat(blazeDWUS) MUST go down to −16, high=40, wait 105 (p_plats.c blazeDWUS branch: low=FindLowestFloorSurrounding clamped; high=current).
- Observed in our port: firing pCrossSpecialLine(350)/pUseSpecialLine(1287) directly → sector NEVER moves; after fire, lines.special[350] STILL 123 (cross-side clear not reached ⇒ dispatcher/EV path exits before creating the plat, or plat blocked/removed in same tic).
- Registry table (specials-table.ts ids 120/121/122/123) route semantics need re-verification vs p_spec.c enclosing-function boundaries (use vs cross section) — 120 registered GR-cross in our table, 123 SR-use; verify W1/S1 assignments for the blaze family against the C switch sections (enclosing-function question OPEN: which function contains p_spec.c:929 case 120?).
- Siblings that DO move: other blaze/ DWUS tags (5, 10-13) responded — the defect is tag/scenario-specific or the 120/123 dispatch route only.
- Note: E1M1 census drives route sets; live player path apparently never crossed/used these two lines in any suite (M6 corpus covers types, not this map's instances).
