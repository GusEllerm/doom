// render/wiDraw.ts — wi_stuff.c DRAWER half (M9-plan §M9-07 / §0.9):
// WI_loadData (:1538), WI_slamBackground (:406), WI_drawLF/EL (:421/:439),
// WI_drawOnLnode (:455), WI_drawAnimatedBack (:583), WI_drawNum (:668),
// WI_drawPercent (:637), WI_drawTime (:687), WI_drawStats (:1436),
// WI_drawShowNextLoc (:771), WI_drawNoState (:812), WI_Drawer dispatch
// (:1772). All blits go through vvideo (V_DrawPatch — raw palette bytes,
// full-bright, no CRANG/TRANMAP in 1.10, §0.11). The counters come from
// sim/wintermission.ts via wiDrawSnapshot() — this module decides NO
// state, it only paints (D_Drawer-after-G_Ticker order, M9-09).
//
// Backgrounds (§0.9): episodic WI is ALWAYS the WIMAP<epsd> world-map
// slam — there is NO "interlude flats" screen in DOOM 1: the
// G_DoInterlude/FLOOR-flat interlude is the COMMERCIAL-only f_wipe
// filler path (g_game.c:1114 wminle? — the 1.9 release source has no
// interlude at all; the level-to-level transition IS
// GS_INTERMISSION + the display melt, §0.11). The interlude-vs-
// intermission split therefore collapses to: WI here, wipe melt in the
// display block (M9-09). WI provider seam mapname→pic: epsd→WIMAP0/1/2
// (retail epsd3→INTERPIC is §4-unreached under the shareware policy).
//
// DEVIATIONS (documented):
//  * Patch "caching": lumpPatch decodes once per (wad,name) — the
//    WI_unloadData Z_ChangeTag(PU_CACHE) half of WI_End has nothing to
//    free (cache semantics, sim-side note).
//  * The netgame/deathmatch drawer branches are §4-unreached.
//  * Vanilla builds WIA anim lump names with "WIA%d%.2d%.2d" (space
//    padded); the SHIPPED lumps (measured, 58 in freedoom1.wad) are
//    ZERO padded — the name builder here pads with zeros (data-driven).
//  * WI_loadData's commercial `INTERPIC` + retail epsd3 rename keep the
//    source shape but epsd>2 never occurs under GAME_MODE=shareware.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { wiDrawSnapshot, WI_EPSD_ANIMS, type WiDrawSnapshot } from '../sim/wintermission';
import type { WadFile } from '../wad/wadfile';
import {
  FG,
  SCREENHEIGHT,
  SCREENWIDTH,
  lumpPatch,
  screens,
  vDrawPatch,
  vMarkRect,
  type VPatch
} from './vvideo';

/* wi_stuff.c:74-87 constants */
const WI_TITLEY = 2;
const SP_STATSX = 50;
const SP_STATSY = 50;
const SP_TIMEX = 16;
const SP_TIMEY = SCREENHEIGHT - 32; // (SCREENHEIGHT-32) = 168

/** lnodes[NUMEPISODES][NUMMAPS] (wi_stuff.c:166-215) — draw-side only. */
export const WI_LNODES: readonly (readonly (readonly [number, number])[])[] = [
  [
    [185, 164], [148, 143], [69, 122], [209, 102], [116, 89],
    [166, 55], [71, 56], [135, 29], [71, 24]
  ],
  [
    [254, 25], [97, 50], [188, 64], [128, 78], [214, 92],
    [133, 130], [208, 136], [148, 140], [235, 158]
  ],
  [
    [156, 168], [48, 154], [174, 95], [265, 75], [130, 48],
    [279, 23], [198, 48], [140, 25], [281, 136]
  ]
];

/* ------------------------------------------------------------------ */
/* patch source seam (wad-backed in production, Map-backed in tests)   */
/* ------------------------------------------------------------------ */

export interface WiPatchSource {
  patch(name: string): VPatch;
}

/** Production source: decoded-lump cache over a WadFile (vvideo
 * lumpPatch, one decode per name). */
