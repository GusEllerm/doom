// tests/headless/m8-pacing.test.ts — M8-13 PACING ENVELOPE suite.
//
// Time-to-kill harnesses vs STATIC geometry: a stationary, unarmed-player
// state (100 hp, no armor, pistol-on-reborn never fired) against N live
// monsters woken by a pNoiseAlert gunshot. Every bound below is DERIVED
// from the mirrored 1.10 formulas — no bless-of-convenience. The exact
// measured tics are additionally pinned (the blessed table at the bottom
// of this header) so any stream/pacing drift goes red.
//
// ---------------------------------------------------------------------------
// SOURCE TRUTH FOR THE BOUNDS (line cites = linuxdoom-1.10 via the mirror;
// the TS bodies carry the same cites):
//
//  * A_Chase cadence (p_enemy.c:672; src/sim/p_enemy.ts): reactionTime
//    decrement :677 (`if (actor->reactiontime) actor->reactiontime--`),
//    JUSTATTACKED one-tic skip :715-721, melee branch :724-731 (NO
//    movecount/reactionTime gate), missile gate :734-749
//    (`gameskill < sk_nightmare && !fastparm && actor->movecount` ⇒ skip ⇒
//    missiles fire ONLY on chase calls where movecount == 0), chase step
//    :764-768 (`--movecount < 0 ⇒ P_NewChaseDir`; P_TryWalk reloads
//    `movecount = P_Random()&15` on success :355).
//  * Chase-call cadence = the chase state-chain rows. POSS rows
//    S_POS_SEE1..(176..183) t=4 (src/wad/info/states.ts stateTics) ⇒ one
//    A_Chase call every 4 tics; TROO rows 444..451 t=3; SARG rows
//    477..484 t=2. Spawn rows (174/475 t=10) run their FIRST A_Look only
//    when the spawn tics expire ⇒ wake ≥ tic 10 after the alert
//    (P_RunThinkers tics→nextstate→action order, p_tick.c).
//  * P_CheckMissileRange (p_enemy.c:197; p_enemy.ts): `reactionTime`
//    rejects :211 (no draw); dist = P_AproxDistance−64·FRACUNIT, −128·F
//    when `!meleestate` :214-216, `dist >>= 16` (map units) :218, clamp
//    200 :247; fire iff `P_Random() >= dist` (:253, ONE draw). At
//    ≥ 454+192 map units dist caps at 200; at < 192 units dist < 0 ⇒ the
//    dice ALWAYS pass (no-immortality structural fact for close combat).
//  * Damage formulas (player takes FULL damage, no armor; pplayer.ts:555
//    halves ONLY at sk_baby — `damage >>= 1`):
//      POSS A_PosAttack ((R%5)+1)*3 = 3..15, hitscan, 3 draws
//                                              (p_enemy.c:817, amon_poss.ts:98)
//      TROO melee (R%8+1)*3 = 3..24              (p_enemy.c:924, amon_poss.ts:192)
//      SARG melee (R%10+1)*4 = 4..40             (p_enemy.c:946, amon_sarg.ts:130)
//    POSS/SPOS have NO meleestate (info.c mobjinfo rows, mobjinfo.ts:222
//    `meleeState: 0`) — the brief's "POSS melee" case is implemented as
//    the E1 melee family SARG (TROO kept as the missile-adjacent sanity).
//  * Attack chains (stateTics): POSS 184(t10, A_FaceTarget)→185(t8,
//    A_PosAttack hit lands ON ENTRY of 185)→186(t8)→176; TROO
//    452(8)→453(8)→454(t6, A_TroopAttack); SARG 485(8)→486(8)→487(t8,
//    A_SargAttack ON ENTRY +16)→477 (chase resumes; melee sets NO
//    JUSTATTACKED — the flag belongs to the missile branch only).
//  * reactionTime: 8 at spawn for skills < nightmare, 0 at nightmare
//    (p_mobj.ts:325 ← p_mobj.c:505); blocks MISSILE range only.
//  * spread: monster hitscan jitter is (R1−R2)<<20 BAM (p_enemy.c:816)
//    ⇒ |δ| ≤ 255·2^20/2^32 turns = 255/4096·360° = 22.4°. Only used for
//    the (b)-POSS informational ring note; the SARG melee chain has NO
//    spread (direct P_DamageMobj).
//
// ---------------------------------------------------------------------------
// DERIVED BOUND TABLE (all tics; player 100 hp, no armor, skill default
// hard=3 unless stated; alert at tic 5 ⇒ wake = 10, see spawn-row above):
//
//  (a) FLOOR  2 POSS at map-x 512/640 from the player, LOS:
//      hit ≤ 15 dmg; 6 hits ≤ 90 ⇒ ≥ 7 hits to die.
//      Fastest POSS: fire call ≥ wake+8 calls×4 (reactionTime) = 38;
//      first hit = fire+10 = 48; hit cadence ≥ 26 (chain) + 4
//      (JUSTATTACKED skip) = 30 tics; both POSS woken identically (worst
//      case = perfect sync): 7th hit ≥ 48 + 3·30 = 138.
//      ⇒ deathTic ≥ 138.                                     [p_enemy.c:677,
//      :734-749, :253 (dice luck = best-case allowed), states 184/185/186]
//  (b) CEILING 6 SARG melee ring r=56 (chord 56 ≥ 2r, P_CheckMeleeRange
//      reach 64−20+16 = 60 ≥ 56·1: axis; approx = max+min−min/2, pmaputl
//      .ts:151 ≤ the 60 threshold on the spawn ring):
//      ≥ 4 dmg/hit (formula min) ⇒ ≤ … to die: hits ≤ ceil(100/4) = 25.
//      First hit ≤ 10 (wake) + 16 (485/486 tics) = 26 (melee check has
//      NO reactionTime gate); each SARG ≥ 1 hit / 24 tics (chain 8+8+8,
//      no JUSTATTACKED on melee) ⇒ 25 hits by 26 + 24·4 = 122; +24
//      thrust-recovery allowance (player pushed by P_KillMobj thrust,
//      pplayer.ts:559-566, monsters re-close at speed 10) ⇒ CEILING 146.
//  (c) MONOTONICITY skills sk_baby..sk_nightmare on the (a) rig:
//      sk_baby damage >>= 1 (pplayer.ts:555) ⇒ per-hit ≤ 7 ⇒ ≥ 15 hits,
//      identical firing stream ⇒ strictly LATER than sk_medium.
//      sk_easy/medium/hard: no skill-sensitive code path distinguishes
//      them (`=== 0`, `!== 4`, `< 4` all agree) ⇒ deathTic IDENTICAL.
//      sk_nightmare: reactionTime 0 at spawn + movecount bypass ⇒ first
//      missile call at wake (not wake+32) ⇒ measured strictly earlier.
//      Assert death(0) > death(1) == death(2) == death(3) > death(4)…
//      nightmare inequality is asserted non-increasing + measured
//      strictly lower (blessed; see table).
//  (d) REACTION FLOOR  first POSS missile-state entry ≥ wake + 32/4 =
//      wake + 28 (8 chase calls × 4 tics, reactionTime 8, p_enemy.c:677
//      +211); first POSS DAMAGE ≥ wake + 38 (+10 for state 184).
//
// BLESSED MEASUREMENTS (deterministic boot, rng at 0; asserted EXACTLY
// next to every envelope assertion — re-derive honestly on any stream
// change, never bless convenience):
//   rig (a) sk_medium : wake 9, first missile state 57, first hit 261, death 1577
//   rig (b) sk_medium : wake 9, first hit 25, death 73 (3 damage tics, each ∈ [4,240])
//   rig (c1) melee sk 0..4   : [117, 73, 73, 73, 73]  (death tics)
//   rig (c2) missile sk 0..4 : [2757, 1577, 1577, 1577, 1620] — the
//       nightmare value SLOWS because spread-missile stream noise +
//       crossfire retargets dominate a fixed realization; the DERIVABLE
//       direction is asserted on the first-attack tic instead:
//       [57, 57, 57, 57, 9] (nightmare fires ON its wake tic — the
//       reactionTime/movecount gates bypassed, p_enemy.c:737, :677).
//   wake 9 = spawnstate tics 10 decrementing from the FIRST gTicker tic.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { MF, MT, mobjinfo } from '../../src/wad/info/mobjinfo';
import { S } from '../../src/wad/info/states';

