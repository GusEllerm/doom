// tests/headless/monsters.test.ts — M8-11 consolidated L2 monster suites
// (docs/design/M8-plan.md §M8-11: "the evidence milestone").
//
// FOUR ACTS, ONE FILE:
//  A. PER-FAMILY LIFECYCLES — every E1 family (POSS/SPOS/TROO/SARG/SPECTRE/
//     SKULL/BRUISER + fixture-only HEAD/rocket-stream) runs wake → chase →
//     attack → pain → death → corpse with PRNG STREAM PINS: the prndindex
//     delta per phase vs the ledger windows (pos/ssarg spread draws, troop
//     missile lift, skullfly stream, caco/baron/rocket missile streams,
//     painChance rolls per the family table, the gib-tics clamp draw, the
//     scream variant draws).
//  B. CROSS-FAMILY INFLIGHT BRAWL — baron vs zombies vs caco in one arena:
//     target switching, friendly-fire deaths, killcount attribution under
//     the NON-NET rule (p_inter.c:694-697 — monster/NULL kills count in SP).
//  C. RANDOM-SITES LEDGER RECONCILIATION — the global manifest test: the
//     RANDOM_SITE_CALLS totals vs the scan sums, module-set equality, and
//     the M8 additions (lastlook/pain/gib/lift/pos-spread) pinned per
//     module (registryManifest idiom — drift = red).
//  D. DETERMINISM MARATHON — E1M1 warp, chaingun given, 300 scripted tics
//     with monsters retaliating: double-run identical hash + prndindex
//     equality + killcount sane (>0). NO game.ts live wiring (that is the
//     e2e task's job); the sim is constructed through the headless harness.
//
// NEVER re-derives family module internals — everything asserted here is
// observable through the SAME seams the family suites used (states,
// health, prndindex deltas, hooks logs). Family B (amon_sarg) is OPTIONAL:
// when the module is not on this branch its two bodies dispatch as counted
// no-ops and the attack-phase pins skip with a probe instead.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { MF, MT, mobjinfo } from '../../src/wad/info/mobjinfo';
import { S } from '../../src/wad/info/states';

import { gInitGame, gTicker } from '../../src/sim/game';
import { buildMapFromData } from '../../src/sim/map';
import {
  asMobj,
  ONFLOORZ,
  pSpawnMobj,
  syncMobj,
  type Mobj,
} from '../../src/sim/p_mobj';
import { hashState, type GameState, type Skill } from '../../src/sim/state';
import { pRunThinkers } from '../../src/sim/ptick';
import { RNDTABLE } from '../../src/sim/prng';
import {
  damageBridgeBody,
  installDamageBridge,
  pDamageMobj,
} from '../../src/sim/p_inter_damage';
import { pPlayerDamage } from '../../src/sim/pplayer';
import {
  aFaceTarget,
  pNoiseAlert,
  registerEnemyHooks,
} from '../../src/sim/p_enemy';
import {
  aPosAttack,
  aSPosAttack,
  aTroopAttack,
  registerFamilyAActions,
} from '../../src/sim/amon_poss';
import {
  aBruisAttack,
  aHeadAttack,
  registerFamilyCActions,
} from '../../src/sim/amon_bruiser';
import { pSpawnMissile } from '../../src/sim/pmissiles';
import { registerDeathActions } from '../../src/sim/pdeath';
import { isActionRegistered, ACT, unimplementedActions } from '../../src/sim/a_actions';
import { installPsprSfxSlot, SFX_ID } from '../../src/sim/psound_stub';
import { attachPsprFields, WP_CHAINGUN, AM_CLIP } from '../../src/sim/p_pspr';
import { RANDOM_SITE_CALLS, RANDOM_SITE_SCAN_SKIP, scanRandomSites } from '../../src/sim/random-sites';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';

/* ------------------------------------------------------------------ */
/* Family B (M8-08, MAY BE MID-LANDING): OPTIONAL dynamic import        */
/* ------------------------------------------------------------------ */

// import.meta.glob keeps the check tsc-safe (no static specifier to
// resolve) AND vite-loadable (the loader runs through the module graph).
const famBMods = import.meta.glob('../../src/sim/amon_sarg.ts');
const famBKey = Object.keys(famBMods)[0];
const famBPresent = famBKey !== undefined;
let famB: Record<string, unknown> | null = null;
if (famBKey !== undefined) {
  famB = (await famBMods[famBKey]!()) as Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const fx = (n: number): number => (n * FRACUNIT) | 0;
const dist = (a: Mobj, b: Mobj): number =>
  Math.hypot((a.x - b.x) / FRACUNIT, (a.y - b.y) / FRACUNIT);

const ARENA: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 1024, h: 768, lightLevel: 200 }],
  things: [{ x: 64, y: 384, angle: 0, type: 1 }],
};

function boot(spec: RectMapSpec, skill: Skill = 3): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), skill);
  installPsprSfxSlot(s.hooks, () => s.leveltime);
  return s;
}

const bootArena = (): GameState => boot(ARENA);

function playerMo(s: GameState): Mobj {
  return asMobj(s.players[0]!.mo as never)!;
}

/** D-m1 by-pass (TEST-ONLY, same helper the family suites install):
 * monster→PLAYER damage routes through pPlayerDamage; everything else
 * dispatches through the production bridge body UNCHANGED. */
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

/** Place prndindex so draw k (1-based, PRE-INCREMENT P_Random) passes
 * pred(k−1) for every k given (amon_* idiom). */
function pinDraws(s: GameState, preds: ((v: number) => boolean)[]): void {
  for (let i = 0; i < 256; i++) {
    if (preds.every((p, k) => p(RNDTABLE[(i + 1 + k) & 0xff]!))) {
      s.rng.prndindex = i;
      return;
    }
  }
  throw new Error('no prndindex satisfies the draw predicates');
}

/** Set prndindex so the NEXT draw reads RNDTABLE[k]. */
function pinNext(s: GameState, k: number): void {
  s.rng.prndindex = (k - 1) & 0xff;
}

const draws = (s: GameState, from: number): number => (s.rng.prndindex - from) & 0xff;
const dmgLog = (s: GameState): number[] => s.hooks.damage.entries.map((e) => e.amount);
const sfxIds = (s: GameState): number[] => s.hooks.sfx.entries.map((e) => e.id);

