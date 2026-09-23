// audio/wiring.ts — M10-09: the audio composer (M10-plan §M10-09).
//
// The SINGLE registration point between the ui/menu volume state, the
// volumes.ts law (M10-01), the context buses (M10-01), and the live event
// seams (hooks.ts, M10-04). Nothing here constructs sound: the buses and the
// volume law own the numbers; the drivers (M10-06 sfx / M10-08 music, their
// own files) plug in through the consumer seams below.
//
// Vanilla truth being wired (plan §0.7):
//   * Menu thermos 0..15, defaults 8/8 (m_misc.c:237-238) live in menu.ts
//     (its mSfxVol/mMusicVol rows, m_menu.c:820-849 — BOTH real routines in
//     1.10, alphaKeys 's'/'m'; the `m_musicvol` no-op premise is FALSE).
//     The engine globals start at 15 (s_sound.c:113/:116) but the m_misc
//     defaults override BOTH to 8 at load (m_misc.c:830/:847).
//   * The D-10d `* 8` restore lives in volumes.ts (thermo → 0..127 internal,
//     s_sound.c:616-639 validation); THIS module only mirrors the menu's
//     state into it (menu.ts is read-only input: menuState.sndVolumes()).
//
// Zone rule (A-06): imports volumes/context (audio), hooks (sim seam,
// read/registration only) and ui/menu's DEBUG-state READ (the plan names
// menu.sndVolumes as the input; menu.ts is never imported for mutation).
// Zero platform globals at import time: gesture/pump attaches are explicit
// (installAudioWiring), context.ts stays lazy/absent-safe.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { LiveMusicFn, LiveSfxFn } from '../sim/hooks';
import { registerLiveMusic, registerLiveSfx } from '../sim/hooks';
import { menuState } from '../ui/menu';
import { ensureContext, platformState, testMuted } from './context';
import {
  musicBusGain,
  musicThermo,
  setMusicThermo,
  setSfxThermo,
  sfxBusGain,
  sfxThermo,
  sfxVolumeInternal,
  musicVolumeInternal,
} from './volumes';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** The music lifecycle view (owner: M10-08 musicSelect via registerAudioCensus). */
export interface AudioCensusMusic {
  lump: string | null;
  playing: boolean;
  paused: boolean;
}

/** Driver-supplied census (voices/missing-lumps/music live in M10-06/08 files). */
export interface AudioCensus {
  activeVoices: number;
  missingLumps: number;
  music: AudioCensusMusic;
}

/** The debug.ts `state().audio` read shape (plan §M10-09 acceptance 3). */
export interface AudioWiringRead extends AudioCensus {
  /** Menu thermos (what the sound menu draws), 0..15 (m_misc.c:237-238). */
  sfxVolume: number;
  musicVolume: number;
  /** Engine ints (D-10d `* 8`), 0..127 (s_sound.c:616-639). */
  sfxInternal: number;
  musicInternal: number;
  /** Live bus gains (volumes.ts laws). */
  sfxBusGain: number;
  musicBusGain: number;
  /** context.ts lifecycle census. */
  context: 'absent' | 'unbuilt' | 'suspended' | 'running';
  /** setTestMute flag (silent e2e boots). */
  muted: boolean;
  /** True once installAudioWiring ran (gesture gate + pump attached). */
  wired: boolean;
}

/** Volume mirror: called with the engine ints whenever they change
 * (mixerCore.setVolume is the intended consumer — s_sound.c's single
 * snd_SfxVolume is read by the spatial math EVERY tic, :539-541). */
export type VolumeMirrorFn = (sfxInternal: number, musicInternal: number) => void;

/** Gesture host seam (browser: window; tests: a fake). */
export interface GestureTarget {
  addEventListener(
    type: string,
    fn: () => void,
    opts?: { once?: boolean },
  ): void;
  removeEventListener?(type: string, fn: () => void): void;
}

