/**
 * sim/pSaveg tests — M11-04 (M11-plan §M11-04, §0.1-§0.3): capture →
 * blank-world → restore IDENTITY across the scenario corpus, the GOLDEN
 * PROPERTY (save@T ⇒ restore ⇒ 500 tics == original T..T+500 hashes), the
 * PRNG pins (vanilla reset-stream equivalence + payload continuation), and
 * the game.ts ga_savegame/ga_loadgame drain + sendsave chain timing.
 *
 * Fixture: one rect-map (tagged mover room + fire/strobe/flash/secret
 * special rooms + monsters + items). Scenarios force movers via the ev*
 * entry points (deterministic, no input dependence on line geometry).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';

import { buildMapFromData, type RuntimeMap } from './map';
import {
  GA,
  gInitGame,
  gInitNew,
  gRequestLoadGame,
  gSaveGame,
  gTicker,
  registerGameFlowHooks,
  resetFlowStubHits,
  resetGameFlow,
  resetSaveFlow,
  saveFlow,
  flowStubHits
} from './game';
import { hashState, type GameState } from './state';
import { emptyInput, type GameInput } from './ticcmd';
import { captureWorld, restoreWorld, type SaveSnapshot } from './pSaveg';
import { pRemoveMobj, pSpawnMobj, type Mobj } from './p_mobj';
import { pKillMobj } from './p_inter_damage';
import { evDoCeiling } from './pceilng';
import { evDoDoor } from './pdoors';
import { evDoPlat } from './pplats';
import { resetPlatFlatCopies } from './pplats';
import { CEIL, PLAT, VL } from './specials-table';
import { pRandom } from './prng';
import {
  captureLog,
  gameactionLog,
  registerCaptureSink,
  resetCaptureLog,
  resetGameactionLog,
  resetSfxStubLog,
  setPendingLoad,
  type CaptureEvent
} from './hooks';
import { CF_GODMODE, CF_NOCLIP } from './player';
import { attachPsprFields, WP_NOCHANGE } from './p_pspr';
import { initPlayerInventory } from './p_inter_inventory';

/* ------------------------------------------------------------------ */
/* Fixture                                                             */
/* ------------------------------------------------------------------ */

const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 }, // 0: player start
    { x: 256, y: 0, w: 256, h: 256, tag: 1 }, // 1: mover target
    { x: 512, y: 0, w: 256, h: 256, special: 17 }, // 2: fireflicker
    { x: 0, y: 256, w: 256, h: 256, special: 2 }, // 3: strobe (spawn draw)
    { x: 256, y: 256, w: 256, h: 256, special: 9 }, // 4: secret count
    { x: 512, y: 256, w: 256, h: 256, special: 1 } // 5: lightflash (draw)
  ],
  triggers: [
    // tagged trigger line on the room0/room1 shared edge (line index
    // resolved by tag at setup time).
    { x1: 256, y1: 64, x2: 256, y2: 192, tag: 1 }
  ],
  things: [
    { x: 64, y: 128, angle: 0, type: 1 },
    { x: 150, y: 60, type: 3004 }, // possessed (AI churn = P_Random draws)
    { x: 190, y: 200, type: 3004 },
    { x: 128, y: 160, type: 2045 }, // stimpack (item-respawn queue)
    { x: 48, y: 208, type: 2007 } // clip
  ]
};

const WAD = buildFixtureMapWad(SPEC);
const WAD_BUF = WAD.buffer.slice(
  WAD.byteOffset,
  WAD.byteOffset + WAD.byteLength
) as ArrayBuffer;

function scenarioMap(): RuntimeMap {
  return buildMapFromData(loadMap(WadFile.parse(WAD_BUF), 'FIXMAP'));
}

function boot(): GameState {
  return gInitGame(scenarioMap());
}

function taggedLine(s: GameState): number {
  const li = Array.from(s.map.lines.tag).findIndex((t) => t === 1);
  if (li < 0) throw new Error('fixture: no tag-1 line');
  return li;
}
function moverSector(s: GameState): number {
  const si = Array.from(s.sectors.tag).findIndex((t) => t === 1);
  if (si < 0) throw new Error('fixture: no tag-1 sector');
  return si;
}

const walkIn = (_i = 0): GameInput => {
  void _i;
  return { ...emptyInput(), forward: true };
};

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

function runIn(s: GameState, tics: number, input: (i: number) => GameInput): void {
  for (let i = 0; i < tics; i++) gTicker(s, input(i));
}

