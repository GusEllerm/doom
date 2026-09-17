// render/bsp.ts — BSP front-to-back walk (M3-plan §M3-04; r_bsp.c + the
// R_PointOnSide half of r_main.c).
//
// GAP G11 (plan §3): the renderer carries its OWN sign-test `pointOnSide`
// ported from r_main.c:162 — sim/bsp.ts serves collision via blockmap and
// its own placement; this copy keeps the r_bsp/r_data hot path free of sim
// imports (eslint doom/zones/render). Duplication is acknowledged for the
// M12 audit; the two ports must stay bit-identical.
//
// Vanilla mapping (linuxdoom-1.10 r_bsp.c):
//   R_RenderBSPNode (r_bsp.c:560-580) — recursive front-then-maybe-back
//     walk, ported ITERATIVELY (explicit pre-allocated stack, §"Zero alloc"
//     below) with identical visit order. `bspnum & NF_SUBSECTOR` on the raw
//     u16 child refs (mapdata.ts: NF_SUBSECTOR = 0x8000); the empty-tree
//     marker −1 routes to subsector 0.
//   R_CheckBBox (r_bsp.c:381-486) — checkcoord[12][4] + m_bbox.h codes
//     BOXTOP=0/BOXBOTTOM=1/BOXLEFT=2/BOXRIGHT=3 (source truth — NOT the
//     {left,right,top,bottom} guess) over the [top,bottom,left,right] flat
//     layout (node_t::bbox[2][4]); `span >= ANG180` ⇒ "sitting on a line"
//     ⇒ true; the solidsegs fully-covered check returns FALSE (bbox adds no
//     rejection once covered ⇒ subtree skipped by the caller).
//   R_AddLine (r_bsp.c:259-357) — u32 angle math verbatim: backface cull on
//     `span >= ANG180`, the two tspan clamps against clipangle / 2*clipangle
//     with the C "totally off the left edge" early-outs (the second clamp's
//     comment is a vanilla mislabel — it rejects the RIGHT edge), the
//     viewangletox projection, then the `x1 == x2` "does not cross a pixel"
//     DROP (exact: r_bsp.c:317, before any classification).
//     Classification source truth (goto order):
//       !backsector                                     ⇒ clipsolid
//       backCeil <= frontFloor || backFloor >= frontCeil ⇒ clipsolid
//         (this is ALSO the "closed door" line — 1.10 tests heights, not
//         the line special; a fully-closed door fails the passability
//         test exactly via this branch)
//       backCeil != frontCeil || backFloor != frontFloor ⇒ clippass
//       ceilingpic==ceilingpic && floorpic==floorpic &&
//         lightlevel==lightlevel && midtexture==0        ⇒ return (noDraw)
//       otherwise                                        ⇒ clippass
//     FLAT-EQUALITY SUBSET (documented): M3-02's flatNum() is the −1 stub,
//     so both pic comparisons are trivially TRUE — until M4 the noDraw
//     rule reduces to light-equality + no-mid-texture (the common trigger
//     line case). A differing-flats pair (vanilla keeps the line) cannot
//     exist in M3 fixtures without flats.
//     1.10 has NO masked/transparent branch in R_AddLine — the
//     masked-vs-solid decision is R_StoreWallRange's (r_segs.c, M3-06):
//     a one-sided seg with a middle texture still goes through clipsolid
//     here ("masked-solid path").
//   R_Subsector (r_bsp.c:505-551) — WALL LOOP ONLY in M3: no R_FindPlane
//     floors/ceilings, no R_AddSprites (plan §M3-04; M4/M5). frontsector =
//     the subsector's sector, set before the seg loop like vanilla.
//
// Design seam (M3-06): the walk never calls storeWallRange itself — every
// visible span leaves through the {@link WalkCallbacks} pair. Production
// wiring (M3-06) plugs clipSolidWallSegment/clipPassWallSegment + drawseg
// recording in ({@link solidsegsWalkCallbacks} is the ledger-only default);
// tests plug recorders. The R_CheckBBox occlusion early-out reads the
// solidsegs LEDGER directly (module state, M3-03) — same data the callbacks
// feed in production, so a recorder-only wiring simply never triggers that
// early-out.
//
// Zero alloc: all walk state is hoisted to walker-creation scope (no
// per-frame closures); the stack is two pre-allocated typed arrays (grow ×2
// only if a tree deeper than capacity is first encountered — never on
// shipped maps; the acceptance probe asserts buffer identity). The
// traversal is an iterative loop, so a frame is pure arithmetic + callback
// dispatch on reused objects (acceptance 4).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { ANG180, ANG90, ANGLETOFINESHIFT, FRACBITS } from '../core/constants';
import { FixedMul } from '../core/fixed';
import { NO_TEXTURE, type RenderWorld } from './rdata';
import {
  clipPassWallSegment,
  clipSolidWallSegment,
  solidsegsFirst,
  solidsegsLast,
  solidsegsLength,
} from './solidsegs';
import {
  BOXTOP,
  BOXBOTTOM,
  BOXLEFT,
  BOXRIGHT,
  bspRoot,
  initTextureMapping,
  NF_SUBSECTOR,
  pointToAngle,
  type RenderMapView,
  type RenderNodeSoA,
  type ViewState,
} from './view';

