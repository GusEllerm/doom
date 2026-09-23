/**
 * Tests for audio/wiring.ts — M10-09 (M10-plan §M10-09).
 *
 * Evidence classes (plan acceptance):
 *  1. thermo −/+ step → internal int → gain, the exact 0..15 sweep driven
 *     through the REAL menu routines (SoundMenu status-2 rows, m_menu.c
 *     :820-849; defaults 8/8 m_misc.c:237-238 — NOT 15: the s_sound.c:113/
 *     :116 globals are overridden at load, m_misc.c:830/:847);
 *  2. bus gains move proportionally through volumes.ts (0 ⇒ gain 0);
 *  3. state().audio absent-object safety (read without install, no throws);
 *  4. zero console output at install (gesture-gated init is seam-silent).
 * Plus: change detection (pump no-op when nothing moved), the live
 * liveSfx/liveMusic fan-out composer, and the gesture-gate attach.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sfxSink, musicSlot } from '../sim/hooks';
import { mReset, SoundMenu, menuState } from '../ui/menu';
import {
  __resetAudioContext,
  busSet,
  ensureContext,
  platformState,
  setContextFactory,
  type AudioContextLike,
  type GainNodeLike,
} from './context';
import {
  MUSIC_TRIM,
  THERMO_DEFAULT,
  THERMO_SCALE,
  bindVolumes,
  resetVolumesToDefaults,
} from './volumes';
import {
  __resetAudioWiring,
  audioWiringInstalled,
  audioWiringState,
  installAudioWiring,
  pumpAudioWiring,
  registerAudioCensus,
  registerVolumeMirror,
  registerWiringMusicConsumer,
  registerWiringSfxConsumer,
  type GestureTarget,
} from './wiring';

/* ---------------- mock graph (context.test shapes) ------------------- */

class MockParam {
  value = 0;
  setTargetAtTime(target: number): void {
    this.value = target;
  }
}
function mockNode(): GainNodeLike & { param: MockParam } {
  const param = new MockParam();
  const node = {
    param,
    gain: param as unknown as GainNodeLike['gain'],
    connect() {},
    disconnect() {},
  };
  return node as unknown as GainNodeLike & { param: MockParam };
}
class MockCtx {
  readonly currentTime = 0;
  state: AudioContextLike['state'] = 'running';
  destination = mockNode();
  readonly gains: Array<ReturnType<typeof mockNode>> = [];
  onstatechange: (() => void) | null = null;
  createGain(): GainNodeLike {
    const g = mockNode();
    this.gains.push(g);
    return g;
  }
  resume(): Promise<void> {
    this.state = 'running';
    return Promise.resolve();
  }
}

function gainOf(param: MockParam): number {
  return param.value;
}

/* ---------------- harness ------------------- */

interface FakeGestures extends GestureTarget {
  fire(type: string): void;
  types(): string[];
}

function fakeGestures(): FakeGestures {
  const map = new Map<string, Array<() => void>>();
  return {
    addEventListener(type, fn) {
      const arr = map.get(type) ?? [];
      arr.push(fn);
      map.set(type, arr);
    },
    fire(type) {
      for (const fn of map.get(type) ?? []) fn();
    },
    types() {
      return [...map.keys()];
    },
  };
}

/** Step the menu's sfx/music thermo to `target` via the REAL row routines
 * (status-2: choice 0 = left, 1 = right — m_menu.c M_SfxVol/M_MusicVol). */
function stepMenuThermo(which: 'sfx' | 'music', target: number): void {
  const row = (which === 'sfx' ? SoundMenu[0] : SoundMenu[2])!;
  const [s, m] = menuState.sndVolumes();
  let cur = which === 'sfx' ? s : m;
  while (cur !== target) {
    row.routine!(cur < target ? 1 : 0);
    const [s2, m2] = menuState.sndVolumes();
    cur = which === 'sfx' ? s2 : m2;
  }
}

beforeEach(() => {
  __resetAudioWiring();
  __resetAudioContext();
  bindVolumes(); // re-register after a context reset (volumes.test idiom)
  setContextFactory(null);
  mReset(); // menu thermos back to 8/8 (m_misc.c:237-238)
  resetVolumesToDefaults();
  lastConsole.mockClear();
});

