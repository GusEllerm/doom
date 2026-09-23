// audio/sfxDriver.ts — the WebAudio SFX driver + main.ts integration
// (M10-06, plan §M10-06 / D-10b / D-10e / D-10f).
//
// WHAT THIS IS: the live mirror of mixerCore's DETERMINISTIC channel
// decisions onto WebAudio nodes. mixerCore.ts owns every decision (allocator,
// attenuation, panning, jitter, dedup, drops — the goldens certify it); this
// module never invents one. Per tic it: advances each channel's sample
// position (the mix-loop role renderMix plays offline — the completion test
// stays mixerCore's), drains the event ledger (hooks.registerLiveSfx events),
// runs S_UpdateSounds (the per-FRAME d_main.c:392 site, mapped to our tic
// grid per D-10f), then DIFFS the 8 mixer channels onto its voice slots.
//
// GRAPH (plan §M10-06, D027: NO StereoPannerNode anywhere):
//   BufferSource ─→ leftGain ─→ merger.in0
//                └─→ rightGain → merger.in1    merger ─→ chGain ─→ sfxBus
//   * L/R gains carry the addsfx QUADRATIC split (i_sound.c:350-373 — the
//     same addsfxSplit the goldens use, evaluated at vol 127 = pure pan law);
//   * chGain carries the linear `v/127` law (vol_lookup is linear in the mix
//     volume, i_sound.c:423 — D-10b's "linear v/127 ≡ vol_lookup" mirror);
//   * the sfxBus node is context.ts's (the ONLY volume owner — volumes.ts
//     pushes snd_SfxVolume/127 onto it, D-10d); no merger node available
//     (minimal mocks) ⇒ the two gains fold into chGain (mono, silent-safe).
//
// PITCH: playbackRate = (pcmRate/contextRate) * (pitch/128) (sfxdata's
// playbackRateFor — the steptable intent, plan §M10-02/§0.8); `pitch` is the
// mixer's channel pitch = NORM_PITCH 128 + D-10a splitmix jitter.
//
// CLOCK (D-10f): vanilla updates sounds per FRAME on a wall-clock device
// (d_main.c:392); our events are tic-stamped. The driver stamps
// ctx.currentTime at EVERY tic boundary into a ring of RING_SIZE (8) and
// schedules STARTS at that recorded boundary time (clamped ≥ now — a
// catch-up tic's events fire ASAP, like vanilla's sub-frame jitter). The
// anchor (first stamped boundary) + 1/35 s per tic is the FALLBACK for a tic
// whose ring entry aged out; staleness beyond the ring cannot silently
// schedule into the past because every `when` clamps to now.
//
// LOOP SOURCES (plan §0.4): the S_sfx `looping` column is NEVER read in
// 1.10 (grep-empty — the looped ambience rows are Doom-2-only and our WAD
// never triggers them), so every source is created with `loop = false` at
// the START site and retired at the STOP site (mixer channel freed ⇒ fade +
// stop + disconnect). The loop field stays available on the voice node for
// a future consumer without a lifecycle change.
//
// LIFECYCLE / FALLBACK:
//   * NO context at boot: installAudio registers the seams; the AudioContext
//     is created ONLY by context.ts's gesture gate (ensureContext). Node ops
//     run only while context.state === 'running' — until then events still
//     flow through the MIXER (pure path, census live, zero nodes), queued
//     into a bounded ledger (cap QUEUE_CAP, drop-oldest counted; age rule
//     QUEUE_MAX_AGE drops stale events on flush — NEVER play an aged
//     sound mid-buffer: voices whose start predates the unlock stay silent).
//   * no-audio environments (node/vitest, no WebAudio): getContext() stays
//     null forever ⇒ the pure-mixer path — decisions + census advance, zero
//     node ops, zero console output (existing e2e contract).
//   * missing DS lumps: mixer.stats.misses counts the drop (plan §0.10 —
//     counter, NEVER console).
//   * Level change (state.map identity swap = the P_SetupLevel port): the
//     S_Start channel-kill half (s_sound.c:207-211) — mixer.startLevel() +
//     fade-stop every voice, no pending carry-over. (The MUSIC half of
//     S_Start is M10-08's.)
//
// Zone rule (A-06): audio imports sim READ-VIEWS only (hooks seam, sfx ids);
// imports mixerCore/sfxdata/volumes/context by their public surfaces; owns
// sfxDriver.ts + the two main.ts wiring lines + the debug-seam attach.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { registerLiveSfx, setSfxEventClock, type LiveSfxOrigin } from '../sim/hooks';
import { SFX_ID } from '../sim/psound_stub';
import type { WadFile } from '../wad/wadfile';
import {
  busSet,
  ensureContext,
  getContext,
  platformState,
  testMuted,
  type AudioParamLike,
  type AudioContextLike
} from './context';
import { addsfxSplit, createMixer, NUM_MIXER_CHANNELS, type MixSfxData, type Mixer } from './mixerCore';
import { sfxDataById } from './sfxdata';
import { sfxIdForName } from './sfxinfo';
import { sfxVolumeInternal } from './volumes';

