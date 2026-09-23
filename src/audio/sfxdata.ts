// audio/sfxdata.ts — DS lump decode + the per-WAD sound cache (M10-02,
// M10-plan §M10-02 / §0.8). Pure TS: no AudioContext, no wall clock; the WAD
// is consumed through the existing read-view (WadFile.readLumpByName/has).
//
// DS lump format (plan §0.8, measured on the pinned freedoom1.wad — all 69
// DS* lumps satisfy `lumpLen == 8 + sampleCount`):
//   offset 0  u16 LE  format       — 0x0003 = unsigned 8-bit PCM ("id/DMX
//                                    SampleFormat 3"); decode is WARN-TOLERANT
//   offset 2  u16 LE  samplingFreq — measured rates {22050, 11025, 17990,
//                                    16000, 44100} (§0.8 histogram, re-audited
//                                    in sfxdata.test.ts)
//   offset 4  u32 LE  sampleCount  — raw byte count follows the 8-byte header
//   offset 8  [...]   samples      — unsigned 8-bit, silence center 128;
//                                    normalized (b - 128) / 128 → Float32 mono.
// The 1.10 engine never parses those header fields — getsfx skips 8 bytes and
// pads the body with 128 to a SAMPLECOUNT (512) multiple (i_sound.c:226-246:
// `paddedsize = ((size-8 + 511)/512)*512`, `paddedsfx[i] = 128`) — so we take
// the BODY as authoritative ([8, lumpLen)) and keep the header count for the
// sanity census only. The vanilla 128-pad tail is honored for free: our bodies
// end where the lump ends, and a trailing 128 byte simply decodes to 0.0.
//
// RESAMPLE DECISION (plan §M10-02): decode keeps the SOURCE rate — no
// resampling here. The live path lets WebAudio resample via BufferSource
// playbackRate = (srcRate / contextRate) * (pitch / 128) (`playbackRateFor`
// below; M10-06's formula), the exact analogue of linuxdoom feeding
// steptable[pitch] as a per-channel fractional pointer step against its fixed
// SAMPLERATE 11025 mixer (i_sound.c:99, :342-344, :495 — pitch there is step
// only, and the comment doubts it even works). Keeping the decode a PURE
// function of bytes means the deterministic TS render path (M10-05 renderMix)
// owns its own resampling in int math and the goldens never depend on an
// AudioContext sampleRate. The (b-128)/128 law is exact in float32 (integer
// divided by a power of two), so decode is bit-stable across platforms.
//
// Missing-lump policy (plan §0.10): an absent DS lump resolves to NULL (a
// silent entry), NEVER a throw. Vanilla cites: the lazy play path dies via
// W_GetNumForName→I_Error (s_sound.c:364-365, i_sound.c:451-456) while the
// boot pre-cache path substitutes dspistol (getsfx, i_sound.c:215-219) — we
// choose silence + a counted miss (warn-once is the driver's voice, M10-06).
// Link rows (chgun, sounds.c:204) resolve through their link, mirroring
// I_InitSound's link branch (i_sound.c:803-810): data comes from the linked
// sound, so chgun is audible wherever the pistol is.
//
// Cache: decode ONCE per WAD mount (vanilla pre-caches all S_sfx at boot,
// i_sound.c:796-811, and usefulness-based eviction is dead in 1.10,
// s_sound.c:368/:796-811) — a WeakMap keyed by the WadFile instance, so the
// entries live exactly as long as the mounted WAD (eviction-free at this
// scale: ~69 lumps ≈ 3 MB of float32).
//
// Zone rule (A-06): wad + audio-table imports only.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { WadFile } from '../wad/wadfile';
import { DS_MISSING_NAMES, dsLumpName, NUMSFX, SFX_INFO } from './sfxinfo';

/** Expected DS header format (id SampleFormat 3 = unsigned 8-bit PCM). */
export const DS_FORMAT_U8 = 0x0003;

/** Header size skipped by vanilla (i_sound.c:230 `size-8`, :247 `+8`). */
export const DS_HEADER_BYTES = 8;

/** One decoded sound: source-rate mono float32 PCM + header census fields. */
export interface DecodedSfx {
  /** samplingFreq from the header (u16 LE @2) — the buffer's native rate. */
  readonly rate: number;
  /** Body [8, lumpLen) normalized to [-1, 1): (b − 128) / 128. */
  readonly samples: Float32Array;
  /** Header format field (u16 LE @0); 3 expected, kept raw for the audit. */
  readonly format: number;
  /** Header sampleCount field (u32 LE @4); kept raw for the audit. */
  readonly headerCount: number;
  /** headerCount ≠ samples.length (vanilla ignores the field; we flag it). */
  readonly countMismatch: boolean;
}

/**
 * Decode a raw DS lump (pure function of bytes; never throws on plausible
 * input — short/empty lumps yield an empty body, a wrong format field is
 * flagged, not fatal). Lumps under 8 bytes are treated as headerless-empty.
 */
export function decodeDsLump(bytes: Uint8Array): DecodedSfx {
  const dv =
    bytes.byteLength >= 8
      ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
      : null;
  const format = dv !== null ? dv.getUint16(0, true) : 0;
  const rate = dv !== null ? dv.getUint16(2, true) : 0;
  const headerCount = dv !== null ? dv.getUint32(4, true) : 0;
  const bodyLen = Math.max(0, bytes.byteLength - DS_HEADER_BYTES);
  const samples = new Float32Array(bodyLen);
  for (let i = 0; i < bodyLen; i += 1) {
    samples[i] = (bytes[DS_HEADER_BYTES + i]! - 128) / 128;
  }
  return { rate, samples, format, headerCount, countMismatch: headerCount !== bodyLen };
}

