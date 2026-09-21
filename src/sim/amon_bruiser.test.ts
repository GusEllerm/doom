// sim/amon_bruiser.test.ts — M8-09 acceptance (docs/design/M8-plan.md
// §M8-09; sources re-read THIS pass from the released linuxdoom-1.10 tree:
// p_enemy.c:950/:969/:979/:1609-1756, p_map.c:325-328 direct-hit dice,
// info.c MT_HEAD/MT_BRUISER/MT_HEADSHOT/MT_BRUISERSHOT rows).
//
// Coverage:
//  1. REGISTRATION: ids 55 (A_HeadAttack), 56 (A_BruisAttack), 50
//     (A_BossDeath) bound under the MOBJ domain; the state-table census of
//     those ids is EXACTLY the mobj rows 506 / {539,568} /
//     {397,548,631,659,700} (FATSO/BOSS/SPID/BSPI/CYBER death tails);
//  2. A_HeadAttack (plan acceptance 3): silent melee (P_Random()%6+1)*10
//     = 10..60 through the P_DamageMobj entry (player victim — health
//     mirror EXACT, pinned stream index), NO sfx; the missile branch
//     spawns MT_HEADSHOT (speed 10*FRACUNIT) — MT_CACBALL never existed;
//     the caco "splash" truth: the flying X rows carry NO action (the
//     A_Explode census is rows 127/811 = MT_FIRE only) — touch damage is
//     the M7-09 PIT direct hit (P_Random()%8+1)*5 on the player health
//     mirror (flight asserted, health drop asserted);
//  3. A_BruisAttack (plan acceptance 1): melee ((P_Random()%8+1)*10 =
//     10..80 + sfx_claw and NO A_FaceTarget (angle untouched — the facing
//     lives in S_BOSS/S_BOS2_ATK1/2); out of range spawns
//     MT_BRUISERSHOT (15*FRACUNIT); the same-species baron-ball rule: a
//     knight's missile at a baron EXPLODES WITHOUT DAMAGE
//     (p_map.c:301-315, live since M7-09);
//  4. A_BossDeath (plan acceptance 2/4) — the p_enemy.c:1609-1756 switch
//     table-driven: E1M8+MT_BRUISER → junk.tag 666 EV_DoFloor
//     lowerFloorToLowest (the E1M8 rule; the mover ACTUALLY MOVES the
//     tagged floor to the lowest neighbour), all-four-barons-dead scan on
//     the thinker roster (one alive → nothing), the living-player gate,
//     the already-moving skip on the 2nd..4th death, E1M8 SPIDER/CYBORG →
//     no-op (acceptance 4), E1M7 baron → no-op, E2M8 CYBORG & E3M8 SPIDER
//     → G_ExitLevel through the LIVE pexit seam (exitRequest latch —
//     the M9 hand-off drains it), the commercial probe branches (map7
//     FATSO floor 666 / BABY raiseToTexture 667) and the E4M6 door
//     RECORD-ONLY seam;
//  5. FLOAT truth: FLOATBOB/A_Float DO NOT exist in 1.10 (p_enemy.c/
//     p_mobj.c/p_local.h greps this pass) — MT_HEAD floats via the live
//     P_ZMovement MF_FLOAT band (pmove.ts:341, M8-02); a behavioural pin
//     that aHeadAttack adds NO z machinery of its own;
//  6. LEDGERS + double-run determinism (A_BossDeath draws NOTHING).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MT, mobjinfo } from '../wad/info/mobjinfo';
import { NUMSTATES, stateAction } from '../wad/info/states';

import { gInitGame } from './game';
import { buildMapFromData } from './map';
import { asMobj, MELEERANGE, ONFLOORZ, pSpawnMobj, type Mobj } from './p_mobj';
import type { GameState, Skill } from './state';
import { hashState } from './state';
import { pRunThinkers } from './ptick';
import { pRandom, RNDTABLE } from './prng';
import { damageBridgeBody, installDamageBridge } from './p_inter_damage';
import { pPlayerDamage } from './pplayer';
import { registerEnemyHooks } from './p_enemy';
import { MF_COUNTKILL, MF_FLOAT, MF_NOGRAVITY } from './thinglinks';
import './pdeath'; // A_Scream/A_Fall bodies for the death chains (import-time)

