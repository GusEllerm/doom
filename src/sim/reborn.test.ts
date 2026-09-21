// sim/reborn.test.ts — M9-08: faithful G_DoReborn (D017 RETIRED).
//
// Chain under test (plan §M9-08/§0.3/§0.5, sources re-read from
// linuxdoom-1.10 this pass): P_KillMobj → PST_DEAD (p_mobj.c) →
// P_DeathThink BT_USE latch → PST_REBORN (p_user.c:225) → G_Ticker reborn
// pass (g_game.c:613-614) → G_DoReborn (:924) → `gameaction =
// ga_loadlevel` (:928, reborn.ts) → same-tic drain (:621-649) →
// G_DoLoadLevel (:445) → P_SetupLevel (p_setup.c:585) → P_SpawnPlayer →
// G_PlayerReborn (g_game.c:800-831). FIXMAP fixtures only — no IWAD, the
// goldens move nowhere (no blessed run crosses a death: grep-verified,
// see the M9-08 report).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { MF, MT } from '../wad/info/mobjinfo';
import { NUMAMMO } from '../wad/info/weaponinfo';

import { buildMapFromData } from './map';
import {
  GA, GS, gInitGame, gTicker, gWorldDone, registerGameFlowHooks,
  resetGameFlow, takeWipeRequest, type LevelLoaderFn
} from './game';
import { hashState, type GameState } from './state';
import type { RuntimeMap } from './map';
import { asMobj, pRemoveMobj, type Mobj } from './p_mobj';
import { pKillMobjPlayer, pKillPlayer } from './pplayer';
import { PST_DEAD, PST_LIVE, PST_REBORN, type Player } from './player';
import { MAXAMMO } from './p_ammo';
import { WP_NOCHANGE, WP_PISTOL } from './p_pspr';
import { emptyInput, type GameInput } from './ticcmd';
import { gameactionLog, resetGameactionLog } from './hooks';
import { gDoReborn, GA_LOADLEVEL } from './reborn';

/* ------------------------------------------------------------------ */
/* Fixture: one room, 1-player start, 3 possessed, 1 medikit           */
/* ------------------------------------------------------------------ */

const SPEC: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 640, h: 640, ceilingHeight: 128, lightLevel: 200 }],
  things: [
    { x: 64, y: 64, angle: 90, type: 1 }, // player 1 start
    { x: 400, y: 400, angle: 0, type: 3004 }, // MT_POSSESSED x3
    { x: 420, y: 400, angle: 0, type: 3004 },
    { x: 440, y: 400, angle: 0, type: 3004 },
    { x: 300, y: 100, angle: 0, type: 2012 } // MT_MISC11 medikit
  ]
};

function buildMap(name = 'FIXMAP'): RuntimeMap {
  const bytes = buildFixtureMapWad(SPEC, name);
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return buildMapFromData(loadMap(WadFile.parse(buf), name));
}

/** Fresh world + the same-map reload loader (main.ts registers the real
 * WAD-backed loader; P_SetupLevel semantics are identical). */
function bootWithReload(): GameState {
  const s = gInitGame(buildMap());
  registerGameFlowHooks({ levelLoader: (st) => st.map });
  return s;
}

const P = (s: GameState): Player & Record<string, unknown> =>
  s.players[0] as Player & Record<string, unknown>;
const MO = (s: GameState): Mobj => asMobj(s.players[0]!.mo)!;

const NOIN: GameInput = emptyInput();
const USE: GameInput = { ...emptyInput(), use: true };
const FWD: GameInput = { ...emptyInput(), forward: true };

function step(s: GameState, n: number, inp: GameInput = NOIN): void {
  for (let i = 0; i < n; i++) gTicker(s, inp);
}

/** Shootable (not corpse/removed) mobjs of a type — P_KillMobj leaves a
 * corpse in the world, so "lives again" = MF_SHOOTABLE census. */
function aliveOf(s: GameState, mt: number): Mobj[] {
  return s.mobjs.mobjs.filter(
    (m) => m.type === mt && !m.removed && (m.flags & MF.MF_SHOOTABLE) !== 0
  );
}

/** In-world (not yet picked up/removed) census — pickups are MF_SPECIAL,
 * never MF_SHOOTABLE. */
