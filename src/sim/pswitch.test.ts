/**
 * sim/pswitch.ts tests (M6-11) — switches, use lines, locked doors/cards
 * (p_switch.c + p_map.c P_UseLines/PTR_UseTraverse + the p_doors.c lock
 * halves). Mirrors /tmp/DOOM-master/linuxdoom-1.10/{p_switch.c,p_map.c,
 * p_doors.c,p_spec.c}.
 *
 * Pinned semantics (M6-plan §M6-11 acceptance):
 *  1) the USE ray: USERANGE = 64·FRACUNIT (SOURCE TRUTH p_local.h:56 —
 *     the plan's "USEMASK 8·64" is Heretic folklore), boundary
 *     pass/fail pinned, one-special-per-press abort;
 *  2) the SW1↔SW2 xor-i round trip + disarm + BUTTONTIME(35) revert +
 *     same-line re-press timer pin + MAXBUTTONS(16) overflow counter +
 *     the special-11 swtchn (NOT swtchx) quirk + the buttonlist->soundorg
 *     (SLOT 0) origin quirk;
 *  3) locked: 99/133–137 refusal (PD_*O + oof, switch stays ARMED) and
 *     success (card OR skull), manual 26–28/32–34 PD_*K, the monster use
 *     gate {1,32,33,34} + the ML_SECRET veto;
 *  4) side-1 refusals (124 excepted) and the p_user.c `usedown` event
 *     latch through the real gTicker.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { FRACUNIT } from '../core/constants';
import { buildFixtureMapWad, ML_SECRET, type RectMapSpec } from '../../tests/fixtures/mapBuilder';
import { TEX_SWITCH_OFF, TEX_SWITCH_ON } from '../../tests/fixtures/m6Fixtures';
import { WadFile } from '../wad/wadfile';
import { loadMap } from '../wad/mapdata';
import { buildSwitchList } from '../wad/switchlist';
import { buildMapFromData } from './map';
import { gInitGame, gTicker } from './game';
import { emptyInput } from './ticcmd';
import { resetHookSlots } from './hooks';
import { pTeleportMove } from './pmap';
import { pUseSpecialLine, pspecCounts, resetPspecCounts } from './pspec';
import {
  unimplementedSpecial, resetUnimplementedSpecial
} from './specials-table';
import { hashState, type GameState } from './state';
import {
  IT_BLUESKULL, IT_BLUECARD, IT_REDCARD, IT_REDSKULL,
  IT_YELLOWSKULL, IT_YELLOWCARD
} from './player';
import { MF_SOLID } from './thinglinks';
import type { Mover } from './pmap';

import {
  BWHERE, BUTTONTIME, MAXBUTTONS, PD_BLUEK, PD_BLUEO, PD_REDK, PD_REDO,
  PD_STRINGS, PD_YELLOWK, PD_YELLOWO, SFX_NOWAY, SFX_OOF, SFX_SWTCHN,
  SFX_SWTCHX, USERANGE, buttonList, evDoLockedDoor, pChangeSwitchTexture,
  pInitSwitchList, pStartButton, pUseLines, pswitchCounts, resetPswitchCounts,
  resetSwitchList, switchList
} from './pswitch';

const fx = (u: number): number => (u * FRACUNIT) | 0;

/* ------------------------------------------------------------------ */
/* Fixture: A room + hair-thin east/north corridors (use-ray geometry)  */
/*                                                                     */
/*   plan units, player start (64,128) facing east:                    */
/*    - A west VOID edge y96..160: trigger SR-PLAT 21 (tag 5) +         */
/*      SW1MTX mid (the west switch, 48 px from x=48)                  */
/*    - A|N1 gap y=256 x96..160: PLAIN open (no special)                */
/*    - N1 north edge y=272: trigger 21 (beyond-the-open-line test)     */
/*    - A|C1 gap x=256 y96..160: special 42 (SR door-close STUB, the    */
/*      NEAREST special for the abort test at x≈250)                    */
/*    - C1|E edge x=272: trigger 61 (must never fire in the abort run)  */
/* ------------------------------------------------------------------ */

