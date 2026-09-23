// audio/mixerCore.ts — the deterministic software mixer (M10-05, plan
// §0.1-0.5 / §M10-05): the s_sound.c channel allocator + the i_sound.c
// mixing law, in pure TS int math. THE golden-buffer engine — zero WebAudio
// (the browser driver, M10-06, mirrors these decisions through GainNodes),
// zero WebAudio panner nodes (NO StereoPannerNode — the L/R split is the
// addsfx quadratic, i_sound.c:350-373; mechanical grep test in
// mixerCore.test.ts).
//
// Channel model (plan §0.1: linuxdoom splits S_getChannel's `snd_channels`
// allocator from the OSS mixer's NUM_CHANNELS=8 slots). D-10c: ONE unified
// pool of NUM_MIXER_CHANNELS = 8 channels with vanilla allocator semantics
// (the documented middle: 1.10's shipped snd_channels=3, m_misc.c:282, is an
// artifact config; i_sound.c:94 NUM_CHANNELS=8 is our mixer width too).
// Deviations from the two-layer split, each marked at its site below: dedup
// kills the whole channel (addsfx killed only the data pointer); a missing
// DS lump is a counted silent DROP before S_StopSound/getChannel (vanilla
// I_Errors through W_GetNumForName — plan §0.10 policy).
//
// S_StartSoundAtVolume order VERBATIM (s_sound.c:254-395, plan §0.2) — MINUS
// the M_Random jitter (D-10a): a sound-owned splitmix(tic, sfxId, origin)
// keeps the DISTRIBUTION (saw ±8 `8-(r&15)`, others ±16 `16-(r&31)`,
// itemup/tink none — s_sound.c:326-346) with ZERO stream draws.
//
// S_getChannel VERBATIM (s_sound.c:827-875, plan §0.4): first-free break,
// break-and-steal on SAME origin (one-sound-per-mobj is the real
// "singularity" — the table column is never read in 1.10); else kick the
// FIRST channel with `priority >= new` (lower number = higher precedence),
// else "Sorry, Charlie" return -1 → the event DROPS (stats.drops).
//
// addsfx rules mirrored (i_sound.c:260-390, plan §0.5): the hardcoded dedup
// set {sawup,sawidl,sawful,sawhit,stnmov,pistol} (i_sound.c:285-290) kills
// any already-active SAME-ID instance regardless of origin; the quadratic
// sep split (i_sound.c:350-373) `leftvol = vol - ((vol*(sep+1)^2)>>16)`,
// `rightvol = vol - ((vol*(sep-256)^2)>>16)`; the vol_lookup law
// `(vol*(byte-128)*256)/127` (i_sound.c:421-423) as the mix contribution
// with C's truncate-toward-zero division; the ±0x7fff / -0x8000 asymmetric
// clamp (:617-627); completion = sample position ≥ length (the mix-loop
// rule :606-607, plan §0.5's I_SoundIsPlaying equivalent).
//
// Pitch: `steptable[pitch]` built EXACTLY as i_sound.c:417 —
// `(int)(pow(2.0, ((pitch-128)/64.0)) * 65536.0)`; the render step per
// output frame is the exact rational pin
// `step16 = trunc(steptable[pitch] * dsRate / sampleRate)` (0.16 fixed — the
// "DS freq → exact rational" sample-rate math; vanilla's own 11025 mixer
// rate is irrelevant, plan §0.8: we resample at the step, not at decode).
//
// renderMix(script, sampleRate): the offline golden engine — event ledger +
// decoded buffers + listener track → interleaved stereo Int16 (toFloat32 for
// consumers). Bit-reproducible by construction: integer pos/step/lookup
// math; the only transcendentals are `steptable`'s pow (i_sound.c verbatim,
// computed once per pitch value) and nothing else — no Math.sin, no Date,
// no iteration-order dependence (events keep ledger order inside a tic).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { SFX_ID, NUMSFX } from '../sim/psound_stub';
import { DEDUP_SFX_IDS, SFX_INFO } from './sfxinfo';

