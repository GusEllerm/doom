// sim/amMap.ts — automap state machine, ported from am_map.c (linuxdoom-1.10;
// ARCHITECTURE §5.4, M2-plan §M2-08, R09 §5). State lives HERE (sim side);
// pixel rasterizing lives in render/automap.ts (M2-09).
//
// Ported 1:1 from the 1.10 sources, fixed point included:
//   * Follow mode is NORTH-UP and center-follow (AM_doFollowPlayer,
//     am_map.c:759-776): `m_x = FTOM(MTOF(plr->mo->x)) - m_w/2`. There is NO
//     rotation in linuxdoom-1.10 am_map.c — no fcosine/feather anywhere in
//     the file; the rotating automap is a later (v1.2/Boom-era) feature. The
//     FTOM(MTOF(x)) round-trip is intentionally NOT the identity (two
//     16.16 multiplies with a truncated reciprocal scale_mtof), and
//     f_oldloc short-circuits the recenter when the player has not moved.
//   * No am_lines[]/AM_addLine line list in 1.10 (that is the DOOM 2/Heretic
//     am_map.c): AM_drawWalls walks `lines[]` directly and calls
//     AM_clipMline per linedef. The equivalent here is amVisibleLines() +
//     amClipMline(), which stay geometry-only (color/class selection per
//     R09 §5 is M2-09's).
//   * AM_updateLightLev() is ported but NOT called from AM_Ticker — the
//     vanilla call is commented out (am_map.c:827), so `lightlev` stays 0 in
//     stock 1.10. R09 §5's "strobes every tic" describes the dead code.
//   * INITSCALEMTOF is .2*FRACUNIT = 13107 (NOT 16*FRACUNIT — that is
//     INITSCALEMTOT in st_stuff.c, a different, unrelated scale); it only
//     seeds the static before AM_LevelInit overwrites scale_mtof with
//     FixedDiv(min_scale_mtof, (int)(0.7*FRACUNIT)).
//   * AM_cheating: cheat_amap_seq = {0xb2,0x26,0x26,0x2e,0xff} is ported
//     verbatim with cht_CheckCheat's matcher (m_cheat.c). Quirk kept: that
//     byte sequence never matches typed ASCII keydowns, so `cheating` is
//     unreachable via keys in the released source (documented, not fixed).
//
// Determinism (§3.5): all state lives in the AutomapState record; no module
// mutable globals, no DOM, no wall clock, no PRNG (the lightlev strobe is
// tic-counter driven even where it exists).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { FRACUNIT, MAXINT } from '../core/constants';
import { FixedDiv, FixedMul } from '../core/fixed';

import type { RuntimeMap } from './map';
import type { Player } from './player';

/* ------------------------------------------------------------------ */
/* Constants (am_map.c / am_map.h / doomdef.h / p_local.h)             */
/* ------------------------------------------------------------------ */

/** am_map.c: `finit_width = SCREENWIDTH` (doomdef.h:110). */
export const AM_FRAME_WIDTH = 320;
/** am_map.c: `finit_height = SCREENHEIGHT - 32` (status bar rows). */
export const AM_FRAME_HEIGHT = 200 - 32;

/** am_map.c: `#define INITSCALEMTOF (.2*FRACUNIT)` → (int)13107.2 = 13107. */
export const INITSCALEMTOF = 13107;
/** am_map.c: `#define F_PANINC 4` (frame-buffer px per tic). */
export const F_PANINC = 4;
/** am_map.c: `M_ZOOMIN = (int)(1.02*FRACUNIT)` = (int)66846.72 = 66846. */
export const M_ZOOMIN = 66846;
/** am_map.c: `M_ZOOMOUT = (int)(FRACUNIT/1.02)` = (int)64250.98 = 64250. */
export const M_ZOOMOUT = 64250;
/** am_map.c: `#define AM_NUMMARKPOINTS 10`. */
export const AM_NUMMARKPOINTS = 10;
/** am_map.c AM_LevelInit: FixedDiv(min_scale_mtof, (int)(0.7*FRACUNIT)). */
export const AM_SEVENTY_PCT = 45875; // (int)(0.7*65536) = (int)45875.2
/** p_local.h:46 `PLAYERRADIUS 16*FRACUNIT` (min_w/min_h + max zoom). */
export const PLAYERRADIUS = 16 * FRACUNIT;