/**
 * BufferSource.playbackRate for a decoded sound (M10-06's formula):
 * (source rate / output context rate) × (pitch / 128), vanilla NORM_PITCH
 * 128 = unity (s_sound.c:289/:323). The 1.10 counterpart is the fractional
 * pointer step from steptable[pitch] (i_sound.c:342-344/:495).
 */
export function playbackRateFor(decoded: DecodedSfx, contextRate: number, pitch = 128): number {
  return (decoded.rate / contextRate) * (pitch / 128);
}

/** Census of one pre-cache pass (the §0.10 lump audit surface). */
export interface SfxCacheCensus {
  /** Table ids with decoded data (includes link rows sharing data). */
  readonly decodedIds: readonly number[];
  /** Ids resolving to null (own DS lump absent AND unlinked) — silent. */
  readonly silentIds: readonly number[];
  /** rate → count over distinct decoded lumps (link rows counted once). */
  readonly rateHistogram: Readonly<Record<number, number>>;
  /** ids whose decode flagged headerCount ≠ body length. */
  readonly countMismatchIds: readonly number[];
  /** ids whose header format ≠ 3. */
  readonly formatOddIds: readonly number[];
}

interface CacheEntry {
  decoded: Map<number, DecodedSfx | null>;
  census: SfxCacheCensus | undefined;
}

// One cache per WAD mount; dies with the WadFile instance (WeakMap). Vanilla
// analogy: all DS data is "static" from I_InitSound on (i_sound.c:796-811).
const CACHE = new WeakMap<WadFile, CacheEntry>();

function entry(wad: WadFile): CacheEntry {
  let e = CACHE.get(wad);
  if (e === undefined) {
    e = { decoded: new Map(), census: undefined };
    CACHE.set(wad, e);
  }
  return e;
}

/**
 * The decoded sound for an sfx id, decoded at most once per WAD mount.
 * null = silent (missing lump, DS_MISSING_NAMES — never throws). Link rows
 * return the LINK's data (i_sound.c:803-810). `misses` counts resolutions
 * that found no lump (the driver's warn-once source of truth, M10-06).
 */
export function sfxDataById(wad: WadFile, id: number): DecodedSfx | null {
  const info = SFX_INFO[id];
  if (info === undefined) {
    throw new RangeError(`sfx id ${id} out of range [0, ${NUMSFX})`);
  }
  if (id === 0) {
    return null; // sfx_None dummy row (sounds.c:117)
  }
  const e = entry(wad);
  const hit = e.decoded.get(id);
  if (hit !== undefined) {
    return hit;
  }
  const sourceId = info.link ?? id; // chgun → pistol data (sounds.c:204)
  let resolved = e.decoded.get(sourceId);
  if (resolved === undefined) {
    resolved = wad.has(dsLumpName(sourceId))
      ? decodeDsLump(wad.readLumpByName(dsLumpName(sourceId)))
      : null;
    e.decoded.set(sourceId, resolved);
  }
  e.decoded.set(id, resolved);
  return resolved;
}

/** Name (table name or sfx_* token) → decoded sound; null silent/unknown id
 * handling identical to sfxDataById (unknown NAME throws RangeError). */
export function sfxDataByName(wad: WadFile, name: string): DecodedSfx | null {
  let bare = name.toLowerCase();
  if (bare.startsWith('sfx_')) {
    bare = bare.slice(4);
  }
  const id = SFX_INFO.findIndex((info) => info.name === bare);
  if (id < 0) {
    throw new RangeError(`unknown sfx name '${name}'`);
  }
  return sfxDataById(wad, id);
}

/**
 * Pre-cache EVERY sfx lump once (vanilla I_InitSound's boot loop,
 * i_sound.c:796-811) and return the lump-availability census. Idempotent and
 * cheap on an already-warm cache (all lookups hit the map).
 */
export function precacheSfx(wad: WadFile): SfxCacheCensus {
  const e = entry(wad);
  const decodedIds: number[] = [];
  const silentIds: number[] = [];
  const rateHistogram: Record<number, number> = {};
  const countMismatchIds: number[] = [];
  const formatOddIds: number[] = [];
  const seenLumps = new Set<number>();
  for (let id = 1; id < NUMSFX; id += 1) {
    const d = sfxDataById(wad, id);
    const sourceId = SFX_INFO[id]!.link ?? id;
    if (d === null) {
      silentIds.push(id);
    } else {
      decodedIds.push(id);
      if (!seenLumps.has(sourceId)) {
        seenLumps.add(sourceId);
        rateHistogram[d.rate] = (rateHistogram[d.rate] ?? 0) + 1;
        if (d.countMismatch) {
          countMismatchIds.push(id);
        }
        if (d.format !== DS_FORMAT_U8) {
          formatOddIds.push(id);
        }
      }
    }
  }
  e.census = { decodedIds, silentIds, rateHistogram, countMismatchIds, formatOddIds };
  return e.census;
}

/** The §0.10 static list, exported from sfxinfo for cache-level symmetry. */
export const MISSING_NAMES = DS_MISSING_NAMES;
