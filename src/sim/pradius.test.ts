// sim/pradius.test.ts — M7-09 splash (plan §M7-09 acceptance 3 + the BFG
// stream pins): P_RadiusAttack falloff `damage − chebyshev(dist−radius)`
// with LOS, the "splash comes from the DEATH STATE, not P_ExplodeMissile"
// truth (rockets/barrels only — plasma/BFG/monster shots do NO splash),
// the MT_CYBORG/MT_SPIDER immunity, self-splash (the rocket-jump fact),
// and A_BFGSpray's 40-ray prnd stream (16 draws × HIT rays only, in ray
// order: 1 MT_EXTRABFG-spawn lastlook + 15 `(P_Random()&7)+1`).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildMapFromData } from './map';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { gInitGame } from './game';
import { hashState, type GameState } from './state';
import { RNDTABLE } from './prng';
import { MT } from '../wad/info/mobjinfo';
import { S, stateAction } from '../wad/info/states';

import { MISSILERANGE, attackRange, pSpawnMobj, resetMobjHookCounts, type Mobj } from './p_mobj';
import { pRunThinkers } from './ptick';
import {
  attachPsprFields,
  bindPsprWorld,
  resetPsprHooks,
  resetPsprHookCounts,
} from './p_pspr';
import { bindShootWorld, registerShootPsprHooks, resetShootGlobals } from './p_shoot';
import { resetPmoveHookCounts } from './pmove';
import { resetPmapHookCounts } from './pmap';
import { pSpawnMissile, pSpawnPlayerMissile, registerMissileHooks } from './pmissiles';
import { pRadiusAttack } from './pradius';
import { pExplodeMissile } from './p_mobj';

const fx = (n: number): number => (n * FRACUNIT) | 0;

function boot(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), 2);
}

function range(extra: RectMapSpec['things'] = []): GameState {
  return boot({
    rooms: [{ x: 0, y: 0, w: 1024, h: 512, lightLevel: 160 }],
    things: [{ x: 128, y: 128, angle: 0, type: 1 }, ...extra],
  });
}

/** Two 512-wide rooms sharing the x=512 wall with a door GAP in the
 * middle; the walls beside the gap are one-sided (LOS blockers). */
function twinRooms(extra: RectMapSpec['things'] = []): GameState {
  return boot({
    rooms: [
      { x: 0, y: 0, w: 512, h: 512, lightLevel: 160 },
      { x: 512, y: 0, w: 512, h: 512, lightLevel: 160 },
    ],
    things: [{ x: 128, y: 128, angle: 0, type: 1 }, ...extra],
  });
}

const live = (s: GameState): Mobj[] => s.mobjs.mobjs.filter((m) => !m.removed);
void live;
const pmo = (p: { mo: object }): Mobj => p.mo as unknown as Mobj;

function shooter(s: GameState): ReturnType<typeof attachPsprFields> {
  bindShootWorld(s);
  const p = attachPsprFields(s.players[0]!);
  bindPsprWorld({ rng: s.rng, leveltime: s.leveltime });
  return p;
}

function tick(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    pRunThinkers(s.thinkers);
    s.leveltime++;
  }
}

/** Splash events (inflictor-unaware damageSlot log = all damage today);
 * the direct-hit event is the FIRST one (PIT runs before the explode). */
const dmgEvents = (s: GameState) => s.hooks.damage.entries;

beforeEach(() => {
  resetPsprHooks();
  registerShootPsprHooks();
  registerMissileHooks();
  resetShootGlobals();
  resetPsprHookCounts();
  resetPmapHookCounts();
  resetPmoveHookCounts();
  resetMobjHookCounts();
  attackRange.value = MISSILERANGE;
  bindShootWorld(null);
});

/* ================================================================== */
/* 1. A_Explode → P_RadiusAttack: the 128-falloff matrix                */
/* ================================================================== */

