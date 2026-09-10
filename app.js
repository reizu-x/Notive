// ============================================================================
// Notely frontend (app.js) — single IIFE, 'use strict'.
// WHAT IT DOES: sidebar navigation, collections folders, note list tree,
// Markdown editor with live preview, templates, import/export, Bin (3-day
// soft-delete), Archive, right-click menus, themes, and the login gate.
// HOW DATA FLOWS: notes live in memory (`notes`) and sync encrypted to the
// server (PUT/GET /api/notes). Auth/session/profile live in the "Auth & E2EE"
// section near the end. localStorage holds ONLY non-secret UI state:
// collections order, deleted-folder entries, collapsed folders, theme,
// sidebar state. Rendering rule: every dynamic string goes through
// escapeHtml(); every rendered link/image URL through sanitizeUrl().
// SECTIONS (in order): Icons · Notes data + E2EE vault · Collections & Bin ·
// Note list tree · Editor · Context menu + delete dialogs · Templates ·
// Shell wiring (search/filters/nav/import/sidebar) · Auth & E2EE session ·
// Themes/settings · Boot.
// ============================================================================
'use strict';
(() => {
// Frame-busting: refuse to run inside a foreign iframe (clickjacking defense).
// The server also sends frame-ancestors 'self'.
try {
  if (window.top !== window.self) {
    window.top.location.href = window.self.location.href;
  }
} catch (error) {}

const iconPaths = {
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  dots: '<circle cx="5" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  inbox: '<path d="M4 5.5h16v13H4z"/><path d="M4 14h4l1.5 2h5L16 14h4"/>',
  star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/>',
  file: '<path d="M6 3.8h7l4 4v14.4H6z"/><path d="M13 3.8v4h4M9 12h5M9 16h5"/>',
  archive: '<path d="M4 7h16v13H4zM3 4h18v3H3zM9 11h6"/>',
  settings: '<path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 0 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 0 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V4a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 0 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2.9Z"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.4 2.4 0 1 1 4.1 1.7c-.9.8-1.8 1.2-1.8 2.6M12 16.7h.01"/>',
  search: '<circle cx="10.8" cy="10.8" r="6.5"/><path d="m16 16 4.3 4.3"/>',
  share: '<path d="M15 5h5v5M20 5l-9 9"/><path d="M18 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H11"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>',
  contrast: '<circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
  'check-square': '<path d="M5 4h14v16H5z"/><path d="m8 12 2.5 2.5L16 9"/>',
  link: '<path d="M10 13.5a4 4 0 0 0 5.7.1l2-2a4 4 0 0 0-5.7-5.7l-1.1 1.1"/><path d="M14 10.5a4 4 0 0 0-5.7-.1l-2 2a4 4 0 1 0 5.7 5.7l1.1-1.1"/>',
  focus: '<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3"/>',
  sidebar: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9.5 4v16"/>',
  folder: '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  'file-text': '<path d="M6 3.5h7l4 4v13H6z"/><path d="M13 3.5v4h4M9 12h5M9 16h5"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12 5 5 9-11"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .7h7.4a1 1 0 0 0 1-.7l.8-12"/><path d="M10 11v6M14 11v6"/>',
  cooking: '<path d="M4 12h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M2 12h20M9 8c0-2 2-2 2-4M13 8c0-2 2-2 2-4M9 12v6M15 12v6"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  'folder-plus': '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M12 11v6M9 14h6"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5"/><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h13l-2.5 4L18 12H5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0"/>',
  restore: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 17v2.5A1.5 1.5 0 0 0 5.5 21h13a1.5 1.5 0 0 0 1.5-1.5V17"/>'
};

// Look up an SVG path by name and wrap it in a standard 24px icon element. Unknown names render empty.
function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ''}</svg>`;
}

document.querySelectorAll('[data-icon]').forEach((element) => {
  element.innerHTML = icon(element.dataset.icon);
});

const starterNotes = [
  {
    id: 'inbox', title: 'Designing a calmer inbox', date: 'Today', tags: ['product', 'systems'], favorite: true, ext: 'md', collection: null,
    body: `# Designing a calmer inbox

The best inbox is not the one that holds everything. It is the one that makes the next right thing feel obvious.

## A few principles

- Give every message a clear home
- Keep the surface quiet
- Make decisions, not just lists

> Attention is a finite resource. Design around it.

### A small experiment

For one week, I am trying a simple rhythm: check twice a day, process to zero, and leave the rest for tomorrow.

- [x] Turn off non-essential notifications
- [x] Create a “read later” space
- [ ] Review the rhythm next Friday

The goal is not perfect productivity. It is making room for better work.`
  },
  {
    id: 'reading', title: 'A reading list for 2026', date: 'Yesterday', tags: ['reading'], favorite: false, ext: 'md', collection: 'Reading list',
    body: `# A reading list for 2026

Books, essays, and field notes I want to spend time with this year.

## Start here

- The Art of Gathering
- The Dawn of Everything
- Ways of Seeing

I want to read fewer things, more slowly, and keep a small note for each one.`
  },
  {
    id: 'north-star', title: 'Project north star', date: 'Mar 18', tags: ['product', 'work'], favorite: false, ext: 'md', collection: 'Work',
    body: `# Project north star

Build the smallest useful version, then learn from the people using it.

## What matters

1. Clear feedback loops
2. Fewer, better defaults
3. A product that feels good on a quiet Tuesday

> Make the important thing easy to find.`
  },
  {
    id: 'weekend', title: 'Weekend field notes', date: 'Mar 15', tags: ['personal'], favorite: false, ext: 'txt', collection: 'Personal',
    body: `# Weekend field notes

The farmers market was quieter than usual. Picked up citrus, sourdough, and a new plant for the studio.

The good kind of unplanned day.`
  },
  {
    id: 'meeting', title: 'Team check-in notes', date: 'Mar 12', tags: ['work'], favorite: false, ext: 'md', collection: 'Work',
    body: `# Team check-in notes

## Open threads

- Confirm the launch sequence
- Share the latest prototype
- Ask for feedback on onboarding

Next check-in: Thursday afternoon.`
  },
  {
    id: 'morning', title: 'A better morning ritual', date: 'Mar 09', tags: ['personal'], favorite: true, ext: 'txt', collection: 'Personal',
    body: `# A better morning ritual

No phone for the first thirty minutes. Water, a short walk, then a page of notes before the day starts asking for things.`
  }
];

// Create a collision-proof note id: crypto.randomUUID when available, else 16 random bytes, else timestamp+random fallback.
function newNoteId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return `note-${window.crypto.randomUUID()}`;
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return 'note-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    return `note-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

// Allowlist for note ids (letters, digits, _ and -, max 80 chars) so ids stay safe in DOM lookups and downloads.
function isValidNoteId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

// Build a safe download filename from a note title: strips path separators, control chars and dot-runs (no hidden double extensions).
function sanitizeFilename(name, ext) {
  const base = String(name == null ? 'note' : name).trim() || 'note';
  const clean = base.replace(/[^a-zA-Z0-9-_. ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'note';
  const safeExt = ext === 'txt' ? 'txt' : 'md';
  // Strip any extension confusion: never allow double extensions to hide type.
  const withoutDots = clean.replace(/\.+/g, '_');
  return `${withoutDots}.${safeExt}`;
}

// Clamp/normalize one stored note into the current schema (id, ext, collection, tags/title/body caps, deleted/archived flags, sane bin timestamps). Never throws on hostile input.
function migrateNote(note) {
  const migrated = (note && typeof note === 'object' && !Array.isArray(note)) ? { ...note } : {};
  if (!isValidNoteId(migrated.id)) migrated.id = newNoteId();
  if (migrated.ext !== 'txt' && migrated.ext !== 'md') {
    const extMatch = typeof migrated.title === 'string' ? migrated.title.match(/\.((md|markdown|txt|text))$/i) : null;
    if (extMatch) {
      const ext = extMatch[1].toLowerCase();
      migrated.ext = ext.startsWith('txt') || ext === 'text' ? 'txt' : 'md';
      migrated.title = migrated.title.slice(0, -(extMatch[0].length));
    } else {
      migrated.ext = 'md';
    }
  }
  if (!('collection' in migrated) || (migrated.collection !== null && typeof migrated.collection !== 'string')) {
    const tags = Array.isArray(migrated.tags) ? migrated.tags : [];
    if (tags.includes('work')) migrated.collection = 'Work';
    else if (tags.includes('personal')) migrated.collection = 'Personal';
    else if (tags.includes('reading')) migrated.collection = 'Reading list';
    else migrated.collection = null;
  }
  if (!Array.isArray(migrated.tags)) migrated.tags = [];
  else {
    // The draft tag is retired: strip it from old notes so it never renders.
    migrated.tags = migrated.tags
      .filter((tag) => typeof tag === 'string')
      .map((tag) => tag.trim().slice(0, 40))
      .filter((tag) => tag && tag.toLowerCase() !== 'draft')
      .slice(0, 20);
  }
  if (typeof migrated.title !== 'string' || !migrated.title.trim()) migrated.title = 'Untitled note';
  else migrated.title = migrated.title.trim().slice(0, 200);
  // Strip NULs: they are meaningless in text but double as internal
  // renderer placeholders — never let stored data carry them.
  if (typeof migrated.title === 'string' && migrated.title.includes('\u0000')) {
    migrated.title = migrated.title.replace(/\u0000/g, '') || 'Untitled note';
  }
  if (typeof migrated.body !== 'string') migrated.body = migrated.body == null ? '' : String(migrated.body).slice(0, 500000);
  else if (migrated.body.length > 500000) migrated.body = migrated.body.slice(0, 500000);
  if (migrated.body.includes('\u0000')) migrated.body = migrated.body.replace(/\u0000/g, '');
  if (typeof migrated.deleted !== 'boolean') migrated.deleted = false;
  if (typeof migrated.archived !== 'boolean') migrated.archived = false;
  // Clamp bin timestamps: future dates or ancient dates are reset to now.
  const nowTs = Date.now();
  const retention = 3 * 24 * 60 * 60 * 1000;
  if (migrated.deleted) {
    if (typeof migrated.deletedAt !== 'number' || !Number.isFinite(migrated.deletedAt) || migrated.deletedAt > nowTs || nowTs - migrated.deletedAt > retention + 86400000) {
      migrated.deletedAt = nowTs;
    }
  } else if ('deletedAt' in migrated) delete migrated.deletedAt;
  if (typeof migrated.favorite !== 'boolean') migrated.favorite = false;
  if (typeof migrated.date !== 'string') migrated.date = 'Now';
  if (typeof migrated.collection === 'string') migrated.collection = migrated.collection.trim().slice(0, 180) || null;
  if (!('recipe' in migrated) || (migrated.recipe !== null && typeof migrated.recipe !== 'string')) migrated.recipe = null;
  if (typeof migrated.recipe === 'string') migrated.recipe = migrated.recipe.trim().slice(0, 180) || null;
  if (!migrated.sections || typeof migrated.sections !== 'object' || Array.isArray(migrated.sections)) migrated.sections = {};
  else {
    const cleanedSections = {};
    for (const [key, value] of Object.entries(migrated.sections).slice(0, 20)) {
      if (typeof key === 'string' && key.trim() && (value === null || typeof value === 'string')) {
        const folder = value === null ? null : value.trim().slice(0, 60) || null;
        cleanedSections[key.trim().slice(0, 80)] = folder;
      }
    }
    migrated.sections = cleanedSections;
  }
  return migrated;
}

// Notes are the signed-in user's server-side data (GET/PUT /api/notes,
// AES-GCM encrypted at rest). Nothing note-shaped is written to localStorage:
// legacy plaintext keys are migrated once, then wiped (CWE-312 fix).
let notes = [];
let notesLoaded = false;
// True when the server E2EE envelope already supplied per-account UI state
// (v2 `ui`). loadUiVault() respects it and never overwrites it with a stale
// device-local copy from another account.
let serverUiLoaded = false;

// One-time read of pre-server localStorage note keys. Returns null when absent or invalid.
function readLegacyLocalNotes() {
  try {
    const raw = JSON.parse(localStorage.getItem('notely-notes') || localStorage.getItem('quietly-notes') || 'null');
    if (!Array.isArray(raw) || !raw.length) return null;
    return raw.map(migrateNote).slice(0, 2000);
  } catch (error) {
    return null;
  }
}

// Delete legacy plaintext note keys after server migration (CWE-312: no plaintext notes lingering on disk).
function wipeLegacyLocalNotes() {
  try {
    localStorage.removeItem('notely-notes');
    localStorage.removeItem('quietly-notes');
  } catch (error) {}
}

let syncTimer;

// --- End-to-end encryption -------------------------------------------------
// Note bodies/titles/tags/collections are encrypted on this device with the
// account master key (AES-GCM-256). The server only stores opaque blobs.
// The master key lives in memory only: it is created at registration (or
// unwrapped at login) and wiped on logout. Reloading with a valid session
// cookie still requires the password to unlock notes (locked vault).
// Must match the server's ARGON2_DESCRIPTOR exactly; both sides reject
// anything else (downgrade protection). PBKDF2 survives only for verifying
// pre-Argon2id logins, which auto-upgrade (see e2eeUpgradeKdf).
const E2EE_KDF_ARGON2ID = { kdf: 'argon2id', t: 3, m: 65536, p: 1 };
const e2ee = { masterKey: null, kdf: null, saltAuth: null, saltEnc: null, iterations: 0 };

// argon2-browser 1.18.0 vendored locally (dual-CDN byte-verified at vendor
// time). Every byte is hash-checked before execution: the scripts via SRI,
// the WASM blob via SubtleCrypto before the runtime ever sees it.
const ARGON2_VENDOR = {
  wrapperUrl: 'vendor/argon2/argon2-wrapper.js',
  wrapperSri: 'sha384-M0v+643vWImGSGCZxDlAOQ/Ca2ShlvWHrOSQizBcd/mtr40Ho/ErB/mrWLxlQ366',
  distUrl: 'vendor/argon2/argon2.js',
  distSri: 'sha384-am7P6S/HiklM8ZO8Ihrv1tCPTFPGfEnKfUn8cqws88YeMDJAx8PJ3gCTdcS1XBuz',
  wasmUrl: 'vendor/argon2/argon2.wasm',
  wasmSha384: '8d844225e9c10f9c576bd8380b2c3428082dff0a2db88b325b93e12eadf72b3b192327083f8ff26d70e2d207ee22b9e3',
};
let argon2LoadPromise = null;
async function sha384Hex(bytes) {
  const digest = await window.crypto.subtle.digest('SHA-384', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function fetchVerifiedBytes(url, expectedHex) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('argon2-fetch');
  const buf = new Uint8Array(await response.arrayBuffer());
  if (await sha384Hex(buf) !== expectedHex) throw new Error('argon2-integrity');
  return buf;
}
function injectVerifiedScript(url, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('argon2-load'));
    document.head.appendChild(script);
  });
}
async function loadArgon2() {
  if (!argon2LoadPromise) {
    argon2LoadPromise = (async () => {
      // Verify first, execute never-before-checked bytes never.
      const wasmBytes = await fetchVerifiedBytes(ARGON2_VENDOR.wasmUrl, ARGON2_VENDOR.wasmSha384);
      self.loadArgon2WasmBinary = async () => wasmBytes.slice(0);
      self.loadArgon2WasmModule = () => injectVerifiedScript(ARGON2_VENDOR.distUrl, ARGON2_VENDOR.distSri);
      await injectVerifiedScript(ARGON2_VENDOR.wrapperUrl, ARGON2_VENDOR.wrapperSri);
      if (!self.argon2 || typeof self.argon2.hash !== 'function') throw new Error('argon2-api');
      return self.argon2;
    })().catch((error) => { argon2LoadPromise = null; throw error; });
  }
  return argon2LoadPromise;
}
function assertArgon2Params(params) {
  if (!params || params.t !== E2EE_KDF_ARGON2ID.t || params.m !== E2EE_KDF_ARGON2ID.m || params.p !== E2EE_KDF_ARGON2ID.p) {
    throw new Error('e2ee-kdf');
  }
}
// Memory-hard password KDF shared bit-for-bit with the server (argon2-cffi,
// same t/m/p). ~0.5-2s per call; login/register/change show busy state.
async function argon2id32(password, saltBytes) {
  const lib = await loadArgon2();
  const result = await lib.hash({
    pass: password,
    salt: saltBytes instanceof Uint8Array ? saltBytes : new Uint8Array(saltBytes),
    time: E2EE_KDF_ARGON2ID.t,
    mem: E2EE_KDF_ARGON2ID.m,
    hashLen: 32,
    parallelism: E2EE_KDF_ARGON2ID.p,
    type: lib.ArgonType.Argon2id,
  });
  return new Uint8Array(result.hash);
}
async function e2eeWrapMasterKeyArgon2id(password, saltEncBytes, masterKeyRaw) {
  const rawKek = await argon2id32(password, saltEncBytes);
  const kek = await window.crypto.subtle.importKey('raw', rawKek, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, masterKeyRaw);
  return { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) };
}

// Uint8Array -> base64 string (for JSON-safe key material).
function e2eeBytesToB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}
// Base64 string -> Uint8Array. Throws on malformed input.
function e2eeB64ToBytes(b64) {
  const binary = atob(String(b64));
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) arr[i] = binary.charCodeAt(i);
  return arr;
}
// Cryptographically random bytes (salts, IVs, master keys).
function e2eeRandomBytes(length) {
  const arr = new Uint8Array(length);
  window.crypto.getRandomValues(arr);
  return arr;
}
// Import a password as a PBKDF2 base key (derive-only, never extractable).
async function e2eePasswordBase(password) {
  return window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
}
// Stretch a password into 256 raw bits (auth verifiers). Salt + iteration count come from the server.
async function e2eeDeriveBits(password, saltBytes, iterations) {
  const base = await e2eePasswordBase(password);
  const bits = await window.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, base, 256);
  return new Uint8Array(bits);
}
// Derive the non-extractable AES-GCM key-encryption key that wraps/unwraps the account master key.
async function e2eeKekFromPassword(password, saltBytes, iterations) {
  const base = await e2eePasswordBase(password);
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
// Wrap the 32-byte master key under the password KEK. Returns an {iv, data} base64 packet for the server.
async function e2eeWrapMasterKey(password, saltEncBytes, iterations, masterKeyRaw) {
  const kek = await e2eeKekFromPassword(password, saltEncBytes, iterations);
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, masterKeyRaw);
  return { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) };
}
// Unwrap the account master key with the password KEK. Throws (locked vault) on wrong password or corrupt wrap.
async function e2eeUnwrapMasterKey(password, saltEncBytes, iterations, wrapped) {
  const kek = await e2eeKekFromPassword(password, saltEncBytes, iterations);
  const raw = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapped.iv) }, kek, e2eeB64ToBytes(wrapped.data));
  // Extractable WITHIN this page so the key can be re-wrapped on rotation or
  // KDF upgrade. Page JS could use it while unlocked regardless (hence the
  // strict CSP + output sanitizers); it is still never persisted or sent.
  return window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
// Encrypt the whole workspace JSON with the in-memory master key. Returns an {iv, data} packet; server stores it opaquely.
async function e2eeEncryptNotes(noteArray) {
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, e2ee.masterKey, new TextEncoder().encode(JSON.stringify(noteArray)));
  return { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) };
}
// Decrypt a server payload with the in-memory master key and parse it. Returns
// the raw envelope: a legacy bare array, or {v, notes, vault} (vault items stay
// encrypted blobs until the vault password unlocks them). Throws otherwise.
async function e2eeDecryptPayload(payload) {
  const plain = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(payload.iv) }, e2ee.masterKey, e2eeB64ToBytes(payload.data));
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) return parsed;
  throw new Error('bad payload');
}
// Wipe all key material from memory (logout, failed unlock). Display/session state is cleared separately.
function e2eeLock() {
  e2ee.masterKey = null;
  e2ee.kdf = null;
  e2ee.saltAuth = null;
  e2ee.saltEnc = null;
  e2ee.iterations = 0;
}
// True when a session exists AND the master key is in memory (vault unlocked, notes readable).
function isUnlocked() {
  return Boolean(cachedProfile && e2ee.masterKey);
}
// The note the editor is bound to, whether it lives in the workspace or the
// unlocked Vault. Editor chrome (favorite/share/type/download/preview) goes
// through this so vault notes behave like normal ones.
function activeEditorNote() {
  if (activeView === 'vault') {
    if (!vault.unlocked || !currentVaultId) return null;
    return vault.notes.find((item) => item.id === currentVaultId) || null;
  }
  return currentNote();
}
// Central lock switch: disables editor inputs and hides New/Import while logged out or locked; otherwise defers to the note deleted/archived state. Runs after every list/selection render.
function refreshEditorLock() {
  let note = null;
  let locked = !isUnlocked();
  if (activeView === 'vault') {
    locked = locked || !vault.unlocked;
    if (!locked && currentVaultId) note = vault.notes.find((item) => item.id === currentVaultId) || null;
  } else if (currentId) {
    note = notes.find((item) => item.id === currentId) || null;
  }
  const readOnly = locked || !note || Boolean(note.deleted) || Boolean(note.archived);
  titleInput.disabled = readOnly;
  markdownInput.disabled = readOnly;
  const newNoteBtn = document.getElementById('new-note');
  const importBtn = document.getElementById('import-notes');
  if (newNoteBtn) newNoteBtn.hidden = locked || activeView === 'bin';
  if (importBtn) importBtn.hidden = locked || activeView === 'bin';
}

// Debounced encrypted upload of the workspace (notes + vault ciphertext +
// per-account UI state). No-ops without a session; reports Locked when the
// vault is locked. The server stores the blob opaquely — UI folders/sections
// ride along so every account keeps its own sidebar across relogs/devices.
async function syncNotesToServer() {
  if (!cachedProfile) return;
  if (!e2ee.masterKey) {
    saveLabel.textContent = 'Locked';
    return;
  }
  try {
    const envelope = { v: 2, notes, vault: await currentVaultBlobs() };
    try {
      if (typeof uiSnapshot === 'function') envelope.ui = uiSnapshot();
    } catch (error) {}
    const payload = await e2eeEncryptNotes(envelope);
    const response = await apiFetch('/api/notes', { method: 'PUT', body: JSON.stringify({ payload }) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    saveLabel.textContent = 'Saved';
  } catch (error) {
    saveLabel.textContent = 'Sync failed';
  }
}

// Immediate (non-debounced) upload used by logout/unload so the last edits
// are never stranded in a cancelled timer.
async function flushNotesToServer() {
  clearTimeout(syncTimer);
  await syncNotesToServer();
}

// Boot/load path: decrypts the server E2EE blob; adopts a legacy plaintext-shape row once; seeds starters only for brand-new accounts (updated_at distinguishes); offline falls back to the legacy local copy.
// The envelope is a bare array (very old), {v:1, notes, vault} (E2EE notes
// only) or {v:2, notes, vault, ui} (notes + per-account sidebar state). When
// the server carries UI state it wins over any device-local copy.
async function loadNotesFromServer() {
  try {
    const response = await apiFetch('/api/notes');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (data && data.payload) {
      // E2EE blob: only this device can read it. Envelope is either a legacy
      // bare notes array or {v, notes, vault} (vault items stay ciphertext).
      const envelope = await e2eeDecryptPayload(data.payload);
      const list = Array.isArray(envelope) ? envelope
        : (envelope && Array.isArray(envelope.notes) ? envelope.notes : null);
      if (!list) throw new Error('bad payload');
      notes = list.map(migrateNote).slice(0, 2000);
      const incomingBlobs = (!Array.isArray(envelope) && Array.isArray(envelope.vault))
        ? envelope.vault.filter(validVaultBlob).slice(0, 2000)
        : [];
      vault.blobs = incomingBlobs;
      if (vault.unlocked) {
        try { vault.notes = await decryptAllVaultBlobs(); }
        catch (error) { vault.notes = []; }
      }
      // Per-account UI state (v2): apply first so the sidebar matches the
      // account even on a fresh device. Falls back to the device-local vault
      // when the server predates v2.
      try {
        if (!Array.isArray(envelope) && envelope && envelope.ui && typeof applyUiSnapshot === 'function') {
          if (applyUiSnapshot(envelope.ui)) {
            serverUiLoaded = true;
            try { await writeUiVaultLocal(); } catch (error) {}
          }
        }
      } catch (error) {}
    } else if (Array.isArray(data.notes) && (data.notes.length || data.updated_at)) {
      // Legacy plaintext-shape response (pre-E2EE row): adopt, then the next
      // debounced save re-uploads it encrypted.
      notes = data.notes.map(migrateNote).slice(0, 2000);
      vault.blobs = [];
      await syncNotesToServer();
    } else {
      const legacy = readLegacyLocalNotes();
      notes = (legacy && legacy.length ? legacy : starterNotes.map(migrateNote)).slice(0, 2000);
      vault.blobs = [];
      await syncNotesToServer();
      wipeLegacyLocalNotes();
    }
    notesLoaded = true;
  } catch (error) {
    const legacy = readLegacyLocalNotes();
    notes = legacy || [];
    notesLoaded = true;
    showToast('Cannot reach the Notely server — working offline');
  }
}

const GENERAL_FOLDER = 'General';
const BIN_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const DEFAULT_COLLECTIONS = ['Work', 'Personal', 'Reading list'];
const COLLECTION_COLORS = ['coral', 'yellow', 'blue', 'mint', 'violet', 'rose'];
const COLLECTION_STORAGE_KEY = 'notely-collections';
const DELETED_COLLECTIONS_KEY = 'notely-deleted-collections';
const COLLAPSED_FOLDERS_KEY = 'notely-tree-collapsed';
const RECIPE_STORAGE_KEY = 'notely-recipe-collections';
const SECTION_DATA_KEY = 'notely-section-data';
// Per-account UI state (sidebar folders, recipes, custom sections, hidden
// sections, Bin entries, collapsed state). Source of truth is the server E2EE
// envelope (`ui` field, v2) so every account keeps its own sidebar across
// relogs and devices. A per-account encrypted localStorage copy is only a
// fast offline cache — never plaintext, never shared between accounts.
const UI_VAULT_KEY = 'notely-ui-vault';

// Locked-boot defaults: folder names stay unreadable until the vault unlocks.
// The legacy plaintext keys below are only ever READ, once, right after
// unlock (adoptLegacyUiKeys), then replaced by the encrypted vault.
let collections = [...DEFAULT_COLLECTIONS];
let deletedCollections = [];
let collapsedFolders = new Set();
let recipeCollections = [];
// User-built sidebar sections: [{ id, name, folders: [...] }]. Notes point at
// them via note.sections = { sectionId: folderPath }.
let customSections = [];
// Display-name overrides for the built-in sections ({ collections?, recipes? }).
let sectionNames = {};
// Built-in sections the user hid via Delete (e.g. ['recipes']). Persisted in
// the encrypted UI vault so an empty unwanted header stays gone.
let hiddenSections = [];
// Custom sections moved to Bin: [{ id, name, folders, deletedAt }]. Binned
// notes keep their section tags, so restoring a note revives its section.
let deletedCustomSections = [];
let uiVaultTimer = null;

// Device-local cache key, namespaced per account so two logins on one device
// can never decrypt (or overwrite) each other's sidebar.
function uiVaultKey() {
  try {
    const name = cachedProfile && cachedProfile.username ? String(cachedProfile.username).toLowerCase() : '';
    if (name) return `${UI_VAULT_KEY}:${name}`;
  } catch (error) {}
  return UI_VAULT_KEY;
}

// Plain-object snapshot of the whole sidebar state for the server envelope.
function uiSnapshot() {
  let theme = 'light';
  try {
    const current = document.documentElement.dataset.theme
      || localStorage.getItem('notely-theme') || 'light';
    if (['light', 'dark', 'dracula'].includes(current)) theme = current;
  } catch (error) {}
  return {
    collections: [...collections],
    deletedCollections: deletedCollections.map((entry) => ({ name: entry.name, deletedAt: entry.deletedAt })),
    collapsed: [...collapsedFolders],
    recipes: [...recipeCollections],
    customSections: customSections.map((section) => ({ id: section.id, name: section.name, folders: [...section.folders] })),
    sectionNames: { ...sectionNames },
    hiddenSections: [...(hiddenSections || [])],
    deletedCustomSections: (deletedCustomSections || []).map((entry) => ({
      id: entry.id, name: entry.name,
      folders: [...(entry.folders || [])], deletedAt: entry.deletedAt,
    })),
    theme,
  };
}

// Validate + normalize a UI snapshot from the server (never throws). Returns
// the cleaned object or null when unusable.
function cleanUiSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  out.collections = Array.isArray(value.collections)
    ? value.collections.filter((name) => typeof name === 'string' && name.trim()).slice(0, 200) : null;
  out.deletedCollections = Array.isArray(value.deletedCollections)
    ? value.deletedCollections.filter((entry) => entry && typeof entry.name === 'string' && entry.name.trim() && typeof entry.deletedAt === 'number').slice(0, 200) : null;
  out.collapsed = Array.isArray(value.collapsed)
    ? value.collapsed.filter((name) => typeof name === 'string').slice(0, 500) : null;
  out.recipes = Array.isArray(value.recipes)
    ? value.recipes.filter((name) => typeof name === 'string' && name.trim()).slice(0, 200) : null;
  const cleanCustom = cleanCustomSections(value.customSections);
  if (cleanCustom) out.customSections = cleanCustom;
  const cleanNames = cleanSectionNames(value.sectionNames);
  if (cleanNames) out.sectionNames = cleanNames;
  const cleanHidden = cleanHiddenSections(value.hiddenSections);
  if (cleanHidden) out.hiddenSections = cleanHidden;
  if (Array.isArray(value.deletedCustomSections)) {
    const cleanSections = value.deletedCustomSections.filter((entry) => (
      entry && typeof entry.id === 'string' && entry.id.trim()
      && typeof entry.name === 'string' && entry.name.trim()
      && typeof entry.deletedAt === 'number'
    )).map((entry) => ({
      id: entry.id.slice(0, 80), name: entry.name.trim().slice(0, 40),
      folders: Array.isArray(entry.folders)
        ? entry.folders.filter((name) => typeof name === 'string' && name.trim())
          .map((name) => name.trim().slice(0, 180)).slice(0, 200)
        : [],
      deletedAt: entry.deletedAt,
    })).slice(0, 20);
    if (cleanSections.length) out.deletedCustomSections = cleanSections;
  }
  if (typeof value.theme === 'string' && ['light', 'dark', 'dracula'].includes(value.theme)) {
    out.theme = value.theme;
  }
  if (out.collections === null && out.deletedCollections === null && out.collapsed === null
    && out.recipes === null && !out.customSections && !out.sectionNames && !out.hiddenSections && !out.deletedCustomSections && !out.theme) return null;
  return out;
}

// Apply a server/UI-vault snapshot to memory. Returns true when anything was adopted.
function applyUiSnapshot(value) {
  const clean = cleanUiSnapshot(value);
  if (!clean) return false;
  let adopted = false;
  if (clean.collections !== null) { collections = clean.collections; adopted = true; }
  if (clean.deletedCollections !== null) { deletedCollections = clean.deletedCollections; adopted = true; }
  if (clean.collapsed !== null) { collapsedFolders = new Set(clean.collapsed); adopted = true; }
  if (clean.recipes !== null) { recipeCollections = clean.recipes; adopted = true; }
  if (clean.customSections) { customSections = clean.customSections; adopted = true; }
  if (clean.sectionNames) { sectionNames = clean.sectionNames; adopted = true; }
  if (clean.hiddenSections) { hiddenSections = clean.hiddenSections; adopted = true; }
  if (clean.deletedCustomSections) { deletedCustomSections = clean.deletedCustomSections; adopted = true; }
  if (clean.theme) {
    try { applyTheme(clean.theme, false); } catch (error) {}
    adopted = true;
  }
  return adopted;
}

// Immediate encrypted write of the per-account local cache. Used by the
// debounced persistUiVault() and by the logout/pagehide flush path.
async function writeUiVaultLocal() {
  if (!e2ee.masterKey) return; // locked: never write (and never plaintext)
  let theme = 'light';
  try {
    const current = document.documentElement.dataset.theme
      || localStorage.getItem('notely-theme') || 'light';
    if (['light', 'dark', 'dracula'].includes(current)) theme = current;
  } catch (error) {}
  const snapshot = JSON.stringify({
    collections, deletedCollections, collapsed: [...collapsedFolders],
    recipes: recipeCollections, customSections, sectionNames,
    hiddenSections, deletedCustomSections, theme,
  });
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, e2ee.masterKey, new TextEncoder().encode(snapshot));
  try {
    localStorage.setItem(uiVaultKey(), JSON.stringify({ iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) }));
    // One-time migration: a legacy shared key decryptable with this account's
    // master key moves to the per-account key, then the shared slot is freed
    // so the next account starts clean instead of failing to decrypt it.
    try {
      if (uiVaultKey() !== UI_VAULT_KEY) {
        const rawLegacy = localStorage.getItem(UI_VAULT_KEY);
        if (rawLegacy) {
          const obj = JSON.parse(rawLegacy);
          const plain = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: e2eeB64ToBytes(obj.iv) }, e2ee.masterKey, e2eeB64ToBytes(obj.data));
          JSON.parse(new TextDecoder().decode(plain));
          localStorage.removeItem(UI_VAULT_KEY);
        }
      }
    } catch (error) {}
    localStorage.removeItem(COLLECTION_STORAGE_KEY);
    localStorage.removeItem(DELETED_COLLECTIONS_KEY);
    localStorage.removeItem(COLLAPSED_FOLDERS_KEY);
    localStorage.removeItem(RECIPE_STORAGE_KEY);
  } catch (error) {}
}

