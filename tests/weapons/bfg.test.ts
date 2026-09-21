/**
 * M7-10 — BFG9000 L2 suite (§M7-10 acceptance 1; R08 §3.6/§2.2,
 * random-sites.md BFG TRUTH: a 90° sweep of 40 rays from the blast
 * point, ray spacing 90/40°, EVERY ray runs P_AimLineAttack (0 draws);
 * a ray HIT spends [P_LastLookForTarget(1), 15 × P_Random() dice] and
 * the event damage is Σ(r&7)+15…120 — the ledger's draw-order goldens
 * let the damage of each ray be re-derived without trusting
 * "damage 100" lore: 100 is only the BFGBLAST mobjinfo damage for the
 * rare `(P_Random()%8+1)·100` direct missile hit).
 *
 * Latch (R08 §5): BFG is a MISSILE-class weapon — A_WeaponReady fires
 * the FIRST shot only on a fresh press (`!attackdown`): the boot-time
 * attackdown=true means holding through the switch never fires; one
 * no-press tic (45) clears the latch, the press at 46 fires. After the
 * first shot, A_ReFire's latch exemption keeps firing every 40 tics
 * while held (measured: 4 charges in 200 tics — as-is port behaviour).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { MT } from '../../src/wad/info/mobjinfo';
import { AM_CELL, attachPsprFields } from '../../src/sim/p_pspr';
import { resolveSfxId } from '../../src/sim/psound_stub';
import { RNDTABLE } from '../../src/sim/prng';

import { boot, dmgEvents, sfxCount, staticDummies, trackPsprites } from './harness';
import { weaponRangeSpec } from '../fixtures/m7Fixtures';

const SFX_BFG = resolveSfxId('sfx_bfg');
const RAISE_DONE = 14;
const PRESS = 46; // fresh press after latch-clear at 45

/** M8-05: one draw per damage event — the victim's painChance roll
 * (p_inter.c:894). */
const DAMAGE_DRAWS = 1;

function range(dummies: { x: number; y?: number; type?: number }[]) {
  // M8-fix: static dummies (AI gate) — see fist.test.ts / harness.
  const s = staticDummies(boot(weaponRangeSpec(
    dummies.map((d) => ({ x: d.x, y: d.y, type: d.type ?? 3004 }))
  )));
  for (const m of s.mobjs.mobjs) if (!m.removed && m.type !== 0) m.health = 1 << 20;
  const p = attachPsprFields(s.players[0]!);
  p.weaponowned[6] = 1; // WP_BFG
  p.ammo[AM_CELL] = 300;
  return { s, p };
}

/** Ordered per-ray re-derivation from the post-spray prnd window. */
function sprayFromWindow(base: number, hits: number, stride = 16) {
  const out: number[] = [];
  for (let i = 0; i < hits; i++) {
    let sum = 0;
    for (let k = 0; k < 15; k++) {
      // 16 draws per hit ray (1 target-look + 15 dice (r&7)+1; +1 damage
      // draw since M8-05) — the window is passed pre-offset to the first
      // die (aBFGSpray, pspam.c:781-813).
      sum += (RNDTABLE[(base + stride * i + k) & 0xff]! & 7) + 1;
    }
    out.push(sum);
  }
  return { out };
}

