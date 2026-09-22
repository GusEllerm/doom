// tests/headless/bug-combat-live.test.ts — BUG-combat-t2 regression suites
// (docs/BUGS.md B-02 "shoot but nothing dies" + B-03 "remains on the
// ground on first level"), on the REAL freedoom1 E1M1.
//
// B-02 ROOT CAUSE (fixed): p_enemy.ts promoteMoverSlot handed the chase-
// promoted monster a ZEROED, UNLINKED dynamic slot and relied on the
// FOLLOWING P_TryMove to link it — a blocked first chase step never
// relinks (vanilla's P_CheckPosition restore-half does; the port's
// stateless CheckPosition does not), leaving the monster invisible to
// every PIT query: hitscan passes THROUGH it, nothing ever dies. The fix
// links at the current position during promotion (the p_inter_damage.ts
// kick-side rule, now shared).
//
// B-03 ROOT CAUSE (fixed): freedoom:1-style E1M1 THINGS carry netgame
// start markers (doomednums 10/12/13/14 and 15/17-21). The 1.10 info.c
// table maps those doomednums onto corpse/gib spawnstates (MT_MISC62 =
// S_PLAY_DIE7 etc. — merged-table artifact); DOOM.EXE's spawn switch
// intercepted them as start points BEFORE the scan so single player never
// spawned them. The port copied the table scan without the switch ⇒ 23
// inert "remains" mobjs on E1M1's floor. Fix: capture-only (rt
// .netGameStarts), never spawn.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FRACUNIT } from '../../src/core/constants';
import { loadMap } from '../../src/wad/mapdata';
import { WadFile } from '../../src/wad/wadfile';
import { MT, mobjinfo } from '../../src/wad/info/mobjinfo';
import { stateAt, stateNext } from '../../src/wad/info/states';
import { buildMapFromData, mapThingAt } from '../../src/sim/map';
import { gInitGame, gTicker } from '../../src/sim/game';
import { pTeleportMove } from '../../src/sim/pmap';
import { isNetGameStartMarker, MF_COUNTKILL, MF_SHOOTABLE, thingLinksIterator } from '../../src/sim/thinglinks';
import { blockIndexOf } from '../../src/sim/blockmap';
import { pAimLineAttack, linetarget } from '../../src/sim/p_shoot';
import { pCheckSight } from '../../src/sim/psight';
import type { GameState } from '../../src/sim/state';
import type { Mobj } from '../../src/sim/p_mobj';
import { emptyInput } from '../../src/sim/ticcmd';

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);
const buf = hasWad ? readFileSync(WAD_PATH) : null;

function bootE1M1(): GameState {
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf!.buffer as ArrayBuffer), 'E1M1')));
}

/** debugSim.warp semantics: relink + destination-floor z (floorz default). */
function warp(s: GameState, x: number, y: number, angle: number): void {
  const mo = s.players[0]!.mo;
  if (angle >= 0) mo.angle = angle;
  pTeleportMove(s.pmap, mo, x, y);
  mo.z = mo.floorz;
}

const NETGAME_STARTS = [10, 12, 13, 15, 17, 18, 19, 20, 21];

