/**
 * tests/render/viewpoints.ts — golden viewpoint scene table
 * (M3-plan §M3-08 + M4-plan §M4-08: the ≥26 full-frame scenes consumed by
 * tests/render/walls.test.ts and — the iwad half — e2e/walls.spec.ts).
 *
 * Three scene families (M4-08):
 *  - 12 WALLFIX scenes on the M3 WALLFIX fixture (4 rooms × 3 viewpoints),
 *  - 7 M4FIX scenes on the M4-06 fixture maps — MASKFIX (masked fence),
 *    SKYFIX (F_SKY1 room), THINGSFIX (octant/flip sprites), PANFIX
 *    (panned sidedefs) — all wad-free,
 *  - 12 freedoom1 E1M1 scenes (skipIf no wad in the vitest suite).
 *
 * M4-08 additions (≥6 new, plan §M4-08 "New scenes"), all analytically
 * derived from THINGS/LINEDEFS/SIDEDEFS/SECTORS (no screenshots):
 *  - fixmask-fence/back: MASKFIX_SPEC two-room map joined by a MASKFIX0
 *    masked fence (solid shoulders + column-parity holes) — holes show the
 *    FAR wall, viewed from both sides.
 *  - fixsky-room/seam: SKYFIX_SPEC sky room (light 32 ⇒ fullbright
 *    evidence: dimmed tables cannot darken sky) + a view where the sky
 *    plane meets the far wall top (the plan §6 horizon-seam risk).
 *  - fixthings-flip: THINGSFIX_SPEC octant ring viewed off-centre: 6
 *    BAR1 statics in view — the near one slot 0 (A1), two slot 4 (A5),
 *    and FOUR flipped lumps: slots 2/3/5 (A3A7/A4A6 XY-mirror halves —
 *    rot = (ang − thingangle + 9·(ANG45/2)) >> 29 per thing, pinned by
 *    the rthings tests; the ring's centre view is all-slot-4 symmetric,
 *    which is WHY this off-centre viewpoint exists).
 *  - fixpan-panned/rowskip: PANFIX_SPEC panned sidedefs — textureoffset
 *    40 shifts FIXWALL0 columns (renderer-consumed axis) and a
 *    rowoffset-only sidedef pins the renderer-blind axis (m4Fixtures
 *    header). Closes the M3 "panned sidedef not expressible" gap note.
 *  - e1m1-court-sky/court-things: E1M1 spawn courtyard = sector 29
 *    (f0/c128, ceiling F_SKY1, L128) ringed by TRE2 things at
 *    (−576…−640, 192…304); SW from inside it fills the top band with sky
 *    (removed-SKY1 diff ≈ 37.6k px), W from spawn puts 5 TRE2 + BON1/
 *    STIM/corpse statics at columns ≈96/133/160/171/204 (probe-recorded).
 *  - e1m1-yard-fenced/busy-mix: sky yards sec 23 (f40/c536 L224, centre
 *    (2224,1323)) + sec 39 (f−80/c536 L240, centre (2200,917)) — MC17/
 *    MC18/ASHWALL masked shells whose projected spans overlap ≥10 static
 *    sprite columns (TRE/SMIT/BAR1/COLU), i.e. sprites + masked middles
 *    in one frame; all counters 0 at both.
 *
 * ----------------------------------------------------------------------
 * WALLFIX fixture design (plan §M3-08 "a WALLFIX RectMapSpec"):
 *   four 512-unit rooms at light 0 / 96 / 192 / 255 (all four scalelight
 *   extremes), a floor-change divider (A|B and C|D share a wall line whose
 *   sectors differ 24 units — the clippass window path), a DOORFIX0 mid-
 *   texture door gap (C|D, special 1), VOID-facing FIXWALL0 boundary walls
 *   in BOTH orientations (vertical x=const + horizontal y=const — the
 *   pancake ±1 rule, R03 §10 / M3-01 acceptance 4), and light-only shared
 *   edges (A|C, B|D: identical heights, different lights ⇒ clippass with
 *   no texture — the identical-flats noDraw-rule neighbour).
 *   The 4×3 pos/angle grid samples every room under both wall orientations
 *   plus one oblique view per room toward the map centre (texture slide /
 *   non-pancake diagonal path).
 *
 * FIXTURE GAP NOTE (plan §5 "fixture thinness" — recorded, NOT hacked):
 *   a *panned* sidedef (non-zero textureoffset/rowoffset) is NOT express-
 *   ible through the mapBuilder RectMapSpec public API — buildMapLumps
 *   hardcodes both sidedef offsets to 0 (mapBuilder.ts:591-592). Per the
 *   plan the case is recorded for M4 instead of hand-patching lumps in a
 *   golden test. E1M1 iwad scenes DO exercise panned sidedefs (e.g. the
 *   yard ASHWALL/MC17 pannings) via their real sidedef offsets.
 *
 * ----------------------------------------------------------------------
 * E1M1 viewpoint derivation (NO screenshots — all coordinates come from
 * THINGS/LINEDEFS/SIDEDEFS/SECTORS of wads/freedoom1.wad E1M1):
 *  - spawn: thing type 1 = (-416, 256, ang 0); the east view looks down
 *    the sector-140 corridor (linedef chain at x > -416, light 192 vs the
 *    160-lit tech halls ⇒ non-noDraw segs; ~4k wall px, matches the
 *    M3-07 e2e band note). North/south from spawn are all-identical-sector
 *    boundaries (noDraw ⇒ black frames — deliberately NOT chosen).
 *  - corner rooms: deathmatch start 14 thing sits at (2008, 480) inside
 *    sector 124 (f24/c384, L220); facing 135° aims at the room's SW corner
 *    (rich top-band: the 360-tall room box). Sector 5 (f192/c336) ruin
 *    ledge corner at (2500, 1700) facing 225° = the second corner.
 *  - atrium: sector 173 (f -168/c 536 ⇒ 704-tall light-224 hall, the map's
 *    central atrium volume) sampled at (1472, 1088) facing 270° — the side
 *    with the most far-span variation (32 distinct ≥50-px colors in the
 *    probe histogram).
 *  - doorway frame: linedef 80 (v1 1152,1424 → v2 1280,1424) is a two-
 *    sided line whose sidedef 0 midtexture is METAL5 — a masked doorway
 *    slab. Viewpoint (1216, 1540) faces 270° straight at the slab from
 *    sector 27 (f -96/c256): middle-texture + flanking solid frames.
 *  - long vista: the south tech corridor — sector 57 (f0/c256, L160) runs
 *    along y ≈ -192 from x ≈ 320 eastward > 4000 units (los ≥ 4800 by
 *    sector-walk; no cross line until the sector-102 step at x ≈ 1360).
 *    (960, -192) @ 0° stresses far-column scalelight diminishing.
 *  - both-open corridor: sector 149 (f0/c128, L160) at (1050, -30) faces
 *    180° back along a corridor whose flanks are two-sided openings
 *    (the ':' chains at y ≈ ±40) ⇒ many clippass spans + occlusion merges.
 *  - busy solidsegs corner: sector 181 (f48/c536, L224) at (2400, 1152)
 *    faces 180° into the ruin yard — the densest span soup in the map
 *    (≈15k wall px, 29 distinct colors in the derivation probe; the many
 *    ASHWALL/MC17 midtex ruin shells stack spans across the columns).
 *    hom == 0 and drawsegOverflow == 0 there, so NO re-pick per the
 *    plan's MAXDRAWSEGS risk note was needed (kept: the counters are
 *    asserted per scene in walls.test.ts).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** One committed viewpoint. x/y/z are MAP UNITS (integers); angleDeg is
 * degrees (the debug-warp convention: floor(deg/360 · 2^32), NOT the
 * THINGS ANG45 quantization). z omitted ⇒ ONFLOORZ (floor-0 ground). */
