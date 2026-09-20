/**
 * M7-10 — CHAINGUN L2 suite (§M7-10 acceptance 1; R08 §2.1 "fire occurs
 * at" + §1.5 0-tic S_CHAIN3 cascade = the same-tic double-fire guard).
 *
 * Chain S_CHAIN1(4, A_FireCGun entry)→2(4, A_FireCGun)→3(0-tic A_ReFire
 * → P_FireWeapon → S_CHAIN1 entry A_FireCGun IN THE SAME TIC) ⇒ one shot
 * every 4 tics while held. The first shot of a press is ACCURATE
 * (refire==0 ⇒ no jitter draws); every refire is inaccurate.
 *
 * Draws: accurate shot = 1 damage + 4 blood = 5; refire = +2 jitter = 7.
 * Ammo −1 clip per shot; sfx_pistol per shot; the FLASH psprite variant
 * `flashstate + state − S_CHAIN1` ⇒ 55 on CHAIN1 shots, 56 on CHAIN2
 * shots (p_pspr.c:615-638 — measured per-tic below).
 *
 * The EMPTY-GUN early-out (ammo==0 BEFORE the ammo read side effects)
 * plus the P_CheckAmmo fallback to the pistol rides the same machine.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { MT } from '../../src/wad/info/mobjinfo';
import { SFX_PISTOL, AM_CLIP, WP_CHAINGUN, attachPsprFields } from '../../src/sim/p_pspr';
import { RNDTABLE } from '../../src/sim/prng';

import { boot, dmgTo, of, sfxCount, trackPsprites } from './harness';
import { weaponRangeSpec } from '../fixtures/m7Fixtures';

const RAISE_DONE = 14;
const SWITCH_READY = 44; // pistol→chaingun (weaponKey '4')

function range() {
  const s = boot(weaponRangeSpec([{ x: 192, type: 3004 }]));
  const dummy = of(s, MT.MT_POSSESSED)[0]!;
  dummy.health = 1 << 20;
  const p = attachPsprFields(s.players[0]!);
  p.weaponowned[WP_CHAINGUN] = 1;
  return { s, dummy, p };
}

describe('chaingun — 4-tic cadence at a zombie 64 units away', () => {
  it('switch + 30 tics of hold: shots at F, F+4, F+8…, accurate first', () => {
    const { s, dummy, p } = range();
    const spawnPrnd = s.rng.prndindex;
    const trace = trackPsprites(s, SWITCH_READY + 20, (t) => ({
      attack: t >= RAISE_DONE, weaponKey: t === RAISE_DONE ? 3 : undefined
    }));
    expect(trace[RAISE_DONE]!.weapon).toBe(11); // PISTOLDOWN starts the switch
    const up = trace.findIndex((x) => x.weapon === 51); // S_CHAINUP
    expect(up).toBe(29);

    const shots = dmgTo(s, dummy);
    expect(shots.map((e) => e.tic)).toEqual([44, 48, 52, 56, 60]); // F=44 + 4k
    // Shot damage re-derivation: refire() only increments in A_ReFire, so
    // BOTH cascade-entry shots of the first cycle (CHAIN1+CHAIN2) stay
    // accurate — [d,bz,bz,ll,t]=5 each — and every A_ReFire-dispatched
    // shot is [d,j,j,bz,bz,ll,t]=7 (first cycle's CHAIN3 cascade onward).
    const offs = [0, 5, 10, 17, 24];
    for (let i = 0; i < shots.length; i++) {
      const derived = 5 * (RNDTABLE[(spawnPrnd + offs[i]! + 1) & 0xff]! % 3 + 1);
      expect(shots[i]!.amount).toBe(derived);
    }
    expect(s.rng.prndindex).toBe(spawnPrnd + 5 + 5 + 7 * 3);
    expect(p.ammo[AM_CLIP]).toBe(50 - 5);
    expect(sfxCount(s, SFX_PISTOL)).toBe(5);
    // Weapon-state cycle through the 0-tic CHAIN3 cascade (never observed
    // as a sampled state — it fires and re-dispatches in the same tic):
    const seq: number[] = [];
    let prev = -1;
    for (const x of trace.slice(SWITCH_READY)) {
      if (x.weapon !== prev) { seq.push(x.weapon); prev = x.weapon; }
    }
    expect(seq.slice(0, 4)).toEqual([52, 53, 52, 53]);
    // Flash variant per shot: 55 (CHAIN1 shots), 56 (CHAIN2 shots).
    expect(trace[44]!.flash).toBe(55);
    expect(trace[48]!.flash).toBe(56);
  });

  it('hold 80 tics: 1 shot / 4 tics, 5+7k draw accounting', () => {
    const { s, dummy, p } = range();
    const spawnPrnd = s.rng.prndindex;
    trackPsprites(s, SWITCH_READY + 80, (t) => ({
      attack: true, weaponKey: t === RAISE_DONE ? 3 : undefined
    }));
    const shots = dmgTo(s, dummy);
    expect(shots.length).toBe(20); // 44 + 4k ≤ 123
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i]!.tic - shots[i - 1]!.tic).toBe(4);
    }
    // Shots: n = 2 accurate + (n−2) refires.
    expect(s.rng.prndindex).toBe(spawnPrnd + 10 + 7 * (shots.length - 2));
    expect(p.ammo[AM_CLIP]).toBe(50 - shots.length);
  });

  it('dry chaingun: A_FireCGun early-out, then the ladder to the pistol', () => {
    const { s, dummy, p } = range();
    p.ammo[AM_CLIP] = 2; // two shots, third attempt: empty-gun return
    const trace = trackPsprites(s, SWITCH_READY + 60, (t) => ({
      attack: true, weaponKey: t === RAISE_DONE ? 3 : undefined
    }));
    expect(p.ammo[AM_CLIP]).toBe(0);
    const shots = dmgTo(s, dummy);
    expect(shots.length).toBe(2);
    // Ladder (clip empty, pistol owned) — CHAINDOWN entered via A_ReFire's
    // checkAmmo on the first empty attempt.
    const down = trace.findIndex((x) => x.weapon === 50); // S_CHAINDOWN
    expect(down).toBeGreaterThan(SWITCH_READY);
    expect(p.pendingweapon).toBe(10); // ladder resolved
    // Clip empty for EVERY clip gun ⇒ the ladder bottoms out at fists
    // (pistol branch is `p.ammo[AM_CLIP]`-gated too, p_ammo.ts).
    expect(p.readyweapon).toBe(0); // WP_FIST by the 104-tic end
    // No extra ammo burned by the empty-gun early-out.
    expect(sfxCount(s, SFX_PISTOL)).toBeGreaterThanOrEqual(2);
  });
});
