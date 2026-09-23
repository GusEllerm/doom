# M11-09 — Cheat ledger (1.10 source census + verification hooks)

Source of truth: `/tmp/DOOM-master/linuxdoom-1.10` (m_cheat.c/h, st_stuff.c, am_map.c,
g_game.c, d_main.c, d_englsh.h). **d_main.c contains ZERO cheat code** — the engine is
`cht_CheckCheat`/`cht_GetParam` (m_cheat.c:43-99) with the `SCRAMBLE` bit-permutation
(m_cheat.h:30-32); the responders that feed it are **ST_Responder** (st_stuff.c:515-724)
and **AM_Responder's iddt** (am_map.c:287/:701), reached from G_Responder (g_game.c:543-548,
HU → ST → AM inside GS_LEVEL) behind M_Responder (d_main.c:173).

## Inventory — exists in 1.10 vs folklore

| code | exists? | effect (source-exact) | source | port site | verify |
|---|---|---|---|---|---|
| `iddqd` | YES | toggle CF_GODMODE; ON ⇒ mo.health=100 & health=100 + "Degreelessness Mode On"; OFF ⇒ "...Off" | st_stuff.c:549-563 | cheats.ts cheatGod | cheatResponder.test `iddqd` |
| `idfa` | YES | armorpoints=200/armortype=2, ALL 9 weapons, ammo→maxammo (NO cards) + "Ammo (no keys) Added" | :564-577 | cheatArsenal(false) | `idfa / idkfa` |
| `idkfa` | YES | idfa + all 6 cards + "Very Happy Ammo Added" | :578-594 | cheatArsenal(true) | idem |
| `idmus<nn>` | YES | msg "Music Change"; **`<nn>` is an <ep><map> PAIR**, song = mus_e1m1+(ep-1)*9+map-1; >31 ⇒ "IMPOSSIBLE SELECTION"; else S_ChangeMusic(n,loop) | :595-621 | resolveMus + sChangeMusic (the M10 musicSlot-adjacent slot — now consumed) | `idmus<ep><map>` |
| `idspispopd` | YES | toggle CF_NOCLIP (+ MF_NOCLIP\|MF_NOGRAVITY mirror, D012) + "No Clipping Mode ON/OFF" | :625-633, table :427-431 | cheatNoclip | `idspispopd / idclip` |
| `idclip` | YES | same effect, second sequence (`cheat_commercial_noclip`) | :434-437 | idem | idem |
| `noclip` | **NO** | the :624 COMMENT claims it; **no sequence exists** — typed, it does NOTHING | comment-only | — (test asserts do-nothing) | `"noclip" does nothing` |
| `idbehold[v s i r a l]` | YES | index i == powertype_t: give via P_GivePower if none, else =1 (strength ⇒ =0 = off) + "Power-up Toggled" | :636-651 | cheatBehold | `idbehold*` |
| `idbehold` (bare) | YES | hint message "inVuln, Str, Inviso, Rad, Allmap, or Lite-amp" ONLY (no menu in 1.10) | :652-656 | cheatBeholdMenu | `bare idbehold` |
| `idchoppers` | YES | weaponowned[chainsaw]=1 + powers[invulnerability]=**1** (the `= true` quirk — ONE unit, not INVULNTICS) + "... doesn't suck - GM" | :657-663 | cheatChoppers | `idchoppers` |
| `idmypos` | YES | message `ang=0x%x;x,y=(0x%x,0x%x)` (unsigned %x ⇒ two's-complement hex) | :664-673 | cheatMypos | `idmypos` |
| `idclev<e><m>` | YES | guards ⇒ msg "Changing Level..." + G_DeferedInitNew(gameskill,e,m); shareware epsd>1 ⇒ silent; **checked OUTSIDE the !netgame gate** (:676) | :676-723 | resolveClev + gDeferedInitNew | `idclev<e><m>` |
| `iddt` | YES — but **in AM_Responder**, automap-open only; `cheating=(cheating+1)%3`, event NOT eaten; never in ST | am_map.c:287/:701-704 | amMap.ts chtCheckCheat | `iddt` describe block |
| `IDK` | NO | DOOM-2-era folklore (health/ammo refill) — does nothing here | absent | — | `"IDK" ... does nothing` |
| `IDKDT`, `mypos` (no id), `dtent`, `cockadoodledoo` | NO | never existed in 1.10 (decoded table census) | absent | — | folklore tests |
| devcmd / `;` respawn | NO | the G_Responder `#if 0` block (g_game.c:512-517) — dead code in 1.10 | g_game.c | — | (source cite only) |

## Activation mechanics (source facts, all pinned by tests)

* Typed **as keys while playing** — `ev_keydown`, `data1` = lowercase ASCII; **no Enter**;
  keyups and mouse/joystick never touch a matcher. Cheats fire only in **GS_LEVEL**
  (g_game.c:543) and (this port) never in netgame — `netgame` is a build-constant false.
* Matcher (m_cheat.c): per-sequence cursor; a matching key advances; a mismatch rewinds
  to 0 and is **NOT retried** against the first byte; **no timeout/decay**. Parameter
  slots (`0` bytes) capture the **raw** key; byte `1` marks parameter start; `0xff` ends.
  Completion resets the cursor ⇒ immediate re-typing re-fires (toggles toggle).
* Cross-talk: every fed key passes the ST chain **in source order** — god → idfa → idkfa
  → idmus → idspispopd‖idclip (else-if; later matchers skip the key when one fired) then
  the six idbehold matchers (independent for-loop) then bare-behold → choppers → mypos
  (second chain), then idclev. Prefix overlap is therefore exact: "idbeholdv" messages
  the hint at the 8th key AND toggles at the 9th; "idkfa" fires kfa ONLY (the idfa
  cursor died on 'k'); "id"+gameplay keys mid-word neither false-triggers nor expires —
  continuing the word completes it (vanilla truth, tested both ways).
* Timing (D-11f): effects + `hooks.cheatSink(effect, params, gametic)` fire in the event
  pump (pre-tic); toggles gate the NEXT tic; `cheatLog` is the ledger of fired tics.

## Pump placement (for M11-10's single main.ts edit)

`if (cheatResponder(state, ev)) continue;` **between mResponder and huResponder** —
never consumes (ST_Responder's last line is `return false`), matching vanilla's
M-first (d_main.c:173) and HU→ST adjacency minus chat (HU eats no letters in SP).
*Known inherited deviation*: our pump runs amResponder FIRST, so with the automap OPEN
the automap-bound letters (c/f/g/m/'0', arrows) are eaten before ST sees them — vanilla
feeds ST before the AM eater (typing idmus with the map open would also set a mark
there). Not fixable without re-ordering the M9-12 pump; no cheat needs those letters
mid-word EXCEPT idmus/idclip/idbehold* typed while automap-open — documented, ledgered.

## Fixes/quirks this task made

1. **amMap.ts iddt matcher FIXED** (was comparing RAW bytes to the scrambled table —
   the comment's "never matches" claim was folklore; m_cheat.c:62 compares
   cheat_xlate_table[key]=SCRAMBLE(key), so iddt DOES work automap-open in 1.10).
   render/automap.ts's "unreachable via keys" comment now stale — render owner refresh.
2. cht_GetParam ports the `while (*(p++) != 1)` advance past the marker and the
   zero-and-rearm behavior; the past-the-end scan (C UB, never reached for real cheats)
   is guarded to ''.
3. Source bug kept: commercial idclev computes epsd=0 then fails the `epsd < 1` guard —
   in 1.10 commercial idclev does NOTHING (unreachable under the shareware policy).
4. NOT-effects honored: idfa gives NO cards; no armor-class beyond points=200/type=2; no
   devcmd; no armor/health write on god-OFF; choppers invuln is 1 unit.

## Follow-ups

* **M11-10**: the ONE main.ts composer edit — insert `cheatResponder(state, ev)` after
  `mResponder` (never consumes; harmless passthrough); optionally expose a cheat-sequence
  injection hook for the L4 e2e (feed `cheatResponder` from `__doom`).
* **M11-03 (textdata patch-list)**: STSTR_* strings currently live in `src/sim/cheats.ts`
  (self-contained by necessity) — MOVE them into textdata.ts there if the ledger wants
  one home; do not duplicate.
* M11-11 e2e: real-key cheat walkthrough (iddqd/idfa/iddt strings + state via keys).
* HU_WRITE_SITES gained the cheats.ts row (funnel `setMessage`); line drifts re-derive
  via humessage.test's census.
