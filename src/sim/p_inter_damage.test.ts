// sim/p_inter_damage.test.ts — M8-05 acceptance (M8-plan §M8-05 + §0.2/0.3/0.5).
//
// Coverage (each pin names the 1.10 line it mirrors):
//  1. THE BRIDGE: the seven damageSlot sites record into the L2 log FIRST and
//     then dispatch (hooks.ts:168-186) — unresolvable slots and PLAYER
//     targets (deviation D-m1) stay record-only;
//  2. P_DamageMobj non-player body: the painChance roll happens on EVERY
//     non-fatal hit (p_inter.c:894 — MF_SKULLFLY suppresses the STATE, never
//     the draw), MF_JUSTHIT, and reactiontime = 0 (:897);
//  3. the generic retarget (:904-913): target = source, threshold =
//     BASETHRESHOLD, seestate only from spawnstate — plus its three exemptions
//     (threshold already spent, source is the VILE, source === target);
//  4. the KICK (p_inter.c:806-832). This is this port's whole "push" story:
//     1.10 p_map.c contains NO push routine (no P_PushMobs exists — grep
//     confirmed), so the only way one thing displaces another is this thrust.
//     Pinned here: the int32 thrust math (wrap included), the chainsaw
//     exemption, the NOCLIP exemption, the fall-forwards branch with its
//     DRAW GATE, the static-slot promotion the kick forces in this port, and
//     the NEGATIVE proof that nothing nearby gets shoved;
//  5. P_KillMobj: corpse flags/height, killcount bookkeeping (player source /
//     !netgame monster-on-monster / netgame silence), the gib rule (:719-724),
//     the `tics -= P_Random()&3` clamp (:726, exactly ONE draw), and the drop
//     table (:737-757 — CLIP/SHOTGUN/CHAINGUN only, MF_DROPPED, ONFLOORZ);
//  6. INTEGRATION with the merged M8-04 core: an infight retarget does not
//     merely remember the shooter — A_Chase then CHASES it;
//  7. determinism: in-process double runs + the boot-stable player thinker id
//     that lands in a monster's hash words[7].
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, beforeEach, expect, it } from 'vitest';

import { ANGLETOFINESHIFT, FRACUNIT } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MF, MT, mobjinfo } from '../wad/info/mobjinfo';
import { S, stateAt } from '../wad/info/states';

import { gInitGame } from './game';
import { buildMapFromData } from './map';
import { damageSlot } from './hooks';
import {
  asMobj,
  mobjFromSlot,
  ONFLOORZ,
  pRemoveMobj,
  pSetMobjState,
  pSpawnMobj,
  syncMobj,
  type Mobj,
} from './p_mobj';
import { hashState, type GameState, type Skill } from './state';
import { pRunThinkers } from './ptick';
import { RNDTABLE } from './prng';
import { pRadiusAttack } from './pradius';
import { pointToAngleOrigin } from './pslide';
import {
  BASETHRESHOLD,
  damageBridgeBody,
  installDamageBridge,
  pDamageMobj,
  pKillMobj,
  pSetDeathStateClamped,
} from './p_inter_damage';
import { aChase, pLookForPlayers, registerEnemyHooks } from './p_enemy';
import { resetActions } from './a_actions';
import { attachPsprFields, bindPsprWorld, WP_CHAINSAW, WP_PISTOL } from './p_pspr';
import { bindShootWorld, pLineAttack } from './p_shoot';
import { MISSILERANGE } from './p_mobj';

const fx = (n: number): number => (n * FRACUNIT) | 0;

function boot(spec: RectMapSpec, skill: Skill = 2): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), skill);
}

/** One 1024×512 room, player start west, everything else as map THINGS
 * (⇒ STATIC grid slots, exactly the load-time situation the promotion
 * bridge exists for). */
function room(things: RectMapSpec['things']): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 1024, h: 512, lightLevel: 200 }],
    things: [{ x: 64, y: 256, angle: 0, type: 1 }, ...(things ?? [])],
  };
}

function playerMo(s: GameState): Mobj {
  return asMobj(s.players[0]!.mo as never)!;
}

/** A map-THINGS monster (static slot, no spawn draws beyond the boot ones). */
function thing(s: GameState, type: number): Mobj {
  const m = s.mobjs.mobjs.find((mm) => mm.type === type && !mm.removed)!;
  expect(m).toBeDefined();
  return m;
}

/** A dynamically spawned monster (P_SpawnMobj draws ONE lastlook). */
function spawned(s: GameState, type: number, x: number, y: number): Mobj {
  const m = pSpawnMobj(s.mobjs, fx(x), fx(y), ONFLOORZ, type);
  m.lastLook = 0;
  return m;
}

/** P_Random draws consumed since `from` (the index wraps mod 256). */
const draws = (s: GameState, from: number): number => (s.rng.prndindex - from) & 0xff;

/** An index whose RNDTABLE value passes / fails a painChance bound. */
function indexWhere(pred: (v: number, i: number) => boolean): number {
  const k = RNDTABLE.findIndex(pred);
  expect(k).toBeGreaterThan(-1);
  return (k - 1) & 0xff; // pRandom PRE-increments: draw lands on k
}

