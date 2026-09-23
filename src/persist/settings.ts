// persist/settings.ts — M11-07: the default.cfg variable set ≡ the IDB
// settings store (M11-plan §M11-07, §0.6, D-11b, D-11d).
//
// WHAT EXISTS IN VANILLA (verified against the mirror's m_misc.c
// defaults[] table at :234-299, line-pinned in VAR_SPECS below):
//   mouse_sensitivity :236=5 · sfx_volume :237=8 · music_volume :238=8
//   show_messages :239=1 · key_right/left/up/down :243-246 (arrows)
//   key_strafeleft ',' :247 · key_straferight '.' :248 · key_fire RCTRL
//   :250 · key_use ' ' :251 · key_strafe RALT :252 · key_speed RSHIFT
//   :253 · use_mouse :268=1 · mouseb_fire/strafe/forward :269-271=0/1/2
//   · use_joystick :273=0 · joyb_fire/strafe/use/speed :274-277=0/1/3/2
//   · screenblocks :279=9 · detaillevel :280=0 · snd_channels :282=3
//   · usegamma :286=0 · chatmacro0-9 :288-297 (chat deferred, §0.8).
// NOT variables of 1.10 (checked; later-engine inventions, NOT persisted
// here): `sfx`, `mouseacceleration` (3.x), `msg_on_screen` (the 1.10
// variable is `show_messages`), `vid_gamma` (1.10 gamma = the static
// gammatable[usegamma] in i_video.c:565-569 — `usegamma` is the ONLY
// gamma variable), `hud_*` (DOOM 95/1.9). The #ifdef NORMALUNIX/SNDSERV/
// LINUX rows (sndserver :257, mb_used :258, mousedev :264, mousetype
// :265) are unix-device rows with no browser meaning — excluded, listed
// in the test census. chatmacro0-9: chat is netgame-only, Post-M12
// (plan §3 deferred list) — schema omits them, counted here, not silent.
//
// MODEL: one-way on boot (IDB record → in-memory model, `hydrate()` —
// M11-10 awaits it BEFORE the first tick; the IDB read is off the sim
// clock, D-11b) and WRITE-ON-CHANGE with a debounce while the session
// runs (vanilla writes only at quit via I_Quit→M_SaveDefaults,
// i_system.c:121/m_misc.c:308 — a browser never quits, D-11b).
//
// APPLICATION (what settings.ts touches DIRECTLY is only the exported
// homes it is allowed to consume): sfx/music volume → audio/volumes.ts
// setSfxThermo/setMusicThermo (the M10-09 merged homes); the ten key_*
// variables → input/bindStore applyConfigVars/serialization (bindStore
// is M11-03's data face — the key_* rows of default.cfg, :243-253).
// Everything else (sensitivity/mouse buttons/screenblocks/detail/gamma/
// messages/joystick/channels) is READ by the consumer mounts that M11-10
// registers from main.ts via applySettings(listener) / getVarsView().
//
// FAILURE LADDER (M11-01 reuse, never a crash): openStore already
// degrades to the in-memory adapter when IndexedDB is absent/blocked;
// a REJECTED store read or a corrupt record ⇒ whole-record defaults
// (report.problems says why); a single bad value ⇒ that variable falls
// back to its m_misc.c default (per-variable coercion, problems lists
// each). Nothing below ever throws across hydrate.
//
// Zone rule (A-06/D-11g): imports ./store (same zone), audio/volumes
// exported setters, input/bindStore (data face) — no sim/render/platform.
// No indexedDB access at import time (store opens lazily in hydrate).
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { setMusicThermo, setSfxThermo } from '../audio/volumes';
import {
  KEY_VANILLA_VARS,
  bindStore,
  vanillaKeyCode,
  type BindStore
} from '../input/bindStore';
import type { Backend } from './idb';
import { openStore, type PersistError, type PersistStore } from './store';

