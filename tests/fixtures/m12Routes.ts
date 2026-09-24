/**
 * M12-03 — deterministic scripted REACHABLE-EXIT ROUTES for all nine E1 maps
 * (docs/design/M12-plan.md §M12-03). Each route is a trigger CHAIN: waypoints
 * are derived AT RUNTIME from the linedef geometry (the stand point sits on
 * the line's FRONT side, offset along the front normal, facing the line —
 * the m9-flow stage-6 "warp + scripted USE" convention), and every trigger
 * the chain touches must VISIBLY MOVE something (the sector-movement ledger
 * in tests/headless/routes.test.ts is the anti-B-11 teeth).
 *
 * Line indices/specials are pinned against drift (the runner asserts
 * lines.special[line] === special before touching it — the m9-flow
 * EXIT_ROUTE drift-guard convention, scaled to the whole route).
 *
 * Waypoint stand-points and front/back sector ids were derived from the
 * pinned wads/freedoom1.wad lumps (pure scan, scripts/map-census.mjs
 * lineage). Card doors: the card grant rides the player inventory directly
 * (the M6-11 debug giveCard channel at sim level) — the DOOR movement is
 * the assertion, the key-grab walk is not the subject.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

/** One trigger the route touches. `kind`:
 *  - 'use':  stand front, scripted USE presses (manual/locked/S1/SR)
 *  - 'cross': stand front, scripted WALK across (W1/GR)
 *  - 'exit-use' / 'exit-cross': the terminal exit trigger (S1 11 / W1 52 /
 *    S1-secret 51 — the 51 variant is the documented BONUS run, not gated).
 * `tag`: sectors that must move (via sectorsWithTag). Door kinds with no tag
 * move their OWN back sector (the door sector) — expected automatically. */
export interface RouteTrigger {
  readonly line: number;
  readonly special: number;
  readonly kind: 'use' | 'cross' | 'exit-use' | 'exit-cross' | 'secret-use';
  readonly tag?: number;
  readonly card?: 'blue' | 'yellow' | 'red';
  /** override for the computed stand point (problem corners only) */
  readonly stand?: { x: number; y: number };
  readonly note?: string;
}

export interface MapRoute {
  readonly map: string;
  /** terminal-exit trigger kinds are the LAST entry (or `secret` bonus) */
  readonly triggers: readonly RouteTrigger[];
  /** documented-bonus secret exit (route reaches it; not gated) */
  readonly secret?: RouteTrigger;
  readonly note?: string;
}

