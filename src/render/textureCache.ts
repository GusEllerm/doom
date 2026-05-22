// Pre-bake procedural textures into raw pixel buffers so the floor/ceiling
// caster can sample them directly without going through canvas drawImage.

export interface RawTexture {
  w: number;
  h: number;
  data: Uint8ClampedArray; // RGBA, length = w*h*4
}

const cache = new Map<HTMLImageElement, RawTexture>();
const TEX_SIZE = 64;

export function bake(img: HTMLImageElement): RawTexture {
  const cached = cache.get(img);
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = TEX_SIZE; c.height = TEX_SIZE;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
  const id = g.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
  const tex: RawTexture = { w: TEX_SIZE, h: TEX_SIZE, data: id.data };
  cache.set(img, tex);
  return tex;
}

export function makeFloorTexture(): RawTexture {
  const c = document.createElement('canvas');
  c.width = TEX_SIZE; c.height = TEX_SIZE;
  const g = c.getContext('2d')!;
  // Stone-floor look: greyish noise with darker grout lines.
  const id = g.createImageData(TEX_SIZE, TEX_SIZE);
  for (let y = 0; y < TEX_SIZE; y++) for (let x = 0; x < TEX_SIZE; x++) {
    const n = (Math.random() * 2 - 1) * 14;
    const tile = (x % 16 === 0 || y % 16 === 0) ? -40 : 0;
    const base = 70 + tile + n;
    const i = (y * TEX_SIZE + x) * 4;
    id.data[i + 0] = Math.max(0, Math.min(255, base * 0.95));
    id.data[i + 1] = Math.max(0, Math.min(255, base * 0.9));
    id.data[i + 2] = Math.max(0, Math.min(255, base * 0.85));
    id.data[i + 3] = 255;
  }
  return { w: TEX_SIZE, h: TEX_SIZE, data: id.data };
}

export function makeCeilingTexture(): RawTexture {
  const c = document.createElement('canvas');
  c.width = TEX_SIZE; c.height = TEX_SIZE;
  const g = c.getContext('2d')!;
  const id = g.createImageData(TEX_SIZE, TEX_SIZE);
  for (let y = 0; y < TEX_SIZE; y++) for (let x = 0; x < TEX_SIZE; x++) {
    const n = (Math.random() * 2 - 1) * 8;
    const panel = (x % 32 === 0 || y % 32 === 0) ? -25 : 0;
    const base = 40 + panel + n;
    const i = (y * TEX_SIZE + x) * 4;
    id.data[i + 0] = Math.max(0, Math.min(255, base * 0.6));
    id.data[i + 1] = Math.max(0, Math.min(255, base * 0.65));
    id.data[i + 2] = Math.max(0, Math.min(255, base * 0.8));
    id.data[i + 3] = 255;
  }
  return { w: TEX_SIZE, h: TEX_SIZE, data: id.data };
}
