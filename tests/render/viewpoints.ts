/**
 * tests/render/viewpoints.ts — M3-08 shared viewpoint scene table
 * (docs/design/M3-plan.md §M3-08): the ≥20 golden viewpoints consumed by
 * tests/render/walls.test.ts (and the iwad half by e2e/walls.spec.ts).
 *
 * Two scene families:
 *  - 12 FIXMAP scenes on the WALLFIX fixture (4 rooms × 3 viewpoints), and
 *  - 8 freedoom1 E1M1 scenes (skipIf no wad in the vitest suite).
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
  readonly name: string;
  readonly kind: 'fixture' | 'iwad';
  /** Human-readable setup script, mirrored into meta.json for review. */
  readonly script: string;
  readonly map: 'WALLFIX' | 'E1M1';
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

const e1m1Scenes: readonly Viewpoint[] = [
  { name: 'e1m1-spawn-east', kind: 'iwad', map: 'E1M1', x: -416, y: 256, angleDeg: 0, script: 'thing type 1 spawn, E down the tech corridor (M3-07 pinned vista)' },
  { name: 'e1m1-corner-dm14', kind: 'iwad', map: 'E1M1', x: 2008, y: 480, angleDeg: 135, script: 'deathmatch start (2008,480) in sector 124 (f24/c384 L220), SW corner of the tall room' },
  { name: 'e1m1-corner-ruin', kind: 'iwad', map: 'E1M1', x: 2500, y: 1700, angleDeg: 225, script: 'sector 5 (f192/c336) ruin ledge, SW at the corner box' },
  { name: 'e1m1-atrium', kind: 'iwad', map: 'E1M1', x: 1472, y: 1088, angleDeg: 270, script: 'atrium hall sector 173 (f -168/c536 L224), W across the 704-tall volume' },
  { name: 'e1m1-doorway-midtex', kind: 'iwad', map: 'E1M1', x: 1216, y: 1540, angleDeg: 270, script: 'sector 27 ledge S at linedef 80 METAL5 masked doorway (midtex frame)' },
  { name: 'e1m1-vista-corridor', kind: 'iwad', map: 'E1M1', x: 960, y: -192, angleDeg: 0, script: 'sector 57 south corridor, E along the >4000-unit straight run (far scalelight diminishing)' },
  { name: 'e1m1-corridor-open', kind: 'iwad', map: 'E1M1', x: 1050, y: -30, angleDeg: 180, script: 'sector 149 both-open tech corridor, W back along the two-sided flank openings' },
  { name: 'e1m1-busy-yard', kind: 'iwad', map: 'E1M1', x: 2400, y: 1152, angleDeg: 180, script: 'sector 181 (f48/c536) W into the ruin-yard span soup (solidsegs stress; hom/dso stay 0 — no re-pick needed)' }
];

export const VIEWPOINTS: readonly Viewpoint[] = [...fixScenes, ...e1m1Scenes];

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
