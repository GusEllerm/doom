# R01 — WAD Container and Map Lumps (implementable reference)

Target: vanilla Doom 1 / Ultimate Doom WAD format as parsed by the id GPL source
(`linuxdoom-1.10`: `w_wad.c`, `doomdata.h`, `p_setup.c`, `p_mobj.c`, `p_sight.c`,
`p_maputl.c`, `r_data.c`, `r_defs.h`), as consumed by **Freedoom: Phase 1**
(`freedoom1.wad`, v0.13.0, verified empirically against the actual file).

All integers **little-endian**. Strings are fixed-width ASCII, NUL- or space-padded, not
NUL-terminated when full width. Coordinates are signed 16-bit map units (rendered as
fixed-point via `<<FRACBITS` at load, `p_setup.c`).

Confidence legend: **High** = verified against GPL source code AND/OR the actual
freedoom1.wad bytes; **Medium** = single primary source or strong secondary; **Low** = recalled.

Empirical basis: full parse of freedoom1.wad v0.13.0 (28,795,076 bytes, IWAD,
3163 lumps, dir at offset 28,744,468), all 36 maps E1M1–E4M9, plus spot-checks of
TEXTURE1/2, PNAMES, patches, sprites, flats, blockmaps.

---

## 1. WAD header — 12 bytes at file offset 0

```
struct WADHeader {              // offset 0
  char    identification[4];    // "IWAD" or "PWAD" (ASCII)
  int32   numlumps;             // lump directory entry count
  int32   infotableofs;         // absolute offset of lump directory
}                               // total 12 bytes; first lump data usually starts at 12
```

Verified: `w_wad.c W_AddFile()` reads 4-byte id (`strncmp(...,"IWAD",4)`, then `"PWAD"`),
then `numlumps = LONG(...)`, `infotableofs = LONG(...)`. No padding field — the "16-byte
header" repeated by some tools/docs is wrong; id reads exactly 12 bytes.
Empirical freedoom1.wad: `49 57 41 44` ("IWAD"), numlumps=3163, infotableofs=28744468;
E1M1 marker lump `filepos=12` ✓. **Confidence: High.**

## 2. Lump directory — 16 bytes per entry at `infotableofs`

```
struct LumpEntry {              // infotableofs + i*16
  int32  filepos;               // absolute data offset (0-size lumps still have a position)
  int32  size;                  // byte count; 0 = marker lump
  char   name[8];               // ASCII, padded with 0x00 (freedoom) or 0x20 (older tools)
}
```

- Lookup (`w_wad.c W_CheckNumForName`): uppercases the query, compares 8 chars
  (stored names are 9-byte NUL-terminated copies), and scans **backwards**
  `numlumps-1 .. 0` — the **last** definition of a name wins within one WAD.
- Multiple WADs chain (`-file`); later files win (same backward logic over the
  concatenated `lumpinfo` array).
- Practical rule for our parser: store names trimmed of trailing 0x00/0x20, compare
  case-insensitively, resolve duplicates last-wins. **Confidence: High.**

## 3. Map layout — marker + 10 data lumps

A map is a 0-size marker lump (`E1M1`..`E4M9`; DOOM2 uses `MAP01`.. with no marker)
immediately followed by exactly this lump sequence (`p_setup.c P_SetupLevel` computes
`lumpnum = W_GetNumForName("E1M1")` and indexes `lumpnum + ML_THINGS(1) .. ML_BLOCKMAP(10)`):

| # | lump      | record size | E1M1 size → count (empirical)               |
|---|-----------|-------------|---------------------------------------------|
| 1 | THINGS    | 10          | 2920 → 292 things                           |
| 2 | LINEDEFS  | 14          | 16450 → 1175 lines                          |
| 3 | SIDEDEFS  | 30          | 54870 → 1829 sidedefs                       |
| 4 | VERTEXES  | 4           | 4784 → 1196 vertices                        |
| 5 | SEGS      | 12          | 24684 → 2057 segs                           |
| 6 | SSECTORS  | 4           | 2728 → 682 subsectors                       |
| 7 | NODES     | 28          | 19068 → 681 nodes (= subsectors − 1) ✓      |
| 8 | SECTORS   | 26          | 4732 → 182 sectors                          |
| 9 | REJECT    | —           | 4141 = ceil(182²/8) ✓ (see §12)             |
|10 | BLOCKMAP  | —           | 7528 bytes; grid 32×27, origin (−712,−1072) |

