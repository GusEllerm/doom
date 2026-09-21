/**
 * M7-10 — shared L2 weapon-suite harness (docs/design/M7-plan.md §M7-10).
 *
 * Everything the per-weapon suites share:
 *  - `boot`: fixture wad → gInitGame + the M7-06 pspr SFX slot filled
 *    (hooks.sfx gets the ten p_pspr.c S_StartSound(player->mo, …) sites);
 *  - scripted input helpers (`fireHold`, `swap`, `use`);
 *  - damage/SFX readers over the M6-01 hook-slot logs;
 *  - the PS_PRIZE recorder: weapon+flash psprite states sampled per tic;
 *  - the STREAM RE-DERIVATION helpers: the suites re-derive every damage
 *    number from the blessed RNDTABLE window consumed by the run (pure
 *    BigInt arithmetic — no engine call), per the random-sites.md ledger
 *    draw orders (hitscan: damage-then-jitter-then-blood/puff; BFG spray:
 *    16 draws per HIT ray in ray order; missile direct: 1 draw ×
 *    info->damage).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { buildFixtureMapWad } from '../fixtures/mapBuilder';
import { buildMapFromData } from '../../src/sim/map';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { gInitGame, gTicker } from '../../src/sim/game';
import { hashState, type GameState, type Skill } from '../../src/sim/state';
import { MF_SHOOTABLE } from '../../src/sim/thinglinks';
import { RNDTABLE } from '../../src/sim/prng';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { installPsprSfxSlot } from '../../src/sim/psound_stub';
import type { Mobj } from '../../src/sim/p_mobj';
import { pTryMove } from '../../src/sim/pmap';

import type { RectMapSpec } from '../fixtures/mapBuilder';

export const FU = 65536; // FRACUNIT (map-unit helper for specs)

export function boot(spec: RectMapSpec, skill: Skill = 2): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  const s = gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), skill);
  // M7-06 slot: the p_pspr.c S_StartSound(player->mo, sfx_*) sites land on
  // hooks.sfx with the player mobj coords (psound_stub's ten-site ledger).
  installPsprSfxSlot(s.hooks, () => s.leveltime);
  return s;
}

/* ------------------------------------------------------------------ */
/* Scripted input                                                      */
/* ------------------------------------------------------------------ */

export const HOLD_FIRE: GameInput = { ...emptyInput(), attack: true };
export const NO_INPUT: GameInput = emptyInput();

export function input(tic: number, script: readonly [number, number, Partial<GameInput>?][]): GameInput {
  let inp: GameInput = { ...NO_INPUT };
  for (const [from, to, patch] of script) {
    if (tic >= from && tic < to) inp = { ...inp, ...patch };
  }
  return inp;
}

/** Run `tics` tics; `at` maps tic → input patch (undefined = last held). */
export function run(
  s: GameState,
  tics: number,
  at: (tic: number) => Partial<GameInput> | undefined
): void {
  let last: GameInput = { ...NO_INPUT };
  for (let t = 0; t < tics; t++) {
    const patch = at(t);
    if (patch !== undefined) last = { ...last, ...patch };
    gTicker(s, last);
  }
}

/* ------------------------------------------------------------------ */
/* Readers                                                             */
/* ------------------------------------------------------------------ */

export const live = (s: GameState): Mobj[] => s.mobjs.mobjs.filter((m) => !m.removed);

export const of = (s: GameState, type: number): Mobj[] =>
  live(s).filter((m) => m.type === type);

/** Live shootable fixture mobjs (dummies): flags are the authority
 * (MF_SHOOTABLE = 4, thinglinks.ts) — puffs/blood/blasts never carry it;
 * MT_PLAYER (= 0, mobjinfo index order) is the shooter, not a dummy. */
export const dummies = (s: GameState): Mobj[] =>
  live(s).filter((m) => m.type !== 0 && (m.flags & MF_SHOOTABLE) !== 0);

