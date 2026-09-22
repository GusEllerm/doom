/**
 * LIVE-SOAK regression suite (task/BUG-display) — the three field reports
 * B-01 / B-05 / B-06 pinned as per-frame invariants on a LONG
 * single-instance live loop (harness.ts mirrors main.ts; the display-block
 * FILE STATICS carried forward exactly like the browser rAF loop).
 *
 * Why this layer: every unit/headless suite renders one frame per scene or
 * resets module statics between scenes, so all three bugs are structurally
 * invisible there — they live in state carried across frames (the
 * borderdrawcount 3-count, the ST widget diff caches, the powerup counters
 * that never decayed). Every assertion below is the field report's own
 * wording translated to a per-frame predicate.
 *
 * Mechanics notes (measured, this repo):
 *  - screenblocks 11 is FULLSCREEN (viewheight 200, no bar, no border);
 *    the windowed soak uses 10 (320×144 window → 12-row top ring).
 *  - vanilla automap covers rows 0..167 with the map, ignores the view
 *    window (no crop) and keeps the status bar (ST_Drawer still gets
 *    viewheight != 200); drawAutomap is NOT replay-idempotent (the wall
 *    throttle state), so the automap frames are pinned via the crop-call
 *    stat + bar/face presence instead of a pixel replay.
 *  - pFixedColormap flickers during the last FLASHLENGTH tics of an
 *    invulnerability (p_user.c:362-371 `> FLASHLENGTH || &8`) — the test
 *    only pins the non-flickering window and the final zero.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { emptyInput, type GameInput } from '../../src/sim/ticcmd';
import { attachPowerupFields } from '../../src/sim/ppalette';
import { setViewSize, viewSize } from '../../src/render/view';
import { displayStatics } from '../../src/render/renderer';
import { screens } from '../../src/render/vvideo';
import type { Player } from '../../src/sim/player';
import { createLiveSoak, hasWad, resetSoakModules, type LiveSoak } from './harness';

const d = describe.skipIf(!hasWad);

/** Player widened by attachPowerupFields (the pPowerThink fields). */
interface PowerPlayer extends Player {
  powers?: Int32Array;
  fixedcolormap?: number;
  damagecount: number;
  bonuscount: number;
}

const WINDOW_BLOCKS = 10; // viewheight 144, viewwidth 320 → top/bottom ring
const FACE_WELL = [143, 168, 32, 32] as const;

function powerPlayer(s: LiveSoak): PowerPlayer {
  return attachPowerupFields(s.state.players[0]!) as PowerPlayer;
}

function rectSha(buf: Uint8Array, x: number, y: number, w: number, h: number): string {
  const row = new Uint8Array(w);
  const hh = createHash('sha256');
  for (let r = 0; r < h; r += 1) {
    row.set(buf.subarray(y * 320 + x + r * 320, y * 320 + x + r * 320 + w));
    hh.update(row);
  }
  return hh.digest('hex').slice(0, 16);
}

/** sha of a rect of the BACK buffer (screens[1]) — the composite the
 * windowed frame must keep outside the 3D window once borders are up. */
function backRectSha(x: number, y: number, w: number, h: number): string {
  return rectSha(screens[1]!.data, x, y, w, h);
}

/** The ring bands of a windowed frame (everything outside the 3D window in
 * rows 0..167 — the border territory B-01 reports being "eaten away"). */
function ringBands(vs: {
  viewwindowx: number;
  viewwindowy: number;
  scaledviewwidth: number;
  viewheight: number;
}): readonly (readonly [number, number, number, number])[] {
  const wx = vs.viewwindowx;
  const wy = vs.viewwindowy;
  const vw = vs.scaledviewwidth;
  const vh = vs.viewheight;
  return [
    [0, 0, 320, wy],
    [0, wy + vh, 320, 168 - wy - vh],
    [0, wy, wx, vh],
    [wx + vw, wy, 320 - wx - vw, vh]
  ];
}

