// js/ui/tags.js — tag helpers: normalization, counts, shared tags, tag
// editor plumbing.

import { tagList } from '../core/elements.js';
import { icon } from '../core/icons.js';
import { escapeHtml } from '../core/strings.js';
import { sharedGroupTags } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { showToast } from './modal.js';
import { activeEditorNote, persistNotes, renderNoteList } from './notes.js';
import { persistUiVault } from './vault.js';
import { updateMeta } from './notes.js';

export function sharedGroupTagList(groupId) {
  return sharedGroupTags.get(groupId) || sharedGroupTags.get(Number(groupId)) || [];
}

// ---- Settings → Customization → Tags --------------------------------------
export function renderSettingsTags() {
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

export function renderTagEditor() {
  let tags;
  if (state.tagEditorShared) {
    tags = sharedTagList();
  } else {
    const note = state.notes.find((item) => item.id === state.tagEditorNoteId);
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
    const pool = state.tagEditorShared
      ? [...sharedGroupTagList(state.collab.groupId).map((label) => ({ label })), ...allTagCounts()]
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

export function closeTagEditor() {
  const overlay = document.getElementById('tag-editor-overlay');
  if (overlay) overlay.hidden = true;
  state.tagEditorNoteId = null;
  state.tagEditorShared = false;
}

export function openTagEditor(id) {
  const note = state.notes.find((item) => item.id === id);
  const overlay = document.getElementById('tag-editor-overlay');
  if (!note || !overlay) return;
  state.tagEditorShared = false;
  state.tagEditorNoteId = id;
  const desc = document.getElementById('tag-editor-desc');
  if (desc) desc.textContent = `Add or remove tags for “${note.title || 'Untitled note'}”.`;
  renderTagEditor();
  overlay.hidden = false;
  const input = document.getElementById('tag-editor-input');
  if (input) { input.value = ''; try { input.focus(); } catch (error) {} }
}

export function openSharedTagEditor() {
  const overlay = document.getElementById('tag-editor-overlay');
  if (!overlay || !state.collab.noteId) return;
  state.tagEditorShared = true;
  state.tagEditorNoteId = null;
  const desc = document.getElementById('tag-editor-desc');
  const title = state.collab.title ? state.collab.title.toString() : 'this shared note';
  if (desc) desc.textContent = `Add or remove tags for “${title}”.`;
  renderTagEditor();
  overlay.hidden = false;
  const input = document.getElementById('tag-editor-input');
  if (input) { input.value = ''; try { input.focus(); } catch (error) {} }
}

export function renderSharedTags() {
  if (!state.collab.noteId || !tagList) return;
  const tags = sharedTagList();
  const addTagButton = '<button type="button" class="tag-add" data-shared-tag-add="1" title="Add tag" aria-label="Add tag">+</button>';
  tagList.innerHTML = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') + addTagButton;
}

// Shared-note tags live in the Yjs doc (a Y.Array) so they sync live to every
// member; the encrypted note meta mirrors them for the Shared list.
export function sharedTagList() {
  if (!state.collab.noteId || !state.collab.tags) return [];
  try { return state.collab.tags.toArray().filter((x) => typeof x === 'string').slice(0, 20); } catch (error) { return []; }
}

// Aggregate every tag with a note count (case-insensitive; first casing wins).
// User-created tags with no notes yet are included with a count of 0.
export function allTagCounts() {
  const map = new Map();
  state.notes.forEach((note) => {
    (Array.isArray(note.tags) ? note.tags : []).forEach((tag) => {
      const key = String(tag).toLowerCase();
      const entry = map.get(key);
      if (entry) entry.count += 1;
      else map.set(key, { label: String(tag), count: 1 });
    });
  });
  state.knownTags.forEach((tag) => {
    const key = String(tag).toLowerCase();
    if (key && !map.has(key)) map.set(key, { label: String(tag), count: 0 });
  });
  return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function removeNoteTag(note, name) {
  const at = noteTagIndex(note, name);
  if (at === -1) return false;
  note.tags.splice(at, 1);
  return true;
}

export function addNoteTag(note, name) {
  const tag = normalizeTagName(name);
  if (!note || !tag) return false;
  if (!Array.isArray(note.tags)) note.tags = [];
  if (noteTagIndex(note, tag) !== -1) return false;
  if (note.tags.length >= 20) { showToast('Tag limit reached (20 per note)'); return false; }
  note.tags.push(tag);
  return true;
}

export function noteTagIndex(note, name) {
  const wanted = normalizeTagName(name).toLowerCase();
  return (Array.isArray(note.tags) ? note.tags : []).findIndex((tag) => String(tag).toLowerCase() === wanted);
}

export function normalizeTagName(name) {
  return String(name == null ? '' : name).replace(/\s+/g, ' ').trim().slice(0, 40);
}

// User-created tags that may not be attached to any note yet (Settings → Tags).
export function cleanTagList(value) {
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


export function tagEditorRemove(name) {
  if (state.tagEditorShared) {
    if (!state.collab.noteId || !state.collab.tags) return;
    const list = sharedTagList();
    const at = list.findIndex((t) => String(t).toLowerCase() === String(name).toLowerCase());
    if (at === -1) return;
    state.collab.tags.delete(at, 1);
    renderTagEditor();
    return;
  }
  const note = state.notes.find((item) => item.id === state.tagEditorNoteId);
  if (!note) return;
  if (removeNoteTag(note, name)) {
    refreshTagsAcrossUi();
    renderTagEditor();
    renderSettingsTags();
  }
}

export function tagEditorAdd(raw) {
  const tag = normalizeTagName(raw);
  if (!tag) return;
  if (state.tagEditorShared) {
    if (!state.collab.noteId || !state.collab.tags) return;
    const list = sharedTagList();
    if (list.some((t) => String(t).toLowerCase() === tag.toLowerCase())) return;
    if (list.length >= 20) { showToast('Tag limit reached (20 per note)'); return; }
    state.collab.tags.push([tag]);
    renderTagEditor();
    return;
  }
  const note = state.notes.find((item) => item.id === state.tagEditorNoteId);
  if (!note) return;
  if (addNoteTag(note, raw)) {
    refreshTagsAcrossUi();
    renderTagEditor();
    renderSettingsTags();
  }
}

// Create a standalone tag (available to every note's tag editor and to search).
export function addKnownTag(raw) {
  const tag = normalizeTagName(raw);
  if (!tag) { showToast('Enter a tag name'); return false; }
  if (state.knownTags.some((entry) => entry.toLowerCase() === tag.toLowerCase())) { showToast(`Tag “${tag}” already exists`); return false; }
  if (state.knownTags.length >= 500) { showToast('Tag limit reached (500)'); return false; }
  state.knownTags.push(tag);
  persistUiVault();
  try { renderSettingsTags(); } catch (error) {}
  try { renderTagEditor(); } catch (error) {}
  showToast(`Tag “${tag}” added`);
  return true;
}

// Delete a tag from every note.
export function deleteTagEverywhere(name) {
  const key = normalizeTagName(name).toLowerCase();
  let changed = 0;
  state.notes.forEach((note) => {
    if (!Array.isArray(note.tags)) return;
    const before = note.tags.length;
    note.tags = note.tags.filter((tag) => String(tag).toLowerCase() !== key);
    if (note.tags.length !== before) changed += 1;
  });
  const hadKnown = state.knownTags.some((tag) => String(tag).toLowerCase() === key);
  if (hadKnown) {
    state.knownTags = state.knownTags.filter((tag) => String(tag).toLowerCase() !== key);
    persistUiVault();
  }
  if (changed) refreshTagsAcrossUi();
  return changed > 0 || hadKnown;
}

// Rename a tag on every note (folds duplicates created by the rename).
export function renameTagEverywhere(oldName, rawNew) {
  const from = normalizeTagName(oldName).toLowerCase();
  const to = normalizeTagName(rawNew);
  if (!from || !to || from === to.toLowerCase()) return false;
  let changed = 0;
  state.notes.forEach((note) => {
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
  const hadKnown = state.knownTags.some((tag) => String(tag).toLowerCase() === from);
  state.knownTags = cleanTagList(state.knownTags.map((tag) => (String(tag).toLowerCase() === from ? to : tag)));
  if (changed || hadKnown) persistUiVault();
  return changed > 0 || hadKnown;
}

export function refreshTagsAcrossUi() {
  persistNotes();
  renderNoteList();
  const open = activeEditorNote();
  if (open) updateMeta(open);
}
