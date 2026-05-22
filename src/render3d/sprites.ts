// Billboard sprites for enemies and pickups. THREE.Sprite always faces the
// camera, so we get the Doom look automatically.

import * as THREE from 'three';

export interface SpriteInstance {
  sprite: THREE.Sprite;
  ownerId: string;
}

export class SpritePool {
  private textures = new Map<HTMLImageElement, THREE.Texture>();
  private pool = new Map<string, SpriteInstance>();

  constructor(private layer: THREE.Group) {}

  private getTexture(img: HTMLImageElement): THREE.Texture {
    let t = this.textures.get(img);
    if (t) return t;
    t = new THREE.Texture(img);
    t.magFilter = THREE.NearestFilter;
    t.minFilter = THREE.NearestFilter;
    t.colorSpace = THREE.SRGBColorSpace;
    t.needsUpdate = true;
    if (!img.complete) img.addEventListener('load', () => { t!.needsUpdate = true; });
    this.textures.set(img, t);
    return t;
  }

  /** Reconcile the pool with the requested entries. Anything not present is
   * removed; new entries get a fresh sprite; existing ones are updated.
   * Entries identify themselves with a stable id (entity instance index). */
  update(entries: Array<{ id: string; x: number; y: number; img: HTMLImageElement; height: number; baseY?: number; }>) {
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.id);
      let inst = this.pool.get(e.id);
      const tex = this.getTexture(e.img);
      if (!inst) {
        const mat = new THREE.SpriteMaterial({ map: tex, fog: true, transparent: true, alphaTest: 0.5 });
        const sprite = new THREE.Sprite(mat);
        this.layer.add(sprite);
        inst = { sprite, ownerId: e.id };
        this.pool.set(e.id, inst);
      } else if (inst.sprite.material.map !== tex) {
        inst.sprite.material.map = tex;
        inst.sprite.material.needsUpdate = true;
      }
      inst.sprite.scale.set(e.height, e.height, 1);
      inst.sprite.position.set(e.x, (e.baseY ?? 0.5), e.y);
    }
    // Remove sprites whose owners disappeared.
    for (const [id, inst] of this.pool) {
      if (!seen.has(id)) {
        this.layer.remove(inst.sprite);
        inst.sprite.material.dispose();
        this.pool.delete(id);
      }
    }
  }

  clear() {
    for (const [, inst] of this.pool) {
      this.layer.remove(inst.sprite);
      inst.sprite.material.dispose();
    }
    this.pool.clear();
  }
}