/** capture → fresh blank world → gInitNew + restoreWorld → identity. */
function restoreIntoBlank(snap: SaveSnapshot): GameState {
  const b = boot();
  gInitNew(b, snap.header.skill, snap.header.episode, snap.header.map);
  restoreWorld(b, snap);
  return b;
}

function expectIdentical(a: GameState, b: GameState): void {
  // 1. the superset observable.
  expect(hashState(b)).toBe(hashState(a));
  // 2. sector SoA + specialdata back-refs, elementwise.
  for (let i = 0; i < a.sectors.count; i++) {
    expect([
      ...b.sectors.floorZ.slice(i, i + 1),
      ...b.sectors.ceilingZ.slice(i, i + 1),
      ...b.sectors.light.slice(i, i + 1),
      ...b.sectors.special.slice(i, i + 1),
      ...b.sectors.tag.slice(i, i + 1)
    ]).toEqual([
      ...a.sectors.floorZ.slice(i, i + 1),
      ...a.sectors.ceilingZ.slice(i, i + 1),
      ...a.sectors.light.slice(i, i + 1),
      ...a.sectors.special.slice(i, i + 1),
      ...a.sectors.tag.slice(i, i + 1)
    ]);
    expect((b.sectors.specialData[i] as { id?: number } | null)?.id ?? null).toBe(
      (a.sectors.specialData[i] as { id?: number } | null)?.id ?? null
    );
  }
  // 3. thinker lists: live ids in arena order (ids ARE the hash position
  //    proxy — same ids, same order).
  const live = (s: GameState) =>
    [...s.thinkers.entries.values()].filter((t) => !t.removed).map((t) => t.id);
  expect(live(b)).toEqual(live(a));
  // 4. mobj roster: count + per-entry sampled fields (player back-refs and
  //    targets resolved by the same roster indices).
  expect(b.mobjs.mobjs.length).toBe(a.mobjs.mobjs.length);
  for (let i = 0; i < a.mobjs.mobjs.length; i++) {
    const ma = a.mobjs.mobjs[i]!;
    const mb = b.mobjs.mobjs[i]!;
    expect([mb.removed ? 1 : 0, mb.type, mb.x, mb.y, mb.z, mb.state, mb.tics,
      mb.health, mb.momx, mb.momy, mb.angle, mb.thinker.id,
      mb.target?.thinker.id ?? -1, mb.threshold, mb.movecount, mb.movedir,
      mb.reactionTime, mb.damage]).toEqual(
      [ma.removed ? 1 : 0, ma.type, ma.x, ma.y, ma.z, ma.state, ma.tics,
        ma.health, ma.momx, ma.momy, ma.angle, ma.thinker.id,
        ma.target?.thinker.id ?? -1, ma.threshold, ma.movecount, ma.movedir,
        ma.reactionTime, ma.damage]
    );
  }
  // 5. player structs (the non-hashed halves).
  for (let i = 0; i < a.players.length; i++) {
    const pa = a.players[i]!;
    const pb = b.players[i]!;
    expect(pb).not.toBe(pa);
    const snapP = (p: typeof pa) => JSON.stringify({
      playerstate: p.playerstate, health: p.health, cheats: p.cheats,
      cards: [...p.cards], viewz: p.viewz, viewheight: p.viewheight,
      bob: p.bob, kill: p.killcount, item: p.itemcount, // message excluded: p_saveg.c:96 NULLs it (never archived),
      psprites: attachPsprFields(p).psprites,
      ammo: [...attachPsprFields(p).ammo],
      powers: [...attachPsprFields(p).powers],
      weaponowned: [...attachPsprFields(p).weaponowned],
      ready: attachPsprFields(p).readyweapon,
      armor: (attachPsprFields(p) as unknown as { armorpoints: number }).armorpoints
    });
    expect(snapP(pb)).toBe(snapP(pa));
    expect(pb.mo.x).toBe(pa.mo.x);
    expect(pb.mo.y).toBe(pa.mo.y);
  }
  // 6. leveltime + secret counters + PRNG state + next-100 stream.
  expect(b.leveltime).toBe(a.leveltime);
  expect([b.totalsecret, b.secretcount, b.specialexit ? 1 : 0]).toEqual(
    [a.totalsecret, a.secretcount, a.specialexit ? 1 : 0]
  );
  expect(b.rng.rndindex).toBe(a.rng.rndindex);
  expect(b.rng.prndindex).toBe(a.rng.prndindex);
  const draws = (s: GameState): number[] => {
    const out: number[] = [];
    for (let k = 0; k < 100; k++) out.push(pRandom(s.rng));
    return out;
  };
  expect(draws(b)).toEqual(draws(a));
  expect(b.rng.prndindex).toBe(a.rng.prndindex);
}

