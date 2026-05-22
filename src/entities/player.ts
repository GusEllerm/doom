import type { Level } from '../world/level';
import { tryMove } from '../world/collision';
import type { InputSnapshot } from '../engine/input';
import type { Enemy } from './enemy';
import { WEAPONS, fireHitscan } from './weapons';
import type { Doors } from '../world/doors';

const MOVE_SPEED = 3.0;
const TURN_SPEED = 0.0025;
const RADIUS = 0.25;

export interface PlayerEvents {
  onFire?: (weapon: 0 | 1) => void;
  onHit?: (enemy: Enemy) => void;
  onKill?: (enemy: Enemy) => void;
  onDryFire?: () => void;
}

export class Player {
  health = 100;
  armor = 0;
  ammo: { pistol: number; shotgun: number } = { pistol: 50, shotgun: 8 };
  weapon: 0 | 1 = 0;
  cooldown = 0;
  moving = false;
  events: PlayerEvents = {};

  constructor(public x: number, public y: number, public angle: number) {}

  takeDamage(amount: number) {
    let dmg = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg / 2);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    this.health = Math.max(0, this.health - dmg);
  }

  update(dt: number, input: InputSnapshot, lvl: Level, enemies: Enemy[], doors?: Doors) {
    this.angle += input.yawDelta * TURN_SPEED;
    const cos = Math.cos(this.angle), sin = Math.sin(this.angle);
    const fwd = input.forward * MOVE_SPEED * dt;
    const str = input.strafe * MOVE_SPEED * dt;
    const dx = cos * fwd + Math.cos(this.angle + Math.PI / 2) * str;
    const dy = sin * fwd + Math.sin(this.angle + Math.PI / 2) * str;
    const next = tryMove(lvl, { x: this.x, y: this.y }, dx, dy, RADIUS, doors);
    this.moving = Math.hypot(next.x - this.x, next.y - this.y) > 1e-4;
    this.x = next.x;
    this.y = next.y;
    if (this.cooldown > 0) this.cooldown -= dt;
    if (input.weaponSlot === 0 || input.weaponSlot === 1) {
      this.weapon = input.weaponSlot;
    }
    if (input.interact && doors) doors.tryOpenNear(this.x, this.y);
    if (input.fire) this.fire(lvl, enemies);
  }

  fire(lvl: Level, enemies: Enemy[]) {
    if (this.cooldown > 0) return;
    const w = WEAPONS[this.weapon]!;
    if (this.ammo[w.ammoKey] < w.ammoPerShot) {
      this.events.onDryFire?.();
      this.cooldown = 0.15;
      return;
    }
    this.ammo[w.ammoKey] -= w.ammoPerShot;
    this.cooldown = w.cooldown;
    this.events.onFire?.(this.weapon);
    for (let i = 0; i < w.rays; i++) {
      const spread = w.rays === 1 ? 0 : (i - (w.rays - 1) / 2) * w.spread / (w.rays - 1);
      const a = this.angle + spread;
      const hit = fireHitscan(lvl, enemies, this.x, this.y, Math.cos(a), Math.sin(a));
      if (hit) {
        const wasAlive = hit.enemy.state !== 'dying';
        hit.enemy.takeDamage(w.damage);
        if (wasAlive) {
          this.events.onHit?.(hit.enemy);
          if (hit.enemy.state === 'dying') this.events.onKill?.(hit.enemy);
        }
      }
    }
  }
}
