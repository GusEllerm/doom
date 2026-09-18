/**
 * FIX-M4-09 — the masked-middles FINAL FLUSH (r_things.c:958-989
 * R_DrawMasked's drawsegs half + r_segs.c:100-190 R_RenderMaskedSegRange)
 * on a view with NO sprites in front.
 *
 * Adapted from the salvage probe tests/render/probe4.tmp.test.ts (same
 * fixture pipeline: buildM4SceneWad('masked') → loadMap → loadRenderWorld
 * (+flats) → renderFrame, with the openingsAt/CLIP_NULL/MAXSHORT probes on
 * the drawseg SoA). The probe only printed; this pins the vanilla truth:
 *
 *   R_DrawMasked = (1) R_SortVisSprites + the back-to-front sprite loop —
 *   each R_DrawSprite may paint a NEARER seg's masked range inline — then
 *   (2) the FINAL FLUSH: every drawseg with a masked middle, newest→oldest,
 *   drawing whatever its maskedtexturecol still holds and resetting each
 *   consumed column to MAXSHORT (idempotent: a second pass draws nothing).
 *
 * With no sprite in the view, pass (1) draws nothing and pass (2) is the
 * ONLY thing that can put a masked middle on screen. FIX-M4-09's defect:
 * that flush silently skipped drawsegs whose maskedtexturecol openings ref
 * is a legitimate NEGATIVE pointer difference colliding with the CLIP_NULL
 * sentinel (vanilla's test is `if (ds->maskedtexturecol)` — a NULL pointer,
 * which a ref of lastopening − rw_x === −1 never is). The fence therefore
 * stayed unpainted and its recorded columns stayed unconsumed.
 *
 * Fixture facts (tests/fixtures/m4Fixtures.ts header): M4MASK = two
 * equal-height rooms joined by a MASKFIX0 masked fence. MASKFIX0 texels =
 * SOLID_FILL 200; texture columns 16..47 are column-PARITY (even opaque,
 * odd post-less ⇒ transparent). Colormap rows here are the identity ramp
 * (rows[i] = i & 255, the probe's tables), so a drawn masked texel lands in
 * the buffer as EXACTLY 200 and anything else on screen is another pass.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { texturesFromWad } from '../../src/wad/texture';
import { Framebuffer, RENDER_HEIGHT, RENDER_WIDTH } from '../../src/render/framebuffer';
import { initLightTables, type LightTables } from '../../src/render/lights';
import { flatsFromWad, loadRenderWorld, NO_TEXTURE, type RenderWorld } from '../../src/render/rdata';
import { buildMapSprites, renderFrame, type SpriteTables } from '../../src/render/renderer';
import { buildRenderMapView, type RenderMapView } from '../../src/render/view';
import * as masked from '../../src/render/masked';
import { drawMasked } from '../../src/render/masked';
import {
  CLIP_NULL, MAXSHORT, getDrawsegs, openingsAt,
} from '../../src/render/drawsegs';
import type { MapData } from '../../src/wad/types';
import { buildM4SceneWad, M4_MAP_NAMES } from '../fixtures/m4Fixtures';
import { degToBam } from './viewpoints';

/** MASKFIX0's opaque texel (m4Fixtures SOLID_FILL). */
const MASKED_TEXEL = 200;

/** The FIXMASK fence viewpoints (tests/render/viewpoints.ts fixmask-*):
 * the same fence from both sides — FIX-M4-09 bites one side (the drawseg
 * whose openings ref collides) and not the other, so BOTH are pinned. */
const VIEWS = [
  { name: 'fixmask-fence (room A, E)', x: 128, y: 128, angleDeg: 0 },
  { name: 'fixmask-back (room B, W)', x: 384, y: 128, angleDeg: 180 }
] as const;

