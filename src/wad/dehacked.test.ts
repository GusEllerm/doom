/**
 * M8-10 — DEHACKED lump parser + states-table fullbright hook
 * (docs/design/M8-plan.md §M8-10 + §3 D-0xx, A-02 / D008 cross-cut).
 *
 * Two halves:
 *   1. a SYNTHETIC lump covering the whole grammar the parser models (and the
 *      parts it deliberately skips), applied through the states.ts hook to a
 *      candidate table AND to the live one (plan acceptance 1);
 *   2. the PINNED freedoom1.wad lump (skipIf absent): the change audit the
 *      task asks for — what it touches, how much of it is in scope, and the
 *      fullbright rows that end up set (plan acceptance 2).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  applyDehackedFullbright,
  describeDehacked,
  parseDehacked,
  readDehacked,
  thingStatePointer,
  DEH_MOBJ_STATE_SLOTS,
  DEHACKED_LUMP_NAME,
  FF_FULLBRIGHT as DEH_FF_FULLBRIGHT,
  FF_FRAMEMASK as DEH_FF_FRAMEMASK,
} from './dehacked';
import {
  FF_FULLBRIGHT,
  FF_FRAMEMASK,
  NUMSTATES,
  S,
  applyDehackedFullbright as hookApplyDehackedFullbright,
  frameFullbright,
  frameIndex,
  stateFrame,
  stateSprite,
  stateTics,
} from './info/states';
import { SPR } from './info/sprnames';
import { WadFile } from './wadfile';

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Canonical (pre-hook) frame column — the info.c transcription. */
const BASE_FRAMES = Int32Array.from(stateFrame);

