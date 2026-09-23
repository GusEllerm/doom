// audio/smfPlayer.ts — SMF event-list → GM synth: pure planner + offline
// renderer + realtime lookahead player (M10-07, M10-plan §M10-07; A-03;
// R10 §4). Owns the §0.6 control-contract half that M10-08 drives.
//
// ONE engine, two clocks (the documented seam, plan §D-10f):
//   * `planMusic(smf)` — PURE planning half (plan: "renderMusicPlanScript —
//     the pure planning half for L1 (voice allocation/order decisions
//     testable node-side)"). Consumes `decodeSmf` output (absolute-µs
//     exact-rational events — the rational tempo math is smf.ts's, NEVER
//     recomputed here; no wall-clock anywhere in the offline path → L1
//     golden determinism) and resolves:
//       - 32-voice pool, per-channel LRU steal (plan §M10-07) —
//         deterministic allocation table (voice idx, patch, t, dur);
//       - channel-state baking (program/CC7/CC10/CC11) into per-note
//         stereo gains (synth.panLaw/channelGain — the same laws realtime);
//       - note-on velocity 0 = note-off (SMF convention, R10 §4.5);
//       - ch 9 (0-based; MIDI "channel 10") percussion auto-release,
//         note-offs ignored there;
//       - CC 120/121/123 = all-notes-off at t (lifecycle acceptance).
//   * Offline: `renderSmfOffline` → synth.ts kernel. Double-render
//     bit-equality is the determinism gate.
//   * Realtime: `SmfPlayer` — the SAME plan + `Synth` nodes scheduled on
//     ctx.currentTime with a 100 ms lookahead window pumped ≥ every 25 ms
//     from the rAF loop (R10 §4.3 "never setTimeout-only"); µs→seconds via
//     `rationalToNumber` is the ONE lossy escape, realtime path only.
//     pause/resume freeze the base clock keeping the schedule (the
//     mus_paused LATCH + music-bus mute are M10-08 / context.suspendForPause).
//   * Loop: FF-end restart at `endT` with +0 gap (plan §M10-07 "FF-end
//     loop = re-schedule full plan at endT (+0 gap — vanilla restart
//     semantics)", s_sound.c:245 level-music loop). `expandLoops` shifts in
//     EXACT rationals, so offline loops stay golden-deterministic.
//
// Zone rule: imports smf.ts (import-only per plan — decoder untouched) and
// synth.ts (same task). No AudioContext import — synth.ts carries the
// structural typings.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { rational, rationalAdd, rationalCmp, rationalToNumber, type Rational, type Smf, type SmfTimedEvent } from './smf';
import {
  channelGain,
  drumKind,
  gmFamily,
  MAX_VOICES,
  panLaw,
  ADSR,
  DRUM_DECAY_US,
  renderNotesOffline,
  type DrumKind,
  type Family,
  type PlannedNote,
  type RenderResult,
  type Synth,
} from './synth';

export type { PlannedNote } from './synth';

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

export interface PlannedChannelEvent {
  readonly seq: number;
  readonly t: Rational;
  readonly channel: number;
  readonly kind: 'program' | 'cc' | 'bend';
  readonly controller?: number;
  readonly value?: number;
  readonly program?: number;
}

export interface MusicPlan {
  readonly division: number;
  readonly endTick: number;
  readonly endT: Rational;
  /** Sorted by (t, seq). */
  readonly notes: readonly PlannedNote[];
  /** Sorted by (t, seq) — realtime replay; offline state is already baked. */
  readonly channelEvents: readonly PlannedChannelEvent[];
  readonly stats: { readonly steals: number; readonly capped: number; readonly drumUnmapped: number };
}

// ---------------------------------------------------------------------------
// Planner (pure)
// ---------------------------------------------------------------------------

const RATIONAL_US = (us: number): Rational => rational(BigInt(us), 1n);

interface VoiceRec {
  ch: number;
  note: number;
  startT: Rational;
  /** Allocation order — the LRU key (startT can tie for same-tick notes). */
  usedSeq: number;
  releaseT: Rational | null;
  /** Envelope release length (µs) applied once released. */
  releaseUs: number;
  /** When the pool slot becomes reusable (∞ while held). */
  endT: Rational | null;
  recIdx: number; // index into note records
}

interface NoteRec {
  seq: number;
  voice: number;
  channel: number;
  note: number;
  velocity: number;
  t: Rational;
  releaseT: Rational | null;
  kind: 'tone' | 'drum';
  family: Family;
  drum: DrumKind;
  program: number;
  gainLeft: number;
  gainRight: number;
  releaseUs: number;
  stolen: boolean;
  ended: boolean;
}

/**
 * Resolve a decoded SMF into a deterministic voice-allocation plan.
 * Allocation order (plan §M10-07): free slot (lowest index) → else steal
 * the OLDEST active voice of the SAME channel (per-channel LRU) → else the
 * oldest voice globally → else drop (`capped`).
 */
