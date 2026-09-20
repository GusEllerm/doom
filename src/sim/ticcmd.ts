// sim/ticcmd.ts — per-tic player command + the input→ticcmd sampler
// (d_ticcmd.h `ticcmd_t`, g_game.c `G_BuildTiccmd` + its tuning tables).
//
// Fields are plain ints in the vanilla ranges (d_ticcmd.h:35-42):
//   forwardmove  int8   "*2048 for move"   (consumed by P_Thrust in M2-07)
//   sidemove     int8   "*2048 for move"
//   angleturn    int16  "<<16 for angle delta" — P_MovePlayer (p_user.c)
//                      does `mo->angle += cmd->angleturn << 16` (BAM), i.e.
//                      640 = 640*65536 / 2^32 turns per tic ≈ 3.5°/tic
//                      (NOT any other shift — pinned from d_ticcmd.h:39 and
//                      p_user.c P_MovePlayer).
//   buttons      uint8  (d_event.h bt_button_t bits)
// The `consistancy`/`chatchar` netgame fields are omitted (single-player
// skeleton; demo/netcode re-add them in later milestones).
//
// SPDX-License-Identifier: GPL-2.0-or-later

/* ------------------------------------------------------------------ */
/* ticcmd_t (d_ticcmd.h)                                               */
/* ------------------------------------------------------------------ */

/** One sampled command; all sim logic reads only this (ARCHITECTURE §3.5-2). */
export interface Ticcmd {
  /** int8, move strength; P_Thrust multiplies by 2048 (M2-07). */
  forwardmove: number;
  /** int8, strafe strength. */
  sidemove: number;
  /** int16, `<<16` gives the BAM angle delta applied per tic. */
  angleturn: number;
  /** uint8, BT_* bits (d_event.h:75-88). */
  buttons: number;
}

export function createTiccmd(): Ticcmd {
  // vanilla `I_BaseTiccmd()` returns an all-zero ticcmd (g_game.c:225-226
  // `base = I_BaseTiccmd(); memcpy(cmd, base, sizeof *cmd)`).
  return { forwardmove: 0, sidemove: 0, angleturn: 0, buttons: 0 };
}

/* d_event.h:75-88 (button bits) */
export const BT_ATTACK = 1;
export const BT_USE = 2;
export const BT_CHANGE = 4;
export const BT_WEAPONMASK = 8 + 16 + 32;
export const BT_WEAPONSHIFT = 3;
export const BT_SPECIAL = 128;

/* ------------------------------------------------------------------ */
/* g_game.c movement tuning tables (g_game.c:171-179)                  */
/* ------------------------------------------------------------------ */

/** g_game.c:175 `fixed_t forwardmove[2] = {0x19, 0x32}` (25 / 50). */
export const FORWARDMOVE: readonly [number, number] = [0x19, 0x32];
/** g_game.c:176 `fixed_t sidemove[2] = {0x18, 0x28}` (24 / 40). */
export const SIDEMOVE: readonly [number, number] = [0x18, 0x28];
/** g_game.c:177 `fixed_t angleturn[3] = {640, 1280, 320}`; index 2 = slow. */
export const ANGLETURN: readonly [number, number, number] = [640, 1280, 320];
/** g_game.c:179 `#define SLOWTURNTICS 6` — tics before turn speed ramps. */
export const SLOWTURNTICS = 6;
/** g_game.c:171 `#define MAXPLMOVE forwardmove[1]` (= 50). */
export const MAXPLMOVE = FORWARDMOVE[1];
/** d_net.c `ticdup` — single player is always 1 (ARCHITECTURE §3.1). */
export const TICDUP = 1;

/* ------------------------------------------------------------------ */
/* GameInput — platform-supplied per-tic input snapshot                */
/* ------------------------------------------------------------------ */

