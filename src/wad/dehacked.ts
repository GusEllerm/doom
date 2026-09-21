/**
 * dehacked.ts — DEHACKED lump parser + the states-table fullbright hook
 * (M8-10, docs/design/M8-plan.md §M8-10 + §3 D-0xx; A-02 / D008 cross-cut).
 *
 * WHAT THIS MODULE IS: a parse-tolerant reader for the classic DeHackEd v3.0
 * *text* patch format (`Patch File for DeHackEd v3.0` / `Doom version = 19` /
 * `Patch format = 6`) — the format Freedoom Phase 1 ships inside its IWAD as
 * the `DEHACKED` lump (20,938 B, R12 §3 lump table + R12 §"divergence 3":
 * "DEHACKED IS PRESENT … fullbright frame tweaks only"). It never throws on
 * content it does not model: unmodelled blocks/lines are counted into
 * {@link DehackedLump.dehSkippedEntries} and the rest of the lump keeps
 * parsing (deterministic — no wall-clock, no locale, latin1 byte→codepoint
 * decode only).
 *
 * WHAT IT APPLIES (plan §M8-10 scope = the fullbright cross-cut, and NOTHING
 * else): `Frame <stateNum>` blocks whose `Sprite subnumber` sets the
 * FF_FULLBRIGHT bit (p_pspr.h:50, 0x8000) on a state whose frame INDEX already
 * matches — i.e. a pure bit-set. Everything else that parses is recorded in
 * the apply report with a reason and left untouched (plan §3 defers "DEHACKED
 * thing property edits beyond fullbright" to M12 stretch). The base rows of
 * `wad/info/states.ts` stay the transcription truth: the hook is idempotent
 * (it only ever ORs the bit in), so a table built without a lump is
 * byte-identical to info.c and the L1 row-by-row census is unaffected.
 *
 * STATE NUMBERING — `Frame <n>` == the states[] ROW index (== statenum_t).
 *   Pinned EMPIRICALLY on the pinned freedoom1.wad DEHACKED (dehacked.test.ts
 *   asserts every row): the lump's own comments and values only make sense
 *   under direct state numbering —
 *     `# Zombie`     Frame 185 = S_POSS_ATK2   (POSS, frame F, 8 tics)
 *     `# Minigun…`   Frame 419 = S_CPOS_ATK4   (CPOS, frame F)
 *     `# Assault…`   Frame 685/687/689 = S_CYBER_ATK2/4/6 (CYBR, frame F)
 *     `super shotgun … muzzle flash … totals 9 tics` → Frame 47/48 =
 *       S_DSGUNFLASH1/2 (SHT2), which in info.c really are 5 + 4 = 9 tics,
 *       re-cut to 4 + 3 = 7 by the lump's `Duration` entries.
 *   (An indirect numbering — sprite-frame counting or the mobj-state pointer
 *   table below — lands on none of those rows.)
 *
 * THING/WEAPON/AMMO STATE BLOCKS are parsed and *indexed* but never applied
 * (they edit state POINTERS, not frame bits). The classic DeHackEd pointer
 * numbering for `Change Thing States` targets is exposed by
 * {@link thingStatePointer}: pointers 0..NUMSTATE-1 address the states[] rows,
 * and pointers from NUMSTATE up address the flat mobj-state table in mobjinfo
 * order, 8 state-pointer slots per mobjtype — the mobjinfo_t field order
 * (info.h:161-183: spawnstate, seestate, painstate, meleestate, missilestate,
 * deathstate, xdeathstate, raisestate), mirrored field-by-field by
 * src/wad/info/mobjinfo.ts.
 *
 * EVIDENCE LEVEL, stated plainly: linuxdoom-1.10 ships NO dehacked source at
 * all (no d_deh.c in the mirror tree), so the block grammar and the pointer
 * numbering above are DeHackEd v3.0 *format* knowledge, not a source
 * transcription. The part that matters for M8-10 — `Frame <n>` == the states[]
 * row — is instead pinned EMPIRICALLY on the pinned freedoom1.wad lump, row by
 * row, by dehacked.test.ts; the pointer numbering contains zero entries in
 * that lump and is exercised only by the synthetic test (and never applied).
 *
 * CALL SITE (intentionally not wired by M8-10, whose file ownership is this
 * module + the single states.ts hook): the WAD boot path runs
 * `applyDehackedFullbright(readDehacked(wad))` (the export in
 * wad/info/states.ts) once after WadFile.parse — with freedoom1.wad that is
 * the 5-row patch dehacked.test.ts asserts. Wiring main.ts is a no-op for
 * pixels today for the render reason below, which is why it is left to the
 * integration milestone rather than done here.
 *
 * RENDER NOTE (verified, cited in the M8-10 report): the WORLD-sprite path
 * never sees the applied bit — render/rthings.ts builds its thing frames as a
 * Uint8Array of `state frame & FF_FRAMEMASK` (rthings.ts:34-35, 277-279, 382)
 * and render/vissprites.ts derives the sprite colormap from scalelight only,
 * with "FULLBRIGHT STAYS OFF until A-02/M8" (vissprites.ts:33-36, 363-367).
 * The bit IS live for the psprite layer (render/psprites.ts:244-245 ⇒
 * colormaps row 0), which is fed by sim/p_pspr.ts reading stateFrame of the
 * weapon states — and freedoom's overrides touch no psprite state's frame
 * word, so this task changes NO goldens.
 *
 * MEASURED, not assumed: rendering freedoom1 E1M1 from the 12 committed
 * viewpoints (tests/render/viewpoints.ts) gives byte-identical framebuffer
 * sha256 prefixes with the table unpatched and with all 5 overrides applied
 * (61e2a836…, 7df6d0c0…, c1ba9ae7…, d26f6e80…, 19d6abb9…, 0e3b04e6…,
 * f3861cb1…, 30588b27…, 5a823160…, 61e2a836…, e041fc82…, 0f6776d9…), while
 * dropping the sprite pass changes >3 of them — i.e. things ARE drawn and the
 * patch is still invisible. The probe lived in tests/render/ only while this
 * task was measured (M8-10 owns no test outside this file); promote it there
 * if/when the world-sprite pass starts reading the bit.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/* ------------------------------------------------------------------ */
