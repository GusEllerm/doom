# R02 — DOOM Graphics Data Formats (verified against id linuxdoom-1.10 source)

All claims below were re-verified against the actual released source files (id-Software/DOOM, `linuxdoom-1.10`)
fetched to `/tmp/doomsrc`, plus a structural inspection of `freedoom1.wad` v0.13.0 in `/tmp` (NOT in repo).
Line citations refer to the fetched files. Items we could NOT confirm from source are marked *(recalled)*.

Two premises in the tasking were WRONG and are corrected here:
1. Column terminator is topdelta **0xFF** (byte -1), not 0x80 (r_defs.h:287, r_data.c:200, r_things.c:359).
2. Wall light formula is NOT `(s->lightlevel*16)>>LIGHTSHIFT`; it is `(lightlevel >> LIGHTSEGSHIFT) + extralight`
   with distance handled separately via `scalelight[level][scale>>LIGHTSCALESHIFT]` (r_segs.c:122, r_segs.c:169-174).

## 1. Lump lookup rules (w_wad.c, r_data.c, p_setup.c)

| Task | Rule | Source |
|---|---|---|
| `W_CheckNumForName` | case-insensitive scan of ALL loaded lumps **backwards** ("scan backwards so patch lump files take precedence") — last duplicate wins | w_wad.c:376-388 |
| `W_GetNumForName` | same, `I_Error` if missing | w_wad.c:399-409 |
| Flats | `firstflat = W_GetNumForName("F_START")+1`, `lastflat = W_GetNumForName("F_END")-1`, `numflats = last-first+1`; flat number = lump − firstflat | r_data.c R_InitFlats (579-594), R_FlatNumForName (672-684) |
| `R_FlatNumForName` | uses global `W_CheckNumForName(name)` then `return i - firstflat` — so a flat name is resolved by **global last-match**, not restricted to F_START..F_END range | r_data.c:675-684 |
| Sprites | `firstspritelump = S_START+1`, `lastspritelump = S_END-1` (R_InitSpriteLumps, r_data.c:603-625) | r_data.c |
| Patches (walls) | There is NO `R_PatchNumForName`. PNAMES names resolved by **global** `W_CheckNumForName` when building `patchlookup[]` in `R_InitTextures`. The `"S_START"/"S_END"` strings at r_data.c:493-494 are only used for the startup progress-bar print (with the famous `// P_???????` comment) — NOT a lookup range | r_data.c:446-453, 491-495 |
| Textures | `R_CheckTextureNumForName` linear `strncasecmp` over parsed TEXTURE1+TEXTURE2 list; name starting with `'-'` is the "NoTexture" marker returning 0 | r_data.c:692-727 |
| Sky flat | `skyflatnum = R_FlatNumForName(SKYFLATNAME)` with `#define SKYFLATNAME "F_SKY1"` — called from G_InitNew path (g_game.c:454), NOT in R_InitSkyMap (that call is commented out in r_sky.c:59) | r_sky.h:32, g_game.c:454 |

`R_InitData` order: `R_InitTextures` → `R_InitFlats` → `R_InitSpriteLumps` → `R_InitColormaps` (r_data.c:654-666).
`R_InitSprites(sprnames)` (the 113-entry `sprnames[]` in info.c) is called from `P_SetupLevel` (p_setup.c:704).

Confidence: high (all direct source).

## 2. PLAYPAL (palettes)

- Lump = **14 × 768 bytes** (14 palettes × 256 RGB triples, 0-255 range, no gamma in file; gamma applied by the
  video layer via `I_SetPalette`). Verified: freedoom1.wad PLAYPAL size = 10752 = 14·768; r_data.c uses none of it,
  but `ST_loadData` caches it (`lu_palette = W_GetNumForName("PLAYPAL")`, st_stuff.c:1203) and switches with
  `pal = base + palette*768; I_SetPalette(pal)` (st_stuff.c:1048).
- Selection logic — `ST_doPaletteStuff` (st_stuff.c:1000-1050), run every tic from `ST_Ticker`:

