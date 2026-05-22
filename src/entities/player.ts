import type { Level } from '../world/level';
import { tryMove } from '../world/collision';
import type { InputSnapshot } from '../engine/input';

const MOVE_SPEED = 3.0;
const TURN_SPEED = 0.0025;
const RADIUS = 0.25;

export class Player {
  health = 100;
  armor = 0;
  ammo: { pistol: number; shotgun: number } = { pistol: 50, shotgun: 8 };
  weapon: 0 | 1 = 0;
  cooldown = 0;

  constructor(public x: number, public y: number, public angle: number) {}

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
    if (input.weaponSlot === 0 || input.weaponSlot === 1) {
      this.weapon = input.weaponSlot;
    }
  }
}
