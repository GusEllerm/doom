// audio/mixerCore.test.ts — deterministic mixer goldens (M10-05, plan
// §M10-05 acceptance #2/#3/#4): allocator matrix (free / same-origin steal /
// priority-evict first-match / "Sorry Charlie" / addsfx dedup / chgun link /
// the S_StopSound(NULL) quirk), D-10e update/free rules, and EIGHT scripted
// offline mixes + the pan sweep trio committed as Int16 FNV hashes
// (double-run reproducible; clamp property over every rendered scene).
//
// Synthetic buffers are piecewise-linear/exact-binary (square + triangle,
// amplitudes over 128) — no Math.sin anywhere in the golden path (plan:
// "reproducible across node versions by construction").
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SFX_ID } from '../sim/psound_stub';
import { SFX_INFO } from './sfxinfo';
import {
  addsfxSplit,
  createMixer,
  mixHash,
  MixSfxData,
  NORM_PITCH,
  NUM_MIXER_CHANNELS,
  renderMix,
  renderStep16,
  sfxJitter,
  STEP_TABLE,
  toFloat32,
  VOL_LOOKUP,
  volLaw,
} from './mixerCore';
import type { MixScript } from './mixerCore';

const FU = 65536;
const SR = 22050; // render rate for every golden scene

/* ------------------------------------------------------------------ */
/* Synthetic exact-binary buffers                                       */
/* ------------------------------------------------------------------ */

function mkBuf(kind: 'sq' | 'tri', rate: number, len: number, amp: number, period: number): MixSfxData {
  const samples = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let w: number;
    if (kind === 'sq') {
      w = i % period < period / 2 ? 1 : -1;
    } else {
      const t = (i % period) / period;
      w = t < 0.25 ? 4 * t : t < 0.75 ? 2 - 4 * t : 4 * t - 4;
      w = Math.round(amp * w) / amp; // byte-quantized triangle
    }
    samples[i] = Math.round(amp * w) / 128;
  }
  return { rate, samples };
}

const BUF_PISTOL = mkBuf('sq', 22050, 2205, 96, 88);
const BUF_DOROPN = mkBuf('tri', 22050, 44100, 80, 220);
const BUF_POSACT = mkBuf('tri', 22050, 22050, 64, 440);
const BUF_ITEMUP = mkBuf('sq', 44100, 2205, 60, 200); // 44.1k → exact ×2 step
const BUF_SAWFUL = mkBuf('tri', 22050, 3307, 90, 150);
const BUF_STNMOV = mkBuf('sq', 22050, 1102, 70, 64);
const BUF_CLAMP = mkBuf('sq', 22050, 2205, 127, 40);

function buffers(extra?: ReadonlyMap<number, MixSfxData>): Map<number, MixSfxData> {
  const m = new Map<number, MixSfxData>([
    [SFX_ID.sfx_pistol, BUF_PISTOL],
    [SFX_ID.sfx_doropn, BUF_DOROPN],
    [SFX_ID.sfx_posact, BUF_POSACT],
    [SFX_ID.sfx_itemup, BUF_ITEMUP],
    [SFX_ID.sfx_sawful, BUF_SAWFUL],
    [SFX_ID.sfx_stnmov, BUF_STNMOV],
    [SFX_ID.sfx_barexp, BUF_SAWFUL], // eviction fillers need data too
    [SFX_ID.sfx_telept, BUF_PISTOL],
  ]);
  if (extra) for (const [k, v] of extra) m.set(k, v);
  return m;
}

const E = (
  tic: number,
  id: number,
  origin: number | null,
  x = 0,
  y = 0,
  volume?: number,
): MixScript['events'][number] => ({ tic, id, origin, x, y, volume });

/* ------------------------------------------------------------------ */
/* Scripted scenes (plan §M10-05 acceptance #3)                         */
/* ------------------------------------------------------------------ */

const LISTENERS = [{ tic: 0, x: 0, y: 0, angle: 0, self: null }];

