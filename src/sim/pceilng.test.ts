/**
 * sim/pceilng.ts tests (M6-08, plan §M6-08) — T_MoveCeiling crush-cycle
 * timing goldens, crusher kill as damage-slot CADENCE on a stuck player
 * (kill/gibs deferred to M7 per plan §4), silent-family sfx counters,
 * stuck-vs-crush result matrix, stasis 57/74, W1/GR clear truth and
 * double-run determinism.
 *
 * Hand-derived timing tables (T_MovePlane step-then-detect, ceilings;
 * thinker tic t runs with leveltime = t−1; a 128→8 ceiling at speed 1):
 *   crushAndRaise/silent  down 121 (t1..t120 move 127→8, t121 detect),
 *     up 121 (t122..t241 move 9→128, t242 detect) → cycle 242 tics.
 *   fastCrushAndRaise     speed 2 BOTH ways (never slows, never resets):
 *     down 61 (t61 detect), up 61 (t122 detect) → cycle 122.
 *   lowerToFloor          dest floor EXACT (no +8): 129 tics, REMOVED.
 *   crush damage (player 56 tall, room floor 0 ceil 128): first nofit at
 *     tic 73 (ceiling reaches 55; 55 < 56) — damage only on
 *     `!(leveltime&3)` → tics (leveltime) 72,76,…,116 = 12 slots, then the
 *     pastdest DOUBLE P_ChangeSector at leveltime 120 adds TWO (M6-04
 *     double-call truth) → 14 by the down-arrival. Crush-slow speed =
 *     CEILSPEED/8 = 1 unit/tic — coincidentally the SAME 1/tic as the
 *     undelayed descent, so height = 128 − t throughout (pin).
 *   lowerAndCrush (44/72) quirk: crush flag FALSE (file header) — fits at
 *     exactly 56 (gap ≥ height), nofits at 55 → rollback every tic:
 *     rests at 56, ZERO damage slots, speed slows to 1/tic.
 *
 * Source mirror: /tmp/DOOM-master/linuxdoom-1.10/p_ceilng.c.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildMapFromData } from './map';
import { gInitGame } from './game';
import { pRunThinkers, sectorSpecialData, setSectorSpecialData, thinkerCount } from './ptick';
import { pCrossSpecialLine, activeCeilings } from './pspec';
import { CEIL, unimplementedSpecial, resetUnimplementedSpecial } from './specials-table';
import { hashState, type GameState } from './state';
import { pmapHookCounts, resetPmapHookCounts } from './pmap';
import { PLAYER_FLAGS } from './player';
import type { Mover } from './pmap';
import { MF_SOLID } from './thinglinks';

import {
  activeCeilings as familyActiveCeilings,
  evDoCeiling,
  evCeilingCrushStop,
  pAddActiveCeiling,
  pceilngCounts,
  resetPceilngCounts,
  CEILSPEED,
  MAXCEILINGS,
  SFX_PSTOP,
  SFX_STNMOV,
  type Ceiling
} from './pceilng';

const fx = (u: number): number => (u * FRACUNIT) | 0;

const PLAYER: Mover = {
  x: 0, y: 0, z: 0, radius: fx(16), height: fx(56),
  flags: MF_SOLID | PLAYER_FLAGS, player: true
};

function stateFor(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec);
  return gInitGame(
    buildMapFromData(loadMap(WadFile.parse(bytes.buffer.slice(
      bytes.byteOffset, bytes.byteOffset + bytes.byteLength
    ) as ArrayBuffer), 'FIXMAP'))
  );
}

/** thinkers-only tic (gTicker §3.2 order minus player physics) — same
 * idiom as pplats.test: run then leveltime++. */
function step(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    pRunThinkers(s.thinkers);
    s.leveltime++;
  }
}

function secByTag(s: GameState, tag: number): number {
  for (let i = 0; i < s.sectors.count; i++) if (s.sectors.tag[i] === tag) return i;
  throw new Error(`no sector tagged ${tag}`);
}

function lineBySpecial(s: GameState, special: number): number {
  for (let i = 0; i < s.map.lines.count; i++) {
    if (s.map.lines.special[i] === special) return i;
  }
  throw new Error(`no line with special ${special}`);
}

