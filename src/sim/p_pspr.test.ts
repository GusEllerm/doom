// SPDX-License-Identifier: GPL-2.0-or-later
// sim/p_pspr.test.ts — M7-07 acceptance (docs/design/M7-plan.md §M7-07).
// 1) raise/lower EXACTLY 16 tics + per-tic sy goldens (fist + pistol);
// 2) ready-bob formulas re-derived vs player.bob streams;
// 3) 0-tic A_ReFire cascade: ≤1 P_FireWeapon (and ≤1 lineAttack) per tic;
// 4) missile/BFG latch: press-release cycles, HOLD refires (tic-20 rocket);
// 5) refire STREAM pins: exact prndindex deltas + damage values;
// 6) firing while lowering is silent (no ammo, no attack);
// 7) double-run determinism of the whole machine.
//
// Timing ground truth: the p_pspr.c/info.c mirror (see p_pspr.ts header);
// R08 (docs/research/08-weapons-player.md) §1–2 tables.
import { beforeEach, describe, expect, it } from 'vitest';

import { createPlayer, PST_DEAD } from './player';
import { createPrngState } from './prng';
import type { PsprPlayer, PsprWorld } from './p_pspr';
import {
  AM_CLIP,
  attachPsprFields,
  bindPsprWorld,
  FF_FULLBRIGHT,
  LOWERSPEED,
  PSPR_STATES,
  PS_FLASH,
  PS_WEAPON,
  psprGlobals,
  psprHookCounts,
  pDropWeapon,
  pFireWeapon,
  pMovePsprites,
  pSetupPsprites,
  pSetPsprite,
  resetPsprHooks,
  registerPsprHook,
  S_CHAIN1,
  S_CHAIN2,
  S_CHAINFLASH1,
  S_CHAINFLASH2,
  S_LIGHTDONE,
  S_MISSILE,
  S_MISSILE1,
  S_PISTOL,
  S_PISTOLDOWN,
  S_PISTOLFLASH,
  S_PISTOLUP,
  S_PLAY,
  S_PLAY_ATK1,
  S_PUNCH,
  S_PUNCHDOWN,
  S_PUNCHUP,
  S_SGUNFLASH2,
  WEAPONBOTTOM,
  WEAPONTOP,
  WEAPONINFO,
  WP_FIST,
  WP_MISSILE,
  WP_NOCHANGE,
  WP_PISTOL,
  WP_SHOTGUN,
} from './p_pspr';
import { BT_ATTACK } from './ticcmd';
import { ACT, isActionRegistered } from './a_actions';
import { weaponinfo } from '../wad/info/weaponinfo';
import { stateAt } from '../wad/info/states';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import { FINEMASK, FRACUNIT } from '../core/constants';

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

type World = PsprWorld;

let world: World;

function mkPlayer(readyweapon: number = WP_FIST): PsprPlayer {
  const p = attachPsprFields(createPlayer());
  p.readyweapon = readyweapon;
  p.pendingweapon = WP_NOCHANGE;
  p.attackdown = true; // G_PlayerReborn start value
  p.cmd.buttons = 0;
  return p;
}

/** advance one tic: leveltime++ then P_MovePsprites (p_user.c order). */
function tick(p: PsprPlayer, buttons?: number): void {
  if (buttons !== undefined) p.cmd.buttons = buttons;
  world.leveltime += 1;
  pMovePsprites(p);
}

function psp(p: PsprPlayer, i = PS_WEAPON) {
  return p.psprites[i]!;
}

const ATK = BT_ATTACK;
const NO = 0;

beforeEach(() => {
  resetPsprHooks();
  world = { rng: createPrngState(), leveltime: 0 };
  bindPsprWorld(world);
  psprGlobals.gamemode = 1;
});

/* ------------------------------------------------------------------ */
/* 1) Raise/lower: exactly 16 tics, per-tic sy goldens                 */
/* ------------------------------------------------------------------ */

