/**
 * M7-10 — ROCKET LAUNCHER L2 suite (§M7-10 acceptance 1; R07 §9.1/§9.2,
 * R08 §3.6, random-sites.md SPLASH TRUTH). Fire on S_MISSILE2 ENTRY
 * (F+8: atkstate tics 8, refire cascade 12 ⇒ 20-tic hold cycle — A_ReFire
 * has NO missile latch; the LATCH is only the A_WeaponReady first-shot
 * gate: boot pins attackdown=true, so a rocket/BFG needs one no-press
 * ready tic, then a press — the script shape below).
 *
 * DIRECT hit = (P_Random()%8+1)·20 → 20..160 (one draw); the explosion
 * that follows is A_Explode → P_RadiusAttack(bomb=128): every thing in
 * LOS gets 128 − ((AproxDistance−radius)>>16) — INCLUDING the shooter
 * (no source exclusion; the 64-unit self-splash is 115 at the measured
 * explosion x — the "rockets never hurt shooter" lore is only the
 * same-species thing-skip on the missile's own traces).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { MT } from '../../src/wad/info/mobjinfo';
import { AM_MISL, attachPsprFields } from '../../src/sim/p_pspr';
import { resolveSfxId } from '../../src/sim/psound_stub';
import { RNDTABLE } from '../../src/sim/prng';

import {
  boot, dmgEvents, of, pinInPlace, rederiveSplashFixed, sfxCount, staticDummies,
  trackPsprites, type DmgEvent
} from './harness';
import type { Mobj } from '../../src/sim/p_mobj';
import type { GameState } from '../../src/sim/state';
import { weaponRangeSpec } from '../fixtures/m7Fixtures';

const SFX_LAUNCH = resolveSfxId('sfx_rlaunc');
const SFX_BOOM = resolveSfxId('sfx_barexp');
const RAISE_DONE = 14;
const PRESS = 46; // latch-cleared press: 44/45 ready tics without attack

function range(dummies: { x: number; type?: number }[]) {
  // M8-fix: static dummies (AI gate) — see fist.test.ts / harness.
  const s = staticDummies(boot(weaponRangeSpec(
    dummies.map((d) => ({ x: d.x, type: d.type ?? 3004 }))
  )));
  for (const m of s.mobjs.mobjs) if (!m.removed && m.type !== 0) m.health = 1 << 20;
  const p = attachPsprFields(s.players[0]!);
  p.weaponowned[4] = 1; // WP_MISSILE
  p.ammo[AM_MISL] = 30;
  return { s, p };
}

/** Damage identity: the log stores the slot AT DAMAGE TIME (hooks.ts records
 * before the M8-05 bridge dispatch) and the kick promotes a static THINGS
 * dummy to a mover slot once per lifetime (p_inter_damage.ts) — resolve
 * through the runtime slot map instead of the live linkSlot. */
const dmgOn = (s: GameState, m: Mobj): DmgEvent[] =>
  dmgEvents(s).filter((e) => e.thing === m.linkSlot || s.mobjs.slotMobjs.get(e.thing) === m);

/** Draws one damage event adds beyond its own damage roll: the victim's
 * painChance roll (p_inter.c:894). The PLAYER half stays record-only at the
 * bridge (D-m1, p_inter_damage.ts), so self-splash costs nothing. */
const DAMAGE_DRAWS = 1;

const hold = (t: number) => ({
  attack: t >= PRESS, weaponKey: t === RAISE_DONE ? 4 : undefined
});