const RAYFIX: RectMapSpec = {
  rooms: [
    { x: 0, y: 0, w: 256, h: 256, tag: 5 },
    { x: 256, y: 0, w: 16, h: 256 },
    { x: 272, y: 0, w: 16, h: 256 },
    { x: 0, y: 256, w: 256, h: 16 }
  ],
  doors: [
    { x1: 128, y1: 256, x2: 192, y2: 256, special: 0 }, // A|N1 plain open gap
    { x1: 256, y1: 96, x2: 256, y2: 160, special: 42 }  // A|C1 nearest-special
  ],
  triggers: [
    { x1: 0, y1: 96, x2: 0, y2: 160, special: 21, tag: 5, texture: TEX_SWITCH_OFF },
    { x1: 96, y1: 272, x2: 160, y2: 272, special: 21, tag: 5, texture: TEX_SWITCH_OFF },
    { x1: 272, y1: 96, x2: 272, y2: 160, special: 61, tag: 0, texture: TEX_SWITCH_OFF }
  ],
  things: [{ x: 64, y: 128, angle: 0, type: 1 }]
};

function stateFor(): GameState {
  const bytes = buildFixtureMapWad(RAYFIX, 'M6USE1');
  const buf = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
  return gInitGame(buildMapFromData(loadMap(WadFile.parse(buf), 'M6USE1')));
}

function lineWithSpecial(s: GameState, special: number): number {
  for (let i = 0; i < s.map.lines.count; i++) {
    if (s.map.lines.special[i] === special) return i;
  }
  throw new Error(`no line with special ${special}`);
}

/** Debug-style warp (same pTeleportMove semantics as __doom.sim.warp —
 * the debug module itself is covered from tests/headless, lint zones keep
 * it out of src/sim). */
function warp(s: GameState, x: number, y: number, angleDeg = NaN): void {
  const p = s.players[0]!;
  if (!Number.isNaN(angleDeg)) {
    p.mo.angle = Math.floor((((angleDeg % 360) + 360) % 360) / 360 * 4294967296) >>> 0;
  }
  pTeleportMove(s.pmap, p.mo, fx(x), fx(y));
  p.mo.z = p.mo.floorz;
}

function monster(): Mover {
  return {
    x: 0, y: 0, z: 0, radius: fx(16), height: fx(56),
    flags: MF_SOLID, player: false
  };
}

function clearButtons(): void {
  for (const b of buttonList) {
    b.line = -1;
    b.where = 0;
    b.btexture = '';
    b.btimer = 0;
    b.soundorgSector = -1;
  }
}

function mid(s: GameState, line: number): string {
  return s.map.sides.midTexture[s.map.lines.sideNumFront[line]!]!;
}

beforeEach(() => {
  clearButtons();
  resetPswitchCounts();
  resetPspecCounts();
  resetUnimplementedSpecial();
  resetSwitchList();
  pInitSwitchList([TEX_SWITCH_OFF, TEX_SWITCH_ON]);
});

/* ------------------------------------------------------------------ */
/* 1) switchlist build (P_InitSwitchList / wad/switchlist.ts)            */
/* ------------------------------------------------------------------ */

describe('switchlist build', () => {
  it('pairs the fixture name via the SW1→SW2 counterpart rule', () => {
    expect(buildSwitchList([TEX_SWITCH_OFF, TEX_SWITCH_ON])).toEqual([
      TEX_SWITCH_OFF, TEX_SWITCH_ON
    ]);
    expect(switchList.numswitches).toBe(1); // beforeEach init
    expect(switchList.names.length).toBe(2);
    expect(switchList.names[0]).toBe(TEX_SWITCH_OFF);
    expect(switchList.names[0 ^ 1]).toBe(TEX_SWITCH_ON); // the i^1 partner
  });

  it('episode filter: shareware keeps E1 pairs; known names above the episode drop out', () => {
    const names = ['SW1BRN1', 'SW2BRN1', 'SW1BLUE', 'SW2BLUE', 'SW1SKULL', 'SW2SKULL'];
    expect(buildSwitchList(names, 1)).toEqual(['SW1BRN1', 'SW2BRN1']);
    expect(buildSwitchList(names, 2)).toEqual([
      'SW1BRN1', 'SW2BRN1', 'SW1BLUE', 'SW2BLUE'
    ]);
    const d2 = buildSwitchList(names, 3);
    expect(d2).toContain('SW1SKULL');
    // A commercial-mode directory CARRYING the older pairs still pairs
    // them (real WADs are disjoint; documented scan caveat).
    expect(d2.length).toBe(6);
    // Unknown (Freedoom/fixture-style) names pair regardless of episode.
    expect(buildSwitchList(['SW1FD1A', 'SW2FD1A'], 1)).toEqual(['SW1FD1A', 'SW2FD1A']);
  });

  it('no fake pairings: an orphan SW1xxx (counterpart absent) is dropped', () => {
    expect(buildSwitchList(['SW1NOPE'])).toEqual([]);
    // …but a WAD that DOES carry both gets the pair (data-driven arm).
    expect(buildSwitchList(['SW1NOPE', 'SW2NOPE'])).toEqual(['SW1NOPE', 'SW2NOPE']);
  });
});

