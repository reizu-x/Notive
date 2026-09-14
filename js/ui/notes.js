// js/ui/notes.js — per-note helpers: note-object type/folder plumbing,
// search matching, filing checks; pairs with device-envelope sync.

import { isRecentNote } from '../core/dates.js';
import { isFolderOrSub } from '../core/paths.js';
import { EXT_MIME, migrateNote, sanitizeFilename } from '../core/schema.js';
import { e2ee, e2eeEncryptNotes } from '../data/crypto.js';
import { currentVaultBlobs } from '../data/vault.js';
import { IMPORTANT_TAG, WELCOME_FOLDERS, WELCOME_SECTION_ID } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { accountScopeKey } from './auth.js';
import { setSaveLabel, syncAgoText } from './feedback.js';
import { refreshEditorLock, uiSnapshot } from './misc.js';
import { showToast } from './modal.js';
import { customNoteFolder } from './sections.js';
import { BIN_RETENTION_MS } from '../core/dates.js';
import { allCount, breadcrumbTitle, editorToolbar, listEmpty, markdownInput, noteList, preview, recentCountEl, starredCountEl, tagList, titleInput, totalCount, wordCount } from '../core/elements.js';
import { icon } from '../core/icons.js';
import { isValidNoteId, newNoteId } from '../core/ids.js';
import { folderDepth, folderIconForDepth, folderLeaf, folderParent } from '../core/paths.js';
import { normalizeExt, parseTitleExtension, sanitizeIngredients, sanitizeSteps } from '../core/schema.js';
import { escapeHtml } from '../core/strings.js';
import { apiFetch } from '../data/api.js';
import { applyTextDiff, closeCollabNote, renderSharedView, scheduleCollabMeta } from '../data/collab-crypto.js';
import { e2eeDecryptPayload } from '../data/crypto.js';
import { cleanVaultFolders, decryptAllVaultBlobs, validVaultBlob } from '../data/vault.js';
import { NOTE_TEMPLATES } from '../domain/constants.js';
import { exitCoverRepos, renderCover, renderPreview, renderRecipeHero, resetIdleTimer } from './editor.js';
import { binRemainingText, noteGlyphFor } from './feedback.js';
import { openDeleteConfirm, openPermanentDeleteConfirm, uniqueTitle, updateListHeading, updateMeta } from './misc.js';
import { applyUiSnapshot, openTemplatePicker, startTreeRename } from './notes-core.js';
import { addFolderToSection, clearSectionSelection, openFolderPicker, persistCollapsedFolders, persistDeletedCustomSections, pruneDeletedCustomSections, renderCustomSections, reviveSectionsForNote, sectionDisplayName, selectCustomSection, startSectionRename, syncCustomSections, updateFoldToggle } from './sections.js';
import { seedFromTemplate, welcomeSeedNotes, welcomeSeedUi } from './shell.js';
import { enableNoteDragDrop, renderStripItems, renderTabs, trackTab, updateBreadcrumbs } from './tabs.js';
import { openTagEditor } from './tags.js';
import { renderVaultList, saveVaultNote, updateVaultUI, writeUiVaultLocal } from './vault.js';