Freedoom map lumps are NOT name-prefixed: `E1M1` marker followed by plain
`THINGS`..`BLOCKMAP` (identical names for every map — resolve by index, not name!).
All 36 E-maps present (E1M1–E4M9, markers size 0). **Confidence: High** (source + bytes).
Hexen-format `Things` (10 → 14 bytes) is NOT used anywhere in vanilla/freedoom.

## 4. THINGS — 10 bytes (`mapthing_t` in doomdata.h: 5 × int16)

```
int16 x, y;          // position
int16 angle;         // degrees; 0=E 90=N 180=W 270=S (multiples of 45 in practice)
int16 type;          // doomednum
int16 flags;         // options/spawn bits, below
```

Flag bits (values confirmed by `p_mobj.c P_SpawnMapThing`, see below):

```
0x001  skill 1–2 (easy/normal-lite)   "baby or easy"
0x002  skill 3   (normal)
0x004  skill 4–5 (hard/nightmare)
0x008  MTF_AMBUSH  — alerted-only/“deaf-ish” flag. NOTE: vanilla 1.10 IGNORES this bit
                      entirely (no code path uses it; P_SpawnMapThing below never tests 8).
                      Freedoom maps still set it (observed in E1M1 flags). Store raw; no
                      behavior needed for vanilla fidelity.
0x010  MTF_NOTSINGLE — skipped when !netgame: `if (!netgame && (options & 16)) return;`
                      (verbatim in p_mobj.c) ✓ verified
0x20/0x40/0x80      — MBF/Boom extensions (friendly/deaf/etc). Not vanilla; store raw.
```

Spawn filter, verbatim `p_mobj.c` (~line 717): `type == 11` → store deathmatch start
(type 11 IS the DOOM 1 DM start; confirmed present in E1M1); `type <= 4` → player start
(types 1–4; all four present in E1M1, exactly 1 each); then `bit = (gameskill==sk_baby)?1
: (gameskill==sk_nightmare)?4 : 1<<(gameskill-1)`, spawn iff `options & bit`.
Observed E1M1 flag values: {1,3,4,6,7,9,12,14,15,23,31}. **Confidence: High.**

## 5. LINEDEFS — 14 bytes

```
int16 v1, v2;        // vertex indices; line direction v1→v2 defines front/back (side 0/1)
int16 flags;         // ML_* bits, verbatim from doomdata.h:
//   0x001 ML_BLOCKING      editor-only solid flag (engine blocking comes from specials)
//   0x002 ML_BLOCKMONSTERS
//   0x004 ML_TWOSIDED      back side exists (renderer draws back side)
//   0x008 ML_DONTPEGTOP    upper texture unpegged (fixed to ceiling)
//   0x010 ML_DONTPEGBOTTOM lower texture unpegged (fixed to floor)
//   0x020 ML_SECRET        automap: report as solid
//   0x040 ML_SOUNDBLOCK
//   0x080 ML_DONTDRAW      automap: never draw
//   0x100 ML_MAPPED        set at runtime by engine, not in WAD
int16 special;       // line special (verified used in E1M1: 0,1,2,11,23,26,62,88,117)
int16 tag;
int16 sidenum[2];    // sidedef indices; sidenum[1] == -1 (0xFFFF) ⇒ one-sided
```

Empirical E1M1: 521 one-sided (sidenum[1]=−1), 654 with ML_TWOSIDED; every line with the
two-sided bit had a valid sidenum[1] (0 counterexamples); 0 lines relied on ML_BLOCKING
alone for solidity (as expected). **Confidence: High** (flags verbatim from doomdata.h).