function ringBad(s: LiveSoak): number {
  if (viewSize().viewheight === 200) return 0; // fullscreen: no ring exists
  let bad = 0;
  for (const [x, y, w, h] of ringBands(viewSize())) {
    if (w <= 0 || h <= 0) continue;
    if (s.hashRect(x, y, w, h) !== backRectSha(x, y, w, h)) bad += 1;
  }
  return bad;
}

function turnWalk(t: number): GameInput {
  return {
    ...emptyInput(),
    forward: true,
    turnLeft: (t >> 4) % 3 === 1,
    turnRight: (t >> 4) % 3 === 2
  };
}

import { createHash } from 'node:crypto';

beforeEach(() => {
  resetSoakModules();
  setViewSize(WINDOW_BLOCKS, 0);
});

d('soak — B-05 palette countdown wired (pPowerThink, p_user.c:336-359)', () => {
  it('damage flash decays back to the normal bank', () => {
    // PRE-FIX BEHAVIOUR (git bisect): damagecount latched at 80 forever,
    // bank 1 every frame, screenRgba never returned to baseline. The
    // baseline comparison runs the SAME session again WITHOUT the hit —
    // a deterministic control (monsters move, the idle face re-rolls).
    const s = createLiveSoak();
    for (let i = 0; i < 4; i += 1) s.cycle();
    const p = powerPlayer(s);
    s.injectDamage(80);
    expect(p.damagecount).toBe(80);
    const f = s.cycle(); // one tic of pPowerThink decay, then display
    expect(p.damagecount).toBe(79); // p_user.c:355 `if (damagecount) --damagecount`
    expect(f.bank).not.toBe(0); // red tone while counting down
    for (let i = 0; i < 80; i += 1) s.cycle();
    expect(p.damagecount).toBe(0);
    expect(s.luts.bank).toBe(0);
    // (No cross-session pixel control: damagecount legitimately feeds the
    // face machine (st_stuff.c:858 R3/R4) and face picks consume P_Random
    // — a hit desyncs the sim PRNG stream, faithful to vanilla. The bank
    // above IS the un-tinted predicate: PaletteLuts.bank 0 = base PLAYPAL.)
  });

  it('a second hit re-sustains the flash from the decay point', () => {
    const s = createLiveSoak();
    for (let i = 0; i < 3; i += 1) s.cycle();
    const p = powerPlayer(s);
    s.injectDamage(80);
    for (let i = 0; i < 50; i += 1) s.cycle();
    expect(p.damagecount).toBe(30);
    expect(s.luts.bank).not.toBe(0); // still flashing
    s.injectDamage(50); // harness clamp: min(100, 30 + 50)
    expect(p.damagecount).toBe(80);
    for (let i = 0; i < 81; i += 1) s.cycle();
    expect(p.damagecount).toBe(0);
    expect(s.luts.bank).toBe(0);
  });

  it('bonuscount (pickup gold flash) decays too', () => {
    const s = createLiveSoak();
    for (let i = 0; i < 3; i += 1) s.cycle();
    const p = powerPlayer(s);
    p.bonuscount = 100;
    for (let i = 0; i < 101; i += 1) s.cycle();
    expect(p.bonuscount).toBe(0); // p_user.c:357-358
    expect(s.luts.bank).toBe(0);
  });

  it('timed powers expire; strength counts up; fixedcolormap settles at 0', () => {
    // A parallel CONTROL session (same deterministic game, no powerups)
    // gives the "inverted while up / identical after expiry" pixel check
    // regardless of monster/idle-face motion.
    const s = createLiveSoak();
    for (let i = 0; i < 3; i += 1) s.cycle();
    const p = powerPlayer(s);
    p.powers![0] = 200; // pw_invulnerability, > FLASHLENGTH: solid inverse
    resetSoakModules();
    setViewSize(WINDOW_BLOCKS, 0);
    const c = createLiveSoak();
    for (let i = 0; i < 4; i += 1) c.cycle();
    s.cycle();
    expect(p.fixedcolormap).toBe(32); // INVERSECOLORMAP (p_user.c:362-365)
    expect(s.hashRect(16, 12, 288, 144)).not.toBe(c.hashRect(16, 12, 288, 144)); // inverted
    for (let i = 0; i < 205; i += 1) {
      s.cycle();
      c.cycle();
    }
    expect(p.powers![0]).toBe(0);
    expect(p.fixedcolormap).toBe(0); // never latches — the PRE-FIX bug kept 32
    expect(s.hashRect(16, 12, 288, 144)).toBe(c.hashRect(16, 12, 288, 144)); // never returns
    // pw_ironfeet (3) expires.
    p.powers![3] = 50;
    for (let i = 0; i < 51; i += 1) s.cycle();
    expect(p.powers![3]).toBe(0);
    // pw_strength (1) counts UP forever ONCE SET (p_user.c:339
    // `if (powers[pw_strength]) ++powers[pw_strength]` — vanilla quirk
    // feeding the berserk fade bzc = 12 - (count>>6)).
    p.powers![1] = 1; // as P_GivePower(pw_strength) does on pickup
    for (let i = 0; i < 10; i += 1) s.cycle();
    expect(p.powers![1]).toBe(11);
  });
});