/** p_inter.c:806-832 re-derived, int32 semantics included. */
function expectedKick(
  target: { x: number; y: number },
  inflictor: { x: number; y: number },
  damage: number,
  mass: number,
  flip = false
): { momx: number; momy: number } {
  let ang = pointToAngleOrigin((target.x - inflictor.x) | 0, (target.y - inflictor.y) | 0) >>> 0;
  let thrust = Math.trunc(Math.imul(Math.imul(damage, FRACUNIT >> 3), 100) / mass) | 0;
  if (flip) {
    ang = (ang + 0x80000000) >>> 0; // +ANG180 (fall forwards: kick INWARD)
    thrust = Math.imul(thrust, 4); // vanilla `thrust *= 4` (int32)
  }
  const fine = ang >>> ANGLETOFINESHIFT;
  return {
    momx: FixedMul(thrust, finecosine[fine]!) | 0,
    momy: FixedMul(thrust, finesine[fine]!) | 0,
  };
}

/** The damage-log slots a mobj has occupied (pre-promotion id aliased in). */
function hitsOn(s: GameState, m: Mobj) {
  return s.hooks.damage.entries.filter(
    (e) => e.thing === m.linkSlot || s.mobjs.slotMobjs.get(e.thing) === m
  );
}

// pSetMobjState runs the NEW state's action, verbatim (p_mobj.c:216-220), and
// the merged M8-04 core registers A_Look/A_Chase — so a bare
// "retarget → seestate" would cascade into a real attack chain (threshold--,
// A_Chase, missile state, activesound draws). The mechanics describes below
// therefore run with the action rows UNREGISTERED (the a_actions stub
// recorder counts the ids, the state lands exactly as P_SetMobjState set it);
// the integration describe re-registers them and asserts the cascade.
beforeEach(() => {
  resetActions();
});

/* ================================================================== */
/* 1. The bridge (hooks.ts wiring + deviations D-m1)                    */
/* ================================================================== */

describe('damage bridge — record first, then dispatch', () => {
  it('boot installs the body; install is idempotent', () => {
    const s = boot(room([]));
    expect(s.hooks.bridge.damageBridge).toBe(damageBridgeBody);
    installDamageBridge(s.hooks);
    expect(s.hooks.bridge.damageBridge).toBe(damageBridgeBody);
    installDamageBridge(s.hooks, null); // the uninstall path used by tests
    expect(s.hooks.bridge.damageBridge).toBeUndefined();
    installDamageBridge(s.hooks);
  });

  it('a site payload logs the entry AND moves the victim', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const victim = thing(s, MT.MT_POSSESSED);
    const before = victim.health;
    s.rng.prndindex = indexWhere((v) => v < mobjinfo[MT.MT_POSSESSED]!.painChance);
    damageSlot(s.hooks, victim.linkSlot, 15, playerMo(s).linkSlot, s.leveltime);
    expect(s.hooks.damage.count).toBe(1);
    expect(s.hooks.damage.entries[0]!.amount).toBe(15);
    expect(victim.health).toBe(before - 15); // 20 → 5, alive
    expect(victim.state).toBe(mobjinfo[MT.MT_POSSESSED]!.painState); // roll hit
  });

  it('an unresolvable slot (plain decor under a crusher) stays record-only', () => {
    const s = boot(room([]));
    expect(() => damageSlot(s.hooks, 4096, 10, null, s.leveltime)).not.toThrow();
    expect(s.hooks.damage.count).toBe(1);
  });

  it('D-m1: a PLAYER target keeps the pre-M8-05 record-only semantics', () => {
    const s = boot(room([]));
    const p = s.players[0]!;
    const mo = playerMo(s);
    const health = mo.health;
    damageSlot(s.hooks, mo.linkSlot, 50, null, s.leveltime);
    expect(s.hooks.damage.count).toBe(1);
    expect(mo.health).toBe(health);
    expect(p.health).toBe(100);
    expect(mo.state).toBe(mobjinfo[MT.MT_PLAYER]!.spawnState);
    // The body itself short-circuits on playerRef, whatever the payload:
    damageBridgeBody(mo as never, 50, undefined);
    expect(mo.health).toBe(health);
  });

  it('a dead target is a no-op (p_inter.c:790 `health <= 0`)', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const m = thing(s, MT.MT_POSSESSED);
    m.health = 0;
    const prnd = s.rng.prndindex;
    pDamageMobj(m, null, null, 10);
    expect(draws(s, prnd)).toBe(0);
    expect(m.state).toBe(mobjinfo[MT.MT_POSSESSED]!.spawnState);
  });

  it('a non-shootable target is a no-op (:775 `! (flags & MF_SHOOTABLE)`)', () => {
    const s = boot(room([]));
    const m = spawned(s, MT.MT_POSSESSED, 300, 256);
    m.flags = (m.flags & ~MF.MF_SHOOTABLE) | 0;
    const prnd = s.rng.prndindex;
    pDamageMobj(m, null, null, 10);
    expect(draws(s, prnd)).toBe(0);
    expect(m.health).toBe(mobjinfo[MT.MT_POSSESSED]!.spawnHealth);
  });
});

/* ================================================================== */
/* 2. Pain: the roll, the flag, the state                              */
/* ================================================================== */