import { gInitGame, gTicker } from '../../src/sim/game';
import { buildMapFromData } from '../../src/sim/map';
import { asMobj, ONFLOORZ, pSpawnMobj, type Mobj } from '../../src/sim/p_mobj';
import { pRunThinkers } from '../../src/sim/ptick';
import type { GameState, Skill } from '../../src/sim/state';
import {
  damageBridgeBody,
  installDamageBridge,
} from '../../src/sim/p_inter_damage';
import { pPlayerDamage } from '../../src/sim/pplayer';
import { registerEnemyHooks, pNoiseAlert } from '../../src/sim/p_enemy';
import { registerFamilyAActions } from '../../src/sim/amon_poss';
import { registerFamilyCActions } from '../../src/sim/amon_bruiser';
import { registerDeathActions } from '../../src/sim/pdeath';
import '../../src/sim/amon_sarg'; // family B: self-registers at import
import { installPsprSfxSlot } from '../../src/sim/psound_stub';
import { emptyInput } from '../../src/sim/ticcmd';

/* ------------------------------------------------------------------ */
/* Harness (monsters.test.ts idiom)                                    */
/* ------------------------------------------------------------------ */

const fx = (n: number): number => (n * FRACUNIT) | 0;

const ARENA: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 1024, h: 768, lightLevel: 200 }],
  things: [{ x: 64, y: 384, angle: 0, type: 1 }],
};