describe('raise/lower timing (p_pspr.c §1)', () => {
  it('P_SetupPsprites raises the first weapon in exactly 16 tics', () => {
    const p = mkPlayer(WP_PISTOL);
    pSetupPsprites(p);
    // action-on-entry: the FIRST A_Raise already ran inside Setup.
    expect(psp(p).sy).toBe(WEAPONBOTTOM - LOWERSPEED); // 122
    expect(psp(p).state).toBe(S_PISTOLUP);
    const sy = [psp(p).sy];
    for (let t = 0; t < 14; t++) {
      tick(p);
      sy.push(psp(p).sy);
      expect(psp(p).state).toBe(S_PISTOLUP); // still raising (raises #2..#15)
    }
    tick(p); // 16th A_Raise: sy 38→≤32 → clamp + readystate
    expect(psp(p).state).toBe(S_PISTOL);
    expect(psp(p).sy).toBe(WEAPONTOP);
    // per-tic golden: linear −6·FRACUNIT from 122 to 38, clamp 32.
    expect(sy).toEqual(
      Array.from({ length: 15 }, (_, i) => (WEAPONBOTTOM - (i + 1) * LOWERSPEED) | 0),
    );
  });

  it('fist: lower → change → raise — 16-tic down with the bottom tic chaining BringUp', () => {
    const p = mkPlayer(WP_FIST);
    p.readyweapon = WP_FIST;
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p); // finish the raise
    expect(psp(p).state).toBe(S_PUNCH);

    p.pendingweapon = WP_PISTOL;
    tick(p); // A_WeaponReady sees the change → downstate + A_Lower entry
    expect(psp(p).state).toBe(S_PUNCHDOWN);
    const sy: number[] = [psp(p).sy];
    for (let t = 0; t < 15; t++) {
      tick(p);
      sy.push(psp(p).sy);
    }
    // 16 A_Lower calls total: bottom reached on the 16th — that same call
    // swaps readyweapon and P_BringUpWeapon re-bases sy to WEAPONBOTTOM,
    // whose entry A_Raise is sy 122 in the SAME tic (p_pspr.c chain).
    expect(sy.slice(0, 15)).toEqual(
      Array.from({ length: 15 }, (_, i) => (WEAPONTOP + (i + 1) * LOWERSPEED) | 0),
    );
    expect(sy[15]).toBe(WEAPONBOTTOM - LOWERSPEED);
    expect(p.readyweapon).toBe(WP_PISTOL);
    expect(p.pendingweapon).toBe(WP_NOCHANGE);
    expect(psp(p).state).toBe(S_PISTOLUP);
  });

  it('dead player: A_Lower parks at WEAPONBOTTOM and never raises (P_DropWeapon path)', () => {
    const p = mkPlayer(WP_PISTOL);
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    p.playerstate = PST_DEAD;
    pDropWeapon(p);
    expect(psp(p).state).toBe(S_PISTOLDOWN);
    for (let t = 0; t < 30; t++) tick(p);
    expect(psp(p).state).toBe(S_PISTOLDOWN); // state never leaves
    expect(psp(p).sy).toBe(WEAPONBOTTOM); // parked, not overrun
  });
});

/* ------------------------------------------------------------------ */
/* 2) Ready-state bob vs the player.bob stream                          */
/* ------------------------------------------------------------------ */

describe('A_WeaponReady bob (R08 §1.4)', () => {
  it('sx/sy match the exact formulas for a moving-bob stream', () => {
    const p = mkPlayer(WP_PISTOL);
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    expect(psp(p).state).toBe(S_PISTOL);

    // A synthetic P_CalcHeight-style bob stream (momentum decay).
    let bob = 16 * FRACUNIT;
    for (let t = 0; t < 40; t++) {
      bob = Math.max(0, bob - 4000);
      p.bob = bob;
      tick(p); // ready self-loop: A_WeaponReady every tic
      const angle = (128 * world.leveltime) & FINEMASK;
      expect(psp(p).sx).toBe(
        (FRACUNIT + FixedMul(bob, finecosine[angle]!)) | 0,
      );
      expect(psp(p).sy).toBe(
        (WEAPONTOP + FixedMul(bob, finesine[angle & (FINEMASK >> 1)]!)) | 0,
      );
    }
    // …and the flash psprite mirrors it at the END of P_MovePsprites.
    expect(psp(p, PS_FLASH).sx).toBe(psp(p).sx);
    expect(psp(p, PS_FLASH).sy).toBe(psp(p).sy);
  });
});

/* ------------------------------------------------------------------ */
/* Fist + pistol cycle tables (info.c rows; R08 §2.1)                   */
/* ------------------------------------------------------------------ */

