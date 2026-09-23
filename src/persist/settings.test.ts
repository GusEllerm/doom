// persist/settings.test.ts — M11-07 acceptance battery.
//
// 1. VAR TABLE vs m_misc.c: the committed census (below) mirrors the
//    defaults[] table of m_misc.c:234-299 line-for-line; when a source
//    mirror is present (DOOM_MIRROR=<dir>, else /tmp/DOOM-master/
//    linuxdoom-1.10 if it exists) the parse is re-checked LIVE, same
//    convention as src/wad/info/states.test.ts. Also asserts the
//    later-engine rows that DO NOT exist in 1.10 (sfx,
//    mouseacceleration, msg_on_screen, vid_gamma, hud_*) are absent.
// 2. Defaults: DEFAULT_CONFIG_VARS values byte-equal the table (cite in
//    the failure message via the census join).
// 3. Round-trip via the memory adapter (setVar → flush → fresh
//    controller + fresh bind store → hydrate ⇒ same state, homes live).
// 4. Hydrate-before-first-tick: with an async store, ticks see defaults
//    until `await hydrate()` resolves, then the stored values (the
//    async gate M11-10 consumes).
// 5. Corruption ladder: garbage record / unknown schema / bad values /
//    rejected store read ⇒ defaults (whole-record or per-var), reported
//    in HydrateReport.problems, NEVER a throw.
// 6. Debounce: N changes ⇒ ONE putSettings; flush forces it.
//
// Homes touched for real: audio/volumes thermos + input/bindStore —
// reset in afterEach so nothing leaks into other files' globals.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetVolumesToDefaults, musicThermo, sfxThermo } from '../audio/volumes';
import { resetBindStore, bindStore } from '../input/bindStore';
import { openStore, type PersistStore } from './store';
import {
  DEFAULT_CONFIG_VARS,
  KEY_VAR_NAMES,
  SETTINGS_KEY,
  SETTINGS_SCHEMA_VERSION,
  createSettingsController,
  keyVarsOf,
  type SettingsRecord
} from './settings';

/* ------------------------------------------------------------------ */
/* 1. The m_misc.c census (mirror gate — committed face)                */
/* ------------------------------------------------------------------ */

interface MiscRow {
  /** line in the mirror's m_misc.c (defaults[] block) */
  readonly line: number;
  readonly name: string;
  /** literal as written in the table (numbers) or a named code */
  readonly value: number | string;
  readonly group: 'var' | 'key' | 'chat' | 'unix-only';
}

