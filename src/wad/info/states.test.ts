// wad/info/states.test.ts — M7-01 state-table acceptance (docs/design/M7-plan.md
// §M7-01, R06 §1/§3/§10, R08 §2.1).
//
// PROVENANCE OF EVERY CONSTANT BELOW: generated from a local linuxdoom-1.10
// source mirror by
//   node scripts/extract-info-tables.mjs --mirror=<mirror> --digests
// which parses info.c states[]/mobjinfo[], info.h sprnames[]/statenum_t and
// d_items.c weaponinfo[] into the canonical row strings digested here
// (`SPR_*,frame,tics,actionId,S_NEXT,misc1,misc2`). The generator ≠ the
// generated tables: states/mobjinfo/sprnames are row-IDENTICAL to the mirror
// (967/137/138 rows) and weaponinfo after the am_noammo value fix — see
// SALVAGE-NOTES-M7-01-t2.md. A row-by-row diff runs when DOOM_MIRROR is set:
//   DOOM_MIRROR=<mirror> npx vitest run src/wad/info/states.test.ts
//
// The census digests are the machine-checkable stand-in for that diff in CI
// (no GPL source in this repo): they pin row COUNT and row CONTENT per state
// family, so a dropped/duplicated/mis-transcribed row fails with the family
// name in the diff. `digests are not vacuous` proves sensitivity by
// deliberately corrupting one row per family group.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  FF_FRAMEMASK,
  FF_FULLBRIGHT,
  MAX_STATE_CHAIN,
  NUMSTATES,
  S,
  frameFullbright,
  frameIndex,
  maxPureChainLength,
  stateAction,
  stateAdvance,
  stateAt,
  setStateChain,
} from './states';
import { NUMSPRITES, SPR, sprnames } from './sprnames';
import { MAX_SPRITE_FRAMES, frameLetter, parseSpriteLumpName } from '../sprites';
import { MF, MF_TRANSSHIFT, MT, NUMMOBJTYPES, DOOMEDNUM_TO_MT, NUM_SPAWNABLE_MOBJS, mobjinfo } from './mobjinfo';
import { AMMO, NUMAMMO, NUMWEAPONS, WP, weaponinfo } from './weaponinfo';

const MIRROR = process.env.DOOM_MIRROR;

/* ------------------------------------------------------------------ */
/* Canonicalisation (same format as scripts/extract-info-tables.mjs)    */
/* ------------------------------------------------------------------ */

/** statenum_t value → name (index === id). */
const STATE_NAMES: string[] = [];
for (const [name, id] of Object.entries(S)) {
  STATE_NAMES[id as number] = name;
}
/** The action column enters the digest as its NUMERIC ActionId: `wad/` may not
 *  import `sim/` (A-INT1 zone rule), so the id→name vocabulary is pinned by
 *  src/sim/a_actions.test.ts instead, and the id ORDER (== ids) is a source
 *  fact (first appearance walking states[]). */

