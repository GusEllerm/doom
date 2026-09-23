// audio/context.ts — AudioContext lifecycle, gesture gate, gain buses, and
// the offline-render harness primitive (M10-01, M10-plan §M10-01).
//
// Lifecycle (plan §M10-01 "context.ts"):
//   * LAZY creation: NO AudioContext is ever constructed at import time.
//     `ensureContext()` is the gesture entry point (pointer/key handlers call
//     it via M10-09's wiring); when no constructor exists at all (node /
//     vitest / no-WebAudio browsers) every entry point degrades to a no-op
//     object — every headless path runs with audio UNBUILT (plan acceptance 3:
//     constructor spy asserts zero).
//   * Gesture unlock: first `ensureContext()` builds the graph (masterGain
//     muted until that first gesture), then ATTEMPTS `resume()` — the
//     autoplay-policy unlock. While the context is not `running`, ops passed
//     to `enqueue()` are queued (FIFO, cap `MAX_PENDING_QUEUE`; overflow is
//     dropped and counted, never thrown) and flushed when state hits
//     `running`.
//   * Pause split (g_game.c:705-712 + s_sound.c:497-513): `suspendForPause()`
//     silences the MUSIC bus only — already-scheduled sfx keep playing; the
//     context itself is never suspended by pause (that would freeze sfx too).
//
// Graph (plan: "sfxBus→masterGain→destination, musicBus→masterGain"):
//     sfxBus ──┐
//              ├─ masterGain ─→ destination
//     musicBus ┘
//   The buses are the ONLY owners of volume state: volumes.ts computes the
//   numbers, this module stores/aps them on the GainNodes. The GainNode
//   triplet is the whole node vocabulary this module ever creates —
//   NO PANNER NODES exist here (D027: StereoPannerNode must not appear in
//   this module; panning is the mixer's quadratic L/R split, plan §0.5).
//   Listener plumbing is POSITION ONLY ({x,y,z}) for the spatial math
//   (M10-05) — never fed to an AudioListener.
//
// Offline harness: `renderMixOffline()` builds the same bus graph inside an
// OfflineAudioContext and renders deterministically for the L1 golden corpus.
// NOTE D-10b: the committed goldens certify the plan through the pure-TS
// `renderMix` of M10-05's mixerCore; this helper is the WebAudio-side harness
// (bit-equal double-render checks), not the golden subject.
//
// Zone rule (A-06): imports NOTHING beyond types; sim/ui never import this
// module directly — M10-06/M10-09 compose on top of it.
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* ------------------------------------------------------------------ */
/* Structural WebAudio subset (mock-friendly; D027: no panner types)   */
/* ------------------------------------------------------------------ */

/** The AudioParam surface this module uses. */
export interface AudioParamLike {
  value: number;
  /** Anti-zipper ramp (volumes.ts law); mocks may apply immediately. */
  setTargetAtTime(target: number, startTime: number, timeConstant: number): void;
}

/** A GainNode — the ONLY node kind this module creates (D027). */
export interface GainNodeLike {
  gain: AudioParamLike;
  connect(dest: unknown): void;
}

/** The AudioContext surface this module uses (live or offline). */
export interface AudioContextLike {
  readonly sampleRate: number;
  readonly currentTime: number;
  readonly state: string;
  readonly destination: unknown;
  createGain(): GainNodeLike;
  resume(): Promise<void>;
  /** Either event style is honored for the running-transition flush. */
  onstatechange: (() => void) | null;
  addEventListener?: (type: 'statechange', cb: () => void) => void;
}

/** Factory seam: tests inject mocks; default reads globalThis. */
export type ContextFactory = () => AudioContextLike;
export type OfflineFactory = (channels: number, frames: number, sampleRate: number) => AudioContextLike & {
  startRendering(): Promise<AudioBufferLike>;
};

export interface AudioBufferLike {
  readonly numberOfChannels: number;
  getChannelData(channel: number): Float32Array;
}

/* ------------------------------------------------------------------ */
/* Bus model (the single owner of live volume state)                   */
/* ------------------------------------------------------------------ */

/** setTargetAtTime time constant for bus ramps (anti-zipper, plan §M10-01). */
export const BUS_RAMP_TC = 0.02;

class Bus {
  private _value = 0;
  node: GainNodeLike | null = null;

  get value(): number {
    return this._value;
  }

  set(value: number, ctx: AudioContextLike | null): void {
    this._value = value;
    if (this.node !== null) {
      const param = this.node.gain;
      if (ctx !== null) {
        param.setTargetAtTime(value, ctx.currentTime, BUS_RAMP_TC);
      } else {
        param.value = value;
      }
    }
  }

