/**
 * e2e automap (M2-09 skeleton, hardened for M2-10): real keyboard events
 * with 35 Hz-aware timing, `__doom.state()` deltas as the sim-side ground
 * truth, and zero console errors across every flow.
 *
 * Hardening deltas (M2-10 acceptance 3):
 *  * TAB is asserted as an OPENS/CLOSES pair: closing now reveals the 3D
 *    walls frame (M3-07 boot switch; the M2 black-placeholder expectation
 *    lived here while the automap booted ON by default) and re-opening
 *    restores the EXACT pre-Tab frame hash (AM_EndKey/AM_StartKey save+
 *    restore of scale + location, am_map.c — an unmoved player must land
 *    byte-identical).
 *  * hold-W uses the `state()` snapshot (not only sim internals) for the
 *    position delta + hash delta.
 *  * NEW: hold-ArrowRight samples raw BAM angles across the hold — the
 *    unwrapped deltas must be strictly negative (vanilla turn-right
 *    decrements angle_t; G_BuildTiccmd's 5-tic 320→640 turnheld ramp makes
 *    each per-sample delta negative regardless of sampling phase).
 *  * NEW: '0' (AM_GOBIGKEY) reveals the whole map (reds pixel count jumps)
 *    and the second press round-trips the zoom scale (reds back within 10%
 *    — NOT byte-exact: faithful AM_restoreScaleAndLoc follow-centers on the
 *    raw mo->x, a documented vanilla quirk).
 *
 * Palette math is done in-page from the actual PLAYPAL bank 0: red-family
 * pixels are those whose RGB equals palette indices 176..191 (WALLCOLORS +
 * lightlev, am_map.c REDS/REDRANGE). The WAD is the pinned
 * wads/freedoom1.wad; skipped (like the viewer spec) when absent.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { enterPlay } from './playstart';

async function wadMissing(page: Page): Promise<boolean> {
  const res = await page.request.get('/wads/freedoom1.wad');
  return !res.ok();
}

/** Console-error collector; returns the live list. */
function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

async function frameHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('no canvas');
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let h = 2166136261 >>> 0;
    for (let i = 0; i < data.length; i += 4) {
      h = Math.imul(h ^ data[i]!, 16777619);
      h = Math.imul(h ^ data[i + 1]!, 16777619);
      h = Math.imul(h ^ data[i + 2]!, 16777619);
    }
    return (h >>> 0).toString(16);
  });
}

/** {index counts} for red-family / WHITE(=209, player arrow) / total black pixels. */
async function pixelStats(page: Page): Promise<{ reds: number; whites: number; nonBlack: number; total: number }> {
  const lut = await page.evaluate(async () => {
    // Exact palette RGB for the red family (indices 176..191) and WHITE
    // (209) — decoded from the served WAD itself (browser-cached fetch).
    const buf = await (await fetch('/wads/freedoom1.wad')).arrayBuffer();
    const view = new DataView(buf);
    const n = view.getInt32(4, true);
    const dir = view.getInt32(8, true);
    let found = -1;
    for (let i = 0; i < n; i++) {
      const nameOff = dir + i * 16 + 8; // name field = entry offset 8
      if (
        String.fromCharCode(
          view.getUint8(nameOff),
          view.getUint8(nameOff + 1),
          view.getUint8(nameOff + 2),
          view.getUint8(nameOff + 3),
          view.getUint8(nameOff + 4),
          view.getUint8(nameOff + 5),
          view.getUint8(nameOff + 6),
          view.getUint8(nameOff + 7)
        ).startsWith('PLAYPAL')
      ) {
        found = i; // last match wins (R01 §15)
      }
    }
    if (found < 0) throw new Error('PLAYPAL not found');
    const pos = view.getInt32(dir + found * 16, true); // filepos = entry offset 0
    const out: Record<string, number[]> = {};
    const grab = (idx: number): number[] => [view.getUint8(pos + idx * 3)!, view.getUint8(pos + idx * 3 + 1)!, view.getUint8(pos + idx * 3 + 2)!];
    for (let i = 176; i < 192; i++) out[String(i)] = grab(i);
    out['209'] = grab(209);
    return out;
  });
  return page.evaluate(
    ([table]) => {
      const canvas = document.querySelector('canvas') as HTMLCanvasElement;
      const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      const key = (r: number, g: number, b: number): string => `${r},${g},${b}`;
      const redKeys = new Set<string>();
      for (let i = 176; i < 192; i++) {
        const c = (table as Record<string, number[]>)[String(i)]!;
        redKeys.add(key(c[0]!, c[1]!, c[2]!));
      }
      const white = (table as Record<string, number[]>)[String(209)]!;
      const whiteKey = key(white[0]!, white[1]!, white[2]!);
      let reds = 0;
      let whites = 0;
      let nonBlack = 0;
      const total = canvas.width * canvas.height;
      for (let i = 0; i < d.length; i += 4) {
        const k = key(d[i]!, d[i + 1]!, d[i + 2]!);
        if (redKeys.has(k)) reds++;
        if (k === whiteKey) whites++;
        if (k !== '0,0,0') nonBlack++;
      }
      return { reds, whites, nonBlack, total };
    },
    [lut] as const
  );
}

