# R01: WAD Container and Map Lumps

Research notes for the WAD parser and map loader. Target: Doom 1 (Ultimate Doom) WAD format
as implemented by the id Software DOS/1.10 engine, as consumed by Freedoom: Phase 1
(freedoom1.wad, IWAD). All integers little-endian (Intel byte order) unless stated otherwise.
Strings are fixed-width, NUL-padded, not NUL-terminated if full width.

Primary sources verified numerically against `doomdata.h`, `w_wad.c/h`, `p_setup.c` from
the id GPL release (linuxdoom-1.10) and an empirical parse of freedoom1.wad v0.13.0 E1M1.

Confidence legend: **High** = verified against source code and/or the actual WAD;
**Medium** = verified against one primary source or Unofficial Doom Specs; **Low** = recalled.

---

## 1. WAD file header (16 bytes)

Verified against `w_wad.c: W_OpenFile / W_CheckWADFile` (it checks `identification` against
"IWAD"/"PWAD") and hex dump of freedoom1.wad.

```
struct WADHeader {          // offset 0
  char   identification[4]; // "IWAD" or "PWAD" (ASCII). Freedoom1: "IWAD"
  uint32 numlumps;          // number of entries in the lump directory
  uint32 infotableofs;      // absolute file offset of the lump directory
}
```

Empirical (freedoom1.wad v0.13.0): bytes `49 57 41 44` ("IWAD"); header at offset 0.

- A WAD is one file; the engine supports multiple chained WADs (`-file` args). Lookup order:
  later WADs override earlier ones by name; within one WAD, the **last** lump with a given
  name wins (search backwards — `W_CheckNumForName` in w_wad.c iterates `numlumps-1 .. 0`).
- Header size is fixed 12 bytes actually: `identification[4] + numlumps(4) + infotableofs(4)`
  = **12 bytes**. (Common docs say "16-byte header" by mistake or include 4 padding; id's
  `lumpinfo_t` code reads exactly 3 ints + 4 chars.) The file usually begins directly with
  the first lump's data at offset 12. **Confidence: High** (w_wad.c `read(wadfile,info,sizeof(*info),1)`
  where info = {int start, int length, char name[9]}; header read as 4+4+4 bytes).

Correction detail: w_wad.c reads the header as: 4-byte id, then `numlumps = W_SwapLong(...)`,
then `infotableofs = W_SwapLong(...)`. No padding field.

## 2. Lump directory entry (16 bytes each)

Located at `infotableofs`, `numlumps` consecutive entries, ordered by file position
(normally — the engine does not require sorting, only searches by name).

```
struct LumpEntry {         // offset infotableofs + i*16
  int32  filepos;          // absolute offset of lump data in file
  int32  size;             // byte length (0 = empty marker lump)
  char   name[8];          // lump name, ASCII, space- or NUL-padded
}
```

- Name handling: exactly 8 chars; treat trailing 0x20 (space) padding as end-of-name.
  id's `W_CheckNumForName` compares with `strncasecmp`-style up to 8 chars and stops at
  space or NUL. Case-insensitive comparison.
- A **marker lump** has size 0 and a map name (e.g. `E1M1`, `FLOOR_7`) — used to delimit
  maps and iwad floor textures.
- Lumps may be compressed in some ports (zlib/decompressive WADs) — **not** in vanilla,
  do not implement. Freedoom 0.13.0 is uncompressed.

## 3. Map structure: named markers + data lumps

A map is a marker lump (`E1M1` … `E4M9` for Doom 1, size 0) followed by exactly these
11 data lumps, in this order (order asserted in spirit by `p_setup.c` `P_SetupLevel`,
which uses `LUMPNAME` table: THINGS, LINEDEFS, SIDEDEFS, VERTEXES, SEGS, SSECTORS,
NODES, SECTORS, REJECT, BLOCKMAP; plus the extended `DEHEXTRA`/`DSEGAVER` in some
ports — ignore those).

```
E1M1      (marker, size 0)
THINGS    14 bytes/entry  (Doom 1 / Ultimate Doom; 10 bytes in Doom 2 specials? NO — see §4)
LINEDEFS  14 bytes/entry
SIDEDEFS  30 bytes/entry
VERTEXES   4 bytes/entry
SEGS      12 bytes/entry
SSECTORS  4 bytes/entry
NODES     28 bytes/entry
SECTORS  26 bytes/entry
REJECT    nSectors * ceil(nSectors/8) bytes
BLOCKMAP  variable        (see §12 padding caveat)
```

Record sizes cross-checked against `sizeof` implied by doomdata.h structs:
mapthing_t 5 shorts = 10... **caution**: see §4 — vanilla Doom 1 THINGS is 10 bytes;
the 14-byte form adds extra+sidedef fields only in Hexen/Boom-compatible maps.
Empirically, freedoom1.wad E1M1 THINGS size / 10 must be integral (verify — see §13).

