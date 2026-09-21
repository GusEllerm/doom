// sim/a_actions.ts — ActionId registry (M7-01, M7-plan §M7-01). The states[]
// action column of info.c references 74 distinct A_* functions (plus
// NULL); 1.10 stores them as function pointers (actionf_t) shared by the
// mobj machine (acp1: (mobj)) and the psprite machine (acp2:
// (player,psprite)) — the SAME table drives both, so dispatch carries an
// opaque context and later tasks bind typed bodies (M7-02 mobj actions,
// M7-07 psprite actions). Numeric ids = order of FIRST APPEARANCE walking
// states[] top-to-bottom — deterministic, machine-checked against the table.
//
// M6-03 registry pattern: machine-checkable manifest + stub recorder keyed
// by id. Bodies arrive with later tasks via registerAction(); an unregistered
// id is a recorded no-op (not a crash — tables stay loadable before bodies
// exist); an UNKNOWN id (no such action in the source) throws, keeping the
// switch total (acceptance 2).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** ActionId 0 = no action ({NULL} in the states table). */
export const ACT_NONE = 0

/** ActionId constants — id vocabulary for states.ts's stateAction column. */
export const ACT = {
  NONE: 0,
  A_Light0:         1,
  A_WeaponReady:    2,
  A_Lower:          3,
  A_Raise:          4,
  A_Punch:          5,
  A_ReFire:         6,
  A_FirePistol:     7,
  A_Light1:         8,
  A_FireShotgun:    9,
  A_Light2:         10,
  A_FireShotgun2:   11,
  A_CheckReload:    12,
  A_OpenShotgun2:   13,
  A_LoadShotgun2:   14,
  A_CloseShotgun2:  15,
  A_FireCGun:       16,
  A_GunFlash:       17,
  A_FireMissile:    18,
  A_Saw:            19,
  A_FirePlasma:     20,
  A_BFGsound:       21,
  A_FireBFG:        22,
  A_BFGSpray:       23,
  A_Explode:        24,
  A_Pain:           25,
  A_PlayerScream:   26,
  A_Fall:           27,
  A_XScream:        28,
  A_Look:           29,
  A_Chase:          30,
  A_FaceTarget:     31,
  A_PosAttack:      32,
  A_Scream:         33,
  A_SPosAttack:     34,
  A_VileChase:      35,
  A_VileStart:      36,
  A_VileTarget:     37,
  A_VileAttack:     38,
  A_StartFire:      39,
  A_Fire:           40,
  A_FireCrackle:    41,
  A_Tracer:         42,
  A_SkelWhoosh:     43,
  A_SkelFist:       44,
  A_SkelMissile:    45,
  A_FatRaise:       46,
  A_FatAttack1:     47,
  A_FatAttack2:     48,
  A_FatAttack3:     49,
  A_BossDeath:      50,
  A_CPosAttack:     51,
  A_CPosRefire:     52,
  A_TroopAttack:    53,
  A_SargAttack:     54,
  A_HeadAttack:     55,
  A_BruisAttack:    56,
  A_SkullAttack:    57,
  A_Metal:          58,
  A_SpidRefire:     59,
  A_BabyMetal:      60,
  A_BspiAttack:     61,
  A_Hoof:           62,
  A_CyberAttack:    63,
  A_PainAttack:     64,
  A_PainDie:        65,
  A_KeenDie:        66,
  A_BrainPain:      67,
  A_BrainScream:    68,
  A_BrainDie:       69,
  A_BrainAwake:     70,
  A_BrainSpit:      71,
  A_SpawnSound:     72,
  A_SpawnFly:       73,
  A_BrainExplode:   74,
} as const
export type ActionId = (typeof ACT)[keyof typeof ACT]

/** NUM_ACTIONS includes NONE. */
export const NUM_ACTIONS = 75