/* ------------------------------------------------------------------ */
/* 2) P_ChangeSwitchTexture — swap, disarm, buttons, quirks              */
/* ------------------------------------------------------------------ */

describe('P_ChangeSwitchTexture (p_switch.c:174-233)', () => {
  it('S1 (useAgain 0): mid swap via i^1, special DISARMED, swtchn, no button', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    expect(mid(s, l)).toBe(TEX_SWITCH_OFF);
    pChangeSwitchTexture(s, l, 0);
    expect(mid(s, l)).toBe(TEX_SWITCH_ON);
    expect(s.map.lines.special[l]).toBe(0);
    expect(s.hooks.sfx.byId?.get(SFX_SWTCHN)).toBe(1);
    expect(pswitchCounts.switchTextureMatch).toBe(1);
    expect(buttonList.every((b) => b.btimer === 0)).toBe(true); // S1: no button
  });

  it('SR (useAgain 1): swap, special KEPT, button armed middle/BUTTONTIME', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    pChangeSwitchTexture(s, l, 1);
    expect(mid(s, l)).toBe(TEX_SWITCH_ON);
    expect(s.map.lines.special[l]).toBe(21); // NOT cleared
    const b = buttonList[0]!;
    expect(b.btimer).toBe(BUTTONTIME);
    expect(b.line).toBe(l);
    expect(b.where).toBe(BWHERE.middle);
    expect(b.btexture).toBe(TEX_SWITCH_OFF); // restores the ORIGINAL
  });

  it('BUTTONTIME revert golden: texture back to SW1 at tic 35 + sfx', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    pChangeSwitchTexture(s, l, 1);
    for (let i = 0; i < 34; i++) gTicker(s, emptyInput());
    expect(mid(s, l)).toBe(TEX_SWITCH_ON); // still up at 34
    gTicker(s, emptyInput()); // the 35th update drains btimer → restore
    expect(mid(s, l)).toBe(TEX_SWITCH_OFF);
    expect(s.hooks.sfx.byId?.get(SFX_SWTCHN)).toBe(2); // press + revert
    expect(buttonList[0]!.btimer).toBe(0);
    expect(buttonList[0]!.line).toBe(-1);
  });

  it('same-line re-press keeps the ORIGINAL timer (vanilla pre-scan)', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    pChangeSwitchTexture(s, l, 1);
    for (let i = 0; i < 10; i++) gTicker(s, emptyInput());
    pChangeSwitchTexture(s, l, 1); // re-press mid-window
    expect(buttonList[0]!.btimer).toBe(25); // 35-10, NOT reset to 35
    expect(buttonList[0]!.btexture).toBe(TEX_SWITCH_OFF);
    expect(pswitchCounts.buttonRepress).toBe(1);
    // The re-press swap itself ran (mid was SW2 → matched names[1] → back
    // to SW1); the expiry then restores btexture (SW1) — idempotent.
    expect(mid(s, l)).toBe(TEX_SWITCH_OFF);
  });

  it('MAXBUTTONS overflow: the 17th start is counted, not crashed', () => {
    const s = stateFor();
    const nLines = s.map.lines.count;
    expect(nLines).toBeGreaterThan(MAXBUTTONS);
    for (let i = 0; i < MAXBUTTONS; i++) pStartButton(s, i, BWHERE.middle, 'X', 35);
    expect(pswitchCounts.buttonStarts).toBe(MAXBUTTONS);
    pStartButton(s, MAXBUTTONS % nLines === 0 ? nLines - 1 : MAXBUTTONS, BWHERE.middle, 'X', 35);
    expect(pswitchCounts.buttonOverflow).toBe(1); // I_Error → typed counter
  });

  it('special-11 QUIRK: disarm-before-check ⇒ exit switch plays swtchn', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    s.map.lines.special[l] = 11;
    resetHookSlots(s.hooks);
    pChangeSwitchTexture(s, l, 0);
    expect(s.hooks.sfx.byId?.get(SFX_SWTCHN)).toBe(1);
    expect(s.hooks.sfx.byId?.get(SFX_SWTCHX)).toBeUndefined();
    // …and through the dispatcher (S1 exit: swap BEFORE the exit call):
    s.map.lines.special[l] = 11;
    resetHookSlots(s.hooks);
    expect(pUseSpecialLine(s, s.players[0]!.mo, l, 0)).toBe(true);
    expect(s.exitRequest).toBe('normal');
    expect(s.hooks.sfx.byId?.get(SFX_SWTCHN)).toBe(1);
    expect(s.hooks.sfx.byId?.get(SFX_SWTCHX)).toBeUndefined();
  });

  it('soundorg quirk: swap sound originates at BUTTONLIST SLOT 0 sector', () => {
    const s = stateFor();
    // TWO special-21 switch lines live in DIFFERENT sectors (west wall =
    // room A, north strip edge = room N1).
    const sw21: number[] = [];
    for (let i = 0; i < s.map.lines.count; i++) {
      if (s.map.lines.special[i] === 21) sw21.push(i);
    }
    expect(sw21.length).toBe(2);
    const lSwitch = sw21[0]!;
    const lOther = sw21[1]!;
    expect(s.map.lines.sectorFront[lSwitch]).not.toBe(s.map.lines.sectorFront[lOther]);
    pStartButton(s, lOther, BWHERE.middle, TEX_SWITCH_OFF, 300); // fills slot 0
    resetHookSlots(s.hooks);
    pChangeSwitchTexture(s, lSwitch, 0);
    const e = s.hooks.sfx.entries[0]!;
    const sec = s.map.lines.sectorFront[lOther]!;
    expect(e.id).toBe(SFX_SWTCHN);
    // SLOT 0's org, not the switch's own sector (x may coincide by
    // geometry — both rooms span x 0..256 — y cannot).
    expect(e.x).toBe(s.map.sectors.soundOrgX[sec]);
    expect(e.y).toBe(s.map.sectors.soundOrgY[sec]);
    expect(e.y).not.toBe(s.map.sectors.soundOrgY[s.map.lines.sectorFront[lSwitch]!]!);
  });

  it('no switch texture on the line ⇒ silent no-op (scan exhausts)', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 42);
    resetHookSlots(s.hooks);
    pChangeSwitchTexture(s, l, 0);
    expect(pswitchCounts.switchTextureMatch).toBe(0);
    expect(s.hooks.sfx.count).toBe(0);
    expect(mid(s, l)).toBe('DOORFIX0'); // door-gap marker, untouched
  });
});