afterEach(() => {
  __resetAudioWiring();
  setContextFactory(null);
  __resetAudioContext();
  resetVolumesToDefaults();
  mReset();
});

const lastConsole = vi.fn();
function watchConsole(): void {
  for (const key of ['log', 'warn', 'error', 'info'] as const) {
    const spy = vi.spyOn(console, key);
    spy.mockImplementation((...args: unknown[]) => {
      lastConsole(key, ...args);
      return undefined;
    });
  }
}
beforeEach(() => watchConsole());
afterEach(() => vi.restoreAllMocks());

/* ------------------------------------------------------------------ */

describe('install defaults + shape (acceptance 3/4)', () => {
  it('installs idempotently with ZERO console output and no context', () => {
    installAudioWiring({ gestures: false, pump: 'manual' });
    installAudioWiring({ gestures: false, pump: 'manual' });
    expect(audioWiringInstalled()).toBe(true);
    expect(lastConsole).not.toHaveBeenCalled();
    expect(platformState()).toBe('absent'); // node: no AudioContext built
    const a = audioWiringState();
    // vanilla truth pinned: thermos DEFAULTS are 8/8 (m_misc.c:237-238),
    // NOT the 15 of the raw s_sound.c:113/:116 globals (overridden at load
    // m_misc.c:830/:847); m_musicvol is a REAL routine (m_menu.c:820-849),
    // not a no-op.
    expect(a.sfxVolume).toBe(THERMO_DEFAULT);
    expect(a.musicVolume).toBe(THERMO_DEFAULT);
    expect(a.sfxInternal).toBe(THERMO_DEFAULT * THERMO_SCALE); // D-10d *8
    expect(a.musicInternal).toBe(THERMO_DEFAULT * THERMO_SCALE);
    expect(a.sfxBusGain).toBeCloseTo((THERMO_DEFAULT * THERMO_SCALE) / 127, 10);
    expect(a.musicBusGain).toBeCloseTo(((THERMO_DEFAULT * THERMO_SCALE) / 127) * MUSIC_TRIM, 10);
    expect(a.muted).toBe(false);
    expect(a.wired).toBe(true);
    expect(a.music).toEqual({ lump: null, playing: false, paused: false });
    expect(a.activeVoices).toBe(0);
    expect(a.missingLumps).toBe(0);
  });

  it('reads work WITHOUT install (absent-object safety, no wad, no throw)', () => {
    expect(audioWiringInstalled()).toBe(false);
    const a = audioWiringState();
    expect(a.wired).toBe(false);
    expect(a.sfxVolume).toBe(8);
    expect(a.sfxBusGain).toBeCloseTo(64 / 127, 10);
  });

  it('driver census overrides merge over the zero defaults', () => {
    registerAudioCensus(() => ({
      activeVoices: 5,
      music: { lump: 'D_E1M1', playing: true, paused: false },
    }));
    const a = audioWiringState();
    expect(a.activeVoices).toBe(5);
    expect(a.missingLumps).toBe(0);
    expect(a.music).toEqual({ lump: 'D_E1M1', playing: true, paused: false });
  });
});