export interface Viewpoint {
  name: string;
  kind: 'fixture' | 'iwad';
  /** Which in-memory WAD the kind:'fixture' scenes boot from (M4-08):
   * 'wallfix' (the M3 WALLFIX_SPEC — the DEFAULT, every pre-M4 scene)
   * or one of the M4-06 fixture maps (m4Fixtures.buildM4SceneWad; the
   * things map additionally carries the synthesized S_START roster that
   * walls.test.ts ships — the combined fixture WAD has no sprite lumps).
   * Ignored by kind:'iwad' scenes. */
  readonly fixtureMap?: 'wallfix' | 'm4-mask' | 'm4-sky' | 'm4-things' | 'm4-pan';
  /** Human-readable setup script, mirrored into meta.json for review. */
  readonly script: string;
  readonly map: 'WALLFIX' | 'M4MASK' | 'M4SKY' | 'M4THNG' | 'M4PAN' | 'E1M1';
  readonly x: number;
  readonly y: number;
  readonly angleDeg: number;
  readonly z?: number;
}

/* ------------------------------------------------------------------ */
/* WALLFIX fixture spec                                                */
/* ------------------------------------------------------------------ */

export const WALLFIX_MAP_NAME = 'WALLFIX';

import type { RectMapSpec } from '../fixtures/mapBuilder';

