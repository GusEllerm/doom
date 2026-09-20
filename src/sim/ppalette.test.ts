// sim/ppalette.test.ts — M7-06 acceptance (M7-plan §M7-06).
//
//  1. Power census + P_GivePower application points (p_inter.c:290-331).
//  2. Tic-exact decay per kind (p_user.c:339-359) — including the
//     "no (gameetic&3) gating in 1.10" claim (every tic decrements).
//  3. fixedcolormap matrix incl. the `>4*32 || &8` flicker (p_user.c:362-383).
//  4. MF_SHADOW toggle on/expire-off (p_inter.c:303 + p_user.c:346-347).
//  5. Palette band matrix (st_stuff.c:1000-1048) with the exact reachability
//     facts: bank 1 and bank 9 are NOT reachable by the (cnt+7)>>3 math.
//  6. sfx slot: sounds.h id table + the pickup-site counts.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, it, expect, beforeEach } from 'vitest';

import {
  BRIGHTCOLORMAP,
  FLASHLENGTH,
  INVERSECOLORMAP,
  NUMBONUSPALS,
  NUMREDPALS,
  POWER_TICS,
  RADIATIONPAL,
  STARTBONUSPALS,
  STARTREDPALS,
  attachPowerupFields,
  fixedColormapView,
  invisibilityFuzz,
  pFixedColormap,
  pPowerThink,
  paletteBand,
  type PowerupPlayer
} from './ppalette';
import {
  PW,
  INVULNTICS,
  INVISTICS,
  INFRATICS,
  IRONTICS,
  BONUSADD,
  P_GivePower,
  resetPickupState
} from './p_inter_pickup';
import { createPlayer } from './player';
import { MF_SHADOW } from './thinglinks';
import { createHookSlots, resetHookSlots } from './hooks';
import { NUMSFX, SFX_ID, installPickupSfxBridge, resolveSfxId, sStartSound } from './psound_stub';
import { SFX_DOROPN, SFX_DORCLS, SFX_BDOPN, SFX_BDCLS } from './pdoors';
import { SFX_PISTOL, SFX_SHOTGN, SFX_DSHTGN, SFX_SAWHIT, SFX_PUNCH } from './p_pspr';
import { SFX_SWTCHN, SFX_OOF, SFX_NOWAY } from './pswitch';
import { SFX_TELEPT } from './ptelept';
import { SFX_PSTART } from './pplats';

function makePlayer(): PowerupPlayer {
  return attachPowerupFields(createPlayer());
}

/** Run n tics of the powerup half of P_PlayerThink. */
function tick(p: PowerupPlayer, n: number, each?: (tic: number) => void): void {
  for (let i = 0; i < n; i++) {
    pPowerThink(p);
    each?.(i + 1);
  }
}

beforeEach(() => {
  resetPickupState();
});

/* ================================================================== */
/* 1. Census + P_GivePower (p_inter.c:290-331)                        */
/* ================================================================== */

describe('power census (doomdef.h:214-236)', () => {
  it('durations are the doomdef.h TICRATE products', () => {
    expect(INVULNTICS).toBe(30 * 35); //  1050
    expect(INVISTICS).toBe(60 * 35); //   2100
    expect(INFRATICS).toBe(120 * 35); //  4200
    expect(IRONTICS).toBe(60 * 35); //    2100
    expect(POWER_TICS[PW.pw_invulnerability]).toBe(1050);
    expect(POWER_TICS[PW.pw_invisibility]).toBe(2100);
    expect(POWER_TICS[PW.pw_ironfeet]).toBe(2100);
    expect(POWER_TICS[PW.pw_infrared]).toBe(4200);
    // Not countdown powers: P_GivePower stores the literal 1.
    expect(POWER_TICS[PW.pw_strength]).toBe(1);
    expect(POWER_TICS[PW.pw_allmap]).toBe(1);
  });

  it('the two non-countdown powers carry flag semantics', () => {
    const p = makePlayer();
    p.powers[PW.pw_allmap] = 1;
    p.powers[PW.pw_strength] = 1;
    tick(p, 500);
    expect(p.powers[PW.pw_allmap]).toBe(1); // never decremented
    expect(p.powers[PW.pw_strength]).toBe(501); // counts UP from 1
  });
});

