import type { LevelJSON } from './types';

// Tile ids: 0 empty, 1 brick, 2 metal, 9 door, 100 exit pad (pass-through)

export const E1M1: LevelJSON = {
  name: 'E1M1: Hangar',
  width: 16, height: 16,
  tiles: [
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,9,9,0,0,0,0,0,0,1,
    1,0,0,2,0,0,0,1,1,0,0,0,2,0,0,1,
    1,0,0,0,0,0,0,1,1,0,0,0,0,0,0,1,
    1,1,9,1,1,1,1,1,1,1,1,1,1,9,1,1,
    1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,
    1,0,0,0,2,2,0,0,0,0,2,2,0,0,0,1,
    1,0,0,0,2,0,0,0,0,0,0,2,0,0,0,1,
    1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,
    1,1,1,1,1,1,1,9,9,1,1,1,1,1,1,1,
    1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,
    1,0,0,2,0,0,0,0,0,0,0,0,2,0,0,1,
    1,0,0,0,0,0,0,0,100,0,0,0,0,0,0,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  ],
  textures: {},
  spawns: [
    { type: 'player', x: 2.5, y: 2.5, angle: 0 },
    { type: 'enemy', kind: 'grunt', x: 12.5, y: 2.5 },
    { type: 'enemy', kind: 'grunt', x: 4.5, y: 8.5 },
    { type: 'enemy', kind: 'grunt', x: 11.5, y: 8.5 },
    { type: 'enemy', kind: 'imp',   x: 7.5, y: 13.5 },
    { type: 'pickup', kind: 'health',       x: 13.5, y: 13.5 },
    { type: 'pickup', kind: 'pistol_ammo',  x: 2.5,  y: 8.5 },
    { type: 'pickup', kind: 'armor',        x: 13.5, y: 2.5 },
  ],
  music: 'e1m1',
  exit: { x: 8, y: 14, nextLevel: 'E1M2' },
};

export const E1M2: LevelJSON = {
  name: 'E1M2: Foundry',
  width: 20, height: 20,
  tiles: [
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
    1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,1,0,0,0,0,2,2,2,2,0,0,0,1,
    1,0,0,2,0,0,0,1,0,0,0,0,2,0,0,2,0,0,0,1,
    1,0,0,0,0,0,0,9,0,0,0,0,2,0,0,2,0,0,0,1,
    1,0,0,0,0,0,0,1,0,0,0,0,2,2,9,2,0,0,0,1,
    1,1,1,1,1,9,1,1,0,0,0,0,0,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,
    1,0,2,0,0,0,0,0,0,2,2,2,0,0,0,0,0,2,0,1,
    1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,1,1,9,9,1,1,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,1,
    1,0,2,0,0,0,0,1,0,0,0,0,1,0,0,0,2,0,0,1,
    1,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,1,0,2,2,0,1,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,1,
    1,1,1,1,9,1,1,1,1,1,1,1,1,1,1,9,1,1,1,1,
    1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,100,0,0,1,
    1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  ],
  textures: {},
  spawns: [
    { type: 'player', x: 3.5, y: 3.5, angle: 0 },
    { type: 'enemy', kind: 'grunt', x: 14.5, y: 3.5 },
    { type: 'enemy', kind: 'grunt', x: 17.5, y: 3.5 },
    { type: 'enemy', kind: 'grunt', x: 4.5, y: 9.5 },
    { type: 'enemy', kind: 'imp',   x: 9.5, y: 14.5 },
    { type: 'enemy', kind: 'imp',   x: 10.5, y: 12.5 },
    { type: 'enemy', kind: 'grunt', x: 17.5, y: 14.5 },
    { type: 'enemy', kind: 'grunt', x: 4.5, y: 18.5 },
    { type: 'enemy', kind: 'imp',   x: 13.5, y: 18.5 },
    { type: 'pickup', kind: 'shotgun_ammo', x: 14.5, y: 4.5 },
    { type: 'pickup', kind: 'shotgun_ammo', x: 9.5, y: 8.5 },
    { type: 'pickup', kind: 'health',       x: 2.5, y: 12.5 },
    { type: 'pickup', kind: 'health',       x: 17.5, y: 18.5 },
    { type: 'pickup', kind: 'armor',        x: 10.5, y: 11.5 },
    { type: 'pickup', kind: 'pistol_ammo',  x: 8.5, y: 18.5 },
  ],
  music: 'e1m2',
  exit: { x: 16, y: 18, nextLevel: 'E1M3' },
};

export const E1M3: LevelJSON = {
  name: 'E1M3: Throne',
  width: 24, height: 24,
  tiles: (() => {
    const W = 24, H = 24;
    const t = new Array<number>(W * H).fill(0);
    const set = (x: number, y: number, v: number) => { t[y * W + x] = v; };
    // Outer wall
    for (let x = 0; x < W; x++) { set(x, 0, 1); set(x, H - 1, 1); }
    for (let y = 0; y < H; y++) { set(0, y, 1); set(W - 1, y, 1); }
    // Inner labyrinth
    const walls: [number, number][] = [];
    for (let x = 4; x < 10; x++) walls.push([x, 4]);
    for (let y = 4; y < 9; y++) walls.push([10, y]);
    for (let x = 10; x < 16; x++) walls.push([x, 8]);
    for (let y = 8; y < 13; y++) walls.push([16, y]);
    for (let x = 6; x < 17; x++) walls.push([x, 13]);
    for (let y = 13; y < 18; y++) walls.push([6, y]);
    for (let x = 6; x < 14; x++) walls.push([x, 18]);
    for (let y = 4; y < 9; y++) walls.push([18, y]);
    for (let x = 18; x < 22; x++) walls.push([x, 9]);
    for (const [x, y] of walls) set(x, y, 2);
    // Doors
    set(10, 6, 9);
    set(13, 8, 9);
    set(11, 13, 9);
    set(6, 16, 9);
    // Exit
    set(W - 3, H - 3, 100);
    return t;
  })(),
  textures: {},
  spawns: [
    { type: 'player', x: 1.5, y: 1.5, angle: 0 },
    { type: 'enemy', kind: 'grunt', x: 3.5, y: 6.5 },
    { type: 'enemy', kind: 'grunt', x: 8.5, y: 2.5 },
    { type: 'enemy', kind: 'imp',   x: 14.5, y: 6.5 },
    { type: 'enemy', kind: 'imp',   x: 18.5, y: 3.5 },
    { type: 'enemy', kind: 'imp',   x: 12.5, y: 11.5 },
    { type: 'enemy', kind: 'grunt', x: 4.5, y: 15.5 },
    { type: 'enemy', kind: 'imp',   x: 20.5, y: 13.5 },
    { type: 'enemy', kind: 'grunt', x: 10.5, y: 16.5 },
    { type: 'enemy', kind: 'grunt', x: 14.5, y: 20.5 },
    { type: 'enemy', kind: 'imp',   x: 18.5, y: 19.5 },
    { type: 'pickup', kind: 'shotgun_ammo', x: 5.5, y: 3.5 },
    { type: 'pickup', kind: 'shotgun_ammo', x: 17.5, y: 11.5 },
    { type: 'pickup', kind: 'health',       x: 2.5, y: 12.5 },
    { type: 'pickup', kind: 'health',       x: 13.5, y: 16.5 },
    { type: 'pickup', kind: 'armor',        x: 8.5, y: 10.5 },
    { type: 'pickup', kind: 'pistol_ammo',  x: 19.5, y: 16.5 },
  ],
  music: 'e1m3',
  exit: { x: 0, y: 0, nextLevel: null },
};

export const LEVELS = [E1M1, E1M2, E1M3];
