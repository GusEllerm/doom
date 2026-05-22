import { tex, sprite } from '../assets/placeholders';

export interface Assets {
  texture(name: string): HTMLImageElement;
  sprite(name: string): HTMLImageElement;
  sound(name: string): AudioBuffer | null;
  music(name: string): AudioBuffer | null;
  loadSounds(ctx: AudioContext, manifest: Record<string, string>): Promise<void>;
  loadMusic(ctx: AudioContext, manifest: Record<string, string>): Promise<void>;
}

const placeholderTex: HTMLImageElement = (() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d')!;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    g.fillStyle = ((x ^ y) & 8) ? '#ff00ff' : '#000000';
    g.fillRect(x, y, 1, 1);
  }
  const img = new Image();
  img.src = c.toDataURL();
  return img;
})();

export interface AssetManifest {
  textures?: Record<string, keyof typeof tex>;
  sprites?: Record<string, keyof typeof sprite>;
  sounds?: Record<string, string>;
  music?: Record<string, string>;
}

export function loadAssets(manifest: AssetManifest): Assets {
  const textures: Record<string, HTMLImageElement> = {};
  for (const [k, key] of Object.entries(manifest.textures ?? {})) {
    const factory = tex[key];
    textures[k] = factory ? factory() : placeholderTex;
  }
  const sprites: Record<string, HTMLImageElement> = {};
  for (const [k, key] of Object.entries(manifest.sprites ?? {})) {
    const factory = sprite[key];
    sprites[k] = factory ? factory() : placeholderTex;
  }
  const sounds = new Map<string, AudioBuffer>();
  const music = new Map<string, AudioBuffer>();

  return {
    texture: (n) => textures[n] ?? placeholderTex,
    sprite: (n) => sprites[n] ?? placeholderTex,
    sound: (n) => sounds.get(n) ?? null,
    music: (n) => music.get(n) ?? null,
    async loadSounds(ctx: AudioContext, m: Record<string, string>) {
      for (const [k, url] of Object.entries(m)) {
        try {
          const buf = await (await fetch(url)).arrayBuffer();
          sounds.set(k, await ctx.decodeAudioData(buf));
        } catch (e) { console.warn('sound load failed', k, e); }
      }
    },
    async loadMusic(ctx: AudioContext, m: Record<string, string>) {
      for (const [k, url] of Object.entries(m)) {
        try {
          const buf = await (await fetch(url)).arrayBuffer();
          music.set(k, await ctx.decodeAudioData(buf));
        } catch (e) { console.warn('music load failed', k, e); }
      }
    },
  };
}