describe('P_GivePower application points (p_inter.c:290-331)', () => {
  it('each kind lands its duration', () => {
    const cases: [number, number][] = [
      [PW.pw_invulnerability, INVULNTICS],
      [PW.pw_invisibility, INVISTICS],
      [PW.pw_infrared, INFRATICS],
      [PW.pw_ironfeet, IRONTICS]
    ];
    for (const [kind, tics] of cases) {
      const p = makePlayer();
      expect(P_GivePower(p, kind)).toBe(true);
      expect(p.powers[kind]).toBe(tics);
    }
  });

  it('berserk heals through P_GiveBody (cap 100) and sets 1', () => {
    const p = makePlayer();
    p.health = 40;
    expect(P_GivePower(p, PW.pw_strength)).toBe(true);
    expect(p.health).toBe(100); // MAXHEALTH cap, NOT 140
    expect(p.powers[PW.pw_strength]).toBe(1);
    // Re-taking berserk still returns true (no `already got it` branch).
    expect(P_GivePower(p, PW.pw_strength)).toBe(true);
  });

  it('invisibility sets MF_SHADOW at the PICKUP site only', () => {
    const p = makePlayer();
    expect(p.mo.flags & MF_SHADOW).toBe(0);
    P_GivePower(p, PW.pw_invisibility);
    expect(p.mo.flags & MF_SHADOW).toBe(MF_SHADOW);
    // Re-taking it refreshes the counter and (re)sets the bit — nothing
    // else in 1.10 touches the flag (grep MF_SHADOW: p_inter.c:303,
    // p_user.c:347, plus monster/flag definitions).
    p.mo.flags &= ~MF_SHADOW;
    P_GivePower(p, PW.pw_invisibility);
    expect(p.mo.flags & MF_SHADOW).toBe(MF_SHADOW);
  });

  it('a power already held is refused, except the four timed kinds', () => {
    const p = makePlayer();
    expect(P_GivePower(p, PW.pw_allmap)).toBe(true);
    expect(P_GivePower(p, PW.pw_allmap)).toBe(false);
    // invulnerability/invisibility/infrared/ironfeet/berserk return true
    // unconditionally — re-picking up REFRESHES the clock (p_inter.c:294-324).
    P_GivePower(p, PW.pw_invulnerability);
    tick(p, 100);
    expect(P_GivePower(p, PW.pw_invulnerability)).toBe(true);
    expect(p.powers[PW.pw_invulnerability]).toBe(INVULNTICS);
  });
});

/* ================================================================== */
/* 2. Decay tables (p_user.c:339-359)                                 */
/* ================================================================== */

describe('power decay, tic-exact', () => {
  it('every countdown power decays exactly −1 EVERY tic (no &3 gate)', () => {
    const p = makePlayer();
    P_GivePower(p, PW.pw_invisibility); // 2100 — the &3-gated kind in ports
    P_GivePower(p, PW.pw_ironfeet);
    let checked = 0;
    tick(p, 2100, (tic) => {
      expect(p.powers[PW.pw_invisibility]).toBe(2100 - tic);
      expect(p.powers[PW.pw_ironfeet]).toBe(2100 - tic);
      checked++;
    });
    expect(checked).toBe(2100);
    expect(p.powers[PW.pw_invisibility]).toBe(0);
    expect(p.powers[PW.pw_ironfeet]).toBe(0);
  });

  it('no power ever wraps below zero', () => {
    const p = makePlayer();
    for (const kind of [PW.pw_invulnerability, PW.pw_invisibility, PW.pw_infrared, PW.pw_ironfeet]) {
      p.powers[kind] = 3;
    }
    tick(p, 40);
    for (const kind of [PW.pw_invulnerability, PW.pw_invisibility, PW.pw_infrared, PW.pw_ironfeet]) {
      expect(p.powers[kind]).toBe(0);
    }
    tick(p, 200);
    expect(Array.from(p.powers).map((v) => (v < 0 ? 'NEG' : v))).not.toContain('NEG');
  });

  it('full lifetimes land on zero at exactly the duration', () => {
    for (const [kind, tics] of [
      [PW.pw_invulnerability, INVULNTICS],
      [PW.pw_invisibility, INVISTICS],
      [PW.pw_infrared, INFRATICS],
      [PW.pw_ironfeet, IRONTICS]
    ] as [number, number][]) {
      const p = makePlayer();
      P_GivePower(p, kind);
      tick(p, tics - 1);
      expect(p.powers[kind], `kind ${kind} at −1 tic`).toBe(1);
      tick(p, 1);
      expect(p.powers[kind], `kind ${kind} at expiry`).toBe(0);
    }
  });

  it('damagecount and bonuscount decay −1/tic and stop at 0', () => {
    const p = makePlayer();
    p.damagecount = 100; // p_inter.c:877-878 clamp
    p.bonuscount = BONUSADD;
    tick(p, 1, () => undefined);
    expect(p.damagecount).toBe(99);
    expect(p.bonuscount).toBe(BONUSADD - 1);
    tick(p, 1000);
    expect(p.damagecount).toBe(0);
    expect(p.bonuscount).toBe(0);
  });
});

