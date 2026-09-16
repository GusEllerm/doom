# ARCHITECTURE — doom-ts

Status: Phase 2 architecture design. Evidence base: docs/research/ R01–R12 (source-verified against linuxdoom-1.10 mirrors per D002). Baseline: PROMPT.md §3/§4/§9, decisions D001–D007.

Table of contents:
1. Module layout and import rules
2. Core contracts (types/interfaces)
3. Frame/tic data flow and determinism
4. Renderer architecture
5. Area designs: specials, AI, weapons, UI, audio, persistence
6. Test strategy
7. Debug API
8. Settings, persistence keys, save versioning
9. Risks / decision-required (ADR-lite)
10. Notes sufficiency

## 1. Module layout and import rules

### 1.1 src/ tree

```
src/
  main.ts                  # boot: fetch WAD bytes, wire platform→sim→render, rAF loop
  debug.ts                 # window.__doom install (exists; §7 replaces stubs)
  types/debug.ts           # debug API types (exists)

  core/                    # shared deterministic primitives; NO imports from sim/render/platform/wad
    fixed.ts               #   fixed_t ops (§2.5), angle ops, Overflow policy
    tables.ts              #   finesine/finetangent/tantoangle/rndtable generation
    random.ts              #   P_Random / M_Random streams (R04 §5)
    constants.ts           #   FRACUNIT, ANG45…, TICRATE, MAPSIZE, limits

  wad/                     # pure decoders: bytes in → typed data out. No sim/render imports.
    wadfile.ts             #   header + lump dir, named lookup, case rules (R01 §1-2,15)
    mapdata.ts             #   THINGS…BLOCKMAP decode → MapData structs (R01 §4-13)
    patches.ts  flats.ts  textures.ts  palette.ts  # R02 decoders (PLAYPAL/COLORMAP/patch/flat/TEXTURE1/PNAMES)
    sprites.ts             #   sprite lump census + SPRITE+rot naming (R02 §8, R06 §4)
    sounds.ts  music.ts    #   DS* header decode (R10 §1); MUS + SMF → unified event list (R10 §3-4)
    dehacked.ts            #   minimal Frame-fullbright parse (R12 §9.3)
    info/                  #   data-driven tables transcribed from info.c: mobjinfo.ts, states.ts,
                           #   sprnames.ts, weaponstates.ts, sfxinfo.ts, soundsequences stub

  sim/                     # THE DETERMINISTIC CORE. Allowed imports: core/, wad/ (data only at load),
                           #   nothing from render/ or platform/. No DOM, no Date/performance, no Math.random.
    g_game.ts              # gamestate machine, G_InitNew, G_Ticker, ticcmd ring, demo hooks (§3)
    state.ts               # live world state (players/sectors/lines/mobjs) + hashState() (§3.4); read-views for render/
    g_saveg.ts             # save serialize/deserialize — pure byte streams (§5.6)
    p_tick.ts              # thinker lists, P_Ticker, leveltime
    p_map.ts p_maputl.ts   # blockmap, P_CheckPosition/P_TryMove/P_BoxOnLineSide, traversal iterators
    p_local.ts             # intercept_t/slidebyte model, line opening/closing
    p_mobj.ts              # mobj spawn/remove, P_SetMobjState, P_MobjThinker, P_SpawnMapThing (R06)
    p_user.ts              # P_MovePlayer, thrust/friction/bob, P_CheckCameraPosition (R04 §7-9)
    p_switch.ts p_spec.ts p_doors.ts p_plats.ts p_floor.ts p_ceilng.ts p_lights.ts p_telept.ts
                           #   line/sector specials (R05), 1:1 module names for auditability
    p_enemy.ts p_sight.ts  # AI: A_Look/A_Chase/attacks/infighting/bossdeath (R07)
    p_inter.ts             # damage, armor, kills, pickups, infighting target swap (R06/R08)
    p_pspr.ts              # weapon state machine, A_Fire*, raise/lower (R08)
    p_setup.ts             # P_SetupLevel: node-side line grouping, sector linking, spawn order (R04 §12)
    a_actions.ts           # ActionId switch dispatcher (A_Chase, A_PosAttack, …) — numeric ids, no closures (R06 §10)
    d_main.ts              # D_DoomLoop-equivalent per-tic dispatch: events, G_BuildTiccmd, M_Ticker, G_Ticker
    m_menu.ts              # menu STATE + M_Responder/M_Ticker — deterministic (affects game), input arrives as event structs (§5.4)
    am_map.ts wi_stuff.ts f_finale.ts  # automap/menu/intermission STATE machines (draw in render/ui/)
    game_loop_state.ts     # statusflags, gameaction, demoplayback flags

  render/                  # READS sim state, NEVER mutates (enforced by convention + review; §4)
    renderer.ts            # R_RenderPlayerView pipeline (§4)
    bsp.ts segs.ts drawsegs.ts plane.ts masked.ts sky.ts
    sprites.ts             # R_ProjectSprite/visplane sprite list, 8-rot + mirror (R03 §9)
    psprites.ts            # weapon sprites onto framebuffer
    cols.ts flats.ts       # column/post blitters, colormap application, fuzz
    palette.ts             # PLAYPAL/COLORMAP → working 320*200 index buffer + RGBA blit
    automap.ts hud.ts statusbar.ts menu.ts intermission.ts  # overlay drawers (state → pixels)
    framebuffer.ts         # 320*200 Uint8 index buffer + Uint8ClampedArray RGBA scratch; capture() hook

  platform/                # the ONLY place DOM/Web APIs are touched
    canvas.ts              # canvas attach, nearest-neighbour scale, present(framebuffer)
    input.ts               # keyboard/pointer-lock → Event[] (d_event_t equivalent), never mutates sim directly
    audio/                 # audio.ts (bus graph), sfx.ts (mixer+channels), music.ts (synth) (§5.5)
    storage.ts             # IndexedDB wrapper: saves/settings (§8)
    clock.ts               # rAF accumulator, wall-clock EXCLUSIVELY here (§3)
    wadload.ts             # fetch/arraybuffer retrieval of the IWAD, sha256 verify
    netbench.ts            # (absent by design — no netcode; "netbench-free" per brief)
```

### 1.2 Responsibilities and one-way data flow

