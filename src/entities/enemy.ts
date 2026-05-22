import type { Entity } from './entity';
import type { Level } from '../world/level';
import type { Player } from './player';
import { tryMove } from '../world/collision';
import { castRay } from '../render/raycaster';
import type { Doors } from '../world/doors';

export type EnemyKind = 'imp' | 'grunt';
export type EnemyState = 'idle' | 'chase' | 'attack' | 'dying';

export interface EnemyEvents {
  onPlayerHit?: (damage: number) => void;
  onDeath?: (kind: EnemyKind) => void;
  onAttack?: (kind: EnemyKind) => void;
}

const STATS = {
  imp: { health: 30, speed: 1.4, sightRange: 9, attackRange: 1.0, damage: 8, attackCd: 1.2 },
  grunt: { health: 20, speed: 2.0, sightRange: 8, attackRange: 0.85, damage: 6, attackCd: 0.9 },
} as const;

export class Enemy implements Entity {
  spriteKey: string;
  dead = false;
  health: number;
  state: EnemyState = 'idle';
  attackCooldown = 0;
  removeAfter = Infinity;

  constructor(public x: number, public y: number, public kind: EnemyKind, private events: EnemyEvents = {}) {
    this.spriteKey = kind + '_front';
    this.health = STATS[kind].health;
  }

  takeDamage(amount: number) {
    if (this.state === 'dying') return;
    this.health -= amount;
    if (this.health <= 0) {
      this.state = 'dying';
      this.spriteKey = this.kind + '_dying';
      this.removeAfter = 8;
      this.events.onDeath?.(this.kind);
      return;
    }
    if (this.state === 'idle') this.state = 'chase';
  }

  private hasLineOfSight(lvl: Level, player: Player): boolean {
    const dx = player.x - this.x, dy = player.y - this.y;
    const dist = Math.hypot(dx, dy);
    if (dist <= 0.001) return true;
    const rdx = dx / dist, rdy = dy / dist;
    const hit = castRay(lvl, this.x, this.y, rdx, rdy);
    return hit.perpDist >= dist - 0.05;
  }

  update(dt: number, lvl: Level, player: Player, doors?: Doors) {
    if (this.state === 'dying') {
      this.removeAfter -= dt;
      if (this.removeAfter <= 0) this.dead = true;
      return;
    }
    const dx = player.x - this.x, dy = player.y - this.y;
    const dist = Math.hypot(dx, dy);
    const stats = STATS[this.kind];

    if (this.state === 'idle') {
      if (dist < stats.sightRange && this.hasLineOfSight(lvl, player)) this.state = 'chase';
      else return;
    }

    if (this.attackCooldown > 0) this.attackCooldown -= dt;

    if (dist <= stats.attackRange && this.hasLineOfSight(lvl, player)) {
      this.state = 'attack';
      if (this.attackCooldown <= 0) {
        this.attackCooldown = stats.attackCd;
        this.events.onAttack?.(this.kind);
        this.events.onPlayerHit?.(stats.damage);
      }
      return;
    }

    this.state = 'chase';
    if (dist > 0.001) {
      const speed = stats.speed * dt;
      const nx = (dx / dist) * speed;
      const ny = (dy / dist) * speed;
      const next = tryMove(lvl, { x: this.x, y: this.y }, nx, ny, 0.25, doors);
      this.x = next.x;
      this.y = next.y;
    }
  }
}