/* ================================================================== */
/* 3. fixedcolormap + the flicker gate (p_user.c:362-383)             */
/* ================================================================== */

describe('fixedcolormap selection', () => {
  it('invulnerability maps to INVERSECOLORMAP 32, infrared to 1', () => {
    expect(INVERSECOLORMAP).toBe(32);
    expect(BRIGHTCOLORMAP).toBe(1);
    const inv = makePlayer();
    inv.powers[PW.pw_invulnerability] = 1000;
    expect(pFixedColormap(inv)).toBe(32);
    const infra = makePlayer();
    infra.powers[PW.pw_infrared] = 1000;
    expect(pFixedColormap(infra)).toBe(1);
    // Invulnerability is checked FIRST (the if/else-if chain).
    infra.powers[PW.pw_invulnerability] = 500;
    expect(pFixedColormap(infra)).toBe(32);
    const plain = makePlayer();
    expect(pFixedColormap(plain)).toBe(0);
  });

  it('the `>4*32 || &8` flicker matrix', () => {
    const inv = makePlayer();
    const table: [number, number][] = [
      [1050, 32], // fresh pickup: on the `>` arm
      [129, 32], // last tic of the `>` arm
      [128, 0], // 128 > 128 false, 128 & 8 = 0 → DARK
      [127, 32], // bit3 set → ON
      [120, 32], // 120 = 0b1111000 → bit3 set
      [119, 0], // 119 = 0b1110111 → bit3 clear
      [112, 0],
      [111, 32], // 111 = 0b1101111 → bit3 set
      [16, 0],
      [15, 32],
      [8, 32],
      [7, 0],
      [1, 0]
    ];
    for (const [tics, want] of table) {
      inv.powers[PW.pw_invulnerability] = tics;
      expect(pFixedColormap(inv), `invuln @${tics}`).toBe(want);
      inv.powers[PW.pw_invulnerability] = 0;
      inv.powers[PW.pw_infrared] = tics;
      expect(pFixedColormap(inv), `infrared @${tics}`).toBe(want === 32 ? BRIGHTCOLORMAP : 0);
      inv.powers[PW.pw_infrared] = 0;
    }
    expect(FLASHLENGTH).toBe(128);
  });

  it('the flicker alternates on 8-tic phases once under 129', () => {
    const inv = makePlayer();
    inv.powers[PW.pw_invulnerability] = 128;
    const on: number[] = [];
    const off: number[] = [];
    for (let t = 128; t > 0; t--) {
      inv.powers[PW.pw_invulnerability] = t;
      (pFixedColormap(inv) === 32 ? on : off).push(t);
    }
    // bit3 set ⇔ t mod 16 in [8,15]
    expect(on.every((t) => (t % 16) >= 8)).toBe(true);
    expect(off.every((t) => (t % 16) < 8)).toBe(true);
    expect(on.length).toBe(64);
    expect(off.length).toBe(64);
  });

  it('the same gate drives the psprite fuzz (r_things.c:716-718)', () => {
    expect(invisibilityFuzz(INVISTICS)).toBe(true);
    expect(invisibilityFuzz(129)).toBe(true);
    expect(invisibilityFuzz(128)).toBe(false);
    expect(invisibilityFuzz(127)).toBe(true);
    expect(invisibilityFuzz(7)).toBe(false);
    expect(invisibilityFuzz(8)).toBe(true);
    expect(invisibilityFuzz(0)).toBe(false);
  });

  it('pPowerThink writes player.fixedcolormap (the renderer read-through)', () => {
    const p = makePlayer();
    P_GivePower(p, PW.pw_infrared);
    tick(p, 4200 - 129);
    expect(p.fixedcolormap).toBe(1); // still on the `>128` arm
    expect(fixedColormapView(p.fixedcolormap)).toBe(1);
    tick(p, 1);
    expect(p.fixedcolormap).toBe(0); // 128 → dark phase
    expect(fixedColormapView(p.fixedcolormap)).toBe(-1); // the C NULL row
    p.powers[PW.pw_infrared] = 0;
    P_GivePower(p, PW.pw_invulnerability);
    pPowerThink(p);
    expect(p.fixedcolormap).toBe(INVERSECOLORMAP);
    expect(fixedColormapView(p.fixedcolormap)).toBe(32);
  });
});

