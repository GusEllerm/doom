/**
 * sim/amMap tests (M2-08 — automap state machine, am_map.c port).
 *
 * Layer 1: FIXMAP (tests/fixtures/mapBuilder, two 256×256 rooms side by
 * side, player 1 at (128,128)) through gInitGame + the amStart/amResponder/
 * amTicker triple: TAB consume semantics, follow-mode FixedMul tracking
 * (FTOM(MTOF(p)) — NOT the identity; pinned), zoom 2%/tic + clamps, pan,
 * marks FIFO, 'g'/'0' toggles, determinism hash, and viewport line-slice
 * goldens cross-checked against a test-local naive segment∩rect oracle. The
 * 100-tic follow test drives real M2-07 noclip fly movement through
 * gTicker. Layer 2: freedoom1.wad E1M1 goldens (auto-skip when absent) — entry scale
 * from the real vertex bbox, spawn-view visible-line count, full-zoom-out
 * view, and a seeded sandwich property over follow-mode viewpoints.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { FixedDiv, FixedMul } from '../core/fixed';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';

import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import {
  AM_FRAME_HEIGHT,
  AM_FRAME_WIDTH,
  AM_NUMMARKPOINTS,
  AM_ZOOMINKEY,
  AM_ZOOMOUTKEY,
  F_PANINC,
  INITSCALEMTOF,
  LITELEVELS,
  M_ZOOMIN,
  M_ZOOMOUT,
  PLAYERRADIUS,
  amActivateNewScale,
  amClearMarks,
  amCreateState,
  amFtom,
  amMtof,
  amResponder,
  amSetFollow,
  amTicker,
  amViewBounds,
  amVisibleLines,
  hashAutomapState,
  keydown,
  keyup,
  type AutomapContext,
  type AutomapState,
  type AutomapEvent
} from './amMap';
import { gInitGame, gTicker } from './game';
import { buildMapFromData, type RuntimeMap } from './map';
import { CF_NOCLIP } from './player';
import type { GameState } from './state';
import { emptyInput } from './ticcmd';

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const SPEC: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, lightLevel: 200 },
    { x: 256, y: 0, w: 256, h: 256, lightLevel: 128 }
  ]
};

function fixMap(name = 'FIXMAP'): RuntimeMap {
  const bytes = buildFixtureMapWad(SPEC);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), name));
}

interface Rig {
  gs: GameState;
  am: AutomapState;
  ctx: AutomapContext;
  ev: (e: AutomapEvent) => boolean;
  tab: () => void;
}

function rig(map = fixMap()): Rig {
  const gs = gInitGame(map);
  const am = amCreateState();
  const ctx: AutomapContext = { map, player: gs.players[0]! };
  return {
    gs,
    am,
    ctx,
    ev: (e) => amResponder(am, e, ctx),
    tab: () => {
      amResponder(am, keydown(9), ctx);
    }
  };
}

const U = FRACUNIT; // one map unit in fixed

/** Test-local naive oracle: closed-rect segment intersection (float). */
function segHitsRect(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  L: number,
  B: number,
  R: number,
  T: number
): boolean {
  const f = (v: number) => v / U;
  const [l, b, r, t] = [f(L), f(B), f(R), f(T)];
  const ax = f(x1);
  const ay = f(y1);
  const bx = f(x2);
  const by = f(y2);
  if (Math.max(ax, bx) < l || Math.min(ax, bx) > r) return false;
  if (Math.max(ay, by) < b || Math.min(ay, by) > t) return false;
  const inside = (x: number, y: number) => x >= l && x <= r && y >= b && y <= t;
  if (inside(ax, ay) || inside(bx, by)) return true;
  const cross = (
    px: number,
    py: number,
    qx: number,
    qy: number,
    sx: number,
    sy: number,
    tx: number,
    ty: number
  ): boolean => {
    const d = (qx - px) * (ty - sy) - (qy - py) * (tx - sx);
    if (d === 0) return false;
    const a = ((sx - px) * (ty - sy) - (sy - py) * (tx - sx)) / d;
    const c = ((sx - px) * (qy - py) - (sy - py) * (qx - px)) / d;
    return a >= 0 && a <= 1 && c >= 0 && c <= 1;
  };
  const corners = [
    [l, b],
    [r, b],
    [r, t],
    [l, t]
  ];
  for (let i = 0; i < 4; i++) {
    const [p, q] = [corners[i]!, corners[(i + 1) % 4]!];
    if (cross(ax, ay, bx, by, p[0]!, p[1]!, q[0]!, q[1]!)) return true;
  }
  return false;
}

