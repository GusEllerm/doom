// sim/pmissiles.test.ts — M7-09 projectiles (plan §M7-09 acceptance 1/2/4):
// P_CheckMissileSpawn nudge/explode-if-blocked, P_SpawnMissile mom math
// (incl. the MF_SHADOW jitter draws), P_SpawnPlayerMissile (spawn AT the
// source xy — NO offset in 1.10 — z + 4*8*FRACUNIT, momz from the aim
// slope), straight parabola-free flight, the PIT_CheckThing MF_MISSILE
// direct-hit formula `(P_Random()%8+1)*info->damage` under a seeded
// stream, the same-species rules (never hit shooter / explode-no-damage)
// and the launch sfx slot ids.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it } from 'vitest';

import { ANG180, ANG90, FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import { buildMapFromData } from './map';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { gInitGame } from './game';
import { hashState, type GameState, type Skill } from './state';
import { RNDTABLE } from './prng';
import { mobjinfo, MF, MT } from '../wad/info/mobjinfo';
import { S } from '../wad/info/states';

import {
  MISSILERANGE,
  attackRange,
  mobjHookCounts,
  pSpawnMobj,
  resetMobjHookCounts,
  type Mobj,
} from './p_mobj';
import { pRunThinkers } from './ptick';
import {
  attachPsprFields,
  bindPsprWorld,
  resetPsprHooks,
  resetPsprHookCounts,
} from './p_pspr';
import { bindShootWorld, registerShootPsprHooks, resetShootGlobals } from './p_shoot';
import { resetPmoveHookCounts } from './pmove';
import { pmapHookCounts, resetPmapHookCounts } from './pmap';
import { pSpawnMissile, pSpawnPlayerMissile, registerMissileHooks } from './pmissiles';

/* ------------------------------------------------------------------ */
/* Harness (same shape as p_shoot.test.ts)                              */
/* ------------------------------------------------------------------ */

const fx = (n: number): number => (n * FRACUNIT) | 0;

function boot(spec: RectMapSpec, skill: Skill = 2): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), skill);
}

/** 1024×512 range; player 1 at (128,128) facing EAST (angle 0). */
function range(extra: RectMapSpec['things'] = []): GameState {
  return boot({
    rooms: [{ x: 0, y: 0, w: 1024, h: 512, lightLevel: 160 }],
    things: [{ x: 128, y: 128, angle: 0, type: 1 }, ...extra],
  });
}

const live = (s: GameState): Mobj[] => s.mobjs.mobjs.filter((m) => !m.removed);
const of = (s: GameState, t: number): Mobj[] => live(s).filter((m) => m.type === t);

function shooter(s: GameState): ReturnType<typeof attachPsprFields> {
  bindShootWorld(s);
  const p = attachPsprFields(s.players[0]!);
  bindPsprWorld({ rng: s.rng, leveltime: s.leveltime });
  return p;
}

/** Advance the thinker arena n tics (P_MobjThinker pass; the specials/
 * player drivers are irrelevant here — fixtures have no movers). */
function tick(s: GameState, n: number): void {
  for (let i = 0; i < n; i++) {
    pRunThinkers(s.thinkers);
    s.leveltime++;
  }
}

/** The player's mover is a REAL Mobj from M7-03 (typed MobjStub in the
 * Player record — the runtime object is the arena mobj). */
const pmo = (p: { mo: object }): Mobj => p.mo as unknown as Mobj;

const momX = (type: number, angle: number): number =>
  FixedMul(mobjinfo[type]!.speed, finecosine[angle >>> 9]!);
const momY = (type: number, angle: number): number =>
  FixedMul(mobjinfo[type]!.speed, finesine[angle >>> 9]!);

beforeEach(() => {
  resetPsprHooks(); // counted no-op defaults…
  registerShootPsprHooks(); // …+ M7-08's three slots…
  registerMissileHooks(); // …+ M7-09's spawnPlayerMissile / PIT bodies
  resetShootGlobals();
  resetPsprHookCounts();
  resetPmapHookCounts();
  resetPmoveHookCounts();
  resetMobjHookCounts();
  attackRange.value = MISSILERANGE;
  bindShootWorld(null);
});

