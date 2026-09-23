/**
 * e2e M10-06 — L4: the WebAudio SFX driver over the REAL page (M10-plan
 * §M10-06 acceptance 3/5 + the no-leak soak; M10-11 owns the full
 * m10-audio.spec).
 *
 * Asserted through the `__doom.audio` debug seam (the shape sfxDriver
 * exports; M10-09 moves it under state().audio):
 *  1. pistol fire (REAL gesture key + real held-fire) ⇒ AudioContext
 *     active + scheduled sources (sourcesStarted/sourcesCreated spy
 *     counters) + the tic-boundary schedule delta < 20 ms (acceptance 5);
 *  2. listener tracking (warp ⇒ audio().listener follows players[0].mo);
 *  3. level change ⇒ stop-all (S_Start channel-kill: activeChannels 0,
 *     every voice stopped);
 *  4. soak: ~300 scripted-fire tics drained live ⇒ every created source
 *     started AND ended AND disconnected (sourcesDisconnected ==
 *     sourcesCreated, activeVoices 0) — the no-leak census;
 *  5. zero console errors across the whole page life (the existing
 *     no-audio/headless contract is the rest of the suite).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test } from '@playwright/test';

import { enterPlay } from './playstart';

const F = 65_536;

interface AudioSeam {
  context: 'absent' | 'unbuilt' | 'suspended' | 'running';
  volume: number;
  busGain: number;
  activeVoices: number;
  activeChannels: number;
  sourcesCreated: number;
  sourcesStarted: number;
  sourcesStopped: number;
  sourcesDisconnected: number;
  missingLumps: number;
  allocatorDrops: number;
  unknownNames: number;
  queuedEvents: number;
  queueDrops: number;
  listener: { x: number; y: number };
  lastSchedDelta: number;
  tic: number;
}

async function boot(page: import('@playwright/test').Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, {
    timeout: 30_000
  });
  await page.waitForFunction(
    () => (window.__doom as unknown as { audio?: unknown }).audio !== undefined,
    null,
    { timeout: 10_000 }
  );
  return errors;
}

function audio(page: import('@playwright/test').Page): Promise<AudioSeam> {
  return page.evaluate(
    () =>
      (
        window.__doom as unknown as {
          audio: () => AudioSeam;
        }
      ).audio()
  );
}

test.describe('M10-06 sfx driver (L4)', () => {
  test('pistol fire unlocks the context, schedules sources, tracks the listener, stops on level change', async ({
    page
  }) => {
    const errors = await boot(page);
    await enterPlay(page);

    // Pre-gesture: nothing was ever created (the silent boot contract).
    let a = await audio(page);
    expect(a.sourcesCreated).toBe(0);
    expect(['absent', 'unbuilt', 'suspended']).toContain(a.context);

    // Arm the pistol and raise it on the live loop.
    await page.evaluate(() => window.__doom!.sim.giveWeapon(1));
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as { player: { readyweapon: number } }).player
          .readyweapon === 1,
      null,
      { timeout: 10_000 }
    );

    // REAL gesture + fire: ControlRight = key_fire (vanilla bind) — the
    // trusted keydown IS the autoplay gesture the driver listens for.
    await page.keyboard.down('ControlRight');
    await page.waitForFunction(
      () =>
        (
          window.__doom as unknown as { audio: () => AudioSeam }
        ).audio().sourcesStarted > 0,
      null,
      { timeout: 10_000 }
    );
    await page.keyboard.up('ControlRight');
    a = await audio(page);
    expect(a.context).toBe('running'); // the AudioContext is ACTIVE
    expect(a.sourcesStarted).toBeGreaterThanOrEqual(1);
    expect(a.sourcesCreated).toBe(a.sourcesStarted);
    expect(a.sourcesStarted - a.sourcesStopped).toBeGreaterThanOrEqual(0);
    // D-10f acceptance 5: scheduled at the tic-boundary stamp, ≈ now.
    expect(Math.abs(a.lastSchedDelta)).toBeLessThan(0.02);
    expect(a.activeChannels).toBeGreaterThanOrEqual(1);

    // Listener tracking: a warp + live tics moves the spatial pose.
    await page.evaluate(() => window.__doom!.sim.warp(512, -256));
    await page.waitForFunction(
      () =>
        (
          window.__doom as unknown as { audio: () => AudioSeam }
        ).audio().listener.x === 512 * 65_536,
      null,
      { timeout: 10_000 }
    );
    a = await audio(page);
    expect(a.listener.y).toBe(-256 * F);

    // Level change (GA_NEWGAME drain on the live loop) = stop-all.
    await page.evaluate(() => {
      window.__doom!.pause(true);
      const st = window.__doom!.sim.getState()!;
      st.advancedemo = false;
      st.gameaction = 2; // ga_newgame
      window.__doom!.sim.runTics(1);
      window.__doom!.popInput();
      window.__doom!.pause(false);
    });
    await page.waitForFunction(
      () =>
        (
          window.__doom as unknown as { audio: () => AudioSeam }
        ).audio().sourcesStopped > 0 &&
        (
          window.__doom as unknown as { audio: () => AudioSeam }
        ).audio().activeChannels === 0,
      null,
      { timeout: 10_000 }
    );
    a = await audio(page);
    expect(a.activeVoices).toBe(0);

    const real = errors.filter((e) => !e.includes('favicon'));
    expect(real).toEqual([]);
  });

  test('soak: every created source ends disconnected (no leak)', async ({ page }) => {
    const errors = await boot(page);
    await enterPlay(page);
    // Gesture via a REAL key (autoplay activation), then arm the seam too
    // (unlock = ensureContext, idempotent either way).
    await page.keyboard.down('ShiftLeft');
    await page.keyboard.up('ShiftLeft');
    await page.evaluate(() => {
      (window.__doom as unknown as { audio: { unlock(): void } }).audio.unlock();
      window.__doom!.sim.giveWeapon(1);
    });
    // Scripted firefight: 300 tics of held fire (≈ 20 pistol shots at the
    // 15-tic cadence) plus drain tics, then hand the loop back.
    await page.evaluate(() => {
      window.__doom!.pause(true);
      window.__doom!.sim.runTics(30, {}); // raise
      for (let i = 0; i < 20; i++) {
        window.__doom!.sim.runTics(2, { attack: true });
        window.__doom!.sim.runTics(13, {});
      }
      window.__doom!.popInput();
      window.__doom!.pause(false);
    });
    // The live loop drains the queued ledger; sources then play out.
    await page.waitForFunction(
      () => {
        const a = (
          window.__doom as unknown as { audio: () => AudioSeam }
        ).audio();
        return (
          a.sourcesStarted >= 10 &&
          a.sourcesDisconnected === a.sourcesCreated &&
          a.activeVoices === 0 &&
          a.activeChannels === 0
        );
      },
      null,
      { timeout: 20_000 }
    );
    const a = await audio(page);
    expect(a.sourcesCreated).toBe(a.sourcesStarted);
    expect(a.missingLumps).toBe(0); // pistol/pain/etc. all have DS lumps
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  });
});
