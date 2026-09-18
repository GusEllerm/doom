# M4 Plan — Planes, sky, masked middles, static thing sprites

Status: planned. Parent: docs/ROADMAP.md M4. Inputs: ARCHITECTURE.md §4 (all) / §6 L3 / §7, R03 §3/§7/§8/§9/§11/§12 (primary), R02 §4/§7/§8 (flats, masking, sprite census), R01 §14 (flat format), M3-plan.md (predecessor; recording infra reused as-is).
Exit (from ROADMAP): floors/ceilings/visplanes, F_SKY1 sky, masked middles drawseg-clipped, static thing sprites 8-rot + clipped vs walls; L3 goldens at viewpoints; `state().render.hom == 0`; L5 review.

## 0. Source truths pinned in this planning pass (id-Software/DOOM linuxdoom-1.10, re-read)
1. **NO polysegs.** `p_polysegs.c` does not exist in linuxdoom-1.10 (repo listing verified; zero `polyseg` grep hits in r_*.c). Floors/ceilings are purely visplane: `R_RenderSegLoop` writes `ceilingplane->top[rw_x]/bottom[rw_x]` marks clipped by `ceilingclip/floorclip`; `R_DrawPlanes` → `R_MakeSpans` → `R_MapPlane` → `R_DrawSpan`. There is no `R_AddInPolySegs`, no triangulation, so the DOORFIX "triangulation with holes" concern is moot — per-column spans cannot HOM by construction.
2. **Visplanes (r_plane.c):** `MAXVISPLANES 128` (vanilla `I_Error` on overflow — port: live counter + typed throw, deviation), `MAXOPENINGS SCREENWIDTH*64` (already in drawsegs.ts). `R_FindPlane(height,picnum,lightlevel)` — 3 args, **no scrolling-flat special** in 1.10; sky collapses (`height=0, lightlevel=0`). `R_CheckPlane` splits by *copying* (height/pic/light) to a new plane with `top[]` memset 0xff; the source plane is NOT shrunk. New planes memset `top` 0xff.
3. **Sky = textured visplane, not a flat draw:** `skyflatnum = R_FlatNumForName("F_SKY1")` (g_game.c:454) is only a *tag*; 1.10 `flattranslation[i]=i` (no SKY1 remap). The visible sky is `skytexture = R_TextureNumForName("SKY1"/"SKY2"/"SKY3" by episode)` — a 1024-wide TEXTURE1 texture — drawn per column in R_DrawPlanes: `dc_iscale = pspriteiscale>>detailshift` (1:1), `dc_colormap = colormaps` (always fullbright ⇒ INVUL-immune), `dc_texturemid = skytexturemid = 100*FRACUNIT` (R_InitSkyMap, one line), `angle = (viewangle + xtoviewangle[x]) >> ANGLETOSKYSHIFT(22)` (2³²>>22 = 1024 columns = full circle) → `R_GetColumn(skytexture, angle)`. R_FindPlane merges all sky planes; markceiling stays true for sky even below viewz (r_segs.c:672 `&& ceilingpic != skyflatnum`); `worldtop = worldhigh` outdoor hack when both ceilings are sky (r_segs.c:530).
4. **Plane add rules (r_segs.c:660-675):** `markfloor = floorheight < viewz`; `markceiling = ceilingheight > viewz || ceilingpic == skyflatnum`. R_Subsector opens `floorplane/ceilingplane` with the same predicate pair (R03 §3).
5. **Flat draw (R_MapPlane/R_DrawSpan):** `yslope[i]`, `distscale[i]` (init at view-size), `basexscale/baseyscale` per frame in R_ClearPlanes; `planeheight = abs(height - viewz)`; `planezlight = zlight[lightnum]` (zlight built+golden-tested in M3-01, consumed here); `spot = ((yfrac>>(16-6))&(63*64)) + ((xfrac>>16)&63)` — row-major, matches `wad/flat.ts` `decodeFlat` exactly; cached per-y distance/xstep/ystep.
6. **Masked middles:** recording already faithful from M3-06 (maskedtexturecol in openings pool + sprtop/sprbottomclip snapshots + forced SIL_TOP/SIL_BOTTOM). Draw path = `R_RenderMaskedSegRange` (r_segs.c:100-190): `spryscale = scale1 + (x1-x1)*scalestep` per column, `dc_iscale = 0xffffffffu/spryscale`, `col = R_GetColumn(tex, maskedtexturecol[x]) - 3` (the −3/+3 topdelta quirk, pin it), clip vs `ds->sprtopclip/sprbottomclip`, reset entry to MAXSHORT after drawing. **R_DrawMasked order:** vissprites back-to-front (each may draw nearer segs' masked ranges), THEN remaining masked ranges of all drawsegs newest→oldest, THEN psprites (M7 — stub).
7. **Sprites:** `R_AddSprites(sec)` = validcount-per-sector + `spritelights = scalelight[clamp((sec.light>>4)+extralight)]` (no pancake rule) + per-thing `R_ProjectSprite` (MINZ 4·FRACUNIT, `xscale = FixedDiv(projection, tz)`, `abs(tx) > tz<<2` reject, `rot = (ang − thingangle + 9·(ANG45/2)) >> 29`, offsets from patch header, flip ⇒ negative `xiscale` + `startfrac = width−1`, `texturemid = (z + spritetopoffset) − viewz`); `MAXVISSPRITES 128` silent return (port: counter); `R_SortVisSprites` ascending scale = back-to-front draw. `R_DrawSprite` clip scan (R03 §8) uses the bsil/tsil arrays M3-06a proved faithful. `R_DrawVisSprite`→`R_DrawMaskedColumn` posts clipped by mfloorclip/mceilingclip.
8. **Static things:** vanilla draws every non-skip thing from its mobj state table; M4 scope = **mobj-less static list**: per thing, first frame letter (A-style), rotation per §7, `gz = floor height of containing subsector` (vanilla sets spawn z the same way via P_TeleportMove at map load), no states/animation. Monsters/player/weapon-psprites excluded (M5/M7/M8); FF_FULLBRIGHT off until A-02/M8 (Freedoom fullbrights read dark — expected, not a bug).

## 1. Exit criteria (milestone-level, objectively checkable)
1. `npm run check` green: visplane Find/Check/Span unit vectors (incl. split-by-copy semantics), R_MapPlane hand-computed flat texels (BigInt FixedMul), rotation/flip table round-trip vs `wad/sprites.ts` census, masked-range + vissprite clipping unit tests, plane add-rule truth table.
2. `renderFrame` = full vanilla order: ClearClipSegs/Drawsegs/Planes/Sprites → BSP (walls + plane marks + R_AddSprites) → `drawPlanes()` → `drawMasked()`; `fb.clear(0)` background REMOVED (sky/black = genuine void); no `R_DrawPlayerSprites` (M7).
3. ≥24 viewpoints (re-blessed 20 + ≥4 new masked/sky/sprite scenes) with sha256+PNG goldens, double-render determinism, `hom == 0`, `visplaneOverflow == visspriteOverflow == 0` on every scene.
4. M3 L5 findings closed: atrium masked columns render real texture (Freedoom GREEN-family fence), tall bands above horizon replaced by ceilings/sky.
5. L4: walls/automap e2e green (updated pixel bands + new sky/masked asserts); L5: ≥24 PNG pairs reviewed vs R03 §7/§8/§11/§12 checklist.

## 2. Task graph and parallel waves

| Wave | Tasks (parallel) | Depends |
|---|---|---|
| 1 | M4-01, M4-02, M4-03 | M3 main (no intra-M4 deps) |
| 2 | M4-04 | M4-01, M4-02 |
| 3 | M4-05, M4-06 | M4-03+M4-04 / M2 fixtures only |
| 4 | M4-07 | M4-01..06 |
| 5 | M4-08 | M4-07 |

Reuses as-is: M3 segs/drawsegs masked recording + silhouettes (M3-06a audit), lights.ts incl. dormant zlight, solidsegs counters, rdata segs/textures, flat.ts/sprites.ts census, viewpoints/goldens-update machinery, mapBuilder.

## 3. Tasks

### M4-01 — Visplane engine (r_plane.c)
- Goal sentence: a marked visplane becomes exactly-once-drawn textured spans with C-exact R_MapPlane math, nearer planes winning per column.
- Owns: `src/render/planes.ts`, `src/render/planes.test.ts`, edits `src/render/view.ts` (add `yslope[200]`/`distscale[320]` per R_ExecuteSetViewSize + `pspriteiscale`), `src/render/bsp.ts` (R_Subsector opens floorplane/ceilingplane per §0.4 + per-frame `validcount++` + `addSectorSprites` callback slot wired in M4-05).
- Must not touch: `src/render/segs.ts` (marks happen there), `src/sim/**`, `docs/**`.
- Consumes: M3-01 zlight, Framebuffer indices, core fixed/tables. Produces: `clearPlanes()` (floorclip=viewheight, ceilingclip=−1, cachedheight memset, basexscale/baseyscale), `findPlane(height,pic,light)` (sky collapse, merge scan, MAXVISPLANES 128 → counter+typed throw), `checkPlane(pl,start,stop)` (copy-split, faithful non-shrink), `drawPlanes()` (creation order; sky branch §0.3; R_MakeSpans + R_MapPlane + `drawSpan` inline row-major spot walk), counters `visplaneOverflow`/`openingOverflow` exported via getRenderCounters.
- Deps: none (M3 stack).
- Acceptance: 1) FindPlane merge/sky-collapse/split-by-copy vectors incl. the non-shrunk source plane; 2) R_MakeSpans emits each row-span once across adjacent columns (analytic 2-plane overlap); 3) R_MapPlane texel goldens vs BigInt oracle (known yslope/distscale, flat ramp); 4) ceiling-marked-atop-floor plane wins (no double draw); 5) overflow injection raises `visplaneOverflow` (liveness, mirrors M3-03 pattern).
- Verify: `npx vitest run src/render/planes.test.ts`