/* ================================================================== */
/* 4. MF_SHADOW toggle (acceptance 3 of the brief)                    */
/* ================================================================== */

describe('MF_SHADOW toggle', () => {
  it('on at pickup, cleared on the exact expiry tic, and stays cleared', () => {
    const p = makePlayer();
    P_GivePower(p, PW.pw_invisibility);
    expect(p.mo.flags & MF_SHADOW).toBe(MF_SHADOW);
    let clearTic = -1;
    tick(p, INVISTICS + 50, (tic) => {
      if (clearTic < 0 && (p.mo.flags & MF_SHADOW) === 0) clearTic = tic;
    });
    expect(clearTic, 'cleared on the tic the counter reaches 0').toBe(INVISTICS);
    expect(p.powers[PW.pw_invisibility]).toBe(0);
    // 1.10 has NO flicker rule that re-toggles MF_SHADOW (no M_RANDOMFLASH
    // in the tree): once cleared it stays cleared until the next pickup.
    tick(p, 200);
    expect(p.mo.flags & MF_SHADOW).toBe(0);
  });

  it('the other powers never touch MF_SHADOW', () => {
    const p = makePlayer();
    for (const kind of [PW.pw_invulnerability, PW.pw_strength, PW.pw_infrared, PW.pw_ironfeet]) {
      P_GivePower(p, kind);
      tick(p, 3);
      expect(p.mo.flags & MF_SHADOW, `kind ${kind}`).toBe(0);
    }
  });
});

/* ================================================================== */
/* 5. Band matrix (st_stuff.c:1000-1048)                              */
/* ================================================================== */

