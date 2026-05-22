import { Level } from '../world/level';
import { parseLevel } from '../world/level';
import { Doors } from '../world/doors';
import { Player } from '../entities/player';
import { Enemy } from '../entities/enemy';
import { type Pickup, makePickup, type PickupKind } from '../world/triggers';
import type { LevelJSON, Spawn } from '../world/types';

export type Phase = 'title' | 'playing' | 'dead' | 'win';

export interface ActiveLevel {
  level: Level;
  doors: Doors;
  enemies: Enemy[];
  pickups: Pickup[];
}

export class Game {
  phase: Phase = 'title';
  player = new Player(1.5, 1.5, 0);
  active: ActiveLevel | null = null;
  damageFlash = 0;
  time = 0;
  levelIndex = 0;
  prevHealth = 100;

  constructor(public levelSources: LevelJSON[]) {}

  start() {
    this.levelIndex = 0;
    this.loadLevel(0);
    this.phase = 'playing';
  }

  restart() {
    this.player = new Player(1.5, 1.5, 0);
    this.loadLevel(this.levelIndex);
    this.phase = 'playing';
  }

  loadLevel(idx: number) {
    const src = this.levelSources[idx];
    if (!src) throw new Error(`no level ${idx}`);
    const level = parseLevel(src);
    const doors = new Doors(level);
    const enemies: Enemy[] = [];
    const pickups: Pickup[] = [];
    for (const s of src.spawns) {
      if (s.type === 'player') {
        this.player.x = s.x;
        this.player.y = s.y;
        this.player.angle = s.angle ?? 0;
      } else if (s.type === 'enemy') {
        const kind = (s.kind as 'imp' | 'grunt') ?? 'imp';
        enemies.push(new Enemy(s.x, s.y, kind, {
          onPlayerHit: (d) => this.player.takeDamage(d),
        }));
      } else if (s.type === 'pickup') {
        pickups.push(makePickup((s.kind as PickupKind) ?? 'health', s.x, s.y));
      }
    }
    this.active = { level, doors, enemies, pickups };
    this.prevHealth = this.player.health;
  }

  advanceLevel(): boolean {
    if (this.levelIndex + 1 >= this.levelSources.length) {
      this.phase = 'win';
      return false;
    }
    // Preserve player health/ammo across levels (classic feel).
    this.levelIndex++;
    this.loadLevel(this.levelIndex);
    return true;
  }

  toTitle() {
    this.phase = 'title';
    this.player = new Player(1.5, 1.5, 0);
    this.active = null;
    this.levelIndex = 0;
  }
}

// Suppress unused-import warning if Spawn isn't referenced anywhere else
export type _SpawnAlias = Spawn;