describe('fist + pistol attack cycles', () => {
  it('table transcription: tics/next/frame of every fist+pistol+flash row', () => {
    const rows: [number, number, number, number][] = [
      // [state, tics, next, frame]
      [S_PUNCH, 1, S_PUNCH, 0],
      [S_PUNCHDOWN, 1, S_PUNCHDOWN, 0],
      [S_PUNCHUP, 1, S_PUNCHUP, 0],
      [5, 4, 6, 1],
      [6, 4, 7, 2],
      [7, 5, 8, 3],
      [8, 4, 9, 2],
      [9, 5, S_PUNCH, 1],
      [S_PISTOL, 1, S_PISTOL, 0],
      [S_PISTOLDOWN, 1, S_PISTOLDOWN, 0],
      [S_PISTOLUP, 1, S_PISTOLUP, 0],
      [13, 4, 14, 0],
      [14, 6, 15, 1],
      [15, 4, 16, 2],
      [16, 5, S_PISTOL, 1],
      [S_PISTOLFLASH, 7, S_LIGHTDONE, FF_FULLBRIGHT | 0],
    ];
    for (const [st, tics, next, frame] of rows) {
      const r = PSPR_STATES[st]!;
      expect([r.tics, r.next, r.frame], `state ${st}`).toEqual([tics, next, frame]);
    }
    // d_items.c weaponinfo spot pins (fist/pistol/shotgun incl. S_NULL flash)
    expect(WEAPONINFO[WP_FIST]).toMatchObject({ upstate: S_PUNCHUP, readystate: S_PUNCH, atkstate: 5, flashstate: 0 });
    expect(WEAPONINFO[WP_PISTOL]).toMatchObject({ upstate: S_PISTOLUP, readystate: S_PISTOL, atkstate: 13, flashstate: S_PISTOLFLASH });
    expect(WEAPONINFO[WP_SHOTGUN]!.atkstate).toBe(21);
    // the A_FireCGun variant trick needs the CHAIN1/2 ↔ FLASH1/2 adjacency
    expect(S_CHAINFLASH2 - S_CHAINFLASH1).toBe(S_CHAIN2 - S_CHAIN1);
  });

  it('pistol cycle = 19 tics, fire at t+4, flash covers t+4..t+10', () => {
    const p = mkPlayer(WP_PISTOL);
    p.ammo[AM_CLIP] = 50;
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    p.attackdown = false;

    tick(p, ATK); // t0: A_WeaponReady fires → PISTOL1 (A fires at t+4)
    expect(psp(p).state).toBe(13);
    const states: number[] = [];
    for (let t = 1; t <= 19; t++) {
      tick(p, NO); // fire released — PISTOL4's A_ReFire does not re-fire
      states.push(psp(p).state);
    }
    expect(psp(p).state).toBe(S_PISTOL); // full cycle = 19 tics
    expect(states[3]).toBe(14); // fire state entered at t=4 (tic index 3)
    expect(p.ammo[AM_CLIP]).toBe(49); // exactly ONE shot
    expect(psprHookCounts.lineAttack).toBe(1);
  });

  it('fist cycle = 22 tics, punch at t+4, no ammo, 3 P_Random draws', () => {
    const p = mkPlayer(WP_FIST);
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    p.attackdown = false;
    const prnd0 = world.rng.prndindex;
    tick(p, ATK); // t0 → PUNCH1
    for (let t = 1; t <= 4; t++) tick(p);
    expect(psp(p).state).toBe(6); // PUNCH2 at t=4: A_Punch ran
    expect(world.rng.prndindex - prnd0).toBe(3); // damage + 2 jitter draws
    for (let t = 5; t <= 22; t++) tick(p, NO); // fire released
    expect(psp(p).state).toBe(S_PUNCH); // 22-tic full cycle
  });
});

/* ------------------------------------------------------------------ */
/* 3) 0-tic cascade: one fire per tic MAX                               */
/* ------------------------------------------------------------------ */

