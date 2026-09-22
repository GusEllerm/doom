/**
 * sim/psectorspecial.test.ts — M6-12 sector specials AT THE FEET
 * (damage floors, secrets, E1M8 finale) + exits (docs/design/M6-plan.md
 * §M6-12). Bodies mirrored from linuxdoom-1.10:
 *   p_spec.c:1005-1069 P_PlayerInSpecialSector (grounded gate :1013,
 *     cadence !(leveltime&0x1f), ironfeet/`P_Random()<5`, secret :1050,
 *     finale :1056-1062, I_Error default :1066);
 *   p_user.c:274-275   the per-tic call site (puser.ts);
 *   p_spec.c:679/762   W1 cross exits 52/124;
 *   p_switch.c:362/434 S1 use exits 11/51 (ChangeSwitchTexture BEFORE);
 *   g_game.c:1002-1017 G_ExitLevel/G_SecretExitLevel (pexit.ts proxies).
 * Fixtures: M6SECT (mapBuilder rooms carrying the census damage/secret/
 * finale sector specials) + a bespoke four-exit line map.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, beforeEach } from 'vitest';

import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { ANG90, FRACUNIT } from '../core/constants';

import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { M6_SCENES } from '../../tests/fixtures/m6Fixtures';
import { buildMapFromData } from './map';
import { gInitGame, gTicker, runHeadless } from './game';
import { hashState, type GameState } from './state';
import { sectorAtPoint } from './bsp';
import { thingSetPosition } from './thinglinks';
import { CF_GODMODE, PLAYER_FLAGS } from './player';
import { resetPuserHookCounts, puserHookCounts } from './puser';
import type { Mover } from './pmap';
import { emptyInput, type GameInput } from './ticcmd';

import {
  pCrossSpecialLine, pUseSpecialLine,
  pPlayerInSpecialSector, feetCounts, resetFeetCounts,
  UnknownSectorSpecialError
} from './pspec';

const fx = (u: number): number => (u * FRACUNIT) | 0;

function stateFromNamed(spec: RectMapSpec, name: string): GameState {
  const bytes = buildFixtureMapWad(spec, name);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), name)));
}

/** SECFIX room centres (m6Fixtures SECFIX_SPEC geometry, map units). */
const ROOM = {
  hall: [128, 128], // special 0
  slime: [384, 128], // special 5
  strobeHurt: [640, 128], // special 4
  nukage: [128, 384], // special 7
  superSlime: [384, 384], // special 16
  secret: [128, 896], // special 9
  finale: [384, 896] // special 11
} as const;

/** Put the player mid-room, GROUNDED on that sector's live floor, and
 * relink the thing grid (test-side warp; z/floorz pinned so the
 * p_spec.c:1013 grounded gate passes without waiting on gravity). */
function place(s: GameState, x: number, y: number, angle = ANG90): number {
  const p = s.players[0]!;
  p.mo.x = fx(x);
  p.mo.y = fx(y);
  p.mo.angle = angle;
  const sec = sectorAtPoint(s.map, p.mo.x, p.mo.y);
  p.mo.floorz = s.sectors.floorZ[sec]!;
  p.mo.z = p.mo.floorz;
  p.mo.momx = 0;
  p.mo.momy = 0;
  p.mo.momz = 0;
  thingSetPosition(s.pmap.links, p.mo.linkSlot!, p.mo.x, p.mo.y);
  return sec;
}

const PLAYER: Mover = {
  x: 0, y: 0, z: 0, radius: fx(16), height: fx(56),
  flags: PLAYER_FLAGS, player: true
};

function lineWithSpecial(s: GameState, special: number): number {
  for (let i = 0; i < s.map.lines.count; i++) {
    if (s.map.lines.special[i] === special) return i;
  }
  throw new Error(`no line with special ${special}`);
}

beforeEach(() => {
  resetFeetCounts();
  resetPuserHookCounts();
});

/* ------------------------------------------------------------------ */
/* Damage-floor cadence hand-tables (p_spec.c:1021-1043)                */
/* ------------------------------------------------------------------ */

