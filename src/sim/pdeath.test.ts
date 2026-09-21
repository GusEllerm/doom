// sim/pdeath.test.ts — M8-06 acceptance (M8-plan §M8-06).
//
// Coverage (each pin names the 1.10 line it mirrors; mirror re-read THIS
// pass — the raw p_enemy.c/info.c/p_inter.c are the arbiters):
//  1. IMP DEATH CHAIN (acceptance 1): damage > health ⇒ painChance path
//     skipped ⇒ P_KillMobj deathstate ⇒ `tics -= P_Random()&3` clamp draw
//     (p_inter.c:726) ⇒ chain S_TROO_DIE1(8) → DIE2(8, A_Scream ENTRY,
//     p_enemy.c:1535, info.c:593-597) → DIE3(6) → DIE4(6, A_Fall ENTRY,
//     :1585) → DIE5(-1). NOTE: the plan prose says "DIE1 5 tics, A_Fall on
//     DIE3" — info.c:593-597 says 8/8/6/6 with A_Scream on DIE2 and A_Fall
//     on DIE4; the SOURCE governs (plan §0.0). MF_SOLID clears EXACTLY on
//     the A_Fall row — before it the corpse is MF_CORPSE|MF_SOLID,
//     height/4 (SHRINK: p_inter.c:680-681, the M8-05 pKillMobj, NOT an
//     A_* action — the death-state entry of P_KillMobj runs the corpse
//     block BEFORE P_SetMobjState, so by the first DIE1 tic the height is
//     already 14 and SOLID is still set);
//  2. XDIE CHAIN (acceptance 2): damage < -spawnhealth ⇒ S_TROO_XDIE1 →
//     XDIE2 A_XScream = sfx_slop (:1574) → XDIE4 A_Fall → XDIE8(-1);
//  3. SCREAM VARIANT TABLE (acceptance 3 + "one line per MT_*"): podth*
//     runs %3, bgdth* runs %2, everything else the plain deathsound with
//     ZERO draws, SPID/CYB via NULL origin (:1561-1567);
//  4. SILENCE: A_Pain and A_Fall draw NO PRNG (:1577-1591 — the whole
//     pain/death sound budget is one emit for Pain, zero for Fall);
//     A_Pain silent for painSound 'sfx_None' (info.c missile rows);
//  5. CORPSE MOVEMENT: P_CheckPosition at the corpse spot BLOCKED while
//     SOLID, PASSABLE the tic A_Fall runs — through the ThingLinks mirror
//     (links.flags is what pitCheckThing reads, pmap.ts:334);
//  6. MF_DROPOFF (p_map.c:481 "don't stand over a dropoff"): a living
//     monster refuses the 64-unit ledge, the SAME monster as a corpse
//     (P_KillMobj just wrote MF_CORPSE|MF_DROPOFF, p_inter.c:680) accepts
//     standing over it;
//  7. SHADOWS (acceptance 4): S_SARG_DIE rows, sfx_sgtdth, A_Scream/
//     A_Fall at the SARG positions (info.c:626-631; doomednum 58 reuses
//     doomednum 7's states);
//  8. LEDGERS: SFX_SITE_LEDGER['pdeath.ts'] and RANDOM_SITE_CALLS
//     ['pdeath.ts'] pinned (the scan tests in ppalette/random-sites do
//     the bidirectional audit);
//  9. determinism: the whole chain run twice in-process, identical
//     signature.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MF, MT, mobjinfo } from '../wad/info/mobjinfo';
import { S } from '../wad/info/states';

import { gInitGame } from './game';
import { buildMapFromData } from './map';
import { ONFLOORZ, pSpawnMobj, syncMobj, type Mobj } from './p_mobj';
import { hashState, type GameState } from './state';
import { pRunThinkers } from './ptick';
import { RNDTABLE } from './prng';
import { pDamageMobj } from './p_inter_damage';
import { aFall, aPain, aScream, aXScream } from './pdeath';
import { isActionRegistered, ACT } from './a_actions';
import { pCheckPosition, pTryMove } from './pmap';
import { asMobj } from './p_mobj';
import { SFX_SITE_LEDGER, SFX_ID, resolveSfxId } from './psound_stub';
import { RANDOM_SITE_CALLS } from './random-sites';

