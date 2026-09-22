// SCRATCH probe: are live monsters stranded in unlinked slots? DELETE later.
// SPDX-License-Identifier: GPL-2.0-or-later
import { test } from '@playwright/test';
import { enterPlay } from './playstart';

test('scratch: stranded-mover probe', async ({ page }) => {
  const res = await page.request.get('/wads/freedoom1.wad');
  test.skip(!res.ok(), 'wad missing');
  await page.goto('/?test', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 60000 });
  await enterPlay(page);
  for (let round = 0; round < 3; round++) {
    const probe = await page.evaluate(() => {
      const api = window.__doom!;
      api.pause(true);
      api.warp(640 * 65536, 336 * 65536, undefined, 0);
      api.popInput();
      let worst = { tic: -1, stranded: [] as number[][] };
      let maxStrand = 0;
      for (let i = 0; i < 120; i++) {
        api.sim.runTics(10, { attack: true });
        const st = api.sim.getState()!;
        const s = st.mobjs.mobjs.filter(
          (m) => !m.removed && (m.flags & 4194304) !== 0 && st.pmap.links.linked[m.linkSlot] === 0,
        );
        if (s.length) {
          maxStrand = Math.max(maxStrand, s.length);
          if (worst.tic < 0) worst = { tic: st.leveltime, stranded: s.map((m) => [m.type, m.linkSlot, m.x >> 16, m.y >> 16]) };
        }
      }
      const st = api.sim.getState()!;
      const killed = st.players[0]!.killcount;
      api.popInput();
      api.pause(false);
      return { worst, maxStrand, killed, lt: st.leveltime };
    });
    console.log('PROBE', round, JSON.stringify(probe));
    await page.waitForTimeout(300);
  }
  // LIVE round: rAF loop, mousedown held, poll strand state in-page
  const live = await page.evaluate(async () => {
    const api = window.__doom!;
    api.warp(640 * 65536, 336 * 65536, undefined, 0);
    api.popInput();
    const canvas = document.querySelector('canvas')!;
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0 }));
    const t0 = performance.now();
    let worst: number[][] = [];
    let maxStrand = 0;
    while (performance.now() - t0 < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      const st = api.sim.getState()!;
      const sl = st.mobjs.mobjs.filter(
        (m) => !m.removed && (m.flags & 4194304) !== 0 && st.pmap.links.linked[m.linkSlot] === 0,
      );
      if (sl.length > maxStrand) {
        maxStrand = sl.length;
        worst = sl.map((m) => [m.type, m.linkSlot, m.x >> 16, m.y >> 16]);
      }
    }
    window.dispatchEvent(new MouseEvent('mouseup', { button: 0 }));
    const st = api.sim.getState()!;
    return { maxStrand, worst, killed: st.players[0]!.killcount, lt: st.leveltime };
  });
  console.log('LIVEPROBE', JSON.stringify(live));
});
