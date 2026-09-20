// sim/p_ammo.test.ts — M7-05 acceptance (docs/design/M7-plan.md §M7-05).
//  1) P_CheckAmmo ladder matrix: costs (BFG 40 / SSG 2 / rest 1), every
//     rung incl. plasma/BFG gamemode gates, SSG shell>2 + commercial gate,
//     pistol-no-ownership-check fallback, fist last-resort, forced
//     downstate side-effect;
//  2) BT_CHANGE switch matrix (p_user.c:291-323): owned/same/shareware
//     gates, fist→chainsaw + commercial shotgun→supershotgun upgrades,
//     mid-raise and mid-fire swap edge cases, gBuildTiccmd key encoding;
//     (1.10 has NO next/prev cycling — R08 §5.1 — nothing to cycle);
//  3) start sets + capacity table: G_PlayerReborn pistol+fists+50 clips,
//     maxammo reset (backpack once-semantics LOST on respawn), rocket
//     half-load = 0 pin, ammo==maxammo full-check boundary;
//  4) psprite integration: registerAmmoHooks seams, pendingweapon →
//     P_BringUpWeapon → A_Raise → A_WeaponReady live-fire chain, scripted
//     pistol→shotgun→(clip)→chaingun→fist route with real fire-action
//     ammo consumption, double-run determinism.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import { buildFixtureMapWad, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { S } from '../wad/info/states';

import { gInitGame, gTicker } from './game';
import { buildMapFromData } from './map';
import { createPlayer, PST_LIVE } from './player';
import { createPrngState } from './prng';
import { pPlayerReborn } from './pplayer';
import { initPlayerInventory, type PickupPlayer } from './p_inter_inventory';
import { P_GiveAmmo } from './p_inter_pickup';
import {
  AM_CELL,
  AM_CLIP,
  AM_MISL,
  AM_SHELL,
  attachPsprFields,
  bindPsprWorld,
  PS_WEAPON,
  pFireWeapon,
  pMovePsprites,
  pSetupPsprites,
  psprGlobals,
  resetPsprHooks,
  WEAPONINFO,
  WP_BFG,
  WP_CHAINSAW,
  WP_CHAINGUN,
  WP_FIST,
  WP_MISSILE,
  WP_NOCHANGE,
  WP_PISTOL,
  WP_PLASMA,
  WP_SHOTGUN,
  WP_SUPERSHOTGUN,
  type PsprPlayer,
  type PsprWorld,
} from './p_pspr';
import {
  MAXAMMO,
  pCheckAmmo,
  pWeaponChange,
  registerAmmoHooks,
} from './p_ammo';
import { puserHookCounts, resetPuserHookCounts, puserHooks } from './puser';
import {
  BT_CHANGE,
  BT_WEAPONMASK,
  BT_WEAPONSHIFT,
  BT_ATTACK,
  BT_USE,
  emptyInput,
  gBuildTiccmd,
  type GameInput,
} from './ticcmd';
import { ACT, isActionRegistered } from './a_actions';
import type { GameState } from './state';

/* ------------------------------------------------------------------ */
/* Harness (p_pspr.test.ts pattern)                                     */
/* ------------------------------------------------------------------ */

let world: PsprWorld;

/** Full player slice: inventory (initPlayerInventory) + pspr fields,
 * matching the gInitGame attach order. */
function mkPlayer(readyweapon: number = WP_PISTOL): PsprPlayer {
  const p = attachPsprFields(initPlayerInventory(createPlayer()));
  p.readyweapon = readyweapon;
  p.pendingweapon = WP_NOCHANGE;
  p.attackdown = true; // G_PlayerReborn start value
  p.cmd.buttons = 0;
  // fixture owns its OWNED/AMMO sets explicitly (own()/ammo()) — the attach
  // placeholder (fists+pistol+50) would otherwise leak into the ladder/
  // switch matrices; the canonical G_PlayerReborn set is pinned in the
  // start-sets block.
  p.weaponowned.fill(0);
  p.ammo.fill(0);
  return p;
}

/** Bare player through the canonical spawn init (pPlayerReborn carries the
 * inventory+pspr attaches itself — the gInitGame → P_SpawnPlayer path). */
function pPlayerRebornProbe(): PickupPlayer & PsprPlayer {
  const p = createPlayer();
  pPlayerReborn(p);
  return p as unknown as PickupPlayer & PsprPlayer;
}

function own(p: PsprPlayer, ...ws: number[]): void {
  for (const w of ws) p.weaponowned[w] = 1;
}

function ammo(p: PsprPlayer, clip = 0, shell = 0, cell = 0, misl = 0): void {
  p.ammo[AM_CLIP] = clip;
  p.ammo[AM_SHELL] = shell;
  p.ammo[AM_CELL] = cell;
  p.ammo[AM_MISL] = misl;
}