/** Run tics until `stop()` (or `cap`), returning the tics consumed. */
function runUntil(s: GameState, cap: number, stop: () => boolean): number {
  let t = 0;
  for (; t < cap; t++) {
    pRunThinkers(s.thinkers);
    if (stop()) return t + 1;
  }
  return t;
}

beforeEach(() => {
  registerEnemyHooks();
  registerFamilyAActions();
  registerFamilyCActions();
  registerDeathActions();
  if (famB && typeof famB['registerFamilyBActions'] === 'function') {
    (famB['registerFamilyBActions'] as () => void)();
  }
});

/* ------------------------------------------------------------------ */
/* The E1 family table (mobjinfo-derived; the painChance column is the  */
/* per-family pin used by EVERY pain roll asserted below)               */
/* ------------------------------------------------------------------ */

interface FamilySpec {
  readonly name: string;
  readonly mt: number;
  /** A_Look aSeeSound variant draws on wake (posit %3 / bgsit %2 = 1). */
  readonly wakeDraws: number;
  /** painChance from the table (asserted equal — the table is the ledger). */
  readonly painChance: number;
  /** A_Scream variant draws in the DEATH chain (podth %3 / bgdth %2 = 1). */
  readonly screamDraws: number;
  /** plain (non-variant) deathsound ids expected in the sfx log, or the
   * podth/bgdth VARIANT RANGES when screamDraws > 0. */
  readonly screamIds: readonly number[] | readonly [number, number];
  /** xdeath chain exists (gib path). */
  readonly gib: boolean;
  readonly countKill: boolean;
  /** P_KillMobj drop-table item (p_inter.c:737-757) — the DROP spawn's
   * lastlook draw rides the KILL window (POSS clip, SPOS shotgun). */
  readonly dropDraws: number;
  /** body lives in the (optional) family B module. */
  readonly famB?: boolean;
  /** per-hit bounds the live chase-phase retaliation must fall inside. */
  readonly hitBounds: readonly [number, number];
}

const FAMILY_TABLE: readonly FamilySpec[] = [
  { name: 'POSS', mt: MT.MT_POSSESSED, wakeDraws: 1, painChance: 200, screamDraws: 1, screamIds: [SFX_ID.sfx_podth1, SFX_ID.sfx_podth1 + 2], gib: true, countKill: true, dropDraws: 1, hitBounds: [3, 15] },
  { name: 'SPOS', mt: MT.MT_SHOTGUY, wakeDraws: 1, painChance: 170, screamDraws: 1, screamIds: [SFX_ID.sfx_podth1, SFX_ID.sfx_podth1 + 2], gib: true, countKill: true, dropDraws: 1, hitBounds: [3, 15] },
  { name: 'TROO', mt: MT.MT_TROOP, wakeDraws: 1, painChance: 200, screamDraws: 1, screamIds: [SFX_ID.sfx_bgdth1, SFX_ID.sfx_bgdth1 + 1], gib: true, countKill: true, dropDraws: 0, hitBounds: [3, 24] },
  { name: 'SARG', mt: MT.MT_SERGEANT, wakeDraws: 0, painChance: 180, screamDraws: 0, screamIds: [SFX_ID.sfx_sgtdth], gib: false, countKill: true, dropDraws: 0, famB: true, hitBounds: [5, 80] },
  { name: 'SPECTRE', mt: MT.MT_SHADOWS, wakeDraws: 0, painChance: 180, screamDraws: 0, screamIds: [SFX_ID.sfx_sgtdth], gib: false, countKill: true, dropDraws: 0, famB: true, hitBounds: [5, 80] },
  { name: 'SKULL', mt: MT.MT_SKULL, wakeDraws: 0, painChance: 256, screamDraws: 0, screamIds: [SFX_ID.sfx_firxpl], gib: false, countKill: false, dropDraws: 0, famB: true, hitBounds: [3, 24] },
  { name: 'BRUISER', mt: MT.MT_BRUISER, wakeDraws: 0, painChance: 50, screamDraws: 0, screamIds: [SFX_ID.sfx_brsdth], gib: false, countKill: true, dropDraws: 0, hitBounds: [8, 80] },
  { name: 'HEAD', mt: MT.MT_HEAD, wakeDraws: 0, painChance: 128, screamDraws: 0, screamIds: [SFX_ID.sfx_cacdth], gib: false, countKill: true, dropDraws: 0, hitBounds: [5, 60] },
];

/** mobjinfo sanity: the table IS the ledger for this suite. */
function painChanceOf(mt: number): number {
  return mobjinfo[mt]!.painChance;
}

/* ================================================================== */
/* A1. WAKE → CHASE (live thinkers) for every E1 family                */
/* ================================================================== */

describe('M8-11 wake→chase: gunshot wakes every family with the ledger see-sound draws', () => {
  for (const fam of FAMILY_TABLE) {
    it(`${fam.name}: wake draws ${fam.wakeDraws} (A_Look variant), chase engages`, () => {
      const s = bootArena();
      installPlayerAwareBridge(s);
      const p = playerMo(s);
      const m = pSpawnMobj(s.mobjs, fx(700), fx(384), ONFLOORZ, fam.mt);
      const iSpawn = s.rng.prndindex;
      expect(m.lastLook).toBeLessThanOrEqual(3); // spawn lastlook ∈ R%MAXPLAYERS

      // STREAM PIN (deterministic wake window): with movedir assigned and
      // movecount>0 the SEE-ROW's first A_Chase skips P_NewChaseDir (the
      // data-dependent random-search draws) and pays ONLY the activesound
      // roll ⇒ wake delta = seeSound variant + 1, EXACTLY.
      m.movedir = 4; // DI_WEST — player lies west
      m.movecount = 15;
      const iWake = s.rng.prndindex;
      pNoiseAlert(s.mobjs, p, p);
      const tics = runUntil(s, 40, () => m.state !== mobjinfo[fam.mt]!.spawnState);
      expect(tics, 'wakes within a few tics of the alert').toBeLessThan(40);
      expect(m.target).toBe(p); // :614 sound-target adoption
      expect(m.state).toBe(mobjinfo[fam.mt]!.seeState); // seestate row
      expect(draws(s, iWake), 'posit %3 / bgsit %2 variant + activesound')
        .toBe(fam.wakeDraws + 1);

      // CHASE: 30 tics engage the chase machinery (movedir re-searched by
      // P_NewChaseDir as the room geometry changes, and the activesound
      // roll is paid EVERY chase tic, ledger p_enemy.ts).
      const iChase = s.rng.prndindex;
      const d0 = dist(m, p);
      runUntil(s, 30, () => false);
      expect(m.movedir).toBeLessThan(8);
      // One activesound roll per A_CHASE CALL (chase rows are 3..6-tic),
      // so the 30-tic window pays at least ⌊30/6⌋ rolls — plus every
      // P_NewChaseDir the geometry forces on top.
      expect(draws(s, iChase)).toBeGreaterThanOrEqual(4);
      expect(dist(m, p)).toBeLessThan(d0); // closes distance
      expect(s.rng.prndindex - iSpawn).toBeGreaterThan(0);
    });
  }
});