/**
 * The semantic stand-in for vanilla's `gamekeydown[]` probes in
 * G_BuildTiccmd (g_game.c:223+) plus the two mouse-delta channels (M5-07).
 * The platform layer resolves keys/mouse into these fields; the sim never
 * sees keycodes or DOM events. Joystick channels (`joyxmove`/`joyymove`)
 * and double-click-to-use remain out of scope — see DEVIATIONS.
 */
export interface GameInput {
  /** Left/strafe-left key (vanilla key_left). */
  turnLeft: boolean;
  /** Right/strafe-right key (vanilla key_right). */
  turnRight: boolean;
  /** Forward key (key_up). */
  forward: boolean;
  /** Back key (key_down). */
  backward: boolean;
  /** Strafe-left key (key_strafeleft). */
  strafeLeft: boolean;
  /** Strafe-right key (key_straferight). */
  strafeRight: boolean;
  /** Strafe modifier (key_strafe): makes left/right strafe instead of turn. */
  strafe: boolean;
  /** Speed modifier (key_speed): run / fast turn. */
  speed: boolean;
  /** Fire button (key_fire). */
  attack: boolean;
  /** Use button (key_use). */
  use: boolean;
  /**
   * Weapon-slot keys '1'..'8 (g_game.c:341-347, M7-05): the pressed
   * weapon KEY (0 = fist slot … 7 = chainsaw slot; vanilla loop bound is
   * NUMWEAPONS-1 = 8, the supershotgun has no slot key). First match wins
   * (vanilla `break`). Undefined/-1 = no weapon key. Encoded below as
   * `BT_CHANGE | slot<<BT_WEAPONSHIFT`; the switch itself runs in
   * P_PlayerThink (p_ammo.ts). 1.10 has NO next/prev cycling (R08 §5.1).
   */
  weaponKey?: number;
  /**
   * Mouse X channel — vanilla `int mousex` (g_game.c:190): the sensitivity-
   * SCALED delta (G_Responder's `data2*(mouseSensitivity+5)/10`, applied at
   * the platform translation seam per A-07) accumulated since the last tic.
   * Consumed once: G_BuildTiccmd zeroes it (g_game.c:411); the producer
   * drains its own accumulator in sample().
   */
  mouseX: number;
  /** Mouse Y channel — vanilla `int mousey` (g_game.c:191). Adds FORWARD
   * (g_game.c:405); 1.10 has NO pitch/mouselook anywhere. */
  mouseY: number;
}

export function emptyInput(): GameInput {
  return {
    turnLeft: false,
    turnRight: false,
    forward: false,
    backward: false,
    strafeLeft: false,
    strafeRight: false,
    strafe: false,
    speed: false,
    attack: false,
    use: false,
    mouseX: 0,
    mouseY: 0
  };
}

/** g_game.c:184 `int turnheld;` — two-stage turn acceleration state. */
export interface TurnheldState {
  turnheld: number;
}

/**
 * g_game.c `G_BuildTiccmd` for a single local player, minus the console/net/
 * demo-only parts (consistancy ring, chat char, double-click-use, joystick,
 * weapon-change keys, special buttons). Structure kept verbatim:
 *
 *  - turnheld += ticdup while left/right held, else 0 (g_game.c:267-271);
 *  - tspeed = 2 (slow, 320) while turnheld < SLOWTURNTICS else `speed`
 *    (0 = 640 normal, 1 = 1280 run) (g_game.c:273-276);
 *  - strafe: left/right ADD to sidemove; else SUB/ADD to angleturn
 *    (g_game.c:278-307) — right turns DOWN (angleturn -=), matching BAM
 *    clockwise sign;
 *  - forward/back add/sub forwardmove[speed]; strafeleft/right add to side
 *    regardless of the strafe modifier (g_game.c:309-329);
 *  - mouse channels THEN: `forward += mousey`; strafe ? `side += mousex*2`
 *    : `angleturn -= mousex*0x8` (g_game.c:403-409) — BEFORE the clamp;
 *  - both axes clamped to ±MAXPLMOVE before being ADDED onto the base
 *    (zero) command (g_game.c:371-379).
 */