describe('paletteBand (ST_doPaletteStuff)', () => {
  const src = (o: Partial<{ damagecount: number; bonuscount: number; powers: number[] }>) => ({
    damagecount: o.damagecount ?? 0,
    bonuscount: o.bonuscount ?? 0,
    powers: new Int32Array(o.powers ?? [0, 0, 0, 0, 0, 0])
  });

  it('the bank layout constants', () => {
    expect(STARTREDPALS).toBe(1);
    expect(NUMREDPALS).toBe(8);
    expect(STARTBONUSPALS).toBe(9);
    expect(NUMBONUSPALS).toBe(4);
    expect(RADIATIONPAL).toBe(13);
  });

  it('red band = (cnt+7)>>3 + 1, clamped at 8', () => {
    const table: [number, number][] = [
      [1, 2],
      [8, 2],
      [9, 3],
      [16, 3],
      [17, 4],
      [25, 5],
      [33, 6],
      [41, 7],
      [49, 8],
      [56, 8],
      [57, 8], // clamp: (57+7)>>3 = 8 → NUMREDPALS-1 = 7 → +1 = 8
      [64, 8],
      [100, 8]
    ];
    for (const [cnt, band] of table) {
      expect(paletteBand(src({ damagecount: cnt })), `damagecount ${cnt}`).toBe(band);
    }
    // The (cnt+7)>>3 shape can never produce 0 for cnt>0, so bank
    // STARTREDPALS(1) is UNREACHABLE — the mildest red flash is bank 2.
    expect(paletteBand(src({ damagecount: 1 }))).not.toBe(STARTREDPALS);
  });

  it('berserk fades through cnt, not its own bank', () => {
    const bzc = (strengthTics: number) => 12 - (strengthTics >> 6);
    const powers = [0, 1, 0, 0, 0, 0];
    expect(bzc(1)).toBe(12);
    expect(paletteBand(src({ powers }))).toBe(3); // (12+7)>>3 = 2 → +1
    powers[1] = 256;
    expect(bzc(256)).toBe(8);
    expect(paletteBand(src({ powers }))).toBe(2);
    powers[1] = 704;
    expect(bzc(704)).toBe(1);
    expect(paletteBand(src({ powers }))).toBe(2);
    powers[1] = 768; // bzc 0 → cnt 0 → falls through
    expect(paletteBand(src({ powers }))).toBe(0);
    // Damage wins when it is larger than the fade (`if (bzc > cnt)`).
    expect(paletteBand({ ...src({ damagecount: 17 }), powers: new Int32Array(powers) })).toBe(4);
    powers[1] = 1;
    expect(paletteBand({ ...src({ damagecount: 1 }), powers: new Int32Array(powers) })).toBe(3);
  });

  it('berserk fades out under live decay (the counting-up power)', () => {
    const p = makePlayer();
    P_GivePower(p, PW.pw_strength);
    expect(paletteBand(p)).toBe(3);
    tick(p, 255); // strength 256 → bzc 8
    expect(p.powers[PW.pw_strength]).toBe(256);
    expect(paletteBand(p)).toBe(2);
    tick(p, 512); // 768 → bzc 0 → band 0 (no red at all)
    expect(paletteBand(p)).toBe(0);
  });

  it('bonus band = (bc+7)>>3 + 9, clamped at 12; bank 9 unreachable', () => {
    const table: [number, number][] = [
      [1, 10],
      [6, 10], // BONUSADD (p_inter.c:37) — the real pickup value
      [8, 10],
      [9, 11],
      [16, 11],
      [17, 12],
      [24, 12],
      [25, 12], // clamp
      [100, 12]
    ];
    for (const [bc, band] of table) {
      expect(paletteBand(src({ bonuscount: bc })), `bonuscount ${bc}`).toBe(band);
    }
    expect(paletteBand(src({ bonuscount: 1 }))).not.toBe(STARTBONUSPALS);
  });

  it('radiation suit band 13 uses the same flicker gate as colormaps', () => {
    const mismatches: string[] = [];
    const powers = new Int32Array(6);
    for (let t = 1; t <= IRONTICS; t++) {
      powers[PW.pw_ironfeet] = t;
      const band = paletteBand({ damagecount: 0, bonuscount: 0, powers });
      const expected = t > FLASHLENGTH || (t & 8) !== 0 ? RADIATIONPAL : 0;
      if (band !== expected) mismatches.push(`tics ${t}: ${band} !== ${expected}`);
    }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(paletteBand(src({ powers: [0, 0, 0, IRONTICS, 0, 0] }))).toBe(13);
  });

  it('precedence: damage > bonus > radiation > 0', () => {
    expect(paletteBand({ ...src({ damagecount: 1, bonuscount: 20, powers: [0, 0, 0, IRONTICS, 0, 0] }) })).toBe(2);
    expect(paletteBand(src({ bonuscount: 1, powers: [0, 0, 0, IRONTICS, 0, 0] }))).toBe(10);
    expect(paletteBand(src({ powers: [0, 0, 0, IRONTICS, 0, 0] }))).toBe(13);
    expect(paletteBand(src({}))).toBe(0);
  });

  it('invulnerability and infrared are NOT bands (fixedcolormap path)', () => {
    // A player who is invulnerable, invisible and berzerk-but-undamaged
    // shows band 0 — vanilla tints those two through COLORMAP, not PLAYPAL.
    const p = makePlayer();
    P_GivePower(p, PW.pw_invulnerability);
    P_GivePower(p, PW.pw_invisibility);
    expect(paletteBand(p)).toBe(0);
    expect(p.fixedcolormap).toBe(0); // refreshed by the think below
    pPowerThink(p);
    expect(p.fixedcolormap).toBe(INVERSECOLORMAP);
    const suit = makePlayer();
    P_GivePower(suit, PW.pw_infrared);
    pPowerThink(suit);
    expect(paletteBand(suit)).toBe(0);
    expect(suit.fixedcolormap).toBe(BRIGHTCOLORMAP);
  });
});

/* ================================================================== */
/* 6. sfx slot (sounds.h ids + the pickup site counts)                */
/* ================================================================== */

