/**
 * e2e M10-10 — audio pack on the real page (task §M10-10 3):
 *
 *  1. gesture-unlock → pistol fire produces an AUDIBLE scheduled-source
 *     count through the `__doom.audio` seam (context running, sources
 *     started, zero console errors);
 *  2. the volume thermo alters the BUS GAIN observably: real F4 sound-menu
 *     keys move `state().audio.sfxVolume` AND `sfxBusGain` by the exact
 *     D-10d law (thermo*8/127);
 *  3. music starts on the title after interaction — RUNS AS AN EXPECTED
 *     FAILURE (FINDING M10-10-A): no production composer installs the M10-08
 *     music selector (`installMusicSelector`/`registerWiringMusicConsumer`/
 *     `setMusicWad` are referenced by NO src file outside musicSelect itself
 *     and its unit tests), so `state().audio.music` never leaves
 *     {lump:null, playing:false} in the browser. When the wiring lands,
 *     this spec flips to "unexpected pass" and the marker gets deleted.
 *
 * Headless chromium runs a REAL AudioContext (null sink) — nothing mocked;
 * the muted-boot contract of the older suites is unchanged (no setTestMute
 * anywhere).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test } from '@playwright/test';

import { enterPlay } from './playstart';

interface AudioWiringRead {
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

interface SfxDebugState {
  context: string;
  sourcesCreated: number;
  sourcesStarted: number;
  activeChannels: number;
  missingLumps: number;
}

async function boot(page: import('@playwright/test').Page): Promise<string[]> {
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

const audio = (page: import('@playwright/test').Page): Promise<AudioWiringRead> =>
  page.evaluate(
    () =>
      (window.__doom!.state() as unknown as { audio: AudioWiringRead }).audio,
  );

const sfxCensus = (page: import('@playwright/test').Page): Promise<SfxDebugState> =>
  page.evaluate(
    () =>
      (
        window.__doom as unknown as {
          audio: () => SfxDebugState;
        }
      ).audio(),
  );

test.describe('M10-10 audio pack (L1 offline corpus companion on the live page)', () => {
  test('gesture-unlock → pistol fire schedules audible sources', async ({ page }) => {
    const errors = await boot(page);
    await enterPlay(page);

    // Pre-gesture census: nothing started, context not running.
    let a = await sfxCensus(page);
    expect(a.sourcesStarted).toBe(0);

    await page.evaluate(() => window.__doom!.sim.giveWeapon(1));
    await page.waitForFunction(
      () =>
        (window.__doom!.state() as { player: { readyweapon: number } }).player
          .readyweapon === 1,
      null,
      { timeout: 10_000 },
    );

    // The REAL trusted keydown is the autoplay gesture; held fire shoots.
    await page.keyboard.down('ControlRight');
    await page.waitForFunction(
      () =>
        (
          window.__doom as unknown as { audio: () => SfxDebugState }
        ).audio().sourcesStarted > 0,
      null,
      { timeout: 10_000 },
    );
    await page.keyboard.up('ControlRight');
    a = await sfxCensus(page);
    expect(a.context).toBe('running');
    expect(a.sourcesStarted).toBeGreaterThanOrEqual(1);
    expect(a.sourcesCreated).toBeGreaterThanOrEqual(a.sourcesStarted);
    expect(a.missingLumps).toBe(0);

    // The wiring read-view agrees, and the gesture flipped the bus graph live.
    const w = await audio(page);
    expect(w.context).toBe('running');
    expect(w.sfxBusGain).toBeCloseTo(64 / 127, 6); // thermo 8 ×8 / 127 (D-10d)
    expect(w.muted).toBe(false);

    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  });

  test('sound-menu thermo keys move sfxVolume AND the bus gain (exact law)', async ({
    page,
  }) => {
    const errors = await boot(page);
    await enterPlay(page);

    const before = await audio(page);
    expect(before.sfxVolume).toBe(8); // m_misc default
    expect(before.sfxBusGain).toBeCloseTo(64 / 127, 6);

    // F4 = the sound-volume control panel (m_menu.c:656-672), itemOn = sfx.
    const menuName = () =>
      page.evaluate(() => window.__doom!.ui?.()?.menu?.menuName ?? null);
    await page.keyboard.press('F4');
    await page.waitForFunction(
      () =>
        (
          window.__doom as unknown as {
            ui: () => { menu?: { menuName: string } } | null;
          }
        ).ui()?.menu?.menuName === 'SoundDef',
      null,
      { timeout: 10_000 },
    );
    expect(await menuName()).toBe('SoundDef');
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(
      () =>
        (
          window.__doom!.state() as unknown as { audio: { sfxVolume: number } }
        ).audio.sfxVolume < 8,
      null,
      { timeout: 10_000 },
    );
    const after = await audio(page);
    expect(after.sfxVolume).toBe(7);
    expect(after.sfxInternal).toBe(56); // D-10d: thermo*8
    expect(after.sfxBusGain).toBeCloseTo(56 / 127, 6);
    // music side untouched by the sfx thermo
    expect(after.musicVolume).toBe(before.musicVolume);

    // And back up (the → key of the same thermo row).
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(
      () =>
        (
          window.__doom!.state() as unknown as { audio: { sfxVolume: number } }
        ).audio.sfxVolume === 8,
      null,
      { timeout: 10_000 },
    );
    const restored = await audio(page);
    expect(restored.sfxBusGain).toBeCloseTo(64 / 127, 6);
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  });

  test('music starts on the title after interaction', async ({ page }) => {
    // FINDING M10-10-A (reported, NOT fixed — src is out of this task's
    // ownership): the M10-08 music lifecycle exists and is unit-green, but
    // NO production file installs it (musicEventListener is never attached
    // as a wiring music consumer; registerAudioCensus never registers the
    // music census). Until that lands, this MUST fail — kept as an
    // expected-failure so the pack stays honest and the fix is obvious.
    test.fail(
      true,
      'FINDING M10-10-A: no src composer installs musicSelect (grep registerWiringMusicConsumer src → only wiring.ts itself + tests); state().audio.music stays {lump:null, playing:false} in the browser',
    );
    const errors = await boot(page);
    // A real key unlocks the context; the title attract already emitted
    // musicSlot('title') → with a selector installed the census must show
    // the D_INTRO song playing (one-shot per d_main.c:477).
    await page.keyboard.press('Space');
    await page.waitForFunction(
      () =>
        (
          window.__doom as unknown as { audio: { unlock(): void } }
        ).audio.unlock() !== undefined,
      null,
      { timeout: 10_000 },
    );
    await page.waitForFunction(
      () =>
        (
          window.__doom!.state() as unknown as {
            audio: { music: { playing: boolean } };
          }
        ).audio.music.playing === true,
      null,
      { timeout: 15_000 },
    );
    const w = await audio(page);
    expect(w.music.lump).toBe('D_INTRO');
    expect(w.music.paused).toBe(false);
    expect(errors.filter((e) => !e.includes('favicon'))).toEqual([]);
  });
});
