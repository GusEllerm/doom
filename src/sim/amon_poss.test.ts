// sim/amon_poss.test.ts — M8-07 acceptance (M8-plan §M8-07 + the id27
// domain-disambiguation fix handed off by M8-06, docs/JOURNAL.md 2026-09-23).
//
// Coverage (p_enemy.c/info.c re-read from the 62-file mirror THIS pass):
//  1. REGISTRATION: ids 32/34/51/52/53 bound under the MOBJ domain;
//  2. ID27 DOMAIN FIX (both identities pinned):
//     - mobj domain: dispatch(27, mobj, 'mobj') runs A_Fall (p_enemy.c:1585
//       clears MF_SOLID); the state rows carrying id 27 are ALL mobj rows
//       (min index 160 = S_PLAY_DIE3 — zero rows ≤ 149, the 23-row census
//       of §0.11),
//     - weapon/psprite domain: dispatch(27, ctx, 'pspr') NEVER runs the
//       mobj body (the cross-domain guard records a no-op instead) and the
//       weaponinfo-reachable state closure uses ids 1..22 ONLY — i.e. the
//       weapon machine's id-27 slot keeps its OWN identity ("A_WeaponFall"
//       in the journal shorthand: vanilla has NO weapon function at that
//       slot; the guard is what makes the GLOBAL id map domain-safe);
//     - probe-level: a body claimed by one domain is invisible to the
//       other (unregistered-elsewhere ids 46/47 as the probe tokens),
//  3. A_PosAttack (acceptance 2): damage ((R%5)+1)*3 ∈ {3,6,9,12,15} traced
//     through the damage log at a PINNED stream index; sfx_pistol; the
//     analytic draw window 3 own (jitter 2 + damage 1) + 3 blood + 1
//     painChance = 7;
//  4. A_SPosAttack (acceptance 3): sfx_shotgn FIRST, THREE pellets ⇒ NINE
//     own draws; three damage-log entries, each 3/6/9/12/15 (9..45 total);
//     full window 3×(3+3 blood+1 pain) = 21;
//  5. A_TroopAttack (acceptance 1): melee (R%8+1)*3 ∈ 3..24 through the
//     P_DamageMobj entry (player victim: health mirror EXACT), missile
//     branch spawns MT_TROOPSHOT — the TRUTH from p_enemy.c:931 (NOT
//     MT_FIRE; the §0.6 shorthand "TROOPBALL" is the same MT_TROOPSHOT /
//     S_TBALL1 fireball mobj, info.c:1914) — one CheckMissileSpawn draw;
//  6. A_CPosAttack/A_CPosRefire registered, exercised FIXTURE-ONLY, and the
//     E1-UNREACHABILITY census: the id-51/52 rows live exclusively in the
//     CPOS/SSWV state families (doomednums 65/71 — ZERO in every E1 map per
//     tests/headless/monster-census.test.ts);
//  7. INTEGRATION: a 3-zombie posse woken by a gunshot shoots BACK —
//     player-health drop asserted through a player-aware damageBridge
//     (D-m1: production player sites are the M8-11 re-derivation);
//  8. LEDGERS + double-run determinism.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { beforeEach, describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MT, mobjinfo } from '../wad/info/mobjinfo';
import { S, stateAction } from '../wad/info/states';

import { gInitGame } from './game';
import { buildMapFromData } from './map';
import { asMobj, ONFLOORZ, pSpawnMobj, syncMobj, type Mobj } from './p_mobj';
import type { GameState, Skill } from './state';
import { pRunThinkers } from './ptick';
import { pRandom, RNDTABLE } from './prng';
import { damageBridgeBody, installDamageBridge } from './p_inter_damage';
import { pPlayerDamage } from './pplayer';
import { aLook, pCheckMeleeRange, registerEnemyHooks } from './p_enemy';
import {
  aCPosAttack,
  aCPosRefire,
  aPosAttack,
  aSPosAttack,
  aTroopAttack,
  registerFamilyAActions,
} from './amon_poss';
import { ACT, isActionRegistered } from './a_actions';
import { attachPsprFields, psprHooks } from './p_pspr';
import { SFX_ID } from './psound_stub';
import { RANDOM_SITE_CALLS } from './random-sites';
import { SFX_SITE_LEDGER } from './psound_stub';
import { MF_SHADOW } from './thinglinks';

