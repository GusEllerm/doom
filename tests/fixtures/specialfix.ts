/**
 * M6-13 — L2 SPECIAL CORPUS fixture generator (M6-plan §M6-13 "family rooms
 * incl. switch textures, keyed-door corridor, teleport pair rooms").
 *
 * EVERYTHING here is DERIVED FROM THE REGISTRY (specials-table.ts is the
 * data, this file only translates DATA → GEOMETRY): a scenario spec per
 * line special (host room + tagged family room + trigger line, switch
 * marker texture on the switch-gated routes) and per sector special (feet
 * room with that special). No per-id manual list exists anywhere in the
 * corpus — tests/headless/specials.test.ts iterates registryManifest().
 *
 * Geometry constants are chosen so every mover family can SUCCEED (see the
 * `geo` table comments — each family's vanilla "would the action no-op"
 * check is defeated by construction: void-dummy floor -128 gives every
 * plat/floor a lowest-surrounding, host A f8/c160 gives raiseFloor /
 * raiseToHighest a destination above the tagged room, the stair ring
 * removes the void from the tagged sector's surroundings, the donut center
 * gets a genuine lower surround, the light room's tagged sector starts
 * dark so turn-on/off are observable).
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import { LINE_SPECIALS, SECTOR_SPECIALS, registryManifest } from '../../src/sim/specials-table';
import type { ActionId } from '../../src/sim/specials-table';

import { TEX_SWITCH_OFF, THING_TELEPORT_DEST } from './m6Fixtures';
import type { LineTriggerSpec, RectMapSpec, RectRoomSpec, ThingSpec } from './mapBuilder';

/* ------------------------------------------------------------------ */
/* Constants shared by the corpus runner                               */
/* ------------------------------------------------------------------ */

/** Tag of the corpus "target" sector (never 0: the 0-tag manual door path
 * would resolve to the trigger's own front sector). */
export const CORPUS_TAG = 7;

/** Corpus host room: floor 8, ceiling 160 — a raiseFloor / raiseToHighest
 * DESTINATION above the tagged room (vanilla returns false when
 * dest == the moving sector's own height). */
const HOST: RectRoomSpec = { x: 0, y: 0, w: 256, h: 256, floorHeight: 8, ceilingHeight: 160 };

/** Standard tagged target room (family geometry overrides per kind). */
const TAGGED: RectRoomSpec = {
  x: 256, y: 0, w: 256, h: 256, floorHeight: 0, ceilingHeight: 128, tag: CORPUS_TAG
};

/** The player 1 start (doomednum 1) in the host room. */
const PLAYER_START: ThingSpec = { x: 128, y: 128, angle: 0, type: 1 };

/** The shared A/B boundary segment the trigger line sits on. */
const TRIG_SEGMENT = { x1: 256, y1: 96, x2: 256, y2: 160 };

/* ------------------------------------------------------------------ */
/* Registry → geometry / trigger translation (kind table)              */
/* ------------------------------------------------------------------ */

/** The route kinds of a line special (registry-derived; every id has
 * exactly one route — manifest.lineRouteCounts.multiRoute === 0 — plus the
 * spawn-only scroll flag). */
export function lineKinds(special: number): { action: ActionId; arg: number; amount: number }[] {
  const e = LINE_SPECIALS[special];
  if (!e) return [];
  const t = e.use ?? e.cross ?? e.shoot;
  return t ? t.actions.map((a) => ({ action: a.action, arg: a.arg ?? 0, amount: a.amount ?? 0 })) : [];
}

export function lineRoute(special: number): 'use' | 'cross' | 'shoot' | 'scroll' | null {
  const e = LINE_SPECIALS[special];
  if (!e) return null;
  if (e.use) return 'use';
  if (e.cross) return 'cross';
  if (e.shoot) return 'shoot';
  if (e.scroll) return 'scroll';
  return null;
}

/** The six locked MANUAL ids (pdoors.ts: 26/32 blue, 27/34 yellow,
 * 28/33 red — card OR skull) and the locked BUTTON ids (pswitch.ts:
 * 99/133 blue, 134/135 red, 136/137 yellow). Keyed off the SOURCE lock
 * switches, applied mechanically to the ids that carry them. */
export const LOCKED_MANUAL_CARDS: Readonly<Record<number, readonly [card: number, skull: number]>> =
  Object.freeze({
    26: [0, 3], 32: [0, 3], 27: [1, 4], 34: [1, 4], 28: [2, 5], 33: [2, 5]
  });