describe('volume plumbing: menu arrows -> internal ints -> gains (acceptance 1)', () => {
  it('exact 0..15 sweep, sfx row: thermo -> *8 internal -> linear /127 gain', () => {
    installAudioWiring({ gestures: false, pump: 'manual' });
    for (let t = 0; t <= 15; t++) {
      stepMenuThermo('sfx', t);
      const a = audioWiringState(); // state read pumps: L4-observable
      expect(a.sfxVolume).toBe(t);
      expect(a.sfxInternal).toBe(t * 8);
      expect(a.sfxBusGain).toBeCloseTo((t * 8) / 127, 10);
      expect(a.musicVolume).toBe(8); // other channel untouched
      expect(a.musicInternal).toBe(64);
    }
  });

  it('exact 0..15 sweep, music row: *8 internal -> /127 * MUSIC_TRIM', () => {
    installAudioWiring({ gestures: false, pump: 'manual' });
    for (let t = 0; t <= 15; t++) {
      stepMenuThermo('music', t);
      const a = audioWiringState();
      expect(a.musicVolume).toBe(t);
      expect(a.musicInternal).toBe(t * 8);
      expect(a.musicBusGain).toBeCloseTo(((t * 8) / 127) * MUSIC_TRIM, 10);
    }
  });

  it('thermo 0 => exact zero gains on BOTH numbers', () => {
    stepMenuThermo('sfx', 0);
    stepMenuThermo('music', 0);
    const a = audioWiringState();
    expect(a.sfxBusGain).toBe(0);
    expect(a.musicBusGain).toBe(0);
  });

  it('pump is a no-op while the menu state is unchanged (change detection)', () => {
    const mirror = vi.fn();
    registerVolumeMirror(mirror);
    expect(pumpAudioWiring()).toBe(true); // first apply always runs
    expect(mirror).toHaveBeenCalledTimes(1);
    expect(pumpAudioWiring()).toBe(false);
    expect(mirror).toHaveBeenCalledTimes(1);
    stepMenuThermo('sfx', 10);
    expect(pumpAudioWiring()).toBe(true);
    expect(mirror).toHaveBeenCalledTimes(2);
    expect(mirror).toHaveBeenLastCalledWith(10 * 8, 8 * 8);
  });

  it('live graph: a menu arrow ramps the exact law onto the sfx bus node', () => {
    const ctx = new MockCtx();
    setContextFactory(() => ctx as unknown as AudioContextLike);
    installAudioWiring({ gestures: false, pump: 'manual' });
    ensureContext();
    expect(busSet.live).toBe(true);
    // graph = master + 2 buses; buses adopted the current law at build.
    const [master, sfx, music] = ctx.gains;
    expect(gainOf(sfx!.param)).toBeCloseTo(64 / 127, 10);
    expect(gainOf(music!.param)).toBeCloseTo((64 / 127) * MUSIC_TRIM, 10);
    expect(gainOf(master!.param)).toBe(1);
    stepMenuThermo('sfx', 2); // pump on the state read moves the node
    audioWiringState();
    expect(gainOf(sfx!.param)).toBeCloseTo(16 / 127, 10);
    expect(gainOf(music!.param)).toBeCloseTo((64 / 127) * MUSIC_TRIM, 10);
  });
});

describe('live fan-out composer (single registration point)', () => {
  it('sfxSink + musicSlot reach the registered consumers verbatim', () => {
    installAudioWiring({ gestures: false, pump: 'manual' });
    const sfxSpy = vi.fn();
    const musicSpy = vi.fn();
    registerWiringSfxConsumer(sfxSpy);
    registerWiringMusicConsumer(musicSpy);
    sfxSink('sfx_pistol', { x: 128, y: -64, z: 0, o: 7 });
    expect(sfxSpy).toHaveBeenCalledWith('sfx_pistol', { x: 128, y: -64, z: 0, o: 7 }, 128, -64, 0, 0);
    sfxSink(42, null);
    expect(sfxSpy).toHaveBeenLastCalledWith(42, null, 0, 0, 0, 0);
    musicSlot('title', false);
    expect(musicSpy).toHaveBeenCalledWith('title', false, 0);
    // removal clears (composer API, null = unregister all)
    registerWiringSfxConsumer(null);
    registerWiringMusicConsumer(null);
    sfxSink('sfx_oof', null);
    musicSlot('level', true);
    expect(sfxSpy).toHaveBeenCalledTimes(2);
    expect(musicSpy).toHaveBeenCalledTimes(1);
  });
});

describe('gesture gate (first key/click => ensureContext)', () => {
  it('no context before the gesture; built + unmuted master after', () => {
    const ctx = new MockCtx();
    ctx.state = 'suspended';
    setContextFactory(() => ctx as unknown as AudioContextLike);
    const target = fakeGestures();
    installAudioWiring({ gestures: target, pump: 'manual' });
    expect(platformState()).toBe('unbuilt'); // nothing constructed yet
    target.fire('pointerdown');
    expect(platformState()).toBe('running');
    const [master] = ctx.gains;
    expect(gainOf(master!.param)).toBe(1); // gesture unmute
    expect(target.types().sort()).toEqual(['keydown', 'pointerdown']);
  });
});