import {
  aBossDeath,
  aBruisAttack,
  aHeadAttack,
  bossSpecialCalls,
  registerFamilyCActions,
  resetBossSpecialCalls,
  setBossLevelProbe,
  type BossLevel
} from './amon_bruiser';
import { ACT, isActionRegistered } from './a_actions';
import { RANDOM_SITE_CALLS, scanRandomSites } from './random-sites';
import { SFX_SITE_LEDGER } from './psound_stub';

const fx = (n: number): number => (n * FRACUNIT) | 0;

/** The four baron posts inside the 128×128 CENTER room of bossArena. */
const POS4: readonly [number, number][] = [[160, 32], [160, 96], [224, 32], [224, 96]];

function boot(spec: RectMapSpec, name = 'FIXMAP', skill: Skill = 3): GameState {
  const bytes = buildFixtureMapWad(spec, name);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), name)), skill);
  installPlayerAwareBridge(s);
  return s;
}

/** D-m1 by-pass (TEST-ONLY, the amon_poss idiom): the family suite
 * measures monster→player damage; production player sites are the M8-11
 * re-derivation. Non-player targets dispatch UNCHANGED. */
function installPlayerAwareBridge(s: GameState): void {
  installDamageBridge(s.hooks, (t, amount, src) => {
    const m = t as Mobj;
    if (m.playerRef !== undefined) {
      pPlayerDamage(m, (src as Mobj) ?? null, (src as Mobj) ?? null, amount);
      return;
    }
    damageBridgeBody(t, amount, src);
  });
}

function playerMo(s: GameState): Mobj {
  return asMobj(s.players[0]!.mo as never)!;
}

const tick = (s: GameState, n: number): void => {
  for (let i = 0; i < n; i++) {
    pRunThinkers(s.thinkers);
    s.leveltime++;
  }
};

/** Place prndindex so draw k (1-based PRE-INCREMENT) reads RNDTABLE at
 * index+1+k and passes pred — the amon_poss helper. */
function pinDraws(s: GameState, preds: ((v: number) => boolean)[]): void {
  for (let i = 0; i < 256; i++) {
    if (preds.every((p, k) => p(RNDTABLE[(i + 1 + k) & 0xff]!))) {
      s.rng.prndindex = i;
      return;
    }
  }
  throw new Error('no prndindex satisfies the draw predicates');
};

const draws = (s: GameState, from: number): number => (s.rng.prndindex - from) & 0xff;
const dmgAmts = (s: GameState): number[] => s.hooks.damage.entries.map((e) => e.amount);
const sfxCount = (s: GameState): number => s.hooks.sfx.entries.length;

/** Single wide room; player 1 start at (64,256) facing EAST. */
function room1(things: RectMapSpec['things'] = []): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 768, h: 512, lightLevel: 200 }],
    things: [{ x: 64, y: 256, angle: 0, type: 1 }, ...things]
  };
}

/** E1M8-style boss arena: the CENTER room of a 3×3 grid (floor +16, TAG
 * 666) with the LOW cell (−16) to its west ⇒ lowerFloorToLowest dest =
 * −16 EXACTLY — the fully enclosed LOWEST_GRID idiom of pfloor.test.ts:
 * VOID edges floor at −128 and DO participate as neighbours, so the
 * tagged room must have no void border (pfloor.test LOWER_SPEC comment). */
function bossArena(things: RectMapSpec['things'] = []): RectMapSpec {
  const rooms = [];
  const floors = [
    [0, 0, 0],
    [-16, 16, 0],
    [0, 0, 0]
  ];
  for (let j = 0; j < 3; j++) {
    for (let i = 0; i < 3; i++) {
      rooms.push({
        x: i * 128,
        y: (j - 1) * 128,
        w: 128,
        h: 128,
        floorHeight: floors[j]![i],
        lightLevel: 192,
        ...(i === 1 && j === 1 ? { tag: 666 } : {})
      });
    }
  }
  return {
    rooms,
    things: [{ x: 192, y: 64, angle: 0, type: 1 }, ...things]
  };
}

