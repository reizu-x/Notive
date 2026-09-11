// ============================================================================
// Notely frontend (app.js) — single IIFE, 'use strict'.
// WHAT IT DOES: sidebar navigation, custom sections/folders, note list tree,
// Markdown editor with live preview, templates, import/export, Bin (3-day
// soft-delete), Archive, right-click menus, themes, and the login gate.
// HOW DATA FLOWS: notes live in memory (`notes`) and sync encrypted to the
// server (PUT/GET /api/notes). Auth/session/profile live in the "Auth & E2EE"
// section near the end. localStorage holds ONLY non-secret UI state:
// section/folder order, collapsed folders, theme,
// sidebar state. Rendering rule: every dynamic string goes through
// escapeHtml(); every rendered link/image URL through sanitizeUrl().
// SECTIONS (in order): Icons · Notes data + E2EE vault · Sections & Bin ·
// Note list tree · Editor · Context menu + delete dialogs · Templates ·
// Shell wiring (search/filters/nav/import/sidebar) · Auth & E2EE session ·
// Themes/settings · Boot.
// ============================================================================
'use strict';
(() => {
// Build guard: index.html carries <meta name="notely-build">. If this script
// is older/newer than the page (stale cache mix), reload once for a matching
// pair instead of running half-bound handlers that silently do nothing.
try {
  const tag = document.querySelector('meta[name="notely-build"]');
  const build = tag ? tag.getAttribute('content') : null;
  if (build !== 'dev13') {
    if (!sessionStorage.getItem('notely-build-reloaded')) {
      sessionStorage.setItem('notely-build-reloaded', '1');
      window.location.reload();
      return;
    }
  } else {
    sessionStorage.removeItem('notely-build-reloaded');
  }
} catch (error) {}
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
    id: 'inbox', title: 'Designing a calmer inbox', date: 'Today', tags: ['product', 'systems'], favorite: true, ext: 'md', sections: {},
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
    id: 'reading', title: 'A reading list for 2026', date: 'Yesterday', tags: ['reading'], favorite: false, ext: 'md', sections: { 'section-collections': 'Reading list' },
    body: `# A reading list for 2026

Books, essays, and field notes I want to spend time with this year.

## Start here

- The Art of Gathering
- The Dawn of Everything
- Ways of Seeing

I want to read fewer things, more slowly, and keep a small note for each one.`
  },
  {
    id: 'north-star', title: 'Project north star', date: 'Mar 18', tags: ['product', 'work'], favorite: false, ext: 'md', sections: { 'section-collections': 'Work' },
    body: `# Project north star

Build the smallest useful version, then learn from the people using it.

## What matters

1. Clear feedback loops
2. Fewer, better defaults
3. A product that feels good on a quiet Tuesday

> Make the important thing easy to find.`
  },
  {
    id: 'weekend', title: 'Weekend field notes', date: 'Mar 15', tags: ['personal'], favorite: false, ext: 'txt', sections: { 'section-collections': 'Personal' },
    body: `# Weekend field notes

The farmers market was quieter than usual. Picked up citrus, sourdough, and a new plant for the studio.

The good kind of unplanned day.`
  },
  {
    id: 'meeting', title: 'Team check-in notes', date: 'Mar 12', tags: ['work'], favorite: false, ext: 'md', sections: { 'section-collections': 'Work' },
    body: `# Team check-in notes

## Open threads

- Confirm the launch sequence
- Share the latest prototype
- Ask for feedback on onboarding

Next check-in: Thursday afternoon.`
  },
  {
    id: 'morning', title: 'A better morning ritual', date: 'Mar 09', tags: ['personal'], favorite: true, ext: 'txt', sections: { 'section-collections': 'Personal' },
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
  const safeExt = normalizeExt(ext);
  // Strip any extension confusion: never allow double extensions to hide type.
  const withoutDots = clean.replace(/\.+/g, '_');
  return `${withoutDots}.${safeExt}`;
}

// Note file types: Markdown renders + previews; txt/json/yaml are edited as
// plain source (no preview, no Markdown toolbar).
const NOTE_EXTS = ['md', 'txt', 'json', 'yaml'];
const EXT_LABELS = { md: 'MD', txt: 'TXT', json: 'JSON', yaml: 'YAML' };
const EXT_MIME = {
  md: 'text/markdown', txt: 'text/plain',
  json: 'application/json', yaml: 'application/x-yaml',
};
// Canonicalize a stored/typed extension (accepts yml/markdown/text aliases).
function normalizeExt(ext, fallback = 'md') {
  const clean = String(ext == null ? '' : ext).trim().toLowerCase().replace(/^\./, '');
  if (clean === 'yml') return 'yaml';
  if (clean === 'markdown') return 'md';
  if (clean === 'text') return 'txt';
  return NOTE_EXTS.includes(clean) ? clean : fallback;
}

// Note cover pictures: uploaded images stored as data URLs on the note
// (inside the E2EE envelope like everything else). Strictly validated on
// every read: image MIME only, base64 payload only, hard length cap.
const COVER_MAX_CHARS = 380000;
const COVER_ACCEPT = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  'image/avif', 'image/bmp', 'image/x-ms-bmp',
];
const COVER_MAX_DIM = 1200;
// Accept by MIME, falling back to the file extension (some systems report
// generic or missing MIME types for camera/gallery files).
function isImageFile(file) {
  if (!file) return false;
  if (COVER_ACCEPT.includes(String(file.type || '').toLowerCase())) return true;
  return /\.(png|jpe?g|jfif|webp|gif|avif|bmp)$/i.test(file.name || '');
}
function cleanCoverSrc(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = s.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  if (s.length > COVER_MAX_CHARS) return null;
  return s;
}

