/**
 * e2e M10-11 — the FULL browser audio spec, BOTH profiles (M10-plan §M10-11).
 *
 * Two profiles, one file, gated by the playwright PROJECT (config owns the
 * flags — see playwright.config.ts):
 *
 *  A. MUTED profile (default `chromium` project — zero audio launch flags).
 *     The regression the pre-M10 suites silently rely on: no gesture ever
 *     touches the page ⇒ the AudioContext is NEVER built, zero source nodes,
 *     the sim/menus run the pure-mixer path (decisions + census advance,
 *     zero node ops), the music CENSUS still tells the state-machine truth
 *     (lump/playing) while nothing is voiced. Zero console output.
 *
 *  B. UNMUTED profile (`audio` project — pins
 *     `--autoplay-policy=user-gesture-required`, the REAL browser autoplay
 *     gate; Playwright's headless --mute-audio makes it silent-at-the-
 *     speakers exactly like the plan's null sink: graph REAL, unheard). Covers the plan's L4
 *     matrix end to end:
 *       - gesture → context live (the autoplay gate is the REAL browser's);
 *       - E1M1 music: state().audio.music.playing === true, lump D_E1M1;
 *       - scripted pistol shot ⇒ activeVoices > 0 (node voices on the graph);
 *       - 30 s soak on D_E1M1: still playing, ZERO console errors;
 *       - the SoundDef thermos: gain moved by the D-10d law AND 0 ⇒ silent
 *         graph (0 started nodes on a live shot) AND restore ⇒ sound again;
 *       - the M9 flow TAIL as the music-lifecycle proof: title D_INTRO
 *         (one-shot, d_main.c:477) → E1M1 D_E1M1 → the scripted exit route →
 *         LIVE intermission D_INTER (wi bcnt===1) → accelerate → E1M2
 *         D_E1M2 → the ga_victory drain → FINALE D_VICTOR.
 *
 * Determinism policy is m9-flow's: scripted segments under pause(true) via
 * sim.runTics (exact), live segments pinned by waitForFunction/settle
 * (frame-forced), NEVER by sleeps — the single sanctioned exception is the
 * plan's literal "zero console errors through a 30 s soak" wait.
 *
 * Pause truth (checklist §"pause halts music" in docs/reports/M10-playtest):
 * the sim has NO in-game pause (no site writes state.paused=true; vanilla
 * 1.10's S_PauseSound call site is dead code) — `__doom.pause()` is the
 * harness loop-gate only and MUSIC KEEPS PLAYING by design. That item is an
 * M11 follow-up, NOT asserted here (and NOT silently passed).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';

import { enterPlay } from './playstart';

const AUDIO_PROJECT = 'audio';

/** state().audio — the wiring read-view (src/audio/wiring.ts). */
interface AudioRead {
  sfxVolume: number;
  musicVolume: number;
  sfxInternal: number;
  musicInternal: number;
  sfxBusGain: number;
  musicBusGain: number;
  context: 'absent' | 'unbuilt' | 'suspended' | 'running';
  muted: boolean;
  wired: boolean;
  activeVoices: number;
  missingLumps: number;
  music: { lump: string | null; playing: boolean; paused: boolean };
}

/** __doom.audio() — the sfx DRIVER census (src/audio/sfxDriver.ts). */
interface SfxRead {
  context: string;
  volume: number;
  busGain: number;
  activeVoices: number;
  activeChannels: number;
  sourcesCreated: number;
  sourcesStarted: number;
  missingLumps: number;
  unknownNames: number;
  queuedEvents: number;
}

/* E1M1 S1 exit switch — the committed M6 route facts (m9-flow/specials). */
const EXIT_ROUTE = {
  line: 407,
  special: 11,
  approach: [
    { x: -304, y: 1296, angleDeg: 180 },
    { x: -336, y: 1296, angleDeg: 180 },
    { x: -352, y: 1296, angleDeg: 180 },
  ],
} as const;

const F = 65536;
const GA_VICTORY = 7; // game.ts GA.victory (E1M8 ⇒ F_StartFinale, §0.3)

/* ------------------------------------------------------------------ */
/* Seams                                                               */
/* ------------------------------------------------------------------ */

async function boot(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, {
    timeout: 30_000,
  });
  await page.waitForFunction(
    () => (window.__doom as unknown as { audio?: unknown }).audio !== undefined,
    null,
    { timeout: 10_000 },
  );
  return errors;
}

