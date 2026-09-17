// js/data/exchange.js — workspace Import/Export in Markdown, JSON, YAML, TXT.
//
// Single-file backups: Export writes the chosen format, Import auto-detects
// from the file extension. JSON/YAML carry the full note objects (lossless);
// Markdown carries title+tags+ext in front-matter; TXT carries `# heading`
// titles. YAML support is a constrained subset (exactly what our emitter
// writes, plus hand-written equivalents) — unparseable files fall back to a
// single text note so nothing is ever silently dropped.

import { state } from '../domain/state.js';
import { migrateNote, normalizeExt, sanitizeFilename } from '../core/schema.js';
import { newNoteId } from '../core/ids.js';
import { ensureNoteFiled, persistNotes, selectNote } from '../ui/notes.js';
import { renderCustomSections, syncCustomSections, uniqueSectionId } from '../ui/sections.js';
import { showToast } from '../ui/modal.js';

export const EXCHANGE_FORMATS = ['json', 'yaml', 'md', 'txt'];
const MAX_IMPORT_BYTES_PER_FILE = 1024 * 1024;
const MAX_IMPORT_BYTES_TOTAL = 5 * 1024 * 1024;
const MAX_NOTES = 2000;

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

function yamlQuote(value) {
  return '"' + String(value == null ? '' : value)
    .replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    .replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

function unquoteScalar(value) {
  const t = String(value == null ? '' : value).trim();
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t); } catch (error) { return t.slice(1, -1); }
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

// Split a flow list ("[a, \"b, c\", d]") or flow map ("{k: v, ...}") on
// top-level commas only (quote- and bracket-aware).
function splitFlowList(inner) {
  const parts = [];
  let cur = '';
  let quote = null;
  let depth = 0;
  for (const ch of String(inner)) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === '[' || ch === '{') {
      depth += 1;
      cur += ch;
    } else if (ch === ']' || ch === '}') {
      depth -= 1;
      cur += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}

