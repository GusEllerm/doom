/**
 * In-memory WAD writer for test fixtures (M1-05, first half of T01).
 *
 * Produces tiny, deterministic, structurally valid IWAD/PWAD byte streams
 * with zero external content (PROMPT §8, ARCHITECTURE §6.1). Byte layout is
 * R01 §1-2: 12-byte header (no padding field), lump data starting at offset
 * 12 each padded to an EVEN next-offset with 0 or 1 NUL byte (id-tooling
 * convention; parsers, including ours, rely on no more than "lumps live
 * wherever the dir says"), and a 16-byte-per-entry directory appended at the
 * end with NUL-padded 8-byte names (freedoom style, R01 §2/§14).
 *
 * This is the base for M2's rectangle-map generator: entries are recorded in
 * insertion order and all offsets are computed in build() (nothing is
 * patched afterwards), so the map builder can append lumps then build once.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

const HEADER_SIZE = 12;
const DIR_ENTRY_SIZE = 16;
const NAME_FIELD_SIZE = 8;

/** One declared lump; absent/undefined data means a zero-size marker. */
export interface WadLumpSource {
  name: string;
  data?: Uint8Array;
}

interface BuilderEntry {
  name: string;
  data: Uint8Array;
}

const EMPTY = new Uint8Array(0);

function normalizeName(name: string): string {
  if (name.length === 0 || name.length > NAME_FIELD_SIZE) {
    throw new RangeError(`WAD lump name must be 1..8 chars, got ${JSON.stringify(name)}`);
  }
  return name.toUpperCase();
}

/**
 * Deterministic WAD assembler. Lumps appear in the directory exactly in the
 * order added (duplicates allowed — parser resolves last-wins, R01 §2);
 * offsets are computed at build time, never before.
 */
export class WadBuilder {
  readonly identification: 'IWAD' | 'PWAD';
  private readonly entries: BuilderEntry[] = [];

  constructor(identification: 'IWAD' | 'PWAD' = 'IWAD') {
    this.identification = identification;
  }

  /** Append a data lump; auto 0/1-byte NUL padding keeps the NEXT offset even. */
  addLump(name: string, data: Uint8Array): this {
    this.entries.push({ name: normalizeName(name), data });
    return this;
  }

  /** Append a zero-size marker lump (offset = current even cursor). */
  addLumpMarker(name: string): this {
    return this.addLump(name, EMPTY);
  }

  /** Insertion-ordered view of what has been added (data lengths only copy-free). */
  get lumps(): readonly Readonly<BuilderEntry>[] {
    return this.entries;
  }

  /** Full file bytes: header, padded data run, directory. Stable ordering. */
  build(): Uint8Array {
    const offsets: number[] = [];
    let cursor = HEADER_SIZE;
    for (const entry of this.entries) {
      offsets.push(cursor);
      cursor += entry.data.length;
      if (cursor % 2 !== 0) cursor += 1; // 0/1-byte even padding
    }
    const infotableofs = cursor;
    const bytes = new Uint8Array(infotableofs + this.entries.length * DIR_ENTRY_SIZE);
    const view = new DataView(bytes.buffer);

    for (let i = 0; i < 4; i++) bytes[i] = this.identification.charCodeAt(i);
    view.setInt32(4, this.entries.length, true);
    view.setInt32(8, infotableofs, true);

    this.entries.forEach((entry, i) => {
      bytes.set(entry.data, offsets[i]!);
      const dir = infotableofs + i * DIR_ENTRY_SIZE;
      view.setInt32(dir, offsets[i]!, true);
      view.setInt32(dir + 4, entry.data.length, true);
      for (let c = 0; c < entry.name.length; c++) {
        bytes[dir + 8 + c] = entry.name.charCodeAt(c); // rest stays NUL padding
      }
    });
    return bytes;
  }
}

/**
 * Convenience one-shot API kept source-compatible with the ARCHITECTURE §6.1 /
 * M1-plan generator contract (the future `maps:` variant lands with M2-02).
 */
export function buildWad(
  lumps: WadLumpSource[],
  identification: 'IWAD' | 'PWAD' = 'IWAD',
): ArrayBuffer {
  const builder = new WadBuilder(identification);
  for (const lump of lumps) {
    builder.addLump(lump.name, lump.data ?? EMPTY);
  }
  const bytes = builder.build();
  return bytes.buffer as ArrayBuffer;
}
