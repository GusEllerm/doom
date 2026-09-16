# M2 Plan — Map loading, automap, noclip movement

Status: planned. Parent: docs/ROADMAP.md M2. Inputs: ARCHITECTURE.md §2.2/§3/§6.1/§7, R01 §3-15, R03 §3, R04, R09 §5, A-04/A-01.
Exit (from ROADMAP): the first map's automap draws correctly and the player arrow moves in noclip — via keyboard AND scripted `__doom` stepping; golden automap frames committed.

## 0. Exit criteria (milestone-level, objectively checkable)
1. `npm run check` green incl. differential fixed-point oracle tests (A-FX1) and a passing BSP property test over generated fixture maps (A-04).
2. `__doom.loadMap('E1M1'|fixture)` parses a real map: lump counts/struct totals match R01 §13/§14 expectations on freedoom1.wad (skipIf-gated).
3. In the browser at spawn: TAB shows the automap; arrow keys/WASD move and rotate a white player arrow over correctly-classified colored lines in noclip fly mode, driven by real keyboard events (layer 4) and by scripted `step(tics)` (layer 2).
4. Golden indexed-framebuffer hashes for automap frames (fixture map always; freedoom1 E1M1 spawn skipIf) + PNG companions, regenerated only via the update script.
5. Screenshot review: an agent confirms line classes/colors against R09 §5 and files findings.

## 1. Task graph and parallel waves

| Wave | Tasks (parallel) | Depends |
|---|---|---|
| 0 | A-FX1 (cross-cutting) | M1 contract |
| 1 | M2-01, M2-03 | A-FX1 / M1-02+M1-05 |
| 2 | M2-02, M2-04 | M2-01+M1-05 / M2-03 |
| 3 | M2-05, M2-06 | M2-04+A-FX1 / M2-04 |
| 4 | M2-07, M2-08 | M2-06 |
| 5 | M2-09 | M2-05, M2-08 |
| 6 | M2-10 | M2-09, M2-02 |

M1→M2 reuses: `WadFile` (M1-02), fixture `buildWad` (M1-05), palette decode (M1-03), contract types (M1-01).

## 2. Tasks

### A-FX1 — core/fixed.ts + tables + differential fixed-point oracle (A-01, cross-cutting)
- Goal sentence: 16.16 arithmetic is bit-exact against a BigInt oracle and known vectors, before any sim math is written on top.
- Owns: `src/core/fixed.ts`, `src/core/tables.ts`, `src/core/constants.ts` (FRACUNIT, ANG45…, ANG_MAX, MAPBLOCKSIZE/UNITS, TICRATE), `src/core/fixed.test.ts`, `src/core/tables.test.ts`.
- Must not touch: `src/sim/**`, `src/wad/**`, `docs/**`.
- Consumes: M1-01 contract only. Produces: §2.5 exact set — `FixedMul` (16-bit limb split), `FixedDiv` (saturating guard + `Math.trunc((a/b)*65536)|0`), `FixedAdd/FixedSub`, angle ops (`>>>0` wrap, `ang>>>19`), `finesine: Int32Array(8192)` generated from the verified formula, finecosine alias +2048, `tantoangle`, `SlopeDiv`, `R_PointToAngle`-grade octant math helpers as pure functions.
- Deps: M1-01.
- Acceptance: 1) differential test vs BigInt oracle: ≥100k seeded random (a,b) FixedMul vectors incl. MININT×−1, ±0, max-magnitude corners — zero mismatches; 2) FixedDiv saturates to ±2147483647 per the §2.5 guard on the vector table; 3) known vectors: finesine[0]=25, finesine[1]=85, finesine[512]=65536 (R03 §1); 4) `npm run check` perf note: the whole oracle test < 5 s; 5) no BigInt outside test files.
- Verify: `npx vitest run src/core/fixed.test.ts src/core/tables.test.ts`

