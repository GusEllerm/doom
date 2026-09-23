/**
 * Tests for audio/context.ts — AudioContext lifecycle, gesture gate, buses,
 * pause split, queueing, offline harness (M10-01, M10-plan §M10-01).
 *
 * Evidence classes:
 *  1. ABSENCE PATH: no AudioContext anywhere (node) => ensureContext is a
 *     no-op, the constructor spy is NEVER called (plan acceptance 3).
 *  2. GESTURE STATE MACHINE: unbuilt -> suspended (on first build) -> running
 *     (resume attempt = autoplay unlock); queued ops flush FIFO exactly once
 *     on the running transition; overflow past MAX_PENDING_QUEUE drops.
 *  3. GRAPH SHAPE: exactly three GainNodes (sfx, music, master), wired
 *     sfx->master->destination and music->master; NO panner nodes (D027 —
 *     source scan proves StereoPannerNode cannot exist in this module).
 *  4. MUTE/PAUSE: setTestMute pins master at 0 across the gesture (plan
 *     acceptance 4); pause silences the MUSIC bus only (s_sound.c:497-513).
 *  5. OFFLINE HARNESS: renderMixOffline double-render is bit-equal
 *     (determinism primitive), and the absent platform rejects typed.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AudioUnavailableError,
  MAX_PENDING_QUEUE,
  attemptResume,
  audioAvailable,
  buffersBitEqual,
  busSet,
  droppedOpCount,
  enqueue,
  ensureContext,
  getListenerPosition,
  isMusicPaused,
  pendingOpCount,
  platformState,
  registerMusicGainSource,
  renderMixOffline,
  resumeFromPause,
  setContextFactory,
  setListenerPosition,
  setOfflineContextFactory,
  setTestMute,
  suspendForPause,
  testMuted,
  __resetAudioContext,
  type AudioContextLike,
  type GainNodeLike,
} from './context';

/* ------------------------------------------------------------------ */
/* Mock WebAudio (structural; the module only ever sees these shapes)  */
/* ------------------------------------------------------------------ */

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
  connects: unknown[] = [];
  connect(dest: unknown): void {
    this.connects.push(dest);
  }
}

class MockContext implements AudioContextLike {
  state = 'suspended';
  currentTime = 0;
  readonly sampleRate = 48000;
  readonly destination = { kind: 'destination' } as const;
  readonly gains: MockGain[] = [];
  resumeCalls = 0;
  resumeMode: 'ok' | 'reject' = 'ok';
  onstatechange: (() => void) | null = null;
  private readonly listeners: Array<() => void> = [];

  createGain(): MockGain {
    const g = new MockGain();
    this.gains.push(g);
    return g;
  }
  addEventListener(_type: 'statechange', cb: () => void): void {
    this.listeners.push(cb);
  }
  resume(): Promise<void> {
    this.resumeCalls += 1;
    if (this.resumeMode === 'reject') return Promise.reject(new Error('autoplay policy'));
    this.state = 'running';
    this.fire();
    return Promise.resolve();
  }
  /** Drive the statechange watchers (mock of the browser's own event). */
  fire(): void {
    this.onstatechange?.();
    for (const f of this.listeners.slice()) f();
  }
}

/** Factory harness: installs a mock factory; `made` records every context. */
function installMock(defaults?: Partial<MockContext>): { made: MockContext[] } {
  const made: MockContext[] = [];
  setContextFactory(() => {
    const c = new MockContext();
    if (defaults) Object.assign(c, defaults);
    made.push(c);
    return c;
  });
  return { made };
}

afterEach(() => {
  __resetAudioContext();
});

/* ------------------------------------------------------------------ */
/* 1. Absence path (node env; plan acceptance 3)                       */
/* ------------------------------------------------------------------ */

