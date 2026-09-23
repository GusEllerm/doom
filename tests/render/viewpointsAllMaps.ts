/**
 * tests/render/viewpointsAllMaps.ts — every-E1-map golden viewpoint table
 * (M12-plan §M12-02: >= 8 analytically-derived viewpoints x 9 E1 maps — the
 * L3 every-map corpus consumed by tests/render/allMaps.test.ts; the same
 * buffers tile the docs/reports/M12-montage.md contact sheets, D016).
 *
 * DERIVATION DISCIPLINE (M4-08 rules — no screenshot peeking, ever): every
 * coordinate is derived from pinned-WAD map structure (THINGS/LINEDEFS/
 * SIDEDEFS/SECTORS/VERTEXES + the NODES/SSECTORS/SEGS BSP, i.e. exactly the
 * map data the M12-01 census JSON describes, parsed straight from the
 * lumps). Point membership = R_PointInSubsector (port-twin traversal of
 * pointOnSideXY/bspSubsectorAt semantics) — a standoff lands ONLY where the
 * BSP-resolved sector has ceiling-floor >= 88 AND light >= 48; centroid
 * views walk back toward a ring vertex until the BSP agrees. Frames are
 * never chosen by looking at frames: the argmax-contrast angle = argmax
 * over 8 cones of boundary-line coverage weighted by height/light delta +
 * midtex bonus. Families, in placement order:
 *   spawn      THINGS type-1 player start; angle = the designer thing angle.
 *   spawn-alt  same spot faced +180 (pure angle arithmetic).
 *   keydoor    keydoor-N  standoff perpendicular from the two longest KEY-door lines
 *              (specials 26/27/28 card, 31/32/117 card+lock), facing them.
 *   exit       exit       standoff from the longest exit line (special 11/19/138).
 *   secret     Freedoom Phase 1 DATA TRUTH: ZERO sectors carry the 0x40
 *              secret BIT in any E1 map (sector-special unions {1..17},
 *              census §0.2) — so the secret family derives from the
 *              secret-DOOR linedefs instead: 125/126 (secret tag) +
 *              102/103 (blind door). Maps with neither (E1M1, E1M6, E1M8)
 *              fall back to far-nook; every E1 secret AREA is reached by a
 *              secret-door-line vantage where one exists.
 *   far-nook   farthest lit sector from spawn (centroid), walk-back point.
 *   tall       tallest non-sky sector; bright = brightest medium sector;
 *   busy       sector holding the most THINGS (all: in-sector rep point,
 *              argmax-contrast angle).
 *   masked     standoff facing a wide masked (mid-texture) two-sided line.
 *   door/lift  plain door line (1/2/23); lift = stair/lift line (60-63/68).
 *   corridor   corridor   elongated lit sector (bbox > 1200 on one axis only), end
 *              standoff on the long axis (far-column scalelight stress).
 * Density: >= 8 per map (plan gate) — 11-14 exist per map, 117 total; the
 * per-map counts are asserted in allMaps.test.ts.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

export interface MapViewpoint {
  /** golden scene name, e.g. "e1m1-spawn". */
  readonly name: string;
  /** map lump name the viewpoint stands on. */
  readonly map: string;
  readonly x: number;
  readonly y: number;
  /** degrees (0=E, 90=N) → BAM via viewpoints.ts degToBam. */
  readonly angleDeg: number;
  /** derivation evidence: the exact sector/linedef ids + geometry cited. */
  readonly note: string;
}