### M2-01 — Grid BSP splitter for fixture maps (A-04 chain pt.1)
- Goal sentence: a ~150-line recursive horizontal/vertical splitter turns an axis-aligned rectangle partition into valid SEGS/SSECTORS/NODES byte arrays.
- Owns: `tests/fixtures/grid-nodes.ts`, `tests/fixtures/grid-nodes.test.ts`.
- Must not touch: `src/**` (test tooling only), `docs/**`, `wads/**`.
- Consumes: rectangle partition input produced by M2-02's compiler (input type `GridPartition` defined here).
- Produces: `buildGridNodes(partition: GridPartition): { segs: Uint8Array; ssectors: Uint8Array; nodes: Uint8Array }` in vanilla 12/4/28-byte layouts (R01 §8-10); splits are always axis-aligned so `P_PointOnDivideSide` degenerates to sign tests — but nodes still carry full dx/dy/bbox fields.
- Deps: M1-01 (contract).
- Acceptance: 1) node count ≤ 2·leaves−1 and every subsector maps to exactly one rect; 2) seg angles are 0/90/180/270 BAM quadrants; 3) ssector/seg/node byte sizes divisible by 4/12/28; 4) longest-axis-first splitting keeps depth ≤ log2-based bound on a 32×32 checkerboard.
- Verify: `npx vitest run tests/fixtures/grid-nodes.test.ts`

### M2-02 — Rectangle-spec fixture map generator + BSP property test (A-04 chain pt.2)
- Goal sentence: `buildMapLumps(FixtureSpec)` emits all 10 map lumps so layer-2 tests run with zero external data — the completion of T01.
- Owns: `tests/fixtures/map-builder.ts`, `tests/fixtures/map-builder.test.ts`; extends `tests/fixtures/wad-builder.ts` `buildWad({maps})` to the full §6.1 contract.
- Must not touch: `src/**`, `docs/**`.
- Consumes: `GridPartition` (M2-01), `buildWad` (M1-05).
- Produces: ARCHITECTURE §6.1 `FixtureSpec`, `buildMapLumps`, updated `buildWad` — THINGS (doomednum 1-4 player starts + arbitrary kinds), LINEDEFS/SIDEDEFS/VERTEXES/SECTORS from cell runs, linear REJECT, correct BLOCKMAP (word offsets, −1 terminators, R01 §13), plus M2-01's node lumps.
- Deps: M2-01, M1-05.
- Acceptance: 1) property test (≥200 seeded random specs incl. 32×32 checkerboards): a test-local reference walker (≤40 lines, independent of src/) resolves every grid sample point to the owning sector from the emitted NODES/SEGS/SSECTORS; 2) BLOCKMAP self-check: every linedef appears in exactly the blocks its bbox touches; 3) REJECT bit layout linear s1·n+s2 (R01 §12); 4) hand-authored reference maps (single room, L-room) committed as `tests/fixtures/reference-maps.ts` blobs, passing the same walker; 5) determinism: same spec ⇒ same sha256.
- Verify: `npx vitest run tests/fixtures/map-builder.test.ts`

### M2-03 — mapdata lump decoder (THINGS…BLOCKMAP + REJECT)
- Goal sentence: map lumps resolve by index from the marker and decode into the §2.2 structs with every R01 §15 quirk handled.
- Owns: `src/wad/mapdata.ts`, `src/wad/mapdata.test.ts`.
- Must not touch: `src/sim/**` (runtime structs are M2-04), `docs/**`.
- Consumes: `WadFile` (§2.1). Produces: §2.2 `MapData`, `LineDef`, `SideDef`, `Vertex`, `Seg`, `SubsectorDef`, `Node`, `SectorDef`, plus `loadMap(wad: WadFile, name: string): MapData` and typed views `thingAt(md, i)`, `rejectVisible(md, s1, s2): boolean`; blockmap kept raw (`md.blockmap`) — iterator lands in M2-05.
- Key rules: resolve the 10 lumps BY INDEX from the marker (quirk 1); int16 signed sidenum −1 sentinels (quirk 3); both `E1M1`/`MAP01` patterns (R01 §17); NODES low-bit subsector flag; seg angle u32-as-number.
- Deps: M1-01, M1-02, M1-05 (fixture maps for tests).
- Acceptance: 1) fixture round-trip: spec → lumps → decode equals spec counts, lights, specials, tags; 2) handcrafted byte vectors pin struct sizes (14/30/4/12/4/28/26 B) and the −1 sentinel; 3) `skipIf(!hasWad)`: freedoom1 E1M1 decodes — blockmap origin (−712,−1072) 32×27, all lists −1-terminated, reject size = ⌈n²/8⌉ (R01 §13); 4) no `getUint16` on −1-capable fields (grep-clean).
- Verify: `npx vitest run src/wad/mapdata.test.ts`

