// True-3D renderer (three.js). Replaces the raycaster while keeping the
// game/world/collision/AI layers untouched.
//
// World coordinates: X right, Z forward (camera looks along +Z = world +X
// when angle = 0; we map by setting camera angle = -player.angle - π/2 so
// that increasing player angle still rotates the view CCW as the rest of
// the game expects). Y is up, with floor at y=0, ceiling at y=1.

import * as THREE from 'three';
import type { Level } from '../world/level';
import type { Doors } from '../world/doors';

const CELL = 1;
const HEIGHT = 1;

export interface WorldRenderer {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  setSize(w: number, h: number): void;
  setLevel(lvl: Level, doors: Doors, opts: WallOptions): void;
  updateDoors(): void;
  render(): void;
  spriteLayer: THREE.Group;
  dispose(): void;
}

export interface WallOptions {
  textureFor: (tile: number) => HTMLImageElement;
  floor: HTMLImageElement;
  ceiling: HTMLImageElement;
}

interface DoorMesh { mesh: THREE.Mesh; x: number; y: number; }

interface InternalState {
  walls?: THREE.Group;
  floor?: THREE.Mesh;
  ceiling?: THREE.Mesh;
  doorMeshes: DoorMesh[];
  doors?: Doors;
  textures: Map<HTMLImageElement, THREE.Texture>;
}

function disposeObject(o: THREE.Object3D) {
  o.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    if (mesh.material) {
      const m = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(m)) m.forEach((x) => x.dispose());
      else m.dispose();
    }
  });
}

function imgToTexture(img: HTMLImageElement, cache: Map<HTMLImageElement, THREE.Texture>): THREE.Texture {
  const cached = cache.get(img);
  if (cached) return cached;
  const tex = new THREE.Texture(img);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  // Re-update once the image actually loads (the procedural data: URLs may
  // not be ready when this is called).
  if (!img.complete) img.addEventListener('load', () => { tex.needsUpdate = true; });
  cache.set(img, tex);
  return tex;
}

