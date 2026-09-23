// audio/volumes.ts — the vanilla volume model (M10-01, M10-plan §M10-01 / §0.7).
//
// The model, per the plan's §0.7 measurement of linuxdoom-1.10:
//   * Menu thermometers are ints 0..15, default 8/8 (m_misc.c:237-238); the
//     sound engine's globals are 0..127 (s_sound.c:113/:116).
//   * D-10d: the 1.10 commented-out `* 8` multipliers are RESTORED —
//     (DOS-era 0..120 scale), applied through `S_SetSfxVolume`/
//     `S_SetMusicVolume` (s_sound.c:616-639), which validate 0..127. The
//     validation mirrors vanilla's I_Error as a THROWN RangeError — the sink
//     boundary (menu wiring, M10-09) catches; this module never calls
//     console/exit.
//   * Bus gain laws (the buses in context.ts are the only owners of live
//     volume state; this module computes the numbers):
//       sfxBus   = internal / 127            (linear — the `vol_lookup` law
//                                             is linear in `i`, i_sound.c:423)
//       musicBus = internal / 127 * MUSIC_TRIM
//     `MUSIC_TRIM` (default 0.5) is tuned in the M10-11 playtest.
//     Application goes through `setTargetAtTime` (anti-zipper, context.ts).
//   * `sfxVolumeForMixer()` exposes the SAME internal int the spatial math
//     uses as its `snd_SfxVolume` slot (plan §0.3) — one source of truth,
//     so the software mix and the live buses can never disagree.
//
// Zone rule (A-06): imports context.ts only (the bus seam). No sim, no ui.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { busSet, onContextBuilt, registerMusicGainSource } from './context';

/** Music bus trim constant (M10-11 playtest target; plan §M10-01 default). */
export const MUSIC_TRIM = 0.5;

/** Thermo default from m_misc.c:237-238 (both channels). */
export const THERMO_DEFAULT = 8;

/** Max engine volume (s_sound.c 0..127 validation ceiling). */
export const SOUNDBWIDTH = 127;

/** D-10d: DOS-era thermo→internal multiplier (restored `* 8`). */
export const THERMO_SCALE = 8;

const THERMO_MAX = 15;

function assertValidEngineVolume(v: number, label: string): void {
  // Mirrors s_sound.c:616-639 `if (volume < 0 || volume > 127) I_Error(...)`
  // as a thrown RangeError (caught at the sink boundary, plan acceptance 2).
  if (!Number.isInteger(v) || v < 0 || v > SOUNDBWIDTH) {
    throw new RangeError(`S_Set${label}Volume: volume ${v} outside 0..${SOUNDBWIDTH}`);
  }
}

let sfxInternal = THERMO_DEFAULT * THERMO_SCALE; // snd_SfxVolume, 0..120
let musicInternal = THERMO_DEFAULT * THERMO_SCALE; // snd_MusicVolume, 0..120

/** sfx bus gain law (linear; i_sound.c:423 vol_lookup linearity). */
export function sfxBusGain(): number {
  return sfxInternal / SOUNDBWIDTH;
}

/** music bus gain law: linear engine volume scaled by the trim constant. */
export function musicBusGain(): number {
  return (musicInternal / SOUNDBWIDTH) * MUSIC_TRIM;
}

function push(): void {
  busSet.setSfx(sfxBusGain());
  busSet.setMusic(musicBusGain());
}

/**
 * Register the volume→bus seams. Applied at module load (runtime consumers
 * need not call it); call again after `__resetAudioContext()` in tests — the
 * reset clears context's listener list, so re-registration never duplicates.
 */
export function bindVolumes(): void {
  // Keep a freshly built (or already built) graph at the current volumes, and
  // let context.resumeFromPause restore the exact law (not a stale value).
  onContextBuilt(() => push());
  registerMusicGainSource(musicBusGain);
}

bindVolumes();

/**
 * S_SetSfxVolume port (s_sound.c:629-639): engine-scale 0..127, RangeError
 * outside (the I_Error mirror).
 */
export function sSetSfxVolume(v: number): void {
  assertValidEngineVolume(v, 'SfxVolume');
  sfxInternal = v;
  push();
}

/** S_SetMusicVolume port (s_sound.c:616-627). */
export function sSetMusicVolume(v: number): void {
  assertValidEngineVolume(v, 'MusicVolume');
  musicInternal = v;
  push();
}

/** Menu thermo setter (m_menu.c:820-849): clamped 0..15, then the D-10d *8. */
export function setSfxThermo(thermo: number): void {
  let t = thermo;
  if (!Number.isFinite(t)) t = THERMO_DEFAULT;
  t = Math.trunc(t);
  if (t < 0) t = 0;
  if (t > THERMO_MAX) t = THERMO_MAX;
  sSetSfxVolume(t * THERMO_SCALE);
}

export function setMusicThermo(thermo: number): void {
  let t = thermo;
  if (!Number.isFinite(t)) t = THERMO_DEFAULT;
  t = Math.trunc(t);
  if (t < 0) t = 0;
  if (t > THERMO_MAX) t = THERMO_MAX;
  sSetMusicVolume(t * THERMO_SCALE);
}

/** Current thermo views (what the menu displays), internal/8. */
export function sfxThermo(): number {
  return sfxInternal / THERMO_SCALE;
}

export function musicThermo(): number {
  return musicInternal / THERMO_SCALE;
}

/** The internal engine ints (snd_SfxVolume / snd_MusicVolume mirrors). */
export function sfxVolumeInternal(): number {
  return sfxInternal;
}

export function musicVolumeInternal(): number {
  return musicInternal;
}

/**
 * The §0.3 `snd_SfxVolume` slot for the mixer's spatial math (M10-05):
 * the SAME internal int, never a second source of truth.
 */
export function sfxVolumeForMixer(): number {
  return sfxInternal;
}

/** Restore the m_misc defaults (tests / boot before cfg read; no cfg in M10). */
export function resetVolumesToDefaults(): void {
  sfxInternal = THERMO_DEFAULT * THERMO_SCALE;
  musicInternal = THERMO_DEFAULT * THERMO_SCALE;
  push();
}
