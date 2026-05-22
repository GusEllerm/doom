export interface Vec2 { x: number; y: number; }

export interface Spawn {
  type: string;
  x: number;
  y: number;
  angle?: number;
  kind?: string;
}

export interface ExitTrigger {
  x: number;
  y: number;
  nextLevel: string | null;
}

export interface LevelJSON {
  name: string;
  width: number;
  height: number;
  tiles: number[];
  textures: Record<string, string>;
  spawns: Spawn[];
  music: string;
  exit: ExitTrigger | null;
}