// Key map (am_map.c AM_*KEY defines → doomdef.h KEY_* codes; printable keys
// carry their ASCII value in event_t.data1).
export const AM_STARTKEY = 9; // KEY_TAB (toggle on/off)
export const AM_ENDKEY = 9; // KEY_TAB
export const AM_PANUPKEY = 0xad; // KEY_UPARROW
export const AM_PANDOWNKEY = 0xaf; // KEY_DOWNARROW
export const AM_PANLEFTKEY = 0xac; // KEY_LEFTARROW
export const AM_PANRIGHTKEY = 0xae; // KEY_RIGHTARROW
export const AM_ZOOMINKEY = 0x3d; // '=' (KEY_EQUALS)
export const AM_ZOOMOUTKEY = 0x2d; // '-' (KEY_MINUS)
export const AM_GOBIGKEY = 0x30; // '0'
export const AM_FOLLOWKEY = 0x66; // 'f'
export const AM_GRIDKEY = 0x67; // 'g'
export const AM_MARKKEY = 0x6d; // 'm'
export const AM_CLEARMARKKEY = 0x63; // 'c'

/** m_cheat.c-style cheatseq for the automap — am_map.c bytes verbatim. */
export const CHEAT_AMAP_SEQ: readonly number[] = [0xb2, 0x26, 0x26, 0x2e, 0xff];

/** am_map.c AM_updateLightLev: `litelevels[] = { 0,4,7,10,12,14,15,15 }`. */
export const LITELEVELS: readonly number[] = [0, 4, 7, 10, 12, 14, 15, 15];

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

/** One automark (mpoint_t markpoints[]); x === -1 means empty. */
export interface Markpoint {
  /** fixed (map coords), -1 = empty */
  x: number;
  /** fixed */
  y: number;
}

/**
 * The am_map.c statics, one record. Field names map to the C originals:
 * mX/mY/mX2/mY2 (window LL/UR, map fixed), mW/mH (window size fixed),
 * mPanIncX/Y (m_paninc), mtofZoommul/ftomZoommul, scaleMtof/scaleFtom,
 * minX..maxY + maxW/maxH (AM_findMinMaxBoundaries), minW/minH
 * (2*PLAYERRADIUS), minScaleMtof/maxScaleMtof (zoom clamps),
 * oldMX/oldMY/oldMW/oldMH (AM_saveScaleAndLoc), fOldlocX/Y (AM_doFollowPlayer
 * memo), amclock/lightlev (strobe counters), bigstate ('0' toggle),
 * cheatCount (cheatseq_t.count).
 *
 * Mode view (prompt/§5.4 vocabulary — the source keeps no mode enum):
 *   off    ⇔ !automapactive
 *   follow ⇔ automapactive &&  followplayer
 *   free   ⇔ automapactive && !followplayer   (pan with arrows)
 */
export interface AutomapState {
  /** am_map.c `automapactive`. */
  automapactive: boolean;
  /** am_map.c `stopped` (AM_Start/AM_Stop handshake). */
  stopped: boolean;

  // framebuffer window (screen px)
  fX: number;
  fY: number;
  fW: number;
  fH: number;

  amclock: number;
  lightlev: number;
  cheating: number;
  grid: number;
  followplayer: number;

  // per-tic deltas
  mPanIncX: number; // fixed
  mPanIncY: number; // fixed
  mtofZoommul: number; // fixed
  ftomZoommul: number; // fixed

  // map window
  mX: number; // fixed
  mY: number; // fixed
  mX2: number; // fixed
  mY2: number; // fixed
  mW: number; // fixed
  mH: number; // fixed

  // map extents + zoom range (AM_findMinMaxBoundaries)
  minX: number; // fixed
  minY: number; // fixed
  maxX: number; // fixed
  maxY: number; // fixed
  maxW: number; // fixed
  maxH: number; // fixed
  minW: number; // fixed
  minH: number; // fixed
  minScaleMtof: number; // fixed
  maxScaleMtof: number; // fixed

  // save/restore ('0' big-view toggle)
  oldMX: number; // fixed
  oldMY: number; // fixed
  oldMW: number; // fixed
  oldMH: number; // fixed

  // follower memo (f_oldloc)
  fOldlocX: number; // fixed
  fOldlocY: number; // fixed

  scaleMtof: number; // fixed
  scaleFtom: number; // fixed

  // marks
  markpoints: Markpoint[];
  markpointnum: number;

  // AM_Responder statics
  bigstate: number;
  cheatCount: number; // cheatseq_t.count