/** id → source action name ('NONE' for 0) — the manifest backbone. */
export const ACTION_NAMES: readonly string[] = [
  'NONE',
  'A_Light0',
  'A_WeaponReady',
  'A_Lower',
  'A_Raise',
  'A_Punch',
  'A_ReFire',
  'A_FirePistol',
  'A_Light1',
  'A_FireShotgun',
  'A_Light2',
  'A_FireShotgun2',
  'A_CheckReload',
  'A_OpenShotgun2',
  'A_LoadShotgun2',
  'A_CloseShotgun2',
  'A_FireCGun',
  'A_GunFlash',
  'A_FireMissile',
  'A_Saw',
  'A_FirePlasma',
  'A_BFGsound',
  'A_FireBFG',
  'A_BFGSpray',
  'A_Explode',
  'A_Pain',
  'A_PlayerScream',
  'A_Fall',
  'A_XScream',
  'A_Look',
  'A_Chase',
  'A_FaceTarget',
  'A_PosAttack',
  'A_Scream',
  'A_SPosAttack',
  'A_VileChase',
  'A_VileStart',
  'A_VileTarget',
  'A_VileAttack',
  'A_StartFire',
  'A_Fire',
  'A_FireCrackle',
  'A_Tracer',
  'A_SkelWhoosh',
  'A_SkelFist',
  'A_SkelMissile',
  'A_FatRaise',
  'A_FatAttack1',
  'A_FatAttack2',
  'A_FatAttack3',
  'A_BossDeath',
  'A_CPosAttack',
  'A_CPosRefire',
  'A_TroopAttack',
  'A_SargAttack',
  'A_HeadAttack',
  'A_BruisAttack',
  'A_SkullAttack',
  'A_Metal',
  'A_SpidRefire',
  'A_BabyMetal',
  'A_BspiAttack',
  'A_Hoof',
  'A_CyberAttack',
  'A_PainAttack',
  'A_PainDie',
  'A_KeenDie',
  'A_BrainPain',
  'A_BrainScream',
  'A_BrainDie',
  'A_BrainAwake',
  'A_BrainSpit',
  'A_SpawnSound',
  'A_SpawnFly',
  'A_BrainExplode',
]

/* ------------------------------------------------------------------ */
/* Implementation slots (filled by later M7 tasks)                     */
/* ------------------------------------------------------------------ */

/** Action bodies take an opaque context; the CALLER's machine (mobj vs
 *  psprite dispatch site) owns the cast. Kept out of the table so wad/
 *  stays import-free (zone rule). */
export type ActionFn = (ctx: unknown) => void

/** The two state machines that dispatch state-table actions (M8-07
 *  id27 domain fix, docs/JOURNAL.md 2026-09-23 M8-06 note): vanilla stores
 *  function POINTERS per state row, so an action's identity is carried by
 *  the state DOMAIN of the row; our numeric id map is global and cannot
 *  encode that by construction. Bodies therefore register under the domain
 *  of the machine whose ctx contract they read ((mobj) vs (player,psp)),
 *  and a dispatch from the OTHER machine never executes them (recorded
 *  no-op instead). Table census (verified M8-07 on the generated states.ts
 *  SoA + the weaponinfo-reachable nextstate closure): pspr-reachable rows
 *  dispatch ids 1..22 only; mobj rows (≥ 90) never dispatch them — so
 *  today the domains are disjoint and this guard is regression insurance
 *  for the id27 double-identity (A_Fall in mobj states vs the weapon
 *  machine's id-27 slot), not a live-behavior change. */
export type ActionDomain = 'mobj' | 'pspr'

/** Domain-UNTAGGED slot (legacy/tests/harness probes): dispatchable from
 *  either machine — kept for the a_actions.test.ts contract and any
 *  registration that predates per-domain tagging. */
const impl: (ActionFn | undefined)[] = new Array<ActionFn | undefined>(NUM_ACTIONS).fill(undefined)
/** Bodies registered by the MOBJ machine (ctx casts to Mobj). */
const implMobj: (ActionFn | undefined)[] = new Array<ActionFn | undefined>(NUM_ACTIONS).fill(undefined)
/** Bodies registered by the WEAPON/psprite machine (ctx casts to PsprActionCtx). */
const implPspr: (ActionFn | undefined)[] = new Array<ActionFn | undefined>(NUM_ACTIONS).fill(undefined)

/** Stub recorder (M6-03 pattern): dispatch of a known-but-unregistered id is
 *  a counted no-op, so tests can enumerate exactly which actions a scenario
 *  needed but no task had provided yet. */
const unimplemented = new Map<string, number>()