function uniqueTitleLocal(base) {
  const clean = (typeof base === 'string' ? base : 'Untitled note').trim().slice(0, 180) || 'Untitled note';
  const taken = new Set(state.notes.filter((note) => !note.deleted).map((note) => String(note.title || '').toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  let counter = 2;
  while (taken.has(`${clean} ${counter}`.toLowerCase())) counter += 1;
  return `${clean} ${counter}`;
}

function downloadFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  setTimeout(() => { URL.revokeObjectURL(link.href); link.remove(); }, 800);
}

function stamp() {
  return new Date().toISOString().slice(0, 10);
}

// Human-readable location of a note: section NAME (ids are per-account and
// meaningless elsewhere) plus its folder path. Used on export so hierarchy
// round-trips across accounts and formats.
function noteLocation(note) {
  const secs = (note && note.sections && typeof note.sections === 'object' && !Array.isArray(note.sections))
    ? Object.entries(note.sections) : [];
  const found = secs.find(([, folder]) => typeof folder === 'string' && folder.trim());
  const folder = found ? found[1].trim().slice(0, 180) : '';
  let list = [];
  try { list = (state && Array.isArray(state.customSections)) ? state.customSections : []; } catch (error) { list = []; }
  const sec = found ? list.find((entry) => entry.id === found[0]) : null;
  return { section: sec ? sec.name : '', folder };
}

// Ancestor chain of a folder path ("A / B / C" -> ["A / B", "A"]) so imported
// sections list every level the tree needs.
function folderAncestors(folder) {
  const parts = String(folder || '').split('/').map((part) => part.trim()).filter(Boolean);
  const out = [];
  for (let i = parts.length - 1; i >= 1; i -= 1) out.push(parts.slice(0, i).join(' / '));
  return out;
}

// Create the dedicated section an import lands in, pre-seeded with every
// folder path (plus ancestors) so the hierarchy arrives intact. Notes can be
// dragged elsewhere afterwards.
function createImportSection(folders) {
  const base = `Import ${stamp()}`;
  const taken = new Set(state.customSections.map((s) => String(s.name || '').toLowerCase()));
  let name = base;
  let counter = 2;
  while (taken.has(name.toLowerCase())) name = `${base} (${counter += 1})`;
  const all = new Set();
  for (const folder of folders) {
    const clean = String(folder || '').trim().slice(0, 180);
    if (!clean) continue;
    all.add(clean);
    for (const ancestor of folderAncestors(clean)) all.add(ancestor);
  }
  const section = { id: uniqueSectionId(), name, folders: [...all], icon: 'layers' };
  state.customSections.push(section);
  return section;
}

// Folder path carried by an imported raw note: explicit `folder` field first,
// then the first filing of a legacy `sections` map.
function rawFolderPath(raw) {
  if (raw && typeof raw.folder === 'string' && raw.folder.trim()) return raw.folder.trim().slice(0, 180);
  const secs = (raw && raw.sections && typeof raw.sections === 'object' && !Array.isArray(raw.sections))
    ? Object.values(raw.sections) : [];
  const found = secs.find((folder) => typeof folder === 'string' && folder.trim());
  return found ? found.trim().slice(0, 180) : '';
}

// ---------------------------------------------------------------------------
// YAML subset codec (emits + reads exactly the shape below)
// ---------------------------------------------------------------------------

function yamlDumpNotes(notes) {
  const lines = ['app: Notely', 'version: 2', `exportedAt: ${yamlQuote(new Date().toISOString())}`, 'notes:'];
  for (const note of notes) {
    const n = note && typeof note === 'object' ? note : {};
    const loc = noteLocation(n);
    lines.push(`- id: ${yamlQuote(n.id || '')}`);
    lines.push(`  title: ${yamlQuote(n.title || 'Untitled note')}`);
    lines.push(`  section: ${yamlQuote(loc.section)}`);
    lines.push(`  folder: ${yamlQuote(loc.folder)}`);
    lines.push(`  tags: [${(Array.isArray(n.tags) ? n.tags : []).map((t) => yamlQuote(t)).join(', ')}]`);
    lines.push(`  favorite: ${n.favorite ? 'true' : 'false'}`);
    lines.push(`  archived: ${n.archived ? 'true' : 'false'}`);
    lines.push(`  deleted: ${n.deleted ? 'true' : 'false'}`);
    if (typeof n.deletedAt === 'number' && Number.isFinite(n.deletedAt)) lines.push(`  deletedAt: ${n.deletedAt}`);
    if (typeof n.updatedAt === 'number' && Number.isFinite(n.updatedAt)) lines.push(`  updatedAt: ${n.updatedAt}`);
    lines.push(`  ext: ${yamlQuote(n.ext || 'md')}`);
    lines.push(`  date: ${yamlQuote(n.date || 'Now')}`);
    if (n.template === 'recipe' || n.template === 'todo') lines.push(`  template: ${yamlQuote(n.template)}`);
    if (typeof n.description === 'string') lines.push(`  description: ${yamlQuote(n.description)}`);
    if (Array.isArray(n.ingredients)) lines.push(`  ingredients: ${JSON.stringify(n.ingredients)}`);
    if (Array.isArray(n.steps)) lines.push(`  steps: ${JSON.stringify(n.steps.map((s) => String(s)))}`);
    const sections = n.sections && typeof n.sections === 'object' && !Array.isArray(n.sections) ? n.sections : {};
    const keys = Object.keys(sections);
    if (keys.length) {
      lines.push('  sections:');
      for (const key of keys.slice(0, 20)) {
        lines.push(`    ${yamlQuote(key)}: ${yamlQuote(sections[key] == null ? '' : sections[key])}`);
      }
    }
    lines.push('  body: |');
    for (const bodyLine of String(n.body == null ? '' : n.body).replace(/\r/g, '').split('\n')) {
      lines.push(bodyLine ? '    ' + bodyLine : '');
    }
  }
  return lines.join('\n') + '\n';
}

function yamlParseScalar(text) {
  const t = String(text == null ? '' : text).trim();
  if (t === '' || t === '~' || t.toLowerCase() === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+$/.test(t)) {
    const n = parseInt(t, 10);
    if (Number.isSafeInteger(n)) return n;
  }
  if (/^-?\d*\.\d+([eE][+-]?\d+)?$/.test(t)) {
    const n = parseFloat(t);
    if (Number.isFinite(n)) return n;
  }
  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') {
    try { return JSON.parse(t); } catch (error) { return t.slice(1, -1); }
  }
  if (t.length >= 2 && t[0] === "'" && t[t.length - 1] === "'") return t.slice(1, -1).replace(/''/g, "'");
  if (t[0] === '[' && t[t.length - 1] === ']') {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlowList(inner).map((part) => yamlParseScalar(part)).filter((v) => v !== null && v !== '');
  }
  if (t[0] === '{' && t[t.length - 1] === '}') {
    const inner = t.slice(1, -1).trim();
    const obj = {};
    if (inner) {
      for (const part of splitFlowList(inner)) {
        const m = part.match(/^(.+?)\s*:\s*(.*)$/s);
        if (m) obj[unquoteScalar(m[1])] = yamlParseScalar(m[2]);
      }
    }
    return obj;
  }
  return t;
}

