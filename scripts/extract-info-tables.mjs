// scripts/extract-info-tables.mjs — DEV-ONLY extraction of the linuxdoom-1.10
// state/mobj/weapon/sprnames tables from a local id Software source mirror,
// used by M7-01 (docs/design/M7-plan.md §M7-01) to prove that the GENERATED
// tables in src/wad/info/*.ts match the source they were transcribed from.
//
// The mirror is NOT part of the repo (no GPL source is committed). This script
// is the provenance tool: it parses the C sources into the same canonical row
// strings src/wad/info/states.test.ts digests, so
//   node scripts/extract-info-tables.mjs --mirror=/path/to/linuxdoom-1.10 --digests
// regenerates the constants committed in that test file, and
//   DOOM_MIRROR=/path/to/linuxdoom-1.10 npx vitest run src/wad/info/states.test.ts
// additionally diffs the tables row-by-row against the source (skipped when the
// env var is unset — CI runs on the committed digests alone).
//
// Parsing scope: exactly what the four generated tables were transcribed from
// (info.c states[] + mobjinfo[], info.h enums + sprnames[], d_items.c
// weaponinfo[]) — C expressions (`16*FRACUNIT`, `MF_SOLID|MF_SHOOTABLE`,
// `3<<26`) are evaluated with the enum/#define values of the same mirror.
//
// SPDX-License-Identifier: GPL-2.0-or-later

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const FRACUNIT = 65536;

/** Read + strip C block comments (line comments are kept: the tables carry the
 *  `// S_NAME` / `// MT_NAME` identity in trailing comments). */
function stripBlockComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** One `typedef enum { … } NAME;` body → ordered `{name, expr}` entries. */
function enumEntries(text, typeName) {
  const tail = new RegExp(`\\}\\s*${typeName}\\s*;`);
  const tailMatch = tail.exec(text);
  if (!tailMatch) throw new Error(`enumEntries: 'typedef enum … } ${typeName};' not found`);
  const head = text.lastIndexOf('typedef enum', tailMatch.index);
  const open = text.indexOf('{', head);
  if (head < 0 || open < 0 || open > tailMatch.index) {
    throw new Error(`enumEntries: no enum body for ${typeName}`);
  }
  const body = stripBlockComments(text.slice(open + 1, tailMatch.index))
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  const out = [];
  for (const part of body.split(',')) {
    const cleaned = part.trim();
    if (cleaned === '') continue;
    const m = /^([A-Za-z_]\w*)\s*(?:=\s*([\s\S]+))?$/.exec(cleaned);
    if (!m) throw new Error(`enumEntries: unparsable enumerator '${cleaned}' in ${typeName}`);
    out.push({ name: m[1], expr: m[2] === undefined ? undefined : m[2].trim() });
  }
  return out;
}

/** Ordered enumerator names (explicit values are rejected: the table enums
 *  are plain sequences, so index == C value). */
function parseEnum(text, typeName) {
  return enumEntries(text, typeName).map((e) => {
    if (e.expr !== undefined) {
      throw new Error(`parseEnum: explicit enumerator value in ${typeName} (${e.name} = ${e.expr})`);
    }
    return e.name;
  });
}