function persistUiVault() {
  clearTimeout(uiVaultTimer);
  uiVaultTimer = setTimeout(() => {
    (async () => {
      if (!e2ee.masterKey) return; // locked: never write (and never plaintext)
      try { await writeUiVaultLocal(); } catch (error) {}
      // The server envelope is the source of truth per account: schedule an
      // upload so sidebar changes survive relogs and follow the account.
      try { persistNotes(); } catch (error) {}
    })();
  }, 150);
}

// Flush a pending UI-vault write immediately (logout/unload path).
async function flushUiVault() {
  clearTimeout(uiVaultTimer);
  await writeUiVaultLocal();
}

function cleanCustomSections(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  value.slice(0, 20).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const id = typeof entry.id === 'string' ? entry.id.trim().slice(0, 80) : '';
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 40) : '';
    const folders = Array.isArray(entry.folders)
      ? entry.folders.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim().slice(0, 180)).slice(0, 200)
      : [];
    if (id && name) out.push({ id, name, folders });
  });
  return out;
}

function cleanSectionNames(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  ['collections', 'recipes'].forEach((kind) => {
    if (typeof value[kind] === 'string' && value[kind].trim()) {
      out[kind] = value[kind].trim().slice(0, 40);
    }
  });
  return out;
}

function cleanHiddenSections(value) {
  if (!Array.isArray(value)) return null;
  const out = value.filter((kind) => kind === 'collections' || kind === 'recipes').slice(0, 2);
  return [...new Set(out)];
}

// True when a built-in sidebar section was hidden via Delete.
function isBuiltinHidden(kind) {
  return Array.isArray(hiddenSections) && hiddenSections.includes(kind);
}

// Hide/show a built-in section and persist the choice.
function setBuiltinHidden(kind, hidden) {
  if (kind !== 'collections' && kind !== 'recipes') return;
  const next = new Set(hiddenSections || []);
  if (hidden) next.add(kind);
  else next.delete(kind);
  hiddenSections = [...next];
  persistUiVault();
  renderCollections();
}

function readLegacyUiKeys() {
  const out = { cols: null, del: null, collapsed: null, recipes: null, sections: null };
  try {
    const storedSections = JSON.parse(localStorage.getItem(SECTION_DATA_KEY) || 'null');
    if (storedSections && typeof storedSections === 'object') {
      const clean = cleanCustomSections(storedSections.sections);
      const names = cleanSectionNames(storedSections.names);
      if ((clean && clean.length) || (names && Object.keys(names).length)) {
        out.sections = { sections: clean || [], names: names || {} };
      }
    }
  } catch (error) {}
  try {
    const storedRecipes = JSON.parse(localStorage.getItem(RECIPE_STORAGE_KEY) || 'null');
    if (Array.isArray(storedRecipes)) {
      const recipes = storedRecipes.filter((name) => typeof name === 'string' && name.trim()).slice(0, 200);
      if (recipes.length) out.recipes = recipes;
    }
  } catch (error) {}
  try {
    const stored = JSON.parse(localStorage.getItem(COLLECTION_STORAGE_KEY) || 'null');
    if (Array.isArray(stored)) {
      const cols = stored.filter((name) => typeof name === 'string' && name.trim()).slice(0, 200);
      if (cols.length) out.cols = cols;
    }
  } catch (error) {}
  try {
    const storedDeleted = JSON.parse(localStorage.getItem(DELETED_COLLECTIONS_KEY) || 'null');
    if (Array.isArray(storedDeleted)) {
      const del = storedDeleted.filter((entry) => entry && typeof entry.name === 'string' && entry.name.trim() && typeof entry.deletedAt === 'number').slice(0, 200);
      if (del.length) out.del = del;
    }
  } catch (error) {}
  try {
    const storedCollapsed = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || 'null');
    if (Array.isArray(storedCollapsed)) {
      const collapsed = storedCollapsed.filter((name) => typeof name === 'string').slice(0, 500);
      out.collapsed = collapsed;
    }
  } catch (error) {}
  return out;
}

async function decryptUiVaultRaw(raw) {
  const obj = JSON.parse(raw);
  const plain = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(obj.iv) }, e2ee.masterKey, e2eeB64ToBytes(obj.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function loadUiVault() {
  // Server envelope (v2) already won: keep it, just refresh the per-account
  // local cache. Never let a stale device copy from another account clobber it.
  if (serverUiLoaded) {
    try { await writeUiVaultLocal(); } catch (error) {}
    return true;
  }
  // Per-account encrypted cache first; then the legacy shared slot (pre
  // per-account migration) when it decrypts with this account's key; else
  // adopt legacy plaintext keys once (then re-saved encrypted + uploaded).
  const keysToTry = [];
  try {
    const perUser = uiVaultKey();
    if (perUser) keysToTry.push(perUser);
    if (perUser !== UI_VAULT_KEY) keysToTry.push(UI_VAULT_KEY);
  } catch (error) { keysToTry.push(UI_VAULT_KEY); }
  for (const key of keysToTry) {
    try {
      const raw = localStorage.getItem(key);
      if (raw && e2ee.masterKey) {
        const vault = await decryptUiVaultRaw(raw);
        if (applyUiSnapshot(vault)) {
          // Promote a legacy shared-slot hit to the per-account key.
          try { await writeUiVaultLocal(); } catch (error) {}
          // This device knew more than the (v1) server row: push it up so the
          // next relog/device sees the same sidebar.
          try { persistNotes(); } catch (error) {}
          return true;
        }
      }
    } catch (error) { /* try next key, then legacy adopt */ }
  }
  const legacy = readLegacyUiKeys();
  let adopted = false;
  if (legacy.cols) { collections = legacy.cols; adopted = true; }
  if (legacy.del) { deletedCollections = legacy.del; adopted = true; }
  if (legacy.collapsed) { collapsedFolders = new Set(legacy.collapsed); adopted = true; }
  if (legacy.recipes) { recipeCollections = legacy.recipes; adopted = true; }
  if (legacy.sections) {
    customSections = legacy.sections.sections;
    sectionNames = legacy.sections.names;
    adopted = true;
  }
  if (adopted) {
    persistUiVault();
    try { persistNotes(); } catch (error) {}
  }
  return adopted;
}
// Persist the sidebar folder order/names into the encrypted UI vault.
function persistCollections() {
  persistUiVault();
}
// Persist the sidebar recipe-folder names into the encrypted UI vault.
function persistRecipeCollections() {
  persistUiVault();
}
// Persist binned-folder entries {name, deletedAt} into the encrypted UI vault.
function persistDeletedCollections() {
  persistUiVault();
}
// Persist binned custom-section records {id, name, folders, deletedAt}.
function persistDeletedCustomSections() {
  persistUiVault();
}
// True when a custom section id currently sits in Bin.
function isCustomSectionDeleted(id) {
  return (deletedCustomSections || []).some((entry) => entry.id === id);
}
// Drop section Bin records with no binned notes left (or past retention).
function pruneDeletedCustomSections() {
  const now = Date.now();
  const before = (deletedCustomSections || []).length;
  deletedCustomSections = (deletedCustomSections || []).filter((entry) => (
    now - entry.deletedAt <= BIN_RETENTION_MS
    && notes.some((note) => note.deleted && note.sections
      && typeof note.sections === 'object' && customNoteFolder(note, entry.id) !== null)
  ));
  if (deletedCustomSections.length !== before) persistDeletedCustomSections();
}
// True when a folder name currently sits in Bin.
function isCollectionDeleted(name) {
  return deletedCollections.some((entry) => entry.name === name);
}
// Stable dot color per folder: fixed brand colors for defaults, palette rotation by sidebar order, hash fallback for orphans.
function collectionColor(name) {
  const known = { Work: 'coral', Personal: 'yellow', 'Reading list': 'blue' };
  if (known[name]) return known[name];
  const index = collections.findIndex((entry) => entry === name);
  if (index >= 0) return COLLECTION_COLORS[index % COLLECTION_COLORS.length];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return COLLECTION_COLORS[Math.abs(hash) % COLLECTION_COLORS.length];
}
// De-duplicate a folder name (case-insensitive) against live, binned and reserved names by appending a counter.
function uniqueCollectionName(base) {
  const taken = new Set(collections.map((name) => name.toLowerCase()));
  deletedCollections.forEach((entry) => taken.add(entry.name.toLowerCase()));
  taken.add(GENERAL_FOLDER.toLowerCase());
  if (!taken.has(base.toLowerCase())) return base;
  let counter = 2;
  while (taken.has(`${base} ${counter}`.toLowerCase())) counter += 1;
  return `${base} ${counter}`;
}

// Permanently drop notes/folders past the 3-day retention; repairs tampered timestamps; drops folder entries with no binned notes left.
function purgeExpiredBin() {
  const now = Date.now();
  let changed = false;
  notes.forEach((note) => {
    // Repair tampered timestamps: future or non-finite values reset to now.
    if (note.deleted && (typeof note.deletedAt !== 'number' || !Number.isFinite(note.deletedAt) || note.deletedAt > now)) {
      note.deletedAt = now;
      changed = true;
    }
  });
  const before = notes.length;
  notes = notes.filter((note) => !(note.deleted && typeof note.deletedAt === 'number' && now - note.deletedAt > BIN_RETENTION_MS));
  if (notes.length !== before) changed = true;
  const foldersBefore = deletedCollections.length;
  deletedCollections = deletedCollections.filter((entry) => (
    now - entry.deletedAt <= BIN_RETENTION_MS
    && notes.some((note) => note.deleted && note.collection === entry.name)
  ));
  if (deletedCollections.length !== foldersBefore) changed = true;
  const sectionsBefore = (deletedCustomSections || []).length;
  deletedCustomSections = (deletedCustomSections || []).filter((entry) => (
    now - entry.deletedAt <= BIN_RETENTION_MS
    && notes.some((note) => note.deleted && note.sections
      && typeof note.sections === 'object' && customNoteFolder(note, entry.id) !== null)
  ));
  if (deletedCustomSections.length !== sectionsBefore) changed = true;
  if (changed) {
    persistDeletedCollections();
    persistDeletedCustomSections();
    persistNotes();
  }
  return changed;
}
purgeExpiredBin();

let currentId = null;
let activeView = 'notes';
let activeFilter = 'all';
let activeCollection = null;
let activeRecipe = null;
let activeSection = null; // 'collections' | 'recipes' | null — whole-section filter
let activeCustom = null; // { section: id, folder: path | null } | null — custom section/folder filter
let searchQuery = '';
let saveTimer;
// Persist collapsed tree-folder state into the encrypted UI vault.
function persistCollapsedFolders() {
  persistUiVault();
}
// ---- Sidebar collections & Bin: folder CRUD, sidebar render, sync with note data ----

const collectionList = document.getElementById('collection-list');

// Render the sidebar folder list (live folders only) plus the implicit General row whenever truly
// uncategorized notes exist (no collection AND not filed in a recipe/custom section).
function renderCollections() {
  if (!collectionList) return;
  const liveHasGeneral = notes.some((note) => !note.deleted && !note.collection && !hidesInGeneral(note));
  const generalRow = liveHasGeneral ? `
    <a href="#" class="collection-item${activeCollection === GENERAL_FOLDER ? ' active' : ''}" data-collection="${GENERAL_FOLDER}" data-depth="0" title="${GENERAL_FOLDER}">
      <span class="collection-dot general"></span>
      <span class="collection-label">${GENERAL_FOLDER}</span>
      <span class="collection-actions">
        <button type="button" class="collection-action" data-collection-rename="${GENERAL_FOLDER}" title="Rename folder" aria-label="Rename ${GENERAL_FOLDER}">${icon('pencil')}</button>
      </span>
      <input class="collection-rename-input" value="${GENERAL_FOLDER}" hidden maxlength="180" aria-label="Folder name" />
    </a>` : '';
  collectionList.innerHTML = collections.filter((name) => !isCollectionDeleted(name)).map((name) => `
    <a href="#" draggable="true" class="collection-item${activeCollection === name ? ' active' : ''}" data-collection="${escapeHtml(name)}" data-depth="${folderDepth(name)}" title="${escapeHtml(name)}">
      <span class="collection-dot ${collectionColor(name)}"></span>
      <span class="collection-label">${escapeHtml(folderLeaf(name))}</span>
      <span class="collection-actions">
        <button type="button" class="collection-action" data-collection-rename="${escapeHtml(name)}" title="Rename folder" aria-label="Rename ${escapeHtml(name)}">${icon('pencil')}</button>
      </span>
      <input class="collection-rename-input" value="${escapeHtml(folderLeaf(name))}" hidden maxlength="180" aria-label="Folder name" />
    </a>`).join('') + generalRow;
  // The Recipes + custom sections always mirror alongside (same sidebar, own namespaces).
  renderRecipeCollections();
  renderCustomSections();
  updateSectionHeaders();
  const collectionsSection = document.querySelector('.sidebar-section[data-section="collections"]');
  if (collectionsSection) {
    collectionsSection.classList.toggle('active-section', activeSection === 'collections');
    collectionsSection.style.display = isBuiltinHidden('collections') ? 'none' : '';
  }
}

// Reconcile sidebar with note data: adopt unknown live folders (normalizing case/whitespace), never resurrect binned ones.
function syncCollectionsWithNotes() {
  let notesDirty = false;
  let collectionsDirty = false;
  const binnedNames = new Set(deletedCollections.map((entry) => entry.name.toLowerCase()));
  notes.forEach((note) => {
    if (note.deleted) return;
    if (typeof note.collection !== 'string' || !note.collection.trim()) {
      if (note.collection !== null && note.collection !== undefined) {
        note.collection = null;
        notesDirty = true;
      }
      return;
    }
    const trimmed = note.collection.trim();
    if (binnedNames.has(trimmed.toLowerCase())) return;
    const canonical = collections.find((entry) => entry.toLowerCase() === trimmed.toLowerCase());
    if (canonical) {
      if (note.collection !== canonical) {
        note.collection = canonical;
        notesDirty = true;
      }
    } else {
      collections.push(trimmed);
      if (note.collection !== trimmed) {
        note.collection = trimmed;
        notesDirty = true;
      }
      collectionsDirty = true;
    }
  });
  if (notesDirty) persistNotes();
  if (collectionsDirty) persistCollections();
  if (collectionsDirty && isBuiltinHidden('collections')) {
    hiddenSections = (hiddenSections || []).filter((kind) => kind !== 'collections');
    persistUiVault();
    syncSideMenuSettings();
  }
  // Recipes + custom sections ride along: one choke point keeps all sidebars in sync.
  syncRecipeCollections();
  syncCustomSections();
}

// Filter the list to one folder: resets view/filter/search, updates the heading, re-renders.
function selectCollection(name) {
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  activeView = 'notes';
  activeFilter = 'all';
  activeCollection = name;
  activeRecipe = null;
  activeSection = null;
  activeCustom = null;
  clearSearch();
  updateListHeading();
  renderCollections();
  renderNoteList();
}

// Validate and rename a folder everywhere (notes, collapsed state, selection, Bin entries).
// Renaming General spawns a real folder. Renaming a parent re-parents its whole subtree.
function renameCollection(oldName, rawNewName, opts) {
  const newName = cleanFolderPath(rawNewName);
  if (!newName) { renderCollections(); renderNoteList(); return false; }
  if (newName === oldName) { renderCollections(); renderNoteList(); return true; }
  if (newName.toLowerCase() === GENERAL_FOLDER.toLowerCase() && oldName !== GENERAL_FOLDER) {
    showToast(`“${GENERAL_FOLDER}” is reserved`);
    renderCollections(); renderNoteList();
    return false;
  }
  const duplicate = oldName === GENERAL_FOLDER
    ? collections.some((entry) => entry.toLowerCase() === newName.toLowerCase())
    : collections.some((entry) => entry !== oldName && entry.toLowerCase() === newName.toLowerCase());
  const collidesWithBin = deletedCollections.some((entry) => entry.name.toLowerCase() === newName.toLowerCase());
  if (duplicate || collidesWithBin) {
    showToast(collidesWithBin && !duplicate ? 'A folder with that name is in Bin' : 'A folder with that name already exists');
    renderCollections(); renderNoteList();
    return false;
  }
  if (oldName === GENERAL_FOLDER) {
    // Renaming General gives its truly uncategorized notes a real collection
    // (notes filed in a recipe/custom section keep living only there).
    collections.push(newName);
    notes.forEach((note) => { if (!note.collection && !hidesInGeneral(note)) note.collection = newName; });
    if (collapsedFolders.has(GENERAL_FOLDER)) { collapsedFolders.delete(GENERAL_FOLDER); }
  } else {
    const index = collections.findIndex((entry) => entry === oldName);
    if (index === -1) return false;
    const oldPrefix = `${oldName}${FOLDER_SEP}`;
    collections = repathList(collections, oldName, newName);
    notes.forEach((note) => {
      if (typeof note.collection === 'string' && isFolderOrSub(note.collection, oldName)) {
        note.collection = note.collection === oldName ? newName : newName + note.collection.slice(oldName.length);
      }
    });
    const collapsed = new Set();
    collapsedFolders.forEach((entry) => {
      collapsed.add(entry === oldName ? newName : (entry.startsWith(oldPrefix) ? newName + entry.slice(oldName.length) : entry));
    });
    collapsedFolders = collapsed;
    deletedCollections.forEach((entry) => {
      if (entry.name === oldName) entry.name = newName;
      else if (entry.name.startsWith(oldPrefix)) entry.name = newName + entry.name.slice(oldName.length);
    });
    if (activeCollection && isFolderOrSub(activeCollection, oldName)) {
      activeCollection = activeCollection === oldName ? newName : newName + activeCollection.slice(oldName.length);
      updateListHeading();
    }
  }
  persistCollections();
  persistCollapsedFolders();
  persistNotes();
  persistDeletedCollections();
  renderCollections();
  renderNoteList();
  if (!opts || !opts.silent) showToast(`Folder renamed to “${newName}”`);
  return true;
}

// Rewrite exact + descendant paths in a folder list (sidebar, collapsed keys).
function repathList(list, oldPath, newPath) {
  const prefix = `${oldPath}${FOLDER_SEP}`;
  return list.map((entry) => {
    if (entry === oldPath) return newPath;
    if (entry.startsWith(prefix)) return newPath + entry.slice(oldPath.length);
    return entry;
  });
}

// Soft-delete a folder: removes it from the sidebar and bins all its live notes for 3 days (General clears
// truly uncategorized notes into Bin — notes filed in a recipe/custom section are left alone).
function deleteCollection(name) {
  if (name === GENERAL_FOLDER) {
    const now = Date.now();
    let count = 0;
    notes.forEach((note) => {
      if (!note.deleted && !note.collection && !hidesInGeneral(note)) {
        note.deleted = true;
        note.deletedAt = now;
        count += 1;
      }
    });
    if (!count) return;
    if (activeCollection === GENERAL_FOLDER) {
      activeCollection = null;
      activeSection = null;
      activeCustom = null;
      activeFilter = 'all';
      listHeading.textContent = 'All notes';
      document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
      document.querySelectorAll('#collection-list .collection-item').forEach((item) => item.classList.remove('active'));
      document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
    }
    const current = currentId ? notes.find((item) => item.id === currentId) : null;
    if (!current || current.deleted) {
      activeView = 'notes';
      document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
      const live = notes.filter((item) => !item.deleted && !item.archived);
      if (live.length) selectNote(live[0].id);
      else clearEditor();
    }
    persistNotes();
    renderCollections();
    renderNoteList();
    showToast(`General cleared — ${count} note${count === 1 ? '' : 's'} moved to Bin`);
    return;
  }
  const index = collections.findIndex((entry) => entry === name);
  if (index === -1) return;
  // Cascade: the folder and every nested subfolder move to Bin together.
  const doomed = collections.filter((entry) => isFolderOrSub(entry, name));
  collections = collections.filter((entry) => !isFolderOrSub(entry, name));
  const movedAt = Date.now();
  notes.forEach((note) => {
    if (!note.deleted && typeof note.collection === 'string' && isFolderOrSub(note.collection, name)) {
      note.deleted = true;
      note.deletedAt = movedAt;
    }
  });
  deletedCollections = deletedCollections.filter((entry) => !isFolderOrSub(entry.name, name));
  doomed.forEach((entry) => {
    if (notes.some((note) => note.deleted && note.collection === entry)) {
      deletedCollections.push({ name: entry, deletedAt: movedAt });
    }
  });
  persistDeletedCollections();
  const keptCollapsed = new Set();
  collapsedFolders.forEach((entry) => { if (!isFolderOrSub(entry, name)) keptCollapsed.add(entry); });
  collapsedFolders = keptCollapsed;
  if (activeCollection && isFolderOrSub(activeCollection, name)) {
    activeCollection = null;
    activeSection = null;
    activeCustom = null;
    activeFilter = 'all';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    document.querySelectorAll('#collection-list .collection-item').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  }
  const current = currentId ? notes.find((item) => item.id === currentId) : null;
  if (!current || current.deleted) {
    activeView = 'notes';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    const live = notes.filter((item) => !item.deleted && !item.archived);
    if (live.length) selectNote(live[0].id);
    else clearEditor();
  }
  updateListHeading();
  persistCollections();
  persistCollapsedFolders();
  persistNotes();
  renderCollections();
  renderNoteList();
  showToast(`Folder “${name}” moved to Bin — kept for 3 days`);
}

// Revive binned custom sections a (newly live) note belongs to, so it has
// a home. Recipe/custom folders inside live sections are re-adopted by the
// sidebar sync that callers run afterwards.
function reviveSectionsForNote(note) {
  if (!note || !note.sections || typeof note.sections !== 'object') return false;
  let revived = false;
  Object.keys(note.sections).forEach((sectionId) => {
    if (customNoteFolder(note, sectionId) === null) return;
    if (customSections.some((entry) => entry.id === sectionId)) return;
    const stashed = (deletedCustomSections || []).find((entry) => entry.id === sectionId);
    if (stashed) {
      const folders = [...(stashed.folders || [])];
      if (!folders.some((entry) => entry === note.sections[sectionId])) folders.push(note.sections[sectionId]);
      customSections.push({ id: stashed.id, name: stashed.name, folders });
    } else {
      customSections.push({ id: sectionId, name: 'Restored section', folders: [note.sections[sectionId]] });
    }
    revived = true;
  });
  if (revived) {
    persistCustomSections();
    pruneDeletedCustomSections();
  }
  return revived;
}

// Restore a binned folder: drops its Bin entry and unbans (undeletes) all its notes, then re-syncs the sidebar.
function restoreCollection(name) {
  if (!isCollectionDeleted(name)) return;
  deletedCollections = deletedCollections.filter((entry) => entry.name !== name);
  persistDeletedCollections();
  notes.forEach((note) => {
    if (note.deleted && note.collection === name) {
      note.deleted = false;
      delete note.deletedAt;
      reviveSectionsForNote(note);
    }
  });
  syncCollectionsWithNotes();
  persistNotes();
  renderCollections();
  if (activeView === 'bin') {
    const binned = notes.filter((item) => item.deleted);
    if (binned.length) selectNote(binned[0].id);
    else clearEditor();
  }
  renderNoteList();
  showToast(`Folder “${name}” restored`);
}

// Erase a binned folder and all its binned notes at once; repairs the current selection.
function permanentlyDeleteCollection(name) {
  if (!isCollectionDeleted(name)) return;
  deletedCollections = deletedCollections.filter((entry) => entry.name !== name);
  persistDeletedCollections();
  notes = notes.filter((note) => !(note.deleted && note.collection === name));
  if (currentId && !notes.some((item) => item.id === currentId)) {
    const pool = activeView === 'bin' ? notes.filter((item) => item.deleted) : notes.filter((item) => !item.deleted);
    if (pool.length) selectNote(pool[0].id);
    else clearEditor();
  } else {
    renderNoteList();
  }
  persistNotes();
  try { pruneDeletedCustomSections(); } catch (error) {}
  renderNoteList();
  showToast(`Folder “${name}” permanently deleted`);
}

// Find a sidebar row by exact dataset value (avoids CSS-escaping pitfalls of quoted selectors).
function findSidebarItem(name) {
  if (!collectionList) return null;
  return [...collectionList.querySelectorAll('.collection-item')].find((item) => item.dataset.collection === name) || null;
}

// Find an All-Notes folder group by exact dataset value (avoids CSS-escaping pitfalls).
function findTreeWrap(folder) {
  return [...noteList.querySelectorAll('[data-folder-wrap]')].find((wrap) => wrap.dataset.folderWrap === folder) || null;
}

// Inline sidebar rename: swaps the label for an input; Enter commits, Escape cancels, blur commits.
function startSidebarRename(name) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  renderCollections();
  const item = findSidebarItem(name);
  if (!item) return;
  const input = item.querySelector('.collection-rename-input');
  const label = item.querySelector('.collection-label');
  const actions = item.querySelector('.collection-actions');
  if (!input) return;
  input.hidden = false;
  if (label) label.hidden = true;
  if (actions) actions.hidden = true;
  input.value = folderLeaf(name);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    // Leaf-only commit: the parent prefix is re-attached so the folder (and
    // its children) cannot slip out of place.
    if (commit) renameCollection(name, joinLeafRename(name, input.value));
    else { renderCollections(); renderNoteList(); }
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  };
  input.onclick = (event) => event.stopPropagation();
  input.onblur = () => finish(true);
}

