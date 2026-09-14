# R03 — DOOM BSP Software Renderer Research

Primary source: the id Software GPL release, `linuxdoom-1.10` (github.com/id-Software/DOOM).
All quoted code below was fetched and read directly from the raw files:
`r_main.c`, `r_bsp.c`, `r_segs.c`, `r_draw.c`, `r_plane.c`, `r_sky.c/.h`, `r_things.c`,
`r_data.c`, `r_defs.h`, `r_local.h`, `r_main.h`, `tables.c/.h`, `m_fixed.h/.c`, `doomdef.h`, `g_game.c`.
Quotes are verbatim from that snapshot (v1.10, Jan/Feb 1997 CVS tag lines).

Note on scope: the task brief used names from *early* (1993/94, pre-release) DOOM internals
(`finecosine[512]`, `t_openbottom/t_opentop`, `R_TextureTranslation`, `plane->scale`,
`dc_colordata`, `ANG1_X`). These do **not** appear in the released 1.10 source; where the brief
and the released code disagree, this document states the released-code truth and flags the
difference. The released engine is the correct target for a faithful recreation.

---

## 1. Fixed-point and angle conventions

**Angles.** `angle_t` is `unsigned int` (32-bit). Full circle = 2^32 ("BAM" / protractor angle).
`tables.h` (verified):

```c
#define ANG45    0x20000000
#define ANG90    0x40000000
#define ANG180   0x80000000
#define ANG270   0xc0000000
#define FINEANGLES    8192
#define FINEMASK     (FINEANGLES-1)
// 0x100000000 to 0x2000
#define ANGLETOFINESHIFT 19
```

So `fineangle = angle >> 19` (2^32 / 2^19 = 8192 fine angles; 8192 = one full turn, so
`FINEANGLES/4 = 2048` = 90°). 1 degree = 2^32/360 = 11930464 ≈ `0xB60F60`.