/** `#define NAME <expr>` map (values evaluated lazily by Evaluator). */
function parseDefines(texts) {
  const defines = new Map();
  for (const text of texts) {
    for (const m of text.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)\s+(?!\()([^\n(]*?)(?:\s*(?:\/\/[^\n]*)?)$/gm)) {
      defines.set(m[1], m[2].trim());
    }
    for (const m of text.matchAll(/^\s*#\s*define\s+([A-Za-z_]\w*)\s*\(([^\n)]*)\)(\s*\/\/.*)?$/gm)) {
      defines.set(m[1], m[2].trim());
    }
  }
  return defines;
}

/** Tiny integer-expression evaluator: identifiers, decimal/hex literals,
 *  + - * | & << >> ( ) unary -. Used for `16*FRACUNIT`,
 *  `MF_SPECIAL|MF_COUNTITEM`, `3<<26` and friends. */
function evalIntExpr(expr, resolve) {
  const tokens = [...String(expr).matchAll(/(\w+)|(<<|>>|[+\-*|&()])/g)].map((m) => m[0]);
  let pos = 0;
  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  function parseOr() {
    let v = parseAnd();
    while (peek() === '|') { next(); v |= parseAnd(); }
    return v;
  }
  function parseAnd() {
    let v = parseShift();
    while (peek() === '&') { next(); v &= parseShift(); }
    return v;
  }
  function parseShift() {
    let v = parseAdd();
    while (peek() === '<<' || peek() === '>>') {
      const op = next();
      const rhs = parseAdd();
      v = op === '<<' ? v << rhs : v >> rhs;
    }
    return v;
  }
  function parseAdd() {
    let v = parseMul();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const rhs = parseMul();
      v = op === '+' ? v + rhs : v - rhs;
    }
    return v;
  }
  function parseMul() {
    let v = parseUnary();
    while (peek() === '*') { next(); v *= parseUnary(); }
    return v;
  }
  function parseUnary() {
    if (peek() === '-') { next(); return -parseUnary(); }
    if (peek() === '(') { next(); const v = parseOr(); expect(')'); return v; }
    const tok = next();
    if (tok === undefined) throw new Error(`evalIntExpr: truncated expression '${expr}'`);
    if (/^0[xX][0-9a-fA-F]+$/.test(tok)) return parseInt(tok, 16);
    if (/^\d+$/.test(tok)) return parseInt(tok, 10);
    const v = resolve(tok);
    if (typeof v !== 'number') throw new Error(`evalIntExpr: unknown symbol '${tok}' in '${expr}'`);
    return v;
  }
  function expect(tok) {
    if (next() !== tok) throw new Error(`evalIntExpr: expected '${tok}' in '${expr}'`);
  }
  const value = parseOr();
  if (pos !== tokens.length) throw new Error(`evalIntExpr: trailing tokens in '${expr}'`);
  return value;
}

/** Ordered enumerator list with the trailing `NUM…` count marker removed
 *  (asserted), so indexes equal C values for the payload names. */
export function trimCountMarker(names, marker) {
  if (names[names.length - 1] !== marker) {
    throw new Error(`trimCountMarker: last enumerator is ${names[names.length - 1]}, expected ${marker}`);
  }
  return names.slice(0, -1);
}

/** Values of a `{ ... },` row list inside `block`, split on top-level commas. */
function splitTopLevel(row) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of row) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur.trim());
  return out;
}

/** states[] of info.c → canonical rows (names, so the comparison checks the
 *  enum identity, not only the numeric value). */
