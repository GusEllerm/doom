/**
 * M9-11 — L3 golden corpus: statusbar + message strip + viewport pair
 * (plan §M9-11, goldens set `m9`).
 *
 * Every scene is a FULL 320×200 production frame composed by displayFrame
 * (the same rAF-frame driver main.ts runs: gFlowTic/gTicker/HU/ST tickers,
 * then the D_Display draw order incl. the sb9 windowed crop + FLOOR7_2/
 * brdr borders) over the pinned E1M1 — captured twice per goldenScene
 * (byte-equal) with HOM=0 asserted on every 3D+bar frame.
 *
 * a) BAR — the 8-variant matrix: health tiers × face states × keys ×
 *    weapon/ammo widgets, scripted through the LIVE player object the
 *    face machine reads (st_stuff.c:752-905 rules): pain tiers 0..3,
 *    evil grin (R2), attacked turn (R3), god face (R6), dead (R1).
 * b) MSG — the HU message strip: shown / held / expired (HU_MSGTIMEOUT
 *    140 tics, hu_stuff.h:44), the player.message drain proven live.
 * c) VIEW — the sb9 (288×144 windowed + bar) vs sb11 (fullscreen)
 *    viewport pair at one camera.
 *
 * M9-13 (D016 montage support): the scene BUILDERS moved verbatim to
 * tests/fixtures/m9Scenarios.ts (BAR_VARIANTS/barScene/msgScene/viewScene)
 * so the exit montage tiles these EXACT scenes; this file keeps the bless
 * loop + sha pins (byte-identical frames before/after the move).
 *
 * WAD-GATED (skipIf no wad, walls/screens pattern): without a wad nothing
 * dumps and committed goldens stay untouched.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { it } from 'vitest';

import {
  BAR_VARIANTS,
  VIEWPOINTS,
  barScene,
  goldenScene,
  m9Describe,
  msgScene,
  viewScene,
} from '../fixtures/m9Scenarios';

const SCRIPT_BAR =
  'E1M1 gInitGame -> warp spawn-east -> [per-tic scripted player state] x5 (gFlowTic+gTicker+HU/ST tickers) -> displayFrame (3D + crop + borders + ST bar) x2 byte-equal, hom asserted 0';
const SCRIPT_MSG =
  'E1M1 gInitGame -> warp spawn-east -> player.message=GOTMEDINEED @tic2 -> [HU/ST tickers] xN -> displayFrame (3D + bar + HU message strip @0,0) x2 byte-equal, hom 0';
const SCRIPT_VIEW =
  'E1M1 gInitGame -> warp spawn-east -> 5 empty tics -> displayFrame (sb variant) x2 byte-equal, hom 0';

/* ================================================================== */
/* a) statusbar 8-variant matrix                                       */
/* ================================================================== */

m9Describe('M9-11 m9hud — statusbar variant matrix (goldens/m9)', () => {
  for (const [name, tics, mutate] of BAR_VARIANTS) {
    it(`${name}: full frame (bar composited, double-run equal, sha vs meta)`, () => {
      goldenScene(name, SCRIPT_BAR, barScene(tics, mutate));
    });
  }
});

/* ================================================================== */
/* b) HU message strip                                                 */
/* ================================================================== */

m9Describe('M9-11 m9hud — HU message strip (goldens/m9)', () => {
  // The strip pixels exist ONLY while the drawer says "messageOn" —
  // pin the queue state at each captured frame (hu_stuff.c:505-533).
  it('msg-show (tic 4): message drawn at (0,0)', () => {
    goldenScene('msg-show-t4', SCRIPT_MSG, msgScene(4));
  });
  it('msg-hold (tic 105): still inside HU_MSGTIMEOUT', () => {
    goldenScene('msg-hold-t105', SCRIPT_MSG, msgScene(105));
  });
  it('msg-gone (tic 144): timeout expired, 3D-only frame', () => {
    goldenScene('msg-gone-t144', SCRIPT_MSG, msgScene(144));
  });
});

/* ================================================================== */
/* c) sb9 / sb11 viewport pair                                          */
/* ================================================================== */

m9Describe('M9-11 m9hud — screenblocks viewport pair (goldens/m9)', () => {
  for (const sb of [9, 11] as const) {
    it(`view-sb${sb}: E1M1 spawn-east full frame (D_Display composition)`, () => {
      goldenScene(`view-sb${sb}-spawn-east`, SCRIPT_VIEW, viewScene(sb, VIEWPOINTS['spawn-east']));
    });
  }
});
