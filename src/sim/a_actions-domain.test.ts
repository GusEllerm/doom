// sim/a_actions-domain.test.ts — M8-07 id27 DOMAIN-DISAMBIGUATION regression
// (docs/JOURNAL.md 2026-09-23 M8-06 handoff: "ActionId 27 double-identity
// (A_WeaponFall in weapon states / A_Fall in mobj states) — vanilla
// disambiguates by state DOMAIN; our global id-map can't. Family task to add
// domain-aware registration (mobj states resolve separately)").
//
// Truth pinned HERE against the generated states.ts SoA + the 62-file mirror:
//  - vanilla state rows store FUNCTION POINTERS — an action's identity IS the
//    state domain of the row. Every id-27 row in the table is an MOBJ row
//    (23 rows, first = S_PLAY_DIE3 = 160; §0.11's A_Fall census) carrying
//    p_enemy.c:1585 A_Fall. The weapon/psprite rows reachable from weaponinfo
//    dispatch ids 1..22 ONLY — vanilla has NO weapon function at id 27
//    ("A_WeaponFall" is the journal shorthand for that EMPTY weapon-side
//    slot). The port's single global impl[] made the slots aliasable; the fix
//    (a_actions.ts ActionDomain) registers/dispatches bodies PER MACHINE and
//    cross-dispatch resolves to the counted no-op, never the other
//    machine's cast.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MT } from '../wad/info/mobjinfo';
import { S, stateAction, stateNext } from '../wad/info/states';
import { weaponinfo } from '../wad/info/weaponinfo';

import { gInitGame } from './game';
import { buildMapFromData } from './map';
import { ONFLOORZ, pSpawnMobj } from './p_mobj';
import type { GameState } from './state';
import { dispatchAction, registerAction, unimplementedActions } from './a_actions';
import { MF_SOLID } from './thinglinks';

const fx = (n: number): number => (n * FRACUNIT) | 0;

function boot(): GameState {
  const spec: RectMapSpec = {
    rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 200 }],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }],
  };
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), 3);
}

const draws = (s: GameState, from: number): number => (s.rng.prndindex - from) & 0xff;

/* ================================================================== */
/* 1. THE ID27 DOMAIN FIX — both identities                            */
/* ================================================================== */

describe('id27 domain disambiguation (M8-07 fix, M8-06 handoff)', () => {
  it('TABLE TRUTH: every id-27 row is an MOBJ row; the weapon closure never dispatches it', () => {
    // (a) rows carrying action 27 — the A_Fall 23-row census (§0.11):
    const rows: number[] = [];
    for (let i = 0; i < stateAction.length; i++) if (stateAction[i] === 27) rows.push(i);
    expect(rows.length).toBe(23);
    expect(Math.min(...rows)).toBe(S.S_PLAY_DIE3); // 160 — the FIRST is a mobj row
    // (b) the weapon/psprite machine's reachable closure (weaponinfo states
    // + the nextstate chains they start) dispatches ids 1..22 ONLY —
    // vanilla has NO weapon function at id 27 ("A_WeaponFall" is the
    // journal's placeholder for that EMPTY weapon-side slot):
    const starts = new Set<number>([S.S_LIGHTDONE]);
    for (const w of weaponinfo as unknown as Record<string, number>[]) {
      for (const k of ['downState', 'upState', 'readyState', 'atkState', 'flashState']) {
        if (w[k]) starts.add(w[k]!);
      }
    }
    const reach = new Set<number>();
    for (const st of starts) {
      let s0 = st;
      let guard = 0;
      while (s0 && !reach.has(s0) && guard++ < 40) {
        reach.add(s0);
        s0 = stateNext[s0]!; // the SoA nextstate column
      }
    }
    for (const r of reach) expect(stateAction[r]!).toBeLessThan(23);
  });

  it('MOBJ identity: dispatch(27, mobj, mobj) runs A_Fall — MF_SOLID cleared', () => {
    const s = boot();
    const z = pSpawnMobj(s.mobjs, fx(300), fx(256), ONFLOORZ, MT.MT_POSSESSED);
    expect(z.flags & MF_SOLID).toBeGreaterThan(0);
    const before = s.rng.prndindex;
    dispatchAction(27, z, 'mobj');
    expect(z.flags & MF_SOLID).toBe(0); // p_enemy.c:1588
    expect(draws(s, before)).toBe(0); // A_Fall draws NOTHING
    expect(unimplementedActions().get('A_Fall')).toBeUndefined();
  });

  it('WEAPON identity: dispatch(27, ctx, pspr) NEVER executes the mobj body', () => {
    const s = boot();
    const z = pSpawnMobj(s.mobjs, fx(300), fx(256), ONFLOORZ, MT.MT_POSSESSED);
    const flagsBefore = z.flags;
    dispatchAction(27, { player: {}, psp: {} }, 'pspr'); // weapon ctx
    expect(z.flags).toBe(flagsBefore); // the mobj body did NOT run
    expect(unimplementedActions().get('A_Fall')).toBe(1); // counted no-op
  });

  it('cross-domain guard both ways: a domain-claimed body is invisible to the other machine', () => {
    // Probe tokens: ids 46/47 (A_FatRaise/A_FatAttack1) have NO live
    // registration in this milestone (§4 stub-only families).
    let mobjRuns = 0;
    let psprRuns = 0;
    registerAction(46, () => mobjRuns++, 'mobj');
    registerAction(47, () => psprRuns++, 'pspr');
    dispatchAction(46, null, 'pspr'); // claimed by mobj ⇒ invisible here
    expect(mobjRuns).toBe(0);
    dispatchAction(47, null, 'mobj'); // claimed by pspr ⇒ invisible here
    expect(psprRuns).toBe(0);
    dispatchAction(46, null, 'mobj');
    dispatchAction(47, null, 'pspr');
    expect([mobjRuns, psprRuns]).toEqual([1, 1]);
    // Untagged dispatch (legacy/test contract) reaches either slot:
    dispatchAction(46, null);
    dispatchAction(47, null);
    expect([mobjRuns, psprRuns]).toEqual([2, 2]);
  });
});

