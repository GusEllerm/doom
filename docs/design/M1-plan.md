# M1 Plan — WAD & data decoding

Status: planned. Parent: docs/ROADMAP.md M1. Inputs: ARCHITECTURE.md §2.1/§2.2/§6/§7, PROMPT.md §7.4/§8-M1, R01, R02.
Exit (from ROADMAP): the debug viewer page shows any texture, flat, sprite or patch from the IWAD with the correct palette; `npm run check` + viewer e2e green.

## 0. Exit criteria (milestone-level, objectively checkable)
1. `WadFile.parse` works on the pinned freedoom1.wad and on synthetic fixture WADs (unit tests, layer 1).
2. Decoders for PLAYPAL/COLORMAP, patches, flats, TEXTURE1(+PNAMES), sprite census exist under `src/wad/`, each with byte-vector + golden-hash unit tests that run without any IWAD present (synthetic fixtures), plus real-IWAD golden-hash tests behind `describe.skipIf(!hasWad)` (ARCHITECTURE §6 layer 1/2 rules).
3. `viewer.html` (dev server) loads `wads/freedoom1.wad` (or `?wad=` override), lists lumps, and renders any patch, flat, TEXTURE1 texture or sprite with palette 0 applied; verified by an agent looking at screenshots (layer 5) and by e2e canvas assertions (layer 4: non-blank, not single-color).
4. `npm run check` green incl. the new eslint import-boundary rules (A-INT1).

## 1. Task graph and parallel waves

| Wave | Tasks (parallel) | Depends |
|---|---|---|
| 0 (contract) | M1-01; A-INT1 (cross-cutting, §TASKS ledger) | — |
| 1 | M1-02, M1-03, M1-04, M1-05 | M1-01 |
| 2 | M1-06, M1-07 | M1-04 / M1-02 (+M1-05 for tests) |
| 3 | M1-08 | M1-02..M1-07 |
| 4 | M1-09 | M1-08 |

Dependency edges are listed per task below. Wave-1 decoders take `Uint8Array` inputs (no WadFile dependency), which is what makes wave 1 wide.

## 2. Tasks

### M1-01 — Contract: wad/graphics types + decode signatures
- Goal: land the shared typed contracts every parallel M1 task builds against (PROMPT §5 contract rule).
- Goal sentence: `npm run check` compiles stub-typed contracts so five decoders can be written in parallel without touching each other's files.
- Owns: `src/wad/types.ts` (new), `src/wad/wadfile.ts` (skeleton class, typed methods `throw new Error('unimplemented')` until M1-02).
- Must not touch: `src/sim/**`, `src/render/**`, `src/platform/**`, `tests/**`, `docs/**`, `e2e/**`.
- Consumes: ARCHITECTURE §2.1 (`LumpInfo`, `WadFile`), §2.2 (`MapData` family — declared here so M2 needs no contract re-open).
- Produces (exact names): §2.1/§2.2 types; plus decoded-graphics types §2 does *not* define (gap G1): `Palettes { base: Uint32Array /* 14*256 RGBA */; colormapRows: Uint8Array /* 34*256 */ }`, `DecodedPatch { width; height; leftOffset; topOffset; columns: Uint8Array[] /* per column, aligned post runs */ }`, `DecodedFlat { name: string; pixels: Uint8Array /* 4096 */ }`, `TextureDef { name; width; height; patches: TexturePatch[]; columns: Uint8Array[] /* composed, column-major, 0=transparent */ }`, `SpriteDef { name4: string; frames: { rotate: boolean; lump: [number,number,number,number,number,number,number,number]; flip: Uint8Array /*8*/ }[] }`.
- Deps: none.
- Acceptance: 1) types compile under `tsc --noEmit` strict incl. `noUncheckedIndexedAccess`; 2) skeleton `WadFile.parse` throws typed errors, signatures byte-identical to §2.1; 3) no other src/ file changed.
- Verify: `npm run check`.