// Create a uniquely-named folder, reset view/filters, and immediately open inline rename.
function addCollectionFolder() {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  const name = uniqueCollectionName('New folder');
  collections.push(name);
  if (isBuiltinHidden('collections')) {
    hiddenSections = (hiddenSections || []).filter((kind) => kind !== 'collections');
    syncSideMenuSettings();
  }
  persistCollections();
  if (collapsedFolders.has(name)) { collapsedFolders.delete(name); persistCollapsedFolders(); }
  activeView = 'notes';
  activeCollection = null;
  activeRecipe = null;
  activeSection = null;
  activeCustom = null;
  activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCollections();
  renderNoteList();
  showToast('Folder added — name it');
  startSidebarRename(name);
}

// Delegated sidebar clicks (rename/delete/select) plus double-click to rename. Delegation survives innerHTML re-renders.
function bindCollectionListEvents() {
  if (!collectionList) return;
  collectionList.addEventListener('click', (event) => {
    const renameBtn = event.target.closest('[data-collection-rename]');
    if (renameBtn) {
      event.preventDefault();
      event.stopPropagation();
      startSidebarRename(renameBtn.dataset.collectionRename);
      return;
    }
    const item = event.target.closest('.collection-item');
    if (!item) return;
    if (event.target.closest('.collection-rename-input')) return;
    event.preventDefault();
    selectCollection(item.dataset.collection);
  });
  collectionList.addEventListener('dblclick', (event) => {
    const item = event.target.closest('.collection-item');
    if (!item || event.target.closest('.collection-rename-input') || event.target.closest('.collection-action')) return;
    event.preventDefault();
    startSidebarRename(item.dataset.collection);
  });
}

// ---- Sidebar Recipes: same folder mechanics as Collections, own namespace.
// A note holds at most one recipe folder (note.recipe); selecting a recipe
// folder filters the list, and new notes created inside it join it.
const recipeList = document.getElementById('recipe-list');

// Render the sidebar recipe folders (only folders that exist; no General row).
function renderRecipeCollections() {
  if (!recipeList) return;
  recipeList.innerHTML = recipeCollections.map((name) => `
    <a href="#" draggable="true" class="collection-item${activeRecipe === name ? ' active' : ''}" data-recipe="${escapeHtml(name)}" data-depth="${folderDepth(name)}" title="${escapeHtml(name)}">
      <span class="collection-dot ${recipeColor(name)}"></span>
      <span class="collection-label">${escapeHtml(folderLeaf(name))}</span>
      <span class="collection-actions">
        <button type="button" class="collection-action" data-recipe-rename="${escapeHtml(name)}" title="Rename folder" aria-label="Rename ${escapeHtml(name)}">${icon('pencil')}</button>
      </span>
      <input class="collection-rename-input" value="${escapeHtml(folderLeaf(name))}" hidden maxlength="180" aria-label="Folder name" />
    </a>`).join('');
  const recipesSection = document.querySelector('.sidebar-section[data-section="recipes"]');
  if (recipesSection) {
    recipesSection.classList.toggle('active-section', activeSection === 'recipes');
    recipesSection.style.display = isBuiltinHidden('recipes') ? 'none' : '';
  }
}

// Stable dot color per recipe folder (palette rotation by sidebar order).
function recipeColor(name) {
  const index = recipeCollections.findIndex((entry) => entry === name);
  if (index >= 0) return COLLECTION_COLORS[(index + 2) % COLLECTION_COLORS.length];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return COLLECTION_COLORS[Math.abs(hash) % COLLECTION_COLORS.length];
}

