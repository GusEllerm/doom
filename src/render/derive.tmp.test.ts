// SCRATCH (never committed): derive hand-computed expected values for M3-06b.
import { it } from 'vitest';
import { writeFileSync } from 'node:fs';

import { ANG90, ANG180, FRACUNIT, MAXINT } from '../core/constants';
import { angAdd, angSub, angToFine, FixedDiv, FixedMul } from '../core/fixed';
import { finesine, finetangent, tantoangle } from '../core/tables';
import type { LineDef, Seg, SectorDef, SideDef, Vertex } from '../wad/types';
import type { MapData, TextureDef } from '../wad/types';

import { loadRenderWorld, type RenderWorld } from './rdata';
import { Framebuffer } from './framebuffer';
import { createSegCallbacks } from './segs';
import { clearClipSegs, getRenderCounters, resetRenderCounters } from './solidsegs';
import {
  CLIP_NEGONE, CLIP_NULL, CLIP_SCREEN, MAXSHORT, clearClipArrays, clearDrawsegs,
  drawsegAdd, drawsegCount, ceilingclip, floorclip, getDrawsegs, maskedTexturecol,
  openingsUsed, snapshotOpenings, clipValue,
} from './drawsegs';
import { computeIscale, dc } from './cols';
import {
  createViewState, pointToAngle, setupView, VIEWHEIGHT,
  type ViewState,
} from './view';
import { initTextureMapping } from './view';

const out: string[] = [];
const log = (s: string) => out.push(s);

function mkTex(name: string, width: number, height: number, fn: (c: number, r: number) => number): TextureDef {
  const columns: Uint8Array[] = [];
  for (let c = 0; c < width; c++) {
    const col = new Uint8Array(height);
    for (let r = 0; r < height; r++) col[r] = fn(c, r);
    columns.push(col);
  }
  return { name, width, height, patches: [], columns } as unknown as TextureDef;
}

interface WOpts {
  floorA?: number; ceilA?: number; lightA?: number;
  pan?: number; flags?: number;
  mid?: string; h: number; // tex height
  back?: { floor: number; ceil: number; light: number; bottom?: string; top?: string; mid?: string };
  wallX?: number; // x of the wall line (default 0)
}

function buildWorld(o: WOpts): RenderWorld {
  const wx = o.wallX ?? 0;
  const vertices: Vertex[] = [
    { x: wx, y: 64 }, { x: wx, y: 192 },
  ];
  const sectors: SectorDef[] = [
    { floorLh: o.floorA ?? 0, ceilingLh: o.ceilA ?? 128, floorFlat: 'F', ceilingFlat: 'F', lightLevel: o.lightA ?? 192, special: 0, tag: 0 },
  ];
  const sideDefs: SideDef[] = [
    { sector: 0, toptexture: '', midtexture: o.mid ?? 'FIXWALL', bottomtexture: '', offset: [o.pan ?? 0, 0], light: 0 },
  ];
  const lineDefs: LineDef[] = [
    { v1: 0, v2: 1, front: 0, back: -1, flags: o.flags ?? 0, special: 0, tag: 0 },
  ];
  if (o.back) {
    sectors.push({ floorLh: o.back.floor, ceilingLh: o.back.ceil, floorFlat: 'F', ceilingFlat: 'F', lightLevel: o.back.light, special: 0, tag: 0 });
    sideDefs.push({ sector: 1, toptexture: o.back.top ?? '', midtexture: o.back.mid ?? '', bottomtexture: o.back.bottom ?? '', offset: [0, 0], light: 0 });
    lineDefs.push({ v1: 2, v2: 3, front: 2, back: 3, flags: 4, special: 0, tag: 0 });
    vertices.push({ x: wx - 64, y: 64 }, { x: wx - 64, y: 192 });
  }
  const segs: Seg[] = [
    { v1: 0, v2: 1, angle: (ANG90 >>> 16) & 0xffff, line: 0, side: 0, offset: 0 },
  ];
  if (o.back) segs.push({ v1: 2, v2: 3, angle: (ANG90 >>> 16) & 0xffff, line: 1, side: 2, offset: 0 });
  const md: MapData = {
    name: 'SEGFIX', things: new Uint8Array(0), lineDefs, sideDefs, vertices, segs,
    ssectors: [], nodes: [], sectors, reject: new Uint8Array(0), blockmap: new Uint8Array(0),
  };
  const textures = new Map<string, TextureDef>([
    ['FIXWALL', mkTex('FIXWALL', 64, o.h, (c, r) => ((c * 3 + r * 5) % 255) + 1)],
  ]);
  return loadRenderWorld(md, textures);
}