### M4-02 — Flat/sky data wiring (r_data.c R_InitFlats + sky texture)
- Goal sentence: named flats and the SKY1 texture resolve to numeric indices so planes/sky hot paths never touch names.
- Owns: `src/render/rdata.ts` (replace `flatNum = () => -1` placeholder), `src/render/rdata.test.ts`.
- Must not touch: `src/wad/**` (consumes flat.ts/texture.ts), `src/render/segs.ts`, `docs/**`.
- Consumes: `wad/flat.ts` decoded flats, TextureDef table. Produces: `flatNum(name)` (F_START scan, identity `flattranslation[i]=i`, −1+warn on miss), `skyflatnum` (= F_SKY1 index; the 1024-byte F_SKY1 lump is never drawn — tag only), `skyTextureNum` (SKY1 for Freedoom/E1 default; episode SKY2/SKY3 selection deferred to M9 game flow — deviation), `getFlatPixels(num)`, `getSkyColumn(angle1024)` via existing `getWallColumn(skytexture, angle)` (1024 = power-of-2, mask wrap already proven safe).
- Deps: none.
- Acceptance: 1) F_SKY1 present in fixture census ⇒ skyflatnum ≠ −1; 2) `skipIf(!hasWad)`: freedoom1 F_START count + F_SKY1 hash, SKY1 texture width 1024 + column 0 sha256; 3) getSkyColumn(angle) wrap for ±out-of-range angles; 4) unknown flat name → −1 + warn list (empty expected on E1M1).
- Verify: `npx vitest run src/render/rdata.test.ts`