/* ------------------------------------------------------------------ */
/* Structural WebAudio extension (mock-friendly; D027: no panner types) */
/* ------------------------------------------------------------------ */

/** The buffer surface a source needs. */
export interface SfxBufferLike {
  readonly length: number;
  getChannelData(channel: number): Float32Array;
}

/** AudioBufferSourceNode surface (loop kept for the §0.4 lifecycle note). */
export interface SfxSourceNodeLike {
  buffer: SfxBufferLike | null;
  playbackRate: AudioParamLike;
  loop: boolean;
  onended: (() => void) | null;
  connect(dest: unknown, output?: number, input?: number): void;
  disconnect(): void;
  start(when: number): void;
  stop(when: number): void;
}

/** GainNode + disconnect (context.ts's GainNodeLike, extended). */
export interface SfxGainNodeLike {
  gain: AudioParamLike;
  connect(dest: unknown, output?: number, input?: number): void;
  disconnect(): void;
}

/** ChannelMergerNode (2 mono inputs → stereo); OPTIONAL — mocks without it
 * fold the L/R gains into chGain (mono fallback). */
export interface SfxMergerNodeLike {
  connect(dest: unknown, output?: number, input?: number): void;
  disconnect(): void;
}

/** The driver's view of the context: context.ts's AudioContextLike PLUS the
 * source factories (the node-vocabulary extension lives HERE, keeping
 * context.ts's gain-only invariant — D027 — untouched). */