describe('absence path (no AudioContext)', () => {
  it('node has no AudioContext: ensureContext is a no-op returning false', () => {
    const g = globalThis as { AudioContext?: unknown };
    expect(g.AudioContext).toBeUndefined(); // node env — the absence premise
    expect(audioAvailable()).toBe(false);
    expect(platformState()).toBe('absent');
    expect(ensureContext()).toBe(false);
    expect(platformState()).toBe('absent');
    expect(busSet.live).toBe(false);
    // no-op safety: every control remains callable
    busSet.setSfx(0.5);
    suspendForPause();
    resumeFromPause();
    expect(enqueue(() => undefined)).toBe('queued'); // nothing running
  });

  it('constructor spy: importing + all census APIs construct ZERO contexts', () => {
    class SpyContext extends MockContext {
      static constructed = 0;
      constructor() {
        super();
        SpyContext.constructed += 1;
      }
    }
    const g = globalThis as { AudioContext?: unknown };
    g.AudioContext = SpyContext;
    try {
      expect(audioAvailable()).toBe(true);
      expect(SpyContext.constructed).toBe(0);
      expect(platformState()).toBe('unbuilt');
      expect(SpyContext.constructed).toBe(0); // census never constructs
      busSet.setSfx(0.5);
      enqueue(() => undefined);
      suspendForPause();
      resumeFromPause();
      expect(SpyContext.constructed).toBe(0);
      expect(ensureContext()).toBe(true); // the gesture is the ONLY site
      expect(SpyContext.constructed).toBe(1);
    } finally {
      delete g.AudioContext;
    }
  });

  it('renderMixOffline rejects typed when the offline platform is absent', async () => {
    setOfflineContextFactory(null); // global lookup -> absent in node
    await expect(renderMixOffline(16, 8000, () => undefined)).rejects.toBeInstanceOf(
      AudioUnavailableError,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 2. Gesture-unlock state machine (mock ctx)                          */
/* ------------------------------------------------------------------ */

describe('gesture-unlock state machine', () => {
  it('unbuilt -> ensure -> build+resume-attempt -> running; idempotent', async () => {
    const { made } = installMock();
    expect(platformState()).toBe('unbuilt');
    expect(ensureContext()).toBe(true);
    expect(made.length).toBe(1); // ONE construction site, ever
    expect(made[0]!.resumeCalls).toBe(1); // the first-input resume attempt
    expect(await Promise.resolve().then(() => platformState())).toBe('running');
    expect(ensureContext()).toBe(true);
    expect(made.length).toBe(1); // idempotent
  });

  it('stays suspended when resume rejects; later resume flushes queue', async () => {
    const { made } = installMock({ resumeMode: 'reject' });
    const order: string[] = [];
    expect(ensureContext()).toBe(true);
    expect(platformState()).toBe('suspended');
    expect(enqueue(() => order.push('a'))).toBe('queued');
    attemptResume();
    await Promise.resolve();
    expect(platformState()).toBe('suspended');
    expect(order).toEqual([]);
    // The gesture "takes": browser flips state; our watchers flush FIFO.
    made[0]!.state = 'running';
    made[0]!.fire();
    expect(order).toEqual(['a']);
    expect(platformState()).toBe('running');
  });

  it('ops enqueued before the gesture flush FIFO exactly once on unlock', async () => {
    installMock();
    const order: number[] = [];
    for (let i = 0; i < 5; i++) expect(enqueue(() => order.push(i))).toBe('queued');
    expect(pendingOpCount()).toBe(5);
    ensureContext(); // gesture -> resume -> running -> flush
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(pendingOpCount()).toBe(0);
    // running now: ops run inline
    expect(enqueue(() => order.push(9))).toBe('ran');
    expect(order).toEqual([0, 1, 2, 3, 4, 9]);
  });

  it('queue overflow drops (counted), never throws, never grows', () => {
    installMock(); // unbuilt => everything queues
    let results = 0;
    for (let i = 0; i < MAX_PENDING_QUEUE; i++) results += enqueue(() => undefined) === 'queued' ? 1 : 0;
    expect(results).toBe(MAX_PENDING_QUEUE);
    expect(enqueue(() => undefined)).toBe('dropped');
    expect(enqueue(() => undefined)).toBe('dropped');
    expect(droppedOpCount()).toBe(2);
    expect(pendingOpCount()).toBe(MAX_PENDING_QUEUE);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Graph shape + D027 (no panner nodes)                             */
/* ------------------------------------------------------------------ */

describe('bus graph', () => {
  it('creates exactly 3 GainNodes: sfx->master, music->master, master->destination', () => {
    const { made } = installMock();
    ensureContext();
    const ctx = made[0]!;
    expect(ctx.gains.length).toBe(3); // master, sfx, music — nothing else
    const [master, sfx, music] = ctx.gains;
    expect(sfx!.connects).toContain(master);
    expect(music!.connects).toContain(master);
    expect(master!.connects).toContain(ctx.destination);
    expect(busSet.live).toBe(true);
  });

  it('master is muted until the gesture unmutes it (0 -> 1 via ramp)', () => {
    const { made } = installMock();
    expect(busSet.master()).toBe(0); // muted-by-default-until-gesture
    expect(ensureContext()).toBe(true);
    const master = made[0]!.gains[0]!;
    expect(master.gain.value).toBe(1);
    expect(master.gain.rampCalls.some(([t, , tc]) => t === 1 && tc > 0)).toBe(true);
  });

  it('D027: the module source contains NO panner node of any kind', () => {
    for (const file of ['./context.ts', './volumes.ts']) {
      const raw = readFileSync(new URL(file, import.meta.url), 'utf8');
      const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code, file).not.toMatch(/StereoPanner|PannerNode|AudioListener/);
    }
  });

  it('listener plumbing stores position ONLY (never fed to a node)', () => {
    expect(getListenerPosition()).toEqual({ x: 0, y: 0, z: 0 });
    setListenerPosition(128 << 16, -64 << 16, 0);
    expect(getListenerPosition()).toEqual({ x: 128 * 65536, y: -64 * 65536, z: 0 });
    const { made } = installMock();
    ensureContext();
    expect(made[0]!.gains.length).toBe(3); // plumbing created NO nodes
  });
});

/* ------------------------------------------------------------------ */
/* 4. Test mute + pause split                                          */
/* ------------------------------------------------------------------ */

describe('setTestMute (plan acceptance 4)', () => {
  it('pins master at 0 across the gesture and restores on unmute', () => {
    const { made } = installMock();
    setTestMute(true);
    expect(testMuted()).toBe(true);
    ensureContext();
    expect(made[0]!.gains[0]!.gain.value).toBe(0);
    setTestMute(false);
    expect(made[0]!.gains[0]!.gain.value).toBe(1);
  });
});

describe('pause split (g_game.c:705-712 + s_sound.c:497-513)', () => {
  it('suspendForPause silences MUSIC only; sfx bus and ctx untouched', () => {
    const { made } = installMock();
    registerMusicGainSource(() => 0.25);
    ensureContext();
    const ctx = made[0]!;
    const [master, sfx, music] = ctx.gains;
    expect(music!.gain.value).toBe(0.25); // pushed by registration
    expect(sfx!.gain.value).toBe(1);
    expect(master!.gain.value).toBe(1);
    suspendForPause();
    expect(isMusicPaused()).toBe(true);
    expect(music!.gain.value).toBe(0); // music silences
    expect(sfx!.gain.value).toBe(1); // already-scheduled sfx keep playing
    expect(ctx.state).toBe('running'); // context NOT suspended
    resumeFromPause();
    expect(isMusicPaused()).toBe(false);
    expect(music!.gain.value).toBe(0.25); // restored via the gain source
  });

  it('music-gain sets during pause stay silent; resume restores the LAW', () => {
    installMock();
    registerMusicGainSource(() => 0.3);
    ensureContext();
    suspendForPause();
    busSet.setMusic(0.9);
    expect(busSet.music()).toBe(0); // paused: no sound escapes
    resumeFromPause();
    expect(busSet.music()).toBe(0.3); // the source law, not the stale 0.9
  });
});

/* ------------------------------------------------------------------ */
/* 5. Offline harness (determinism primitive)                          */
/* ------------------------------------------------------------------ */

/** Deterministic fake renderer: output = master*sfx gain (pure fn of bus). */
function installOfflineMock(): void {
  setOfflineContextFactory((channels, frames, sampleRate) => {
    const gains: MockGain[] = [];
    const ctx: AudioContextLike & { startRendering(): Promise<{ numberOfChannels: number; getChannelData(c: number): Float32Array }> } = {
      sampleRate,
      currentTime: 0,
      state: 'closed',
      destination: { kind: 'destination' },
      onstatechange: null,
      createGain(): GainNodeLike {
        const g = new MockGain();
        gains.push(g);
        return g;
      },
      resume: () => Promise.resolve(),
      startRendering: async () => {
        const [master, sfx] = gains;
        const v = (master!.gain.value + 1) * sfx!.gain.value + frames / 1e6 + sampleRate / 1e9;
        return {
          numberOfChannels: channels,
          getChannelData: () => new Float32Array(frames).fill(v),
        };
      },
    };
    return ctx;
  });
}

describe('renderMixOffline harness', () => {
  it('same input twice => bit-equal buffers (determinism assertion)', async () => {
    installOfflineMock();
    const wire = (ctx: AudioContextLike, buses: { setSfx: (v: number) => void }): void => {
      buses.setSfx(ctx.sampleRate > 0 ? 0.75 : 0);
    };
    const a = await renderMixOffline(64, 48000, wire);
    const b = await renderMixOffline(64, 48000, wire);
    expect(a.channels.length).toBe(2);
    expect(buffersBitEqual(a, b)).toBe(true);
    const c = await renderMixOffline(64, 44100, wire);
    expect(buffersBitEqual(a, { ...c, sampleRate: a.sampleRate })).toBe(false); // sensitivity
  });

  it('buffersBitEqual is bitwise (Object.is): -0 != 0, NaN == NaN', () => {
    const mk = (ch: Float32Array): { sampleRate: number; channels: Float32Array[] } => ({
      sampleRate: 8000,
      channels: [ch],
    });
    expect(buffersBitEqual(mk(new Float32Array([-0, 1])), mk(new Float32Array([0, 1])))).toBe(false);
    expect(buffersBitEqual(mk(new Float32Array([NaN])), mk(new Float32Array([NaN])))).toBe(true);
  });
});
