// audio/musicSelect.test.ts — M10-08 music selection + lifecycle
// (M10-plan §M10-08 acceptance 1/2/3/5 + the §0.x source-policy degradation
// + fetch-companion plumbing). Pure-node: mock Synth context, fake WAD
// read-views, smfBuild fixtures; the real pinned IWAD joins where present.
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSmf, type BuildEvent } from '../../tests/fixtures/smfBuild';
import { buildMapFromData } from '../sim/map';
import { loadMap } from '../wad/mapdata';
import { WadFile } from '../wad/wadfile';
import {
  gDeferedInitNew,
  gInitGame,
  GS,
  gTicker,
  registerGameFlowHooks,
  resetGameFlow
} from '../sim/game';
import { musicLog, musicSlot, resetSfxStubLog } from '../sim/hooks';
import type { GameState } from '../sim/state';
import type { SynthContextLike } from './synth';
import {
  installMusicSelector,
  lumpName,
  makeOggSource,
  musicControlEvents,
  musicState,
  musicTick,
  musDecoder,
  registerOgg,
  resetMusicSelector,
  resolveLevelSong,
  sChangeMusic,
  sPauseMusic,
  sResumeMusic,
  sStartLevel,
  sStartMusic,
  sStopMusic,
  setMusicHost,
  setMusicLevelView,
  setMusicWad,
  setOggSource,
  SONG_NAMES,
  SPMUS,
  uninstallMusicSelector,
  type MusicHost,
  type OggTrackLike
} from './musicSelect';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// A 1.0 s one-shot song: div 480, tempo 500000 µs/q, one note 0→960 ticks.
const song: BuildEvent[][] = [
  [
    { delta: 0, type: 'tempo', usPerQuarter: 500_000 },
    { delta: 0, type: 'program', channel: 0, program: 80 },
    { delta: 0, type: 'noteOn', channel: 0, note: 60, velocity: 100 },
    { delta: 960, type: 'noteOff', channel: 0, note: 60, velocity: 0 },
    { delta: 0, type: 'eot' }
  ]
];
const songBytes = (): Uint8Array => buildSmf({ format: 0, division: 480, tracks: song });

class FakeWad {
  readonly lumps = new Map<string, Uint8Array>();
  has(name: string): boolean {
    return this.lumps.has(name);
  }
  readLumpByName(name: string): Uint8Array {
    const b = this.lumps.get(name);
    if (b === undefined) throw new RangeError(`unknown lump '${name}'`);
    return b;
  }
}

function fakeWadWith(...names: string[]): FakeWad {
  const w = new FakeWad();
  for (const n of names) w.lumps.set(n, songBytes());
  return w;
}

// Minimal mock of the Synth node graph with a controllable clock.
function mockHost(): { host: MusicHost; now: { t: number } } {
  const now = { t: 0 };
  const param = () => ({
    value: 0,
    setValueAtTime: (v: number, t: number) => {
      void v;
      void t;
    },
    linearRampToValueAtTime: (v: number, t: number) => {
      void v;
      void t;
    },
    setTargetAtTime: (v: number, t: number, c: number) => {
      void v;
      void t;
      void c;
    }
  });
  const ctx: SynthContextLike = {
    sampleRate: 44100,
    get currentTime() {
      return now.t;
    },
    destination: 'dest',
    createGain: () => ({ gain: param(), connect: () => undefined }),
    createOscillator: () =>
      ({
        type: 'sine',
        frequency: param(),
        detune: param(),
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined
      }) as never,
    createBufferSource: () =>
      ({
        buffer: null,
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined
      }) as never,
    createBuffer: (_ch: number, frames: number, _rate: number) => ({
      getChannelData: () => new Float32Array(frames)
    }),
    createBiquadFilter: () =>
      ({ type: 'lowpass', frequency: param(), Q: param(), connect: () => undefined }) as never
  };
  return { host: { context: ctx, musicIn: 'musicBus' }, now };
}

function fakeTrack(log: string[]): OggTrackLike {
  return {
    durationSec: 2,
    start(when, loop) {
      log.push(`start:${when.toFixed(3)}:${loop ? 'loop' : 'once'}`);
    },
    stop() {
      log.push('stop');
    }
  };
}

/* ------------------------------------------------------------------ */
/* S_music mirror + selection math (acceptance 1)                      */
/* ------------------------------------------------------------------ */

