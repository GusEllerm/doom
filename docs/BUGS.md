# Live-play bug ledger (user field report, post-M9)

Source: human play session on dev server (vite, wads/freedoom1.wad), 22 Sep.
All reproduced-or-not statuses maintained here. Headless suites were green —
this is the *persistent live-state* bug class the frame-rebuild goldens can't
see (each golden builds a fresh harness; the browser keeps mutable state across
frames and screens).

| ID | Symptom (user words) | Class | Hypotheses | Status |
|---|---|---|---|---|
| B-01 | "smaller square within the viewport, gets smaller as the game progresses" | display loop | view-window rect recomputed with wrong deltas per frame (R_ExecuteSetViewSize drift?), psprite scale state, or wipe-rect leftover; shrinks => accumulating state | TRIAGE |
| B-02 | "unable to kill enemies; gun shoots but nothing dies" | combat live path | live aim (mouse yaw vs P_AimLineAttack?), or hitscan tracer misses live mobjs, or bridge dispatch differs under real-time tick cadence (worked in scripted e2e kills) | TRIAGE |
| B-03 | "remains on the ground on first level" | content truth | census-verified: E1M1 has NO decor doomednums (vanilla E1M1 has none either) => must be a port artifact (item drawing death-state sprite? corpse-position leak? deco-shot sprites?) | TRIAGE |
| B-04 | "taking an elevator glitches the screen; lifts don't stay down (not stateful)" | sim + render | (a) sector-mid-motion render (3D-floor/clip or visplane on changing heights); (b) plat/stayDown state not persisting — retrigger rule wrong or platform thinker replaced | TRIAGE |
| B-05 | "damage/pickup flash stays that color, never reverts" | palette loop | flash tics never decay in live loop (ST_Ticker? palette posted per-frame without decay), or PlayPal vs FixedColormap stuck | TRIAGE |
| B-06 | "UI elements flicker and eventually disappear (face)" | display loop | statusbar BG-canvas double-buffer discipline: draw-once/erase-every-frame mismatch under rAF (works in harness which redraws fully) | TRIAGE |

Related process lesson: e2e canvas/motion specs pass because they warp+script;
real-time unpaused sessions explore state the specs never hold. Exit sweeps
should add a **live-session soak test** (run dev-realistic rAF loop for N real
seconds, assert state invariants + screenshot diffs over time).

Fixes: reference this ledger; update Status column with evidence per fix.