### M1-02 — WadFile: header, lump directory, lookup rules
- Goal sentence: parsing any WAD gives correct identification, last-match-wins case-insensitive lookup, index-range scans and zero-copy lump reads.
- Owns: `src/wad/wadfile.ts` (completes M1-01 skeleton), `src/wad/wadfile.test.ts`.
- Must not touch: other `src/wad/*` decoders, `src/sim|render|platform/**`, `docs/**`.
- Consumes: `LumpInfo`, `WadFile` (§2.1). Produces: same, implemented.
- Impls §2.1 exactly: `parse`, `identification`, `lumpNumByName` (last-match wins, −1), `lumpNumAt`, `lumpName`, `lumpRange` (skips zero-size markers, R12 §9.7), `readLump` (subarray, zero-copy), `readLumpByName`, `has`.
- Deps: M1-01. (Tests for lumpRange need a WAD: handcrafted byte vectors in-test until M1-05 lands; final integration in M1-09.)
- Acceptance: 1) header/dir parse for 'IWAD'/'PWAD'; 2) name trim of NUL *and* space padding, case-insensitive, last-match wins (R01 §15.2); 3) `readLump` returns subarray aliasing the source buffer (no copy — assert `byteOffset` semantics); 4) `lumpRange('S_START','S_END')` skips zero-size entries; 5) malformed header (bad identification, dir past EOF) throws typed error; 6) ≥8 unit tests on handcrafted byte vectors, all green.
- Verify: `npx vitest run src/wad/wadfile.test.ts`, `npm run check`.

### M1-03 — PLAYPAL / COLORMAP decoders
- Goal sentence: PLAYPAL bytes decode to 14 RGBA palette rows and COLORMAP to 34×256 translation rows, testable without a renderer.
- Owns: `src/wad/palette.ts`, `src/wad/palette.test.ts`, `src/wad/fixtures-golden/palette/*.json` (golden hashes of synthetic-input decodes).
- Must not touch: `src/render/**` (the RGBA-blit LUT is M3+), `docs/**`.
- Consumes: none (pure `Uint8Array` in). Produces: `Palettes` (M1-01), `decodePlaypal(buf: Uint8Array): Palettes`, `decodeColormap(buf: Uint8Array): Uint8Array`, `rgbaAt(pal, index): number`.
- Facts pinned from R02 §2-3: PLAYPAL = 14×768 RGB triples; COLORMAP = 34×256 (32 light + 2 invuln); size mismatch throws.
- Deps: M1-01.
- Acceptance: 1) 10752/8704 size validation + typed throw otherwise; 2) golden sha256 tests on a synthetic 10752 B ramp input; 3) RGBA packing order asserted (0xAARRGGBB little-endian Uint32); 4) real-IWAD test asserts freedoom1 PLAYPAL/COLORMAP exact sizes + sha256, `skipIf(!hasWad)`.
- Verify: `npx vitest run src/wad/palette.test.ts`.

### M1-04 — Patch (column/post) decoder
- Goal sentence: any patch-format lump (walls, sprites, interface graphics) decodes to typed columns/posts with correct alignment handling.
- Owns: `src/wad/patches.ts`, `src/wad/patches.test.ts`, `src/wad/fixtures-golden/patch/*`.
- Must not touch: `src/render/**`, `src/wad/sprites.ts` (M1-07 owns naming), `docs/**`.
- Consumes: `DecodedPatch` (M1-01). Produces: `decodePatch(buf: Uint8Array): DecodedPatch`; column-major post layout per ARCHITECTURE §4.3 (per column: aligned runs of `{topDelta, pixels}`).
- Facts pinned (R01 §14, R02 §5): header 4×int16 then int32 `columnofs[width]`; post = `(int8 topdelta, byte length, bytes)` until `topdelta==0xFF`; 1-4 align bytes between columns, `columnofs` authoritative.
- Deps: M1-01.
- Acceptance: 1) handcrafted vector: 2-column patch with terminator + 3 align bytes decodes exactly; 2) truncated column (past lump end) throws typed `WadParseError`, never reads OOB; 3) golden sha256 on a deterministic synthetic 64×64 patch; 4) decoder is allocation-reusable (`decodePatchInto(out, buf)` variant tested to reuse column arrays); 5) `skipIf(!hasWad)` golden decode of freedoom1 `TEXTURE1` sample patch + one `S_START` sprite, sha256 committed.
- Verify: `npx vitest run src/wad/patches.test.ts`.

