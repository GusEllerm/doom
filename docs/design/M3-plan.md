# M3 Plan — Wall renderer

Status: planned. Parent: docs/ROADMAP.md M3. Inputs: ARCHITECTURE.md §4 (all) / §6 L3 / §7, R03 (primary; r_bsp.c/r_segs.c/r_main.c/r_draw.c/r_data.c), R02 §4 (light tables), R01 §8-10.
Exit (from ROADMAP): BSP walls w/ upper/lower/middle textures, light buckets + distance diminishing, solidsegs occlusion; ≥20 sampled viewpoints on fixture+E1M1 with L3 goldens; `state().render.hom == 0` on all; L5 review.

## 0. Exit criteria (milestone-level, objectively checkable)
1. `npm run check` green: light tables (zlight/scalelight) vs BigInt recompute vectors, solidsegs insert/merge unit tests incl. live overflow injection, seg-loading round-trips (L1).
2. `renderFrame(map, view)` produces a walls-only 320×200 indexed frame in Node (no DOM): R_RenderBSPNode → R_AddLine clipsolid/clippass → R_StoreWallRange → R_RenderSegLoop drawing toptex/bottex/midtex through `R_DrawColumn`, per-column `scalelight` bucket + pancake adjust; ceilingclip/floorclip maintained faithfully for M4.
3. ≥20 viewpoints (12 FIXMAP WALLFIX grid + 8 E1M1 skipIf) with sha256 + PNG goldens under `tests/render/goldens/walls/`, regenerated only via `npm run goldens:update -- --set walls --reason`; rendering the same view twice yields byte-identical buffers (L3 determinism).
4. `state().render.hom == 0` on every golden viewpoint and in e2e; an overflow-injection unit test proves the counter is live (not constant zero).
5. L4: walls e2e green (real keys + `__doom` setup; canvas non-blank/not-single-color/changes-on-warp; zero console errors). L5: ≥20 PNG pairs reviewed against R03 §5/§6/§10/§15 checklist; findings filed as tasks.

## 1. Task graph and parallel waves

| Wave | Tasks (parallel) | Depends |
|---|---|---|
| 1 | M3-01, M3-02, M3-03 | M2 main (no M3 deps) |
| 2 | M3-04, M3-05 | M3-01+02+03 / M3-01+02 |
| 3 | M3-06 | M3-02, M3-03, M3-04, M3-05 |
| 4 | M3-07 | M3-06 |
| 5 | M3-08 | M3-07 |

Reuses as-is: Framebuffer (M2-09), fixture mapBuilder/bspSplit, goldens-update.mjs machinery, harness boot path from `tests/render/automap.test.ts`, `core/fixed|tables`.

## 2. Tasks

### M3-01 — Light tables (r_main.c R_InitLightTables / R_ExecuteSetViewSize)
- Goal sentence: every wall pixel's shade is a LUT hit into tables bit-identical to r_main.c before any rendering starts.
- Owns: `src/render/lights.ts`, `src/render/lights.test.ts`.
- Must not touch: `src/core/**`, `src/wad/**`, `src/sim/**`, `docs/**`.
- Consumes: COLORMAP rows (34×256, `wad/palettes`) passed in as a plain `Uint8Array`. Produces: `initLightTables(colormapRows)` → `{ colormaps (32×256), zlight 16×128, scalelight 16×48, scalelightfixed }` (row-offset tables as Uint32Array into `colormaps`), `wallLightNum(sectorLight, extralight, v1x,v1y,v2x,v2y)` (LIGHTSEGSHIFT bucket + pancake ±1, R03 §10), constants LIGHTLEVELS 16/LIGHTSEGSHIFT 4/MAXLIGHTSCALE 48/LIGHTSCALESHIFT 12/MAXLIGHTZ 128/LIGHTZSHIFT 20/NUMCOLORMAPS 32/DISTMAP 2. Exact C integer-division chains (`startmap=((15-i)*2)*32/16`, `level = startmap - j*320/viewwidth/2`), no float shortcuts.
- Deps: none (main).
- Acceptance: 1) zlight + scalelight sha256 goldens vs BigInt-recomputed expected in-test; 2) all `level` values clamped [0,31]; 3) `scalelight[15][j]` row 0 identity; 4) pancake: horizontal −1 / vertical +1 / diagonal 0 before clamp; 5) note pinned in test header: walls consume scalelight (R03 §10), zlight is built+golden-tested here and consumed by M4 flats.
- Verify: `npx vitest run src/render/lights.test.ts`

