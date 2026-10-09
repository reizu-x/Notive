// js/core/zip.js — minimal ZIP writer for plaintext exports (pentest F-41).
// STORE-only entries (no compression): universally readable, and the payloads
// (markdown/JSON/CSV) barely compress anyway. Implemented here so the export
// feature stays dependency-free, offline, and CSP-safe (no wasm/eval).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function u16v(value) {
  return [value & 0xFF, (value >>> 8) & 0xFF];
}

function u32v(value) {
  return [value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF];
}

function concatByteArrays(parts, extraLength = 0) {
  const size = parts.reduce((sum, part) => sum + part.length, 0) + extraLength;
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/**
 * Build a STORE-only ZIP archive in memory.
 * entries: [{ name: string, data: Uint8Array }] — names must already be
 * archive-safe (traversal-free; the caller sanitizes via sanitizeFilename).
 * Returns a Blob (application/zip).
 */
export function buildStoreZip(entries) {
  const safe = (entries || []).map((entry) => ({
    name: new TextEncoder().encode(String(entry.name || 'file').replace(/[/\\]/g, '_')),
    data: entry.data instanceof Uint8Array ? entry.data : new Uint8Array(entry.data),
  }));
  const parts = [];
  let offset = 0;
  const central = [];
  for (const { name, data } of safe) {
    const crc = crc32(data);
    const local = new Uint8Array([
      ...u32v(0x04034b50),               // local file header signature
      ...u16v(20), ...u16v(0x0800),      // version needed, flags (F-48: UTF-8 names)
      ...u16v(0),                        // method: STORE
      ...u16v(0), ...u16v(0),            // mod time/date
      ...u32v(crc), ...u32v(data.length), ...u32v(data.length),
      ...u16v(name.length), ...u16v(0),  // name len, extra len
      ...name,
      ...data,
    ]);
    central.push(new Uint8Array([
      ...u32v(0x02014b50),               // central dir header
      ...u16v(20), ...u16v(0),           // versions
      ...u16v(0x0800), ...u16v(0),       // flags (F-48: UTF-8 names), method
      ...u16v(0), ...u16v(0),            // time/date
      ...u32v(crc), ...u32v(data.length), ...u32v(data.length),
      ...u16v(name.length), ...u16v(0), ...u16v(0), // name/extra/comment
      ...u16v(0), ...u16v(0), ...u32v(0),           // disk, attrs
      ...u32v(offset),                   // local header offset
      ...name,
    ]));
    parts.push(local);
    offset += local.length;
  }
  const centralBytes = concatByteArrays(central);
  parts.push(centralBytes);
  parts.push(new Uint8Array([
    ...u32v(0x06054b50),                 // EOCD
    ...u16v(0), ...u16v(0),              // disk numbers
    ...u16v(safe.length), ...u16v(safe.length),
    ...u32v(centralBytes.length),
    ...u32v(offset),                     // central dir offset
    ...u16v(0),                          // comment length
  ]));
  return new Blob([concatByteArrays(parts, 0)], { type: 'application/zip' });
}