export function wadWiPatches(wad: WadFile): WiPatchSource {
  return { patch: (name) => lumpPatch(wad, name) };
}

/** Test/static-map source. */
export function mapWiPatches(byName: ReadonlyMap<string, VPatch>): WiPatchSource {
  return { patch: (name) => {
    const p = byName.get(name.toUpperCase());
    if (!p) throw new Error(`wiDraw: missing patch ${name}`);
    return p;
  } };
}

export interface WiGraphics {
  readonly bg: VPatch;
  readonly lnames: readonly VPatch[]; // WILV<epsd>0..8
  readonly yah: readonly [VPatch, VPatch];
  readonly splat: VPatch;
  readonly percent: VPatch;
  readonly colon: VPatch;
  readonly num: readonly VPatch[]; // WINUM0..9
  readonly wiminus: VPatch;
  readonly finished: VPatch;
  readonly entering: VPatch;
  readonly spSecret: VPatch; // WISCRT2
  readonly kills: VPatch; // WIOSTK
  readonly items: VPatch; // WIOSTI
  readonly timeP: VPatch; // WITIME
  readonly par: VPatch; // WIPAR
  readonly sucks: VPatch; // WISUCKS
}

const cache = new WeakMap<WiPatchSource, { epsd: number; g: WiGraphics }>();

/** WIA frame-patch name (see header: zero-padded, measured). */
export function wiaName(epsd: number, animIndex: number, frame: number): string {
  // "HACK ALERT!" (wi_stuff.c:1611-1620): epsd1 anim 8 aliases anim 4.
  const j = epsd === 1 && animIndex === 8 ? 4 : animIndex;
  const p2 = (n: number): string => String(n).padStart(2, '0');
  return `WIA${epsd}${p2(j)}${p2(frame)}`;
}

/** WI_loadData (:1538-1557): cache the SP patch set AND slam the WIMAP
 * background into screens[1] (V_DrawPatch(0,0,1,bg)) — the
 * WI_slamBackground source. Idempotent per (source, epsd). */
export function wiLoadData(src: WiPatchSource, epsd: number): WiGraphics {
  const hit = cache.get(src);
  if (hit !== undefined && hit.epsd === epsd) return hit.g;

  const name = epsd >= 3 ? 'INTERPIC' : `WIMAP${epsd}`; // retail half, §4
  const bg = src.patch(name);
  vDrawPatch(0, 0, 1, bg); // screens[1] back buffer

  const g: WiGraphics = {
    bg,
    lnames: Array.from({ length: 9 }, (_, i) => src.patch(`WILV${epsd}${i}`)),
    yah: [src.patch('WIURH0'), src.patch('WIURH1')],
    splat: src.patch('WISPLAT'),
    percent: src.patch('WIPCNT'),
    colon: src.patch('WICOLON'),
    num: Array.from({ length: 10 }, (_, d) => src.patch(`WINUM${d}`)),
    wiminus: src.patch('WIMINUS'),
    finished: src.patch('WIF'),
    entering: src.patch('WIENTER'),
    spSecret: src.patch('WISCRT2'),
    kills: src.patch('WIOSTK'),
    items: src.patch('WIOSTI'),
    timeP: src.patch('WITIME'),
    par: src.patch('WIPAR'),
    sucks: src.patch('WISUCKS')
  };
  cache.set(src, { epsd, g });
  return g;
}

/* ------------------------------------------------------------------ */
/* drawing primitives (verbatim geometry)                              */
/* ------------------------------------------------------------------ */

/** WI_slamBackground (:406): memcpy(screens[0], screens[1]). */
export function wiSlamBackground(): void {
  screens[FG]!.data.set(screens[1]!.data);
  vMarkRect(0, 0, SCREENWIDTH, SCREENHEIGHT);
}