/** Settings-record schema (record-shape changes bump this; :schema >
 * ours ⇒ treated as corrupt ⇒ defaults, never a partial guess). */
export const SETTINGS_SCHEMA_VERSION = 1;

/** The kv key of the record inside the `settings` object store
 * (store.putSettings merge-writes top-level keys; ours is one). */
export const SETTINGS_KEY = 'settings';

/** Default debounce for write-on-change (D-11b). */
export const DEBOUNCE_MS = 200;

/* ------------------------------------------------------------------ */
/* The non-key variable set (m_misc.c:236-286)                          */
/* ------------------------------------------------------------------ */

export type ConfigVarName =
  | 'mouse_sensitivity'
  | 'sfx_volume'
  | 'music_volume'
  | 'show_messages'
  | 'use_mouse'
  | 'mouseb_fire'
  | 'mouseb_strafe'
  | 'mouseb_forward'
  | 'use_joystick'
  | 'joyb_fire'
  | 'joyb_strafe'
  | 'joyb_use'
  | 'joyb_speed'
  | 'screenblocks'
  | 'detaillevel'
  | 'snd_channels'
  | 'usegamma';

/** Typed face of the persisted (non-key) default.cfg variables. The
 * joystick/snd_channels rows are PERSISTED but INERT in M11 (no joystick
 * device, M10 mixer owns voices) — faithful to the table, plan §3. */
export interface ConfigVars extends Record<ConfigVarName, number> {
  /** m_misc.c:236 — mouse turn scale (menu 0..9, m_menu.c:1118-1123). */
  mouse_sensitivity: number;
  /** m_misc.c:237 — thermo 0..15 (snd_SfxVolume = *8 law, volumes.ts). */
  sfx_volume: number;
  /** m_misc.c:238 — thermo 0..15. */
  music_volume: number;
  /** m_misc.c:239 — showMessages (hu_stuff/m_msg pump). */
  show_messages: number;
  /** m_misc.c:268 */
  use_mouse: number;
  /** m_misc.c:269 — mouse button → fire (0-based index). */
  mouseb_fire: number;
  /** m_misc.c:270 */
  mouseb_strafe: number;
  /** m_misc.c:271 */
  mouseb_forward: number;
  /** m_misc.c:273 — inert (no joystick device in M11). */
  use_joystick: number;
  /** m_misc.c:274-277 — inert joystick button map. */
  joyb_fire: number;
  joyb_strafe: number;
  joyb_use: number;
  joyb_speed: number;
  /** m_misc.c:279 — 3..11 (R_ExecuteSetViewSize, r_main.c:653-690). */
  screenblocks: number;
  /** m_misc.c:280 — 0..1 (M_ChangeDetail m_menu.c:1134). */
  detaillevel: number;
  /** m_misc.c:282 — inert; validated 1..3 (classic channel count). */
  snd_channels: number;
  /** m_misc.c:286 — 0..4 (gammatable row, m_menu.c:1598-1600). The ONLY
   * gamma variable — 1.10 has no `vid_gamma` variable. */
  usegamma: number;
}

/** The m_misc.c defaults table values (the mirror-gate counterpart —
 * settings.test.ts cross-checks every row against m_misc.c:234-299). */
export const DEFAULT_CONFIG_VARS: Readonly<ConfigVars> = {
  mouse_sensitivity: 5, // m_misc.c:236
  sfx_volume: 8, // :237
  music_volume: 8, // :238
  show_messages: 1, // :239
  use_mouse: 1, // :268
  mouseb_fire: 0, // :269
  mouseb_strafe: 1, // :270
  mouseb_forward: 2, // :271
  use_joystick: 0, // :273
  joyb_fire: 0, // :274
  joyb_strafe: 1, // :275
  joyb_use: 3, // :276
  joyb_speed: 2, // :277
  screenblocks: 9, // :279
  detaillevel: 0, // :280
  snd_channels: 3, // :282
  usegamma: 0 // :286
};