function probed(w: RenderWorld): { world: RenderWorld; calls: number[][] } {
  const calls: number[][] = [];
  const world: RenderWorld = {
    ...w,
    getWallColumn(t: number, c: number) {
      calls.push([t, c, dc.x]);
      return w.getWallColumn(t, c);
    },
  };
  return { world, calls };
}

interface RunOpts {
  x: number; y: number; z?: number; angle: number;
  world: RenderWorld; a: number; b: number; seg?: number; pass?: boolean;
}

function run(o: RunOpts): { fb: Framebuffer; min: number; max: number } {
  const fb = new Framebuffer();
  const view = createViewState();
  setupView(view, { x: o.x * FRACUNIT, y: o.y * FRACUNIT, z: o.z, angle: o.angle });
  const cb = createSegCallbacks(fb, o.world, view);
  clearClipSegs(320);
  clearDrawsegs();
  clearClipArrays(VIEWHEIGHT);
  resetRenderCounters();
  cb.onSegReached?.(o.seg ?? 0, o.a, o.b);
  if (o.pass) cb.addPass(o.a, o.b);
  else cb.addSolid(o.a, o.b);
  let min = 999, max = -1;
  for (let x = o.a; x <= o.b; x++) {
    let lo = 999, hi = -1;
    for (let y = 0; y < 200; y++) if (fb.indices[y * 320 + x] !== 0) { if (lo === 999) lo = y; hi = y; }
    if (lo !== 999) { min = Math.min(min, lo); max = Math.max(max, hi); }
  }
  return { fb, min, max };
}

function spanAt(fb: Framebuffer, x: number): [number, number] {
  let lo = 999, hi = -1;
  for (let y = 0; y < 200; y++) if (fb.indices[y * 320 + x] !== 0) { if (lo === 999) lo = y; hi = y; }
  return [lo, hi];
}

