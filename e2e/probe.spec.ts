import { test } from '@playwright/test';
test('probe 404 console + bigdoor pixels', async ({ page }) => {
  const logs: string[] = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e}`));
  await page.goto('/viewer.html?wad=/wads/definitely-not-here.wad');
  await page.waitForSelector('[data-test-id="wad-missing"]', { timeout: 10_000 });
  console.log('404LOGS', JSON.stringify(logs));
  logs.length = 0;
  await page.goto('/viewer.html?texture=BIGDOOR1');
  await page.waitForSelector('[data-test-id="wad-loaded"]', { timeout: 30_000 });
  const info = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-test-id="texture-canvas"]')!;
    const ctx = c.getContext('2d')!;
    const px = (x: number, y: number) => Array.from(ctx.getImageData(x, y, 1, 1).data);
    return { w: c.width, h: c.height, center: px(c.width >> 1, c.height >> 1), corner: px(0, 0), q: px(c.width >> 2, c.height >> 2), data0: px(5, 5) };
  });
  console.log('TEXPROBE', JSON.stringify(info));
  console.log('TEXLOGS', JSON.stringify(logs));
});
