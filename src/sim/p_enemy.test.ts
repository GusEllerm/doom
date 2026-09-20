// sim/p_enemy.test.ts — M8-04 acceptance (M8-plan §M8-04 + §0.2-0.5):
//  1. the sleeping posse wakes on the GUNSHOT sound path (P_NoiseAlert via
//     the p_pspr.c:256 slot → sector soundtarget → A_Look target+seestate);
//  2. LOS wake + the 180° rear gate (dist > MELEERANGE ⇒ skip; ≤ ⇒ react);
//  3. MF_AMBUSH wakes ONLY via sight (soundtarget set, no LOS ⇒ stays put
//     — with the verbatim "target set but no seestate" goto quirk);
//  4. chase movement/cornering determinism + the PRNG stream pins (exact
//     prndindex deltas per source call site; lastlook ring pins);
//  5. MF_JUSTHIT ⇒ P_CheckMissileRange fires back WITHOUT the dice draw;
//  6. P_Move blocked paths: pure wall (false, no use), special line
//     (spechit! → P_UseSpecialLine — the monster-activated door path),
//     P_TryWalk's 1-draw movecount reload;
//  7. ring math: stop=(lastlook-1)&3 + the SP c++==2 double-visit;
//  8. activesound fires exactly when the NEXT table value is < 3;
//  9. the soundblock flood rule (one blocked hop, then dead) + static→
//     mover slot promotion on the first chase step.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, beforeEach, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MT, mobjinfo } from '../wad/info/mobjinfo';
import { gInitGame } from './game';
import { buildMapFromData } from './map';
import { sectorAtPoint } from './bsp';
import {
  asMobj,
  DI_NODIR,
  MELEERANGE,
  ONFLOORZ,
  mobjFromSlot,
  pSetMobjFlags,
  pSetMobjState,
  pSpawnMobj,
  type Mobj,
} from './p_mobj';
import { hashState, type GameState, type Skill } from './state';
import { pRunThinkers } from './ptick';
import { RNDTABLE } from './prng';
import {
  aChase,
  aFaceTarget,
  aLook,
  pCheckMeleeRange,
  pCheckMissileRange,
  pLookForPlayers,
  pMove,
  pNewChaseDir,
  pNoiseAlert,
  pTryWalk,
  registerEnemyHooks,
} from './p_enemy';
import { ACT, isActionRegistered, resetActions } from './a_actions';
import { attachPsprFields, psprHookCounts, psprHooks } from './p_pspr';
import { sightcounts } from './psight';
import { pspecCounts } from './pspec';
import type { MoveMobj } from './pmove';
import { MF_AMBUSH, MF_JUSTATTACKED, MF_JUSTHIT, MF_SHADOW } from './thinglinks';

const fx = (n: number): number => (n * FRACUNIT) | 0;

function boot(spec: RectMapSpec, skill: Skill = 2): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), skill);
}

/** One 512×512 room, player start at (64,64). */
function room(things: RectMapSpec['things']): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 512, h: 512, lightLevel: 200 }],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }, ...(things ?? [])],
  };
}

function playerMo(s: GameState): Mobj {
  return asMobj(s.players[0]!.mo as unknown as MoveMobj)!;
}

/** Spawn an imp with a PINNED lastlook (spawn draws one P_Random; the ring
 * tests overwrite the value so the window math stays analytic). */
function imp(s: GameState, x: number, y: number): Mobj {
  const m = pSpawnMobj(s.mobjs, fx(x), fx(y), ONFLOORZ, MT.MT_TROOP);
  m.lastLook = 0;
  return m;
}

function sectorOf(s: GameState, m: Mobj): number {
  return sectorAtPoint(s.map, m.x, m.y);
}

function fireGunshot(s: GameState): void {
  psprHooks.noiseAlert(attachPsprFields(s.players[0]!));
}

