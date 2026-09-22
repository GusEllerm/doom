/**
 * Shared e2e helper (M9-fix): the page now boots into the TITLEPIC attract
 * (M9 boot flow — D_StartTitle at the D_DoomMain tail; GS_DEMOSCREEN ticks
 * NEVER run the world and game keys are eaten by the attract/menu), so any
 * spec that tests PLAY behavior must first ENTER the game.
 *
 * The real-keys recipe (Esc / Enter walks on the live loop) is m9-flow
 * stage 2's job — THAT spec keeps it, guarding the production boot UI. For
 * the pre-existing specs this helper adapts, a real-keys walk would be
 * wall-clock bound: the menu transitions consume live tics, so gametic —
 * a HASHED §3.4 field — drifts ±1-3 tics from leveltime between page
 * loads, and the double-run determinism specs (which pin `state().hash`
 * across two boots) flake ~50% on it (the legacy boot-into-E1M1 never had
 * that drift: gametic == leveltime from page load).
 *
 * So this is the DETERMINISTIC enter-play: pause the live stepper, re-zero
 * the clock the legacy boot implicitly anchored (gametic = 0), bypass the
 * armed-but-unconsumed advancedemo flag (the attract is never shown —
 * production boot stays untouched; m9-flow stage 1 still proves it), then
 * do EXACTLY what M_ChooseSkill does — G_DeferedInitNew(Hurt me, E1)
 * (gameskill 3 == the legacy boot's default skill, gamemode.ts's 1-based
 * deferred-init domain) — and drain it on ONE scripted runTics tic. The
 * drain (gTicker step 2 → G_DoNewGame → G_InitNew: M_ClearRandom,
 * P_SetupLevel, leveltime=0) lands (leveltime, gametic) == (1, 1) EXACTLY
 * and the legacy invariant gametic == leveltime + 0 holds again — every
 * tic after this point is either live 1:1 or scripted 1:1. No sleeps, no
 * polling races; the resume mirrors the real-keys path (menu keys were
 * never the world's input; popInput drains whatever the page queued).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { type Page } from '@playwright/test';

/**
 * Boot → play on E1M1/Hurt me, resolving at EXACTLY (leveltime, gametic)
 * == (1, 1), gamestate GS_LEVEL, usergame true, with the live loop
 * running again (specs park it themselves — pause watchers, runTo, etc.).
 */
export async function enterPlay(page: Page): Promise<void> {
  const done = await page.evaluate(() => {
    const api = window.__doom!;
    api.pause(true); // freeze the live stepper — every tic from here is accounted
    const st = api.sim.getState()!;
    st.gametic = 0; // legacy-boot clock anchor (the attract's tics are history)
    st.advancedemo = false; // never arm the attract page we are skipping
    // G_DeferedInitNew(sk_hurt+1, ep1, map1) — the EXACT fields
    // M_ChooseSkill/M_NewGame write (m_menu.c:874+); skill 3 (1-based) ==
    // the legacy boot's gInitGame default; gameaction 2 == GA.newgame.
    st.gameskill = 3;
    st.gameepisode = 1;
    st.gamemap = 1;
    st.gameaction = 2;
    api.sim.runTics(1); // scripted drain: G_DoNewGame → G_InitNew → P_SetupLevel
    const s = api.sim.getState()!;
    const ok =
      s.gamestate === 0 && s.leveltime === 1 && s.gametic === 1 && s.usergame === true && s.map.name === 'E1M1';
    api.popInput(); // drain any DOM events queued meanwhile (m9-flow stage 6 idiom)
    api.pause(false); // hand the loop back (park watchers take over from here)
    return ok ? null : { gamestate: s.gamestate, leveltime: s.leveltime, gametic: s.gametic, map: s.map.name };
  });
  if (done !== null) {
    throw new Error(`deterministic new-game drain did not land (1,1)/E1M1/LEVEL: ${JSON.stringify(done)}`);
  }
}