describe('rocket — direct + splash matrix re-derived from the blast point', () => {
  it('direct hit: 20·(r%8+1), then 128-splash to dummy, shooter and far zombie', () => {
    const { s, p } = range([{ x: 192 }, { x: 288 }]);
    const dummy = of(s, MT.MT_POSSESSED)[0]!;
    const far = of(s, MT.MT_POSSESSED)[1]!;
    const player = s.players[0]!.mo;
    const spawnPrnd = s.rng.prndindex;
    const pinDummy = pinInPlace(s, dummy);
    const pinFar = pinInPlace(s, far);
    const trace = trackPsprites(
      s,
      90,
      (t) => ({ attack: t === PRESS, weaponKey: t === RAISE_DONE ? 4 : undefined }),
      // Both dummies held: the splash amounts are re-derived from their
      // positions, and each damage event kicks its victim (M8-05 thrust).
      () => {
        pinDummy();
        pinFar();
      }
    );
    expect(trace[PRESS]!.weapon).toBe(60); // P_FireWeapon → S_MISSILE1
    expect(trace[PRESS + 8]!.weapon).toBe(61); // S_MISSILE2 fires the shot

    const toDummy = dmgOn(s, dummy);
    expect(toDummy).toHaveLength(2); // direct + splash
    expect(toDummy[0]!.tic).toBe(55);
    // Draws: [lastlook, cms] at 54 + [(dmg), explode] at 55, then ONE
    // painChance roll per NON-player damage event (dummy direct, dummy
    // splash, far zombie — the player's self-splash stays record-only,
    // D-m1) — M8-05.
    expect(s.rng.prndindex).toBe(spawnPrnd + 4 + 3 * DAMAGE_DRAWS);
    const direct = ((RNDTABLE[(spawnPrnd + 3) & 0xff]! % 8) + 1) * 20;
    expect(direct % 20).toBe(0);
    expect(toDummy[0]!.amount).toBe(direct);

    // Explosion point = rocket position when blocked (roster keeps it):
    const rocket = s.mobjs.mobjs.find((m) => m.type === MT.MT_ROCKET)!;
    const ex = rocket.x;
    const splashDummy = rederiveSplashFixed(
      128, dummy.x - ex, dummy.y - player.y, dummy.radius
    );
    expect(splashDummy).not.toBeNull();
    expect(toDummy[1]!.amount).toBe(splashDummy!);
    expect(toDummy[1]!.amount).toBeGreaterThan(110);

    // Shooter splash — the "rocket-jump" damage, no source exclusion.
    const self = dmgOn(s, player as unknown as Mobj);
    expect(self).toHaveLength(1);
    expect(self[0]!.amount).toBe(
      rederiveSplashFixed(128, player.x - ex, 0, player.radius)
    );
    expect(self[0]!.amount).toBeGreaterThan(100);

    // Far zombie at 288: 130 units from the blast — inside r=128? NO:
    // (dx − 20) ≈ 110 < 128 ⇒ it DOES take 128−110 = ~14 splash.
    const farEv = dmgOn(s, far);
    expect(farEv).toHaveLength(1);
    expect(farEv[0]!.amount).toBe(
      rederiveSplashFixed(128, far.x - ex, 0, far.radius)
    );

    expect(p.ammo[AM_MISL]).toBe(29);
    expect(sfxCount(s, SFX_LAUNCH)).toBe(1); // seesound at spawn
    expect(sfxCount(s, SFX_BOOM)).toBe(1); // death sight/sound
  });

  it('hold: 20-tic A_ReFire cycle, 4 draws per rocket', () => {
    const { s, p } = range([{ x: 192 }]);
    const dummy = of(s, MT.MT_POSSESSED)[0]!;
    const spawnPrnd = s.rng.prndindex;
    trackPsprites(s, 200, hold, pinInPlace(s, dummy));
    const tics = [...new Set(dmgOn(s, dummy).filter((e) => e.amount % 20 === 0 && e.amount <= 160).map((e) => e.tic))];
    const hits = [...new Set(dmgEvents(s).map((e) => e.tic))].filter((t) => t < 200);
    expect(tics).toHaveLength(hits.length);
    expect(tics.length).toBeGreaterThanOrEqual(7); // 55,75,…,175 (+…206 out)
    for (let i = 1; i < tics.length; i++) {
      expect(tics[i]! - tics[i - 1]!).toBe(20);
    }
    // Per rocket: 4 fire/impact draws + the direct-hit and splash
    // painChance rolls on the dummy.
    expect(s.rng.prndindex).toBe(
      (spawnPrnd + (4 + 2 * DAMAGE_DRAWS) * tics.length) & 0xff
    );
    expect(p.ammo[AM_MISL]).toBe(30 - tics.length);
  });
});
