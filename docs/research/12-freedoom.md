# 12 — Freedoom: Phase 1 (v0.13.0) Verified Profile

Empirical audit of `/tmp/freedoom-0.13.0/freedoom1.wad` (+ freedoom2.wad, COPYING.txt, CREDITS.txt, CREDITS-MUSIC.txt). All facts below were computed with a throwaway Python WAD parser (`/tmp/fdwad.py` + query scripts), not copied from docs. (Supersedes earlier Node-parser attempts.)

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

Parsed lump-by-lump from freedoom1.wad (freedoom2.wad in agreement unless noted).

| Content | Lump(s) | Present? | Size / detail |
|---|---|---|---|
| Title screen | `TITLEPIC` | YES | 68,168 B (raw picture), plus `M_DOOM` logo patch 4,968 B |
| Credits screen | `CREDIT` | YES | 68,168 B raw picture |
| Intermission background | `INTERPIC` | YES | 68,168 B (same byte size as TITLEPIC; distinct lump) |
| Level-complete maps | `WILV00..WILV38` | YES, **36 lumps** | one per map (E*M1→WILV00 … E4M9→WILV38), NOT vanilla’s 5-per-group scheme; sizes 1,410–5,033 B |
| Episode-1 style `CWILV*` | — | NO | absent (Doom 2 convention) |
| Ending text | `ENDTEXT` | **NO** | absent; `END0`–`END6` (120–1,749 B, 7-px-wide graphic strips) exist instead |
| Victory screen | `VICTORY` no; `VICTORY2` YES | partial | 68,168 B raw picture |
| Help screens | `HELP1`, `HELP2` | YES (2) | 68,168 B each (vanilla has 1) |
| Menu graphics | `M_*` | YES, **82 lumps** | incl. `M_DOOM`, `M_SKULL1/2`, `M_NEWG/M_SKILL/M_EPISOD/M_OPTION/M_QUITG`, `M_EPI1..4`, plus ~35 source-port option labels (`M_HUD`, `M_COMPAT` …) that vanilla never draws |
| Status bar | `STBAR`, `STARMS`, `STCFN033-096/121/123-125` (68), `STTNUM0-9`, `STTMINUS`, `STTPRCNT`, `STGNUM0-9`, `STYSNUM0-9`, `STKEYS0-8`, `STFB0-3`, `STPB0-3`, `STFST*/STFTL*/STFTR*/STFOUCH*/STFEVL*/STFKILL*/STFGOD0/STFDEAD0`, `STDISK`, `STCDROM` | YES (177 ST* lumps) | face set complete for 5 skins × expressions |
| Automap graphics | `AM_*` | **NONE** | like vanilla — automap is drawn procedurally |
| HUD font | `STCFN*` YES; `FONTA*` NO | partial | STCFN ASCII coverage 33–96, 121, 123–125 only; **no STCFN097–120, no STCFN122**; `DBIGFONT` extra lump exists |
| Intermission numerals | `WI*` (136 lumps: `WINUM0-9`, `WITIME`, `WIPAR`, `WIP1-4`, `WIBP1-4`, `WISCRT2`, `WIVCTMS`, `WIENTER`, `WIURH0/1`, `WISPLAT`, `WIMAP0-2`, `WIA*`) | YES | full vanilla-equivalent set |
| Attract demos | `DEMO1..4` | YES | 28–85 KB |
| Skies | `SKY1..SKY4` (+ `SKY2A-D`, `SKY3A/B` extras) | YES | 35,080 B patch-style |

**GAPS list** (things our UI layer must synthesize or tolerate):
1. `ENDTEXT` missing → text-scroll ending must fall back to `END0..6` graphics or a built-in text.
2. `VICTORY` missing (only `VICTORY2`).
3. `STCFN097–120`/`122` missing → that range **is the ASCII lowercase block**: Freedoom ships no lowercase glyphs (text is rendered uppercase-only, as vanilla does via toupper). Fallback glyph = `STCFN096` (dot) or space for undefined codes.
4. No `AM_*`, no `FONTA*` — automap procedural, HUD font = STCFN only.
5. WILV is 1:1 per map (36), not 5 per episode — episode-index math `WILV(episode*10 + (map-1))` still works since numbering is episode*10+level-1.
6. Extra `M_*` option graphics (≈35) must be ignored by a vanilla-style menu.

## 5. Audio

- **DS* effects: 69 lumps** in freedoom1.wad (109 in freedoom2.wad). Covers all classic vanilla names (DSPISTOL, DSSHOTGN, …, DSBAREXP, DSNOWAY) plus extras like DSOUCH and DSJUMP.
- **DS header parse** (DSPISTOL, 11,034 B): `03 00 22 56 12 2b 00 00 …` = DMX raw: u16 format=3, u16 sampleRate (0x5622=22050 or 0x2b11=11025), u32 sampleCount, then 8-bit unsigned PCM from offset 8. Verified across all 69: `lumpSize - 8 == u32@4` (sample count) in **69/69** lumps. DSPISTOL: 22050 Hz, 11,026 samples (~0.5 s at 22 kHz).
- **D_* music: 41 lumps** (D_E1M1..D_E1M9, D_INTER, D_INTRO, D_INTROA, D_VICTOR, D_BUNNY, D_E2M1..9, D_E3M1..9, D_E4M1..9).
  **First bytes of every sampled D_* lump: `4d 54 68 64` = `MThd` — Standard MIDI File, NOT MUS** (no `MUS\x1a` magic anywhere). `D_BUNNY` present (credits easter-egg track).