export interface SfxContextLike extends AudioContextLike {
  createBufferSource?(): SfxSourceNodeLike;
  createBuffer?(channels: number, length: number, sampleRate: number): SfxBufferLike;
  createChannelMerger?(inputs: number): SfxMergerNodeLike;
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** D-10f ring of tic-boundary AudioContext timestamps. */
export const RING_SIZE = 8;

/** The sim tick rate (the scheduler grid, 1/35 s per tic). */
export const TIC_DT = 1 / 35;

/** Minimum scheduling lead (never start in the past). */
export const MIN_LEAD = 0.002;

/** Steal/stop fade time constant (plan acceptance 1: the 2 ms fade). */
export const FADE_TC = 0.002;

/** Stop margin past the fade target (fade settles ~3 τ). */
export const STOP_MARGIN = 0.02;

/** Per-tic parameter ramp constant (D-10e live updates, anti-zipper). */
export const PARAM_TC = 0.005;

/** Pending-event ledger cap (drop-oldest, counted — the unlock-flush rule
 * the plan shares with context.ts's MAX_PENDING_QUEUE). */
export const QUEUE_CAP = 256;

/** Age past which a queued event is dropped instead of flushed. */
export const QUEUE_MAX_AGE = 2; // seconds

/** Tic-age past which a channel observed while the context was NOT running
 * is never voiced after the unlock (no mid-buffer starts). Voice records are
 * written on every sync, so in practice the diff always catches the start
 * tic — this bounds the pathological catch-up case. */
export const VOICE_MAX_AGE_TICS = 2;

/* ------------------------------------------------------------------ */
/* Sim read-view (A-INT1: GameState satisfies it structurally)          */
/* ------------------------------------------------------------------ */

/** Origin pose read-view (mobj x/y/z fixed_t + BAM angle for the sep math). */
export interface SfxOriginView {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly angle?: number;
}

/** The slice of GameState the driver reads (players[0].mo == viewplayer's
 * mobj, the S_UpdateSounds listener, s_sound.c:519). */
export interface SfxSimView {
  readonly players: readonly { readonly mo: SfxOriginView }[];
  readonly map: unknown; // identity ONLY (the level-change detector)
  readonly gamemap: number;
  readonly leveltime: number;
  readonly gametic: number;
}

/* ------------------------------------------------------------------ */
/* Options + debug shape                                               */
/* ------------------------------------------------------------------ */

export interface SfxDriverOptions {
  /** The mounted WAD for DS decode via sfxdata (cache-owned). */
  readonly wad?: WadFile | null;
  /** Data-source seam (tests): id → decoded PCM, null = silent (§0.10).
   * Defaults to the WAD-backed sfxdata.sfxDataById. */
  readonly resolve?: (id: number) => MixSfxData | null;
  /** Wall-clock seam for the queue age rule (seconds; default performance /
   * Date.now — node/vitest safe). */
  readonly wallNow?: () => number;
}

/** The debug-seam shape (M10-09's debug.ts consumes/extends it; exported
 * here per the plan: "debug.ts state read — exposed by M10-09, M10-06
 * exports the shape"). Attached at `__doom.audio` by installAudio. */
export interface SfxDebugState {
  /** context.ts lifecycle census. */
  readonly context: 'absent' | 'unbuilt' | 'suspended' | 'running';
  /** The snd_SfxVolume internal int (volumes.ts, D-10d). */
  readonly volume: number;
  /** sfx bus gain (volumes.ts law). */
  readonly busGain: number;
  /** Voices with live, un-ended source nodes. */
  readonly activeVoices: number;
  /** Mixer channels currently occupied (the census M10-11 asserts). */
  readonly activeChannels: number;
  readonly sourcesCreated: number;
  readonly sourcesStarted: number;
  readonly sourcesStopped: number;
  readonly sourcesDisconnected: number;
  /** Missing-DS-lump counted drops (§0.10). */
  readonly missingLumps: number;
  /** "Sorry, Charlie" allocator drops (s_sound.c:856-860). */
  readonly allocatorDrops: number;
  /** Unknown sfx name resolutions (UI sinks; never a console error). */
  readonly unknownNames: number;
  /** Pending-event ledger census + its counted overflow/age drops. */
  readonly queuedEvents: number;
  readonly queueDrops: number;
  /** Listener pose the mixer spatializes against (fixed_t). */
  readonly listener: { readonly x: number; readonly y: number };
  /** |scheduledWhen − currentTime| of the last START (acceptance 5: < 1
   * audio block in the steady state; −1 before the first start). */
  readonly lastSchedDelta: number;
  /** Driver tic counter (boundary ring index). */
  readonly tic: number;
}

/* ------------------------------------------------------------------ */
/* Internal voice state                                                 */
/* ------------------------------------------------------------------ */

interface VoiceNodes {
  readonly src: SfxSourceNodeLike;
  readonly chGain: SfxGainNodeLike;
  readonly left: SfxGainNodeLike;
  readonly right: SfxGainNodeLike;
  readonly merger: SfxMergerNodeLike | null;
  disconnected: boolean;
}

interface Voice {
  sfxId: number;
  startTic: number;
  nodes: VoiceNodes | null;
  stopped: boolean;
  /** Last seen channel pos16 — a DECREASE means the mixer RESTARTED the
   * channel (dedup kill+reuse, same-origin steal at one tic: (sfxId,
   * startTic) alone cannot see it — pos16 reset to 0 can). */
  lastPos: number;
}

interface PendingEvent {
  readonly id: number;
  readonly origin: number | null;
  readonly x: number;
  readonly y: number;
  readonly wallAt: number;
}

/* ------------------------------------------------------------------ */
/* Origin identity (allocator `origin` numbers)                         */
/* ------------------------------------------------------------------ */

/** Object origins (mobj read-views) → stable positive ids; the player mobj
 * is mapped too, so `listener.self` compares equal for the player's own
 * S_StartSound(p.mo, …) sites (listener-local, s_sound.c:305). */
type OriginIds = WeakMap<object, number>;

/** Coordinate-only origins (the origin-NULL-but-positioned emits, e.g.
 * p_enemy.ts:618) hash to NEGATIVE ids: never equal an object id, equal for
 * repeated emits from one spot (the vanilla one-sound-per-mobj approximation). */
function coordOriginId(x: number, y: number): number {
  if (x === 0 && y === 0) return 0; // 0/0/0 = the NULL-origin listener form
  const h = (Math.imul(x | 0, 0x9e3779b1) ^ Math.imul(y | 0, 0x85ebca6b)) | 0;
  return -(((h >>> 1) | 1) >>> 0);
}

/* ------------------------------------------------------------------ */
/* The driver                                                           */
/* ------------------------------------------------------------------ */

export interface SfxDriver {
  /** Per-TIC entry (main.ts stepTic, after gTicker — the d_main.c:392
   * S_UpdateSounds mapping, D-10f): boundary stamp, pos16 advance, event
   * drain, updateSounds, node diff. */
  tick(state: SfxSimView): void;
  /** Per-FRAME entry (main.ts loop): flush late-arriving UI events at
   * now+lead with the age rule; census refresh. */
  frame(): void;
  /** The live-listener body (hooks.registerLiveSfx). Public for tests. */
  onSfxEvent(
    sfx: number | string,
    origin: LiveSfxOrigin | null,
    x: number,
    y: number,
    z: number,
    tic: number,
  ): void;
  debug(): SfxDebugState;
  /** Detach the seams (tests / reinstall). */
  dispose(): void;
}

/** S_sfx id for the live listener's numeric-or-name token; undefined = drop
 * (counted, never console — §0.10 policy). */
export function resolveSfxToken(sfx: number | string): number | undefined {
  if (typeof sfx === 'number') return sfx >= 1 && sfx < 109 ? sfx : undefined;
  return sfxIdForName(sfx);
}

/** The ±… law split of addsfxSplit evaluated at the law ceiling (vol 127):
 * the PURE pan gains the L/R pair carries (the volume half lives on chGain
 * as `v/127` — plan §M10-06 graph). AddsfxSplit throws only on a sep bug. */
function panGains(sep: number): { left: number; right: number } {
  const s = addsfxSplit(127, sep);
  return { left: s.left / 127, right: s.right / 127 };
}

class Driver implements SfxDriver {
  private readonly mixer: Mixer;
  private readonly opts: SfxDriverOptions;
  private readonly wallNow: () => number;
  private readonly voices: (Voice | null)[] = [];
  private readonly pending: PendingEvent[] = [];
  private readonly originIds: OriginIds = new WeakMap();
  private readonly buffers = new Map<number, SfxBufferLike | null>();
  private nextOriginId = 1;
  private queueDrops = 0;
  private unknownNames = 0;
  private sourcesCreated = 0;
  private sourcesStarted = 0;
  private sourcesStopped = 0;
  private sourcesDisconnected = 0;
  private lastSchedDelta = -1;
  private ticIndex = 0;
  private readonly ring = new Float64Array(RING_SIZE);
  private readonly ringTic = new Int32Array(RING_SIZE).fill(-1);
  private anchor: { tic: number; t: number } | null = null;
  private lastMap: unknown = null;
  private state: SfxSimView | null = null;
  private disposed = false;

