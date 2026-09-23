/**
 * M10-10 — shared harness for the audio golden corpus + integration smoke
 * (M10-plan §M10-10). Mirrors the m9Scenarios dump-or-assert convention:
 *
 *   GOLDENS_MODE=update + GOLDENS_DUMP_DIR → dump bin/json (the
 *       goldens-update.mjs `--set audio` pipeline blesses them)
 *   GOLDENS_MODE=check or unset            → assert sha vs meta.json
 *
 * The audio set's ARTIFACT is the little-endian Int16 interleaved mix bytes
 * (`<name>.bin`) instead of a blessed PNG (scripts/goldens-update.mjs
 * audio-set branch); big scenes (the E1M1 firefight) bless the sha ONLY
 * (`artifact: 'none'`), exactly the plan's "2000-tic event stream →
 * renderMix → Int16 hash" wording. Every render is DOUBLE-RUN and asserted
 * byte-equal before it is dumped or checked (the determinism half of the
 * golden).
 *
 * Also lives here: the E1M1 scripted-firefight ledger recorder (real sim →
 * live-sfx ledger + listener track), the tic-aligned `renderScript` engine
 * (renderMix + stop events — the golden engine for loop start/stop, built
 * ONLY from public mixerCore API), the canonical music-plan dumper, and the
 * mock-AudioContext driver-spy rig mirrored from src/audio/sfxDriver.test.ts
 * (integration smoke: ledger → offline mix == live driver census).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import {
  addsfxSplit,
  createMixer,
  mixHash,
  renderStep16,
  toFloat32,
  volLaw,
  type MixSfxData,
} from '../../src/audio/mixerCore';
import { TPS } from '../../src/audio/mixerCore';
import { planMusic, renderPlanOffline, type MusicPlan } from '../../src/audio/smfPlayer';
import { decodeSmf, rationalToNumber, smfCanonical, type Smf } from '../../src/audio/smf';
import { mixChecksum } from '../../src/audio/synth';
import {
  setContextFactory,
  ensureContext,
  __resetAudioContext,
  type AudioContextLike,
} from '../../src/audio/context';
import { bindVolumes } from '../../src/audio/volumes';
import {
  __resetSfxDriver,
  createSfxDriver,
  type SfxBufferLike,
  type SfxDriver,
  type SfxMergerNodeLike,
  type SfxSourceNodeLike,
} from '../../src/audio/sfxDriver';
import { sfxDataById } from '../../src/audio/sfxdata';
import { SFX_INFO } from '../../src/audio/sfxinfo';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData, type RuntimeMap } from '../../src/sim/map';
import { gInitGame, gTicker } from '../../src/sim/game';
import { hashState, type GameState } from '../../src/sim/state';
import {
  registerLiveSfx,
  resetHookSlots,
  type LiveSfxOrigin,
} from '../../src/sim/hooks';
import {
  installPickupSfxBridge,
  installPsprSfxSlot,
} from '../../src/sim/psound_stub';
import { AM_CLIP, WP_PISTOL } from '../../src/sim/p_pspr';
import { emptyInput, type GameInput } from '../../src/sim/ticcmd';

/* ------------------------------------------------------------------ */
/* wad discovery (walls/automap/m9Scenarios candidates, first hit)     */
/* ------------------------------------------------------------------ */

function findWad(): string | undefined {
  const candidates = [
    process.env['DOOM_WAD'],
    process.env['FREEDOOM1_WAD'],
    fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url)),
  ];
  return candidates.find((p): p is string => p !== undefined && existsSync(p));
}

export const WAD_PATH = findWad();
export const hasWad = WAD_PATH !== undefined;

