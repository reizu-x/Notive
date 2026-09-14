// js/ui/vault.js — private-vault modal plumbing: open/close renders and
// lock-state banners. All modal state lives on the shared state object.

import { icon } from '../core/icons.js';
import { state } from '../domain/state.js';
import { apiFetch } from '../data/api.js';
import { e2ee, e2eeB64ToBytes, e2eeBytesToB64, e2eeRandomBytes } from '../data/crypto.js';
import { COLLAPSED_FOLDERS_KEY, UI_VAULT_KEY } from '../domain/constants.js';
import { showToast } from './modal.js';
import { setDeleteDialog } from './notes.js';
import { THEMES } from './theme.js';
import { isRecentNote } from '../core/dates.js';
import { allCount, breadcrumbTitle, listEmpty, markdownInput, noteList, recentCountEl, starredCountEl, titleInput, totalCount } from '../core/elements.js';
import { newNoteId } from '../core/ids.js';
import { folderDepth, folderIconForDepth } from '../core/paths.js';
import { normalizeExt } from '../core/schema.js';
import { escapeHtml } from '../core/strings.js';
import { argon2id32 } from '../data/crypto.js';
import { currentVaultBlobs, decryptAllVaultBlobs, timingSafeEqualStr, uniqueVaultTitle } from '../data/vault.js';
import { NOTE_TEMPLATES } from '../domain/constants.js';
import { passwordPolicyCheck } from './auth.js';
import { exitCoverRepos, renderCover, renderPreview } from './editor.js';
import { setSaveLabel } from './feedback.js';
import { readLegacyUiKeys, refreshEditorLock, updateListHeading, updateMeta } from './misc.js';
import { applyUiSnapshot, openTemplatePicker } from './notes-core.js';
import { clearEditor, clearSearch, goAllNotes, persistNotes, renderNoteList, updateBinUI } from './notes.js';
import { addVaultFolder, ensureMigratedCollectionsSection, openVaultFolderDeleteConfirm, openVaultFolderPicker, persistCollapsedFolders, renameVaultFolder, renderCustomSections } from './sections.js';
import { welcomeSeedUi } from './shell.js';
import { renderStripItems, renderTabs, trackTab, updateBreadcrumbs } from './tabs.js';



export function updateVaultUI() {
  const inVault = state.activeView === 'vault';
  const showVaultTools = inVault && state.vault.unlocked;
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
  if (vaultNavIcon) vaultNavIcon.innerHTML = icon(state.vault.unlocked ? 'unlock' : 'lock');
}