/* Frame-word constants                                               */
/* ------------------------------------------------------------------ */

/**
 * p_pspr.h:50 — fullbright bit of a state's frame word. Deliberately local
 * (NOT imported from ./info/states): that module imports this one for its
 * build hook, and a value import would cycle. dehacked.test.ts pins parity.
 */
export const FF_FULLBRIGHT = 0x8000;
/** p_pspr.h:51 — frame index mask. */
export const FF_FRAMEMASK = 0x7fff;

/** The IWAD lump name the patch is read from (R12 §3 lump table). */
export const DEHACKED_LUMP_NAME = 'DEHACKED';

/* ------------------------------------------------------------------ */
/* Entry model                                                        */
/* ------------------------------------------------------------------ */

/**
 * Which grammar block an entry came from. `frame` is the only in-scope kind;
 * the rest are modelled well enough to count, audit and (for `thingState`)
 * index — never to apply.
 */
export type DehackedEntryKind =
  /** `Frame <n>` property block (in-scope: `Sprite subnumber` bit-sets). */
  | 'frame'
  /** `Thing <n>` property block (deferred: plan §3 item (e)). */
  | 'thing'
  /** `Missile <n>` property block. */
  | 'missile'
  /** `Sound <n>` property block. */
  | 'sound'
  /** `Ammo <n>` property block. */
  | 'ammo'
  /** `Weapon <n>` property block. */
  | 'weapon'
  /** `Player <n>` property block. */
  | 'player'
  /** `Miscellaneous` property block (per-global numbers, not pointers). */
  | 'miscProperty'
  /** `Change Thing States` entry (state-pointer edit). */
  | 'thingState'
  /** `Change Weapon States` entry (state-pointer edit). */
  | 'weaponState'
  /** `Change Ammo States` entry (state-pointer edit). */
  | 'ammoState'
  /** `Change Miscellaneous Numbers` entry (per-global number pointers). */
  | 'miscNumber';

