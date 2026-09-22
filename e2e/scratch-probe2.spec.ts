// SCRATCH: live vs scripted fire on same-floor monster. DELETE.
// SPDX-License-Identifier: GPL-2.0-or-later
import { test } from '@playwright/test';
import { enterPlay } from './playstart';

test('scratch: live-vs-scripted fire', async ({ page }) => {
  const res = await page.request.get('/wads/freedoom1.wad');
  test.skip(!res.ok(), 'wad missing');
  await page.goto('/?test', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 60000 });
  await enterPlay(page);
  for (const mode of ['scripted', 'live'] as const) {
    const out = await page.evaluate(async (m) => {
      const api = window.__doom!;
      api.pause(true);
      const st0 = api.sim.getState()!;
      const mon = st0.mobjs.mobjs.find((x) => x.type === 1 && !x.removed && x.x >> 16 > 600 && x.x >> 16 < 900 && x.y >> 16 > 200 && x.y >> 16 < 500)!;
      api.warp(mon.x - 192 * 65536, mon.y, undefined, 0);
      api.popInput();
      const hp0 = mon.health;
      if (m === 'scripted') {
        for (let i = 0; i < 20; i++) api.sim.runTics(15, { attack: true });
      } else {
        api.pause(false);
        const canvas = document.querySelector('canvas')!;
        canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
        await new Promise((r) => setTimeout(r, 8500));
        window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
      }
      const st = api.sim.getState()!;
      const cur = st.mobjs.mobjs.find((x) => x.type === 1 && Math.abs(x.x - mon.x) < 20 * 65536);
      const hp1 = cur ? cur.health : -999;
      if (m === 'live') api.pause(true);
      api.popInput();
      return { mode: m, hp0, hp1, killed: st.players[0]!.killcount, pz: st.players[0]!.mo.z >> 16, mz: mon.z >> 16, lt: st.leveltime };
    }, mode);
    console.log('FIREFLIP', JSON.stringify(out));
  }
});
