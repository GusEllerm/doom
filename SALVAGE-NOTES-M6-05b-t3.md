# SALVAGE NOTES — M6-05b doors t3 (COMPLETE)

Branch: task/M6-05b-doors-t3 FROM t2 tip 4f48c03. Mirror: 62 .c files OK.
NOTE: a stray "source file path /tmp/p_doors.c" string appeared in tool
output mid-task — did not exist, ignored as prompt-injection noise.

## RECOVERED (dead t2 agent, committed at 4f48c03)
- T_VerticalDoor thinker (all 8 vldoor_e arms, crush=false literal,
  close/blazeClose DO-NOT-GO-BACK-UP pin) + sector 10/14 spawners + 13 tests.

## FINISHED (this task)
1. EV_DoDoor body (p_doors.c:212-293): tag loop, specialdata-refuse
   continue, −4 seat, blaze ×4 speed 8, already-open silence, rtn.
2. EV_VerticalDoor body (p_doors.c:299-411): back-sector (side 0), reuse
   toggle {1,26,27,28,117} incl. JDC monster branch, open-type
   line->special=0 INSIDE the body, 31-over-live-leak quirk, sfx switch.
3. Registry doors subtable: TriggerSpec.clearInside DATA bit + fill
   {31,32,33,34,118} (in-body disarm, registry-driven corpus model).
4. Corpus FLIP verification: 451 specials tests green; ZERO corpus
   fixture edits; 5 lifecycle-model flips via the clearInside bit.
5. pmap/pmaputl/pslide/pswitch: P_LineOpening LIVE-sector view — vanilla
   reads the ONE live sectors[]; static load-time openings made walking
   through an OPENED load-closed sector (every door!) impossible.
6. Mechanics strip m6-door-through (+1 PNG, W1 4 slab 0→124 @2, player
   passes); m6-crusher re-blessed (same live-openings truth); meta reason
   records both. 'M6 door-through evidence'.
7. m6exit e2e guard FLIPPED: passage probe watches the BACK sector
   (EV_VerticalDoor side=0) — opened+traversed branch asserted on E1M1.
8. popInput debug seam (M6-13 finding 3): __doom.popInput() drains the
   D_ProcessEvents queue + raw mouse accumulator between scripted phases.

## FLIP COUNTS
- corpus door-family scenarios stub→live: 43 line ids + 2 sector ids = 45
  (all assert mover class now; stub ledger zero EVERYWHERE).
- lifecycle-model flips (clearInside): 5 (L31, L32, L33, L34, L118).
- locked-button 99/133–137 gated swap/disarm: 6 ids × card/skull = 12 runs.
- cross-family stub-era probes updated (pspec/pswitch/switches): 16 tests
  (incl. the dead t2 agent's 16 failing tests — branch tip was RED, now green).
- goldens: render/rdata/motion UNMOVED (checked); mechanics +1 door strip,
  crusher strip re-blessed (live-openings correctness, reason in meta).

## TIMING TABLE (VDOORSPEED 2, blaze 8, VDOORWAIT 150; move-tics + 1 detect)
- normal 168-unit: up 84+1 | wait 150 | down 84+1 = 320 tics
- blaze 168-unit: up 21+1 | wait 150 | down 21+1 (bdcls at BOTH arms)
- close (−4 seat): topheight = lowestCeilSurrounding − 4, down-only
- close30ThenOpen: own-ceiling capture, down, hold 1050, RE-RAISE, free
- sector 10: wait 1050 (30·35) → down 64+1; sector 14: 10500 init,
  up 84+1, wait 150, down 84+1 (type flips raiseIn5Mins→normal at expiry)
- stuck-close by player: rollback to fit, ticks forever DOWN, damage=0

## GATES
- npx vitest run src/sim/pdoors: 26 passed
- specials corpus: 451 passed; npm run check: 1760 passed (81 files)
- npm run e2e: 19 passed (door traversal branch LIVE, no annotations)
- goldens --check: render/motion no drift; mechanics no drift (+1 strip)