### M2-04 — Sim-side map setup (p_setup + runtime state structs)
- Goal sentence: decoded `MapData` becomes the live-world model — mutable runtime structs with linked line/sector refs, built in a fixed order.
- Owns: `src/sim/state.ts`, `src/sim/p_setup.ts`, `src/sim/p_setup.test.ts`.
- Must not touch: `src/wad/**`, `src/render/**`, `docs/**`.
- Consumes: §2.2 structs, `core/constants.ts` (A-FX1). Produces runtime `line_t/side_t/sector_t` mirrors (R04 §13 fields: `frontsector/backsector/special/tag/validcount`, `sector_t.floorHeight/ceilingHeight/lightLevel/floorPic/ceilingPic/tag/special/...`), `sectorsTagged: Map<tag, number[]>` in linedef-scan order (§5.1), and `Readonly` read-views for render (§1.2). Exact exports: `setupWorld(md: MapData): World`, `getWorld(): World`, `P_GroupLines`-equivalent linking.
- Deps: M2-03.
- Acceptance: 1) every linedef referenced by exactly the sectors it borders (fixture property); 2) `sectorsTagged` order = linedef-index order; 3) THINGS pass records starts (doomednum 1-4), warns+skips unknown kinds (R12 §9.1), spawns nothing else; 4) render-visible types are `Readonly` views; 5) A-INT1 boundary rules stay green.
- Verify: `npx vitest run src/sim/p_setup.test.ts`, `npm run check`

### M2-05 — Blockmap runtime + BSP point location
- Goal sentence: `pointInSubsector` descends the real node tree bit-exactly, and `P_BlockLinesIterator` enumerates linedefs per 128-unit block — the two primitives every later feature sits on.
- Owns: `src/sim/p_map.ts`, `src/sim/p_map.test.ts`.
- Must not touch: `src/render/**`, `src/wad/**`, `docs/**`.
- Consumes: `World` (M2-04), `FixedMul`/angle ops (A-FX1), node/seg structs (§2.2). Produces: `pointInSubsector(x, y): SubsectorIndex` (vanilla `R_PointInSubsector` walk + `P_PointOnDivideSide` with the `>>8`-pre-shifted intercept math kept verbatim per §3.5.4; NOTE gap G7), `sectorAtPoint`, `P_BlockLinesIterator(x, y, cb)` over the raw BLOCKMAP (word offsets ×2, −1 terminator, out-of-grid = no lines, R01 §13).
- Deps: M2-04, A-FX1.
- Acceptance: 1) fixture property: every sample point of ≥100 seeded maps resolves to the generator's owning sector (same corpus as M2-02, now through the *real* walker); 2) deterministic tie-break: points exactly on splits return a stable side across runs; 3) blockmap: every linedef of a fixture map is returned by exactly the blocks its bbox touches (double loop over all blocks); 4) `skipIf(!hasWad)`: 4096 seeded points on E1M1 never throw and each resolves to a sector index < sector count; spawn-point sector matches a committed value; 5) MININT-safe: divide-by-zero path can't hang (SlopeDiv clamp).
- Verify: `npx vitest run src/sim/p_map.test.ts`

### M2-06 — Sim skeleton: dummy player, tic driver, headless harness
- Goal sentence: `stepTics(n, cmds)` advances a world + minimal player deterministically in Node, which is the harness every later sim task extends.
- Owns: `src/sim/g_game.ts` (stub: gamestate enum, `gameaction`, `gametic`, `G_InitNew`/`G_Ticker` minimal per §3.2 order), `src/sim/p_tick.ts` (leveltime, empty thinker list with the Map-insertion-order contract §2.4), `src/sim/state.ts` *append-only* additions (player slot per §2.4 subset: `mo` position fields, `cmd: TicCmd`, `cheats`, `playerState`), `tests/sim/harness.ts`, `tests/sim/skeleton.test.ts`.
- Must not touch: `src/platform/**`, `src/render/**`, `docs/**`.
- Consumes: `setupWorld` (M2-04); produces: `stepTics(n: number, cmds?: TicCmd[]): number` (returns `hashState()`), `hashState()` FNV-1a per §3.4 (M2 scope fields), `DoomEvent` type (§1.2 seam) consumed by M2-07.
- Deps: M2-04.
- Acceptance: 1) same fixture + same scripted cmds ⇒ identical `hashState()` over 3 runs (determinism contract §3.5); 2) `gametic`/`leveltime` advance exactly n; 3) harness boots from `buildWad` bytes with no DOM (`document`/`window` undefined-safe — lint proves via sim-boundary rules); 4) no wall-clock/`Math.random` (A-INT1 lint enforces); 5) harness exposes `loadFixture(spec)` + `loadIwad(name)` (skipIf).
- Verify: `npx vitest run tests/sim/skeleton.test.ts`, `npm run check`

