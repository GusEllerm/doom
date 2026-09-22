# B-10 exit notes — spawn counts via the New Game menu

Verdict: menu→skill plumbing VERIFIED VANILLA-CORRECT; prime hypothesis
DISPROVEN with live evidence. One real defect found in the same filter
family (ptelept.ts skillBit, fixed here).

Vanilla sites (linuxdoom-1.10 mirror, 62 .c files):
- m_menu.c:915  G_DeferedInitNew(choice, epi+1, 1) — choice 0..4 IS the
  skill_t enum value (doomdef.h:149-153 sk_baby=0..sk_nightmare=4).
- g_game.c:1450 gameskill = skill (NO ±1 anywhere; G_InitNew clamps >4 only).
- p_mobj.c:741-748 bit = 1 (baby) / 4 (nightmare) / 1<<(gameskill-1).
Ours: menu.ts gDeferedInitNew(choice+1) through the documented 1-based
seam (gamemode.ts) → skillToInternal(raw)=raw-1 → skillBit mirrors p_mobj.c.

Skill table (identical before/after — no behavior change on the menu path):
row  gameskill  internal  bit  E1M1 monsters (WAD census = live, both)
 0       1       sk_baby    1   17
 1       2       sk_easy    1   17
 2       3       sk_medium  2   29   (= harness default, monsters.spec)
 3       4       sk_hard    4   46   (3001:18 3002:9 3004:5 9:13 58:1)
 4       5       nigtmare   4   46   (no extra-spawn rule in P_SpawnMapThing)

"32 hostiles at skill 3" was a subset count (dn 3001+3002+3004); freedoom1
dn9=MT_SHOTGUY(13) + dn58=MT_SHADOWS(1) are also MF_COUNTKILL at bit 4.

Evidence: live-browser real-key menu walk (all 5 rows) — alive/byType/
barrels/gameskill all match; spawn positions all resolve to real BSP
subsectors (badPos=0); in-game New Game repeat also correct; full e2e 44/44
+ npm run check green.

See: tests/headless/spawn-skill.test.ts, e2e/spawn-skill.spec.ts,
tests/fixtures/m8Roster.ts E1M1_SKILL_ALIVE, src/sim/ptelept.ts fix.
