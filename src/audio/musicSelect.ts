// audio/musicSelect.ts — M10-08: music SELECTION + LIFECYCLE (M10-plan
// §0.6/§M10-08). The S_music[] name mirror (sounds.c:36-112), the S_Start()
// map→song math (s_sound.c:202-248 incl. the spmus[] e4 table :220-233 +
// the §0.10 direct-`D_E<ep><map>`-lump-first rule), S_ChangeMusic
// (s_sound.c:649-686, same-song no-op guard :665-666 + the lazy
// sprintf("d_%s") lookup :673-676), S_StartMusic = non-looping (:644-647),
// S_StopMusic (:689-703) and the S_PauseSound/S_ResumeSound latch
// (:497-513, g_game.c:705-712).
//
// SOURCE POLICY (plan §0.x MUSIC SOURCE CORRECTION + §0.10 audit):
//   * The pinned freedoom1.wad (0.13.0) carries 41 BSD-licensed Freedoom-
//     ORIGINAL SMF lumps D_E1M1..D_E4M9/D_INTER/D_INTRO/D_INTROA/D_VICTOR/
//     D_BUNNY (measured this task: MThd everywhere, ZERO MUS, ZERO OGG).
//     This is the default playable source (SMF-IWAD support per §0.x).
//   * The release ZIP ships NO OGG companions (audited this task: 11
//     entries — 2 WADs + docs; scripts/freedoom/fetch.mjs gained the
//     .ogg-capable pin + verify discipline, with ZERO pinned entries).
//     If OGGs are ever placed under wads/music/ (fetch-only, never
//     committed — wads/ is gitignored), the host registers them through
//     registerOgg()/an OggSource and they take precedence for that lump.
//   * MUS transcription is CANCELLED (§0.x): `musDecoder = false` (plan
//     §4 flag) — a MUS-headed lump degrades to counted silence.
//
// Missing files degrade to DETERMINISTIC SILENCE: warn-once per song name
// + counted drop (never console.error, plan §0.10 policy), and every
// headless path (no host / no wad) is a pure state machine.
//
// Zone rule (A-06): imports the sim SEAMS only (hooks.registerLiveMusic,
// gamemode constants — read-views) + wad read-view types; sim imports
// NOTHING from here. The S_Start sfx-channel kill is mixerCore's (M10-05
// `startLevel` hook) — this module owns only the MUSIC half.
// SPDX-License-Identifier: GPL-2.0-or-later

import { GAME_MODE, type GameMode } from '../sim/gamemode';
import { registerLiveMusic, type MusicKind } from '../sim/hooks';
import { decodeSmf, rationalToNumber, SmfDecodeError, type Smf } from './smf';
import { SmfPlayer } from './smfPlayer';
import { Synth, type SynthContextLike } from './synth';

/* ------------------------------------------------------------------ */
/* S_music[] — the 70-row name mirror (sounds.c:36-112)                */
/* ------------------------------------------------------------------ */

/** mus_* indices we reach (sounds.h:101-168): NONE + episodic 1-27 +
 * the 5 special songs + mus_runnin (commercial math anchor). */
export const MUS = {
  NONE: 0,
  E1M1: 1, // e1m1..e1m9 = 1..9, e2m* = 10..18, e3m* = 19..27
  INTER: 28,
  INTRO: 29,
  BUNNY: 30,
  VICTOR: 31,
  INTROA: 32,
  RUNNIN: 33
} as const;

/** NUMMUSIC (sounds.c row count: dummy + 27 episodic + 5 special + 37
 * commercial = 70). Transcribed byte-for-byte from sounds.c:37-111 —
 * the 6-char commercial names are DOOM 2's truncated table entries
 * (exists-but-unreachable under the shareware policy, §0.6). */
