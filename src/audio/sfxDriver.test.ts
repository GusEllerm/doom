/**
 * Tests for audio/sfxDriver.ts — the WebAudio SFX driver (M10-06,
 * M10-plan §M10-06): mock-graph node-op exactness (plan acceptance 1),
 * zero-op absence path (acceptance 2 + the headless contract), the D-10f
 * tic-boundary clock (acceptance 5), counted missing lumps (acceptance 4),
 * the unlock-flush cap/age rules, the 2 ms steal fade, the S_Start
 * level-change kill, and the no-leak disconnect census.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  busSet,
  ensureContext,
  platformState,
  setContextFactory,
  __resetAudioContext,
  type AudioContextLike,
} from './context';
import { bindVolumes } from './volumes';
import { addsfxSplit, sfxJitter, type MixSfxData } from './mixerCore';
import {
  STOP_MARGIN,
  QUEUE_CAP,
  __resetSfxDriver,
  createSfxDriver,
  type SfxBufferLike,
  type SfxDriver,
  type SfxGainNodeLike,
  type SfxMergerNodeLike,
  type SfxSimView,
  type SfxSourceNodeLike,
} from './sfxDriver';

/* ------------------------------------------------------------------ */
/* Mock WebAudio graph (records every op the driver performs)          */
/* ------------------------------------------------------------------ */

class MockParam {
  value = 0;
  readonly ramps: Array<[number, number, number]> = [];
  setTargetAtTime(target: number, startTime: number, tc: number): void {
    this.ramps.push([target, startTime, tc]);
    this.value = target;
  }
}

class MockGain implements SfxGainNodeLike {
  readonly gain = new MockParam();
  readonly connects: Array<{ dest: unknown; input?: number }> = [];
  disconnects = 0;
  connect(dest: unknown, _output?: number, input?: number): void {
    this.connects.push({ dest, input });
  }
  disconnect(): void {
    this.disconnects++;
  }
}

class MockSource implements SfxSourceNodeLike {
  buffer: SfxBufferLike | null = null;
  readonly playbackRate = new MockParam();
  loop = false;
  onended: (() => void) | null = null;
  readonly starts: number[] = [];
  readonly stops: number[] = [];
  disconnects = 0;
  connect(): void {
    /* sources connect through their gains only in this mock's usage */
  }
  disconnect(): void {
    this.disconnects++;
  }
  start(when: number): void {
    this.starts.push(when);
  }
  stop(when: number): void {
    this.stops.push(when);
  }
}

class MockMerger implements SfxMergerNodeLike {
  disconnects = 0;
  readonly connects: Array<{ dest: unknown; input?: number }> = [];
  connect(dest: unknown, _output?: number, input?: number): void {
    this.connects.push({ dest, input });
  }
  disconnect(): void {
    this.disconnects++;
  }
}

class MockContext implements AudioContextLike {
  state = 'running';
  currentTime = 5;
  readonly sampleRate = 48_000;
  readonly destination = { kind: 'destination' } as const;
  onstatechange: (() => void) | null = null;
  readonly gains: MockGain[] = [];
  readonly sources: MockSource[] = [];
  readonly mergers: MockMerger[] = [];
  readonly buffers: MockBuffer[] = [];
  resumeCalls = 0;

  createGain(): MockGain {
    const g = new MockGain();
    this.gains.push(g);
    return g;
  }
  createBufferSource(): MockSource {
    const s = new MockSource();
    this.sources.push(s);
    return s;
  }
  createBuffer(_channels: number, length: number, sampleRate: number): MockBuffer {
    const b = new MockBuffer(length, sampleRate);
    this.buffers.push(b);
    return b;
  }
  createChannelMerger(): MockMerger {
    const m = new MockMerger();
    this.mergers.push(m);
    return m;
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    return Promise.resolve();
  }
}