const fx = (n: number): number => (n * FRACUNIT) | 0;

function boot(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), 2);
}

/** One 1024x512 room, player start west (type = doomednum in THINGS). */
function room(things: RectMapSpec['things'] = []): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 1024, h: 512, lightLevel: 200 }],
    things: [{ x: 64, y: 256, angle: 0, type: 1 }, ...things],
  };
}

/** The ledge fixture (pmap.test.ts M5-03): room A floor 64, room B floor
 * 0 — the dropoff line at x = 128. */
const LEDGE: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 128, floorHeight: 64 },
    { x: 128, y: 0, w: 128, h: 128 },
  ],
  things: [{ x: 32, y: 32, angle: 0, type: 1 }],
};

function playerMo(s: GameState): Mobj {
  return asMobj(s.players[0]!.mo as never)!;
}

function spawned(s: GameState, type: number, x: number, y: number): Mobj {
  return pSpawnMobj(s.mobjs, fx(x), fx(y), ONFLOORZ, type, -1, {
    skipLastLookRandom: true,
  });
}

const draws = (s: GameState, from: number): number => (s.rng.prndindex - from) & 0xff;

/** Set prndindex so the NEXT draw lands on table index k. */
function pin(s: GameState, k: number): void {
  s.rng.prndindex = (k - 1) & 0xff;
}

/** Index whose RNDTABLE value passes pred. */
function indexWhere(pred: (v: number) => boolean): number {
  const k = RNDTABLE.findIndex((v) => pred(v));
  expect(k, 'RNDTABLE has an index passing the predicate').toBeGreaterThan(-1);
  return k;
}

/** CONSECUTIVE index pair: draw1 passes a, draw2 passes b. */
function pinPair(s: GameState, a: (v: number) => boolean, b: (v: number) => boolean): void {
  for (let i = 0; i < 256; i++) {
    if (a(RNDTABLE[i]!) && b(RNDTABLE[(i + 1) & 0xff]!)) {
      pin(s, i);
      return;
    }
  }
  throw new Error('no consecutive index pair satisfies both predicates');
}

const sfxIds = (s: GameState): number[] => s.hooks.sfx.entries.map((e) => e.id);

/** Tick (thinkers only — p_inter_damage.test.ts idiom) until the victim
 * enters `state`; returns the tic count. */
function tickUntil(s: GameState, m: Mobj, state: number, max = 64): number {
  for (let t = 1; t <= max; t++) {
    pRunThinkers(s.thinkers);
    if (m.state === state) return t;
  }
  throw new Error(`state ${state} not reached within ${max} tics`);
}