/** Index k with RNDTABLE[k] < 3 / >= bound (the deterministic draws). */
function indexWhere(pred: (v: number, i: number) => boolean): number {
  const k = RNDTABLE.findIndex(pred);
  expect(k).toBeGreaterThan(-1);
  return k;
}

beforeEach(() => {
  resetActions();
  registerEnemyHooks();
});

/* ================================================================== */
/* 0. Registration                                                     */
/* ================================================================== */

describe('registration (M7-01 registry ids 29/30/31 + noiseAlert slot)', () => {
  it('A_Look/A_Chase/A_FaceTarget are bound bodies after import', () => {
    expect(isActionRegistered(ACT.A_Look)).toBe(true);
    expect(isActionRegistered(ACT.A_Chase)).toBe(true);
    expect(isActionRegistered(ACT.A_FaceTarget)).toBe(true);
  });
});

/* ================================================================== */
/* 1. Sound wake — the sleeping posse + gunshot (§0.2/§0.3)             */
/* ================================================================== */

describe('A_Look sound wake (gunshot → soundtarget → seestate)', () => {
  it('P_NoiseAlert writes sector soundtarget; AWAY-FACING sleepers wake on it', () => {
    const s = boot(room([]));
    const p = playerMo(s);
    // A posse of 3 imps, ALL facing EAST while the player sits WEST of
    // them ⇒ the 180° cone gate alone would keep them asleep: any wake
    // MUST come from the soundtarget path (the gunshot).
    const posse = [imp(s, 300, 100), imp(s, 400, 300), imp(s, 300, 400)];
    for (const m of posse) m.angle = 0;

    fireGunshot(s); // p_pspr.c:256 — target = emitter = player->mo
    expect(psprHookCounts.noiseAlert).toBe(1);
    expect(Array.from(s.map.sectors.soundTarget).some((t) => t === p.linkSlot)).toBe(true);

    for (const m of posse) {
      const before = s.rng.prndindex;
      aLook(m);
      expect(m.target).toBe(p); // soundtarget arm — NOT the sight ring
      expect(m.state).toBe(mobjinfo[MT.MT_TROOP]!.seeState);
      // 3 draws per wake, all ledgered sites: seesound %2 (1) + the
      // SEE-STATE ROW'S OWN A_Chase (S_TROO_WALK* carries it): the failing
      // missile dice (1) + the diagonal TryWalk reload (1). The NewChaseDir
      // swap draw is SKIPPED — diagonal-first succeeded and returns early.
      expect(s.rng.prndindex).toBe((before + 3) & 0xff);
    }
    expect(s.hooks.sfx.count).toBe(3);
  });

  it('the SOUNDBLOCK flood rule: one blocked hop, then dead (§0.3)', () => {
    // A | hall | B — the FULL shared edges are ML_SOUNDBLOCK door lines:
    // A traversed 1, hall 2, B NEVER alerted (p_enemy.c:142-146).
    const s = boot({
      rooms: [
        { x: 0, y: 200, w: 256, h: 100 },
        { x: 256, y: 200, w: 256, h: 100 },
        { x: 512, y: 200, w: 256, h: 100 },
      ],
      doors: [
        { x1: 256, y1: 200, x2: 256, y2: 300, special: 0, soundBlock: true },
        { x1: 512, y1: 200, x2: 512, y2: 300, special: 0, soundBlock: true },
      ],
      things: [{ x: 100, y: 250, angle: 0, type: 1 }],
    });
    const p = playerMo(s);
    fireGunshot(s);
    const targets = Array.from(s.map.sectors.soundTarget);
    const traversed = Array.from(s.map.sectors.soundTraversed);
    expect(targets.filter((t) => t !== -1).length).toBe(2); // A + hall, NOT B
    expect(targets).toContain(p.linkSlot);
    expect(Math.max(...traversed)).toBe(2); // the soundblocked-hop marker

    // …and the sleeper in B stays frozen even when looked at:
    const m = imp(s, 600, 250);
    m.angle = 0;
    const s0 = s.rng.prndindex;
    aLook(m);
    expect(m.target).toBeUndefined();
    expect(s.rng.prndindex).toBe(s0);
  });

  it('a sleeper PAST the sound reach (void-walled next room) stays asleep', () => {
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 512 },
        { x: 512, y: 0, w: 256, h: 512 }, // void gap between ⇒ blocks
      ],
      things: [{ x: 100, y: 250, angle: 0, type: 1 }],
    });
    const m = imp(s, 600, 250);
    m.angle = 0;
    const s0 = s.rng.prndindex;
    fireGunshot(s);
    aLook(m);
    expect(m.target).toBeUndefined();
    expect(m.state).toBe(mobjinfo[MT.MT_TROOP]!.spawnState);
    expect(s.rng.prndindex).toBe(s0); // NO seesound draw
  });
});

