/**
 * dehacked.ts — DEHACKED lump parser (M8-10 stub; see docs/design/M8-plan.md
 * §M8-10 / D-0xx, A-02 / D008 fullbright cross-cut).
 *
 * STUB: signatures only, throws until implemented in this task's follow-up
 * commits.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** Parsed-but-not-applied DEHACKED lump (stub). */
export interface DehackedLump {
  readonly text: string;
}

/** Parse a DEHACKED lump (stub). */
export function parseDehacked(_bytes: Uint8Array): DehackedLump {
  throw new Error('M8-10: not implemented');
}
