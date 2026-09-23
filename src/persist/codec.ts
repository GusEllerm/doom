/**
 * Savegame byte codec — M11-02.
 *
 * HEADER: byte-faithful port of the `G_DoSaveGame` / `G_DoLoadGame` layout
 * (g_game.c:1270-1321 / :1201-1251), VERSION = 110 (doomdef.h:33 — NOT 104;
 * the 1.9-style `'d','O','O','M'` id bytes DO NOT exist in linuxdoom-1.10).
 * There is NO checksum anywhere (g_game.c has none; the `0x1d` byte is a
 * consistancy marker, g_game.c:1301). Byte layout (all offsets from file start):
 *
 *   offset  size  field
 *   ------  ----  -----
 *    0       24   description (savedescription truncated into the 24B field,
 *                   g_game.c:1282; SAVESTRINGSIZE=24 at :75)
 *   24       16   "version 110" + NUL padding  (sprintf("version %i",VERSION),
 *                   g_game.c:1284-1286; VERSIONSIZE=16 at :1198)
 *   40        1   gameskill                    (:1288)
 *   41        1   gameepisode                  (:1289)
 *   42        1   gamemap                      (:1290)
 *   43        4   playeringame[0..3]           (:1291, one byte each)
 *   47        3   leveltime, big-endian-ish `>>16, >>8, &0xff` (:1292-1294;
 *                   decoded `(a<<16)+(b<<8)+c` at :1233)
 *   50        N   payload (opaque; OUR structured container — D-11a)
 *   50+N      1   0x1d consistancy marker      (:1301)
 *
 * Total length must be <= SAVEGAMESIZE = 0x2c000 (g_game.c:74) or vanilla
 * I_Errors ("Savegame buffer overrun", :1303-1305); we surface a typed error.
 *
 * BODY (D-11a): a byte-faithful vanilla payload would need id's exact
 * `player_t`/`mobj_t` C layouts — zero observable fidelity in a browser, so
 * the header is faithful where observable and the payload is OUR versioned
 * container: `"DBP1" | version u32LE | (id u8, len u32LE, bytes)*`. The
 * mirror performs NO byte swapping anywhere (p_saveg.c stores shorts via raw
 * `short*` pointer writes, p_saveg.c:121/131-155, and memcpy's whole structs —
 * native little-endian on the target), so little-endian is the byte-order
 * authority for our own container.
 *
 * Failure modes are TYPED RESULTS, never throws — vanilla's bad-version path
 * is a SILENT return (g_game.c:1214-1217) and the marker mismatch is the only
 * hard "Bad savegame" (:1240-1241).
 */

/** doomdef.h:33 — `#define VERSION 110`. */
export const VERSION = 110;
/** g_game.c:75 — `#define SAVESTRINGSIZE 24`. */
export const SAVESTRINGSIZE = 24;
/** g_game.c:1198 — `#define VERSIONSIZE 16`. */
export const VERSIONSIZE = 16;
/** g_game.c:74 — `#define SAVEGAMESIZE 0x2c000`. */
export const SAVEGAMESIZE = 0x2c000;
/** g_game.c:1301 — consistancy marker byte (NOT a checksum — §0.1). */
export const CONSISTANCY_MARKER = 0x1d;
/** dstrings.h:41 — `#define SAVEGAMENAME "doomsav"`. */
export const SAVEGAMENAME = 'doomsav';
/** Fixed header size: 24 + 16 + 1 + 1 + 1 + 4 + 3 (g_game.c:1282-1294). */
export const HEADER_SIZE = 50;
/** The exact version string written at offset 24 (g_game.c:1285). */
export const VERSION_STRING = `version ${VERSION}`;

/** d_englsh.h:75 EMPTYSTRING — what M_ReadSaveStrings shows for absent slots. */
export const EMPTY_SLOT = 'empty slot';

// ---------------------------------------------------------------------------
// Little-endian reader/writer (P_ReadLong/P_WriteLong equivalents).
//
// The mirror has no endian helpers at all: p_saveg.c writes shorts through a
// raw `short*` cursor (p_saveg.c:121) and memcpy's structs verbatim — native
// little-endian on every target. Our container follows that: LE throughout.
// ---------------------------------------------------------------------------

export class ByteWriter {
  private readonly buf: Uint8Array;
  private readonly view: DataView;
  pos = 0;