### M4-03 — Static thing/sprite tables (r_things.c R_InitSprites + thing table subset)
- Goal sentence: sprite lump rotation/flip tables and a per-map static thing list exist before the first frame, with zero per-frame allocation.
- Owns: `src/render/rthings.ts`, `src/render/rthings.test.ts`.
- Must not touch: `src/wad/sprites.ts` (consumes census), `src/sim/**`, `docs/**`.
- Consumes: `wad/sprites.ts` SpriteDef census (M1-07), patch decode, MapData things/subsectors/sectors. Produces: `installSprites(census)` → per-sprite `{frames: {rotate, lump[8], flip[8]}}` (rot-0 fills all 8; digits 1-8 zero-based; XY mirror ⇒ flip bit — same table as `R_InstallSpriteLump`, built from census not lump scan); `buildStaticThings(map, installed)` → SoA {x, y, angle, spriteNum, frame=firstLetter, floorZ=subsector floor} + per-sector linked list for R_AddSprites; `THING_SPRITE` subset table of info.c `namesprites`: exclude markers (1-4, 11, 14, 87, 2001-2005) and **all monster types (M8)**; items/decorations = first frame, static (deviation: no state animation — pickups spin from M7).
- Deps: none.
- Acceptance: 1) rotation table round-trip: `PLAYA2A8`-style pair ⇒ lump/flip correct, rot=0 frame fills; 2) 8-rot selection `rot = (ang − thingang + 9·(ANG45/2)) >> 29` vs hand-computed octants incl. wrap; 3) E1M1 skipIf: thing list counts (zero monsters, markers skipped), floorZ = containing sector floor for 1000 sampled things via bsp point location; 4) zero allocation in per-frame lookup paths.
- Verify: `npx vitest run src/render/rthings.test.ts`