// De-duplicate a recipe folder name (case-insensitive) by appending a counter.
function uniqueRecipeName(base) {
  const taken = new Set(recipeCollections.map((name) => name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  let counter = 2;
  while (taken.has(`${base} ${counter}`.toLowerCase())) counter += 1;
  return `${base} ${counter}`;
}

// Adopt recipe folders found on live notes that the sidebar does not list yet
// (imports, older data), normalizing case onto the sidebar spelling.
function syncRecipeCollections() {
  let notesDirty = false;
  let recipesDirty = false;
  notes.forEach((note) => {
    if (note.deleted || typeof note.recipe !== 'string' || !note.recipe.trim()) return;
    const trimmed = note.recipe.trim();
    const canonical = recipeCollections.find((entry) => entry.toLowerCase() === trimmed.toLowerCase());
    if (canonical) {
      if (note.recipe !== canonical) { note.recipe = canonical; notesDirty = true; }
    } else {
      recipeCollections.push(trimmed);
      if (note.recipe !== trimmed) { note.recipe = trimmed; notesDirty = true; }
      recipesDirty = true;
    }
  });
  if (notesDirty) persistNotes();
  if (recipesDirty) persistRecipeCollections();
  if (recipesDirty && isBuiltinHidden('recipes')) {
    hiddenSections = (hiddenSections || []).filter((kind) => kind !== 'recipes');
    persistUiVault();
    syncSideMenuSettings();
  }
}

// Filter the list to one recipe folder (clears any collection selection).
function selectRecipe(name) {
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  activeView = 'notes';
  activeFilter = 'all';
  activeCollection = null;
  activeRecipe = name;
  activeSection = null;
  activeCustom = null;
  clearSearch();
  updateListHeading();
  renderCollections();
  renderRecipeCollections();
  renderNoteList();
}

function findRecipeItem(name) {
  if (!recipeList) return null;
  return [...recipeList.querySelectorAll('.collection-item')].find((item) => item.dataset.recipe === name) || null;
}

// Inline sidebar rename for a recipe folder; Enter commits, Escape cancels.
function startRecipeRename(name) {
  renderRecipeCollections();
  const item = findRecipeItem(name);
  if (!item) return;
  const input = item.querySelector('.collection-rename-input');
  const label = item.querySelector('.collection-label');
  const actions = item.querySelector('.collection-actions');
  if (!input) return;
  input.hidden = false;
  if (label) label.hidden = true;
  if (actions) actions.hidden = true;
  input.value = folderLeaf(name);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    // Leaf-only commit: the parent prefix is re-attached so the folder (and
    // its children) cannot slip out of place.
    if (commit) renameRecipe(name, joinLeafRename(name, input.value));
    else { renderRecipeCollections(); renderNoteList(); }
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  };
  input.onclick = (event) => event.stopPropagation();
  input.onblur = () => finish(true);
}

// Validate and rename a recipe folder on the folder, its subtree and all matching notes.
function renameRecipe(oldName, rawNewName, opts) {
  const newName = cleanFolderPath(rawNewName);
  if (!newName) { renderRecipeCollections(); renderNoteList(); return false; }
  if (newName === oldName) { renderRecipeCollections(); renderNoteList(); return true; }
  if (recipeCollections.some((entry) => entry !== oldName && entry.toLowerCase() === newName.toLowerCase())) {
    showToast('A folder with that name already exists');
    renderRecipeCollections(); renderNoteList();
    return false;
  }
  const index = recipeCollections.findIndex((entry) => entry === oldName);
  if (index === -1) return false;
  recipeCollections = repathList(recipeCollections, oldName, newName);
  notes.forEach((note) => {
    if (typeof note.recipe === 'string' && isFolderOrSub(note.recipe, oldName)) {
      note.recipe = note.recipe === oldName ? newName : newName + note.recipe.slice(oldName.length);
    }
  });
  if (activeRecipe && isFolderOrSub(activeRecipe, oldName)) {
    activeRecipe = activeRecipe === oldName ? newName : newName + activeRecipe.slice(oldName.length);
    updateListHeading();
  }
  persistRecipeCollections();
  persistNotes();
  renderRecipeCollections();
  renderNoteList();
  if (!opts || !opts.silent) showToast(`Folder renamed to “${newName}”`);
  return true;
}

// Delete a recipe folder and its nested subfolders: the folder is removed
// from the sidebar and every live note inside moves to Bin for 3 days (tags
// are kept, so restoring a note revives its folder via the sidebar sync).
function deleteRecipe(name) {
  const index = recipeCollections.findIndex((entry) => entry === name);
  if (index === -1) return;
  const movedAt = Date.now();
  let count = 0;
  notes.forEach((note) => {
    if (!note.deleted && typeof note.recipe === 'string' && isFolderOrSub(note.recipe, name)) {
      note.deleted = true;
      note.deletedAt = movedAt;
      count += 1;
    }
  });
  recipeCollections = recipeCollections.filter((entry) => !isFolderOrSub(entry, name));
  if (activeRecipe && isFolderOrSub(activeRecipe, name)) {
    activeRecipe = null;
    activeSection = null;
    activeFilter = 'all';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
    updateListHeading();
  }
  const current = currentId ? notes.find((item) => item.id === currentId) : null;
  if (!current || current.deleted) {
    activeView = 'notes';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    const live = notes.filter((item) => !item.deleted && !item.archived);
    if (live.length) selectNote(live[0].id);
    else clearEditor();
  }
  persistRecipeCollections();
  persistNotes();
  renderRecipeCollections();
  renderNoteList();
  showToast(count
    ? `Recipe folder “${name}” moved to Bin — ${count} note${count === 1 ? '' : 's'} kept for 3 days`
    : `Recipe folder “${name}” deleted`);
}

function openBuiltinSectionDeleteConfirm(kind) {
  if (!e2ee.masterKey) { showToast('Log in to manage sections'); return; }
  if (kind !== 'collections' && kind !== 'recipes') return;
  const name = sectionDisplayName(kind);
  const count = notes.filter((note) => {
    if (note.deleted) return false;
    if (kind === 'recipes') return typeof note.recipe === 'string' && note.recipe;
    return true;
  }).length;
  pendingDeleteId = kind;
  pendingDeleteMode = 'builtin-section';
  setDeleteDialog({
    eyebrow: 'Delete section',
    title: `Delete section “${name}”?`,
    name,
    message: count
      ? `” organizes ${count} note${count === 1 ? '' : 's'}. The notes stay in place, only the folders are removed and the section is hidden (restore it in Settings → Side Menu). Are you sure?`
      : '” has no notes in it. The section will be hidden (restore it in Settings → Side Menu). Are you sure?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Delete every folder in a built-in section and hide the section header;
// notes keep everything else. Restore via Settings → Side Menu.
// (Custom sections have deleteCustomSection; single folders use their own confirms.)
function deleteBuiltinSection(kind) {
  if (kind !== 'collections' && kind !== 'recipes') return;
  const name = sectionDisplayName(kind);
  if (kind === 'recipes') {
    recipeCollections = [];
    notes.forEach((note) => { if (typeof note.recipe === 'string') note.recipe = null; });
    if (activeRecipe || activeSection === 'recipes') {
      activeRecipe = null;
      activeSection = null;
      activeFilter = 'all';
      document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
      document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
      updateListHeading();
    }
    persistRecipeCollections();
  } else {
    collections = [];
    // Live notes lose their folder; binned notes keep their paths so Bin and
    // folder restore stay coherent.
    notes.forEach((note) => { if (!note.deleted && typeof note.collection === 'string') note.collection = null; });
    if (activeCollection || activeSection === 'collections') {
      activeCollection = null;
      activeSection = null;
      activeFilter = 'all';
      document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
      document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
      updateListHeading();
    }
    persistCollections();
  }
  if (!isBuiltinHidden(kind)) {
    hiddenSections = [...(hiddenSections || []), kind];
    persistUiVault();
  }
  persistNotes();
  renderCollections();
  syncSideMenuSettings();
  renderNoteList();
  showToast(`Section “${name}” deleted`);
}

function openRecipeDeleteConfirm(name) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  if (!recipeCollections.includes(name)) return;
  const count = notes.filter((note) => !note.deleted && typeof note.recipe === 'string' && isFolderOrSub(note.recipe, name)).length;
  pendingDeleteId = name;
  pendingDeleteMode = 'recipe';
  setDeleteDialog({
    eyebrow: 'Delete folder',
    title: 'Delete this folder?',
    name,
    message: count
      ? `” holds ${count} note${count === 1 ? '' : 's'}. The folder and its notes will move to Bin for 3 days. Are you sure?`
      : '” is empty. Are you sure you want to delete it?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

function addRecipeFolder() {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  const name = uniqueRecipeName('New folder');
  recipeCollections.push(name);
  if (isBuiltinHidden('recipes')) {
    hiddenSections = (hiddenSections || []).filter((kind) => kind !== 'recipes');
    syncSideMenuSettings();
  }
  persistRecipeCollections();
  activeView = 'notes';
  activeCollection = null;
  activeRecipe = null;
  activeSection = null;
  activeCustom = null;
  activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCollections();
  renderRecipeCollections();
  renderNoteList();
  showToast('Folder added — name it');
  startRecipeRename(name);
}

function bindRecipeListEvents() {
  if (!recipeList) return;
  recipeList.addEventListener('click', (event) => {
    const renameBtn = event.target.closest('[data-recipe-rename]');
    if (renameBtn) {
      event.preventDefault();
      event.stopPropagation();
      startRecipeRename(renameBtn.dataset.recipeRename);
      return;
    }
    const item = event.target.closest('.collection-item');
    if (!item) return;
    if (event.target.closest('.collection-rename-input')) return;
    event.preventDefault();
    selectRecipe(item.dataset.recipe);
  });
  recipeList.addEventListener('dblclick', (event) => {
    const item = event.target.closest('.collection-item');
    if (!item || event.target.closest('.collection-rename-input') || event.target.closest('.collection-action')) return;
    event.preventDefault();
    startRecipeRename(item.dataset.recipe);
  });
}
function bindSectionHeaderEvents() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.addEventListener('click', (event) => {
    const delBtn = event.target.closest('[data-del-section]');
    if (delBtn) {
      event.preventDefault();
      event.stopPropagation();
      openBuiltinSectionDeleteConfirm(delBtn.dataset.delSection);
      return;
    }
    if (event.target.closest('button') || event.target.closest('input')) return;
    const label = event.target.closest('.section-label-text');
    if (!label) return;
    const section = label.closest('.sidebar-section');
    if (!section) return;
    event.preventDefault();
    if (section.dataset.customSection) {
      if (!isSectionEmpty('custom', section.dataset.customSection)) selectCustomSection(section.dataset.customSection);
    } else if (section.dataset.section) {
      if (!isSectionEmpty(section.dataset.section)) selectSection(section.dataset.section);
    }
  });
  sidebar.addEventListener('dblclick', (event) => {
    if (event.target.closest('button') || event.target.closest('input')) return;
    const label = event.target.closest('.section-label-text');
    if (!label) return;
    const section = label.closest('.sidebar-section');
    if (!section) return;
    event.preventDefault();
    if (section.dataset.customSection) startSectionRename({ kind: 'custom', id: section.dataset.customSection });
    else if (section.dataset.section) startSectionRename({ kind: section.dataset.section });
  });
}

// Render user-built sections: header (editable name, add/delete) + folders.
function renderCustomSections() {
  const container = document.getElementById('custom-sections');
  if (!container) return;
  container.innerHTML = customSections.map((section) => `
    <div class="sidebar-section" data-custom-section="${escapeHtml(section.id)}" data-section="custom">
      <div class="section-label">
        <span class="section-initial" title="${escapeHtml(section.name)}" aria-hidden="true">${escapeHtml(section.name.charAt(0).toUpperCase() || '?')}</span>
        <span class="section-label-text" data-section-name="${escapeHtml(section.id)}">${escapeHtml(section.name)}</span>
        <span class="section-actions">
          <button class="text-icon-button" data-custom-add="${escapeHtml(section.id)}" aria-label="Add folder" title="Add folder">+</button>
          <button class="section-delete" data-custom-del-section="${escapeHtml(section.id)}" aria-label="Delete section" title="Delete section">×</button>
        </span>
      </div>
      <div class="collection-list">
        ${section.folders.map((name) => `
        <a href="#" draggable="true" class="collection-item${activeCustom && activeCustom.section === section.id && activeCustom.folder === name ? ' active' : ''}" data-csection="${escapeHtml(section.id)}" data-cfolder="${escapeHtml(name)}" data-depth="${folderDepth(name)}" title="${escapeHtml(name)}">
          <span class="collection-dot ${customFolderColor(section, name)}"></span>
          <span class="collection-label">${escapeHtml(folderLeaf(name))}</span>
          <span class="collection-actions">
            <button type="button" class="collection-action" data-cf-rename="${escapeHtml(name)}" data-cf-section="${escapeHtml(section.id)}" title="Rename folder" aria-label="Rename ${escapeHtml(name)}">${icon('pencil')}</button>
          </span>
          <input class="collection-rename-input" value="${escapeHtml(folderLeaf(name))}" hidden maxlength="180" aria-label="Folder name" />
        </a>`).join('')}
      </div>
    </div>`).join('');
  updateSectionHeaders();
}

function customFolderColor(section, name) {
  const index = section.folders.findIndex((entry) => entry === name);
  if (index >= 0) return COLLECTION_COLORS[(index + 4) % COLLECTION_COLORS.length];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return COLLECTION_COLORS[Math.abs(hash) % COLLECTION_COLORS.length];
}

// Paint built-in header texts + initials from display-name overrides.
function updateSectionHeaders() {
  ['collections', 'recipes'].forEach((kind) => {
    const label = document.querySelector(`.sidebar-section[data-section="${kind}"] .section-label-text`);
    if (label) label.textContent = sectionDisplayName(kind);
    const badge = document.querySelector(`.sidebar-section[data-section="${kind}"] .section-initial`);
    if (badge) {
      const name = sectionDisplayName(kind);
      badge.textContent = name.charAt(0).toUpperCase();
      badge.title = name;
    }
  });
  document.querySelectorAll('#custom-sections .sidebar-section').forEach((wrap) => {
    const id = wrap.dataset.customSection;
    wrap.classList.toggle('active-section', Boolean(activeCustom && !activeCustom.folder && activeCustom.section === id));
    wrap.classList.toggle('is-empty', isSectionEmpty('custom', id));
  });
  document.querySelectorAll('.sidebar-section[data-section]:not([data-custom-section])').forEach((wrap) => {
    wrap.classList.toggle('is-empty', isSectionEmpty(wrap.dataset.section));
  });
}

// A sidebar section header filters the list — pointless when the section
// holds nothing, so empty sections are unclickable (rename still works).
function isSectionEmpty(kind, id) {
  if (kind === 'custom') {
    const section = customSections.find((entry) => entry.id === id);
    return !section || !section.folders.length;
  }
  if (kind === 'recipes') return !recipeCollections.length;
  if (collections.filter((name) => !isCollectionDeleted(name)).length) return false;
  return !notes.some((note) => !note.deleted && !note.collection && !hidesInGeneral(note));
}

// All taken section display names (lowercased), optionally skipping one entry.
function takenSectionNames(except) {
  const names = [];
  ['collections', 'recipes'].forEach((kind) => {
    if (!(except && except.kind === kind)) names.push(sectionDisplayName(kind));
  });
  customSections.forEach((section) => {
    if (!(except && except.kind === 'custom' && except.id === section.id)) names.push(section.name);
  });
  return names.map((name) => name.toLowerCase());
}

function uniqueSectionName() {
  const taken = new Set(takenSectionNames());
  let counter = 1;
  while (taken.has(`section ${counter}`)) counter += 1;
  return `Section ${counter}`;
}

function uniqueSectionId() {
  let id = `section-${Date.now()}`;
  while (customSections.some((section) => section.id === id)) id += '-x';
  return id;
}

function addCustomSection() {
  if (!e2ee.masterKey) { showToast('Log in to manage sections'); return; }
  const section = { id: uniqueSectionId(), name: uniqueSectionName(), folders: [] };
  customSections.push(section);
  persistCustomSections();
  activeView = 'notes';
  activeFilter = 'all';
  activeCollection = null;
  activeRecipe = null;
  activeSection = null;
  activeCustom = null;
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCollections();
  renderNoteList();
  showToast('Section added — name it');
  startSectionRename({ kind: 'custom', id: section.id });
}

// Inline rename for a section header (built-in or custom); Enter commits.
function startSectionRename(target) {
  renderCollections();
  let label = null;
  if (target.kind === 'custom') {
    const wrap = [...document.querySelectorAll('#custom-sections [data-custom-section]')]
      .find((el) => el.dataset.customSection === target.id);
    label = wrap ? wrap.querySelector('.section-label-text') : null;
  } else {
    label = document.querySelector(`.sidebar-section[data-section="${target.kind}"] .section-label-text`);
  }
  if (!label) return;
  // The label is hidden (not replaced): built-in headers are static markup
  // that no render rebuilds, so removing it would lose the label forever.
  // A second double-click while open just refocuses the pending input.
  const pending = label.parentElement ? label.parentElement.querySelector('.section-rename-input') : null;
  if (pending) { pending.focus(); pending.select(); return; }
  const input = document.createElement('input');
  input.className = 'section-rename-input';
  input.value = target.kind === 'custom'
    ? (customSections.find((section) => section.id === target.id) || {}).name || ''
    : sectionDisplayName(target.kind);
  input.maxLength = 40;
  input.setAttribute('aria-label', 'Section name');
  label.hidden = true;
  label.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    input.remove();
    label.hidden = false;
    if (commit) renameSectionDisplay(target.kind, target.id, input.value);
    else { renderCollections(); renderNoteList(); }
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  };
  input.onclick = (event) => event.stopPropagation();
  input.onblur = () => finish(true);
}

// Validate and apply a section display-name edit.
function renameSectionDisplay(kind, id, rawNewName) {
  const newName = String(rawNewName == null ? '' : rawNewName).replace(/[\x00-\x1F<>"]/g, '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!newName) { renderCollections(); renderNoteList(); return false; }
  const current = kind === 'custom'
    ? ((customSections.find((section) => section.id === id) || {}).name || '')
    : sectionDisplayName(kind);
  if (!current) { renderCollections(); renderNoteList(); return false; }
  if (newName === current) { renderCollections(); renderNoteList(); return true; }
  if (takenSectionNames({ kind, id }).includes(newName.toLowerCase())) {
    showToast('A section with that name already exists');
    renderCollections(); renderNoteList();
    return false;
  }
  if (kind === 'custom') {
    customSections.find((section) => section.id === id).name = newName;
  } else {
    sectionNames[kind] = newName;
  }
  persistCustomSections();
  updateListHeading();
  renderCollections();
  renderNoteList();
  showToast('Section renamed');
  return true;
}

// Delete a custom section: the section is removed from the sidebar, stashed
// in Bin, and every live note inside moves to Bin for 3 days (section tags
// are kept, so restoring a note revives its section).
function deleteCustomSection(id) {
  const index = customSections.findIndex((entry) => entry.id === id);
  if (index === -1) return;
  const removed = customSections[index];
  const name = removed.name;
  const movedAt = Date.now();
  let count = 0;
  notes.forEach((note) => {
    if (!note.deleted && customNoteFolder(note, id) !== null) {
      note.deleted = true;
      note.deletedAt = movedAt;
      count += 1;
    }
  });
  customSections.splice(index, 1);
  if (count) {
    deletedCustomSections = (deletedCustomSections || []).filter((entry) => entry.id !== id);
    deletedCustomSections.push({
      id, name, folders: [...(removed.folders || [])], deletedAt: movedAt,
    });
    persistDeletedCustomSections();
  }
  if (activeCustom && activeCustom.section === id) {
    activeCustom = null;
    activeFilter = 'all';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
    updateListHeading();
  }
  const current = currentId ? notes.find((item) => item.id === currentId) : null;
  if (!current || current.deleted) {
    activeView = 'notes';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    const live = notes.filter((item) => !item.deleted && !item.archived);
    if (live.length) selectNote(live[0].id);
    else clearEditor();
  }
  persistCustomSections();
  persistNotes();
  renderCollections();
  renderNoteList();
  showToast(count
    ? `Section “${name}” moved to Bin — ${count} note${count === 1 ? '' : 's'} kept for 3 days`
    : `Section “${name}” deleted`);
}

// De-duplicate a folder name inside one custom section.
function uniqueCustomFolderName(sectionId, base) {
  const section = customSections.find((entry) => entry.id === sectionId);
  const taken = new Set((section ? section.folders : []).map((name) => name.toLowerCase()));
  const cleanBase = String(base == null ? 'New folder' : base).trim() || 'New folder';
  if (!taken.has(cleanBase.toLowerCase())) return cleanBase;
  let counter = 2;
  while (taken.has(`${cleanBase} ${counter}`.toLowerCase())) counter += 1;
  return `${cleanBase} ${counter}`;
}

function findCustomItem(sectionId, folder) {
  return [...document.querySelectorAll('#custom-sections .collection-item')]
    .find((item) => item.dataset.csection === sectionId && item.dataset.cfolder === folder) || null;
}

function addCustomFolder(sectionId) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  const name = uniqueCustomFolderName(sectionId, 'New folder');
  section.folders.push(name);
  persistCustomSections();
  activeView = 'notes';
  activeCollection = null;
  activeRecipe = null;
  activeSection = null;
  activeCustom = null;
  activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCollections();
  renderNoteList();
  showToast('Folder added — name it');
  startCustomFolderRename(sectionId, name);
}

// Inline rename for a custom-section folder row.
function startCustomFolderRename(sectionId, folder) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  renderCustomSections();
  const item = findCustomItem(sectionId, folder);
  if (!item) return;
  const input = item.querySelector('.collection-rename-input');
  const label = item.querySelector('.collection-label');
  const actions = item.querySelector('.collection-actions');
  if (!input) return;
  input.hidden = false;
  if (label) label.hidden = true;
  if (actions) actions.hidden = true;
  input.value = folderLeaf(folder);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    // Leaf-only commit: the parent prefix is re-attached so the folder (and
    // its children) cannot slip out of place.
    if (commit) renameCustomFolder(sectionId, folder, joinLeafRename(folder, input.value));
    else { renderCustomSections(); renderNoteList(); }
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  };
  input.onclick = (event) => event.stopPropagation();
  input.onblur = () => finish(true);
}

// Validate and rename a custom folder on the section and matching notes.
function renameCustomFolder(sectionId, oldName, rawNewName, opts) {
  const newName = cleanFolderPath(rawNewName);
  if (!newName) { renderCustomSections(); renderNoteList(); return false; }
  if (newName === oldName) { renderCustomSections(); renderNoteList(); return true; }
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section) return false;
  if (section.folders.some((entry) => entry !== oldName && entry.toLowerCase() === newName.toLowerCase())) {
    showToast('A folder with that name already exists');
    renderCustomSections(); renderNoteList();
    return false;
  }
  section.folders = repathList(section.folders, oldName, newName);
  notes.forEach((note) => {
    const current = customNoteFolder(note, sectionId);
    if (current !== null && isFolderOrSub(current, oldName)) {
      note.sections[sectionId] = current === oldName ? newName : newName + current.slice(oldName.length);
    }
  });
  if (activeCustom && activeCustom.section === sectionId && activeCustom.folder && isFolderOrSub(activeCustom.folder, oldName)) {
    activeCustom.folder = activeCustom.folder === oldName ? newName : newName + activeCustom.folder.slice(oldName.length);
    updateListHeading();
  }
  persistCustomSections();
  persistNotes();
  renderCustomSections();
  renderNoteList();
  if (!opts || !opts.silent) showToast(`Folder renamed to “${folderLeaf(newName)}”`);
  return true;
}

function openCustomFolderDeleteConfirm(sectionId, folder) {
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section || !section.folders.includes(folder)) return;
  const count = notes.filter((note) => {
    if (note.deleted) return false;
    const current = customNoteFolder(note, sectionId);
    return current !== null && isFolderOrSub(current, folder);
  }).length;
  pendingDeleteId = folder;
  pendingDeleteMode = 'custom-folder';
  pendingDeleteSection = sectionId;
  setDeleteDialog({
    eyebrow: 'Delete folder',
    title: 'Delete this folder?',
    name: folder,
    message: count
      ? `” holds ${count} note${count === 1 ? '' : 's'}. The folder and its notes will move to Bin for 3 days. Are you sure?`
      : '” is empty. Are you sure you want to delete it?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Delete a custom folder and its nested subfolders: the folder is removed
// from the sidebar and every live note inside moves to Bin for 3 days (tags
// are kept, so restoring a note revives its folder via the sidebar sync).
function deleteCustomFolder(sectionId, folder) {
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  const movedAt = Date.now();
  let count = 0;
  notes.forEach((note) => {
    if (note.deleted || !note.sections || typeof note.sections !== 'object') return;
    const current = customNoteFolder(note, sectionId);
    if (current !== null && isFolderOrSub(current, folder)) {
      note.deleted = true;
      note.deletedAt = movedAt;
      count += 1;
    }
  });
  section.folders = section.folders.filter((entry) => !isFolderOrSub(entry, folder));
  if (activeCustom && activeCustom.section === sectionId && activeCustom.folder && isFolderOrSub(activeCustom.folder, folder)) {
    activeCustom = null;
    activeFilter = 'all';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
    updateListHeading();
  }
  const current = currentId ? notes.find((item) => item.id === currentId) : null;
  if (!current || current.deleted) {
    activeView = 'notes';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    const live = notes.filter((item) => !item.deleted && !item.archived);
    if (live.length) selectNote(live[0].id);
    else clearEditor();
  }
  persistCustomSections();
  persistNotes();
  renderCustomSections();
  renderNoteList();
  showToast(count
    ? `Folder “${folderLeaf(folder)}” moved to Bin — ${count} note${count === 1 ? '' : 's'} kept for 3 days`
    : `Folder “${folderLeaf(folder)}” deleted`);
}

// Adopt custom folders found on live notes that the sidebar does not list
// yet (imports, older data), normalizing case onto the sidebar spelling.
function syncCustomSections() {
  let notesDirty = false;
  let sectionsDirty = false;
  customSections.forEach((section) => {
    notes.forEach((note) => {
      if (note.deleted) return;
      const folder = customNoteFolder(note, section.id);
      if (!folder) return;
      const canonical = section.folders.find((entry) => entry.toLowerCase() === folder.toLowerCase());
      if (canonical) {
        if (note.sections[section.id] !== canonical) { note.sections[section.id] = canonical; notesDirty = true; }
      } else {
        section.folders.push(folder);
        sectionsDirty = true;
      }
    });
  });
  if (notesDirty) persistNotes();
  if (sectionsDirty) persistCustomSections();
}

function bindCustomSectionsEvents() {
  const container = document.getElementById('custom-sections');
  if (container) {
    container.addEventListener('click', (event) => {
      if (event.target.closest('.collection-rename-input') || event.target.closest('.section-rename-input')) return;
      const addBtn = event.target.closest('[data-custom-add]');
      if (addBtn) {
        event.preventDefault();
        event.stopPropagation();
        addCustomFolder(addBtn.dataset.customAdd);
        return;
      }
      const delSectionBtn = event.target.closest('[data-custom-del-section]');
      if (delSectionBtn) {
        event.preventDefault();
        event.stopPropagation();
        openCustomSectionDeleteConfirm(delSectionBtn.dataset.customDelSection);
        return;
      }
      const renameBtn = event.target.closest('[data-cf-rename]');
      if (renameBtn) {
        event.preventDefault();
        event.stopPropagation();
        startCustomFolderRename(renameBtn.dataset.cfSection, renameBtn.dataset.cfRename);
        return;
      }
      const item = event.target.closest('.collection-item');
      if (item && item.dataset.cfolder) {
        event.preventDefault();
        selectCustomFolder(item.dataset.csection, item.dataset.cfolder);
      }
    });
    container.addEventListener('dblclick', (event) => {
      if (event.target.closest('.collection-rename-input') || event.target.closest('.section-rename-input')
        || event.target.closest('.collection-action') || event.target.closest('button')) return;
      const label = event.target.closest('.section-label-text');
      if (label) {
        const wrap = label.closest('[data-custom-section]');
        if (wrap) {
          event.preventDefault();
          startSectionRename({ kind: 'custom', id: wrap.dataset.customSection });
        }
        return;
      }
      const item = event.target.closest('.collection-item');
      if (item && item.dataset.cfolder) {
        event.preventDefault();
        startCustomFolderRename(item.dataset.csection, item.dataset.cfolder);
      }
    });
    container.addEventListener('contextmenu', (event) => {
      const item = event.target.closest('.collection-item');
      if (!item || !item.dataset.cfolder || event.target.closest('.collection-rename-input')) return;
      event.preventDefault();
      event.stopPropagation();
      openFolderContextMenu('custom', item.dataset.cfolder, event.clientX, event.clientY, item.dataset.csection);
    });
  }
  const newSectionBtn = document.getElementById('new-section');
  if (newSectionBtn) newSectionBtn.addEventListener('click', (event) => {
    event.preventDefault();
    addCustomSection();
  });
}

function openCustomSectionDeleteConfirm(id) {
  const section = customSections.find((entry) => entry.id === id);
  if (!section) return;
  const count = notes.filter((note) => !note.deleted && customNoteFolder(note, id) !== null).length;
  pendingDeleteId = id;
  pendingDeleteMode = 'custom-section';
  pendingDeleteSection = null;
  setDeleteDialog({
    eyebrow: 'Delete section',
    title: 'Delete this section?',
    name: section.name,
    message: count
      ? `” organizes ${count} note${count === 1 ? '' : 's'}. The section and its notes will move to Bin for 3 days (restoring a note revives the section). Are you sure?`
      : '” is empty. Are you sure you want to delete it?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Clicking a section header filters the list to every folder under it.
// ---- Folder context menu (right-click): Open / Rename / New subfolder /
// Delete. One shared menu for sidebar rows and All-Notes folder headers;
// the target carries its namespace so collections and recipes stay separate.
let folderMenuTarget = null; // { ns: 'collections' | 'recipes' | 'custom', path, section? }

function getFolderContextMenu() {
  return document.getElementById('folder-context-menu');
}

function closeFolderContextMenu() {
  const menu = getFolderContextMenu();
  if (menu) menu.hidden = true;
  folderMenuTarget = null;
}

function openFolderContextMenu(ns, path, x, y, sectionId) {
  const menu = getFolderContextMenu();
  if (!menu || !path) return;
  folderMenuTarget = sectionId ? { ns, path, section: sectionId } : { ns, path };
  const binned = activeView === 'bin' && ns === 'collections' && path !== GENERAL_FOLDER && isCollectionDeleted(path);
  const generalInBin = activeView === 'bin' && ns === 'collections' && path === GENERAL_FOLDER;
  menu.querySelectorAll('[data-folder-action]').forEach((btn) => {
    const actionName = btn.dataset.folderAction;
    if (binned) btn.hidden = !(actionName === 'restore' || actionName === 'delete');
    else if (generalInBin) btn.hidden = actionName !== 'open';
    else btn.hidden = actionName === 'restore';
  });
  const deleteLabel = document.getElementById('folder-delete-label');
  if (deleteLabel) deleteLabel.textContent = binned ? 'Delete permanently' : 'Delete';
  menu.hidden = false;
  const padding = 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - padding) menu.style.left = `${Math.max(padding, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight - padding) menu.style.top = `${Math.max(padding, y - rect.height)}px`;
}

function handleFolderMenuAction(action, target) {
  const resolved = target || folderMenuTarget;
  if (!resolved || typeof action !== 'string') return;
  const { ns, path } = resolved;
  const sectionId = resolved.section;
  if (action === 'open') {
    if (ns === 'recipes') selectRecipe(path);
    else if (ns === 'custom' && sectionId) selectCustomFolder(sectionId, path);
    else selectCollection(path);
  } else if (action === 'rename') {
    if (ns === 'recipes') startRecipeRename(path);
    else if (ns === 'custom' && sectionId) startCustomFolderRename(sectionId, path);
    else startSidebarRename(path);
  } else if (action === 'subfolder') {
    createSubfolder(ns, path, sectionId);
  } else if (action === 'restore') {
    if (ns === 'collections') restoreCollection(path);
  } else if (action === 'delete') {
    if (activeView === 'bin' && ns === 'collections' && path !== GENERAL_FOLDER && isCollectionDeleted(path)) {
      openFolderPermanentDeleteConfirm(path);
    } else if (ns === 'recipes') openRecipeDeleteConfirm(path);
    else if (ns === 'custom' && sectionId) openCustomFolderDeleteConfirm(sectionId, path);
    else openFolderDeleteConfirm(path);
  }
}

// Insert a folder path directly after its parent's block (the parent plus any
// existing descendants) so a new subfolder renders under its parent instead
// of at the end of the list. Appends when the parent is missing.
function insertFolderAfterParent(list, parentPath, newPath) {
  if (parentPath) {
    const prefix = `${parentPath}${FOLDER_SEP}`;
    let at = -1;
    list.forEach((entry, index) => {
      if (entry === parentPath || entry.startsWith(prefix)) at = index;
    });
    if (at !== -1) {
      list.splice(at + 1, 0, newPath);
      return list;
    }
  }
  list.push(newPath);
  return list;
}

// Create a nested folder under a parent path and jump straight into naming
// it. General has no true children, so it creates a top-level folder.
function createSubfolder(ns, parentPath, sectionId) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  if (ns === 'recipes') {
    const name = uniqueRecipeName(`${parentPath}${FOLDER_SEP}New folder`);
    insertFolderAfterParent(recipeCollections, parentPath, name);
    persistRecipeCollections();
    renderRecipeCollections();
    renderNoteList();
    showToast('Folder added — name it');
    startRecipeRename(name);
    return;
  }
  if (ns === 'custom') {
    const section = customSections.find((entry) => entry.id === sectionId);
    if (!section) return;
    const name = uniqueCustomFolderName(sectionId, `${parentPath}${FOLDER_SEP}New folder`);
    insertFolderAfterParent(section.folders, parentPath, name);
    persistCustomSections();
    renderCustomSections();
    renderNoteList();
    showToast('Folder added — name it');
    startCustomFolderRename(sectionId, name);
    return;
  }
  if (!parentPath || parentPath === GENERAL_FOLDER) { addCollectionFolder(); return; }
  const name = uniqueCollectionName(`${parentPath}${FOLDER_SEP}New folder`);
  insertFolderAfterParent(collections, parentPath, name);
  persistCollections();
  renderCollections();
  renderNoteList();
  showToast('Folder added — name it');
  startSidebarRename(name);
}

function bindFolderContextMenu() {
  const menu = getFolderContextMenu();
  if (!menu) return;
  const sidebarTarget = (event) => {
    if (event.target.closest('.collection-rename-input')) return null;
    const recipeRow = event.target.closest('#recipe-list .collection-item');
    if (recipeRow) return { ns: 'recipes', path: recipeRow.dataset.recipe };
    const collectionRow = event.target.closest('#collection-list .collection-item');
    if (collectionRow) return { ns: 'collections', path: collectionRow.dataset.collection };
    return null;
  };
  if (collectionList) collectionList.addEventListener('contextmenu', (event) => {
    const target = sidebarTarget(event);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    openFolderContextMenu(target.ns, target.path, event.clientX, event.clientY);
  });
  if (recipeList) recipeList.addEventListener('contextmenu', (event) => {
    const target = sidebarTarget(event);
    if (!target) return;
    event.preventDefault();
    event.stopPropagation();
    openFolderContextMenu(target.ns, target.path, event.clientX, event.clientY);
  });
  if (noteList) noteList.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.tree-folder-row');
    if (!row || event.target.closest('.tree-rename-input')) return;
    const wrap = row.closest('[data-folder-wrap]');
    if (!wrap) return;
    event.preventDefault();
    event.stopPropagation();
    // Resolve the row's namespace so "New subfolder" becomes a child of the
    // right-clicked folder: the active recipe/custom filter wins, otherwise
    // the enclosing list-section shell (home view shows all namespaces).
    const shell = wrap.closest('[data-list-section]');
    const shellKind = shell ? shell.dataset.listSection : null;
    if (activeRecipe || shellKind === 'recipes') {
      openFolderContextMenu('recipes', wrap.dataset.folderWrap, event.clientX, event.clientY);
      return;
    }
    if (activeCustom) {
      openFolderContextMenu('custom', wrap.dataset.folderWrap, event.clientX, event.clientY, activeCustom.section);
      return;
    }
    if (shellKind === 'custom') {
      const secBtn = shell.querySelector('[data-section-id]');
      const secId = secBtn ? secBtn.dataset.sectionId : null;
      if (secId) {
        openFolderContextMenu('custom', wrap.dataset.folderWrap, event.clientX, event.clientY, secId);
        return;
      }
    }
    openFolderContextMenu('collections', wrap.dataset.folderWrap, event.clientX, event.clientY);
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-folder-action]');
    if (!item) return;
    const action = item.dataset.folderAction;
    const target = folderMenuTarget;
    closeFolderContextMenu();
    handleFolderMenuAction(action, target);
  });
  document.addEventListener('click', (event) => {
    if (folderMenuTarget && !event.target.closest('#folder-context-menu')) closeFolderContextMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    if (folderMenuTarget && !event.target.closest('#folder-context-menu')) closeFolderContextMenu();
  });
  window.addEventListener('resize', closeFolderContextMenu);
}

// ---- Folder drag-and-drop: reorder siblings, or drop onto a folder to nest
// inside it (top/bottom quarter = before/after, middle = nest). One shared
// implementation for collections, recipes and custom sections; reparenting
// reuses the rename functions so notes, collapse state and selection follow.
function folderListOf(ns, sectionId) {
  if (ns === 'recipes') return recipeCollections;
  if (ns === 'custom') {
    const section = customSections.find((entry) => entry.id === sectionId);
    return section ? section.folders : null;
  }
  return collections;
}

function persistFolderList(ns) {
  if (ns === 'recipes') persistRecipeCollections();
  else if (ns === 'custom') persistCustomSections();
  else persistCollections();
}

function renameFolderPath(ns, sectionId, oldPath, newPath, opts) {
  if (ns === 'recipes') return renameRecipe(oldPath, newPath, opts);
  if (ns === 'custom') return renameCustomFolder(sectionId, oldPath, newPath, opts);
  return renameCollection(oldPath, newPath, opts);
}

// Move a folder block (path + descendants) within its list.
function reorderFolderBlock(ns, sectionId, movedRoot, anchorPath, after) {
  const list = folderListOf(ns, sectionId);
  if (!list) return false;
  const block = list.filter((entry) => isFolderOrSub(entry, movedRoot));
  if (!block.length) return false;
  const rest = list.filter((entry) => !isFolderOrSub(entry, movedRoot));
  let index = rest.indexOf(anchorPath);
  if (index === -1) index = rest.length;
  else if (after) index += 1;
  const reordered = [...rest.slice(0, index), ...block, ...rest.slice(index)];
  if (ns === 'recipes') recipeCollections = reordered;
  else if (ns === 'custom') {
    const section = customSections.find((entry) => entry.id === sectionId);
    if (!section) return false;
    section.folders = reordered;
  } else collections = reordered;
  persistFolderList(ns);
  return true;
}

// Reparent a folder under a new parent (null = top level). Returns the new
// full path, or null when blocked. Shows toasts itself.
function reparentFolder(ns, sectionId, oldPath, newParent) {
  if (newParent && (newParent === oldPath || isFolderOrSub(newParent, oldPath))) {
    showToast("Can't move a folder into itself");
    return null;
  }
  const list = folderListOf(ns, sectionId);
  if (!list || !list.includes(oldPath)) return null;
  if (newParent && !list.includes(newParent)) return null;
  const leaf = folderLeaf(oldPath);
  let newPath = newParent ? `${newParent}${FOLDER_SEP}${leaf}` : leaf;
  if (newPath !== oldPath) {
    const others = list.filter((entry) => !isFolderOrSub(entry, oldPath)).map((entry) => entry.toLowerCase());
    if (ns === 'collections') deletedCollections.forEach((entry) => others.push(entry.name.toLowerCase()));
    if (others.includes(newPath.toLowerCase())) {
      let counter = 2;
      const stem = (suffix) => (newParent ? `${newParent}${FOLDER_SEP}${leaf} ${suffix}` : `${leaf} ${suffix}`);
      while (others.includes(stem(counter).toLowerCase())) counter += 1;
      newPath = stem(counter);
    }
    const ok = renameFolderPath(ns, sectionId, oldPath, newPath, { silent: true });
    if (!ok) return null;
  }
  return newPath;
}

function sidebarFolderTarget(event) {
  if (event.target.closest('.collection-rename-input')) return null;
  const customRow = event.target.closest('#custom-sections .collection-item');
  if (customRow && customRow.dataset.cfolder) {
    return { ns: 'custom', section: customRow.dataset.csection, path: customRow.dataset.cfolder };
  }
  const recipeRow = event.target.closest('#recipe-list .collection-item');
  if (recipeRow) return { ns: 'recipes', path: recipeRow.dataset.recipe };
  const collectionRow = event.target.closest('#collection-list .collection-item');
  if (collectionRow && collectionRow.dataset.collection !== GENERAL_FOLDER) {
    return { ns: 'collections', path: collectionRow.dataset.collection };
  }
  return null;
}

function bindFolderDragDrop() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const clearIndicators = () => {
    sidebar.querySelectorAll('.drop-before,.drop-after,.drop-target').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));
  };
  sidebar.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.collection-item');
    if (!row) return;
    const target = sidebarFolderTarget(event);
    if (!target || !e2ee.masterKey) { event.preventDefault(); return; }
    event.dataTransfer.setData('application/x-notely-folder', JSON.stringify(target));
    event.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
    closeFolderContextMenu();
    closeNoteContextMenu();
  });
  sidebar.addEventListener('dragend', () => {
    sidebar.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    clearIndicators();
  });
  sidebar.addEventListener('dragover', (event) => {
    const row = event.target.closest('.collection-item');
    if (!row || !e2ee.masterKey) return;
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('application/x-notely-folder')) return;
    const rect = row.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearIndicators();
    if (ratio < 0.25) row.classList.add('drop-before');
    else if (ratio > 0.75) row.classList.add('drop-after');
    else row.classList.add('drop-target');
  });
  sidebar.addEventListener('dragleave', (event) => {
    const row = event.target.closest('.collection-item');
    if (row && !row.contains(event.relatedTarget)) {
      row.classList.remove('drop-before', 'drop-after', 'drop-target');
    }
  });
  sidebar.addEventListener('drop', (event) => {
    const row = event.target.closest('.collection-item');
    if (!row || !e2ee.masterKey) return;
    let dragged = null;
    try { dragged = JSON.parse(event.dataTransfer.getData('application/x-notely-folder')); } catch (error) { dragged = null; }
    if (!dragged || !dragged.path) return;
    // General is pinned (never draggable), but dropping onto it moves a
    // collection folder back to the top level.
    const generalRow = event.target.closest('#collection-list .collection-item');
    if (generalRow && generalRow.dataset.collection === GENERAL_FOLDER) {
      if (dragged.ns !== 'collections') return;
      event.preventDefault();
      if (folderParent(dragged.path) === null) return;
      const newPath = reparentFolder(dragged.ns, dragged.section, dragged.path, null);
      if (!newPath) return;
      if (reorderFolderBlock(dragged.ns, dragged.section, newPath, null, false)) {
        renderCollections();
        renderNoteList();
        showToast(`Moved to top level`);
      }
      return;
    }
    const target = sidebarFolderTarget(event);
    if (!target || target.ns !== dragged.ns || (target.ns === 'custom' && target.section !== dragged.section)) return;
    if (target.path === dragged.path) return;
    if (isFolderOrSub(target.path, dragged.path)) {
      event.preventDefault();
      showToast("Can't move a folder into itself");
      return;
    }
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
    const list = folderListOf(dragged.ns, dragged.section);
    if (!list) return;
    if (ratio >= 0.25 && ratio <= 0.75) {
      // Nest inside the target folder.
      const newPath = reparentFolder(dragged.ns, dragged.section, dragged.path, target.path);
      if (!newPath) return;
      const movedHome = newPath !== dragged.path;
      // Group visually right after the new parent's subtree.
      const moved = folderListOf(dragged.ns, dragged.section).filter((entry) => isFolderOrSub(entry, newPath));
      const rest = folderListOf(dragged.ns, dragged.section).filter((entry) => !isFolderOrSub(entry, newPath));
      let index = rest.length;
      for (let i = rest.length - 1; i >= 0; i -= 1) {
        if (isFolderOrSub(rest[i], target.path)) { index = i + 1; break; }
      }
      const reordered = [...rest.slice(0, index), ...moved, ...rest.slice(index)];
      if (dragged.ns === 'recipes') recipeCollections = reordered;
      else if (dragged.ns === 'custom') {
        const section = customSections.find((entry) => entry.id === dragged.section);
        if (section) section.folders = reordered;
      } else collections = reordered;
      persistFolderList(dragged.ns);
      renderCollections();
      renderNoteList();
      if (movedHome) showToast(`Moved to “${folderLeaf(target.path)}”`);
    } else {
      // Reorder among siblings (reparenting across levels when needed).
      const newParent = folderParent(target.path);
      let movedRoot = dragged.path;
      if ((newParent || null) !== (folderParent(dragged.path) || null)) {
        const newPath = reparentFolder(dragged.ns, dragged.section, dragged.path, newParent);
        if (!newPath) return;
        movedRoot = newPath;
      }
      // Anchor may have been renamed if it sat inside the moved subtree —
      // guarded above, so it is stable here.
      if (reorderFolderBlock(dragged.ns, dragged.section, movedRoot, target.path, ratio > 0.75)) {
        renderCollections();
        renderNoteList();
      }
    }
  });
}
const noteList = document.getElementById('note-list');
const listEmpty = document.getElementById('list-empty');
const listHeading = document.getElementById('list-heading');
const titleInput = document.getElementById('title-input');
const markdownInput = document.getElementById('markdown-input');
const preview = document.getElementById('markdown-preview');
const breadcrumbTitle = document.getElementById('breadcrumb-title');
const wordCount = document.getElementById('word-count');
const tagList = document.getElementById('tag-list');
const saveLabel = document.getElementById('save-label');
const typeBadge = document.getElementById('type-badge');
const editorToolbar = document.getElementById('editor-toolbar');
const allCount = document.getElementById('all-count');
const recentCountEl = document.getElementById('recent-count');
const starredCountEl = document.getElementById('starred-count');
const totalCount = document.getElementById('total-count');
const importInput = document.getElementById('import-input');
const modeLabel = document.getElementById('mode-label');
const idleHint = document.getElementById('idle-hint');
const modeToggle = document.getElementById('mode-toggle');
const IDLE_PREVIEW_MS = 10000;
let writeMode = 'edit';
let idleTimer;

// Escape the five HTML metacharacters; null-safe. Every dynamic string in templates must pass through this.
// ---- Rendering helpers: HTML escaping + allowlisted Markdown (XSS boundary) ----

function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

// Allowlist-based URL sanitizer for Markdown links/images.
// Blocks javascript:, data:, vbscript:, file:, blob: etc. Only http/https
// (and mailto: for links) are rendered as clickable. Anything else renders
// as plain text so it can never become an XSS sink.
function sanitizeUrl(raw, { allowMailto = false } = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  // Reject whitespace, markup delimiters and ALL control chars (including
  // NUL placeholders used internally) to block obfuscation and mXSS. Also
  // reject encoded quotes (&quot; &#39; ...) — a literal quote is never valid
  // unencoded in a URL, and this keeps quotes out of emitted attributes even
  // after entity decoding.
  if (/[\s<>"\x00-\x1F\x7F]/.test(text)) return null;
  if (/&(?:quot|apos|#39|#x27|#34|#x22);?/i.test(text)) return null;
  const lower = text.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    try {
      const parsed = new URL(text);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return text;
    } catch (error) {}
    return null;
  }
  if (allowMailto && lower.startsWith('mailto:')) {
    if (/^mailto:[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(text)) return text;
    return null;
  }
  return null;
}

// Render inline Markdown on already-escaped text: code spans and link/image tags are stashed in placeholders so later emphasis passes can never reach inside href/src attributes.
function inlineMarkdown(value) {
  // Extract code spans FIRST so backtick content can never be reinterpreted
  // inside a link/image URL emitted below (sanitizer-ordering hardening).
  const codeSpans = [];
  const genTags = [];
  const stashTag = (tag) => {
    genTags.push(tag);
    return `\u0000GENTAG${genTags.length - 1}\u0000`;
  };
  // Emphasis for link/image labels: applied before the tag is stashed so that
  // later emphasis passes cannot reach inside generated href/src attributes
  // (URLs legitimately contain * and _ characters).
  const applyEmphasis = (text) => text
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
  const safe = escapeHtml(value)
    .replace(/`([^`]+)`/g, (match, code) => {
      codeSpans.push(`<code>${code}</code>`);
      return `\u0000CODESPAN${codeSpans.length - 1}\u0000`;
    })
    .replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (match, alt, src) => {
      const clean = sanitizeUrl(src, { allowMailto: false });
      if (!clean) return alt;
      return stashTag(`<img alt="${applyEmphasis(alt)}" src="${clean}" loading="lazy" referrerpolicy="no-referrer">`);
    })
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (match, label, href) => {
      const clean = sanitizeUrl(href, { allowMailto: true });
      if (!clean) return label;
      return stashTag(`<a href="${clean}" target="_blank" rel="noopener noreferrer nofollow">${applyEmphasis(label)}</a>`);
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\u0000GENTAG(\d+)\u0000/g, (match, index) => genTags[Number(index)] ?? '')
    .replace(/\u0000CODESPAN(\d+)\u0000/g, (match, index) => codeSpans[Number(index)] ?? '');
  return safe;
}

// Line-based block renderer (headings, lists, tasks, quotes, code fences, hr) built only from escaped/sanitized pieces.
function renderMarkdown(markdown) {
  const source = typeof markdown === 'string' ? markdown : String(markdown == null ? '' : markdown);
  const lines = source.replace(/\r/g, '').split('\n');
  let html = '';
  let inList = false;
  let listType = '';
  let inCode = false;
  let code = [];

  const closeList = () => {
    if (inList) {
      html += `</${listType}>`;
      inList = false;
      listType = '';
    }
  };

  lines.forEach((line) => {
    if (line.trim().startsWith('```')) {
      closeList();
      if (inCode) {
        html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
        code = [];
      }
      inCode = !inCode;
      return;
    }
    if (inCode) {
      code.push(line);
      return;
    }
    if (/^###\s+/.test(line)) { closeList(); html += `<h3>${inlineMarkdown(line.replace(/^###\s+/, ''))}</h3>`; return; }
    if (/^##\s+/.test(line)) { closeList(); html += `<h2>${inlineMarkdown(line.replace(/^##\s+/, ''))}</h2>`; return; }
    if (/^#\s+/.test(line)) { closeList(); html += `<h1>${inlineMarkdown(line.replace(/^#\s+/, ''))}</h1>`; return; }
    if (/^[-*_]{3,}\s*$/.test(line)) { closeList(); html += '<hr>'; return; }
    const taskMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
      const checked = taskMatch[1].toLowerCase() === 'x';
      html += `<li class="task"><span class="task-box${checked ? ' checked' : ''}" aria-hidden="true"></span>${inlineMarkdown(taskMatch[2])}</li>`;
      return;
    }
    const unorderedMatch = line.match(/^[-*]\s+(.*)$/);
    if (unorderedMatch) {
      if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
      html += `<li>${inlineMarkdown(unorderedMatch[1])}</li>`;
      return;
    }
    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      if (!inList || listType !== 'ol') { closeList(); html += '<ol>'; inList = true; listType = 'ol'; }
      html += `<li>${inlineMarkdown(orderedMatch[1])}</li>`;
      return;
    }
    if (/^>\s?/.test(line)) { closeList(); html += `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`; return; }
    if (!line.trim()) { closeList(); return; }
    closeList();
    html += `<p>${inlineMarkdown(line)}</p>`;
  });
  closeList();
  if (inCode) html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
  return html || '<p class="preview-placeholder">Start writing to see your note here.</p>';
}

// Display folder of a note: its collection, or General when uncategorized.
// ---- Note list: filtering, grouping, counts, tree rendering ----

function folderOf(note) {
  return note.collection || GENERAL_FOLDER;
}

// A note filed in another section needs no General row: without this, a note
// created inside a recipe/custom folder would also render under General
// (same note twice in All Notes).
function hidesInGeneral(note) {
  if (note.collection) return false;
  if (typeof note.recipe === 'string' && note.recipe) return true;
  if (note.sections && typeof note.sections === 'object') {
    return Object.values(note.sections).some((value) => typeof value === 'string' && value);
  }
  return false;
}

// ---- Nested folders: a folder path is segments joined with FOLDER_SEP
// ("Work / Projects"). All folder namespaces (collections, recipes) share
// these helpers; matching is always exact-path or proper-descendant.
const FOLDER_SEP = ' / ';

function splitFolderPath(path) {
  return String(path == null ? '' : path).split('/').map((part) => part.trim()).filter(Boolean);
}

function folderParent(path) {
  const parts = splitFolderPath(path);
  if (parts.length < 2) return null;
  return parts.slice(0, -1).join(FOLDER_SEP);
}

function folderLeaf(path) {
  const parts = splitFolderPath(path);
  return parts.length ? parts[parts.length - 1] : String(path);
}

function folderDepth(path) {
  return Math.max(0, splitFolderPath(path).length - 1);
}

// True for the folder itself and anything nested under it ("Work" matches
// "Work" and "Work / Projects", but not "Workout").
function isFolderOrSub(path, ancestor) {
  return path === ancestor || path.startsWith(`${ancestor}${FOLDER_SEP}`);
}

// C0 control characters as a plain string (built, not escaped).
const CONTROL_CHARS = Array.from({ length: 32 }, (_, index) => String.fromCharCode(index)).join('');

// Normalize a raw path: clean each segment (no slashes survive), cap
// segments at 60 chars and the whole path at 180. Returns '' when empty.
function cleanFolderPath(raw) {
  const parts = String(raw == null ? '' : raw)
    .replace(new RegExp('[' + CONTROL_CHARS + '<>' + '"' + ']', 'g'), '')
    .split('/')
    .map((part) => part.trim().replace(/\s+/g, ' ').slice(0, 60))
    .filter(Boolean);
  return parts.join(FOLDER_SEP).slice(0, 180);
}

// Rename UX edits the leaf segment only: the parent prefix is re-attached on
// commit, so renaming a folder can never detach it from its parent (and a
// renamed parent keeps its children via the usual subtree repath).
// Returns '' when nothing usable was typed (callers treat it as cancel).
function joinLeafRename(oldPath, rawLeaf) {
  const leaf = cleanFolderPath(rawLeaf);
  if (!leaf) return '';
  const parent = folderParent(oldPath);
  return parent ? `${parent}${FOLDER_SEP}${leaf}` : leaf;
}

// True for notes dated Now/Today/Yesterday (drives the Recent chip).
function isRecentNote(note) {
  return ['Now', 'Today', 'Yesterday'].includes(note.date);
}

// Single place that computes the list heading from view + collection + chip filter (e.g. "Work · Starred").
function updateListHeading() {
  const suffix = activeFilter === 'favorites' ? ' · Starred' : activeFilter === 'recent' ? ' · Recent' : '';
  if (activeView === 'bin') listHeading.textContent = `Bin${suffix}`;
  else if (activeView === 'vault') listHeading.textContent = `Vault${suffix}`;
  else if (activeView === 'archive') listHeading.textContent = `Archive${suffix}`;
  else if (activeView === 'favorites') listHeading.textContent = 'Starred notes';
  else if (activeCollection) listHeading.textContent = `${folderLeaf(activeCollection)}${suffix}`;
  else if (activeRecipe) listHeading.textContent = `${folderLeaf(activeRecipe)}${suffix}`;
  else if (activeCustom) listHeading.textContent = `${activeCustom.folder ? folderLeaf(activeCustom.folder) : sectionDisplayName('custom', activeCustom.section)}${suffix}`;
  else if (activeSection) listHeading.textContent = `${sectionDisplayName(activeSection)}${suffix}`;
  else listHeading.textContent = activeFilter === 'favorites' ? 'Starred notes' : activeFilter === 'recent' ? 'Recent notes' : 'All notes';
}

// Clear the search box and its in-memory query.
function clearSearch() {
  searchQuery = '';
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
}

// Rebuild the clickable breadcrumb trail: [view] [/ folder] / [note title].
// The title element itself is persistent (editor writes to it directly); only
// the trail prefix is re-rendered here.
function viewLabel(view) {
  if (view === 'favorites') return 'Starred notes';
  if (view === 'archive') return 'Archive';
  if (view === 'bin') return 'Bin';
  if (view === 'vault') return 'Vault';
  return 'All notes';
}

function updateBreadcrumbs() {
  const trail = document.getElementById('breadcrumb-trail');
  if (!trail) return;
  trail.innerHTML = '';
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'crumb-link';
  root.dataset.crumb = 'root';
  root.textContent = viewLabel(activeView);
  root.title = 'Back to All notes';
  trail.appendChild(root);
  const activeFolderPath = activeCollection || activeRecipe
    || (activeCustom ? activeCustom.folder : null);
  const activeFolder = activeFolderPath
    || (activeCustom ? sectionDisplayName('custom', activeCustom.section) : null)
    || (activeSection ? sectionDisplayName(activeSection) : null);
  if (activeFolder) {
    const sep = document.createElement('span');
    sep.className = 'crumb-separator';
    sep.textContent = '/';
    trail.appendChild(sep);
    const folder = document.createElement('button');
    folder.type = 'button';
    folder.className = 'crumb-link';
    folder.dataset.crumb = 'folder';
    folder.textContent = activeFolderPath ? folderLeaf(activeFolder) : activeFolder;
    folder.title = `Show ${activeFolder}`;
    trail.appendChild(folder);
  }
}

// Breadcrumb home: reset to All notes with nothing open and an enlarged
// workspace (editor hidden). Selecting any note exits the enlarged mode.
function goAllNotes() {
  clearCollectionSelection();
  activeView = 'notes';
  activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  currentId = null;
  currentVaultId = null;
  clearEditor();
  document.querySelector('.app-shell').classList.add('workspace-focus');
  renderCollections();
  renderNoteList();
}

document.getElementById('breadcrumbs').addEventListener('click', (event) => {
  const crumb = event.target.closest('[data-crumb]');
  if (!crumb) return;
  event.preventDefault();
  if (crumb.dataset.crumb === 'root') goAllNotes();
  else if (crumb.dataset.crumb === 'folder') {
    if (activeCollection) selectCollection(activeCollection);
    else if (activeRecipe) selectRecipe(activeRecipe);
    else if (activeCustom && activeCustom.folder) selectCustomFolder(activeCustom.section, activeCustom.folder);
    else if (activeCustom) selectCustomSection(activeCustom.section);
    else if (activeSection) selectSection(activeSection);
  }
});

// Master list filter: Bin vs live, archive rules, search text, chip filter, selected collection.
function visibleNotes() {
  if (activeView === 'vault') return [];
  return notes.filter((note) => {
    const isDeleted = Boolean(note.deleted);
    const isArchived = Boolean(note.archived);
    if (activeView === 'bin') {
      if (!isDeleted) return false;
    } else {
      if (isDeleted) return false;
      if (activeView === 'archive') {
        if (!isArchived) return false;
      } else {
        // notes / favorites views hide archived items; Archive has its own view.
        if (isArchived) return false;
      }
    }
    const safeTitle = typeof note.title === 'string' ? note.title : '';
    const safeBody = typeof note.body === 'string' ? note.body : '';
    const safeTags = Array.isArray(note.tags) ? note.tags.filter((t) => typeof t === 'string').join(' ') : '';
    const matchesSearch = !searchQuery || `${safeTitle} ${safeBody} ${safeTags}`.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesFilter = activeFilter === 'all' || (activeFilter === 'favorites' && note.favorite) || (activeFilter === 'recent' && isRecentNote(note));
    const matchesCollection = !activeCollection || (activeCollection === GENERAL_FOLDER
      // The General pseudo-folder holds only truly uncategorized notes, never
      // notes filed in a recipe/custom section.
      ? (!note.collection && !hidesInGeneral(note))
      : isFolderOrSub(folderOf(note), activeCollection));
    const matchesRecipe = !activeRecipe || (typeof note.recipe === 'string' && isFolderOrSub(note.recipe, activeRecipe));
    const matchesSection = !activeSection || (activeSection === 'recipes'
      ? (typeof note.recipe === 'string' && recipeCollections.some((entry) => note.recipe === entry || isFolderOrSub(note.recipe, entry)))
      : true);
    const matchesCustom = !activeCustom || (customNoteFolder(note, activeCustom.section) !== null
      && (!activeCustom.folder || isFolderOrSub(customNoteFolder(note, activeCustom.section), activeCustom.folder)));
    return matchesSearch && matchesFilter && matchesCollection && matchesRecipe && matchesSection && matchesCustom;
  });
}

// Notes in the current view + selected folder, ignoring the search box and
// the All/Recent/Starred chip — so the chips mirror the selected folder.
function scopeNotes() {
  if (activeView === 'vault') return vault.unlocked ? [...vault.notes] : [];
  return notes.filter((note) => {
    const isDeleted = Boolean(note.deleted);
    const isArchived = Boolean(note.archived);
    if (activeView === 'bin') {
      if (!isDeleted) return false;
    } else {
      if (isDeleted) return false;
      if (activeView === 'archive') {
        if (!isArchived) return false;
      } else if (isArchived) {
        return false;
      }
    }
    if (activeCollection === GENERAL_FOLDER) {
      if (note.collection || hidesInGeneral(note)) return false;
    } else if (activeCollection && !isFolderOrSub(folderOf(note), activeCollection)) return false;
    if (activeRecipe && !(typeof note.recipe === 'string' && isFolderOrSub(note.recipe, activeRecipe))) return false;
    if (activeSection === 'recipes' && !(typeof note.recipe === 'string' && recipeCollections.some((entry) => note.recipe === entry || isFolderOrSub(note.recipe, entry)))) return false;
    if (activeCustom) {
      const customFolder = customNoteFolder(note, activeCustom.section);
      if (customFolder === null) return false;
      if (activeCustom.folder && !isFolderOrSub(customFolder, activeCustom.folder)) return false;
    }
    return true;
  });
}

// Human countdown ("2d left") until a binned note is purged.
function binRemainingText(note) {
  if (!note.deleted || typeof note.deletedAt !== 'number') return '';
  const remaining = BIN_RETENTION_MS - (Date.now() - note.deletedAt);
  if (remaining <= 0) return 'Expires soon';
  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d left`;
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h left`;
  return 'Expires soon';
}

// Resize the Markdown textarea to its content (skipped in preview mode).
function autogrow() {
  if (markdownInput.hidden) return;
  markdownInput.style.height = 'auto';
  markdownInput.style.height = `${markdownInput.scrollHeight}px`;
}

// Swap the writing area between Markdown source and rendered preview; plain-text notes never preview.
function renderPreview(note) {
  const bottomHint = document.querySelector('.editor-bottom span:first-child');
  const isTxt = note.ext === 'txt';
  const showPreview = !isTxt && writeMode === 'preview';
  if (showPreview) preview.innerHTML = renderMarkdown(note.body);
  markdownInput.hidden = showPreview;
  preview.hidden = !showPreview;
  if (modeLabel) modeLabel.textContent = isTxt ? 'Plain text' : (showPreview ? 'Preview' : 'Write');
  if (idleHint) idleHint.textContent = isTxt ? 'Plain text file' : (showPreview ? 'Click the text to keep writing' : 'Markdown source · live preview after 10s idle');
  if (modeToggle) {
    modeToggle.hidden = isTxt;
    modeToggle.textContent = showPreview ? 'Write' : 'Preview';
  }
  if (bottomHint) bottomHint.textContent = isTxt ? 'Plain text file (.txt)' : 'Markdown · auto-preview after 10s idle';
  if (typeBadge) typeBadge.textContent = isTxt ? 'TXT' : 'MD';
  if (editorToolbar) editorToolbar.classList.toggle('is-plain', isTxt);
  if (!showPreview) autogrow();
}

// After 10s idle, auto-switch a non-empty Markdown note to preview.
function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    const note = currentNote();
    if (note && note.ext === 'md' && writeMode === 'edit' && markdownInput.value.trim()) {
      setWriteMode('preview');
    }
  }, IDLE_PREVIEW_MS);
}

// Switch write/preview mode and refocus the editor when returning to edit.
function setWriteMode(mode, { focus = false } = {}) {
  writeMode = mode;
  clearTimeout(idleTimer);
  renderPreview(activeEditorNote());
  if (mode === 'edit') {
    resetIdleTimer();
    if (focus) {
      markdownInput.focus();
      markdownInput.setSelectionRange(markdownInput.value.length, markdownInput.value.length);
    }
  }
}

// Inline rename for All-Notes folder headers; refused in Bin for General/binned folders (Bin offers restore/delete instead).
function startTreeRename(folder) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  if (activeView === 'bin' && (folder === GENERAL_FOLDER || isCollectionDeleted(folder))) return;
  const wrap = findTreeWrap(folder);
  if (!wrap) return;
  const row = wrap.querySelector('.tree-folder-row');
  const folderBtn = wrap.querySelector('[data-folder]');
  const renameBtn = wrap.querySelector('[data-folder-rename]');
  let input = wrap.querySelector('.tree-rename-input');
  if (!input) {
    input = document.createElement('input');
    input.className = 'tree-rename-input';
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Folder name');
    row.appendChild(input);
  }
  input.value = folderLeaf(folder);
  input.hidden = false;
  if (folderBtn) folderBtn.hidden = true;
  if (renameBtn) renameBtn.hidden = true;
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      // Namespace follows the row (recipe/custom rows rename in place, never
      // as collections), and the commit is leaf-only so children stay put.
      let ns = null;
      let sectionId = null;
      if (activeRecipe) ns = 'recipes';
      else if (activeCustom) { ns = 'custom'; sectionId = activeCustom.section; }
      else {
        const shell = wrap.closest('[data-list-section]');
        const kind = shell ? shell.dataset.listSection : null;
        if (kind === 'recipes') ns = 'recipes';
        else if (kind === 'custom') {
          const secBtn = shell.querySelector('[data-section-id]');
          if (secBtn && secBtn.dataset.sectionId) { ns = 'custom'; sectionId = secBtn.dataset.sectionId; }
        }
      }
      if (!ns) ns = 'collections';
      renameFolderPath(ns, sectionId, folder, joinLeafRename(folder, input.value));
    }
    else renderNoteList();
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  };
  input.onclick = (event) => event.stopPropagation();
  input.ondblclick = (event) => event.stopPropagation();
  input.onblur = () => finish(true);
}

// Swap New/Import vs Empty-Bin buttons per view, then refresh the lock state.
function updateBinUI() {
  const inBin = activeView === 'bin';
  const emptyBinBtn = document.getElementById('empty-bin');
  if (emptyBinBtn) emptyBinBtn.hidden = !inBin;
  refreshEditorLock();
}

// Drag-and-drop note sorting: drag a row onto another note to reorder (top /
// bottom half picks the side); dropping onto a folder header moves the note
// into that folder. Disabled in Bin and Vault, where order is meaningless.
function dropNoteOnNote(draggedId, targetId, after) {
  if (!draggedId || !targetId || draggedId === targetId) return;
  const from = notes.findIndex((note) => note.id === draggedId);
  const target = notes.find((note) => note.id === targetId);
  if (from === -1 || !target) return;
  const [moved] = notes.splice(from, 1);
  // Adopt the target's folder in the current grouping namespace.
  if (activeRecipe) {
    const groupOf = (note) => ((activeRecipe && typeof note.recipe === 'string' && note.recipe) ? note.recipe : folderOf(note));
    const folder = groupOf(target);
    moved.recipe = folder === GENERAL_FOLDER ? null : folder;
  } else if (!activeCustom) {
    const folder = folderOf(target);
    moved.collection = folder === GENERAL_FOLDER ? null : folder;
  } else if (activeCustom.folder) {
    // Custom-section context: adopt the target's folder in the same section,
    // never touch the collections namespace.
    const folder = customNoteFolder(target, activeCustom.section);
    if (folder) {
      if (!moved.sections || typeof moved.sections !== 'object') moved.sections = {};
      moved.sections[activeCustom.section] = folder;
    }
  }
  let to = notes.findIndex((note) => note.id === targetId);
  if (after) to += 1;
  notes.splice(to, 0, moved);
  persistNotes();
  renderNoteList();
}

function dropNoteOnFolder(draggedId, folder) {
  const index = notes.findIndex((note) => note.id === draggedId);
  if (index === -1 || typeof folder !== 'string') return;
  const [moved] = notes.splice(index, 1);
  if (activeRecipe) moved.recipe = folder === GENERAL_FOLDER ? null : folder;
  else if (activeCustom) {
    // Custom-section context: file into the same section (General unfiles it
    // from the section instead of touching the collections namespace).
    if (!moved.sections || typeof moved.sections !== 'object') moved.sections = {};
    if (folder === GENERAL_FOLDER) delete moved.sections[activeCustom.section];
    else moved.sections[activeCustom.section] = folder;
  }
  else moved.collection = folder === GENERAL_FOLDER ? null : folder;
  // Append after the folder's last note in global order (empty folders: end).
  const keyOf = (note) => {
    if (activeRecipe) return (note.recipe || GENERAL_FOLDER);
    if (activeCustom) return customNoteFolder(note, activeCustom.section) || GENERAL_FOLDER;
    return folderOf(note);
  };
  let to = notes.length;
  for (let i = notes.length - 1; i >= 0; i -= 1) {
    if (keyOf(notes[i]) === folder) { to = i + 1; break; }
  }
  notes.splice(to, 0, moved);
  persistNotes();
  renderNoteList();
}

function enableNoteDragDrop() {
  const canDrag = activeView !== 'bin' && activeView !== 'vault';
  const clearIndicators = () => {
    noteList.querySelectorAll('.drop-before,.drop-after,.drop-target').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));
  };
  noteList.querySelectorAll('[data-note-id]').forEach((row) => {
    const id = row.dataset.noteId;
    row.draggable = canDrag;
    if (!canDrag) return;
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', id);
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
      closeNoteContextMenu();
      closeFolderContextMenu();
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      clearIndicators();
    });
    row.addEventListener('dragover', (event) => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const after = (event.clientY - rect.top) > rect.height / 2;
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (event) => {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      dropNoteOnNote(event.dataTransfer.getData('text/plain'), id, (event.clientY - rect.top) > rect.height / 2);
    });
  });
  if (!canDrag) return;
  noteList.querySelectorAll('[data-folder]').forEach((header) => {
    header.addEventListener('dragover', (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      header.classList.add('drop-target');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drop-target'));
    header.addEventListener('drop', (event) => {
      event.preventDefault();
      dropNoteOnFolder(event.dataTransfer.getData('text/plain'), header.dataset.folder);
    });
  });
}

// Render the grouped note tree: folder ordering, collapse, Bin actions vs rename pencil, scoped counters, and per-row event wiring.
function renderNoteList() {
  if (activeView === 'vault') { renderVaultList(); return; }
  const visible = visibleNotes();
  const searching = searchQuery.trim() !== '';
  // Grouping follows the active folder namespace: recipe paths when a recipe
  // folder is selected, custom-section paths when one of those is selected,
  // collection paths otherwise — so nested folders render under their own name
  // instead of leaking into General.
  const groupKeyOfNote = (note) => {
    if (activeRecipe && typeof note.recipe === 'string' && note.recipe) return note.recipe;
    if (activeCustom) return customNoteFolder(note, activeCustom.section) || GENERAL_FOLDER;
    return folderOf(note);
  };
  const groups = new Map();
  visible.forEach((note) => {
    const folder = groupKeyOfNote(note);
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(note);
  });
  // Newest-first ordering (item 7): folders sort by their newest note, so a
  // freshly created note always lands on top of the list.
  const orderOf = new Map();
  notes.forEach((note, index) => { if (!orderOf.has(note.id)) orderOf.set(note.id, index); });
  // Render one set of folder groups as a nested, recency-ordered tree.
  const renderFolderGroups = (groupsMap) => {
  const folderNewest = (folder) => Math.min(...groupsMap.get(folder).map((note) => orderOf.get(note.id) ?? Infinity));
  // Build a nested tree from flat "A / B / C" paths; intermediate parents
  // render as headers even without direct notes.
  const buildFolderTree = (paths) => {
    const byPath = new Map();
    const roots = [];
    const ensureNode = (fullPath) => {
      let node = byPath.get(fullPath);
      if (!node) {
        node = { fullPath, files: groupsMap.get(fullPath) || [], children: [] };
        byPath.set(fullPath, node);
        const parent = folderParent(fullPath);
        if (parent) ensureNode(parent).children.push(node);
        else roots.push(node);
      }
      return node;
    };
    paths.forEach(ensureNode);
    return roots;
  };
  const subtreeNewest = (node) => {
    let best = node.files.length ? folderNewest(node.fullPath) : Infinity;
    node.children.forEach((child) => { best = Math.min(best, subtreeNewest(child)); });
    return best;
  };
  const subtreeCount = (node) => node.files.length + node.children.reduce((sum, child) => sum + subtreeCount(child), 0);
  const byRecency = (a, b) => subtreeNewest(a) - subtreeNewest(b);
  const renderFolderNode = (node) => {
    const folder = node.fullPath;
    const files = node.files;
    const isCollapsed = !searching && collapsedFolders.has(folder);
    const isBinnedFolder = activeView === 'bin' && folder !== GENERAL_FOLDER && isCollectionDeleted(folder);
    const folderActions = activeView === 'bin'
      ? (isBinnedFolder
        ? `<button type="button" class="tree-action" data-folder-restore="${escapeHtml(folder)}" title="Restore folder" aria-label="Restore ${escapeHtml(folder)}">${icon('restore')}</button>
           <button type="button" class="tree-action danger" data-folder-delete="${escapeHtml(folder)}" title="Delete folder permanently" aria-label="Delete ${escapeHtml(folder)} permanently">${icon('trash')}</button>`
        : '')
      : `<button type="button" class="tree-rename" data-folder-rename="${escapeHtml(folder)}" title="Rename folder" aria-label="Rename ${escapeHtml(folder)}">${icon('pencil')}</button>`;
    const childrenHtml = node.children.slice().sort(byRecency).map(renderFolderNode).join('');
    return `
    <div class="tree-folder-wrap${isCollapsed ? ' closed' : ''}" data-folder-wrap="${escapeHtml(folder)}">
      <div class="tree-folder-row">
        <button class="tree-folder" data-folder="${escapeHtml(folder)}" aria-expanded="${isCollapsed ? 'false' : 'true'}" title="${escapeHtml(folder)}${activeView === 'bin' ? '' : ' — double-click to rename'}">
          <span class="tree-chevron">${icon('chevron-right')}</span>
          <span class="tree-folder-icon">${icon('folder')}</span>
          <span class="tree-folder-name">${escapeHtml(folderLeaf(folder))}</span>
          <span class="tree-count">${subtreeCount(node)}</span>
        </button>
        ${folderActions}
        <input class="tree-rename-input" value="${escapeHtml(folder)}" hidden maxlength="180" aria-label="Folder name" />
      </div>
      <div class="tree-children">
        ${childrenHtml}
        ${files.map((note) => `
        <button class="tree-file${note.id === currentId ? ' selected' : ''}" data-note-id="${escapeHtml(String(note.id))}" title="${escapeHtml(note.title || 'Untitled note')}">
          <span class="tree-file-icon tree-file-icon-${note.ext === 'txt' ? 'txt' : 'md'}">${icon(note.ext === 'txt' ? 'file-text' : 'file')}</span>
          <span class="tree-file-name">${escapeHtml(note.title || 'Untitled note')}</span>
          ${activeView === 'bin' ? `<span class="bin-meta">${binRemainingText(note)}</span>` : ''}
          ${note.favorite && activeView !== 'bin' ? `<span class="mini-star">${icon('star')}</span>` : ''}
        </button>`).join('')}
      </div>
    </div>`;
  };
  return buildFolderTree([...groupsMap.keys()]).sort(byRecency).map(renderFolderNode).join('');
  };
  // One sidebar section as a list supergroup: clickable title (filters),
  // rename pencil, note count, then its folder tree.
  const renderSectionShell = (kind, id, title, groupsMap) => {
    const total = [...groupsMap.values()].reduce((sum, files) => sum + files.length, 0);
    return `<div class="list-section" data-list-section="${kind}">
      <div class="list-section-head">
        <button class="list-section-title" data-section-jump="${kind}" data-section-id="${escapeHtml(id || '')}" title="Show ${escapeHtml(title)}">${escapeHtml(title)}</button>
        <span class="tree-count">${total}</span>
        <button type="button" class="list-section-rename" data-section-rename="${kind}" data-section-id="${escapeHtml(id || '')}" title="Rename section" aria-label="Rename ${escapeHtml(title)}">${icon('pencil')}</button>
      </div>
      ${renderFolderGroups(groupsMap)}
    </div>`;
  };
  // Home-like views (no folder/search/chip filter) separate folders by
  // section to mirror the slide menu; everything else keeps the flat tree.
  const homeLike = activeView === 'notes' && activeFilter === 'all' && !searching
    && !activeCollection && !activeRecipe && !(activeCustom && activeCustom.folder);
  if (homeLike) {
    const parts = [];
    const wantCols = !activeCustom && (!activeSection || activeSection === 'collections');
    const wantRecipes = !activeCustom && (!activeSection || activeSection === 'recipes');
    const customTargets = activeCustom && !activeCustom.folder
      ? customSections.filter((section) => section.id === activeCustom.section)
      : ((!activeSection && !activeCustom) ? customSections : []);
    if (wantCols) {
      const sectionGroups = new Map();
      visible.forEach((note) => {
        if (hidesInGeneral(note)) return;
        const folder = folderOf(note);
        if (!sectionGroups.has(folder)) sectionGroups.set(folder, []);
        sectionGroups.get(folder).push(note);
      });
      if (sectionGroups.size) parts.push(renderSectionShell('collections', '', sectionDisplayName('collections'), sectionGroups));
    }
    if (wantRecipes) {
      const sectionGroups = new Map();
      visible.forEach((note) => {
        if (typeof note.recipe !== 'string' || !note.recipe) return;
        if (!sectionGroups.has(note.recipe)) sectionGroups.set(note.recipe, []);
        sectionGroups.get(note.recipe).push(note);
      });
      if (sectionGroups.size) parts.push(renderSectionShell('recipes', '', sectionDisplayName('recipes'), sectionGroups));
    }
    customTargets.forEach((section) => {
      const sectionGroups = new Map();
      visible.forEach((note) => {
        const folder = customNoteFolder(note, section.id);
        if (!folder) return;
        if (!sectionGroups.has(folder)) sectionGroups.set(folder, []);
        sectionGroups.get(folder).push(note);
      });
      if (sectionGroups.size) parts.push(renderSectionShell('custom', section.id, section.name, sectionGroups));
    });
    noteList.innerHTML = parts.join('');
  } else {
    noteList.innerHTML = renderFolderGroups(groups);
  }
  const inBin = activeView === 'bin';
  listEmpty.hidden = visible.length !== 0;
  noteList.hidden = visible.length === 0;
  const emptyTitle = listEmpty.querySelector('strong');
  const emptySub = listEmpty.querySelector('span:last-child');
  if (emptyTitle) emptyTitle.textContent = inBin ? 'Bin is empty' : 'No notes found';
  if (emptySub) emptySub.textContent = inBin ? 'Deleted notes stay here for 3 days before they are permanently removed.' : 'Try another search or create a new note.';
  const liveNotes = notes.filter((note) => !note.deleted && !note.archived);
  const archivedNotes = notes.filter((note) => !note.deleted && note.archived);
  const binnedNotes = notes.filter((note) => note.deleted);
  const scope = scopeNotes();
  if (allCount) allCount.textContent = scope.length;
  if (recentCountEl) recentCountEl.textContent = scope.filter((note) => isRecentNote(note)).length;
  if (starredCountEl) starredCountEl.textContent = scope.filter((note) => note.favorite).length;
  const activeContextName = activeCollection || activeRecipe
    || (activeCustom ? (activeCustom.folder || sectionDisplayName('custom', activeCustom.section)) : null)
    || (activeSection ? sectionDisplayName(activeSection) : null);
  if (totalCount) totalCount.textContent = inBin ? `${visible.length} in bin` : (activeContextName ? `${visible.length} note${visible.length === 1 ? '' : 's'} in ${activeContextName}` : `${visible.length} note${visible.length === 1 ? '' : 's'}`);
  const navAllCount = document.getElementById('nav-all-count');
  if (navAllCount) navAllCount.textContent = liveNotes.length;
  const navBinCount = document.getElementById('nav-bin-count');
  if (navBinCount) navBinCount.textContent = binnedNotes.length;
  const navArchiveCount = document.getElementById('nav-archive-count');
  if (navArchiveCount) navArchiveCount.textContent = archivedNotes.length;
  updateBinUI();
  updateVaultUI();
  updateBreadcrumbs();
  noteList.querySelectorAll('[data-note-id]').forEach((item) => item.addEventListener('click', () => selectNote(item.dataset.noteId)));
  enableNoteDragDrop();
  noteList.querySelectorAll('[data-folder]').forEach((item) => item.addEventListener('click', () => {
    const folder = item.dataset.folder;
    if (collapsedFolders.has(folder)) collapsedFolders.delete(folder);
    else collapsedFolders.add(folder);
    persistCollapsedFolders();
    renderNoteList();
  }));
  noteList.querySelectorAll('[data-folder-rename]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    startTreeRename(item.dataset.folderRename);
  }));
  noteList.querySelectorAll('[data-folder-restore]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    restoreCollection(item.dataset.folderRestore);
  }));
  noteList.querySelectorAll('[data-folder-delete]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    openFolderPermanentDeleteConfirm(item.dataset.folderDelete);
  }));
  noteList.querySelectorAll('.tree-folder-name').forEach((item) => item.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const wrap = item.closest('[data-folder-wrap]');
    if (!wrap) return;
    const folderName = wrap.dataset.folderWrap;
    if (activeView === 'bin' && (folderName === GENERAL_FOLDER || isCollectionDeleted(folderName))) return;
    startTreeRename(folderName);
  }));
  noteList.querySelectorAll('[data-section-jump]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    const kind = item.dataset.sectionJump;
    const id = item.dataset.sectionId || null;
    if (kind === 'custom' && id) selectCustomSection(id);
    else selectSection(kind);
  }));
  const renameSectionFromList = (kind, id) => {
    if (kind === 'custom' && id) startSectionRename({ kind: 'custom', id });
    else startSectionRename({ kind });
  };
  noteList.querySelectorAll('[data-section-rename]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    renameSectionFromList(item.dataset.sectionRename, item.dataset.sectionId || null);
  }));
  noteList.querySelectorAll('.list-section-title').forEach((item) => item.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    renameSectionFromList(item.dataset.sectionJump, item.dataset.sectionId || null);
  }));
}

