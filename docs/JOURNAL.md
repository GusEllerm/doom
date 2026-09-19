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
- M2-10 attempt-1: infra death at tool-use #4 (branch never created — zero-loss recovery). Attempt-2 (5f3a77bc) with hardened stub-first rule. Network flakiness wave noted.
- M2-10 attempt-2: infra death AFTER stubs (salvage pi-agent-5f3a77bc = stubs only). Attempt-3 (79a4b0e1) builds on salvage, one-commit-per-deliverable + headless-only discipline.
- 🏁 M2 COMPLETE (M2-10 merged 410d974): 5-scene blessed frame goldens (3 FIXMAP + 2 E1M1), goldens:update tooling w/ required --reason + --check drift gate, keyboard e2e hardened (Tab byte-exact restore, W-move deltas, turn monotonicity). All gates green.
- M3 plan accepted (8 tasks, 5 waves; D010 filed). Plan agent was read-only — orchestrator wrote file verbatim from transcript (worth remembering: pass write-enabled implementer for file-producing plans next time).
- M3-01 merged (light tables BigInt-verified incl. pancake lightnum).
- M3-01 merged (light tables BigInt-verified incl. pancake).
- M3-02 merged (seg angles straight from SEGS lump BAM — matches P_LoadSegs, no atan2). M3-05 dispatched (R_DrawColumn).
- M3-03 merged (r_bsp.c:88-252 verbatim port, hom liveness via 33-span injection). M3-04 dispatched (walk+view; seam: WalkCallbacks for M3-06).
- M3-05 merged (column blit).

## 2026-09-16 — M3-04 merged + latent fixture bug fixed
- bspSplit NODES bbox byte order was [x0,y0,x1,y1]; vanilla m_bbox.h/P_LoadNodes = [top,bottom,left,right] per child. mapdata decode was already correct — the FIXMAP ENCODER was wrong (decoded child bboxes garbage; invisible until R_CheckBBox consumed them). 4-line encoder fix + inverse-read test via justified out-of-ownership exception. Whole suite green.
- M3-04 quality highlights: R_RenderBSPNode iterative port with identical visit order; clipangle = xtoviewangle[0] NO shift (pinned); WalkCallbacks seam for M3-06; 1000-seed brute-cone superset sweep proves CheckBBox never drops visible segs.
- M3-06 stopped mid-run by pause; salvage = stubs + drawsegs draft. Finisher cfedc832 dispatched (reviews draft vs r_segs.c, completes segs.ts + tests).
- M3-06 finisher: infra death (inspection phase, zero new commits — salvage unchanged). STRATEGY: split task — M3-06a port-only (43b8c151, smoke test only) + M3-06b test matrix after. Smaller sessions = fewer infra casualties.

## 2026-09-16 — M3-06a merged: walls render
R_StoreWallRange + R_RenderSegLoop ported (segs.ts 454 lines, drawsegs draft audited/fixed). FIXMAP smoke: full walker+callbacks paints 64000px (all columns), 2 drawsegs, hom==0. Source truths banked: masked = midtexture presence; DBITS=5 in R_PointToDist; scalelightfixed≡fixedcolormap row; rdata −1 NO_TEXTURE sentinel (vanilla 0) handled. M3-06b (six-acceptance test matrix) dispatched with fix-findings protocol (no src edits by testers).