/** 640×640, four rooms, light 0/96/192/255 — see the header for the
 * feature each element exists to exercise. */
export const WALLFIX_SPEC: RectMapSpec = {
  rooms: [
    // A: dark room (scalelight bucket 0 side of the pancake/clamps).
    { x: 0, y: 0, w: 320, h: 320, lightLevel: 0 },
    // B: floor +24 ⇒ the A|B shared line is the floor-change divider.
    { x: 320, y: 0, w: 320, h: 320, lightLevel: 96, floorHeight: 24 },
    // C: mid-bright, floor 0 (A|C edge = light-only clippass line).
    { x: 0, y: 320, w: 320, h: 320, lightLevel: 192 },
    // D: full bright, floor +24 (B|D light-only edge; C|D = door + step).
    { x: 320, y: 320, w: 320, h: 320, lightLevel: 255, floorHeight: 24 }
  ],
  // DOORFIX0 mid-texture gap on the C|D shared edge (special 1).
  doors: [{ x1: 320, y1: 384, x2: 320, y2: 448 }]
};

/* ------------------------------------------------------------------ */
/* Scene table                                                         */
/* ------------------------------------------------------------------ */

/** Room centre points of WALLFIX (all 320×320 rooms ⇒ centres at 160/480). */
const PA = { x: 160, y: 160, room: 'A(light 0)' };
const PB = { x: 480, y: 160, room: 'B(light 96,f24)' };
const PC = { x: 160, y: 480, room: 'C(light 192)' };
const PD = { x: 480, y: 480, room: 'D(light 255,f24)' };