/* ------------------------------------------------------------------ */
/* 3) locked cards — EV_DoLockedDoor + the EV_VerticalDoor lock halves   */
/* ------------------------------------------------------------------ */

interface LockCase {
  readonly special: number;
  readonly card: number;
  readonly skull: number;
  readonly msg: string;
}

const LOCKED_BUTTONS: readonly LockCase[] = [
  { special: 99, card: IT_BLUECARD, skull: IT_BLUESKULL, msg: PD_BLUEO },
  { special: 133, card: IT_BLUECARD, skull: IT_BLUESKULL, msg: PD_BLUEO },
  { special: 134, card: IT_REDCARD, skull: IT_REDSKULL, msg: PD_REDO },
  { special: 135, card: IT_REDCARD, skull: IT_REDSKULL, msg: PD_REDO },
  { special: 136, card: IT_YELLOWCARD, skull: IT_YELLOWSKULL, msg: PD_YELLOWO },
  { special: 137, card: IT_YELLOWCARD, skull: IT_YELLOWSKULL, msg: PD_YELLOWO }
];

const LOCKED_DOORS: readonly LockCase[] = [
  { special: 26, card: IT_BLUECARD, skull: IT_BLUESKULL, msg: PD_BLUEK },
  { special: 32, card: IT_BLUECARD, skull: IT_BLUESKULL, msg: PD_BLUEK },
  { special: 27, card: IT_YELLOWCARD, skull: IT_YELLOWSKULL, msg: PD_YELLOWK },
  { special: 34, card: IT_YELLOWCARD, skull: IT_YELLOWSKULL, msg: PD_YELLOWK },
  { special: 28, card: IT_REDCARD, skull: IT_REDSKULL, msg: PD_REDK },
  { special: 33, card: IT_REDCARD, skull: IT_REDSKULL, msg: PD_REDK }
];

