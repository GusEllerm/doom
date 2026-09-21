/**
 * e2e M8-12 — L4 live monsters on the LIVE page (M8-plan §M8-12). The game.ts
 * production flip (side-effect imports of p_enemy/pdeath/amon_*) makes the
 * E1M1 MF_COUNTKILL roster LIVE in the browser: A_Look/A_Chase tick from the
 * first frame, gunshots reach P_NoiseAlert, deaths run the pdeath chains.
 *
 * Scripted-tic discipline mirrors physics/specials: pause(true) freezes the
 * rAF stepper, every phase runs inside ONE synchronous page.evaluate (no rAF
 * interleaving ⇒ bit-deterministic), and every assertion reads the M8-12
 * debug seams: state().monsters = { alive, byType, barrels, killcount,
 * first, mobjs[] } with the plan's type/health/state/target/movedir/
 * movecount/flags views.
 *
 * CENSUS TRUTH (skill 2 — main.ts boots gInitGame(map) default; the headless
 * monster-census fixture pins the SAME thing records at its CENSUS_SKILL=3:
 * tests/fixtures/m8Roster.ts WAD_CENSUS.E1M1 = 3004 raw 12/alive 5, 9 13/13,
 * 3001 18/18, 3002 9/9, 58 1/1, barrels 22 — the skill-bit winners at
 * normal differ per record; the alive-by-type below was measured off the
 * identical gInitGame path (freedoom1.wad, skill 2): POSS 4, SPOS 10,
 * TROO 10, SARG 5 = 29 living + 22 barrels, zero monsters of any other
 * doomednum). The task brief's "34 zombiemen" figure is contradicted by the
 * authoritative WAD census (E1M1 doomednum 3004: 12 raw / 5 alive at
 * skill 3 / 4 at skill 2) — the spec asserts the WAD truth, not the brief.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';

import type { DebugMonsters, DebugMonsterView, DebugStateLive } from '../src/types/debug';

const F = 65536;

// MT_* (src/wad/info/mobjinfo.ts mobjtype_t order)
const MT_POSSESSED = 1;
const MT_SHOTGUY = 2;
const MT_TROOP = 11;
const MT_SERGEANT = 12;
// S_* idle-stand rows (src/wad/info/states.ts): the POSS STAND/STND2 A_Look
// cycle — a woken monster MUST leave this pair.
const S_POSS_STND = 174;
const S_POSS_STND2 = 175;

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
  await page.evaluate(() => window.__doom!.pause(true)); // freeze the rAF stepper
  return errors;
}

/** One synchronous scripted phase (ONE evaluate block — the rAF stepper is
 * paused, so a tight runTics loop cannot interleave live tics). */
async function runPhase(
  page: Page,
  p: { tics: number; input?: Record<string, unknown>; warp?: { x: number; y: number; deg: number } }
): Promise<{ monsters: DebugMonsters; hash: number; player: { x: number; y: number; health: number } }> {
  return page.evaluate((cfg) => {
    const api = window.__doom!;
    if (cfg.warp) api.warp(cfg.warp.x, cfg.warp.y, undefined, cfg.warp.deg);
    let left = cfg.tics;
    while (left > 0) {
      const k = Math.min(10, left);
      api.sim.runTics(k, cfg.input as never);
      left -= k;
    }
    const s = api.state() as DebugStateLive;
    return { monsters: s.monsters, hash: s.hash, player: { x: s.player.x, y: s.player.y, health: s.player.health } };
  }, p);
}

const monsters = (page: Page) =>
  page.evaluate(() => (window.__doom!.state() as { monsters: DebugMonsters }).monsters);

