# BUG-spawns stub (B-10)
Live E1M1 via New Game menu spawns ~1 monster; census says 32 hostiles at skill 3.
Prime hypothesis: menu->skill plumbing (missing (skill-1) conversion) corrupts gameskill bit filter in P_SpawnMapThing.
Plan: verify vanilla sites (g_game.c G_InitNew, p_mobj.c P_SpawnMapThing), browser repro across all 5 skills, minimal fix + regression specs.