### M4-04 — Plane marking + masked middle drawing (r_segs.c completion)
- Goal sentence: segs mark their plane spans and masked fences finally draw pixels, clipped by the drawseg snapshots M3 recorded.
- Owns: `src/render/segs.ts` (plane calls), `src/render/masked.ts` (R_RenderMaskedSegRange + shared R_DrawMaskedColumn), `src/render/drawsegs.ts` (drawMasked/drawMaskedSegRange stubs → real; reverse-drawseg sweep), `src/render/masked.test.ts`.
- Must not touch: `src/sim/**`, `src/render/planes.ts` (consumes findPlane/checkPlane), `docs/**`.
- Consumes: M4-01 (checkPlane), M4-02 (getFlat/getSkyColumn), M3 segs recording. Produces: storeWallRange additions — markfloor/markceiling per §0.4 incl. sky guard, `worldtop=worldhigh` hack, `checkPlane` before R_RenderSegLoop; segLoop `ceilingplane->top/bottom[rw_x]` marks; `renderMaskedSegRange(ds,x1,x2)` faithful (−3 quirk, MAXSHORT reset, spryscale stepping); `drawMasked()` = per-drawseg sweep (vissprite half completes in M4-05; here: full reverse sweep, mfloorclip/mceilingclip from ds refs, CLIP_SCREEN/CLIP_NEGONE refs honored).
- Deps: M4-01, M4-02.
- Acceptance: 1) fixture floor/ceiling marks: top/bottom ranges match hand-computed `centery − h·scale` clipped by clips; 2) sky guard: ceiling below viewz still marked when pic==skyflatnum; 3) masked: drawn columns equal recorded maskedtexturecol snapshot (a nearer occluder removes exactly its span), entries reset to MAXSHORT; 4) `drawMasked` idempotence: second call draws nothing (all MAXSHORT); 5) openings-pool overflow → `openingOverflow` + throw (vanilla corrupts; deviation pinned).
- Verify: `npx vitest run src/render/masked.test.ts src/render/segs.test.ts`

### M4-05 — Static sprite pass (r_things.c R_AddSprites/R_DrawSprite)
- Goal sentence: static things appear as correctly rotated, wall-clipped sprites at the right height and light, drawn back-to-front.
- Owns: `src/render/vissprites.ts`, `src/render/vissprites.test.ts`, edits `src/render/bsp.ts` (wire `addSectorSprites` → validcount-guarded R_AddSprites) and `src/render/masked.ts` (drawMasked: sort + back-to-front vissprite pass + per-sprite nearer-seg masked ranges via `pointOnSegSide`).
- Must not touch: `src/sim/**`, `src/wad/**`, `docs/**`.
- Consumes: M4-03 tables, M4-04 masked.ts, M3 silhouettes/drawsegs, lights spritelights. Produces: `projectSprite(thing)` (MINZ/scale/off/rot/flip/texturemid per §0.7, `gz`=floorZ, `gzt`=z+spritetopoffset, MAXVISSPRITES 128 → `visspriteOverflow` counter), `sortVisSprites()` (ascending scale), `drawSprite` (clipbot/cliptop −2 scan, silhouette &= gz/gzt tests, masked-range draw for nearer segs, `drawVisSprite` post stream via masked.ts drawMaskedColumn, `colormap = fixedcolormap ?? colormaps (fullbright, off) ?? spritelights[xscale>>LIGHTSCALESHIFT]`), `clearSprites()`; fuzz/`MF_SHADOW`: not needed for static roster (documented).
- Deps: M4-03, M4-04.
- Acceptance: 1) projection known vectors (spawn-relative fixture thing: xscale, screen x1/x2, texturemid); 2) rotation/flip: 8 positions around a BARREL1-style fixture pick the right lump + mirror startfrac/xiscale sign; 3) clipping: thing behind one-sided wall invisible; behind pass-seg window clipped by sprtop/bottomclip snapshots (fixture both-silhouette case); 4) z-order: two overlapping things, nearer drawn later (sort assert); 5) overflow injection fires visspriteOverflow.
- Verify: `npx vitest run src/render/vissprites.test.ts`