  constructor(opts: SfxDriverOptions) {
    this.opts = opts;
    this.wallNow = opts.wallNow ?? defaultWallNow;
    this.mixer = createMixer({
      buffers: (id: number): MixSfxData | null => this.decoded(id),
      sfxVolume: sfxVolumeInternal(),
    });
    for (let i = 0; i < NUM_MIXER_CHANNELS; i++) this.voices.push(null);
    registerLiveSfx(this.onSfxEvent);
  }

  /* ---------------- data ---------------- */

  private decoded(id: number): MixSfxData | null {
    const resolve = this.opts.resolve;
    if (resolve !== undefined) return resolve(id);
    const wad = this.opts.wad;
    if (wad === null || wad === undefined) return null;
    return sfxDataById(wad, id);
  }

  /** AudioBuffer per source id, created on first PLAY (vanilla pre-caches
   * at boot, i_sound.c:796-811; on-demand is byte-equivalent data, just
   * lazier — the sfxdata decode itself stays boot-cacheable). */
  private bufferFor(ctx: SfxContextLike, id: number): SfxBufferLike | null {
    const hit = this.buffers.get(id);
    if (hit !== undefined) return hit;
    const data = this.decoded(id);
    let buf: SfxBufferLike | null = null;
    if (data !== null && typeof ctx.createBuffer === 'function') {
      buf = ctx.createBuffer(1, Math.max(1, data.samples.length), Math.max(1, data.rate));
      buf.getChannelData(0).set(data.samples);
    }
    this.buffers.set(id, buf);
    return buf;
  }

