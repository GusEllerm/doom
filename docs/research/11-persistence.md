# R11 — Save Games and Demo Format (DOOM 1.10 / Freedoom target)

Sources: id DOOM 1.10 source (`/tmp/DOOM-master/linuxdoom-1.10/`), Chocolate Doom (`/tmp/chocolate-doom-master/src/`). All claims verified against local sources this session; confidence marked per section.

## 1. Vanilla savegame stream (G_DoSaveGame, g_game.c)

**Confidence: high (all quotes read directly from `/tmp/DOOM-master/linuxdoom-1.10/g_game.c` and `p_saveg.c` this session).**

### 1.1 File layout / order

`G_DoSaveGame` (g_game.c:1270) writes, in this exact order:

```c
    memcpy (save_p, description, SAVESTRINGSIZE);      // 24-byte slot label
    save_p += SAVESTRINGSIZE;
    memset (name2,0,sizeof(name2));
    sprintf (name2,"version %i",VERSION);              // "version 110", 16 bytes
    memcpy (save_p, name2, VERSIONSIZE);
    save_p += VERSIONSIZE;

    *save_p++ = gameskill;
    *save_p++ = gameepisode;
    *save_p++ = gamemap;
    for (i=0 ; i<MAXPLAYERS ; i++)
	*save_p++ = playeringame[i];
    *save_p++ = leveltime>>16;                         // 24-bit big-endian tic counter
    *save_p++ = leveltime>>8;
    *save_p++ = leveltime;

    P_ArchivePlayers ();
    P_ArchiveWorld ();
    P_ArchiveThinkers ();
    P_ArchiveSpecials ();

    *save_p++ = 0x1d;		// consistancy marker
```

Constants (g_game.c:74-75, doomdef.h:33, dstrings.h:41): `SAVEGAMESIZE 0x2c000` (179,712 B hard cap → `I_Error("Savegame buffer overrun")`), `SAVESTRINGSIZE 24`, `VERSIONSIZE 16`, `VERSION = 110`, `SAVEGAMENAME "doomsav"` → file `doomsav<N>.dsg`. The whole header is raw bytes (1-byte fields, no endianness conversion), so vanilla files are little-endian-host-typed except the explicit big-endian 3-byte `leveltime`.

**Random index is NOT in the vanilla stream.** `rndindex`/`prndindex` appear nowhere in p_saveg.c or the save/load functions; `rndindex` is only used as the netgame consistency checksum (g_game.c:692 `consistancy[i][buf] = rndindex;`). On load, `G_DoLoadGame → G_InitNew → M_ClearRandom()` (g_game.c:1414) resets both to 0 — see §4/§6 for the parity consequences. (Corrects the outline note "world fields incl. random index".)

### 1.2 Players — P_ArchivePlayers (p_saveg.c)

Per playing slot, the raw C struct is blob-copied, with psprite states converted to state-table indices:

```c
    PADSAVEP();
    dest = (player_t *)save_p;
    memcpy (dest,&players[i],sizeof(player_t));
    save_p += sizeof(player_t);
    for (j=0 ; j<NUMPSPRITES ; j++)
	if (dest->psprites[j].state)
	    dest->psprites[j].state = (state_t *)(dest->psprites[j].state-states);
```

`PADSAVEP()` = `save_p += (4 - ((int) save_p & 3)) & 3` (p_saveg.c:39, "so that the load/save works on SGI&Gecko"). On `P_UnArchivePlayers` the struct is memcpy'd back and these fields are **nulled, not restored**: `players[i].mo = NULL; players[i].message = NULL; players[i].attacker = NULL;` — `mo` is later re-linked by the thinker pass (`mobj->player->mo = mobj`), and psprite states converted back via `&states[(int)...]`. Everything else (inventory, health, `cmd`, `damagecount`, `bonuscount`, `fixed_t` view vars, `lastlook`) persists as raw struct bytes.

### 1.3 World — P_ArchiveWorld (p_saveg.c)

Only *mutable* world state, as int16 deltas over the WAD defaults — geometry (vertexes/nodes/segs/subsectors) is never touched:

```c
	*put++ = sec->floorheight >> FRACBITS;
	*put++ = sec->ceilingheight >> FRACBITS;
	*put++ = sec->floorpic;
	*put++ = sec->ceilingpic;
	*put++ = sec->lightlevel;
	*put++ = sec->special;		// needed?
	*put++ = sec->tag;		// needed?
    ...
	*put++ = li->flags;
	*put++ = li->special;
	*put++ = li->tag;
	for (j=0 ; j<2 ; j++) {
	    if (li->sidenum[j] == -1) continue;
	    si = &sides[li->sidenum[j]];
	    *put++ = si->textureoffset >> FRACBITS;
	    *put++ = si->rowoffset >> FRACBITS;
	    *put++ = si->toptexture;
	    *put++ = si->bottomtexture;
	    *put++ = si->midtexture;
	}
```

Heights/offsets are stored as **integer map units** (>> FRACBITS, restored with `<< FRACBITS`). On unload `sec->specialdata = 0; sec->soundtarget = 0;` are cleared (thinker-owned fields). Note the fixed 7 + 3 + (2×5) per-entity counts, and the conditional sidedef skip — parsing requires the loaded map's `numsectors`/`numlines`/`sidenum` to know how many bytes to consume.

### 1.4 Thinkers — pointer serialization