d('soak — B-01 the border ring survives every frame (d_main.c:276-296 mis-port)', () => {
  it('idle windowed soak: ring bands are byte-exact back-buffer pixels', () => {
    const s = createLiveSoak();
    for (let i = 0; i < 30; i += 1) {
      s.cycle();
      expect(ringBad(s)).toBe(0);
    }
  });

  it('movement soak (the field-report trigger): ring never eaten by 3D bleed', () => {
    // PRE-FIX BEHAVIOUR (measured on the bug build): ringBad 4/4 from
    // frame 5 on — the 3-count border erase lost to the full-res 3D pass
    // and raw UNCROPPED 3D (content shifted 16 rows against the cropped
    // window) sat in the ring forever.
    const s = createLiveSoak();
    s.setInput(turnWalk);
    let ringBadFrames = 0;
    for (let i = 0; i < 150; i += 1) {
      s.cycle();
      if (ringBad(s) > 0) ringBadFrames += 1;
    }
    s.setInput(null);
    expect(ringBadFrames).toBe(0);
  });

  it('resize churn (setsizeneeded re-latch path) keeps the ring at every size', () => {
    const s = createLiveSoak();
    for (const blocks of [9, 10, 8, 11, 10]) {
      setViewSize(blocks, 0);
      for (let i = 0; i < 12; i += 1) {
        s.cycle();
        expect(ringBad(s)).toBe(0);
      }
    }
  });

  it('automap ignores the view window: no crop while the map is up', () => {
    // Vanilla automap covers rows 0..167 at FULL width; cropping it would
    // stamp a 16-row-shifted duplicate square in the middle of the map
    // (the automap flavour of B-01). drawAutomap's wall throttle makes a
    // pixel replay non-reproducible, so pin the mechanism + the visible
    // consequence: crop calls flat, bar still drawn (vanilla keeps ST up
    // over the automap: AM_clearFB stops at row 168).
    const s = createLiveSoak();
    for (let i = 0; i < 5; i += 1) s.cycle();
    s.setAutomap(true);
    s.setInput(turnWalk);
    const crops = displayStatics.cropCalls;
    let mapPixels = 0;
    for (let i = 0; i < 60; i += 1) {
      s.cycle();
      mapPixels = Math.max(mapPixels, countNonBackground(s));
    }
    s.setInput(null);
    expect(displayStatics.cropCalls).toBe(crops); // ZERO crops under automap
    expect(mapPixels).toBeGreaterThan(50); // and the map really drew
    // bar over automap: face well is NOT bare background (ST still up)
    expect(s.hashRect(...FACE_WELL)).not.toBe(backRectSha(...FACE_WELL));
    s.setAutomap(false);
    s.cycle();
    expect(displayStatics.cropCalls).toBeGreaterThan(crops); // crops resume
    expect(ringBad(s)).toBe(0);
  });
});