### M2-07 — Noclip fly movement + keyboard + debug API wiring
- Goal sentence: pressing keys moves a noclip-flying player through the world at 35 Hz, and `__doom.loadMap/warp/step/noclip/state` drive the same code path tests use.
- Owns: `src/sim/p_user.ts` (fly/noclip subset of `P_MovePlayer`: angle-turn from cmd, `pTryMove`-free position integrate via `FixedMul` of forward/side speeds, vanilla `forwardmove`/`sidemove` speed constants, no collision, MF_NOCLIP|MF_NOGRAVITY set — explicitly *not* the full physics of M5), `src/platform/input.ts` (keyboard → `DoomEvent[]`, WASD+arrow+TAB bindings per A-09 default table), `src/debug.ts` (replace stubs: real `loadMap/warp/noclip/step/pause/state` against the sim; `warp` = direct fixed-set + `angleDeg→BAM`, teleport semantics note §7), `src/types/debug.ts` (`DebugStateSnapshot` discriminated union per §7, M2-complete fields), `src/main.ts` (boot: wadload → first map → per-rAF present via M2-09 framebuffer when present, else blank canvas), `src/sim/d_main.ts` (per-tic dispatch: drain events → buildTiccmd into `netcmds[0][gametic%12]` → `G_Ticker`, §3.1 step 3).
- Must not touch: `src/wad/**`, `docs/**` (DECISIONS entry for warp-teleport-vs-P_TeleportMove goes through orchestrator, not this task).
- Consumes: harness contracts (M2-06), `World` (M2-04), `platform/wadload.ts` (M1-08).
- Deps: M2-06.
- Acceptance: 1) harness test: scripted cmds (fwd+turn) move player by a committed fixed-point delta hash over 35 tics (noclip fly ⇒ analytic, no friction yet); 2) `__doom.step(35)` == harness-equivalent hash (same code path); 3) e2e (real key events, debug only asserts): holding right-arrow increases angleDeg monotonically over sampled tics; holding W increases distance travelled; 4) `state()` returns ready:true with player x/y/z/angleDeg matching internal fixed values; 5) zero console errors; 6) p_user.ts contains no blockmap/collision calls (grep assertion — M5 replaces this file honestly).
- Verify: `npx vitest run tests/sim/`, `npm run e2e -- e2e/movement.spec.ts` (new skeleton), `npm run check`

### M2-08 — Automap state machine (sim/am_map.ts)
- Goal sentence: automap mode/follow/zoom/pan/mark state evolves tick-deterministically from queued events, exactly where vanilla AM_Ticker does (§3.2 GS_LEVEL item list).
- Owns: `src/sim/am_map.ts`, `src/sim/am_map.test.ts` (via M2-06 harness).
- Must not touch: `src/render/**`, `docs/**`.
- Consumes: `DoomEvent`s (M2-06), player slot, `World`; produces: `AM_Ticker()`, `AM_Responder(ev): boolean`, `AutomapState` read-view `{m_x, m_y, m_mtof, f_e, am_WhichThings/flags, marks[10], cheating, current lightlev}` — fields named per R09 §5 (follow/grid/marks/zoom vars, `INITSCALEMTOF`, `M_ZOOMIN = 1.02*FRACUNIT` i.e. `66847`-ish fixed constant pinned in test, `litelevels[]` 8-tic strobe through `mRandom`-free tic counter).
- Deps: M2-06.
- Acceptance: 1) TAB toggles map on/off, responder consumes event (no leak to player input while open, arrows pan when not following); 2) 'f'/'g'/'m'/'c' behaviors + ≤10 marks with FIFO evict (R09 §5); 3) zoom holds 2%/tic, clamps at min/max; 4) determinism: identical event script ⇒ identical `AutomapState` hash; 5) follow-mode tracks player fixed coords via `FixedMul` (uses A-FX1).
- Verify: `npx vitest run src/sim/am_map.test.ts`

