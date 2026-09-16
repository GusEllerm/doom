/**
 * e2e automap (M2-09): boot the game page, assert deterministic automap
 * pixels for the E1M1 spawn view, noclip+hold-W movement changes both the
 * sim position and the arrow-region pixels (follow mode), Tab toggles the
 * overlay, and the console stays clean.
 *
 * Palette math is done in-page from the actual PLAYPAL bank 0: red-family
 * pixels are those whose RGB equals palette indices 176..191 (WALLCOLORS
 * + lightlev, am_map.c REDS/REDRANGE). The WAD is the pinned
 * wads/freedoom1.wad; skipped (like the viewer spec) when absent.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';

async function wadMissing(page: Page): Promise<boolean> {
  const res = await page.request.get('/wads/freedoom1.wad');
  return !res.ok();
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

test.describe('automap boot + interaction', () => {
  test('spawn view pixels, noclip movement, Tab toggle, clean console', async ({ page }) => {
    test.setTimeout(60_000);
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto('/?test=1');
    await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });
    // Let the follow-mode recenter tic + a few tics run so the view settles.
    await page.waitForTimeout(250);

    // (1) deterministic spawn automap view: red walls + white arrow present
    const s1 = await pixelStats(page);
    expect(s1.nonBlack).toBeGreaterThan(1000);
    expect(s1.reds, `red-family pixel count out of range: ${s1.reds}`).toBeGreaterThan(900);
    expect(s1.reds).toBeLessThan(2500);
    // WHITE (palette 209, the player-arrow color): the spawn-view arrow is
    // small (entry zoom ≈ 0.11 px/unit ⇒ a handful of px), assert > 0.
    expect(s1.whites, 'player arrow (WHITE) must be visible').toBeGreaterThan(0);

    // stability: the settled follow view must not flicker between frames
    const h1 = await frameHash(page);
    await page.waitForTimeout(120);
    expect(await frameHash(page), 'settled automap view must be stable').toBe(h1);

    // (2) zoom in well past the whole-map entry scale (holds '=' ⇒ 2%/tic,
    // am_map.c M_ZOOMIN — ~6 s ≈ 1.02^210 ≈ 60x), THEN noclip + hold W
    // ~500 ms: at ≥1 px/unit the follow window provably tracks the player,
    // so both the sim position AND the arrow-region pixels must change.
    await page.keyboard.down('Equal');
    await page.waitForTimeout(6000);
    await page.keyboard.up('Equal');
    await page.waitForTimeout(150);

    await page.evaluate(() => window.__doom!.sim.setNoclip(true));
    const before = await arrowRegionHash(page);
    const posBefore = await page.evaluate(() => {
      const st = window.__doom!.sim.getState()!;
      return { x: st.players[0]!.mo.x, y: st.players[0]!.mo.y };
    });
    await page.keyboard.down('KeyW');
    await page.waitForTimeout(500);
    await page.keyboard.up('KeyW');
    await page.waitForTimeout(100);
    const posAfter = await page.evaluate(() => {
      const st = window.__doom!.sim.getState()!;
      return { x: st.players[0]!.mo.x, y: st.players[0]!.mo.y };
    });
    expect(
      Math.abs(posAfter.x - posBefore.x) + Math.abs(posAfter.y - posBefore.y),
      'holding W must move the player'
    ).toBeGreaterThan(65536);
    expect(await arrowRegionHash(page), 'arrow-region pixels must change').not.toBe(before);

    // (3) Tab toggles the automap off (full frame goes plain) and back on
    const mapOnHash = await frameHash(page);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);
    const offHash = await frameHash(page);
    expect(offHash, 'Tab must change the frame').not.toBe(mapOnHash);
    const offStats = await pixelStats(page);
    expect(offStats.nonBlack, 'map-off frame is the plain M3 placeholder buffer').toBeLessThan(
      s1.nonBlack / 4
    );
    await page.keyboard.press('Tab');
    await page.waitForTimeout(120);
    expect(await frameHash(page), 'Tab back on must repaint the automap').not.toBe(offHash);

    // (4) zero console errors across the whole flow
    expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  });
});