  // AM_updateLightLev statics (ported, call commented out like vanilla)
  lightNexttic: number;
  lightCnt: number;

  /** AM_Start's `lastlevel/lastepisode` stand-in: level-change memo. */
  lastMapName: string | null;
}

/** event_t (ev_keydown/ev_keyup slice) — the M2-07 DoomEvent seam feeds
 * `data1` = doomdef.h key code / ASCII char, exactly like vanilla. */
export interface AutomapEvent {
  readonly type: 'keydown' | 'keyup';
  /** event_t.data1 */
  readonly data1: number;
}

/** Keydown helper for event scripts. */
export const keydown = (data1: number): AutomapEvent => ({ type: 'keydown', data1 });
/** Keyup helper for event scripts. */
export const keyup = (data1: number): AutomapEvent => ({ type: 'keyup', data1 });

/** Whatever AM_Responder/AM_Ticker need beyond the automap state itself. */
export interface AutomapContext {
  readonly map: RuntimeMap;
  readonly player: Player;
}

/** Clipped line in framebuffer pixel coords (fline_t after AM_clipMline). */
export interface FLine {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/* ------------------------------------------------------------------ */
/* FTOM / MTOF (am_map.c:119-123)                                      */
/* ------------------------------------------------------------------ */

/** `FTOM(x) FixedMul(((x)<<16),scale_ftom)` — fb px → map fixed. */
export function amFtom(s: AutomapState, x: number): number {
  return FixedMul(x << 16, s.scaleFtom);
}

/** `MTOF(x) (FixedMul((x),scale_mtof)>>16)` — map fixed → fb px. */
export function amMtof(s: AutomapState, x: number): number {
  return FixedMul(x, s.scaleMtof) >> 16;
}

/** `CXMTOF(x) (f_x + MTOF((x)-m_x))`. */
export function amCxmtof(s: AutomapState, x: number): number {
  return s.fX + amMtof(s, (x - s.mX) | 0);
}

/** `CYMTOF(y) (f_y + (f_h - MTOF((y)-m_y)))` — map y is up, fb y is down. */
export function amCymtof(s: AutomapState, y: number): number {
  return s.fY + (s.fH - amMtof(s, (y - s.mY) | 0));
}

/* ------------------------------------------------------------------ */
/* Construction + AM_Start/AM_Stop                                     */
/* ------------------------------------------------------------------ */

/** The am_map.c file-scope statics at load time (all zeroed by the C
 * runtime except scale_mtof=INITSCALEMTOF, followplayer=1, stopped=true). */
export function amCreateState(): AutomapState {
  return {
    automapactive: false,
    stopped: true,
    fX: 0,
    fY: 0,
    fW: AM_FRAME_WIDTH,
    fH: AM_FRAME_HEIGHT,
    amclock: 0,
    lightlev: 0,
    cheating: 0,
    grid: 0,
    followplayer: 1,
    mPanIncX: 0,
    mPanIncY: 0,
    mtofZoommul: 0, // statics: zero until AM_initVariables
    ftomZoommul: 0,
    mX: 0,
    mY: 0,
    mX2: 0,
    mY2: 0,
    mW: 0,
    mH: 0,
    minX: 0,
    minY: 0,
    maxX: 0,
    maxY: 0,
    maxW: 0,
    maxH: 0,
    minW: 0,
    minH: 0,
    minScaleMtof: 0,
    maxScaleMtof: 0,
    oldMX: 0,
    oldMY: 0,
    oldMW: 0,
    oldMH: 0,
    fOldlocX: 0,
    fOldlocY: 0,
    scaleMtof: INITSCALEMTOF,
    scaleFtom: 0,
    markpoints: Array.from({ length: AM_NUMMARKPOINTS }, () => ({ x: 0, y: 0 })),
    markpointnum: 0,
    bigstate: 0,
    cheatCount: 0,
    lightNexttic: 0,
    lightCnt: 0,
    lastMapName: null
  };
}

/** AM_Stop (minus AM_unloadPics — AMMNUM patches are an M2-09/UI concern). */
export function amStop(s: AutomapState): void {
  // static event_t st_notify = { ev_keyup, AM_MSGEXITED } — HU/statusbar, later.
  s.automapactive = false;
  s.stopped = true;
}

/**
 * AM_Start: stop a previous session, AM_LevelInit on level change, then
 * AM_initVariables. `viewactive = false` is a render-side flag (M2-09 reads
 * automapactive instead); AM_loadPics (AMMNUM0..9) is likewise deferred.
 */
export function amStart(s: AutomapState, world: AutomapContext): void {
  if (!s.stopped) amStop(s);
  s.stopped = false;
  if (s.lastMapName !== world.map.name) {
    amLevelInit(s, world.map);
    s.lastMapName = world.map.name;
  }
  amInitVariables(s, world.player);
}

/** AM_LevelInit: fb window, clear marks, zoom range, entry scale
 * `FixedDiv(min_scale_mtof, 0.7*FRACUNIT)` clamped to max_scale_mtof. */
export function amLevelInit(s: AutomapState, map: RuntimeMap): void {
  s.fX = 0;
  s.fY = 0;
  s.fW = AM_FRAME_WIDTH; // finit_width
  s.fH = AM_FRAME_HEIGHT; // finit_height
  amClearMarks(s);
  amFindMinMaxBoundaries(s, map);
  let scale = FixedDiv(s.minScaleMtof, AM_SEVENTY_PCT);
  if (scale > s.maxScaleMtof) scale = s.minScaleMtof;
  s.scaleMtof = scale;
  s.scaleFtom = FixedDiv(FRACUNIT, s.scaleMtof);
}

/** AM_findMinMaxBoundaries: vertex bbox + zoom range. */
export function amFindMinMaxBoundaries(s: AutomapState, map: RuntimeMap): void {
  let minX = MAXINT;
  let minY = MAXINT;
  let maxX = -MAXINT;
  let maxY = -MAXINT;
  for (let i = 0; i < map.numVertexes; i++) {
    const x = map.verticesX[i]!;
    const y = map.verticesY[i]!;
    if (x < minX) minX = x;
    else if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    else if (y > maxY) maxY = y;
  }
  s.minX = minX;
  s.minY = minY;
  s.maxX = maxX;
  s.maxY = maxY;
  s.maxW = (maxX - minX) | 0;
  s.maxH = (maxY - minY) | 0;
  s.minW = 2 * PLAYERRADIUS; // "const? never changed?"
  s.minH = 2 * PLAYERRADIUS;

  const a = FixedDiv(s.fW << 16, s.maxW);
  const b = FixedDiv(s.fH << 16, s.maxH);
  s.minScaleMtof = a < b ? a : b;
  s.maxScaleMtof = FixedDiv(s.fH << 16, 2 * PLAYERRADIUS);
}

/** AM_clearMarks: x = -1 means empty, next mark index 0. */
export function amClearMarks(s: AutomapState): void {
  for (const m of s.markpoints) m.x = -1; // y untouched, like the C loop
  s.markpointnum = 0;
}

/** AM_initVariables (minus ST_Responder notify — status bar is M2-09/UI):
 * fresh window at the player, zoom/pan multipliers neutral. */
export function amInitVariables(s: AutomapState, player: Player): void {
  s.automapactive = true;
  s.fOldlocX = MAXINT;
  s.fOldlocY = 0;
  s.amclock = 0;
  s.lightlev = 0;

  s.mPanIncX = 0;
  s.mPanIncY = 0;
  s.mtofZoommul = FRACUNIT;
  s.ftomZoommul = FRACUNIT;

  s.mW = amFtom(s, s.fW);
  s.mH = amFtom(s, s.fH);

  // vanilla picks consoleplayer's (or the first) playing slot; single-player
  // that is always players[0].
  s.mX = (player.mo.x - (s.mW >> 1)) | 0;
  s.mY = (player.mo.y - (s.mH >> 1)) | 0;
  amChangeWindowLoc(s);

  s.oldMX = s.mX;
  s.oldMY = s.mY;
  s.oldMW = s.mW;
  s.oldMH = s.mH;
}

/* ------------------------------------------------------------------ */
/* Window geometry helpers                                             */
/* ------------------------------------------------------------------ */

/** AM_activateNewScale: keep the window center, re-derive size from scale. */
export function amActivateNewScale(s: AutomapState): void {
  s.mX = (s.mX + (s.mW >> 1)) | 0;
  s.mY = (s.mY + (s.mH >> 1)) | 0;
  s.mW = amFtom(s, s.fW);
  s.mH = amFtom(s, s.fH);
  s.mX = (s.mX - (s.mW >> 1)) | 0;
  s.mY = (s.mY - (s.mH >> 1)) | 0;
  s.mX2 = (s.mX + s.mW) | 0;
  s.mY2 = (s.mY + s.mH) | 0;
}

/** AM_saveScaleAndLoc. */
export function amSaveScaleAndLoc(s: AutomapState): void {
  s.oldMX = s.mX;
  s.oldMY = s.mY;
  s.oldMW = s.mW;
  s.oldMH = s.mH;
}

/** AM_restoreScaleAndLoc. */
export function amRestoreScaleAndLoc(s: AutomapState, player: Player): void {
  s.mW = s.oldMW;
  s.mH = s.oldMH;
  if (!s.followplayer) {
    s.mX = s.oldMX;
    s.mY = s.oldMY;
  } else {
    s.mX = (player.mo.x - (s.mW >> 1)) | 0;
    s.mY = (player.mo.y - (s.mH >> 1)) | 0;
  }
  s.mX2 = (s.mX + s.mW) | 0;
  s.mY2 = (s.mY + s.mH) | 0;
  s.scaleMtof = FixedDiv(s.fW << 16, s.mW);
  s.scaleFtom = FixedDiv(FRACUNIT, s.scaleMtof);
}

/** AM_addMark: mark the window center; FIFO-evicts at AM_NUMMARKPOINTS. */
export function amAddMark(s: AutomapState): void {
  s.markpoints[s.markpointnum]!.x = (s.mX + (s.mW >> 1)) | 0;
  s.markpoints[s.markpointnum]!.y = (s.mY + (s.mH >> 1)) | 0;
  s.markpointnum = (s.markpointnum + 1) % AM_NUMMARKPOINTS;
}

/** AM_minOutWindowScale: zoom fully out (see whole map). */
export function amMinOutWindowScale(s: AutomapState): void {
  s.scaleMtof = s.minScaleMtof;
  s.scaleFtom = FixedDiv(FRACUNIT, s.scaleMtof);
  amActivateNewScale(s);
}

/** AM_maxOutWindowScale: zoom fully in (2*PLAYERRADIUS tall). */
export function amMaxOutWindowScale(s: AutomapState): void {
  s.scaleMtof = s.maxScaleMtof;
  s.scaleFtom = FixedDiv(FRACUNIT, s.scaleMtof);
  amActivateNewScale(s);
}

/** AM_changeWindowScale: apply the zoom multipliers, clamp at min/max. */
export function amChangeWindowScale(s: AutomapState): void {
  s.scaleMtof = FixedMul(s.scaleMtof, s.mtofZoommul);
  s.scaleFtom = FixedDiv(FRACUNIT, s.scaleMtof);
  if (s.scaleMtof < s.minScaleMtof) amMinOutWindowScale(s);
  else if (s.scaleMtof > s.maxScaleMtof) amMaxOutWindowScale(s);
  else amActivateNewScale(s);
}

/** AM_changeWindowLoc: apply pan, stop following when panning, clamp to map. */
export function amChangeWindowLoc(s: AutomapState): void {
  if (s.mPanIncX || s.mPanIncY) {
    s.followplayer = 0;
    s.fOldlocX = MAXINT;
  }
  s.mX = (s.mX + s.mPanIncX) | 0;
  s.mY = (s.mY + s.mPanIncY) | 0;

  if ((s.mX + (s.mW >> 1)) > s.maxX) s.mX = (s.maxX - (s.mW >> 1)) | 0;
  else if ((s.mX + (s.mW >> 1)) < s.minX) s.mX = (s.minX - (s.mW >> 1)) | 0;

  if ((s.mY + (s.mH >> 1)) > s.maxY) s.mY = (s.maxY - (s.mH >> 1)) | 0;
  else if ((s.mY + (s.mH >> 1)) < s.minY) s.mY = (s.minY - (s.mH >> 1)) | 0;

  s.mX2 = (s.mX + s.mW) | 0;
  s.mY2 = (s.mY + s.mH) | 0;
}

/** AM_doFollowPlayer — north-up center-follow; the FTOM(MTOF(...))
 * round-trip (not a plain copy) and the f_oldloc memo are ported verbatim.
 * No rotation: 1.10 has none. */
export function amDoFollowPlayer(s: AutomapState, player: Player): void {
  if (s.fOldlocX !== player.mo.x || s.fOldlocY !== player.mo.y) {
    s.mX = (amFtom(s, amMtof(s, player.mo.x)) - (s.mW >> 1)) | 0;
    s.mY = (amFtom(s, amMtof(s, player.mo.y)) - (s.mH >> 1)) | 0;
    s.mX2 = (s.mX + s.mW) | 0;
    s.mY2 = (s.mY + s.mH) | 0;
    s.fOldlocX = player.mo.x;
    s.fOldlocY = player.mo.y;
  }
}

/** AM_updateLightLev — ported verbatim (statics in state) but NOT called by
 * amTicker: the call is commented out in the released am_map.c (line 827),
 * so vanilla 1.10 lightlev stays 0. Kept for a faithful diff + a possible
 * future "funky strobing" toggle. */
export function amUpdateLightLev(s: AutomapState): void {
  if (s.amclock > s.lightNexttic) {
    s.lightlev = LITELEVELS[s.lightCnt++]!;
    if (s.lightCnt === LITELEVELS.length) s.lightCnt = 0;
    s.lightNexttic = s.amclock + 6 - (s.amclock % 6);
  }
}

/* ------------------------------------------------------------------ */
/* AM_Responder                                                        */
/* ------------------------------------------------------------------ */

/** cht_CheckCheat (m_cheat.c), non-chat branch, verbatim. */
function chtCheckCheat(s: AutomapState, ch: number): boolean {
  if (ch === CHEAT_AMAP_SEQ[s.cheatCount]) {
    s.cheatCount++;
    if (!CHEAT_AMAP_SEQ[s.cheatCount]) {
      s.cheatCount = 0;
      return true;
    }
  } else {
    s.cheatCount = 0;
  }
  return false;
}

/**
 * AM_Responder. Returns true = event consumed (must not reach G_Responder).
 * `plr->message = AMSTR_*` assignments are dropped (HUD messages land with
 * the status-bar/HU task); everything else is line-for-line. The vanilla
 * `viewactive` side effects are render flags: consumers read
 * `state.automapactive`.
 */
export function amResponder(s: AutomapState, ev: AutomapEvent, world: AutomapContext): boolean {
  let rc = false;

  if (!s.automapactive) {
    if (ev.type === 'keydown' && ev.data1 === AM_STARTKEY) {
      amStart(s, world);
      // viewactive = false (render-side; M2-09)
      rc = true;
    }
  } else if (ev.type === 'keydown') {
    rc = true;
    switch (ev.data1) {
      case AM_PANRIGHTKEY:
        if (!s.followplayer) s.mPanIncX = amFtom(s, F_PANINC);
        else rc = false;
        break;
      case AM_PANLEFTKEY:
        if (!s.followplayer) s.mPanIncX = -amFtom(s, F_PANINC);
        else rc = false;
        break;
      case AM_PANUPKEY:
        if (!s.followplayer) s.mPanIncY = amFtom(s, F_PANINC);
        else rc = false;
        break;
      case AM_PANDOWNKEY:
        if (!s.followplayer) s.mPanIncY = -amFtom(s, F_PANINC);
        else rc = false;
        break;
      case AM_ZOOMOUTKEY:
        s.mtofZoommul = M_ZOOMOUT;
        s.ftomZoommul = M_ZOOMIN;
        break;
      case AM_ZOOMINKEY:
        s.mtofZoommul = M_ZOOMIN;
        s.ftomZoommul = M_ZOOMOUT;
        break;
      case AM_ENDKEY:
        s.bigstate = 0;
        // viewactive = true (render-side; M2-09)
        amStop(s);
        break;
      case AM_GOBIGKEY:
        s.bigstate = s.bigstate ? 0 : 1;
        if (s.bigstate) {
          amSaveScaleAndLoc(s);
          amMinOutWindowScale(s);
        } else {
          amRestoreScaleAndLoc(s, world.player);
        }
        break;
      case AM_FOLLOWKEY:
        s.followplayer = s.followplayer ? 0 : 1;
        s.fOldlocX = MAXINT;
        break;
      case AM_GRIDKEY:
        s.grid = s.grid ? 0 : 1;
        break;
      case AM_MARKKEY:
        // plr->message = AMSTR_MARKEDSPOT + markpointnum — HU task.
        amAddMark(s);
        break;
      case AM_CLEARMARKKEY:
        amClearMarks(s);
        break;
      default:
        // static cheatstate = 0; (write-only in the original — dropped)
        rc = false;
    }
    // if (!deathmatch && cht_CheckCheat(&cheat_amap, ev->data1)) — single
    // player ⇒ deathmatch is false.
    if (chtCheckCheat(s, ev.data1)) {
      rc = false;
      s.cheating = (s.cheating + 1) % 3;
    }
  } else {
    rc = false;
    switch (ev.data1) {
      case AM_PANRIGHTKEY:
      case AM_PANLEFTKEY:
        if (!s.followplayer) s.mPanIncX = 0;
        break;
      case AM_PANUPKEY:
      case AM_PANDOWNKEY:
        if (!s.followplayer) s.mPanIncY = 0;
        break;
      case AM_ZOOMOUTKEY:
      case AM_ZOOMINKEY:
        s.mtofZoommul = FRACUNIT;
        s.ftomZoommul = FRACUNIT;
        break;
      default:
        break;
    }
  }

  return rc;
}

/** Mode setter for later input wiring (the vanilla equivalent is the 'f'
 * key through AM_Responder; same f_oldloc invalidation). */
export function amSetFollow(s: AutomapState, follow: boolean): void {
  s.followplayer = follow ? 1 : 0;
  s.fOldlocX = MAXINT;
}

/* ------------------------------------------------------------------ */
/* AM_Ticker                                                           */
/* ------------------------------------------------------------------ */

/** AM_Ticker — one tic of automap evolution (§3.2 GS_LEVEL item). */
export function amTicker(s: AutomapState, player: Player): void {
  if (!s.automapactive) return;

  s.amclock++;

  if (s.followplayer) amDoFollowPlayer(s, player);

  if (s.ftomZoommul !== FRACUNIT) amChangeWindowScale(s);

  if (s.mPanIncX || s.mPanIncY) amChangeWindowLoc(s);

  // AM_updateLightLev(); — commented out in vanilla am_map.c:827, kept so.
}

/* ------------------------------------------------------------------ */
/* Viewport for the renderer                                           */
/* ------------------------------------------------------------------ */

/** Map-space window rect (fixed). */
export interface AutomapView {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

/** m_x..m_y2 — the window the renderer must rasterize into f_w×f_h px. */
export function amViewBounds(s: AutomapState): AutomapView {
  return { left: s.mX, bottom: s.mY, right: s.mX2, top: s.mY2 };
}

/**
 * AM_clipMline (am_map.c:826-966) verbatim: trivial rejects in map coords,
 * transform via CXMTOF/CYMTOF, Cohen-Sutherland-style loop with C-truncating
 * integer divisions. Non-crash divergence: a zero denominators case would
 * SIGFPE in C; JS yields Infinity/NaN whose outcodes are 0, which exits the
 * loop and reports "visible" instead of killing the process.
 */
export function amClipMline(
  s: AutomapState,
  ax: number,
  ay: number,
  bx: number,
  by: number
): FLine | null {
  const LEFT = 1;
  const RIGHT = 2;
  const BOTTOM = 4;
  const TOP = 8;

  let outcode1 = 0;
  let outcode2 = 0;
  let outside: number;
  let dx: number;
  let dy: number;

  if (ay > s.mY2) outcode1 = TOP;
  else if (ay < s.mY) outcode1 = BOTTOM;

  if (by > s.mY2) outcode2 = TOP;
  else if (by < s.mY) outcode2 = BOTTOM;

  if (outcode1 & outcode2) return null; // trivially outside

  if (ax < s.mX) outcode1 |= LEFT;
  else if (ax > s.mX2) outcode1 |= RIGHT;

  if (bx < s.mX) outcode2 |= LEFT;
  else if (bx > s.mX2) outcode2 |= RIGHT;

  if (outcode1 & outcode2) return null; // trivially outside

  // transform to frame-buffer coordinates
  let flax = amCxmtof(s, ax);
  let flay = amCymtof(s, ay);
  let flbx = amCxmtof(s, bx);
  let flby = amCymtof(s, by);

  const doOutcode = (x: number, y: number): number => {
    let oc = 0;
    if (y < 0) oc |= TOP;
    else if (y >= s.fH) oc |= BOTTOM;
    if (x < 0) oc |= LEFT;
    else if (x >= s.fW) oc |= RIGHT;
    return oc;
  };

  outcode1 = doOutcode(flax, flay);
  outcode2 = doOutcode(flbx, flby);

  if (outcode1 & outcode2) return null;

  while (outcode1 | outcode2) {
    // may be partially inside box — find an outside point
    outside = outcode1 ? outcode1 : outcode2;

    // clip to each side (vanilla always anchors at a's coords — quirk kept)
    let tmpX: number;
    let tmpY: number;
    if (outside & TOP) {
      dy = (flay - flby) | 0;
      dx = (flbx - flax) | 0;
      tmpX = (flax + Math.trunc((dx * flay) / dy)) | 0;
      tmpY = 0;
    } else if (outside & BOTTOM) {
      dy = (flay - flby) | 0;
      dx = (flbx - flax) | 0;
      tmpX = (flax + Math.trunc((dx * (flay - s.fH)) / dy)) | 0;
      tmpY = s.fH - 1;
    } else if (outside & RIGHT) {
      dy = (flby - flay) | 0;
      dx = (flbx - flax) | 0;
      tmpY = (flay + Math.trunc((dy * (s.fW - 1 - flax)) / dx)) | 0;
      tmpX = s.fW - 1;
    } else {
      // outside & LEFT
      dy = (flby - flay) | 0;
      dx = (flbx - flax) | 0;
      tmpY = (flay + Math.trunc((dy * -flax) / dx)) | 0;
      tmpX = 0;
    }

    if (outside === outcode1) {
      flax = tmpX;
      flay = tmpY;
      outcode1 = doOutcode(flax, flay);
    } else {
      flbx = tmpX;
      flby = tmpY;
      outcode2 = doOutcode(flbx, flby);
    }

    if (outcode1 & outcode2) return null; // trivially outside
  }

  return { ax: flax, ay: flay, bx: flbx, by: flby };
}

/**
 * The linedef slice the renderer should rasterize: indices of linedefs whose
 * segment intersects the current window, i.e. AM_drawWalls' per-line
 * `AM_clipMline` predicate. Geometry only — ML_DONTDRAW/secret/cheating
 * visibility policy belongs to the renderer (M2-09/R09 §5). Requires a
 * window/scale consistent pair (as maintained by the state machine; the
 * map-coord reject AND the fb-coord transform both define visibility).
 */
export function amVisibleLines(s: AutomapState, map: RuntimeMap): number[] {
  const out: number[] = [];
  const L = map.lines;
  for (let i = 0; i < L.count; i++) {
    const v1 = L.v1[i]!;
    const v2 = L.v2[i]!;
    if (amClipMline(s, map.verticesX[v1]!, map.verticesY[v1]!, map.verticesX[v2]!, map.verticesY[v2]!)) {
      out.push(i);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* hashAutomapState — determinism golden hook (§3.4 style, FNV-1a)     */
/* ------------------------------------------------------------------ */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** FNV-1a u32 over the int32 serialization of every numeric field. */
export function hashAutomapState(s: AutomapState): number {
  const n = 44 + s.markpoints.length * 2;
  const buf = new ArrayBuffer(n * 4);
  const dv = new DataView(buf);
  let o = 0;
  const put = (v: number): void => {
    dv.setInt32(o, v | 0, true);
    o += 4;
  };
  put(s.automapactive ? 1 : 0);
  put(s.stopped ? 1 : 0);
  put(s.fX);
  put(s.fY);
  put(s.fW);
  put(s.fH);
  put(s.amclock);
  put(s.lightlev);
  put(s.cheating);
  put(s.grid);
  put(s.followplayer);
  put(s.mPanIncX);
  put(s.mPanIncY);
  put(s.mtofZoommul);
  put(s.ftomZoommul);
  put(s.mX);
  put(s.mY);
  put(s.mX2);
  put(s.mY2);
  put(s.mW);
  put(s.mH);
  put(s.minX);
  put(s.minY);
  put(s.maxX);
  put(s.maxY);
  put(s.maxW);
  put(s.maxH);
  put(s.minW);
  put(s.minH);
  put(s.minScaleMtof);
  put(s.maxScaleMtof);
  put(s.oldMX);
  put(s.oldMY);
  put(s.oldMW);
  put(s.oldMH);
  put(s.fOldlocX);
  put(s.fOldlocY);
  put(s.scaleMtof);
  put(s.scaleFtom);
  put(s.markpointnum);
  put(s.bigstate);
  put(s.cheatCount);
  put(s.lightNexttic);
  put(s.lightCnt);
  for (const m of s.markpoints) {
    put(m.x);
    put(m.y);
  }
  let h = FNV_OFFSET;
  for (let i = 0; i < buf.byteLength; i++) {
    h ^= dv.getUint8(i)!;
    h = Math.imul(h, FNV_PRIME);
  }
  return h >>> 0;
}