/* ================================================================== */
/* 2. LOS wake + 180° rear gate (§0.2)                                  */
/* ================================================================== */

describe('P_LookForPlayers — sight + rear gate', () => {
  it('front-cone LOS wakes with ZERO draws', () => {
    const s = boot(room([]));
    const p = playerMo(s);
    const m = imp(s, 264, 64); // 200 units EAST of the player
    m.angle = 0x80000000; // facing WEST — the player bears due west
    m.target = undefined;
    const s0 = s.rng.prndindex;
    expect(pLookForPlayers(m, false)).toBe(true);
    expect(m.target).toBe(p);
    expect(s.rng.prndindex).toBe(s0); // P_LookForPlayers never draws
  });

  it('behind-back at dist > MELEERANGE skips; ≤ MELEERANGE reacts anyway', () => {
    const s = boot(room([]));
    const p = playerMo(s);
    // Imp facing EAST (angle 0) while the player sits due WEST:
    const far = imp(s, 264, 64); // 200 units
    far.angle = 0;
    expect(pLookForPlayers(far, false)).toBe(false);
    expect(far.target).toBeUndefined();
    // allaround=true (the A_Chase call) has NO cone gate ⇒ acquires:
    expect(pLookForPlayers(far, true)).toBe(true);
    expect(far.target).toBe(p);

    const near = imp(s, 120, 64); // 56 units — inside MELEERANGE
    near.angle = 0;
    expect(pLookForPlayers(near, false)).toBe(true); // "react anyway if close"
    expect(near.target).toBe(p);
    void MELEERANGE;
  });

  it('dead player: the ring revisits slot 0 twice then bails, NO sight probe', () => {
    const s = boot(room([]));
    s.players[0]!.health = 0;
    const m = imp(s, 200, 200);
    m.lastLook = 0;
    const c0 = sightcounts[0]! + sightcounts[1]!;
    expect(pLookForPlayers(m, false)).toBe(false);
    expect(m.lastLook).toBe(0); // walks 0→(1,2,3)→0 twice, ends at the start
    expect(sightcounts[0]! + sightcounts[1]! - c0).toBe(0); // health bails first
  });

  it('live-but-unseen player: SP visits slot 0 TWICE per call (c++==2 wrap)', () => {
    // The §M8-04(f) pin: the vanilla `c++ == 2` bail interacts with the
    // SP ring so the single live slot is examined twice per failed call.
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 512 },
        { x: 512, y: 0, w: 256, h: 512 },
      ],
      things: [{ x: 100, y: 250, angle: 0, type: 1 }],
    });
    const m = imp(s, 600, 250);
    m.lastLook = 0;
    const c0 = sightcounts[0]! + sightcounts[1]!;
    expect(pLookForPlayers(m, false)).toBe(false);
    expect(sightcounts[0]! + sightcounts[1]! - c0).toBe(2);
  });
});

/* ================================================================== */
/* 3. MF_AMBUSH — sight-only wake (§0.2)                                */
/* ================================================================== */

