/**
 * Sprite definition loader — `S_START..S_END` lump census (M1-07).
 *
 * Source-verified against linuxdoom-1.10 `r_things.c` (R02 §8, R06 §4):
 * - `R_InitSpriteDefs` scans every lump between the sprite markers and
 *   compares **only the first 4 name chars** to the sprite name — there is
 *   no `S_` prefix rule (r_things.c:207-218).
 * - Lump-name grammar `SSSSFR[fr]` (r_things.c:218-234): chars 0-3 sprite,
 *   char 4 frame letter (`name[4]-'A'`), char 5 rotation digit
 *   (`name[5]-'0'`), and — when present — chars 6-7 a *second* frame/rotation
 *   pair installed as the horizontally mirrored image (`flip = true`,
 *   r_things.c:228-234).
 * - `R_InstallSpriteLump` (r_things.c:95-156, verbatim): rotation `0` fills
 *   all 8 slots with the same lump (`rotate = false`); rotation `1..8` fills
 *   slot `rotation-1` (`rotate = true`). A flipped install writes **the same
 *   lump** into `slot(rotation-1)` with `flip = 1` — no slot copying happens,
 *   which is why bilateral sprites name five lumps for eight views:
 *   `TROOA1`, `TROOA2A8`, `TROOA3A7`, `TROOA4A6`, `TROOA5`
 *   (verified: freedoom1.wad has 182 such 8-char names out of 853 sprite
 *   lumps and the mirror-pair digit sets are exactly {2,8}, {3,7}, {4,6} plus
 *   the self-mirror pair {1,5}; indices 0 and 4 are their own mirrors).
 *   The renderer's `lump = sprframe->lump[rot]; flip = sprframe->flip[rot]`
 *   (r_things.c:520-533) then mirrors the patch by walking it backwards
 *   (`xiscale = -iscale`), so no pixel work belongs here.
 *
 * Differences from vanilla, deliberate (DOOM tolerates junk lumps; a
 * browser build must not die on them):
 * - vanilla `I_Error`s on malformed names, duplicate rotation slots, a
 *   rot=0 lump mixed with rot=1..8 lumps, and missing rotations. Here those
 *   cases are collected into `warnings` and the *first* install wins, so a
 *   WAD with junk still yields a usable census.
 * - vanilla knows `sprites[]` from `sprnames[]` in info.c; we census from the
 *   lumps themselves, so unknown/extra 4CCs appear too (override-safe, and
 *   `lumpToSprite` needs no name table).
 * - a `#` in a lump name (e.g. `TROOA1#5`, the "SPRITE(6) + #N instance"
 *   scheme some tooling emits) is not expressible in vanilla's grammar — the
 *   WAD directory name field is 8 bytes, so 9-char names cannot exist at all,
 *   and vanilla would read `#`/`5` as a garbage frame pair and `I_Error`. We
 *   reject such names with a dedicated {@link SpriteNameError} message.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import type { SpriteDef } from './types';
import type { WadFile } from './wadfile';

/* ------------------------------------------------------------------ */
/* Constants (R02 §8 / r_things.c)                                     */
/* ------------------------------------------------------------------ */

/** Sprite range markers (R01 §15.2; zero-size markers are skipped by lumpRange). */
export const SPRITE_START_MARKER = 'S_START';
export const SPRITE_END_MARKER = 'S_END';

/** Views per rotating frame (`sprframe_t.lump[8]`). */
export const NUM_ROTATIONS = 8;

/** `sprtemp[29]` — `R_InstallSpriteLump` rejects `frame >= 29` (r_things.c:110-114). */
export const MAX_SPRITE_FRAMES = 29;

/** Highest legal rotation digit (`rotation > 8` is rejected, r_things.c:110). */
export const MAX_ROTATION_DIGIT = 8;

/** `SSSSFR` / `SSSSFRfr`. */
const NAME_LEN_PLAIN = 6;
const NAME_LEN_PAIRED = 8;
const SPRITE_NAME_LEN = 4;

/** Eight lump slots in the exact `SpriteDef['frames'][0]['lump']` tuple shape. */
type LumpSlots = [number, number, number, number, number, number, number, number];

/* ------------------------------------------------------------------ */
/* Typed error (R02 §8 grammar violations)                             */
/* ------------------------------------------------------------------ */