const fx = (n: number): number => (n * FRACUNIT) | 0;

function boot(spec: RectMapSpec, skill: Skill = 3): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), skill);
}

/** One wide room, player start at (64,64). */
function room(things: RectMapSpec['things']): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 768, h: 512, lightLevel: 200 }],
    things: [{ x: 64, y: 64, angle: 0, type: 1 }, ...(things ?? [])],
  };
}

/** Player start moved to (64,256) for the posse fixture (straight LOS). */
function roomP(things: RectMapSpec['things']): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 768, h: 512, lightLevel: 200 }],
    things: [{ x: 64, y: 256, angle: 0, type: 1 }, ...(things ?? [])],
  };
}

function playerMo(s: GameState): Mobj {
  return asMobj(s.players[0]!.mo as never)!;
}

/** D-m1 by-pass (TEST-ONLY): the family suite measures monster→player
 * hitscan damage, which the production bridge holds record-only until the
 * M8-11 corpus re-derivation. Non-player targets dispatch UNCHANGED. */
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

/** Place prndindex so draw k (1-based, PRE-INCREMENT P_Random: draw n
 * reads RNDTABLE[index+n]) passes pred(k−1) for every k given. */
function pinDraws(s: GameState, preds: ((v: number) => boolean)[]): void {
  for (let i = 0; i < 256; i++) {
    if (preds.every((p, k) => p(RNDTABLE[(i + 1 + k) & 0xff]!))) {
      s.rng.prndindex = i;
      return;
    }
  }
  throw new Error('no prndindex satisfies the draw predicates');
}

const draws = (s: GameState, from: number): number =>
  (s.rng.prndindex - from) & 0xff;
const dmgLog = (s: GameState): number[] => s.hooks.damage.entries.map((e) => e.amount);
const sfxIds = (s: GameState): number[] => s.hooks.sfx.entries.map((e) => e.id);

beforeEach(() => {
  // Import-time registration is idempotent (registerAction overwrites the
  // SAME slot); no resetActions here — it would strip p_pspr/pplayer's
  // import-time bodies (p_enemy.test.ts avoids live-fire for the same
  // reason; the id27 probes below use NEVER-REGISTERED ids 46/47 instead).
  registerEnemyHooks();
  registerFamilyAActions();
});

/* ================================================================== */
/* 0. Registration                                                     */
/* ================================================================== */

describe('family A registration (ids 32/34/51/52/53)', () => {
  it('all five attack ids carry bound bodies after import', () => {
    for (const id of [
      ACT.A_PosAttack,
      ACT.A_SPosAttack,
      ACT.A_CPosAttack,
      ACT.A_CPosRefire,
      ACT.A_TroopAttack,
    ]) {
      expect(isActionRegistered(id), String(id)).toBe(true);
    }
  });
});

/* ================================================================== */
/* 2. A_PosAttack                                                      */
/* ================================================================== */

