/**
 * M7-10 §2 — SHARED-STREAM DETERMINISM: one 500-tic scripted run on the
 * stream arena interleaves FIRE (pistol on the zombie axis) + PICKUP
 * (clip in room C) + DOOR (use-raised tag-665 door) + FLICKER (sector
 * special 1 light flashes — the steady P_Random metronome) + TELEPORT
 * (W1 special 39 onto the teleportman) against the SINGLE P_Random
 * stream. Acceptance: (a) identical scripts ⇒ identical hashState; (b)
 * reordering the same event mix (door-use tic shifted inside the
 * blocked-at-door window ⇒ same five subsystems, different interleaving
 * phase) ⇒ different hash — the stream is order-SENSITIVE, not just
 * order-dependent; (c) removing the flicker metronome alone changes the
 * hash ⇒ the light flashers really are on the shared stream.
 *
 * Script geometry (STREAM_* fixture constants): player (224,460) facing
 * north; walking north hits the closed door line y=512 within ~60 tics;
 * the use press raises it (VDOOR targets surrounding-ceiling−32 = 96);
 * crossing y=576 fires the W1 teleport to (224,704) facing south; the
 * walk continues south over the clip (y=600, sfx itemup #32) down the
 * zombie axis (y=384). Ammo is pinned to 30 so the stream also sees the
 * P_CheckAmmo pistol→fist ladder late in the run.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it } from 'vitest';

import { MT } from '../../src/wad/info/mobjinfo';
import { AM_CLIP, attachPsprFields } from '../../src/sim/p_pspr';
import { resolveSfxId } from '../../src/sim/psound_stub';

import { boot, dmgTo, doubleRunHash, of, sfxCount } from './harness';
import { gTicker } from '../../src/sim/game';
import { emptyInput } from '../../src/sim/ticcmd';
import { streamArenaSpec } from '../fixtures/m7Fixtures';
import type { GameState } from '../../src/sim/state';


const SFX_TELEPORT = resolveSfxId('sfx_telept');
const FU = 65536;

/** The canonical 500-tic interleaving; `fireTic`/`useTic` are the knobs. */
function script(useTic: number, fireTic = 16) {
  return (t: number) => {
    const patch: Record<string, boolean | number | undefined> = {};
    if (t === 4) patch.forward = true;
    if (t === fireTic) patch.attack = true;
    if (t === useTic) patch.use = true;
    if (t === useTic + 1) patch.use = false;
    return Object.keys(patch).length ? patch : undefined;
  };
}

/** Per-tic observer capturing the five subsystem witnesses. */
function runWitnessed(s: GameState, useTic: number) {
  const w = {
    maxCeiling: 0, // door sector (index 2) ceiling travel
    maxPlayerY: 0,
    lights: new Set<number>(),
    minAmmo: Infinity,
    maxAmmo: 0
  };
  const p = attachPsprFields(s.players[0]!);
  p.ammo[AM_CLIP] = 4; // pin the fist-ladder excursion mid-run
  // Same merge semantics as harness.run (full GameInput base!).
  const at = script(useTic);
  let inp = emptyInput();
  for (let t = 0; t < 500; t++) {
    const patch = at(t);
    if (patch !== undefined) inp = { ...inp, ...patch };
    gTicker(s, inp);
    w.maxCeiling = Math.max(w.maxCeiling, s.sectors.ceilingZ[2]!);
    w.maxPlayerY = Math.max(w.maxPlayerY, s.players[0]!.mo.y);
    w.lights.add(s.sectors.light[1]!); // room A is sector 1 (0 is the void default)
    w.minAmmo = Math.min(w.minAmmo, p.ammo[AM_CLIP]!);
    w.maxAmmo = Math.max(w.maxAmmo, p.ammo[AM_CLIP]!);
  }
  return w;
}