// Selected note, falling back to the first note (may be undefined when empty — callers must guard).
function currentNote() {
  return notes.find((note) => note.id === currentId) || notes[0];
}

// Refresh word count, tag chips and the favorite button for the open note.
function updateMeta(note) {
  const body = typeof note.body === 'string' ? note.body : '';
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  wordCount.textContent = `${words} word${words === 1 ? '' : 's'}`;
  const tags = Array.isArray(note.tags) ? note.tags.filter((tag) => typeof tag === 'string').slice(0, 20) : [];
  tagList.innerHTML = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('');
  document.getElementById('favorite-button').classList.toggle('is-favorite', Boolean(note.favorite));
  document.getElementById('favorite-button').style.color = note.favorite ? '#b79b54' : '';
}

// Open a note in the editor and re-render the list; lock state is reapplied afterwards.
// Every note opens in PREVIEW mode (edit mode never carries over between
// notes); clicking/focusing the preview switches that note to edit mode.
function selectNote(id) {
  const note = notes.find((item) => item.id === id);
  if (!note) return;
  currentId = id;
  currentVaultId = null;
  document.querySelector('.app-shell').classList.remove('workspace-focus');
  writeMode = 'preview';
  clearTimeout(idleTimer);
  titleInput.value = typeof note.title === 'string' ? note.title : 'Untitled note';
  markdownInput.value = typeof note.body === 'string' ? note.body : '';
  breadcrumbTitle.textContent = note.title;
  renderPreview(note);
  updateMeta(note);
  renderNoteList();
  refreshEditorLock();
}