export const SONG_NAMES: readonly string[] = [
  '', // index 0 = the {0} dummy row
  'e1m1', 'e1m2', 'e1m3', 'e1m4', 'e1m5', 'e1m6', 'e1m7', 'e1m8', 'e1m9',
  'e2m1', 'e2m2', 'e2m3', 'e2m4', 'e2m5', 'e2m6', 'e2m7', 'e2m8', 'e2m9',
  'e3m1', 'e3m2', 'e3m3', 'e3m4', 'e3m5', 'e3m6', 'e3m7', 'e3m8', 'e3m9',
  'inter', 'intro', 'bunny', 'victor', 'introa',
  'runnin', 'stalks', 'countd', 'betwee', 'doom', 'the_da', 'shawn', 'ddtblu',
  'in_cit', 'dead', 'stlks2', 'theda2', 'doom2', 'ddtbl2', 'runni2', 'dead2',
  'stlks3', 'romero', 'shawn2', 'messag', 'count2', 'ddtbl3', 'ampie', 'theda3',
  'adrian', 'messg2', 'romer2', 'tense', 'shawn3', 'openin', 'evil', 'ultima',
  'read_m', 'dm2ttl', 'dm2int'
];

/** The spmus[] e4-remap table, s_sound.c:220-233 (mus_ indices). */
export const SPMUS: readonly number[] = [
  22, // mus_e3m4  American   e4m1
  20, // mus_e3m2  Romero     e4m2
  21, // mus_e3m3  Shawn      e4m3
  5, //  mus_e1m5  American   e4m4
  16, // mus_e2m7  Tim        e4m5
  13, // mus_e2m4  Romero     e4m6
  15, // mus_e2m6  J.Anderson e4m7 CHIRON.WAD
  14, // mus_e2m5  Shawn      e4m8
  9 //  mus_e1m9  Tim        e4m9
];

/** Plan §4 flag: the MUS decoder is NOT implemented (§0.x: transcription
 * cancelled, and the pinned WAD carries ZERO MUS lumps). */
export const musDecoder = false;

/** §0.6 call-site table: musicSlot kind ⇒ S_music index (§M10-08 routing:
 * title ⇒ D_INTRO ONE-SHOT (d_main.c:477), inter ⇒ D_INTER, finale ⇒
 * D_VICTOR; 'level' resolves per-map through sStart). */
export const KIND_SONG: Readonly<Record<Exclude<MusicKind, 'level'>, number>> = {
  intermission: MUS.INTER,
  title: MUS.INTRO,
  finale: MUS.VICTOR
};

/* ------------------------------------------------------------------ */
/* Selection math (pure)                                               */
/* ------------------------------------------------------------------ */

export interface ResolvedSong {
  /** S_music table index (the same-song identity for the vanilla guard). */
  readonly song: number;
  /** The LUMP the bytes come from — sprintf("d_%s") rule, upper-cased
   * (s_sound.c:673-676). OGG companions key on this name. */
  readonly lump: string;
  /** True when the §0.10 direct lookup beat the table name (e4m9 ⇒
   * D_E4M9 although spmus says mus_e1m9). */
  readonly direct: boolean;
}

/** S_Start()'s song math (s_sound.c:215-238) + the §0.10 direct-lump
 * rule. `has` = wad lump-availability probe (omit ⇒ table-only, the
 * vanilla behavior). Commercial is present-but-unreachable (§4): the
 * shareware GAME_MODE never selects it. */
export function resolveLevelSong(
  episode: number,
  map: number,
  mode: GameMode = GAME_MODE,
  has?: (lump: string) => boolean
): ResolvedSong {
  if (mode === 'commercial') {
    const song = MUS.RUNNIN + map - 1; // s_sound.c:218
    return { song, lump: lumpName(song), direct: false };
  }
  let song: number;
  if (episode < 4) song = MUS.E1M1 + (episode - 1) * 9 + map - 1; // :235
  else song = SPMUS[Math.min(Math.max(map, 1), 9) - 1]!; // :237 (clamped index)
  const lump = lumpName(song);
  // §0.10: a same-position direct lump (D_E4M9) wins over the remapped
  // table name — DATA truth, not a deviation of the guard (the table
  // index still drives the same-song identity, which stays mus_e1m9).
  if (episode === 4 && has !== undefined) {
    const direct = `D_E4M${map}`;
    if (has(direct)) return { song, lump: direct, direct: true };
  }
  return { song, lump, direct: false };
}

/** Table name → lump name (the "d_%s" sprintf, upper-cased for WADs). */
export function lumpName(song: number): string {
  return `D_${(SONG_NAMES[song] ?? '').toUpperCase()}`;
}

/* ------------------------------------------------------------------ */
/* Host seams (the composer — M10-09 wiring — injects these)           */
/* ------------------------------------------------------------------ */