- Support lumps: `GENMIDI` (11,908 B) + `DMXGUS` (5,472 B) for SMF playback; `DP*` (≈69 tiny 5–188 B lumps) hold per-sound info.
- freedoom2.wad: 35 D_* SMF tracks (D_RUNNIN … D_DM2INT).

## 6. Things: full histogram vs Doom1 doomednums

Parsed **all 36 maps** of freedoom1.wad: **16,083 things, 93 unique type values**.

**Coverage: 93/93 types (100% of instances) are valid Doom 1 doomednums** from the `mobjinfo[]` table in `docs/research/06-map-objects.md` §3/§5. **Unmatched list: empty.** No Doom-2-only numbers (6072, 4001, 5001–5007, 4003, 2052, 2058…) appear anywhere — confirming and extending R06’s 7-map sample to the whole IWAD.

**Verdict (R06 cross-ref): Freedoom Phase 1 = Doom 1 thing numbering.** Spawn types 1–4 (36 each) and 11 DM-starts (278) handled per `P_SpawnMapThing` special cases.

Full histogram (type: count), all 36 maps:

```
1:36 2:36 3:36 4:36 5:18 6:16 7:3 8:69 9:1350 10:72 11:278 12:21 13:19 14:190
15:142 16:11 17:28 18:34 19:27 20:42 21:25 22:12 24:72 25:8 26:18 27:12 28:9
29:9 30:14 31:7 32:21 33:29 34:124 35:82 36:17 37:13 38:7 39:9 40:5 41:20 42:26
43:96 44:12 45:22 46:51 47:63 48:130 51:1 53:4 54:80 55:10 56:14 57:43 58:381
59:15 60:22 61:4 62:10 63:21 2001:164 2002:95 2003:70 2004:33 2005:37 2006:7
2007:516 2008:753 2010:379 2011:583 2012:302 2013:42 2014:1108 2015:1164
2018:83 2019:33 2022:4 2023:31 2024:14 2025:45 2026:9 2028:387 2035:401 2045:3
2046:166 2047:87 2048:212 2049:166 3001:2366 3002:531 3003:111 3004:1590
3005:260 3006:349
```

Notes: monsters used: 3001 (2366), 3004 (1590), 9 (1350), 3002 (531), 3006=MT_SKULL pain elemental (349), 3005=MT_HEAD baron (260), 58=MT_SHADOWS (381), 3003=MT_BRUISER hell knight (111), 16=MT_CYBORG (11), 7=MT_SPIDER (3) — all Doom-1 meanings. Unused Doom-1 numbers include 64/65/66/67/71/84 (Doom-2 monsters), 82/83 (SS/megasphere), 85/86 (tech lamps), 68/69/70 (babysitter/knight/burning barrel — 70 absent too), 87/88/89 (boss brain).

Per-map thing counts range 70 (E2M8) – 1187 (E4M7); E1M1 = 292 (matches R06).

## 7. Sprites / flats / textures census

**freedoom1.wad:**
- Sprites: 853 lumps in `S_START..S_END`; **113 unique 4-char prefixes**; **440 unique (prefix, frame-letter) pairs**; frames-per-prefix: 42 prefixes ×1 frame, 24 ×2, 20 ×4, 8 ×5, 6 ×3, 1 ×6, and 12 prefixes with 10–23 frames (the multi-frame actors: TROO, POSS, SPOS, PLAY, PLYC, SARG, SPID, CYBR, HEAD, SKUL, BOSS, MISL…). Prefix set vs vanilla SPR_* enum: 27 vanilla prefixes absent — all Doom-2-only or unused-in-Doom-1-maps: BBRN, BOS2, BRS1, BSPI, CPOS, FATB, FATT, FBXP, FIRE, HDB1–6, KEEN, MEGA, PAIN, POB1, POB2, SGN2, SHT2, SKEL, SSWV, TLMP, TLP2, VILE. Extras not in vanilla enum: `PLYC` (green player skin), `PIST`. **freedoom2.wad: 140 prefixes, 1350 sprite lumps** (full Doom-2 superset: VILE, FIRE, FATB/FATT, CPOS, KEEN, PAIN, SSWV, HDB1-6, POB1/2, BRS1, TLMP/TLP2, BSPI, SKEL, MEGA, SGN2, BOS2).
- Flats: **246** unique names (246 lumps, all exactly 4096 B). Sub-ranges F2_/F3_ empty.
- Textures: TEXTURE1 = **801**, TEXTURE2 = **162** → **963 composite textures**; PNAMES = **1,049** patch names.
- Patches: 1,053 lumps in P-range (≈101 are texture-component patches with frame-like names such as `DOBIGTVA`).