function scenario(
  name: string, setupTics: number, setup: (s: GameState) => void,
  settleTics: number, input: (i: number) => GameInput = walkIn
): void {
  it(`${name}: capture→blank→restore identity`, () => {
    const a = boot();
    runIn(a, setupTics, input);
    setup(a);
    runIn(a, settleTics, input);

    const hashPre = hashState(a);
    const snap = captureWorld(a);
    expect(hashState(a)).toBe(hashPre); // capture purity (no world touch)

    expectIdentical(a, restoreIntoBlank(snap));
  });

  it(`${name}: 500-tic golden (save@T → restore → == original T..T+500)`, () => {
    // NOTE the strict ORDER: the module-level world binds (p_pspr/p_shoot/
    // pswitch bindPsprWorld-style singletons) are last-setup-wins, so the
    // two worlds must NEVER tick interleaved — a finishes its 500 BEFORE
    // b is booted (production is single-state; same rule here).
    const a = boot();
    runIn(a, setupTics, input);
    setup(a);
    runIn(a, settleTics, input);
    const hashPre = hashState(a);
    const snap = captureWorld(a);

    const ha: number[] = [];
    for (let k = 0; k < 10; k++) {
      runIn(a, 50, (i) => input(1000 + k * 50 + i));
      ha.push(hashState(a));
    }

    const b = restoreIntoBlank(snap);
    const hb: number[] = [];
    for (let k = 0; k < 10; k++) {
      runIn(b, 50, (i) => input(1000 + k * 50 + i));
      hb.push(hashState(b));
    }
    expect(hb).toEqual(ha);
    expect(hb[0]).not.toBe(hashPre); // the world actually moved
  });
}

beforeEach(() => {
  resetGameFlow();
  resetFlowStubHits();
  resetSaveFlow();
  resetCaptureLog();
  resetGameactionLog();
  resetSfxStubLog();
  resetPlatFlatCopies();
  registerCaptureSink(null);
  setPendingLoad(null);
  registerGameFlowHooks({ levelLoader: () => scenarioMap() });
});

/* ------------------------------------------------------------------ */
/* The scenario corpus (plan §M11-04 acceptance)                        */
/* ------------------------------------------------------------------ */

describe('M11-04 capture→restore identity battery', () => {
  scenario('mid-door-move', 20, (s) => {
    expect(evDoDoor(s, taggedLine(s), VL.close)).toBeTruthy();
  }, 15);

  scenario('plat-mid-travel', 20, (s) => {
    expect(evDoPlat(s, taggedLine(s), PLAT.downWaitUpStay, 0)).toBeTruthy();
  }, 12);

  scenario('crush-mid-travel', 20, (s) => {
    // movers + victims inside the tagged sector (crusher cadence draws
    // P_Random through the crush damage path).
    const sec = moverSector(s);
    void sec;
    pSpawnMobj(s.mobjs, (300 << 16), (64 << 16), 0, 1);
    pSpawnMobj(s.mobjs, (300 << 16), (128 << 16), 0, 1);
    expect(evDoCeiling(s, taggedLine(s), CEIL.crushAndRaise)).toBeTruthy();
  }, 40);

  scenario('fire-and-lights', 0, () => {
    /* pure light specials ticking (fireflicker/flash/strobe draws) */
  }, 60);

  scenario('corpse-field', 40, (s) => {
    const targets = s.mobjs.mobjs.filter(
      (m) => !m.removed && m.type === 1
    ) as Mobj[];
    expect(targets.length).toBeGreaterThanOrEqual(2);
    pKillMobj(null, targets[0]!);
    pKillMobj(null, targets[1]!);
    // removed item ⇒ roster tombstone + item-respawn queue entry
    const stim = s.mobjs.mobjs.find((m) => m.type === 31 && !m.removed);
    if (stim) pRemoveMobj(stim);
  }, 30);

  scenario('weapon-in-hand-powerups', 10, (s) => {
    const p = initPlayerInventory(attachPsprFields(s.players[0]!));
    p.weaponowned[2] = 1; // shotgun
    p.readyweapon = 2;
    p.pendingweapon = WP_NOCHANGE;
    p.ammo[1] = 21;
    p.powers[0] = 30; // invulnerability riding down
    p.powers[1] = 60; // invisibility
    p.cheats = CF_GODMODE | CF_NOCLIP;
    p.cards[0] = 1;
    p.cards[4] = 1;
    p.armorpoints = 150;
    p.armortype = 2;
  }, 10, (i) => ({ ...walkIn(i), attack: i % 20 < 3 }));

  scenario('secret-counts-tallies', 30, (s) => {
    expect(s.totalsecret).toBe(1); // the special-9 room counted at load
    s.secretcount = 2;
    s.players[0]!.killcount = 3;
    s.players[0]!.itemcount = 5;
  }, 10);

  scenario('projectiles-and-corpses', 30, (s) => {
    // shotgun shells mid-flight + a killed monster (death states ticking).
    const r = pSpawnMobj(s.mobjs, (150 << 16), (128 << 16), 48 << 16, 33);
    r.momx = 2097152;
    r.angle = 0;
    const victim = s.mobjs.mobjs.find((m) => m.type === 1 && !m.removed)!;
    pKillMobj(null, victim);
  }, 25);
});