/* ------------------------------------------------------------------ */
/* Callback seam                                                       */
/* ------------------------------------------------------------------ */

/** The R_ClipSolidWallSegment / R_ClipPassWallSegment call sites of
 * R_AddLine (r_bsp.c:355 / :346) — `last` is already x2-1. Optional trace
 * hooks (tests' tree-order proof; zero cost when omitted): onNodeEnter fires
 * when a node is entered (nearSide = the player-side child visited first),
 * onFarEnter when the far-side child is about to be visited, onNodeExit
 * after BOTH subtrees are done, onSubsector before a subsector's seg loop,
 * onSegReached after R_AddLine's clip math passed (before classification —
 * the seam acceptance 1's "walked seg" probe uses). */
export interface WalkCallbacks {
  addSolid(first: number, last: number): void;
  addPass(first: number, last: number): void;
  onNodeEnter?(node: number, nearSide: number): void;
  onFarEnter?(node: number, farSide: number): void;
  onNodeExit?(node: number): void;
  onSubsector?(subsector: number): void;
  onSegReached?(seg: number, x1: number, x2: number): void;
  /** R_CheckBBox verdict probe (tests' pruning triage; zero cost if unset). */
  onBBox?(node: number, side: number, visible: boolean): void;
}

/** Default wiring: the exact M3-03 ledger ops of vanilla R_AddLine (no
 * drawsegs yet — M3-06 wraps these and adds storeWallRange recording). */
export function solidsegsWalkCallbacks(): WalkCallbacks {
  return {
    addSolid(first: number, last: number): void {
      clipSolidWallSegment(first, last);
    },
    addPass(first: number, last: number): void {
      clipPassWallSegment(first, last);
    },
  };
}

/* ------------------------------------------------------------------ */
/* Walker                                                             */
/* ------------------------------------------------------------------ */

export interface BspWalker {
  /** Run one frame's wall pass for `view`; `root` = bspRoot(map) default. */
  walk(view: ViewState, callbacks: WalkCallbacks, root?: number): void;
  /** Seg index inside R_AddLine (recording callbacks read this). */
  curSeg: number;
  /** rw_angle1 from R_AddLine (r_bsp.c:290) — consumed by M3-06 segcalc. */
  rwAngle1: number;
  /** frontsector of the subsector being processed (R_Subsector). */
  frontSector: number;
  /** Traversal stack buffers (acceptance-4 identity probe; replaced only
   * by the documented grow path, which no shipped map reaches). */
  readonly stackKind: Uint8Array;
  readonly stackVal: Int32Array;
}

// Stack item kinds: enter node / continue-with-far-child / exit node. The
// push order [exit, far, nearChild] reproduces the vanilla recursion
// (near subtree → bbox-checked far subtree → return) exactly.
const ENTER = 0;
const FAR = 1;
const EXIT = 2;

const INITIAL_STACK = 512; // ≥ 3 × tree depth (E1M1 depth < 100, fixtures «)

/**
 * Build a reusable walker over one map + render world. All per-frame state
 * is on the returned object; {@link BspWalker.walk} allocates nothing
 * (steady state — see file header).
 */