export function gBuildTiccmd(input: GameInput, turn: TurnheldState): Ticcmd {
  const cmd = createTiccmd();

  const strafe = input.strafe;
  const speed = input.speed ? 1 : 0;

  let forward = 0;
  let side = 0;

  // use two stage accelerative turning on the keyboard (g_game.c:265-276)
  if (input.turnRight || input.turnLeft) turn.turnheld += TICDUP;
  else turn.turnheld = 0;
  const tspeed = turn.turnheld < SLOWTURNTICS ? 2 : speed;

  // let movement keys cancel each other out (g_game.c:279-307)
  if (strafe) {
    if (input.turnRight) side += SIDEMOVE[speed];
    if (input.turnLeft) side -= SIDEMOVE[speed];
  } else {
    if (input.turnRight) cmd.angleturn -= ANGLETURN[tspeed];
    if (input.turnLeft) cmd.angleturn += ANGLETURN[tspeed];
  }

  if (input.forward) forward += FORWARDMOVE[speed];
  if (input.backward) forward -= FORWARDMOVE[speed];
  if (input.strafeRight) side += SIDEMOVE[speed];
  if (input.strafeLeft) side -= SIDEMOVE[speed];

  if (input.attack) cmd.buttons |= BT_ATTACK;
  if (input.use) cmd.buttons |= BT_USE;

  // for choice of weapons (g_game.c:341-347) — first slot key wins:
  //   for (i = 0; i < NUMWEAPONS-1; i++)
  //     if (gamekeydown['1' + i]) { cmd->buttons |= BT_CHANGE | i<<BT_WEAPONSHIFT; break; }
  if (input.weaponKey !== undefined && input.weaponKey >= 0) {
    cmd.buttons |= BT_CHANGE | (input.weaponKey << BT_WEAPONSHIFT);
  }

  // Mouse channels — g_game.c:403-410, positioned EXACTLY between the key
  // accumulation and the clamp (add-then-clamp order pinned: mouse-y joins
  // `forward` BEFORE the ±MAXPLMOVE clamp, so mouse + held-forward key
  // still caps at MAXPLMOVE, never exceeds it):
  //   forward += mousey;                       (g_game.c:405 — NO pitch,
  //   if (strafe) side += mousex*2;            //  mouse-y is forward/back)
  //   else cmd->angleturn -= mousex*0x8;       (g_game.c:407-409; rightward
  // mouse turns angle DOWN, matching the key convention) then
  // `mousex = mousey = 0` (g_game.c:411) — the consumed-once rule lives in
  // the input sampler (input/mouse.ts sample() drains); this function is
  // pure and never mutates `input`.
  forward += input.mouseY;
  if (strafe) side += input.mouseX * 2;
  else cmd.angleturn -= input.mouseX * 0x8;

  // clamp, then add onto the base command (g_game.c:371-379)
  if (forward > MAXPLMOVE) forward = MAXPLMOVE;
  else if (forward < -MAXPLMOVE) forward = -MAXPLMOVE;
  if (side > MAXPLMOVE) side = MAXPLMOVE;
  else if (side < -MAXPLMOVE) side = -MAXPLMOVE;

  cmd.forwardmove += forward;
  cmd.sidemove += side;

  // int8/int16 normalization — vanilla stores into `char`/`short` fields
  // (d_ticcmd.h:36-38). With the ±MAXPLMOVE clamp the moves are already in
  // range; angleturn can legitimately double up (turn+strafe keys) so the
  // int16 wrap matches C's `short` assignment.
  cmd.forwardmove = (cmd.forwardmove << 24) >> 24;
  cmd.sidemove = (cmd.sidemove << 24) >> 24;
  cmd.angleturn = (cmd.angleturn << 16) >> 16;
  cmd.buttons &= 0xff;

  return cmd;
}