| Index | Use | Trigger (exact source logic) |
|---|---|---|
| 0 | normal | default; also restored on state change (`D_DoomDraw`: `I_SetPalette(W_CacheLumpName("PLAYPAL"))`, d_main.c:275) |
| 1..8 | red pain (`STARTREDPALS=1`, `NUMREDPALS=8`) | `cnt = damagecount`; `palette = (cnt+7)>>3` clamped to 7, `+=1`. Berserk: `bzc = 12 - (powers[pw_strength]>>6)`, `cnt = max(cnt,bzc)` → red tint fades over ~12 tics |
| 9..12 | gold bonus pickup (`STARTBONUSPALS=9`, `NUMBONUSPALS=4`) | `palette = (bonuscount+7)>>3` clamped 3, `+=9` (item pickup sets bonuscount=200+, decremented per tic in p_user.c) |
| 13 | radiation suit green (`RADIATIONPAL=13`) | `powers[pw_ironfeet] > 4*32 \|\| powers[pw_ironfeet]&8` |
| 14… | do not exist — Doom 1 has 14 palettes | |

- WAD verification (freedoom1.wad): palettes 1..8 ramp red at color 0 (28,57,86,114,143,172,200,229 — 8 steps);
  9..12 gold ramp (26/23/8 steps); 13 is green-shifted (color 0 = [0,31,0]). Matches constants.
- Note: palettes 1..13 are the ONLY replacements; there is **no** quad damage palette (Doom 2 powerup, not Doom 1).
  Invulnerability uses COLORMAP row 32 instead (below), not a palette.

Confidence: high.

## 3. COLORMAP (light tables)

- Lump = 8704 bytes = **34 × 256** (verified: freedoom1.wad COLORMAP size 8704). Loaded verbatim into an
  256-byte-aligned `colormaps` pointer (`R_InitColormaps`, r_data.c:633-644, `length = W_LumpLength(lump)+255`).
- Rows 0..31: light level → palette remap (0 = full bright, 31 = darkest). `NUMCOLORMAPS 32` (r_main.h:84).
- Row 32: `INVERSECOLORMAP 32` (p_user.c:41) — greyscale/inverse map used for **invulnerability**:
  `player->fixedcolormap = INVERSECOLORMAP` (p_user.c:367), consumed as
  `fixedcolormap = colormaps + player->fixedcolormap*256` in `R_RenderPlayerView` (r_main.c:847-856), which also
  forces `scalelightfixed[i] = fixedcolormap` so every wall/sprite pixel goes through that single row.