describe('locked specials (p_doors.c checks, p_switch.c dispatch)', () => {
  it('d_englsh strings pinned EXACT (PD_* ids map to them for M9)', () => {
    expect(PD_STRINGS[PD_BLUEO]).toBe('You need a blue key to activate this object');
    expect(PD_STRINGS[PD_REDO]).toBe('You need a red key to activate this object');
    expect(PD_STRINGS[PD_YELLOWO]).toBe('You need a yellow key to activate this object');
    expect(PD_STRINGS[PD_BLUEK]).toBe('You need a blue key to open this door');
    expect(PD_STRINGS[PD_REDK]).toBe('You need a red key to open this door');
    expect(PD_STRINGS[PD_YELLOWK]).toBe('You need a yellow key to open this door');
  });

  it('SR/S1 buttons 99/133–137: refusal = PD_*O + oof + switch STAYS ARMED', () => {
    for (const c of LOCKED_BUTTONS) {
      const s = stateFor();
      const l = lineWithSpecial(s, 21); // stand-in switch line
      s.map.lines.special[l] = c.special;
      resetHookSlots(s.hooks);
      resetPswitchCounts();
      expect(pUseSpecialLine(s, s.players[0]!.mo, l, 0), `use ${c.special}`).toBe(true);
      expect(s.hooks.message.byId?.get(c.msg), `msg ${c.special}`).toBe(1);
      expect(s.hooks.sfx.byId?.get(SFX_OOF), `oof ${c.special}`).toBe(1);
      expect(s.players[0]!.message).toBe(c.msg); // player.message write
      expect(s.map.lines.special[l], `armed ${c.special}`).toBe(c.special);
      expect(mid(s, l)).toBe(TEX_SWITCH_OFF); // texture untouched
      expect(pswitchCounts.changeSwitchTexture).toBe(0);
      expect(unimplementedSpecial.byLine[c.special]).toBe(0); // EV_DoDoor NOT reached
    }
  });

  it('card OR skull unlocks (any-combo rule), and the right colour only', () => {
    for (const c of LOCKED_BUTTONS) {
      for (const slot of [c.card, c.skull]) {
        const s = stateFor();
        const l = lineWithSpecial(s, 21);
        s.map.lines.special[l] = c.special;
        s.players[0]!.cards[slot] = 1;
        resetHookSlots(s.hooks);
        resetPswitchCounts();
        resetUnimplementedSpecial();
        clearButtons();
        const beforeUse = s.thinkers.nextId;
        expect(pUseSpecialLine(s, s.players[0]!.mo, l, 0)).toBe(true);
        expect(s.hooks.message.count, `${c.special} card ${slot}`).toBe(0);
        // M6-05b FLIP: EV_DoDoor is LIVE and the stand-in switch line's
        // TAG matches a sector → action TRUE, so the vanilla gated flow
        // runs: swap SW1→SW2, button pushed, disarm iff useAgain=0
        // (S1 133/135/137; SR 99/134/136 stay armed). Stub log empty.
        expect(
          unimplementedSpecial.byFn.get('evDoDoor'), `body ${c.special} LIVE`
        ).toBeUndefined();
        expect(s.thinkers.nextId, 'blazeOpen mover spawned').toBeGreaterThan(beforeUse);
        expect(mid(s, l), 'body TRUE ⇒ swap').toBe(TEX_SWITCH_ON);
        const again = c.special === 99 || c.special === 134 || c.special === 136;
        // pChangeSwitchTexture starts a button ONLY for useAgain=1 (SR).
        if (again) {
          expect(buttonList[0]!.btimer, 'SR: button pushed').toBeGreaterThan(0);
        } else {
          expect(buttonList[0]!.btimer, 'S1: no button').toBe(0);
        }
        expect(s.map.lines.special[l], again ? 'SR keeps armed' : 'S1 disarms')
          .toBe(again ? c.special : 0);
      }
    }
  });

  it('wrong-colour card still refuses (red at a blue lock)', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    s.map.lines.special[l] = 99;
    s.players[0]!.cards[IT_REDCARD] = 1;
    s.players[0]!.cards[IT_YELLOWSKULL] = 1;
    resetHookSlots(s.hooks);
    expect(pUseSpecialLine(s, s.players[0]!.mo, l, 0)).toBe(true);
    expect(s.hooks.message.byId?.get(PD_BLUEO)).toBe(1);
  });

  it('manual doors 26/27/28/32–34: PD_*K refusal before the body; card passes', () => {
    for (const c of LOCKED_DOORS) {
      const s = stateFor();
      const l = lineWithSpecial(s, 42); // gap line stand-in (two-sided)
      s.map.lines.special[l] = c.special;
      resetHookSlots(s.hooks);
      resetUnimplementedSpecial();
      expect(pUseSpecialLine(s, s.players[0]!.mo, l, 0), `use ${c.special}`).toBe(true);
      expect(s.hooks.message.byId?.get(c.msg), `msg ${c.special}`).toBe(1);
      expect(unimplementedSpecial.byFn.get('evVerticalDoor') ?? 0, `body ${c.special}`).toBe(0);
      expect(s.map.lines.special[l]).toBe(c.special); // never disarms (manuals)
      // With the card: straight into the (LIVE since M6-05b) body:
      s.players[0]!.cards[c.card] = 1;
      resetUnimplementedSpecial();
      resetHookSlots(s.hooks);
      const beforeUse = s.thinkers.nextId;
      expect(pUseSpecialLine(s, s.players[0]!.mo, l, 0)).toBe(true);
      expect(s.hooks.message.count).toBe(0);
      expect(s.thinkers.nextId, 'body LIVE: mover on the back sector')
        .toBeGreaterThan(beforeUse);
      expect(
        unimplementedSpecial.byFn.get('evVerticalDoor'), 'no stub'
      ).toBeUndefined();
      // Open ids 32/33/34 disarm INSIDE the body (p_doors.c clearInside).
      expect(s.map.lines.special[l], 'open types disarm inside')
        .toBe(c.special === 32 || c.special === 33 || c.special === 34 ? 0 : c.special);
    }
  });

  it('evDoLockedDoor: non-player thing → 0 silently (p_doors.c `if (!p)`)', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    s.map.lines.special[l] = 99;
    resetHookSlots(s.hooks);
    expect(evDoLockedDoor(s, l, 3, monster() as never)).toBe(false);
    expect(s.hooks.message.count).toBe(0);
    expect(pswitchCounts.lockedNoPlayer).toBe(0); // not even a player
  });

  it('monster use gate: {1,32,33,34} pass, others + ML_SECRET vetoed', () => {
    const m = monster() as never;
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    // Allow-list {1,32,33,34}: past the gate (returns true — vanilla
    // falls through the switch after EV_VerticalDoor). 1 hits the body
    // stub; 32/33/34 hit the lock branch's silent `if (!player) return`
    // (monster mobjs reach no player_t in the port either — body NOT
    // reached, no message).
    for (const sp of [1, 32, 33, 34]) {
      s.map.lines.special[l] = sp;
      resetUnimplementedSpecial();
      resetHookSlots(s.hooks);
      const beforeBody = s.thinkers.nextId;
      expect(pUseSpecialLine(s, m, l, 0), `monster ${sp}`).toBe(true);
      expect(s.hooks.message.count, `monster ${sp} msg`).toBe(0);
      // M6-05b FLIP: special 1 reaches the LIVE body (monsters spawn
      // doors — the JDC gate is REUSE-only, p_doors.c); 32/33/34 stay
      // in the lock branch's silent `if (!player) return` (no body).
      expect(s.thinkers.nextId, `monster ${sp} body`)
        .toBe(sp === 1 ? beforeBody + 1 : beforeBody);
      expect(
        unimplementedSpecial.byFn.get('evVerticalDoor'), 'no stub'
      ).toBeUndefined();
    }
    // Not on the list (21 S1 plat, 26 locked manual): gate vetoes ⇒
    // false, nothing runs.
    for (const sp of [21, 26]) {
      s.map.lines.special[l] = sp;
      resetUnimplementedSpecial();
      resetHookSlots(s.hooks);
      expect(pUseSpecialLine(s, m, l, 0), `veto ${sp}`).toBe(false);
      expect(unimplementedSpecial.count).toBe(0);
      expect(s.hooks.message.count).toBe(0);
    }
    // ML_SECRET vetoes monsters but NOT players ("never open secret
    // doors", p_switch.c:292).
    const lSec = lineWithSpecial(s, 21);
    s.map.lines.flags[lSec] = s.map.lines.flags[lSec]! | ML_SECRET;
    resetUnimplementedSpecial();
    expect(pUseSpecialLine(s, m, lSec, 0)).toBe(false);
    expect(pUseSpecialLine(s, s.players[0]!.mo, lSec, 0)).toBe(true);
    expect(s.map.lines.special[lSec]).toBe(0); // S1 21 fired+disarmed
  });
});