/** Structural wad read-view (WadFile satisfies it; A-06 type-only). */
export interface MusicWadView {
  has(name: string): boolean;
  readLumpByName(name: string): Uint8Array;
}

/** A decoded OGG companion track (host-built: AudioBufferSourceNode →
 * musicBus; M10-09's wiring owns the fetch/decode plumbing — see
 * makeOggSource below). Times are AudioContext seconds. */
export interface OggTrackLike {
  readonly durationSec: number;
  start(whenSec: number, loop: boolean): void;
  stop(): void;
}

/** Async companion provider: resolves a playable track for a lump name,
 * or null when the file is absent (negative-cached by makeOggSource). */
export interface OggSource {
  trackFor(lump: string): Promise<OggTrackLike | null>;
}

/** The realtime host: a Synth context + (optionally) the musicBus node.
 * Absent ⇒ every lifecycle transition is pure bookkeeping (the silent,
 * deterministic headless path). `now` defaults to context.currentTime. */
export interface MusicHost {
  readonly context: SynthContextLike;
  readonly musicIn?: unknown;
  now?: () => number;
}

export interface LevelView {
  episode: number;
  map: number;
  mode?: GameMode;
}

/* ------------------------------------------------------------------ */
/* Module state (mus_playing / mus_paused equivalents)                 */
/* ------------------------------------------------------------------ */

interface MusicRuntime {
  /** mus_playing (the resolved lump currently started; null = silent). */
  playingLump: string | null;
  playingSong: number;
  /** loop flag of the current song (S_ChangeMusic argument). */
  looping: boolean;
  /** mus_paused latch (s_sound.c:497-513). */
  paused: boolean;
  /** census (debug seam / tests). */
  starts: number;
  stops: number;
  missing: number;
  musSkipped: number;
  changeCalls: number;
  noOps: number;
  /** song names already warned about (warn-ONCE policy, §0.10). */
  warned: Set<string>;
  /** lifecycle events routed through the live listener. */
  events: { kind: MusicKind; loop: boolean; tic: number }[];
  /** token guarding async OGG resolution races. */
  token: number;
  /** wall-clock end of the CURRENT non-looping song (Infinity when
   * looping/headless) — the one-shot re-arm + playing census. */
  endAtSec: number;
  /** live SMF playback objects (rebuilt per host). */
  player: SmfPlayer | null;
  /** registered/loose OGG companions keyed by lump name. */
  oggs: Map<string, OggTrackLike>;
  oggSource: OggSource | null;
  liveOgg: { track: OggTrackLike; loop: boolean } | null;
}

const rt: MusicRuntime = {
  playingLump: null,
  playingSong: 0,
  looping: false,
  paused: false,
  starts: 0,
  stops: 0,
  missing: 0,
  musSkipped: 0,
  changeCalls: 0,
  noOps: 0,
  warned: new Set(),
  events: [],
  token: 0,
  endAtSec: Infinity,
  player: null,
  oggs: new Map(),
  oggSource: null,
  liveOgg: null
};

let wad: MusicWadView | null = null;
let host: MusicHost | null = null;
let levelView: (() => LevelView) | null = null;
let installed = false;

/** Attach the IWAD read-view (main.ts boot / tests). null detaches. */
export function setMusicWad(view: MusicWadView | null): void {
  wad = view;
}

/** Inject the realtime host; rebuilds the Synth/SmfPlayer pair (nothing
 * is playing across a host swap — callers sStopMusic() first). */
export function setMusicHost(h: MusicHost | null): void {
  host = h;
  rt.player =
    h === null ? null : new SmfPlayer(new Synth({ context: h.context, musicIn: h.musicIn }));
}

/** The episode/map accessor the 'level' event resolves through (the
 * composer wires it to state.gameepisode/gamemap; unset ⇒ E1M1). */
export function setMusicLevelView(fn: (() => LevelView) | null): void {
  levelView = fn;
}

/** Register a playable OGG companion for a lump name (fetch-only files;
 * plan §0.x — never committed, verified by scripts/freedoom/fetch.mjs). */
export function registerOgg(lump: string, track: OggTrackLike | null): void {
  if (track === null) rt.oggs.delete(lump);
  else rt.oggs.set(lump, track);
}

/** Install an async companion source (makeOggSource for the default
 * fetch/cache discipline; null disables probing entirely). */
export function setOggSource(src: OggSource | null): void {
  rt.oggSource = src;
}

