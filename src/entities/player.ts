import type { Level } from '../world/level';
import { tryMove } from '../world/collision';
import type { InputSnapshot } from '../engine/input';
import type { Enemy } from './enemy';
import { WEAPONS, fireHitscan } from './weapons';
import type { Doors } from '../world/doors';
import { telemetry } from '../engine/telemetry';
import { debug } from '../render/debug';

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
  lastShotWallDist = 0;

  constructor(public x: number, public y: number, public angle: number) {}

  takeDamage(amount: number, source = 'unknown') {
    let dmg = amount;
    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, dmg / 2);
      this.armor -= absorbed;
      dmg -= absorbed;
    }
    this.health = Math.max(0, this.health - dmg);
    telemetry.push({ type: 'damage_taken', t: performance.now() / 1000, from: source, amount, healthAfter: this.health });
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
    if (input.interact && doors) {
      const opened = doors.tryOpenNear(this.x, this.y);
      telemetry.push({ type: 'door_interact', t: performance.now() / 1000, x: this.x, y: this.y, opened });
    }
    if (input.fire) this.fire(lvl, enemies);
  }

  fire(lvl: Level, enemies: Enemy[]) {
    const now = performance.now() / 1000;
    if (this.cooldown > 0) return;
    const w = WEAPONS[this.weapon]!;
    if (this.ammo[w.ammoKey] < w.ammoPerShot) {
      this.events.onDryFire?.();
      telemetry.push({ type: 'shot_dryfire', t: now, weapon: w.key });
      this.cooldown = 0.15;
      return;
    }
    this.ammo[w.ammoKey] -= w.ammoPerShot;
    this.cooldown = w.cooldown;
    this.events.onFire?.(this.weapon);
    let hitsThisShot = 0;
    let nearestDist: number | null = null;
    let wallImpactDist = 0;
    for (let i = 0; i < w.rays; i++) {
      const spread = w.rays === 1 ? 0 : (i - (w.rays - 1) / 2) * w.spread / (w.rays - 1);
      const a = this.angle + spread;
      const hit = fireHitscan(lvl, enemies, this.x, this.y, Math.cos(a), Math.sin(a));
      if (i === 0) wallImpactDist = hit.wallT;
      if (hit.enemy) {
        hitsThisShot++;
        if (nearestDist === null || hit.t < nearestDist) nearestDist = hit.t;
        const wasAlive = hit.enemy.state !== 'dying';
        hit.enemy.takeDamage(w.damage);
        telemetry.push({
          type: 'shot_target', t: now, weapon: w.key,
          targetKind: hit.enemy.kind, damage: w.damage, distance: hit.t,
          killed: wasAlive && hit.enemy.state === 'dying',
        });
        if (wasAlive) {
          this.events.onHit?.(hit.enemy);
          if (hit.enemy.state === 'dying') this.events.onKill?.(hit.enemy);
        }
      }
    }
    this.lastShotWallDist = wallImpactDist;
    telemetry.push({ type: 'shot', t: now, weapon: w.key, rays: w.rays, hits: hitsThisShot, nearestDistance: nearestDist });
    debug.lastShot = {
      ox: this.x, oy: this.y,
      dx: Math.cos(this.angle), dy: Math.sin(this.angle),
      t: performance.now() / 1000, hit: hitsThisShot > 0,
    };
  }
}