describe('P_DamageMobj — pain state (p_inter.c:894-902)', () => {
  it('roll < painChance: MF_JUSTHIT + painstate + reactiontime 0, ONE draw', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const m = thing(s, MT.MT_POSSESSED);
    m.reactionTime = 8;
    s.rng.prndindex = indexWhere((v) => v < mobjinfo[MT.MT_POSSESSED]!.painChance);
    const before = s.rng.prndindex;
    pDamageMobj(m, null, null, 5);
    expect(draws(s, before)).toBe(1); // the roll is the ONLY draw
    expect(m.health).toBe(15);
    expect(m.state).toBe(mobjinfo[MT.MT_POSSESSED]!.painState);
    expect(m.flags & MF.MF_JUSTHIT).not.toBe(0);
    expect(m.reactionTime).toBe(0); // :897 "we're awake now..."
  });

  it('roll >= painChance: no state change, the DRAW still happens', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const m = thing(s, MT.MT_POSSESSED);
    s.rng.prndindex = indexWhere((v) => v >= mobjinfo[MT.MT_POSSESSED]!.painChance);
    const before = s.rng.prndindex;
    pDamageMobj(m, null, null, 5);
    expect(draws(s, before)).toBe(1);
    expect(m.state).toBe(mobjinfo[MT.MT_POSSESSED]!.spawnState);
    expect(m.flags & MF.MF_JUSTHIT).toBe(0);
    expect(m.reactionTime).toBe(0);
  });

  it('painChance 0 (barrel) still pays the roll — the draw is unconditional', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 2035 }]));
    const barrel = thing(s, MT.MT_BARREL);
    expect(mobjinfo[MT.MT_BARREL]!.painChance).toBe(0);
    const before = s.rng.prndindex;
    pDamageMobj(barrel, null, null, 5);
    expect(draws(s, before)).toBe(1);
    expect(barrel.state).toBe(mobjinfo[MT.MT_BARREL]!.spawnState);
  });

  it('MF_SKULLFLY suppresses the STATE, never the DRAW', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    imp.flags = (imp.flags | MF.MF_SKULLFLY) | 0;
    s.rng.prndindex = indexWhere((v) => v < mobjinfo[MT.MT_TROOP]!.painChance);
    const before = s.rng.prndindex;
    pDamageMobj(imp, null, null, 5);
    expect(draws(s, before)).toBe(1);
    expect(imp.state).toBe(mobjinfo[MT.MT_TROOP]!.spawnState);
    expect(imp.flags & MF.MF_JUSTHIT).toBe(0);
  });

  it('MF_SKULLFLY also zeroes momentum up front (:793-796)', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    imp.flags = (imp.flags | MF.MF_SKULLFLY) | 0;
    imp.momx = 12345;
    imp.momy = -54321;
    imp.momz = 999;
    pDamageMobj(imp, null, null, 5);
    expect([imp.momx, imp.momy, imp.momz]).toEqual([0, 0, 0]);
  });

  it('damage >= health kills instead: no pain roll is taken at all', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    const before = s.rng.prndindex;
    pDamageMobj(imp, null, null, 60);
    // one draw: P_KillMobj's tics clamp — NOT the painChance roll
    expect(draws(s, before)).toBe(1);
    expect(imp.state).toBe(mobjinfo[MT.MT_TROOP]!.deathState);
  });
});

/* ================================================================== */
/* 3. Retarget (:904-913                                              */
/* ================================================================== */

describe('P_DamageMobj — generic retarget', () => {
  it('infight: the victim turns on the shooter and pays BASETHRESHOLD', () => {
    const s = boot(room([
      { x: 300, y: 256, angle: 0, type: 3001 },
      { x: 700, y: 256, angle: 180, type: 3001 },
    ]));
    const a = thing(s, MT.MT_TROOP);
    const b = s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP)[1]!;
    pDamageMobj(a, b, b, 5);
    expect(a.target).toBe(b);
    expect(a.threshold).toBe(BASETHRESHOLD);
    expect(BASETHRESHOLD).toBe(100);
    // spawnstate → seestate ("change into one AS SOON AS POSSIBLE")
    expect(a.state).toBe(mobjinfo[MT.MT_TROOP]!.seeState);
  });

  it('threshold already spent (revenge target active) ⇒ no retarget', () => {
    const s = boot(room([
      { x: 300, y: 256, angle: 0, type: 3001 },
      { x: 700, y: 256, angle: 180, type: 3001 },
    ]));
    const a = thing(s, MT.MT_TROOP);
    const b = s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP)[1]!;
    a.threshold = 40;
    const target = playerMo(s);
    a.target = target;
    pDamageMobj(a, b, b, 5);
    expect(a.target).toBe(target);
    expect(a.threshold).toBe(40);
  });

  it('a VILE victim retargets EVEN with a threshold (the `|| type == MT_VILE`)', () => {
    const s = boot(room([
      { x: 300, y: 256, angle: 0, type: 64 },
      { x: 700, y: 256, angle: 180, type: 3001 },
    ]));
    const vile = thing(s, MT.MT_VILE);
    const b = thing(s, MT.MT_TROOP);
    vile.threshold = 40;
    pDamageMobj(vile, b, b, 5);
    expect(vile.target).toBe(b);
    expect(vile.threshold).toBe(BASETHRESHOLD);
  });

  it('a VILE source is never adopted (source->type != MT_VILE)', () => {
    const s = boot(room([
      { x: 300, y: 256, angle: 0, type: 3001 },
      { x: 700, y: 256, angle: 180, type: 64 },
    ]));
    const imp = thing(s, MT.MT_TROOP);
    const vile = thing(s, MT.MT_VILE);
    pDamageMobj(imp, vile, vile, 5);
    expect(imp.target).toBeUndefined();
    expect(imp.threshold).toBe(0);
  });

  it('self-inflicted damage does not retarget (source != target)', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    pDamageMobj(imp, imp, imp, 5);
    expect(imp.target).toBeUndefined();
    expect(imp.threshold).toBe(0);
  });

  it('source null (slime, crusher, hazard) ⇒ no retarget', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    pDamageMobj(imp, null, null, 5);
    expect(imp.target).toBeUndefined();
    expect(imp.threshold).toBe(0);
  });

  it('already in an attack state: target/threshold move, state does not', () => {
    const s = boot(room([
      { x: 300, y: 256, angle: 0, type: 3001 },
      { x: 700, y: 256, angle: 180, type: 3001 },
    ]));
    const a = thing(s, MT.MT_TROOP);
    const b = s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP)[1]!;
    pSetMobjState(a, mobjinfo[MT.MT_TROOP]!.missileState);
    const state = a.state;
    pDamageMobj(a, b, b, 5);
    expect(a.target).toBe(b);
    expect(a.threshold).toBe(BASETHRESHOLD);
    expect(a.state).toBe(state);
  });

  it('the retarget lands in the hash: words[7] is the new target thinker id', () => {
    const s = boot(room([
      { x: 300, y: 256, angle: 0, type: 3001 },
      { x: 700, y: 256, angle: 180, type: 3001 },
    ]));
    const a = thing(s, MT.MT_TROOP);
    const b = s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP)[1]!;
    syncMobj(a);
    const before = hashState(s);
    expect(a.words[7]).toBe(0);
    pDamageMobj(a, b, b, 5);
    syncMobj(a);
    expect(a.words[7]).toBe(b.thinker.id);
    expect(hashState(s)).not.toBe(before);
  });
});