// Parse our YAML subset into raw note objects. Throws on structural garbage
// (the caller falls back to a single text note).
function yamlParseNotes(text) {
  const lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n');
  const items = [];
  let cur = null;
  let inList = false;
  let inSections = false;
  let litKey = null;
  let litIndent = -1;
  let litBuf = [];
  const flushLiteral = () => {
    if (litKey && cur) cur[litKey] = litBuf.join('\n').replace(/\n+$/, '');
    litKey = null;
    litBuf = [];
    litIndent = -1;
  };
  const indentOf = (line) => (line.match(/^ */) || [''])[0].length;
  for (const line of lines) {
    if (!line.trim()) { if (litKey) litBuf.push(''); continue; }
    const indent = indentOf(line);
    const content = line.trim();
    // A new top-level list item always ends any open literal first.
    if (indent === 0 && content.startsWith('- ')) {
      flushLiteral();
      inList = true;
      inSections = false;
      cur = {};
      items.push(cur);
      const rest = content.slice(2).trim();
      if (rest) {
        const m = rest.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
        if (m) setField(cur, m[1], m[2]);
        else throw new Error('Bad YAML list item.');
      }
      continue;
    }
    if (litKey) {
      if (litIndent < 0) litIndent = indent;
      if (indent < litIndent) {
        flushLiteral();
      } else {
        litBuf.push(line.slice(litIndent));
        continue;
      }
    }
    if (!cur) {
      const m = content.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
      if (m && m[1].toLowerCase() === 'notes' && !m[2].trim()) { inList = true; continue; }
      continue; // top-level app/version/exportedAt keys are informational
    }
    if (indent === 2 && inList) {
      inSections = false;
      const m = content.match(/^([A-Za-z_][\w-]*)\s*:(.*)$/);
      if (!m) throw new Error('Bad YAML mapping.');
      if (!m[2].trim()) {
        if (m[1].toLowerCase() === 'sections') { cur.sections = {}; inSections = true; continue; }
        cur[m[1]] = null;
        continue;
      }
      if (m[2].trim() === '|') { litKey = m[1]; litIndent = -1; litBuf = []; continue; }
      setField(cur, m[1], m[2]);
      continue;
    }
    if (indent >= 4 && inSections) {
      const m = content.match(/^(.+?)\s*:(.*)$/);
      if (m) {
        const parsed = yamlParseScalar(m[2]);
        cur.sections[unquoteScalar(m[1])] = String(parsed == null ? '' : parsed);
      }
      continue;
    }
    throw new Error('Bad YAML structure.');
  }
  flushLiteral();
  return items;
}

function setField(obj, key, raw) {
  obj[key] = yamlParseScalar(raw);
}

// ---------------------------------------------------------------------------
// Markdown multi-note codec (front-matter blocks)
// ---------------------------------------------------------------------------