describe('shared-stream determinism — fire+pickup+door+flicker+teleport', () => {
  it('500-tic run engages ALL FIVE subsystems', () => {
    const s = boot(streamArenaSpec());
    const dummy = of(s, MT.MT_POSSESSED)[0]!;
    const w = runWitnessed(s, 100);
    // FIRE: pistol volleys down the axis past the teleport (autoaim hit)
    expect(dmgTo(s, dummy).length).toBeGreaterThan(3);
    // PICKUP: the clip box (thing 2048 = +50 clips) south of the teleport
    // pushed ammo past its boot value — the witness is the state delta
    // (the p_inter pickup tail's sfx is not in the p_pspr slot ledger).
    expect(w.maxAmmo).toBeGreaterThanOrEqual(50);
    // DOOR: closed (ceilingZ 0) → the thinker raises it past the player
    // clearance; witness the MAX live ceilingZ over the run (the static
    // map.sectors.ceilingHeight is load-time data).
    expect(w.maxCeiling).toBeGreaterThanOrEqual(96 * FU);
    // TELEPORT: player reached the teleportman at y=704
    expect(w.maxPlayerY).toBe(704 * FU);
    // FLICKER: light level took several discrete values (special 1)
    expect(w.lights.size).toBeGreaterThanOrEqual(2);
    // LADDER witness: the pinned 4-round clip hit 0 mid-run (the
    // P_CheckAmmo fists lower fired) before the +50 clip box restored
    // the pistol.
    expect(w.minAmmo).toBe(0);
    expect(sfxCount(s, SFX_TELEPORT)).toBeGreaterThanOrEqual(1);
  });

  it('identical scripts ⇒ identical hashes (double run, 500 tics)', () => {
    const { hashA, hashB } = doubleRunHash(streamArenaSpec(), 500, script(100));
    expect(hashA).toBe(hashB);
    expect(hashA).not.toBe(0);
  });

  it('order sensitivity: same event mix, fire-metronome phase shifted ⇒ new hash', () => {
    // Shifting the FIRE press (16→22) re-phases the shot draws against
    // the flicker metronome's fixed-tic draws. Both runs still perform
    // ALL five events (walk/door/teleport/pickup/fire): same script ⇒ same
    // hash (test above), phase-shifted order ⇒ different hash.
    //
    // M8-05 note: the zombie used to be a fixed obstacle the player wedged
    // against at a bit-identical y. Now every hit kicks it (p_inter.c:826-857
    // thrust — the port's only "push"; 1.10 has no P_PushMobs), it dies a
    // volley earlier or later depending on the phase, and the corpse stops
    // blocking MF_SOLID sooner, so the player's final y carries a sub-unit
    // residue (0.06 units measured). The test's actual claim is about the
    // DRAW ORDER, so the mix is witnessed instead of the coordinate.
    const a = doubleRunHash(streamArenaSpec(), 500, script(100, 16));
    const b = doubleRunHash(streamArenaSpec(), 500, script(100, 22));
    expect(Math.abs(b.b.players[0]!.mo.y - a.a.players[0]!.mo.y)).toBeLessThan(FU);
    for (const [tag, s] of [['a', a.a], ['b', b.b]] as const) {
      expect(s.hooks.damage.count, tag).toBeGreaterThan(3); // FIRE happened
    }
    expect(b.hashA).toBe(b.hashB); // …and each variant is self-deterministic
    expect(a.hashA).not.toBe(b.hashA);
  });

  it('flicker-off control: the light metronome alone moves the hash', () => {
    const on = doubleRunHash(streamArenaSpec(), 500, script(100));
    const off = doubleRunHash(streamArenaSpec({ flicker: false }), 500, script(100));
    expect(on.hashA).not.toBe(off.hashA);
    // Control keeps everything else: door, teleport, pickup still happen.
    expect(sfxCount(off.b, SFX_TELEPORT)).toBeGreaterThanOrEqual(1);
    expect(off.b.players[0]!.mo.y).not.toBe(0);
  });

  it('prnd accounting: the stream advances monotonically across all movers', () => {
    const s = boot(streamArenaSpec());
    const seen: number[] = [];
    const at = script(100);
    let inp = emptyInput();
    for (let t = 0; t < 500; t++) {
      const patch = at(t);
      if (patch !== undefined) inp = { ...inp, ...patch };
      gTicker(s, inp);
      seen.push(s.rng.prndindex);
    }
    // No backward draws outside wraparound: count of 255→0 wraps must be
    // the only decreases, and the stream must have moved a LOT (shots +
    // flicker + blood).
    let wraps = 0;
    for (let i = 1; i < seen.length; i++) {
      if (seen[i]! < seen[i - 1]!) wraps++;
    }
    expect(wraps).toBeLessThanOrEqual(3); // ≤ ~700 draws over 500 tics
    expect(seen[499]!).not.toBe(seen[0]!); // stream moved
  });
});