function snapshotFrames(): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < stateFrame.length; i += 1) {
    h = Math.imul(h ^ stateFrame[i]!, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Rows whose frame word differs from the canonical literal. */
function changedRows(target: Int32Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < target.length; i += 1) if (target[i] !== BASE_FRAMES[i]) out.push(i);
  return out;
}

/**
 * A synthetic patch covering every grammar shape the parser models: the
 * in-scope fullbright bit-set, the out-of-scope frame keys, the four
 * `Change * States` blocks, a property block, unknown junk and two BEX
 * sections (Freedoom ships PARS + STRINGS the same way).
 */
const SYNTHETIC = [
  'Patch File for DeHackEd v3.0',
  'Doom version = 19',
  'Patch format = 6',
  '',
  '# in scope: sets fullbright on S_POSS_ATK2 (frame F = 5, plan acceptance 1)',
  'Frame ' + S.S_POSS_ATK2,
  'Sprite subnumber = 32773',
  '',
  '// out of scope: tics (Duration) would change sim timing',
  'Frame 47',
  'Duration = 4',
  '',
  '! out of scope: sprite index + frame index + a fullbright CLEAR',
  'Frame 48',
  'Sprite number = 7',
  '',
  'Frame 49', // S_CHAIN, base frame 0: 32776 would MOVE the frame index
  'Sprite subnumber = 32776',
  '',
  'Frame 50', // value without the 0x8000 bit ⇒ a fullbright CLEAR
  'Sprite subnumber = 0',
  '',
  'Frame 51',
  'Light level = 192',
  '',
  'Frame 99999',
  'Sprite subnumber = 32773',
  '',
  'Change Thing States',
  'Thing # 2 : Pain -> 220',
  'Thing # 2 : Missile -> 184',
  '',
  'Change Weapon States',
  'Weapon # 5 : DUp -> 30',
  '',
  'Change Ammo States',
  'Ammo # 1 : Default max -> 200',
  '',
  'Change Misc Numbers',
  'Misc # 5 : Skill5 Health -> 100',
  '',
  'Thing 12',
  'Health = 40',
  'Mass = 100',
  '',
  'Garbage Block 3',
  'what = ever',
  '[PARS]',
  'par  1 1   30  # 00:30',
  'par  1 2  120',
  '[STRINGS]',
  'GOTARMOR = Put on a force field vest.',
  'NIGHTMARE = line one\\',
  'line two',
  '',
].join('\n');

/* ------------------------------------------------------------------ */
/* 0) Constants parity with the table module                          */
/* ------------------------------------------------------------------ */

describe('frame-word constants', () => {
  it('dehacked.ts mirrors p_pspr.h through states.ts (no value cycle)', () => {
    expect(DEH_FF_FULLBRIGHT).toBe(FF_FULLBRIGHT);
    expect(DEH_FF_FRAMEMASK).toBe(FF_FRAMEMASK);
    expect(DEH_FF_FULLBRIGHT | DEH_FF_FRAMEMASK).toBe(0xffff);
    expect(DEH_MOBJ_STATE_SLOTS).toBe(8);
    expect(DEHACKED_LUMP_NAME).toBe('DEHACKED');
  });
});

/* ------------------------------------------------------------------ */
/* 1) Parser: grammar coverage, tolerance, determinism                */
/* ------------------------------------------------------------------ */

describe('parseDehacked (synthetic)', () => {
  const lump = parseDehacked(SYNTHETIC);

  it('reads the header metadata and ignores signature/comment lines', () => {
    expect(lump.doomVersion).toBe(19);
    expect(lump.patchFormat).toBe(6);
    expect(lump.bexSections).toEqual(['PARS', 'STRINGS']);
  });

  it('classifies every modeled block', () => {
    const byKind: Record<string, number> = {};
    for (const e of lump.entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    expect(byKind).toEqual({
      frame: 7, // 5 sprite-subnumber lines (+1 out of range), duration, sprite, light
      thingState: 2,
      weaponState: 1,
      ammoState: 1,
      miscNumber: 1,
      thing: 2,
    });
    // The `Thing 12` property lines are `thing`, never `miscNumber`:
    expect(lump.entries.filter((e) => e.kind === 'thing').map((e) => e.key)).toEqual(['health', 'mass']);
    expect(lump.entries.filter((e) => e.kind === 'miscNumber').map((e) => e.key)).toEqual(['skill5 health']);
  });

  it('maps Frame keys to the frame-word vocabulary', () => {
    const frame = lump.entries.filter((e) => e.kind === 'frame');
    expect(frame.map((e) => `${e.index}:${e.key}:${e.value}`)).toEqual([
      `${S.S_POSS_ATK2}:frame:32773`,
      '47:tics:4',
      '48:sprite:7',
      '49:frame:32776',
      '50:frame:0',
      '51:light:192',
      '99999:frame:32773',
    ]);
  });

  it('counts what it cannot model instead of crashing (dehSkippedEntries)', () => {
    expect(lump.dehSkippedEntries).toBe(6);
    expect(lump.skippedByBucket).toEqual({
      'unrecognized line': 2, // `Garbage Block 3` + `what = ever`
      '[PARS]': 2,
      '[STRINGS]': 2, // GOTARMOR + the two-line `\` continuation entry (once)
    });
  });

  it('indexes Change Thing States with the classic mobj-state pointer table', () => {
    const ts = lump.entries.filter((e) => e.kind === 'thingState');
    expect(ts.map((e) => `${e.index}/${e.key}`)).toEqual(['2/pain', '2/missile']);
    // pointers: NUMSTATE + thing * 8 slots + slot index (mobjinfo_t field
    // order: spawn, see, pain, melee, missile, death, xdeath, raise).
    expect(thingStatePointer(2, 'Pain', NUMSTATES)).toBe(NUMSTATES + 2 * 8 + 2);
    expect(thingStatePointer(2, 'missilestate', NUMSTATES)).toBe(NUMSTATES + 2 * 8 + 4);
    expect(thingStatePointer(0, 'spawn', 967)).toBe(967);
    expect(thingStatePointer(136, 'Raise', NUMSTATES)).toBe(NUMSTATES + 136 * DEH_MOBJ_STATE_SLOTS + 7);
    expect(thingStatePointer(1, 'nonsense', NUMSTATES)).toBe(-1);
    for (const e of ts) {
      expect(thingStatePointer(e.index, e.key, NUMSTATES)).toBeGreaterThan(NUMSTATES);
    }
  });

  it('is deterministic: the same bytes parse to the same structure twice', () => {
    expect(parseDehacked(SYNTHETIC)).toEqual(lump);
    const bytes = new Uint8Array(Buffer.from(SYNTHETIC, 'latin1'));
    expect(parseDehacked(bytes)).toEqual(lump);
  });

  it('never throws on junk, and reports zero entries for an empty lump', () => {
    for (const junk of ['', '\n\n\n', 'x', 'Frame\n', 'Frame abc\nSprite subnumber = z\n', '[STRINGS]', '#[PARS]']) {
      expect(() => parseDehacked(junk)).not.toThrow();
    }
    expect(parseDehacked('').entries).toHaveLength(0);
    expect(parseDehacked('').dehSkippedEntries).toBe(0);
    // A `Frame` header without a usable number never opens a block, so the
    // line under it has no context: counted, not guessed.
    const j = parseDehacked('Frame abc\nSprite subnumber = z\n');
    expect(j.entries).toHaveLength(0);
    expect(j.dehSkippedEntries).toBe(2);
    // A symbolic (non-integer) value inside a real block parses to NaN and is
    // reported as an ignored frame-index change rather than applied.
    const sym = parseDehacked('Frame 47\nSprite subnumber = BRSWA\n');
    expect(sym.entries).toHaveLength(1);
    expect(Number.isNaN(sym.entries[0]!.value)).toBe(true);
    const t = Int32Array.from(BASE_FRAMES);
    const r = applyDehackedFullbright(t, sym);
    expect(r.appliedCount).toBe(0);
    expect(r.ignored[0]!.reason).toMatch(/frame index change/);
    expect(Int32Array.from(t)).toEqual(BASE_FRAMES);
  });
});

/* ------------------------------------------------------------------ */
/* 2) Apply: fullbright-only scope, idempotence, the states.ts hook   */
/* ------------------------------------------------------------------ */

describe('applyDehackedFullbright (synthetic, candidate table)', () => {
  const lump = parseDehacked(SYNTHETIC);

  it('applies ONLY the pure 0x8000 bit-set — plan acceptance 1', () => {
    const target = Int32Array.from(BASE_FRAMES);
    const report = applyDehackedFullbright(target, lump);

    expect(report.appliedCount).toBe(1);
    expect(report.applied[0]!.state).toBe(S.S_POSS_ATK2);
    expect(report.applied[0]!.from).toBe(5);
    expect(report.applied[0]!.to).toBe(32773);
    expect(target[S.S_POSS_ATK2]).toBe(32773); // frame F | fullbright
    expect(frameIndex(target[S.S_POSS_ATK2]!)).toBe(5);
    expect(frameFullbright(target[S.S_POSS_ATK2]!)).toBe(true);
    // Surgical: nothing else moves.
    expect(changedRows(target)).toEqual([S.S_POSS_ATK2]);
  });

  it('logs every parsed-but-not-applied entry with a reason', () => {
    const target = Int32Array.from(BASE_FRAMES);
    const report = applyDehackedFullbright(target, lump);
    expect(report.ignoredCount).toBe(lump.entries.length - report.appliedCount);
    expect(report.dehSkippedEntries).toBe(lump.dehSkippedEntries);

    const reasons = Object.keys(report.ignoredByReason).join('\n');
    expect(reasons).toMatch(/Duration/); // state tics: sim-visible, deferred
    expect(reasons).toMatch(/fullbright CLEAR/); // Frame 49: 6 clears the bit
    expect(reasons).toMatch(/frame index change/); // Frame 49: 0 → frame H
    expect(reasons).toMatch(/state index outside/); // Frame 99999
    expect(reasons).toMatch(/property edit/); // Thing 12 Health/Mass
    expect(reasons).toMatch(/state-pointer edit/); // Change * States blocks
    // Nothing but the one bit-set moves, whatever the other entries say.
    for (const s of [47, 48, 49, 50, 51, 99999]) expect(target[s]).toBe(BASE_FRAMES[s]);
  });

  it('is idempotent — a double run leaves the table byte-identical', () => {
    const target = Int32Array.from(BASE_FRAMES);
    const first = applyDehackedFullbright(target, lump);
    const after1 = Int32Array.from(target);
    const second = applyDehackedFullbright(target, lump);
    expect(Int32Array.from(target)).toEqual(after1);
    expect(second.appliedCount).toBe(0);
    expect(first.appliedCount).toBe(1);
    expect(second.ignoredByReason['fullbright bit already set in the base table — nothing to apply']).toBe(1);
  });

  it('is a no-op without a lump (synthetic WADs, plan D-0xx)', () => {
    const target = Int32Array.from(BASE_FRAMES);
    for (const absent of [null, undefined]) {
      const report = applyDehackedFullbright(target, absent);
      expect(report.appliedCount).toBe(0);
      expect(report.ignoredCount).toBe(0);
      expect(report.dehSkippedEntries).toBe(0);
      expect(Int32Array.from(target)).toEqual(BASE_FRAMES);
    }
  });

  it('fullbright already set in the base table is counted, not re-applied', () => {
    // S_HEALINGFONT? any row that info.c already writes fullbright:
    const row = BASE_FRAMES.findIndex((f) => (f & FF_FULLBRIGHT) !== 0);
    expect(row).toBeGreaterThan(-1);
    const lump2 = parseDehacked(`Frame ${row}\nSprite subnumber = ${BASE_FRAMES[row]}\n`);
    const target = Int32Array.from(BASE_FRAMES);
    const report = applyDehackedFullbright(target, lump2);
    expect(report.appliedCount).toBe(0);
    expect(report.ignoredCount).toBe(1);
    expect(Int32Array.from(target)).toEqual(BASE_FRAMES);
  });
});

describe('states.ts applyDehackedFullbright hook (live table)', () => {
  // The hook's default target IS the module table, so this describe owns the
  // mutation: it snapshots, applies, asserts, and restores in the same test —
  // every other test in this file reads the canonical columns.
  it('patches the built table through the single insertion point, reversibly', () => {
    const before = snapshotFrames();
    expect(changedRows(stateFrame)).toEqual([]);

    const lump = parseDehacked(SYNTHETIC);
    const report = hookApplyDehackedFullbright(lump);
    expect(report.appliedCount).toBe(1);
    expect(stateFrame[S.S_POSS_ATK2]).toBe(32773);
    expect(changedRows(stateFrame)).toEqual([S.S_POSS_ATK2]);

    // deterministic double-run (plan acceptance: table build twice ⇒ same)
    const mid = snapshotFrames();
    const again = hookApplyDehackedFullbright(lump);
    expect(snapshotFrames()).toBe(mid);
    expect(again.appliedCount).toBe(0);

    // null lump after a patch: no-op (the hook never un-patches), and the
    // untouched rows still match info.c row for row.
    expect(hookApplyDehackedFullbright(null).appliedCount).toBe(0);
    expect(snapshotFrames()).toBe(mid);
    expect(before).not.toBe(mid);

    // restore the canonical bytes for the rest of the module instance
    for (const a of report.applied) stateFrame[a.state] = a.from;
    expect(snapshotFrames()).toBe(before);
    expect(changedRows(stateFrame)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 3) The pinned freedoom1.wad lump: audit + applied counts           */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('freedoom1.wad DEHACKED', () => {
  const wad = WadFile.parse(
    new Uint8Array(readFileSync(WAD_PATH)).buffer as ArrayBuffer,
  );
  const lump = readDehacked(wad);

  it('is present, v3.0/format 6, and parsed without skips of the modeled part', () => {
    expect(lump).not.toBeNull();
    expect(lump!.doomVersion).toBe(19);
    expect(lump!.patchFormat).toBe(6);
    // R12 §"divergence 3": the lump IS present, 20,938 bytes.
    expect(wad.readLumpByName(DEHACKED_LUMP_NAME).byteLength).toBe(20938);
    expect(lump!.bexSections).toEqual(['PARS', 'STRINGS']);
  });

  it('changes exactly 7 frame rows: 5 fullbright bit-sets + 2 tics cuts', () => {
    const frames = lump!.entries.filter((e) => e.kind === 'frame');
    expect(frames.map((e) => `${e.index}:${e.key}=${e.value}`)).toEqual([
      '185:frame=32773', // # Zombie
      '419:frame=32773', // # Minigun zombie
      '685:frame=32773', // # Assault tripod
      '687:frame=32773',
      '689:frame=32773',
      '47:tics=4', // super-shotgun flash: 5 → 4
      '48:tics=3', //                        4 → 3
    ]);
    expect(lump!.dehSkippedEntries).toBeGreaterThan(0);
    // No thing/weapon/ammo/misc edits at all (R12 §3 "no thing/weapon changes").
    for (const kind of ['thing', 'thingState', 'weaponState', 'ammoState', 'miscNumber'] as const) {
      expect(lump!.entries.some((e) => e.kind === kind)).toBe(false);
    }
  });

  it('Frame <n> == the states[] row: the rows the lump names are the rows its comments name', () => {
    // `# Zombie` / `# Minigun zombie` / `# Assault tripod` firing frames, all
    // frame F (index 5) non-fullbright in info.c; and the SHT2 flash pair
    // whose 5 + 4 = 9 tics the lump's own comment quotes.
    expect([stateSprite[185], stateSprite[419], stateSprite[685], stateSprite[687], stateSprite[689]]).toEqual([
      SPR.POSS,
      SPR.CPOS,
      SPR.CYBR,
      SPR.CYBR,
      SPR.CYBR,
    ]);
    for (const s of [185, 419, 685, 687, 689]) {
      expect(frameIndex(BASE_FRAMES[s]!)).toBe(5);
      expect(frameFullbright(BASE_FRAMES[s]!)).toBe(false);
    }
    expect(stateTics[47]! + stateTics[48]!).toBe(9);
    expect(S.S_POSS_ATK2).toBe(185);
    expect(S.S_CPOS_ATK4).toBe(419);
    expect(S.S_CYBER_ATK2).toBe(685);
    expect(S.S_CYBER_ATK4).toBe(687);
    expect(S.S_CYBER_ATK6).toBe(689);
    expect(S.S_DSGUNFLASH1).toBe(47);
    expect(S.S_DSGUNFLASH2).toBe(48);
  });

  it('applies 5 fullbright bit-sets, ignores the 2 tics cuts, and re-runs identically', () => {
    const target = Int32Array.from(BASE_FRAMES);
    const report = applyDehackedFullbright(target, lump);

    expect(report.parsedByKind).toEqual({ frame: 7 });
    expect(report.appliedCount).toBe(5);
    expect(report.applied.map((a) => a.state)).toEqual([185, 419, 685, 687, 689]);
    for (const a of report.applied) {
      expect(a.from).toBe(5);
      expect(a.to).toBe(32773);
      expect(target[a.state]).toBe(32773);
    }
    expect(changedRows(target)).toEqual([185, 419, 685, 687, 689]);
    expect(report.ignoredCount).toBe(2);
    expect(report.ignoredByReason).toEqual({
      'state tics (Duration) — sim-visible, outside the M8-10 fullbright cross-cut': 2,
    });
    expect(report.ignored.map((e) => `${e.index}:${e.key}=${e.value}`)).toEqual(['47:tics=4', '48:tics=3']);

    // deterministic table build: second pass ⇒ identical bytes
    const hash1 = Array.from(target).join(',');
    const second = applyDehackedFullbright(target, lump);
    expect(Array.from(target).join(',')).toBe(hash1);
    expect(second.appliedCount).toBe(0);
    expect(parseDehacked(wad.readLumpByName(DEHACKED_LUMP_NAME))).toEqual(lump);

    // fullbright row census: base 278 (states.test.ts SOURCE_FULLBRIGHT_ROWS)
    // + the 5 applied rows, nothing else.
    const rows = [...Array(NUMSTATES).keys()].filter((i) => frameFullbright(target[i]!));
    expect(rows).toHaveLength(278 + 5);
    for (const s of [185, 419, 685, 687, 689]) expect(rows).toContain(s);

    console.log(describeDehacked(lump!, report));
  });

  it('leaves the live table canonical for every other test (hook untouched here)', () => {
    expect(changedRows(stateFrame)).toEqual([]);
  });
});
