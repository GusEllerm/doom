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
import { enterPlay } from './playstart';

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

/**
 * Boot + the physics.spec determinism trick: the in-page watcher PARKS both
 * page loads at EXACT leveltime 40 (the boot jitter stays out — the rAF
 * stepper is paused the first frame ≥ 40), so every scripted phase below is
 * bit-identical across boots, monsters' A_Look look-cycle phase included.
 */
async function boot(page: Page): Promise<string[]> {
  const errors = trackConsole(page);
  await page.goto('/?test', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 60000 });
  // M9 boot flow: boot is the TITLEPIC attract (world tics frozen there),
  // so enter play BEFORE parking — the park watcher needs leveltime to run.
  await enterPlay(page);
  const parked = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const api = window.__doom!;
        const check = (): void => {
          const st = api.sim.getState();
          if (st !== null && st.leveltime >= 40) {
            api.pause(true);
            resolve(st.leveltime);
          } else {
            requestAnimationFrame(() => check());
          }
        };
        check();
      })
  );
  if (parked !== 40) throw new Error(`park: leveltime ${parked}, expected 40`);
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
    // Spawn-order first monster = the doomednum-3002 (SARG) record: at the
    // park its A_Look cycle is in the deterministic idle pair, never a
    // wake/chase row.
    expect([475, 476]).toContain(m.first!.state);
    expect(m.first!.flagsLite.solid).toBe(true);
    expect(m.first!.targetPlayer).toBe(false);
    expect(m.first!.movedir).toBe(8); // DI_NODIR — A_Chase never ran
    expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
  });

  test('gunshot at spawn ARMS the ambush sleepers (soundtarget writes; no wake without LOS)', async ({ page }) => {
    test.skip(await wadMissing(page));
    const errors = await boot(page);
    // Baseline: nobody has a target (idle STAND cycle only).
    const before = await monsters(page);
    expect(before.mobjs.every((mo) => mo.targetSlot === null)).toBe(true);

    // Fire 40 tics = ~2 pistol shots: the p_pspr.c:256 P_NoiseAlert body
    // writes the sector soundtarget; the E1M1 parade pair (doomednum 3004
    // records with the AMBUSH thing-bit) gets `actor->target` ARMED through
    // A_Look's soundtarget branch — but MF_AMBUSH is SIGHT-GATED (p_enemy.c
    // :617) and no LOS reaches the spawn corridor, so they STAY in their
    // idle look rows (the pure-noise WAKE proof belongs to the non-ambush
    // fixtures; p_enemy.test.ts pins the flood + cone rules headlessly).
    const r = await runPhase(page, { tics: 40, input: { attack: true } });
    const m = r.monsters;
    const armed = m.mobjs.filter((mo) => mo.targetPlayer && mo.flagsLite.ambush);
    expect(armed.length, 'gunshot arms the ambush sleepers via soundtarget').toBeGreaterThanOrEqual(1);
    expect(armed.every((mo) => [S_POSS_STND, S_POSS_STND2].includes(mo.state)), 'armed but asleep: no LOS, no wake').toBe(true);
    expect(m.killcount).toBe(0);
    expect(errors.filter((e) => !e.includes('favicon')).length).toBe(0);
  });

  test('courtyard pair: sight wakes (states leave S_POSS_STAND), chase attacks, player fire kills (killcount++, corpse stops blocking)', async ({ page }) => {
    test.skip(await wadMissing(page));
    const errors = await boot(page);
    // Warp into the parade courtyard, facing east: a POSS sits at (752,336)
    // ~112 units on the eye line, its buddy at (816,448) — the pair the
    // headless probe maps. 30 LOS tics: sight wake (ambush clears on sight).
    const wake = await runPhase(page, { tics: 30, warp: { x: 640 * F, y: 336 * F, deg: 0 } });
    const woken = wake.monsters.mobjs.filter((mo) => mo.targetPlayer);
    expect(woken.length, 'sight wakes the close pair').toBeGreaterThanOrEqual(1);
    expect(woken.some((mo) => mo.state !== S_POSS_STND && mo.state !== S_POSS_STND2), 'woken states leave S_POSS_STAND').toBe(true);

    // Hold attack: pistol auto-aim lands; the pair closes to ATTACK range
    // (states 182..186 = POSS ATk/A_FaceTarget/missile rows) and dies.
    const fight = await page.evaluate(
      () => {
        const api = window.__doom!;
        const trace: { kills: number; hp: number; minD: number; atk: boolean; awake: boolean; corpse: DebugMonsterView | null }[] = [];
        for (let t = 0; t < 60; t++) {
          api.sim.runTics(10, { attack: true });
          const s = api.state() as DebugStateLive;
          const w = s.monsters.mobjs.filter((mo) => mo.health > 0 && mo.targetPlayer);
          trace.push({
            kills: s.monsters.killcount,
            hp: s.player.health,
            minD: w.length ? Math.min(...w.map((mo) => Math.hypot(mo.x - s.player.x, mo.y - s.player.y))) : 1e12,
            atk: w.some((mo) => mo.state >= 182 && mo.state <= 186),
            awake: w.length > 0,
            corpse: s.monsters.mobjs.find((mo) => mo.health <= 0) ?? null
          });
          if (s.monsters.killcount > 0 && s.monsters.mobjs.some((mo) => mo.health <= 0)) break;
        }
        return { trace, monsters: (api.state() as DebugStateLive).monsters };
      },
      null
    );
    const last = fight.trace[fight.trace.length - 1]!;
    expect(fight.trace.some((t) => t.atk), 'the chase closes to attack range (POSS ATk/missile rows 182..186)').toBe(true);
    expect(last.kills, 'killcount increments (intermission counter seam)').toBeGreaterThan(0);
    // The plan's OR: monsters die from player fire (killcount > 0). The
    // probe-matched E1M1 pair lands no hits before dying — hp 100 throughout.
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

    // Walk-through smoke: line the player up beside the corpse ON THE
    // SAME FLOOR — BUG-combat-t2 made the corpse's resting spot
    // chase-dependent, and a fixed west offset can land against a
    // >MAXSTEP sector step that would stop even a vanilla walker — so
    // sweep 64…512 units west, then east, for the first spot whose
    // settled floorz equals the corpse's floor (corpse.z with momz
    // settled). Then walk THROUGH it: an alive MF_SOLID monster would
    // stop the player ~29 units short; the corpse must not.
    const walk = await page.evaluate(
      (v: { x: number; y: number; z: number }) => {
        const api = window.__doom!;
        const F64 = 65536;
        let ok = false;
        let dir = -1;
        // The corpse's FLOORZ (not its mid-fall z) is the ground truth
        // for the walk line — a death-tic corpse can still be falling.
        const st0 = api.sim.getState()!;
        const cp = st0.mobjs.mobjs.find((m) => m.type === 1 && m.health <= 0)!;
        for (let d = 64; d <= 512 && !ok; d += 64) {
          for (const sgn of [-1, 1] as const) {
            api.warp(v.x + sgn * d * F64, v.y, undefined, 0);
            api.sim.runTics(8); // settle onto the floor
            const st = api.sim.getState()!;
            ok = st.players[0]!.mo.floorz === cp.floorz;
            if (ok) {
              dir = -sgn; // walk toward the corpse
              break;
            }
          }
        }
        if (!ok) return { crossed: false };
        api.sim.runTics(120, { forward: true });
        const st = api.sim.getState()!;
        const px = st.players[0]!.mo.x;
        // crossed = player got 32 units past the corpse centre
        return { crossed: (px - v.x) * dir > 32 * F64, px: px >> 16, cx: v.x >> 16 };
      },
      { x: corpse.x, y: corpse.y, z: corpse.z }
    );
    expect(walk.crossed, `player walks through the corpse line unobstructed ${JSON.stringify(walk)}`).toBe(true);
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