### M3-02 — Render world load (r_data.c R_LoadSegs + texture/column setup)
- Goal sentence: the renderer owns numeric seg/side/texture tables so no hot loop touches strings or sim objects.
- Owns: `src/render/rdata.ts`, `src/render/rdata.test.ts`.
- Must not touch: `src/sim/**` (renderer consumes structural read-view interfaces, M2-09 pattern; enforcement point stays `src/main.ts`), `src/wad/**`, `docs/**`.
- Consumes: `MapData` (`wad/mapdata`), composed `TextureDef.columns`/`DecodedPatch.columns` (`wad/texture`). Produces: `loadRenderWorld(md, textures)` → seg SoA (v1x,v1y,v2x,v2y fixed; angle BAM u32-as-number; line/side indices; offset fixed), side→numeric toptex/midtex/bottex (−1 sentinel) + `masked` flag (transparent-column scan, R02 §7/§4.3), `texWidth/texWidthMask/texHeight`, `getWallColumn(tex, col)` with `col &= widthmask` wrap (composited = patch-column stitch), `flatNum = () => -1` placeholder (M4).
- Deps: none (main).
- Acceptance: 1) FIXMAP round-trip: counts match MapData, all names resolve or −1; 2) masked flag correct on synthetic solid vs fence textures; 3) `getWallColumn` fuzz loop (10k cols incl. negatives) never OOB; 4) sha256 of composed FIXWALL0 column 0; 5) `skipIf(!hasWad)`: E1M1 segs all load, missing-texture warnings = committed list (empty expected).
- Verify: `npx vitest run src/render/rdata.test.ts`

### M3-03 — solidsegs + HOM counters (r_bsp.c clip-seg ops)
- Goal sentence: the occlusion ledger inserts/merges spans exactly like R_ClipSolidWallSegment, and any dropped/duplicated coverage raises a live `hom` counter instead of silently mirroring.
- Owns: `src/render/solidsegs.ts`, `src/render/solidsegs.test.ts`.
- Must not touch: anything else.
- Consumes: `core/constants`. Produces: `clearClipSegs` (sentinels (MININT,-1),(viewwidth,MAXINT)), `clipSolidWallSegment(first,last): fragments`, `clipPassWallSegment`, MAXSEGS 32, Int32Array-backed {first,last} pairs + drawseg ref slot (§4.2); `renderCounters = { hom, drawsegOverflow, solidsegDrops }` + `getRenderCounters()/resetRenderCounters()` — `hom++` on solidsegs insert overflow or `start > stop` store ranges; `drawsegOverflow++` counted separately (MAXDRAWSEGS silent return, r_segs.c) so `hom` means occlusion-loss specifically.
- Deps: none (main).
- Acceptance: 1) scripted span sequences reproduce vanilla merge results incl. the `start->last < first-1` walk and adjacent-range merge ("touching pixels"); 2) overflow injection: 33 disjoint spans ⇒ `hom > 0` (counter liveness regression); 3) pass-segs report fragments without inserting; 4) fully-covered insert is a no-op (R_CheckBBox fast path relies on it).
- Verify: `npx vitest run src/render/solidsegs.test.ts`