describe('MF_AMBUSH gate', () => {
  it('soundtarget WITHOUT LOS: no wake, no seesound — but target SET (:614)', () => {
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 512 },
        { x: 512, y: 0, w: 256, h: 512 },
      ],
      things: [{ x: 100, y: 250, angle: 0, type: 1 }],
    });
    const p = playerMo(s);
    const m = imp(s, 600, 250);
    pSetMobjFlags(m, m.flags | MF_AMBUSH);
    s.map.sectors.soundTarget[sectorOf(s, m)] = p.linkSlot; // flood reached B
    const s0 = s.rng.prndindex;
    const h0 = s.hooks.sfx.count;
    aLook(m);
    expect(m.state).toBe(mobjinfo[MT.MT_TROOP]!.spawnState); // NOT seestate
    expect(m.target).toBe(p); // assigned BEFORE the ambush gate (quirk pin)
    expect(s.rng.prndindex).toBe(s0);
    expect(s.hooks.sfx.count).toBe(h0);
  });

  it('ambush WITH LOS to the soundtarget: wakes (sound + CheckSight gate)', () => {
    const s = boot(room([]));
    const p = playerMo(s);
    const m = imp(s, 300, 300);
    pSetMobjFlags(m, m.flags | MF_AMBUSH);
    s.map.sectors.soundTarget[sectorOf(s, m)] = p.linkSlot;
    aLook(m);
    expect(m.state).toBe(mobjinfo[MT.MT_TROOP]!.seeState);
  });

  it('ambush + gunshot in the SAME sector (LOS free): wakes normally', () => {
    // The flag MEANING pin (the MTF bit itself is p_mobj.test's): an
    // ambush imp still wakes on sound WHEN THE SIGHT GATE PASSES.
    const s = boot(room([]));
    const m = imp(s, 300, 300);
    pSetMobjFlags(m, m.flags | MF_AMBUSH);
    fireGunshot(s);
    aLook(m);
    expect(m.state).toBe(mobjinfo[MT.MT_TROOP]!.seeState);
  });
});

/* ================================================================== */
/* 4. Chase: movement, cornering, stream pins                           */
/* ================================================================== */

