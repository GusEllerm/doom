# Controls

The default table below is THIS PORT'S code, not folklore: the behavior
side lives in [`src/input/mapping.ts`](src/input/mapping.ts)
(`DEFAULT_BINDINGS`, decision A-09) and the data side — the same rows as
readable/writable rows with their `default.cfg` citations — in
[`src/input/bindStore.ts`](src/input/bindStore.ts) (`KEY_VANILLA_VARS`,
`configVars()`). The vanilla-compat column cites
`linuxdoom-1.10/m_misc.c` `defaultvars` (lines 243–253), read at startup
by `M_LoadDefaults`; the WASD letters are this port's additions layered
on top — W/S match the DOS build's `KEY_w`/`KEY_s`, and A/D ARE the
vanilla `key_strafeleft`/`key_straferight` keys, so "A/D strafe" is
vanilla-true.

## Movement & actions (held keys, sampled per 35 Hz tic)

| Key | Action | default.cfg variable (m_misc.c) |
|---|---|---|
| `W` / `↑` | move forward | `key_up` = KEY_UPARROW (:245) |
| `S` / `↓` | move backward | `key_down` = KEY_DOWNARROW (:246) |
| `←` | turn left | `key_left` = KEY_LEFTARROW (:244) |
| `→` | turn right | `key_right` = KEY_RIGHTARROW (:243) |
| `A` / `,` | strafe left | `key_strafeleft` = `','` (:247) |
| `D` / `.` | strafe right | `key_straferight` = `'.'` (:248) |
| `Right Ctrl` | fire weapon | `key_fire` = KEY_RCTRL (:250) |
| `Space` | open doors / use switches | `key_use` = `' '` (:251) |
| `Right Alt` (held) | strafe modifier (makes ↑/↓ strafe) | `key_strafe` = KEY_RALT (:252) |
| `Right Shift` (held) | speed / run | `key_speed` = KEY_RSHIFT (:253) |

Turning has no key-repeat impulses: a held arrow/`←`/`→` is a held key
sampled every tic (vanilla `gamekeydown[]` + `G_BuildTiccmd`'s turnheld
ramp), so taps turn a little, holds turn continuously.

## Mouse

Mouse motion moves the player only while the pointer is **locked** (click
the canvas during a level to lock; press `Esc` — which the browser always
passes through, opening the pause-style menu — to release).

| Input | Effect |
|---|---|
| motion X (locked) | turn — scaled `(sensitivity+5)/10`, integer, default 5 = ×1 (g_game.c:579) |
| motion Y (locked) | forward/back — 1.10 has **no mouselook**; mouse-Y never pitches (g_game.c:405) |
| `left button` (hold) | fire (the ev_mouse → `key_fire` mirror) |

Mouse sensitivity is adjusted with the Options menu's "Mouse
Sensitivity" slider (`←`/`→` on that row); 1.10 has no sensitivity key
binding and no config variable for it.

## Menus (keyboard + mouse)

Menus take over the arrow keys while open. The mouse works via
key-synthesis: hovering a menu item emits the arrow key pairs that move
the skull, and a click emits Enter — mirroring what the DOS OS layer did
for vanilla (`m_menu.c` itself contains zero mouse code; the browser
synthesizer is [`src/input/menuMouse.ts`](src/input/menuMouse.ts)).

| Key | Effect |
|---|---|
| `Esc` | open/close the main menu; inside a menu, close it (also closes the automap) |
| `Backspace` | back up one menu page |
| `↑` / `↓` | move the skull |
| `←` / `→` | adjust sliders (volume, screen size, sensitivity) |
| `Enter` | choose the highlighted item |
| `Y` / `N` | answer confirmations ("End Game?", quit) |
| typing… | save-name editor: printable chars append (HUD font only) |
| `Backspace` / `Enter` / `Esc` in the editor | delete char / commit / revert |

## In-game function keys

The full `M_Responder` F-key block (`m_menu.c:1512-1596`, transcribed in
[`src/ui/menu.ts`](src/ui/menu.ts)) — no F12 in 1.10, and quicksave is
F6: F2/F3 open the save/load MENUS, they are not quicksave folklore.

| Key | Effect |
|---|---|
| `F1` | Help ("Read This!") |
| `F2` | Save Game menu |
| `F3` | Load Game menu |
| `F4` | Sound Volume menu |
| `F5` | detail level toggle |
| `F6` | quicksave |
| `F7` | end game |
| `F8` | toggle HUD messages |
| `F9` | quickload |
| `F10` | quit DOOM |
| `F11` | gamma correction cycle |
| `-` / `=` | screen size down / up |

## Automap

| Key | Effect |
|---|---|
| `Tab` | toggle automap |
| `↑` `↓` `←` `→` | pan the map (while not following) |
| `-` / `=` | zoom out / in |
| `0` | zoom-to-fit toggle (whole map) |
| `f` | follow player |
| `g` | grid toggle |
| `m` / `c` | mark / clear marks |
| `iddt` | reveal the whole map (automap-open-only cheat, AM_Responder) |

## Cheats

Typed **as keys while playing** — no Enter; the matcher is the 1.10 one
(`m_cheat.c`, scrambled-table cursor). Full source ledger with effects,
citations and per-code tests:
[`docs/reports/M11-cheats.md`](docs/reports/M11-cheats.md). Existence
marks below are from that census of `linuxdoom-1.10`.

| Code | In 1.10? | Effect |
|---|---|---|
| `iddqd` | yes | god mode toggle |
| `idfa` | yes | all weapons + full ammo (no keys) |
| `idkfa` | yes | idfa + all key cards |
| `idmus<ep><map>` | yes | change music (e.g. `idmus25`); impossible pairs say so |
| `idspispopd` | yes | no-clipping toggle |
| `idclip` | yes | second no-clipping sequence (same effect) |
| `idbehold` | yes | hint message only (bare form) |
| `idbeholdv` `s` `i` `r` `a` `l` | yes | toggle each power-up |
| `idchoppers` | yes | chainsaw (+ one tick of invulnerability — the 1.10 `= true` quirk) |
| `idmypos` | yes | debug position/angle message (hex) |
| `idclev<ep><map>` | yes | warp (shareware guard: ep 2+ silently does nothing) |
| `iddt` | yes (automap only) | map reveal, in `AM_Responder` |
| `noclip` | **no** | folklore — does nothing |
| `IDK`, `IDKDT`, `mypos`, `dtent`, `cockadoodledoo` | **no** | folklore — does nothing |
