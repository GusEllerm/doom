# M11 Playtest — manual checklist (M11-11)

Companion to `M11-cheats.md` (the 1.10 cheat census/ledger) and the automated
proof `e2e/m11-persist.spec.ts` (6/6 green ×2, full `npm run e2e` green, zero
console errors). Everything below is the MANUAL (human-hands) face of the same
claims: run `npm run dev`, open `http://127.0.0.1:5173/` — the game boots to
the TITLEPIC attract exactly like vanilla's D_DoomMain tail.

Sources verified against `/tmp/DOOM-master/linuxdoom-1.10` (mirror gate:
`ls *.c | wc -l` == 62).

## A. Save/load by REAL keyboard across a MANUAL reload (ROADMAP exit 1)

| # | Step (human) | Expected | 1.10 cite |
|---|---|---|---|
| A1 | Esc → "NEW GAME" → Episode 1 → Hurt me | live E1M1, statusbar + psprite up | m_menu.c M_NewGame/M_ChooseSkill |
| A2 | Esc → "SAVE GAME" → skull a slot → Enter | the row turns into an editor with `_` cursor (intercepts every char) | m_menu.c:644-659 M_SaveSelect, :656 saveStringEnter |
| A3 | type `playtest` → Enter | menu closes; save lands (slot list shows `PLAYTEST` — the 1.10 editor TOUPPERs every char) | m_menu.c:1477 `ch = toupper(ch)` |
| A4 | RELOAD the browser tab (F5/Cmd-R) | game boots to TITLEPIC again; DevTools → Application → IndexedDB → `doom` DB → `saves` store shows the slot (the persistence claim) | plan §M11-01 (DB `doom` v1, stores `saves`/`settings`) |
| A5 | Esc → "LOAD GAME" → the `PLAYTEST` row shows → Enter | back in the level at the saved instant (HUD clock matches); no "game saved." spam, silent like vanilla's load lane | m_menu.c M_LoadSelect → G_LoadGame (deferral §0.3) |
| A6 | F9 → press `y` at "Are you sure you want to load …?" | the quickload prompt names the last-quick-saved slot | m_menu.c:729-745, QLPROMPT d_englsh.h |

Automated twin: spec tests 1 (byte-exact hash+pixels+100-tic trajectory across
`page.reload()`) and 3 (this exact click/type route).

## B. F6/F9 quicksave (exit 3)

| # | Step | Expected | 1.10 cite |
|---|---|---|---|
| B1 | fresh session, F9 | "you haven't picked a quicksave slot yet!" (QSAVESPOT, d_englsh.h:44); 'y' does NOTHING (no load, clock runs on) | m_menu.c:736-739, QSAVESPOT |
| B2 | F6 (first time) | SaveDef OPENS and the NEXT slot you pick becomes the quickslot (`quickSaveSlot = -2` "pick a slot now") | m_menu.c:696-707 |
| B3 | pick slot 0, type `quick`, Enter | saved as `QUICK`; F6 again → prompt instead of menu; F9 + `y` restores position/ammo exactly | m_menu.c:672-706, :722 |

F6/F9 EXIST in 1.10: `case KEY_F6` (Quicksave) m_menu.c:1572,
`case KEY_F9` (Quickload) m_menu.c:1587 (KEY_F6/F9 doomdef.h:262/:265).
(There is NO F2/F3 quicksave in 1.10 — M11-03 finding, re-verified here.)
Automated twin: spec test 4.

## C. Settings survive a reload (exit 5)

| # | Step | Expected |
|---|---|---|
| C1 | DevTools console: `__doom.settings({sfx_volume: 3, music_volume: 1, mouse_sensitivity: 8})` | returns the echo; within ~a quarter second the `settings` store holds the record (write-on-change, D-11b — a browser never "quits", so no M_SaveDefaults moment exists) |
| C2 | reload | `__doom.settings().vars` shows 3/1/8 BEFORE the first tick (boot awaits hydrate, D-11b); `__doom.state().audio.sfxVolume === 3` — applied, not just stored; mouse feel scaled by 8 (input/mouse.ts remount) |
| C3 | IndexedDB blocked (e.g. private mode) | boots fine on the memory backend, zero console errors (fail-closed ladder, settings.ts header) |