export function createBspWalker(map: RenderMapView, world: RenderWorld): BspWalker {
  const nodes = map.nodes;
  const mapping = initTextureMapping();

  let stackKind = new Uint8Array(INITIAL_STACK);
  let stackVal = new Int32Array(INITIAL_STACK);
  let sp = 0;

  function pushItem(kind: number, val: number): void {
    if (sp === stackKind.length) grow(); // documented once-grow; never on shipped maps
    stackKind[sp] = kind;
    stackVal[sp] = val;
    sp += 1;
  }

  function grow(): void {
    const next = stackKind.length * 2;
    const k = new Uint8Array(next);
    k.set(stackKind);
    const v = new Int32Array(next);
    v.set(stackVal);
    stackKind = k;
    stackVal = v;
  }

  /** child ref dispatch: NF_SUBSECTOR bit ⇒ subsector, else node. */
  function pushChild(ref: number, view: ViewState, cb: WalkCallbacks): void {
    if ((ref & NF_SUBSECTOR) !== 0) renderSubsector(ref & ~NF_SUBSECTOR, view, cb);
    else pushItem(ENTER, ref);
  }

  /** R_Subsector — wall loop only (file header). */
  function renderSubsector(ss: number, view: ViewState, cb: WalkCallbacks): void {
    walker.frontSector = map.subsectors.sector[ss]!;
    cb.onSubsector?.(ss);
    const start = map.subsectors.segStart[ss]!;
    const count = map.subsectors.segCount[ss]!;
    for (let i = 0; i < count; i += 1) addLine(start + i, view, cb);
  }

  /** R_AddLine — verbatim clip math + the clipsolid/clippass/noDraw
   * classification of the file header. */
  function addLine(seg: number, view: ViewState, cb: WalkCallbacks): void {
    walker.curSeg = seg;

    const angle1v = pointToAngle(view, world.segV1x[seg]!, world.segV1y[seg]!);
    const angle2v = pointToAngle(view, world.segV2x[seg]!, world.segV2y[seg]!);

    const span = (angle1v - angle2v) >>> 0;
    if (span >= ANG180) return; // back side ⇒ backface cull

    walker.rwAngle1 = angle1v; // rw_angle1 = angle1 (r_bsp.c:290)
    let angle1 = (angle1v - view.viewangle) >>> 0;
    let angle2 = (angle2v - view.viewangle) >>> 0;

    const clip = mapping.clipangle;
    const clip2 = (clip * 2) >>> 0;

    let tspan = (angle1 + clip) >>> 0;
    if (tspan > clip2) {
      tspan = (tspan - clip2) >>> 0;
      if (tspan >= span) return; // totally off the left edge
      angle1 = clip;
    }
    tspan = (clip - angle2) >>> 0;
    if (tspan > clip2) {
      tspan = (tspan - clip2) >>> 0;
      // "totally off the left edge" — C comment verbatim; this is the
      // right-edge rejection (vanilla mislabel, r_bsp.c:302).
      if (tspan >= span) return;
      angle2 = (0 - clip) >>> 0;
    }

    const a1 = ((angle1 + ANG90) >>> 0) >>> ANGLETOFINESHIFT;
    const a2 = ((angle2 + ANG90) >>> 0) >>> ANGLETOFINESHIFT;
    const x1 = mapping.viewangletox[a1]!;
    const x2 = mapping.viewangletox[a2]!;

    if (x1 === x2) return; // does not cross a pixel (r_bsp.c:317)

    cb.onSegReached?.(seg, x1, x2); // seams: reached = past all clip math

    /* ---- classification (source-truth table in the file header) ---- */
    const line = world.segLine[seg]!;
    let backSector = -1; // NULL backsector ⇔ "single sided line"
    let through = -1; // sidedef the seg draws through (seg_t::sidedef)
    if (line >= 0) {
      // segSide = line.front (side-0 seg) / line.back (side-1 seg) per
      // rdata.ts; the seg's backsector is the OTHER sidedef's sector.
      through = world.segSide[seg]!;
      const other =
        world.lineFront[line] === through ? world.lineBack[line]! : world.lineFront[line]!;
      if (other >= 0) backSector = world.sideSector[other]!;
    }

    const front = walker.frontSector;
    if (backSector < 0) {
      cb.addSolid(x1, x2 - 1); // single sided line ⇒ clipsolid (also the
      return; // one-sided midtex "masked-solid" path, header note)
    }
    if (
      world.sectorCeil[backSector]! <= world.sectorFloor[front]! ||
      world.sectorFloor[backSector]! >= world.sectorCeil[front]!
    ) {
      cb.addSolid(x1, x2 - 1); // closed door / impassable ⇒ clipsolid
      return;
    }
    if (
      world.sectorCeil[backSector]! !== world.sectorCeil[front]! ||
      world.sectorFloor[backSector]! !== world.sectorFloor[front]!
    ) {
      cb.addPass(x1, x2 - 1); // window ⇒ clippass
      return;
    }
    // Reject empty lines used for triggers and special events: identical
    // heights (checked above) + identical light + no middle texture. Flat
    // equality is the documented M3 −1-stub subset (file header).
    const midTex = through >= 0 ? world.sideMidTex[through]! : NO_TEXTURE;
    if (world.sectorLight[backSector] === world.sectorLight[front] && midTex === NO_TEXTURE) {
      return; // noDraw
    }
    cb.addPass(x1, x2 - 1);
  }

  /** R_CheckBBox (r_bsp.c:381-486). */
  function checkBBox(view: ViewState, node: number, side: number): boolean {
    const base = node * 8 + side * 4; // [BOXTOP,BOXBOTTOM,BOXLEFT,BOXRIGHT]
    const bb = nodes.bboxes;

    let boxx: number;
    if (view.viewx <= bb[base + BOXLEFT]!) boxx = 0;
    else if (view.viewx < bb[base + BOXRIGHT]!) boxx = 1;
    else boxx = 2;

    let boxy: number;
    if (view.viewy >= bb[base + BOXTOP]!) boxy = 0;
    else if (view.viewy > bb[base + BOXBOTTOM]!) boxy = 1;
    else boxy = 2;

    const boxpos = (boxy << 2) + boxx;
    if (boxpos === 5) return true; // viewpoint inside the box

    const cc = boxpos * 4;
    const x1 = bb[base + CHECKCOORD[cc]!]!;
    const y1 = bb[base + CHECKCOORD[cc + 1]!]!;
    const x2 = bb[base + CHECKCOORD[cc + 2]!]!;
    const y2 = bb[base + CHECKCOORD[cc + 3]!]!;

    const angle1 = (pointToAngle(view, x1, y1) - view.viewangle) >>> 0;
    const angle2v = (pointToAngle(view, x2, y2) - view.viewangle) >>> 0;

    const span = (angle1 - angle2v) >>> 0;
    if (span >= ANG180) return true; // sitting on a line

    const clip = mapping.clipangle;
    const clip2 = (clip * 2) >>> 0;

    let a1 = angle1;
    let tspan = (a1 + clip) >>> 0;
    if (tspan > clip2) {
      tspan = (tspan - clip2) >>> 0;
      if (tspan >= span) return false; // totally off the left edge
      a1 = clip;
    }
    let a2 = angle2v;
    tspan = (clip - a2) >>> 0;
    if (tspan > clip2) {
      tspan = (tspan - clip2) >>> 0;
      if (tspan >= span) return false;
      a2 = (0 - clip) >>> 0;
    }

    const sx1 = mapping.viewangletox[((a1 + ANG90) >>> 0) >>> ANGLETOFINESHIFT]!;
    let sx2 = mapping.viewangletox[((a2 + ANG90) >>> 0) >>> ANGLETOFINESHIFT]!;
    if (sx1 === sx2) return false; // does not cross a pixel
    sx2 -= 1;

    // Find the first clippost that touches the source post (adjacent pixels
    // touch). The right sentinel (last = MAXINT ≥ any sx2) bounds the scan;
    // the length guard mirrors that sentinel bound, never truncates.
    const len = solidsegsLength();
    let start = 0;
    while (start < len && solidsegsLast(start) < sx2) start += 1;

    if (sx1 >= solidsegsFirst(start) && sx2 <= solidsegsLast(start)) return false; // covered
    return true;
  }

  const walker: BspWalker = {
    curSeg: -1,
    rwAngle1: 0,
    frontSector: -1,
    get stackKind() {
      return stackKind;
    },
    get stackVal() {
      return stackVal;
    },
    walk(view: ViewState, cb: WalkCallbacks, root: number = bspRoot(map)): void {
      /* ---- R_RenderBSPNode, iterative (see ENTER/FAR/EXIT note) ---- */
      sp = 0;
      pushItem(ENTER, root);
      while (sp > 0) {
        sp -= 1;
        const val = stackVal[sp]!;
        const kind = stackKind[sp]!;
        if (kind === ENTER) {
          if (val === -1) {
            // empty tree (r_bsp.c: `if (bspnum == -1) R_Subsector(0)`)
            renderSubsector(0, view, cb);
            continue;
          }
          const side = pointOnSide(view, nodes, val);
          cb.onNodeEnter?.(val, side);
          pushItem(EXIT, val);
          pushItem(FAR, val);
          pushChild(side === 0 ? nodes.child0[val]! : nodes.child1[val]!, view, cb);
        } else if (kind === FAR) {
          const side = (pointOnSide(view, nodes, val) ^ 1) as 0 | 1;
          const vis = checkBBox(view, val, side);
          cb.onBBox?.(val, side, vis);
          if (vis) {
            cb.onFarEnter?.(val, side);
            pushChild(side === 0 ? nodes.child0[val]! : nodes.child1[val]!, view, cb);
          }
        } else {
          cb.onNodeExit?.(val);
        }
      }
    },
  };

  return walker;
}