/* ------------------------------------------------------------------ */
/* PRNG pins (§0.1)                                                    */
/* ------------------------------------------------------------------ */

describe('M11-04 PRNG pins', () => {
  it('load ⇒ the gInitNew M_ClearRandom stream: fresh-boot capture restores BYTE-IDENTICALLY to the reset stream', () => {
    // Capture at a fresh boot (vanilla truth: no mid-run draws happened),
    // so post-restore indices == the same fresh boot's == reset+load
    // draws, and the next-100 P_Random stream matches an independent boot.
    const a = boot();
    const snap = captureWorld(a);
    const b = restoreIntoBlank(snap);
    const c = boot();
    expect(b.rng.rndindex).toBe(a.rng.rndindex);
    expect(b.rng.rndindex).toBe(c.rng.rndindex);
    expect(b.rng.prndindex).toBe(c.rng.prndindex);
    const stream = (s: GameState): number[] => {
      const out: number[] = [];
      for (let k = 0; k < 100; k++) out.push(pRandom(s.rng));
      return out;
    };
    expect(stream(b)).toEqual(stream(c));
  });

  it('mid-run capture ⇒ the payload carries the stream (continuation after restore)', () => {
    const a = boot();
    runIn(a, 120, walkIn); // monster AI consumed P_Random
    expect(a.rng.prndindex).toBeGreaterThan(0);
    const snap = captureWorld(a);
    const b = restoreIntoBlank(snap);
    expect(b.rng.prndindex).toBe(a.rng.prndindex);
    expect(b.rng.rndindex).toBe(a.rng.rndindex);
  });
});

/* ------------------------------------------------------------------ */
/* game.ts drain integration (§0.3 two-stage deferral)                  */
/* ------------------------------------------------------------------ */

