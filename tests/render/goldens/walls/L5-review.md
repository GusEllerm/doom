# M4-08 — L5 review pack: walls goldens, M4 full-frame baseline

Task: docs/design/M4-plan.md §M4-08. Branch: task/M4-08-goldens.
Set: `--set walls` (name retained for the full-scene set — plan §4 deviation),
31 committed scenes = **20 M3 scenes re-blessed ONCE** (reason
"M4-08: M4 full-frame baseline (planes+masked+statics) replaces M3
walls-only"; the "initial M3-08 baseline" entry remains in every
meta.json scene history) **+ 11 new** (7 M4 fixture maps: masked×2, sky×2,
things, panning×2 — wad-free; 4 E1M1: sky courtyard ×2, fenced yard, busy
mix). Sources: 12 WALLFIX + 7 M4FIX (M4MASK/M4SKY/M4THNG/M4PAN) + 12 E1M1
(freedoom1.wad, sha pinned per scene in meta.json).

## Machine gates (L3 — evidence, already green on this branch)
- `npx vitest run tests/render/walls.test.ts` — 31 golden cases:
  double-render **byte-identical**, `hom == 0`, `visplaneOverflow ==
  visspriteOverflow == openingOverflow == drawsegOverflow == 0` (both renders).
- `npm run goldens:update -- --set walls --check` — no drift (31/31).
- `npm run check` / `npm run e2e` green (12-scene in-page walk + the new
  sky pixel-band assert for e1m1-court-sky: top-20-row non-black > 3000).

## Reviewer checklist (R03 §7/§8/§11/§12; verdicts welcome — machine evidence below each item)
1. **Flat texture alignment / orientation** — FLTRAMP0 (px = x column
   mirror tell), FLTCHK0 checker and FLTEDG0 corner codes: `fixpan-*`
   frames + fixture floors; flats are row-major, row 0 NORTH (m4Fixtures
   pinned generators, sha-committed).
2. **Flats lit by zlight falloff, not wall light** — E1M1 floors dim
   toward the distance in every outdoor/long scene (`e1m1-spawn-east`,
   `e1m1-vista-corridor`); fixture flats run through the synth COLORMAP
   rows (fixture scenes), so look for the same near-bright/far-dark ramp.
3. **Light buckets** — the WALLFIX light 0/96/192/255 rooms
   (`fix-a-*` … `fix-d-*`) keep the four scalelight extremes; near-black
   in the dark rooms is the faithful startmap-saturating bucket behaviour
   (viewpoints.ts note), not a regression.
4. **Horizon straight at 90/270** — `fix-a-n/fix-b-n/fix-c-n/fix-d-n`,
   `e1m1-court-sky` (sky–wall junction must be one straight row).
5. **Sky horizon seam + fullbright** — `fixsky-room`: the light-32 room
   dims EVERYTHING except the sky (row-0 values stay in the 1..16 marker
   band under the dimming tables — planes.ts `dc_colormap = colormaps`);
   `fixsky-seam`: sky meets the far wall top with no 1-px gap/overlap
   (plan §6 risk); `e1m1-court-sky`: freedoom SKY1 fills the top band
   (removed-SKY1 diff ≈ 37.6k px; in-page top-band assert in e2e).
6. **Masked holes reveal depth** — `fixmask-fence`/`fixmask-back`:
   diff vs a fence-free twin render = 17,161 painted pixels, **0 of them
   black**, and 40,344 far-wall pixels survive untouched in the parity
   holes (holes show the FAR wall, not the void). E1M1 counterparts:
   `e1m1-yard-fenced` (masked spans × 10 sprite columns), `e1m1-busy-mix`.
7. **Sprite placement / 8-octant / flip** — `fixthings-flip`: off-centre
   ring view = 6 static BAR1s, per-thing rot = (ang − thingangle +
   9·(ANG45/2)) >> 29 → slots 0 (A1, the big near one), 4 (A5) and FOUR
   flipped lumps (A3A7/A4A6 mirrors at columns ≈21-30, 97-102, 237-241,
   288-297 — measured sprite-pixel column groups). E1M1 sanity:
   `e1m1-court-things` (TRE2 grove columns 121-199), `e1m1-spawn-east`.
