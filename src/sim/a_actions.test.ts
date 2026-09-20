// sim/a_actions.test.ts — M7-01 ActionId registry acceptance (M7-plan §M7-01
// acceptance 2: "action ids unique, switch total (unknown id throws in
// tests)"), plus the machine check that the registry is COMPLETE against the
// states[] table it indexes.
//
// The registry vocabulary is a source fact: info.c's states[] action field
// references 74 distinct A_* functions in a deterministic order (order of
// FIRST APPEARANCE walking the table top-to-bottom), which is exactly how
// a_actions.ts assigns ids. SOURCE_ACTION_ORDER/SOURCE_ACTION_ROW_COUNTS below
// were generated from the source mirror by
//   node scripts/extract-info-tables.mjs --mirror=<mirror> --digests
// (`action order` / `action counts` lines).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, afterEach } from 'vitest';

import { NUMSTATES, S, stateAction } from '../wad/info/states';
import {
  ACT,
  ACT_NONE,
  ACTION_NAMES,
  NUM_ACTIONS,
  actionsManifest,
  dispatchAction,
  isActionRegistered,
  registerAction,
  resetActions,
  unimplementedActions,
} from './a_actions';

/** info.c states[] action field, first-appearance order (ids 1..74). */
export const SOURCE_ACTION_ORDER: readonly string[] = [
  'A_Light0', 'A_WeaponReady', 'A_Lower', 'A_Raise', 'A_Punch', 'A_ReFire', 'A_FirePistol',
  'A_Light1', 'A_FireShotgun', 'A_Light2', 'A_FireShotgun2', 'A_CheckReload', 'A_OpenShotgun2',
  'A_LoadShotgun2', 'A_CloseShotgun2', 'A_FireCGun', 'A_GunFlash', 'A_FireMissile', 'A_Saw',
  'A_FirePlasma', 'A_BFGsound', 'A_FireBFG', 'A_BFGSpray', 'A_Explode', 'A_Pain',
  'A_PlayerScream', 'A_Fall', 'A_XScream', 'A_Look', 'A_Chase', 'A_FaceTarget', 'A_PosAttack',
  'A_Scream', 'A_SPosAttack', 'A_VileChase', 'A_VileStart', 'A_VileTarget', 'A_VileAttack',
  'A_StartFire', 'A_Fire', 'A_FireCrackle', 'A_Tracer', 'A_SkelWhoosh', 'A_SkelFist',
  'A_SkelMissile', 'A_FatRaise', 'A_FatAttack1', 'A_FatAttack2', 'A_FatAttack3', 'A_BossDeath',
  'A_CPosAttack', 'A_CPosRefire', 'A_TroopAttack', 'A_SargAttack', 'A_HeadAttack',
  'A_BruisAttack', 'A_SkullAttack', 'A_Metal', 'A_SpidRefire', 'A_BabyMetal', 'A_BspiAttack',
  'A_Hoof', 'A_CyberAttack', 'A_PainAttack', 'A_PainDie', 'A_KeenDie', 'A_BrainPain',
  'A_BrainScream', 'A_BrainDie', 'A_BrainAwake', 'A_BrainSpit', 'A_SpawnSound', 'A_SpawnFly',
  'A_BrainExplode',
];

/** Rows per action id in states[] (index === ActionId, 0 = no action). */
export const SOURCE_ACTION_ROW_COUNTS: readonly number[] = [
  519, 1, 10, 9, 9, 1, 9, 1, 8, 1, 6, 1, 1, 1, 1, 1, 2, 2, 1, 2, 1, 1, 1, 1, 2, 19, 1,
  23, 6, 33, 122, 43, 1, 19, 3, 12, 1, 1, 1, 1, 35, 2, 2, 1, 1, 1, 1, 1, 1, 1, 5, 4, 2,
  1, 1, 1, 2, 1, 4, 2, 2, 1, 1, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 3, 1,
];