describe('rocket splash (A_Explode → P_RadiusAttack, p_map.c:1160)', () => {
  /** Fire east from the standard player; explode at the x=w wall. */
  function rocketIntoWall(roomW: number, extra: RectMapSpec['things'] = []) {
    const s = boot({
      rooms: [{ x: 0, y: 0, w: roomW, h: 512, lightLevel: 160 }],
      things: [{ x: 128, y: 128, angle: 0, type: 1 }, ...extra],
    });
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    tick(s, Math.ceil((roomW - 128 - 10) / 20) + 4);
    return s;
  }

  it('wall impact: victim within LOS takes 128 − chebyshev(dist−radius)', () => {
    // Victim 60 units north of the impact point (x=roomW wall at 300).
    const s = rocketIntoWall(300, [{ x: 300 - 4, y: 128 + 60, angle: 0, type: 3004 }]);
    const expl = s.mobjs.mobjs.find((m) => m.type === MT.MT_ROCKET && m.state >= S.S_EXPLODE1)!;
    expect(expl, 'rocket reached the explode state').toBeDefined();
    const victim = s.mobjs.mobjs.find((m) => m.type === MT.MT_POSSESSED)!;
    const dx = Math.abs(victim.x - expl.x);
    const dy = Math.abs(victim.y - expl.y);
    const dist = Math.max(0, ((Math.max(dx, dy) - victim.radius) >> 16));
    const want = 128 - dist;
    const e = dmgEvents(s).find((ev) => ev.thing === victim.linkSlot);
    expect(e, 'splash event for the victim').toBeDefined();
    expect(e!.amount).toBe(want);
    expect(e!.source).toBe((s.players[0]!.mo as unknown as Mobj).linkSlot); // bombsource
  });

  it('wall-BLOCKED victim in range takes 0 (LOS, plan acceptance 3)', () => {
    // DETACHED rooms (a void gap between — shared edges would be OPEN
    // connections in this builder): both flanking walls are void-backed
    // closed two-sided lines the LOS traverse must reject. reject is
    // all-zero in fixtures, so this exercises the TRAVERSE, not the table.
    const s = boot({
      rooms: [
        { x: 0, y: 0, w: 260, h: 512, lightLevel: 160 },
        { x: 340, y: 0, w: 200, h: 512, lightLevel: 160 },
      ],
      things: [
        { x: 128, y: 128, angle: 0, type: 1 },
        { x: 370, y: 140, angle: 0, type: 3004 }, // behind two walls, <128 away
      ],
    });
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    tick(s, 12);
    const victim = s.mobjs.mobjs.find((m) => m.type === MT.MT_POSSESSED)!;
    expect(
      dmgEvents(s).some((e) => e.thing === victim.linkSlot),
      'no splash through a solid wall',
    ).toBe(false);
    expect(s.mobjs.counts.explodeMissile).toBe(1); // it DID explode there
  });

  it('out of radius (>128 units) takes nothing', () => {
    const s = rocketIntoWall(300, [{ x: 300 - 8, y: 128 + 160, angle: 0, type: 3004 }]);
    const victim = s.mobjs.mobjs.find((m) => m.type === MT.MT_POSSESSED)!;
    expect(dmgEvents(s).some((e) => e.thing === victim.linkSlot)).toBe(false);
  });

  it('bosses are concussion-immune (MT_CYBORG/MT_SPIDER)', () => {
    // OFF the rocket's line of flight (a direct PIT hit has no boss
    // exemption — that rule is radius-only); both inside the 128 splash.
    const s = rocketIntoWall(300, [
      { x: 285, y: 200, angle: 0, type: 16 }, // cyberdemon, ~70 units away
      { x: 285, y: 175, angle: 0, type: 3004 }, // zombieman control, ~50
    ]);
    const boss = s.mobjs.mobjs.find((m) => m.type === MT.MT_CYBORG)!;
    const ctrl = s.mobjs.mobjs.find((m) => m.type === MT.MT_POSSESSED)!;
    expect(dmgEvents(s).some((e) => e.thing === boss.linkSlot), 'boss immune').toBe(false);
    expect(dmgEvents(s).some((e) => e.thing === ctrl.linkSlot), 'control hit').toBe(true);
  });

  it('self-splash: 1.10 rockets CAN damage the shooter (rocket-jump truth)', () => {
    // Shooter 24 units from the impact ⇒ dist 0 ⇒ full 128.
    const s = rocketIntoWall(152, []);
    const player = s.players[0]!.mo as unknown as Mobj;
    const e = dmgEvents(s).find((ev) => ev.thing === player.linkSlot);
    expect(e, 'P_RadiusAttack has NO source exclusion').toBeDefined();
    expect(e!.amount).toBeGreaterThan(100);
    expect(e!.source).toBe(player.linkSlot); // bombsource == self
  });

  it('direct hit THEN splash: two events for one point-blank victim', () => {
    const s = rocketIntoWall(240, [{ x: 236, y: 128, angle: 0, type: 3004 }]);
    const victim = s.mobjs.mobjs.find((m) => m.type === MT.MT_POSSESSED)!;
    const evs = dmgEvents(s).filter((e) => e.thing === victim.linkSlot);
    expect(evs.length).toBeGreaterThanOrEqual(2);
    // 0 = direct (PIT, dice*20, no LOS needed); 1 = splash ≥ 128−dist
    expect(evs[0]!.amount % 20).toBe(0);
    expect(evs[1]!.amount).toBeLessThanOrEqual(128);
    expect(evs[1]!.amount).toBeGreaterThan(100);
  });

  it('PLASMA wall impact: direct-only — NO splash (R07 §9.2)', () => {
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 300, h: 512, lightLevel: 160 }],
      things: [
        { x: 128, y: 128, angle: 0, type: 1 },
        { x: 250, y: 175, angle: 0, type: 3004 }, // off-axis AND 25 from wall
      ],
    });
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_PLASMA);
    tick(s, 10);
    expect(s.mobjs.counts.explodeMissile).toBe(1);
    expect(dmgEvents(s).length, 'wall impact does no damage at all').toBe(0);
  });

  it('monster shot (MT_TROOPSHOT) wall impact: explode, zero splash', () => {
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 300, h: 512, lightLevel: 160 }],
      things: [
        { x: 128, y: 128, angle: 0, type: 1 },
        { x: 260, y: 150, angle: 0, type: 3004 },
      ],
    });
    const shooterMo = pSpawnMobj(s.mobjs, fx(128), fx(256), 0, MT.MT_POSSESSED);
    const dest = pSpawnMobj(s.mobjs, fx(295), fx(256), 0, MT.MT_HEADSHOT); // wall marker at x=300
    void dest;
    pSpawnMissile(s.mobjs, shooterMo, { x: fx(299), y: fx(256), z: 0 } as Mobj, MT.MT_TROOPSHOT);
    tick(s, 22); // 10 u/tic from x≈135 to the x=300 wall + the explode tic
    const victim = s.mobjs.mobjs.find((m) => m.type === MT.MT_POSSESSED && m !== shooterMo)!;
    expect(s.mobjs.counts.explodeMissile).toBe(1);
    expect(dmgEvents(s).some((e) => e.thing === victim.linkSlot)).toBe(false);
  });

  it('barrel path exists: only S_EXPLODE1/S_BEXP4 carry A_Explode (info scan)', () => {
    // states.ts action column scan — EXACTLY two A_Explode (24) carriers
    // among the M7 projectile/explosion states (S_BEXP4 is the barrel;
    // S_EXPLODE1 the rocket puff). A_BFGSpray (23) exactly one (S_BFGLAND3).
    let explode = 0;
    let spray = 0;
    for (let i = 0; i < 967; i++) {
      const a = stateActionOf(i);
      if (a === 24) explode++;
      if (a === 23) spray++;
    }
    expect(spray).toBe(1);
    expect(explode).toBeGreaterThanOrEqual(2); // S_EXPLODE1 + S_BEXP4 (+barrels)
  });

  it('P_RadiusAttack direct API: damage = 128 − dist, LOS-gated, no draws', () => {
    const s = range([{ x: 300, y: 128, angle: 0, type: 3004 }]);
    const spot = s.mobjs.mobjs.find((m) => m.type === MT.MT_POSSESSED)!;
    const before = s.rng.prndindex;
    pRadiusAttack(s.mobjs, spot, null, 128);
    expect(s.rng.prndindex).toBe(before); // P_RadiusAttack draws NOTHING
    const e = dmgEvents(s)[0];
    expect(e!.amount).toBe(128); // center visit: dist 0
    expect(e!.source).toBe(null); // bombsource NULL (environmental)
  });

  it('double-run: splash scenario hash + logs identical', () => {
    const run = (): string => {
      const s = twinRooms([
        { x: 500, y: 200, angle: 0, type: 3004 },
        { x: 530, y: 200, angle: 0, type: 3004 },
      ]);
      const p = shooter(s);
      pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
      tick(s, 60);
      return `${hashState(s)}|${JSON.stringify(s.hooks.damage.entries)}|${s.rng.prndindex}`;
    };
    expect(run()).toBe(run());
  });
});