  /* ---------------- origin identity ---------------- */

  private originIdOf(o: object): number {
    let id = this.originIds.get(o);
    if (id === undefined) {
      id = this.nextOriginId++;
      this.originIds.set(o, id);
    }
    return id;
  }

  /* ---------------- the live listener ---------------- */

  onSfxEvent = (
    sfx: number | string,
    origin: LiveSfxOrigin | null,
    x: number,
    y: number,
  ): void => {
    // z is informational (no z term in the distance math, s_sound.c:767-771)
    // and the tic is the ledger's — the driver stamps its own boundaries.
    if (this.disposed) return;
    const id = resolveSfxToken(sfx);
    if (id === undefined) {
      this.unknownNames++;
      return;
    }
    if (id === SFX_ID.sfx_None) return;
    let originId: number | null;
    if (origin !== null && origin !== undefined) {
      originId = this.originIdOf(origin);
    } else {
      const cid = coordOriginId(x, y);
      originId = cid === 0 ? null : cid; // NULL origin = listener position
    }
    if (this.pending.length >= QUEUE_CAP) {
      this.pending.shift();
      this.queueDrops++;
    }
    this.pending.push({ id, origin: originId, x, y, wallAt: this.wallNow() });
  };

  /* ---------------- per-tic ---------------- */

  tick(state: SfxSimView): void {
    if (this.disposed) return;
    this.state = state;
    const ctx = (getContext() as SfxContextLike | null) ?? null;
    const running = ctx !== null && ctx.state === 'running' && !testMuted();

    // Level-change detector (the S_Start channel-kill half, s_sound.c:
    // 207-211; the P_SetupLevel port swaps state.map identity — same
    // detector main.ts' ST_Start half uses).
    if (this.lastMap !== null && state.map !== this.lastMap) this.startLevel();
    this.lastMap = state.map;

    this.mixer.setVolume(sfxVolumeInternal());
    this.mixer.setGamemap(state.gamemap);

    const mo = state.players[0]!.mo;
    const pose = {
      x: mo.x,
      y: mo.y,
      angle: mo.angle ?? 0,
      self: this.originIdOf(mo as unknown as object),
    };

    // D-10f boundary stamp + ring (the tic→time mapping's fresh end).
    this.ticIndex += 1;
    const now = ctx !== null ? ctx.currentTime : 0;
    if (running) {
      this.ring[this.ticIndex & (RING_SIZE - 1)] = now;
      this.ringTic[this.ticIndex & (RING_SIZE - 1)] = this.ticIndex;
      if (this.anchor === null) this.anchor = { tic: this.ticIndex, t: now };
    }

    // The mix-loop role on the live path: advance every occupied channel's
    // 0.16 position by one tic at its playback rate
    // (source-samples/tic = rate · (pitch/128) / 35) — the completion test
    // (pos16 ≥ length) stays mixerCore's updateSounds rule.
    for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
      const c = this.mixer.channels[i]!;
      if (c.sfxId && c.data !== null) {
        c.pos16 += Math.trunc((c.data.rate * 65536 * c.pitch) / (128 * 35));
      }
    }