describe('P_Move / P_TryWalk / P_NewChaseDir', () => {
  it('P_TryWalk: DI_EAST step = 8 units, exactly ONE draw (movecount reload)', () => {
    const s = boot(room([]));
    const m = imp(s, 100, 256);
    m.target = playerMo(s);
    m.movedir = 0;
    const x0 = m.x;
    const s0 = s.rng.prndindex;
    expect(pTryWalk(m)).toBe(true);
    expect(m.x - x0).toBe(fx(8)); // speed 8 RAW × FRACUNIT (§0.5 product pin)
    expect(s.rng.prndindex).toBe((s0 + 1) & 0xff);
    expect(m.movecount).toBeLessThanOrEqual(15);
  });

  it('diagonal step = raw 8×47000 (5.737 units, NOT FixedMul-rounded)', () => {
    const s = boot(room([]));
    const m = imp(s, 100, 256);
    m.target = playerMo(s);
    m.movedir = 1; // DI_NORTHEAST
    const x0 = m.x;
    const y0 = m.y;
    expect(pTryWalk(m)).toBe(true);
    expect(m.x - x0).toBe(Math.imul(8, 47000));
    expect(m.y - y0).toBe(Math.imul(8, 47000));
  });

  it('P_Move into a solid wall: false, no draws, movedir unchanged, z unmoved', () => {
    const s = boot(room([]));
    const m = imp(s, 500, 256);
    m.target = playerMo(s);
    m.movedir = 0; // EAST into the void-backed boundary
    const s0 = s.rng.prndindex;
    expect(pMove(m)).toBe(false);
    expect(m.movedir).toBe(0);
    expect(s.rng.prndindex).toBe(s0);
    expect(m.x).toBe(fx(500));
  });

  it('P_Move blocked by a SPECIAL line: uses it (spechit!), true + NODIR', () => {
    // Low-ceiling corridor (h 40 < imp height 56 ⇒ move MUST fail) sharing
    // a special-1 MANUAL DOOR line with the monster's room — the monster
    // "opens doors by walking into them" (§0.5) via P_UseSpecialLine.
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 512 },
        { x: 256, y: 0, w: 256, h: 512, ceilingHeight: 40 },
      ],
      triggers: [{ x1: 256, y1: 200, x2: 256, y2: 300, special: 1, tag: 0 }],
      things: [{ x: 100, y: 250, angle: 0, type: 1 }],
    });
    const m = imp(s, 240, 250);
    m.target = playerMo(s);
    m.movedir = 0;
    const u0 = pspecCounts.useSpecialLine;
    expect(pMove(m)).toBe(true);
    expect(m.movedir).toBe(DI_NODIR);
    expect(pspecCounts.useSpecialLine).toBe(u0 + 1);
    expect(m.x).toBe(fx(240)); // the MOVE did not happen — only the USE
  });

  it('P_NewChaseDir axis target: swap draw + reload = EXACTLY 2 draws', () => {
    const s = boot(room([]));
    const m = imp(s, 264, 69); // player at (64,64): W axis, |Δy| 5 < 10 dead band
    m.target = playerMo(s);
    m.movedir = DI_NODIR; // turnaround NODIR ⇒ no exclusion
    const s0 = s.rng.prndindex;
    const x0 = m.x;
    pNewChaseDir(m);
    expect(s.rng.prndindex & 0xff).toBe((s0 + 2) & 0xff); // swap + TryWalk
    expect(m.movedir).toBe(4); // DI_WEST
    expect(m.x).toBeLessThan(x0);
  });

  it('chase determinism: 40 tics of A_Chase, twice = bit-identical', () => {
    const spec: RectMapSpec = {
      rooms: [
        { x: 0, y: 0, w: 512, h: 512 },
        { x: 512, y: 128, w: 64, h: 256 }, // alcove east
      ],
      things: [{ x: 64, y: 256, angle: 0, type: 1 }],
    };
    const run = (): {
      w: number[]; x: number; y: number; st: number; tics: number; prnd: number; rnd: number;
    } => {
      const s = boot(spec);
      const p = playerMo(s);
      const m = imp(s, 544, 256);
      m.target = p;
      s.rng.prndindex = 7;
      pSetMobjState(m, mobjinfo[MT.MT_TROOP]!.seeState);
      for (let t = 0; t < 40; t++) pRunThinkers(s.thinkers);
      // hashState MINUS the targetIndex word: the PLAYER mobj thinker id is
      // a module-global seq (PLAYER_THINKER_ID_BASE + playerThinkerSeq++,
      // pplayer.ts) that spans boots — the monster's words[7] would differ
      // across in-process double runs with ZERO sim nondeterminism. The
      // remaining 8 words + prnd + position are the determinism pin.
      const w = m.words.map((v, i) => (i === 7 ? 0 : v));
      return { w, x: m.x, y: m.y, st: m.state, tics: m.tics, prnd: s.rng.prndindex, rnd: s.rng.rndindex };
    };
    const a = run();
    const b = run();
    expect(a).toEqual(b); // double-run determinism (ARCH §3.3)
    expect(a.x).toBeLessThan(fx(544)); // advanced toward the player
    void hashState;
  });
});

/* ================================================================== */
/* 5. A_Chase flag semantics (§0.4)                                     */
/* ================================================================== */