export interface DmgEvent {
  readonly thing: number; // ThingLinks slot of the target
  readonly amount: number;
  readonly source: number | null;
  readonly tic: number;
}

export const dmgEvents = (s: GameState): DmgEvent[] =>
  s.hooks.damage.entries.map((e) => ({
    thing: e.thing,
    amount: e.amount,
    source: e.source,
    tic: e.tic
  }));

/**
 * Damage events delivered to `m`. M8-05 makes the naive `e.thing ===
 * m.linkSlot` filter WRONG for the first hit of a static-slot dummy: the
 * log stores the ThingLinks slot *at damage time* (hooks.ts records before
 * dispatching to the P_DamageMobj body), and the kick that body applies
 * promotes a static THINGS slot to a mover slot (p_inter_damage.ts), so the
 * victim's slot id changes ONCE per lifetime. Identity resolution goes
 * through the runtime's slot map, which keeps the pre-promotion id aliased
 * to the same mobj; the direct compare still covers the mover case.
 */
export const dmgTo = (s: GameState, m: Mobj): DmgEvent[] =>
  dmgEvents(s).filter((e) => e.thing === m.linkSlot || s.mobjs.slotMobjs.get(e.thing) === m);

/**
 * Fixture rig (M8-05): discard a dummy's XY momentum after every tic. Since
 * the damageBridge went live, `P_DamageMobj`'s close-combat kick
 * (p_inter.c:805-832, `thrust = damage*(FRACUNIT>>3)*100/mass`, FRICTION
 * 0.875 ⇒ a slide of ~8·thrust) pushes map-THINGS dummies around — true
 * vanilla behavior, but it would fling a 48-unit melee dummy out of
 * MELEERANGE and turn these M7 draw-derivation suites into knockback
 * tests. The kick itself is pinned where it belongs, in
 * src/sim/p_inter_damage.test.ts. Zeroing momentum draws nothing and moves
 * no hashed bytes a weapon test observes (the dummy is immortal rigging).
 */
export const pinMomentum = (m: Mobj): (() => void) => () => {
  m.momx = 0;
  m.momy = 0;
};

/**
 * Stronger variant of {@link pinMomentum} for the swings where one tic of
 * momentum is already too much: a berserk punch (≤200 damage on mass 100)
 * kicks with ~25 units of momentum and P_XYMovement spends ALL of it in the
 * tic it is applied (the MAXMOVE split loop), so zeroing afterwards cannot
 * undo the step. The dummy is walked back to its spawn point with P_TryMove
 * — the port's mover reposition (relinks, draws nothing; P_CheckPosition
 * skips the mover itself), which is exactly what vanilla's blocked-kick
 * path would leave. Used by the melee suites, where the fixture wants
 * "target held at MELEERANGE", not a knockback test.
 */
export const pinInPlace = (s: GameState, m: Mobj): (() => void) => {
  const x = m.x;
  const y = m.y;
  return () => {
    m.momx = 0;
    m.momy = 0;
    // Only a drift can call P_TryMove, and a drift means the kick already
    // promoted the dummy to a mover slot (p_inter_damage.ts) — the
    // static-slot guard cannot fire.
    if (m.x !== x || m.y !== y) pTryMove(s.pmap, m, x, y);
  };
};

/**
 * M8-fix static-dummy rig: install the mobj AI gate (hooks.aiGate) on a
 * booted state — the A_Look/A_Chase state actions then skip dispatch, so
 * planted MT_POSSESSED dummies never sight- or sound-wake and never
 * chase-walk: the STND row re-enters STND forever, sprite/tics advancing
 * exactly like production, ZERO P-stream draws from the AI. Pain/death
 * state actions and the P_DamageMobj bridge keep running (a gated dummy
 * still bleeds, kicks and dies like before M8-12). Pre-M8-12 the test
 * bundle simply had no A_Look/A_Chase bodies registered; with game.ts
 * importing p_enemy/amon_* they are live everywhere, so the fixtures
 * that pinned STATIC dummies ask for the gate. Production (and every
 * suite that wants AI — p_enemy/monsters/amon_*) never installs it.
 */
