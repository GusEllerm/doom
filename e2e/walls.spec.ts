/**
 * e2e walls pipeline (M3-07 skeleton, M3-08 walk, M4-07 full frame): the
 * game page boots into the 3D view (renderFrame per ARCHITECTURE §4.1 —
 * now the COMPLETE frame: planes + masked middles + sprites),
 * `__doom.capture()` returns the REAL rendered index buffer and
 * `__doom.state().render` carries the live renderer counters.
 *
 * Skeleton asserts (M3-plan §M3-07 acceptance 1–3 + 5):
 *  1. boot → dev-API warp to the spawn spot with a pinned z/angle ⇒ the
 *     capture is non-blank, NOT a single color, and deterministic across
 *     two consecutive captures (same viewpoint ⇒ same bytes, L3);
 *  2. state().render.hom === 0 (live counter, not the old −1 stub);
 *  3. Tab still toggles the automap — now drawn OVER the 3D pass
 *     (§4.1.9): the frame changes (pixel diff: automap wall-red family +
 *     WHITE arrow pixels present), and closing restores the BYTE-IDENTICAL
 *     3D frame (unmoved player, stateless pipeline);
 *  4. zero console errors across the flow.
 *
 * M4-07 keeps this spec STRUCTURAL: the milestone re-bless of the golden
 * frames (the 20 M3 scenes + ≥4 new ones) is M4-08's job, and the full-frame
 * pipeline legitimately changes every frame — visplanes replace the black
 * clear and masked middles now draw. So the viewpoint walk below asserts
 * (a) the live frame reproduces its own bytes on a later frame (the L3
 * claim under a running browser loop), (b) every scene is non-blank and
 * multi-colour, and (c) all five render counters of
 * `state().render` are live and 0. NO stale golden sha is compared here.
 *
 * Palette-free pixel math: capture() exposes the raw 8-bit indices, so
 * automap colors are counted directly (WALLCOLORS family = 176..191,
 * WHITE = 209, am_map.c REDS/WHITE). The WAD is the pinned
 * wads/freedoom1.wad; skipped when absent (like the automap spec).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';

import { VIEWPOINTS } from '../tests/render/viewpoints';

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

interface CaptureStats {
  /** FNV-1a over the raw index buffer (byte identity proxy). */
  hash: string;
  nonBlack: number;
  /** nonzero palette values occupying ≥ 50 pixels (single-color test). */
  distinct: number;
  /** automap wall-red family (WALLCOLORS..+15 = 176..191). */
  reds: number;
  /** automap WHITE (209, player arrow). */
  whites: number;
}

/** __doom.capture() → the real framebuffer indices, summarized in-page. */
function captureStats(page: Page): Promise<CaptureStats> {
  return page.evaluate(() => {
    const cap = window.__doom!.capture();
    let h = 2166136261 >>> 0;
    let nonBlack = 0;
    let reds = 0;
    let whites = 0;
    const counts = new Map<number, number>();
    for (let i = 0; i < cap.indices.length; i++) {
      const v = cap.indices[i]!;
      h = Math.imul(h ^ v, 16777619);
      if (v !== 0) {
        nonBlack++;
        counts.set(v, (counts.get(v) ?? 0) + 1);
      }
      if (v >= 176 && v < 192) reds++;
      if (v === 209) whites++;
    }
    let distinct = 0;
    for (const [v, n] of counts) if (v !== 0 && n >= 50) distinct++;
    return { hash: (h >>> 0).toString(16), nonBlack, distinct, reds, whites };
  });
}

/** Live state().render (all five counters; null while state() is not ready). */
function renderCounters(page: Page): Promise<{
  hom: number;
  visplaneOverflow: number;
  visspriteOverflow: number;
  openingOverflow: number;
  drawsegOverflow: number;
} | null> {
  return page.evaluate(() => {
    const s = window.__doom!.state();
    return s.ready ? s.render : null;
  });
}

/** SHA-256 of the captured index buffer, computed IN-PAGE (crypto.subtle;
 * 127.0.0.1 is a secure context) — same bytes, same hash as node. */
