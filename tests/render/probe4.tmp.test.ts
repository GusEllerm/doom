import { describe, it, vi } from 'vitest';
import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { texturesFromWad } from '../../src/wad/texture';
import { Framebuffer } from '../../src/render/framebuffer';
import { initLightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame } from '../../src/render/renderer';
import { buildRenderMapView } from '../../src/render/view';
import * as masked from '../../src/render/masked';
import { getDrawsegs, CLIP_NULL, openingsAt, MAXSHORT, clipValue } from '../../src/render/drawsegs';
import { VIEWHEIGHT } from '../../src/render/view';
import { buildM4SceneWad, M4_MAP_NAMES } from '../fixtures/m4Fixtures';

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('probe4', () => {
  it('fixture fence flush pixel effect (no sprites)', () => {
    const bytes = buildM4SceneWad('masked');
    const wad = WadFile.parse(ab(bytes));
    const mapName = M4_MAP_NAMES.masked;
    const md = loadMap(wad, mapName);
    const view = buildRenderMapView(md);
    const world = loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad));
    const sprites = buildMapSprites({ md, map: view, wad });
    const rows = new Uint8Array(34 * 256);
    for (let i = 0; i < rows.length; i++) rows[i] = i & 255;
    const tables = initLightTables(rows);
    const mo = { x: 384 * FRACUNIT, y: 128 * FRACUNIT, angle: Math.floor(180/360*4294967296)|0 };

    const fbA = new Framebuffer();
    renderFrame({ fb: fbA, world, map: view, player: { mo }, tables, sprites });

    const fbB = new Framebuffer();
    const spy = vi.spyOn(masked, 'drawMasked').mockImplementation(() => {
      const dd = getDrawsegs();
      const rows: unknown[] = [];
      for (let i = 0; i < dd.count; i++) {
        if (dd.maskedcol[i] === CLIP_NULL) continue;
        let recorded = 0;
        for (let x = dd.x1[i]!; x <= dd.x2[i]!; x++) if (openingsAt(dd.maskedcol[i]! + x) !== MAXSHORT) recorded++;
        const c = (dd.x1[i]! + dd.x2[i]!) >> 1;
        rows.push({ i, x1: dd.x1[i], x2: dd.x2[i], base: dd.maskedcol[i], recorded,
          top: clipValue(dd.sprtopclip[i]!, c, VIEWHEIGHT), bot: clipValue(dd.sprbottomclip[i]!, c, VIEWHEIGHT),
          s1: (dd.scale1[i]! >>> 16), t1: dd.tsilheight[i]! >>> 0 === 0 ? dd.tsilheight[i] : (dd.tsilheight[i]! >> 16), bs: dd.bsilheight[i]! >> 16 });
      }
      const all: unknown[] = [];
      for (let i = 0; i < dd.count; i++) all.push({ i, seg: dd.seg[i], x1: dd.x1[i], x2: dd.x2[i], sil: dd.silhouette[i], st: dd.sprtopclip[i], sb: dd.sprbottomclip[i], m: dd.maskedcol[i] });
      process.stderr.write('P4B ' + JSON.stringify({ configured: masked.maskedPassConfigured(), n: dd.count, rows, all }) + '\n');
    });
    renderFrame({ fb: fbB, world, map: view, player: { mo }, tables, sprites });
    spy.mockRestore();

    let diff = 0;
    let hist: Record<number, number> = {};
    for (let i = 0; i < fbA.indices.length; i++) {
      if (fbA.indices[i] !== fbB.indices[i]) {
        diff++;
        const v = fbA.indices[i]!;
        hist[v] = (hist[v] ?? 0) + 1;
      }
    }
    const top = Object.entries(hist).sort((a, b) => b[1] - a[1]).slice(0, 6);
    // also: no-sprite-pass variant
    const fbC = new Framebuffer();
    renderFrame({ fb: fbC, world, map: view, player: { mo }, tables });
    const fbD = new Framebuffer();
    const spy2 = vi.spyOn(masked, 'drawMasked').mockImplementation(() => {});
    renderFrame({ fb: fbD, world, map: view, player: { mo }, tables });
    spy2.mockRestore();
    let diffNS = 0;
    for (let i = 0; i < fbC.indices.length; i++) if (fbC.indices[i] !== fbD.indices[i]) diffNS++;
    process.stderr.write(`P4 diffWithSprites=${diff} diffNoSprites=${diffNS} top=${JSON.stringify(top)}\n`);
  });
});