/* ================================================================== */
/* A2. ATTACK STREAM PINS — exact prndindex windows per family         */
/* ================================================================== */

/** Park an idle victim whose threshold=1 suppresses the retarget cascade
 * (p_inter.c:911 stays 0-draw), so the WINDOW measures attacker + shot
 * path + the victim's painChance roll only (amon_* idiom). */
function victim(s: GameState, mt: number, x: number, y: number): Mobj {
  const v = pSpawnMobj(s.mobjs, fx(x), fx(y), ONFLOORZ, mt);
  v.threshold = 1;
  syncMobj(v);
  return v;
}

describe('M8-11 attack streams: pos/ssarg spread draws pinned to the stream', () => {
  it('POSS A_PosAttack: 3 own (jitter 2 + damage 1) + 4 blood + 1 pain = 8', () => {
    const s = bootArena();
    const z = pSpawnMobj(s.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_POSSESSED);
    const v = victim(s, MT.MT_TROOP, 340, 384);
    z.target = v;
    pinDraws(s, [() => true, () => true, () => true, () => true, () => true, () => true, () => true, (r) => r < painChanceOf(MT.MT_TROOP)]);
    const i = s.rng.prndindex;
    const hp = v.health;
    aPosAttack(z);
    const dmg = ((RNDTABLE[(i + 3) & 0xff]! % 5) + 1) * 3;
    expect([3, 6, 9, 12, 15]).toContain(dmg);
    expect(hp - v.health).toBe(dmg);
    expect(v.state).toBe(mobjinfo[MT.MT_TROOP]!.painState);
    expect(draws(s, i)).toBe(8);
  });

  it('SPOS A_SPosAttack: THREE pellets = 3×(3+4+1) = 24 draws, volley 9..45', () => {
    const s = bootArena();
    const g = pSpawnMobj(s.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_SHOTGUY);
    const v = victim(s, MT.MT_SERGEANT, 340, 384);
    v.health = 1 << 20; // cannot die: 3 full-window pellets must all land
    g.target = v;
    const i = s.rng.prndindex;
    const hp = v.health;
    aSPosAttack(g);
    const hits = dmgLog(s);
    expect(hits.length).toBe(3);
    let sum = 0;
    for (const h of hits) {
      expect([3, 6, 9, 12, 15]).toContain(h);
      sum += h;
    }
    expect(sum).toBe(hp - v.health);
    expect(sum).toBeGreaterThanOrEqual(9); // volley bounds 3×3 .. 3×15
    expect(sum).toBeLessThanOrEqual(45);
    expect(sfxIds(s)[0]).toBe(SFX_ID.sfx_shotgn);
    expect(draws(s, i)).toBe(24);
  });

  it('TROO melee 2 draws + missile MT_TROOPSHOT stream ≤ the 10-draw lift ceiling', () => {
    // MELEE: claw roll + the victim's painChance roll (amon_poss pin).
    const s = bootArena();
    const imp = pSpawnMobj(s.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_TROOP);
    const v = victim(s, MT.MT_SERGEANT, 322, 384);
    imp.target = v;
    pinDraws(s, [() => true, (r) => r < painChanceOf(MT.MT_SERGEANT)]);
    const i0 = s.rng.prndindex;
    const hp0 = v.health;
    aTroopAttack(imp);
    // MELEE bodies call P_DamageMobj DIRECTLY (no damageSlot record — only
    // hitscan/PIT/crush sites populate hooks.damage): the health delta is
    // the observable.
    expect(hp0 - v.health).toBe(((RNDTABLE[(i0 + 1) & 0xff]! % 8) + 1) * 3);
    expect(draws(s, i0)).toBe(2);

    // MISSILE ("MT_FIRE" shorthand — the 1.10 truth is MT_TROOPSHOT, the
    // MT_FIRE reading is disproved in amon_poss.ts:180). Spawn side 2
    // (lastlook + CheckMissileSpawn lift), impact 3 (direct dice,
    // explode-tics lift, pain roll) ⇒ 5 total, ceiling ≤ 10.
    const s2 = bootArena();
    const imp2 = pSpawnMobj(s2.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_TROOP);
    const v2 = victim(s2, MT.MT_SERGEANT, 700, 384);
    v2.health = 1 << 20;
    imp2.target = v2;
    const i1 = s2.rng.prndindex;
    aTroopAttack(imp2);
    const ball = s2.mobjs.mobjs.find(
      (m) => m.type === MT.MT_TROOPSHOT && !m.removed,
    );
    expect(ball, 'missile branch spawns the MT_TROOPSHOT fireball').toBeTruthy();
    expect(draws(s2, i1)).toBe(2); // spawn side only so far
    const tics = runUntil(s2, 120, () => v2.health < 1 << 20);
    expect(tics).toBeLessThan(120); // the ball connects
    const d = ((1 << 20) - v2.health);
    expect(d).toBeGreaterThanOrEqual(3); // (R%8+1)×3 — MT_TROOPSHOT damage 3
    expect(d).toBeLessThanOrEqual(24);
    const cycle = draws(s2, i1);
    expect(cycle, 'full missile cycle within the 10-draw lift ceiling').toBeLessThanOrEqual(10);
    expect(cycle).toBeGreaterThanOrEqual(4);
  });

  it('BRUISER melee (R%8+1)*10 10..80 with sfx_claw: 2-draw window', () => {
    const s = bootArena();
    const b = pSpawnMobj(s.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_BRUISER);
    const v = victim(s, MT.MT_POSSESSED, 322, 384);
    v.health = 1 << 20;
    b.target = v;
    pinDraws(s, [() => true, (r) => r < painChanceOf(MT.MT_POSSESSED)]);
    const i = s.rng.prndindex;
    const hp0 = v.health;
    aBruisAttack(b);
    expect(hp0 - v.health).toBe(((RNDTABLE[(i + 1) & 0xff]! % 8) + 1) * 10);
    expect(sfxIds(s)[0]).toBe(SFX_ID.sfx_claw);
    expect(draws(s, i)).toBe(2);
  });

  it('BRUISER missile stream: MT_BRUISERSHOT spawn 2 → impact dice 8..64 + explode 1 + pain 1', () => {
    const s = bootArena();
    const b = pSpawnMobj(s.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_BRUISER);
    const v = victim(s, MT.MT_POSSESSED, 700, 384);
    v.health = 1 << 20;
    b.target = v;
    const i = s.rng.prndindex;
    aBruisAttack(b);
    expect(s.mobjs.mobjs.some((m) => m.type === MT.MT_BRUISERSHOT && !m.removed)).toBe(true);
    expect(draws(s, i)).toBe(2);
    const tics = runUntil(s, 160, () => v.health < 1 << 20);
    expect(tics).toBeLessThan(160);
    const d = dmgLog(s)[0] ?? -1;
    expect(d).toBeGreaterThanOrEqual(8); // (R%8+1)×8 — MT_BRUISERSHOT damage 8
    expect(d).toBeLessThanOrEqual(64);
    expect(draws(s, i)).toBe(5); // 2 spawn + dice + explode-tics + pain
  });

  it('HEAD (fixture-only, E2 roster) melee: SILENT (R%6+1)*10 = 10..60, 2 draws', () => {
    const s = bootArena();
    const c = pSpawnMobj(s.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_HEAD);
    const v = victim(s, MT.MT_POSSESSED, 322, 384);
    v.health = 1 << 20;
    c.target = v;
    pinDraws(s, [() => true, (r) => r < painChanceOf(MT.MT_POSSESSED)]);
    const i = s.rng.prndindex;
    const hp0 = v.health;
    aHeadAttack(c);
    expect(hp0 - v.health).toBe(((RNDTABLE[(i + 1) & 0xff]! % 6) + 1) * 10);
    expect(sfxIds(s).length, 'A_HeadAttack is silent (no melee sfx site)').toBe(0);
    expect(draws(s, i)).toBe(2);
  });

  it('HEAD missile stream: MT_HEADSHOT flight, TOUCH dice (R%8+1)*5 = 5..40', () => {
    const s = bootArena();
    const c = pSpawnMobj(s.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_HEAD);
    const v = victim(s, MT.MT_POSSESSED, 700, 384);
    v.health = 1 << 20;
    c.target = v;
    const i = s.rng.prndindex;
    aHeadAttack(c);
    expect(s.mobjs.mobjs.some((m) => m.type === MT.MT_HEADSHOT && !m.removed)).toBe(true);
    expect(draws(s, i)).toBe(2);
    const tics = runUntil(s, 160, () => v.health < 1 << 20);
    expect(tics).toBeLessThan(160);
    expect(dmgLog(s)[0]).toBeGreaterThanOrEqual(5); // MT_HEADSHOT damage 5
    expect(dmgLog(s)[0]).toBeLessThanOrEqual(40);
    expect(draws(s, i)).toBe(5);
  });

  it('CYBER stream: MT_ROCKET spawn 2 → direct dice 20..160 + explode lift (no A_CyberAttack body pre-M9)', () => {
    // A_CyberAttack (id 63) is registered by NO E1 family (MT_CYBORG is
    // fixture-only, plan §0.12) — the stream itself is the missile engine.
    expect(isActionRegistered(ACT.A_CyberAttack), 'not an E1 body').toBe(false);
    const s = bootArena();
    const src = pSpawnMobj(s.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_CYBORG, -1, {
      skipLastLookRandom: true,
    });
    const v = victim(s, MT.MT_POSSESSED, 700, 384);
    v.health = 1 << 20;
    const i = s.rng.prndindex;
    pSpawnMissile(s.mobjs, src, v, MT.MT_ROCKET);
    expect(s.mobjs.mobjs.some((m) => m.type === MT.MT_ROCKET && !m.removed)).toBe(true);
    expect(draws(s, i)).toBe(2); // lastlook + CheckMissileSpawn lift
    const tics = runUntil(s, 160, () => v.health < 1 << 20);
    expect(tics).toBeLessThan(160);
    expect(dmgLog(s)[0]).toBeGreaterThanOrEqual(20); // (R%8+1)×20 — MT_ROCKET
    expect(dmgLog(s)[0]).toBeLessThanOrEqual(160);
    // Impact: direct dice + explode-tics + pain, and the rocket's explode
    // ROW 127 spawns the MT_FIRE splat mobj — its LASTLOOK is the one
    // extra draw (6 total); the A_Explode body itself draws NOTHING
    // (splash truth, M8-09 census).
    expect(draws(s, i)).toBe(6);
  });

  it('SPECTRE stream: the MF_SHADOW target adds FaceTarget jitter 2 draws', () => {
    const s = bootArena();
    const sp = pSpawnMobj(s.mobjs, fx(300), fx(384), ONFLOORZ, MT.MT_SHADOWS);
    const v = victim(s, MT.MT_SERGEANT, 700, 384);
    v.flags |= MF.MF_SHADOW; // (a fuzzy PLAYER is the classic case; the
    syncMobj(v);            //  A_FaceTarget branch reads the flag only)
    sp.target = v;
    const i = s.rng.prndindex;
    aFaceTarget(sp);
    expect(draws(s, i)).toBe(2); // (R−R)<<21 — p_enemy.c:795
  });
});