8. **No slivers / no bleed** — 1-px column slivers along shared edges
   (`fix-a-ne`, `fix-c-ne`, `e1m1-corner-*`, `e1m1-atrium`) and sprite
   bleed through solid walls (pipeline.test.ts occlusion asserts; visual:
   `e1m1-court-sky` left band — sprites there must stand on their own
   floor, not ghost through the courtyard wall).

## Explicit verdicts on the two M3 findings (plan §M4-08 acceptance 4)
- **Atrium masked checker — RESOLVED.** M3: `e1m1-atrium`'s GREEN-family
  fence line drew nothing (walls-only frame). Now: `tests/fixtures/…
  goldens/walls/e1m1-atrium.png` paints 12,673 → 41,170 pixels
  (old → new PNG count); the middle texture draws through the drawseg
  snapshots (M4-04 renderMaskedSegRange + its unit tests), and the
  masked+sprite mix scenes (`e1m1-yard-fenced`, `e1m1-busy-mix`) show
  the same path under sprite interaction.
- **Horizon bands above viewz — RESOLVED (ceiled/skyed).** Every
  previously black top band carries a ceiling flat or sky in the
  re-blessed PNGs (top-60-row non-black: e1m1-spawn-east 2,326 → 14,399;
  e1m1-corner-dm14 12,212 → 19,158; full-frame paint totals 3,975 →
  44,575 at spawn-east). Where the sector ceiling is F_SKY1 the band is
  the SKY1 texture (items 5 above), never the M3 black.

Reviewer notes (expected, NOT bugs — plan §4): monsters invisible until
M8; freedoom fullbrights read dark (no DEHACKED until A-02/M8); sky name
fixed to SKY1; no psprites (M7). E1M1 "emptiness" vs retail screenshots
is the monster exclusion.