export interface AudioWiringOptions {
  /** Attach first-gesture ⇒ ensureContext (autoplay unlock, D005-class).
   * true (default) = window when present; object = injected host;
   * false = never attach (tests manage the context directly). */
  gestures?: boolean | GestureTarget;
  /** Menu-volume pump driver: 'raf' (default when requestAnimationFrame
   * exists — vanilla polls M_Ticker per frame; we poll the read-only menu
   * state the same cadence), 'manual' = only pumpAudioWiring()/state reads
   * move the volumes (headless/vitest). */
  pump?: 'raf' | 'manual';
}

/* ------------------------------------------------------------------ */
/* Module state                                                        */
/* ------------------------------------------------------------------ */

let installed = false;
let lastApplied: [number, number] | null = null;
let pumpMode: 'raf' | 'manual' = 'manual';
let rafHandle = 0;

const sfxConsumers = new Set<LiveSfxFn>();
const musicConsumers = new Set<LiveMusicFn>();
const volumeMirrors = new Set<VolumeMirrorFn>();
let census: (() => Partial<AudioCensus>) | null = null;

function defaultGestureTarget(): GestureTarget | null {
  const g = globalThis as {
    window?: { addEventListener(t: string, f: () => void, o?: { once?: boolean }): void };
  };
  return g.window ?? null;
}

function raf(): ((cb: () => void) => number) | null {
  const g = globalThis as { requestAnimationFrame?: (cb: () => void) => number };
  return typeof g.requestAnimationFrame === 'function' ? g.requestAnimationFrame : null;
}

/* ------------------------------------------------------------------ */
/* Live-event fan-out (the single composer, plan §M10-09)              */
/* ------------------------------------------------------------------ */

const dispatchSfx: LiveSfxFn = (sfx, origin, x, y, z, tic) => {
  for (const fn of sfxConsumers) fn(sfx, origin, x, y, z, tic);
};

const dispatchMusic: LiveMusicFn = (kind, loop, tic) => {
  for (const fn of musicConsumers) fn(kind, loop, tic);
};

/**
 * Add (or with null, remove) a live SFX consumer. The wiring owns the ONE
 * hooks.registerLiveSfx registration (composer role): direct registerLiveSfx
 * calls from drivers would REPLACE the dispatcher — drivers must register
 * here instead (wave-4 integration note).
 */
export function registerWiringSfxConsumer(fn: LiveSfxFn | null): void {
  if (fn === null) sfxConsumers.clear();
  else sfxConsumers.add(fn);
}

/** Add (or with null, remove) a live music consumer (M10-08's seam). */
export function registerWiringMusicConsumer(fn: LiveMusicFn | null): void {
  if (fn === null) musicConsumers.clear();
  else musicConsumers.add(fn);
}

/** Add (or with null, remove) a volume mirror (mixerCore.setVolume). */
export function registerVolumeMirror(fn: VolumeMirrorFn | null): void {
  if (fn === null) volumeMirrors.clear();
  else volumeMirrors.add(fn);
}

/** Register the driver census provider (M10-06/08 voices/missing/music). */
export function registerAudioCensus(fn: (() => Partial<AudioCensus>) | null): void {
  census = fn;
}

/* ------------------------------------------------------------------ */
/* Volume plumbing: menu thermos → volumes.ts → buses + mirrors        */
/* ------------------------------------------------------------------ */

/**
 * Read the menu's 0..15 thermos (menuState.sndVolumes — the plan's stated
 * input) and, on any change, push them through volumes.ts (D-10d `* 8`,
 * sSet*Volume validation, bus gains) and every volume mirror. Returns true
 * when anything moved. The menu's values ARE the truth (m_menu.c semantics:
 * the thermos rows are the only writers while sound options are live);
 * persistence across reload is M11 (A-10) — session-only by plan.
 */