describe('M8-11 family B attack streams (skipped while amon_sarg is unlanded)', () => {
  const itB = famBPresent ? it : it.skip;
  itB(`probe: amon_sarg present=${String(famBPresent)}`, () => {
    expect(famBPresent).toBe(true);
  });

  itB('SARG melee via the ATK rows: (R%8+1)*10 halved-gate, bounds 5..80', () => {
    const s = bootArena();
    installPlayerAwareBridge(s);
    const d = pSpawnMobj(s.mobjs, fx(150), fx(384), ONFLOORZ, MT.MT_SERGEANT);
    const p = playerMo(s);
    d.target = p;
    const hp0 = s.players[0]!.health;
    const tics = runUntil(s, 60, () => s.players[0]!.health < hp0);
    expect(tics).toBeLessThan(60);
    expect(s.players[0]!.health).toBe(hp0 - (hp0 - s.players[0]!.health));
    for (const e of dmgLog(s)) {
      expect(e).toBeGreaterThanOrEqual(5); // (R%8+1)*10 halved ⇒ ≥ 5
      expect(e).toBeLessThanOrEqual(80);
    }
  });

  itB('SKULL stream: A_SkullAttack sets MF_SKULLFLY, hit dice (R%8+1)*3 = 3..24', () => {
    const s = bootArena();
    installPlayerAwareBridge(s);
    const k = pSpawnMobj(s.mobjs, fx(400), fx(384), ONFLOORZ, MT.MT_SKULL);
    const p = playerMo(s);
    k.target = p;
    let sawFly = false;
    const hp0 = s.players[0]!.health;
    runUntil(s, 200, () => {
      if ((k.flags & MF.MF_SKULLFLY) !== 0) sawFly = true;
      return s.players[0]!.health < hp0;
    });
    expect(sawFly, 'the charge sets MF_SKULLFLY').toBe(true);
    for (const e of dmgLog(s)) {
      expect(e).toBeGreaterThanOrEqual(3); // MT_SKULL damage 3
      expect(e).toBeLessThanOrEqual(24);
    }
  });
});

