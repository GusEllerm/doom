// audio/spatial.test.ts — S_AdjustSoundParams port goldens (M10-05, plan
// §M10-05 acceptance #1: "distance→vol exact at 0/159/160/680/1199/1200
// (both formulae + map8), sep exact at angle 0/90/180/270 (finesine values
// pinned)"). Constants pinned to the MIRROR (plan §0.3 corrects R10's
// Chocolate 200/1000 quote: linuxdoom-1.10 is 160/1040).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { finesine } from '../core/tables';
import {
  NORM_SEP,
  sAdjustSoundParams,
  S_ATTENUATOR,
  S_CLIPPING_DIST,
  S_CLOSE_DIST,
  sApproxDistance,
  sPointToAngle2,
  S_STEREO_SWING,
} from './spatial';

const FU = 65536; // FRACUNIT

describe('constants (s_sound.c mirror pins)', () => {
  it('clip/close/attenuator/swing match s_sound.c:55/:61/:64/:74', () => {
    expect(S_CLIPPING_DIST).toBe(1200 * FU);
    expect(S_CLOSE_DIST).toBe(160 * FU); // plan §0.3: MIRROR truth, not 200
    expect(S_ATTENUATOR).toBe(1040); // (1200-160)>>FRACBITS
    expect(S_STEREO_SWING).toBe(96 * FU);
    expect(NORM_SEP).toBe(128);
  });

  it('finesine table entries at the quarter angles are pinned (tables.ts)', () => {
    expect(finesine[0]).toBe(25);
    expect(finesine[2048]).toBe(65535);
    expect(finesine[4096]).toBe(-25);
    expect(finesine[6144]).toBe(-65535);
  });
});

describe('sApproxDistance (GG1, s_sound.c:767-771)', () => {
  it('is |dx| on an axis and 1.5x on a diagonal', () => {
    expect(sApproxDistance(800 * FU, 0)).toBe(800 * FU);
    expect(sApproxDistance(0, 800 * FU)).toBe(800 * FU);
    expect(sApproxDistance(800 * FU, 800 * FU)).toBe(1200 * FU); // 2−½
  });
});

describe('sAdjustSoundParams — distance→vol table (plan §0.3)', () => {
  // sndSfxVolume = 64 (thermo 8 ×8, D-10d), gamemap 1: the linear ramp
  // vol = 64*(1200−dist)/1040 below CLOSE 160 ⇒ full; map8 = 15 +
  // 49*(1200−dist)/1040 with NO clip-out (s_sound.c:800-808).
  const l = { x: 0, y: 0 };
  const at = (d: number): number => d * FU;

  it('non-map8 exact points: 0/159/160/680 inaudible-from-1199', () => {
    expect(sAdjustSoundParams(l, { x: at(0), y: 0 }, 64, 64, 1)?.vol).toBe(64); // :796-799
    expect(sAdjustSoundParams(l, { x: at(159), y: 0 }, 64, 64, 1)?.vol).toBe(64); // < CLOSE
    expect(sAdjustSoundParams(l, { x: at(160), y: 0 }, 64, 64, 1)?.vol).toBe(64); // 64*1040/1040
    expect(sAdjustSoundParams(l, { x: at(680), y: 0 }, 64, 64, 1)?.vol).toBe(32); // 64*520/1040
    expect(sAdjustSoundParams(l, { x: at(1199), y: 0 }, 64, 64, 1)).toBeNull(); // 64/1040→0, :817
    expect(sAdjustSoundParams(l, { x: at(1200), y: 0 }, 64, 64, 1)).toBeNull(); // vol 0
    expect(sAdjustSoundParams(l, { x: at(1201), y: 0 }, 64, 64, 1)).toBeNull(); // clip :773-777
  });

  it('map8 branch: 15-floor, clamp at CLIP, never clip-out', () => {
    expect(sAdjustSoundParams(l, { x: at(0), y: 0 }, 64, 64, 8)?.vol).toBe(64); // < CLOSE
    expect(sAdjustSoundParams(l, { x: at(160), y: 0 }, 64, 64, 8)?.vol).toBe(64); // 15+49
    expect(sAdjustSoundParams(l, { x: at(680), y: 0 }, 64, 64, 8)?.vol).toBe(39); // 15+24
    expect(sAdjustSoundParams(l, { x: at(1199), y: 0 }, 64, 64, 8)?.vol).toBe(15); // 15+0
    expect(sAdjustSoundParams(l, { x: at(1200), y: 0 }, 64, 64, 8)?.vol).toBe(15);
    expect(sAdjustSoundParams(l, { x: at(1500), y: 0 }, 64, 64, 8)?.vol).toBe(15); // clamped
    expect(sAdjustSoundParams(l, { x: at(1200), y: 0 }, 120, 120, 8)?.vol).toBe(15);
  });

  it('the 1.10 raw-thermo near-silence quirk (plan §0.7): snd 8 at 680 ⇒ 4', () => {
    expect(sAdjustSoundParams(l, { x: at(680), y: 0 }, 8, 8, 1)?.vol).toBe(4);
  });

  it('diagonal GG1 distance lands exactly on CLIP ⇒ inaudible (vol 0)', () => {
    expect(sAdjustSoundParams(l, { x: at(800), y: at(800) }, 64, 64, 1)).toBeNull();
  });
});