// replicate the scale chain for value dumps
function chainDump(label: string, viewx: number, viewy: number, viewangle: number, segAngle: number, v1x: number, v1y: number, col: number) {
  const { xtoviewangle } = initTextureMapping();
  const view = { viewx: viewx, viewy: viewy, viewz: 41 * FRACUNIT, viewangle, viewsin: 0, viewcos: 0, extralight: 0, fixedcolormap: -1 } as ViewState;
  const rwAngle1 = pointToAngle(view, v1x, v1y);
  const rwNormalAngle = angAdd(segAngle, ANG90);
  let offsetAngle = angSub(rwNormalAngle, rwAngle1);
  if ((offsetAngle | 0) < 0) offsetAngle = (-(offsetAngle | 0)) >>> 0;
  if (offsetAngle > ANG90) offsetAngle = ANG90;
  const distangle = angSub(ANG90, offsetAngle);
  // pointToDist
  let dx = Math.abs(v1x - viewx) | 0;
  let dy = Math.abs(v1y - viewy) | 0;
  if (dy > dx) { const t = dx; dx = dy; dy = t; }
  const pangle = (tantoangle[FixedDiv(dy, dx) >> 5]! + ANG90) >>> 19;
  const hyp = FixedDiv(dx, finesine[pangle]!);
  const rwDistance = FixedMul(hyp, finesine[angToFine(distangle)]!);
  const visangle = angAdd(viewangle, xtoviewangle[col]!);
  const anglea = angAdd(ANG90, angSub(visangle, viewangle));
  const angleb = angAdd(ANG90, angSub(visangle, rwNormalAngle));
  const sinea = finesine[angToFine(anglea)]!;
  const sineb = finesine[angToFine(angleb)]!;
  const num = FixedMul(160 * FRACUNIT, sineb);
  const den = FixedMul(rwDistance, sinea);
  let scale = FixedDiv(num, den);
  if (scale > 64 * FRACUNIT) scale = 64 * FRACUNIT; else if (scale < 256) scale = 256;
  // rw_offset
  let oa = angSub(rwNormalAngle, rwAngle1);
  if (oa > ANG180) oa = (0 - oa) >>> 0;
  if (oa > ANG90) oa = ANG90;
  let rwOffset = FixedMul(hyp, finesine[angToFine(oa)]!);
  if (angSub(rwNormalAngle, rwAngle1) < ANG180) rwOffset = -rwOffset;
  const rwCenterAngle = (ANG90 + viewangle - rwNormalAngle) >>> 0;
  log(`${label}: rwAngle1=${(rwAngle1 >>> 0) / 2 ** 16}deg normal=${rwNormalAngle / 2 ** 16}deg oa=${(angSub(rwNormalAngle, rwAngle1) >>> 0) / 2 ** 16} offsetAng=${offsetAngle / 2 ** 16} hyp=${hyp} rwDistance=${rwDistance} (= ${rwDistance / FRACUNIT})`);
  log(`  visangle fine=${angToFine(angSub(visangle, viewangle))} anglea=${angToFine(anglea)} sinea=${sinea} angleb=${angToFine(angleb)} sineb=${sinea === 0 ? 0 : sineb} num=${num} den=${den} scale=${scale} (${(scale / FRACUNIT).toFixed(6)})`);
  log(`  rwOffset(tangent part)=${rwOffset} (${rwOffset / FRACUNIT}) centerAngle fine=${angToFine(rwCenterAngle)} xtoview[160]=${xtoviewangle[160]} xtoview fine@140=${angToFine(angSub(xtoviewangle[140]!, 0)) >>> 0}`);
  // texturecolumn at col
  const angle = (rwCenterAngle + xtoviewangle[col]!) >>> 19;
  log(`  col@${col}: finetangent[${angle}]=${finetangent[angle]} tc=${((rwOffset - FixedMul(finetangent[angle]!, rwDistance)) >> 16)}`);
  return { rwDistance, scale, rwOffset, hyp };
}

