# Browser Doom-Like Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a playable 2.5D Doom-inspired raycasting FPS that runs in a modern browser, with 3 levels, 2 enemies, 2 weapons, and audio.

**Architecture:** Vite + TypeScript single-page app. One full-viewport `<canvas>` rendered by a hand-written DDA raycaster at an internal 320×200 buffer, upscaled with nearest-neighbor. Fixed-timestep loop ticks the sim at 60 Hz. Modules are small, single-purpose, and wired in `main.ts` with no sibling cross-imports.

**Tech Stack:** TypeScript (strict), Vite, Canvas 2D, WebAudio API, Vitest.

---

## Conventions used in this plan

- **Test commands:** `npm test -- --run path/to/file.test.ts` for one file, `npm test -- --run` for all.
- **Dev server:** `npm run dev` opens at http://localhost:5173.
- **Commit style:** Conventional commits (`feat:`, `chore:`, `test:`, `docs:`).
- **Coordinate system:** X right, Y down (screen-style); angles in radians, 0 = +X, increasing CCW; world is unit cells.
- Each phase ends with a single squashed commit summarizing the phase, AND a tag `phase-N`.

---

# Phase 1 — Skeleton

### Task 1.1: Scaffold Vite + TypeScript project

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`

- [ ] **Step 1: Initialize package.json**

Create `/Users/gusellerm/Projects/doom/package.json`:
```json
{
  "name": "doom",
  "private": true,
  "type": "module",
  "version": "0.1.0",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "preview": "vite preview",
    "test": "vitest"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, no errors.

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "types": ["vite/client", "vitest/globals"],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4: Create vite.config.ts**

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  test: { environment: 'happy-dom', globals: true },
});
```

Then `npm i -D happy-dom`.

- [ ] **Step 5: Create index.html**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>DOOM</title>
    <style>
      html, body { margin: 0; height: 100%; background: #000; overflow: hidden; }
      #game { display: block; width: 100vw; height: 100vh; image-rendering: pixelated; cursor: crosshair; }
    </style>
  </head>
  <body>
    <canvas id="game"></canvas>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 6: Create minimal src/main.ts that clears the canvas**

```ts
const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const BUF_W = 320, BUF_H = 200;
canvas.width = BUF_W; canvas.height = BUF_H;
ctx.imageSmoothingEnabled = false;
ctx.fillStyle = '#222';
ctx.fillRect(0, 0, BUF_W, BUF_H);
ctx.fillStyle = '#f0f';
ctx.font = '16px monospace';
ctx.fillText('DOOM', 130, 100);
```

- [ ] **Step 7: Verify dev server runs**

Run: `npm run dev`
Expected: server listens at http://localhost:5173 and the page shows pink "DOOM" on dark grey, scaled up. Stop with Ctrl-C.

### Task 1.2: Fixed-timestep game loop with FPS counter

**Files:**
- Create: `src/engine/loop.ts`
- Modify: `src/main.ts`
- Test: `tests/engine/loop.test.ts`

- [ ] **Step 1: Write the failing test**

`tests/engine/loop.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { stepAccumulator } from '../../src/engine/loop';