export const staticDummies = (s: GameState): GameState => {
  s.hooks.aiGate = () => true;
  return s;
};

export function sfxCount(s: GameState, id: number): number {
  return s.hooks.sfx.byId?.get(id) ?? 0;
}

/** Per-tic psprite trace: weapon-slot and flash-slot state numbers. */
export interface PsprSample {
  readonly tic: number;
  readonly weapon: number;
  readonly weaponTics: number;
  readonly sy: number;
  readonly flash: number;
}

/**
 * `afterTic` (optional) runs right after each `gTicker` — the rig hook for
 * fixtures that must neutralise a live sim effect without touching the
 * stream (M8-05: `pinMomentum` below). Takes no PRNG draws by contract.
 */
export function trackPsprites(
  s: GameState,
  tics: number,
  at: (tic: number) => Partial<GameInput> | undefined,
  afterTic?: (tic: number) => void
): PsprSample[] {
  const p = s.players[0] as unknown as {
    psprites: { state: number; tics: number; sx: number; sy: number }[];
  };
  const trace: PsprSample[] = [];
  let last: GameInput = { ...NO_INPUT };
  for (let t = 0; t < tics; t++) {
    const patch = at(t);
    if (patch !== undefined) last = { ...last, ...patch };
    gTicker(s, last);
    afterTic?.(t);
    trace.push({
      tic: t,
      weapon: p.psprites[0]!.state,
      weaponTics: p.psprites[0]!.tics,
      sy: p.psprites[0]!.sy,
      flash: p.psprites[1]!.state
    });
  }
  return trace;
}

/* ------------------------------------------------------------------ */
/* Stream re-derivation (BigInt, RNDTABLE only — no engine call)       */
/* ------------------------------------------------------------------ */

/** Table draw k of the window starting (exclusive) at `base` —
 * P_Random pre-increments: draw #1 = RNDTABLE[(base+1)&255]. */
export function drawAt(base: number, k: number): number {
  return RNDTABLE[(base + k) & 0xff]!;
}

/** P_GunShot re-derivation: per shot the source order is
 * damage draw FIRST, then the 2 jitter draws iff !accurate
 * (p_pspr.c:505-519). Returns each shot's damage + the draws consumed. */
export function rederiveGunShots(
  base: number,
  shots: number,
  accurateFirst: boolean
): { damages: number[]; draws: number } {
  const damages: number[] = [];
  let k = 0;
  for (let i = 0; i < shots; i++) {
    damages.push(Number(5n * ((BigInt(drawAt(base, k)) % 3n) + 1n)));
    k += 1;
    if (!(i === 0 && accurateFirst)) k += 2;
  }
  return { damages, draws: k };
}

/** A_FireShotgun: 7 × (!accurate) gunshots — damage, jitter, jitter. */
export function rederiveShotgunPellets(
  base: number,
  volleys: number
): { damages: number[]; draws: number } {
  const damages: number[] = [];
  let k = 0;
  for (let v = 0; v < volleys; v++) {
    for (let i = 0; i < 7; i++) {
      damages.push(Number(5n * ((BigInt(drawAt(base, k)) % 3n) + 1n)));
      k += 3;
    }
  }
  return { damages, draws: k };
}

/** A_BFGSpray (random-sites ledger): per HIT ray the source order is
 * EXTRABFG spawn lastlook (1 draw) THEN the 15 dice — 16 draws per hit
 * ray, ray order. MISS rays draw NOTHING. */