const fixScenes: readonly Viewpoint[] = [
  // 4 positions × 3 angles = 12. Coverage: close-up horizontal VOID walls
  // (pancake -1: fix-b-s/fix-c-n/fix-d-n), close-up vertical VOID walls
  // (pancake +1: fix-a-w/fix-d-e), oblique centre views (divider/door corner
  // + non-pancake diagonal: fix-a-ne/fix-c-ne/fix-d-w), through-the-light-
  // edge vistas (fix-a-n/fix-b-n) and the door/divider pair (fix-c-e/fix-b-w).
  { name: 'fix-a-n', kind: 'fixture', map: 'WALLFIX', x: PA.x, y: PA.y, angleDeg: 90, script: `${PA.room}: N THROUGH the A|C light-only edge to the far C-VOID wall (pass-through occlusion + far bucket)` },
  { name: 'fix-a-w', kind: 'fixture', map: 'WALLFIX', x: PA.x, y: PA.y, angleDeg: 180, script: `${PA.room}: W at vertical VOID wall (pancake +1, darkest room)` },
  { name: 'fix-a-ne', kind: 'fixture', map: 'WALLFIX', x: PA.x, y: PA.y, angleDeg: 45, script: `${PA.room}: oblique NE at the A|B floor-change divider corner` },
  { name: 'fix-b-w', kind: 'fixture', map: 'WALLFIX', x: PB.x, y: PB.y, angleDeg: 180, script: `${PB.room}: W across the floor-change divider (step down into A)` },
  { name: 'fix-b-n', kind: 'fixture', map: 'WALLFIX', x: PB.x, y: PB.y, angleDeg: 90, script: `${PB.room}: N THROUGH the B|D light-only edge to the far D-VOID wall` },
  { name: 'fix-b-s', kind: 'fixture', map: 'WALLFIX', x: PB.x, y: PB.y, angleDeg: 270, script: `${PB.room}: S at horizontal VOID wall (pancake -1)` },
  { name: 'fix-c-e', kind: 'fixture', map: 'WALLFIX', x: PC.x, y: PC.y, angleDeg: 0, script: `${PC.room}: E at the DOORFIX0 door gap (midtex, both-open)` },
  { name: 'fix-c-n', kind: 'fixture', map: 'WALLFIX', x: PC.x, y: PC.y, angleDeg: 90, script: `${PC.room}: N at horizontal VOID wall` },
  { name: 'fix-c-ne', kind: 'fixture', map: 'WALLFIX', x: PC.x, y: PC.y, angleDeg: 45, script: `${PC.room}: oblique NE at the door corner (midtex + VOID frame)` },
  { name: 'fix-d-w', kind: 'fixture', map: 'WALLFIX', x: PD.x, y: PD.y, angleDeg: 180, script: `${PD.room}: W at the door gap + floor step from D side` },
  { name: 'fix-d-e', kind: 'fixture', map: 'WALLFIX', x: PD.x, y: PD.y, angleDeg: 0, script: `${PD.room}: E at vertical VOID wall (pancake +1, brightest bucket)` },
  { name: 'fix-d-n', kind: 'fixture', map: 'WALLFIX', x: PD.x, y: PD.y, angleDeg: 90, script: `${PD.room}: N at horizontal VOID wall (brightest)` }
];

