// js/ui/notes-core.js — the entangled workspace core: note selection/CRUD,
// list rendering + drag/drop, sections/folders flows, shared view and vault
// UI + the sync stack. Extracted as one hub because its internal call graph
// is mutually recursive; split per-subsystem in a later pass.

import { breadcrumbTitle, markdownInput, tagList, titleInput, wordCount } from '../core/elements.js';
import { folderLeaf, isFolderOrSub, joinLeafRename } from '../core/paths.js';
import { apiFetch } from '../data/api.js';
import { collabDeleteGroup, collabDeleteNote, renderSharedView, setSharedNavCount } from '../data/collab-crypto.js';
import { e2ee } from '../data/crypto.js';
import { COLLAPSED_FOLDERS_KEY, SECTION_DATA_KEY } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { showLogin } from './auth.js';
import { findTreeWrap } from './editor.js';
import { cleanUiSnapshot, closeDeleteConfirm, e2eeLock, renderTemplateOptions } from './misc.js';
import { showToast } from './modal.js';
import { addNote, clearEditor, deleteNoteById, emptyBin, flushNotesToServer, permanentlyDeleteNoteById, renderNoteList, wipeLegacyLocalNotes } from './notes.js';
import { deleteCustomFolder, deleteCustomSection, deleteSharedFolderNow, deleteVaultFolder, ensureMigratedCollectionsSection, renameFolderPath, renderCustomSections } from './sections.js';
import { applyProfile, applyTheme, clearSessionUnlock } from './shell.js';
import { cleanTagList, deleteTagEverywhere, renderSettingsTags } from './tags.js';
import { deleteVaultNote, renderVaultList, writeUiVaultLocal } from './vault.js';
// Server logout, then wipe keys/notes/editor/selection from memory and reset the UI to the gate.
// Pending edits are flushed to the server FIRST so nothing made in this
// session is lost by the relog. The per-account encrypted local cache is kept
// (it needs the master key to read); only legacy plaintext keys are removed.
export async function logout() {
  // Flush while still unlocked: local UI cache + server envelope (notes + UI).
  clearSessionUnlock();
  try {
    clearTimeout(state.uiVaultTimer);
    if (state.cachedProfile && e2ee.masterKey) {
      try { await writeUiVaultLocal(); } catch (error) {}
      try { await flushNotesToServer(); } catch (error) {}
    } else {
      clearTimeout(state.syncTimer);
    }
  } catch (error) {}
  try { await apiFetch('/api/logout', { method: 'POST' }); } catch (error) {}
  state.cachedProfile = null;
  state.profileAvatar = '';
  state.knownTags = [];
  setSharedNavCount(0);
  e2eeLock();
  // Wipe decrypted workspace: memory, editor DOM and any legacy local copy.
  state.notes = [];
  state.openTabs = [];
  state.notesLoaded = false;
  state.serverNotesVersion = 0;
  state.serverUiLoaded = false;
  state.currentId = null;
  state.currentVaultId = null;
  state.vault.unlocked = false;
  state.vault.dek = null;
  state.vault.notes = [];
  state.vault.blobs = [];
  state.vault.folders = [];
  state.vault.meta = null;
  state.activeView = 'notes';
  state.activeFilter = 'all';
  state.activeCustom = null;
  state.searchQuery = '';
  clearTimeout(state.syncTimer);
  try { clearTimeout(state.saveTimer); } catch (error) {}
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
  state.collapsedFolders = new Set();
  state.customSections = [];
  state.deletedCustomSections = [];
  state.activeCustom = null;
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

export function refreshCurrent() {
  // Refresh only the workspace sidebar (the notes list / Shared inbox).
  if (state.activeView === 'shared') { renderSharedView(); return; }
  if (state.activeView === 'vault') { renderVaultList(); return; }
  renderNoteList();
}

// Show the New-note template chooser popup.
export function openTemplatePicker() {
  const overlay = document.getElementById('template-overlay');
  if (!overlay) { addNote(); return; }
  renderTemplateOptions();
  overlay.hidden = false;
  const first = overlay.querySelector('.template-option');
  if (first) first.focus();
}

// Run the pending popup action: soft/permanent/empty/folder/folder-permanent.
export function confirmPendingDelete() {
  if (!state.pendingDeleteId) return;
  const id = state.pendingDeleteId;
  const mode = state.pendingDeleteMode;
  const sectionId = state.pendingDeleteSection;
  closeDeleteConfirm();
  if (mode === 'empty') emptyBin();
  else if (mode === 'permanent') permanentlyDeleteNoteById(id);
  else if (mode === 'vault-note') deleteVaultNote(id);
  else if (mode === 'vault-folder') deleteVaultFolder(id);
  else if (mode === 'custom-section') deleteCustomSection(id);
  else if (mode === 'custom-folder') deleteCustomFolder(sectionId, id);
  else if (mode === 'tag') { if (state.pendingDeleteTag) { deleteTagEverywhere(state.pendingDeleteTag); renderSettingsTags(); } }
  else if (mode === 'collab-note') { collabDeleteNote(id); }
  else if (mode === 'collab-group') { collabDeleteGroup(id); }
  else if (mode === 'shared-folder') { deleteSharedFolderNow(Number(id), sectionId); }
  else deleteNoteById(id);
}

// Inline rename for All-Notes folder headers; refused in Bin.
export function startTreeRename(folder) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  if (state.activeView === 'bin') return;
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
      if (state.activeCustom) sectionId = state.activeCustom.section;
      else {
        const shell = wrap.closest('[data-list-section]');
        const kind = shell ? shell.dataset.listSection : null;
        if (kind === 'custom') {
          const secBtn = shell.querySelector('[data-section-id]');
          if (secBtn && secBtn.dataset.sectionId) sectionId = secBtn.dataset.sectionId;
        }
      }
      if (!sectionId) {
        const owner = state.customSections.find((section) => section.folders.some((entry) => entry === folder || isFolderOrSub(entry, folder) || isFolderOrSub(folder, entry)));
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

// Apply a server/UI-vault snapshot to memory. Returns true when anything was adopted.
export function applyUiSnapshot(value) {
  const clean = cleanUiSnapshot(value);
  if (!clean) return false;
  let adopted = false;
  if (clean.collapsed !== null) { state.collapsedFolders = new Set(clean.collapsed); adopted = true; }
  if (clean.customSections) { state.customSections = clean.customSections; adopted = true; }
  if (clean.deletedCustomSections) { state.deletedCustomSections = clean.deletedCustomSections; adopted = true; }
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
    state.profileAvatar = clean.avatar;
    adopted = true;
    try { applyProfile(); } catch (error) {}
  }
  if (Array.isArray(clean.tags)) {
    state.knownTags = cleanTagList(clean.tags);
    adopted = true;
  }
  return adopted;
}