let wadSingleton: WadFile | null = null;
export function iwad(): WadFile {
  if (wadSingleton === null) {
    if (WAD_PATH === undefined) throw new Error('no IWAD discovered');
    const bytes = readFileSync(WAD_PATH);
    wadSingleton = WadFile.parse(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  }
  return wadSingleton;
}

export function iwadSha256(): string {
  if (WAD_PATH === undefined) throw new Error('no IWAD discovered');
  return sha256Of(readFileSync(WAD_PATH));
}

/* ------------------------------------------------------------------ */
/* goldens plumbing (mirrors m9Scenarios.goldenScene for the audio set) */
/* ------------------------------------------------------------------ */

export const META_PATH = fileURLToPath(
  new URL('../audio/goldens/meta.json', import.meta.url),
);
export const DUMP_DIR = process.env['GOLDENS_DUMP_DIR'] ?? null;
export const MODE = process.env['GOLDENS_MODE'] ?? '';

export function sha256Of(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex');
}

/** Little-endian Int16 bytes of an interleaved stereo mix (the artifact). */
export function mixToBytes(mix: Int16Array): Buffer {
  return Buffer.from(mix.buffer.slice(0, mix.byteLength));
}

export function peakAbs(mix: Int16Array): { min: number; max: number } {
  let min = 0;
  let max = 0;
  for (let i = 0; i < mix.length; i++) {
    if (mix[i]! < min) min = mix[i]!;
    if (mix[i]! > max) max = mix[i]!;
  }
  return { min, max };
}

export interface AudioGoldenOpts {
  /** Scene name (unique in the set). */
  name: string;
  /** 'fixture' = wad-free, 'iwad' = wad-gated (meta records the wad sha). */
  kind: 'fixture' | 'iwad';
  /** Human-parsable pipeline description committed into meta.json. */
  script: string;
  /** THE render — called TWICE (double-run byte-equality first). */
  render: () => Int16Array;
  /** Sample rate recorded in meta. */
  sampleRate: number;
  /** 'bin' (default) commits `<name>.bin`; 'none' commits the sha only
   * (big streams — the plan's Int16-hash wording). */
  artifact?: 'bin' | 'none';
}

/**
 * One audio golden: double-run byte-equality ALWAYS; then dump (update
 * mode) or sha-assert vs meta.json (check/naked mode). The Float32 view
 * (toFloat32) shares the same sha domain — the Int16 bytes ARE the golden.
 */
export function audioGolden(opts: AudioGoldenOpts): void {
  it(opts.name, () => runAudioGolden(opts));
}

function runAudioGolden(opts: AudioGoldenOpts): void {
  const mixA = opts.render();
  const mixB = opts.render();
  const a = mixToBytes(mixA);
  const b = mixToBytes(mixB);
  expect(b.equals(a), `${opts.name}: double-run byte equality`).toBe(true);

  const sha = sha256Of(a);
  const record = {
    kind: opts.kind,
    script: opts.script,
    format: 's16le-interleaved-stereo',
    sampleRate: opts.sampleRate,
    frames: mixA.length / 2,
    mixHash: mixHash(mixA),
    float32Len: toFloat32(mixA).length,
    bin: opts.artifact === 'none' ? null : `${opts.name}.bin`,
    ...(opts.kind === 'iwad' ? { wadSha256: iwadSha256() } : {}),
  };

  if (DUMP_DIR !== null) {
    // update AND check modes both dump (check mode compares the dumps
    // against the committed goldens in scripts/goldens-update.mjs)
    writeFileSync(
      `${DUMP_DIR}/${opts.name}.json`,
      JSON.stringify({ name: opts.name, indexSha256: sha, ...record }),
    );
    if (opts.artifact !== 'none') writeFileSync(`${DUMP_DIR}/${opts.name}.bin`, a);
  }
  if (MODE === 'update') return;
  if (!existsSync(META_PATH)) {
    throw new Error(
      `audio goldens not blessed (no ${META_PATH}); run: node scripts/goldens-update.mjs --set audio --reason "..."`,
    );
  }
  const meta = JSON.parse(readFileSync(META_PATH, 'utf8')) as {
    scenes: Record<string, { indexSha256: string; kind?: string; wad?: { sha256: string } }>;
  };
  const entry = meta.scenes[opts.name];
  if (entry === undefined) {
    if (opts.kind === 'iwad' && !hasWad) return; // goldens-update skip-log covers it
    throw new Error(`audio golden '${opts.name}' missing from meta.json`);
  }
  expect(entry.indexSha256, `${opts.name}: sha vs blessed meta.json`).toBe(sha);
}

/* ------------------------------------------------------------------ */
/* synthetic exact-binary buffers (mixerCore.test.ts idiom: no Math.sin) */
/* ------------------------------------------------------------------ */

export function mkBuf(
  kind: 'sq' | 'tri',
  rate: number,
  len: number,
  amp: number,
  period: number,
): MixSfxData {
  const samples = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    let w: number;
    if (kind === 'sq') {
      w = i % period < period / 2 ? 1 : -1;
    } else {
      const t = (i % period) / period;
      w = t < 0.25 ? 4 * t : t < 0.75 ? 2 - 4 * t : 4 * t - 4;
      w = Math.round(amp * w) / amp;
    }
    samples[i] = Math.round(amp * w) / 128;
  }
  return { rate, samples };
}

