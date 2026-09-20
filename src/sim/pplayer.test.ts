// sim/pplayer.test.ts — M7-03 acceptance: player mobj states, pain/death
// flow, reborn (plan §M7-03). Deterministic: every P_Random touch is at a
// pinned index (mClearRandom at boot; the player spawn draws NOTHING per
// the documented D-t1 skip, so prndindex starts at 0 = rndtable[0] = 0).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { S } from '../wad/info/states';
import { MF, MT } from '../wad/info/mobjinfo';

import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';

import { buildMapFromData } from './map';
import { gInitGame, gTicker } from './game';
import { hashState, type GameState, type Skill } from './state';
import type { Mobj } from './p_mobj';
import { asMobj, pSetMobjState, pSpawnMobj } from './p_mobj';
import { thinkerCount } from './ptick';
import { emptyInput, type GameInput } from './ticcmd';
import { PST_DEAD, PST_LIVE, PST_REBORN, VIEWHEIGHT, type Player } from './player';
import {
  ANG5,
  PW_INVULNERABILITY,
  bindPplayerLevel,
  pKillMobjPlayer,
  pKillPlayer,
  pSpawnPlayerFromStart,
  pHurtPlayer,
  pplayerHookCounts,
  pplayerSoundLog,
  resetPplayerHookCounts,
  resetPplayerSoundLog,
  BASETHRESHOLD
} from './pplayer';
import { ACT, isActionRegistered } from './a_actions';
import { WP_PISTOL } from './p_pspr';
import { puserHookCounts, resetPuserHookCounts } from './puser';

const NOIN: GameInput = emptyInput();
const FWD: GameInput = { ...emptyInput(), forward: true };

function roomSpec(things: RectMapSpec['things']): RectMapSpec {
  return {
    rooms: [{ x: 0, y: 0, w: 512, h: 512, ceilingHeight: 128, lightLevel: 200 }],
    things: [{ x: 32, y: 32, angle: 90, type: 1 }, ...(things ?? [])]
  };
}