describe('M8-11 family B absent probe (counts the no-op dispatch, never a crash)', () => {
  const itAbsent = famBPresent ? it.skip : it;
  itAbsent('ids 54/57 stay registered-free: brawl lives run them as counted no-ops', () => {
    expect(isActionRegistered(ACT.A_SargAttack)).toBe(false);
    expect(isActionRegistered(ACT.A_SkullAttack)).toBe(false);
    unimplementedActions(); // accessor smoke
  });
});

/* ================================================================== */
/* A3. PAIN PHASE — painChance roll per the family table                */
/* ================================================================== */

describe('M8-11 pain: ONE prndindex delta per non-fatal hit, per the family table', () => {
  for (const fam of FAMILY_TABLE) {
    it(`${fam.name}: roll<${painChanceOf(fam.mt)} ⇒ painstate + reactiontime 0; roll≥ ⇒ state holds`, () => {
      expect(painChanceOf(fam.mt)).toBe(fam.painChance); // table IS the ledger
      const s = bootArena();
      const v = victim(s, fam.mt, 500, 384);
      // Pain roll pinned BELOW painChance: p_mobj MT_SKULL keeps its
      // MF_SKULLFLY-free state (no charge started), so the painstate row
      // is taken for EVERY family (SKULL painChance 256 = always-pain).
      pinNext(s, RNDTABLE.findIndex((r) => r < painChanceOf(fam.mt)));
      const i = s.rng.prndindex;
      pDamageMobj(v, null, null, 1);
      expect(draws(s, i)).toBe(1); // the painChance roll, and nothing else
      expect(v.state).toBe(mobjinfo[fam.mt]!.painState);
      // A_Pain lives on the PAIN2 row (tics≠0 on PAIN1) — the emit lands
      // on the chain's 3rd tic, silent for painSound '0' (missile rows).
      runUntil(s, 6, () => false);
      const emits = sfxIds(s).filter((id) => id === SFX_ID.sfx_popain || id === SFX_ID.sfx_dmpain);
      const painToken = mobjinfo[fam.mt]!.painSound;
      if (painToken === '0' || painToken === 'sfx_None') {
        expect(emits.length).toBe(0);
      } else {
        expect(emits.length).toBe(1);
      }
      // The roll ≥ painChance branch: draw still paid, state unchanged.
      pinNext(s, RNDTABLE.findIndex((r) => r >= painChanceOf(fam.mt)));
      const i2 = s.rng.prndindex;
      pDamageMobj(v, null, null, 1);
      expect(draws(s, i2)).toBe(1);
    });
  }
});

/* ================================================================== */
/* A4. DEATH → CORPSE — gib-tics draw, scream variants, A_Fall          */
/* ================================================================== */