    // Drain the pending ledger. running/headless consume at this tic's
    // boundary; a PRESENT-but-suspended context keeps the queue to the age
    // + cap rules only (the unlock flush lands it in frame()/tick).
    const spliced = this.pending.splice(0, this.pending.length);
    let toConsume = spliced;
    if (ctx !== null && !running) {
      const wall = this.wallNow();
      const keep = spliced.filter((e) => wall - e.wallAt <= QUEUE_MAX_AGE);
      this.queueDrops += spliced.length - keep.length;
      for (const e of keep) this.pending.push(e);
      toConsume = [];
    } else if (spliced.length > QUEUE_CAP) {
      toConsume = spliced.slice(spliced.length - QUEUE_CAP); // drop-oldest
      this.queueDrops += spliced.length - toConsume.length;
    }
    const when = running ? this.boundaryTime(this.ticIndex, now) : now;
    for (const e of toConsume) {
      this.mixer.start(e.id, e.origin, e.x, e.y, state.leveltime);
    }
    this.mixer.updateSounds(state.leveltime, pose);
    this.sync(running, when);
  }

  /* ---------------- per-frame ---------------- */

  frame(): void {
    if (this.disposed) return;
    const ctx = (getContext() as SfxContextLike | null) ?? null;
    const running = ctx !== null && ctx.state === 'running' && !testMuted();
    if (this.pending.length === 0) return;
    const wall = this.wallNow();
    while (this.pending.length > 0 && wall - this.pending[0]!.wallAt > QUEUE_MAX_AGE) {
      this.pending.shift();
      this.queueDrops++;
    }
    if (!running) {
      // Unlock-flush interplay happens in tick/frame: while not running the
      // ledger only ages (cap + age rules above).
      return;
    }
    const now = ctx!.currentTime;
    const events = this.pending.splice(0, this.pending.length);
    for (const e of events) {
      this.mixer.start(e.id, e.origin, e.x, e.y, this.state?.leveltime ?? 0);
    }
    this.sync(running, now + MIN_LEAD);
  }

  /* ---------------- level change ---------------- */