## 6. SIDEDEFS — 30 bytes (`mapsidedef_t`)

```
int16 textureoffset;    // world-X texture scroll
int16 rowoffset;        // world-Y texture scroll
char  toptexture[8];    // "-" (0x2D) or all-space/zero = none
char  bottomtexture[8];
char  midtexture[8];
int16 sector;           // sector behind this side (verified max = 181 with 182 sectors ✓)
```

Convention (M4-10 verified on freedoom1 E1M1 raw bytes): one-sided lines put the wall
texture in **midtexture (byte 20)** — vanilla's `sideDef_t` slot order is
top@4/bottom@12/mid@20. (The earlier "solid uses TOPTEXTURE, mid never non-empty"
claim was an artifact of a swapped decoder, since fixed in mapdata.ts.) Mid-textured
(masked) lines: two-sided bit set AND
midtexture non-empty; a plain two-sided line has both top/bottom textures chosen from the
two neighboring sectors. Texture name compare: uppercase, trim trailing space/NUL;
treat "-" as empty. **Confidence: High.**

## 7. VERTEXES — 4 bytes

`int16 x, y;`. The BSP builder adds split vertices, so vertexes ≥ original count exist.
**Confidence: High.**

## 8. SEGS — 12 bytes (`msegs_t`)

```
int16 v1, v2;     // vertex INDICES into VERTEXES (seg endpoints; splits get new vertices)
int16 angle;      // BAM16: angle of v1→v2 direction; unsigned; 65536 = 360°
                  // (0=E, 16384=N, 32768=W; verified: treated as u16, values to 64442)
int16 linedef;    // index into LINEDEFS; −1 for "minisegs" (BSP split artifacts).
                  // E1M1 has ZERO minisegs (freedoom maps don't use −1 segs; E1M1 0/2057;
                  // still handle −1 defensively).
int16 side;       // 0 = front, 1 = back (which sidedef of linedef)
int16 offset;     // texture offset along line from linedef v1 to seg v1 (map units)
```

Direction rule: side==0 ⇒ seg runs same direction as linedef v1→v2; side==1 ⇒ opposite.
Verified on E1M1 with coordinate vectors: 1920/2057 exact; remaining 137 differ only by
BSP split-point rounding (collinearity off by ≤1 unit; direction semantics hold).
Angle = BAM of the same v1→v2 vector (atan2 check: same rounding-limited match).
Minisegs (linedef −1) have side=0/1 into a one-sided line pair; not present in freedoom.
**Confidence: High.**

## 9. SSECTORS — 4 bytes

`int16 numsegs; int16 firstseg;` — segs are contiguous; firstseg indexes SEGS.
E1M1 verified: first subsectors (3,0),(3,3),(3,6) — contiguous tiling; max firstseg+numsegs ≤ 2057 ✓.
Each subsector lies in exactly one sector (engine derives it from the first seg’s sidedef,
`p_setup.c P_GroupLines`: `ss->sector = seg->sidedef->sector`). **Confidence: High.**

## 10. NODES — 28 bytes (`mapnode_t`)

```
int16  x, y;         // partition line start (integer map units; 1.10 stores as fixed <<FRACBITS)
int16  dx, dy;       // partition line delta
int16  bbox[2][4];   // child bounding boxes: {minx, miny, maxx, maxy} per child (frustum clip)
uint16 children[2];  // if bit 15 (0x8000 = NF_SUBSECTOR, doomdata.h) set → index into
                     // SSECTORS (value & 0x7FFF); else index into NODES (subtree)
```

A node’s partition line splits the plane; child 0 is the **front/right** side of the
vector (x,y)→(x+dx,y+dy), child 1 the back/left side (renderer walks back-first:
`P_CrossBSPNode` in p_sight.c, `R_SubSectorBSP` in r_bsp.c). Verified: E1M1 node0 =
(368,1296,dx0,dy−32), children 0x8001/0x8002 → subsectors 1 and 2; all non-leaf child
indices < numnodes (681); leaves = subsector count (682) ✓ BSP invariant nodes = subs−1.
**Confidence: High.**

