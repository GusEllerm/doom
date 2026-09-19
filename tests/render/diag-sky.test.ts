/**
 * M4-10 DIAG — e1m1-court-things rendered BLACK left/right above the
 * horizon (x 0..106 / 214..319).
 *
 * Verdict (fixed, golden re-blessed): sky drawing was NOT the issue. The
 * sky sliver (visplane pic==skyflatnum, columns 121..199) drew correctly
 * the whole time. The black columns were the flanking ONE-SIDED segs of
 * the spawn room's west wall (lines 829/1046, front sector 140
 * floor0/ceil128): their wall texture ('BASE2') sits in the sidedef's
 * midtexture slot at byte 20 (vanilla mapsidedef_t top@4/bottom@12/mid@20
 * — doomdata.h), but mapdata.ts decoded mid←byte12 / bottom←byte20 (the
 * slots swapped). The renderer therefore saw midtexture=-1 →
 * untextured-one-sided → nothing drawn; per-column marks were empty
 * (front ceiling edge projects at y≈−3..−45, above row 0, so
 * top=clip+1 > bottom=yl−1 legitimately marks nothing), no visplane and
 * no wall column ever reached those pixels → fb stayed 0 (black).
 * Fixed by src/wad/mapdata.ts decoding the vanilla slot order.
 *
 * This fast regression boots the REAL pipeline for that exact viewpoint
 * (walls.test.ts iwad boot path) and asserts (a) the sidedef slot decode
 * and (b) no fully-black column survives in the top-50 band. Skipped
 * without the wad; runs in ~the cost of one frame.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { FRACUNIT, MININT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { decodeColormap } from '../../src/wad/palettes';
import { texturesFromWad } from '../../src/wad/texture';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame } from '../../src/sim/game';
import { Framebuffer, RENDER_WIDTH } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld, NO_TEXTURE } from '../../src/render/rdata';
import { buildMapSprites, renderFrame } from '../../src/render/renderer';
import { buildRenderMapView } from '../../src/render/view';

import { degToBam } from './viewpoints';

const WAD_PATH = [
  process.env['DOOM_WAD'],
  process.env['FREEDOOM1_WAD'],
  fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url)),
].find((p): p is string => p !== undefined && existsSync(p));

describe.skipIf(WAD_PATH === undefined)('M4-10 e1m1-court-things black-flank diag', () => {
  const bytes = new Uint8Array(readFileSync(WAD_PATH!));
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const wad = WadFile.parse(buf);
  const md = loadMap(wad, 'E1M1');
  const world = loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad));

  it('sidedef slots decode vanilla: one-sided flank wall texture lands in MID (byte 20)', () => {
    // Lines 829/1046 flank the spawn room's west wall (x=-512); side 1302
    // is the room-facing sidedef the viewpoint renders. Pre-fix it decoded
    // mid='' + bottom='BASE2' (swap) ⇒ black columns.
    const side = md.sideDefs[1302]!;
    expect(side.midtexture.toUpperCase()).toBe('BASE2');
    expect(world.sideMidTex[1302]).not.toBe(NO_TEXTURE);
  });

  it('no fully-black column above the horizon at the court-things viewpoint', () => {
    const map = buildRenderMapView(md);
    const tables = initLightTables(decodeColormap(wad.readLumpByName('COLORMAP')!));
    const sprites = buildMapSprites({ md, map, wad });
    const state = gInitGame(buildMapFromData(md));
    const mo = state.players[0]!.mo;
    mo.x = (-416 * FRACUNIT) | 0;
    mo.y = (256 * FRACUNIT) | 0;
    mo.z = MININT; // ONFLOORZ
    mo.angle = degToBam(180);
    const fb = new Framebuffer();
    renderFrame({ fb, world, map, player: { mo }, tables, sprites });
    for (let x = 0; x < RENDER_WIDTH; x++) {
      let painted = false;
      for (let y = 0; y < 50; y++) painted ||= fb.indices[y * RENDER_WIDTH + x] !== 0;
      expect(painted, `column ${x}: top-50 band must not be all-black (M4-10)`).toBe(true);
    }
  });
});