export const LOCKED_BUTTON_CARDS: Readonly<Record<number, readonly [card: number, skull: number]>> =
  Object.freeze({
    99: [0, 3], 133: [0, 3], 134: [2, 5], 135: [2, 5], 136: [1, 4], 137: [1, 4]
  });

export function lockedCardsFor(special: number): readonly [number, number] | null {
  return LOCKED_MANUAL_CARDS[special] ?? LOCKED_BUTTON_CARDS[special] ?? null;
}

/** Pre-arm movers (crushStop / stopPlat remove something that must first
 * EXIST): cross-triggered starters, registry-data-driven by id. */
export const PRE_ARM_CROSS: Readonly<Record<number, number>> = Object.freeze({
  57: 6, 74: 6, // EV_CeilingCrushStop ← W1 fastCrushAndRaise (cross 6)
  54: 10, 89: 10 // EV_StopPlat           ← W1 platDownWaitUpStay (cross 10)
});

/* ------------------------------------------------------------------ */
/* Line scenario specs                                                 */
/* ------------------------------------------------------------------ */

export interface LineScenarioSpec {
  readonly spec: RectMapSpec;
  /** Trigger specials present in spec order (line indices are found at
   * runtime by scanning lines.special). */
  readonly triggerSpecials: readonly number[];
}

/**
 * Build the two-room (+ extras for stairs/donut) fixture map for one line
 * special. `special` may additionally be a PRE-ARM cross starter (6/10) —
 * those ids get their own ordinary spec too.
 */
export function lineScenarioSpec(special: number): LineScenarioSpec {
  const kinds = lineKinds(special);
  const kind = kinds[0]?.action ?? 'scroll';
  const route = lineRoute(special);
  const entry = LINE_SPECIALS[special]!;

  // Family geometry --------------------------------------------------
  let host: RectRoomSpec = HOST;
  let tagged: RectRoomSpec = { ...TAGGED };
  let extraRooms: readonly RectRoomSpec[] = [];
  let things: readonly ThingSpec[] | undefined = [PLAYER_START];
  const triggerTag = route === 'use' && (kind === 'verticalDoor') ? CORPUS_TAG : CORPUS_TAG;

  switch (kind) {
    case 'stairs': {
      // Stair ring: tagged B shares EVERY edge (no void surrounding) with
      // f8 rooms + a 4-step ascending chain {8,16,24,32} — P_FindLowest-
      // FloorSurrounding(B) = 8 ≠ 0 spawns, the chain gives FindNext-
      // LowestFloor successors.
      tagged = { ...TAGGED, ceilingHeight: 160 };
      extraRooms = [
        { x: 256, y: 256, w: 256, h: 64, floorHeight: 8, ceilingHeight: 160 }, // north
        { x: 256, y: -64, w: 256, h: 64, floorHeight: 8, ceilingHeight: 160 }, // south
        { x: 512, y: 0, w: 128, h: 64, floorHeight: 8, ceilingHeight: 160 },
        { x: 512, y: 64, w: 128, h: 64, floorHeight: 16, ceilingHeight: 160 },
        { x: 512, y: 128, w: 128, h: 64, floorHeight: 24, ceilingHeight: 160 },
        { x: 512, y: 192, w: 128, h: 64, floorHeight: 32, ceilingHeight: 160 }
      ];
      break;
    }
    case 'donut': {
      // Donut: TAGGED = the raised CENTER (f64); its surroundings
      // (host f8 + E/S/N rooms f0) give BOTH P_FindLowest{Floor,Ceiling}-
      // Surrounding a genuine answer below/above (EV_DoDonut spawns plat +
      // floor movers). The trigger sits on the host↔center edge.
      host = HOST;
      tagged = { x: 256, y: 64, w: 128, h: 128, floorHeight: 64, ceilingHeight: 160, tag: CORPUS_TAG };
      extraRooms = [
        { x: 384, y: 64, w: 128, h: 128, floorHeight: 0, ceilingHeight: 160 },
        { x: 256, y: 192, w: 128, h: 64, floorHeight: 0, ceilingHeight: 160 },
        { x: 256, y: 0, w: 128, h: 64, floorHeight: 0, ceilingHeight: 160 },
        { x: 384, y: 0, w: 128, h: 64, floorHeight: 0, ceilingHeight: 160 },
        { x: 384, y: 192, w: 128, h: 64, floorHeight: 0, ceilingHeight: 160 }
      ];
      break;
    }
    case 'teleport': {
      // Teleport destination (doomednum 14) inside the tagged room — the
      // per-sector destination list P_EvTeleport draws from.
      things = [PLAYER_START, { x: 384, y: 128, angle: 90, type: THING_TELEPORT_DEST }];
      break;
    }
    case 'lightOn':
    case 'lightsOff':
    case 'strobe': {
      tagged = { ...tagged, lightLevel: 64 }; // dark: on/off both observable
      break;
    }
    default:
      break;
  }

  // Trigger line -----------------------------------------------------
  const triggerTexture =
    route === 'use' || route === 'shoot'
      ? (entry.use?.gateSwitch !== undefined || entry.use?.thenSwitch !== undefined ||
         entry.use?.switchBefore !== undefined || entry.shoot?.thenSwitch !== undefined)
        ? TEX_SWITCH_OFF
        : undefined
      : undefined;
  const triggers: LineTriggerSpec[] = [];
  const preArm = PRE_ARM_CROSS[special];
  if (preArm !== undefined) {
    // Pre-arm starter line first (own segment on the shared edge), then
    // the scenario trigger.
    triggers.push({ x1: 256, y1: 24, x2: 256, y2: 64, special: preArm, tag: CORPUS_TAG });
  }
  triggers.push({
    ...TRIG_SEGMENT,
    special,
    tag: kind === 'verticalDoor' || kind === 'lockedDoor' ? 0 : triggerTag,
    ...(triggerTexture ? { texture: triggerTexture } : {})
  });

  const rooms: RectRoomSpec[] = [host, tagged, ...extraRooms.filter((r) =>
    // the donut tagged room REPLACES the default tagged rectangle
    !(kind === 'donut' && r.x === tagged.x && r.y === tagged.y)
  )];
  return { spec: { rooms, triggers, things }, triggerSpecials: triggers.map((t) => t.special!) };
}