  /** S_Start's sfx-channel kill (s_sound.c:207-211). */
  startLevel(): void {
    this.mixer.startLevel();
    this.pending.length = 0;
    const ctx = (getContext() as SfxContextLike | null) ?? null;
    const when = ctx !== null ? ctx.currentTime : 0;
    for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
      const v = this.voices[i] ?? null;
      if (v !== null) {
        this.stopVoice(v, when);
        this.voices[i] = null;
      }
    }
  }

  /* ---------------- scheduling clock (D-10f) ---------------- */

  /** audioTime(tic): the ring-stamped boundary for a CURRENT tic (the
   * steady-state path — |audioTime − now| < 1 block), else the
   * anchor + tic·(1/35) extrapolation, clamped ≥ now + MIN_LEAD by the
   * caller's use (never schedule into the past). */
  private boundaryTime(ticIndex: number, now: number): number {
    const slot = ticIndex & (RING_SIZE - 1);
    if (this.ringTic[slot] === ticIndex) {
      return Math.max(this.ring[slot] as number, now) + MIN_LEAD;
    }
    if (this.anchor !== null) {
      return Math.max(this.anchor.t + (ticIndex - this.anchor.tic) * TIC_DT, now) + MIN_LEAD;
    }
    return now + MIN_LEAD;
  }

  /* ---------------- node diff ---------------- */

  private sync(running: boolean, when: number): void {
    const ctx = running ? (getContext() as SfxContextLike | null) : null;
    for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
      const c = this.mixer.channels[i]!;
      const v = this.voices[i] ?? null;
      if (!c.sfxId) {
        if (v !== null) {
          this.stopVoice(v, when);
          this.voices[i] = null;
        }
        continue;
      }
      if (v === null || v.sfxId !== c.sfxId || v.startTic !== c.startTic || c.pos16 < v.lastPos) {
        // START / STEAL (plan acceptance 1: the old voice fades 2 ms, the
        // new source starts at the SAME `when`).
        if (v !== null) this.stopVoice(v, when);
        const voice: Voice = {
          sfxId: c.sfxId,
          startTic: c.startTic,
          nodes: null,
          stopped: false,
          lastPos: c.pos16,
        };
        if (ctx !== null && typeof ctx.createBufferSource === 'function') {
          voice.nodes = this.buildVoice(ctx, c, when);
        }
        this.voices[i] = voice;
        continue;
      }
      if (v.nodes !== null) this.applyParams(v.nodes, c, when);
      v.lastPos = c.pos16;
    }
  }

  private buildVoice(
    ctx: SfxContextLike,
    c: { sfxId: number; data: MixSfxData | null; pitch: number; vol: number; sep: number },
    when: number,
  ): VoiceNodes | null {
    const dataId = c.sfxId;
    const buf = this.bufferFor(ctx, dataId);
    if (buf === null) return null;
    const bus = busSet.sfxNode?.() ?? null;
    const src = ctx.createBufferSource!();
    const chGain = ctx.createGain() as unknown as SfxGainNodeLike;
    const left = ctx.createGain() as unknown as SfxGainNodeLike;
    const right = ctx.createGain() as unknown as SfxGainNodeLike;
    const merger =
      typeof ctx.createChannelMerger === 'function' ? ctx.createChannelMerger(2) : null;
    src.buffer = buf;
    src.loop = false; // plan §0.4: the looping column is never read in 1.10
    // sfxdata's playbackRateFor law, applied to the mixer's MixSfxData view:
    // (pcmRate/contextRate) × (pitch/128) — the steptable intent (§0.8).
    src.playbackRate.value = c.data !== null
      ? (c.data.rate / ctx.sampleRate) * (c.pitch / 128)
      : 1;
    const nodes: VoiceNodes = { src, chGain, left, right, merger, disconnected: false };
    src.connect(left);
    src.connect(right);
    if (merger !== null) {
      left.connect(merger, 0, 0);
      right.connect(merger, 0, 1);
      merger.connect(chGain);
    } else {
      left.connect(chGain);
      right.connect(chGain);
    }
    chGain.connect((bus as unknown as object) ?? (ctx.destination as object));
    this.applyParams(nodes, c, when, true);
    this.sourcesCreated++;
    src.start(when);
    this.sourcesStarted++;
    this.lastSchedDelta = Math.abs(when - ctx.currentTime);
    src.onended = (): void => {
      if (nodes.disconnected) return;
      nodes.disconnected = true;
      src.disconnect();
      left.disconnect();
      right.disconnect();
      merger?.disconnect();
      chGain.disconnect();
      this.sourcesDisconnected++;
    };
    return nodes;
  }

  private applyParams(
    nodes: VoiceNodes,
    c: { vol: number; sep: number },
    when: number,
    atStart = false,
  ): void {
    const pan = panGains(c.sep);
    const chv = c.vol / 127;
    if (atStart) {
      nodes.chGain.gain.value = chv;
      nodes.left.gain.value = pan.left;
      nodes.right.gain.value = pan.right;
    } else {
      nodes.chGain.gain.setTargetAtTime(chv, when, PARAM_TC);
      nodes.left.gain.setTargetAtTime(pan.left, when, PARAM_TC);
      nodes.right.gain.setTargetAtTime(pan.right, when, PARAM_TC);
    }
  }

  private stopVoice(v: Voice, when: number): void {
    if (v.stopped) return;
    v.stopped = true;
    this.sourcesStopped++;
    const n = v.nodes;
    if (n === null || n.disconnected) return;
    n.chGain.gain.setTargetAtTime(0, when, FADE_TC); // the 2 ms anti-click fade
    n.src.stop(when + STOP_MARGIN);
  }

  /* ---------------- debug ---------------- */

  debug(): SfxDebugState {
    let active = 0;
    let channels = 0;
    for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
      const v = this.voices[i] ?? null;
      const c = this.mixer.channels[i]!;
      if (c.sfxId) channels++;
      if (v !== null && v.nodes !== null && !v.stopped && !v.nodes.disconnected) active++;
    }
    const listener = { x: 0, y: 0 };
    // The mixer keeps its pose private; mirror the last tick's player mo.
    const mo = this.state?.players[0]?.mo;
    if (mo !== undefined) {
      listener.x = mo.x;
      listener.y = mo.y;
    }
    return {
      context: platformState(),
      volume: sfxVolumeInternal(),
      busGain: busSet.sfx(),
      activeVoices: active,
      activeChannels: channels,
      sourcesCreated: this.sourcesCreated,
      sourcesStarted: this.sourcesStarted,
      sourcesStopped: this.sourcesStopped,
      sourcesDisconnected: this.sourcesDisconnected,
      missingLumps: this.mixer.stats.misses,
      allocatorDrops: this.mixer.stats.drops,
      unknownNames: this.unknownNames,
      queuedEvents: this.pending.length,
      queueDrops: this.queueDrops,
      listener,
      lastSchedDelta: this.lastSchedDelta,
      tic: this.ticIndex,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    registerLiveSfx(null);
    this.pending.length = 0;
  }
}

