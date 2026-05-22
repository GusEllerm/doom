import type { Player } from '../entities/player';
import { telemetry } from '../engine/telemetry';

export type PickupKind = 'health' | 'armor' | 'pistol_ammo' | 'shotgun_ammo';

export interface Pickup {
  kind: PickupKind;
  x: number;
  y: number;
  spriteKey: string;
  taken: boolean;
}

const PICKUP_SPRITE: Record<PickupKind, string> = {
  health: 'pickup_health',
  armor: 'pickup_armor',
  pistol_ammo: 'pickup_pistol_ammo',
  shotgun_ammo: 'pickup_shotgun_ammo',
};

export function makePickup(kind: PickupKind, x: number, y: number): Pickup {
  return { kind, x, y, spriteKey: PICKUP_SPRITE[kind], taken: false };
}

export interface PickupEvents {
  onPickup?: (kind: PickupKind) => void;
}

export function updatePickups(pickups: Pickup[], player: Player, events: PickupEvents = {}) {
  const RADIUS = 0.4;
  for (const p of pickups) {
    if (p.taken) continue;
    if (Math.hypot(p.x - player.x, p.y - player.y) < RADIUS) {
      apply(p.kind, player);
      p.taken = true;
      events.onPickup?.(p.kind);
      telemetry.push({ type: 'pickup', t: performance.now() / 1000, kind: p.kind, x: p.x, y: p.y });
    }
  }
}

function apply(kind: PickupKind, player: Player) {
  switch (kind) {
    case 'health': player.health = Math.min(100, player.health + 25); break;
    case 'armor':  player.armor  = Math.min(100, player.armor + 25); break;
    case 'pistol_ammo':  player.ammo.pistol  += 20; break;
    case 'shotgun_ammo': player.ammo.shotgun += 6; break;
  }
}