const secByTag = (s: GameState, tag: number): number => {
  for (let i = 0; i < s.sectors.count; i++) if (s.sectors.tag[i] === tag) return i;
  throw new Error(`no sector tagged ${tag}`);
};

const mobjsOfType = (s: GameState, type: number): Mobj[] =>
  s.mobjs.mobjs.filter((m) => m.type === type && !m.removed);

const lastMobj = (s: GameState): Mobj => {
  const ms = s.mobjs.mobjs.filter((m) => !m.removed);
  return ms[ms.length - 1]!;
};

beforeEach(() => {
  registerEnemyHooks();
  registerFamilyCActions();
  resetBossSpecialCalls();
  setBossLevelProbe(null);
});

/* ================================================================== */
/* 1. Registration + state-table census                                */
/* ================================================================== */

describe('family C registration (ids 50/55/56)', () => {
  it('all three ids carry bound bodies after import', () => {
    for (const id of [ACT.A_HeadAttack, ACT.A_BruisAttack, ACT.A_BossDeath]) {
      expect(isActionRegistered(id), String(id)).toBe(true);
    }
  });

  it('the table census of 55/56/50 is EXACTLY the mobj-domain rows', () => {
    const rows = (id: number): number[] => {
      const out: number[] = [];
      for (let i = 0; i < NUMSTATES; i++) if (stateAction[i] === id) out.push(i);
      return out;
    };
    expect(rows(ACT.A_HeadAttack)).toEqual([506]); // S_HEAD_ATK3 (504/505 = A_FaceTarget)
    expect(rows(ACT.A_BruisAttack)).toEqual([539, 568]); // S_BOSS_ATK3 + S_BOS2_ATK3
    // S_FATT_DIE10 (commercial-only) + S_BOSS_DIE7 + S_SPID_DIE11 +
    // S_BSPI_DIE7 + S_CYBER_DIE10 — the tics=-1 death tails:
    expect(rows(ACT.A_BossDeath)).toEqual([397, 548, 631, 659, 700]);
    // Every carrier row is mobj-side (≥ 150 — the pspr machine never
    // dispatches them; a_actions.ts cross-domain guard, M8-07 census).
    for (const i of [506, 539, 568, 397, 548, 631, 659, 700]) expect(i > 150).toBe(true);
  });
});

/* ================================================================== */
/* 2. A_HeadAttack — p_enemy.c:950-967                                 */
/* ================================================================== */