/* ------------------------------------------------------------------ */
/* Sector scenario specs                                               */
/* ------------------------------------------------------------------ */

/**
 * One room carrying the sector special with the player 1 start INSIDE it
 * (grounded feet dispatch, z == floorZ from spawn), plus a neighbouring
 * corridor room so light families have a bright surrounding (192 default)
 * and the spawner's sector is not the void-walled single room.
 */
export function sectorScenarioSpec(special: number): LineScenarioSpec {
  const room: RectRoomSpec = {
    x: 0, y: 0, w: 256, h: 256, floorHeight: 0, ceilingHeight: 128, special
  };
  const corridor: RectRoomSpec = { x: 256, y: 0, w: 128, h: 256, floorHeight: 0, ceilingHeight: 128 };
  return {
    spec: { rooms: [room, corridor], things: [{ x: 128, y: 128, angle: 0, type: 1 }] },
    triggerSpecials: []
  };
}

/* ------------------------------------------------------------------ */
/* Corpus census (machine: registry iteration only)                    */
/* ------------------------------------------------------------------ */

export interface CorpusCensus {
  readonly lineSpecials: readonly number[];
  readonly sectorSpecials: readonly number[];
  /** line ids whose route actions ALL resolve to the door-family entry
   * points (evDoDoor / evVerticalDoor / pSpawnDoor*) — the M6-05 BODY
   * never landed on main (pdoors.ts header "tracked as an M6-13
   * follow-up"); the corpus classifies them `stub-or-live` so the moment
   * the body re-lands the SAME table passes with the thinker class. */
  readonly doorFamilyLineIds: readonly number[];
  readonly doorFamilySectorIds: readonly number[];
}

export function corpusCensus(): CorpusCensus {
  const m = registryManifest();
  const doorKind = (a: ActionId): boolean => a === 'door' || a === 'verticalDoor' || a === 'lockedDoor';
  const doorLines = m.lineIds.filter((id) => {
    const t = LINE_SPECIALS[id]!;
    const acts = (t.use ?? t.cross ?? t.shoot)?.actions ?? [];
    return acts.length > 0 && acts.every((a) => doorKind(a.action));
  });
  const doorSectors = m.sectorIds.filter((id) => {
    const spawn = SECTOR_SPECIALS[id]?.spawn;
    return spawn?.action === 'doorCloseIn30' || spawn?.action === 'doorRaiseIn5Mins';
  });
  return {
    lineSpecials: m.lineIds,
    sectorSpecials: m.sectorIds,
    doorFamilyLineIds: doorLines,
    doorFamilySectorIds: doorSectors
  };
}