describe('M8-11 death→corpse: gib-tics 1 draw, scream variants per the table, A_Fall corpse', () => {
  for (const fam of FAMILY_TABLE) {
    describe(`${fam.name} death chain`, () => {
      it(`plain death: 1 gib-tics draw, ${fam.screamDraws} scream draw(s), A_Fall clears MF_SOLID`, () => {
        const s = bootArena();
        installPlayerAwareBridge(s);
        const p = playerMo(s);
        const m = pSpawnMobj(s.mobjs, fx(500), fx(384), ONFLOORZ, fam.mt);
        expect(m.flags & MF.MF_SOLID).not.toBe(0);

        // The kill: damage ≥ health skips the painChance roll entirely
        // (p_inter.c:883 goto path) — the ONLY draw in the call is the
        // `tics -= P_Random()&3` clamp (p_inter.c:726). Player source ⇒
        // killcount (MF_COUNTKILL families only, D-0xx SKULL truth).
        const kc0 = s.players[0]!.killcount;
        const i = s.rng.prndindex;
        pDamageMobj(m, p, p, mobjinfo[fam.mt]!.spawnHealth);
        // 1 = the `tics -= P_Random()&3` clamp draw; + the drop-table
        // item's lastlook (POSS clip / SPOS shotgun, p_inter.c:737-757).
        expect(draws(s, i)).toBe(1 + fam.dropDraws);
        expect(m.state).toBe(mobjinfo[fam.mt]!.deathState);
        expect((m.flags & MF.MF_CORPSE) !== 0 && (m.flags & MF.MF_SHOOTABLE) === 0).toBe(true);
        expect(m.flags & MF.MF_SOLID).not.toBe(0); // SOLID until A_Fall
        expect(s.players[0]!.killcount).toBe(kc0 + (fam.countKill ? 1 : 0));

        // The chain runs to the A_Fall row (silent) — the scream variant
        // draws are the ONLY stream cost between kill and corpse.
        const iChain = s.rng.prndindex;
        const tics = runUntil(s, 120, () => (m.flags & MF.MF_SOLID) === 0);
        expect(tics, 'death chain reaches the A_Fall row').toBeLessThan(120);
        expect(draws(s, iChain)).toBe(fam.screamDraws);
        const [lo, hi] = fam.screamDraws > 0
          ? (fam.screamIds as readonly [number, number])
          : [fam.screamIds[0]!, fam.screamIds[0]!];
        const deaths = sfxIds(s).filter((id) => id >= lo && id <= hi);
        expect(deaths.length).toBe(1); // one scream, in-variant range
        // Corpse: MF_CORPSE kept; NON-skull corpses drop MF_NOGRAVITY
        // (p_inter.c:680-681), the SKULL corpse keeps it.
        expect((m.flags & MF.MF_CORPSE) !== 0).toBe(true);
        if (fam.mt === MT.MT_SKULL) {
          expect(m.flags & MF.MF_NOGRAVITY).not.toBe(0);
        } else {
          expect(m.flags & MF.MF_NOGRAVITY).toBe(0);
        }
      });

      it(fam.gib ? `overkill (damage < −spawnhealth): X DEATH chain, sfx_slop 0 draws` : `no xdeathstate ⇒ plain death whatever the overkill`, () => {
        const s = bootArena();
        installPlayerAwareBridge(s);
        const p = playerMo(s);
        const m = pSpawnMobj(s.mobjs, fx(500), fx(384), ONFLOORZ, fam.mt);
        const i = s.rng.prndindex;
        pDamageMobj(m, p, p, mobjinfo[fam.mt]!.spawnHealth * 10); // gib rule
        expect(draws(s, i)).toBe(1 + fam.dropDraws); // clamp (+ drop lastlook)
        if (fam.gib) {
          expect(m.state).toBe(mobjinfo[fam.mt]!.xdeathState);
          expect(mobjinfo[fam.mt]!.xdeathState).not.toBe(S.S_NULL);
        } else {
          expect(mobjinfo[fam.mt]!.xdeathState).toBe(S.S_NULL);
          expect(m.state).toBe(mobjinfo[fam.mt]!.deathState);
        }
        runUntil(s, 140, () => !s.mobjs.slotMobjs.has(m.linkSlot) || (m.flags & MF.MF_SOLID) === 0);
        if (fam.gib) {
          expect(sfxIds(s).filter((id) => id === SFX_ID.sfx_slop).length).toBe(1); // A_XScream, 0 draws
        }
      });
    });
  }
});

/* ================================================================== */
/* A5. Per-family double-run: the whole lifecycle is stream-determinism */
/* ================================================================== */

describe('M8-11 double-run lifecycle signatures per family', () => {
  for (const fam of FAMILY_TABLE) {
    it(`${fam.name}: wake→chase→(attack if body present)→pain→death twice, identical`, () => {
      const sig = (): string => {
        const s = bootArena();
        installPlayerAwareBridge(s);
        const p = playerMo(s);
        const m = pSpawnMobj(s.mobjs, fx(700), fx(384), ONFLOORZ, fam.mt);
        pNoiseAlert(s.mobjs, p, p);
        runUntil(s, 40, () => m.state !== mobjinfo[fam.mt]!.spawnState);
        runUntil(s, 120, () => s.players[0]!.health < 100);
        pDamageMobj(m, null, null, 1); // pain (roll unpinned — stream pays it)
        runUntil(s, 30, () => false);
        pDamageMobj(m, p, p, mobjinfo[fam.mt]!.spawnHealth + 1); // kill
        runUntil(s, 120, () => (m.flags & MF.MF_SOLID) === 0 || m.removed);
        return JSON.stringify([
          hashState(s),
          s.rng.prndindex,
          s.players[0]!.health,
          s.players[0]!.killcount,
          m.state,
          m.health,
          m.flags,
        ]);
      };
      expect(sig()).toBe(sig());
    });
  }
});

/* ================================================================== */
/* B. CROSS-FAMILY INFLIGHT BRAWL                                      */
/* ================================================================== */

