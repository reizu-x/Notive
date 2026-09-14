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