export function setVaultModal(mode, message) {
  state.vaultModalMode = mode;
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

export function closeVaultModal() {
  document.getElementById('vault-overlay').hidden = true;
  state.vaultModalMode = null;
  ['vault-password', 'vault-new-password', 'vault-confirm-password'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
}

export function vaultFail(message) {
  const errorEl = document.getElementById('vault-error');
  const card = document.querySelector('#vault-overlay .modal');
  if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; }
  if (card) {
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  }
}


export async function openVaultModal() {
  if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to open the Vault'); return; }
  let meta = null;
  try {
    const response = await apiFetch('/api/vault-meta');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    meta = await response.json();
  } catch (error) {
    showToast('Cannot reach the Notely server');
    return;
  }
  state.vault.meta = meta;
  setVaultModal(meta && meta.exists ? 'unlock' : 'setup');
  document.getElementById('vault-overlay').hidden = false;
  const focusInput = document.querySelector(state.vaultModalMode === 'setup' ? '#vault-new-password' : '#vault-password');
  if (focusInput) focusInput.focus();
}

export function openVaultNoteDeleteConfirm(id) {
  const note = state.vault.notes.find((item) => item.id === id);
  if (!note) return;
  state.pendingDeleteId = id;
  state.pendingDeleteMode = 'vault-note';
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

export async function decryptUiVaultRaw(raw) {
  const obj = JSON.parse(raw);
  const plain = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(obj.iv) }, e2ee.masterKey, e2eeB64ToBytes(obj.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// Immediate encrypted write of the per-account local cache. Used by the
// debounced persistUiVault() and by the logout/pagehide flush path.
export async function writeUiVaultLocal() {
  if (!e2ee.masterKey) return; // locked: never write (and never plaintext)
  let theme = 'light';
  try {
    const current = document.documentElement.dataset.theme
      || localStorage.getItem('notely-theme') || 'light';
    if (THEMES.includes(current)) theme = current;
  } catch (error) {}
  const snapshot = JSON.stringify({
    collapsed: [...state.collapsedFolders],
    customSections: state.customSections, deletedCustomSections: state.deletedCustomSections, theme,
    avatar: state.profileAvatar || '',
    tags: state.knownTags,
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

// Device-local cache key, namespaced per account so two logins on one device
// can never decrypt (or overwrite) each other's sidebar.
export function uiVaultKey() {
  try {
    const name = state.cachedProfile && state.cachedProfile.username ? String(state.cachedProfile.username).toLowerCase() : '';
    if (name) return `${UI_VAULT_KEY}:${name}`;
  } catch (error) {}
  return UI_VAULT_KEY;
}


export async function resetVault() {
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
  state.vault.unlocked = false;
  state.vault.dek = null;
  state.vault.notes = [];
  state.vault.blobs = [];
  state.vault.folders = [];
  state.vault.meta = null;
  state.currentVaultId = null;
  persistNotes();
  closeVaultModal();
  goAllNotes();
  renderNoteList();
  showToast('Vault reset');
}

export async function unlockVaultFromModal() {
  const password = String(document.getElementById('vault-password').value || '');
  const meta = state.vault.meta;
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
    state.vault.dek = await window.crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    state.vault.notes = await decryptAllVaultBlobs();
    state.vault.unlocked = true;
    closeVaultModal();
    enterVaultView();
    showToast('Vault unlocked');
  } catch (error) {
    vaultFail('Incorrect vault password.');
  }
}

export async function setupVaultFromModal() {
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
    state.vault.dek = await window.crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    state.vault.notes = [];
    state.vault.unlocked = true;
    closeVaultModal();
    enterVaultView();
    showToast('Vault ready');
  } catch (error) {
    vaultFail('Could not set up the vault. Try again.');
  }
}

// Wipe vault plaintext (keeping ciphertext blobs AND the folder list) and
// leave the view. Folders stay so a background sync while locked can never
// strand or erase them from the envelope.
export async function lockVault() {
  if (state.activeView === 'vault' && state.currentVaultId) saveVaultNote();
  try { await currentVaultBlobs(); } catch (error) {}
  persistNotes();
  state.vault.unlocked = false;
  state.vault.dek = null;
  state.vault.notes = [];
  state.vault.meta = null;
  state.currentVaultId = null;
  goAllNotes();
  renderNoteList();
  showToast('Vault locked');
}

export function enterVaultView() {
  if (!state.vault.unlocked) { openVaultModal(); return; }
  state.activeView = 'vault';
  state.activeCustom = null;
  state.activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'vault'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
}

// Render the Vault view: lock notice when locked, otherwise one Vault folder
// with the decrypted notes. Counts/footer mirror the normal list shape.
export function renderVaultList() {
  updateBinUI(); // Vault never shows Empty Bin; this also clears stale visibility.
  updateVaultUI();
  updateBreadcrumbs();
  const emptyTitle = listEmpty.querySelector('strong');
  const emptySub = listEmpty.querySelector('span:last-child');
  if (!state.vault.unlocked) {
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
  if (!state.vault.notes.length && !state.vault.folders.length) {
    noteList.innerHTML = '';
    listEmpty.hidden = false;
    noteList.hidden = true;
    if (emptyTitle) emptyTitle.textContent = 'Vault is empty';
    if (emptySub) emptySub.textContent = 'Create your first secret note.';
  } else {
    listEmpty.hidden = true;
    noteList.hidden = false;
    const knownVaultFolders = new Set(state.vault.folders);
    const rootNotes = state.vault.notes.filter((note) => !note.folder || !knownVaultFolders.has(note.folder));
    const renderVaultNoteRow = (note) => `
        <button class="tree-file${note.id === state.currentVaultId ? ' selected' : ''}" data-vault-id="${escapeHtml(note.id)}" title="${escapeHtml(note.title || 'Untitled note')}" draggable="true">
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
          <span class="tree-count">${state.vault.notes.length}</span>
        </button>
        <button type="button" class="strip-btn" data-vault-folder-add title="New vault folder" aria-label="New vault folder">${icon('folder-plus')}</button>
      </div>
      <div class="tree-children">
        ${state.vault.folders.map((folder) => {
          const files = state.vault.notes.filter((note) => note.folder === folder);
          const isCollapsed = state.collapsedFolders.has(folder);
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
  if (allCount) allCount.textContent = state.vault.notes.length;
  if (recentCountEl) recentCountEl.textContent = state.vault.notes.filter((note) => isRecentNote(note)).length;
  if (starredCountEl) starredCountEl.textContent = state.vault.notes.filter((note) => note.favorite).length;
  if (totalCount) totalCount.textContent = `${state.vault.notes.length} in vault`;
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
      if (state.collapsedFolders.has(folder)) state.collapsedFolders.delete(folder);
      else state.collapsedFolders.add(folder);
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
      if (!state.vault.unlocked) { event.preventDefault(); return; }
      event.dataTransfer.setData('text/plain', row.dataset.vaultId);
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  });
  noteList.querySelectorAll('[data-vault-folder]').forEach((header) => {
    header.addEventListener('dragover', (event) => {
      if (!state.vault.unlocked) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      header.classList.add('drop-target');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drop-target'));
    header.addEventListener('drop', (event) => {
      event.preventDefault();
      const folder = header.dataset.vaultFolder;
      const note = state.vault.unlocked ? state.vault.notes.find((entry) => entry.id === event.dataTransfer.getData('text/plain')) : null;
      if (!note || !state.vault.folders.includes(folder)) return;
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

export function deleteVaultNote(id) {
  const index = state.vault.notes.findIndex((item) => item.id === id);
  if (index === -1) return;
  state.vault.notes.splice(index, 1);
  state.vault.blobs = state.vault.blobs.filter((item) => item.id !== id);
  if (state.currentVaultId === id) {
    if (state.vault.notes.length) selectVaultNote(state.vault.notes[Math.min(index, state.vault.notes.length - 1)].id);
    else { state.currentVaultId = null; clearEditor(); }
  }
  persistNotes();
  renderNoteList();
  showToast('Secret note deleted');
}

// Create a vault note from a template into the picked folder (or Vault root).
export function createVaultNoteFromTemplate(templateKey) {
  if (!state.vault.unlocked) { showToast('Unlock the Vault first'); return null; }
  const template = NOTE_TEMPLATES[templateKey] || NOTE_TEMPLATES.standard;
  const folder = (state.pendingVaultFolder && state.vault.folders.includes(state.pendingVaultFolder)) ? state.pendingVaultFolder : null;
  state.pendingVaultFolder = null;
  const title = uniqueVaultTitle(template.titleBase);
  const note = {
    id: newNoteId(), title, body: template.body(title),
    tags: [...template.tags], ext: normalizeExt(template.ext),
    date: 'Now', favorite: false, folder,
  };
  state.vault.notes.unshift(note);
  state.currentVaultId = note.id;
  selectVaultNote(note.id);
  persistNotes();
  showToast(folder ? `${template.label} created in ${folder}` : `${template.label} created`);
  return note;
}

// + New secret note entry: like + New Note outside the Vault — asks for the
// folder first (only when folders exist), then the template.
export function onNewVaultNoteClick() {
  if (!state.vault.unlocked) { showToast('Unlock the Vault first'); return; }
  state.pendingVaultFolder = null;
  state.vaultTemplatePending = false;
  if (state.vault.folders.length && openVaultFolderPicker()) return;
  state.vaultTemplatePending = true;
  openTemplatePicker();
}

// Save the open vault note into memory; the debounced envelope sync persists it.
export function saveVaultNote() {
  if (!state.vault.unlocked || !state.currentVaultId) return;
  const note = state.vault.notes.find((item) => item.id === state.currentVaultId);
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
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 450);
}

// Open a vault note in the editor (preview-first, like normal notes).
export function selectVaultNote(id) {
  exitCoverRepos(true);
  const note = state.vault.unlocked ? state.vault.notes.find((item) => item.id === id) : null;
  if (!note) return;
  trackTab(id, true);
  state.currentVaultId = id;
  state.currentId = null;
  document.querySelector('.app-shell').classList.remove('workspace-focus');
  state.writeMode = 'preview';
  clearTimeout(state.idleTimer);
  titleInput.value = note.title;
  markdownInput.value = note.body;
  breadcrumbTitle.textContent = note.title;
  renderCover(null); // vault notes have no covers; clear any stale banner
  renderPreview(note);
  updateMeta(note);
  renderNoteList();
  refreshEditorLock();
}

export async function loadUiVault() {
  // Server envelope (v2) already won: keep it, just refresh the per-account
  // local cache. Never let a stale device copy from another account clobber it.
  if (state.serverUiLoaded) {
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
  if (legacy.collapsed) { state.collapsedFolders = new Set(legacy.collapsed); adopted = true; }
  if (legacy.sections) {
    state.customSections = legacy.sections.sections;
    adopted = true;
  }
  if (legacy.cols || legacy.colsName) {
    try { ensureMigratedCollectionsSection(legacy.cols || [], legacy.colsName || null); adopted = true; } catch (error) {}
  }
  if (!adopted && state.customSections.length === 0) {
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

export function persistUiVault() {
  clearTimeout(state.uiVaultTimer);
  state.uiVaultTimer = setTimeout(() => {
    (async () => {
      if (!e2ee.masterKey) return; // locked: never write (and never plaintext)
      try { await writeUiVaultLocal(); } catch (error) {}
      // The server envelope is the source of truth per account: schedule an
      // upload so sidebar changes survive relogs and follow the account.
      try { persistNotes(); } catch (error) {}
    })();
  }, 150);
}