### M4-06 — Fixture extension: sky, flats, fences, things, panning
- Goal sentence: the fixture maps can actually express sky sectors, flat-visible rooms, masked fences and sprite things — closing the M3 "fixture thinness/panned sidedef" gap for real goldens.
- Owns: `tests/fixtures/mapBuilder.ts` extensions (per-side flats + `skyCeil` flag ⇒ F_SKY1, mid-masked texture support, **sidedef textureoffset/rowoffset options** — closes M3 gap note, `things` entries on RectMapSpec), `tests/fixtures/mapBuilder.test.ts`.
- Must not touch: `src/**`, `docs/**`.
- Deps: none (M2 tooling only; ships before M4-08 needs it).
- Acceptance: 1) round-trip: sky sector parses with ceilingpic == skyflatnum name, offsets land in SIDEDEFS; 2) fixture WAD carries the synth flats/sprite lumps (reuse graphics.ts) so masked/sprite goldens run IWAD-free; 3) BSP property test still green with things present; 4) no public-API breaks for existing WALLFIX consumers (new fields optional; existing FIXMAP goldens unchanged pre-rebless).
- Verify: `npx vitest run tests/fixtures/mapBuilder.test.ts`

### M4-07 — Full-frame pipeline integration + live surface
- Goal sentence: one `renderFrame` now runs the exact vanilla order — planes replace the black clear, sprites and masked middles draw — and counters are live in `state()`.
- Owns: `src/render/renderer.ts` (drop `fb.clear(0)`; add clearPlanes/clearSprites around BSP, drawPlanes, drawMasked; automap overlay pass unchanged), `src/debug.ts` + `src/types/debug.ts` (`state().render.{hom,visplaneOverflow,visspriteOverflow,openingOverflow,drawsegOverflow}`), `src/main.ts` (no structural change expected), `e2e/walls.spec.ts` (new asserts).
- Must not touch: other `src/render/**` internals (imports only), `docs/**`, goldens (M4-08 owns).
- Acceptance: 1) fixture + E1M1 (skipIf) frames: non-black band above horizon at an outdoor fixture/E1M1 viewpoint, masked fence columns now textured; 2) automap-over-3D Tab round-trip still byte-identical; 3) double-render determinism; 4) all overflow counters 0 everywhere, injection unit tests stay green; 5) zero console errors; M2 automap/viewer specs untouched.
- Verify: `npm run e2e -- e2e/walls.spec.ts e2e/automap.spec.ts`, `npm run check`

### M4-08 — Golden re-bless + new viewpoints + L5 evidence
- Goal sentence: the milestone's evidence: ≥24 blessed full-scene frames (the 20 M3 walls scenes re-blessed ONCE as the M4 planes baseline, plus ≥4 new masked/sky/sprite scenes) with determinism, overflow==0 gates, and a filed L5 review closing M3 findings.
- Owns: `tests/render/viewpoints.ts` (extend table), `tests/render/walls.test.ts` (planes+sprites path), `tests/render/goldens/walls/*` (re-blessed meta+PNGs), `scripts/goldens-update.mjs` (scene-table consumption only; `--set walls` name retained for the full-scene set — deviation recorded), `e2e/walls.spec.ts` (final iwad asserts).
- Must not touch: `src/**` (findings → fix tasks), mapBuilder public API (M4-06 already extended it).
- New scenes (≥4): FIX masked fence (two rooms, GREEN-family masked mid, IWAD variant on E1M1 atrium line), FIX sky room (F_SKY1 ceiling + low light — sky fullbright assert), FIX sprite pair (rot octant + overlap z-order), E1M1 outdoors/sky viewpoint + E1M1 sprite-lined room; totals ≥12 FIXMAP + ≥12 E1M1-capable ⇒ ≥24.
- Acceptance: 1) one re-bless with reason "M4 planes baseline", then `--check` green with zero drift; 2) double-render byte-identical everywhere; 3) hom/visplane/vissprite/opening/drawseg overflow all 0 on every scene; 4) L5 review reads all PNGs vs R03 §7/§11/§12 checklist + **explicit verdicts on the two M3 findings** (atrium checker resolved; horizon bands now ceiled/skyed); findings → docs/TASKS.md fix tasks.
- Verify: `npm run goldens:update -- --set walls --check`, `npm run check && npm run e2e`