function ab(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Identity colormap rows: every lookup is the identity LUT, so a drawn
 * masked texel appears verbatim (probe4's tables). */
function identityRows(): Uint8Array {
  const rows = new Uint8Array(34 * 256);
  for (let i = 0; i < rows.length; i++) rows[i] = i & 255;
  return rows;
}

interface Scene {
  readonly md: MapData;
  readonly map: RenderMapView;
  readonly world: RenderWorld;
  readonly tables: LightTables;
  readonly sprites: SpriteTables;
}

function scene(): Scene {
  const wad = WadFile.parse(ab(buildM4SceneWad('masked')));
  const md = loadMap(wad, M4_MAP_NAMES.masked);
  const map = buildRenderMapView(md);
  return {
    md,
    map,
    world: loadRenderWorld(md, texturesFromWad(wad), flatsFromWad(wad)),
    tables: initLightTables(identityRows()),
    sprites: buildMapSprites({ md, map, wad }),
  };
}

interface View { readonly x: number; readonly y: number; readonly angleDeg: number }

function player(v: View): { mo: { x: number; y: number; angle: number } } {
  return { mo: { x: v.x * FRACUNIT, y: v.y * FRACUNIT, angle: degToBam(v.angleDeg) } };
}

/** One full frame; `flushOff` neutralises R_DrawMasked's drawsegs half
 * (the sprite half still runs) — the A/B baseline for "what the flush owns". */
function frame(s: Scene, v: View, opts: { sprites?: boolean; flushOff?: boolean } = {}): Framebuffer {
  const fb = new Framebuffer();
  const deps = {
    fb,
    world: s.world,
    map: s.map,
    player: player(v),
    tables: s.tables,
    ...(opts.sprites === false ? {} : { sprites: s.sprites }),
  };
  if (opts.flushOff === true) {
    const spy = vi.spyOn(masked, 'drawMasked').mockImplementation(() => {});
    try {
      renderFrame(deps);
    } finally {
      spy.mockRestore();
    }
  } else {
    renderFrame(deps);
  }
  return fb;
}

const sha = (fb: Framebuffer): string => createHash('sha256').update(fb.indices).digest('hex');

/** Drawsegs of the last frame whose seg side carries a MID TEXTURE — in
 * vanilla that is exactly "masked middle" (R_StoreWallRange allocates
 * maskedtexturecol from `sidedef->midtexture` on two-sided lines only), so
 * this enumeration does NOT consult maskedcol and therefore stays valid
 * while the allocation is broken. */
function maskedDrawsegs(world: RenderWorld): {
  i: number; side: number; x1: number; x2: number; base: number;
}[] {
  const d = getDrawsegs();
  const out: ReturnType<typeof maskedDrawsegs> = [];
  for (let i = 0; i < d.count; i++) {
    const side = world.segSide[d.seg[i]!]!;
    if (side < 0 || world.sideMidTex[side] === NO_TEXTURE) continue;
    out.push({ i, side, x1: d.x1[i]!, x2: d.x2[i]!, base: d.maskedcol[i]! });
  }
  return out;
}

function diffPixels(a: Framebuffer, b: Framebuffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.indices.length; i++) if (a.indices[i] !== b.indices[i]) out.push(i);
  return out;
}

const px = (fb: Framebuffer, x: number, y: number): number => fb.indices[y * RENDER_WIDTH + x]!;

describe('FIX-M4-09 masked final flush (R_DrawMasked drawsegs half)', () => {
  // NO SPRITES: M4MASK ships no S_START lumps ⇒ the sprite census is empty,
  // so the back-to-front half of R_DrawMasked has nothing to draw and cannot
  // paint a masked range inline — the final flush is the only masked drawer.
  it('the fixture really has no sprite to interleave (flush-only frame)', () => {
    const s = scene();
    expect(s.sprites.sprites.count, 'M4MASK sprite census').toBe(0);
    expect(s.sprites.things.count, 'renderable statics').toBe(0);
    const withSprites = frame(s, VIEWS[0]!);
    const without = frame(s, VIEWS[0]!, { sprites: false });
    expect(sha(withSprites)).toBe(sha(without));
  });

  for (const v of VIEWS) describe(`FIXMASK ${v.name}, no sprites`, () => {
    const s = scene();

    it('the flush draws the fence posts (masked texels), and only those', () => {
      const on = frame(s, v, { sprites: false });
      const off = frame(s, v, { sprites: false, flushOff: true });
      expect(masked.maskedPassConfigured(), 'renderFrame wired the masked pass').toBe(true);

      const diff = diffPixels(on, off);
      // RED (FIX-M4-09): the flush never runs for this drawseg ⇒ zero diff.
      expect(diff.length, 'masked-middleware pixels owned by the flush').toBeGreaterThan(0);

      // Every pixel the flush owns is a MASKFIX0 texel through the identity
      // colormap; nothing else may change (no planes/wall re-draw here).
      const wrong = diff.filter((i) => on.indices[i] !== MASKED_TEXEL);
      expect(wrong.slice(0, 8), 'flush pixels == MASKFIX0 texel').toEqual([]);

      // ...and they sit inside the masked drawsegs' screen spans.
      const segs = maskedDrawsegs(s.world);
      expect(segs.length, 'masked drawsegs recorded').toBeGreaterThan(0);
      const outside = diff.filter((i) => {
        const x = i % RENDER_WIDTH;
        return !segs.some((d) => x >= d.x1 && x <= d.x2);
      });
      expect(outside.length, 'flush pixels confined to the masked spans').toBe(0);
    });

    it('every owned pixel is a per-column texel run, and the parity holes survive', () => {
      const on = frame(s, v, { sprites: false });
      const off = frame(s, v, { sprites: false, flushOff: true });
      const diff = diffPixels(on, off);
      expect(diff.length).toBeGreaterThan(0);

      const byCol = new Map<number, number[]>();
      for (const i of diff) {
        const x = i % RENDER_WIDTH;
        const list = byCol.get(x) ?? [];
        list.push(Math.floor(i / RENDER_WIDTH));
        byCol.set(x, list);
      }
      const segs = maskedDrawsegs(s.world);
      const cover = (x: number): number => segs.filter((d) => x >= d.x1 && x <= d.x2).length;
      // A masked middle draws one contiguous texel run per screen column
      // (MASKFIX0 columns are either fully opaque or post-less); only where
      // TWO masked drawsegs overlap one column can the runs interleave.
      for (const [x, rows] of byCol) {
        if (cover(x) !== 1) continue;
        rows.sort((a, b) => a - b);
        for (let k = 1; k < rows.length; k++) expect(rows[k]! - rows[k - 1]!, `col ${x} run`).toBe(1);
      }

      const span = segs.reduce((n, d) => n + (d.x2 - d.x1 + 1), 0);
      expect(byCol.size, 'opaque columns exist').toBeGreaterThan(0);
      expect(byCol.size, 'parity holes: not every column is a post').toBeLessThan(span);

      // A hole column inside the fence span is untouched by the flush — the
      // FAR view (wall/flats from the BSP pass) shows through, and it is
      // not the flat 200 of a post.
      const holeCol = Array.from({ length: RENDER_WIDTH }, (_, x) => x)
        .find((x) => !byCol.has(x) && cover(x) > 0);
      expect(holeCol, 'a parity-hole screen column inside the fence span').not.toBeUndefined();
      const holeVals = new Set<number>();
      for (let r = 0; r < RENDER_HEIGHT; r++) {
        expect(px(off, holeCol!, r), `hole col ${holeCol} row ${r} unchanged`).toBe(px(on, holeCol!, r));
        holeVals.add(px(on, holeCol!, r)!);
      }
      expect(holeVals.size > 1 || !holeVals.has(MASKED_TEXEL), 'far view, not a post').toBe(true);

      // A post column reads MASKFIX0 across the whole run it owns.
      const postCol = Math.max(...byCol.keys());
      for (const r of byCol.get(postCol)!) expect(px(on, postCol, r), `post col ${postCol}`).toBe(MASKED_TEXEL);
    });

    it('maskedtexturecol is allocated for every masked seg and consumed once', () => {
      const fb = frame(s, v, { sprites: false });
      const segs = maskedDrawsegs(s.world);
      expect(segs.length).toBeGreaterThan(0);
      for (const d of segs) {
        // Allocated: vanilla `if (ds->maskedtexturecol)`. The openings ref
        // is a signed pointer difference (lastopening − rw_x) and may be
        // negative — it must never read as "unallocated" (FIX-M4-09).
        expect(d.base, `drawseg ${d.i} maskedtexturecol allocated`).not.toBe(CLIP_NULL);
        let unconsumed = 0;
        for (let x = d.x1; x <= d.x2; x++) if (openingsAt(d.base + x) !== MAXSHORT) unconsumed++;
        expect(unconsumed, `drawseg ${d.i} maskedtexturecol consumed`).toBe(0);
      }

      // Idempotence: the flush resets every column it draws to MAXSHORT, so
      // a second R_DrawMasked pass in the same frame draws nothing.
      const before = Uint8Array.from(fb.indices);
      drawMasked();
      expect(Uint8Array.from(fb.indices)).toEqual(before);
    });

    it('is deterministic across frames and boots (L3)', () => {
      const a = frame(s, v, { sprites: false });
      const b = frame(s, v, { sprites: false });
      expect(sha(b)).toBe(sha(a));
      expect(sha(frame(scene(), v, { sprites: false }))).toBe(sha(a));
      const backOff = frame(s, v, { sprites: false, flushOff: true });
      expect(diffPixels(a, backOff).length, 'flush owns pixels in this view').toBeGreaterThan(0);
    });
  });
});