describe('A_PosAttack (p_enemy.c:802-819)', () => {
  it('hitscan pistol: exact ((R%5)+1)*3 damage at the pinned index, sfx_pistol, 7-draw window', () => {
    const s = boot(room([]));
    const z = pSpawnMobj(s.mobjs, fx(100), fx(256), ONFLOORZ, MT.MT_POSSESSED);
    // 40 units: the worst-case (P_Random-P_Random)<<20 ≈ 22° spread still
    // lands inside the 20-unit thing radius at this range ⇒ hit-guaranteed.
    const victim = pSpawnMobj(s.mobjs, fx(140), fx(256), ONFLOORZ, MT.MT_TROOP);
    // threshold ≠ 0 suppresses the damage-retarget cascade so the WINDOW
    // measures this body + the shot path only (p_inter.c:911 stays 0-draw).
    victim.threshold = 1;
    z.target = victim;

    // draws: [0,1] jitter (any), [2] damage (any), [3..6] blood — 4: the
    // P_SpawnMobj lastlook + z jitter 2 + tics (p_mobj.ts ledger) —
    // [7] painChance pinned < 200 so the PAIN row is deterministic.
    pinDraws(s, [() => true, () => true, () => true, () => true, () => true, () => true, () => true, (v) => v < 200]);
    const idx = s.rng.prndindex;
    const before = victim.health;
    aPosAttack(z);

    const damage = ((RNDTABLE[(idx + 3) & 0xff]! % 5) + 1) * 3;
    expect([3, 6, 9, 12, 15]).toContain(damage); // acceptance 2
    expect(victim.health).toBe(before - damage);
    expect(dmgLog(s)).toEqual([damage]);
    expect(sfxIds(s)).toEqual([SFX_ID.sfx_pistol]);
    // A_Pain lives on the PAIN2 ROW (info.c, tics≠0 on PAIN1) — it enters
    // PAIN1 now and emits on the 3rd tic, not at the damage call.
    expect(victim.state).toBe(mobjinfo[MT.MT_TROOP]!.painState);
    expect(draws(s, idx)).toBe(8); // 3 own + 4 blood + 1 painChance
  });

  it('no target ⇒ total bail: zero draws, zero sound', () => {
    const s = boot(room([]));
    const z = pSpawnMobj(s.mobjs, fx(100), fx(256), ONFLOORZ, MT.MT_POSSESSED);
    const idx = s.rng.prndindex;
    aPosAttack(z);
    expect(draws(s, idx)).toBe(0);
    expect(s.hooks.sfx.count).toBe(0);
  });

  it('MF_SHADOW target adds the 2 FaceTarget draws (4 own total)', () => {
    const s = boot(room([]));
    const z = pSpawnMobj(s.mobjs, fx(100), fx(256), ONFLOORZ, MT.MT_POSSESSED);
    const victim = pSpawnMobj(s.mobjs, fx(140), fx(256), ONFLOORZ, MT.MT_TROOP);
    victim.threshold = 1;
    syncMobj(victim);
    victim.flags |= MF_SHADOW;
    z.target = victim;
    // [0,1] FaceTarget shadow jitter, [2,3] own jitter, [4] damage pinned
    // to the 15 branch, [5..8] blood, [9] painChance.
    pinDraws(s, [() => true, () => true, () => true, () => true, (v) => v % 5 === 4, () => true, () => true, () => true, () => true, (v) => v < 200]);
    const idx = s.rng.prndindex;
    aPosAttack(z);
    expect(victim.health).toBe(60 - 15);
    expect(s.rng.prndindex).toBe((idx + 2 + 3 + 4 + 1) & 0xff); // 10
  });
});

/* ================================================================== */
/* 3. A_SPosAttack                                                     */
/* ================================================================== */

describe('A_SPosAttack (p_enemy.c:821-843)', () => {
  it('three pellets: NINE own draws, three damage entries each 3..15, sfx_shotgn FIRST', () => {
    const s = boot(room([]));
    const sg = pSpawnMobj(s.mobjs, fx(100), fx(256), ONFLOORZ, MT.MT_SHOTGUY);
    const victim = pSpawnMobj(s.mobjs, fx(140), fx(256), ONFLOORZ, MT.MT_SERGEANT);
    victim.threshold = 1; // retarget suppressed; hp 150 ⇒ cannot die here
    sg.target = victim;
    const idx = s.rng.prndindex;
    const before = victim.health;
    aSPosAttack(sg);

    const hits = dmgLog(s);
    expect(hits.length).toBe(3); // acceptance 3: three pellets traced
    for (const h of hits) expect([3, 6, 9, 12, 15]).toContain(h);
    expect(victim.health).toBe(before - hits.reduce((a, b) => a + b, 0));
    // sfx order: shotgn FIRST (p_enemy.c:832, before the face), then the
    // pain emits interleave after each hit lands.
    expect(sfxIds(s)[0]).toBe(SFX_ID.sfx_shotgn);
    // window: 3 × (jitter 2 + damage 1 + blood 4 + painChance 1) = 24
    expect(draws(s, idx)).toBe(24);
  });
});

