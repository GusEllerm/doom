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
 *     WHITE arrow pixels present), and closing restores every pixel the 3D
 *     pass paints (M4-07 dropped the background clear — vanilla has none —
 *     so pixels the 3D frame leaves BLACK may keep overlay residue; see the
 *     in-test comment);
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
import { enterPlay } from './playstart';

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
  /** non-black pixels of the TOP 20 rows (M4-08: sky/outdoor band). */
  topBand: number;
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
    let topBand = 0;
    const counts = new Map<number, number>();
    for (let i = 0; i < cap.indices.length; i++) {
      const v = cap.indices[i]!;
      h = Math.imul(h ^ v, 16777619);
      if (v !== 0) {
        nonBlack++;
        if (i < 320 * 20) topBand++;
      }
      counts.set(v, (counts.get(v) ?? 0) + 1);
      if (v >= 176 && v < 192) reds++;
      if (v === 209) whites++;
    }
    let distinct = 0;
    for (const [v, n] of counts) if (v !== 0 && n >= 50) distinct++;
    return { hash: (h >>> 0).toString(16), nonBlack, distinct, topBand, reds, whites };
  });
}

/**
 * M10-10 FLAKE FIX (part 1/2) — state-predicate wait: two ADJACENT rAF
 * polls hash equal (a settled screen — the byte-determinism claim, now
 * proven by the wait itself), plus the automap overlay pixels for mode
 * 'on' (WALLCOLORS 176..191 > 100 AND WHITE 209 > 0) and frame-differs-
 * from-`notHash` for mode 'off'. A Tab toggle is EVENT-level (keydown →
 * eventQueue → next consumed tic → next renderFrame); fixed sleeps raced
 * that chain. With the world PARKED (`runTo`) every post-runTo frame is
 * identical, so these waits resolve in ~2 rAFs.
 */
async function waitSettled(
  page: Page,
  mode: 'any' | 'on' | 'off' = 'any',
  notHash?: string
): Promise<void> {
  await page.waitForFunction(
    ([m, bad]) => {
      const cap = window.__doom!.capture();
      let h = 2166136261 >>> 0;
      let reds = 0;
      let whites = 0;
      for (let i = 0; i < cap.indices.length; i++) {
        const v = cap.indices[i]!;
        h = Math.imul(h ^ v, 16777619);
        if (v >= 176 && v < 192) reds++;
        else if (v === 209) whites++;
      }
      const hash = (h >>> 0).toString(16);
      const store = window as unknown as Record<string, string | undefined>;
      const settled = store.__wallsSettledHash === hash;
      store.__wallsSettledHash = hash;
      if (!settled || hash === bad) return false;
      if (m === 'on') return reds > 100 && whites > 0;
      return true;
    },
    [mode, notHash ?? null] as [string, string | null],
    { timeout: 15_000 }
  );
}

/**
 * M10-10 FLAKE FIX (part 2/2) — the tic-pin pattern from e2e/automap.spec
 * (M9-fix): resume, park at EXACTLY `target` leveltime and pause again.
 * The measured root cause of this spec's overPainted flake is the E1M1
 * spawn vista's ~30-tic sector-LIGHT special (a 3.7k-pixel, rows 52..113
 * repaint every ~30 live tics): whenever the stash→close window happened
 * to straddle a phase step, pixels the 3D pass legitimately repaints with
 * a NEW light level counted as "overlay residue". Parking in TICS (never
 * wall clock) makes the window's world advance exact, and the Tab events
 * queue while paused and drain on the first live tic after the resume.
 */
