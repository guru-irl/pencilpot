/**
 * Dependency-free TrueType / OpenType `fvar` (font variations) parser.
 *
 * Reads the variable-font axis + named-instance metadata directly out of an
 * SFNT (.ttf / .otf) byte buffer, with zero npm dependencies.
 *
 * Public API:
 *   readFvar(buffer)            → { axes:[{tag,min,default,max,name}],
 *                                   instances:[{name,coords:{tag:value}}] }
 *   readFontFamilyName(buffer)  → string | null   (nameID 16, fallback 1)
 *
 * References:
 *   - SFNT table directory: https://learn.microsoft.com/typography/opentype/spec/otff
 *   - fvar table:           https://learn.microsoft.com/typography/opentype/spec/fvar
 *   - name table:           https://learn.microsoft.com/typography/opentype/spec/name
 */

// ── SFNT table directory ──────────────────────────────────────────────────────

/**
 * Parse the SFNT table directory and return a map of tag → { offset, length }.
 *
 * Header (12 bytes): sfntVersion u32, numTables u16@4, searchRange u16@6,
 *   entrySelector u16@8, rangeShift u16@10.
 * Each of `numTables` records is 16 bytes from offset 12:
 *   tag(4 ascii), checksum u32, offset u32, length u32.
 */
function readTableDirectory(buf) {
  if (buf.length < 12) throw new Error("fvar: buffer too small to be a font");
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  let p = 12;
  for (let i = 0; i < numTables; i++) {
    if (p + 16 > buf.length) break;
    const tag = buf.toString("ascii", p, p + 4);
    const offset = buf.readUInt32BE(p + 8);
    const length = buf.readUInt32BE(p + 12);
    tables[tag] = { offset, length };
    p += 16;
  }
  return tables;
}

// ── name table ────────────────────────────────────────────────────────────────

/**
 * Parse the `name` table into a nameID → string resolver.
 *
 * Prefers Windows platform (3) / language 0x409 (en-US) UTF-16BE records; falls
 * back to any record for the nameID. Returns a Map<number, string>.
 *
 * name table format 0:
 *   format u16@0, count u16@2, stringOffset u16@4 (offset to string storage
 *   from start of the name table), then `count` 12-byte NameRecords:
 *     platformID u16, encodingID u16, languageID u16, nameID u16,
 *     length u16, offset u16 (from stringOffset).
 */
function readNameTable(buf, table) {
  const names = new Map();      // nameID → preferred string
  if (!table) return names;
  const base = table.offset;
  if (base + 6 > buf.length) return names;

  const count = buf.readUInt16BE(base + 2);
  const storageOffset = base + buf.readUInt16BE(base + 4);

  // Track which nameIDs we've already filled with a *preferred* record so a
  // later fallback record never overwrites a Windows/en-US one.
  const preferred = new Set();

  let p = base + 6;
  for (let i = 0; i < count; i++) {
    if (p + 12 > buf.length) break;
    const platformID = buf.readUInt16BE(p);
    const encodingID = buf.readUInt16BE(p + 2);
    const languageID = buf.readUInt16BE(p + 4);
    const nameID     = buf.readUInt16BE(p + 6);
    const length     = buf.readUInt16BE(p + 8);
    const offset     = buf.readUInt16BE(p + 10);
    p += 12;

    const strStart = storageOffset + offset;
    const strEnd = strStart + length;
    if (strEnd > buf.length) continue;

    const isWindows = platformID === 3;
    const isUnicodeUtf16 = platformID === 0 || (isWindows && (encodingID === 1 || encodingID === 0));
    let value;
    if (isWindows || isUnicodeUtf16) {
      value = buf.toString("utf16le", strStart, strEnd);
      // utf16le on a big-endian buffer reverses bytes — swap first.
      value = decodeUtf16BE(buf, strStart, strEnd);
    } else {
      // Mac / other 1-byte encodings: treat as latin1.
      value = buf.toString("latin1", strStart, strEnd);
    }

    const isPreferred = isWindows && languageID === 0x409;
    if (isPreferred) {
      names.set(nameID, value);
      preferred.add(nameID);
    } else if (!preferred.has(nameID) && !names.has(nameID)) {
      names.set(nameID, value);
    }
  }
  return names;
}