function ceilingOf(tag: number): Ceiling | null {
  for (let i = 0; i < MAXCEILINGS; i++) {
    const c = activeCeilings[i] as Ceiling | null;
    if (c !== null && c.tag === tag) return c;
  }
  return null;
}

function ceilZ(s: GameState, tag: number): number {
  return s.sectors.ceilingZ[secByTag(s, tag)]!;
}

function sfxCount(s: GameState, id: number): number {
  return s.hooks.sfx.byId?.get(id) ?? 0;
}

function damageEntries(s: GameState) {
  return s.hooks.damage.entries;
}

beforeEach(() => {
  resetUnimplementedSpecial();
  resetPceilngCounts();
  resetPmapHookCounts();
});

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// Crusher hall: sector tag 25, floor 0 / ceiling 128; W1 25 trigger line
// on the room-room boundary (player parked in room 2 — no obstruction for
// the pure timing goldens). The boundary line doubles as the crushStop
// (57) and GR (73/77) line by overwriting `special` per scenario.
const CRUSHER_FREE: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, tag: 25 },
    { x: 256, y: 0, w: 256, h: 256 }
  ],
  triggers: [{ x1: 256, y1: 0, x2: 256, y2: 256, special: 25, tag: 25 }],
  things: [{ x: 384, y: 128, angle: 0, type: 1 }]
};

// Same hall WITH the player standing in it (x 128 — inside the sector's
// blockbox; the crusher gets stuck at head height).
const CRUSHER_STUCK: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, tag: 25 },
    { x: 256, y: 0, w: 256, h: 256 }
  ],
  triggers: [{ x1: 256, y1: 0, x2: 256, y2: 256, special: 25, tag: 25 }],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
};

// Ride: room 1 (tag 7, ceiling 128) beside a 256-ceiling room —
// P_FindHighestCeilingSurrounding = 256. The player is FLOATING (z 70 ≠
// floorz 0 ⇒ P_ThingHeightClip's not-onfloor arm pushes z = ceiling − 56).
const RIDE: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, tag: 7 },
    { x: 256, y: 0, w: 256, h: 256, ceilingHeight: 256 }
  ],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
};

/* ------------------------------------------------------------------ */
/* 1) Crush-cycle timing goldens (plan §M6-08 acceptance 1)            */
/* ------------------------------------------------------------------ */

