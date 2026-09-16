# 12 — Freedoom: Phase 1 (v0.13.0) Verified Profile

Empirical audit of `/tmp/freedoom-0.13.0/freedoom1.wad` (+ freedoom2.wad, COPYING.txt, CREDITS.txt, CREDITS-MUSIC.txt). All facts below were computed with a throwaway Node WAD parser (`/tmp/fd_parse*.mjs`), not copied from docs.

Pinned (D005): tag `v0.13.0`; zip sha256 `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59`; per-WAD assets don't exist (zip only).

## 1. Verified files (sizes + sha256)
| File | Bytes | sha256 |
|---|---|---|
| `freedoom1.wad` | 28,795,076 | `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` |
| `freedoom2.wad` | 28,787,748 | `a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b` |
| zip (release artifact) | — | `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59` (pinned D005) |

Zip URL: `https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip` (per D005 pin; only the zip is published, no per-WAD assets).

Both WADs are `IWAD`, 32-bit directory. freedoom1.wad: 3,163 lumps; freedoom2.wad: 3,610 lumps. WAD header for freedoom1.wad: numLumps=3163, dirOfs=28744468 (dir ends exactly at EOF — no trailing garbage).

## 2. Maps (map-marker lumps)
Parsed from map-marker lumps (each marker is followed by THINGS — all verified):

- **freedoom1.wad: 36 maps = 4 episodes × 9 maps**, Doom-1 (E1M1) format:
  - Episode 1: E1M1–E1M9
  - Episode 2: E2M1–E2M9
  - Episode 3: E3M1–E3M9
  - Episode 4: E4M1–E4M9
  - (Episodes 1–3 mirror Doom 1's 9-map structure incl. secret maps E1M9/E2M9/E3M9; episode 4 "Double Impact" = 9 new maps. Episode names per CREDITS-MUSIC.txt: "Outpost Outbreak", "Military Labs", "Event Horizon", "Double Impact" — but see §9: no MAPINFO lump, so these names live only in docs.)
- freedoom2.wad (for reference): 32 MAP01–MAP32, Doom-2 format.

## 3. Lump inventory vs vanilla expectations

All sizes/counts from the Python parser (`/tmp/fdwad.py`) over the lump directory.

| Item | freedoom1.wad | freedoom2.wad | Notes |
|---|---|---|---|
| PLAYPAL | present, 10,752 B = **14 palettes** × 768 | same | vanilla layout (14 palettes, indices 0–13) |
| COLORMAP | present, 8,704 B = **34 tables** × 256 | same | vanilla layout |
| TEXTURE1 | present, 43,350 B, **801 textures** | present, 51,152 B, **963 textures** | |
| TEXTURE2 | present, 7,936 B, **162 textures** | ABSENT | freedoom2 packs everything in TEXTURE1 |
| PNAMES | present, 8,396 B, **1,049 patch names** | 8,436 B, **1,054** | |
| Flats (`F_START`..`F_END`) | **246 lumps**, all 4096 B, 983,040 B total; contains a nested `F1_START`/`F1_END` sub-range (240 lumps) | 246 lumps, same layout | nested Boom-style markers — parser must skip zero-size `?_START/?_END` markers inside ranges |
| Sprites (`S_START`..`S_END`) | **853 lumps**, 2,539,745 B | 1,350 lumps | |
| Patches (`P_START`..`P_END`) | **1,053 lumps**, 10,075,596 B; nested `P1_START`/`P1_END` sub-range (1,047 lumps) | 1,058 lumps | `P2_`/`P3_` marker pairs exist but are empty |
| `A_START`..`A_END` | ABSENT | ABSENT | alpha-sprite range not used |
| ANIMATED | ABSENT | ABSENT | no generalized animation lump — texture animation is via SWITCHES/ANIMSECT? No: plain masked-texture animation frames only (SWIMIT/NTEXTURE1? not present either) |
| BFND / SFND | ABSENT / ABSENT | ABSENT / ABSENT | sound bindings are vanilla `DS` lumps + DEHACKED-style `DP*` patches (see §5) |
| `P_START` name-shaped frame lumps | 101 patch names inside P-range look like sprite frames (e.g. `DOBIGTVA`, `COMP01_1`) — texture *components*, not sprites | — | |

**MISSING vs vanilla Doom 1 IWAD** (engine must not assume these):

| Lump | Status |
|---|---|
| `ENDTEXT` | ABSENT — replaced by `END0`–`END6` graphic lumps (7px-wide patch-style strips) |
| `CWILV00..04` | ABSENT (Doom-2-only, correctly absent in a Doom-1 IWAD) |
| `VICTORY` | ABSENT — `VICTORY2` present (68,168 B raw flat-style picture) |
| `SWITCH` | ABSENT (no switch-texture override lump) |
| `DOOM` / `GAMECONF` / `OPTIONS` | ABSENT |
| `FLOOR_1`, `HI_START`/`HI_END` | ABSENT |
| `STCFN097`–`STCFN120`, `STCFN122` | ABSENT (68 STCFN lumps: 033–096, 121, 123–125) — font coverage is narrower than vanilla’s 033–122 |

**EXTRA lumps not in vanilla**:

| Lump(s) | Size | What |
|---|---|---|
| `DEHACKED` | 20,938 B | DeHackEd v3.0 patch, Doom version 19, format 6 — **fullbright firing-frame tweaks only** (Frame N / Sprite subnumber = 32773 style). No thing/weapon changes. |
| `GENMIDI` | 11,908 B | GenMusic instrument mappings (SMF support) |
| `DMXGUS` | 5,472 B | GUS patch table |
| `FREEDOOM` | 7 B | IWAD identity marker |
| `DBIGFONT` | 9,949 B | big-font data (source-port extra) |
| `DP*` × ~69 | 5–188 B each | per-sound info records (`DPPISTOL`, `DSDOROPN` counterparts) |
| `END0`–`END6` | 120–1,749 B | ending-screen character strips (see MISSING table) |
| `WIA*` (30×13 B), `WIMAP0..2` | — | intermission map-area animation hooks |
| `DEMO1..4` | present | attract demos |
| `HELP1`, `HELP2` | 68,168 B | two help screens (vanilla has HELP1 only) |

## 4. UI / synthetic-content audit
<!-- SECTION 4 -->

## 5. Audio
<!-- SECTION 5 -->

## 6. Things: full histogram vs Doom1 doomednums
<!-- SECTION 6 -->

## 7. Sprites / flats / textures census
<!-- SECTION 7 -->

## 8. License / attribution (for our CREDITS.md)
<!-- SECTION 8 -->

## 9. Behavioral deltas to code for
<!-- SECTION 9 -->

## 10. Fetch recipe + doom1.wad-support notes
<!-- SECTION 10 -->

## Confidence & sources
<!-- CONFIDENCE -->