export function createWorld(canvas: HTMLCanvasElement): WorldRenderer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0608);
  scene.fog = new THREE.Fog(0x0a0608, 4, 18);

  const camera = new THREE.PerspectiveCamera(72, 1, 0.05, 100);
  camera.rotation.order = 'YXZ';

  const spriteLayer = new THREE.Group();
  scene.add(spriteLayer);

  const ambient = new THREE.AmbientLight(0xffffff, 0.55);
  scene.add(ambient);
  const torch = new THREE.PointLight(0xffaa66, 1.2, 8, 1.5);
  scene.add(torch);

  const state: InternalState = { doorMeshes: [], textures: new Map() };

  function clearLevel() {
    if (state.walls) { scene.remove(state.walls); disposeObject(state.walls); }
    if (state.floor) { scene.remove(state.floor); disposeObject(state.floor); }
    if (state.ceiling) { scene.remove(state.ceiling); disposeObject(state.ceiling); }
    for (const d of state.doorMeshes) { scene.remove(d.mesh); disposeObject(d.mesh); }
    state.walls = state.floor = state.ceiling = undefined;
    state.doorMeshes = [];
  }

  function setLevel(lvl: Level, doors: Doors, opts: WallOptions) {
    clearLevel();
    state.doors = doors;
    buildWalls(lvl, doors, opts);
    buildFloorCeiling(lvl, opts);
    buildDoors(lvl, doors, opts);
  }

  function buildWalls(lvl: Level, doors: Doors, opts: WallOptions) {
    // Group exposed faces by texture so we can use a single material per group.
    const byTexture = new Map<HTMLImageElement, { positions: number[]; uvs: number[]; normals: number[]; indices: number[]; }>();
    function bucket(img: HTMLImageElement) {
      let b = byTexture.get(img);
      if (!b) { b = { positions: [], uvs: [], normals: [], indices: [] }; byTexture.set(img, b); }
      return b;
    }

    const isWall = (x: number, y: number) => {
      const t = lvl.tileAt(x, y);
      if (t === 0) return false;
      if (t === 9) return true;       // doors render via separate meshes
      if (t >= 100) return false;
      return true;
    };

    for (let y = 0; y < lvl.height; y++) {
      for (let x = 0; x < lvl.width; x++) {
        const t = lvl.tileAt(x, y);
        if (t === 9) continue; // doors handled separately
        if (!isWall(x, y)) continue;
        const img = opts.textureFor(t);
        const b = bucket(img);
        // For each neighbour, if it's not a wall, render that face.
        // Coordinate mapping: cell (x, y) occupies world box [x, x+1] × [0, 1] × [y, y+1].
        if (!isWall(x, y - 1)) addQuad(b, x, 0, y, x + 1, HEIGHT, y, 'north');
        if (!isWall(x, y + 1)) addQuad(b, x, 0, y + 1, x + 1, HEIGHT, y + 1, 'south');
        if (!isWall(x - 1, y)) addQuad(b, x, 0, y, x, HEIGHT, y + 1, 'west');
        if (!isWall(x + 1, y)) addQuad(b, x + 1, 0, y, x + 1, HEIGHT, y + 1, 'east');
      }
    }

    const group = new THREE.Group();
    for (const [img, b] of byTexture) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      geom.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
      geom.setAttribute('normal', new THREE.Float32BufferAttribute(b.normals, 3));
      geom.setIndex(b.indices);
      const mat = new THREE.MeshLambertMaterial({
        map: imgToTexture(img, state.textures),
        fog: true,
      });
      const mesh = new THREE.Mesh(geom, mat);
      group.add(mesh);
    }
    scene.add(group);
    state.walls = group;
    void doors;
  }

  function addQuad(
    b: { positions: number[]; uvs: number[]; normals: number[]; indices: number[]; },
    x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
    face: 'north' | 'south' | 'east' | 'west',
  ) {
    const idx = b.positions.length / 3;
    let nx = 0, ny = 0, nz = 0;
    let positions: [number, number, number][];
    // Quads are wound so the visible side faces away from the wall interior.
    if (face === 'north') { // -z normal
      nz = -1;
      positions = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]];
    } else if (face === 'south') { // +z normal
      nz = 1;
      positions = [[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]];
    } else if (face === 'west') { // -x normal
      nx = -1;
      positions = [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]];
    } else { // east, +x normal
      nx = 1;
      positions = [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]];
    }
    for (const p of positions) b.positions.push(p[0], p[1], p[2]);
    for (let i = 0; i < 4; i++) b.normals.push(nx, ny, nz);
    // UVs: bottom-left -> bottom-right -> top-right -> top-left
    b.uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    // Reverse the triangle winding so the outward normal points away from the
    // wall interior (three.js front-face = CCW vertices from camera POV).
    b.indices.push(idx, idx + 2, idx + 1, idx, idx + 3, idx + 2);
  }

  function buildFloorCeiling(lvl: Level, opts: WallOptions) {
    const w = lvl.width, h = lvl.height;
    const floorGeom = new THREE.PlaneGeometry(w, h, 1, 1);
    floorGeom.rotateX(-Math.PI / 2);
    floorGeom.translate(w / 2, 0, h / 2);
    const floorTex = imgToTexture(opts.floor, state.textures).clone();
    floorTex.wrapS = floorTex.wrapT = THREE.RepeatWrapping;
    floorTex.repeat.set(w, h);
    floorTex.needsUpdate = true;
    const floor = new THREE.Mesh(floorGeom, new THREE.MeshLambertMaterial({ map: floorTex, fog: true }));
    scene.add(floor);
    state.floor = floor;

    const ceilGeom = new THREE.PlaneGeometry(w, h, 1, 1);
    ceilGeom.rotateX(Math.PI / 2);
    ceilGeom.translate(w / 2, HEIGHT, h / 2);
    const ceilTex = imgToTexture(opts.ceiling, state.textures).clone();
    ceilTex.wrapS = ceilTex.wrapT = THREE.RepeatWrapping;
    ceilTex.repeat.set(w, h);
    ceilTex.needsUpdate = true;
    const ceiling = new THREE.Mesh(ceilGeom, new THREE.MeshLambertMaterial({ map: ceilTex, fog: true }));
    scene.add(ceiling);
    state.ceiling = ceiling;
  }

  function buildDoors(lvl: Level, doors: Doors, opts: WallOptions) {
    for (let y = 0; y < lvl.height; y++) for (let x = 0; x < lvl.width; x++) {
      if (lvl.tileAt(x, y) !== 9) continue;
      const img = opts.textureFor(9);
      const mat = new THREE.MeshLambertMaterial({
        map: imgToTexture(img, state.textures),
        fog: true,
      });
      const geom = new THREE.BoxGeometry(CELL, HEIGHT, CELL);
      const mesh = new THREE.Mesh(geom, mat);
      mesh.position.set(x + 0.5, HEIGHT / 2, y + 0.5);
      scene.add(mesh);
      state.doorMeshes.push({ mesh, x, y });
      void doors;
    }
  }

  function updateDoors() {
    if (!state.doors) return;
    for (const d of state.doorMeshes) {
      const ratio = state.doors.openRatio(d.x, d.y);
      d.mesh.position.y = HEIGHT / 2 + ratio * HEIGHT;
      d.mesh.visible = ratio < 0.999;
    }
  }

  function setSize(w: number, h: number) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function render() {
    // Torch tracks the camera so the player illuminates nearby walls.
    torch.position.copy(camera.position);
    renderer.render(scene, camera);
  }

  function dispose() {
    clearLevel();
    renderer.dispose();
  }

  return { scene, camera, renderer, setSize, setLevel, updateDoors, render, spriteLayer, dispose };
}