## 4. Deviations, decisions, gaps found in this planning pass
- Monsters invisible until M8 (static list excludes them; vanilla would show standing A-frames) — recorded so L5 reviewers don't flag E1M1 emptiness; DEHACKED fullbright stays A-02/M8 (fullbright sprites read dark in M4 goldens).
- Thing z = subsector floor at map load (no floor-motion tracking until M6 lifts; vanilla spawn z is identical for static things).
- Visplane/openings overflow: vanilla `I_Error`/silent corruption → counter + typed throw in TS (test-visible, never silent).
- `R_AddSprites` per-sector `validcount` replaces thinglist iteration (1.10 iterates `sec->thinglist` of spawned mobjs; our mobj-less list is prebuilt per sector — same draw set, order corrected by R_SortVisSprites anyway).
- Sky texture name fixed to SKY1 (episode selection is M9); psprite branch of R_DrawMasked stubbed (M7); fuzz path unused (no MF_SHADOW statics).
- Golden set keeps the `walls` name for the now-full-scene set; meta.json marks the re-bless reason as baseline.

## 5. Exit verification (run on integrated main)
1. `npm run check` — planes/masked/vissprites/rthings/fixture suites + all M1-M3 suites green (M3 wall unit expectations updated only where plane marking legitimately changed seg behavior: document each).
2. `npm run goldens:update -- --set walls --check` — ≥24 scenes, zero drift, one-time re-bless recorded with reason.
3. `npm run e2e` — walls (updated bands + sky/masked asserts), automap (updated), viewer unchanged; zero console errors.
4. Overflow evidence: every golden scene + e2e assert all five counters 0; the three injection liveness tests (solidsegs/visplane/vissprite) green.
5. L5: verifier reads test-results PNGs vs golden pairs; checklist — flats lit by zlight falloff not wall light, horizon straight at 90/270, sky fullbright & INVUL-immune path, seam-free masked fences, 8-rotation walk-around on fixture sprite ring, no sprite bleed through solid walls; verdicts on both M3 findings; findings filed in docs/TASKS.md.

## 6. Risks
- Visplane/Openings pressure at E1M1 crowded viewpoints (MAXVISPLANES 128, MAXOPENINGS 20480 consumed by BOTH maskedtexturecol and per-drawseg clip snapshots): if a scene trips either, re-pick viewpoint or fix recording — do NOT raise caps; counters make triage unambiguous.
- Sky horizon seam (skytexturemid/`dc_iscale=pspriteiscale` 1:1 tie): off-by-one rows show as a 1-px gap/overlap band at the horizon; mitigated by a dedicated sky fixture viewpoint with sky meeting a pegged wall top.
- Sprite draw order in shared subsectors (validcount adds a sector once — sprite missing/early if wiring placed wrong in R_Subsector vs post-seg): pinned by the M4-05 z-order test + bsp callback placed after nothing (vanilla places R_AddSprites BEFORE the seg loop — match it).
- `R_CheckPlane` split-by-copy semantics differ from later Doom versions — copying M2/M3-era references or StackOverflow folklore (polyseg-era code) into review would mis-debug seams; the §0.1 pinned facts are the arbiter.
- Performance: full 320×200 spans + sprite posts headless; R_MapPlane caching is per-y (keep it); budget the golden render at < ~2 s/scene in Node, profiled via one timing assert (not a fidelity gate).
- Fixture sky rooms risk "all-black void looks identical to sky bug" — the skyroom scene asserts a known SKY1 column sha in the top band, not just non-black.