## 11. SECTORS — 26 bytes (`mapsector_t`)

```
int16 floorheight;      // map units (signed; can be negative)
int16 ceilingheight;
char  floorpic[8];      // flat name
char  ceilingpic[8];    // flat name; "F_SKY1" ⇒ sky (verified: F_SKY1 flat exists, 4096 B)
int16 lightlevel;       // 0..255
int16 special;          // sector special (E1M1 uses 0,1,7,9,12)
int16 tag;              // links to line/sector actions
```

**Confidence: High** (verbatim doomdata.h; counts verified).

## 12. REJECT — ⚠ LINEAR n²-bit packing (not row-padded!)

`p_sight.c P_CheckSight` indexes the matrix as:
`s1 = sector A, s2 = sector B; pnum = s1*numsectors + s2; if (rejectmatrix[pnum>>3] &
(1<<(pnum&7))) → invisible`. I.e. bit at linear position `s1*n + s2` (bit 1 = cannot see).
So the natural size is **ceil(n²/8)** bytes — verified for ALL 36 freedoom maps (E1M1:
182² /8 → 4141 bytes ✓ exact; E4M9: 651² → 52976 ✓).
Many docs claim rows of `n*ceil(n/8)` bytes (4186 for 182) — WRONG for vanilla indexing.
Parser guidance: read raw, size it to ceil(n²/8), clamp reads (pad 0x00 = visible) if a
pwad ships a short/row-padded matrix. **Confidence: High** (code + 36/36 maps).

## 13. BLOCKMAP — word-addressed

```
int16 originx, originy;               // block (0,0) corner (<<FRACBITS at load)
int16 width, height;                  // grid dims; block size = 128×128 map units
                                      // (MAPBLOCKSHIFT=7, p_local.h/doomdef.h)
uint16 blockoffsets[width*height];    // WORD offset (bytes/2) from BLOCKMAP LUMP START
                                      // to a line-number list; list = int16 entries,
                                      // terminated by int16 −1 (0xFFFF)
line lists…                            // referenced line indices into LINEDEFS
```

Load code, `p_setup.c` (~line 474): caches the whole lump, `SHORT()`-swaps it **two bytes
at a time for `length/2` iterations** (all-16-bit view), `blockmap = blockmaplump+4`, and
`P_BlockLinesIterator` (`p_maputl.c`): `offset = *(blockmap + y*bmapwidth+x); for (list =
blockmaplump+offset; *list != -1; list++)` — out-of-range blocks (x/y outside grid) are
skipped silently. Empirical E1M1: origin (−712,−1072), 32×27, lump = 3764 words =
4 header + 864 table + 2900 list words; every offset ≥ 4+bw*bh (= line section starts
immediately after the offset table, **no padding word** in any of the 36 maps); all 864
lists terminate with −1; max referenced line = 1174 = last line ✓.
Port caveat: the offsets are in **words**, not bytes — a port that scans "line blocks"
from `4+bw*bh` **words** is fine; treat offsets×2 as byte positions. Empty blocks repeat
an existing `[−1]` terminator (offset points at a bare −1). Also note `p_setup.c` swaps
the lump as int16 (a port storing a byte copy must byte-swap likewise).
**Confidence: High.**

## 14. Common (non-map) lumps

Verified names/sizes in freedoom1.wad:

