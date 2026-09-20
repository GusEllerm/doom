# Visual Review Board

Human-eye gate (D016). Images embedded below — preview pane (VS Code /
GitHub / any markdown preview) shows them inline; the `![...]()` targets are
repo-relative so they also resolve from the repo root. Verdict format at the
bottom. Paths absolute: `/Users/gusellerm/Projects/doom/docs/VISUAL-REVIEW.md`

---

## Tier 1 — E1M1 real-world views (highest signal)

**Criteria:** perspective converges to eye height, no stair-step wall joins;
textures aligned, no HOM garbage bleeding across sectors; lighting matches
rooms; flats tile seamlessly; sprites sit ON the floor, upright, plausible
scale (zombie ≈ door height); sky only in sky sectors.

### 1. Spawn corridor — *my pass: ✓ (M3)* — yours: ☐

![e1m1-spawn-east](../tests/render/goldens/walls/e1m1-spawn-east.png)

### 2. Atrium (multi-height, light variation) — *my pass: ✓ (M3)* — yours: ☐

![e1m1-atrium](../tests/render/goldens/walls/e1m1-atrium.png)

### 3. Courtyard sky (sky only above sky ceilings) — *my pass: ✓ (M4)* — yours: ☐

![e1m1-court-sky](../tests/render/goldens/walls/e1m1-court-sky.png)

### 4. Courtyard things (size ladder, on-floor placement) — *my pass: ✓ (M4)* — yours: ☐

![e1m1-court-things](../tests/render/goldens/walls/e1m1-court-things.png)

### 5. Doorway middle-texture (see-through above / solid below) — *my pass: ✓ (M3)* — yours: ☐

![e1m1-doorway-midtex](../tests/render/goldens/walls/e1m1-doorway-midtex.png)

### 6. Busy mix — draw-order stress — *my pass: ✗ never* — yours: ☐

![e1m1-busy-mix](../tests/render/goldens/walls/e1m1-busy-mix.png)

### 7. Vista corridor — COLORMAPS light falloff — *my pass: ✗ never* — yours: ☐

![e1m1-vista-corridor](../tests/render/goldens/walls/e1m1-vista-corridor.png)

---

## Tier 2 — motion & mechanics strips (temporal)

**Criteria:** read left→right as time; acceleration not teleport; bob gentle
(±~5 px); machines cycle smoothly; per-frame stats consistent with what you
see.

### 8. Walk / turn / step-up — *my pass: ✓ (M5)* — yours: ☐

![m5 motion](../tests/render/goldens/motion/m5-10-walk-turn-step.png)

### 9. Door-through — *my pass: ✗ never* — yours: ☐

![m6 door](../tests/render/goldens/mechanics/m6-door-through.png)

### 10. Lift-through — *my pass: ✗ never* — yours: ☐

![m6 lift](../tests/render/goldens/mechanics/m6-lift-through.png)

### 11. Crusher cycle — *my pass: ✓ (M6 audit)* — yours: ☐

![m6 crusher](../tests/render/goldens/mechanics/m6-crusher.png)

### 12. Light strobe — *my pass: ✓ (M6 audit)* — yours: ☐

![m6 light](../tests/render/goldens/mechanics/m6-light-paint.png)

---

## Tier 3 — weapons ⚠ PARKED — do not review yet

The "same blob centered" bug you found is being fixed + re-blessed (M7-11).
When the fix merges, check: montage tiles the 15 scenes; gun bottom-anchored
(bottom ~⅓, slightly right of center); every weapon visually distinct.

![montage (currently broken — monster-sprite census)](../tests/render/goldens/weapons/montage.png)

Sample scene (also currently broken):

![wpn pistol raise](../tests/render/goldens/weapons/wpn-pistol-raise.png)

---

## Tier 4 — fixture geometry (sanity only; noise textures intentional)

Fix textures are generated test patterns, **not game art** — judge geometry
only: watertight joins, panning per offsets, masked fences see-through, sky
continuity.

### 15. Box-room joins (12-view family) — yours: ☐

![fix a-n](../tests/render/goldens/walls/fix-a-n.png)
![fix b-s](../tests/render/goldens/walls/fix-b-s.png)

### 16. Masked draw — yours: ☐

![mask back](../tests/render/goldens/walls/fixmask-back.png)
![mask fence](../tests/render/goldens/walls/fixmask-fence.png)

### 17. Sky room/seam — yours: ☐

![sky room](../tests/render/goldens/walls/fixsky-room.png)
![sky seam](../tests/render/goldens/walls/fixsky-seam.png)

### 18. Texture panning alignment — yours: ☐

![pan panned](../tests/render/goldens/walls/fixpan-panned.png)
![pan rowskip](../tests/render/goldens/walls/fixpan-rowskip.png)

---

## Automap

**Criteria:** one-colored line work, player arrow + trail triangle, thing
dots, labelled modes.

### 19. Spawn + 20 tics — *my pass: ✓ (M2)* — yours: ☐

![am spawn](../tests/render/goldens/automap/e1m1-spawn-tab-20tics.png)

### 20. Follow noclip run — *my pass: ✓ (M2)* — yours: ☐

![am follow](../tests/render/goldens/automap/e1m1-follow-noclip-forward-35.png)

### 21. Free pan/zoom — *my pass: ✓ (M2)* — yours: ☐

![am panzoom](../tests/render/goldens/automap/fix-free-panzoom-31.png)

---

## Verdicts

Reply anything like:

- `#6 fail — wedge of garbage bottom-left`
- `court-things: barrels float`
- `#9 pass`

Each fail becomes a tracked investigation; **findings beat goldens** —
re-bless only with a source-explained cause.
