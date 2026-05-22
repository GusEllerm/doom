// Lightweight ring buffer of structured game events. Inspect from harness
// via window.__events (also exposes a derive() helper that summarizes).

export type GameEvent =
  | { type: 'level_start'; t: number; level: string; index: number }
  | { type: 'shot'; t: number; weapon: string; rays: number; hits: number; nearestDistance: number | null }
  | { type: 'shot_target'; t: number; weapon: string; targetKind: string; damage: number; distance: number; killed: boolean }
  | { type: 'shot_dryfire'; t: number; weapon: string }
  | { type: 'damage_taken'; t: number; from: string; amount: number; healthAfter: number }
  | { type: 'pickup'; t: number; kind: string; x: number; y: number }
  | { type: 'door_interact'; t: number; x: number; y: number; opened: boolean }
  | { type: 'door_state'; t: number; x: number; y: number; state: string }
  | { type: 'enemy_attack'; t: number; kind: string; distance: number }
  | { type: 'enemy_death'; t: number; kind: string; x: number; y: number }
  | { type: 'enemy_stuck'; t: number; kind: string; x: number; y: number; secondsStuck: number }
  | { type: 'frame_slow'; t: number; ms: number }
  | { type: 'player_oob'; t: number; x: number; y: number }
  | { type: 'level_advance'; t: number; from: number; to: number };

const MAX_EVENTS = 4096;

class Telemetry {
  private buf: GameEvent[] = [];
  private head = 0;
  private size = 0;

  push(e: GameEvent) {
    if (this.buf.length < MAX_EVENTS) {
      this.buf.push(e);
      this.size = this.buf.length;
    } else {
      this.buf[this.head] = e;
      this.head = (this.head + 1) % MAX_EVENTS;
    }
  }

  all(): GameEvent[] {
    if (this.size < MAX_EVENTS) return this.buf.slice();
    return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
  }

  clear() {
    this.buf = [];
    this.head = 0;
    this.size = 0;
  }

  derive() {
    const events = this.all();
    let shotsFired = 0;
    let shotsHit = 0;
    let totalRays = 0;
    let totalRayHits = 0;
    let damageDealt = 0;
    let damageTaken = 0;
    let kills = 0;
    let doorOpens = 0;
    let doorInteractAttempts = 0;
    let pickups = 0;
    let slowFrames = 0;
    let worstFrame = 0;
    let stuckEnemies = 0;
    let oob = 0;
    let levelsCompleted = 0;
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          shotsFired++;
          totalRays += e.rays;
          totalRayHits += e.hits;
          if (e.hits > 0) shotsHit++;
          break;
        case 'shot_target':
          damageDealt += e.damage;
          if (e.killed) kills++;
          break;
        case 'damage_taken':
          damageTaken += e.amount;
          break;
        case 'pickup': pickups++; break;
        case 'door_interact':
          doorInteractAttempts++;
          if (e.opened) doorOpens++;
          break;
        case 'frame_slow':
          slowFrames++;
          if (e.ms > worstFrame) worstFrame = e.ms;
          break;
        case 'enemy_stuck': stuckEnemies++; break;
        case 'player_oob': oob++; break;
        case 'level_advance': levelsCompleted++; break;
      }
    }
    return {
      events: events.length,
      shotsFired,
      shotsHit,
      shotAccuracy: shotsFired ? +(shotsHit / shotsFired).toFixed(3) : 0,
      rayAccuracy: totalRays ? +(totalRayHits / totalRays).toFixed(3) : 0,
      damageDealt,
      damageTaken,
      kills,
      pickups,
      doorInteractAttempts,
      doorOpens,
      doorOpenSuccessRate: doorInteractAttempts ? +(doorOpens / doorInteractAttempts).toFixed(3) : 0,
      slowFrames,
      worstFrameMs: +worstFrame.toFixed(1),
      stuckEnemyEvents: stuckEnemies,
      playerOOB: oob,
      levelsCompleted,
    };
  }
}

export const telemetry = new Telemetry();
