# JOURNAL

Append-only log of events, surprises and lessons.

## 2026-09-14 — Project start (Phase 0)
- Read PROMPT.md in full. Environment oriented: node 22 / npm 10 / git 2.50; network YES; Playwright chromium preinstalled; no `origin` remote; clean `main` at 25d1f83.
- Prior attempt (raycaster→three.js) deliberately cleared; its lessons: winding-order invisible-wall bug and dead menu clicks evaded unit tests → browser-level verification with visual review is mandatory here.
- Created state skeletons (STATUS/ROADMAP/TASKS/DECISIONS/JOURNAL).
- Next: dispatch 12 parallel researchers (Phase 1) + scaffold implementer (T00) simultaneously.

## 2026-09-14 — Pause (user request)
- User asked to pause. No cancel tool exists for queued sub-agents, so R04-R12 + T00 may still start/complete; their outputs land in docs/research/*.md (uncommitted) or branch task/00-scaffold (T00 works in an isolated worktree and commits only there).
- R03's note (docs/research/03-bsp-renderer.md) is already in the working tree, possibly mid-write — left uncommitted intentionally.
- Resume protocol: read STATUS.md header, collect agent reports via get_subagent_result for the IDs listed there, review + commit docs/research/*, reconcile TASKS.md, then continue Phase 1 exit check.

## 2026-09-14 — Unpaused; fleet lost; re-dispatched
- During the pause the harness cleaned up ALL sub-agents (running and queued), including T00's worktree (pruned; never branched). Only R03's committed note survived.
- Lesson: agent context is not durable across pauses. Durable state = files in git + agent reports. All re-dispatch briefs now demand: WRITE THE FILE EARLY, append as you go, so a cutoff leaves usable output.
- Survivor reports yielded verified leads (id source path linuxdoom-1.10, real MF_* flag values, state_t misc fields, doomednum present, Freedoom v0.13.0 hint) — embedded into re-dispatch briefs.
- Re-dispatched: R01,R02,R04..R12,T00 (12 units, new IDs in STATUS.md).
- R02 (graphics) done, committed. Correction captured: vanilla lightnum = (lightlevel>>LIGHTSEGSHIFT)+extralight (not *16); palette usage from st_stuff.c; freedoom1.wad v0.13.0 inspected in /tmp (repo clean of WADs).
- R04 (simulation core) done: 594 lines, PRNG table + movement constants quoted from source.
- R01 (WAD container) done: 326 lines; E1M1 empirical parse confirms record sizes. Note: GitHub release-asset URLs 404 from sub-agent sandboxes — fetch-freedoom may need the browser_download_url direct path or a mirror; R12/T00 to confirm.

## 2026-09-15 — Connection-error wave; re-dispatch wave 2 (offline-first)
- A fleet-wide "Connection error" killed R06-R12 + T00 (some at 0 tool uses). R05 finished just before and its file is committed (swept in via c60ca66/1837348; HEAD content = full 630 lines).
- Mitigation: /tmp now holds LOCAL CACHES: /tmp/DOOM-master (full id GPL mirror incl. linuxdoom-1.10), /tmp/doomsrc (89 loose files), /tmp/freedoom-0.13.0/ (freedoom1.wad, freedoom2.wad, CREDITS.txt, COPYING.txt), /tmp/chocolate-doom-master. Wave-2 briefs direct agents to read these instead of fetching over the flaky network.
- Lesson: researchers' "write file early" must be "create outline file in step 1"; R06/07/08 burned 3.5M tokens without ever creating their file.
- R08 (weapons/player) done offline-first: 718 lines, ~30 verbatim quotes; corrected LOWERSPEED=FRACUNIT*6 premise from brief. 6/12 notes in.
- R07 (monster AI) done: 1292 lines w/ full function quotes (A_Chase, P_Move, P_LookForPlayers, P_CheckSight...). 7/12.
- R06 done: 833 lines; mobjinfo 137-row table script-extracted; P_KillMobj/P_TouchSpecialThing quoted. 8/12.

## 2026-09-15 — Infra wave 2 (harness 500 "cannot schedule new futures after shutdown")
- Killed R09 (partial: 47-line outline + some research done), R10 (outline), R11 (outline), R12 (0 uses), T00 (0 uses). Not resumable (cleaned up).
- Outlines committed (write-early rule paid off — skeletons + some sections survive).
- Wave 3 re-dispatch: R09-R12 resume-from-outline, T00 third attempt. If T00 dies again (3rd), orchestrator builds scaffold directly (recorded as D006 fallback).

## 2026-09-15 — T00 done (orchestrator-built after 3 infra deaths); Xcode git gate found
- T00 completed directly per D006 fallback: deliverable A salvaged from the attempt-3 branch (3add364), B-E built and verified by orchestrator. main is GREEN: check, e2e (canvas non-blank, zero console errors), build, fetch-freedoom (real GitHub download + local-zip + cache-hit + tamper-rejection all proven). LICENSE GPL-2.0(+or-later), CREDITS placeholder, debug API stub, pinned release.json (freedoom1.wad sha256 7323bcc1...703d).
- NEW infra issue: Xcode license gate broke /usr/bin/git (the "terminated"/license errors). Workaround D007: CLT git path. User should run sudo xcodebuild -license accept.
- Lesson: an orchestrator-side `git add -A` swept a live researcher's mid-write file into a task branch — never bulk-add docs while agents are writing in the shared checkout; stage explicit paths only.
- R11 done: vanilla savegame stream quoted (no QuotePointer in 1.10; raw pointers neutralized by rebuild-on-load) + our tagged-binary design. 9/12.
- R12 done (empirical): Phase 1 = 4 episodes x 9 maps. Thing numbering = Doom1 (16,083 things, all maps). TWO ENGINE FEATURES FOUND: (1) DEHACKED lump present — fullbright firing-frame tweaks only; need minimal DEH parser or transcribed constants; (2) Freedoom D_* music is SMF (MIDI files), vanilla is MUS → both decoders needed (adjusts R10/ARCHITECTURE scope).
- R09 done: 408 lines; status bar widget coords, STCFN font loader, Freedoom UI synthesize list. 11/12 notes; only R10 halves running.

## 2026-09-15 — Phase 1 COMPLETE: 12/12 research notes committed
- R10 finished via the split-two-agents pattern (worked perfectly — both halves wrote in place). Final data points: vanilla sound path has NO 0x7F wrapping (settled from code + byte histograms); Freedoom D_* music is 100% SMF (41 lumps), MUS spec still documented for vanilla compatibility.
- Phase 1 exit criteria met (notes exist for all topics). Architect dispatched next; per §8 an architect must also confirm notes suffice for design.

## 2026-09-15 — Phase 2 complete; M1 wave 0 dispatched
- Plans landed: M1 (9 tasks, 4 waves), M2 (10 tasks + A-FX1), ROADMAP with L1-L5 exit criteria.
- Dispatched: M1-01 contract (e764b9b0), A-INT1 boundaries (3f60201e), A-FX1 fixed core (8b7724cf) — all in worktrees, commit-early rule.
- A-INT1 merged with surgery: harness had appended a junk commit registering node_modules (symlink) into git — cherry-picked only the real commit. Lesson: inspect pi-agent-* branches for harness auto-commits before merging.

## 2026-09-16 — M1-03 merged; TWO load-bearing discoveries
1. WAD lump-dir entries are [u32 filepos][u32 length][8-byte name] — position/length BEFORE name (verified empirically vs wads/freedoom1.wad; the name-first assumption was baked into a mini-parser). M1-02 (WadFile) must implement this order; contract tests must pin it.
2. Freedoom data != vanilla lore: palette0 e255 = (167,107,107) not white; COLORMAP row0 maps 168→4 (not pure identity). All goldens must be pinned from freedoom1.wad bytes, never from memory. R02 note's "vanilla expectations" phrasing misled the test author.
- Also: added @types/node devDep (test tooling needs fs/url types; tsconfig include += tests — surfaced one strict-null bug in eslint-rules test, fixed).
- M1-02 merged via cherry-pick x2 (harness junk commit dropped again — recurring, auto-filter in salvage flow). WadFile live on main: parse/last-match/zero-copy/marker-skip, 15 tests. Follow-up: switch palettes golden-test mini-parser to real WadFile.
- M1-05 merged (conflict in eslint-rules test resolved keeping main's null-guard). Palettes goldens migrated to real WadFile. M1-07 dispatched (sprite census). M1-06 waits on M1-04.
- A-FX1 merged: zero impl bugs vs oracle (200k vectors incl gcc-UB corner semantics). M2 chain started (M2-01 splitter).
- M2-01 merged (1491c41); M2-02 dispatched. M1-06 attempt-2 running after infra death attempt-1 (no commits lost; pruned worktree).

## 2026-09-16 — RACE LESSON: M1-06 double-dispatch
- I judged attempt-1 (e0563d45) dead from a truncated "terminated" notification + an empty `git -C <worktree> status` (dir already gone ⇒ silent empty). It was ALIVE; both attempts raced on branch task/M1-06-textures. Salvaged: pinned attempt-1 chain to salvage/M1-06-e0563d45 (fd87a39).
- Rules going forward: (1) before re-dispatching a "dead" agent, require BOTH a failure notification AND branch evidence (log/commits), never the worktree-dir probe alone; (2) re-dispatches get branch <id>-<slug>-t2 to make races structurally impossible; (3) verify 'flat row->column transpose' claims against R02 during M1-06 review — flats are row-major 4096 in vanilla.
- M1-06 merged: PNAMES 1049, TEXTURE1 801 + TEXTURE2 162 textures, sha256-composed goldens. Race resolved cleanly (attempt-2 tree). DecodedFlat contract comment fixed (row-major).
- M1-08 viewer dispatched (milestone exit); M2-03 dispatched (wave 1 parallel).
- M2-02 merged (8 mapgen tests incl. blockmap union == all linedefs property).

## 2026-09-16 — 🏁 M1 EXIT CRITERIA MET
Debug viewer (merged from pi-agent-631a47ef) renders any flat/patch/sprite/texture from freedoom1.wad with PLAYPAL+COLORMAP controls; playwright e2e 4/4 green incl. deep links + 404 fallback. Notable find by the viewer agent: vanilla patches tolerate 0-3 byte post padding (patch-header heuristic updated). M1-09 (golden consolidation) + M2-03 close out the wave.
- M2-03 merged (E1M1 loadMap goldens run on main). M2-04 dispatched (p_setup runtime; M2-05/06 unlock behind it). FIXMAP↔loadMap round-trip green across fixture boundary.

## 2026-09-16 — M1 COMPLETE + symlink footgun lesson
- M1-09 merged (d57944a): integration goldens + round-trip + e2e hardening. 301/301 tests, 0 skips.
- HAZARD FOUND: harness auto-commits capture untracked paths; `.gitignore` `wads/` (dir form) does NOT match a *symlink* named `wads` — M2-03's harness commit committed such a symlink (absolute path into main checkout), and merging it DESTROYED the real wads/ dir (git rm + symlink). Fixed: symlink removed, wad restored (sha 7323bcc… verified), ignore rule now includes bare `wads`. 
- RULE ADDED to salvage/merge flow: junk-commit filter must flag ANY commit touching node_modules OR wads OR *.wad OR symlinks (mode 120000) — check `git show --raw` modes, not just paths.

## 2026-09-16 — M2-04 merged; wave 3 out
- E1M1 structural goldens now pinned: 182 sectors; sector line-list SUM == numLines + backDiff (1822); sector-0 property vectors. Audit script false-positive learned: legitimate symlink DELETIONS flag as junk — interpret `git show --raw` direction.
- Dispatched: M2-05 (blockmap+bsp point-loc, agent d2b743b3), M2-06 (sim skeleton + vanilla PRNG table + determinism harness, agent ef653f9a). Briefs mandate audit-branch.sh + no blind add -A.
- M2-06 merged (rndtable byte-identical to m_random.c; 1000-tic determinism goldens incl. E1M1). M2-07 (8904a739) + M2-08 (d62d873b) dispatched. Running: M2-05, M2-07, M2-08.
- M2-05 merged: CSR blockmap decode + BSP walker; E1M1 ssectors@start pinned.
- M2-07 merged: movement goldens pinned (walk 35tic @0° step 51199/19 — table-exact); turn = polling not events; D009 filed for M5.
- PAUSE requested by user after M2-08 lands. Queued for resume: M2-09 (automap renderer + main.ts boot wiring, deps M2-05+M2-08), then M2-10 (M2 exit e2e). State is clean: all work merged to main, checks green.

## 2026-09-16 — PAUSED (user request) after M2-08
- Merged M2-08 (a7b595b): faithful am_map.c port — follow/pan, fixed-point MTOF/FTOM memo, 2%/tic zoom clamps, marks FIFO, viewport clip; E1M1 goldens ran. All checks green on main (454 unit tests + e2e).
- Main state: M1 complete; M2-01..08 merged. No agents running.
- RESUME QUEUE: M2-09 automap RENDERER + main.ts boot wiring (deps M2-05+M2-08 ✓ — ready to dispatch; include M2-07's follow-up: rAF tic loop + debugSim.attach + loadMap wiring) → M2-10 exit e2e (arrow moves in noclip on screen). Then M2 close + M3 planning wave.
- Resumed per user. Dispatched M2-09 (agent 0ba62557): framebuffer + AM_drawFline port + player arrow + main.ts boot (fetch→E1M1→35Hz rAF loop) + automap e2e. This task puts the first map pixels on screen.
- M2-09 attempt-1: infra death (Connection error), ZERO commits (stayed in read phase 27 tool uses despite write-early mandate). Attempt-2 (9266d5a8) briefed with FIRST-ACTION=stub-commit rule hardened.

## 2026-09-16 — First pixels: M2-09 merged (c5272e8)
E1M1 automap renders in the browser: 320x200 indexed fb + AM_drawFline port + green arrow; boot fetch→loadMap→35Hz accumulator loop; Tab toggles. e2e 5/5 green (two consecutive runs), 484 unit tests. M2-10 (frame goldens + goldens:update script + hardened keyboard e2e) dispatched to close M2.