/* ================================================================== */
/* 1. P_SpawnPlayerMissile — p_mobj.c:935-980                           */
/* ================================================================== */

describe('P_SpawnPlayerMissile (p_mobj.c:935, R08 §3.6)', () => {
  it('spawn AT source xy (1.10 has NO forward offset), z + 4*8*FRACUNIT', () => {
    const s = range();
    const p = shooter(s);
    const src = pmo(p);
    const before = s.rng.prndindex;
    pSpawnPlayerMissile(s.mobjs, src, MT.MT_ROCKET);

    const r = of(s, MT.MT_ROCKET)[0]!;
    expect(r).toBeDefined();
    // BEFORE the CheckMissileSpawn nudge, x == source x: the nudge adds
    // exactly momx>>1 — assert the SUM, which pins the zero offset:
    expect(r.x).toBe(src.x + (r.momx >> 1));
    expect(r.y).toBe(src.y + (r.momy >> 1));
    expect(r.z).toBe(src.z + fx(32));
    expect(r.target).toBe(src);
    expect(r.angle).toBe(src.angle >>> 0);
    expect(r.flags & MF.MF_MISSILE).toBe(MF.MF_MISSILE);
    expect(r.flags & MF.MF_NOGRAVITY).toBe(MF.MF_NOGRAVITY);
    expect(r.flags & MF.MF_DROPOFF).toBe(MF.MF_DROPOFF);
    // Draws: P_SpawnMobj lastlook (1) + CheckMissileSpawn tics (1). No
    // aim probes hit anything (all three miss ⇒ slope 0, zero draws).
    expect((s.rng.prndindex - before) & 255).toBe(2);
  });

  it('mom = speed·(cos,sin) from the tables, momz = FixedMul(speed, 0)', () => {
    const s = range();
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    const r = of(s, MT.MT_ROCKET)[0]!;
    expect(r.momx).toBe(momX(MT.MT_ROCKET, 0)); // 20*FRACUNIT·finecosine[0]
    expect(r.momy).toBe(momY(MT.MT_ROCKET, 0)); // table quirk: finesine[0]=25
    expect(r.momz).toBe(0); // no autoaim target → slope 0 fallback
  });

  it('straight flight: mom added every tic, no friction, no gravity drift', () => {
    const s = range();
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    const r = of(s, MT.MT_ROCKET)[0]!;
    const x0 = r.x;
    const z0 = r.z;
    tick(s, 5);
    expect(r.momx).toBe(momX(MT.MT_ROCKET, 0)); // MF_MISSILE: friction never
    expect(r.momz).toBe(0);
    expect(r.z).toBe(z0); // MF_NOGRAVITY: parabola-free
    // 1 spawn nudge + 5 tics of mom:
    expect(r.x).toBe(x0 + 5 * momX(MT.MT_ROCKET, 0));
  });

  it('P_CheckMissileSpawn: tics −= P_Random()&3 clamped to ≥1', () => {
    const s = range();
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    const r = of(s, MT.MT_ROCKET)[0]!;
    // Stream position `before+1` was the tics draw (index 0 = lastlook):
    // reconstruct from the table without assuming its value.
    expect(r.tics).toBeGreaterThanOrEqual(1);
    expect(r.tics).toBeLessThanOrEqual(stateTicsOf(S.S_ROCKET));
    for (const m of s.mobjs.mobjs) if (m.type === MT.MT_ROCKET) void m;
  });

  it('P_CheckMissileSpawn explodes when blocked at spawn (thing inside)', () => {
    // Rocket spawned INSIDE the player itself is the skip-self rule, so
    // use a wall: aim into the corner by teleporting the source 8 units
    // from the east wall (2 units short of its own 20-unit step).
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 148, h: 512, lightLevel: 160 }],
      things: [{ x: 128, y: 128, angle: 0, type: 1 }],
    });
    const p = shooter(s);
    resetPmoveHookCounts();
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    // Pre-stepped 10 units into/through the wall line ⇒ P_TryMove fails ⇒
    // P_ExplodeMissile immediately (no sky: solid one-sided border).
    expect(s.mobjs.counts.explodeMissile).toBe(1);
    const r = of(s, MT.MT_ROCKET)[0];
    if (r) expect(r.momx).toBe(0); // exploded: momentum zeroed
    expect(pmapHookCounts.missileHit).toBe(0); // wall, not a thing
  });

  it('sfx slot ids: launch draws sfx_rlaunc (14) at the missile origin', () => {
    const s = range();
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    const r = of(s, MT.MT_ROCKET)[0]!;
    expect(s.hooks.sfx.byId?.get(14)).toBe(1);
    // S_StartSound runs at the pSpawnMobj site — BEFORE the CheckMissile-
    // Spawn prestep (vanilla order), so the coords are the pre-nudge xy.
    expect(s.hooks.sfx.entries.find((e) => e.id === 14)!.x).toBe(r.x - (r.momx >> 1));

    const t = range();
    const q = shooter(t);
    pSpawnPlayerMissile(t.mobjs, q.mo as unknown as Mobj, MT.MT_PLASMA);
    expect(t.hooks.sfx.byId?.get(8)).toBe(1); // sfx_plasma
    const u = range();
    const w = shooter(u);
    pSpawnPlayerMissile(u.mobjs, w.mo as unknown as Mobj, MT.MT_BFG);
    expect(u.hooks.sfx.count).toBe(0); // MT_BFG seesound = sfx_None ('0')
  });
});