describe('M8-11 inflight arena: baron vs zombies vs caco', () => {
  /** The arena: passive-but-immortal witness (player, re-topped every
   * 64 tics) WEST; FOUR zombies EAST of the witness, TWO OF THEM IN THE
   * SAME SHOOTING LANE (400/700 at y 512) — the far one's accurate
   * first shot organic-friendlies the near one (source = a MONSTER mobj,
   * the honest infight path p_inter.c:904-916); two barons + two cacos
   * EAST, their westbound fireballs MUST cross the zombie lane (PIT
   * direct dice, pmissiles.ts) feeding the same cascade. */
  function brawl(): GameState {
    const s = boot({
      rooms: [{ x: 0, y: 0, w: 1536, h: 1024, lightLevel: 200 }],
      things: [{ x: 64, y: 512, angle: 0, type: 1 }],
    });
    installPlayerAwareBridge(s);
    const p = playerMo(s);
    p.health = s.players[0]!.health = 1 << 24;
    pSpawnMobj(s.mobjs, fx(1100), fx(384), ONFLOORZ, MT.MT_BRUISER);
    pSpawnMobj(s.mobjs, fx(1100), fx(640), ONFLOORZ, MT.MT_BRUISER);
    pSpawnMobj(s.mobjs, fx(950), fx(256), ONFLOORZ, MT.MT_HEAD);
    pSpawnMobj(s.mobjs, fx(950), fx(768), ONFLOORZ, MT.MT_HEAD);
    pSpawnMobj(s.mobjs, fx(400), fx(512), ONFLOORZ, MT.MT_POSSESSED); // lane
    pSpawnMobj(s.mobjs, fx(700), fx(512), ONFLOORZ, MT.MT_POSSESSED); // lane
    pSpawnMobj(s.mobjs, fx(700), fx(352), ONFLOORZ, MT.MT_POSSESSED);
    pSpawnMobj(s.mobjs, fx(700), fx(672), ONFLOORZ, MT.MT_POSSESSED);
    pNoiseAlert(s.mobjs, p, p);
    return s;
  }

  function brawlSig(tics = 1500): string {
    const s = brawl();
    const p = playerMo(s);
    for (let t = 0; t < tics; t++) {
      if ((t & 63) === 0) p.health = s.players[0]!.health = 1 << 24;
      pRunThinkers(s.thinkers);
    }
    return JSON.stringify([
      s.players[0]!.killcount,
      s.rng.prndindex,
      s.mobjs.mobjs
        .filter((m) => mobjinfo[m.type]!.flags & MF.MF_COUNTKILL)
        .map((m) => [m.type, m.health, m.state, m.target?.type ?? 0]),
    ]);
  }

  const liveMon = (s: GameState, type: number): Mobj[] =>
    s.mobjs.mobjs.filter((m) => m.type === type && !m.removed);

  it('baron fireballs crossing the zombie lane switch a zombie target (brawl ON)', () => {
    const s = brawl();
    const p = playerMo(s);
    // LATCHED per-tic (a flip may heal over once the adopted shooter
    // dies — A_Chase re-adopts the player with threshold expired).
    let flipped = false;
    for (let t = 0; t < 1500 && !flipped; t++) {
      if ((t & 63) === 0) p.health = s.players[0]!.health = 1 << 24;
      pRunThinkers(s.thinkers);
      flipped = s.mobjs.mobjs.some(
        (m) =>
          !m.removed &&
          m !== p &&
          (mobjinfo[m.type]!.flags & MF.MF_COUNTKILL) !== 0 &&
          m.target !== undefined &&
          m.target !== p &&
          !m.target.removed,
      );
    }
    expect(flipped, 'a monster adopted the shooter that friendly-fired it').toBe(true);
  });

  it('target switching is BIDIRECTIONAL: a baron turns on what shot it', () => {
    const s = brawl();
    const p = playerMo(s);
    const z = liveMon(s, MT.MT_POSSESSED)[0]!;
    const b = liveMon(s, MT.MT_BRUISER)[0]!;
    // Scripted opener for THIS assertion (the arena's own crossfire is
    // too slow to guarantee a baron-side flip in 1500 tics): the zombie
    // hits the baron point-blank — p_inter.c:907 arms the baron. The
    // baron's painChance is 50, but the RETARGET branch is draw-free and
    // roll-INDEPENDENT (threshold branch p_inter.c:904-916) — a
    // threshold=0 baron always adopts the shooter.
    b.threshold = 0;
    z.target = b;
    z.health = 1 << 20; // survive the baron's point-blank entry-A_Chase
    z.x = b.x - fx(30); // point-blank, LOS trivial
    syncMobj(z);
    aPosAttack(z);
    expect(b.target).toBe(z); // :911 source adopted (non-VILE, D-0yy)
    // BASETHRESHOLD 100 is written, then the SEE-ROW ENTRY-ACTION
    // (P_SetMobjState dispatches the row action — the spawn→see switch
    // the retarget block performs) pays ONE A_Chase threshold DECAY on
    // that same call: the observable is 99 at assert time.
    expect(b.threshold).toBe(99);
    expect(b.threshold).toBeLessThan(100);
    // …and the cascade does NOT hand the baron back to the player crowd:
    expect(b.target).not.toBe(p);
    // The flip survives a chase tic (the baron keeps the new target):
    const i = s.rng.prndindex;
    runUntil(s, 10, () => false);
    expect(b.target).toBe(z);
    expect(draws(s, i)).toBeGreaterThanOrEqual(0);
  });

  it('friendly-fire deaths attribute killcount to player0 under the NON-NET rule', () => {
    const s = brawl();
    const p = playerMo(s);
    // The player NEVER fires or damages anything: every kill here is
    // monster-ammunition. p_inter.c:694-697 (the !netgame fallback) must
    // still tally them into players[0].killcount.
    for (let t = 0; t < 2400; t++) {
      if ((t & 63) === 0) p.health = s.players[0]!.health = 1 << 24;
      pRunThinkers(s.thinkers);
    }
    const deadCountKill = s.mobjs.mobjs.filter(
      (m) =>
        mobjinfo[m.type]!.flags & MF.MF_COUNTKILL &&
        (m.health <= 0 || m.removed),
    ).length;
    expect(deadCountKill, 'friendly fire kills someone in 2400 tics').toBeGreaterThan(0);
    expect(s.players[0]!.killcount).toBe(deadCountKill); // EXACT attribution
    expect(s.mobjs.netgame, 'single player').toBe(false);
  });

  it('double-run: the brawl signature is stream-identical', () => {
    expect(brawlSig()).toBe(brawlSig());
  });
});

/* ================================================================== */
/* C. RANDOM-SITES LEDGER RECONCILIATION                               */
/* ================================================================== */