| lump | layout / notes |
|---|---|
| `PLAYPAL` | 10752 = 14 palettes × 768 bytes (RGB triples, palette 0 base) ✓ exact size |
| `COLORMAP`| 8704 = 34 tables × 256 bytes (light 255→0 + invuln maps) ✓ exact size |
| `PNAMES`  | int32 count (1049), then count × **8-byte** names. ⚠ Vanilla reads stride 8 (`r_data.c: strncpy(name, name_p + i*8, 8)`) — NOT the 16-byte "name+reserved" some docs claim. Empirical: lump size 4+8·1049 = 8396 ✓ exact. |
| `TEXTURE1`/`TEXTURE2` | int32 count (freedoom1: 801 + 162 = 963 textures), then int32 offsets to records: `char name[8]; int32 (0); int16 width; int16 height; int16 (0); int16 (0); int16 patchcount; then patchcount × {int16 x, y, patch, stepdir, colormap}` — header 22 B, width@12, height@14, patchcount@20, patches@22. Verified 963/963 records parse sanely (e.g. BIGDOOR1 128×96, 5 patches); max patch index 1048 < PNAMES 1049 ✓. This offset layout equals `maptexture_t` (r_data.c) with `boolean=enum` (4-byte) and `void* columndirectory` placeholder — the infamous "struct copied to disk" format. Some secondary docs (Unofficial Specs) imply width@8/patchcount@14 — those offsets are empirically WRONG for vanilla/freedoom. Confidence: High (bytes + struct layout), field names of the four 0-bytes Low. |
| patches (in `P_START`..`P_END`) | 1047 lumps. Header: `int16 width, height, leftoffset, topoffset; int32 columnofs[width]` — 4 SHORTS then LONG offsets (r_defs.h `patch_t` ✓ + empirical: colofs[0] = 8+4·width in all 853 sprites scanned). columnofs are byte offsets from lump start. Column: repeated `(int8 topdelta, byte length, byte[length])` posts until `topdelta == 0xFF` terminator, then 1–4 align bytes before the next column start (columnofs is authoritative). Verified post walk on AG128_1 column 0. Confidence: High for header/columns, Medium for align-byte details. |
| flats (in `F_START`..`F_END`) | raw 64×64 palettized bytes = 4096 each, no header; first byte = top-left corner. 246 flat-region lumps incl. embedded markers (`F1_START`..`F3_END` used by freedoom tooling). `F_SKY1` = 4096-byte placeholder. ✓ |
| sprites (in `S_START`..`S_END`) | 853 lumps, patch-format as above; lump name = 4-char sprite + frame letter + rotation digit (e.g. `BOSSA1`); rotations 0 = all angles, `ABCD…` = 45° octants; `XY` pairs for mirrored frames. ✓ scanned all 853 parse as valid patch headers |
| markers present | `S_START/S_END`, `P_START/P_END` (+`P1..P3_START/END` sub-markers), `F_START/F_END` (+`F1..F3_*`). Names are NUL-padded in the directory ✓ |
| `ANIMATED` | ABSENT in freedoom1.wad — it is a **Boom/MBF-only** lump; vanilla drives flats/texture animation via sector/line specials + built-in tables (`r_data.c R_InitTexAnims` / flat animation table). Don’t implement. Verified absent. |
| `BFND`/`SFND` | ABSENT (Boom-only sound-fallback lumps). Verified absent. |
| `FLOOR7_1`, `FLOOR7_2`, `CEIL5_1`, `CEIL5_2` | these are **4096-byte flat lumps** (episode floor/ceil sets, DOOM 1 shareware grouping). The TEXTURE1-internal "episode marker" texture names referenced by some docs are DeuTex artifacts; in freedoom1 they appear as actual flat lumps — verified sizes 4096. "WALL" marker lump: absent. |
| `CNTR`/`CELE` | no such lumps in freedoom1.wad (checked exhaustively). The brief’s "F/WAL", "CNTR/CELE" grouping lumps do not exist in this IWAD; DOOM1 shareware episode-texture markers exist only inside TEXTURE1 records in the original id WADs. Confidence: High (absent here), Low on historical shape. |

Also present (verified by name in the directory): `TITLEPIC`, `M_DOOM`, `HELP1`, `HELP2`,
`CREDIT` (**columnar flat-picture format**: int16 width=320, int16 height=200, then
2×width int16 offsets (main + transparent-translation column tables) — patch-style
post columns; size 68168 B verified, offset math 8+4·320=1288 = first column ✓), `WILV00`… (episode
intermission map graphics), `END2`/`END3` (episode-end text graphics; no `ENDGAME`,
`ENDROOM*` or `ENDMAP` lumps exist in this IWAD), `SW1*`/`SW2*` switch texture pairs
(plain patches), `DS*` sound lumps. Music: no `G*`/`D_*` OPL lumps inventoried here —
freedoom ships DOS-MIDI-style `D_*`/`G_*`? unverified, defer to audio research (R07).