describe('crush-and-raise cycle timing (T_MoveCeiling verbatim)', () => {
  it('crushAndRaise (W1 25): down 121 / up 121, turnaround hashes, cycle 242', () => {
    const s = stateFor(CRUSHER_FREE);
    const line = lineBySpecial(s, 25);
    expect(pCrossSpecialLine(s.pmap, line, 0, PLAYER)).toBe(undefined); // void in 1.10
    expect(s.map.lines.special[line]).toBe(0); // W1 clear-on-effect
    const c = ceilingOf(25)!;
    expect(c.crush).toBe(true);
    expect(c.speed).toBe(CEILSPEED);
    expect(c.topheight).toBe(fx(128));
    expect(c.bottomheight).toBe(fx(8)); // floor + 8*FRACUNIT
    expect(c.direction).toBe(-1);
    expect(c.type).toBe(CEIL.crushAndRaise);
    expect(c.tag).toBe(25); // sec->tag (p_ceilng.c:246)

    step(s, 120); // pure descent
    expect(ceilZ(s, 25)).toBe(fx(8));
    expect(c.direction).toBe(-1); // arrival NOT detected yet (detect tic 121)
    step(s, 1);
    expect(c.direction).toBe(1); // pastdest at tic 121 → down→up
    expect(c.speed).toBe(CEILSPEED);
    // stnmov on !(leveltime&7) tics of the down move: lt 0,8,…,120 = 16
    expect(sfxCount(s, SFX_STNMOV)).toBe(16);
    expect(sfxCount(s, SFX_PSTOP)).toBe(0); // non-silent types: no pstop

    step(s, 120); // t122..241 ascent, no detect yet
    expect(ceilZ(s, 25)).toBe(fx(128));
    expect(c.direction).toBe(1);
    step(s, 1); // t242: pastdest up → down, speed reset arm (crushAndRaise)
    expect(c.direction).toBe(-1);
    expect(c.speed).toBe(CEILSPEED);
    expect(ceilZ(s, 25)).toBe(fx(128));
    // stnmov: 16 down + 15 up (lt 128..232 ⇒ t129..241) = 31 per cycle
    expect(sfxCount(s, SFX_STNMOV)).toBe(31);
    expect(ceilingOf(25)).toBe(c); // crusher NEVER self-removes
    expect(sectorSpecialData(s.sectors, secByTag(s, 25))).toBe(c);
  });

  it('fastCrushAndRaise (W1 6): speed 2 BOTH ways, cycle 122 (pin: never slows/resets)', () => {
    const s = stateFor(CRUSHER_FREE);
    const line = lineBySpecial(s, 25);
    s.map.lines.special[line] = 6;
    s.map.lines.tag[line] = 25;
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    const c = ceilingOf(25)!;
    expect(c.speed).toBe(CEILSPEED * 2);

    step(s, 60);
    expect(ceilZ(s, 25)).toBe(fx(8));
    expect(c.direction).toBe(-1);
    step(s, 1); // t61: 8−2 < 8 → pastdest → up (speed UNCHANGED — pin)
    expect(c.direction).toBe(1);
    expect(c.speed).toBe(CEILSPEED * 2);

    step(s, 60); // t62..121 moves to 128 (overshoot check strict >)
    expect(ceilZ(s, 25)).toBe(fx(128));
    expect(c.direction).toBe(1);
    step(s, 1); // t122: 128+2 > 128 → pastdest → down
    expect(c.direction).toBe(-1);
    expect(c.speed).toBe(CEILSPEED * 2); // down-arm reset is crushAndRaise ONLY
  });

  it('silentCrushAndRaise (W1 141): same timing, ZERO stnmov, pstop each turnaround', () => {
    const s = stateFor(CRUSHER_FREE);
    const line = lineBySpecial(s, 25);
    s.map.lines.special[line] = 141;
    s.map.lines.tag[line] = 25;
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    expect(s.map.lines.special[line]).toBe(0); // W1 clear

    step(s, 121); // down arrival
    expect(ceilingOf(25)!.direction).toBe(1);
    expect(sfxCount(s, SFX_STNMOV)).toBe(0); // silent ⇒ counter assert (plan)
    expect(sfxCount(s, SFX_PSTOP)).toBe(1);
    step(s, 121); // up arrival (t242)
    expect(ceilingOf(25)!.direction).toBe(-1);
    expect(sfxCount(s, SFX_STNMOV)).toBe(0);
    expect(sfxCount(s, SFX_PSTOP)).toBe(2);
  });

  it('lowerToFloor (41/43 type): dest floor EXACT, one-shot self-removal at t129', () => {
    const s = stateFor(CRUSHER_FREE);
    const line = lineBySpecial(s, 25);
    expect(evDoCeiling(s, line, CEIL.lowerToFloor)).toBe(true);
    const c = ceilingOf(25)!;
    expect(c.bottomheight).toBe(fx(0)); // NO +8 (type guard, p_ceilng.c:230)
    expect(c.crush).toBe(false);
    step(s, 128);
    expect(ceilZ(s, 25)).toBe(fx(0));
    expect(ceilingOf(25)).toBe(c);
    const n0 = thinkerCount(s.thinkers);
    step(s, 1); // t129 pastdest → P_RemoveActiveCeiling
    expect(ceilingOf(25)).toBeNull();
    expect(sectorSpecialData(s.sectors, secByTag(s, 25))).toBeNull();
    expect(c.removed).toBe(true); // lazy sentinel
    step(s, 1); // unlinked at the next visit (ptick timing)
    expect(thinkerCount(s.thinkers)).toBe(n0 - 1);
  });

  it('lowerAndCrush (44/72): reaches floor+8 and REMOVES with no obstruction', () => {
    const s = stateFor(CRUSHER_FREE);
    const line = lineBySpecial(s, 25);
    expect(evDoCeiling(s, line, CEIL.lowerAndCrush)).toBe(true);
    step(s, 121); // down 120 move + detect at 121
    expect(ceilZ(s, 25)).toBe(fx(8));
    expect(ceilingOf(25)).toBeNull(); // removed on down-arrival (p_ceilng.c:137)
  });
});

/* ------------------------------------------------------------------ */
/* 2) Crusher kill cadence (M6-04 contract; death/gibs deferred M7)    */
/* ------------------------------------------------------------------ */

