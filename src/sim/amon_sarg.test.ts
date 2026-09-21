// sim/amon_sarg.test.ts — M8-08 Family B acceptance (M8-plan §M8-08 with
// §0.7/§0.8/§0.9). The mirror (62 .c files, §0.0) was re-read THIS pass;
// every pin names the 1.10 line it mirrors.
//
// Coverage:
//  1. REGISTRATION + the ACTION-NAME TRUTH: ids 54 (A_SargAttack,
//     info.c:623 `S_SARG_ATK3`) + 57 (A_SkullAttack, info.c:726
//     `S_SKULL_ATK2`) bound, the p_map.c:276 slam on `pmapHooks.skullFlyHit`,
//     and `A_Scream` left as M8-06's registration (never rebound here).
//     NOT A_PainAttack (that is the PAIN ELEMENTAL, id 64, p_enemy.c:1512,
//     M9-scope), and there is NO A_LostSoulAttack action in 1.10;
//  2. A_SargAttack (acceptance 1): the melee gate, damage
//     ((P_Random()%10)+1)*4 with the 4 AND the 40 bound pinned, exactly
//     TWO draws per landed hit (1 die + the p_inter.c:894 painChance
//     roll), the PLAYER half of P_DamageMobj live (health drop asserted —
//     the action calls the direct entry, not the record-only bridge),
//     ZERO sound (sfx_sgtatk belongs to A_Chase, p_enemy.c:728-729), and out
//     of range: no damage, ZERO draws, and no missile path at all
//     (missilestate 0, info.c:1432/1458);
//  3. SPECTRE = DEMON + MF_SHADOW (acceptance 3): identical mobjinfo rows,
//     identical damage at the same stream index, and the ONE stream
//     difference the flag causes — A_FaceTarget's 2-draw jitter when the
//     target is fuzzy (p_enemy.c:794-795). RENDER GAP REPORTED, NOT FAKED:
//     1.10 has NO translucency anywhere — a shadow thing is drawn by the
//     FUZZ column (r_things.c:577-580 sets `vis->colormap = NULL` for
//     MF_SHADOW, R_DrawVisSprite then runs R_DrawFuzzColumn, r_draw.c:285).
//     The port's fuzz PRIMITIVE exists and is exact (framebuffer.ts
//     drawFuzzColumn + fuzzoffset + the fuzzpos global), but vissprites.ts
//     never lets pColormap go negative (its light block calls the fuzz
//     branch "dead per file header", so the drawFuzzColumnUnused stub at
//     :518 is UNREACHABLE) ⇒ a live spectre/lost soul draws FULLY OPAQUE
//     at normal light, silently. Renderer task to close: pColormap = -1 on
//     MF_SHADOW + route the negative branch to framebuffer.drawFuzzColumn;
//  4. A_Chase integration: the demon closes, emits sfx_sgtatk and runs
//     ATK1→ATK2→ATK3 (the A_SargAttack row) with a real player hit;
//  5. A_SkullAttack (acceptance 2): MF_SKULLFLY, |mom_xy| = SKULLSPEED
//     (p_enemy.c:1417), momz = (dest.z + h/2 − z)/dist with the dist<1
//     clamp, the sfx_sklatk emit, ZERO own draws;
//  6. THE SLAM through the real thinker/PIT path: 3..24 damage
//     (((R%8)+1)× info->damage 3), flag cleared, momentum zeroed, state ⇒
//     spawnstate (the STND row's own A_Look is what then re-arms it), ONE
//     slam draw, `pmapHookCounts.skullFlyHit` in step;
//  7. the p_map.c:276 LIVE-flag read (pitCheckThing snapshots `tm.flags`
//     once per mover, so
//     without the flag re-check a second thing in the same cell would
//     draw+damage twice where vanilla draws once) — pinned at zero draws;
//  8. MOVEMENT integration (M8-02): no friction while flying
//     (p_mobj.c:201-202 ⇒ mom_xy constant) and the floor hit FLIPS momz
//     (p_mobj.c:291-294) — the lost-soul hop, with NO gravity (info.c:1598
//     MF_NOGRAVITY row) so the arc never decays;
//  9. SKULLFLY RELEASE ON DEATH: p_inter.c:676 clears MF_SKULLFLY, the
//     :679 `type != MT_SKULL` test keeps MF_NOGRAVITY for lost souls ONLY
//     (the port's flags mirror carries FLOAT for the soul and the corpse
//     clears it), the DIE chain then runs M8-06's A_Scream (deathsound
//     sfx_firxpl) and A_Fall, and MT_SKULL is !MF_COUNTKILL (killcount
//     unmoved, §0.11) while the demon/spectre DO carry it;
// 10. INFIGHT: a slam on a monster IS the §0.8 retarget (target = the
//     SOUL, threshold = BASETHRESHOLD 100) and A_Chase runs on it — the
//     player is ignored while the soul lives;
// 11. EVERY state row of MT_SERGEANT / MT_SHADOWS / MT_SKULL walked from
//     the mobjinfo pointers: entry action registered or faithfully NULL,
//     the attack chain's damage row reached, pain/death chain actions
//     found — nothing hits the unimplemented-action recorder;
// 12. doomednum truth (§0.12): 3002 demon / 58 spectre / 3006 lost soul,
//     spawned through the real pSpawnThings doomednum scan (the soul's
//     SPAWN row is not yet charging — MF_SKULLFLY is an action flag), PLUS
//     a WAD-guarded census re-measured THIS pass from freedoom1.wad:
//     E1M1 = demon 9, SPECTRE 1, soul 0; E1M6 = 30/25/3; E1M7 = 53/30/8 —
//     the E1 totals reproduce plan §0.12 exactly (166/145, 99/97, 11/11),
//     so lost souls really are E1M6/E1M7-only and the spectre is the
//     rarest of the three;
// 13. the ThingLinks flag mirror (§3.4 word[5] / PIT read the MIRROR,
//     not the field) carries MF_SHADOW and flips MF_SKULLFLY off on slam;
// 14. LEDGERS both directions (RANDOM_SITE_CALLS 2 = melee die + slam die,
//     SFX_SITE_LEDGER 1 = the soul's attacksound; A_SargAttack emits
//     NOTHING, the demon's sfx_sgtatk is A_Chase's) + double-run
//     determinism: same stream index ⇒ same damage, same hash.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { ANG90, ANG270, ANGLETOFINESHIFT, FRACUNIT } from '../core/constants';
import { finecosine, finesine } from '../core/tables';
import { FixedMul } from '../core/fixed';
import { rPointToAngle2 } from './p_shoot';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MF, MT, mobjinfo } from '../wad/info/mobjinfo';
import { S, stateAction, stateNext } from '../wad/info/states';

