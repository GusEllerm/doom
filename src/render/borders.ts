// render/borders.ts — R_FillBackScreen / R_DrawViewBorder (M9-09,
// plan §M9-09; r_draw.c:731-830 + :832-880, brdr patch loop :773-790).
//
// Only matters for the WINDOWED sizes (scaledviewwidth < 320, §0.11):
// screens[1] is the back screen — FLOOR7_2 tiled over rows 0..167
// (episodic name; the GRNROCK commercial branch is dead for this port's
// shareware/episodic policy, M9-plan §0.12) plus the beveled `brdr_*`
// patch frame around the view window; R_DrawViewBorder copies the
// outside-the-window regions back onto screens[0] (three verbatim
// R_VideoErase blocks + the V_MarkRect "?"), i.e. erases old menu/border
// junk after a resize or a menu close. The borderdrawcount 3-count lives
// in renderer.ts' displayFrame (it is d_main.c's static, §0.6).
//
// Zone: imports core + wad types + the vvideo layers (import only, the
// vvideo internals are M9-01-owned). No sim imports.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { WadFile } from '../wad/wadfile';
import { lumpPatch, screens, vDrawPatch, vMarkRect } from './vvideo';
import { viewSize } from './view';

/** Vanilla SCREENWIDTH/HEIGHT/SBARHEIGHT (r_draw.c cites; same literals
 * as view.ts's ViewSize block). */
const SCREENW = 320;
const SCREENH = 200;
const SBAR = 32;

/** The eight beveled-edge patches drawn around the window (r_draw.c:773-815
 * — the loop patches t/b/l/r then the four CORNER patches). */
const BRDR_LUMPS = ['brdr_t', 'brdr_b', 'brdr_l', 'brdr_r'] as const;
const BRDR_CORNERS = ['brdr_tl', 'brdr_tr', 'brdr_bl', 'brdr_br'] as const;

/** fillBackScreen calls (evidence counter for the skip-if-fullscreen gate). */
export const borderStats = {
  fillBackScreen: 0,
  drawViewBorder: 0,
  videoEraseBytes: 0,
};

export function resetBorderStats(): void {
  borderStats.fillBackScreen = 0;
  borderStats.drawViewBorder = 0;
  borderStats.videoEraseBytes = 0;
}

/**
 * R_FillBackScreen (r_draw.c:731): tiles the flat into screens[1]
 * (rows 0..SCREENHEIGHT-SBARHEIGHT-1; 320 % 64 == 0 so the `SCREENWIDTH&63`
 * tail branch never fires) and stamps the brdr_* frame around the window.
 * No-op at scaledviewwidth == 320 (the vanilla early return).
 */
export function fillBackScreen(wad: WadFile, flatName = 'FLOOR7_2'): void {
  const vs = viewSize();
  if (vs.scaledviewwidth === SCREENW) return; // :746
  const back = screens[1];
  if (back == null) throw new Error('borders: vInit() must run before fillBackScreen');

  const src = wad.readLumpByName(flatName);
  if (src.length !== 64 * 64) {
    throw new Error(`borders: flat ${flatName} is ${src.length} bytes, not a 64x64 flat`);
  }
  borderStats.fillBackScreen += 1;

  const dest = back.data;
  dest.fill(0); // rows 168..199 stay index-0 (vanilla leaves them untouched)
  for (let y = 0; y < SCREENH - SBAR; y += 1) {
    const rowSrc = (y & 63) << 6; // src + ((y&63)<<6), repeated 5x
    for (let x = 0; x < SCREENW / 64; x += 1) {
      dest.set(src.subarray(rowSrc, rowSrc + 64), y * SCREENW + x * 64);
    }
  }

  // Beveled edge (r_draw.c:773-790): the four straight patches tile the
  // window rim at 8px pitch, then the four corner patches land verbatim.
  for (let x = 0; x < vs.scaledviewwidth; x += 8) {
    vDrawPatch(vs.viewwindowx + x, vs.viewwindowy - 8, 1, lumpPatch(wad, BRDR_LUMPS[0]));
  }
  for (let x = 0; x < vs.scaledviewwidth; x += 8) {
    vDrawPatch(vs.viewwindowx + x, vs.viewwindowy + vs.viewheight, 1, lumpPatch(wad, BRDR_LUMPS[1]));
  }
  for (let y = 0; y < vs.viewheight; y += 8) {
    vDrawPatch(vs.viewwindowx - 8, vs.viewwindowy + y, 1, lumpPatch(wad, BRDR_LUMPS[2]));
  }
  for (let y = 0; y < vs.viewheight; y += 8) {
    vDrawPatch(
      vs.viewwindowx + vs.scaledviewwidth,
      vs.viewwindowy + y,
      1,
      lumpPatch(wad, BRDR_LUMPS[3]),
    );
  }
  vDrawPatch(vs.viewwindowx - 8, vs.viewwindowy - 8, 1, lumpPatch(wad, BRDR_CORNERS[0]));
  vDrawPatch(
    vs.viewwindowx + vs.scaledviewwidth,
    vs.viewwindowy - 8,
    1,
    lumpPatch(wad, BRDR_CORNERS[1]),
  );
  vDrawPatch(vs.viewwindowx - 8, vs.viewwindowy + vs.viewheight, 1, lumpPatch(wad, BRDR_CORNERS[2]));
  vDrawPatch(
    vs.viewwindowx + vs.scaledviewwidth,
    vs.viewwindowy + vs.viewheight,
    1,
    lumpPatch(wad, BRDR_CORNERS[3]),
  );
  // Vanilla ends each straight/corner W_CacheLumpName with MarkPatches? No
  // — V_DrawPatch's own V_MarkRect ran on screens[1] (harmless: the dirty
  // box is maintenance-only in this port, vvideo header).
}

/** R_VideoErase (r_draw.c:820-828): the back→front memcpy. */
function rVideoErase(ofs: number, count: number): void {
  const dest = screens[0];
  const src = screens[1];
  if (dest == null || src == null) {
    throw new Error('borders: vInit() must run before drawViewBorder');
  }
  if (ofs < 0 || ofs + count > dest.data.length) {
    throw new Error(`borders: R_VideoErase ofs=${ofs} count=${count} out of range`);
  }
  dest.data.set(src.data.subarray(ofs, ofs + count), ofs);
  borderStats.videoEraseBytes += count;
}

/**
 * R_DrawViewBorder (r_draw.c:832-880) verbatim three-copy layout:
 *   top + one line of left side; one line of right side + bottom; the
 *   side strips per row via the wraparound memcpy. No-op at fullscreen.
 * Ends with the vanilla `V_MarkRect (0,0,SCREENWIDTH, SCREENHEIGHT-SBAR)`
 * "?".
 */
export function drawViewBorder(): void {
  const vs = viewSize();
  if (vs.scaledviewwidth === SCREENW) return; // :839
  borderStats.drawViewBorder += 1;

  const top = (SCREENH - SBAR - vs.viewheight) / 2;
  let side = (SCREENW - vs.scaledviewwidth) / 2;

  // copy top and one line of left side
  rVideoErase(0, top * SCREENW + side);

  // copy one line of right side and bottom
  const ofs1 = (vs.viewheight + top) * SCREENW - side;
  rVideoErase(ofs1, top * SCREENW + side);

  // copy sides using wraparound
  let ofs = top * SCREENW + SCREENW - side;
  side <<= 1;
  for (let i = 1; i < vs.viewheight; i += 1) {
    rVideoErase(ofs, side);
    ofs += SCREENW;
  }

  // ?
  vMarkRect(0, 0, SCREENW, SCREENH - SBAR);
}