### M2-09 — Automap renderer (render/automap.ts + player arrow)
- Goal sentence: automap state + world lines become correct pixels in the 320×200 index buffer, with vanilla line classes and the white arrow.
- Owns: `src/render/framebuffer.ts` (320×200 `Uint8Array` index buffer + RGBA scratch + palette blit LUT per §4.7 — pulled forward from M3, gap G8), `src/render/automap.ts`, `src/render/palette-blit.test.ts`, present wiring in `src/main.ts` (the only cross-task file it touches; coordinate with M2-07's version — sequential, not parallel).
- Must not touch: `src/sim/**` (read-view only), `src/wad/**`, `docs/**`.
- Consumes: `AutomapState` read-view (M2-08), `World` read-views (M2-04), `Palettes` (M1-03). Produces: `drawAutomap(fb)`, `AM_drawWalls` classification per R09 §5 — one-sided `WALLCOLORS+lightlev` strobe; special-39 teleporter `WALLCOLORS+WALLRANGE/2`; floor-ceiling-change two-sided `FDWALLCOLORS+lightlev`; ceiling-change `CDWALLCOLORS+lightlev`; flat two-sided only when `cheating`; secret lines normal unless cheating; player arrow `WHITE` at scale, `AM_drawGrid` at 256-unit block boundaries when grid on; all coords via `FixedMul` m-to-f transforms, screen clipping without allocation.
- Deps: M2-05, M2-08, M1-03.
- Acceptance: 1) fixture map: one-sided boundary pixels equal `WALLCOLORS+lightlev[tic%8]` set; floor-change line pixels in BROWNS range; two-sided flat invisible with cheating=0; 2) arrow present at expected screen coords in follow mode (pixel-window assertion); 3) grid ON draws lines at every `MAPBLOCKUNITS<<FRACBITS`; 4) zero allocation in steady-state draw (test counts via reuse pattern); 5) framebuffer LUT rebuilt only on palette change; 6) render imports no `sim/` mutators (A-INT1 + Readonly views).
- Verify: `npx vitest run src/render/palette-blit.test.ts`, `npm run check`

### M2-10 — Golden automap frames + M2 e2e
- Goal sentence: the milestone's evidence: committed frame goldens (fixture always-on, E1M1 skipIf) and a green keyboard-driven e2e on `main`.
- Owns: `tests/render/automap.test.ts`, `tests/render/goldens/automap/*` (sha256 + PNG), `scripts/goldens-update.mjs` + `npm run goldens:update` (package.json edit), `e2e/automap.spec.ts`.
- Must not touch: `src/**` implementations (findings → fix tasks), `docs/**`.
- Consumes: renderer (M2-09), fixture maps (M2-02), harness (M2-06).
- Acceptance: 1) fixture golden: scripted event script (TAB + 20 tics) ⇒ committed index-buffer sha256, regenerated only via update script which records the reason; 2) E1M1 spawn golden `skipIf(!hasWad)`; 3) e2e: real keys — TAB opens, arrows/WASD move arrow (canvas changes + `state()` deltas), zero console errors; 4) PNGs written to test-results and *reviewed* against R09 §5 checklist by the verifier; 5) `npm run check && npm run e2e` green on integrated main.
- Verify: `npm run check`, `npm run e2e -- e2e/automap.spec.ts`, `npm run goldens:update -- --check`

## 3. Architecture gaps discovered in this planning pass
- G6: §2.2 stores BLOCKMAP/REJECT raw but names no accessor API — M2-03 adds `loadMap/thingAt/rejectVisible` and M2-05 the iterator; back-port signatures into §2 at retro.
- G7: vanilla `R_PointInSubsector` lives in r_main.c; we place `pointInSubsector` in `sim/p_map.ts` (sim needs it for specials/AI later) — deliberate deviation from vanilla file layout, record in DECISIONS.
- G8: `render/framebuffer.ts` (§4.7, planned M3) is needed by the automap in M2 — pulled forward into M2-09; M3 wall-render tasks must then not re-own it.
- G9: §7 `DebugStateSnapshot` assumes a full Player (§2.4) that does not exist before M5/M7 — M2-07 lands the union with M2-relevant fields real and the rest pinned to documented defaults; snapshot schema note goes to §7 at retro.
- G10: THINGS beyond player starts cannot spawn before the mobj tables (M6) — M2-04 warns+skips, consistent with R12 §9.1; automap thing-drawing deferred to M4/M6 (vanilla parity note: things were never in scope for M2's exit).