```
platform/input ──events──▶ platform/clock ──ticcmds──▶ sim (d_main→G_Ticker)
                                                        │  state (read-only view)
                                                        ▼
platform/canvas ◀──RGBA blit── render/framebuffer ◀── render/* (per video frame)
platform/audio ◀──audio events── sim (S_* queue drained by platform per frame; §3.1 step 4)
platform/storage ◀─▶ sim serialize/deserialize APIs only (§5.6, §8)
wad/* ──decoded data──▶ sim/p_setup + render/*Init (load time only)
```

- **wad/** never imports sim/render/platform; sim/p_setup and render init consume its outputs once per level/boot.
- **sim/** imports core/ and (load-time only) wad/; never render/, never platform/. Platform callbacks into sim: `queueEvents()`, `buildTiccmd()`, `stepTics(n)`.
- **render/** imports core/, wad/ (cached graphics), and reads `sim/state.ts` exports. Mutating anything under sim/ from render/ is a review-blocking violation; the sim state module exposes read-typed views (`Readonly` interfaces) — the discipline is enforced structurally, not by freezing.
- **core/** imports nothing.

### 1.3 Import-rule enforcement — choice: eslint `no-restricted-imports`

We already run ESLint flat config in `npm run check` (eslint.config.js). dependency-cruiser would add a second tool + CI step for the same job; eslint zones cover it (Task **A-INT1**: extend eslint.config.js with `no-restricted-imports` patterns per directory — sim: ban `render/** platform/**`, forbid `Math.random`, `Date.now`, `performance`, `document`, `window` via `no-restricted-globals`/`no-restricted-syntax` overrides; render: ban `sim/**` *mutators* is not expressible in eslint — covered by the Readonly-view convention + a lint rule banning imports of `sim/` non-`state*` modules and by tests; wad: ban sim/render/platform; core: ban everything else). Deviation cost if eslint patterns prove too weak later: revisit dependency-cruiser at the M12 audit (tracked as risk A-06).

## 2. Core contracts

All types live where they are owned; cross-area imports go through these contracts (they become the M1 “contract task” landed before parallel work, per PROMPT §5).

### 2.1 WAD access — `wad/wadfile.ts`

```ts
export interface LumpInfo { name: string; lumpnum: number; }
export class WadFile {
  static parse(buf: ArrayBuffer): WadFile;            // 'IWAD'/'PWAD' header + dir (R01 §1-2)
  readonly identification: 'IWAD' | 'PWAD';
  lumpNumByName(name: string): number;                // last-match wins, -1 absent (R01 §15)
  lumpNumAt(index: number): number;                   // by dir index (for range scans)
  lumpName(num: number): string;
  lumpRange(startMarker: string, endMarker: string): number[]; // skips zero-size markers (R12 §9.7)
  readLump(num: number): Uint8Array;                  // zero-copy subarray
  readLumpByName(name: string): Uint8Array;
  has(name: string): boolean;
}
```

### 2.2 Map data — decoded structs (`wad/mapdata.ts`, sizes per R01 §4-13)

```ts
export interface MapData {
  name: string;                       // 'E1M1' or 'MAP01'; both patterns accepted (R01 §17)
  things: Uint8Array;                 // raw 10 B records; typed view helpers below
  lineDefs: LineDef[]; sideDefs: SideDef[]; vertices: Vertex[];
  segs: Seg[]; ssectors: SubsectorDef[]; nodes: Node[]; sectors: SectorDef[];
  reject: Uint8Array; blockmap: Uint8Array;          // reject = linear n²-bit packing (R01 §12)
}
export interface Vertex { x: number; y: number }                     // fixed later (i32 raw units)
export interface SideDef { sector: number; toptexture: string; midtexture: string; bottomtexture: string; offset: [number, number]; light: number /*unused*/ }
export interface LineDef { v1: number; v2: number; front: number; back: number; flags: number; special: number; tag: number }
export interface Seg { v1: number; v2: number; angle: number; /*BAM, u32-as-number*/ line: number; side: number; offset: number }
export interface SubsectorDef { numsegs: number; firstseg: number }
export interface Node { bbox: BBox; splitx: number /*fixed*/; splity: number; dx: number; dy: number; right: number; left: number } // low bit = subsector flag
export interface SectorDef { floorLh: number; ceilingLh: number; floorFlat: string; ceilingFlat: string; lightLevel: number; special: number; tag: number }
```

Sim-side runtime structs (`sim/state.ts`) mirror these with mutable live fields (`sector_t.floorZ/floorCeiling` thinker refs, `line_t.special` rerouted by P_GroupLines, `validcount` etc. per R04 §13, R06 §10).

### 2.3 mobj/state tables — data-driven (R06)

```ts
export type StateId = number;                       // 0 = S_NULL; index == statenum_t order (R06 §10)
export interface State { sprite: number; frame: number /* frameIndex | FF_FULLBRIGHT 0x8000 */;
                          tics: number;              // i16 semantics, -1 forever, 0 = loop-advance
                          action: ActionId;          // 0 = none; numeric dispatch via switch in a_actions.ts
                          nextstate: StateId; misc1: number; misc2: number }
export interface MobjInfo { spawnState: StateId; flags: number; health: number; radius: fixed;
                             height: fixed; mass: number; damage: number; speed: fixed;
                             painState: StateId; deathState: StateId; xDeathState: StateId;
                             respawnState: StateId; painChance: number }
export const states: readonly State[];               // 967 rows, info.c order (stateId arithmetic like S_PLAY_RUN1+n works)
export const mobjinfo: readonly MobjInfo[];          // index == MT_ enum
export const doomednumToMobj: Map<number, MobjType>; // built at init; unknown type → warn+skip (R12 §9.1)
```

`mobj_t` is a plain object (fields exactly per R04 §13 / R06 §10) held in the thinker arena (§3.5): x/y/z/mom* are `fixed` (int32 numbers); `state: StateId`; `flags: number` (MF_* bitset); `target/tracer` are **thinker indices** (0 = null) not object refs kept ad hoc — index refs keep save/load trivial (§5.6).

### 2.4 player_t / ticcmd / thinker

```ts
export interface TicCmd { forwardMove: number /*int8*/; sideMove: number /*int8*/; angleTurn: number /*int16, demo-quantized §3.5.2*/;
                          buttons: number; // BT_ATTACK 1 | BT_USE 2 | BT_FORWARD 4 | BT_TURNO90 8…BTS_*
                          actualTurn: number }      // debug-only, never sim-visible