- `fixedcolormap = 1` for infrared (night vision) — "almost full bright" row 1 (p_user.c:377).
- Fullbright sprites/sky do NOT use row 32/33: they just use `colormaps` = row 0 unmodified
  (r_things.c:588-591 `vis->colormap = colormaps`; r_plane.c:405 "Sky is allways drawn full bright, i.e.
  colormaps[0] is used").
- `inversecolormap` as a separate mechanism: not needed — only this row-32 fixedcolormap exists.
- Which of 34 rows are actually used by vanilla: 0..31 (light), 1 again (infrared), 32 (invul). Rows 33 (and the
  second copy in 0-31? no) are unreferenced by 1.10 code; (recalled: row 33 historically for DOOM 2's red
  invulnerability map — not used in Doom 1).

## 4. Light diminishing math (exact)

Constants (r_main.h:69-75, r_local.h):

```c
#define LIGHTLEVELS   16   // sector-light buckets
#define LIGHTSEGSHIFT  4   // lightlevel>>4 -> bucket (lightlevel 0..255 -> 0..15)
#define MAXLIGHTSCALE 48   // distance buckets for walls/sprites
#define LIGHTSCALESHIFT 12
#define MAXLIGHTZ    128   // distance buckets for flats
#define LIGHTZSHIFT   20
#define NUMCOLORMAPS  32
#define DISTMAP        2   // r_main.c:613
```

- Sector bucket: `lightnum = (frontsector->lightlevel >> LIGHTSEGSHIFT) + extralight` (r_segs.c:122, 642;
  r_plane.c:428; r_things.c R_AddSprites/R_AddPSprites). `extralight` = gun-flash bump from player (r_main.c:838).
  Walls get a small directional tweak: `lightnum--` if line is horizontal (v1.y==v2.y), `lightnum++` if vertical
  (r_segs.c:124-127). Clamp to [0, LIGHTLEVELS-1] → `walllights = scalelight[lightnum]`.
- Per-column distance fade (walls, r_segs.c:167-174 in `R_StoreWallRange` draw):
  `index = spryscale >> LIGHTSCALESHIFT` (clamped `MAXLIGHTSCALE-1`), `dc_colormap = walllights[index]`,
  where `spryscale` interpolates `ds_p->scale1/2` — the projected wall scale, incremented
  `spryscale += rw_scalestep` per pixel. `scale1 = rw_scale = FixedDiv(projection, gxt-gyt)<<detailshift`
  (r_segs.c:419). i.e. distance dimming via projected scale, not raw distance.
- Table build, `R_ExecuteSetViewSize` (r_main.c:744-759) — scalelight:
  `startmap = ((LIGHTLEVELS-1-i)*2)*NUMCOLORMAPS/LIGHTLEVELS;`
  `level = startmap - j*SCREENWIDTH/(viewwidth<<detailshift)/DISTMAP;` clamp 0..31;
  `scalelight[i][j] = colormaps + level*256`.
- Table build, `R_InitLightTables` (r_main.c:614-642) — zlight (flats):
  `scale = FixedDiv((SCREENWIDTH/2*FRACUNIT), (j+1)<<LIGHTZSHIFT); scale >>= LIGHTSCALESHIFT;`
  `level = startmap - scale/DISTMAP;` `zlight[i][j] = colormaps + level*256`. Flats use
  `planezlight = zlight[light]` (r_plane.c:436) and index it by per-span distance.
- Sprites: `vis->colormap = spritelights[xscale >> (LIGHTSCALESHIFT-detailshift)]` with
  `spritelights = scalelight[lightnum]` (r_things.c:598-602, 631-635).
- There is **no `LIGHTBRIGHT` constant** in linuxdoom-1.10 (grep over all files).

Confidence: high.

## 5. Patch (column-post) format — r_data.c / r_things.c usage

Byte layout (patch_t, r_defs.h:356-364; post_t r_defs.h:283-292):

| Offset | Size | Field |
|---|---|---|
| 0 | int16 | width |
| 2 | int16 | height |
| 4 | int16 | leftoffset (pixels left of origin) |
| 6 | int16 | topoffset (pixels below origin) |
| 8 | 4·width | columnofs[i]: int32, offset from lump start to column i |

- A **column** = sequence of posts; each post: byte `topdelta` (rows below previous post top; 0 allowed),
  byte `length` (1..255), then `length` palette bytes.
- Column terminator: `topdelta == 0xFF` (r_defs.h:287 comment "-1 is the last post in a column";
  loops `while (patch->topdelta != 0xff)` — r_data.c:200 `R_DrawColumnInCache`, r_things.c:359
  `R_DrawMaskedColumn`). NOT 0x80. Verified on real data: freedoom1.wad `BOSSA1` col 0 begins
  `0A 05 6B 6B 6A 6C 05 … FF …`.
- No padding/alignment inside a patch; posts are byte-packed. (The 4-byte "alignment" seen in texture
  composites is the `+3` pointer trick — see §6.)
- Sprites are patches; wall patches and sprite patches share the format. `R_InitSpriteLumps` caches
  `spritewidth[i] = SHORT(patch->width)<<FRACBITS`, `spriteoffset`, `spritetopoffset`
  from leftoffset/topoffset (r_data.c:603-625).
- Sample (freedoom1.wad): lump `BOSSA1`: w=49 h=69 left=24 top=69.
- The function that "reads" a patch is simply `W_CacheLumpNum` + cast to `patch_t*` — there is no
  `R_ReadPatch` in 1.10.

Confidence: high.

## 6. Flats

- Raw 64×64 = **4096 bytes**, row-major, no header. Flat index = position between F_START/F_END
  (r_data.c:585-588). Verified: freedoom1.wad has 246 lumps between F_START/F_END, sizes {4096} (plus size-0
  spacer lumps — harmless, count includes them; vanilla numbering assumes contiguous 4096 lumps).
- Names are 8 chars padded with trailing 0x00 in the directory, e.g. `"FLAT1\0\0"`, `"F_SKY1\0\0"`
  (all names are 0-padded, not space-padded; comparison is done as two 4-byte ints — w_wad.c:364-383).
  F_SKY1 itself is a real 4096-byte flat (its pixels never shown).
- Drawn via `W_CacheLumpNum(firstflat + flattranslation[picnum])` (r_plane.c:423-425).

## 7. TEXTURE1 / TEXTURE2 / PNAMES

PNAMES: int32 count + count × 8-byte names. `patchlookup[i] = W_CheckNumForName(name_i)` at load
(r_data.c:446-453); a name found nowhere makes that patch `-1` → `I_Error("Missing patch")`.

TEXTURE1 (and optional TEXTURE2, appended) — on-disk structs (r_data.c:69-92 `maptexture_t`, 76 `mappatch_t`):

| Offset | Type | Field |
|---|---|---|
| 0 | int32 | numtextures |
| 4 | 4·N | offsets (int32, relative to this lump's start) |
texture record (byte offsets verified against raw bytes of freedoom1.wad TEXTURE1, `AASTINKY` record:
`name… 00000000 2000 4800 00000000 0300` + 3× mappatch):

| Offset | Type | Field |
|---|---|---|
| 0 | char[8] | name (NUL-padded) |
| 8 | int32 | **masked** flag (4-byte field: u16 flag + 2 pad + u16 0; nonzero = columns may have holes → drawn with the masked/post column renderer) |
| 12 | int16 | width (power of two in practice; mask = next pow2 − 1, r_data.c:554-557) |
| 14 | int16 | height |
| 16 | int32 | obsolete columndirectory (ignored; struct field `void** columndirectory`, r_data.c:87) |
| 20 | int16 | patchcount |
| 22 | 10 each | mappatch records: 5 × int16: originx, originy, patch (PNAMES index), stepdir, colormap — only originx/originy/patch copied (r_data.c:536-538) |

The released `maptexture_t {char name[8]; boolean masked; short width; short height; void**; short patchcount;}`
lands on exactly these disk offsets because `boolean` is a 4-byte enum (doomtype.h:34), matching the canonical
Unofficial Doom Specs layout.

- Texture count in DOOM: TEXTURE1 + TEXTURE2 concatenated (r_data.c:461-472); `R_TextureNumForName` searches
  the combined list by name; `R_CheckTextureNumForName` treats name[0]=='-' as "no texture" (returns 0).
- Compositing: `R_GenerateLookup`/`R_GenerateComposite` (r_data.c:228-405). Columns touched by exactly one patch
  point directly into the patch lump (`colofs[x] = LONG(columnofs[..])+3`); columns overlapped by multiple
  patches get a freshly built post in a composite block (`dest = cache + 3`, R_DrawColumnInCache). The `+3`
  is the post header space (topdelta+length+slack byte) — there is **no 8-byte alignment** anywhere; that was
  a false premise. Composite overflow guard: `texturecompositesize > 0x10000 - texture->height` → error
  ("texture is >64k", r_data.c:371-376).
- `R_GetColumn(tex,col)`: `col &= texturewidthmask[tex]` (wrap by pow2 mask) then lump+offset (r_data.c:385-404).

### Texture/flat animation and switches — NO ANIMATED lump in vanilla

- Vanilla animation is a **hardcoded `animdefs[]` table in p_spec.c:102-141** (`animdef_t {istexture, endname,
  startname, speed}`; e.g. `{false,"NUKAGE3","NUKAGE1",8}`, `{true,"BLODGR4","BLODGR1",8}`, `{true,"DBRAIN4",…}`;
  includes a "DOOM II flat animations" block). `P_InitPicAnims` resolves them into `anims[32]` by consecutive
  flat/texture numbers (p_spec.c:143-180).
- Per-tic, `P_UpdateSpecials` (p_spec.c:1085-1107) sets
  `pic = basepic + ((leveltime/speed + i) % numpics); texturetranslation[i] = pic` (or `flattranslation`).
  The renderer applies these globally through `texturetranslation[sidedef->midtexture]` (r_segs.c:460 etc.) and
  `flattranslation[pl->picnum]` (r_plane.c:423-425). That IS the entire texture/flat animation mechanism.
- There is **no ANIMATED lump** — confirmed absent in freedoom1.wad directory; the mechanism is internal to
  p_spec.c (also true in retail DOOM.EXE). *(Confident; p_spec.c is the released implementation.)*
- Switch texture "animation" (SW1xxx→SW2xxx): hardcoded `switchlist` name pairs in p_switch.c (~40 entries,
  e.g. `{"SW1BRCOM","SW2BRCOM",1}`); `P_ChangeSwitchTexture` swaps the matching side texture to its partner
  (`switchlist[i^1]`) and buttons revert via `P_StartButton` after `BUTTONTIME` (p_switch.c:201-260). No
  SWITCHES lump in vanilla (also absent in freedoom1.wad).
- Light flicker ("fl1..fl24"): sector specials in **p_lights.c** — thinkers `P_SpawnLightFlash`,
  `P_SpawnFireFlicker`, `P_SpawnStrobeFlash`, `P_SpawnGlowingLight` mutate `sector->lightlevel`;
  consumed each frame by the lightnum formulas in §4. (No R_AnimateLight exists in linuxdoom-1.10 — that
  function is DOOM 2 / later-source material; light animation here is entirely logic-side.)

Confidence: high (texture record offsets verified byte-for-byte in freedoom1.wad TEXTURE1).

## 8. Sprites

- Lump naming `SSWWWAA[AFF]`: 4-char sprite name, 1 frame letter A-Z (max 29 frames — `sprtemp[29]`,
  `frame >= 29` error, r_things.c:110-114), 1 rotation digit. Rotation `0` = single lump for all 8 views;
  `1..8` = one of 8 octants (1 = one clockwise step from facing-the-viewer; r_things.c:71-75 comment).
  A 7th/8th character (another letter+digit pair) means this lump is **also** installed as the mirrored
  image of another frame/rotation: `if (lumpinfo[l].name[6]) { frame=name[6]-'A'; rotation=name[7]-'0';
  R_InstallSpriteLump(l, frame, rotation, true); }` (r_things.c:228-234).
- Lookup: for each 4-char name in `sprnames[]` (info.c), `R_InitSpriteDefs` scans every lump between
  S_START..S_END comparing first 4 name chars as an int (`*(int*)lumpinfo[l].name == intname`, r_things.c:207-218).
  No "S_" prefix rule. With `modifiedgame`, `W_GetNumForName` re-resolves for override precedence.
  Validation: frame with rotate≠0 must have all 8 rotations, rot0-lump + rot1..8 mix is an error
  (r_things.c:246-269, 116-152).
- Rotation selection in `R_ProjectSprite` (r_things.c:520-533):
  `ang = R_PointToAngle(thing->x, thing->y); rot = (ang - thing->angle + (unsigned)(ANG45/2)*9) >> 29;`
  `lump = sprframe->lump[rot]; flip = sprframe->flip[rot];` — mirroring = draw patch right-to-left:
  `vis->startfrac = spritewidth[lump]-1; vis->xiscale = -iscale;` (r_things.c:561-564).
- Frame constants: `FF_FULLBRIGHT = 0x8000`, `FF_FRAMEMASK = 0x7fff` (p_pspr.h:50-51). There are NO
  `BIT_TOPFULLBRIGHT`/32-flag constants in linuxdoom-1.10 (that scheme belongs to some source ports) —
  fullbright is a single 0x8000 bit on `state_t::frame`; frame index = `frame & FF_FRAMEMASK`.
  Fullbright draw: `vis->colormap = colormaps` (row 0), r_things.c:588-591.
- `MF_SHADOW` (translucent things): `vis->colormap = NULL` (r_things.c:581), then in `R_DrawMasked`:
  `if (!dc_colormap) colfunc = fuzzcolfunc` (r_things.c:415). Fuzz is the destination-jitter table
  `fuzzoffset[50]` of ±320 (SCREENWIDTH) screen offsets in r_draw.c (FUZZTABLE 50, FUZZOFF SCREENWIDTH);
  **no fuzz colormap / fuzzcolormap lump** exists in vanilla (that's Heretic).
  Note: `R_DrawColumnLow` (detail mode) has the `dc_source[(frac>>FRACBITS)&127]` masking quirk (r_draw.c:247).
- Translated (playerspectre/armor) sprites: `MF_TRANSLATION` → `R_DrawTranslatedColumn` +
  `translationtables` (r_things.c:418-420, R_InitTranslationTables in r_data.c — palette 13 remap rows).
- PSprite same machinery: `R_AddPSprites` lightnum → `spritelights` (r_things.c:727, 758-762).

Confidence: high.

## 9. Sky

- `#define SKYFLATNAME "F_SKY1"` (r_sky.h:32); `skyflatnum = R_FlatNumForName(SKYFLATNAME)` at level start
  (g_game.c:454). Sectors assign it as flatpic for floor/ceiling — there is no ceiling special; comparison
  `pl->picnum == skyflatnum` (r_plane.c:225, 396). All sky planes collapse to height 0 / lightlevel 0
  (r_plane.c:225-230 "all skys map together").
- Sky texture = normal TEXTURE1 texture `SKY1..SKY4` chosen per episode (g_game.c:1457-1477: `skytexture =
  R_TextureNumForName("SKY1")…("SKY4")`).
- `skytexturemid = 100*FRACUNIT` (r_sky.c:60 `R_InitSkyMap`, called on view-size change r_main.c:788).
- Drawing (R_DrawPlanes, r_plane.c:396-418): full bright always `dc_colormap = colormaps` ("Sky is allways
  drawn full bright … sky is not affected by INVUL inverse mapping" comment),
  `angle = (viewangle + xtoviewangle[x]) >> ANGLETOSKYSHIFT` with `#define ANGLETOSKYSHIFT 22` (r_sky.h:35)
  — 360° mapped onto 128 sky columns (2^32/2^22 = 1024 ang-indices? — no: shift gives 2^10=1024 values into
  R_GetColumn's pow2 texture mask); horizontal scroll = just viewangle; vanilla has no skyspeed here.
- Wall/flat sky edge case: two-sided lines with sky on both ceilings get the "hack to allow height changes in
  outdoor areas" (`worldtop = worldhigh`, r_segs.c:529-532).
- The "skycolormap table 128..255 trick" from the tasking does NOT exist in linuxdoom-1.10 (r_sky.c is 62
  lines, no such table). *(That is DOOM 2's r_sky.c / skyflat behavior — recalled, low priority for Doom 1.)*

Confidence: high for 1.10 behavior; the skycolormap note is explicitly DOOM-2-only.

## 10. Verified numeric facts (spot-checked ≥5)

1. PLAYPAL = 10752 bytes = 14×768 — freedoom1.wad directory + st_stuff.c:1048 `palette*768`. ✔
2. COLORMAP = 8704 bytes = 34×256; `INVERSECOLORMAP 32` — freedoom1.wad + p_user.c:41. ✔
3. `LIGHTLEVELS 16`, `LIGHTSEGSHIFT 4`, `MAXLIGHTSCALE 48`, `LIGHTSCALESHIFT 12`, `MAXLIGHTZ 128`,
   `LIGHTZSHIFT 20`, `NUMCOLORMAPS 32`, `DISTMAP 2` — r_main.h:69-75, r_main.c:613. ✔
4. `rot = (ang-thing->angle + ANG45/2*9) >> 29` — r_things.c:523. ✔
5. Post loop `while (patch->topdelta != 0xff)` — r_data.c:200, r_things.c:359; real bytes show FF terminators. ✔
6. `FF_FULLBRIGHT 0x8000`, `FF_FRAMEMASK 0x7fff` — p_pspr.h:50-51. ✔
7. `skytexturemid = 100*FRACUNIT`; `ANGLETOSKYSHIFT 22` — r_sky.c:60, r_sky.h:35. ✔
8. Sprite lumps 853 between S_START/S_END in freedoom1.wad; 182 have 8-char mirrored names; e.g. `SARGA2A8`. ✔
9. Flat lumps = 4096 bytes; patch sample BOSSA1 w=49 h=69 left=24 top=69. ✔
10. animdefs speeds = 8 tics/frame, `MAXANIMS 32`, `pic = basepic + ((leveltime/speed + i)%numpics)` —
    p_spec.c:92-141, 1104. ✔

## Sources

- id GPL source, https://raw.githubusercontent.com/id-Software/DOOM/master/linuxdoom-1.10/
  (w_wad.c, r_data.c, r_main.c/h, r_local.h, r_segs.c, r_things.c, r_plane.c, r_draw.c, r_sky.c/h, r_defs.h,
  p_spec.c, p_switch.c, p_user.c, p_lights.c, p_setup.c, p_pspr.h, st_stuff.c, d_main.c, g_game.c, info.c)
- DoomWiki.org articles (PLAYPAL/COLORMAP/Patch/Texture) for terminology cross-check only — no numeric fact
  rests on them.
- The Unofficial DOOM Specs (for the TEXTURE record byte-offset footnote).
- /tmp/freedoom1_v013.wad (freedoom v0.13.0, via Debian package) directory inspection for lump presence/sizes.

Open uncertainties for the architect:
- DOOM-2-only skycolormap/inverse palettes deliberately excluded (Doom 1 target).
- Vanilla quirk worth keeping: flats lookup by global name (`R_FlatNumForName` not range-checked) means
  duplicate names later in the WAD win.