const m4FixScenes: readonly Viewpoint[] = [
  // MASKFIX: the shared x=256 line carries MASKFIX0 on both sidedefs —
  // solid shoulders cols 0-15/48-63, parity holes on odd texture columns
  // (m4Fixtures header). Both views see the FAR room wall through holes.
  { name: 'fixmask-fence', kind: 'fixture', fixtureMap: 'm4-mask', map: 'M4MASK', x: 128, y: 128, angleDeg: 0, script: 'M4MASK room A: E at the MASKFIX0 masked fence — parity holes must show the FAR wall (B side), opaque columns never black' },
  { name: 'fixmask-back', kind: 'fixture', fixtureMap: 'm4-mask', map: 'M4MASK', x: 384, y: 128, angleDeg: 180, script: 'M4MASK room B: W at the same fence from the other side — symmetric masked-range path, far wall A through the holes' },
  // SKYFIX: room A ceiling F_SKY1 at light 32 — with the synth dimming
  // tables every NON-sky byte scales down, sky bytes must not (planes.ts
  // sky branch pins colormaps[0], "Sky is allways full bright").
  { name: 'fixsky-room', kind: 'fixture', fixtureMap: 'm4-sky', map: 'M4SKY', x: 256, y: 256, angleDeg: 90, script: 'M4SKY light-32 sky room: N — F_SKY1 band fullbright under the DIMMING colormap rows (sky light-immunity evidence)' },
  { name: 'fixsky-seam', kind: 'fixture', fixtureMap: 'm4-sky', map: 'M4SKY', x: 64, y: 256, angleDeg: 0, script: 'M4SKY: E along the room — the sky plane meets the far wall TOP at the worldhigh seam (plan §6 horizon-seam stress: skytexturemid 1:1 tie)' },
  // THINGSFIX ring seen OFF-centre (the centre view is rot-symmetric
  // slot-4 ⇒ no flips): six BAR1 in the FOV — slots 0/2/3/4/5 with the
  // XY-mirror flips flagged in the script (per-thing rot math above).
  { name: 'fixthings-flip', kind: 'fixture', fixtureMap: 'm4-things', map: 'M4THNG', x: 64, y: 256, angleDeg: 0, script: 'M4THNG: E from the west edge — near BAR1 dead ahead (slot 0 A1), ring BAR1s at slots 2/3/5 FLIPPED + slot 4, pair BAR1 slot 5 flipped: octants + XY mirrors in one frame' },
  // PANFIX: room A sidedefs carry textureoffset 40 (+rowoffset 8 bytes),
  // room C sidedefs rowoffset 24 ONLY (renderer-blind ⇒ looks unpanned —
  // pinned truth, m4Fixtures header).
  { name: 'fixpan-panned', kind: 'fixture', fixtureMap: 'm4-pan', map: 'M4PAN', x: 128, y: 128, angleDeg: 90, script: 'M4PAN room A (L0): N at the textureoffset-40 sidedef — FIXWALL0 columns shifted 40 px-texels vs the unpanned fix-a-n; rowoffset 8 IGNORED (pinned)' },
  { name: 'fixpan-rowskip', kind: 'fixture', fixtureMap: 'm4-pan', map: 'M4PAN', x: 128, y: 384, angleDeg: 0, script: 'M4PAN room C (L255): E at the rowoffset-24-only sidedef — renders UNpanned (rdata consumes textureoffset only); the SIDEDEFS bytes round-trip is mapBuilder.test.ts territory' }
];

const e1m1Scenes: readonly Viewpoint[] = [
  { name: 'e1m1-spawn-east', kind: 'iwad', map: 'E1M1', x: -416, y: 256, angleDeg: 0, script: 'thing type 1 spawn, E down the tech corridor (M3-07 pinned vista)' },
  { name: 'e1m1-corner-dm14', kind: 'iwad', map: 'E1M1', x: 2008, y: 480, angleDeg: 135, script: 'deathmatch start (2008,480) in sector 124 (f24/c384 L220), SW corner of the tall room' },
  { name: 'e1m1-corner-ruin', kind: 'iwad', map: 'E1M1', x: 2500, y: 1700, angleDeg: 225, script: 'sector 5 (f192/c336) ruin ledge, SW at the corner box' },
  { name: 'e1m1-atrium', kind: 'iwad', map: 'E1M1', x: 1472, y: 1088, angleDeg: 270, script: 'atrium hall sector 173 (f -168/c536 L224), W across the 704-tall volume' },
  { name: 'e1m1-doorway-midtex', kind: 'iwad', map: 'E1M1', x: 1216, y: 1540, angleDeg: 270, script: 'sector 27 ledge S at linedef 80 METAL5 masked doorway (midtex frame)' },
  { name: 'e1m1-vista-corridor', kind: 'iwad', map: 'E1M1', x: 960, y: -192, angleDeg: 0, script: 'sector 57 south corridor, E along the >4000-unit straight run (far scalelight diminishing)' },
  { name: 'e1m1-corridor-open', kind: 'iwad', map: 'E1M1', x: 1050, y: -30, angleDeg: 180, script: 'sector 149 both-open tech corridor, W back along the two-sided flank openings' },
  { name: 'e1m1-busy-yard', kind: 'iwad', map: 'E1M1', x: 2400, y: 1152, angleDeg: 180, script: 'sector 181 (f48/c536) W into the ruin-yard span soup (solidsegs stress; hom/dso stay 0 — no re-pick needed)' },
  // M4-08 additions (analytic derivations in this file header).
  { name: 'e1m1-court-sky', kind: 'iwad', map: 'E1M1', x: -608, y: 240, angleDeg: 225, script: 'spawn courtyard sec 29 (F_SKY1 f0/c128 L128) from INSIDE, SW — sky fills the band above the ring walls (removed-SKY1 diff ≈ 37.6k px); no sprites in the centre cone' },
  { name: 'e1m1-court-things', kind: 'iwad', map: 'E1M1', x: -416, y: 256, angleDeg: 180, script: 'thing type 1 spawn, W at the courtyard — TRE2 grove (5 sprite columns ≈96/133/160/171/204) + BON1/STIM/corpse statics + sky sliver above the courtyard wall' },
  { name: 'e1m1-yard-fenced', kind: 'iwad', map: 'E1M1', x: 2224, y: 1323, angleDeg: 90, script: 'sky yard sec 23 (f40/c536 L224) centre, N through the MC18/MC17/ASHWALL fence lines — masked spans overlap 10 static sprite columns (TRE/SMIT/BON1)' },
  { name: 'e1m1-busy-mix', kind: 'iwad', map: 'E1M1', x: 2200, y: 917, angleDeg: 225, script: 'sky yard sec 39 (f-80/c536 L240) centre, SW — masked shells + BAR1/COLU/TRE statics + sky sliver in one busy frame (all counters 0)' }
];