/** Decode a UTF-16BE byte range into a JS string. */
function decodeUtf16BE(buf, start, end) {
  let out = "";
  for (let i = start; i + 1 < end; i += 2) {
    out += String.fromCharCode((buf[i] << 8) | buf[i + 1]);
  }
  return out;
}

// ── Fixed 16.16 ───────────────────────────────────────────────────────────────

/** Read a signed Fixed 16.16 value at offset `p` and return it as a float. */
function readFixed(buf, p) {
  return buf.readInt32BE(p) / 65536;
}

// ── fvar parsing ──────────────────────────────────────────────────────────────

/**
 * Parse the `fvar` table out of a font buffer.
 *
 * @param {Buffer} buffer  raw .ttf / .otf bytes
 * @returns {{ axes: Array<{tag:string,min:number,default:number,max:number,name:string}>,
 *             instances: Array<{name:string, coords:Object<string,number>}> }}
 * @throws if the font has no `fvar` table (i.e. it is not a variable font).
 */
export function readFvar(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const tables = readTableDirectory(buf);

  const fvar = tables["fvar"];
  if (!fvar) {
    throw new Error("readFvar: font has no 'fvar' table — not a variable font");
  }
  const names = readNameTable(buf, tables["name"]);

  const base = fvar.offset;
  // fvar header:
  //   majorVersion u16@0, minorVersion u16@2,
  //   axesArrayOffset u16@4, reserved/countSizePairs u16@6,
  //   axisCount u16@8, axisSize u16@10,
  //   instanceCount u16@12, instanceSize u16@14
  const axesArrayOffset = buf.readUInt16BE(base + 4);
  const axisCount       = buf.readUInt16BE(base + 8);
  const axisSize        = buf.readUInt16BE(base + 10);
  const instanceCount   = buf.readUInt16BE(base + 12);
  const instanceSize    = buf.readUInt16BE(base + 14);

  // ── Axis records ──
  const axes = [];
  let p = base + axesArrayOffset;
  for (let i = 0; i < axisCount; i++) {
    const recStart = p;
    const tag = buf.toString("ascii", p, p + 4);
    const min = readFixed(buf, p + 4);
    const def = readFixed(buf, p + 8);
    const max = readFixed(buf, p + 12);
    // flags u16 @ +16, axisNameID u16 @ +18
    const axisNameID = buf.readUInt16BE(p + 18);
    const name = names.get(axisNameID) ?? tag;
    axes.push({ tag, min, default: def, max, name });
    p = recStart + axisSize;
  }

  // ── Instance records ──
  // Each instance: subfamilyNameID u16, flags u16, axisCount × Fixed coords,
  // optional postScriptNameID u16 (present iff instanceSize is large enough).
  const hasPostScript = instanceSize >= 4 + axisCount * 4 + 2;
  const instances = [];
  let ip = base + axesArrayOffset + axisCount * axisSize;
  for (let i = 0; i < instanceCount; i++) {
    const recStart = ip;
    const subfamilyNameID = buf.readUInt16BE(ip);
    // flags u16 @ +2 (skipped)
    const coords = {};
    let cp = ip + 4;
    for (let a = 0; a < axisCount; a++) {
      coords[axes[a].tag] = readFixed(buf, cp);
      cp += 4;
    }
    void hasPostScript; // postScriptNameID intentionally not surfaced
    const name = names.get(subfamilyNameID) ?? "";
    instances.push({ name, coords });
    ip = recStart + instanceSize;
  }

  return { axes, instances };
}

/**
 * Read the font's family name from the `name` table.
 * Prefers the typographic family (nameID 16), falling back to the legacy
 * family (nameID 1). Returns null if neither is present.
 *
 * @param {Buffer} buffer  raw .ttf / .otf bytes
 * @returns {string|null}
 */
export function readFontFamilyName(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const tables = readTableDirectory(buf);
  const names = readNameTable(buf, tables["name"]);
  return names.get(16) ?? names.get(1) ?? null;
}