function presentOf(s: GameState, mt: number): Mobj[] {
  return s.mobjs.mobjs.filter((m) => m.type === mt && !m.removed);
}

/** Kill everything the script hands us, then kill the player. */
function killMonsters(s: GameState): number {
  let n = 0;
  for (const m of aliveOf(s, MT.MT_POSSESSED)) {
    pKillMobjPlayer(null, m);
    n++;
  }
  return n;
}

/** pKillPlayer at tic 0, then one USE tic latches PST_REBORN inside
 * P_DeathThink (p_user.c:225), the NEXT tic runs pass+drain. Returns
 * after that second tic — the reload has happened by then (g_game.c
 * 613-614 → :621-649, SAME gTicker call). */
function dieAndReborn(s: GameState): void {
  pKillPlayer(P(s));
  step(s, 1, USE); // death-cam tic: BT_USE latch inside the tic
  step(s, 1, USE); // pass → G_DoReborn → ga_loadlevel → drain (this tic)
}

beforeEach(() => {
  resetGameFlow();
  resetGameactionLog();
});
afterEach(() => resetGameFlow());

/* ------------------------------------------------------------------ */
describe('M9-08 gDoReborn: the gameaction half (g_game.c:924-929)', () => {
  it('GA_LOADLEVEL is GA.loadlevel (d_event.h:56, cycle-avoiding pin)', () => {
    expect(GA_LOADLEVEL).toBe(GA.loadlevel);
  });

  it('body: !netgame ⇒ sets gameaction = ga_loadlevel and NOTHING else', () => {
    const s = bootWithReload();
    const before = hashState(s);
    gDoReborn(s);
    expect(s.gameaction).toBe(GA.loadlevel);
    expect(hashState(s)).toBe(before); // no world mutation — pure arm
    // (no player/mobj/sector touch: g_game.c:928 is the whole statement)
  });

  it('the pass+drain consume it INSIDE one gTicker (gameaction never survives)', () => {
    const s = bootWithReload();
    P(s).playerstate = PST_REBORN; // the netgame-style direct latch
    gTicker(s); // ONE call: pass arms, drain loads, spawn disarms
    expect(s.gameaction).toBe(GA.nothing);
    expect(P(s).playerstate).toBe(PST_LIVE);
    expect(gameactionLog.entries.map((e) => e.action)).toEqual([GA.loadlevel]);
  });
});

