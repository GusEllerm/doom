/**
 * First end-to-end gate (PROMPT.md §8 Phase 2): the page loads with zero
 * console errors, the canvas is not blank, and the debug API is present
 * under ?test=1. Behavior under test is driven by the real page only.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test } from '@playwright/test';

test('canvas renders non-blank with zero console errors', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push(String(err)));

  await page.goto('/?test=1');
  await page.waitForFunction(() => document.readyState === 'complete');
  // Let a few animation frames paint.
  await page.waitForTimeout(200);

  const stats = await page.evaluate(() => {
    const canvas = document.querySelector('canvas');
    if (!(canvas instanceof HTMLCanvasElement)) return null;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set<string>();
    for (let i = 0; i < img.data.length; i += 4 * 97) {
      seen.add(`${img.data[i]},${img.data[i + 1]},${img.data[i + 2]}`);
      if (seen.size > 4) break;
    }
    return { colors: seen.size, width: canvas.width, height: canvas.height };
  });

  expect(stats, 'canvas with 2d context exists').not.toBeNull();
  expect(stats!.width).toBe(320);
  expect(stats!.height).toBe(200);
  expect(stats!.colors, 'canvas must show more than one color').toBeGreaterThan(1);

  const hasDebug = await page.evaluate(() => typeof window.__doom === 'object');
  expect(hasDebug, 'window.__doom installed under ?test=1').toBe(true);

  expect(consoleErrors, `console errors: ${consoleErrors.join(' | ')}`).toEqual([]);
});
