/**
 * M7-10 — FIST (melee) L2 suite (§M7-10 acceptance 1+5; R08 §2.2; mirror
 * p_pspr.c:352-380 A_Punch).
 *
 * `damage = ((P_Random()%10)+1) << 1` → EVEN 2..20, ×10 under berserk
 * (powers pw_strength) → 20..200. Draw order per swing: damage FIRST,
 * then the two jitter draws (ALWAYS — melee is never "accurate"), then
 * the 4 impact-mobj draws on a hit (blood zjit×2 + spawn lastlook +
 * tics). MELEERANGE 64.
 *
 * Chain S_PUNCH1(4)→2(4, A_Punch entry ⇒ damage at F+4)→3(5)→4(4)→
 * 5(5, A_ReFire entry ⇒ hold cycle 17). Turn-to-face on hit rewrites
 * mo.angle to R_PointToAngle2(target) — asserted with an off-axis dummy.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { MT } from '../../src/wad/info/mobjinfo';
import { SFX_PUNCH, attachPsprFields } from '../../src/sim/p_pspr';
import { RNDTABLE } from '../../src/sim/prng';

import { boot, dmgTo, of, sfxCount, trackPsprites } from './harness';
import { weaponRangeSpec } from '../fixtures/m7Fixtures';

const RAISE_DONE = 14;
const SWITCH_READY = 44; // pistol→fist: lower 14..29, raise → ready 44
const PUNCH_F = SWITCH_READY; // first punch fires on the ready tic

function range(dummies: { x: number; y?: number }[]) {
  const s = boot(weaponRangeSpec(
    dummies.map((d) => ({ x: d.x, y: d.y, type: 3004 }))
  ));
  for (const m of of(s, MT.MT_POSSESSED)) m.health = 1 << 20;
  return s;
}

describe('fist — melee punches at a zombie 48 units away', () => {
  it('single press: even 2..20 re-derived, damage at F+4, sfx on hit', () => {
    const s = range([{ x: 176 }]);
    const dummy = of(s, MT.MT_POSSESSED)[0]!;
    const spawnPrnd = s.rng.prndindex;
    // Switch pistol→fist at 14; one-tic fire press at 45 (the switch
    // consumed the ready tic 44 itself).
    const trace = trackPsprites(s, 60, (t) => ({
      attack: t === PUNCH_F + 1, weaponKey: t === RAISE_DONE ? 0 : undefined
    }));
    const shots = dmgTo(s, dummy);
    expect(shots).toHaveLength(1);
    expect(shots[0]!.tic).toBe(PUNCH_F + 5); // fire 45 + 4

    // Window = [damage, jitter, jitter, blood zjit×2, lastlook, tics].
    expect(s.rng.prndindex).toBe(spawnPrnd + 7);
    const derived = ((RNDTABLE[(spawnPrnd + 1) & 0xff]! % 10) + 1) << 1;
    expect(shots[0]!.amount).toBe(derived);
    expect(derived % 2).toBe(0);
    expect(derived).toBeGreaterThanOrEqual(2);
    expect(derived).toBeLessThanOrEqual(20);

    // No ammo economy at all (am_noammo row).
    const p = attachPsprFields(s.players[0]!);
    expect(p.ammo.length).toBe(4);
    for (let a = 0; a < 4; a++) expect(p.ammo[a]).toBe(a === 0 ? 50 : 0);
    expect(sfxCount(s, SFX_PUNCH)).toBe(1);
    void trace;
  });

  it('hold: 17-tic cycle, 7 draws per swing', () => {
    const s = range([{ x: 176 }]);
    const dummy = of(s, MT.MT_POSSESSED)[0]!;
    const spawnPrnd = s.rng.prndindex;
    trackPsprites(s, 90, (t) => ({
      attack: true, weaponKey: t === RAISE_DONE ? 0 : undefined
    }));
    const shots = dmgTo(s, dummy);
    expect(shots.length).toBe(3); // F=44, 61, 78 (17-tic cycle) ⇒ dmg 48/65/82
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i]!.tic - shots[i - 1]!.tic).toBe(17);
    }
    expect(s.rng.prndindex).toBe(spawnPrnd + 7 * shots.length);
    for (const e of shots) expect(e.amount % 2).toBe(0);
  });

  it('berserk: same draws, damage ×10 (20..200)', () => {
    const s = range([{ x: 176 }]);
    const dummy = of(s, MT.MT_POSSESSED)[0]!;
    const spawnPrnd = s.rng.prndindex;
    const p = attachPsprFields(s.players[0]!);
    p.powers[0] = 1; // pw_strength (perma while >0)
    trackPsprites(s, 210, (t) => ({
      attack: true, weaponKey: t === RAISE_DONE ? 0 : undefined
    }));
    const shots = dmgTo(s, dummy);
    expect(shots.length).toBe(10); // F=44 + 17k ≤ 209
    let k = 0;
    for (const e of shots) {
      const derived = (((RNDTABLE[(spawnPrnd + k * 7 + 1) & 0xff]! % 10) + 1) << 1) * 10;
      expect(e.amount).toBe(derived);
      expect(e.amount % 20).toBe(0);
      k++;
    }
  });

  it('turn-to-face: off-axis dummy rewrites the player angle', () => {
    const s = range([{ x: 160, y: 140 }]); // 32/16 offset: east trace grazes r=16
    const dummy = of(s, MT.MT_POSSESSED)[0]!;
    const p = attachPsprFields(s.players[0]!);
    const before = p.mo.angle;
    trackPsprites(s, 60, (t) => ({
      attack: t === PUNCH_F + 1, weaponKey: t === RAISE_DONE ? 0 : undefined
    }));
    expect(p.mo.angle).not.toBe(before);
    // R_PointToAngle2((128,128) → hit near (160,140)): bearing atan2(12,32)
    // ≈ 20.6° (245M BAM); the pull-back point makes it exact within <0.2°.
    const bearing = 245243168;
    expect(Math.abs((p.mo.angle >>> 0) - bearing)).toBeLessThan(1 << 24);
    void before;
    expect(dmgTo(s, dummy)).toHaveLength(1);
  });

  it('miss (no dummy): swings anyway — 3 draws, no sfx, no damage slot', () => {
    const s = range([]);
    const spawnPrnd = s.rng.prndindex;
    trackPsprites(s, 60, (t) => ({
      attack: t === PUNCH_F + 1, weaponKey: t === RAISE_DONE ? 0 : undefined
    }));
    expect(s.hooks.damage.count).toBe(0);
    expect(sfxCount(s, SFX_PUNCH)).toBe(0);
    expect(s.rng.prndindex).toBe(spawnPrnd + 3);
  });
});