/** Snapshot of the 48x48 window around the arrow (screen center area). */
async function arrowRegionHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const d = canvas.getContext('2d')!.getImageData(136, 60, 48, 48).data; // x 136..184, y 60..108
    let h = 2166136261 >>> 0;
    for (let i = 0; i < d.length; i += 4) h = Math.imul(h ^ d[i]!, 16777619);
    return (h >>> 0).toString(16);
  });
}

/** __doom.state() ready-branch player fields (null while not ready). */
function statePlayer(page: Page): Promise<{ x: number; y: number; hash: number } | null> {
  return page.evaluate(() => {
    const s = window.__doom!.state();
    return s.ready ? { x: s.player.x, y: s.player.y, hash: s.hash } : null;
  });
}

/** Raw BAM angle of player 1 (u32 as number). */
const playerAngleBam = (page: Page): Promise<number> =>
  page.evaluate(() => window.__doom!.sim.getState()!.players[0]!.mo.angle >>> 0);

/**
 * Resume, park at EXACTLY `target` leveltime and pause again (the
 * physics.spec runTo pattern — the same-frame pause means no tic can
 * interleave with the read). M9-fix: with enterPlay (not the page load)
 * starting the world clock, this spec's byte-exact Tab round-trip must be
 * pinned in TICS, not wall clock — the ST face widget repaints a
 * different blink pose on some idle redraws (stTicker runs per LIVE tic,
 * one art change measured at tic ~100), and any sample straddling one of
 * those boundaries is a different frame. runTo freezes the face clock
 * between every assertion (and the slow 28MB pixelStats LUT fetch —
 * rendering keeps running under pause, §7).
 */
function runTo(page: Page, target: number): Promise<void> {
  return page.evaluate(
    (t: number) =>
      new Promise<void>((resolve) => {
        const api = window.__doom!;
        const check = (): void => {
          if ((api.sim.getState()?.leveltime ?? 0) >= t) {
            api.pause(true);
            resolve();
          } else {
            requestAnimationFrame(() => check());
          }
        };
        api.pause(false);
        check();
      }),
    target
  );
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
  // M9 boot flow: TITLEPIC first — deterministic enter-play (e2e/playstart.ts).
  await enterPlay(page);
  // Settle: live to a PINNED leveltime 24, paused there. The ST face
  // paints its first real art at the first idle redraw (tic ~17, the
  // M9-fix flake was a sample landing before it — blank vs face, 578 px
  // inside the face rect); 24 is past it, and the pause stops the blink
  // clock for everything below.
  await runTo(page, 24);
  // M3-07 boot switch: the page boots into the 3D walls view (the M2
  // automap-by-default amStart call is gone) — TAB opens the automap.
  await page.keyboard.press('Tab');
  await runTo(page, 28); // > 4 tics: the open event is drained
}