function runTo(page: Page, target: number): Promise<void> {
  return page.evaluate(
    (t: number) =>
      new Promise<void>((resolve) => {
        const api = window.__doom!;
        const start = api.sim.getState()?.leveltime ?? 0;
        const check = (): void => {
          const lt = api.sim.getState()?.leveltime ?? 0;
          // `lt > start` guarantees ≥ 1 live tic per call — a queued key
          // event ALWAYS drains (a bare `lt >= t` park could resume and
          // re-pause inside a single rAF and strand the event forever).
          if (lt >= t && lt > start) {
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

const leveltime = (page: Page): Promise<number> =>
  page.evaluate(() => window.__doom!.sim.getState()?.leveltime ?? 0);

/** Live state().render COUNTERS (null while state() is not ready). The
 * B-07/B-08 sprite fingerprint field (state().render.sprites) is
 * deliberately excluded — this helper's contract is the five counters. */
function renderCounters(page: Page): Promise<{
  hom: number;
  visplaneOverflow: number;
  visspriteOverflow: number;
  openingOverflow: number;
  drawsegOverflow: number;
} | null> {
  return page.evaluate(() => {
    const s = window.__doom!.state();
    if (!s.ready) return null;
    const { sprites, ...counters } = s.render;
    void sprites;
    return counters;
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

/** Keep a copy of the current capture in a page global (the diff below runs
 * in-page, so 64000 bytes never cross the wire). */
function stashFrame(page: Page, key: string): Promise<number> {
  return page.evaluate((k: string) => {
    const store = window as unknown as Record<string, Uint8Array>;
    store[k] = window.__doom!.capture().indices.slice();
    return store[k]!.length;
  }, key);
}

/** Compare the live capture against a stashed one, in-page. */
function diffAgainstStashed(page: Page, key: string): Promise<{
  differing: number;
  overPainted: number;
  samples: string[];
}> {
  return page.evaluate((k: string) => {
    const store = window as unknown as Record<string, Uint8Array>;
    const before = store[k]!;
    const now = window.__doom!.capture().indices;
    let differing = 0;
    let overPainted = 0;
    const samples: string[] = [];
    for (let i = 0; i < now.length; i++) {
      if (now[i] === before[i]) continue;
      differing++;
      // Rows 168+ belong to the STATUSBAR drawer, not the 3D pass — and
      // ST legitimately re-rolls the idle face every
      // ST_STRAIGHTFACECOUNT=17 tics (vanilla P_Random & 3). The 3D
      // round-trip contract below is only about rows 0..167.
      if (before[i] !== 0 && Math.floor(i / 320) < 168) {
        overPainted++;
        if (samples.length < 6) samples.push(`r${Math.floor(i / 320)}c${i % 320}:${before[i]}->${now[i]}`);
      }
    }
    return { differing, overPainted, samples };
  }, key);
}

async function boot(page: Page): Promise<void> {
  await page.goto('/?test=1');
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
  // M9 boot flow: TITLEPIC attract first — enter play so the warp/capture
  // pins and the Tab overlay below run against the LIVE 3D game.
  await enterPlay(page);
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
    // Flake fix: PARK at an exact tic (was a 150 ms sleep — the frame was
    // still mid-blink/mid-light-phase sometimes). Rendering keeps running
    // under pause (§7), so wait for the parked viewpoint to land.
    await runTo(page, (await leveltime(page)) + 40);
    await waitSettled(page);

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

    // M4-07 raises the painted share of a frame enormously (planes): the
    // M3 walls-only spawn frame had ~1.1k non-black pixels, the integrated
    // frame paints the room around the player.
    expect(cap1.nonBlack, 'the integrated frame must paint the view').toBeGreaterThan(20_000);

    // (3) Tab opens the automap OVER the 3D pass: pixel diff vs the 3D
    // frame, automap line-red + WHITE arrow pixels present (the drawer
    // clears the buffer with BACKGROUND first — vanilla AM_Drawer).
    //
    // M4-07 note (behaviour rename, plan §1.2): renderFrame no longer
    // clears the background, so the round trip is no longer BYTE-EXACT —
    // vanilla clears nothing either, and wherever the 3D pass leaves the
    // genuine void (never-painted pixels) the overlay's own background
    // residue may linger. What MUST hold (and is checked): everywhere the
    // 3D pass paints, the pre-Tab pixel is restored exactly; only pixels
    // that were void (black) before Tab may differ, and the reopened frame
    // is deterministic again.
    //
    // M10-10 FLAKE FIX (measured): the FORWARD spawn vista is never quiet
    // for a 4-tic round-trip window — the start-room torch flames
    // (columns 99/218, rows 104..106) step their animation every ≈ 6 tics
    // and the entry light special runs until ≈ tic 45 — so a stash→close
    // window straddling a step counted 2…3.7k legitimately re-lit/animated
    // pixels as “residue” (the flake). The cycle therefore runs at the
    // first viewpoint whose 3D pass is a fixed point over the window
    // (spawn angle, then the three quarter-turns), parked in TICS via
    // runTo (events queue while parked and drain on the first live tic —
    // the automap.spec M9-fix pattern). A genuine residue bug sticks in
    // EVERY phase and angle, so the min-over-attempts assertion below
    // stays a real contract.
    const angles = [0, 180, 90, 270];
    let best = { overPainted: Number.POSITIVE_INFINITY, samples: [] as string[] };
    let attempts = 0;
    angleLoop: for (const turn of angles) {
      await page.evaluate((deg: number) => {
        const s = window.__doom!.state();
        if (!s.ready) throw new Error('state() not ready');
        window.__doom!.warp(s.player.x, s.player.y, 0, (s.player.angleDeg + deg) % 360);
      }, turn);
      if (attempts === 0) await runTo(page, (await leveltime(page)) + 40); // let the entry special settle
      for (let phaseTry = 0; phaseTry < 6; phaseTry++) {
        const t = (await leveltime(page)) + 1;
        await runTo(page, t); // park; the stash below is at an EXACT tic
        await stashFrame(page, '__wallsPreTab');
        const preHash = (await captureStats(page)).hash;

        await page.keyboard.press('Tab'); // queued while parked
        await runTo(page, t + 2); // drains the event on the first live tic
        await waitSettled(page, 'on'); // overlay pixels present (no sleep)
        const amCap = await captureStats(page);
        expect(amCap.hash, 'Tab must change the frame').not.toBe(preHash);
        expect(amCap.reds, 'automap wall lines must be present when open').toBeGreaterThan(100);
        expect(amCap.whites, 'player arrow (WHITE) must be present when open').toBeGreaterThan(0);

        await page.keyboard.press('Tab'); // queued while parked
        await runTo(page, t + 4); // close drains + renders
        await waitSettled(page, 'off', amCap.hash); // 3D repainted (no sleep)
        const restore = await diffAgainstStashed(page, '__wallsPreTab');
        attempts++;
        if (restore.overPainted < best.overPainted) best = restore;
        if (restore.overPainted === 0) break angleLoop;
        await runTo(page, t + 5); // window crossed a world phase: slide on
      }
    }
    expect(
      best.overPainted,
      `closing the automap must restore every pixel the 3D pass paints (${attempts} parked windows tried; first: ${best.samples.join(', ')})`
    ).toBe(0);
    // `differing` > 0 is expected: it is exactly the set of pixels the 3D
    // pass never touches (the void-pixel finding of the M4-07 report). What
    // must NEVER happen is a differing pixel the 3D pass HAD painted
    // (overPainted, asserted 0 above) — that would mean overlay residue had
    // stuck to a live pixel. The closed frame must be the 3D frame again.
    const restored1 = await captureStats(page);
    const restored2 = await captureStats(page);
    expect(restored2.hash, 'the reopened 3D frame must be deterministic again').toBe(restored1.hash);

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
        // (b2) M4-08 pixel band: the outdoor courtyard viewpoint stands IN a
        // F_SKY1 sector — the top 20 rows must be sky-drawn, not the M3
        // black band (derivation: viewpoints.ts, e1m1-court-sky; a
        // removed-SKY1 render diff shows ~37.6k sky pixels here).
        if (vp.name === 'e1m1-court-sky') {
          expect(cap1.topBand, `${vp.name}: sky band must paint the top rows (got ${cap1.topBand}/6400)`).toBeGreaterThan(3000);
        }
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