/* ------------------------------------------------------------------ */
describe('M9-08 death chain: die → SAME MAP reloads from scratch', () => {
  it('monsters respawn, medikit comes back, player pistol-starts at start', () => {
    const s = bootWithReload();
    const corpse = MO(s);
    step(s, 20, FWD); // start faces 90° ⇒ forward walks +y
    expect(s.players[0]!.mo.y).not.toBe(64 << 16);

    expect(killMonsters(s)).toBe(3); // all three possessed die
    expect(aliveOf(s, MT.MT_POSSESSED).length).toBe(0);
    const med = presentOf(s, MT.MT_MISC11)[0]!;
    pRemoveMobj(med); // "taken medikits refill": gone from the world
    expect(presentOf(s, MT.MT_MISC11).length).toBe(0);
    expect(P(s).playerstate).not.toBe(PST_DEAD);

    dieAndReborn(s);

    // level identity + flow truth (g_game.c:461/:928, §0.3):
    expect(s.gamestate).toBe(GS.LEVEL);
    expect(s.gameaction).toBe(GA.nothing);
    expect(s.viewactive).toBe(true);
    expect(s.wipegamestate).toBe(-1); // g_game.c:451 force-melt sentinel
    expect(takeWipeRequest(s)).toBe(true); // consumed exactly once
    expect(takeWipeRequest(s)).toBe(false);

    // WORLD reborn (P_SetupLevel: fresh thinker list, P_LoadThings):
    const poss = aliveOf(s, MT.MT_POSSESSED);
    expect(poss.length).toBe(3); // a killed baron lives again
    for (const m of poss) expect(m.health).toBe(20); // mobjinfo spawnhealth
    const med2 = presentOf(s, MT.MT_MISC11);
    expect(med2.length).toBe(1);
    expect(med2[0]!.flags & MF.MF_SPECIAL).not.toBe(0); // refill stands

    // PLAYER (P_SpawnPlayer reborn branch, g_game.c:656-657 → :800):
    expect(P(s).playerstate).toBe(PST_LIVE);
    expect(MO(s)).not.toBe(corpse); // a NEW mobj in the NEW runtime
    expect(MO(s).x).toBe(64 << 16); // back at the 1-player start
    expect(MO(s).y).toBe(64 << 16);
    expect(P(s).health).toBe(100);
    // leveltime reset pin (p_setup.c:647 at the drain, ++ at the tail):
    // the 22 tics of history are GONE — the clock restarts at 1.
    expect(s.leveltime).toBe(1);
  });

  it('SOURCE VERDICT: kill/item/secretcount + frags RESET on the reload', () => {
    const s = bootWithReload();
    expect(killMonsters(s)).toBe(3);
    expect(P(s).killcount).toBe(3); // COUNTKILL sweep credit
    P(s).itemcount = 7; // simulate seven pickups
    s.secretcount = 2; // player->secretcount proxy (state.ts:190)
    P(s).frags[0] = 5;
    s.totalsecret = 9; // stale total (re-derived by the specials pass)

    dieAndReborn(s);

    // P_SetupLevel zeroes the per-player tallies (p_setup.c:597-601)
    // BEFORE P_LoadThings — G_PlayerReborn's preserve/restore pair
    // (g_game.c:806-819) therefore preserves ZERO on the reload path;
    // the preservation is only observable on the netgame respawn
    // branch (g_game.c:936-959, M12). SECRET FLAGS: per-player
    // secretcount is the same zeroing ⇒ FOUND secrets do NOT survive
    // death; the sector-9 trigger re-arms with the fresh specials pass
    // and totalsecret is re-derived (p_setup.c:593 + P_SpawnSpecials).
    expect(P(s).killcount).toBe(0);
    expect(P(s).itemcount).toBe(0);
    expect(s.secretcount).toBe(0);
    expect(s.totalsecret).toBe(0); // fixture has no sector 19 ⇒ 0
    expect(P(s).frags[0]).toBe(0); // G_DoLoadLevel frags memset (:482)
  });

  it('PST_DEAD at load time joins the reborn spawn (g_game.c:479-481)', () => {
    const s = bootWithReload();
    // load armed while the player is DEAD (e.g. ga_newgame while dying):
    pKillPlayer(P(s));
    expect(P(s).playerstate).toBe(PST_DEAD);
    s.gameaction = GA.loadlevel; // a load not armed by the reborn pass
    gTicker(s);
    expect(P(s).playerstate).toBe(PST_LIVE); // DEAD→REBORN→spawned live
    expect(MO(s).health).toBe(100);
  });
});

/* ------------------------------------------------------------------ */
describe('M9-08 G_PlayerReborn end-state through the live chain (§0.5)', () => {
  it('full arsenal + powers + cheats are memset; pistol start kept', () => {
    const s = bootWithReload();
    const p = P(s);
    const inv = p as unknown as {
      ammo: Int32Array; maxammo: Int32Array; powers: Int32Array;
      cards: Int32Array; weaponowned: Int32Array; armorpoints: number;
      armortype: number; backpack: boolean; readyweapon: number;
      pendingweapon: number; attackdown: boolean; usedown: boolean;
    };
    // an endgame-ish player state before dying:
    p.cheats = 7; // iddqd+idfa+noclip
    inv.ammo.fill(40); // all four types stuffed
    inv.weaponowned.fill(1); // all nine
    inv.powers.fill(60);
    inv.cards.fill(1);
    inv.armorpoints = 200;
    inv.armortype = 2;
    inv.backpack = true;
    s.totalsecret = 0;
    step(s, 2);
    dieAndReborn(s);

    expect(p.cheats).toBe(0); // the memset KILLS cheats (vanilla)
    expect(inv.ammo[0]).toBe(50); // AM_CLIP = 50 (g_game.c:828)
    for (let i = 1; i < NUMAMMO; i++) expect(inv.ammo[i]).toBe(0);
    for (let i = 0; i < NUMAMMO; i++) expect(inv.maxammo[i]).toBe(MAXAMMO[i]!); // :830
    expect(inv.backpack).toBe(false); // double-max LOST (memset)
    expect(inv.weaponowned[0]).toBe(1); // fist
    expect(inv.weaponowned[1]).toBe(1); // pistol
    for (let w = 2; w < 9; w++) expect(inv.weaponowned[w]).toBe(0); // 2-9 gone
    expect(inv.readyweapon).toBe(WP_PISTOL); // :817 ready=pending=pistol
    // G_PlayerReborn sets pending=pistol, then the SAME spawn's
    // P_SetupPsprites (p_pspr.c:405, p_pspr.ts:285) consumes it →
    // wp_nochange + P_BringUpWeapon raises the pistol:
    expect(inv.pendingweapon).toBe(WP_NOCHANGE);
    expect(inv.powers.every((x) => x === 0)).toBe(true);
    expect(inv.cards.every((x) => x === 0)).toBe(true);
    expect(inv.armorpoints).toBe(0);
    expect(inv.armortype).toBe(0);
    expect(p.health).toBe(100);
    expect(inv.attackdown).toBe(true); // "don't do anything immediately"
    expect(inv.usedown).toBe(true); //   (g_game.c:815)
    expect(p.playerstate).toBe(PST_LIVE);
  });
});