function boot(things: RectMapSpec['things'] = [], skill: Skill = 2): GameState {
  const bytes = buildFixtureMapWad(roomSpec(things), 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')), skill);
}

const P = (s: GameState): Player => s.players[0]!;
const MO = (s: GameState): Mobj => asMobj(s.players[0]!.mo)!;

function step(s: GameState, n: number, inp: GameInput = NOIN): void {
  for (let i = 0; i < n; i++) gTicker(s, inp);
}

beforeEach(() => {
  resetPplayerHookCounts();
  resetPplayerSoundLog();
  resetPuserHookCounts();
});

/* ------------------------------------------------------------------ */
describe('M7-03 spawn: the player IS a real mobj (P_SpawnPlayer)', () => {
  it('MT_PLAYER mobj, links, angle, health mirror, hash-excluded thinker', () => {
    const s = boot();
    const m = MO(s);
    expect(m).toBeDefined();
    expect(m.type).toBe(MT.MT_PLAYER);
    expect(m).toBe(s.players[0]!.mo);
    expect(m.player).toBe(true);
    expect((m as Mobj & { playerRef?: Player }).playerRef).toBe(s.players[0]!);
    expect(m.x).toBe(32 << 16);
    expect(m.y).toBe(32 << 16);
    expect(m.angle).toBe(0x40000000); // ANG45 * (90/45)
    expect(m.health).toBe(100);
    expect(s.players[0]!.playerstate).toBe(PST_LIVE);
    expect(m.thinker.excludeFromHash).toBe(true);
    expect(m.thinker.id).toBeGreaterThanOrEqual(0x40000000); // reserved range
  });

  it('registers NOTHING on the hashed thinker-id counter (blessed ids stable)', () => {
    const s = boot();
    const entries = [...s.thinkers.entries.values()];
    expect(entries.length).toBe(1);
    expect(entries[0]!.id >>> 30).toBe(1); // reserved range (player mobj)
    expect(thinkerCount(s.thinkers)).toBe(1);
    // hash twin-run identity (players[]-only serialization preserved)
    const a = boot();
    const b = boot();
    step(a, 30, FWD);
    step(b, 30, FWD);
    expect(hashState(a)).toBe(hashState(b));
  });

  it('no rng draw at spawn (D-t1) + psprites spawn (P_SetupPsprites)', () => {
    const s = boot();
    expect(s.rng.prndindex).toBe(0);
    const pp = P(s) as Player & { psprites: { state: number }[] };
    expect(pp.psprites[0]!.state).not.toBe(0); // gun psprite live
    step(s, 1);
    expect(s.rng.prndindex).toBe(0); // raising the gun draws nothing
    expect(pplayerHookCounts.stHudStart).toBe(1); // ST/HU seam counted
  });

  it('live z through movers: the thinker keeps z at the risen floor', () => {
    const s = boot();
    const m = MO(s);
    const sec = ((): number => {
      // the fixture is a single floor sector — find it via z bookkeeping
      for (let i = 0; i < s.sectors.count; i++) if (s.sectors.floorZ[i] === m.floorz) return i;
      throw new Error('no match');
    })();
    // what the M6 movers do every tic: publish the new floor into the
    // mobj (pThingHeightClip "onfloor ⇒ z = floorz" is the mover body).
    s.sectors.floorZ[sec] = 8 * FRACUNIT;
    m.floorz = 8 * FRACUNIT;
    step(s, 2);
    expect(m.z).toBe(8 * FRACUNIT);
    expect(P(s).viewz).toBeGreaterThan(8 * FRACUNIT);
  });
});

/* ------------------------------------------------------------------ */
describe('M7-03 state machine: RUN entry + walking-frame stop (p_user.c/p_mobj.c)', () => {
  it('walking sets S_PLAY_RUN1 from the standing state; full stop reverts', () => {
    const s = boot();
    expect(MO(s).state).toBe(S.S_PLAY);
    step(s, 4, FWD);
    const m = MO(s);
    expect(m.state - S.S_PLAY_RUN1).toBeGreaterThanOrEqual(0);
    expect(m.state - S.S_PLAY_RUN1).toBeLessThan(4);
    step(s, 80); // release: friction glide → the stop branch
    expect(MO(s).state).toBe(S.S_PLAY);
  });
});

/* ------------------------------------------------------------------ */
describe('M7-03 pain gating matrix (P_DamageMobj player half)', () => {
  it('environmental damage: mirror decrement, pain draw, S_PLAY_PAIN', () => {
    const s = boot();
    pHurtPlayer(P(s), 10);
    expect(P(s).health).toBe(90);
    expect(MO(s).health).toBe(90);
    expect(s.rng.prndindex).toBe(1); // exactly the one pain-chance draw
    expect(MO(s).state).toBe(S.S_PLAY_PAIN); // rndtable[0]=0 < 255
    expect(MO(s).flags & MF.MF_JUSTHIT).not.toBe(0);
    expect(MO(s).reactionTime).toBe(0);
    expect(P(s).attacker).toBeNull();
    expect(P(s).damagecount).toBe(10);
  });

  it('pain chain: A_Pain fires at S_PLAY_PAIN2, back to S_PLAY in 8 tics', () => {
    const s = boot();
    pHurtPlayer(P(s), 5);
    step(s, 1);
    step(s, 3); // 4 tics in PAIN -> PAIN2 (A_Pain)
    expect(pplayerSoundLog.some((e) => e.token === 'sfx_plpain')).toBe(true);
    step(s, 5);
    expect(MO(s).state).toBe(S.S_PLAY);
  });

  it('CF_GODMODE: <1000 damage fully ignored (no draw, no decrement)', () => {
    const s = boot();
    P(s).cheats |= 2; // CF_GODMODE
    pHurtPlayer(P(s), 500);
    expect(P(s).health).toBe(100);
    expect(s.rng.prndindex).toBe(0);
    expect(MO(s).state).toBe(S.S_PLAY);
  });

  it('pw_invulnerability gates identically; 1000+ always cuts through', () => {
    const s = boot();
    (P(s) as unknown as { powers: Int32Array }).powers[PW_INVULNERABILITY] = 100;
    pHurtPlayer(P(s), 100);
    expect(P(s).health).toBe(100);
    pHurtPlayer(P(s), 2000);
    expect(P(s).health).toBe(0); // the hell-hack sector is absent ⇒ dies
    expect(P(s).playerstate).toBe(PST_DEAD);
  });

  it('sk_baby halves the damage before everything', () => {
    const s = boot([], 0);
    pHurtPlayer(P(s), 10);
    expect(P(s).health).toBe(95);
  });

  it('sector special 11 hell hack: survivable by 1 hp', () => {
    const s = boot();
    for (let i = 0; i < s.sectors.count; i++) s.sectors.special[i] = 11;
    pHurtPlayer(P(s), 100);
    expect(P(s).health).toBe(1);
    expect(P(s).playerstate).toBe(PST_LIVE);
  });

  it('thrust kick: inflictor pushes (no draw below the fall-forwards window)', () => {
    const s = boot();
    const m = MO(s);
    const inf = pSpawnMobj(s.mobjs, m.x + 64 * FRACUNIT, m.y, m.z, MT.MT_PUFF);
    const pre = s.rng.prndindex; // the PUFF spawn drew one (lastlook)
    pHurtPlayer(P(s), 30, null, inf);
    expect(m.momx).toBeLessThan(0); // pushed AWAY from the inflictor (-x)
    expect(Math.abs(m.momy)).toBeLessThan(FRACUNIT / 64); // R_PointToAngle's ANG180-1
    expect(s.rng.prndindex).toBe(pre + 1); // pain draw only (fall-forwards false)
  });

  it('damagecount caps at 100 (the teleport-stomp clamp)', () => {
    const s = boot();
    P(s).health = 200;
    MO(s).health = 200;
    pHurtPlayer(P(s), 90);
    pHurtPlayer(P(s), 90);
    expect(P(s).damagecount).toBe(100);
    expect(P(s).health).toBe(20);
  });

  it('attacked by a source mobj: retarget branch runs for players too', () => {
    const s = boot();
    const m = MO(s);
    const src = pSpawnMobj(s.mobjs, m.x + 128 * FRACUNIT, m.y, m.z, MT.MT_POSSESSED);
    pHurtPlayer(P(s), 10, src);
    expect(m.target).toBe(src);
    expect(m.threshold).toBe(BASETHRESHOLD);
    // the pain draw fires BEFORE the generic retarget (255 chance), so
    // the seestate write is gated out this hit; target/threshold stick.
    expect(m.state).toBe(S.S_PLAY_PAIN);
    expect(P(s).attacker).toBe(src);
  });
});

/* ------------------------------------------------------------------ */
describe('M7-03 death flow (P_KillMobj player branch + chain)', () => {
  it('kill bookkeeping: flags, height, PST_DEAD, hooks, S_PLAY_DIE1', () => {
    const s = boot();
    const m = MO(s);
    pKillPlayer(P(s));
    expect(P(s).playerstate).toBe(PST_DEAD);
    expect(m.flags & MF.MF_SHOOTABLE).toBe(0);
    expect(m.flags & MF.MF_CORPSE).not.toBe(0);
    expect(m.flags & MF.MF_DROPOFF).not.toBe(0);
    expect(m.height).toBe((3670016 >> 2) | 0);
    expect(m.state).toBe(S.S_PLAY_DIE1);
    expect(pplayerHookCounts.dropWeapon).toBe(1); // M7-04 hook, counted
    expect(s.rng.prndindex).toBe(1); // the tics clamp draw (rndtable[0]=0 ⇒ 10)
  });

  it('timing table: DIE2 scream @10, A_Fall SOLID-off @20, DIE7 forever', () => {
    const s = boot();
    pKillPlayer(P(s));
    step(s, 9);
    expect(MO(s).state).toBe(S.S_PLAY_DIE1);
    expect(pplayerSoundLog.some((e) => e.token === 'sfx_pldeth')).toBe(false);
    step(s, 1); // tic 10 -> DIE2 dispatches A_PlayerScream
    expect(MO(s).state).toBe(S.S_PLAY_DIE2);
    expect(pplayerSoundLog.some((e) => e.token === 'sfx_pldeth')).toBe(true);
    step(s, 10); // tic 20 -> DIE3 dispatches A_Fall
    expect(MO(s).state).toBe(S.S_PLAY_DIE3);
    expect(MO(s).flags & MF.MF_SOLID).toBe(0);
    step(s, 40); // t70 -> through DIE4/5/6 into DIE7 (6 transitions x 10)
    expect(MO(s).state).toBe(S.S_PLAY_DIE7);
    step(s, 200);
    expect(MO(s).state).toBe(S.S_PLAY_DIE7); // tics -1: forever
    expect(MO(s).removed).toBe(false); // a corpse, not freed
  });

  it('health < -spawnhealth selects S_PLAY_XDIE1 (gib branch)', () => {
    const s = boot();
    const m = MO(s);
    m.health = -150;
    pKillMobjPlayer(null, m);
    expect(m.state).toBe(S.S_PLAY_XDIE1);
    step(s, 10);
    expect(MO(s).state).toBe(S.S_PLAY_XDIE3); // A_XScream@5, A_Fall@10
    expect(pplayerSoundLog.some((e) => e.token === 'sfx_slop')).toBe(true);
  });

  it('environment kill self-frags; monster kill credits killcount + drops', () => {
    const s = boot();
    pKillPlayer(P(s)); // source null
    expect(P(s).frags[0]).toBe(1);
    expect(P(s).killcount).toBe(0);

    const s2 = boot();
    const poss = pSpawnMobj(s2.mobjs, 200 << 16, 200 << 16, 0, MT.MT_POSSESSED);
    pKillMobjPlayer(null, poss);
    expect(s2.players[0]!.killcount).toBe(1); // !netgame COUNTKILL sweep
    const clip = s2.mobjs.mobjs.find((x) => x.type === MT.MT_CLIP && !x.removed)!;
    expect(clip.flags & MF.MF_DROPPED).not.toBe(0);
  });
});

/* ------------------------------------------------------------------ */
describe('M7-03 P_DeathThink (p_user.c:180-232)', () => {
  it('viewheight sinks 16px->6px at 1/FRACUNIT per tic; deltaviewheight 0', () => {
    const s = boot();
    pKillPlayer(P(s));
    expect(P(s).viewheight).toBe(VIEWHEIGHT);
    step(s, 35);
    expect(P(s).viewheight).toBe(6 * FRACUNIT);
    step(s, 20);
    expect(P(s).viewheight).toBe(6 * FRACUNIT);
    expect(puserHookCounts.deathThink).toBe(55);
  });

  it('turns toward the attacker at ANG5/tic, then fades damagecount', () => {
    const s = boot();
    const m = MO(s);
    const att = pSpawnMobj(s.mobjs, m.x, m.y - 128 * FRACUNIT, m.z, MT.MT_POSSESSED);
    pKillPlayer(P(s), att);
    // attacker is set by the DAMAGE path (P_DamageMobj), never by the
    // kill — mirror the real-world sequence for the death-cam test:
    P(s).attacker = att;
    P(s).damagecount = 5;
    const target = 0xc0000000; // due south
    let prev = m.angle;
    for (let i = 0; i < 70; i++) {
      step(s, 1);
      const d = (m.angle - prev) >>> 0;
      expect(
        d === 0 || d === ANG5 || d === ((0 - ANG5) >>> 0) || m.angle === target
      ).toBe(true); // step, hold, or the facing-window snap
      prev = m.angle;
    }
    expect(m.angle).toBe(target);
    expect(P(s).damagecount).toBe(0); // faced the killer -> faded
  });

  it('BT_USE while dead latches PST_REBORN; the ticker consumes it (M7-11c)', () => {
    const s = boot();
    pKillPlayer(P(s));
    // latch happens INSIDE P_DeathThink (p_user.c:225) during a tic —
    // with the reborn pass live, the NEXT gTicker step consumes it
    // (g_game.c:629-640), so the observable end-state is PST_LIVE again
    // with G_PlayerReborn counted.
    step(s, 5, { ...emptyInput(), use: true });
    expect(P(s).playerstate).toBe(PST_LIVE);
    expect(P(s).health).toBe(100);
    expect(pplayerHookCounts.playerReborn).toBeGreaterThanOrEqual(1);
  });

  it('the hook is registered: pPlayerThink dead branch runs the body', () => {
    const s = boot();
    P(s).playerstate = PST_DEAD;
    step(s, 1);
    expect(puserHookCounts.deathThink).toBe(1);
    expect(P(s).viewheight).toBe(VIEWHEIGHT - FRACUNIT);
  });
});

/* ------------------------------------------------------------------ */
describe('M7-03 reborn (G_PlayerReborn clears list via the spawn branch)', () => {
  it('everything clears except frags/killcount/itemcount; cheats die', () => {
    const s = boot();
    const p = P(s);
    p.cheats = 7;
    p.frags[2] = 3;
    p.killcount = 11;
    p.itemcount = 4;
    const pp = p as unknown as {
      powers: Int32Array;
      ammo: Int32Array;
      readyweapon: number;
    };
    pp.powers[1] = 60;
    pp.ammo[1] = 99;
    const old = MO(s);
    pKillPlayer(p);
    p.playerstate = PST_REBORN;
    const before = pplayerHookCounts.playerReborn;
    pSpawnPlayerFromStart(s.mobjs, p, { x: 32, y: 32, angle: 90, type: 1, options: 1 });
    expect(pplayerHookCounts.playerReborn).toBe(before + 1);
    expect(p.cheats).toBe(0);
    expect(p.health).toBe(100);
    expect(p.usedown).toBe(true);
    expect(p.playerstate).toBe(PST_LIVE);
    expect(p.frags[2]).toBe(3);
    expect(p.killcount).toBe(11);
    expect(p.itemcount).toBe(4);
    expect(pp.powers[1]).toBe(0);
    expect(pp.ammo[1]).toBe(0);
    expect(pp.ammo[0]).toBe(50); // AM_CLIP
    expect(pp.readyweapon).toBe(WP_PISTOL); // g_game.c G_PlayerReborn
    // new mobj replaced the corpse; the OLD mobj keeps ticking with the
    // playerRef back-pointer quirk (vanilla's dangling-corpse behavior)
    expect(MO(s)).not.toBe(old);
    expect(old.removed).toBe(false);
    expect((old as Mobj & { playerRef?: Player }).playerRef).toBe(p);
    expect(MO(s).z).toBe(MO(s).floorz);
    expect(P(s).viewheight).toBe(VIEWHEIGHT); // memset then P_SpawnPlayer
  });
});

/* ------------------------------------------------------------------ */
describe('M7-03 A_* registration + seams', () => {
  it('the four player-death actions are registered (A_Light* came with M7-01)', () => {
    expect(isActionRegistered(ACT.A_Pain)).toBe(true);
    expect(isActionRegistered(ACT.A_PlayerScream)).toBe(true);
    expect(isActionRegistered(ACT.A_Fall)).toBe(true);
    expect(isActionRegistered(ACT.A_XScream)).toBe(true);
    expect(isActionRegistered(ACT.A_Light0)).toBe(true);
    expect(isActionRegistered(ACT.A_Light1)).toBe(true);
    expect(isActionRegistered(ACT.A_Light2)).toBe(true);
  });

  it('A_Fall is the ONLY effect: MF_SOLID off, nothing else', () => {
    const s = boot();
    const m = MO(s);
    expect(m.flags & MF.MF_SOLID).not.toBe(0);
    pSetMobjState(m, S.S_PLAY_DIE3);
    expect(m.flags & MF.MF_SOLID).toBe(0);
    expect(m.state).toBe(S.S_PLAY_DIE3); // the chain continues normally
  });

  it('bindPplayerLevel is idempotent + registers the spawn hook', () => {
    const s = boot();
    bindPplayerLevel(s);
    expect(s.mobjs.playerSpawnFn).toBeTypeOf('function');
    step(s, 2); // re-bind did not break the tick
    expect(MO(s).type).toBe(MT.MT_PLAYER);
  });

  it('pKillPlayer/pHurtPlayer demand the real mobj (no stub path)', () => {
    const s = boot();
    const p = P(s);
    // detach via a hand-built state is out of scope; instead verify the
    // asMobj gate directly through a raw stub clone
    const fake = { ...p, mo: { ...p.mo } };
    // the clone's mo lost the isMobj marker via spread order? it keeps it —
    // so check the error path on a stripped object instead:
    (fake as unknown as { mo: unknown }).mo = {};
    expect(() => pKillPlayer(fake as Player)).toThrow(/real mobj/);
    expect(() => pHurtPlayer(fake as Player, 1)).toThrow(/real mobj/);
  });
});
