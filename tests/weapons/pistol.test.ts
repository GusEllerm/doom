/**
 * M7-10 — PISTOL L2 suite (docs/design/M7-plan.md §M7-10 acceptance 1;
 * R08 §2.1/§2.2; mirror p_pspr.c A_FirePistol/P_GunShot).
 *
 * Scripted shots at a zombie dummy 64 units on the eye line (close enough
 * that the ±(P_Random()-P_Random())<<18 jitter cannot escape the 16-unit
 * radius: 64·tan(5.62°) ≈ 6.3 ⇒ every aimed shot's damage is observable).
 *
 * Reborn spawns the pistol READY (G_PlayerReborn, R08 §10); its raise
 * completes at t=14 (16 A_Raise calls: boot + t0..t13, sy 128→32 step 6).
 * Fire at tic F, damage at F+4 (S_PISTOL1 tics 4, A_FirePistol entry on
 * S_PISTOL2 14; flash psprite 17 = S_PISTOLFLASH 7 tics):
 *   - damage = 5·(P_Random()%3+1) RE-DERIVED from the RNDTABLE window in
 *     the ledger draw order [damage, (jitter×2 iff refire), blood:
 *     zjit×2, lastlook, tics] — never from an engine replay;
 *   - ammo −1 per shot; ladder at exhaustion (pistol-only ⇒ fist +
 *     forced PISTOLDOWN);
 *   - 14-tic hold cadence (4+6+4; S_PISTOL4's A_ReFire fires on entry);
 *   - sfx_pistol (id 1) once per shot through the hooks.sfx slot;
 *   - prndindex delta golden: 5 (accurate first) + 7·(n−1).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { MT } from '../../src/wad/info/mobjinfo';
import { SFX_PISTOL, AM_CLIP, WP_FIST, attachPsprFields } from '../../src/sim/p_pspr';
import { RNDTABLE } from '../../src/sim/prng';

import { boot, dmgTo, of, sfxCount, staticDummies, trackPsprites } from './harness';
import { weaponRangeSpec } from '../fixtures/m7Fixtures';

const FU = 65536;
const RAISE_DONE = 14; // pistol ready tic (G_PlayerReborn spawn)

/** M8-05: draws the DAMAGE PATH adds per hit on an immortal dummy —
 * exactly the one `P_Random() < painchance` roll (p_inter.c:894; the
 * death-side `tics -= P_Random()&3` clamp (p_inter.c:725) cannot fire
 * here because every fixture dummy is pinned immortal or dies only in the
 * dedicated death suites, which pin that draw explicitly). */
const DAMAGE_DRAWS = 1;

function range() {
  // M8-fix: static dummies (AI gate) — see fist.test.ts / harness.
  const s = staticDummies(boot(weaponRangeSpec([{ x: 192, type: 3004 }])));
  const dummy = of(s, MT.MT_POSSESSED)[0]!;
  expect(dummy.x).toBe(192 * FU);
  dummy.health = 1 << 20; // immortal dummy: no death path inside the window
  return { s, dummy };
}