/* ================================================================== */
/* 4. The kick (p_inter.c:806-832) — this port's only "push"            */
/* ================================================================== */

describe('P_DamageMobj — thrust / kick math', () => {
  it('kick AWAY from the inflictor, all four quadrants', () => {
    for (const [dx, dy] of [
      [-64, 0],
      [64, 0],
      [0, -64],
      [0, 64],
    ] as [number, number][]) {
      const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
      const imp = thing(s, MT.MT_TROOP);
      const inf = spawned(s, MT.MT_TROOP, 300 - dx, 256 - dy); // inflictor behind
      const prnd = s.rng.prndindex;
      pDamageMobj(imp, inf, inf, 15);
      const want = expectedKick(imp, inf, 15, mobjinfo[MT.MT_TROOP]!.mass);
      expect(imp.momx, `${dx},${dy}`).toBe(want.momx);
      expect(imp.momy, `${dx},${dy}`).toBe(want.momy);
      // no fall-forwards draw: same z
      expect(draws(s, prnd)).toBe(1);
      pRemoveMobjHelper(inf);
    }
  });

  it('magnitude = damage*(FRACUNIT>>3)*100/mass (mass 400 kicks 1/4 as hard)', () => {
    const s = boot(room([
      { x: 300, y: 256, angle: 0, type: 3001 },
      { x: 600, y: 256, angle: 0, type: 3005 },
    ]));
    const imp = thing(s, MT.MT_TROOP);
    const caco = thing(s, MT.MT_HEAD);
    const inf = spawned(s, MT.MT_TROOP, 236, 256);
    pDamageMobj(imp, inf, inf, 15);
    pDamageMobj(caco, inf, inf, 15);
    expect(mobjinfo[MT.MT_HEAD]!.mass).toBe(400);
    expect(caco.momx).toBe(expectedKick(caco, inf, 15, 400).momx);
    expect(caco.momx).not.toBe(imp.momx);
    // the thrust itself is the integer division by mass, not a /4 shortcut
    expect(Math.trunc(6144000 / 400)).toBe(15360);
    pRemoveMobjHelper(inf);
  });

  it('the int32 product wraps — telefrag-style 10000 damage kicks BACKWARD', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    imp.health = 1 << 20; // survive, so the kick is what we measure
    const inf = spawned(s, MT.MT_TROOP, 236, 256);
    pDamageMobj(imp, inf, inf, 10000);
    const raw = Math.trunc(Math.imul(Math.imul(10000, FRACUNIT >> 3), 100) / 100);
    expect(raw).toBeLessThan(0); // 10000*4096*100 overflows int32
    expect(Math.sign(imp.momx)).toBe(Math.sign(raw));
    pRemoveMobjHelper(inf);
  });

  it('MF_NOCLIP: no kick, damage and pain unchanged', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    imp.flags = (imp.flags | MF.MF_NOCLIP) | 0;
    const inf = spawned(s, MT.MT_TROOP, 236, 256);
    const prnd = s.rng.prndindex;
    pDamageMobj(imp, inf, inf, 15);
    expect([imp.momx, imp.momy]).toEqual([0, 0]);
    expect(draws(s, prnd)).toBe(1); // only the painChance roll
    pRemoveMobjHelper(inf);
  });

  it('no inflictor (crusher / hazard floor / slime) ⇒ no kick at all', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    const prnd = s.rng.prndindex;
    pDamageMobj(imp, null, null, 15);
    expect([imp.momx, imp.momy]).toEqual([0, 0]);
    expect(draws(s, prnd)).toBe(1);
  });

  it('the chainsaw exemption: a player in wp_chainsaw does not shove', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    const p = attachPsprFields(s.players[0]!);
    const mo = playerMo(s);
    p.readyweapon = WP_CHAINSAW;
    pDamageMobj(imp, mo, mo, 15);
    expect([imp.momx, imp.momy]).toEqual([0, 0]);
    // the very same geometry WITH another weapon does kick
    p.readyweapon = WP_PISTOL;
    pDamageMobj(imp, mo, mo, 15);
    expect(imp.momx).not.toBe(0);
  });

  it('fall forwards: z gap > 64, damage < 40 and > health ⇒ reverse + ×4 thrust', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    // The branch is `damage < 40 && damage > target->health` (PRE-damage
    // health — the kick block runs BEFORE the subtraction), i.e. it can only
    // ever fire on a killing blow under 40 points.
    imp.health = 10;
    const inf = spawned(s, MT.MT_TROOP, 236, 256);
    // z WITHOUT syncMobj: a static slot's z is grid-owned (syncMobj would
    // adopt the floor back), and the body only ever reads target.z.
    imp.z = fx(128); // the victim stands 128 units ABOVE the inflictor
    s.rng.prndindex = indexWhere((v) => (v & 1) === 1);
    const prnd = s.rng.prndindex;
    pDamageMobj(imp, inf, inf, 20);
    // fall-forwards roll + P_KillMobj's tics clamp; NO painChance roll (dead)
    expect(draws(s, prnd)).toBe(2);
    const want = expectedKick(imp, inf, 20, mobjinfo[MT.MT_TROOP]!.mass, true);
    expect(imp.momx).toBe(want.momx);
    expect(imp.momy).toBe(want.momy);
    // Reversed (ang + ANG180): the victim face-plants BACK toward the
    // inflictor instead of away from it (plain kick would be momx > 0).
    expect(Math.sign(imp.momx)).toBeLessThan(0);
    expect(Math.sign(expectedKick(imp, inf, 20, 100).momx)).toBeGreaterThan(0);
    expect(imp.state).toBe(mobjinfo[MT.MT_TROOP]!.deathState);
    pRemoveMobjHelper(inf);
  });

  it('the fall-forwards roll is DRAW-GATED: a small z gap costs nothing', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    const inf = spawned(s, MT.MT_TROOP, 236, 256);
    s.rng.prndindex = indexWhere((v) => (v & 1) === 1);
    const prnd = s.rng.prndindex;
    pDamageMobj(imp, inf, inf, 15);
    expect(draws(s, prnd)).toBe(1); // z gap 0 ⇒ the && short-circuits
    pRemoveMobjHelper(inf);
  });

  it('the kick promotes a static THINGS slot exactly once', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    const links = s.pmap.links;
    const old = imp.linkSlot;
    expect(old).toBeLessThan(links.staticCount); // load-time static binding
    const inf = spawned(s, MT.MT_TROOP, 236, 256);
    pDamageMobj(imp, inf, inf, 15);
    expect(imp.linkSlot).toBeGreaterThanOrEqual(links.staticCount);
    expect(links.flags[old]).toBe(0);
    expect(links.linked[old]).toBe(0);
    expect(mobjFromSlot(s.mobjs, imp.linkSlot)).toBe(imp);
    const slot = imp.linkSlot;
    const first = imp.momx;
    pDamageMobj(imp, inf, inf, 15); // second kick: no second promotion
    expect(imp.linkSlot).toBe(slot);
    expect(imp.momx).toBe((first * 2) | 0); // momentum accumulates (`+=`)
    pRemoveMobjHelper(inf);
  });

  it('PUSH TRUTH: nothing else nearby is shoved (1.10 has no P_PushMobs)', () => {
    const s = boot(room([
      { x: 300, y: 256, angle: 0, type: 3001 },
      { x: 332, y: 256, angle: 0, type: 3001 }, // 4 units from the radius edge
      { x: 300, y: 288, angle: 0, type: 3004 },
    ]));
    const [victim, beside, above] = [
      thing(s, MT.MT_TROOP),
      s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP)[1]!,
      thing(s, MT.MT_POSSESSED),
    ];
    for (const m of [beside, above]) {
      m.health = 1 << 20; // immortal, so only a real push could move it
    }
    for (const m of [victim, beside, above]) {
      m.health = 1 << 20; // survive: only a shove could show up
    }
    const snapshot = [beside, above].map((m) => [m.x, m.y, m.momx, m.momy, m.linkSlot]);
    damageSlot(s.hooks, victim.linkSlot, 30, beside.linkSlot, s.leveltime);
    expect([beside, above].map((m) => [m.x, m.y, m.momx, m.momy, m.linkSlot])).toEqual(snapshot);
    expect(victim.momx).not.toBe(0); // the victim itself IS kicked
    expect(s.hooks.damage.count).toBe(1); // ONE victim, no neighbour sweep
  });
});