export const MAP_VIEWS: readonly MapViewpoint[] = [
  /* ---- E1M1 (13 views) ---- */
  { name: 'e1m1-spawn', map: 'E1M1', x: -416, y: 256, angleDeg: 0, note: 'player1 start thing, designer angle; stand: BSP sec140 L192 f0/c128 AQF054/SLIME14' },
  { name: 'e1m1-spawn-alt', map: 'E1M1', x: -416, y: 256, angleDeg: 180, note: 'player1 start thing, designer angle; stand: BSP sec140 L192 f0/c128 AQF054/SLIME14' },
  { name: 'e1m1-keydoor-0', map: 'E1M1', x: 832, y: 1608, angleDeg: 270, note: 'ln421 sp26 standoff perpendicular, facing the line; stand: BSP sec87 L192 f-136/c8 AQF070/AQF012' },
  { name: 'e1m1-keydoor-1', map: 'E1M1', x: 832, y: 1368, angleDeg: 90, note: 'ln423 sp26 standoff perpendicular, facing the line; stand: BSP sec56 L128 f-128/c64 FLOOR5_2/SLIME14' },
  { name: 'e1m1-exit', map: 'E1M1', x: -304, y: 1296, angleDeg: 180, note: 'ln407 sp11 standoff perpendicular, facing the line; stand: BSP sec66 L160 f-128/c8 FLAT5_4/FLAT1' },
  { name: 'e1m1-far-nook', map: 'E1M1', x: 3018, y: 2138, angleDeg: 225, note: 'sec7 centroid walk-back, argmax-contrast angle; stand: BSP sec7 L160 f184/c304 MFLR8_3/MFLR8_3' },
  { name: 'e1m1-tall', map: 'E1M1', x: 1207, y: 853, angleDeg: 270, note: 'sec0 centroid walk-back, argmax-contrast angle; stand: BSP sec0 L202 f-160/c376 RROCK18/CEIL5_1' },
  { name: 'e1m1-bright', map: 'E1M1', x: 2537, y: 605, angleDeg: 225, note: 'sec124 centroid walk-back, argmax-contrast angle; stand: BSP sec124 L220 f24/c384 RROCK18/RROCK17' },
  { name: 'e1m1-busy', map: 'E1M1', x: 2203, y: -201, angleDeg: 135, note: 'sec134 n=21 centroid walk-back, argmax-contrast angle; stand: BSP sec134 L160 f136/c264 CEIL5_1/FLAT1' },
  { name: 'e1m1-masked', map: 'E1M1', x: 2024, y: 1413, angleDeg: 216, note: 'ln1 midtex standoff perpendicular, facing the line; stand: BSP sec7 L160 f184/c304 MFLR8_3/MFLR8_3' },
  { name: 'e1m1-door', map: 'E1M1', x: 2160, y: -416, angleDeg: 180, note: 'ln998 sp2 standoff perpendicular, facing the line; stand: BSP sec120 L192 f128/c272 FWATER1/NUKAGE1' },
  { name: 'e1m1-lift', map: 'E1M1', x: 1428, y: -376, angleDeg: 270, note: 'ln1075 sp62 standoff perpendicular, facing the line; stand: BSP sec144 L160 f-8/c296 AQF024/FWATER1' },
  { name: 'e1m1-corridor-0', map: 'E1M1', x: 880, y: 1808, angleDeg: 0, note: 'corridor sec87 elongated lit sector, end standoff on the long axis; stand: BSP sec87 L192 f-136/c8 AQF070/AQF012' },
  /* ---- E1M2 (12 views) ---- */
  { name: 'e1m2-spawn', map: 'E1M2', x: 608, y: 48, angleDeg: 270, note: 'player1 start thing, designer angle; stand: BSP sec182 L192 f0/c128 FLOOR4_1/CEIL3_5' },
  { name: 'e1m2-spawn-alt', map: 'E1M2', x: 608, y: 48, angleDeg: 90, note: 'player1 start thing, designer angle; stand: BSP sec182 L192 f0/c128 FLOOR4_1/CEIL3_5' },
  { name: 'e1m2-keydoor-0', map: 'E1M2', x: 1112, y: -160, angleDeg: 0, note: 'ln151 sp28 standoff perpendicular, facing the line; stand: BSP sec4 L208 f-8/c88 FLOOR0_3/FLAT5_5' },
  { name: 'e1m2-keydoor-1', map: 'E1M2', x: 832, y: -1408, angleDeg: 0, note: 'ln260 sp26 standoff perpendicular, facing the line; stand: BSP sec59 L144 f128/c256 FLAT5_4/FLAT1' },
  { name: 'e1m2-exit', map: 'E1M2', x: 1978, y: -2184, angleDeg: 264, note: 'ln1974 sp19 standoff perpendicular, facing the line; stand: BSP sec350 L224 f72/c200 FLAT14/FLAT14' },
  { name: 'e1m2-secret', map: 'E1M2', x: 584, y: -2520, angleDeg: 90, note: 'ln1854 sp103 standoff perpendicular, facing the line; stand: BSP sec263 L128 f64/c160 FLOOR4_8/CEIL3_5' },
  { name: 'e1m2-tall', map: 'E1M2', x: 1541, y: -10, angleDeg: 225, note: 'sec178 centroid walk-back, argmax-contrast angle; stand: BSP sec178 L178 f-1024/c-48 SLIME01/CEIL5_3' },
  { name: 'e1m2-bright', map: 'E1M2', x: 2136, y: -2240, angleDeg: 135, note: 'sec102 centroid walk-back, argmax-contrast angle; stand: BSP sec102 L224 f72/c200 FLAT14/FLAT14' },
  { name: 'e1m2-busy', map: 'E1M2', x: 216, y: -439, angleDeg: 315, note: 'sec8 n=13 centroid walk-back, argmax-contrast angle; stand: BSP sec8 L224 f0/c320 RROCK19/F_SKY1' },
  { name: 'e1m2-masked', map: 'E1M2', x: 664, y: -896, angleDeg: 90, note: 'ln0 midtex standoff perpendicular, facing the line; stand: BSP sec11 L144 f-8/c184 FLAT1/FLAT5_5' },
  { name: 'e1m2-door', map: 'E1M2', x: 720, y: -2784, angleDeg: 0, note: 'ln515 sp2 standoff perpendicular, facing the line; stand: BSP sec269 L144 f64/c320 FLOOR5_2/CEIL5_1' },
  { name: 'e1m2-lift', map: 'E1M2', x: 1472, y: -1408, angleDeg: 180, note: 'ln219 sp62 standoff perpendicular, facing the line; stand: BSP sec44 L128 f240/c368 STEP2/CEIL5_1' },
  /* ---- E1M3 (12 views) ---- */
  { name: 'e1m3-spawn', map: 'E1M3', x: -788, y: -216, angleDeg: 90, note: 'player1 start thing, designer angle; stand: BSP sec0 L180 f0/c120 FLOOR5_2/F_SKY1' },
  { name: 'e1m3-spawn-alt', map: 'E1M3', x: -788, y: -216, angleDeg: 270, note: 'player1 start thing, designer angle; stand: BSP sec0 L180 f0/c120 FLOOR5_2/F_SKY1' },
  { name: 'e1m3-keydoor-0', map: 'E1M3', x: -1024, y: 104, angleDeg: 180, note: 'ln708 sp31 standoff perpendicular, facing the line; stand: BSP sec5 L164 f0/c128 FLOOR5_2/CEIL5_2' },
  { name: 'e1m3-keydoor-1', map: 'E1M3', x: -1264, y: 104, angleDeg: 0, note: 'ln710 sp32 standoff perpendicular, facing the line; stand: BSP sec149 L160 f16/c104 FLOOR5_1/CEIL4_2' },
  { name: 'e1m3-exit', map: 'E1M3', x: -1296, y: 1004, angleDeg: 225, note: 'ln2024 sp138 standoff perpendicular, facing the line; stand: BSP sec22 L150 f56/c152 FLOOR5_1/CEIL3_5' },
  { name: 'e1m3-secret', map: 'E1M3', x: -952, y: 2152, angleDeg: 270, note: 'ln361 sp103 standoff perpendicular, facing the line; stand: BSP sec89 L150 f104/c288 FLOOR4_8/CEIL5_1' },
  { name: 'e1m3-tall', map: 'E1M3', x: -96, y: 123, angleDeg: 135, note: 'sec2 centroid walk-back, argmax-contrast angle; stand: BSP sec2 L164 f-104/c128 NUKAGE1/CEIL5_2' },
  { name: 'e1m3-bright', map: 'E1M3', x: -505, y: 1720, angleDeg: 225, note: 'sec64 centroid walk-back, argmax-contrast angle; stand: BSP sec64 L255 f-33/c23 FLOOR7_1/FLOOR7_1' },
  { name: 'e1m3-busy', map: 'E1M3', x: -508, y: 290, angleDeg: 135, note: 'sec5 n=21 centroid walk-back, argmax-contrast angle; stand: BSP sec5 L164 f0/c128 FLOOR5_2/CEIL5_2' },
  { name: 'e1m3-masked', map: 'E1M3', x: -768, y: 152, angleDeg: 270, note: 'ln6 midtex standoff perpendicular, facing the line; stand: BSP sec20 L196 f0/c168 FLOOR5_2/F_SKY1' },
  { name: 'e1m3-door', map: 'E1M3', x: -1144, y: 848, angleDeg: 270, note: 'ln149 sp1 standoff perpendicular, facing the line; stand: BSP sec22 L150 f56/c152 FLOOR5_1/CEIL3_5' },
  { name: 'e1m3-lift', map: 'E1M3', x: -1376, y: 1568, angleDeg: 90, note: 'ln261 sp62 standoff perpendicular, facing the line; stand: BSP sec34 L136 f0/c128 FLOOR4_8/CEIL5_1' },
  /* ---- E1M4 (14 views) ---- */
  { name: 'e1m4-spawn', map: 'E1M4', x: 896, y: -1760, angleDeg: 90, note: 'player1 start thing, designer angle; stand: BSP sec21 L160 f-8/c160 FLAT14/F_SKY1' },
  { name: 'e1m4-spawn-alt', map: 'E1M4', x: 896, y: -1760, angleDeg: 270, note: 'player1 start thing, designer angle; stand: BSP sec21 L160 f-8/c160 FLAT14/F_SKY1' },
  { name: 'e1m4-keydoor-0', map: 'E1M4', x: 1992, y: -704, angleDeg: 180, note: 'ln267 sp27 standoff perpendicular, facing the line; stand: BSP sec29 L135 f16/c144 FLOOR0_3/CEIL3_5' },
  { name: 'e1m4-keydoor-1', map: 'E1M4', x: 1752, y: -704, angleDeg: 0, note: 'ln272 sp27 standoff perpendicular, facing the line; stand: BSP sec27 L135 f8/c144 FLOOR0_3/CEIL3_5' },
  { name: 'e1m4-exit', map: 'E1M4', x: 704, y: 2136, angleDeg: 180, note: 'ln1996 sp11 standoff perpendicular, facing the line; stand: BSP sec141 L160 f-72/c56 FLOOR4_8/FLOOR4_8' },
  { name: 'e1m4-secret', map: 'E1M4', x: -1120, y: -832, angleDeg: 270, note: 'ln1892 sp126 standoff perpendicular, facing the line; stand: BSP sec46 L145 f-104/c24 FLAT19/FLAT1' },
  { name: 'e1m4-tall', map: 'E1M4', x: 637, y: -236, angleDeg: 180, note: 'sec151 centroid walk-back, argmax-contrast angle; stand: BSP sec151 L150 f-112/c160 NUKAGE1/CEIL5_2' },
  { name: 'e1m4-bright', map: 'E1M4', x: 1760, y: 813, angleDeg: 225, note: 'sec201 centroid walk-back, argmax-contrast angle; stand: BSP sec201 L208 f-240/c-128 FLOOR4_8/CEIL5_2' },
  { name: 'e1m4-busy', map: 'E1M4', x: -1705, y: -396, angleDeg: 45, note: 'sec233 n=27 centroid walk-back, argmax-contrast angle; stand: BSP sec233 L130 f-264/c-136 FLOOR4_6/FLAT1' },
  { name: 'e1m4-masked', map: 'E1M4', x: 896, y: -1344, angleDeg: 270, note: 'ln1 midtex standoff perpendicular, facing the line; stand: BSP sec1 L130 f0/c144 FLOOR0_3/CEIL3_5' },
  { name: 'e1m4-door', map: 'E1M4', x: 64, y: -488, angleDeg: 270, note: 'ln79 sp1 standoff perpendicular, facing the line; stand: BSP sec6 L135 f16/c144 FLOOR0_3/CEIL3_5' },
  { name: 'e1m4-lift', map: 'E1M4', x: -576, y: -704, angleDeg: 180, note: 'ln326 sp62 standoff perpendicular, facing the line; stand: BSP sec33 L165 f0/c160 STEP1/F_SKY1' },
  { name: 'e1m4-corridor-0', map: 'E1M4', x: 126, y: 1600, angleDeg: 90, note: 'corridor sec184 elongated lit sector, end standoff on the long axis; stand: BSP sec184 L140 f-64/c64 CEIL5_2/CEIL3_5' },
  { name: 'e1m4-corridor-1', map: 'E1M4', x: -955, y: 496, angleDeg: 90, note: 'corridor sec34 elongated lit sector, end standoff on the long axis; stand: BSP sec34 L165 f-256/c160 FLOOR0_1/F_SKY1' },
  /* ---- E1M5 (14 views) ---- */
  { name: 'e1m5-spawn', map: 'E1M5', x: -4768, y: 1296, angleDeg: 0, note: 'player1 start thing, designer angle; stand: BSP sec5 L256 f-16/c56 FLOOR5_2/FLAT2' },
  { name: 'e1m5-spawn-alt', map: 'E1M5', x: -4768, y: 1296, angleDeg: 180, note: 'player1 start thing, designer angle; stand: BSP sec5 L256 f-16/c56 FLOOR5_2/FLAT2' },
  { name: 'e1m5-keydoor-0', map: 'E1M5', x: -3312, y: 1440, angleDeg: 180, note: 'ln1156 sp31 standoff perpendicular, facing the line; stand: BSP sec7 L176 f-16/c120 FLOOR5_2/CEIL3_3' },
  { name: 'e1m5-keydoor-1', map: 'E1M5', x: -3536, y: 1440, angleDeg: 0, note: 'ln1171 sp31 standoff perpendicular, facing the line; stand: BSP sec13 L192 f-16/c240 FLOOR5_2/F_SKY1' },
  { name: 'e1m5-exit', map: 'E1M5', x: -992, y: 1088, angleDeg: 180, note: 'ln634 sp11 standoff perpendicular, facing the line; stand: BSP sec56 L192 f-16/c176 FLOOR4_8/FLAT19' },
  { name: 'e1m5-secret', map: 'E1M5', x: -1408, y: 1088, angleDeg: 0, note: 'ln633 sp126 standoff perpendicular, facing the line; stand: BSP sec60 L144 f-32/c112 SLIME01/CEIL5_2' },
  { name: 'e1m5-tall', map: 'E1M5', x: 352, y: 1440, angleDeg: 180, note: 'sec82 centroid walk-back, argmax-contrast angle; stand: BSP sec82 L256 f-40/c208 FLOOR4_1/TLITE6_6' },
  { name: 'e1m5-bright', map: 'E1M5', x: -2656, y: 1440, angleDeg: 0, note: 'sec1 centroid walk-back, argmax-contrast angle; stand: BSP sec1 L256 f-16/c176 FLOOR5_2/TLITE6_6' },
  { name: 'e1m5-busy', map: 'E1M5', x: -861, y: 699, angleDeg: 0, note: 'sec56 n=28 centroid walk-back, argmax-contrast angle; stand: BSP sec56 L192 f-16/c176 FLOOR4_8/FLAT19' },
  { name: 'e1m5-masked', map: 'E1M5', x: -768, y: 416, angleDeg: 180, note: 'ln4 midtex standoff perpendicular, facing the line; stand: BSP sec56 L192 f-16/c176 FLOOR4_8/FLAT19' },
  { name: 'e1m5-door', map: 'E1M5', x: 1472, y: 1008, angleDeg: 90, note: 'ln1202 sp1 standoff perpendicular, facing the line; stand: BSP sec127 L192 f-32/c112 FLAT3/CEIL3_3' },
  { name: 'e1m5-lift', map: 'E1M5', x: 1472, y: 1728, angleDeg: 90, note: 'ln654 sp62 standoff perpendicular, facing the line; stand: BSP sec76 L192 f-16/c112 FLOOR4_8/FLAT19' },
  { name: 'e1m5-corridor-0', map: 'E1M5', x: 1072, y: -281, angleDeg: 0, note: 'corridor sec163 elongated lit sector, end standoff on the long axis; stand: BSP sec163 L192 f72/c208 CEIL4_1/FLAT19' },
  { name: 'e1m5-corridor-1', map: 'E1M5', x: -1584, y: 1440, angleDeg: 180, note: 'corridor sec86 elongated lit sector, end standoff on the long axis; stand: BSP sec86 L192 f-16/c112 FLOOR4_8/FLAT19' },
  /* ---- E1M6 (14 views) ---- */
  { name: 'e1m6-spawn', map: 'E1M6', x: 0, y: -160, angleDeg: 90, note: 'player1 start thing, designer angle; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3' },
  { name: 'e1m6-spawn-alt', map: 'E1M6', x: 0, y: -160, angleDeg: 270, note: 'player1 start thing, designer angle; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3' },
  { name: 'e1m6-keydoor-0', map: 'E1M6', x: -912, y: 1024, angleDeg: 0, note: 'ln118 sp28 standoff perpendicular, facing the line; stand: BSP sec140 L176 f0/c192 FLOOR5_4/FLOOR0_6' },
  { name: 'e1m6-keydoor-1', map: 'E1M6', x: 1920, y: 480, angleDeg: 180, note: 'ln603 sp32 standoff perpendicular, facing the line; stand: BSP sec232 L208 f-72/c64 FLAT18/CEIL5_2' },
  { name: 'e1m6-exit', map: 'E1M6', x: -744, y: -80, angleDeg: 0, note: 'ln1546 sp11 standoff perpendicular, facing the line; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3' },
  { name: 'e1m6-secret', map: 'E1M6', x: 1000, y: 480, angleDeg: 180, note: 'ln1464 sp103 standoff perpendicular, facing the line; stand: BSP sec237 L208 f-72/c96 FLAT18/FLAT14' },
  { name: 'e1m6-tall', map: 'E1M6', x: -1818, y: -1677, angleDeg: 45, note: 'sec178 centroid walk-back, argmax-contrast angle; stand: BSP sec178 L192 f-512/c128 NUKAGE1/FLOOR0_6' },
  { name: 'e1m6-bright', map: 'E1M6', x: -780, y: 1351, angleDeg: 315, note: 'sec263 centroid walk-back, argmax-contrast angle; stand: BSP sec263 L224 f72/c176 FLOOR0_3/FLAT5_4' },
  { name: 'e1m6-busy', map: 'E1M6', x: -801, y: -519, angleDeg: 45, note: 'sec151 n=125 centroid walk-back, argmax-contrast angle; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3' },
  { name: 'e1m6-masked', map: 'E1M6', x: 296, y: -296, angleDeg: 135, note: 'ln1 midtex standoff perpendicular, facing the line; stand: BSP sec151 L160 f-192/c-32 FLOOR4_8/FLOOR0_3' },
  { name: 'e1m6-door', map: 'E1M6', x: 992, y: 528, angleDeg: 90, note: 'ln1110 sp1 standoff perpendicular, facing the line; stand: BSP sec154 L160 f-72/c96 FLAT18/FLAT14' },
  { name: 'e1m6-lift', map: 'E1M6', x: -736, y: 448, angleDeg: 270, note: 'ln512 sp62 standoff perpendicular, facing the line; stand: BSP sec363 L192 f0/c384 STEP2/CEIL3_5' },
  { name: 'e1m6-corridor-0', map: 'E1M6', x: -2313, y: -2416, angleDeg: 270, note: 'corridor sec193 elongated lit sector, end standoff on the long axis; stand: BSP sec193 L224 f-384/c0 NUKAGE1/F_SKY1' },
  { name: 'e1m6-corridor-1', map: 'E1M6', x: 459, y: 880, angleDeg: 90, note: 'corridor sec59 elongated lit sector, end standoff on the long axis; stand: BSP sec59 L224 f-32/c288 MFLR8_2/F_SKY1' },
  /* ---- E1M7 (14 views) ---- */
  { name: 'e1m7-spawn', map: 'E1M7', x: 0, y: -232, angleDeg: 90, note: 'player1 start thing, designer angle; stand: BSP sec16 L192 f0/c96 FLAT14/CEIL5_2' },
  { name: 'e1m7-spawn-alt', map: 'E1M7', x: 0, y: -232, angleDeg: 270, note: 'player1 start thing, designer angle; stand: BSP sec16 L192 f0/c96 FLAT14/CEIL5_2' },
  { name: 'e1m7-keydoor-0', map: 'E1M7', x: -504, y: 896, angleDeg: 0, note: 'ln130 sp27 standoff perpendicular, facing the line; stand: BSP sec693 L192 f0/c128 RROCK03/RROCK03' },
  { name: 'e1m7-keydoor-1', map: 'E1M7', x: -256, y: 896, angleDeg: 180, note: 'ln131 sp27 standoff perpendicular, facing the line; stand: BSP sec73 L160 f32/c176 FLAT19/FLAT19' },
  { name: 'e1m7-exit', map: 'E1M7', x: -936, y: 704, angleDeg: 180, note: 'ln3975 sp11 standoff perpendicular, facing the line; stand: BSP sec376 L192 f-256/c160 FLOOR6_2/F_SKY1' },
  { name: 'e1m7-secret', map: 'E1M7', x: -416, y: 1632, angleDeg: 90, note: 'ln283 sp103 standoff perpendicular, facing the line; stand: BSP sec33 L144 f8/c144 FLOOR4_8/MFLR8_1' },
  { name: 'e1m7-tall', map: 'E1M7', x: 3153, y: 663, angleDeg: 135, note: 'sec229 centroid walk-back, argmax-contrast angle; stand: BSP sec229 L144 f-248/c256 NUKAGE1/CEIL3_5' },
  { name: 'e1m7-bright', map: 'E1M7', x: 1408, y: 2816, angleDeg: 315, note: 'sec592 centroid walk-back, argmax-contrast angle; stand: BSP sec592 L255 f296/c360 CEIL3_5/CEIL3_5' },
  { name: 'e1m7-busy', map: 'E1M7', x: -989, y: 2191, angleDeg: 315, note: 'sec456 n=24 centroid walk-back, argmax-contrast angle; stand: BSP sec456 L208 f0/c144 TLITE6_5/MFLR8_1' },
  { name: 'e1m7-masked', map: 'E1M7', x: 0, y: 256, angleDeg: 270, note: 'ln3 midtex standoff perpendicular, facing the line; stand: BSP sec5 L192 f0/c128 SLIME13/FLAT1' },
  { name: 'e1m7-door', map: 'E1M7', x: 0, y: -40, angleDeg: 90, note: 'ln19 sp1 standoff perpendicular, facing the line; stand: BSP sec0 L192 f0/c128 FLAT14/FLAT23' },
  { name: 'e1m7-lift', map: 'E1M7', x: 1984, y: 1152, angleDeg: 270, note: 'ln645 sp62 standoff perpendicular, facing the line; stand: BSP sec627 L160 f-24/c72 FLOOR0_3/FLAT3' },
  { name: 'e1m7-corridor-0', map: 'E1M7', x: 619, y: -1056, angleDeg: 270, note: 'corridor sec147 elongated lit sector, end standoff on the long axis; stand: BSP sec147 L192 f-96/c160 CEIL5_2/F_SKY1' },
  { name: 'e1m7-corridor-1', map: 'E1M7', x: -1261, y: -816, angleDeg: 270, note: 'corridor sec376 elongated lit sector, end standoff on the long axis; stand: BSP sec376 L192 f-256/c160 FLOOR6_2/F_SKY1' },
  /* ---- E1M8 (11 views) ---- */
  { name: 'e1m8-spawn', map: 'E1M8', x: 2464, y: 360, angleDeg: 270, note: 'player1 start thing, designer angle; stand: BSP sec83 L224 f-136/c256 STEP1/F_SKY1' },
  { name: 'e1m8-spawn-alt', map: 'E1M8', x: 2464, y: 360, angleDeg: 90, note: 'player1 start thing, designer angle; stand: BSP sec83 L224 f-136/c256 STEP1/F_SKY1' },
  { name: 'e1m8-keydoor-0', map: 'E1M8', x: 3232, y: -704, angleDeg: 90, note: 'ln868 sp31 standoff perpendicular, facing the line; stand: BSP sec93 L224 f24/c168 SLIME13/SLIME13' },
  { name: 'e1m8-exit', map: 'E1M8', x: -124, y: 316, angleDeg: 135, note: 'ln894 sp19 standoff perpendicular, facing the line; stand: BSP sec17 L224 f-16/c256 MFLR8_2/F_SKY1' },
  { name: 'e1m8-far-nook', map: 'E1M8', x: 132, y: -1212, angleDeg: 45, note: 'sec39 centroid walk-back, argmax-contrast angle; stand: BSP sec39 L128 f0/c112 FLOOR7_2/FLOOR6_2' },
  { name: 'e1m8-tall', map: 'E1M8', x: 928, y: -1575, angleDeg: 135, note: 'sec32 centroid walk-back, argmax-contrast angle; stand: BSP sec32 L160 f-8/c200 CEIL5_2/FLOOR7_2' },
  { name: 'e1m8-bright', map: 'E1M8', x: 3228, y: -1688, angleDeg: 135, note: 'sec93 centroid walk-back, argmax-contrast angle; stand: BSP sec93 L224 f24/c168 SLIME13/SLIME13' },
  { name: 'e1m8-busy', map: 'E1M8', x: 2464, y: 320, angleDeg: 180, note: 'sec83 n=8 centroid walk-back, argmax-contrast angle; stand: BSP sec83 L224 f-136/c256 STEP1/F_SKY1' },
  { name: 'e1m8-masked', map: 'E1M8', x: -139, y: -9, angleDeg: 336, note: 'ln20 midtex standoff perpendicular, facing the line; stand: BSP sec17 L224 f-16/c256 MFLR8_2/F_SKY1' },
  { name: 'e1m8-corridor-0', map: 'E1M8', x: 1584, y: 50, angleDeg: 180, note: 'corridor sec54 elongated lit sector, end standoff on the long axis; stand: BSP sec54 L224 f0/c256 RROCK19/F_SKY1' },
  { name: 'e1m8-corridor-1', map: 'E1M8', x: -464, y: 21, angleDeg: 180, note: 'corridor sec7 elongated lit sector, end standoff on the long axis; stand: BSP sec7 L224 f0/c256 MFLR8_2/F_SKY1' },
  /* ---- E1M9 (13 views) ---- */
  { name: 'e1m9-spawn', map: 'E1M9', x: -216, y: -160, angleDeg: 180, note: 'player1 start thing, designer angle; stand: BSP sec2 L192 f-8/c104 FLAT5/CEIL3_4' },
  { name: 'e1m9-spawn-alt', map: 'E1M9', x: -216, y: -160, angleDeg: 0, note: 'player1 start thing, designer angle; stand: BSP sec2 L192 f-8/c104 FLAT5/CEIL3_4' },
  { name: 'e1m9-keydoor-0', map: 'E1M9', x: -416, y: 648, angleDeg: 270, note: 'ln46 sp31 standoff perpendicular, facing the line; stand: BSP sec19 L176 f-72/c184 FLAT10/CEIL3_3' },
  { name: 'e1m9-keydoor-1', map: 'E1M9', x: -416, y: 400, angleDeg: 90, note: 'ln87 sp31 standoff perpendicular, facing the line; stand: BSP sec10 L176 f-72/c56 FLAT10/CEIL3_3' },
  { name: 'e1m9-exit', map: 'E1M9', x: 1312, y: 720, angleDeg: 270, note: 'ln1662 sp11 standoff perpendicular, facing the line; stand: BSP sec59 L144 f-8/c136 FLOOR0_3/MFLR8_1' },
  { name: 'e1m9-secret', map: 'E1M9', x: 8, y: 2960, angleDeg: 90, note: 'ln883 sp103 standoff perpendicular, facing the line; stand: BSP sec163 L160 f120/c232 FLOOR0_5/CEIL3_5' },
  { name: 'e1m9-tall', map: 'E1M9', x: 1203, y: 2328, angleDeg: 225, note: 'sec145 centroid walk-back, argmax-contrast angle; stand: BSP sec145 L176 f-96/c264 NUKAGE1/CEIL3_5' },
  { name: 'e1m9-bright', map: 'E1M9', x: 1634, y: 1826, angleDeg: 180, note: 'sec114 centroid walk-back, argmax-contrast angle; stand: BSP sec114 L240 f40/c168 FLOOR0_3/CEIL3_5' },
  { name: 'e1m9-busy', map: 'E1M9', x: -948, y: 3143, angleDeg: 315, note: 'sec264 n=23 centroid walk-back, argmax-contrast angle; stand: BSP sec264 L160 f112/c240 FLAT5/CEIL3_5' },
  { name: 'e1m9-masked', map: 'E1M9', x: -352, y: -160, angleDeg: 0, note: 'ln1 midtex standoff perpendicular, facing the line; stand: BSP sec1 L176 f-8/c104 FLAT5/CEIL3_3' },
  { name: 'e1m9-door', map: 'E1M9', x: 928, y: 1536, angleDeg: 180, note: 'ln344 sp1 standoff perpendicular, facing the line; stand: BSP sec106 L160 f-72/c184 FLAT5/CEIL3_5' },
  { name: 'e1m9-lift', map: 'E1M9', x: 1056, y: 3440, angleDeg: 180, note: 'ln951 sp62 standoff perpendicular, facing the line; stand: BSP sec194 L160 f-104/c120 FLAT5/F_SKY1' },
  { name: 'e1m9-corridor-0', map: 'E1M9', x: -368, y: 1484, angleDeg: 180, note: 'corridor sec60 elongated lit sector, end standoff on the long axis; stand: BSP sec60 L160 f-72/c208 FLAT5/F_SKY1' },
];

/** E1 map order (plan §0.1). */
export const MAP_NAMES = ['E1M1','E1M2','E1M3','E1M4','E1M5','E1M6','E1M7','E1M8','E1M9'] as const;