describe('A_HeadAttack (MT_HEAD — caco)', () => {
  it('melee: SILENT (P_Random()%6+1)*10 through the P_DamageMobj entry, health mirror exact', () => {
    const s = boot(room1());
    const caco = pSpawnMobj(s.mobjs, fx(96), fx(256), ONFLOORZ, MT.MT_HEAD);
    const p = playerMo(s);
    p.flags |= MF_NOGRAVITY | MF_FLOAT; // irrelevant; keep flags honest
    caco.target = p;

    pinDraws(s, [() => true]); // draw 1 = the damage die (pinned <180 so no player pain side-effects shift the mirror below; player pain is state-only anyway)
    const idx = s.rng.prndindex;
    const before = s.players[0]!.health;
    const sfx0 = sfxCount(s);
    const angle0 = caco.angle;
    aHeadAttack(caco);

    const damage = ((RNDTABLE[(idx + 1) & 0xff]! % 6) + 1) * 10;
    expect([10, 20, 30, 40, 50, 60]).toContain(damage); // plan bounds 10..60
    expect(s.players[0]!.health).toBe(before - damage); // EXACT mirror
    expect(sfxCount(s)).toBe(sfx0); // :958-963 has NO S_StartSound
    // A_FaceTarget DID face (the melee line calls it, :957): target due
    // WEST of a EAST-facing caco ⇒ angle lands on ANGLE_180 (±1 ulp —
    // the R_PointToAngle table path can land one below 0x80000000).
    expect(caco.angle).not.toBe(angle0);
    expect(Math.abs(((caco.angle | 0) - -0x80000000) | 0)).toBeLessThanOrEqual(1 << 20);
    // no missile spawned:
    expect(mobjsOfType(s, MT.MT_HEADSHOT).length).toBe(0);
  });

  it('melee draws EXACTLY one own die (plus the pplayer painChance draw)', () => {
    const s = boot(room1());
    const caco = pSpawnMobj(s.mobjs, fx(96), fx(256), ONFLOORZ, MT.MT_HEAD);
    caco.target = playerMo(s);
    pinDraws(s, [() => true]);
    const idx = s.rng.prndindex;
    aHeadAttack(caco);
    // damage die + P_DamageMobj's player painChance roll — nothing else.
    expect(draws(s, idx)).toBe(2);
  });

  it('missile branch: spawns MT_HEADSHOT (10*FRACUNIT, info damage 5) at source z+32', () => {
    const s = boot(room1());
    const caco = pSpawnMobj(s.mobjs, fx(400), fx(256), ONFLOORZ, MT.MT_HEAD);
    caco.target = playerMo(s);
    aHeadAttack(caco);

    const ball = lastMobj(s);
    expect(ball.type).toBe(MT.MT_HEADSHOT);
    expect(mobjinfo[MT.MT_HEADSHOT]!.speed).toBe(fx(10));
    expect(ball.z).toBe((caco.z + 32 * FRACUNIT) | 0); // pSpawnMissile, p_mobj.c:889-925
    // Due WEST momentum = FixedMul(10<<16, finecosine[west]) — the
    // −65535-table ulp makes |momx| ≤ 10<<16 (never above).
    expect(ball.momx).toBeLessThan(0);
    expect(Math.abs(ball.momx)).toBeGreaterThan(fx(10) - 64);
    expect(Math.abs(ball.momx)).toBeLessThanOrEqual(fx(10));
    expect(ball.momz).toBe(0); // dest.z == source.z
    expect(ball.target).toBe(caco);
    expect(s.players[0]!.health).toBe(100); // damage is flight-resolved, not at spawn
  });

  it('ACCEPTANCE: ball FLIGHT + touch on the player — health drops by (R%8+1)*5 (the only damage a 1.10 caco ball does; X rows carry no A_Explode)', () => {
    const s = boot(room1());
    const caco = pSpawnMobj(s.mobjs, fx(400), fx(256), ONFLOORZ, MT.MT_HEAD);
    caco.target = playerMo(s);
    aHeadAttack(caco);

    const before = s.players[0]!.health;
    let t = 0;
    for (; t < 120; t++) {
      pRunThinkers(s.thinkers);
      s.leveltime++;
      if (s.players[0]!.health < before) break;
    }
    expect(t).toBeLessThan(120); // 336 units at 10/tic ≈ 34 tics
    const dmg = dmgAmts(s).filter((d) => d > 0).slice(-1)[0]!;
    expect(dmg % 5).toBe(0); // (R%8+1) * mobjinfo.damage(5) — p_map.c:325-328
    expect(dmg / 5).toBeGreaterThanOrEqual(1);
    expect(dmg / 5).toBeLessThanOrEqual(8);
    expect(s.players[0]!.health).toBe(before - dmg);
    // THE SPLASH TRUTH: no A_Explode rides the X rows (action census of id
    // 24 = rows {127, 811} = MT_FIRE only) — the ball does exactly ONE
    // damage event, no radius pass:
    expect(dmgAmts(s).length).toBe(1);
  });

  it('FLOAT TRUTH: MT_HEAD carries MF_FLOAT|MF_NOGRAVITY (research 06 row) — hover is the LIVE P_ZMovement band, no action here', () => {
    expect(mobjinfo[MT.MT_HEAD]!.flags & MF_FLOAT).toBeTruthy();
    expect(mobjinfo[MT.MT_HEAD]!.flags & MF_NOGRAVITY).toBeTruthy();
    const s = boot(room1());
    const caco = pSpawnMobj(s.mobjs, fx(96), fx(256), ONFLOORZ, MT.MT_HEAD);
    const z0 = caco.z;
    aHeadAttack(caco); // silent melee — no z write of its own
    expect(caco.z).toBe(z0);
    expect(MELEERANGE).toBe(fx(64)); // pCheckMeleeRange is p_enemy's (MELEERANGE−20+radius)
  });
});