## 15. Quirks register (parser must-haves)

1. **Resolve map lumps BY INDEX** from the map marker (`marker+1 .. marker+10`), never by
   name — all maps reuse the same data lump names (`p_setup.c` does exactly this).
2. **Last-name-wins** lookup within/across WADs; case-insensitive; names NUL- *and*
   space-padded → trim both.
3. **−1 as unsigned trap**: sidenum[1]/linedef refs are int16 −1 sentinels. Read signed.
   A `uint16` read turning 0xFFFF into 65535 will crash the renderer; classic port bug.
4. **BLOCKMAP offsets are word offsets** from the lump start (×2 for bytes); line lists
   end at int16 −1; out-of-grid blocks = no lines. Load whole lump then 16-bit-swap.
5. **REJECT is linear s1·n+s2 bit order** — convert from row-padded inputs if ever needed.
6. **PNAMES stride 8**, textures width@12/height@14/patchcount@20, patch header 4×int16 +
   int32 colofs: the three places where "docs vs bytes" diverge — follow the bytes above.
7. Masked vs solid: midtexture present on two-sided line ⇒ masked (R_BLOCKRENDERER,
   draw both faces); one-sided solid walls live in **toptexture of side 0**.
8. THINGS bit 8 (ambush) exists in freedoom maps but vanilla ignores it — keep for
   future MBF parity but do not alter vanilla behavior on it.
9. Lump data may be shared/overlapping in badly built pwads; vanilla tolerates it.
   Marker lumps with size 0 can share positions (E1M1 marker sits at 12 with the data).
10. E1M1 marker is lump #0 at offset 12 in freedoom1.wad: nothing lives between the
    header and map 1.

## 16. Sources

- id GPL `linuxdoom-1.10` raw files (fetched & read this session):
  `doomdata.h` (all map record structs + ML_* flag bits verbatim), `w_wad.c`/`w_wad.h`
  (header/directory layout, name lookup), `p_setup.c` (lump loading, blockmap swap,
  subsector→sector), `p_mobj.c` (thing flags/skill/DM starts), `p_sight.c` (REJECT
  indexing), `p_maputl.c` (blockmap iteration), `r_data.c` + `r_defs.h` (PNAMES stride,
  texture record, patch_t), `doomtype.h`, `p_map.c`.
- Empirical: `/tmp/freedoom-0.13.0/freedoom1.wad` (v0.13.0, 28,795,076 B) parsed with a
  Python script: header, full directory, all 36 maps’ lumps sized/counted, E1M1 records
  deep-verified (things flags, linedef sidenum/twosided cross-check, seg direction/angle
  geometry, node invariants, blockmap offsets/terminators, reject size formula ×36 maps,
  PNAMES/TEXTURE1/2 963-record scan, 853-sprite header scan, patch column walk).
- The Unofficial DOOM Specs and doomwiki.org were **NOT fetchable** in this sandbox
  (doomwiki.org returned 403; gamers.org index reachable but specs pages not located);
  where docs could have added context, confidence was graded down instead of quoting them.
  No spec page is cited as verified.
- Freedoom WAD obtained from an existing /tmp copy of the official v0.13.0 release zip
  (github release-asset URLs 404 through this environment’s egress).

## 17. Open items for the architect

- Decide internal representation for one-sided wall (keep top-texture-on-side-0 rule).
- Sky flat (`F_SKY1`) sentinel handling belongs to R03/renderer, not the loader.
- `MAP01`-style names (Doom 2 format) absent from freedoom1 — but loader may support
  both cheaply since freedoom2.wad exists for the Phase 2 stretch goal.