export function parseStates(infoC, statenum) {
  const start = infoC.indexOf('state_t\tstates[NUMSTATES]');
  if (start < 0) throw new Error('parseStates: states[] not found');
  const end = infoC.indexOf('\n};', start);
  const block = infoC.slice(start, end);
  const rows = [];
  for (const line of block.split('\n')) {
    const lineNoComment = line.replace(/\/\/[^\n]*/, '');
    const m = /^\s*\{\s*(SPR_\w+)\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*\{\s*(\w*)\s*\}\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*,\s*([^,]+?)\s*\},?\s*$/.exec(lineNoComment);
    if (!m) {
      if (/^\s*\{SPR_/.test(lineNoComment)) throw new Error(`parseStates: unparsable row: ${line.trim()}`);
      continue;
    }
    const nameMatch = /\/\/\s*(S_\w+)\s*$/.exec(line);
    const name = nameMatch ? nameMatch[1] : undefined;
    rows.push({
      name: name ?? `S_INDEX${rows.length}`,
      sprite: m[1],
      frame: m[2],
      tics: m[3],
      action: m[4],
      next: m[5],
      misc1: m[6],
      misc2: m[7],
    });
  }
  if (rows.length !== statenum.length) {
    throw new Error(`parseStates: ${rows.length} rows vs ${statenum.length} statenum_t entries`);
  }
  rows.forEach((r, i) => {
    if (r.name !== statenum[i]) throw new Error(`parseStates: row ${i} is ${r.name}, statenum says ${statenum[i]}`);
  });
  return rows;
}

/** mobjinfo[] of info.c (25-field blocks, `// MT_NAME` header comment). */
export function parseMobjinfo(infoC, mobjtype) {
  const start = infoC.indexOf('mobjinfo_t mobjinfo[NUMMOBJTYPES]');
  if (start < 0) throw new Error('parseMobjinfo: mobjinfo[] not found');
  const block = infoC.slice(start, infoC.indexOf('\n};', start));
  const fields = ['doomednum', 'spawnState', 'spawnHealth', 'seeState', 'seeSound', 'reactionTime',
    'attackSound', 'painState', 'painChance', 'painSound', 'meleeState', 'missileState',
    'deathState', 'xdeathState', 'deathSound', 'speed', 'radius', 'height', 'mass', 'damage',
    'activeSound', 'flags', 'raiseState'];
  const out = [];
  for (const m of block.matchAll(/\{\s*\/\/\s*(MT_\w+)([\s\S]*?)\n\s*\},?/g)) {
    const body = m[2].replace(/\/\/[^\n]*/g, '');
    const values = splitTopLevel(body).filter((v) => v !== '');
    if (values.length !== fields.length) {
      throw new Error(`parseMobjinfo: ${m[2]} has ${values.length} fields, expected ${fields.length}`);
    }
    out.push({ name: m[1], raw: Object.fromEntries(fields.map((f, i) => [f, values[i]])) });
  }
  if (out.length !== mobjtype.length) {
    throw new Error(`parseMobjinfo: ${out.length} entries vs ${mobjtype.length} mobjtype_t`);
  }
  out.forEach((e, i) => {
    if (e.name !== mobjtype[i]) throw new Error(`parseMobjinfo: entry ${i} is ${e.name}, mobjtype says ${mobjtype[i]}`);
  });
  return out;
}

/** weaponinfo[] of d_items.c. */
export function parseWeaponinfo(dItemsC) {
  const start = dItemsC.indexOf('weaponinfo_t\tweaponinfo[NUMWEAPONS]');
  if (start < 0) throw new Error('parseWeaponinfo: weaponinfo[] not found');
  const block = dItemsC.slice(start, dItemsC.indexOf('\n};', start));
  const names = ['wp_fist', 'wp_pistol', 'wp_shotgun', 'wp_chaingun', 'wp_missile', 'wp_plasma',
    'wp_bfg', 'wp_chainsaw', 'wp_supershotgun'];
  const rows = [];
  // Leaf braces only: the array's own outer braces contain nested rows.
  for (const m of block.matchAll(/\{([^{}]*)\}/g)) {
    const f = splitTopLevel(m[1].replace(/\/\/[^\n]*/g, '')).filter((v) => v !== '');
    if (f.length === 0) continue;
    if (f.length !== 6) throw new Error(`parseWeaponinfo: unparsable row {${m[1].trim()}}`);
    rows.push({ name: names[rows.length] ?? `wp_${rows.length}`, ammo: f[0], upState: f[1], downState: f[2], readyState: f[3], atkState: f[4], flashState: f[5] });
  }
  if (rows.length !== 9) throw new Error(`parseWeaponinfo: ${rows.length} rows, expected 9`);
  return rows;
}

/** sprnames[] of info.c (spritenum order). */
export function parseSprnames(infoC) {
  const start = infoC.indexOf('sprnames[NUMSPRITES]');
  if (start < 0) throw new Error('parseSprnames: sprnames[NUMSPRITES] not found');
  const block = infoC.slice(start, infoC.indexOf('};', start));
  const names = [...block.matchAll(/"(\w{4})"/g)].map((m) => m[1]);
  if (names.length !== 138) throw new Error(`parseSprnames: ${names.length} names, expected 138`);
  return names;
}

/** Full extraction from a mirror directory. */
export function extractTables(mirrorDir) {
  const read = (f) => readFileSync(join(mirrorDir, f), 'latin1');
  const infoC = read('info.c');
  const infoH = read('info.h');
  const dItemsC = read('d_items.c');
  const pMobjH = read('p_mobj.h');
  const pPsprH = read('p_pspr.h');
  const statenumAll = parseEnum(infoH, 'statenum_t');
  const mobjtypeAll = parseEnum(infoH, 'mobjtype_t');
  const spritenumAll = parseEnum(infoH, 'spritenum_t');
  const ammo = parseEnum(read('doomdef.h'), 'ammotype_t');
  const statenum = trimCountMarker(statenumAll, 'NUMSTATES');
  const mobjtype = trimCountMarker(mobjtypeAll, 'NUMMOBJTYPES');
  const spritenum = trimCountMarker(spritenumAll, 'NUMSPRITES');
  const defines = parseDefines([pPsprH, read('doomdef.h'), read('m_fixed.h')]);
  // MF_* flags are an explicit-value enum in p_mobj.h.
  const symbols = new Map();
  for (const e of enumEntries(pMobjH, 'mobjflag_t')) {
    symbols.set(e.name, e.expr === undefined ? 0 : evalIntExpr(e.expr, (t) => resolveNamed(t)));
  }
  for (const [i, n] of spritenumAll.entries()) symbols.set(n, i);
  for (const [i, n] of statenumAll.entries()) symbols.set(n, i);
  for (const [i, n] of mobjtypeAll.entries()) symbols.set(n, i);
  for (const [i, n] of ammo.entries()) symbols.set(n, i);
  function resolveNamed(tok) {
    if (symbols.has(tok)) return symbols.get(tok);
    if (defines.has(tok)) return evalIntExpr(defines.get(tok), resolveNamed);
    throw new Error(`resolveNamed: unknown symbol '${tok}'`);
  }
  const num = (expr) => evalIntExpr(expr, resolveNamed);
  const parsedStates = parseStates(infoC, statenum).map((r) => ({
    ...r,
    spriteIdx: num(r.sprite),
    frame: num(r.frame),
    tics: num(r.tics),
    actionName: r.action === 'NULL' ? 'NONE' : r.action,
    nextIdx: num(r.next),
    misc1: num(r.misc1),
    misc2: num(r.misc2),
  }));
  // ActionId vocabulary = order of FIRST APPEARANCE walking states[] (the
  // contract src/sim/a_actions.ts documents); NONE (source NULL) is 0.
  const actionOrder = [];
  for (const r of parsedStates) if (!actionOrder.includes(r.actionName)) actionOrder.push(r.actionName);
  const states = parsedStates.map((r) => ({ ...r, actionId: actionOrder.indexOf(r.actionName) }));
  const actionCounts = actionOrder.map((n) => parsedStates.filter((r) => r.actionName === n).length);
  const mobjinfo = parseMobjinfo(infoC, mobjtype).map((e) => {
    const row = {}
    for (const [k, v] of Object.entries(e.raw)) {
      // sfx_* stay name tokens (no sfx enum is committed in this repo); every
      // other field is a C integer expression (state id, n*FRACUNIT, MF_* |).
      row[k] = /^sfx_/.test(v) ? v : num(v)
    }
    return { name: e.name, ...row }
  });
  const weaponinfo = parseWeaponinfo(dItemsC).map((r) => ({
    name: r.name,
    ammo: num(r.ammo),
    upState: num(r.upState), downState: num(r.downState), readyState: num(r.readyState),
    atkState: num(r.atkState), flashState: num(r.flashState),
  }));
  return {
    statenum, mobjtype, spritenum, ammo, actionOrder, actionCounts,
    sprnames: parseSprnames(infoC),
    states, mobjinfo, weaponinfo,
    numstatenum: statenum.length,
  };
}

/* Canonical row strings — the single format shared by --digests output and the
 * committed constants in src/wad/info/states.test.ts. */
export function stateRowString(s) {
  return [s.sprite, s.frame, s.tics, s.actionId, s.next, s.misc1, s.misc2].join(',');
}
export function mobjRowString(m, statenum, sprnames) {
  void sprnames;
  const st = (v) => (typeof v === 'number' ? statenum[v] : v);
  return [m.doomednum, st(m.spawnState), m.spawnHealth, st(m.seeState), m.seeSound, m.reactionTime,
    m.attackSound, st(m.painState), m.painChance, m.painSound, st(m.meleeState), st(m.missileState),
    st(m.deathState), st(m.xdeathState), m.deathSound, m.speed, m.radius, m.height, m.mass,
    m.damage, m.activeSound, m.flags, st(m.raiseState)].join(',');
}
export function weaponRowString(w, statenum, ammo) {
  return [ammo[w.ammo], statenum[w.upState], statenum[w.downState], statenum[w.readyState],
    statenum[w.atkState], statenum[w.flashState]].join(',');
}
export function sha256(lines) {
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}

/** Family = the state name's chain prefix: trailing frame digits stripped, then
 *  cut after the last word separator (`S_POSS_DIE15` → `S_POSS`,
 *  `S_BEXP4` → `S_BEXP`, `S_NULL` → `S_NULL`). */
export function familyOf(name) {
  const noDigits = name.replace(/\d+$/, '');
  const cut = noDigits.lastIndexOf('_');
  return cut > 2 ? noDigits.slice(0, cut) : noDigits;
}

/** Census: every family with its row count and digest (rows in statenum order). */
export function familyCensus(names, rows) {
  const groups = new Map();
  names.forEach((n, i) => {
    const fam = familyOf(n);
    if (!groups.has(fam)) groups.set(fam, []);
    groups.get(fam).push(i);
  });
  return [...groups.entries()].map(([family, indexes]) => ({
    family,
    indexes,
    count: indexes.length,
    digest: sha256(indexes.map((i) => stateRowString(rows[i]))),
  }));
}

function main(argv) {
  const mirror = (argv.find((a) => a.startsWith('--mirror=')) ?? '').split('=')[1] ?? '/tmp/DOOM-master/linuxdoom-1.10';
  const t = extractTables(mirror);
  const wantDigests = argv.includes('--digests');
  if (!wantDigests) {
    process.stdout.write(JSON.stringify(t, null, 1) + '\n');
    return;
  }
  console.error(`mirror: ${mirror}`);
  console.error(`states: ${t.states.length}  mobjinfo: ${t.mobjinfo.length}  sprnames: ${t.sprnames.length}  weaponinfo: ${t.weaponinfo.length}`);
  console.error(`states full digest: ${sha256(t.states.map(stateRowString))}`);
  console.error(`mobjinfo full digest: ${sha256(t.mobjinfo.map((m) => mobjRowString(m, t.statenum, t.sprnames)))}`);
  console.error(`weaponinfo full digest: ${sha256(t.weaponinfo.map((w) => weaponRowString(w, t.statenum, t.ammo)))}`);
  console.error(`sprnames digest: ${sha256(t.sprnames)}`);
  console.error(`actions: ${t.actionOrder.length} (${t.actionCounts.reduce((a, b) => a + b, 0)} rows)`);
  console.error(`action order: ${t.actionOrder.join(',')}`);
  console.error(`action counts: ${t.actionCounts.join(',')}`);
  console.error('// family census: family,count,digest');
  const rows = familyCensus(t.statenum, t.states).map((f) => `${f.family},${f.count},${f.digest}`);
  process.stdout.write(rows.join('\n') + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