/* ------------------------------------------------------------------ */
/* The S_* port                                                        */
/* ------------------------------------------------------------------ */

/** The live-music listener: musicSlot(kind, loop) → the §0.6 routing.
 * installMusicSelector() registers it (idempotent); uninstall clears. */
export function musicEventListener(kind: MusicKind, loop: boolean, tic: number): void {
  rt.events.push({ kind, loop, tic });
  if (kind === 'level') {
    const v = levelView !== null ? levelView() : { episode: 1, map: 1 };
    sStartLevel(v.episode, v.map, v.mode);
    return;
  }
  sChangeMusic(KIND_SONG[kind], kind === 'title' ? false : loop);
}

export function installMusicSelector(): void {
  if (installed) return;
  installed = true;
  registerLiveMusic(musicEventListener);
}

export function uninstallMusicSelector(): void {
  if (!installed) return;
  installed = false;
  registerLiveMusic(null);
  sStopMusic();
}

/**
 * S_Start() (s_sound.c:202-248) — the per-level selection half (the sfx
 * channel kill is mixerCore's startLevel hook, M10-05). mus_paused = 0
 * (:214) and the selection ALWAYS loops (:245).
 */
export function sStartLevel(episode: number, map: number, mode: GameMode = GAME_MODE): void {
  rt.paused = false; // mus_paused = 0 (s_sound.c:214)
  const resolved = resolveLevelSong(episode, map, mode, wad ? (n) => wad!.has(n) : undefined);
  startResolved(resolved, true);
}

/** S_StartMusic (s_sound.c:644-647): the ONE-SHOT variant (title). */
export function sStartMusic(song: number): void {
  sChangeMusic(song, false);
}

/** S_ChangeMusic (s_sound.c:649-686). Bad indices are counted drops
 * (vanilla I_Error → our zero-console policy). The same-song guard is
 * `mus_playing == music` (:665-666) with ONE documented refinement: a
 * NON-looping song that has finished re-arms (d_main.c:477/:498 replay
 * the title tune per attract-page cycle, §0.6). */
export function sChangeMusic(song: number, loop: boolean): void {
  rt.changeCalls += 1;
  if (song <= MUS.NONE || song >= SONG_NAMES.length) {
    warnOnce(`music#${song}`, 'bad music number'); // vanilla I_Error slot
    return;
  }
  const lump = lumpName(song);
  startResolved({ song, lump, direct: false }, loop);
}

/** S_StopMusic (s_sound.c:689-703): unregister current song. */
export function sStopMusic(): void {
  rt.token += 1; // cancel in-flight OGG resolutions
  if (rt.liveOgg !== null) {
    rt.liveOgg.track.stop();
    rt.liveOgg = null;
  }
  if (rt.player !== null) rt.player.stop(nowSec());
  if (rt.playingLump !== null) {
    rt.stops += 1;
    rt.playingLump = null;
    rt.playingSong = 0;
    rt.looping = false;
  }
  rt.endAtSec = Infinity;
  rt.paused = false;
}

/** S_PauseSound music half (s_sound.c:497-505). */
export function sPauseMusic(): void {
  if (rt.playingLump !== null && !rt.paused) {
    rt.paused = true;
    rt.player?.pause(nowSec());
  }
}

/** S_ResumeSound music half (s_sound.c:507-513). */
export function sResumeMusic(): void {
  if (rt.playingLump !== null && rt.paused) {
    rt.paused = false;
    rt.player?.resume(nowSec());
  }
}

/** Pump the lookahead scheduler (composer calls per animation frame;
 * headless tests drive it with a fake clock). The SmfPlayer gates on
 * its own paused/playing flags — the mus_paused latch lives here too. */
export function musicTick(nowSecOverride?: number): number {
  if (rt.paused) return 0;
  if (rt.player === null || !rt.player.playing) return 0;
  return rt.player.pump(nowSecOverride ?? nowSec());
}

/* ------------------------------------------------------------------ */
/* Internals                                                           */
/* ------------------------------------------------------------------ */

