/**
 * Tests for audio/volumes.ts — the §0.7 volume model (M10-01, M10-plan).
 *
 * Evidence classes:
 *  1. VOLUME LAW GOLDEN TABLE: the 16 thermo values -> exact internal ints
 *     (`thermo*8`, D-10d) and exact bus gains (linear /127; music carries the
 *     MUSIC_TRIM constant) — plan acceptance 1, numbers written from
 *     m_misc.c:237-238 + s_sound.c:616-639 + i_sound.c:423.
 *  2. RANGE GUARD: sSet{Sfx,Music}Volume outside 0..127 throws RangeError
 *     (the s_sound.c I_Error mirror, plan acceptance 2); thermos clamp 0..15
 *     (m_menu.c:820-849 behavior).
 *  3. BUS PLUMBING: with a mocked live graph, setter -> setTargetAtTime on
 *     the exact bus node (anti-zipper), and the freshly built context adopts
 *     current volumes (buses = only owner of live volume state).
 *  4. MIXER SINGLE SOURCE: sfxVolumeForMixer() is the same internal int the
 *     spatial math consumes (no second truth).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { beforeEach, describe, expect, it } from 'vitest';

import {
  busSet,
  ensureContext,
  registerMusicGainSource,
  resumeFromPause,
  suspendForPause,
  setContextFactory,
  __resetAudioContext,
  type GainNodeLike,
} from './context';
import {
  MUSIC_TRIM,
  SOUNDBWIDTH,
  THERMO_DEFAULT,
  THERMO_SCALE,
  bindVolumes,
  musicBusGain,
  musicThermo,
  musicVolumeInternal,
  resetVolumesToDefaults,
  sSetMusicVolume,
  sSetSfxVolume,
  sfxBusGain,
  sfxThermo,
  sfxVolumeForMixer,
  sfxVolumeInternal,
  setMusicThermo,
  setSfxThermo,
} from './volumes';

/* Mock live graph (same structural shapes as context.test). */
class MockParam {
  value = 0;
  readonly rampCalls: Array<[number, number, number]> = [];
  setTargetAtTime(target: number, startTime: number, timeConstant: number): void {
    this.rampCalls.push([target, startTime, timeConstant]);
    this.value = target;
  }
}
class MockGain implements GainNodeLike {
  readonly gain = new MockParam();
  connect(): void {}
}
class MockContext {
  state = 'running'; // live immediately: focus here is the gain law, not the gate
  currentTime = 0;
  sampleRate = 48000;
  destination = { kind: 'destination' };
  readonly gains: MockGain[] = [];
  onstatechange: (() => void) | null = null;
  createGain(): MockGain {
    const g = new MockGain();
    this.gains.push(g);
    return g;
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

let made: MockContext[] = [];

beforeEach(() => {
  __resetAudioContext();
  made = [];
  setContextFactory(() => {
    const c = new MockContext();
    made.push(c);
    return c;
  });
  bindVolumes(); // re-arm seams after the module-state reset
  resetVolumesToDefaults();
});

/** Bus nodes in build order: [master, sfx, music]. */
function nodes(): [MockGain, MockGain, MockGain] {
  const g = made[0]!.gains;
  return [g[0]!, g[1]!, g[2]!];
}

describe('volume law golden table (plan acceptance 1)', () => {
  it('defaults are thermo 8/8 -> internal 64 (m_misc.c:237-238 + D-10d)', () => {
    expect(THERMO_DEFAULT).toBe(8);
    expect(sfxThermo()).toBe(8);
    expect(musicThermo()).toBe(8);
    expect(sfxVolumeInternal()).toBe(64);
    expect(musicVolumeInternal()).toBe(64);
  });

  it('all 16 thermos: internal = t*8, sfxGain = i/127, musicGain = i/127*TRIM', () => {
    const goldenSfx: number[] = [];
    const goldenMusic: number[] = [];
    for (let t = 0; t <= 15; t++) {
      setSfxThermo(t);
      setMusicThermo(t);
      expect(sfxVolumeInternal(), `internal @ ${t}`).toBe(t * 8); // D-10d
      expect(sfxVolumeForMixer()).toBe(t * 8);
      const i = t * THERMO_SCALE;
      expect(sfxBusGain(), `sfxGain @ ${t}`).toBe(i / SOUNDBWIDTH);
      expect(musicBusGain(), `musicGain @ ${t}`).toBe((i / SOUNDBWIDTH) * MUSIC_TRIM);
      goldenSfx.push(i / SOUNDBWIDTH);
      goldenMusic.push((i / SOUNDBWIDTH) * MUSIC_TRIM);
    }
    // Spot-pin the endpoints + default row exactly (float-stable divisions).
    expect(goldenSfx[0]).toBe(0);
    expect(goldenSfx[15]).toBe(120 / 127);
    expect(goldenMusic[8]).toBe((64 / 127) * 0.5);
    expect(MUSIC_TRIM).toBe(0.5);
  });

  it('thermo clamps to 0..15 like m_menu.c (no throw below/above)', () => {
    setSfxThermo(-3);
    expect(sfxVolumeInternal()).toBe(0);
    setSfxThermo(20);
    expect(sfxVolumeInternal()).toBe(120);
    setMusicThermo(Number.NaN);
    expect(musicThermo()).toBe(THERMO_DEFAULT); // non-finite -> default, never NaN
  });
});

describe('range guard (plan acceptance 2; s_sound.c:616-639 I_Error mirror)', () => {
  it('0..127 integers accepted; everything else throws RangeError', () => {
    expect(() => sSetSfxVolume(0)).not.toThrow();
    expect(() => sSetSfxVolume(127)).not.toThrow();
    expect(() => sSetSfxVolume(-1)).toThrow(RangeError);
    expect(() => sSetSfxVolume(128)).toThrow(RangeError);
    expect(() => sSetSfxVolume(8.5)).toThrow(RangeError);
    expect(() => sSetMusicVolume(Number.NaN)).toThrow(RangeError);
    // rejected sets leave state untouched
    expect(sfxVolumeInternal()).toBe(127);
    expect(musicVolumeInternal()).toBe(64);
  });

  it('a throw at the sink boundary is catchable and non-fatal (I_Error parity)', () => {
    let caught: unknown = null;
    try {
      sSetMusicVolume(999);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(RangeError);
    expect(musicVolumeInternal()).toBe(64); // engine volume unchanged
  });
});

describe('bus plumbing (buses own the live volume state)', () => {
  it('a freshly built context adopts the CURRENT volumes', () => {
    setSfxThermo(12);
    setMusicThermo(3);
    expect(ensureContext()).toBe(true);
    const [, sfx, music] = nodes();
    expect(sfx!.gain.value).toBeCloseTo(96 / 127, 12);
    expect(music!.gain.value).toBeCloseTo((24 / 127) * MUSIC_TRIM, 12);
  });

  it('setters ramp the exact node via setTargetAtTime (anti-zipper)', () => {
    ensureContext();
    const [, sfx, music] = nodes();
    sSetSfxVolume(127);
    expect(sfx!.gain.value).toBe(1);
    expect(sfx!.gain.rampCalls.at(-1)![2]).toBeGreaterThan(0); // TC > 0
    sSetMusicVolume(127);
    expect(music!.gain.value).toBe(MUSIC_TRIM);
  });

  it('pause holds the music bus silent; volume moves apply on resume', () => {
    registerMusicGainSource(musicBusGain);
    ensureContext();
    const [, , music] = nodes();
    suspendForPause();
    expect(music!.gain.value).toBe(0);
    setMusicThermo(15);
    expect(music!.gain.value).toBe(0); // still silent while paused
    resumeFromPause();
    expect(music!.gain.value).toBeCloseTo((120 / 127) * MUSIC_TRIM, 12); // the LAW
  });
});

describe('mixer single source', () => {
  it('sfxVolumeForMixer tracks every setter path', () => {
    sSetSfxVolume(100);
    expect(sfxVolumeForMixer()).toBe(100);
    setSfxThermo(4);
    expect(sfxVolumeForMixer()).toBe(32);
    resetVolumesToDefaults();
    expect(sfxVolumeForMixer()).toBe(64);
  });

  it('busSet mirrors are value-consistent without a context (headless)', () => {
    setSfxThermo(10);
    setMusicThermo(5);
    expect(busSet.sfx()).toBe(sfxBusGain());
    expect(busSet.music()).toBe(musicBusGain());
    expect(busSet.live).toBe(false);
  });
});