function psp(p: PsprPlayer) {
  return p.psprites[PS_WEAPON]!;
}

/** One tic: leveltime++ then P_MovePsprites (p_user.c order). */
function tick(p: PsprPlayer, buttons?: number): void {
  if (buttons !== undefined) p.cmd.buttons = buttons;
  world.leveltime += 1;
  pMovePsprites(p);
}

const ARENA: RectMapSpec = {
  rooms: [{ x: 0, y: 0, w: 1024, h: 1024, ceilingHeight: 400, lightLevel: 200 }],
  things: [{ x: 512, y: 512, angle: 0, type: 1 }],
};

function boot(): GameState {
  const bytes = buildFixtureMapWad(ARENA, 'FIXMAP');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'FIXMAP')));
}

const input = (over: Partial<GameInput>): GameInput => ({ ...emptyInput(), ...over });

beforeEach(() => {
  resetPsprHooks();
  resetPuserHookCounts();
  puserHooks.weaponChange = undefined;
  world = { rng: createPrngState(), leveltime: 0 };
  bindPsprWorld(world);
  psprGlobals.gamemode = 1; // registered (Doom 1 retail) default
});

afterEach(() => {
  puserHooks.weaponChange = undefined;
});

/* ------------------------------------------------------------------ */
/* 1) P_CheckAmmo ladder matrix                                        */
/* ------------------------------------------------------------------ */

