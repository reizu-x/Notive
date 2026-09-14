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
// EXPECTED_BUILD must be bumped together with the meta + cache busters.
try {
  const tag = document.querySelector('meta[name="notely-build"]');
  const build = tag ? tag.getAttribute('content') : null;
  if (build !== 'dev81') {
    if (!sessionStorage.getItem('notely-build-reloaded')) {
      sessionStorage.setItem('notely-build-reloaded', '1');
      window.location.reload();
      return;
    }
  } else {
    sessionStorage.removeItem('notely-build-reloaded');
  }
  // Login footer shows the live build straight from the meta tag, so the
  // visible number can never drift from the guarded one.
  const buildTag = document.getElementById('build-tag');
  if (buildTag && build) buildTag.textContent = `dev build ${build}`;
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
  'chevron-up': '<path d="m6 15 6-6 6 6"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-1.2 5.2"/><path d="M20 5.5V11h-5.5"/>',
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
  // Section icon picker set (line style, tinted by the section/theme color).
  layers: '<path d="m12 3.5 9 4.8-9 4.8-9-4.8Z"/><path d="m3 12.5 9 4.8 9-4.8"/><path d="m3 16.5 9 4.8 9-4.8"/>',
  bookmark: '<path d="M6 3.5h12v17l-6-4-6 4z"/>',
  tag: '<path d="M4 4h7.2l8.6 8.6-7.2 7.2L4 11.2z"/><circle cx="8.3" cy="8.3" r="1.3"/>',
  briefcase: '<path d="M3.5 8h17v11.5h-17z"/><path d="M9 8V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3.5 12.8h17"/>',
  book: '<path d="M5 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5z"/><path d="M19 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/>',
  heart: '<path d="M12 20s-7-4.4-7-9a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 4.6-7 9-7 9z"/>',
  flask: '<path d="M9 3.5h6M10 3.5v6L5.7 18a2 2 0 0 0 1.8 3h9a2 2 0 0 0 1.8-3L14 9.5v-6"/><path d="M7.6 15h8.8"/>',
  leaf: '<path d="M5 19c0-8 6-13 14-13 0 8-5 14-13 14z"/><path d="M5 19c3-3 6-5 10-6"/>',
  code: '<path d="m9 8-5 4 5 4M15 8l5 4-5 4"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.2 2.4 3.3 5.3 3.3 8.5S14.2 18.1 12 20.5c-2.2-2.4-3.3-5.3-3.3-8.5S9.8 5.9 12 3.5Z"/>',
  bulb: '<path d="M9.5 18h5M10.5 21h3"/><path d="M12 3a6 6 0 0 1 3.6 10.8c-.7.5-1.1 1.2-1.1 2H9.5c0-.8-.4-1.5-1.1-2A6 6 0 0 1 12 3Z"/>',
  flag: '<path d="M6 21V4M6 4h11l-2 4 2 4H6"/>',
  calendar: '<rect x="4" y="5.5" width="16" height="15" rx="2"/><path d="M4 10h16M8 3.5v4M16 3.5v4"/>',
  palette: '<path d="M12 3.5a8.5 8.5 0 0 0 0 17c1.4 0 2-1 2-2 0-1.4 1-2 2-2h1a3 3 0 0 0 3-3c0-5-4-10-8-10Z"/><circle cx="8" cy="12" r="1"/><circle cx="10" cy="8.5" r="1"/><circle cx="15" cy="9" r="1"/>',
  rocket: '<path d="M12 3c3 1 5 4 5 8 0 2-.7 3.7-1.6 5H8.6C7.7 14.7 7 13 7 11c0-4 2-7 5-8Z"/><path d="M9 16c-1 1-1.5 3-1.5 5 2 0 3.5-.6 4.5-1.5M15 16c1 1 1.5 3 1.5 5-2 0-3.5-.6-4.5-1.5"/><circle cx="12" cy="9.5" r="1.4"/>',
  home: '<path d="m4 11 8-7 8 7"/><path d="M6 10v10h12V10"/>',
  hash: '<path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h15.5M4 15h15.5"/>',
  eye: '<path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="m3 3 18 18"/><path d="M10.6 6.2A11 11 0 0 1 12 5.5c6.5 0 10 6.5 10 6.5a17.6 17.6 0 0 1-3.4 4.2"/><path d="M6.7 6.8A17.7 17.7 0 0 0 2 12s3.5 6.5 10 6.5a10.9 10.9 0 0 0 4.3-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  'folder-nested': '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/><path d="M9 12v4M9 12h6a1.5 1.5 0 0 1 1.5 1.5V16"/>',
  // Depth-styled folders: parent = solid, subfolder = plain outline,
  // sub-subfolder = nested outline with a bolder stroke (reads when small).
  'folder-solid': '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="currentColor" stroke-width="1.2"/>',
  'folder-deep': '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" stroke-width="2.4"/><path d="M9 12.2v3.8M9 12.2h5.6a1.5 1.5 0 0 1 1.5 1.5V16" stroke-width="2.4"/>',
  // File-type glyphs: rounded page outline (recipe-icon line style) with the
  // extension written on the paper. Tinted per theme via currentColor.
  'type-md': '<path d="M6.5 3.6h6.6l5.3 5.3V20a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20V5.1a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M13.1 3.6 18.4 8.9h-3.8a1.5 1.5 0 0 1-1.5-1.5Z"/><text x="11.7" y="17.4" text-anchor="middle" font-family="ui-monospace, monospace" font-size="4.9" font-weight="700" fill="currentColor" stroke="none">MD</text>',
  'type-txt': '<path d="M6.5 3.6h6.6l5.3 5.3V20a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20V5.1a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M13.1 3.6 18.4 8.9h-3.8a1.5 1.5 0 0 1-1.5-1.5Z"/><text x="11.7" y="17.4" text-anchor="middle" font-family="ui-monospace, monospace" font-size="4" font-weight="700" fill="currentColor" stroke="none">TXT</text>',
  'type-json': '<path d="M6.5 3.6h6.6l5.3 5.3V20a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20V5.1a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M13.1 3.6 18.4 8.9h-3.8a1.5 1.5 0 0 1-1.5-1.5Z"/><text x="11.7" y="17.4" text-anchor="middle" font-family="ui-monospace, monospace" font-size="3.2" font-weight="700" fill="currentColor" stroke="none">JSON</text>',
  'type-yaml': '<path d="M6.5 3.6h6.6l5.3 5.3V20a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 20V5.1a1.5 1.5 0 0 1 1.5-1.5Z"/><path d="M13.1 3.6 18.4 8.9h-3.8a1.5 1.5 0 0 1-1.5-1.5Z"/><text x="11.7" y="17.4" text-anchor="middle" font-family="ui-monospace, monospace" font-size="3.2" font-weight="700" fill="currentColor" stroke="none">YAML</text>',
  'file-text': '<path d="M6 3.5h7l4 4v13H6z"/><path d="M13 3.5v4h4M9 12h5M9 16h5"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="m5 12 5 5 9-11"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l.8 12a1 1 0 0 0 1 .7h7.4a1 1 0 0 0 1-.7l.8-12"/><path d="M10 11v6M14 11v6"/>',
  cooking: '<path d="M4 12h16v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M2 12h20M9 8c0-2 2-2 2-4M13 8c0-2 2-2 2-4M9 12v6M15 12v6"/>',
  todo: '<path d="M7 5.5h10A1.5 1.5 0 0 1 18.5 7v12a1.5 1.5 0 0 1-1.5 1.5H7A1.5 1.5 0 0 1 5.5 19V7A1.5 1.5 0 0 1 7 5.5Z"/><path d="M9.4 4.2h5.2a1 1 0 0 1 1 1v1.1H8.4V5.2a1 1 0 0 1 1-1Z"/><path d="M8.4 11.1l1 1 1.7-1.9M8.4 15.1l1 1 1.7-1.9"/><path d="M13.2 11.6h2.8M13.2 15.6h2.8"/>',
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

// Pull Ingredients / Method lists out of a recipe note's legacy Markdown body
// so old recipes can be migrated into the structured recipe fields.
function parseRecipeBody(body) {
  const lines = String(body == null ? '' : body).replace(/\r/g, '').split('\n');
  const ingredients = [];
  const steps = [];
  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      const name = heading[1].trim().toLowerCase();
      if (/^ingredients?\b/.test(name)) { section = 'ing'; continue; }
      if (/^(method|steps?|directions?|instructions?)\b/.test(name)) { section = 'method'; continue; }
      section = '';
      continue;
    }
    if (section === 'ing') {
      const m = line.match(/^[-*]\s+(?:\[([ xX])\]\s*)?(.*)$/);
      if (m) { const text = m[2].trim(); if (text) ingredients.push({ t: text, d: (m[1] || '').toLowerCase() === 'x' }); }
      else if (line) section = '';
    } else if (section === 'method') {
      const m = line.match(/^(?:\d+[.)]|[-*])\s+(.*)$/);
      if (m) { const text = m[1].trim(); if (text) steps.push(text); }
      else if (line) section = '';
    }
  }
  return { ingredients, steps };
}
function sanitizeIngredients(value) {
  return (Array.isArray(value) ? value : []).slice(0, 200).map((item) => {
    if (item && typeof item === 'object') return { t: String(item.t == null ? '' : item.t).slice(0, 300), d: Boolean(item.d) };
    return { t: String(item == null ? '' : item).slice(0, 300), d: false };
  });
}
function sanitizeSteps(value) {
  return (Array.isArray(value) ? value : []).slice(0, 300).map((step) => String(step == null ? '' : step).slice(0, 2000));
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
  if (typeof migrated.updatedAt !== 'number' || !Number.isFinite(migrated.updatedAt)) migrated.updatedAt = null;
  // Template markers: preserved only when 'recipe' or 'todo'. The recipe
  // marker also carries an optional description (fixed hero under the meta
  // row, max 2000 chars). Anything else is dropped so the envelope stays clean.
  if (migrated.template === 'recipe' || migrated.template === 'todo') {
    if (migrated.template === 'recipe') {
      if (typeof migrated.description === 'string') migrated.description = migrated.description.slice(0, 2000);
      else if ('description' in migrated) delete migrated.description;
    } else if ('description' in migrated) delete migrated.description;
    // Template marker carries its tag so recipes/to-dos are findable and
    // filterable by tag: backfill it for notes created before it existed.
    const templateTag = migrated.template;
    if (!migrated.tags.some((tag) => String(tag).toLowerCase() === templateTag)) {
      migrated.tags = [templateTag, ...migrated.tags].slice(0, 20);
    }
  } else {
    if ('template' in migrated) delete migrated.template;
    if ('description' in migrated) delete migrated.description;
  }
  // Recipe notes carry structured Ingredients/Method fields; backfill them from
  // a legacy Markdown body once, then keep them normalized.
  if (migrated.template === 'recipe') {
    if (!Array.isArray(migrated.ingredients) || !Array.isArray(migrated.steps)) {
      const parsed = parseRecipeBody(migrated.body);
      if (!Array.isArray(migrated.ingredients)) migrated.ingredients = parsed.ingredients;
      if (!Array.isArray(migrated.steps)) migrated.steps = parsed.steps;
    }
    migrated.ingredients = sanitizeIngredients(migrated.ingredients);
    migrated.steps = sanitizeSteps(migrated.steps);
  } else {
    if ('ingredients' in migrated) delete migrated.ingredients;
    if ('steps' in migrated) delete migrated.steps;
  }
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

// Onboarding workspace for brand-new accounts: a "Notes" section with
// General/Personal folders plus welcome notes that explain the app. Ids are
// stable (`welcome-*`) so this runs at most once per account — any saved
// envelope (even an empty one) means the server row exists and this never fires.
const WELCOME_SECTION_ID = 'section-notes';
const WELCOME_FOLDERS = ['General', 'Personal'];

function welcomeSeedNotes() {
  const generalWelcome = `# Welcome to Notely

This is your private, end-to-end encrypted notebook. Everything you write is
encrypted on this device before it ever reaches the server — nobody else can
read it, not even the server itself.

## The basics

- **New note** — the button at the top of the list creates a note.
- **Write** — the left pane is your editor, the right pane previews as you type.
- **Organise** — every note can live in a folder. This workspace starts with
  two: **General** and **Personal**, inside the **Notes** section.
- **Search** — the search bar finds note titles, contents and folders. To find a
  tag, type \`tag: <name>\` (for example, \`tag: recipe\`).

## Sections and folders

The sidebar holds **sections** (think of them as shelves). Each section contains
**folders**, and folders can nest — type \`Work / Projects\` to create a folder
inside a folder. Create new sections with **+ Add section**, and add folders
with the **+** next to a section.

## Note types

When creating a note you can pick a template:

- **Note** — free-form markdown, the default.
- **Recipe** — ingredients and steps with a tidy layout.
- **To-do** — checkboxes that track progress as you go.

## Safety net

- **Favorite** notes (right-click) to pin them for quick access.
- **Archive** notes you want out of the way but not gone.
- **Delete** moves a note to the **Bin**, where it waits for a grace period
  before being removed for good — mistakes are recoverable.

> Everything here is yours alone. Change these notes, rename the folders, or
> delete them — this workspace is yours to shape.`;

  const personalWelcome = `# Your personal space

This folder is for the everyday things: journal entries, ideas, lists, plans,
drafts, anything that is yours.

## Ideas to get you started

- A **daily journal** — one note per day, or one running note.
- **Lists** — books to read, films to watch, places to go.
- **Projects** — plan something you care about, one step at a time.
- **Recipes** — switch the template to *Recipe* for ingredients and steps.

## Tips

1. **Tags** — add tags like \`ideas\` or \`todo\` to find notes across folders.
2. **Markdown** — \`#\` makes headings, \`-\` makes lists, \`>\` makes quotes.
3. **Drag notes** onto a folder in the sidebar to file them.

> There is no wrong way to take notes. Start messy, organise later.`;

  return [
    {
      id: 'welcome-general', title: 'Welcome to Notely', date: 'Today',
      tags: ['welcome'], favorite: true, ext: 'md',
      sections: { [WELCOME_SECTION_ID]: 'General' },
      body: generalWelcome,
    },
    {
      id: 'welcome-personal', title: 'Your personal space', date: 'Today',
      tags: ['welcome'], favorite: false, ext: 'md',
      sections: { [WELCOME_SECTION_ID]: 'Personal' },
      body: personalWelcome,
    },
  ];
}

// The sidebar section that ships with new accounts. Only applied when the
// account has no sidebar state of its own (server or device cache).
function welcomeSeedUi() {
  return {
    collapsed: [],
    customSections: [{ id: WELCOME_SECTION_ID, name: 'Notes', folders: [...WELCOME_FOLDERS], icon: 'book' }],
    deletedCustomSections: [],
  };
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
  // A shared note is always editable while it is open in the standard editor.
  if (collab.noteId) {
    titleInput.disabled = false;
    markdownInput.disabled = false;
    return;
  }
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
  if (newNoteBtn) newNoteBtn.hidden = locked || activeView === 'bin' || activeView === 'vault' || activeView === 'shared';
  if (importBtn) importBtn.hidden = locked || activeView === 'bin' || activeView === 'vault' || activeView === 'shared';
  const coverAddBtn = document.getElementById('cover-add');
  if (coverAddBtn) setCoverAddHidden(readOnly || activeView === 'vault' || !note || Boolean(note.cover) || note.template === 'recipe');
  const coverChangeBtn = document.getElementById('cover-change');
  if (coverChangeBtn) coverChangeBtn.disabled = readOnly;
  const coverRemoveBtn = document.getElementById('cover-remove');
  if (coverRemoveBtn) coverRemoveBtn.disabled = readOnly;
  const coverReposBtn = document.getElementById('cover-repos');
  if (coverReposBtn) coverReposBtn.disabled = readOnly;
  const coverDoneBtn = document.getElementById('cover-done');
  if (coverDoneBtn) coverDoneBtn.disabled = readOnly;
  const recipeDesc = document.getElementById('recipe-desc');
  if (recipeDesc) recipeDesc.disabled = readOnly;
  const recipePhotoBtn = document.getElementById('recipe-photo-btn');
  if (recipePhotoBtn) recipePhotoBtn.disabled = readOnly;
}

// ---- Desktop copy / cloud opt-out ----
// "This device only" mode: server sync is off and the E2EE envelope is saved
// to a per-account encrypted localStorage slot instead. Same key-zeroing
// rules as the UI vault — never plaintext, never shared between accounts.
function accountScopeKey(base) {
  try {
    const name = cachedProfile && cachedProfile.username ? String(cachedProfile.username).toLowerCase() : '';
    return `${base}:${name}`;
  } catch (error) { return base; }
}
function deviceOnlyKey() { return accountScopeKey('notely-device-only'); }
function localNotesKey() { return accountScopeKey('notely-local-notes'); }
function deviceOnlyPref() {
  try { return localStorage.getItem(deviceOnlyKey()) === '1'; } catch (error) { return false; }
}
function setDeviceOnlyPref(on) {
  try {
    if (on) localStorage.setItem(deviceOnlyKey(), '1');
    else localStorage.removeItem(deviceOnlyKey());
  } catch (error) {}
}

// Build the outgoing workspace envelope (notes + vault ciphertext + UI state)
// shared by server sync and device-only saves.
async function buildNotesEnvelope() {
  const envelope = { v: 2, notes, vault: await currentVaultBlobs(), vaultFolders: [...vault.folders] };
  try {
    if (typeof uiSnapshot === 'function') envelope.ui = uiSnapshot();
  } catch (error) {}
  return envelope;
}

// Encrypted local save in device-only mode: same E2EE payload the server
// would get, parked in this browser's per-account slot.
async function saveNotesToDevice() {
  if (!e2ee.masterKey) {
    setSaveLabel('Locked', 'gray');
    return;
  }
  try {
    const payload = await e2eeEncryptNotes(await buildNotesEnvelope());
    try { localStorage.setItem(localNotesKey(), JSON.stringify(payload)); } catch (error) {
      setSaveLabel('Save failed', 'red');
      return;
    }
    setSaveLabel('Offline · saved', 'gray');
  } catch (error) {
    setSaveLabel('Save failed', 'red');
  }
}

// Apply a decrypted {v,notes,vault,vaultFolders,ui} envelope (or legacy array)
// to live state. Shared by the server blob path and the device-only local path.
async function adoptNotesEnvelope(envelope) {
  const list = Array.isArray(envelope) ? envelope
    : (envelope && Array.isArray(envelope.notes) ? envelope.notes : null);
  if (!list) throw new Error('bad payload');
  notes = list.map(migrateNote).slice(0, 2000);
  const incomingBlobs = (!Array.isArray(envelope) && Array.isArray(envelope.vault))
    ? envelope.vault.filter(validVaultBlob).slice(0, 2000)
    : [];
  vault.blobs = incomingBlobs;
  try {
    vault.folders = (!Array.isArray(envelope) && envelope) ? cleanVaultFolders(envelope.vaultFolders) : [];
  } catch (error) { vault.folders = []; }
  if (vault.unlocked) {
    try { vault.notes = await decryptAllVaultBlobs(); }
    catch (error) { vault.notes = []; }
  }
  try {
    if (!Array.isArray(envelope) && envelope && envelope.ui && typeof applyUiSnapshot === 'function') {
      if (applyUiSnapshot(envelope.ui)) {
        serverUiLoaded = true;
        try { await writeUiVaultLocal(); } catch (error) {}
      }
    }
  } catch (error) {}
  // Folder-required invariant: nothing loads (or stays) unfiled.
  try { enforceFilingInvariant(); } catch (error) {}
}

// Device-only boot: load from the encrypted local slot (onboarding workspace
// when the device copy is missing) without touching the server either way.
async function loadNotesFromDevice() {
  try {
    const raw = localStorage.getItem(localNotesKey());
    if (raw) {
      const payload = JSON.parse(raw);
      await adoptNotesEnvelope(await e2eeDecryptPayload(payload));
      notesLoaded = true;
      setSaveLabel('Offline · loaded', 'gray');
      return;
    }
  } catch (error) {}
  notes = welcomeSeedNotes();
  applyUiSnapshot(welcomeSeedUi());
  vault.blobs = [];
  vault.folders = [];
  notesLoaded = true;
  setSaveLabel('Offline · saved', 'gray');
}

// Debounced encrypted upload of the workspace (notes + vault ciphertext +
// per-account UI state). No-ops without a session; reports Locked when the
// vault is locked. The server stores the blob opaquely — UI folders/sections
// ride along so every account keeps its own sidebar across relogs/devices.
// Device-only mode redirects the same save into local storage instead.
async function syncNotesToServer() {
  if (!cachedProfile) return;
  if (deviceOnlyPref()) {
    await saveNotesToDevice();
    return;
  }
  if (!e2ee.masterKey) {
    setSaveLabel('Locked', 'gray');
    return;
  }
  try {
    const payload = await e2eeEncryptNotes(await buildNotesEnvelope());
    const response = await apiFetch('/api/notes', { method: 'PUT', body: JSON.stringify({ payload, baseVersion: serverNotesVersion }) });
    if (response.status === 409) {
      setSaveLabel('Out of date', 'red');
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
    markSynced();
  } catch (error) {
    setSaveLabel('Sync failed', 'red');
  }
}

// Immediate (non-debounced) upload used by logout/unload so the last edits
// are never stranded in a cancelled timer.
async function flushNotesToServer() {
  clearTimeout(syncTimer);
  await syncNotesToServer();
}

// Boot/load path: decrypts the server E2EE blob; adopts a legacy plaintext-shape row once; brand-new accounts start empty (updated_at distinguishes); offline falls back to the legacy local copy.
// The envelope is a bare array (very old), {v:1, notes, vault} (E2EE notes
// only) or {v:2, notes, vault, ui} (notes + per-account sidebar state). When
// the server carries UI state it wins over any device-local copy.
async function loadNotesFromServer() {
  // Cloud opt-out: decrypt-and-go from the local slot; the server is never
  // contacted in this mode (no GET, no background PUT).
  if (deviceOnlyPref()) {
    await loadNotesFromDevice();
    return;
  }
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
      await adoptNotesEnvelope(await e2eeDecryptPayload(data.payload));
    } else if (Array.isArray(data.notes) && (data.notes.length || data.updated_at)) {
      // Legacy plaintext-shape response (pre-E2EE row): adopt, then the next
      // debounced save re-uploads it encrypted.
      notes = data.notes.map(migrateNote).slice(0, 2000);
      vault.blobs = [];
      vault.folders = [];
      await syncNotesToServer();
    } else {
      // Brand-new account: no server blob, no notes row. Seed the onboarding
      // workspace (Notes section, General/Personal folders, welcome notes).
      // Only genuine legacy local data (pre-server version) is migrated on top.
      const legacy = readLegacyLocalNotes();
      notes = (legacy && legacy.length ? legacy : welcomeSeedNotes()).slice(0, 2000);
      vault.blobs = [];
      vault.folders = [];
      if (!legacy || !legacy.length) applyUiSnapshot(welcomeSeedUi());
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
// User-created tags that may not be attached to any note yet (Settings → Tags).
let knownTags = [];
function cleanTagList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  value.slice(0, 500).forEach((raw) => {
    const tag = normalizeTagName(raw);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) return;
    seen.add(key);
    out.push(tag);
  });
  return out;
}
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
    if (THEMES.includes(current)) theme = current;
  } catch (error) {}
  return {
    collapsed: [...collapsedFolders],
    customSections: customSections.map((section) => ({ id: section.id, name: section.name, folders: [...section.folders], icon: sectionIconName(section) })),
    deletedCustomSections: (deletedCustomSections || []).map((entry) => ({
      id: entry.id, name: entry.name,
      folders: [...(entry.folders || [])], deletedAt: entry.deletedAt,
    })),
    theme,
    avatar: profileAvatar || '',
    tags: knownTags,
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
  if (typeof value.theme === 'string' && THEMES.includes(value.theme)) {
    out.theme = value.theme;
  }
  if (typeof value.avatar === 'string' && cleanAvatarSrc(value.avatar)) {
    out.avatar = value.avatar.trim();
  }
  if (Array.isArray(value.tags)) {
    const tags = cleanTagList(value.tags);
    if (tags.length) out.tags = tags;
  }
  if (out.collapsed === null
    && !out.customSections && !out.legacyCollections && !out.legacyCollectionsName && !out.deletedCustomSections && !out.theme && !out.avatar && !out.tags) return null;
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
  if (typeof clean.avatar === 'string') {
    profileAvatar = clean.avatar;
    adopted = true;
    try { applyProfile(); } catch (error) {}
  }
  if (Array.isArray(clean.tags)) {
    knownTags = cleanTagList(clean.tags);
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
    if (THEMES.includes(current)) theme = current;
  } catch (error) {}
  const snapshot = JSON.stringify({
    collapsed: [...collapsedFolders],
    customSections, deletedCustomSections, theme,
    avatar: profileAvatar || '',
    tags: knownTags,
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

// Section icon picker set (order shown in the picker). First entry is the
// default for sections without a chosen icon.
const SECTION_ICONS = ['layers', 'folder', 'book', 'briefcase', 'tag', 'bookmark',
  'star', 'flag', 'bulb', 'flask', 'leaf', 'code', 'globe', 'calendar', 'palette',
  'rocket', 'home', 'heart', 'hash', 'archive'];

// Resolve a section's icon, falling back to the default when unset/invalid.
function sectionIconName(section) {
  const name = section && typeof section.icon === 'string' ? section.icon : '';
  return SECTION_ICONS.includes(name) ? name : SECTION_ICONS[0];
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
    const icon = typeof entry.icon === 'string' && SECTION_ICONS.includes(entry.icon) ? entry.icon : undefined;
    if (id && name) out.push(icon ? { id, name, folders, icon } : { id, name, folders });
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
  if (!adopted && customSections.length === 0) {
    // Fresh device + fresh account: adopt the onboarding sidebar (Notes
    // section with General/Personal). Any real sidebar state wins over it.
    applyUiSnapshot(welcomeSeedUi());
    adopted = true;
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
    // The section name and its icon both select (mark) the section.
    const label = event.target.closest('.section-label-text, .section-icon');
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
  // Collapsed slide menu shows section initials: clicking one opens the
  // section in the workspace (empty sections stay put, like labels).
  sidebar.addEventListener('click', (event) => {
    const initial = event.target.closest('.section-initial');
    if (!initial) return;
    const section = initial.closest('.sidebar-section');
    if (!section || !section.dataset.customSection) return;
    event.preventDefault();
    if (!isSectionEmpty('custom', section.dataset.customSection)) selectCustomSection(section.dataset.customSection);
  });
}

// Render user-built sections: header (editable name, add/delete) + folders.
function renderCustomSections() {
  const container = document.getElementById('custom-sections');
  if (!container) return;
  container.innerHTML = customSections.map((section) => `
    <div class="sidebar-section" data-custom-section="${escapeHtml(section.id)}" data-section="custom">
      <div class="section-label">
        <span class="section-initial" title="${escapeHtml(section.name)}" aria-hidden="true">${icon(sectionIconName(section))}</span>
        <span class="section-icon" title="${escapeHtml(section.name)}" aria-hidden="true">${icon(sectionIconName(section))}</span>
        <span class="section-label-text" data-section-name="${escapeHtml(section.id)}">${escapeHtml(section.name)}</span>
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
  const section = { id: uniqueSectionId(), name: uniqueSectionName(), folders: [], icon: SECTION_ICONS[0] };
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
function startSectionRename(target, anchorEl) {
  // Workspace-anchored rename (pencil/dblclick in the note list): edit inline
  // in the list header where clicked — never in the slide menu.
  if (anchorEl && anchorEl.isConnected && anchorEl.closest('#note-list')) {
    const head = anchorEl.closest('.list-section-head');
    if (head && !head.querySelector('.section-rename-input')) {
      const section = customSections.find((entry) => entry.id === target.id);
      const input = document.createElement('input');
      input.className = 'section-rename-input';
      input.value = (section || {}).name || '';
      input.maxLength = 40;
      input.setAttribute('aria-label', 'Section name');
      anchorEl.hidden = true;
      anchorEl.after(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        input.remove();
        anchorEl.hidden = false;
        if (commit) renameSectionDisplay(target.id, input.value);
        else renderNoteList();
      };
      input.onkeydown = (event) => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        event.stopPropagation();
      };
      input.onclick = (event) => event.stopPropagation();
      input.onblur = () => finish(true);
      return;
    }
    if (head) {
      const pending = head.querySelector('.section-rename-input');
      if (pending) { pending.focus(); pending.select(); return; }
    }
  }
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
  if (slideMenuCollapsed()) {
    // Inline naming lives in the slide menu and is hidden while collapsed.
    askInput({ eyebrow: 'New folder', title: 'Name the folder', desc: `In ${section.name}`, label: 'Folder name', password: false, placeholder: 'e.g. Projects', okText: 'Create' }).then((value) => {
      if (value == null) return;
      const leaf = String(value).trim().slice(0, 60);
      if (!leaf) { showToast('Give the folder a name'); return; }
      if (/[/\\]/.test(leaf)) { showToast('Use a plain name without slashes'); return; }
      if (section.folders.some((entry) => entry.toLowerCase() === leaf.toLowerCase())) {
        showToast('A folder with that name already exists');
        return;
      }
      section.folders.push(leaf);
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
      showToast('Folder added');
    });
    return;
  }
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

// Add a folder to one section from its All-Notes header (folder-plus beside
// the edit pencil). Keeps the current view. When the slide menu is collapsed
// the inline rename row is hidden, so the name is asked in a popup instead.
function addFolderToSection(sectionId) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  let slideCollapsed = false;
  try { slideCollapsed = document.getElementById('sidebar').classList.contains('collapsed'); } catch (error) {}
  const commit = (leaf) => {
    const clean = String(leaf == null ? '' : leaf).trim().slice(0, 60);
    if (!clean) { showToast('Give the folder a name'); return; }
    if (/[/\\]/.test(clean)) { showToast('Use a plain name without slashes'); return; }
    if (section.folders.some((entry) => entry.toLowerCase() === clean.toLowerCase())) {
      showToast('A folder with that name already exists');
      return;
    }
    section.folders.push(clean);
    persistCustomSections();
    renderCustomSections();
    renderNoteList();
    showToast('Folder added');
  };
  if (slideCollapsed) {
    askInput({ eyebrow: 'New folder', title: 'Name the folder', desc: `In ${section.name}`, label: 'Folder name', password: false, placeholder: 'e.g. Projects', okText: 'Create' }).then((value) => {
      if (value != null) commit(value);
    });
    return;
  }
  const name = uniqueCustomFolderName(sectionId, 'New folder');
  section.folders.push(name);
  persistCustomSections();
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
      const head = event.target.closest('.section-label');
      const headWrap = event.target.closest('[data-custom-section]');
      if (head && headWrap && !event.target.closest('input')) {
        event.preventDefault();
        event.stopPropagation();
        closeFolderContextMenu();
        openSectionContextMenu(headWrap.dataset.customSection, event.clientX, event.clientY);
        return;
      }
      const item = event.target.closest('.collection-item');
      if (!item || !item.dataset.cfolder || event.target.closest('.collection-rename-input')) return;
      event.preventDefault();
      event.stopPropagation();
      closeSectionContextMenu();
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
// ---- Section context menu (right-click on a slide-menu section header):
// New folder / Rename section / Delete section. Replaces the old header +
// and × buttons. Rename/add fall back to popups while the slide menu is
// collapsed, where the inline rows are hidden.
let sectionMenuTarget = null; // section id

function closeSectionContextMenu() {
  const menu = document.getElementById('section-context-menu');
  if (menu) menu.hidden = true;
  sectionMenuTarget = null;
}

function openSectionContextMenu(sectionId, x, y) {
  const menu = document.getElementById('section-context-menu');
  if (!menu || !sectionId) return;
  if (!customSections.some((entry) => entry.id === sectionId)) return;
  sectionMenuTarget = sectionId;
  menu.hidden = false;
  const padding = 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - padding) menu.style.left = `${Math.max(padding, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight - padding) menu.style.top = `${Math.max(padding, y - rect.height)}px`;
}

function slideMenuCollapsed() {
  try { return document.getElementById('sidebar').classList.contains('collapsed'); } catch (error) { return false; }
}

function handleSectionMenuAction(action, sectionId) {
  if (!sectionId || typeof action !== 'string') return;
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  if (action === 'add') {
    addCustomFolder(sectionId);
  } else if (action === 'icon') {
    openSectionIconPicker(sectionId);
  } else if (action === 'rename') {
    if (slideMenuCollapsed()) {
      askInput({ eyebrow: 'Rename section', title: section.name, desc: '', label: 'Section name', password: false, placeholder: section.name, okText: 'Rename' }).then((value) => {
        if (value == null) return;
        renameSectionDisplay(sectionId, value);
      });
    } else {
      startSectionRename({ kind: 'custom', id: sectionId });
    }
  } else if (action === 'delete') {
    openCustomSectionDeleteConfirm(sectionId);
  }
}

// ---- Section icon picker -------------------------------------------------
// Opens a grid of line icons; picking one stores it on the section (persisted
// in the E2EE UI envelope) and repaints the sidebar.
let sectionIconTarget = null;

function openSectionIconPicker(sectionId) {
  const overlay = document.getElementById('section-icon-overlay');
  const grid = document.getElementById('section-icon-grid');
  const section = customSections.find((entry) => entry.id === sectionId);
  if (!overlay || !grid || !section) return;
  sectionIconTarget = sectionId;
  const current = sectionIconName(section);
  grid.innerHTML = SECTION_ICONS.map((name) =>
    `<button type="button" class="section-icon-option${name === current ? ' is-selected' : ''}" data-icon-choice="${name}" title="${name}" aria-label="${name}">${icon(name)}</button>`).join('');
  const desc = document.getElementById('section-icon-desc');
  if (desc) desc.textContent = `Pick the icon shown beside “${section.name}”.`;
  overlay.hidden = false;
  const first = grid.querySelector('.section-icon-option');
  if (first) first.focus();
}

function closeSectionIconPicker() {
  const overlay = document.getElementById('section-icon-overlay');
  if (overlay) overlay.hidden = true;
  sectionIconTarget = null;
}

function chooseSectionIcon(name) {
  const section = customSections.find((entry) => entry.id === sectionIconTarget);
  if (!section || !SECTION_ICONS.includes(name)) { closeSectionIconPicker(); return; }
  section.icon = name;
  closeSectionIconPicker();
  persistCustomSections();
  renderCustomSections();
  renderNoteList();
  showToast(`Icon set to “${name}”`);
}

function bindSectionContextMenu() {
  const menu = document.getElementById('section-context-menu');
  if (menu) menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-section-action]');
    if (!item) return;
    const target = sectionMenuTarget;
    closeSectionContextMenu();
    handleSectionMenuAction(item.dataset.sectionAction, target);
  });
  document.addEventListener('click', (event) => {
    if (sectionMenuTarget && !event.target.closest('#section-context-menu')) closeSectionContextMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    if (sectionMenuTarget && !event.target.closest('#section-context-menu')) closeSectionContextMenu();
  });
  window.addEventListener('resize', closeSectionContextMenu);
}

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
  // Subfolders nest up to two levels: "New subfolder" is offered on top-level
  // folders and on first-level subfolders, but not on the deepest ones.
  const atMaxDepth = folderDepth(path) >= MAX_SUBFOLDER_PARENT_DEPTH;
  menu.querySelectorAll('[data-folder-action]').forEach((btn) => {
    const actionName = btn.dataset.folderAction;
    btn.hidden = actionName === 'restore'
      || (actionName === 'new-note' && activeView === 'bin')
      || (actionName === 'subfolder' && atMaxDepth);
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
  } else if (action === 'new-note') {
    // File the new note straight into the right-clicked folder.
    pendingSectionFolder = { ns: 'custom', section: sectionId, folder: path };
    pendingTemplate = null;
    openTemplatePicker();
  } else if (action === 'rename') {
    startCustomFolderRename(sectionId, path);
  } else if (action === 'subfolder') {
    if (folderDepth(path) >= MAX_SUBFOLDER_PARENT_DEPTH) return; // depth limit
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
  // Depth limit: top-level -> sub -> sub-sub, but no deeper.
  if (folderDepth(parentPath) >= MAX_SUBFOLDER_PARENT_DEPTH) {
    showToast('Subfolders can only nest two levels deep');
    return;
  }
  let slideCollapsed = false;
  try { slideCollapsed = document.getElementById('sidebar').classList.contains('collapsed'); } catch (error) {}
  if (slideCollapsed) {
    // The inline rename row lives in the slide menu and is hidden while it
    // is collapsed: ask for the name in a popup instead.
    askInput({ eyebrow: 'New subfolder', title: 'Name the subfolder', desc: `Under ${parentPath}`, label: 'Subfolder name', password: false, placeholder: 'e.g. Projects', okText: 'Create' }).then((value) => {
      if (value == null) return;
      const leaf = String(value).trim().slice(0, 60);
      if (!leaf) { showToast('Give the subfolder a name'); return; }
      if (/[/\\]/.test(leaf)) { showToast('Use a plain name without slashes'); return; }
      const section = customSections.find((entry) => entry.id === sectionId);
      if (!section) return;
      const name = `${parentPath}${FOLDER_SEP}${leaf}`;
      if (section.folders.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
        showToast('A folder with that name already exists');
        return;
      }
      insertFolderAfterParent(section.folders, parentPath, name);
      persistCustomSections();
      renderCustomSections();
      renderNoteList();
      showToast('Subfolder created');
    });
    return;
  }
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

function bindFolderContextMenu() {
  const menu = getFolderContextMenu();
  if (!menu) return;
  if (noteList) noteList.addEventListener('contextmenu', (event) => {
    // The Vault header is not a workspace folder: no folder menu there.
    if (activeView === 'vault') return;
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
// ---- Save-state light ----
// One helper drives the topbar indicator: dot colour (green synced / gray
// offline / red error) plus label text. Sync timestamps feed the
// "Synced X min ago" wording and a ticker keeps it current.
let lastSyncedAt = 0;
function setSaveLabel(text, mode = 'green') {
  if (saveLabel) saveLabel.textContent = text;
  const dot = document.querySelector('.save-state .save-dot');
  if (dot) {
    dot.classList.toggle('is-offline', mode === 'gray');
    dot.classList.toggle('is-error', mode === 'red');
  }
  // Sidebar footer mirror: drives the Settings/Help-area indicator too so
  // the two can never show different states.
  const syncDot = document.querySelector('.sync-status .sync-dot');
  const syncText = document.querySelector('.sync-status .sync-text');
  if (syncDot) {
    syncDot.classList.toggle('is-offline', mode === 'gray');
    syncDot.classList.toggle('is-error', mode === 'red');
  }
  if (syncText) syncText.textContent = text;
}
function syncAgoText() {
  const seconds = Math.max(0, Math.floor((Date.now() - lastSyncedAt) / 1000));
  if (seconds < 15) return 'Synced just now';
  if (seconds < 120) return 'Synced 1 min ago';
  if (seconds < 3600) return `Synced ${Math.floor(seconds / 60)} min ago`;
  return `Synced at ${new Date(lastSyncedAt).toTimeString().slice(0, 5)}`;
}
function markSynced() {
  lastSyncedAt = Date.now();
  setSaveLabel(syncAgoText(), 'green');
}
setInterval(() => {
  if (lastSyncedAt && saveLabel && saveLabel.textContent.startsWith('Synced')) {
    setSaveLabel(syncAgoText(), 'green');
  }
}, 30000);
const typeBadge = document.getElementById('type-badge');
const editorToolbar = document.getElementById('editor-toolbar');
const allCount = document.getElementById('all-count');
const recentCountEl = document.getElementById('recent-count');
const starredCountEl = document.getElementById('starred-count');
const totalCount = document.getElementById('total-count');
const importInput = document.getElementById('import-input');
const modeLabel = document.getElementById('mode-label');
const modeToggle = document.getElementById('mode-toggle');
const beautifyBtn = document.getElementById('beautify-btn');
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

// Split a Markdown table row into trimmed cells. Handles optional leading/
// trailing pipes and escaped (\|) pipes inside a cell.
function splitTableRow(line) {
  let s = String(line == null ? '' : line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

// Recognise a GFM delimiter row ("| --- | :--: |") and return per-column
// alignment ('left'|'center'|'right'|''), or null when it is not one.
function tableAligns(line) {
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
  }
  return aligns;
}

function renderTable(header, aligns, rows) {
  const alignAttr = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
  const head = header.map((cell, i) => `<th${alignAttr(i)}>${inlineMarkdown(cell)}</th>`).join('');
  const body = rows.map((row) => `<tr>${header
    .map((_, i) => `<td${alignAttr(i)}>${inlineMarkdown(row[i] == null ? '' : row[i])}</td>`)
    .join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

// Split a `::: recipe` block into its two columns at the first `---` rule.
function splitRecipeColumns(lines) {
  const at = lines.findIndex((line) => /^\s*---\s*$/.test(line));
  if (at === -1) return [lines.join('\n'), ''];
  return [lines.slice(0, at).join('\n'), lines.slice(at + 1).join('\n')];
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

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    if (line.trim().startsWith('```')) {
      closeList();
      if (inCode) {
        html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
        code = [];
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    // Two-column recipe block: `::: recipe` ... `:::`. The first `---` rule
    // splits the left (Ingredients) and right (Method) columns.
    if (/^:::\s*(recipe|columns)\s*$/i.test(line)) {
      closeList();
      const block = [];
      let r = li + 1;
      while (r < lines.length && !/^:::\s*$/.test(lines[r])) { block.push(lines[r]); r += 1; }
      const [left, right] = splitRecipeColumns(block);
      const renderCol = (text) => (text.trim() ? renderMarkdown(text) : '');
      html += `<table class="recipe-table"><tbody><tr><td class="recipe-col">${renderCol(left)}</td><td class="recipe-col">${renderCol(right)}</td></tr></tbody></table>`;
      li = r;
      continue;
    }
    // GFM table: a header row immediately followed by a |---|---| delimiter row.
    if (line.includes('|') && li + 1 < lines.length) {
      const aligns = tableAligns(lines[li + 1]);
      const header = aligns ? splitTableRow(line) : null;
      if (aligns && header && header.length === aligns.length) {
        closeList();
        const rows = [];
        let r = li + 2;
        while (r < lines.length && lines[r].trim() !== '' && lines[r].includes('|')) {
          rows.push(splitTableRow(lines[r]));
          r += 1;
        }
        html += renderTable(header, aligns, rows);
        li = r - 1;
        continue;
      }
    }
    if (/^###\s+/.test(line)) { closeList(); html += `<h3>${inlineMarkdown(line.replace(/^###\s+/, ''))}</h3>`; continue; }
    if (/^##\s+/.test(line)) { closeList(); html += `<h2>${inlineMarkdown(line.replace(/^##\s+/, ''))}</h2>`; continue; }
    if (/^#\s+/.test(line)) { closeList(); html += `<h1>${inlineMarkdown(line.replace(/^#\s+/, ''))}</h1>`; continue; }
    if (/^[-*_]{3,}\s*$/.test(line)) { closeList(); html += '<hr>'; continue; }
    const taskMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
      const checked = taskMatch[1].toLowerCase() === 'x';
      html += `<li class="task"><span class="task-box${checked ? ' checked' : ''}" aria-hidden="true"></span>${inlineMarkdown(taskMatch[2])}</li>`;
      continue;
    }
    const unorderedMatch = line.match(/^[-*]\s+(.*)$/);
    if (unorderedMatch) {
      if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
      html += `<li>${inlineMarkdown(unorderedMatch[1])}</li>`;
      continue;
    }
    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      if (!inList || listType !== 'ol') { closeList(); html += '<ol>'; inList = true; listType = 'ol'; }
      html += `<li>${inlineMarkdown(orderedMatch[1])}</li>`;
      continue;
    }
    if (/^>\s?/.test(line)) { closeList(); html += `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    html += `<p>${inlineMarkdown(line)}</p>`;
  }
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


// ---- Folder-required invariant: a note never lives outside the sections ----
// Every entry path funnels through here. A note with no valid filing is
// placed into the first folder of the first section (creating the default
// "Notes" section when the workspace has none), so unfiled notes cannot
// exist. Returns true when the note was refiled.
function ensureNoteFiled(note) {
  if (!note || note.deleted) return false;
  if (note.sections && typeof note.sections === 'object') {
    for (const [secId, folder] of Object.entries(note.sections)) {
      if (typeof folder !== 'string' || !folder.trim()) continue;
      const section = customSections.find((entry) => entry.id === secId);
      if (section && section.folders.includes(folder)) return false; // validly filed
    }
    // Filings exist but all stale: drop them so re-filing picks a fresh home.
    const stale = Object.entries(note.sections).filter(([, folder]) => typeof folder !== 'string' || !folder.trim()
      || !customSections.some((entry) => entry.id && entry.folders.includes(folder)));
    if (stale.length === Object.keys(note.sections).length) note.sections = {};
  }
  // Resolve a destination: first folder of the first section; else create
  // the default section (welcome seed shape) so the note always has a home.
  let target = customSections.find((entry) => entry.folders.length);
  if (!target) {
    target = { id: WELCOME_SECTION_ID, name: 'Notes', folders: [...WELCOME_FOLDERS] };
    customSections.unshift(target);
  }
  note.sections = { [target.id]: target.folders[0] };
  return true;
}

// Sweep every live note through the invariant (boot, import, restore, sync).
function enforceFilingInvariant() {
  let changed = false;
  notes.forEach((note) => { if (ensureNoteFiled(note)) changed = true; });
  if (changed) {
    persistNotes();
    renderCustomSections();
    renderNoteList();
  }
  return changed;
}

// ---- Nested folders: a folder path is segments joined with FOLDER_SEP
// ("Work / Projects"). All folder namespaces share
// these helpers; matching is always exact-path or proper-descendant.
const FOLDER_SEP = ' / ';
// Folders may nest twice (top-level -> sub -> sub-sub); a third level is not
// allowed. folderDepth() returns 0 for top-level, 1 for a sub, 2 for the
// deepest allowed sub-sub, so depth >= 2 cannot host another subfolder.
const MAX_SUBFOLDER_PARENT_DEPTH = 2;

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

// Icon name by nesting depth: parent (solid) -> subfolder (outline) ->
// sub-subfolder and deeper (bold nested outline).
function folderIconForDepth(depth) {
  if (depth <= 0) return 'folder-solid';
  if (depth === 1) return 'folder';
  return 'folder-deep';
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
  else if (activeView === 'shared') listHeading.textContent = 'Shared';
  else if (activeView === 'archive') listHeading.textContent = `Archive${suffix}`;
  else if (activeView === 'favorites') listHeading.textContent = 'Starred notes';
  else if (activeCustom) listHeading.textContent = `${activeCustom.folder ? folderLeaf(activeCustom.folder) : sectionDisplayName('custom', activeCustom.section)}${suffix}`;
  else listHeading.textContent = activeFilter === 'favorites' ? 'Starred notes' : activeFilter === 'recent' ? 'Recent notes' : 'All Notes';
  // Collapsed-strip name mirrors the heading (dev), rendered vertically.
  try {
    const viewIcon = document.getElementById('workspace-view-icon');
    if (viewIcon) {
      const name = listHeading.textContent || '';
      viewIcon.textContent = name.trim() || '?';
      viewIcon.title = listHeading.textContent;
    }
  } catch (error) {}
}

// Clear the search box and its in-memory query.
function clearSearch() {
  searchQuery = '';
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
}

// ---- Open-note tabs (dev): many notes open at once, replacing breadcrumbs ----
let openTabs = []; // [{ id, vault }] in opening order, capped
const MAX_OPEN_TABS = 20;
// List glyph shared by the note list, tabs and strip. Recipes and to-dos keep
// their distinctive glyphs; everything else gets its file-type icon.
function noteGlyphFor(note) {
  if (note && note.template === 'recipe') return 'cooking';
  if (note && note.template === 'todo') return 'todo';
  const ext = note && note.ext;
  if (ext === 'txt') return 'type-txt';
  if (ext === 'json') return 'type-json';
  if (ext === 'yaml') return 'type-yaml';
  return 'type-md';
}
function findTabbedNote(id, isVault, isShared) {
  if (isShared) {
    const meta = sharedNoteMeta.get(String(id)) || sharedNoteMeta.get(id);
    return { id, title: (meta && meta.title) || 'Shared note', template: (meta && meta.template) || '', shared: true, deleted: false };
  }
  if (isVault) return vault.unlocked ? vault.notes.find((entry) => entry.id === id) || null : null;
  return notes.find((entry) => entry.id === id) || null;
}
// Remember an opened note; selecting a tab never moves it — order is fixed
// by opening time. Evict oldest non-active past the cap.
function trackTab(id, isVault, isShared) {
  const shared = Boolean(isShared);
  let tabId = id;
  if (shared) {
    tabId = Number(id);
    if (!Number.isInteger(tabId) || tabId <= 0) return;
  } else if (!isValidNoteId(id)) return;
  const wasVault = Boolean(isVault);
  if (!openTabs.some((tab) => String(tab.id) === String(tabId) && tab.vault === wasVault && Boolean(tab.shared) === shared)) {
    openTabs.push({ id: tabId, vault: wasVault, shared });
  }
  while (openTabs.length > MAX_OPEN_TABS) {
    const dropAt = openTabs.findIndex((tab) => !(tab.id === currentId && !tab.vault)
      && !(tab.id === currentVaultId && tab.vault)
      && !(tab.shared && collab.noteId != null && String(tab.id) === String(collab.noteId)));
    openTabs.splice(dropAt === -1 ? 0 : dropAt, 1);
  }
}
// Close one tab; when it was active, fall back to the nearest surviving
// neighbor (next, then previous, then outward) so selection stays put.
function closeTab(id, isVault, isShared) {
  const wasVault = Boolean(isVault);
  const wasShared = Boolean(isShared);
  const wasActive = wasShared
    ? (collab.noteId != null && String(collab.noteId) === String(id))
    : (!wasVault && id === currentId) || (wasVault && id === currentVaultId);
  const closedAt = openTabs.findIndex((tab) => String(tab.id) === String(id) && tab.vault === wasVault && Boolean(tab.shared) === wasShared);
  openTabs = openTabs.filter((tab) => !(String(tab.id) === String(id) && tab.vault === wasVault && Boolean(tab.shared) === wasShared));
  if (wasActive) {
    const order = [];
    const at = closedAt === -1 ? openTabs.length : closedAt;
    if (at < openTabs.length) order.push(at);
    for (let d = 1; d < openTabs.length; d += 1) {
      if (at - d >= 0) order.push(at - d);
      if (at + d < openTabs.length) order.push(at + d);
    }
    for (const i of order) {
      if (findTabbedNote(openTabs[i].id, openTabs[i].vault, openTabs[i].shared)) {
        if (openTabs[i].shared) openCollabNote(openTabs[i].id);
        else if (openTabs[i].vault) selectVaultNote(openTabs[i].id);
        else selectNote(openTabs[i].id);
        renderTabs();
        return;
      }
    }
    if (collab.noteId != null) closeCollabNote();
    currentId = null;
    currentVaultId = null;
    clearEditor();
  }
  renderTabs();
}
// Paint the strip; drop tabs whose notes are gone (purged, vault locked) or
// binned — a deleted note leaves the tabs at once.
function renderTabs() {
  const bar = document.getElementById('tab-bar');
  if (!bar) return;
  openTabs = openTabs.filter((tab) => {
    const note = findTabbedNote(tab.id, tab.vault, tab.shared);
    return note && !note.deleted;
  });
  // No tabs, no collapse toggle.
  try {
    const collapseBtn = document.getElementById('toggle-workspace');
    if (collapseBtn) collapseBtn.hidden = openTabs.length === 0;
  } catch (error) {}
  const activeAlive = (currentId && notes.some((entry) => entry.id === currentId))
    || (currentVaultId && vault.unlocked && vault.notes.some((entry) => entry.id === currentVaultId))
    || (collab.noteId != null && openTabs.some((tab) => tab.shared && String(tab.id) === String(collab.noteId)));
  if ((currentId || currentVaultId || collab.noteId != null) && !activeAlive) {
    const fallback = [...openTabs].reverse().find((tab) => findTabbedNote(tab.id, tab.vault, tab.shared));
    if (fallback) {
      if (fallback.shared) openCollabNote(fallback.id);
      else if (fallback.vault) selectVaultNote(fallback.id);
      else selectNote(fallback.id);
      return; // selecting re-renders the strip
    }
    currentId = null;
    currentVaultId = null;
    if (collab.noteId != null) closeCollabNote();
    clearEditor();
    return; // clearing re-renders the strip
  }
  bar.innerHTML = `<button type="button" class="tab-home" data-tab-home title="All Notes" aria-label="All Notes">${icon('inbox')}</button>`
    + openTabs.map((tab) => {
      const note = findTabbedNote(tab.id, tab.vault, tab.shared);
      const title = (note && note.title) || 'Untitled note';
      const active = tab.shared
        ? (collab.noteId != null && String(tab.id) === String(collab.noteId))
        : ((!tab.vault && tab.id === currentId) || (tab.vault && tab.id === currentVaultId));
      return `<button type="button" class="tab-item${active ? ' active' : ''}" draggable="true" data-tab-id="${escapeHtml(String(tab.id))}" data-tab-vault="${tab.vault ? '1' : ''}" data-tab-shared="${tab.shared ? '1' : ''}" title="${escapeHtml(title)}">`
        + `<span class="tab-glyph">${icon(tab.shared ? 'share' : noteGlyphFor(note))}</span>`
        + `<span class="tab-label">${escapeHtml(title)}</span>`
        + `<span class="tab-close" data-tab-close="${escapeHtml(String(tab.id))}" data-tab-close-vault="${tab.vault ? '1' : ''}" data-tab-close-shared="${tab.shared ? '1' : ''}" role="button" aria-label="Close ${escapeHtml(title)}">×</span>`
        + `</button>`;
    }).join('')
    + `<button type="button" class="tab-overflow" data-tab-overflow title="More tabs" aria-label="More tabs" hidden><span data-overflow-count></span>${icon('chevron-down')}</button>`;
  fitTabStrip(bar);
}
// Overflowed tabs (id/vault/title) from the last fit; powers the dropdown.
let lastOverflowTabs = [];
let tabOverflowOpen = false;
function closeTabOverflow() {
  tabOverflowOpen = false;
  const menu = document.getElementById('tab-overflow-menu');
  if (menu) menu.hidden = true;
}
// Hide whatever does not fit; the active tab always stays, earliest others
// fill the rest, and the remainder goes to the dropdown button. No scrollbar.
function fitTabStrip(bar) {
  const btn = bar.querySelector('[data-tab-overflow]');
  const tabs = [...bar.querySelectorAll('[data-tab-id]')];
  if (!btn || !bar.clientWidth) {
    if (btn) btn.hidden = true;
    lastOverflowTabs = [];
    closeTabOverflow();
    return;
  }
  const gap = 6;
  const home = bar.querySelector('[data-tab-home]');
  const homeW = home ? home.offsetWidth : 0;
  const widths = new Map(tabs.map((tab) => [tab, tab.offsetWidth]));
  const totalTabs = tabs.reduce((sum, tab) => sum + widths.get(tab) + gap, 0);
  if (homeW + gap + totalTabs <= bar.clientWidth) {
    btn.hidden = true;
    tabs.forEach((tab) => { tab.hidden = false; });
    lastOverflowTabs = [];
    closeTabOverflow();
    return;
  }
  btn.hidden = false;
  const btnW = btn.offsetWidth;
  const activeEl = bar.querySelector('.tab-item.active');
  const visible = new Set();
  let used = homeW + gap + btnW + gap;
  if (activeEl) { visible.add(activeEl); used += widths.get(activeEl) + gap; }
  for (const tab of tabs) {
    if (visible.has(tab)) continue;
    if (used + widths.get(tab) <= bar.clientWidth) { visible.add(tab); used += widths.get(tab) + gap; }
  }
  const hidden = [];
  tabs.forEach((tab) => {
    const hide = !visible.has(tab);
    tab.hidden = hide;
    if (hide) hidden.push({ id: tab.dataset.tabId, vault: tab.dataset.tabVault === '1', shared: tab.dataset.tabShared === '1', title: tab.title });
  });
  lastOverflowTabs = hidden;
  const countEl = btn.querySelector('[data-overflow-count]');
  if (countEl) countEl.textContent = hidden.length ? `+${hidden.length}` : '';
  btn.setAttribute('aria-label', `${hidden.length} more tabs`);
  if (!hidden.length) { closeTabOverflow(); return; }
  if (tabOverflowOpen) { paintTabOverflow(); placeTabOverflow(); }
}
function paintTabOverflow() {
  const menu = document.getElementById('tab-overflow-menu');
  if (!menu) return;
  menu.innerHTML = lastOverflowTabs.map((tab) => {
    const note = findTabbedNote(tab.id, tab.vault, tab.shared);
    const title = (note && note.title) || tab.title || 'Untitled note';
    return `<button type="button" class="context-item" data-otab-id="${escapeHtml(String(tab.id))}" data-otab-vault="${tab.vault ? '1' : ''}" data-otab-shared="${tab.shared ? '1' : ''}" title="${escapeHtml(title)}">`
      + `<span class="tab-glyph">${icon(tab.shared ? 'share' : noteGlyphFor(note))}</span>`
      + `<span class="tab-label">${escapeHtml(title)}</span>`
      + `<span class="tab-close" data-otab-close="${escapeHtml(String(tab.id))}" data-otab-close-vault="${tab.vault ? '1' : ''}" data-otab-close-shared="${tab.shared ? '1' : ''}" role="button" aria-label="Close ${escapeHtml(title)}">×</span>`
      + `</button>`;
  }).join('');
}
function placeTabOverflow() {
  const menu = document.getElementById('tab-overflow-menu');
  const bar = document.getElementById('tab-bar');
  if (!menu || !bar) return;
  const btn = bar.querySelector('[data-tab-overflow]');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}
function toggleTabOverflow() {
  const menu = document.getElementById('tab-overflow-menu');
  if (!menu) return;
  if (tabOverflowOpen) { closeTabOverflow(); return; }
  if (!lastOverflowTabs.length) return;
  tabOverflowOpen = true;
  paintTabOverflow();
  menu.hidden = false;
  placeTabOverflow();
}
const tabBarEl = document.getElementById('tab-bar');
if (tabBarEl) tabBarEl.addEventListener('click', (event) => {
  if (tabClickSuppressed) return;
  const closer = event.target.closest('[data-tab-close]');
  if (closer) {
    event.stopPropagation();
    closeTab(closer.dataset.tabClose, closer.dataset.tabCloseVault === '1', closer.dataset.tabCloseShared === '1');
    return;
  }
  if (event.target.closest('[data-tab-overflow]')) { toggleTabOverflow(); return; }
  if (event.target.closest('[data-tab-home]')) { goAllNotes(); return; }
  const tab = event.target.closest('[data-tab-id]');
  if (!tab) return;
  if (tab.dataset.tabShared === '1') openCollabNote(tab.dataset.tabId);
  else if (tab.dataset.tabVault === '1') selectVaultNote(tab.dataset.tabId);
  else selectNote(tab.dataset.tabId);
});
// Drag-and-drop reordering of tabs (order is otherwise fixed by opening time).
let dragTabEl = null;
let dragTabIndex = null;
let tabClickSuppressed = false;
function clearTabDropMarks() {
  if (!tabBarEl) return;
  tabBarEl.querySelectorAll('.tab-drop-before, .tab-drop-after').forEach((el) => el.classList.remove('tab-drop-before', 'tab-drop-after'));
}
function endTabDrag() {
  if (dragTabEl) dragTabEl.classList.remove('dragging');
  clearTabDropMarks();
  dragTabEl = null;
  dragTabIndex = null;
  tabClickSuppressed = true;
  setTimeout(() => { tabClickSuppressed = false; }, 250);
}
if (tabBarEl) tabBarEl.addEventListener('dragstart', (event) => {
  const tab = event.target.closest('[data-tab-id]');
  if (!tab) return;
  dragTabEl = tab;
  dragTabIndex = [...tabBarEl.querySelectorAll('[data-tab-id]')].indexOf(tab);
  tab.classList.add('dragging');
  try { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tab.dataset.tabId || ''); } catch (error) {}
});
if (tabBarEl) tabBarEl.addEventListener('dragover', (event) => {
  if (dragTabIndex == null) return;
  event.preventDefault();
  try { event.dataTransfer.dropEffect = 'move'; } catch (error) {}
  const over = event.target.closest('[data-tab-id]');
  clearTabDropMarks();
  if (!over || over === dragTabEl) return;
  const rect = over.getBoundingClientRect();
  over.classList.add(event.clientX > rect.left + rect.width / 2 ? 'tab-drop-after' : 'tab-drop-before');
});
if (tabBarEl) tabBarEl.addEventListener('drop', (event) => {
  if (dragTabIndex == null) return;
  event.preventDefault();
  const over = event.target.closest('[data-tab-id]');
  if (over && over !== dragTabEl) {
    const tabs = [...tabBarEl.querySelectorAll('[data-tab-id]')];
    let to = tabs.indexOf(over);
    const rect = over.getBoundingClientRect();
    if (event.clientX > rect.left + rect.width / 2) to += 1;
    if (dragTabIndex < to) to -= 1;
    const [moved] = openTabs.splice(dragTabIndex, 1);
    if (moved) {
      openTabs.splice(Math.max(0, Math.min(openTabs.length, to)), 0, moved);
      renderTabs();
    }
  }
  endTabDrag();
});
if (tabBarEl) tabBarEl.addEventListener('dragend', endTabDrag);

const tabOverflowMenuEl = document.getElementById('tab-overflow-menu');
if (tabOverflowMenuEl) tabOverflowMenuEl.addEventListener('click', (event) => {
  const closer = event.target.closest('[data-otab-close]');
  if (closer) {
    event.stopPropagation();
    closeTab(closer.dataset.otabClose, closer.dataset.otabCloseVault === '1', closer.dataset.otabCloseShared === '1');
    return;
  }
  const row = event.target.closest('[data-otab-id]');
  if (!row) return;
  if (row.dataset.otabShared === '1') openCollabNote(row.dataset.otabId);
  else if (row.dataset.otabVault === '1') selectVaultNote(row.dataset.otabId);
  else selectNote(row.dataset.otabId);
  closeTabOverflow();
});
document.addEventListener('click', (event) => {
  if (tabOverflowOpen && !event.target.closest('#tab-overflow-menu') && !event.target.closest('[data-tab-overflow]')) closeTabOverflow();
});
window.addEventListener('resize', () => {
  closeTabOverflow();
  try { renderTabs(); } catch (error) {}
  try { updateStripScrollButton(); } catch (error) {}
});

// Collapsed workspace strip. With the sidebar expanded it behaves as before:
// inside a folder it lists that folder's notes plus immediate subfolders.
// With the sidebar COLLAPSED the slide menu shows sections only, so this
// strip becomes the folder navigator: every folder of the active section (or
// of all sections when no section is selected) renders as its colored dot;
// clicking one opens it. Gold folder glyphs stay distinct from note glyphs.
function renderStripItems() {
  const box = document.getElementById('workspace-strip-items');
  if (!box) return;
  const section = activeCustom ? customSections.find((entry) => entry.id === activeCustom.section) : null;
  const folder = activeCustom ? activeCustom.folder : null;
  // Back button sits under the collapse toggle, over the folder name —
  // visible only inside a subfolder.
  const backBtn = document.getElementById('workspace-strip-back');
  if (activeView === 'vault' || activeView === 'shared') {
    box.innerHTML = '';
    if (backBtn) {
      backBtn.hidden = true;
      delete backBtn.dataset.stripSection;
      delete backBtn.dataset.stripTarget;
    }
    updateStripScrollButton();
    return;
  }
  // Folder navigation is always on in the strip (folders no longer live in
  // the slide menu in any state). Folders render as a tree: each subfolder
  // sits indented under its parent, preserving the section's list order.
  // Notes join the strip only while inside a folder, after the tree.
  const sections = section ? [section] : customSections.slice();
  let html = '';
  sections.forEach((sec) => {
    if (!sec.folders.length) return;
    if (!section && sections.length > 1) {
      html += `<span class="strip-section-tag" title="${escapeHtml(sec.name)}" aria-hidden="true">${escapeHtml(sec.name.charAt(0).toUpperCase() || '?')}</span>`;
    }
    // When a folder is selected the strip is scoped to that folder's branch:
    // it shows only the folder and its contents (its subfolders). Otherwise
    // the whole section tree is shown for navigation.
    const pool = (section && folder)
      ? [folder, ...sec.folders.filter((name) => name !== folder && isFolderOrSub(name, folder))]
      : sec.folders;
    const childrenOf = new Map();
    const roots = [];
    pool.forEach((name) => {
      const parent = folderParent(name);
      if (parent && pool.includes(parent)) {
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(name);
      } else roots.push(name);
    });
    const emitted = new Set();
    const emitFolder = (name) => {
      if (emitted.has(name)) return;
      emitted.add(name);
      const depth = folderDepth(name);
      const activeDot = section && folder === name;
      const glyph = `<span class="strip-folder-glyph ${customFolderColor(sec, name)}">${icon(folderIconForDepth(depth))}</span>`;
      html += `<button type="button" class="strip-btn is-folder${depth > 0 ? ' is-subfolder' : ''}${depth > 1 ? ' is-deep' : ''}${activeDot ? ' is-dot-active' : ''}" data-strip-section="${escapeHtml(sec.id)}" data-strip-folder="${escapeHtml(name)}" title="${escapeHtml(sec.name)} / ${escapeHtml(name)}" aria-label="Open ${escapeHtml(folderLeaf(name))}">${glyph}</button>`;
      (childrenOf.get(name) || []).forEach(emitFolder);
    };
    roots.forEach(emitFolder);
    pool.forEach(emitFolder);
  });
  // Inside a folder: append its direct notes beneath the folder icons.
  if (section && folder && activeView !== 'bin') {
    const pool = visibleNotes().filter((note) => !note.deleted);
    const direct = pool.filter((note) => customNoteFolder(note, section.id) === folder);
    if (direct.length) html += `<span class="strip-section-tag" title="Notes in ${escapeHtml(folderLeaf(folder))}" aria-hidden="true">·</span>`;
    html += direct.map((note) => `<button type="button" class="strip-btn${note.id === currentId ? ' is-note-active' : ''}" data-strip-note="${escapeHtml(String(note.id))}" title="${escapeHtml(note.title || 'Untitled note')}" aria-label="Open ${escapeHtml(note.title || 'Untitled note')}">${icon(noteGlyphFor(note))}</button>`).join('');
  }
  box.innerHTML = html;
  if (backBtn) {
    // Back is available anywhere inside a folder: up to the parent folder
    // when nested, otherwise back to the section root (no folder selected).
    if (section && folder) {
      const parent = folderParent(folder);
      backBtn.hidden = false;
      backBtn.dataset.stripSection = section.id;
      backBtn.dataset.stripTarget = parent || '';
      if (parent) {
        backBtn.title = `${parent} — back to parent folder`;
        backBtn.setAttribute('aria-label', `Back to ${folderLeaf(parent)}`);
      } else {
        backBtn.title = `${section.name} — back to section`;
        backBtn.setAttribute('aria-label', `Back to ${section.name}`);
      }
    } else {
      backBtn.hidden = true;
      delete backBtn.dataset.stripSection;
      delete backBtn.dataset.stripTarget;
    }
  }
  updateStripScrollButton();
}
const stripBoxEl = document.getElementById('workspace-strip-items');
if (stripBoxEl) {
  stripBoxEl.addEventListener('scroll', updateStripScrollButton, { passive: true });
  stripBoxEl.addEventListener('click', (event) => {
    const sub = event.target.closest('[data-strip-folder]');
    if (sub) { selectCustomFolder(sub.dataset.stripSection, sub.dataset.stripFolder); return; }
    const item = event.target.closest('[data-strip-note]');
    if (item) selectNote(item.dataset.stripNote);
  });
  // Right-click a strip folder: same menu as everywhere else (Open / New note
  // / Rename / New subfolder / Delete).
  stripBoxEl.addEventListener('contextmenu', (event) => {
    const sub = event.target.closest('[data-strip-folder]');
    if (!sub) return;
    event.preventDefault();
    event.stopPropagation();
    openFolderContextMenu('custom', sub.dataset.stripFolder, event.clientX, event.clientY, sub.dataset.stripSection);
  });
}
const stripBackEl = document.getElementById('workspace-strip-back');
if (stripBackEl) stripBackEl.addEventListener('click', (event) => {
  event.preventDefault();
  const sectionId = stripBackEl.dataset.stripSection;
  if (!sectionId) return;
  const target = stripBackEl.dataset.stripTarget;
  if (target) selectCustomFolder(sectionId, target);
  else selectCustomSection(sectionId);
});

// Strip overflow: when the dots/notes do not fit the strip height, a
// scroll buttons appear above/below the strip (never a scrollbar): a down
// arrow when there is more below, and an up arrow once scrolled down. Clicking
// pages one viewport of items; both hide automatically at their ends.
function makeStripScrollButton(id, dir, glyphName, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `strip-scroll-btn strip-scroll-${dir}`;
  btn.id = id;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.innerHTML = icon(glyphName);
  return btn;
}
const stripScrollUp = makeStripScrollButton('strip-scroll-up', 'up', 'chevron-up', 'Scroll up');
const stripScrollDown = makeStripScrollButton('strip-scroll-down', 'down', 'chevron-down', 'Scroll down');
if (stripBoxEl && stripBoxEl.parentElement) {
  stripBoxEl.insertAdjacentElement('beforebegin', stripScrollUp);
  stripBoxEl.insertAdjacentElement('afterend', stripScrollDown);
  stripScrollUp.addEventListener('click', () => {
    stripBoxEl.scrollBy({ top: -stripBoxEl.clientHeight, behavior: 'smooth' });
  });
  stripScrollDown.addEventListener('click', () => {
    stripBoxEl.scrollBy({ top: stripBoxEl.clientHeight, behavior: 'smooth' });
  });
}
function updateStripScrollButton() {
  if (!stripBoxEl) return;
  const collapsible = document.querySelector('.app-shell.workspace-collapsed:not(.workspace-focus)');
  const canUp = stripBoxEl.scrollTop > 1;
  const canDown = stripBoxEl.scrollTop + stripBoxEl.clientHeight < stripBoxEl.scrollHeight - 1;
  if (stripScrollUp) stripScrollUp.classList.toggle('is-visible', Boolean(collapsible && canUp));
  if (stripScrollDown) stripScrollDown.classList.toggle('is-visible', Boolean(collapsible && canDown));
}

// Rebuild the clickable breadcrumb trail: [view] [/ folder] / [note title].
// The title element itself is persistent (editor writes to it directly); only
// the trail prefix is re-rendered here.
function viewLabel(view) {
  if (view === 'favorites') return 'Starred notes';
  if (view === 'archive') return 'Archive';
  if (view === 'bin') return 'Bin';
  if (view === 'vault') return 'Vault';
  return 'All Notes';
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
  root.title = 'Back to All Notes';
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
  if (activeView === 'vault' || activeView === 'shared') return [];
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
    const matchesSearch = noteMatchesSearch(note, searchQuery);
    const matchesFilter = activeFilter === 'all' || (activeFilter === 'favorites' && note.favorite) || (activeFilter === 'recent' && isRecentNote(note));
    const matchesCustom = !activeCustom || (customNoteFolder(note, activeCustom.section) !== null
      && (!activeCustom.folder || isFolderOrSub(customNoteFolder(note, activeCustom.section), activeCustom.folder)));
    return matchesSearch && matchesFilter && matchesCustom;
  });
}

// Sidebar search. Plain terms match file text (title + contents) and folder
// names only — tags are excluded. `tag: <name>` matches tags and `body: <text>`
// matches the note body. Terms are AND-ed.
function noteMatchesSearch(note, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  const title = typeof note.title === 'string' ? note.title : '';
  const body = typeof note.body === 'string' ? note.body : '';
  const folders = note.sections && typeof note.sections === 'object'
    ? Object.values(note.sections).filter((value) => typeof value === 'string').join(' ')
    : '';
  const tags = (Array.isArray(note.tags) ? note.tags : []).filter((t) => typeof t === 'string').map((t) => t.toLowerCase());
  const tokens = q.split(/\s+/).filter(Boolean);
  const tagTerms = [];
  const bodyTerms = [];
  const textTerms = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'tag:') {
      const name = tokens[i + 1];
      if (!name) return false; // a bare "tag:" matches nothing until a name is typed
      tagTerms.push(name);
      i += 1;
    } else if (token.startsWith('tag:') && token.length > 4) {
      tagTerms.push(token.slice(4));
    } else if (token === 'body:') {
      const text = tokens[i + 1];
      if (!text) return false; // a bare "body:" matches nothing until text is typed
      bodyTerms.push(text);
      i += 1;
    } else if (token.startsWith('body:') && token.length > 5) {
      bodyTerms.push(token.slice(5));
    } else {
      textTerms.push(token);
    }
  }
  const tagMatch = tagTerms.every((term) => tags.some((tag) => tag.includes(term)));
  const bodyHay = body.toLowerCase();
  const bodyMatch = bodyTerms.every((term) => bodyHay.includes(term));
  const haystack = `${title} ${body} ${folders}`.toLowerCase();
  const textMatch = textTerms.every((term) => haystack.includes(term));
  return tagMatch && bodyMatch && textMatch;
}

// Search a shared-note inbox entry. Title/folder/tags are in the decrypted meta;
// `body:` matches against a session cache of note bodies (populated whenever a
// shared note is opened — bodies live in the CRDT and aren't loaded for the list).
function sharedNoteMatchesSearch(entry, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  const title = typeof entry.title === 'string' ? entry.title : '';
  const folder = typeof entry.folder === 'string' ? entry.folder : '';
  const tags = (Array.isArray(entry.tags) ? entry.tags : []).filter((t) => typeof t === 'string').map((t) => t.toLowerCase());
  const body = sharedBodyCache.get(String(entry.id)) || '';
  const tokens = q.split(/\s+/).filter(Boolean);
  const tagTerms = [];
  const bodyTerms = [];
  const textTerms = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'tag:') {
      const name = tokens[i + 1];
      if (!name) return false;
      tagTerms.push(name);
      i += 1;
    } else if (token.startsWith('tag:') && token.length > 4) {
      tagTerms.push(token.slice(4));
    } else if (token === 'body:') {
      const text = tokens[i + 1];
      if (!text) return false;
      bodyTerms.push(text);
      i += 1;
    } else if (token.startsWith('body:') && token.length > 5) {
      bodyTerms.push(token.slice(5));
    } else {
      textTerms.push(token);
    }
  }
  if (tagTerms.length && !tags.length) return false;
  const tagMatch = tagTerms.every((term) => tags.some((tag) => tag.includes(term)));
  const bodyHay = body.toLowerCase();
  const bodyMatch = bodyTerms.every((term) => bodyHay.includes(term));
  const haystack = `${title} ${folder}`.toLowerCase();
  const textMatch = textTerms.every((term) => haystack.includes(term));
  return tagMatch && bodyMatch && textMatch;
}

// Notes in the current view + selected folder, ignoring the search box and
// the All/Recent/Starred chip — so the chips mirror the selected folder.
function scopeNotes() {
  if (activeView === 'vault') return vault.unlocked ? [...vault.notes] : [];
  if (activeView === 'shared') return [];
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

// ---- JSON/YAML syntax highlighting ---------------------------------------
// The editing textarea cannot render colors, so a pre overlay behind it paints
// colored tokens while the textarea text runs transparent. Both share font,
// padding and line-height so the glyphs sit exactly on top of each other.
const syntaxLayer = document.getElementById('syntax-layer');

function highlightJson(text) {
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false)\b|\b(null)\b|(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|([{}\[\],:])/g;
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    out += escapeHtml(text.slice(last, match.index));
    if (match[1] !== undefined) {
      out += `<span class="tok-${match[2] ? 'key' : 'string'}">${escapeHtml(match[1])}</span>`;
      if (match[2]) out += `<span class="tok-punct">${escapeHtml(match[2])}</span>`;
    } else if (match[3] !== undefined) {
      out += `<span class="tok-number">${escapeHtml(match[3])}</span>`;
    } else if (match[4] !== undefined) {
      out += `<span class="tok-bool">${escapeHtml(match[4])}</span>`;
    } else if (match[5] !== undefined) {
      out += `<span class="tok-bool">${escapeHtml(match[5])}</span>`;
    } else if (match[6] !== undefined) {
      out += `<span class="tok-comment">${escapeHtml(match[6])}</span>`;
    } else {
      out += `<span class="tok-punct">${escapeHtml(match[7])}</span>`;
    }
    last = re.lastIndex;
  }
  return out + escapeHtml(text.slice(last));
}

// Index of a # comment start, ignoring # inside quotes.
function yamlCommentAt(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}

function highlightYamlValue(text) {
  const re = /("(?:\\.|[^"\\])*"|'(?:''|[^'])*')|(-?\d+(?:\.\d+)?)|\b(true|false|null|yes|no|on|off|~)\b|(&\w+|\*\w+)/gi;
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    out += escapeHtml(text.slice(last, match.index));
    if (match[1] !== undefined) out += `<span class="tok-string">${escapeHtml(match[1])}</span>`;
    else if (match[2] !== undefined) out += `<span class="tok-number">${escapeHtml(match[2])}</span>`;
    else if (match[3] !== undefined) out += `<span class="tok-bool">${escapeHtml(match[3])}</span>`;
    else out += `<span class="tok-anchor">${escapeHtml(match[4])}</span>`;
    last = re.lastIndex;
  }
  return out + escapeHtml(text.slice(last));
}

function highlightYaml(text) {
  return String(text).split('\n').map((line) => {
    let content = line;
    let comment = '';
    const commentAt = yamlCommentAt(content);
    if (commentAt >= 0) { comment = content.slice(commentAt); content = content.slice(0, commentAt); }
    let html = '';
    // key: optional indent, optional "- ", a name, then ":".
    const keyMatch = content.match(/^(\s*)(-\s+)?([^\s:#][^:\n]*?)(\s*:\s*|:\s*$|:$)/);
    if (keyMatch) {
      html += escapeHtml(keyMatch[1]);
      if (keyMatch[2]) html += `<span class="tok-punct">${escapeHtml(keyMatch[2])}</span>`;
      html += `<span class="tok-key">${escapeHtml(keyMatch[3])}</span>`;
      html += `<span class="tok-punct">${escapeHtml(keyMatch[4])}</span>`;
      content = content.slice(keyMatch[0].length);
    } else {
      const dash = content.match(/^(\s*)(-\s+)/);
      if (dash) {
        html += escapeHtml(dash[1]) + `<span class="tok-punct">${escapeHtml(dash[2])}</span>`;
        content = content.slice(dash[0].length);
      }
    }
    html += highlightYamlValue(content);
    if (comment) html += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
    return html;
  }).join('\n');
}

// Paint (or clear) the overlay for the open note. Only JSON/YAML are colored.
function updateSyntaxLayer(note, showPreview) {
  if (!syntaxLayer) return;
  const ext = note && note.ext;
  const lang = ext === 'json' ? 'json' : (ext === 'yaml' ? 'yaml' : null);
  if (!lang || showPreview) {
    syntaxLayer.hidden = true;
    syntaxLayer.innerHTML = '';
    markdownInput.classList.remove('is-highlighted');
    return;
  }
  const source = typeof note.body === 'string' ? note.body : markdownInput.value;
  const html = lang === 'json' ? highlightJson(source) : highlightYaml(source);
  syntaxLayer.className = `syntax-layer lang-${lang}`;
  // Trailing newline keeps the last line's height in sync with the textarea.
  syntaxLayer.innerHTML = `${html}\n`;
  syntaxLayer.hidden = false;
  markdownInput.classList.add('is-highlighted');
}

// ---- Beautify (JSON / YAML) ----------------------------------------------
// JSON: strict parse + 2-space re-emit (throws on invalid, surfaced as toast).
function beautifyJsonText(text) {
  return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
}

// YAML: safe normalization — tabs to spaces, trailing whitespace stripped,
// blank runs collapsed, and distinct indent depths remapped to 2-space steps
// (relative nesting preserved). Comments and values are left intact.
function beautifyYamlText(text) {
  const rawLines = String(text == null ? '' : text).replace(/\t/g, '  ').split('\n');
  const depths = [];
  rawLines.forEach((line) => {
    if (!line.trim()) return;
    const indent = (line.match(/^ */) || [''])[0].length;
    if (!depths.includes(indent)) depths.push(indent);
  });
  depths.sort((a, b) => a - b);
  const levelOf = new Map(depths.map((n, index) => [n, index]));
  const staged = rawLines.map((line) => {
    if (!line.trim()) return '';
    const match = line.match(/^( *)([\s\S]*)$/);
    const level = levelOf.get(match[1].length) || 0;
    let content = match[2].replace(/\s+$/, '');
    content = content.replace(/^-\s+/, '- ').replace(/^-$/, '-');
    // Collapse 2+ spaces after a simple "key:" into one (never touches URLs or
    // values with no gap, and unquoted leading spaces are insignificant).
    content = content.replace(/^((?:-\s+)?[A-Za-z_][\w .-]*?):[ \t]{2,}(\S)/, '$1: $2');
    return '  '.repeat(level) + content;
  });
  const cleaned = [];
  staged.forEach((line) => {
    if (!line) {
      if (cleaned.length && cleaned[cleaned.length - 1] !== '') cleaned.push('');
      return;
    }
    cleaned.push(line);
  });
  while (cleaned.length && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return `${cleaned.join('\n')}\n`;
}

// Apply the formatter to the open note (button is visible for json/yaml only).
function applyBeautify() {
  const note = activeEditorNote();
  if (!note || note.deleted || note.archived) return;
  if (note.ext !== 'json' && note.ext !== 'yaml') return;
  const source = typeof markdownInput.value === 'string' && markdownInput.value ? markdownInput.value : (note.body || '');
  let formatted;
  try {
    formatted = note.ext === 'json' ? beautifyJsonText(source) : beautifyYamlText(source);
  } catch (error) {
    showToast(note.ext === 'json' ? 'Invalid JSON — fix the syntax first' : 'Could not format this YAML');
    return;
  }
  if (formatted === source) { showToast('Already tidy'); return; }
  note.body = formatted;
  markdownInput.value = formatted;
  renderPreview(note);
  updateMeta(note);
  setSaveLabel('Saving...', 'green');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 200);
  showToast(`${note.ext === 'json' ? 'JSON' : 'YAML'} beautified`);
}

// Swap the writing area between Markdown source and rendered preview; non-Markdown notes never preview.
function renderPreview(note) {
  if (collab.noteId && collab.body) {
    note = { id: collab.noteId, title: collab.title ? collab.title.toString() : '',
             body: collab.body.toString(), ext: 'md', tags: [], favorite: false,
             archived: false, deleted: false };
  }
  const bottomHint = document.querySelector('.editor-bottom-fixed span:first-child');
  const isMd = note.ext === 'md';
  const plainLabel = note.ext === 'txt' ? 'Plain text' : (EXT_LABELS[note.ext] || 'MD');
  const showPreview = isMd && writeMode === 'preview';
  if (showPreview) preview.innerHTML = renderMarkdown(note.body);
  markdownInput.hidden = showPreview;
  preview.hidden = !showPreview;
  if (modeLabel) modeLabel.textContent = isMd ? (showPreview ? 'Preview' : 'Write') : plainLabel;
  // Preview toggle is for standard Markdown notes and recipes; to-dos and
  // every other file type have no preview.
  const showLivePreview = isMd && (!note.template || note.template === 'recipe');
  if (modeToggle) {
    modeToggle.hidden = !showLivePreview;
    modeToggle.textContent = showPreview ? 'Write' : 'Preview';
  }
  if (bottomHint) bottomHint.textContent = isMd ? 'Markdown' : plainLabel;
  if (typeBadge) typeBadge.textContent = EXT_LABELS[note.ext] || 'MD';
  if (beautifyBtn) beautifyBtn.hidden = !(note.ext === 'json' || note.ext === 'yaml');
  // Formatting toolbar returns only for notes carrying the "md" tag.
  const mdTagged = Array.isArray(note.tags) && note.tags.some((tag) => String(tag).toLowerCase() === 'md');
  if (editorToolbar) editorToolbar.hidden = !mdTagged;
  if (!showPreview) autogrow();
  updateSyntaxLayer(note, showPreview);
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
  // Recipe notes show the photo in the fixed hero below the meta row instead
  // of the banner above the title.
  const bannerUsable = usable && !(note && note.template === 'recipe');
  const heading = document.querySelector('.editor-heading');
  if (heading) heading.classList.toggle('has-cover', Boolean(bannerUsable));
  if (bannerUsable) {
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
      // Recipe notes add their photo from the fixed hero, never the banner row.
      setCoverAddHidden(!editable || (note && note.template === 'recipe'));
    }
  }
  renderRecipeHero(note);
}

// Fixed recipe hero (meal photo + description) between the meta row and the
// writing area. Editor chrome, not body text, so it cannot be deleted. The
// photo reuses the note cover (same picker, validation and E2EE storage);
// the src is re-validated on every render and assigned as a property.
function renderRecipeHero(note) {
  const hero = document.getElementById('recipe-hero');
  if (!hero) return;
  // A shared recipe note keeps its meal photo (Y.Map 'assets') and description
  // (Y.Text 'desc') in the collaborative doc; a local note uses its own fields.
  let template;
  let cover;
  let description;
  if (collab.noteId) {
    template = collab.template;
    cover = collab.cover;
    description = collab.desc ? collab.desc.toString() : '';
  } else {
    template = note && note.template;
    cover = note && note.cover;
    description = note && note.description;
  }
  const show = Boolean(template === 'recipe' && activeView !== 'vault');
  hero.hidden = !show;
  if (!show) { renderRecipeBody(note); return; }
  const usable = cleanCoverSrc(cover);
  const img = document.getElementById('recipe-photo-img');
  const empty = document.getElementById('recipe-photo-empty');
  if (img) {
    if (usable) {
      if (img.getAttribute('src') !== usable) img.setAttribute('src', usable);
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }
  if (empty) empty.hidden = Boolean(usable);
  const descEl = document.getElementById('recipe-desc');
  if (descEl) {
    const next = typeof description === 'string' ? description : '';
    if (document.activeElement !== descEl && descEl.value !== next) descEl.value = next;
  }
  renderRecipeBody(note);
}

// ---- Structured recipe body (Ingredients / Method) -----------------------
// Recipe notes never show their Markdown body; instead these editable fields
// are rendered as a two-column table. Local recipes store the lists on the
// note; shared recipes keep them in a Y.Map('recipe') in the collaborative doc.
function recipeDataForActive(note) {
  if (collab.noteId) {
    const data = { ingredients: [], steps: [] };
    if (!collab.recipe) return data;
    try { data.ingredients = sanitizeIngredients(JSON.parse(collab.recipe.get('ingredients') || '[]')); } catch (error) {}
    try { data.steps = sanitizeSteps(JSON.parse(collab.recipe.get('steps') || '[]')); } catch (error) {}
    return data;
  }
  if (note && note.template === 'recipe') {
    return { ingredients: sanitizeIngredients(note.ingredients), steps: sanitizeSteps(note.steps) };
  }
  return { ingredients: [], steps: [] };
}
function renderRecipeIngredients(list) {
  const box = document.getElementById('recipe-ingredients');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<p class="recipe-empty">No ingredients yet.</p>'; return; }
  box.innerHTML = list.map((item, i) => `
    <div class="recipe-row">
      <button type="button" class="recipe-check${item.d ? ' checked' : ''}" data-recipe-toggle="${i}" role="checkbox" aria-checked="${item.d ? 'true' : 'false'}" aria-label="Toggle ingredient"></button>
      <textarea class="recipe-input" data-recipe-ing="${i}" rows="1" placeholder="Ingredient" aria-label="Ingredient">${escapeHtml(item.t)}</textarea>
      <button type="button" class="recipe-remove" data-recipe-remove-ing="${i}" aria-label="Remove ingredient">&times;</button>
    </div>`).join('');
  box.querySelectorAll('textarea').forEach((area) => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; });
}
function renderRecipeSteps(list) {
  const box = document.getElementById('recipe-steps');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<p class="recipe-empty">No steps yet.</p>'; return; }
  box.innerHTML = list.map((step, i) => `
    <div class="recipe-row">
      <span class="recipe-num">${i + 1}.</span>
      <textarea class="recipe-input" data-recipe-step="${i}" rows="1" placeholder="Describe this step" aria-label="Step ${i + 1}">${escapeHtml(step)}</textarea>
      <button type="button" class="recipe-remove" data-recipe-remove-step="${i}" aria-label="Remove step">&times;</button>
    </div>`).join('');
  box.querySelectorAll('textarea').forEach((area) => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; });
}
function renderRecipeBody(note) {
  const wrap = document.getElementById('recipe-body');
  const panel = document.querySelector('.editor-panel');
  if (!wrap) return;
  const target = note || (collab.noteId ? null : currentNote());
  const isRecipe = activeView !== 'vault' && (collab.noteId ? collab.template === 'recipe' : Boolean(target && target.template === 'recipe'));
  if (panel) panel.classList.toggle('recipe-mode', isRecipe);
  wrap.hidden = !isRecipe;
  if (!isRecipe) return;
  const data = recipeDataForActive(target);
  renderRecipeIngredients(data.ingredients);
  renderRecipeSteps(data.steps);
}
// Edit the recipe lists for whichever source is open (local note or shared doc).
function recipeMutate(mutator) {
  if (collab.noteId) {
    if (!collab.recipe) return;
    const data = recipeDataForActive(null);
    mutator(data);
    collab.recipe.set('ingredients', JSON.stringify(sanitizeIngredients(data.ingredients)));
    collab.recipe.set('steps', JSON.stringify(sanitizeSteps(data.steps)));
    return;
  }
  const note = currentNote();
  if (!note || note.template !== 'recipe') return;
  const data = { ingredients: sanitizeIngredients(note.ingredients), steps: sanitizeSteps(note.steps) };
  mutator(data);
  note.ingredients = sanitizeIngredients(data.ingredients);
  note.steps = sanitizeSteps(data.steps);
  note.date = 'Now';
  note.updatedAt = Date.now();
  persistNotes();
}
function focusRecipeField(selector, index) {
  const fields = document.querySelectorAll(`.recipe-body-fixed ${selector}`);
  if (!fields.length) return;
  const at = (index === 'last') ? fields.length - 1 : Math.max(0, Math.min(fields.length - 1, Number(index) || 0));
  const el = fields[at];
  if (!el) return;
  el.focus();
  if (typeof el.setSelectionRange === 'function') {
    const n = el.value.length;
    try { el.setSelectionRange(n, n); } catch (error) {}
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

// Shared recipe notes keep their meal photo in the collaborative doc
// (Y.Map 'assets'), so every member sees the same picture.
function requestCollabCoverUpload() {
  exitCoverRepos(true);
  if (!collab.noteId || !isUnlocked()) return;
  const input = document.getElementById('cover-input');
  if (input) { input.value = ''; input.click(); }
}

async function handleCollabCoverFile(file) {
  if (!collab.noteId || !collab.assets) return;
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
    if (!collab.noteId || !collab.assets) return; // moved on mid-upload
    collab.assets.set('cover', clean);
    collab.cover = clean;
    renderRecipeHero(null);
    showToast(wasOptimized ? 'Meal photo added (optimized)' : 'Meal photo added');
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
  try { renderCollabPresence(); } catch (error) {}
  if (mode === 'edit') {
    resetIdleTimer();
    if (focus) {
      // Focus without jumping the caret to the end: setSelectionRange(end)
      // used to scroll the whole editor to the bottom on every Write click.
      try { markdownInput.focus({ preventScroll: true }); }
      catch (error) { markdownInput.focus(); }
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

// True when a drag event carries a Notely folder (slide-menu/workspace shared
// payload), as opposed to a note drag (text/plain) or a file hover.
function isFolderDrag(event) {
  try {
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
    return types.includes('application/x-notely-folder');
  } catch (error) { return false; }
}

// Resolve a workspace folder header to its section (same precedence as the
// folder context menu: active custom filter, then the list-section shell,
// then the folder owner).
function resolveListFolderTarget(header) {
  if (!header || !header.dataset.folder) return null;
  const wrap = header.closest('[data-folder-wrap]');
  const shell = header.closest('[data-list-section]');
  const shellKind = shell ? shell.dataset.listSection : null;
  let sectionId = activeCustom ? activeCustom.section : null;
  if (shellKind === 'custom') {
    const secBtn = shell.querySelector('[data-section-id]');
    if (secBtn && secBtn.dataset.sectionId) sectionId = secBtn.dataset.sectionId;
  }
  if (!sectionId && wrap) {
    const folder = wrap.dataset.folderWrap;
    const owner = customSections.find((section) => section.folders.some((entry) => entry === folder || isFolderOrSub(folder, entry) || isFolderOrSub(entry, folder)));
    if (owner) sectionId = owner.id;
  }
  if (!sectionId) return null;
  return { ns: 'custom', section: sectionId, path: header.dataset.folder };
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
      if (!event.dataTransfer || isFolderDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const after = (event.clientY - rect.top) > rect.height / 2;
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (event) => {
      if (isFolderDrag(event)) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      dropNoteOnNote(event.dataTransfer.getData('text/plain'), id, (event.clientY - rect.top) > rect.height / 2);
    });
  });
  if (!canDrag) return;
  noteList.querySelectorAll('[data-folder]').forEach((header) => {
    header.addEventListener('dragover', (event) => {
      if (isFolderDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      header.classList.add('drop-target');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drop-target'));
    header.addEventListener('drop', (event) => {
      if (isFolderDrag(event)) return;
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
  // Folder headers drag to re-sort or nest (same payload and rules as the
  // slide menu): top/bottom quarter reorders, middle nests inside.
  noteList.querySelectorAll('[data-folder-wrap]').forEach((wrap) => {
    const header = wrap.querySelector('[data-folder]');
    if (!header) return;
    header.draggable = true;
    const rowEl = header.closest('.tree-folder-row') || header;
    header.addEventListener('dragstart', (event) => {
      const target = resolveListFolderTarget(header);
      const fromList = target ? folderListOf(target.ns, target.section) : null;
      // Intermediate headers are not real folders: they cannot be dragged.
      if (!target || !fromList || !fromList.includes(target.path) || !e2ee.masterKey) { event.preventDefault(); return; }
      event.dataTransfer.setData('application/x-notely-folder', JSON.stringify(target));
      event.dataTransfer.effectAllowed = 'move';
      header.classList.add('dragging');
      closeFolderContextMenu();
      closeNoteContextMenu();
    });
    header.addEventListener('dragend', () => {
      header.classList.remove('dragging');
      clearIndicators();
    });
    header.addEventListener('dragover', (event) => {
      if (!isFolderDrag(event) || !e2ee.masterKey) return;
      const rect = header.getBoundingClientRect();
      const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      clearIndicators();
      if (ratio < 0.25) rowEl.classList.add('drop-before');
      else if (ratio > 0.75) rowEl.classList.add('drop-after');
      else rowEl.classList.add('drop-target');
    });
    header.addEventListener('dragleave', (event) => {
      if (!header.contains(event.relatedTarget)) {
        rowEl.classList.remove('drop-before', 'drop-after', 'drop-target');
      }
    });
    header.addEventListener('drop', (event) => {
      if (!isFolderDrag(event) || !e2ee.masterKey) return;
      let dragged = null;
      try { dragged = JSON.parse(event.dataTransfer.getData('application/x-notely-folder')); } catch (error) { dragged = null; }
      if (!dragged || !dragged.path) return;
      const target = resolveListFolderTarget(header);
      if (!target || target.ns !== dragged.ns || target.section !== dragged.section) return;
      if (target.path === dragged.path) return;
      if (isFolderOrSub(target.path, dragged.path)) {
        event.preventDefault();
        showToast("Can't move a folder into itself");
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = header.getBoundingClientRect();
      const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
      const list = folderListOf(dragged.ns, dragged.section);
      if (!list) return;
      // Intermediate headers are not real folders: order around their subtree
      // instead (never nest into them).
      let anchor = target.path;
      let after = ratio > 0.75;
      let nest = ratio >= 0.25 && ratio <= 0.75;
      if (!list.includes(target.path)) {
        const under = list.filter((entry) => isFolderOrSub(entry, target.path));
        if (!under.length) return;
        nest = false;
        if (ratio < 0.5) { anchor = under[0]; after = false; }
        else { anchor = under[under.length - 1]; after = true; }
      }
      if (anchor === dragged.path || isFolderOrSub(anchor, dragged.path)) return;
      if (nest) {
        // Nest inside the target folder.
        const newPath = reparentFolder(dragged.ns, dragged.section, dragged.path, target.path);
        if (!newPath) return;
        const movedHome = newPath !== dragged.path;
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
        // Reorder around the anchor (reparenting across levels when needed).
        const refParent = folderParent(anchor);
        let movedRoot = dragged.path;
        if ((refParent || null) !== (folderParent(dragged.path) || null)) {
          const newPath = reparentFolder(dragged.ns, dragged.section, dragged.path, refParent);
          if (!newPath) return;
          movedRoot = newPath;
        }
        if (reorderFolderBlock(dragged.ns, dragged.section, movedRoot, anchor, after)) {
          renderCustomSections();
          renderNoteList();
        }
      }
    });
  });
}

// Render the grouped note tree: folder ordering, collapse, Bin actions vs rename pencil, scoped counters, and per-row event wiring.
function renderNoteList() {
  const sharedNewBtn = document.getElementById('shared-new');
  if (sharedNewBtn) sharedNewBtn.hidden = true;
  const refreshBtnTop = document.getElementById('refresh-view');
  if (refreshBtnTop) refreshBtnTop.hidden = true; // Refresh lives only in Shared.
  if (activeView === 'vault') { renderVaultList(); renderTabs(); renderStripItems(); return; }
  if (activeView === 'shared') { renderSharedView(); renderTabs(); renderStripItems(); updateFoldToggle(); return; }
  const visible = visibleNotes();
  const searching = searchQuery.trim() !== '';
  // Grouping follows the active folder namespace: custom-section paths when one
  // of those is selected, otherwise each note's first filing. The
  // folder-required invariant guarantees every note has a filing.
  const groupKeyOfNote = (note) => {
    if (activeCustom) return customNoteFolder(note, activeCustom.section);
    return firstFilingOf(note);
  };
  const groups = new Map();
  visible.forEach((note) => {
    const folder = groupKeyOfNote(note);
    if (folder == null) return;
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
  // Manual folder order wins over recency so drag-sorts stick: folders follow
  // their section list order (same as the slide menu). Unknown paths (stale
  // filings) and cross-section ties fall back to recency.
  const manualPosition = (folder) => {
    for (const section of customSections) {
      const at = section.folders.indexOf(folder);
      if (at !== -1) return { section: section.id, index: at };
    }
    for (const section of customSections) {
      const under = section.folders.filter((entry) => isFolderOrSub(entry, folder));
      if (under.length) {
        let best = Infinity;
        under.forEach((entry) => { best = Math.min(best, section.folders.indexOf(entry)); });
        return { section: section.id, index: best };
      }
    }
    return { section: '', index: Infinity };
  };
  const byManualOrder = (a, b) => {
    const pa = manualPosition(a.fullPath);
    const pb = manualPosition(b.fullPath);
    if (pa.section && pa.section === pb.section && pa.index !== pb.index) return pa.index - pb.index;
    return byRecency(a, b);
  };
  const renderFolderNode = (node) => {
    const folder = node.fullPath;
    const files = node.files;
    const isCollapsed = !searching && collapsedFolders.has(folder);
    const folderActions = activeView === 'bin'
      ? ''
      : `<button type="button" class="tree-rename" data-folder-rename="${escapeHtml(folder)}" title="Rename folder" aria-label="Rename ${escapeHtml(folder)}">${icon('pencil')}</button>`;
    const childrenHtml = node.children.slice().sort(byManualOrder).map(renderFolderNode).join('');
    return `
    <div class="tree-folder-wrap${isCollapsed ? ' closed' : ''}" data-folder-wrap="${escapeHtml(folder)}">
      <div class="tree-folder-row">
        <button class="tree-folder" data-folder="${escapeHtml(folder)}" aria-expanded="${isCollapsed ? 'false' : 'true'}" title="${escapeHtml(folder)}${activeView === 'bin' ? '' : ' — double-click to rename'}">
          <span class="tree-chevron">${icon('chevron-right')}</span>
          <span class="tree-folder-icon">${icon(folderIconForDepth(folderDepth(folder)))}</span>
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
          <span class="tree-file-icon tree-file-icon-${note.ext}">${icon(noteGlyphFor(note))}</span>
          <span class="tree-file-name">${escapeHtml(note.title || 'Untitled note')}</span>
          ${activeView === 'bin' ? `<span class="bin-meta">${binRemainingText(note)}</span>` : ''}
          ${note.favorite && activeView !== 'bin' ? `<span class="mini-star">${icon('star')}</span>` : ''}
        </button>`).join('')}
      </div>
    </div>`;
  };
  return buildFolderTree([...groupsMap.keys()]).sort(byManualOrder).map(renderFolderNode).join('');
  };
  // One sidebar section as a list supergroup: clickable title (filters),
  // rename pencil, note count, then its folder tree.
  const renderSectionShell = (kind, id, title, groupsMap) => {
    const total = [...groupsMap.values()].reduce((sum, files) => sum + files.length, 0);
    return `<div class="list-section" data-list-section="${kind}">
      <div class="list-section-head">
        <button class="list-section-title" data-section-jump="${kind}" data-section-id="${escapeHtml(id || '')}" title="Show ${escapeHtml(title)}">${escapeHtml(title)}</button>
        <span class="tree-count">${total}</span>
        ${activeView === 'bin' ? '' : `<button type="button" class="list-section-add" data-section-add="${escapeHtml(id || '')}" title="Add folder to ${escapeHtml(title)}" aria-label="Add folder to ${escapeHtml(title)}">${icon('folder-plus')}</button>`}
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
      // Seed every folder so newly added (still empty) folders show in the
      // folder list instead of only folders that already hold notes.
      section.folders.forEach((folder) => { if (!sectionGroups.has(folder)) sectionGroups.set(folder, []); });
      visible.forEach((note) => {
        const folder = customNoteFolder(note, section.id);
        if (!folder) return;
        if (!sectionGroups.has(folder)) sectionGroups.set(folder, []);
        sectionGroups.get(folder).push(note);
      });
      if (sectionGroups.size) parts.push(renderSectionShell('custom', section.id, section.name, sectionGroups));
    });
    // Folder-required invariant: unfiled notes cannot exist (enforced at
    // every entry path), so no plain rows outside sections are rendered.
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
  updateFoldToggle();
  noteList.querySelectorAll('[data-note-id]').forEach((item) => item.addEventListener('click', () => selectNote(item.dataset.noteId)));
  enableNoteDragDrop();
  noteList.querySelectorAll('[data-folder]').forEach((item) => item.addEventListener('click', () => {
    // Expanded workspace: clicking a folder just opens/closes its contents in
    // place. It never "zooms into" the folder (that lives in the workspace
    // strip when collapsed), so the full list stays put.
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
  const renameSectionFromList = (kind, id, anchor) => {
    if (kind === 'custom' && id) startSectionRename({ kind: 'custom', id }, anchor || null);
  };
  noteList.querySelectorAll('[data-section-rename]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    renameSectionFromList(item.dataset.sectionRename, item.dataset.sectionId || null, item.closest('.list-section-head') ? item.closest('.list-section-head').querySelector('.list-section-title') : item);
  }));
  noteList.querySelectorAll('[data-section-add]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    addFolderToSection(item.dataset.sectionAdd);
  }));
  noteList.querySelectorAll('.list-section-title').forEach((item) => item.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    renameSectionFromList(item.dataset.sectionJump, item.dataset.sectionId || null, item);
  }));
  renderTabs();
  renderStripItems();
}

// Selected note, falling back to the first note (may be undefined when empty — callers must guard).
function currentNote() {
  return notes.find((note) => note.id === currentId) || notes[0];
}

// Refresh word count, tag chips and the favorite button for the open note.
// Human "last edited" label from a note's timestamp (falls back to its date text).
function relativeEditedLabel(note) {
  const ts = note && typeof note.updatedAt === 'number' && Number.isFinite(note.updatedAt) ? note.updatedAt : null;
  if (!ts) {
    const fallback = note && typeof note.date === 'string' && note.date.trim() ? note.date.trim() : 'recently';
    return `Edited ${fallback}`;
  }
  const diff = Math.max(0, Date.now() - ts);
  const minute = 60000, hour = 3600000, day = 86400000;
  if (diff < minute) return 'Edited just now';
  if (diff < hour) return `Edited ${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `Edited ${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'Edited yesterday';
  if (diff < 7 * day) return `Edited ${Math.floor(diff / day)}d ago`;
  return `Edited ${new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function updateMeta(note) {
  // Shared notes render their tags from the Yjs doc instead of note.tags.
  if (collab.noteId) { renderSharedTags(); return; }
  renderRecipeHero(note);
  let body = typeof note.body === 'string' ? note.body : '';
  if (note.template === 'recipe') {
    body = `${sanitizeIngredients(note.ingredients).map((item) => item.t).join(' ')} ${sanitizeSteps(note.steps).join(' ')}`;
  }
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  wordCount.textContent = `${words} word${words === 1 ? '' : 's'}`;
  const editedEl = document.getElementById('edited-label');
  if (editedEl) editedEl.textContent = relativeEditedLabel(note);
  const tags = Array.isArray(note.tags) ? note.tags.filter((tag) => typeof tag === 'string').slice(0, 20) : [];
  // "+" affordance sits inline after the tags and opens the tag editor for THIS
  // note (the note id is bound to the button). It only appears for the user's
  // own regular notes: vault and shared/collab notes have no editable tag list,
  // and showing it there used to tag whichever regular note was last active.
  const taggable = !collab.noteId && activeView !== 'vault' && activeView !== 'shared'
    && notes.some((item) => item.id === note.id);
  const addTagButton = taggable
    ? `<button type="button" class="tag-add" data-note-id="${escapeHtml(String(note.id))}" title="Add tag" aria-label="Add tag">+</button>`
    : '';
  tagList.innerHTML = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') + addTagButton;
  document.getElementById('favorite-button').classList.toggle('is-favorite', Boolean(note.favorite));
  document.getElementById('favorite-button').style.color = note.favorite ? '#b79b54' : '';
}

// Open a note in the editor and re-render the list; lock state is reapplied afterwards.
// Every note opens in PREVIEW mode (edit mode never carries over between
// notes); clicking/focusing the preview switches that note to edit mode.
function selectNote(id) {
  if (collab.noteId) closeCollabNote();
  exitCoverRepos(true);
  const note = notes.find((item) => item.id === id);
  if (!note) return;
  trackTab(id, false);
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
    setSaveLabel('Sync failed', 'red');
    showToast('Too many notes to sync (2000 max) — delete some to keep saving');
    clearTimeout(saveTimer);
    return;
  }
  setSaveLabel('Saving...', 'green');
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
    else if (isArchived) btn.hidden = !(actionName === 'open' || actionName === 'unarchive' || actionName === 'download' || actionName === 'tags' || actionName === 'delete');
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
    updatedAt: Date.now(),
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
  // Drop rendered preview HTML too: it may hold vault content, which must not
  // linger in the DOM past lock/logout (separation both ways).
  preview.innerHTML = '';
  if (editorToolbar) editorToolbar.hidden = true;
  renderRecipeHero(null);
  renderCover(null);
  // Nothing marked: hide the editor and let the notes panel take the room.
  // Any selection (selectNote/selectVaultNote) removes it again.
  try {
    document.querySelector('.app-shell').classList.add('workspace-focus');
  } catch (error) {}
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
  ensureNoteFiled(note);
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
  if (typeof action !== 'string' || !/^(open|favorite|important|tags|restore|duplicate|download|archive|unarchive|delete)$/.test(action)) return;
  if (action === 'open') selectNote(id);
  else if (action === 'favorite') toggleFavoriteById(id);
  else if (action === 'important') toggleImportantById(id);
  else if (action === 'tags') openTagEditor(id);
  else if (action === 'restore') restoreNoteById(id);
  else if (action === 'archive') archiveNoteById(id);
  else if (action === 'unarchive') unarchiveNoteById(id);
  else if (action === 'duplicate') duplicateNoteById(id);
  else if (action === 'download') downloadNoteById(id);
  else if (action === 'delete') requestDeleteNoteById(id);
}

// ---- Tags -----------------------------------------------------------------
// Tags live on each note as freeform strings (<=40 chars, max 20 per note).
// The account-wide view (settings) aggregates them for rename/delete.

function normalizeTagName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 40);
}
function noteTagIndex(note, name) {
  const wanted = normalizeTagName(name).toLowerCase();
  return (Array.isArray(note.tags) ? note.tags : []).findIndex((tag) => String(tag).toLowerCase() === wanted);
}
function addNoteTag(note, name) {
  const tag = normalizeTagName(name);
  if (!note || !tag) return false;
  if (!Array.isArray(note.tags)) note.tags = [];
  if (noteTagIndex(note, tag) !== -1) return false;
  if (note.tags.length >= 20) { showToast('Tag limit reached (20 per note)'); return false; }
  note.tags.push(tag);
  return true;
}
function removeNoteTag(note, name) {
  const at = noteTagIndex(note, name);
  if (at === -1) return false;
  note.tags.splice(at, 1);
  return true;
}
// Aggregate every tag with a note count (case-insensitive; first casing wins).
// User-created tags with no notes yet are included with a count of 0.
function allTagCounts() {
  const map = new Map();
  notes.forEach((note) => {
    (Array.isArray(note.tags) ? note.tags : []).forEach((tag) => {
      const key = String(tag).toLowerCase();
      const entry = map.get(key);
      if (entry) entry.count += 1;
      else map.set(key, { label: String(tag), count: 1 });
    });
  });
  knownTags.forEach((tag) => {
    const key = String(tag).toLowerCase();
    if (key && !map.has(key)) map.set(key, { label: String(tag), count: 0 });
  });
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}
function refreshTagsAcrossUi() {
  persistNotes();
  renderNoteList();
  const open = activeEditorNote();
  if (open) updateMeta(open);
}
// Rename a tag on every note (folds duplicates created by the rename).
function renameTagEverywhere(oldName, rawNew) {
  const from = normalizeTagName(oldName).toLowerCase();
  const to = normalizeTagName(rawNew);
  if (!from || !to || from === to.toLowerCase()) return false;
  let changed = 0;
  notes.forEach((note) => {
    if (!Array.isArray(note.tags)) return;
    const next = [];
    let touched = false;
    note.tags.forEach((tag) => {
      if (String(tag).toLowerCase() === from) { touched = true; next.push(to); return; }
      next.push(tag);
    });
    if (!touched) return;
    changed += 1;
    const seen = new Set();
    note.tags = next.filter((tag) => {
      const key = String(tag).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  });
  if (changed) refreshTagsAcrossUi();
  const hadKnown = knownTags.some((tag) => String(tag).toLowerCase() === from);
  knownTags = cleanTagList(knownTags.map((tag) => (String(tag).toLowerCase() === from ? to : tag)));
  if (changed || hadKnown) persistUiVault();
  return changed > 0 || hadKnown;
}
// Delete a tag from every note.
function deleteTagEverywhere(name) {
  const key = normalizeTagName(name).toLowerCase();
  let changed = 0;
  notes.forEach((note) => {
    if (!Array.isArray(note.tags)) return;
    const before = note.tags.length;
    note.tags = note.tags.filter((tag) => String(tag).toLowerCase() !== key);
    if (note.tags.length !== before) changed += 1;
  });
  const hadKnown = knownTags.some((tag) => String(tag).toLowerCase() === key);
  if (hadKnown) {
    knownTags = knownTags.filter((tag) => String(tag).toLowerCase() !== key);
    persistUiVault();
  }
  if (changed) refreshTagsAcrossUi();
  return changed > 0 || hadKnown;
}
// Create a standalone tag (available to every note's tag editor and to search).
function addKnownTag(raw) {
  const tag = normalizeTagName(raw);
  if (!tag) { showToast('Enter a tag name'); return false; }
  if (knownTags.some((entry) => entry.toLowerCase() === tag.toLowerCase())) { showToast(`Tag “${tag}” already exists`); return false; }
  if (knownTags.length >= 500) { showToast('Tag limit reached (500)'); return false; }
  knownTags.push(tag);
  persistUiVault();
  try { renderSettingsTags(); } catch (error) {}
  try { renderTagEditor(); } catch (error) {}
  showToast(`Tag “${tag}” added`);
  return true;
}

// ---- Note tag editor (opened from the note right-click menu) --------------
let tagEditorNoteId = null;
let tagEditorShared = false;

// Shared-note tags live in the Yjs doc (a Y.Array) so they sync live to every
// member; the encrypted note meta mirrors them for the Shared list.
function sharedTagList() {
  if (!collab.noteId || !collab.tags) return [];
  try { return collab.tags.toArray().filter((x) => typeof x === 'string').slice(0, 20); } catch (error) { return []; }
}
function renderSharedTags() {
  if (!collab.noteId || !tagList) return;
  const tags = sharedTagList();
  const addTagButton = '<button type="button" class="tag-add" data-shared-tag-add="1" title="Add tag" aria-label="Add tag">+</button>';
  tagList.innerHTML = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') + addTagButton;
}
function openSharedTagEditor() {
  const overlay = document.getElementById('tag-editor-overlay');
  if (!overlay || !collab.noteId) return;
  tagEditorShared = true;
  tagEditorNoteId = null;
  const desc = document.getElementById('tag-editor-desc');
  const title = collab.title ? collab.title.toString() : 'this shared note';
  if (desc) desc.textContent = `Add or remove tags for “${title}”.`;
  renderTagEditor();
  overlay.hidden = false;
  const input = document.getElementById('tag-editor-input');
  if (input) { input.value = ''; try { input.focus(); } catch (error) {} }
}

function openTagEditor(id) {
  const note = notes.find((item) => item.id === id);
  const overlay = document.getElementById('tag-editor-overlay');
  if (!note || !overlay) return;
  tagEditorShared = false;
  tagEditorNoteId = id;
  const desc = document.getElementById('tag-editor-desc');
  if (desc) desc.textContent = `Add or remove tags for “${note.title || 'Untitled note'}”.`;
  renderTagEditor();
  overlay.hidden = false;
  const input = document.getElementById('tag-editor-input');
  if (input) { input.value = ''; try { input.focus(); } catch (error) {} }
}
function closeTagEditor() {
  const overlay = document.getElementById('tag-editor-overlay');
  if (overlay) overlay.hidden = true;
  tagEditorNoteId = null;
  tagEditorShared = false;
}
function renderTagEditor() {
  let tags;
  if (tagEditorShared) {
    tags = sharedTagList();
  } else {
    const note = notes.find((item) => item.id === tagEditorNoteId);
    if (!note) return;
    tags = Array.isArray(note.tags) ? note.tags : [];
  }
  const current = document.getElementById('tag-editor-current');
  const suggest = document.getElementById('tag-editor-suggest');
  if (current) {
    current.innerHTML = tags.length
      ? tags.map((tag) => `<button type="button" class="tag-chip" data-tag-remove="${escapeHtml(tag)}" title="Remove ${escapeHtml(tag)}">${escapeHtml(tag)}<span aria-hidden="true">×</span></button>`).join('')
      : '<span class="tag-editor-empty">No tags yet — add one below.</span>';
  }
  if (suggest) {
    const have = new Set(tags.map((tag) => String(tag).toLowerCase()));
    // Shared notes also suggest the section's owner-curated tags.
    const pool = tagEditorShared
      ? [...sharedGroupTagList(collab.groupId).map((label) => ({ label })), ...allTagCounts()]
      : allTagCounts();
    const seen = new Set();
    const others = [];
    for (const entry of pool) {
      const key = String(entry.label).toLowerCase();
      if (!key || have.has(key) || seen.has(key)) continue;
      seen.add(key);
      others.push(entry);
    }
    suggest.innerHTML = others.length
      ? `<span class="tag-editor-suggest-label">Existing tags</span>${others.map((entry) => `<button type="button" class="tag-chip is-add" data-tag-add="${escapeHtml(entry.label)}">${escapeHtml(entry.label)}</button>`).join('')}`
      : '';
  }
}
function tagEditorAdd(raw) {
  const tag = normalizeTagName(raw);
  if (!tag) return;
  if (tagEditorShared) {
    if (!collab.noteId || !collab.tags) return;
    const list = sharedTagList();
    if (list.some((t) => String(t).toLowerCase() === tag.toLowerCase())) return;
    if (list.length >= 20) { showToast('Tag limit reached (20 per note)'); return; }
    collab.tags.push([tag]);
    renderTagEditor();
    return;
  }
  const note = notes.find((item) => item.id === tagEditorNoteId);
  if (!note) return;
  if (addNoteTag(note, raw)) {
    refreshTagsAcrossUi();
    renderTagEditor();
    renderSettingsTags();
  }
}
function tagEditorRemove(name) {
  if (tagEditorShared) {
    if (!collab.noteId || !collab.tags) return;
    const list = sharedTagList();
    const at = list.findIndex((t) => String(t).toLowerCase() === String(name).toLowerCase());
    if (at === -1) return;
    collab.tags.delete(at, 1);
    renderTagEditor();
    return;
  }
  const note = notes.find((item) => item.id === tagEditorNoteId);
  if (!note) return;
  if (removeNoteTag(note, name)) {
    refreshTagsAcrossUi();
    renderTagEditor();
    renderSettingsTags();
  }
}

// ---- Settings → Customization → Tags --------------------------------------
function renderSettingsTags() {
  const box = document.getElementById('settings-tag-list');
  if (!box) return;
  const tags = allTagCounts();
  if (!tags.length) {
    box.innerHTML = '<p class="modal-desc">No tags yet. Right-click a note and choose “Tags…” to add some.</p>';
    return;
  }
  box.innerHTML = tags.map((entry) => `
    <div class="settings-tag-row" data-settings-tag="${escapeHtml(entry.label)}">
      <span class="tag">${escapeHtml(entry.label)}</span>
      <span class="settings-tag-count">${entry.count} note${entry.count === 1 ? '' : 's'}</span>
      <button type="button" class="settings-tag-action" data-tag-rename="${escapeHtml(entry.label)}" title="Rename tag" aria-label="Rename ${escapeHtml(entry.label)}">${icon('pencil')}</button>
      <button type="button" class="settings-tag-action danger" data-tag-delete="${escapeHtml(entry.label)}" title="Delete tag" aria-label="Delete ${escapeHtml(entry.label)}">${icon('trash')}</button>
    </div>`).join('');
}

// ---- E2EE note sharing ----------------------------------------------------
// Each account publishes an ECDH P-256 keypair: the public key in the clear,
// the private key wrapped under the account master key. To share, a random
// content key encrypts the note and is wrapped for the recipient's public key
// (ECIES). The server relays only ciphertext and can never read a note.
const sharing = { privateKey: null, signingKey: null, ready: false };

let sharingKeyPromise = null;
function sharingEnsureKeys() {
  // Single-flight: concurrent callers must never generate two different
  // keypairs (the published public key could stop matching the in-memory key).
  if (sharing.ready && sharing.privateKey && sharing.signingKey) return Promise.resolve(true);
  if (sharingKeyPromise) return sharingKeyPromise;
  sharingKeyPromise = sharingEnsureKeysOnce().finally(() => { sharingKeyPromise = null; });
  return sharingKeyPromise;
}
async function sharingUnwrapAccountKey(encPrivB64, kind) {
  const wrapped = e2eeB64ToBytes(encPrivB64);
  const priv = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrapped.slice(0, 12) }, e2ee.masterKey, wrapped.slice(12));
  if (kind === 'ECDSA') {
    return window.crypto.subtle.importKey('pkcs8', priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
  return window.crypto.subtle.importKey('pkcs8', priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
}
async function sharingWrapAccountKey(pkcs8) {
  const iv = e2eeRandomBytes(12);
  const ct = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, e2ee.masterKey, pkcs8));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return e2eeBytesToB64(out);
}
async function sharingGenerateKeys() {
  try {
    const ecdh = await window.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const sig = await window.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = new Uint8Array(await window.crypto.subtle.exportKey('raw', ecdh.publicKey));
    const ecdhPkcs8 = new Uint8Array(await window.crypto.subtle.exportKey('pkcs8', ecdh.privateKey));
    const sigPub = new Uint8Array(await window.crypto.subtle.exportKey('raw', sig.publicKey));
    const sigPkcs8 = new Uint8Array(await window.crypto.subtle.exportKey('pkcs8', sig.privateKey));
    const pubRes = await apiFetch('/api/keys', { method: 'POST', body: JSON.stringify({
      algo: 'ECDH-P256',
      pubkey: e2eeBytesToB64(pub),
      encPriv: await sharingWrapAccountKey(ecdhPkcs8),
      sigPubkey: e2eeBytesToB64(sigPub),
      sigEncPriv: await sharingWrapAccountKey(sigPkcs8),
    }) });
    if (!pubRes.ok) return false;
    sharing.privateKey = ecdh.privateKey;
    sharing.signingKey = sig.privateKey;
    sharing.ready = true;
    return true;
  } catch (error) { return false; }
}
async function sharingPublishSigningKey(pubB64, encPrivB64) {
  // Additive backfill: keep the existing ECDH key, add a signing key.
  try {
    const sig = await window.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const sigPub = new Uint8Array(await window.crypto.subtle.exportKey('raw', sig.publicKey));
    const sigPkcs8 = new Uint8Array(await window.crypto.subtle.exportKey('pkcs8', sig.privateKey));
    const res = await apiFetch('/api/keys', { method: 'POST', body: JSON.stringify({
      algo: 'ECDH-P256', pubkey: pubB64, encPriv: encPrivB64,
      sigPubkey: e2eeBytesToB64(sigPub),
      sigEncPriv: await sharingWrapAccountKey(sigPkcs8),
    }) });
    if (!res.ok) return false;
    sharing.signingKey = sig.privateKey;
    sharing.ready = true;
    return true;
  } catch (error) { return false; }
}
async function sharingEnsureKeysOnce() {
  if (sharing.ready && sharing.privateKey && sharing.signingKey) return true;
  if (!e2ee.masterKey) return false;
  try {
    const res = await apiFetch('/api/keys/me');
    if (res.ok) {
      const data = await res.json();
      if (data && data.exists && data.encPriv && data.pubkey) {
        sharing.privateKey = await sharingUnwrapAccountKey(data.encPriv, 'ECDH');
        if (data.sigEncPriv && data.sigPubkey) {
          sharing.signingKey = await sharingUnwrapAccountKey(data.sigEncPriv, 'ECDSA');
          sharing.ready = true;
          return true;
        }
        return await sharingPublishSigningKey(data.pubkey, data.encPriv);
      }
    }
  } catch (error) { /* fall through and (re)generate */ }
  return sharingGenerateKeys();
}

// ---- Signed wraps: a member signs the key they hand a peer, so the recipient
// can detect a server that substitutes a wrap it controls. ------------------------------------------------------------------
let sharingPinsLoaded = false;
const sharingPins = new Map(); // signer username -> signing-key fingerprint
function sharingPinsLoad() {
  if (sharingPinsLoaded) return;
  sharingPinsLoaded = true;
  try {
    const obj = JSON.parse(localStorage.getItem('notely-keypins') || '{}');
    Object.keys(obj).forEach((k) => sharingPins.set(k, String(obj[k])));
  } catch (error) {}
}
function sharingPinsSave() {
  try { localStorage.setItem('notely-keypins', JSON.stringify(Object.fromEntries(sharingPins))); } catch (error) {}
}
async function sharingFingerprint(pubRawBytes) {
  const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', pubRawBytes));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function wrapSigMessage(groupId, recipient, keyVersion, w) {
  return `notely-wrap-v1|${groupId || ''}|${recipient}|${Number(keyVersion) || 1}|${w.wrappedKey}|${w.ephPub}|${w.wrapIv}`;
}
async function signWrap(groupId, recipient, keyVersion, w) {
  if (!sharing.signingKey) return '';
  const data = new TextEncoder().encode(wrapSigMessage(groupId, recipient, keyVersion, w));
  const sig = new Uint8Array(await window.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, sharing.signingKey, data));
  return e2eeBytesToB64(sig);
}
async function sharingSignerPublicKey(signer) {
  const res = await apiFetch(`/api/keys/lookup?username=${encodeURIComponent(signer)}`);
  if (!res.ok) throw new Error('Could not load the sender\'s signing key.');
  const data = await res.json();
  if (!data.sigPubkey) throw new Error(`${signer} has no signing key published.`);
  const raw = e2eeB64ToBytes(data.sigPubkey);
  const fp = await sharingFingerprint(raw);
  sharingPinsLoad();
  const pinned = sharingPins.get(signer);
  if (pinned && pinned !== fp) {
    throw new Error(`Signing key for ${signer} changed (${pinned} → ${fp}). Refusing to trust it.`);
  }
  if (!pinned) { sharingPins.set(signer, fp); sharingPinsSave(); }
  return window.crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}
// Throws if a wrap we did not make fails verification (legacy unsigned wraps are
// allowed through so existing sections keep working).
async function verifyWrap(groupId, recipient, keyVersion, w) {
  if (!w || !w.sig || !w.signer) return;
  if (w.signer === recipient) return; // our own wrap
  const pub = await sharingSignerPublicKey(w.signer);
  const data = new TextEncoder().encode(wrapSigMessage(groupId, recipient, keyVersion, w));
  const ok = await window.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, e2eeB64ToBytes(w.sig), data);
  if (!ok) throw new Error(`The section key from ${w.signer} failed verification.`);
}
async function unwrapMyKey(myKey, groupId, recipient, keyVersion) {
  await verifyWrap(groupId, recipient, keyVersion, myKey);
  return unwrapRawKey(myKey.wrappedKey, myKey.ephPub, myKey.wrapIv);
}

async function sharingRecipientPublicKey(username) {
  const res = await apiFetch(`/api/keys/lookup?username=${encodeURIComponent(username)}`);
  if (!res.ok) {
    let message = 'Could not find a sharing key for that account.';
    try { const data = await res.json(); if (data && data.error) message = data.error; } catch (error) {}
    throw new Error(message);
  }
  const data = await res.json();
  return window.crypto.subtle.importKey('raw', e2eeB64ToBytes(data.pubkey),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

// ---- Live collaborative notes (E2EE via Yjs) ------------------------------
// Shared sections: a group has a random key wrapped to each member. Notes live
// under the group; any note added there is automatically shared with everyone
// in the group. Edits are Yjs CRDT updates encrypted with the group key and
// relayed over a WebSocket. The server only relays ciphertext.
let yjsPromise = null;
function loadYjs() {
  if (!yjsPromise) yjsPromise = import('/vendor/yjs/yjs.mjs');
  return yjsPromise;
}

async function wrapRawKeyFor(recipientPub, rawKey) {
  const eph = await window.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const shared = await window.crypto.subtle.deriveKey(
    { name: 'ECDH', public: recipientPub }, eph.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const wrapIv = e2eeRandomBytes(12);
  const wrapped = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, shared, rawKey));
  const ephPub = new Uint8Array(await window.crypto.subtle.exportKey('raw', eph.publicKey));
  return { wrappedKey: e2eeBytesToB64(wrapped), ephPub: e2eeBytesToB64(ephPub), wrapIv: e2eeBytesToB64(wrapIv) };
}
async function unwrapRawKey(wrappedB64, ephPubB64, wrapIvB64) {
  if (!sharing.privateKey) throw new Error('locked');
  const ephPub = await window.crypto.subtle.importKey('raw', e2eeB64ToBytes(ephPubB64),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await window.crypto.subtle.deriveKey(
    { name: 'ECDH', public: ephPub }, sharing.privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new Uint8Array(await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapIvB64) }, shared, e2eeB64ToBytes(wrappedB64)));
}
async function collabEncrypt(keyRaw, bytes) {
  const key = await window.crypto.subtle.importKey('raw', keyRaw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = e2eeRandomBytes(12);
  const ct = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv); packed.set(ct, iv.length);
  return e2eeBytesToB64(packed);
}
async function collabDecrypt(keyRaw, packedB64) {
  const key = await window.crypto.subtle.importKey('raw', keyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
  const packed = e2eeB64ToBytes(packedB64);
  return new Uint8Array(await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12)));
}
// Note "meta" (title + folder) is encrypted under the group key so the server
// still sees nothing. It powers the Shared inbox list without loading the doc.
async function collabEncryptMeta(keyRaw, meta) {
  return collabEncrypt(keyRaw, new TextEncoder().encode(JSON.stringify({
    t: meta.title || '', f: meta.folder || '', tp: meta.template || '',
    tg: Array.isArray(meta.tags) ? meta.tags.filter((x) => typeof x === 'string').slice(0, 20) : [],
  })));
}
async function collabDecryptMeta(keyRaw, encB64) {
  if (!encB64) return { title: '', folder: '', template: '', tags: [] };
  try {
    const obj = JSON.parse(new TextDecoder().decode(await collabDecrypt(keyRaw, encB64)));
    return {
      title: typeof obj.t === 'string' ? obj.t : '',
      folder: typeof obj.f === 'string' ? obj.f : '',
      template: typeof obj.tp === 'string' ? obj.tp : '',
      tags: Array.isArray(obj.tg) ? obj.tg.filter((x) => typeof x === 'string').slice(0, 20) : []
    };
  } catch (error) { return { title: '', folder: '', template: '', tags: [] }; }
}
async function collabEncryptGroupMeta(keyRaw, folders, tags) {
  return collabEncrypt(keyRaw, new TextEncoder().encode(JSON.stringify({
    folders: Array.isArray(folders) ? folders : [],
    tags: Array.isArray(tags) ? tags.filter((x) => typeof x === 'string').slice(0, 100) : [],
  })));
}
async function collabDecryptGroupMeta(keyRaw, encB64) {
  if (!encB64) return { folders: [], tags: [] };
  try {
    const obj = JSON.parse(new TextDecoder().decode(await collabDecrypt(keyRaw, encB64)));
    return {
      folders: Array.isArray(obj.folders) ? obj.folders.filter((f) => typeof f === 'string') : [],
      tags: Array.isArray(obj.tags) ? obj.tags.filter((t) => typeof t === 'string') : [],
    };
  } catch (error) { return { folders: [], tags: [] }; }
}
// Unwrap a group's key from my membership (used by the inbox + note creation).
async function collabGroupKey(groupId) {
  const res = await apiFetch(`/api/collab/groups/${groupId}`);
  if (!res.ok) throw new Error('No access');
  const g = await res.json();
  const key = await unwrapMyKey(g.myKey, groupId, cachedProfile && cachedProfile.username, g.myKeyVersion);
  return { key, group: g };
}
// Push the current title/folder (debounced) so the inbox list stays current.
function scheduleCollabMeta() {
  if (!collab.noteId || !collab.key) return;
  clearTimeout(collab.metaTimer);
  collab.metaTimer = setTimeout(async () => {
    if (!collab.noteId || !collab.key) return;
    try {
      const encMeta = await collabEncryptMeta(collab.key, {
        title: collab.title ? collab.title.toString().slice(0, 200) : '',
        folder: collab.folder || '',
        template: collab.template || '',
        tags: collab.tags ? collab.tags.toArray().filter((x) => typeof x === 'string').slice(0, 20) : [],
      });
      await apiFetch(`/api/collab/notes/${collab.noteId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    } catch (error) {}
  }, 700);
}

const collab = { noteId: null, groupId: null, doc: null, title: null, body: null, desc: null, assets: null,
  cover: '', description: '', es: null, key: null, keyVersion: 1, keys: new Map(),
  members: [], owner: null, groupName: '', folder: '', template: '', updates: 0, reconnect: null, metaTimer: null,
  outbox: [], flushing: false, flushTimer: null,
  presence: new Map(), presenceTimer: null, clientId: null, color: null, typing: false, pending: [], tags: null };

// Raw group key for a given epoch (falls back to the current key). After a
// rotation the section's content is always fully under the current epoch, but a
// frame posted just before the switch may still carry the previous version.
function collabKeyFor(version) {
  const v = Number(version);
  if (Number.isFinite(v) && collab.keys.has(v)) return collab.keys.get(v);
  return collab.key;
}

function setCollabStatus(text, offline) {
  const el = document.getElementById('collab-status');
  const textEl = document.getElementById('collab-status-text');
  const sep = document.getElementById('collab-status-sep');
  if (textEl) textEl.textContent = text;
  if (el) { el.hidden = false; el.style.color = offline ? '#c0453e' : ''; }
  if (sep) sep.hidden = false;
}
function commonPrefixLen(a, b) { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i += 1; return i; }
function commonSuffixLen(a, b, max) { let i = 0; while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1; return i; }
function applyTextDiff(ytext, oldStr, newStr) {
  if (oldStr === newStr) return;
  const p = commonPrefixLen(oldStr, newStr);
  const suffix = commonSuffixLen(oldStr, newStr, Math.min(oldStr.length - p, newStr.length - p));
  const delCount = oldStr.length - p - suffix;
  const insert = newStr.slice(p, newStr.length - suffix);
  if (delCount > 0) ytext.delete(p, delCount);
  if (insert) ytext.insert(p, insert);
}
function collabSyncDom() {
  if (!collab.doc) return;
  const titleStr = collab.title ? collab.title.toString() : '';
  if (titleInput && titleInput.value !== titleStr && document.activeElement !== titleInput) titleInput.value = titleStr;
  const bodyStr = collab.body ? collab.body.toString() : '';
  if (markdownInput && markdownInput.value !== bodyStr) {
    const start = markdownInput.selectionStart;
    markdownInput.value = bodyStr;
    try { markdownInput.setSelectionRange(Math.min(start, bodyStr.length), Math.min(start, bodyStr.length)); } catch (error) {}
    if (writeMode === 'preview') { try { preview.innerHTML = renderMarkdown(bodyStr); } catch (error) {} }
  }
  const descEl = document.getElementById('recipe-desc');
  if (descEl && collab.desc) {
    const descStr = collab.desc.toString();
    if (document.activeElement !== descEl && descEl.value !== descStr) descEl.value = descStr;
  }
}
// Keep the shared recipe hero in step with the collaborative cover asset.
function collabAssetsChanged() {
  if (!collab.noteId) return;
  const raw = collab.assets ? collab.assets.get('cover') : '';
  collab.cover = cleanCoverSrc(raw) || '';
  collab.description = collab.desc ? collab.desc.toString() : '';
  renderRecipeHero(null);
}
// The Members popup: accepted members, plus invites for the owner.
function renderCollabMembersModal() {
  const btn = document.getElementById('collab-pending');
  const me = cachedProfile && cachedProfile.username;
  const isOwner = collab.owner === me;
  // Owner always first; stable sort keeps the rest in join order.
  const members = [...(collab.members || [])].sort((a, b) => {
    if (a === collab.owner) return -1;
    if (b === collab.owner) return 1;
    return 0;
  });
  const pending = collab.pending || [];
  if (btn) {
    btn.classList.toggle('has-pending', isOwner && pending.length > 0);
    const extra = (isOwner && pending.length) ? ` · ${pending.length} invited` : '';
    btn.title = `Members (${members.length}${extra})`;
  }
  const list = document.getElementById('collab-pending-list');
  if (!list) return;
  const memberRows = members.map((name) => {
    const tags = `${name === me ? ' (you)' : ''}${name === collab.owner ? ' · owner' : ''}`;
    const canRemove = isOwner && name !== me;
    return `<div class="collab-pending-row"><span class="collab-pending-name">${escapeHtml(name)}${tags}</span>${canRemove ? `<button type="button" class="btn btn-secondary" data-remove-member="${escapeHtml(name)}">Remove</button>` : ''}</div>`;
  }).join('');
  let html = `<p class="collab-members-section">Members</p>${memberRows || '<p class="collab-pending-empty">No members yet.</p>'}`;
  // Only the owner sees who has not accepted yet (and can cancel invites).
  if (isOwner) {
    const pendingRows = pending.map((name) => `<div class="collab-pending-row"><span class="collab-pending-name">${escapeHtml(name)}</span><button type="button" class="btn btn-secondary" data-cancel-invite="${escapeHtml(name)}">Cancel</button></div>`).join('');
    html += `<p class="collab-members-section">Invited</p>${pendingRows || '<p class="collab-pending-empty">No pending invitations.</p>'}`;
  }
  list.innerHTML = html;
}
function openCollabPending() {
  if (!collab.noteId) return;
  renderCollabMembersModal();
  const overlay = document.getElementById('collab-pending-overlay');
  if (overlay) overlay.hidden = false;
}
function closeCollabPending() {
  const overlay = document.getElementById('collab-pending-overlay');
  if (overlay) overlay.hidden = true;
}
async function cancelCollabInvite(name) {
  if (!collab.groupId || !name) return;
  const res = await apiFetch(`/api/collab/groups/${collab.groupId}/members/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Could not cancel the invitation'); return; }
  collab.pending = (collab.pending || []).filter((n) => n !== name);
  renderCollabMembersModal();
  showToast(`Invitation to ${name} cancelled`);
}

// ---- Presence: who is here, where their cursor is (ephemeral, encrypted) ----
let collabCaretMirror = null;
let collabTypingTimer = null;
let collabPresenceLocalTimer = null;
const COLLAB_PRESENCE_TTL_MS = 15000;

function collabPresenceColor(username) {
  const name = String(username || '');
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 45%)`;
}
// Textarea caret coordinates via an offscreen mirror with identical metrics.
function collabCaretCoords(index) {
  const ta = markdownInput;
  if (!ta) return null;
  if (!collabCaretMirror) {
    collabCaretMirror = document.createElement('div');
    collabCaretMirror.setAttribute('aria-hidden', 'true');
    document.body.appendChild(collabCaretMirror);
  }
  const mirror = collabCaretMirror;
  const cs = window.getComputedStyle(ta);
  const st = mirror.style;
  st.position = 'absolute';
  st.visibility = 'hidden';
  st.top = '-9999px';
  st.left = '-9999px';
  st.whiteSpace = 'pre-wrap';
  st.overflowWrap = 'break-word';
  st.width = `${ta.clientWidth}px`;
  st.boxSizing = cs.boxSizing;
  st.fontFamily = cs.fontFamily;
  st.fontSize = cs.fontSize;
  st.fontWeight = cs.fontWeight;
  st.lineHeight = cs.lineHeight;
  st.letterSpacing = cs.letterSpacing;
  st.padding = cs.padding;
  st.border = cs.border;
  st.tabSize = cs.tabSize;
  const value = ta.value || '';
  const clamped = Math.max(0, Math.min(Number(index) || 0, value.length));
  mirror.textContent = value.slice(0, clamped);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  return { top: marker.offsetTop, left: marker.offsetLeft,
           height: marker.offsetHeight || parseFloat(cs.lineHeight) || 16 };
}
function renderCollabPresence() {
  const box = document.getElementById('collab-presence');
  const layer = document.getElementById('collab-caret-layer');
  if (!collab.noteId) {
    if (box) box.innerHTML = '';
    if (layer) layer.innerHTML = '';
    return;
  }
  const now = Date.now();
  const entries = [];
  collab.presence.forEach((p, id) => {
    if (now - p.ts < COLLAB_PRESENCE_TTL_MS) entries.push({ id, ...p });
    else collab.presence.delete(id);
  });
  entries.sort((a, b) => String(a.user).localeCompare(String(b.user)));
  if (box) {
    // Always show a "you" chip so the row is visible even when alone; remote
    // peers are appended after it.
    const meName = (cachedProfile && cachedProfile.username) || 'You';
    const self = `<span class="collab-presence-chip${collab.typing ? ' is-typing' : ''}"><span class="collab-presence-dot" style="background:${collab.color || '#888'}"></span>${escapeHtml(meName)} (you)${collab.typing ? ' · typing…' : ''}</span>`;
    box.innerHTML = self + entries.map((p) => `<span class="collab-presence-chip${p.typing ? ' is-typing' : ''}"><span class="collab-presence-dot" style="background:${p.color}"></span>${escapeHtml(p.user || 'Someone')}${p.typing ? ' · typing…' : ''}</span>`).join('');
  }
  if (layer) {
    if (writeMode !== 'edit') { layer.innerHTML = ''; }
    else {
      layer.innerHTML = entries.map((p) => {
        const c = collabCaretCoords(p.s);
        if (!c) return '';
        return `<div class="collab-caret" style="top:${c.top}px;left:${c.left}px;height:${c.height}px;background:${p.color}"><span class="collab-caret-label" style="background:${p.color}">${escapeHtml(p.user || '')}</span></div>`;
      }).join('');
    }
  }
}
function collabPresenceLocal(typing) {
  if (!collab.noteId) return;
  if (typing) {
    collab.typing = true;
    clearTimeout(collabTypingTimer);
    collabTypingTimer = setTimeout(() => { collab.typing = false; }, 1500);
  }
  if (collabPresenceLocalTimer) return;
  collabPresenceLocalTimer = setTimeout(() => { collabPresenceLocalTimer = null; collabSendPresence(false); }, 120);
}
async function collabSendPresence(leave) {
  if (!collab.noteId || !collab.key || !collab.clientId) return;
  const noteId = collab.noteId;
  const key = collab.key;
  const keyVersion = collab.keyVersion;
  const ta = markdownInput;
  const body = JSON.stringify({
    id: collab.clientId,
    u: (cachedProfile && cachedProfile.username) || '',
    c: collab.color,
    s: ta ? ta.selectionStart : 0,
    e: ta ? ta.selectionEnd : 0,
    typing: !leave && collab.typing === true,
    leave: Boolean(leave),
  });
  try {
    const payload = await collabEncrypt(key, new TextEncoder().encode(body));
    if (!leave && collab.noteId !== noteId) return; // note changed while encrypting
    await apiFetch(`/api/collab/notes/${noteId}/presence`, { method: 'POST', body: JSON.stringify({ payload, keyVersion }) });
  } catch (error) {}
}
async function collabPresenceReceive(msg) {
  if (!collab.noteId) return;
  const key = collabKeyFor(msg.version);
  if (!key) return;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(await collabDecrypt(key, msg.payload))); } catch (error) { return; }
  const id = String(data.id || '');
  if (!id || id === collab.clientId) return;
  if (data.leave) { collab.presence.delete(id); renderCollabPresence(); return; }
  collab.presence.set(id, {
    user: String(data.u || ''),
    color: typeof data.c === 'string' ? data.c : '#888',
    s: Number(data.s) || 0,
    e: Number(data.e) || 0,
    typing: Boolean(data.typing),
    ts: Date.now(),
  });
  renderCollabPresence();
}
function collabPresenceHeartbeat() {
  if (!collab.noteId) return;
  collabSendPresence(false);
  renderCollabPresence();
  collab.presenceTimer = setTimeout(collabPresenceHeartbeat, 5000);
}
// Local edits go through an outbox so nothing is lost while offline or when a
// POST fails: queued Yjs updates are retried until the server acks them. A 409
// means the section key moved under us, so the full local state is compacted
// instead (which also clears the queue).
async function collabBroadcast(update) {
  if (!collab.key || !collab.noteId) return;
  collab.outbox.push(update);
  if (collab.outbox.length >= 200) { collab.outbox.length = 0; collabCompact(); return; }
  flushCollabOutbox();
}
function scheduleCollabFlush() {
  if (collab.flushTimer || !collab.noteId) return;
  collab.flushTimer = setTimeout(() => { collab.flushTimer = null; flushCollabOutbox(); }, 5000);
}
async function flushCollabOutbox() {
  if (collab.flushing || !collab.outbox.length || !collab.key || !collab.noteId) return;
  collab.flushing = true;
  try {
    while (collab.outbox.length) {
      const update = collab.outbox[0];
      let res;
      try {
        const payload = await collabEncrypt(collab.key, update);
        res = await apiFetch(`/api/collab/notes/${collab.noteId}/updates`, {
          method: 'POST', body: JSON.stringify({ payload, keyVersion: collab.keyVersion }) });
      } catch (error) {
        setCollabStatus(`Offline — ${collab.outbox.length} unsent`, true);
        scheduleCollabFlush();
        return;
      }
      if (res.ok) { collab.outbox.shift(); continue; }
      if (res.status === 409) {
        // Epoch changed under us: drop the stale queue and push the full state.
        collab.outbox.length = 0;
        await collabCompact();
        return;
      }
      setCollabStatus(`Offline — ${collab.outbox.length} unsent`, true);
      scheduleCollabFlush();
      return;
    }
    setCollabStatus('Live · connected', false);
  } finally {
    collab.flushing = false;
  }
}
async function collabCompact() {
  if (!collab.doc || !collab.key || !collab.noteId) return;
  try {
    const Y = await loadYjs();
    const state = Y.encodeStateAsUpdate(collab.doc);
    const payload = await collabEncrypt(collab.key, state);
    const res = await apiFetch(`/api/collab/notes/${collab.noteId}/compact`, { method: 'POST', body: JSON.stringify({ state: payload, keyVersion: collab.keyVersion }) });
    if (res && res.ok) collab.outbox.length = 0; // full state covers every queued update
  } catch (error) {}
}
function collabConnect(noteId, keyRaw, Y, doc) {
  if (collab.es) { try { collab.es.close(); } catch (error) {} collab.es = null; }
  let es;
  try { es = new EventSource(`/api/collab/notes/${noteId}/stream`); }
  catch (error) { setCollabStatus('Could not connect', true); return; }
  collab.es = es;
  es.onopen = () => { setCollabStatus('Live · connected', false); flushCollabOutbox(); };
  es.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch (error) { return; }
    if (msg.type === 'closed') { setCollabStatus('This note was closed', true); return; }
    if (msg.type === 'rekey') {
      // Owner rotated the section key: adopt the new epoch so our edits are
      // encrypted under the key the removed member does not have.
      await collabAdoptRekey(msg.version);
      return;
    }
    if (msg.type === 'presence') { collabPresenceReceive(msg); return; }
    if (msg.type !== 'state' && msg.type !== 'update') return;
    const key = collabKeyFor(msg.version);
    if (!key) return;
    try { Y.applyUpdate(doc, await collabDecrypt(key, msg.payload), 'remote'); } catch (error) {}
  };
  // EventSource auto-reconnects; the stream replays state + backlog on reconnect.
  es.onerror = () => { if (collab.noteId === noteId) setCollabStatus('Offline — retrying…', true); };
}

// Fetch and unlock the new epoch key after the owner rotates, and switch to it.
async function collabAdoptRekey(version) {
  if (!collab.groupId) return;
  try {
    const res = await apiFetch(`/api/collab/groups/${collab.groupId}`);
    if (!res.ok) return;
    const g = await res.json();
    const key = await unwrapMyKey(g.myKey, collab.groupId, cachedProfile && cachedProfile.username, g.myKeyVersion);
    const v = Number(g.keyVersion || g.myKeyVersion || version || (collab.keyVersion + 1));
    collab.keys.set(v, key);
    collab.keyVersion = v;
    collab.key = key;
    setCollabStatus(`Rekeyed · v${v}`, false);
  } catch (error) {}
}
async function openCollabNote(noteId) {
  if (!e2ee.masterKey) { showToast('Log in and unlock your notes first'); return; }
  if (!(await sharingEnsureKeys())) { showToast('Could not unlock your sharing keys'); return; }
  let res;
  try { res = await apiFetch(`/api/collab/notes/${noteId}`); } catch (error) { res = null; }
  if (!res || !res.ok) { showToast('Cannot open that shared note'); return; }
  const meta = await res.json();
  let keyRaw;
  try { keyRaw = await unwrapMyKey(meta.myKey, meta.groupId, cachedProfile && cachedProfile.username, meta.myKeyVersion); }
  catch (error) { showToast(error && error.message ? error.message : 'You no longer have access to this note'); return; }
  // Group metadata gives the section name + members.
  let group = { name: '', members: [] };
  try { const g = await apiFetch(`/api/collab/groups/${meta.groupId}`); if (g.ok) group = await g.json(); } catch (error) {}
  // Section-level tags/folders (owner-curated) so the tag editor can suggest them.
  if (group.encMeta) {
    try {
      const gm = await collabDecryptGroupMeta(keyRaw, group.encMeta);
      sharedGroupTags.set(meta.groupId, gm.tags || []);
      if (!sharedGroupFolders.has(meta.groupId)) sharedGroupFolders.set(meta.groupId, gm.folders || []);
      sharedGroupOwners.set(meta.groupId, meta.owner);
    } catch (error) {}
  }
  const Y = await loadYjs();
  closeCollabNote();
  const doc = new Y.Doc();
  let noteMeta = { title: '', folder: '', template: '', tags: [] };
  try { noteMeta = await collabDecryptMeta(keyRaw, meta.encMeta || ''); } catch (error) {}
  Object.assign(collab, {
    noteId, groupId: meta.groupId, doc,
    title: doc.getText('title'), body: doc.getText('body'), desc: doc.getText('desc'),
    assets: doc.getMap('assets'), recipe: doc.getMap('recipe'), tags: doc.getArray('tags'), cover: '', description: '',
    es: null, key: keyRaw, keyVersion: Number(meta.keyVersion) || 1,
    keys: new Map([[Number(meta.keyVersion) || 1, keyRaw]]),
    members: group.members || [], pending: group.pending || [], owner: meta.owner, groupName: group.name || '',
    folder: noteMeta.folder || '', template: noteMeta.template || '', updates: 0,
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote') return;
    collab.updates += 1;
    collabBroadcast(update);
    if (collab.updates % 40 === 0) collabCompact();
  });
  collab.title.observe(collabSyncDom);
  collab.body.observe(collabSyncDom);
  collab.desc.observe(collabSyncDom);
  collab.assets.observe(collabAssetsChanged);
  collab.recipe.observe((event, transaction) => { if (transaction && transaction.origin === 'remote') renderRecipeBody(null); });
  collab.tags.observe(() => { renderSharedTags(); scheduleCollabMeta(); });
  collab.body.observe(() => { if (collab.noteId != null) sharedBodyCache.set(String(collab.noteId), collab.body.toString()); });
  sharedBodyCache.set(String(noteId), collab.body.toString());
  renderSharedTags();
  const delBtn = document.getElementById('collab-delete');
  if (delBtn) delBtn.hidden = !(collab.owner === (cachedProfile && cachedProfile.username));
  // Bind the standard editor to the shared doc (title + Markdown body).
  writeMode = 'edit';
  if (titleInput) titleInput.value = collab.title.toString();
  if (markdownInput) markdownInput.value = collab.body.toString();
  try { refreshEditorLock(); } catch (error) {}
  // refreshEditorLock bails out for shared notes, so enable the recipe hero
  // controls here (a shared recipe is always editable while it is open).
  const recipeDesc = document.getElementById('recipe-desc');
  if (recipeDesc) recipeDesc.disabled = false;
  const recipePhotoBtn = document.getElementById('recipe-photo-btn');
  if (recipePhotoBtn) recipePhotoBtn.disabled = false;
  try { renderRecipeHero(null); } catch (error) {}
  try { collabAssetsChanged(); } catch (error) {}
  try { renderPreview(null); } catch (error) {}
  try { markdownInput.focus({ preventScroll: true }); } catch (error) {}
  renderCollabMembersModal();
  // Presence: a stable per-open client id + colour, then a heartbeat loop that
  // broadcasts our cursor and prunes stale peers.
  collab.clientId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `c${Date.now()}${Math.random()}`;
  collab.color = collabPresenceColor(cachedProfile && cachedProfile.username);
  collab.typing = false;
  collab.presence.clear();
  if (collab.presenceTimer) { clearTimeout(collab.presenceTimer); collab.presenceTimer = null; }
  collabPresenceHeartbeat();
  // Only the owner may invite members.
  const inviteBtn = document.getElementById('collab-invite');
  if (inviteBtn) inviteBtn.hidden = !(collab.owner === (cachedProfile && cachedProfile.username));
  setCollabStatus('Connecting…', false);
  const collabTop = document.getElementById('collab-top');
  if (collabTop) collabTop.hidden = false;
  const editorPanel = document.querySelector('.editor-panel');
  if (editorPanel) editorPanel.classList.add('collab-mode');
  trackTab(noteId, false, true);
  try { renderTabs(); } catch (error) {}
  collabConnect(noteId, keyRaw, Y, doc);
}
function closeCollabNote() {
  if (collab.reconnect) { clearTimeout(collab.reconnect); collab.reconnect = null; }
  // Tell peers we left (best-effort; reads current key/note before clearing).
  try { collabSendPresence(true); } catch (error) {}
  const statusEl = document.getElementById('collab-status');
  const statusSep = document.getElementById('collab-status-sep');
  if (statusEl) statusEl.hidden = true;
  if (statusSep) statusSep.hidden = true;
  const collabTop = document.getElementById('collab-top');
  if (collabTop) collabTop.hidden = true;
  const editorPanel = document.querySelector('.editor-panel');
  if (editorPanel) editorPanel.classList.remove('collab-mode');
  if (collab.es) { try { collab.es.close(); } catch (error) {} }
  if (collab.doc) { try { collab.doc.destroy(); } catch (error) {} }
  collab.noteId = null; collab.groupId = null; collab.doc = null; collab.title = null; collab.body = null;
  collab.desc = null; collab.assets = null; collab.recipe = null; collab.cover = ''; collab.description = '';
  collab.es = null; collab.key = null; collab.keyVersion = 1; collab.keys = new Map();
  collab.members = []; collab.owner = null; collab.groupName = ''; collab.template = '';
  if (collab.flushTimer) { clearTimeout(collab.flushTimer); collab.flushTimer = null; }
  if (collab.presenceTimer) { clearTimeout(collab.presenceTimer); collab.presenceTimer = null; }
  collab.outbox = []; collab.flushing = false;
  collab.presence.clear(); collab.clientId = null; collab.color = null;
  renderCollabPresence();
  try { renderRecipeHero(null); } catch (error) {}
}
async function collabAddGroupMember(groupId, keyRaw, name, keyVersion) {
  const pub = await sharingRecipientPublicKey(name);
  const wrap = await wrapRawKeyFor(pub, keyRaw);
  wrap.sig = await signWrap(groupId, name, keyVersion, wrap);
  const res = await apiFetch(`/api/collab/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ username: name, ...wrap }) });
  if (!res.ok) {
    let message = 'Could not add member';
    try { const d = await res.json(); if (d && d.error) message = d.error; } catch (error) {}
    throw new Error(message);
  }
}
// Start a connection: create a shared section for the person (no note yet).
// They receive a "<you> wants to connect with you" request to accept.
async function collabCreateSection(members) {
  const names = Array.isArray(members) ? members : [];
  const keyRaw = e2eeRandomBytes(32);
  let selfPub;
  try { selfPub = await sharingRecipientPublicKey(cachedProfile.username); }
  catch (error) { showToast('Could not load your public key'); return null; }
  const wrap = await wrapRawKeyFor(selfPub, keyRaw);
  // Self-wrap: signed over an empty group id (the group does not exist yet);
  // verification is skipped for one's own wrap.
  wrap.sig = await signWrap('', cachedProfile.username, 1, wrap);
  const name = names[0] || 'Connection';
  const res = await apiFetch('/api/collab/groups', { method: 'POST', body: JSON.stringify({ name, ...wrap }) });
  if (!res.ok) { showToast('Could not start the connection'); return null; }
  const data = await res.json();
  const failed = [];
  for (const who of names) {
    try { await collabAddGroupMember(data.id, keyRaw, who, 1); }
    catch (error) { failed.push(`${who}: ${error && error.message ? error.message : 'failed'}`); }
  }
  if (activeView === 'shared') renderSharedView();
  if (failed.length) showToast(`Connection started, but some requests failed — ${failed[0]}`);
  else showToast(`Connection request sent to ${names.join(', ')}`);
  return data.id;
}
// New-note entry in the Shared tree: ask which template to start from first.
let pendingSharedTemplate = null; // { groupId, folder } | null
function openSharedNewNote(groupId, folder) {
  pendingSharedTemplate = { groupId, folder: folder || '' };
  openTemplatePicker();
}
function sharedUniqueTitle(base, groupId) {
  const used = new Set();
  sharedNoteMeta.forEach((m) => {
    if (String(m.groupId) === String(groupId)) {
      const t = (m.title || '').trim().toLowerCase();
      if (t) used.add(t);
    }
  });
  if (!used.has(base.toLowerCase())) return base;
  let i = 2;
  while (used.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}
// Start a shared note from the same templates used by All Notes.
async function createSharedNoteWithTemplate(groupId, folder, templateKey) {
  const key0 = NOTE_TEMPLATES[templateKey] ? templateKey : 'standard';
  if (!e2ee.masterKey) { showToast('Log in and unlock your notes first'); return; }
  if (!(await sharingEnsureKeys())) { showToast('Could not unlock your sharing keys'); return; }
  let key;
  try { key = (await collabGroupKey(groupId)).key; }
  catch (error) { showToast('You no longer have access to this section'); return; }
  const seed = seedFromTemplate(key0, sharedUniqueTitle(NOTE_TEMPLATES[key0].titleBase, groupId));
  const encMeta = await collabEncryptMeta(key, { title: seed.title, folder: folder || '', template: key0 });
  const res = await apiFetch(`/api/collab/groups/${groupId}/notes`, { method: 'POST', body: JSON.stringify({ encMeta }) });
  if (!res.ok) { showToast('Could not create the note'); return; }
  const note = await res.json();
  // Seed the template title + body as the note's first CRDT update, so the
  // editor and every member joining later start from the (possibly edited)
  // template instead of racing a post-connect insert.
  try {
    const Y = await loadYjs();
    const doc = new Y.Doc();
    doc.getText('title').insert(0, seed.title);
    if (seed.body) doc.getText('body').insert(0, seed.body);
    const template = NOTE_TEMPLATES[key0];
    if (key0 === 'recipe' && template.recipe) {
      doc.getMap('recipe').set('ingredients', JSON.stringify(sanitizeIngredients(template.recipe.ingredients)));
      doc.getMap('recipe').set('steps', JSON.stringify(sanitizeSteps(template.recipe.steps)));
    }
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const payload = await collabEncrypt(key, update);
    await apiFetch(`/api/collab/notes/${note.id}/updates`, { method: 'POST', body: JSON.stringify({ payload }) });
  } catch (error) {}
  await openCollabNote(note.id);
  if (activeView === 'shared') renderSharedView();
}
// Add a subfolder under an existing shared folder (persisted in group meta).
async function addSubfolder(groupId, parentFolder) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const value = await askInput({ eyebrow: 'Subfolder', title: 'Add a subfolder', desc: `Under ${parentFolder}`, label: 'Name', password: false, placeholder: 'e.g. Notes', okText: 'Add' });
  if (value == null) return;
  const name = String(value).trim().replace(/[\/\\]+/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
  if (!name) return;
  const folder = `${parentFolder}${FOLDER_SEP}${name}`;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  if (existing.some((f) => f.toLowerCase() === folder.toLowerCase())) { showToast('That subfolder already exists'); return; }
  try {
    const encMeta = await collabEncryptGroupMeta(key, [...existing, folder], sharedGroupTagList(groupId));
    const res = await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    if (!res.ok) { showToast('Could not add the subfolder'); return; }
    showToast(`Subfolder \u201c${name}\u201d added`);
    renderSharedView();
  } catch (error) { showToast('Could not add the subfolder'); }
}
async function collabInvite() {
  if (!collab.groupId || !collab.key) return;
  const me = cachedProfile && cachedProfile.username;
  if (collab.owner !== me) { showToast('Only the owner can add members'); return; }
  const value = await askInput({ eyebrow: 'Invite', title: 'Add a member', desc: 'They need a Notely account and must have logged in once.', label: 'Username', password: false, placeholder: 'their-username', okText: 'Invite' });
  if (value == null) return;
  const target = String(value).trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(target)) { showToast('Invalid username'); return; }
  try {
    await collabAddGroupMember(collab.groupId, collab.key, target, collab.keyVersion);
    collab.pending = collab.pending || [];
    if (!collab.pending.includes(target)) collab.pending.push(target);
    renderCollabMembersModal();
    showToast(`Invited ${target}`);
  } catch (error) { showToast(error && error.message ? error.message : 'Could not add member'); }
}
async function collabRemoveMember(name) {
  if (!collab.groupId) return;
  const me = cachedProfile && cachedProfile.username;
  if (collab.owner === me && collab.key) {
    // Owner removing a peer: the server rotates the section key in the same
    // request, so a removal can never leave the old key live for the person just
    // cut off. Keys never leave the members' devices.
    setCollabStatus('Rotating section key…', false);
    const ok = await collabRotateSectionKey(name);
    renderCollabMembersModal();
    showToast(ok ? `Removed ${name} — section key rotated` : `Could not remove ${name}`);
    return;
  }
  const res = await apiFetch(`/api/collab/groups/${collab.groupId}/members/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Could not remove member'); return; }
  collab.members = collab.members.filter((m) => m !== name);
  renderCollabMembersModal();
  showToast(`Removed ${name}`);
}

// Owner-side key rotation: generate a new epoch key, re-encrypt every note in
// the section under it, publish a wrap per remaining member, then commit the new
// version. Reusing the server only as blob storage; the key itself is never sent.
// When `remove` names a member, the server removes them and bumps the epoch in a
// single transaction, so the two can never diverge.
async function collabRotateSectionKey(remove) {
  if (!collab.groupId || !collab.key) return false;
  const Y = await loadYjs();
  const newVersion = (collab.keyVersion || 1) + 1;
  const newKey = e2eeRandomBytes(32);
  const oldKey = collab.key;
  // 1) Publish the new epoch: wrap the new key to every remaining accepted
  //    member (self included) and, when removing, do it in the same request.
  const remaining = (collab.members || []).filter((m) => m !== remove);
  const keys = [];
  for (const member of [...new Set(remaining)]) {
    try {
      const pub = await sharingRecipientPublicKey(member);
      const w = await wrapRawKeyFor(pub, newKey);
      w.sig = await signWrap(collab.groupId, member, newVersion, w);
      keys.push({ username: member, ...w });
    } catch (error) {}
  }
  const url = remove
    ? `/api/collab/groups/${collab.groupId}/members/${encodeURIComponent(remove)}`
    : `/api/collab/groups/${collab.groupId}/rotate`;
  const rr = await apiFetch(url, {
    method: remove ? 'DELETE' : 'POST', body: JSON.stringify({ keyVersion: newVersion, keys }) });
  if (!rr.ok) { showToast('Could not rotate the section key'); return false; }
  collab.keys.set(newVersion, newKey);
  collab.keyVersion = newVersion;
  collab.key = newKey;
  if (remove) collab.members = remaining;
  // 2) Re-encrypt every note in the section under the new key (the old key is
  //    still in collab.keys, so we can decrypt each note's existing ciphertext),
  //    including each note's title/folder meta and the section's folder list —
  //    otherwise meta stays locked to the old epoch. Compacting replaces the
  //    snapshot and drops the old update log.
  let groupNotes = [];
  let groupEncMeta = '';
  try {
    const res = await apiFetch('/api/collab/groups');
    if (res.ok) {
      const data = await res.json();
      const g = (data.groups || []).find((x) => String(x.id) === String(collab.groupId));
      groupNotes = g ? (g.notes || []) : [];
      groupEncMeta = g ? (g.encMeta || '') : '';
    }
  } catch (error) {}
  for (const n of groupNotes) {
    try {
      const res = await apiFetch(`/api/collab/notes/${n.id}/state`);
      if (res.ok) {
        const data = await res.json();
        const doc = new Y.Doc();
        if (data.encState) {
          try { Y.applyUpdate(doc, await collabDecrypt(collabKeyFor(data.keyVersion), data.encState), 'rotate'); } catch (error) {}
        }
        for (const u of (data.updates || [])) {
          try { Y.applyUpdate(doc, await collabDecrypt(collabKeyFor(u.version), u.payload), 'rotate'); } catch (error) {}
        }
        const packed = await collabEncrypt(newKey, Y.encodeStateAsUpdate(doc));
        await apiFetch(`/api/collab/notes/${n.id}/compact`, { method: 'POST', body: JSON.stringify({ state: packed, keyVersion: newVersion }) });
        doc.destroy();
      }
      if (n.encMeta) {
        const meta = await collabDecryptMeta(oldKey, n.encMeta);
        await apiFetch(`/api/collab/notes/${n.id}/meta`, { method: 'POST', body: JSON.stringify({ encMeta: await collabEncryptMeta(newKey, meta) }) });
      }
    } catch (error) {}
  }
  if (groupEncMeta) {
    try {
      const gf = await collabDecryptGroupMeta(oldKey, groupEncMeta);
      await apiFetch(`/api/collab/groups/${collab.groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta: await collabEncryptGroupMeta(newKey, gf.folders || [], gf.tags || []) }) });
    } catch (error) {}
  }
  return true;
}
// Section-scoped rotation used when a section is flagged rekey_needed: a member
// left or deleted their account. Any remaining member holding the key can rotate
// — new epoch, re-wrap for everyone still in the section, re-encrypt the notes.
async function rotateGroupSection({ groupId, key, version, members, notes, folderMeta, remove }) {
  const Y = await loadYjs();
  const newVersion = (Number(version) || 1) + 1;
  const newKey = e2eeRandomBytes(32);
  const remaining = (members || []).filter((m) => m !== remove);
  const keys = [];
  for (const member of [...new Set(remaining)]) {
    try {
      const pub = await sharingRecipientPublicKey(member);
      const w = await wrapRawKeyFor(pub, newKey);
      w.sig = await signWrap(groupId, member, newVersion, w);
      keys.push({ username: member, ...w });
    } catch (error) {}
  }
  const url = remove
    ? `/api/collab/groups/${groupId}/members/${encodeURIComponent(remove)}`
    : `/api/collab/groups/${groupId}/rotate`;
  const rr = await apiFetch(url, {
    method: remove ? 'DELETE' : 'POST', body: JSON.stringify({ keyVersion: newVersion, keys }) });
  if (!rr.ok) return false;
  for (const n of (notes || [])) {
    try {
      const res = await apiFetch(`/api/collab/notes/${n.id}/state`);
      if (res.ok) {
        const data = await res.json();
        const doc = new Y.Doc();
        if (data.encState) { try { Y.applyUpdate(doc, await collabDecrypt(key, data.encState), 'rotate'); } catch (error) {} }
        for (const u of (data.updates || [])) { try { Y.applyUpdate(doc, await collabDecrypt(key, u.payload), 'rotate'); } catch (error) {} }
        const packed = await collabEncrypt(newKey, Y.encodeStateAsUpdate(doc));
        await apiFetch(`/api/collab/notes/${n.id}/compact`, { method: 'POST', body: JSON.stringify({ state: packed, keyVersion: newVersion }) });
        doc.destroy();
      }
      if (n.encMeta) {
        const meta = await collabDecryptMeta(key, n.encMeta);
        await apiFetch(`/api/collab/notes/${n.id}/meta`, { method: 'POST', body: JSON.stringify({ encMeta: await collabEncryptMeta(newKey, meta) }) });
      }
    } catch (error) {}
  }
  if (folderMeta) {
    try {
      const gf = await collabDecryptGroupMeta(key, folderMeta);
      await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta: await collabEncryptGroupMeta(newKey, gf.folders || [], gf.tags || []) }) });
    } catch (error) {}
  }
  return true;
}
const rekeyInFlight = new Set();
async function rekeyGroupIfNeeded(group, key) {
  if (!group || !key || !group.rekeyNeeded || rekeyInFlight.has(group.id)) return;
  // Only a member holding the current epoch may rotate. A stale wrap (e.g. an
  // invite accepted after a rekey) must not rotate — it would re-encrypt with an
  // old key and lose content. Another member rotates and re-wraps us instead.
  if (Number(group.myKeyVersion) !== Number(group.keyVersion)) return;
  rekeyInFlight.add(group.id);
  try {
    const ok = await rotateGroupSection({
      groupId: group.id, key, version: group.keyVersion,
      members: group.members || [], notes: group.notes || [], folderMeta: group.encMeta || '' });
    if (ok) showToast('Section key rotated after a member left');
  } finally {
    rekeyInFlight.delete(group.id);
  }
}
// A member leaves a shared section: remove ourselves. The server flags the
// section so a remaining member rotates the key on next open (the server holds
// no key to rotate with).
async function leaveSharedSection(groupId) {
  const me = cachedProfile && cachedProfile.username;
  if (!me) return;
  const res = await apiFetch(`/api/collab/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(me)}`, { method: 'DELETE' });
  if (res.ok) { showToast('Left the section'); renderSharedView(); }
  else showToast('Could not leave the section');
}
async function collabDeleteNote(noteId) {
  const me = cachedProfile && cachedProfile.username;
  if (collab.noteId != null && String(collab.noteId) === String(noteId) && collab.owner !== me) {
    showToast('Only the owner can delete a shared note');
    return;
  }
  const res = await apiFetch(`/api/collab/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
  if (res.ok) {
    if (collab.noteId === Number(noteId) || String(collab.noteId) === String(noteId)) closeCollabNote();
    openTabs = openTabs.filter((tab) => !(tab.shared && String(tab.id) === String(noteId)));
    try { renderTabs(); } catch (error) {}
    if (activeView === 'shared') renderSharedView();
  } else {
    let msg = 'Could not delete the note';
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (error) {}
    showToast(msg);
  }
}
async function collabDeleteGroup(groupId) {
  const res = await apiFetch(`/api/collab/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
  if (res.ok) { if (String(collab.groupId) === String(groupId)) closeCollabNote(); showToast('Shared section deleted'); if (activeView === 'shared') renderSharedView(); }
  else showToast('Could not delete the section');
}
function confirmDeleteGroup(groupId) {
  pendingDeleteId = String(groupId);
  pendingDeleteMode = 'collab-group';
  pendingDeleteTag = null;
  setDeleteDialog({ eyebrow: 'Delete section', title: 'Delete this shared section?', name: 'This section', message: '” and all its notes will be deleted for everyone. This cannot be undone.' });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}
// Popup: ask who the new shared section is for.
function parseUsernames(raw) {
  // Owner + invitees must stay within the 4-member section cap.
  return String(raw || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
}
function openCollabNewDialog() {
  const overlay = document.getElementById('collab-new-overlay');
  if (!overlay) return;
  const input = document.getElementById('collab-new-members');
  if (input) input.value = '';
  const status = document.getElementById('collab-new-status');
  if (status) { status.hidden = true; status.textContent = ''; }
  overlay.hidden = false;
  if (input) { try { input.focus(); } catch (error) {} }
}
function closeCollabNewDialog() {
  const overlay = document.getElementById('collab-new-overlay');
  if (overlay) overlay.hidden = true;
}
function setCollabNewStatus(message) {
  const status = document.getElementById('collab-new-status');
  if (status) { status.textContent = message; status.hidden = false; }
}
async function confirmCollabNew() {
  const input = document.getElementById('collab-new-members');
  const me = cachedProfile && cachedProfile.username;
  const names = parseUsernames(input ? input.value : '').filter((n) => /^[A-Za-z0-9_-]{3,32}$/.test(n) && n !== me);
  if (!names.length) { setCollabNewStatus('Enter at least one valid username (not your own).'); return; }
  if (!(await sharingEnsureKeys())) { setCollabNewStatus('Could not set up sharing keys.'); return; }
  const btn = document.getElementById('collab-new-create');
  if (btn) btn.disabled = true;
  setCollabNewStatus('Sending…');
  try {
    await collabCreateSection(names);
    closeCollabNewDialog();
  } catch (error) {
    setCollabNewStatus(error && error.message ? error.message : 'Could not create the section.');
  } finally {
    if (btn) btn.disabled = false;
  }
}
// Bottom "+ New note" opens the same popup (a new person = a new section).
function collabCreate() { openCollabNewDialog(); }

// The Shared view: one section per person, each holding automatically-shared notes.
const sharedGroupKeys = new Map(); // groupId -> unwrapped group key
const sharedGroupFolders = new Map(); // groupId -> [folder, ...]
const sharedGroupTags = new Map(); // groupId -> [tag, ...] (owner-curated, section-level)
const sharedGroupOwners = new Map(); // groupId -> owner username
function sharedGroupTagList(groupId) {
  return sharedGroupTags.get(groupId) || sharedGroupTags.get(Number(groupId)) || [];
}
function sharedGroupOwnerOf(groupId) {
  return sharedGroupOwners.get(groupId) || sharedGroupOwners.get(Number(groupId)) || null;
}
const sharedNoteMeta = new Map();  // noteId -> { title, folder, tags, groupId }
const sharedBodyCache = new Map(); // noteId -> plaintext body (session cache for body: search)

function sharedNoteRow(n, groupId, canDelete) {
  const title = (n.title && n.title.trim()) ? n.title.trim() : 'Untitled note';
  // Align the note's icon under its folder's icon (folder rows carry a chevron).
  const indent = n.folder ? 8 + folderDepth(n.folder) * 14 + 23 : 8;
  const glyph = (n.template && NOTE_TEMPLATES[n.template] && NOTE_TEMPLATES[n.template].icon) ? NOTE_TEMPLATES[n.template].icon : 'file';
  const deleteAction = canDelete
    ? `<span class="tree-action danger" data-collab-note-delete="${n.id}" role="button" title="Delete note" aria-label="Delete ${escapeHtml(title)}">${icon('trash')}</span>`
    : '';
  return `<button class="tree-file shared-view-row" draggable="true" data-collab-open="${n.id}" data-collab-group="${groupId}" style="padding-left:${indent}px" title="${escapeHtml(title)}">
      <span class="tree-file-icon">${icon(glyph)}</span>
      <span class="tree-file-name">${escapeHtml(title)}</span>
      <span class="tree-action" data-note-folder="${n.id}" data-note-group="${groupId}" role="button" title="Move to folder" aria-label="Move ${escapeHtml(title)} to a folder">${icon('folder-plus')}</span>
      ${deleteAction}
    </button>`;
}

const sharedCollapsed = new Set(); // `${groupId}::${folder}` collapsed folders
function sharedFolderKey(groupId, folder) { return `${groupId}::${folder}`; }
// Every folder key (including ancestors) across all shared sections, for the
// sidebar's collapse-all/expand-all control in the Shared view.
function sharedAllFolderKeys() {
  const keys = new Set();
  const addPath = (groupId, path) => {
    let cur = path;
    while (cur) { keys.add(sharedFolderKey(groupId, cur)); cur = folderParent(cur); }
  };
  sharedGroupFolders.forEach((folders, groupId) => {
    (folders || []).forEach((folder) => { if (folder) addPath(groupId, folder); });
  });
  sharedNoteMeta.forEach((meta) => { if (meta && meta.folder) addPath(meta.groupId, meta.folder); });
  return [...keys];
}

function sharedFolderTree(notesDec, groupId, folderList, canDelete) {
  const set = new Set((folderList || []).filter(Boolean));
  notesDec.forEach((n) => { if (n.folder) set.add(n.folder); });
  const folders = new Set();
  set.forEach((f) => { let cur = f; while (cur) { folders.add(cur); cur = folderParent(cur); } });
  const childrenOf = new Map();
  const roots = [];
  folders.forEach((f) => {
    const parent = folderParent(f);
    if (parent && folders.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(f);
    } else roots.push(f);
  });
  roots.sort((a, b) => a.localeCompare(b));
  childrenOf.forEach((arr) => arr.sort((a, b) => a.localeCompare(b)));
  const parts = [];
  const emit = (folder) => {
    const depth = folderDepth(folder);
    const leaf = folderLeaf(folder);
    const collapsed = sharedCollapsed.has(sharedFolderKey(groupId, folder));
    parts.push(`<div class="shared-folder" draggable="true" data-shared-folder="${escapeHtml(folder)}" data-shared-group="${groupId}" style="padding-left:${8 + depth * 14}px">
        <button type="button" class="shared-folder-toggle${collapsed ? ' is-collapsed' : ''}" data-shared-toggle="${escapeHtml(folder)}" data-shared-group="${groupId}" title="${collapsed ? 'Expand' : 'Collapse'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(leaf)}">${icon('chevron-right')}</button>
        ${icon('folder')}<span class="shared-folder-name">${escapeHtml(leaf)}</span>
        <span class="shared-folder-actions">
          <button type="button" class="shared-folder-action" data-folder-note="${escapeHtml(folder)}" data-folder-group="${groupId}" title="New note in ${escapeHtml(leaf)}" aria-label="New note in ${escapeHtml(leaf)}">${icon('file-text')}</button>
          <button type="button" class="shared-folder-action" data-folder-sub="${escapeHtml(folder)}" data-folder-group="${groupId}" title="New subfolder in ${escapeHtml(leaf)}" aria-label="New subfolder in ${escapeHtml(leaf)}">${icon('folder-plus')}</button>
        </span>
      </div>`);
    if (collapsed) return;
    // A folder's own notes come first, directly under it, then its subfolders.
    notesDec.filter((n) => n.folder === folder).forEach((n) => parts.push(sharedNoteRow(n, groupId, canDelete)));
    (childrenOf.get(folder) || []).forEach(emit);
  };
  roots.forEach(emit);
  notesDec.filter((n) => !n.folder).forEach((n) => parts.push(sharedNoteRow(n, groupId, canDelete)));
  return parts.join('') || '<p class="modal-desc" style="padding:2px 10px 6px">No notes yet — use + New note in this section.</p>';
}

// Sidebar Shared badge: number of connections (plus pending invitations).
function setSharedNavCount(n) {
  const el = document.getElementById('nav-shared-count');
  if (el) el.textContent = String(Math.max(0, Number(n) || 0));
}
async function refreshSharedNavCount() {
  if (!cachedProfile) { setSharedNavCount(0); return; }
  try {
    const res = await apiFetch('/api/collab/groups');
    if (!res.ok) return;
    const data = await res.json();
    const groups = Array.isArray(data.groups) ? data.groups.length : 0;
    const invites = Array.isArray(data.invites) ? data.invites.length : 0;
    setSharedNavCount(groups + invites);
  } catch (error) {}
}

async function renderSharedView() {
  updateBinUI();
  updateVaultUI();
  updateBreadcrumbs();
  const emptyTitle = listEmpty.querySelector('strong');
  const emptySub = listEmpty.querySelector('span:last-child');
  noteList.hidden = false;
  listEmpty.hidden = true;
  if (totalCount) totalCount.textContent = 'Shared notes';
  if (allCount) allCount.textContent = '0';
  if (recentCountEl) recentCountEl.textContent = '0';
  if (starredCountEl) starredCountEl.textContent = '0';
  const headerNew = document.getElementById('shared-new');
  if (headerNew) headerNew.hidden = false;
  const headerRefresh = document.getElementById('refresh-view');
  if (headerRefresh) headerRefresh.hidden = false;
  noteList.innerHTML = `<div class="list-section">
      <div class="list-section-head">
        <span class="list-section-title">People</span>
      </div>
      <div id="shared-view-list"><p class="modal-desc" style="padding:6px 10px">Loading…</p></div>
    </div>`;
  const box = document.getElementById('shared-view-list');
  if (!e2ee.masterKey) { if (box) box.innerHTML = '<p class="modal-desc" style="padding:6px 10px">Log in and unlock your notes first.</p>'; return; }
  let res;
  try { res = await apiFetch('/api/collab/groups'); } catch (error) { res = null; }
  if (!res || !res.ok) { if (box) box.innerHTML = '<p class="modal-desc" style="padding:6px 10px">Could not load shared sections.</p>'; return; }
  const data = await res.json();
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const invites = Array.isArray(data.invites) ? data.invites : [];
  setSharedNavCount(groups.length + invites.length);
  const me = cachedProfile && cachedProfile.username;
  const query = searchQuery.trim();
  const searching = query !== '';
  // Invitations render first and independently of key handling (hidden while searching).
  const invitesHtml = (!searching && invites.length) ? `<div class="list-section">
      <div class="list-section-head"><span class="list-section-title">Invitations</span><span class="shared-group-count">${invites.length}</span></div>
      ${invites.map((inv) => `<div class="shared-invite">
        <span class="shared-invite-text"><strong>${escapeHtml(inv.owner)}</strong> wants to connect with you</span>
        <button type="button" class="btn btn-primary shared-action" data-invite-accept="${inv.id}">Accept</button>
        <button type="button" class="btn btn-secondary shared-action" data-invite-decline="${inv.id}">Decline</button>
      </div>`).join('')}
    </div>` : '';
  if (!groups.length) {
    sharedGroupFolders.clear();
    sharedNoteMeta.clear();
    box.innerHTML = invitesHtml || '<p class="modal-desc" style="padding:6px 10px">No connections yet. Click + New connection and enter a username to start.</p>';
    updateFoldToggle();
    return;
  }
  if (!(await sharingEnsureKeys())) {
    box.innerHTML = invitesHtml + '<p class="modal-desc" style="padding:6px 10px">Could not unlock your sharing keys — reopen Shared to retry.</p>';
    updateFoldToggle();
    return;
  }
  sharedGroupKeys.clear();
  sharedGroupFolders.clear();
  sharedNoteMeta.clear();
  const groupBlocks = [];
  let totalMatches = 0;
  for (const g of groups) {
    const isOwner = g.owner === me;
    const displayName = isOwner ? (g.name || 'Shared') : g.owner;
    let key = null;
    try { key = (await collabGroupKey(g.id)).key; sharedGroupKeys.set(g.id, key); }
    catch (error) { /* cannot decrypt (rare) */ }
    let groupFolders = [];
    let groupTags = [];
    if (key) { try { const gm = await collabDecryptGroupMeta(key, g.encMeta || ''); groupFolders = gm.folders; groupTags = gm.tags; } catch (error) {} }
    sharedGroupFolders.set(g.id, groupFolders);
    sharedGroupTags.set(g.id, groupTags);
    sharedGroupOwners.set(g.id, g.owner);
    const rawNotes = Array.isArray(g.notes) ? g.notes : [];
    const decoded = [];
    for (const n of rawNotes) {
      let meta = { title: '', folder: '', template: '' };
      if (key) { try { meta = await collabDecryptMeta(key, n.encMeta || ''); } catch (error) {} }
      const entry = { id: n.id, title: meta.title, folder: meta.folder, template: meta.template, tags: meta.tags || [], groupId: g.id };
      sharedNoteMeta.set(String(n.id), entry);
      decoded.push(entry);
    }
    // After decoding this render, a flagged section (member left / account
    // deleted) is re-keyed in the background by a remaining member.
    if (key && g.rekeyNeeded) rekeyGroupIfNeeded(g, key);
    const visible = searching ? decoded.filter((entry) => sharedNoteMatchesSearch(entry, query)) : decoded;
    if (searching && !visible.length) continue;
    totalMatches += visible.length;
    groupBlocks.push(`<div class="shared-group">
      <div class="shared-group-head">
        <span class="shared-group-name">${escapeHtml(displayName)}</span>
        <span class="shared-group-count">${searching ? visible.length : decoded.length}</span>
        <button type="button" class="shared-group-add" data-group-addfolder="${g.id}" title="Add a folder to ${escapeHtml(displayName)}" aria-label="Add a folder to ${escapeHtml(displayName)}">${icon('folder-plus')}</button>
        ${isOwner
          ? `<button type="button" class="shared-icon" data-group-settings="${g.id}" title="Section settings" aria-label="Section settings for ${escapeHtml(displayName)}">${icon('settings')}</button>`
            + `<button type="button" class="shared-icon danger" data-group-delete="${g.id}" title="Delete section" aria-label="Delete section">${icon('trash')}</button>`
          : `<button type="button" class="shared-icon" data-group-leave="${g.id}" title="Leave section" aria-label="Leave section">${icon('logout')}</button>`}
      </div>
      ${sharedFolderTree(visible, g.id, searching ? [] : groupFolders, isOwner)}
    </div>`);
  }
  let html = invitesHtml + groupBlocks.join('');
  if (searching && totalMatches === 0) html = `<p class="modal-desc" style="padding:6px 10px">No shared notes match “${escapeHtml(query)}”.</p>`;
  box.innerHTML = html;
  updateFoldToggle();
  try { renderTabs(); } catch (error) {}
}

async function addSharedFolder(groupId) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const value = await askInput({ eyebrow: 'Folder', title: 'Add a folder', desc: 'Type a name, or "Parent / Child" to nest.', label: 'Folder name', password: false, placeholder: 'e.g. Ideas / 2026', okText: 'Add' });
  if (value == null) return;
  const folder = String(value).trim().replace(/\s*\/\s*/g, FOLDER_SEP).replace(/^\/+|\/+$/g, '').slice(0, 180);
  if (!folder) return;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  if (existing.some((f) => f.toLowerCase() === folder.toLowerCase())) { showToast('That folder already exists'); return; }
  try {
    const encMeta = await collabEncryptGroupMeta(key, [...existing, folder], sharedGroupTagList(groupId));
    const res = await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    if (!res.ok) { showToast('Could not add the folder'); return; }
    showToast(`Folder \u201c${folder}\u201d added`);
    renderSharedView();
  } catch (error) { showToast('Could not add the folder'); }
}
async function moveSharedNote(noteId, groupId) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  const entry = sharedNoteMeta.get(String(noteId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const value = await askInput({ eyebrow: 'Folder', title: 'Move to folder', desc: 'Type a folder name, or "Parent / Child" to nest.', label: 'Folder', password: false, placeholder: 'e.g. Ideas / 2026', okText: 'Move' });
  if (value == null) return;
  const folder = String(value).trim().replace(/\s*\/\s*/g, FOLDER_SEP).replace(/^\/+|\/+$/g, '').slice(0, 180);
  try {
    const encMeta = await collabEncryptMeta(key, { title: (entry && entry.title) || '', folder });
    const res = await apiFetch(`/api/collab/notes/${noteId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    if (!res.ok) { showToast('Could not move the note'); return; }
    if (collab.noteId === Number(noteId) || String(collab.noteId) === String(noteId)) collab.folder = folder;
    showToast(folder ? `Moved to ${folder}` : 'Moved to the section root');
    renderSharedView();
  } catch (error) { showToast('Could not move the note'); }
}

// Drag-and-drop: move a note into a folder (no prompt).
async function moveSharedNoteToFolder(noteId, groupId, folder) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  const entry = sharedNoteMeta.get(String(noteId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const target = folder || '';
  if ((entry && entry.folder) === target) return;
  await updateSharedNoteMeta(key, noteId, { title: (entry && entry.title) || '', folder: target });
  if (String(collab.noteId) === String(noteId)) collab.folder = target;
  renderSharedView();
  showToast(target ? `Moved to ${target}` : 'Moved to the section root');
}
// Drag-and-drop: reparent a folder (with its subfolders and notes).
async function reparentSharedFolder(groupId, folder, newParent) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const parent = newParent || '';
  if (parent && (parent === folder || isFolderOrSub(parent, folder))) { showToast("Can't move a folder into itself"); return; }
  const leaf = folderLeaf(folder);
  const newPath = parent ? `${parent}${FOLDER_SEP}${leaf}` : leaf;
  if (newPath === folder) return;
  const prefix = `${folder}${FOLDER_SEP}`;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  const nextFolders = existing.map((f) => (f === folder ? newPath : (f.startsWith(prefix) ? newPath + f.slice(folder.length) : f)));
  for (const e of [...sharedNoteMeta.values()]) {
    if (String(e.groupId) !== String(groupId) || !e.folder) continue;
    if (e.folder === folder || e.folder.startsWith(prefix)) {
      const nf = e.folder === folder ? newPath : newPath + e.folder.slice(folder.length);
      await updateSharedNoteMeta(key, e.id, { title: e.title || '', folder: nf });
    }
  }
  await saveGroupFolders(groupId, key, nextFolders);
  renderSharedView();
  showToast('Folder moved');
}

async function saveGroupFolders(groupId, key, folders) {
  try {
    const encMeta = await collabEncryptGroupMeta(key, folders, sharedGroupTagList(groupId));
    await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
  } catch (error) {}
}

// ---- Owner-only section settings: a section-level tag list -----------------
let sectionSettingsGroupId = null;
function renderSectionSettingsTags() {
  const box = document.getElementById('section-tags-current');
  if (!box) return;
  const tags = sharedGroupTagList(sectionSettingsGroupId);
  box.innerHTML = tags.length
    ? tags.map((tag) => `<button type="button" class="tag-chip" data-section-tag-remove="${escapeHtml(tag)}" title="Remove ${escapeHtml(tag)}">${escapeHtml(tag)}<span aria-hidden="true">×</span></button>`).join('')
    : '<span class="tag-editor-empty">No section tags yet — add one below.</span>';
}
async function saveSectionTags(groupId, tags) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return false; }
  const folders = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  try {
    const encMeta = await collabEncryptGroupMeta(key, folders, tags);
    const res = await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    return res.ok;
  } catch (error) { return false; }
}
function openSectionSettings(groupId) {
  const me = cachedProfile && cachedProfile.username;
  // Owner-only; the cog is only rendered for owners, this is the safety net.
  if (!me || sharedGroupOwnerOf(groupId) !== me) { showToast('Only the owner can change section settings'); return; }
  const overlay = document.getElementById('section-settings-overlay');
  if (!overlay) return;
  sectionSettingsGroupId = Number(groupId) || groupId;
  renderSectionSettingsTags();
  overlay.hidden = false;
  const input = document.getElementById('section-tags-input');
  if (input) { input.value = ''; try { input.focus(); } catch (error) {} }
}
function closeSectionSettings() {
  const overlay = document.getElementById('section-settings-overlay');
  if (overlay) overlay.hidden = true;
  sectionSettingsGroupId = null;
}
function sectionTagAdd(raw) {
  if (sectionSettingsGroupId == null) return;
  const tag = normalizeTagName(raw);
  if (!tag) return;
  const tags = sharedGroupTagList(sectionSettingsGroupId);
  if (tags.some((t) => String(t).toLowerCase() === tag.toLowerCase())) return;
  if (tags.length >= 100) { showToast('Section tag limit reached (100)'); return; }
  const next = [...tags, tag];
  sharedGroupTags.set(sectionSettingsGroupId, next);
  renderSectionSettingsTags();
  saveSectionTags(sectionSettingsGroupId, next).then((ok) => { if (!ok) showToast('Could not save section tags'); });
}
function sectionTagRemove(name) {
  if (sectionSettingsGroupId == null) return;
  const tags = sharedGroupTagList(sectionSettingsGroupId);
  const next = tags.filter((t) => String(t).toLowerCase() !== String(name).toLowerCase());
  if (next.length === tags.length) return;
  sharedGroupTags.set(sectionSettingsGroupId, next);
  renderSectionSettingsTags();
  saveSectionTags(sectionSettingsGroupId, next).then((ok) => { if (!ok) showToast('Could not save section tags'); });
}
async function updateSharedNoteMeta(key, noteId, meta) {
  try {
    // Callers rename/move notes and don't carry tags; preserve them from the
    // last decode so the encrypted meta mirror isn't wiped.
    let tags = meta.tags;
    if (tags === undefined) {
      const existing = sharedNoteMeta.get(String(noteId));
      tags = existing && Array.isArray(existing.tags) ? existing.tags : [];
    }
    const encMeta = await collabEncryptMeta(key, { ...meta, tags });
    await apiFetch(`/api/collab/notes/${noteId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
  } catch (error) {}
}
async function renameSharedFolder(groupId, folder) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const value = await askInput({ eyebrow: 'Rename folder', title: folderLeaf(folder), desc: 'Rename this folder in the shared section.', label: 'Name', password: false, placeholder: folderLeaf(folder), okText: 'Rename' });
  if (value == null) return;
  const leaf = String(value).trim().replace(/[\/\\]+/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
  if (!leaf) return;
  const parent = folderParent(folder);
  const newPath = parent ? `${parent}${FOLDER_SEP}${leaf}` : leaf;
  if (newPath.toLowerCase() === folder.toLowerCase()) return;
  const prefix = `${folder}${FOLDER_SEP}`;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  const nextFolders = existing.map((f) => (f === folder ? newPath : (f.startsWith(prefix) ? newPath + f.slice(folder.length) : f)));
  for (const e of [...sharedNoteMeta.values()]) {
    if (String(e.groupId) !== String(groupId) || !e.folder) continue;
    if (e.folder === folder || e.folder.startsWith(prefix)) {
      const nf = e.folder === folder ? newPath : newPath + e.folder.slice(folder.length);
      await updateSharedNoteMeta(key, e.id, { title: e.title || '', folder: nf });
    }
  }
  await saveGroupFolders(groupId, key, nextFolders);
  showToast('Folder renamed');
  renderSharedView();
}
function confirmDeleteSharedFolder(groupId, folder) {
  pendingDeleteId = String(groupId);
  pendingDeleteMode = 'shared-folder';
  pendingDeleteSection = folder;
  setDeleteDialog({ eyebrow: 'Delete folder', title: 'Delete this folder?', name: folderLeaf(folder), message: '” will be removed from the shared section; its notes move to the section root.' });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) { overlay.hidden = false; const b = document.getElementById('confirm-delete'); if (b) b.focus(); }
}
async function deleteSharedFolderNow(groupId, folder) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const prefix = `${folder}${FOLDER_SEP}`;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  const nextFolders = existing.filter((f) => f !== folder && !f.startsWith(prefix));
  for (const e of [...sharedNoteMeta.values()]) {
    if (String(e.groupId) !== String(groupId) || !e.folder) continue;
    if (e.folder === folder || e.folder.startsWith(prefix)) await updateSharedNoteMeta(key, e.id, { title: e.title || '', folder: '' });
  }
  await saveGroupFolders(groupId, key, nextFolders);
  showToast('Folder deleted');
  renderSharedView();
}

// Right-click menu for shared notes and folders.
let sharedMenuTarget = null;
function closeSharedContextMenu() {
  const menu = document.getElementById('shared-context-menu');
  if (menu) menu.hidden = true;
  sharedMenuTarget = null;
}
function showSharedContextMenu(kind, payload, x, y) {
  const menu = document.getElementById('shared-context-menu');
  if (!menu) return;
  sharedMenuTarget = { kind, ...payload };
  const items = kind === 'note'
    ? [['open', 'file-text', 'Open'], ['move', 'folder-plus', 'Move to folder'], ['delete', 'trash', 'Delete note']]
    : [['folder-note', 'file-text', 'New note here'], ['folder-sub', 'folder-plus', 'New subfolder'],
       ['folder-rename', 'pencil', 'Rename folder'], ['folder-delete', 'trash', 'Delete folder']];
  menu.innerHTML = items.map(([action, glyph, label]) =>
    `<button type="button" class="context-item${action.includes('delete') ? ' danger' : ''}" data-shared-action="${action}" role="menuitem"><span data-icon="${glyph}"></span><span>${label}</span></button>`).join('');
  menu.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  menu.hidden = false;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  if (rect.right > window.innerWidth - pad) menu.style.left = `${Math.max(pad, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight - pad) menu.style.top = `${Math.max(pad, y - rect.height)}px`;
}

async function acceptInvite(id) {
  const res = await apiFetch(`/api/collab/groups/${encodeURIComponent(id)}/accept`, { method: 'POST', body: '{}' });
  if (res.ok) { showToast('Invitation accepted'); renderSharedView(); }
  else showToast('Could not accept the invitation');
}
async function declineInvite(id) {
  const me = cachedProfile && cachedProfile.username;
  const res = await apiFetch(`/api/collab/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(me)}`, { method: 'DELETE' });
  if (res.ok) { showToast('Invitation declined'); renderSharedView(); }
  else showToast('Could not decline the invitation');
}

// Keyboard-accessible delete: mirrors the context-menu rules exactly —
// binned notes ask for permanent-confirm, important-tagged notes ask for
// confirm, everything else soft-deletes straight into Bin.
function requestDeleteNoteById(id) {
  if (!id || typeof id !== 'string' || !isValidNoteId(id)) return;
  const note = notes.find((item) => item.id === id);
  if (!note) return;
  if (note.deleted) openPermanentDeleteConfirm(id);
  else if (isImportant(note)) openDeleteConfirm(id);
  else deleteNoteById(id);
}

let pendingDeleteId = null;
let pendingDeleteMode = 'soft';
let pendingDeleteSection = null; // custom section id for folder/section deletes
let pendingDeleteTag = null; // tag name for tag deletes

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
  else if (mode === 'vault-folder') deleteVaultFolder(id);
  else if (mode === 'custom-section') deleteCustomSection(id);
  else if (mode === 'custom-folder') deleteCustomFolder(sectionId, id);
  else if (mode === 'tag') { if (pendingDeleteTag) { deleteTagEverywhere(pendingDeleteTag); renderSettingsTags(); } }
  else if (mode === 'collab-note') { collabDeleteNote(id); }
  else if (mode === 'collab-group') { collabDeleteGroup(id); }
  else if (mode === 'shared-folder') { deleteSharedFolderNow(Number(id), sectionId); }
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
const vault = { unlocked: false, dek: null, notes: [], blobs: [], meta: null, folders: [] };
let currentVaultId = null;
let vaultModalMode = null; // 'setup' | 'unlock' | 'reset-confirm'

function validVaultBlob(item) {
  return Boolean(item && typeof item.id === 'string' && item.payload
    && typeof item.payload.iv === 'string' && typeof item.payload.data === 'string');
}

// Vault folder names: flat, trimmed, no slashes, capped. Shared by envelope
// reads and the add/rename dialogs.
function cleanVaultFolders(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((name) => typeof name === 'string' && name.trim() && !/[/\\]/.test(name))
    .map((name) => name.trim().replace(/\s+/g, ' ').slice(0, 60))
    .filter(Boolean)
    .slice(0, 200);
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function vaultEncryptNote(note) {
  const iv = e2eeRandomBytes(12);
  const folder = (note && typeof note.folder === 'string' && note.folder.trim())
    ? note.folder.trim().slice(0, 60) : null;
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, vault.dek,
    new TextEncoder().encode(    JSON.stringify({
      id: note.id, title: note.title, body: note.body,
      tags: Array.isArray(note.tags) ? note.tags : [],
      ext: normalizeExt(note.ext),
      date: note.date, favorite: !!note.favorite, folder,
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
    folder: (typeof obj.folder === 'string' && obj.folder.trim()) ? obj.folder.trim().slice(0, 60) : null,
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
  trackTab(id, true);
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
  note.updatedAt = Date.now();
  breadcrumbTitle.textContent = note.title;
  renderPreview(note);
  updateMeta(note);
  renderTabs();
  setSaveLabel('Saving...', 'green');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 450);
}

// + New secret note entry: like + New Note outside the Vault — asks for the
// folder first (only when folders exist), then the template.
let pendingVaultFolder = null; // folder name | null (null = Vault root)
let vaultTemplatePending = false;
function onNewVaultNoteClick() {
  if (!vault.unlocked) { showToast('Unlock the Vault first'); return; }
  pendingVaultFolder = null;
  vaultTemplatePending = false;
  if (vault.folders.length && openVaultFolderPicker()) return;
  vaultTemplatePending = true;
  openTemplatePicker();
}

// Folder destination picker for new vault notes. Reuses the shared
// folder-pick overlay with vault entries (root first).
function openVaultFolderPicker() {
  const box = document.getElementById('folder-pick-options');
  const overlay = document.getElementById('folder-pick-overlay');
  if (!box || !overlay) return false;
  document.getElementById('folder-pick-desc').textContent = 'Where in the Vault should this note land?';
  const rows = [{ name: '', label: 'Vault', sub: 'Top level' }]
    .concat(vault.folders.map((folder) => ({ name: folder, label: folderLeaf(folder), sub: folder })));
  box.innerHTML = rows.map((entry) => `
    <button class="template-option" data-vault-pick="${escapeHtml(entry.name)}">
      <span class="template-icon">${icon('folder')}</span>
      <span class="theme-option-text"><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.sub)}</span></span>
    </button>`).join('');
  box.querySelectorAll('[data-vault-pick]').forEach((btn) => btn.addEventListener('click', () => {
    pendingVaultFolder = btn.dataset.vaultPick || null;
    closeFolderPicker();
    vaultTemplatePending = true;
    openTemplatePicker();
  }));
  overlay.hidden = false;
  const first = box.querySelector('[data-vault-pick]');
  if (first) first.focus();
  return true;
}

// Create a vault note from a template into the picked folder (or Vault root).
function createVaultNoteFromTemplate(templateKey) {
  if (!vault.unlocked) { showToast('Unlock the Vault first'); return null; }
  const template = NOTE_TEMPLATES[templateKey] || NOTE_TEMPLATES.standard;
  const folder = (pendingVaultFolder && vault.folders.includes(pendingVaultFolder)) ? pendingVaultFolder : null;
  pendingVaultFolder = null;
  const title = uniqueVaultTitle(template.titleBase);
  const note = {
    id: newNoteId(), title, body: template.body(title),
    tags: [...template.tags], ext: normalizeExt(template.ext),
    date: 'Now', favorite: false, folder,
  };
  vault.notes.unshift(note);
  currentVaultId = note.id;
  selectVaultNote(note.id);
  persistNotes();
  showToast(folder ? `${template.label} created in ${folder}` : `${template.label} created`);
  return note;
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

// ---- Vault folders (flat, dev): explicit list in the envelope so empty
// folders survive. Notes carry folder (or null for Vault root).
function cleanVaultFolderInput(raw, exceptFolder) {
  const clean = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) return { error: 'Give the folder a name' };
  if (/[/\\]/.test(raw)) return { error: 'Use a plain name without slashes' };
  if (vault.folders.some((entry) => entry !== exceptFolder && entry.toLowerCase() === clean.toLowerCase())) {
    return { error: 'A folder with that name already exists' };
  }
  return { name: clean };
}

function addVaultFolder() {
  if (!vault.unlocked) { showToast('Unlock the Vault first'); return; }
  askInput({ eyebrow: 'Vault', title: 'New vault folder', desc: '', label: 'Folder name', password: false, placeholder: 'e.g. Receipts', okText: 'Create' }).then((value) => {
    if (value == null) return;
    const checked = cleanVaultFolderInput(value, null);
    if (checked.error) { showToast(checked.error); return; }
    vault.folders.push(checked.name);
    persistNotes();
    renderNoteList();
    showToast('Vault folder added');
  });
}

function renameVaultFolder(folder) {
  if (!vault.unlocked || !vault.folders.includes(folder)) return;
  askInput({ eyebrow: 'Vault', title: 'Rename vault folder', desc: '', label: 'Folder name', password: false, placeholder: folder, okText: 'Rename' }).then((value) => {
    if (value == null) return;
    const checked = cleanVaultFolderInput(value, folder);
    if (checked.error) { showToast(checked.error); return; }
    if (checked.name === folder) return;
    vault.folders = vault.folders.map((entry) => (entry === folder ? checked.name : entry));
    vault.notes.forEach((note) => { if (note.folder === folder) note.folder = checked.name; });
    persistNotes();
    renderNoteList();
    showToast('Vault folder renamed');
  });
}

function openVaultFolderDeleteConfirm(folder) {
  const count = vault.notes.filter((note) => note.folder === folder).length;
  pendingDeleteId = folder;
  pendingDeleteMode = 'vault-folder';
  setDeleteDialog({
    eyebrow: 'Delete vault folder',
    title: 'Delete this folder?',
    name: folder,
    message: count
      ? `” holds ${count} secret note${count === 1 ? '' : 's'}. The notes stay in the Vault. Are you sure?`
      : '” is empty. Are you sure you want to delete it?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Delete a vault folder immediately (no Bin in the vault): its notes move to
// the Vault root and everything syncs encrypted as usual.
function deleteVaultFolder(folder) {
  if (!vault.unlocked) return;
  vault.folders = vault.folders.filter((entry) => entry !== folder);
  vault.notes.forEach((note) => { if (note.folder === folder) { note.folder = null; note.date = 'Now'; } });
  persistNotes();
  renderNoteList();
  showToast('Vault folder deleted');
}

// Render the Vault view: lock notice when locked, otherwise one Vault folder
// with the decrypted notes. Counts/footer mirror the normal list shape.
function renderVaultList() {
  updateBinUI(); // Vault never shows Empty Bin; this also clears stale visibility.
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
    renderTabs();
    renderStripItems();
    return;
  }
  if (!vault.notes.length && !vault.folders.length) {
    noteList.innerHTML = '';
    listEmpty.hidden = false;
    noteList.hidden = true;
    if (emptyTitle) emptyTitle.textContent = 'Vault is empty';
    if (emptySub) emptySub.textContent = 'Create your first secret note.';
  } else {
    listEmpty.hidden = true;
    noteList.hidden = false;
    const knownVaultFolders = new Set(vault.folders);
    const rootNotes = vault.notes.filter((note) => !note.folder || !knownVaultFolders.has(note.folder));
    const renderVaultNoteRow = (note) => `
        <button class="tree-file${note.id === currentVaultId ? ' selected' : ''}" data-vault-id="${escapeHtml(note.id)}" title="${escapeHtml(note.title || 'Untitled note')}" draggable="true">
          <span class="tree-file-icon tree-file-icon-md">${icon('file')}</span>
          <span class="tree-file-name">${escapeHtml(note.title || 'Untitled note')}</span>
          <span class="tree-action danger" data-vault-delete="${escapeHtml(note.id)}" title="Delete secret note" role="button" aria-label="Delete ${escapeHtml(note.title || 'Untitled note')}">${icon('trash')}</span>
        </button>`;
    noteList.innerHTML = `
    <div class="tree-folder-wrap" data-folder-wrap="Vault">
      <div class="tree-folder-row">
        <button class="tree-folder" data-folder="Vault" aria-expanded="true" title="Vault">
          <span class="tree-chevron">${icon('chevron-right')}</span>
          <span class="tree-folder-icon">${icon('lock')}</span>
          <span class="tree-folder-name">Vault</span>
          <span class="tree-count">${vault.notes.length}</span>
        </button>
        <button type="button" class="strip-btn" data-vault-folder-add title="New vault folder" aria-label="New vault folder">${icon('folder-plus')}</button>
      </div>
      <div class="tree-children">
        ${vault.folders.map((folder) => {
          const files = vault.notes.filter((note) => note.folder === folder);
          const isCollapsed = collapsedFolders.has(folder);
          return `
        <div class="tree-folder-wrap${isCollapsed ? ' closed' : ''}" data-vault-folder-wrap="${escapeHtml(folder)}">
          <div class="tree-folder-row">
            <button class="tree-folder" data-vault-folder="${escapeHtml(folder)}" aria-expanded="${isCollapsed ? 'false' : 'true'}" title="${escapeHtml(folder)}">
              <span class="tree-chevron">${icon('chevron-right')}</span>
          <span class="tree-folder-icon">${icon(folderIconForDepth(folderDepth(folder)))}</span>
              <span class="tree-folder-name vault-folder-name">${escapeHtml(folder)}</span>
              <span class="tree-count">${files.length}</span>
            </button>
            <button type="button" class="section-delete" data-vault-folder-delete="${escapeHtml(folder)}" title="Delete folder" aria-label="Delete folder ${escapeHtml(folder)}">×</button>
          </div>
          <div class="tree-children">
            ${files.map(renderVaultNoteRow).join('')}
          </div>
        </div>`;
        }).join('')}
        ${rootNotes.map(renderVaultNoteRow).join('')}
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
  const vaultAddBtn = noteList.querySelector('[data-vault-folder-add]');
  if (vaultAddBtn) vaultAddBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    addVaultFolder();
  });
  noteList.querySelectorAll('[data-vault-folder]').forEach((header) => {
    header.addEventListener('click', () => {
      const folder = header.dataset.vaultFolder;
      if (collapsedFolders.has(folder)) collapsedFolders.delete(folder);
      else collapsedFolders.add(folder);
      persistCollapsedFolders();
      renderNoteList();
    });
  });
  noteList.querySelectorAll('[data-vault-folder] .vault-folder-name').forEach((label) => label.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const header = label.closest('[data-vault-folder]');
    if (header) renameVaultFolder(header.dataset.vaultFolder);
  }));
  noteList.querySelectorAll('[data-vault-folder-delete]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    openVaultFolderDeleteConfirm(item.dataset.vaultFolderDelete);
  }));
  // Vault note sorting: drag a secret note onto a vault folder to file it.
  noteList.querySelectorAll('[data-vault-id]').forEach((row) => {
    row.addEventListener('dragstart', (event) => {
      if (!vault.unlocked) { event.preventDefault(); return; }
      event.dataTransfer.setData('text/plain', row.dataset.vaultId);
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  });
  noteList.querySelectorAll('[data-vault-folder]').forEach((header) => {
    header.addEventListener('dragover', (event) => {
      if (!vault.unlocked) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      header.classList.add('drop-target');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drop-target'));
    header.addEventListener('drop', (event) => {
      event.preventDefault();
      const folder = header.dataset.vaultFolder;
      const note = vault.unlocked ? vault.notes.find((entry) => entry.id === event.dataTransfer.getData('text/plain')) : null;
      if (!note || !vault.folders.includes(folder)) return;
      note.folder = folder;
      note.date = 'Now';
      persistNotes();
      renderNoteList();
      showToast(`Moved to “${folder}”`);
    });
  });
  renderTabs();
  renderStripItems();
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

// Wipe vault plaintext (keeping ciphertext blobs AND the folder list) and
// leave the view. Folders stay so a background sync while locked can never
// strand or erase them from the envelope.
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
  vault.folders = [];
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
document.getElementById('new-vault-note').addEventListener('click', onNewVaultNoteClick);
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
  // Shared (collaborative) note: edits go to the Yjs doc, not to a local note.
  if (collab.noteId && collab.title && collab.body) {
    applyTextDiff(collab.title, collab.title.toString(), String(titleInput.value || '').slice(0, 200));
    applyTextDiff(collab.body, collab.body.toString(), String(markdownInput.value || ''));
    if (collab.desc && collab.template === 'recipe') {
      const descEl = document.getElementById('recipe-desc');
      applyTextDiff(collab.desc, collab.desc.toString(), descEl && typeof descEl.value === 'string' ? descEl.value.slice(0, 2000) : '');
    }
    scheduleCollabMeta();
    return;
  }
  if (activeView === 'vault') { saveVaultNote(); return; }
  const note = currentNote();
  if (!note || note.deleted || note.archived) return;
  const rawTitle = (typeof titleInput.value === 'string' ? titleInput.value : '').trim().slice(0, 200) || 'Untitled note';
  note.title = parseTitleExtension(rawTitle, note);
  if (typeof note.title !== 'string' || !note.title.trim()) note.title = 'Untitled note';
  note.title = note.title.slice(0, 200);
  note.body = typeof markdownInput.value === 'string' ? markdownInput.value.slice(0, 500000) : '';
  if (note.template === 'recipe') {
    const descEl = document.getElementById('recipe-desc');
    note.description = descEl && typeof descEl.value === 'string' ? descEl.value.slice(0, 2000) : '';
  } else if ('description' in note) delete note.description;
  note.date = 'Now';
  note.updatedAt = Date.now();
  breadcrumbTitle.textContent = note.title;
  renderPreview(note);
  updateMeta(note);
  renderTabs();
  setSaveLabel('Saving...', 'green');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 450);
  resetIdleTimer();
}

// De-duplicate a note title (case-insensitive) by appending a counter.
// Binned notes don't squat names — only live ones count.
function uniqueTitle(base) {
  const clean = (typeof base === 'string' ? base : 'Untitled note').trim().slice(0, 180) || 'Untitled note';
  const taken = new Set(notes.filter((note) => !note.deleted).map((note) => String(note.title || '').toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  let counter = 2;
  while (taken.has(`${clean} ${counter}`.toLowerCase())) counter += 1;
  return `${clean} ${counter}`;
}

// ---- Templates, toasts, editor formatting commands ----

const NOTE_TEMPLATES = {
  standard: {
    label: 'Standard note',
    caption: 'Standard',
    icon: 'file-text',
    titleBase: 'New Standard Note',
    tags: [],
    body: (title) => `# ${title}\n\nStart writing here...`
  },
  recipe: {
    label: 'Recipe',
    caption: 'Recipe',
    icon: 'cooking',
    titleBase: 'New Recipe',
    tags: ['recipe'],
    body: () => '',
    recipe: { ingredients: ['Ingredient one', 'Ingredient two'], steps: ['Step one', 'Step two'] }
  },
  todo: {
    label: 'To-do list',
    caption: 'To-do',
    icon: 'check-square',
    titleBase: 'New To-Do Note',
    tags: ['todo'],
    body: (title) => `# ${title}\n\n## Today\n\n- [ ] Most important task\n- [ ] Second task\n\n## Later\n\n- [ ] Someday task`
  }
};
// Single source of truth for the New-note chooser, shared by All Notes and the
// Shared view so the two pickers are always identical.
function renderTemplateOptions() {
  const box = document.getElementById('template-options');
  if (!box) return;
  box.innerHTML = Object.keys(NOTE_TEMPLATES).map((key) => {
    const template = NOTE_TEMPLATES[key];
    const label = template.label || template.caption || key;
    return `<button class="template-option template-square" data-template="${escapeHtml(key)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
        <span class="template-icon">${icon(template.icon || 'file-text')}</span>
        <span class="template-caption">${escapeHtml(template.caption || key)}</span>
      </button>`;
  }).join('');
}

// One seed used by both All Notes and the Shared view, so editing a template's
// title/body is mirrored everywhere a new note is created from it.
function seedFromTemplate(templateKey, title) {
  const template = NOTE_TEMPLATES[templateKey] || NOTE_TEMPLATES.standard;
  return {
    template,
    title,
    body: typeof template.body === 'function' ? template.body(title) : '',
  };
}

// Create a note from a template (Standard/Recipe/To-Do) into the current view+collection and open it.
function createNoteFromTemplate(templateKey) {
  const template = NOTE_TEMPLATES[templateKey] || NOTE_TEMPLATES.standard;
  if (activeView === 'bin') {
    activeView = 'notes';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    updateListHeading();
  }
  const id = newNoteId();
  const title = uniqueTitle(template.titleBase);
  const tags = [...template.tags];
  // Filing follows the workspace: a picked folder files the note there; a bare
  // section view asks first (pendingSectionFolder), falling back to the
  // section's first folder only when the picker had nothing to offer.
  const picked = pendingSectionFolder;
  pendingSectionFolder = null;
  // A picked folder always wins when it still exists (covers both the
  // bare-section flow and the folder-required gate resume, where the active
  // view may be a different section or none at all). Stale picks (folder
  // deleted since) fall through to the normal resolution below.
  const pickedSection = picked && picked.ns === 'custom'
    ? customSections.find((entry) => entry.id === picked.section) : null;
  const pickedFolder = pickedSection && typeof picked.folder === 'string'
    && pickedSection.folders.includes(picked.folder) ? picked.folder : null;
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
  const customFolder = pickedFolder
    || (activeCustom && activeCustom.folder)
    || (customSection && customSection.folders.length ? customSection.folders[0] : null);
  const filedSections = (pickedFolder && pickedSection) ? { [pickedSection.id]: pickedFolder }
    : (activeCustom && customFolder) ? { [activeCustom.section]: customFolder } : inheritSections;
  // Folder-required rule: a note must land in a folder or subfolder. If no
  // filing resolved above, park the template choice and ask for a
  // destination first — creation resumes after the pick. A workspace with no
  // folders at all cannot file anything: say so instead of silently
  // creating an unfiled note.
  if (!customFolder && !Object.values(filedSections).some((value) => typeof value === 'string' && value)) {
    pendingTemplate = templateKey;
    if (!openFolderPicker()) {
      pendingTemplate = null;
      showToast('Create a folder first, then add your note there');
      return null;
    }
    return null;
  }
  const note = { id, title, date: 'Now', updatedAt: Date.now(), tags, favorite: false, archived: false, deleted: false, ext: normalizeExt(template.ext), sections: filedSections, body: seedFromTemplate(templateKey, title).body };
  if (templateKey === 'recipe' || templateKey === 'todo') note.template = templateKey;
  if (templateKey === 'recipe' && template.recipe) {
    note.ingredients = sanitizeIngredients(template.recipe.ingredients);
    note.steps = sanitizeSteps(template.recipe.steps);
  }
  if (templateKey === 'recipe') note.body = '';
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
  const dest = customFolder || sectionValues[0] || 'All Notes';
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
  renderTemplateOptions();
  overlay.hidden = false;
  const first = overlay.querySelector('.template-option');
  if (first) first.focus();
}

// Hide the template chooser popup.
function closeTemplatePicker() {
  vaultTemplatePending = false;
  pendingSharedTemplate = null;
  const overlay = document.getElementById('template-overlay');
  if (overlay) overlay.hidden = true;
}

// Folder picked in a bare section view, awaiting template choice.
let pendingSectionFolder = null; // { ns: 'custom', section: id, folder } | null
// Template picked while unfiled, awaiting a folder choice (folder-required rule).
let pendingTemplate = null; // template key | null

// + New note entry: a bare section view (no folder picked) asks for the
// destination folder first, so the note lands where the user wants. A section
// with no folders yet cannot file anything — say so instead of silently
// creating an invisible note.
function onNewNoteClick() {
  pendingSectionFolder = null;
  pendingTemplate = null;
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

// Order picker entries like the expanded workspace note list: a parent is
// followed immediately by all its children (recursively), matching the
// strip's tree grouping. Roots/orphans keep the section's list order.
function orderFoldersLikeWorkspace(folders) {
  const childrenOf = new Map();
  const roots = [];
  folders.forEach((name) => {
    const parent = folderParent(name);
    if (parent && folders.includes(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(name);
    } else roots.push(name);
  });
  const out = [];
  const emit = (name) => {
    if (out.includes(name)) return;
    out.push(name);
    (childrenOf.get(name) || []).forEach(emit);
  };
  roots.forEach(emit);
  folders.forEach(emit);
  return out;
}

// Fill + show the folder chooser. With (ns, sectionId) it lists one section
// (bare-section flow, resumes at the template picker). With no args it lists
// every folder in the workspace (folder-required gate, resumes a parked
// template choice). Returns false when there is nothing to choose.
function openFolderPicker(ns, sectionId) {
  const box = document.getElementById('folder-pick-options');
  const overlay = document.getElementById('folder-pick-overlay');
  if (!box || !overlay) return false;
  let entries = [];
  let heading;
  if (ns === 'custom') {
    const section = customSections.find((entry) => entry.id === sectionId);
    if (!section || !section.folders.length) return false;
    entries = orderFoldersLikeWorkspace(section.folders).map((folder) => ({ ns, section: sectionId, folder, context: section.name }));
    heading = `Where in ${entries[0].context} should this note land?`;
  } else {
    (customSections || []).forEach((section) => {
      orderFoldersLikeWorkspace(section.folders || []).forEach((folder) => {
        entries.push({ ns: 'custom', section: section.id, folder, context: section.name });
      });
    });
    if (!entries.length) return false;
    heading = 'Every note needs a folder — where should this one land?';
  }
  document.getElementById('folder-pick-desc').textContent = heading;
  box.innerHTML = entries.map((entry) => {
    const leaf = folderLeaf(entry.folder);
    const sub = leaf === entry.folder ? entry.context : entry.folder;
    // Indent icon + label text (not the button) one notch per depth level.
    // Icons mirror the workspace strip: colored folder, nested glyph for subs.
    const section = customSections.find((sec) => sec.id === entry.section);
    const depth = folderDepth(entry.folder);
    const glyphClass = `strip-folder-glyph ${section ? customFolderColor(section, entry.folder) : 'blue'}`;
    const glyph = `<span class="${glyphClass}">${icon(folderIconForDepth(depth))}</span>`;
    return `
    <button class="template-option" data-pick-ns="${entry.ns}" data-pick-section="${escapeHtml(entry.section || '')}" data-pick-folder="${escapeHtml(entry.folder)}">
      <span class="template-icon template-icon-bare" style="margin-left:${depth * 14}px">${glyph}</span>
      <span class="theme-option-text"><strong>${escapeHtml(leaf)}</strong><span>${escapeHtml(sub)}</span></span>
    </button>`;
  }).join('');
  box.querySelectorAll('[data-pick-folder]').forEach((btn) => btn.addEventListener('click', () => {
    pendingSectionFolder = { ns: btn.dataset.pickNs, section: btn.dataset.pickSection || null, folder: btn.dataset.pickFolder };
    closeFolderPicker();
    // Folder-required gate resumes here: a parked template choice goes
    // straight to creation; the bare-section flow picks a template next.
    if (pendingTemplate) {
      const templateKey = pendingTemplate;
      pendingTemplate = null;
      createNoteFromTemplate(templateKey);
    } else {
      openTemplatePicker();
    }
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

// In-app input prompt (replaces window.prompt everywhere: native prompts are
// unmasked plaintext, unstyled, and block automation/testing). One-shot
// promise: resolves the typed string, or null on cancel/Esc/overlay click.
// A second call while open resolves the first waiter with null.
let askInputPending = null;
function askInput({ eyebrow = 'Notely', title = 'Input needed', desc = '', label = 'Value', password = true, placeholder = '', okText = 'Confirm' } = {}) {
  if (askInputPending) {
    try { askInputPending(null); } catch (error) {}
    askInputPending = null;
  }
  return new Promise((resolve) => {
    const modal = document.getElementById('prompt-modal');
    const input = document.getElementById('prompt-input');
    const okBtn = document.getElementById('prompt-ok');
    const cancelBtn = document.getElementById('prompt-cancel');
    const cancelX = document.getElementById('prompt-cancel-x');
    if (!modal || !input || !okBtn) { resolve(null); return; }
    document.getElementById('prompt-eyebrow').textContent = eyebrow;
    document.getElementById('prompt-title').textContent = title;
    document.getElementById('prompt-desc').textContent = desc;
    document.getElementById('prompt-label').textContent = label;
    okBtn.textContent = okText;
    input.type = password ? 'password' : 'text';
    input.placeholder = placeholder;
    input.value = '';
    askInputPending = resolve;
    const settle = (value) => {
      okBtn.onclick = null;
      if (cancelBtn) cancelBtn.onclick = null;
      if (cancelX) cancelX.onclick = null;
      input.onkeydown = null;
      modal.onclick = null;
      modal.hidden = true;
      if (askInputPending === resolve) askInputPending = null;
      resolve(value);
    };
    okBtn.onclick = () => settle(input.value);
    if (cancelBtn) cancelBtn.onclick = () => settle(null);
    if (cancelX) cancelX.onclick = () => settle(null);
    input.onkeydown = (event) => {
      if (event.key === 'Enter') settle(input.value);
      else if (event.key === 'Escape') settle(null);
    };
    modal.onclick = (event) => { if (event.target === modal) settle(null); };
    modal.hidden = false;
    setTimeout(() => { try { input.focus(); } catch (error) {} }, 30);
  });
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
// Section icon picker: close button, backdrop click, and icon choice.
document.getElementById('close-section-icon').addEventListener('click', closeSectionIconPicker);
document.getElementById('section-icon-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'section-icon-overlay') closeSectionIconPicker();
});
document.getElementById('section-icon-grid').addEventListener('click', (event) => {
  const choice = event.target.closest('[data-icon-choice]');
  if (choice) chooseSectionIcon(choice.dataset.iconChoice);
});
// Note tag editor wiring.
document.getElementById('close-tag-editor').addEventListener('click', closeTagEditor);
document.getElementById('tag-editor-done').addEventListener('click', closeTagEditor);
document.getElementById('tag-editor-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'tag-editor-overlay') closeTagEditor();
});
document.getElementById('tag-editor-current').addEventListener('click', (event) => {
  const remove = event.target.closest('[data-tag-remove]');
  if (remove) tagEditorRemove(remove.dataset.tagRemove);
});
document.getElementById('tag-editor-suggest').addEventListener('click', (event) => {
  const add = event.target.closest('[data-tag-add]');
  if (add) tagEditorAdd(add.dataset.tagAdd);
});
document.getElementById('tag-editor-add-btn').addEventListener('click', () => {
  const input = document.getElementById('tag-editor-input');
  if (input) { tagEditorAdd(input.value); input.value = ''; input.focus(); }
});
document.getElementById('tag-editor-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    event.stopPropagation();
    tagEditorAdd(event.target.value);
    event.target.value = '';
  }
});
// Note view: the inline "+" next to a note's tags opens the tag editor for the
// exact note the button was rendered for (same modal as the note menu's
// "Tags…"). Binding by id means a stale/other view can never tag a wrong note.
tagList.addEventListener('click', (event) => {
  const btn = event.target.closest('.tag-add');
  if (!btn) return;
  if (btn.dataset.sharedTagAdd || collab.noteId) { openSharedTagEditor(); return; }
  const id = btn.dataset.noteId;
  if (id) openTagEditor(id);
});
// Shared view wiring: sections create notes; rows open the live editor.
noteList.addEventListener('click', (event) => {
  const iacc = event.target.closest('[data-invite-accept]');
  if (iacc) { event.preventDefault(); acceptInvite(iacc.dataset.inviteAccept); return; }
  const idec = event.target.closest('[data-invite-decline]');
  if (idec) { event.preventDefault(); declineInvite(idec.dataset.inviteDecline); return; }
  const stog = event.target.closest('[data-shared-toggle]');
  if (stog) {
    event.preventDefault(); event.stopPropagation();
    const k = sharedFolderKey(stog.dataset.sharedGroup, stog.dataset.sharedToggle);
    if (sharedCollapsed.has(k)) sharedCollapsed.delete(k); else sharedCollapsed.add(k);
    renderSharedView();
    updateFoldToggle();
    return;
  }
  const ndel = event.target.closest('[data-collab-note-delete]');
  if (ndel) { event.preventDefault(); event.stopPropagation(); collabDeleteNote(ndel.dataset.collabNoteDelete); return; }
  const nfol = event.target.closest('[data-note-folder]');
  if (nfol) { event.preventDefault(); event.stopPropagation(); moveSharedNote(nfol.dataset.noteFolder, nfol.dataset.noteGroup); return; }
  const gdel = event.target.closest('[data-group-delete]');
  if (gdel) { event.preventDefault(); event.stopPropagation(); confirmDeleteGroup(gdel.dataset.groupDelete); return; }
  const gadd = event.target.closest('[data-group-addfolder]');
  if (gadd) { event.preventDefault(); event.stopPropagation(); addSharedFolder(gadd.dataset.groupAddfolder); return; }
  const gleave = event.target.closest('[data-group-leave]');
  if (gleave) { event.preventDefault(); event.stopPropagation(); leaveSharedSection(gleave.dataset.groupLeave); return; }
  const gset = event.target.closest('[data-group-settings]');
  if (gset) { event.preventDefault(); event.stopPropagation(); openSectionSettings(gset.dataset.groupSettings); return; }
  const fnote = event.target.closest('[data-folder-note]');
  if (fnote) { event.preventDefault(); event.stopPropagation(); openSharedNewNote(fnote.dataset.folderGroup, fnote.dataset.folderNote); return; }
  const fsub = event.target.closest('[data-folder-sub]');
  if (fsub) { event.preventDefault(); event.stopPropagation(); addSubfolder(fsub.dataset.folderGroup, fsub.dataset.folderSub); return; }
  const open = event.target.closest('[data-collab-open]');
  if (open) { event.preventDefault(); openCollabNote(open.dataset.collabOpen); return; }
  const newBtn = event.target.closest('#shared-new');
  if (newBtn) { event.preventDefault(); collabCreate(); }
});
// Right-click a shared note or folder to act on it.
noteList.addEventListener('contextmenu', (event) => {
  if (activeView !== 'shared') return;
  const folderRow = event.target.closest('.shared-folder');
  if (folderRow) {
    const ref = folderRow.querySelector('[data-folder-note]');
    if (ref) {
      event.preventDefault(); event.stopPropagation();
      showSharedContextMenu('folder', { groupId: ref.dataset.folderGroup, folder: ref.dataset.folderNote }, event.clientX, event.clientY);
      return;
    }
  }
  const noteRow = event.target.closest('[data-collab-open]');
  if (noteRow) {
    event.preventDefault(); event.stopPropagation();
    showSharedContextMenu('note', { noteId: noteRow.dataset.collabOpen, groupId: noteRow.dataset.collabGroup }, event.clientX, event.clientY);
  }
});
{
  const menu = document.getElementById('shared-context-menu');
  if (menu) menu.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-shared-action]');
    if (!btn || !sharedMenuTarget) return;
    const action = btn.dataset.sharedAction;
    const t = sharedMenuTarget;
    closeSharedContextMenu();
    if (action === 'open') openCollabNote(t.noteId);
    else if (action === 'move') moveSharedNote(t.noteId, t.groupId);
    else if (action === 'delete') {
      pendingDeleteId = String(t.noteId); pendingDeleteMode = 'collab-note'; pendingDeleteTag = null;
      setDeleteDialog({ eyebrow: 'Delete note', title: 'Delete this shared note?', name: `Note #${t.noteId}`, message: '\u201d will be deleted for everyone. This cannot be undone.' });
      const overlay = document.getElementById('delete-overlay');
      if (overlay) { overlay.hidden = false; const b = document.getElementById('confirm-delete'); if (b) b.focus(); }
    }
    else if (action === 'folder-note') openSharedNewNote(t.groupId, t.folder);
    else if (action === 'folder-sub') addSubfolder(t.groupId, t.folder);
    else if (action === 'folder-rename') renameSharedFolder(t.groupId, t.folder);
    else if (action === 'folder-delete') confirmDeleteSharedFolder(t.groupId, t.folder);
  });
  document.addEventListener('click', (event) => { if (sharedMenuTarget && !event.target.closest('#shared-context-menu')) closeSharedContextMenu(); });
  document.addEventListener('contextmenu', (event) => { if (sharedMenuTarget && !event.target.closest('#shared-context-menu')) closeSharedContextMenu(); }, true);
  window.addEventListener('resize', closeSharedContextMenu);
  noteList.addEventListener('scroll', closeSharedContextMenu, true);
}
// Drag-and-drop in the Shared tree: move notes into folders, reparent folders.
function clearSharedDropTargets() {
  noteList.querySelectorAll('.drop-target, .drop-before').forEach((el) => el.classList.remove('drop-target', 'drop-before'));
}
noteList.addEventListener('dragstart', (event) => {
  if (activeView !== 'shared') return;
  const folderRow = event.target.closest('.shared-folder');
  const noteRow = event.target.closest('[data-collab-open]');
  let payload = null;
  if (folderRow && folderRow.dataset.sharedFolder != null) {
    payload = { kind: 'folder', folder: folderRow.dataset.sharedFolder, groupId: folderRow.dataset.sharedGroup };
  } else if (noteRow) {
    payload = { kind: 'note', id: noteRow.dataset.collabOpen, groupId: noteRow.dataset.collabGroup };
  }
  if (!payload) return;
  try { event.dataTransfer.setData('application/x-notely-shared', JSON.stringify(payload)); } catch (error) {}
  event.dataTransfer.effectAllowed = 'move';
});
noteList.addEventListener('dragover', (event) => {
  if (activeView !== 'shared') return;
  const folderRow = event.target.closest('.shared-folder');
  const noteRow = event.target.closest('[data-collab-open]');
  const groupBlock = event.target.closest('.shared-group');
  if (!folderRow && !noteRow && !groupBlock) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  clearSharedDropTargets();
  if (folderRow) folderRow.classList.add('drop-target');
  else if (noteRow) noteRow.classList.add('drop-before');
  else groupBlock.classList.add('drop-target');
});
noteList.addEventListener('dragleave', (event) => {
  if (!event.relatedTarget || !noteList.contains(event.relatedTarget)) clearSharedDropTargets();
});
noteList.addEventListener('drop', (event) => {
  if (activeView !== 'shared') return;
  let payload = null;
  try { payload = JSON.parse(event.dataTransfer.getData('application/x-notely-shared') || 'null'); } catch (error) { payload = null; }
  if (!payload || !payload.kind) return;
  event.preventDefault();
  const folderRow = event.target.closest('.shared-folder');
  const noteRow = event.target.closest('[data-collab-open]');
  let targetFolder = '';
  if (folderRow) targetFolder = folderRow.dataset.sharedFolder || '';
  else if (noteRow) targetFolder = (sharedNoteMeta.get(String(noteRow.dataset.collabOpen)) || {}).folder || '';
  clearSharedDropTargets();
  if (payload.kind === 'note') moveSharedNoteToFolder(payload.id, payload.groupId, targetFolder);
  else if (payload.kind === 'folder') reparentSharedFolder(payload.groupId, payload.folder, targetFolder);
});
noteList.addEventListener('dragend', () => clearSharedDropTargets());

function refreshCurrent() {
  // Refresh only the workspace sidebar (the notes list / Shared inbox).
  if (activeView === 'shared') { renderSharedView(); return; }
  if (activeView === 'vault') { renderVaultList(); return; }
  renderNoteList();
}
{
  const sharedNewBtn = document.getElementById('shared-new');
  if (sharedNewBtn) sharedNewBtn.addEventListener('click', collabCreate);
  const refreshBtn = document.getElementById('refresh-view');
  if (refreshBtn) refreshBtn.addEventListener('click', () => { try { refreshCurrent(); } catch (error) {} });
}
document.getElementById('close-collab-new').addEventListener('click', closeCollabNewDialog);
document.getElementById('collab-new-cancel').addEventListener('click', closeCollabNewDialog);
document.getElementById('collab-new-create').addEventListener('click', confirmCollabNew);
document.getElementById('collab-new-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'collab-new-overlay') closeCollabNewDialog();
});
document.getElementById('collab-pending').addEventListener('click', openCollabPending);
document.getElementById('close-collab-pending').addEventListener('click', closeCollabPending);
document.getElementById('collab-pending-done').addEventListener('click', closeCollabPending);
document.getElementById('collab-pending-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'collab-pending-overlay') closeCollabPending();
});
document.getElementById('collab-pending-list').addEventListener('click', (event) => {
  const cancel = event.target.closest('[data-cancel-invite]');
  if (cancel) { event.preventDefault(); cancelCollabInvite(cancel.dataset.cancelInvite); return; }
  const remove = event.target.closest('[data-remove-member]');
  if (remove) { event.preventDefault(); collabRemoveMember(remove.dataset.removeMember); }
});
document.getElementById('close-section-settings').addEventListener('click', closeSectionSettings);
document.getElementById('section-settings-done').addEventListener('click', closeSectionSettings);
document.getElementById('section-settings-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'section-settings-overlay') closeSectionSettings();
});
document.getElementById('section-tags-current').addEventListener('click', (event) => {
  const rm = event.target.closest('[data-section-tag-remove]');
  if (rm) sectionTagRemove(rm.dataset.sectionTagRemove);
});
document.getElementById('section-tags-add-btn').addEventListener('click', () => {
  const input = document.getElementById('section-tags-input');
  if (input) { sectionTagAdd(input.value); input.value = ''; input.focus(); }
});
document.getElementById('section-tags-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ',') {
    event.preventDefault();
    event.stopPropagation();
    sectionTagAdd(event.target.value);
    event.target.value = '';
  }
});
document.getElementById('collab-new-members').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') { event.preventDefault(); confirmCollabNew(); }
});
document.getElementById('collab-invite').addEventListener('click', collabInvite);
document.getElementById('collab-delete').addEventListener('click', () => {
  if (!collab.noteId) return;
  const id = collab.noteId;
  pendingDeleteId = String(id);
  pendingDeleteMode = 'collab-note';
  pendingDeleteTag = null;
  setDeleteDialog({ eyebrow: 'Delete note', title: 'Delete this shared note?', name: `Note #${id}`, message: '” will be deleted for everyone in this section. This cannot be undone.' });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
});
// Settings → Tags: rename / delete across all notes.
document.getElementById('settings-tag-list').addEventListener('click', (event) => {
  const rename = event.target.closest('[data-tag-rename]');
  if (rename) {
    const oldName = rename.dataset.tagRename;
    askInput({ eyebrow: 'Rename tag', title: oldName, desc: 'Renames this tag on every note.', label: 'Tag name', password: false, placeholder: oldName, okText: 'Rename' }).then((value) => {
      if (value == null) return;
      if (!renameTagEverywhere(oldName, value)) showToast('Tag not changed');
      renderSettingsTags();
    });
    return;
  }
  const del = event.target.closest('[data-tag-delete]');
  if (del) {
    const name = del.dataset.tagDelete;
    pendingDeleteId = '__TAG__';
    pendingDeleteMode = 'tag';
    pendingDeleteTag = name;
    setDeleteDialog({ eyebrow: 'Delete tag', title: 'Delete this tag?', name, message: '” will be removed from every note. This cannot be undone.' });
    const overlay = document.getElementById('delete-overlay');
    if (overlay) {
      overlay.hidden = false;
      const confirmBtn = document.getElementById('confirm-delete');
      if (confirmBtn) confirmBtn.focus();
    }
  }
});
document.getElementById('template-overlay').addEventListener('click', (event) => {
  const option = event.target.closest('#template-options .template-option[data-template]');
  if (!option) return;
  const shared = pendingSharedTemplate;
  pendingSharedTemplate = null;
  const forVault = vaultTemplatePending;
  vaultTemplatePending = false;
  closeTemplatePicker();
  if (shared) { createSharedNoteWithTemplate(shared.groupId, shared.folder, option.dataset.template); return; }
  if (forVault) { createVaultNoteFromTemplate(option.dataset.template); return; }
  createNoteFromTemplate(option.dataset.template);
});
document.getElementById('close-delete').addEventListener('click', closeDeleteConfirm);
document.getElementById('cancel-delete').addEventListener('click', closeDeleteConfirm);
document.getElementById('confirm-delete').addEventListener('click', confirmPendingDelete);
// Delete/Backspace removes the marked workspace note (same rules as the menu:
// Bin confirm for binned/important notes, direct soft-delete otherwise).
// Ignored while typing, while logged out, inside any popup, or in the Vault
// view (vault notes keep their own delete UI).
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Delete' && event.key !== 'Backspace') return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const target = event.target;
  if (target && (target.isContentEditable
    || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''))) return;
  if (!cachedProfile || !e2ee.masterKey) return;
  if (!document.getElementById('login-overlay').hidden) return;
  if (document.querySelector('.modal-overlay:not([hidden])')) return;
  if (document.querySelector('.context-menu:not([hidden])')) return;
  if (activeView === 'vault') return;
  if (!currentId) return;
  event.preventDefault();
  requestDeleteNoteById(currentId);
});
document.getElementById('delete-overlay').addEventListener('click', (event) => {
  if (event.target.id === 'delete-overlay') closeDeleteConfirm();
});
titleInput.addEventListener('input', saveCurrentNote);
markdownInput.addEventListener('input', saveCurrentNote);
markdownInput.addEventListener('input', () => collabPresenceLocal(true));
markdownInput.addEventListener('keyup', () => collabPresenceLocal(true));
markdownInput.addEventListener('click', () => collabPresenceLocal(false));
markdownInput.addEventListener('select', () => collabPresenceLocal(false));
document.getElementById('recipe-desc').addEventListener('input', saveCurrentNote);
document.getElementById('recipe-photo-btn').addEventListener('click', () => { if (collab.noteId) requestCollabCoverUpload(); else requestCoverUpload(); });
// Structured recipe body: toggle, edit, add and remove Ingredients / Method.
const recipeBodyEl = document.getElementById('recipe-body');
if (recipeBodyEl) {
  recipeBodyEl.addEventListener('click', (event) => {
    const toggle = event.target.closest('[data-recipe-toggle]');
    if (toggle) {
      const i = Number(toggle.dataset.recipeToggle);
      recipeMutate((data) => { if (data.ingredients[i]) data.ingredients[i].d = !data.ingredients[i].d; });
      renderRecipeBody(null);
      return;
    }
    const remIng = event.target.closest('[data-recipe-remove-ing]');
    if (remIng) {
      const i = Number(remIng.dataset.recipeRemoveIng);
      recipeMutate((data) => { data.ingredients.splice(i, 1); });
      renderRecipeBody(null);
      return;
    }
    const remStep = event.target.closest('[data-recipe-remove-step]');
    if (remStep) {
      const i = Number(remStep.dataset.recipeRemoveStep);
      recipeMutate((data) => { data.steps.splice(i, 1); });
      renderRecipeBody(null);
      return;
    }
    if (event.target.closest('#recipe-add-ingredient')) {
      recipeMutate((data) => { data.ingredients.push({ t: '', d: false }); });
      renderRecipeBody(null);
      focusRecipeField('[data-recipe-ing]', 'last');
      return;
    }
    if (event.target.closest('#recipe-add-step')) {
      recipeMutate((data) => { data.steps.push(''); });
      renderRecipeBody(null);
      focusRecipeField('[data-recipe-step]', 'last');
    }
  });
  recipeBodyEl.addEventListener('input', (event) => {
    const ing = event.target.closest('[data-recipe-ing]');
    if (ing) {
      ing.style.height = 'auto';
      ing.style.height = `${ing.scrollHeight}px`;
      const i = Number(ing.dataset.recipeIng);
      recipeMutate((data) => { if (data.ingredients[i]) data.ingredients[i].t = ing.value; });
      return;
    }
    const step = event.target.closest('[data-recipe-step]');
    if (step) {
      step.style.height = 'auto';
      step.style.height = `${step.scrollHeight}px`;
      const i = Number(step.dataset.recipeStep);
      recipeMutate((data) => { data.steps[i] = step.value; });
    }
  });
  recipeBodyEl.addEventListener('keydown', (event) => {
    const el = event.target.closest('[data-recipe-step], [data-recipe-ing]');
    if (!el || event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    if (el.dataset.recipeStep != null) {
      const i = Number(el.dataset.recipeStep);
      recipeMutate((data) => { data.steps.splice(i + 1, 0, ''); });
      renderRecipeBody(null);
      focusRecipeField('[data-recipe-step]', i + 1);
    } else {
      const i = Number(el.dataset.recipeIng);
      recipeMutate((data) => { data.ingredients.splice(i + 1, 0, { t: '', d: false }); });
      renderRecipeBody(null);
      focusRecipeField('[data-recipe-ing]', i + 1);
    }
  });
}

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

// Expand/shrink all folder contents (button at the right end of the filter
// row, beside "Starred"). State is inferred: any collapsible folder still
// open -> collapse everything; otherwise expand everything. The chevron
// points down when folders are expanded (click = collapse) and flips when
// everything is already collapsed.
const foldToggle = document.getElementById('toggle-folders');
function visibleFolderPaths() {
  const paths = new Set();
  notes.forEach((note) => {
    if (note.deleted || note.archived) return;
    if (note.sections && typeof note.sections === 'object') {
      Object.values(note.sections).forEach((folder) => {
        if (typeof folder === 'string' && folder.trim()) paths.add(folder);
      });
    }
  });
  customSections.forEach((section) => section.folders.forEach((folder) => paths.add(folder)));
  return [...paths];
}
function updateFoldToggle() {
  if (!foldToggle) return;
  const inShared = activeView === 'shared';
  const paths = inShared ? sharedAllFolderKeys() : visibleFolderPaths();
  const collapsed = inShared ? sharedCollapsed : collapsedFolders;
  const anyOpen = paths.some((folder) => !collapsed.has(folder));
  foldToggle.classList.toggle('is-expanded', anyOpen);
  const label = anyOpen ? 'Collapse all folders' : 'Expand all folders';
  foldToggle.setAttribute('aria-label', label);
  foldToggle.setAttribute('title', label);
}
if (foldToggle) {
  foldToggle.addEventListener('click', () => {
    if (activeView === 'shared') {
      const keys = sharedAllFolderKeys();
      const anyOpen = keys.some((key) => !sharedCollapsed.has(key));
      if (anyOpen) keys.forEach((key) => sharedCollapsed.add(key));
      else keys.forEach((key) => sharedCollapsed.delete(key));
      renderSharedView();
      updateFoldToggle();
      return;
    }
    const anyOpen = visibleFolderPaths().some((folder) => !collapsedFolders.has(folder));
    if (anyOpen) visibleFolderPaths().forEach((folder) => collapsedFolders.add(folder));
    else visibleFolderPaths().forEach((folder) => collapsedFolders.delete(folder));
    persistCollapsedFolders();
    renderNoteList();
  });
}

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
  if (!section || !folder) return;
  // Intermediate parents are not always stored in the folder list (a note can
  // be filed three levels deep without its ancestors listed). Accept any
  // ancestor of a known folder, registering it so it stays navigable.
  if (!section.folders.includes(folder)) {
    const isAncestor = section.folders.some((entry) => isFolderOrSub(entry, folder));
    if (!isAncestor) return;
    section.folders.push(folder);
    persistCustomSections();
    renderCustomSections();
  }
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
  if (typeof view !== 'string' || !/^(notes|favorites|archive|bin|vault|shared)$/.test(view)) return;
  if (view === 'vault' && !vault.unlocked) { openVaultModal(); return; }
  if (collab.noteId) closeCollabNote();
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav === item));
  clearSectionSelection();
  activeView = view;
  searchQuery = '';
  document.getElementById('search-input').value = '';
  // Pick the chip filter, then let updateListHeading() own the heading text so
  // the collapsed workspace-strip name (#workspace-view-icon) always stays in
  // sync (previously favorites/bin/archive set the heading directly, leaving
  // the strip showing the last view that called updateListHeading, e.g. Shared).
  activeFilter = view === 'favorites' ? 'favorites' : 'all';
  updateListHeading();
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