import { gInitGame } from './game';
import { buildMapFromData } from './map';
import {
  asMobj,
  ONFLOORZ,
  pSetMobjFlags,
  pSetMobjState,
  pSpawnMobj,
  type Mobj,
} from './p_mobj';
import { hashState, type GameState } from './state';
import { pRunThinkers } from './ptick';
import { RNDTABLE } from './prng';
import { pDamageMobj } from './p_inter_damage';
import { pZMovement } from './pmove';
import { pAproxDistance } from './pmaputl';
import { pTeleportMove } from './pmap';
import { aChase } from './p_enemy';
import { aSargAttack, aSkullAttack, SKULLSPEED, skullFlyHit } from './amon_sarg';
import './pdeath'; // A_Scream/A_Fall bodies for the death chains (M8-06's)
import { ACT, isActionRegistered, unimplementedActions } from './a_actions';
import { pmapHookCounts, pmapHooks, resetPmapHookCounts } from './pmap';
import { SFX_ID, SFX_SITE_LEDGER } from './psound_stub';
import { RANDOM_SITE_CALLS, scanRandomSites } from './random-sites';
import { MF_SHADOW, MF_SKULLFLY } from './thinglinks';

const fx = (n: number): number => (n * FRACUNIT) | 0;

function boot(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), 3);
}

/** One 1024×512 room, player start west (the pdeath/p_inter_damage idiom). */
function room(things: RectMapSpec['things'] = []): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 1024, h: 512, lightLevel: 200 }],
    things: [{ x: 64, y: 256, angle: 0, type: 1 }, ...things],
  };
}

let s: GameState = null as unknown as GameState;

function playerMo(): Mobj {
  return asMobj(s.players[0]!.mo as never)!;
}

function spawned(type: number, x: number, y: number): Mobj {
  return pSpawnMobj(s.mobjs, fx(x), fx(y), ONFLOORZ, type, -1, {
    skipLastLookRandom: true,
  });
}

const hp = (): number => s.players[0]!.health;
const draws = (from: number): number => (s.rng.prndindex - from) & 0xff;
const sfxIds = (): number[] => s.hooks.sfx.entries.map((e) => e.id);

/** Set prndindex so the NEXT draw lands on table index k. */
function pin(k: number): void {
  s.rng.prndindex = (k - 1) & 0xff;
}

function indexWhere(pred: (v: number) => boolean): number {
  const k = RNDTABLE.findIndex((v) => pred(v));
  expect(k, 'RNDTABLE has an index passing the predicate').toBeGreaterThan(-1);
  return k;
}

/** Tick the thinker arena until `pred` (fails loudly). */
function tickUntil(pred: () => boolean, max = 200, label = ''): number {
  for (let t = 1; t <= max; t++) {
    pRunThinkers(s.thinkers);
    if (pred()) return t;
  }
  throw new Error(`not reached in ${max} tics${label ? `: ${label}` : ''}`);
}