it('derive', () => {
  const { xtoviewangle } = initTextureMapping();
  log(`xtoviewangle[160]=${xtoviewangle[160]} [96]fine=${angToFine(xtoviewangle[96]! >>> 0)} [140]fine=${angToFine(xtoviewangle[140]! >>> 0)} [180]fine=${angToFine(xtoviewangle[180]! >>> 0)}`);
  log(`finesine[2048]=${finesine[2048]} finesine[1024]=${finesine[1024]} finesine[2560]=${finesine[2560]}`);

  // ---- VP-A1: perpendicular d=160, col 160
  {
    const w = buildWorld({ h: 128 });
    chainDump('VP-A1', 160 * FRACUNIT, 128 * FRACUNIT, ANG180, ANG90 << 0, 0, 64 * FRACUNIT, 160);
    const r = run({ x: 160, y: 128, angle: ANG180, world: w, a: 160, b: 160 });
    const ds = getDrawsegs();
    log(`VP-A1 scale1=${ds.scale1[0]} scale2=${ds.scale2[0]} step=${ds.scalestep[0]} span=${spanAt(r.fb, 160)}`);
    log(`  ceilclip160=${ceilingclip[160]} floorclip160=${floorclip[160]} sil=${ds.silhouette[0]} sprtop=${ds.sprtopclip[0]} sprbot=${ds.sprbottomclip[0]} bsil=${ds.bsilheight[0]} tsil=${ds.tsilheight[0]}`);
  }
  // ---- VP-A2: cols 140..180
  {
    const w = buildWorld({ h: 128 });
    const r = run({ x: 160, y: 128, angle: ANG180, world: w, a: 140, b: 180 });
    const ds = getDrawsegs();
    log(`VP-A2 scale1=${ds.scale1[0]} scale2=${ds.scale2[0]} step=${ds.scalestep[0]}`);
    log(`  spans 140=${spanAt(r.fb, 140)} 160=${spanAt(r.fb, 160)} 180=${spanAt(r.fb, 180)} 139=${spanAt(r.fb, 139)}`);
    log(`  counters ${JSON.stringify(getRenderCounters())}`);
  }
  // ---- VP-B: d=80, ceiling 72
  {
    const w = buildWorld({ h: 128, ceilA: 72 });
    chainDump('VP-B', 80 * FRACUNIT, 128 * FRACUNIT, ANG180, ANG90, 0, 64 * FRACUNIT, 160);
    const r = run({ x: 80, y: 128, angle: ANG180, world: w, a: 160, b: 160 });
    const ds = getDrawsegs();
    log(`VP-B scale1=${ds.scale1[0]} span=${spanAt(r.fb, 160)}`);
  }
  // ---- VP-C: off-axis 45 deg
  {
    const w = buildWorld({ h: 128 });
    chainDump('VP-C', 160 * FRACUNIT, 0, 0x60000000, ANG90, 0, 64 * FRACUNIT, 160);
    const r = run({ x: 160, y: 0, angle: 0x60000000, world: w, a: 160, b: 160 });
    const ds = getDrawsegs();
    log(`VP-C scale1=${ds.scale1[0]} span=${spanAt(r.fb, 160)}`);
  }
  // ---- VP-D: z=40
  {
    const w = buildWorld({ h: 128 });
    const r = run({ x: 160, y: 128, z: 40 * FRACUNIT, angle: ANG180, world: w, a: 160, b: 160 });
    const ds = getDrawsegs();
    log(`VP-D scale1=${ds.scale1[0]} span=${spanAt(r.fb, 160)}`);
  }
  // ---- VP-E: col 96 (off-center, perpendicular)
  {
    const w = buildWorld({ h: 128 });
    chainDump('VP-E', 160 * FRACUNIT, 128 * FRACUNIT, ANG180, ANG90, 0, 64 * FRACUNIT, 96);
    const r = run({ x: 160, y: 128, angle: ANG180, world: w, a: 96, b: 96 });
    const ds = getDrawsegs();
    log(`VP-E scale1=${ds.scale1[0]} span=${spanAt(r.fb, 96)}`);
  }
  // ---- panning: pan 24, cols 140..180
  {
    const { world, calls } = probed(buildWorld({ h: 128, pan: 24 }));
    chainDump('PAN', 160 * FRACUNIT, 128 * FRACUNIT, ANG180, ANG90, 0, 64 * FRACUNIT, 160);
    run({ x: 160, y: 128, angle: ANG180, world, a: 140, b: 180 });
    log(`PAN probes n=${calls.length} first=${JSON.stringify(calls.slice(0, 3))} mid=${JSON.stringify(calls.slice(19, 22))} last=${JSON.stringify(calls.slice(-2))}`);
    // exact tc per column via chain replica
    const tcs: number[] = [];
    for (let x = 140; x <= 180; x++) {
      const { rwDistance, rwOffset } = { ...chainOf(160 * FRACUNIT, 128 * FRACUNIT, ANG180, 0, 64 * FRACUNIT) };
      const angle = (ANG90 + xtoviewangle[x]!) >>> 19;
      tcs.push((rwOffset - FixedMul(finetangent[angle]!, rwDistance)) >> 16);
    }
    log(`PAN tc-expected ${JSON.stringify(tcs)}`);
    log(`PAN tc-probed   ${JSON.stringify(calls.map((c) => c[1]))}`);
  }
  // ---- pegging (one-sided, tex height 64)
  for (const flags of [0, 0x10]) {
    const w = buildWorld({ h: 64, flags });
    const r = run({ x: 160, y: 128, angle: ANG180, world: w, a: 160, b: 160 });
    log(`PEG flags=0x${flags.toString(16)} span=${spanAt(r.fb, 160)} px@13=${r.fb.indices[13 * 320 + 160]} px@141=${r.fb.indices[141 * 320 + 160]}`);
  }
  // ---- two-sided bottom pegging
  for (const flags of [0, 0x10]) {
    const w = buildWorld({ h: 64, flags, back: { floor: 32, ceil: 128, light: 192, bottom: 'FIXWALL' } });
    const r = run({ x: 160, y: 128, angle: ANG180, world: w, a: 160, b: 160 });
    log(`2S-PEG flags=0x${flags.toString(16)} span=${spanAt(r.fb, 160)} px@109=${r.fb.indices[109 * 320 + 160]}@141=${r.fb.indices[141 * 320 + 160]}`);
  }
  // ---- masked
  {
    const w = buildWorld({ h: 64, back: { floor: 0, ceil: 128, light: 192, mid: 'FIXWALL' } });
    run({ x: 160, y: 128, angle: ANG180, world: w, a: 150, b: 170, seg: 1, pass: true });
    const ds = getDrawsegs();
    log(`MASK count=${drawsegCount()} sil=${ds.silhouette[0]} sprtop=${ds.sprtopclip[0]} sprbot=${ds.sprbottomclip[0]} maskedcol=${ds.maskedcol[0]} tsil=${ds.tsilheight[0]} bsil=${ds.bsilheight[0]}`);
    log(`  mtc[150..153]=${[150, 151, 152, 153].map((x) => maskedTexturecol(0, x))} mtc149=${maskedTexturecol(0, 149)} openingsUsed=${openingsUsed()}`);
    log(`  clipValue top@150=${clipValue(ds.sprtopclip[0]!, 150, VIEWHEIGHT)} bot=${clipValue(ds.sprbottomclip[0]!, 150, VIEWHEIGHT)}`);
    log(`  painted col160=${spanAt(new Framebuffer(), 160)} ceilclip150=${ceilingclip[150]} floorclip150=${floorclip[150]}`);
  }
  // ---- occlusion: one-sided full cover + pass seg
  {
    const w = buildWorld({ h: 128, back: { floor: 16, ceil: 128, light: 192, bottom: 'FIXWALL' } });
    run({ x: 160, y: 128, angle: ANG180, world: w, a: 140, b: 180 });
    // second store pass: new fb, but SAME solidsegs ledger state — replicate by running both in one go:
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, { x: 160 * FRACUNIT, y: 128 * FRACUNIT, angle: ANG180 });
    const cb = createSegCallbacks(fb, w, view);
    clearClipSegs(320); clearDrawsegs(); clearClipArrays(VIEWHEIGHT); resetRenderCounters();
    cb.onSegReached?.(0, 140, 180); cb.addSolid(140, 180);
    const snap: number[] = [];
    for (let x = 140; x <= 180; x++) for (let y = 0; y < 200; y++) snap.push(fb.indices[y * 320 + x]!);
    cb.onSegReached?.(1, 100, 220); cb.addPass(100, 220);
    const ds = getDrawsegs();
    let changed = 0;
    let k = 0;
    for (let x = 140; x <= 180; x++) for (let y = 0; y < 200; y++) if (fb.indices[y * 320 + x] !== snap[k++]) changed++;
    log(`OCC drawsegs=${drawsegCount()} ds1=[${ds.x1[1]},${ds.x2[1]}] ds2=[${ds.x2[2] !== undefined ? `${ds.x1[2]!},${ds.x2[2]}` : '-'}] changedInCovered=${changed} counters=${JSON.stringify(getRenderCounters())}`);
    log(`  painted 120=${spanAt(fb, 120)} 140=${spanAt(fb, 140)} 181=${spanAt(fb, 181)} 219=${spanAt(fb, 219)}`);
    // fully-occluded pass seg
    clearClipSegs(320); clearDrawsegs(); clearClipArrays(VIEWHEIGHT); resetRenderCounters();
    cb.onSegReached?.(0, 100, 220); cb.addSolid(100, 220);
    cb.onSegReached?.(1, 140, 180); cb.addPass(140, 180);
    log(`  full-occ drawsegs=${drawsegCount()} counters=${JSON.stringify(getRenderCounters())}`);
  }
  // ---- silhouette matrix (two-sided variants)
  for (const v of [
    { back: { floor: -16, ceil: 128, light: 192 } }, // back floor lower: front floor > back? 0 > -16 yes -> SIL_BOTTOM bsil=0? front floor 0
    { back: { floor: 0, ceil: 160, light: 192 } }, // back ceil higher -> SIL_TOP tsil=front ceil
    { back: { floor: 200, ceil: 220, light: 192 } }, // back floor above ceil -> CLIP_SCREEN
    { back: { floor: -100, ceil: -50, light: 192 } }, // back ceil <= front floor -> CLIP_NEGONE
    { back: { floor: 0, ceil: 30, light: 192 } }, // back ceil < viewz -> SIL_TOP sentinel
    { back: { floor: 60, ceil: 128, light: 192 } }, // back floor > viewz(41) -> SIL_BOTTOM MAXINT (worldlow>worldbottom too)
  ]) {
    const w = buildWorld({ h: 128, back: v.back });
    run({ x: 160, y: 128, angle: ANG180, world: w, a: 160, b: 160, seg: 1, pass: true });
    const ds = getDrawsegs();
    log(`SIL back(f${v.back.floor},c${v.back.ceil}) sil=${ds.silhouette[0]} bsil=${ds.bsilheight[0]} tsil=${ds.tsilheight[0]} top=${ds.sprtopclip[0]} bot=${ds.sprbottomclip[0]}`);
  }
  // ---- overflow integration
  {
    const w = buildWorld({ h: 128 });
    const fb = new Framebuffer();
    const view = createViewState();
    setupView(view, { x: 160 * FRACUNIT, y: 128 * FRACUNIT, angle: ANG180 });
    const cb = createSegCallbacks(fb, w, view);
    clearClipSegs(320); clearDrawsegs(); clearClipArrays(VIEWHEIGHT); resetRenderCounters();
    for (let i = 0; i < 256; i++) drawsegAdd(0);
    cb.onSegReached?.(0, 160, 160); cb.addSolid(160, 160);
    log(`OVF count=${drawsegCount()} counters=${JSON.stringify(getRenderCounters())} painted=${spanAt(fb, 160)}`);
  }
  // snapshotOpenings addressing
  {
    clearDrawsegs();
    const src = new Int16Array(320);
    for (let x = 0; x < 320; x++) src[x] = x - 100;
    const ref = snapshotOpenings(src, 100, 30);
    log(`SNAP ref=${ref} ref[100]=${clipValue(ref, 100, 200)} ref[129]=${clipValue(ref, 129, 200)} used=${openingsUsed()}`);
  }
  log(`iscale(65536)=${computeIscale(FRACUNIT)} MAXINT=${MAXINT} CLIP: N=${CLIP_NULL} S=${CLIP_SCREEN} N1=${CLIP_NEGONE} MAXSHORT=${MAXSHORT}`);

  writeFileSync('/tmp/derive-out.txt', out.join('\n'));
});