/** The MINIMAL decoded-buffer shape the render loop needs (rate + mono
 * float PCM at the native DS rate). sfxdata's DecodedSfx satisfies it
 * structurally; the golden tests build exact-binary synthetic buffers. */
export interface MixSfxData {
  readonly rate: number;
  readonly samples: Float32Array;
}
import { NORM_SEP, sAdjustSoundParams } from './spatial';

/* ------------------------------------------------------------------ */
/* Constants (source-cited)                                             */
/* ------------------------------------------------------------------ */

/** D-10c unified pool width = i_sound.c:94 NUM_CHANNELS 8. */
export const NUM_MIXER_CHANNELS = 8;

/** The sim tick rate (35 tps, ARCHITECTURE §2) — the scheduler grid. */
export const TPS = 35;

/** s_sound.c:69 NORM_PITCH. */
export const NORM_PITCH = 128;

/** s_sound.c:70 NORM_PRIORITY — the dead local (plan §0.2); eviction always
 * compares TABLE priorities (s_sound.c:854 `channels[c].sfxinfo->priority`). */
export const NORM_PRIORITY = 64;

/**
 * steptable analog, i_sound.c:417 VERBATIM (`steptablemid[i] =
 * (int)(pow(2.0, (i/64.0))*65536.0)`, i = pitch − NORM_PITCH). pitch 128 →
 * 65536 = unity. Built ONCE; every value is a plain int (0.16 fixed).
 */
export const STEP_TABLE: readonly number[] = (() => {
  const t = new Array<number>(256);
  for (let p = 0; p < 256; p++) {
    t[p] = Math.trunc(Math.pow(2.0, (p - NORM_PITCH) / 64.0) * 65536.0);
  }
  return t;
})();

/**
 * vol_lookup, i_sound.c:421-423 VERBATIM: `vol_lookup[i*256+j] =
 * (i*(j-128)*256)/127` — C int division truncates toward ZERO (Math.trunc).
 * Row = mix volume 0..127, column = unsigned 8-bit byte 0..255; result is
 * the signed 16-bit-domain contribution. Exported for golden audits
 * (`volLaw` below is the algebraic same-law form used on interpolated s).
 */
export const VOL_LOOKUP: readonly number[] = (() => {
  const t = new Array<number>(128 * 256);
  for (let i = 0; i < 128; i++) {
    for (let j = 0; j < 256; j++) t[i * 256 + j] = Math.trunc((i * (j - 128) * 256) / 127);
  }
  return t;
})();

/** The vol_lookup law as a function (also exact for the INTERPOLATED signed
 * sample `s` the renderer produces between two bytes): (vol * s * 256) / 127,
 * truncated toward zero — i_sound.c:423. */
export function volLaw(vol: number, s: number): number {
  return Math.trunc((vol * s * 256) / 127);
}

/* ------------------------------------------------------------------ */
/* Sound-owned pitch jitter (D-10a — NO M_Random draws)                 */
/* ------------------------------------------------------------------ */