describe('amon_sarg (M8-08): demon / spectre / lost soul', () => {
  /* -------------------------------------------------------------- */
  /* 1. registration + source-truth action names                     */
  /* -------------------------------------------------------------- */
  it('ids 54/57 + the skullfly PIT slot are bound; A_Scream stays M8-06', () => {
    s = boot(room());
    expect(isActionRegistered(ACT.A_SargAttack)).toBe(true);
    expect(isActionRegistered(ACT.A_SkullAttack)).toBe(true);
    expect(typeof pmapHooks.skullFlyHit).toBe('function');
    expect(isActionRegistered(ACT.A_Scream)).toBe(true); // pdeath.ts's, not ours

    // THE TRUTH THE BRIEF ASKED FOR (resolved from the mirror, not guessed):
    //   demon/spectre melee row ⇒ A_SargAttack (info.c:623). A_PainAttack
    //   (id 64, p_enemy.c:1512) is the PAIN ELEMENTAL (MT_PAIN, doomednum
    //   71, info.c:1681, ZERO in E1M1-E1M9 per the §0.12 census) — the plan
    //   defers A_PainAttack/A_PainDie (and A_PainShootSkull, :1522) to M9.
    //   The lost soul has NO attack action of its own beyond A_SkullAttack:
    //   MT_SKULL meleestate is 0 (info.c:1587), so its contact damage is
    //   PIT_CheckThing's MF_SKULLFLY branch (p_map.c:276), reached through
    //   the MISSILE state (info.c:1588) that A_Chase opens in
    //   P_CheckMissileRange (which carries the live MT_SKULL `dist >>= 1`
    //   tweak, p_enemy.c:239-245). No "A_LostSoulAttack" exists in 1.10.
    expect(stateAction[S.S_SARG_ATK3]).toBe(ACT.A_SargAttack);
    expect(stateAction[S.S_SKULL_ATK2]).toBe(ACT.A_SkullAttack);
    expect(mobjinfo[MT.MT_SKULL]!.meleeState).toBe(0);
    expect(mobjinfo[MT.MT_SKULL]!.missileState).toBe(S.S_SKULL_ATK1);
    expect(mobjinfo[MT.MT_SKULL]!.damage).toBe(3); // info.c:1596 ⇒ 3..24 slam
    expect(mobjinfo[MT.MT_SERGEANT]!.missileState).toBe(0); // melee-only family
  });

  /* -------------------------------------------------------------- */
  /* 2. A_SargAttack                                                 */
  /* -------------------------------------------------------------- */
  it('A_SargAttack in range: (R%10+1)*4 — the 4 AND 40 bounds pinned, 2 draws, LIVE player half, silent', () => {
    s = boot(room());
    const p = playerMo();
    // MELEERANGE − 20 + victim radius 16 = 60 units (p_enemy.c:184) ⇒ 48.
    const demon = spawned(MT.MT_SERGEANT, 112, 256);
    demon.target = p;

    pin(indexWhere((v) => v % 10 === 7)); // (7+1)*4 = 32
    const h0 = hp();
    const idx = s.rng.prndindex;
    aSargAttack(demon);
    expect(h0 - hp()).toBe(32);
    expect(demon.rt.state.players[0]!.health).toBe(h0 - 32); // the mirror too
    expect(draws(idx)).toBe(2); // 1 die + the :894 painChance roll
    expect(s.hooks.sfx.count).toBe(0); // the action emits NOTHING
    expect(s.hooks.damage.count).toBe(0); // direct entry (not the bridge)
    // A_FaceTarget aimed the demon at its target (p_enemy.c:789).
    expect(demon.angle).not.toBe(0);

    // The formula's BOUNDS, not a sample: %10 === 0 ⇒ 1*4 = 4, %10 === 9 ⇒ 40.
    pin(indexWhere((v) => v % 10 === 0));
    const h1 = hp();
    aSargAttack(demon);
    expect(h1 - hp()).toBe(4);
    pin(indexWhere((v) => v % 10 === 9));
    const h2 = hp();
    aSargAttack(demon);
    expect(h2 - hp()).toBe(40);
  });

  it('A_SargAttack out of range: no damage, ZERO draws — and the family has no missile state at all', () => {
    s = boot(room());
    const demon = spawned(MT.MT_SERGEANT, 400, 256);
    demon.target = playerMo();
    const h0 = hp();
    const idx = s.rng.prndindex;
    aSargAttack(demon); // 336 units ≥ the 60-unit bound
    expect(hp()).toBe(h0);
    expect(draws(idx)).toBe(0); // the gate is a range test + CheckSight, no die
    expect(mobjinfo[MT.MT_SERGEANT]!.missileState).toBe(0); // info.c:1432
    expect(mobjinfo[MT.MT_SHADOWS]!.missileState).toBe(0); // info.c:1458
  });

  it('A_SargAttack with no target bails BEFORE A_FaceTarget (p_enemy.c:939)', () => {
    s = boot(room());
    const demon = spawned(MT.MT_SERGEANT, 400, 256);
    const idx = s.rng.prndindex;
    const angle = demon.angle;
    aSargAttack(demon);
    expect(demon.target).toBeUndefined();
    expect(demon.angle).toBe(angle); // no face, no aim write
    expect(draws(idx)).toBe(0);
  });

  /* -------------------------------------------------------------- */
  /* 3. spectre = demon + MF_SHADOW                                 */
  /* -------------------------------------------------------------- */
  it('spectre = demon + MF_SHADOW: same rows, same damage at the same index, +2 draws only when it is the TARGET', () => {
    s = boot(room());
    const p = playerMo();
    const demon = spawned(MT.MT_SERGEANT, 112, 256);
    demon.target = p;
    // info.c:1446-1470 vs :1420-1444 — the — the ONLY table difference is MF_SHADOW.
    for (const r of [
      'spawnState',
      'seeState',
      'painState',
      'meleeState',
      'missileState',
      'deathState',
      'xdeathState',
      'speed',
      'radius',
      'damage',
    ] as const) {
      expect(mobjinfo[MT.MT_SHADOWS]![r], r).toBe(mobjinfo[MT.MT_SERGEANT]![r]);
    }
    expect(mobjinfo[MT.MT_SHADOWS]!.flags & MF_SHADOW).toBe(MF_SHADOW);
    expect(mobjinfo[MT.MT_SERGEANT]!.flags & MF_SHADOW).toBe(0);

    // Same stream index ⇒ the SAME damage number: zero action diff.
    const spectre = spawned(MT.MT_SHADOWS, 112, 256);
    spectre.target = p;
    const k = indexWhere((v) => v % 10 === 3); // (3+1)*4 = 16
    pin(k);
    const h0 = hp();
    aSargAttack(demon);
    const demonHit = h0 - hp();
    pin(k);
    const h1 = hp();
    aSargAttack(spectre);
    expect(demonHit).toBe(16);
    expect(h1 - hp()).toBe(demonHit);

    // The ONE stream difference a spectre causes: A_FaceTarget's fuzzy-
    // target jitter (p_enemy.c:794-795, TWO draws) — only when the spectre is
    // the TARGET (the demon attacking a spectre), never when attacking a
    // player. A player target: die + painChance = 2. A spectre target:
    // +2 jitter = 4.
    const attacker = spawned(MT.MT_SERGEANT, 112, 256);
    attacker.target = p;
    let idx = s.rng.prndindex;
    aSargAttack(attacker);
    expect(draws(idx)).toBe(2);
    attacker.target = spectre; // touching ⇒ melee range AND MF_SHADOW
    idx = s.rng.prndindex;
    aSargAttack(attacker);
    expect(draws(idx)).toBe(4); // jitter 2 + die 1 + painChance 1
  });

  it('A_Chase integration: the demon reaches melee, plays sfx_sgtatk once and runs ATK1→ATK3', () => {
    s = boot(room());
    const p = playerMo();
    const demon = spawned(MT.MT_SERGEANT, 200, 256);
    demon.target = p;
    demon.reactionTime = 0;
    pSetMobjState(demon, mobjinfo[demon.type]!.seeState); // S_SARG_RUN1

    const h0 = hp();
    const t = tickUntil(() => demon.state === S.S_SARG_ATK3, 100, 'ATK3');
    expect(t).toBeGreaterThan(0);
    expect(sfxIds()).toEqual([SFX_ID.sfx_sgtatk]); // A_Chase's ONE :727 emit
    // The ATK3 row (info.c:623) dispatched A_SargAttack ⇒ a real hit
    // (pinned by the demon being adjacent by the time it fires).
    expect(hp()).toBeLessThan(h0);
    expect(s.hooks.sfx.count).toBe(1); // the action itself added no sound
  });

  /* -------------------------------------------------------------- */
  /* 4. A_SkullAttack                                               */
  /* -------------------------------------------------------------- */
  it('A_SkullAttack: skullfly + SKULLSPEED mom + center-aimed momz + sfx_sklatk, ZERO draws', () => {
    s = boot(room());
    const p = playerMo();
    const skull = spawned(MT.MT_SKULL, 264, 256);
    skull.target = p;
    const idx = s.rng.prndindex;
    aSkullAttack(skull);

    expect(skull.flags & MF_SKULLFLY).toBe(MF_SKULLFLY); // :1428
    // The momentum is the table-faithful reading of :1432-1434 — the port's
    // finesine/finecosine are the M2 half-step tables (max 65535, and
    // finesine[ANG180 index] = -25, NOT 0), so the pins are the FORMULA plus
    // the magnitude, not hand-written round numbers.
    const fine = skull.angle >>> ANGLETOFINESHIFT;
    expect(skull.momx).toBe(FixedMul(SKULLSPEED, finecosine[fine]!));
    expect(skull.momy).toBe(FixedMul(SKULLSPEED, finesine[fine]!));
    const speed = Math.hypot(skull.momx, skull.momy) / FRACUNIT;
    expect(Math.abs(speed - 20)).toBeLessThan(0.01); // SKULLSPEED = 20*FRACUNIT
    // A_FaceTarget aims ACTOR→TARGET (p_enemy.c:789), i.e. due WEST here —
    // the table's own reading of that direction (ANG180 minus one halfstep,
    // which is why finesine[] is -25 and not 0; M2's tables are the truth).
    expect(skull.angle).toBe(rPointToAngle2(skull.x, skull.y, p.x, p.y));
    expect(skull.angle).toBeGreaterThan(ANG90);
    expect(skull.angle).toBeLessThan(ANG270);
    // :1436-1441 — dist is a TIC COUNT (fixed / SKULLSPEED), clamped to ≥1,
    // and momz is plain C `/` (toward zero) of the target-CENTER dz by it.
    const dist = Math.max(
      1,
      Math.trunc(pAproxDistance((p.x - skull.x) | 0, (p.y - skull.y) | 0) / SKULLSPEED),
    );
    expect(dist).toBe(10); // 200 units / 20 per tic
    expect(skull.momz).toBe(Math.trunc((((p.z + (p.height >> 1)) | 0) - skull.z) / dist));
    expect(skull.momz).toBe(Math.trunc(fx(28) / 10)); // = 183500 ≈ 2.8/tic
    expect(sfxIds()).toEqual([SFX_ID.sfx_sklatk]); // info.c:1583
    expect(draws(idx)).toBe(0); // NO draw of its own
    expect(SKULLSPEED).toBe(20 * FRACUNIT); // p_enemy.c:1417
  });

  it('A_SkullAttack clamps dist<1 (p_enemy.c:1439) and bails with no target (no flag, no sound)', () => {
    s = boot(room());
    const p = playerMo();
    const skull = spawned(MT.MT_SKULL, 264, 256);
    skull.x = p.x;
    skull.y = p.y;
    skull.target = p;
    aSkullAttack(skull);
    expect(skull.momz).toBe(fx(28)); // dz / 1 — the clamp is what stops /0
    const loose = spawned(MT.MT_SKULL, 600, 256);
    const idx = s.rng.prndindex;
    const sfx = s.hooks.sfx.count;
    aSkullAttack(loose);
    expect(loose.flags & MF_SKULLFLY).toBe(0);
    expect(s.hooks.sfx.count).toBe(sfx);
    expect(draws(idx)).toBe(0);
  });

  /* -------------------------------------------------------------- */
  /* 5. the slam, through the real state + PIT path                  */
  /* -------------------------------------------------------------- */
  it('charge → slam: 3..24 damage, skullfly cleared, momentum zeroed, spawnstate, ONE slam draw', () => {
    s = boot(room());
    resetPmapHookCounts();
    const p = playerMo();
    const skull = spawned(MT.MT_SKULL, 264, 256);
    skull.target = p;
    // The authentic entry: A_Chase's missile state (info.c:1588) — ATK1 is
    // A_FaceTarget, ATK2 is A_SkullAttack, then ATK3↔ATK4 (NULL rows) is
    // the flight loop, so the soul never re-enters A_Chase while flying.
    pSetMobjState(skull, mobjinfo[MT.MT_SKULL]!.missileState);

    const h0 = hp();
    const idx = s.rng.prndindex;
    let flew = false;
    const t = tickUntil(() => {
      if ((skull.flags & MF_SKULLFLY) !== 0) flew = true;
      return flew && (skull.flags & MF_SKULLFLY) === 0;
    }, 120, 'charge then slam');
    expect(t).toBeGreaterThan(6); // ATK1 (10 tics) + ATK2 + the flight

    const dmg = h0 - hp();
    expect(dmg % 3).toBe(0); // ((R%8)+1) * info->damage(3)
    expect(dmg).toBeGreaterThanOrEqual(3);
    expect(dmg).toBeLessThanOrEqual(24);
    expect(pmapHookCounts.skullFlyHit).toBe(1);
    expect(skull.momx).toBe(0);
    expect(skull.momy).toBe(0);
    expect(skull.momz).toBe(0);
    // p_map.c:284 spawnstate; the STND row's OWN action (A_Look, info.c:721)
    // runs the same tic and, with the player point-blank in sight, goes
    // straight to the see state — both readings are the source.
    expect([mobjinfo[MT.MT_SKULL]!.spawnState, mobjinfo[MT.MT_SKULL]!.seeState]).toContain(
      skull.state,
    );
    expect(draws(idx)).toBeGreaterThan(0); // the slam die (+ painChance roll)
  });

  /* -------------------------------------------------------------- */
  /* 6. p_map.c:276 reads tmthing->flags LIVE                        */
  /* -------------------------------------------------------------- */
  it('a second thing in the same cell never re-slams (live flag read; zero extra draws)', () => {
    s = boot(room());
    const p = playerMo();
    const skull = spawned(MT.MT_SKULL, 264, 256);
    pSetMobjFlags(skull, skull.flags | MF_SKULLFLY);
    const h0 = hp();
    skullFlyHit(p.linkSlot, skull); // the slam
    expect(hp()).toBeLessThan(h0);
    const after = s.rng.prndindex;
    skullFlyHit(p.linkSlot, skull); // the same cell, second thing visited
    expect(s.rng.prndindex).toBe(after); // ZERO draws — vanilla draws once
    expect(hp()).toBeLessThan(h0); // and never damages twice
    expect(skull.momx).toBe(0);
  });

  /* -------------------------------------------------------------- */
  /* 7. movement integration: no friction + the hop                  */
  /* -------------------------------------------------------------- */
  it('flying: mom_xy constant (no friction) and the floor hit FLIPS momz (the hop stream)', () => {
    s = boot(room());
    const p = playerMo();
    const skull = spawned(MT.MT_SKULL, 700, 256);
    skull.target = p;
    aSkullAttack(skull);
    const [mx, my] = [skull.momx, skull.momy];
    skull.z = fx(40);
    skull.momz = -2 * FRACUNIT;

    pRunThinkers(s.thinkers);
    expect([skull.momx, skull.momy]).toEqual([mx, my]); // p_mobj.c:201-202 exemption
    expect(skull.z).toBe(fx(38)); // z += momz, NOGRAVITY ⇒ momz never accelerates
    pRunThinkers(s.thinkers);
    pRunThinkers(s.thinkers);
    expect(skull.momz).toBe(-2 * FRACUNIT); // still the same, still falling
    expect(skull.z).toBe(fx(34));

    // The bounce itself (p_mobj.c:291-294): ON the floor with momz < 0.
    skull.z = 0;
    skull.momz = -3 * FRACUNIT;
    pZMovement(skull);
    expect(skull.momz).toBe(3 * FRACUNIT); // FLIPPED, not zeroed
    expect(skull.z).toBe(0); // snapped to floorz
    expect([skull.momx, skull.momy]).toEqual([mx, my]);
    // …and the arc keeps hopping (NOGRAVITY row ⇒ no decay).
    pZMovement(skull);
    expect(skull.momz).toBe(3 * FRACUNIT);
    expect(skull.z).toBe(fx(3));
  });

  /* -------------------------------------------------------------- */
  /* 8. skullfly release on death                                   */
  /* -------------------------------------------------------------- */
  it('death releases skullfly: NOGRAVITY survives for MT_SKULL only, M8-06 sounds run, killcount unmoved', () => {
    s = boot(room());
    const p = playerMo();
    const skull = spawned(MT.MT_SKULL, 264, 256);
    skull.target = p;
    aSkullAttack(skull);
    expect(skull.flags & MF_SKULLFLY).toBe(MF_SKULLFLY);

    pDamageMobj(skull, null, p, 500); // 100−500 < −spawnhealth, xdeathstate 0
    expect(skull.flags & MF_SKULLFLY).toBe(0); // p_inter.c:676 (the RELEASE)
    expect(skull.flags & MF.MF_NOGRAVITY).toBe(MF.MF_NOGRAVITY); // :679 SKULL-only
    expect(skull.flags & MF.MF_FLOAT).toBe(0);
    expect(skull.flags & MF.MF_CORPSE).toBe(MF.MF_CORPSE);
    expect(skull.state).toBe(S.S_SKULL_DIE1); // gib rule: xdeath 0 ⇒ deathstate
    expect(mobjinfo[MT.MT_SKULL]!.flags & MF.MF_COUNTKILL).toBe(0);
    expect(s.players[0]!.killcount).toBe(0); // lost souls never count (§0.11)

    tickUntil(() => skull.state === S.S_SKULL_DIE2, 30, 'DIE2');
    expect(sfxIds()).toContain(SFX_ID.sfx_firxpl); // info.c:1591 deathsound
    tickUntil(() => skull.state === S.S_SKULL_DIE6, 60, 'DIE6');
    expect(skull.flags & MF.MF_SOLID).toBe(0); // A_Fall ran (info.c:734)
    expect(skull.removed).toBe(false); // the -1 corpse row persists
    // A dead soul can never resume the charge either:
    expect(skull.flags & MF_SKULLFLY).toBe(0);
  });

  /* -------------------------------------------------------------- */
  /* 9. infighting                                                  */
  /* -------------------------------------------------------------- */
  it('a skull slam on a monster IS the retarget: imp.target = the soul, threshold 100', () => {
    s = boot(room());
    const soul = spawned(MT.MT_SKULL, 264, 256);
    const imp = spawned(MT.MT_TROOP, 300, 256);
    soul.target = imp;
    aSkullAttack(soul);
    const idx = s.rng.prndindex;

    (pmapHooks.skullFlyHit as NonNullable<typeof pmapHooks.skullFlyHit>)(imp.linkSlot, soul);
    expect(imp.target).toBe(soul); // p_inter.c:908-911
    expect(imp.threshold).toBe(100); // BASETHRESHOLD (p_local.h:61)
    expect(soul.flags & MF_SKULLFLY).toBe(0);
    expect(draws(idx)).toBeGreaterThanOrEqual(2); // slam die + painChance roll

    // And A_Chase RUNS ON the new target (the M8-05 integration shape):
    // threshold decays every chase tic WHILE the target lives (p_enemy.c:682-689
    // -695) and the target is never re-looked, i.e. the player is ignored.
    imp.reactionTime = 0;
    imp.movecount = 0;
    for (let t = 0; t < 16; t++) aChase(imp);
    expect(imp.target).toBe(soul); // it did not fall back to the player
    expect(imp.threshold).toBe(100 - 16); // the chase loop ran on the SOUL
    // Out of melee range it genuinely CHASES it (P_Move toward the soul):
    pTeleportMove(s.pmap, soul, fx(900), fx(256));
    const x0 = imp.x;
    for (let t = 0; t < 40 && imp.x === x0; t++) aChase(imp);
    expect(imp.x).not.toBe(x0);
    expect(imp.target).toBe(soul);
  });

  /* -------------------------------------------------------------- */
  /* 11. every state row of the three types (§0.9)                   */
  /* -------------------------------------------------------------- */
  it('every info.ts row the family can occupy dispatches an action that exists (NULL rows are NULL)', () => {
    s = boot(room());
    // The rows MT_SERGEANT / MT_SHADOWS / MT_SKULL can ever occupy, walked
    // through the mobjinfo pointers (not hard-coded ids), with the action
    // each row runs on ENTRY.
    const rowsOf = (type: number): { label: string; st: number }[] => {
      const i = mobjinfo[type]!;
      const out: { label: string; st: number }[] = [];
      for (const [label, st] of [
        ['spawn', i.spawnState],
        ['see', i.seeState],
        ['pain', i.painState],
        ['melee', i.meleeState],
        ['missile', i.missileState],
        ['death', i.deathState],
        ['xdeath', i.xdeathState],
      ] as const) {
        if (st !== 0) out.push({ label, st });
      }
      return out;
    };
    // A row's action id ⇒ registered (or NULL). A_Chase/A_Look/A_FaceTarget
    // come from p_enemy.ts (imported), A_Pain/A_Scream/A_Fall from
    // pdeath.ts, A_SargAttack/A_SkullAttack from THIS task.
    const walk = (st: number, depth = 0): void => {
      expect(depth, 'chain terminates').toBeLessThan(12);
      const act = stateAction[st]!;
      if (act === 0) return; // a NULL row is faithfully NULL
      expect(isActionRegistered(act), `state ${st} action ${act}`).toBe(true);
    };
    for (const type of [MT.MT_SERGEANT, MT.MT_SHADOWS, MT.MT_SKULL]) {
      for (const { label, st } of rowsOf(type)) {
        walk(st);
        // …and the row is REACHABLE: pSetMobjState runs its action without
        // hitting the unimplemented-action recorder (§0.9).
        const mo = spawned(type, 300, 256);
        pSetMobjState(mo, st);
        expect(unimplementedActions().size, `${label} of ${type}`).toBe(0);
      }
      // The attack CHAIN, derived (not hard-coded): the melee/missile entry
      // row is a face row, and its nextstate is the family's ACTION row —
      // S_SARG_ATK3 ⇒ A_SargAttack (info.c:623), S_SKULL_ATK2 ⇒
      // A_SkullAttack (info.c:726). This is the §0.9 "A_Chase → state row →
      // action" wiring, checked from the tables.
      const i = mobjinfo[type]!;
      const entry = i.meleeState !== 0 ? i.meleeState : i.missileState;
      expect(stateAction[entry], `${type} attack entry`).toBe(ACT.A_FaceTarget);
      // Walk the chain past the face rows (the demon chain is ATK1→ATK2 both
      // A_FaceTarget, then ATK3 = A_SargAttack; the soul's is one step).
      let damageRow = stateNext[entry]!;
      let hops = 0;
      while (stateAction[damageRow] === ACT.A_FaceTarget && hops++ < 4) {
        damageRow = stateNext[damageRow]!;
      }
      expect(
        stateAction[damageRow],
        `${type} damage row ${damageRow}`,
      ).toBe(type === MT.MT_SKULL ? ACT.A_SkullAttack : ACT.A_SargAttack);
      expect(stateAction[i.painState]).toBe(0); // pain rows are NULL…
      expect(stateAction[stateNext[i.painState]!]).toBe(ACT.A_Pain); // …PAIN2 acts
      expect(stateAction[i.deathState]).toBe(0);
      expect(stateAction[stateNext[i.deathState]!]).toBe(ACT.A_Scream);
    }
  });

  it('the ThingLinks flag mirror carries MF_SHADOW (PIT + §3.4 word[5] read the mirror)', () => {
    s = boot(room());
    const spectre = spawned(MT.MT_SHADOWS, 400, 256);
    const demon = spawned(MT.MT_SERGEANT, 500, 256);
    expect(spectre.flags & MF_SHADOW).toBe(MF_SHADOW);
    expect(s.pmap.links.flags[spectre.linkSlot!]! & MF_SHADOW).toBe(MF_SHADOW);
    expect(s.pmap.links.flags[demon.linkSlot!]! & MF_SHADOW).toBe(0);
    // A slam through the mirror path flips the mirrored flag too (§0.7):
    const soul = spawned(MT.MT_SKULL, 600, 256);
    pSetMobjFlags(soul, soul.flags | MF_SKULLFLY);
    expect(s.pmap.links.flags[soul.linkSlot!]! & MF_SKULLFLY).toBe(MF_SKULLFLY);
    skullFlyHit(demon.linkSlot, soul);
    expect(s.pmap.links.flags[soul.linkSlot!]! & MF_SKULLFLY).toBe(0);
  });

  /* -------------------------------------------------------------- */
  /* 12. doomednum truth (§0.12) — the map-thing spawn path           */
  /* -------------------------------------------------------------- */
  it('doomednums 3002 / 58 / 3006 spawn the family through pSpawnThings (§0.12)', () => {
    // The three rows are NOT adjacent in info.c and the doomednums are not
    // sequential: demon 3002 (info.c:1421), spectre 58 (:1447 — the only
    // low-numbered one, and the reason it is easy to miss: it reuses the
    // SARG rows verbatim, spawnstate S_SARG_STND/seestate S_SARG_RUN1/
    // meleestate S_SARG_ATK1 at :1448/1450/1457), lost soul 3006 (:1577).
    // Per the §0.12 census the demon is in every E1 map, the SPECTRE is in
    // E1M1,3-7,9, and lost souls are E1M6/E1M7 only (11 in all of E1).
    // Spawned from THINGS, the doomednum scan must land on exactly these.
    expect(mobjinfo[MT.MT_SERGEANT]!.doomednum).toBe(3002);
    expect(mobjinfo[MT.MT_SHADOWS]!.doomednum).toBe(58);
    expect(mobjinfo[MT.MT_SKULL]!.doomednum).toBe(3006);
    const st = boot(
      room([
        { x: 200, y: 128, angle: 90, type: 3002 },
        { x: 300, y: 128, angle: 90, type: 58 },
        { x: 400, y: 128, angle: 90, type: 3006 },
      ]),
    );
    s = st;
    const byType = new Map<number, Mobj[]>();
    for (const m of st.mobjs.slotMobjs.values()) {
      if (m.type === MT.MT_SERGEANT || m.type === MT.MT_SHADOWS || m.type === MT.MT_SKULL) {
        byType.set(m.type, [...(byType.get(m.type) ?? []), m]);
      }
    }
    expect(byType.get(MT.MT_SERGEANT)?.length).toBe(1);
    expect(byType.get(MT.MT_SHADOWS)?.length).toBe(1);
    expect(byType.get(MT.MT_SKULL)?.length).toBe(1);
    const soul = byType.get(MT.MT_SKULL)![0]!;
    // The spawned soul is NOT yet charging: MF_SKULLFLY is an action flag
    // (p_enemy.c:1428) — A_Chase has to open ATK1/ATK2 first.
    expect(soul.flags & MF_SKULLFLY).toBe(0);
    expect(soul.state).toBe(mobjinfo[MT.MT_SKULL]!.spawnState);
    expect(byType.get(MT.MT_SHADOWS)![0]!.flags & MF_SHADOW).toBe(MF_SHADOW);
  });

});