function mdDumpNotes(notes) {
  return notes.map((note) => {
    const n = note && typeof note === 'object' ? note : {};
    const loc = noteLocation(n);
    const title = String(n.title || 'Untitled note').replace(/\s+/g, ' ').trim().slice(0, 180) || 'Untitled note';
    const tags = (Array.isArray(n.tags) ? n.tags : []).map((t) => yamlQuote(t)).join(', ');
    const ext = (n.ext === 'txt' || n.ext === 'json' || n.ext === 'yaml') ? n.ext : 'md';
    return `---\ntitle: ${yamlQuote(title)}\nsection: ${yamlQuote(loc.section)}\nfolder: ${yamlQuote(loc.folder)}\ntags: [${tags}]\next: ${ext}\n---\n\n${String(n.body == null ? '' : n.body).replace(/\r/g, '')}\n`;
  }).join('\n');
}

function parseMdFrontMatter(fmLines) {
  const out = { title: '', tags: [], ext: 'md', folder: '' };
  for (const rawLine of fmLines) {
    const line = String(rawLine).trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'title') out.title = unquoteScalar(val).slice(0, 180);
    else if (key === 'tags') {
      const inner = val.startsWith('[') && val.endsWith(']') ? val.slice(1, -1) : val;
      out.tags = splitFlowList(inner).map((p) => String(unquoteScalar(p)).trim()).filter(Boolean).slice(0, 20);
    } else if (key === 'ext' && /^(md|txt|json|yaml)$/i.test(unquoteScalar(val))) {
      out.ext = String(unquoteScalar(val)).toLowerCase();
    } else if (key === 'folder') {
      out.folder = String(unquoteScalar(val)).trim().slice(0, 180);
    }
  }
  return out;
}

function mdParseNotes(text, fallbackTitle) {
  const lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n');
  const isFence = (line) => line.trim() === '---';
  const looksFm = (segment) => segment.some((line) => /^(title|tags|id|ext|date|favorite|archived|deleted|section|folder)\s*:/.test(line.trim()));
  const notes = [];
  let fm = null;
  let body = [];
  const flush = () => {
    const textBody = body.join('\n').replace(/^\n+|\s+$/g, '');
    if (fm || textBody) notes.push({ fm, body: textBody });
    fm = null;
    body = [];
  };
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i < lines.length && !isFence(lines[i])) {
    return [{ fm: null, body: lines.join('\n').replace(/^\n+|\s+$/g, '') }];
  }
  while (i < lines.length) {
    if (!isFence(lines[i])) { body.push(lines[i]); i += 1; continue; }
    let j = i + 1;
    const segment = [];
    while (j < lines.length && !isFence(lines[j])) { segment.push(lines[j]); j += 1; }
    if (j < lines.length && looksFm(segment)) {
      flush();
      fm = segment;
      i = j + 1;
      continue;
    }
    if (j < lines.length) body.push(lines[i]); // fence is body text
    i += 1;
  }
  flush();
  return notes.map(({ fm: fmLines, body: noteBody }) => {
    const meta = fmLines ? parseMdFrontMatter(fmLines) : { title: '', tags: [], ext: 'md', folder: '' };
    return { title: meta.title || fallbackTitle, tags: meta.tags, ext: meta.ext, folder: meta.folder || '', body: noteBody };
  });
}

// ---------------------------------------------------------------------------
// TXT codec (`# Heading` blocks split on `---` dividers)
// ---------------------------------------------------------------------------

function txtDumpNotes(notes) {
  return notes.map((note) => {
    const n = note && typeof note === 'object' ? note : {};
    const title = String(n.title || 'Untitled note').replace(/\s+/g, ' ').trim() || 'Untitled note';
    const loc = noteLocation(n);
    const marker = loc.folder ? `> ${loc.folder}\n\n` : '';
    return `# ${title}\n\n${marker}${String(n.body == null ? '' : n.body).replace(/\r/g, '')}`;
  }).join('\n\n---\n\n') + '\n';
}