  /** Attach a live node and push the stored value through it. */
  attach(node: GainNodeLike, ctx: AudioContextLike): void {
    this.node = node;
    node.gain.setTargetAtTime(this._value, ctx.currentTime, BUS_RAMP_TC);
  }

  detach(): void {
    this.node = null;
  }
}

/**
 * The bus triplet. Works with or without a live context: the stored values
 * are authoritative and get pushed onto nodes the moment the graph is built.
 */
export interface BusSet {
  /** True once a live AudioContext owns the nodes. */
  readonly live: boolean;
  sfx(): number;
  music(): number;
  master(): number;
  /** M10-06 additive: the live sfx-bus GainNode source consumers connect to
   * (null until the graph is built). Optional — the offline harness BusSet
   * needs no source wiring. */
  sfxNode?(): GainNodeLike | null;
  /** M10-10-A additive: the music-bus GainNode (the Synth's musicIn);
   * null until the graph is built. Optional like sfxNode (offline
   * harness BusSets need no source wiring). */
  musicNode?(): GainNodeLike | null;
  setSfx(v: number): void;
  setMusic(v: number): void;
  /** Direct master control (gesture unmute / test mute); respects mute flags. */
  setMaster(v: number): void;
}

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

export type PlatformState = 'absent' | 'unbuilt' | 'suspended' | 'running';
export type EnqueueResult = 'ran' | 'queued' | 'dropped';

/** Max ops buffered while the context is not `running` (gesture pending). */
export const MAX_PENDING_QUEUE = 64;

let contextFactory: ContextFactory | null = null;
let offlineFactory: OfflineFactory | null = null;

const sfxBus = new Bus();
const musicBus = new Bus();
const masterBus = new Bus();
masterBus.set(0, null); // muted-by-default-until-gesture

let ctx: AudioContextLike | null = null;
let built = false; // graph built at least once this process
let gestureSeen = false;
let testMute = false;
let musicPaused = false;

const pending: (() => void)[] = [];
let droppedOps = 0;

const builtListeners: ((buses: BusSet) => void)[] = [];
let musicGainSource: (() => number) | null = null;

let listener = { x: 0, y: 0, z: 0 };

function defaultFactory(): ContextFactory | null {
  const g = globalThis as { AudioContext?: new () => AudioContextLike };
  return typeof g.AudioContext === 'function' ? () => new g.AudioContext!() : null;
}

function defaultOfflineFactory(): OfflineFactory | null {
  const g = globalThis as {
    OfflineAudioContext?: new (channels: number, frames: number, sampleRate: number) => AudioContextLike & {
      startRendering(): Promise<AudioBufferLike>;
    };
  };
  return typeof g.OfflineAudioContext === 'function'
    ? (channels, frames, sampleRate) => new g.OfflineAudioContext!(channels, frames, sampleRate)
    : null;
}

function activeFactory(): ContextFactory | null {
  return contextFactory !== null ? contextFactory : defaultFactory();
}

function buildGraph(context: AudioContextLike): void {
  ctx = context;
  const master = context.createGain();
  const sfx = context.createGain();
  const music = context.createGain();
  sfx.connect(master);
  music.connect(master);
  master.connect(context.destination);
  masterBus.attach(master, context);
  sfxBus.attach(sfx, context);
  musicBus.attach(music, context);
  builtListeners.slice().forEach((cb) => cb(busSet));
}

function onRunning(): void {
  const queue = pending.splice(0, pending.length);
  for (const op of queue) op();
}

function wireStateWatch(context: AudioContextLike): void {
  const cb = (): void => {
    if (context.state === 'running') onRunning();
  };
  context.onstatechange = cb;
  context.addEventListener?.('statechange', cb);
}

/* ------------------------------------------------------------------ */
/* Public: lifecycle / gesture gate                                    */
/* ------------------------------------------------------------------ */

/** Test seam: inject a context factory (null restores the global lookup). */
export function setContextFactory(factory: ContextFactory | null): void {
  contextFactory = factory;
}

/** Test seam: inject the offline factory (null restores the global lookup). */
export function setOfflineContextFactory(factory: OfflineFactory | null): void {
  offlineFactory = factory;
}

/** True when SOME AudioContext constructor exists (never constructs one). */
export function audioAvailable(): boolean {
  return activeFactory() !== null;
}

/** State machine census: absent | unbuilt | suspended | running. */
export function platformState(): PlatformState {
  if (ctx !== null) return ctx.state === 'running' ? 'running' : 'suspended';
  if (built) return 'suspended'; // graph existed; context closed/lost — treat as needing resume
  return audioAvailable() ? 'unbuilt' : 'absent';
}