export const VIEWPOINTS: readonly Viewpoint[] = [...fixScenes, ...m4FixScenes, ...e1m1Scenes];

/* ------------------------------------------------------------------ */
/* Deterministic fixture texture + light sources (no wad needed)        */
/* ------------------------------------------------------------------ */

/** Fixture wall-column generator (M3-07 renderer.test.ts pattern): values
 * avoid 0 (black) so every drawn column is measurable, and span a wide
 * range so the colormap buckets + pancake ±1 are visible in the shas. */
export function fixTexValue(col: number, row: number): number {
  return ((col * 16 + row) % 200) + 32; // 32..231
}

/** Synthetic COLORMAP rows (34×256) for the FIXTURE scenes: row 0 is the
 * identity and row k scales every non-black index by (32-k)/32 with a
 * floor of 1 — vanilla COLORMAP's "slide toward black, dimmest grays
 * survive" shape as an own deterministic generator (the fixture wad
 * carries no COLORMAP lump; the floor keeps every DRAWN pixel > 0 so
 * dark-room buckets stay measurable in the golden histograms).
 * Rows 32..33 clone row 31 (unused: walls consume scalelight rows
 * 0..31 only). NB: vanilla's scalelight startmap saturates to row 31 for
 * lightnum ≤ 6 — light 0 and 96 rooms ARE near-black up close; that is
 * the faithful bucket behaviour the goldens pin, not a bug. */
export function synthColormapRows(): Uint8Array {
  const rows = new Uint8Array(34 * 256);
  for (let k = 0; k < 32; k++) {
    for (let v = 0; v < 256; v++) {
      rows[k * 256 + v] = k === 0 || v === 0 ? v : Math.max(1, Math.round((v * (32 - k)) / 32));
    }
  }
  rows.set(rows.subarray(31 * 256, 32 * 256), 32 * 256);
  rows.set(rows.subarray(31 * 256, 32 * 256), 33 * 256);
  return rows;
}

/** PNG-review palette for fixture scenes: identity gray ramp (index → rgb).
 * iwad scenes use PLAYPAL palette 0 (decoded from the wad) instead. */
export function grayRampPalette(): number[] {
  const out: number[] = [];
  for (let v = 0; v < 256; v++) out.push(v, v, v);
  return out;
}

/** Degrees → BAM exactly like src/debug.ts degToBam (floored on the
 * 2^32 circle — the warp convention the e2e cross-check reuses). */
export function degToBam(deg: number): number {
  const d = ((deg % 360) + 360) % 360;
  return Math.floor((d / 360) * 4294967296) >>> 0;
}