// Export every plainWorkspace note (and unlocked Vault notes) as one JSON
// backup file in the browser's download folder — the "desktop copy".
export function exportAllNotes() {
  if (!state.cachedProfile || !state.notesLoaded) { showToast('Log in first'); return; }
  const payload = {
    app: 'Notely',
    version: 2,
    exportedAt: new Date().toISOString(),
    notes: state.notes.map((note) => ({ ...note })),
  };
  if (state.vault.unlocked && state.vault.notes.length) {
    payload.vaultNotes = state.vault.notes.map((note) => ({ ...note, vault: true }));
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

// Show a transient bottom-right status message (single timer, latest wins).
// In-app input prompt (replaces window.prompt everywhere: native prompts are
// unmasked plaintext, unstyled, and block automation/testing). One-shot
// promise: resolves the typed string, or null on cancel/Esc/overlay click.
// A second call while open resolves the first waiter with null.
// True when the open note is not Markdown (formatting tools stay disabled).
export function isPlainTextNote() {
  const note = activeEditorNote();
  return note && note.ext !== 'md';
}

// Popup: permanently erase the whole Bin (shows the doomed count).
export function openEmptyBinConfirm() {
  const count = state.notes.filter((item) => item.deleted).length;
  if (!count) { showToast('Bin is already empty'); return; }
  state.pendingDeleteId = '__ALL__';
  state.pendingDeleteMode = 'empty';
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

// Fill the shared in-app confirm popup (eyebrow/title/name/message). Name is set via textContent — never HTML.
export function setDeleteDialog({ eyebrow, title, name, message }) {
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

export function downloadNoteById(id) {
  downloadNoteObject(state.notes.find((item) => item.id === id));
}

// Download one note with a sanitized filename and matching MIME type.
export function downloadNoteObject(note) {
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

// Show the right-click menu at the cursor: per-state item visibility (deleted/archived/live) with viewport clamping.
export function openNoteContextMenu(noteId, x, y) {
  const menu = getNoteContextMenu();
  const note = state.notes.find((item) => item.id === noteId);
  if (!menu || !note) return;
  state.contextMenuNoteId = noteId;
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

// Hide the right-click menu and forget its target note.
export function closeNoteContextMenu() {
  const menu = getNoteContextMenu();
  if (menu) menu.hidden = true;
  state.contextMenuNoteId = null;
}

export function getNoteContextMenu() {
  return document.getElementById('note-context-menu');
}

// True when a note carries the important tag (case-insensitive).
export function isImportant(note) {
  return Boolean(note && Array.isArray(note.tags) && note.tags.some((tag) => String(tag).toLowerCase() === IMPORTANT_TAG));
}

// Selected note, falling back to the first note (may be undefined when empty — callers must guard).
export function currentNote() {
  return state.notes.find((note) => note.id === state.currentId) || state.notes[0];
}

// Swap New/Import vs Empty-Bin buttons per view, then refresh the lock state.
export function updateBinUI() {
  const inBin = state.activeView === 'bin';
  const emptyBinBtn = document.getElementById('empty-bin');
  if (emptyBinBtn) emptyBinBtn.hidden = !inBin;
  refreshEditorLock();
}

// Notes in the current view + selected folder, ignoring the search box and
// the All/Recent/Starred chip — so the chips mirror the selected folder.
export function scopeNotes() {
  if (state.activeView === 'vault') return state.vault.unlocked ? [...state.vault.notes] : [];
  if (state.activeView === 'shared') return [];
  return state.notes.filter((note) => {
    const isDeleted = Boolean(note.deleted);
    const isArchived = Boolean(note.archived);
    if (state.activeView === 'bin') {
      if (!isDeleted) return false;
    } else {
      if (isDeleted) return false;
      if (state.activeView === 'archive') {
        if (!isArchived) return false;
      } else if (isArchived) {
        return false;
      }
    }
    if (state.activeCustom) {
      const customFolder = customNoteFolder(note, state.activeCustom.section);
      if (customFolder === null) return false;
      if (state.activeCustom.folder && !isFolderOrSub(customFolder, state.activeCustom.folder)) return false;
    }
    return true;
  });
}

// Sidebar search. Plain terms match file text (title + contents) and folder
// names only — tags are excluded. `tag: <name>` matches tags and `body: <text>`
// matches the note body. Terms are AND-ed.
export function noteMatchesSearch(note, query) {
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

// Master list filter: Bin vs live, archive rules, search text, chip filter, selected collection.
export function visibleNotes() {
  if (state.activeView === 'vault' || state.activeView === 'shared') return [];
  return state.notes.filter((note) => {
    const isDeleted = Boolean(note.deleted);
    const isArchived = Boolean(note.archived);
    if (state.activeView === 'bin') {
      if (!isDeleted) return false;
    } else {
      if (isDeleted) return false;
      if (state.activeView === 'archive') {
        if (!isArchived) return false;
      } else {
        // notes / favorites views hide archived items; Archive has its own view.
        if (isArchived) return false;
      }
    }
    const matchesSearch = noteMatchesSearch(note, state.searchQuery);
    const matchesFilter = state.activeFilter === 'all' || (state.activeFilter === 'favorites' && note.favorite) || (state.activeFilter === 'recent' && isRecentNote(note));
    const matchesCustom = !state.activeCustom || (customNoteFolder(note, state.activeCustom.section) !== null
      && (!state.activeCustom.folder || isFolderOrSub(customNoteFolder(note, state.activeCustom.section), state.activeCustom.folder)));
    return matchesSearch && matchesFilter && matchesCustom;
  });
}

// Clear the search box and its in-memory query.
export function clearSearch() {
  state.searchQuery = '';
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = '';
}

// ---- Folder-required invariant: a note never lives outside the sections ----
// Every entry path funnels through here. A note with no valid filing is
// placed into the first folder of the first section (creating the default
// "Notes" section when the workspace has none), so unfiled notes cannot
// exist. Returns true when the note was refiled.
export function ensureNoteFiled(note) {
  if (!note || note.deleted) return false;
  if (note.sections && typeof note.sections === 'object') {
    for (const [secId, folder] of Object.entries(note.sections)) {
      if (typeof folder !== 'string' || !folder.trim()) continue;
      const section = state.customSections.find((entry) => entry.id === secId);
      if (section && section.folders.includes(folder)) return false; // validly filed
    }
    // Filings exist but all stale: drop them so re-filing picks a fresh home.
    const stale = Object.entries(note.sections).filter(([, folder]) => typeof folder !== 'string' || !folder.trim()
      || !state.customSections.some((entry) => entry.id && entry.folders.includes(folder)));
    if (stale.length === Object.keys(note.sections).length) note.sections = {};
  }
  // Resolve a destination: first folder of the first section; else create
  // the default section (welcome seed shape) so the note always has a home.
  let target = state.customSections.find((entry) => entry.folders.length);
  if (!target) {
    target = { id: WELCOME_SECTION_ID, name: 'Notes', folders: [...WELCOME_FOLDERS] };
    state.customSections.unshift(target);
  }
  note.sections = { [target.id]: target.folders[0] };
  return true;
}

export function firstFilingOf(note) {
  if (note && note.sections && typeof note.sections === 'object') {
    const first = Object.values(note.sections).find((value) => typeof value === 'string' && value);
    if (first) return first;
  }
  return null;
}

// ---- Save-state light ----
// One helper drives the topbar indicator: dot colour (green synced / gray
// offline / red error) plus label text. Sync timestamps feed the
// "Synced X min ago" wording and a ticker keeps it current.
export function markSynced() {
  state.lastSyncedAt = Date.now();
  setSaveLabel(syncAgoText(), 'green');
}

// Encrypted local save in device-only mode: same E2EE payload the server
// would get, parked in this browser's per-account slot.
export async function saveNotesToDevice() {
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

// Build the outgoing workspace envelope (notes + vault ciphertext + UI state)
// shared by server sync and device-only saves.
export async function buildNotesEnvelope() {
  const envelope = { v: 2, notes: state.notes, vault: await currentVaultBlobs(), vaultFolders: [...state.vault.folders] };
  try {
    if (typeof uiSnapshot === 'function') envelope.ui = uiSnapshot();
  } catch (error) {}
  return envelope;
}

export function setDeviceOnlyPref(on) {
  try {
    if (on) localStorage.setItem(deviceOnlyKey(), '1');
    else localStorage.removeItem(deviceOnlyKey());
  } catch (error) {}
}

export function deviceOnlyPref() {
  try { return localStorage.getItem(deviceOnlyKey()) === '1'; } catch (error) { return false; }
}

export function localNotesKey() { return accountScopeKey('notely-local-notes'); }

export function deviceOnlyKey() { return accountScopeKey('notely-device-only'); }

// The note the editor is bound to, whether it lives in the workspace or the
// unlocked Vault. Editor chrome (favorite/share/type/download/preview) goes
// through this so vault notes behave like normal ones.
export function activeEditorNote() {
  if (state.activeView === 'vault') {
    if (!state.vault.unlocked || !state.currentVaultId) return null;
    return state.vault.notes.find((item) => item.id === state.currentVaultId) || null;
  }
  return currentNote();
}

// Delete legacy plaintext note keys after server migration (CWE-312: no plaintext notes lingering on disk).
export function wipeLegacyLocalNotes() {
  try {
    localStorage.removeItem('notely-notes');
    localStorage.removeItem('quietly-notes');
  } catch (error) {}
}

// One-time read of pre-server localStorage note keys. Returns null when absent or invalid.
export function readLegacyLocalNotes() {
  try {
    const raw = JSON.parse(localStorage.getItem('notely-notes') || localStorage.getItem('quietly-notes') || 'null');
    if (!Array.isArray(raw) || !raw.length) return null;
    return raw.map(migrateNote).slice(0, 2000);
  } catch (error) {
    return null;
  }
}


// + New note entry: a bare section view (no folder picked) asks for the
// destination folder first, so the note lands where the user wants. A section
// with no folders yet cannot file anything — say so instead of silently
// creating an invisible note.
export function onNewNoteClick() {
  state.pendingSectionFolder = null;
  state.pendingTemplate = null;
  if (state.activeCustom && !state.activeCustom.folder) {
    const section = state.customSections.find((entry) => entry.id === state.activeCustom.section);
    if (section && !section.folders.length) {
      showToast(`Create a folder in ${section.name} first`);
      return;
    }
    if (openFolderPicker('custom', state.activeCustom.section)) return;
  }
  openTemplatePicker();
}

// Shortcut for a blank Standard note.
export function addNote() {
  createNoteFromTemplate('standard');
}

// Create a note from a template (Standard/Recipe/To-Do) into the current view+collection and open it.
export function createNoteFromTemplate(templateKey) {
  const template = NOTE_TEMPLATES[templateKey] || NOTE_TEMPLATES.standard;
  if (state.activeView === 'bin') {
    state.activeView = 'notes';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
    updateListHeading();
  }
  const id = newNoteId();
  const title = uniqueTitle(template.titleBase);
  const tags = [...template.tags];
  // Filing follows the workspace: a picked folder files the note there; a bare
  // section view asks first (state.pendingSectionFolder), falling back to the
  // section's first folder only when the picker had nothing to offer.
  const picked = state.pendingSectionFolder;
  state.pendingSectionFolder = null;
  // A picked folder always wins when it still exists (covers both the
  // bare-section flow and the folder-required gate resume, where the active
  // view may be a different section or none at all). Stale picks (folder
  // deleted since) fall through to the normal resolution below.
  const pickedSection = picked && picked.ns === 'custom'
    ? state.customSections.find((entry) => entry.id === picked.section) : null;
  const pickedFolder = pickedSection && typeof picked.folder === 'string'
    && pickedSection.folders.includes(picked.folder) ? picked.folder : null;
  const customSection = state.activeCustom ? state.customSections.find((entry) => entry.id === state.activeCustom.section) : null;
  // No active folder context (e.g. All notes): inherit filing from the open
  // note so the new note lands next to it instead of staying unfiled.
  // Only live locations count — binned/deleted/removed folders are skipped.
  const inheritSections = {};
  if (!state.activeCustom && state.currentId) {
    const openNote = state.notes.find((entry) => entry.id === state.currentId);
    if (openNote) {
      if (openNote.sections && typeof openNote.sections === 'object') {
        for (const secId of Object.keys(openNote.sections)) {
          const folder = openNote.sections[secId];
          if (typeof folder !== 'string' || !folder) continue;
          const sec = state.customSections.find((entry) => entry.id === secId);
          if (sec && sec.folders.includes(folder)) inheritSections[secId] = folder;
        }
      }
    }
  }
  const customFolder = pickedFolder
    || (state.activeCustom && state.activeCustom.folder)
    || (customSection && customSection.folders.length ? customSection.folders[0] : null);
  const filedSections = (pickedFolder && pickedSection) ? { [pickedSection.id]: pickedFolder }
    : (state.activeCustom && customFolder) ? { [state.activeCustom.section]: customFolder } : inheritSections;
  // Folder-required rule: a note must land in a folder or subfolder. If no
  // filing resolved above, park the template choice and ask for a
  // destination first — creation resumes after the pick. A workspace with no
  // folders at all cannot file anything: say so instead of silently
  // creating an unfiled note.
  if (!customFolder && !Object.values(filedSections).some((value) => typeof value === 'string' && value)) {
    state.pendingTemplate = templateKey;
    if (!openFolderPicker()) {
      state.pendingTemplate = null;
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
  state.notes.unshift(note);
  state.activeFilter = 'all';
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  // A stale search query must never swallow the brand-new note.
  clearSearch();
  state.currentId = id;
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

// Detect a trailing file extension typed in the title and switch the note type instead.
// Persist title/body from the editor (debounced server sync); refuses deleted/archived notes.
export function saveCurrentNote() {
  // Shared (collaborative) note: edits go to the Yjs doc, not to a local note.
  if (state.collab.noteId && state.collab.title && state.collab.body) {
    applyTextDiff(state.collab.title, state.collab.title.toString(), String(titleInput.value || '').slice(0, 200));
    applyTextDiff(state.collab.body, state.collab.body.toString(), String(markdownInput.value || ''));
    if (state.collab.desc && state.collab.template === 'recipe') {
      const descEl = document.getElementById('recipe-desc');
      applyTextDiff(state.collab.desc, state.collab.desc.toString(), descEl && typeof descEl.value === 'string' ? descEl.value.slice(0, 2000) : '');
    }
    scheduleCollabMeta();
    return;
  }
  if (state.activeView === 'vault') { saveVaultNote(); return; }
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
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 450);
  resetIdleTimer();
}

// Delegated right-click handling on the note list; closes on outside click, resize, scroll and Escape.
export function bindNoteContextMenu() {
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
    const id = state.contextMenuNoteId;
    closeNoteContextMenu();
    handleNoteMenuAction(action, id);
  });
  document.addEventListener('click', (event) => {
    if (state.contextMenuNoteId && !event.target.closest('#note-context-menu')) closeNoteContextMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    if (state.contextMenuNoteId && !event.target.closest('#note-context-menu')) closeNoteContextMenu();
  });
  window.addEventListener('resize', closeNoteContextMenu);
  noteList.addEventListener('scroll', closeNoteContextMenu);
}

// Keyboard-accessible delete: mirrors the context-menu rules exactly —
// binned notes ask for permanent-confirm, important-tagged notes ask for
// confirm, everything else soft-deletes straight into Bin.
export function requestDeleteNoteById(id) {
  if (!id || typeof id !== 'string' || !isValidNoteId(id)) return;
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  if (note.deleted) openPermanentDeleteConfirm(id);
  else if (isImportant(note)) openDeleteConfirm(id);
  else deleteNoteById(id);
}

// Dispatch a validated context-menu action; unknown ids/actions are ignored.
export function handleNoteMenuAction(action, id) {
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

// Permanently erase everything in Bin (notes + folder entries) after popup confirmation.
export function emptyBin() {
  const binned = state.notes.filter((item) => item.deleted);
  if (!binned.length) { showToast('Bin is already empty'); return; }
  state.notes = state.notes.filter((item) => !item.deleted);
  state.deletedCustomSections = [];
  persistDeletedCustomSections();
  const currentAlive = state.currentId && state.notes.some((item) => item.id === state.currentId);
  if (!currentAlive) {
    if (state.notes.length) selectNote(state.notes[0].id);
    else clearEditor();
  } else {
    renderNoteList();
  }
  persistNotes();
  renderNoteList();
  showToast(`Emptied Bin (${binned.length})`);
}

// Erase one binned note immediately; repairs the selection.
export function permanentlyDeleteNoteById(id) {
  const index = state.notes.findIndex((item) => item.id === id);
  if (index === -1) return;
  const wasCurrent = state.currentId === id;
  state.notes.splice(index, 1);
  if (wasCurrent) {
    const pool = state.activeView === 'bin' ? state.notes.filter((item) => item.deleted) : state.notes.filter((item) => !item.deleted);
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

// Return one archived note to All notes (refuses deleted notes) and re-sync the sidebar.
export function unarchiveNoteById(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note || note.deleted || !note.archived) return;
  note.archived = false;
  syncCustomSections();
  persistNotes();
  renderCustomSections();
  renderNoteList();
  showToast('Note unarchived');
}

// Move one live note to Archive; repairs the selection from the still-visible list.
export function archiveNoteById(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note || note.deleted || note.archived) return;
  note.archived = true;
  if (state.currentId === id) {
    const pool = visibleNotes().filter((item) => item.id !== id);
    if (pool.length) selectNote(pool[0].id);
    else clearEditor();
  }
  persistNotes();
  renderNoteList();
  showToast('Note archived');
}

// Restore one binned note; revives its folder too when the folder itself was binned.
export function restoreNoteById(id) {
  const note = state.notes.find((item) => item.id === id);
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
  if (state.activeView === 'bin') {
    const binned = state.notes.filter((item) => item.deleted);
    if (binned.length) selectNote(binned[0].id);
    else clearEditor();
    renderNoteList();
  } else {
    selectNote(id);
  }
  renderNoteList();
  showToast('Note restored');
}

// Soft-delete one note into Bin (sets deletedAt); repairs the selection to a neighbor.
export function deleteNoteById(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note || note.deleted) return;
  const liveBefore = state.notes.filter((item) => !item.deleted);
  const pos = liveBefore.findIndex((item) => item.id === id);
  note.deleted = true;
  note.deletedAt = Date.now();
  if (state.currentId === id) {
    const liveAfter = state.notes.filter((item) => !item.deleted);
    if (liveAfter.length) selectNote(liveAfter[Math.min(Math.max(pos, 0), liveAfter.length - 1)].id);
    else clearEditor();
  } else {
    renderNoteList();
  }
  persistNotes();
  renderNoteList();
  showToast('Moved to Bin — kept for 3 days');
}

// Empty the editor for the no-notes state and re-render.
export function clearEditor() {
  exitCoverRepos(true);
  state.currentId = null;
  state.currentVaultId = null;
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

// Flip the star flag and refresh badges, counts and list.
export function toggleFavoriteById(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  note.favorite = !note.favorite;
  if (id === state.currentId) updateMeta(note);
  persistNotes();
  renderNoteList();
  showToast(note.favorite ? 'Added to favorites' : 'Removed from favorites');
}

// Copy a note (fresh id, unique title, reset dates/flags) right after the original and open it.
export function duplicateNoteById(id) {
  const original = state.notes.find((item) => item.id === id);
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
  const index = state.notes.findIndex((item) => item.id === id);
  state.notes.splice(index + 1, 0, copy);
  state.currentId = copy.id;
  selectNote(copy.id);
  persistNotes();
  renderNoteList();
  showToast('Note duplicated');
}

// Add/remove the important tag; important notes require popup confirmation before deletion.
export function toggleImportantById(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  if (!Array.isArray(note.tags)) note.tags = [];
  if (isImportant(note)) {
    note.tags = note.tags.filter((tag) => String(tag).toLowerCase() !== IMPORTANT_TAG);
    showToast('Removed important tag');
  } else {
    note.tags = [...note.tags, IMPORTANT_TAG];
    showToast('Marked as important');
  }
  if (id === state.currentId) updateMeta(note);
  persistNotes();
  renderNoteList();
}

// Debounced save: refuses (with a warning, never truncates) past 2000 notes, then syncs encrypted to the server.
export function persistNotes() {
  if (state.notes.length > 2000) {
    // Never silently truncate: refusing to sync preserves data locally until
    // the user deletes notes; the server would reject oversized payloads.
    setSaveLabel('Sync failed', 'red');
    showToast('Too many notes to sync (2000 max) — delete some to keep saving');
    clearTimeout(state.saveTimer);
    return;
  }
  setSaveLabel('Saving...', 'green');
  clearTimeout(state.syncTimer);
  state.syncTimer = setTimeout(() => { syncNotesToServer(); }, 450);
}

// Open a note in the editor and re-render the list; lock state is reapplied afterwards.
// Every note opens in PREVIEW mode (edit mode never carries over between
// notes); clicking/focusing the preview switches that note to edit mode.
export function selectNote(id) {
  if (state.collab.noteId) closeCollabNote();
  exitCoverRepos(true);
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  trackTab(id, false);
  state.currentId = id;
  state.currentVaultId = null;
  document.querySelector('.app-shell').classList.remove('workspace-focus');
  state.writeMode = 'preview';
  clearTimeout(state.idleTimer);
  titleInput.value = typeof note.title === 'string' ? note.title : 'Untitled note';
  markdownInput.value = typeof note.body === 'string' ? note.body : '';
  breadcrumbTitle.textContent = note.title;
  renderCover(note);
  renderPreview(note);
  updateMeta(note);
  renderNoteList();
  refreshEditorLock();
}

// Render the grouped note tree: folder ordering, collapse, Bin actions vs rename pencil, scoped counters, and per-row event wiring.
export function renderNoteList() {
  const sharedNewBtn = document.getElementById('shared-new');
  if (sharedNewBtn) sharedNewBtn.hidden = true;
  const refreshBtnTop = document.getElementById('refresh-view');
  if (refreshBtnTop) refreshBtnTop.hidden = true; // Refresh lives only in Shared.
  if (state.activeView === 'vault') { renderVaultList(); renderTabs(); renderStripItems(); return; }
  if (state.activeView === 'shared') { renderSharedView(); renderTabs(); renderStripItems(); updateFoldToggle(); return; }
  const visible = visibleNotes();
  const searching = state.searchQuery.trim() !== '';
  // Grouping follows the active folder namespace: custom-section paths when one
  // of those is selected, otherwise each note's first filing. The
  // folder-required invariant guarantees every note has a filing.
  const groupKeyOfNote = (note) => {
    if (state.activeCustom) return customNoteFolder(note, state.activeCustom.section);
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
  state.notes.forEach((note, index) => { if (!orderOf.has(note.id)) orderOf.set(note.id, index); });
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
    for (const section of state.customSections) {
      const at = section.folders.indexOf(folder);
      if (at !== -1) return { section: section.id, index: at };
    }
    for (const section of state.customSections) {
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
    const isCollapsed = !searching && state.collapsedFolders.has(folder);
    const folderActions = state.activeView === 'bin'
      ? ''
      : `<button type="button" class="tree-rename" data-folder-rename="${escapeHtml(folder)}" title="Rename folder" aria-label="Rename ${escapeHtml(folder)}">${icon('pencil')}</button>`;
    const childrenHtml = node.children.slice().sort(byManualOrder).map(renderFolderNode).join('');
    return `
    <div class="tree-folder-wrap${isCollapsed ? ' closed' : ''}" data-folder-wrap="${escapeHtml(folder)}">
      <div class="tree-folder-row">
        <button class="tree-folder" data-folder="${escapeHtml(folder)}" aria-expanded="${isCollapsed ? 'false' : 'true'}" title="${escapeHtml(folder)}${state.activeView === 'bin' ? '' : ' — double-click to rename'}">
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
        <button class="tree-file${note.id === state.currentId ? ' selected' : ''}" data-note-id="${escapeHtml(String(note.id))}" title="${escapeHtml(note.title || 'Untitled note')}">
          <span class="tree-file-icon tree-file-icon-${note.ext}">${icon(noteGlyphFor(note))}</span>
          <span class="tree-file-name">${escapeHtml(note.title || 'Untitled note')}</span>
          ${state.activeView === 'bin' ? `<span class="bin-meta">${binRemainingText(note)}</span>` : ''}
          ${note.favorite && state.activeView !== 'bin' ? `<span class="mini-star">${icon('star')}</span>` : ''}
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
        ${state.activeView === 'bin' ? '' : `<button type="button" class="list-section-add" data-section-add="${escapeHtml(id || '')}" title="Add folder to ${escapeHtml(title)}" aria-label="Add folder to ${escapeHtml(title)}">${icon('folder-plus')}</button>`}
        <button type="button" class="list-section-rename" data-section-rename="${kind}" data-section-id="${escapeHtml(id || '')}" title="Rename section" aria-label="Rename ${escapeHtml(title)}">${icon('pencil')}</button>
      </div>
      ${renderFolderGroups(groupsMap)}
    </div>`;
  };
  // Home-like views (no folder/search/chip filter) separate folders by
  // section to mirror the slide menu; everything else keeps the flat tree.
  const homeLike = state.activeView === 'notes' && state.activeFilter === 'all' && !searching
    && !(state.activeCustom && state.activeCustom.folder);
  if (homeLike) {
    const parts = [];
    const customTargets = state.activeCustom && !state.activeCustom.folder
      ? state.customSections.filter((section) => section.id === state.activeCustom.section)
      : ((!state.activeCustom) ? state.customSections : []);
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
  const inBin = state.activeView === 'bin';
  listEmpty.hidden = visible.length !== 0;
  noteList.hidden = visible.length === 0;
  const emptyTitle = listEmpty.querySelector('strong');
  const emptySub = listEmpty.querySelector('span:last-child');
  if (emptyTitle) emptyTitle.textContent = inBin ? 'Bin is empty' : 'No notes found';
  if (emptySub) emptySub.textContent = inBin ? 'Deleted notes stay here for 3 days before they are permanently removed.' : 'Try another search or create a new note.';
  const liveNotes = state.notes.filter((note) => !note.deleted && !note.archived);
  const archivedNotes = state.notes.filter((note) => !note.deleted && note.archived);
  const binnedNotes = state.notes.filter((note) => note.deleted);
  const scope = scopeNotes();
  if (allCount) allCount.textContent = scope.length;
  if (recentCountEl) recentCountEl.textContent = scope.filter((note) => isRecentNote(note)).length;
  if (starredCountEl) starredCountEl.textContent = scope.filter((note) => note.favorite).length;
  const activeContextName = (state.activeCustom ? (state.activeCustom.folder || sectionDisplayName('custom', state.activeCustom.section)) : null);
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
    if (state.collapsedFolders.has(folder)) state.collapsedFolders.delete(folder);
    else state.collapsedFolders.add(folder);
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
    if (state.activeView === 'bin') return;
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

// Breadcrumb home: reset to All notes with nothing open and an enlarged
// workspace (editor hidden). Selecting any note exits the enlarged mode.
export function goAllNotes() {
  clearSectionSelection();
  state.activeView = 'notes';
  state.activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  state.currentId = null;
  state.currentVaultId = null;
  clearEditor();
  document.querySelector('.app-shell').classList.add('workspace-focus');
  renderCustomSections();
  renderNoteList();
}

// Sweep every live note through the invariant (boot, import, restore, sync).
export function enforceFilingInvariant() {
  let changed = false;
  state.notes.forEach((note) => { if (ensureNoteFiled(note)) changed = true; });
  if (changed) {
    persistNotes();
    renderCustomSections();
    renderNoteList();
  }
  return changed;
}

// Permanently drop notes/sections past the 3-day retention; repairs tampered timestamps; drops section entries with no binned notes left.
export function purgeExpiredBin() {
  const now = Date.now();
  let changed = false;
  state.notes.forEach((note) => {
    // Repair tampered timestamps: future or non-finite values reset to now.
    if (note.deleted && (typeof note.deletedAt !== 'number' || !Number.isFinite(note.deletedAt) || note.deletedAt > now)) {
      note.deletedAt = now;
      changed = true;
    }
  });
  const before = state.notes.length;
  state.notes = state.notes.filter((note) => !(note.deleted && typeof note.deletedAt === 'number' && now - note.deletedAt > BIN_RETENTION_MS));
  if (state.notes.length !== before) changed = true;
  const sectionsBefore = (state.deletedCustomSections || []).length;
  state.deletedCustomSections = (state.deletedCustomSections || []).filter((entry) => (
    now - entry.deletedAt <= BIN_RETENTION_MS
    && state.notes.some((note) => note.deleted && note.sections
      && typeof note.sections === 'object' && customNoteFolder(note, entry.id) !== null)
  ));
  if (state.deletedCustomSections.length !== sectionsBefore) changed = true;
  if (changed) {
    persistDeletedCustomSections();
    persistNotes();
  }
  return changed;
}

// Boot/load path: decrypts the server E2EE blob; adopts a legacy plaintext-shape row once; brand-new accounts start empty (updated_at distinguishes); offline falls back to the legacy local copy.
// The envelope is a bare array (very old), {v:1, notes, vault} (E2EE notes
// only) or {v:2, notes, vault, ui} (notes + per-account sidebar state). When
// the server carries UI state it wins over any device-local copy.
export async function loadNotesFromServer() {
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
      if (data && typeof data.updated_at === 'number') state.serverNotesVersion = data.updated_at;
    } catch (error) {}
    if (data && data.payload) {
      // E2EE blob: only this device can read it. Envelope is either a legacy
      // bare notes array or {v, notes, vault} (vault items stay ciphertext).
      await adoptNotesEnvelope(await e2eeDecryptPayload(data.payload));
    } else if (Array.isArray(data.notes) && (data.notes.length || data.updated_at)) {
      // Legacy plaintext-shape response (pre-E2EE row): adopt, then the next
      // debounced save re-uploads it encrypted.
      state.notes = data.notes.map(migrateNote).slice(0, 2000);
      state.vault.blobs = [];
      state.vault.folders = [];
      await syncNotesToServer();
    } else {
      // Brand-new account: no server blob, no notes row. Seed the onboarding
      // workspace (Notes section, General/Personal folders, welcome notes).
      // Only genuine legacy local data (pre-server version) is migrated on top.
      const legacy = readLegacyLocalNotes();
      state.notes = (legacy && legacy.length ? legacy : welcomeSeedNotes()).slice(0, 2000);
      state.vault.blobs = [];
      state.vault.folders = [];
      if (!legacy || !legacy.length) applyUiSnapshot(welcomeSeedUi());
      await syncNotesToServer();
      wipeLegacyLocalNotes();
    }
    state.notesLoaded = true;
  } catch (error) {
    const legacy = readLegacyLocalNotes();
    state.notes = legacy || [];
    state.notesLoaded = true;
    showToast('Cannot reach the Notely server — working offline');
  }
}

// Immediate (non-debounced) upload used by logout/unload so the last edits
// are never stranded in a cancelled timer.
export async function flushNotesToServer() {
  clearTimeout(state.syncTimer);
  await syncNotesToServer();
}

// Debounced encrypted upload of the workspace (notes + vault ciphertext +
// per-account UI state). No-ops without a session; reports Locked when the
// vault is locked. The server stores the blob opaquely — UI folders/sections
// ride along so every account keeps its own sidebar across relogs/devices.
// Device-only mode redirects the same save into local storage instead.
export async function syncNotesToServer() {
  if (!state.cachedProfile) return;
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
    const response = await apiFetch('/api/notes', { method: 'PUT', body: JSON.stringify({ payload, baseVersion: state.serverNotesVersion }) });
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
      if (data && typeof data.updated_at === 'number') state.serverNotesVersion = data.updated_at;
    } catch (error) {}
    markSynced();
  } catch (error) {
    setSaveLabel('Sync failed', 'red');
  }
}

// Device-only boot: load from the encrypted local slot (onboarding workspace
// when the device copy is missing) without touching the server either way.
export async function loadNotesFromDevice() {
  try {
    const raw = localStorage.getItem(localNotesKey());
    if (raw) {
      const payload = JSON.parse(raw);
      await adoptNotesEnvelope(await e2eeDecryptPayload(payload));
      state.notesLoaded = true;
      setSaveLabel('Offline · loaded', 'gray');
      return;
    }
  } catch (error) {}
  state.notes = welcomeSeedNotes();
  applyUiSnapshot(welcomeSeedUi());
  state.vault.blobs = [];
  state.vault.folders = [];
  state.notesLoaded = true;
  setSaveLabel('Offline · saved', 'gray');
}

// Apply a decrypted {v,notes,vault,vaultFolders,ui} envelope (or legacy array)
// to live state. Shared by the server blob path and the device-only local path.
export async function adoptNotesEnvelope(envelope) {
  const list = Array.isArray(envelope) ? envelope
    : (envelope && Array.isArray(envelope.notes) ? envelope.notes : null);
  if (!list) throw new Error('bad payload');
  state.notes = list.map(migrateNote).slice(0, 2000);
  const incomingBlobs = (!Array.isArray(envelope) && Array.isArray(envelope.vault))
    ? envelope.vault.filter(validVaultBlob).slice(0, 2000)
    : [];
  state.vault.blobs = incomingBlobs;
  try {
    state.vault.folders = (!Array.isArray(envelope) && envelope) ? cleanVaultFolders(envelope.vaultFolders) : [];
  } catch (error) { state.vault.folders = []; }
  if (state.vault.unlocked) {
    try { state.vault.notes = await decryptAllVaultBlobs(); }
    catch (error) { state.vault.notes = []; }
  }
  try {
    if (!Array.isArray(envelope) && envelope && envelope.ui && typeof applyUiSnapshot === 'function') {
      if (applyUiSnapshot(envelope.ui)) {
        state.serverUiLoaded = true;
        try { await writeUiVaultLocal(); } catch (error) {}
      }
    }
  } catch (error) {}
  // Folder-required invariant: nothing loads (or stays) unfiled.
  try { enforceFilingInvariant(); } catch (error) {}
}