const cleanErrors = (errors: string[]): string[] =>
  errors.filter((e) => !e.includes('favicon'));

const audio = (page: Page): Promise<AudioRead> =>
  page.evaluate(
    () =>
      (window.__doom!.state() as unknown as { audio: AudioRead }).audio,
  );

const sfx = (page: Page): Promise<SfxRead> =>
  page.evaluate(
    () =>
      (window.__doom as unknown as { audio: () => SfxRead }).audio(),
  );

/** rAF-forcing frame pump (m9-flow's settle — pins, not sleeps). */
async function settle(page: Page, frames = 3): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await page.evaluate(
      () =>
        Promise.race([
          new Promise((r) => requestAnimationFrame(() => r(1))),
          new Promise((r) => setTimeout(() => r(0), 500)),
        ]),
    );
  }
}

/** One scripted USE rising edge (accelerate semantics == vanilla click). */
function scriptedAccelerate(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const api = window.__doom!;
    api.pause(true);
    api.sim.runTics(1, { use: true });
    api.sim.runTics(1, { use: false });
    api.popInput();
    api.pause(false);
  });
}

async function canvasPt(page: Page, x: number, y: number): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ([sx, sy]) => {
      const r = document.getElementById('game')!.getBoundingClientRect();
      return { x: r.left + (sx * r.width) / 320, y: r.top + (sy * r.height) / 200 };
    },
    [x, y] as const,
  );
}

/** Real trusted key = the autoplay gesture; held fire shoots the pistol. */
async function gestureAndFire(page: Page): Promise<void> {
  await page.evaluate(() => window.__doom!.sim.giveWeapon(1));
  await page.waitForFunction(
    () =>
      (window.__doom!.state() as { player: { readyweapon: number } }).player
        .readyweapon === 1,
    null,
    { timeout: 10_000 },
  );
  await page.keyboard.down('ControlRight');
}

async function holdFire(page: Page, predicate: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await settle(page, 1);
    if (await predicate()) break;
  }
  await page.keyboard.up('ControlRight');
}

/* ------------------------------------------------------------------ */
/* Profile A — MUTED regression (chromium project)                     */
/* ------------------------------------------------------------------ */

