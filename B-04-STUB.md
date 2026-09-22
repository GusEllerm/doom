# B-04 stub — lifts/elevators: not stateful + screen glitch mid-ride

Branch `task/BUG-lifts-t2` off main @ 094b20b. Prior attempt died at stub.

Plan (docs/BUGS.md B-04):
- (a) Enumerate E1M1 real elevator/lift specials from WAD (line specials + sector types), simulate each ride; compare platThink state machine vs p_doors.c/p_plats.c semantics (downWaitUpStay vs downAndWait, W1 consume-once vs SR/S1 reuse, stayDown waits forever).
- (b) Render 5 mid-transit frames vs per-frame reference; identify artifact signature (HOM / tear / black band); minimal fix.
- Regression tests: per-special state trace on E1M1 elevators, 500-tic stay-down persistence, retrigger correctness; mid-motion frame render asserts (hom==0, row monotonic).
- Gates: `npm run check` green, goldens `--check` green. NEVER touch docs/**.

Status: IN PROGRESS.