**Trig tables.** `tables.c` ships them as literal data (not computed at startup — the
computation code in `R_InitTables`/`R_InitPointToAngle` is `#if 0`'d out):

```c
fixed_t finesine[5*FINEANGLES/4];   // effective size 10240
fixed_t* finecosine = &finesine[FINEANGLES/4];   // i.e. +2048 entries (r_main.c)
fixed_t finetangent[FINEANGLES/2];  // effective size 4096
angle_t tantoangle[SLOPERANGE+1];   // 2049 entries, SLOPERANGE=2048
```

Values are `finesine[i] = FRACUNIT * sin((i+0.5)*2π/FINEANGLES)` (half-tick phase offset);
`finesine[0]=25`, verified from tables.c data. Usage pattern everywhere:
`finesine[angle >> ANGLETOFINESHIFT]`, indices masked into 0..10239 by the natural wrap of
`angle>>19`. **There is no 512-entry sine table in DOOM** — that is Wolfenstein 3D / the
1993 pre-release ("AngTable" of 512); released DOOM uses the 10240-entry finesine above.

**Fixed point.** `m_fixed.h` (verified): `FRACBITS 16`, `FRACUNIT (1<<FRACBITS)`, `fixed_t = int`.
`m_fixed.c`: `FixedMul(a,b) = ((long long)a * b) >> FRACBITS` (use 32-bit BigInt/multiply-high
emulation in TS); `FixedDiv` overflows to MININT/MAXINT via `FixedDiv2` (`c = ((long long)a)<<16 / b` style).

**Tangent vs angle for clipping.** DOOM gets a point's angle via tangent + arc-tangent LUT,
not via an atan2f: `R_PointToAngle` (r_main.c) folds the vector into 8 octants and calls
`SlopeDiv(num,den)` (tables.c): `if (den < 512) return SLOPERANGE; ans = (num<<3)/(den>>8);`
then `tantoangle[SlopeDiv(y,x)]`. Octant code (verified in r_main.c):

```c
if (x>y) return tantoangle[SlopeDiv(y,x)];            // octant 0
else     return ANG90-1-tantoangle[SlopeDiv(x,y)];    // octant 1  ... etc
```

`R_PointToDist` also uses tantoangle: `angle = (tantoangle[FixedDiv(dy,dx)>>DBITS]+ANG90) >>
ANGLETOFINESHIFT; dist = FixedDiv(dx, finesine[angle]);` with `DBITS = FRACBITS-SLOPEBITS = 5`.

**clipangle / viewangletox (the tangent table's real job).** `FIELDOFVIEW 2048` fine angles
(= 90°) across the screen (r_main.c). `R_InitTextureMapping`:

```c
focallength = FixedDiv (centerxfrac, finetangent[FINEANGLES/4+FIELDOFVIEW/2]);
for (i=0 ; i<FINEANGLES/2 ; i++) {
    if (finetangent[i] > FRACUNIT*2) t = -1;
    else if (finetangent[i] < -FRACUNIT*2) t = viewwidth+1;
    else { t = FixedMul (finetangent[i], focallength);
           t = (centerxfrac - t+FRACUNIT-1)>>FRACBITS; /*clamp [-1, viewwidth+1]*/ }
    viewangletox[i] = t;
}
// then scan viewangletox to build xtoviewangle[x] = (i<<ANGLETOFINESHIFT)-ANG90
clipangle = xtoviewangle[0];
```

With `FIELDOFVIEW=2048`, `clipangle` ≈ slightly under ANG45 (tan(45°+ε) boundary); half-FOV
is exactly 1024 fineangles = 45° at screen edge. `projection = centerxfrac` (r_main.c
`R_ExecuteSetViewSize`, verified), i.e. focal length = half screen width in fixed point.

**TypeScript notes:** store BAM angles as `Uint32` (`>>> 0` after add/sub); `FixedMul(a,b)`
safely as `Math.floor(a*b/65536)|0` for |a·b| < 2^52; build finesine as Int32Array(10240)
with `65536*Math.sin((i+0.5)*Math.PI*2/8192)` (matches the #if 0'd R_InitTables formula).

Confidence: **High** (all constants read from fetched files; finesine[0]=25 spot-checked).

---

## 2. Frame loop: R_RenderPlayerView

Verified in r_main.c — order (this IS the frame):

```c
R_SetupFrame (player);      // viewx/y/z, viewangle, viewsin/cos, extralight,
                            // fixedcolormap (invul/partial-invis), validcount++
R_ClearClipSegs ();         // solidsegs = {(-MAXINT,-1),(viewwidth,MAXINT)}
R_ClearDrawSegs ();         // ds_p = drawsegs
R_ClearPlanes ();           // floorclip[i]=viewheight; ceilingclip[i]=-1; visplanes reset
R_ClearSprites ();          // vissprite_p = vissprites
R_RenderBSPNode (numnodes-1);   // the whole BSP pass (walls + visplane marks + vissprites)
R_DrawPlanes ();            // textured flats + sky via column spans
R_DrawMasked ();            // vissprites back-to-front, masked mid textures, psprites
```

Corrections to the brief: it is `R_ClearSprites` (not "R_ClearPSprites"); there is no
`R_MainRenderBSP`; the BSP pass *adds* things (`R_AddSprites` per sector during traversal)
but *draws* them only at the end in `R_DrawMasked`. Weapon/player sprites (psprites) are
drawn last of all in `R_DrawPlayerSprites`, only `if (!viewangleoffset)` (not in side views).

**Screen blocks:** `R_SetViewSize(blocks, detail)`; `scaledviewwidth = setblocks*32;
viewheight = (setblocks*168/10)&~7;` (blocks=11 → full 320x200); `viewwidth =
scaledviewwidth>>detailshift`. `detailshift` (0=high,1=low/blocky) selects
`colfunc = R_DrawColumn` vs `R_DrawColumnLow`, `spanfunc = R_DrawSpan` vs `R_DrawSpanLow`.
For a faithful TS port, hardcode blocks=11/detail=0 (320x200, `centery=100`, `centerx=160`,
`projection=160<<16`) — DOOM games always play at high detail; detailmask does not exist
("detail" here is only this half-res column doubling).

Confidence: **High**.

---

## 3. BSP traversal: R_RenderBSPNode, R_Subsector

Verbatim (r_bsp.c):

```c
void R_RenderBSPNode (int bspnum) {
    if (bspnum & NF_SUBSECTOR) { R_Subsector(bspnum==(-1)?0:(bspnum&(~NF_SUBSECTOR))); return; }
    bsp = &nodes[bspnum];
    side = R_PointOnSide (viewx, viewy, bsp);
    R_RenderBSPNode (bsp->children[side]);          // front side FIRST (near→far)
    if (R_CheckBBox (bsp->bbox[side^1]))
        R_RenderBSPNode (bsp->children[side^1]);    // back side if bbox maybe visible
}
```

`NF_SUBSECTOR = 0x8000` (r_bsp.h/doomdata.h). `R_PointOnSide` is the classic sign test
(`left = FixedMul(dy_node>>16, dx); right = FixedMul(dy, dx_node>>16); return right < left ? 0 : 1;`
with axis-aligned fast paths and a sign-bit shortcut; returns 0=front, 1=back). Traversal is
therefore **front-to-back** along the viewer's BSP tree. Backchild rejection `R_CheckBBox`
computes the two corner angles of the bbox closest to the view edges via the
`checkcoord[12][4]` table, clips against `clipangle`, maps to screen columns through
`viewangletox`, then tests whether the span is already fully covered by `solidsegs`
(`sx1 >= start->first && sx2 <= start->last → false`). `boxpos==5` (viewpoint inside bbox)
→ always true.

`R_Subsector` (r_bsp.c, verified): `frontsector = sub->sector;` then
`if (frontsector->floorheight < viewz) floorplane = R_FindPlane(floorheight, floorpic,
lightlevel); else floorplane = NULL;` and
`if (frontsector->ceilingheight > viewz || frontsector->ceilingpic == skyflatnum)
ceilingplane = R_FindPlane(...); else ceilingplane = NULL;` then `R_AddSprites(frontsector);`
and `while (count--) R_AddLine(line++);` over the subsector's segs (`segs[firstline..`).

**validcount trick:** `R_AddSprites` starts with
`if (sec->validcount == validcount) return; sec->validcount = validcount;` — a sector split
into many subsectors is only sprite-added once per frame, on its FIRST (nearest) visit.
`validcount++` once per frame in `R_SetupFrame`. (`linedef->validcount` is used similarly in
the collision code, not the renderer; `linedef->flags |= ML_MAPPED` is set in
R_StoreWallRange for the automap.)

Note there is no "R_DrawSubsector": subsectors do not draw, they *record* (drawsegs + plane
marks + vissprite list). Actual drawing happens in R_DrawPlanes/R_DrawMasked. Backsector
"visplanes" are not opened by segs — visplanes are only frontsector planes; back sectors are
handled by drawing the upper/lower wall textures and letting the BSP continue past the
pass-through line.

Confidence: **High** (direct quotes).

---

## 4. R_AddLine: seg clipping with tangents of clip angles

r_bsp.c (verified). The key angles:

```c
angle1 = R_PointToAngle (line->v1->x, line->v1->y);
angle2 = R_PointToAngle (line->v2->x, line->v2->y);
span = angle1 - angle2;
if (span >= ANG180) return;          // back side (backface cull)
rw_angle1 = angle1;
angle1 -= viewangle; angle2 -= viewangle;
tspan = angle1 + clipangle;
if (tspan > 2*clipangle) { tspan -= 2*clipangle; if (tspan >= span) return; angle1 = clipangle; }
tspan = clipangle - angle2;
if (tspan > 2*clipangle) { tspan -= 2*clipangle; if (tspan >= span) return; angle2 = -clipangle; }
angle1 = (angle1+ANG90)>>ANGLETOFINESHIFT;  x1 = viewangletox[angle1];
angle2 = (angle2+ANG90)>>ANGLETOFINESHIFT;  x2 = viewangletox[angle2];
if (x1 == x2) return;                      // crosses no pixel
```

Classification (goto at end of R_AddLine, verified):
- `!backsector` → **clipsolid** (one-sided wall, full occluder).
- closed door (`backceiling <= frontfloor || backfloor >= frontceiling`) → clipsolid.
- heights differ on either side → **clippass** (window: draws toptex/bottex but does not
  add to solidsegs — you can see through the openings).
- identical flats/light and no midtexture → return (reject event lines).
- masked midtexture on an otherwise-closed line: takes the clipsolid path (it occludes
  columns where drawn; its transparent columns are re-drawn later in R_DrawMasked).

`x2` is used as `x2-1` (inclusive stop). `clipangle` usage above = the "tangent of clip
angle" the brief mentions: the LUT `viewangletox` is generated from `finetangent`, and
angles are clamped to ±clipangle. (The 1993 `ANG1_X`/512-step tangent walk is gone; replaced
by `R_PointToAngle`+`SlopeDiv`+`tantoangle`.)

Confidence: **High**.

---

## 5. solidsegs and R_StoreWallRange (drawseg creation)

`solidsegs[MAXSEGS=32]` of `{first,last}` sorted ascending, initialized with sentinel spans
(-MAXINT,-1) and (viewwidth, MAXINT) (verified R_ClearClipSegs).

`R_ClipSolidWallSegment(first,last)` — interval insert/merge against solidsegs, calling
`R_StoreWallRange` for each uncovered fragment (verbatim logic quoted in file: walk
`while (start->last < first-1) start++;` "adjacent pixels are touching" ⇒ adjacent ranges
merge). `R_ClipPassWallSegment` — same fragments reported but **no** insertion into
solidsegs. `MAXDRAWSEGS 256`; overflow returns silently (r_segs.c:
`if (ds_p == &drawsegs[MAXDRAWSEGS]) return;`).

`R_StoreWallRange(start,stop)` (r_segs.c) essentials, verbatim:

```c
rw_normalangle = curline->angle + ANG90;
offsetangle = abs(rw_normalangle-rw_angle1);
if (offsetangle > ANG90) offsetangle = ANG90;
distangle = ANG90 - offsetangle;
hyp = R_PointToDist (curline->v1->x, curline->v1->y);
sineval = finesine[distangle>>ANGLETOFINESHIFT];
rw_distance = FixedMul (hyp, sineval);           // perpendicular dist to line origin

ds_p->x1 = rw_x = start;  ds_p->x2 = stop;  rw_stopx = stop+1;
ds_p->scale1 = rw_scale  = R_ScaleFromGlobalAngle (viewangle + xtoviewangle[start]);
ds_p->scale2 = R_ScaleFromGlobalAngle (viewangle + xtoviewangle[stop]);
ds_p->scalestep = rw_scalestep = (ds_p->scale2 - rw_scale) / (stop-start);
```

`R_ScaleFromGlobalAngle` (r_main.c, live version):
`anglea = ANG90 + (visangle-viewangle); angleb = ANG90 + (visangle-rw_normalangle);`
`num = FixedMul(projection, finesine[angleb>>19]) << detailshift;`
`den = FixedMul(rw_distance, finesine[anglea>>19]);`
`scale = (den > num>>16) ? clamp(FixedDiv(num,den), 256, 64*FRACUNIT) : 64*FRACUNIT;`

Texture U mapping (per column, in `R_RenderSegLoop`):

```c
angle = (rw_centerangle + xtoviewangle[rw_x])>>ANGLETOFINESHIFT;
texturecolumn = rw_offset-FixedMul(finetangent[angle],rw_distance);
texturecolumn >>= FRACBITS;
```

with (from R_StoreWallRange) `rw_offset = ±FixedMul(hyp, finesine[offsetangle>>…])` sign
flipped when `rw_normalangle-rw_angle1 < ANG180`, plus `sidedef->textureoffset +
curline->offset`; `rw_centerangle = ANG90 + viewangle - rw_normalangle`. (This is the
"tangent-based" texture step — `rw_offset` is the tangent-length along the wall at the v1
endpoint. There is no `delta.y*scale` formula in DOOM's renderer; that phrasing belongs to
the brief's earlier-engine memory.)

Vertical projection of wall edges: world heights are pre-shifted by 4 (`worldtop >>= 4`)
and stepped per column:

```c
topstep    = -FixedMul (rw_scalestep, worldtop);
topfrac    = (centeryfrac>>4) - FixedMul (worldtop, rw_scale);
bottomstep = -FixedMul (rw_scalestep, worldbottom);
bottomfrac = (centeryfrac>>4) - FixedMul (worldbottom, rw_scale);
// (pixhigh/pixlow analogously for backsector worldhigh/worldlow)
```

Screen y at a column = `topfrac >> HEIGHTBITS(=12)` (with `HEIGHTUNIT=1<<12`), i.e. the
`y = centery - (h * scale)` law in incremental form. `#define HEIGHTBITS 12` — verified.

Confidence: **High** (verbatim quotes).

---

## 6. R_RenderSegLoop, wall texture vertical mapping

Per column (r_segs.c, verified): mark floor/ceiling spans into visplane `top[]/bottom[]`
arrays (clipped against `ceilingclip`/`floorclip`), then draw tiers:

- **midtexture (one-sided):** `dc_yl = yl; dc_yh = yh; dc_texturemid = rw_midtexturemid;`
  draw, then `ceilingclip[x] = viewheight; floorclip[x] = -1;` (fully occluding).
- **toptexture:** `mid = pixhigh>>12; pixhigh += pixhighstep;` clamp vs floorclip; if
  visible draw yl..mid and set `ceilingclip[x]=mid`; else `ceilingclip[x] = yl-1`.
- **bottomtexture:** `mid = (pixlow+4095)>>12; pixlow += pixlowstep;` clamp vs ceilingclip;
  if `mid <= yh` draw mid..yh, `floorclip[x]=mid`; else `floorclip[x]=yh+1`.
- `maskedtexture`: only records `maskedtexturecol[rw_x] = texturecolumn;`.

Texture mid rules (r_segs.c R_StoreWallRange, verified): one-sided
`rw_midtexturemid = worldtop` unless `ML_DONTPEGBOTTOM` → `frontfloor +
textureheight[mid] - viewz`; two-sided top exists iff `worldhigh < worldtop`,
`worldtop` if `ML_DONTPEGTOP` else `backceiling + textureheight[toptex] - viewz`; bottom
exists iff `worldlow > worldbottom`, `worldtop` if `ML_DONTPEGBOTTOM` else `worldlow`; all
get `+= sidedef->rowoffset`. (Pegging: DONTPEG* anchors texture BOTTOM instead of TOP.)

Column draw uses globals:

```c
dc_colormap = walllights[index];         // index = rw_scale>>LIGHTSCALESHIFT, clamp 47
dc_x = rw_x;
dc_iscale = 0xffffffffu / (unsigned)rw_scale;   // unsigned inverse scale!
```

and the vertical mapping in R_DrawColumn is `frac = dc_texturemid + (dc_yl-centery)*dc_iscale;`
→ screen-space law `texrow = texturemid + (y - centery) * (FRACUNIT/scale_per_screenpx)`.
(In JS: `dc_iscale = (0xffffffffu >>> 0) / (rw_scale >>> 0)` then as uint32 — beware JS
float division precision: compute `Math.floor(0xffffffff/scale)` exactly or emulate with
`(-1 >>> 0)/scale|0` via Number; rw_scale > 0 always.)

Confidence: **High**.

---

## 7. Visplanes (r_plane.c)

`MAXVISPLANES 128`, `MAXOPENINGS SCREENWIDTH*64`. A visplane = `{height, picnum,
lightlevel, minx, maxx, top[SCREENWIDTH], bottom[SCREENWIDTH]}`. `R_FindPlane` merges
planes with identical (height,pic,light) — sky planes force `height=0, lightlevel=0` so
"all skys map together" (verified). `R_CheckPlane(pl,start,stop)` splits a plane when the
new x-range overlaps an already-marked (non-0xff) region, otherwise widens minx/maxx —
this prevents a flat from being drawn twice from two depths (the HOM guard).

There is **no `plane->scale`** — DOOM does not scale flats per-plane. Scale is per screen
row: `yslope[i] = FixedDiv((viewwidth<<detailshift)/2*FRACUNIT, abs(((i-viewheight/2)<<FRACBITS)+FRACUNIT/2));`
(verified R_ExecuteSetViewSize).

`R_MapPlane(y,x1,x2)` (the flat primitive, verbatim core):
`distance = FixedMul(planeheight, yslope[y]); ds_xstep = FixedMul(distance, basexscale);
ds_ystep = FixedMul(distance, baseyscale); length = FixedMul(distance, distscale[x1]);
angle = (viewangle + xtoviewangle[x1])>>ANGLETOFINESHIFT;
ds_xfrac = viewx + FixedMul(finecosine[angle], length);
ds_yfrac = -viewy - FixedMul(finesine[angle], length);   // note the negated y
ds_colormap = planezlight[clamp(distance>>LIGHTZSHIFT, 0, 127)];`

`basexscale = FixedDiv(finecosine[(viewangle-ANG90)>>ANGLETOFINESHIFT], centerxfrac);
baseyscale = -FixedDiv(finesine[same], centerxfrac);` (R_ClearPlanes). `planeheight =
abs(pl->height - viewz)` is set in R_DrawPlanes. `R_DrawPlanes` iterates visplanes in
creation order (= front-to-back by construction) and walks columns through
`R_MakeSpans(x, top[x-1],bottom[x-1], top[x],bottom[x])` which emits horizontal spans
(`R_MapPlane` → `spanfunc` = R_DrawSpan) exactly once per pixel, newest plane wins.
Flat indexing (R_DrawSpan): `spot = ((yfrac>>(16-6))&(63*64)) + ((xfrac>>16)&63);` — 64x64
flats, row-major. Flats stored as 4096-byte column-major? No — flats are 64*64 linear,
`spot = y*64 + x`. Floor vs ceiling use the same `R_DrawSpan`; `floorfunc/ceilingfunc` are
unused vestiges in 1.10.

`R_DrawPlanes` handles the **sky visplane** inline (see §11).

Confidence: **High**.

---

## 8. Drawsegs + sprite clipping (what replaces "drawseg front/back list")

`drawseg_t` (r_defs.h, verified): `curline, x1, x2, scale1, scale2, scalestep, silhouette
(SIL_NONE/BOTTOM/TOP/BOTH = 0/1/2/3), bsilheight, tsilheight, sprtopclip, sprbottomclip,
maskedtexturecol` (pointers "adjusted so [x1] is first value").

In `R_StoreWallRange` (verified):
- one-sided: `silhouette = SIL_BOTH; sprtopclip = screenheightarray; sprbottomclip = negonearray; bsilheight=MAXINT; tsilheight=MININT;`
- two-sided silhouette set from height comparisons (front higher floor ⇒ SIL_BOTTOM with
  `bsilheight = frontfloor` or MAXINT if backfloor > viewz; mirrored for top; back fully
  below frontfloor ⇒ full bottom clip negonearray, etc.).
- `worldtop = worldhigh` hack when both ceilings are sky (outdoor height changes).
- After rendering: if silhouette (or masked) requires it, the **current**
  `ceilingclip[start..stop)` / `floorclip[start..stop)` arrays are `memcpy`'d into the
  openings pool and stored as `sprtopclip`/`sprbottomclip`. So each drawseg stores the
  per-column occlusion it caused, sampled at draw time.
- masked segs force SIL_TOP/SIL_BOTTOM without height (`tsilheight=MININT; bsilheight=MAXINT`).

`R_DrawSprite(spr)` (r_things.c, verified): init `clipbot/cliptop[x] = -2` for x1..x2; scan
drawsegs newest→oldest; skip if `ds->x1 > spr->x2 || ds->x2 < spr->x1 || (!ds->silhouette &&
!ds->maskedtexturecol)`. Let `scale = max(scale1,scale2)`, `lowscale = min(scale1,scale2)`;
if `scale < spr->scale || (lowscale < spr->scale && !R_PointOnSegSide(spr->gx, spr->gy,
ds->curline))` → seg is BEHIND sprite: draw its masked range now
(`R_RenderMaskedSegRange(ds, r1, r2)`) if it has one, and continue (no clipping). Else clip:
`silhouette = ds->silhouette; if (spr->gz >= ds->bsilheight) silhouette &= ~SIL_BOTTOM;
if (spr->gzt <= ds->tsilheight) silhouette &= ~SIL_TOP;` then for silhouette 1/2/3 fill
`clipbot[x] = ds->sprbottomclip[x]` / `cliptop[x] = ds->sprtopclip[x]` where still `-2`.

This scale-comparison loop is DOOM's answer to "is this seg in front of the sprite";
`R_PointOnSegSide` breaks ties for segs whose scale range straddles the sprite's scale.
Unclipped columns default to `clipbot=viewheight, cliptop=-1`. This is also the mechanism
by which sprites behind windows still get drawn: `R_RenderMaskedSegRange` is invoked from
here (masked mid textures of *nearer* segs are painted into the region before the sprite).

`R_DrawVisSprite` streams patch columns: `frac = vis->startfrac; frac += vis->xiscale` per
screen column, `column = patch + patch->columnofs[frac>>16]`, then
`R_DrawMaskedColumn`: per post,

```c
topscreen    = sprtopscreen + spryscale*column->topdelta;
bottomscreen = topscreen + spryscale*column->length;
dc_yl = (topscreen+FRACUNIT-1)>>FRACBITS;
dc_yh = (bottomscreen-1)>>FRACBITS;
if (dc_yh >= mfloorclip[dc_x])   dc_yh = mfloorclip[dc_x]-1;
if (dc_yl <= mceilingclip[dc_x]) dc_yl = mceilingclip[dc_x]+1;
if (dc_yl <= dc_yh) { dc_source = (byte*)column+3;
    dc_texturemid = basetexturemid - (column->topdelta<<FRACBITS); colfunc(); }
column = (column_t*)((byte*)column + column->length + 4);   // topdelta byte + 3 header
```

with `sprtopscreen = centeryfrac - FixedMul(dc_texturemid, spryscale)`. (`spryscale *
topdelta` is plain integer multiplication since topdelta is in 16.16 via <<FRACBITS? No:
`topscreen = sprtopscreen + spryscale*column->topdelta` — topdelta is a byte, so this is
`scale * delta` in fixed point directly. Verified as written.)

Confidence: **High**.

---

## 9. Sprite projection (R_ProjectSprite, r_things.c)

Verified verbatim:

```c
tr_x = thing->x - viewx;  tr_y = thing->y - viewy;
gxt = FixedMul(tr_x,viewcos);  gyt = -FixedMul(tr_y,viewsin);
tz = gxt-gyt;
if (tz < MINZ) return;                     // MINZ = FRACUNIT*4
xscale = FixedDiv(projection, tz);
gxt = -FixedMul(tr_x,viewsin);  gyt = FixedMul(tr_y,viewcos);
tx = -(gyt+gxt);
if (abs(tx) > (tz<<2)) return;             // too far off the side (wide FOV guard)
```

Rotation selection (exact; the brief's `(ang+ANG90/16)>>(ANG90/8)` is the older 512-angle
description): `ang = R_PointToAngle(thing->x, thing->y);
rot = (ang - thing->angle + (unsigned)(ANG45/2)*9) >> 29;` — 8 rotations of 45° each;
rotation 0 faces the viewer, increases clockwise (r_things.c comment). `rotate==0` frames
use `lump[0]`/`flip[0]` for all views.

Screen edges:

```c
tx -= spriteoffset[lump];        // leftoffset<<16, from patch header
x1 = (centerxfrac + FixedMul (tx,xscale)) >> FRACBITS;
tx += spritewidth[lump];
x2 = ((centerxfrac + FixedMul (tx,xscale)) >> FRACBITS) - 1;
```

vissprite fields: `scale = xscale<<detailshift; texturemid = (thing->z + spritetopoffset) -
viewz; xiscale = ±iscale` (negative when flipped; flipped starts `startfrac =
spritewidth-1`), `iscale = FixedDiv(FRACUNIT, xscale)`; if clipped on left,
`startfrac += xiscale*(x1-x1)`. Light: `MF_SHADOW → colormap NULL` (fuzz),
`fixedcolormap`, `FF_FULLBRIGHT → colormaps`, else `spritelights[xscale >>
(LIGHTSCALESHIFT-detailshift)]`.

`R_SortVisSprites` insertion-sorts vissprites **by ascending scale** (smallest = farthest
first) and `R_DrawMasked` draws them back-to-front — so within-sector draw order is
corrected by depth here, not by BSP order.

**PSprites (weapon):** `pspritescale = FRACUNIT*viewwidth/SCREENWIDTH`,
`pspriteiscale = FRACUNIT*SCREENWIDTH/viewwidth`; `tx = psp->sx - 160*FRACUNIT;
x1 = (centerxfrac + FixedMul(tx,pspritescale))>>FRACBITS;` (`sx`/`sy` are fixed-point screen
positions, `WEAPONBOTTOM 128*FRACUNIT`, `WEAPONTOP 32*FRACUNIT`, bob via
`psp->sx = FRACUNIT + FixedMul(player->bob, finecosine[angle])` in p_pspr.c).
`texturemid = (BASEYCENTER<<FRACBITS) + FRACUNIT/2 - (psp->sy - spritetopoffset[lump])`,
`BASEYCENTER = 100`. Clipping: `mfloorclip = screenheightarray; mceilingclip = negonearray;`
(full screen). Colormap: invisibility power → fuzz; `fixedcolormap`; `FF_FULLBRIGHT →
colormaps` (flash frames are fullbright); else `spritelights[MAXLIGHTSCALE-1]` (nearest
scale — weapon is always lit at "zero distance").

Confidence: **High**.

---

## 10. Lighting (diminishing + EXTRALIGHT)

Tables of `lighttable_t*` (= `byte*` into `colormaps`, 256 B per level), both with
`startmap = ((LIGHTLEVELS-1-i)*2)*NUMCOLORMAPS/LIGHTLEVELS` (= (15-level)*2):
- z table (static, R_InitLightTables): `scale = FixedDiv(SCREENWIDTH/2*FRACUNIT,
  (j+1)<<LIGHTZSHIFT); scale >>= LIGHTSCALESHIFT; level = clamp(startmap - scale/DISTMAP);
  zlight[i][j] = colormaps + level*256;`
- scale table (per view size, R_ExecuteSetViewSize): `level = clamp(startmap -
  j*SCREENWIDTH/(viewwidth<<detailshift)/DISTMAP); scalelight[i][j] = colormaps + level*256;`

Wall usage (r_segs.c, verbatim): `lightnum = (frontsector->lightlevel >> LIGHTSEGSHIFT) +
extralight;` then `if (v1->y == v2->y) lightnum--; else if (v1->x == v2->x) lightnum++;`
(pancake-light adjustment: horizontal segs darker, vertical brighter, diagonal normal);
clamped to `scalelight[0..15]`; per column `dc_colormap = walllights[rw_scale>>LIGHTSCALESHIFT]`.
Flat usage: `planezlight = zlight[clamp((lightlevel>>4)+extralight)]`, indexed by
`distance>>LIGHTZSHIFT`. `extralight` = gun-flash light boost, set (not decayed) by state actions `A_Light0/1/2` →
`player->extralight = 0/1/2` (p_pspr.c, verified); zeroed in `P_SpawnPlayer` (p_mobj.c:681)
and `G_PlayerReborn` (g_game.c:788). `fixedcolormap` (invulnerability): set in R_SetupFrame to
`colormaps + player->fixedcolormap*256` and `walllights = scalelightfixed` (all entries the
same map). The brief's `rw->light = s->lightlevel<<LIGHTSHIFT / dist` is the pre-1.10
approach; 1.10 uses the LUTs above exclusively.

Confidence: **High** (incl. extralight set-points in p_pspr.c/p_mobj.c/g_game.c).

---

## 11. Sky rendering

- `skyflatnum = R_FlatNumForName("F_SKY1")` at startup (g_game.c:454, verified); sky texture
  chosen per episode (`SKY1..SKY4`, g_game.c). `SKYFLATNAME "F_SKY1"`, `ANGLETOSKYSHIFT 22`
  (r_sky.h, verified).
- In R_Subsector a ceiling at/behind viewz still opens a visplane **if it is F_SKY1**
  (see §3); R_FindPlane collapses all sky planes (height=0, light=0); in R_StoreWallRange
  `markceiling` is kept for sky even when ceiling below viewz (r_segs.c: `&&
  frontsector->ceilingpic != skyflatnum`), and the `worldtop = worldhigh` outdoor hack.
- Drawing (R_DrawPlanes, verbatim): `dc_iscale = pspriteiscale>>detailshift;` (1:1
  screen-pixel tie at 320 wide); `dc_colormap = colormaps;` (always full bright — comment:
  "so sky is not affected by INVUL inverse mapping"); `dc_texturemid = skytexturemid;` then
  per column x in minx..maxx: `dc_yl = pl->top[x]; dc_yh = pl->bottom[x];
  angle = (viewangle + xtoviewangle[x])>>ANGLETOSKYSHIFT;` (2^32>>22 = 1024 columns = 360°)
  `dc_x = x; dc_source = R_GetColumn(skytexture, angle); colfunc();`

Sky columns are indexed by pure view direction (no distance, no light); rows are tied to
screen y by `dc_iscale = pspriteiscale` so the horizon row sits at `100` texture rows from
the top at eye level (sky textures are 1024x128). `R_InitSkyMap` =
`skytexturemid = 100*FRACUNIT` (one line; the brief's "colormap trick 128..255 for
invulnerability" is a different thing: R_InitColormaps just loads the 34-lump COLORMAP table
in r_data.c; the invul map is lump #32 inverted gamma used as fixedcolormap — no dedicated
R_InitSkyMap colormap code exists in 1.10).

Confidence: **High** for rendering path; **Medium** for the brief's sky/invul-colormap claims
(not found as described in 1.10).

---

## 12. Masked mid textures (two-sided fence lines)

Set-up in R_StoreWallRange: `ds_p->maskedtexturecol = maskedtexturecol = lastopening - rw_x;
lastopening += rw_stopx - rw_x;` and R_RenderSegLoop records `maskedtexturecol[x] =
texturecolumn` per column (a short array indexed by absolute screen x, MAXSHORT = unset).
Rendering is deferred to `R_DrawMasked` (and to R_DrawSprite for segs nearer than a sprite):
`R_RenderMaskedSegRange(ds, x1, x2)` (verbatim highlights):
`rw_scalestep = ds->scalestep; spryscale = ds->scale1 + (x1-ds->x1)*rw_scalestep;
mfloorclip = ds->sprbottomclip; mceilingclip = ds->sprtopclip;` (occlusion snapshot at draw
time); `dc_texturemid = (DONTPEGBOTTOM ? max(frontfloor,backfloor)+texheight :
min(frontceil,backceil)) - viewz + rowoffset;` then per column x1..x2 where
`maskedtexturecol[dc_x] != MAXSHORT`:
`sprtopscreen = centeryfrac - FixedMul(dc_texturemid, spryscale);
dc_iscale = 0xffffffffu / (unsigned)spryscale;
col = (column_t*)((byte*)R_GetColumn(texnum, maskedtexturecol[dc_x]) - 3);
R_DrawMaskedColumn(col); maskedtexturecol[dc_x] = MAXSHORT;` and `spryscale += rw_scalestep;
every column.

(The "-3" tricks R_DrawMaskedColumn's `+3` so `topdelta=0` posts start at the first byte —
a quirk to reproduce exactly. There is no "64-column step loop" in 1.10 masked drawing;
the loop is per screen column with scale stepping.)

Confidence: **High**.

---

## 13. Fuzz / translation columns

`R_DrawFuzzColumn` (r_draw.c, verbatim mechanism): reads the framebuffer back and indexes a
50-entry `fuzzoffset[±320]` jitter table:
`*dest = colormaps[6*256 + dest[fuzzoffset[fuzzpos]]];` using "colormap #6" of 0..31
(comment: brighter than average); borders trimmed (`dc_yl=1` if 0, `dc_yh=viewheight-2`
if last row). Shadow draw = `colormap NULL → colfunc = fuzzcolfunc`. Spectre fuzz is
framebuffer-based, not a precomputed fuzztable of composited pixels (brief's "fuzztable" =
`fuzzoffset`). `R_DrawTranslatedColumn` maps the green player ramp (0x70-0x7F → 0x60/0x40/0x20
grays/reds, R_InitTranslationTables) for MF_TRANSLATION sprites.

Confidence: **High**.

---

## 14. Framebuffer and column posting

`SCREENWIDTH 320`, `SCREENHEIGHT 200` (doomdef.h, verified). 320x200 single-byte-per-pixel
screens (`screens[0]`, plus `screens[1]` back buffer for the border pattern).
`R_InitBuffer(width,height)` (r_draw.c, verified): `viewwindowx = (320-width)>>1;
columnofs[i] = viewwindowx + i; viewwindowy = width==320 ? 0 : (200-32-height)>>1;
ylookup[i] = screens[0] + (i+viewwindowy)*320;` — `byte*` row pointers + `int` column
offsets, so a pixel is `ylookup[y] + columnofs[x]`.

`R_DrawColumn` inner loop (verbatim):

```c
dest = ylookup[dc_yl] + columnofs[dc_x];
fracstep = dc_iscale;
frac = dc_texturemid + (dc_yl-centery)*fracstep;
do { *dest = dc_colormap[dc_source[(frac>>FRACBITS)&127]];
     dest += SCREENWIDTH; frac += fracstep; } while (count--);
```

Wall columns are masked by `&127` (128-tall composite textures; width wrap is pre-done via
`texturewidthmask` in `R_GetColumn`: `col &= texturewidthmask[tex]`, composited patch
column = `texturecomposite[tex] + texturecolumnofs[tex][col]`; single-patch textures read
the raw patch and must be 128 tall by WAD convention). There is no `dc_colordata` array in
1.10 — that's early-code naming; `dc_source` + `dc_colormap` is the pair.

TS mapping: `Uint8Array(64000)`, `ylookup[y] = y*320`; translate the do-loop 1:1 with
integer ops; normalize `frac` with `|0` before `>>16`, `&127` then wraps negatives correctly.

Confidence: **High**.

---

## 15. Hall of mirrors (HOM): why this architecture prevents it

A "hall of mirror" is what you see when a flat (or wall) is left **unpainted**: the
framebuffer byte retains a pixel from the previous frame (or garbage), which looks like a
reflective corridor. Concretely in DOOM's design:

1. Every floor/ceiling pixel must be claimed by exactly one visplane mark
   (`ceilingplane->top[x]/bottom[x]`, `floorplane->...`) during the front-to-back BSP pass.
   `R_RenderSegLoop` marks the region above/below each *solid* or *height-changing* seg, and
   `R_CheckPlane` guarantees a column's marked range is never claimed twice by planes of
   different depth (splitting into a new visplane when overlapping already-marked columns).
2. Because walls are drawn front-to-back and each seg tightens `ceilingclip/floorclip`
   (one-sided segs: `ceilingclip=viewheight; floorclip=-1`), a sector whose boundaries were
   *never reached* (a hole in the BSP map, or a line wrongly treated as non-marking) leaves
   its interior unmarked → nothing drawn there → stale pixels. So HOMs in a faithful port
   are almost always **map bugs** (unwalled gaps, self-referencing sectors) or **clip-seg
   overflow** (`MAXSEGS 32` — a scene with >~30 disjoint solid spans per column leaves gaps;
   DOOM's `R_CheckBBox` early-out keeps this from crashing), or visplane/opening overflow
   (I_Error in 1.10).
3. Sprites/masked textures cannot create HOMs because they draw over already-claimed pixels
   (drawseg snapshot clips guarantee correct occlusion without needing background pixels).
4. DOOM draws *vertical columns*, never horizontal spans for walls; spans exist only for
   flats (R_DrawSpan) after the per-plane `spanstart` bookkeeping in R_MakeSpans, which
   explicitly closes spans when top/bottom clip changes — "no spans for walls / no
   detailmask" per the brief is correct for 1.10.

Recreation rule: paint every pixel exactly once in the visplane pass; keep solidsegs merge
logic exact (including the `first-1` adjacency condition); keep the overflow guards
(drawseg cap returns silently; in TS prefer dynamic grow or same cap).

Confidence: **High** for mechanism in 1.10 (derived from the quoted code); **Medium** for
historical HOM lore attributions.

---

## 16. Constants quick reference (all verified unless noted)

| Constant | Value | File |
|---|---|---|
| FRACBITS / FRACUNIT | 16 / 65536 | m_fixed.h |
| ANG45/90/180/270 | 2^30 / 2^31 / 2^31·2 / 3·2^30 | tables.h |
| FINEANGLES | 8192 | tables.h |
| ANGLETOFINESHIFT | 19 | tables.h |
| finesine / finecosine | 10240 entries / +2048 offset | tables.c, r_main.c |
| finetangent | 4096 | tables.c |
| tantoangle | 2049 (SLOPERANGE 2048, DBITS 5) | tables.c/.h |
| FIELDOFVIEW | 2048 (=45° half-FOV at edges) | r_main.c |
| projection | centerxfrac (=160<<16 at 320) | r_main.c |
| MINZ | 4*FRACUNIT | r_things.c |
| BASEYCENTER | 100 | r_things.c |
| skytexturemid | 100*FRACUNIT | r_sky.c |
| ANGLETOSKYSHIFT | 22 | r_sky.h |
| HEIGHTBITS / HEIGHTUNIT | 12 / 4096 | r_segs.c |
| MAXDRAWSEGS / MAXSEGS | 256 / 32 | r_defs.h / r_bsp.c |
| MAXVISPLANES / MAXOPENINGS | 128 / 320*64 | r_plane.c |
| MAXVISSPRITES | 128 | r_things.h (verified) |
| SIL_NONE/BOTTOM/TOP/BOTH | 0/1/2/3 | r_defs.h |
| LIGHTLEVELS/SEGSHIFT | 16 / 4 | r_main.h |
| MAXLIGHTSCALE/SHIFT | 48 / 12 | r_main.h |
| MAXLIGHTZ / SHIFT | 128 / 20 | r_main.h |
| NUMCOLORMAPS / DISTMAP | 32 / 2 | r_main.h / r_main.c |
| scale clamp | [256, 64*FRACUNIT] | r_main.c |
| SCREENWIDTH/HEIGHT | 320 / 200 | doomdef.h |
| NF_SUBSECTOR | 0x8000 | doomdata.h (via r_bsp.c usage) |

## 17. Sources

- github.com/id-Software/DOOM, `linuxdoom-1.10/`: r_main.c, r_bsp.c, r_segs.c, r_draw.c,
  r_plane.c, r_sky.c/.h, r_things.c, r_data.c, r_defs.h, r_local.h, r_main.h, r_plane.h,
  tables.c/.h, m_fixed.h/.c, doomdef.h, g_game.c — **fetched via curl and quoted directly**
  (all code quotes above checked against these fetches; finesine[0]=25 and finetangent[3071]
  ≈ 65385 ≈ tan(89.98°)… spot-checked numerically).
- The Unofficial DOOM Specs (Steve Benmerador) — **not fetched successfully**; its
  early-era constants (ANG1_X, 512-entry sine, R_TextureTranslation) referenced in the brief
  could not be confirmed and do not appear in 1.10.
- doomwiki.org — returned HTTP 403 to plain curl (both /wiki/Angle and
  /wiki/Hall_of_mirrors_effect); no doomwiki claims incorporated except as lore notes.

## 18. Open items / uncertainties for the architect

1. ~~`MAXVISSPRITES`~~ verified 128 in r_things.h.
2. ~~extralight~~ verified: set by A_Light0/1/2 state actions, no decay.
3. `P_LoadSectors`-side sky/sector details (sky1..4 selection per episode) — g_game.c lines
   454-470/1457-1477 confirmed to exist but not fully quoted.
4. Doom wiki pages were blocked (403); if the specs' tangent constants matter (they don't
   for 1.10-faithful rendering), retry via a different UA/mirror.
5. JS emulation of `0xffffffffu / scale` and `FixedMul` overflow behavior needs a deliberate
   policy (recommend BigInt-free: `Math.floor` + `>>>0`/`|0`, and Uint32Array-backed tables);
   `FixedDiv` clamp-to-MININT/MAXINT behavior (m_fixed.c verified) must be reproduced.