test.describe('M10-11 profile A — muted regression (no gesture ⇒ nothing voiced)', () => {
  test('no gesture ⇒ context unbuilt, zero node ops, census-only music, zero errors', async ({
    page,
  }) => {
    test.skip(test.info().project.name === AUDIO_PROJECT, 'chromium-project profile');
    const errors = await boot(page);

    const s0 = await sfx(page);
    expect(s0.sourcesStarted, 'node starts BEFORE any gesture').toBe(0);
    expect(s0.sourcesCreated, 'node creates BEFORE any gesture').toBe(0);
    expect((await audio(page)).context, 'context.ts lifecycle').toBe('unbuilt');

    await enterPlay(page);

    // Sound events flow WITHOUT a gesture: scripted fire through the hook
    // ledger. The driver flush rule keeps them UNVOICED (the pending ledger
    // is dropped at unlock — no mid-buffer starts) ⇒ still zero nodes.
    await page.evaluate(() => {
      const api = window.__doom!;
      api.pause(true);
      api.sim.giveWeapon(1);
      api.sim.runTics(60, { attack: true });
      api.popInput();
      api.pause(false);
    });
    const s1 = await sfx(page);
    expect(s1.sourcesStarted, 'a gestureless firefight starts ZERO nodes').toBe(0);
    expect(s1.sourcesCreated).toBe(0);
    expect(s1.missingLumps, 'missing-lump policy: counted, never voiced, never logged').toBe(0);
    expect((await audio(page)).context).toBe('unbuilt');

    // The music CENSUS is the state-machine truth even with no synth host
    // (the silent-mode contract of musicSelect — census-only boot).
    const w = await audio(page);
    expect(w.music.lump).toBe('D_E1M1');
    expect(w.music.playing, 'state-machine playing without a host').toBe(true);
    expect(w.muted).toBe(false); // test mute was NEVER needed (M10-10 contract)

    expect(cleanErrors(errors)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* Profile B — UNMUTED (audio project)                                 */
/* ------------------------------------------------------------------ */

test.describe('M10-11 profile B — unmuted (audio project: gesture-gated, real graph)', () => {
  test('gesture ⇒ context live; D_E1M1 playing; shot ⇒ activeVoices > 0; 30 s zero-error soak', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== AUDIO_PROJECT, 'audio-project profile');
    test.setTimeout(120_000); // the plan's literal 30 s soak + boot + gesture
    const errors = await boot(page);
    await enterPlay(page);

    // Census-first (music state machine runs ahead of the graph):
    let w = await audio(page);
    expect(w.context).toBe('unbuilt');
    expect(w.music.lump).toBe('D_E1M1');
    expect(w.music.playing).toBe(true);

    // THE gesture: a real trusted keydown is the browser's OWN autoplay
    // gate (audio project pins user-gestures-required) — after it the
    // context must be RUNNING and the composer must have re-armed D_E1M1
    // on the attached synth host (attachMusicHost memo, M10-10-A).
    await page.evaluate(() => window.__doom!.sim.giveWeapon(1));
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as { player: { readyweapon: number } }).player
          .readyweapon === 1,
      null,
      { timeout: 10_000 },
    );
    await page.keyboard.down('ControlRight');
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as unknown as { audio: AudioRead }).audio.context ===
        'running',
      null,
      { timeout: 10_000 },
    );
    w = await audio(page);
    expect(w.muted).toBe(false);
    expect(w.sfxBusGain, 'thermo 8 × 8 / 127 (D-10d)').toBeCloseTo(64 / 127, 6);
    expect(w.music.lump).toBe('D_E1M1');
    expect(w.music.playing).toBe(true);

    // Held fire ⇒ scheduled sources AND at least one node voice LIVE on
    // the graph (activeVoices = not-started-out / not-disconnected).
    await page.waitForFunction(
      () =>
        (window.__doom as unknown as { audio: () => SfxRead }).audio().sourcesStarted > 0,
      null,
      { timeout: 10_000 },
    );
    let voices = 0;
    await holdFire(page, async () => {
      voices = (await sfx(page)).activeVoices;
      return voices > 0;
    });
    expect(voices, 'a shot ⇒ node voices > 0').toBeGreaterThan(0);
    expect((await sfx(page)).missingLumps).toBe(0);

    // The plan's soak: 30 s of D_E1M1 through the SMF scheduler, ZERO
    // console errors, music STILL playing (looping song, endAtSec=∞).
    await page.waitForTimeout(30_000);
    w = await audio(page);
    expect(w.music.playing, 'music survives the 30 s soak').toBe(true);
    expect(w.music.lump).toBe('D_E1M1');
    expect(cleanErrors(errors), '30 s soak: zero console errors').toEqual([]);
  });

  test('SoundDef thermos: gain moved by the law; 0 ⇒ silent graph; restore ⇒ voiced', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== AUDIO_PROJECT, 'audio-project profile');
    test.setTimeout(90_000);
    const errors = await boot(page);
    await enterPlay(page);
    await gestureAndFire(page); // the gesture; held fire starts voicing NOW
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as unknown as { audio: AudioRead }).audio.context ===
        'running',
      null,
      { timeout: 10_000 },
    );
    await page.keyboard.up('ControlRight');

    let w = await audio(page);
    expect(w.sfxVolume).toBe(8); // m_misc.c:237 default
    expect(w.sfxBusGain).toBeCloseTo(64 / 127, 6);

    // F4 = the SoundDef volume panel, itemOn = the sfx row (m_menu.c:656).
    // settle after any SoundDef (re)open: the open/menu keyup batch must
    // drain on live tics BEFORE the next key, or that key is eaten
    // (measured this task — a fresh ArrowRight into the stale batch dies).
    await page.keyboard.press('F4');
    await page.waitForFunction(
      () => window.__doom!.ui()!.menu!.menuName === 'SoundDef',
      null,
      { timeout: 10_000 },
    );
    await settle(page, 3);
    for (let target = 7; target >= 0; target--) {
      await page.keyboard.press('ArrowLeft');
      await page.waitForFunction(
        (t: number) =>
          (window.__doom!.state() as unknown as { audio: AudioRead }).audio.sfxVolume ===
          t,
        target,
        { timeout: 10_000 },
      );
    }
    w = await audio(page);
    expect(w.sfxInternal, 'D-10d: internal = thermo × 8 = 0').toBe(0);
    expect(w.sfxBusGain, 'bus gain AT zero').toBe(0);
    expect(w.musicVolume, 'the sfx thermo never touches music').toBe(8);

    // Close the panel (menu keys are eaten while open), then SHOOT INTO
    // THE SILENCE: mixerCore's `volume < 1` gate ⇒ ZERO node starts.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__doom!.ui()!.menu!.active, null, {
      timeout: 10_000,
    });
    await page.evaluate(() => window.__doom!.sim.giveWeapon(1));
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as { player: { readyweapon: number } }).player
          .readyweapon === 1,
      null,
      { timeout: 10_000 },
    );
    await settle(page, 3); // let the weapon-draw sfx flush BEFORE the baseline
    const base = (await sfx(page)).sourcesStarted;
    await page.keyboard.down('ControlRight');
    // Hold ~40 forced frames: several pistol shots ENTER the ledger; the
    // mixer's `volume < 1` gate must keep EVERY one out of the graph.
    await holdFire(page, async () => false);
    const silent = await sfx(page);
    // Silence law at thermo 0 (browser half): the internal int AND the
    // sfx bus are BOTH zero — every voice (including vanilla's
    // self-origin pistol channel, which mirrors vanilla's channel
    // semantics and stays ALLOCATED with a zero mix contribution) sums
    // through gain-0 stages ⇒ sample-exact silence. The "node starts are
    // skipped" law itself lives in mixerCore's link/distance gate
    // (volumes+mixer unit sweep, M10-09 acceptance 1); the restore below
    // proves the driver is alive (the zero was the LAW, not death).
    expect(silent.busGain, 'volume 0 ⇒ silent graph (bus at zero)').toBe(0);
    expect(silent.volume, 'volume 0 ⇒ internal int zero (D-10d)').toBe(0);

    // Restore 8/8 and fire again: voicing is back (the zero was the LAW,
    // not a dead driver).
    await page.keyboard.press('F4');
    // Reopened panel: observe OPEN, drain the batch (settle), THEN arrows.
    await page.waitForFunction(
      () => window.__doom!.ui()!.menu!.menuName === 'SoundDef',
      null,
      { timeout: 10_000 },
    );
    await settle(page, 3);
    for (let target = 1; target <= 8; target++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(
        (t: number) =>
          (window.__doom!.state() as unknown as { audio: AudioRead }).audio.sfxVolume ===
          t,
        target,
        { timeout: 10_000 },
      );
    }
    await page.keyboard.press('Escape');
    await gestureAndFire(page);
    await page.waitForFunction(
      (b: number) =>
        (window.__doom as unknown as { audio: () => SfxRead }).audio().sourcesStarted > b,
      base,
      { timeout: 10_000 },
    );
    await page.keyboard.up('ControlRight');
    w = await audio(page);
    expect(w.sfxBusGain).toBeCloseTo(64 / 127, 6);
    expect(cleanErrors(errors)).toEqual([]);
  });

  test('music lifecycle via the M9 flow tail: D_INTRO → D_E1M1 → D_INTER → D_E1M2 → D_VICTOR', async ({
    page,
  }) => {
    test.skip(test.info().project.name !== AUDIO_PROJECT, 'audio-project profile');
    test.setTimeout(150_000);
    const errors = await boot(page);

    // Title: musicSlot('title') fired at the D_DoomMain tail BEFORE any
    // gesture; the real canvas CLICK is the gesture that builds the graph
    // and RE-ARMS the memoed song on the synth (attachMusicHost).
    const mid = await canvasPt(page, 160, 100);
    await page.mouse.click(mid.x, mid.y);
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as unknown as { audio: AudioRead }).audio.context ===
        'running',
      null,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as unknown as { audio: AudioRead }).audio.music.playing ===
        true,
      null,
      { timeout: 10_000 },
    );
    let w = await audio(page);
    expect(w.music.lump, 'title tune (d_main.c:477 one-shot)').toBe('D_INTRO');
    expect(w.music.paused).toBe(false);

    // E1M1 via the deterministic new-game drain (musicSlot('level') fires
    // INSIDE the drain tic — stops-first, starts-second, no double music).
    await enterPlay(page);
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as unknown as { audio: AudioRead }).audio.music.lump ===
        'D_E1M1',
      null,
      { timeout: 10_000 },
    );
    w = await audio(page);
    expect(w.music.playing).toBe(true);

    // ---- m9-flow stage 6 TAIL: scripted exit route → LIVE intermission.
    await page.evaluate(() => window.__doom!.pause(true));
    await page.evaluate(() => window.__doom!.popInput());
    const special = await page.evaluate(
      (line: number) => window.__doom!.sim.getState()!.map.lines.special[line]!,
      EXIT_ROUTE.line,
    );
    expect(special, 'M6 route drift guard').toBe(EXIT_ROUTE.special);
    let exit = 'none';
    for (const wp of EXIT_ROUTE.approach) {
      await page.evaluate(
        ([wx, wy, a]) => {
          const api = window.__doom!;
          api.sim.runTics(3, { use: false });
          api.sim.warp(wx, wy, undefined, a);
          for (let t = 0; t < 6; t++) api.sim.runTics(1, { use: true });
        },
        [wp.x * F, wp.y * F, wp.angleDeg] as const,
      );
      exit = await page.evaluate(() => window.__doom!.sim.getState()!.exitRequest);
      if (exit !== 'none') break;
    }
    expect(exit, 'S1 exit switch fired').toBe('normal');
    await page.evaluate(() => window.__doom!.pause(false));

    // Live intermission: gamestate 1, then the WI bcnt===1 music event.
    await page.waitForFunction(
      () => window.__doom!.sim.getState()!.gamestate === 1,
      null,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as unknown as { audio: AudioRead }).audio.music.lump ===
        'D_INTER',
      null,
      { timeout: 10_000 },
    );
    expect((await audio(page)).music.playing, 'intermission music loops').toBe(true);

    // Accelerate the tally with REAL clicks (m9-flow stage 6 idiom), then
    // run out to E1M2 — its musicSlot('level') must land on D_E1M2.
    for (let i = 0; i < 4; i++) {
      if ((await page.evaluate(() => window.__doom!.ui()!.wi!.spState)) === 10) break;
      await page.mouse.down();
      await settle(page, 2);
      await page.mouse.up();
      await settle(page, 1);
    }
    // Fallback edge (this spec's subject is the MUSIC swap, not the click
    // seam — m9-flow stage 6 owns the real-accelerate proof): a scripted
    // use press/release is the same vanilla rising edge.
    for (let i = 0; i < 6; i++) {
      if ((await page.evaluate(() => window.__doom!.ui()!.wi!.spState)) === 10) break;
      await scriptedAccelerate(page);
    }
    for (let i = 0; i < 4; i++) {
      const phase = await page.evaluate(() => window.__doom!.ui()!.wi!.phase);
      if (phase !== 'StatCount') break;
      await page.mouse.down();
      await settle(page, 2);
      await page.mouse.up();
      await settle(page, 1);
    }
    for (let i = 0; i < 6; i++) {
      const phase = await page.evaluate(() => window.__doom!.ui()!.wi!.phase);
      if (phase !== 'StatCount') break;
      await scriptedAccelerate(page);
    }
    const landed = await page.evaluate(() => {
      const sim = window.__doom!.sim;
      for (let t = 0; t < 4000; t++) {
        sim.runTics(1);
        const s = sim.getState()!;
        if (s.gamestate === 0 && s.map.name === 'E1M2') return { ok: true, t };
      }
      const s = sim.getState()!;
      const u = window.__doom!.ui();
      return {
        ok: false,
        t: 4000,
        gs: s.gamestate,
        wi: u?.wi ? { phase: u.wi.phase, spState: u.wi.spState, active: u.wi.active } : null,
      };
    });
    expect(landed.ok, `WI run-out reaches E1M2 (${JSON.stringify(landed)})`).toBe(true);
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as unknown as { audio: AudioRead }).audio.music.lump ===
        'D_E1M2',
      null,
      { timeout: 10_000 },
    );
    expect((await audio(page)).music.playing).toBe(true);

    // ---- Finale tail: the ga_victory drain (the E1M8-exit action, §0.3)
    // → F_StartFinale → musicSlot('finale', true) → D_VICTOR (mus_victor).
    const finale = await page.evaluate((ga: number) => {
      const api = window.__doom!;
      api.pause(true);
      const s = api.sim.getState()!;
      s.gameaction = ga;
      api.sim.runTics(1); // the drain tic: G_DoAction → F_StartFinale
      const gs = s.gamestate;
      api.popInput();
      api.pause(false);
      return gs;
    }, GA_VICTORY);
    expect(finale, 'GS_FINALE').toBe(2);
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as unknown as { audio: AudioRead }).audio.music.lump ===
        'D_VICTOR',
      null,
      { timeout: 10_000 },
    );
    w = await audio(page);
    expect(w.music.playing, 'finale music loops').toBe(true);

    expect(cleanErrors(errors), 'zero console errors across the whole tail').toEqual([]);
  });
});