function startResolved(resolved: ResolvedSong, loop: boolean): void {
  // The same-song no-op guard (s_sound.c:665-666 mus_playing == music) sits
  // on the CHANGE path — and S_Start REACHES it (S_ChangeMusic(mnum,true),
  // s_sound.c:245). Refinement: a finished NON-loop song re-arms
  // (attract-cycle title replay, d_main.c:477/:498, §0.6).
  if (rt.playingLump === resolved.lump && (loop || !oneShotFinished())) {
    rt.noOps += 1;
    return;
  }
  // shutdown old music (s_sound.c:670 S_StopMusic BEFORE the new start —
  // stops first, starts second, never interleaved: "no double music").
  sStopMusic();
  rt.token += 1;
  const token = rt.token;
  rt.playingLump = resolved.lump;
  rt.playingSong = resolved.song;
  rt.looping = loop;
  rt.starts += 1;
  rt.endAtSec = Infinity;

  // Companion OGG first (plan §0.x source policy)…
  const loose = rt.oggs.get(resolved.lump);
  if (loose !== undefined) {
    startOgg({ track: loose, loop });
    return;
  }
  // …else the SMF/IWAD path…
  const bytes = readMusicLump(resolved.lump);
  if (bytes === null) return; // counted silence (warn-once inside)
  if (isMusHeader(bytes)) {
    // MUS behind the off-flag: counted, silent, never an error (§4).
    if (!musDecoder) {
      rt.musSkipped += 1;
      warnOnce(resolved.lump, 'MUS lump but musDecoder=false (§4 flag) — silence');
      rt.playingLump = null;
      rt.playingSong = 0;
      return;
    }
  }
  let smf: Smf;
  try {
    smf = decodeSmf(bytes);
  } catch (err) {
    const why = err instanceof SmfDecodeError ? err.message : 'decoder error';
    warnOnce(resolved.lump, `undecodable SMF (${why}) — silence`);
    rt.missing += 1;
    rt.playingLump = null;
    rt.playingSong = 0;
    return;
  }
  if (rt.player !== null && host !== null) {
    const plan = rt.player.play(smf, loop, nowSec());
    rt.endAtSec = loop ? Infinity : nowSec() + rationalToNumber(plan.endT) / 1_000_000;
  }
  // …and an async companion source (fetch/decode) upgrades the SMF copy
  // the moment it resolves — a missing file keeps the SMF (or silence).
  if (rt.oggSource !== null) {
    const p = rt.oggSource.trackFor(resolved.lump);
    void p.then(
      (track) => {
        if (track === null || rt.token !== token || rt.playingLump !== resolved.lump) return;
        if (rt.player !== null) rt.player.stop(nowSec());
        startOgg({ track, loop });
      },
      () => undefined // fetch failure == file absent: keep SMF, stay quiet
    );
  }
}

function startOgg(entry: { track: OggTrackLike; loop: boolean }): void {
  rt.liveOgg = entry;
  const when = nowSec();
  entry.track.start(when, entry.loop);
  rt.endAtSec = entry.loop ? Infinity : when + entry.track.durationSec;
}

/** True when the current playback is a one-shot whose END CLOCK has run
 * out (the re-arm condition, §0.6 attract-cycle title replay). Headless
 * (no host clock) or looping songs never "end" — silent mode keeps the
 * vanilla guard shape. */
function oneShotFinished(): boolean {
  if (rt.looping || rt.endAtSec === Infinity || host === null) return false;
  return nowSec() >= rt.endAtSec;
}

function readMusicLump(lump: string): Uint8Array | null {
  if (wad === null) {
    // No IWAD attached (early boot / headless harness): counted, warned
    // once; deterministic silence.
    rt.missing += 1;
    warnOnce(lump, 'no IWAD attached');
    rt.playingLump = null;
    rt.playingSong = 0;
    return null;
  }
  if (!wad.has(lump)) {
    rt.missing += 1;
    warnOnce(lump, 'lump absent — silence');
    rt.playingLump = null;
    rt.playingSong = 0;
    return null;
  }
  return wad.readLumpByName(lump);
}

/** Cheap MUS signature: no "MThd", and the 10-byte header's scoreLen
 * (u16 LE @4) accounts for the lump exactly. Decoding stays flag-off. */
function isMusHeader(b: Uint8Array): boolean {
  if (b.length < 14) return false;
  if (b[0] === 0x4d && b[1] === 0x54 && b[2] === 0x68 && b[3] === 0x64) return false; // MThd
  const score = b[4]! | (b[5]! << 8);
  return score > 0 && score + 10 === b.length;
}