const SCENES: Record<string, MixScript> = {
  // pan sweep: sources ahead / left (north) / right (south), ≤ CLOSE dist.
  'pan-east': {
    buffers: buffers(),
    listener: LISTENERS,
    events: [E(0, SFX_ID.sfx_doropn, 11, 100 * FU, 0)],
  },
  'pan-north': {
    buffers: buffers(),
    listener: LISTENERS,
    events: [E(0, SFX_ID.sfx_doropn, 12, 0, 100 * FU)],
  },
  'pan-south': {
    buffers: buffers(),
    listener: LISTENERS,
    events: [E(0, SFX_ID.sfx_doropn, 13, 0, -100 * FU)],
  },
  // distance ramp along +x: vols 64/64/48/32/19/7 at the start, then mixed.
  'distance-ramp': {
    buffers: buffers(),
    listener: LISTENERS,
    events: [
      E(0, SFX_ID.sfx_posact, 100, 0, 0),
      E(0, SFX_ID.sfx_posact, 101, 160 * FU, 0),
      E(0, SFX_ID.sfx_posact, 102, 480 * FU, 0),
      E(0, SFX_ID.sfx_posact, 103, 680 * FU, 0),
      E(0, SFX_ID.sfx_posact, 104, 880 * FU, 0),
      E(0, SFX_ID.sfx_posact, 105, 1080 * FU, 0),
    ],
  },
  // priority steal mid-sample: 8 long doors (prio 100) fill the pool at tic
  // 0, a pistol (64) arrives at tic 35 and kicks the FIRST ≥-match (ch 0).
  'priority-steal': {
    buffers: buffers(),
    listener: LISTENERS,
    events: [
      ...Array.from({ length: 8 }, (_, i) =>
        E(0, SFX_ID.sfx_doropn, 200 + i, (60 + i * 8) * FU, 0),
      ),
      E(35, SFX_ID.sfx_pistol, 99, 60 * FU, 0),
    ],
  },
  // addsfx dedup retriggers: pistol and sawful re-armed from NEW origins
  // while live; stale instance killed, channel reused. 44.1k itemup rides
  // here for the exact-rational step (pitch 128, no jitter — §0.2).
  'dedup-retrigger': {
    buffers: buffers(),
    listener: LISTENERS,
    events: [
      E(0, SFX_ID.sfx_pistol, 1, 40 * FU, 0),
      E(3, SFX_ID.sfx_pistol, 2, 44 * FU, 0),
      E(6, SFX_ID.sfx_sawful, 3, 48 * FU, 0),
      E(9, SFX_ID.sfx_sawful, 4, 52 * FU, 0),
      E(12, SFX_ID.sfx_stnmov, null),
      E(15, SFX_ID.sfx_itemup, 5, 56 * FU, 0),
    ],
  },
  // chgun LINK: only DSPISTOL data exists; link branch = pitch 150 +
  // ±16 jitter, priority-64 row, pistol samples (sounds.c:204).
  'chgun-link': {
    buffers: buffers(),
    listener: LISTENERS,
    events: [E(0, SFX_ID.sfx_chgun, 7, 100 * FU, 0)],
  },
  // NORM_SEP center (origin NULL ⇒ listener-local): the sep-128 quadratic
  // legs (129², −128²) round to the SAME shift at vol 64 ⇒ L≡R per sample.
  'norm-sep': {
    buffers: buffers(),
    listener: LISTENERS,
    events: [E(0, SFX_ID.sfx_doropn, null)],
  },
  // pitch-jitter determinism: 6 positional doors across tics/origins +
  // a no-jitter itemup; double-rendered, bit-compared.
  'jitter-determinism': {
    buffers: buffers(),
    listener: LISTENERS,
    events: [
      E(0, SFX_ID.sfx_doropn, 201, 60 * FU, 0),
      E(20, SFX_ID.sfx_doropn, 202, 60 * FU, 0),
      E(40, SFX_ID.sfx_doropn, 203, 60 * FU, 0),
      E(60, SFX_ID.sfx_doropn, 204, 60 * FU, 0),
      E(80, SFX_ID.sfx_doropn, 205, 60 * FU, 0),
      E(100, SFX_ID.sfx_doropn, 206, 60 * FU, 0),
      E(0, SFX_ID.sfx_itemup, 207, 60 * FU, 0),
    ],
  },
  // silence pad: no events → exactly 1 s of zeros (auto frames).
  'silence-pad': { buffers: buffers(), listener: LISTENERS, events: [] },
  // clamp: 8 full-scale square waves at volume 127 ⇒ ±0x7fff hard rails.
  'clamp-rails': {
    buffers: buffers(new Map([[SFX_ID.sfx_punch, BUF_CLAMP]])),
    listener: LISTENERS,
    events: Array.from({ length: 8 }, (_, i) =>
      E(0, SFX_ID.sfx_punch, 300 + i, 10 * FU, 0, 127),
    ),
  },
};