const MISC_TABLE: readonly MiscRow[] = [
  { line: 236, name: 'mouse_sensitivity', value: 5, group: 'var' },
  { line: 237, name: 'sfx_volume', value: 8, group: 'var' },
  { line: 238, name: 'music_volume', value: 8, group: 'var' },
  { line: 239, name: 'show_messages', value: 1, group: 'var' },
  { line: 243, name: 'key_right', value: 0xae, group: 'key' }, // KEY_RIGHTARROW
  { line: 244, name: 'key_left', value: 0xac, group: 'key' },
  { line: 245, name: 'key_up', value: 0xad, group: 'key' },
  { line: 246, name: 'key_down', value: 0xaf, group: 'key' },
  { line: 247, name: 'key_strafeleft', value: 0x2c, group: 'key' }, // ','
  { line: 248, name: 'key_straferight', value: 0x2e, group: 'key' }, // '.'
  { line: 250, name: 'key_fire', value: 0x9d, group: 'key' }, // KEY_RCTRL
  { line: 251, name: 'key_use', value: 0x20, group: 'key' }, // ' '
  { line: 252, name: 'key_strafe', value: 0xb8, group: 'key' }, // KEY_RALT
  { line: 253, name: 'key_speed', value: 0xb6, group: 'key' }, // KEY_RSHIFT
  { line: 257, name: 'sndserver', value: 'sndserver', group: 'unix-only' },
  { line: 258, name: 'mb_used', value: 2, group: 'unix-only' },
  { line: 264, name: 'mousedev', value: '/dev/ttyS0', group: 'unix-only' },
  { line: 265, name: 'mousetype', value: 'microsoft', group: 'unix-only' },
  { line: 268, name: 'use_mouse', value: 1, group: 'var' },
  { line: 269, name: 'mouseb_fire', value: 0, group: 'var' },
  { line: 270, name: 'mouseb_strafe', value: 1, group: 'var' },
  { line: 271, name: 'mouseb_forward', value: 2, group: 'var' },
  { line: 273, name: 'use_joystick', value: 0, group: 'var' },
  { line: 274, name: 'joyb_fire', value: 0, group: 'var' },
  { line: 275, name: 'joyb_strafe', value: 1, group: 'var' },
  { line: 276, name: 'joyb_use', value: 3, group: 'var' },
  { line: 277, name: 'joyb_speed', value: 2, group: 'var' },
  { line: 279, name: 'screenblocks', value: 9, group: 'var' },
  { line: 280, name: 'detaillevel', value: 0, group: 'var' },
  { line: 282, name: 'snd_channels', value: 3, group: 'var' },
  { line: 286, name: 'usegamma', value: 0, group: 'var' },
  { line: 288, name: 'chatmacro0', value: 'HUSTR_CHATMACRO0', group: 'chat' },
  { line: 289, name: 'chatmacro1', value: 'HUSTR_CHATMACRO1', group: 'chat' },
  { line: 290, name: 'chatmacro2', value: 'HUSTR_CHATMACRO2', group: 'chat' },
  { line: 291, name: 'chatmacro3', value: 'HUSTR_CHATMACRO3', group: 'chat' },
  { line: 292, name: 'chatmacro4', value: 'HUSTR_CHATMACRO4', group: 'chat' },
  { line: 293, name: 'chatmacro5', value: 'HUSTR_CHATMACRO5', group: 'chat' },
  { line: 294, name: 'chatmacro6', value: 'HUSTR_CHATMACRO6', group: 'chat' },
  { line: 295, name: 'chatmacro7', value: 'HUSTR_CHATMACRO7', group: 'chat' },
  { line: 296, name: 'chatmacro8', value: 'HUSTR_CHATMACRO8', group: 'chat' },
  { line: 297, name: 'chatmacro9', value: 'HUSTR_CHATMACRO9', group: 'chat' }
];

const MIRROR =
  process.env.DOOM_MIRROR ??
  ['/tmp/DOOM-master/linuxdoom-1.10', '/tmp/linuxdoom-1.10']
    .find((p) => existsSync(join(p, 'm_misc.c'))) ??
  '';

/** Parse the defaults[] block of a live m_misc.c: name → {line, token}. */
function parseMirrorDefaults(path: string): Map<string, { line: number; token: string }> {
  const src = readFileSync(path, 'latin1');
  const start = src.indexOf('default_t\tdefaults[]');
  if (start < 0) throw new Error('defaults[] block not found');
  const KEY_TOKENS: Record<string, number> = {
    KEY_RIGHTARROW: 0xae,
    KEY_LEFTARROW: 0xac,
    KEY_UPARROW: 0xad,
    KEY_DOWNARROW: 0xaf,
    KEY_RCTRL: 0x9d,
    KEY_RALT: 0xb8,
    KEY_RSHIFT: 0xb6
  };
  const out = new Map<string, { line: number; token: string }>();
  const line0 = src.slice(0, start).split('\n').length;
  src.slice(start).split('\n').forEach((row, i) => {
    const m = /^\s*\{\s*"([^"]+)"\s*,[^,]*,\s*(.*?)\s*\},?\s*$/.exec(row);
    if (!m) return;
    let token = m[2];
    if (token.startsWith('(')) token = token.replace(/^\((?:int|char)\s*\)\s*/, '');
    if (token.startsWith("'")) token = String(token.codePointAt(1));
    else if (/^KEY_/.test(token)) token = String(KEY_TOKENS[token]);
    else if (token.startsWith('"')) token = token.slice(1, -1);
    else if (/^HUSTR_/.test(token)) token = token;
    out.set(m[1], { line: line0 + i, token });
  });
  return out;
}