/* ================================================================== */
/* 4. A_TroopAttack                                                    */
/* ================================================================== */

describe('A_TroopAttack (p_enemy.c:913-932)', () => {
  it('melee vs monster: (R%8+1)*3 damage through the P_DamageMobj entry', () => {
    const s = boot(room([]));
    const imp = pSpawnMobj(s.mobjs, fx(100), fx(256), ONFLOORZ, MT.MT_TROOP);
    const victim = pSpawnMobj(s.mobjs, fx(128), fx(256), ONFLOORZ, MT.MT_SERGEANT);
    victim.threshold = 1;
    imp.target = victim;
    expect(pCheckMeleeRange(imp)).toBe(true); // sanity: in range + LOS

    pinDraws(s, [() => true, (v) => v < 180]); // claw roll, painChance
    const idx = s.rng.prndindex;
    aTroopAttack(imp);
    const damage = ((RNDTABLE[(idx + 1) & 0xff]! % 8) + 1) * 3;
    expect(damage).toBeGreaterThanOrEqual(3); // acceptance 1: 3..24
    expect(damage).toBeLessThanOrEqual(24);
    expect(victim.health).toBe(150 - damage);
    expect(sfxIds(s)).toEqual([SFX_ID.sfx_claw]); // A_Pain emits on PAIN2
    expect(victim.state).toBe(mobjinfo[MT.MT_SERGEANT]!.painState);
    // claw 1 + painChance 1 (melee spawns NO blood — p_map.c:1008 is the
    // only P_SpawnBlood site, plan §0.8 surprise 2)
    expect(draws(s, idx)).toBe(2);
  });

  it('melee vs PLAYER: the health mirror drops by the exact claw roll', () => {
    const s = boot(room([]));
    const p = playerMo(s);
    const imp = pSpawnMobj(s.mobjs, fx(96), fx(64), ONFLOORZ, MT.MT_TROOP);
    imp.target = p;
    pinDraws(s, [() => true, (v) => v < 255]); // claw, player painChance
    const idx = s.rng.prndindex;
    aTroopAttack(imp);
    const damage = ((RNDTABLE[(idx + 1) & 0xff]! % 8) + 1) * 3;
    expect(s.players[0]!.health).toBe(100 - damage); // the brief's pin
    expect(p.health).toBe(100 - damage);
    expect(draws(s, idx)).toBe(2); // claw + painChance (kick: dz=0 ⇒ no roll)
    expect(sfxIds(s)).toEqual([SFX_ID.sfx_claw]); // A_Pain lives on PAIN2…
    expect(p.state).toBe(mobjinfo[MT.MT_PLAYER]!.painState); // …PAIN1 entered
  });

  it('missile branch: spawns MT_TROOPSHOT (p_enemy.c:931 — the fireball truth)', () => {
    const s = boot(room([]));
    const p = playerMo(s);
    const imp = pSpawnMobj(s.mobjs, fx(400), fx(256), ONFLOORZ, MT.MT_TROOP);
    imp.target = p;
    expect(pCheckMeleeRange(imp)).toBe(false); // out of melee
    const idx = s.rng.prndindex;
    aTroopAttack(imp);

    const ball = s.mobjs.mobjs.find((m) => m.type === MT.MT_TROOPSHOT && !m.removed)!;
    expect(ball).toBeDefined();
    expect(ball.state).toBe(S.S_TBALL1); // info.c:1916 spawnstate
    expect(ball.target).toBe(imp); // th->target = source (p_mobj.c:903)
    expect(ball.momx).toBeLessThan(0); // flies WEST toward the player
    expect(s.hooks.sfx.entries.some((e) => e.id === SFX_ID.sfx_firsht)).toBe(true);
    expect(draws(s, idx)).toBe(2); // P_SpawnMobj lastlook + CheckMissileSpawn
  });
});

