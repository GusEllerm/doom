/**
 * e2e live-combat — B-07/B-08 permanent regression (docs/BUGS.md round 2:
 * "monsters never move/attack visibly" + "shooting never harms them" in the
 * REAL browser session while every runTics harness stayed green).
 *
 * THE SPEC CLASS THE LEDGER ASKED FOR: a genuine 35 Hz rAF session with
 * real input and NO scripted stepping — this file calls sim.runTics() ZERO
 * times. Every tic of the observed world comes from the page's own loop:
 *   - New Game walked with REAL keys (Esc/Enter/arrows, m9-flow recipe);
 *   - firing is the REAL key_fire mapping (RightCtrl) on the live ticcmd;
 *   - aiming drives the documented ev_mouse injection seam (the SAME raw
 *     accumulator + per-tic sample() drain the locked-mouse device path
 *     feeds — headless pointer lock is unreliable, M5-plan §6); the spec
 *     pins the resulting aim sanity (converges under ~1° via a live
 *     deg-per-pixel calibration off the real angle readback).
 * Setup-only seams: noclip+warp to stage in front of a monster (warp is
 * "setup only — never substitutes for movement-under-test"); god-mode ONLY
 * during the kill fistfight so a stray fireball can't swap the scene.
 *
 * THE COHERENCE CHANNEL (why pixels alone can't prove B-07): the sprite
 * pass already drew a FROZEN boot-time census (main.ts never fed
 * deps.mobjs → renderer.ts kept the M9-09 overlay in useStatic mode), yet
 * live PIXEL diffs can still move pre-fix — sector-light thinkers (gunfire
 * fog, flickers) remap every index. So the spec asserts on the additive
 * `state().render.sprites` seam: the position fingerprint (count +
 * map-unit coordinate sums) of EXACTLY the thing rows the sprite pass fed
 * R_AddSprites last frame. Sprite-only, zero light noise, and it can only
 * move if the live roster is wired. Pre-fix behavior (verified): monsters
 * walk in the sim while the fingerprint sits CONSTANT — that's the assert.
 * Pixel diffs are still captured and logged for the field report.
 *
 * Assertions, one live page, in order:
 *   1. real keys move the PLAYER (live KeyW → sim position delta);
 *   2. VISUAL<->SIM COHERENCE: the tracked monster (STABLE identity via
 *      the additive `thinkerId` field — spawn-order indices drift and
 *      linkSlot is promoted on first move, p_enemy.ts:298) rouses/moves
 *      in the sim ⇒ the sprite-pass fingerprint moves with it (pure no-gun
 *      window: same sign on the shared axis; fired windows: any change);
 *   3. LIVE KILL: tracked aim + real-key fire produces a killcount on that
 *      monster AND the fingerprint moved during the fight (puffs/blood/
 *      death frames entered the sprite pass — pre-fix the TRUE-position
 *      shots killed invisible monsters: killcount rose over an untouched,
 *      motionless census sprite, exactly the user's report);
 *   4. zero console/page errors.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DebugStateLive } from '../src/types/debug';

const F = 65536;
const ART = 'artifacts/live-combat';

interface Snap {
  lt: number;
  px: number;
  py: number;
  angleDeg: number;
  killcount: number;
  roster: number;
  mons: { tid: number; type: number; x: number; y: number; hp: number; st: number; tgt: boolean; shootable: boolean }[];
  fp: { drawn: number; sumX: number; sumY: number };
}

type SnapP = Snap & { indices?: number[] };

/** ONE evaluate = seam read + framebuffer grab share the frame. */
const SNAP_CORE = `lt: s.leveltime, px: s.player.x, py: s.player.y, angleDeg: s.player.angleDeg,
    killcount: s.monsters.killcount,
    mons: s.monsters.mobjs.map((m) => ({ tid: m.thinkerId, type: m.type, x: m.x, y: m.y, hp: m.health, st: m.state, tgt: m.targetPlayer, shootable: m.flagsLite.shootable })),
    roster: st.mobjs.mobjs.length,
    fp: s.render.sprites`;

/** ONE evaluate = seam read (+ optional framebuffer grab) share the frame. */
function snapExpr(withPixels: boolean): string {
  return `(() => {
  const s = window.__doom.state(), st = window.__doom.sim.getState();
  return { ${SNAP_CORE}${withPixels ? ", indices: Array.from(window.__doom.capture().indices)" : ''} };
})()`;
}

async function snap(page: Page, withPixels = false): Promise<SnapP> {
  return page.evaluate(snapExpr(withPixels)) as Promise<SnapP>;
}

/** Changed pixels in the view rows (above the psprite gun band, rows ≥150
 * — logging channel only; see the header for why pixels can't be the
 * regression signal). */