// Strip Markdown syntax from a body, keeping the raw text: headings lose #,
// emphasis loses markers, lists keep a dash, blockquotes lose >, code fences
// lose backticks, images become their alt text, links become label (url).
function stripMarkdown(text) {
  let out = String(text || '');
  out = out.replace(/```[\s\S]*?```/g, (m) => m.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/gm, ''));
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^(\s*)([-*+]|\d+\.)\s+/gm, '$1');
  out = out.replace(/^(\s*)-\s+\[[ xX]\]\s+/gm, '$1');
  out = out.replace(/(\*\*\*|\*\*|__|\*|_|~~)([^*_~]+)\1/g, '$2');
  out = out.replace(/^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*$/gm, '');
  out = out.replace(/\|/g, ' ');
  return out;
}

if (typeBadge) typeBadge.addEventListener('click', () => {
  if (collab.noteId) return; // shared notes are always Markdown
  const note = activeEditorNote();
  if (!note) return;
  if (note.deleted) { showToast('Restore this note to edit it'); return; }
  if (note.archived) { showToast('Unarchive this note to edit it'); return; }
  const order = ['md', 'txt', 'json', 'yaml'];
  const next = order[(order.indexOf(note.ext) + 1) % order.length];
  // Markdown never survives a switch to plain text: the syntax markers are
  // stripped from this note's body (raw text kept).
  if (next === 'txt' && note.ext === 'md' && typeof note.body === 'string' && note.body) {
    const stripped = stripMarkdown(note.body);
    if (stripped !== note.body) {
      note.body = stripped;
      markdownInput.value = note.body;
      showToast('Markdown formatting removed');
    }
  }
  note.ext = next;
  writeMode = 'edit';
  clearTimeout(idleTimer);
  renderPreview(note);
  resetIdleTimer();
  persistNotes();
  renderNoteList();
  const typeNames = { md: 'Markdown (.md)', txt: 'plain text (.txt)', json: 'JSON (.json)', yaml: 'YAML (.yaml)' };
  showToast(`Switched to ${typeNames[note.ext]}`);
});