describe('var table vs m_misc.c (mirror gate)', () => {
  it('the census covers the whole defaults[] table (41 rows)', () => {
    expect(MISC_TABLE.length).toBe(41);
    expect(new Set(MISC_TABLE.map((r) => r.name)).size).toBe(41);
  });

  it('live mirror parse matches the census names + default tokens', (t) => {
    if (!MIRROR || !existsSync(join(MIRROR, 'm_misc.c'))) return t.skip();
    const live = parseMirrorDefaults(join(MIRROR, 'm_misc.c'));
    expect([...live.keys()].sort()).toEqual(MISC_TABLE.map((r) => r.name).sort());
    for (const row of MISC_TABLE) {
      const entry = live.get(row.name);
      expect(entry, row.name).toBeDefined();
      expect(entry!.line, `${row.name} line`).toBe(row.line);
      if (typeof row.value === 'number') {
        // numeric rows agree by VALUE (named constants/char literals were
        // resolved to numbers by the parser above).
        expect(Number(entry!.token), `${row.name} = ${entry!.token} @:${row.line}`).toBe(
          row.value
        );
      }
    }
  });

  it('DEFAULT_CONFIG_VARS ≡ the census `var` rows (name+default)', () => {
    const rows = MISC_TABLE.filter((r) => r.group === 'var');
    expect(Object.keys(DEFAULT_CONFIG_VARS).sort()).toEqual(rows.map((r) => r.name).sort());
    for (const r of rows) {
      expect(
        DEFAULT_CONFIG_VARS[r.name as keyof typeof DEFAULT_CONFIG_VARS],
        `${r.name} (${r.line})`
      ).toBe(r.value);
    }
  });

  it('the ten key_* rows are exactly KEY_VAR_NAMES', () => {
    const rows = MISC_TABLE.filter((r) => r.group === 'key');
    expect(rows).toHaveLength(10);
    expect([...KEY_VAR_NAMES].sort()).toEqual(rows.map((r) => r.name).sort());
  });

  it('1.10 has NO sfx / mouseacceleration / msg_on_screen / vid_gamma / hud rows', () => {
    for (const absent of ['sfx', 'mouseacceleration', 'msg_on_screen', 'vid_gamma']) {
      expect(MISC_TABLE.some((r) => r.name === absent), absent).toBe(false);
    }
    expect(MISC_TABLE.some((r) => r.name.startsWith('hud'))).toBe(false);
    // the 1.10 truth our schema uses INSTEAD of each:
    expect(DEFAULT_CONFIG_VARS.show_messages).toBe(1); // ≡ msg_on_screen
    expect(DEFAULT_CONFIG_VARS.usegamma).toBe(0); // ≡ vid_gamma (variable)
    expect(DEFAULT_CONFIG_VARS.mouse_sensitivity).toBe(5); // no accel var
  });

  it('chatmacro rows are census-listed but schema-absent (chat deferred)', () => {
    expect(MISC_TABLE.filter((r) => r.group === 'chat')).toHaveLength(10);
    for (const name of Object.keys(DEFAULT_CONFIG_VARS)) {
      expect(name).not.toMatch(/^chatmacro/);
    }
  });
});

/* ------------------------------------------------------------------ */
/* lifecycle helpers                                                    */
/* ------------------------------------------------------------------ */

afterEach(() => {
  resetVolumesToDefaults();
  resetBindStore();
  vi.useRealTimers();
});

async function memStore(): Promise<PersistStore> {
  return openStore({ memory: true });
}