/**
 * M10-06 additive: the live AudioContext (NOT a construction site — null
 * until the first gesture builds the graph; the driver reads it lazily and
 * degrades to the pure-mixer path when null, keeping the constructor spy
 * zero on every headless path). Source-node FACTORIES (createBufferSource
 * etc.) are the driver's structural extension of AudioContextLike.
 */
export function getContext(): AudioContextLike | null {
  return ctx;
}

/** The bus triplet (always present; live once a context owns the nodes). */
export const busSet: BusSet = {
  get live(): boolean {
    return ctx !== null && sfxBus.node !== null;
  },
  sfx: () => sfxBus.value,
  music: () => musicBus.value,
  master: () => masterBus.value,
  sfxNode: () => sfxBus.node,
  musicNode: () => musicBus.node,
  setSfx: (v) => sfxBus.set(v, ctx),
  setMusic: (v) => musicBus.set(musicPaused ? 0 : v, ctx),
  setMaster: (v) => masterBus.set(testMute ? 0 : v, ctx),
};

/**
 * Gesture entry point (pointer/key handlers, M10-09 wiring). First call
 * builds the graph (the ONLY construction site), unmutes master, and
 * attempts `resume()` — the autoplay unlock. Idempotent afterwards: still
 * attempts resume while suspended. Returns false only when the platform is
 * entirely absent (no-op safety; nothing was constructed).
 */
export function ensureContext(): boolean {
  const factory = activeFactory();
  if (factory === null) return false; // no-op object semantics: absent platform
  if (!built) {
    buildGraph(factory());
    wireStateWatch(ctx!);
    built = true;
  }
  gestureSeen = true;
  busSet.setMaster(testMute ? 0 : 1);
  attemptResume();
  return true;
}

/** Resume attempt (gesture unlock); rejection just leaves us suspended. */
export function attemptResume(): void {
  if (ctx === null) return;
  if (ctx.state === 'suspended') {
    void ctx.resume().then(
      () => {
        if (ctx !== null && ctx.state === 'running') onRunning();
      },
      () => undefined,
    );
  } else if (ctx.state === 'running') {
    onRunning();
  }
}

/**
 * Queue an op (node start etc.) unless the platform is `running`, in which
 * case it runs immediately. While unbuilt/suspended the op is queued FIFO;
 * past `MAX_PENDING_QUEUE` the new op is DROPPED (counted, never thrown).
 */
export function enqueue(op: () => void): EnqueueResult {
  if (ctx !== null && ctx.state === 'running' && !needsResumeGate()) {
    op();
    return 'ran';
  }
  if (pending.length >= MAX_PENDING_QUEUE) {
    droppedOps += 1;
    return 'dropped';
  }
  pending.push(op);
  return 'queued';
}

function needsResumeGate(): boolean {
  // Before the first gesture the master is muted; queuing keeps node-start
  // timestamps aligned with the eventual unlock.
  return !gestureSeen;
}

/** Ops dropped for queue overflow since boot (debug seam). */
export function droppedOpCount(): number {
  return droppedOps;
}

/** Pending-op census (tests/debug). */
export function pendingOpCount(): number {
  return pending.length;
}

/* ------------------------------------------------------------------ */
/* Public: mute / pause                                                */
/* ------------------------------------------------------------------ */

/**
 * Test mute (plan acceptance 4): short-circuits ALL node starts (consumers
 * check `testMuted()`) and pins master at 0 until unmuting. Non-audio e2e
 * boots with this set => silent contexts, zero-regression for old specs.
 */
export function setTestMute(mute: boolean): void {
  testMute = mute;
  busSet.setMaster(mute ? 0 : (gestureSeen ? 1 : 0));
}

export function testMuted(): boolean {
  return testMute;
}

/**
 * Pause the MUSIC bus only (vanilla mus_paused / S_PauseSound split,
 * g_game.c:705-712 + s_sound.c:497-513): already-scheduled sfx keep
 * playing; the context is NOT suspended. Music schedulers gate on
 * `isMusicPaused()` (the SCHEDULING pause reading, plan §D-10f).
 */
export function suspendForPause(): void {
  musicPaused = true;
  musicBus.set(0, ctx);
}

/** Resume the music bus to the volumes.ts value (idempotent). */
export function resumeFromPause(): void {
  musicPaused = false;
  musicBus.set(musicGainSource !== null ? musicGainSource() : musicBus.value, ctx);
}

export function isMusicPaused(): boolean {
  return musicPaused;
}