/** Register (or replace) the body of an action id. `domain` binds the body
 *  to ONE machine (see ActionDomain); omitting it fills the domain-free
 *  slot (visible to both machines — test/harness use). Returns the id for
 *  chaining-style registration blocks in later tasks. */
export function registerAction(id: number, fn: ActionFn, domain?: ActionDomain): number {
  if (!Number.isInteger(id) || id < ACT_NONE || id >= NUM_ACTIONS) {
    throw new Error(`registerAction: unknown action id ${id}`)
  }
  if (domain === 'mobj') implMobj[id] = fn
  else if (domain === 'pspr') implPspr[id] = fn
  else impl[id] = fn
  return id
}

/** True when a body is bound (manifest/test surface). */
export function isActionRegistered(id: number): boolean {
  return (
    id > ACT_NONE &&
    id < NUM_ACTIONS &&
    (impl[id] !== undefined || implMobj[id] !== undefined || implPspr[id] !== undefined)
  )
}

/** Resolve the body for a dispatch from `domain` (undefined = either
 *  machine). Resolution order: same-domain body, then untagged body; a
 *  body claimed ONLY by the OTHER machine is never resolved (cross-domain
 *  guard → the counted no-op below). Untagged dispatch (legacy) prefers
 *  the untagged slot, then mobj, then pspr — deterministic order. */
function resolve(id: number, domain?: ActionDomain): ActionFn | undefined {
  if (domain === 'mobj') return implMobj[id] ?? (implPspr[id] === undefined ? impl[id] : undefined)
  if (domain === 'pspr') return implPspr[id] ?? (implMobj[id] === undefined ? impl[id] : undefined)
  return impl[id] ?? implMobj[id] ?? implPspr[id]
}

/** Dispatch a state-table action id (P_SetMobjState/P_SetPsprite call sites
 *  go through this once M7-02/07 wire the machines). The switch is TOTAL
 *  over the source vocabulary — ids outside it throw. Unregistered-but-known
 *  ids record and return (typed no-op). */