describe('crusher damage cadence on a stuck player (plan §M6-08 acceptance 2)', () => {
  it('crushAndRaise over the player: 10 dmg per !(leveltime&3) tic, crushed crawl, pastdest cadence gate', () => {
    // Hand-derived tic table (run-then-increment idiom, spawn at lt 0):
    //   cz = 128 − t down at CEILSPEED=1/tic while it FITS; stuck when
    //   cz < 56 ⇒ first crushed move at t72 (cz 55, damage if 72&3==0 —
    //   it is), crushed arm slows to CEILSPEED/8 = 8192 = 1/8 unit/tic
    //   (FIXED-POINT truth — NOT 1/tic), then cz = 55 − (t−72)/8.
    //   cz reaches floor+8 (dest) at t448 (crushed, 448&3==0 → damage);
    //   t449 = the pastdest clamp+rollback tic — TWO P_ChangeSector calls
    //   but 449&3 == 1 → the cadence gate zeroes BOTH (the M6-04 double-
    //   call truth is "two calls, damage only on !(lt&3) tics").
    const s = stateFor(CRUSHER_STUCK);
    const line = lineBySpecial(s, 25);
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);

    step(s, 72); // ceiling at 56 — still FITS (gap 56 ≥ height 56)
    expect(damageEntries(s).length).toBe(0);

    step(s, 49); // tics 72…120: crush phase
    const evs = damageEntries(s);
    for (const e of evs) {
      expect(e.amount).toBe(10); // PIT_ChangeSector literal
      expect(e.source).toBeNull(); // world damage (no M7 inflictor)
      expect(e.tic & 3).toBe(0); // the !(leveltime&3) cadence
    }
    // crush-phase hits: lt 72,76,…,120 — exactly ONE per cadence tic.
    expect([...new Set(evs.map((e) => e.tic))]).toEqual(
      Array.from({ length: 13 }, (_, i) => 72 + 4 * i)
    );
    expect(evs.length).toBe(13);

    // crush-stuck physics truth: crushed (crush=true) ⇒ STAYS down, slowed
    // to CEILSPEED/8 = 8192 = 1/8 unit/tic; cz(120) = 55 − 48/8 = 49.
    const c = ceilingOf(25)!;
    expect(c.direction).toBe(-1); // still crawling down — no arrival yet
    expect(c.speed).toBe(CEILSPEED / 8);
    expect(ceilZ(s, 25)).toBe(fx(49));

    // Crawl to the down-arrival: t448 last crushed move (damage #95),
    // t449 pastdest ⇒ TWO P_ChangeSector calls, cadence-gated to ZERO.
    step(s, 449 - 121 + 1); // ticks lt 121…449 (step N runs the tic stamped N-1)
    const all = damageEntries(s);
    expect(all.length).toBe(95); // 72…448 step 4
    expect(all.filter((e) => e.tic === 448).length).toBe(1);
    expect(all.filter((e) => e.tic === 449).length).toBe(0); // double call, gated
    expect(ceilZ(s, 25)).toBe(fx(8));
    expect(c.direction).toBe(1);
    expect(c.speed).toBe(CEILSPEED); // down-arrival reset (crushAndRaise arm)

    // UP NEVER BLOCKS (`#if 0` pin): the ceiling rises THROUGH the player,
    // zero damage on the up leg.
    const before = damageEntries(s).length;
    step(s, 60);
    expect(ceilZ(s, 25)).toBe(fx(68)); // 8 + 60 · CEILSPEED, monotone
    expect(damageEntries(s).length).toBe(before);

    // Death path DEFERRED (plan §4): health/gibs live in M7/M8 — the slot
    // log is the M6 evidence, the player is structurally unkillable here.
    expect(s.players[0]!.mo.z).toBe(fx(0));
  });

  it('blood-spray PRNG draws ride the damage cadence (4 per slot, M6-04 pin)', () => {
    const s = stateFor(CRUSHER_STUCK);
    const line = lineBySpecial(s, 25);
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    step(s, 121);
    expect(pmapHookCounts.crushBlood).toBe(damageEntries(s).length);
  });
});

/* ------------------------------------------------------------------ */
/* 3) Stuck-vs-crush result matrix (live movers)                       */
/* ------------------------------------------------------------------ */

