# M12-04 node probe — CPU profile flame summary

Profile: profiles/probe.cpuprofile (1639 ms sampled, 200 µs
interval; open in Chrome devtools → Performance). Regenerate:
`node scripts/perf-probe.mjs`.

## Measured table (node, per scene)

| scene | mobjs | sim p50/p95/max (ms) | render p50/p95/max (ms) | frame p50/p95 (ms) |
|---|---|---|---|---|
| e1m7 | 539 | 0.05 / 0.09 / 0.24 | 0.95 / 1.08 / 2.02 | 1.01 / 1.15 |
| e1m1 | 191 | 0.02 / 0.03 / 0.35 | 0.98 / 1.05 / 1.36 | 1.00 / 1.08 |
| fire40 | 231 | 0.05 / 0.16 / 0.38 | 1.12 / 1.39 / 1.84 | 1.19 / 1.50 |

Budget {"simP50Ms":8,"simP95Ms":13,"renderP50Ms":8,"renderP95Ms":13} — pinned per D-12a (tests/perf/budget.ts).
Machine: Apple M5 Pro (18 cores), node v22.22.1.

## Top self-time frames (✔ = repo engine frame)

| % total | self ms | frame | engine |
|---|---|---|---|
| 15.4 | 251.9 | `renderSegLoop @ src/render/segs.ts:364` | ✔ |
| 14.1 | 230.7 | `drawColumn @ src/render/cols.ts:113` | ✔ |
| 7.4 | 121.7 | `storeWallRange @ src/render/segs.ts:163` | ✔ |
| 4.5 | 74.5 | `mapPlane @ src/render/planes.ts:346` | ✔ |
| 4.2 | 69.4 | `bspSubsectorAt @ src/render/rthings.ts:683` | ✔ |
| 2.8 | 45.8 | `(anon) @ src/core/constants.ts:3` | ✔ |
| 2.7 | 44.8 | `drawVisSprite @ src/render/vissprites.ts:373` | ✔ |
| 2.5 | 41.4 | `drawPlanes @ src/render/planes.ts:422` | ✔ |
| 2.4 | 39.2 | `markAt @ src/render/planes.ts:476` | ✔ |
| 2.1 | 33.7 | `drawMaskedColumn @ src/render/masked.ts:130` | ✔ |
| 2.0 | 33.0 | `(anon) @ src/render/framebuffer.ts:3` | ✔ |
| 2.0 | 32.9 | `update @ src/render/rthings.ts:873` | ✔ |
| 1.9 | 30.5 | `post @ node:inspector:117` |  |
| 1.8 | 29.5 | `(garbage collector) @ (native):-1` |  |
| 1.4 | 23.5 | `drawSprite @ src/render/vissprites.ts:317` | ✔ |
| 1.4 | 22.7 | `renderFrame @ src/render/renderer.ts:226` | ✔ |
| 1.2 | 19.8 | `compose @ src/wad/texture.ts:249` | ✔ |
| 1.2 | 19.6 | `loadRenderWorld @ src/render/rdata.ts:168` | ✔ |
| 1.0 | 16.3 | `(anon) @ src/render/view.ts:3` | ✔ |
| 1.0 | 15.6 | `renderMaskedSegRange @ src/render/masked.ts:182` | ✔ |
| 0.9 | 14.5 | `(anon) @ src/render/cols.ts:3` | ✔ |
| 0.9 | 14.3 | `addLine @ src/render/bsp.ts:175` | ✔ |
| 0.9 | 14.3 | `scaleFromGlobalAngle @ src/render/segs.ts:147` | ✔ |
| 0.8 | 13.6 | `draw @ src/render/planes.ts:399` | ✔ |
| 0.8 | 12.9 | `drawVisSprite @ src/render/psprites.ts:104` | ✔ |
