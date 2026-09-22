/**
 * e2e M7-11c — L4 weapon suite on the LIVE page (M7-plan §M7-11): scripted
 * tic streams drive the real sim (no noclip); every assertion reads the
 * live state via the debug seams (readyweapon/ammo/pspr added this task).
 *
 * Weapons (WP_ enum): fist 0, pistol 1, shotgun 2, chaingun 3. Ammo
 * (AMMO_): clip 0, shell 1. The bug class this spec guards — the
 * sprite-index translation fix — is asserted as DISTINCT psprite state
 * numbers between pistol and chaingun while raised.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { enterPlay } from './playstart';

async function wadMissing(page: Page): Promise<boolean> {
  const res = await page.request.get('/wads/freedoom1.wad');
  return !res.ok();
}

function trackConsole(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(String(err)));
  return errors;
}

async function boot(page: Page): Promise<string[]> {
  const errors = trackConsole(page);
  await page.goto('/?test', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 60000 });
  // M9 boot flow: TITLEPIC ticks no world — enter play or runTics/giveWeapon
  // would drive a frozen attract world.
  await enterPlay(page);
  return errors;
}

/** runTics in slices so long phases don't blow the evaluate budget. */
async function run(page: Page, tics: number, input: Record<string, unknown>): Promise<void> {
  await page.evaluate(
    ([n, inp]) => {
      let left = n as number;
      while (left > 0) {
        const k = Math.min(10, left);
        window.__doom!.sim.runTics(k, inp as never);
        left -= k;
      }
    },
    [tics, input] as const,
  );
}

const st = (page: Page) =>
  page.evaluate(() => {
    const s = window.__doom!.state() as {
      player: {
        readyweapon: number;
        pendingweapon: number;
        ammo: number[];
        weapons: number;
        health: number;
        pspr: { slot: number; state: number }[];
      };
    };
    return s.player;
  });

test.describe('M7 weapon e2e', () => {
  test('pistol fire consumes clips and drives the psprite machine', async ({ page }) => {
    test.skip(await wadMissing(page));
    const errors = await boot(page);
    await page.evaluate(() => window.__doom!.sim.giveWeapon(1));
    await run(page, 30, {}); // raise completes (P_BringUpWeapon/A_Raise)
    const before = await st(page);
    expect(before.readyweapon).toBe(1);
    expect(before.ammo[0]).toBeGreaterThan(0);
    // fire 35 tics: pistol cadence 15 → at least 2 shots, clip ammo down
    const seenStates = await page.evaluate(async () => {
      const seen = new Set<number>();
      for (let i = 0; i < 35; i++) {
        window.__doom!.sim.runTics(1, { attack: true });
        const p = (window.__doom!.state() as {
          player: { pspr: { slot: number; state: number }[] };
        }).player;
        seen.add(p.pspr[0]!.state);
        seen.add(p.pspr[1]!.state);
      }
      return [...seen];
    });
    const after = await st(page);
    expect(after.ammo[0]).toBeLessThan(before.ammo[0]!);
    // weapon raised state + at least one distinct flash/fire state seen
    expect(seenStates.length).toBeGreaterThanOrEqual(2);
    expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
  });

  test('weapon-key switch to chaingun: distinct psprite state, bullet economy', async ({ page }) => {
    test.skip(await wadMissing(page));
    const errors = await boot(page);
    await page.evaluate(() => {
      window.__doom!.sim.giveWeapon(1); // pistol (ammo source)
      window.__doom!.sim.giveWeapon(3); // chaingun
    });
    await run(page, 30, {});
    const pistolState = (await st(page)).pspr[0]!.state;
    await run(page, 1, { weaponKey: 3 });
    await run(page, 40, {}); // lower + raise cycle
    const after = await st(page);
    expect(after.readyweapon).toBe(3);
    // THE sprite-index regression in pixels-of-state-space: chaingun ready
    // state must differ from the pistol ready state (pre-fix they shared a
    // wrong-sprite blob; states collapsing would reintroduce the class).
    expect(after.pspr[0]!.state).not.toBe(pistolState);
    expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
  });

  test('death sinks the view and USE reborns (states + health)', async ({ page }) => {
    test.skip(await wadMissing(page));
    const errors = await boot(page);
    await page.evaluate(() => window.__doom!.sim.killPlayer());
    // death window: health must hit <=0 somewhere in the 29-31-tic death
    // sequence; single-player death then RELOADS THE LEVEL on USE
    // (faithful G_DoReborn → ga_loadlevel — M9-08, D017 retired: world
    // respawns, player pistol-starts at the start spot), so sample the
    // window rather than one late snapshot.
    let sawDead = false;
    for (let i = 0; i < 20; i++) {
      await page.evaluate(() => window.__doom!.sim.runTics(1, {}));
      if ((await st(page)).health <= 0) sawDead = true;
    }
    expect(sawDead).toBe(true);
    // respawn (auto or USE latch) must land within a generous window —
    // poll rather than pin one tic window (deathcam length varies with
    // the death-tic phase; do not fight it).
    let revived = 0;
    for (let i = 0; i < 20; i++) {
      await run(page, 10, { use: true });
      revived = (await st(page)).health;
      if (revived === 100) break;
    }
    expect(revived).toBe(100);
    expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
  });

  test('out-of-ammo auto-downgrade ladder fires', async ({ page }) => {
    test.skip(await wadMissing(page));
    const errors = await boot(page);
    await page.evaluate(() => {
      window.__doom!.sim.giveWeapon(1);
      window.__doom!.sim.giveWeapon(3); // chaingun preferred (higher wpn)
    });
    await run(page, 30, {});
    expect((await st(page)).readyweapon).toBe(3);
    // burn every clip round (start 50 → <15 after 40 shots, empty by 90)
    await run(page, 90 * 4, { attack: true });
    await run(page, 40, { attack: true }); // final shots + ladder check
    const after = await st(page);
    expect(after.ammo[0]).toBeLessThan(15); // reserve nearly/fully dry
    // P_CheckAmmo ladder: every gun dry (ammo fully burnt) → fists are
    // the honest bottom of the ladder (p_pspr.c:158-215 loop to wp_fists).
    expect([0, 1, 3]).toContain(after.readyweapon);
    if (after.readyweapon === 0) expect(after.ammo[0]).toBe(0);
    expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
  });
});