function defaultWallNow(): number {
  const p = (globalThis as { performance?: { now(): number } }).performance;
  return (p !== undefined ? p.now() : Date.now()) / 1000;
}

/* ------------------------------------------------------------------ */
/* Factory + main.ts integration                                       */
/* ------------------------------------------------------------------ */

export function createSfxDriver(options: SfxDriverOptions = {}): SfxDriver {
  return new Driver(options);
}

/* The module singleton the main.ts wiring drives (installAudio replaces —
 * the file-picker re-boot path calls afterLoad twice). */
let current: Driver | null = null;
let gestureWired = false;

/**
 * The SINGLE main.ts edit point (plan §M10-06): registers the live-sfx
 * seam + the UI sfx clock + the autoplay gesture gate, and attaches the
 * debug shape at `__doom.audio` (additive runtime property — M10-09's
 * debug.ts task owns the file, this module owns the shape). Idempotent on
 * re-boot (replaces the previous driver).
 */
export function installAudio(state: SfxSimView, wad: WadFile | null = null): SfxDriver {
  if (current !== null) current.dispose();
  const driver = new Driver({ wad });
  current = driver as Driver;
  setSfxEventClock(() => state.gametic);
  if (!gestureWired && typeof window !== 'undefined') {
    gestureWired = true;
    const unlock = (): void => {
      ensureContext();
    };
    window.addEventListener('keydown', unlock);
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('mousedown', unlock);
  }
  const win = (globalThis as { window?: { __doom?: Record<string, unknown> } }).window;
  const seam = win?.['__doom'];
  if (seam !== undefined && seam !== null) {
    seam['audio'] = Object.assign(
      (): SfxDebugState => (current !== null ? current.debug() : emptyDebug()),
      { unlock: (): boolean => ensureContext() },
    );
  }
  return driver;
}

function emptyDebug(): SfxDebugState {
  return {
    context: platformState(),
    volume: sfxVolumeInternal(),
    busGain: busSet.sfx(),
    activeVoices: 0,
    activeChannels: 0,
    sourcesCreated: 0,
    sourcesStarted: 0,
    sourcesStopped: 0,
    sourcesDisconnected: 0,
    missingLumps: 0,
    allocatorDrops: 0,
    unknownNames: 0,
    queuedEvents: 0,
    queueDrops: 0,
    listener: { x: 0, y: 0 },
    lastSchedDelta: -1,
    tic: 0,
  };
}

/** Per-tic wiring line in main.ts stepTic (no-op before installAudio). */
export function audioTick(state: SfxSimView): void {
  current?.tick(state);
}

/** Per-frame wiring line in main.ts loop (no-op before installAudio). */
export function audioFrame(): void {
  current?.frame();
}

/** Test seam: full module reset (unit tests only). */
export function __resetSfxDriver(): void {
  current?.dispose();
  current = null;
  gestureWired = false;
}