describe('defaults + read view', () => {
  it('before hydrate the view is defaults and reports unloaded', async () => {
    const s = createSettingsController({ store: await memStore() });
    expect(s.view().loaded).toBe(false);
    expect(s.view().vars).toEqual(DEFAULT_CONFIG_VARS);
    expect(s.status().backend).toBe('memory');
  });

  it('first hydrate on an empty store ⇒ source defaults, no record', async () => {
    const s = createSettingsController({ store: await memStore() });
    const r = await s.hydrate();
    expect(r).toMatchObject({
      loaded: true,
      source: 'defaults',
      backend: 'memory'
    });
    expect(r.problems).toContain('no-record: first run, defaults stand');
    expect(s.view().vars).toEqual(DEFAULT_CONFIG_VARS);
  });

  it('setVar validates like the cfg law (unknown/out-of-range/bad type)', async () => {
    const s = createSettingsController({ store: await memStore() });
    expect(s.setVar('screenblocks', 10)).toBe(true);
    expect(s.setVar('screenblocks', 2)).toBe(false); // m_menu screensize 3..11
    expect(s.setVar('screenblocks', 12)).toBe(false);
    expect(s.setVar('usegamma', 5)).toBe(false); // m_menu.c:1598-1600 wrap max
    expect(s.setVar('sfx_volume', 16)).toBe(false); // thermo 0..15
    expect(s.setVar('mouse_sensitivity', 10)).toBe(false); // m_menu.c:1118-1123
    expect(s.setVar('nope', 1)).toBe(false);
    expect(s.setVar('detaillevel', 'hi' as unknown as number)).toBe(false);
    expect(s.setVar('key_fire', 1.5)).toBe(false);
    expect(s.setVar('key_fire', 0x66)).toBe(true); // 'f' → attack channel
    expect(s.view().keys.key_fire).toBe(0x66);
  });
});

describe('round-trip via the memory store', () => {
  it('setVar → flush → fresh controller+binds ⇒ identical state', async () => {
    const store = await memStore();
    const a = createSettingsController({ store, binds: bindStore });
    await a.hydrate();

    const applied = a.setMany({
      mouse_sensitivity: 9,
      sfx_volume: 3,
      music_volume: 1,
      show_messages: 0,
      use_mouse: 0,
      mouseb_forward: 3,
      screenblocks: 11,
      detaillevel: 1,
      snd_channels: 1,
      usegamma: 4,
      key_fire: 0x66 // 'f'
    });
    expect(applied).toHaveLength(11);
    expect(await a.flush()).toEqual({ ok: true });

    // what actually landed in the settings store:
    const snap = await store.getSettings();
    expect(snap.ok).toBe(true);
    const rec = (snap.ok ? snap.value[SETTINGS_KEY] : undefined) as SettingsRecord;
    expect(rec.schema).toBe(SETTINGS_SCHEMA_VERSION);
    expect(rec.vars.screenblocks).toBe(11);
    expect(rec.keys.key_fire).toBe(0x66);
    expect(Object.keys(rec.keys)).toHaveLength(10);

    // "reload": wipe the live homes + binds, hydrate a NEW controller.
    resetVolumesToDefaults();
    resetBindStore();
    const b = createSettingsController({ store, binds: bindStore });
    const rb = await b.hydrate();
    expect(rb.source).toBe('store');
    expect(rb.problems).toEqual([]);
    expect(b.view().vars).toEqual(a.view().vars);
    // homes actually moved:
    expect(sfxThermo()).toBe(3);
    expect(musicThermo()).toBe(1);
    expect(bindStore.get('KeyF')).toBe('attack');
    expect(bindStore.get('ControlRight')).toBeUndefined();
    expect(keyVarsOf(bindStore).key_fire).toBe(0x66);
    // serialization is a fixed point (re-save = same key map):
    b.setVar('screenblocks', 11); // no-op change, triggers write path
    expect(await b.flush()).toEqual({ ok: true });
    const snap2 = await store.getSettings();
    const rec2 = (snap2.ok ? snap2.value[SETTINGS_KEY] : undefined) as SettingsRecord;
    expect(rec2.keys).toEqual(rec.keys);
  });

  it('key_vars stay vanilla-truth: A-09 extras are not cfg state', async () => {
    const s = createSettingsController({ store: await memStore() });
    await s.hydrate();
    const kv = s.view().keys;
    expect(Object.keys(kv)).toEqual([...KEY_VAR_NAMES]);
    // default table → every variable at its m_misc.c default byte
    expect(kv).toEqual({
      key_right: 0xae,
      key_left: 0xac,
      key_up: 0xad,
      key_down: 0xaf,
      key_strafeleft: 0x2c,
      key_straferight: 0x2e,
      key_fire: 0x9d,
      key_use: 0x20,
      key_strafe: 0xb8,
      key_speed: 0xb6
    });
  });
});