/* ================================================================== */
/* 5. P_KillMobj                                                       */
/* ================================================================== */

describe('P_KillMobj — death, gibs, killcount, drops', () => {
  it('corpse bookkeeping: flags, height, deathstate, ONE clamp draw', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const m = thing(s, MT.MT_POSSESSED);
    const info = mobjinfo[MT.MT_POSSESSED]!;
    const prnd = s.rng.prndindex;
    pDamageMobj(m, null, null, info.spawnHealth);
    expect(m.health).toBe(0); // clamped to 0 by P_KillMobj? (see next pin)
    expect(m.flags & MF.MF_SHOOTABLE).toBe(0);
    expect(m.flags & MF.MF_CORPSE).not.toBe(0);
    expect(m.flags & MF.MF_DROPOFF).not.toBe(0);
    expect(m.flags & MF.MF_NOGRAVITY).toBe(0);
    expect(m.height).toBe(info.height >> 2);
    expect(m.state).toBe(info.deathState);
    expect(draws(s, prnd)).toBe(2); // clamp + the dropped clip's lastlook
  });

  it('the tics clamp is exactly ONE draw and floors at 1', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    for (const idx of [0, 37, 91, 200]) {
      imp.health = mobjinfo[MT.MT_TROOP]!.spawnHealth;
      imp.removed = false;
      s.rng.prndindex = (idx - 1) & 0xff;
      const prnd = s.rng.prndindex;
      pSetDeathStateClamped(imp);
      expect(draws(s, prnd)).toBe(1);
      // the clamp applies to the NEW (death) state's table tics
      expect(imp.state).toBe(mobjinfo[MT.MT_TROOP]!.deathState);
      expect(imp.tics).toBe(
        Math.max(1, stateAt(mobjinfo[MT.MT_TROOP]!.deathState).tics - (RNDTABLE[idx]! & 3))
      );
    }
  });

  it('gib rule: health < -spawnhealth AND xdeathstate ⇒ X DEATH', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const m = thing(s, MT.MT_POSSESSED);
    const info = mobjinfo[MT.MT_POSSESSED]!;
    expect(info.xdeathState).not.toBe(S.S_NULL);
    pDamageMobj(m, null, null, info.spawnHealth + 1 + 20);
    expect(m.health).toBeLessThan(-info.spawnHealth);
    expect(m.state).toBe(info.xdeathState);
  });

  it('no xdeathstate (VILE) ⇒ plain deathstate whatever the overkill', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 64 }]));
    const vile = thing(s, MT.MT_VILE);
    const info = mobjinfo[MT.MT_VILE]!;
    expect(info.xdeathState).toBe(0);
    pDamageMobj(vile, null, null, 100000);
    expect(vile.state).toBe(info.deathState);
  });

  it('drop table: POSS drops an MF_DROPPED clip at ONFLOORZ under the corpse', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const m = thing(s, MT.MT_POSSESSED);
    const before = s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_CLIP).length;
    pDamageMobj(m, null, null, 999);
    const clips = s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_CLIP);
    expect(clips.length).toBe(before + 1);
    const clip = clips[clips.length - 1]!;
    expect(clip.x).toBe(m.x);
    expect(clip.y).toBe(m.y);
    expect(clip.z).not.toBe(ONFLOORZ); // ONFLOORZ resolves to the floor
    expect(clip.flags & MF.MF_DROPPED).not.toBe(0);
    // MF_DROPPED reaches the hash: word[5] is the LINKS mirror, not the field
    syncMobj(clip);
    expect(clip.words[5]! & MF.MF_DROPPED).not.toBe(0);
  });

  it('drop table verbatim: SHOTGUY→shotgun, CHAINGUY→chaingun, nothing else', () => {
    const cases: [number, number | null][] = [
      [MT.MT_POSSESSED, MT.MT_CLIP],
      [MT.MT_SHOTGUY, MT.MT_SHOTGUN],
      [MT.MT_CHAINGUY, MT.MT_CHAINGUN],
      [MT.MT_TROOP, null],
      [MT.MT_HEAD, null],
      [MT.MT_SERGEANT, null],
      [MT.MT_VILE, null],
      [MT.MT_BARREL, null],
    ];
    for (const [type, item] of cases) {
      const doomednum = mobjinfo[type]!.doomednum;
      const s = boot(room(doomednum > 0 ? [{ x: 300, y: 256, angle: 0, type: doomednum }] : []));
      const m = doomednum > 0 ? thing(s, type) : spawned(s, type, 300, 256);
      const count = (t: number): number =>
        s.mobjs.mobjs.filter((mm) => mm.type === t && !mm.removed).length;
      const before = count(item ?? -1);
      const roster = s.mobjs.mobjs.length;
      pKillMobj(null, m);
      if (item === null) {
        expect(s.mobjs.mobjs.length, `MT ${type} drops nothing`).toBe(roster);
      } else {
        expect(count(item), `MT ${type} -> MT ${item}`).toBe(before + 1);
      }
    }
  });

  it('corpse flags reach the ThingLinks mirror (traces read links.flags)', () => {
    // PIT_CheckThing / the line-attack traverse read the GRID mirror
    // (pmap.ts:331 ← p_map.c's `th->flags`), and §3.4 word[5] hashes it.
    // A raw `mobj.flags` write here would leave a corpse SHOOTABLE to shots.
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const m = thing(s, MT.MT_POSSESSED);
    const links = s.pmap.links;
    expect(links.flags[m.linkSlot]! & MF.MF_SHOOTABLE).not.toBe(0);
    syncMobj(m);
    expect(m.words[5]! & MF.MF_SHOOTABLE).not.toBe(0);
    pKillMobj(null, m);
    expect(links.flags[m.linkSlot]! & MF.MF_SHOOTABLE).toBe(0);
    expect(links.flags[m.linkSlot]! & MF.MF_CORPSE).not.toBe(0);
    expect(links.flags[m.linkSlot]! & MF.MF_SOLID).not.toBe(0); // still solid!
    syncMobj(m);
    expect(m.words[5]! & MF.MF_SHOOTABLE).toBe(0);
  });

  it('shots fly OVER a corpse (p_map.c `!(th->flags & MF_SHOOTABLE)`)', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const victim = thing(s, MT.MT_POSSESSED);
    bindShootWorld(s);
    bindPsprWorld({ rng: s.rng, leveltime: s.leveltime });
    attachPsprFields(s.players[0]!);
    const p = playerMo(s);
    pLineAttack(p, 0, MISSILERANGE, 0, 7); // angle 0 = due EAST: a real hit
    expect(s.hooks.damage.count).toBe(1);
    pLineAttack(p, 0, MISSILERANGE, 0, 999); // kill it
    expect(s.hooks.damage.count).toBe(2);
    expect(victim.health).toBeLessThanOrEqual(0);
    const before = s.hooks.damage.count;
    pLineAttack(p, 0, MISSILERANGE, 0, 7); // corpse: the shot flies on
    expect(s.hooks.damage.count).toBe(before);
  });

  it('killcount: a player source counts the kill', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const m = thing(s, MT.MT_POSSESSED);
    const p = s.players[0]!;
    expect(m.flags & MF.MF_COUNTKILL).not.toBe(0);
    expect(p.killcount).toBe(0);
    pKillMobj(playerMo(s), m);
    expect(p.killcount).toBe(1);
  });

  it('killcount: monster-on-monster counts in SP, not in netgame', () => {
    const solo = boot(room([
      { x: 300, y: 256, angle: 0, type: 3001 },
      { x: 700, y: 256, angle: 180, type: 3001 },
    ]));
    const a = thing(solo, MT.MT_TROOP);
    const b = solo.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP)[1]!;
    expect(solo.mobjs.netgame).toBe(false);
    pKillMobj(b, a);
    expect(solo.players[0]!.killcount).toBe(1);

    const net = boot(room([
      { x: 300, y: 256, angle: 0, type: 3001 },
      { x: 700, y: 256, angle: 180, type: 3001 },
    ]));
    net.mobjs.netgame = true;
    const na = thing(net, MT.MT_TROOP);
    const nb = net.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP)[1]!;
    pKillMobj(nb, na);
    expect(net.players[0]!.killcount).toBe(0);
  });

  it('source null still counts the monster death (!netgame branch, :694-697)', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const m = thing(s, MT.MT_POSSESSED);
    pKillMobj(null, m);
    expect(s.players[0]!.killcount).toBe(1);
    // a non-COUNTKILL victim (barrel) is not counted
    const s2 = boot(room([]));
    const barrel = spawned(s2, MT.MT_BARREL, 300, 256);
    pKillMobj(null, barrel);
    expect(s2.players[0]!.killcount).toBe(0);
  });
});

