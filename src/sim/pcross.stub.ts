// sim/pcross.stub.ts — counted P_CrossSpecialLine stub (M5-03).
//
// p_map.c's P_TryMove spechit loop ends every successful crossing with
//   P_CrossSpecialLine (ld-lines, oldside, thing);   // p_map.c:530
// The real dispatch (specials table, sector motion, triggers) is M6
// territory (M5-plan §0.10 / §M5-03). Until then this stub keeps the CALL
// SITE live: every crossed special line bumps a counter and, if a hook is
// registered (tests; M6's real dispatcher later), forwards
// (line, oldside, mover). Nothing else in p_map.c depends on the return
// value — P_CrossSpecialLine is `void` — so the counter is the only gap.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import type { Mover } from './pmap';

/** Hook slot; M6 replaces the registration with the real switch(). */
export interface PCrossHooks {
  /** p_map.c p_switch.c `P_CrossSpecialLine(linenum, side, thing)` —
   * `side` is the OLD side (p_map.c:530 passes oldside). */
  crossSpecialLine?: (line: number, side: number, thing: Mover) => void;
}

export const pcrossHooks: PCrossHooks = {};

/** Counted no-op bookkeeping (reset in tests; not sim state — hashes
 * never read it, matching the pmapHookCounts convention). */
export const pcrossCounts = { crossSpecialLine: 0 };

export function resetPcrossCounts(): void {
  pcrossCounts.crossSpecialLine = 0;
}

/** The call-site entry point pmap.ts invokes instead of the M6 function. */
export function pCrossSpecialLineStub(line: number, side: number, thing: Mover): void {
  pcrossCounts.crossSpecialLine++;
  pcrossHooks.crossSpecialLine?.(line, side, thing);
}
