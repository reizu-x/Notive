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