### M3-04 — BSP walk + view setup (r_main.c setup + r_bsp.c)
- Goal sentence: the front-to-back node walk with faithful bbox/clip-angle rejection decides exactly which segs reach the wall tier.
- Owns: `src/render/view.ts`, `src/render/bsp.ts`, `src/render/bsp.test.ts`.
- Must not touch: `src/sim/**` (own `pointOnSide` sign test ported from r_bsp.c — gap G11), `docs/**`.
- Consumes: `RenderMapView` structural read-view (RuntimeMap subset: nodes/subsectors/vertices/lines/sides/sectors SoA, defined here), `loadRenderWorld` (M3-02), `fixed/tables`. Produces: `setupView(player)` — viewx/viewy = mo.x/mo.y, viewangle, viewcos/viewsin, `viewz = mo.z + VIEWHEIGHT(41·FRACUNIT)` placeholder (**documented deviation: P_CalcHeight/bob is M5**; no tilt in M3), extralight/fixedcolormap read-through; `initTextureMapping` once (focallength, viewangletox[4096], xtoviewangle[321], clipangle; projection=160<<16, centery=100); `renderBspNode(root)`: R_PointOnSide, R_CheckBBox with checkcoord[12][4] + solidsegs fully-covered early-out, R_AddLine verbatim clip math (`span >= ANG180` u32 backface cull; tspan clamps; `x1==x2` drop), classification clipsolid/clippass/noDraw (closed-door + height-diff + identical-flats rules, R03 §4); R_Subsector = seg loop only (no planes, no R_AddSprites — M4).
- Deps: M3-01 (clipangle inputs use tables), M3-02, M3-03.
- Acceptance: 1) reference-comparison test: on 1000 seeded fixture viewpoints the real walk visits a superset-equal of a no-early-out reference (bbox reject never drops a visible seg); 2) clip-classification truth table (solid/closed-door/window/noDraw/masked-solid-path); 3) E1M1 skipIf: spawn render completes, subsector visit order strictly front-first per tree proof; 4) zero allocation in walk steady state.
- Verify: `npx vitest run src/render/bsp.test.ts`

### M3-05 — Wall column blit (r_draw.c R_DrawColumn + dc_* globals)
- Goal sentence: one column of wall texture lands in the index buffer with the C-exact `frac` walk and zero per-pixel math beyond a colormap hit.
- Owns: `src/render/cols.ts`, `src/render/cols.test.ts`.
- Must not touch: `src/render/framebuffer.ts` (M2-09-owned; use `indices` directly), `docs/**`.
- Consumes: Framebuffer indices, `colormaps` rows (M3-01), `getWallColumn` (M3-02). Produces: `Dc` global struct (x/yl/yh/iscale/texturemid/source/colormap), `drawColumn()`: `dc_iscale = Math.floor(0xffffffff / (rw_scale >>> 0)) >>> 0` (gap G12 — unsigned div policy: both operands < 2^32 ⇒ double-exact, verified), `frac = (dc_texturemid + (dc_yl-centery)*dc_iscale)|0`, loop `indices[y*320+x] = colormap[source[(frac>>16)&127]]`, `frac += iscale`.
- Deps: M3-01, M3-02.
- Acceptance: 1) hand-computed 40-px column golden (fixture texture, fixed scale/mid); 2) negative-`frac` wrap == `&127` C behavior; 3) iscale known vectors vs `floor(0xffffffff/scale)` (incl. scale=256, 64·FRACUNIT clamps); 4) no allocation per call.
- Verify: `npx vitest run src/render/cols.test.ts`

### M3-06 — R_StoreWallRange + R_RenderSegLoop + drawsegs (r_segs.c)
- Goal sentence: a visible seg becomes one drawseg with exact scale math, pegged texture mids, and per-column upper/lower/middle draws that tighten ceilingclip/floorclip like vanilla.
- Owns: `src/render/segs.ts`, `src/render/drawsegs.ts`, `src/render/segs.test.ts`, `src/render/drawsegs.test.ts`.
- Must not touch: `src/render/solidsegs.ts` (consumes), `src/sim/**`, `docs/**`.
- Consumes: M3-03 (solidsegs + counters), M3-04 (view/clip angles), M3-05 (drawColumn), M3-02. Produces: drawsegs SoA (§4.2: x1/x2, scale1/2/step, seg, silhouette SIL_*, bsil/tsil heights, sprtop/sprbottomclip refs, maskedtexturecol) with MAXDRAWSEGS 256 silent-return + counter; `storeWallRange(start,stop)` faithful: rw_distance via hyp·finesine(distangle), scale1/2 via R_ScaleFromGlobalAngle clamped [256, 64·FRACUNIT], rw_offset tangent sign rule, rw_centerangle, texturemid rules incl. ML_DONTPEGTOP/BOTTOM + rowoffset, lightnum from M3-01; `renderSegLoop()`: HEIGHTBITS-12 top/bottom/high/low frac+step stepping, toptex/bottex clip-vs-floorclip/ceilingclamping, one-sided midtex full-column + `ceilingclip=viewheight; floorclip=-1`, two-sided upper/lower only where open; masked midtex: record `maskedtexturecol[x] = texturecolumn` (MAXSHORT init), NO draw — `drawMasked()` no-op stub, M4 consumes the snapshot (maskedtexturecol + sprtop/bottomclip memcpy); `drawMaskedSegRange` stub noted. No ML_MAPPED writes (sim-mutation ban, G13).
- Deps: M3-02, M3-03, M3-04, M3-05.
- Acceptance: 1) analytic fixture (known line/scale): screen spans match hand-computed `centery − h·scale` for floor/ceil heights; 2) texture-column sampling matches the rw_offset+tangent formula on a panned sidedef; 3) pegged vs unpegged bottom texture rows differ as in r_segs.c; 4) one-sided seg fully occludes (subsequent pass seg draws nothing under it); 5) drawseg overflow counter fires at 257, no crash; 6) masked recording leaves `maskedtexturecol[x] != MAXSHORT` and pixels untouched.
- Verify: `npx vitest run src/render/segs.test.ts src/render/drawsegs.test.ts`