Automated twin: spec test 2. NOTE (test-authoring trap, documented from the
salvage): IndexedDB reads SEE an uncommitted put (same-document
read-your-writes) and playwright `waitForFunction` does not await async
predicates (1.63, measured) — wait for `settings().status()` to QUIESCE
(dirty=false, writePending=false, lastWrite.ok) before any reload in a spec.

## D. Bindings hold (exit 5, D-11d)

D1 — 1.10 has NO bind menu: the config face IS the `key_*` variables
(m_misc.c:243-253). Console: `__doom.settings({key_fire: 0x39})` (moves
key_fire to '9'… debug face only, no menu — faithful), reload, `__doom.settings().keys.key_fire`
still 0x39; the keyboard table remounts from it (input/bindStore data face).

## E. Cheats by hand (exit 6)

Type them as real keys WHILE playing (no Enter, no console) — the full
source-censused 1.10 inventory, effects, and message strings are LEDGERED in
`M11-cheats.md`; quick sheet (all YES-exist rows):

| code | effect (feel it by hand) |
|---|---|
| `iddqd` | god mode ON/OFF toggle, health snaps to 100 |
| `idfa` / `idkfa` | all ammo/weapons (idkfa also all 6 cards) |
| `idmus<ep><map>` | music change to that level's song (pair, not number!) |
| `idspispopd` / `idclip` | noclip (walk through walls, no gravity bob) |
| `idbehold<v s i r a l>` | powerup toggles; bare `idbehold` = hint message only |
| `idchoppers` | chainsaw + the 1-unit invulnerability quirk |
| `idmypos` | `ang=0x…;x,y=(0x…,0x…)` hex line |
| `idclev<ep><map>` | level warp (shareware: eps 2+ silent) |
| `iddt` | automap OPEN only: all-map + things (cycling cheating level) |
| `noclip`, `IDK`, `mypos`, `dtent` | DO NOTHING (folklore; decoded-table census) |

God/noclip survive save→load (they ride the player_t payload — M11-04).
Automated twin: spec test 5 (real `iddqd`/`idfa` keystrokes).

## F. Demo download — FILE INSPECTION ONLY (exit 4, D-11e)

`__doom.recordDemo()` → play → `__doom.recordDemo()` off produces a
byte-exact 1.10 `.lmp` (13B version-110 header + 4B/tic cmds + 0x80
DEMOMARKER, g_game.c:1549-1570). Inspect with `xxd`/hexdump — header
`v110 <skill> <ep> <map> <tos> <extra> <plyr> 0 … 0`. There is NOTHING to
open "in VLC" (demos are sim input streams, not video — the plan's joke
row); playback is `__doom.playDemo(bytes)`. No checksum exists in 1.10
demos, and we add none (D-11c — desyncs stay silent like vanilla).
Automated twin: spec test 6 (a crafted 60-tic zero-cmd `.lmp` drives the
LIVE page and rebuilds the byte-identical world of the plain run).

## Known gap found by this suite (filed, sim-side)

"game saved." NEVER appears on the HUD: vanilla G_DoSaveGame sets
`players[consoleplayer].message = GGSAVED` (g_game.c:1316) and HU_Ticker pops
it for 140 tics; this port's save drain routes GGSAVED through
`hooks.messageSlot` instead (src/sim/game.ts:831) — the documented
"observable channel meanwhile" (src/sim/player.ts:144) — and no bridge feeds
the HU machine (player.message has NO GGSAVED write site; humessage's own
write-site census). Fix belongs in src/sim/game.ts (mirror the cheats.ts
setMessage funnel); until then the e2e asserts the documented log seam
(spec cites). Everything else on this checklist is green by machine
(`e2e/m11-persist.spec.ts`), so the human pass is a CONFIRMATION run, not
the only proof.
