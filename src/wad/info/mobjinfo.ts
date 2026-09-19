// wad/info/mobjinfo.ts — the mobjinfo[] table of info.c (linuxdoom-1.10),
// transcribed verbatim; 137 entries in MT_ enum order (info.h mobjtype_t), so
// `type` indexes work directly (R06 §3/§10). MF_* bit constants from
// p_mobj.h:120-201. Sounds stay opaque sfx_* name tokens (audio is M10; the
// M7-06 sfx slot resolves them). Radius/height/speed raw fixed-point ints
// (n*FRACUNIT evaluated). doomednum→MT_ spawn map = first-match scan order,
// matching vanilla P_SpawnMapThing's linear search (p_mobj.c:704+, R06 §6).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/** info.h mobjtype_t NUMMOBJTYPES. */
export const NUMMOBJTYPES = 137

/** p_mobj.h:120-201 — mobj_t flags (i32-safe; MF_TRANSLATION spans bits 26-27). */
export const MF = {
  MF_SPECIAL: 1,
  MF_SOLID: 2,
  MF_SHOOTABLE: 4,
  MF_NOSECTOR: 8,
  MF_NOBLOCKMAP: 16,
  MF_AMBUSH: 32,
  MF_JUSTHIT: 64,
  MF_JUSTATTACKED: 128,
  MF_SPAWNCEILING: 256,
  MF_NOGRAVITY: 512,
  MF_DROPOFF: 1024,
  MF_PICKUP: 2048,
  MF_NOCLIP: 4096,
  MF_SLIDE: 8192,
  MF_FLOAT: 16384,
  MF_TELEPORT: 32768,
  MF_MISSILE: 65536,
  MF_DROPPED: 131072,
  MF_SHADOW: 262144,
  MF_NOBLOOD: 524288,
  MF_CORPSE: 1048576,
  MF_INFLOAT: 2097152,
  MF_COUNTKILL: 4194304,
  MF_COUNTITEM: 8388608,
  MF_SKULLFLY: 16777216,
  MF_NOTDMATCH: 33554432,
  MF_TRANSLATION: 201326592,
} as const
export const MF_TRANSSHIFT = 26