function sha256(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** states[i] in the extractor's canonical string form. */
function stateRowString(i: number): string {
  const row = stateAt(i);
  return [
    `SPR_${sprnames[row.sprite] as string}`,
    row.frame,
    row.tics,
    row.action,
    STATE_NAMES[row.nextstate] as string,
    row.misc1,
    row.misc2,
  ].join(',');
}

/** mobjinfo[i] in the extractor's canonical string form. */
function mobjRowString(i: number): string {
  const m = mobjinfo[i]!;
  const st = (v: number) => STATE_NAMES[v] as string;
  return [
    m.doomednum, st(m.spawnState), m.spawnHealth, st(m.seeState), m.seeSound, m.reactionTime,
    m.attackSound, st(m.painState), m.painChance, m.painSound, st(m.meleeState), st(m.missileState),
    st(m.deathState), st(m.xdeathState), m.deathSound, m.speed, m.radius, m.height, m.mass,
    m.damage, m.activeSound, m.flags, st(m.raiseState),
  ].join(',');
}

/** weaponinfo[i] in the extractor's canonical string form. */
function weaponRowString(i: number): string {
  const w = weaponinfo[i]!;
  const ammoNames = ['am_clip', 'am_shell', 'am_cell', 'am_misl', 'NUMAMMO', 'am_noammo'];
  return [
    ammoNames[w.ammo] as string, STATE_NAMES[w.upState], STATE_NAMES[w.downState],
    STATE_NAMES[w.readyState], STATE_NAMES[w.atkState], STATE_NAMES[w.flashState],
  ].join(',');
}

/** Family = chain prefix of the statenum name (`S_POSS_DIE15` → `S_POSS`,
 *  `S_BEXP4` → `S_BEXP`); must match familyOf() in the extractor. */
function familyOf(name: string): string {
  const noDigits = name.replace(/\d+$/, '');
  const cut = noDigits.lastIndexOf('_');
  return cut > 2 ? noDigits.slice(0, cut) : noDigits;
}

/* ------------------------------------------------------------------ */
/* Frozen source constants                                             */
/* ------------------------------------------------------------------ */

/** info.c states[] row count (info.h NUMSTATES). */
export const SOURCE_NUMSTATES = 967;
export const SOURCE_NUMMOBJTYPES = 137;
export const SOURCE_NUMSPRITES = 138;
export const SOURCE_NUMWEAPONS = 9;

/** sha256[0:16] of the canonical row strings, whole table. */
export const SOURCE_STATES_DIGEST = '34ccd2d247595b2f';
export const SOURCE_MOBJINFO_DIGEST = '42837e8b83635128';
export const SOURCE_WEAPONINFO_DIGEST = 'b8edf93159f9218f';
export const SOURCE_SPRNAMES_DIGEST = 'a0482fc583f518f3';

/** Per-family census from statenum order: [family, rowCount, digest].
 *  180 families, row counts sum to NUMSTATES. */
export const SOURCE_STATE_CENSUS: readonly [string, number, string][] = [
  ['S_NULL', 1, 'efb6241fb97e1e42'],
  ['S_LIGHTDONE', 1, 'ae348a63a795504f'],
  ['S_PUNCH', 6, 'd5db63d2473a4084'],
  ['S_PUNCHDOWN', 1, '840a2d63f33bd216'],
  ['S_PUNCHUP', 1, 'c3ae668b9bc0a750'],
  ['S_PISTOL', 5, 'be7c6ab2017dcb97'],
  ['S_PISTOLDOWN', 1, '229017c25be531a7'],
  ['S_PISTOLUP', 1, '929733646e1ed560'],
  ['S_PISTOLFLASH', 1, 'a399d8eb120f7654'],
  ['S_SGUN', 10, '3a365f3a8226746f'],
  ['S_SGUNDOWN', 1, 'ec51808d5cfc480c'],
  ['S_SGUNUP', 1, '1ce4238599af5f2e'],
  ['S_SGUNFLASH', 2, 'cff5b689cf1f9855'],
  ['S_DSGUN', 11, 'aad03986684be8c2'],
  ['S_DSGUNDOWN', 1, 'ff2b220a78f9d5ff'],
  ['S_DSGUNUP', 1, 'db084dc14fb1c5e3'],
  ['S_DSNR', 2, '255ac342889e3b4c'],
  ['S_DSGUNFLASH', 2, '12564bf5e67ee788'],
  ['S_CHAIN', 4, '6ebab4c5fa35b2a2'],
  ['S_CHAINDOWN', 1, 'ca11bdd87792360e'],
  ['S_CHAINUP', 1, '3ae57956dfbc0611'],
  ['S_CHAINFLASH', 2, '8830c7192757da82'],
  ['S_MISSILE', 4, 'ec212e8d1b30c6f1'],
  ['S_MISSILEDOWN', 1, '6414678484fd1b31'],
  ['S_MISSILEUP', 1, 'f5e136742ebd8e3c'],
  ['S_MISSILEFLASH', 4, '3a26f7af08408f38'],
  ['S_SAW', 4, '01f1c0d1af66b6ce'],
  ['S_SAWB', 1, 'bfa988f868f470e6'],
  ['S_SAWDOWN', 1, '3a8832b58ded7e03'],
  ['S_SAWUP', 1, '497fd666ce0db1be'],
  ['S_PLASMA', 3, '0ef23c562b3e2f00'],
  ['S_PLASMADOWN', 1, '1c0126f4d8edd893'],
  ['S_PLASMAUP', 1, '3038b632d94d54cc'],
  ['S_PLASMAFLASH', 2, '710b1f0bd52bba88'],
  ['S_BFG', 5, '518caaefb9744632'],
  ['S_BFGDOWN', 1, 'e17ee211f531a63f'],
  ['S_BFGUP', 1, '54f39b588fbc2ba2'],
  ['S_BFGFLASH', 2, 'b234ea872149bf83'],
  ['S_BLOOD', 3, 'b8ac66fab7101d9a'],
  ['S_PUFF', 4, '8071e7190d72f030'],
  ['S_TBALL', 2, '5bb67513fef7dd52'],
  ['S_TBALLX', 3, 'd15d0245b2788648'],
  ['S_RBALL', 2, 'cbeccf01a0778cba'],
  ['S_RBALLX', 3, '335c3a5a485b0bf1'],
  ['S_PLASBALL', 2, '0054e71444310fd1'],
  ['S_PLASEXP', 5, 'ed90b2b7f39c486c'],
  ['S_ROCKET', 1, '5005a2bd4c9d3e70'],
  ['S_BFGSHOT', 2, 'ac9d62ab96455cde'],
  ['S_BFGLAND', 6, '69cb515fb907712e'],
  ['S_BFGEXP', 4, '7be13ac361fad53d'],
  ['S_EXPLODE', 3, 'afd65162f4706ada'],
  ['S_TFOG', 12, 'b0ad486007e752a5'],
  ['S_IFOG', 7, '080e0109bf2c580c'],
  ['S_PLAY', 25, '32826a18f25a701f'],
  ['S_POSS', 33, '4d36dcb32407707a'],
  ['S_SPOS', 34, 'cb79dfc30b4dc90f'],
  ['S_VILE', 40, 'c44b7fee049b75e8'],
  ['S_FIRE', 30, '8b4db78e397f2330'],
  ['S_SMOKE', 5, 'cee31d402ce7bb73'],
  ['S_TRACER', 2, '06cc71a801caac3e'],
  ['S_TRACEEXP', 3, '248ae3bf4a9ceac7'],
  ['S_SKEL', 36, 'd337a172252e9ca5'],
  ['S_FATSHOT', 2, '57f8de3716f8a008'],
  ['S_FATSHOTX', 3, '9358a984e5a4848a'],
  ['S_FATT', 44, 'dc7b189a0dcd5afd'],
  ['S_CPOS', 36, '2ac57e2bbfaf21c4'],
  ['S_TROO', 33, '5913131aa3834f91'],
  ['S_SARG', 27, 'c245a4425c433ac3'],
  ['S_HEAD', 20, '3c8127212c62e4d9'],
  ['S_BRBALL', 2, 'a25ddd905c152a80'],
  ['S_BRBALLX', 3, 'd1117d626c295d32'],
  ['S_BOSS', 29, '1e2d0d97d16bc949'],
  ['S_BOS2', 29, 'a16a3a4167a4482c'],
  ['S_SKULL', 16, 'fa2007373af4b642'],
  ['S_SPID', 31, '4273ecabc50b929a'],
  ['S_BSPI', 35, '5ece168805098bba'],
  ['S_ARACH', 7, '7eef4b9ef82d047e'],
  ['S_CYBER', 27, '961068a6d2575e2c'],
  ['S_PAIN', 25, 'a49b05c1e8e1439e'],
  ['S_SSWV', 37, '8b1a423b15130b9f'],
  ['S_KEENSTND', 1, 'fa6499a665d45ca8'],
  ['S_COMMKEEN', 12, '247570d77426f77d'],
  ['S_KEENPAIN', 2, 'ebef1d3a555c578f'],
  ['S_BRAIN', 6, '8ab077baea0f43c5'],
  ['S_BRAINEYE', 2, 'faf119c971d143da'],
  ['S_BRAINEYESEE', 1, '9d4c428def61bda6'],
  ['S_SPAWN', 4, 'ae4deda7e2bfd3fe'],
  ['S_SPAWNFIRE', 8, '0acf3006dddf5289'],
  ['S_BRAINEXPLODE', 3, '21cd8b8e4f0c6ef6'],
  ['S_ARM', 2, '25de44115f767551'],
  ['S_ARM1A', 1, '259f64c43c960cb6'],
  ['S_ARM2A', 1, 'c6255bb230066e6e'],
  ['S_BAR', 2, '5492b17fb78be70a'],
  ['S_BEXP', 5, '26a11311acada7bf'],
  ['S_BBAR', 3, 'b04a2077207e8cc0'],
  ['S_BON', 2, '865e0d6b13cf78e1'],
  ['S_BON1A', 1, 'd9159f847e686c86'],
  ['S_BON1B', 1, '32fb2f4994a55ce9'],
  ['S_BON1C', 1, '8855082445c7d54c'],
  ['S_BON1D', 1, 'c80ffefe27ee67a0'],
  ['S_BON1E', 1, '24a79b2dcdec1377'],
  ['S_BON2A', 1, 'ce7e885d84560b73'],
  ['S_BON2B', 1, 'c671f881592e9f9e'],
  ['S_BON2C', 1, 'd1699f1f0f4f16b4'],
  ['S_BON2D', 1, '1e2da183b2e93635'],
  ['S_BON2E', 1, 'a71c1b6820f935ac'],
  ['S_BKEY', 2, '11281868c9659eb5'],
  ['S_RKEY', 2, '9ec92c192536770b'],
  ['S_YKEY', 2, '6c6b40ded33d32cb'],
  ['S_BSKULL', 2, '97ff2e356d8d8673'],
  ['S_RSKULL', 2, '5aa8dd7b24f315b5'],
  ['S_YSKULL', 2, 'cc3889b29b1b89c3'],
  ['S_STIM', 1, 'dfa9013f998e5ec8'],
  ['S_MEDI', 1, '02ae72aa4ba67cee'],
  ['S_SOUL', 6, '6a51339e982e7c35'],
  ['S_PINV', 4, 'b4027f2606d36556'],
  ['S_PSTR', 1, 'c4de602655a0cca9'],
  ['S_PINS', 4, 'a7bb3962c55bd5ff'],
  ['S_MEGA', 4, '0db661d88ff1cea7'],
  ['S_SUIT', 1, '4b7c31d02216a8eb'],
  ['S_PMAP', 6, '287d08be498973d4'],
  ['S_PVIS', 2, 'd5229f180d5d3653'],
  ['S_CLIP', 1, '54207feb998b875f'],
  ['S_AMMO', 1, '1a10f0ff29c6ea4e'],
  ['S_ROCK', 1, 'cd929b086959b485'],
  ['S_BROK', 1, 'ae75b490004698d4'],
  ['S_CELL', 1, 'dca5823ce602e0ae'],
  ['S_CELP', 1, 'aac065cd52addd09'],
  ['S_SHEL', 1, '380906c2f7139537'],
  ['S_SBOX', 1, '80464a80dd416746'],
  ['S_BPAK', 1, 'af0a8cace1d07df8'],
  ['S_BFUG', 1, 'ce83071beac47d98'],
  ['S_MGUN', 1, '76e27c2c1847f3cf'],
  ['S_CSAW', 1, 'bfad84427b958390'],
  ['S_LAUN', 1, '276bf43f6393b5fd'],
  ['S_PLAS', 1, 'e2d88690a8a2e3f7'],
  ['S_SHOT', 2, '474510b90eb50e37'],
  ['S_COLU', 1, '0c3d7e81e0650924'],
  ['S_STALAG', 1, '162bdaad107492aa'],
  ['S_BLOODYTWITCH', 4, '679463312e32f623'],
  ['S_DEADTORSO', 1, '650acd3d3727110e'],
  ['S_DEADBOTTOM', 1, '641952247a136c20'],
  ['S_HEADSONSTICK', 1, 'c66daae69d3acb6e'],
  ['S_GIBS', 1, '3271c677c2c85ace'],
  ['S_HEADONASTICK', 1, 'a942d3e36de6e259'],
  ['S_HEADCANDLES', 2, 'f41c7afffa7a82da'],
  ['S_DEADSTICK', 1, '21e00a75f02035dd'],
  ['S_LIVESTICK', 2, '66d06541e8b2bddc'],
  ['S_MEAT', 4, '0c2757ae1d103f49'],
  ['S_STALAGTITE', 1, '8d9a28d4e175e712'],
  ['S_TALLGRNCOL', 1, '944bf24fb5974963'],
  ['S_SHRTGRNCOL', 1, '1a55705c89dd8563'],
  ['S_TALLREDCOL', 1, 'a676507456e8ceaa'],
  ['S_SHRTREDCOL', 1, 'facc9235c8241dc1'],
  ['S_CANDLESTIK', 1, '2fb06f8aaaa3d40c'],
  ['S_CANDELABRA', 1, 'f2247f9a77445a23'],
  ['S_SKULLCOL', 1, '44b10d8c3d6b9625'],
  ['S_TORCHTREE', 1, '97db3b7da5e568f3'],
  ['S_BIGTREE', 1, '63062a32b438a68d'],
  ['S_TECHPILLAR', 1, '90ead31d1adf1247'],
  ['S_EVILEYE', 4, '1a49d613ea9b6dfe'],
  ['S_FLOATSKULL', 3, '9cadc1488ea56ebb'],
  ['S_HEARTCOL', 2, '003193904b250734'],
  ['S_BLUETORCH', 4, '40319101121f0032'],
  ['S_GREENTORCH', 4, '47f6b20a0d17160f'],
  ['S_REDTORCH', 4, '6b274bc13cecab59'],
  ['S_BTORCHSHRT', 4, 'd7c8a66459df5940'],
  ['S_GTORCHSHRT', 4, 'bdab6438a9c4e34e'],
  ['S_RTORCHSHRT', 4, 'c0a9434f6462bc1d'],
  ['S_HANGNOGUTS', 1, '8bfe8bc0a2c1016b'],
  ['S_HANGBNOBRAIN', 1, 'c326d81146c42efe'],
  ['S_HANGTLOOKDN', 1, 'ec78297b4b869605'],
  ['S_HANGTSKULL', 1, 'e442fae6888766ce'],
  ['S_HANGTLOOKUP', 1, '8c4c7e1f0a2e7cfb'],
  ['S_HANGTNOBRAIN', 1, 'e12a04f22d65a69d'],
  ['S_COLONGIBS', 1, '0d8d16be4a4194b2'],
  ['S_SMALLPOOL', 1, '057d73df1ba1c745'],
  ['S_BRAINSTEM', 1, 'd88fe20a196866f0'],
  ['S_TECHLAMP', 4, 'da8177f27e7887cf'],
  ['S_TECH2LAMP', 4, '0f172624639690fb'],
];

/** Spot vectors: [state, sprite, frame (RAW, FF_* bits included), tics,
 *  action id, next, misc1, misc2] straight from info.c. Frame literals are
 *  written the way the source writes them (32768+n = fullbright, e.g. 32773
 *  = frame E | FF_FULLBRIGHT). */
type StateVector = [string, string, number, number, number, string, number, number];

const PLAYER_VECTORS: readonly StateVector[] = [
  ['S_PLAY', 'PLAY', 0, -1, 0, 'S_NULL', 0, 0],
  ['S_PLAY_RUN1', 'PLAY', 0, 4, 0, 'S_PLAY_RUN2', 0, 0],
  ['S_PLAY_ATK1', 'PLAY', 4, 12, 0, 'S_PLAY', 0, 0],
  ['S_PLAY_ATK2', 'PLAY', 32773, 6, 0, 'S_PLAY_ATK1', 0, 0],
  ['S_PLAY_PAIN2', 'PLAY', 6, 4, 25, 'S_PLAY', 0, 0], // A_Pain
  ['S_PLAY_DIE3', 'PLAY', 9, 10, 27, 'S_PLAY_DIE4', 0, 0], // A_Fall
  ['S_PLAY_XDIE9', 'PLAY', 22, -1, 0, 'S_NULL', 0, 0],
];

/** Psprite/weapon states (M7-07 consumes these chains). */
const WEAPON_VECTORS: readonly StateVector[] = [
  ['S_LIGHTDONE', 'SHTG', 4, 0, 1, 'S_NULL', 0, 0], // A_Light0 — the 0-tic row
  ['S_PUNCH', 'PUNG', 0, 1, 2, 'S_PUNCH', 0, 0], // A_WeaponReady (self-loop)
  ['S_PISTOLFLASH', 'PISF', 32768, 7, 8, 'S_LIGHTDONE', 0, 0], // A_Light1
  ['S_SGUNFLASH2', 'SHTF', 32769, 3, 10, 'S_LIGHTDONE', 0, 0], // A_Light2
  ['S_CHAIN3', 'CHGG', 1, 0, 6, 'S_CHAIN', 0, 0], // A_ReFire — 0-tic chain
  ['S_SAWUP', 'SAWG', 2, 1, 4, 'S_SAWUP', 0, 0], // A_Raise
  ['S_BFG', 'BFGG', 0, 1, 2, 'S_BFG', 0, 0],
  ['S_DSGUNFLASH1', 'SHT2', 32776, 5, 8, 'S_DSGUNFLASH2', 0, 0],
];

/** Monster death / pain / gib chains (M8 consumes; A_Scream/A_Fall placement
 *  is what the corpse-tic and gibs rules depend on). */
const MONSTER_VECTORS: readonly StateVector[] = [
  ['S_POSS_DIE2', 'POSS', 8, 5, 33, 'S_POSS_DIE3', 0, 0], // A_Scream
  ['S_POSS_XDIE9', 'POSS', 20, -1, 0, 'S_NULL', 0, 0],
  ['S_TROO_DIE5', 'TROO', 12, -1, 0, 'S_NULL', 0, 0],
  ['S_TROO_PAIN', 'TROO', 7, 2, 0, 'S_TROO_PAIN2', 0, 0],
  ['S_SPOS_PAIN2', 'SPOS', 6, 3, 25, 'S_SPOS_RUN1', 0, 0], // A_Pain
  ['S_KEENPAIN', 'KEEN', 12, 4, 0, 'S_KEENPAIN2', 0, 0],
  ['S_COMMKEEN11', 'KEEN', 10, 6, 66, 'S_COMMKEEN12', 0, 0], // A_KeenDie
  ['S_MEAT4', 'GOR4', 0, -1, 0, 'S_NULL', 0, 0], // gore/decor (MF_SOLID decor)
];

/** Item / pickup states — the MF_SPECIAL spawn frames (spawnstate is the
 *  forever row R12's doomednum→MT lookup hands to P_SpawnThing). */
const ITEM_VECTORS: readonly StateVector[] = [
  ['S_AMMO', 'AMMO', 0, -1, 0, 'S_NULL', 0, 0],
  ['S_BPAK', 'BPAK', 0, -1, 0, 'S_NULL', 0, 0],
  ['S_CLIP', 'CLIP', 0, -1, 0, 'S_NULL', 0, 0],
  ['S_STIM', 'STIM', 0, -1, 0, 'S_NULL', 0, 0],
  ['S_SUIT', 'SUIT', 32768, -1, 0, 'S_NULL', 0, 0], // fullbright forever
  ['S_PINV', 'PINV', 32768, 6, 0, 'S_PINV2', 0, 0], // 4-frame flash cycle
];

/** Effect/explosion rows (0-tic-free, A_Explode placement pinned). */
const EFFECT_VECTORS: readonly StateVector[] = [
  ['S_PUFF1', 'PUFF', 32768, 4, 0, 'S_PUFF2', 0, 0],
  ['S_PUFF3', 'PUFF', 2, 4, 0, 'S_PUFF4', 0, 0],
  ['S_PUFF4', 'PUFF', 3, 4, 0, 'S_NULL', 0, 0],
  ['S_BEXP', 'BEXP', 32768, 5, 0, 'S_BEXP2', 0, 0],
  ['S_BEXP4', 'BEXP', 32771, 10, 24, 'S_BEXP5', 0, 0], // A_Explode
  ['S_EXPLODE1', 'MISL', 32769, 8, 24, 'S_EXPLODE2', 0, 0], // A_Explode
];

const OTHER_VECTORS: readonly StateVector[] = [
  ['S_NULL', 'TROO', 0, -1, 0, 'S_NULL', 0, 0], // sentinel row
  ['S_KEENSTND', 'KEEN', 0, -1, 0, 'S_KEENSTND', 0, 0], // self-loop, tics -1
  ['S_BRAINEYE', 'SSWV', 0, 10, 29, 'S_BRAINEYE', 0, 0], // A_Look self-loop
];

export const SOURCE_SPOT_VECTORS: readonly StateVector[] = [
  ...PLAYER_VECTORS,
  ...WEAPON_VECTORS,
  ...MONSTER_VECTORS,
  ...ITEM_VECTORS,
  ...EFFECT_VECTORS,
  ...OTHER_VECTORS,
];

/** mobjinfo[] spot rows (doomednum, states, sounds, fixed-point sizes,
 *  MF_* flag masks exactly as info.c writes them). */
type MobjVector = [string, ...unknown[]];
export const SOURCE_MOBJ_VECTORS: readonly MobjVector[] = [
  ['MT_PLAYER', -1, 'S_PLAY', 100, 'S_PLAY_RUN1', 'sfx_None', 0, 'sfx_None', 'S_PLAY_PAIN', 255, 'sfx_plpain', 'S_NULL', 'S_PLAY_ATK1', 'S_PLAY_DIE1', 'S_PLAY_XDIE1', 'sfx_pldeth', 0, 1048576, 3670016, 100, 0, 'sfx_None', 33557510, 'S_NULL'],
  ['MT_POSSESSED', 3004, 'S_POSS_STND', 20, 'S_POSS_RUN1', 'sfx_posit1', 8, 'sfx_pistol', 'S_POSS_PAIN', 200, 'sfx_popain', 'S_NULL', 'S_POSS_ATK1', 'S_POSS_DIE1', 'S_POSS_XDIE1', 'sfx_podth1', 8, 1310720, 3670016, 100, 0, 'sfx_posact', 4194310, 'S_POSS_RAISE1'],
  ['MT_TROOP', 3001, 'S_TROO_STND', 60, 'S_TROO_RUN1', 'sfx_bgsit1', 8, '0', 'S_TROO_PAIN', 200, 'sfx_popain', 'S_TROO_ATK1', 'S_TROO_ATK1', 'S_TROO_DIE1', 'S_TROO_XDIE1', 'sfx_bgdth1', 8, 1310720, 3670016, 100, 0, 'sfx_bgact', 4194310, 'S_TROO_RAISE1'],
  ['MT_SKULL', 3006, 'S_SKULL_STND', 100, 'S_SKULL_RUN1', '0', 8, 'sfx_sklatk', 'S_SKULL_PAIN', 256, 'sfx_dmpain', 'S_NULL', 'S_SKULL_ATK1', 'S_SKULL_DIE1', 'S_NULL', 'sfx_firxpl', 8, 1048576, 3670016, 50, 3, 'sfx_dmact', 16902, 'S_NULL'],
  ['MT_KEEN', 72, 'S_KEENSTND', 100, 'S_NULL', 'sfx_None', 8, 'sfx_None', 'S_KEENPAIN', 256, 'sfx_keenpn', 'S_NULL', 'S_NULL', 'S_COMMKEEN', 'S_NULL', 'sfx_keendt', 0, 1048576, 4718592, 10000000, 0, 'sfx_None', 4195078, 'S_NULL'],
  ['MT_CLIP', 2007, 'S_CLIP', 1000, 'S_NULL', 'sfx_None', 8, 'sfx_None', 'S_NULL', 0, 'sfx_None', 'S_NULL', 'S_NULL', 'S_NULL', 'S_NULL', 'sfx_None', 0, 1310720, 1048576, 100, 0, 'sfx_None', 1, 'S_NULL'],
  ['MT_BARREL', 2035, 'S_BAR1', 20, 'S_NULL', 'sfx_None', 8, 'sfx_None', 'S_NULL', 0, 'sfx_None', 'S_NULL', 'S_NULL', 'S_BEXP', 'S_NULL', 'sfx_barexp', 0, 655360, 2752512, 100, 0, 'sfx_None', 524294, 'S_NULL'],
  ['MT_BOSSBRAIN', 88, 'S_BRAIN', 250, 'S_NULL', 'sfx_None', 8, 'sfx_None', 'S_BRAIN_PAIN', 255, 'sfx_bospn', 'S_NULL', 'S_NULL', 'S_BRAIN_DIE1', 'S_NULL', 'sfx_bosdth', 0, 1048576, 1048576, 10000000, 0, 'sfx_None', 6, 'S_NULL'],
  ['MT_PUFF', -1, 'S_PUFF1', 1000, 'S_NULL', 'sfx_None', 8, 'sfx_None', 'S_NULL', 0, 'sfx_None', 'S_NULL', 'S_NULL', 'S_NULL', 'S_NULL', 'sfx_None', 0, 1310720, 1048576, 100, 0, 'sfx_None', 528, 'S_NULL'],
];

/** weaponinfo[] rows (d_items.c): [ammo, up, down, ready, atk, flash]. */
export const SOURCE_WEAPON_VECTORS: readonly [string, number, string, string, string, string, string][] = [
  ['wp_fist', AMMO.am_noammo, 'S_PUNCHUP', 'S_PUNCHDOWN', 'S_PUNCH', 'S_PUNCH1', 'S_NULL'],
  ['wp_pistol', AMMO.am_clip, 'S_PISTOLUP', 'S_PISTOLDOWN', 'S_PISTOL', 'S_PISTOL1', 'S_PISTOLFLASH'],
  ['wp_shotgun', AMMO.am_shell, 'S_SGUNUP', 'S_SGUNDOWN', 'S_SGUN', 'S_SGUN1', 'S_SGUNFLASH1'],
  ['wp_chaingun', AMMO.am_clip, 'S_CHAINUP', 'S_CHAINDOWN', 'S_CHAIN', 'S_CHAIN1', 'S_CHAINFLASH1'],
  ['wp_missile', AMMO.am_misl, 'S_MISSILEUP', 'S_MISSILEDOWN', 'S_MISSILE', 'S_MISSILE1', 'S_MISSILEFLASH1'],
  ['wp_plasma', AMMO.am_cell, 'S_PLASMAUP', 'S_PLASMADOWN', 'S_PLASMA', 'S_PLASMA1', 'S_PLASMAFLASH1'],
  ['wp_bfg', AMMO.am_cell, 'S_BFGUP', 'S_BFGDOWN', 'S_BFG', 'S_BFG1', 'S_BFGFLASH1'],
  ['wp_chainsaw', AMMO.am_noammo, 'S_SAWUP', 'S_SAWDOWN', 'S_SAW', 'S_SAW1', 'S_NULL'],
  ['wp_supershotgun', AMMO.am_shell, 'S_DSGUNUP', 'S_DSGUNDOWN', 'S_DSGUN', 'S_DSGUN1', 'S_DSGUNFLASH1'],
];

/** Source-derived structural census (mirror counts, all asserted below). */
export const SOURCE_ZERO_TIC_STATES = [1, 54, 62, 73, 255, 335, 339, 711];
export const SOURCE_FOREVER_ROWS = 80;
export const SOURCE_FULLBRIGHT_ROWS = 278;
export const SOURCE_MAX_FRAME_INDEX = 28;
export const SOURCE_SPECIAL_MOBJS = 36;
export const SOURCE_SPAWNABLE_MOBJS = 118;
export const SOURCE_FLAG_COMBOS = 20;
export const SOURCE_SOUND_TOKENS_ZERO = 15;
export const SOURCE_MAX_PURE_CHAIN = 2;

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const S_ID = (name: string): number => {
  const id = (S as Record<string, number>)[name];
  if (id === undefined) throw new Error(`statenum_t has no ${name}`);
  return id;
};
const MT_ID = (name: string): number => {
  const id = (MT as Record<string, number>)[name];
  if (id === undefined) throw new Error(`mobjtype_t has no ${name}`);
  return id;
};

function checkStateVectors(vectors: readonly StateVector[]): string[] {
  const bad: string[] = [];
  for (const [name, sprite, frame, tics, action, next, misc1, misc2] of vectors) {
    const id = S_ID(name);
    const row = stateAt(id);
    const want = [sprite, frame, tics, action, S_ID(next), misc1, misc2];
    const got = [sprnames[row.sprite], row.frame, row.tics, row.action, row.nextstate, row.misc1, row.misc2];
    if (want.some((v, k) => v !== got[k])) {
      bad.push(`${name} (${id}): want ${want.join(',')} got ${got.join(',')}`);
    }
  }
  return bad;
}

function familyGroups(vectors: readonly StateVector[]): Map<string, StateVector[]> {
  const out = new Map<string, StateVector[]>();
  for (const v of vectors) {
    const f = familyOf(v[0]);
    if (!out.has(f)) out.set(f, []);
    out.get(f)!.push(v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 1. Completeness + census                                            */
/* ------------------------------------------------------------------ */

describe('M7-01 state tables — completeness/census vs info.c', () => {
  it('row counts match info.c (967/137/138/9)', () => {
    expect(NUMSTATES).toBe(SOURCE_NUMSTATES);
    expect(NUMMOBJTYPES).toBe(SOURCE_NUMMOBJTYPES);
    expect(NUMSPRITES).toBe(SOURCE_NUMSPRITES);
    expect(NUMWEAPONS).toBe(SOURCE_NUMWEAPONS);
    expect(mobjinfo).toHaveLength(NUMMOBJTYPES);
    expect(sprnames).toHaveLength(NUMSPRITES);
    expect(weaponinfo).toHaveLength(NUMWEAPONS);
    expect(Object.keys(S)).toHaveLength(NUMSTATES);
  });

  it('statenum values are dense 0..966 in info.h order', () => {
    const ids = Object.values(S);
    expect(new Set(ids).size).toBe(NUMSTATES);
    expect(Math.min(...ids)).toBe(0);
    expect(Math.max(...ids)).toBe(NUMSTATES - 1);
    expect(STATE_NAMES.length).toBe(NUMSTATES);
    expect(STATE_NAMES[0]).toBe('S_NULL');
    expect(STATE_NAMES[784]).toBe('S_BRAINEYE');
  });

  it('whole-table digests match the parsed mirror', () => {
    expect(sha256([...Array(NUMSTATES).keys()].map(stateRowString))).toBe(SOURCE_STATES_DIGEST);
    expect(sha256(mobjinfo.map((_, i) => mobjRowString(i)))).toBe(SOURCE_MOBJINFO_DIGEST);
    expect(sha256(weaponinfo.map((_, i) => weaponRowString(i)))).toBe(SOURCE_WEAPONINFO_DIGEST);
    expect(sha256([...sprnames])).toBe(SOURCE_SPRNAMES_DIGEST);
  });

  it('per-family census: 180 families, 967 rows, every digest', () => {
    const groups = new Map<string, number[]>();
    for (let i = 0; i < NUMSTATES; i++) {
      const f = familyOf(STATE_NAMES[i] as string);
      if (!groups.has(f)) groups.set(f, []);
      groups.get(f)!.push(i);
    }
    expect(SOURCE_STATE_CENSUS.length).toBe(180);
    expect(SOURCE_STATE_CENSUS.reduce((s, [, n]) => s + n, 0)).toBe(NUMSTATES);
    expect(new Set(SOURCE_STATE_CENSUS.map(([f]) => f)).size).toBe(SOURCE_STATE_CENSUS.length);
    expect(new Set([...groups.keys()]).size).toBe(SOURCE_STATE_CENSUS.length);
    const mismatches: string[] = [];
    for (const [family, count, digest] of SOURCE_STATE_CENSUS) {
      const idx = groups.get(family);
      if (idx === undefined) { mismatches.push(`${family}: absent from the table`); continue; }
      if (idx.length !== count) mismatches.push(`${family}: ${idx.length} rows, source has ${count}`);
      else if (sha256(idx.map(stateRowString)) !== digest) mismatches.push(`${family}: content digest drift`);
    }
    expect(mismatches).toEqual([]);
  });

  it('spot vectors per family group (player/weapon/monster/item/effect/other)', () => {
    // Sampling floor per family group (plan: ≥5 states per family sampled).
    const counts: Record<string, number> = {
      player: PLAYER_VECTORS.length, weapon: WEAPON_VECTORS.length, monster: MONSTER_VECTORS.length,
      item: ITEM_VECTORS.length, effect: EFFECT_VECTORS.length,
    };
    for (const [group, n] of Object.entries(counts)) expect(n, group).toBeGreaterThanOrEqual(5);
    expect(OTHER_VECTORS.length).toBeGreaterThanOrEqual(3);
    // every sampled row lands in a distinct-enough coverage set:
    const families = new Set(SOURCE_SPOT_VECTORS.map((v) => familyOf(v[0])));
    expect(families.size).toBeGreaterThanOrEqual(20);
    expect(familyGroups(SOURCE_SPOT_VECTORS).size).toBe(families.size);
    expect(checkStateVectors(SOURCE_SPOT_VECTORS)).toEqual([]);
  });

  it('mobjinfo and weaponinfo spot rows match info.c / d_items.c', () => {
    const bad: string[] = [];
    for (const [name, ...fields] of SOURCE_MOBJ_VECTORS) {
      const row = mobjinfo[MT_ID(name)]!;
      const got = [
        row.doomednum, row.spawnState, row.spawnHealth, row.seeState, row.seeSound, row.reactionTime,
        row.attackSound, row.painState, row.painChance, row.painSound, row.meleeState, row.missileState,
        row.deathState, row.xdeathState, row.deathSound, row.speed, row.radius, row.height, row.mass,
        row.damage, row.activeSound, row.flags, row.raiseState,
      ];
      const want = fields.map((v) => (typeof v === 'string' && v.startsWith('S_') ? S_ID(v) : v));
      if (want.some((v, k) => v !== got[k])) {
        bad.push(`${name}: want ${want.join(',')} got ${got.join(',')}`);
      }
    }
    expect(bad).toEqual([]);

    const wbad: string[] = [];
    SOURCE_WEAPON_VECTORS.forEach(([name, ammo, up, down, ready, atk, flash], i) => {
      const w = weaponinfo[i]!;
      const got = [w.ammo, w.upState, w.downState, w.readyState, w.atkState, w.flashState];
      const want = [ammo, S_ID(up), S_ID(down), S_ID(ready), S_ID(atk), S_ID(flash)];
      if (want.some((v, k) => v !== got[k])) wbad.push(`${name}: want ${want.join(',')} got ${got.join(',')}`);
    });
    expect(wbad).toEqual([]);
    expect(SOURCE_WEAPON_VECTORS.map((v) => v[0])).toEqual([
      'wp_fist', 'wp_pistol', 'wp_shotgun', 'wp_chaingun', 'wp_missile', 'wp_plasma', 'wp_bfg',
      'wp_chainsaw', 'wp_supershotgun',
    ]);
  });

  it('structural census numbers match the mirror', () => {
    expect([...Array(NUMSTATES).keys()].filter((i) => stateAt(i).tics === 0)).toEqual(SOURCE_ZERO_TIC_STATES);
    expect([...Array(NUMSTATES).keys()].filter((i) => stateAt(i).tics === -1)).toHaveLength(SOURCE_FOREVER_ROWS);
    expect([...Array(NUMSTATES).keys()].filter((i) => frameFullbright(stateAt(i).frame))).toHaveLength(SOURCE_FULLBRIGHT_ROWS);
    expect(Math.max(...[...Array(NUMSTATES).keys()].map((i) => frameIndex(stateAt(i).frame)))).toBe(SOURCE_MAX_FRAME_INDEX);
    expect(mobjinfo.filter((m) => (m.flags & MF.MF_SPECIAL) !== 0)).toHaveLength(SOURCE_SPECIAL_MOBJS);
    expect(NUM_SPAWNABLE_MOBJS).toBe(SOURCE_SPAWNABLE_MOBJS);
    expect(DOOMEDNUM_TO_MT.size).toBe(SOURCE_SPAWNABLE_MOBJS);
    expect(new Set(mobjinfo.map((m) => m.flags)).size).toBe(SOURCE_FLAG_COMBOS);
    expect(mobjinfo.flatMap((m) => [m.seeSound, m.attackSound, m.painSound, m.deathSound, m.activeSound])
      .filter((token) => String(token) === '0')).toHaveLength(SOURCE_SOUND_TOKENS_ZERO);
  });

  it('doomednum→MT keeps vanilla first-match scan order', () => {
    // Vanilla P_SpawnMapThing walks mobjinfo[] in order and takes the FIRST
    // type whose doomednum matches; MT_BRAINEYE (88) must therefore never
    // shadow MT_BOSSBRAIN, and the map size proves nothing was overwritten.
    expect(DOOMEDNUM_TO_MT.get(88)).toBe(MT_ID('MT_BOSSBRAIN'));
    expect(DOOMEDNUM_TO_MT.get(-1)).toBeUndefined();
    expect(DOOMEDNUM_TO_MT.get(2007)).toBe(MT_ID('MT_CLIP'));
    expect(DOOMEDNUM_TO_MT.get(3001)).toBe(MT_ID('MT_TROOP'));
    expect(mobjinfo.filter((m) => m.doomednum === -1)).toHaveLength(NUMMOBJTYPES - SOURCE_SPAWNABLE_MOBJS);
  });

  it('MF_* constants match p_mobj.h', () => {
    expect(MF.MF_SPECIAL).toBe(1);
    expect(MF.MF_TRANSLATION).toBe(0xc000000);
    expect(MF_TRANSSHIFT).toBe(26);
    expect(MF.MF_SOLID | MF.MF_SHOOTABLE | MF.MF_DROPOFF | MF.MF_PICKUP | MF.MF_NOTDMATCH)
      .toBe(mobjinfo[MT_ID('MT_PLAYER')]!.flags);
  });

  it('doomdef.h enum values are the C values (marker-before-name traps)', () => {
    // NUMAMMO precedes am_noammo and NUMWEAPONS precedes wp_nochange, so the
    // names are 5 and 10 — the fist/chainsaw rows of weaponinfo[] carry
    // am_noammo (never a maxammo[]/clipammo[] index; those are NUMAMMO long).
    expect(AMMO.am_clip).toBe(0);
    expect(AMMO.am_noammo).toBe(5);
    expect(NUMAMMO).toBe(4);
    expect(WP.wp_fist).toBe(0);
    expect(WP.wp_supershotgun).toBe(8);
    expect(WP.wp_nochange).toBe(10);
    expect(weaponinfo[WP.wp_fist]).toBeDefined();
    expect(weaponinfo[WP.wp_chainsaw]!.ammo).toBe(AMMO.am_noammo);
    expect(weaponinfo[WP.wp_fist]!.ammo).toBe(AMMO.am_noammo);
    expect(weaponinfo.filter((w) => w.ammo === AMMO.am_noammo)).toHaveLength(2);
  });

  it('the action column stays inside the registry id space (75 ids)', () => {
    const ids = new Set([...Array(NUMSTATES).keys()].map((i) => stateAction[i] as number));
    expect(ids.size).toBe(75); // 74 A_* functions + "no action"
    expect(Math.max(...ids)).toBe(74);
    expect(Math.min(...ids)).toBe(0);
    expect(ids.has(0)).toBe(true);
  });

  it('sprnames indexes agree with the SPR_* map (4CC order)', () => {
    for (const [name, idx] of Object.entries(SPR)) {
      expect(sprnames[idx as number]).toBe(name);
    }
    expect(sprnames[0]).toBe('TROO');
  });
});

/* ------------------------------------------------------------------ */
/* 2. Frame-bit decode (p_pspr.h FF_* + sprite grammar)                 */
/* ------------------------------------------------------------------ */

describe('M7-01 frame-bit decode', () => {
  it('FF_FULLBRIGHT/FF_FRAMEMASK split the raw frame word', () => {
    expect(FF_FULLBRIGHT).toBe(0x8000);
    expect(FF_FRAMEMASK).toBe(0x7fff);
    expect(FF_FULLBRIGHT | FF_FRAMEMASK).toBe(0xffff);
    // info.c writes fullbright frames as the literal 32768+n:
    expect(frameIndex(32773)).toBe(5);
    expect(frameFullbright(32773)).toBe(true);
    expect(frameIndex(32768)).toBe(0);
    expect(frameIndex(28)).toBe(28);
    expect(frameFullbright(28)).toBe(false);
    // frame + FF_FULLBRIGHT === the source literal:
    for (const [, , frame] of SOURCE_SPOT_VECTORS) {
      expect(frameIndex(frame) | (frameFullbright(frame) ? FF_FULLBRIGHT : 0)).toBe(frame);
    }
  });

  it('no state frame bit is a rotation bit; every frame indexes a real slot', () => {
    for (let i = 0; i < NUMSTATES; i++) {
      const frame = stateAt(i).frame;
      expect(frameIndex(frame)).toBeLessThan(MAX_SPRITE_FRAMES);
    }
    // Vanilla quirk pinned: exactly three states (S_VILE_HEAL1..3) use frame
    // indexes 26..28 — beyond the A–Z letters the sprite lump grammar can
    // name, so those frames have no lump and never draw (VILE sprites stop at
    // the letter Z); they are the only rows above 25.
    const aboveLetters = [...Array(NUMSTATES).keys()].filter((i) => frameIndex(stateAt(i).frame) > 25);
    expect(aboveLetters.map((i) => STATE_NAMES[i]).sort())
      .toEqual(['S_VILE_HEAL1', 'S_VILE_HEAL2', 'S_VILE_HEAL3']);
    // Every other (sprite, frame) pair must decode to a lump name the sprite
    // grammar parses back to the same indexes (r_things.c name = 4CC + frame
    // letter + rotation digit; rotation comes from the lump name, never the
    // state frame — R06 §4).
    for (const [i, sprite, frame] of SOURCE_SPOT_VECTORS.map(
      (v) => [S_ID(v[0]), v[1], v[2]] as [number, string, number],
    )) {
      const idx = frameIndex(frame);
      const lump = `${sprite}${frameLetter(idx)}0`;
      expect(parseSpriteLumpName(lump).installs[0]!.frame, lump).toBe(idx);
      expect(sprnames[stateAt(i).sprite]).toBe(sprite);
      expect(frameFullbright(frame)).toBe(frameFullbright(stateAt(i).frame));
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Digest sensitivity (deliberately-wrong control)                  */
/* ------------------------------------------------------------------ */

describe('M7-01 digest sensitivity (generated ≠ trusted)', () => {
  it('one wrong field per family group changes the digest', () => {
    const base = [...Array(NUMSTATES).keys()].map(stateRowString);
    expect(sha256(base)).toBe(SOURCE_STATES_DIGEST);
    // [label, state id, column index (0 sprite, 1 frame, 2 tics, 3 action,
    // 4 nextstate, 5/6 misc), mutate]
    const probes: [string, number, number][] = [
      ['player frame bit (32773-style)', S_ID('S_PLAY_ATK2'), 1],
      ['weapon tics', S_ID('S_PISTOLFLASH'), 2],
      ['monster nextstate', S_ID('S_TROO_DIE5'), 4],
      ['item sprite index', S_ID('S_CLIP'), 0],
      ['effect action id', S_ID('S_BEXP4'), 3],
      ['sentinel tics', S_ID('S_NULL'), 2],
    ];
    for (const [label, row, col] of probes) {
      const fields = base[row]!.split(',');
      const mutate = (v: number) => (v === 0 ? 1 : v - 1);
      const patched = [...base];
      patched[row] = [...fields.slice(0, col), mutate(Number(fields[col])), ...fields.slice(col + 1)].join(',');
      expect(sha256(patched), label).not.toBe(SOURCE_STATES_DIGEST);
      // and the family census catches it:
      const family = familyOf(STATE_NAMES[row] as string);
      const idx = [...Array(NUMSTATES).keys()].filter((i) => familyOf(STATE_NAMES[i] as string) === family);
      const want = SOURCE_STATE_CENSUS.find(([f]) => f === family)?.[2];
      expect(sha256(idx.map((i) => (i === row ? patched[i]! : stateRowString(i)))), family).not.toBe(want);
    }
  });

  it('a dropped or duplicated row fails the census count, not just the digest', () => {
    const family = 'S_POSS';
    const idx = [...Array(NUMSTATES).keys()].filter((i) => familyOf(STATE_NAMES[i] as string) === family);
    const [, count] = SOURCE_STATE_CENSUS.find(([f]) => f === family)!;
    expect(idx.length).toBe(count);
    expect(idx.length - 1).not.toBe(count); // dropped-row control
    expect([...idx, idx[0]!].map(stateRowString)).not.toEqual(idx.map(stateRowString));
  });
});

/* ------------------------------------------------------------------ */
/* 4. Pure-data advance helpers (P_SetMobjState / P_MobjThinker)        */
/* ------------------------------------------------------------------ */

describe('M7-01 advance helpers (0-tic chain rules, R06 §1)', () => {
  it('stateAt bounds are hard errors', () => {
    expect(() => stateAt(-1)).toThrow(RangeError);
    expect(() => stateAt(NUMSTATES)).toThrow(RangeError);
    expect(() => stateAt(1.5)).toThrow(RangeError);
    expect(() => stateAdvance(0, -1)).toThrow(RangeError);
    expect(() => stateAdvance(0, 0.5)).toThrow(RangeError);
  });

  it('every 0-tic row terminates in ≤2 pure steps (no action needed)', () => {
    expect(SOURCE_ZERO_TIC_STATES).toEqual([1, 54, 62, 73, 255, 335, 339, 711]);
    expect(maxPureChainLength()).toBe(SOURCE_MAX_PURE_CHAIN);
    for (const id of SOURCE_ZERO_TIC_STATES) {
      const c = setStateChain(id);
      expect(c.steps.length, STATE_NAMES[id]).toBeLessThanOrEqual(SOURCE_MAX_PURE_CHAIN);
      expect(c.steps[0]!.state).toBe(id);
      expect(c.steps[0]!.tics).toBe(0);
    }
  });

  it('S_LIGHTDONE is the one 0-tic row that removes (next = S_NULL)', () => {
    const c = setStateChain(S_ID('S_LIGHTDONE'));
    expect(c.alive).toBe(false);
    expect(c.state).toBe(S.S_NULL);
    expect(c.steps).toHaveLength(1);
    expect(stateAdvance(S_ID('S_LIGHTDONE'), 0).id).toBe(S.S_NULL);
  });

  it('the 0-tic weapon chains land back on the ready state in ONE call', () => {
    for (const [atk, ready] of [['S_CHAIN3', 'S_CHAIN'], ['S_MISSILE3', 'S_MISSILE'], ['S_SAW3', 'S_SAW']] as const) {
      const c = setStateChain(S_ID(atk));
      expect(c.alive, atk).toBe(true);
      expect(c.state).toBe(S_ID(ready));
      expect(c.steps.map((s) => s.state)).toEqual([S_ID(atk), S_ID(ready)]);
      expect(stateAdvance(S_ID(atk), 0).id).toBe(S_ID(ready));
    }
  });

  it('monster 0-tic entries chain into the next state (A_VileStart, A_FaceTarget, A_PainAttack)', () => {
    for (const [from, to] of [['S_VILE_ATK1', 'S_VILE_ATK2'], ['S_SKEL_FIST1', 'S_SKEL_FIST2'], ['S_SKEL_MISS1', 'S_SKEL_MISS2'], ['S_PAIN_ATK4', 'S_PAIN_RUN1']] as const) {
      const c = setStateChain(S_ID(from));
      expect(c.steps.map((s) => s.state)).toEqual([S_ID(from), S_ID(to)]);
      expect(c.tics).toBe(stateAt(S_ID(to)).tics);
    }
  });

  it('actions may override tics (callback contract) and re-open the cascade', () => {
    // A_PlayerScream-style: force 0 tics on S_PLAY_DIE2 and watch the chain
    // run through DIE3 inside the same call.
    const c = setStateChain(S_ID('S_PLAY_DIE2'), (state) => (state === S_ID('S_PLAY_DIE2') ? 0 : undefined));
    expect(c.state).toBe(S_ID('S_PLAY_DIE3'));
    expect(c.steps.map((s) => s.state)).toEqual([S_ID('S_PLAY_DIE2'), S_ID('S_PLAY_DIE3')]);
    // an action that returns a tic count stops the walk with that count:
    const d = setStateChain(S_ID('S_PLAY_DIE2'), () => 7);
    expect(d.tics).toBe(7);
    expect(d.steps).toHaveLength(1);
  });

  it('the cascade guard fires where vanilla would hang', () => {
    // A_Chase self-cycles with 0 tics → the pure table terminates (tics 3) but
    // an action that always returns 0 never lands: MAX_STATE_CHAIN catches it.
    expect(() => setStateChain(S_ID('S_TROO_RUN1'), () => 0)).toThrow(/cascade exceeded/);
    expect(setStateChain(S_ID('S_TROO_RUN1')).steps).toHaveLength(1);
    expect(MAX_STATE_CHAIN).toBe(1024);
  });

  it('stateAdvance walks the run cycle, forever states, and death-to-NULL', () => {
    const run = [S_ID('S_PLAY_RUN1'), S_ID('S_PLAY_RUN2'), S_ID('S_PLAY_RUN3'), S_ID('S_PLAY_RUN4')];
    for (const [tic, step] of [[0, 0], [3, 0], [4, 1], [7, 1], [8, 2], [12, 3], [16, 0], [20, 1]] as const) {
      expect(stateAdvance(run[0]!, tic).id, `tic ${tic}`).toBe(run[step]!);
    }
    expect(stateAdvance(S_ID('S_PLAY'), 1000).id).toBe(S_ID('S_PLAY')); // tics -1
    expect(stateAdvance(S_ID('S_PLAY_DIE7'), 50).id).toBe(S_ID('S_PLAY_DIE7'));
    expect(stateAdvance(S_ID('S_PLAY_DIE1'), 10).id).toBe(S_ID('S_PLAY_DIE2'));
    expect(stateAdvance(S_ID('S_PLAY_DIE1'), 11).id).toBe(S_ID('S_PLAY_DIE2'));
    expect(stateAdvance(S_ID('S_PUFF3'), 20).id).toBe(S.S_NULL); // PUFF4 → S_NULL
    expect(stateAdvance(S_ID('S_EXPLODE1'), 0).id).toBe(S_ID('S_EXPLODE1'));
    expect(stateAdvance(S_ID('S_SKEL_FIST1'), 0).id).toBe(S_ID('S_SKEL_FIST2')); // 0-tic at t=0
    expect(stateAdvance(S_ID('S_SKEL_FIST1'), 6).id).toBe(S_ID('S_SKEL_FIST3'));
  });
});

/* ------------------------------------------------------------------ */
/* 5. Optional: row-by-row diff against a source mirror                */
/* ------------------------------------------------------------------ */

describe.skipIf(MIRROR === undefined || !existsSync(MIRROR))('M7-01 mirror diff', () => {
  it('every row equals the parsed info.c line', async () => {
    const mod = await import(/* @vite-ignore */ new URL(`../../../scripts/extract-info-tables.mjs`, import.meta.url).href);
    const t = mod.extractTables(MIRROR as string);
    const sname: string[] = [];
    (t.statenum as string[]).forEach((n: string, i: number) => { sname[i] = n; });
    expect(t.statenum as string[]).toEqual(STATE_NAMES); // info.h order (NUMSTATES marker trimmed)
    expect(t.mobjinfo.length).toBe(NUMMOBJTYPES);
    expect(t.sprnames).toEqual([...sprnames]);
    const sdiff: string[] = [];
    (t.states as Record<string, unknown>[]).forEach((r, i) => {
      const want = [r.sprite, r.frame, r.tics, r.actionId, sname[r.nextIdx as number], r.misc1, r.misc2].join(',');
      if (want !== stateRowString(i)) sdiff.push(`${sname[i]}:\n  mirror ${want}\n  table  ${stateRowString(i)}`);
    });
    expect(sdiff.slice(0, 12)).toEqual([]);
    const mdiff: string[] = [];
    (t.mobjinfo as Record<string, unknown>[]).forEach((r, i) => {
      const want = [
        r.doomednum, sname[r.spawnState as number], r.spawnHealth, sname[r.seeState as number], r.seeSound,
        r.reactionTime, r.attackSound, sname[r.painState as number], r.painChance, r.painSound,
        sname[r.meleeState as number], sname[r.missileState as number], sname[r.deathState as number],
        sname[r.xdeathState as number], r.deathSound, r.speed, r.radius, r.height, r.mass, r.damage,
        r.activeSound, r.flags, sname[r.raiseState as number],
      ].join(',');
      if (want !== mobjRowString(i)) mdiff.push(`${sname[i] ?? i}:\n  mirror ${want}\n  table  ${mobjRowString(i)}`);
    });
    expect(mdiff.slice(0, 12)).toEqual([]);
    const wdiff: string[] = [];
    (t.weaponinfo as Record<string, unknown>[]).forEach((r, i) => {
      const want = [
        (t.ammo as string[])[r.ammo as number], sname[r.upState as number], sname[r.downState as number],
        sname[r.readyState as number], sname[r.atkState as number], sname[r.flashState as number],
      ].join(',');
      if (want !== weaponRowString(i)) wdiff.push(`weapon ${i}: mirror ${want} table ${weaponRowString(i)}`);
    });
    expect(wdiff).toEqual([]);
  });
});