describe('feet damage floors — 32-tic cadence hand-tables', () => {
  const table = [
    ['slime', 5, 10],
    ['strobeHurt', 4, 20],
    ['nukage', 7, 5],
    ['superSlime', 16, 20]
  ] as const;

  for (const [room, special, dmg] of table) {
    it(`sector ${special} (${room}): ${dmg} dmg at tics 0/32/64, source null`, () => {
      const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
      const p = s.players[0]!;
      place(s, ROOM[room][0], ROOM[room][1]);
      runHeadless(s, 96);
      const log = s.hooks.damage;
      expect(log.count).toBe(3);
      // !(leveltime&0x1f): the FIRST damage tic is 0 (P_PlayerThink runs
      // before the leveltime++ at the P_Ticker tail).
      expect(log.entries.map((e) => e.tic)).toEqual([0, 32, 64]);
      expect(log.entries.every((e) => e.amount === dmg)).toBe(true);
      expect(log.entries.every((e) => e.source === null)).toBe(true);
      expect(log.entries.every((e) => e.thing === p.mo.linkSlot)).toBe(true);
      expect(s.hooks.exit.count).toBe(0);
    });
  }

  it('no damage floor ⇒ zero slot calls, zero feet dispatch', () => {
    const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
    place(s, ROOM.hall[0], ROOM.hall[1]);
    runHeadless(s, 70);
    expect(s.hooks.damage.count).toBe(0);
    expect(feetCounts.calls).toBe(0);
    expect(puserHookCounts.playerInSpecialSector).toBe(0);
  });

  it('FALLING over slime does not damage (z != floorZ gate, p_spec.c:1013)', () => {
    const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
    const p = s.players[0]!;
    const sec = place(s, ROOM.nukage[0], ROOM.nukage[1]);
    p.mo.z = s.sectors.floorZ[sec]! + fx(8); // airborne over the nukage
    pPlayerInSpecialSector(s, p, sec);
    expect(s.hooks.damage.count).toBe(0);
    expect(feetCounts.calls).toBe(1);
    // Same tic, grounded ⇒ the slot fires (cadence tic 0).
    p.mo.z = s.sectors.floorZ[sec]!;
    pPlayerInSpecialSector(s, p, sec);
    expect(s.hooks.damage.count).toBe(1);
  });

  it('drop onto slime: first hit only on a !(t&31) tic; double-run hash', () => {
    const drop = (): { h: number; log: string } => {
      const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
      const p = s.players[0]!;
      const sec = place(s, ROOM.nukage[0], ROOM.nukage[1]);
      p.mo.z = s.sectors.floorZ[sec]! + fx(80);
      runHeadless(s, 64);
      return {
        h: hashState(s),
        log: s.hooks.damage.entries.map((e) => `${e.tic}:${e.amount}`).join(',')
      };
    };
    const a = drop();
    const b = drop();
    expect(a.h).toBe(b.h);
    // Nothing before landing; every hit lands on a cadence tic.
    for (const e of s0Entries(a.log)) {
      expect(e.tic % 32).toBe(0);
      expect(e.tic).toBeGreaterThan(0); // still airborne at tic 0
    }
    expect(a.log.length).toBeGreaterThan(0);
  });

  it('route walk across a nukage floor into super slime: damage en route, '
     + 'double-run equal', () => {
    const walk = (): { h: number; entries: string } => {
      const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
      place(s, 64, 384, 0); // nukage room, west end, facing EAST (angle 0)
      const input: GameInput = { ...emptyInput(), forward: true };
      runHeadless(s, 64, () => input);
      return {
        h: hashState(s),
        entries: s.hooks.damage.entries
          .map((e) => `${e.tic}:${e.amount}`).join(',')
      };
    };
    const a = walk();
    const b = walk();
    // The feet READ happens in P_PlayerThink (before that tic's
    // P_XYMovement): tic 0 is mid-nukage (5), tic 32 is still ~1 unit
    // short of the open seam into the super-slime room — so both hits
    // carry the nukage amount, and the wall-clock of the seam crossing
    // (tic 32–33) is baked into this hand-table.
    expect(a.entries).toBe('0:5,32:5');
    expect(a.h).toBe(b.h);
  });
});

/* ------------------------------------------------------------------ */
/* ironfeet / P_Random()<5 rules (p_spec.c:1023-1043)                   */
/* ------------------------------------------------------------------ */

/** RNG-QUIET damage fixture: ONLY feet specials (no light/strobe sector
 * specials anywhere — plights thinkers draw P_Random map-wide, which
 * would poison the exact draw-count hand-tables below). Same room grid
 * corners as SECFIX for the damage rooms. */