// Debounced save: refuses (with a warning, never truncates) past 2000 notes, then syncs encrypted to the server.
function persistNotes() {
  if (notes.length > 2000) {
    // Never silently truncate: refusing to sync preserves data locally until
    // the user deletes notes; the server would reject oversized payloads.
    saveLabel.textContent = 'Sync failed';
    showToast('Too many notes to sync (2000 max) — delete some to keep saving');
    clearTimeout(saveTimer);
    return;
  }
  saveLabel.textContent = 'Saving...';
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncNotesToServer(); }, 450);
}

let contextMenuNoteId = null;
const IMPORTANT_TAG = 'important';

// True when a note carries the important tag (case-insensitive).
function isImportant(note) {
  return Boolean(note && Array.isArray(note.tags) && note.tags.some((tag) => String(tag).toLowerCase() === IMPORTANT_TAG));
}

// Add/remove the important tag; important notes require popup confirmation before deletion.
function toggleImportantById(id) {
  const note = notes.find((item) => item.id === id);
  if (!note) return;
  if (!Array.isArray(note.tags)) note.tags = [];
  if (isImportant(note)) {
    note.tags = note.tags.filter((tag) => String(tag).toLowerCase() !== IMPORTANT_TAG);
    showToast('Removed important tag');
  } else {
    note.tags = [...note.tags, IMPORTANT_TAG];
    showToast('Marked as important');
  }
  if (id === currentId) updateMeta(note);
  persistNotes();
  renderNoteList();
}

// Return the shared right-click menu element.
// ---- Context menu, delete dialogs, note lifecycle (Bin/Archive/restore) ----

function getNoteContextMenu() {
  return document.getElementById('note-context-menu');
}

// Hide the right-click menu and forget its target note.
function closeNoteContextMenu() {
  const menu = getNoteContextMenu();
  if (menu) menu.hidden = true;
  contextMenuNoteId = null;
}

// Show the right-click menu at the cursor: per-state item visibility (deleted/archived/live) with viewport clamping.
function openNoteContextMenu(noteId, x, y) {
  const menu = getNoteContextMenu();
  const note = notes.find((item) => item.id === noteId);
  if (!menu || !note) return;
  contextMenuNoteId = noteId;
  const favoriteLabel = document.getElementById('context-favorite-label');
  if (favoriteLabel) favoriteLabel.textContent = note.favorite ? 'Unfavorite' : 'Favorite';
  const importantLabel = document.getElementById('context-important-label');
  if (importantLabel) importantLabel.textContent = isImportant(note) ? 'Unmark as important' : 'Mark as important';
  const isDeleted = Boolean(note.deleted);
  const isArchived = Boolean(note.archived);
  menu.querySelectorAll('[data-menu-action]').forEach((btn) => {
    const actionName = btn.dataset.menuAction;
    if (isDeleted) btn.hidden = !(actionName === 'restore' || actionName === 'delete');
    else if (isArchived) btn.hidden = !(actionName === 'open' || actionName === 'unarchive' || actionName === 'download' || actionName === 'delete');
    else btn.hidden = (actionName === 'restore' || actionName === 'unarchive');
  });
  const archiveLabel = document.getElementById('context-archive-label');
  if (archiveLabel) archiveLabel.textContent = isArchived ? 'Unarchive' : 'Archive';
  const deleteLabel = document.getElementById('context-delete-label');
  if (deleteLabel) deleteLabel.textContent = isDeleted ? 'Delete permanently' : 'Delete';
  menu.hidden = false;
  const padding = 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - padding) menu.style.left = `${Math.max(padding, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight - padding) menu.style.top = `${Math.max(padding, y - rect.height)}px`;
}

// Download one note as .md/.txt via a Blob URL with a sanitized filename.
function downloadNoteObject(note) {
  if (!note) return;
  const body = typeof note.body === 'string' ? note.body : '';
  const blob = new Blob([body], { type: note.ext === 'txt' ? 'text/plain' : 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.rel = 'noopener';
  link.download = sanitizeFilename(note.title, note.ext);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`Downloaded ${link.download}`);
}

function downloadNoteById(id) {
  downloadNoteObject(notes.find((item) => item.id === id));
}

// Copy a note (fresh id, unique title, reset dates/flags) right after the original and open it.
function duplicateNoteById(id) {
  const original = notes.find((item) => item.id === id);
  if (!original) return;
  const title = uniqueTitle(`${typeof original.title === 'string' ? original.title : 'Untitled note'} copy`);
  const copy = {
    ...original,
    id: newNoteId(),
    title,
    date: 'Now',
    favorite: false,
    archived: false,
    deleted: false,
    tags: [...(Array.isArray(original.tags) ? original.tags.filter((t) => typeof t === 'string') : [])],
    body: typeof original.body === 'string' ? original.body.slice(0, 500000) : ''
  };
  delete copy.deletedAt;
  const index = notes.findIndex((item) => item.id === id);
  notes.splice(index + 1, 0, copy);
  currentId = copy.id;
  selectNote(copy.id);
  persistNotes();
  renderNoteList();
  showToast('Note duplicated');
}

// Flip the star flag and refresh badges, counts and list.
function toggleFavoriteById(id) {
  const note = notes.find((item) => item.id === id);
  if (!note) return;
  note.favorite = !note.favorite;
  if (id === currentId) updateMeta(note);
  persistNotes();
  renderNoteList();
  showToast(note.favorite ? 'Added to favorites' : 'Removed from favorites');
}

// Empty the editor for the no-notes state and re-render.
function clearEditor() {
  currentId = null;
  currentVaultId = null;
  titleInput.value = '';
  titleInput.disabled = false;
  markdownInput.value = '';
  markdownInput.disabled = false;
  breadcrumbTitle.textContent = 'No notes';
  if (wordCount) wordCount.textContent = '0 words';
  if (tagList) tagList.innerHTML = '';
  renderNoteList();
}

// Soft-delete one note into Bin (sets deletedAt); repairs the selection to a neighbor.
function deleteNoteById(id) {
  const note = notes.find((item) => item.id === id);
  if (!note || note.deleted) return;
  const liveBefore = notes.filter((item) => !item.deleted);
  const pos = liveBefore.findIndex((item) => item.id === id);
  note.deleted = true;
  note.deletedAt = Date.now();
  if (currentId === id) {
    const liveAfter = notes.filter((item) => !item.deleted);
    if (liveAfter.length) selectNote(liveAfter[Math.min(Math.max(pos, 0), liveAfter.length - 1)].id);
    else clearEditor();
  } else {
    renderNoteList();
  }
  persistNotes();
  renderNoteList();
  showToast('Moved to Bin — kept for 3 days');
}

// Restore one binned note; revives its folder too when the folder itself was binned.
function restoreNoteById(id) {
  const note = notes.find((item) => item.id === id);
  if (!note || !note.deleted) return;
  note.deleted = false;
  delete note.deletedAt;
  if (note.collection && isCollectionDeleted(note.collection)) {
    deletedCollections = deletedCollections.filter((entry) => entry.name !== note.collection);
    persistDeletedCollections();
  }
  // Revive a binned custom section the note belongs to, so it has a home.
  // Recipe/custom folders inside live sections are re-adopted by the sync below.
  reviveSectionsForNote(note);
  syncCollectionsWithNotes();
  persistNotes();
  renderCollections();
  try { renderRecipeCollections(); } catch (error) {}
  try { renderCustomSections(); } catch (error) {}
  if (activeView === 'bin') {
    const binned = notes.filter((item) => item.deleted);
    if (binned.length) selectNote(binned[0].id);
    else clearEditor();
    renderNoteList();
  } else {
    selectNote(id);
  }
  renderNoteList();
  showToast('Note restored');
}

// Move one live note to Archive; repairs the selection from the still-visible list.
function archiveNoteById(id) {
  const note = notes.find((item) => item.id === id);
  if (!note || note.deleted || note.archived) return;
  note.archived = true;
  if (currentId === id) {
    const pool = visibleNotes().filter((item) => item.id !== id);
    if (pool.length) selectNote(pool[0].id);
    else clearEditor();
  }
  persistNotes();
  renderNoteList();
  showToast('Note archived');
}

// Return one archived note to All notes (refuses deleted notes) and re-sync the sidebar.
function unarchiveNoteById(id) {
  const note = notes.find((item) => item.id === id);
  if (!note || note.deleted || !note.archived) return;
  note.archived = false;
  syncCollectionsWithNotes();
  persistNotes();
  renderCollections();
  renderNoteList();
  showToast('Note unarchived');
}

// Erase one binned note immediately; repairs the selection.
function permanentlyDeleteNoteById(id) {
  const index = notes.findIndex((item) => item.id === id);
  if (index === -1) return;
  const wasCurrent = currentId === id;
  notes.splice(index, 1);
  if (wasCurrent) {
    const pool = activeView === 'bin' ? notes.filter((item) => item.deleted) : notes.filter((item) => !item.deleted);
    if (pool.length) selectNote(pool[0].id);
    else clearEditor();
  } else {
    renderNoteList();
  }
  persistNotes();
  try { pruneDeletedCustomSections(); } catch (error) {}
  renderNoteList();
  showToast('Permanently deleted');
}

// Permanently erase everything in Bin (notes + folder entries) after popup confirmation.
function emptyBin() {
  const binned = notes.filter((item) => item.deleted);
  if (!binned.length) { showToast('Bin is already empty'); return; }
  notes = notes.filter((item) => !item.deleted);
  deletedCollections = [];
  persistDeletedCollections();
  deletedCustomSections = [];
  persistDeletedCustomSections();
  const currentAlive = currentId && notes.some((item) => item.id === currentId);
  if (!currentAlive) {
    if (notes.length) selectNote(notes[0].id);
    else clearEditor();
  } else {
    renderNoteList();
  }
  persistNotes();
  renderNoteList();
  showToast(`Emptied Bin (${binned.length})`);
}

// Dispatch a validated context-menu action; unknown ids/actions are ignored.
function handleNoteMenuAction(action, id) {
  if (!id || typeof id !== 'string' || !isValidNoteId(id)) return;
  if (typeof action !== 'string' || !/^(open|favorite|important|restore|duplicate|download|archive|unarchive|delete)$/.test(action)) return;
  if (action === 'open') selectNote(id);
  else if (action === 'favorite') toggleFavoriteById(id);
  else if (action === 'important') toggleImportantById(id);
  else if (action === 'restore') restoreNoteById(id);
  else if (action === 'archive') archiveNoteById(id);
  else if (action === 'unarchive') unarchiveNoteById(id);
  else if (action === 'duplicate') duplicateNoteById(id);
  else if (action === 'download') downloadNoteById(id);
  else if (action === 'delete') {
    const note = notes.find((item) => item.id === id);
    if (!note) return;
    if (note.deleted) openPermanentDeleteConfirm(id);
    else if (isImportant(note)) openDeleteConfirm(id);
    else deleteNoteById(id);
  }
}

let pendingDeleteId = null;
let pendingDeleteMode = 'soft';
let pendingDeleteSection = null; // custom section id for folder/section deletes

// Fill the shared in-app confirm popup (eyebrow/title/name/message). Name is set via textContent — never HTML.
function setDeleteDialog({ eyebrow, title, name, message }) {
  const eyebrowEl = document.querySelector('#delete-overlay .eyebrow');
  const titleEl = document.getElementById('delete-title');
  const descEl = document.getElementById('delete-desc');
  const nameEl = document.getElementById('delete-note-name');
  if (eyebrowEl && eyebrow) eyebrowEl.textContent = eyebrow;
  if (titleEl && title) titleEl.textContent = title;
  if (nameEl && name !== undefined) nameEl.textContent = name;
  if (descEl && message) {
    descEl.innerHTML = '';
    descEl.append(document.createTextNode('“'));
    const nameSpan = document.createElement('span');
    nameSpan.id = 'delete-note-name';
    nameSpan.textContent = name || 'Untitled note';
    descEl.append(nameSpan, document.createTextNode(message));
  }
}

// Popup: delete an important-tagged note (moves to Bin, restorable for 3 days).
function openDeleteConfirm(id) {
  const note = notes.find((item) => item.id === id);
  if (!note) return;
  pendingDeleteId = id;
  pendingDeleteMode = 'soft';
  setDeleteDialog({
    eyebrow: 'Delete note',
    title: 'Delete this note?',
    name: note.title || 'Untitled note',
    message: '” is marked as important. Move it to Bin anyway? You can restore it within 3 days.'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Popup: permanently erase one binned note (no recovery).
function openPermanentDeleteConfirm(id) {
  const note = notes.find((item) => item.id === id);
  if (!note) return;
  pendingDeleteId = id;
  pendingDeleteMode = 'permanent';
  setDeleteDialog({
    eyebrow: 'Permanently delete',
    title: 'Delete forever?',
    name: note.title || 'Untitled note',
    message: '” will be permanently deleted and cannot be recovered. Are you sure?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Popup: permanently erase the whole Bin (shows the doomed count).
function openEmptyBinConfirm() {
  const count = notes.filter((item) => item.deleted).length;
  if (!count) { showToast('Bin is already empty'); return; }
  pendingDeleteId = '__ALL__';
  pendingDeleteMode = 'empty';
  setDeleteDialog({
    eyebrow: 'Empty Bin',
    title: 'Empty Bin?',
    name: `${count} note${count === 1 ? '' : 's'}`,
    message: '” in Bin will be permanently deleted and cannot be recovered. Are you sure?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Popup: delete a folder (its notes move to Bin, or to General for legacy text — see deleteCollection).
function openFolderDeleteConfirm(name) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  const isGeneral = name === GENERAL_FOLDER;
  if (!isGeneral && !collections.includes(name)) return;
  const count = notes.filter((note) => !note.deleted && isFolderOrSub(folderOf(note), name)
    && (name !== GENERAL_FOLDER || !hidesInGeneral(note))).length;
  pendingDeleteId = name;
  pendingDeleteMode = 'folder';
  setDeleteDialog({
    eyebrow: 'Delete folder',
    title: 'Delete this folder?',
    name,
    message: !count
      ? '” is empty. Are you sure you want to delete it?'
      : isGeneral
        ? `” holds ${count} uncategorized note${count === 1 ? '' : 's'}. Notes inside will move to Bin for 3 days. Are you sure?`
        : `” holds ${count} note${count === 1 ? '' : 's'}. The folder and its notes will move to Bin for 3 days. Are you sure?`
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Popup: permanently erase a binned folder and all its binned notes.
function openFolderPermanentDeleteConfirm(name) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  if (!isCollectionDeleted(name)) return;
  const count = notes.filter((note) => note.deleted && note.collection === name).length;
  pendingDeleteId = name;
  pendingDeleteMode = 'folder-permanent';
  setDeleteDialog({
    eyebrow: 'Permanently delete',
    title: 'Delete folder forever?',
    name,
    message: `” and its ${count} binned note${count === 1 ? '' : 's'} will be permanently deleted and cannot be recovered. Are you sure?`
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Hide the confirm popup and clear the pending action.
function closeDeleteConfirm() {
  const overlay = document.getElementById('delete-overlay');
  if (overlay) overlay.hidden = true;
  pendingDeleteId = null;
  pendingDeleteMode = 'soft';
  pendingDeleteSection = null;
}

// Run the pending popup action: soft/permanent/empty/folder/folder-permanent.
function confirmPendingDelete() {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  const mode = pendingDeleteMode;
  const sectionId = pendingDeleteSection;
  closeDeleteConfirm();
  if (mode === 'empty') emptyBin();
  else if (mode === 'permanent') permanentlyDeleteNoteById(id);
  else if (mode === 'folder') deleteCollection(id);
  else if (mode === 'folder-permanent') permanentlyDeleteCollection(id);
  else if (mode === 'vault-note') deleteVaultNote(id);
  else if (mode === 'recipe') deleteRecipe(id);
  else if (mode === 'custom-section') deleteCustomSection(id);
  else if (mode === 'builtin-section') deleteBuiltinSection(id);
  else if (mode === 'custom-folder') deleteCustomFolder(sectionId, id);
  else deleteNoteById(id);
}

// Delegated right-click handling on the note list; closes on outside click, resize, scroll and Escape.
function bindNoteContextMenu() {
  const menu = getNoteContextMenu();
  if (!menu || !noteList) return;
  noteList.addEventListener('contextmenu', (event) => {
    const item = event.target.closest('[data-note-id]');
    if (!item) return;
    event.preventDefault();
    event.stopPropagation();
    openNoteContextMenu(item.dataset.noteId, event.clientX, event.clientY);
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-menu-action]');
    if (!item) return;
    const action = item.dataset.menuAction;
    const id = contextMenuNoteId;
    closeNoteContextMenu();
    handleNoteMenuAction(action, id);
  });
  document.addEventListener('click', (event) => {
    if (contextMenuNoteId && !event.target.closest('#note-context-menu')) closeNoteContextMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    if (contextMenuNoteId && !event.target.closest('#note-context-menu')) closeNoteContextMenu();
  });
  window.addEventListener('resize', closeNoteContextMenu);
  noteList.addEventListener('scroll', closeNoteContextMenu);
}

// ---- Private Vault (user-facing feature) ----------------------------------
// Password-locked secret notes behind the single Vault menu button. This is
// separate from the login AND from the E2EE key vault above: vault items live
// inside the E2EE notes blob as per-item AES-GCM ciphertexts under the vault
// key, so the server sees nothing. Only a verifier + wrapped vault key persist
// server-side (vault_meta table). Locked state keeps ciphertext (`blobs`) so
// a background sync can never wipe secrets; plaintext exists in memory only
// while unlocked (wiped on lock/logout/reload).
const vault = { unlocked: false, dek: null, notes: [], blobs: [], meta: null };
let currentVaultId = null;
let vaultModalMode = null; // 'setup' | 'unlock' | 'reset-confirm'

function validVaultBlob(item) {
  return Boolean(item && typeof item.id === 'string' && item.payload
    && typeof item.payload.iv === 'string' && typeof item.payload.data === 'string');
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function vaultEncryptNote(note) {
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault.dek,
    new TextEncoder().encode(JSON.stringify({
      id: note.id, title: note.title, body: note.body,
      tags: Array.isArray(note.tags) ? note.tags : [],
      ext: note.ext === 'txt' ? 'txt' : 'md',
      date: note.date, favorite: !!note.favorite,
    })));
  return { id: note.id, payload: { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) } };
}

async function vaultDecryptItem(item) {
  const plain = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(item.payload.iv) }, vault.dek,
    e2eeB64ToBytes(item.payload.data));
  const obj = JSON.parse(new TextDecoder().decode(plain));
  if (!obj || typeof obj !== 'object') throw new Error('bad vault note');
  return {
    id: String(item.id),
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.slice(0, 200) : 'Untitled note',
    body: typeof obj.body === 'string' ? obj.body.slice(0, 500000) : '',
    tags: Array.isArray(obj.tags) ? obj.tags.filter((tag) => typeof tag === 'string').slice(0, 20) : [],
    ext: obj.ext === 'txt' ? 'txt' : 'md',
    date: typeof obj.date === 'string' ? obj.date.slice(0, 40) : 'Now',
    favorite: false,
  };
}

async function decryptAllVaultBlobs() {
  const out = [];
  for (const item of vault.blobs) {
    try { out.push(await vaultDecryptItem(item)); }
    catch (error) { /* skip corrupt items */ }
  }
  return out;
}

// Ciphertext staged for upload: freshly encrypted while unlocked, retained
// blobs while locked (a background sync can never erase secrets).
async function currentVaultBlobs() {
  if (!vault.unlocked) return vault.blobs;
  const out = [];
  for (const note of vault.notes) out.push(await vaultEncryptNote(note));
  vault.blobs = out;
  return out;
}

function uniqueVaultTitle(base) {
  const clean = (typeof base === 'string' ? base : 'Untitled note').trim().slice(0, 180) || 'Untitled note';
  const taken = new Set(vault.notes.map((note) => String(note.title || '').toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  let counter = 2;
  while (taken.has(`${clean} ${counter}`.toLowerCase())) counter += 1;
  return `${clean} ${counter}`;
}

// Open a vault note in the editor (preview-first, like normal notes).
function selectVaultNote(id) {
  const note = vault.unlocked ? vault.notes.find((item) => item.id === id) : null;
  if (!note) return;
  currentVaultId = id;
  currentId = null;
  document.querySelector('.app-shell').classList.remove('workspace-focus');
  writeMode = 'preview';
  clearTimeout(idleTimer);
  titleInput.value = note.title;
  markdownInput.value = note.body;
  breadcrumbTitle.textContent = note.title;
  renderPreview(note);
  updateMeta(note);
  renderNoteList();
  refreshEditorLock();
}

// Save the open vault note into memory; the debounced envelope sync persists it.
function saveVaultNote() {
  if (!vault.unlocked || !currentVaultId) return;
  const note = vault.notes.find((item) => item.id === currentVaultId);
  if (!note) return;
  note.title = (typeof titleInput.value === 'string' ? titleInput.value : '').trim().slice(0, 200) || 'Untitled note';
  note.body = typeof markdownInput.value === 'string' ? markdownInput.value.slice(0, 500000) : '';
  note.date = 'Now';
  breadcrumbTitle.textContent = note.title;
  renderPreview(note);
  updateMeta(note);
  saveLabel.textContent = 'Saving...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 450);
}

function addVaultNote() {
  if (!vault.unlocked) { showToast('Unlock the Vault first'); return; }
  const title = uniqueVaultTitle('Untitled note');
  const note = { id: newNoteId(), title, body: `# ${title}\n\nSecret...`, tags: [], ext: 'md', date: 'Now', favorite: false };
  vault.notes.unshift(note);
  currentVaultId = note.id;
  selectVaultNote(note.id);
  persistNotes();
  showToast('Secret note created');
}

function deleteVaultNote(id) {
  const index = vault.notes.findIndex((item) => item.id === id);
  if (index === -1) return;
  vault.notes.splice(index, 1);
  vault.blobs = vault.blobs.filter((item) => item.id !== id);
  if (currentVaultId === id) {
    if (vault.notes.length) selectVaultNote(vault.notes[Math.min(index, vault.notes.length - 1)].id);
    else { currentVaultId = null; clearEditor(); }
  }
  persistNotes();
  renderNoteList();
  showToast('Secret note deleted');
}

