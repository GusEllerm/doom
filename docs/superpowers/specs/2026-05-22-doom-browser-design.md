# Browser Doom-Like — Design Spec

**Date:** 2026-05-22
**Status:** Approved (proceeding autonomously)

## Goal

A small, playable Doom-inspired first-person shooter that runs in a modern browser. The aim is a classic 1993-era feel — 2.5D raycasting, sprite enemies, chunky textures, mouse-look — at a scope of 3 levels, 2 enemy types, and 2 weapons.

## Non-goals (v1)

- True 3D rendering, free vertical look, jumping.
- WAD-file compatibility or any original Doom assets.
- Multiplayer, level editor, save/load.
- Mobile / touch input.
- Pathfinding beyond "walk toward the player and slide against walls."

## Tech stack

- **Build:** Vite + TypeScript (strict).
- **Rendering:** HTML5 Canvas 2D, internal buffer 320×200 upscaled, `imageSmoothingEnabled = false`.
- **Audio:** WebAudio API.
- **Tests:** Vitest for pure-logic modules.
- **Art:** CC0 sprite pack (selected during phase 3; licensing recorded in `assets/CREDITS.md`).

## High-level architecture

Single-page Vite app. One full-viewport `<canvas>`. A fixed-timestep loop using `requestAnimationFrame` with an accumulator ticks the simulation at 60 Hz and renders every frame.

Modules are small and single-purpose. Wiring happens in `main.ts`. No cross-imports between sibling subsystems.

```
src/
  main.ts                  // bootstrap, wires modules together
  engine/
    loop.ts                // fixed-timestep game loop
    input.ts               // pointer lock + keyboard, exposes per-frame snapshot
    assets.ts              // image + audio loader, manifest
    audio.ts               // WebAudio mixer (music bus, sfx bus)
  render/
    raycaster.ts           // DDA wall renderer, depth buffer
    sprites.ts             // billboard sprite renderer
    hud.ts                 // HUD overlay (health/armor/ammo/face)
    viewmodel.ts           // first-person weapon sprite + bob/recoil
  world/
    level.ts               // JSON load + validate
    collision.ts           // circle-vs-grid sliding collision
    doors.ts               // door state, open/close logic
    triggers.ts            // pickups + exit triggers
  entities/
    player.ts
    enemy.ts               // imp + grunt state machines
    weapons.ts             // pistol + shotgun (hitscan)
  game/
    state.ts               // top-level game state object
    transitions.ts         // title -> playing -> dead/win -> next level
  assets/
    manifest.json
    textures/  sprites/  sounds/  music/  levels/
docs/superpowers/specs/
tests/                     // vitest specs for pure modules
index.html
vite.config.ts
package.json
```

### Module boundaries

- `render/*` reads world state, writes pixels. Never mutates game state.
- `world/*` owns the map and physics queries (`isSolid`, `move(entity, dx, dy)`).
- `entities/*` owns per-entity behavior; calls into `world/*` for movement and into `engine/audio` for SFX.
- `game/*` owns sequencing and the active level.

## Components

### Raycaster (`render/raycaster.ts`)
Per-screen-column DDA against a 2D int grid. For each column:
1. Compute ray direction from camera plane + view direction.
2. Step through grid cells until a solid tile is hit.
3. Compute perpendicular distance (avoids fisheye).
4. Derive wall slice height and texture-column x; blit a vertical strip from the wall texture.
Maintains a `depth[width]` array (perp distance per column) consumed by the sprite renderer.

Floor and ceiling: solid colors for v1 (textured floor casting is a possible polish-phase extension; not required).

### Sprite renderer (`render/sprites.ts`)
For each visible entity:
1. Transform position to camera space.
2. Cull if behind camera.
3. Sort back-to-front.
4. Project to screen, compute scale.
5. For each on-screen column, skip if `entityDist > depth[x]` (wall occlusion).