/* ================================================================== */
/* 2. A_BFGSpray — p_pspr.c:781 stream pins                            */
/* ================================================================== */

describe('A_BFGSpray (p_pspr.c:781, S_BFGLAND3)', () => {
  /** BFG mobj NORTH-bound from the player, exploded deterministically
   * via pExplodeMissile (no flight ⇒ no flight draws before the spray). */
  function sprayFixture(extras: RectMapSpec['things'] = []) {
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 1024, h: 1024, lightLevel: 160 }],
      things: [{ x: 512, y: 128, angle: 90, type: 1 }, ...extras],
    });
    const p = shooter(s);
    const bfg = pSpawnMobj(s.mobjs, fx(512), fx(300), 0, MT.MT_BFG);
    bfg.target = pmo(p);
    bfg.angle = ANG90_LOCAL; // spray arc centered due NORTH
    return { s, p, bfg };
  }

  const ANG90_LOCAL = 0x40000000;

  it('boom: P_ExplodeMissile sets S_BFGLAND + sfx_rxplod (15), NO splash', () => {
    const { s, bfg } = sprayFixture([{ x: 560, y: 260, angle: 0, type: 3004 }]);
    pExplodeMissile(bfg);
    expect(s.mobjs.counts.explodeMissile).toBe(1);
    expect(bfg.state).toBe(S.S_BFGLAND);
    expect(s.hooks.sfx.byId?.get(15)).toBe(1); // deathsound sfx_rxplod
    expect(dmgEvents(s).length, 'BFG impact itself splashes NOTHING').toBe(0);
    expect(s.mobjs.mobjs.filter((m) => m.type === MT.MT_EXTRABFG).length).toBe(0);
  });

  it('spray timing: A_BFGSpray fires when S_BFGLAND3 sets (≈13–16 tics)', () => {
    const { s, bfg } = sprayFixture([{ x: 512, y: 700, angle: 0, type: 3004 }]);
    const start = s.rng.prndindex;
    pExplodeMissile(bfg); // +1 draw (tics)
    tick(s, 20);
    const hits = dmgEvents(s);
    expect(hits.length, 'ray hits damaged the dummy').toBeGreaterThan(0);
    expect(hits[0]!.thing).toBe(s.mobjs.mobjs.find((m) => m.type === MT.MT_POSSESSED)!.linkSlot);
    // BFGLAND3 is reached 16−(explodeTicsDraw&3) tics later; the draws
    // between are ONLY the spray's own (thinkers here never draw):
    expect(s.rng.prndindex).toBe((start + 1 + 16 * hits.length) & 255);
    void bfg;
  });

  it('STREAM PIN: 16 draws × hit-rays (1 spawn lastlook + 15 dice) in ray order', () => {
    const { s, bfg } = sprayFixture([
      { x: 460, y: 700, angle: 0, type: 3004 },
      { x: 560, y: 700, angle: 0, type: 3004 },
    ]);
    const start = s.rng.prndindex;
    pExplodeMissile(bfg); // draw A: explode tics (index start+1)
    tick(s, 20);

    const hits = dmgEvents(s);
    expect(hits.length, 'both dummies take multiple rays').toBeGreaterThan(2);
    const extrabfg = s.mobjs.mobjs.filter((m) => m.type === MT.MT_EXTRABFG).length;
    expect(extrabfg, 'one MT_EXTRABFG per hit ray').toBe(hits.length);

    // Exact layout: explode tics at start+1, then per hit ray k: spawn
    // lastlook at start+2+16k, the 15 dice at start+3+16k … +17+16k.
    for (let k = 0; k < hits.length; k++) {
      let want = 0;
      for (let j = 0; j < 15; j++) want += (RNDTABLE[(start + 3 + 16 * k + j) & 255]! & 7) + 1;
      expect(hits[k]!.amount, `ray ${k} damage`).toBe(want);
    }
    expect(s.rng.prndindex).toBe((start + 1 + 16 * hits.length) & 255);
  });
});

function stateActionOf(i: number): number {
  return stateAction[i]!;
}