if (beautifyBtn) beautifyBtn.addEventListener('click', applyBeautify);

const importNotesBtn = document.getElementById('import-notes');
if (importNotesBtn) importNotesBtn.addEventListener('click', () => importInput.click());
document.getElementById('cover-add').addEventListener('click', requestCoverUpload);
document.getElementById('cover-change').addEventListener('click', requestCoverUpload);
document.getElementById('cover-remove').addEventListener('click', removeCover);
document.getElementById('cover-repos').addEventListener('click', enterCoverRepos);
document.getElementById('cover-done').addEventListener('click', () => exitCoverRepos(true));
document.getElementById('cover-input').addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) { if (collab.noteId) handleCollabCoverFile(file); else handleCoverFile(file); }
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
        updatedAt: Date.now(),
        tags: [],
        favorite: false,
        archived: false,
        deleted: false,
        ext,
        sections: (activeCustom && activeCustom.folder) ? { [activeCustom.section]: activeCustom.folder } : {},
        body: (text || (ext === 'md' ? `# ${base}\n` : '')).slice(0, 500000)
      };
      ensureNoteFiled(note);
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

document.getElementById('focus-editor').addEventListener('click', () => {
  document.querySelector('.editor-panel').classList.toggle('focus-mode');
  showToast(document.querySelector('.editor-panel').classList.contains('focus-mode') ? 'Focus mode on' : 'Focus mode off');
});
document.getElementById('open-sidebar').addEventListener('click', () => document.getElementById('sidebar').classList.add('open'));
document.getElementById('close-sidebar').addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));