/** Committed goldens: FNV-1a hex of the interleaved Int16 render. Blessed
 * this pass from the int-law engine; drift is a FINDING (plan §4.5). */
const GOLDENS: Record<string, string> = {
  'pan-east': '23b84202',
  'pan-north': 'a290fea4',
  'pan-south': '3837a3de',
  'distance-ramp': '9dfb552d',
  'priority-steal': '109a05f1',
  'dedup-retrigger': '094a6b8c',
  'chgun-link': '419d6832',
  'norm-sep': '5bfa8abd',
  'jitter-determinism': '55b13581',
  'silence-pad': 'cb8d2b65',
  'clamp-rails': '2c4505e7',
};

/* ------------------------------------------------------------------ */
/* Mixing-law units                                                     */
/* ------------------------------------------------------------------ */

describe('mixing law units (i_sound.c)', () => {
  it('vol_lookup is (i*(j-128)*256)/127 and volLaw agrees (:421-423)', () => {
    expect(VOL_LOOKUP.length).toBe(128 * 256);
    expect(VOL_LOOKUP[64 * 256 + 128]).toBe(0);
    for (const v of [0, 1, 4, 32, 64, 95, 127]) {
      for (const b of [0, 1, 64, 127, 128, 129, 192, 255]) {
        expect(volLaw(v, b - 128)).toBe(VOL_LOOKUP[v * 256 + b]);
      }
    }
  });

  it('addsfxSplit is the quadratic sep law (:350-373)', () => {
    expect(addsfxSplit(64, 128)).toEqual({ left: 48, right: 48 }); // center
    expect(addsfxSplit(64, 33)).toEqual({ left: 63, right: 16 }); // left-heavy
    expect(addsfxSplit(64, 224)).toEqual({ left: 15, right: 63 }); // right-heavy
    expect(addsfxSplit(0, 33)).toEqual({ left: 0, right: 0 });
    expect(() => addsfxSplit(127, 300)).toThrow(RangeError); // out-of-bounds guard
  });

  it('steptable = pow(2,(p−128)/64)·65536 truncated (:417); exact-rational step', () => {
    expect(STEP_TABLE[128]).toBe(65536);
    expect(STEP_TABLE[192]).toBe(131072);
    expect(STEP_TABLE[64]).toBe(32768);
    expect(STEP_TABLE[150]).toBe(Math.trunc(Math.pow(2, 22 / 64) * 65536));
    // DS freq → rational: 44.1k data at 22.05k render = exactly ×2 (itemup
    // has NO jitter, §0.2, so pitch 128 ⇒ exact rational, no pow error)
    expect(renderStep16(128, 44100, 22050)).toBe(131072);
    expect(renderStep16(128, 22050, 22050)).toBe(65536);
    expect(renderStep16(128, 22050, 48000)).toBe(Math.trunc((65536 * 22050) / 48000));
  });

  it('sfxJitter keeps the §0.2 distribution without touching any RNG stream', () => {
    for (let tic = 0; tic < 200; tic++) {
      const saw = sfxJitter(tic, SFX_ID.sfx_sawhit, tic);
      expect(saw).toBeGreaterThanOrEqual(-7); // 8 − (r&15) ∈ [−7, 8]
      expect(saw).toBeLessThanOrEqual(8);
      const other = sfxJitter(tic, SFX_ID.sfx_doropn, tic);
      expect(other).toBeGreaterThanOrEqual(-15); // 16 − (r&31) ∈ [−15, 16]
      expect(other).toBeLessThanOrEqual(16);
      expect(sfxJitter(tic, SFX_ID.sfx_itemup, tic)).toBe(0); // no draw, no jitter
      expect(sfxJitter(tic, SFX_ID.sfx_tink, tic)).toBe(0);
    }
    // deterministic in its inputs:
    expect(sfxJitter(7, 20, 3)).toBe(sfxJitter(7, 20, 3));
  });
});