function warnOnce(name: string, why: string): void {
  if (rt.warned.has(name)) return;
  rt.warned.add(name);
  // warn-ONCE, never an error (plan §0.10 — the L4 no-console-errors gate).
  console.warn(`musicSelect: ${name}: ${why}`);
}

function nowSec(): number {
  if (host === null) return 0;
  return host.now !== undefined ? host.now() : host.context.currentTime;
}

/* ------------------------------------------------------------------ */
/* Census / test seams                                                 */
/* ------------------------------------------------------------------ */

export interface MusicStatus {
  lump: string | null;
  song: number;
  playing: boolean;
  paused: boolean;
  starts: number;
  stops: number;
  missing: number;
  musSkipped: number;
}

/** Read-only census (the M10-09 debug seam reads through this). */
export function musicState(): MusicStatus {
  const playing =
    rt.liveOgg !== null ||
    (rt.playingLump !== null && !oneShotFinished());
  return {
    lump: rt.playingLump,
    song: rt.playingSong,
    playing,
    paused: rt.paused,
    starts: rt.starts,
    stops: rt.stops,
    missing: rt.missing,
    musSkipped: rt.musSkipped
  };
}

/** Per-test isolation: full state wipe (NOT called by the app). */
export function resetMusicSelector(): void {
  rt.playingLump = null;
  rt.playingSong = 0;
  rt.looping = false;
  rt.paused = false;
  rt.starts = 0;
  rt.stops = 0;
  rt.missing = 0;
  rt.musSkipped = 0;
  rt.changeCalls = 0;
  rt.noOps = 0;
  rt.warned = new Set();
  rt.events = [];
  rt.token += 1;
  rt.endAtSec = Infinity;
  rt.player = null;
  rt.oggs = new Map();
  rt.oggSource = null;
  rt.liveOgg = null;
  wad = null;
  host = null;
  levelView = null;
  installed = false;
  registerLiveMusic(null);
}

/** Event ledger (tests). */
export function musicControlEvents(): readonly { kind: MusicKind; loop: boolean; tic: number }[] {
  return rt.events;
}

/* ------------------------------------------------------------------ */
/* Companion-OGG plumbing (plan §0.x: fetch-decodeAudioBuffer → loop   */
/* via the MUSIC bus; graceful absence = null, negative-cached)        */
/* ------------------------------------------------------------------ */

/** Fetchable/decodable context slice (browser AudioContext subset; kept
 * local so context.ts stays M10-01-owned). */
export interface OggDecodeContext {
  decodeAudioData(data: ArrayBuffer): Promise<unknown>;
  createBufferSource(): {
    buffer: unknown;
    loop: boolean;
    connect(dest: unknown): void;
    start(when?: number): void;
    stop(): void;
  };
  currentTime: number;
}

/** Default companion source: GET `${base}/${name.toLowerCase()}.ogg`
 * (vite serves the fetched, NEVER-committed wads/music/ dir the same way
 * as wads/freedoom1.wad). 404/decode failure ⇒ null forever (one probe
 * per name — deterministic silence, zero console noise). */
export function makeOggSource(
  ctx: OggDecodeContext,
  musicIn: unknown,
  base = '/wads/music'
): OggSource {
  const cache = new Map<string, Promise<OggTrackLike | null>>();
  return {
    trackFor(lump: string): Promise<OggTrackLike | null> {
      const hit = cache.get(lump);
      if (hit !== undefined) return hit;
      const p = (async (): Promise<OggTrackLike | null> => {
        try {
          const res = await fetch(`${base}/${lump.toLowerCase()}.ogg`);
          if (!res.ok) return null;
          const ab = await res.arrayBuffer();
          const buffer = await ctx.decodeAudioData(ab);
          const durationSec = (buffer as { duration?: number }).duration ?? 0;
          let src: { stop(): void } | null = null;
          return {
            durationSec,
            start(whenSec: number, loop: boolean): void {
              src?.stop();
              const node = ctx.createBufferSource();
              node.buffer = buffer;
              node.loop = loop;
              node.connect(musicIn);
              node.start(whenSec);
              src = node;
            },
            stop(): void {
              src?.stop();
              src = null;
            }
          };
        } catch {
          return null; // absent/unfetchable == no companion
        }
      })();
      cache.set(lump, p);
      return p;
    }
  };
}