/** One parsed entry (a `key = value` line, or one `X # n : slot -> v` line). */
export interface DehackedEntry {
  readonly kind: DehackedEntryKind;
  /** Normalized block keyword (`frame`, `thing`, `change thing states`, …). */
  readonly block: string;
  /** Block index (`Frame 185` ⇒ 185); -1 when the block has no index. */
  readonly index: number;
  /**
   * Normalized key: `frame`/`sprite`/`tics`/`light`/`misc1`/`misc2`/`action`
   * for Frame blocks, the lowercased source key otherwise, and the slot name
   * (`pain`, `death`, `missile`, …) for the `Change * States` forms.
   */
  readonly key: string;
  /** Numeric value; NaN when the value is not a plain integer. */
  readonly value: number;
  /** Slot target pointer index for `Change Thing States` (see thingStatePointer). */
  readonly pointer: number;
  /** Verbatim line (diagnostics / audit). */
  readonly raw: string;
  /** 1-based source line (diagnostics / audit). */
  readonly line: number;
}

/** A DEHACKED lump, parsed. */
export interface DehackedLump {
  /** latin1 decode of the lump bytes (byte i ⇒ codepoint i). */
  readonly text: string;
  /** `Doom version = <n>`; -1 when absent. */
  readonly doomVersion: number;
  /** `Patch format = <n>`; -1 when absent. */
  readonly patchFormat: number;
  /** Every recognized entry, in source order. */
  readonly entries: readonly DehackedEntry[];
  /**
   * Count of lines the grammar did not recognize at all — unmodelled blocks,
   * BEX `[SECTION]` payloads (Freedoom ships `[PARS]` + `[STRINGS]`), and
   * malformed lines. The plan's "parse-tolerant skip + counter" requirement.
   */
  readonly dehSkippedEntries: number;
  /** Skipped-line attribution by bucket (`[PARS]`, `unknown block`, …). */
  readonly skippedByBucket: Readonly<Record<string, number>>;
  /** BEX section names seen, in source order (`PARS`, `STRINGS`, …). */
  readonly bexSections: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Parser                                                             */
/* ------------------------------------------------------------------ */

/** Block keyword → entry kind (classic DeHackEd v3.0 block headers). */
const PROPERTY_BLOCKS: Readonly<Record<string, DehackedEntryKind>> = {
  frame: 'frame',
  thing: 'thing',
  missile: 'missile',
  sound: 'sound',
  ammo: 'ammo',
  weapon: 'weapon',
  player: 'player',
  miscellaneous: 'miscProperty',
};

/** `Change X` block header → entry kind. */
const CHANGE_BLOCKS: ReadonlyArray<readonly [RegExp, DehackedEntryKind, string]> = [
  [/^change\s+thing\s+states$/i, 'thingState', 'change thing states'],
  [/^change\s+weapon\s+states$/i, 'weaponState', 'change weapon states'],
  [/^change\s+ammo\s+states$/i, 'ammoState', 'change ammo states'],
  [/^change\s+misc(ellaneous)?\s+num(ber)?s?$/i, 'miscNumber', 'change misc numbers'],
];

/** Names of the `Change * States` kinds (the state-pointer edit classes). */
const STATE_POINTER_KINDS: readonly DehackedEntryKind[] = [
  'thingState',
  'weaponState',
  'ammoState',
  'miscNumber',
];

/** Frame-block key vocabulary (DeHackEd v3.0 + BEX [FRAME] aliases). */
const FRAME_KEYS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^sprite\s+subnumber$/i, 'frame'],
  [/^sprite\s+number$/i, 'sprite'],
  [/^duration$/i, 'tics'],
  [/^light\s+level$/i, 'light'],
  [/^misc\s*#?\s*1$/i, 'misc1'],
  [/^misc\s*#?\s*2$/i, 'misc2'],
  [/^action(\s+(function|routine))?$/i, 'action'],
];

/** `Change * States` / pointer line: `Thing # 5 : Pain -> 42`. */
const POINTER_ENTRY = /^(thing|weapon|ammo|misc|text)\s*#?\s*(\d+)\s*:\s*([A-Za-z][\w -]*?)\s*(?:->|=)\s*(\S+)(.*)$/i;
/** Property line: `Sprite subnumber = 32773`, `Duration = 4`. */
const KEY_VALUE = /^([A-Za-z][\w .#-]*?)\s*=\s*(\S.*?)\s*$/;
/**
 * `Frame 185`, `Thing # 7 (Zombieman)`, `Miscellaneous`, `Thing All`.
 * ANCHORED to end-of-line (modulo the parenthesised thing-name comment the
 * classic writers emit): an unanchored version would swallow the `Change
 * * States` pointer lines (`Weapon # 5 : DUp -> 30`) as block headers.
 */
const BLOCK_HEADER = /^(frame|thing|missile|sound|ammo|weapon|player|miscellaneous)\s*(#?\s*(all|zero|\d+))?\s*(\([^)]*\))?\s*$/i;
/** BEX section header: `[PARS]`, `[STRINGS]`, … */
const SECTION_HEADER = /^\[([A-Za-z][\w]*)\]\s*$/;
/** Comment / file signature lines. */
const COMMENT = /^\s*[#!;]/;
const SLASH_COMMENT = /^\s*\/\//;
const SIGNATURE = /^\s*(patch file for|created with|dehacked version)/i;
/** Top-level metadata lines (handled, not "skipped"). */
const METADATA: ReadonlyArray<readonly [RegExp, 'version' | 'format']> = [
  [/^doom\s+version$/i, 'version'],
  [/^patch\s+format$/i, 'format'],
];

/** mobjinfo_t state-pointer slots per mobjtype (info.h:1305+ field order). */
export const DEH_MOBJ_STATE_SLOTS = 8;

/** Slot-name table for `Thing # n : <slot> -> …` (mobjinfo_t field order). */
const THING_STATE_SLOTS: ReadonlyArray<readonly [RegExp, number]> = [
  [/^spawn(state)?$/i, 0],
  [/^(see|stand)(state)?$/i, 1],
  [/^pain(state)?$/i, 2],
  [/^(melee|attack)(state)?$/i, 3],
  [/^missile(state)?$/i, 4],
  [/^death(state)?$/i, 5],
  [/^(xdeath|xdeath)(state)?$/i, 6],
  [/^(raise)(state)?$/i, 7],
];

/**
 * Classic DeHackEd mobj-state pointer numbering: 0..numStates-1 are states[]
 * rows, numStates.. address the flat mobj-state table in mobjinfo order,
 * DEH_MOBJ_STATE_SLOTS slots per mobjtype (== sum of the per-mobj state counts
 * before n, uniform because every mobjinfo_t row carries the same 8
 * state-pointer fields). Out-of-band slot names return -1.
 */
export function thingStatePointer(
  thingNumber: number,
  slot: string,
  numStates: number,
): number {
  for (const [re, s] of THING_STATE_SLOTS) {
    if (re.test(slot)) return numStates + thingNumber * DEH_MOBJ_STATE_SLOTS + s;
  }
  return -1;
}

/** Latin1 decode: byte i → codepoint i (dehacked files are byte-oriented). */
function decodeLatin1(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return out;
}

/** Parse a `key = value` right side: integer, or NaN for symbolic tokens. */
function parseValue(text: string): number {
  const m = /^(-?\d+)(?!\w)/.exec(text.trim());
  return m ? Number.parseInt(m[1]!, 10) : Number.NaN;
}

/** Normalize a Frame-block key through the known-key table. */
function frameKey(key: string): string {
  for (const [re, name] of FRAME_KEYS) if (re.test(key.trim())) return name;
  return key.trim().toLowerCase();
}

/**
 * parseDehacked — read a DEHACKED lump. Pure, total (never throws on content),
 * and deterministic: identical bytes always yield identical entries/counters.
 */
export function parseDehacked(source: Uint8Array | string): DehackedLump {
  const text = typeof source === 'string' ? source : decodeLatin1(source);
  const lines = text.split(/\r\n|\r|\n/);

  const entries: DehackedEntry[] = [];
  const skippedByBucket: Record<string, number> = {};
  const bexSections: string[] = [];
  let dehSkippedEntries = 0;
  let doomVersion = -1;
  let patchFormat = -1;

  let kind: DehackedEntryKind | null = null;
  let block = '';
  let index = -1;
  let section: string | null = null;

  const skip = (bucket: string): void => {
    dehSkippedEntries += 1;
    skippedByBucket[bucket] = (skippedByBucket[bucket] ?? 0) + 1;
  };

  const closeBlock = (): void => {
    kind = null;
    block = '';
    index = -1;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();

    if (trimmed === '') {
      // Blank line = end of the current property block (classic grammar);
      // BEX sections end only at the next section header or at EOF.
      if (section === null) closeBlock();
      continue;
    }
    if (COMMENT.test(trimmed) || SLASH_COMMENT.test(trimmed)) continue;
    if (SIGNATURE.test(trimmed)) continue;

    const sectionMatch = SECTION_HEADER.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1]!.toUpperCase();
      bexSections.push(section);
      closeBlock();
      continue;
    }

    if (section !== null) {
      // Inside a BEX `[SECTION]` (Freedoom ships PARS + STRINGS): the payload
      // is out of the M8 scope by construction. One entry per logical line —
      // a trailing `\` continues the value onto the next line.
      skip(`[${section}]`);
      let last = trimmed;
      while (last.endsWith('\\') && i + 1 < lines.length) {
        i += 1;
        last = lines[i]!.trim();
      }
      continue;
    }

    const change = CHANGE_BLOCKS.find(([re]) => re.test(trimmed));
    if (change) {
      kind = change[1];
      block = change[2];
      index = -1;
      continue;
    }

    const header = BLOCK_HEADER.exec(trimmed);
    if (header) {
      kind = PROPERTY_BLOCKS[header[1]!.toLowerCase()]!;
      block = kind;
      const value = header[3];
      index = value === undefined ? -1 : /^(all|zero)$/i.test(value) ? -2 : Number.parseInt(value, 10);
      continue;
    }

    // — entry lines —
    if (kind !== null && STATE_POINTER_KINDS.includes(kind)) {
      const m = POINTER_ENTRY.exec(trimmed);
      if (m) {
        const slot = m[3]!.trim();
        const thingNumber = Number.parseInt(m[2]!, 10);
        const isThing = kind === 'thingState';
        entries.push({
          kind,
          block,
          index: thingNumber,
          key: slot.toLowerCase(),
          value: parseValue(m[4]!),
          pointer: isThing ? thingStatePointer(thingNumber, slot, 0) : -1,
          raw,
          line: i + 1,
        });
        continue;
      }
      skip('malformed state-change line');
      continue;
    }

    const kv = KEY_VALUE.exec(trimmed);
    if (kv) {
      const keyRaw = kv[1]!;
      // Top-level metadata lines (`Doom version = 19`) are handled, not skipped.
      if (kind === null) {
        const meta = METADATA.find(([re]) => re.test(keyRaw));
        if (meta) {
          const v = parseValue(kv[2]!);
          if (meta[1] === 'version') doomVersion = v;
          else patchFormat = v;
          continue;
        }
        // A `key = value` line outside any recognized block: no block context
        // means no way to interpret it — count it, never guess.
        skip('unrecognized line');
        continue;
      }
      // (kind !== null here: entries always belong to a recognized block.)
      entries.push({
        kind,
        block,
        index,
        key: kind === 'frame' ? frameKey(keyRaw) : keyRaw.trim().toLowerCase(),
        value: parseValue(kv[2]!),
        pointer: -1,
        raw,
        line: i + 1,
      });
      continue;
    }

    skip('unrecognized line');
  }

  return {
    text,
    doomVersion,
    patchFormat,
    entries,
    dehSkippedEntries,
    skippedByBucket,
    bexSections,
  };
}

/**
 * Read + parse the `DEHACKED` lump of a WAD (last-match-wins lookup is
 * WadFile's), or null when the IWAD ships none — the plan's no-op branch
 * (synthetic fixture WADs).
 */
export function readDehacked(wad: {
  has: (name: string) => boolean;
  readLumpByName: (name: string) => Uint8Array;
}): DehackedLump | null {
  return wad.has(DEHACKED_LUMP_NAME) ? parseDehacked(wad.readLumpByName(DEHACKED_LUMP_NAME)) : null;
}

/* ------------------------------------------------------------------ */
/* Apply (fullbright cross-cut only)                                  */
/* ------------------------------------------------------------------ */

/** One applied frame-bit override. */
export interface DehackedFrameChange {
  /** states[] row (== statenum_t) whose frame word changed. */
  readonly state: number;
  /** Frame word before / after. */
  readonly from: number;
  readonly to: number;
  /** 1-based source line of the `Sprite subnumber` entry. */
  readonly line: number;
}

/** One parsed entry deliberately NOT applied. */
export interface DehackedIgnored {
  readonly kind: DehackedEntryKind;
  readonly block: string;
  readonly key: string;
  readonly index: number;
  readonly value: number;
  readonly reason: string;
  readonly line: number;
}

/** Result of one {@link applyDehackedFullbright} pass. */
export interface DehackedApplyReport {
  /** Applied frame-bit overrides, in source order. */
  readonly applied: readonly DehackedFrameChange[];
  readonly appliedCount: number;
  /** Parsed-but-not-applied entries with the scope reason (auditable). */
  readonly ignored: readonly DehackedIgnored[];
  readonly ignoredCount: number;
  /** ignored-count by reason (deterministic insertion order). */
  readonly ignoredByReason: Readonly<Record<string, number>>;
  /** parsed-entry count by kind (`frame`, `thing`, `thingState`, …). */
  readonly parsedByKind: Readonly<Record<string, number>>;
  /** Carried through from the lump: unmodelled lines (plan's counter). */
  readonly dehSkippedEntries: number;
}

/** Reason text per out-of-scope class (plan §M8-10 scope + §3 (e)). */
const REASON = {
  tics: 'state tics (Duration) — sim-visible, outside the M8-10 fullbright cross-cut',
  sprite: 'state sprite index change — outside the M8-10 fullbright cross-cut',
  other: 'frame property change — outside the M8-10 fullbright cross-cut',
  clear: 'fullbright CLEAR (0x8000 not set) — M8-10 applies fullbright SETs only',
  frameIndex: 'frame index change, not a pure 0x8000 bit-set — outside M8-10 scope',
  range: 'state index outside the states table',
  property: 'thing/weapon/ammo/sound/misc property edit — deferred (plan §3 item (e))',
  states: 'state-pointer edit (Change * States) — deferred (plan §3 item (e))',
  misc: 'miscellaneous-number edit — deferred (plan §3 item (e))',
} as const;

/** Out-of-scope reason for one parsed entry ('' ⇒ in scope). */
function ignoreReason(e: DehackedEntry): string {
  if (e.kind === 'frame') {
    if (e.key === 'frame') return e.index < 0 ? REASON.range : REASON.frameIndex;
    if (e.key === 'tics') return REASON.tics;
    if (e.key === 'sprite') return REASON.sprite;
    return REASON.other;
  }
  if (e.kind === 'thingState' || e.kind === 'weaponState' || e.kind === 'ammoState') return REASON.states;
  if (e.kind === 'miscNumber') return REASON.misc;
  return REASON.property;
}

/**
 * applyDehackedFullbright — the M8-10 cross-cut, as a pure table mutation.
 *
 * Only `Frame <n> / Sprite subnumber = v` entries where v sets FF_FULLBRIGHT
 * WITHOUT changing the frame index are applied (`frames[n] = base | 0x8000`);
 * the write is monotone (bit OR only), so the pass is IDEMPOTENT and
 * re-running it on an already-patched table is byte-identical — the
 * determinism requirement. Everything else lands in {@link
 * DehackedApplyReport.ignored} with a reason. `lump = null` (no DEHACKED lump
 * in the IWAD) is the documented no-op: appliedCount 0, table untouched.
 */
export function applyDehackedFullbright(
  frames: Int32Array,
  lump: DehackedLump | null | undefined,
): DehackedApplyReport {
  const applied: DehackedFrameChange[] = [];
  const ignored: DehackedIgnored[] = [];
  const ignoredByReason: Record<string, number> = {};
  const parsedByKind: Record<string, number> = {};

  const bump = (map: Record<string, number>, key: string): void => {
    map[key] = (map[key] ?? 0) + 1;
  };

  for (const e of lump?.entries ?? []) {
    bump(parsedByKind, e.kind);
    if (e.kind !== 'frame' || e.key !== 'frame') {
      const reason = ignoreReason(e) || (e.kind === 'frame' ? REASON.other : REASON.property);
      ignored.push({ kind: e.kind, block: e.block, key: e.key, index: e.index, value: e.value, reason, line: e.line });
      bump(ignoredByReason, reason);
      continue;
    }
    const base = e.index >= 0 && e.index < frames.length ? frames[e.index]! : undefined;
    const reason =
      base === undefined
        ? REASON.range
        : Number.isNaN(e.value)
          ? REASON.frameIndex
          : (e.value & FF_FULLBRIGHT) === 0
            ? REASON.clear
            : (e.value & FF_FRAMEMASK) !== (base & FF_FRAMEMASK)
              ? REASON.frameIndex
              : '';
    if (reason !== '') {
      ignored.push({ kind: e.kind, block: e.block, key: e.key, index: e.index, value: e.value, reason, line: e.line });
      bump(ignoredByReason, reason);
      continue;
    }
    const to = (base! | FF_FULLBRIGHT) | 0;
    if (to !== base!) {
      frames[e.index] = to;
      applied.push({ state: e.index, from: base!, to, line: e.line });
    } else {
      ignored.push({
        kind: e.kind,
        block: e.block,
        key: e.key,
        index: e.index,
        value: e.value,
        reason: 'fullbright bit already set in the base table — nothing to apply',
        line: e.line,
      });
      bump(ignoredByReason, 'fullbright bit already set in the base table — nothing to apply');
    }
  }

  return {
    applied,
    appliedCount: applied.length,
    ignored,
    ignoredCount: ignored.length,
    ignoredByReason,
    parsedByKind,
    dehSkippedEntries: lump?.dehSkippedEntries ?? 0,
  };
}

/** One-line-per-bucket audit dump (test output / debug seam). */
export function describeDehacked(lump: DehackedLump, report: DehackedApplyReport): string {
  const lines = [
    `dehacked: doom version ${lump.doomVersion}, patch format ${lump.patchFormat}, ` +
      `${lump.entries.length} entries, ${lump.dehSkippedEntries} skipped lines ` +
      `(bex sections: ${lump.bexSections.join(',') || 'none'})`,
    `  parsed by kind: ${Object.entries(lump.entries.reduce<Record<string, number>>((m, e) => {
      m[e.kind] = (m[e.kind] ?? 0) + 1;
      return m;
    }, {})).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`,
    `  applied fullbright bit-sets: ${report.appliedCount}` +
      (report.applied.length === 0 ? '' : ` (states ${report.applied.map((a) => a.state).join(',')})`),
    `  ignored: ${report.ignoredCount} ${Object.entries(report.ignoredByReason).map(([k, v]) => `[${v}] ${k}`).join(' | ') || ''}`,
    `  skipped by bucket: ${Object.entries(lump.skippedByBucket).map(([k, v]) => `${k}=${v}`).join(' ') || 'none'}`,
  ];
  return lines.join('\n');
}
