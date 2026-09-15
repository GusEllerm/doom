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