/* ------------------------------------------------------------------ */
/* Public: volume-module seams                                         */
/* ------------------------------------------------------------------ */

/** Run cb now (context already built) or on first build. Never fires twice. */
export function onContextBuilt(cb: (buses: BusSet) => void): void {
  if (built && ctx !== null) cb(busSet);
  else builtListeners.push(cb);
}

/** volumes.ts registers its music-gain law so pause-restore is exact. */
export function registerMusicGainSource(getGain: (() => number) | null): void {
  musicGainSource = getGain;
  if (musicGainSource !== null && !musicPaused) musicBus.set(musicGainSource(), ctx);
}

/* ------------------------------------------------------------------ */
/* Public: listener position (POSITION ONLY — D027, no panner nodes)   */
/* ------------------------------------------------------------------ */

export interface ListenerPosition {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Store the listener for the §0.3 spatial math (M10-05 reads it). NO Audio-
 *  Listener / panner plumbing — stereo comes from the mixer's L/R gains. */
export function setListenerPosition(x: number, y: number, z: number): void {
  listener = { x, y, z };
}

export function getListenerPosition(): ListenerPosition {
  return listener;
}

/* ------------------------------------------------------------------ */
/* Public: offline-mix harness primitive (L1 golden helper)            */
/* ------------------------------------------------------------------ */

export interface RenderedMix {
  readonly sampleRate: number;
  readonly channels: readonly Float32Array[];
}

/** Bit-equality over rendered buffers — the determinism assertion primitive. */
export function buffersBitEqual(a: RenderedMix, b: RenderedMix): boolean {
  if (a.sampleRate !== b.sampleRate || a.channels.length !== b.channels.length) return false;
  for (let c = 0; c < a.channels.length; c++) {
    const x = a.channels[c]!;
    const y = b.channels[c]!;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) {
      if (!Object.is(x[i], y[i])) return false;
    }
  }
  return true;
}

/**
 * Deterministic offline render: build the same bus graph inside an
 * OfflineAudioContext, let `wire(ctx, buses)` attach the source plan, render.
 * Absent platform => rejects with a typed error (callers skipIf, never crash).
 * D-10b: the committed goldens live in mixerCore's pure-TS `renderMix`; this
 * is the WebAudio-side harness for double-render bit-equality checks.
 */
export async function renderMixOffline(
  frames: number,
  sampleRate: number,
  wire: (context: AudioContextLike, buses: BusSet) => void,
): Promise<RenderedMix> {
  const factory = offlineFactory !== null ? offlineFactory : defaultOfflineFactory();
  if (factory === null) {
    throw new AudioUnavailableError('renderMixOffline: no OfflineAudioContext available');
  }
  const octx = factory(2, frames, sampleRate);
  const master = octx.createGain();
  const sfx = octx.createGain();
  const music = octx.createGain();
  sfx.connect(master);
  music.connect(master);
  master.connect(octx.destination);
  const localSfx = new Bus();
  const localMusic = new Bus();
  const localMaster = new Bus();
  localSfx.set(1, null);
  localMusic.set(1, null);
  localMaster.set(1, null);
  localSfx.attach(sfx, octx);
  localMusic.attach(music, octx);
  localMaster.attach(master, octx);
  const local: BusSet = {
    live: true,
    sfx: () => localSfx.value,
    music: () => localMusic.value,
    master: () => localMaster.value,
    setSfx: (v) => localSfx.set(v, octx),
    setMusic: (v) => localMusic.set(v, octx),
    setMaster: (v) => localMaster.set(v, octx),
  };
  wire(octx, local);
  const buffer = await octx.startRendering();
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
  return { sampleRate, channels };
}

/** Typed boundary error for absent-platform calls (plan: never raw throws). */
export class AudioUnavailableError extends Error {
  override readonly name = 'AudioUnavailableError';
}

/* ------------------------------------------------------------------ */
/* Test/reset seam                                                     */
/* ------------------------------------------------------------------ */

/** Full module reset (unit tests only — NOT a runtime API). */
export function __resetAudioContext(): void {
  contextFactory = null;
  offlineFactory = null;
  sfxBus.detach();
  musicBus.detach();
  masterBus.detach();
  sfxBus.set(1, null);
  musicBus.set(1, null);
  masterBus.set(0, null);
  ctx = null;
  built = false;
  gestureSeen = false;
  testMute = false;
  musicPaused = false;
  pending.length = 0;
  droppedOps = 0;
  builtListeners.length = 0;
  musicGainSource = null;
  listener = { x: 0, y: 0, z: 0 };
}