/**
 * r_bsp.c checkcoord[12][4] (11 rows in C; boxpos 11 unreachable). Values
 * are m_bbox.h codes {BOXTOP=0, BOXBOTTOM=1, BOXLEFT=2, BOXRIGHT=3}, which
 * index the [top,bottom,left,right] flat bbox layout built in view.ts.
 * Rows 3 and 7 are the C `{0}` padding ((boxy<<2)+boxx never yields 3/7).
 */
const CHECKCOORD = Int32Array.of(
  3, 0, 2, 1, 3, 0, 2, 0, 3, 1, 2, 0, 0, 0, 0, 0, 2, 0, 2, 1, 0, 0, 0, 0, 3, 1, 3, 0, 0, 0,
  0, 0, 2, 0, 3, 1, 2, 1, 3, 1, 2, 1, 3, 0,
);

/* ------------------------------------------------------------------ */
/* R_PointOnSide (r_main.c:162-212) — GAP G11 local copy              */
/* ------------------------------------------------------------------ */

/**
 * Returns side 0 (front) or 1 (back). Fixed-point FRACBITS flavour, verbatim
 * from r_main.c — including "on plane ⇒ back" (`right < left` front test).
 * G11: duplicated on purpose from sim/bsp.ts (zone rule + placement
 * fidelity); the math is bit-identical (sign-bit shortcut + FixedMul(dy >>
 * FRACBITS, dx) pairing).
 */
