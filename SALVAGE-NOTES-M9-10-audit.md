# M9-10 salvage audit notes (5e77714 → rebase onto main abf4132)

Survived code (finale.ts 341 L, title.ts 266 L, textdata.ts, title.test.ts
262 L / 11 green) audited against docs/design/M9-plan.md §M9-10 + §0.6/0.10
and the tracked mirrors (.refs/g_game.c, .refs/d_englsh.h). NO §M9-10 work
is discarded; two drifts + one gap:

1. FIX (gate-red): finale.ts imports GAME_MODE but never uses it →
   `tsc --noEmit` TS6133. The survived commit was never gate-run. Pin
   stays as the comment (gamemode.ts GAME_MODE='shareware' +
   clampNewGame ep≤1 make the ep2-4 arms unreachable).
2. FIX (source-site drift): fStartFinale hoists `sfxStub('mus_victor')`
   ABOVE the gameepisode switch; vanilla calls S_ChangeMusic(mus_victor,
   true) INSIDE the ep1 case (f_finale.c:110 — ep2-4 have their own
   tracks mus_adac/bunny/pworld). Moved into case 1.
3. GAP: finale.test.ts still the 3-line stub → completed this pass
   (E1TEXT byte hash vs .refs/d_englsh.h re-parse incl. \n count,
   reveal-tic exactness, HELP2 hold-forever, wipegamestate=-1 sentinel
   once, title first-key-arms-menu cross-check).

Verified-faithful (no change): E1TEXT byte-exact (440 bytes, 15 '\n');
reveal count=(finalecount-10)/TEXTSPEED (F_TextWrite :297-299), '\n' →
(cx=10, cy+=11) (:307-311); stage flip `finalecount > strlen*3+250` ⇒
finalecount=0/stage=1/wipegamestate=-1 (F_Ticker :241-247) — E1TEXT flip
at finalecount==1571, all glyphs at ≥1330; HELP2 forever, shareware ep1
(F_Drawer :712-720); F_Responder constant-false (:196-202); pagetic=170
(:473), %6 counter (:465), D_StartTitle demosequence=-1 (:525-530);
G_Responder demo branch matches .refs/g_game.c:520-535 verbatim
(ev_joystick half omitted — no joystick in the browser); game.ts seams
(ga_victory→startFinale, GS_FINALE→finaleTicker, GS_DEMOSCREEN→
pageTicker, startTitle hook) all exist as claimed; reduced-attract
boundary matches §0.6 wording; D-0zz route menu.ts→gStartTitle→
dStartTitle wired.

Banked (not drift, follow-ups): the D_Display branch calls
(dPageDrawer/fDrawer inside renderer.ts) and the event-chain call of
gResponderDemo are renderer-assembly/M9-12 wiring seams (M9-10 must not
touch renderer.ts/main.ts); goldens invoke the drawer seams directly.
