/**
 * M5-09 — helpers + fixture-map specs for the L2 scripted-tic FEEL goldens
 * (docs/design/M5-plan.md §M5-09). Spec DATA only — the rectangle model of
 * tests/fixtures/mapBuilder (per-room floorHeight/ceilingHeight gives the
 * step rooms 24/25, ledge pit, low ceiling and slide-corner rooms).
 *
 * Everything physics lives in src/sim; this file only boots fixture WADs,
 * scripts GameInput streams, warps via the real P_TeleportMove, and carries
 * the independent BigInt oracles the dual-derivation acceptance requires
 * (the oracle mirrors the SOURCE formulas — p_user.c / p_mobj.c / the 1993
 * tables — never the implementation module, so it is not self-referential).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { FRACUNIT } from '../../src/core/constants';
import { finecosine, finesine } from '../../src/core/tables';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { buildMapFromData } from '../../src/sim/map';
import { gInitGame, gTicker } from '../../src/sim/game';
import { pTeleportMove } from '../../src/sim/pmap';
import {
  CF_NOCLIP,
  MF_NOCLIP,
  MF_NOGRAVITY,
  MOVE_THRUST_SCALE
} from '../../src/sim/player';
import type { GameState } from '../../src/sim/state';
import { emptyInput, FORWARDMOVE, SIDEMOVE, type GameInput } from '../../src/sim/ticcmd';
import { buildFixtureMapWad, type RectMapSpec } from '../fixtures/mapBuilder';

export const fx = (n: number): number => (n * FRACUNIT) | 0;

/** BigInt oracle of FixedMul (p_fixed.c: exact product, arithmetic >>16,
 * low 32 bits). Independent re-implementation, not src/core/fixed. */
export function fmOracle(a: number, b: number): number {
  return Number(BigInt.asIntN(32, (BigInt(a) * BigInt(b)) >> 16n));
}

/** g_game.c:174-175 thrust magnitudes ×2048 (p_local.h/g_game.c verified). */
export const T_WALK = FORWARDMOVE[0] * MOVE_THRUST_SCALE; // 0x19*2048 = 51200
export const T_RUN = FORWARDMOVE[1] * MOVE_THRUST_SCALE; // 0x32*2048 = 102400
export const T_SIDE = SIDEMOVE[0] * MOVE_THRUST_SCALE; // 0x18*2048 = 49152
/** p_mobj.c FRICTION / P_XYMovement STOPSPEED. */
export const FRICTION = 0xe800;
export const STOPSPEED = 0x1000;

/** Thrust vector of P_Thrust at a BAM angle: mom += FixedMul(move, trig).
 * fine* tables indexed (angle >> ANGLETOFINESHIFT) = angle >>> 19. */
export function thrustVec(move: number, angleBam: number): [number, number] {
  const fine = (angleBam >>> 0) >>> 19;
  return [fmOracle(move, finecosine[fine]!), fmOracle(move, finesine[fine]!)];
}

/* ------------------------------------------------------------------ */
/* Fixture boot / scripting                                            */
/* ------------------------------------------------------------------ */

export function bootFeel(spec: RectMapSpec): GameState {
  const bytes = buildFixtureMapWad(spec, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

const DEG_TO_BAM = 0x100000000 / 360;

/** debug-warp semantics (src/debug.ts): real P_TeleportMove, then z = the
 * destination floor unless an explicit z, then optional exact-deg angle. */
export function warp(
  s: GameState,
  xUnits: number,
  yUnits: number,
  zUnits?: number,
  angleDeg?: number
): void {
  const p = s.players[0]!;
  pTeleportMove(s.pmap, p.mo, fx(xUnits), fx(yUnits));
  p.mo.z = zUnits === undefined ? p.mo.floorz : fx(zUnits);
  if (angleDeg !== undefined) p.mo.angle = Math.floor(angleDeg * DEG_TO_BAM) >>> 0;
}

export const in_ = (over: Partial<GameInput>): GameInput => ({ ...emptyInput(), ...over });

/** Run `tics` tics of ONE held input, calling `perTic` after each tic. */
export function hold(
  s: GameState,
  tics: number,
  inp: GameInput,
  perTic?: (p: GameState['players'][0], tic: number) => void
): number {
  for (let t = 0; t < tics; t++) {
    gTicker(s, inp);
    perTic?.(s.players[0]!, t);
  }
  return s.players[0]!.mo.x;
}

/** Cheat-flag sync identical to src/debug.ts setNoclip (D012: noclip = the
 * SAME physics, MF_NOCLIP check-skip + MF_NOGRAVITY). */
export function setNoclip(s: GameState, on: boolean): void {
  const p = s.players[0]!;
  if (on) {
    p.cheats |= CF_NOCLIP;
    p.mo.flags |= MF_NOCLIP | MF_NOGRAVITY;
  } else {
    p.cheats &= ~CF_NOCLIP;
    p.mo.flags &= ~(MF_NOCLIP | MF_NOGRAVITY);
  }
}

/* ------------------------------------------------------------------ */
/* Analytic curve oracle (open ground, angle fixed, single substep)     */
/* ------------------------------------------------------------------ */

/**
 * Per-tic P_MovePlayer→P_XYMovement curve independent of src/sim: thrust
 * FIRST onto momentum, the post-thrust momentum moves the mobj (one
 * substep while |mom| < MAXMOVE/2), THEN friction unless the stop rule
 * (all axes < STOPSPEED and no cmd movement) zeroes both axes.
 * Returns the post-tic {momx,momy,x,y} sequence.
 */
export function curve(
  tics: number,
  startX: number,
  startY: number,
  thrust: (tic: number) => [number, number],
  startMom: [number, number] = [0, 0]
): { momx: number[]; momy: number[]; x: number[]; y: number[] } {
  const out = { momx: [] as number[], momy: [] as number[], x: [] as number[], y: [] as number[] };
  let mx = startMom[0];
  let my = startMom[1];
  let x = startX;
  let y = startY;
  for (let t = 0; t < tics; t++) {
    const [tx, ty] = thrust(t);
    const dx = (mx + tx) | 0;
    const dy = (my + ty) | 0;
    x = (x + dx) | 0;
    y = (y + dy) | 0;
    mx = fmOracle(dx, FRICTION);
    my = fmOracle(dy, FRICTION);
    out.momx.push(mx);
    out.momy.push(my);
    out.x.push(x);
    out.y.push(y);
  }
  return out;
}

/** Post-release glide: P_XYMovement moves by CURRENT mom, then zeroes when
 * BOTH axes are within ±STOPSPEED (no cmd movement), else ×FRICTION.
 * Returns {dist, tics} — tics = tics until (and incl.) the zeroing tic. */
export function glide(
  momx: number,
  momy: number
): { dx: number; dy: number; stopTic: number } {
  let gx = momx;
  let gy = momy;
  let dx = 0;
  let dy = 0;
  let stopTic = 0;
  for (let t = 1; gx !== 0 || gy !== 0; t++) {
    dx = (dx + gx) | 0;
    dy = (dy + gy) | 0;
    if (Math.abs(gx) < STOPSPEED && Math.abs(gy) < STOPSPEED) {
      gx = 0;
      gy = 0;
      stopTic = t;
    } else {
      gx = fmOracle(gx, FRICTION);
      gy = fmOracle(gy, FRICTION);
    }
  }
  return { dx, dy, stopTic };
}

/* ------------------------------------------------------------------ */
/* Fixture map specs (§M5-09: "fixture map specs: step rooms 24/25,     */
/* pit room, friction arena, low-ceiling step")                         */
/* ------------------------------------------------------------------ */

/** Friction arena: 1024², ceiling 400 (fall headroom), explicit start,
 * NO default dot item (the MF_SOLID barrel would park on the spawn). */
export const ARENA: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 1024, h: 1024, ceilingHeight: 400, lightLevel: 200 }],
  things: [{ x: 512, y: 512, angle: 0, type: 1 }]
};