describe('M10-08 S_music mirror (sounds.c:36-112)', () => {
  it('row census: 1 dummy + 27 episodic + 5 special + 35 commercial = 68', () => {
    // NOTE the plan §0.6 "70 rows" is a miscount of the sounds.c dump —
    // the table has 68 rows (the sounds.h mus_None..mus_dm2int enum counts
    // 68; verified against the mirror this task).
    expect(SONG_NAMES.length).toBe(68);
    expect(SONG_NAMES[0]).toBe('');
    expect(SONG_NAMES[1]).toBe('e1m1');
    expect(SONG_NAMES[27]).toBe('e3m9');
    expect(SONG_NAMES[28]).toBe('inter');
    expect(SONG_NAMES[29]).toBe('intro');
    expect(SONG_NAMES[30]).toBe('bunny');
    expect(SONG_NAMES[31]).toBe('victor');
    expect(SONG_NAMES[32]).toBe('introa');
    expect(SONG_NAMES[33]).toBe('runnin');
    expect(SONG_NAMES[67]).toBe('dm2int');
    expect(lumpName(29)).toBe('D_INTRO');
    expect(musDecoder).toBe(false); // §4 flag: MUS decoder OFF
  });

  it('spmus[] transcribes s_sound.c:220-233', () => {
    expect(SPMUS).toEqual([22, 20, 21, 5, 16, 13, 15, 14, 9]);
  });
});

describe('M10-08 resolveLevelSong (S_Start math, s_sound.c:215-238)', () => {
  it('episodic rows: E1M1..E1M9 → D_E1M1..D_E1M9 (+ep2/ep3 anchors)', () => {
    for (let m = 1; m <= 9; m++) {
      expect(resolveLevelSong(1, m).lump).toBe(`D_E1M${m}`);
    }
    expect(resolveLevelSong(2, 5).lump).toBe('D_E2M5');
    expect(resolveLevelSong(2, 5).song).toBe(14);
    expect(resolveLevelSong(3, 9).lump).toBe('D_E3M9');
    expect(resolveLevelSong(3, 9).song).toBe(27);
  });

  it('episode 4: spmus remap names, but the DIRECT D_E4Mx lump wins when present', () => {
    // No lump probe ⇒ the vanilla table name (e4m9 ⇒ mus_e1m9 ⇒ D_E1M9).
    expect(resolveLevelSong(4, 9).lump).toBe('D_E1M9');
    expect(resolveLevelSong(4, 9).song).toBe(9);
    // Table-only census of the full spmus row (nothing direct available).
    const noE4 = () => false;
    const lumps = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((m) =>
      resolveLevelSong(4, m, 'shareware', noE4).lump
    );
    expect(lumps).toEqual([
      'D_E3M4', 'D_E3M2', 'D_E3M3', 'D_E1M5', 'D_E2M7', 'D_E2M4', 'D_E2M6', 'D_E2M5', 'D_E1M9'
    ]);
    // The pinned-WAD data truth (§0.10): direct D_E4M9 found ⇒ SAME table
    // index (identity stays mus_e1m9), bytes from D_E4M9.
    const hasE4 = (n: string) => n === 'D_E4M9' || n === 'D_E4M1';
    const r9 = resolveLevelSong(4, 9, 'shareware', hasE4);
    expect(r9.lump).toBe('D_E4M9');
    expect(r9.song).toBe(9);
    expect(r9.direct).toBe(true);
  });

  it('commercial formula row: present-but-unreachable (§4)', () => {
    const r = resolveLevelSong(1, 3, 'commercial');
    expect(r.song).toBe(35); // mus_runnin(33) + 3 - 1 (s_sound.c:218)
    expect(r.lump).toBe('D_COUNTD');
  });
});

/* ------------------------------------------------------------------ */
/* Lifecycle port (S_Change/Stop/Start/pause; acceptance 2/3)          */
/* ------------------------------------------------------------------ */

