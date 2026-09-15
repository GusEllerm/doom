# R11 — Save Games and Demo Format (DOOM 1.10 / Freedoom target)

Sources: id DOOM 1.10 source (`/tmp/DOOM-master/linuxdoom-1.10/`), Chocolate Doom (`/tmp/chocolate-doom-master/src/`). All claims verified against local sources this session; confidence marked per section.

## 1. Vanilla savegame stream (G_DoSaveGame, g_game.c)
(outline)
- 1.1 File layout / order
- 1.2 Players — P_ArchivePlayers (p_save.c)
- 1.3 World — P_ArchiveWorld (sectors/lines/sidedefs/lighting)
- 1.4 Thinkers — pointer serialization trick
- 1.5 Specials/mobjs — P_ArchiveSpecials
- 1.6 Load order — G_DoLoadGame

## 2. What is NOT saved
## 3. Recommended format for our engine (main deliverable)
## 4. Demo format (DOOM1 .lmp)
## 5. Demo sync mechanics
## 6. Save/load UI in our engine
## 7. Determinism checklist (feeds ARCHITECTURE)