### M3-07 — Frame pipeline + boot switch + viewpoint debug API
- Goal sentence: the game page draws the 3D view at 35 Hz, and tests can pin an arbitrary viewpoint and capture the real rendered buffer through `__doom`.
- Owns: `src/render/renderer.ts` (`renderFrame(world, map, player, automapState?)`: setupView → clearClipSegs/clearDrawsegs/counters → `fb.clear(0)` → BSP pass → `drawMasked()` stub → optional automap overlay pass when map active (§4.1.9); NO R_ClearPlanes/visplanes — deviation D below), `src/main.ts` (drop the automap-by-default boot; rAF: renderFrame after tics; automap stays via state), `src/debug.ts` (`capture()` → real framebuffer copy; `state().render.hom` from `getRenderCounters()`), `src/types/debug.ts` (hom real value; capture doc line), `src/sim` untouched — viewpoint pin uses existing `warp` (x,y,z?,angleDeg) which the renderer reads per frame, `e2e/walls.spec.ts` (skeleton: load, warp, capture non-zero).
- Must not touch: other `src/render/**` internals beyond importing them, `tests/fixtures/**`, `docs/**`.
- Consumes: M3-04/05/06 exports, Framebuffer, automap drawer. Produces: the exact entry `renderFrame(...)` + `getRenderCounters` re-export the golden suite and e2e use.
- Deps: M3-06.
- Acceptance: 1) `capture()` after `warp` = non-blank, non-single-color, deterministic across two calls; 2) `state().render.hom` tracks counters (live, not the old −1 stub); 3) main page: walls visible, Tab still opens automap (now over the 3D pass) and closes to byte-identical walls frame; 4) M2 automap goldens still green (pipeline calls drawAutomap directly — assert, do not re-bless); 5) zero console errors.
- Verify: `npm run e2e -- e2e/walls.spec.ts`, `npm run check`