describe('M7-01 ActionId registry', () => {
  afterEach(() => {
    resetActions();
  });

  it('manifest is complete against info.c (75 ids, names, order)', () => {
    expect(NUM_ACTIONS).toBe(75);
    expect(SOURCE_ACTION_ORDER).toHaveLength(74);
    expect(ACTION_NAMES).toHaveLength(NUM_ACTIONS);
    expect(ACTION_NAMES[ACT_NONE]).toBe('NONE');
    expect(ACTION_NAMES.slice(1)).toEqual([...SOURCE_ACTION_ORDER]);
    expect(new Set(ACTION_NAMES).size).toBe(NUM_ACTIONS); // unique
    // ACT map mirrors the name list exactly (id ↔ name both ways):
    const entries = Object.entries(ACT);
    expect(entries).toHaveLength(75);
    for (const [name, id] of entries) {
      expect(ACTION_NAMES[id as number], name).toBe(name === 'NONE' ? 'NONE' : name);
      expect(name).toBe(ACTION_NAMES[id as number]);
    }
    // every source action has an ACT key:
    for (const [id, name] of SOURCE_ACTION_ORDER.entries()) {
      expect((ACT as Record<string, number>)[name], name).toBe(id + 1);
    }
    expect(ACT.NONE).toBe(0);
    expect(Math.max(...Object.values(ACT))).toBe(NUM_ACTIONS - 1);
  });

  it('machine census: the states[] action column uses every id, source counts exact', () => {
    const counts = new Array<number>(NUM_ACTIONS).fill(0);
    const unknown: number[] = [];
    for (let i = 0; i < NUMSTATES; i++) {
      const id = stateAction[i] as number;
      if (id < 0 || id >= NUM_ACTIONS || !Number.isInteger(id)) unknown.push(i);
      else counts[id] = (counts[id] as number) + 1;
    }
    expect(unknown).toEqual([]);
    expect(counts).toEqual([...SOURCE_ACTION_ROW_COUNTS]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(NUMSTATES);
    // acceptance: no action id is referenced by the table but missing from the
    // registry, and no registry id is dead (unused) in the table.
    expect(counts.slice(1).every((n) => n > 0)).toBe(true);
  });

  it('the switch is total: every known id dispatches, unknown ids throw', () => {
    const seen: number[] = [];
    registerAction(ACT.A_Chase, (ctx) => seen.push(ctx as number));
    for (let id = 0; id < NUM_ACTIONS; id++) {
      expect(() => dispatchAction(id, id)).not.toThrow();
    }
    expect(seen).toEqual([30]); // A_Chase id
    for (const bad of [NUM_ACTIONS, -1, 1.5, 1e6, Number.NaN]) {
      expect(() => dispatchAction(bad, null), String(bad)).toThrow(/unknown ActionId/);
    }
    expect(() => registerAction(NUM_ACTIONS, () => {})).toThrow(/unknown action id/);
    expect(() => registerAction(-1, () => {})).toThrow(/unknown action id/);
  });

  it('unregistered ids are recorded no-ops, registered ones run (M6-03 pattern)', () => {
    expect(isActionRegistered(ACT.A_Light1)).toBe(false);
    dispatchAction(ACT.A_Light1, null);
    dispatchAction(ACT.A_Light1, null);
    expect([...unimplementedActions()]).toEqual([['A_Light1', 2]]);
    let calls = 0;
    expect(registerAction(ACT.A_Light1, () => { calls++; })).toBe(ACT.A_Light1);
    expect(isActionRegistered(ACT.A_Light1)).toBe(true);
    dispatchAction(ACT.A_Light1, null);
    expect(calls).toBe(1);
    expect(unimplementedActions().get('A_Light1')).toBe(2); // history, not cleared by binding
    resetActions();
    expect(isActionRegistered(ACT.A_Light1)).toBe(false);
    expect(unimplementedActions().size).toBe(0);
    dispatchAction(ACT_NONE, null); // NONE never records
    expect(unimplementedActions().size).toBe(0);
  });

  it('manifest() reports binding status for later tasks to assert against', () => {
    registerAction(ACT.A_FirePistol, () => {});
    const m = actionsManifest();
    expect(m).toHaveLength(NUM_ACTIONS);
    expect(m[0]).toEqual({ id: 0, name: 'NONE', registered: false });
    expect(m[ACT.A_FirePistol as number]).toEqual({ id: 7, name: 'A_FirePistol', registered: true });
    expect(m.filter((e) => e.registered).map((e) => e.name)).toEqual(['A_FirePistol']);
    expect(m.filter((e) => !e.registered && e.id !== 0)).toHaveLength(NUM_ACTIONS - 2);
  });

  it('the psprite and mobj machines share this one vocabulary (R06 §1, R08 §2.1)', () => {
    // Psprite rows (weapon states, ids < S_LIGHTDONE..S_PLASMAFLASH region)
    // and mobj rows draw from the SAME id space — checked by construction:
    // the action column of every state below S_KEENSTND is a valid id, and
    // both call sites dispatch through dispatchAction.
    const psprRegion = [...Array(S.S_LIGHTDONE + 1).keys()];
    const mobjRegion = [...Array(NUMSTATES - S.S_LIGHTDONE).keys()].map((i) => i + S.S_LIGHTDONE);
    for (const list of [psprRegion, mobjRegion]) {
      for (const id of list.map((i) => stateAction[i] as number)) {
        expect(id).toBeGreaterThanOrEqual(ACT_NONE);
        expect(id).toBeLessThan(NUM_ACTIONS);
      }
    }
    // The weapon ready/down/up rows all carry the psprite-side actions:
    expect(stateAction[S.S_PUNCH]).toBe(ACT.A_WeaponReady);
    expect(stateAction[S.S_PUNCHDOWN]).toBe(ACT.A_Lower);
    expect(stateAction[S.S_PUNCHUP]).toBe(ACT.A_Raise);
    expect(stateAction[S.S_PUNCH2]).toBe(ACT.A_Punch);
    expect(stateAction[S.S_PUNCH5]).toBe(ACT.A_ReFire);
    expect(stateAction[S.S_LIGHTDONE]).toBe(ACT.A_Light0);
    expect(stateAction[S.S_BRAINEYE]).toBe(ACT.A_Look);
  });
});