// ---- App shell wiring: search, filters, nav, import/export, sidebar collapse ----

// Panel resizing: drag the handle between the expanded notes panel and the
// editor to change the panel width. Bounds: 220px–560px (min keeps search +
// chips usable; max keeps the editor readable). The collapsed strip (55px)
// is never affected — the handle is hidden in strip/focus modes. Width is
// persisted per device and re-applied on boot.
const PANEL_MIN_WIDTH = 220;
const PANEL_MAX_WIDTH = 560;
const panelResizer = document.getElementById('panel-resizer');
const notesPanel = document.querySelector('.notes-panel');
function applyPanelWidth(px) {
  if (!notesPanel) return;
  const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(px)));
  notesPanel.style.flexBasis = `${width}px`;
  try { localStorage.setItem('notely-panel-width', String(width)); } catch (error) {}
}
function restorePanelWidth() {
  if (!notesPanel) return;
  try {
    const saved = parseInt(localStorage.getItem('notely-panel-width') || '', 10);
    if (Number.isFinite(saved)) notesPanel.style.flexBasis = `${Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, saved))}px`;
  } catch (error) {}
}
if (panelResizer && notesPanel) {
  let dragging = false;
  panelResizer.addEventListener('pointerdown', (event) => {
    if (document.querySelector('.app-shell.workspace-collapsed')) return;
    dragging = true;
    panelResizer.classList.add('is-dragging');
    document.body.classList.add('is-panel-resizing');
    panelResizer.setPointerCapture(event.pointerId);
  });
  panelResizer.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    applyPanelWidth(event.clientX - notesPanel.getBoundingClientRect().left);
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    panelResizer.classList.remove('is-dragging');
    document.body.classList.remove('is-panel-resizing');
  };
  panelResizer.addEventListener('pointerup', endDrag);
  panelResizer.addEventListener('pointercancel', endDrag);
  // Double-click resets to the default width (325px) and clears the override.
  panelResizer.addEventListener('dblclick', () => {
    notesPanel.style.flexBasis = '';
    try { localStorage.removeItem('notely-panel-width'); } catch (error) {}
  });
  restorePanelWidth();
}

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
  // Folder dots migrate between slide menu and workspace strip on toggle.
  try { renderStripItems(); } catch (error) {}
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