describe('stepAccumulator', () => {
  it('runs N fixed steps and returns remaining accumulator', () => {
    const tick = vi.fn();
    // 50ms elapsed, 16.6667ms step -> 3 ticks
    const remaining = stepAccumulator(50, 1000 / 60, tick);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(remaining).toBeCloseTo(50 - 3 * (1000 / 60), 5);
  });

  it('clamps catch-up to a max number of ticks (spiral of death guard)', () => {
    const tick = vi.fn();
    const remaining = stepAccumulator(10_000, 1000 / 60, tick, 5);
    expect(tick).toHaveBeenCalledTimes(5);
    expect(remaining).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `npm test -- --run tests/engine/loop.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement loop**

`src/engine/loop.ts`:
```ts
export type TickFn = (dt: number) => void;
export type RenderFn = (alpha: number) => void;

export function stepAccumulator(elapsedMs: number, stepMs: number, tick: TickFn, maxTicks = 8): number {
  let acc = elapsedMs;
  let n = 0;
  while (acc >= stepMs && n < maxTicks) {
    tick(stepMs / 1000);
    acc -= stepMs;
    n++;
  }
  if (n === maxTicks) return 0;
  return acc;
}

export function startLoop(tick: TickFn, render: RenderFn, hz = 60) {
  const stepMs = 1000 / hz;
  let last = performance.now();
  let acc = 0;
  const frame = (now: number) => {
    const elapsed = Math.min(250, now - last); // clamp huge frames
    last = now;
    acc = stepAccumulator(acc + elapsed, stepMs, tick);
    render(acc / stepMs);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `npm test -- --run tests/engine/loop.test.ts`
Expected: 2 passing.

- [ ] **Step 5: Wire loop into main.ts with FPS counter**

```ts
import { startLoop } from './engine/loop';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const BUF_W = 320, BUF_H = 200;
canvas.width = BUF_W; canvas.height = BUF_H;
ctx.imageSmoothingEnabled = false;

let frames = 0, fps = 0, fpsTimer = 0;

startLoop(
  (_dt) => { /* sim */ },
  (_alpha) => {
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, BUF_W, BUF_H);
    ctx.fillStyle = '#0f0';
    ctx.font = '12px monospace';
    ctx.fillText(`FPS ${fps}`, 4, 14);
    frames++;
    fpsTimer += 1 / 60;
    if (fpsTimer >= 1) { fps = frames; frames = 0; fpsTimer = 0; }
  }
);
```

(FPS computed off render-call count which is fine for a debug HUD; we'll replace later if needed.)

- [ ] **Step 6: Visually verify**

Run: `npm run dev` → load page → see "FPS 60" stable. Stop server.

### Task 1.3: Phase commit + tag

- [ ] **Step 1: Commit**

```bash
git add .
git commit -m "feat(phase-1): vite+ts scaffold, canvas, fixed-step loop with fps counter"
git tag phase-1
```

---

# Phase 2 — Engine: raycaster + movement + collision

### Task 2.1: World grid + level fixture

**Files:**
- Create: `src/world/level.ts`, `src/world/types.ts`
- Test: `tests/world/level.test.ts`

- [ ] **Step 1: Test**

```ts
import { parseLevel } from '../../src/world/level';

it('parses a level with width*height tiles', () => {
  const lvl = parseLevel({
    name: 'test', width: 3, height: 3,
    tiles: [1,1,1, 1,0,1, 1,1,1],
    textures: {}, spawns: [], music: '', exit: null,
  });
  expect(lvl.tileAt(1,1)).toBe(0);
  expect(lvl.tileAt(0,0)).toBe(1);
  expect(lvl.isSolid(0,0)).toBe(true);
  expect(lvl.isSolid(1,1)).toBe(false);
});

it('rejects tile arrays of wrong length', () => {
  expect(() => parseLevel({ name:'x', width:2, height:2, tiles:[1,1,1], textures:{}, spawns:[], music:'', exit:null }))
    .toThrow();
});
```

- [ ] **Step 2: Types**

`src/world/types.ts`:
```ts
export interface Vec2 { x: number; y: number; }
export interface Spawn { type: string; x: number; y: number; angle?: number; kind?: string; }
export interface ExitTrigger { x: number; y: number; nextLevel: string | null; }
export interface LevelJSON {
  name: string;
  width: number; height: number;
  tiles: number[];
  textures: Record<string, string>;
  spawns: Spawn[];
  music: string;
  exit: ExitTrigger | null;
}
```

- [ ] **Step 3: Level implementation**

`src/world/level.ts`:
```ts
import type { LevelJSON } from './types';

export class Level {
  constructor(public readonly data: LevelJSON) {}
  get width() { return this.data.width; }
  get height() { return this.data.height; }
  tileAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 1; // out of bounds = solid
    return this.data.tiles[y * this.width + x] ?? 1;
  }
  isSolid(x: number, y: number): boolean {
    const t = this.tileAt(x | 0, y | 0);
    return t !== 0 && t < 100; // ids 100+ reserved for pass-through (e.g. exit pad)
  }
}

export function parseLevel(j: LevelJSON): Level {
  if (!Number.isInteger(j.width) || !Number.isInteger(j.height) || j.width <= 0 || j.height <= 0)
    throw new Error('invalid level dimensions');
  if (j.tiles.length !== j.width * j.height)
    throw new Error(`tile count ${j.tiles.length} != ${j.width * j.height}`);
  return new Level(j);
}
```

- [ ] **Step 4: Run tests, pass.**

- [ ] **Step 5: Build a hardcoded test level for the engine demo**

`src/world/devLevel.ts`:
```ts
import { parseLevel } from './level';

export const devLevel = parseLevel({
  name: 'dev',
  width: 10, height: 10,
  tiles: [
    1,1,1,1,1,1,1,1,1,1,
    1,0,0,0,0,0,0,0,0,1,
    1,0,0,0,2,0,0,0,0,1,
    1,0,0,0,0,0,0,0,0,1,
    1,0,2,0,0,0,2,0,0,1,
    1,0,0,0,0,0,0,0,0,1,
    1,0,0,0,2,2,0,0,0,1,
    1,0,0,0,0,0,0,0,0,1,
    1,0,0,0,0,0,0,0,0,1,
    1,1,1,1,1,1,1,1,1,1,
  ],
  textures: { '1': 'brick', '2': 'metal' },
  spawns: [{ type: 'player', x: 1.5, y: 1.5, angle: 0 }],
  music: '',
  exit: null,
});
```

### Task 2.2: Input — keyboard + pointer lock

**Files:**
- Create: `src/engine/input.ts`
- Test: `tests/engine/input.test.ts`

- [ ] **Step 1: Test (covers the snapshot semantics)**

```ts
import { Input } from '../../src/engine/input';

it('snapshot returns axes from currently-pressed keys and resets mouse delta', () => {
  const input = new Input();
  input._press('KeyW');
  input._press('KeyD');
  input._mouseMove(15);
  const s = input.snapshot();
  expect(s.forward).toBe(1);
  expect(s.strafe).toBe(1);
  expect(s.yawDelta).toBe(15);
  const s2 = input.snapshot();
  expect(s2.yawDelta).toBe(0); // delta reset
});
```

- [ ] **Step 2: Implementation**

`src/engine/input.ts`:
```ts
export interface InputSnapshot {
  forward: number; strafe: number; yawDelta: number;
  fire: boolean; interact: boolean; weaponSlot: number | null;
}

export class Input {
  private pressed = new Set<string>();
  private mouseDx = 0;
  private fireLatched = false;
  private interactLatched = false;
  private slotLatched: number | null = null;
  paused = false;

  install(canvas: HTMLCanvasElement) {
    addEventListener('keydown', e => this._press(e.code));
    addEventListener('keyup', e => this._release(e.code));
    canvas.addEventListener('click', () => canvas.requestPointerLock());
    document.addEventListener('pointerlockchange', () => {
      this.paused = document.pointerLockElement !== canvas;
    });
    addEventListener('mousemove', e => { if (!this.paused) this._mouseMove(e.movementX); });
    addEventListener('mousedown', e => { if (!this.paused && e.button === 0) this.fireLatched = true; });
  }
  _press(code: string) {
    this.pressed.add(code);
    if (code === 'KeyE') this.interactLatched = true;
    if (code === 'Digit1') this.slotLatched = 0;
    if (code === 'Digit2') this.slotLatched = 1;
  }
  _release(code: string) { this.pressed.delete(code); }
  _mouseMove(dx: number) { this.mouseDx += dx; }

  snapshot(): InputSnapshot {
    const fwd = (this.pressed.has('KeyW') ? 1 : 0) - (this.pressed.has('KeyS') ? 1 : 0);
    const str = (this.pressed.has('KeyD') ? 1 : 0) - (this.pressed.has('KeyA') ? 1 : 0);
    const s: InputSnapshot = {
      forward: fwd, strafe: str,
      yawDelta: this.mouseDx,
      fire: this.fireLatched || this.pressed.has('Space'),
      interact: this.interactLatched,
      weaponSlot: this.slotLatched,
    };
    this.mouseDx = 0;
    this.fireLatched = false;
    this.interactLatched = false;
    this.slotLatched = null;
    return s;
  }
}
```

- [ ] **Step 3: Tests pass.**

### Task 2.3: Player + circle-vs-grid collision with sliding

**Files:**
- Create: `src/world/collision.ts`, `src/entities/player.ts`
- Test: `tests/world/collision.test.ts`

- [ ] **Step 1: Tests**

```ts
import { tryMove } from '../../src/world/collision';
import { parseLevel } from '../../src/world/level';

const lvl = parseLevel({
  name:'t', width:5, height:5,
  tiles:[
    1,1,1,1,1,
    1,0,0,0,1,
    1,0,1,0,1,
    1,0,0,0,1,
    1,1,1,1,1,
  ],
  textures:{}, spawns:[], music:'', exit:null,
});

it('moves freely in empty space', () => {
  const out = tryMove(lvl, { x: 1.5, y: 1.5 }, 0.3, 0, 0.2);
  expect(out.x).toBeCloseTo(1.8);
  expect(out.y).toBeCloseTo(1.5);
});

it('blocks against a wall on X but slides on Y', () => {
  // From (1.5,1.5) moving +x toward solid at (2,2) on row y=2: at y=1.5 row y=1 has no wall.
  // Use a clearer setup: from (1.7,2.5) moving +x; tile at (2,2) is solid.
  const out = tryMove(lvl, { x: 1.7, y: 2.5 }, 0.5, 0.2, 0.2);
  expect(out.x).toBeLessThanOrEqual(2 - 0.2); // stopped before wall
  expect(out.y).toBeCloseTo(2.7); // y unaffected
});
```

- [ ] **Step 2: Implementation**

`src/world/collision.ts`:
```ts
import type { Level } from './level';

export interface Vec2 { x: number; y: number; }

export function tryMove(lvl: Level, pos: Vec2, dx: number, dy: number, radius: number): Vec2 {
  let { x, y } = pos;
  const nx = x + dx;
  if (!collides(lvl, nx, y, radius)) x = nx;
  const ny = y + dy;
  if (!collides(lvl, x, ny, radius)) y = ny;
  return { x, y };
}

function collides(lvl: Level, x: number, y: number, r: number): boolean {
  // Sample 4 corners of the AABB around the circle.
  return lvl.isSolid(x - r, y - r) || lvl.isSolid(x + r, y - r)
      || lvl.isSolid(x - r, y + r) || lvl.isSolid(x + r, y + r);
}
```

- [ ] **Step 3: Tests pass.**

- [ ] **Step 4: Player**

`src/entities/player.ts`:
```ts
import type { Level } from '../world/level';
import { tryMove } from '../world/collision';
import type { InputSnapshot } from '../engine/input';

const MOVE_SPEED = 3.0;    // cells/sec
const TURN_SPEED = 0.0025; // radians per mouse pixel
const RADIUS = 0.25;

export class Player {
  constructor(public x: number, public y: number, public angle: number) {}
  health = 100;
  armor = 0;
  ammo = { pistol: 50, shotgun: 8 };
  weapon: 0 | 1 = 0;
  cooldown = 0;

  update(dt: number, input: InputSnapshot, lvl: Level) {
    this.angle += input.yawDelta * TURN_SPEED;
    const cos = Math.cos(this.angle), sin = Math.sin(this.angle);
    const fwd = input.forward * MOVE_SPEED * dt;
    const str = input.strafe * MOVE_SPEED * dt;
    const dx = cos * fwd + Math.cos(this.angle + Math.PI / 2) * str;
    const dy = sin * fwd + Math.sin(this.angle + Math.PI / 2) * str;
    const next = tryMove(lvl, { x: this.x, y: this.y }, dx, dy, RADIUS);
    this.x = next.x; this.y = next.y;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (input.weaponSlot !== null && (input.weaponSlot === 0 || input.weaponSlot === 1))
      this.weapon = input.weaponSlot as 0 | 1;
  }
}
```

### Task 2.4: Raycaster on untextured grid

**Files:**
- Create: `src/render/raycaster.ts`
- Test: `tests/render/raycaster.test.ts`

- [ ] **Step 1: Math test**

```ts
import { castRay } from '../../src/render/raycaster';
import { parseLevel } from '../../src/world/level';

const lvl = parseLevel({
  name:'t', width:5, height:1, tiles:[0,0,0,1,0], // wall at x=3
  textures:{}, spawns:[], music:'', exit:null,
});

it('returns perpendicular distance to wall along +X ray', () => {
  const hit = castRay(lvl, 0.5, 0.5, 1, 0);
  // wall faces at x=3, perp distance from x=0.5 should be 2.5
  expect(hit.perpDist).toBeCloseTo(2.5, 5);
  expect(hit.tile).toBe(1);
  expect(hit.side).toBe(0); // x-side
});
```

- [ ] **Step 2: Implementation (untextured for now — returns hit info)**

`src/render/raycaster.ts`:
```ts
import type { Level } from '../world/level';

export interface RayHit { perpDist: number; tile: number; side: 0 | 1; wallX: number; }

export function castRay(lvl: Level, px: number, py: number, rdx: number, rdy: number): RayHit {
  let mapX = Math.floor(px), mapY = Math.floor(py);
  const deltaDistX = Math.abs(1 / (rdx || 1e-30));
  const deltaDistY = Math.abs(1 / (rdy || 1e-30));
  const stepX = rdx < 0 ? -1 : 1;
  const stepY = rdy < 0 ? -1 : 1;
  let sideDistX = rdx < 0 ? (px - mapX) * deltaDistX : (mapX + 1 - px) * deltaDistX;
  let sideDistY = rdy < 0 ? (py - mapY) * deltaDistY : (mapY + 1 - py) * deltaDistY;
  let side: 0 | 1 = 0;
  for (let i = 0; i < 64; i++) {
    if (sideDistX < sideDistY) { sideDistX += deltaDistX; mapX += stepX; side = 0; }
    else { sideDistY += deltaDistY; mapY += stepY; side = 1; }
    if (lvl.isSolid(mapX + 0.0001, mapY + 0.0001)) {
      const perp = side === 0
        ? (mapX - px + (1 - stepX) / 2) / rdx
        : (mapY - py + (1 - stepY) / 2) / rdy;
      const wallY = side === 0 ? py + perp * rdy : px + perp * rdx;
      return { perpDist: Math.max(0.0001, perp), tile: lvl.tileAt(mapX, mapY), side, wallX: wallY - Math.floor(wallY) };
    }
  }
  return { perpDist: 64, tile: 0, side: 0, wallX: 0 };
}

export const BUF_W = 320, BUF_H = 200;

export function renderWalls(ctx: CanvasRenderingContext2D, lvl: Level, px: number, py: number, angle: number, fov = Math.PI / 3, depth?: Float32Array) {
  const planeLen = Math.tan(fov / 2);
  const dirX = Math.cos(angle), dirY = Math.sin(angle);
  const planeX = -dirY * planeLen, planeY = dirX * planeLen;
  // Ceiling + floor fill
  ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, BUF_W, BUF_H / 2);
  ctx.fillStyle = '#202020'; ctx.fillRect(0, BUF_H / 2, BUF_W, BUF_H / 2);
  for (let x = 0; x < BUF_W; x++) {
    const cam = 2 * x / BUF_W - 1;
    const rdx = dirX + planeX * cam;
    const rdy = dirY + planeY * cam;
    const hit = castRay(lvl, px, py, rdx, rdy);
    if (depth) depth[x] = hit.perpDist;
    const h = Math.min(BUF_H, Math.floor(BUF_H / hit.perpDist));
    const top = Math.floor((BUF_H - h) / 2);
    const shade = hit.side === 1 ? 0.7 : 1.0;
    const base = hit.tile === 1 ? 180 : 120;
    const c = Math.floor(base * shade / Math.max(1, hit.perpDist * 0.3));
    ctx.fillStyle = `rgb(${c},${c},${c})`;
    ctx.fillRect(x, top, 1, h);
  }
}
```

- [ ] **Step 3: Tests pass.**

### Task 2.5: Wire engine into main.ts demo

- [ ] **Step 1: Update main.ts**

```ts
import { startLoop } from './engine/loop';
import { Input } from './engine/input';
import { Player } from './entities/player';
import { devLevel } from './world/devLevel';
import { renderWalls, BUF_W, BUF_H } from './render/raycaster';

const canvas = document.getElementById('game') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
canvas.width = BUF_W; canvas.height = BUF_H;
ctx.imageSmoothingEnabled = false;

const input = new Input(); input.install(canvas);
const player = new Player(1.5, 1.5, 0);
const depth = new Float32Array(BUF_W);

startLoop(
  (dt) => {
    if (input.paused) return;
    const snap = input.snapshot();
    player.update(dt, snap, devLevel);
  },
  () => {
    renderWalls(ctx, devLevel, player.x, player.y, player.angle, Math.PI / 3, depth);
    if (input.paused) {
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, BUF_W, BUF_H);
      ctx.fillStyle = '#fff';
      ctx.font = '12px monospace';
      ctx.fillText('Click to play', 130, 100);
    }
  }
);
```

- [ ] **Step 2: Visual check**

Run: `npm run dev` — click canvas, see walls, WASD moves, mouse turns, can't walk through walls.

### Task 2.6: Phase commit

```bash
git add .
git commit -m "feat(phase-2): raycaster, wasd+mouselook, sliding collision"
git tag phase-2
```

---

# Phase 3 — Textures & asset pipeline

### Task 3.1: Asset loader

**Files:**
- Create: `src/engine/assets.ts`, `src/assets/manifest.json`
- Test: `tests/engine/assets.test.ts`

- [ ] **Step 1: Manifest scaffold**

`src/assets/manifest.json`:
```json
{
  "textures": {
    "brick":  "/assets/textures/brick.png",
    "metal":  "/assets/textures/metal.png",
    "door":   "/assets/textures/door.png"
  },
  "sprites": {},
  "sounds":  {},
  "music":   {}
}
```

- [ ] **Step 2: Loader with placeholder fallback**

`src/engine/assets.ts`:
```ts
export interface Assets {
  texture(name: string): HTMLImageElement;
  sprite(name: string): HTMLImageElement;
  sound(name: string): ArrayBuffer | null;
  music(name: string): ArrayBuffer | null;
}

const placeholderTex = (() => {
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const g = c.getContext('2d')!;
  for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
    g.fillStyle = ((x ^ y) & 8) ? '#ff00ff' : '#000';
    g.fillRect(x, y, 1, 1);
  }
  const img = new Image(); img.src = c.toDataURL(); return img;
})();

async function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => { console.warn('texture load failed', url); res(placeholderTex); };
    img.src = url;
  });
}

async function loadAudio(url: string): Promise<ArrayBuffer | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status}`);
    return await r.arrayBuffer();
  } catch (e) { console.warn('audio load failed', url, e); return null; }
}

export async function loadAssets(manifest: any): Promise<Assets> {
  const textures: Record<string, HTMLImageElement> = {};
  for (const [k, url] of Object.entries(manifest.textures ?? {})) textures[k] = await loadImage(url as string);
  const sprites: Record<string, HTMLImageElement> = {};
  for (const [k, url] of Object.entries(manifest.sprites ?? {})) sprites[k] = await loadImage(url as string);
  const sounds: Record<string, ArrayBuffer | null> = {};
  for (const [k, url] of Object.entries(manifest.sounds ?? {})) sounds[k] = await loadAudio(url as string);
  const music: Record<string, ArrayBuffer | null> = {};
  for (const [k, url] of Object.entries(manifest.music ?? {})) music[k] = await loadAudio(url as string);
  return {
    texture: n => textures[n] ?? placeholderTex,
    sprite:  n => sprites[n] ?? placeholderTex,
    sound:   n => sounds[n] ?? null,
    music:   n => music[n] ?? null,
  };
}
```

- [ ] **Step 3: Test (placeholder fallback)**

```ts
import { loadAssets } from '../../src/engine/assets';
it('returns placeholder for missing texture', async () => {
  const a = await loadAssets({ textures: { brick: '/nope.png' } });
  const t = a.texture('brick');
  expect(t).toBeDefined();
  // missing key still returns placeholder
  const m = a.texture('missing');
  expect(m).toBeDefined();
});
```

(Test will use happy-dom; image load will fail and fall back. That's the point.)

### Task 3.2: Pick & install CC0 sprite pack

- [ ] **Step 1: Source pack**

Use the OpenGameArt "First Person Dungeon Crawl Protagonist" + "Wolfenstein-style textures" sets, both CC0. Specific pack candidates:
- Walls: `https://opengameart.org/content/wolfenstein-textures` (CC0)
- Enemies: `https://opengameart.org/content/zombie-sprite` (CC0)
- Weapons: `https://opengameart.org/content/old-pixelated-pistol-shotgun` (CC0)

Download the PNGs into `public/assets/textures/`, `public/assets/sprites/enemies/`, `public/assets/sprites/weapons/`. Record source URLs and licenses in `public/assets/CREDITS.md`.

(If a pack is unavailable, use procedurally-generated placeholder PNGs — see Task 3.4 below.)

- [ ] **Step 2: Update manifest**

Add entries for `brick.png`, `metal.png`, `door.png`, `imp_front.png`, `grunt_front.png`, `pistol.png`, `shotgun.png`, etc.

### Task 3.3: Textured wall rendering

**Files:**
- Modify: `src/render/raycaster.ts`
- Modify: `src/main.ts` (pass assets)

- [ ] **Step 1: Replace `renderWalls` body to sample texture columns**

```ts
export function renderWalls(
  ctx: CanvasRenderingContext2D,
  lvl: Level,
  px: number, py: number, angle: number,
  textures: (id: number) => HTMLImageElement,
  fov = Math.PI / 3,
  depth?: Float32Array,
) {
  const planeLen = Math.tan(fov / 2);
  const dirX = Math.cos(angle), dirY = Math.sin(angle);
  const planeX = -dirY * planeLen, planeY = dirX * planeLen;
  ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, 0, BUF_W, BUF_H / 2);
  ctx.fillStyle = '#202020'; ctx.fillRect(0, BUF_H / 2, BUF_W, BUF_H / 2);
  for (let x = 0; x < BUF_W; x++) {
    const cam = 2 * x / BUF_W - 1;
    const rdx = dirX + planeX * cam;
    const rdy = dirY + planeY * cam;
    const hit = castRay(lvl, px, py, rdx, rdy);
    if (depth) depth[x] = hit.perpDist;
    const h = Math.floor(BUF_H / hit.perpDist);
    const top = Math.floor((BUF_H - h) / 2);
    const img = textures(hit.tile);
    const tx = Math.floor(hit.wallX * img.width);
    ctx.drawImage(img, tx, 0, 1, img.height, x, top, 1, h);
    if (hit.side === 1) {
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(x, top, 1, h);
    }
  }
}
```

- [ ] **Step 2: Wire assets in main.ts**

```ts
import manifest from './assets/manifest.json';
import { loadAssets } from './engine/assets';

const assets = await loadAssets(manifest);
const tileTex = (id: number) => assets.texture({1:'brick', 2:'metal', 9:'door'}[id] ?? 'brick');

// ... pass tileTex into renderWalls
```

(Use top-level await; Vite supports it.)

- [ ] **Step 3: Visual check.** Walls textured.

### Task 3.4: Procedural placeholder generator (fallback if real assets unavailable)

- [ ] **Step 1: Add `src/assets/placeholders.ts`** that draws brick / metal / door textures into canvases and returns their data URLs. Use these in `manifest.json` via `data:` URLs if real PNGs aren't sourced. (Only execute this task if Task 3.2 cannot source a CC0 pack.)

### Task 3.5: Phase commit

```bash
git add .
git commit -m "feat(phase-3): asset loader, textured walls, placeholder fallback"
git tag phase-3
```

---

# Phase 4 — Sprites & enemies (no combat)

### Task 4.1: Entity base + spawn loading

**Files:**
- Create: `src/entities/entity.ts`, `src/entities/enemy.ts`

- [ ] **Step 1: Entity interface**

```ts
import type { Level } from '../world/level';
import type { Player } from './player';

export interface Entity {
  x: number; y: number;
  spriteKey: string;
  dead: boolean;
  update(dt: number, lvl: Level, player: Player): void;
}
```

- [ ] **Step 2: Enemy with idle-walk-toward-player behavior**

```ts
import type { Entity } from './entity';
import type { Level } from '../world/level';
import type { Player } from './player';
import { tryMove } from '../world/collision';

export type EnemyKind = 'imp' | 'grunt';

export class Enemy implements Entity {
  spriteKey: string;
  dead = false;
  health: number;
  state: 'idle' | 'alert' | 'chase' | 'attack' | 'dying' = 'idle';
  speed: number;

  constructor(public x: number, public y: number, public kind: EnemyKind) {
    this.spriteKey = kind + '_front';
    this.health = kind === 'imp' ? 30 : 20;
    this.speed = kind === 'imp' ? 1.2 : 1.8;
  }

  update(dt: number, lvl: Level, player: Player) {
    if (this.dead) return;
    // Phase 4: always chase, no LOS check yet
    const dx = player.x - this.x, dy = player.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist > 0.6) {
      const nx = dx / dist * this.speed * dt;
      const ny = dy / dist * this.speed * dt;
      const p = tryMove(lvl, { x: this.x, y: this.y }, nx, ny, 0.25);
      this.x = p.x; this.y = p.y;
    }
  }
}
```

### Task 4.2: Sprite billboard renderer with depth occlusion

**Files:**
- Create: `src/render/sprites.ts`
- Test: `tests/render/sprites.test.ts`

- [ ] **Step 1: Test the transform math**

```ts
import { spriteCameraTransform } from '../../src/render/sprites';
it('returns positive z for sprite in front of camera', () => {
  // Camera at (0,0) looking +x (angle 0). Sprite at (3,0). z should be 3.
  const t = spriteCameraTransform(3, 0, 0, 0, 0);
  expect(t.z).toBeCloseTo(3);
  expect(t.x).toBeCloseTo(0);
});
it('returns negative z for sprite behind camera', () => {
  const t = spriteCameraTransform(-3, 0, 0, 0, 0);
  expect(t.z).toBeLessThan(0);
});
```

- [ ] **Step 2: Implementation**

```ts
import { BUF_W, BUF_H } from './raycaster';

export interface CamSpace { x: number; z: number; }
export function spriteCameraTransform(sx: number, sy: number, px: number, py: number, angle: number): CamSpace {
  const dx = sx - px, dy = sy - py;
  const cos = Math.cos(-angle), sin = Math.sin(-angle);
  return { x: dx * cos - dy * sin, z: dx * sin + dy * cos };
}

export interface RenderableSprite { x: number; y: number; img: HTMLImageElement; }

export function renderSprites(
  ctx: CanvasRenderingContext2D,
  sprites: RenderableSprite[],
  px: number, py: number, angle: number,
  depth: Float32Array,
  fov = Math.PI / 3,
) {
  const planeLen = Math.tan(fov / 2);
  // Sort back-to-front
  const enriched = sprites.map(s => {
    const c = spriteCameraTransform(s.x, s.y, px, py, angle);
    return { s, c, d: c.x * c.x + c.z * c.z };
  }).filter(e => e.c.z > 0.1).sort((a, b) => b.d - a.d);

  for (const { s, c } of enriched) {
    const screenX = Math.floor((BUF_W / 2) * (1 + (c.x / planeLen) / c.z));
    const size = Math.floor(BUF_H / c.z);
    const top = Math.floor((BUF_H - size) / 2);
    const left = screenX - size / 2;
    for (let col = 0; col < size; col++) {
      const sx = left + col;
      if (sx < 0 || sx >= BUF_W) continue;
      if (c.z > depth[sx]) continue;
      const tx = Math.floor((col / size) * s.img.width);
      ctx.drawImage(s.img, tx, 0, 1, s.img.height, sx, top, 1, size);
    }
  }
}
```

- [ ] **Step 3: Wire into main.ts**

Build `entities: Enemy[]` (one imp at (5,5)), render after walls:
```ts
const sprites = entities.filter(e => !e.dead).map(e => ({ x: e.x, y: e.y, img: assets.sprite(e.spriteKey) }));
renderSprites(ctx, sprites, player.x, player.y, player.angle, depth);
```

- [ ] **Step 4: Visual check.** Enemy sprite visible, walks toward player, occluded by walls.

### Task 4.3: Phase commit

```bash
git add .
git commit -m "feat(phase-4): sprite billboards with depth occlusion, basic enemy chase"
git tag phase-4
```

---

# Phase 5 — Combat: weapons, damage, HUD

### Task 5.1: Weapon definitions + hitscan

**Files:**
- Create: `src/entities/weapons.ts`
- Test: `tests/entities/weapons.test.ts`

- [ ] **Step 1: Test ray-vs-circle helper**

```ts
import { rayHitsCircle } from '../../src/entities/weapons';
it('detects ray hitting circle directly ahead', () => {
  const t = rayHitsCircle(0, 0, 1, 0, 5, 0, 0.4);
  expect(t).not.toBeNull();
  expect(t!).toBeCloseTo(5, 1);
});
it('misses when circle is off-axis', () => {
  expect(rayHitsCircle(0, 0, 1, 0, 5, 2, 0.4)).toBeNull();
});
```

- [ ] **Step 2: Implementation**

```ts
import type { Level } from '../world/level';
import type { Enemy } from './enemy';
import { castRay } from '../render/raycaster';

export interface Weapon {
  key: 'pistol' | 'shotgun';
  cooldown: number; damage: number; spread: number; rays: number;
  ammoKey: 'pistol' | 'shotgun';
  ammoPerShot: number;
}

export const WEAPONS: Weapon[] = [
  { key: 'pistol',  cooldown: 0.25, damage: 12, spread: 0,    rays: 1, ammoKey: 'pistol',  ammoPerShot: 1 },
  { key: 'shotgun', cooldown: 0.85, damage: 8,  spread: 0.18, rays: 7, ammoKey: 'shotgun', ammoPerShot: 1 },
];

export function rayHitsCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, r: number): number | null {
  const fx = ox - cx, fy = oy - cy;
  const a = dx * dx + dy * dy;
  const b = 2 * (fx * dx + fy * dy);
  const c = fx * fx + fy * fy - r * r;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return t > 0 ? t : null;
}

export function fireHitscan(lvl: Level, enemies: Enemy[], ox: number, oy: number, dx: number, dy: number): { enemy: Enemy; t: number } | null {
  const wallT = castRay(lvl, ox, oy, dx, dy).perpDist;
  let best: { enemy: Enemy; t: number } | null = null;
  for (const e of enemies) {
    if (e.dead) continue;
    const t = rayHitsCircle(ox, oy, dx, dy, e.x, e.y, 0.35);
    if (t === null || t > wallT) continue;
    if (!best || t < best.t) best = { enemy: e, t };
  }
  return best;
}
```

### Task 5.2: Player fires; enemies take damage and die

**Files:**
- Modify: `src/entities/player.ts`
- Modify: `src/entities/enemy.ts`

- [ ] **Step 1: Player.fire**

Add to `Player`:
```ts
import { WEAPONS, fireHitscan } from './weapons';
import type { Enemy } from './enemy';

fire(lvl: Level, enemies: Enemy[]) {
  if (this.cooldown > 0) return;
  const w = WEAPONS[this.weapon];
  if (this.ammo[w.ammoKey] < w.ammoPerShot) return;
  this.ammo[w.ammoKey] -= w.ammoPerShot;
  this.cooldown = w.cooldown;
  for (let i = 0; i < w.rays; i++) {
    const spread = (i - (w.rays - 1) / 2) * w.spread / Math.max(1, w.rays - 1);
    const a = this.angle + spread;
    const hit = fireHitscan(lvl, enemies, this.x, this.y, Math.cos(a), Math.sin(a));
    if (hit) {
      hit.enemy.health -= w.damage;
      if (hit.enemy.health <= 0) { hit.enemy.dead = true; }
    }
  }
}
```

Modify `update()` to call `fire` when `input.fire` and not paused.

### Task 5.3: HUD

**Files:**
- Create: `src/render/hud.ts`

- [ ] **Step 1: Draw HUD strip**

```ts
import { BUF_W, BUF_H } from './raycaster';
import type { Player } from '../entities/player';
import { WEAPONS } from '../entities/weapons';

export function renderHUD(ctx: CanvasRenderingContext2D, player: Player, damageFlash: number) {
  if (damageFlash > 0) {
    ctx.fillStyle = `rgba(255,0,0,${Math.min(0.5, damageFlash)})`;
    ctx.fillRect(0, 0, BUF_W, BUF_H);
  }
  const h = 26;
  ctx.fillStyle = '#111'; ctx.fillRect(0, BUF_H - h, BUF_W, h);
  ctx.fillStyle = '#888'; ctx.fillRect(0, BUF_H - h, BUF_W, 1);
  ctx.font = '10px monospace';
  ctx.fillStyle = '#f44'; ctx.fillText(`HP ${Math.max(0, player.health | 0)}`, 8, BUF_H - 10);
  ctx.fillStyle = '#4cf'; ctx.fillText(`AR ${player.armor | 0}`, 70, BUF_H - 10);
  const w = WEAPONS[player.weapon];
  ctx.fillStyle = '#ff4'; ctx.fillText(`${w.key.toUpperCase()} ${player.ammo[w.ammoKey]}`, 140, BUF_H - 10);
}
```

### Task 5.4: Weapon viewmodel

**Files:**
- Create: `src/render/viewmodel.ts`

- [ ] **Step 1: Draw weapon at bottom-center with bob + recoil**

```ts
import { BUF_W, BUF_H } from './raycaster';
import type { Player } from '../entities/player';
import { WEAPONS } from '../entities/weapons';
import type { Assets } from '../engine/assets';

export function renderViewmodel(ctx: CanvasRenderingContext2D, player: Player, time: number, moving: boolean, assets: Assets) {
  const w = WEAPONS[player.weapon];
  const img = assets.sprite(w.key);
  const bob = moving ? Math.sin(time * 8) * 4 : 0;
  const recoil = Math.max(0, player.cooldown / w.cooldown) * 12;
  const x = BUF_W / 2 - img.width / 2;
  const y = BUF_H - 26 - img.height + recoil + bob;
  ctx.drawImage(img, x, y);
}
```

### Task 5.5: Wire combat into main.ts

- [ ] **Step 1:** Track `damageFlash` and decrement each frame. Call `player.fire(lvl, enemies)` when `snap.fire`. Render HUD + viewmodel after sprites.

- [ ] **Step 2: Enemy damages player on melee contact**

Add to `Enemy.update`: if `dist < 0.7`, deal damage to player on a cooldown.

```ts
attackCooldown = 0;
// inside update, after movement:
this.attackCooldown -= dt;
if (dist < 0.7 && this.attackCooldown <= 0) {
  player.health -= this.kind === 'imp' ? 8 : 6;
  this.attackCooldown = 1.0;
  // signal damageFlash to game state — done via a callback or event
}
```

To avoid coupling, pass an `onPlayerHit` callback in `update` signature, or read damage from a per-frame array. Cleanest: enemies set `player.health -= ...` directly and main.ts watches `prevHealth > player.health` to bump `damageFlash`.

### Task 5.6: Phase commit

```bash
git add .
git commit -m "feat(phase-5): hitscan combat, HUD, weapon viewmodel, enemy melee damage"
git tag phase-5
```

---

# Phase 6 — Doors, pickups, level transitions, second enemy

### Task 6.1: Door tiles

**Files:**
- Create: `src/world/doors.ts`
- Modify: `src/world/level.ts` (door state stored separately from tile array)

- [ ] **Step 1: Door manager**

```ts
import type { Level } from './level';

export type DoorState = 'closed' | 'opening' | 'open' | 'closing';

export class Doors {
  private map = new Map<string, { state: DoorState; t: number }>();
  constructor(lvl: Level) {
    for (let y = 0; y < lvl.height; y++) for (let x = 0; x < lvl.width; x++) {
      if (lvl.tileAt(x, y) === 9) this.map.set(`${x},${y}`, { state: 'closed', t: 0 });
    }
  }
  isBlocking(x: number, y: number): boolean {
    const d = this.map.get(`${x},${y}`);
    return !!d && d.state !== 'open';
  }
  tryOpen(x: number, y: number) {
    const d = this.map.get(`${x},${y}`);
    if (d && d.state === 'closed') { d.state = 'opening'; d.t = 0; }
  }
  update(dt: number) {
    for (const d of this.map.values()) {
      if (d.state === 'opening') { d.t += dt; if (d.t > 1) d.state = 'open'; }
    }
  }
}
```

- [ ] **Step 2: Hook into collision**

`Level.isSolid` checks tile id, plus the collision module accepts an optional `Doors` and consults `isBlocking`. Update `tryMove` signature: `tryMove(lvl, doors, pos, dx, dy, r)`.

- [ ] **Step 3: Test doors block then pass after open.**

### Task 6.2: Pickups & exit triggers

**Files:**
- Create: `src/world/triggers.ts`

- [ ] **Step 1:** Trigger entities with `onTouch(player, game)`. Types: `health`, `pistol_ammo`, `shotgun_ammo`, `armor`, `exit`. On player overlap (distance < 0.4), apply effect and remove (or for exit, transition level).

### Task 6.3: Second enemy + LOS gating

Promote enemy behavior from "always chase" to the full state machine using `castRay` for LOS:
- `idle` until player within 8 cells AND LOS clear.
- `chase` until in attack range.
- `attack` plays attack animation; for imp, fire hitscan at player.

### Task 6.4: Level transitions

`game/transitions.ts`: holds `currentLevelIndex`, list of level JSON URLs. On exit trigger, fade out, load next level via `parseLevel(await (await fetch(url)).json())`, reset entities, place player at spawn.

### Task 6.5: Phase commit

```bash
git add .
git commit -m "feat(phase-6): doors, pickups, exit triggers, level transitions, second enemy with LOS"
git tag phase-6
```

---

# Phase 7 — Three hand-built levels + title/win screens

### Task 7.1: Author levels

Create `public/assets/levels/e1m1.json`, `e1m2.json`, `e1m3.json`. Sizes 16×16, 20×20, 24×24. Each progressively introduces:
- L1: pistol-only, 4 grunts, 1 imp, single room with corridors.
- L2: adds shotgun pickup, doors, 6 grunts, 3 imps.
- L3: maze-y, 4 imps + 6 grunts, find exit.

Hand-author the JSON (no editor in v1). Validate each loads cleanly on dev run.

### Task 7.2: Title screen

`game/state.ts` phase `title`: full-screen text "DOOM — click to start". On click, transition to `playing` with level 1.

### Task 7.3: Death + restart

On `player.health <= 0`, phase → `dead`. Show "You died. Click to restart." Restart reloads current level.

### Task 7.4: Win screen

After last level's exit: phase → `win`. Show "You won. Click to play again." Click resets to title.

### Task 7.5: Phase commit

```bash
git add .
git commit -m "feat(phase-7): three levels, title/dead/win screens, restart flow"
git tag phase-7
```

---

# Phase 8 — Audio & polish

### Task 8.1: WebAudio mixer

**Files:**
- Create: `src/engine/audio.ts`

- [ ] **Step 1: Mixer with sfx + music buses**

```ts
export class AudioMixer {
  ctx: AudioContext | null = null;
  sfxGain!: GainNode; musicGain!: GainNode;
  buffers = new Map<string, AudioBuffer>();
  musicNode: AudioBufferSourceNode | null = null;
  private playing = new Map<string, number>();

  async init() {
    if (this.ctx) return;
    this.ctx = new AudioContext();
    this.sfxGain = this.ctx.createGain(); this.sfxGain.gain.value = 0.7; this.sfxGain.connect(this.ctx.destination);
    this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.4; this.musicGain.connect(this.ctx.destination);
  }
  async load(name: string, buf: ArrayBuffer | null) {
    if (!buf || !this.ctx) return;
    this.buffers.set(name, await this.ctx.decodeAudioData(buf));
  }
  playSfx(name: string, maxConcurrent = 4) {
    if (!this.ctx) return;
    const playing = this.playing.get(name) ?? 0;
    if (playing >= maxConcurrent) return;
    const buf = this.buffers.get(name); if (!buf) return;
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.connect(this.sfxGain); s.start();
    this.playing.set(name, playing + 1);
    s.onended = () => this.playing.set(name, (this.playing.get(name) ?? 1) - 1);
  }
  playMusic(name: string) {
    if (!this.ctx) return;
    this.stopMusic();
    const buf = this.buffers.get(name); if (!buf) return;
    const s = this.ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.connect(this.musicGain); s.start();
    this.musicNode = s;
  }
  stopMusic() { try { this.musicNode?.stop(); } catch {} this.musicNode = null; }
}
```

### Task 8.2: Sound integration points

- On pistol fire → `playSfx('pistol')`
- On shotgun fire → `playSfx('shotgun')`
- On enemy hit → `playSfx('hit')`
- On enemy death → `playSfx('death_' + kind)`
- On door open → `playSfx('door')`
- On pickup → `playSfx('pickup')`
- On level start → `playMusic(level.music)`

### Task 8.3: Visual polish

- Damage flash decay: `damageFlash = max(0, damageFlash - dt * 2)`; bump to 1.0 when player health decreases.
- Weapon recoil already in Task 5.4.
- Muzzle flash: when `cooldown > w.cooldown - 0.06`, overlay a bright yellow patch above viewmodel.
- Sky strip with gradient for ceiling.

### Task 8.4: Tuning pass

Playtest each level end-to-end. Adjust:
- Enemy speed / damage / health.
- Weapon damage / cooldown.
- Pickup placement.

### Task 8.5: Final commit

```bash
git add .
git commit -m "feat(phase-8): audio mixer, sfx + music wiring, muzzle flash, tuning"
git tag phase-8 v1.0.0
```

---

# Self-Review Notes

**Spec coverage:**
- 3 levels: Phase 7 ✓
- 2 enemies (imp, grunt): Phases 4, 6 ✓
- 2 weapons (pistol, shotgun): Phase 5 ✓
- Raycaster, sliding collision, mouselook: Phase 2 ✓
- Textured walls, asset loader with placeholder fallback: Phase 3 ✓
- Sprite billboards w/ depth occlusion: Phase 4 ✓
- HUD + viewmodel: Phase 5 ✓
- Doors, pickups, triggers, transitions: Phase 6 ✓
- Title/dead/win screens: Phase 7 ✓
- WebAudio (sfx + music), polish: Phase 8 ✓
- Tests on collision, level, raycaster, weapons: Tasks 2.1, 2.3, 2.4, 5.1 ✓

**Known gaps to fix during execution (not blockers):**
- The "happy-dom" image-load test in Task 3.1 may need adjustment — image `onerror` behavior under happy-dom is environment-dependent. If the test is flaky, replace it with a unit test on the placeholder generator instead.
- Asset sourcing (Task 3.2): if no CC0 pack is available at run time, use Task 3.4's procedural placeholders. The plan covers both paths.
