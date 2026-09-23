# M12-01 — Nine-Map Census Report (E1, Freedoom Phase 1 pinned WAD)

Machine evidence: `M12-census.json` (this directory) · live assertions: `tests/headless/allMapsCensus.test.ts` (37 green). Generated post-salvage by orchestrator from the committed artifact.

## Gap table

| Map | Lumps | Line specials | Sector specials | Gaps |
|---|---|---|---|---|
| E1M1 | ok | 8 (1,2,11,23,26,62,88,117) | 1,7,9,12 | none |
| E1M2 | ok | 23 (1,2,11,19,23,26,27,28,31,38,48,58,62,63,71,88,97,102,103,109,117,120,123) | 1,2,8,9,17 | none |
| E1M3 | ok | 13 (1,2,7,11,20,23,31,32,51,62,88,103,138) | 1,2,3,5,8,9,12,16,17 | none |
| E1M4 | ok | 12 (1,11,19,26,27,31,36,62,88,97,103,126) | 5,9,12 | none |
| E1M5 | ok | 9 (1,11,31,33,62,88,117,123,126) | 9,17 | none |
| E1M6 | ok | 20 (1,11,20,22,27,28,32,38,48,61,62,97,103,105,107,114,117,120,123,126) | 1,7,8,9 | none |
| E1M7 | ok | 22 (1,2,11,23,26,27,28,36,38,53,61,62,63,71,75,88,97,103,117,123,125,133) | 5,8,9,17 | none |
| E1M8 | ok | 3 (19,31,52) | 7,9 | none |
| E1M9 | ok | 13 (1,2,11,27,31,33,46,62,71,88,103,112,123) | 5,7,9,16,17 | none |

## Unions

- Line specials: 1,2,7,11,19,20,22,23,26,27,28,31,32,33,36,38,46,48,51,52,53,58,61,62,63,71,75,88,97,102,103,105,107,109,112,114,117,120,123,125,126,133,138
- Sector specials: 1,2,3,5,7,8,9,12,16,17
- Content surfaces: 14/14 present (allRequiredLumps all true)
- Structure: BSP walk terminates + blockmap consistent + P_SetupLevel completes 9/9 (live); missingSprite==0 all maps; unimplementedSpecial==0 across driven routes; per-skill spawn census at WAD positions 9/9.

**Verdict: ZERO gaps.** All specials used by all nine maps are in the live registry; every sprite/doomednum resolves; every lump surface present.