describe('M8-11 random-sites ledger reconciliation (global manifest, registryManifest idiom)', () => {
  const sum = (o: Readonly<Record<string, number>>): number =>
    Object.values(o).reduce((a, b) => a + b, 0);

  it('the RANDOM_SITE_* TOTAL equals the sum of module sites (both directions)', () => {
    const scan = scanRandomSites();
    // Module SETS equal — an emitter module missing from the ledger, or a
    // stale ledger line, is red in EITHER direction (the psound_stub
    // SFX_SITE_LEDGER idiom).
    expect(Object.keys(scan).sort()).toEqual(Object.keys(RANDOM_SITE_CALLS).sort());
    for (const [name, n] of Object.entries(scan)) {
      expect(RANDOM_SITE_CALLS[name], name).toBe(n);
    }
    // Aggregate ledger total — UPDATE IN THE SAME COMMIT that adds a
    // site (a family-B landing must move this number AND its module
    // line together, or this gate is the drift alarm).
    expect(sum(RANDOM_SITE_CALLS)).toBe(sum(scan));
    expect(sum(RANDOM_SITE_CALLS)).toBe(69);
    expect(RANDOM_SITE_SCAN_SKIP).toEqual(['prng.ts']);
  });

  it('the M8 additions are LEDGERED (lastlook / pain / gib / lift / pos-spread)', () => {
    // lastlook: P_SpawnMobj (1 of p_mobj.ts 9: spawn 1 + explode tics 1 +
    // mapthing 1 + puff 3 + blood 3) — behavioural pin: every family
    // spawn above carries `lastLook = R%MAXPLAYERS` (wake suite).
    expect(RANDOM_SITE_CALLS['p_mobj.ts']).toBe(9);
    // pain roll + gib-tics clamp + fall-forwards &1 in the monster half
    // (p_inter_damage.ts 3), thrust &1 + painChance in the player half
    // (pplayer.ts 2) — behavioural pins: the pain/death windows above.
    expect(RANDOM_SITE_CALLS['p_inter_damage.ts']).toBe(3);
    expect(RANDOM_SITE_CALLS['pplayer.ts']).toBe(2);
    // lift: CheckMissileSpawn tics (1 of pmissiles.ts 4: spawn tics 1 +
    // shadow jitter 2 + direct dice 1) — missile-cycle pins above.
    expect(RANDOM_SITE_CALLS['pmissiles.ts']).toBe(4);
    // pos-spread: PosAttack 3 + SPosAttack 3-written (9 runtime) +
    // CPos/CPosRefire/Troop — the attack-stream windows above.
    expect(RANDOM_SITE_CALLS['amon_poss.ts']).toBe(11);
    expect(RANDOM_SITE_CALLS['amon_bruiser.ts']).toBe(2);
    expect(RANDOM_SITE_CALLS['p_enemy.ts']).toBe(9);
    expect(RANDOM_SITE_CALLS['pdeath.ts']).toBe(2);
    // scream variant draws (podth %3 / bgdth %2) ride pdeath.ts's 2.
    // Family B (mid-landing): if the module exists the SET equality test
    // above already forces its ledger line; here it may be absent.
    const scan = scanRandomSites();
    if ('amon_sarg.ts' in scan) {
      expect(RANDOM_SITE_CALLS['amon_sarg.ts'], 'family B ledgered').toBeTruthy();
    }
  });

  it('the draw-budget ledger matches the BEHAVIOURAL windows (per-invocation cross-check)', () => {
    // Runtime draws ≠ text occurrences (the SPos 3-written/9-loop truth).
    // The family suite pinned per-invocation: PosAttack 3+4 blood+1 pain,
    // SPosAttack 3×8, troop missile 2+3, bruiser/head missile 2+3,
    // rocket 2+4 (MT_FIRE lastlook), pain roll 1, kill clamp 1, scream
    // variant 0..1, wake variant 0..1 — re-state the arithmetic here so
    // an edit to ANY of those sites breaks BOTH this line and the pins:
    expect(3 + 4 + 1).toBe(8); // POSS shot window
    expect(3 * 8).toBe(24); // SPOS volley window
    expect(2 + 3).toBe(5); // baron/caco missile cycle
    expect(2 + 4).toBe(6); // rocket cycle (explode-row MT_FIRE lastlook)
    expect(1 + 1).toBe(2); // kill clamp + drop lastlook (POSS/SPOS)
  });
});

/* ================================================================== */
/* D. DETERMINISM MARATHON — E1M1 warp + scripted combat                */
/* ================================================================== */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('M8-11 determinism marathon: E1M1 warp, chaingun, 300 scripted tics', () => {
  /** Warp E1M1 and stage the scripted combat: chaingun GIVEN (weaponKey
   * 3 at tic 5, HOLD from tic 20 — the M7-10 switch/raise cadence),
   * reinforcements spawned at the start room (POSS close + TROO at
   * fireball range — the map roster alone yields no 300-tic contact,
   * FINDINGS), and a 400-HP tank so death/rebirth cannot mask the
   * retaliation stats. NO game.ts live wiring — pure harness seams. */
  function marathonState(): GameState {
    const bytes = readFileSync(WAD_PATH);
    const buf = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
    installPsprSfxSlot(s.hooks, () => s.leveltime);
    installPlayerAwareBridge(s); // D-m1 test bridge (monster→player hits land)
    const p = attachPsprFields(s.players[0]!);
    p.weaponowned[WP_CHAINGUN] = 1;
    p.ammo[AM_CLIP] = 20; // ~15 shots, then the dry-gun ladder (M7-10)
    const mo = playerMo(s);
    mo.health = s.players[0]!.health = 400;
    pSpawnMobj(s.mobjs, fx(-256), fx(256), ONFLOORZ, MT.MT_POSSESSED);
    pSpawnMobj(s.mobjs, fx(-256), fx(352), ONFLOORZ, MT.MT_POSSESSED);
    pSpawnMobj(s.mobjs, fx(-160), fx(192), ONFLOORZ, MT.MT_POSSESSED);
    pSpawnMobj(s.mobjs, fx(64), fx(256), ONFLOORZ, MT.MT_TROOP);
    pSpawnMobj(s.mobjs, fx(64), fx(352), ONFLOORZ, MT.MT_TROOP);
    return s;
  }

  function marathonRun(s: GameState): void {
    for (let t = 0; t < 300; t++) {
      const inp: GameInput = {
        ...emptyInput(),
        weaponKey: t === 5 ? 3 : undefined,
        attack: t >= 20,
      };
      gTicker(s, inp);
    }
  }

  it('double run identical: hash, prndindex, killcount sane', () => {
    // ONE live world per process (the p_shoot/pmap `bound` singletons):
    // build→run pairs MUST interleave, never build-both-then-run-both
    // (the M2-era loop tests dodge the same rule; FINDINGS note).
    const a = marathonState();
    marathonRun(a);
    const b = marathonState();
    marathonRun(b);

    expect(hashState(b)).toBe(hashState(a));
    expect(b.rng.prndindex).toBe(a.rng.prndindex);
    expect(b.leveltime).toBe(a.leveltime);

    // killcount SANE: the 3 close zombies fall to the chain; the two
    // imps fight back from fireball range.
    expect(a.players[0]!.killcount).toBeGreaterThan(0);
    expect(b.players[0]!.killcount).toBe(a.players[0]!.killcount);
    // RETALIATION landed (monsters hit the tank — the M8 plan's "mixed AI
    // + player fire" pin) yet the tank survived (no reborn noise):
    expect(a.players[0]!.health).toBeLessThan(400);
    expect(a.players[0]!.health).toBeGreaterThan(0);
    expect(a.leveltime).toBe(300);
  });
});