/* ------------------------------------------------------------------ */
/* renderScript — the renderMix mirror + STOP events (loop start/stop)  */
/*                                                                     */
/* Same tic grid, same int law, same per-tic start/update order as      */
/* mixerCore.renderMix; the ONE addition is `stops` — S_StopSound(origin) */
/* keys applied at the SAME point in the tic block (before the starts,   */
/* the S_StartSound order vanilla reaches through S_StopSound at :349 —  */
/* for an EXPLICIT stop key the tic block does stop → starts → update).  */
/* Built ONLY from public mixerCore API (createMixer/addsfxSplit/        */
/* renderStep16/volLaw), so it can never drift from the law silently:    */
/* the equality test asserts it reproduces renderMix byte-for-byte on a  */
/* stop-free scene.                                                      */
/* ------------------------------------------------------------------ */

export interface ScriptStop {
  readonly tic: number;
  readonly origin: number | null;
}

export interface Script extends Omit<import('../../src/audio/mixerCore').MixScript, 'frames'> {
  readonly stops?: readonly ScriptStop[];
  readonly frames?: number;
}

export function renderScript(script: Script, sampleRate: number): Int16Array {
  const src: (id: number) => MixSfxData | null =
    typeof script.buffers === 'function'
      ? script.buffers
      : (id: number) => (script.buffers as ReadonlyMap<number, MixSfxData>).get(id) ?? null;
  const resolve = (id: number): MixSfxData | null => {
    const info = SFX_INFO[id];
    return src(info !== undefined && info.link !== null ? info.link : id);
  };

  let frames = script.frames;
  if (frames === undefined) {
    frames = sampleRate;
    for (const e of script.events) {
      const d = resolve(e.id);
      if (d === null || d.rate <= 0) continue;
      const end = Math.ceil((e.tic / TPS) * sampleRate + (d.samples.length / d.rate) * sampleRate);
      if (end + sampleRate > frames) frames = end + sampleRate;
    }
    frames = Math.max(frames | 0, sampleRate);
  }

  const mixer = createMixer({
    buffers: resolve,
    sfxVolume: script.sfxVolume ?? 8 * 8,
    gamemap: script.gamemap ?? 1,
  });
  const out = new Int16Array(frames * 2);

  type Item = { tic: number; seq: number; kind: 'start' | 'stop'; ev: { id?: number; origin?: number | null; x?: number; y?: number; volume?: number } };
  const items: Item[] = [];
  script.events.forEach((e, i) => items.push({ tic: e.tic, seq: i, kind: 'start', ev: e }));
  for (const [i, s] of (script.stops ?? []).entries())
    items.push({ tic: s.tic, seq: script.events.length + i, kind: 'stop', ev: { origin: s.origin } });
  items.sort((a, b) => a.tic - b.tic || a.seq - b.seq);

  const keys = [...(script.listener ?? [])].sort((a, b) => a.tic - b.tic);

  let pi = 0;
  let ki = 0;
  let lastTic = -1;
  const lv = new Int32Array(8);
  const rv = new Int32Array(8);
  const st = new Int32Array(8);

  for (let f = 0; f < frames; f++) {
    const tic = Math.floor((f * TPS) / sampleRate);
    if (tic !== lastTic) {
      lastTic = tic;
      while (ki < keys.length && keys[ki]!.tic <= tic) {
        mixer.setListener(keys[ki]!);
        ki++;
      }
      while (pi < items.length && items[pi]!.tic <= tic) {
        const it = items[pi]!;
        if (it.kind === 'stop') mixer.stopSound(it.ev.origin ?? null);
        else mixer.start(it.ev.id!, it.ev.origin ?? null, it.ev.x ?? 0, it.ev.y ?? 0, tic, it.ev.volume);
        pi++;
      }
      mixer.updateSounds(tic);
      for (let i = 0; i < 8; i++) {
        const c = mixer.channels[i]!;
        if (c.sfxId && c.data !== null) {
          const { left, right } = addsfxSplit(c.vol, c.sep);
          lv[i] = left;
          rv[i] = right;
          st[i] = renderStep16(c.pitch, c.data.rate, sampleRate);
        }
      }
    }

    let dl = 0;
    let dr = 0;
    for (let i = 0; i < 8; i++) {
      const c = mixer.channels[i]!;
      if (!c.sfxId || c.data === null) continue;
      const sm = c.data.samples;
      const s0 = c.pos16 >>> 16;
      if (s0 >= sm.length) {
        c.sfxId = 0;
        c.priority = 0;
        c.origin = null;
        c.data = null;
        c.vol = 0;
        continue;
      }
      const frac = c.pos16 & 0xffff;
      const i0 = Math.round(sm[s0]! * 128);
      const i1 = s0 + 1 < sm.length ? Math.round(sm[s0 + 1]! * 128) : i0;
      const s = i0 + (((i1 - i0) * frac) >> 16);
      dl += volLaw(lv[i]!, s);
      dr += volLaw(rv[i]!, s);
      c.pos16 += st[i]!;
      if ((c.pos16 >>> 16) >= sm.length) {
        c.sfxId = 0;
        c.priority = 0;
        c.origin = null;
        c.data = null;
        c.vol = 0;
      }
    }
    out[f * 2] = dl > 0x7fff ? 0x7fff : dl < -0x8000 ? -0x8000 : dl;
    out[f * 2 + 1] = dr > 0x7fff ? 0x7fff : dr < -0x8000 ? -0x8000 : dr;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* music goldens: canonical plan + checksummed offline render          */
/* ------------------------------------------------------------------ */

/** Deterministic, EXACT dump of a MusicPlan (rational n/d strings, baked
 * gains fixed(6), total order = plan order). */
export function planCanonical(plan: MusicPlan): string {
  const r = (x: { n: bigint; d: bigint }): string => `${x.n}/${x.d}`;
  const lines = [
    `end=${r(plan.endT)} notes=${plan.notes.length}`,
    ...plan.notes.map(
      (n) =>
        `n ${n.seq} v${n.voice} ch${n.channel} note${n.note} vel${n.velocity} t=${r(n.t)} rel=${r(n.releaseT)} ` +
        `${n.kind}:${n.family}${n.kind === 'drum' ? ':' + n.drum : ''} p${n.program} ` +
        `gl=${n.gainLeft.toFixed(6)} gr=${n.gainRight.toFixed(6)}${n.stolen ? ' STOLEN' : ''}`,
    ),
    ...plan.channelEvents.map(
      (c) => `c ${c.seq} ch${c.channel} ${c.kind} t=${r(c.t)} a=${c.controller ?? c.program ?? 0} v=${c.value ?? 0}`,
    ),
  ];
  return lines.join('\n');
}

export interface MusicGoldenOpts {
  name: string;
  kind: 'fixture' | 'iwad';
  script: string;
  /** Raw SMF bytes (decode is part of the certified path). */
  smf: () => Uint8Array;
  sampleRate: number;
  seconds: number;
  loops?: number;
}

/** Decode → canonical(plan) sha + offline-render checksum, ALL double-run
 * asserted byte-equal, then dump-or-assert. */
export function musicGolden(opts: MusicGoldenOpts): void {
  it(opts.name, () => runMusicGolden(opts));
}

function runMusicGolden(opts: MusicGoldenOpts): void {
  const work = (): string => {
    const smf: Smf = decodeSmf(opts.smf());
    const plan = planMusic(smf);
    const render = renderPlanOffline(plan, {
      sampleRate: opts.sampleRate,
      seconds: opts.seconds,
      loops: opts.loops ?? 1,
    });
    const peak = { min: 1, max: 0 };
    for (const ch of [render.left, render.right]) {
      for (let i = 0; i < ch.length; i++) {
        if (ch[i]! < peak.min) peak.min = ch[i]!;
        if (ch[i]! > peak.max) peak.max = ch[i]!;
      }
    }
    return [
      `canonicalSha=${sha256Of(Buffer.from(smfCanonical(smf)))}`,
      `planSha=${sha256Of(Buffer.from(planCanonical(plan)))}`,
      `notes=${plan.notes.length} endT=${rationalToNumber(plan.endT).toFixed(6)}`,
      `checksum=${mixChecksum(render)}`,
      `peak=${peak.min.toFixed(9)},${peak.max.toFixed(9)}`,
    ].join('\n');
  };
  const w1 = work();
  const w2 = work();
  expect(w2, `${opts.name}: double-run equality`).toBe(w1);
  runAudioGolden({
    name: opts.name,
    kind: opts.kind,
    script: opts.script,
    sampleRate: opts.sampleRate,
    artifact: 'none',
    render: () => {
      // The artifact for music scenes IS the text record above; encode it
      // losslessly into Int16 bytes (byte-length/2 samples, exact roundtrip).
      const bytes = Buffer.from(w1 + '\u0000', 'utf8');
      const n = Math.ceil(bytes.length / 2);
      const mix = new Int16Array(n);
      const view = new Uint8Array(mix.buffer);
      bytes.forEach((b, i) => (view[i] = b));
      return mix;
    },
  });
}

/* ------------------------------------------------------------------ */
/* E1M1 scripted runs (real sim; audio is a PURE CONSUMER)             */
/* ------------------------------------------------------------------ */

export function bootE1M1(): GameState {
  const state = gInitGame(buildMapFromData(loadMap(iwad(), 'E1M1')));
  resetHookSlots(state.hooks);
  // Mirror main.ts:586-587 — the production sfx-slot install for the
  // headless scripted runs (weapon-fire + pickup emits reach sfxSlot).
  installPickupSfxBridge(state.hooks, () => state.leveltime);
  installPsprSfxSlot(state.hooks, () => state.leveltime);
  return state;
}

export interface ScriptedRun {
  state: GameState;
  /** Live-sfx ledger (origin objects mapped to stable ints in arrival order). */
  events: { tic: number; id: number; x: number; y: number; z: number; origin: number | null }[];
  /** Listener keyframes (recorded on x/y/angle change only). */
  listener: { tic: number; x: number; y: number; angle: number; self: number | null }[];
  hash: number;
  sfxLogHash: string;
}

function originKey(origin: LiveSfxOrigin | null, ids: Map<object, number>, next: { v: number }): number | null {
  if (origin === null || origin === undefined) return null;
  let id = ids.get(origin);
  if (id === undefined) {
    id = next.v++;
    ids.set(origin, id);
  }
  return id;
}

/**
 * Run scripted tics on a fresh E1M1 boot with an audio CONSUMER attached
 * (or with none — `consumer: false` is the muted-boot baseline for hook-log
 * parity). Input schedule: `plan(tic) -> GameInput` each tic. Returns the
 * ledger + listener track + hashState + a sha over the sfx hook log.
 */
export function scriptedE1M1Run(opts: {
  tics: number;
  plan?: (tic: number) => Partial<GameInput>;
  pistolStart?: boolean;
  consumer?: boolean;
  /** Also attach a REAL mixerCore Mixer as the consumer's second half
   * (the audio pipeline really consumes the ledger; hash must not move). */
  mixer?: boolean;
}): ScriptedRun {
  const state = bootE1M1();
  if (opts.pistolStart) {
    const p = state.players[0] as unknown as {
      weaponowned: Int32Array | number[];
      ammo: Int32Array | number[];
      readyweapon: number;
    };
    p.weaponowned[WP_PISTOL] = 1;
    p.ammo[AM_CLIP] = 300;
    p.readyweapon = WP_PISTOL;
  }
  const ids = new Map<object, number>();
  const next = { v: 1 };
  const run: ScriptedRun = {
    state,
    events: [],
    listener: [],
    hash: 0,
    sfxLogHash: '',
  };
  const mo0 = state.players[0]!.mo;
  const selfId = originKey(mo0 as unknown as LiveSfxOrigin, ids, next);
  run.listener.push({ tic: 0, x: mo0.x, y: mo0.y, angle: (mo0.angle ?? 0) >>> 0, self: selfId });

  if (opts.consumer ?? true) {
    let mixer: ReturnType<typeof createMixer> | null = null;
    if (opts.mixer) mixer = createMixer({ buffers: (id: number) => sfxDataById(iwad(), id) });
    registerLiveSfx((sfx, origin, x, y, z, tic) => {
      const id = typeof sfx === 'number' ? sfx : -1;
      run.events.push({ tic, id, x, y, z, origin: originKey(origin, ids, next) });
      if (mixer !== null) {
        const mo = state.players[0]!.mo;
        mixer.start(id, origin === null ? null : (originKey(origin, ids, next) ?? null), x, y, tic);
        mixer.updateSounds(tic, {
          x: mo.x,
          y: mo.y,
          angle: (mo.angle ?? 0) >>> 0,
          self: selfId,
        });
      }
    });
  } else {
    registerLiveSfx(null);
  }

  const input = (tic: number): GameInput => ({ ...emptyInput(), ...(opts.plan?.(tic) ?? {}) });
  try {
    for (let t = 0; t < opts.tics; t++) {
      gTicker(state, input(t));
      const mo = state.players[0]!.mo;
      const last = run.listener[run.listener.length - 1]!;
      if (last.x !== mo.x || last.y !== mo.y || ((mo.angle ?? 0) >>> 0) !== last.angle) {
        run.listener.push({ tic: t + 1, x: mo.x, y: mo.y, angle: (mo.angle ?? 0) >>> 0, self: selfId });
      }
    }
  } finally {
    registerLiveSfx(null);
  }
  run.hash = hashState(state);
  run.sfxLogHash = sha256Of(
    Buffer.from(
      JSON.stringify(state.hooks.sfx.entries.map((e) => [e.id, e.x, e.y, e.z, e.tic])) +
        `|count=${state.hooks.sfx.count}`,
    ),
  );
  return run;
}

/** Convenience: the scripted E1M1 pistol firefight (held fire, 2000 tics). */
export const FIREFIGHT_TICS = 2000;

export function e1m1Firefight(): ScriptedRun {
  return scriptedE1M1Run({
    tics: FIREFIGHT_TICS,
    pistolStart: true,
    // attackdown starts TRUE (G_PlayerReborn idiom, p_pspr.ts:290) — the
    // button must be seen RELEASED once before a held-fire refires.
    plan: (tic) => (tic < 2 ? {} : { attack: true }),
  });
}

/** The MixScript for the firefight golden (wad-resolved DS buffers). */
export function firefightScript(run: ScriptedRun): Script {
  const wad = iwad();
  return {
    events: run.events.map((e) => ({ tic: e.tic, id: e.id, x: e.x, y: e.y, origin: e.origin })),
    listener: run.listener,
    buffers: (id: number) => sfxDataById(wad, id),
  };
}

/* ------------------------------------------------------------------ */
/* mock-WebAudio driver-spy rig (sfxDriver.test.ts mirror; the live half */
/* of the integration smoke: ledger → driver census vs offline render)   */
/* ------------------------------------------------------------------ */

class SpyParam {
  value = 0;
  setTargetAtTime(target: number): void {
    this.value = target;
  }
  setValueAtTime(v: number): void {
    this.value = v;
  }
  linearRampToValueAtTime(v: number): void {
    this.value = v;
  }
}
class SpyGain {
  readonly gain = new SpyParam();
  disconnects = 0;
  connect(): void {}
  disconnect(): void {
    this.disconnects++;
  }
}
class SpyBuffer implements SfxBufferLike {
  private readonly data: Float32Array;
  constructor(readonly length: number, readonly sampleRate: number) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}
class SpySource implements SfxSourceNodeLike {
  buffer: SfxBufferLike | null = null;
  readonly playbackRate = new SpyParam();
  loop = false;
  onended: (() => void) | null = null;
  readonly starts: number[] = [];
  readonly stops: number[] = [];
  disconnects = 0;
  connect(): void {}
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
class SpyMerger implements SfxMergerNodeLike {
  disconnects = 0;
  connect(): void {}
  disconnect(): void {
    this.disconnects++;
  }
}

export class SpyContext implements AudioContextLike {
  state: 'suspended' | 'running' = 'running';
  currentTime = 5;
  readonly sampleRate = 44_100;
  readonly destination = { kind: 'destination' } as const;
  onstatechange: (() => void) | null = null;
  readonly sources: SpySource[] = [];
  createGain(): SpyGain {
    return new SpyGain();
  }
  createBufferSource(): SpySource {
    const s = new SpySource();
    this.sources.push(s);
    return s;
  }
  createBuffer(_ch: number, length: number, rate: number): SpyBuffer {
    return new SpyBuffer(Math.max(1, length), Math.max(1, rate));
  }
  createChannelMerger(): SpyMerger {
    return new SpyMerger();
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

export interface SpyRig {
  ctx: SpyContext;
  driver: SfxDriver;
  events: ScriptedRun['events'];
  listener: { tic: number; x: number; y: number; angle: number; self: number | null }[];
  started: () => number;
  dispose: () => void;
}

/**
 * Attach a driver (real wad data) + a ledger collector to a scripted E1M1
 * run: BOTH see every sfxSlot event (hooks.registerLiveSfx is single-slot,
 * so the rig multiplexes explicitly). `tic` calls driver.tick(state) after
 * every gTicker — the D-10f tic-boundary shape.
 */
export function spyRun(opts: { tics: number; plan?: (tic: number) => Partial<GameInput> }): SpyRig {
  __resetSfxDriver();
  __resetAudioContext();
  bindVolumes();
  const ctx = new SpyContext();
  setContextFactory(() => ctx);
  ensureContext();
  const wall = { t: 1000 };
  const driver = createSfxDriver({ wad: iwad(), wallNow: () => wall.t });
  const events: ScriptedRun['events'] = [];
  const ids = new Map<object, number>();
  const next = { v: 1 };

  const state = bootE1M1();
  const listener: SpyRig['listener'] = [];
  const mo0 = state.players[0]!.mo;
  const selfId = originKey(mo0 as unknown as LiveSfxOrigin, ids, next);
  listener.push({ tic: 0, x: mo0.x, y: mo0.y, angle: (mo0.angle ?? 0) >>> 0, self: selfId });
  const p = state.players[0] as unknown as {
    weaponowned: Int32Array | number[];
    ammo: Int32Array | number[];
    readyweapon: number;
  };
  p.weaponowned[WP_PISTOL] = 1;
  p.ammo[AM_CLIP] = 300;
  p.readyweapon = WP_PISTOL;

  registerLiveSfx((sfx, origin, x, y, z, tic) => {
    events.push({ tic, id: typeof sfx === 'number' ? sfx : -1, x, y, z, origin: originKey(origin, ids, next) });
    driver.onSfxEvent(sfx, origin, x, y, z, tic);
  });
  try {
    for (let t = 0; t < opts.tics; t++) {
      ctx.currentTime += 1 / 35;
      wall.t += 1 / 35;
      gTicker(state, { ...emptyInput(), ...(opts.plan?.(t) ?? {}) });
      driver.tick(state);
      const mo = state.players[0]!.mo;
      const last = listener[listener.length - 1]!;
      if (last.x !== mo.x || last.y !== mo.y || ((mo.angle ?? 0) >>> 0) !== last.angle) {
        listener.push({ tic: t + 1, x: mo.x, y: mo.y, angle: (mo.angle ?? 0) >>> 0, self: selfId });
      }
      for (const src of ctx.sources) {
        // fire onended for sources whose scheduled stop has passed the clock
        if (src.onended !== null && src.stops.length > 0 && src.stops[src.stops.length - 1]! <= ctx.currentTime) {
          const cb = src.onended;
          src.onended = null;
          cb();
        }
      }
    }
  } finally {
    registerLiveSfx(null);
  }
  return {
    ctx,
    driver,
    events,
    listener,
    started: () => ctx.sources.filter((s) => s.starts.length > 0).length,
    dispose: () => {
      driver.dispose();
      __resetSfxDriver();
      __resetAudioContext();
    },
  };
}

/* ------------------------------------------------------------------ */
/* misc exported helpers                                                */
/* ------------------------------------------------------------------ */

export { mixHash, toFloat32 };
export type { MixSfxData, RuntimeMap };
export { rationalToNumber };

/** Quiet helper for the census test: is a name a plausible DS lump? */
export function hasDsLump(wad: WadFile, id: number): boolean {
  const name = SFX_INFO[id]!.name.toUpperCase();
  return wad.has(`DS${name}`);
}
