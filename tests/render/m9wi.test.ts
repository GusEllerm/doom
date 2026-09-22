/**
 * M9-11 — L3 golden corpus: intermission tallies + finale (plan §M9-11,
 * goldens set `m9`).
 *
 * Ten frames through the SAME driver as m9hud/m9menus — scripted sim tics
 * (gTicker routes WI_Ticker / F_Ticker via the M9-03 flow hooks), capture
 * by displayFrame with the registered wiDrawer/finaleDrawer seam
 * (d_main.c:263-268). No 3D pass in these states, so instead of a HOM pin
 * each scene asserts the no-3D shape (counters undefined) + zero
 * displayStubHits; the WI tally inputs ride the LIVE counters the M9-07
 * state machine reads (mobjs.totalkills / players.killcount / secretcount
 * / leveltime, g_game.c G_DoCompleted fill).
 *
 * Tallies: 0/0/0 @t70, 50/33/0 @t70 (mid-count digits), 100/100/100 @t200
 * + the par/sucks time pages (leveltime 300 < par vs 200000 ≫ par, both
 * captured at the final StatCount state) + ShowNextLoc blink on/off (the
 * accelerate edge: attack press+release at spState 10).
 * Finale: FLOOR4_8+E1TEXT reveal @t200, all-text hold @t900 (flip is
 * strlen*3+250 = 1570), HELP2 stage 1 @t1571.
 *
 * WAD-GATED (skipIf no wad): the WIMAP0/WISCRT2/WISUCKS, STCFN and
 * FLOOR4_8 art is real.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, it } from 'vitest';

import {
  displayStubHits,
  registerDisplayHooks,
} from '../../src/render/renderer';
import { wadWiPatches, wiDrawer } from '../../src/render/wiDraw';
import { gDoCompleted, wiDrawSnapshot, wiPeek, wiResetPlayerFlags, wiTicker } from '../../src/sim/wintermission';
import { gExitLevel } from '../../src/sim/game';
import { emptyInput } from '../../src/sim/ticcmd';
import { fDrawer, fReset, fSetWad, fStartFinale, fTicker } from '../../src/ui/finale';
import {
  M9Driver,
  VIEWPOINTS,
  bundle_,
  goldenScene,
  m9Describe,
  sharedFb,
  type Bundle,
  type SceneFrame,
} from '../fixtures/m9Scenarios';

const SCRIPT_WI =
  'E1M1 gInitGame -> scripted census/kill/item/secret/leveltime -> gExitLevel + gTicker drain (G_DoCompleted -> WI_Start, GS_INTERMISSION) -> scripted wiTicker tics -> displayFrame wiDrawer x2 byte-equal (no 3D pass)';
const SCRIPT_FIN =
  'E1M1 gInitGame -> fStartFinale (FLOOR4_8 + E1TEXT) -> F_Ticker xN -> displayFrame GS_FINALE finaleDrawer x2 byte-equal (no 3D pass)';

function expectNo3dNoStubs(r: { counters?: unknown }): void {
  expect(r.counters, 'this state draws no 3D pass').toBeUndefined();
  expect(displayStubHits.count, 'all D_Display drawers registered').toBe(0);
}

interface Tally {
  readonly kills?: number;
  readonly items?: number;
  readonly secrets?: number;
  readonly leveltime?: number;
  readonly totalkills?: number;
  readonly totalitems?: number;
  readonly totalsecret?: number;
}

/** Boot E1M1, stage the census the way P_SetupLevel would, exit; the
 * returned driver sits in GS_INTERMISSION with the wiDrawer hook wired
 * (FRESH wadWiPatches source per frame — sidesteps the wiLoadData back-
 * buffer cache across scenes, see the wiDraw.ts seam contract). */
function wiBoot(tally: Tally): M9Driver {
  const b: Bundle = bundle_();
  const d = new M9Driver(b, VIEWPOINTS['spawn-east'], {
    bar: false,
    hu: false,
    flow: { wiTicker, doCompleted: gDoCompleted },
  });
  wiResetPlayerFlags();
  const p = d.state.players[0]!;
  d.state.mobjs.totalkills = tally.totalkills ?? 100;
  d.state.mobjs.totalitems = tally.totalitems ?? 100;
  d.state.totalsecret = tally.totalsecret ?? 1;
  p.killcount = tally.kills ?? 0;
  p.itemcount = tally.items ?? 0;
  d.state.secretcount = tally.secrets ?? 0;
  if (tally.leveltime !== undefined) d.state.leveltime = tally.leveltime;
  gExitLevel(d.state);
  d.tic(); // the drain tic: G_DoCompleted -> WI_Start (BCNT=1)
  registerDisplayHooks({
    wiDrawer: () => wiDrawer(wadWiPatches(b.wad), wiDrawSnapshot()),
  });
  return d;
}

function capture(d: M9Driver): SceneFrame {
  const r = d.display();
  expectNo3dNoStubs(r);
  return { bytes: sharedFb.indices.slice() };
}