### M1-05 — Fixture-WAD micro-builder (tests/fixtures)
- Goal sentence: unit tests can synthesize a tiny valid WAD (header, dir, markers, fake graphics) with zero external content — this is the WAD-writer half of T01 and is reused unchanged by the M2 rectangle-map generator.
- Owns: `tests/fixtures/wad-builder.ts`, `tests/fixtures/graphics.ts`, `tests/fixtures/wad-builder.test.ts`, `tests/fixtures/index.ts`.
- Must not touch: `src/**`, `docs/**`, `wads/**`.
- API: `buildWad(lumps: {name: string; data?: Uint8Array}[], identification?: 'IWAD'|'PWAD'): ArrayBuffer` (auto S_/P_/F_ START/END markers around typed groups, dir by offset order) and generators `synthPatch(w,h,seed)`, `synthFlat(name,seed)`, `synthPlaypal()`, `synthColormap()`, `synthPnames+Texture1(...)` matching M1-01 decoded shapes. Contract: ARCHITECTURE §6.1 `buildWad` signature kept source-compatible (the `maps:` field is filled by M2-02).
- Produces: the byte source for every wave-1/2 golden test (deterministic seeds ⇒ committed golden hashes are reproducible).
- Deps: M1-01. Note: round-trip test against the real `WadFile.parse` runs in M1-09 (cross-wave file ownership).
- Acceptance: 1) output passes structural self-check test (identification, dir offsets strictly increasing, names 8-byte NUL/space padded); 2) deterministic — two runs hash equal; 3) generated synthetic patch/flat/palette byte-lengths equal the R01 §14 real-WAD constants (4096 flat, 10752 PLAYPAL, etc.); 4) no dependency on any real WAD.
- Verify: `npx vitest run tests/fixtures/wad-builder.test.ts` (add `tests/**/*.test.ts` to vitest include — allowed edit in `vitest.config.ts`).

### M1-06 — Flat + TEXTURE1/PNAMES texture decoders
- Goal sentence: named flats load raw 64×64 and TEXTURE1/PNAMES records compose into column-major textures with transparent-pixel correctness.
- Owns: `src/wad/flats.ts`, `src/wad/textures.ts`, `src/wad/flats.test.ts`, `src/wad/textures.test.ts`, `src/wad/fixtures-golden/texture/*`.
- Must not touch: `src/wad/patches.ts` (consumes only), `src/render/**`, `docs/**`.
- Consumes: `DecodedPatch`/`decodePatch` (M1-04), `DecodedFlat`, `TextureDef` (M1-01), M1-05 fixtures for tests.
- Facts pinned (R01 §14, R02 §6-7): flat = raw 4096 B, first byte top-left; PNAMES count int32 + 8-byte names (stride 8); texture record width@12/height@14/patchcount@20, patches `{x,y,patch,stepdir,colormap}` int16 ×5; composition blends by (x,y) offset with 0 = transparent; masked-texture detection = any transparent pixel inside bounding columns (§4.3 sentinel scan).
- Deps: M1-04 (composition), M1-05 (test inputs).
- Acceptance: 1) PNAMES stride-8 and record offsets asserted by handcrafted vectors (the three R01 §15.6 divergences covered); 2) composed 64×64 texture from 2 synthetic patches equals hand-computed expected columns; 3) `skipIf(!hasWad)` test parses freedoom1 PNAMES+TEXTURE1 fully (all 801 records sane: width/height>0, patch indices < pnames.length) and sha256s two composed textures; 4) texture-by-name lookup cache (`textures.get('BIGDOOR1')`) pure-functional; 5) <450 diff lines including tests.
- Verify: `npx vitest run src/wad/flats.test.ts src/wad/textures.test.ts`.

### M1-07 — Sprite definition loader (lump census + frame/rot naming)
- Goal sentence: scanning `S_START..S_END` yields per-sprite frame tables with 8-rotation lump ids and mirror flags, matching R02 §8/R06 §4 naming rules.
- Owns: `src/wad/sprites.ts`, `src/wad/sprites.test.ts`.
- Must not touch: `src/wad/patches.ts` (pixel decode is M1-04's), `src/render/**`, `docs/**`.
- Consumes: `WadFile.lumpRange('S_START','S_END')` (§2.1, M1-02), `SpriteDef` (M1-01), M1-05 fixture WADs for tests.
- Produces: `buildSpriteDefs(wad: WadFile): { byName: Map<string /*4cc*/, SpriteDef>; lumpToSprite: Map<number, {sprite: number; frame: number; rot: number; flip: boolean}> }`; name parse: chars 0-3 sprite, char 4 frame letter, char 5 rotation digit (`0` = all angles, `1-8` octants, `XY` mirror pairs → flip bit on the pair's base frame).
- Deps: M1-02, M1-05.
- Acceptance: 1) name-parse table test covers `BOSSA1`, `PLAYA2A8`-style mirror pairs, bogus names skipped+warned; 2) fixture WAD with 2 sprites × 2 frames census equals the expected `SpriteDef` structure; 3) `skipIf(!hasWad)`: all 853 freedoom1 sprite lumps map with zero warnings, frame totals equal a committed count; 4) frame index = letter-'A' handled.
- Verify: `npx vitest run src/wad/sprites.test.ts`