describe('hydrate-before-first-tick (async gate for M11-10)', () => {
  it('ticks before `await hydrate()` see defaults; after, the stored state', async () => {
    const store = await memStore();
    // Seed a saved session through a throwaway controller.
    const seed = createSettingsController({ store });
    await seed.hydrate();
    seed.setMany({ screenblocks: 10, sfx_volume: 2 });
    await seed.flush();

    const s = createSettingsController({ store });
    let tickValue = 0;
    const tick = () => {
      tickValue = s.view().vars.screenblocks;
    };
    const boot = s.hydrate(); // async — M11-10 awaits exactly this
    tick(); // a tick BEFORE the await completes
    expect(boot instanceof Promise).toBe(true);
    expect(tickValue).toBe(DEFAULT_CONFIG_VARS.screenblocks); // defaults stand
    const r = await boot;
    tick(); // first tick AFTER hydration
    expect(tickValue).toBe(10);
    expect(r.source).toBe('store');
    expect(sfxThermo()).toBe(2); // volume home applied by hydrate
  });

  it('hydrate never rejects even when the store itself throws', async () => {
    const boom: PersistStore = {
      ...(await memStore()),
      getSettings: () => Promise.reject(new Error('boom'))
    };
    const s = createSettingsController({ store: boom });
    const r = await s.hydrate();
    expect(r.loaded).toBe(true);
    expect(r.source).toBe('defaults');
    expect(r.problems.join()).toContain('hydrate-threw');
    expect(s.view().vars).toEqual(DEFAULT_CONFIG_VARS);
  });
});

