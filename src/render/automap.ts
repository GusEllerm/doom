// render/automap.ts — automap pixel pipeline: AutomapState + World read
// views become palette indices in the 320x200 buffer (M2-plan §M2-09,
// ARCHITECTURE §5, port of am_map.c's AM_Drawer half).
//
// Zone discipline (A-INT1 / eslint doom/zones/render): this file may NOT
// import sim/* (only sim/state). It therefore consumes STRUCTURAL read-view
// interfaces below — plain readonly field shapes that the real sim objects
// (AutomapState / RuntimeMap / Player) satisfy by construction, with zero
// casting cost and zero import edge. If a field ever goes out of sync, the
// call site in main.ts fails to typecheck (main imports both sides).
//
// Faithfulness map (linuxdoom-1.10 am_map.c, line refs verified):
//   AM_Drawer      :1332 AM_clearFB(BACKGROUND) → grid → walls → players →
//                    crosshair → marks. (AM_drawThings only when
//                    cheating==2 — unreachable via keys, see amMap.ts.)
//   AM_drawWalls   :1117 color groups — one-sided WALLCOLORS+lightlev;
//                    special 39 (teleport) WALLCOLORS+WALLRANGE/2; ML_SECRET
//                    WALLCOLORS+lightlev (SECRETWALLCOLORS==WALLCOLORS);
//                    floor change FDWALLCOLORS+lightlev (BROWNS=64);
//                    ceiling change CDWALLCOLORS+lightlev (YELLOWS=231);
//                    flat two-sided ONLY when cheating (TSWALLCOLORS=GRAYS).
//                    LINE_NEVERSEE(=ML_DONTDRAW=128) skipped unless cheating.
//                    ML_MAPPED: vanilla stamps it on every line in
//                    P_GroupLines; our M2-04 map keeps RAW LINEDEF flags, so
//                    "mapped" is implicit for every existing line (deviation
//                    note in the task report).
//   AM_clipMline   :846  Cohen-Sutherland variant — re-derived here from
//                    the same source (sim/amMap.amClipMline is the twin the
//                    state machine uses; automap.test diffs them pixel-for-
//                    pixel so the two ports cannot drift).
//   AM_drawFline   :978  Bresenham with the `fuck` guard (endpoints outside
//                    the fb ⇒ vanilla prints to stderr and skips; here: skip
//                    silently — zero console noise requirement).
//   AM_drawGrid    :1071 MAPBLOCKUNITS-aligned lines across the window.
//   AM_drawPlayers :1237 non-netgame ⇒ player_arrow (7 segments built from
//                    R = 8*PLAYERRADIUS/7), color WHITE (=256-47=209), no
//                    scale (scale arg 0), rotated by plr->mo->angle via
//                    AM_rotate (:1172 finesine/finecosine FixedMul pair).
//                    DEVIATION vs the task brief: the arrow is WHITE, not
//                    GREENS — GREENS is AM_drawThings' THINGCOLORS.
//   AM_drawMarks   :1305 markpoints EXPOSED in state but drawn with
//                    V_DrawPatch(AMMNUM0..9) — a WAD-patch rasterizer
//                    concern, follow-up (see task report FOLLOW-UPS).
//
// lightlev: 1.10's AM_updateLightLev call is commented out (am_map.c:827)
// ⇒ the state machine keeps lightlev at 0 ⇒ red-family walls are index 176
// in practice; the ranges below stay faithful anyway.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FINEMASK, ANGLETOFINESHIFT, FRACUNIT, MAPBLOCKUNITS } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { finecosine, finesine } from '../core/tables';

import type { Framebuffer } from './framebuffer';

/* ------------------------------------------------------------------ */
/* Colors (am_map.c:52-85 — palette indices into PLAYPAL bank 0)       */
/* ------------------------------------------------------------------ */