describe('pdeath (M8-06): A_Pain / A_Scream / A_XScream / A_Fall', () => {
  it('the four ids are registered (25/33/28/27)', () => {
    expect([
      isActionRegistered(ACT.A_Pain),
      isActionRegistered(ACT.A_Scream),
      isActionRegistered(ACT.A_XScream),
      isActionRegistered(ACT.A_Fall),
    ]).toEqual([true, true, true, true]);
  });

  /* -------------------------------------------------------------- */
  /* 1. imp death chain: kill → DIE2 scream → DIE4 fall             */
  /* -------------------------------------------------------------- */
  it('death chain: deathstate + clamp draw, A_Scream on DIE2, MF_SOLID cleared EXACTLY on the A_Fall row (DIE4)', () => {
    const s = boot(room([{ x: 400, y: 256, angle: 0, type: 3001 }]));
    const imp = s.mobjs.mobjs.find((m) => m.type === MT.MT_TROOP && !m.removed)!;
    expect(imp.flags & MF.MF_SOLID).toBeGreaterThan(0);
    expect(imp.height).toBe(fx(56));

    // clamp draw: &3 == 0 (tics stay 8); scream draw: %2 == 1 (bgdth2=63)
    pinPair(s, (v) => (v & 3) === 0, (v) => v % 2 === 1);
    const idx = s.rng.prndindex;
    pDamageMobj(imp, null, playerMo(s), 60); // health 60-60 = 0 → kill

    // P_KillMobj half (p_inter.c:672-681 + :721/:725/:726) — SHRINK TRUTH:
    // height >>= 2 and MF_CORPSE|MF_DROPOFF are P_KillMobj's (M8-05 core),
    // NOT an A_* first-tic — MF_SOLID untouched (p_inter.c:705 clears it
    // only for PLAYER victims).
    expect(imp.state).toBe(S.S_TROO_DIE1);
    expect(imp.flags & MF.MF_CORPSE).toBeGreaterThan(0);
    expect(imp.flags & MF.MF_DROPOFF).toBeGreaterThan(0);
    expect(imp.flags & MF.MF_SHOOTABLE).toBe(0);
    expect(imp.flags & MF.MF_SOLID).toBeGreaterThan(0); // SOLID until A_Fall
    expect(imp.height).toBe(fx(56) >> 2); // 14 units — p_inter.c:681
    expect(imp.tics).toBe(8); // clamp draw landed &3 == 0
    expect(draws(s, idx)).toBe(1); // EXACTLY the clamp draw (p_inter.c:726)
    expect(s.hooks.sfx.count).toBe(0); // P_KillMobj is SILENT (the
    // I_StartSound line at p_inter.c:733 is COMMENTED OUT in the source)
    expect(s.players[0]!.killcount).toBe(1); // MF_COUNTKILL, player source

    // DIE1 (8) → DIE2: A_Scream fires on ENTRY (info.c:594).
    const t = tickUntil(s, imp, S.S_TROO_DIE2);
    expect(t).toBe(8); // 8 clamp-untouched tics of DIE1
    expect(sfxIds(s)).toEqual([SFX_ID.sfx_bgdth2]); // 62 + (draw %2 == 1)
    const e = s.hooks.sfx.entries[0]!;
    expect([e.x, e.y, e.z]).toEqual([imp.x, imp.y, imp.z]); // actor origin
    expect(draws(s, idx)).toBe(2); // clamp + the single %2 select
    expect(imp.flags & MF.MF_SOLID).toBeGreaterThan(0); // still SOLID
    expect(s.hooks.sfx.count).toBe(1);

    // DIE2 (8) + DIE3 (6) → DIE4: A_Fall clears MF_SOLID THIS tic.
    tickUntil(s, imp, S.S_TROO_DIE4);
    expect(imp.flags & MF.MF_SOLID).toBe(0);
    expect(s.hooks.sfx.count).toBe(1); // A_Fall emits NOTHING (:1585-1591)
    expect(draws(s, idx)).toBe(2); // A_Fall draws NOTHING
    tickUntil(s, imp, S.S_TROO_DIE5);
    expect(imp.tics).toBe(-1); // the forever corpse row
    expect(imp.removed).toBe(false); // corpses are NOT removed (S_NULL never runs)
  });

  /* -------------------------------------------------------------- */
  /* 2. gib chain                                                     */
  /* -------------------------------------------------------------- */
  it('xdeath chain: damage < -spawnhealth → XDIE1 → XDIE2 A_XScream (sfx_slop) → XDIE4 fall → XDIE8', () => {
    const s = boot(room([{ x: 400, y: 256, angle: 0, type: 3001 }]));
    const imp = s.mobjs.mobjs.find((m) => m.type === MT.MT_TROOP)!;
    pin(s, indexWhere((v) => (v & 3) === 0));
    const idx = s.rng.prndindex;
    pDamageMobj(imp, null, playerMo(s), 1000); // 60-1000 = -940 < -60
    expect(imp.state).toBe(S.S_TROO_XDIE1);
    expect(imp.tics).toBe(5); // info.c:598 (5 tics, clamp &3 == 0)
    tickUntil(s, imp, S.S_TROO_XDIE2);
    expect(sfxIds(s)).toEqual([SFX_ID.sfx_slop]); // 31, :1574 — no variant,
    // no draw: the ONLY draw of the whole gib chain is the kill clamp.
    expect(draws(s, idx)).toBe(1);
    tickUntil(s, imp, S.S_TROO_XDIE4);
    expect(imp.flags & MF.MF_SOLID).toBe(0); // A_Fall row (info.c:601)
    tickUntil(s, imp, S.S_TROO_XDIE8);
    expect(imp.tics).toBe(-1); // XDIE8 -1 (info.c:605) — corpse persists
    expect(s.hooks.sfx.count).toBe(1);
  });

  /* -------------------------------------------------------------- */
  /* 3. scream variant table — one line per MT_*                      */
  /* -------------------------------------------------------------- */
  it('A_Scream family table: podth %3, bgdth %2, default = plain deathsound (0 draws), SPID/CYB full volume', () => {
    const s = boot(room());
    const pod = indexWhere((v) => v % 3 === 2);
    const bg = indexWhere((v) => v % 2 === 1);
    // [MT, expected emit id, variant draws? (1 = exactly one P_Random)]
    const table: [number, number, 'podth' | 'bgdth' | 'plain'][] = [
      [MT.MT_POSSESSED, SFX_ID.sfx_podth1 + 2, 'podth'], // 59 + %3 → 61
      [MT.MT_SHOTGUY, SFX_ID.sfx_podth1 + 2, 'podth'], // podth2 token still joins the 59..61 RUN (:1544-1548)
      [MT.MT_TROOP, SFX_ID.sfx_bgdth1 + 1, 'bgdth'], // 62 + %2 → 63
      [MT.MT_SERGEANT, SFX_ID.sfx_sgtdth, 'plain'], // 64
      [MT.MT_SHADOWS, SFX_ID.sfx_sgtdth, 'plain'], // 64 (shares the SARG rows)
      [MT.MT_HEAD, SFX_ID.sfx_cacdth, 'plain'], // 65
      [MT.MT_SKULL, SFX_ID.sfx_firxpl, 'plain'], // 17 — info.c:1593: the lost soul's deathsound is firxpl; sfx_skldth exists in sounds.h but is referenced by NO mobjinfo row
      [MT.MT_BRUISER, SFX_ID.sfx_brsdth, 'plain'], // 67
      [MT.MT_CYBORG, SFX_ID.sfx_cybdth, 'plain'], // 68 — NULL origin
      [MT.MT_SPIDER, SFX_ID.sfx_spidth, 'plain'], // 69 — NULL origin
      [MT.MT_KNIGHT, SFX_ID.sfx_kntdth, 'plain'], // 72
      [MT.MT_PAIN, SFX_ID.sfx_pedth, 'plain'], // 73
    ];
    for (const [type, expectId, variant] of table) {
      const m = spawned(s, type, 300, 256);
      const before = s.hooks.sfx.count;
      if (variant === 'podth') pin(s, pod);
      else if (variant === 'bgdth') pin(s, bg);
      const idx = s.rng.prndindex; // AFTER the pin (the pin itself rewinds)
      aScream(m);
      expect(s.hooks.sfx.count - before, `MT ${type} emits once`).toBe(1);
      const e = s.hooks.sfx.entries[s.hooks.sfx.count - 1]!;
      expect(e.id, `MT ${type} sound id`).toBe(expectId);
      expect(resolveSfxId(mobjinfo[type]!.deathSound)).toBeGreaterThan(0);
      const boss = type === MT.MT_SPIDER || type === MT.MT_CYBORG;
      // p_enemy.c:1561-1567: bosses → NULL origin (full volume)
      expect([e.x, e.y, e.z], `MT ${type} origin`).toEqual(
        boss ? [0, 0, 0] : [m.x, m.y, m.z],
      );
      expect(draws(s, idx), `MT ${type} draws`).toBe(variant === 'plain' ? 0 : 1);
    }
    // deathsound 0 → `case 0: return` (:1540) — NO emit, NO draw. The
    // zero-deathsound rows are FX mobjs (info.c MT_FIRE); MT_TROOPSHOT's
    // firxpl goes through P_ExplodeMissile (p_mobj.c:103), never A_Scream:
    const fire = spawned(s, MT.MT_FIRE, 320, 256);
    const idx = s.rng.prndindex;
    const n = s.hooks.sfx.count;
    aScream(fire);
    expect(s.hooks.sfx.count).toBe(n);
    expect(draws(s, idx)).toBe(0);
  });

  /* -------------------------------------------------------------- */
  /* 4. A_Pain / A_Fall: zero PRNG; A_Pain silence for painSound 0    */
  /* -------------------------------------------------------------- */
  it('A_Pain emits painsound with NO draw; silent for sfx_None; A_Fall draws nothing', () => {
    const s = boot(room());
    const imp = spawned(s, MT.MT_TROOP, 300, 256);
    const idx = s.rng.prndindex;
    aPain(imp);
    expect(s.hooks.sfx.entries.at(-1)!.id).toBe(SFX_ID.sfx_popain); // 27
    expect(s.hooks.sfx.entries.at(-1)!.x).toBe(imp.x); // actor origin (:1580)
    const dmg = spawned(s, MT.MT_SERGEANT, 320, 256);
    aPain(dmg);
    expect(s.hooks.sfx.entries.at(-1)!.id).toBe(SFX_ID.sfx_dmpain); // 26
    const shot = spawned(s, MT.MT_TROOPSHOT, 340, 256);
    const before = s.hooks.sfx.count;
    aPain(shot); // painSound sfx_None → `if (painsound)` false (:1579)
    expect(s.hooks.sfx.count).toBe(before);
    aFall(imp);
    expect(s.hooks.sfx.count).toBe(before);
    expect(s.rng.prndindex, 'A_Pain/A_Fall draw NOTHING (p_enemy.c:1577-1591)')
      .toBe(idx);
    // aXScream is draw-free too:
    aXScream(imp);
    expect(s.hooks.sfx.entries.at(-1)!.id).toBe(SFX_ID.sfx_slop); // 31
    expect(s.rng.prndindex).toBe(idx);
  });

  /* -------------------------------------------------------------- */
  /* 5. corpse movement: SOLID blocks, A_Fall opens (mirror included) */
  /* -------------------------------------------------------------- */
  it('corpse blocks P_CheckPosition while MF_SOLID, passable the tic A_Fall runs (ThingLinks mirror)', () => {
    const s = boot(room([{ x: 400, y: 256, angle: 0, type: 3001 }]));
    const imp = s.mobjs.mobjs.find((m) => m.type === MT.MT_TROOP)!;
    const p = playerMo(s);
    pin(s, indexWhere((v) => (v & 3) === 0)); // clamp no-op: DIE1 8 tics
    pDamageMobj(imp, null, p, 60);
    // Before A_Fall: SOLID corpse ⇒ PIT_CheckThing `return !(flags &
    // MF_SOLID)` (p_map.c:341) ⇒ BLOCKED, even though height is 14 —
    // SOLID has no z carve-out for walkers in 1.10.
    expect(pCheckPosition(s.pmap, p, imp.x, imp.y)).toBe(false);
    expect(s.pmap.links.flags[imp.linkSlot]! & MF.MF_SOLID).toBeGreaterThan(0);
    tickUntil(s, imp, S.S_TROO_DIE4); // A_Fall ran THIS tic
    expect(s.pmap.links.flags[imp.linkSlot]! & MF.MF_SOLID).toBe(0); // the
    // aFall write went through p_mobj.writeFlags ⇒ the mirror pitCheckThing
    // reads agrees the corpse no longer blocks (pmap.ts:334 early-out).
    expect(pCheckPosition(s.pmap, p, imp.x, imp.y)).toBe(true);
  });

  /* -------------------------------------------------------------- */
  /* 6. MF_DROPOFF monster-on-corpse (p_map.c:481)                    */
  /* -------------------------------------------------------------- */
  it('living monster refuses the ledge (no DROPOFF); the corpse (MF_DROPOFF from P_KillMobj) stands over it', () => {
    const s = boot(LEDGE);
    const imp = spawned(s, MT.MT_TROOP, 96, 64);
    expect(imp.flags & MF.MF_DROPOFF).toBe(0); // info.c monster rows carry NO DROPOFF
    expect(pTryMove(s.pmap, imp, fx(136), fx(64))).toBe(false); // p_map.c:481
    // Kill (source NULL: the !netgame catch-all, p_inter.c:692): the
    // corpse block ADDS MF_CORPSE|MF_DROPOFF (p_inter.c:680).
    pDamageMobj(imp, null, null, 60);
    expect(imp.flags & MF.MF_DROPOFF).toBeGreaterThan(0);
    expect(s.players[0]!.killcount).toBe(1);
    syncMobj(imp);
    expect(pTryMove(s.pmap, imp, fx(136), fx(64))).toBe(true); // stands over the dropoff
  });

  /* -------------------------------------------------------------- */
  /* 7. SHADOWS: SARG rows, sfx_sgtdth, same action positions          */
  /* -------------------------------------------------------------- */
  it('SHADOWS death runs the S_SARG_DIE rows: scream on SARG_DIE2, fall on SARG_DIE4, zero draws', () => {
    const s = boot(room([{ x: 400, y: 256, angle: 0, type: 58 }]));
    const sh = s.mobjs.mobjs.find((m) => m.type === MT.MT_SHADOWS)!;
    expect(mobjinfo[MT.MT_SHADOWS]!.deathState).toBe(mobjinfo[MT.MT_SERGEANT]!.deathState);
    pin(s, indexWhere((v) => (v & 3) === 0));
    const idx = s.rng.prndindex;
    pDamageMobj(sh, null, playerMo(s), 150);
    expect(sh.state).toBe(S.S_SARG_DIE1); // 490 — info.c:1459 shares the rows
    tickUntil(s, sh, S.S_SARG_DIE2);
    expect(sfxIds(s)).toEqual([SFX_ID.sfx_sgtdth]); // 64 default branch
    expect(sh.flags & MF.MF_SOLID).toBeGreaterThan(0);
    tickUntil(s, sh, S.S_SARG_DIE4);
    expect(sh.flags & MF.MF_SOLID).toBe(0); // A_Fall position identical to SARG
    expect(draws(s, idx)).toBe(1); // kill clamp ONLY (sgtdth is not a variant run)
    expect(s.hooks.sfx.count).toBe(1);
  });

  /* -------------------------------------------------------------- */
  /* 8. ledgers                                                       */
  /* -------------------------------------------------------------- */
  it('site ledgers carry the M8-06 rows (the bidirectional scans live in ppalette/random-sites tests)', () => {
    expect(SFX_SITE_LEDGER['pdeath.ts']).toBe(4); // Pain 1 + Scream 2 + XScream 1, Fall silent
    expect(RANDOM_SITE_CALLS['pdeath.ts']).toBe(2); // podth %3 + bgdth %2 occurrences
  });

  /* -------------------------------------------------------------- */
  /* 9. determinism: in-process double run                            */
  /* -------------------------------------------------------------- */
  it('double run: identical sfx/state/flags/hash signature', () => {
    const run = () => {
      const s = boot(room([{ x: 400, y: 256, angle: 0, type: 3001 }]));
      const imp = s.mobjs.mobjs.find((m) => m.type === MT.MT_TROOP)!;
      pin(s, indexWhere((v) => (v & 3) === 0));
      pDamageMobj(imp, null, playerMo(s), 60);
      for (let t = 0; t < 30; t++) pRunThinkers(s.thinkers);
      return JSON.stringify({
        sfx: sfxIds(s),
        state: imp.state,
        tics: imp.tics,
        flags: imp.flags,
        height: imp.height,
        prnd: s.rng.prndindex,
        hash: hashState(s),
      });
    };
    expect(run()).toBe(run());
    // and the emit really happened in both (not a silent double no-op):
    const s = boot(room([{ x: 400, y: 256, angle: 0, type: 3001 }]));
    const imp = s.mobjs.mobjs.find((m) => m.type === MT.MT_TROOP)!;
    pDamageMobj(imp, null, playerMo(s), 60);    for (let t = 0; t < 30; t++) pRunThinkers(s.thinkers);
    expect(s.hooks.sfx.count).toBe(1);
  });
});