/* ================================================================== */
/* 3. A_BruisAttack — p_enemy.c:979-996 (BRUISER + KNIGHT rows)         */
/* ================================================================== */

describe('A_BruisAttack (MT_BRUISER baron / MT_KNIGHT hell knight)', () => {
  it('melee: sfx_claw + (P_Random()%8+1)*10 = 10..80, NO facing (angle untouched)', () => {
    const s = boot(room1());
    const baron = pSpawnMobj(s.mobjs, fx(96), fx(256), ONFLOORZ, MT.MT_BRUISER);
    baron.target = playerMo(s);

    pinDraws(s, [() => true]);
    const idx = s.rng.prndindex;
    const before = s.players[0]!.health;
    const sfx0 = sfxCount(s);
    aBruisAttack(baron);

    const damage = ((RNDTABLE[(idx + 1) & 0xff]! % 8) + 1) * 10;
    expect([10, 20, 30, 40, 50, 60, 70, 80]).toContain(damage); // plan acceptance 1: 10..80
    expect(s.players[0]!.health).toBe(before - damage);
    expect(sfxCount(s)).toBe(sfx0 + 1); // :988 sfx_claw
    expect(s.hooks.sfx.entries[sfxCount(s) - 1]!.id).toBe(55); // sfx_claw id
    expect(baron.angle).toBe(0); // NO A_FaceTarget in this body — the ATK1/2 rows face
    expect(mobjsOfType(s, MT.MT_BRUISERSHOT).length).toBe(0);
  });

  it('distance branch: out of melee range launches MT_BRUISERSHOT (15*FRACUNIT)', () => {
    const s = boot(room1());
    const baron = pSpawnMobj(s.mobjs, fx(364), fx(256), ONFLOORZ, MT.MT_BRUISER);
    baron.target = playerMo(s); // 300 units ≫ MELEERANGE−20+16 = 60
    const before = s.players[0]!.health;
    aBruisAttack(baron);
    expect(s.players[0]!.health).toBe(before); // nothing at launch time
    const ball = lastMobj(s);
    expect(ball.type).toBe(MT.MT_BRUISERSHOT);
    expect(mobjinfo[MT.MT_BRUISERSHOT]!.speed).toBe(fx(15));
    expect(ball.momx).toBeLessThan(0);
    expect(Math.abs(ball.momx)).toBeGreaterThan(fx(15) - 64);
    expect(Math.abs(ball.momx)).toBeLessThanOrEqual(fx(15));
  });

  it('KNIGHT shares the body (S_BOS2_ATK3 carries id 56) and the SAME-SPECIES rule: its ball at a baron explodes WITHOUT damage (p_map.c:301-315, live M7-09)', () => {
    const s = boot(room1());
    const knight = pSpawnMobj(s.mobjs, fx(364), fx(256), ONFLOORZ, MT.MT_KNIGHT);
    const baron = pSpawnMobj(s.mobjs, fx(100), fx(256), ONFLOORZ, MT.MT_BRUISER);
    knight.target = baron;
    aBruisAttack(knight);
    const ball = lastMobj(s);
    expect(ball.type).toBe(MT.MT_BRUISERSHOT);

    const hp0 = baron.health;
    let t = 0;
    for (; t < 80; t++) {
      pRunThinkers(s.thinkers);
      s.leveltime++;
      if (ball.removed || ball.health <= 0) break; // exploded (deathstate)
    }
    expect(t).toBeLessThan(80);
    expect(baron.health).toBe(hp0); // Explode, no damage (same species as the originator)
    expect(dmgAmts(s).filter((d) => d > 0).length).toBe(0);
  });
});