export const REDS = 256 - 5 * 16; // 176
export const REDRANGE = 16;
export const GREENS = 7 * 16; // 112
export const GREENRANGE = 16;
export const GRAYS = 6 * 16; // 96
export const GRAYSRANGE = 16;
export const BROWNS = 4 * 16; // 64
export const BROWNRANGE = 16;
export const YELLOWS = 256 - 32 + 7; // 231
export const YELLOWRANGE = 1;
export const BLACK = 0;
export const WHITE = 256 - 47; // 209

export const BACKGROUND = BLACK;
export const WALLCOLORS = REDS;
export const WALLRANGE = REDRANGE;
export const TSWALLCOLORS = GRAYS;
export const FDWALLCOLORS = BROWNS;
export const CDWALLCOLORS = YELLOWS;
export const THINGCOLORS = GREENS;
export const GRIDCOLORS = GRAYS + GRAYSRANGE / 2; // 104
export const XHAIRCOLORS = GRAYS;

/** doomdata.h ML_* flags. */
export const ML_SECRET = 32;
export const ML_DONTDRAW = 128; // am_map.c LINE_NEVERSEE
export const ML_MAPPED = 256;

/** p_local.h:46 — player_arrow's R base. */
export const PLAYERRADIUS = 16 * FRACUNIT;

/* ------------------------------------------------------------------ */
/* Structural read-views (satisfied by sim/amMap.AutomapState,         */
/* sim/map.RuntimeMap, sim/player.Player — enforced at the main.ts call)*/
/* ------------------------------------------------------------------ */

/** AutomapState fields the drawer reads. */
export interface AutomapGeom {
  readonly automapactive: boolean;
  readonly grid: number;
  readonly cheating: number;
  readonly lightlev: number;
  readonly followplayer: number;
  readonly fX: number;
  readonly fY: number;
  readonly fW: number;
  readonly fH: number;
  readonly mX: number;
  readonly mY: number;
  readonly mX2: number;
  readonly mY2: number;
  readonly mW: number;
  readonly mH: number;
  readonly scaleMtof: number;
  readonly scaleFtom: number;
  readonly markpoints: readonly { readonly x: number; readonly y: number }[];
}

/** RuntimeMap fields the drawer reads (SoA arrays, fixed coords). */
export interface AutomapMap {
  readonly verticesX: Int32Array;
  readonly verticesY: Int32Array;
  readonly blockmapOriginX: number;
  readonly blockmapOriginY: number;
  readonly lines: {
    readonly count: number;
    readonly v1: Int32Array;
    readonly v2: Int32Array;
    readonly flags: Int32Array;
    readonly special: Int32Array;
    readonly sectorFront: Int32Array;
    readonly sectorBack: Int32Array;
  };
  readonly sectors: {
    readonly floorHeight: Int32Array;
    readonly ceilingHeight: Int32Array;
  };
}

/** Player fields for the arrow. */
export interface AutomapPlayer {
  readonly mo: { readonly x: number; readonly y: number; readonly angle: number };
}

/* ------------------------------------------------------------------ */
/* FTOM / MTOF / CXMTOF / CYMTOF (am_map.c:119-123)                    */
/* ------------------------------------------------------------------ */

export function amFtom(g: AutomapGeom, x: number): number {
  return FixedMul(x << 16, g.scaleFtom);
}

export function amMtof(g: AutomapGeom, x: number): number {
  return FixedMul(x, g.scaleMtof) >> 16;
}

export function amCxmtof(g: AutomapGeom, x: number): number {
  return g.fX + amMtof(g, (x - g.mX) | 0);
}

export function amCymtof(g: AutomapGeom, y: number): number {
  return g.fY + (g.fH - amMtof(g, (y - g.mY) | 0));
}

/* ------------------------------------------------------------------ */
/* AM_clipMline (am_map.c:846-966) — C-truncating twin of              */
/* sim/amMap.amClipMline; pixel-diffed against it in automap.test      */
/* ------------------------------------------------------------------ */