const workspaceToggle = document.getElementById('toggle-workspace');
// Collapse/expand the workspace (notes panel) and persist the choice,
// mirroring the sidebar collapse. Starts expanded.
function setWorkspaceCollapsed(collapsed) {
  const shell = document.querySelector('.app-shell');
  if (shell) shell.classList.toggle('workspace-collapsed', collapsed);
  try { localStorage.setItem('notely-workspace-collapsed', collapsed ? '1' : '0'); } catch (error) {}
  if (workspaceToggle) {
    const label = collapsed ? 'Expand workspace' : 'Collapse workspace';
    workspaceToggle.setAttribute('aria-label', label);
    workspaceToggle.setAttribute('title', label);
  }
  // The strip is only measurable while collapsed: repaint it and re-evaluate
  // the scroll arrows after the layout switches.
  try { renderStripItems(); } catch (error) {}
  try { requestAnimationFrame(updateStripScrollButton); } catch (error) {}
  try { setTimeout(updateStripScrollButton, 60); } catch (error) {}
}
if (workspaceToggle) {
  restoreWorkspaceCollapsed();
  workspaceToggle.addEventListener('click', () => {
    const shell = document.querySelector('.app-shell');
    setWorkspaceCollapsed(shell ? !shell.classList.contains('workspace-collapsed') : false);
  });
}
// Re-apply the persisted collapse choice (login, register, boot all land here
// after their first selection, so the workspace returns as the user left it).
function restoreWorkspaceCollapsed() {
  try {
    setWorkspaceCollapsed(localStorage.getItem('notely-workspace-collapsed') === '1');
  } catch (error) { setWorkspaceCollapsed(false); }
}