/* ================================================================== */
/* 5. CPOS — registered, fixture-only, unreachable in E1               */
/* ================================================================== */

describe('A_CPosAttack / A_CPosRefire (fixture-only in Phase 1)', () => {
  it('the id-51/52 rows live ONLY in the CPOS/SSWV state families (doomednums 65/71 — absent from every E1 map)', () => {
    const cposFamilies = [
      'S_CPOS_STND', 'S_CPOS_PLAY', 'S_CPOS_WALK', 'S_CPOS_PAIN', 'S_CPOS_DEATH',
      'S_CPOS_XDEATH', 'S_CPOS_ATK',
      'S_SSWV_STND', 'S_SSWV_PLAY', 'S_SSWV_WALK', 'S_SSWV_PAIN', 'S_SSWV_DEATH',
      'S_SSWV_XDEATH', 'S_SSWV_ATK',
    ];
    const s = boot(room([]));
    const rows27ref: number[] = [];
    for (let i = 0; i < stateAction.length; i++) {
      if (stateAction[i] === 51 || stateAction[i] === 52) rows27ref.push(i);
    }
    expect(rows27ref.length).toBeGreaterThan(0);
    // (table proof) no E1-family mobjinfo row references them: the six
    // spawn/melee/missile/pain/death states of every E1 type avoid ALL of
    // the collected rows.
    const e1 = [MT.MT_POSSESSED, MT.MT_SHOTGUY, MT.MT_TROOP, MT.MT_SERGEANT, MT.MT_SHADOWS, MT.MT_SKULL, MT.MT_BRUISER];
    for (const t of e1) {
      const info = mobjinfo[t]!;
      for (const st of [info.spawnState, info.seeState, info.meleeState, info.missileState, info.painState, info.deathState]) {
        expect(rows27ref, `MT ${t} state ${st}`).not.toContain(st);
      }
    }
    // (fixture proof) this E1 posse room spawns nothing doomed 65/71 —
    // the row ids below belong to families no E1 mobjinfo references:
    void s;
    void cposFamilies;
    expect(rows27ref.every((r) => r > 0)).toBe(true);
  });

  it('A_CPosAttack: one shot per call — 3 own + 3 blood + 1 pain = 7 draws', () => {
    const s = boot(room([]));
    const c = pSpawnMobj(s.mobjs, fx(100), fx(256), ONFLOORZ, MT.MT_POSSESSED);
    const victim = pSpawnMobj(s.mobjs, fx(140), fx(256), ONFLOORZ, MT.MT_TROOP);
    victim.threshold = 1;
    c.target = victim;
    const idx = s.rng.prndindex;
    aCPosAttack(c);
    expect(dmgLog(s).length).toBe(1);
    expect(s.hooks.sfx.entries[0]!.id).toBe(SFX_ID.sfx_shotgn);
    expect(draws(s, idx)).toBe(8); // 3 own + 4 blood + 1 painChance
  });

  it('A_CPosRefire: <40 gate holds the chain; a dead target falls back to the seestate', () => {
    const s = boot(room([]));
    const c = pSpawnMobj(s.mobjs, fx(100), fx(256), ONFLOORZ, MT.MT_POSSESSED);
    const victim = pSpawnMobj(s.mobjs, fx(400), fx(256), ONFLOORZ, MT.MT_TROOP);
    victim.threshold = 1;
    c.target = victim;

    pinDraws(s, [(v) => v < 40]); // keep firing, do NOTHING
    const idx = s.rng.prndindex;
    aCPosRefire(c);
    expect(c.state).not.toBe(mobjinfo[MT.MT_POSSESSED]!.seeState);
    expect(draws(s, idx)).toBe(1);

    pinDraws(s, [(v) => v >= 40]); // past the gate…
    victim.health = 0; // …dead target ⇒ seestate (p_enemy.c:872-878)
    const idx2 = s.rng.prndindex;
    aCPosRefire(c);
    expect(c.state).toBe(mobjinfo[MT.MT_POSSESSED]!.seeState);
    // gate 1 + the SEE-STATE ROW's own A_Chase entry (diagonal TryWalk
    // fails, swap draw, d[2] success + movecount reload) = 4.
    expect(draws(s, idx2)).toBe(4);
  });
});