/** WI_drawLF (:421): "<Levelname>" + "Finished!" (5/4-height step). */
export function wiDrawLF(g: WiGraphics, snap: WiDrawSnapshot): void {
  let y = WI_TITLEY;
  const l = g.lnames[snap.last]!;
  vDrawPatch((SCREENWIDTH - l.width) / 2, y, FG, l);
  y += Math.trunc((5 * l.height) / 4);
  vDrawPatch((SCREENWIDTH - g.finished.width) / 2, y, FG, g.finished);
}

/** WI_drawEL (:439): "Entering" + "<Levelname>" (5/4-height step). */
export function wiDrawEL(g: WiGraphics, snap: WiDrawSnapshot): void {
  let y = WI_TITLEY;
  vDrawPatch((SCREENWIDTH - g.entering.width) / 2, y, FG, g.entering);
  const l = g.lnames[snap.next]!;
  y += Math.trunc((5 * l.height) / 4);
  vDrawPatch((SCREENWIDTH - l.width) / 2, y, FG, l);
}

/** WI_drawOnLnode (:455): fits-first-of-{c[0],c[1]} at lnodes[epsd][n]. */
export function wiDrawOnLnode(
  snap: WiDrawSnapshot, n: number, patches: readonly VPatch[]
): void {
  const [lx, ly] = WI_LNODES[snap.epsd]![n]!;
  let i = 0;
  let fits = false;
  do {
    const c = patches[i]!;
    const left = lx - c.leftOffset;
    const top = ly - c.topOffset;
    const right = left + c.width;
    const bottom = top + c.height;
    if (left >= 0 && right < SCREENWIDTH && top >= 0 && bottom < SCREENHEIGHT) {
      fits = true;
    } else {
      i++;
    }
  } while (!fits && i !== 2);

  if (fits && i < 2) {
    vDrawPatch(lx, ly, FG, patches[i]!);
  }
  // vanilla else-branch printf("Could not place patch…") — stderr-free
  // port: silently unfits (never happens with the shipped WISPLAT/WIURH).
}

/** WI_drawAnimatedBack (:583): frame patches of every anim with ctr>=0. */
export function wiDrawAnimatedBack(src: WiPatchSource, snap: WiDrawSnapshot): void {
  if (snap.epsd > 2) return;
  const table = WI_EPSD_ANIMS[snap.epsd] ?? [];
  for (let i = 0; i < table.length; i++) {
    const a = snap.anims[i]!;
    if (a.ctr >= 0) vDrawPatch(a.x, a.y, FG, src.patch(wiaName(snap.epsd, i, a.ctr)));
  }
}

/** WI_drawNum (:668): right-justified LSB-first digits; 1994 = "n/a"
 * skip; minus when negative. Returns the new (left edge) x. */
export function wiDrawNum(
  g: WiGraphics, x: number, y: number, n: number, digits: number
): number {
  const fontwidth = g.num[0]!.width;
  let neg: boolean;
  let t = n;

  if (digits < 0) {
    if (!t) {
      digits = 1; // variable-length zeros are 1 digit long
    } else {
      digits = 0;
      let temp = t;
      while (temp) {
        temp = Math.trunc(temp / 10);
        digits++;
      }
    }
  }

  neg = t < 0;
  if (neg) t = -t;

  // if non-number, do not draw it (stlib 1994 idiom)
  if (t === 1994) return 0;

  while (digits-- > 0) {
    x -= fontwidth;
    vDrawPatch(x, y, FG, g.num[Math.trunc(t) % 10]!);
    t = Math.trunc(t / 10);
  }

  if (neg) vDrawPatch((x -= 8), y, FG, g.wiminus);

  return x;
}

/** WI_drawPercent (:637): negative percent = nothing. */
export function wiDrawPercent(
  g: WiGraphics, x: number, y: number, p: number
): void {
  if (p < 0) return;
  vDrawPatch(x, y, FG, g.percent);
  wiDrawNum(g, x, y, p, -1);
}