## PAUSE #2 (user request) — state: M3 6a merged (walls render in smoke), M3-06b in flight
Resume queue: merge M3-06b when reported → M3-07 (frame pipeline + boot, deps M3-06b) → M3-08 (viewpoint goldens + HOM gate + e2e ⇒ M3 closes). All prior work merged & green on main.
- Resumed (pause #2). M3-06b stopped mid-derivation; salvage has stubs + 348-line scratch derivation test. Finisher 7accf79e mining it into the real matrix.

## 2026-09-16 — M3-06b merged (test matrix) — found FIX-M3-06c
Six-acceptance matrix green (analytic spans e.g. d=160 → span[13,141], scale 131072 near-wall, off-axis 46358 → [39,129]; occlusion fragments; 257th drawseg → counter; masked recording w/ SIL_BOTH). One real bug found by tests: negative-base openings refs filtered by >=0 guards vs vanilla pointer math (maskedtexturecol/sprtopclip snapshots lost when pool base < start). Fix task 06c + M3-07 pipeline dispatched in parallel (segs.ts ownership split keeps them disjoint). Salvage-derived lesson: scratch derivations with out-of-range sidedef indices produced NaN garbage — numbers re-verified fresh before believing.
- M3-06c merged: reproduce-first red commit then pointer-math fix; 588/588 zero skips.
- M3-07 merged: 3D walls are the default browser frame (E1M1 at 35Hz, Tab automap-over-3D, capture()+live hom in debug API). e2e 7/7. M3-08 golden sweep dispatched — last M3 task.

## 2026-09-16 — 🏁 M3 COMPLETE (walls renderer)
- M3-08 merged: 20 blessed viewpoints (12 FIXMAP + 8 E1M1), double-render byte-equality, hom==0 & drawsegOverflow==0 everywhere, goldens:update --set walls --check green, e2e 8 specs green, 600+ unit tests.
- L5 review (orchestrator viewed PNGs): FIX frames textbook walls-only perspective (filled wedges, centered horizon, black planes as documented). E1M1 spawn-east/atrium structurally plausible (edge-on slivers, raised-ledge occlusion reads). FINDINGS→M4: (a) atrium green checker — suspect masked-mid columns (recorded-not-drawn this milestone) and/or GREEN-family textures in Freedoom's E1M1 — re-verify in M4 when drawMasked lands; (b) tall distant bands above horizon look odd without ceilings — expected per walls-only deviation, revisit after visplanes.
- Queue: M4 plan (planes/sky/masked/things), then waves.

## 2026-09-16 — M4 plan accepted (8 tasks, 5 waves)
Pinned truths (re-verified from source by planner): 1.10 visplanes marked from seg store paths (NO polysegs in the draw path — polyseg-free), sky = visplane with skyflatnum + angle-keyed columns (textured sky via SKY1 lump as wall-texture columns at horizon), F_SKY1 lump never drawn (tag only), MAXVISPLANES 128. Worktree ../doom-M4-plan removed after merge. Wave 1: planes engine, flat/sky data, static thing tables.
- M4-02 merged. Data truths: F_START count 246; SKY1 width 256 (power-of-2 mask OK); E1M1 missing flats EMPTY (report preview was truncated/misleading — verified committed goldens directly before believing, rule working).
- M4-01 merged (visplanes + yslope/distscale + subsector seam, MapPlane BigInt goldens). M4-04 dispatched early (deps satisfied: 01+02 merged; 03 still running).
- M4-03 merged; M4-05 dispatched (parallel with M4-04; disjoint ownership: 05=bsprites+bsp wiring, 04=segs marking).
- M4-04 merged: floors/ceilings mark visplanes from store paths; masked middles DRAW (reverse drawseg sweep). M4-06 fixtures dispatched parallel.

## 2026-09-16 — M4-05 merged (+ env anomaly)
- Cross-task rename breakage found at merge (vissprites imported M3 no-op from drawsegs; M4-04 had relocated the driver to masked.ts). One-line import fix; suite green. LESSON: parallel tasks touching same subsystem should rebase onto each other's merges BEFORE finishing, or name dispatch cross-references explicitly.
- ENV ANOMALY: remote 'origin' → https://github.com/GusEllerm/doom.git now exists (was absent at Phase 0/D002; main is 118 ahead, never pushed by me). NOT pushing anything without explicit instruction; flag to user at next checkpoint. D002 env facts partially stale.
- M4-06 merged (M4FIXTURES maps + buildM4FixturesWad). M4-07 integration dispatched — last functional task before the M4-08 re-bless/L5.
- D011: pushing main to origin authorized; pushed (note: origin already had pause#1 commit — user pushed earlier themselves).

## 2026-09-16 — M4-07 merged; M4-08 re-bless dispatched
- Verified vanilla R_DrawMasked semantics in r_things.c (sprites back-to-front with inline occluding-masked draws :892 + final flush :980; idempotence via maskedtexturecol reset) — our two-call drawSprites→drawMasked reproduces it. 
- main currently has 20 INTENTIONALLY stale M3 wall-golden failures (frames legitimately gained planes/masked/sprites; determinism+counters green). M4-08 re-bless fixes with reason history. First main-RED window in project history — bounded and planned.
- Pushes to origin/main now standard (D011).

## 2026-09-16 — 🏁 M4 COMPLETE (planes/sky/masked/static sprites)
- M4-08 re-bless 31 scenes → FIX-M4-09 sentinel-collision fix (refs -1024 range; red-first) → M4-10 diagnostic root-caused a MAPDATA decode swap (sidedef mid@20/bottom@12; M2-03-era bug that a fixture COMPAT shim had been masking; shim retired, research doc §6 corrected). 17 goldens re-blessed; L5 frames now show masked windows over real sprites + BASE2 bands floor-to-horizon.
- LESSON: compat shims that compensate for bugs must carry a root-cause task ID at creation; 'shim (FINDING for M4-07)' cost two extra passes to unmask.
- Milestones: M1 ✅ M2 ✅ M3 ✅ M4 ✅. Next: M5 plan (player physics + input — p_user replaces fly stub, momentum/friction/step-up/fall/bob, pointer-lock mouse, D009 revisit).
- M5 plan merged (10 tasks/7 waves; FRICTION 0xe800, STOPSPEED 0x1000, walk thrust 51200/run 102400 pinned). Wave 1: pmaputl ∥ mouse.
- M5-07 merged (i_video.c scaling law + ev_mouse queue).
- Concurrency policy → 'more if safe' (user): saturated to cap 3 by pulling forward M6+M7 plan drafting (docs-only, disjoint branches) alongside M5 collision chain. M7 plan coarsely deps M6 (absent at authoring) — reconcile at merge.

## 2026-09-16 — /tmp MIRROR DECAY INCIDENT
- Discovered (M7 planner report): macOS /tmp cleanup ate the offline source mirrors (linuxdoom-1.10 down to 14 files, doomsrc to 5). Some earlier agent sessions ran against partial sources — their reports compensated via research-note verbatim quotes (verified adequate in spot checks: M5-01/02 cite p_maputl/p_map which existed at their run times).
- RESTORED: /tmp/DOOM-master/linuxdoom-1.10 = 62 .c files from official id-Software/DOOM master.zip (network fine). /tmp/doomsrc not restored (mirror canonical).
- RULE: every dispatch brief now assumes /tmp may be empty; implementers verify target file exists (one ls) before grep-planning; orchestrator re-checks mirror at session start (ls *.c | wc -l == 62).
- M7 plan + M6 plan merged (both written during the partial-source window; M7 explicitly routed ambiguities to empirical Freedoom L2 fixtures instead of folklore — sound methodologically).
- M5 chain 01-06 merged fast (mirror restored; source-truth corrections: no telefrag param on TryMove; slide is 3-retry intra-tic; noclip truth D012). Wave 6 parallel: live e2e + feel goldens.
- M5-09 merged: feel suite 13 scenarios — 7 analytic (friction asymptote 546133 = 200·4095/15·(256/232)^n etc), 32767 short overflow truth, corner livelock absent-on-grids truth.

## 2026-09-17 — 🏁 M5 COMPLETE (player physics + input)
- M5-08 (live page; pointer-lock real-device fix) + M5-10 (motion strip + 9 mechanical exit guards) merged. Gates: 973 tests, 14 e2e, goldens automap/walls/motion drift-free.
- L5 motion strip reviewed: wall approach scales correctly, bob oscillation visible around horizon, step-up at t=40 with squat lag + recovery, turn swing per feel-09 ramp. PASS.
- Feel evidence is analytic-grade: friction asymptote, fall parabola, turn-ramp re-derivations — 12/13 scenarios not hash-dependent.
- Milestones: M1-M5 ✅. Next: M6 (level mechanics) wave 1 per merged plan: thinker arena + fixture specials + p_tick.
- M6-02 merged (door/switch/teleport/secret families; WALLFIX+M4FIX byte-stability pinned to pre-change shas). Truth: DOOM1 linedef special@6/tag@8 RAW — no Hexen packing (brief assumption corrected by implementer from R01). Wave 2 dispatched: registry (R05 137-number manifest) + T_MovePlane/crush contract.
- M6-04 merged: plane-motion contract + crush truth (dmg=20 fixed/tic players; crush=1 kills monsters; door-reserved crush==2 semantics documented for M6-05).
- M6 wave 3 partial out: doors MERGED (first special alive in-engine), plats+lights running. Queue: 07/08/10/12 as slots free, then 11, then 13 (corpus+E1M1 route).

## 2026-09-17 — M6-09 merged (lights) — PAUSE PENDING behind M6-06
- Light thinkers live with exact PRNG profiles (flicker 0.25 draws/tic, flash &64 polarity-flip quirk, strobe 0 draws/tic, glow silent). Headless goldens re-blessed ONCE (reason 'sector-light specials live'); render goldens unmoved BECAUSE rdata still reads static md.sectors — live lights invisible to frames until M6-13 wires the renderer's sector source (GAP TRACKED: M6-13).
- PAUSE #3 requested: after M6-06 (plats, running) merges, stop. Resume queue: M6-07 floors/stairs/donut, M6-08 ceilings/crushers, M6-10 teleports, M6-12 feet-specials+exits (parallelizable per plan), then M6-11 switches/cards, M6-13 corpus+E1M1 route (includes renderer live-sector wiring).