describe('P_CheckAmmo ladder (p_pspr.c:158-215)', () => {
  it('sufficient-ammo pass-through: TRUE, no pendingweapon, no downstate', () => {
    const p = mkPlayer(WP_PISTOL);
    ammo(p, 1);
    const st = psp(p).state;
    expect(pCheckAmmo(p)).toBe(true);
    expect(p.pendingweapon).toBe(WP_NOCHANGE);
    expect(psp(p).state).toBe(st);
    expect(p.ammo[AM_CLIP]).toBe(1); // check never consumes
  });

  it('am_noammo weapons always pass (fist/chainsaw, zero ammo)', () => {
    for (const w of [WP_FIST, WP_CHAINSAW]) {
      const p = mkPlayer(w);
      ammo(p);
      expect(pCheckAmmo(p)).toBe(true);
      expect(p.pendingweapon).toBe(WP_NOCHANGE);
    }
  });

  it('one-shot costs: pistol/chaingun/plasma 1, SSG 2, BFG 40 (exact-boundary)', () => {
    const p1 = mkPlayer(WP_PISTOL);
    ammo(p1, 1);
    expect(pCheckAmmo(p1)).toBe(true); // 1 clip fires
    const p2 = mkPlayer(WP_SUPERSHOTGUN);
    ammo(p2, 0, 2);
    expect(pCheckAmmo(p2)).toBe(true); // exactly 2 shells fire
    const p3 = mkPlayer(WP_SUPERSHOTGUN);
    ammo(p3, 0, 1);
    expect(pCheckAmmo(p3)).toBe(false); // 1 < 2 → ladder
    const p4 = mkPlayer(WP_BFG);
    ammo(p4, 0, 0, 40);
    expect(pCheckAmmo(p4)).toBe(true); // exactly BFGCELLS=40 fires
    const p5 = mkPlayer(WP_BFG);
    ammo(p5, 0, 0, 39);
    expect(pCheckAmmo(p5)).toBe(false); // 39 < 40 → ladder
  });

  it('rung order: plasma first when owned+cell, gated by gamemode != shareware', () => {
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_PLASMA);
    ammo(p, 0, 0, 1);
    expect(pCheckAmmo(p)).toBe(false);
    expect(p.pendingweapon).toBe(WP_PLASMA);
    // shareware gate: plasma owned + cell but gamemode 0 → next rungs;
    // pistol-ammo 0, nothing else owned → fist.
    const q = mkPlayer(WP_PISTOL);
    own(q, WP_PLASMA);
    ammo(q, 0, 0, 100);
    psprGlobals.gamemode = 0;
    pCheckAmmo(q);
    expect(q.pendingweapon).toBe(WP_FIST);
    psprGlobals.gamemode = 1;
  });

  it('SSG rung: owned && shell > 2 && commercial ONLY (shell==2 and gates fail)', () => {
    const p = mkPlayer(WP_PISTOL); // pistol ready, out of clip → ladder
    own(p, WP_SHOTGUN, WP_SUPERSHOTGUN);
    ammo(p, 0, 3);
    psprGlobals.gamemode = 2;
    pCheckAmmo(p);
    expect(p.pendingweapon).toBe(WP_SUPERSHOTGUN);
    // shell == 2 is NOT > 2: SSG-ready with 1 shell enters the ladder; the
    // SSG rung fails (>2 required), chaingun rung skipped, shotgun rung
    // takes shell ≥ 1 → plain shotgun:
    const q = mkPlayer(WP_SUPERSHOTGUN);
    own(q, WP_SHOTGUN, WP_SUPERSHOTGUN);
    ammo(q, 0, 1);
    psprGlobals.gamemode = 2;
    pCheckAmmo(q); // 1 < 2 → ladder; shell 1 not > 2 → SSG rung fails;
    // chaingun no; shotgun owned + shell 1 → shotgun
    expect(q.pendingweapon).toBe(WP_SHOTGUN);
    // registered (non-commercial): SSG owned, shell 50, still not chosen
    // shotgun-ready with 50 shells never ladders (cost 1) — enter via pistol
    const s = mkPlayer(WP_PISTOL);
    own(s, WP_SHOTGUN, WP_SUPERSHOTGUN);
    ammo(s, 0, 50);
    psprGlobals.gamemode = 1;
    pCheckAmmo(s);
    expect(s.pendingweapon).toBe(WP_SHOTGUN); // NOT supershotgun (gate)
    psprGlobals.gamemode = 2;
    const t = mkPlayer(WP_PISTOL);
    own(t, WP_SHOTGUN, WP_SUPERSHOTGUN);
    ammo(t, 0, 50);
    pCheckAmmo(t);
    expect(t.pendingweapon).toBe(WP_SUPERSHOTGUN);
  });

  it('chaingun rung precedes shotgun (both owned, clip left, shells spent)', () => {
    const p = mkPlayer(WP_SHOTGUN);
    own(p, WP_SHOTGUN, WP_CHAINGUN);
    ammo(p, 1, 0); // shotgun ready at 0 shells → ladder; clip 1
    pCheckAmmo(p);
    expect(p.pendingweapon).toBe(WP_CHAINGUN); // chaingun rung comes FIRST
  });

  it('chaingun rung skipped without clip even when owned (shotgun taken)', () => {
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_SHOTGUN, WP_CHAINGUN);
    ammo(p, 0, 20);
    pCheckAmmo(p); // clip 0 → chaingun rung fails → shotgun rung
    expect(p.pendingweapon).toBe(WP_SHOTGUN);
  });

  it('pistol rung needs NO weaponowned check (fallback weapon, p_pspr.c:187)', () => {
    const p = mkPlayer(WP_SHOTGUN);
    // NOTHING owned (mkPlayer cleared the attach placeholder):
    ammo(p, 1);
    pCheckAmmo(p); // shotgun ready, shell 0 → ladder
    expect(p.pendingweapon).toBe(WP_PISTOL);
    expect(p.weaponowned[WP_PISTOL]).toBe(0);
  });

  it('chainsaw rung (no ammo needed), missile rung (misl), BFG rung (cell>40)', () => {
    const a = mkPlayer(WP_PISTOL);
    own(a, WP_CHAINSAW);
    ammo(a);
    pCheckAmmo(a);
    expect(a.pendingweapon).toBe(WP_CHAINSAW);

    const b = mkPlayer(WP_PISTOL);
    own(b, WP_MISSILE);
    ammo(b, 0, 0, 0, 1);
    pCheckAmmo(b);
    expect(b.pendingweapon).toBe(WP_MISSILE);

    const c = mkPlayer(WP_PISTOL);
    own(c, WP_BFG);
    ammo(c, 0, 0, 41);
    pCheckAmmo(c);
    expect(c.pendingweapon).toBe(WP_BFG);
    ammo(c, 0, 0, 40);
    c.pendingweapon = WP_NOCHANGE;
    pCheckAmmo(c); // cell 40 NOT > 40 → fist
    expect(c.pendingweapon).toBe(WP_FIST);
    psprGlobals.gamemode = 0;
    ammo(c, 0, 0, 100);
    c.pendingweapon = WP_NOCHANGE;
    pCheckAmmo(c); // shareware gate
    expect(c.pendingweapon).toBe(WP_FIST);
    psprGlobals.gamemode = 1;
  });

  it('everything fails → fist', () => {
    const p = mkPlayer(WP_MISSILE);
    own(p, WP_MISSILE);
    ammo(p);
    pCheckAmmo(p);
    expect(p.pendingweapon).toBe(WP_FIST);
  });

  it('forced-downstate side-effect: ready weapon downstate entered, ammo intact', () => {
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_SHOTGUN);
    ammo(p, 0, 8);
    expect(psp(p).state).toBe(0); // no weapon psprite yet
    expect(pCheckAmmo(p)).toBe(false);
    // P_SetPsprite(downstate) ENTERS A_Lower (sy moves); state is pinned:
    expect(psp(p).state).toBe(WEAPONINFO[WP_PISTOL]!.downstate);
    expect(psp(p).sy).toBe(6 * FRACUNIT); // A_Lower ran once (LOWERSPEED)
    expect(p.ammo[AM_CLIP]).toBe(0);
    expect(p.ammo[AM_SHELL]).toBe(8); // ladder never consumes
  });

  it('ladder is deterministic: identical inputs → identical results', () => {
    const run = (): [number, number] => {
      const p = mkPlayer(WP_BFG);
      own(p, WP_PLASMA, WP_SHOTGUN, WP_MISSILE);
      ammo(p, 3, 0, 12, 4);
      const ok = pCheckAmmo(p);
      return [ok ? 1 : 0, p.pendingweapon];
    };
    expect(run()).toEqual(run());
  });
});