m9Describe('M9-11 m9wi — intermission tallies + finale (goldens/m9)', () => {
  it('wi-tally-0: 0/0/0 % at tic 70', () => {
    goldenScene('wi-tally-0-t70', SCRIPT_WI, () => {
      const d = wiBoot({ kills: 0, items: 0, secrets: 0, leveltime: 0 });
      for (let t = 1; t < 70; t++) d.tic();
      return capture(d);
    });
  });

  it('wi-tally-50: 50/33/0 % mid-count at tic 70', () => {
    goldenScene('wi-tally-50-t70', SCRIPT_WI, () => {
      const d = wiBoot({ kills: 50, items: 33, secrets: 0, leveltime: 105 });
      for (let t = 1; t < 70; t++) d.tic();
      return capture(d);
    });
  });

  it('wi-tally-100: 100/100/100 % settled at tic 200', () => {
    goldenScene('wi-tally-100-t200', SCRIPT_WI, () => {
      const d = wiBoot({
        kills: 7, items: 5, secrets: 1, leveltime: 105,
        totalkills: 7, totalitems: 5, totalsecret: 1,
      });
      for (let t = 1; t < 200; t++) d.tic();
      return capture(d);
    });
  });

  it('wi-time-par: final time page UNDER par', () => {
    goldenScene('wi-time-par', SCRIPT_WI, () => {
      const d = wiBoot({ kills: 50, items: 0, secrets: 0, leveltime: 300 });
      let guard = 0;
      while (wiPeek().spState !== 10 && guard++ < 4000) d.tic();
      expect(wiPeek().spState, 'reached the final StatCount state').toBe(10);
      return capture(d);
    });
  });

  it('wi-time-sucks: final time page far OVER par (WISUCKS)', () => {
    goldenScene('wi-time-sucks', SCRIPT_WI, () => {
      const d = wiBoot({ kills: 0, items: 0, secrets: 0, leveltime: 200000 });
      let guard = 0;
      while (wiPeek().spState !== 10 && guard++ < 4000) d.tic();
      expect(wiPeek().spState, 'reached the final StatCount state').toBe(10);
      return capture(d);
    });
  });

  /** Accelerate (attack edge at spState 10) -> ShowNextLoc; capture the
   * map page at a blink-ON and a blink-OFF tic (WI_shownextPointer). */
  function shownextScene(pointerOn: boolean): () => SceneFrame {
    return () => {
      const d = wiBoot({
        kills: 7, items: 5, secrets: 1, leveltime: 105,
        totalkills: 7, totalitems: 5, totalsecret: 1,
      });
      let guard = 0;
      while (wiPeek().spState !== 10 && guard++ < 4000) d.tic();
      d.tic({ ...emptyInput(), attack: true }); // edge DOWN
      d.tic(); // edge UP -> WI_InitShowNextLoc on this tic (spState 10)
      guard = 0;
      while (wiPeek().phase !== 'ShowNextLoc' && guard++ < 500) d.tic();
      expect(wiPeek().phase, 'ShowNextLoc reached').toBe('ShowNextLoc');
      guard = 0;
      while (wiPeek().snlPointerOn !== pointerOn && guard++ < 64) d.tic();
      expect(wiPeek().snlPointerOn, `blink ${pointerOn ? 'ON' : 'OFF'} reached`).toBe(
        pointerOn,
      );
      return capture(d);
    };
  }

  it('wi-shownext-on: E1M2 map page, skull-on frame', () => {
    goldenScene('wi-shownext-on', SCRIPT_WI, shownextScene(true));
  });
  it('wi-shownext-off: same page, blink-off frame', () => {
    goldenScene('wi-shownext-off', SCRIPT_WI, shownextScene(false));
  });

  /* ---------------------------------------------------------------- */
  /* finale — three phases (text reveal / full-text hold / HELP2)      */
  /* ---------------------------------------------------------------- */

  function finaleScene(tics: number): () => SceneFrame {
    return () => {
      const b = bundle_();
      const d = new M9Driver(b, VIEWPOINTS['spawn-east'], { bar: false, hu: false });
      fReset(b.wad);
      fSetWad(b.wad);
      fStartFinale(d.state); // ga_victory case body (f_finale.c:96-135)
      for (let t = 0; t < tics; t++) fTicker(d.state, emptyInput());
      registerDisplayHooks({ finaleDrawer: fDrawer });
      const r = d.display();
      expectNo3dNoStubs(r);
      return { bytes: sharedFb.indices.slice() };
    };
  }

  it('fin-text-200: FLOOR4_8 flood + E1TEXT mid-reveal (tic 200)', () => {
    goldenScene('fin-text-200', SCRIPT_FIN, finaleScene(200));
  });
  it('fin-text-full: every E1TEXT char drawn, stage 0 hold (tic 900)', () => {
    goldenScene('fin-text-full-t900', SCRIPT_FIN, finaleScene(900));
  });
  it('fin-help2: stage 1 HELP2 hold (tic 1571, past strlen*3+250)', () => {
    goldenScene('fin-help2-t1571', SCRIPT_FIN, finaleScene(1571));
  });
});
