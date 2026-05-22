import type { Level } from '../world/level';
import type { Player } from './player';

export interface Entity {
  x: number;
  y: number;
  spriteKey: string;
  dead: boolean;
  removeAfter?: number; // seconds remaining before cleanup (corpses)
  update(dt: number, lvl: Level, player: Player): void;
}