function openVaultNoteDeleteConfirm(id) {
  const note = vault.notes.find((item) => item.id === id);
  if (!note) return;
  pendingDeleteId = id;
  pendingDeleteMode = 'vault-note';
  setDeleteDialog({
    eyebrow: 'Delete secret note',
    title: 'Delete this note?',
    name: note.title || 'Untitled note',
    message: '” will be permanently deleted and cannot be recovered. Are you sure?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Render the Vault view: lock notice when locked, otherwise one Vault folder
// with the decrypted notes. Counts/footer mirror the normal list shape.
function renderVaultList() {
  updateVaultUI();
  updateBreadcrumbs();
  const emptyTitle = listEmpty.querySelector('strong');
  const emptySub = listEmpty.querySelector('span:last-child');
  if (!vault.unlocked) {
    noteList.innerHTML = `
    <div class="vault-locked">
      <span class="empty-icon" data-icon="lock"></span>
      <strong>Vault is locked</strong>
      <span>Unlock to see your secret notes.</span>
      <button class="btn btn-primary" id="vault-lock-open">Unlock Vault</button>
    </div>`;
    const lockIcon = noteList.querySelector('[data-icon="lock"]');
    if (lockIcon) lockIcon.innerHTML = icon('lock');
    listEmpty.hidden = true;
    noteList.hidden = false;
    if (allCount) allCount.textContent = '0';
    if (recentCountEl) recentCountEl.textContent = '0';
    if (starredCountEl) starredCountEl.textContent = '0';
    if (totalCount) totalCount.textContent = '0 in vault';
    const openBtn = document.getElementById('vault-lock-open');
    if (openBtn) openBtn.addEventListener('click', openVaultModal);
    return;
  }
  if (!vault.notes.length) {
    noteList.innerHTML = '';
    listEmpty.hidden = false;
    noteList.hidden = true;
    if (emptyTitle) emptyTitle.textContent = 'Vault is empty';
    if (emptySub) emptySub.textContent = 'Create your first secret note.';
  } else {
    listEmpty.hidden = true;
    noteList.hidden = false;
    noteList.innerHTML = `
    <div class="tree-folder-wrap" data-folder-wrap="Vault">
      <div class="tree-folder-row">
        <button class="tree-folder" data-folder="Vault" aria-expanded="true" title="Vault">
          <span class="tree-chevron">${icon('chevron-right')}</span>
          <span class="tree-folder-icon">${icon('lock')}</span>
          <span class="tree-folder-name">Vault</span>
          <span class="tree-count">${vault.notes.length}</span>
        </button>
      </div>
      <div class="tree-children">
        ${vault.notes.map((note) => `
        <button class="tree-file${note.id === currentVaultId ? ' selected' : ''}" data-vault-id="${escapeHtml(note.id)}" title="${escapeHtml(note.title || 'Untitled note')}">
          <span class="tree-file-icon tree-file-icon-md">${icon('file')}</span>
          <span class="tree-file-name">${escapeHtml(note.title || 'Untitled note')}</span>
          <span class="tree-action danger" data-vault-delete="${escapeHtml(note.id)}" title="Delete secret note" role="button" aria-label="Delete ${escapeHtml(note.title || 'Untitled note')}">${icon('trash')}</span>
        </button>`).join('')}
      </div>
    </div>`;
  }
  if (allCount) allCount.textContent = vault.notes.length;
  if (recentCountEl) recentCountEl.textContent = vault.notes.filter((note) => isRecentNote(note)).length;
  if (starredCountEl) starredCountEl.textContent = vault.notes.filter((note) => note.favorite).length;
  if (totalCount) totalCount.textContent = `${vault.notes.length} in vault`;
  noteList.querySelectorAll('[data-vault-id]').forEach((item) => item.addEventListener('click', (event) => {
    if (event.target.closest('[data-vault-delete]')) return;
    selectVaultNote(item.dataset.vaultId);
  }));
  noteList.querySelectorAll('[data-vault-delete]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    openVaultNoteDeleteConfirm(item.dataset.vaultDelete);
  }));
}

// Toggle the vault-only action buttons and the nav lock icon.
function updateVaultUI() {
  const inVault = activeView === 'vault';
  const showVaultTools = inVault && vault.unlocked;
  const newVaultBtn = document.getElementById('new-vault-note');
  const lockVaultBtn = document.getElementById('lock-vault');
  if (newVaultBtn) newVaultBtn.hidden = !showVaultTools;
  if (lockVaultBtn) lockVaultBtn.hidden = !showVaultTools;
  if (inVault) {
    // The vault has its own actions; never show the normal ones here.
    const newNoteBtn = document.getElementById('new-note');
    const importBtn = document.getElementById('import-notes');
    if (newNoteBtn) newNoteBtn.hidden = true;
    if (importBtn) importBtn.hidden = true;
  }
  if (inVault) {
    // The vault has its own actions; never show the normal ones here.
    const newNoteBtn = document.getElementById('new-note');
    const importBtn = document.getElementById('import-notes');
    if (newNoteBtn) newNoteBtn.hidden = true;
    if (importBtn) importBtn.hidden = true;
  }
  const vaultNavIcon = document.querySelector('.nav-item[data-view="vault"] .nav-icon');
  if (vaultNavIcon) vaultNavIcon.innerHTML = icon(vault.unlocked ? 'unlock' : 'lock');
}

function enterVaultView() {
  if (!vault.unlocked) { openVaultModal(); return; }
  activeView = 'vault';
  activeCollection = null;
  activeRecipe = null;
  activeSection = null;
  activeCustom = null;
  activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'vault'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCollections();
  renderNoteList();
}

// Wipe vault plaintext (keeping ciphertext blobs) and leave the view.
async function lockVault() {
  if (activeView === 'vault' && currentVaultId) saveVaultNote();
  try { await currentVaultBlobs(); } catch (error) {}
  persistNotes();
  vault.unlocked = false;
  vault.dek = null;
  vault.notes = [];
  vault.meta = null;
  currentVaultId = null;
  goAllNotes();
  renderNoteList();
  showToast('Vault locked');
}

// Vault password modal: 'setup' (first run), 'unlock', or 'reset-confirm'.
function setVaultModal(mode, message) {
  vaultModalMode = mode;
  document.getElementById('vault-title').textContent = mode === 'setup' ? 'Set Vault Password' : mode === 'reset-confirm' ? 'Reset Vault?' : 'Unlock Vault';
  document.getElementById('vault-desc').textContent = mode === 'setup'
    ? 'Choose a password just for your vault. It is separate from your login and cannot be recovered.'
    : mode === 'reset-confirm'
      ? 'This permanently deletes every note inside the vault. This cannot be undone.'
      : 'Enter your vault password to reveal your secret notes.';
  document.getElementById('vault-setup-block').hidden = mode !== 'setup';
  document.getElementById('vault-unlock-block').hidden = mode !== 'unlock';
  const confirmBtn = document.getElementById('vault-confirm');
  confirmBtn.textContent = mode === 'setup' ? 'Set password' : mode === 'reset-confirm' ? 'Reset vault' : 'Unlock';
  confirmBtn.className = mode === 'unlock' ? 'btn btn-primary' : 'btn btn-danger';
  const errorEl = document.getElementById('vault-error');
  if (errorEl) {
    if (message) { errorEl.textContent = message; errorEl.hidden = false; }
    else errorEl.hidden = true;
  }
}

async function openVaultModal() {
  if (!cachedProfile || !e2ee.masterKey) { showToast('Log in to open the Vault'); return; }
  let meta = null;
  try {
    const response = await apiFetch('/api/vault-meta');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    meta = await response.json();
  } catch (error) {
    showToast('Cannot reach the Notely server');
    return;
  }
  vault.meta = meta;
  setVaultModal(meta && meta.exists ? 'unlock' : 'setup');
  document.getElementById('vault-overlay').hidden = false;
  const focusInput = document.querySelector(vaultModalMode === 'setup' ? '#vault-new-password' : '#vault-password');
  if (focusInput) focusInput.focus();
}

function closeVaultModal() {
  document.getElementById('vault-overlay').hidden = true;
  vaultModalMode = null;
  ['vault-password', 'vault-new-password', 'vault-confirm-password'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
}

function vaultFail(message) {
  const errorEl = document.getElementById('vault-error');
  const card = document.querySelector('#vault-overlay .modal');
  if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; }
  if (card) {
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  }
}

async function setupVaultFromModal() {
  const password = String(document.getElementById('vault-new-password').value || '');
  const confirm = String(document.getElementById('vault-confirm-password').value || '');
  if (password !== confirm) { vaultFail('Passwords do not match.'); return; }
  const missing = passwordPolicyCheck(password);
  if (missing.length) { vaultFail(`Vault password needs ${missing.join(', ')}.`); return; }
  try {
    const saltAuthBytes = e2eeRandomBytes(16);
    const saltEncBytes = e2eeRandomBytes(16);
    const verifier = await argon2id32(password, saltAuthBytes);
    const dekRaw = e2eeRandomBytes(32);
    const kekRaw = await argon2id32(password, saltEncBytes);
    const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = e2eeRandomBytes(12);
    const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, dekRaw);
    const response = await apiFetch('/api/vault-meta', {
      method: 'POST',
      body: JSON.stringify({
        verifier: e2eeBytesToB64(verifier),
        saltAuth: e2eeBytesToB64(saltAuthBytes),
        saltEnc: e2eeBytesToB64(saltEncBytes),
        encDek: { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) },
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    vault.dek = await window.crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    vault.notes = [];
    vault.unlocked = true;
    closeVaultModal();
    enterVaultView();
    showToast('Vault ready');
  } catch (error) {
    vaultFail('Could not set up the vault. Try again.');
  }
}

async function unlockVaultFromModal() {
  const password = String(document.getElementById('vault-password').value || '');
  const meta = vault.meta;
  if (!meta || !meta.exists) { setVaultModal('setup'); return; }
  try {
    const verifier = await argon2id32(password, e2eeB64ToBytes(meta.saltAuth));
    if (!timingSafeEqualStr(e2eeBytesToB64(verifier), meta.verifier)) {
      vaultFail('Incorrect vault password.');
      return;
    }
    const kekRaw = await argon2id32(password, e2eeB64ToBytes(meta.saltEnc));
    const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const dekRaw = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: e2eeB64ToBytes(meta.encDek.iv) }, kek, e2eeB64ToBytes(meta.encDek.data));
    vault.dek = await window.crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    vault.notes = await decryptAllVaultBlobs();
    vault.unlocked = true;
    closeVaultModal();
    enterVaultView();
    showToast('Vault unlocked');
  } catch (error) {
    vaultFail('Incorrect vault password.');
  }
}

async function resetVault() {
  try {
    const response = await apiFetch('/api/vault-meta', { method: 'DELETE' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    vaultFail('Could not reset the vault. Try again.');
    return;
  }
  vault.unlocked = false;
  vault.dek = null;
  vault.notes = [];
  vault.blobs = [];
  vault.meta = null;
  currentVaultId = null;
  persistNotes();
  closeVaultModal();
  goAllNotes();
  renderNoteList();
  showToast('Vault reset');
}

document.getElementById('vault-confirm').addEventListener('click', async () => {
  if (vaultModalMode === 'setup') await setupVaultFromModal();
  else if (vaultModalMode === 'reset-confirm') await resetVault();
  else await unlockVaultFromModal();
});
document.getElementById('vault-cancel').addEventListener('click', closeVaultModal);
document.getElementById('close-vault').addEventListener('click', closeVaultModal);
document.getElementById('vault-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'vault-overlay') closeVaultModal();
});
document.getElementById('vault-overlay').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
    event.preventDefault();
    document.getElementById('vault-confirm').click();
  }
});
document.getElementById('vault-reset-link').addEventListener('click', () => setVaultModal('reset-confirm'));
document.getElementById('new-vault-note').addEventListener('click', addVaultNote);
document.getElementById('lock-vault').addEventListener('click', lockVault);

// Detect a trailing .md/.txt extension typed in the title and switch the note type instead.
function parseTitleExtension(rawTitle, note) {
  const input = typeof rawTitle === 'string' ? rawTitle : 'Untitled note';
  const match = input.match(/\.((md|markdown|txt|text))$/i);
  if (match) {
    const ext = match[1].toLowerCase();
    note.ext = (ext.startsWith('txt') || ext === 'text') ? 'txt' : 'md';
    return input.slice(0, -(match[0].length)).trim().slice(0, 200) || 'Untitled note';
  }
  return input.slice(0, 200);
}

// Persist title/body from the editor (debounced server sync); refuses deleted/archived notes.
function saveCurrentNote() {
  if (activeView === 'vault') { saveVaultNote(); return; }
  const note = currentNote();
  if (!note || note.deleted || note.archived) return;
  const rawTitle = (typeof titleInput.value === 'string' ? titleInput.value : '').trim().slice(0, 200) || 'Untitled note';
  note.title = parseTitleExtension(rawTitle, note);
  if (typeof note.title !== 'string' || !note.title.trim()) note.title = 'Untitled note';
  note.title = note.title.slice(0, 200);
  note.body = typeof markdownInput.value === 'string' ? markdownInput.value.slice(0, 500000) : '';
  note.date = 'Now';
  breadcrumbTitle.textContent = note.title;
  renderPreview(note);
  updateMeta(note);
  saveLabel.textContent = 'Saving...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 450);
  resetIdleTimer();
}

// De-duplicate a note title (case-insensitive) by appending a counter.
function uniqueTitle(base) {
  const clean = (typeof base === 'string' ? base : 'Untitled note').trim().slice(0, 180) || 'Untitled note';
  const taken = new Set(notes.map((note) => String(note.title || '').toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  let counter = 2;
  while (taken.has(`${clean} ${counter}`.toLowerCase())) counter += 1;
  return `${clean} ${counter}`;
}

// ---- Templates, toasts, editor formatting commands ----

const NOTE_TEMPLATES = {
  standard: {
    label: 'Standard note',
    titleBase: 'Untitled note',
    tags: [],
    body: (title) => `# ${title}\n\nStart writing here...`
  },
  recipe: {
    label: 'Recipe',
    titleBase: 'New recipe',
    tags: ['recipe'],
    body: (title) => `# ${title}\n\n> Prep: 15 min · Cook: 30 min · Servings: 4\n\n## Ingredients\n\n- 2 tbsp olive oil\n- 1 onion, diced\n- 2 cloves garlic, minced\n- Salt and pepper to taste\n\n## Instructions\n\n1. Heat the oil over medium heat.\n2. Add the onion and cook until soft.\n3. Add garlic, season, and finish to taste.\n\n## Notes\n\n- ...`
  },
  todo: {
    label: 'To-do list',
    titleBase: 'New to-do list',
    tags: ['todo'],
    body: (title) => `# ${title}\n\n## Today\n\n- [ ] Most important task\n- [ ] Second task\n\n## Later\n\n- [ ] Someday task`
  }
};

// Create a note from the Standard/Recipe/To-Do template into the current view+collection and open it.
function createNoteFromTemplate(templateKey) {
  const template = NOTE_TEMPLATES[templateKey] || NOTE_TEMPLATES.standard;
  if (activeView === 'bin') {
    activeView = 'notes';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    listHeading.textContent = 'All notes';
  }
  const id = newNoteId();
  const title = uniqueTitle(template.titleBase);
  const tags = [...template.tags];
  // Filing follows the workspace: a picked folder files the note there; a bare
  // section view asks first (pendingSectionFolder), falling back to the
  // section's first folder only when the picker had nothing to offer.
  const picked = pendingSectionFolder;
  pendingSectionFolder = null;
  const pickedCustom = picked && picked.ns === 'custom' && activeCustom && picked.section === activeCustom.section
    ? picked.folder : null;
  const pickedRecipe = picked && picked.ns === 'recipes' && activeSection === 'recipes' && !activeRecipe
    ? picked.folder : null;
  const customSection = activeCustom ? customSections.find((entry) => entry.id === activeCustom.section) : null;
  const customFolder = pickedCustom
    || (activeCustom && activeCustom.folder)
    || (customSection && customSection.folders.length ? customSection.folders[0] : null);
  const recipeFolder = pickedRecipe || activeRecipe
    || (activeSection === 'recipes' && recipeCollections.length ? recipeCollections[0] : null);
  const note = { id, title, date: 'Now', tags, favorite: false, archived: false, deleted: false, ext: 'md', collection: activeCollection === GENERAL_FOLDER ? null : activeCollection, recipe: recipeFolder, sections: (activeCustom && customFolder) ? { [activeCustom.section]: customFolder } : {}, body: template.body(title) };
  notes.unshift(note);
  activeFilter = 'all';
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  // A stale search query must never swallow the brand-new note.
  clearSearch();
  currentId = id;
  selectNote(id);
  markdownInput.focus();
  markdownInput.setSelectionRange(markdownInput.value.length, markdownInput.value.length);
  persistNotes();
  // Confirm where it landed: if the current view filters it out, name the
  // destination so the note is findable instead of seemingly lost.
  const shown = visibleNotes().some((entry) => entry.id === id);
  const dest = customFolder || recipeFolder || note.collection || GENERAL_FOLDER;
  showToast(shown ? `${template.label} created` : `${template.label} created in ${dest}`);
  return note;
}

// Shortcut for a blank Standard note.
function addNote() {
  createNoteFromTemplate('standard');
}

// Show the New-note template chooser popup.
function openTemplatePicker() {
  const overlay = document.getElementById('template-overlay');
  if (!overlay) { addNote(); return; }
  overlay.hidden = false;
  const first = overlay.querySelector('.template-option');
  if (first) first.focus();
}

// Hide the template chooser popup.
function closeTemplatePicker() {
  const overlay = document.getElementById('template-overlay');
  if (overlay) overlay.hidden = true;
}

// Folder picked in a bare section view, awaiting template choice.
let pendingSectionFolder = null; // { ns: 'custom'|'recipes', section: id|null, folder } | null

// + New note entry: a bare section view (no folder picked) asks for the
// destination folder first, so the note lands where the user wants. A section
// with no folders yet cannot file anything — say so instead of silently
// creating an invisible note.
function onNewNoteClick() {
  pendingSectionFolder = null;
  if (activeCustom && !activeCustom.folder) {
    const section = customSections.find((entry) => entry.id === activeCustom.section);
    if (section && !section.folders.length) {
      showToast(`Create a folder in ${section.name} first`);
      return;
    }
    if (openFolderPicker('custom', activeCustom.section)) return;
  } else if (activeSection === 'recipes' && !activeRecipe) {
    if (!recipeCollections.length) {
      showToast('Create a recipe folder first');
      return;
    }
    if (openFolderPicker('recipes', null)) return;
  }
  openTemplatePicker();
}

// Fill + show the folder chooser for a bare section view. Returns false when
// there is nothing to choose (caller falls through to the template picker).
function openFolderPicker(ns, sectionId) {
  const box = document.getElementById('folder-pick-options');
  const overlay = document.getElementById('folder-pick-overlay');
  if (!box || !overlay) return false;
  let entries = [];
  if (ns === 'custom') {
    const section = customSections.find((entry) => entry.id === sectionId);
    if (!section || !section.folders.length) return false;
    entries = section.folders.map((folder) => ({ ns, section: sectionId, folder, context: section.name }));
  } else {
    if (!recipeCollections.length) return false;
    entries = recipeCollections.map((folder) => ({ ns, section: null, folder, context: sectionDisplayName('recipes') }));
  }
  document.getElementById('folder-pick-desc').textContent = `Where in ${entries[0].context} should this note land?`;
  box.innerHTML = entries.map((entry) => {
    const leaf = folderLeaf(entry.folder);
    const sub = leaf === entry.folder ? entry.context : entry.folder;
    return `
    <button class="template-option" data-pick-ns="${entry.ns}" data-pick-section="${escapeHtml(entry.section || '')}" data-pick-folder="${escapeHtml(entry.folder)}">
      <span class="template-icon">${icon('folder')}</span>
      <span class="theme-option-text"><strong>${escapeHtml(leaf)}</strong><span>${escapeHtml(sub)}</span></span>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-pick-folder]').forEach((btn) => btn.addEventListener('click', () => {
    pendingSectionFolder = { ns: btn.dataset.pickNs, section: btn.dataset.pickSection || null, folder: btn.dataset.pickFolder };
    closeFolderPicker();
    openTemplatePicker();
  }));
  overlay.hidden = false;
  const first = box.querySelector('[data-pick-folder]');
  if (first) first.focus();
  return true;
}

function closeFolderPicker() {
  const overlay = document.getElementById('folder-pick-overlay');
  if (overlay) overlay.hidden = true;
}

// Show a transient bottom-right status message (single timer, latest wins).
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

// True when the open note is .txt (Markdown tools stay disabled).
function isPlainTextNote() {
  const note = activeEditorNote();
  return note && note.ext === 'txt';
}

// Wrap the editor selection (or placeholder word) with a Markdown marker and save.
function wrapSelection(before, after = before) {
  if (!cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
  if (isPlainTextNote()) { showToast('Plain text note — switch to Markdown to format'); return; }
  const start = markdownInput.selectionStart;
  const end = markdownInput.selectionEnd;
  const selected = markdownInput.value.slice(start, end) || 'text';
  markdownInput.setRangeText(`${before}${selected}${after}`, start, end, 'select');
  markdownInput.focus();
  saveCurrentNote();
}

// Insert a Markdown line prefix (heading/list/quote) at the start of the current line and save.
function linePrefix(prefix) {
  if (!cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
  if (isPlainTextNote()) { showToast('Plain text note — switch to Markdown to format'); return; }
  const start = markdownInput.selectionStart;
  const lineStart = markdownInput.value.lastIndexOf('\n', start - 1) + 1;
  markdownInput.setRangeText(prefix, lineStart, lineStart, 'end');
  markdownInput.focus();
  saveCurrentNote();
}

document.getElementById('new-note').addEventListener('click', onNewNoteClick);
document.getElementById('close-templates').addEventListener('click', closeTemplatePicker);
document.getElementById('template-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'template-overlay') closeTemplatePicker();
});
document.getElementById('close-folder-pick').addEventListener('click', closeFolderPicker);
document.getElementById('folder-pick-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'folder-pick-overlay') closeFolderPicker();
});
document.querySelectorAll('.template-option').forEach((option) => option.addEventListener('click', () => {
  closeTemplatePicker();
  createNoteFromTemplate(option.dataset.template);
}));
document.getElementById('close-delete').addEventListener('click', closeDeleteConfirm);
document.getElementById('cancel-delete').addEventListener('click', closeDeleteConfirm);
document.getElementById('confirm-delete').addEventListener('click', confirmPendingDelete);
document.getElementById('delete-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'delete-overlay') closeDeleteConfirm();
});
titleInput.addEventListener('input', saveCurrentNote);
markdownInput.addEventListener('input', saveCurrentNote);

document.getElementById('search-input').addEventListener('input', (event) => {
  searchQuery = String(event.target.value || '').slice(0, 200);
  renderNoteList();
});

document.querySelectorAll('.filter-chip').forEach((chip) => chip.addEventListener('click', () => {
  activeFilter = chip.dataset.filter;
  document.querySelectorAll('.filter-chip').forEach((item) => item.classList.toggle('active', item === chip));
  updateListHeading();
  renderNoteList();
}));

// Display name of a sidebar section.
// Display folder of a note inside one custom section (null when unassigned).
function customNoteFolder(note, sectionId) {
  if (!note || !note.sections || typeof note.sections !== 'object') return null;
  const folder = note.sections[sectionId];
  return typeof folder === 'string' && folder.trim() ? folder : null;
}

// Display name of a sidebar section: custom sections carry their own name,
// built-ins fall back to defaults unless renamed.
function sectionDisplayName(kind, id) {
  if (kind === 'custom') {
    const section = customSections.find((entry) => entry.id === id);
    return section ? section.name : 'Section';
  }
  if (sectionNames[kind]) return sectionNames[kind];
  return kind === 'recipes' ? 'Recipes' : 'Collections';
}

// Persist custom sections + section display names into the encrypted UI vault.
function persistCustomSections() {
  persistUiVault();
}

// Filter the list to every folder under a sidebar section (header click).
// One filter at a time: this clears any selected folder.
function selectSection(kind) {
  if (kind !== 'collections' && kind !== 'recipes') return;
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  activeView = 'notes';
  activeFilter = 'all';
  activeCollection = null;
  activeRecipe = null;
  activeCustom = null;
  activeSection = kind;
  clearSearch();
  updateListHeading();
  renderCollections();
  renderNoteList();
}

// Filter the list to a custom section (folder null) or one of its folders.
// Clears every other filter, like its built-in counterparts.
function selectCustomSection(sectionId) {
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  activeView = 'notes';
  activeFilter = 'all';
  activeCollection = null;
  activeRecipe = null;
  activeSection = null;
  activeCustom = { section: sectionId, folder: null };
  clearSearch();
  updateListHeading();
  renderCollections();
  renderNoteList();
}

function selectCustomFolder(sectionId, folder) {
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section || !section.folders.includes(folder)) return;
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  activeView = 'notes';
  activeFilter = 'all';
  activeCollection = null;
  activeRecipe = null;
  activeSection = null;
  activeCustom = { section: sectionId, folder };
  clearSearch();
  updateListHeading();
  renderCollections();
  renderNoteList();
}

// Clear the active collection/recipe filter and both sidebar highlights.
function clearCollectionSelection() {
  activeCollection = null;
  activeRecipe = null;
  activeSection = null;
  activeCustom = null;
  document.querySelectorAll('#collection-list .collection-item, #recipe-list .collection-item').forEach((item) => item.classList.remove('active'));
}

document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', (event) => {
  event.preventDefault();
  const view = item.dataset.view;
  if (typeof view !== 'string' || !/^(notes|favorites|archive|bin|vault)$/.test(view)) return;
  if (view === 'vault' && !vault.unlocked) { openVaultModal(); return; }
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav === item));
  clearCollectionSelection();
  activeView = view;
  searchQuery = '';
  document.getElementById('search-input').value = '';
  if (view === 'favorites') {
    activeFilter = 'favorites';
    listHeading.textContent = 'Starred notes';
  } else if (view === 'bin') {
    activeFilter = 'all';
    listHeading.textContent = 'Bin';
  } else if (view === 'vault') {
    activeFilter = 'all';
    updateListHeading();
  } else {
    activeFilter = 'all';
    listHeading.textContent = view === 'archive' ? 'Archive' : 'All notes';
  }
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === activeFilter));
  renderNoteList();
}));

document.getElementById('empty-bin').addEventListener('click', (event) => {
  event.preventDefault();
  openEmptyBinConfirm();
});

document.getElementById('new-collection').addEventListener('click', (event) => {
  event.preventDefault();
  addCollectionFolder();
});

document.getElementById('new-recipe').addEventListener('click', (event) => {
  event.preventDefault();
  addRecipeFolder();
});

preview.addEventListener('click', () => {
  if (writeMode === 'preview') setWriteMode('edit', { focus: true });
});
preview.addEventListener('focus', () => {
  if (writeMode === 'preview') setWriteMode('edit', { focus: true });
});
if (modeToggle) modeToggle.addEventListener('click', () => {
  const note = activeEditorNote();
  if (!note || note.ext === 'txt') return;
  if (writeMode === 'preview') setWriteMode('edit', { focus: true });
  else if (markdownInput.value.trim()) setWriteMode('preview');
  else showToast('Nothing to preview yet');
});

document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
  if (writeMode === 'preview') setWriteMode('edit');
  const action = button.dataset.action;
  if (action === 'bold') wrapSelection('**');
  if (action === 'italic') wrapSelection('*');
  if (action === 'code') wrapSelection('`');
  if (action === 'heading') linePrefix('## ');
  if (action === 'bullet') linePrefix('- ');
  if (action === 'check') linePrefix('- [ ] ');
  if (action === 'quote') linePrefix('> ');
  if (action === 'link') wrapSelection('[', '](https://)');
}));

document.getElementById('favorite-button').addEventListener('click', () => {
  const note = activeEditorNote();
  if (!note) return;
  if (note.deleted) { showToast('Restore this note to edit it'); return; }
  if (note.archived) { showToast('Unarchive this note to edit it'); return; }
  note.favorite = !note.favorite;
  updateMeta(note);
  persistNotes();
  renderNoteList();
  showToast(note.favorite ? 'Added to favorites' : 'Removed from favorites');
});

document.getElementById('share-button').addEventListener('click', async () => {
  const note = activeEditorNote();
  if (!note) return;
  if (note.deleted || note.archived) { showToast('Only active notes can be shared'); return; }
  const title = typeof note.title === 'string' ? note.title.slice(0, 200) : 'Untitled note';
  const body = typeof note.body === 'string' ? note.body.slice(0, 5000) : '';
  const shareText = `${title}\n\n${body}`;
  if (!window.isSecureContext && !navigator.share) { showToast('Sharing needs a secure context'); return; }
  try {
    if (navigator.share) await navigator.share({ title: note.title, text: shareText });
    else await navigator.clipboard.writeText(shareText);
    showToast(navigator.share ? 'Share sheet opened' : 'Note copied to clipboard');
  } catch (error) {
    if (error.name !== 'AbortError') showToast('Could not share this note');
  }
});

if (typeBadge) typeBadge.addEventListener('click', () => {
  const note = activeEditorNote();
  if (!note) return;
  if (note.deleted) { showToast('Restore this note to edit it'); return; }
  if (note.archived) { showToast('Unarchive this note to edit it'); return; }
  note.ext = note.ext === 'txt' ? 'md' : 'txt';
  writeMode = 'edit';
  clearTimeout(idleTimer);
  renderPreview(note);
  resetIdleTimer();
  persistNotes();
  renderNoteList();
  showToast(note.ext === 'txt' ? 'Switched to plain text (.txt)' : 'Switched to Markdown (.md)');
});

document.getElementById('import-notes').addEventListener('click', () => importInput.click());
const MAX_IMPORT_FILES = 20;
const MAX_IMPORT_BYTES_PER_FILE = 1024 * 1024;
const MAX_IMPORT_BYTES_TOTAL = 5 * 1024 * 1024;
importInput.addEventListener('change', async (event) => {
  const picked = [...(event.target.files || [])].filter((file) => /\.(md|markdown|txt|text)$/i.test(file.name || ''));
  if (!picked.length) { showToast('Choose .md or .txt files to import'); return; }
  if (picked.length > MAX_IMPORT_FILES) { showToast(`Choose up to ${MAX_IMPORT_FILES} files at once`); importInput.value = ''; return; }
  let imported = 0;
  let totalBytes = 0;
  for (const file of picked) {
    try {
      if (typeof file.size === 'number' && file.size > MAX_IMPORT_BYTES_PER_FILE) { showToast(`Skipped ${file.name}: over 1 MB`); continue; }
      const text = await file.text();
      if (text.length > MAX_IMPORT_BYTES_PER_FILE) { showToast(`Skipped ${file.name}: over 1 MB`); continue; }
      totalBytes += text.length;
      if (totalBytes > MAX_IMPORT_BYTES_TOTAL) { showToast('Import stopped: 5 MB total limit'); break; }
      const rawBase = String(file.name || 'Untitled note').replace(/\.[^.]+$/, '').trim().slice(0, 180) || 'Untitled note';
      const base = rawBase.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
      const isText = /\.(txt|text)$/i.test(file.name);
      const note = {
        id: newNoteId(),
        title: uniqueTitle(base),
        date: 'Now',
        tags: [],
        favorite: false,
        archived: false,
        deleted: false,
        ext: isText ? 'txt' : 'md',
        collection: activeCollection === GENERAL_FOLDER ? null : activeCollection,
        recipe: activeRecipe,
        sections: (activeCustom && activeCustom.folder) ? { [activeCustom.section]: activeCustom.folder } : {},
        body: (text || (isText ? '' : `# ${base}\n`)).slice(0, 500000)
      };
      notes.unshift(note);
      if (imported === 0) currentId = note.id;
      imported += 1;
    } catch (error) { /* skip unreadable files */ }
  }
  importInput.value = '';
  if (imported) {
    activeFilter = 'all';
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
    syncCollectionsWithNotes();
    renderCollections();
    selectNote(currentId);
    persistNotes();
    showToast(`Imported ${imported} file${imported === 1 ? '' : 's'}`);
  }
});

document.getElementById('more-button').addEventListener('click', () => {
  downloadNoteObject(activeEditorNote());
});
document.getElementById('focus-editor').addEventListener('click', () => {
  document.querySelector('.editor-panel').classList.toggle('focus-mode');
  showToast(document.querySelector('.editor-panel').classList.contains('focus-mode') ? 'Focus mode on' : 'Focus mode off');
});
document.getElementById('open-sidebar').addEventListener('click', () => document.getElementById('sidebar').classList.add('open'));
document.getElementById('close-sidebar').addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));

// ---- App shell wiring: search, filters, nav, import/export, sidebar collapse ----