interface VarSpec {
  readonly cite: string;
  readonly min: number;
  readonly max: number;
}

/** Coercion law: integer inside [min,max] or the variable falls back to
 * its default (corrupt-value ladder). Ranges come from the vanilla CODE
 * that clamps each variable, not our taste. */
const VAR_SPECS: Readonly<Record<ConfigVarName, VarSpec>> = {
  mouse_sensitivity: { cite: 'm_misc.c:236', min: 0, max: 9 }, // m_menu.c:1118-1123
  sfx_volume: { cite: 'm_misc.c:237', min: 0, max: 15 }, // thermo clamp volumes.ts:101-108
  music_volume: { cite: 'm_misc.c:238', min: 0, max: 15 },
  show_messages: { cite: 'm_misc.c:239', min: 0, max: 1 },
  use_mouse: { cite: 'm_misc.c:268', min: 0, max: 1 },
  mouseb_fire: { cite: 'm_misc.c:269', min: 0, max: 255 },
  mouseb_strafe: { cite: 'm_misc.c:270', min: 0, max: 255 },
  mouseb_forward: { cite: 'm_misc.c:271', min: 0, max: 255 },
  use_joystick: { cite: 'm_misc.c:273', min: 0, max: 1 },
  joyb_fire: { cite: 'm_misc.c:274', min: 0, max: 255 },
  joyb_strafe: { cite: 'm_misc.c:275', min: 0, max: 255 },
  joyb_use: { cite: 'm_misc.c:276', min: 0, max: 255 },
  joyb_speed: { cite: 'm_misc.c:277', min: 0, max: 255 },
  screenblocks: { cite: 'm_misc.c:279', min: 3, max: 11 }, // r_main.c screensize
  detaillevel: { cite: 'm_misc.c:280', min: 0, max: 1 },
  snd_channels: { cite: 'm_misc.c:282', min: 1, max: 3 },
  usegamma: { cite: 'm_misc.c:286', min: 0, max: 4 } // m_menu.c:1598-1600
};

/** Names of the ten key_* variables (m_misc.c:243-253) — the list comes
 * from bindStore's data face so there is ONE table (M11-03's cites). */
export const KEY_VAR_NAMES: readonly string[] = KEY_VANILLA_VARS.map((v) => v.name);

/** Any persisted variable name (default.cfg's own namespace). */
export type SettingsVarName = ConfigVarName | (typeof KEY_VAR_NAMES)[number];

/* ------------------------------------------------------------------ */
/* Record shape                                                         */
/* ------------------------------------------------------------------ */

export interface SettingsRecord {
  schema: number;
  vars: ConfigVars;
  /** The ten key_* variables as vanilla key codes (0 = channel not
   * served by the variable's key; vanilla stores exactly these ints). */
  keys: Record<string, number>;
}

/** The m_misc.c default byte of a variable’s key. Prefer the data-face
 * defaultKey; the keyboard↔mapping import cycle can leave those fields
 * undefined at eval time depending on module order (latent M11-03-area
 * bug, filed as follow-up), and the DOM-code transcription is the same
 * byte by construction — resolve through it as the fallback. */
function defaultByte(v: { domCode: string; defaultKey: number }): number {
  return v.defaultKey ?? vanillaKeyCode(v.domCode);
}

/** Build the key_* variable map from the LIVE bind table: for each of
 * the ten variables, the vanilla code of the key currently serving the
 * channel — preferring the variable’s own default key while it still
 * holds (multi-key A-09 rows with no vanilla face, like KeyW, read as
 * the default and are NOT part of the cfg state — D-11d). */
