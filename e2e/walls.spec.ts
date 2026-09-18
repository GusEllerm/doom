/**
 * e2e walls pipeline (M3-07 skeleton + M3-08 completion): the game page
 * now boots into the 3D walls view (renderFrame per ARCHITECTURE §4.1),
 * `__doom.capture()` returns the REAL rendered index buffer and
 * `__doom.state().render.hom` is the live renderer counter.
 *
 * Skeleton asserts (M3-plan §M3-07 acceptance 1–3 + 5):
 *  1. boot → dev-API warp to the spawn spot with a pinned z/angle ⇒ the
 *     capture is non-blank, NOT a single color, and deterministic across
 *     two consecutive captures (same viewpoint ⇒ same bytes, L3);
 *  2. state().render.hom === 0 (live counter, not the old −1 stub);
 *  3. Tab still toggles the automap — now drawn OVER the 3D pass
 *     (§4.1.9): the frame changes (pixel diff: automap wall-red family +
 *     WHITE arrow pixels present), and closing restores the BYTE-IDENTICAL
 *     walls frame (unmoved player, stateless pipeline);
 *  4. zero console errors across the flow.
 *
 * M3-08 adds the GOLDEN-DRIVEN check: every committed iwad viewpoint of
 * tests/render/viewpoints.ts is warped to through `__doom.warp` (same
 * deg→BAM + z semantics the node suite uses), the live frame is hashed
 * TWICE in-page (SHA-256 over the capture indices) and must (a) agree
 * with itself — same pinned viewpoint ⇒ same bytes on EVERY later frame,
 * the L3 determinism claim under a running browser loop — and (b) equal
 * the golden `indexSha256` of tests/render/goldens/walls/meta.json
 * (browser pipeline ≡ node pipeline), with `state().render.hom == 0`
 * asserted per viewpoint via `__doom.state()`.
 *
 * Palette-free pixel math: capture() exposes the raw 8-bit indices, so
 * automap colors are counted directly (WALLCOLORS family = 176..191,
 * WHITE = 209, am_map.c REDS/WHITE). The WAD is the pinned
 * wads/freedoom1.wad; skipped when absent (like the automap spec).
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { VIEWPOINTS } from '../tests/render/viewpoints';

const META_PATH = fileURLToPath(new URL('../tests/render/goldens/walls/meta.json', import.meta.url));

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

/** Live state().render.hom (null while state() is not ready). */
function renderHom(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const s = window.__doom!.state();
    return s.ready ? s.render.hom : null;
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
    // Band note: walls-only ⇒ large black floor/ceiling gaps (deviation D);
    // the pinned E1M1 spawn vista lands ≈ 4k wall pixels.
    expect(cap1.nonBlack, `walls capture too sparse: ${cap1.nonBlack}`).toBeGreaterThan(2000);
    expect(cap1.distinct, 'walls capture must not be a single color').toBeGreaterThan(1);
    expect(cap2.hash, 'same pinned viewpoint must render identical bytes').toBe(cap1.hash);

    // (2) Live hom counter (acceptance 2): 0, not the old −1 stub.
    const hom = await renderHom(page);
    expect(hom, 'state().render.hom must be live after boot').toBe(0);

    // (3) Tab opens the automap OVER the 3D pass: pixel diff vs the walls
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

  test('golden viewpoints: in-page double-render sha == golden sha, hom == 0 (M3-08)', async ({ page }) => {
    test.setTimeout(180_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    test.skip(!existsSync(META_PATH), 'walls goldens meta.json missing — run npm run goldens:update -- --set walls');
    const consoleErrors = trackConsole(page);
    const meta = JSON.parse(readFileSync(META_PATH, 'utf8')) as {
      scenes: Record<string, { indexSha256: string }>;
    };

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

        const sha1 = await captureSha(page);
        const sha2 = await captureSha(page);
        // (a) determinism under the live rAF loop: identical captures.
        expect(sha2, `${vp.name}: later frame must match the earlier one`).toBe(sha1);
        // (b) the browser pipeline reproduces the committed node golden.
        expect(sha1, `${vp.name}: live frame sha must equal the golden sha`).toBe(
          meta.scenes[vp.name]?.indexSha256
        );
        expect(await renderHom(page), `${vp.name}: state().render.hom must be live and 0`).toBe(0);
      });
    }

    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