const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('toggle-sidebar');
// Collapse/expand the icon-strip sidebar and persist the choice.
function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  try { localStorage.setItem('notely-sidebar-collapsed', collapsed ? '1' : '0'); } catch (error) {}
  if (sidebarToggle) {
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.setAttribute('title', label);
  }
}
// Whether the sidebar starts collapsed on load (Settings → Side Menu; device-local).
function startCollapsedPref() {
  try { return localStorage.getItem('notely-sidebar-start-collapsed') !== '0'; }
  catch (error) { return true; }
}
if (sidebarToggle) {
  setSidebarCollapsed(startCollapsedPref());
  sidebarToggle.addEventListener('click', () => {
    setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
  });
}

// ---- Auth & E2EE session, themes, settings, boot ----

const THEMES = ['light', 'dark', 'dracula'];
const THEME_META_COLORS = { light: '#f4f0e9', dark: '#1f1d1b', dracula: '#282a36' };
const settingsOverlay = document.getElementById('settings-overlay');

// Auth is handled by the Notely server (server.py) backed by the encrypted
// SQLite database (notely.db). The browser stores no credentials: the session
// lives in an HttpOnly cookie and the profile below is in-memory only.
let cachedProfile = null;

// Same-origin JSON fetch wrapper used by every backend call.
async function apiFetch(path, options) {
  return fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
}

// Ask the server who holds the cookie; caches the profile in memory (null when signed out).
async function refreshSession() {
  try {
    const response = await apiFetch('/api/me');
    if (!response.ok) {
      cachedProfile = null;
      return null;
    }
    cachedProfile = await response.json();
    return cachedProfile;
  } catch (error) {
    cachedProfile = null;
    return null;
  }
}

// Display name from an E2EE profile (first + last, falls back to username).
function fullNameOf(profile) {
  return `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || profile.username || '?';
}

// Synchronous view of the in-memory session for render code (null when signed out).
function getSessionUser() {
  if (!cachedProfile) return null;
  return { username: cachedProfile.username, name: fullNameOf(cachedProfile), subtitle: cachedProfile.subtitle || 'Personal space' };
}

// Avatar initials: first letters of the first two name words, uppercased.
function initialsFor(name) {
  return String(name || '').trim().split(/\s+/).map((word) => word[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
}

// Display profile (name + subtitle) or null when signed out.
function currentProfile() {
  const sessionUser = getSessionUser();
  if (sessionUser) return { name: sessionUser.name, subtitle: sessionUser.subtitle };
  return null;
}

// Paint the sidebar profile card and avatar from the session profile.
function applyProfile() {
  const profile = currentProfile();
  if (!profile) return;
  const nameEl = document.querySelector('.profile-copy strong');
  const subEl = document.querySelector('.profile-copy span');
  const avatarEl = document.querySelector('.profile-card .avatar');
  if (nameEl) nameEl.textContent = profile.name;
  if (subEl) subEl.textContent = profile.subtitle;
  if (avatarEl) avatarEl.textContent = initialsFor(profile.name);
}

// Show the login gate and focus the username field.
function showLogin() {
  const overlay = document.getElementById('login-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  const errorEl = document.getElementById('login-error');
  if (errorEl) errorEl.hidden = true;
  const userInput = document.getElementById('login-username');
  if (userInput) userInput.focus();
}

// Hide the login gate.
function hideLogin() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.hidden = true;
}

// Server logout, then wipe keys/notes/editor/selection from memory and reset the UI to the gate.
// Pending edits are flushed to the server FIRST so nothing made in this
// session is lost by the relog. The per-account encrypted local cache is kept
// (it needs the master key to read); only legacy plaintext keys are removed.
async function logout() {
  // Flush while still unlocked: local UI cache + server envelope (notes + UI).
  try {
    clearTimeout(uiVaultTimer);
    if (cachedProfile && e2ee.masterKey) {
      try { await writeUiVaultLocal(); } catch (error) {}
      try { await flushNotesToServer(); } catch (error) {}
    } else {
      clearTimeout(syncTimer);
    }
  } catch (error) {}
  try { await apiFetch('/api/logout', { method: 'POST' }); } catch (error) {}
  cachedProfile = null;
  e2eeLock();
  // Wipe decrypted workspace: memory, editor DOM and any legacy local copy.
  notes = [];
  notesLoaded = false;
  serverUiLoaded = false;
  currentId = null;
  currentVaultId = null;
  vault.unlocked = false;
  vault.dek = null;
  vault.notes = [];
  vault.blobs = [];
  vault.meta = null;
  activeView = 'notes';
  activeFilter = 'all';
  activeCollection = null;
  activeRecipe = null;
  activeSection = null;
  activeCustom = null;
  searchQuery = '';
  clearTimeout(syncTimer);
  try { clearTimeout(saveTimer); } catch (error) {}
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
  wipeLegacyLocalNotes();
  try {
    // Drop only legacy plaintext keys (CWE-312). Per-account encrypted caches
    // (`notely-ui-vault:<user>`) stay so the next login boots fast offline —
    // the server envelope remains the source of truth.
    localStorage.removeItem(COLLECTION_STORAGE_KEY);
    localStorage.removeItem(DELETED_COLLECTIONS_KEY);
    localStorage.removeItem(COLLAPSED_FOLDERS_KEY);
    localStorage.removeItem(RECIPE_STORAGE_KEY);
    localStorage.removeItem(SECTION_DATA_KEY);
  } catch (error) {}
  collections = [...DEFAULT_COLLECTIONS];
  deletedCollections = [];
  collapsedFolders = new Set();
  recipeCollections = [];
  customSections = [];
  sectionNames = {};
  hiddenSections = [];
  titleInput.value = '';
  markdownInput.value = '';
  breadcrumbTitle.textContent = 'No notes';
  if (wordCount) wordCount.textContent = '0 words';
  if (tagList) tagList.innerHTML = '';
  const passwordInput = document.getElementById('login-password');
  if (passwordInput) passwordInput.value = '';
  document.getElementById('sidebar').classList.remove('open');
  renderCollections();
  clearEditor();
  showLogin();
}

// Show the login error message with a shake; defaults to the generic (non-enumerating) text.
function loginFail(message) {
  const errorEl = document.getElementById('login-error');
  const card = document.querySelector('.login-card');
  if (errorEl) {
    errorEl.textContent = message || 'Incorrect username or password.';
    errorEl.hidden = false;
  }
  if (card) {
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  }
}

// Client-side password rules (12+ chars, upper, lower, digit, special). The server never sees passwords, so this is the enforcement point for new ones.
function passwordPolicyCheck(password) {
  const failures = [];
  if (typeof password !== 'string' || password.length < 12) failures.push('at least 12 characters');
  if (!/[A-Z]/.test(password || '')) failures.push('1 capital letter');
  if (!/[a-z]/.test(password || '')) failures.push('1 small letter');
  if (!/[0-9]/.test(password || '')) failures.push('1 number');
  if (!/[^A-Za-z0-9]/.test(password || '')) failures.push('1 special character');
  return failures;
}

// Switch the gate between Log in and Create account forms. The single tab
// below the submit button doubles as the way back: it reads "Create account"
// on the login form and "Log in" on the register form.
function setAuthTab(mode) {
  const isRegister = mode === 'register';
  document.getElementById('login-form').hidden = isRegister;
  document.getElementById('register-form').hidden = !isRegister;
  const tabLoginEl = document.getElementById('tab-login');
  if (tabLoginEl) {
    tabLoginEl.classList.toggle('active', !isRegister);
    tabLoginEl.setAttribute('aria-selected', String(!isRegister));
  }
  const tabRegisterEl = document.getElementById('tab-register');
  if (tabRegisterEl) {
    tabRegisterEl.classList.toggle('active', isRegister);
    tabRegisterEl.setAttribute('aria-selected', String(isRegister));
    tabRegisterEl.textContent = isRegister ? 'Log in' : 'Create account';
  }
  document.getElementById('login-title').textContent = isRegister ? 'Create account' : 'Log in';
}

const tabLogin = document.getElementById('tab-login');
const tabRegister = document.getElementById('tab-register');
if (tabLogin) tabLogin.addEventListener('click', () => setAuthTab('login'));
if (tabRegister) tabRegister.addEventListener('click', () => {
  const onRegister = !document.getElementById('register-form').hidden;
  setAuthTab(onRegister ? 'login' : 'register');
});

let authBusy = false;
// Derive the KEK and unwrap the account master key into memory (extractable
// within this page so it can be re-wrapped on rotation/upgrade). Throws on
// wrong password (vault stays locked). Bundle shape: {kdf, saltAuth,
// saltEnc, iterations?, encMasterKey} with base64 salts/wrap.
async function e2eeUnlockWithPassword(username, password, bundle) {
  const saltEncBytes = e2eeB64ToBytes(bundle.saltEnc);
  let masterKey;
  if (bundle.kdf === 'argon2id') {
    const rawKek = await argon2id32(password, saltEncBytes);
    const kek = await window.crypto.subtle.importKey('raw', rawKek, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const rawMk = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: e2eeB64ToBytes(bundle.encMasterKey.iv) }, kek, e2eeB64ToBytes(bundle.encMasterKey.data));
    masterKey = await window.crypto.subtle.importKey('raw', rawMk, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  } else {
    masterKey = await e2eeUnwrapMasterKey(password, saltEncBytes, bundle.iterations, bundle.encMasterKey);
  }
  const saltAuthBytes = e2eeB64ToBytes(bundle.saltAuth);
  e2ee.masterKey = masterKey;
  e2ee.kdf = bundle.kdf || 'pbkdf2';
  e2ee.saltAuth = saltAuthBytes;
  e2ee.saltEnc = saltEncBytes;
  e2ee.iterations = bundle.iterations || 0;
}

// One-shot PBKDF2 -> Argon2id lift: re-wraps the SAME master key (exported
// while unlocked) under a fresh Argon2id KEK. Notes are untouched, so this
// cannot strand data; failures simply retry on the next login.
async function e2eeUpgradeKdf(username, password) {
  const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
  const saltAuthBytes = e2eeRandomBytes(16);
  const saltEncBytes = e2eeRandomBytes(16);
  const authBits = await argon2id32(password, saltAuthBytes);
  const wrapped = await e2eeWrapMasterKeyArgon2id(password, saltEncBytes, masterRaw);
  const oldAuthBits = await e2eeDeriveBits(password, e2ee.saltAuth, e2ee.iterations);
  const response = await apiFetch('/api/upgrade-kdf', {
    method: 'POST',
    body: JSON.stringify({
      oldAuthHash: e2eeBytesToB64(oldAuthBits),
      kdf: 'argon2id',
      params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
      saltAuth: e2eeBytesToB64(saltAuthBytes),
      saltEnc: e2eeBytesToB64(saltEncBytes),
      authHash: e2eeBytesToB64(authBits),
      encMasterKey: wrapped,
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  e2ee.kdf = 'argon2id';
  e2ee.saltAuth = saltAuthBytes;
  e2ee.saltEnc = saltEncBytes;
  e2ee.iterations = 0;
}

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authBusy) return;
  const usernameEl = document.getElementById('login-username');
  const passwordEl = document.getElementById('login-password');
  const submitBtn = event.target.querySelector('button[type="submit"]');
  const username = String(usernameEl.value || '').trim().slice(0, 32);
  const password = String(passwordEl.value || '');
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username) || !password) { loginFail(); return; }
  authBusy = true;
  if (submitBtn) submitBtn.disabled = true;
  const done = () => { authBusy = false; if (submitBtn) submitBtn.disabled = false; };
  try {
    // Step 1: fetch KDF parameters (identical shape for unknown names, so
    // this reveals nothing beyond what login itself would).
    const kdfResponse = await apiFetch(`/api/kdf-params?username=${encodeURIComponent(username)}`);
    if (!kdfResponse.ok) throw new Error(`HTTP ${kdfResponse.status}`);
    const kdf = await kdfResponse.json();
    let data;
    if (kdf && kdf.e2ee && kdf.saltAuth) {
      // Step 2a: E2EE login — only the auth verifier travels the wire.
      // Argon2id (~1s) or legacy PBKDF2 per the account descriptor; anything
      // else is refused (downgrade protection).
      let authBits;
      if (kdf.kdf === 'argon2id') {
        assertArgon2Params(kdf.params);
        authBits = await argon2id32(password, e2eeB64ToBytes(kdf.saltAuth));
      } else {
        authBits = await e2eeDeriveBits(password, e2eeB64ToBytes(kdf.saltAuth), (kdf.params && kdf.params.i) || 0);
      }
      const loginResponse = await apiFetch('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, authHash: e2eeBytesToB64(authBits) })
      });
      if (!loginResponse.ok) {
        done();
        if (loginResponse.status === 429) loginFail('Too many attempts — try again in a few minutes.');
        else loginFail();
        return;
      }
      data = await loginResponse.json();
      await e2eeUnlockWithPassword(username, password, {
        kdf: data.kdf || kdf.kdf || 'pbkdf2',
        saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
        iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
        encMasterKey: data.encMasterKey,
      });
      if (e2ee.kdf !== 'argon2id') {
        try {
          await e2eeUpgradeKdf(username, password);
        } catch (error) { /* vault still works on PBKDF2; retry next login */ }
      }
    } else {
      // Step 2b: legacy account — password login upgrades it to E2EE
      // transparently and returns the fresh wrapped key in one round trip.
      const loginResponse = await apiFetch('/api/login', {
        method: 'POST',
        body: JSON.stringify({ username, password })
      });
      if (!loginResponse.ok) {
        done();
        if (loginResponse.status === 429) loginFail('Too many attempts — try again in a few minutes.');
        else loginFail();
        return;
      }
      data = await loginResponse.json();
      if (data && data.encMasterKey) {
        await e2eeUnlockWithPassword(username, password, data);
      }
    }
    cachedProfile = { username: data.username, firstName: data.firstName, lastName: data.lastName, subtitle: data.subtitle };
    const errorEl = document.getElementById('login-error');
    if (errorEl) errorEl.hidden = true;
    passwordEl.value = '';
    hideLogin();
    applyProfile();
    // Fresh account context: never leak the previous login's sidebar into this one.
    serverUiLoaded = false;
    collections = [...DEFAULT_COLLECTIONS];
    deletedCollections = [];
    collapsedFolders = new Set();
    recipeCollections = [];
    customSections = [];
    sectionNames = {};
    hiddenSections = [];
    await loadNotesFromServer();
    if (purgeExpiredBin()) persistNotes();
    await loadUiVault();
    syncCollectionsWithNotes();
    // First login on a v1 row (or a device that knew more than the server):
    // push the merged sidebar up so the next relog/device sees it.
    if (!serverUiLoaded) {
      try { await writeUiVaultLocal(); } catch (error) {}
      persistNotes();
    }
    renderCollections();
    const firstActiveNote = notes.find((note) => !note.deleted && !note.archived)
      || notes.find((note) => !note.deleted)
      || notes[0];
    currentId = firstActiveNote ? firstActiveNote.id : null;
    if (currentId) selectNote(currentId);
    else clearEditor();
    refreshEditorLock();
    showToast(`Welcome back, ${fullNameOf(cachedProfile)}`);
  } catch (error) {
    e2eeLock();
    const message = error && error.message;
    loginFail(message === 'e2ee-unwrap' ? 'Could not unlock notes with this password.'
      : (message && message.indexOf('argon2') === 0) ? 'Security libraries failed integrity check. Hard-refresh and retry.'
      : 'Cannot reach the Notely server. Is it running?');
  }
  done();
});

const registerForm = document.getElementById('register-form');
if (registerForm) registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (authBusy) return;
  const username = String(document.getElementById('register-username').value || '').trim();
  const first = String(document.getElementById('register-first').value || '').trim().slice(0, 40);
  const last = String(document.getElementById('register-last').value || '').trim().slice(0, 40);
  const password = String(document.getElementById('register-password').value || '');
  const confirm = String(document.getElementById('register-confirm').value || '');
  const errorEl = document.getElementById('register-error');
  const fail = (msg) => { if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; } };
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { fail('Username must be 3-32 chars: letters, numbers, _ or -.'); return; }
  if (!first || !last) { fail('First and last name are required.'); return; }
  if (password !== confirm) { fail('Passwords do not match.'); return; }
  const missing = passwordPolicyCheck(password);
  if (missing.length) { fail(`Password needs ${missing.join(', ')}.`); return; }
  authBusy = true;
  let response;
  try {
    // E2EE+Argon2id registration: brand-new random master key, wrapped
    // locally. The password never leaves this device — only the verifier,
    // salts, descriptor and wrapped key do.
    const saltAuthBytes = e2eeRandomBytes(16);
    const saltEncBytes = e2eeRandomBytes(16);
    const authBits = await argon2id32(password, saltAuthBytes);
    const masterRaw = e2eeRandomBytes(32);
    const wrapped = await e2eeWrapMasterKeyArgon2id(password, saltEncBytes, masterRaw);
    response = await apiFetch('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        username,
        kdf: 'argon2id',
        params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
        authHash: e2eeBytesToB64(authBits),
        saltAuth: e2eeBytesToB64(saltAuthBytes),
        saltEnc: e2eeBytesToB64(saltEncBytes),
        encMasterKey: wrapped,
        firstName: first,
        lastName: last
      })
    });
  } catch (error) {
    fail('Cannot reach the Notely server. Is it running?');
    authBusy = false;
    return;
  }
  authBusy = false;
  if (response.status === 202) {
    // Uniform response: the server answers identically whether the name was
    // free or taken, so this message must not distinguish the two cases.
    let message = 'If the username is available, the account was created — please log in';
    try {
      const data = await response.json();
      if (data && typeof data.message === 'string' && data.message) message = data.message;
    } catch (error) {}
    if (errorEl) errorEl.hidden = true;
    showToast(message);
    setAuthTab('login');
    document.getElementById('login-username').value = username;
    document.getElementById('register-password').value = '';
    document.getElementById('register-confirm').value = '';
  } else if (response.status === 429) {
    fail('Too many attempts — try again in a few minutes.');
  } else {
    try {
      const data = await response.json();
      fail(data.error || 'Could not create account.');
    } catch (error) {
      fail('Could not create account.');
    }
  }
});

const changeBtn = document.getElementById('change-password-btn');
if (changeBtn) changeBtn.addEventListener('click', async () => {
  const current = String(document.getElementById('change-current').value || '');
  const next = String(document.getElementById('change-new').value || '');
  const errorEl = document.getElementById('change-error');
  const missing = passwordPolicyCheck(next);
  if (missing.length) {
    if (errorEl) { errorEl.textContent = `New password needs ${missing.join(', ')}.`; errorEl.hidden = false; }
    return;
  }
  if (!e2ee.masterKey || !e2ee.saltAuth || !e2ee.saltEnc || !cachedProfile) {
    if (errorEl) { errorEl.textContent = 'Please log in again, then retry.'; errorEl.hidden = false; }
    return;
  }
  let response;
  let newSaltAuthBytes = null;
  let newSaltEncBytes = null;
  try {
    // Rotation binds to the CURRENT password too: derive its verifier under
    // the account's registered KDF for the proof, then wrap under a fresh
    // Argon2id KEK — all without revealing either password or any key.
    const currentAuthBits = e2ee.kdf === 'argon2id'
      ? await argon2id32(current, e2ee.saltAuth)
      : await e2eeDeriveBits(current, e2ee.saltAuth, e2ee.iterations);
    newSaltAuthBytes = e2eeRandomBytes(16);
    newSaltEncBytes = e2eeRandomBytes(16);
    const newAuthBits = await argon2id32(next, newSaltAuthBytes);
    const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
    const newWrapped = await e2eeWrapMasterKeyArgon2id(next, newSaltEncBytes, masterRaw);
    response = await apiFetch('/api/change-password', {
      method: 'POST',
      body: JSON.stringify({
        currentAuth: e2eeBytesToB64(currentAuthBits),
        kdf: 'argon2id',
        params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
        authHash: e2eeBytesToB64(newAuthBits),
        saltAuth: e2eeBytesToB64(newSaltAuthBytes),
        saltEnc: e2eeBytesToB64(newSaltEncBytes),
        encMasterKey: newWrapped
      })
    });
  } catch (error) {
    if (errorEl) { errorEl.textContent = 'Cannot reach the server.'; errorEl.hidden = false; }
    return;
  }
  if (response.ok) {
    e2ee.kdf = 'argon2id';
    e2ee.saltAuth = newSaltAuthBytes;
    e2ee.saltEnc = newSaltEncBytes;
    e2ee.iterations = 0;
    if (errorEl) errorEl.hidden = true;
    document.getElementById('change-current').value = '';
    document.getElementById('change-new').value = '';
    showToast('Password updated');
  } else {
    try {
      const data = await response.json();
      if (errorEl) { errorEl.textContent = data.error || 'Could not update password.'; errorEl.hidden = false; }
    } catch (error) {
      if (errorEl) { errorEl.textContent = 'Could not update password.'; errorEl.hidden = false; }
    }
  }
});
document.getElementById('logout-button').addEventListener('click', logout);
// Apply a theme (light/dark/dracula), persist the choice and update the meta theme-color.
function applyTheme(theme, announce = false) {
  const normalized = THEMES.includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = normalized;
  try { localStorage.setItem('notely-theme', normalized); } catch (error) {}
  // Sync to the per-account envelope so the choice survives logout, restart
  // and other devices. No-op while logged out/locked (localStorage still keeps
  // the login screen on the picked theme).
  try {
    if (typeof persistUiVault === 'function' && cachedProfile && e2ee.masterKey) persistUiVault();
  } catch (error) {}
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', THEME_META_COLORS[normalized]);
  document.querySelectorAll('.theme-option').forEach((option) => {
    const selected = option.dataset.themeValue === normalized;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-pressed', selected ? 'true' : 'false');
  });
  document.querySelectorAll('.login-theme-item').forEach((option) => {
    const selected = option.dataset.themeValue === normalized;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  if (announce) showToast(`${normalized.charAt(0).toUpperCase() + normalized.slice(1)} theme on`);
}
// Show the settings modal and close the mobile sidebar.
function openSettings() {
  if (!settingsOverlay) return;
  setSettingsTab('appearance');
  const startBox = document.getElementById('start-collapsed');
  if (startBox) startBox.checked = startCollapsedPref();
  syncSideMenuSettings();
  settingsOverlay.hidden = false;
  document.getElementById('sidebar').classList.remove('open');
}
// Keep the Side Menu section toggles in sync with hiddenSections.
function syncSideMenuSettings() {
  const collectionsBox = document.getElementById('show-collections');
  if (collectionsBox) collectionsBox.checked = !isBuiltinHidden('collections');
  const recipesBox = document.getElementById('show-recipes');
  if (recipesBox) recipesBox.checked = !isBuiltinHidden('recipes');
}
// Switch the settings left-nav tab and its right-side pane.
function setSettingsTab(name) {
  document.querySelectorAll('.settings-nav-item').forEach((item) => item.classList.toggle('active', item.dataset.settingsTab === name));
  document.querySelectorAll('.settings-pane').forEach((pane) => {
    pane.hidden = pane.dataset.settingsPane !== name;
  });
}
document.querySelectorAll('.settings-nav-item').forEach((item) => item.addEventListener('click', () => setSettingsTab(item.dataset.settingsTab)));
document.getElementById('start-collapsed').addEventListener('change', (event) => {
  const collapsed = event.target.checked;
  try { localStorage.setItem('notely-sidebar-start-collapsed', collapsed ? '1' : '0'); } catch (error) {}
  setSidebarCollapsed(collapsed);
  showToast(collapsed ? 'Sidebar will start collapsed' : 'Sidebar will start expanded');
});
function bindSideMenuSectionToggle(id, kind) {
  const box = document.getElementById(id);
  if (!box) return;
  box.addEventListener('change', (event) => {
    setBuiltinHidden(kind, !event.target.checked);
    syncSideMenuSettings();
    showToast(event.target.checked ? `Section “${sectionDisplayName(kind)}” shown` : `Section “${sectionDisplayName(kind)}” hidden`);
  });
}
bindSideMenuSectionToggle('show-collections', 'collections');
bindSideMenuSectionToggle('show-recipes', 'recipes');
// Hide the settings modal.
function closeSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.hidden = true;
}
let savedTheme = 'light';
try { savedTheme = localStorage.getItem('notely-theme') || 'light'; } catch (error) {}
applyTheme(savedTheme);
document.getElementById('open-settings').addEventListener('click', (event) => {
  event.preventDefault();
  openSettings();
});
document.getElementById('close-settings').addEventListener('click', closeSettings);
if (settingsOverlay) settingsOverlay.addEventListener('click', (event) => {
  if (event.target === settingsOverlay) closeSettings();
});
document.querySelectorAll('.theme-option').forEach((option) => option.addEventListener('click', () => {
  applyTheme(option.dataset.themeValue, true);
}));
// Compact picker on the login card. No toast: it would render behind the overlay.
const loginThemeToggle = document.getElementById('login-theme-toggle');
const loginThemeMenu = document.getElementById('login-theme-menu');
function setLoginThemeMenu(open) {
  if (!loginThemeToggle || !loginThemeMenu) return;
  loginThemeMenu.hidden = !open;
  loginThemeToggle.setAttribute('aria-expanded', String(open));
}
if (loginThemeToggle) loginThemeToggle.addEventListener('click', (event) => {
  event.stopPropagation();
  setLoginThemeMenu(loginThemeMenu.hidden);
});
document.querySelectorAll('.login-theme-item').forEach((option) => option.addEventListener('click', (event) => {
  event.stopPropagation();
  applyTheme(option.dataset.themeValue, false);
  setLoginThemeMenu(false);
}));
document.addEventListener('click', (event) => {
  if (loginThemeMenu && !loginThemeMenu.hidden && !event.target.closest('.login-theme-float')) setLoginThemeMenu(false);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (typeof loginThemeMenu !== 'undefined' && loginThemeMenu && !loginThemeMenu.hidden) { setLoginThemeMenu(false); return; }
    if (folderMenuTarget) { closeFolderContextMenu(); return; }
    if (contextMenuNoteId) { closeNoteContextMenu(); return; }
    const vaultOverlay = document.getElementById('vault-overlay');
    if (vaultOverlay && !vaultOverlay.hidden) { closeVaultModal(); return; }
    const deleteOverlay = document.getElementById('delete-overlay');
    if (deleteOverlay && !deleteOverlay.hidden) { closeDeleteConfirm(); return; }
    const templateOverlay = document.getElementById('template-overlay');
    if (templateOverlay && !templateOverlay.hidden) { closeTemplatePicker(); return; }
    const folderPickOverlay = document.getElementById('folder-pick-overlay');
    if (folderPickOverlay && !folderPickOverlay.hidden) { closeFolderPicker(); return; }
    if (settingsOverlay && !settingsOverlay.hidden) { closeSettings(); return; }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
    if (!cachedProfile) return;
    event.preventDefault();
    persistNotes();
    showToast('Note saved');
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
    event.preventDefault();
    wrapSelection('**');
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
    event.preventDefault();
    wrapSelection('*');
  }
  if (event.key === '/' && document.getElementById('login-overlay').hidden && document.activeElement !== markdownInput && document.activeElement !== titleInput && !(document.activeElement && (document.activeElement.classList.contains('collection-rename-input') || document.activeElement.classList.contains('tree-rename-input')))) {
    event.preventDefault();
    document.getElementById('search-input').focus();
  }
});

bindCollectionListEvents();
bindRecipeListEvents();
bindSectionHeaderEvents();
bindCustomSectionsEvents();
bindNoteContextMenu();
bindFolderContextMenu();
bindFolderDragDrop();
// Best-effort flush so closing/reloading mid-debounce never strands the last
// edits (or sidebar changes) on this device. visibilitychange fires early
// enough to complete; pagehide is a final fire-and-forget attempt.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && typeof isUnlocked === 'function' && isUnlocked()) {
    try { persistNotes(); } catch (error) {}
  }
});
window.addEventListener('pagehide', () => {
  if (cachedProfile && e2ee.masterKey) {
    try { syncNotesToServer(); } catch (error) {}
    try { writeUiVaultLocal(); } catch (error) {}
  }
});
boot();
// Startup: session check (vault stays locked, so the password gate always shows), empty locked workspace, folder sync, first-note selection, purge timer.
async function boot() {
  await refreshSession();
  applyProfile();
  // E2EE posture: the master key never persists, so even a valid session
  // cookie leaves the vault locked — the password is required on every fresh
  // page load to decrypt notes. The profile (server-side) still renders.
  notes = [];
  clearEditor();
  showLogin();
  refreshEditorLock();
  syncCollectionsWithNotes();
  renderCollections();
  clearEditor();
  refreshEditorLock();
}
setInterval(() => {
  const hadBin = notes.some((note) => note.deleted);
  if (purgeExpiredBin()) {
    if (currentId && !notes.some((note) => note.id === currentId)) {
      const live = notes.filter((note) => !note.deleted);
      if (live.length) selectNote(live[0].id);
      else clearEditor();
    } else {
      renderNoteList();
    }
    if (hadBin) showToast('Bin auto-emptied expired notes');
  }
}, 60000);
})();