### HUD (`render/hud.ts`) + viewmodel (`render/viewmodel.ts`)
Bottom strip: face portrait, health %, armor %, ammo (current weapon's pool), current weapon icon. Weapon viewmodel anchored bottom-center, bob offset = sin(time * speed) * amplitude when moving, plus a one-shot recoil animation on fire.

### Input (`engine/input.ts`)
- Click canvas → request pointer lock.
- Keyboard: track currently-down keys in a Set.
- Mouse: accumulate `dx` per frame; reset on read.
- Exposes `snapshot()` returning `{ forward, strafe, yawDelta, fire, interact, weaponSlot }`.
- On pointer-lock loss → emit `paused` event; overlay shown until re-click.

**Bindings:** W/A/S/D move and strafe; mouse turns; left mouse fires; E interacts; 1/2 selects weapon; Esc releases pointer lock (browser-controlled).

### Collision (`world/collision.ts`)
Player and enemies are circles, radius ~0.25 cell. Movement resolves X and Y independently against the tile grid so entities slide along walls. Doors are special tiles whose `solid` flag flips when opened.

### Doors (`world/doors.ts`)
A door cell has `state ∈ {closed, opening, open, closing}` and a timer. `E` within 1 cell of a closed door triggers `opening`. Enemies cannot open doors in v1 (keeps AI simple).

### Triggers (`world/triggers.ts`)
- **Pickups:** health pack, armor shard, ammo box. On player overlap, mutate player and remove trigger.
- **Exit:** cell that, when the player overlaps, advances to next level (or to the win screen after the last level).

### Player (`entities/player.ts`)
State: `{ pos: vec2, angle: number, health, armor, ammo: {pistol, shotgun}, weapon, cooldown }`. `update(dt, input, world)` applies input → movement → weapon firing → cooldown ticks.

### Enemies (`entities/enemy.ts`)
Two types share a state machine: `idle → alerted → chase → attack → dying`.
- **Imp:** slow; ranged attack (hitscan with windup animation) when LOS and within range; melee otherwise.
- **Grunt:** faster; melee only.
Line-of-sight = single DDA ray to player; alerts on damage or LOS. Pathing = walk toward player using the same collision-slide. No A*.

### Weapons (`entities/weapons.ts`)
- **Pistol:** single hitscan ray, low damage, fast cooldown, uses pistol ammo.
- **Shotgun:** 7 hitscan rays in a horizontal spread, high damage, slow cooldown, uses shell ammo.
Each weapon defines `{ cooldown, damage, spread, ammoKey, viewmodelFrames }`.

### Audio (`engine/audio.ts`)
WebAudio with two gain-bus nodes: music and sfx. Music: per-level looping track loaded on level start, faded in. SFX: cap simultaneous instances per clip (e.g. max 4 pistol shots overlapping). Music starts on first user gesture (browser autoplay policy).

### Level format (`world/level.ts`)
```jsonc
{
  "name": "E1M1",
  "width": 16, "height": 16,
  "tiles": [/* width*height ints; 0 = empty, >0 = wall id, special ids for doors/exits */],
  "textures": { "1": "brick", "2": "metal", "9": "door" },
  "spawns": [
    { "type": "player", "x": 1.5, "y": 1.5, "angle": 0 },
    { "type": "imp",    "x": 5.5, "y": 4.5 },
    { "type": "pickup", "kind": "shotgun_ammo", "x": 3.5, "y": 7.5 }
  ],
  "music": "e1m1",
  "exit": { "x": 14, "y": 14, "nextLevel": "e1m2" }
}
```
Loaded JSON is hand-validated; failures log and drop to title.

### Game state (`game/state.ts`)
```ts
type Phase = 'title' | 'playing' | 'dead' | 'win'
interface GameState {
  phase: Phase
  level: Level | null
  player: Player
  entities: Entity[]
  hud: { damageFlash: number }
  time: number
}
```
Transitions in `game/transitions.ts`: title → playing (on start); playing → dead (player health ≤ 0; restart current level on click); playing → playing (exit trigger advances level); last-level exit → win.

## Data flow per frame

1. `input.snapshot()` produces an immutable per-frame input object.
2. Loop runs N fixed sim ticks (60 Hz target) to consume accumulated time:
   - Player update (movement, weapon fire).
   - Enemy updates (AI, attacks).
   - Trigger / door updates.
   - Hit resolution and cleanup (dead entities removed).
3. Render pass: clear → ceiling/floor fill → walls (raycaster, writes depth) → sprites (reads depth) → viewmodel → HUD.
4. Audio: flush any queued one-shots; tick music fade if any.

## Error handling

- **Asset load failure:** log; replace texture with magenta placeholder; replace sound with silence; game continues.
- **Level JSON invalid:** log validation error; return to title.
- **Pointer-lock loss:** auto-pause; overlay "Click to resume."
- **Audio context blocked:** defer creation until first user gesture.
- **Canvas resize:** internal 320×200 buffer is constant; CSS scales it; no behavior change.

No save/load in v1. Death restarts the current level with full health and starting ammo.

## Testing

Unit tests (Vitest) cover pure-logic modules only:
- `world/collision`: axis-separated sliding, corner clamping, door blocking.
- `world/level`: JSON parse + validation rejects malformed input.
- `entities/weapons`: hitscan ray-vs-entity selection, cooldown gating, ammo decrement, shotgun spread count.
- `entities/enemy`: alert on damage, attack-range gating, dying-on-zero-health.
- `render/raycaster`: perpendicular-distance math on a fixture grid (no canvas).

Rendering, input, and audio are validated by playing each phase's demo.

## Phased delivery (checkpoints)

Each phase ends with a git commit and a working `npm run dev` state.

1. **Skeleton** — Vite+TS scaffold, full-viewport canvas, fixed-step loop, FPS counter.
2. **Engine** — raycaster on untextured grid, WASD + mouse-look (pointer lock), wall collision with sliding.
3. **Textures & assets** — CC0 sprite pack wired via asset manifest, textured walls, floor/ceiling fill, placeholder-on-fail.
4. **Sprites & enemies** — billboard renderer with depth occlusion, one imp that walks toward the player (no combat).
5. **Combat** — pistol + shotgun (hitscan), enemy damage/death, HUD (health + ammo), damage flash.
6. **World features** — doors, pickups (health/ammo), exit triggers, level transitions, grunt enemy.
7. **Levels** — 3 hand-built levels, title screen, win screen, restart-on-death.
8. **Audio & polish** — SFX (shoot/hit/door/pickup/death), per-level music, weapon bob, recoil animation, light tuning.

After each phase: I commit, summarize what changed, and you can play it before I start the next phase.

## Open items deferred to v2

- Floor/ceiling texture casting.
- Variable ceiling heights / stairs.
- Pathfinding (A* over walkable cells).
- Saved high scores / progress.
- Mobile controls.
- Configurable mouse sensitivity / key rebinding UI.
