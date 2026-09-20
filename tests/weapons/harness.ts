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

export const dmgTo = (s: GameState, m: Mobj): DmgEvent[] =>
  dmgEvents(s).filter((e) => e.thing === m.linkSlot);

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

export function trackPsprites(
  s: GameState,
  tics: number,
  at: (tic: number) => Partial<GameInput> | undefined
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

/** Double-run determinism helper: hash after identical scripts. */
export function doubleRunHash(
  spec: RectMapSpec,
  tics: number,
  at: (tic: number) => Partial<GameInput> | undefined
): { hashA: number; hashB: number; a: GameState; b: GameState } {
  const a = boot(spec);
  const b = boot(spec);
  run(a, tics, at);
  run(b, tics, at);
  return { hashA: hashState(a), hashB: hashState(b), a, b };
}