/** mobjtype_t with explicit values (array index order). */
export const MT = {
  MT_PLAYER:            0,
  MT_POSSESSED:         1,
  MT_SHOTGUY:           2,
  MT_VILE:              3,
  MT_FIRE:              4,
  MT_UNDEAD:            5,
  MT_TRACER:            6,
  MT_SMOKE:             7,
  MT_FATSO:             8,
  MT_FATSHOT:           9,
  MT_CHAINGUY:          10,
  MT_TROOP:             11,
  MT_SERGEANT:          12,
  MT_SHADOWS:           13,
  MT_HEAD:              14,
  MT_BRUISER:           15,
  MT_BRUISERSHOT:       16,
  MT_KNIGHT:            17,
  MT_SKULL:             18,
  MT_SPIDER:            19,
  MT_BABY:              20,
  MT_CYBORG:            21,
  MT_PAIN:              22,
  MT_WOLFSS:            23,
  MT_KEEN:              24,
  MT_BOSSBRAIN:         25,
  MT_BOSSSPIT:          26,
  MT_BOSSTARGET:        27,
  MT_SPAWNSHOT:         28,
  MT_SPAWNFIRE:         29,
  MT_BARREL:            30,
  MT_TROOPSHOT:         31,
  MT_HEADSHOT:          32,
  MT_ROCKET:            33,
  MT_PLASMA:            34,
  MT_BFG:               35,
  MT_ARACHPLAZ:         36,
  MT_PUFF:              37,
  MT_BLOOD:             38,
  MT_TFOG:              39,
  MT_IFOG:              40,
  MT_TELEPORTMAN:       41,
  MT_EXTRABFG:          42,
  MT_MISC0:             43,
  MT_MISC1:             44,
  MT_MISC2:             45,
  MT_MISC3:             46,
  MT_MISC4:             47,
  MT_MISC5:             48,
  MT_MISC6:             49,
  MT_MISC7:             50,
  MT_MISC8:             51,
  MT_MISC9:             52,
  MT_MISC10:            53,
  MT_MISC11:            54,
  MT_MISC12:            55,
  MT_INV:               56,
  MT_MISC13:            57,
  MT_INS:               58,
  MT_MISC14:            59,
  MT_MISC15:            60,
  MT_MISC16:            61,
  MT_MEGA:              62,
  MT_CLIP:              63,
  MT_MISC17:            64,
  MT_MISC18:            65,
  MT_MISC19:            66,
  MT_MISC20:            67,
  MT_MISC21:            68,
  MT_MISC22:            69,
  MT_MISC23:            70,
  MT_MISC24:            71,
  MT_MISC25:            72,
  MT_CHAINGUN:          73,
  MT_MISC26:            74,
  MT_MISC27:            75,
  MT_MISC28:            76,
  MT_SHOTGUN:           77,
  MT_SUPERSHOTGUN:      78,
  MT_MISC29:            79,
  MT_MISC30:            80,
  MT_MISC31:            81,
  MT_MISC32:            82,
  MT_MISC33:            83,
  MT_MISC34:            84,
  MT_MISC35:            85,
  MT_MISC36:            86,
  MT_MISC37:            87,
  MT_MISC38:            88,
  MT_MISC39:            89,
  MT_MISC40:            90,
  MT_MISC41:            91,
  MT_MISC42:            92,
  MT_MISC43:            93,
  MT_MISC44:            94,
  MT_MISC45:            95,
  MT_MISC46:            96,
  MT_MISC47:            97,
  MT_MISC48:            98,
  MT_MISC49:            99,
  MT_MISC50:            100,
  MT_MISC51:            101,
  MT_MISC52:            102,
  MT_MISC53:            103,
  MT_MISC54:            104,
  MT_MISC55:            105,
  MT_MISC56:            106,
  MT_MISC57:            107,
  MT_MISC58:            108,
  MT_MISC59:            109,
  MT_MISC60:            110,
  MT_MISC61:            111,
  MT_MISC62:            112,
  MT_MISC63:            113,
  MT_MISC64:            114,
  MT_MISC65:            115,
  MT_MISC66:            116,
  MT_MISC67:            117,
  MT_MISC68:            118,
  MT_MISC69:            119,
  MT_MISC70:            120,
  MT_MISC71:            121,
  MT_MISC72:            122,
  MT_MISC73:            123,
  MT_MISC74:            124,
  MT_MISC75:            125,
  MT_MISC76:            126,
  MT_MISC77:            127,
  MT_MISC78:            128,
  MT_MISC79:            129,
  MT_MISC80:            130,
  MT_MISC81:            131,
  MT_MISC82:            132,
  MT_MISC83:            133,
  MT_MISC84:            134,
  MT_MISC85:            135,
  MT_MISC86:            136,
} as const
export type MobjType = (typeof MT)[keyof typeof MT]

/** mobjinfo_t (info.h:1305+), 23 fields, states as stateIds, sounds as names. */
export interface MobjInfo {
  doomednum: number
  spawnState: number
  spawnHealth: number
  seeState: number
  seeSound: string
  reactionTime: number
  attackSound: string
  painState: number
  painChance: number
  painSound: string
  meleeState: number
  missileState: number
  deathState: number
  xdeathState: number
  deathSound: string
  speed: number
  radius: number
  height: number
  mass: number
  damage: number
  activeSound: string
  flags: number
  raiseState: number
}