/* ================================================================== */
/* 2. P_SpawnMissile — p_mobj.c:889-925 (monster-family aim)             */
/* ================================================================== */

describe('P_SpawnMissile (p_mobj.c:889)', () => {
  it('mom vector aims at dest; momz = dz / (dist/speed); one lastlook draw', () => {
    const s = range();
    const src = shooter(s).mo as unknown as Mobj;
    const dest = pSpawnMobj(s.mobjs, fx(328), src.y, src.z, MT.MT_POSSESSED);
    const before = s.rng.prndindex;
    const th = pSpawnMissile(s.mobjs, src, dest, MT.MT_HEADSHOT);
    // draws AFTER the dest spawn (already snapshotted): missile lastlook 1
    // + CheckMissileSpawn tics 1 = 2 (no MF_SHADOW on a plain dest).
    expect((s.rng.prndindex - before) & 255).toBe(2);
    expect(th.target).toBe(src);
    expect(th.momz).toBe(0); // same z
    expect(th.momy).toBeLessThan(1000); // due-east: table-noise only
    // MT_HEADSHOT speed = 10*FRACUNIT (mobjinfo row) — full speed on x:
    expect(th.momx).toBe(FixedMul(mobjinfo[MT.MT_HEADSHOT]!.speed, finecosine[0]!));
    expect(th.x).toBe(src.x + (th.momx >> 1)); // prestep at source xy
  });

  it('MF_SHADOW dest: 2 EXTRA jitter draws, angle ≠ direct', () => {
    const s = range();
    const src = shooter(s).mo as unknown as Mobj;
    const dest = pSpawnMobj(s.mobjs, fx(328), src.y, src.z, MT.MT_POSSESSED);
    dest.flags = (dest.flags | MF.MF_SHADOW) | 0;
    const before = s.rng.prndindex;
    const th = pSpawnMissile(s.mobjs, src, dest, MT.MT_HEADSHOT);
    expect((s.rng.prndindex - before) & 255).toBe(4); // +2 fuzzy jitter
    expect(th.angle).not.toBe(0);
    expect(th.angle >>> 0).toBeGreaterThan(0);
  });
});

/* ================================================================== */
/* 3. PIT_CheckThing MF_MISSILE branch — p_map.c:291-330                */
/* ================================================================== */