interface FPoint {
  x: number;
  y: number;
}

/** Scratch reused across every clipped line (zero steady-state alloc). */
const clipA: FPoint = { x: 0, y: 0 };
const clipB: FPoint = { x: 0, y: 0 };

/**
 * Clip map-fixed segment (ax,ay)-(bx,by) against the window, writing fb-
 * pixel endpoints into clipA/clipB. false ⇒ invisible. `fW`/`fH` come from
 * the geom's full frame box; fX/fY offsets are applied by CXMTOF/CYMTOF.
 */
export function amClipMline(g: AutomapGeom, ax: number, ay: number, bx: number, by: number): boolean {
  const LEFT = 1;
  const RIGHT = 2;
  const BOTTOM = 4;
  const TOP = 8;
  const fW = g.fW;
  const fH = g.fH;

  let outcode1 = 0;
  let outcode2 = 0;

  if (ay > g.mY2) outcode1 = TOP;
  else if (ay < g.mY) outcode1 = BOTTOM;
  if (by > g.mY2) outcode2 = TOP;
  else if (by < g.mY) outcode2 = BOTTOM;
  if (outcode1 & outcode2) return false;

  if (ax < g.mX) outcode1 |= LEFT;
  else if (ax > g.mX2) outcode1 |= RIGHT;
  if (bx < g.mX) outcode2 |= LEFT;
  else if (bx > g.mX2) outcode2 |= RIGHT;
  if (outcode1 & outcode2) return false;

  clipA.x = amCxmtof(g, ax);
  clipA.y = amCymtof(g, ay);
  clipB.x = amCxmtof(g, bx);
  clipB.y = amCymtof(g, by);

  const outcodeOf = (x: number, y: number): number => {
    let oc = 0;
    if (y < 0) oc |= TOP;
    else if (y >= fH) oc |= BOTTOM;
    if (x < 0) oc |= LEFT;
    else if (x >= fW) oc |= RIGHT;
    return oc;
  };

  outcode1 = outcodeOf(clipA.x, clipA.y);
  outcode2 = outcodeOf(clipB.x, clipB.y);
  if (outcode1 & outcode2) return false;

  while (outcode1 | outcode2) {
    const outside = outcode1 ? outcode1 : outcode2;
    let tmpX: number;
    let tmpY: number;
    let dx: number;
    let dy: number;

    // Vanilla always anchors the intercept at point a — quirk kept.
    if (outside & TOP) {
      dy = (clipA.y - clipB.y) | 0;
      dx = (clipB.x - clipA.x) | 0;
      tmpX = (clipA.x + Math.trunc((dx * clipA.y) / dy)) | 0;
      tmpY = 0;
    } else if (outside & BOTTOM) {
      dy = (clipA.y - clipB.y) | 0;
      dx = (clipB.x - clipA.x) | 0;
      tmpX = (clipA.x + Math.trunc((dx * (clipA.y - fH)) / dy)) | 0;
      tmpY = fH - 1;
    } else if (outside & RIGHT) {
      dy = (clipB.y - clipA.y) | 0;
      dx = (clipB.x - clipA.x) | 0;
      tmpY = (clipA.y + Math.trunc((dy * (fW - 1 - clipA.x)) / dx)) | 0;
      tmpX = fW - 1;
    } else {
      dy = (clipB.y - clipA.y) | 0;
      dx = (clipB.x - clipA.x) | 0;
      tmpY = (clipA.y + Math.trunc((dy * -clipA.x) / dx)) | 0;
      tmpX = 0;
    }

    if (outside === outcode1) {
      clipA.x = tmpX;
      clipA.y = tmpY;
      outcode1 = outcodeOf(clipA.x, clipA.y);
    } else {
      clipB.x = tmpX;
      clipB.y = tmpY;
      outcode2 = outcodeOf(clipB.x, clipB.y);
    }

    if (outcode1 & outcode2) return false;
  }

  return true;
}