function txtParseNotes(text, fallbackTitle) {
  const lines = String(text == null ? '' : text).replace(/\r/g, '').split('\n');
  const notes = [];
  let title = null;
  let body = [];
  let pendingDivider = false;
  let seenContent = false;
  let folder = '';
  let folderChecked = false;
  const flush = () => {
    const textBody = body.join('\n').replace(/^\n+|\s+$/g, '');
    if (title || textBody) notes.push({ title: title || fallbackTitle, folder, body: textBody });
    title = null;
    body = [];
    folder = '';
    folderChecked = false;
  };
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { body.push(line); continue; }
    if (trimmed === '---') { pendingDivider = true; continue; }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading && (!seenContent || pendingDivider)) {
      flush();
      title = heading[1].trim().slice(0, 180) || fallbackTitle;
      pendingDivider = false;
      seenContent = true;
      continue;
    }
    if (pendingDivider) { body.push('---'); pendingDivider = false; }
    // A `> path` line as the first body line of a headed note carries the
    // folder (written by our exporter). Heading-less files skip this so a
    // leading quote line is never eaten.
    if (!folderChecked && title !== null) {
      folderChecked = true;
      const marker = line.match(/^>\s*(\S(?:.*\S)?)\s*$/);
      if (marker) {
        folder = marker[1].slice(0, 180);
        seenContent = true;
        continue;
      }
    }
    seenContent = true;
    body.push(line);
  }
  flush();
  return notes;
}

// ---------------------------------------------------------------------------
// JSON parsing (Notely envelope, raw array, single note)
// ---------------------------------------------------------------------------

function parseJsonNotes(text) {
  const parsed = JSON.parse(String(text || ''));
  if (parsed && parsed.app === 'Notely' && Array.isArray(parsed.notes)) {
    return { notes: parsed.notes, sections: parsed.ui && Array.isArray(parsed.ui.customSections) ? parsed.ui.customSections : null };
  }
  if (Array.isArray(parsed)) return { notes: parsed, sections: null };
  if (parsed && typeof parsed === 'object' && (parsed.title !== undefined || parsed.body !== undefined)) {
    return { notes: [parsed], sections: null };
  }
  throw new Error('No notes found in JSON.');
}

// ---------------------------------------------------------------------------
// Export / import flows
// ---------------------------------------------------------------------------

function workspaceNotesForExport(full) {
  const list = state.notes.filter((note) => full || !note.deleted);
  return list.map((note) => ({ ...note }));
}

export async function exportWorkspace(format) {
  if (!state.cachedProfile || !state.notesLoaded) { showToast('Log in first'); return; }
  const fmt = EXCHANGE_FORMATS.includes(format) ? format : 'json';
  const full = fmt === 'json' || fmt === 'yaml';
  const docs = workspaceNotesForExport(full);
  if (!docs.length) { showToast('No notes to export'); return; }
  const stampStr = stamp();
  let text = '';
  let ext = fmt;
  let mime = 'text/plain';
  if (fmt === 'json') {
    text = JSON.stringify({
      app: 'Notely', version: 2, exportedAt: new Date().toISOString(),
      notes: docs.map((note) => ({ ...note, ...noteLocation(note) })),
    }, null, 2);
    ext = 'json';
    mime = 'application/json';
  } else if (fmt === 'yaml') {
    text = yamlDumpNotes(docs);
    ext = 'yaml';
    mime = 'text/yaml';
  } else if (fmt === 'md') {
    text = mdDumpNotes(docs);
    ext = 'md';
    mime = 'text/markdown';
  } else {
    text = txtDumpNotes(docs);
    ext = 'txt';
    mime = 'text/plain';
  }
  downloadFile(sanitizeFilename(`Notely-notes-${stampStr}`, ext), text, mime);
  showToast(`Exported ${docs.length} note${docs.length === 1 ? '' : 's'} (${ext.toUpperCase()})`);
}

function mergeRawNote(raw, fallbackBase, importSectionId) {
  const clean = (typeof raw.title === 'string' && raw.title.trim())
    ? raw.title : ((typeof raw.name === 'string' && raw.name.trim()) ? raw.name : fallbackBase);
  const folder = rawFolderPath(raw);
  const note = migrateNote({
    id: newNoteId(),
    title: uniqueTitleLocal(clean),
    date: 'Now',
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 20) : [],
    favorite: !!raw.favorite,
    archived: !!raw.archived,
    deleted: !!raw.deleted,
    ...(typeof raw.deletedAt === 'number' ? { deletedAt: raw.deletedAt } : {}),
    ext: normalizeExt(raw.ext || 'md'),
    template: (raw.template === 'recipe' || raw.template === 'todo') ? raw.template : undefined,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    ...(Array.isArray(raw.ingredients) ? { ingredients: raw.ingredients } : {}),
    ...(Array.isArray(raw.steps) ? { steps: raw.steps.map((s) => String(s)) } : {}),
    sections: importSectionId ? { [importSectionId]: folder } : {},
    body: String(raw.body == null ? (raw.content == null ? (raw.text == null ? '' : raw.text) : raw.content) : raw.body),
  });
  ensureNoteFiled(note);
  state.notes.unshift(note);
  return note.id;
}