function hash32(a: number, b: number, c: number): number {
  let z = (a + Math.imul(b + 0x9e3779b9, 0x85ebca6b) ^ Math.imul(c + 0xc2b2ae35, 0x27d4eb2d)) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * The ±pitch wobble of s_sound.c:326-346 WITHOUT the menu-stream
 * `M_Random()` burn (D-10a): a pure function of (tic, sfx id, origin).
 * Distribution preserved verbatim — sawup..sawhit `+8-(r&15)`, everything
 * except itemup/tink `+16-(r&31)`, itemup/tink none (no draw, no jitter).
 */
export function sfxJitter(tic: number, sfxId: number, origin: number | null): number {
  if (sfxId === SFX_ID.sfx_itemup || sfxId === SFX_ID.sfx_tink) return 0;
  const r = hash32(tic | 0, sfxId, origin === null ? 0 : (origin | 0) + 1);
  if (sfxId >= SFX_ID.sfx_sawup && sfxId <= SFX_ID.sfx_sawhit) return 8 - (r & 15);
  return 16 - (r & 31);
}

/* ------------------------------------------------------------------ */
/* addsfx quadratic stereo split (i_sound.c:350-373)                    */
/* ------------------------------------------------------------------ */

/** The sep range is 32..225 from s_sound.c:793 and NORM_SEP 128, so both
 * squared legs stay inside [0, vol]; an escape is an implementation bug. */
export function addsfxSplit(
  vol: number,
  sep: number,
): { readonly left: number; readonly right: number } {
  const s1 = sep + 1; // :352 "seperation += 1"
  const left = vol - ((vol * s1 * s1) >> 16); // :357
  const s2 = s1 - 257; // :360 "seperation = seperation - 257"
  const right = vol - ((vol * s2 * s2) >> 16); // :362
  if (left < 0 || left > 127 || right < 0 || right > 127) {
    // vanilla I_Error("leftvol/rightvol out of bounds") :364-369
    throw new RangeError(`addsfxSplit out of bounds: vol=${vol} sep=${sep}`);
  }
  return { left, right };
}

/* ------------------------------------------------------------------ */
/* Channel pool + allocator                                             */
/* ------------------------------------------------------------------ */

/** One mixer channel (unified channel_t × i_sound.c slot arrays). Read-only
 * for consumers; the mixer/render loop owns mutations. */
export interface MixChannel {
  /** S_sfx id currently playing; 0 = FREE (vanilla `channels[slot]` truthy). */
  sfxId: number;
  /** Table priority (sounds.c col 3) while occupied; eviction operand. */
  priority: number;
  /** Origin handle (null = NULL-origin: listener-local). */
  origin: number | null;
  /** Last-known source position (fixed_t) — per-tic re-apply (D-10e). */
  x: number;
  y: number;
  /** Decoded PCM (link rows carry the LINK's data, i_sound.c:803-810). */
  data: MixSfxData | null;
  /** Current pitch 0..255 (NORM_PITCH 128 + jitter, s_sound.c:323-346). */
  pitch: number;
  /** Current mix volume 0..127 (pre-split; spatially attenuated). */
  vol: number;
  /** Current stereo separation 32..225 (128 = center). */
  sep: number;
  /** 0.16 fixed sample position; the mix loop owns the advance. */
  pos16: number;
  /** Tic the channel was started on (addsfx `channelstart`, :347). */
  startTic: number;
}

/** The listener pose (players[consoleplayer].mo read-view): fixed_t x/y,
 * u32 BAM angle, `self` = the origin handle OF the player mobj (a start with
 * that origin is listener-local, s_sound.c:305). */
export interface ListenerPose {
  readonly x: number;
  readonly y: number;
  readonly angle?: number;
  readonly self?: number | null;
}

/** Data source: sfxdata.sfxDataById-style resolution, null = silent (§0.10). */
export type SfxBufferSource = (id: number) => MixSfxData | null;

export interface MixerOptions {
  /** Decoded data per sfx id (link rows are resolved INTERNALLY here — pass
   * a map/function keyed by the table id whose DS lump exists, or key the
   * link target: the pool looks up `info.link ?? id`). */
  readonly buffers: ReadonlyMap<number, MixSfxData> | SfxBufferSource;
  /** snd_SfxVolume mirror, 0..127 (default = thermo 8 *8 = 64, D-10d). */
  readonly sfxVolume?: number;
  /** gamemap for the E1M8 branch (s_sound.c:773/:800; default 1). */
  readonly gamemap?: number;
}

export interface MixerStats {
  /** Starts dropped for a missing DS lump (warn-once counter surface). */
  misses: number;
  /** Starts dropped by "Sorry, Charlie" (s_sound.c:856-860). */
  drops: number;
}

export interface Mixer {
  readonly channels: readonly MixChannel[];
  readonly stats: MixerStats;
  /** S_SetSfxVolume (s_sound.c:631-639): 0..127 or RangeError. */
  setVolume(v: number): void;
  volume(): number;
  setGamemap(g: number): void;
  gamemap(): number;
  setListener(p: ListenerPose): void;
  /** S_StartSound/AtVolume (§0.2): true = a channel was allocated. */
  start(
    id: number,
    origin: number | null,
    x: number,
    y: number,
    tic: number,
    volume?: number,
  ): boolean;
  /** S_StopSound (s_sound.c:471-484): first channel matching origin. */
  stopSound(origin: number | null): void;
  /** S_UpdateSounds (s_sound.c:519-613) with D-10e per-tic param re-apply. */
  updateSounds(tic: number, listener?: ListenerPose): void;
  /** S_Start's channel-kill half (s_sound.c:207-211; music side → M10-08). */
  startLevel(): void;
}

export function createMixer(options: MixerOptions): Mixer {
  const src: SfxBufferSource =
    typeof options.buffers === 'function'
      ? options.buffers
      : (id: number) => (options.buffers as ReadonlyMap<number, MixSfxData>).get(id) ?? null;

  const channels: MixChannel[] = [];
  for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
    channels.push({
      sfxId: 0,
      priority: 0,
      origin: null,
      x: 0,
      y: 0,
      data: null,
      pitch: NORM_PITCH,
      vol: 0,
      sep: NORM_SEP,
      pos16: 0,
      startTic: 0,
    });
  }

  let sfxVolume = options.sfxVolume ?? 8 * 8; // D-10d: thermo 8 → internal 64
  let gamemap = options.gamemap ?? 1;
  let listener: Required<ListenerPose> = { x: 0, y: 0, angle: 0, self: null };
  const stats: MixerStats = { misses: 0, drops: 0 };

  /** S_StopChannel (:708-742): usefulness bookkeeping is dead in 1.10 and
   * I_StopSound is a no-op — freeing the channel silences it (unified pool). */
  function stopChannel(cnum: number): void {
    const c = channels[cnum]!;
    if (!c.sfxId) return;
    c.sfxId = 0;
    c.priority = 0;
    c.origin = null;
    c.data = null;
    c.vol = 0;
    c.sep = NORM_SEP;
    c.pos16 = 0;
  }

  /** S_StopSound (s_sound.c:471-484): FIRST channel matching origin (the
   * NULL-origin events match NULL channels, verbatim). */
  function stopSound(origin: number | null): void {
    for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
      const c = channels[i]!;
      if (c.sfxId && c.origin === origin) {
        stopChannel(i);
        break;
      }
    }
  }

  /** S_getChannel VERBATIM (s_sound.c:827-875). */
  function getChannel(origin: number | null, priority: number): number {
    let cnum = 0;
    for (; cnum < NUM_MIXER_CHANNELS; cnum++) {
      const c = channels[cnum]!;
      if (!c.sfxId) break; // :836 first free
      if (origin !== null && c.origin === origin) {
        stopChannel(cnum); // :838-842 break-and-steal (one sound per origin)
        break;
      }
    }
    if (cnum === NUM_MIXER_CHANNELS) {
      // :850-854 — kick the FIRST channel whose table priority is >= ours
      for (cnum = 0; cnum < NUM_MIXER_CHANNELS; cnum++) {
        if (channels[cnum]!.priority >= priority) break;
      }
      if (cnum === NUM_MIXER_CHANNELS) return -1; // :856-860 "Sorry, Charlie"
      stopChannel(cnum); // :866-869 "Otherwise, kick out lower priority"
    }
    return cnum;
  }

  /** The per-channel spatial volume reset S_UpdateSounds recomputes
   * (:539-541: volume = snd_SfxVolume fresh EVERY tic — never incremental). */
  function reapply(c: MixChannel): void {
    const info = SFX_INFO[c.sfxId]!;
    let volume = sfxVolume;
    if (info.link !== null) {
      volume += 0; // link `volume` column is 0 for the only link row (chgun)
      if (volume < 1) {
        stopChannel(channels.indexOf(c));
        return;
      }
      if (volume > sfxVolume) volume = sfxVolume;
    }
    if (c.origin !== null && c.origin !== listener.self) {
      const r = sAdjustSoundParams(listener, { x: c.x, y: c.y }, volume, sfxVolume, gamemap);
      const sameXy = c.x === listener.x && c.y === listener.y;
      if (r === null) {
        stopChannel(channels.indexOf(c)); // :586-588 inaudible ⇒ stop
        return;
      }
      c.vol = r.vol;
      c.sep = sameXy ? NORM_SEP : r.sep; // :312-316 override, verbatim shape
    } else {
      c.vol = volume; // local sounds: full snd_SfxVolume, center
      c.sep = NORM_SEP;
    }
  }

  return {
    channels,
    stats,

    setVolume(v: number): void {
      if (v < 0 || v > 127) {
        // s_sound.c:633-636 I_Error("Attempt to set sfx volume at %d")
        throw new RangeError(`Attempt to set sfx volume at ${v}`);
      }
      sfxVolume = v;
    },
    volume: () => sfxVolume,
    setGamemap(g: number): void {
      gamemap = g;
    },
    gamemap: () => gamemap,
    setListener(p: ListenerPose): void {
      listener = { x: p.x, y: p.y, angle: p.angle ?? 0, self: p.self ?? null };
    },

    start(id, origin, x, y, tic, volumeIn): boolean {
      // :268 bogus-sound guard (I_Error → RangeError at the boundary)
      if (!Number.isInteger(id) || id < 1 || id >= NUMSFX) {
        throw new RangeError(`Bad sfx #: ${id}`);
      }
      const info = SFX_INFO[id]!;

      let volume = volumeIn ?? sfxVolume;
      let pitch: number;
      let priority: number;
      if (info.link !== null) {
        // :283-299 link branch — pitch 150 (sounds.c:204), volume += 0,
        // clamp 1..snd_SfxVolume, drop when < 1
        pitch = info.linkPitch;
        priority = info.priority;
        volume += 0;
        if (volume < 1) return false;
        if (volume > sfxVolume) volume = sfxVolume;
      } else {
        pitch = NORM_PITCH; // :302 (the :286 local is dead — eviction reads
        priority = info.priority; // the TABLE row via S_getChannel, §0.4)
      }

      // :305-324 audible check / param adjust; NULL origin = local
      let sep = NORM_SEP;
      if (origin !== null && origin !== listener.self) {
        const r = sAdjustSoundParams(
          listener,
          { x, y },
          volume,
          sfxVolume,
          gamemap,
        );
        if (x === listener.x && y === listener.y) sep = NORM_SEP; // :312-316
        else if (r !== null) sep = r.sep;
        if (r === null) return false; // :317-319 `if (!rc) return;`
        volume = r.vol;
      }

      // :326-346 pitch jitter — D-10a sound-owned splitmix, NOT M_Random
      pitch += sfxJitter(tic, id, origin);
      if (pitch < 0) pitch = 0;
      else if (pitch > 255) pitch = 255;

      // :364-365 lump resolution (i_sound.c:451-456 `ds%s`) + link data
      // (i_sound.c:803-810). Policy deviation (§0.10): a missing lump is a
      // counted silent drop — vanilla I_Errors; we never touch the channel
      // pool for a sound that can never produce a sample.
      const data = src(info.link ?? id);
      if (data === null) {
        stats.misses++;
        return false;
      }

      stopSound(origin); // :349 kill-old (one sound per origin)

      // addsfx mutual exclusion (i_sound.c:283-306, plan §0.5): ANY active
      // instance of a dedup id is unconditionally killed, origin-independent
      // (chainsaw-dupe fix). Unified-pool ordering: the kill precedes the
      // slot choice so the freed channel is reused (addsfx's own slot scan
      // lands on the killed slot — same reuse); vanilla deviates by picking
      // the eviction channel first and leaving it data-less (documented).
      if (DEDUP_SFX_IDS.includes(id)) {
        for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
          if (channels[i]!.sfxId === id) stopChannel(i);
        }
      }

      const cnum = getChannel(origin, priority); // :352
      if (cnum < 0) {
        stats.drops++;
        return false;
      }

      const c = channels[cnum]!;
      c.sfxId = id;
      c.priority = priority;
      c.origin = origin;
      c.x = x;
      c.y = y;
      c.data = data;
      c.pitch = pitch;
      c.vol = volume;
      c.sep = sep;
      c.pos16 = 0;
      c.startTic = tic; // channelstart analog (:347) — oldest-echo kept here
      return true;
    },

    stopSound(origin): void {
      stopSound(origin);
    },

    updateSounds(tic, listenerPose?): void {
      if (listenerPose !== undefined) this.setListener(listenerPose);
      void tic;
      for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
        const c = channels[i]!;
        if (!c.sfxId || c.data === null) continue;
        // Finished ⇒ free (I_SoundIsPlaying is a 1.10 stub; the equivalent
        // rule is the mix-loop end test, i_sound.c:606-607, plan §0.5).
        if ((c.pos16 >>> 16) >= c.data.samples.length) {
          stopChannel(i);
          continue;
        }
        reapply(c); // D-10e per-tic re-apply (mirror's I_UpdateSoundParams
        // is a documented NO-OP, i_sound.c:675-688 — we follow Chocolate)
      }
    },

    startLevel(): void {
      // s_sound.c:207-211 (S_Start kills every sfx channel; the music side
      // of S_Start is M10-08's)
      for (let i = 0; i < NUM_MIXER_CHANNELS; i++) stopChannel(i);
    },
  };
}