export const M12_ROUTES: Readonly<Record<string, MapRoute>> = {
  E1M1: {
    map: 'E1M1',
    triggers: [
      { line: 594, special: 62, kind: 'use', tag: 1, note: 'SR lift shaft (sec 98)' },
      { line: 421, special: 26, kind: 'use', card: 'blue', note: 'blue door (sec 71)' },
      { line: 407, special: 11, kind: 'exit-use', note: 'S1 exit switch (m9-flow EXIT_ROUTE line)' }
    ]
  },
  E1M2: {
    map: 'E1M2',
    note: 'tag-14 blazing plat = B-11 (docs/BUGS.md) — kept in the chain ON PURPOSE: it must move or the route is red (BLOCKED-BY B-11)',
    triggers: [
      { line: 797, special: 123, kind: 'use', tag: 19, note: 'SR plat blaze DWUS (sec 64)' },
      { line: 350, special: 123, kind: 'use', tag: 14, note: 'B-11 blazing plat (sec 124)' },
      { line: 260, special: 26, kind: 'use', card: 'blue', note: 'blue door (sec 54)' },
      { line: 147, special: 28, kind: 'use', card: 'red', note: 'red door (sec 29)' },
      { line: 737, special: 11, kind: 'exit-use', note: 'S1 exit switch' }
    ]
  },
  E1M3: {
    map: 'E1M3',
    triggers: [
      { line: 261, special: 62, kind: 'use', tag: 1, note: 'SR lift (sec 47)' },
      { line: 763, special: 62, kind: 'use', tag: 12, note: 'SR lift (sec 161)' },
      { line: 933, special: 20, kind: 'use', tag: 16, note: 'S1 plat raise&change (sec 146)' },
      { line: 1367, special: 11, kind: 'exit-use', note: 'S1 exit switch (tag 15)' }
    ],
    secret: { line: 993, special: 51, kind: 'secret-use', note: 'S1 secret exit — documented bonus' }
  },
  E1M4: {
    map: 'E1M4',
    triggers: [
      { line: 326, special: 62, kind: 'use', tag: 1, note: 'SR lift shaft (sec 33)' },
      { line: 267, special: 27, kind: 'use', card: 'yellow', note: 'yellow door (sec 28)' },
      { line: 1205, special: 27, kind: 'use', card: 'yellow', note: 'yellow door (sec 172)' },
      { line: 1996, special: 11, kind: 'exit-use', note: 'S1 exit switch' }
    ]
  },
  E1M5: {
    map: 'E1M5',
    triggers: [
      { line: 463, special: 117, kind: 'use', note: 'blaze-raise manual door (sec 212)' },
      { line: 989, special: 123, kind: 'use', tag: 3, note: 'SR plat blaze (sec 178)' },
      { line: 654, special: 62, kind: 'use', tag: 2, note: 'SR lift shaft (sec 105)' },
      { line: 634, special: 11, kind: 'exit-use', note: 'S1 exit switch' }
    ],
    note: 'no secret exit exists in E1M5 (map-data truth: zero 51/124 lines)'
  },
  E1M6: {
    map: 'E1M6',
    triggers: [
      { line: 512, special: 62, kind: 'use', tag: 14, note: 'SR lift shaft (sec 363)' },
      { line: 1530, special: 20, kind: 'use', tag: 1, note: 'S1 plat raise&change (sec 142)' },
      { line: 1464, special: 103, kind: 'use', tag: 3, note: 'S1 door open (sec 56)' },
      { line: 118, special: 28, kind: 'use', card: 'red', note: 'red door (sec 138)' },
      { line: 1546, special: 11, kind: 'exit-use', note: 'S1 exit switch' }
    ]
  },
  E1M7: {
    map: 'E1M7',
    triggers: [
      { line: 2882, special: 123, kind: 'use', tag: 11, note: 'SR plat blaze (sec 488)' },
      { line: 1428, special: 62, kind: 'use', tag: 21, note: 'SR lift (sec 236)' },
      { line: 946, special: 23, kind: 'use', tag: 39, note: 'S1 lower-to-lowest (secs 110/176/278)' },
      { line: 1309, special: 28, kind: 'use', card: 'red', note: 'red door (sec 225)' },
      { line: 1436, special: 11, kind: 'exit-use', note: 'S1 exit switch (16-unit slot line)' }
    ]
  },
  E1M8: {
    map: 'E1M8',
    note: 'FREEDOOM E1M8 DATA TRUTH: zero barons, zero sector-special-11 sectors (vanilla lore does not apply); the exit is the W1-cross ring around the central chamber. Tag-666 W1 lower (L894, diagonal) omitted: sealed sector 3 has no lowerable neighbour — see route report.',
    triggers: [
      { line: 606, special: 19, kind: 'cross', tag: 3, note: 'W1 floor lower (secs 50/52/55/67)' },
      { line: 408, special: 19, kind: 'cross', tag: 1, note: 'W1 floor lower (secs 36/37/38/41)' },
      { line: 166, special: 52, kind: 'exit-cross', note: 'W1 exit ring into the central chamber' }
    ]
  },
  E1M9: {
    map: 'E1M9',
    note: 'five barons (doomednum 59) at ~ (1728..1856, 2784) are NOT on the exit route (E1M9 has no A_BossDeath rule)',
    triggers: [
      { line: 576, special: 62, kind: 'use', tag: 25, note: 'SR lift (sec 121)' },
      { line: 603, special: 103, kind: 'use', tag: 6, note: 'S1 door open (secs 159/160/169)' },
      { line: 706, special: 62, kind: 'use', tag: 3, note: 'SR lift shaft (sec 187)' },
      { line: 1659, special: 27, kind: 'use', card: 'yellow', note: 'yellow door guarding the exit (sec 51)' },
      { line: 1662, special: 11, kind: 'exit-use', note: 'S1 exit switch' }
    ]
  }
};

export const E1_ROUTE_MAPS = Object.keys(M12_ROUTES);

/** Card inventory slot order (player.ts IT_* constants). */
export const CARD_SLOT: Record<'blue' | 'yellow' | 'red', number> = {
  blue: 0, // IT_BLUECARD
  yellow: 1, // IT_YELLOWCARD
  red: 2 // IT_REDCARD
};

/**
 * Front-side stand point + facing angle for a trigger line, computed from
 * the linedef geometry: the FRONT (side0) is on the RIGHT of v1→v2, so
 * stand = mid + rightNormal*offset and facing = dir rotated +90° (toward the
 * line). Angle degrees: 0=E, 90=N (atan2 convention of the port).
 */
export function frontStand(
  x1: number, y1: number, x2: number, y2: number, offset: number,
  override?: { x: number; y: number }
): { x: number; y: number; angleDeg: number } {
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  // right normal of (dx,dy) is (dy,-dx)
  const rn = { x: dy / len, y: -dx / len };
  const x = override?.x ?? mx + rn.x * offset;
  const y = override?.y ?? my + rn.y * offset;
  // facing = -rightNormal (toward the line)
  const angleDeg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return { x, y, angleDeg: (angleDeg + 360) % 360 };
}