export interface Player { mo: ThinkerId; playerState: PST_LIVE|PST_DEAD|PST_REBORN; cmd: TicCmd;
  viewZ: fixed; viewHeight: fixed; deltaViewHeight: fixed; bob: fixed; // no bobmove table in 1.10 (R04 §7)
  health: number; armorPoints: number; armorType: number; powers: Int32Array /*NUMPOWERS*/;
  cards: Int32Array /*NUMCARDS*/; backpack: number;
  readyWeapon: number; pendingWeapon: number; weaponOwned: Uint8Array; ammo: Int32Array; maxAmmo: Int32Array;
  attackDown: number; useDown: number; cheats: number; refire: number;
  killCount: number; itemCount: number; secretCount: number;
  damageCount: number; bonusCount: number;
  extraLight: number; fixedColormap: number; attacker: ThinkerId;
  psprites: Psprite[] /* {state: StateId; tics: number} × NUMPSPRITES */ }
// (full field list per R04 §13; kept as an object with fixed slots, no Map/any)
```

Thinker arena (`sim/p_tick.ts`): insertion-ordered `Map<ThinkerId, Thinker>` (Map iteration order is spec-guaranteed = vanilla list order, R11 §6.4); removal = delete + sentinel tic -1 semantics; removal during iteration only takes effect next visit (vanilla `(actionf_v)(-1)`).

### 2.5 Numeric policy — DECISION

**fixed_t = plain `number` used as a frozen int32** (every producer ends `|0`; unsigned angle ops `>>>0`). **No BigInt in sim/render hot paths**; BigInt allowed only in load-time table generation. Rationale (35 Hz sim + 60 fps renderer in JS):

- V8 doubles hold all int32 arithmetic exactly (|v| < 2^53): add/sub/shift/bit-ops on int32 are exact and ~1 op, vs BigInt which is 10-100× slower per op and allocates. The renderer's inner loops are tens of FixedMul per column — BigInt there forfeits the 60 fps budget for zero fidelity gain.
- The only non-exact primitive is the 32×32 product in FixedMul (up to 2^62). Exact fix without BigInt: 16-bit limb split (below). `Math.floor(a*b/65536)` drifts (R03 §1, R04 §4) → forbidden.
- FixedDiv matches vanilla exactly via the quoted saturating-guard + double-truncation recipe (R04 §4) — no emulation needed beyond `Math.trunc`.
- Golden-framebuffer/demo parity then hinges only on *call-order discipline* (§3.5), which unit tests pin via known-vector tests (finesine[0]=25, R03 §1; FixedMul corners incl. MININT×-1).

```ts
// core/fixed.ts — exact 16.16 helpers (all take/return int32-as-number)
const FB = 16;
export function FixedMul(a: number, b: number): number {   // (a*b)>>16, low 32 bits, exact
  const a0 = a & 0xffff, a1 = a >> 16, b0 = b & 0xffff, b1 = b >> 16;
  return (Math.imul(a1, b1) << 16) + (a1 * b0 + a0 * b1) + (Math.imul(a0, b0) >>> 16) | 0;
}
export function FixedDiv(a: number, b: number): number {   // vanilla m_fixed.c recipe verbatim
  if ((Math.abs(a) >> 14) >= Math.abs(b)) return (a ^ b) < 0 ? -2147483648 : 2147483647;
  return Math.trunc((a / b) * 65536) | 0;                  // same op order as FixedDiv2's double path
}
```

(Split check: a·b = a1b1·2³² + mid·2¹⁶ + lo; each term exact in double; `|0` discards above-bit-31 exactly like the C long→int truncation. Unit-tested against C outputs on random + corner vectors — task A-FX1.)

| Op | C original | TS implementation | Notes |
|---|---|---|---|
| FixedMul | `(long long)a*b >> 16` | limb split above | hot; ~4 int-ops |
| FixedDiv | saturate + double | guard + `Math.trunc((a/b)*65536)\|0` | saturates ±MAXINT |
| FixedAdd / >>FRACBITS / << | `+`, `>>`, `<<` | `+\|0`, `a>>16`, `a<<16` | arithmetic shift = JS `>>` |
| angle add/sub | `unsigned` wrap | `(a+b)>>>0`, `(a-b)>>>0` | BAM u32-as-number |
| angle→fine | `ang>>19` | `ang>>>19` | index into Int32Array(10240) |
| finesine/finecosine | tables.c data | Int32Array generated `round(65536*sin((i+0.5)*2π/8192))` | verified formula (R03 §1); cosine = +2048 alias |
| SlopeDiv/tantoangle | `(num<<3)/(den>>8)` clamp 2048 | same with doubles + clamp | R_PointToAngle octants verbatim (R03 §1) |
| `0xffffffffu/scale` | unsigned div | `(0xffffffff/scale)>>>0` | renderer clipping (R03 §18.5) |

Angles: `angle_t` values are `number`s normalized `>>>0`. Renderer may compare angles numerically after `>>>0`. All tables are `Int32Array`/`Uint32Array`, built once in `core/tables.ts`.

## 3. Frame/tic data flow and determinism

### 3.1 Main loop (platform/clock.ts + sim/d_main.ts)

Wall clock exists in exactly one place. Numbered per-frame sequence (rAF callback, target 60 fps):

1. `clock.tick(now)`: `acc += (now - last) * 35/1000` clamped to ≤ 4 tics/frame (spiral guard); `nTics = floor(acc); acc -= nTics`.
2. `input.drainEvents()` → `DoomEvent[]` pushed to the sim event queue (key/mouse/buttons only; the menu responder consumes them during step 3a, per R09 §1.5).
3. For each of the `nTics` tics (never more than 4, never a fraction):
   a. `d_main.dProcessEvents()` — events → menu responder (may change gamestate/gameaction) or player input state.
   b. `g_game.buildTiccmd()` from current input state → `netcmds[0][gametic % 12]` (single-player consoleplayer ring, R04 §1/§3). Demo recording writes the 4-byte quantized tic here (§5.6); demo playback *reads* the tic here instead of building it.
   c. `m_menu.ticker()`, then `g_game.ticker()` (§3.2 order).
   d. `gametic++`.
4. `platform/audio.update(players[0].mo)` — positional update; drain the sim→audio event queue (`{sfxId, sourceMobj}` entries enqueued by `S_StartSound` calls during the tics; bounded queue, priority drops at mix time; §5.5).
5. `renderer.renderPlayerView(players[0])` — pure read of sim state → 320×200 index buffer (every frame, even when 0 tics ran, for menu/mouse responsiveness).
6. `canvas.present(framebuffer)` — RGBA blit via the current palette/colormap lookup (§4.7).

`step()` in the debug API and tests drive 3a–3d directly with a scripted ticcmd stream — no rAF, no clock (headless path). `ticdup=1`; the accumulator replaces `I_GetTime`/`TryRunTics` — the one deliberate non-vanilla mechanism, and it changes nothing a determinism contract observes (same tic sequence).

### 3.2 Per-tic order inside the sim (verbatim from R04 §1)

1. Rebirth pass (`PST_REBORN` → `G_DoReborn`).
2. `gameaction` drain (ga_loadlevel/newgame/loadgame/savegame/playdemo/completed/victory/worlddone).
3. Per player: copy `netcmds[i][gametic % 12]` → `player.cmd`; demo read/write; turbo check.
4. Special buttons (pause/save bits).
5. Dispatch by `gamestate`: `GS_LEVEL` → `P_Ticker()` + `ST_Ticker` + `AM_Ticker` + `HU_Ticker`; `GS_INTERMISSION` → `WI_Ticker`; `GS_FINALE` → `F_Ticker`; `GS_DEMOSCREEN` → `D_PageTicker`.

`P_Ticker` (if !paused): `P_PlayerThink` per playing player (P_MovePlayer inside) → `P_RunThinkers` (deferred-thinker swap first; thinkers added during the tic tick next tic; removal sentinel = tics -1, lazy removal on next visit) → `P_UpdateSpecials` → `P_RespawnSpecials` → `leveltime++`.

### 3.3 PRNG discipline (R04 §5, R11 §4.4)

- `core/random.ts`: `pRandom()` (prndindex) for all gameplay; `mRandom()` (rndindex) for presentation-only use (SFX pitch, status-bar face). Pure reads over the transcribed `rndtable` (verbatim in R04 §5).
- No `Math.random` below the tic driver (lint-enforced in sim/, §1.3).
- `M_ClearRandom()` on new game/level setup; both indices saved/restored by save/load (§5.6) — a vanilla-parity gap deliberately fixed here.

### 3.4 State hashing (test hook)

`sim/state.ts: hashState(): number` — FNV-1a over a canonical byte serialization: leveltime, both rnd indices, per-player fixed fields, per-sector (floorZ, ceilingZ, lightLevel, special), per-live-mobj (x,y,z,stateId,tics,flags,health,targetIndex) in thinker-arena order. Used by headless-sim golden-state tests and the debug `state()` snapshot.

### 3.5 Determinism rules (binding; R04 §14 + R11 §6)

1. Sim advances only inside `G_Ticker`; wall-clock only in platform/clock.
2. Input enters only as quantized ticcmds (angleturn packed `(x+128)>>8`, same lossy path in record and live).
3. Gameplay RNG only `pRandom`.
4. int32 fixed everywhere (§2.5); `>>` arithmetic; `P_InterceptVector` `>>8` pre-shifts kept verbatim.
5. Thinker tick order = insertion order; moving a mobj between blockmap cells re-links block links only, never re-inserts the thinker.
6. Iteration-order-safe containers only: `Map`/arrays; never integer-keyed plain objects (R11 §6.5).
7. Load = rebuild (`P_SetupLevel` in identical order) + apply, never restore references; saved indices resolve against rebuilt arrays.
8. Renderer never mutates sim state; `validcount++` bumps live in sim traversal code only.

## 4. Renderer architecture

All of §4 implements R03 (line/section refs are R03's). One `RenderState` object, preallocated per boot; no per-frame allocation in steady state.

### 4.1 Pipeline per frame (R_RenderPlayerView, R03 §2)

1. Setup: viewplayer/viewang/viewx/viewy/viewz from `player.mo` + `viewheight`/`bob`; `viewcos/viewfinecosine`; `R_InitTextureMapping` (viewangletox/xtoviewangle/clipangle; constant after FOV init).
2. Clip sidedef: open `headtailchain` (R_CheckSides).
3. BSP walk `R_RenderBSPNode` from root (R03 §3): node → onP/chain splitting with the intercept stack; subsector → `R_AddLine` per seg (tangent clip-angle rejection, R03 §4); back sides queued for masked segs.
4. `R_StoreWallRange` → drawsegs + solidsegs maintenance (R03 §5) — this is the HOM-free occlusion core (§4.6).
5. `R_DrawPSprites` (weapon) queued into vissprites with the psprite flag.
6. Back side defs → masked middle two-sided lines via drawseg clipping (`R_ClipVisPlane` equivalents, R03 §12).
7. Visplane flush during walk (above/sky/under, R03 §7); `R_DrawSubsegs`-equivalent: after each visplane fills, draw its columns (walls via `R_RenderCol`/masked) and flats via `R_DrawFlat` (per-column ceiling/floor spans from the open bottom/tail chains).
8. Sprites: `R_ProjectSprite` per visible mobj (8 rotations + mirror bit, light-level bucket, fuzz/shadow translation, R03 §9, §13) → sorted by bbox top (validcount-stable) → per sprite: drawseg occlusion spans (R03 §8) then column blit.
9. Automap/HUD/statusbar/menu overlays draw *into the same 320×200 index buffer* after the 3D pass (drawers in render/ui).

### 4.2 Data structures (sized to vanilla limits, preallocated typed arrays)

- `solidsegs: Int32Array` triples (x1,x2,drawseg index), MAXSOLIDSEGMENTS gate.
- `drawsegs`: parallel Int32Arrays (l1x,l1y,l2x,l2y,sx1,sx2, top/topoffset, bottom/bottomdelta, topscale/botscale, seg, isvisible, next) — flat SoA, R03 §5.
- `visplanes`: 3 planes (above/under/sky), SoA with `needskey` = (ceilingflat|lightbucket|scalekey), MAXVISSPLANES 32; overflow → drop plane (never crash) + `homSuspect` debug counter.
- `vissprites`: 128 entries (MAXVISSPRITES verified), {x1,x2,topoffset,bottomdelta,sprite handle}.
- `segbuffer` per subsector: clipped visible x-range lives in drawsegs, matching vanilla.

### 4.3 Textures/flats pipeline

- Patches decoded once (R02 §5) to column-major posts: per-column `{topoffset, lumplen, data}` plus a fused `Uint8` column strip — column-major layout chosen so wall blits walk contiguous memory (perf note §4.8).
- TEXTURE1/PNAMES composition to the same column format at load (R02 §7); masked textures get an alpha-zero sentinel column scan.
- Flats: 64×64 raw; texture animation via `flatanim`/`textureanim` (SWITCH lump if present else built-in fallback list, R02 §7/§186).
- Wall column draw: `texstep`/`texstep scaled by xscale` per column; vertical span blit through `colormap = COLORMAPS[lightbucket + zlight(dist bucket)]` pre-multiplied LUT — a single `Uint8Array(256)` lookup per (light bucket, colormap row); no per-pixel math (R02 §4).

### 4.4 Lighting/sky/fuzz

- Light bucket = `min(31, (lightlevel>>4) + zlight[dist])` with DISTMAP=2 tables built at init (R02 §4, R03 §10); `extralight`/`fixedcolormap` from player (§5.3 powerups).
- Sky: `SKY1..4` flat as a 360° wrap, drawn in the visplane sky path with horizon + scale rules (R03 §11); `F_SKY1` sentinel resolved at map load (skyflatnum, loader-neutral per R01 §17).
- Fuzz (shadow devils/stolen-view): precomputed fuzzpos/fuzzcols dither masks, XOR translucency against column copies (R03 §13).

### 4.5 Sprites and psprites

- Sprite frame interpretation at load: lump-name parse → `sprites[sp].frames[f] = {rotate: bool, lump[8], flip[8]}` (R06 §4); rotation `rot = ((viewAngle - thing.angle) + (ANG45/2*9)) >>> 29` (u32-safe); flip → mirror blit flag.
- Sprite clipping = per-column drawseg span test before the column blit (R03 §8); occluded spans skipped, never the whole sprite.
- Psprites (weapons): same projector, fixed screen position from state misc1/misc2 + weapon bob from `A_WeaponReady` (psprite.x/y already sim-side); drawn before world sprites so monsters clip over the gun (vanilla order).

### 4.6 HOM discipline

solidsegs binary insert/merge exactly as R03 §5; visplane overflow drops planes; any `R_StoreWallRange` with x1>x2 or reversed drawseg bounds increments a debug counter exposed via `state().render.hom` — golden tests assert it is 0 (M3+ exit criterion).

### 4.7 Framebuffer + present

- `buffer: Uint8Array(64000)` indices; `rgba: Uint8Array(256000)` scratch.
- Blit LUT: `Uint32Array(32*256)` = (colormapRow, index) → RGBA, rebuilt only when PLAYPAL or COLORMAP changes (palette flashes = palette index 1..31 rows for damage/bonus colormap, R02 §2; powerup tint selects rows at draw time).
- Present: `putImageData` on a 320×200 offscreen ImageData, then one nearest-neighbour `drawImage` scale to the canvas (`imageSmoothingEnabled=false`); canvas backing store = integer multiple of 320×200 (integer scale = pixel-perfect).
- `capture()` returns a copy of `buffer` (the indexed 320×200, §7) — golden tests hash it.

### 4.8 Performance notes (35 Hz sim + 60 fps budget)

- Zero allocations per frame: all render structures preallocated; string keys resolved to numeric lump ids at map load (no `Map.get(string)` in blit paths).
- All hot arrays typed (Int32Array/Uint8Array); struct-of-arrays everywhere in drawsegs/visplanes.
- Column-major texture posts + flat tiles → inner blit is `dst[o] = lut[src[tex]]` over a contiguous run; tex step is integer (`xscale` fixed, `texpos` int32).
- FixedMul per column (not per pixel) for scale math; per-pixel work is LUT lookup + store only.
- The 64000-entry RGBA convert loop is a flat typed-array loop (SIMD-friendly shape); on typical maps the whole frame targets < 8 ms (measured in M12 profiling task; budget logged in JOURNAL).
- No Proxy/getter state access across the sim→render seam: `render/state_view.ts` caches raw object refs per frame setup.

## 5. Area designs (where each lives, its seam to the sim core, determinism notes)

### 5.1 Level mechanics (R05) — `sim/p_switch.ts`, `p_spec.ts`, `p_doors.ts`, `p_plats.ts`, `p_floor.ts`, `p_ceilng.ts`, `p_lights.ts`, `p_telept.ts`

- Trigger taxonomy and the full Doom-1 special tables live as data + `switch(special)` exactly per R05 §2 (use/cross/shoot × W1/WR/S1/SR/G1/GR/manual); manual doors via `P_UseLine`.
- Movers are thinkers with `specialdata` (thinker index) back-refs: `vdoor_t`, `plat_t`, `floor_t`, `ceiling_t`, light strobers — field lists per R05 §4-9, constants verbatim (VDOORSPEED 2·FRACUNIT, PLATWAIT 3 s, MAXPLATS/MAXCEILINGS 30…).
- Sector specials: spawn-time pass in `P_SpawnSpecials` (R05 §3.1) + `P_PlayerInSpecialSector` ground pass (R05 §3.2); scroll/liquid flats via the ambient floor/ceiling movers.
- Exits/secrets: `P_ChangeExit`, `EV_SecretExitNormal`, sector-9 secret detection (R05 §10/§13) set `BV_*` flags → intermission data (§5.4).
- Seam to renderer: animated flats/texture changes and scrolling walls mutate only sim-side texture-id fields; render re-reads them each frame (no push API).
- Determinism: all speed/wait constants are fixed; thinker ordering follows §3.5; `tagHashing` replaced by array-index scans (`sectorsTagged: Map<tag, Sector[]>` built in P_SetupLevel order — never rebuilt from sorting).

### 5.2 Monster AI (R07) — `sim/p_enemy.ts`, `p_sight.ts` + `a_actions.ts` registrations

- All AI is state-action callbacks dispatched by the numeric ActionId switch (A_Look/A_Chase/A_PosAttack/… per R07 §6 roster). Roster = Doom-1 subset (R07 §15) + barrels (§13) + bosses/`A_BossDeath` (§11-12).
- Chase direction tables `p_chase_dirs` and `P_Move`/`P_TryWalk`/`P_NewChaseDir` verbatim (R07 §2.3); `P_LookForPlayers` lastlook ring (§3); `P_CheckSight` with REJECT bit test + `P_CrossesLine` (R07 §4); `P_NoiseAlert` sector-flood via `soundtarget` + `P_LookForPlayers` wake (R07 §5).
- Infighting: the `P_DamageMobj` target-swap block (R07 §7, p_inter.c) lives in `p_inter.ts`; `threshold`/`lastlook` fields per §2.4.
- Projectile collision = `P_MobjBlockmapMove`-equivalent through the standard `P_CheckPosition`/`P_TraverseTraverser` path (R07 §9.1); `P_ExplodeMissile`, `P_RadiusAttack` (blockmap iteration order = vanilla row-major) per §9.2-9.3.
- Determinism: every `P_Random` call site position-matched to R07/R08 (a table in `docs/design/random-sites.md` tracks expected counts per action — golden-state tests catch drift).

### 5.3 Weapons & player (R08) — `sim/p_pspr.ts`, `p_inter.ts` (damage/armor), pickup code in `p_inter.ts` (R06 §8)

- Weapon state tables (raise/lower/fire states, ammo costs) as data (R08 §2.1); `A_WeaponReady`/`A_ReFire`/`P_CheckAmmo`/`P_PickupWeapon` flows per R08 §1/§4/§5, raise/lower speed FRACUNIT·6.
- Hitscan: `P_AimLineAttack` → `P_LineAttack` → `PTR_ShootTraverse` with `P_BulletSlope` autoaim (R08 §3); `A_FirePistol`-etc spread `(pRandom()-pRandom())<<18` exact.
- Damage/armor formula + kickback verbatim from R08 §7 quotes (armorIndex 1/2 logic, health clamps).
- Powerups: `powers[]` timers + render effects (invulnerability colormap cycle, supershot) split sim-timers vs render-tint cleanly; palette flashes via `damagecount`/`bonuscount` → render palette-colormap choice (R08 §6.3).
- Seam: `psprites[]` state is sim data; `render/psprites.ts` only projects.

### 5.4 UI (R09) — logic `sim/m_menu.ts`, `am_map.ts`, `wi_stuff.ts`, `f_finale.ts`, `hu_stuff`-equivalent; pixels `render/{menu,statusbar,automap,intermission,hud}.ts`

- Menu/automap/intermission *state machines tick in the sim* (they change gamestate/gameaction — M_Ticker/AM_Ticker/WI_Ticker are tic-order items §3.2); responders consume the queued event list deterministically.
- Menu trees + skill/episode menus per R09 §1 (Freedoom-substituted graphics per R09 §1.2/R12 §4); status bar 28-line draw + face animation from health/`mRandom` (R09 §2); HUD messages ring buffer with 4 s TTL (R09 §4); automap modes/vars per R09 §5; intermission stats/`wminfo` + CWILV→own-drawn fallback (R09 §6, R12 §4).
- Fonts: STCFN0xx patches with the Freedoom-partial caveat (missing glyphs → fallback draw rule per R09 §3/§7).
- Keyboard map: WASD-first with vanilla-compat keys and identical F-key layer (R09 §8; default binding table in `platform/input.ts`, remappable, persisted §8).
- Determinism: menu state affects the sim only through gameaction/ticcmd bits; automap/face `mRandom` use confined to the M stream.

### 5.5 Audio (R10) — `sim` emits `{sfxId, sourceMobj}` events; everything else `platform/audio/`

- Sim side: `S_StartSound(mobjIdx, sfxId)` = *enqueue* (bounded ring, 64 entries, overwrite-oldest); zero Web Audio in sim. The vanilla ±pitch `mRandom()` perturbation (R10 §5) is *not* run inside the sim event path; it runs platform-side at drain time from a platform-local counter, keeping the M stream sim-only — deviation from vanilla call placement, parity-neutral for gameplay (tracked as risk A-07; status-bar face keeps a legit `mRandom` sim-side tick use).
- Platform mixer: 8 SFX voices, 32 kHz mono → AudioBuffers cached per sfxId (DS decode per R10 §1 at load); priority/retrigger policy R10 §6 (volume-then-age eviction, same-origin cutoff); distance atten + panning per R10 §2.4 (sourced from sim positions at drain); stereo = equal-power panner.
- Music: **SMF-first** (Freedoom ships SMF per R12 §9.4; MUS decoder optional for doom1.wad parity, gated behind a flag — see risk R-3). Decoder → unified sorted event list (R10 §4.1, pure, unit-testable); subtractive-lite GM synth (R10 §4.2), lookahead scheduler (0.1 s window, 25 ms pump), pause = suspend music nodes; loop via rescheduled end event (R10 §4.6).
- Volumes: 0..15 ints, quadratic gain curve (R10 §7 recommendation), one `musicGain` + one `sfxGain` bus.

### 5.6 Persistence & demos (R11) — `sim/g_saveg.ts` (serialize API, pure byte streams) + `platform/storage.ts` (IndexedDB)

- Format: `DSV1` tagged-binary per R11 §3 — sections (game settings, players, world, thinkers, specials), unknown-tag skip, dense-index pointer fixup (thinker u32, sector/line u32, state u16, player u8+1), full-precision i32 fixed, both rnd indices + `lastlook` round-tripped (fixes vanilla gaps R11 §1.1/§1.4).
- API: `sim.serialize(): ArrayBuffer` / `sim.deserialize(buf): void` (rebuild-not-restore, §3.5.7); storage just keys/puts them (§8).
- Demos (stretch): record/playback hooks already reserved in the ticcmd step (§3.1.3b); `.lmp` header + 4-byte tics per R11 §4; parity rides on §3.3/§3.5 — `P_Random` call-site table is the demo-critical artifact.

## 6. Test strategy (PROMPT §9 layers → tooling)

| Layer | Tooling | Where |
|---|---|---|
| 1 Static/unit | `npm run check` (tsc strict, eslint+boundary rules, vitest) — decoders vs byte vectors from R01/R02, fixed-point known vectors, state-table transcriptions vs info.c dumps, specials tables, rndtable parity | `src/**/*.test.ts` co-located |
| 2 Headless sim | `tests/sim/harness.ts`: boot engine on a fixture/real WAD **in Node** (no DOM — sim+wad import nothing browser-only), script `ticcmd[]` streams, assert fields + `hashState()` goldens; feature-per-fixture maps for §3 mechanics; Freedoom E1M1/E1M9 integration when `wads/` present (else `describe.skipIf`, never silently in CI-critical paths) | `tests/sim/` |
| 3 Golden framebuffers | `renderTest(map, {x,y,z,angle,tics}) → indices: Uint8Array(64000)` running the real renderer in Node (canvas never involved); golden = sha256 + PNG companion; `npm run goldens:update` regenerates + writes reason into commit-msg draft. Debug `capture()` in-browser feeds the *same* hashing code so layer-3 goldens double as e2e visual checks | `tests/render/`, goldens in `tests/render/goldens/` |
| 4 e2e | Playwright headless Chromium, real input events only; `__doom` for setup + assertions (§7); zero-console-errors rule already scaffolded (`e2e/canvas.spec.ts` pattern: non-blank, not single-color, changes after movement) | `e2e/` |
| 5 Visual review | Verifier checklist scripts dump screenshot + golden PNG pairs under `test-results/`; agent inspects (M3+) | process, per milestone |

### 6.1 Fixture tooling contract (`tests/fixtures/`)

```ts
export interface FixtureSpec {  // declarative tiny map, one feature each
  size: [w: number, h: number];                 // 128..1024 units, grid-aligned
  sectors: { floor: number; ceiling: number; light: number; special: number; tag: number;
            cells: [[x0, y0], [x1, y1]] }[];     // rectangular cell runs → trivially convex
  lines: { special: number; tag: number; a: [number, number]; b: [number, number];
           side?: 'left' | 'right' }[];          // grid-edge line specials
  things: { kind: number /*doomednum*/; x: number; y: number; angle?: number }[];
}
export function buildMapLumps(spec: FixtureSpec): Record<string, Uint8Array>; // 10 lumps incl. nodes
export function buildWad(opts: { maps: FixtureSpec[]; extras?: Record<string, Uint8Array> }): ArrayBuffer;
```

Node generation without a general node builder: specs are axis-aligned rectangle partitions, so SEGS/SSECTORS/NODES come from a ~150-line recursive grid splitter (split lines are always horizontal/vertical → intercept math degenerates to sign tests). Validity check shipped as a test: the generated BSP must return the owning sector for every sample point (property test over the grid). Hand-authored reference maps (single room, L-room) are also committed for regression pinning. Freedoom stays *out* of unit/fixture tests; it is used in layers 2b/3/4 integration only (R12 attribution respected for any Freedoom-derived golden).

## 7. Debug API final surface (`src/debug.ts`, `src/types/debug.ts`)

Same install gate (DEV or `?test=1`). Replaces all stubs; `step`/`capture` semantics pinned:

```ts
export interface DoomDebugApi {
  /** Load map by name ('E1M1'|'MAP01') and enter GS_LEVEL at the start position. Throws on unknown map. */
  loadMap(mapName: string): void;
  /** Teleport player 0 (teleport-move semantics, noclip-safe): fixed-point x/y, optional fixed z and BAM degrees [0,360). Setup only — never substitutes for movement-under-test. */
  warp(x: number, y: number, z?: number, angleDeg?: number): void;
  /** set/get CF_GODMODE (cheat-equivalent path). Returns resulting state. */
  god(enabled?: boolean): boolean;
  /** set/get CF_NOCLIP. Returns resulting state. */
  noclip(enabled?: boolean): boolean;
  /** Run exactly n tics through the §3.2 path with empty input (or scripted cmds); pauses sim during call; returns hashState() after the last tic. */
  step(tics: number): number;
  /** set/get menu-pause equivalent (sim freeze; rendering continues). Returns state. */
  pause(paused?: boolean): boolean;
  state(): DebugStateSnapshot;
  /** Renders one frame synchronously (even paused) then returns a fresh copy of the 320×200 index buffer. */
  capture(): CaptureResult;
}
export interface DebugStateSnapshot {
  ready: true; gametic: number; leveltime: number; map: string; gamestate: string;
  player: { x: number; y: number; z: number; angleDeg: number; health: number; armor: number;
            ammo: number[]; weapons: number; powerups: Record<string, number>; onGroundSector: number };
  sectors: { count: number; floorZ: number[] /* sampled ≤ 64, stride-reported */ };
  thinkers: { count: number };
  render: { hom: number };
  hash: number;                      // §3.4 hashState()
}
export interface CaptureResult { width: 320; height: 200; indices: Uint8Array } // 64000 B
```

(`state()` returns `{ready:false, note}` only before first successful boot; typed as a discriminated union.)

## 8. Settings & persistence keys (IndexedDB, per R11 §3)

- DB `doom-ts` v1, two stores: `saves` (keyPath = slot key) and `settings` (keyPath = key).
- Keys: `doom-save-0 … doom-save-9` (vanilla slot mirror; value `{meta: {description: 24-chars, leveltime, episode, map, skill, savedAt}, data: ArrayBuffer}`), `doom-save-quick` (F6/F9), `doom-save-auto` (optional auto-quicksave toggle, default ON per R11 §3 recommendation), `doom-settings` (single record), `doom-binds` (key/mouse binding map, R09 §8 defaults).
- `doom-settings` record: `mouseSensitivity` (5 default, vanilla mousescale units), `mouseInvert: false`, `sndSfxVolume: 8`, `sndMusicVolume: 8` (0..15, Chocolate defaults R10 §7), `showAutoSaveToggle`, `iwadPath` preference (user-WAD picker), `cpuScale` (integer canvas scale override). Everything else fidelity-locked until post-done (§1).
- Atomicity: single `put()` per save (R11 §3 maps temp-rename safety onto one IDB transaction); slot list via `getAllKeys()` + meta read.
- Save format versioning: header `{magic 'DSV1', u32 formatVersion, u32 contentVersion}`; loader accepts `formatVersion ≤ OUR_VERSION`, migrates via tagged-section skip (unknown sections ignored) — a breaking change bumps formatVersion with a migration function registered per pair; `contentVersion` mismatch = warn-and-try (data tables are code-versioned; mismatch typically fails the map-checksum tag and is reported, not silently corrupted).

## 9. Risks / decision-required (ADR-lite)

**A-01 Numeric policy (chosen).** Context: fidelity demands bit-exact 16.16 math; JS has no int32 multiply. Options: BigInt everywhere; double+`Math.floor` (drifts — R03 §18.5/R04 §4 forbid); 16-bit limb split. Choice: int32-as-number + limb-split `FixedMul` (§2.5); BigInt load-time only. Risk: subtle split bugs — mitigated by randomized differential tests vs a C oracle (task A-FX1) and golden framebuffers.

**A-02 DEHACKED fullbright (R12 §9.3).** Context: Freedoom ships BEX-format DEHACKED setting fullbright bits on sprite frames. Options: ignore (sprites render dark in light-0 areas); full BEX parser. Choice: minimal parser for Frame/Sprite `fullbright`+`sprite subnumber` entries applied at table build; unknown lines parse-and-warn. Recommendation confirmed: implement in M8 (monsters) — visually load-bearing, cheap.

**A-03 SMF synth quality (R10 §4).** Context: Freedoom music is SMF; vanilla MUS never appears in the target IWAD. Options: OPL-FM emulation (heavy, wrong for SMF), subtractive-lite GM (recommended), silent fallback. Choice: subtractive-lite + noise-drums, 32-voice pool; MUS decoder behind a flag for doom1.wad parity (stretch). Risk: timbre distance from GUS/OPL expectations — accepted; GM soundfont is a stated post-done stretch.

**A-04 Fixture maps without a node builder.** Context: layer-2 tests need WADs with valid BSP (PROMPT §8). Options: general node builder (~1k+ lines, own bug surface); hand-authored blobs (brittle); grid-recursive splitter for rectangle specs. Choice: rectangle-spec generator + grid splitter (§6.1) with a BSP property test. Risk: cannot express non-convex fixture quirks (diagonal lines) — acceptable; diagonal behavior gets Freedoom integration coverage.

**A-05 SFX mixer size.** Context: vanilla 116 mono 8-bit voices at 11/22 kHz; WebAudio node churn. Options: AudioBuffer+BufferSource pool of 8 (chosen, §5.5) vs per-sound nodes (GC churn) vs AudioWorklet DSP mixer (fidelity of exact channel-drop policy, high cost). Choice: 8-voice pool + priority/age policy (R10 §6); revisit only if profiling shows mixer cost (expected < 1 ms/frame).

**A-06 Boundary enforcement tool.** Context: §1.3. Options: eslint no-restricted-imports (zero new deps, already in `npm run check`) vs dependency-cruiser (stronger graph queries). Choice: eslint now (task A-INT1); dependency-cruiser only if audits find rule gaps (render→sim mutation is convention+tests either way).

**A-07 Presentation randomness vs M-stream.** Context: vanilla calls `M_Random` in s_sound.c (pitch) and st_stuff.c (face). If our platform SFX path used the shared M stream, sim determinism would depend on audio state. Choice: status face keeps sim-side `mRandom` (deterministic, in saves); SFX pitch uses a platform counter (audio off when muted — stream independence matters). Demo-parity note: only relevant to vanilla `.lmp` cross-play, which is stretch.

**A-08 Accumulator vs vanilla TryRunTics/ticdup.** Choice: plain accumulator (§3.1). Accepted deviation; single-player only; demo layer records the resulting tic sequence so parity claims stay checkable.

**A-09 Keyboard default mapping (R09 §8).** Choice: WASD primary + full vanilla-compat set + identical F-key layer; mouse Y-invert defaults OFF. Recorded in DECISIONS at implementation; remappable via `doom-binds`.

**A-10 IndexedDB in headless tests.** Node vitest has no IDB: sim-side serialize/deserialize tested on raw buffers (pure); storage layer gets one Playwright persistence test in-browser (M11). Risk of drift: shared `serialize` API keeps both honest.

## 10. Notes sufficiency (per research note)

| Note | Verdict | Gaps / notes |
|---|---|---|
| R01 wad-container | Sufficient | Everything needed for WadFile/mapdata incl. quirks; only open items were representation calls (resolved §1/§2). |
| R02 graphics-data | Sufficient | Decoders + exact light-diminishing math + animation/switch lump handling; §9 sky lump detail suffices for the F_SKY1 path. Minor gap: SWITCH lump exact format — verify empirically vs freedoom1.wad in M4. |
| R03 bsp-renderer | Sufficient | Complete pipeline incl. tables, clipping recipes, HOM model, constants; its own §18 open items resolved here (unsigned-div policy §2.5; sky per-episode selection = trivial g_game detail, confirm at M4). |
| R04 simulation-core | Sufficient | Tic loop, ticcmd, movement, thinkers, PRNG table verbatim; I_GetTime internals absent from source — moot, our clock is platform-side by design (§3.1). |
| R05 specials | Sufficient | Full Doom-1 special tables + mover pseudocode/constants; 1.10-vs-wiki deltas flagged with confidence levels. Light validcount/`P_FindNearestDoor`-style scans derivable. |
| R06 map-objects | Sufficient | Full mobjinfo transcription + state encoding + doomednum map; sprite frame/rot/mirror rules complete. |
| R07 monster-ai | Sufficient | All roster actions, chase/sight/infighting/radius-damage quoted; random call-site counts listed (feeds §5.2 parity table). |
| R08 weapons-player | Sufficient | State tables, fire actions, hitscan/autoaim, ammo/damage formulas quoted; corrections vs lore noted and adopted. |
| R09 ui | Sufficient | Menu trees, status bar face rules, automap vars, intermission data, font mechanism; Freedoom-lump substitutions audited. Font fallback glyph policy is ours (§5.4). |
| R10 audio | Sufficient | DS format, sfxinfo, attenuation/priority, MUS+SMF parses, synth + mixer design; open items promoted to A-03/A-05/A-07. |
| R11 persistence | Sufficient | Vanilla archive/fixup detail + a concrete DSV design adopted (§5.6, §8); demo format deferred to stretch as planned. |
| R12 freedoom | Sufficient | Pinned release/checksum (matches D005), map list, lump presence matrix, DEHACKED correction, SMF fact — all consumed above; no blocking gaps. |