/* ------------------------------------------------------------------ */
/* renderMix — the offline golden engine                                */
/* ------------------------------------------------------------------ */

/** One S_StartSound ledger event (superset-compatible with the sim-side
 * SfxEvent {id,x,y,z,tic}: z is informational — no z term in the distance
 * math, s_sound.c:767-771). */
export interface MixEvent {
  readonly tic: number;
  readonly id: number;
  readonly x?: number;
  readonly y?: number;
  readonly origin?: number | null;
  readonly volume?: number;
}

/** Listener track keyframe (players[consoleplayer].mo per tic; sparse —
 * the pose holds from this tic until the next key). */
export interface MixListenerKey {
  readonly tic: number;
  readonly x: number;
  readonly y: number;
  readonly angle?: number;
  readonly self?: number | null;
}

export interface MixScript {
  readonly events: readonly MixEvent[];
  readonly buffers: ReadonlyMap<number, MixSfxData> | SfxBufferSource;
  readonly listener?: readonly MixListenerKey[];
  readonly sfxVolume?: number;
  readonly gamemap?: number;
  /** Output length; default = last sound end + 1 s silence pad. */
  readonly frames?: number;
}

/** The exact-rational 0.16 step pin (file-level PIN, plan §M10-05):
 * `step16 = trunc(steptable[pitch] * dsRate / sampleRate)` — integer-only
 * arithmetic from an integer steptable entry and two integer rates. */
