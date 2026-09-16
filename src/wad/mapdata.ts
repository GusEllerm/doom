/**
 * mapdata — map lump decoders (THINGS…BLOCKMAP + REJECT), M2-03.
 * STUB — implementation lands in the following commits.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { MapData } from './types';
import type { WadFile } from './wadfile';

export class MapDataError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MapDataError';
  }
}

export function loadMap(_wad: WadFile, _name: string): MapData {
  throw new MapDataError('not implemented');
}
