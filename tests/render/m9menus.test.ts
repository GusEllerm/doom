/**
 * M9-11 — L3 golden corpus: title page + menu screens (plan §M9-11,
 * goldens set `m9`).
 *
 * Four frames through the SAME production driver as m9hud (displayFrame +
 * the registered per-state drawers, d_main.c:193-330):
 *   1. title-page   — GS_DEMOSCREEN via dInit/advancedemo, TITLEPIC
 *                     through the dPageDrawer seam (no 3D pass).
 *   2. menu-main    — E1M1 live frame + M_Drawer MainDef (skull on item
 *                     0), menuOpen = G_Ticker sim-half frozen (vanilla
 *                     g_game.c:651: only the M_Ticker skull animates).
 *   3. menu-newgame — MainDef → Enter (EpiDef, shareware 3 items) →
 *                     Enter (NewDef skill screen, lastOn = hurtme).
 *   4. menu-options — MainDef → Down → Enter: the thermo screen.
 * The menu frames carry the 3D pass ⇒ HOM=0 pinned; the title page
 * asserts the no-3D shape (counters undefined) + zero displayStubHits.
 *
 * M9-13 (D016 montage support): titleScene/menuScene moved verbatim to
 * tests/fixtures/m9Scenarios.ts (shared with the exit montage); byte-
 * identical frames before/after the move.
 *
 * WAD-GATED (skipIf no wad): the M_ / TITLEPIC / STCFN art is real.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { it } from 'vitest';

import { KEY_DOWNARROW, KEY_ENTER } from '../../src/input/keyboard';
import {
  goldenScene,
  m9Describe,
  menuScene,
  titleScene,
} from '../fixtures/m9Scenarios';

const SCRIPT_TITLE =
  'E1M1 gInitGame -> dReset/dInit/dRegisterFlow -> gFlowTic (D_DoAdvanceDemo: TITLEPIC) -> displayFrame GS_DEMOSCREEN pageDrawer x2 byte-equal (no 3D pass)';
const SCRIPT_MENU =
  'E1M1 gInitGame -> warp spawn-east -> 5 sim tics (3D live, hom 0) -> mInit + M_StartControlPanel -> [key script] -> 6 x (M_Ticker flow tic + displayFrame: 3D + crop + borders + ST bar + HU + M_Drawer LAST) x2 byte-equal';

m9Describe('M9-11 m9menus — title + menu screens (goldens/m9)', () => {
  it('title-page: TITLEPIC through the D_Display demoscreen branch', () => {
    goldenScene('title-page', SCRIPT_TITLE, titleScene());
  });

  it('menu-main: MainDef over the live E1M1 frame (skull animated)', () => {
    goldenScene('menu-main', SCRIPT_MENU, menuScene([]));
  });

  it('menu-newgame: NewGameMenu skill screen (EpiDef-entered)', () => {
    goldenScene('menu-newgame', SCRIPT_MENU, menuScene([KEY_ENTER, KEY_ENTER]));
  });

  it('menu-options: OptionsMenu thermo screen', () => {
    goldenScene('menu-options', SCRIPT_MENU, menuScene([KEY_DOWNARROW, KEY_ENTER]));
  });
});