/* ------------------------------------------------------------------ */
/* 2) BT_CHANGE weapon switch (p_user.c:291-323)                        */
/* ------------------------------------------------------------------ */

function changeTo(p: PsprPlayer, slot: number): void {
  p.cmd.buttons = BT_CHANGE | (slot << BT_WEAPONSHIFT);
  pWeaponChange(p);
  p.cmd.buttons = 0;
}

describe('weapon switch (p_user.c:291-323)', () => {
  it('owned && different → pendingweapon; unowned/same-slot never change', () => {
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_PISTOL, WP_SHOTGUN);
    changeTo(p, WP_SHOTGUN);
    expect(p.pendingweapon).toBe(WP_SHOTGUN);
    // same weapon: pressing the ready weapon's slot is a NO-OP
    p.pendingweapon = WP_NOCHANGE;
    changeTo(p, WP_PISTOL);
    expect(p.pendingweapon).toBe(WP_NOCHANGE);
    // unowned weapon: never selectable (no ammo skip needed — 1.10 has no
    // cycling; the AMMOLESS-but-owned weapon IS selectable and the ladder
    // in A_ReFire/A_WeaponReady's fire path handles the empty case)
    p.pendingweapon = WP_NOCHANGE;
    changeTo(p, WP_MISSILE);
    expect(p.pendingweapon).toBe(WP_NOCHANGE);
  });

  it('fist slot upgrades to chainsaw when owned (p_user.c:297-305)', () => {
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_PISTOL, WP_CHAINSAW);
    changeTo(p, WP_FIST);
    expect(p.pendingweapon).toBe(WP_CHAINSAW);
    // already holding the chainsaw: the UPGRADE is skipped, and fists (the
    // slot itself, always owned per G_PlayerReborn) ARE selectable — the
    // vanilla "press 1 with saw out" downgrade:
    p.readyweapon = WP_CHAINSAW;
    p.pendingweapon = WP_NOCHANGE;
    own(p, WP_FIST);
    changeTo(p, WP_FIST);
    expect(p.pendingweapon).toBe(WP_FIST);
    // chainsaw NOT owned → fist itself (fists are always owned —
    // G_PlayerReborn grants them; the fixture owns them explicitly):
    const q = mkPlayer(WP_PISTOL);
    own(q, WP_PISTOL, WP_FIST);
    changeTo(q, WP_FIST);
    expect(q.pendingweapon).toBe(WP_FIST);
  });

  it('shotgun slot upgrades to SSG in commercial only (p_user.c:307-314)', () => {
    const p = mkPlayer(WP_MISSILE); // ready ≠ shotgun/ssg
    own(p, WP_MISSILE, WP_PISTOL, WP_SHOTGUN, WP_SUPERSHOTGUN);
    psprGlobals.gamemode = 2;
    changeTo(p, WP_SHOTGUN);
    expect(p.pendingweapon).toBe(WP_SUPERSHOTGUN);
    // readyweapon already SSG: the upgrade is skipped, so slot 2 selects
    // the plain shotgun (vanilla downgrade path — owned && != readyweapon):
    p.readyweapon = WP_SUPERSHOTGUN;
    p.pendingweapon = WP_NOCHANGE;
    changeTo(p, WP_SHOTGUN);
    expect(p.pendingweapon).toBe(WP_SHOTGUN);
    // registered: plain shotgun
    psprGlobals.gamemode = 1;
    changeTo(p, WP_SHOTGUN);
    expect(p.pendingweapon).toBe(WP_SHOTGUN);
  });

  it('shareware gate: plasma/BFG not selectable even when owned (cheat-safe)', () => {
    psprGlobals.gamemode = 0;
    const p = mkPlayer(WP_MISSILE); // ready ≠ pistol/plasma/BFG
    own(p, WP_MISSILE, WP_PISTOL, WP_PLASMA, WP_BFG);
    changeTo(p, WP_PLASMA);
    expect(p.pendingweapon).toBe(WP_NOCHANGE);
    changeTo(p, WP_BFG);
    expect(p.pendingweapon).toBe(WP_NOCHANGE);
    changeTo(p, WP_PISTOL); // other slots unaffected by the gate
    expect(p.pendingweapon).toBe(WP_PISTOL);
    psprGlobals.gamemode = 1;
    changeTo(p, WP_PLASMA);
    expect(p.pendingweapon).toBe(WP_PLASMA);
  });

  it('G_BuildTiccmd encodes slot keys; pWeaponChange decodes (g_game.c:341-347)', () => {
    const turn = { turnheld: 0 };
    const cmd = gBuildTiccmd(input({ weaponKey: WP_MISSILE }), turn);
    expect(cmd.buttons & BT_CHANGE).not.toBe(0);
    expect((cmd.buttons & BT_WEAPONMASK) >> BT_WEAPONSHIFT).toBe(WP_MISSILE);
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_PISTOL, WP_MISSILE);
    p.cmd = { ...cmd };
    pWeaponChange(p);
    expect(p.pendingweapon).toBe(WP_MISSILE);
    // no weapon key → no BT_CHANGE, pPlayerThink never calls the seam
    const plain = gBuildTiccmd(input({}), turn);
    expect(plain.buttons & BT_CHANGE).toBe(0);
  });

  it('switch during RAISE: raise finishes on the OLD readyweapon, then lowers/raises the new one', () => {
    const p = mkPlayer(WP_SHOTGUN);
    own(p, WP_PISTOL, WP_SHOTGUN, WP_CHAINGUN);
    pSetupPsprites(p); // raising shotgun (readyweapon=shotgun)
    expect(psp(p).state).toBe(S.S_SGUNUP);
    // mid-raise, press slot 3 (chaingun): pendingweapon changes, state untouched
    p.cmd.buttons = BT_CHANGE | (WP_CHAINGUN << BT_WEAPONSHIFT);
    pWeaponChange(p);
    p.cmd.buttons = 0;
    expect(p.pendingweapon).toBe(WP_CHAINGUN);
    expect(psp(p).state).toBe(S.S_SGUNUP); // the machine ignores it until ready
    // finish the raise: A_Raise's final frame enters the shotgun READY
    // state, whose 0-tic A_WeaponReady immediately sees the pending change
    // and cascades into the DOWN state — the swap has NOT happened yet:
    for (let i = 0; i < 20 && psp(p).state !== S.S_SGUNDOWN; i++) tick(p);
    expect(psp(p).state).toBe(S.S_SGUNDOWN);
    expect(p.readyweapon).toBe(WP_SHOTGUN); // raise finished on the OLD gun
    // lower (16) + raise (16) → chaingun ready
    for (let i = 0; i < 40 && p.readyweapon !== WP_CHAINGUN; i++) tick(p);
    expect(p.readyweapon).toBe(WP_CHAINGUN);
    expect(p.pendingweapon).toBe(WP_NOCHANGE);
  });

  it('switch DURING FIRE: refire defers to the pending change (A_ReFire), ready weapon not consumed', () => {
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_PISTOL, WP_SHOTGUN);
    ammo(p, 10, 5);
    pSetupPsprites(p); // pistol up…
    for (let i = 0; i < 16; i++) tick(p); // …ready (S_PISTOL)
    expect(psp(p).state).toBe(S.S_PISTOL);
    p.attackdown = false;
    // fire the pistol: ready → atk chain (button held). A_FirePistol lands
    // a few frames INTO the chain (S_PISTOL1 entry carries no action — the
    // shot occurs at the "fire occurs at" tic, R08 §2.1):
    let t = 0;
    while (p.ammo[AM_CLIP] === 10 && t < 8) {
      tick(p, BT_ATTACK);
      t++;
    }
    expect(p.ammo[AM_CLIP]).toBe(9); // A_FirePistol consumed exactly 1
    // while the pistol chain animates, switch to the shotgun:
    p.pendingweapon = WP_SHOTGUN;
    while (p.readyweapon === WP_PISTOL && t < 60) {
      tick(p, BT_ATTACK);
      t++;
    }
    expect(p.readyweapon).toBe(WP_SHOTGUN);
    while (psp(p).state !== S.S_SGUN && t < 80) {
      tick(p, 0); // release BEFORE the shotgun reaches ready
      t++;
    }
    // the pistol fired EXACTLY once in total: A_ReFire's pendingweapon
    // check (p_pspr.c:307-324) lets the switch through instead of refiring,
    // and psprHooks.checkAmmo in that else-branch never consumes; the
    // shotgun never fired (button released before its READY tic):
    expect(p.ammo[AM_CLIP]).toBe(9);
    expect(p.ammo[AM_SHELL]).toBe(5);
  });

  it('pPlayerThink seam: BT_CHANGE counted + hook fires only with the bit set', () => {
    registerAmmoHooks();
    // direct seam call through the switch body (puser call-site coverage in
    // the live-game block below):
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_PISTOL, WP_CHAINSAW);
    changeTo(p, WP_FIST);
    expect(p.pendingweapon).toBe(WP_CHAINSAW);
  });
});