class MockBuffer implements SfxBufferLike {
  private readonly data: Float32Array;
  constructor(readonly length: number, readonly sampleRate: number) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const F = 65_536;

/** 0.5 s @ 22050 Hz test PCM (id 1 = pistol). */
function fakeData(seconds = 0.5, rate = 22_050): MixSfxData {
  const n = Math.round(seconds * rate);
  const samples = new Float32Array(n);
  samples.fill(0.125);
  return { rate, samples };
}

interface TestState extends SfxSimView {
  players: { mo: { x: number; y: number; z: number; angle: number } }[];
  map: Record<string, number>;
  leveltime: number;
  gametic: number;
}

function makeState(): TestState {
  return {
    players: [{ mo: { x: 0, y: 0, z: 0, angle: 0 } }],
    map: { n: 1 },
    gamemap: 1,
    leveltime: 0,
    gametic: 0,
  };
}

/** Boot the mock world: injected context + built graph + a driver over the
 * fake data resolver and a controllable wall clock. */
function setup(opts: {
  data?: (id: number) => MixSfxData | null;
  wall?: number;
  running?: boolean;
}): { ctx: MockContext; driver: SfxDriver; state: TestState; now: { wall: number } } {
  __resetSfxDriver();
  __resetAudioContext();
  bindVolumes();
  const ctx = new MockContext();
  ctx.state = opts.running === false ? 'suspended' : 'running';
  setContextFactory(() => ctx);
  ensureContext(); // the gesture stand-in: builds the bus graph
  const now = { wall: opts.wall ?? 100 };
  const driver = createSfxDriver({
    resolve: opts.data ?? (() => fakeData()),
    wallNow: () => now.wall,
  });
  return { ctx, driver, state: makeState(), now };
}

/** Advance the fake clock + the driver's view by n tics (1/35 s each). */
function runTics(ctx: MockContext | null, driver: SfxDriver, state: TestState, n: number): void {
  for (let i = 0; i < n; i++) {
    if (ctx !== null) ctx.currentTime += 1 / 35;
    state.leveltime += 1;
    state.gametic += 1;
    driver.tick(state);
  }
}

function fire(driver: SfxDriver, id = 1, origin: { x: number; y: number; z: number } | null = null): void {
  driver.onSfxEvent(id, origin, origin ? origin.x : 0, origin ? origin.y : 0, 0, 0);
}

afterEach(() => {
  __resetSfxDriver();
  __resetAudioContext();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* 1. Exact node ops (plan acceptance 1)                               */
/* ------------------------------------------------------------------ */

describe('sfxDriver node ops', () => {
  it('fires one voice: source start at the tic-boundary time, exact gains and rate', () => {
    const { ctx, driver, state } = setup({});
    fire(driver);
    runTics(ctx, driver, state, 1);

    expect(ctx.sources).toHaveLength(1);
    const src = ctx.sources[0]!;
    // D-10f: scheduled at the boundary stamped THIS tic (currentTime at
    // tick) + MIN_LEAD — |when − now| < one audio block (acceptance 5).
    const now = ctx.currentTime;
    expect(src.starts).toHaveLength(1);
    expect(Math.abs(src.starts[0]! - now)).toBeLessThan(0.01);
    expect(driver.debug().lastSchedDelta).toBeLessThan(0.01);

    // playbackRate = (pcmRate/contextRate) × (pitch/128), pitch = 128 +
    // D-10a splitmix jitter for (tic, id, origin).
    const pitch = 128 + sfxJitter(state.leveltime, 1, null);
    expect(src.playbackRate.value).toBeCloseTo((22_050 / 48_000) * (pitch / 128), 10);
    expect(src.loop).toBe(false); // §0.4: the looping column is never read

    // Graph: source → {left,right} gains → merger (L=0,R=1) → chGain → sfxBus.
    // Bus gains 0..2 are context.ts's (master/sfx/music); the voice made 3.
    expect(ctx.gains).toHaveLength(6);
    const [chGain, left, right] = [ctx.gains[3]!, ctx.gains[4]!, ctx.gains[5]!];
    expect(ctx.mergers).toHaveLength(1);
    expect(left.connects[0]!.dest).toBe(ctx.mergers[0]);
    expect(left.connects[0]!.input).toBe(0);
    expect(right.connects[0]!.input).toBe(1);
    expect(ctx.mergers[0]!.connects[0]!.dest).toBe(chGain);
    expect(chGain.connects[0]!.dest).toBe(busSet.sfxNode!());

    // NULL-origin sound = listener-local: vol = snd_SfxVolume (64, D-10d),
    // sep = NORM_SEP 128 → the plan's law: chGain = v/127, L/R = quadratic
    // (addsfxSplit at the 127 law ceiling).
    expect(chGain.gain.value).toBeCloseTo(64 / 127, 10);
    const split = addsfxSplit(127, 128);
    expect(left.gain.value).toBeCloseTo(split.left / 127, 10);
    expect(right.gain.value).toBeCloseTo(split.right / 127, 10);

    expect(driver.debug().activeVoices).toBe(1);
    expect(driver.debug().activeChannels).toBe(1);
    expect(driver.debug().sourcesStarted).toBe(1);
  });

  it('spatializes an origin sound: distance-attenuated chGain + panned L/R', () => {
    const { ctx, driver, state } = setup({});
    // Source 200 map-units due east, listener at the origin facing east:
    // vol = 64×(1200−200)/1040 = 61 (s_sound.c:810-813, truncated).
    fire(driver, 1, { x: 200 * F, y: 0, z: 0 });
    runTics(ctx, driver, state, 1);
    expect(ctx.sources).toHaveLength(1);
    const chGain = ctx.gains[3]!;
    const [left, right] = [ctx.gains[4]!, ctx.gains[5]!];
    expect(chGain.gain.value).toBeCloseTo(61 / 127, 10);
    expect(left.gain.value).not.toBe(right.gain.value);
    // The split is consistent with SOME sep in range (exact seps are the
    // spatial.test.ts table's job; here: the driver mirrors the mixer).
    for (const g of [left, right]) {
      expect(g.gain.value).toBeGreaterThan(0);
      expect(g.gain.value).toBeLessThanOrEqual(1);
    }
  });

  it('drops an inaudible (>1200) start silently: no channel, no node', () => {
    const { ctx, driver, state } = setup({});
    fire(driver, 1, { x: 1300 * F, y: 0, z: 0 });
    runTics(ctx, driver, state, 1);
    expect(ctx.sources).toHaveLength(0);
    expect(driver.debug().activeChannels).toBe(0);
  });

  it('retrigger of the SAME sound restarts: old voice fades 2 ms, new starts at the same when', () => {
    const { ctx, driver, state } = setup({});
    fire(driver); // sfx_pistol — also in the addsfx dedup set
    runTics(ctx, driver, state, 1);
    runTics(ctx, driver, state, 8); // still playing (0.5 s ≈ 17 tics)
    fire(driver);
    runTics(ctx, driver, state, 1);

    expect(ctx.sources).toHaveLength(2);
    const [oldSrc, newSrc] = [ctx.sources[0]!, ctx.sources[1]!];
    expect(oldSrc.stops).toHaveLength(1);
    // Steal = 2 ms fade + start at the SAME when (plan acceptance 1) — the
    // old source's stop lands STOP_MARGIN past that shared `when`.
    const when = newSrc.starts[0]!;
    expect(oldSrc.stops[0]!).toBeCloseTo(when + STOP_MARGIN, 10);
    const oldChGain = ctx.gains[3]!;
    const fade = oldChGain.gain.ramps.at(-1)!;
    expect(fade[0]).toBe(0);
    expect(fade[2]).toBeCloseTo(0.002, 10); // FADE_TC
    expect(driver.debug().sourcesStopped).toBe(1);
    expect(driver.debug().activeVoices).toBe(1);
  });

  it('retires a finished sound: mixer frees the channel, voice stops + disconnects once', () => {
    const { ctx, driver, state } = setup({ data: () => fakeData(0.2) });
    fire(driver);
    runTics(ctx, driver, state, 1);
    for (let i = 0; i < 12 && driver.debug().activeChannels > 0; i++) {
      runTics(ctx, driver, state, 1);
    }
    expect(driver.debug().activeChannels).toBe(0);
    expect(driver.debug().activeVoices).toBe(0);
    const src = ctx.sources[0]!;
    expect(src.stops).toHaveLength(1);
    src.onended!();
    src.onended!(); // idempotent
    expect(driver.debug().sourcesDisconnected).toBe(1);
    expect(src.disconnects).toBe(1);
    expect(ctx.gains[3]!.disconnects).toBe(1);
    expect(ctx.mergers[0]!.disconnects).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 2. Absence path + counted misses (acceptances 2 + 4)                */
/* ------------------------------------------------------------------ */

describe('sfxDriver fallbacks', () => {
  it('zero-op with no AudioContext: pure-mixer census, no nodes, no console', () => {
    __resetSfxDriver();
    __resetAudioContext();
    bindVolumes();
    expect(platformState()).toBe('absent'); // node: no AudioContext global
    const err = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const driver = createSfxDriver({ resolve: () => fakeData(0.5) });
    const state = makeState();
    fire(driver);
    runTics(null, driver, state, 1); // no context exists — pure-mixer path
    const d = driver.debug();
    expect(d.context).toBe('absent');
    expect(d.sourcesCreated).toBe(0);
    expect(d.activeChannels).toBe(1); // the pure-mixer census still advances
    runTics(null, driver, state, 20);
    expect(driver.debug().activeChannels).toBe(0);
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('missing DS lump: counted drop, never a console line', () => {
    const err = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const { ctx, driver, state } = setup({ data: () => null });
    fire(driver);
    runTics(ctx, driver, state, 1);
    expect(driver.debug().missingLumps).toBe(1);
    expect(ctx.sources).toHaveLength(0);
    expect(err).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('unknown sfx NAME from a UI sink: counted, never console, never throws', () => {
    const { ctx, driver, state } = setup({});
    driver.onSfxEvent('sfx_not_a_sound', null, 0, 0, 0, 0);
    runTics(ctx, driver, state, 1);
    expect(driver.debug().unknownNames).toBe(1);
    expect(ctx.sources).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Listener tracking + level change + unlock flush                  */
/* ------------------------------------------------------------------ */

describe('sfxDriver lifecycle', () => {
  it('follows the viewplayer listener pose', () => {
    const { ctx, driver, state } = setup({});
    state.players[0]!.mo.x = 512 * F;
    state.players[0]!.mo.y = -256 * F;
    runTics(ctx, driver, state, 2);
    expect(driver.debug().listener).toEqual({ x: 512 * F, y: -256 * F });
  });

  it('level change stops everything (the S_Start channel-kill half)', () => {
    const { ctx, driver, state } = setup({});
    fire(driver);
    runTics(ctx, driver, state, 3);
    expect(driver.debug().activeChannels).toBe(1);
    state.map = { n: 2 }; // the P_SetupLevel identity swap
    runTics(ctx, driver, state, 1);
    expect(driver.debug().activeChannels).toBe(0);
    expect(driver.debug().activeVoices).toBe(0);
    expect(ctx.sources[0]!.stops).toHaveLength(1);
    expect(driver.debug().sourcesStopped).toBe(1);
  });

  it('queued events flush at the unlock (cap + age rules)', () => {
    const { ctx, driver, state, now } = setup({ running: false });
    expect(platformState()).toBe('suspended');

    fire(driver);
    runTics(ctx, driver, state, 1);
    expect(driver.debug().queuedEvents).toBe(1); // ledger kept, no nodes
    expect(ctx.sources).toHaveLength(0);

    // Cap rule: overflow drops the OLDEST, counted.
    for (let i = 0; i < QUEUE_CAP + 10; i++) driver.onSfxEvent(1, null, 0, 0, 0, 0);
    expect(driver.debug().queuedEvents).toBe(QUEUE_CAP);
    expect(driver.debug().queueDrops).toBe(1 + QUEUE_CAP + 10 - QUEUE_CAP);

    // Age rule: past QUEUE_MAX_AGE the flush drops them instead of playing.
    now.wall += 5;
    runTics(ctx, driver, state, 1);
    expect(driver.debug().queuedEvents).toBe(0);

    // Unlock: a fresh event plays at the next tick.
    fire(driver);
    ctx.state = 'running';
    runTics(ctx, driver, state, 1);
    expect(ctx.sources).toHaveLength(1);
    expect(driver.debug().context).toBe('running');
  });

  it('pre-unlock channels never start mid-buffer after the unlock', () => {
    __resetSfxDriver();
    __resetAudioContext();
    bindVolumes();
    const now = { wall: 100 };
    const driver = createSfxDriver({ resolve: () => fakeData(), wallNow: () => now.wall });
    const state = makeState();
    // Consume the start with NO context at all (voice records unvoiced).
    fire(driver);
    state.leveltime += 1;
    driver.tick(state);
    expect(driver.debug().activeChannels).toBe(1); // mixer running, unvoiced
    // The gesture arrives: context built + running; the aged channel stays
    // silent (no mid-buffer starts), a NEW sound voices.
    const ctx = new MockContext();
    setContextFactory(() => ctx);
    ensureContext();
    state.leveltime += 1;
    ctx.currentTime += 1 / 35;
    driver.tick(state);
    expect(ctx.sources).toHaveLength(0);
    fire(driver);
    state.leveltime += 1;
    ctx.currentTime += 1 / 35;
    driver.tick(state);
    expect(ctx.sources).toHaveLength(1);
  });
});
