// render/rdata.ts — render-side world load (M3-plan §M3-02): numeric seg /
// sidedef / texture SoA tables so no wall hot loop touches strings or sim
// objects. STUB — implementation in progress.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { MapData } from '../wad/types';
import type { TextureDef } from '../wad/types';

/** Numeric render view of one map (see module docs). */
export interface RenderWorld {
  mapName: string;
}

/** Stub: builds numeric render tables from decoded map data. */
export function loadRenderWorld(
  _md: MapData,
  _textures: ReadonlyMap<string, TextureDef>,
): RenderWorld {
  throw new Error('not implemented');
}