export function rederiveBfgRays(
  base: number,
  hitRays: number
): { damages: number[]; draws: number } {
  const damages: number[] = [];
  let k = 0;
  for (let r = 0; r < hitRays; r++) {
    k += 1; // spawn lastlook
    let d = 0n;
    for (let j = 0; j < 15; j++) d += (BigInt(drawAt(base, k + j)) & 7n) + 1n;
    damages.push(Number(d));
    k += 15;
  }
  return { damages, draws: k };
}

/** Missile direct hit (p_map.c:325): ONE draw, `(rand%8+1)*info.damage`
 * — rocket 20..160, plasma 5..40, BFG 100..800. */
export function rederiveMissileHit(
  base: number,
  index: number,
  infoDamage: number
): { damage: number; draws: number } {
  return {
    damage: Number(((BigInt(drawAt(base, index)) & 7n) + 1n) * BigInt(infoDamage)),
    draws: 1
  };
}

/** PIT_RadiusAttack re-derivation (p_map.c:713-762, pradius.ts pin):
 * dist = max(0, (chebyshevDelta − targetRadius) >> 16) (C arithmetic
 * shift — floor), then damage = bombDamage − dist when in LOS; dist ≥
 * bombDamage ⇒ no event. Fixed-point exact through BigInt. */
/** P_RadiusAttack damage re-derivation from EXACT fixed-point deltas:
 * dist = (P_AproxDistance(dx,dy) − radius) >> 16, damage = bomb − dist
 * (BigInt throughout — floor semantics of C `>>` on the non-negative
 * post-subtraction value, matching pradius.ts). */
export function rederiveSplashFixed(
  bombDamage: number,
  dxFixed: number,
  dyFixed: number,
  radiusFixed: number
): number | null {
  let dx = BigInt(dxFixed);
  let dy = BigInt(dyFixed);
  if (dx < 0n) dx = -dx;
  if (dy < 0n) dy = -dy;
  // P_AproxDistance = dx + dy − (min >> 1) (pmaputl.ts:151-156)
  const aproxBig = dx + dy - ((dx < dy ? dx : dy) >> 1n);
  let dist = (aproxBig - BigInt(radiusFixed)) >> 16n;
  if (dist < 0n) dist = 0n;
  if (dist >= BigInt(bombDamage)) return null;
  return bombDamage - Number(dist);
}

export function rederiveSplash(
  bombDamage: number,
  dxUnits: number,
  dyUnits: number,
  targetRadiusUnits: number
): number | null {
  const dx = absBig(dxUnits) * BigInt(FU);
  const dy = absBig(dyUnits) * BigInt(FU);
  const cheb = dx > dy ? dx : dy;
  let dist = (cheb - BigInt(targetRadiusUnits) * BigInt(FU)) >> 16n;
  if (dist < 0n) dist = 0n;
  if (dist >= BigInt(bombDamage)) return null;
  return Number(BigInt(bombDamage) - dist);
}

function absBig(v: number): bigint {
  const b = BigInt(v);
  return b < 0n ? -b : b;
}

/** Double-run determinism helper: identical script ⇒ identical hash.
 * The pair runs STRICTLY SEQUENTIALLY (boot→run→boot→run): the sim keeps
 * module-level scan scratch (the linetarget singleton in p_shoot.ts and
 * the switch world bindings), so two GameStates must not interleave tick
 * loops in one process — the established convention of every L2 suite is
 * ONE live state at a time. Sequential boot+run pairs were verified to
 * hash byte-identically run after run (the shared-stream order test in
 * tests/weapons/stream.test.ts depends on this being pair-serial). */
export function doubleRunHash(
  spec: RectMapSpec,
  tics: number,
  at: (tic: number) => Partial<GameInput> | undefined
): { hashA: number; hashB: number; a: GameState; b: GameState } {
  const a = boot(spec);
  run(a, tics, at);
  const hashA = hashState(a);
  const b = boot(spec);
  run(b, tics, at);
  const hashB = hashState(b);
  return { hashA, hashB, a, b };
}