test.describe('automap boot + interaction', () => {
  test('spawn pixels, Tab off→3D walls, Tab on→byte-exact restore, clean console', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    const consoleErrors = trackConsole(page);

    await boot(page);

    // (1) deterministic spawn automap view: red walls + white arrow present
    const s1 = await pixelStats(page);
    expect(s1.nonBlack).toBeGreaterThan(1000);
    expect(s1.reds, `red-family pixel count out of range: ${s1.reds}`).toBeGreaterThan(900);
    expect(s1.reds).toBeLessThan(2500);
    expect(s1.whites, 'player arrow (WHITE) must be visible').toBeGreaterThan(0);

    // (2) stability: the settled follow view must not flicker between frames
    const settled = await frameHash(page);
    await page.waitForTimeout(120);
    expect(await frameHash(page), 'settled automap view must be stable').toBe(settled);

    // (3) TAB closes: the map-off frame is the 3D walls view (M3-07 boot
    // switch — the black placeholder buffer is gone; byte-exact
    // walls↔automap round-trips live in e2e/walls.spec.ts). The event is
    // queued while paused and consumed by the pinned 6-tic run below.
    await page.keyboard.press('Tab');
    await runTo(page, 34); // > 4 tics: the close event is drained
    expect(await frameHash(page), 'Tab must change the frame').not.toBe(settled);
    expect((await pixelStats(page)).nonBlack, 'map-off = 3D walls frame').toBeGreaterThan(1000);

    // (4) TAB re-opens: AM_Start restores the saved scale+location — with an
    // unmoved player the frame must come back BYTE-EXACT.
    await page.keyboard.press('Tab');
    await runTo(page, 40); // > 4 tics: the open event is drained
    expect(await frameHash(page), 'Tab re-open must restore the exact saved view').toBe(settled);

    // (5) state() live + clean console
    const st = await statePlayer(page);
    expect(st, 'state() must be ready after boot').not.toBeNull();
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('zoom, W move (state deltas), ArrowRight turn monotonic, 0 go-big, clean console', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    const consoleErrors = trackConsole(page);

    await boot(page);
    // The boot hands back a PAUSED world at leveltime 28 (test 1 pins its
    // samples in tics) — this flow drives REAL held keys over wall-clock
    // windows, so hand the live loop back.
    await page.evaluate(() => window.__doom!.pause(false));

    // (1) zoom in well past the entry scale (hold '=' ⇒ 2%/tic,
    // M_ZOOMIN — ~6 s ≈ 1.02^210 ≈ 60x) so follow-mode tracking is provable
    // at ≥1 px/unit.
    await page.keyboard.down('Equal');
    await page.waitForTimeout(6000);
    await page.keyboard.up('Equal');
    await page.waitForTimeout(150);

    // (2) noclip + hold W: state() snapshot position AND arrow-region
    // pixels must both move (follow window tracks the player).
    await page.evaluate(() => window.__doom!.sim.setNoclip(true));
    const before = await arrowRegionHash(page);
    const posBefore = await statePlayer(page);
    expect(posBefore).not.toBeNull();
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(500); // ≈17 tics at 35 Hz
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(120);
    const posAfter = await statePlayer(page);
    expect(posAfter).not.toBeNull();
    expect(
      Math.abs(posAfter!.x - posBefore!.x) + Math.abs(posAfter!.y - posBefore!.y),
      'holding W must move the player (state() delta)'
    ).toBeGreaterThan(65536);
    expect(posAfter!.hash, 'state() hash must change with movement').not.toBe(posBefore!.hash);
    expect(await arrowRegionHash(page), 'arrow-region pixels must change').not.toBe(before);

    // (3) hold ArrowRight ~15 tics: unwrapped BAM deltas strictly negative
    // (turn-right decrements angle_t), frame repaints the rotated arrow.
    const samples: number[] = [];
    await page.keyboard.down('ArrowRight');
    for (let i = 0; i < 5; i++) {
      samples.push(await playerAngleBam(page));
      await page.waitForTimeout(100);
    }
    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(100);
    for (let i = 1; i < samples.length; i++) {
      const delta = (samples[i]! - samples[i - 1]!) >>> 0; // u32 wrap-aware
      const signed = delta >= 0x80000000 ? delta - 0x100000000 : delta;
      expect(signed, `ArrowRight sample ${i}: angle must decrease (right turn)`).toBeLessThan(0);
    }

    // (4) '0' go-big reveals the whole map (red pixels jump). The second
    // press restores the saved scale — but NOT byte-exact: faithful
    // AM_restoreScaleAndLoc centers follow mode on the RAW mo->x while the
    // settled follow view uses the FTOM(MTOF(x)) round-trip (deliberately
    // not the identity — sim/amMap.ts header), so the restored view may sit
    // a sub-pixel off. Assert the scale round-trip via the red-pixel count.
    const preBig = await frameHash(page);
    const redsBefore = (await pixelStats(page)).reds;
    await page.keyboard.press('Digit0');
    await page.waitForTimeout(150);
    const big = await pixelStats(page);
    const bigHash = await frameHash(page);
    expect(bigHash).not.toBe(preBig);
    expect(big.reds, `'0' must reveal the whole map (reds ${redsBefore} → ${big.reds})`).toBeGreaterThan(
      redsBefore
    );
    await page.keyboard.press('Digit0');
    await page.waitForTimeout(150);
    const restored = await frameHash(page);
    expect(restored, "second '0' must leave the whole-map view").not.toBe(bigHash);
    const redsRestored = (await pixelStats(page)).reds;
    expect(
      Math.abs(redsRestored - redsBefore),
      `restored zoom must match prior scale within 10% (reds ${redsBefore} → ${redsRestored})`
    ).toBeLessThan(Math.max(16, Math.floor(redsBefore * 0.1)));

    // (5) zero console errors across the whole flow
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