/* ------------------------------------------------------------------ */
/* AM_drawFline (am_map.c:978-1049) — Bresenham, verbatim              */
/* ------------------------------------------------------------------ */

/**
 * Classic Bresenham w/ whatever optimizations needed for speed. The
 * `fuck` debug guard (endpoints outside the fb ⇒ vanilla fprintf+skip)
 * silently skips here — zero console noise is a hard e2e requirement.
 * Returns the number of PUTDOTs painted (0 when the guard trips) for
 * testability.
 */
export function amDrawFline(fb: Framebuffer, ax: number, ay: number, bx: number, by: number, color: number, fW: number, fH: number): number {
  if (ax < 0 || ax >= fW || ay < 0 || ay >= fH || bx < 0 || bx >= fW || by < 0 || by >= fH) {
    return 0; // vanilla: fprintf(stderr,"fuck...") — noise deliberately dropped
  }

  let x = ax;
  let y = ay;
  let painted = 0;
  const dx = bx - ax;
  const ax2 = 2 * (dx < 0 ? -dx : dx);
  const sx = dx < 0 ? -1 : 1;
  const dy = by - ay;
  const ay2 = 2 * (dy < 0 ? -dy : dy);
  const sy = dy < 0 ? -1 : 1;

  if (ax2 > ay2) {
    let d = ay2 - ax2 / 2;
    for (;;) {
      fb.point(x, y, color);
      painted++;
      if (x === bx) return painted;
      if (d >= 0) {
        y += sy;
        d -= ax2;
      }
      x += sx;
      d += ay2;
    }
  } else {
    let d = ax2 - ay2 / 2;
    for (;;) {
      fb.point(x, y, color);
      painted++;
      if (y === by) return painted;
      if (d >= 0) {
        x += sx;
        d -= ay2;
      }
      y += sy;
      d += ax2;
    }
  }
}

/** AM_drawMline: clip then rasterize (fb passed for the fline guard). */
export function amDrawMline(fb: Framebuffer, g: AutomapGeom, ax: number, ay: number, bx: number, by: number, color: number): void {
  if (amClipMline(g, ax, ay, bx, by)) {
    amDrawFline(fb, clipA.x, clipA.y, clipB.x, clipB.y, color, g.fW, g.fH);
  }
}

/* ------------------------------------------------------------------ */
/* AM_drawWalls (am_map.c:1117-1166)                                   */
/* ------------------------------------------------------------------ */

export function amDrawWalls(fb: Framebuffer, g: AutomapGeom, map: AutomapMap): void {
  const L = map.lines;
  const cheating = g.cheating;
  const lightlev = g.lightlev;
  for (let i = 0; i < L.count; i++) {
    const v1 = L.v1[i]!;
    const v2 = L.v2[i]!;
    const ax = map.verticesX[v1]!;
    const ay = map.verticesY[v1]!;
    const bx = map.verticesX[v2]!;
    const by = map.verticesY[v2]!;
    const flags = L.flags[i]!;
    // Vanilla guard: `cheating || (lines[i].flags & ML_MAPPED)`. M2-04 keeps
    // raw LINEDEF flags; vanilla's P_GroupLines stamps ML_MAPPED on every
    // line at setup ⇒ every existing line is "mapped" here (header note).
    {
      if ((flags & ML_DONTDRAW) !== 0 && !cheating) continue;
      const back = L.sectorBack[i]!;
      if (back < 0) {
        amDrawMline(fb, g, ax, ay, bx, by, WALLCOLORS + lightlev);
      } else {
        const front = L.sectorFront[i]!;
        if (L.special[i] === 39) {
          // teleporters
          amDrawMline(fb, g, ax, ay, bx, by, WALLCOLORS + WALLRANGE / 2);
        } else if ((flags & ML_SECRET) !== 0) {
          // secret door — SECRETWALLCOLORS === WALLCOLORS (am_map.c:81)
          amDrawMline(fb, g, ax, ay, bx, by, WALLCOLORS + lightlev);
        } else if (map.sectors.floorHeight[back] !== map.sectors.floorHeight[front]) {
          amDrawMline(fb, g, ax, ay, bx, by, FDWALLCOLORS + lightlev); // floor level change
        } else if (map.sectors.ceilingHeight[back] !== map.sectors.ceilingHeight[front]) {
          amDrawMline(fb, g, ax, ay, bx, by, CDWALLCOLORS + lightlev); // ceiling level change
        } else if (cheating) {
          amDrawMline(fb, g, ax, ay, bx, by, TSWALLCOLORS + lightlev);
        }
      }
    }
    // plr->powers[pw_allmap] GRAYS+3 branch: powers land post-M2 — no allmap
    // power exists yet, so the branch is unreachable (faithful no-op).
  }
}