/** mobjinfo[NUMMOBJTYPES] — index === MT_* (source order preserved). */
export const mobjinfo: readonly MobjInfo[] = [
  { doomednum: -1, spawnState: 149, spawnHealth: 100, seeState: 150, seeSound: 'sfx_None', reactionTime: 0, attackSound: 'sfx_None', painState: 156, painChance: 255, painSound: 'sfx_plpain', meleeState: 0, missileState: 154, deathState: 158, xdeathState: 165, deathSound: 'sfx_pldeth', speed: 0, radius: 1048576, height: 3670016, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 33557510, raiseState: 0 }, // MT_PLAYER
  { doomednum: 3004, spawnState: 174, spawnHealth: 20, seeState: 176, seeSound: 'sfx_posit1', reactionTime: 8, attackSound: 'sfx_pistol', painState: 187, painChance: 200, painSound: 'sfx_popain', meleeState: 0, missileState: 184, deathState: 189, xdeathState: 194, deathSound: 'sfx_podth1', speed: 8, radius: 1310720, height: 3670016, mass: 100, damage: 0, activeSound: 'sfx_posact', flags: 4194310, raiseState: 203 }, // MT_POSSESSED
  { doomednum: 9, spawnState: 207, spawnHealth: 30, seeState: 209, seeSound: 'sfx_posit2', reactionTime: 8, attackSound: '0', painState: 220, painChance: 170, painSound: 'sfx_popain', meleeState: 0, missileState: 217, deathState: 222, xdeathState: 227, deathSound: 'sfx_podth2', speed: 8, radius: 1310720, height: 3670016, mass: 100, damage: 0, activeSound: 'sfx_posact', flags: 4194310, raiseState: 236 }, // MT_SHOTGUY
  { doomednum: 64, spawnState: 241, spawnHealth: 700, seeState: 243, seeSound: 'sfx_vilsit', reactionTime: 8, attackSound: '0', painState: 269, painChance: 10, painSound: 'sfx_vipain', meleeState: 0, missileState: 255, deathState: 271, xdeathState: 0, deathSound: 'sfx_vildth', speed: 15, radius: 1310720, height: 3670016, mass: 500, damage: 0, activeSound: 'sfx_vilact', flags: 4194310, raiseState: 0 }, // MT_VILE
  { doomednum: -1, spawnState: 281, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 528, raiseState: 0 }, // MT_FIRE
  { doomednum: 66, spawnState: 321, spawnHealth: 300, seeState: 323, seeSound: 'sfx_skesit', reactionTime: 8, attackSound: '0', painState: 343, painChance: 100, painSound: 'sfx_popain', meleeState: 335, missileState: 339, deathState: 345, xdeathState: 0, deathSound: 'sfx_skedth', speed: 10, radius: 1310720, height: 3670016, mass: 500, damage: 0, activeSound: 'sfx_skeact', flags: 4194310, raiseState: 351 }, // MT_UNDEAD
  { doomednum: -1, spawnState: 316, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_skeatk', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 318, xdeathState: 0, deathSound: 'sfx_barexp', speed: 655360, radius: 720896, height: 524288, mass: 100, damage: 10, activeSound: 'sfx_None', flags: 67088, raiseState: 0 }, // MT_TRACER
  { doomednum: -1, spawnState: 311, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 528, raiseState: 0 }, // MT_SMOKE
  { doomednum: 67, spawnState: 362, spawnHealth: 600, seeState: 364, seeSound: 'sfx_mansit', reactionTime: 8, attackSound: '0', painState: 386, painChance: 80, painSound: 'sfx_mnpain', meleeState: 0, missileState: 376, deathState: 388, xdeathState: 0, deathSound: 'sfx_mandth', speed: 8, radius: 3145728, height: 4194304, mass: 1000, damage: 0, activeSound: 'sfx_posact', flags: 4194310, raiseState: 398 }, // MT_FATSO
  { doomednum: -1, spawnState: 357, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_firsht', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 359, xdeathState: 0, deathSound: 'sfx_firxpl', speed: 1310720, radius: 393216, height: 524288, mass: 100, damage: 8, activeSound: 'sfx_None', flags: 67088, raiseState: 0 }, // MT_FATSHOT
  { doomednum: 65, spawnState: 406, spawnHealth: 70, seeState: 408, seeSound: 'sfx_posit2', reactionTime: 8, attackSound: '0', painState: 420, painChance: 170, painSound: 'sfx_popain', meleeState: 0, missileState: 416, deathState: 422, xdeathState: 429, deathSound: 'sfx_podth2', speed: 8, radius: 1310720, height: 3670016, mass: 100, damage: 0, activeSound: 'sfx_posact', flags: 4194310, raiseState: 435 }, // MT_CHAINGUY
  { doomednum: 3001, spawnState: 442, spawnHealth: 60, seeState: 444, seeSound: 'sfx_bgsit1', reactionTime: 8, attackSound: '0', painState: 455, painChance: 200, painSound: 'sfx_popain', meleeState: 452, missileState: 452, deathState: 457, xdeathState: 462, deathSound: 'sfx_bgdth1', speed: 8, radius: 1310720, height: 3670016, mass: 100, damage: 0, activeSound: 'sfx_bgact', flags: 4194310, raiseState: 470 }, // MT_TROOP
  { doomednum: 3002, spawnState: 475, spawnHealth: 150, seeState: 477, seeSound: 'sfx_sgtsit', reactionTime: 8, attackSound: 'sfx_sgtatk', painState: 488, painChance: 180, painSound: 'sfx_dmpain', meleeState: 485, missileState: 0, deathState: 490, xdeathState: 0, deathSound: 'sfx_sgtdth', speed: 10, radius: 1966080, height: 3670016, mass: 400, damage: 0, activeSound: 'sfx_dmact', flags: 4194310, raiseState: 496 }, // MT_SERGEANT
  { doomednum: 58, spawnState: 475, spawnHealth: 150, seeState: 477, seeSound: 'sfx_sgtsit', reactionTime: 8, attackSound: 'sfx_sgtatk', painState: 488, painChance: 180, painSound: 'sfx_dmpain', meleeState: 485, missileState: 0, deathState: 490, xdeathState: 0, deathSound: 'sfx_sgtdth', speed: 10, radius: 1966080, height: 3670016, mass: 400, damage: 0, activeSound: 'sfx_dmact', flags: 4456454, raiseState: 496 }, // MT_SHADOWS
  { doomednum: 3005, spawnState: 502, spawnHealth: 400, seeState: 503, seeSound: 'sfx_cacsit', reactionTime: 8, attackSound: '0', painState: 507, painChance: 128, painSound: 'sfx_dmpain', meleeState: 0, missileState: 504, deathState: 510, xdeathState: 0, deathSound: 'sfx_cacdth', speed: 8, radius: 2031616, height: 3670016, mass: 400, damage: 0, activeSound: 'sfx_dmact', flags: 4211206, raiseState: 516 }, // MT_HEAD
  { doomednum: 3003, spawnState: 527, spawnHealth: 1000, seeState: 529, seeSound: 'sfx_brssit', reactionTime: 8, attackSound: '0', painState: 540, painChance: 50, painSound: 'sfx_dmpain', meleeState: 537, missileState: 537, deathState: 542, xdeathState: 0, deathSound: 'sfx_brsdth', speed: 8, radius: 1572864, height: 4194304, mass: 1000, damage: 0, activeSound: 'sfx_dmact', flags: 4194310, raiseState: 549 }, // MT_BRUISER
  { doomednum: -1, spawnState: 522, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_firsht', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 524, xdeathState: 0, deathSound: 'sfx_firxpl', speed: 983040, radius: 393216, height: 524288, mass: 100, damage: 8, activeSound: 'sfx_None', flags: 67088, raiseState: 0 }, // MT_BRUISERSHOT
  { doomednum: 69, spawnState: 556, spawnHealth: 500, seeState: 558, seeSound: 'sfx_kntsit', reactionTime: 8, attackSound: '0', painState: 569, painChance: 50, painSound: 'sfx_dmpain', meleeState: 566, missileState: 566, deathState: 571, xdeathState: 0, deathSound: 'sfx_kntdth', speed: 8, radius: 1572864, height: 4194304, mass: 1000, damage: 0, activeSound: 'sfx_dmact', flags: 4194310, raiseState: 578 }, // MT_KNIGHT
  { doomednum: 3006, spawnState: 585, spawnHealth: 100, seeState: 587, seeSound: '0', reactionTime: 8, attackSound: 'sfx_sklatk', painState: 593, painChance: 256, painSound: 'sfx_dmpain', meleeState: 0, missileState: 589, deathState: 595, xdeathState: 0, deathSound: 'sfx_firxpl', speed: 8, radius: 1048576, height: 3670016, mass: 50, damage: 3, activeSound: 'sfx_dmact', flags: 16902, raiseState: 0 }, // MT_SKULL
  { doomednum: 7, spawnState: 601, spawnHealth: 3000, seeState: 603, seeSound: 'sfx_spisit', reactionTime: 8, attackSound: 'sfx_shotgn', painState: 619, painChance: 40, painSound: 'sfx_dmpain', meleeState: 0, missileState: 615, deathState: 621, xdeathState: 0, deathSound: 'sfx_spidth', speed: 12, radius: 8388608, height: 6553600, mass: 1000, damage: 0, activeSound: 'sfx_dmact', flags: 4194310, raiseState: 0 }, // MT_SPIDER
  { doomednum: 68, spawnState: 632, spawnHealth: 500, seeState: 634, seeSound: 'sfx_bspsit', reactionTime: 8, attackSound: '0', painState: 651, painChance: 128, painSound: 'sfx_dmpain', meleeState: 0, missileState: 647, deathState: 653, xdeathState: 0, deathSound: 'sfx_bspdth', speed: 12, radius: 4194304, height: 4194304, mass: 600, damage: 0, activeSound: 'sfx_bspact', flags: 4194310, raiseState: 660 }, // MT_BABY
  { doomednum: 16, spawnState: 674, spawnHealth: 4000, seeState: 676, seeSound: 'sfx_cybsit', reactionTime: 8, attackSound: '0', painState: 690, painChance: 20, painSound: 'sfx_dmpain', meleeState: 0, missileState: 684, deathState: 691, xdeathState: 0, deathSound: 'sfx_cybdth', speed: 16, radius: 2621440, height: 7208960, mass: 1000, damage: 0, activeSound: 'sfx_dmact', flags: 4194310, raiseState: 0 }, // MT_CYBORG
  { doomednum: 71, spawnState: 701, spawnHealth: 400, seeState: 702, seeSound: 'sfx_pesit', reactionTime: 8, attackSound: '0', painState: 712, painChance: 128, painSound: 'sfx_pepain', meleeState: 0, missileState: 708, deathState: 714, xdeathState: 0, deathSound: 'sfx_pedth', speed: 8, radius: 2031616, height: 3670016, mass: 400, damage: 0, activeSound: 'sfx_dmact', flags: 4211206, raiseState: 720 }, // MT_PAIN
  { doomednum: 84, spawnState: 726, spawnHealth: 50, seeState: 728, seeSound: 'sfx_sssit', reactionTime: 8, attackSound: '0', painState: 742, painChance: 170, painSound: 'sfx_popain', meleeState: 0, missileState: 736, deathState: 744, xdeathState: 749, deathSound: 'sfx_ssdth', speed: 8, radius: 1310720, height: 3670016, mass: 100, damage: 0, activeSound: 'sfx_posact', flags: 4194310, raiseState: 758 }, // MT_WOLFSS
  { doomednum: 72, spawnState: 763, spawnHealth: 100, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 776, painChance: 256, painSound: 'sfx_keenpn', meleeState: 0, missileState: 0, deathState: 764, xdeathState: 0, deathSound: 'sfx_keendt', speed: 0, radius: 1048576, height: 4718592, mass: 10000000, damage: 0, activeSound: 'sfx_None', flags: 4195078, raiseState: 0 }, // MT_KEEN
  { doomednum: 88, spawnState: 778, spawnHealth: 250, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 779, painChance: 255, painSound: 'sfx_bospn', meleeState: 0, missileState: 0, deathState: 780, xdeathState: 0, deathSound: 'sfx_bosdth', speed: 0, radius: 1048576, height: 1048576, mass: 10000000, damage: 0, activeSound: 'sfx_None', flags: 6, raiseState: 0 }, // MT_BOSSBRAIN
  { doomednum: 89, spawnState: 784, spawnHealth: 1000, seeState: 785, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 2097152, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 24, raiseState: 0 }, // MT_BOSSSPIT
  { doomednum: 87, spawnState: 0, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 2097152, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 24, raiseState: 0 }, // MT_BOSSTARGET
  { doomednum: -1, spawnState: 787, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_bospit', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_firxpl', speed: 655360, radius: 393216, height: 2097152, mass: 100, damage: 3, activeSound: 'sfx_None', flags: 71184, raiseState: 0 }, // MT_SPAWNSHOT
  { doomednum: -1, spawnState: 791, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 528, raiseState: 0 }, // MT_SPAWNFIRE
  { doomednum: 2035, spawnState: 806, spawnHealth: 20, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 808, xdeathState: 0, deathSound: 'sfx_barexp', speed: 0, radius: 655360, height: 2752512, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 524294, raiseState: 0 }, // MT_BARREL
  { doomednum: -1, spawnState: 97, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_firsht', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 99, xdeathState: 0, deathSound: 'sfx_firxpl', speed: 655360, radius: 393216, height: 524288, mass: 100, damage: 3, activeSound: 'sfx_None', flags: 67088, raiseState: 0 }, // MT_TROOPSHOT
  { doomednum: -1, spawnState: 102, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_firsht', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 104, xdeathState: 0, deathSound: 'sfx_firxpl', speed: 655360, radius: 393216, height: 524288, mass: 100, damage: 5, activeSound: 'sfx_None', flags: 67088, raiseState: 0 }, // MT_HEADSHOT
  { doomednum: -1, spawnState: 114, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_rlaunc', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 127, xdeathState: 0, deathSound: 'sfx_barexp', speed: 1310720, radius: 720896, height: 524288, mass: 100, damage: 20, activeSound: 'sfx_None', flags: 67088, raiseState: 0 }, // MT_ROCKET
  { doomednum: -1, spawnState: 107, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_plasma', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 109, xdeathState: 0, deathSound: 'sfx_firxpl', speed: 1638400, radius: 851968, height: 524288, mass: 100, damage: 5, activeSound: 'sfx_None', flags: 67088, raiseState: 0 }, // MT_PLASMA
  { doomednum: -1, spawnState: 115, spawnHealth: 1000, seeState: 0, seeSound: '0', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 117, xdeathState: 0, deathSound: 'sfx_rxplod', speed: 1638400, radius: 851968, height: 524288, mass: 100, damage: 100, activeSound: 'sfx_None', flags: 67088, raiseState: 0 }, // MT_BFG
  { doomednum: -1, spawnState: 667, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_plasma', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 669, xdeathState: 0, deathSound: 'sfx_firxpl', speed: 1638400, radius: 851968, height: 524288, mass: 100, damage: 5, activeSound: 'sfx_None', flags: 67088, raiseState: 0 }, // MT_ARACHPLAZ
  { doomednum: -1, spawnState: 93, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 528, raiseState: 0 }, // MT_PUFF
  { doomednum: -1, spawnState: 90, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 16, raiseState: 0 }, // MT_BLOOD
  { doomednum: -1, spawnState: 130, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 528, raiseState: 0 }, // MT_TFOG
  { doomednum: -1, spawnState: 142, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 528, raiseState: 0 }, // MT_IFOG
  { doomednum: 14, spawnState: 0, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 24, raiseState: 0 }, // MT_TELEPORTMAN
  { doomednum: -1, spawnState: 123, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 528, raiseState: 0 }, // MT_EXTRABFG
  { doomednum: 2018, spawnState: 802, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC0
  { doomednum: 2019, spawnState: 804, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC1
  { doomednum: 2014, spawnState: 816, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 8388609, raiseState: 0 }, // MT_MISC2
  { doomednum: 2015, spawnState: 822, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 8388609, raiseState: 0 }, // MT_MISC3
  { doomednum: 5, spawnState: 828, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 33554433, raiseState: 0 }, // MT_MISC4
  { doomednum: 13, spawnState: 830, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 33554433, raiseState: 0 }, // MT_MISC5
  { doomednum: 6, spawnState: 832, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 33554433, raiseState: 0 }, // MT_MISC6
  { doomednum: 39, spawnState: 838, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 33554433, raiseState: 0 }, // MT_MISC7
  { doomednum: 38, spawnState: 836, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 33554433, raiseState: 0 }, // MT_MISC8
  { doomednum: 40, spawnState: 834, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 33554433, raiseState: 0 }, // MT_MISC9
  { doomednum: 2011, spawnState: 840, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC10
  { doomednum: 2012, spawnState: 841, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC11
  { doomednum: 2013, spawnState: 842, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 8388609, raiseState: 0 }, // MT_MISC12
  { doomednum: 2022, spawnState: 848, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 8388609, raiseState: 0 }, // MT_INV
  { doomednum: 2023, spawnState: 852, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 8388609, raiseState: 0 }, // MT_MISC13
  { doomednum: 2024, spawnState: 853, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 8388609, raiseState: 0 }, // MT_INS
  { doomednum: 2025, spawnState: 861, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC14
  { doomednum: 2026, spawnState: 862, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 8388609, raiseState: 0 }, // MT_MISC15
  { doomednum: 2045, spawnState: 868, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 8388609, raiseState: 0 }, // MT_MISC16
  { doomednum: 83, spawnState: 857, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 8388609, raiseState: 0 }, // MT_MEGA
  { doomednum: 2007, spawnState: 870, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_CLIP
  { doomednum: 2048, spawnState: 871, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC17
  { doomednum: 2010, spawnState: 872, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC18
  { doomednum: 2046, spawnState: 873, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC19
  { doomednum: 2047, spawnState: 874, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC20
  { doomednum: 17, spawnState: 875, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC21
  { doomednum: 2008, spawnState: 876, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC22
  { doomednum: 2049, spawnState: 877, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC23
  { doomednum: 8, spawnState: 878, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC24
  { doomednum: 2006, spawnState: 879, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC25
  { doomednum: 2002, spawnState: 880, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_CHAINGUN
  { doomednum: 2005, spawnState: 881, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC26
  { doomednum: 2003, spawnState: 882, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC27
  { doomednum: 2004, spawnState: 883, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_MISC28
  { doomednum: 2001, spawnState: 884, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_SHOTGUN
  { doomednum: 82, spawnState: 885, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 1, raiseState: 0 }, // MT_SUPERSHOTGUN
  { doomednum: 85, spawnState: 959, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC29
  { doomednum: 86, spawnState: 963, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC30
  { doomednum: 2028, spawnState: 886, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC31
  { doomednum: 30, spawnState: 907, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC32
  { doomednum: 31, spawnState: 908, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC33
  { doomednum: 32, spawnState: 909, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC34
  { doomednum: 33, spawnState: 910, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC35
  { doomednum: 37, spawnState: 913, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC36
  { doomednum: 36, spawnState: 924, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC37
  { doomednum: 41, spawnState: 917, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC38
  { doomednum: 42, spawnState: 921, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC39
  { doomednum: 43, spawnState: 914, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC40
  { doomednum: 44, spawnState: 926, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC41
  { doomednum: 45, spawnState: 930, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC42
  { doomednum: 46, spawnState: 934, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC43
  { doomednum: 55, spawnState: 938, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC44
  { doomednum: 56, spawnState: 942, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC45
  { doomednum: 57, spawnState: 946, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC46
  { doomednum: 47, spawnState: 906, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC47
  { doomednum: 48, spawnState: 916, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC48
  { doomednum: 34, spawnState: 911, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC49
  { doomednum: 35, spawnState: 912, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC50
  { doomednum: 49, spawnState: 888, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 4456448, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC51
  { doomednum: 50, spawnState: 902, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 5505024, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC52
  { doomednum: 51, spawnState: 903, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 5505024, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC53
  { doomednum: 52, spawnState: 904, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 4456448, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC54
  { doomednum: 53, spawnState: 905, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 3407872, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC55
  { doomednum: 59, spawnState: 902, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 5505024, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 768, raiseState: 0 }, // MT_MISC56
  { doomednum: 60, spawnState: 904, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 4456448, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 768, raiseState: 0 }, // MT_MISC57
  { doomednum: 61, spawnState: 903, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 3407872, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 768, raiseState: 0 }, // MT_MISC58
  { doomednum: 62, spawnState: 905, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 3407872, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 768, raiseState: 0 }, // MT_MISC59
  { doomednum: 63, spawnState: 888, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 4456448, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 768, raiseState: 0 }, // MT_MISC60
  { doomednum: 22, spawnState: 515, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC61
  { doomednum: 15, spawnState: 164, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC62
  { doomednum: 18, spawnState: 193, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC63
  { doomednum: 21, spawnState: 495, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC64
  { doomednum: 23, spawnState: 600, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC65
  { doomednum: 20, spawnState: 461, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC66
  { doomednum: 19, spawnState: 226, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC67
  { doomednum: 10, spawnState: 173, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC68
  { doomednum: 12, spawnState: 173, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC69
  { doomednum: 28, spawnState: 894, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC70
  { doomednum: 24, spawnState: 895, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 0, raiseState: 0 }, // MT_MISC71
  { doomednum: 27, spawnState: 896, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC72
  { doomednum: 29, spawnState: 897, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC73
  { doomednum: 25, spawnState: 899, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC74
  { doomednum: 26, spawnState: 900, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC75
  { doomednum: 54, spawnState: 915, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 2097152, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC76
  { doomednum: 70, spawnState: 813, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 2, raiseState: 0 }, // MT_MISC77
  { doomednum: 73, spawnState: 950, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 5767168, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC78
  { doomednum: 74, spawnState: 951, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 5767168, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC79
  { doomednum: 75, spawnState: 952, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 4194304, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC80
  { doomednum: 76, spawnState: 953, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 4194304, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC81
  { doomednum: 77, spawnState: 954, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 4194304, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC82
  { doomednum: 78, spawnState: 955, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1048576, height: 4194304, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 770, raiseState: 0 }, // MT_MISC83
  { doomednum: 79, spawnState: 956, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 16, raiseState: 0 }, // MT_MISC84
  { doomednum: 80, spawnState: 957, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 16, raiseState: 0 }, // MT_MISC85
  { doomednum: 81, spawnState: 958, spawnHealth: 1000, seeState: 0, seeSound: 'sfx_None', reactionTime: 8, attackSound: 'sfx_None', painState: 0, painChance: 0, painSound: 'sfx_None', meleeState: 0, missileState: 0, deathState: 0, xdeathState: 0, deathSound: 'sfx_None', speed: 0, radius: 1310720, height: 1048576, mass: 100, damage: 0, activeSound: 'sfx_None', flags: 16, raiseState: 0 }, // MT_MISC86
]

/** doomednum → first MT_ with that doomednum (vanilla spawn-scan semantics;
 *  doomednum -1 excluded). Unknown doomednums: callers warn+skip (R12). */
export const DOOMEDNUM_TO_MT: ReadonlyMap<number, number> = new Map(
  mobjinfo.flatMap((m, i) => (m.doomednum !== -1 ? [[m.doomednum, i] as const] : [])).reduce((acc, e) => {
    if (!acc.some((p) => p[0] === e[0])) acc.push(e)
    return acc
  }, [] as [number, number][]),
)

/** Number of spawnable (doomednum != -1) entries. */
export const NUM_SPAWNABLE_MOBJS = mobjinfo.filter((m) => m.doomednum !== -1).length