/* ------------------------------------------------------------------ */
/* 4) P_UseLines / PTR_UseTraverse (the USE ray)                         */
/* ------------------------------------------------------------------ */

describe('P_UseLines ray (p_map.c:1090-1160)', () => {
  it('USERANGE is 64·FRACUNIT (p_local.h:56 source truth)', () => {
    expect(USERANGE).toBe(64 * FRACUNIT);
  });

  it('fires a switch 48 units ahead: plat action live + swap + disarm', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    warp(s, 48, 128, 180); // facing WEST, 48 px from the x=0 switch
    resetHookSlots(s.hooks);
    pUseLines(s.players[0]!);
    expect(pswitchCounts.useSpecial).toBe(1);
    expect(mid(s, l)).toBe(TEX_SWITCH_ON);
    expect(s.map.lines.special[l]).toBe(0);
    expect(s.hooks.sfx.byId?.get(SFX_SWTCHN)).toBe(1);
  });

  it('64-unit boundary pinned: reachable AT 64, NOT at 65', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    warp(s, 64, 128, 180);
    pUseLines(s.players[0]!);
    const at64 = s.map.lines.special[l];
    // Pin the fixed comparison (P_TraverseIntercepts frac<=dist): the
    // endpoint-touching intercept IS traversed ⇒ fires at exactly 64.
    expect(at64, 'fires at exactly 64').toBe(0);
    warp(s, 65, 128, 180);
    pUseLines(s.players[0]!);
    expect(s.map.lines.special[l], 'silent at 65').toBe(0); // already fired
    // A FRESH state proves the negative:
    const s2 = stateFor();
    const l2 = lineWithSpecial(s2, 21);
    warp(s2, 65, 128, 180);
    pUseLines(s2.players[0]!);
    expect(s2.map.lines.special[l2], 'no fire at 65').toBe(21);
    expect(pswitchCounts.useSpecial, 'traverser never reached it').toBe(1); // prior hit
  });

  it('solid wall within range: sfx_noway + ABORT (no special behind it)', () => {
    const s = stateFor();
    // Face the north wall of A at a NON-gap segment: warp just below
    // y=256 outside the x96..160 gap span (the wall line is room-void).
    warp(s, 20, 216, 90); // x=20 is outside the gap span ⇒ solid at 40 px
    resetHookSlots(s.hooks);
    resetPswitchCounts();
    pUseLines(s.players[0]!);
    expect(pswitchCounts.useNoWay).toBe(1);
    expect(s.hooks.sfx.byId?.get(SFX_NOWAY)).toBe(1);
    expect(s.hooks.sfx.entries[0]!.x).toBe(s.players[0]!.mo.x); // origin = usething
    expect(pswitchCounts.useSpecial).toBe(0);
  });

  it('open non-special line: keeps checking, fires the special beyond', () => {
    const s = stateFor();
    warp(s, 160, 240, 90); // facing NORTH through the A|N1 gap (16 px)
    resetPswitchCounts();
    resetHookSlots(s.hooks);
    pUseLines(s.players[0]!);
    expect(pswitchCounts.useNoWay).toBe(0); // the gap was open, not a wall
    expect(pswitchCounts.useSpecial).toBe(1); // …and the y=272 switch fired
    // TWO special-21 lines exist (west + north); exactly one swapped:
    let swapped = 0;
    for (let i = 0; i < s.map.lines.count; i++) {
      if (s.map.sides.midTexture[s.map.lines.sideNumFront[i]!] === TEX_SWITCH_ON) swapped++;
    }
    expect(swapped).toBe(1);
    expect(s.map.lines.special.filter((v) => v === 0).length).toBeGreaterThan(0);
  });

  it('two specials in line: ONLY the nearest fires (return-false abort)', () => {
    const s = stateFor();
    const lNear = lineWithSpecial(s, 42); // x=256 gap, special 42
    const lFar = lineWithSpecial(s, 61); // x=272 trigger, special 61
    expect(s.map.lines.sideNumFront[lNear]!).toBeGreaterThanOrEqual(0);
    warp(s, 250, 128, 0); // facing EAST: 6 px to 42, 22 px to 61
    resetPswitchCounts();
    resetUnimplementedSpecial();
    resetHookSlots(s.hooks);
    pUseLines(s.players[0]!);
    expect(pswitchCounts.useSpecial).toBe(1); // dispatched once, then ABORT
    expect(pspecCounts.useSpecialLine).toBe(1);
    expect(unimplementedSpecial.byLine[42], 'SR door-close LIVE — no stub').toBe(0);
    expect(unimplementedSpecial.byLine[61]).toBe(0); // never reached
    expect(s.map.lines.special[lFar], 'far line untouched').toBe(61);
    expect(mid(s, lFar)).toBe(TEX_SWITCH_OFF);
    expect(s.map.lines.special[lNear]).toBe(42); // SR keeps its special
  });

  it('side-1 (back side) refusals: everything but 124', () => {
    const s = stateFor();
    const l = lineWithSpecial(s, 21);
    // Direct dispatcher: side 1 ⇒ false, NOTHING happens.
    resetHookSlots(s.hooks);
    resetUnimplementedSpecial();
    expect(pUseSpecialLine(s, s.players[0]!.mo, l, 1)).toBe(false);
    expect(s.map.lines.special[l]).toBe(21);
    expect(unimplementedSpecial.count).toBe(0);
    // 124 falls THROUGH the side gate (1.10's commented-out sliding door
    // case — USE route absent ⇒ returns true, no action).
    s.map.lines.special[l] = 124;
    expect(pUseSpecialLine(s, s.players[0]!.mo, l, 1)).toBe(true);
    expect(s.map.lines.special[l]).toBe(124); // use-side no-op (cross owns it)
    // Geometric proof: standing in E, using WEST across the x=272 line.
    const s2 = stateFor();
    const lE = lineWithSpecial(s2, 61);
    warp(s2, 280, 128, 180);
    resetPswitchCounts();
    pUseLines(s2.players[0]!);
    expect(pswitchCounts.useSpecial).toBe(1); // dispatched…
    expect(s2.map.lines.special[lE]).toBe(61); // …and refused (back side)
    expect(mid(s2, lE)).toBe(TEX_SWITCH_OFF);
  });

  it('usedown: one ray per PRESS through the real gTicker (p_user.c:320)', () => {
    const s = stateFor();
    warp(s, 250, 128, 0);
    resetPswitchCounts();
    const use = { ...emptyInput(), use: true };
    // M7-05 (G_PlayerReborn, g_game.c:822 `usedown = attackdown = true;
    // don't do anything immediately` — now live via the forced-PST_REBORN
    // new game): a button HELD SINCE SPAWN is "down last tic" and gets NO
    // ray until a real release+press cycle happens.
    for (let i = 0; i < 5; i++) gTicker(s, use); // HELD since spawn: 5 tics
    expect(pswitchCounts.useLines, 'spawn usedown latch: no ray while held').toBe(0);
    expect(pspecCounts.useSpecialLine).toBe(0);
    gTicker(s, emptyInput()); // release
    for (let i = 0; i < 3; i++) gTicker(s, use); // first real PRESS
    expect(pswitchCounts.useLines, 'first press fires').toBe(1);
    gTicker(s, emptyInput()); // release
    for (let i = 0; i < 3; i++) gTicker(s, use); // press again
    expect(pswitchCounts.useLines, 'second press fires again').toBe(2);
    expect(s.players[0]!.usedown).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5) determinism (debug giveCard channel: tests/headless/switches)      */
/* ------------------------------------------------------------------ */

describe('determinism', () => {
  it('double-run equality: warp+give+use+40 tics hashes identically', () => {
    const run = (): number => {
      const s = stateFor();
      warp(s, 250, 128, 0);
      s.players[0]!.cards[IT_BLUECARD] = 1;
      const h0 = hashState(s);
      expect(Number.isFinite(h0)).toBe(true);
      const use = { ...emptyInput(), use: true };
      gTicker(s, use);
      for (let i = 0; i < 40; i++) gTicker(s, emptyInput());
      return hashState(s);
    };
    expect(run()).toBe(run());
  });
});