**freedoom2.wad:** flats 246, TEXTURE1 = 963 (no TEXTURE2), PNAMES = 1,054.

## 8. License / attribution (for our CREDITS.md)

License = **BSD 3-Clause “Revised”** (not GPL), © the Freedoom contributors. Exact lines to ship (`COPYING.txt`, 30 lines):

```
Copyright © 2001-2024
Contributors to the Freedoom project.  All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

  * Redistributions of source code must retain the above copyright
    notice, this list of conditions and the following disclaimer.
  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the
    documentation and/or other materials provided with the distribution.
  * Neither the name of the Freedoom project nor the names of its
    contributors may be used to endorse or promote products derived from
    this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS
IS” … (standard disclaimer) …

For a list of contributors to the Freedoom project, see the file
CREDITS.
```

Our CREDITS.md must: (1) reproduce the copyright line + 3-condition list + disclaimer verbatim (bundle full `COPYING.txt`), (2) bundle/point to `CREDITS.txt` (1,030 lines, `N:/S:/E:/W:/D:` contributor records — first entry: “N: Colin Phipps … D: binary lumps (playpal, colormap etc)”), and (3) bundle/point to **`CREDITS-MUSIC.txt`** (205 lines — music IS credited in a separate file, e.g. `--Phase 1-- Title: "Fight for Freedom" by Korp…`, per-track authors incl. episode names “Outpost Outbreak / Military Labs / Event Horizon / Double Impact”). DEHACKED in the WAD carries `SPDX-License-Identifier: BSD-3-Clause` comments — consistent.

## 9. Behavioral deltas to code for

1. **Thing numbering: Doom 1 doomednums, 100% verified** (§6). Key `P_SpawnMapThing` off the Doom-1 mobjinfo table; unknown types → warn+skip (never hard-fail).
2. **No MAPINFO** (absent) — episode names (“Outpost Outbreak” etc.) exist only in CREDITS-MUSIC.txt; hardcode or load from our own data. Map list discovery = E?M? markers.
3. **DEHACKED IS PRESENT** (20,938 B, v3.0, “Doom version = 19, Patch format = 6”) — correction to the prior assumption “DEHACKED absent”. Content: fullbright frame tweaks only (`Frame 185 / Sprite subnumber = 32773`). Loader must at minimum parse/ignore Frame+sprite-subnumber entries safely; ideally apply the 0x8000 fullbright bit.
4. **Music is SMF (`MThd`), not MUS** — no MUS-magic fallback path will ever fire; plan a MIDI synth or silent fallback. GENMIDI/DMXGUS present for supporting ports.
5. **Engine must NOT assume lumps**: `ENDTEXT`, `VICTORY`, `SWITCH`, `AM_*`, `CWILV*`, `FONTA*`, STCFN 097–120/122 (§3/§4). Nested `P1_START/F1_START` markers inside data ranges must be skipped as zero-size markers, not textures/flats.
6. `WILV` is per-map (36) — don’t assume ≤5 per episode when indexing.
7. Ranges may contain zero-size markers and duplicate-name lumps only at map data lumps (9 names × 36); sprite/flat/patch names are unique.

## 10. Fetch recipe + doom1.wad-support notes

```
curl -L -O https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip
shasum -a 256 freedoom-0.13.0.zip   # 3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59
unzip -j freedoom-0.13.0.zip freedoom-0.13.0/freedoom1.wad   # never commit the .wad
```

**doom1.wad (vanilla shareware) support notes**: E1M1–E1M9 only (+E2/E3 for the registered/commercial doom1.wad full version; shareware = 9 maps + DEMO1-3). Our loader, while targeting Freedoom, will also accept doom1.wad, so tolerance list: handle 16-palette PLAYPAL? (also 14 — same size), MUS-format `D_*` in vanilla (SMF in Freedoom) → both decode paths needed; `ENDTEXT` present in vanilla but absent in Freedoom (dual ending paths); `SWITCH` lump optional; DEHACKED optional (absent in vanilla); vanilla STCFN033–122 complete vs Freedoom partial (§4); thing numbering identical (Doom 1 table). Map discovery: if only E1M1.. markers, expose 1 episode; never assume 36 maps or E4 exists.

## Confidence & sources

All §1–§7 numbers computed directly by `/tmp/fdwad.py` + query scripts over `/tmp/freedoom-0.13.0/*.wad` (IWAD headers verified, directory fully parsed, EOF flush verified for freedoom1). §8 quotes verbatim from COPYING.txt/CREDITS*.txt. Thing table cross-ref: `docs/research/06-map-objects.md` §3/§5 (137-entry mobjinfo, Doom-1 numbering). Confidence: **High** everywhere (one parser, reproducible).