export function pumpAudioWiring(): boolean {
  const [sfxThermoNow, musicThermoNow] = menuState.sndVolumes();
  if (
    lastApplied !== null &&
    lastApplied[0] === sfxThermoNow &&
    lastApplied[1] === musicThermoNow
  ) {
    return false;
  }
  lastApplied = [sfxThermoNow, musicThermoNow];
  setSfxThermo(sfxThermoNow);
  setMusicThermo(musicThermoNow);
  const sfxInt = sfxVolumeInternal();
  const musicInt = musicVolumeInternal();
  for (const fn of volumeMirrors) fn(sfxInt, musicInt);
  return true;
}

function pumpLoop(): void {
  pumpAudioWiring();
  if (pumpMode === 'raf' && installed) {
    const r = raf();
    if (r !== null) rafHandle = r(pumpLoop);
  }
}

/* ------------------------------------------------------------------ */
/* Gesture gate (first key/click ⇒ ensureContext, D005-class)          */
/* ------------------------------------------------------------------ */

function gesture(): void {
  ensureContext();
}

function attachGestures(target: GestureTarget | null): void {
  if (target === null) return;
  // once:true per channel — ensureContext is idempotent afterwards and the
  // listeners must not accumulate per key.
  target.addEventListener('pointerdown', gesture, { once: true });
  target.addEventListener('keydown', gesture, { once: true });
}

/* ------------------------------------------------------------------ */
/* Install / reset                                                     */
/* ------------------------------------------------------------------ */

/** Idempotent install (main.ts's M10-06 installAudio site is the production
 * call point; debug.ts installs it for dev/test boots until then). */
export function installAudioWiring(options: AudioWiringOptions = {}): void {
  const gestures = options.gestures ?? true;
  const target =
    gestures === false ? null : gestures === true ? defaultGestureTarget() : gestures;

  if (!installed) {
    installed = true;
    registerLiveSfx(dispatchSfx);
    registerLiveMusic(dispatchMusic);
  }
  if (target !== null) attachGestures(target);
  if (options.pump !== undefined) pumpMode = options.pump;
  if (pumpMode === 'raf' && rafHandle === 0) {
    const r = raf();
    if (r !== null) rafHandle = r(pumpLoop);
  }
  pumpAudioWiring();
}

export function audioWiringInstalled(): boolean {
  return installed;
}

/** Test seam: full detach of the wiring layer (volume state untouched —
 * volumes.resetVolumesToDefaults owns that). */
export function __resetAudioWiring(): void {
  const g = globalThis as { cancelAnimationFrame?: (h: number) => void };
  if (rafHandle !== 0 && typeof g.cancelAnimationFrame === 'function') {
    g.cancelAnimationFrame(rafHandle);
  }
  rafHandle = 0;
  installed = false;
  pumpMode = 'manual';
  lastApplied = null;
  sfxConsumers.clear();
  musicConsumers.clear();
  volumeMirrors.clear();
  census = null;
  registerLiveSfx(null);
  registerLiveMusic(null);
}

/* ------------------------------------------------------------------ */
/* Debug read-view (state().audio, debug.ts seam)                      */
/* ------------------------------------------------------------------ */

const EMPTY_CENSUS: AudioCensus = {
  activeVoices: 0,
  missingLumps: 0,
  music: { lump: null, playing: false, paused: false },
};

/** Live audio snapshot; pumps the menu thermos first so a debug read ALWAYS
 * reflects the on-screen slider (L4 observability without a tic pump).
 * Never throws, never logs (plan acceptance 4), no-wad safe. */
export function audioWiringState(): AudioWiringRead {
  pumpAudioWiring();
  const partial = census !== null ? census() : {};
  return {
    sfxVolume: sfxThermo(),
    musicVolume: musicThermo(),
    sfxInternal: sfxVolumeInternal(),
    musicInternal: musicVolumeInternal(),
    sfxBusGain: sfxBusGain(),
    musicBusGain: musicBusGain(),
    context: platformState(),
    muted: testMuted(),
    wired: installed,
    activeVoices: partial.activeVoices ?? EMPTY_CENSUS.activeVoices,
    missingLumps: partial.missingLumps ?? EMPTY_CENSUS.missingLumps,
    music: { ...EMPTY_CENSUS.music, ...(partial.music ?? {}) },
  };
}
