/**
 * M7-10 — PLASMA GUN L2 suite (§M7-10 acceptance 1; R08 §2.2 "single
 * spawn + random flash sprite flashstate+(P_Random()&1)"; R07 §9.1: the
 * projectile is MT_PLASMA, info damage 5 ⇒ direct hit
 * `(P_Random()%8+1)*5` — ONE draw, spread myth: NONE in 1.10).
 *
 * Fire happens on S_PLASMA1 ENTRY (action A_FirePlasma): ammo −1 cell,
 * 1 flash-variant draw, 2 spawn draws (lastlook + P_CheckMissileSpawn).
 * S_PLASMA1 tics 3 → S_PLASMA2 entry runs A_ReFire ⇒ measured hold cycle
 * 3 tics. The 64-unit target is hit on the SPAWN TIC (spawn nudge +
 * first thinker move), so per shot the ledger window is exactly 5 draws
 * — the damage roll sits at window offset +4 ([flash, cms, thinghit
 * chain×2, dmg/explode-tics] as-measured). NO splash (random-sites.md
 * SPLASH TRUTH: plasma's deathstate has no A_Explode).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { MT } from '../../src/wad/info/mobjinfo';
import { AM_CELL, WP_PLASMA, attachPsprFields } from '../../src/sim/p_pspr';
import { resolveSfxId } from '../../src/sim/psound_stub';
import { RNDTABLE } from '../../src/sim/prng';

import { boot, dmgTo, of, pinInPlace, sfxCount, staticDummies, trackPsprites } from './harness';

/** M8-05: the live P_DamageMobj adds the victim's painChance roll
 * (p_inter.c:894) AFTER the hit's own damage draw, and its kick pushes the
 * dummy — the fire-stream window is measured here, so the dummy is held by
 * harness.pinInPlace (the kick is pinned in p_inter_damage.test.ts). */
const DAMAGE_DRAWS = 1;
import { weaponRangeSpec } from '../fixtures/m7Fixtures';

const SFX_PLASMA = resolveSfxId('sfx_plasma');
const RAISE_DONE = 14;
const SWITCH_READY = 44; // pistol→plasma (weaponKey '6')

function range() {
  // M8-fix: static dummies (AI gate) — see fist.test.ts / harness.
  const s = staticDummies(boot(weaponRangeSpec([{ x: 192, type: 3004 }])));
  const dummy = of(s, MT.MT_POSSESSED)[0]!;
  dummy.health = 1 << 20;
  const p = attachPsprFields(s.players[0]!);
  p.weaponowned[WP_PLASMA] = 1;
  p.ammo[AM_CELL] = 120;
  return { s, dummy, p };
}

describe('plasma — single-projectile fire at a zombie 64 units away', () => {
  it('one press: 3 fire draws (flash variant + spawn + missilespawn), hit +1', () => {
    const { s, dummy, p } = range();
    const spawnPrnd = s.rng.prndindex;
    const trace = trackPsprites(
      s,
      70,
      (t) => ({ attack: t === SWITCH_READY, weaponKey: t === RAISE_DONE ? 5 : undefined }),
      pinInPlace(s, dummy)
    );

    expect(trace[RAISE_DONE]!.weapon).toBe(11); // switch starts
    expect(trace[SWITCH_READY]!.weapon).toBe(77); // S_PLASMA1 fires on entry

    const shots = dmgTo(s, dummy);
    expect(shots).toHaveLength(1);
    // Impact tic: spawn tic 44 + flight (speed 25 u/tic over 64 units,
    // ±1 from the P_CheckMissileSpawn nudge — measured pin):
    expect(shots[0]!.tic).toBe(44); // nudge + first thinker tic cover the 64 units
    // Window (5 fire/impact draws + the painChance draw): dmg roll
    // re-derived at absolute spawnPrnd+4.
    expect(s.rng.prndindex).toBe(spawnPrnd + 5 + DAMAGE_DRAWS);
    const derived = ((RNDTABLE[(spawnPrnd + 4) & 0xff]! % 8) + 1) * 5;
    expect(shots[0]!.amount).toBe(derived);
    expect(derived % 5).toBe(0);
    expect(derived).toBeGreaterThanOrEqual(5);
    expect(derived).toBeLessThanOrEqual(40);
    // Flash variant draw k=0 selects 79/80:
    const flash = trace[SWITCH_READY]!.flash;
    expect([79, 80]).toContain(flash);
    // pRandom increments BEFORE reading → draw #1 reads RNDTABLE+1.
    expect(flash).toBe(79 + (RNDTABLE[(spawnPrnd + 1) & 0xff]! & 1));

    expect(p.ammo[AM_CELL]).toBe(119);
    expect(sfxCount(s, SFX_PLASMA)).toBe(1); // seesound at spawn
    // No splash: only the direct-hit event, no A_Explode roster.
    expect(s.hooks.damage.count).toBe(1);
    expect(s.mobjs.mobjs.filter((m) => m.type === MT.MT_PLASMA)).toHaveLength(1);
  });

  it('hold: S_PLASMA2-entry A_ReFire cycle, 4 draws per shot', () => {
    const { s, dummy, p } = range();
    const spawnPrnd = s.rng.prndindex;
    trackPsprites(
      s,
      90,
      (t) => ({ attack: true, weaponKey: t === RAISE_DONE ? 5 : undefined }),
      pinInPlace(s, dummy)
    );
    const shots = dmgTo(s, dummy);
    expect(shots.length).toBe(16); // fire 44,47,50,…3-tic cycle → ≤89
    for (let i = 1; i < 4; i++) {
      expect(shots[i]!.tic - shots[i - 1]!.tic).toBe(3);
    }
    // Per shot: [flash, lastlook, cms, dmg, explode] = 5 draws + painChance.
    expect(s.rng.prndindex).toBe(
      (spawnPrnd + (5 + DAMAGE_DRAWS) * shots.length) & 0xff
    );
    for (let i = 0; i < shots.length; i++) {
      const derived =
        ((RNDTABLE[(spawnPrnd + i * (5 + DAMAGE_DRAWS) + 4) & 0xff]! % 8) + 1) * 5;
      expect(shots[i]!.amount).toBe(derived);
    }
    expect(p.ammo[AM_CELL]).toBe(120 - shots.length);
  });
});
