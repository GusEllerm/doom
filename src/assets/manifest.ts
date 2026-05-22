import type { AssetManifest } from '../engine/assets';

export const manifest: AssetManifest = {
  textures: {
    brick: 'brick',
    metal: 'metal',
    door: 'door',
    exit: 'exit',
  },
  sprites: {
    imp_front: 'imp_front',
    grunt_front: 'grunt_front',
    imp_dying: 'imp_dying',
    grunt_dying: 'grunt_dying',
    pickup_health: 'pickup_health',
    pickup_armor: 'pickup_armor',
    pickup_pistol_ammo: 'pickup_pistol_ammo',
    pickup_shotgun_ammo: 'pickup_shotgun_ammo',
    pistol: 'pistol',
    shotgun: 'shotgun',
  },
  sounds: {},
  music: {},
};

export const tileTextureKey: Record<number, string> = {
  1: 'brick',
  2: 'metal',
  9: 'door',
  100: 'exit',
};