test.describe('M8-12 live monsters e2e', () => {
  test('E1M1 living census + killcount 0 (WAD census truth)', async ({ page }) => {
    test.skip(await wadMissing(page));
    const errors = await boot(page);
    const m = await monsters(page);
    expect(m.killcount).toBe(0);
    expect(m.byType[MT_POSSESSED]).toBe(4); // doomednum 3004: raw 12, skill-2 alive 4
    expect(m.byType[MT_SHOTGUY]).toBe(10);
    expect(m.byType[MT_TROOP]).toBe(10);
    expect(m.byType[MT_SERGEANT]).toBe(5);
    expect(m.alive).toBe(29);
    expect(m.barrels).toBe(22);
    expect(m.mobjs).toHaveLength(29);
    expect(m.first).not.toBeNull();
    expect(m.first!.state).toBe(S_POSS_STND); // undisturbed idle row at tic 0
    expect(m.first!.flagsLite.solid).toBe(true);
    expect(m.first!.targetPlayer).toBe(false);
    expect(m.first!.movedir).toBe(-1); // DI_NODIR — A_Chase never ran
    expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
  });

  test('gunshot at spawn wakes the far posse (soundtarget → A_Look → A_Chase)', async ({ page }) => {
    test.skip(await wadMissing(page));
    const errors = await boot(page);
    // Baseline: nobody has a target (idle STAND cycle only).
    const before = await monsters(page);
    expect(before.mobjs.every((mo) => mo.targetSlot === null)).toBe(true);

    // Raise is already done (G_PlayerReborn pistol raised); fire 40 tics =
    // ~2 pistol shots — A_FirePistol's p_pspr.c:256 P_NoiseAlert body.
    const r = await runPhase(page, { tics: 40, input: { attack: true } });
    const m = r.monsters;
    const awake = m.mobjs.filter((mo) => mo.targetPlayer);
    expect(awake.length, 'gunshot wakes the LOS-free posse').toBeGreaterThanOrEqual(1);
    expect(awake.some((mo) => mo.state !== S_POSS_STND && mo.state !== S_POSS_STND2), 'woken states leave S_POSS_STAND').toBe(true);
    expect(awake.some((mo) => mo.movedir >= 0), 'A_Chase picked a chase direction').toBe(true);
    expect(m.killcount).toBe(0); // nothing died — this is the wake phase
    expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
  });

  test('firefight: chase closes, player fire kills (killcount++, corpse stops blocking)', async ({ page }) => {
    test.skip(await wadMissing(page));
    const errors = await boot(page);
    // Warp onto the parade courtyard, facing east: a POSS sits at (752,336)
    // ~112 units on the eye line, its buddy at (816,448) — the same
    // (deterministic) pair the headless probe maps.
    const wake = await runPhase(page, { tics: 30, warp: { x: 640 * F, y: 336 * F, deg: 0 } });
    const woken = wake.monsters.mobjs.filter((mo) => mo.targetPlayer);
    expect(woken.length, 'sight wakes the close pair').toBeGreaterThanOrEqual(1);
    expect(woken.some((mo) => mo.state !== S_POSS_STND && mo.state !== S_POSS_STND2)).toBe(true);
    const distAt = (m: DebugMonsters, px: number, py: number) =>
      Math.min(...m.mobjs.filter((mo) => mo.health > 0).map((mo) => Math.hypot(mo.x - px, mo.y - py)));
    const dWake = distAt(wake.monsters, 640 * F, 336 * F);

    // Hold attack: pistol auto-aim lands; A_Chase closes WHILE shooting.
    const fight = await page.evaluate(
      () => {
        const api = window.__doom!;
        const trace: { g: number; kills: number; hp: number; minD: number; corpse: DebugMonsterView | null }[] = [];
        let ppos = { x: (api.state() as DebugStateLive).player.x, y: (api.state() as DebugStateLive).player.y };
        for (let t = 0; t < 46; t++) {
          api.sim.runTics(10, { attack: true });
          const s = api.state() as DebugStateLive;
          ppos = { x: s.player.x, y: s.player.y };
          const alive = s.monsters.mobjs.filter((mo) => mo.health > 0);
          trace.push({
            g: s.monsters.killcount,
            kills: s.monsters.killcount,
            hp: s.player.health,
            minD: alive.length ? Math.min(...alive.map((mo) => Math.hypot(mo.x - ppos.x, mo.y - ppos.y))) : 1e12,
            corpse: s.monsters.mobjs.find((mo) => mo.health <= 0) ?? null
          });
          if (s.monsters.killcount > 0 && trace[trace.length - 1]!.corpse) break;
        }
        return { trace, monsters: (api.state() as DebugStateLive).monsters };
      },
      null
    );
    const last = fight.trace[fight.trace.length - 1]!;
    expect(last.kills, 'killcount increments (intermission counter seam)').toBeGreaterThan(0);
    expect(last.minD, 'the chase closes the distance').toBeLessThan(dWake);
    // The plan's OR — player health drops OR monsters die from player fire:
    // the close pair dies before their shots land (hp stays 100 through the
    // probe-matched window); killcount > 0 (asserted above) carries it.
    expect(last.kills > 0 || last.hp < 100, 'damage exchange happened').toBe(true);

    // Corpse: the MF_CORPSE flag lands, and A_Fall clears MF_SOLID (the
    // walk-over rule) within the death chain.
    let corpse = last.corpse!;
    expect(corpse.flagsLite.corpse, 'P_KillMobj sets MF_CORPSE').toBe(true);
    if (corpse.flagsLite.solid) {
      const after = await page.evaluate(() => {
        const api = window.__doom!;
        for (let t = 0; t < 6; t++) {
          api.sim.runTics(10);
          const c = (api.state() as DebugStateLive).monsters.mobjs.find(
            (mo) => mo.health <= 0 && !mo.flagsLite.solid
          );
          if (c) return c as DebugMonsterView;
        }
        return null;
      });
      expect(after, 'A_Fall clears MF_SOLID within 60 tics').not.toBeNull();
      corpse = after as DebugMonsterView;
    }
    expect(corpse.flagsLite.solid, 'corpse no longer blocks').toBe(false);

    // Walk-through smoke: line the player up 160 units west of the corpse
    // and walk east THROUGH it — an alive MF_SOLID monster would stop the
    // player at x = corpse.x − 29; the corpse must not.
    const walk = await page.evaluate(
      (v: { x: number; y: number }) => {
        const api = window.__doom!;
        api.warp(v.x - 160 * 65536, v.y, undefined, 0);
        api.sim.runTics(45, { forward: true });
        const s = api.state() as DebugStateLive;
        return s.player.x;
      },
      { x: corpse.x, y: corpse.y }
    );
    expect(walk, 'player walks through the corpse line unobstructed').toBeGreaterThan(corpse.x + 32 * F);
    expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
  });

  test('double-run determinism: scripted firefight hashes identically across page loads', async ({ page }) => {
    test.skip(await wadMissing(page));
    const script = async (p: Page): Promise<[number, number]> => {
      await boot(p);
      const r = await runPhase(p, {
        tics: 400,
        warp: { x: 640 * F, y: 336 * F, deg: 0 },
        input: { attack: true }
      });
      return [r.hash, r.monsters.killcount];
    };
    const [h1, k1] = await script(page);
    const page2 = await page.context().newPage();
    const [h2, k2] = await script(page2);
    expect(h2, 'same seed + identical script ⇒ identical state().hash').toBe(h1);
    expect(k2).toBe(k1);
  });
});