/* ------------------------------------------------------------------ */
describe('M9-08 determinism + level-transition boundary', () => {
  it('double-run across a death: identical hashes at every checkpoint', () => {
    const script = (tic: number): GameInput => (tic < 30 ? FWD : USE);
    const run = (die: boolean): number[] => {
      const s = bootWithReload();
      const marks: number[] = [];
      for (let t = 0; t < 150; t++) {
        if (die && t === 30) killMonsters(s); // rng-drawing kill sweep
        if (die && t === 31) pKillPlayer(P(s)); // die at tic 31
        gTicker(s, script(t));
        if (t === 40 || t === 99 || t === 149) marks.push(hashState(s));
      }
      return marks;
    };
    const a = run(true);
    const b = run(true);
    expect(a).toEqual(b); // determinism ACROSS the reload (PRNG streams
    // continue — M_ClearRandom is a G_InitNew site, not a load site).
    const alive = run(false); // identical inputs, no death
    expect(a).not.toEqual(alive); // the reload really rebuilt the world
  });

  it('gWorldDone → next map: LIVE player carries over, tallies reset', () => {
    // boundary pin for the gSetupLevel zeroing (p_setup.c:597-601): a
    // SURVIVING player is NOT reborn (inventory carries across levels —
    // no G_PlayerReborn without the PST_REBORN latch), but the per-level
    // counters and the world still re-setup.
    resetGameFlow();
    const a = buildMap('FIXMAP');
    const b = buildMap('FIXMAP');
    const loader: LevelLoaderFn = (_st, _ep, map) => (map === 1 ? a : b);
    const s = gInitGame(a);
    registerGameFlowHooks({ levelLoader: loader });
    const p = P(s);
    const inv = p as unknown as { ammo: Int32Array; weaponowned: Int32Array };
    inv.ammo[0] = 17; // collected shells-equivalent (clip slot)
    inv.weaponowned[2] = 1; // shotgun carried
    killMonsters(s);
    expect(p.killcount).toBe(3);

    s.wminfo.next = 1; // wminfo.next = gamemap-1 ⇒ E?M2 (§0.3)
    gWorldDone(s); // g_game.c:1147 — ga_worlddone
    gTicker(s); // drain → G_DoWorldDone → G_DoLoadLevel (:1172)

    expect(s.gamemap).toBe(2);
    expect(s.gamestate).toBe(GS.LEVEL);
    expect(s.viewactive).toBe(true);
    expect(s.leveltime).toBe(1); // reset at the drain, ++ at the tail
    expect(p.playerstate).toBe(PST_LIVE); // NOT PST_REBORN (survivor)
    expect(inv.ammo[0]).toBe(17); // inventory carries across the exit
    expect(inv.weaponowned[2]).toBe(1);
    expect(p.killcount).toBe(0); // per-level tally (p_setup.c:597)
    expect(s.secretcount).toBe(0);
    expect(aliveOf(s, MT.MT_POSSESSED).length).toBe(3); // fresh world
  });
});
