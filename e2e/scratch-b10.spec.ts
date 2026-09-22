import { expect, test, type Page } from '@playwright/test';
import type { DebugMonsters } from '../src/types/debug';

async function wadMissing(page: Page): Promise<boolean> {
  const res = await page.request.get('/wads/freedoom1.wad');
  return !res.ok();
}

async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
}

test.describe('B-10 scratch: real menu skill picks', () => {
  for (const row of [0, 1, 2, 3, 4]) {
    test(`skill row ${row}`, async ({ page }) => {
      test.skip(await wadMissing(page));
      const errors: string[] = [];
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('pageerror', (e) => errors.push(String(e)));
      await page.goto('/', { waitUntil: 'load' });
      await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 60000 });
      // Real keys: Esc -> New Game -> E1 -> arrows to row -> Enter (+y for nightmare)
      await press(page, 'Escape');
      await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'MainDef', null, { timeout: 5000 });
      await press(page, 'Enter'); // New Game
      await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'EpiDef', null, { timeout: 5000 });
      await press(page, 'Enter'); // E1
      await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'NewDef', null, { timeout: 5000 });
      // walk to row from itemOn 0 (NewDef lastOn starts at 2? — use arrows reading itemOn)
      for (let guard = 0; ; ) {
        const cur = await page.evaluate(() => window.__doom!.ui()!.menu!.itemOn);
        if (cur === row) break;
        if (++guard > 10) throw new Error('nav stuck at ' + cur);
        await press(page, cur < row ? 'ArrowDown' : 'ArrowUp');
      }
      await press(page, 'Enter');
      if (row === 4) {
        await page.waitForFunction(() => window.__doom!.ui()!.menu!.messageToPrint === 1, null, { timeout: 5000 });
        await press(page, 'y');
      }
      await page.waitForFunction(() => {
        const st = window.__doom!.state();
        return !!st.ready && st.screen.gamestate === 0 && st.map === 'E1M1' && st.leveltime > 2;
      }, null, { timeout: 15000 });
      await page.waitForTimeout(300);
      const out = await page.evaluate(() => {
        const s = window.__doom!.state();
        const m = (s as unknown as { monsters: DebugMonsters }).monsters;
        return { gameskill: s.screen.gameskill, alive: m.alive, barrels: m.barrels, byType: m.byType, mobjs: m.mobjs.length, errors: 0 };
      });
      console.log(`ROW=${row} -> ` + JSON.stringify(out));
      console.log('ERRORS: ' + JSON.stringify(errors.filter((e) => !e.includes('favicon')).slice(0, 5)));
      expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
    });
  }
});

test.describe('B-10 scratch 2: in-game New Game + spawn positions', () => {
  test('second New Game from in-game menu', async ({ page }) => {
    test.skip(await wadMissing(page));
    await page.goto('/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 60000 });
    // first entry: title -> New Game -> E1 -> row 3
    await press(page, 'Escape');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'MainDef', null, { timeout: 5000 });
    await press(page, 'Enter'); await press(page, 'Enter');
    for (let guard = 0; ; ) {
      const cur = await page.evaluate(() => window.__doom!.ui()!.menu!.itemOn);
      if (cur === 3) break;
      if (++guard > 10) throw new Error('nav stuck');
      await press(page, cur < 3 ? 'ArrowDown' : 'ArrowUp');
    }
    await press(page, 'Enter');
    await page.waitForFunction(() => window.__doom!.state().ready && window.__doom!.state().screen.gamestate === 0, null, { timeout: 15000 });
    const m1 = await page.evaluate(() => (window.__doom!.state() as unknown as { monsters: DebugMonsters }).monsters.alive);
    // now IN GAME: Esc -> New Game -> E1 -> row 3 again
    await press(page, 'Escape');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'MainDef', null, { timeout: 5000 });
    await press(page, 'Enter'); // New Game
    const name = await page.evaluate(() => window.__doom!.ui()!.menu!.menuName);
    if (name === 'EpiDef') await press(page, 'Enter');
    for (let guard = 0; ; ) {
      const cur = await page.evaluate(() => window.__doom!.ui()!.menu!.itemOn);
      if (cur === 3) break;
      if (++guard > 10) throw new Error('nav stuck 2 at ' + cur);
      await press(page, cur < 3 ? 'ArrowDown' : 'ArrowUp');
    }
    await press(page, 'Enter');
    await page.waitForFunction(() => window.__doom!.state().screen.gamestate === 0 && window.__doom!.state().leveltime > 40, null, { timeout: 15000 });
    const out = await page.evaluate(() => {
      const s = window.__doom!.state();
      const m = (s as unknown as { monsters: DebugMonsters }).monsters;
      const st = window.__doom!.sim.getState()!;
      const F = 65536;
      const xs = m.mobjs.map((mo) => Math.round((mo as unknown as { x: number }).x));
      void st;
      return { gameskill: s.screen.gameskill, alive: m.alive, barrels: m.barrels, leveltime: s.leveltime, xs: xs.slice(0, 4), xscale: Math.max(...m.mobjs.map((mo) => Math.abs(Math.round((mo as unknown as { x: number }).x / F)))).toString() };
    });
    console.log('FIRST ' + m1 + ' SECOND ' + JSON.stringify(out));
    expect(m1).toBe(46);
  });
});