export function planMusic(smf: Smf): MusicPlan {
  interface ChState {
    program: number;
    cc7: number;
    cc11: number;
    cc10: number;
    drumCc10: number;
  }
  const ch: ChState[] = [];
  for (let i = 0; i < 16; i++) ch.push({ program: 0, cc7: 127, cc11: 127, cc10: 64, drumCc10: 64 });

  const voices: (VoiceRec | null)[] = new Array(MAX_VOICES).fill(null);
  const held: Map<number, number>[] = []; // channel → note → voice idx (last note-on wins)
  for (let i = 0; i < 16; i++) held.push(new Map());

  const records: NoteRec[] = [];
  const channelEvents: PlannedChannelEvent[] = [];
  let seq = 0;
  let steals = 0;
  let capped = 0;
  let drumUnmapped = 0;

  const voiceEnd = (v: VoiceRec): Rational | null =>
    v.releaseT === null ? null : rationalAdd(v.releaseT, RATIONAL_US(v.releaseUs));

  const releaseVoice = (vi: number, t: Rational): void => {
    const v = voices[vi];
    if (v == null || v.releaseT !== null) return;
    v.releaseT = t;
    v.endT = voiceEnd(v);
    const rec = records[v.recIdx];
    if (rec !== undefined && !rec.ended) {
      rec.releaseT = t;
      rec.ended = true;
    }
    held[v.ch]!.delete(v.note);
  };

  const notesOffAll = (channel: number, t: Rational): void => {
    const h = held[channel]!;
    for (const vi of [...h.values()]) releaseVoice(vi, t);
    h.clear();
  };
  for (const e of smf.events as readonly SmfTimedEvent[]) {
    const t = e.time;
    const ev = e.event;
    switch (ev.kind) {
      case 'programChange': {
        ch[ev.channel]!.program = ev.program & 0x7f;
        channelEvents.push({ seq: seq++, t, channel: ev.channel, kind: 'program', program: ev.program & 0x7f });
        break;
      }
      case 'controlChange': {
        channelEvents.push({ seq: seq++, t, channel: ev.channel, kind: 'cc', controller: ev.controller, value: ev.value });
        const st = ch[ev.channel]!;
        if (ev.controller === 7) st.cc7 = ev.value;
        else if (ev.controller === 11) st.cc11 = ev.value;
        else if (ev.controller === 10) st.cc10 = ev.value;
        else if (ev.controller === 120 || ev.controller === 121 || ev.controller === 123) notesOffAll(ev.channel, t);
        break;
      }
      case 'pitchBend': {
        channelEvents.push({ seq: seq++, t, channel: ev.channel, kind: 'bend', value: ev.value });
        break;
      }
      case 'noteOn': {
        if (ev.velocity === 0) {
          // SMF convention: note-on velocity 0 == note-off (R10 §4.5).
          const vi = held[ev.channel]!.get(ev.note);
          if (vi !== undefined) releaseVoice(vi, t);
          break;
        }
        const isDrum = ev.channel === 9;
        // Re-articulation of a HELD pitch releases the previous voice at t
        // (pinned: latest note-on owns the pitch for the later note-off).
        if (!isDrum) {
          const prev = held[ev.channel]!.get(ev.note & 0x7f);
          if (prev !== undefined) releaseVoice(prev, t);
        }
        const program = ch[ev.channel]!.program;
        const family: Family = isDrum ? 'saw' : gmFamily(program);
        const drum: DrumKind = isDrum ? drumKind(ev.note) : 'hat';
        if (isDrum && !drumRangeOk(ev.note)) drumUnmapped += 1;
        const gain = channelGain(ch[ev.channel]!.cc7, ch[ev.channel]!.cc11);
        const pan = panLaw(ch[ev.channel]!.cc10);
        const gl = isDrum ? pan.left : gain * pan.left;
        const gr = isDrum ? pan.right : gain * pan.right;

        // --- allocation (plan: free → per-channel LRU steal → global LRU) ---
        let vi = voices.findIndex((v) => v === null || (v.endT !== null && rationalCmp(v.endT, t) <= 0));
        let stolen = false;
        if (vi === -1) {
          const active = (v: VoiceRec | null | undefined): v is VoiceRec =>
            v != null && (v.endT === null || rationalCmp(v.endT, t) > 0);
          const older = (a: VoiceRec, b: VoiceRec): boolean => a.usedSeq < b.usedSeq;
          let best = -1;
          for (let i = 0; i < voices.length; i++) {
            const v = voices[i];
            if (!active(v) || v.ch !== ev.channel) continue; // per-channel LRU first
            if (best === -1 || older(v, voices[best]!)) best = i;
          }
          if (best === -1) {
            for (let i = 0; i < voices.length; i++) {
              const v = voices[i];
              if (!active(v)) continue;
              if (best === -1 || older(v, voices[best]!)) best = i;
            }
          }
          if (best === -1) {
            capped += 1; // cannot happen with endT math, kept for the census
            break;
          }
          releaseVoice(best, t); // 2 ms release envelope on the victim
          vi = best;
          stolen = true;
          steals += 1;
        }
        const recIdx = records.length;
        const noteSeq = seq++;
        const rec: NoteRec = {
          seq: noteSeq,
          voice: vi,
          channel: ev.channel,
          note: ev.note & 0x7f,
          velocity: ev.velocity & 0x7f,
          t,
          releaseT: null,
          kind: isDrum ? 'drum' : 'tone',
          family,
          drum,
          program,
          gainLeft: gl,
          gainRight: gr,
          releaseUs: 0,
          stolen,
          ended: false,
        };
        rec.releaseUs = isDrum ? DRUM_DECAY_US[drum] : ADSR[family].releaseUs;
        records.push(rec);
        const v: VoiceRec = {
          ch: ev.channel,
          note: ev.note & 0x7f,
          startT: t,
          usedSeq: noteSeq,
          releaseT: isDrum ? t : null, // drums auto-release at note start
          releaseUs: rec.releaseUs,
          endT: null,
          recIdx,
        };
        if (isDrum) {
          v.endT = voiceEnd(v);
          rec.releaseT = t;
          rec.ended = true;
        } else {
          held[ev.channel]!.set(ev.note & 0x7f, vi);
        }
        voices[vi] = v;
        break;
      }
      case 'noteOff': {
        const vi = held[ev.channel]!.get(ev.note & 0x7f);
        if (vi !== undefined) releaseVoice(vi, t); // drum note-offs: voice already released → no-op
        break;
      }
      default:
        break; // tempo/meta: timing already baked into t
    }
  }

  // Flush: every still-held note releases at endT (loop boundary = plan end).
  for (let c = 0; c < 16; c++) notesOffAll(c, smf.endT);

  const notes: PlannedNote[] = records.map((r) => ({
    seq: r.seq,
    voice: r.voice,
    channel: r.channel,
    note: r.note,
    velocity: r.velocity,
    t: r.t,
    releaseT: r.releaseT ?? smf.endT,
    kind: r.kind,
    family: r.family,
    drum: r.drum,
    program: r.program,
    gainLeft: r.gainLeft,
    gainRight: r.gainRight,
    stolen: r.stolen,
  }));
  notes.sort((a, b) => rationalCmp(a.t, b.t) || a.seq - b.seq);
  channelEvents.sort((a, b) => rationalCmp(a.t, b.t) || a.seq - b.seq);

  return {
    division: smf.division,
    endTick: smf.endTick,
    endT: smf.endT,
    notes,
    channelEvents,
    stats: { steals, capped, drumUnmapped },
  };
}