**There is no QuotePointer / pointer-tag table in this source tree** (`grep -rn QuotePointer /tmp/DOOM-master` → zero hits; Chocolate Doom's `src/doom/p_saveg.c` likewise has no `SerializePointer`/pointer-tag machinery). The actual mechanism is:

1. A one-byte class tag + 4-byte pad, then a raw `memcpy` of the whole `mobj_t`:
```c
	    *save_p++ = tc_mobj;
	    PADSAVEP();
	    mobj = (mobj_t *)save_p;
	    memcpy (mobj, th, sizeof(*mobj));
	    save_p += sizeof(*mobj);
	    mobj->state = (state_t *)(mobj->state - states);   // state = index
	    if (mobj->player)
		mobj->player = (player_t *)((mobj->player-players) + 1);  // 1-based player index
```
2. Only those two pointer fields are "swizzled" to indices. **All other pointers (`thinker.next/prev`, `subsector`, `target`, `tracer`, `referred`, `sys1`, function pointers) are serialized as raw host addresses** inside the memcpy blob. They are made harmless at load time by *rebuilding, not restoring* (see 1.6). Chocolate Doom keeps this byte layout (`saveg_writep` writes the raw pointer as a 32-bit int, p_saveg.c:187) but overwrites/ignores those fields on read (`str->state = &states[saveg_read32()]`, `str->player = &players[pl-1]`, and `mobj->target = NULL; mobj->tracer = NULL;` in its `P_UnArchiveThinkers`).
3. Terminating `*save_p++ = tc_end;`.

Lost-on-save facts to remember: `mobj->target` is explicitly `NULL`ed on load, and `tracer` survives only as a garbage value that is also overwritten/NULLed (Chocolate) — vanilla leaves whatever the address blob contained. **Our format must serialize target/tracer/lastlook explicitly as indices** (Chocolate's DOOM is equally lossy here; vanilla demos desync across save/load for this reason).

### 1.5 Specials — P_ArchiveSpecials

Second pass over the thinker list; each mover type gets an enum tag (`tc_ceiling=0 … tc_glow=6, tc_endspecials`, p_saveg.c) then a struct blob with the sector pointer swizzled to an index:

```c
	*save_p++ = tc_ceiling;   // also tc_door, tc_floor, tc_plat,
	PADSAVEP();             // tc_flash, tc_strobe, tc_glow
	ceiling = (ceiling_t *)save_p;
	memcpy (ceiling, th, sizeof(*ceiling));
	save_p += sizeof(*ceiling);
	ceiling->sector = (sector_t *)(ceiling->sector - sectors);
```

The ceiling/plat entries additionally check the `activeceilings[]`/`activeplats` lists (tag `tc_ceiling` is also emitted for stopped-but-listed movers with `function.acv == NULL`), so the active-list membership is what gets saved. On unload the active lists are re-populated from the parsed thinkers.

### 1.6 Load order — G_DoLoadGame fixup sequence

```c
    length = M_ReadFile (savename, &savebuffer);
    save_p = savebuffer + SAVESTRINGSIZE;
    sprintf (vcheck,"version %i",VERSION);
    if (strcmp (save_p, vcheck)) return;		// bad version (silent!)
    save_p += VERSIONSIZE;
    gameskill = *save_p++; gameepisode = *save_p++; gamemap = *save_p++;
    for (i=0 ; i<MAXPLAYERS ; i++) playeringame[i] = *save_p++;

    // load a base level
    G_InitNew (gameskill, gameepisode, gamemap);      // full level rebuild

    a = *save_p++; b = *save_p++; c = *save_p++;
    leveltime = (a<<16) + (b<<8) + c;

    P_UnArchivePlayers ();
    P_UnArchiveWorld ();
    P_UnArchiveThinkers ();
    P_UnArchiveSpecials ();

    if (*save_p != 0x1d) I_Error ("Bad savegame");
```

Fixup logic: `G_InitNew` replays `G_DoLoadLevel` (fresh WAD state, `P_SpawnPlayer`, `P_SpawnSpecials`, `M_ClearRandom`) so every array index is meaningful again; then the archive sections *overwrite* the pristine level. `P_UnArchiveThinkers` first frees every existing thinker (`P_RemoveMobj`/`Z_Free`), `P_InitThinkers()`, then for each mobj: `mobj->state = &states[(int)mobj->state]; mobj->target = NULL; mobj->player = &players[(int)mobj->player-1]; mobj->player->mo = mobj; P_SetThingPosition(mobj); mobj->info = &mobjinfo[mobj->type]; mobj->floorz = mobj->subsector->sector->floorheight; mobj->ceilingz = mobj->subsector->sector->ceilingheight; P_AddThinker(...)`. Thinker **ordering is preserved by insertion order** (save order = list order), which matters for tic behavior.

## 2. What is rebuilt, not saved

**Confidence: high** (p_setup.c `P_SetupLevel`, quoted).

`P_SetupLevel` runs before the archive sections and rebuilds everything structural — "note: most of this ordering is important":

```c
    P_LoadBlockMap (lumpnum+ML_BLOCKMAP);
    P_LoadVertexes (lumpnum+ML_VERTEXES);
    P_LoadSectors (lumpnum+ML_SECTORS);
    P_LoadSideDefs (lumpnum+ML_SIDEDEFS);
    P_LoadLineDefs (lumpnum+ML_LINEDEFS);
    P_LoadSubsectors (lumpnum+ML_SSECTORS);
    P_LoadNodes (lumpnum+ML_NODES);
    P_LoadSegs (lumpnum+ML_SEGS);
    rejectmatrix = W_CacheLumpNum (lumpnum+ML_REJECT,PU_LEVEL);
    P_GroupLines ();
    P_LoadThings (lumpnum+ML_THINGS);      // then P_SpawnSpecials()
```

Never serialized: all WAD geometry (vertexes, nodes, segs, subsectors, blockmap — loaded from the BLOCKMAP lump, not generated), REJECT, sidedef defaults and texture *definitions* (only per-side offsets/texture nums are saved), sector tag/special *definitions* (saved only as the mutable copy), THINGS (respawn flags come from the map), `line->specialdata`/`specialdata`, `sector->soundtarget`, `activeceilings/activeplats` contents, subsector pointers (`P_SetThingPosition` recomputes from x/y), `floorz/ceilingz` (re-read from subsector), `mobj->info` (from `type`), all state function pointers, sound state (`S_Stop`/restarted), `bodyqueslot`, `deathmatchstarts`, view/HUD/automap state, palette/colormap, free-response `message`. **Our engine inherits this contract: rebuild nodes/blockmap/subsector lookups at load; only persist mutable deltas.**

## 3. OUR format design (feeds DECISIONS)

**Confidence: medium-high (design recommendation, grounded in §1 failures).**

- **Versioned tagged binary.** Header: magic `"DSV1"`, u32 format version, u32 contentVersion (engine build), then sections, each `u8 sectionId, u32 length` — unknown tags skippable, so future additions don't break old saves. Never blob-dump JS objects; explicit field writers only.
- **Slot-index pointer fixup.** Replace every vanilla pointer with a dense index resolved after full rebuild:
  - thinkers → index into a dense thinker array (save order = linked-list order, preserving tick order);
  - `mobj_t*` fields (`target`, `tracer`, `soundtarget`, `specialdata`, `referred`) → **u32 thinker index, 0 = null** — this *fixes* vanilla, which loses `target`/`tracer` (§1.4);
  - `sector_t*` → u32 sector index (vanilla does this one right);
  - `line_t*` → u32 line index; `player_s*` → u8 player index +1 (vanilla's `+1` trick, kept);
  - `state_t*` → **u16 statenum**, i.e. index into a frozen state table (vanilla `state - states`); never serialize action args.
- **Stream primitives**: fixed-point as i32 raw (keep full fracbits — do NOT repeat vanilla's `>>FRACBITS` height loss unless vanilla-demo parity demands it; for our own saves use i32 fixed), `leveltime` as u32, per-player and per-mobj explicit field lists (no struct padding).
- **Save the PRNG indices**: `prndindex`, `rndindex`, `bodyqueslot`/`iquetail` and `mobj->lastlook` — vanilla resets them (§1.1), a known desync source; for us they must round-trip.
- **IndexedDB keys**: `doom-save-<slot>` (slot 0..9, mirroring vanilla's 10 slots, `doomsav<N>.dsg` equivalent), value `{ meta: {description: 24-byte string, leveltime, episode, map, skill, savedAt}, data: ArrayBuffer }`; settings under `doom-settings`. List/validate via `getAllKeys()`. Write-to-temp-then-rename maps to a single atomic `put()` (IndexedDB transactions give Chocolate's temp-file-rename safety for free).
- **Size estimate method**: `bytes ≈ Σ_players fieldsPlayer + numSectors*7*u16-equiv + numLines*(3 + usedSides*5) + numMobjs*fieldsMobj + numSpecials*fieldsSpecial + header`. Calibrate by instrumenting one real Chocolate/vanilla save: a typical DOOM E1M1 save is ~30-60 KB, cap-equivalent 176 KB (SAVEGAMESIZE). For us: (live mobjs ≈ 300 × ~64 B) + (E1M1: 696 sectors × 14 B + 1542 lines × ~23 B) ≈ **~60 KB/save** — trivial for IndexedDB.
- **Quicksave recommendation**: keep a dedicated `doom-save-quick` slot plus `doom-save-<slot>`; auto-quicksave on level start is a modern addition — recommend exposing it as a settings toggle, defaulting ON (Freedoom target has no vanilla parity constraint on file format).

## 4. Demo format (DOOM 1 .lmp) + sync mechanics

**Confidence: high** (g_game.c quoted in full below; d_event.h read). No savedgame.md or demo-format .md exists in Chocolate Doom's tree — `find /tmp/chocolate-doom-master -name '*.md'` shows only README/NEWS/etc. (README.md:16 claims "Compatibility with the DOS demo, configuration and savegame files"; the format lives in code, `src/doom/g_game.c`).

### 4.1 Header (G_BeginRecording, g_game.c)

```c
    demo_p = demobuffer;
    *demo_p++ = VERSION;          // 110 — playback rejects mismatches
    *demo_p++ = gameskill;
    *demo_p++ = gameepisode;
    *demo_p++ = gamemap;
    *demo_p++ = deathmatch;
    *demo_p++ = respawnparm;
    *demo_p++ = fastparm;
    *demo_p++ = nomonsters;
    *demo_p++ = consoleplayer;
    for (i=0 ; i<MAXPLAYERS ; i++)
	*demo_p++ = playeringame[i];
```

→ 12-byte header, all u8. `G_DoPlayDemo` checks `if (*demo_p++ != VERSION) { "Demo is from a different game version!"; }`. Recording buffer defaults to `0x20000` bytes (`-maxdemo` in KB overrides). End of file: `*demo_p++ = DEMOMARKER;` (`#define DEMOMARKER 0x80`) then `M_WriteFile (demoname, demobuffer, demo_p - demobuffer)`.

### 4.2 Tic stream — 4 bytes per tic, both directions

```c
void G_ReadDemoTiccmd (ticcmd_t* cmd)
{
    if (*demo_p == DEMOMARKER)
    {   G_CheckDemoStatus (); return;   }
    cmd->forwardmove = ((signed char)*demo_p++);
    cmd->sidemove = ((signed char)*demo_p++);
    cmd->angleturn = ((unsigned char)*demo_p++)<<8;
    cmd->buttons = (unsigned char)*demo_p++;
}

void G_WriteDemoTiccmd (ticcmd_t* cmd)
{
    if (gamekeydown['q'])  G_CheckDemoStatus ();   // press q to end recording
    *demo_p++ = cmd->forwardmove;
    *demo_p++ = cmd->sidemove;
    *demo_p++ = (cmd->angleturn+128)>>8;
    *demo_p++ = cmd->buttons;
    demo_p -= 4;
    if (demo_p > demoend - 16)  { G_CheckDemoStatus (); return; }
    G_ReadDemoTiccmd (cmd);         // make SURE it is exactly the same
}
```

Layout per tic: **u8 forwardmove (i8), u8 sidemove (i8), u8 angleturn = high byte of ANGLES (biased +128 on write, `<<8` on read — the 3rd ticcmd byte; the stream is 4 bytes/tic, not 3 — the "3-byte" claim in the task outline is wrong), u8 buttons**. The recorder writes over the reserved 4 bytes each tic (`demo_p -= 4`) so in-game saves can rewind/overwrite the current tic, and immediately re-reads the tic it wrote to guarantee encoder/decoder identity.

**Buttons packing trick** (d_event.h:75-98, g_game.c:425-437, 700-725): bit0 `BT_ATTACK`, plus `BT_SPECIAL = 128`, `BT_SPECIALMASK = 3`, `BTS_PAUSE = 1`, `BTS_SAVEGAME = 2`, `BTS_SAVESHIFT = 2`. In-game special commands ride the same byte:

```c
	cmd->buttons = BT_SPECIAL | BTS_SAVEGAME | (savegameslot<<BTS_SAVESHIFT);
```

and `G_Ticker` unpacks it (`case BTS_SAVEGAME: savegameslot = (buttons & BTS_SAVEMASK)>>BTS_SAVESHIFT; gameaction = ga_savegame;`) — this is how netgames/demos trigger in-game slot saves, and how pause toggles are carried.

### 4.3 Playback loop

There is **no `D_DemoTicker`** in 1.10. Single-demo playback is driven straight from `G_Ticker` (g_game.c:~660):

```c
	    memcpy (cmd, &netcmds[i][buf], sizeof(ticcmd_t));
	    if (demoplayback)
		G_ReadDemoTiccmd (cmd);
	    if (demorecording)
		G_WriteDemoTiccmd (cmd);
```

so every `gametic` consumes exactly one 4-byte tic before `P_Ticker()`. `d_net.c` only supplies the netgame/ticdup path (`ticdup`, `BACKUPTICS`, consistancy); a recorded single-player demo is replayed at 1 tic per game tick with `netgame=false`. `G_CheckDemoStatus` on DEMOMARKER restores single-player flags and `D_AdvanceDemo()`s.

### 4.4 Random-stream parity requirement

m_random.c (verified):

```c
int	rndindex = 0;
int	prndindex = 0;

// Which one is deterministic?
int P_Random (void) { prndindex = (prndindex+1)&0xff; return rndtable[prndindex]; }
int M_Random (void) { rndindex  = (rndindex +1)&0xff; return rndtable[rndindex];  }
void M_ClearRandom (void) { rndindex = prndindex = 0; }
```

Two streams over one 256-byte `rndtable` (note: in this tree **P_Random uses prndindex, M_Random uses rndindex** — opposite of the common lore; quote above is authoritative for linuxdoom-1.10). `G_InitNew` calls `M_ClearRandom()`, so level starts reset both to 0. **Parity rule: replay must call the two streams in identical order and counts as vanilla.** Demos desync if the engine calls P_Random during loading/rendering (anything not tick-driven), or across a save/load, because the streams reset while `leveltime` is restored (§1.1) — our engine must (a) keep P_/M_ streams separate and 256-modular, (b) save/restore both indices (§3), (c) forbid random use outside tick logic.

### 4.5 1.10 demo features/absences

Present: version byte gate, `-file x.lmp` playback of lumps (`W_CacheLumpName(defdemoname)`), `-timedemo` (`singletics`, `I_Error("timed %i gametics in %i realtics")`), `-fastrespawn`/`-nomonsters`/`-respawn`/deathmatch flags in header, `q` key aborts recording. Absent (vs later formats): no gametic/ticdup block (that's the DOS *netdemo* format only), no options/skill deltas mid-stream, no user-space/comment bytes, no checksums, `DEMOMARKER` 0x80 as sole terminator, and a hard dependence on exact PRNG-call parity (no resync mechanism at all).

## 5. Slots / save-load UI

**Confidence: high (m_menu.c read); one correction to the task premise.**

- **10 slots**, `char savegamestrings[10][SAVESTRINGSIZE]` (m_menu.c:132), files `SAVEGAMENAME"%d.dsg"` = `doomsav0..9.dsg`; menu reads the first 24 bytes of each file to draw the slot list (`M_ReadSaveStrings`, m_menu.c:~521).
- F2 = save menu, F3 = load menu (m_menu.c:1548/1554 `case KEY_F2: ... M_SaveGame(0)` / `case KEY_F3: ... M_LoadGame(0)`).
- **Correction: quicksave/quickload DO exist in the released 1.10 source** — `KEY_F6: // Quicksave` → `M_QuickSave()`, `KEY_F9: // Quickload` → `M_QuickLoad()` (m_menu.c:1571-1590), with `quickSaveSlot` semantics (`-1` = none, `-2` = "pick a slot now", `QSPROMPT`/`QLPROMPT` in d_englsh.h:46-47) and netgame in-band save via BTS_SAVEGAME (§4.2). Whether MS-DOS DOOM bound these keys identically is outside our sources — mark *recalled*: community lore says DOS DOOM's F-keys 4-10 were action keys; the code here is unambiguous.
- Our engine: 10 numbered slots in IndexedDB + `doom-save-quick` + optional autosave slot; recommend keeping the F2/F3/F6/F9 mapping.

## 6. Determinism checklist (feeds ARCHITECTURE)

**Confidence: high for vanilla facts (quoted above); high as a requirement list for our engine.**

1. **Fixed-point everywhere**: `FixedMul/FixedDiv` + angle-16 tables reproduce collision/movement byte-exact; FP64 drift desyncs demos within seconds. Keep `>>FRACBITS` rounding semantics (`>>`, truncation toward −∞).
2. **No wall-clock, no `Math.random` in tick code**: vanilla tick input is exactly one 4-byte demo/net tic (§4.3); anything time-based (rushing, interpolation) lives outside `P_Ticker`.
3. **Single PRNG streams**: `P_Random`/`M_Random` as separate 256-entry modular counters (§4.4); every call site must fire in the same order — this includes *not* adding extra calls in loading (vanilla `P_SpawnPlayer` uses `P_Random() % MAXPLAYERS` for `lastlook` in DM, p_mobj.c:506). Save/restore both indices (§1.1 gap).
4. **Thinker order stability**: tick order = linked-list insertion order; in JS use an insertion-ordered `Map<number, Thinker>` keyed by dense id **never re-created from sorting** (Map iteration is insertion-order per spec — safe — but deleting and re-adding a moving thinker must preserve position like vanilla's splice-free relist, or order changes silently). `P_AddThinker` appends to tail; removals keep others' slots.
5. **Iteration-order-only data structures**: no `Object.keys` on numeric-ish keys (integer-keyed objects reorder!) — use `Map`/arrays for thinker lists, sector tagging, active lists (`activeceilings` is an index-ordered array in vanilla).
6. **Rebuild-not-restore geometry** (§2): identical `P_SetupLevel` order so indices in the save stream resolve identically; node traversal in `P_GroupLines`-equivalent must be array-index driven, never hash-order.
7. **Save/load must not perturb state**: vanilla resets `leveltime`-adjacent state via `G_InitNew` before overwriting (`leveltime` then re-restored, Chocolate g_game.c:1634 does it by save/restore around `G_InitNew`); our loader should rebuild, apply, and restore `{leveltime, prndindex, rndindex, bodyqueslot}` verbatim.
8. **Ticcmd quantization**: clamp to ±`MAXPLMOVE` (50) and pack/unpack through the same `(angleturn+128)>>8` / `<<8` lossy path in both record and live input (§4.2) so recorded and replayed cmds are bit-identical.

## Sources

- `/tmp/DOOM-master/linuxdoom-1.10/g_game.c` — G_DoSaveGame (1270), G_DoLoadGame (1201), G_Ticker (~603-730), G_BeginRecording (~1550), G_DoPlayDemo, G_CheckDemoStatus, G_ReadDemoTiccmd (1491), G_WriteDemoTiccmd, DEMOMARKER/SAVEGAMESIZE/SAVESTRINGSIZE/SAVEGAMENAME, VERSION=110 (doomdef.h:33).
- `/tmp/DOOM-master/linuxdoom-1.10/p_saveg.c` — PADSAVEP, P_Archive/UnArchive{Players,World,Thinkers,Specials}, tc_* enums; `grep -rn QuotePointer /tmp/DOOM-master` → no matches (absence verified).
- `/tmp/DOOM-master/linuxdoom-1.10/{m_random.c, p_setup.c, m_menu.c, d_event.h, d_englsh.h, dstrings.h, p_mobj.c, d_net.c}` — PRNG streams, P_SetupLevel order, slot/quick keys/menu, BT_* enums, prompts, lastlook, ticdup path.
- `/tmp/chocolate-doom-master/src/doom/{p_saveg.c,g_game.c}` + repo-wide `*.md` scan (no savedgame/demo format docs; README.md:16) — saveg_read/write primitives incl. `saveg_writep` raw-pointer-as-u32, temp-file rename flow, target/tracer NULLing, header read/write helpers.
- Recalled (not verified locally): DOS-era F-key bindings lore (§5); community descriptions of vanilla savegame fragility.