function captureSha(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const cap = window.__doom!.capture();
    const digest = await crypto.subtle.digest('SHA-256', cap.indices.slice().buffer as ArrayBuffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
  // A few settling frames/tics at the spawn point before pinning.
  await page.waitForTimeout(250);
}

test.describe('walls pipeline (M3-07 skeleton)', () => {
  test('warp capture deterministic + hom live + Tab overlay round-trip, clean console', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    const consoleErrors = trackConsole(page);

    await boot(page);

    // (1) Pin the viewpoint through the dev API (x,y from the live spawn,
    // z=0 explicit, angle preserved) — renderer reads the player per frame.
    await page.evaluate(() => {
      const s = window.__doom!.state();
      if (!s.ready) throw new Error('state() not ready');
      window.__doom!.warp(s.player.x, s.player.y, 0, s.player.angleDeg);
    });
    await page.waitForTimeout(150); // ≥ 5 frames at 60 Hz

    const cap1 = await captureStats(page);
    const cap2 = await captureStats(page);

    // Non-blank, not a single color, deterministic ×2 (acceptance 1).
    // M4-07 band note: the frame is now FULL (visplanes fill the floor and
    // ceiling, masked middles and static sprites draw), so the spawn vista
    // is far denser than the ≈ 4k wall pixels the walls-only M3 frame had.
    expect(cap1.nonBlack, `walls capture too sparse: ${cap1.nonBlack}`).toBeGreaterThan(2000);
    expect(cap1.distinct, 'walls capture must not be a single color').toBeGreaterThan(1);
    expect(cap2.hash, 'same pinned viewpoint must render identical bytes').toBe(cap1.hash);

    // (2) Live render counters (acceptance 2): all five 0, not the old −1
    // stubs (M4-07 extended state().render with the overflow caps).
    const counters = await renderCounters(page);
    expect(counters, 'state().render must be live after boot').not.toBeNull();
    expect(counters, 'every render counter must be 0 at the spawn viewpoint').toEqual({
      hom: 0,
      visplaneOverflow: 0,
      visspriteOverflow: 0,
      openingOverflow: 0,
      drawsegOverflow: 0,
    });

    // (3) Tab opens the automap OVER the 3D pass: pixel diff vs the 3D
    // frame, automap line-red + WHITE arrow pixels present (the drawer
    // clears the buffer with BACKGROUND first — vanilla AM_Drawer).
    const wallsHash = cap1.hash;
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    const amCap = await captureStats(page);
    expect(amCap.hash, 'Tab must change the frame').not.toBe(wallsHash);
    expect(amCap.reds, 'automap wall lines must be present when open').toBeGreaterThan(100);
    expect(amCap.whites, 'player arrow (WHITE) must be present when open').toBeGreaterThan(0);

    // Tab closes: the SAME pinned viewpoint must come back BYTE-IDENTICAL
    // (player unmoved; renderer stateless across frames).
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
    expect((await captureStats(page)).hash, 'close must restore byte-identical walls frame').toBe(wallsHash);

    // (4) Zero console errors (acceptance 5).
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });

  test('golden viewpoints: in-page double-render sha + structural frame checks (M4-07)', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    const consoleErrors = trackConsole(page);

    await boot(page);
    // Freeze the sim tics: the golden pins a STATIC viewpoint, and pausing
    // proves the RENDER loop (which keeps running) alone reproduces bytes.
    await page.evaluate(() => window.__doom!.pause(true));

    for (const vp of VIEWPOINTS.filter((v) => v.kind === 'iwad')) {
      await test.step(vp.name, async () => {
        await page.evaluate(([x, y, z, deg]: [number, number, number | null, number]) => {
          window.__doom!.warp(x, y, z ?? undefined, deg);
        }, [(vp.x * 65536) | 0, (vp.y * 65536) | 0, vp.z === undefined ? null : (vp.z * 65536) | 0, vp.angleDeg] as [number, number, number | null, number]);
        await page.waitForTimeout(120); // ≥ 7 render frames at 60 Hz

        const cap1 = await captureStats(page);
        const sha1 = await captureSha(page);
        const sha2 = await captureSha(page);
        // (a) determinism under the live rAF loop: identical captures.
        expect(sha2, `${vp.name}: later frame must match the earlier one`).toBe(sha1);
        // (b) a real frame, not a void/flat fill. NB: no golden-sha compare —
        //     the M4 baseline is blessed by M4-08, and pixel bands moved.
        expect(cap1.nonBlack, `${vp.name}: void frame: ${cap1.nonBlack}`).toBeGreaterThan(2000);
        expect(cap1.distinct, `${vp.name}: frame must not be a single color`).toBeGreaterThan(1);
        // (c) live counters, all clean (plan §1.3 overflow gates).
        expect(
          await renderCounters(page),
          `${vp.name}: state().render counters must be live and 0`
        ).toEqual({ hom: 0, visplaneOverflow: 0, visspriteOverflow: 0, openingOverflow: 0, drawsegOverflow: 0 });
      });
    }

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
