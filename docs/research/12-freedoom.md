# 12 — Freedoom: Phase 1 (v0.13.0) Verified Profile

Empirical audit of `/tmp/freedoom-0.13.0/freedoom1.wad` (+ freedoom2.wad, COPYING.txt, CREDITS.txt, CREDITS-MUSIC.txt). All facts below were computed with a throwaway Node WAD parser (`/tmp/fd_parse*.mjs`), not copied from docs.

Pinned (D005): tag `v0.13.0`; zip sha256 `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59`; per-WAD assets don't exist (zip only).

## 1. Verified files (sizes + sha256)
| File | Bytes | sha256 |
|---|---|---|
| `freedoom1.wad` | 28,795,076 | `7323bcc168c5a45ff10749b339960e98314740a734c30d4b9f3337001f9e703d` |
| `freedoom2.wad` | 28,787,748 | `a8772e088847032510d97ba2312406a6998f21cbab44d4ff10696faa9c0ecd4b` |
| zip (release artifact) | — | `3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59` (pinned D005) |

Zip URL: `https://github.com/free-doom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip` (per D005 pin; only the zip is published, no per-WAD assets).

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
<!-- SECTION 3 -->

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