/** Thrown by {@link parseSpriteLumpName} for names outside the DOOM grammar. */
export class SpriteNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpriteNameError';
  }
}

/* ------------------------------------------------------------------ */
/* Public shapes                                                       */
/* ------------------------------------------------------------------ */

/** One `R_InstallSpriteLump` call derived from a lump name (1 or 2 per name). */
export interface SpriteInstall {
  /** Frame index, `name[4] - 'A'` (0 = 'A'). */
  readonly frame: number;
  /** Rotation *digit*: 0 = all views, 1..8 = one octant. */
  readonly rotation: number;
  /** True for the chars 6-7 pair (mirrored install). */
  readonly flip: boolean;
}

/** Parsed sprite lump name. */
export interface SpriteLumpName {
  /** Chars 0-3, uppercased. */
  readonly name4: string;
  /** Direct install first, mirrored install second (r_things.c:223-234 order). */
  readonly installs: readonly SpriteInstall[];
}

/** Where a lump ends up: sprite index, frame index and rotation slot. */
export interface LumpSite {
  /** Index into {@link SpriteCensus.sprites}. */
  readonly sprite: number;
  /** Frame index (`'A'`-based). */
  readonly frame: number;
  /** 0-based rotation *slot* (`sprframe.lump[rot]` index); rot=0 lumps use 0. */
  readonly rot: number;
  /** Mirror flag for that slot. */
  readonly flip: boolean;
}