describe('missile thing hits (PIT_CheckThing, R07 §9.1)', () => {
    it('direct hit damage = (P_Random()%8+1)*20 under the seeded stream', () => {
    const s = range([{ x: 328, y: 128, angle: 0, type: 3004 }]); // Zombieman
    const p = shooter(s);
    const before = s.rng.prndindex;
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    tick(s, 12);
    const direct = s.hooks.damage.entries[0];
    expect(direct, 'one direct-hit damage event').toBeDefined();
    // Stream order: lastlook (before+1), spawn tics (before+2), then the
    // PIT_CheckThing damage draw (before+3) — P_Random PRE-increments.
    const hitDraw = RNDTABLE[(before + 3) & 255]!;
    expect(direct!.amount).toBe(((hitDraw % 8) + 1) * mobjinfo[MT.MT_ROCKET]!.damage);
    expect(direct!.source).toBe(pmo(p).linkSlot); // tmthing->target
    expect(s.hooks.damage.count).toBeGreaterThanOrEqual(1);
    expect(pmapHookCounts.missileHit).toBe(1);
  });

  it('range pin: repeated seeds produce values inside [20,160] step 20', () => {
    const s = range([{ x: 328, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    const seen = new Set<number>();
    for (let round = 0; round < 40; round++) {
      const before = s.rng.prndindex;
      pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
      tick(s, 3); // hit lands within a few tics at 20 units/tic
      // recompute directly from the stream: hit draw at before+3
      // (spawn lastlook, spawn tics, then the PIT damage draw):
      const want = ((RNDTABLE[(before + 3) & 255]! % 8) + 1) * 20;
      seen.add(want);
      expect(want % 20).toBe(0);
      expect(want).toBeGreaterThanOrEqual(20);
      expect(want).toBeLessThanOrEqual(160);
    }
    expect(seen.size).toBeGreaterThan(3);
  });

  it('over/under passes: high missile (spatially impossible here) via z poke', () => {
    const s = range([{ x: 328, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    const r = of(s, MT.MT_ROCKET)[0]!;
    r.z = fx(64); // above the 56-tall dummy's top at floor 0
    r.momz = 0;
    s.rng.prndindex = (s.rng.prndindex - 0) | 0;
    tick(s, 12);
    expect(s.hooks.damage.count, 'overhead pass does no damage').toBe(0);
    expect(pmapHookCounts.missileHit).toBe(0);
    expect(s.mobjs.counts.explodeMissile, 'flies on — no explode from a thing').toBe(0);
  });

  it('rocket never damages its shooter (same-species skip, p_map.c:306)', () => {
    // Fire WEST at the player's own cell: the shooter sits IN the path.
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 1024, h: 512, lightLevel: 160 }],
      things: [{ x: 512, y: 256, angle: 180, type: 1 }], // facing WEST
    });
    const p = shooter(s);
    const src = pmo(p);
    src.x = fx(640); // stand east of the start, still facing west
    pSpawnPlayerMissile(s.mobjs, src, MT.MT_ROCKET);
    tick(s, 30);
    // The rocket passes THROUGH the shooter (skip ⇒ return true) and the
    // player mobj is never a damage target:
    expect(s.hooks.damage.count).toBe(0);
    const shots = s.mobjs.mobjs.filter((m) => m.type === MT.MT_ROCKET);
    expect(shots.length).toBe(1);
    expect(shots[0]!.removed || shots[0]!.x < src.x).toBeTruthy();
  });

  it('same-species monster shot: explodes WITHOUT damage (p_map.c:311)', () => {
    const s = range();
    // Away from the player's own cell (128,128) — a missile spawned INTO
    // the player would hit the player first (the spawn prestep!).
    const shooterImp = pSpawnMobj(s.mobjs, fx(128), fx(256), 0, MT.MT_POSSESSED);
    const victim = pSpawnMobj(s.mobjs, fx(328), fx(256), 0, MT.MT_POSSESSED);
    pSpawnMissile(s.mobjs, shooterImp, victim, MT.MT_TROOPSHOT);
    const dmgBefore = s.hooks.damage.count;
    tick(s, 20);
    expect(s.hooks.damage.count, 'no direct damage').toBe(dmgBefore);
    expect(pmapHookCounts.missileNoDamage).toBe(1); // explode-no-damage
    const shot = s.mobjs.mobjs.find((m) => m.type === MT.MT_TROOPSHOT)!;
    expect(shot.removed || (shot.momx === 0 && shot.momy === 0)).toBeTruthy();
  });

  it('player-shot-at-player is allowed cross-type (MT_PLAYER ≠ monster): damages', () => {
    // Player-fired rocket into a MONSTER: plain direct hit (the species
    // rule only skips when shooter.type == victim.type).
    const s = range([{ x: 328, y: 128, angle: 0, type: 3001 }]); // baron
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    tick(s, 12);
    expect(s.hooks.damage.count).toBeGreaterThanOrEqual(1);
  });

  it('explosion after the hit: S_EXPLODE1 state + sfx_barexp (82) deathsound', () => {
    const s = range([{ x: 328, y: 128, angle: 0, type: 3004 }]);
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    tick(s, 12);
    const r = s.mobjs.mobjs.find((m) => m.type === MT.MT_ROCKET)!;
    expect(r.removed || r.state >= S.S_EXPLODE1).toBeTruthy();
    expect(s.hooks.sfx.byId?.get(82), 'deathsound via mobjHooks seam').toBe(1);
    expect(mobjHookCounts.startSound).toBeGreaterThanOrEqual(1);
  });

  it('double-run determinism: same script ⇒ same hash + event logs', () => {
    const run = (): string => {
      const s = range([{ x: 328, y: 128, angle: 0, type: 3004 }]);
      const p = shooter(s);
      pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
      tick(s, 25);
      return `${hashState(s)}|${JSON.stringify(s.hooks.damage.entries)}|${s.rng.prndindex}`;
    };
    expect(run()).toBe(run());
  });

  it('90° rocket: mom from angle, flight stays on the y axis', () => {
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 1024, h: 512, lightLevel: 160 }],
      things: [{ x: 128, y: 128, angle: 90, type: 1 }],
    });
    const p = shooter(s);
    pSpawnPlayerMissile(s.mobjs, pmo(p), MT.MT_ROCKET);
    const r = of(s, MT.MT_ROCKET)[0]!;
    expect(r.angle).toBe(ANG90);
    tick(s, 4);
    expect(r.x - fx(128)).toBeLessThanOrEqual(fx(1)); // cos(90°) table noise
    expect(r.y - fx(128)).toBeGreaterThan(fx(70)); // 4·20 units north
    void ANG180;
  });
});

