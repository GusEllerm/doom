# R06: Map Objects and the State Table Model

Research notes for the TypeScript recreation (Doom 1 format, Freedoom target).
Sources: id Software linuxdoom-1.10 (`/tmp/DOOM-master/linuxdoom-1.10/`), `/tmp/freedoom-0.13.0/freedoom1.wad`.

Status: IN PROGRESS (sections filled as drafted).

## Table of contents
1. State machine semantics (P_SetMobjState, P_MobjThinker)
2. SPR_* sprite enum (full list, 4-char codes)
3. mobjinfo[] — full transcription of all 118 MT_ entries (script-extracted)
4. FRAME_* bit constants, rotation/mirror rules (r_things.c/h)
5. Thing numbering: Doom1 doomednum + Freedoom Phase 1 evidence (E1M1 THINGS histogram)
6. P_SpawnMapThing — exact code, skill/ambush filters
7. P_KillMobj — full quote (gib thresholds, corpse, barrels, player branch)
8. Item pickup — P_TouchSpecialThing + P_Give* semantics, MaxAmmo
9. Barrels & exploding mobjs
10. Notes for our TypeScript port (mobj_t fields, state-table encoding)

## Verified baseline (spot-checked from predecessor)
(filled in section 1/3)

## 1. State machine semantics
(pending)

## 2. SPR_* sprite enum
(pending)

## 3. mobjinfo[] full table (118 entries)
(pending)

## 4. FRAME_* constants and rotation rules
(pending)

## 5. Thing numbering — Doom1 vs Doom2 standard in Freedoom
(pending)

## 6. P_SpawnMapThing
(pending)

## 7. P_KillMobj
(pending)

## 8. Item pickup (P_TouchSpecialThing, P_Give*)
(pending)

## 9. Barrels and exploding mobjs
(pending)

## 10. Port notes: mobj_t fields and state-table encoding
(pending)

## Sources
(pending)
