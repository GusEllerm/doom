# M12-04 node probe — CPU profile flame summary

Profile: profiles/probe.cpuprofile (1646 ms sampled, 200 µs
interval; open in Chrome devtools → Performance). Regenerate:
`node scripts/perf-probe.mjs`.

## Measured table (node, per scene)

| scene | mobjs | sim p50/p95/max (ms) | render p50/p95/max (ms) | frame p50/p95 (ms) |
|---|---|---|---|---|
| e1m7 | 539 | 0.05 / 0.08 / 0.21 | 0.95 / 1.10 / 2.02 | 1.00 / 1.17 |
| e1m1 | 191 | 0.02 / 0.03 / 0.07 | 0.98 / 1.10 / 1.38 | 1.00 / 1.12 |
| fire40 | 231 | 0.05 / 0.15 / 0.32 | 1.14 / 1.34 / 1.53 | 1.20 / 1.45 |

Budget {"simP50Ms":8,"simP95Ms":13,"renderP50Ms":8,"renderP95Ms":13} — pinned per D-12a (tests/perf/budget.ts).
Machine: Apple M5 Pro (18 cores), node v22.22.1.

## Top self-time frames (✔ = repo engine frame)

| % total | self ms | frame | engine |
|---|---|---|---|
| 15.5 | 255.1 | `renderSegLoop @ src/render/segs.ts:364` | ✔ |
| 14.8 | 243.6 | `drawColumn @ src/render/cols.ts:113` | ✔ |
| 7.5 | 123.8 | `storeWallRange @ src/render/segs.ts:163` | ✔ |
| 4.9 | 80.9 | `mapPlane @ src/render/planes.ts:346` | ✔ |
| 4.2 | 68.8 | `bspSubsectorAt @ src/render/rthings.ts:683` | ✔ |
| 2.5 | 41.9 | `markAt @ src/render/planes.ts:476` | ✔ |
| 2.4 | 39.1 | `drawVisSprite @ src/render/vissprites.ts:373` | ✔ |
| 2.3 | 38.1 | `drawPlanes @ src/render/planes.ts:422` | ✔ |
| 2.3 | 37.6 | `drawMaskedColumn @ src/render/masked.ts:130` | ✔ |
| 2.2 | 36.5 | `(anon) @ src/core/constants.ts:3` | ✔ |
| 2.0 | 32.7 | `(anon) @ src/render/framebuffer.ts:3` | ✔ |
| 1.9 | 31.5 | `post @ node:inspector:117` |  |
| 1.6 | 27.0 | `(garbage collector) @ (native):-1` |  |
| 1.6 | 26.0 | `update @ src/render/rthings.ts:873` | ✔ |
| 1.5 | 25.2 | `renderFrame @ src/render/renderer.ts:226` | ✔ |
| 1.4 | 23.0 | `drawSprite @ src/render/vissprites.ts:317` | ✔ |
| 1.3 | 21.2 | `loadRenderWorld @ src/render/rdata.ts:168` | ✔ |
| 1.3 | 21.0 | `compose @ src/wad/texture.ts:249` | ✔ |
| 1.2 | 20.3 | `renderMaskedSegRange @ src/render/masked.ts:182` | ✔ |
| 1.2 | 19.0 | `addLine @ src/render/bsp.ts:175` | ✔ |
| 1.0 | 16.3 | `(anon) @ src/render/view.ts:3` | ✔ |
| 0.8 | 13.5 | `walk @ src/render/bsp.ts:301` | ✔ |
| 0.8 | 13.1 | `renderSubsector @ src/render/bsp.ts:150` | ✔ |
| 0.8 | 13.0 | `decodePatch @ src/wad/patch.ts:53` | ✔ |
| 0.7 | 11.6 | `pointToAngle @ src/render/view.ts:252` | ✔ |