// Clamp/normalize one stored note into the current schema (id, ext, sections, tags/title/body caps, deleted/archived flags, sane bin timestamps). Never throws on hostile input.
function migrateNote(note) {
  const migrated = (note && typeof note === 'object' && !Array.isArray(note)) ? { ...note } : {};
  if (!isValidNoteId(migrated.id)) migrated.id = newNoteId();
  if (!NOTE_EXTS.includes(migrated.ext)) {
    const extMatch = typeof migrated.title === 'string' ? migrated.title.match(/\.((md|markdown|txt|text|json|yaml|yml))$/i) : null;
    if (extMatch) {
      migrated.ext = normalizeExt(extMatch[1]);
      migrated.title = migrated.title.slice(0, -(extMatch[0].length));
    } else {
      migrated.ext = 'md';
    }
  } else {
    migrated.ext = normalizeExt(migrated.ext);
  }
  if (typeof migrated.cover === 'string') {
    migrated.cover = cleanCoverSrc(migrated.cover);
  } else if (migrated.cover != null) {
    migrated.cover = null;
  }
  // Vertical focal point of the cover banner (0 = top, 100 = bottom).
  if (!migrated.cover || typeof migrated.coverPos !== 'number' || !Number.isFinite(migrated.coverPos)) {
    migrated.coverPos = null;
  } else {
    migrated.coverPos = Math.min(100, Math.max(0, migrated.coverPos));
  }
  if (!migrated.sections || typeof migrated.sections !== 'object' || Array.isArray(migrated.sections)) migrated.sections = {};
  // Legacy collection/tags -> default custom section (same value, new home).
  if (typeof migrated.collection === 'string' && migrated.collection.trim()) {
    const folder = migrated.collection.trim().slice(0, 180);
    if (typeof migrated.sections[MIGRATED_COLLECTIONS_SECTION_ID] !== 'string' || !migrated.sections[MIGRATED_COLLECTIONS_SECTION_ID]) {
      migrated.sections[MIGRATED_COLLECTIONS_SECTION_ID] = folder;
    }
  } else if (!('collection' in migrated) || migrated.collection == null) {
    const tags = Array.isArray(migrated.tags) ? migrated.tags : [];
    let tagFolder = null;
    if (tags.includes('work')) tagFolder = 'Work';
    else if (tags.includes('personal')) tagFolder = 'Personal';
    else if (tags.includes('reading')) tagFolder = 'Reading list';
    if (tagFolder && (typeof migrated.sections[MIGRATED_COLLECTIONS_SECTION_ID] !== 'string' || !migrated.sections[MIGRATED_COLLECTIONS_SECTION_ID])) {
      migrated.sections[MIGRATED_COLLECTIONS_SECTION_ID] = tagFolder;
    }
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
  // Built-in Collections/Recipes removed: drop legacy fields (migrated above into custom sections).
  if ('collection' in migrated) delete migrated.collection;
  if ('recipe' in migrated) delete migrated.recipe;
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
// Last server updated_at seen (optimistic concurrency: sent as baseVersion on
// PUT; server rejects 409 on stale overwrites so hijacked/racing writes fail
// instead of silently destroying newer data).
let serverNotesVersion = 0;
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
// Note bodies/titles/tags/sections are encrypted on this device with the
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
// Preflight (anti-brick): trial-decrypt a fresh wrap with the same password
// before uploading. Honest clients never send an undecryptable wrap; without
// this a client bug (or test script) bricks the account into login-200 yet
// unlock-impossible. Returns true when the wrap round-trips to 32 bytes.
async function e2eeTrialUnwrapArgon2id(password, saltEncBytes, wrapped) {
  try {
    const rawKek = await argon2id32(password, saltEncBytes);
    const kek = await window.crypto.subtle.importKey('raw', rawKek, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const raw = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapped.iv) }, kek, e2eeB64ToBytes(wrapped.data));
    return raw instanceof ArrayBuffer ? raw.byteLength === 32 : new Uint8Array(raw).length === 32;
  } catch (error) {
    return false;
  }
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
  const coverAddBtn = document.getElementById('cover-add');
  if (coverAddBtn) setCoverAddHidden(readOnly || activeView === 'vault' || !note || Boolean(note.cover));
  const coverChangeBtn = document.getElementById('cover-change');
  if (coverChangeBtn) coverChangeBtn.disabled = readOnly;
  const coverRemoveBtn = document.getElementById('cover-remove');
  if (coverRemoveBtn) coverRemoveBtn.disabled = readOnly;
  const coverReposBtn = document.getElementById('cover-repos');
  if (coverReposBtn) coverReposBtn.disabled = readOnly;
  const coverDoneBtn = document.getElementById('cover-done');
  if (coverDoneBtn) coverDoneBtn.disabled = readOnly;
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
    const response = await apiFetch('/api/notes', { method: 'PUT', body: JSON.stringify({ payload, baseVersion: serverNotesVersion }) });
    if (response.status === 409) {
      saveLabel.textContent = 'Out of date';
      try { showToast('Notes changed on server — reloading'); } catch (error) {}
      try { await loadNotesFromServer(); } catch (error) {}
      try { renderNoteList(); } catch (error) {}
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    try {
      const data = await response.json();
      if (data && typeof data.updated_at === 'number') serverNotesVersion = data.updated_at;
    } catch (error) {}
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
    try {
      if (data && typeof data.updated_at === 'number') serverNotesVersion = data.updated_at;
    } catch (error) {}
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

const BIN_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
// Default folders carried over from the removed built-in Collections section.
// New custom sections share the same folder palette/behavior (same value).
const DEFAULT_CUSTOM_FOLDERS = ['Work', 'Personal', 'Reading list'];
const FOLDER_COLORS = ['coral', 'yellow', 'blue', 'mint', 'violet', 'rose'];
const COLLECTION_COLORS = FOLDER_COLORS;
const COLLAPSED_FOLDERS_KEY = 'notely-tree-collapsed';
const SECTION_DATA_KEY = 'notely-section-data';
// Built-in Collections section removed: all sections are custom sections.
// The former Collections folders/notes migrate into MIGRATED_COLLECTIONS_SECTION_ID.
const MIGRATED_COLLECTIONS_SECTION_ID = 'section-collections';
// Per-account UI state (sidebar folders, custom sections, hidden
// sections, Bin entries, collapsed state). Source of truth is the server E2EE
// envelope (`ui` field, v2) so every account keeps its own sidebar across
// relogs and devices. A per-account encrypted localStorage copy is only a
// fast offline cache — never plaintext, never shared between accounts.
const UI_VAULT_KEY = 'notely-ui-vault';

// Locked-boot defaults: folder names stay unreadable until the vault unlocks.
let collapsedFolders = new Set();
// Sidebar sections: [{ id, name, folders: [...] }]. Notes point at
// them via note.sections = { sectionId: folderPath }. All sections (including
// the migrated former Collections) share the same implementation/value.
let customSections = [];
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
    collapsed: [...collapsedFolders],
    customSections: customSections.map((section) => ({ id: section.id, name: section.name, folders: [...section.folders] })),
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
  out.collapsed = Array.isArray(value.collapsed)
    ? value.collapsed.filter((name) => typeof name === 'string').slice(0, 500) : null;
  const cleanCustom = cleanCustomSections(value.customSections);
  if (cleanCustom) out.customSections = cleanCustom;
  // Legacy built-in Collections data (pre-unification): carried for migration
  // in applyUiSnapshot into the default custom section.
  if (Array.isArray(value.collections)) {
    const legacyCols = value.collections.filter((name) => typeof name === 'string' && name.trim()).slice(0, 200);
    if (legacyCols.length) out.legacyCollections = legacyCols;
  }
  if (value.sectionNames && typeof value.sectionNames.collections === 'string' && value.sectionNames.collections.trim()) {
    out.legacyCollectionsName = value.sectionNames.collections.trim().slice(0, 40);
  }
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
  if (out.collapsed === null
    && !out.customSections && !out.legacyCollections && !out.legacyCollectionsName && !out.deletedCustomSections && !out.theme) return null;
  return out;
}

// Apply a server/UI-vault snapshot to memory. Returns true when anything was adopted.
function applyUiSnapshot(value) {
  const clean = cleanUiSnapshot(value);
  if (!clean) return false;
  let adopted = false;
  if (clean.collapsed !== null) { collapsedFolders = new Set(clean.collapsed); adopted = true; }
  if (clean.customSections) { customSections = clean.customSections; adopted = true; }
  if (clean.deletedCustomSections) { deletedCustomSections = clean.deletedCustomSections; adopted = true; }
  // One-time migration of legacy built-in Collections into the default custom
  // section (same folders/value, unified implementation).
  if (clean.legacyCollections || clean.legacyCollectionsName) {
    try { ensureMigratedCollectionsSection(clean.legacyCollections || [], clean.legacyCollectionsName || null); adopted = true; } catch (error) {}
  }
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
    collapsed: [...collapsedFolders],
    customSections, deletedCustomSections, theme,
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
    localStorage.removeItem('notely-collections');
    localStorage.removeItem('notely-deleted-collections');
    localStorage.removeItem(COLLAPSED_FOLDERS_KEY);
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

// Ensure the migrated former-Collections custom section exists and carries
// the same folders/value. All new sections share this implementation.
function ensureMigratedCollectionsSection(legacyFolders, legacyName) {
  const folders = Array.isArray(legacyFolders)
    ? legacyFolders.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim().slice(0, 180)).slice(0, 200)
    : [];
  let section = customSections.find((entry) => entry.id === MIGRATED_COLLECTIONS_SECTION_ID);
  if (!section) {
    const baseName = (typeof legacyName === 'string' && legacyName.trim() ? legacyName.trim().slice(0, 40) : 'Collections');
    const taken = new Set(customSections.map((entry) => entry.name.toLowerCase()));
    let name = baseName;
    if (taken.has(name.toLowerCase())) {
      let counter = 2;
      while (taken.has(`${baseName} ${counter}`.toLowerCase())) counter += 1;
      name = `${baseName} ${counter}`;
    }
    const merged = [...folders];
    if (!merged.length) DEFAULT_CUSTOM_FOLDERS.forEach((name) => { if (!merged.some((entry) => entry.toLowerCase() === name.toLowerCase())) merged.push(name); });
    section = { id: MIGRATED_COLLECTIONS_SECTION_ID, name, folders: merged };
    customSections.unshift(section);
  } else {
    folders.forEach((name) => {
      if (!section.folders.some((entry) => entry.toLowerCase() === name.toLowerCase())) section.folders.push(name);
    });
    if (typeof legacyName === 'string' && legacyName.trim() && section.name !== legacyName.trim()) {
      const taken = new Set(customSections.filter((entry) => entry.id !== section.id).map((entry) => entry.name.toLowerCase()));
      if (!taken.has(legacyName.trim().toLowerCase())) section.name = legacyName.trim().slice(0, 40);
    }
  }
  // Migrate note.collection -> note.sections[migratedId] (same value, new home).
  let notesDirty = false;
  notes.forEach((note) => {
    if (typeof note.collection === 'string' && note.collection.trim()) {
      const folder = note.collection.trim().slice(0, 180);
      if (!note.sections || typeof note.sections !== 'object' || Array.isArray(note.sections)) note.sections = {};
      if (typeof note.sections[section.id] !== 'string' || !note.sections[section.id]) {
        note.sections[section.id] = folder;
        notesDirty = true;
      }
      if (!section.folders.some((entry) => entry.toLowerCase() === folder.toLowerCase())) {
        section.folders.push(folder);
      }
    }
    if ('collection' in note) { delete note.collection; notesDirty = true; }
  });
  if (notesDirty) persistNotes();
  persistCustomSections();
  return section;
}

function readLegacyUiKeys() {
  const out = { cols: null, colsName: null, collapsed: null, sections: null };
  try {
    const storedSections = JSON.parse(localStorage.getItem(SECTION_DATA_KEY) || 'null');
    if (storedSections && typeof storedSections === 'object') {
      const clean = cleanCustomSections(storedSections.sections);
      if (clean && clean.length) {
        out.sections = { sections: clean };
      }
      if (storedSections.names && typeof storedSections.names.collections === 'string' && storedSections.names.collections.trim()) {
        out.colsName = storedSections.names.collections.trim().slice(0, 40);
      }
    }
  } catch (error) {}
  try {
    const stored = JSON.parse(localStorage.getItem('notely-collections') || 'null');
    if (Array.isArray(stored)) {
      const cols = stored.filter((name) => typeof name === 'string' && name.trim()).slice(0, 200);
      if (cols.length) out.cols = cols;
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
  if (legacy.collapsed) { collapsedFolders = new Set(legacy.collapsed); adopted = true; }
  if (legacy.sections) {
    customSections = legacy.sections.sections;
    adopted = true;
  }
  if (legacy.cols || legacy.colsName) {
    try { ensureMigratedCollectionsSection(legacy.cols || [], legacy.colsName || null); adopted = true; } catch (error) {}
  }
  if (adopted) {
    persistUiVault();
    try { persistNotes(); } catch (error) {}
  }
  return adopted;
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
// Permanently drop notes/sections past the 3-day retention; repairs tampered timestamps; drops section entries with no binned notes left.
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
  const sectionsBefore = (deletedCustomSections || []).length;
  deletedCustomSections = (deletedCustomSections || []).filter((entry) => (
    now - entry.deletedAt <= BIN_RETENTION_MS
    && notes.some((note) => note.deleted && note.sections
      && typeof note.sections === 'object' && customNoteFolder(note, entry.id) !== null)
  ));
  if (deletedCustomSections.length !== sectionsBefore) changed = true;
  if (changed) {
    persistDeletedCustomSections();
    persistNotes();
  }
  return changed;
}
purgeExpiredBin();

let currentId = null;
let activeView = 'notes';
let activeFilter = 'all';
let activeCustom = null; // { section: id, folder: path | null } | null — section/folder filter
let searchQuery = '';
let saveTimer;
// Persist collapsed tree-folder state into the encrypted UI vault.
function persistCollapsedFolders() {
  persistUiVault();
}
// ---- Sidebar sections & Bin: folder CRUD, sidebar render, sync with note data ----

// Rewrite exact + descendant paths in a folder list (sidebar, collapsed keys).
function repathList(list, oldPath, newPath) {
  const prefix = `${oldPath}${FOLDER_SEP}`;
  return list.map((entry) => {
    if (entry === oldPath) return newPath;
    if (entry.startsWith(prefix)) return newPath + entry.slice(oldPath.length);
    return entry;
  });
}

// Revive binned custom sections a (newly live) note belongs to, so it has
// a home. Custom folders inside live sections are re-adopted by the
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
// Erase a binned folder and all its binned notes at once; repairs the current selection.
// Find a sidebar row by exact dataset value (avoids CSS-escaping pitfalls of quoted selectors).
// Find an All-Notes folder group by exact dataset value (avoids CSS-escaping pitfalls).
function findTreeWrap(folder) {
  return [...noteList.querySelectorAll('[data-folder-wrap]')].find((wrap) => wrap.dataset.folderWrap === folder) || null;
}

// Inline sidebar rename: swaps the label for an input; Enter commits, Escape cancels, blur commits.
// Create a uniquely-named folder, reset view/filters, and immediately open inline rename.
// Delegated sidebar clicks (rename/delete/select) plus double-click to rename. Delegation survives innerHTML re-renders.
// Recipes section removed.

// Delete every folder in a built-in section and hide the section header;
// notes keep everything else. Restore via Settings → Side Menu.
// (Custom sections have deleteCustomSection; single folders use their own confirms.)
function bindSectionHeaderEvents() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('button') || event.target.closest('input')) return;
    const label = event.target.closest('.section-label-text');
    if (!label) return;
    const section = label.closest('.sidebar-section');
    if (!section) return;
    event.preventDefault();
    if (section.dataset.customSection) {
      if (!isSectionEmpty('custom', section.dataset.customSection)) selectCustomSection(section.dataset.customSection);
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
  // Same value as removed Collections had: fixed brand colors for defaults.
  const known = { Work: 'coral', Personal: 'yellow', 'Reading list': 'blue' };
  if (known[name]) return known[name];
  const index = section.folders.findIndex((entry) => entry === name);
  if (index >= 0) return COLLECTION_COLORS[(index + 4) % COLLECTION_COLORS.length];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return COLLECTION_COLORS[Math.abs(hash) % COLLECTION_COLORS.length];
}

// Paint section headers (all sections share the same custom implementation).
function updateSectionHeaders() {
  document.querySelectorAll('#custom-sections .sidebar-section').forEach((wrap) => {
    const id = wrap.dataset.customSection;
    wrap.classList.toggle('active-section', Boolean(activeCustom && !activeCustom.folder && activeCustom.section === id));
    wrap.classList.toggle('is-empty', isSectionEmpty('custom', id));
  });
}

// A sidebar section header filters the list — pointless when the section
// holds nothing, so empty sections are unclickable (rename still works).
function isSectionEmpty(kind, id) {
  const sectionId = kind === 'custom' ? id : kind;
  const section = customSections.find((entry) => entry.id === sectionId);
  if (section) return !section.folders.length;
  return true;
}

// All taken section display names (lowercased), optionally skipping one entry.
function takenSectionNames(exceptId) {
  const names = [];
  customSections.forEach((section) => {
    if (!(exceptId && exceptId === section.id)) names.push(section.name);
  });
  return names.map((name) => name.toLowerCase());
}

function uniqueSectionName() {
  const taken = new Set(takenSectionNames(null));
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
  activeCustom = null;
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
  showToast('Section added — name it');
  startSectionRename({ kind: 'custom', id: section.id });
}

// Inline rename for a section header (built-in or custom); Enter commits.
function startSectionRename(target) {
  renderCustomSections();
  let label = null;
  if (target.kind === 'custom') {
    const wrap = [...document.querySelectorAll('#custom-sections [data-custom-section]')]
      .find((el) => el.dataset.customSection === target.id);
    label = wrap ? wrap.querySelector('.section-label-text') : null;
  }
  if (!label) return;
  // The label is hidden (not replaced): built-in headers are static markup
  // that no render rebuilds, so removing it would lose the label forever.
  // A second double-click while open just refocuses the pending input.
  const pending = label.parentElement ? label.parentElement.querySelector('.section-rename-input') : null;
  if (pending) { pending.focus(); pending.select(); return; }
  const input = document.createElement('input');
  input.className = 'section-rename-input';
  input.value = (customSections.find((section) => section.id === target.id) || {}).name || '';
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
    if (commit) renameSectionDisplay(target.id, input.value);
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

// Validate and apply a section display-name edit (all sections share the same implementation).
function renameSectionDisplay(id, rawNewName) {
  const newName = String(rawNewName == null ? '' : rawNewName).replace(/[\x00-\x1F<>"]/g, '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!newName) { renderCustomSections(); renderNoteList(); return false; }
  const section = customSections.find((entry) => entry.id === id);
  if (!section) { renderCustomSections(); renderNoteList(); return false; }
  const current = section.name || '';
  if (newName === current) { renderCustomSections(); renderNoteList(); return true; }
  if (takenSectionNames(id).includes(newName.toLowerCase())) {
    showToast('A section with that name already exists');
    renderCustomSections(); renderNoteList();
    return false;
  }
  section.name = newName;
  persistCustomSections();
  updateListHeading();
  renderCustomSections();
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
  renderCustomSections();
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
  activeCustom = null;
  activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCustomSections();
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
  // Keep collapsed state following the rename (same value as Collections had).
  if (collapsedFolders.size) {
    const oldPrefix = `${oldName}${FOLDER_SEP}`;
    const next = new Set();
    collapsedFolders.forEach((entry) => {
      next.add(entry === oldName ? newName : (entry.startsWith(oldPrefix) ? newName + entry.slice(oldName.length) : entry));
    });
    collapsedFolders = next;
    persistCollapsedFolders();
  }
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
// the target carries its section so folders stay separate.
let folderMenuTarget = null; // { ns: 'custom', path, section }

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
  if (!menu || !path || !sectionId) return;
  folderMenuTarget = { ns: 'custom', path, section: sectionId };
  menu.querySelectorAll('[data-folder-action]').forEach((btn) => {
    const actionName = btn.dataset.folderAction;
    btn.hidden = actionName === 'restore';
  });
  const deleteLabel = document.getElementById('folder-delete-label');
  if (deleteLabel) deleteLabel.textContent = 'Delete';
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
  const { path, section: sectionId } = resolved;
  if (action === 'open') {
    selectCustomFolder(sectionId, path);
  } else if (action === 'rename') {
    startCustomFolderRename(sectionId, path);
  } else if (action === 'subfolder') {
    createSubfolder('custom', path, sectionId);
  } else if (action === 'restore') {
    return;
  } else if (action === 'delete') {
    openCustomFolderDeleteConfirm(sectionId, path);
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
// it. Without a parent, a top-level folder is created.
function createSubfolder(ns, parentPath, sectionId) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  if (true) {
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
}

function bindFolderContextMenu() {
  const menu = getFolderContextMenu();
  if (!menu) return;
  if (noteList) noteList.addEventListener('contextmenu', (event) => {
    const row = event.target.closest('.tree-folder-row');
    if (!row || event.target.closest('.tree-rename-input')) return;
    const wrap = row.closest('[data-folder-wrap]');
    if (!wrap) return;
    event.preventDefault();
    event.stopPropagation();
    // Resolve the row's namespace so "New subfolder" becomes a child of the
    // right-clicked folder: the active custom filter wins, otherwise
    // the enclosing list-section shell (home view shows all namespaces).
    const shell = wrap.closest('[data-list-section]');
    const shellKind = shell ? shell.dataset.listSection : null;
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
    // Unknown shell: no folder menu.
    return;
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
// inside it (top/bottom quarter = before/after, middle = nest). Unified custom
// sections implementation (same value for all new sections); reparenting
// reuses the rename functions so notes, collapse state and selection follow.
function folderListOf(ns, sectionId) {
  const section = customSections.find((entry) => entry.id === sectionId);
  return section ? section.folders : null;
}

function persistFolderList(ns) {
  persistCustomSections();
}

function renameFolderPath(ns, sectionId, oldPath, newPath, opts) {
  return renameCustomFolder(sectionId, oldPath, newPath, opts);
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
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section) return false;
  section.folders = reordered;
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
    const target = sidebarFolderTarget(event);
    if (!target || target.ns !== dragged.ns || target.section !== dragged.section) return;
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
      const section = customSections.find((entry) => entry.id === dragged.section);
      if (section) section.folders = reordered;
      persistFolderList(dragged.ns);
      renderCustomSections();
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
        renderCustomSections();
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

// First folder filing of a note across sections, or null when unfiled.
// ---- Note list: filtering, grouping, counts, tree rendering ----

function firstFilingOf(note) {
  if (note && note.sections && typeof note.sections === 'object') {
    const first = Object.values(note.sections).find((value) => typeof value === 'string' && value);
    if (first) return first;
  }
  return null;
}

// True when a note has no folder filing in any section.
function isUnfiled(note) {
  if (!note || !note.sections || typeof note.sections !== 'object') return true;
  return !Object.values(note.sections).some((value) => typeof value === 'string' && value);
}

// ---- Nested folders: a folder path is segments joined with FOLDER_SEP
// ("Work / Projects"). All folder namespaces share
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
  else if (activeCustom) listHeading.textContent = `${activeCustom.folder ? folderLeaf(activeCustom.folder) : sectionDisplayName('custom', activeCustom.section)}${suffix}`;
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
  const activeFolderPath = (activeCustom ? activeCustom.folder : null);
  const activeFolder = activeFolderPath
    || (activeCustom ? sectionDisplayName('custom', activeCustom.section) : null);
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
  clearSectionSelection();
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
  renderCustomSections();
  renderNoteList();
}

document.getElementById('breadcrumbs').addEventListener('click', (event) => {
  const crumb = event.target.closest('[data-crumb]');
  if (!crumb) return;
  event.preventDefault();
  if (crumb.dataset.crumb === 'root') goAllNotes();
  else if (crumb.dataset.crumb === 'folder') {
    if (activeCustom && activeCustom.folder) selectCustomFolder(activeCustom.section, activeCustom.folder);
    else if (activeCustom) selectCustomSection(activeCustom.section);
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
    const matchesCustom = !activeCustom || (customNoteFolder(note, activeCustom.section) !== null
      && (!activeCustom.folder || isFolderOrSub(customNoteFolder(note, activeCustom.section), activeCustom.folder)));
    return matchesSearch && matchesFilter && matchesCustom;
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

// Swap the writing area between Markdown source and rendered preview; non-Markdown notes never preview.
function renderPreview(note) {
  const bottomHint = document.querySelector('.editor-bottom span:first-child');
  const isMd = note.ext === 'md';
  const plainLabel = note.ext === 'txt' ? 'Plain text' : (EXT_LABELS[note.ext] || 'MD');
  const showPreview = isMd && writeMode === 'preview';
  if (showPreview) preview.innerHTML = renderMarkdown(note.body);
  markdownInput.hidden = showPreview;
  preview.hidden = !showPreview;
  if (modeLabel) modeLabel.textContent = isMd ? (showPreview ? 'Preview' : 'Write') : plainLabel;
  if (idleHint) idleHint.textContent = isMd ? 'Markdown source · live preview after 10s idle' : `${plainLabel} file — no preview`;
  if (modeToggle) {
    modeToggle.hidden = !isMd;
    modeToggle.textContent = showPreview ? 'Write' : 'Preview';
  }
  if (bottomHint) bottomHint.textContent = isMd ? 'Markdown · auto-preview after 10s idle' : `${plainLabel} file (.${note.ext})`;
  if (typeBadge) typeBadge.textContent = EXT_LABELS[note.ext] || 'MD';
  if (editorToolbar) editorToolbar.classList.toggle('is-plain', !isMd);
  if (!showPreview) autogrow();
}

// ---- Note cover pictures ------------------------------------------------
// Covers ride on the note (inside the E2EE envelope) as validated data URLs.
function coverFocalPos(note) {
  if (note && typeof note.coverPos === 'number' && Number.isFinite(note.coverPos)) {
    return Math.min(100, Math.max(0, note.coverPos));
  }
  return 50;
}

// The Add-cover row lives under the topbar line; hiding the button must
// hide the row too, or its margin leaves a gap.
function setCoverAddHidden(hide) {
  const addBtn = document.getElementById('cover-add');
  if (addBtn) addBtn.hidden = hide;
  const row = document.querySelector('.cover-add-row');
  if (row) row.style.display = hide ? 'none' : '';
}

// Paint the cover banner for the open note (null hides it). The src is
// re-validated on every render and assigned as a property, never via HTML.
function renderCover(note) {
  const wrap = document.getElementById('cover-wrap');
  const img = document.getElementById('cover-img');
  const addBtn = document.getElementById('cover-add');
  if (!wrap || !img) return;
  const usable = note && activeView !== 'vault' ? cleanCoverSrc(note.cover) : null;
  const heading = document.querySelector('.editor-heading');
  if (heading) heading.classList.toggle('has-cover', Boolean(usable));
  if (usable) {
    if (img.getAttribute('src') !== usable) img.setAttribute('src', usable);
    img.style.objectPosition = `50% ${coverFocalPos(note)}%`;
    wrap.hidden = false;
    if (addBtn) setCoverAddHidden(true);
  } else {
    wrap.hidden = true;
    img.removeAttribute('src');
    if (addBtn) {
      const editable = Boolean(note) && activeView !== 'vault' && isUnlocked()
        && !note.deleted && !note.archived;
      setCoverAddHidden(!editable);
    }
  }
}

function requestCoverUpload() {
  exitCoverRepos(true);
  const note = currentNote();
  if (activeView === 'vault') return;
  if (!note) { showToast('Open a note first'); return; }
  if (!isUnlocked()) { showToast('Log in to edit notes'); return; }
  if (note.deleted) { showToast('Restore this note to edit it'); return; }
  if (note.archived) { showToast('Unarchive this note to edit it'); return; }
  const input = document.getElementById('cover-input');
  if (input) { input.value = ''; input.click(); }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

// Downscale to a JPEG banner (max 1200px side, quality 0.82).
function downscaleCover(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('decode'));
    img.onload = () => {
      try {
        const naturalW = img.naturalWidth || 800;
        const naturalH = img.naturalHeight || 600;
        const scale = Math.min(1, COVER_MAX_DIM / Math.max(naturalW, naturalH));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(naturalW * scale));
        canvas.height = Math.max(1, Math.round(naturalH * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas')); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('encode')); return; }
          readFileAsDataUrl(blob).then(resolve, reject);
        }, 'image/jpeg', 0.82);
      } catch (error) { reject(error); }
    };
    img.src = dataUrl;
  });
}

async function handleCoverFile(file) {
  const note = currentNote();
  if (!note || activeView === 'vault' || !isUnlocked() || note.deleted || note.archived) return;
  if (!file) return;
  if (!isImageFile(file)) { showToast('Use a PNG, JPEG, WebP, GIF, AVIF or BMP image'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('Image too large (5 MB max)'); return; }
  const wasOptimized = file.size > 300000;
  showToast('Loading picture…');
  try {
    const raw = await readFileAsDataUrl(file);
    const dataUrl = wasOptimized ? await downscaleCover(raw) : raw;
    const clean = cleanCoverSrc(dataUrl) || (!wasOptimized ? await downscaleCover(raw).then(cleanCoverSrc) : null);
    if (!clean) { showToast('Could not use that image — try a smaller file'); return; }
    if (!currentNote() || currentNote().id !== note.id) return; // moved on mid-upload
    note.cover = clean;
    if (typeof note.coverPos !== 'number' || !Number.isFinite(note.coverPos)) note.coverPos = 50;
    note.date = 'Now';
    renderCover(note);
    persistNotes();
    showToast(wasOptimized ? 'Cover added (optimized) — Reposition to adjust' : 'Cover added — Reposition to adjust');
  } catch (error) {
    showToast('Could not read that image');
  }
}

// Drag the banner on the note itself to reposition the cover (Notion-style).
// Repositioning is a locked mode: Reposition unlocks, Done saves + locks.
let coverDragging = false;
let coverRepositioning = false;
let coverReposStart = 50;

function canEditCoverNote() {
  const note = currentNote();
  if (!note || activeView === 'vault' || !isUnlocked() || note.deleted || note.archived) return null;
  if (!cleanCoverSrc(note.cover)) return null;
  return note;
}

function setCoverReposUI() {
  const wrap = document.getElementById('cover-wrap');
  const badge = document.getElementById('cover-pos');
  const reposBtn = document.getElementById('cover-repos');
  const doneBtn = document.getElementById('cover-done');
  const changeBtn = document.getElementById('cover-change');
  const removeBtn = document.getElementById('cover-remove');
  if (wrap) wrap.classList.toggle('repositioning', coverRepositioning);
  if (reposBtn) reposBtn.hidden = coverRepositioning;
  if (doneBtn) doneBtn.hidden = !coverRepositioning;
  if (changeBtn) changeBtn.hidden = coverRepositioning;
  if (removeBtn) removeBtn.hidden = coverRepositioning;
  if (badge) {
    if (coverRepositioning) {
      const note = currentNote();
      badge.hidden = false;
      badge.textContent = `${note ? coverFocalPos(note) : 50}%`;
    } else {
      badge.hidden = true;
    }
  }
}

function enterCoverRepos() {
  const note = canEditCoverNote();
  if (!note || coverRepositioning) return;
  coverRepositioning = true;
  coverReposStart = coverFocalPos(note);
  setCoverReposUI();
  showToast('Drag the cover to reposition — Done to lock');
}

// Leave reposition mode; save persists the staged position, cancel restores it.
function exitCoverRepos(save) {
  if (!coverRepositioning) return;
  coverRepositioning = false;
  coverDragging = false;
  const wrap = document.getElementById('cover-wrap');
  if (wrap) wrap.classList.remove('dragging');
  const note = currentNote();
  if (save && note && note.cover) {
    note.date = 'Now';
    if (currentId === note.id) renderCover(note);
    persistNotes();
    showToast('Cover position locked');
  } else if (!save && note && note.cover) {
    note.coverPos = coverReposStart;
    if (currentId === note.id) renderCover(note);
  }
  setCoverReposUI();
}

function coverDragNote() {
  if (!coverRepositioning) return null;
  return canEditCoverNote();
}

function moveCoverOnNote(clientY) {
  const note = coverDragNote();
  const wrap = document.getElementById('cover-wrap');
  const badge = document.getElementById('cover-pos');
  if (!note || !wrap) return;
  const rect = wrap.getBoundingClientRect();
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  note.coverPos = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  const img = document.getElementById('cover-img');
  if (img) img.style.objectPosition = `50% ${note.coverPos}%`;
  if (badge) {
    badge.hidden = false;
    badge.textContent = `${note.coverPos}%`;
  }
}

function endCoverDrag() {
  if (!coverDragging) return;
  coverDragging = false;
  const wrap = document.getElementById('cover-wrap');
  if (wrap) wrap.classList.remove('dragging');
}

function removeCover() {
  exitCoverRepos(false);
  const note = currentNote();
  if (!note || activeView === 'vault' || !isUnlocked() || note.deleted || note.archived) return;
  if (!note.cover) return;
  note.cover = null;
  note.coverPos = null;
  note.date = 'Now';
  renderCover(note);
  persistNotes();
  showToast('Cover removed');
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

// Inline rename for All-Notes folder headers; refused in Bin.
function startTreeRename(folder) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  if (activeView === 'bin') return;
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
      // Namespace follows the row; fall back to whichever custom section owns the folder.
      let sectionId = null;
      if (activeCustom) sectionId = activeCustom.section;
      else {
        const shell = wrap.closest('[data-list-section]');
        const kind = shell ? shell.dataset.listSection : null;
        if (kind === 'custom') {
          const secBtn = shell.querySelector('[data-section-id]');
          if (secBtn && secBtn.dataset.sectionId) sectionId = secBtn.dataset.sectionId;
        }
      }
      if (!sectionId) {
        const owner = customSections.find((section) => section.folders.some((entry) => entry === folder || isFolderOrSub(entry, folder) || isFolderOrSub(folder, entry)));
        if (owner) sectionId = owner.id;
      }
      if (!sectionId) { renderNoteList(); return; }
      renameFolderPath('custom', sectionId, folder, joinLeafRename(folder, input.value));
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
  // Adopt the target's folder when inside a specific folder view (same section only).
  if (activeCustom && activeCustom.folder) {
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

function dropNoteOnFolder(draggedId, folder, sectionId) {
  const index = notes.findIndex((note) => note.id === draggedId);
  if (index === -1 || typeof folder !== 'string') return;
  const [moved] = notes.splice(index, 1);
  // Resolve target section: explicit sectionId wins, else active custom section.
  const targetSection = sectionId || (activeCustom ? activeCustom.section : null);
  if (!moved.sections || typeof moved.sections !== 'object') moved.sections = {};
  if (targetSection) {
    moved.sections[targetSection] = folder;
  } else {
    // No section context (should not happen in unified UI): keep filing unchanged.
    notes.splice(index, 0, moved);
    persistNotes();
    renderNoteList();
    return;
  }
  // Append after the folder's last note in global order (empty folders: end).
  const keyOf = (note) => {
    if (targetSection) return customNoteFolder(note, targetSection);
    if (activeCustom) return customNoteFolder(note, activeCustom.section);
    return firstFilingOf(note);
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
      const wrap = header.closest('[data-folder-wrap]');
      const shell = header.closest('[data-list-section]');
      const shellKind = shell ? shell.dataset.listSection : null;
      let sectionId = activeCustom ? activeCustom.section : null;
      if (shellKind === 'custom') {
        const secBtn = shell.querySelector('[data-section-id]');
        if (secBtn && secBtn.dataset.sectionId) sectionId = secBtn.dataset.sectionId;
      }
      // Resolve section from wrap when possible (flat view has no shell context).
      if (!sectionId && wrap) {
        const folder = wrap.dataset.folderWrap;
        const owner = customSections.find((section) => section.folders.some((entry) => entry === folder || isFolderOrSub(folder, entry) || isFolderOrSub(entry, folder)));
        if (owner) sectionId = owner.id;
      }
      dropNoteOnFolder(event.dataTransfer.getData('text/plain'), header.dataset.folder, sectionId);
    });
  });
}

// Render the grouped note tree: folder ordering, collapse, Bin actions vs rename pencil, scoped counters, and per-row event wiring.
function renderNoteList() {
  if (activeView === 'vault') { renderVaultList(); return; }
  const visible = visibleNotes();
  const searching = searchQuery.trim() !== '';
  // Grouping follows the active folder namespace: custom-section paths when one
  // of those is selected, otherwise each note's first filing (unfiled notes
  // render as plain rows without a folder header).
  const groupKeyOfNote = (note) => {
    if (activeCustom) return customNoteFolder(note, activeCustom.section);
    return firstFilingOf(note);
  };
  const groups = new Map();
  const unfiledNotes = [];
  visible.forEach((note) => {
    const folder = groupKeyOfNote(note);
    if (folder == null) { unfiledNotes.push(note); return; }
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push(note);
  });
  // One bare note row (same markup as folder-grouped rows, minus the folder).
  const renderBareNoteRow = (note) => `
        <button class="tree-file${note.id === currentId ? ' selected' : ''}" data-note-id="${escapeHtml(String(note.id))}" title="${escapeHtml(note.title || 'Untitled note')}">
          <span class="tree-file-icon tree-file-icon-${note.ext}">${icon(note.ext === 'md' ? 'file' : 'file-text')}</span>
          <span class="tree-file-name">${escapeHtml(note.title || 'Untitled note')}</span>
          ${activeView === 'bin' ? `<span class="bin-meta">${binRemainingText(note)}</span>` : ''}
          ${note.favorite && activeView !== 'bin' ? `<span class="mini-star">${icon('star')}</span>` : ''}
        </button>`;
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
    const folderActions = activeView === 'bin'
      ? ''
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
          <span class="tree-file-icon tree-file-icon-${note.ext}">${icon(note.ext === 'md' ? 'file' : 'file-text')}</span>
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
    && !(activeCustom && activeCustom.folder);
  if (homeLike) {
    const parts = [];
    const customTargets = activeCustom && !activeCustom.folder
      ? customSections.filter((section) => section.id === activeCustom.section)
      : ((!activeCustom) ? customSections : []);
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
    // Notes without a folder filing stay visible as plain rows.
    if (!activeCustom) {
      const unfiled = visible.filter((note) => isUnfiled(note));
      if (unfiled.length) parts.push(unfiled.map(renderBareNoteRow).join(''));
    }
    noteList.innerHTML = parts.join('');
  } else {
    noteList.innerHTML = renderFolderGroups(groups) + unfiledNotes.map(renderBareNoteRow).join('');
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
  const activeContextName = (activeCustom ? (activeCustom.folder || sectionDisplayName('custom', activeCustom.section)) : null);
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
  noteList.querySelectorAll('.tree-folder-name').forEach((item) => item.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (activeView === 'bin') return;
    const wrap = item.closest('[data-folder-wrap]');
    if (!wrap) return;
    startTreeRename(wrap.dataset.folderWrap);
  }));
  noteList.querySelectorAll('[data-section-jump]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    const kind = item.dataset.sectionJump;
    const id = item.dataset.sectionId || null;
    if (kind === 'custom' && id) selectCustomSection(id);
  }));
  const renameSectionFromList = (kind, id) => {
    if (kind === 'custom' && id) startSectionRename({ kind: 'custom', id });
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
  exitCoverRepos(true);
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
  renderCover(note);
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

// Download one note with a sanitized filename and matching MIME type.
function downloadNoteObject(note) {
  if (!note) return;
  const body = typeof note.body === 'string' ? note.body : '';
  const blob = new Blob([body], { type: EXT_MIME[note.ext] || 'text/markdown' });
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
  exitCoverRepos(true);
  currentId = null;
  currentVaultId = null;
  titleInput.value = '';
  titleInput.disabled = false;
  markdownInput.value = '';
  markdownInput.disabled = false;
  breadcrumbTitle.textContent = 'No notes';
  if (wordCount) wordCount.textContent = '0 words';
  if (tagList) tagList.innerHTML = '';
  renderCover(null);
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
  // Revive a binned custom section the note belongs to, so it has a home.
  // Custom folders inside live sections are re-adopted by the sync below.
  reviveSectionsForNote(note);
  syncCustomSections();
  persistNotes();
  renderCustomSections();
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
  syncCustomSections();
  persistNotes();
  renderCustomSections();
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
  else if (mode === 'vault-note') deleteVaultNote(id);
  else if (mode === 'custom-section') deleteCustomSection(id);
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
    new TextEncoder().encode(    JSON.stringify({
      id: note.id, title: note.title, body: note.body,
      tags: Array.isArray(note.tags) ? note.tags : [],
      ext: normalizeExt(note.ext),
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
    ext: normalizeExt(obj.ext),
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
  exitCoverRepos(true);
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
  renderCover(null); // vault notes have no covers; clear any stale banner
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
  activeCustom = null;
  activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'vault'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCustomSections();
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
// reset-confirm reuses the masked unlock password field for the LOGIN
// password proof (no window.prompt plaintext shoulder-surfing).
function setVaultModal(mode, message) {
  vaultModalMode = mode;
  document.getElementById('vault-title').textContent = mode === 'setup' ? 'Set Vault Password' : mode === 'reset-confirm' ? 'Reset Vault?' : 'Unlock Vault';
  document.getElementById('vault-desc').textContent = mode === 'setup'
    ? 'Choose a password just for your vault. It is separate from your login and cannot be recovered.'
    : mode === 'reset-confirm'
      ? 'Enter your LOGIN password to confirm. This permanently deletes every note inside the vault. This cannot be undone.'
      : 'Enter your vault password to reveal your secret notes.';
  document.getElementById('vault-setup-block').hidden = mode !== 'setup';
  document.getElementById('vault-unlock-block').hidden = (mode !== 'unlock' && mode !== 'reset-confirm');
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
  // Re-auth fix: stolen cookie alone cannot wipe the vault. Read the LOGIN
  // password from the masked modal field (shown in reset-confirm mode),
  // derive the account verifier, and send as proof.
  let proof = null;
  try {
    const input = document.getElementById('vault-password');
    const pwd = String((input && input.value) || '');
    if (!pwd) { vaultFail('Enter your login password to confirm reset.'); return; }
    if (!e2ee.saltAuth) { vaultFail('Log in again, then retry reset.'); return; }
    const saltBytes = (e2ee.saltAuth instanceof Uint8Array) ? e2ee.saltAuth : e2eeB64ToBytes(e2ee.saltAuth);
    const raw = await argon2id32(pwd, saltBytes);
    proof = e2eeBytesToB64(raw);
  } catch (error) {
    vaultFail('Could not confirm password.');
    return;
  }
  try {
    const response = await apiFetch('/api/vault-meta', { method: 'DELETE', body: JSON.stringify({ currentAccountAuth: proof }) });
    if (response.status === 401) {
      vaultFail('Incorrect login password — vault not reset.');
      return;
    }
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

// Detect a trailing file extension typed in the title and switch the note type instead.
function parseTitleExtension(rawTitle, note) {
  const input = typeof rawTitle === 'string' ? rawTitle : 'Untitled note';
  const match = input.match(/\.((md|markdown|txt|text|json|yaml|yml))$/i);
  if (match) {
    note.ext = normalizeExt(match[1]);
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

// Create a note from a template (Standard/Recipe/To-Do) into the current view+collection and open it.
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
  const customSection = activeCustom ? customSections.find((entry) => entry.id === activeCustom.section) : null;
  // No active folder context (e.g. All notes): inherit filing from the open
  // note so the new note lands next to it instead of staying unfiled.
  // Only live locations count — binned/deleted/removed folders are skipped.
  const inheritSections = {};
  if (!activeCustom && currentId) {
    const openNote = notes.find((entry) => entry.id === currentId);
    if (openNote) {
      if (openNote.sections && typeof openNote.sections === 'object') {
        for (const secId of Object.keys(openNote.sections)) {
          const folder = openNote.sections[secId];
          if (typeof folder !== 'string' || !folder) continue;
          const sec = customSections.find((entry) => entry.id === secId);
          if (sec && sec.folders.includes(folder)) inheritSections[secId] = folder;
        }
      }
    }
  }
  const customFolder = pickedCustom
    || (activeCustom && activeCustom.folder)
    || (customSection && customSection.folders.length ? customSection.folders[0] : null);
  const filedSections = (activeCustom && customFolder) ? { [activeCustom.section]: customFolder } : inheritSections;
  const note = { id, title, date: 'Now', tags, favorite: false, archived: false, deleted: false, ext: normalizeExt(template.ext), sections: filedSections, body: template.body(title) };
  notes.unshift(note);
  activeFilter = 'all';
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  // A stale search query must never swallow the brand-new note.
  clearSearch();
  currentId = id;
  selectNote(id);
  // Mirror the new filing in the workspace sidebar immediately.
  renderCustomSections();
  markdownInput.focus();
  markdownInput.setSelectionRange(markdownInput.value.length, markdownInput.value.length);
  persistNotes();
  // Confirm where it landed: if the current view filters it out, name the
  // destination so the note is findable instead of seemingly lost.
  const shown = visibleNotes().some((entry) => entry.id === id);
  const sectionValues = Object.values(note.sections || {}).filter((value) => typeof value === 'string' && value);
  const dest = customFolder || sectionValues[0] || 'All notes';
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
let pendingSectionFolder = null; // { ns: 'custom', section: id, folder } | null

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
    return false;
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

// True when the open note is not Markdown (formatting tools stay disabled).
function isPlainTextNote() {
  const note = activeEditorNote();
  return note && note.ext !== 'md';
}

// Wrap the editor selection (or placeholder word) with a Markdown marker and save.
function wrapSelection(before, after = before) {
  if (!cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
  if (isPlainTextNote()) { showToast('Formatting needs a Markdown note'); return; }
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
  if (isPlainTextNote()) { showToast('Formatting needs a Markdown note'); return; }
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
document.querySelectorAll('#template-overlay .template-option').forEach((option) => option.addEventListener('click', () => {
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

// Display name of a sidebar section (all sections share the custom implementation).
function sectionDisplayName(kind, id) {
  const sectionId = kind === 'custom' ? id : kind;
  const section = customSections.find((entry) => entry.id === sectionId);
  return section ? section.name : 'Section';
}

// Persist custom sections + section display names into the encrypted UI vault.
function persistCustomSections() {
  persistUiVault();
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
  activeCustom = { section: sectionId, folder: null };
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
}

function selectCustomFolder(sectionId, folder) {
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section || !section.folders.includes(folder)) return;
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  activeView = 'notes';
  activeFilter = 'all';
  activeCustom = { section: sectionId, folder };
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
}

// Clear section/folder filters and sidebar highlights (unified custom implementation).
function clearSectionSelection() {
  activeCustom = null;
  document.querySelectorAll('#custom-sections .collection-item').forEach((item) => item.classList.remove('active'));
}

document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', (event) => {
  event.preventDefault();
  const view = item.dataset.view;
  if (typeof view !== 'string' || !/^(notes|favorites|archive|bin|vault)$/.test(view)) return;
  if (view === 'vault' && !vault.unlocked) { openVaultModal(); return; }
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav === item));
  clearSectionSelection();
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

preview.addEventListener('click', () => {
  if (writeMode === 'preview') setWriteMode('edit', { focus: true });
});
preview.addEventListener('focus', () => {
  if (writeMode === 'preview') setWriteMode('edit', { focus: true });
});
if (modeToggle) modeToggle.addEventListener('click', () => {
  const note = activeEditorNote();
  if (!note || note.ext !== 'md') return;
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
  const order = ['md', 'txt', 'json', 'yaml'];
  note.ext = order[(order.indexOf(note.ext) + 1) % order.length];
  writeMode = 'edit';
  clearTimeout(idleTimer);
  renderPreview(note);
  resetIdleTimer();
  persistNotes();
  renderNoteList();
  const typeNames = { md: 'Markdown (.md)', txt: 'plain text (.txt)', json: 'JSON (.json)', yaml: 'YAML (.yaml)' };
  showToast(`Switched to ${typeNames[note.ext]}`);
});

document.getElementById('import-notes').addEventListener('click', () => importInput.click());
document.getElementById('cover-add').addEventListener('click', requestCoverUpload);
document.getElementById('cover-change').addEventListener('click', requestCoverUpload);
document.getElementById('cover-remove').addEventListener('click', removeCover);
document.getElementById('cover-repos').addEventListener('click', enterCoverRepos);
document.getElementById('cover-done').addEventListener('click', () => exitCoverRepos(true));
document.getElementById('cover-input').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) handleCoverFile(file);
});
// Reposition by dragging the banner on the note itself (buttons opt out).
function coverDragStart(event, clientY) {
  if (event.target && event.target.closest && event.target.closest('button')) return;
  if (!coverDragNote()) return;
  coverDragging = true;
  const wrap = document.getElementById('cover-wrap');
  if (wrap) wrap.classList.add('dragging');
  moveCoverOnNote(clientY);
  event.preventDefault();
}
document.getElementById('cover-wrap').addEventListener('pointerdown', (event) => {
  if (event.button !== undefined && event.button !== 0) return;
  coverDragStart(event, event.clientY);
});
document.getElementById('cover-wrap').addEventListener('pointermove', (event) => {
  if (coverDragging) moveCoverOnNote(event.clientY);
});
document.getElementById('cover-wrap').addEventListener('pointerup', () => endCoverDrag());
document.getElementById('cover-wrap').addEventListener('pointercancel', () => endCoverDrag());
document.getElementById('cover-wrap').addEventListener('mousedown', (event) => {
  if (event.button !== 0) return;
  coverDragStart(event, event.clientY);
});
document.addEventListener('mousemove', (event) => {
  if (coverDragging) moveCoverOnNote(event.clientY);
});
document.addEventListener('mouseup', () => endCoverDrag());
const MAX_IMPORT_FILES = 20;
const MAX_IMPORT_BYTES_PER_FILE = 1024 * 1024;
const MAX_IMPORT_BYTES_TOTAL = 5 * 1024 * 1024;
importInput.addEventListener('change', async (event) => {
  const picked = [...(event.target.files || [])].filter((file) => /\.(md|markdown|txt|text|json|yaml|yml)$/i.test(file.name || ''));
  if (!picked.length) { showToast('Choose .md, .txt, .json or .yaml files to import'); return; }
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
      const ext = /\.json$/i.test(file.name) ? 'json'
        : (/\.(yaml|yml)$/i.test(file.name) ? 'yaml'
        : (/\.(txt|text)$/i.test(file.name) ? 'txt' : 'md'));
      const note = {
        id: newNoteId(),
        title: uniqueTitle(base),
        date: 'Now',
        tags: [],
        favorite: false,
        archived: false,
        deleted: false,
        ext,
        sections: (activeCustom && activeCustom.folder) ? { [activeCustom.section]: activeCustom.folder } : {},
        body: (text || (ext === 'md' ? `# ${base}\n` : '')).slice(0, 500000)
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
    syncCustomSections();
    renderCustomSections();
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
  serverNotesVersion = 0;
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
    localStorage.removeItem('notely-collections');
    localStorage.removeItem('notely-deleted-collections');
    localStorage.removeItem(COLLAPSED_FOLDERS_KEY);
    localStorage.removeItem(SECTION_DATA_KEY);
  } catch (error) {}
  collapsedFolders = new Set();
  customSections = [];
  deletedCustomSections = [];
  activeCustom = null;
  titleInput.value = '';
  markdownInput.value = '';
  breadcrumbTitle.textContent = 'No notes';
  if (wordCount) wordCount.textContent = '0 words';
  if (tagList) tagList.innerHTML = '';
  const passwordInput = document.getElementById('login-password');
  if (passwordInput) passwordInput.value = '';
  document.getElementById('sidebar').classList.remove('open');
  renderCustomSections();
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
  const isRecover = mode === 'recover';
  document.getElementById('login-form').hidden = isRegister || isRecover;
  document.getElementById('register-form').hidden = !isRegister;
  // Passkey / recovery helpers belong to signing in, never to registering.
  // Recovery mode shows only the recovery options (no password, login,
  // passkey or forgot-link chrome).
  const helpers = document.getElementById('login-helpers');
  if (helpers) helpers.hidden = isRegister;
  const passkeyBtn = document.getElementById('passkey-login-btn');
  if (passkeyBtn) passkeyBtn.hidden = isRecover;
  const linkWrap = document.getElementById('recover-link-wrap');
  if (linkWrap) linkWrap.hidden = isRecover;
  const block = document.getElementById('recover-block');
  if (block) block.hidden = !isRecover;
  const tabs = document.querySelector('.auth-tabs');
  if (tabs) tabs.hidden = isRecover;
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
  document.getElementById('login-title').textContent = isRecover ? 'Recover account' : isRegister ? 'Create account' : 'Log in';
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
      if (loginResponse.status === 202) {
        // MFA enrolled: password verifier passed, TOTP still required.
        // Unlock the vault now (keys already in 202 body), then prove TOTP
        // to mint the session cookie. Old non-MFA logins never hit this.
        data = await loginResponse.json();
        try {
          await e2eeUnlockWithPassword(username, password, {
            kdf: data.kdf || kdf.kdf || 'pbkdf2',
            saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
            iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
            encMasterKey: data.encMasterKey,
          });
        } catch (error) { done(); loginFail('Could not unlock notes with this password.'); return; }
        const ticket = data.mfaTicket;
        const codeInput = window.prompt('Enter your 6-digit authenticator code (or a recovery code XXXX-XXXX):');
        if (!codeInput) { e2eeLock(); done(); loginFail('MFA code required.'); return; }
        const trimmed = String(codeInput).trim();
        const challengeBody = trimmed.indexOf('-') >= 0
          ? { ticket, recoveryCode: trimmed.toUpperCase() }
          : { ticket, code: trimmed };
        const challenge = await apiFetch('/api/mfa/challenge', { method: 'POST', body: JSON.stringify(challengeBody) });
        if (!challenge.ok) { e2eeLock(); done(); loginFail('Incorrect MFA code.'); return; }
        data = await challenge.json();
        // data is the profile; keys already unlocked above from the 202 body.
        data.kdf = data.kdf || kdf.kdf;
        data.saltEnc = data.saltEnc || null;
        data.iterations = data.iterations || 0;
        data.encMasterKey = data.encMasterKey || null;
      } else {
        if (!loginResponse.ok) {
          done();
          if (loginResponse.status === 429) loginFail('Too many attempts — try again in a few minutes.');
          else loginFail();
          return;
        }
        data = await loginResponse.json();
        try {
          await e2eeUnlockWithPassword(username, password, {
            kdf: data.kdf || kdf.kdf || 'pbkdf2',
            saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
            iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
            encMasterKey: data.encMasterKey,
          });
        } catch (error) {
          // Email-reset rewrap: verifier is new but the wrapped key still
          // answers to the OLD password. Unlock with it once, then re-wrap
          // under the new password via the normal rotation endpoint.
          if (!pendingRewrap || !pendingRewrap.password) throw error;
          const oldPw = window.prompt('Enter your OLD password once to re-encrypt notes under the new one:');
          if (!oldPw) throw error;
          await e2eeUnlockWithPassword(username, oldPw, {
            kdf: data.kdf || kdf.kdf || 'pbkdf2',
            saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
            iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
            encMasterKey: data.encMasterKey,
          });
          const freshSaltAuth = e2eeRandomBytes(16);
          const freshSaltEnc = e2eeRandomBytes(16);
          const freshAuth = await argon2id32(pendingRewrap.password, freshSaltAuth);
          const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
          const freshWrap = await e2eeWrapMasterKeyArgon2id(pendingRewrap.password, freshSaltEnc, masterRaw);
          const curBits = await argon2id32(pendingRewrap.password, pendingRewrap.saltAuth);
          await apiFetch('/api/change-password', {
            method: 'POST',
            body: JSON.stringify({
              currentAuth: e2eeBytesToB64(curBits),
              kdf: 'argon2id',
              params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
              authHash: e2eeBytesToB64(freshAuth),
              saltAuth: e2eeBytesToB64(freshSaltAuth),
              saltEnc: e2eeBytesToB64(freshSaltEnc),
              encMasterKey: freshWrap,
            }),
          });
          e2ee.kdf = 'argon2id';
          e2ee.saltAuth = freshSaltAuth;
          e2ee.saltEnc = freshSaltEnc;
          e2ee.iterations = 0;
          pendingRewrap = null;
        }
      }
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
    cachedProfile = { username: data.username, firstName: data.firstName, lastName: data.lastName, subtitle: data.subtitle, email: data.email || '' };
    const errorEl = document.getElementById('login-error');
    if (errorEl) errorEl.hidden = true;
    passwordEl.value = '';
    hideLogin();
    applyProfile();
    // Fresh account context: never leak the previous login's sidebar into this one.
    serverUiLoaded = false;
    collapsedFolders = new Set();
    customSections = [];
    deletedCustomSections = [];
    activeCustom = null;
    await loadNotesFromServer();
    if (purgeExpiredBin()) persistNotes();
    await loadUiVault();
    try { ensureMigratedCollectionsSection([], null); } catch (error) {}
    syncCustomSections();
    // First login on a v1 row (or a device that knew more than the server):
    // push the merged sidebar up so the next relog/device sees it.
    if (!serverUiLoaded) {
      try { await writeUiVaultLocal(); } catch (error) {}
      persistNotes();
    }
    renderCustomSections();
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
  const email = String(document.getElementById('register-email').value || '').trim().slice(0, 254);
  const first = String(document.getElementById('register-first').value || '').trim().slice(0, 40);
  const last = String(document.getElementById('register-last').value || '').trim().slice(0, 40);
  const password = String(document.getElementById('register-password').value || '');
  const confirm = String(document.getElementById('register-confirm').value || '');
  const errorEl = document.getElementById('register-error');
  const fail = (msg) => { if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; } };
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { fail('Username must be 3-32 chars: letters, numbers, _ or -.'); return; }
  if (!/^[^@\s<>\"]+@[^@\s<>\"]+\.[^@\s<>\"]+$/.test(email)) { fail('A valid email address is required.'); return; }
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
    if (!await e2eeTrialUnwrapArgon2id(password, saltEncBytes, wrapped)) {
      fail('Key setup failed locally — not uploaded. Retry.');
      authBusy = false;
      return;
    }
    response = await apiFetch('/api/register', {
      method: 'POST',
      body: JSON.stringify({
        username,
        email,
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
// Passkey login (option-1): assertion replaces the password verifier for the
// session; the password is still asked locally afterwards to unwrap the E2EE
// master key and is never sent. Old password logins are untouched.
const passkeyLoginBtn = document.getElementById('passkey-login-btn');
if (passkeyLoginBtn) passkeyLoginBtn.addEventListener('click', async () => {
  const usernameEl = document.getElementById('login-username');
  const passwordEl = document.getElementById('login-password');
  const username = String(usernameEl.value || '').trim().slice(0, 32);
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { loginFail(); return; }
  if (authBusy) return;
  authBusy = true;
  try {
    if (!window.PublicKeyCredential) throw new Error('passkeys unsupported');
    const begin = await apiFetch('/api/passkey/login-begin', {
      method: 'POST', body: JSON.stringify({ username }),
    });
    const opts = await begin.json();
    if (!begin.ok) throw new Error(opts.error || 'No passkeys.');
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBuf(opts.challenge),
        rpId: opts.rpId,
        allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
        timeout: opts.timeout,
        userVerification: opts.userVerification,
      },
    });
    const finish = await apiFetch('/api/passkey/login-finish', {
      method: 'POST',
      body: JSON.stringify({
        username,
        id: cred.id,
        rawId: bufToB64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: bufToB64url(cred.response.clientDataJSON),
          authenticatorData: bufToB64url(cred.response.authenticatorData),
          signature: bufToB64url(cred.response.signature),
          userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
        },
      }),
    });
    let data;
    let passkeyKeys = null;
    if (finish.status === 202) {
      // MFA still required on top of passkey.
      data = await finish.json();
      passkeyKeys = {
        kdf: data.kdf, saltEnc: data.saltEnc,
        iterations: data.iterations, encMasterKey: data.encMasterKey,
      };
      const codeInput = window.prompt('Enter your 6-digit authenticator code (or recovery code XXXX-XXXX):');
      if (!codeInput) throw new Error('mfa required');
      const t = String(codeInput).trim();
      const ch = await apiFetch('/api/mfa/challenge', {
        method: 'POST',
        body: JSON.stringify(t.indexOf('-') >= 0
          ? { ticket: data.mfaTicket, recoveryCode: t.toUpperCase() }
          : { ticket: data.mfaTicket, code: t }),
      });
      if (!ch.ok) throw new Error('mfa failed');
      const profile = await ch.json();
      data = { ...profile, ...passkeyKeys };
    } else {
      if (!finish.ok) {
        const d = await finish.json().catch(() => ({}));
        throw new Error(d.error || 'Passkey failed.');
      }
      data = await finish.json();
    }
    // Unlock E2EE locally: password never leaves the device. Reuse typed
    // password if present, else ask once.
    let password = String(passwordEl.value || '');
    if (!password) {
      const asked = window.prompt('Enter your password to unlock notes on this device (stays local):');
      if (!asked) throw new Error('password required');
      password = asked;
    }
    const kdfR = await apiFetch(`/api/kdf-params?username=${encodeURIComponent(username)}`);
    const kdf = await kdfR.json();
    await e2eeUnlockWithPassword(username, password, {
      kdf: data.kdf || kdf.kdf || 'pbkdf2',
      saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
      iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
      encMasterKey: data.encMasterKey,
    });
    cachedProfile = { username: data.username, firstName: data.firstName, lastName: data.lastName, subtitle: data.subtitle, email: data.email || '' };
    passwordEl.value = '';
    hideLogin();
    applyProfile();
    serverUiLoaded = false;
    collapsedFolders = new Set();
    customSections = [];
    deletedCustomSections = [];
    activeCustom = null;
    await loadNotesFromServer();
    if (purgeExpiredBin()) persistNotes();
    await loadUiVault();
    try { ensureMigratedCollectionsSection([], null); } catch (error) {}
    syncCustomSections();
    if (!serverUiLoaded) {
      try { await writeUiVaultLocal(); } catch (error) {}
      persistNotes();
    }
    renderCustomSections();
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
    loginFail(error && error.message === 'mfa required' ? 'MFA code required.'
      : 'Cannot reach the Notely server. Is it running?');
  }
  authBusy = false;
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
// --- MFA settings (Two-Factor pane under Change Password) ---
async function refreshMfaStatus() {
  const statusEl = document.getElementById('mfa-status');
  const setupBtn = document.getElementById('mfa-setup-btn');
  const disableBtn = document.getElementById('mfa-disable-btn');
  const recBlock = document.getElementById('mfa-recovery-block');
  const recLeft = document.getElementById('mfa-recovery-left');
  try {
    const r = await apiFetch('/api/mfa/status');
    if (!r.ok) throw new Error();
    const s = await r.json();
    if (statusEl) statusEl.textContent = s.enabled
      ? `MFA is ON (${s.recoveryLeft} recovery codes left).`
      : 'MFA is OFF. Logins need only your password.';
    if (setupBtn) setupBtn.hidden = Boolean(s.enabled);
    if (disableBtn) disableBtn.hidden = !s.enabled;
    if (recBlock) recBlock.hidden = !s.enabled;
    if (recLeft) recLeft.textContent = String(s.recoveryLeft || 0);
  } catch (error) {
    if (statusEl) statusEl.textContent = 'Could not load MFA status.';
  }
}
const mfaSetupBtn = document.getElementById('mfa-setup-btn');
if (mfaSetupBtn) mfaSetupBtn.addEventListener('click', async () => {
  const err = document.getElementById('mfa-error');
  try {
    const r = await apiFetch('/api/mfa/setup', { method: 'POST' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'setup failed');
    document.getElementById('mfa-secret').textContent = data.secret;
    document.getElementById('mfa-otpauth').textContent = data.otpauth;
    // QR first, secret under it (local-only render; secret never fetched remotely).
    try {
      const qrEl = document.getElementById('mfa-qr');
      if (qrEl) {
        qrEl.innerHTML = '';
        if (typeof QRCode !== 'undefined') {
          new QRCode(qrEl, { text: data.otpauth, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
        }
      }
    } catch (error) { /* text secret still usable */ }
    document.getElementById('mfa-setup-block').hidden = false;
    if (err) err.hidden = true;
  } catch (error) {
    if (err) { err.textContent = error.message || 'Could not start setup.'; err.hidden = false; }
  }
});
const mfaConfirmBtn = document.getElementById('mfa-confirm-btn');
if (mfaConfirmBtn) mfaConfirmBtn.addEventListener('click', async () => {
  const err = document.getElementById('mfa-error');
  const code = String(document.getElementById('mfa-confirm-code').value || '').trim();
  try {
    const r = await apiFetch('/api/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Incorrect code.');
    }
    document.getElementById('mfa-setup-block').hidden = true;
    document.getElementById('mfa-confirm-code').value = '';
    showToast('MFA enabled');
    await refreshMfaStatus();
  } catch (error) {
    if (err) { err.textContent = error.message; err.hidden = false; }
  }
});
const mfaDisableBtn = document.getElementById('mfa-disable-btn');
if (mfaDisableBtn) mfaDisableBtn.addEventListener('click', async () => {
  const code = window.prompt('Enter a 6-digit code (or recovery code) to disable MFA:');
  if (!code) return;
  const t = String(code).trim();
  const body = t.indexOf('-') >= 0 ? { recoveryCode: t.toUpperCase() } : { code: t };
  const r = await apiFetch('/api/mfa/disable', { method: 'POST', body: JSON.stringify(body) });
  showToast(r.ok ? 'MFA disabled' : 'Incorrect code.');
  await refreshMfaStatus();
});
const mfaRecBtn = document.getElementById('mfa-recovery-btn');
if (mfaRecBtn) mfaRecBtn.addEventListener('click', async () => {
  const r = await apiFetch('/api/recovery/generate', { method: 'POST' });
  if (!r.ok) { showToast('Could not generate codes.'); return; }
  const data = await r.json();
  document.getElementById('mfa-recovery-list').textContent = (data.codes || []).join('  ');
  showToast('Copy recovery codes now — shown once.');
  await refreshMfaStatus();
});
// --- Passkeys (option-1 login factor; password still unlocks E2EE notes) ---
function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlToBuf(b64url) {
  let s = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
async function refreshPasskeys() {
  const listEl = document.getElementById('passkey-list');
  const errEl = document.getElementById('passkey-error');
  try {
    const r = await apiFetch('/api/passkey/list');
    if (!r.ok) throw new Error();
    const data = await r.json();
    const keys = (data && data.keys) || [];
    if (listEl) {
      listEl.innerHTML = '';
      if (!keys.length) listEl.textContent = 'No passkeys yet.';
      keys.forEach((k) => {
        const row = document.createElement('div');
        row.textContent = `${String(k.id).slice(0, 16)}… (added ${new Date((k.created_at || 0) * 1000).toLocaleDateString()}) `;
        const del = document.createElement('button');
        del.textContent = 'Remove';
        del.className = 'btn btn-secondary';
        del.addEventListener('click', async () => {
          await apiFetch('/api/passkey/remove', { method: 'POST', body: JSON.stringify({ id: k.id }) });
          await refreshPasskeys();
        });
        row.appendChild(del);
        listEl.appendChild(row);
      });
    }
    if (errEl) errEl.hidden = true;
  } catch (error) {
    if (listEl) listEl.textContent = 'Could not load passkeys.';
  }
}
const passkeyAddBtn = document.getElementById('passkey-add-btn');
if (passkeyAddBtn) passkeyAddBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('passkey-error');
  try {
    if (!window.PublicKeyCredential) throw new Error('Passkeys not supported in this browser.');
    const begin = await apiFetch('/api/passkey/register-begin', { method: 'POST' });
    const opts = await begin.json();
    if (!begin.ok) throw new Error(opts.error || 'Could not start enrolment.');
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: b64urlToBuf(opts.challenge),
        rp: opts.rp,
        user: { id: b64urlToBuf(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
        pubKeyCredParams: opts.pubKeyCredParams,
        timeout: opts.timeout,
        attestation: opts.attestation,
        authenticatorSelection: opts.authenticatorSelection,
        excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
      },
    });
    const finish = await apiFetch('/api/passkey/register-finish', {
      method: 'POST',
      body: JSON.stringify({
        id: cred.id,
        rawId: bufToB64url(cred.rawId),
        type: cred.type,
        response: {
          clientDataJSON: bufToB64url(cred.response.clientDataJSON),
          attestationObject: bufToB64url(cred.response.attestationObject),
        },
        transports: (cred.response.getTransports && cred.response.getTransports()) || [],
      }),
    });
    if (!finish.ok) {
      const d = await finish.json().catch(() => ({}));
      throw new Error(d.error || 'Enrolment failed.');
    }
    showToast('Passkey added');
    await refreshPasskeys();
  } catch (error) {
    if (errEl) { errEl.textContent = error.message || 'Could not add passkey.'; errEl.hidden = false; }
  }
});
document.getElementById('open-settings').addEventListener('click', () => {
  try { refreshMfaStatus(); } catch (error) {}
  try { refreshPasskeys(); } catch (error) {}
  try { refreshAccountPane(); } catch (error) {}
});
// --- Account pane (username/email/delete) ---
function refreshAccountPane() {
  try {
    const u = document.getElementById('account-username');
    if (u) u.value = (cachedProfile && cachedProfile.username) || '';
    const e = document.getElementById('account-email');
    if (e && document.activeElement !== e) e.value = (cachedProfile && cachedProfile.email) || '';
  } catch (error) {}
}
const accountSaveBtn = document.getElementById('account-save-btn');
if (accountSaveBtn) accountSaveBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('account-error');
  const email = String(document.getElementById('account-email').value || '').trim().slice(0, 254);
  try {
    const r = await apiFetch('/api/account/email', { method: 'POST', body: JSON.stringify({ email }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Could not save email.');
    if (cachedProfile) cachedProfile.email = data.email || email;
    if (errEl) errEl.hidden = true;
    try { applyProfile(); } catch (error) {}
    showToast('Email saved');
  } catch (error) {
    if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
  }
});
const accountDeleteBtn = document.getElementById('account-delete-btn');
if (accountDeleteBtn) accountDeleteBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('account-error');
  try {
    const uname = (cachedProfile && cachedProfile.username) || '';
    const typed = window.prompt(`Type your username (${uname}) to confirm deletion:`);
    if (typed !== uname) { showToast('Deletion cancelled.'); return; }
    const current = window.prompt('Enter your current password to confirm deletion:');
    if (!current) return;
    if (!e2ee.saltAuth) throw new Error('Please log in again, then retry.');
    const saltBytes = (e2ee.saltAuth instanceof Uint8Array) ? e2ee.saltAuth : e2eeB64ToBytes(e2ee.saltAuth);
    const raw = e2ee.kdf === 'argon2id'
      ? await argon2id32(current, saltBytes)
      : await e2eeDeriveBits(current, saltBytes, e2ee.iterations);
    const r = await apiFetch('/api/account', {
      method: 'DELETE', body: JSON.stringify({ confirmUsername: uname, currentAuth: e2eeBytesToB64(raw) }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Could not delete account.');
    }
    await logout();
    showToast('Account deleted');
  } catch (error) {
    if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
  }
});
// --- Password-loss recovery codes (E2EE-safe wraps, server stores hashes only) ---
async function sha256Hex(text) {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const REC_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function newRecoveryCode() {
  const bytes = e2eeRandomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i += 1) s += REC_ALPHABET[bytes[i] % REC_ALPHABET.length];
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}
const acctRecBtn = document.getElementById('acct-rec-generate-btn');
if (acctRecBtn) acctRecBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('acct-rec-error');
  try {
    if (!cachedProfile || !e2ee.masterKey) throw new Error('Log in and unlock notes first.');
    const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
    const wraps = [];
    const plain = [];
    for (let i = 0; i < 8; i += 1) {
      const code = newRecoveryCode();
      const salt = e2eeRandomBytes(16);
      const kekRaw = await argon2id32(code, salt);
      const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
      const iv = e2eeRandomBytes(12);
      const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, masterRaw);
      wraps.push({
        codeHash: await sha256Hex(code),
        salt: e2eeBytesToB64(salt),
        wrappedKey: { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) },
      });
      plain.push(code);
    }
    const r = await apiFetch('/api/recovery/account/generate', { method: 'POST', body: JSON.stringify({ wraps }) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Could not store codes.');
    }
    document.getElementById('acct-rec-list').textContent = plain.join('   ');
    const st = document.getElementById('acct-rec-status');
    if (st) st.textContent = '8 unused codes. Copy now — shown once. Each works once.';
    showToast('Recovery codes generated — copy now.');
  } catch (error) {
    if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
  }
});
// --- Login-overlay forgot-password flow (lookup by hash, unwrap locally) ---
const recoverLink = document.getElementById('recover-link');
if (recoverLink) recoverLink.addEventListener('click', () => {
  setAuthTab('recover');
});
const recoverBack = document.getElementById('recover-back');
if (recoverBack) recoverBack.addEventListener('click', () => setAuthTab('login'));
// Recover popup: one method per view (email / code / email-link token).
function openRecoverModal(kind) {
  const blockId = kind === 'email' ? 'recover-email-block'
    : kind === 'token' ? 'recover-token-block' : 'recover-code-block';
  const modal = document.getElementById('recover-modal');
  if (!modal) {
    // Fallback for mixed cached layouts: toggle the form inline.
    ['recover-email-block', 'recover-code-block', 'recover-token-block'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = id !== blockId;
    });
    return;
  }
  const title = document.getElementById('recover-modal-title');
  if (title) title.textContent = kind === 'email' ? 'Recover with email'
    : kind === 'token' ? 'Set a new password' : 'Recover with code';
  ['recover-email-block', 'recover-code-block', 'recover-token-block'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  const show = document.getElementById(blockId);
  if (show) show.hidden = false;
  modal.hidden = false;
}
function closeRecoverModal() {
  const modal = document.getElementById('recover-modal');
  if (modal) modal.hidden = true;
  verifiedRecovery = null;
  const block = document.getElementById('recover-newpw-block');
  if (block) block.hidden = true;
}
const closeRecoverModalBtn = document.getElementById('close-recover-modal');
if (closeRecoverModalBtn) closeRecoverModalBtn.addEventListener('click', closeRecoverModal);
const recoverModalOverlay = document.getElementById('recover-modal');
if (recoverModalOverlay) recoverModalOverlay.addEventListener('click', (event) => {
  if (event.target === recoverModalOverlay) closeRecoverModal();
});
const recoverOptEmail = document.getElementById('recover-opt-email');
if (recoverOptEmail) recoverOptEmail.addEventListener('click', () => openRecoverModal('email'));
const recoverOptCode = document.getElementById('recover-opt-code');
if (recoverOptCode) recoverOptCode.addEventListener('click', () => openRecoverModal('code'));
const recoverEmailBtn = document.getElementById('recover-email-btn');
if (recoverEmailBtn) recoverEmailBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('recover-email-error');
  const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
  try {
    const email = String(document.getElementById('recover-email-address').value || '').trim().slice(0, 254);
    if (!/^[^@\s<>\"]+@[^@\s<>\"]+\.[^@\s<>\"]+$/.test(email)) throw new Error('Enter your email address first.');
    const r = await apiFetch('/api/recovery/email/start', {
      method: 'POST', body: JSON.stringify({ email }),
    });
    if (!r.ok) throw new Error('Could not send email. Try again later.');
    if (errEl) errEl.hidden = true;
    const note = document.getElementById('recover-email-note');
    if (note) note.textContent = 'If the account exists, a reset link is on its way. It expires in 15 minutes.';
    showToast('Reset email sent if the account exists.');
  } catch (error) {
    fail(error.message || 'Could not send email.');
  }
});
let verifiedRecovery = null;
const recoverVerifyBtn = document.getElementById('recover-verify-btn');
if (recoverVerifyBtn) recoverVerifyBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('recover-error');
  const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
  try {
    const username = String(document.getElementById('recover-code-username').value || '').trim();
    const code = String(document.getElementById('recover-code').value || '').trim().toUpperCase();
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) throw new Error('Enter your username first.');
    if (!code) throw new Error('Enter a recovery code.');
    const codeHash = await sha256Hex(code);
    // Cross-search: the code must belong to this username before the
    // new-password fields are revealed.
    const lookup = await apiFetch('/api/recovery/account/lookup', {
      method: 'POST', body: JSON.stringify({ username, codeHash }),
    });
    if (lookup.status === 429) {
      const d = await lookup.json().catch(() => ({}));
      throw new Error((d && d.error) || 'Too many attempts — try again later.');
    }
    if (!lookup.ok) throw new Error('Username and recovery code do not match an account.');
    const wrap = await lookup.json();
    const kekRaw = await argon2id32(code, e2eeB64ToBytes(wrap.salt));
    const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    let masterRaw;
    try {
      masterRaw = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: e2eeB64ToBytes(wrap.wrappedKey.iv) },
        kek, e2eeB64ToBytes(wrap.wrappedKey.data));
    } catch (error) { throw new Error('Username and recovery code do not match an account.'); }
    verifiedRecovery = { username, code, codeHash, masterRaw };
    if (errEl) errEl.hidden = true;
    document.getElementById('recover-newpw-block').hidden = false;
    showToast('Code verified — set a new password.');
  } catch (error) {
    verifiedRecovery = null;
    document.getElementById('recover-newpw-block').hidden = true;
    fail(error.message || 'Verification failed.');
  }
});
const recoverBtn = document.getElementById('recover-btn');
if (recoverBtn) recoverBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('recover-error');
  const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
  try {
    if (!verifiedRecovery) throw new Error('Verify your username and code first.');
    const next = String(document.getElementById('recover-new').value || '');
    const confirm = String(document.getElementById('recover-confirm').value || '');
    const missing = passwordPolicyCheck(next);
    if (missing.length) throw new Error(`New password needs ${missing.join(', ')}.`);
    if (next !== confirm) throw new Error('New passwords do not match.');
    const { username, codeHash, masterRaw } = verifiedRecovery;
    const newSaltAuth = e2eeRandomBytes(16);
    const newSaltEnc = e2eeRandomBytes(16);
    const newAuthBits = await argon2id32(next, newSaltAuth);
    const newWrapped = await e2eeWrapMasterKeyArgon2id(next, newSaltEnc, masterRaw);
    const reset = await apiFetch('/api/recovery/account/reset', {
      method: 'POST',
      body: JSON.stringify({
        username, codeHash,
        authHash: e2eeBytesToB64(newAuthBits),
        saltAuth: e2eeBytesToB64(newSaltAuth),
        saltEnc: e2eeBytesToB64(newSaltEnc),
        encMasterKey: newWrapped,
        kdf: 'argon2id',
        params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
      }),
    });
    if (!reset.ok) {
      const d = await reset.json().catch(() => ({}));
      throw new Error(d.error || 'Could not reset password.');
    }
    if (errEl) errEl.hidden = true;
    const loginName = document.getElementById('login-username');
    if (loginName) loginName.value = username;
    verifiedRecovery = null;
    document.getElementById('recover-code-username').value = '';
    document.getElementById('recover-code').value = '';
    document.getElementById('recover-new').value = '';
    document.getElementById('recover-confirm').value = '';
    document.getElementById('recover-newpw-block').hidden = true;
    closeRecoverModal();
    setAuthTab('login');
    showToast('Password reset — log in with the new password.');
  } catch (error) {
    fail(error.message || 'Recovery failed.');
  }
});
document.getElementById('open-settings').addEventListener('click', () => {
  try { refreshMfaStatus(); } catch (error) {}
  try { refreshPasskeys(); } catch (error) {}
  try { refreshAccountPane(); } catch (error) {}
});
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
// Keep Side Menu settings in sync (unified custom sections have no hide toggles).
function syncSideMenuSettings() {}
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
}
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
    if (coverRepositioning) { exitCoverRepos(false); return; }
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
// --- Email-link password reset (?emailToken=...) ---
// The link proves email ownership; the new verifier is derived locally and
// the wrapped master key is untouched server-side. After reset the user logs
// in with the new password, then enters the OLD password once to re-wrap.
let emailRecoveryToken = null;
let pendingRewrap = null;
try {
  const params = new URLSearchParams(window.location.search || '');
  const tok = params.get('emailToken');
  if (tok && tok.length <= 256) emailRecoveryToken = tok;
} catch (error) {}
const recoverTokenBtn = document.getElementById('recover-token-btn');
if (recoverTokenBtn) recoverTokenBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('recover-token-error');
  const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
  try {
    if (!emailRecoveryToken) throw new Error('This link is invalid. Request a new email.');
    const next = String(document.getElementById('recover-token-new').value || '');
    const confirm = String(document.getElementById('recover-token-confirm').value || '');
    const missing = passwordPolicyCheck(next);
    if (missing.length) throw new Error(`New password needs ${missing.join(', ')}.`);
    if (next !== confirm) throw new Error('New passwords do not match.');
    const newSaltAuth = e2eeRandomBytes(16);
    const newAuthBits = await argon2id32(next, newSaltAuth);
    const r = await apiFetch('/api/recovery/email/complete', {
      method: 'POST',
      body: JSON.stringify({
        token: emailRecoveryToken,
        authHash: e2eeBytesToB64(newAuthBits),
        saltAuth: e2eeBytesToB64(newSaltAuth),
      }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Link invalid or expired.');
    }
    pendingRewrap = { password: next, saltAuth: newSaltAuth };
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('emailToken');
      window.history.replaceState({}, '', url.toString());
    } catch (error) {}
    emailRecoveryToken = null;
    if (errEl) errEl.hidden = true;
    closeRecoverModal();
    setAuthTab('login');
    showToast('Password reset — log in with the new password, then enter the old one once.');
  } catch (error) {
    fail(error.message || 'Recovery failed.');
  }
});
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
  // Email-reset landing: open recovery with only the token popup visible.
  try {
    if (emailRecoveryToken) {
      setAuthTab('recover');
      openRecoverModal('token');
    }
  } catch (error) {}
  refreshEditorLock();
  syncCustomSections();
  renderCustomSections();
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