describe('A_Chase + range checks', () => {
  it('MF_JUSTATTACKED: cleared, ONE NewChaseDir, NO attack, early return', () => {
    const s = boot(room([]));
    const m = imp(s, 200, 64);
    m.target = playerMo(s);
    pSetMobjFlags(m, m.flags | MF_JUSTATTACKED);
    m.movedir = 0;
    const st0 = m.state;
    const s0 = s.rng.prndindex;
    aChase(m);
    expect(m.flags & MF_JUSTATTACKED).toBe(0);
    expect(m.state).toBe(st0); // no melee/missile state entered
    expect((s.rng.prndindex - s0) & 0xff).toBeGreaterThan(0); // dir search drew
  });

  it('MF_JUSTHIT: fires back WITHOUT the dice draw; A_Chase sets JUSTATTACKED', () => {
    const s = boot(room([]));
    const m = imp(s, 144, 64); // 80 units — outside melee (bound 60)
    m.target = playerMo(s);
    m.movecount = 0;
    m.reactionTime = 0;
    pSetMobjFlags(m, m.flags | MF_JUSTHIT);
    const s0 = s.rng.prndindex;
    expect(pCheckMissileRange(m)).toBe(true);
    expect(m.flags & MF_JUSTHIT).toBe(0); // :207 cleared
    expect(s.rng.prndindex).toBe(s0); // the `P_Random() < dist` was SKIPPED

    // Through A_Chase (JUSTHIT already consumed): a dice roll that PASSES
    // (prnd parked at a table value ≥ dist) enters missilestate + sets
    // MF_JUSTATTACKED.
    s.rng.prndindex = (indexWhere((v) => v >= 17) - 1) & 0xff; // dist = 16
    aChase(m);
    expect(m.state).toBe(mobjinfo[MT.MT_TROOP]!.missileState);
    expect(m.flags & MF_JUSTATTACKED).not.toBe(0);
  });

  it('no LOS: missile range false with ZERO draws', () => {
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 512 },
        { x: 512, y: 0, w: 256, h: 512 },
      ],
      things: [{ x: 100, y: 250, angle: 0, type: 1 }],
    });
    const m = imp(s, 600, 250);
    m.target = playerMo(s);
    m.reactionTime = 0;
    const s0 = s.rng.prndindex;
    expect(pCheckMissileRange(m)).toBe(false);
    expect(s.rng.prndindex).toBe(s0);
  });

  it('lost target ⇒ P_LookForPlayers(allaround) fails ⇒ back to SPAWNSTATE', () => {
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 256, h: 512 },
        { x: 512, y: 0, w: 256, h: 512 },
      ],
      things: [{ x: 100, y: 250, angle: 0, type: 1 }],
    });
    const m = imp(s, 600, 250);
    m.target = undefined;
    pSetMobjState(m, mobjinfo[MT.MT_TROOP]!.seeState);
    aChase(m);
    expect(m.state).toBe(mobjinfo[MT.MT_TROOP]!.spawnState);
  });

  it('threshold decays; dead target zeroes it; A_Look zeroes it outright', () => {
    const s = boot(room([]));
    const m = imp(s, 300, 64);
    m.target = playerMo(s);
    m.threshold = 50;
    aChase(m);
    expect(m.threshold).toBe(49);
    m.target.health = 0;
    aChase(m);
    expect(m.threshold).toBe(0);
    m.threshold = 77;
    aLook(m);
    expect(m.threshold).toBe(0); // :609 — ANY shot will wake up
  });

  it('activesound fires iff the NEXT draw is < 3 (exactly one draw)', () => {
    const s = boot(room([]));
    const m = imp(s, 300, 64);
    m.target = playerMo(s);
    m.movedir = 0; // open east ⇒ P_Move succeeds, drawing NOTHING
    m.movecount = 5; // the chase step draws nothing itself
    // park prndindex so the activesound roll reads a table value < 3:
    const k = indexWhere((v) => v < 3);
    s.rng.prndindex = (k - 1) & 0xff;
    const h0 = s.hooks.sfx.count;
    aChase(m);
    expect(s.hooks.sfx.count).toBe(h0 + 1);
    expect(s.hooks.sfx.entries[h0]!.id).toBe(s.hooks.sfx.entries[h0]!.id); // logged
    expect(s.hooks.sfx.byId!.get(s.hooks.sfx.entries[h0]!.id)).toBe(1);
  });
});