function lineEnds(map: RuntimeMap, i: number): [number, number, number, number] {
  const v1 = map.lines.v1[i]!;
  const v2 = map.lines.v2[i]!;
  return [
    map.verticesX[v1]!,
    map.verticesY[v1]!,
    map.verticesX[v2]!,
    map.verticesY[v2]!
  ];
}

/** Indices of linedefs whose segment meets the closed window rect. */
function naiveVisible(map: RuntimeMap, s: AutomapState): number[] {
  const out: number[] = [];
  for (let i = 0; i < map.lines.count; i++) {
    const [x1, y1, x2, y2] = lineEnds(map, i);
    if (segHitsRect(x1, y1, x2, y2, s.mX, s.mY, s.mX2, s.mY2)) out.push(i);
  }
  return out;
}

/** Deterministic LCG for seeded viewpoints (no Math.random, §1.3). */
function lcg(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x / 0x100000000;
  };
}

/** Consistent custom view: set scale + window center directly (state-only). */
function setView(s: AutomapState, scaleMtof: number, cx: number, cy: number): void {
  s.scaleMtof = scaleMtof;
  s.scaleFtom = FixedDiv(FRACUNIT, s.scaleMtof);
  amActivateNewScale(s);
  s.mX = (cx - (s.mW >> 1)) | 0;
  s.mY = (cy - (s.mH >> 1)) | 0;
  s.mX2 = (s.mX + s.mW) | 0;
  s.mY2 = (s.mY + s.mH) | 0;
}

/* Goldens recorded 2026-07 from this port on FIXMAP. Regenerate + explain. */
const GOLDEN_FIXMAP_DEFAULT_SCALE = 58514; // FixedDiv(40960, 45875)
const GOLDEN_FIXMAP_MIN_SCALE_MTOF = 40960; // fit 512 px→320 wide
const GOLDEN_FIXMAP_MAX_SCALE_MTOF = 344064; // FixedDiv(168<<16, 2*PLAYERRADIUS)
const GOLDEN_HASH_SCRIPT_200 = 4068524677; // RE-BLESSED M5-06: p_user physics
// replaces the D009 fly stub — the follow-window player positions change.

/* ------------------------------------------------------------------ */
/* Constants (am_map.c verbatim)                                       */
/* ------------------------------------------------------------------ */

describe('constants', () => {
  it('pins the am_map.c fixed constants', () => {
    expect(INITSCALEMTOF).toBe(13107); // (int)(.2*FRACUNIT), NOT 16*FRACUNIT
    expect(M_ZOOMIN).toBe(66846); // (int)(1.02*FRACUNIT) — 66847 would be wrong
    expect(M_ZOOMOUT).toBe(64250); // (int)(FRACUNIT/1.02)
    expect(F_PANINC).toBe(4);
    expect(AM_NUMMARKPOINTS).toBe(10);
    expect(AM_FRAME_WIDTH).toBe(320);
    expect(AM_FRAME_HEIGHT).toBe(168); // SCREENHEIGHT-32
    expect(PLAYERRADIUS).toBe(16 * FRACUNIT);
    expect(LITELEVELS).toEqual([0, 4, 7, 10, 12, 14, 15, 15]);
  });
});

/* ------------------------------------------------------------------ */
/* TAB toggle + responder consume semantics                            */
/* ------------------------------------------------------------------ */