// ---- Auth & E2EE session, themes, settings, boot ----

const THEMES = ['light', 'dark', 'dracula', 'nord', 'tokyo', 'gruvbox'];
const THEME_META_COLORS = { light: '#f4f0e9', dark: '#1f1d1b', dracula: '#282a36', nord: '#2e3440', tokyo: '#1a1b26', gruvbox: '#282828' };
const THEME_LABELS = { light: 'Light', dark: 'Dark', dracula: 'Dracula', nord: 'Nord', tokyo: 'Tokyo Night', gruvbox: 'Gruvbox' };
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

// --- Per-browser-session unlock -------------------------------------------
// The master key never touches persistent storage. To survive a page refresh
// without re-typing the password we keep it in sessionStorage, which the
// browser wipes when the tab/window closes. Clearing it (logout) or closing
// the browser locks the vault again.
function sessionUnlockKey() { return accountScopeKey('notely-session-unlock'); }
function clearSessionUnlock() {
  try { sessionStorage.removeItem(sessionUnlockKey()); } catch (error) {}
}
async function saveSessionUnlock() {
  if (!e2ee.masterKey || !cachedProfile) return;
  try {
    const raw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
    sessionStorage.setItem(sessionUnlockKey(), JSON.stringify({
      u: cachedProfile.username,
      k: e2eeBytesToB64(new Uint8Array(raw)),
      kdf: e2ee.kdf || 'pbkdf2',
      saltAuth: e2ee.saltAuth ? e2eeBytesToB64(e2ee.saltAuth) : '',
      saltEnc: e2ee.saltEnc ? e2eeBytesToB64(e2ee.saltEnc) : '',
      iterations: e2ee.iterations || 0,
    }));
  } catch (error) {}
}
async function restoreSessionUnlock() {
  if (!cachedProfile) return false;
  let blob;
  try { blob = JSON.parse(sessionStorage.getItem(sessionUnlockKey()) || 'null'); } catch (error) { blob = null; }
  if (!blob || blob.u !== cachedProfile.username || !blob.k) return false;
  try {
    const raw = e2eeB64ToBytes(blob.k);
    const masterKey = await window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    e2ee.masterKey = masterKey;
    e2ee.kdf = blob.kdf || 'pbkdf2';
    e2ee.saltAuth = blob.saltAuth ? e2eeB64ToBytes(blob.saltAuth) : null;
    e2ee.saltEnc = blob.saltEnc ? e2eeB64ToBytes(blob.saltEnc) : null;
    e2ee.iterations = blob.iterations || 0;
    return true;
  } catch (error) { clearSessionUnlock(); return false; }
}
// Load the decrypted workspace after an unlock (login or session restore).
async function enterWorkspace() {
  // Fresh account context: never leak the previous login's sidebar into this one.
  serverUiLoaded = false;
  collapsedFolders = new Set();
  customSections = [];
  deletedCustomSections = [];
  activeCustom = null;
  knownTags = [];
  await loadNotesFromServer();
  if (purgeExpiredBin()) persistNotes();
  await loadUiVault();
  // No default section/folder seeding: new accounts start with an empty
  // sidebar. ensureMigratedCollectionsSection only runs for genuine legacy data.
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
  restoreWorkspaceCollapsed();
  try { sharingEnsureKeys(); } catch (error) {}
  try { refreshSharedNavCount(); } catch (error) {}
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

// --- Profile avatar --------------------------------------------------------
// Optional user picture. Stored inside the E2EE UI vault (never plaintext on
// disk/server), rendered as an image in place of the initials.
let profileAvatar = '';
const AVATAR_MAX_CHARS = 400000;
function cleanAvatarSrc(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length > AVATAR_MAX_CHARS) return null;
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : null;
}
// Paint a round avatar element with the picture when set, else its initials.
function paintAvatar(el, fallbackInitials) {
  if (!el) return;
  el.textContent = '';
  const src = cleanAvatarSrc(profileAvatar);
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = src;
    el.appendChild(img);
  } else {
    el.textContent = fallbackInitials;
  }
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
  paintAvatar(document.querySelector('.profile-card .avatar'), initialsFor(profile.name));
  if (nameEl) nameEl.textContent = profile.name;
  if (subEl) subEl.textContent = profile.subtitle;
  refreshProfilePopup();
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
  clearSessionUnlock();
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
  profileAvatar = '';
  knownTags = [];
  setSharedNavCount(0);
  e2eeLock();
  // Wipe decrypted workspace: memory, editor DOM and any legacy local copy.
  notes = [];
  openTabs = [];
  notesLoaded = false;
  serverNotesVersion = 0;
  serverUiLoaded = false;
  currentId = null;
  currentVaultId = null;
  vault.unlocked = false;
  vault.dek = null;
  vault.notes = [];
  vault.blobs = [];
  vault.folders = [];
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
  // NIST SP 800-63B: length-based, no composition rules; long passwords allowed.
  const failures = [];
  if (typeof password !== 'string' || password.length < 15) failures.push('at least 15 characters');
  if (typeof password === 'string' && password.length > 256) failures.push('at most 256 characters');
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

