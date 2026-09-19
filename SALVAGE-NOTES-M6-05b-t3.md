# SALVAGE NOTES — M6-05b doors t3

Branch: task/M6-05b-doors-t3 FROM task/M6-05b-doors-t2 tip 4f48c03.
Mirror check: /tmp/DOOM-master/linuxdoom-1.10 = 62 .c files OK (p_doors.c present).

## Own paths (zero overlap with parallel salvage agents)
- src/sim/pdoors.ts + src/sim/pdoors.test.ts
- debug seams (popInput)
- NEVER docs/**

## Recovered from dead t2 agent (committed at 4f48c03)
- T_VerticalDoor thinker + sector 10/14 spawners (doorOpen/doorClose) live.

## Remaining plan (docs/design/M6-plan.md §M6-05)
1. Inventory: npx vitest run src/sim/pdoors + diff pdoors.ts vs main.
2. EV_DoDoor body (bliz monster-gate PIN; DOORSPEED / DOORWAIT / BLZSPEED / BLZWAIT / BLZDEATH from p_doors.h).
3. EV_VerticalDoor body (in-progress door re-use, blurz doorClose raise, crush semantics).
4. Registry doors subtable fill (line specials 1,26,27,28,62,101,117,118).
5. Corpus auto-FLIP verification via specials.test.ts flip counts (no corpus edits).
6. mechanics strip door-through PNG + meta.
7. m6exit e2e guard pending flip.
8. popInput debug seam (M6-13 finding 3).

## Gates
- npx vitest run src/sim/pdoors green
- specials corpus flips green
- npm run check green
- npm run e2e green
- goldens --check unmoved (mechanics +1)