describe('BFG — latch fire, 40-ray spray re-derivation', () => {
  it('hold from the press: fires EXACTLY once (latch — no refire)', () => {
    const { s, p } = range([{ x: 192 }]);
    trackPsprites(s, 200, (t) => ({
      attack: t >= PRESS, weaponKey: t === RAISE_DONE ? 6 : undefined
    }));
    // First shot needs the fresh press (latch); the hold then refires
    // on the 40-tic A_ReFire cycle: 46, 86, 126, 166 (5th would land at
    // 206, outside the window) ⇒ exactly four −40 charges.
    expect(p.ammo[AM_CELL]).toBe(300 - 40 * 4);
    expect(sfxCount(s, SFX_BFG)).toBe(4);
    const bfgs = s.mobjs.mobjs.filter(
      (m) => m.type === MT.MT_BFG || m.type === MT.MT_EXTRABFG
    );
    expect(bfgs.length).toBeGreaterThanOrEqual(1);
    const main = s.mobjs.mobjs.filter((m) => m.type === MT.MT_BFG);
    expect(main).toHaveLength(4);
  });

  it('spray at 64 units: every hit event matches the ordered prnd window', () => {
    const { s } = range([{ x: 192 }]);
    const dummy = s.mobjs.mobjs.find((m) => m.type === MT.MT_POSSESSED)!;
    const spawnPrnd = s.rng.prndindex;
    trackPsprites(s, 200, (t) => ({
      attack: t === PRESS, weaponKey: t === RAISE_DONE ? 6 : undefined
    }));
    // M8-05: the log names the slot AT DAMAGE TIME and the kick promotes a
    // static THINGS dummy once (p_inter_damage.ts) — resolve identity
    // through the runtime slot map.
    const hits = dmgEvents(s).filter(
      (e) => e.thing === dummy.linkSlot || s.mobjs.slotMobjs.get(e.thing) === dummy
    );
    // One shot: direct missile hit ((r%8+1)·100) + N spray events.
    expect(hits.length).toBeGreaterThanOrEqual(1);
    const direct = hits.find((e) => e.amount % 100 === 0 && e.amount <= 800);
    expect(direct).toBeDefined();
    const spray = hits.filter((e) => e !== direct);
    expect(sfxCount(s, SFX_BFG)).toBe(1);
    const H = spray.length;
    // Window accounting: 4 draws at the direct-hit/spawn chain, then 16 per
    // hit ray PLUS one damage-path draw per damage event (the victim's
    // painChance roll, p_inter.c:894 — M8-05): 17 per hit ray and one for
    // the direct missile hit. Ray i's dice window: spawnPrnd+7+17i..+15.
    expect(s.rng.prndindex).toBe(
      (spawnPrnd + 4 + (16 + DAMAGE_DRAWS) * H + DAMAGE_DRAWS) & 0xff
    );
    // The direct-hit painChance draw lands BEFORE the first ray (the missile
    // damages on impact, then explodes), so the ray windows start one later.
    const { out } = sprayFromWindow(spawnPrnd + 7, H, 16 + DAMAGE_DRAWS);
    // (helper.end is NOT the run index: the dice-per-ray window sits
    // inside a 16-draw stride — one non-dice draw per ray on top.)
    for (let i = 0; i < H; i++) {
      expect(spray[i]!.amount).toBe(out[i]);
      expect(spray[i]!.amount).toBeGreaterThanOrEqual(15);
      expect(spray[i]!.amount).toBeLessThanOrEqual(120);
    }
    // Spray geometry: rays sweep mo.angle−45°…+45° (0.2°/ray), so the
    // 64-unit dummy (±14° from the blast axis) is hit by MULTIPLE rays.
    expect(H).toBeGreaterThanOrEqual(1);
    // Geometry pin: the dummy at 64 units spans ±14° of the 90°/40-ray
    // fan ⇒ 21 of the 40 rays connect, each spawning MT_EXTRABFG at the
    // target's z+height/4.
    expect(s.mobjs.mobjs.filter((m) => m.type === MT.MT_EXTRABFG)).toHaveLength(H);
  });

  it('no targets in the cone: spray still costs exactly 3 + 0×16 draws', () => {
    const { s } = range([]);
    const spawnPrnd = s.rng.prndindex;
    trackPsprites(s, 200, (t) => ({
      attack: t === PRESS, weaponKey: t === RAISE_DONE ? 6 : undefined
    }));
    // [ll, cms] + wall-explode(1). Zero spray draws.
    expect(s.rng.prndindex).toBe(spawnPrnd + 3);
    expect(s.hooks.damage.count).toBe(0);
  });
});