// Password reveal: any .password-eye button toggles its target input between
// masked and visible. Delegated so it works for every field that opts in.
document.addEventListener('click', (event) => {
  const eye = event.target.closest && event.target.closest('.password-eye');
  if (!eye) return;
  event.preventDefault();
  const input = document.getElementById(eye.dataset.eye || '');
  if (!input) return;
  const reveal = input.type === 'password';
  input.type = reveal ? 'text' : 'password';
  eye.setAttribute('aria-pressed', reveal ? 'true' : 'false');
  eye.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
  eye.innerHTML = icon(reveal ? 'eye-off' : 'eye');
  try { input.focus({ preventScroll: true }); } catch (error) { input.focus(); }
});

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
        const codeInput = await askInput({
          eyebrow: 'Two-factor authentication', title: 'Enter your code',
          desc: '6-digit code from your authenticator app.',
          label: 'Code', password: false, placeholder: '123456', okText: 'Verify',
        });
        if (!codeInput) { e2eeLock(); done(); loginFail('MFA code required.'); return; }
        const challenge = await apiFetch('/api/mfa/challenge', {
          method: 'POST', body: JSON.stringify({ ticket, code: String(codeInput).trim() }),
        });
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
          const oldPw = await askInput({
            eyebrow: 'Recover account', title: 'One last step',
            desc: 'Enter your OLD password once to re-encrypt notes under the new one. It stays on this device.',
            label: 'Old password', password: true, placeholder: '•••••', okText: 'Re-encrypt',
          });
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
    await enterWorkspace();
    await saveSessionUnlock();
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
  // Username first: the server can only look up passkeys for a named
  // account, so an empty field gets guidance — never a ceremony attempt.
  if (!username) { loginFail('Enter your username first.'); return; }
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { loginFail(); return; }
  if (authBusy) return;
  authBusy = true;
  try {
    if (!window.PublicKeyCredential) throw new Error('passkeys unsupported');
    const begin = await apiFetch('/api/passkey/login-begin', {
      method: 'POST', body: JSON.stringify({ username }),
    });
    const opts = await begin.json();
    // Deliberately vague: unknown names and accounts without any passkey
    // all read as a plain login failure (no enrolment oracle).
    if (!begin.ok) {
      authBusy = false;
      if (begin.status === 429) {
        loginFail(opts.error || 'Too many attempts — try again in a few minutes.');
      } else {
        loginFail('Login Failed');
      }
      return;
    }
    const cred = await navigator.credentials.get({
      publicKey: {
        challenge: b64urlToBuf(opts.challenge),
        rpId: opts.rpId,
        allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
        timeout: opts.timeout,
        userVerification: opts.userVerification,
        // Ask for the PRF evaluation when the server offers a salt. No salt
        // (or no PRF support) simply yields no secret — password fallback.
        ...(opts.prfSalt ? { extensions: { prf: { eval: { first: b64urlToBuf(opts.prfSalt) } } } } : {}),
      },
    });
    const prfSecret = prfFirstResult(cred);
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
        prfWrap: data.prfWrap || null,
      };
      const codeInput = await askInput({
        eyebrow: 'Two-factor authentication', title: 'Enter your code',
        desc: '6-digit code from your authenticator app.',
        label: 'Code', password: false, placeholder: '123456', okText: 'Verify',
      });
      if (!codeInput) throw new Error('mfa required');
      const ch = await apiFetch('/api/mfa/challenge', {
        method: 'POST',
        body: JSON.stringify({ ticket: data.mfaTicket, code: String(codeInput).trim() }),
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
    // Unlock: prefer the PRF secret (no password involved). The PRF wrap is
    // bound to THIS credential — only its authenticator yields the secret.
    // Anything missing (old enrolment, no PRF support) falls back to the
    // password prompt, which never leaves the device.
    let unlocked = false;
    if (prfSecret && data.prfWrap) {
      try {
        e2ee.masterKey = await prfUnwrapMasterKey(prfSecret, data.prfWrap);
        e2ee.kdf = data.kdf || 'argon2id';
        unlocked = true;
      } catch (error) { /* fall through to password */ }
    }
    if (!unlocked) {
      let password = String(passwordEl.value || '');
      if (!password) {
        const asked = await askInput({
          eyebrow: 'Unlock notes', title: 'Your password',
          desc: 'Needed once on this device to decrypt notes. It stays local.',
          label: 'Password', password: true, placeholder: '•••••', okText: 'Unlock',
        });
        if (!asked) throw new Error('password required');
        password = asked;
      }
    const kdfR = await apiFetch(`/api/kdf-params?username=${encodeURIComponent(username)}`);
    const kdf = await kdfR.json();
    const unlockBundle = {
      kdf: data.kdf || kdf.kdf || 'pbkdf2',
      saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
      iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
      encMasterKey: data.encMasterKey,
    };
    try {
      await e2eeUnlockWithPassword(username, password, unlockBundle);
    } catch (error) {
      // Same email-reset rewrap as password login: the verifier is new but
      // the wrapped key still answers to the OLD password. Unlock once with
      // it, then re-wrap under the new password (see password-login path).
      if (!pendingRewrap || !pendingRewrap.password) throw error;
      const oldPw = await askInput({
        eyebrow: 'Recover account', title: 'One last step',
        desc: 'Enter your OLD password once to re-encrypt notes under the new one. It stays on this device.',
        label: 'Old password', password: true, placeholder: '•••••', okText: 'Re-encrypt',
      });
      if (!oldPw) throw error;
      await e2eeUnlockWithPassword(username, oldPw, unlockBundle);
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
    } // end password fallback (skipped entirely after PRF unlock)
    // Auto-enable passwordless: this login's assertion already produced the
    // passkey's PRF secret, and we now hold the master key (PRF or password).
    // If no wrap is stored yet, store one so future logins need no password.
    if (prfSecret && !data.prfWrap && e2ee.masterKey) {
      try {
        const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
        const prfWrap = await prfWrapMasterKey(prfSecret, masterRaw);
        await apiFetch('/api/passkey/prf-wrap', { method: 'POST', body: JSON.stringify({ id: cred.id, prfWrap }) });
      } catch (error) {}
    }
    cachedProfile = { username: data.username, firstName: data.firstName, lastName: data.lastName, subtitle: data.subtitle, email: data.email || '' };
    passwordEl.value = '';
    hideLogin();
    applyProfile();
    await enterWorkspace();
    await saveSessionUnlock();
    showToast(`Welcome back, ${fullNameOf(cachedProfile)}`);
  } catch (error) {
    e2eeLock();
    const name = error && error.name;
    const msg = error && error.message;
    if (msg === 'mfa required') loginFail('MFA code required.');
    else if (msg === 'e2ee-unwrap') loginFail('Could not unlock notes with this password.');
    else if (msg === 'password required') loginFail('Enter your password to unlock notes.');
    else if (name === 'NotAllowedError' || name === 'AbortError') loginFail('Passkey sign-in was cancelled or timed out.');
    else if (name === 'SecurityError' || (msg && /rp\.?id|origin|relying party/i.test(msg))) loginFail('This passkey can’t be used on this address — open Notely at the exact address you registered it (e.g. https://localhost:5001).');
    else if (name === 'TypeError' || (msg && /failed to fetch|network|load failed/i.test(msg))) loginFail('Cannot reach the Notely server. Is it running?');
    else loginFail(msg || 'Passkey sign-in failed.');
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
// --- MFA settings (Two-Factor pane) ---
// Lost the authenticator? Recover the account (email/recovery code) — that
// clears MFA, so no separate MFA bypass codes exist by design.
async function refreshMfaStatus() {
  const statusEl = document.getElementById('mfa-status');
  const setupBtn = document.getElementById('mfa-setup-btn');
  const disableBtn = document.getElementById('mfa-disable-btn');
  try {
    const r = await apiFetch('/api/mfa/status');
    if (!r.ok) throw new Error();
    const s = await r.json();
    if (statusEl) statusEl.textContent = s.enabled
      ? 'MFA is ON. Logins need your password plus a 6-digit code.'
      : 'MFA is OFF. Logins need only your password.';
    if (setupBtn) setupBtn.hidden = Boolean(s.enabled);
    if (disableBtn) disableBtn.hidden = !s.enabled;
  } catch (error) {
    if (statusEl) statusEl.textContent = 'Could not load MFA status.';
  }
}
const mfaSetupBtn = document.getElementById('mfa-setup-btn');
function openMfaQrModal() {
  const modal = document.getElementById('mfa-qr-modal');
  if (modal) modal.hidden = false;
}
function closeMfaQrModal() {
  const modal = document.getElementById('mfa-qr-modal');
  if (modal) modal.hidden = true;
}
const closeMfaQrBtn = document.getElementById('close-mfa-qr-modal');
if (closeMfaQrBtn) closeMfaQrBtn.addEventListener('click', closeMfaQrModal);
const mfaQrOverlay = document.getElementById('mfa-qr-modal');
if (mfaQrOverlay) mfaQrOverlay.addEventListener('click', (event) => {
  if (event.target === mfaQrOverlay) closeMfaQrModal();
});
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
    if (err) err.hidden = true;
    document.getElementById('mfa-confirm-code').value = '';
    openMfaQrModal();
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
    document.getElementById('mfa-confirm-code').value = '';
    closeMfaQrModal();
    showToast('MFA enabled');
    await refreshMfaStatus();
  } catch (error) {
    if (err) { err.textContent = error.message; err.hidden = false; }
  }
});
const mfaDisableBtn = document.getElementById('mfa-disable-btn');
if (mfaDisableBtn) mfaDisableBtn.addEventListener('click', async () => {
  const code = await askInput({
    eyebrow: 'Two-factor authentication', title: 'Disable MFA',
    desc: 'Confirm with a 6-digit authenticator code. Lost your device? Recover the account instead.',
    label: 'Code', password: false, placeholder: '123456', okText: 'Disable',
  });
  if (!code) return;
  const r = await apiFetch('/api/mfa/disable', { method: 'POST', body: JSON.stringify({ code: String(code).trim() }) });
  showToast(r.ok ? 'MFA disabled' : 'Incorrect code.');
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
// PRF passwordless unlock: KEK = SHA-256(authenticator PRF output), used to
// wrap/unwrap the account master key. MUST match on register (wrap) and login
// (unwrap) — both sides call this one function.
async function prfUnwrapMasterKey(prfSecretBytes, wrapped) {
  const kekRaw = new Uint8Array(await window.crypto.subtle.digest('SHA-256', prfSecretBytes));
  const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const raw = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapped.iv) }, kek, e2eeB64ToBytes(wrapped.data));
  return window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function prfWrapMasterKey(prfSecretBytes, masterKeyRaw) {
  const kekRaw = new Uint8Array(await window.crypto.subtle.digest('SHA-256', prfSecretBytes));
  const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, masterKeyRaw);
  return { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) };
}
function prfFirstResult(cred) {
  try {
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : null;
    const first = ext && ext.prf && ext.prf.results && ext.prf.results.first;
    return first ? new Uint8Array(first) : null;
  } catch (error) {
    return null;
  }
}
// Many authenticators evaluate the PRF only during an assertion (get), not
// during creation. Run a throwaway get() against the just-created credential to
// obtain its PRF output, so passwordless unlock works on far more devices. The
// challenge is local — nothing is sent to the server; only the PRF output is
// used, to wrap the master key under SHA-256(PRF).
async function prfSecretViaAssertion(credentialId, rpId, prfSaltB64) {
  if (!window.PublicKeyCredential || !navigator.credentials || !navigator.credentials.get) return null;
  try {
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge: e2eeRandomBytes(32),
        ...(rpId ? { rpId } : {}),
        allowCredentials: [{ type: 'public-key', id: credentialId }],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: b64urlToBuf(prfSaltB64) } } },
      },
    });
    return prfFirstResult(assertion);
  } catch (error) {
    return null;
  }
}
// Attach a PRF wrap to an existing passkey (no remove/re-add needed), so it can
// unlock notes without the password. Requires an unlocked session (master key
// is in memory) and a PRF-capable authenticator.
async function enablePasswordlessPasskey(credIdB64, prfSaltB64, btn) {
  const errEl = document.getElementById('passkey-error');
  try {
    if (!e2ee.masterKey) throw new Error('Unlock your notes first (log in with your password), then retry.');
    if (!prfSaltB64) throw new Error('Passwordless is not available for this account.');
    if (btn) btn.disabled = true;
    // Best-effort browser check (Chromium exposes this). Helps tell "browser
    // can't do it" apart from "this authenticator didn't return a PRF".
    let caps = null;
    try {
      if (window.PublicKeyCredential && PublicKeyCredential.getClientCapabilities) {
        caps = await PublicKeyCredential.getClientCapabilities();
      }
    } catch (error) { caps = null; }
    if (caps && caps['extension:prf'] === false) {
      throw new Error('This browser doesn’t support the passkey PRF extension needed for passwordless — use Chrome or Edge.');
    }
    const prfSecret = await prfSecretViaAssertion(b64urlToBuf(credIdB64), undefined, prfSaltB64);
    if (!prfSecret) {
      throw new Error('This authenticator returned no PRF, so passwordless can’t be enabled. Chrome/Edge usually support it; Firefox currently does not.');
    }
    const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
    const prfWrap = await prfWrapMasterKey(prfSecret, masterRaw);
    const r = await apiFetch('/api/passkey/prf-wrap', { method: 'POST', body: JSON.stringify({ id: credIdB64, prfWrap }) });
    if (r.status === 401) throw new Error('Session expired — log in again, then retry.');
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Could not enable passwordless.');
    }
    if (errEl) errEl.hidden = true;
    showToast('Passwordless unlock enabled for this passkey');
    await refreshPasskeys();
  } catch (error) {
    if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
      if (errEl) errEl.hidden = true;
    } else if (errEl) {
      errEl.textContent = error.message || 'Could not enable passwordless.';
      errEl.hidden = false;
    }
    if (btn) btn.disabled = false;
  }
}
async function refreshPasskeys() {
  const listEl = document.getElementById('passkey-list');
  const errEl = document.getElementById('passkey-error');
  try {
    const r = await apiFetch('/api/passkey/list');
    if (!r.ok) throw new Error();
    const data = await r.json();
    const keys = (data && data.keys) || [];
    const prfSalt = (data && data.prfSalt) || null;
    if (listEl) {
      listEl.innerHTML = '';
      if (!keys.length) listEl.textContent = 'No passkeys yet.';
      keys.forEach((k) => {
        const row = document.createElement('div');
        // passwordless flag tells whether THIS key unlocks notes alone or
        // still needs the password afterwards.
        row.textContent = `${String(k.id).slice(0, 16)}… (added ${new Date((k.created_at || 0) * 1000).toLocaleDateString()} · ${k.passwordless ? 'no password needed' : 'password still needed'}) `;
        if (!k.passwordless) {
          const enable = document.createElement('button');
          enable.textContent = 'Enable passwordless';
          enable.className = 'btn btn-secondary';
          enable.addEventListener('click', () => enablePasswordlessPasskey(k.id, prfSalt, enable));
          row.appendChild(enable);
          row.appendChild(document.createTextNode(' '));
        }
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
        // Ask for a PRF evaluation so this device can later unlock notes with
        // NO password. Unsupported authenticators simply omit the result.
        ...(opts.prfSalt ? { extensions: { prf: { eval: { first: b64urlToBuf(opts.prfSalt) } } } } : {}),
      },
    });
    // Wrap the live master key under the PRF secret (when offered). The wrap
    // lets THIS credential unlock notes later; the secret itself is never
    // stored or sent anywhere.
    let prfWrap = null;
    try {
      if (e2ee.masterKey && opts.prfSalt) {
        // Prefer the PRF from the create ceremony; fall back to a follow-up
        // assertion for authenticators that only evaluate PRF on get().
        let prfSecret = prfFirstResult(cred);
        if (!prfSecret) {
          prfSecret = await prfSecretViaAssertion(cred.rawId, opts.rp && opts.rp.id, opts.prfSalt);
        }
        if (prfSecret) {
          const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
          prfWrap = await prfWrapMasterKey(prfSecret, masterRaw);
        }
      }
    } catch (error) { prfWrap = null; }
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
        ...(prfWrap ? { prfWrap } : {}),
      }),
    });
    if (!finish.ok) {
      const d = await finish.json().catch(() => ({}));
      throw new Error(d.error || 'Enrolment failed.');
    }
    const fd = await finish.json().catch(() => ({}));
    showToast(fd.prf ? 'Passkey added — passwordless unlock on' : 'Passkey added — it turns passwordless after your next passkey sign-in');
    await refreshPasskeys();
  } catch (error) {
    // Cancelled browser ceremony (NotAllowedError/AbortError) is deliberate,
    // not a failure: stay silent instead of flashing an error.
    if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
      if (errEl) errEl.hidden = true;
      return;
    }
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
    const f = document.getElementById('account-first');
    if (f && document.activeElement !== f) f.value = (cachedProfile && cachedProfile.firstName) || '';
    const l = document.getElementById('account-last');
    if (l && document.activeElement !== l) l.value = (cachedProfile && cachedProfile.lastName) || '';
    const e = document.getElementById('account-email');
    if (e && document.activeElement !== e) e.value = (cachedProfile && cachedProfile.email) || '';
  } catch (error) {}
}
const accountSaveBtn = document.getElementById('account-save-btn');
if (accountSaveBtn) accountSaveBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('account-error');
  const email = String(document.getElementById('account-email').value || '').trim().slice(0, 254);
  try {
    // Changing the recovery email is credential-adjacent (it is the reset
    // channel), so prove password knowledge before the session can repoint it.
    const current = await askInput({
      eyebrow: 'Save email', title: 'Confirm password',
      desc: 'Enter your current password to change your recovery email. It stays on this device; only a proof is sent.',
      label: 'Current password', password: true, placeholder: '•••••', okText: 'Save email',
    });
    if (!current) return;
    if (!e2ee.saltAuth) throw new Error('Please log in again, then retry.');
    const saltBytes = (e2ee.saltAuth instanceof Uint8Array) ? e2ee.saltAuth : e2eeB64ToBytes(e2ee.saltAuth);
    const raw = e2ee.kdf === 'argon2id'
      ? await argon2id32(current, saltBytes)
      : await e2eeDeriveBits(current, saltBytes, e2ee.iterations);
    const r = await apiFetch('/api/account/email', { method: 'POST', body: JSON.stringify({ email, currentAuth: e2eeBytesToB64(raw) }) });
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
    const typed = await askInput({
      eyebrow: 'Delete account', title: 'Are you sure?',
      desc: `Type your username (${uname}) to confirm permanent deletion of your account, notes, vault and keys.`,
      label: 'Username', password: false, placeholder: uname, okText: 'Continue',
    });
    if (typed !== uname) { showToast('Deletion cancelled.'); return; }
    const current = await askInput({
      eyebrow: 'Delete account', title: 'Confirm password',
      desc: 'Enter your current password. It stays on this device; only a proof is sent.',
      label: 'Current password', password: true, placeholder: '•••••', okText: 'Delete my account',
    });
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
    try { clearRecoveryCodesLocal(); } catch (error) {}
    await logout();
    showToast('Account deleted');
  } catch (error) {
    if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
  }
});
// --- Name editing (stored inside the server-encrypted profile) ---
async function saveAccountName() {
  const errEl = document.getElementById('account-error');
  const first = String(document.getElementById('account-first').value || '').trim().slice(0, 60);
  const last = String(document.getElementById('account-last').value || '').trim().slice(0, 60);
  try {
    const r = await apiFetch('/api/account/profile', { method: 'POST', body: JSON.stringify({ firstName: first, lastName: last }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Could not save name.');
    if (cachedProfile) { cachedProfile.firstName = data.firstName || first; cachedProfile.lastName = data.lastName || last; }
    if (errEl) errEl.hidden = true;
    applyProfile();
    showToast('Name saved');
  } catch (error) {
    if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
  }
}
const accountSaveNameBtn = document.getElementById('account-save-name-btn');
if (accountSaveNameBtn) accountSaveNameBtn.addEventListener('click', saveAccountName);

// --- Profile popup + avatar picture ---------------------------------------
const profileOverlay = document.getElementById('profile-overlay');
function openProfilePopup() {
  if (!profileOverlay) return;
  refreshProfilePopup();
  profileOverlay.hidden = false;
  document.getElementById('sidebar').classList.remove('open');
  const btn = document.getElementById('profile-edit-btn');
  if (btn) { try { btn.focus(); } catch (error) {} }
}
function closeProfilePopup() {
  if (profileOverlay) profileOverlay.hidden = true;
}
function refreshProfilePopup() {
  const name = cachedProfile ? fullNameOf(cachedProfile) : '';
  const nameEl = document.getElementById('profile-modal-name');
  if (nameEl) nameEl.textContent = name || 'Not signed in';
  const userEl = document.getElementById('profile-view-username');
  if (userEl) userEl.textContent = cachedProfile ? `@${cachedProfile.username}` : '';
  const emailEl = document.getElementById('profile-view-email');
  if (emailEl) emailEl.textContent = cachedProfile && cachedProfile.email ? cachedProfile.email : 'No recovery email set';
  paintAvatar(document.getElementById('profile-avatar-large'), initialsFor(name));
  const removeBtn = document.getElementById('profile-photo-remove');
  if (removeBtn) removeBtn.hidden = !cleanAvatarSrc(profileAvatar);
}
// Center-crop to a square 256px JPEG for a compact avatar.
function downscaleAvatar(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('decode'));
    img.onload = () => {
      try {
        const size = 256;
        const w = img.naturalWidth || size;
        const h = img.naturalHeight || size;
        const side = Math.min(w, h);
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas')); return; }
        ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('encode')); return; }
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('read'));
          reader.onload = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(blob);
        }, 'image/jpeg', 0.85);
      } catch (error) { reject(error); }
    };
    img.src = dataUrl;
  });
}
async function handleAvatarFile(file) {
  if (!file) return;
  if (!e2ee.masterKey) { showToast('Log in and unlock your notes to change your photo'); return; }
  if (!isImageFile(file)) { showToast('Use a PNG, JPEG, WebP, GIF, AVIF or BMP image'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('Image too large (5 MB max)'); return; }
  showToast('Loading picture…');
  try {
    const raw = await readFileAsDataUrl(file);
    const scaled = await downscaleAvatar(raw).catch(() => raw);
    const clean = cleanAvatarSrc(scaled) || cleanAvatarSrc(raw);
    if (!clean) { showToast('Could not use that image — try a smaller one'); return; }
    profileAvatar = clean;
    paintAvatar(document.querySelector('.profile-card .avatar'), initialsFor(cachedProfile ? fullNameOf(cachedProfile) : ''));
    refreshProfilePopup();
    persistUiVault();
    showToast('Profile photo updated');
  } catch (error) { showToast('Could not read that image'); }
}
const profileCardEl = document.querySelector('.profile-card');
if (profileCardEl) profileCardEl.addEventListener('click', (event) => {
  if (event.target.closest('#logout-button')) return;
  openProfilePopup();
});
const closeProfileBtn = document.getElementById('close-profile');
if (closeProfileBtn) closeProfileBtn.addEventListener('click', closeProfilePopup);
if (profileOverlay) profileOverlay.addEventListener('click', (event) => { if (event.target === profileOverlay) closeProfilePopup(); });
document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && profileOverlay && !profileOverlay.hidden) closeProfilePopup(); });
const profileEditBtn = document.getElementById('profile-edit-btn');
if (profileEditBtn) profileEditBtn.addEventListener('click', () => {
  closeProfilePopup();
  openSettings();
  setSettingsTab('profile');
  refreshAccountPane();
});
const profilePhotoBtn = document.getElementById('profile-photo-btn');
if (profilePhotoBtn) profilePhotoBtn.addEventListener('click', () => {
  const input = document.getElementById('avatar-input');
  if (input) { input.value = ''; input.click(); }
});
const profilePhotoRemove = document.getElementById('profile-photo-remove');
if (profilePhotoRemove) profilePhotoRemove.addEventListener('click', () => {
  profileAvatar = '';
  paintAvatar(document.querySelector('.profile-card .avatar'), initialsFor(cachedProfile ? fullNameOf(cachedProfile) : ''));
  refreshProfilePopup();
  persistUiVault();
  showToast('Profile photo removed');
});
const avatarInputEl = document.getElementById('avatar-input');
if (avatarInputEl) avatarInputEl.addEventListener('change', (event) => {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (file) handleAvatarFile(file);
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
let acctRecShownCodes = [];
// Plaintext codes live ONLY here (memory) and in one encrypted on-device
// cache below. The server keeps hashes + wraps, so a second device can never
// re-display them — it must replace the set (invalidating the old codes).
function acctRecCacheKey() {
  try {
    const name = cachedProfile && cachedProfile.username ? String(cachedProfile.username).toLowerCase() : '';
    if (name) return `notely-recovery-codes:${name}`;
  } catch (error) {}
  return null;
}
async function saveRecoveryCodesLocal(codes) {
  if (!e2ee.masterKey) return;
  const key = acctRecCacheKey();
  if (!key) return;
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, e2ee.masterKey, new TextEncoder().encode(JSON.stringify(codes)));
  try {
    localStorage.setItem(key, JSON.stringify({ iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) }));
  } catch (error) {}
}
async function loadRecoveryCodesLocal() {
  if (!e2ee.masterKey) return null;
  const key = acctRecCacheKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const plain = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: e2eeB64ToBytes(obj.iv) }, e2ee.masterKey, e2eeB64ToBytes(obj.data));
    const codes = JSON.parse(new TextDecoder().decode(plain));
    return Array.isArray(codes) && codes.length ? codes : null;
  } catch (error) {
    return null;
  }
}
function clearRecoveryCodesLocal() {
  try {
    const key = acctRecCacheKey();
    if (key) localStorage.removeItem(key);
  } catch (error) {}
}
function renderAcctRecCodes() {
  const list = document.getElementById('acct-rec-codes');
  if (!list) return;
  list.innerHTML = '';
  acctRecShownCodes.forEach((code) => {
    const item = document.createElement('li');
    item.textContent = code;
    list.appendChild(item);
  });
}
function openAcctRecModal() {
  renderAcctRecCodes();
  const err = document.getElementById('acct-rec-modal-error');
  if (err) err.hidden = true;
  const modal = document.getElementById('acct-rec-modal');
  if (modal) modal.hidden = false;
}
function closeAcctRecModal() {
  // One-shot display: wipe plaintext codes from memory and DOM on close.
  acctRecShownCodes = [];
  renderAcctRecCodes();
  const modal = document.getElementById('acct-rec-modal');
  if (modal) modal.hidden = true;
}
const acctRecDownloadBtn = document.getElementById('acct-rec-download-btn');
if (acctRecDownloadBtn) acctRecDownloadBtn.addEventListener('click', () => {
  try {
    const body = ['Notely password recovery codes', `Account: ${(cachedProfile && cachedProfile.username) || ''}`,
      `Generated: ${new Date().toISOString()}`, '',
      ...acctRecShownCodes, '',
      'Each code works once. Store them offline.'].join('\n');
    const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'notely-recovery-codes.txt';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (error) {
    const err = document.getElementById('acct-rec-modal-error');
    if (err) { err.textContent = 'Download failed — copy the codes manually.'; err.hidden = false; }
  }
});
const acctRecDoneBtn = document.getElementById('acct-rec-done-btn');
if (acctRecDoneBtn) acctRecDoneBtn.addEventListener('click', async () => {
  closeAcctRecModal();
  showToast('Recovery codes saved.');
  try { await refreshAcctRecStatus(); } catch (error) {}
});
async function refreshAcctRecStatus() {
  // Count display only; plaintext codes are never re-fetchable by design.
  // While unused codes exist the SAME set stays viewable (no regenerate);
  // generating again is only offered once the set is exhausted.
  const genBtn = document.getElementById('acct-rec-generate-btn');
  const viewBtn = document.getElementById('acct-rec-view-btn');
  try {
    const r = await apiFetch('/api/recovery/account/count');
    if (!r.ok) return;
    const data = await r.json();
    const n = data.count || 0;
    const st = document.getElementById('acct-rec-status');
    if (n > 0) {
      const local = await loadRecoveryCodesLocal();
      if (st) st.textContent = local
        ? `${n} unused codes stored. Same set as generated — view anytime.`
        : `${n} unused codes stored (generated on another device). Use one, or replace the whole set.`;
      if (genBtn) {
        genBtn.hidden = Boolean(local);
        genBtn.textContent = local ? 'Generate recovery codes' : 'Replace codes…';
      }
      if (viewBtn) viewBtn.hidden = !local;
    } else {
      clearRecoveryCodesLocal();
      if (st) st.textContent = 'No recovery codes stored on this account.';
      if (genBtn) { genBtn.hidden = false; genBtn.textContent = 'Generate recovery codes'; }
      if (viewBtn) viewBtn.hidden = true;
    }
  } catch (error) {}
}
const acctRecViewBtn = document.getElementById('acct-rec-view-btn');
if (acctRecViewBtn) acctRecViewBtn.addEventListener('click', async () => {
  const codes = await loadRecoveryCodesLocal();
  if (!codes) {
    showToast('Codes are on the device where they were generated.');
    await refreshAcctRecStatus();
    return;
  }
  acctRecShownCodes = codes;
  renderAcctRecCodes();
  const modal = document.getElementById('acct-rec-modal');
  if (modal) modal.hidden = false;
});
if (acctRecBtn) acctRecBtn.addEventListener('click', async () => {
  const errEl = document.getElementById('acct-rec-error');
  // 8 sequential Argon2id wraps take several seconds: show progress so the
  // click feels alive. Yields between rounds let the label actually paint.
  const paint = () => new Promise((resolve) => setTimeout(resolve, 30));
  try {
    if (!cachedProfile || !e2ee.masterKey) throw new Error('Log in and unlock notes first.');
    acctRecBtn.disabled = true;
    acctRecBtn.textContent = 'Starting…';
    await paint();
    // Replacement guard: never silently invalidate an existing unused set.
    // (The button is hidden while this device holds the codes, so reaching
    // here means another device made them — demand explicit confirmation.)
    try {
      const pre = await apiFetch('/api/recovery/account/count');
      if (pre.ok && ((await pre.json()).count || 0) > 0 && !(await loadRecoveryCodesLocal())) {
        const typed = await askInput({
          eyebrow: 'Password recovery', title: 'Replace codes?',
          desc: 'This invalidates the existing unused codes (e.g. made on another device). Type REPLACE to continue.',
          label: 'Confirmation', password: false, placeholder: 'REPLACE', okText: 'Replace',
        });
        if (String(typed || '').trim().toUpperCase() !== 'REPLACE') {
          acctRecBtn.disabled = false;
          acctRecBtn.textContent = 'Replace codes…';
          return;
        }
      }
    } catch (error) {
      if (error && error.message === 'Log in and unlock notes first.') throw error;
      // Count check is advisory only; a failed check must not block generate.
    }
    const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
    const wraps = [];
    const plain = [];
    for (let i = 0; i < 8; i += 1) {
      acctRecBtn.textContent = `Generating ${i + 1} of 8…`;
      await paint();
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
    acctRecBtn.textContent = 'Saving…';
    const r = await apiFetch('/api/recovery/account/generate', { method: 'POST', body: JSON.stringify({ wraps }) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.error || 'Could not store codes.');
    }
    acctRecShownCodes = plain;
    try { await saveRecoveryCodesLocal(plain); } catch (error) {}
    if (errEl) errEl.hidden = true;
    openAcctRecModal();
    await refreshAcctRecStatus();
  } catch (error) {
    if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
  } finally {
    try {
      acctRecBtn.disabled = false;
      await refreshAcctRecStatus();
    } catch (error) {
      try { acctRecBtn.textContent = 'Generate recovery codes'; } catch {}
    }
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
  // Code flow always restarts at the verify view; a verified match swaps the
  // popup to the new-password view (see verify handler).
  if (kind === 'code') {
    const vv = document.getElementById('recover-verify-view');
    if (vv) vv.hidden = false;
    const np = document.getElementById('recover-newpw-block');
    if (np) np.hidden = true;
    if (title) title.textContent = 'Recover with code';
  } else if (title) title.textContent = kind === 'email' ? 'Recover with email'
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
    // Swap the popup: verify view out, new-password view in.
    document.getElementById('recover-verify-view').hidden = true;
    document.getElementById('recover-newpw-block').hidden = false;
    document.getElementById('recover-modal-title').textContent = 'Set a new password';
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
  try { refreshAcctRecStatus(); } catch (error) {}
});
// Apply a theme, persist the choice and update the meta theme-color.
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
  const themeSelectEl = document.getElementById('theme-select');
  if (themeSelectEl) themeSelectEl.value = normalized;
  document.querySelectorAll('.login-theme-item').forEach((option) => {
    const selected = option.dataset.themeValue === normalized;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  if (announce) showToast(`${THEME_LABELS[normalized] || normalized} theme on`);
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
  if (name === 'tags') { try { renderSettingsTags(); } catch (error) {} }
}
const settingsNewTagBtn = document.getElementById('settings-new-tag');
if (settingsNewTagBtn) settingsNewTagBtn.addEventListener('click', async () => {
  const value = await askInput({
    eyebrow: 'New tag', title: 'Create a tag',
    desc: 'It becomes available in every note’s tag editor, and you can search it with “tag: <name>”.',
    label: 'Tag name', password: false, placeholder: 'e.g. project', okText: 'Create tag',
  });
  if (value == null) return;
  addKnownTag(value);
});
document.querySelectorAll('.settings-nav-item').forEach((item) => item.addEventListener('click', () => setSettingsTab(item.dataset.settingsTab)));
document.getElementById('start-collapsed').addEventListener('change', (event) => {
  const collapsed = event.target.checked;
  try { localStorage.setItem('notely-sidebar-start-collapsed', collapsed ? '1' : '0'); } catch (error) {}
  setSidebarCollapsed(collapsed);
  showToast(collapsed ? 'Sidebar will start collapsed' : 'Sidebar will start expanded');
});

// ---- Device copy / cloud opt-out wiring ----
const deviceOnlyBox = document.getElementById('device-only-mode');
// Export every plainWorkspace note (and unlocked Vault notes) as one JSON
// backup file in the browser's download folder — the "desktop copy".
function exportAllNotes() {
  if (!cachedProfile || !notesLoaded) { showToast('Log in first'); return; }
  const payload = {
    app: 'Notely',
    version: 2,
    exportedAt: new Date().toISOString(),
    notes: notes.map((note) => ({ ...note })),
  };
  if (vault.unlocked && vault.notes.length) {
    payload.vaultNotes = vault.notes.map((note) => ({ ...note, vault: true }));
  }
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  link.download = sanitizeFilename(`Notely-notes-${stamp}`, 'json');
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 800);
  showToast('Notes exported to your device');
}
document.getElementById('export-all-btn').addEventListener('click', exportAllNotes);
// Turning sync OFF is single-click (toast warns). Turning it back ON opens
// the resync dialog so the local copy is uploaded or discarded deliberately.
deviceOnlyBox.addEventListener('change', (event) => {
  const on = event.target.checked;
  if (!cachedProfile) {
    event.target.checked = false;
    showToast('Log in first');
    return;
  }
  if (on) {
    setDeviceOnlyPref(true);
    clearTimeout(syncTimer);
    syncNotesToServer();
    showToast('This device only — notes no longer sync to the cloud');
    return;
  }
  const overlay = document.getElementById('resync-overlay');
  if (!overlay) { // No dialog available: keep server notes, drop the local copy
    setDeviceOnlyPref(false);
    showToast('Sync re-enabled');
    return;
  }
  overlay.hidden = false;
});
document.getElementById('resync-close').addEventListener('click', () => {
  deviceOnlyBox.checked = true;
  document.getElementById('resync-overlay').hidden = true;
});
document.getElementById('resync-cancel').addEventListener('click', () => {
  deviceOnlyBox.checked = true;
  document.getElementById('resync-overlay').hidden = true;
});
document.getElementById('resync-overlay').addEventListener('click', (event) => {
  if (event.target === document.getElementById('resync-overlay')) {
    deviceOnlyBox.checked = true;
    document.getElementById('resync-overlay').hidden = true;
  }
});
// Upload local copy: refresh serverNotesVersion from the server's current
// blob (empty for fresh accounts), push so the device copy wins, and clear
// the local slot so a later device-only session starts fresh.
document.getElementById('resync-upload').addEventListener('click', async () => {
  setDeviceOnlyPref(false);
  try { localStorage.removeItem(localNotesKey()); } catch (error) {}
  document.getElementById('resync-overlay').hidden = true;
  try {
    const response = await apiFetch('/api/notes');
    if (response.ok) {
      const data = await response.json();
      if (data && typeof data.updated_at === 'number') serverNotesVersion = data.updated_at;
    }
  } catch (error) {}
  await syncNotesToServer();
  showToast('Local notes uploaded — sync is back on');
});
// Keep server copy (local is cleared) and reload it onto this device.
document.getElementById('resync-keep').addEventListener('click', async () => {
  setDeviceOnlyPref(false);
  try { localStorage.removeItem(localNotesKey()); } catch (error) {}
  document.getElementById('resync-overlay').hidden = true;
  await loadNotesFromServer();
  renderNoteList();
  showToast('Sync re-enabled — server notes kept');
});
// Reflect the device-only checkbox when settings open.
if (deviceOnlyBox) {
  const openSettingsDeviceOnly = () => {
    deviceOnlyBox.checked = deviceOnlyPref();
  };
  document.getElementById('open-settings').addEventListener('click', openSettingsDeviceOnly);
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
const themeSelect = document.getElementById('theme-select');
if (themeSelect) themeSelect.addEventListener('change', () => applyTheme(themeSelect.value, true));
// Reading font (Settings → Appearance). Device-local like the sidebar prefs
// (not part of the per-account envelope): one line, no sync conflicts.
const FONTS = ['default', 'serif', 'palatino', 'sans', 'verdana', 'mono'];
function applyFont(font, announce = false) {
  const normalized = FONTS.includes(font) ? font : 'default';
  document.documentElement.dataset.font = normalized;
  try { localStorage.setItem('notely-font', normalized); } catch (error) {}
  const fontSelectEl = document.getElementById('font-select');
  if (fontSelectEl) fontSelectEl.value = normalized;
  if (announce) showToast(`${normalized.charAt(0).toUpperCase() + normalized.slice(1)} font on`);
}
let savedFont = 'default';
try { savedFont = localStorage.getItem('notely-font') || 'default'; } catch (error) {}
applyFont(savedFont);
const fontSelect = document.getElementById('font-select');
if (fontSelect) fontSelect.addEventListener('change', () => applyFont(fontSelect.value, true));
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
    if (typeof sharedMenuTarget !== 'undefined' && sharedMenuTarget) { closeSharedContextMenu(); return; }
    if (contextMenuNoteId) { closeNoteContextMenu(); return; }
    const vaultOverlay = document.getElementById('vault-overlay');
    if (vaultOverlay && !vaultOverlay.hidden) { closeVaultModal(); return; }
    const deleteOverlay = document.getElementById('delete-overlay');
    if (deleteOverlay && !deleteOverlay.hidden) { closeDeleteConfirm(); return; }
    const templateOverlay = document.getElementById('template-overlay');
    if (templateOverlay && !templateOverlay.hidden) { closeTemplatePicker(); return; }
    const folderPickOverlay = document.getElementById('folder-pick-overlay');
    if (folderPickOverlay && !folderPickOverlay.hidden) { closeFolderPicker(); return; }
    const sectionIconOverlay = document.getElementById('section-icon-overlay');
    if (sectionIconOverlay && !sectionIconOverlay.hidden) { closeSectionIconPicker(); return; }
    const tagEditorOverlay = document.getElementById('tag-editor-overlay');
    if (tagEditorOverlay && !tagEditorOverlay.hidden) { closeTagEditor(); return; }
    const collabNewOverlay = document.getElementById('collab-new-overlay');
    if (collabNewOverlay && !collabNewOverlay.hidden) { closeCollabNewDialog(); return; }
    if (collab.noteId) { closeCollabNote(); return; }
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
bindSectionContextMenu();
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
  // A valid session plus a per-browser-session key (sessionStorage) restores the
  // workspace on refresh; otherwise the vault stays locked and the password gate
  // shows. The key is wiped when the tab/browser closes or on logout.
  const unlocked = await restoreSessionUnlock();
  if (unlocked) {
    hideLogin();
    try { await enterWorkspace(); }
    catch (error) { e2eeLock(); clearSessionUnlock(); notes = []; clearEditor(); showLogin(); }
  } else {
    notes = [];
    clearEditor();
    showLogin();
    refreshEditorLock();
    syncCustomSections();
    renderCustomSections();
    clearEditor();
    refreshEditorLock();
  }
  // Email-reset landing: open recovery with only the token popup visible.
  try {
    if (emailRecoveryToken) {
      setAuthTab('recover');
      openRecoverModal('token');
    }
  } catch {}
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