/* ------------------------------------------------------------------ */
/* 12b. The §0.12 census, measured from the pinned WAD this pass        */
/* ------------------------------------------------------------------ */
const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));

describe.skipIf(!existsSync(WAD_PATH))('family B doomednums in freedoom1.wad', () => {
  // §0.12's numbers, re-measured with THIS task's own scan (10-byte THINGS
  // records, map.ts:741 idiom; "alive at skill 3" = skill bit 3 set and the
  // MTF_NOTSINGLE bit clear). The E1 totals reproduce the plan's table
  // exactly — demon 166/145, spectre 99/97, lost soul 11/11 — so the
  // family's roster is not folklore: the spectre really is the rarest of
  // the three and lost souls exist in E1M6/E1M7 ONLY.
  const count = (name: string, doomed: number): [number, number] => {
    const bytes = readFileSync(WAD_PATH);
    const m = buildMapFromData(
      loadMap(WadFile.parse(bytes.buffer.slice(bytes.byteOffset) as ArrayBuffer), name),
    );
    const v = new DataView(m.things.buffer, m.things.byteOffset, m.things.byteLength);
    let total = 0;
    let alive = 0;
    for (let i = 0; i < m.things.length; i += 10) {
      if (v.getUint16(i + 6, true) !== doomed) continue;
      const opt = v.getUint16(i + 8, true);
      total++;
      if ((opt & 0x1f) !== 0 && (opt & 4) !== 0 && (opt & 0x20) === 0) alive++;
    }
    return [total, alive];
  };
  for (const map of ['E1M1', 'E1M6', 'E1M7'] as const) {
    it(`${map}: demon / spectre / lost-soul Thing counts`, () => {
      const want: Record<string, [number, number, number][]> = {
        E1M1: [
          [3002, 9, 9],
          [58, 1, 1],
          [3006, 0, 0],
        ],
        E1M6: [
          [3002, 30, 24],
          [58, 25, 25],
          [3006, 3, 3],
        ],
        E1M7: [
          [3002, 53, 50],
          [58, 30, 30],
          [3006, 8, 8],
        ]
      };
      for (const [doomed, total, alive] of want[map]!) {
        expect(count(map, doomed), `${map} doomednum ${doomed}`).toEqual([total, alive]);
      }
    });
  }
});