// chain replica for tc sweeps (view fixed perpendicular d=160)
function chainOf(viewx: number, viewy: number, viewangle: number, v1x: number, v1y: number) {
  const view = { viewx, viewy, viewz: 41 * FRACUNIT, viewangle, viewsin: 0, viewcos: 0, extralight: 0, fixedcolormap: -1 } as ViewState;
  const rwAngle1 = pointToAngle(view, v1x, v1y);
  const rwNormalAngle = angAdd(ANG90, ANG90);
  let offsetAngle = angSub(rwNormalAngle, rwAngle1);
  if ((offsetAngle | 0) < 0) offsetAngle = (-(offsetAngle | 0)) >>> 0;
  if (offsetAngle > ANG90) offsetAngle = ANG90;
  const distangle = angSub(ANG90, offsetAngle);
  let dx = Math.abs(v1x - viewx) | 0;
  let dy = Math.abs(v1y - viewy) | 0;
  if (dy > dx) { const t = dx; dx = dy; dy = t; }
  const pangle = (tantoangle[FixedDiv(dy, dx) >> 5]! + ANG90) >>> 19;
  const hyp = FixedDiv(dx, finesine[pangle]!);
  const rwDistance = FixedMul(hyp, finesine[angToFine(distangle)]!);
  let oa = angSub(rwNormalAngle, rwAngle1);
  if (oa > ANG180) oa = (0 - oa) >>> 0;
  if (oa > ANG90) oa = ANG90;
  let rwOffset = FixedMul(hyp, finesine[angToFine(oa)]!);
  if (angSub(rwNormalAngle, rwAngle1) < ANG180) rwOffset = -rwOffset;
  rwOffset = (rwOffset + 24 * FRACUNIT) | 0;
  return { rwDistance, rwOffset };
}