export function dispatchAction(id: number, ctx: unknown, domain?: ActionDomain): void {
  switch (id) {
    case 0: // NONE — {NULL} state, never dispatched
      return
    case 1: // A_Light0
      return run(id, ctx, domain)
    case 2: // A_WeaponReady
      return run(id, ctx, domain)
    case 3: // A_Lower
      return run(id, ctx, domain)
    case 4: // A_Raise
      return run(id, ctx, domain)
    case 5: // A_Punch
      return run(id, ctx, domain)
    case 6: // A_ReFire
      return run(id, ctx, domain)
    case 7: // A_FirePistol
      return run(id, ctx, domain)
    case 8: // A_Light1
      return run(id, ctx, domain)
    case 9: // A_FireShotgun
      return run(id, ctx, domain)
    case 10: // A_Light2
      return run(id, ctx, domain)
    case 11: // A_FireShotgun2
      return run(id, ctx, domain)
    case 12: // A_CheckReload
      return run(id, ctx, domain)
    case 13: // A_OpenShotgun2
      return run(id, ctx, domain)
    case 14: // A_LoadShotgun2
      return run(id, ctx, domain)
    case 15: // A_CloseShotgun2
      return run(id, ctx, domain)
    case 16: // A_FireCGun
      return run(id, ctx, domain)
    case 17: // A_GunFlash
      return run(id, ctx, domain)
    case 18: // A_FireMissile
      return run(id, ctx, domain)
    case 19: // A_Saw
      return run(id, ctx, domain)
    case 20: // A_FirePlasma
      return run(id, ctx, domain)
    case 21: // A_BFGsound
      return run(id, ctx, domain)
    case 22: // A_FireBFG
      return run(id, ctx, domain)
    case 23: // A_BFGSpray
      return run(id, ctx, domain)
    case 24: // A_Explode
      return run(id, ctx, domain)
    case 25: // A_Pain
      return run(id, ctx, domain)
    case 26: // A_PlayerScream
      return run(id, ctx, domain)
    case 27: // A_Fall
      return run(id, ctx, domain)
    case 28: // A_XScream
      return run(id, ctx, domain)
    case 29: // A_Look
      return run(id, ctx, domain)
    case 30: // A_Chase
      return run(id, ctx, domain)
    case 31: // A_FaceTarget
      return run(id, ctx, domain)
    case 32: // A_PosAttack
      return run(id, ctx, domain)
    case 33: // A_Scream
      return run(id, ctx, domain)
    case 34: // A_SPosAttack
      return run(id, ctx, domain)
    case 35: // A_VileChase
      return run(id, ctx, domain)
    case 36: // A_VileStart
      return run(id, ctx, domain)
    case 37: // A_VileTarget
      return run(id, ctx, domain)
    case 38: // A_VileAttack
      return run(id, ctx, domain)
    case 39: // A_StartFire
      return run(id, ctx, domain)
    case 40: // A_Fire
      return run(id, ctx, domain)
    case 41: // A_FireCrackle
      return run(id, ctx, domain)
    case 42: // A_Tracer
      return run(id, ctx, domain)
    case 43: // A_SkelWhoosh
      return run(id, ctx, domain)
    case 44: // A_SkelFist
      return run(id, ctx, domain)
    case 45: // A_SkelMissile
      return run(id, ctx, domain)
    case 46: // A_FatRaise
      return run(id, ctx, domain)
    case 47: // A_FatAttack1
      return run(id, ctx, domain)
    case 48: // A_FatAttack2
      return run(id, ctx, domain)
    case 49: // A_FatAttack3
      return run(id, ctx, domain)
    case 50: // A_BossDeath
      return run(id, ctx, domain)
    case 51: // A_CPosAttack
      return run(id, ctx, domain)
    case 52: // A_CPosRefire
      return run(id, ctx, domain)
    case 53: // A_TroopAttack
      return run(id, ctx, domain)
    case 54: // A_SargAttack
      return run(id, ctx, domain)
    case 55: // A_HeadAttack
      return run(id, ctx, domain)
    case 56: // A_BruisAttack
      return run(id, ctx, domain)
    case 57: // A_SkullAttack
      return run(id, ctx, domain)
    case 58: // A_Metal
      return run(id, ctx, domain)
    case 59: // A_SpidRefire
      return run(id, ctx, domain)
    case 60: // A_BabyMetal
      return run(id, ctx, domain)
    case 61: // A_BspiAttack
      return run(id, ctx, domain)
    case 62: // A_Hoof
      return run(id, ctx, domain)
    case 63: // A_CyberAttack
      return run(id, ctx, domain)
    case 64: // A_PainAttack
      return run(id, ctx, domain)
    case 65: // A_PainDie
      return run(id, ctx, domain)
    case 66: // A_KeenDie
      return run(id, ctx, domain)
    case 67: // A_BrainPain
      return run(id, ctx, domain)
    case 68: // A_BrainScream
      return run(id, ctx, domain)
    case 69: // A_BrainDie
      return run(id, ctx, domain)
    case 70: // A_BrainAwake
      return run(id, ctx, domain)
    case 71: // A_BrainSpit
      return run(id, ctx, domain)
    case 72: // A_SpawnSound
      return run(id, ctx, domain)
    case 73: // A_SpawnFly
      return run(id, ctx, domain)
    case 74: // A_BrainExplode
      return run(id, ctx, domain)
    default:
      throw new Error(`dispatchAction: unknown ActionId ${id} (not in info.c states[])`)
  }
}

function run(id: number, ctx: unknown, domain?: ActionDomain): void {
  const fn = resolve(id, domain)
  if (fn === undefined) {
    const name = ACTION_NAMES[id] as string
    unimplemented.set(name, (unimplemented.get(name) ?? 0) + 1)
    return
  }
  fn(ctx)
}

/** Recorded unimplemented-action counts (name → times dispatched). */
export function unimplementedActions(): ReadonlyMap<string, number> {
  return unimplemented
}

/** Clear all bound bodies + recorder (test isolation). */
export function resetActions(): void {
  impl.fill(undefined)
  implMobj.fill(undefined)
  implPspr.fill(undefined)
  unimplemented.clear()
}

/** Machine-checkable manifest: every id with name + bound status. */
export interface ActionManifestEntry {
  id: number
  name: string
  registered: boolean
}

export function actionsManifest(): ActionManifestEntry[] {
  const out: ActionManifestEntry[] = []
  for (let id = 0; id < NUM_ACTIONS; id++) {
    out.push({ id, name: ACTION_NAMES[id] as string, registered: isActionRegistered(id) })
  }
  return out
}