/* ------------------------------------------------------------------ */
/* AM_drawGrid (am_map.c:1071-1111)                                    */
/* ------------------------------------------------------------------ */

/** The block stride in fixed: am_map.c's `MAPBLOCKUNITS<<FRACBITS` equals
 * core/constants MAPBLOCKUNITS (p_local.h MAPBLOCKSIZE = 128*FRACUNIT). */
export const AM_BLOCKSTRIDE = MAPBLOCKUNITS;

export function amDrawGrid(fb: Framebuffer, g: AutomapGeom, bmapOrgX: number, bmapOrgY: number): void {
  const color = GRIDCOLORS;

  // vertical gridlines
  let start = g.mX;
  const stride = AM_BLOCKSTRIDE;
  const modX = (start - bmapOrgX) % stride;
  if (modX) start += stride - modX;
  const endX = (g.mX + g.mW) | 0;
  for (let x = start; x < endX; x += stride) {
    amDrawMline(fb, g, x, g.mY, x, (g.mY + g.mH) | 0, color);
  }

  // horizontal gridlines
  start = g.mY;
  const modY = (start - bmapOrgY) % stride;
  if (modY) start += stride - modY;
  const endY = (g.mY + g.mH) | 0;
  for (let y = start; y < endY; y += stride) {
    amDrawMline(fb, g, g.mX, y, (g.mX + g.mW) | 0, y, color);
  }
}

/* ------------------------------------------------------------------ */
/* AM_rotate + AM_drawLineCharacter + player_arrow (am_map.c:158-171,  /*
/* 1172-1238, 1237-1259)                                              */
/* ------------------------------------------------------------------ */

/** AM_rotate — fixed-point 2D rotation by angle_t a. */
export function amRotateXY(x: number, y: number, a: number): readonly [number, number] {
  const fine = (a >>> ANGLETOFINESHIFT) & FINEMASK;
  const cos = finecosine[fine]!;
  const sin = finesine[fine]!;
  const tmpx = FixedMul(x, cos) - FixedMul(y, sin);
  const tmpy = FixedMul(x, sin) + FixedMul(y, cos);
  return [tmpx, tmpy];
}

// player_arrow[] vertices, R = (8*PLAYERRADIUS)/7 evaluated with C integer
// arithmetic (all quantities positive fixed, so / truncates toward zero):
//   { {-R+R/8,0}, {R,0} } { {R,0}, {R-R/2, R/4} } { {R,0}, {R-R/2,-R/4} }
//   { {-R+R/8,0}, {-R-R/8, R/4} } { {-R+R/8,0}, {-R-R/8,-R/4} }
//   { {-R+3R/8,0}, {-R+R/8, R/4} } { {-R+3R/8,0}, {-R+R/8,-R/4} }
const R = ((8 * PLAYERRADIUS) / 7) | 0;
const R8 = (R / 8) | 0;
const R2 = (R / 2) | 0;
const R4 = (R / 4) | 0;
const R38 = ((3 * R) / 8) | 0;

