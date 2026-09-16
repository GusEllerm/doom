/**
 * Pure lump-classification and table-pagination helpers for the WAD debug
 * viewer (M1-08). DOM-free so vitest can cover it under the node
 * environment; the viewer DOM layer stays thin wiring.
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Size of a flat in bytes (64x64 indices, R02 §6). */
export const FLAT_BUDGET = 4096;

/** How the viewer previews a lump. */
export type LumpKind = 'flat' | 'patch' | 'sprite' | 'data' | 'marker';

/**
 * Classify a lump by name + directory size only (no byte inspection; the
 * caller refines 'patch' vs 'data' by attempting decodePatch, and overrides
 * with 'sprite' when the lump sits inside S_START..S_END).
 *
 * Rules (R01 §14, R02 §6/§8):
 *  - size 0                              → 'marker' (range markers)
 *  - flat-shaped name (starts with F) AND 4096 B → 'flat' (FLAT1_, F_, FF_, VV_, F_SKY1 …)
 *  - exactly 4096 B otherwise            → 'flat' candidate (patch attempt first)
 *  - everything else                     → 'data'
 */
export function classifyLump(name: string, size: number): LumpKind {
  if (size === 0) return 'marker';
  const upper = name.toUpperCase();
  if (size === FLAT_BUDGET) return 'flat';
  if (upper.startsWith('FONT') || upper.startsWith('S_START') || upper.startsWith('S_END')) {
    return 'data';
  }
  return 'data';
}

/** True when the name looks like a standard flat (F-prefixed: FLAT*, F_*, FF_*, VV_*). */
export function looksLikeFlatName(name: string): boolean {
  return /^F[0-9A-Z_]*$/i.test(name.toUpperCase());
}

/**
 * Header-only patch sanity check (does NOT walk posts; decodePatch remains
 * the authoritative test — call it in a try/catch). Checks: minimum length,
 * positive sane dimensions, and that the columnofs table itself fits inside
 * the lump. Post padding is 0-3 bytes (R01 §14), so columnofs values are NOT
 * generally 4-aligned (freedoom's AGB128_1 has offset 306); alignment is
 * therefore not tested here — decodePatch's per-column bounds check is.
 */
export function looksLikePatchHeader(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getInt16(0, true);
  const height = view.getInt16(2, true);
  if (width <= 0 || height <= 0 || width > 1024 || height > 4096) return false;
  if (bytes.length < 16 + width * 4) return false;
  for (let c = 0; c < Math.min(width, 4); c++) {
    const ofs = view.getUint32(16 + c * 4, true);
    if (ofs < 16 || ofs >= bytes.length) return false;
  }
  return true;
}

/** A one-line entry of the lump table. */
export interface LumpRow {
  readonly num: number;
  readonly name: string;
  readonly size: number;
  readonly kind: LumpKind;
}

/** Build the full table rows from parallel name/size accessors. */
export function buildRows(
  count: number,
  nameAt: (i: number) => string,
  sizeAt: (i: number) => number,
): LumpRow[] {
  const rows: LumpRow[] = [];
  for (let i = 0; i < count; i++) {
    const name = nameAt(i);
    const size = sizeAt(i);
    rows.push({ num: i, name, size, kind: classifyLump(name, size) });
  }
  return rows;
}

/** Case-insensitive substring filter on lump names (empty query = all). */
export function filterRows(rows: readonly LumpRow[], query: string): LumpRow[] {
  const q = query.trim().toUpperCase();
  if (q === '') return rows.slice();
  return rows.filter((r) => r.name.toUpperCase().includes(q));
}

/** Paging window over a filtered list. */
export interface Page {
  readonly start: number;
  readonly end: number; // exclusive
  readonly page: number; // 0-based
  readonly pageCount: number;
}

/**
 * Slice [start,end) for `page` (clamped into range) with pageSize entries
 * per page; an empty list still reports page 0 of 1 with an empty window.
 */
export function pageSlice(length: number, page: number, pageSize: number): Page {
  const pageCount = Math.max(1, Math.ceil(length / pageSize));
  const p = Math.min(Math.max(0, Math.trunc(page)), pageCount - 1);
  const start = p * pageSize;
  return { start, end: Math.min(length, start + pageSize), page: p, pageCount };
}

/** Format one byte range as hex+ASCII lines (16 bytes per row). */
export function hexDump(bytes: Uint8Array, limit = 2048): string {
  const n = Math.min(bytes.length, limit);
  const lines: string[] = [];
  for (let off = 0; off < n; off += 16) {
    let hex = '';
    let ascii = '';
    for (let i = 0; i < 16; i++) {
      const b = off + i < n ? (bytes[off + i] as number) : -1;
      hex += b < 0 ? '   ' : b.toString(16).padStart(2, '0') + ' ';
      ascii += b < 0 || (b >= 32 && b < 127) ? String.fromCharCode(b < 0 ? 32 : b) : '.';
    }
    lines.push(`${off.toString(16).padStart(6, '0')}  ${hex} |${ascii}|`);
  }
  if (bytes.length > n) lines.push(`... (${bytes.length - n} more bytes)`);
  return lines.join('\n');
}