const FEET_RNG_SPEC = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 }, // hall (start)
    { x: 256, y: 0, w: 256, h: 256, special: 5 }, // helslime
    { x: 0, y: 256, w: 256, h: 256, special: 7 }, // nukage
    { x: 256, y: 256, w: 256, h: 256, special: 16 } // super helslime
  ],
  things: [{ x: 64, y: 64, angle: 0, type: 1 }]
} satisfies RectMapSpec;

const RNG_ROOM = {
  slime: [384, 128],
  nukage: [128, 384],
  superSlime: [384, 384]
} as const;

describe('feet — pw_ironfeet gate and the randBypass draw', () => {
  const withPowers = (s: GameState, ironfeet: number): void => {
    // ironfeet is a COUNTDOWN (p_user.c:347 `if (p) p--` — B-05 wiring) —
    // pin it high for the whole run (a real SUIT gives IRONTICS=2100).
    (s.players[0] as unknown as { powers?: number[] }).powers =
      [0, 0, ironfeet, 0, 0, 0];
  };

  it('ironfeet blocks specials 5/7 completely — and draws NO P_Random', () => {
    for (const room of ['slime', 'nukage'] as const) {
      const s = stateFromNamed(FEET_RNG_SPEC, 'FIXMAP');
      withPowers(s, 10000);
      place(s, RNG_ROOM[room][0], RNG_ROOM[room][1]);
      runHeadless(s, 96);
      expect(s.hooks.damage.count).toBe(0);
      expect(s.rng.prndindex).toBe(0); // `!powers[...]` short-circuits
    }
  });

  it('special 16 + ironfeet: P_Random draws EVERY grounded tic (RNG table ' +
     'hand-table: idx0=0<5 hits @0, idx32=212 misses @32, idx64=141 misses @64)',
  () => {
    const s = stateFromNamed(FEET_RNG_SPEC, 'FIXMAP');
    withPowers(s, 10000);
    s.rng.prndindex = 255; // first draw lands on rndtable[0] = 0 (<5)
    place(s, RNG_ROOM.superSlime[0], RNG_ROOM.superSlime[1]);
    runHeadless(s, 96);
    expect(s.hooks.damage.count).toBe(1);
    expect(s.hooks.damage.entries[0]!.tic).toBe(0);
    expect(s.rng.prndindex).toBe(95); // 96 draws from index 255
  });

  it('special 16 WITHOUT ironfeet: 20 dmg/32 tics and zero draws', () => {
    const s = stateFromNamed(FEET_RNG_SPEC, 'FIXMAP');
    place(s, RNG_ROOM.superSlime[0], RNG_ROOM.superSlime[1]);
    runHeadless(s, 96);
    expect(s.hooks.damage.count).toBe(3);
    expect(s.rng.prndindex).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* Secret sectors (p_spec.c:1047-1050 + P_SpawnSpecials :1305)          */
/* ------------------------------------------------------------------ */

describe('feet — secret sector 9', () => {
  it('totalsecret counted at load; standing in drops secretcount once, ' +
     'zeroes the special, logs NO message (1.10 has none — R05 §5)', () => {
    const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
    expect(s.totalsecret).toBe(1); // one SECTOR_SECRET room
    expect(s.secretcount).toBe(0);
    const before = hashState(s);

    const sec = place(s, ROOM.secret[0], ROOM.secret[1]);
    expect(s.sectors.special[sec]).toBe(9);
    gTicker(s);
    expect(s.secretcount).toBe(1);
    expect(s.sectors.special[sec]).toBe(0);
    expect(s.hooks.message.count).toBe(0);
    expect(hashState(s)).not.toBe(before); // secretcount is hashed

    // The call-site gate (p_user.c:274 `if (sector->special)`) is dead now.
    puserHookCounts.playerInSpecialSector = 0;
    runHeadless(s, 64);
    expect(s.secretcount).toBe(1);
    expect(puserHookCounts.playerInSpecialSector).toBe(0);
    expect(s.hooks.damage.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* E1M8 finale — sector special 11 (p_spec.c:1054-1063)                 */
/* ------------------------------------------------------------------ */

describe('feet — E1M8 finale (EXIT SUPER DAMAGE)', () => {
  it('clears CF_GODMODE on the first grounded tic; 20 dmg/32 tics even ' +
     'with godmode (P_DamageMobj filtering itself is M7)', () => {
    const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
    const p = s.players[0]!;
    p.cheats |= CF_GODMODE;
    place(s, ROOM.finale[0], ROOM.finale[1]);
    runHeadless(s, 64);
    expect(p.cheats & CF_GODMODE).toBe(0);
    expect(s.hooks.damage.entries.map((e) => e.tic)).toEqual([0, 32]);
    expect(s.hooks.damage.entries.every((e) => e.amount === 20)).toBe(true);
    expect(s.exitRequest).toBe('none'); // hp 100 > 10
  });

  it('health clamp fixture (damage-slot-fed): hp <= 10 ⇒ G_ExitLevel, ' +
     'hp = 11 ⇒ never exits', () => {
    const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
    const p = s.players[0]!;
    p.health = 10; // M7 applies slot damage; fixtures clamp directly
    place(s, ROOM.finale[0], ROOM.finale[1]);
    gTicker(s);
    expect(s.exitRequest).toBe('normal');
    expect(s.specialexit).toBe(false); // G_ExitLevel clears (g_game.c:1004)
    expect(s.hooks.exit.entries).toEqual([{ kind: 'normal', tic: 0 }]);

    const s2 = stateFromNamed(M6_SCENES.sector, 'M6SECT');
    s2.players[0]!.health = 11;
    place(s2, ROOM.finale[0], ROOM.finale[1]);
    runHeadless(s2, 33);
    expect(s2.exitRequest).toBe('none');
    expect(s2.hooks.exit.count).toBe(0);
    expect(s2.hooks.damage.count).toBe(2); // tics 0 and 32
  });
});

/* ------------------------------------------------------------------ */
/* default: I_Error ⇒ typed throw + counter (p_spec.c:1065-1067)        */
/* ------------------------------------------------------------------ */

describe('feet — unknown sector special typed throw', () => {
  it('census-excluded special 6 under a grounded player throws and counts',
  () => {
    const s = stateFromNamed(M6_SCENES.sector, 'M6SECT');
    const sec = place(s, ROOM.hall[0], ROOM.hall[1]);
    s.sectors.special[sec] = 6; // no case in P_SpawnSpecials NOR the feet switch
    expect(() => gTicker(s)).toThrow(UnknownSectorSpecialError);
    expect(feetCounts.unknownSpecial).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* Exits — W1 52/124 cross, S1 11/51 use (p_spec.c/p_switch.c)          */
/* ------------------------------------------------------------------ */

const EXITS_SPEC = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256 },
    { x: 256, y: 0, w: 256, h: 256 }
  ],
  triggers: [
    { x1: 0, y1: 64, x2: 0, y2: 128, special: 11 }, // S1 exit (west wall)
    { x1: 0, y1: 128, x2: 0, y2: 192, special: 51 }, // S1 secret exit
    { x1: 512, y1: 64, x2: 512, y2: 128, special: 52 }, // W1 exit
    { x1: 512, y1: 128, x2: 512, y2: 192, special: 124 } // W1 secret exit
  ],
  things: [{ x: 64, y: 64, angle: 0, type: 1 }]
} satisfies RectMapSpec;

describe('exits — exitRequest hook (D013(e)/D013(g), pexit.ts)', () => {
  it('cross 52 ⇒ normal; cross 124 ⇒ secret + specialexit; neither clears; ' +
     'a later G_ExitLevel clears specialexit (g_game.c:1004)', () => {
    const s = stateFromNamed(EXITS_SPEC, 'FIXMAP');
    pCrossSpecialLine(s.pmap, lineWithSpecial(s, 52), 0, PLAYER);
    expect(s.exitRequest).toBe('normal');
    expect(s.specialexit).toBe(false);

    const l124 = lineWithSpecial(s, 124);
    pCrossSpecialLine(s.pmap, l124, 0, PLAYER);
    expect(s.exitRequest).toBe('secret');
    expect(s.specialexit).toBe(true);
    expect(s.map.lines.special[l124]).toBe(124); // W1 exits never clear
    expect(s.map.lines.special[lineWithSpecial(s, 52)]).toBe(52);

    pCrossSpecialLine(s.pmap, lineWithSpecial(s, 52), 0, PLAYER);
    expect(s.exitRequest).toBe('normal'); // last wins
    expect(s.specialexit).toBe(false);
    expect(s.hooks.exit.entries.map((e) => e.kind)).toEqual([
      'normal', 'secret', 'normal'
    ]);
  });

  it('use 11/51 route the exits (switchBefore ⇒ ChangeSwitchTexture stub ' +
     'runs FIRST; texture/sfx machinery is M6-11)', () => {
    const s = stateFromNamed(EXITS_SPEC, 'FIXMAP');
    expect(pUseSpecialLine(s, PLAYER, lineWithSpecial(s, 11), 0)).toBe(true);
    expect(s.exitRequest).toBe('normal');
    expect(pUseSpecialLine(s, PLAYER, lineWithSpecial(s, 51), 0)).toBe(true);
    expect(s.exitRequest).toBe('secret');
    expect(s.specialexit).toBe(true);
    expect(s.hooks.exit.count).toBe(2);
  });

  it('use-side special-124 fires NOTHING (side-0 gate is its only quirk)',
  () => {
    const s = stateFromNamed(EXITS_SPEC, 'FIXMAP');
    expect(pUseSpecialLine(s, PLAYER, lineWithSpecial(s, 124), 0)).toBe(true);
    expect(s.exitRequest).toBe('none'); // vanilla: no use case for 124
    expect(s.hooks.exit.count).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* E1M1 (skipIf): headless route on a damaging floor + determinism      */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

const FEET_DAMAGE: Readonly<Record<number, number>> = {
  4: 20, 5: 10, 7: 5, 11: 20, 16: 20
};

/** A point whose sectorAtPoint is the given sector (bbox grid scan —
 * P_GroupLines soundorgs are NOT guaranteed inside concave sectors). */
function pointInSector(s: GameState, sector: number): [number, number] {
  const m = s.map;
  const l = m.sectors.bboxLeft[sector]!;
  const r = m.sectors.bboxRight[sector]!;
  const b = m.sectors.bboxBottom[sector]!;
  const t = m.sectors.bboxTop[sector]!;
  for (let x = l + fx(8); x <= r - fx(8); x += fx(24)) {
    for (let y = b + fx(8); y <= t - fx(8); y += fx(24)) {
      if (sectorAtPoint(m, x, y) === sector) return [x, y];
    }
  }
  throw new Error(`sector ${sector}: no sample point`);
}

describe.skipIf(!hasWad)('freedoom1.wad E1M1 — damaging floor route', () => {
  it('damage-sector stand ⇒ exact cadence, amount per table; double-run ' +
     'hash equal (no damage sector in E1M1 ⇒ zero-damage determinism)', () => {
    const load = (): GameState => {
      const buf = readFileSync(WAD_PATH);
      const ab = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength
      ) as ArrayBuffer;
      return gInitGame(buildMapFromData(loadMap(WadFile.parse(ab), 'E1M1')));
    };
    const probe = (): { h: number; dmg: number; special: number } => {
      const s = load();
      let target = -1;
      for (let i = 0; i < s.sectors.count; i++) {
        const sp = s.sectors.special[i]!;
        if (FEET_DAMAGE[sp] !== undefined) { target = i; break; }
      }
      if (target >= 0) {
        const [x, y] = pointInSector(s, target);
        place(s, x / FRACUNIT, y / FRACUNIT);
      }
      runHeadless(s, 70);
      return {
        h: hashState(s),
        dmg: s.hooks.damage.count,
        special: target >= 0 ? s.sectors.special[target]! : 0
      };
    };
    const a = probe();
    const b = probe();
    expect(a.h).toBe(b.h);
    if (a.special !== 0) {
      expect(a.dmg).toBe(3); // tics 0/32/64 of a 70-tic stand
      const s = load();
      // re-derive the same first damage sector and re-check the amount
      const target = [...Array(s.sectors.count).keys()]
        .find((i) => FEET_DAMAGE[s.sectors.special[i]!] !== undefined)!;
      const [x, y] = pointInSector(s, target);
      place(s, x / FRACUNIT, y / FRACUNIT);
      runHeadless(s, 70);
      expect(
        s.hooks.damage.entries.every((e) => e.amount === FEET_DAMAGE[a.special])
      ).toBe(true);
      expect(s.hooks.damage.entries.map((e) => e.tic)).toEqual([0, 32, 64]);
    } else {
      expect(a.dmg).toBe(0); // recorded so a silent regression is loud
    }
  });
});

/* helpers ------------------------------------------------------------ */

function s0Entries(log: string): { tic: number; amount: number }[] {
  if (!log) return [];
  return log.split(',').map((e) => {
    const [tic, amount] = e.split(':').map(Number) as [number, number];
    return { tic, amount };
  });
}