/* ================================================================== */
/* 6. The seven sites, end to end                                      */
/* ================================================================== */

describe('damage sites — the log still lines up, and the body runs', () => {
  it('P_RadiusAttack: one log entry per victim, splash damage re-derived', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const dummy = thing(s, MT.MT_POSSESSED);
    dummy.health = 1 << 20;
    const blast = spawned(s, MT.MT_ROCKET, 260, 256);
    const before = dummy.health;
    const prnd = s.rng.prndindex;
    pRadiusAttack(s.mobjs, blast, playerMo(s), 128);
    expect(s.hooks.damage.count).toBe(1);
    expect(hitsOn(s, dummy)).toHaveLength(1);
    expect(s.hooks.damage.entries[0]!.amount).toBe(before - dummy.health);
    expect(dummy.health).toBeLessThan(before);
    expect(dummy.momx).not.toBe(0); // kicked away from the blast point
    // P_RadiusAttack itself draws NOTHING (fixed-point radius math,
    // p_map.c:1144-1194); the single draw is the victim's painChance roll.
    expect(draws(s, prnd)).toBe(1);
    pRemoveMobjHelper(blast);
  });

  it('a telefrag payload (10000 damage) kills through the bridge', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3004 }]));
    const victim = thing(s, MT.MT_POSSESSED);
    damageSlot(s.hooks, victim.linkSlot, 10000, playerMo(s).linkSlot, s.leveltime);
    expect(s.hooks.damage.count).toBe(1);
    expect(victim.health).toBeLessThanOrEqual(0);
    expect(victim.state).toBe(mobjinfo[MT.MT_POSSESSED]!.xdeathState); // gibbed
    expect(s.players[0]!.killcount).toBe(1);
  });

  it('crusher payload (source null) damages a monster without a kick', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    imp.health = 1 << 20;
    damageSlot(s.hooks, imp.linkSlot, 10, null, s.leveltime);
    expect(imp.momx).toBe(0);
    expect(imp.target).toBeUndefined();
    expect(imp.health).toBe((1 << 20) - 10);
  });
});