export function pointOnSide(view: ViewState, nodes: RenderNodeSoA, i: number): 0 | 1 {
  return pointOnSideXY(view.viewx, view.viewy, nodes, i);
}

/** Bare-coordinate form (tests + callers without a ViewState). */
export function pointOnSideXY(x: number, y: number, nodes: RenderNodeSoA, i: number): 0 | 1 {
  const lx = nodes.x[i]!;
  const ly = nodes.y[i]!;
  const ldx = nodes.dx[i]!;
  const ldy = nodes.dy[i]!;

  if (ldx === 0) {
    if (x <= lx) return ldy > 0 ? 1 : 0;
    return ldy < 0 ? 1 : 0;
  }
  if (ldy === 0) {
    if (y <= ly) return ldx < 0 ? 1 : 0;
    return ldx > 0 ? 1 : 0;
  }

  const dx = (x - lx) | 0;
  const dy = (y - ly) | 0;

  // Try to quickly decide by looking at sign bits.
  if ((ldy ^ ldx ^ dx ^ dy) & 0x80000000) {
    if ((ldy ^ dx) & 0x80000000) return 1; // (left is negative)
    return 0;
  }

  const left = FixedMul(ldy >> FRACBITS, dx);
  const right = FixedMul(dy, ldx >> FRACBITS);
  return right < left ? 0 : 1; // front side : back
}
