# M12 exit sweep — full-episode hardening (2026-09-23)

Plan of record: `docs/design/M12-plan.md`. Tasks M12-01..10 all merged
(commit refs in docs/TASKS.md). Every number below was either re-run THIS
turn (marked RAN) or read from a committed artifact (marked CITED).

## Exit gates (fresh, RAN this turn)

| gate | result |
|---|---|
| `npm run check` | **GREEN** — 185 files / **3574 tests** passed, 2 skipped (38.4 s); tsc + eslint + vitest + license-audit PASS in-chain (RAN) |
| `npx vitest run tests/render/allMaps.test.ts` | **128 passed**, 1.6 s — the every-map L3 corpus re-run standalone (RAN; also green inside the full check) |
| `npm run e2e -- --list` | **74 tests in 20 files** (chromium + chromium-audio + build projects; experimental firefox/webkit projects exist but are `PW_EXTRA_BROWSERS`-gated and skipped locally) (RAN) |
| goldens `maps` set | 126 golden entries in `tests/render/goldens/maps/meta.json`, all `hom == 0`; the suite asserts sha256 of every scene (CITED meta.json + suite green above; no regeneration) |

## Corpus + census numbers (the milestone's headline)

- **Census (M12-01):** 9/9 maps, **ZERO gaps** — all line/sector specials in
  the live registry, all sprites/doomednums resolve, 14/14 lump surfaces,
  BSP+blockmap+P_SetupLevel complete 9/9 (`docs/reports/M12-census.md`,
  machine JSON `M12-census.json`, live assertions
  `tests/headless/allMapsCensus.test.ts`, 37 green inside the check).
- **Render corpus (M12-02):** **117 analytically-derived viewpoints × 9 E1
  maps + 9 per-map montage sheets = 126 entries** in the `maps` golden set
  (meta.json scene count, per-map: E1M1 13, E1M2 12, E1M3 12, E1M4 14,
  E1M5 14, E1M6 14, E1M7 14, E1M8 11, E1M9 13 views). Pipeline: double
  render byte-equal, HOM=0, all overflow counters 0, non-single-color
  filter; pinned WAD sha256 `7323bcc1…703d` (CITED meta.json + montage doc).
  D016 eyes-on: PASS at the M12-02 merge turn (2 zero-light scenes legit
  map lighting, per JOURNAL).
- **Exit routes (M12-03):** **9/9 maps** scripted to exits with per-tic
  trigger ledgers (19 tests, ~0.5 s, determinism double-run) + L4 browser
  playthroughs E1M1/E1M2/E1M8 ×3, zero console errors (merge 0bf3c54).
  E1M8 TRUTH: the pinned WAD has no barons/sector-11 — finale = W1 ring +
  ga_victory, faithful.
- **Soak (M12-05):** `tests/e2e-soak/RESULTS.md` — CI default **10 sim-min
  (21,001 tics, 28 rotations)**: 0 violations, heap net +6.02 MB plateau
  flat; one-shot **30-min marathon (63,000 tics)**: 0 violations, 26
  faithful reborns, reload bands Δ0 exact ×26+ revisits, heap net +4.17 /
  peak +7.19 MB over 30 GC-forced samples — **no slope, 0 leaks**, no src
  change, nothing re-blessed (CITED RESULTS.md).
- **Perf (M12-04), measured (CITED `tests/perf/evidence/`):** node probe —
  heaviest scene E1M7 (539 mobjs): sim p50 **0.048 ms/tic**, render p50
  **0.950 ms/frame**, frame p95 1.17 ms; worst scene fire40 frame p95 1.45
  ms. Browser real-rAF (30 s × 3 scenes): 60.0 fps / 35.0 Hz, worst
  **frame p95 2.4 ms** (E1M1) vs pinned caps p50 ≤ 8 / p95 ≤ 13 ms
  (`tests/perf/budget.ts`). **Zero optimization commits** — the profile is
  the deliverable; hottest engine frame `renderSegLoop` 15.5 % self.
- **Production build (M12-06):** game-only dist; total gzipped JS measured
  **181,516 B** vs pinned cap 500,000 B (`e2e/build.spec.ts:49`); debug
  seam `__doom` verified ABSENT without `?test=1` (merge ab1ce6e).
- **License audit (M12-07):** PASS inside `npm run check` — 374/374 tracked
  sources SPDX-headered, 0 committed blobs under wads/, 2868 name literals
  classified, CREDITS + source offer + Freedoom pins present (RAN).
- **Montages (D016 pack):** `tests/render/goldens/maps/e1m{1..9}-montage.png`
  — 9 contact sheets, blessed goldens, grid + per-tile derivation tables in
  `docs/reports/M12-montage.md`.

## Known-open items for Phase 4 (stated, not hidden)

1. **m10-audio music-lump assert flake** — flaked once during M12-08
   (pre-existing, noted in the merge note 5fdbde0); Phase-4 flake-hunt item.
2. **firefox/webkit manual matrix pending a human** — only chromium is
   installed locally (probe: `docs/reports/M12-browser-matrix.md` §1);
   the 15-min per-engine script + findings table are ready to sign.
3. **Playtest checklists awaiting the user** — M10 ear session
   (`docs/reports/M10-playtest.md`: MUSIC_TRIM, audible distance), M11
   hands (`docs/reports/M11-playtest.md`), and this milestone's montage
   re-view pointer in `docs/VISUAL-REVIEW.md`.

## Discrepancies found during closure (flagged, not silently fixed)

- The M12-04 merge-subject numbers "sim 0.204ms/tic render 0.514ms/frame"
  appear in NO committed evidence file; the exit record uses the measured
  evidence tables above (which are *better*: 0.048/0.950 p50 node, worst
  browser p95 2.4 ms).
- M12-02 merge-subject says "108 viewpoints"; the committed meta.json says
  **117 viewpoints + 9 montages = 126 golden entries**. The JOURNAL soak
  line says "15-min CI default, 60-min marathon"; RESULTS.md pins 10-min
  default / 30-min marathon (what was executed).
- The exit brief's D-12 lettering (a=E1-only, b=perf) conflicts with the
  plan of record + release notes, where **D-12a = measure-then-pin,
  D-12b = E1-only**. The DECISIONS ledger keeps the PLAN's letters and adds
  the two late in-milestone decisions as D-12g (elevator/B-11) and D-12h
  (sensitivity persistence).