/* ================================================================== */
/* 7. Integration with the merged M8-04 core                            */
/* ================================================================== */

describe('infight end-to-end (damage → retarget → A_Chase really chases)', () => {
  beforeEach(() => {
    resetActions();
    registerEnemyHooks(); // the merged M8-04 core is LIVE here
  });

  it('the victim advances on the shooter instead of the player', () => {
    const s = boot(room([
      { x: 400, y: 256, angle: 0, type: 3001 },
      { x: 800, y: 256, angle: 180, type: 3001 },
    ]));
    const a = thing(s, MT.MT_TROOP);
    const b = s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP)[1]!;
    const player = playerMo(s);
    a.target = player; // it had the player
    a.threshold = 0;
    pDamageMobj(a, b, b, 5);
    expect(a.target).toBe(b);

    const startX = a.x;
    a.reactionTime = 0;
    for (let t = 0; t < 35; t++) {
      aChase(a);
      pRunThinkers(s.thinkers);
    }
    expect(a.target).toBe(b); // the target stuck
    expect(a.x).toBeGreaterThan(startX); // and it moved EAST, toward b
    expect(Math.abs(a.x - b.x)).toBeLessThan(Math.abs(startX - b.x));
  });

  it('A_Chase decays the threshold and the revenge rule re-arms', () => {
    const s = boot(room([
      { x: 400, y: 256, angle: 0, type: 3001 },
      { x: 800, y: 256, angle: 180, type: 3001 },
    ]));
    const a = thing(s, MT.MT_TROOP);
    const b = s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP)[1]!;
    pDamageMobj(a, b, b, 5);
    for (let t = 0; t < 40; t++) {
      aChase(a);
      pRunThinkers(s.thinkers);
    }
    expect(a.threshold).toBeLessThan(BASETHRESHOLD);
    const c = spawned(s, MT.MT_TROOP, 400, 64);
    // Threshold NOT yet spent ⇒ the revenge branch is skipped, b stays.
    a.threshold = 50;
    pDamageMobj(a, c, c, 5);
    expect(a.target).toBe(b);
    expect(a.threshold).toBe(50);
    // Spent ⇒ a fresh hit adopts the new attacker (the `!threshold` branch).
    a.threshold = 0;
    pDamageMobj(a, c, c, 5);
    expect(a.target).toBe(c);
    expect(a.threshold).toBe(BASETHRESHOLD);
    pRemoveMobjHelper(c);
  });

  it('a gunshot still routes through the same bookkeeping (noiseAlert path)', () => {
    const s = boot(room([{ x: 300, y: 256, angle: 0, type: 3001 }]));
    const imp = thing(s, MT.MT_TROOP);
    pLookForPlayers(imp, false);
    expect(imp.target).toBeUndefined();
    pDamageMobj(imp, playerMo(s), playerMo(s), 5);
    expect(imp.target).toBe(playerMo(s));
  });
});