/** WI_drawTime (:687): base-60 split, "sucks" past 61*59. */
export function wiDrawTime(g: WiGraphics, x: number, y: number, t: number): void {
  if (t < 0) return;

  if (t <= 61 * 59) {
    let div = 1;
    do {
      const n = Math.trunc(t / div) % 60;
      x = wiDrawNum(g, x, y, n, 2) - g.colon.width;
      div *= 60;
      if (div === 60 || Math.trunc(t / div)) vDrawPatch(x, y, FG, g.colon);
    } while (Math.trunc(t / div));
  } else {
    // "sucks"
    vDrawPatch(x - g.sucks.width, y, FG, g.sucks);
  }
}

/** WI_drawStats (:1436). */
export function wiDrawStats(src: WiPatchSource, g: WiGraphics, snap: WiDrawSnapshot): void {
  const lh = Math.trunc((3 * g.num[0]!.height) / 2); // line height

  wiSlamBackground();
  wiDrawAnimatedBack(src, snap);
  wiDrawLF(g, snap);

  vDrawPatch(SP_STATSX, SP_STATSY, FG, g.kills);
  wiDrawPercent(g, SCREENWIDTH - SP_STATSX, SP_STATSY, snap.cntKills);

  vDrawPatch(SP_STATSX, SP_STATSY + lh, FG, g.items);
  wiDrawPercent(g, SCREENWIDTH - SP_STATSX, SP_STATSY + lh, snap.cntItems);

  vDrawPatch(SP_STATSX, SP_STATSY + 2 * lh, FG, g.spSecret);
  wiDrawPercent(g, SCREENWIDTH - SP_STATSX, SP_STATSY + 2 * lh, snap.cntSecret);

  vDrawPatch(SP_TIMEX, SP_TIMEY, FG, g.timeP);
  wiDrawTime(g, SCREENWIDTH / 2 - SP_TIMEX, SP_TIMEY, snap.cntTime);

  if (snap.epsd < 3) {
    vDrawPatch(SCREENWIDTH / 2 + SP_TIMEX, SP_TIMEY, FG, g.par);
    wiDrawTime(g, SCREENWIDTH - SP_TIMEX, SP_TIMEY, snap.cntPar);
  }
}

/** WI_drawShowNextLoc (:771) — episodic halves. */
export function wiDrawShowNextLoc(src: WiPatchSource, g: WiGraphics, snap: WiDrawSnapshot): void {
  wiSlamBackground();
  wiDrawAnimatedBack(src, snap);

  if (snap.epsd > 2) {
    wiDrawEL(g, snap);
    return;
  }

  const last = snap.last === 8 ? snap.next - 1 : snap.last;

  // draw a splat on taken cities
  for (let i = 0; i <= last; i++) wiDrawOnLnode(snap, i, [g.splat]);

  // splat the secret level?
  if (snap.didsecret) wiDrawOnLnode(snap, 8, [g.splat]);

  // draw flashing ptr
  if (snap.snlPointerOn) wiDrawOnLnode(snap, snap.next, g.yah);

  wiDrawEL(g, snap); // (gamemode != commercial) ⇒ always
}

/** WI_drawNoState (:812): same picture, pointer forced ON. */
export function wiDrawNoState(src: WiPatchSource, g: WiGraphics, snap: WiDrawSnapshot): void {
  wiDrawShowNextLoc(src, g, { ...snap, snlPointerOn: true });
}

/** WI_Drawer (:1772) — SP dispatch. Returns false when the WI session is
 * gone (drawer never paints outside GS_INTERMISSION frames; the caller
 * order is D_Display-after-G_Ticker, M9-09 wiring). */
export function wiDrawer(src: WiPatchSource): boolean {
  if (screens[1] === null || screens[FG] === null) return false;
  const snap = wiDrawSnapshot();
  const g = wiLoadData(src, snap.epsd);

  switch (snap.phase) {
    case 'StatCount':
      wiDrawStats(src, g, snap);
      break;
    case 'ShowNextLoc':
      wiDrawShowNextLoc(src, g, snap);
      break;
    case 'NoState':
      wiDrawNoState(src, g, snap);
      break;
  }
  return true;
}