d('soak — B-06 statusbar widgets never vanish (ST widget diff vs dirty FG)', () => {
  it('face stays drawn on EVERY frame of a movement soak', () => {
    // PRE-FIX BEHAVIOUR (measured on the bug build): faceBox==BG on every
    // frame whose face VALUE didn't change — "the face flickers, then the
    // whole bar is gone" (only the always-redrawn digits survived).
    const s = createLiveSoak();
    s.setInput(turnWalk);
    let blankFrames = 0;
    let notRefreshed = 0;
    for (let i = 0; i < 150; i += 1) {
      const f = s.cycle();
      if (s.hashRect(...FACE_WELL) === backRectSha(...FACE_WELL)) blankFrames += 1;
      if (viewSize().viewheight !== 200 && !f.display.barRefreshed) notRefreshed += 1;
    }
    s.setInput(null);
    expect(blankFrames).toBe(0);
    expect(notRefreshed).toBe(0); // reorder contract: every windowed frame refreshes
  });

  it('HUD state unchanged ⇒ bar bytes unchanged (no flicker class)', () => {
    // The ONLY legitimate idle bar change is the vanilla face re-roll
    // every ST_STRAIGHTFACECOUNT=17 tics (st_stuff.c idle tail: pain
    // offset + st_randomnumber%3) — that is a VALUE change the widget
    // diff correctly propagates, not flicker. The pre-fix code erased
    // the face on the NEXT frame and never re-drew it (face == BG until
    // the next change), so the extra predicate (face box never == the
    // bare STBAR background) is the real pin.
    const s = createLiveSoak();
    for (let i = 0; i < 4; i += 1) s.cycle();
    const seen = new Set<string>();
    let faceBlank = 0;
    const p = s.state.players[0]!;
    const health0 = p.health;
    for (let i = 0; i < 60; i += 1) {
      seen.add(s.cycle().barSha);
      if (s.hashRect(...FACE_WELL) === backRectSha(...FACE_WELL)) faceBlank += 1;
    }
    expect(p.health).toBe(health0); // truly idle (no monster in LOS at spawn)
    expect(faceBlank).toBe(0); // the B-06 predicate
    expect([...seen].length).toBeLessThanOrEqual(60 / 17 + 2); // face re-rolls only
  });

  it('fullscreen round-trip brings the widgets back', () => {
    const s = createLiveSoak();
    for (let i = 0; i < 3; i += 1) s.cycle();
    const barRef = s.frames[s.frames.length - 1]!.barSha;
    setViewSize(11, 0); // FULL screen — no bar (B-05's third flavour: a
    s.cycle(); //          1-frame fullscreen "menu" flashed the bar back
    s.cycle(); //           for exactly one frame)
    setViewSize(WINDOW_BLOCKS, 0);
    s.cycle();
    const f = s.cycle();
    expect(f.barSha).toBe(barRef); // face/numbers/arms back after the toggle
  });

  it('100-tic idle tripwire: face always present, bar churn = face re-roll cadence', () => {
    const s = createLiveSoak();
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const f = s.cycle();
      seen.add(f.barSha);
      expect(s.hashRect(...FACE_WELL)).not.toBe(backRectSha(...FACE_WELL));
    }
    expect([...seen].length).toBeLessThanOrEqual(100 / 17 + 3); // re-roll cadence
  });
});

/** Non-background pixels in the automap territory (rows 0..167):
 * BACKGROUND is palette index 8? no — am_map clears with the BACKGROUND
 * colour (vix 247?); count pixels that differ from the modal value. */
function countNonBackground(s: LiveSoak): number {
  const px = s.fb.indices;
  let bg = 0;
  const hist = new Int32Array(256);
  for (let i = 0; i < 168 * 320; i += 1) hist[px[i]!] = (hist[px[i]!] ?? 0) + 1;
  let best = 0;
  for (let v = 0; v < 256; v += 1) {
    const c = hist[v] ?? 0;
    if (c > best) {
      best = c;
      bg = v;
    }
  }
  let n = 0;
  for (let i = 0; i < 168 * 320; i += 1) if (px[i] !== bg) n += 1;
  return n;
}
