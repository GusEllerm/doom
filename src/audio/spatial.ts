// audio/spatial.ts — S_AdjustSoundParams, the 1.10 audibility math
// (s_sound.c:752-818) ported VERBATIM (M10-05, plan §0.3 / §M10-05).
//
// The four source truths, each line-cited at its use below:
//  * distance — GG1 approx-euclidean `adx + ady - min(adx,ady)>>1` on x/y
//    ONLY, no z term (s_sound.c:765-771); a source z stays informational.
//  * clipping — `gamemap != 8 && dist > S_CLIPPING_DIST(1200*FRACUNIT)` ⇒
//    inaudible (s_sound.c:55/:773-777).
//  * falloff — s_sound.c:796-815, mirror-pinned constants (plan §0.3 CORRECTS
//    R10's Chocolate 200/1000 quote): S_CLOSE_DIST = 160*FRACUNIT (:61),
//    S_ATTENUATOR = (1200-160)>>FRACBITS = 1040 (:64).
//      dist < 160            ⇒ vol = snd_SfxVolume                       :796-799
//      gamemap == 8          ⇒ vol = 15 + (snd-15)*(CLIP-dist>>16)/1040  :800-808
//                               (dist clamped to CLIP, NO clip-out)
//      else                  ⇒ vol = snd*(CLIP-dist>>16)/1040            :810-813
//    Audibility = vol > 0 (:817). C's int division truncates toward zero —
//    Math.trunc below, matching.
//  * panning — EXISTS in 1.10 (plan §0.3; the "no-panning" brief premise is
//    false): delta = R_PointToAngle2(source→listener) − listener.angle with
//    the verbatim C branch (`angle + (0xffffffff − listener->angle)` — note
//    the −1 quirk of s_sound.c:786, kept), sep = 128 − (FixedMul(
//    S_STEREO_SWING=96*FRACUNIT, finesine[delta>>ANGLETOFINESHIFT])>>FRACBITS)
//    (:793, S_STEREO_SWING :74). sep range measured 31..225; the L/R split
//    itself is the addsfx quadratic in mixerCore.ts (i_sound.c:350-373) — NO
//    StereoPannerNode anywhere (mechanical grep test in mixerCore.test.ts).
//
// Panning is NOT a WebAudio panner here: this module is pure int/float math;
// the browser driver (M10-06) mirrors the exact same split through GainNodes.
//
// R_PointToAngle2 (s_sound.c calls r_main.c:314-372): locally re-derived from
// the SAME gold-verified fine tables (core/tables.ts), octants byte-identical
// to the sim port src/sim/pslide.ts pointToAngleOrigin (which is itself
// R_PointToAngle on the delta, per p_shoot.ts rPointToAngle2) — the audio zone
// imports no sim runtime, only the pure tables (A-06).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import {
  ANG180,
  ANG270,
  ANG90,
  FRACBITS,
  FRACUNIT,
} from '../core/constants';
import { angAdd, angSub, FixedMul } from '../core/fixed';
import { finesine, SlopeDiv, tantoangle } from '../core/tables';

/** s_sound.c:55 — `#define S_CLIPPING_DIST (1200*0x10000)`. */
export const S_CLIPPING_DIST = 1200 * FRACUNIT;
/** s_sound.c:61 — `#define S_CLOSE_DIST (160*0x10000)` (mirror truth, §0.3). */
export const S_CLOSE_DIST = 160 * FRACUNIT;
/** s_sound.c:64 — `((S_CLIPPING_DIST-S_CLOSE_DIST)>>FRACBITS)` = 1040. */
export const S_ATTENUATOR = (S_CLIPPING_DIST - S_CLOSE_DIST) >>> FRACBITS;
/** s_sound.c:74 — `#define S_STEREO_SWING (96*0x10000)`. */
export const S_STEREO_SWING = 96 * FRACUNIT;
/** s_sound.c:71 — NORM_SEP (center); the mixer's local default sep. */
export const NORM_SEP = 128;

/** Listener/source pose. x/y fixed_t; angle u32 BAM (listener only). */
export interface SpatialPose {
  readonly x: number;
  readonly y: number;
  /** angle_t (u32); sources carry none (unused), default 0 = due east. */
  readonly angle?: number;
}

/** Audible result: the modified `*vol` / `*sep` out-params (pitch untouched —
 * s_sound.c:752's `*pitch` is never written by the body). */
export interface AdjustResult {
  readonly vol: number;
  readonly sep: number;
}