describe('amon_sarg (M8-08): demon / spectre / lost soul (continued)', () => {
    /* -------------------------------------------------------------- */
  /* 10. ledgers + determinism                                      */
  /* -------------------------------------------------------------- */
  it('ledgers: amon_sarg rows present and the scan matches both directions', () => {
    expect(RANDOM_SITE_CALLS['amon_sarg.ts']).toBe(2); // die + slam die
    expect(SFX_SITE_LEDGER['amon_sarg.ts']).toBe(1); // the skull attacksound
    expect(scanRandomSites()).toEqual({ ...RANDOM_SITE_CALLS });
  });

  it('determinism: the same charge/chase scene double-runs to equal hashes and equal damage', () => {
    const run = (): { hash: number; hpLeft: number; sfx: number } => {
      const st = boot(room());
      // Re-bind the module-level fixture the helpers read.
      s = st;
      const p = playerMo();
      const soul = spawned(MT.MT_SKULL, 364, 256);
      const demon = spawned(MT.MT_SHADOWS, 700, 128);
      demon.target = p;
      pSetMobjState(soul, mobjinfo[MT.MT_SKULL]!.missileState);
      for (let t = 0; t < 150; t++) {
        if (t === 60) aSargAttack(demon); // one scripted melee attempt
        pRunThinkers(st.thinkers);
      }
      return { hash: hashState(st), hpLeft: st.players[0]!.health, sfx: st.hooks.sfx.count };
    };
    const a = run();
    const b = run();
    expect(b.hash).toBe(a.hash);
    expect(b.hpLeft).toBe(a.hpLeft);
    expect(b.sfx).toBe(a.sfx);
    s = boot(room());
  });
});