describe('failure ladder (corruption → defaults, not crash)', () => {
  async function seeded(mutate: (st: PersistStore) => Promise<void>) {
    const store = await memStore();
    await mutate(store);
    const s = createSettingsController({ store });
    return { s, store };
  }

  it('garbage record ⇒ whole-record defaults, problem listed, no throw', async () => {
    const { s } = await seeded(async (st) => {
      await st.putSettings({ [SETTINGS_KEY]: 'total-garbage' });
    });
    const r = await s.hydrate();
    expect(r.source).toBe('defaults');
    expect(r.problems).toContain('corrupt-record: using defaults');
    expect(s.view().vars).toEqual(DEFAULT_CONFIG_VARS);
  });

  it('future schema ⇒ defaults (we never partial-guess)', async () => {
    const { s } = await seeded(async (st) => {
      await st.putSettings({ [SETTINGS_KEY]: { schema: 99, vars: {} } });
    });
    const r = await s.hydrate();
    expect(r.source).toBe('defaults');
    expect(r.problems).toContain('corrupt-record: using defaults');
  });

  it('rejected store read ⇒ defaults + typed error (M11-01 rung)', async () => {
    const store = await memStore();
    const failing: PersistStore = {
      ...store,
      getSettings: async () => ({
        ok: false as const,
        error: { code: 'io-failure' as const, message: 'blocked' }
      })
    };
    const s = createSettingsController({ store: failing });
    const r = await s.hydrate();
    expect(r.source).toBe('defaults');
    expect(r.error?.code).toBe('io-failure');
    expect(s.view().vars).toEqual(DEFAULT_CONFIG_VARS);
  });

  it('per-variable corruption substitutes only the bad variables', async () => {
    const { s } = await seeded(async (st) => {
      await st.putSettings({
        [SETTINGS_KEY]: {
          schema: 1,
          vars: {
            ...DEFAULT_CONFIG_VARS,
            screenblocks: 99, // out of the 3..11 law
            usegamma: 'x', // wrong type
            sfx_volume: null
          },
          keys: { key_use: -3, key_fire: 0x9d }
        }
      });
    });
    const r = await s.hydrate();
    expect(r.source).toBe('store'); // the RECORD was fine
    expect(s.view().vars.screenblocks).toBe(9); // m_misc.c:279 default
    expect(s.view().vars.usegamma).toBe(0);
    expect(s.view().vars.sfx_volume).toBe(8);
    expect(s.view().vars.mouse_sensitivity).toBe(5); // untouched row survives
    expect(r.problems.filter((p) => p.startsWith('invalid:')).sort()).toEqual([
      'invalid:key_use: skipped',
      'invalid:screenblocks: default substituted',
      'invalid:sfx_volume: default substituted',
      'invalid:usegamma: default substituted'
    ]);
    expect(r.applied.keys.applied).toEqual(['key_fire']);
  });
});

describe('debounced write-on-change (D-11b)', () => {
  it('N setVar calls coalesce into ONE store write; flush forces it', async () => {
    vi.useFakeTimers();
    const real = await memStore();
    let writes = 0;
    const spy: PersistStore = {
      ...real,
      putSettings: async (patch) => {
        writes++;
        return real.putSettings(patch);
      }
    };
    const s = createSettingsController({ store: spy, debounceMs: 50 });
    await s.hydrate();
    expect(writes).toBe(0);
    for (let i = 3; i <= 11; i++) s.setVar('screenblocks', i);
    s.setVar('usegamma', 2);
    expect(writes).toBe(0); // still debounced
    await vi.advanceTimersByTimeAsync(60);
    expect(writes).toBe(1); // ONE merged write
    await s.flush(); // nothing dirty ⇒ no extra write
    expect(writes).toBe(1);
    const snap = await real.getSettings();
    const rec = (snap.ok ? snap.value[SETTINGS_KEY] : undefined) as SettingsRecord;
    expect(rec.vars.screenblocks).toBe(11);
    expect(rec.vars.usegamma).toBe(2);
  });
});

describe('consumer mounts (applySettings — the M11-10 surface)', () => {
  it('mount fires immediately and on each change, until unmounted', async () => {
    const s = createSettingsController({ store: await memStore() });
    const seen: Array<[boolean, readonly string[]]> = [];
    const off = s.applySettings((v, changed) => seen.push([v.loaded, changed]));
    expect(seen).toEqual([[false, []]]); // immediate read-mount
    s.setVar('detaillevel', 1);
    expect(seen[1]).toEqual([false, ['detaillevel']]);
    off();
    s.setVar('detaillevel', 0);
    expect(seen).toHaveLength(2); // silent after unmount
  });

  it('hydrate(fn) mounts the boot consumer and fires it with the loaded view', async () => {
    const store = await memStore();
    const seed = createSettingsController({ store });
    await seed.hydrate();
    seed.setVar('music_volume', 12);
    await seed.flush();

    const s2 = createSettingsController({ store });
    let mountedMusic = -1;
    const r = await s2.hydrate((v) => {
      mountedMusic = v.vars.music_volume;
    });
    expect(r.source).toBe('store');
    expect(mountedMusic).toBe(12); // the boot-apply face for main.ts
  });
});