/**
 * R_PointToAngle2 (r_main.c:314-372 octants, identical to the pslide.ts
 * pointToAngleOrigin of the delta — p_shoot.ts:539-541 form): the angle from
 * (x1,y1) toward (x2,y2) in BAM u32.
 */
export function sPointToAngle2(x1: number, y1: number, x2: number, y2: number): number {
  const x = (x2 - x1) | 0;
  const y = (y2 - y1) | 0;
  if (x === 0 && y === 0) return 0; // r_main.c:343-345

  if (x >= 0) {
    if (y >= 0) {
      if (x > y) return tantoangle[SlopeDiv(y, x)]!; // octant 0
      return angSub(angSub(ANG90, 1), tantoangle[SlopeDiv(x, y)]!); // octant 1
    }
    const ny = -y;
    if (x > ny) return angSub(0, tantoangle[SlopeDiv(ny, x)]!); // octant 8
    return angAdd(ANG270, tantoangle[SlopeDiv(x, ny)]!); // octant 7
  }
  const nx = -x;
  if (y >= 0) {
    if (nx > y) return angSub(angSub(ANG180, 1), tantoangle[SlopeDiv(y, nx)]!); // octant 3
    return angAdd(ANG90, tantoangle[SlopeDiv(nx, y)]!); // octant 2
  }
  const ny = -y;
  if (nx > ny) return angAdd(ANG180, tantoangle[SlopeDiv(ny, nx)]!); // octant 4
  return angSub(angSub(ANG270, 1), tantoangle[SlopeDiv(nx, ny)]!); // octant 5
}

/** GG1 approx-euclidean fixed distance over the abs deltas — s_sound.c:767-771
 * (`adx + ady - ((adx < ady ? adx : ady)>>1)`), x/y only, NO z term. */
export function sApproxDistance(adx: number, ady: number): number {
  return adx + ady - ((adx < ady ? adx : ady) >> 1);
}

/**
 * S_AdjustSoundParams (s_sound.c:752-818). `vol` mirrors the C in/out param —
 * the 1.10 BODY never reads it (both branches derive from sndSfxVolume, the
 * input value is dead; kept in the signature for the plan §M10-05 shape),
 * `gamemap` selects the E1M8 special case. Returns the modified {vol, sep},
 * or null when INAUDIBLE (C `return 0` — clip-out on non-map8, :773-777, or
 * `*vol <= 0`, :817).
 */
export function sAdjustSoundParams(
  listener: SpatialPose,
  source: SpatialPose,
  vol: number,
  sndSfxVolume: number,
  gamemap: number,
): AdjustResult | null {
  void vol; // dead in the 1.10 body (see docstring)
  const adx = Math.abs(((listener.x | 0) - (source.x | 0)) | 0); // :767
  const ady = Math.abs(((listener.y | 0) - (source.y | 0)) | 0); // :768
  const dist = sApproxDistance(adx, ady); // :771

  if (gamemap !== 8 && dist > S_CLIPPING_DIST) return null; // :773-777

  // angle of source to listener — :780-788, verbatim branch INCLUDING the
  // (0xffffffff − listener.angle) wraparound quirk (a −1 mod 2^32; kept).
  const angle = sPointToAngle2(listener.x, listener.y, source.x, source.y);
  const la = (listener.angle ?? 0) >>> 0;
  const delta =
    angle > la ? (angle - la) >>> 0 : (angle + (0xffffffff - la)) >>> 0;
  const fine = delta >>> 19; // :788 ANGLETOFINESHIFT

  // stereo separation — :793
  const sep = 128 - ((FixedMul(S_STEREO_SWING, finesine[fine]!) >> FRACBITS) | 0);

  // volume calculation — :796-815
  let out: number;
  if (dist < S_CLOSE_DIST) {
    out = sndSfxVolume; // :796-799
  } else if (gamemap === 8) {
    let d = dist; // :800-808 (clamped; never clip-out)
    if (d > S_CLIPPING_DIST) d = S_CLIPPING_DIST;
    out =
      15 +
      Math.trunc(
        ((sndSfxVolume - 15) * ((S_CLIPPING_DIST - d) >>> FRACBITS)) /
          S_ATTENUATOR,
      );
  } else {
    out = Math.trunc(
      (sndSfxVolume * ((S_CLIPPING_DIST - dist) >>> FRACBITS)) / S_ATTENUATOR,
    ); // :810-813
  }

  return out > 0 ? { vol: out, sep } : null; // :817 `return (*vol > 0)`
}