/** GM note-range coverage of the 4 drum archetypes (32..57 pinned by synth). */
function drumRangeOk(note: number): boolean {
  return note >= 32 && note <= 57;
}

/**
 * Loop expansion: `cycles` copies at k·endT, EXACT rationals, +0 gap
 * (plan §M10-07 vanilla restart semantics). `cycles` 1 = identity copy.
 */
export function expandLoops(plan: MusicPlan, cycles: number): MusicPlan {
  if (cycles <= 1) return { ...plan, notes: [...plan.notes], channelEvents: [...plan.channelEvents] };
  const notes: PlannedNote[] = [];
  const channelEvents: PlannedChannelEvent[] = [];
  let s = rational(0n, 1n);
  for (let k = 0; k < cycles; k++) {
    for (const n of plan.notes) {
      notes.push({
        ...n,
        seq: n.seq + k * plan.notes.length,
        t: rationalAdd(n.t, s),
        releaseT: rationalAdd(n.releaseT, s),
      });
    }
    for (const c of plan.channelEvents) channelEvents.push({ ...c, seq: c.seq + k * plan.channelEvents.length, t: rationalAdd(c.t, s) });
    s = rationalAdd(s, plan.endT);
  }
  notes.sort((a, b) => rationalCmp(a.t, b.t) || a.seq - b.seq);
  channelEvents.sort((a, b) => rationalCmp(a.t, b.t) || a.seq - b.seq);
  return { ...plan, notes, channelEvents };
}

// ---------------------------------------------------------------------------
// Offline render (golden path: decode → plan → kernel; no wall clock)
// ---------------------------------------------------------------------------

export function renderPlanOffline(
  plan: MusicPlan,
  opts: { sampleRate: number; seconds: number; loops?: number },
): RenderResult {
  const expanded = expandLoops(plan, opts.loops ?? 1);
  return renderNotesOffline(expanded.notes, opts.sampleRate, opts.seconds);
}