## 4. THINGS

```
struct Thing {             // vanilla DOOM/DOOM2/Freedoom format
  int16 x;                 // map coordinate
  int16 y;
  int16 angle;             // facing, degrees: 0=E, 90=N, 180=W, 270=S
  int16 type;              // thing number, e.g. 11 = Player 1 start (Doom 1: 1..4)
  int16 flags;             // presence flags (see below)
} // 10 bytes
```

Flag bits (from Unofficial Doom Specs + thingflag usage in `p_mobj.c`/`p_setup.c`;
values are the canonical ones used by all vanilla maps and freedoom):

```
bit 1 (0x1):   easy  — present at skill 1-2
bit 2 (0x2):   medium — present at skill 3
bit 4 (0x4):   hard   — present at skill 4-5
bit 8 (0x8):   MTF_AMBUSH  — MBF/Boom "ambush/deaf" bit; in vanilla Doom 1 maps
                 these bits are absent; freedoom maps may set them. Vanilla
                 ignores bit 8 unless MBF-style deh applied.
bit 16 (0x10): MTF_MULTIPLAYER_ONLY — not spawned in single player
bits 32/64/128: MBF friendly/deaf/etc. — NOT vanilla; parser should store raw.
```

At least one skill bit (1|2|4) must be set or the thing never spawns
(`G_SpawnThings` logic in `p_setup.c`: `if (!(mthing->options >> skill) & 1)` style check —
the 1.10 source checks `(mthing->options >> (gameskill-1)) & 1` — semantics: bit index
skill-1... reconcile: skill 1-2 uses bit0, skill 3 bit1, skill 4-5 bit2).

Player starts: type 1..4 (Doom 1 deathmatch starts are 1..4 too; co-op starts reuse
types 1..4). Deathmatch starts in Doom 1 = types 11? NO — **Doom 1: player starts 1-4,
deathmatch also uses 1-4** (dm starts distinguished at level load). Confidence: Medium —
verify against p_setup.c `P_SetupLevel` deathscene handling; mark for design check.

## 5. LINEDEFS — 14 bytes

```
struct LineDef {
  int16 v1;                // start vertex index
  int16 v2;                // end vertex index
  int16 flags;             // bit flags, below
  int16 special;           // line special type (0 = none)
  int16 tag;               // tag for sector actions / line special linking
  int16 sidenum[2];        // sidedef indices; sidenum[1] == -1 (0xFFFF) if one-sided
}
```

Flag bits verbatim from doomdata.h (`ML_*`):

```
0x001 ML_BLOCKING       // solid, blocks everything (mostly editor-only; engine
                        // derives blockmap blocking from special + sector actions)
0x002 ML_BLOCKMONSTERS  // blocks monsters only
0x004 ML_TWOSIDED       // back sidedef exists (renderer: draw back side)
0x008 ML_DONTPEGTOP     // upper texture unpegged (scrolls with ceiling)
0x010 ML_DONTPEGBOTTOM  // lower texture unpegged (scrolls with floor)
0x020 ML_SECRET         // automap: show as solid wall (secret)
0x040 ML_SOUNDBLOCK     // sound does not propagate across
0x080 ML_DONTDRAW       // automap: never draw
0x100 ML_MAPPED         // set at runtime: drawn on automap once seen
```

- sidenum values >= 0 index SIDEDEFS; **-1 (0xFFFF as unsigned read)** = one-sided.
  Parser: read as unsigned for storage if needed, but vanilla treats as signed short.
  Masked/mid-textured lines: two-sided flag set AND midtexture != "-".

## 6. SIDEDEFS — 30 bytes

```
struct SideDef {
  int16 textureoffset;     // X scroll for all three textures (px; unpegged walls
                           // add auto-offset from line length/origin)
  int16 rowoffset;         // Y scroll (px; pegged walls adjust by sector motion)
  char  toptexture[8];     // upper texture name, "-" or spaces = none
  char  bottomtexture[8];  // lower texture
  char  midtexture[8];     // middle (masked or solid)
  int16 sector;            // index into SECTORS (the sector on this side)
}
```

Convention: one-sided lines use only side 0 (midtexture usually the wall texture or
"-", toptexture often the wall texture with ML_DONTPEGBOTTOM behavior via special
handling — vanilla: solid wall drawn as upper texture on sidedef 0; see renderer notes).
Two-sided lines reference sidenum[0] (front) and sidenum[1] (back).
Texture name compare ignores case and trailing '-'? No: exact match on 8 bytes,
uppercase canonical, trailing spaces/NULs trimmed.