export function keyVarsOf(binds: BindStore = bindStore): Record<string, number> {
  const table = binds.bindings();
  const out: Record<string, number> = {};
  for (const v of KEY_VANILLA_VARS) {
    const own = table.find((b) => b.code === v.domCode && b.action === v.channel);
    if (own) {
      out[v.name] = defaultByte(v);
      continue;
    }
    const other = table.find((b) => b.action === v.channel);
    out[v.name] = other ? vanillaKeyCode(other.code) : 0;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Controller                                                           */
/* ------------------------------------------------------------------ */

/** Read view handed to consumer mounts (M11-10 registers these). */
export interface SettingsView {
  readonly loaded: boolean;
  readonly vars: Readonly<ConfigVars>;
  readonly keys: Readonly<Record<string, number>>;
}

export type SettingsListener = (view: SettingsView, changed: readonly string[]) => void;

export interface HydrateReport {
  loaded: true;
  /** 'store' = record read and merged; 'defaults' = nothing stored OR the
   * read failed OR the record was corrupt (problems says which). */
  source: 'store' | 'defaults';
  backend: Backend;
  problems: string[];
  /** typed store failure when the read itself failed (ladder rung 1). */
  error?: PersistError;
  applied: { vars: number; keys: { applied: string[]; skipped: string[] } };
}

export interface SettingsStatus {
  loaded: boolean;
  backend: Backend | 'unopened';
  dirty: boolean;
  writePending: boolean;
  lastWrite?: { ok: boolean; error?: PersistError };
}

export interface SettingsControllerOptions {
  /** Injected store (tests); default: lazily openStore() on first use. */
  store?: PersistStore;
  debounceMs?: number;
  /** Injected bind table (tests); default: the process bindStore. */
  binds?: BindStore;
}

export interface SettingsController {
  /** Async boot read (M11-10: AWAIT before the first tick). Optional
   * listener is mounted and fired once hydration completes. Idempotent
   * by re-read: a second call refreshes from the store again. */
  hydrate(fn?: SettingsListener): Promise<HydrateReport>;
  /** MOUNT a consumer: called immediately with the current view, then on
   * every change (changed = the variable names that moved). Returns the
   * unmount function. This is the READ-mount surface M11-10 registers. */
  applySettings(fn: SettingsListener): () => void;
  /** Current read view (defaults until hydrate; NEVER throws). */
  view(): SettingsView;
  /** setVar('screenblocks', 10) / setVar('key_fire', 0x66): validate →
   * model → apply homes → notify mounts → schedule the debounced write.
   * False = value rejected (out of range / uncoercible / skipped bind). */
  setVar(name: string, value: unknown): boolean;
  setMany(patch: Readonly<Record<string, unknown>>): string[];
  /** Drain any pending debounced write NOW (tests, page-hide). */
  flush(): Promise<{ ok: boolean; error?: PersistError }>;
  status(): SettingsStatus;
}

export function createSettingsController(
  options: SettingsControllerOptions = {}
): SettingsController {
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const binds = options.binds ?? bindStore;

  const vars: ConfigVars = { ...DEFAULT_CONFIG_VARS };
  let loaded = false;
  let dirty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inflight: Promise<{ ok: boolean; error?: PersistError }> | null = null;
  let lastWrite: SettingsStatus['lastWrite'];
  let lastReport: HydrateReport | null = null;
  const listeners = new Set<SettingsListener>();

  let storePromise: Promise<PersistStore> | null = options.store
    ? Promise.resolve(options.store)
    : null;
  function ensureStore(): Promise<PersistStore> {
    if (!storePromise) storePromise = openStore();
    return storePromise;
  }
  let lastBackend: Backend | null = options.store ? options.store.backend : null;

  function currentKeys(): Record<string, number> {
    return keyVarsOf(binds);
  }

  function view(): SettingsView {
    return { loaded, vars: { ...vars }, keys: currentKeys() };
  }

  function notify(changed: readonly string[]): void {
    const v = view();
    for (const fn of [...listeners]) fn(v, changed);
  }

  /** Push a variable into its exported home (only the two homes this
   * module is allowed to write; every other consumer READS the view). */
  function applyHome(name: string, value: number): boolean {
    if (name === 'sfx_volume') {
      setSfxThermo(value);
      return true;
    }
    if (name === 'music_volume') {
      setMusicThermo(value);
      return true;
    }
    if ((KEY_VAR_NAMES as readonly string[]).includes(name)) {
      const r = binds.applyConfigVars({ [name]: value });
      return r.applied.includes(name);
    }
    return false; // consumer-mounted (sensitivity, screenblocks, ...)
  }

  function coerce(name: ConfigVarName, raw: unknown): { ok: boolean; value?: number } {
    const spec = VAR_SPECS[name];
    if (typeof raw !== 'number' || !Number.isInteger(raw)) return { ok: false };
    if (raw < spec.min || raw > spec.max) return { ok: false };
    return { ok: true, value: raw };
  }

  async function hydrate(fn?: SettingsListener): Promise<HydrateReport> {
    if (fn) applySettings(fn);
    const problems: string[] = [];
    let source: HydrateReport['source'] = 'defaults';
    let error: PersistError | undefined;
    let nVars = 0;
    const keyResult = { applied: [] as string[], skipped: [] as string[] };

    try {
      const store = await ensureStore();
      lastBackend = store.backend;
      const res = await store.getSettings();
      if (!res.ok) {
        error = res.error;
        problems.push('store-read-failed: using defaults');
      } else {
        const rec: unknown = (res.value as Record<string, unknown>)[SETTINGS_KEY];
        if (rec === undefined) {
          problems.push('no-record: first run, defaults stand');
        } else if (
          typeof rec !== 'object' ||
          rec === null ||
          typeof (rec as SettingsRecord).schema !== 'number' ||
          (rec as SettingsRecord).schema > SETTINGS_SCHEMA_VERSION ||
          (rec as SettingsRecord).schema < 1
        ) {
          // corruption / unknown future schema ⇒ defaults, not a crash.
          problems.push('corrupt-record: using defaults');
        } else {
          const stored = rec as Partial<SettingsRecord>;
          source = 'store';
          const storedVars =
            typeof stored.vars === 'object' && stored.vars !== null
              ? (stored.vars as unknown as Record<string, unknown>)
              : {};
          if (typeof stored.vars !== 'object' || stored.vars === null) {
            problems.push('corrupt-vars: using defaults');
          }
          for (const name of Object.keys(VAR_SPECS) as ConfigVarName[]) {
            const c = coerce(name, storedVars[name]);
            if (c.ok && c.value !== undefined) {
              if (vars[name] !== c.value) nVars++;
              vars[name] = c.value;
            } else {
              vars[name] = DEFAULT_CONFIG_VARS[name];
              problems.push(`invalid:${name}: default substituted`);
            }
          }
          const storedKeys =
            typeof stored.keys === 'object' && stored.keys !== null
              ? (stored.keys as Record<string, unknown>)
              : {};
          const clean: Record<string, number> = {};
          for (const name of KEY_VAR_NAMES) {
            const v = storedKeys[name];
            if (v === undefined) continue;
            if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 0xff) {
              problems.push(`invalid:${name}: skipped`);
              continue;
            }
            clean[name] = v;
          }
          const ar = binds.applyConfigVars(clean);
          keyResult.applied = ar.applied;
          keyResult.skipped = ar.skipped;
        }
      }
    } catch (e) {
      // Last rung: NOTHING throws across hydrate (M11-10 boot contract).
      problems.push('hydrate-threw: using defaults');
      void e;
    }

    // Apply the homes unconditionally after the ladder resolved the model
    // (vanilla applies its defaults the same way: M_LoadDefaults FIRST,
    // cfg values on top).
    setSfxThermo(vars.sfx_volume);
    setMusicThermo(vars.music_volume);
    loaded = true;
    lastReport = {
      loaded: true,
      source,
      backend: lastBackend ?? 'memory',
      problems,
      ...(error ? { error } : {}),
      applied: { vars: nVars, keys: keyResult }
    };
    notify(Object.keys(VAR_SPECS));
    return lastReport;
  }

  function setVar(name: string, value: unknown): boolean {
    let changedName: string | null = null;
    if ((VAR_SPECS as Record<string, VarSpec | undefined>)[name] !== undefined) {
      const c = coerce(name as ConfigVarName, value);
      if (!c.ok) return false;
      const key = name as ConfigVarName;
      if (vars[key] === c.value && name !== 'sfx_volume' && name !== 'music_volume') {
        return true;
      }
      vars[key] = c.value!;
      changedName = name;
      applyHome(name, c.value!);
    } else if ((KEY_VAR_NAMES as readonly string[]).includes(name)) {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 0xff) {
        return false;
      }
      if (!applyHome(name, value)) return false;
      changedName = name;
    } else {
      return false; // not a default.cfg variable
    }
    dirty = true;
    schedule();
    notify([changedName!]);
    return true;
  }

  function setMany(patch: Readonly<Record<string, unknown>>): string[] {
    const applied: string[] = [];
    for (const [name, value] of Object.entries(patch)) {
      if (setVar(name, value)) applied.push(name);
    }
    return applied;
  }

  function schedule(): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void writeNow();
    }, debounceMs);
    // node test hosts: never hold the event loop for a debounce alone.
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  async function writeNow(): Promise<{ ok: boolean; error?: PersistError }> {
    if (inflight) {
      await inflight; // serialize writers
    }
    if (!dirty) return lastWrite ?? { ok: true };
    dirty = false;
    const task = (async () => {
      try {
        const store = await ensureStore();
        lastBackend = store.backend;
        const rec: SettingsRecord = {
          schema: SETTINGS_SCHEMA_VERSION,
          vars: { ...vars },
          keys: currentKeys()
        };
        const res = await store.putSettings({ [SETTINGS_KEY]: rec });
        lastWrite = res.ok ? { ok: true } : { ok: false, error: res.error };
      } catch (e) {
        lastWrite = { ok: false, error: { code: 'io-failure', message: String(e) } };
      }
      return lastWrite!;
    })();
    inflight = task;
    const out = await task;
    if (inflight === task) inflight = null;
    return out;
  }

  async function flush(): Promise<{ ok: boolean; error?: PersistError }> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return writeNow();
  }

  function status(): SettingsStatus {
    return {
      loaded,
      backend: storePromise === null ? 'unopened' : lastBackend ?? 'unopened',
      dirty,
      writePending: timer !== null || inflight !== null,
      ...(lastWrite ? { lastWrite } : {})
    };
  }

  function applySettings(fn: SettingsListener): () => void {
    listeners.add(fn);
    fn(view(), []);
    return () => listeners.delete(fn);
  }

  return { hydrate, applySettings, view, setVar, setMany, flush, status };
}

/* ------------------------------------------------------------------ */
/* Process singleton (the face M11-10 mounts from main.ts)              */
/* ------------------------------------------------------------------ */

let instance: SettingsController | null = null;

/** The boot controller (lazy; no indexedDB access until hydrate). */
export function settings(): SettingsController {
  if (!instance) instance = createSettingsController();
  return instance;
}

/** Boot read — AWAIT BEFORE THE FIRST TICK (M11-10); never rejects. */
export function hydrateSettings(fn?: SettingsListener): Promise<HydrateReport> {
  return settings().hydrate(fn);
}

/** Register a consumer read-mount (called immediately + on change). */
export function applySettings(fn: SettingsListener): () => void {
  return settings().applySettings(fn);
}

export function setSetting(name: string, value: unknown): boolean {
  return settings().setVar(name, value);
}

export function flushSettings(): Promise<{ ok: boolean; error?: PersistError }> {
  return settings().flush();
}

/** Test seam: drop the singleton (fresh defaults next time). */
export function __resetSettingsForTests(): void {
  instance = null;
}
