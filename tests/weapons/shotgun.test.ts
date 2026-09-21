/**
 * M7-10 — SHOTGUN L2 suite (§M7-10 acceptance 1; R08 §2.2; mirror
 * p_pspr.c A_FireShotgun — SEVEN pellets, each an inaccurate
 * P_GunShot: damage 5·(P_R()%3+1) draw FIRST, then the 2 jitter draws,
 * then the 4 impact-mobj draws per pellet (49 draws per volley).
 *
 * Chain S_SGUN1(3)→2(7, A_FireShotgun entry ⇒ volley at F+3)→3(5)→4(5)
 * →5(4)→6(5)→7(5)→8(3)→9(7, A_ReFire entry ⇒ hold cycle 37).
 * Ammo −1 shell per volley; sfx_dshtgn (id 2) once per volley; flash
 * psprite S_SGUNFLASH1(30) 4 tics then FLASH2(31) 3 tics.
 *
 * The switch path (pistol→shotgun via the '3' slot key) rides the 16+16
 * lower/raise machine: pistol ready t14 → SGUNDOWN 16 → SGUNUP → ready
 * t44 ⇒ first volley damage at t47.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { MT } from '../../src/wad/info/mobjinfo';
import { SFX_SHOTGN, AM_SHELL, WP_SHOTGUN, attachPsprFields } from '../../src/sim/p_pspr';
import { RNDTABLE } from '../../src/sim/prng';

import { boot, dmgTo, of, pinInPlace, sfxCount, trackPsprites } from './harness';

/** M8-05: the live P_DamageMobj kick (p_inter.c:826-857) adds ONE draw per
 * hit (the painChance roll, p_inter.c:894) and pushes the dummy — these
 * suites derive the fire-stream window, so the dummy is held in place by
 * harness.pinInPlace and the per-hit window is 7+1. The kick itself is
 * pinned in src/sim/p_inter_damage.test.ts. */
const DAMAGE_DRAWS = 1;
import { weaponRangeSpec } from '../fixtures/m7Fixtures';

const FU = 65536;
const SWITCH_READY = 44; // pistol→shotgun: 14 + 15 + 15
const VOLLEY_TIC = SWITCH_READY + 3;

function range() {
  const s = boot(weaponRangeSpec([{ x: 192, type: 3004 }]));
  const dummy = of(s, MT.MT_POSSESSED)[0]!;
  dummy.health = 1 << 20;
  const p = attachPsprFields(s.players[0]!);
  p.weaponowned[WP_SHOTGUN] = 1;
  p.ammo[AM_SHELL] = 30;
  return { s, dummy, p };
}

describe('shotgun — 7-pellet volleys at a zombie 64 units away', () => {
  it('switch + volley: 7×{5,10,15} re-derived, ammo −1, 49 draws', () => {
    const { s, dummy, p } = range();
    const spawnPrnd = s.rng.prndindex;
    const trace = trackPsprites(
      s,
      70,
      (t) => ({ attack: t >= 14, weaponKey: t === 14 ? 2 : undefined }),
      pinInPlace(s, dummy)
    );
    // Switch machine: PISTOLDOWN at 14, SGUNUP at 29, SGUN ready+fire 44.
    expect(trace[14]!.weapon).toBe(11);
    const up = trace.findIndex((x) => x.weapon === 20); // S_SGUNUP
    expect(up).toBe(29);
    expect(trace[SWITCH_READY]!.weapon).toBe(21); // fired: S_SGUN1
    expect(trace[SWITCH_READY]!.sy).toBe(32 * FU);

    const shots = dmgTo(s, dummy);
    expect(shots).toHaveLength(7);
    for (const e of shots) expect(e.tic).toBe(VOLLEY_TIC);
    // Per-pellet ledger order: dmg, jit, jit, impact×4, painChance → 8k+1.
    for (let k = 0; k < 7; k++) {
      const derived =
        5 * (RNDTABLE[(spawnPrnd + k * (7 + DAMAGE_DRAWS) + 1) & 0xff]! % 3 + 1);
      expect(shots[k]!.amount).toBe(derived);
      expect([5, 10, 15]).toContain(shots[k]!.amount);
    }
    expect(s.rng.prndindex).toBe(spawnPrnd + (49 + 7 * DAMAGE_DRAWS));
    expect(p.ammo[AM_SHELL]).toBe(29);
    expect(sfxCount(s, SFX_SHOTGN)).toBe(1);

    // Flash chain: 30 (4 tics incl. set tic) then 31 (3 tics).
    for (let k = 0; k < 3; k++) expect(trace[VOLLEY_TIC + k]!.flash).toBe(30);
    for (let k = 3; k < 6; k++) expect(trace[VOLLEY_TIC + k]!.flash).toBe(31);
  });

  it('hold: 37-tic cycle, 7 volleys of blood', () => {
    const { s, dummy, p } = range();
    const spawnPrnd = s.rng.prndindex;
    trackPsprites(
      s,
      200,
      (t) => ({ attack: true, weaponKey: t === 14 ? 2 : undefined }),
      pinInPlace(s, dummy)
    );
    const shots = dmgTo(s, dummy);
    expect(shots.length).toBe(35); // 5 volleys × 7
    const tics = [...new Set(shots.map((e) => e.tic))].sort((a, b) => a - b);
    expect(tics).toEqual([47, 84, 121, 158, 195]);
    expect(s.rng.prndindex).toBe((spawnPrnd + (49 + 7 * DAMAGE_DRAWS) * 5) & 0xff);
    expect(p.ammo[AM_SHELL]).toBe(30 - 5);
    expect(sfxCount(s, SFX_SHOTGN)).toBe(5);
    // Spawned blood roster (removed included): 7 per volley.
    expect(s.mobjs.mobjs.filter((m) => m.type === MT.MT_BLOOD)).toHaveLength(35);
  });

  it('out of shells: ladder → pistol (owned, loaded) with forced SGUNDOWN', () => {
    const { s, p } = range();
    p.ammo[AM_SHELL] = 1; // one volley, then the ladder
    const trace = trackPsprites(s, 160, (t) => ({
      attack: true, weaponKey: t === 14 ? 2 : undefined
    }));
    expect(p.ammo[AM_SHELL]).toBe(0);
    const down = trace.findIndex((x) => x.weapon === 19); // S_SGUNDOWN
    expect(down).toBe(81); // fire-tic 44 + 37-cycle, gate fails on SGUN9 entry
    // Ladder fully resolves within the 160-tic window: pistol picked,
    // SGUNDOWN 81..95, PISTOLUP, ready + firing again by 111.
    expect(p.pendingweapon).toBe(10); // wp_nochange again
    expect(p.readyweapon).toBe(1); // WP_PISTOL
    const pistolUp = trace.findIndex((x) => x.weapon === 12 && x.tic > down);
    expect(pistolUp).toBe(96);
  });
});