describe.skipIf(!hasWad)('BUG-combat-t2: real-E1M1 live-path regressions', () => {
  it('B-03 boot roster purity: no netgame-start spawns, no corpse frames, no puffs/blood', () => {
    const s = bootE1M1();
    // (a) every live mobj's rendered (sprite,frame) is NOT a
    // player/monster DEATH-state frame (the "remains" signature)
    // (a) no mobj sits in a death/xdeath/raise STATE of a player or E1
    // monster (walked via stateNext so barrel/decor chain overlaps can
    // never alias). This is the exact "remains" signature of B-03:
    // MT_MISC62/68/69 spawn S_PLAY_DIE7/S_PLAY_XDIE9, MT_MISC63/67/66/64
    // spawn the POSS/SPOS/TROO/SARG DIE-final frames.
    const deathStates = new Set<number>();
    for (const mt of [MT.MT_PLAYER, MT.MT_POSSESSED, MT.MT_SHOTGUY, MT.MT_TROOP, MT.MT_SERGEANT]) {
      const info = mobjinfo[mt]!;
      for (const head of [info.deathState, info.xdeathState, info.raiseState]) {
        let st = head;
        for (let n = 0; st !== 0 && n < 32; n++) {
          deathStates.add(st);
          st = stateNext[st]!;
        }
      }
    }
    for (const m of s.mobjs.mobjs) {
      expect(deathStates.has(m.state), `mobj type=${m.type} state=${m.state} sits in a death chain`).toBe(false);
    }
    // (b) no puff/blood/teleport-fog mobjs exist at leveltime 0
    for (const m of s.mobjs.mobjs) {
      expect([MT.MT_PUFF, MT.MT_BLOOD, MT.MT_TFOG, MT.MT_IFOG].includes(m.type as never), `mtype ${m.type}`).toBe(false);
    }
    // (c) the WAD's netgame-start doomednums are CAPTURED, never spawned
    const map = s.map;
    const raw = new Map<number, number>();
    for (let i = 0; i < map.numThings; i++) {
      const t = mapThingAt(map, i);
      if (isNetGameStartMarker(t.type)) raw.set(t.type, (raw.get(t.type) ?? 0) + 1);
    }
    const rawTotal = [...raw.values()].reduce((a, b) => a + b, 0);
    expect(rawTotal, 'E1M1 carries netgame-start markers').toBeGreaterThan(0);
    expect(s.mobjs.netGameStarts.length, 'captured == raw census').toBe(rawTotal);
    const aliveTypes = new Set(s.mobjs.mobjs.map((m) => DOOMEDNUM_OF(m.type)));
    for (const dn of NETGAME_STARTS) {
      expect(aliveTypes.has(dn), `doomednum ${dn} must never spawn`).toBe(false);
    }
  });

  it('B-02 ghost-monster guard: nothing that LOOKS like a creature is un-shootable', () => {
    // THE B-02 root cause: freedoom:1-style E1M1 carries the netgame/death
    // match START markers (doomednums 10/12/13/14, 15/17-21); the 1.10
    // table maps them onto MT_MISC62/68/69/63/67/66/64 — inert decor
    // (flags = 0: NOT MF_SOLID, NOT MF_SHOOTABLE) whose SPAWNSTATES are
    // player/monster DEATH frames (S_PLAY_DIE7, S_POSS_DIE5 …). They
    // rendered as monster-shaped things the shots passed straight through
    // — "shoot but nothing dies" AND "remains on the ground" from ONE
    // cause. DOOM.EXE intercepted these doomednums as start points; the
    // fix is the isNetGameStartMarker gate (capture-only, rt.netGameStarts).
    const creatureSprites = new Set<number>();
    for (const info of Object.values(mobjinfo)) {
      if ((info.flags & MF_SHOOTABLE) !== 0 && info.seeState !== 0) {
        creatureSprites.add(stateAt(info.spawnState).sprite);
      }
    }
    let ghosts = 0;
    for (const m of bootE1M1().mobjs.mobjs) {
      if (creatureSprites.has(stateAt(m.state).sprite) && (m.flags & MF_SHOOTABLE) === 0) ghosts++;
    }
    expect(ghosts, 'un-shootable creature-sprite ghosts (netgame-start decor)').toBe(0);
  });

  it('B-02 grid-visibility invariant: every alive monster stays in the blockmap while chasing', () => {
    const s = bootE1M1();
    // e2e monsters.spec courtyard scenario: wake the pair, let them chase
    // (first chase step = slot promotion — where the bug lived).
    warp(s, 640 * FRACUNIT, 336 * FRACUNIT, 0);
    for (let tic = 0; tic < 1200; tic++) {
      gTicker(s);
      if (tic % 10 !== 0) continue;
      const links = s.pmap.links;
      for (const m of s.mobjs.mobjs) {
        if (m.removed || (m.flags & MF_COUNTKILL) === 0) continue;
        // The invariant: an alive mover's grid slot is LINKED and sits at
        // the cell its x/y names (promotion may never strand a mover).
        expect(links.linked[m.linkSlot], `tic ${tic}: alive monster stranded in unlinked slot ${m.linkSlot}`).toBe(1);
        let found = false;
        const cx = blockIndexOf(m.x - links.bm.originX);
        const cy = blockIndexOf(m.y - links.bm.originY);
        thingLinksIterator(links, cx, cy, (slot) => {
          if (slot === m.linkSlot) found = true;
          return true;
        });
        expect(found, `tic ${tic}: monster (${m.x >> 16},${m.y >> 16}) absent from its block cell`).toBe(true);
      }
    }
  });

  it('B-02 real-E1M1 pistol kill via ticcmd input: hp drop AND death', () => {
    const s = bootE1M1();
    // Deterministic target acquisition: the first monster with a clear
    // sight line from a warp spot due west of it, at its own floor.
    // Lightest first: POSS/SPOS die to the pistol inside the window even
    // with cover breaks; the scan is deterministic in THINGS order.
    const monsters = s.mobjs.mobjs
      .filter((m) => (m.flags & MF_COUNTKILL) !== 0 && !m.removed)
      .sort((a, b) => (a.type === MT.MT_POSSESSED || a.type === MT.MT_SHOTGUY ? 0 : 1) - (b.type === MT.MT_POSSESSED || b.type === MT.MT_SHOTGUY ? 0 : 1));
    let target: Mobj | null = null;
    outer: for (const mo of monsters) {
      for (const d of [128, 192, 256, 384, 512]) {
        warp(s, mo.x - d * FRACUNIT, mo.y, 0);
        gTicker(s);
        gTicker(s);
        if (pCheckSight(s.mobjs, s.players[0]!.mo as never, mo as never)) {
          target = mo;
          break outer;
        }
      }
    }
    expect(target, 'a shootable monster pair exists on E1M1').not.toBeNull();

    // Auto-aim must lock the target (P_BulletSlope's centre probe).
    pAimLineAttack(s.players[0]!.mo as never, 0, 32 * 64 * FRACUNIT);
    expect(linetarget.active, 'autoaim acquires the visible target').toBe(true);

    // Keep the shot window open: deep ammo + body armor (test rig, not a
    // gameplay cheat — the firing path stays the real pistol/ticcmd one).
    const pl = s.players[0] as unknown as { ammo: Int32Array; armorpoints: number; armorlevel: number };
    pl.ammo[0] = 500;
    pl.armorpoints = 200;
    pl.armorlevel = 2;
    const hp0 = target!.health;
    const kills0 = s.players[0]!.killcount;
    for (let tic = 0; tic < 2000; tic++) gTicker(s, { ...emptyInput(), attack: true });
    expect(target!.health < hp0 || target!.removed, 'hp drop from pistol fire').toBe(true);
    // P_KillMobj credit seam: player.killcount (a death clears MF_SHOOTABLE
    // via A_Fall, so flag-scanning the roster is NOT the kill seam).
    expect(s.players[0]!.killcount > kills0, 'monster death registered (killcount seam)').toBe(true);
  });
});

/** MT → its table doomednum (−1/0 when the type never spawns). */
function DOOMEDNUM_OF(mt: number): number {
  return mobjinfo[mt]!.doomednum;
}