describe('M10-08 lifecycle (s_sound.c:644-703)', () => {
  beforeEach(() => resetMusicSelector());
  afterEach(() => {
    uninstallMusicSelector();
    resetMusicSelector();
    vi.restoreAllMocks();
  });

  it('start plays the lump, same-song re-trigger is a NO-OP (play-count 1)', () => {
    setMusicWad(fakeWadWith('D_E1M1'));
    const { host, now } = mockHost();
    setMusicHost(host);
    sStartLevel(1, 1);
    now.t = 0.05;
    musicTick();
    expect(musicState().lump).toBe('D_E1M1');
    expect(musicState().playing).toBe(true);
    sStartLevel(1, 1); // reload of the SAME map (D017 death-rebirth path)
    sChangeMusic(1, true);
    expect(musicState().starts).toBe(1); // no double-music, ever
    expect(musicState().stops).toBe(0);
  });

  it('level CHANGE stops the old song exactly once and starts the new', () => {
    setMusicWad(fakeWadWith('D_E1M1', 'D_E1M2'));
    const { host } = mockHost();
    setMusicHost(host);
    sStartLevel(1, 1);
    sStartLevel(1, 2);
    const st = musicState();
    expect(st).toMatchObject({ lump: 'D_E1M2', starts: 2, stops: 1, missing: 0 });
  });

  it('title music is ONE-SHOT (§0.6 d_main.c:477) and RE-ARMS after its end', () => {
    setMusicWad(fakeWadWith('D_INTRO'));
    const { host, now } = mockHost();
    setMusicHost(host);
    sStartMusic(29); // S_StartMusic = S_ChangeMusic(m, false)
    now.t = 0.05;
    musicTick();
    expect(musicState().playing).toBe(true);
    sChangeMusic(29, false); // re-trigger while still playing ⇒ no-op
    expect(musicState().starts).toBe(1);
    now.t = 1.05; // the 1.0 s song is over
    musicTick();
    expect(musicState().playing).toBe(false);
    sStartMusic(29); // attract-cycle replay (§0.6) ⇒ re-armed
    expect(musicState().starts).toBe(2);
    expect(musicState().lump).toBe('D_INTRO');
  });

  it('sStopMusic is idempotent and counted once', () => {
    setMusicWad(fakeWadWith('D_E1M1'));
    setMusicHost(mockHost().host);
    sStartLevel(1, 1);
    sStopMusic();
    sStopMusic();
    expect(musicState()).toMatchObject({ lump: null, playing: false, stops: 1 });
  });

  it('pause/resume latch mirrors s_sound.c:497-513 (idempotent both ways)', () => {
    setMusicWad(fakeWadWith('D_E1M1'));
    const { host, now } = mockHost();
    setMusicHost(host);
    sStartLevel(1, 1);
    sPauseMusic();
    sPauseMusic();
    expect(musicState()).toMatchObject({ paused: true, playing: true });
    now.t = 0.02;
    expect(musicTick(now.t)).toBe(0); // no scheduling through the latch
    sResumeMusic();
    sResumeMusic();
    expect(musicState().paused).toBe(false);
    expect(musicTick(now.t)).toBeGreaterThan(0); // scheduling resumed
  });

  it('bad music numbers are counted drops, never throws (I_Error slot)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sChangeMusic(0, true);
    sChangeMusic(999, true);
    expect(musicState().lump).toBe(null);
    expect(warn).toHaveBeenCalledTimes(2); // warn-ONCE per bad id
    expect(warn.mock.calls.every((c) => String(c[0]).startsWith('musicSelect:'))).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Missing files + MUS + companion-OGG source policy (§0.x)            */
/* ------------------------------------------------------------------ */

describe('M10-08 missing-file degradation (deterministic silence)', () => {
  beforeEach(() => resetMusicSelector());
  afterEach(() => {
    resetMusicSelector();
    vi.restoreAllMocks();
  });

  it('absent lump: silence, counted drop, ONE warn, ZERO errors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    setMusicWad(fakeWadWith()); // EMPTY wad: no D_* at all
    sStartLevel(1, 1);
    sStartLevel(1, 1); // repeat attempts stay silent (guard: playingLump null)
    expect(musicState()).toMatchObject({ lump: null, playing: false, missing: 2, musSkipped: 0 });
    expect(warn).toHaveBeenCalledTimes(1); // warn-ONCE
    expect(err).toHaveBeenCalledTimes(0);
  });

  it('no IWAD attached at all: same deterministic silence path', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    sStartLevel(1, 1);
    expect(musicState().playing).toBe(false);
    expect(musicState().missing).toBe(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('undecodable bytes: counted, warned once, silent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = fakeWadWith();
    w.lumps.set('D_E1M1', new Uint8Array([1, 2, 3])); // junk, too short for MUS
    setMusicWad(w);
    sStartLevel(1, 1);
    expect(musicState()).toMatchObject({ lump: null, playing: false, missing: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('MUS-headed lump behind the OFF flag: counted musSkipped, silence (§4)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const w = fakeWadWith();
    const mus = new Uint8Array(10 + 16);
    mus[4] = 16; // scoreLen u16 LE @4 = 16, 16 + 10 == length
    w.lumps.set('D_E1M1', mus);
    setMusicWad(w);
    sStartLevel(1, 1);
    expect(musicState()).toMatchObject({ lump: null, playing: false, musSkipped: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe('M10-08 OGG companion layer (plan §0.x source policy)', () => {
  beforeEach(() => resetMusicSelector());
  afterEach(() => {
    resetMusicSelector();
    vi.restoreAllMocks();
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('registered OGG track plays (looped via the music host) instead of SMF', () => {
    const log: string[] = [];
    registerOgg('D_E1M1', fakeTrack(log));
    setMusicWad(fakeWadWith('D_E1M1'));
    setMusicHost(mockHost().host);
    sStartLevel(1, 1);
    expect(log).toEqual(['start:0.000:loop']);
    expect(musicState().playing).toBe(true);
    sStartLevel(1, 2); // song switch ⇒ companion stopped cleanly
    expect(log).toEqual(['start:0.000:loop', 'stop']);
  });

  it('async source UPGRADES the SMF copy when the file resolves; absence keeps SMF', async () => {
    const log: string[] = [];
    setMusicWad(fakeWadWith('D_E1M1', 'D_E1M2'));
    const track = fakeTrack(log);
    setOggSource({
      trackFor: async (lump) => (lump === 'D_E1M1' ? track : null)
    });
    sStartLevel(1, 1); // SMF starts immediately (no host ⇒ silent-but-stateful)
    await flush();
    expect(log).toEqual(['start:0.000:loop']); // companion took over
    sStartLevel(1, 2); // D_E1M2: source resolves null ⇒ stays SMF, zero noise
    await flush();
    expect(log).toEqual(['start:0.000:loop', 'stop']);
    expect(musicState().lump).toBe('D_E1M2');
  });

  it('makeOggSource: GET+decode loop, 404 ⇒ forever-null (negative cache, ONE probe)', async () => {
    const decoded: number[] = [];
    const ctx = {
      sampleRate: 44100,
      currentTime: 0,
      decodeAudioData: async (ab: ArrayBuffer) => {
        decoded.push(ab.byteLength);
        return { duration: 2.5 };
      },
      createBufferSource: () => ({
        buffer: null as unknown,
        loop: false,
        connect: () => undefined,
        start: () => undefined,
        stop: () => undefined
      })
    };
    const urls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      urls.push(url);
      const ok = url.endsWith('d_e1m1.ogg');
      return { ok, arrayBuffer: async () => new ArrayBuffer(9) };
    });
    const src = makeOggSource(ctx, 'musicIn', '/wads/music');
    const t = await src.trackFor('D_E1M1');
    expect(t).not.toBeNull();
    expect(t!.durationSec).toBe(2.5);
    t!.start(1.5, true); // exercises the buffer-source plumbing (fake nodes)
    expect(decoded).toEqual([9]);
    const miss = await src.trackFor('D_INTER');
    expect(miss).toBeNull();
    const again = await src.trackFor('D_INTER'); // negative-cached: ONE probe
    expect(again).toBeNull();
    expect(urls).toEqual(['/wads/music/d_e1m1.ogg', '/wads/music/d_inter.ogg']);
    vi.unstubAllGlobals();
  });
});

/* ------------------------------------------------------------------ */
/* musicSlot routing + the game.ts level site (acceptance 5)           */
/* ------------------------------------------------------------------ */

describe('M10-08 musicSlot routing + S_Start site', () => {
  beforeEach(() => {
    resetMusicSelector();
    resetSfxStubLog();
    resetGameFlow();
  });
  afterEach(() => {
    uninstallMusicSelector();
    resetMusicSelector();
    resetGameFlow();
    vi.restoreAllMocks();
  });

  it('title/intermission/finale kinds route to D_INTRO/D_INTER/D_VICTOR', () => {
    setMusicWad(fakeWadWith('D_INTRO', 'D_INTER', 'D_VICTOR'));
    installMusicSelector();
    musicSlot('title', false);
    expect(musicState().lump).toBe('D_INTRO');
    musicSlot('intermission', true);
    expect(musicState().lump).toBe('D_INTER');
    musicSlot('finale', true);
    expect(musicState().lump).toBe('D_VICTOR');
    expect(musicControlEvents().map((e) => e.kind)).toEqual(['title', 'intermission', 'finale']);
  });

  it("'level' routes through the episode/map view seam", () => {
    setMusicWad(fakeWadWith('D_E2M7'));
    const view = { episode: 2, map: 7 };
    setMusicLevelView(() => view);
    installMusicSelector();
    musicSlot('level', true);
    expect(musicState().lump).toBe('D_E2M7');
    view.map = 8;
    setMusicWad(fakeWadWith('D_E2M7', 'D_E2M8'));
    musicSlot('level', true);
    expect(musicState().lump).toBe('D_E2M8');
    expect(musicState().starts).toBe(2);
  });

  // Acceptance 5 (hook ledger): EXACTLY one musicSlot('level') per level
  // load through the real P_SetupLevel port (this worktree's game.ts).
  it('one musicSlot(level) per level load: boot=1, newgame-drain=+1', () => {
    const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
    if (!existsSync(WAD_PATH)) return; // sim harness needs real E1M1/E1M2 bytes
    const wad = WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer);
    const mapFor = (ep: number, map: number) => buildMapFromData(loadMap(wad, `E${ep}M${map}`));
    setMusicWad(wad);
    const { host } = mockHost();
    setMusicHost(host);
    installMusicSelector();
    let st: GameState | null = null;
    setMusicLevelView(() => ({ episode: st?.gameepisode ?? 1, map: st?.gamemap ?? 1 }));
    registerGameFlowHooks({ levelLoader: (_s, ep, map) => mapFor(ep, map) });

    resetSfxStubLog();
    st = gInitGame(mapFor(1, 1)); // boot load = 1 level event
    expect(musicLog.count).toBe(1);
    expect(musicLog.byId?.get('level')).toBe(1);
    expect(musicState().lump).toBe('D_E1M1');

    gDeferedInitNew(st, 2, 1, 2); // E1M1 → E1M2 (new-game flow drain)
    gTicker(st); // the drain performs the load
    expect(musicLog.count).toBe(2);
    expect(musicLog.byId?.get('level')).toBe(2);
    expect(musicState()).toMatchObject({ lump: 'D_E1M2', starts: 2, stops: 1 });
    expect(st.gamestate).toBe(GS.LEVEL);
    expect(musicControlEvents().filter((e) => e.kind === 'level').length).toBe(2);
  });
});

/* ------------------------------------------------------------------ */
/* IWAD-gated census: the 41 pinned D_* lumps are all playable SMF     */
/* ------------------------------------------------------------------ */

const WAD_PATH = fileURLToPath(new URL('../../wads/freedoom1.wad', import.meta.url));
const hasWad = existsSync(WAD_PATH);

describe.skipIf(!hasWad)('M10-08 pinned-WAD music census (§0.10 audit)', () => {
  beforeEach(() => resetMusicSelector());
  afterEach(() => {
    resetMusicSelector();
    vi.restoreAllMocks();
  });

  it('all 40 songs resolve + decode with ZERO missing/MUS/skip counts', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const wad = WadFile.parse(readFileSync(WAD_PATH).buffer as ArrayBuffer);
    setMusicWad(wad);
    const seen: string[] = [];
    for (let ep = 1; ep <= 4; ep++) {
      for (let m = 1; m <= 9; m++) {
        const r = resolveLevelSong(ep, m, 'shareware', (n) => wad.has(n));
        sStartLevel(ep, m);
        seen.push(r.lump);
        expect(musicState()).toMatchObject({ lump: r.lump, missing: 0, musSkipped: 0 });
      }
    }
    expect(seen.length).toBe(36);
    expect(seen[0]).toBe('D_E1M1');
    expect(seen[18]).toBe('D_E3M1');
    // e4 rows took the DIRECT rule (D_E4M1.., §0.10), not the spmus names.
    expect(seen[27]).toBe('D_E4M1');
    expect(seen[35]).toBe('D_E4M9');
    sChangeMusic(28, true);
    expect(musicState().lump).toBe('D_INTER');
    sStartMusic(29);
    expect(musicState().lump).toBe('D_INTRO');
    sChangeMusic(31, true);
    expect(musicState().lump).toBe('D_VICTOR');
    expect(musicState().missing).toBe(0);
    expect(musicState().musSkipped).toBe(0);
    expect(warn).toHaveBeenCalledTimes(0); // zero console noise, 40 songs
  });
});