/* ================================================================== */
/* 8. Determinism                                                      */
/* ================================================================== */

const DROPS = new Set<number>([MT.MT_POSSESSED, MT.MT_SHOTGUY, MT.MT_CHAINGUY]);

describe('determinism', () => {
  it('double in-process run: identical hash, prnd, and roster', () => {
    const spec = room([
      { x: 400, y: 256, angle: 0, type: 3001 },
      { x: 800, y: 256, angle: 180, type: 3001 },
      { x: 600, y: 320, angle: 90, type: 3004 },
    ]);
    const run = () => {
      const s = boot(spec);
      const imps = s.mobjs.mobjs.filter((mm) => mm.type === MT.MT_TROOP);
      const a = imps[0]!;
      const b = imps[1]!;
      const dummy = thing(s, MT.MT_POSSESSED);
      for (let t = 0; t < 60; t++) {
        pDamageMobj(dummy, playerMo(s), playerMo(s), 5);
        pDamageMobj(a, b, b, 5);
        pRunThinkers(s.thinkers);
      }
      for (const m of s.mobjs.mobjs) if (!m.removed) syncMobj(m);
      return {
        hash: hashState(s),
        prnd: s.rng.prndindex,
        rnd: s.rng.rndindex,
        kill: s.players[0]!.killcount,
        roster: s.mobjs.mobjs.map((m) => [m.type, m.linkSlot, m.health, m.state, m.removed]),
        dmg: s.hooks.damage.entries.map((e) => [e.tic, e.amount, e.source]),
      };
    };
    const x = run();
    const y = run();
    expect(x).toEqual(y);
    expect(x.hash).not.toBe(0);
  });

  it('the player thinker id in words[7] is boot-stable (no seq leak)', () => {
    const spec = room([{ x: 400, y: 256, angle: 0, type: 3001 }]);
    const once = () => {
      const s = boot(spec);
      const imp = thing(s, MT.MT_TROOP);
      pDamageMobj(imp, playerMo(s), playerMo(s), 5);
      syncMobj(imp);
      return { w7: imp.words[7], id: playerMo(s).thinker.id };
    };
    const a = once();
    const b = once();
    expect(a).toEqual(b);
    expect(a.w7).toBe(a.id);
  });

  it('pKillMobj never draws more than the clamp + a drop spawn', () => {
    for (const type of [MT.MT_POSSESSED, MT.MT_TROOP, MT.MT_SERGEANT]) {
      const s = boot(room([]));
      const m = spawned(s, type, 300, 256);
      m.health = 1;
      const prnd = s.rng.prndindex;
      pKillMobj(null, m);
      const info = mobjinfo[type]!;
      expect(draws(s, prnd), `MT ${type} doomednum ${info.doomednum}`).toBe(
        1 + (DROPS.has(type) ? 1 : 0)
      );
    }
  });
});

/* Helper: drop a probe mobj (an inflictor stand-in) out of the roster. */
function pRemoveMobjHelper(m: Mobj): void {
  pRemoveMobj(m);
}