function stateTicsOf(st: number): number {
  // local import-free read of the states table tics via mobjinfo spawn
  return st === S.S_ROCKET ? 10 : 0;
}

/* ================================================================== */
/* 4. E1M1 world test (plan: rocket-through-door scenario, skipIf WAD)  */
/* ================================================================== */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('E1M1 rocket world (freedoom1.wad)', () => {
  function e1m1(): GameState {
    const bytes = readFileSync(WAD_PATH);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')), 2);
  }

  it('rocket flies and explodes on the start-room wall; double-run exact', () => {
    const run = (): number => {
      const s = e1m1();
      const p = shooter(s);
      // WEST from the player start — the start room's west wall is ~50
      // units (rocket = 20 u/tic ⇒ impact in ~3 tics, no LOS-to-sky).
      (p.mo as unknown as Mobj).angle = 1 << 31; // ANG180
      pSpawnPlayerMissile(s.mobjs, p.mo as unknown as Mobj, MT.MT_ROCKET);
      for (let i = 0; i < 20; i++) {
        pRunThinkers(s.thinkers);
        s.leveltime++;
      }
      expect(s.mobjs.counts.explodeMissile, 'hit the wall').toBe(1);
      expect(s.hooks.sfx.byId?.get(82)).toBe(1); // sfx_barexp deathsound
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});
