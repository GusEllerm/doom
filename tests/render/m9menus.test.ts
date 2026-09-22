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
 * WAD-GATED (skipIf no wad): the M_ / TITLEPIC / STCFN art is real.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, it } from 'vitest';

import {
  displayStubHits,
  registerDisplayHooks,
} from '../../src/render/renderer';
import {
  KEY_DOWNARROW,
  KEY_ENTER,
} from '../../src/input/keyboard';
import {
  mDrawer,
  mResponder,
  mReset,
  mStartControlPanel,
  mTicker,
} from '../../src/ui/menu';
import { registerGameFlowHooks } from '../../src/sim/game';
import { dInit, dPageDrawer, dRegisterFlow, dReset, dSetWad } from '../../src/ui/title';
import {
  M9Driver,
  VIEWPOINTS,
  bundle_,
  goldenScene,
  m9Describe,
} from '../fixtures/m9Scenarios';

const SCRIPT_TITLE =
  'E1M1 gInitGame -> dReset/dInit/dRegisterFlow -> gFlowTic (D_DoAdvanceDemo: TITLEPIC) -> displayFrame GS_DEMOSCREEN pageDrawer x2 byte-equal (no 3D pass)';
const SCRIPT_MENU =
  'E1M1 gInitGame -> warp spawn-east -> 5 sim tics (3D live, hom 0) -> mInit + M_StartControlPanel -> [key script] -> 6 x (M_Ticker flow tic + displayFrame: 3D + crop + borders + ST bar + HU + M_Drawer LAST) x2 byte-equal';

function expectNoMissingDrawer(): void {
  expect(displayStubHits.count, 'all D_Display drawers registered').toBe(0);
}

const down = (data1: number): { type: 'keydown'; data1: number } => ({
  type: 'keydown',
  data1,
});
const up = (data1: number): { type: 'keyup'; data1: number } => ({
  type: 'keyup',
  data1,
});

function press(d: M9Driver, ch: number): void {
  mResponder(d.state, down(ch));
  mResponder(d.state, up(ch));
}

m9Describe('M9-11 m9menus — title + menu screens (goldens/m9)', () => {
  it('title-page: TITLEPIC through the D_Display demoscreen branch', () => {
    goldenScene('title-page', SCRIPT_TITLE, () => {
      const b = bundle_();
      const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { bar: false, hu: false });
      dReset(b.wad);
      dRegisterFlow();
      dSetWad(b.wad);
      dInit(d.state); // D_StartTitle arms advancedemo
      d.flowTic(); // the tic block consumes it -> TITLEPIC page (d_main.c:454)
      registerDisplayHooks({ pageDrawer: dPageDrawer });
      const r = d.display();
      expect(r.counters, 'demoscreen draws no 3D pass').toBeUndefined();
      expectNoMissingDrawer();
      return d.capture(); // pageDrawer draws the full 320x200 page, no 3D
    });
  });

  /** Boot, open the control panel, run a key script, settle 6 skull tics,
   * capture the composed frame (menu drawn LAST over the live level). */
  function menuScene(keys: readonly number[]): () => { bytes: Uint8Array; hom?: number } {
    return () => {
      const b = bundle_();
      const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { sb: 9 });
      for (let t = 0; t < 5; t++) d.tic();
      mReset(b.wad); // full cross-scene reset (menu table statics,
      // lastOn cursors, screenblocks) + mInit inside
      registerGameFlowHooks({ mTicker: (st) => mTicker(st) });
      registerDisplayHooks({ mDrawer });
      mStartControlPanel(d.state);
      for (const k of keys) press(d, k);
      for (let t = 0; t < 6; t++) d.flowTic(); // M_Ticker ONLY (sim frozen)
      const r = d.display({ menuActive: true });
      expectNoMissingDrawer();
      return {
        ...d.capture(),
        ...(r.counters === undefined ? {} : { hom: r.counters.hom }),
      };
    };
  }

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