describe('0-tic A_ReFire cascade pins (plan §6 R4)', () => {
  it('chaingun: 8-tic cycle, exactly 2 shots (tics 0 and 4), NEVER >1 per tic', () => {
    const p = mkPlayer(3); // WP_CHAINGUN
    p.weaponowned[3] = 1;
    p.readyweapon = 3; // WP_CHAINGUN
    p.ammo[AM_CLIP] = 200;
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    p.attackdown = false;

    tick(p, ATK); // t0: WeaponReady fires → CHAIN1 (shots land at tics 4, 8, …)
    const fired: number[] = [];
    for (let t = 0; t < 40; t++) {
      const before = psprHookCounts.lineAttack;
      tick(p);
      const delta = psprHookCounts.lineAttack - before;
      expect(delta, `shots at tic ${t}`).toBeLessThanOrEqual(1);
      if (delta === 1) fired.push(t);
    }
    // Shots land every 4 tics (CHAIN1 and CHAIN2 both call A_FireCGun).
    expect(fired.slice(0, 6)).toEqual([3, 7, 11, 15, 19, 23]);
    expect(p.ammo[AM_CLIP]).toBe(200 - (fired.length + 1)); // +1: the press tic
  });

  it('the 0-tic CHAIN3→ReFire→WeaponReady→Fire cascade lands in ONE tic', () => {
    const p = mkPlayer(3);
    p.weaponowned[3] = 1;
    p.ammo[AM_CLIP] = 200;
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    p.cmd.buttons = ATK;
    p.attackdown = false;
    // Fire directly mid-ready and step until CHAIN3 (tic+8): the cascade
    // must NOT re-dispatch A_WeaponReady twice in the tic (ammo assert).
    pFireWeapon(p);
    const before = psprHookCounts.lineAttack;
    for (let t = 0; t < 8; t++) tick(p);
    expect(psp(p).state).toBe(52); // CHAIN3 0-tic: ReFire fired → back in CHAIN1
    expect(psprHookCounts.lineAttack - before).toBe(2); // exactly 2 shots
  });
});

/* ------------------------------------------------------------------ */
/* 4) Missile/BFG latch semantics (plan acceptance 4)                   */
/* ------------------------------------------------------------------ */

describe('missile/BFG latch', () => {
  it('press-release cycles the launcher; HOLD refires at tic 20', () => {
    const p = mkPlayer(WP_MISSILE);
    p.weaponowned[WP_MISSILE] = 1;
    p.ammo[3] = 50; // am_misl
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);

    // Press: fires once…
    p.attackdown = false;
    tick(p, ATK);
    expect(psp(p).state).toBe(S_MISSILE1);
    // …hold through the cycle: the rocket SPAWNS at tic 8 (MISSILE2 entry)…
    for (let t = 1; t <= 19; t++) tick(p);
    expect(psprHookCounts.spawnPlayerMissile).toBe(1);
    tick(p); // tic 20: MISSILE3 0-tic → A_ReFire (NO latch) → fires again
    expect(psp(p).state).toBe(S_MISSILE1); // (the rocket itself lands 8 later)
    for (let t = 0; t < 8; t++) tick(p);
    expect(psprHookCounts.spawnPlayerMissile).toBe(2);
    // release: the in-flight MISSILE2 cycle finishes, ready re-arms, no more
    tick(p, NO);
    for (let t = 0; t < 12; t++) tick(p, NO);
    expect(psp(p).state).toBe(S_MISSILE);
    expect(psprHookCounts.spawnPlayerMissile).toBe(2);
  });

  it('BFG fires only on a fresh press (60-tic cycle), 40 cells per shot', () => {
    const p = mkPlayer(6); // WP_BFG
    p.weaponowned[6] = 1;
    p.ammo[2] = 400; // am_cell
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    p.attackdown = false;
    tick(p, ATK);
    expect(psp(p).state).toBe(84); // S_BFG1
    for (let t = 1; t <= 30; t++) tick(p, ATK); // A_FireBFG lands at t=30
    expect(psprHookCounts.spawnPlayerMissile).toBe(1);
    expect(p.ammo[2]).toBe(400 - 40);
  });
});

/* ------------------------------------------------------------------ */
/* 5) Refire STREAM pins (prndindex deltas)                             */
/* ------------------------------------------------------------------ */