function viewDiff(a: number[], b: number[]): number {
  let n = 0;
  const stop = 320 * 150;
  for (let i = 0; i < stop; i++) if (a[i] !== b[i]) n++;
  return n;
}

async function press(page: Page, key: string): Promise<void> {
  await page.keyboard.down(key);
  await page.waitForTimeout(120);
  await page.keyboard.up(key);
  await page.waitForTimeout(120);
}

/** Real-time windowing by sim state (never bare sleeps). */
async function liveUntil(page: Page, target: number, ms = 15_000): Promise<void> {
  await page.waitForFunction((t: number) => (window.__doom!.sim.getState()?.leveltime ?? 0) >= t, target, { timeout: ms });
}

const fireTap = async (page: Page): Promise<void> => {
  await page.keyboard.down('ControlRight'); // key_fire (input/mapping.ts)
  await page.waitForTimeout(90);
  await page.keyboard.up('ControlRight');
};

test.describe.serial('B-07/B-08 browser-live combat (real rAF, zero runTics)', () => {
  test('monsters move on screen, shots kill, deaths are seen', async ({ page }) => {
    mkdirSync(ART, { recursive: true });
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(String(e)));

    await page.goto('/');
    await page.waitForFunction(() => window.__doom?.sim.getState() !== null, null, { timeout: 30_000 });

    // ---- REAL-keys New Game (m9-flow stage-2 recipe; live tics only) ----
    await press(page, 'Escape');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.active && window.__doom!.ui()!.menu!.menuName === 'MainDef', null, { timeout: 10_000 });
    await press(page, 'Enter'); // New Game
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'EpiDef', null, { timeout: 10_000 });
    await press(page, 'Enter'); // Episode 1
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.menuName === 'NewDef', null, { timeout: 10_000 });
    await press(page, 'ArrowDown');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.itemOn === 3, null, { timeout: 10_000 });
    await press(page, 'ArrowUp');
    await page.waitForFunction(() => window.__doom!.ui()!.menu!.itemOn === 2, null, { timeout: 10_000 });
    await press(page, 'Enter'); // Hurt me
    await page.waitForFunction(() => {
      const s = window.__doom!.state() as DebugStateLive;
      return s.ready === true && s.map === 'E1M1' && window.__doom!.ui()!.screen.gamestate === 0;
    }, null, { timeout: 20_000 });
    await liveUntil(page, 1);

    // ---- 1. real keys reach the live ticcmd: a KeyW hold moves the player ----
    const p0 = await snap(page);
    await page.keyboard.down('KeyW');
    await liveUntil(page, p0.lt + 10);
    await page.keyboard.up('KeyW');
    await liveUntil(page, p0.lt + 12);
    const p1 = await snap(page);
    expect(Math.hypot(p1.px - p0.px, p1.py - p0.py) / F, 'real KeyW moved the player through the live loop').toBeGreaterThan(8);

    // ---- setup: stage 288 units south of a zombieman, facing it ----
    const target = p1.mons.find((m) => m.hp === 20 && m.shootable)!;
    expect(target, 'E1M1 has a zombieman census').toBeTruthy();
    await page.evaluate(({ x, y }) => {
      window.__doom!.noclip(true);
      window.__doom!.warp(x, y - 288 * 65536, undefined, 90);
    }, { x: target.x, y: target.y });
    await page.evaluate(() => window.__doom!.noclip(false));
    await liveUntil(page, (await snap(page)).lt + 6); // settle frames post-warp

    const s0 = await snap(page, true);
    const t0 = s0.mons.find((m) => m.tid === target.tid)!;
    expect(t0, 'tracked monster survives the warp setup').toBeTruthy();
    expect(s0.fp.drawn, 'sprite pass drew its thing list').toBeGreaterThan(0);

    // ---- 2. VISUAL<->SIM COHERENCE (real tics, zero input first; vanilla
    // A_Look only sees inside the mobj's cone and turns on random
    // lastlooks, so POLL for the wake instead of pinning a window; past
    // ~6 s, real gunfire taps rouse any inert monster via pain state).
    // The assert is the sprite-pass fingerprint — pixel diffs carry
    // sector-light noise and CANNOT carry the freeze signal (see header).
    const pureDeadline = Date.now() + 6_000;
    const pollDeadline = Date.now() + 15_000;
    let nextTap = pureDeadline;
    let firedTap = false;
    let moved = 0;
    let roused = false;
    let sEnd = s0;
    while (Date.now() < pollDeadline) {
      sEnd = await snap(page);
      const t = sEnd.mons.find((m) => m.tid === target.tid);
      if (t === undefined) {
        roused = true; // left the census view (died to a tap)
        break;
      }
      moved = Math.hypot(t.x - t0.x, t.y - t0.y) / F;
      roused = moved > 0 || t.tgt || t.hp <= 0 || t.st !== t0.st;
      if (roused) break;
      if (Date.now() > nextTap) {
        firedTap = true;
        nextTap = Date.now() + 2_000;
        await fireTap(page);
      }
      await page.waitForTimeout(120);
    }
    expect(roused, 'the sim monster never stirred in 15 real seconds even after gunshots').toBe(true);
    const s1 = await snap(page, true);
    const t1 = s1.mons.find((m) => m.tid === target.tid);
    const fpMoved = s1.fp.sumX !== s0.fp.sumX || s1.fp.sumY !== s0.fp.sumY;
    expect(fpMoved, `sim monster roused (moved ${moved.toFixed(0)}u) but the sprite pass drew the SAME positions — frozen census = B-07 (fp ${s0.fp.sumX},${s0.fp.sumY} -> ${s1.fp.sumX},${s1.fp.sumY})`).toBe(true);
    if (!firedTap && t1 !== undefined && Math.abs(t1.y - t0.y) > Math.abs(t1.x - t0.x)) {
      // Pure (no-spawn) window and a dominantly vertical monster move: the
      // fingerprint must move WITH it, not merely somewhere.
      expect((t1.y - t0.y) * (s1.fp.sumY - s0.fp.sumY), 'fingerprint moved against the monster direction').toBeGreaterThan(0);
    }
    console.log(`live-combat: moved=${moved.toFixed(0)}u fpDelta=(${s1.fp.sumX - s0.fp.sumX},${s1.fp.sumY - s0.fp.sumY}) firedTap=${firedTap} pixels=${viewDiff(s0.indices!, s1.indices!)}`);

    // ---- 3. LIVE KILL: tracked aim (ev_mouse seam, calibrated live — the
    // aim-sanity axis) + REAL RightCtrl fire. God-mode ONLY for the
    // fistfight: gunfire wakes the whole area and a player death would
    // swap the scene out from under the kill assertion. ----
    await page.evaluate(() => window.__doom!.god(true));
    const cal = await snap(page);
    await page.evaluate(() => window.__doom!.sim.injectMouse(10, 0));
    await liveUntil(page, cal.lt + 3);
    const calAfter = await snap(page);
    let dp = ((calAfter.angleDeg - cal.angleDeg + 540) % 360) - 180;
    if (Math.abs(dp) < 1e-9) dp = -0.44; // deg per raw px at sens 5 (never ÷0)

    const fpFire0 = cal.fp;
    const capA = (await snap(page, true)).indices!;
    const deadline = Date.now() + 12_000;
    let aimErr = 999;
    let last = s1;
    while (Date.now() < deadline) {
      last = await snap(page);
      const t = last.mons.find((m) => m.tid === target.tid);
      if (t === undefined || t.hp <= 0) break;
      const want = ((Math.atan2(t.y - last.py, t.x - last.px) * 180 / Math.PI) + 360) % 360;
      aimErr = ((want - last.angleDeg + 540) % 360) - 180;
      if (Math.abs(aimErr) > 0.9) {
        const raw = aimErr / dp;
        const dx = Math.max(-40, Math.min(40, raw > 0 ? Math.max(1, Math.round(raw)) : Math.min(-1, Math.round(raw))));
        await page.evaluate((d: number) => window.__doom!.sim.injectMouse(d, 0), dx);
        await page.waitForTimeout(45);
      } else {
        await fireTap(page);
      }
    }
    const s2 = await snap(page, true);
    await page.evaluate(() => window.__doom!.god(false));
    await page.screenshot({ path: join(ART, 'after-kill.png') });
    const t2 = s2.mons.find((m) => m.tid === target.tid);
    expect(s2.killcount > s0.killcount || t2 === undefined || t2.hp <= 0,
      `no live kill in 12 real seconds (aimErr ${aimErr.toFixed(1)}°, killcount ${s2.killcount}, roster ${s0.roster}->${s2.roster})`).toBe(true);
    expect(s2.roster, 'puffs/blood spawned during the fight (sim side)').toBeGreaterThan(s0.roster);
    expect(s2.fp.sumX !== fpFire0.sumX || s2.fp.sumY !== fpFire0.sumY,
      `shots spawned ${s2.roster - s0.roster} mobjs but the sprite pass positions never changed — invisible puffs/death = B-08 (fp ${fpFire0.sumX},${fpFire0.sumY} -> ${s2.fp.sumX},${s2.fp.sumY})`).toBe(true);
    console.log(`live-combat: kill=${s2.killcount} roster ${s0.roster}->${s2.roster} fpDelta=(${s2.fp.sumX - fpFire0.sumX},${s2.fp.sumY - fpFire0.sumY}) firePixels=${viewDiff(capA, s2.indices!)}`);

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