### M1-08 — Debug viewer page (platform)
- Goal sentence: a dev-only page renders any chosen patch/flat/texture/sprite from a loaded IWAD through PLAYPAL palette 0 onto the 320×200 canvas.
- Owns: `viewer.html`, `src/viewer/main.ts`, `src/viewer/blit.ts` (indexed→RGBA via `Palettes`, viewer-only until `render/framebuffer.ts` lands in M3), `src/platform/wadload.ts` (fetch + optional sha256 verify via `crypto.subtle`, async — record deviation), `vite.config.ts` (multi-entry `viewer`), `e2e/viewer.spec.ts` (skeleton).
- Must not touch: `src/main.ts`, `src/debug.ts` semantics (viewer does not install `__doom`; game page untouched), `src/wad/**` (consumers only), `docs/**`.
- Consumes: `WadFile`, `decodePlaypal`/`decodeColormap`, `decodePatch`, flats/textures (M1-06), sprite census (M1-07).
- Route: separate `viewer.html` entry (decision to record in DECISIONS.md: cleaner than a `?debug` branch in the game page; the in-game debug route arrives with M3 framebuffer capture).
- Deps: M1-02, M1-03, M1-04, M1-06, M1-07.
- Acceptance: 1) loads `/wads/freedoom1.wad` (404 → file-picker fallback UI, no console error); 2) lump-type selector (P_START patches, F_START flats, TEXTURE1 names, sprite 4cc) + `?lump=NAME` deep link renders the graphic; 3) patch/sprite drawn at native size honoring left/top offsets, flat 64×64, texture composed; 4) canvas assertions: non-blank, not single-color, changes on lump switch, zero console errors; 5) nearest-neighbour upscale, no smoothing; 6) screenshots of ≥4 lump kinds reviewed by the verifier (layer-5 checklist under test-results).
- Verify: `npm run e2e -- e2e/viewer.spec.ts`; manual: `npm run dev` → `/viewer.html?lump=DOOR1` + screenshot review

### M1-09 — IWAD integration goldens + viewer e2e hardening
- Goal sentence: the milestone's real-data evidence exists: fixture↔parser round-trip, per-decoder IWAD golden hashes, and a green viewer e2e on `main`.
- Owns: `src/wad/integration-iwad.test.ts` (single `describe.skipIf(!hasWad)` file), `e2e/viewer.spec.ts` (completion), `tests/fixtures/roundtrip.test.ts`.
- Must not touch: `src/wad/*` implementations (findings are filed as fix tasks, not folded in), `docs/**`.
- Consumes: everything above.
- Deps: M1-02..M1-08.
- Acceptance: 1) round-trip: `buildWad` output re-parsed by `WadFile.parse` — names, offsets, ranges, zero-size markers all agree; 2) IWAD asserts PLAYPAL/COLORMAP hashes, PNAMES/TEXTURE1 record counts (1049 names; 801+162 textures), sprite census totals, one composed-texture sha256, one patch sha256 — committed values from R01 §14; 3) e2e deep-links 4 lump kinds, asserts canvas properties + zero console errors; 4) `npm run check && npm run e2e` green on integrated `main`.
- Verify: `npm run check`, `npm run e2e -- e2e/viewer.spec.ts`

## 3. Architecture gaps discovered in this planning pass
- G1: ARCHITECTURE §2 defines no decoded-graphics types (patch/flat/texture/palette/sprite) — M1-01 defines them in `src/wad/types.ts`; back-port into §2 at the M1 retro.
- G2: `vitest.config.ts` includes only `src/**/*.test.ts`; `tests/**` unit tests (fixtures, M2 harness) need the include widened — done in M1-05.
- G3: §6.1 `buildWad(opts)` assumes map specs exist; M1 ships the graphics-only half (maps optional until M2-02); signatures kept compatible.
- G4: viewer entry choice (separate `viewer.html` vs `?debug` route) is unrecorded — M1-08 writes it to DECISIONS.md.
- G5: `wadload.ts` sha256 verify is async (`crypto.subtle`) while §3.1 boot reads as sync — viewer tolerates async; revisit at M3 when `main.ts` boots the engine.