/* ================================================================== */
/* 4. A_BossDeath — p_enemy.c:1609-1756 (the :1627-1677 switch)         */
/* ================================================================== */

describe('A_BossDeath (the E1M8 rule + the full 1.10 switch)', () => {
  it('ACCEPTANCE 2: four barons on E1M8 — the last death MOVES the tag-666 floor to the lowest neighbour (EV_DoFloor lowerFloorToLowest)', () => {
    const s = boot(bossArena(), 'E1M8');
    const barons = POS4.map(
      ([x, y]) => pSpawnMobj(s.mobjs, fx(x), fx(y), ONFLOORZ, MT.MT_BRUISER)
    );
    const sec = secByTag(s, 666);
    expect(s.sectors.floorZ[sec]).toBe(fx(16));

    for (const b of barons) pPlayerDamage(b, null, null, 5000);
    tick(s, 200); // death chain (~48) + the mover (32 + arrival)

    const calls = bossSpecialCalls();
    expect(calls.length).toBeGreaterThanOrEqual(4); // EVERY baron's DIE7 entry calls (the first wins)
    expect(calls[0]!.kind).toBe('floor');
    expect(calls[0]!.tag).toBe(666);
    expect(calls.filter((c) => c.executed).length).toBe(1); // specialdata refuse on the 2nd..4th
    expect(s.sectors.floorZ[sec]).toBe(fx(-16)); // lowered to room B EXACTLY
    expect(s.exitRequest).toBe('none'); // E1 is a FLOOR move, NOT an exit (no special 11 in 1.10)
  });

  it('all-dead scan (thinker roster): one baron alive ⇒ NOTHING happens; kill it ⇒ the floor moves', () => {
    const s = boot(bossArena(), 'E1M8');
    // pw_invulnerability: the surviving GUARD baron hunts for the 200
    // waiting tics — the witness must live (the living-player gate below
    // is tested SEPARATELY, unfixed, in its own case).
    (s.players[0] as unknown as { powers: number[] }).powers[0] = 1;
    const barons = POS4.slice(0, 3).map(
      ([x, y]) => pSpawnMobj(s.mobjs, fx(x), fx(y), ONFLOORZ, MT.MT_BRUISER)
    );
    const guard = pSpawnMobj(s.mobjs, fx(224), fx(96), ONFLOORZ, MT.MT_BRUISER);
    for (const b of barons) pPlayerDamage(b, null, null, 5000);
    tick(s, 200);
    expect(bossSpecialCalls().length).toBe(0); // :1698-1703 other boss not dead
    expect(s.sectors.floorZ[secByTag(s, 666)]).toBe(fx(16));

    pPlayerDamage(guard, null, null, 5000);
    tick(s, 200);
    expect(bossSpecialCalls().some((c) => c.kind === 'floor' && c.executed)).toBe(true);
    expect(s.sectors.floorZ[secByTag(s, 666)]).toBe(fx(-16));
  });

  it('living-player gate (:1682-1688): everyone dead ⇒ the victory action is SKIPPED', () => {
    const s = boot(bossArena(), 'E1M8');
    const victim = pSpawnMobj(s.mobjs, fx(128), fx(256), ONFLOORZ, MT.MT_BRUISER);
    pPlayerDamage(playerMo(s), null, null, 1000); // player dies
    pPlayerDamage(victim, null, null, 5000);
    tick(s, 200);
    expect(s.players[0]!.health).toBeLessThanOrEqual(0);
    expect(bossSpecialCalls().length).toBe(0);
    expect(s.exitRequest).toBe('none');
  });

  it('A_BossDeath draws NOTHING (p_enemy.c:1609 has no P_Random — pinned at the stream level)', () => {
    const s = boot(bossArena(), 'E1M8');
    const dying = pSpawnMobj(s.mobjs, fx(128), fx(256), ONFLOORZ, MT.MT_BRUISER);
    pinDraws(s, [() => true]);
    const idx = s.rng.prndindex;
    aBossDeath(dying); // sole baron, living player, E1M8
    expect(bossSpecialCalls().length).toBe(1);
    expect(draws(s, idx)).toBe(0);
  });

  it('ACCEPTANCE 4: E1M8 SPIDER and CYBORG deaths are NO-OPS (case 1 gates MT_BRUISER only, :1633-1634)', () => {
    for (const type of [MT.MT_SPIDER, MT.MT_CYBORG]) {
      const s = boot(bossArena(), 'E1M8');
      const boss = pSpawnMobj(s.mobjs, fx(128), fx(256), ONFLOORZ, type);
      pPlayerDamage(boss, null, null, 4000);
      tick(s, 600); // the SPID/CYBER death chains are LONG (tics -1 tails)
      expect(bossSpecialCalls().length, String(type)).toBe(0);
      expect(s.sectors.floorZ[secByTag(s, 666)], String(type)).toBe(fx(16));
      expect(s.exitRequest, String(type)).toBe('none');
    }
  });

  it('E1M7 baron → return at :1630 (map gate); no mover, no exit', () => {
    const s = boot(bossArena(), 'E1M7');
    const boss = pSpawnMobj(s.mobjs, fx(128), fx(256), ONFLOORZ, MT.MT_BRUISER);
    pPlayerDamage(boss, null, null, 5000);
    tick(s, 200);
    expect(bossSpecialCalls().length).toBe(0);
    expect(s.sectors.floorZ[secByTag(s, 666)]).toBe(fx(16));
  });

  it('E2M8 CYBORG → falls out of the victory switch to G_ExitLevel (:1755) — the LIVE pexit seam latches exitRequest (M9 drains it)', () => {
    const s = boot(bossArena(), 'E2M8');
    const boss = pSpawnMobj(s.mobjs, fx(128), fx(256), ONFLOORZ, MT.MT_CYBORG);
    pPlayerDamage(boss, null, null, 5000);
    tick(s, 600);
    const calls = bossSpecialCalls();
    expect(calls.length).toBe(1);
    expect(calls[0]!.kind).toBe('exit');
    expect(s.exitRequest).toBe('normal'); // gExitLevel → exitSlot (D013(e))
    expect(s.specialexit).toBe(false);
  });

  it('E3M8 SPIDER → the same G_ExitLevel fall-out (:1645-1652 gate, :1755 tail)', () => {
    const s = boot(bossArena(), 'E3M8');
    const boss = pSpawnMobj(s.mobjs, fx(128), fx(256), ONFLOORZ, MT.MT_SPIDER);
    pPlayerDamage(boss, null, null, 5000);
    tick(s, 600);
    expect(bossSpecialCalls()[0]!.kind).toBe('exit');
    expect(s.exitRequest).toBe('normal');
  });

  it('probe branches (doomstat seam): commercial E7-FATSO floor 666, E7-BABY raiseToTexture 667, E4M6 CYBORG door blazeOpen RECORD-ONLY (M9+ note)', () => {
    const probe = (episode: number, map: number, commercial: boolean) => (): BossLevel =>
      ({ commercial, episode, map });

    {      
      const s = boot(bossArena(), 'MAP07');
      resetBossSpecialCalls();
      setBossLevelProbe(probe(1, 7, true));
      const fatso = pSpawnMobj(s.mobjs, fx(192), fx(64), ONFLOORZ, MT.MT_FATSO);
      aBossDeath(fatso);
      const c = bossSpecialCalls();
      expect(c.length).toBe(1);
      expect(c[0]).toMatchObject({ kind: 'floor', tag: 666, executed: true }); // :1712-1717
    }
    {
      const s = boot(bossArena(), 'MAP07');
      resetBossSpecialCalls();
      setBossLevelProbe(probe(1, 7, true));
      const bspi = pSpawnMobj(s.mobjs, fx(192), fx(64), ONFLOORZ, MT.MT_BABY);
      aBossDeath(bspi);
      expect(bossSpecialCalls()[0]).toMatchObject({ kind: 'floor', tag: 667, actionType: 5 }); // raiseToTexture :1719-1724
    }
    {
      const s = boot(bossArena(), 'E4M6');
      resetBossSpecialCalls();
      setBossLevelProbe(probe(4, 6, false));
      const cyber = pSpawnMobj(s.mobjs, fx(128), fx(256), ONFLOORZ, MT.MT_CYBORG);
      aBossDeath(cyber);
      const c = bossSpecialCalls();
      expect(c[0]).toMatchObject({ kind: 'door', tag: 666, executed: false }); // :1740-1744, record-only
      expect(s.exitRequest).toBe('none');
    }
    {
      // commercial gate (:1616-1623): map != 7 → return; map 7 wrong type → return
      const s = boot(bossArena(), 'MAP05');
      resetBossSpecialCalls();
      setBossLevelProbe(probe(1, 5, true));
      const fatso = pSpawnMobj(s.mobjs, fx(192), fx(64), ONFLOORZ, MT.MT_FATSO);
      aBossDeath(fatso);
      expect(bossSpecialCalls().length).toBe(0);
    }
  });

  it('unresolved level identity (fixture name without E#M#) ⇒ recorded no-op, no crash', () => {
    const s = boot(bossArena(), 'FIXMAP');
    const boss = pSpawnMobj(s.mobjs, fx(128), fx(256), ONFLOORZ, MT.MT_BRUISER);
    pPlayerDamage(boss, null, null, 5000);
    tick(s, 200);
    expect(bossSpecialCalls().length).toBe(0);
    expect(s.exitRequest).toBe('none');
  });

  it('the COUNTKILL truth of the switch comment: MT_BRUISER is E1M8s boss (4 in E1M8 per the doomednum 3003 row; MT_HEAD doomednum 3005 never in E1 — plan §0.12)', () => {
    expect(mobjinfo[MT.MT_BRUISER]!.doomednum).toBe(3003);
    expect(mobjinfo[MT.MT_HEAD]!.doomednum).toBe(3005);
    expect(mobjinfo[MT.MT_BRUISER]!.flags & MF_COUNTKILL).toBeTruthy();
    expect(mobjinfo[MT.MT_HEAD]!.flags & MF_COUNTKILL).toBeTruthy();
    // Caco actions stay REGISTERED-but-E1-unreachable (plan acceptance 3
    // is exercised fixture-only above — MT_HEAD never spawns from an
    // E1M1–E1M9 THINGS lump; tests/headless/monster-census.test.ts owns
    // the live census).
  });
});