### M3-08 — Viewpoint golden suite (≥20) + HOM regression + L5 evidence
- Goal sentence: the milestone's evidence: ≥20 committed 3D frames (fixture + E1M1) with byte goldens, PNGs, and `hom == 0` on every one.
- Owns: `tests/render/viewpoints.ts` (shared scene table), `tests/render/walls.test.ts`, `tests/render/goldens/walls/*` (meta.json + PNGs), `scripts/goldens-update.mjs` (additive `--set walls|automap`, default automap — reuses dump/PNG/reason machinery), `e2e/walls.spec.ts` (completed). Must not touch: `src/**` (findings → fix tasks), `tests/fixtures/mapBuilder.ts` public API (extend WALLFIX spec *data*, not the builder; if a builder change is unavoidable, split a task).
- Consumes: `renderFrame`, harness boot path (automap.test.ts pattern), mapBuilder `buildFixtureMapWad`, goldens script. Scene set — 12 FIXMAP: a `WALLFIX` RectMapSpec (rooms at light 0/96/192/255, floor-change divider, DOORFIX0 gap, vertical+horizontal walls for the pancake rule, panned sidedef) sampled on a 4×3 position/angle grid; 8 E1M1 (skipIf): spawn, two room corners, the atrium, a both-open corridor, a doorway frame, a long vista (z/scale stress), a many-span corner stressing solidsegs — each a committed `{x,y,z?,angleDeg}` triple; 20 total, both maps ≥8. Per scene: boot → warp → 0 tics → renderFrame ×2 (identical sha required) → sha256(indices) + hom==0 assert; dump for PNG blessing.
- Deps: M3-07.
- Acceptance: 1) meta.json ≥20 scenes, each with script + reason history; 2) `npm run goldens:update -- --set walls --check` green; regen requires `--reason`; 3) same view twice ⇒ identical bytes (determinism, L3); 4) hom==0 on all scenes (and M3-03's overflow-injection test stays green as the counter-liveness regression); 5) PNGs reviewed (L5 checklist: texture alignment/panning, pegging, dark-room buckets, far-wall dimming, no span slivers) under test-results; 6) `npm run check && npm run e2e` green on integrated main.
- Verify: `npm run goldens:update -- --set walls --check`, `npm run e2e -- e2e/walls.spec.ts`, `npm run check`

## 3. Deviations, decisions, gaps found in this planning pass
- Walls-only background: `fb.clear(0)` (BLACK, mirrors AM_clearFB BACKGROUND) replaces R_ClearPlanes/visplanes — floor/ceiling gaps show black instead of flats; this is *expected background*, not HOM (hom counts solidsegs/store failures only); M4's visplanes replace it. R_ClearPlanes/sky/planes not ported here.
- zlight wording correction: 1.10 walls use `scalelight[lightnum][rw_scale>>LIGHTSCALESHIFT]` (R03 §10); ROADMAP's "zlight diminishing" = distance dimming generally. Both families land + golden-test in M3-01; zlight consumption starts M4 (flats).
- viewz placeholder: `viewz = mo.z + 41·FRACUNIT` (VIEWHEIGHT exists in `sim/player.ts`); P_CalcHeight/bob arrive with M5 physics.
- Masked middles: recording (maskedtexturecol + drawseg clip snapshots) is faithful in M3-06 but `drawMasked()`/`drawMaskedSegRange` are named no-op stubs — M4 draws without pipeline changes.
- G11: renderer re-implements the r_bsp.c sign-test `pointOnSide` (sim/bsp.ts serves collision; faithful r_data/r_bsp placement), duplication noted for the M12 audit.
- G12: `0xffffffffu / scale` policy fixed: `Math.floor(0xffffffff/(scale>>>0))>>>0` — double division exact for <2^32 operands; pinned in cols tests.
- G13: renderer never sets `ML_MAPPED` (r_segs.c side effect) — sim immutability wins; automap already tracks its own mapped state. Record in DECISIONS.

## 4. Exit verification (run on integrated main)
1. `npm run check` — L1: lights/rdata/solidsegs/view/bsp/cols/segs suites green, incl. BigInt light-table vectors and the live-hom overflow injection.
2. `npm run goldens:update -- --set walls --check` — L3: ≥20 viewpoint sha256 + PNG-provenance (tEXt sha) green, zero drift; determinism double-render asserts green.
3. `npm run e2e` (incl. `e2e/walls.spec.ts`) — L4 green, zero console errors, M2 automap/viewer specs unchanged.
4. HOM evidence: every golden scene + e2e assert `state().render.hom === 0`; overflow-injection unit proves the counter is wired from solidsegs logic.
5. L5 review: verifier reads `test-results/goldens/walls/*.png` vs golden pairs against R03 §5/§6/§10/§15; findings filed as tasks in docs/TASKS.md.

## 5. Risks
- Column/post sampling alignment: `texturecolumnofs` stitching vs single-patch 128-tall assumption and the unsigned `dc_iscale` off-by-one ⇒ texture slide/wobble; mitigated by hand-computed column goldens (M3-05) + M3-02 wrap fuzz.
- Black floor/ceiling gaps (planes are M4) can mask real solidsegs bugs in visual review — mitigated by the counter-liveness test and fixture-first review order (review fixture PNGs against expected black regions explicitly listed in viewpoints.ts).
- Light-table index bounds: `j*320/viewwidth/2` integer-truncation chain and MAXLIGHTSCALE 48 / MAXLIGHTZ 128 clamps must match C; pinned via M3-01 BigInt vectors — a mismatch here silently dims/brightens whole frames, caught only by the goldens.
- E1M1 crowded viewpoints may hit MAXDRAWSEGS 256 / MAXSEGS 32: if a chosen scene trips them, re-pick the viewpoint or fix merge logic — do NOT raise caps; drawsegOverflow is reported separately from hom so triage is unambiguous.
- Fixture thinness: WALLFIX must actually exercise pegged/panned/masked/side-different textures; if mapBuilder can't express a case, record a gap for M4 rather than hand-patching lumps inside the golden test.