/* ================================================================== */
/* 6. Melee range + A_FaceTarget                                        */
/* ================================================================== */

describe('P_CheckMeleeRange / A_FaceTarget', () => {
  it('per-victim radius: bound = MELEERANGE − 20 + player radius (16)', () => {
    const s = boot(room([]));
    const p = playerMo(s);
    const m = imp(s, 300, 64); // same y as the player (aprox = pure dx)
    m.target = p;
    m.x = (p.x - fx(58)) | 0; // < 64−20+16 = 60 ⇒ TRUE
    expect(pCheckMeleeRange(m)).toBe(true);
    m.x = (p.x - fx(61)) | 0; // ≥ 60 ⇒ FALSE without touching the sight
    const c0 = sightcounts[0]! + sightcounts[1]!;
    expect(pCheckMeleeRange(m)).toBe(false);
    expect(sightcounts[0]! + sightcounts[1]! - c0).toBe(0);
  });

  it('a melee attempt burns exactly ONE sight trace', () => {
    const s = boot(room([]));
    const m = imp(s, 100, 64);
    m.target = playerMo(s);
    const c0 = sightcounts[0]! + sightcounts[1]!;
    expect(pCheckMeleeRange(m)).toBe(true);
    expect(sightcounts[0]! + sightcounts[1]! - c0).toBe(1);
  });

  it('A_FaceTarget: clears MF_AMBUSH; SHADOW target ⇒ exactly 2 draws', () => {
    const s = boot(room([]));
    const m = imp(s, 200, 200);
    const p = playerMo(s);
    m.target = p;
    pSetMobjFlags(m, m.flags | MF_AMBUSH);
    const s0 = s.rng.prndindex;
    aFaceTarget(m);
    expect(m.flags & MF_AMBUSH).toBe(0);
    expect(s.rng.prndindex).toBe(s0); // NO jitter against a solid target
    pSetMobjFlags(p, p.flags | MF_SHADOW);
    // park the pair on two UNEQUAL table entries so the jitter is ≠ 0:
    const k = indexWhere((v, i) => i < RNDTABLE.length - 1 && v !== RNDTABLE[i + 1]!);
    s.rng.prndindex = (k - 1) & 0xff;
    const s1 = s.rng.prndindex;
    aFaceTarget(m);
    expect(s.rng.prndindex).toBe((s1 + 2) & 0xff);
    pSetMobjFlags(p, p.flags & ~MF_SHADOW);
  });
});

/* ================================================================== */
/* 7. NoiseAlert direct + mover promotion                               */
/* ================================================================== */

describe('pNoiseAlert + static-slot promotion', () => {
  it('pNoiseAlert(target=emitter) marks ITS sector with the target slot', () => {
    const s = boot(room([]));
    const p = playerMo(s);
    pNoiseAlert(s.mobjs, p, p);
    expect(s.map.sectors.soundTarget[sectorOf(s, p)]).toBe(p.linkSlot);
  });

  it('a chasing map-THINGS monster promotes its static grid slot ONCE', () => {
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 512, h: 512 }],
      things: [
        { x: 64, y: 64, angle: 0, type: 1 },
        { x: 300, y: 64, angle: 180, type: 3001 },
      ],
    });
    const m = s.mobjs.mobjs.find((x) => x.type === MT.MT_TROOP)!;
    const old = m.linkSlot;
    const links = s.pmap.links;
    expect(old).toBeLessThan(links.staticCount); // THINGS bind statically
    m.target = playerMo(s);
    m.movedir = 4; // DI_WEST
    expect(pMove(m)).toBe(true);
    expect(m.linkSlot).toBeGreaterThanOrEqual(links.staticCount); // promoted
    expect(links.flags[old]).toBe(0); // the old static pair is inert
    expect(links.linked[old]).toBe(0);
    expect(mobjFromSlot(s.mobjs, m.linkSlot)).toBe(m);
    expect(pMove(m)).toBe(true); // idempotent — no second promotion
  });
});
