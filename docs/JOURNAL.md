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
