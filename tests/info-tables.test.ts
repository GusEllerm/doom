// tests/info-tables.test.ts — M7-01 cross-table parity: the generated
// info.c tables (src/wad/info/*) vs the pre-M7 renderer tables in
// src/render/rthings.ts, which were hand-rolled in M4 from the same source.
//
// Lives under tests/ (outside the A-INT1 zones) because it must import both
// `wad/` and `render/`; the zone rule that forbids that pairing inside src/ is
// exactly why the drift was only catchable here.
//
// Parity claim: `THING_SPRITE4`/`THING_FRAMES` answer doomednum → spawnstate
// sprite 4CC + frame index. That is reproducible from states.ts + mobjinfo.ts
// + sprnames.ts alone, with the frame bit decoded by FF_FRAMEMASK.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { frameIndex, stateAt } from '../src/wad/info/states';
import { sprnames } from '../src/wad/info/sprnames';
import { DOOMEDNUM_TO_MT, MF, mobjinfo } from '../src/wad/info/mobjinfo';
import { KIND_MARKER, KIND_MONSTER, KIND_STATIC, THING_FRAMES, THING_KINDS, THING_SPRITE4, THING_TYPES } from '../src/render/rthings';

describe('M7-01 info tables vs renderer THING_* tables', () => {
  it('every doomednum resolves to the same sprite 4CC + spawnstate frame', () => {
    const diffs: string[] = [];
    for (let row = 0; row < THING_TYPES.length; row++) {
      const doomednum = THING_TYPES[row]!;
      const mt = DOOMEDNUM_TO_MT.get(doomednum);
      if (mt === undefined) {
        diffs.push(`doomednum ${String(doomednum)} has no mobjinfo entry`);
        continue;
      }
      const spawn = stateAt(mobjinfo[mt]!.spawnState);
      const sprite = sprnames[spawn.sprite] as string;
      const frame = frameIndex(spawn.frame);
      if (sprite !== THING_SPRITE4[row] || frame !== THING_FRAMES[row]) {
        diffs.push(
          `doomednum ${String(doomednum)} (MT_${mt}, S_${spawn.id}): tables ${sprite}/${frame} ` +
          `vs rthings ${THING_SPRITE4[row]}/${THING_FRAMES[row]}`,
        );
      }
    }
    expect(diffs).toEqual([]);
    expect(THING_TYPES.length).toBe(118);
  });

  it('the two tables cover exactly the same doomednum set', () => {
    const rendererSide = new Set([...THING_TYPES]);
    const tableSide = new Set<number>();
    for (const [doomednum] of DOOMEDNUM_TO_MT) tableSide.add(doomednum);
    // Player/deathmatch starts (doomednum 1–4, 11) appear in NEITHER: they
    // have no mobjinfo entry and P_SpawnMapThing handles them before the
    // type scan (r_things.ts documents the same exclusion).
    expect([...tableSide].filter((d) => !rendererSide.has(d)).sort((a, b) => a - b)).toEqual([]);
    expect([...rendererSide].filter((d) => !tableSide.has(d))).toEqual([]);
    expect([...tableSide].sort((a, b) => a - b)).toEqual([...rendererSide].sort((a, b) => a - b));
  });

  it('spawnstate classes agree with the mobj flags', () => {
    const bad: string[] = [];
    for (let row = 0; row < THING_TYPES.length; row++) {
      const mt = DOOMEDNUM_TO_MT.get(THING_TYPES[row]!);
      if (mt === undefined) continue;
      const m = mobjinfo[mt]!;
      const kind = THING_KINDS[row]!;
      if (kind !== KIND_STATIC && kind !== KIND_MARKER && kind !== KIND_MONSTER) {
        bad.push(`MT_${mt} unknown kind ${kind}`);
      }
      // Pickups (MF_SPECIAL) are never drawn as monsters…
      if ((m.flags & MF.MF_SPECIAL) !== 0 && kind === KIND_MONSTER) bad.push(`MT_${mt} pickup as monster`);
      // …and everything the renderer treats as a monster is shootable.
      if (kind === KIND_MONSTER && (m.flags & MF.MF_SHOOTABLE) === 0) bad.push(`MT_${mt} monster not shootable`);
    }
    expect(bad).toEqual([]);
    // Marker rows are exactly the MF_NOSECTOR markers plus the five weapon
    // pickups 2001–2005 (r_things.ts DEVIATION note: source-wise they are
    // MF_SPECIAL pickups vanilla draws; the M4 plan excluded them until
    // pickups exist — M7-04/05 will revisit).
    const markers = [...THING_TYPES].filter((_, i) => THING_KINDS[i] === KIND_MARKER);
    expect(markers).toEqual([14, 87, 89, 2001, 2002, 2003, 2004, 2005]);
    for (const dn of [14, 87, 89]) {
      const mt = DOOMEDNUM_TO_MT.get(dn)!;
      expect(mobjinfo[mt]!.flags & MF.MF_NOSECTOR, `doomednum ${dn}`).not.toBe(0);
    }
    for (const dn of [2001, 2002, 2003, 2004, 2005]) {
      const mt = DOOMEDNUM_TO_MT.get(dn)!;
      expect(mobjinfo[mt]!.flags & MF.MF_SPECIAL, `doomednum ${dn}`).not.toBe(0);
    }
    expect(thingKind(88)).toBe(KIND_MONSTER); // MT_BOSSBRAIN counts as a monster target
  });
});

function thingKind(doomednum: number): number {
  const row = [...THING_TYPES].indexOf(doomednum);
  expect(row, `doomednum ${doomednum} absent`).toBeGreaterThanOrEqual(0);
  return THING_KINDS[row]!;
}