  constructor(capacity: number) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  byte(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError(`byte out of range: ${value}`);
    }
    this.buf[this.pos++] = value;
  }

  bytes(values: ArrayLike<number>): void {
    for (let i = 0; i < values.length; i++) this.byte(values[i]);
  }

  short(value: number): void {
    if (!Number.isInteger(value) || value < -0x8000 || value > 0x7fff) {
      throw new RangeError(`int16 out of range: ${value}`);
    }
    this.view.setInt16(this.pos, value, true);
    this.pos += 2;
  }

  long(value: number): void {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) {
      throw new RangeError(`int32 out of range: ${value}`);
    }
    this.view.setInt32(this.pos, value, true);
    this.pos += 4;
  }

  ulong(value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
      throw new RangeError(`uint32 out of range: ${value}`);
    }
    this.view.setUint32(this.pos, value, true);
    this.pos += 4;
  }

  /** ASCII with NUL padding into a fixed field (vanilla sprintf+memset idiom). */
  fixedString(value: string, size: number): void {
    if (value.length > size - 1) {
      throw new RangeError(`string does not fit ${size}B field: ${value}`);
    }
    for (let i = 0; i < size; i++) {
      this.buf[this.pos + i] = i < value.length ? value.charCodeAt(i) : 0;
    }
    this.pos += size;
  }

  /** ASCII into a fixed field, NO NUL rule (magic fields: exact 4/4 fit). */
  ascii(value: string, size: number): void {
    if (value.length > size) {
      throw new RangeError(`string does not fit ${size}B field: ${value}`);
    }
    for (let i = 0; i < size; i++) {
      this.buf[this.pos + i] = i < value.length ? value.charCodeAt(i) : 0;
    }
    this.pos += size;
  }

  /** Bytes with zero padding into a fixed field (memcpy(save_p, desc, 24)). */
  pad(value: Uint8Array, size: number): void {
    if (value.length > size) {
      throw new RangeError(`${value.length}B does not fit ${size}B field`);
    }
    this.buf.set(value, this.pos);
    this.buf.fill(0, this.pos + value.length, this.pos + size);
    this.pos += size;
  }

  result(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

export class ByteReader {
  private readonly view: DataView;
  pos = 0;

  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  /** Throws RangeError on underrun; decodeSave guards lengths so it never fires there. */
  byte(): number {
    this.require(1);
    return this.bytes[this.pos++];
  }

  short(): number {
    this.require(2);
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }

  long(): number {
    this.require(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  ulong(): number {
    this.require(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  take(n: number): Uint8Array {
    this.require(n);
    const v = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  /** C-string read: bytes up to first NUL within `size` (strcmp semantics). */
  fixedString(size: number): string {
    const field = this.take(size);
    let end = 0;
    while (end < size && field[end] !== 0) end++;
    let s = '';
    for (let i = 0; i < end; i++) s += String.fromCharCode(field[i]);
    return s;
  }

  private require(n: number): void {
    if (this.remaining < n) {
      throw new RangeError(`truncated: need ${n} byte(s), ${this.remaining} left`);
    }
  }
}

// ---------------------------------------------------------------------------
// Header model + derivation rules
// ---------------------------------------------------------------------------

export interface SaveHeader {
  /** Menu-visible description; <= SAVESTRINGSIZE-2 chars (see clampDescription). */
  description: string;
  /** gameskill 0..4 (sk_baby..sk_nightmare). */
  skill: number;
  /** gameepisode 1..4. */
  episode: number;
  /** gamemap 1..35 (episodic cap 1..9 is enforced by callers, g_game.c:1386-1394). */
  map: number;
  /** playeringame[0..3], one byte each; boolean in practice (0 or 1). */
  playeringame: readonly [number, number, number, number];
  /** leveltime — must be < 2^24 to survive the >>16 / >>8 / &0xff split. */
  leveltime: number;
}

/** Save file NAME derivation: `doomsav<slot>.dsg` (g_game.c:1277 + dstrings.h:41). */
export function saveFileName(slot: number): string {
  if (!Number.isInteger(slot) || slot < 0 || slot > 9) {
    throw new RangeError(`save slot out of range: ${slot}`);
  }
  return `${SAVEGAMENAME}${slot}.dsg`;
}

/**
 * Save DESCRIPTION derivation/cap: the 1.10 menu editor caps the string at
 * SAVESTRINGSIZE-2 = 22 chars (m_menu.c:1483 width cap `(SAVESTRINGSIZE-2)*8`
 * px); the 24B field is the string NUL-padded (memcpy at g_game.c:1282).
 * An absent slot displays EMPTY_SLOT (m_menu.c:511-536) — never stored here.
 */
export function clampDescription(text: string): string {
  const cap = SAVESTRINGSIZE - 2;
  // Strip NULs and non-printables so the field round-trips strcmp-clean.
  let clean = '';
  for (let i = 0; i < text.length && clean.length < cap; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0x20 && code < 0x7f) clean += text[i];
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Typed failures (never thrown across the API boundary)
// ---------------------------------------------------------------------------

export type CodecFailure =
  /** bytes shorter than HEADER_SIZE + marker (vanilla would read garbage). */
  | { kind: 'truncated'; needed: number; have: number }
  /** offset-24 field != "version 110" (vanilla: SILENT return, :1214-1217). */
  | { kind: 'badVersion'; found: string }
  /** tail byte != 0x1d (vanilla: I_Error("Bad savegame"), :1240-1241). */
  | { kind: 'badMarker'; found: number }
  /** total length > SAVEGAMESIZE (vanilla "Savegame buffer overrun", :1303). */
  | { kind: 'bufferOverrun'; length: number; limit: number }
  /** a header field is out of its byte-expressible range. */
  | { kind: 'badField'; field: string; value: number | string };

export interface EncodeSuccess {
  ok: true;
  bytes: Uint8Array;
}
export interface EncodeFailure {
  ok: false;
  failure: CodecFailure;
}
export type EncodeResult = EncodeSuccess | EncodeFailure;

export interface DecodeSuccess {
  ok: true;
  header: SaveHeader;
  /** Opaque payload bytes (container parse is parsePayload's job). */
  payload: Uint8Array;
}
export interface DecodeFailure {
  ok: false;
  failure: CodecFailure;
}
export type DecodeResult = DecodeSuccess | DecodeFailure;

export function describeFailure(f: CodecFailure): string {
  switch (f.kind) {
    case 'truncated':
      return `truncated savegame: needed ${f.needed} bytes, have ${f.have}`;
    case 'badVersion':
      return `bad savegame version: found "${f.found}" (expected "${VERSION_STRING}")`;
    case 'badMarker':
      return `bad savegame: consistancy marker 0x${f.found.toString(16)} (expected 0x1d)`;
    case 'bufferOverrun':
      return `savegame buffer overrun: ${f.length} > ${f.limit}`;
    case 'badField':
      return `bad header field ${f.field}: ${f.value}`;
  }
}

// ---------------------------------------------------------------------------
// encodeSave / decodeSave
// ---------------------------------------------------------------------------

/**
 * Encode the §0.1 byte layout EXACTLY, payload spliced at offset 50.
 * Field validation is strict (typed failure) because our ranges are the
 * observable ones; vanilla was silent only for the version field.
 */
export function encodeSave(header: SaveHeader, payload: Uint8Array): EncodeResult {
  const bad = validateHeader(header);
  if (bad) return { ok: false, failure: bad };

  const total = HEADER_SIZE + payload.length + 1;
  if (total > SAVEGAMESIZE) {
    return { ok: false, failure: { kind: 'bufferOverrun', length: total, limit: SAVEGAMESIZE } };
  }

  const w = new ByteWriter(total);
  // offset 0 — 24B description field, NUL-padded (g_game.c:1282).
  const desc = new Uint8Array(SAVESTRINGSIZE);
  for (let i = 0; i < header.description.length; i++) {
    desc[i] = header.description.charCodeAt(i) & 0xff;
  }
  w.pad(desc, SAVESTRINGSIZE);
  // offset 24 — "version 110" + NULs (g_game.c:1283-1286: memset then sprintf).
  w.fixedString(VERSION_STRING, VERSIONSIZE);
  // offset 40..42 — skill/episode/map, single bytes.
  w.byte(header.skill);
  w.byte(header.episode);
  w.byte(header.map);
  // offset 43..46 — playeringame[0..3].
  for (let i = 0; i < 4; i++) w.byte(header.playeringame[i]);
  // offset 47..49 — leveltime big-endian-ish split (>>16, >>8, &0xff).
  w.byte((header.leveltime >> 16) & 0xff);
  w.byte((header.leveltime >> 8) & 0xff);
  w.byte(header.leveltime & 0xff);
  // offset 50.. — our payload, opaque (D-11a).
  w.bytes(payload);
  // final byte — consistancy marker.
  w.byte(CONSISTANCY_MARKER);
  return { ok: true, bytes: w.result() };
}

/**
 * Decode following G_DoLoadGame's order (:1201-1251): skip 24B desc, strcmp
 * the version (typed BadVersion result — silent-return semantics preserved),
 * read the 3+4+3 block, payload = everything up to the marker, marker check.
 * Never throws on garbage input.
 */
export function decodeSave(bytes: Uint8Array): DecodeResult {
  if (bytes.length < HEADER_SIZE + 1) {
    return { ok: false, failure: { kind: 'truncated', needed: HEADER_SIZE + 1, have: bytes.length } };
  }
  const r = new ByteReader(bytes);
  r.take(SAVESTRINGSIZE); // skip the description field (:1209)
  const version = r.fixedString(VERSIONSIZE);
  if (version !== VERSION_STRING) {
    return { ok: false, failure: { kind: 'badVersion', found: version } };
  }
  const skill = r.byte();
  const episode = r.byte();
  const map = r.byte();
  const playeringame: [number, number, number, number] = [r.byte(), r.byte(), r.byte(), r.byte()];
  const a = r.byte();
  const b = r.byte();
  const c = r.byte();
  const leveltime = ((a << 16) | (b << 8) | c) >>> 0;
  const payload = r.take(r.remaining - 1).slice(); // own the copy; no aliasing
  const marker = r.byte();
  if (marker !== CONSISTANCY_MARKER) {
    return { ok: false, failure: { kind: 'badMarker', found: marker } };
  }
  // Description: strip the NUL padding (M_ReadSaveStrings shows it raw, :511-536).
  const descBytes = bytes.subarray(0, SAVESTRINGSIZE);
  let end = 0;
  while (end < SAVESTRINGSIZE && descBytes[end] !== 0) end++;
  let description = '';
  for (let i = 0; i < end; i++) description += String.fromCharCode(descBytes[i]);
  return {
    ok: true,
    header: { description, skill, episode, map, playeringame, leveltime },
    payload,
  };
}

function validateHeader(header: SaveHeader): CodecFailure | null {
  const int = (v: number, lo: number, hi: number, field: string): CodecFailure | null =>
    !Number.isInteger(v) || v < lo || v > hi ? { kind: 'badField', field, value: v } : null;
  const fieldErrors: (CodecFailure | null)[] = [
    int(header.skill, 0, 4, 'skill'),
    int(header.episode, 1, 4, 'episode'),
    int(header.map, 1, 35, 'map'),
    int(header.leveltime, 0, 0xffffff, 'leveltime'),
    header.playeringame.length !== 4 ? { kind: 'badField', field: 'playeringame', value: 'length != 4' } : null,
    ...header.playeringame.map((v) => int(v, 0, 1, 'playeringame[i]')),
    header.description.length > SAVESTRINGSIZE - 2
      ? { kind: 'badField', field: 'description', value: header.description }
      : null,
  ];
  for (const f of fieldErrors) if (f) return f;
  return null;
}

// ---------------------------------------------------------------------------
// DBP1 payload container (D-11a — OUR format, internal state, never a
// fidelity surface). Layout: "DBP1" | version u32LE | (id u8, len u32LE, bytes)*
// ---------------------------------------------------------------------------

export const PAYLOAD_MAGIC = 'DBP1';
/** Container schema version; bump when the section map changes meaning. */
export const PAYLOAD_VERSION = 1;

export interface PayloadSection {
  id: number;
  bytes: Uint8Array;
}

export type PayloadFailure =
  | { kind: 'truncated'; needed: number; have: number }
  | { kind: 'badMagic'; found: string }
  | { kind: 'badPayloadVersion'; found: number }
  | { kind: 'badSection'; id: number; offset: number };

export type PayloadResult =
  | { ok: true; version: number; sections: PayloadSection[] }
  | { ok: false; failure: PayloadFailure };

export function buildPayload(sections: readonly PayloadSection[], version = PAYLOAD_VERSION): Uint8Array {
  let size = PAYLOAD_MAGIC.length + 4;
  for (const s of sections) size += 1 + 4 + s.bytes.length;
  const w = new ByteWriter(size);
  w.ascii(PAYLOAD_MAGIC, 4);
  w.ulong(version);
  for (const s of sections) {
    w.byte(s.id);
    w.ulong(s.bytes.length);
    w.bytes(s.bytes);
  }
  return w.result();
}

export function parsePayload(bytes: Uint8Array): PayloadResult {
  if (bytes.length < 8) {
    return { ok: false, failure: { kind: 'truncated', needed: 8, have: bytes.length } };
  }
  const r = new ByteReader(bytes);
  let magic = '';
  for (let i = 0; i < 4; i++) magic += String.fromCharCode(r.byte());
  if (magic !== PAYLOAD_MAGIC) {
    return { ok: false, failure: { kind: 'badMagic', found: magic } };
  }
  const version = r.ulong();
  const sections: PayloadSection[] = [];
  try {
    while (r.remaining > 0) {
      const at = r.pos;
      const id = r.byte();
      const len = r.ulong();
      // A length that overruns the buffer is corruption (len is the WHOLE
      // remainder budget — never legitimately huge).
      if (len > r.remaining) {
        return { ok: false, failure: { kind: 'badSection', id, offset: at } };
      }
      sections.push({ id, bytes: r.take(len).slice() });
    }
  } catch {
    return { ok: false, failure: { kind: 'truncated', needed: 0, have: r.remaining } };
  }
  return { ok: true, version, sections };
}