/** Flat [ax,ay,bx,by] segment list — NUMPLYRLINES = 7. */
export const PLAYER_ARROW_LINES: readonly number[] = [
  -R + R8, 0, R, 0,
  R, 0, R - R2, R4,
  R, 0, R - R2, -R4,
  -R + R8, 0, -R - R8, R4,
  -R + R8, 0, -R - R8, -R4,
  -R + R38, 0, -R + R8, R4,
  -R + R38, 0, -R + R8, -R4
];

/** AM_drawLineCharacter at scale=0 (the non-netgame player-arrow call). */
export function amDrawLineCharacter(
  fb: Framebuffer,
  g: AutomapGeom,
  lines: readonly number[],
  angle: number,
  color: number,
  x: number,
  y: number
): void {
  for (let i = 0; i < lines.length; i += 4) {
    let aax = lines[i]!;
    let aay = lines[i + 1]!;
    let bbx = lines[i + 2]!;
    let bby = lines[i + 3]!;
    if (angle) {
      [aax, aay] = amRotateXY(aax, aay, angle);
      [bbx, bby] = amRotateXY(bbx, bby, angle);
    }
    amDrawMline(fb, g, (aax + x) | 0, (aay + y) | 0, (bbx + x) | 0, (bby + y) | 0, color);
  }
}

/** AM_drawPlayers, single-player branch: WHITE player_arrow (no scale). */
export function amDrawPlayers(fb: Framebuffer, g: AutomapGeom, player: AutomapPlayer): void {
  // `cheating` cheat_player_arrow: unreachable via keys (amMap.ts note) and
  // identical geometry family — the plain arrow is the faithful path.
  amDrawLineCharacter(fb, g, PLAYER_ARROW_LINES, player.mo.angle, WHITE, player.mo.x, player.mo.y);
}

/* ------------------------------------------------------------------ */
/* AM_drawCrosshair (am_map.c:1327-1330) + AM_drawMarks (:1305)        */
/* ------------------------------------------------------------------ */

export function amDrawCrosshair(fb: Framebuffer, g: AutomapGeom): void {
  // fb[(f_w*(f_h+1))/2] = color — a FLAT buffer index into the full 320x200
  // `fb` (with f_w=320, f_h=168 that is fb[27040] = row 135, col 160 — the
  // vanilla single-point quirk, kept verbatim).
  fb.indices[(g.fW * (g.fH + 1)) / 2] = XHAIRCOLORS;
}

/** AM_drawMarks: markpoints are exposed in state; drawing them needs the
 * AMMNUM0..9 WAD patches through V_DrawPatch — FOLLOW-UP (patch blitter is
 * an M3/UI concern). Detection helper kept honest: */
export function amMarksExposed(g: AutomapGeom): boolean {
  return g.markpoints.some((m) => m.x !== -1);
}

/* ------------------------------------------------------------------ */
/* AM_Drawer (am_map.c:1332-1349)                                      */
/* ------------------------------------------------------------------ */

/**
 * One automap frame into `fb`. Returns false (nothing drawn) when the
 * automap is off — main.ts then presents the (black) buffer; the 3D view
 * replaces that branch when it lands.
 */
export function drawAutomap(fb: Framebuffer, g: AutomapGeom, map: AutomapMap, player: AutomapPlayer): boolean {
  if (!g.automapactive) return false;

  fb.clear(BACKGROUND); // AM_clearFB(BACKGROUND)
  if (g.grid) amDrawGrid(fb, g, map.blockmapOriginX, map.blockmapOriginY);
  amDrawWalls(fb, g, map);
  amDrawPlayers(fb, g, player);
  // AM_drawThings: cheating==2 only — unreachable (see amMap.ts).
  amDrawCrosshair(fb, g);
  // AM_drawMarks: needs AMMNUM patches via V_DrawPatch — FOLLOW-UP.
  // V_MarkRect(f_x,f_y,f_w,f_h): debug screen-border marker — dropped.
  return true;
}
