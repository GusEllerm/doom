import type { LevelJSON } from './types';

// Tile ids: 0 empty, 1 brick, 2 metal, 9 door, 100 exit pad (pass-through)
export const devLevelJSON: LevelJSON = {
  name: 'dev',
  width: 12, height: 12,
  tiles: [
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 1,
    1, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 1,
    1, 1, 1, 9, 1, 1, 1, 1, 1, 0, 0, 1,
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 2, 2, 0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 1,
    1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  ],
  textures: {},
  spawns: [
    { type: 'player', x: 1.5, y: 1.5, angle: 0 },
    { type: 'enemy', kind: 'imp', x: 8.5, y: 3.5 },
    { type: 'enemy', kind: 'grunt', x: 5.5, y: 7.5 },
    { type: 'pickup', kind: 'health', x: 2.5, y: 9.5 },
    { type: 'pickup', kind: 'shotgun_ammo', x: 7.5, y: 8.5 },
    { type: 'pickup', kind: 'pistol_ammo', x: 9.5, y: 6.5 },
  ],
  music: '',
  exit: { x: 10, y: 10, nextLevel: null },
};
