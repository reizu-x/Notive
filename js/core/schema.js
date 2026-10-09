// js/core/schema.js — note schema: ext types, validators, legacy migration, recipe fields.
import { newNoteId, isValidNoteId } from './ids.js';

export const NOTE_EXTS = ['md', 'txt', 'json', 'yaml'];

export const COVER_ACCEPT = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif',
  'image/avif', 'image/bmp', 'image/x-ms-bmp',
];

export const COVER_MAX_CHARS = 380000;

export const MIGRATED_COLLECTIONS_SECTION_ID = 'section-collections';

export function normalizeExt(ext, fallback = 'md') {
  const clean = String(ext == null ? '' : ext).trim().toLowerCase().replace(/^\./, '');
  if (clean === 'yml') return 'yaml';
  if (clean === 'markdown') return 'md';
  if (clean === 'text') return 'txt';
  return NOTE_EXTS.includes(clean) ? clean : fallback;
}

export function isImageFile(file) {
  if (!file) return false;
  if (COVER_ACCEPT.includes(String(file.type || '').toLowerCase())) return true;
  return /\.(png|jpe?g|jfif|webp|gif|avif|bmp)$/i.test(file.name || '');
}

export function parseRecipeBody(body) {
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

export function migrateNote(note) {
  const migrated = (note && typeof note === 'object' && !Array.isArray(note)) ? { ...note } : {};
  // Hidden system tags (leading underscore — retired `_todo`/`_recipe`
  // markers) and any tag outside the allowed alphabet (capitals, small
  // letters, dash) are stripped from every note on load.
  if (Array.isArray(migrated.tags)) {
    migrated.tags = migrated.tags.filter((tag) =>
      /^[A-Za-z-]+$/.test(String(tag || '')) && !String(tag).startsWith('_'));
  }
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
    // Retired tags, stripped from old notes so they never render:
    // - 'draft' is gone entirely;
    // - 'important' moved to a boolean flag (Important tab) — promote, then strip.
    if (migrated.tags.some((tag) => typeof tag === 'string' && tag.trim().toLowerCase() === 'important')) {
      migrated.important = true;
    }
    migrated.tags = migrated.tags
      .filter((tag) => typeof tag === 'string')
      .map((tag) => tag.trim().slice(0, 40))
      .filter((tag) => tag && tag.toLowerCase() !== 'draft' && tag.toLowerCase() !== 'important' && /^[A-Za-z]+$/.test(tag))
      .slice(0, 20);
  }
  if (typeof migrated.important !== 'boolean') migrated.important = false;
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

export function sanitizeIngredients(value) {
  return (Array.isArray(value) ? value : []).slice(0, 200).map((item) => {
    if (item && typeof item === 'object') return { t: String(item.t == null ? '' : item.t).slice(0, 300), d: Boolean(item.d) };
    return { t: String(item == null ? '' : item).slice(0, 300), d: false };
  });
}

export function sanitizeSteps(value) {
  return (Array.isArray(value) ? value : []).slice(0, 300).map((step) => String(step == null ? '' : step).slice(0, 2000));
}

export function cleanCoverSrc(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  const m = s.match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  if (s.length > COVER_MAX_CHARS) return null;
  return s;
}

// Build a safe download filename from a note title: strips path separators,
// control chars and dot-runs (no hidden double extensions).
// Parse a leading YAML-ish front-matter block (title + tags) so exported
// and re-imported .md files round-trip structured metadata. Returns {meta, body}.
export function parseMarkdownFrontMatter(text) {
  const source = String(text == null ? '' : text).replace(/\r/g, '');
  if (!source.startsWith('---')) return { meta: null, body: source };
  const end = source.indexOf('\n---', 3);
  if (end === -1) return { meta: null, body: source };
  const meta = { title: '', tags: [] };
  for (const raw of source.slice(3, end).split('\n')) {
    const line = raw.trim();
    if (line.startsWith('title:')) {
      meta.title = line.slice(6).trim().slice(0, 180);
    } else if (line.startsWith('tags:')) {
      const value = line.slice(5).trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        meta.tags = value.slice(1, -1).split(',').map((t) => t.trim().replace(/["']/g, '')).filter(Boolean).slice(0, 20);
      }
    }
  }
  return { meta, body: source.slice(end + 4).replace(/^\n/, '') };
}

export function sanitizeFilename(name, ext) {
  const base = String(name == null ? 'note' : name).trim() || 'note';
  const clean = base.replace(/[^a-zA-Z0-9-_. ]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'note';
  const safeExt = normalizeExt(ext);
  // Strip any extension confusion: never allow double extensions to hide type.
  const withoutDots = clean.replace(/\.+/g, '_');
  return `${withoutDots}.${safeExt}`;
}

// Note file types: Markdown renders + previews; txt/json/yaml are edited as
// plain source (no preview, no Markdown toolbar).
export const EXT_LABELS = { md: 'MD', txt: 'TXT', json: 'JSON', yaml: 'YAML' };
export const EXT_MIME = {
  md: 'text/markdown', txt: 'text/plain',
  json: 'application/json', yaml: 'application/x-yaml',
};

// Cover images are downscaled on import so a photo-sized upload cannot blow
// past the envelope/base64 budget.
export const COVER_MAX_DIM = 1200;

// Parse a typed title like "groceries.txt" into a bare title plus a canonical
// stored extension on the note object; unknown/trailing no-ext stays Markdown.
export function parseTitleExtension(rawTitle, note) {
  const input = typeof rawTitle === 'string' ? rawTitle : 'Untitled note';
  const match = input.match(/\.((md|markdown|txt|text|json|yaml|yml))$/i);
  if (match) {
    note.ext = normalizeExt(match[1]);
    return input.slice(0, -(match[0].length)).trim().slice(0, 200) || 'Untitled note';
  }
  return input.slice(0, 200);
}
