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
 * M9-13 (D016 montage support): wiBoot/wiTallyScene/wiTimeScene/
 * finaleScene moved verbatim to tests/fixtures/m9Scenarios.ts (shared
 * with the exit montage); byte-identical frames before/after the move.
 *
 * WAD-GATED (skipIf no wad): the WIMAP0/WISCRT2/WISUCKS, STCFN and
 * FLOOR4_8 art is real.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, it } from 'vitest';

import { emptyInput } from '../../src/sim/ticcmd';
import { wiPeek } from '../../src/sim/wintermission';
import {
  finaleScene,
  goldenScene,
  m9Describe,
  wiBoot,
  wiCapture,
  wiTallyScene,
  wiTimeScene,
  type SceneFrame,
} from '../fixtures/m9Scenarios';

const SCRIPT_WI =
  'E1M1 gInitGame -> scripted census/kill/item/secret/leveltime -> gExitLevel + gTicker drain (G_DoCompleted -> WI_Start, GS_INTERMISSION) -> scripted wiTicker tics -> displayFrame wiDrawer x2 byte-equal (no 3D pass)';
const SCRIPT_FIN =
  'E1M1 gInitGame -> fStartFinale (FLOOR4_8 + E1TEXT) -> F_Ticker xN -> displayFrame GS_FINALE finaleDrawer x2 byte-equal (no 3D pass)';

m9Describe('M9-11 m9wi — intermission tallies + finale (goldens/m9)', () => {
  it('wi-tally-0: 0/0/0 % at tic 70', () => {
    goldenScene('wi-tally-0-t70', SCRIPT_WI, wiTallyScene({ kills: 0, items: 0, secrets: 0, leveltime: 0 }, 70));
  });

  it('wi-tally-50: 50/33/0 % mid-count at tic 70', () => {
    goldenScene('wi-tally-50-t70', SCRIPT_WI, wiTallyScene({ kills: 50, items: 33, secrets: 0, leveltime: 105 }, 70));
  });

  it('wi-tally-100: 100/100/100 % settled at tic 200', () => {
    goldenScene('wi-tally-100-t200', SCRIPT_WI, wiTallyScene({
      kills: 7, items: 5, secrets: 1, leveltime: 105,
      totalkills: 7, totalitems: 5, totalsecret: 1,
    }, 200));
  });

  it('wi-time-par: final time page UNDER par', () => {
    goldenScene('wi-time-par', SCRIPT_WI, wiTimeScene({ kills: 50, items: 0, secrets: 0, leveltime: 300 }));
  });

  it('wi-time-sucks: final time page far OVER par (WISUCKS)', () => {
    goldenScene('wi-time-sucks', SCRIPT_WI, wiTimeScene({ kills: 0, items: 0, secrets: 0, leveltime: 200000 }));
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
      return wiCapture(d);
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