/** Result of a sprite census. */
export interface SpriteCensus {
  /** All sprites found, in first-lump order (stable). */
  readonly sprites: SpriteDef[];
  /** 4CC → def; insertion order matches {@link SpriteCensus.sprites}. */
  readonly byName: Map<string, SpriteDef>;
  /** Lump → its primary site (the non-mirrored one when a name has both). */
  readonly lumpToSprite: Map<number, LumpSite>;
  /** Lump → every site it was installed at (8-char mirrored names: two). */
  readonly lumpSites: Map<number, readonly LumpSite[]>;
  /** Human-readable tolerance notes; empty for a clean WAD. */
  readonly warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Lump-name grammar                                                   */
/* ------------------------------------------------------------------ */

const SPRITE_4CC = /^[A-Z0-9]{4}$/;

/** Frame letter → index; throws for anything outside `A`-`Z` (hence ≥ 29). */
function parseFrameLetter(source: string, at: number, what: string): number {
  const ch = source[at] as string;
  if (ch < 'A' || ch > 'Z') {
    throw new SpriteNameError(
      `'${source}': frame character '${ch}' at index ${at} is not A-Z for ${what}`,
    );
  }
  const frame = ch.charCodeAt(0) - 65;
  if (frame >= MAX_SPRITE_FRAMES) {
    throw new SpriteNameError(
      `'${source}': frame ${ch} (index ${frame}) >= ${MAX_SPRITE_FRAMES} for ${what}`,
    );
  }
  return frame;
}

/** Rotation digit; `0` legal only for the plain (chars 4-5) pair. */
function parseRotationDigit(source: string, at: number, what: string): number {
  const ch = source[at] as string;
  if (ch < '0' || ch > '9') {
    throw new SpriteNameError(
      `'${source}': rotation character '${ch}' at index ${at} is not 0-9 for ${what}`,
    );
  }
  const rotation = ch.charCodeAt(0) - 48;
  if (rotation > MAX_ROTATION_DIGIT) {
    throw new SpriteNameError(
      `'${source}': rotation ${rotation} > ${MAX_ROTATION_DIGIT} for ${what}`,
    );
  }
  return rotation;
}

/** Strip trailing NUL/space padding and fold case (lump names, R01 §15.2). */
function normalizeLumpName(name: string): string {
  const nul = name.indexOf('\u0000');
  return (nul >= 0 ? name.slice(0, nul) : name).trimEnd().toUpperCase();
}

/**
 * Parse a sprite lump name per R02 §8: `SSSSFR` (6 chars) or `SSSSFRfr`
 * (8 chars, the `fr` pair installed mirrored/flipped).
 *
 * Throws {@link SpriteNameError} for anything outside the grammar: wrong
 * length (a 7- or 9-char name cannot be a DOOM sprite name — the directory
 * name field is 8 bytes), a `#` variant suffix, a non-alphanumeric 4CC, a
 * frame letter outside A-Z, or a rotation digit outside 0-8.
 */
export function parseSpriteLumpName(name: string): SpriteLumpName {
  const src = normalizeLumpName(name);
  if (src.length === 0) {
    throw new SpriteNameError(`'${name}': empty lump name`);
  }
  if (src.includes('#')) {
    throw new SpriteNameError(
      `'${src}': '#' instance suffix (TROOA1#5 style) is not a vanilla sprite name`,
    );
  }
  if (src.length !== NAME_LEN_PLAIN && src.length !== NAME_LEN_PAIRED) {
    throw new SpriteNameError(
      `'${src}': expected ${NAME_LEN_PLAIN} (SSSSFR) or ${NAME_LEN_PAIRED} ` +
        `(SSSSFRfr) chars, got ${src.length}`,
    );
  }
  const name4 = src.slice(0, SPRITE_NAME_LEN);
  if (!SPRITE_4CC.test(name4)) {
    throw new SpriteNameError(`'${src}': sprite name '${name4}' is not 4 A-Z0-9 chars`);
  }
  const frame = parseFrameLetter(src, 4, 'frame');
  const rotation = parseRotationDigit(src, 5, 'rotation');
  const installs: SpriteInstall[] = [{ frame, rotation, flip: false }];
  if (src.length === NAME_LEN_PAIRED) {
    // Mirrored twin: chars 6-7 may name a *different* frame, and a digit 0
    // there means "this patch, mirrored, for all views" — vanilla keeps the
    // rotation==0 branch and just stores flip in all 8 slots (r_things.c:121-139).
    const mirrorFrame = parseFrameLetter(src, 6, 'mirror frame');
    const mirrorRotation = parseRotationDigit(src, 7, 'mirror rotation');
    installs.push({ frame: mirrorFrame, rotation: mirrorRotation, flip: true });
  }
  return { name4, installs };
}

/** Frame index → display letter (`0` → `'A'`). */
export function frameLetter(frame: number): string {
  return String.fromCharCode(65 + frame);
}

/* ------------------------------------------------------------------ */
/* Census                                                              */
/* ------------------------------------------------------------------ */

interface FrameAcc {
  /** Any lump seen for this frame. */
  touched: boolean;
  rotate: boolean;
  lump: number[];
  flip: number[];
}

interface SpriteAcc {
  readonly name4: string;
  readonly index: number;
  readonly frames: (FrameAcc | undefined)[];
}

function blankSlots(): LumpSlots {
  return [-1, -1, -1, -1, -1, -1, -1, -1];
}

function newFrameAcc(): FrameAcc {
  return { touched: false, rotate: true, lump: blankSlots(), flip: [0, 0, 0, 0, 0, 0, 0, 0] };
}

/**
 * Census `S_START..S_END` into per-sprite frame tables (vanilla
 * `R_InitSpriteDefs`, r_things.c:185-280, without the `I_Error`s).
 *
 * Lumps are visited in ascending lump order, sprites in first-appearance
 * order and frames in index order, so the result is deterministic. Every
 * frame slot keeps its `'A'`-based index: a frame with no lumps becomes an
 * all-(-1) entry (and a warning) instead of shifting later frames down.
 */
export function buildSpriteDefs(wad: WadFile): SpriteCensus {
  const warnings: string[] = [];
  const sprites = new Map<string, SpriteAcc>();
  const lumpSites = new Map<number, LumpSite[]>();
  const lumpToSprite = new Map<number, LumpSite>();

  const spriteFor = (name4: string): SpriteAcc => {
    const seen = sprites.get(name4);
    if (seen !== undefined) {
      return seen;
    }
    const fresh: SpriteAcc = {
      name4,
      index: sprites.size,
      frames: [],
    };
    sprites.set(name4, fresh);
    return fresh;
  };

  const frameFor = (sprite: SpriteAcc, frame: number): FrameAcc => {
    const acc = sprite.frames[frame];
    if (acc !== undefined) {
      return acc;
    }
    const fresh = newFrameAcc();
    sprite.frames[frame] = fresh;
    return fresh;
  };

  for (const lumpnum of wad.lumpRange(SPRITE_START_MARKER, SPRITE_END_MARKER)) {
    const lumpName = wad.lumpName(lumpnum);
    let parsed: SpriteLumpName;
    try {
      parsed = parseSpriteLumpName(lumpName);
    } catch (err) {
      // Only SpriteNameError can escape parseSpriteLumpName; String() keeps
      // the census alive even if a future parser throws something else.
      const detail = err instanceof SpriteNameError ? err.message : String(err);
      warnings.push(`lump ${lumpnum} '${lumpName}': ${detail}`);
      continue;
    }

    const sprite = spriteFor(parsed.name4);
    const sites: LumpSite[] = [];

    for (const install of parsed.installs) {
      const acc = frameFor(sprite, install.frame);
      const label = `${parsed.name4} frame ${frameLetter(install.frame)}`;

      if (install.rotation === 0) {
        if (acc.touched) {
          // r_things.c:122-133 — rot=0 lump in a rotating frame (or twice).
          warnings.push(
            `lump ${lumpnum} '${lumpName}': ${label} ${
              acc.rotate ? 'has rotations and a rot=0 lump' : 'has multip rot=0 lump'
            }`,
          );
          continue;
        }
        acc.rotate = false;
        for (let r = 0; r < NUM_ROTATIONS; r++) {
          acc.lump[r] = lumpnum;
          acc.flip[r] = install.flip ? 1 : 0;
        }
        acc.touched = true;
        sites.push({ sprite: sprite.index, frame: install.frame, rot: 0, flip: install.flip });
        continue;
      }

      if (acc.touched && !acc.rotate) {
        warnings.push(`lump ${lumpnum} '${lumpName}': ${label} has rotations and a rot=0 lump`);
        continue;
      }
      acc.rotate = true;
      acc.touched = true;

      const slot = install.rotation - 1;
      const held = acc.lump[slot] as number;
      if (held !== -1 && held !== lumpnum) {
        // r_things.c:146-151 "has two lumps mapped to it"; first install wins.
        warnings.push(
          `lump ${lumpnum} '${lumpName}': ${label} rotation ${install.rotation} ` +
            `already has lump ${held}`,
        );
        continue;
      }
      acc.lump[slot] = lumpnum;
      acc.flip[slot] = install.flip ? 1 : 0;
      sites.push({
        sprite: sprite.index,
        frame: install.frame,
        rot: slot,
        flip: install.flip,
      });
    }

    if (sites.length > 0) {
      lumpSites.set(lumpnum, sites);
      lumpToSprite.set(lumpnum, sites.find((site) => !site.flip) ?? (sites[0] as LumpSite));
    }
  }

  const defs: SpriteDef[] = [];
  const byName = new Map<string, SpriteDef>();
  for (const sprite of sprites.values()) {
    const frames: SpriteDef['frames'] = [];
    for (let frame = 0; frame < sprite.frames.length; frame++) {
      const acc = sprite.frames[frame];
      if (acc === undefined || !acc.touched) {
        // Vanilla I_Error "No patches found"; keep the index, drop the pixel.
        warnings.push(
          `sprite ${sprite.name4}: frame ${frameLetter(frame)} has no lumps ` +
            `(frames use index = letter - 'A', so a hole is preserved)`,
        );
        frames.push({ rotate: false, lump: blankSlots(), flip: new Uint8Array(NUM_ROTATIONS) });
        continue;
      }
      const lump = blankSlots();
      for (let r = 0; r < NUM_ROTATIONS; r++) lump[r] = acc.lump[r] as number;
      if (acc.rotate) {
        for (let r = 0; r < NUM_ROTATIONS; r++) {
          if (lump[r] === -1) {
            // Vanilla I_Error "is missing rotations" (r_things.c:251-270).
            warnings.push(
              `sprite ${sprite.name4}: frame ${frameLetter(frame)} ` +
                `is missing rotation ${r + 1}`,
            );
          }
        }
      }
      frames.push({
        rotate: acc.rotate,
        lump,
        flip: Uint8Array.from(acc.flip),
      });
    }
    const def: SpriteDef = { name4: sprite.name4, frames };
    defs.push(def);
    byName.set(sprite.name4, def);
  }

  return { sprites: defs, byName, lumpToSprite, lumpSites, warnings };
}
