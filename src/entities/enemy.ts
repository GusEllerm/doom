import type { Entity } from './entity';
import type { Level } from '../world/level';
import type { Player } from './player';
import { tryMove } from '../world/collision';
import { castRay } from '../render/raycaster';
import type { Doors } from '../world/doors';
import { telemetry } from '../engine/telemetry';

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
  animTime = 0;
  private lastX = 0;
  private lastY = 0;
  private stationarySeconds = 0;
  private stuckReported = false;

  constructor(public x: number, public y: number, public kind: EnemyKind, private events: EnemyEvents = {}) {
    this.spriteKey = kind + '_front';
    this.health = STATS[kind].health;
  }

  private updateSprite() {
    if (this.state === 'dying') { this.spriteKey = this.kind + '_dying'; return; }
    if (this.state === 'attack') { this.spriteKey = this.kind + '_attack'; return; }
    if (this.state === 'chase') {
      const frame = Math.floor(this.animTime * 4) % 2;
      this.spriteKey = this.kind + (frame === 0 ? '_frontA' : '_frontB');
      return;
    }
    this.spriteKey = this.kind + '_front';
  }

  takeDamage(amount: number) {
    if (this.state === 'dying') return;
    this.health -= amount;
    if (this.health <= 0) {
      this.state = 'dying';
      this.removeAfter = 8;
      this.updateSprite();
      this.events.onDeath?.(this.kind);
      telemetry.push({ type: 'enemy_death', t: performance.now() / 1000, kind: this.kind, x: this.x, y: this.y });
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
    this.animTime += dt;
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
        telemetry.push({ type: 'enemy_attack', t: performance.now() / 1000, kind: this.kind, distance: dist });
      }
      this.updateSprite();
      return;
    }

    this.state = 'chase';
    if (dist > 0.001) {
      const speed = stats.speed * dt;
      let nx = (dx / dist) * speed;
      let ny = (dy / dist) * speed;
      // Unstick: if we've been stationary for a moment, our direct-pursuit
      // vector is jammed against a wall corner. Pick a sideways direction so
      // we can escape and try again next frame.
      if (this.stationarySeconds > 0.5) {
        const wiggle = this.stationarySeconds > 1.2 ? Math.PI / 2 : Math.PI / 4;
        const sign = ((this.stationarySeconds * 7) | 0) % 2 === 0 ? 1 : -1;
        const a = Math.atan2(dy, dx) + sign * wiggle;
        nx = Math.cos(a) * speed;
        ny = Math.sin(a) * speed;
      }
      const next = tryMove(lvl, { x: this.x, y: this.y }, nx, ny, 0.25, doors);
      const moved = Math.hypot(next.x - this.x, next.y - this.y);
      this.x = next.x;
      this.y = next.y;
      if (moved < 0.002) {
        this.stationarySeconds += dt;
        if (this.stationarySeconds > 2 && !this.stuckReported) {
          telemetry.push({ type: 'enemy_stuck', t: performance.now() / 1000, kind: this.kind, x: this.x, y: this.y, secondsStuck: this.stationarySeconds });
          this.stuckReported = true;
        }
      } else {
        this.stationarySeconds = 0;
        this.stuckReported = false;
      }
    }
    this.lastX = this.x; this.lastY = this.y;
    this.updateSprite();
  }
}