## Scene list (31)
| name | kind | setup | warp | sha |
|---|---|---|---|---|
| e1m1-atrium | iwad | atrium hall sector 173 (f -168/c536 L224), W across the 704-tall volume | (1472,1088) @ 270° | `3e18cce73c77…` |
| e1m1-busy-mix | iwad | sky yard sec 39 (f-80/c536 L240) centre, SW — masked shells + BAR1/COLU/TRE statics + sky sliver in one busy frame (all counters 0) | (2200,917) @ 225° | `bc76044fc787…` |
| e1m1-busy-yard | iwad | sector 181 (f48/c536) W into the ruin-yard span soup (solidsegs stress; hom/dso stay 0 — no re-pick needed) | (2400,1152) @ 180° | `3d5b3f838fa3…` |
| e1m1-corner-dm14 | iwad | deathmatch start (2008,480) in sector 124 (f24/c384 L220), SW corner of the tall room | (2008,480) @ 135° | `3b21812df2cf…` |
| e1m1-corner-ruin | iwad | sector 5 (f192/c336) ruin ledge, SW at the corner box | (2500,1700) @ 225° | `76ffac876227…` |
| e1m1-corridor-open | iwad | sector 149 both-open tech corridor, W back along the two-sided flank openings | (1050,-30) @ 180° | `2ba7fdf16e9b…` |
| e1m1-court-sky | iwad | spawn courtyard sec 29 (F_SKY1 f0/c128 L128) from INSIDE, SW — sky fills the band above the ring walls (removed-SKY1 diff ≈ 37.6k px… | (-608,240) @ 225° | `4bb56d4282be…` |
| e1m1-court-things | iwad | thing type 1 spawn, W at the courtyard — TRE2 grove (5 sprite columns ≈96/133/160/171/204) + BON1/STIM/corpse statics + sky sliver a… | (-416,256) @ 180° | `c5c6b64887a8…` |
| e1m1-doorway-midtex | iwad | sector 27 ledge S at linedef 80 METAL5 masked doorway (midtex frame) | (1216,1540) @ 270° | `46ed1a767ef7…` |
| e1m1-spawn-east | iwad | thing type 1 spawn, E down the tech corridor (M3-07 pinned vista) | (-416,256) @ 0° | `8b93ff15c08a…` |
| e1m1-vista-corridor | iwad | sector 57 south corridor, E along the >4000-unit straight run (far scalelight diminishing) | (960,-192) @ 0° | `851fd0fc93a9…` |
| e1m1-yard-fenced | iwad | sky yard sec 23 (f40/c536 L224) centre, N through the MC18/MC17/ASHWALL fence lines — masked spans overlap 10 static sprite columns … | (2224,1323) @ 90° | `58b164c5b691…` |
| fix-a-n | fixture | A(light 0): N THROUGH the A|C light-only edge to the far C-VOID wall (pass-through occlusion + far bucket) | (160,160) @ 90° | `57fbb61646a6…` |
| fix-a-ne | fixture | A(light 0): oblique NE at the A|B floor-change divider corner | (160,160) @ 45° | `4c9215e32dde…` |
| fix-a-w | fixture | A(light 0): W at vertical VOID wall (pancake +1, darkest room) | (160,160) @ 180° | `7cfbc66eebda…` |
| fix-b-n | fixture | B(light 96,f24): N THROUGH the B|D light-only edge to the far D-VOID wall | (480,160) @ 90° | `eb9f6a00d2dd…` |
| fix-b-s | fixture | B(light 96,f24): S at horizontal VOID wall (pancake -1) | (480,160) @ 270° | `69671467312a…` |
| fix-b-w | fixture | B(light 96,f24): W across the floor-change divider (step down into A) | (480,160) @ 180° | `16725e95bde3…` |
| fix-c-e | fixture | C(light 192): E at the DOORFIX0 door gap (midtex, both-open) | (160,480) @ 0° | `48cc790676e0…` |
| fix-c-n | fixture | C(light 192): N at horizontal VOID wall | (160,480) @ 90° | `a71f1ec6aa74…` |
| fix-c-ne | fixture | C(light 192): oblique NE at the door corner (midtex + VOID frame) | (160,480) @ 45° | `f420c2fc07a7…` |
| fix-d-e | fixture | D(light 255,f24): E at vertical VOID wall (pancake +1, brightest bucket) | (480,480) @ 0° | `3b2824dc65d3…` |
| fix-d-n | fixture | D(light 255,f24): N at horizontal VOID wall (brightest) | (480,480) @ 90° | `6b8ff94d7a1a…` |
| fix-d-w | fixture | D(light 255,f24): W at the door gap + floor step from D side | (480,480) @ 180° | `8cafb26848bd…` |
| fixmask-back | fixture | M4MASK room B: W at the same fence from the other side — symmetric masked-range path, far wall A through the holes | (384,128) @ 180° | `5a828fd1e56f…` |
| fixmask-fence | fixture | M4MASK room A: E at the MASKFIX0 masked fence — parity holes must show the FAR wall (B side), opaque columns never black | (128,128) @ 0° | `66e6c263465f…` |
| fixpan-panned | fixture | M4PAN room A (L0): N at the textureoffset-40 sidedef — FIXWALL0 columns shifted 40 px-texels vs the unpanned fix-a-n; rowoffset 8 IG… | (128,128) @ 90° | `11d9a1044a71…` |
| fixpan-rowskip | fixture | M4PAN room C (L255): E at the rowoffset-24-only sidedef — renders UNpanned (rdata consumes textureoffset only); the SIDEDEFS bytes r… | (128,384) @ 0° | `377134f42dbb…` |
| fixsky-room | fixture | M4SKY light-32 sky room: N — F_SKY1 band fullbright under the DIMMING colormap rows (sky light-immunity evidence) | (256,256) @ 90° | `bd90cd556401…` |
| fixsky-seam | fixture | M4SKY: E along the room — the sky plane meets the far wall TOP at the worldhigh seam (plan §6 horizon-seam stress: skytexturemid 1:1… | (64,256) @ 0° | `de1f13d62449…` |
| fixthings-flip | fixture | M4THNG: E from the west edge — near BAR1 dead ahead (slot 0 A1), ring BAR1s at slots 2/3/5 FLIPPED + slot 4, pair BAR1 slot 5 flippe… | (64,256) @ 0° | `3db193e4425f…` |