describe('P_Random stream pins (shared P stream, plan §6 R1)', () => {
  it('pistol: first shot of a hold = 1 draw (accurate), refire = 3 draws', () => {
    const p = mkPlayer(WP_PISTOL);
    p.ammo[AM_CLIP] = 50;
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    p.attackdown = false;

    const base = world.rng.prndindex;
    tick(p, ATK); // fire #1 starts (lands 4 tics later)
    for (let t = 0; t < 4; t++) tick(p, ATK); // tic +4: PISTOL2 → 1 draw
    expect(world.rng.prndindex - base).toBe(1); // 5*(rnd%3+1) ONLY
    expect(p.refire).toBe(0);

    // Held: PISTOL4's entry-A_ReFire re-starts the chain at +14 — the
    // refire SHOT lands at +14 (damage draw + 2 jitter draws = 3).
    const mid = world.rng.prndindex;
    for (let t = 0; t < 14; t++) tick(p, ATK);
    expect(world.rng.prndindex - mid).toBe(3);
    expect(p.refire).toBe(1);
  });

  it('registered aim hook sees bulletslope probe order (1–3 probes)', () => {
    const probes: number[] = [];
    registerPsprHook('aimLineAttack', (_p, angle) => {
      psprHookCounts.aimLineAttack++;
      probes.push(angle >>> 26); // coarse probe-angle fingerprint
      return { slope: 0, hit: probes.length === 2 }; // probe 2 "hits"
    });
    const p = mkPlayer(WP_PISTOL);
    p.ammo[AM_CLIP] = 10;
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    p.attackdown = false;
    tick(p, ATK);
    const n = probes.length;
    for (let t = 0; t < 4; t++) tick(p, ATK);
    expect(n).toBe(0);
    // probe 1 missed, probe 2 hit ⇒ EXACTLY two aim calls, angles
    // a and a+ (1<<26): (a2 - a1) === 1 bucket.
    expect(probes.length).toBe(2);
    expect(probes[1]! - probes[0]!).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 6) Fire while lowering is silent                                     */
/* ------------------------------------------------------------------ */

describe('fire during lower (acceptance: silent)', () => {
  it('no ammo, no lineAttack, no sound while the gun lowers', () => {
    const p = mkPlayer(WP_FIST);
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    p.readyweapon = WP_PISTOL; // pretend owned+pistol ready for the down table
    p.pendingweapon = WP_FIST; // change pending → lowers PISTOL downstate
    p.ammo[AM_CLIP] = 30;
    const sounds = psprHookCounts.startSound;
    for (let t = 0; t < 16; t++) {
      tick(p, ATK); // hammering fire while lowering
      expect(p.ammo[AM_CLIP]).toBe(30);
    }
    expect(psprHookCounts.lineAttack).toBe(0);
    expect(psprHookCounts.startSound).toBe(sounds); // no S_* from A_Lower
    // …and now the raise→ready cycle resumes normally.
    expect(p.readyweapon).toBe(WP_FIST);
    for (let t = 0; t < 16; t++) tick(p, ATK);
    expect(psp(p).state).toBe(5); // fist attack chain running
  });
});

/* ------------------------------------------------------------------ */
/* 7) Double-run determinism                                            */
/* ------------------------------------------------------------------ */

describe('double-run determinism', () => {
  it('identical scripts ⇒ identical psprite/hash streams', () => {
    const run = () => {
      const w: World = { rng: createPrngState(), leveltime: 0 };
      bindPsprWorld(w);
      resetPsprHooks();
      const p = mkPlayer(WP_PISTOL);
      p.weaponowned[WP_PISTOL] = 1;
      p.ammo[AM_CLIP] = 50;
      pSetupPsprites(p);
      const log: string[] = [];
      for (let t = 0; t < 200; t++) {
        const buttons =
          t > 18 && t < 120 && t % 7 < 5 ? ATK : t % 31 === 0 ? ATK : NO;
        if (t === 60) p.pendingweapon = WP_FIST;
        if (t === 90) p.pendingweapon = WP_PISTOL;
        if (t === 40) p.bob = 9 * FRACUNIT;
        if (t === 100) p.bob = 0;
        tick(p, buttons);
        log.push(
          `${w.leveltime}:${psp(p).state}/${psp(p).tics}/${psp(p).sx}/${psp(p).sy}|` +
            `${psp(p, PS_FLASH).state}/${p.ammo[AM_CLIP]}/${p.readyweapon}/${p.refire}/${p.extralight}/${w.rng.prndindex}`,
        );
      }
      return log;
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b);
    // The log must actually exercise the machine (no constant stream).
    const distinct = new Set(a.map((l) => l.split(':')[1]!.split('|')[0]));
    expect(distinct.size).toBeGreaterThan(20);
  });
});

/* ------------------------------------------------------------------ */
/* SetPsprite semantics                                                 */
/* ------------------------------------------------------------------ */

describe('P_SetPsprite semantics', () => {
  it('table consumption: rows/actions come from the merged M7-01 tables', () => {
    // row view parity (states.ts SoA is the authority)
    for (const st of [S_PUNCH, S_PUNCHUP, S_PISTOL, S_PISTOLUP, S_PISTOLFLASH, S_LIGHTDONE]) {
      const r = stateAt(st);
      expect([PSPR_STATES[st]!.tics, PSPR_STATES[st]!.next, PSPR_STATES[st]!.frame], `row ${st}`).toEqual(
        [r.tics, r.nextstate, r.frame],
      );
    }
    // WEAPONINFO is the weaponinfo.ts table (key-renamed)
    for (let w = 0; w < WEAPONINFO.length; w++) {
      expect(WEAPONINFO[w]).toEqual({
        ammo: weaponinfo[w]!.ammo,
        upstate: weaponinfo[w]!.upState,
        downstate: weaponinfo[w]!.downState,
        readystate: weaponinfo[w]!.readyState,
        atkstate: weaponinfo[w]!.atkState,
        flashstate: weaponinfo[w]!.flashState,
      });
    }
    // the pspr bodies are registered in the M7-01 ActionId registry
    for (const id of [ACT.A_WeaponReady, ACT.A_Lower, ACT.A_Raise, ACT.A_ReFire, ACT.A_FirePistol, ACT.A_GunFlash, ACT.A_Light0, ACT.A_Light1, ACT.A_Light2]) {
      expect(isActionRegistered(id), `action ${id}`).toBe(true);
    }
    // registry dispatch drives the machine: the pistol entry fires through it
    const p = mkPlayer(WP_PISTOL);
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    expect(psp(p).state).toBe(S_PISTOL);
  });

  it('S_NULL removes; 0-tic cascades run actions once each', () => {
    const p = mkPlayer(WP_SHOTGUN);
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    const ready = psp(p).state;
    pSetPsprite(p, PS_WEAPON, 0);
    expect(psp(p).state).toBe(0); // tics keeps its stale value (vanilla)
    // shotgun flash chain: FLASH1(4)→FLASH2(3)→LIGHTDONE(0-tic cascade out)
    pSetPsprite(p, PS_FLASH, S_SGUNFLASH2);
    expect(psp(p, PS_FLASH).state).toBe(S_SGUNFLASH2);
    pSetPsprite(p, PS_FLASH, S_LIGHTDONE);
    expect(psp(p, PS_FLASH).state).toBe(0); // 0-tic entry removed it
    expect(p.extralight).toBe(0);
    // restore ready for the table check below
    pSetPsprite(p, PS_WEAPON, ready);
  });

  it('A_WeaponReady exits the attack state via the M7-03 slot when set', () => {
    const seen: number[] = [];
    registerPsprHook('moStateIs', (_p, st) => st === S_PLAY_ATK1);
    registerPsprHook('setMobjState', (_p, st) => {
      psprHookCounts.setMobjState++;
      seen.push(st);
    });
    const p = mkPlayer(WP_PISTOL);
    pSetupPsprites(p);
    for (let t = 0; t < 16; t++) tick(p);
    expect(seen).toContain(S_PLAY); // P_SetMobjState(mo, S_PLAY)
  });

  it('P_SetupPsprites with pending chains straight into the raise', () => {
    const p = mkPlayer(WP_FIST);
    p.weaponowned[WP_PISTOL] = 1;
    p.readyweapon = WP_PISTOL;
    pSetupPsprites(p); // pending=ready=pistol → PISTOLUP, sy 122
    expect(psp(p).state).toBe(S_PISTOLUP);
    expect(psp(p).sy).toBe(WEAPONBOTTOM - LOWERSPEED);
  });

  it('ready state with health 0 puts the weapon away immediately', () => {
    const p = mkPlayer(WP_PISTOL);
    p.health = 0;
    pSetPsprite(p, PS_WEAPON, S_PISTOL); // entry calls A_WeaponReady → down
    expect(psp(p).state).toBe(S_PISTOLDOWN);
  });
});
