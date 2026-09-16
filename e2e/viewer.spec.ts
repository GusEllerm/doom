/**
 * Viewer e2e (M1-08): loads /viewer.html against the dev server, waits for
 * the "WAD loaded" state, asserts the lump count, previews a FLAT1_* flat
 * with a non-blank canvas, and opens the TROO sprite frame grid. Skips with
 * a message when wads/freedoom1.wad was never fetched (fetch-freedoom).
 * Reuses the existing playwright webServer (npm run dev) from
 * playwright.config.ts, like e2e/canvas.spec.ts.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';

/** True when the served IWAD is missing (viewer falls back to file picker). */
async function wadMissing(page: Page): Promise<boolean> {
  const res = await page.request.get('/wads/freedoom1.wad');
  return !res.ok();
}

async function pixelStats(page: Page, testId: string, nth = 0): Promise<{ colors: number; nonClear: number; total: number }> {
  return page.evaluate(
    ([id, idx]) => {
      const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>(`[data-test-id="${id}"]`));
      const canvas = canvases[idx];
      if (!canvas) return { colors: 0, nonClear: 0, total: 0 };
      const ctx = canvas.getContext('2d');
      if (!ctx) return { colors: 0, nonClear: 0, total: 0 };
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const seen = new Set<string>();
      let nonClear = 0;
      for (let i = 0; i < img.data.length; i += 4) {
        const key = `${img.data[i]},${img.data[i + 1]},${img.data[i + 2]},${img.data[i + 3]}`;
        if (seen.size < 4000) seen.add(key);
        if (!(img.data[i] === 0 && img.data[i + 1] === 0 && img.data[i + 2] === 0 && img.data[i + 3] === 255)) {
          nonClear++;
        }
      }
      return { colors: seen.size, nonClear, total: img.data.length / 4 };
    },
    [testId, nth] as const,
  );
}

test.describe('WAD debug viewer', () => {
  test('loads the IWAD, lists lumps, renders a flat and a sprite grid', async ({ page }) => {
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');

    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto('/viewer.html');
    await page.waitForSelector('[data-test-id="wad-loaded"]', { timeout: 30_000 });

    // (a) lump count visible and in the expected range for the pinned IWAD
    //     (freedoom1 v0.13.0 has 3163 lumps; the task text's "22k" predates
    //     the pin — see task report DEVIATIONS).
    const count = Number(await page.textContent('[data-test-id="lump-count"]'));
    expect(Number.isFinite(count)).toBe(true);
    expect(count).toBeGreaterThan(2000);
    expect(count).toBeLessThan(50_000);

    // (b) FLAT1_* flat renders non-empty pixels (not the opaque-black clear)
    await page.fill('[data-test-id="lump-filter"]', 'FLAT1_');
    const rows = page.locator('[data-test-id="lump-select"]');
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    const flatCanvas = page.locator('[data-test-id="preview-canvas"]');
    await expect(flatCanvas).toBeVisible();
    await expect(flatCanvas).toHaveAttribute('width', '64');
    const flat = await pixelStats(page, 'preview-canvas');
    expect(flat.total).toBe(64 * 64);
    expect(flat.nonClear, 'flat canvas must not be all clear color').toBeGreaterThan(0);
    expect(flat.colors, 'flat must show more than one palette color').toBeGreaterThan(1);

    // hex preview is present for any lump
    await page.fill('[data-test-id="lump-filter"]', 'PLAYPAL');
    await page.locator('[data-test-id="lump-select"]').first().click();
    await expect(page.locator('[data-test-id="hex-preview"]')).toContainText('000000');

    // (c) sprite browser: TROO frame grid renders many rotation canvases
    await page.click('[data-test-id="tab-sprites"]');
    await page.fill('[data-test-id="sprite-filter"]', 'TROO');
    await page.locator('[data-test-id="sprite-row"]', { hasText: 'TROO' }).first().click();
    const cells = page.locator('[data-test-id="sprite-grid"] [data-test-id="sprite-cell"]');
    await expect(cells.first()).toBeVisible();
    const n = await cells.count();
    // freedoom1 TROO: 8 rotating frames x 8 slots + 13 single views (>= 70);
    // keep a loose lower bound so the assertion tracks behavior, not pinning.
    expect(n, 'TROO frame grid canvases').toBeGreaterThanOrEqual(24);
    const gridPixel = await pixelStats(page, 'sprite-cell', 0);
    expect(gridPixel.nonClear, 'first sprite cell must render ink').toBeGreaterThan(0);

    // zero console errors across the whole session
    expect(consoleErrors, `console errors: ${consoleErrors.join('\n')}`).toHaveLength(0);
  });

  test('404 IWAD falls back to the file picker without page errors', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    await page.goto('/viewer.html?wad=/wads/definitely-not-here.wad');
    await page.waitForSelector('[data-test-id="wad-missing"]', { timeout: 10_000 });
    await expect(page.locator('[data-test-id="wad-file"]')).toBeVisible();
    expect(pageErrors, 'no uncaught errors on the 404 path').toHaveLength(0);
  });

  test('renders a patch and a TEXTURE1 texture via deep links', async ({ page }) => {
    test.skip(await wadMissing(page), 'wads/freedoom1.wad missing — run `npm run fetch-freedoom` first');
    await page.goto('/viewer.html?lump=AGB128_1');
    await page.waitForSelector('[data-test-id="wad-loaded"]', { timeout: 30_000 });
    const patch = await pixelStats(page, 'preview-canvas');
    expect(patch.colors, 'AGB128_1 patch must render colors').toBeGreaterThan(1);
    expect(patch.nonClear).toBeGreaterThan(0);

    await page.goto('/viewer.html?texture=BIGDOOR1');
    await page.waitForSelector('[data-test-id="wad-loaded"]', { timeout: 30_000 });
    const tex = await pixelStats(page, 'texture-canvas');
    expect(tex.colors, 'BIGDOOR1 texture must render colors').toBeGreaterThan(1);
  });
});