export async function importExchangeFiles(files) {
  if (!state.cachedProfile || !state.notesLoaded) { showToast('Log in first'); return; }
  const picked = [...(files || [])];
  if (!picked.length) return;
  let totalBytes = 0;
  // Phase 1: parse every file (no state changes yet).
  const batches = [];
  for (const file of picked) {
    try {
      const name = String((file && file.name) || 'Untitled note');
      if (typeof file.size === 'number' && file.size > MAX_IMPORT_BYTES_PER_FILE) { showToast(`Skipped ${name}: over 1 MB`); continue; }
      const text = await file.text();
      if (text.length > MAX_IMPORT_BYTES_PER_FILE) { showToast(`Skipped ${name}: over 1 MB`); continue; }
      totalBytes += text.length;
      if (totalBytes > MAX_IMPORT_BYTES_TOTAL) { showToast('Import stopped: 5 MB total limit'); break; }
      const rawBase = name.replace(/\.[^.]+$/, '').trim().slice(0, 180) || 'Untitled note';
      const base = rawBase.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
      const ext = /\.json$/i.test(name) ? 'json'
        : (/\.(yaml|yml)$/i.test(name) ? 'yaml'
        : (/\.(txt|text)$/i.test(name) ? 'txt' : 'md'));
      let raws = [];
      if (ext === 'json') {
        raws = parseJsonNotes(text).notes;
      } else if (ext === 'yaml') {
        try {
          raws = yamlParseNotes(text);
        } catch (error) {
          raws = [{ title: base, body: text, ext: 'txt' }];
        }
        if (!raws.length) raws = [{ title: base, body: text, ext: 'txt' }];
      } else if (ext === 'md') {
        raws = mdParseNotes(text, base).map((entry) => ({ ...entry, ext: normalizeExt(entry.ext || 'md') }));
      } else {
        raws = txtParseNotes(text, base).map((entry) => ({ ...entry, ext: 'txt' }));
      }
      if (raws.length) batches.push({ base, raws });
    } catch (error) { /* skip unreadable files */ }
  }
  const allRaws = batches.flatMap((batch) => batch.raws.map((raw) => ({ raw, base: batch.base })));
  if (!allRaws.length) { showToast('No notes found in file'); return; }
  // Phase 2: the import gets its own section carrying every folder path, so
  // the hierarchy arrives intact and notes can be dragged elsewhere after.
  const importSection = createImportSection(allRaws.map(({ raw }) => rawFolderPath(raw)));
  let imported = 0;
  let firstId = null;
  for (const { raw, base } of allRaws) {
    try {
      const id = mergeRawNote(raw, base, importSection.id);
      if (imported === 0) firstId = id;
      imported += 1;
      if (state.notes.length > MAX_NOTES) break;
    } catch (error) { /* skip unreadable entries */ }
  }
  if (imported) {
    state.activeFilter = 'all';
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
    syncCustomSections();
    renderCustomSections();
    if (firstId) {
      try { selectNote(firstId); } catch (error) {}
    }
    persistNotes();
    try { const syncMod = await import('./sync.js'); syncMod.syncNow().catch(() => {}); } catch (error) {}
    showToast(`Imported ${imported} note${imported === 1 ? '' : 's'} into “${importSection.name}” — syncing…`);
  } else {
    showToast('No notes found in file');
  }
}

// Exported for unit-style checks (pure codecs, no DOM/state needed beyond args).
export const __exchangeCodecs = { yamlDumpNotes, yamlParseNotes, mdDumpNotes, mdParseNotes, txtDumpNotes, txtParseNotes, parseJsonNotes };
