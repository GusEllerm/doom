# R10: Audio Research — Sound Lumps, MUS Format, Channel Allocation

> Research for a from-scratch TypeScript recreation of DOOM (Web Audio API, Doom 1 WAD format, Freedoom target).
> Sources: id GPL source `/tmp/DOOM-master/linuxdoom-1.10/`, Chocolate Doom `/tmp/chocolate-doom-master/`, `/tmp/freedoom-0.13.0/freedoom1.wad`.

## Table of Contents
1. [Sound lump format (DS* lumps)](#1-sound-lump-format-ds-lumps)
   - [1.1 Header layout](#11-header-layout)
   - [1.2 Sample data encoding and 0x7F..0x7F wrapping](#12-sample-data-encoding-and-0x7f0x7f-wrapping)
   - [1.3 EMPIRICAL: DS lump stats from freedoom1.wad](#13-empirical-ds-lump-stats-from-freedoom1wad)
2. [sfxinfo table and sound playback path](#2-sfxinfo-table-and-sound-playback-path)
   - [2.1 sfxinfo_t struct and sfx_atomatten enums](#21-sfxinfo_t-struct-and-sfx_atomatten-enums)
   - [2.2 sfxinfo table (transcribed)](#22-sfxinfo-table-transcribed)
   - [2.3 S_StartSound call sites and mixing](#23-s_startsound-call-sites-and-mixing)
   - [2.4 Distance attenuation, panning, priority](#24-distance-attenuation-panning-priority)
3. [MUS format](#3-mus-format)
   - [3.1 Header layout](#31-header-layout)
   - [3.2 Event encoding](#32-event-encoding)
   - [3.3 Channel map (mus_chandata)](#33-channel-map-mus_chandata)
   - [3.4 Tempo and timing](#34-tempo-and-timing)
4. [Decoding pipeline design for us](#4-decoding-pipeline-design-for-us)
5. [Music selection and looping](#5-music-selection-and-looping)
6. [Sound retrigger / priority policy (8-16 channel allocator)](#6-sound-retrigger--priority-policy)
7. [Volume model](#7-volume-model)
8. [Freedoom audio license / attribution](#8-freedoom-audio-license--attribution)
9. [Confidence and sources](#9-confidence-and-sources)

## 1. Sound lump format (DS* lumps)

### 1.1 Header layout

A DS* lump is `[8-byte header][raw 8-bit PCM samples]`. There is **no dedicated header struct** in the id sources — `/tmp/DOOM-master/linuxdoom-1.10/i_sound.c` never parses it; `getsfx()` just skips the first 8 bytes and returns the rest (`i_sound.c:186-249`):

```c
sprintf(name, "ds%s", sfxname);          // i_sound.c:204
...
paddedsize = ((size-8 + (SAMPLECOUNT-1)) / SAMPLECOUNT) * SAMPLECOUNT;  // i_sound.c:231
memcpy(  paddedsfx, sfx, size );
for (i=size ; i<paddedsize+8 ; i++)
    paddedsfx[i] = 128;                  // pad with silence value 128
return (void *) (paddedsfx + 8);         // i_sound.c:248 — data starts at lump offset 8
```

The field layout comes from Chocolate Doom, `/tmp/chocolate-doom-master/src/i_sdlsound.c:745-747` (`CacheSfx` path):

```c
// 16 bit sample rate field, 32 bit length field
samplerate = (data[3] << 8) | data[2];
length = (data[7] << 24) | (data[6] << 16) | (data[5] << 8) | data[4];
```

Verified empirically against freedoom1.wad (see 1.3): bytes 0-1 are a **version/format field, always `0x0003`** in every sampled lump; `lump_length == 8 + sample_count` exactly.

Vanila-DMX quirk: Chocolate additionally *skips the first 16 and last 16 bytes* of every lump ("reason unknown", `i_sdlsound.c:766-768`: `data += 16; length -= 32;` — then passes `data + 8`, i.e. body offset 24), and rejects lumps with `length > lumplen - 8 || length <= 48` (`i_sdlsound.c:758-761`, DMX's ~49-sample cutoff). **For our implementation follow linuxdoom: header = 8 bytes, body = bytes [8, lumpLen); skip the DMX 16/16 trim** — freedoom lumps start their (silent, 0x80-padded) data at offset 8 (verified: bytes 8-15 are `80 80 80 ...` in 11 of the 69 lumps and near-silence elsewhere).

### 1.2 Sample data encoding and 0x7F..0x7F wrapping

**Verified answer to the prior uncertainty: there is NO 0x7F marker escaping/wrapping in the vanilla data path.** The complete decoding in `/tmp/DOOM-master/linuxdoom-1.10/i_sound.c` is the `getsfx()` memcpy+pad shown above (lines 229-248); a grep for `0x7f`/`127` in that file hits only `0x7fff` output-clipping in the 16-bit mixer (`i_sound.c:617-626`), never sample-stream decoding. The mixer consumes the bytes directly as unsigned 8-bit indices into `channelleftvol_lookup[]`. Chocolate likewise feeds the raw bytes to an `AUDIO_U8` conversion (`i_sdlsound.c:637`: `SDL_BuildAudioCVT(&convertor, AUDIO_U8, 1, samplerate, ...)`).

Empirical confirmation on freedoom1.wad: byte histograms of DS bodies are smooth and full-range (DSPISTOL: min 0, max 255; top bytes 0x80=698, 0x7F=591, 0x7E=469 — a bell around the 128 silence point, not repeated marker runs). 0x7F is simply a common *value*, not an escape byte.

Encoding: **unsigned 8-bit linear PCM, mono, center = 128, range 0..255**, no compression.

Conversion recipe to Float32 for WebAudio:

```
n = AudioContext.sampleRate / headerRate
out[i] = (pcm8[Math.floor(i * n)] - 128) / 128     // naive zero-order hold
// better: linear interpolate between pcm8[f] and pcm8[f+1], t = i*n - f
// silence pad: 128 -> 0.0f; DMX quirk: drop lumps with sample_count <= 48
```

(Chocolate's naive resampler for non-power-of-2 ratios, `i_sdlsound.c:662-680`, uses a fixed-point `expand_ratio = (length << 8) / expanded_length` — same math as the recipe. Optional anti-alias low-pass at `fs/2` of the source, `i_sdlsound.c:682+` `LOW_PASS_FILTER`.)

### 1.3 EMPIRICAL: DS lump stats from freedoom1.wad

Parsed `/tmp/freedoom-0.13.0/freedoom1.wad` (IWAD, 3163 lumps) with a script in `/tmp`:

- **Total DS* lumps: 69** (non-empty), total 1,405,435 bytes (~1.4 MB, 0.34 s at CD rate as raw bytes... i.e. tiny).
- Format field: `0x0003` in 69/69.
- **Sample rates: 22050 Hz ×44, 11025 Hz ×22, 16000 Hz ×1, 17990 Hz ×1, 44100 Hz ×1** — we must support arbitrary rates, not just 11025.
- `lump_length == 8 + sample_count` holds for all 69.
- Examples: DSPISTOL 22050 Hz / 11026 samples (0.50 s); DSSHOTGN 11025 Hz / 11191 samples (1.02 s); DSSGCOCK 11025 Hz / 5108 samples (0.46 s); min lump 2,213 B, max 110,488 B (≈2.5 s).

**Confidence §1: high.** Header layout, no-0x7F-wrapping, and stats verified directly in `i_sound.c`/`i_sdlsound.c` + parsed empirically from freedoom1.wad (69/69 lumps consistent). Note: `/tmp/DOOM-master/linuxdoom-1.10/s_sound.c` *does* exist (contrary to the "if absent" hint); DMX internals (16/16 skip) remain "reason unknown" even in Chocolate.

## 2. sfxinfo table and sound playback path

### 2.1 sfxinfo_t struct and sfx_* atten enums

Struct from `/tmp/DOOM-master/linuxdoom-1.10/sounds.h:32-62`:

```c
struct sfxinfo_struct
{
    char*       name;        // up to 6-character name (DS lump = "ds"+name)
    int         singularity; // Sfx singularity (only one at a time)
    int         priority;    // Sfx priority
    sfxinfo_t*  link;        // referenced sound if a link
    int         pitch;       // pitch if a link
    int         volume;      // volume if a link
    void*       data;
    int         usefulness;  // cache aging (0=decrement, -1=evict, >0=in use)
    int         lumpnum;
};
```

Chocolate (`/tmp/chocolate-doom-master/src/doom/sounds.c:112-114`) uses the same info as macros:
`SOUND(name,priority) = {NULL,name,priority,NULL,-1,-1,...}` and `SOUND_LINK(name,priority,link_id,pitch,volume)`.

Key corrections to assumptions:
- **There is no per-sfx volume enum in Doom.** `volume` is only set on *linked* entries (e.g. `chgun` links to `pistol` with pitch 150, volume 0). Normal sounds play at the global default; `NORM_VOLUME = snd_MaxVolume`, `NORM_PITCH = 128`, `NORM_SEP = 128`, `NORM_PRIORITY 64` (`linuxdoom s_sound.c:67-69`, `chocolate s_sound.c:60-61`).
- **There is no ATTN_* enum in Doom** (ATTN_NONE/NORM/IDLE/STATIC is Heretic/Hexen; grep found nothing in Doom's s_sound.h). Doom's per-sound “attenuation” is *only* the distance formula in 2.4.
- **No `channel` column** — the table carries no channel assignment; channels are allocated at runtime (2.4).

### 2.2 sfxinfo table (transcribed)

From `/tmp/chocolate-doom-master/src/doom/sounds.c:116-224` (identical priorities in `/tmp/DOOM-master/linuxdoom-1.10/sounds.c:114+`, where rows look like `{ "pistol", false, 64, 0, -1, -1, 0 }` — `singularity` is false for every row and never acted upon except hardcoded in `i_sound.c addsfx`). Format: **index | name (→ lump DS*name) | priority | pitch/volume only if linked**. DS lump = `"DS" + name` uppercased.

0 none p0 · 1 pistol p64 · 2 shotgn 64 · 3 sgcock 64 · 4 dshtgn 64 · 5 dbopn 64 · 6 dbcls 64 · 7 dbload 64 · 8 plasma 64 · 9 bfg 64 · 10 sawup 64 · 11 sawidl 118 · 12 sawful 64 · 13 sawhit 64 · 14 rlaunc 64 · 15 rxplod 70 · 16 firsht 70 · 17 firxpl 70 · 18 pstart 100 · 19 pstop 100 · 20 doropn 100 · 21 dorcls 100 · 22 stnmov 119 · 23 swtchn 78 · 24 swtchx 78 · 25 plpain 96 · 26 dmpain 96 · 27 popain 96 · 28 vipain 96 · 29 mnpain 96 · 30 pepain 96 · 31 slop 78 · 32 itemup 78 · 33 wpnup 78 · 34 oof 96 · 35 telept 32 · 36 posit1 98 · 37 posit2 98 · 38 posit3 98 · 39 bgsit1 98 · 40 bgsit2 98 · 41 sgtsit 98 · 42 cacsit 98 · 43 brssit 94 · 44 cybsit 92 · 45 spisit 90 · 46 bspsit 90 · 47 kntsit 90 · 48 vilsit 90 · 49 mansit 90 · 50 pesit 90 · 51 sklatk 70 · 52 sgtatk 70 · 53 skepch 70 · 54 vilatk 70 · 55 claw 70 · 56 skeswg 70 · 57 pldeth 32 · 58 pdiehi 32 · 59 podth1 70 · 60 podth2 70 · 61 podth3 70 · 62 bgdth1 70 · 63 bgdth2 70 · 64 sgtdth 70 · 65 cacdth 70 · 66 skldth 70 · 67 brsdth 32 · 68 cybdth 32 · 69 spidth 32 · 70 bspdth 32 · 71 vildth 32 · 72 kntdth 32 · 73 pedth 32 · 74 skedth 32 · 75 posact 120 · 76 bgact 120 · 77 dmact 120 · 78 bspact 100 · 79 bspwlk 100 · 80 vilact 100 · 81 noway 78 · 82 barexp 60 · 83 punch 64 · 84 hoof 70 · 85 metal 70 · **86 chgun p64 → link sfx_pistol, pitch 150, volume 0** · 87 tink 60 · 88 bdopn 100 · 89 bdcls 100 · 90 itmbk 100 · 91 flame 32 · 92 flamst 32 · 93 getpow 60 · 94 bospit 70 · 95 boscub 70 · 96 bossit 70 · 97 bospn 70 · 98 bosdth 70 · 99 manatk 70 · 100 mandth 70 · 101 sssit 70 · 102 ssdth 70 · 103 keenpn 70 · 104 keendt 70 · 105 skeact 70 · 106 skesit 70 · 107 skeatk 70 · 108 radio 60.

(Indices 88-108 are DOOM II sfx; the Doom 1 / freedoom1 table uses 0-87. Only linked row in the whole table is 86 `chgun`.)

### 2.3 S_StartSound call sites

Counted in `/tmp/DOOM-master/linuxdoom-1.10/*.c` (~150 calls, `S_StartSound(target, sfx_id)`), by category:
- **Enemy attack/act/death**: `p_enemy.c` 35 (sit/attack/death/pain sfx per mobj via `A_Look`/`A_Chase`/`A_PosAttack` etc.)
- **Menu/UI**: `m_menu.c` 30 (sfx_swtchn/sfx_swtchx), `wi_stuff.c` 24 (intermission: sfx_swtchx, keendt…), `hu_stuff.c` 2 (sfx_itemup)
- **Doors/plats/ceilings**: `p_doors.c` 20 (doropn/dorcls/bdopn/bdcls), `p_plats.c` 10, `p_ceilng.c` 4, `p_floor.c` 2, `p_switch.c` 3 (sfx_swtchx/stnmov via `P_ChangeTag`)
- **Weapons/player**: `p_pspr.c` 10 (firing, cockpit/noway), `p_user.c` 0 (weapon fire sfx comes via `A_FireProjectile`/`P_SpawnMissile` in p_enemy.c and pspr fire functions; `p_mobj.c` 7 = missile launch/explosion like firsht/rxplod)
- **Pickups/events**: `p_inter.c` 2 (itemup/wpnup), `p_map.c` 1 (barexp/hoof via P_CheckMissileRange/blast), `p_spec.c` 1 (sfx_pstart via specials), `p_telept.c` 2 (telept)
- **Demo/game flow**: `g_game.c` 1 (sfx_swtchx), `f_finale.c` 4 (bospit/bosdth etc.), `s_sound.c` 6 internal (e.g. S_StartSoundAtVolume default).

Implication for us: sound triggers must be **level/game-state-driven via mobj-origin** (world position matters) — every call goes through `S_StartSound(mobj_t* origin, int sfx_id)`.

### 2.4 Distance attenuation, panning, priority (channel allocator reference)

All from `/tmp/chocolate-doom-master/src/doom/s_sound.c` (linuxdoom `s_sound.c` is equivalent; same formulas, `s_sound.c:755-815`):

**Distance** (Chebyshev-ish approx, `S_AdjustSoundParams`, chocolate s_sound.c:359-362; constants :43-55 `S_CLIPPING_DIST = 1200*FRACUNIT`, `S_CLOSE_DIST = 200*FRACUNIT`, `S_ATTENUATOR = (CLIPPING-CLOSE)>>FRACBITS`):

```c
approx_dist = adx + ady - ((adx < ady ? adx : ady)>>1);   // ≈ Euclidean, GG p.428
// clip: if (gamemap != 8 && approx_dist > S_CLIPPING_DIST) return 0;  // inaudible
// audible range, normal maps:
*vol = (snd_SfxVolume * ((S_CLIPPING_DIST - approx_dist)>>FRACBITS)) / S_ATTENUATOR;
// close range (dist < 200 units): *vol = snd_SfxVolume (max, 0..127 from 0..15 *8)
// E1M8 exception: *vol = 15 + ((snd_SfxVolume-15)*(CLIP-dist>>FRACBITS)) / S_ATTENUATOR
```

Linear falloff from max volume at 200 map units to 0 at 1200 units; nothing beyond 1200 (except the softer E1M8 ramp).

**Stereo pan** (chocolate s_sound.c:383-385):

```c
angle = R_PointToAngle2(listener->x, listener->y, source->x, source->y) - listener->angle;
*sep = 128 - (FixedMul(S_STEREO_SWING, finesine[angle]) >> FRACBITS);  // S_STEREO_SWING = 96*FRACUNIT
```

`sep` 0..256, 128 = center; left vol ≈ vol*(256-sep)/256, right ≈ vol*sep/256 (see linuxdoom `i_sound.c addsfx` call). If source coincides with listener: `sep = NORM_SEP = 128`. In WebAudio: equal-power pan `sqrt` of angle-based sine — identical math.

**Channel allocation / priority** (`S_GetChannel`, chocolate doom/s_sound.c:285-335) — our reference allocator:

```c
typedef struct { sfxinfo_t *sfxinfo; mobj_t *origin; int handle; int pitch; } channel_t;
static channel_t *channels;  int snd_channels = 8;   // :106
```

Algorithm: (1) scan 8 channels for a free one, **but if a channel is occupied by the *same origin mobj*, stop there and steal it** (one sound per mobj — this is Doom’s “singularity” in practice); (2) if none free, scan for a channel whose `sfxinfo->priority >= new priority` — if all are lower priority, kick out the first lower-priority one; (3) if no lower priority found → `return -1` (sound dropped, “Sorry, Charlie”). Priorities come from the table (2.2): gunshots 64 < monster sounds 90-120 < stnmov 119 — so movement/door loops outrank your own firing.

**Vanilla-DMX specifics vs our implementation**: (a) linuxdoom `i_sound.c addsfx` also hardcodes mutual exclusion for sawup/sawidl/sawful/sawhit/stnmov/pistol (`i_sound.c:281-303`) and evicts by *oldest gametic among lowest priority* (`channelcounts[]`) — Chocolate's simpler origin+kick-out above is the better emulation target; (b) vanilla `usefulness` cache aging / `S_stopLastSound`-style eviction we replace by pre-decoded AudioBuffers; (c) vanilla mixes 8 channels into a 16-bit stereo buffer at ~11 kHz with 128-entry volume lookup tables and 127-clipping — we do this natively in WebAudio with `AudioBufferSourceNode` per sound, playbackRate = pitch/128 · lumpRate/contextRate (`NORM_PITCH = 128`; saw sounds get ±8 random pitch jitter, `linuxdoom s_sound.c:324-333`); (d) the DMX 16/16-byte skip + 48-sample cutoff is emulation trivia we skip (see 1.1).

**Confidence §2: high** for struct, table (verbatim), formulas, and S_GetChannel (all quoted from source). **Medium** for the exact left/right volume split from `sep` (recalled from `addsfx` call pattern, not re-quoted) and for per-category call-site counts (grep counts exact, category attribution partly inferred from file names).

## 3. MUS format

**Headline empirical finding (verified, this session): freedoom1.wad contains ZERO MUS lumps.** All 41 `D_*` lumps are Standard MIDI Files (raw `MThd`, not RIFF-wrapped). Counts by magic bytes of first 3–4 bytes of every `D_*` lump in `/tmp/freedoom-0.13.0/freedoom1.wad` (3163 lumps total):

| Format magic | Count | Notes |
|---|---|---|
| `4D 55 53` ("MUS") | **0** | none |
| `52 49 46 46` ("RIFF" CRMF) | **0** | none |
| `4D 54 68 64` ("MThd") | **41** | all D_E1M1..D_E4M9, D_INTER, D_INTRO, D_INTROA, D_VICTOR, D_BUNNY |

So for a Freedoom target we must implement an **SMF player**; the MUS decoder is only needed for vanilla/doom.wad compatibility (or can be dropped entirely — decision input for DECISIONS.md).

### 3.1 Header layout

**Empirical — first 16 bytes of `D_E1M1` in freedoom1.wad** (lump offset 12322996):

```
4D 54 68 64 00 00 00 06 00 01 00 12 00 60 4D 54
M  T  h  d  <len=6>    fmt=1  ntrk=18 div=96  M  T(rk)
```

i.e. a plain SMF **format 1** header: 18 tracks, division 96 ticks/quarter-note, then immediately the first `MTrk` chunk. No MUS magic anywhere.

For comparison, the MUS header we would parse for vanilla WADs — from `/tmp/chocolate-doom-master/src/mus2mid.c` L56–65 (struct) and L488–491 (magic check `M U S 0x1A`):

```
offset  size  field
0       4     id  = 'M','U','S',0x1A
4       2     scorelength        (big-endian, SHORT()ed)
6       2     scorestart         (offset of event data)
8       2     primarychannels    (bitmask, 13 melodic channels)
10      2     secondarychannels  (bitmask, 3 rhythm channels)
12      2     instrumentcount    (static instruments: follow with 32*count bytes)
```

`MUS` files are self-contained; the DMX spec (and i_oplmusic's static-instrument fallback) supplies 140 built-in instruments when count=0. [verified: mus2mid.c L416–434, L488–491]

### 3.2 Event encoding

MUS event stream begins at `scorestart`. Event chunks: a run of events, each an **event descriptor byte** followed by params; descriptor bit layout (from mus2mid.c L524–525: `channel = eventdescriptor & 0x0F`, `event = eventdescriptor & 0x70`, and L636–638: `if (eventdescriptor & 0x80) break;` — the 0x80 bit marks the *last event in the chunk*):

```
bit 7      : 1 = last event in this chunk (next bytes are the time delta)
bits 6-4   : event type (musevent enum, mus2mid.c L34–41)
bits 3-0   : MUS channel number 0..15 (15 = percussion)
```

| Code | Event (enum in mus2mid.c L34–41) | Params after descriptor |
|---|---|---|
| 0x00 | `mus_releasekey` | 1 byte: key |
| 0x10 | `mus_presskey` | 1 byte key; **if key & 0x80**, a 2nd byte = explicit velocity (masked `&0x7F`, cached per channel); else use cached channel velocity (default 127) — mus2mid.c L542–559 |
| 0x20 | `mus_pitchwheel` | 1 byte v → MIDI wheel = `v * 64` (L566–572) |
| 0x30 | `mus_systemevent` | 1 byte controller nr (only 10..14 valid, else file error) → valueless CC via `controller_map` (L579–594) |
| 0x40 | `mus_changecontroller` | 1 byte ctrl, 1 byte value; ctrl 0 = program change, ctrl 1..9 → valued CC via `controller_map`; ctrl>9 = error (L597–625) |
| 0x60 | `mus_scoreend` | no params, ends the score (L627–629) |

(0x50/0x70 are unused/invalid — `default: return true` in the switch.)

**Delta-time chain**: after the chunk's last descriptor (bit 7 set), the delay is a **7-bit big-endian chain**: `timedelay = timedelay * 128 + (b & 0x7F)` for each byte until one has high bit **clear** (mus2mid.c L643–656). Deltas accumulate in `queuedtime` and are emitted as MIDI variable-length deltas. Note there is NO delta before events inside a chunk — events in one chunk are simultaneous.

MUS→MIDI controller map (`controller_map[]`, mus2mid.c L94–97): MUS ctrl index → MIDI CC number:

```
index: 0x00 0x01 0x02 0x03 0x04 0x05 0x06 0x07 0x08 0x09 0x0A 0x0B 0x0C 0x0D 0x0E
MIDI:  0x00 0x20 0x01 0x07 0x0A 0x0B 0x5B 0x5D 0x40 0x43 0x78 0x7B 0x7E 0x7F 0x79
(0=bank, 1=bank-select CC32(0x20), 2=CC1 mod, 3=CC7 volume, 4=CC10 pan,
 5=CC11 expression, 6=CC91 reverb, 7=CC93 chorus, 8=CC64 sustain,
 9=CC67 porta, 10=CC120 sound1, 11=CC123 all-off, 12=CC126 solo on,
 13=CC127 solo off, 14=CC121 reset — 10..14 arrive via mus_systemevent)
```

**Channel map** (mus2mid.c L387–413 `GetMIDIChannel`): MUS ch 15 → MIDI ch 9 (percussion); MUS ch 0–14 get dynamically allocated sequential MIDI channels 0..15 skipping 9, first use emits CC 0x7B "all notes off" (the "D_DDTBLU disease" fix). In practice with 16 MUS channels → 1:1 onto MIDI 0–8,10–15 + 9 for rhythm.

### 3.3 Channel map (mus_chandata)

For OPL playback Chocolate keeps a static-instrument table in `i_oplmusic.c` (fallback instruments when a MUS declares 0 instruments; `mus_chandata`/`static_instr_info`, L341+ region); each channel also carries control state (volume CC, pan, bend range). Not needed for a MIDI-renderer approach; cited only as behavior reference. [confidence: source present at /tmp/chocolate-doom-master/src/i_oplmusic.c, transcribed partially]

### 3.4 Tempo and timing

- MUS has **no tempo field**: 140 ticks per second, fixed. Verified indirectly in Chocolate: MUS converted to SMF gets resolution **70** (`0x00,0x46` in `midiheader[]`, mus2mid.c L74) and **no tempo meta event is emitted**; the player default is `us_per_beat = 500 * 1000` (120 BPM, i_oplmusic.c L1501) → 70 ticks / 0.5 s = **140 ticks/s**. So MUS tick = 1/140 s ≈ 7.14 ms. [verified]
- Pitch note value: mus2mid writes `key & 0x7F` directly (L160–166). The DMX MUS spec says note = keybyte **+12**; mus2mid does not add it — a known discrepancy to test when/if we ever decode a real MUS. [medium confidence]
- Looping: MUS has no loop marker; i_oplmusic loops the event stream from the beginning (restart after `mus_scoreend` / `I_PlaySong(loop=true)`).

### 3.5 SMF (MIDI) empirical parse of freedoom1.wad

All 41 `D_*` lumps (parsed this session with python3, walking MThd/MTrk chunks):

- **Format: every lump is SMF format 1** (multi-track: conductor/tempo track + one track per part).
- **All 41 contain `FF 51` set-tempo meta events** (tempo changes are inside tracks, not a header field — SMF has no header tempo).
- Division (ticks/quarter-note) histogram: **96** ×28, **480** ×8, **960** ×3, **600** ×1 (D_E1M5), **32** ×1 (D_E4M3). Track counts range 1–19 (e.g. D_E1M1: 18 tracks, div 96; D_E4M3: 1 track, div 32).
- Channel 9 percussion, GS/XG bank-select CC0/CC32 usage is expected in these files (Freedoom tracks are authored for hardware/GM synths; e.g. fluidsynth/timidity playback). [verified for structure; patch-map expectations: recalled]
- Parsing implication: we need delta-varlen parsing (high-bit-continued, same 128-multiplier idiom as MUS), running status, meta events FF 51 (tempo), FF 2F (end of track), FF 58 (time sig — present), FF 59/51 optional, and sysex (F0/F7) skip.

## 4. Decoding pipeline design for us

Proposal (input for DECISIONS.md). Principle: **deterministic decode at load time into one unified in-memory event list**, so the runtime is format-agnostic (MUS from vanilla WADs or SMF from Freedoom both funnel into the same stream).

1. **Decoder stage** (pure function, runs once per lump at `loadMap`):
   - SMF path (needed for Freedoom): parse MThd (accept format 0/1/2 — merge multiple tracks into one timeline by summing per-track tick positions with the shared division), walk MTrk events: varlen delta → tick, channel events with running status, meta FF 51 (tempo: microseconds/quarter → converts ticks→seconds via `seconds += deltaTicks/div * usPerQuarter/1e6`), FF 2F ends a track.
   - MUS path (optional, vanilla compat): per §3.2/§3.4 — chunk/delta decode, per-chunk velocity cache, mus→midi channel table, fixed 140 ticks/s, ctrl via `controller_map`.
   - Output event: `{ t: seconds, ch: 0..15, type: noteOn|noteOff|cc|program|pitchBend|tempo|end, data1, data2 }`, sorted by `t`. No async, no AudioContext dependency → fully unit-testable and reproducible.
2. **Voice layer (WebAudio)**. Recommended: **subtractive-lite, not OPL-FM** — our target assets render fine on any GM synth; a 2-op FM per melodic voice is the stretch goal. Baseline per melodic channel: one shared `GainNode` chain per MIDI channel `voice → chGain → chPanner → musicBus`; voice = `OscillatorNode` selected by GM patch family (square/saw for leads, triangle for bass/organ pads, detuned 2-osc for strings/polysynth) + AD(SR) envelope (`linearRampToValueAtTime` attack ~5 ms, exponential decay to sustain) approximating OPL/ADSR behavior. Drums (ch 9): noise buffer (white, pre-baked) with bandpass + fast decay for cymbal/hat, short lowpassed noise + sine pitch-drop for kick, mid-noise burst for snare — 4 archetypes keyed by GM drum note number ranges.
3. **Scheduling**: lookahead scheduler in the audio-render tick — every ~25 ms (or via `AudioWorklet` timer) push all events with `t < ctx.currentTime + 0.1` using `start(at)`/`setValueAtTime` for sample-accurate timing; never schedule from `setTimeout` alone without lookahead. One `AudioContext` shared with SFX; music events scheduled on `ctx.currentTime` clock, game-pause = stop scheduling + `suspend()` of music nodes (SUSPEND music voices, keep SFX ctx running).
4. **Mixing topology / volume**: `musicBus → musicGain → destination`, `musicGain.gain = musicVolumeCurve(snd_MusicVolume)` (§7), updated live from the options menu — mirrors vanilla `S_SetMusicVolume` (s_sound.c L616–628 sets one global music volume). SFX get their own bus (§6) so ducks/meters are independent.
5. **Channel state**: per MIDI channel keep `{patch, volume(CC7), pan(CC10), expression(CC11), pitchBendRange, notes: Map<pitch, voiceRef>}`; note-on with velocity 0 = note-off (SMF convention). Mono-per-channel is wrong for format-1 parts — allow polyphonic voices per channel, capped by the global pool (§6 budget: music and SFX get separate pools; music cap 32 voices, LRU steal per channel).
6. **Looping**: on `end` event, reschedule a restart at `endT + loopGap` (§5) rather than re-decoding; keep the sorted event list alive on the `Music` object.

Open decisions for DECISIONS.md: (a) ship MUS decoder or SMF-only (Freedoom-only target argues SMF-only); (b) FM vs subtractive voices; (c) GS/XG CC0 bank handling — recommend ignoring banks and mapping patch numbers straight to our synth families.

## 5. Music selection and looping

**Lump naming rule** — vanilla resolves the music index to a lump by prefixing `d_` to the 6-char song name, `/tmp/DOOM-master/linuxdoom-1.10/s_sound.c` (`S_ChangeMusic`, L673–677):

```c
    // get lumpnum if neccessary
    if (!music->lumpnum)
    {
	sprintf(namebuf, "d_%s", music->name);
	music->lumpnum = W_GetNumForName(namebuf);
    }
```

with names in `S_music[]` (`/tmp/DOOM-master/linuxdoom-1.10/sounds.c` L36+: `{ "e1m1", 0 }, { "e1m2", 0 }, … { "inter" }, { "intro" }, { "bunny" }, { "victor" }, { "introa" }, plus DOOM-II-only "runnin"…"romero"), i.e. lump `D_E1M1` etc. (WAD names are case-insensitive/uppercase-stored). [verified]

**Map → song rule** (`S_Start` in s_sound.c, L217–238): commercial mode `mnum = mus_runnin + gamemap - 1`; episode mode:

```c
    if (gameepisode < 4)
      mnum = mus_e1m1 + (gameepisode-1)*9 + gamemap-1;
    else
      mnum = spmus[gamemap-1];
```

where `spmus[]` remaps Episode 4 (SIGIL) to existing songs (e4m1→mus_e3m4 "American", e4m2→e3m2, e3m3, e1m5, e2m7, e2m4, e2m6, e2m5, e1m9 — s_sound.c L222–233). Then `S_ChangeMusic(mnum, true)` — **in-level music always loops** (L244). Finale/inter music: `S_ChangeMusic(mus_victor, true)` (f_finale.c L114, loops) but `S_StartMusic(mus_bunny)` / `S_StartMusic(mus_intro)` → `S_ChangeMusic(m_id, false)` (s_sound.c L644–647) — **one-shot**. Non-looping means SMF players must self-loop format-1 files at end-of-last-track for level music (vanilla MUS ports restart the stream; for our SMF renderer: restart at first tick on `FF 2F` of all tracks).

**Empirical `D_*` inventory of freedoom1.wad** (from the WAD directory, this session — 41 lumps): `D_E1M1…D_E1M9`, `D_E2M1…D_E2M9`, `D_E3M1…D_E3M9`, **`D_E4M1…D_E4M9` (E4 tracks exist as real audio — no spmus remap needed for Freedoom, though we should still implement the remap for vanilla WADs where they're absent)**, plus `D_INTER` (intermission), `D_INTRO`, `D_INTROA` (alt intro for -file?), `D_VICTOR` (episode 1–3 victory), `D_BUNNY` (Kilroy). All 41 verified as SMF (see §3.5). Freedoom2.wad would additionally need the DOOM-II song names, not in scope here.

Implementation note: look up `D_` + uppercase map name first (matches WAD naming), fall back to the `S_music` index table + spmus remap for non-standard maps; if the lump is missing, no music (vanilla `W_GetNumForName` errors — we should warn-and-silence).

## 6. Sound retrigger / priority policy

**Vanilla behavior (ground truth, verified in `/tmp/DOOM-master/linuxdoom-1.10/s_sound.c`)**:

- Fixed pool of `numChannels` mixing channels (8 in vanilla DOS; the Linux port takes it from `I_InitSound`; `S_Start()` kills all channels at level start, L208–211).
- Allocation (`S_allocChannel`, L837–864): first, any free channel; **else any channel playing a sound from the same `origin` is stopped and reused** — vanilla's core retrigger rule is *one sound per source object, latest wins*. Only if neither exists: scan for a channel whose `sfxinfo->priority >= new sfxinfo->priority` and kill it (“Otherwise, kick out lower priority”), else `return -1` (“F!CK! No lower priority. Sorry, Charlie.”).
- Lower `priority` value = higher precedence (vanilla sfxinfo table order; player武器/feedback sounds lowest). No age term at all in vanilla.

**Recommendation for us (16-voice SFX pool)**:

1. Pool of 16 voices, separate from the music voice pool (§4) so music never steals SFX.
2. Allocation order: free voice → same-origin voice (stop, reuse — preserves vanilla's per-monster masking) → **victim selection = lowest class, then oldest**: rank = (priorityClass, startedAt); evict the max-rank voice whose class is worse (numerically larger) than the new sound's; never evict a same-or-higher class — drop the new sound instead (vanilla “Sorry, Charlie”).
3. **Priority by volume-class heuristic** (since Freedoom's sfxinfo priority column is mostly 64/127 noise): player weapon feedback & menu = class 0, player pain/item pickup = 1, enemy attack sounds = 2, monster sight/alert = 3, impact/spatial ambience = 4, looping drone sounds = 5 (looping: never evicted by non-looping, stopped by same-origin only). Keeps important close sounds audible under firefights without a full rewrite.
4. **Retrigger rules**: same sfx from same origin retriggering within `max(sampleDur, 1 tic)` restarts the voice (vanilla latest-wins); same sfx id from *different* origins gets a fresh voice (up to pool cap) with ±small random detune forbidden (vanilla has no random pitch except `S_sfx[].pitch` link shifts — keep deterministic); identical sound from same origin while playing = restart in place (no double-trigger). Same-sfx-different-origin beyond ~3 simultaneous instances: reuse oldest instance of that id (combats machine-gun phasing and voice starvation).
5. Voice-steal must be sample-accurate: stop old source with `stop(now)`, start new at `now` — no gaps or clicks (2 ms fade-out on steal).

## 7. Volume model

**Verified vanilla facts:**

- The UI volume is an integer **0–15** per stream. Menu adjust code (`/tmp/DOOM-master/linuxdoom-1.10/m_menu.c` L821–826 pattern, identical for both):

  ```c
  	if (snd_SfxVolume)
  	    snd_SfxVolume--;
      ...
  	if (snd_SfxVolume < 15)
  	    snd_SfxVolume++;
  ```

- Default values differ by source lineage — **both verified**:
  - Linux GPL source `/tmp/DOOM-master/linuxdoom-1.10/s_sound.c` L113/L116: `int snd_SfxVolume = 15;` and `int snd_MusicVolume = 15;` (“maximum volume for sound/music”, doomstat.h L109–110).
  - Chocolate Doom `/tmp/chocolate-doom-master/src/doom/s_sound.c` L86/L90: `int sfxVolume = 8;` / `int musicVolume = 8;` (what vanilla default.cfg shipped is debated; Chocolate is the maintained reference — treat 8 as “default-ish”, 15 as menu-max).
- Internals scale to MIDI/PCM 0–127 space: `S_SetMusicVolume`/`S_SetSfxVolume` validate `volume < 0 || volume > 127` (linuxdoom s_sound.c L616–637), i.e. the engine keeps an extended range; menu only reaches 0–15. Music sets one global driver volume (`I_SetMusicVolume(volume)`), mirroring our single `musicGain` node (§4).

**Proposed mapping 0–15 → WebAudio gain** (input for DECISIONS.md): perceptual curve, not linear — equal-loudness steps feel linear to the ear. Recommend **quadratic-in-normalized**: `gain = (v/15)^2` (v=15→1.0, v=8→0.284, v=1→0.0044, v=0→0) — equivalently ~ -1.76 dB per step. Alternative cited by other ports: `gain = v == 0 ? 0 : 10^((v-15)*2.0/20)` (constant 2 dB/step; v=8→0.50). Recommend the quadratic one for music (music at 8/15 should sit clearly under gameplay SFX, matching the 8/15-era mix everyone knows), with a global trim constant tuned to taste, and apply `setTargetAtTime` on the GainNode to avoid zipper noise. Per-SFX distance attenuation stays per §2.4 (other agent's scope); master sfxGain uses the same curve.

## 8. Freedoom audio license / attribution

Exact lines shipped in `/tmp/freedoom-0.13.0/` (all verified present):

`COPYING.txt` (whole-archive license — BSD-style):

> Copyright © 2001-2024
> Contributors to the Freedoom project.  All rights reserved.
>
> Redistribution and use in source and binary forms, with or without
> modification, are permitted provided that the following conditions are met:
>
>   * Redistributions of source code must retain the above copyright
>     notice, this list of conditions and the following disclaimer.
>   * Redistributions in binary form must reproduce the above copyright
>     notice, this list of conditions and the following disclaimer in the
>     documentation and/or other materials provided with the distribution.

(`THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS”…` disclaimer follows, L17–20.)

`CREDITS.txt` (per-contributor; the audio-relevant lines):

> [See the CREDITS-MUSIC file for specific track authors and titles.]

plus ~30 `D:` contribution lines tagged `music` / `musics` / `sounds` under named contributors, e.g. `N: Colin Phipps … D: binary lumps (playpal, colormap etc)`, `D: textures, music`, `D: graphics, sounds, flats, sprites`, `D: musics, PC speaker sounds` (CREDITS.txt is 1030 lines; grep 'D:.*music\|D:.*sounds' yields the attribution set).

**`CREDITS-MUSIC.txt` exists (205 lines) and is the required music-credit file** — it maps every `D_*` track to title+author. Needed lines for our target (freedoom1 subset), quoted verbatim (top of file):

> --Phase 1--
>
> Title: "Fight for Freedom" by Korp, based on "Fountain Dance" by Tyler "Picklehammer" Pantella
> Intermission: "YOU LIVE!!!!" by Stratos
> Victory: "Distance" by Korp
> Bunny: "Impactean Welcome Party" by Goji

and the E1/E2/E3 blocks beneath (E1M1 “Stanky Leg Specialist” by Lola "BlueWorrior" Harvey … E3M9 “No-Clip to the End”, full list L7–45; the Phase-2/MAP/DM blocks at the end apply to freedoom2.wad only).

**Action for us:** ship an ABOUT/credits screen or file reproducing COPYING.txt’s copyright+conditions and the CREDITS-MUSIC.txt Phase-1 lines (plus sound contributors from CREDITS.txt). [uncertain: the 0.13 archive here carries only the BSD-style COPYING; the project’s public statement that data (incl. music) is CC-BY 4.0 is recalled, not found in the offline files — verify online before release.]

## 9. Confidence and sources

(TBD by overall author; note: sections 3–8 below are this agent's scope.)

**Verified this session (primary evidence read/parsed directly):**
- All 41 `D_*` lumps in freedoom1.wad are SMF `MThd` (0 MUS, 0 RIFF) — python3 WAD-directory parse; hex dump of D_E1M1 header; per-lump format/division/track/tempo-meta scan.
- SMF stats: all format 1; divisions {96:28, 480:8, 960:3, 600:1, 32:1}; all contain FF 51 tempo meta; 1–19 MTrk chunks per file.
- MUS header struct, magic `MUS\x1A`, event descriptor bits (0x80 chunk-end / 0x70 type / 0x0F channel), event table 0x00/0x10/0x20/0x30/0x40/0x60, velocity-cache & key&0x80 rule, 128-multiplier delta chain, `controller_map`, `GetMIDIChannel` (15→9, dynamic alloc + D_DDTBLU all-notes-off) — all line-checked in `/tmp/chocolate-doom-master/src/mus2mid.c`.
- MUS timing 140 ticks/s (resolution 0x46=70 in mus2mid midiheader + i_oplmusic.c L1501 default `us_per_beat = 500*1000`).
- Vanilla `d_%s` lump lookup, `S_Start` episode/commercial/spmus music index math, `S_ChangeMusic(mnum,true)` loop, `S_StartMusic`=no-loop, f_finale victor/bunny — `/tmp/DOOM-master/linuxdoom-1.10/s_sound.c`, `sounds.c`, `f_finale.c`, `m_menu.c`.
- SFX allocator: free → same-origin kill → priority-evict-or-drop (s_sound.c L837–864); volume defaults 15/15 (linuxdoom s_sound.c L113/116) and 8/8 (chocolate src/doom/s_sound.c L86/90); 0–127 internal clamp (s_sound.c L616–637); menu 0–15 (m_menu.c L821–842).
- Freedoom attribution lines quoted from `/tmp/freedoom-0.13.0/COPYING.txt`, `CREDITS.txt` (1030 L), `CREDITS-MUSIC.txt` (205 L, “--Phase 1--” block).

**Recalled / not verified (flagged):**
- DMX MUS spec “note = keybyte + 12” (mus2mid does NOT add it — discrepancy unresolved; no real MUS available offline to test).
- GS/XG bank-select usage in Freedoom MIDIs (plausible, not exhaustively dumped).
- Freedoom 0.13 data assets “CC-BY 4.0” license claim — not present in offline files.
- §4/§6 design proposals (voice counts, curves, eviction) are engineering recommendations, not source facts.