export function renderStep16(pitch: number, dsRate: number, sampleRate: number): number {
  return Math.trunc((STEP_TABLE[pitch]! * dsRate) / sampleRate);
}

/**
 * Software-render a script to an interleaved stereo Int16 buffer
 * [L0,R0,L1,R1,…] at `sampleRate`. THE golden subject (D-10b): deterministic
 * int math mirroring i_sound.c:576-635 — per frame, per active channel:
 * signed 8-bit-equivalent sample (linear interpolation between the two
 * neighbour bytes in the signed-byte domain — the pinned deviation from the
 * nearest-neighbour fetch of :577, needed because we step arbitrary
 * dsRate/sampleRate), volLaw contribution per side, ±0x7fff/−0x8000 clamp
 * (:617-627), integer 0.16 advance, free-on-end (:606-607).
 * Tic grid: tic = floor(frame * TPS / sampleRate); each boundary applies the
 * listener keyframes ≤ tic, starts that tic's ledger events IN LEDGER ORDER,
 * then runs S_UpdateSounds (D-DoomLoop order, d_main.c:392: input, then
 * per-frame sound update).
 */
export function renderMix(script: MixScript, sampleRate: number): Int16Array {
  const src: SfxBufferSource =
    typeof script.buffers === 'function'
      ? script.buffers
      : (id: number) => (script.buffers as ReadonlyMap<number, MixSfxData>).get(id) ?? null;
  const resolve = (id: number): MixSfxData | null => {
    const info = SFX_INFO[id];
    return src(info !== undefined && info.link !== null ? info.link : id);
  };

  // Output length: explicit, or last natural end + 1 s pad (silence scenes
  // therefore render to exactly 1 s of zeros).
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

  // Ledger order preserved inside a tic: stable sort by tic.
  const events = script.events.map((e, i) => ({ e, i }));
  events.sort((a, b) => a.e.tic - b.e.tic || a.i - b.i);
  const keys = [...(script.listener ?? [])].sort((a, b) => a.tic - b.tic);

  let ei = 0;
  let ki = 0;
  let lastTic = -1;
  // Per-channel per-tic cached mix parameters (lv/rv split + step).
  const lv = new Int32Array(NUM_MIXER_CHANNELS);
  const rv = new Int32Array(NUM_MIXER_CHANNELS);
  const st = new Int32Array(NUM_MIXER_CHANNELS);

  /** i_sound.c:606-607 — the mix loop itself retires the finished channel
   * (pointer ≥ end ⇒ `channels[chan] = 0`); the unified pool frees it now
   * instead of at the next S_UpdateSounds (same silence). */
  function retire(i: number): void {
    const c = mixer.channels[i]!;
    c.sfxId = 0;
    c.priority = 0;
    c.origin = null;
    c.data = null;
    c.vol = 0;
  }

  for (let f = 0; f < frames; f++) {
    const tic = Math.floor((f * TPS) / sampleRate);
    if (tic !== lastTic) {
      lastTic = tic;
      while (ki < keys.length && keys[ki]!.tic <= tic) {
        mixer.setListener(keys[ki]!); // listener track (pose holds)
        ki++;
      }
      while (ei < events.length && events[ei]!.e.tic <= tic) {
        const e = events[ei]!.e;
        mixer.start(e.id, e.origin ?? null, e.x ?? 0, e.y ?? 0, tic, e.volume);
        ei++;
      }
      mixer.updateSounds(tic);
      for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
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
    for (let i = 0; i < NUM_MIXER_CHANNELS; i++) {
      const c = mixer.channels[i]!;
      if (!c.sfxId || c.data === null) continue;
      const sm = c.data.samples;
      const s0 = c.pos16 >>> 16;
      if (s0 >= sm.length) {
        retire(i); // zero-length/finished guard (mix-loop rule, :606-607)
        continue;
      }
      const frac = c.pos16 & 0xffff;
      const i0 = Math.round(sm[s0]! * 128); // exact signed-byte equivalent of
      const i1 = s0 + 1 < sm.length ? Math.round(sm[s0 + 1]! * 128) : i0; // (b-128)/128
      const s = i0 + (((i1 - i0) * frac) >> 16); // linear interp, signed-byte
      dl += volLaw(lv[i]!, s);
      dr += volLaw(rv[i]!, s);
      c.pos16 += st[i]!;
      if ((c.pos16 >>> 16) >= sm.length) retire(i);
    }

    // Clamp to range, i_sound.c:617-627 VERBATIM (asymmetric −0x8000/0x7fff).
    out[f * 2] = dl > 0x7fff ? 0x7fff : dl < -0x8000 ? -0x8000 : dl;
    out[f * 2 + 1] = dr > 0x7fff ? 0x7fff : dr < -0x8000 ? -0x8000 : dr;
  }

  return out;
}

/** Golden-consumer helper: Int16 interleaved → Float32 interleaved (/32768). */
export function toFloat32(mix: Int16Array): Float32Array {
  const f = new Float32Array(mix.length);
  for (let i = 0; i < mix.length; i++) f[i] = mix[i]! / 32768;
  return f;
}

/** FNV-1a 32 over the Int16 buffer's little-endian bytes — the golden hash
 * surface (committed as 8 hex digits per scene). */
export function mixHash(mix: Int16Array): string {
  const bytes = new Uint8Array(mix.buffer, mix.byteOffset, mix.byteLength);
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i]!;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