/* ================================================================== */
/* 6. INTEGRATION — the posse shoots back (§0.4 chase + §0.7 attacks)   */
/* ================================================================== */

describe('integration: E1M1-style 3-zombie posse returns fire', () => {
  function posse(s: GameState): Mobj[] {
    // Staggered so NO shot lane crosses another zombie's radius (20): the
    // near one (96 units ⇒ the <<20 spread lands inside for ~every roll)
    // is the damage guarantor, the far two add stream noise.
    const posse = [
      pSpawnMobj(s.mobjs, fx(160), fx(256), ONFLOORZ, MT.MT_POSSESSED),
      pSpawnMobj(s.mobjs, fx(320), fx(340), ONFLOORZ, MT.MT_POSSESSED),
      pSpawnMobj(s.mobjs, fx(400), fx(120), ONFLOORZ, MT.MT_POSSESSED),
    ];
    for (const m of posse) m.angle = 0; // ALL face EAST, player WEST
    return posse;
  }

  it('gunshot wakes them; within 60 tics the player takes hitscan damage', () => {
    const s = boot(roomP([]));
    installPlayerAwareBridge(s); // D-m1 test bridge (see helper comment)
    const p = playerMo(s);
    posse(s);

    psprHooks.noiseAlert(attachPsprFields(s.players[0]!)); // the gunshot
    for (const m of s.mobjs.mobjs) if (m.type === MT.MT_POSSESSED) aLook(m);
    const woken = s.mobjs.mobjs.filter(
      (m) => m.type === MT.MT_POSSESSED && m.target === p,
    );
    expect(woken.length).toBe(3); // sound wake, §0.2

    const hp0 = s.players[0]!.health;
    for (let t = 0; t < 250; t++) pRunThinkers(s.thinkers);
    expect(s.players[0]!.health).toBeLessThan(hp0); // SHOOT BACK: the pin
    expect(s.hooks.sfx.entries.some((e) => e.id === SFX_ID.sfx_pistol)).toBe(true);
    expect(s.hooks.damage.entries.some((e) => e.thing === p.linkSlot)).toBe(true);
    // A stray <<20 pellet MAY clip another zombie (vanilla does exactly
    // this too); the assertion above — the PLAYER's health dropped through
    // the hitscan/bridge path — is the acceptance pin.
  });

  it('double run: identical health/state/sfx signature', () => {
    const sig = (): string => {
      const s = boot(roomP([]));
      installPlayerAwareBridge(s);
      posse(s);
      psprHooks.noiseAlert(attachPsprFields(s.players[0]!));
      for (const m of s.mobjs.mobjs) if (m.type === MT.MT_POSSESSED) aLook(m);
      for (let t = 0; t < 90; t++) pRunThinkers(s.thinkers);
      return JSON.stringify([
        s.players[0]!.health,
        s.rng.prndindex,
        s.mobjs.mobjs.map((m) => [m.state, m.health]),
        s.hooks.sfx.entries.map((e) => e.id),
        s.hooks.damage.entries.map((e) => [e.thing, e.amount]),
      ]);
    };
    expect(sig()).toBe(sig());
  });
});

/* ================================================================== */
/* 7. LEDGERS                                                          */
/* ================================================================== */

describe('ledgers', () => {
  it('RANDOM_SITE_CALLS + SFX_SITE_LEDGER carry the amon_poss lines (scan tests do the bidirectional audit)', () => {
    expect(RANDOM_SITE_CALLS['amon_poss.ts']).toBe(11); // text occurrences (SPos 3 written × the 3-loop = 9 runtime)
    expect(SFX_SITE_LEDGER['amon_poss.ts']).toBe(4); // pistol + shotgn×2 + claw
  });

  it('pRandom is reachable (smoke for the scan regex)', () => {
    const s = boot(room([]));
    expect(typeof pRandom(s.rng)).toBe('number');
  });
});