describe('AM_Responder — TAB toggle (acceptance 1)', () => {
  it('first TAB opens: active, follow defaults on, scale from map bbox', () => {
    const r = rig();
    expect(r.ev(keydown(9))).toBe(true);
    expect(r.am.automapactive).toBe(true);
    expect(r.am.stopped).toBe(false);
    expect(r.am.followplayer).toBe(1);
    expect(r.am.amclock).toBe(0);
    expect(r.am.grid).toBe(0);
    expect(r.am.cheating).toBe(0);
    expect(r.am.markpoints.every((m) => m.x === -1)).toBe(true);
    expect(r.am.minScaleMtof).toBe(GOLDEN_FIXMAP_MIN_SCALE_MTOF);
    expect(r.am.maxScaleMtof).toBe(GOLDEN_FIXMAP_MAX_SCALE_MTOF);
    expect(r.am.scaleMtof).toBe(GOLDEN_FIXMAP_DEFAULT_SCALE);
    expect(r.am.scaleMtof).toBe(FixedDiv(GOLDEN_FIXMAP_MIN_SCALE_MTOF, 45875));
    expect(r.am.scaleFtom).toBe(FixedDiv(FRACUNIT, GOLDEN_FIXMAP_DEFAULT_SCALE));
    // window = FTOM(320×168) at the entry scale = 0.7 × map extent (wide axis)
    expect(r.am.mW).toBe(320 * r.am.scaleFtom);
    expect(r.am.mH).toBe(168 * r.am.scaleFtom);
  });

  it('second TAB closes (mode off) and consumes the event', () => {
    const r = rig();
    r.tab();
    expect(r.ev(keydown(9))).toBe(true);
    expect(r.am.automapactive).toBe(false);
    expect(r.am.stopped).toBe(true);
    // reopen works (AM_Start re-runs initVariables, not LevelInit)
    expect(r.ev(keydown(9))).toBe(true);
    expect(r.am.automapactive).toBe(true);
  });

  it('while open: map keys are consumed, unknown keys and keyups are not', () => {
    const r = rig();
    r.tab();
    for (const k of [
      0x66, // f
      0x67, // g
      0x6d, // m
      0x63, // c
      0x30, // 0
      AM_ZOOMINKEY,
      AM_ZOOMOUTKEY
    ]) {
      expect(r.ev(keydown(k))).toBe(true);
      expect(r.ev(keyup(k))).toBe(false); // keyup branch always returns false
    }
    expect(r.ev(keydown(0x78))).toBe(false); // 'x' → default: rc = false
    expect(r.ev(keyup(0x78))).toBe(false);
  });

  it('arrows leak while following, pan when free (no leak to player input)', () => {
    const r = rig();
    r.tab();
    for (const k of [0xac, 0xad, 0xae, 0xaf]) {
      expect(r.ev(keydown(k))).toBe(false); // follow mode: leak to G_Responder
    }
    expect(r.am.mPanIncX).toBe(0);
    expect(r.am.mPanIncY).toBe(0);

    r.ev(keydown(0x66)); // 'f' → free mode
    expect(r.am.followplayer).toBe(0);
    const pan = FixedMul(4 << 16, r.am.scaleFtom); // FTOM(F_PANINC)
    expect(r.ev(keydown(0xae))).toBe(true);
    expect(r.am.mPanIncX).toBe(pan);
    r.ev(keyup(0xae));
    expect(r.am.mPanIncX).toBe(0);
    expect(r.ev(keydown(0xad))).toBe(true);
    expect(r.am.mPanIncY).toBe(pan);
    r.ev(keyup(0xad));
    expect(r.am.mPanIncY).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Follow mode (acceptance 5)                                          */
/* ------------------------------------------------------------------ */

describe('AM_Ticker — follow mode (north-up, FixedMul)', () => {
  it('follow-mode truth: NORTH-UP — player angle never moves the window', () => {
    const a = rig();
    const b = rig();
    a.tab();
    b.tab();
    for (let i = 0; i < 30; i++) {
      a.gs.players[0]!.mo.x = (8 << 16) + i * 4321;
      b.gs.players[0]!.mo.x = (8 << 16) + i * 4321;
      b.gs.players[0]!.mo.angle = (i * 0x0b000000) >>> 0; // spin player; am must not care
      amTicker(a.am, a.gs.players[0]!);
      amTicker(b.am, b.gs.players[0]!);
    }
    expect(hashAutomapState(a.am)).toBe(hashAutomapState(b.am));
  });

  it('stays pinned via FTOM(MTOF(p)) over 100 tics of noclip movement', () => {
    const r = rig();
    r.tab();
    const p = r.gs.players[0]!;
    p.cheats |= CF_NOCLIP; // M2-07 fly path
    const start = { x: p.mo.x, y: p.mo.y };
    for (let i = 0; i < 100; i++) {
      gTicker(r.gs, {
        ...emptyInput(),
        forward: i % 20 !== 0,
        turnRight: i % 30 === 0
      });
      amTicker(r.am, p);
      expect(r.am.mX + (r.am.mW >> 1)).toBe(amFtom(r.am, amMtof(r.am, p.mo.x)));
      expect(r.am.mY + (r.am.mH >> 1)).toBe(amFtom(r.am, amMtof(r.am, p.mo.y)));
      // FTOM(MTOF(x)) is NOT the identity (truncated scale round-trip); the
      // window center stays within one framebuffer pixel of the player.
      expect(Math.abs(r.am.mX + (r.am.mW >> 1) - p.mo.x)).toBeLessThan(
        Math.ceil(FRACUNIT * (FRACUNIT / r.am.scaleMtof)) + 4096
      );
    }
    expect(p.mo.x !== start.x || p.mo.y !== start.y).toBe(true); // really moved
    expect(r.am.mX2).toBe(r.am.mX + r.am.mW);
    expect(r.am.mY2).toBe(r.am.mY + r.am.mH);
  });

  it('f_oldloc memo: no recenter while the player stands still', () => {
    const r = rig();
    r.tab();
    amTicker(r.am, r.gs.players[0]!);
    const m = r.am.mX;
    r.am.mX = (m + 12345) | 0; // tamper
    amTicker(r.am, r.gs.players[0]!);
    expect(r.am.mX).toBe(m + 12345); // memo hit → untouched
    r.gs.players[0]!.mo.x = (r.gs.players[0]!.mo.x + 1) | 0;
    amTicker(r.am, r.gs.players[0]!);
    expect(r.am.mX).not.toBe(m + 12345); // memo miss → recentred
  });

  it("'f' toggles follow and invalidates the memo; amSetFollow matches", () => {
    const r = rig();
    r.tab();
    r.ev(keydown(0x66));
    expect(r.am.followplayer).toBe(0);
    expect(r.am.fOldlocX).toBe(0x7fffffff);
    amSetFollow(r.am, true);
    expect(r.am.followplayer).toBe(1);
    expect(r.am.fOldlocX).toBe(0x7fffffff);
  });

  it('pan clamps the window centre at the map bounds', () => {
    const r = rig();
    r.tab();
    r.ev(keydown(0x66)); // free
    r.ev(keydown(0xac)); // hold left
    for (let i = 0; i < 200; i++) amTicker(r.am, r.gs.players[0]!);
    // vanilla clamps the centre to the map edge: m_x = min_x - m_w/2
    expect(r.am.mX + (r.am.mW >> 1)).toBe(r.am.minX);
    r.ev(keyup(0xac));
  });
});

/* ------------------------------------------------------------------ */
/* Zoom (acceptance 3)                                                 */
/* ------------------------------------------------------------------ */

describe('AM_Ticker — zoom', () => {
  it('holds 2%/tic while held: scale = FixedMul chain of M_ZOOMIN', () => {
    const r = rig();
    r.tab();
    r.ev(keydown(AM_ZOOMINKEY));
    let scale = r.am.scaleMtof;
    for (let i = 0; i < 10; i++) {
      scale = FixedMul(scale, M_ZOOMIN);
      amTicker(r.am, r.gs.players[0]!);
      expect(r.am.scaleMtof).toBe(Math.min(scale, r.am.maxScaleMtof));
      expect(r.am.mW).toBe(amFtom(r.am, r.am.fW));
    }
    r.ev(keyup(AM_ZOOMINKEY));
    expect(r.am.mtofZoommul).toBe(FRACUNIT);
    const s = r.am.scaleMtof;
    amTicker(r.am, r.gs.players[0]!);
    expect(r.am.scaleMtof).toBe(s); // released ⇒ frozen
  });

  it('clamps at max_scale_mtof zooming in, min_scale_mtof zooming out', () => {
    const r = rig();
    r.tab();
    r.ev(keydown(AM_ZOOMINKEY));
    for (let i = 0; i < 200; i++) amTicker(r.am, r.gs.players[0]!);
    expect(r.am.scaleMtof).toBe(GOLDEN_FIXMAP_MAX_SCALE_MTOF);
    // max zoom = 2*PLAYERRADIUS window height
    expect(Math.abs(r.am.mH - 32 * FRACUNIT)).toBeLessThan(FRACUNIT);
    r.ev(keyup(AM_ZOOMINKEY));
    r.ev(keydown(AM_ZOOMOUTKEY));
    for (let i = 0; i < 500; i++) amTicker(r.am, r.gs.players[0]!);
    expect(r.am.scaleMtof).toBe(GOLDEN_FIXMAP_MIN_SCALE_MTOF);
    r.ev(keyup(AM_ZOOMOUTKEY));
  });

  it("'0' zooms fully out and restores on second press", () => {
    const r = rig();
    r.tab();
    const before = r.am.scaleMtof;
    const oldW = r.am.mW;
    r.ev(keydown(0x30));
    expect(r.am.bigstate).toBe(1);
    expect(r.am.scaleMtof).toBe(r.am.minScaleMtof);
    r.ev(keydown(0x30));
    expect(r.am.bigstate).toBe(0);
    expect(r.am.scaleMtof).toBe(before);
    expect(r.am.mW).toBe(oldW);
  });
});

/* ------------------------------------------------------------------ */
/* Grid + marks (acceptance 2)                                         */
/* ------------------------------------------------------------------ */

describe('grid + marks', () => {
  it("'g' toggles the grid flag", () => {
    const r = rig();
    r.tab();
    r.ev(keydown(0x67));
    expect(r.am.grid).toBe(1);
    r.ev(keydown(0x67));
    expect(r.am.grid).toBe(0);
  });

  it("'m' marks the window centre, ≤10 marks with FIFO evict, 'c' clears", () => {
    const r = rig();
    r.tab();
    const p = r.gs.players[0]!;
    const centres: number[] = [];
    for (let i = 0; i < 12; i++) {
      p.mo.x = (16 << 16) + i * (32 << 16);
      p.mo.y = (16 << 16) + i * (16 << 16);
      amTicker(r.am, p);
      centres.push(amFtom(r.am, amMtof(r.am, p.mo.x)));
      r.ev(keydown(0x6d));
      expect(r.am.markpointnum).toBe((i + 1) % AM_NUMMARKPOINTS);
    }
    // presses 0..9 filled slots 0..9; 10/11 overwrote 0/1 — FIFO.
    expect(r.am.markpoints[0]!.x).toBe(centres[10]);
    expect(r.am.markpoints[1]!.x).toBe(centres[11]);
    for (let i = 2; i < 10; i++) expect(r.am.markpoints[i]!.x).toBe(centres[i]);
    r.ev(keydown(0x63));
    expect(r.am.markpoints.every((m) => m.x === -1)).toBe(true);
    expect(r.am.markpointnum).toBe(0);
    amClearMarks(r.am); // idempotent
  });
});

/* ------------------------------------------------------------------ */
/* Determinism (acceptance 4)                                          */
/* ------------------------------------------------------------------ */

describe('determinism', () => {
  const script = (r: Rig, t: number): void => {
    if (t === 0) r.ev(keydown(9));
    if (t === 20) r.ev(keydown(AM_ZOOMINKEY));
    if (t === 40) r.ev(keyup(AM_ZOOMINKEY));
    if (t === 60) r.ev(keydown(0x67));
    if (t === 80) r.ev(keydown(0x6d));
    if (t === 100) r.ev(keydown(0x66)); // free mode
    if (t === 101) r.ev(keydown(0xae)); // pan right
    if (t === 140) r.ev(keyup(0xae));
    if (t === 150) r.ev(keydown(0x30));
    if (t === 160) r.ev(keydown(0x6d));
    if (t === 170) r.ev(keydown(0x63));
    if (t === 180) r.ev(keydown(0x67));
    if (t === 190) r.ev(keydown(0x66));
    const p = r.gs.players[0]!;
    p.cheats |= CF_NOCLIP;
    gTicker(r.gs, {
      ...emptyInput(),
      forward: t % 7 < 4,
      turnRight: t % 23 === 0,
      strafe: t % 31 === 0
    });
    amTicker(r.am, p);
  };

  it('identical 200-tic event script ⇒ identical AutomapState hash', () => {
    const a = rig();
    const b = rig();
    for (let t = 0; t < 200; t++) {
      script(a, t);
      script(b, t);
    }
    expect(hashAutomapState(a.am)).toBe(hashAutomapState(b.am));
    expect(hashAutomapState(a.am)).toBe(GOLDEN_HASH_SCRIPT_200);
  });

  it('hash is a u32 and observes every scripted change', () => {
    const a = rig();
    const h0 = hashAutomapState(a.am);
    expect(h0).toBeGreaterThanOrEqual(0);
    expect(h0).toBeLessThanOrEqual(0xffffffff);
    a.tab();
    const h1 = hashAutomapState(a.am);
    expect(h1).not.toBe(h0);
    a.ev(keydown(0x67));
    expect(hashAutomapState(a.am)).not.toBe(h1);
    amTicker(a.am, a.gs.players[0]!);
    expect(hashAutomapState(a.am)).not.toBe(h1); // amclock
  });

  it('lightlev stays 0 (vanilla AM_updateLightLev call is commented out)', () => {
    const r = rig();
    r.tab();
    for (let i = 0; i < 100; i++) amTicker(r.am, r.gs.players[0]!);
    expect(r.am.lightlev).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Viewport line slice                                                 */
/* ------------------------------------------------------------------ */

describe('amViewBounds + amVisibleLines (FIXMAP)', () => {
  it('view bounds are the consistent window rect', () => {
    const r = rig();
    r.tab();
    amTicker(r.am, r.gs.players[0]!);
    const v = amViewBounds(r.am);
    expect(v.right - v.left).toBe(r.am.mW);
    expect(v.top - v.bottom).toBe(r.am.mH);
    expect(v.left).toBeLessThan(v.right);
  });

  it('spawn view at entry scale shows exactly the naive-visible lines', () => {
    const r = rig();
    r.tab();
    const map = r.ctx.map;
    const got = amVisibleLines(r.am, map);
    expect(got).toEqual(naiveVisible(map, r.am));
    // Room interior at spawn: the left room wall (x=0) and the shared room
    // wall (x=256) cross the window band (358.4×188.2 units centred on the
    // player); the y=0/y=256 walls fall outside the 188-unit-tall window.
    expect(got.length).toBe(2);
    const walls = got
      .map((i) => {
        const [wx1, , wx2] = lineEnds(map, i);
        expect(wx1).toBe(wx2); // vertical
        return wx1 / U;
      })
      .sort((p, q) => p - q);
    expect(walls).toEqual([0, 256]);
  });

  it('zoomed-in room interior shows exactly the wall in view (naive-equal)', () => {
    const r = rig();
    r.tab();
    const map = r.ctx.map;
    // 4× zoom centred at (60,128): window ≈ 90×47 units → only x=0 wall.
    setView(r.am, FixedMul(r.am.minScaleMtof, 4 * FRACUNIT), 60 * U, 128 * U);
    const got = amVisibleLines(r.am, map);
    expect(got).toEqual(naiveVisible(map, r.am));
    expect(got.length).toBe(1);
    // dead centre of the room interior: nothing at all
    setView(r.am, FixedMul(r.am.minScaleMtof, 4 * FRACUNIT), 128 * U, 128 * U);
    expect(amVisibleLines(r.am, map)).toEqual([]);
  });

  it("'0' full-out view left-of-map-centre sees all lines but the far wall", () => {
    const r = rig();
    r.tab();
    const map = r.ctx.map;
    r.ev(keydown(0x30)); // big view = min scale, still centred on (128,128)
    const got = amVisibleLines(r.am, map);
    expect(got).toEqual(naiveVisible(map, r.am));
    expect(got.length).toBe(map.lines.count - 1); // right wall x=512 out of view
  });

  it('property: reported lines touch the viewport; interior lines are reported', () => {
    const r = rig();
    r.tab();
    const map = r.ctx.map;
    const rand = lcg(0x5eed08);
    let samples = 0;
    for (let trial = 0; trial < 120 && samples < 40; trial++) {
      const cx = Math.floor(rand() * 512 * U + U / 3);
      const cy = Math.floor(rand() * 256 * U + U / 3);
      const zooms = [FRACUNIT, 2 * FRACUNIT, 4 * FRACUNIT, 8 * FRACUNIT];
      const scale = Math.min(
        FixedMul(r.am.minScaleMtof, zooms[trial % 4]!),
        r.am.maxScaleMtof
      );
      setView(r.am, scale, cx, cy);
      // skip near-degenerate edge-touching samples (clip is exact-on-edge by
      // construction; the naive float oracle is not)
      let degenerate = false;
      for (let i = 0; i < map.lines.count && !degenerate; i++) {
        const [x1, y1, x2, y2] = lineEnds(map, i);
        for (const [px, py] of [
          [x1, y1] as const,
          [x2, y2] as const
        ]) {
          if (
            Math.abs(px - r.am.mX) < 64 ||
            Math.abs(px - r.am.mX2) < 64 ||
            Math.abs(py - r.am.mY) < 64 ||
            Math.abs(py - r.am.mY2) < 64
          )
            degenerate = true;
        }
      }
      if (degenerate) continue;
      samples++;
      const got = amVisibleLines(r.am, map);
      const v = amViewBounds(r.am);
      const pad = 2 * U;
      for (const i of got) {
        // containment: every reported line's bbox intersects the viewport
        const [x1, y1, x2, y2] = lineEnds(map, i);
        expect(Math.max(x1, x2)).toBeGreaterThanOrEqual(v.left - pad);
        expect(Math.min(x1, x2)).toBeLessThanOrEqual(v.right + pad);
        expect(Math.max(y1, y2)).toBeGreaterThanOrEqual(v.bottom - pad);
        expect(Math.min(y1, y2)).toBeLessThanOrEqual(v.top + pad);
      }
      for (const i of naiveVisible(map, r.am)) {
        const [x1, y1, x2, y2] = lineEnds(map, i);
        const strictIn = (x: number, y: number) =>
          x > v.left + U && x < v.right - U && y > v.bottom + U && y < v.top - U;
        if (strictIn(x1, y1) && strictIn(x2, y2)) {
          expect(got).toContain(i); // strictly-interior lines are never missed
        }
      }
    }
    expect(samples).toBeGreaterThanOrEqual(20);
  });
});

/* ------------------------------------------------------------------ */
/* freedoom1.wad E1M1 goldens (auto-skip when absent)                  */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad E1M1 automap goldens', () => {
  // Recorded 2026-07 from wads/freedoom1.wad via this port.
  const GOLDEN_E1M1_SPAWN_VISIBLE = 635; // pinned after first run
  const GOLDEN_E1M1_SPAWN_SCALE = 4625;

  function e1m1(): Rig {
    const buf = readFileSync(WAD_PATH).buffer.slice(
      0
    ) as ArrayBuffer;
    return rig(buildMapFromData(loadMap(WadFile.parse(buf), 'E1M1')));
  }

  it('follow viewport at player 1 spawn lists the golden line count', () => {
    const r = e1m1();
    r.tab();
    amTicker(r.am, r.gs.players[0]!);
    expect(r.am.scaleMtof).toBe(GOLDEN_E1M1_SPAWN_SCALE);
    const got = amVisibleLines(r.am, r.ctx.map);
    expect(got.length).toBe(GOLDEN_E1M1_SPAWN_VISIBLE);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(r.ctx.map.lines.count);
  });

  it('1.10 has no am_lines list: geometry visibility over all linedefs', () => {
    // The DOOM2/Heretic AM_addLine am_lines[] counter does not exist in
    // linuxdoom-1.10; the state walks linedefs directly, so the population
    // we iterate over equals the linedef count exactly.
    const r = e1m1();
    expect(r.ctx.map.lines.count).toBeGreaterThan(1000);
  });

  it('seeded follow-mode viewpoints: reported lines intersect the window', () => {
    const r = e1m1();
    r.tab();
    const map = r.ctx.map;
    const rand = lcg(0xe171 ^ 0x51);
    for (let t = 0; t < 32; t++) {
      const cx =
        (Math.floor(rand() * ((map.mapBBox.right - map.mapBBox.left) / U)) +
          map.mapBBox.left / U) *
        U;
      const cy =
        (Math.floor(rand() * ((map.mapBBox.top - map.mapBBox.bottom) / U)) +
          map.mapBBox.bottom / U) *
        U;
      const zoom = [FRACUNIT, 2 * FRACUNIT, 3 * FRACUNIT, 5 * FRACUNIT][t % 4]!;
      const scale = Math.min(FixedMul(r.am.minScaleMtof, zoom), r.am.maxScaleMtof);
      setView(r.am, scale, cx, cy);
      for (const i of amVisibleLines(r.am, map)) {
        const [x1, y1, x2, y2] = lineEnds(map, i);
        const v = amViewBounds(r.am);
        const pad = 2 * U;
        expect(Math.max(x1, x2)).toBeGreaterThanOrEqual(v.left - pad);
        expect(Math.min(x1, x2)).toBeLessThanOrEqual(v.right + pad);
        expect(Math.max(y1, y2)).toBeGreaterThanOrEqual(v.bottom - pad);
        expect(Math.min(y1, y2)).toBeLessThanOrEqual(v.top + pad);
      }
    }
  });
});