describe('sAdjustSoundParams — sep table (s_sound.c:780-793)', () => {
  // Listener at origin facing EAST (angle 0). The s_sound.c:786 branch quirk
  // (`angle + (0xffffffff − listener->angle)` when the angles are NOT
  // strictly greater) makes an exactly-forward source delta = −1 ⇒ fine
  // index 8191, sep 129 — transcribed, not fixed.
  const L = { x: 0, y: 0, angle: 0 };
  const D = 50 * FU;

  it('forward(0°)→129 (the −1 wrap quirk), 90°→33, 180°→128, 270°→224', () => {
    expect(sAdjustSoundParams(L, { x: D, y: 0 }, 64, 64, 1)?.sep).toBe(129); // fine 8191
    expect(sAdjustSoundParams(L, { x: 0, y: D }, 64, 64, 1)?.sep).toBe(33); // fine 2048 (left)
    expect(sAdjustSoundParams(L, { x: -D, y: 0 }, 64, 64, 1)?.sep).toBe(128); // fine 4095
    expect(sAdjustSoundParams(L, { x: 0, y: -D }, 64, 64, 1)?.sep).toBe(224); // fine 6144 (right)
  });

  it('sep follows the listener ANGLE too: same world geometry, facing north', () => {
    // Listener facing north (ANG90): the northern source is now directly
    // ahead ⇒ the 129 quirk; the eastern source is now on the RIGHT (224).
    const LN = { x: 0, y: 0, angle: 0x40000000 };
    expect(sAdjustSoundParams(LN, { x: 0, y: D }, 64, 64, 1)?.sep).toBe(129);
    expect(sAdjustSoundParams(LN, { x: D, y: 0 }, 64, 64, 1)?.sep).toBe(224);
  });

  it('sPointToAngle2 reproduces the octant corners (r_main tan-table −1 quirks)', () => {
    expect(sPointToAngle2(0, 0, D, 0)).toBe(0); // octant 0
    expect(sPointToAngle2(0, 0, 0, D)).toBe(0x3fffffff); // octant 1: ANG90−1
    expect(sPointToAngle2(0, 0, -D, 0)).toBe(0x7fffffff); // octant 3: ANG180−1
    expect(sPointToAngle2(0, 0, 0, -D)).toBe(0xc0000000); // octant 7: exact ANG270
    expect(sPointToAngle2(100 * FU, 20 * FU, 100 * FU, 20 * FU)).toBe(0); // zero delta
  });
});

describe('zone/mechanical guards', () => {
  it('the CODE (comments stripped) contains no StereoPanner anywhere', () => {
    const strip = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    for (const f of ['./spatial.ts', './mixerCore.ts']) {
      const src = strip(readFileSync(new URL(f, import.meta.url), 'utf8'));
      expect(src).not.toMatch(/StereoPanner|createStereoPanner/i);
    }
  });
});

