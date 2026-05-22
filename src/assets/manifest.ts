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
    imp_frontA: 'imp_frontA',
    imp_frontB: 'imp_frontB',
    imp_attack: 'imp_attack',
    imp_dying: 'imp_dying',
    grunt_front: 'grunt_front',
    grunt_frontA: 'grunt_frontA',
    grunt_frontB: 'grunt_frontB',
    grunt_attack: 'grunt_attack',
    grunt_dying: 'grunt_dying',
    pickup_health: 'pickup_health',
    pickup_armor: 'pickup_armor',
    pickup_pistol_ammo: 'pickup_pistol_ammo',
    pickup_shotgun_ammo: 'pickup_shotgun_ammo',
    pistol: 'pistol',
    shotgun: 'shotgun',
    face_100: 'face_100',
    face_75: 'face_75',
    face_50: 'face_50',
    face_25: 'face_25',
    face_10: 'face_10',
    face_hurt: 'face_hurt',
    face_dead: 'face_dead',
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