describe('M11-04 game.ts save/load branches', () => {
  it('sendsave chain: packs at tic N, drains at tic N+1 (vanilla timing), capture pure', () => {
    const a = boot();
    runIn(a, 30, walkIn);
    const hashAt = hashState(a);

    gSaveGame(3, 'mid-run test');
    // tic 1: build packs BT_SPECIAL|BTS_SAVEGAME|(3<<2), decode ARMS
    // gameaction after the drain slot ⇒ survives this tic.
    gTicker(a, walkIn(0));
    expect(a.players[0]!.cmd.buttons & 128).toBe(128);
    expect(a.gameaction).toBe(GA.savegame);
    const sink: CaptureEvent[] = [];
    registerCaptureSink((e) => sink.push(e));
    // tic 2: the drain executes G_DoSaveGame at the boundary.
    gTicker(a, walkIn(1));
    expect(a.gameaction).toBe(GA.nothing);
    expect(saveFlow.savesDone).toBe(1);
    expect(sink.length).toBe(1);
    expect(sink[0]!.kind).toBe('save');
    expect(sink[0]!.slot).toBe(3);
    expect(sink[0]!.description).toBe('mid-run test');
    expect(captureLog.entries[0]!.kind).toBe('save');
    // GGSAVED message (g_game.c:1318 / d_englsh.h:135)
    expect(a.hooks.message.byId?.get('GGSAVED')).toBe(1);
    // The save path never touched the world: continuing WITHOUT saving
    // hashes identically through both tics.
    const plain = boot();
    runIn(plain, 30, walkIn);
    expect(hashState(plain)).toBe(hashAt);
    gTicker(plain, walkIn(0));
    gTicker(plain, walkIn(1));
    expect(hashState(plain)).toBe(hashState(a));
    expect(gameactionLog.entries.some((e) => e.action === GA.savegame)).toBe(true);
  });

  it('the payload survives a JSON round-trip (persist codec path, D-11a)', () => {
    // persist's codec byte/DBP1 path serializes the payload — nothing in
    // SaveSnapshot may be live-object-only (typed arrays, Maps, fns).
    const a = boot();
    runIn(a, 60, walkIn);
    const snap = captureWorld(a);
    const wire = JSON.parse(JSON.stringify(snap)) as SaveSnapshot;
    expectIdentical(a, restoreIntoBlank(wire));
  });

  it('ga_loadgame drains the pending snapshot; one tic later == reference continuation', () => {
    const a = boot();
    runIn(a, 60, walkIn);
    const snap = captureWorld(a);
    gTicker(a, walkIn(60)); // reference continuation, one tic
    const cont = hashState(a);

    const b = boot();
    runIn(b, 10, walkIn); // live mid-run world gets replaced
    gRequestLoadGame(b, snap);
    expect(b.gameaction).toBe(GA.loadgame);
    gTicker(b, walkIn(60)); // drain executes G_DoLoadGame, then the tic ticks
    expect(b.gameaction).toBe(GA.nothing);
    expect(saveFlow.loadsDone).toBe(1);
    expect(hashState(b)).toBe(cont);
  });

  it('bad-format snapshot ⇒ typed load-rejected, silent state (vanilla bad-version lane)', () => {
    const s = boot();
    runIn(s, 10, walkIn);
    const hashPre = hashState(s);
    gRequestLoadGame(s, { format: 2 } as unknown as SaveSnapshot);
    gTicker(s, walkIn(0));
    expect(s.gameaction).toBe(GA.nothing);
    expect(saveFlow.loadsDone).toBe(0);
    expect(captureLog.entries[0]!.kind).toBe('load-rejected');
    // state moved exactly one plain tic (no reload happened)
    const c = boot();
    runIn(c, 10, walkIn);
    expect(hashPre).toBe(hashState(c));
    gTicker(c, walkIn(0));
    expect(hashState(s)).toBe(hashState(c));
  });

  it('empty pendingLoad drain ⇒ counted stub, no crash', () => {
    const s = boot();
    s.gameaction = GA.loadgame;
    gTicker(s, emptyInput());
    expect(s.gameaction).toBe(GA.nothing);
    expect(flowStubHits.byName.get('ga_loadgame-empty')).toBe(1);
  });

  it('in-game save→load round trip at a FIXED tic beats the original run', () => {
    // The M11 exit-line shape WITHOUT the persist layer: gSaveGame chain →
    // snapshot from the sink → gRequestLoadGame on the SAME state (after
    // the world drifted 300 tics) → 500-tic hash equality with the
    // uninterrupted run.
    const a = boot();
    runIn(a, 100, walkIn);
    const sink: CaptureEvent[] = [];
    registerCaptureSink((e) => sink.push(e));
    gSaveGame(0, 'golden');
    gTicker(a, walkIn(100)); // pack+arm
    gTicker(a, walkIn(101)); // drain ⇒ capture lands in sink
    const snap = sink[0]!.snapshot as SaveSnapshot;

    // 300 drifted tics, then the load drain — and the REFERENCE boots
    // only AFTER a is completely done (module world binds are
    // last-setup-wins; see the scenario helper note — a must never tick
    // while the reference's binds are live).
    runIn(a, 300, (i) => ({ ...walkIn(i), turnRight: i % 3 === 0 }));
    gRequestLoadGame(a, snap);
    gTicker(a, walkIn(100)); // the load drain ticks one tic too
    for (let k = 1; k < 500; k++) gTicker(a, walkIn(100 + k));
    const hashSaved = hashState(a);

    const reference = boot();
    // The two-phase save costs one world tic before the capture happens
    // (request tic packs, next tic drains) — the snapshot's world sits at
    // tic 101, so the reference replays 101 tics then the same 500.
    runIn(reference, 101, walkIn);
    for (let k = 0; k < 500; k++) gTicker(reference, walkIn(101 + k));
    expect(hashSaved).toBe(hashState(reference));
  });
});