/** FIXMAP-sized room for the noclip wall pass-through (wall east x=240 for
 * an r16 player). */
export const ROOM256: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 200 }],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
};

/** A[0..256] f0 | B[256..512] f+STEP ceiling 128 — walk east over a step.
 * STEP=24 ⇒ P_TryMove's `tmfloorz−z > 24*FRACUNIT` passes (not >),
 * STEP=25 ⇒ blocked flush. */
export function stepRoom(step: number): RectMapSpec {
  return {
    rooms: [
      { x: 0, y: 0, w: 256, h: 128, lightLevel: 200 },
      { x: 256, y: 0, w: 256, h: 128, lightLevel: 200, floorHeight: step }
    ],
    things: [{ x: 208, y: 64, angle: 0, type: 1 }]
  };
}

/** Spawn corridor f0 c400 | pit f−500 c400 (500-unit LEDGE walk-off). */
export const LEDGE: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 128, ceilingHeight: 400, lightLevel: 200 },
    { x: 128, y: 0, w: 128, h: 128, ceilingHeight: 400, lightLevel: 200, floorHeight: -500 }
  ],
  things: [{ x: 32, y: 64, angle: 0, type: 1 }]
};

/** Slide corner: A[0..128]×[0..256] c400 | WALL strip [128..144]×[0..128]
 * floor=ceiling=0 (height-blocked line) | E[128..400]×[128..256] c400.
 * 45° forward run: block on the A|WALL line, slide north, round the
 * (128,128) corner into E — the M5-04 "no livelock" pin. */
export const SLIDECORNER: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 128, h: 256, ceilingHeight: 400, lightLevel: 200 },
    { x: 128, y: 0, w: 16, h: 128, lightLevel: 200, ceilingHeight: 0 },
    { x: 128, y: 128, w: 272, h: 128, ceilingHeight: 400, lightLevel: 200 }
  ],
  things: [{ x: 48, y: 48, angle: 45, type: 1 }]
};

/** Barrel room: MF_SOLID doomednum 2035 (r10/h42) between spawn and wall. */
export const BARREL: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 256, h: 256, lightLevel: 200 }],
  things: [
    { x: 64, y: 128, angle: 0, type: 1 },
    { x: 128, y: 128, type: 2035 }
  ]
};

/** Low corridor: ceiling 56 == player height ⇒ viewz clamps to
 * ceilingz−4*FRACUNIT whenever the bob wave lifts it above 52. */
export const LOWCEIL: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 512, h: 128, ceilingHeight: 56, lightLevel: 200 }],
  things: [{ x: 32, y: 64, angle: 0, type: 1 }]
};

/** Marathon field: main room + +24 step room (east) + −64 dropoff (south,
 * ceiling 400 so the pit is enterable/landable) — walk/run/strafe/turn
 * phases cross steps, ledges, walls and slides over 2000 scripted tics. */
export const MARATHON: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 512, h: 512, ceilingHeight: 400, lightLevel: 200 },
    { x: 512, y: 0, w: 512, h: 512, ceilingHeight: 400, lightLevel: 200, floorHeight: 24 },
    { x: 0, y: -512, w: 512, h: 512, ceilingHeight: 400, lightLevel: 200, floorHeight: -64 }
  ],
  things: [{ x: 128, y: 128, angle: 0, type: 1 }]
};

/** 4096² open field — long-distance curves without wall interference. */
export const BIGARENA: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 4096, h: 4096, ceilingHeight: 400, lightLevel: 200 }],
  things: [{ x: 2048, y: 2048, angle: 0, type: 1 }]
};
