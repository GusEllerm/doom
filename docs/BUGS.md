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
| B-07 | Monsters never move/attack visibly in live play (though player takes proximity damage) | TRIAGE |
| B-08 | Player still cannot damage/kill monsters via shooting in live play (worked for agent's harness-level ticcmd kill test) | TRIAGE |

Class note: harness (game.ts + scripted runTics) says combat+AI work; the REAL rAF/real-time browser path disagrees. All prior AI/combat specs use runTics/warp seams — none drive a genuine 35Hz rAF session with real input into monsters. Gap: **browser-live soak spec**.