describe('pistol — scripted shots (zombie at 64 units)', () => {
  it('single press: damage re-derived from the prnd window, ammo −1, sfx 1', () => {
    const { s, dummy } = range();
    const spawnPrnd = s.rng.prndindex; // level-load desync baseline
    const p = attachPsprFields(s.players[0]!);

    // One-tic fire press at the ready tic (no refire: A_ReFire finds no
    // BT_ATTACK and resets refire).
    const trace = trackPsprites(s, 60, (t) => ({ attack: t === RAISE_DONE }));

    // Raise machine: 12 until the ready tic, then 10 (S_PISTOL ready).
    for (let t = 0; t < RAISE_DONE; t++) expect(trace[t]!.weapon).toBe(12);
    expect(trace[RAISE_DONE - 1]!.sy).toBe(38 * FU);
    expect(trace[RAISE_DONE]!.sy).toBe(32 * FU);

    const shots = dmgTo(s, dummy);    expect(shots).toHaveLength(1);
    expect(shots[0]!.tic).toBe(RAISE_DONE + 4); // S_PISTOL2 entry

    // Accurate shot = 5 weapon draws [damage, zjit, zjit, lastlook, tics]
    // + 1 damage-path draw: the victim's P_DamageMobj painChance roll
    // (p_inter.c:894) runs inside the damageSlot dispatch, i.e. AFTER the
    // blood draws (p_shoot.ts spawns blood, then calls damageSlot).
    expect(s.rng.prndindex).toBe(spawnPrnd + 5 + DAMAGE_DRAWS);
    const derived = 5 * (RNDTABLE[(spawnPrnd + 1) & 0xff]! % 3 + 1);
    expect(shots[0]!.amount).toBe(derived);
    expect([5, 10, 15]).toContain(shots[0]!.amount);

    // Psprite + flash sequence around the shot.
    const f = RAISE_DONE;
    for (let k = 0; k < 4; k++) expect(trace[f + k]!.weapon).toBe(13);
    for (let k = 4; k < 10; k++) {
      expect(trace[f + k]!.weapon).toBe(14);
      expect(trace[f + k]!.flash).toBe(17); // S_PISTOLFLASH (tics 7 → 6 visible)
    }
    expect(trace[f + 10]!.flash).toBe(0); // S_LIGHTDONE 0-tic → removed
    for (let k = 10; k < 14; k++) expect(trace[f + k]!.weapon).toBe(15);
    for (let k = 14; k < 19; k++) expect(trace[f + k]!.weapon).toBe(16);
    expect(trace[f + 19]!.weapon).toBe(10); // no BT_ATTACK: A_ReFire exits

    expect(p.ammo[AM_CLIP]).toBe(49);
    expect(sfxCount(s, SFX_PISTOL)).toBe(1);
    // Spawned-ROSTER (incl. removed): the blood puff has expired by tic 60.
    expect(s.mobjs.mobjs.filter((m) => m.type === MT.MT_BLOOD)).toHaveLength(1);
  });

  it('hold-to-refire: 14-tic cadence, refires consume +2 jitter draws', () => {
    const { s, dummy } = range();
    const spawnPrnd = s.rng.prndindex;
    const p = attachPsprFields(s.players[0]!);

    const trace = trackPsprites(s, 120, () => ({ attack: true }));
    const shots = dmgTo(s, dummy);
    expect(shots.length).toBe(8); // 18 + 14k ≤ 119
    expect(shots[0]!.tic).toBe(RAISE_DONE + 4);
    for (let i = 1; i < shots.length; i++) {
      expect(shots[i]!.tic - shots[i - 1]!.tic).toBe(14);
    }
    // Full-window re-derivation: shot 0 = 5 weapon draws + the victim's
    // painChance draw, every refire = 7 + 1 (damage draw first, then the
    // jitter pair, then the 4 blood draws, then painChance).
    expect(5 * (RNDTABLE[(spawnPrnd + 1) & 0xff]! % 3 + 1)).toBe(shots[0]!.amount);
    let k = 5 + DAMAGE_DRAWS;
    for (let i = 1; i < shots.length; i++) {
      expect(5 * (RNDTABLE[(spawnPrnd + k + 1) & 0xff]! % 3 + 1)).toBe(shots[i]!.amount);
      k += 7 + DAMAGE_DRAWS;
    }
    expect(s.rng.prndindex).toBe(
      spawnPrnd + 5 + DAMAGE_DRAWS + (7 + DAMAGE_DRAWS) * (shots.length - 1)
    );
    expect(p.ammo[AM_CLIP]).toBe(50 - shots.length);
    expect(sfxCount(s, SFX_PISTOL)).toBe(shots.length);
    expect(trace[trace.length - 1]!.weapon).toBe(14); // mid-cycle (8th shot fired 112)
  });

  it('out of ammo: ladder falls back to fists, forced PISTOLDOWN', () => {
    const { s } = range();
    const p = attachPsprFields(s.players[0]!);
    p.ammo[AM_CLIP] = 2; // shots at t14 and t28, ladder at t42
    const trace = trackPsprites(s, 160, () => ({ attack: true }));
    expect(p.ammo[AM_CLIP]).toBe(0);
    const down = trace.findIndex((x) => x.weapon === 11); // S_PISTOLDOWN
    expect(down).toBe(42); // third refire attempt fails the gate
    const fistUp = trace.findIndex((x) => x.weapon === 4); // S_PUNCHUP
    expect(fistUp).toBe(down + 15); // lower = 16 A_Lower calls
    // Raise completes 14 tics later; attack is STILL held, so the ready
    // tic itself already dispatches P_FireWeapon (state 5 = S_PUNCH1) —
    // state 2 never survives a full tic sample.
    const fistReady = trace.findIndex((x) => x.weapon === 5); // S_PUNCH1
    expect(fistReady).toBe(fistUp + 15); // 15 further A_Raise calls
    expect(p.readyweapon).toBe(WP_FIST);
    expect(p.pendingweapon).toBe(10); // wp_nochange
    expect(p.attackdown).toBe(true);
  });
});