/* ------------------------------------------------------------------ */
/* Allocator matrix (s_sound.c:827-875 / i_sound.c:283-306)             */
/* ------------------------------------------------------------------ */

function census(m: ReturnType<typeof createMixer>): (number | 0)[] {
  return m.channels.map((c) => c.sfxId);
}

describe('S_getChannel allocator matrix (plan §0.4)', () => {
  afterEach(() => vi.useRealTimers());

  it('rejects bad ids and bad volumes (I_Error → RangeError)', () => {
    const m = createMixer({ buffers: buffers() });
    expect(() => m.start(0, null, 0, 0, 0)).toThrow(RangeError);
    expect(() => m.start(109, null, 0, 0, 0)).toThrow(RangeError);
    expect(() => m.start(1.5, null, 0, 0, 0)).toThrow(RangeError);
    expect(() => m.setVolume(128)).toThrow(RangeError);
    expect(() => m.setVolume(-1)).toThrow(RangeError);
  });

  it('fills first-free in channel order', () => {
    const m = createMixer({ buffers: buffers() });
    for (let i = 0; i < 8; i++) expect(m.start(20, 500 + i, 50 * FU, 0, i)).toBe(true);
    expect(census(m)).toEqual([20, 20, 20, 20, 20, 20, 20, 20]);
    expect(m.channels[7]!.origin).toBe(507);
  });

  it('same-origin start STEALS the live channel (one sound per mobj)', () => {
    const m = createMixer({ buffers: buffers() });
    for (let i = 0; i < 8; i++) m.start(20, 600 + i, 50 * FU, 0, 0);
    expect(m.start(32, 603, 50 * FU, 0, 1)).toBe(true); // itemup from origin 603
    const c = census(m);
    expect(c[3]).toBe(32); // ch 3 reused, not an eviction
    expect(c.filter((x) => x !== 0).length).toBe(8);
  });

  it('eviction kicks the FIRST channel with priority >= new (>=, first-match)', () => {
    // fill: barexp 60, barexp 60, doropn 100, telept 32, itemup 78, …
    const m = createMixer({ buffers: buffers() });
    const fill = [
      SFX_ID.sfx_barexp,
      SFX_ID.sfx_barexp,
      SFX_ID.sfx_doropn,
      SFX_ID.sfx_telept,
      SFX_ID.sfx_itemup,
      SFX_ID.sfx_doropn,
      SFX_ID.sfx_telept,
      SFX_ID.sfx_itemup,
    ];
    fill.forEach((id, i) => m.start(id, 700 + i, 50 * FU, 0, 0));
    expect(m.start(SFX_ID.sfx_pistol, 800, 50 * FU, 0, 1)).toBe(true); // 64
    const c = census(m);
    expect(c[2]).toBe(1); // ch 2 (100 ≥ 64) was the FIRST match — ch 0/1: 60 < 64
    // a 32-priority (telept) start now evicts ch 0 (60 ≥ 32 first match)
    const m2 = createMixer({ buffers: buffers() });
    fill.forEach((id, i) => m2.start(id, 700 + i, 50 * FU, 0, 0));
    expect(m2.start(SFX_ID.sfx_telept, 801, 50 * FU, 0, 1)).toBe(true);
    expect(census(m2)[0]).toBe(35);
  });

  it('"Sorry, Charlie": all channels strictly LOWER priority ⇒ counted DROP', () => {
    const m = createMixer({ buffers: buffers() });
    for (let i = 0; i < 8; i++) m.start(SFX_ID.sfx_barexp, 900 + i, 50 * FU, 0, 0); // 60s
    expect(m.start(SFX_ID.sfx_pistol, 999, 50 * FU, 0, 1)).toBe(false); // 64 > 60
    expect(m.stats.drops).toBe(1);
    expect(census(m).every((x) => x === 82)).toBe(true);
  });

  it('addsfx dedup trio kills the SAME-ID instance regardless of origin', () => {
    const m = createMixer({ buffers: buffers() });
    m.start(SFX_ID.sfx_pistol, 1, 40 * FU, 0, 0);
    m.start(20, 2, 40 * FU, 0, 0);
    m.start(SFX_ID.sfx_pistol, 3, 40 * FU, 0, 1); // dedup: pistol@1 dies, reuse
    expect(census(m)).toEqual([1, 20, 0, 0, 0, 0, 0, 0]);
    expect(m.channels[0]!.origin).toBe(3);
    m.start(SFX_ID.sfx_sawful, 4, 40 * FU, 0, 2);
    m.start(SFX_ID.sfx_sawful, 5, 40 * FU, 0, 3);
    expect(census(m).filter((x) => x === 12).length).toBe(1);
    // a NON-dedup pair layers normally:
    m.start(20, 6, 40 * FU, 0, 4);
    m.start(20, 7, 40 * FU, 0, 4);
    expect(census(m).filter((x) => x === 20).length).toBe(3);
  });

  it('S_StopSound(NULL) replaces the first NULL-origin channel (verbatim quirk)', () => {
    const m = createMixer({ buffers: buffers() });
    m.start(SFX_ID.sfx_doropn, null, 0, 0, 0);
    expect(census(m).filter((x) => x !== 0).length).toBe(1);
    m.start(SFX_ID.sfx_itemup, null, 0, 0, 1); // stopSound(null) kills ch0 first
    expect(census(m)).toEqual([32, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('chgun LINK reuses pistol data at pitch 150 + §0.2 jitter', () => {
    const m = createMixer({ buffers: buffers() }); // NO buffer under id 86
    expect(m.start(SFX_ID.sfx_chgun, 7, 100 * FU, 0, 5)).toBe(true);
    const c = m.channels[0]!;
    expect(c.sfxId).toBe(86);
    expect(c.data).toBe(BUF_PISTOL); // link → pistol samples (:803-810)
    expect(c.priority).toBe(SFX_INFO[86]!.priority); // table 64
    expect(c.pitch).toBeGreaterThanOrEqual(150 - 15);
    expect(c.pitch).toBeLessThanOrEqual(150 + 16);
    expect(c.pitch).toBe(150 + sfxJitter(5, 86, 7));
  });

  it('missing lump = counted silent drop, zero console output (§0.10)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const m = createMixer({ buffers: buffers() }); // id 4 (dshtgn) absent
    expect(m.start(SFX_ID.sfx_dshtgn, 9, 10 * FU, 0, 0)).toBe(false);
    expect(m.stats.misses).toBe(1);
    expect(errSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* S_UpdateSounds (D-10e per-tic re-apply) + free rules                 */
/* ------------------------------------------------------------------ */

describe('updateSounds / S_Start / free rules', () => {
  it('per-tic re-apply follows the listener (live falloff), clip-outs free', () => {
    const m = createMixer({ buffers: buffers() });
    m.setListener({ x: 0, y: 0, angle: 0, self: null });
    m.start(SFX_ID.sfx_doropn, 42, 1000 * FU, 0, 0);
    expect(m.channels[0]!.vol).toBe(12); // 64*200/1040 = 12
    m.updateSounds(1, { x: 600 * FU, y: 0, angle: 0, self: null });
    expect(m.channels[0]!.vol).toBe(49); // dist 400 ⇒ 64*800/1040 = 49.23 → 49
    m.updateSounds(2, { x: 2400 * FU, y: 0, angle: 0, self: null });
    expect(census(m)[0]).toBe(0); // beyond CLIP ⇒ stopped (:586-588)
  });

  it('E1M8 never clip-outs: distant vol freezes at the 15 floor', () => {
    const m = createMixer({ buffers: buffers(), gamemap: 8 });
    m.setListener({ x: 0, y: 0, angle: 0, self: null });
    m.start(SFX_ID.sfx_doropn, 42, 1150 * FU, 0, 0);
    m.updateSounds(1, { x: 3200 * FU, y: 0, angle: 0, self: null });
    expect(m.channels[0]!.sfxId).toBe(20);
    expect(m.channels[0]!.vol).toBe(15); // :800-808 floor
  });

  it('finished channels free on the next update (pos ≥ len rule)', () => {
    const m = createMixer({ buffers: buffers() });
    m.start(SFX_ID.sfx_pistol, null, 0, 0, 0);
    m.channels[0]!.pos16 = BUF_PISTOL.samples.length << 16;
    m.updateSounds(1);
    expect(census(m)[0]).toBe(0);
  });

  it('startLevel kills every channel (s_sound.c:207-211)', () => {
    const m = createMixer({ buffers: buffers() });
    for (let i = 0; i < 8; i++) m.start(20, i + 1, 50 * FU, 0, 0);
    m.startLevel();
    expect(census(m)).toEqual(new Array(NUM_MIXER_CHANNELS).fill(0));
  });

  it('local (self-origin) sounds keep full volume + NORM_SEP pan', () => {
    const m = createMixer({ buffers: buffers() });
    m.setListener({ x: 0, y: 0, angle: 0, self: 5 });
    m.start(SFX_ID.sfx_pistol, 5, 5000 * FU, 0, 0); // origin IS the listener
    expect(m.channels[0]!.vol).toBe(64);
    expect(m.channels[0]!.sep).toBe(128);
  });
});

/* ------------------------------------------------------------------ */
/* renderMix goldens                                                    */
/* ------------------------------------------------------------------ */

function energy(mix: Int16Array, side: 0 | 1): number {
  let e = 0;
  for (let i = side; i < mix.length; i += 2) e += Math.abs(mix[i]!);
  return e;
}

function sceneCensus(scene: MixScript): { channels: (number | 0)[]; mixer: ReturnType<typeof createMixer> } {
  const mixer = createMixer({ buffers: scene.buffers as Map<number, MixSfxData> });
  mixer.setListener({ x: 0, y: 0, angle: 0, self: null });
  const evs = [...scene.events].sort((a, b) => a.tic - b.tic);
  for (const e of evs) mixer.start(e.id, e.origin ?? null, e.x ?? 0, e.y ?? 0, e.tic, e.volume);
  mixer.updateSounds(evs.length ? evs[evs.length - 1]!.tic : 0);
  return { channels: census(mixer), mixer };
}

describe('renderMix — scripted golden corpus (plan acceptance #3)', () => {
  for (const [name, script] of Object.entries(SCENES)) {
    it(`${name}: bit-reproducible + committed hash`, () => {
      const a = renderMix(script, SR);
      const b = renderMix(script, SR); // double-run determinism
      expect(a).toEqual(b);
      expect(GOLDENS[name]).not.toBe('PENDING');
      expect(mixHash(a), 'GOLDEN ' + name + ' =').toBe(GOLDENS[name]);
      // clamp property (acceptance #4): Int16 rails always hold
      let max = -0x8000;
      let min = 0x7fff;
      for (const v of a) {
        if (v > max) max = v;
        if (v < min) min = v;
      }
      expect(max).toBeLessThanOrEqual(0x7fff);
      expect(min).toBeGreaterThanOrEqual(-0x8000);
    });
  }

  it('pan sweep: north event is LEFT-heavy, south RIGHT, ahead balanced', () => {
    const n = energy(renderMix(SCENES['pan-north']!, SR), 0);
    const nR = energy(renderMix(SCENES['pan-north']!, SR), 1);
    const s = energy(renderMix(SCENES['pan-south']!, SR), 0);
    const sR = energy(renderMix(SCENES['pan-south']!, SR), 1);
    const e = energy(renderMix(SCENES['pan-east']!, SR), 0);
    const eR = energy(renderMix(SCENES['pan-east']!, SR), 1);
    expect(n).toBeGreaterThan(nR * 3); // left dominant (sep 33)
    expect(sR).toBeGreaterThan(s * 3); // right dominant (sep 224)
    expect(Math.abs(e - eR)).toBeLessThan(e * 0.05); // ahead ≈ center (129 quirk)
  });

  it('distance ramp: exact per-channel start volumes 64/64/48/32/19/7', () => {
    const { channels } = sceneCensus(SCENES['distance-ramp']!);
    expect(channels).toEqual([75, 75, 75, 75, 75, 75, 0, 0]);
    const m = createMixer({ buffers: buffers() });
    m.setListener({ x: 0, y: 0, angle: 0, self: null });
    const vols = [0, 160, 480, 680, 880, 1080].map((d, i) => {
      m.start(SFX_ID.sfx_posact, 100 + i, d * FU, 0, 0);
      return m.channels[i]!.vol;
    });
    expect(vols).toEqual([64, 64, 44, 32, 19, 7]); // 64*(1200−d)/1040 trunc
  });

  it('priority steal: pistol kicks door channel 0 mid-sample, 7 doors survive', () => {
    const { channels } = sceneCensus(SCENES['priority-steal']!);
    expect(channels[0]).toBe(1); // pistol replaced the first ≥64 match
    expect(channels.filter((x) => x === 20).length).toBe(7);
  });

  it('dedup scene: one pistol (origin 2), one sawful (origin 4), itemup pitch 128', () => {
    const { channels, mixer } = sceneCensus(SCENES['dedup-retrigger']!);
    expect(channels.filter((x) => x === 1).length).toBe(1);
    expect(channels.filter((x) => x === 12).length).toBe(1);
    expect(channels.filter((x) => x === 22).length).toBeLessThanOrEqual(1);
    const itemup = mixer.channels.find((c) => c.sfxId === 32);
    expect(itemup?.pitch).toBe(NORM_PITCH); // §0.2: itemup = NO jitter
    expect(itemup?.data).toBe(BUF_ITEMUP);
  });

  it('chgun scene: pistol samples, link pitch', () => {
    const { mixer } = sceneCensus(SCENES['chgun-link']!);
    const c = mixer.channels.find((x) => x.sfxId === 86);
    expect(c?.data).toBe(BUF_PISTOL);
    expect(c!.pitch).toBeGreaterThanOrEqual(135);
    expect(c!.pitch).toBeLessThanOrEqual(166);
  });

  it('norm-sep: L≡R SAMPLE-FOR-SAMPLE (pure mono sum, no panner)', () => {
    const mix = renderMix(SCENES['norm-sep']!, SR);
    for (let f = 0; f < mix.length / 2; f++) expect(mix[f * 2]).toBe(mix[f * 2 + 1]);
  });

  it('silence pad: zero events ⇒ 1 s of exact zeros, toFloat32 all 0', () => {
    const mix = renderMix(SCENES['silence-pad']!, SR);
    expect(mix.length).toBe(SR * 2);
    expect(mix.every((v) => v === 0)).toBe(true);
    expect(toFloat32(mix).every((v) => v === 0)).toBe(true);
  });

  it('clamp rails: both ±0x7fff/−0x8000 rails hit (:617-627)', () => {
    const mix = renderMix(SCENES['clamp-rails']!, SR);
    expect(Math.max(...mix.slice(0, 4000))).toBe(0x7fff);
    expect(Math.min(...mix.slice(0, 4000))).toBe(-0x8000);
  });

  it('silent-for-silent: all-missing buffers render exact zeros, silently', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const zero = renderMix(
      {
        buffers: () => null,
        listener: LISTENERS,
        events: [E(0, SFX_ID.sfx_doropn, 1, 10 * FU, 0), E(5, SFX_ID.sfx_pistol, null)],
      },
      SR,
    );
    expect(zero.every((v) => v === 0)).toBe(true);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('tic-grid schedule: an event starting at tic 70 (2 s) is silent before', () => {
    const mix = renderMix(
      {
        buffers: buffers(),
        listener: LISTENERS,
        events: [E(70, SFX_ID.sfx_doropn, 1, 40 * FU, 0)],
        frames: 2 * SR,
      },
      SR,
    );
    expect(mix.slice(0, 2 * SR).every((v) => v === 0)).toBe(true);
  });
});

describe('mechanical no-panner scan (D027-style guard, plan §0.3)', () => {
  it('mixerCore/spatial CODE never mentions StereoPanner', () => {
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const f of ['./mixerCore.ts', './spatial.ts']) {
      expect(strip(readFileSync(new URL(f, import.meta.url), 'utf8'))).not.toMatch(
        /StereoPanner|createStereoPanner/i,
      );
    }
  });
});