/** One-shot: decode (caller) → plan → offline buffer. */
export function renderSmfOffline(
  smf: Smf,
  opts: { sampleRate: number; seconds: number; loops?: number },
): RenderResult {
  return renderPlanOffline(planMusic(smf), opts);
}

// ---------------------------------------------------------------------------
// Realtime player (same plan, ctx.currentTime clock, documented seam)
// ---------------------------------------------------------------------------

/** Lookahead window, s (plan §M10-07: "100 ms window"). */
export const LOOKAHEAD_S = 0.1;
/** Recommended pump period, ms (plan: "25 ms pump", driven from the rAF loop). */
export const PUMP_INTERVAL_MS = 25;

interface Action {
  readonly t: Rational;
  readonly seq: number;
  readonly note?: PlannedNote;
  readonly msg?: PlannedChannelEvent;
}

/**
 * Realtime SMF player. `play` captures the plan; `pump(nowSec)` (call from
 * the rAF loop every `PUMP_INTERVAL_MS`) schedules every action whose
 * absolute time falls inside [now, now + LOOKAHEAD_S). Loops re-arm at
 * `endT` with +0 gap by advancing a cycle offset (rational-exact until the
 * documented µs→s escape at schedule time).
 */
export class SmfPlayer {
  private readonly synth: Synth;
  private actions: Action[] = [];
  private cursor = 0;
  private base = 0;
  private cycle = 0;
  private endTSec = 0;
  private looping = false;
  private playingFlag = false;
  private pausedAt: number | null = null;
  scheduled = 0; // census (debug seam)

  constructor(synth: Synth) {
    this.synth = synth;
  }

  get playing(): boolean {
    return this.playingFlag;
  }
  get paused(): boolean {
    return this.pausedAt !== null;
  }

  play(smf: Smf, loop: boolean, nowSec: number): MusicPlan {
    const plan = planMusic(smf);
    this.playPlan(plan, loop, nowSec);
    return plan;
  }

  playPlan(plan: MusicPlan, loop: boolean, nowSec: number): void {
    this.actions = [
      ...plan.notes.map((n) => ({ t: n.t, seq: n.seq, note: n })),
      ...plan.channelEvents.map((c) => ({ t: c.t, seq: c.seq, msg: c })),
    ].sort((a, b) => rationalCmp(a.t, b.t) || a.seq - b.seq);
    this.cursor = 0;
    this.cycle = 0;
    this.base = nowSec;
    this.endTSec = rationalToNumber(plan.endT) / 1_000_000;
    this.looping = loop;
    this.pausedAt = null;
    this.playingFlag = this.actions.length > 0;
  }

  stop(nowSec: number): void {
    this.playingFlag = false;
    this.pausedAt = null;
    this.cursor = this.actions.length;
    this.synth.stopAll(nowSec);
  }

  /** Freeze the timeline keeping the schedule (resume shifts the base). */
  pause(nowSec: number): void {
    if (this.playingFlag && this.pausedAt === null) this.pausedAt = nowSec;
  }

  resume(nowSec: number): void {
    if (this.pausedAt !== null) {
      this.base += nowSec - this.pausedAt; // freeze the timeline keeping the schedule
      this.pausedAt = null;
    }
  }

  /** Position inside the current cycle, seconds (debug/tests). */
  position(nowSec: number): number {
    if (!this.playingFlag) return 0;
    return Math.max(0, nowSec - this.base - this.cycle * this.endTSec);
  }

  /** Schedule everything inside the lookahead window; returns ops issued. */
  pump(nowSec: number): number {
    if (!this.playingFlag || this.pausedAt !== null) return 0;
    let issued = 0;
    const horizon = nowSec + LOOKAHEAD_S;
    // Loop wrap: past the cycle end, advance the cycle offset (+0 gap).
    for (;;) {
      if (this.cursor >= this.actions.length) {
        if (!this.looping || this.endTSec <= 0) {
          this.playingFlag = false;
          break;
        }
        this.cycle += 1;
        this.cursor = 0;
      }
      const a = this.actions[this.cursor]!;
      const when = this.base + this.cycle * this.endTSec + rationalToNumber(a.t) / 1_000_000;
      if (when >= horizon) break;
      if (when >= nowSec) {
        if (a.note !== undefined) {
          this.synth.startNote(
            a.note,
            when,
            this.base + this.cycle * this.endTSec + rationalToNumber(a.note.releaseT) / 1_000_000,
          );
        } else if (a.msg !== undefined) {
          this.synth.applyChannelEvent(a.msg, when);
        }
        this.scheduled += 1;
        issued += 1;
      }
      // Past-due events (stall/late pump): skip silently, keep the grid.
      this.cursor += 1;
    }
    return issued;
  }
}