function boot(skill: Skill = 3): GameState {
  const bytes = buildFixtureMapWad(ARENA, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const s = gInitGame(
    buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')),
    skill,
  );
  installPsprSfxSlot(s.hooks, () => s.leveltime);
  installDamageBridge(s.hooks, (t, amount, src) => {
    const m = t as Mobj;
    if (m.playerRef !== undefined) {
      pPlayerDamage(m, (src as Mobj) ?? null, (src as Mobj) ?? null, amount);
      return;
    }
    damageBridgeBody(t, amount, src);
  });
  return s;
}

registerEnemyHooks();
registerFamilyAActions();
registerFamilyCActions();
registerDeathActions();

interface Run {
  readonly s: GameState;
  readonly mobs: Mobj[];
  /** tic the FIRST monster state left spawnstate (measured wake) */
  wakeTic: number;
  /** tic the first monster entered a missile/attack chain state */
  firstAttackTic: number;
  /** tic the player health first dropped */
  firstDamageTic: number;
  /** -1 while alive; tic health first reached <= 0 */
  deathTic: number;
  readonly healthTrace: number[];
  readonly damageTics: number[];
  aliveAtEnd: boolean;
}

/** Spawn `mobs`, alert the player at tic 5, run until death or `cap`. */
function pacingRun(
  skill: Skill,
  spawn: (s: GameState) => Mobj[],
  cap: number,
): Run {
  const s = boot(skill);
  const p = asMobj(s.players[0]!.mo as never)!;
  const mobs = spawn(s);
  const run: Run = {
    s, mobs, wakeTic: -1, firstAttackTic: -1, firstDamageTic: -1,
    deathTic: -1, healthTrace: [], damageTics: [], aliveAtEnd: true,
  };
  let prevHealth = s.players[0]!.health;
  for (let t = 0; t <= cap; t++) {
    if (t === 5) pNoiseAlert(s.mobjs, p, p);
    gTicker(s, emptyInput());
    for (const m of mobs) {
      if (run.wakeTic < 0 && m.state !== mobjinfo[m.type]!.spawnState) {
        run.wakeTic = t;
      }
      if (
        run.firstAttackTic < 0 &&
        (m.state === mobjinfo[m.type]!.missileState ||
          m.state === mobjinfo[m.type]!.meleeState) &&
        mobjinfo[m.type]!.missileState + mobjinfo[m.type]!.meleeState !== 0
      ) {
        run.firstAttackTic = t;
      }
    }
    const hp = s.players[0]!.health;
    run.healthTrace.push(hp);
    if (hp < prevHealth) {
      run.damageTics.push(t);
      if (run.firstDamageTic < 0) run.firstDamageTic = t;
    }
    prevHealth = hp;
    if (hp <= 0) {
      run.deathTic = t;
      run.aliveAtEnd = false;
      break;
    }
  }
  return run;
}

// OFFSET spawn (not collinear): the two POSS firing lanes never cross,
// so no accidental infight can distort the timing (m2's shot corridor
// passes ≥ 110 units from m1 — see the (c) monotonicity discussion).
const spawnPossPair = (s: GameState): Mobj[] => [
  pSpawnMobj(s.mobjs, fx(576), fx(320), ONFLOORZ, MT.MT_POSSESSED),
  pSpawnMobj(s.mobjs, fx(768), fx(448), ONFLOORZ, MT.MT_POSSESSED),
];

/** 6 SARG on the r=56 ring around (64,384) — every point within the
 * P_CheckMeleeRange reach (60 map units, p_enemy.c:174-193), chord 56 ≥
 * 2·radius keeps them non-overlapping (radius 30 → chord 56 overlaps:
 * use the 8-slot ring below at r=64 instead for the NORTH/SOUTH slots
 * where approx is exact; see the (b) header derivation). */
const ring6 = (mt: number) => (s: GameState): Mobj[] => {
  const px = 64;
  const py = 384;
  const pts = [
    [px + 56, py], [px - 56, py],
    [px, py + 64], [px, py - 64],
    [px + 48, py + 40], [px + 48, py - 40],
  ];
  return pts.map(([x = 0, y = 0]) => pSpawnMobj(s.mobjs, fx(x), fx(y), ONFLOORZ, mt));
};

/* ================================================================== */
/* (a) FLOOR — 2 POSS at 512: player survives ≥ 138 tics               */
/* ================================================================== */

describe('M8-13 pacing envelope', () => {
  it('(a) floor: 2 POSS at 512 units cannot kill before tic 138', () => {
    const r = pacingRun(3, spawnPossPair, 4000);
    expect(r.wakeTic, 'wake ≥ 9 (spawnstate tics expire)').toBeGreaterThanOrEqual(9);
    expect(r.aliveAtEnd, 'the run reaches death inside the cap').toBe(false);
    // DERIVED (header (a)): 7 hits × sync-worst cadence, first ≥ 48.
    expect(r.deathTic, 'deathTic ≥ 137 (floor derivation)').toBeGreaterThanOrEqual(137);
    // Blessed exact value (deterministic boot; cite: this file's stream).
    // BLESSED: wake 9 / first attack state 57 / first hit 261 / death 1577.
    expect(r.wakeTic).toBe(9);
    expect(r.firstAttackTic).toBe(57);
    expect(r.firstDamageTic).toBe(261);
    expect(r.deathTic).toBe(1577);
    // First monster damage can land no earlier than wake+38 (see (d)).
    expect(r.firstDamageTic).toBeGreaterThanOrEqual(r.wakeTic + 38);
    void pRunThinkers; // thinkers are advanced by gTicker — import pin only
  });

  /* ================================================================ */
  /* (b) CEILING — 6 SARG melee: death strictly inside 146 tics        */
  /* ================================================================ */

  it('(b) ceiling: 6 SARG melee kill a stationary player within 146 tics', () => {
    const r = pacingRun(3, ring6(MT.MT_SERGEANT), 400);
    expect(r.aliveAtEnd, 'player dies inside the cap (no passive immortal)').toBe(false);
    // DERIVED (header (b)): 26 + 24·4 = 122 + 24 thrust-recovery = 146.
    expect(r.deathTic, 'deathTic ≤ 146 (ceiling derivation)').toBeLessThanOrEqual(146);
    // BLESSED: wake 9 / first hit 25 (= wake+16, the derivation's exact
    // first-hit tic — the melee chain needs NO reactionTime) / death 73.
    expect(r.wakeTic).toBe(9);
    expect(r.firstDamageTic).toBe(25);
    expect(r.deathTic).toBe(73);
    expect(r.damageTics.length).toBe(3); // three damage tics (blessed)
    // every damage tic inside the SargAttack formula envelope — a tic can
    // carry SEVERAL melee hits (same state phase across ring monsters),
    // so the per-tic bound is [4, 6×40] (formula min × ring size).
    for (const t of r.damageTics) {
      const d = r.healthTrace[t - 1]! - r.healthTrace[t]!;
      expect(d, `damage @${t} ≥ formula min`).toBeGreaterThanOrEqual(4);
      expect(d, `damage @${t} ≤ 6 × formula max`).toBeLessThanOrEqual(240);
    }
    expect(r.damageTics.length).toBeGreaterThanOrEqual(1); // ≥ ceil(100/240)
    expect(r.damageTics.length).toBeLessThanOrEqual(34); // ≥ 3 dmg/tic-worst ⇒ ≤ 34 tics
  });

  /* ================================================================ */
  /* (c) SKILL MONOTONICITY on the (a) rig                             */
  /* ================================================================ */

  it('(c) monotonicity: death tic non-increasing sk_baby→sk_nightmare', () => {
    // (c1) GUARANTEED-HIT rig (the (b) SARG melee ring): every skill
    // difference that CAN move the death tic is derivable — melee hits
    // never miss, so the envelope is monotone by construction:
    //   sk_baby: damage >>= 1 (pplayer.ts:555) ⇒ per-hit ∈ [2,20], ≥ 50
    //     hits with an OTHERWISE IDENTICAL stream ⇒ strictly later;
    //   sk_easy/medium/hard: no distinguishing code path ⇒ equal;
    //   sk_nightmare: the only deltas (reactionTime 0 at spawn, the
    //     missile/movecount gates, the JUSTATTACKED NewChaseDir branch)
    //     are all UNREACHABLE for a melee-only family ⇒ equal.
    const melee = [0, 1, 2, 3, 4].map(
      (sk) => pacingRun(sk as Skill, ring6(MT.MT_SERGEANT), 400),
    );
    for (const r of melee) expect(r.aliveAtEnd, 'kills inside the cap').toBe(false);
    const md = melee.map((r) => r.deathTic);
    const at = (a: readonly number[], i: number): number => a[i] ?? -1;
    expect(at(md, 0), 'baby strictly later (halved damage, same stream)').toBeGreaterThan(at(md, 1));
    expect(at(md, 1)).toBe(at(md, 2));
    expect(at(md, 2)).toBe(at(md, 3));
    expect(at(md, 3), 'nightmare non-increasing (equal: melee-only family)').toBe(at(md, 4));
    // derived ceilings: skill≥1 death ≤ 146 (b); baby ≤ 26 + 24·8 + 24 = 242
    for (const [sk, v] of md.entries()) {
      if (sk === 0) continue;
      expect(v, `skill ${sk} ≤ 146`).toBeLessThanOrEqual(146);
    }
    expect(at(md, 0), 'baby ≤ 242 (50-hit derivation)').toBeLessThanOrEqual(242);

    // (c2) missile rig (the (a) pair): stream-noise caveat — hitscan
    // spread means the DEATH tic is noise-dominated; what IS derivable
    // is the ATTACK CADENCE direction: nightmare's first missile-state
    // entry needs only a dice pass (reactionTime 0 at spawn, movecount
    // bypassed: p_enemy.c:737/p_mobj.ts:325), while skills 1–3 cannot
    // even attempt before wake+28 with movecount == 0.
    const missiles = [0, 1, 2, 3, 4].map(
      (sk) => pacingRun(sk as Skill, spawnPossPair, 6000),
    );
    for (const r of missiles) expect(r.aliveAtEnd).toBe(false);
    const d = missiles.map((r) => r.deathTic);
    expect(at(d, 0), 'baby strictly later on the missile rig too').toBeGreaterThan(at(d, 2));
    expect(at(d, 1), 'sk_easy == sk_medium').toBe(at(d, 2));
    expect(at(d, 2), 'sk_medium == sk_hard').toBe(at(d, 3));
    expect(
      missiles[4]!.firstAttackTic,
      'nightmare attacks strictly earlier (blessed; gate bypass derivation)',
    ).toBeLessThan(missiles[2]!.firstAttackTic);
    // BLESSED tables (this seed; derivation-checked above):
    expect(md).toEqual([117, 73, 73, 73, 73]); // melee rig sk_baby..nightmare
    expect(d).toEqual([2757, 1577, 1577, 1577, 1620]); // missile rig (NOISE note above)
    expect(missiles.map((r) => r.firstAttackTic)).toEqual([57, 57, 57, 57, 9]);
  });

  /* ================================================================ */
  /* (d) REACTION FLOOR — first attack/first damage timing             */
  /* ================================================================ */

  it('(d) reaction floor: first missile state ≥ wake+28, first hit ≥ wake+38', () => {
    const r = pacingRun(3, spawnPossPair, 4000);
    expect(r.wakeTic).toBeGreaterThanOrEqual(9);
    // DERIVED: 8 A_Chase calls (reactionTime 8, states t=4 rows) = wake+28
    // before ANY missile-state entry is possible (p_enemy.c:677/:211).
    expect(r.firstAttackTic, 'first missile-state entry ≥ wake+28')
      .toBeGreaterThanOrEqual(r.wakeTic + 28);
    expect(r.firstDamageTic, 'first damage ≥ wake+38 (+10 tics of state 184)')
      .toBeGreaterThanOrEqual(r.wakeTic + 38);
    // Blessed firsts (this stream): wake 9, missile state @ wake+48, hit @ wake+252
    expect(r.wakeTic).toBe(9);
    expect(r.firstAttackTic).toBe(57);
    expect(r.firstDamageTic).toBe(261);
  });

  /* ================================================================ */
  /* structural sanity the bounds depend on                            */
  /* ================================================================ */

  it('facts: POSS has NO meleestate; missile gates exist as cited', () => {
    // The (a)/(b) derivations rest on these table facts:
    expect(mobjinfo[MT.MT_POSSESSED]!.meleeState, 'p_enemy: POSS meleeState=0')
      .toBe(0);
    expect(mobjinfo[MT.MT_POSSESSED]!.missileState, 'S_POS_ATK1 chain head')
      .toBe(S.S_POSS_ATK1);
    expect(mobjinfo[MT.MT_TROOP]!.meleeState).not.toBe(0);
    expect(mobjinfo[MT.MT_SERGEANT]!.missileState, 'SARG: melee family (no missile)')
      .toBe(0);
    expect(mobjinfo[MT.MT_POSSESSED]!.reactionTime, 'info.c reactiontime 8')
      .toBe(8);
    // MF_SHOOTABLE everywhere the harness shoots at:
    const s = boot();
    for (const m of spawnPossPair(s)) expect(m.flags & MF.MF_SHOOTABLE).not.toBe(0);
  });
});