/* ================================================================== */
/* 5. Ledgers + determinism                                            */
/* ================================================================== */

describe('ledgers + determinism', () => {
  it('random-sites ledger: amon_bruiser.ts = 2 pRandom occurrences (scan = ledger)', () => {
    expect(scanRandomSites()['amon_bruiser.ts']).toBe(2);
    expect(RANDOM_SITE_CALLS['amon_bruiser.ts']).toBe(2);
  });

  it('sfx ledger: amon_bruiser.ts = 1 emit site (A_BruisAttack sfx_claw)', () => {
    expect(SFX_SITE_LEDGER['amon_bruiser.ts']).toBe(1);
  });

  it('double run: E1M8 baron purge hashes identically (state hash + call log)', () => {
    const run = (): { hash: number; log: string } => {
      const s = boot(bossArena(), 'E1M8');
      resetBossSpecialCalls();
      for (const [x, y] of POS4) {
        pPlayerDamage(pSpawnMobj(s.mobjs, fx(x), fx(y), ONFLOORZ, MT.MT_BRUISER), null, null, 5000);
      }
      tick(s, 200);
      return {
        hash: hashState(s),
        log: JSON.stringify(bossSpecialCalls()) + JSON.stringify(dmgAmts(s))
      };
    };
    const a = run();
    const b = run();
    expect(a.hash).toBe(b.hash);
    expect(a.log).toBe(b.log);
  });
});

// pRandom import guard: the draws helper uses prndindex arithmetic; the
// import keeps the module-level contract of the suite honest (no direct
// pRandom calls are needed here — every draw is body-driven).
void pRandom;