describe('stuck-vs-crush matrix (crush flag semantics, live pThingHeightClip)', () => {
  it('lowerAndCrush (crush=FALSE quirk): rests at head height 56, ZERO damage', () => {
    const s = stateFor(CRUSHER_STUCK);
    const line = lineBySpecial(s, 25);
    expect(evDoCeiling(s, line, CEIL.lowerAndCrush)).toBe(true);
    const c = ceilingOf(25)!;
    expect(c.crush).toBe(false); // PIN: 44/72 never damage (file header)

    step(s, 200);
    expect(ceilZ(s, 25)).toBe(fx(56)); // 55 rolls back to 56 EVERY tic
    expect(damageEntries(s).length).toBe(0);
    expect(c.direction).toBe(-1); // still trying, slowed
    expect(c.speed).toBe(CEILSPEED / 8); // crushed-slow arm lists lowerAndCrush
    // never removed while stuck: slot + specialdata held forever
    expect(ceilingOf(25)).toBe(c);
  });

  it('lowerToFloor over a standing player: rollback-retry at 56, no crush list', () => {
    const s = stateFor(CRUSHER_STUCK);
    const line = lineBySpecial(s, 25);
    expect(evDoCeiling(s, line, CEIL.lowerToFloor)).toBe(true);
    const c = ceilingOf(25)!;
    step(s, 200);
    expect(ceilZ(s, 25)).toBe(fx(56));
    expect(damageEntries(s).length).toBe(0);
    expect(c.speed).toBe(CEILSPEED); // lowerToFloor is NOT in the slow list
  });

  it('ceiling UP is never blocked (#if 0 pin): rise through a floater, zero damage, monotone', () => {
    const s = stateFor(RIDE);
    const mo = s.players[0]!.mo;
    // Head ABOVE the 128 ceiling (80 + 56 = 136 > 128) ⇒ clamped to
    // ceiling − 56 at the first mover tic (see the once-clamp truth at
    // the bottom of this test). (A floater whose head fits under a RISING
    // ceiling is NOT pushed — vanilla pushes only when forced; pin.)
    mo.z = fx(80);
    const line = 0; // any line works — only its tag matters
    s.map.lines.tag[line] = 7;
    expect(evDoCeiling(s, line, CEIL.raiseToHighest)).toBe(true);
    const c = ceilingOf(7)!;
    expect(c.topheight).toBe(fx(256)); // P_FindHighestCeilingSurrounding

    let prev = fx(128);
    for (let i = 0; i < 128; i++) { // 128 moves: cz 128→256, alive (arrival
                                    // move is 'ok'; pastdest detects NEXT tic)
      step(s, 1);
      const z = ceilZ(s, 7);
      expect(z >= prev, 'monotone rise, no rollback').toBe(true);
      prev = z;
      const pz = mo.z;
      expect(pz <= z - fx(56), 'player never above the ceiling').toBe(true);
    }
    expect(ceilZ(s, 7)).toBe(fx(256));
    // Vanilla push truth: the not-onfloor arm clamps ONLY on strict
    // overlap (`z + height > ceilingz`). Spawn head 136 > cz 128 ⇒ ONE
    // clamp at t1: z = 129 − 56 = 73; the speed-1 rise never overtakes a
    // fixed head again ⇒ z stays 73 (a rising ceiling does NOT carry a
    // floater — gravity-free thinkers-only step; real-game fall is M5
    // physics outside this mover tick).
    expect(mo.z).toBe(fx(73));
    expect(damageEntries(s).length).toBe(0);
    expect(ceilingOf(7)).toBe(c);
    step(s, 1); // pastdest detect — raiseToHighest REMOVES (p_ceilng.c:90)
    expect(ceilingOf(7)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* 4) Stasis: EV_CeilingCrushStop 57/74 + revival                      */
/* ------------------------------------------------------------------ */

describe('crusher stasis (57 W1 / 74 GR + revival re-fire)', () => {
  it('stop parks the thinker (fn null, direction 0), revival restores olddirection', () => {
    const s = stateFor(CRUSHER_FREE);
    const line = lineBySpecial(s, 25);
    s.map.lines.special[line] = 73; // GR crushAndRaise (no clear)
    s.map.lines.tag[line] = 25;
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    expect(s.map.lines.special[line]).toBe(73); // GR keeps
    step(s, 10);
    const z0 = ceilZ(s, 25);
    const c = ceilingOf(25)!;

    s.map.lines.special[line] = 57; // W1 crush stop
    expect(pCrossSpecialLine(s.pmap, line, 0, PLAYER)).toBe(undefined); // void in 1.10
    expect(s.map.lines.special[line]).toBe(0); // W1 clear
    expect(c.direction).toBe(0);
    expect(c.olddirection).toBe(-1);
    expect(c.fn).toBeNull(); // linked, never ticked (ptick stasis idiom)
    step(s, 20);
    expect(ceilZ(s, 25)).toBe(z0); // frozen mid-crush
    expect(ceilingOf(25)).toBe(c); // slot KEPT (stasis ≠ removal)

    // 57 again: nothing non-stasis to stop ⇒ vanilla rtn = 0.
    s.map.lines.special[line] = 57;
    expect(evCeilingCrushStop(s, line)).toBe(false);

    // Re-fire the GR crusher: P_ActivateInStasisCeiling revives (tag match,
    // direction 0); the specialdata guard stops a second spawn.
    s.map.lines.special[line] = 73;
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    expect(c.direction).toBe(-1);
    expect(c.fn).not.toBeNull();
    step(s, 5);
    expect(ceilZ(s, 25)).toBeLessThan(z0); // moving again
  });

  it('raiseToHighest does NOT revive in-stasis ceilings (stasis type list pin)', () => {
    const s = stateFor(RIDE);
    const line = 0;
    s.map.lines.tag[line] = 7;
    evDoCeiling(s, line, CEIL.raiseToHighest);
    const c = ceilingOf(7)!;
    evCeilingCrushStop(s, line);
    expect(c.direction).toBe(0);
    evDoCeiling(s, line, CEIL.raiseToHighest); // NOT in the revival list
    expect(c.direction).toBe(0); // stays parked forever
    expect(c.fn).toBeNull();
  });

  it('specialdata refuses a second mover; rtn=false when all tagged sectors busy', () => {
    const s = stateFor(CRUSHER_FREE);
    const line = lineBySpecial(s, 25);
    expect(evDoCeiling(s, line, CEIL.crushAndRaise)).toBe(true);
    expect(evDoCeiling(s, line, CEIL.crushAndRaise)).toBe(false);
    expect(evDoCeiling(s, line, CEIL.fastCrushAndRaise)).toBe(false);
    // the fast re-fire still REVIVED nothing (not in stasis) and spawned
    // nothing: exactly one slot, one thinker.
    expect(activeCeilings.filter((t) => t !== null).length).toBe(1);
    expect([...s.thinkers.entries.values()].filter((t) => !t.removed).length).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 5) Exit-line / clear truth through the real dispatcher              */
/* ------------------------------------------------------------------ */

describe('W1 clear vs GR keep on effect (registry through dispatch)', () => {
  it('6/25/44/141/57 clear; 72/73/74/77 keep', () => {
    const s = stateFor(CRUSHER_FREE);
    const line = lineBySpecial(s, 25);
    for (const id of [6, 25, 44, 141, 57]) {
      s.map.lines.special[line] = id;
      s.map.lines.tag[line] = 25;
      pCrossSpecialLine(s.pmap, line, 0, PLAYER);
      expect(s.map.lines.special[line], `W1 ${id}`).toBe(0);
      // clear the slot for the next scenario (drop the current mover)
      for (let i = 0; i < MAXCEILINGS; i++) {
        const t = activeCeilings[i] as Ceiling | null;
        if (t !== null) {
          setSectorSpecialData(s.sectors, t.sector, null);
          t.removed = true; // lazy sentinel — arena purges on next visit
          activeCeilings[i] = null;
        }
      }
    }
    for (const id of [72, 73, 74, 77]) {
      s.map.lines.special[line] = id;
      s.map.lines.tag[line] = 25;
      pCrossSpecialLine(s.pmap, line, 0, PLAYER);
      expect(s.map.lines.special[line], `GR ${id}`).toBe(id);
      for (let i = 0; i < MAXCEILINGS; i++) {
        const t = activeCeilings[i] as Ceiling | null;
        if (t !== null) {
          setSectorSpecialData(s.sectors, t.sector, null);
          t.removed = true;
          activeCeilings[i] = null;
        }
      }
    }
    expect(unimplementedSpecial.count).toBe(0); // nothing stubbed
  });
});

/* ------------------------------------------------------------------ */
/* 5b) Load census: 1.10 P_SpawnSpecials has NO ceiling case           */
/* ------------------------------------------------------------------ */

describe('level load: no spawn-special crushers exist in 1.10 (census PIN)', () => {
  it('sector specials load with ZERO active ceilings and zero movers', () => {
    // p_spec.c P_SpawnSpecials sector cases (verified): 1,2,3,4,8,9,10,
    // 12,13,14,17 — LIGHTS, SECRET, DOORS only. No ceiling/crusher case
    // exists (the sector-special-crusher idiom is later-source folklore).
    // The ceiling family = the 13 LINE ids 6/25/40/41/43/44/49/57/72/73/
    // 74/77/141 — every crusher is LINE-triggered, none at load. Fixture
    // uses SPAWN-SILENT sectors only (5/16 = feet damage specials, no
    // spawn case) ⇒ the arena must hold ZERO thinkers at load.
    const s = stateFor({
      rooms: [
        { x: 0, y: 0, w: 128, h: 128, special: 5 },
        { x: 256, y: 0, w: 128, h: 128, special: 16 }
      ],
      things: [{ x: 64, y: 64, angle: 0, type: 1 }]
    });
    expect(activeCeilings.every((t) => t === null)).toBe(true);
    for (let i = 0; i < s.sectors.count; i++) {
      expect(sectorSpecialData(s.sectors, i), `sector ${i}`).toBeNull();
    }
    const cz0: number[] = [];
    for (let i = 0; i < s.sectors.count; i++) cz0.push(s.sectors.ceilingZ[i]!);
    step(s, 10); // thinkers tick — nothing ceiling-shaped exists to tick
    for (let i = 0; i < s.sectors.count; i++) {
      expect(s.sectors.ceilingZ[i]).toBe(cz0[i]);
    }
    expect(thinkerCount(s.thinkers)).toBe(0); // 5/16 have no spawn case
    expect(unimplementedSpecial.byFn.get('evDoCeiling')).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 6) Determinism: double-run hashes (cadence + cycle + stasis)        */
/* ------------------------------------------------------------------ */

describe('double-run hash equality (L2 determinism)', () => {
  const runScenario = (seedStuck: boolean): number[] => {
    resetUnimplementedSpecial();
    const s = stateFor(seedStuck ? CRUSHER_STUCK : CRUSHER_FREE);
    const line = lineBySpecial(s, 25);
    pCrossSpecialLine(s.pmap, line, 0, PLAYER);
    const out: number[] = [];
    step(s, 60);
    out.push(hashState(s));
    if (seedStuck) {
      step(s, 61); // through the crush + pastdest damage window
      out.push(hashState(s));
      step(s, 121);
      out.push(hashState(s));
    } else {
      // stop at 60, park in stasis, revive silent, run half a cycle
      expect(evCeilingCrushStop(s, line)).toBe(true);
      out.push(hashState(s));
      evDoCeiling(s, line, CEIL.silentCrushAndRaise); // revive via stasis list
      step(s, 180);
      out.push(hashState(s));
    }
    return out;
  };

  it('crush cadence scenario: two identical runs hash equal', () => {
    expect(runScenario(true)).toEqual(runScenario(true));
  });

  it('cycle + stasis/revive scenario: two identical runs hash equal', () => {
    expect(runScenario(false)).toEqual(runScenario(false));
  });
});

/* ------------------------------------------------------------------ */
/* 7) Ownership / globals sanity                                       */
/* ------------------------------------------------------------------ */

describe('activeCeilings global', () => {
  it('activeCeilings is the pceilng-owned array re-exported by pspec', () => {
    expect(familyActiveCeilings).toBe(activeCeilings);
  });

  it('add overflow counts (vanilla I_Error slot)', () => {
    const junk = { id: -1, fn: null, removed: false, hashWords: [] };
    const saved = activeCeilings.slice();
    try {
      for (let i = 0; i < MAXCEILINGS; i++) activeCeilings[i] = junk;
      pAddActiveCeiling(null as never, junk as never);
      expect(pceilngCounts.addOverflow).toBe(1);
    } finally {
      for (let i = 0; i < MAXCEILINGS; i++) activeCeilings[i] = saved[i] ?? null;
    }
  });
});