/* ------------------------------------------------------------------ */
/* 3) Start sets + capacity table                                       */
/* ------------------------------------------------------------------ */

describe('start sets + maxammo (g_game.c:820-830, p_inter.c:33)', () => {
  it('MAXAMMO table verbatim (p_inter.c:33)', () => {
    expect([...MAXAMMO]).toEqual([200, 50, 300, 50]);
  });

  it('new-game start set = G_PlayerReborn (gInitGame forces PST_REBORN, g_game.c:1440)', () => {
    // The live path (gInitGame → P_SpawnPlayer REBORN branch) lands on
    // pPlayerReborn — asserted here directly on a bare player:
    const p = pPlayerRebornProbe();
    expect(p.readyweapon).toBe(WP_PISTOL);
    expect([...p.weaponowned]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0]); // fists+pistol
    expect(p.ammo[AM_CLIP]).toBe(50);
    expect(p.ammo[AM_SHELL] ?? 0).toBe(0);
    expect([...(p as unknown as PickupPlayer).maxammo]).toEqual([200, 50, 300, 50]);
    expect((p as unknown as PickupPlayer).backpack).toBe(false);
    // Episode/skill: 1.10 has NO episode- or skill-dependent start (R08
    // §10) — the table above IS every (episode, skill) combination, and
    // reborn never reads gameskill (skill doubles PICKUPS only).
  });

  it('P_GiveAmmo num=5 clip box = 50 (economy sizes the route test uses)', () => {
    const p = mkPlayer();
    const inv = p as unknown as PickupPlayer;
    expect(P_GiveAmmo(inv, AM_CLIP, 5)).toBe(true);
    expect(p.ammo[AM_CLIP]).toBe(50);
  });

  it('G_PlayerReborn resets EVERYTHING a backpack did (once-semantics across death)', () => {
    const p = mkPlayer(WP_PLASMA);
    const inv = p as unknown as PickupPlayer;
    own(p, WP_PISTOL, WP_SHOTGUN, WP_PLASMA);
    ammo(p, 400, 100, 600, 100);
    const inv2 = inv; // alias keeps the maxammo accesses on the inventory view
    for (let i = 0; i < 4; i++) inv2.maxammo[i]! *= 2; // backpack double-max
    inv.backpack = true;
    inv.armorpoints = 200;
    inv.armortype = 2;
    p.health = 200;
    pPlayerReborn(p);
    expect(inv.backpack).toBe(false); // memset — double-max LOST on respawn
    expect([...inv.maxammo]).toEqual([200, 50, 300, 50]); // g_game.c:830
    expect([...p.ammo]).toEqual([50, 0, 0, 0]);
    expect([...p.weaponowned]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(p.readyweapon).toBe(WP_PISTOL);
    expect(p.pendingweapon).toBe(WP_PISTOL);
    expect(p.health).toBe(100);
    expect(p.playerstate).toBe(PST_LIVE);
    expect(inv.armorpoints).toBe(0);
    expect(inv.armortype).toBe(0);
    // a SECOND backpack now doubles again (once-semantics re-armed):
    for (let i = 0; i < 4; i++) inv.maxammo[i]! *= 2;
    inv.backpack = true;
    expect(inv.maxammo[AM_CLIP]).toBe(400);
    expect(P_GiveAmmo(inv, AM_CLIP, 1)).toBe(true); // capacity honored
  });

  it('full-capacity boundary: P_GiveAmmo refuses at maxammo, keeps the thing', () => {
    const p = mkPlayer();
    const inv = p as unknown as PickupPlayer;
    p.ammo[AM_CLIP] = MAXAMMO[AM_CLIP]!;
    expect(P_GiveAmmo(inv, AM_CLIP, 5)).toBe(false);
    expect(p.ammo[AM_CLIP]).toBe(200);
    // one below max: given, clamped
    p.ammo[AM_CLIP] = 195;
    expect(P_GiveAmmo(inv, AM_CLIP, 1)).toBe(true); // +10 → clamp 200
    expect(p.ammo[AM_CLIP]).toBe(200);
  });

  it('rocket half-load = 0 pin: dropped rocket ammo gives clipammo[3]/2 = 0', () => {
    const p = mkPlayer();
    const inv = p as unknown as PickupPlayer;
    // clipammo = {10, 4, 20, 1}; num=0 (dropped) → integer half: 5, 2, 10, 0
    expect(P_GiveAmmo(inv, AM_MISL, 0)).toBe(true); // NOT at max — true
    expect(p.ammo[AM_MISL]).toBe(0); // ...but the amount is 0 (1/2 truncates)
    expect(P_GiveAmmo(inv, AM_MISL, 1)).toBe(true);
    expect(p.ammo[AM_MISL]).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* 4) Integration: seams, live game, live-fire chain                    */
/* ------------------------------------------------------------------ */

describe('psprite integration + live game', () => {
  it('registerAmmoHooks binds BOTH seams (p_ammo IS the checkAmmo owner)', () => {
    registerAmmoHooks();
    expect(puserHooks.weaponChange).toBeTypeOf('function');
    // the ladder identity shows through a fire-attempt: out-of-ammo pistol
    // downstates via p_ammo's pCheckAmmo (identical shape to the p_pspr
    // default — seam proof is the registration itself + this behavior):
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_SHOTGUN);
    ammo(p, 0, 8);
    p.attackdown = false;
    pFireWeapon(p);
    expect(p.pendingweapon).toBe(WP_SHOTGUN);
    expect(psp(p).state).toBe(WEAPONINFO[WP_PISTOL]!.downstate);
  });

  it('out-of-ammo live chain: fire attempt → ladder → lower 16 → raise → READY, ammo untouched', () => {
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_SHOTGUN);
    ammo(p, 0, 8);
    pSetupPsprites(p); // pistol up
    for (let i = 0; i < 16; i++) tick(p); // finish raise → S_PISTOL ready
    expect(psp(p).state).toBe(S.S_PISTOL);
    p.pendingweapon = WP_NOCHANGE;
    p.attackdown = false;
    tick(p, BT_ATTACK); // A_WeaponReady → P_FireWeapon → ladder fails
    expect(p.pendingweapon).toBe(WP_SHOTGUN);
    expect(psp(p).state).toBe(WEAPONINFO[WP_PISTOL]!.downstate);
    // release the button through the swap legs (holding it would make the
    // shotgun fire the INSTANT it becomes ready — pinned in the route test):
    let t = 0;
    while (p.readyweapon === WP_PISTOL && t < 22) {
      tick(p, 0);
      t++;
    }
    expect(p.readyweapon).toBe(WP_SHOTGUN); // swapped at the A_Lower bottom
    const lowerTics = t;
    t = 0;
    while (psp(p).state !== S.S_SGUN && t < 20) {
      tick(p, 0);
      t++;
    }
    expect(psp(p).state).toBe(S.S_SGUN); // live-fire ready (A_WeaponReady)
    expect(lowerTics).toBeLessThanOrEqual(22); // sy 32→128 @ 6/tic + entry
    expect(p.ammo[AM_SHELL]).toBe(8); // the failed attempt consumed nothing
  });

  it('E1M1-style route: pistol→shotgun→(backpack clip)→chaingun→fist, real fire consumption, deterministic', () => {
    const runRoute = () => {
      const p = mkPlayer(WP_PISTOL);
      own(p, WP_PISTOL, WP_SHOTGUN, WP_CHAINGUN); // saw/missile NOT owned
      ammo(p, 2, 2, 0, 0);
      pSetupPsprites(p);
      for (let i = 0; i < 16; i++) tick(p);
      const switches: number[] = [];
      let last = p.readyweapon;
      // hold fire: 2 pistol shots → ladder→shotgun (clip 0, shell 2);
      // 2 shotgun blasts → ladder finds nothing → fist.
      for (let i = 0; i < 260; i++) {
        tick(p, BT_ATTACK);
        if (p.readyweapon !== last) {
          switches.push(p.readyweapon);
          last = p.readyweapon;
        }
      }
      const afterFist = [switches.slice(), [...p.ammo]];
      // "pickup" clip boxes while holding fists: P_GiveAmmo auto-switch
      // (p_inter.c:68) selects the owned chaingun (M7-04 seam, economy fed
      // by MAXAMMO):
      expect(P_GiveAmmo(p as unknown as PickupPlayer, AM_CLIP, 5)).toBe(true);
      expect(p.pendingweapon).toBe(WP_CHAINGUN);
      for (let i = 0; i < 50 && p.readyweapon !== WP_CHAINGUN; i++) {
        tick(p, BT_ATTACK);
        if (p.readyweapon !== last) {
          switches.push(p.readyweapon);
          last = p.readyweapon;
        }
      }
      expect(p.readyweapon).toBe(WP_CHAINGUN);
      const clipStart = p.ammo[AM_CLIP];
      for (let i = 0; i < 400 && p.readyweapon !== WP_FIST; i++) tick(p, BT_ATTACK);
      switches.push(p.readyweapon);
      return { switches, ammo: [...p.ammo], clipStart, trace: afterFist };
    };

    const a = runRoute();
    const b = runRoute();
    // pistol → shotgun → fist (no clip yet) → chaingun → fist (clip spent)
    expect(a.switches).toEqual([WP_SHOTGUN, WP_FIST, WP_CHAINGUN, WP_FIST]);
    expect(a.ammo).toEqual([0, 0, 0, 0]);
    expect(a.clipStart).toBe(50); // one clip box × 50 (P_GiveAmmo num=1)
    // double-run determinism (ammo counters ARE the observable):
    expect(b).toEqual(a);
  });

  it('live game (gInitGame): start set + pistol raise tick by tick', () => {
    const state = boot();
    const p = state.players[0] as unknown as PsprPlayer;
    expect(p.readyweapon).toBe(WP_PISTOL);
    expect([...p.weaponowned]).toEqual([1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(p.ammo[AM_CLIP]).toBe(50);
    expect([...(p as unknown as PickupPlayer).maxammo]).toEqual([200, 50, 300, 50]);
    for (let i = 0; i < 17; i++) gTicker(state);
    expect(psp(p).state).toBe(S.S_PISTOL); // raised and ready, live loop
  });

  it('live game switch: real ticcmd path (weaponKey → BT_CHANGE → pendingweapon)', () => {
    const state = boot();
    const p = state.players[0] as unknown as PsprPlayer;
    own(p, WP_PISTOL, WP_SHOTGUN);
    p.ammo[AM_SHELL] = 8;
    for (let i = 0; i < 17; i++) gTicker(state); // pistol ready
    resetPuserHookCounts();
    gTicker(state, input({ weaponKey: WP_SHOTGUN }));
    expect(p.pendingweapon).toBe(WP_SHOTGUN);
    expect(puserHookCounts.weaponChange).toBe(1);
    // holding the key stays harmless (newweapon == readyweapon after swap)
    for (let i = 0; i < 40 && p.readyweapon !== WP_SHOTGUN; i++) {
      gTicker(state, input({ weaponKey: WP_SHOTGUN }));
    }
    expect(p.readyweapon).toBe(WP_SHOTGUN);
    const wc = puserHookCounts.weaponChange;
    for (let i = 0; i < 10; i++) gTicker(state, input({ weaponKey: WP_SHOTGUN }));
    expect(puserHookCounts.weaponChange).toBe(wc + 10); // still counted...
    expect(p.readyweapon).toBe(WP_SHOTGUN); // ...but the switch never re-fires
    // use/attack untouched by the change bits:
    const cmd = gBuildTiccmd(input({ weaponKey: WP_PISTOL, attack: true, use: true }), {
      turnheld: 0,
    });
    expect(cmd.buttons & BT_ATTACK).not.toBe(0);
    expect(cmd.buttons & BT_USE).not.toBe(0);
  });

  it('live game: pistol fires (ammo 50→…) through the real machine', () => {
    expect(isActionRegistered(ACT.A_FirePistol)).toBe(true); // M7-07 merged
    const state = boot();
    const p = state.players[0] as unknown as PsprPlayer;
    for (let i = 0; i < 17; i++) gTicker(state);
    expect(psp(p).state).toBe(S.S_PISTOL);
    p.attackdown = false; // fresh press
    let fired = 0;
    for (let i = 0; i < 60; i++) {
      gTicker(state, input({ attack: true }));
      if (p.ammo[AM_CLIP] === 49 && fired === 0) fired = 1;
    }
    expect(fired).toBe(1);
    expect(p.ammo[AM_CLIP]).toBeLessThan(50); // hold refired beyond shot 1
  });
});

/* ------------------------------------------------------------------ */
/* Seam defaults (no registration → untouched)                          */
/* ------------------------------------------------------------------ */

describe('parallel-safety', () => {
  it('without registerAmmoHooks, pPlayerThink never swaps (counted no-op seam)', () => {
    // puser.ts default: hook undefined, weaponChange counter still counts
    // the BT_CHANGE evaluation (M7-05+ registration replaces the body).
    const p = mkPlayer(WP_PISTOL);
    own(p, WP_SHOTGUN);
    p.cmd.buttons = BT_CHANGE | (WP_SHOTGUN << BT_WEAPONSHIFT);
    puserHookCounts.weaponChange++; // what puser.ts itself would do
    puserHooks.weaponChange?.(p); // undefined — nothing happens
    expect(p.pendingweapon).toBe(WP_NOCHANGE);
  });
});