describe('sfx slot', () => {
  it('the sfxenum table is order-exact against every pin already on main', () => {
    expect(NUMSFX).toBe(109);
    expect(SFX_ID.sfx_None).toBe(0);
    expect(SFX_ID.sfx_radio).toBe(108);
    expect([SFX_DOROPN, SFX_DORCLS, SFX_BDOPN, SFX_BDCLS]).toEqual([
      SFX_ID.sfx_doropn,
      SFX_ID.sfx_dorcls,
      SFX_ID.sfx_bdopn,
      SFX_ID.sfx_bdcls
    ]);
    expect([SFX_PISTOL, SFX_SHOTGN, SFX_DSHTGN, SFX_SAWHIT, SFX_PUNCH]).toEqual([
      SFX_ID.sfx_pistol,
      SFX_ID.sfx_shotgn,
      SFX_ID.sfx_dshtgn,
      SFX_ID.sfx_sawhit,
      SFX_ID.sfx_punch
    ]);
    expect([SFX_SWTCHN, SFX_OOF, SFX_NOWAY, SFX_TELEPT, SFX_PSTART]).toEqual([
      SFX_ID.sfx_swtchn,
      SFX_ID.sfx_oof,
      SFX_ID.sfx_noway,
      SFX_ID.sfx_telept,
      SFX_ID.sfx_pstart
    ]);
    // The three pickup sounds (the only ones p_inter.c emits).
    expect([SFX_ID.sfx_itemup, SFX_ID.sfx_wpnup, SFX_ID.sfx_getpow]).toEqual([32, 33, 93]);
    expect(SFX_ID.sfx_plpain).toBe(25);
  });

  it('ids are dense 0..108 with no duplicates', () => {
    const ids = Object.values(SFX_ID);
    expect(ids.length).toBe(NUMSFX);
    expect(new Set(ids).size).toBe(NUMSFX);
    expect(ids.map((v) => v as number).sort((a, b) => a - b)).toEqual(
      Array.from({ length: NUMSFX }, (_, i) => i)
    );
  });

  it("the bare-'0' mobjinfo token resolves to sfx_None", () => {
    expect(resolveSfxId('0')).toBe(0);
    expect(resolveSfxId('sfx_getpow')).toBe(93);
    expect(() => resolveSfxId('sfx_notathing')).toThrow(/not an sfxenum_t name/);
  });

  it('S_StartSound(NULL, …) logs the listener origin as (0,0,0)', () => {
    const h = createHookSlots();
    sStartSound(h, SFX_ID.sfx_getpow, null, 12);
    sStartSound(h, SFX_ID.sfx_slop, { x: 1 << 16, y: 2 << 16, z: 3 << 16 }, 13);
    expect(h.sfx.count).toBe(2);
    expect(h.sfx.entries[0]).toEqual({ id: 93, x: 0, y: 0, z: 0, tic: 12 });
    expect(h.sfx.entries[1]).toEqual({ id: 31, x: 1 << 16, y: 2 << 16, z: 3 << 16, tic: 13 });
    expect(h.sfx.byId?.get(93)).toBe(1);
    resetHookSlots(h);
    expect(h.sfx.count).toBe(0);
  });

  it('the pickup tail enqueues EXACTLY one sfx per pickup (p_inter.c:660)', () => {
    const h = createHookSlots();
    const tail = installPickupSfxBridge(h, () => 7);
    tail('sfx_itemup');
    tail('sfx_getpow');
    tail('sfx_wpnup');
    expect(h.sfx.count, 'one enqueue per tail call').toBe(3);
    expect(h.sfx.byId?.get(32)).toBe(1);
    expect(h.sfx.byId?.get(93)).toBe(1);
    expect(h.sfx.byId?.get(33)).toBe(1);
    // S_StartSound(NULL, sound) → listener origin on every one of them.
    expect(h.sfx.entries.every((e) => e.x === 0 && e.y === 0 && e.z === 0 && e.tic === 7)).toBe(true);
    expect(() => tail('sfx_nope')).toThrow(/not an sfxenum_t name/);
  });

  it('a powerup pickup site emits sfx_getpow (93) and nothing else', () => {
    // The six power sprites (PAIN/PSTR/PINS/SUIT/MEGA/SOUL) share ONE id:
    // p_inter.c:406/416/492/501/508/515/522/529 all set `sound = sfx_getpow`.
    const h = createHookSlots();
    const tail = installPickupSfxBridge(h, () => 0);
    for (let i = 0; i < 6; i++) tail('sfx_getpow');
    expect(h.sfx.count).toBe(6);
    expect(h.sfx.byId?.size).toBe(1);
    expect(h.sfx.byId?.get(SFX_ID.sfx_getpow)).toBe(6);
  });
});
