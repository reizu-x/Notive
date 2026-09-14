// js/ui/vault.js — private-vault modal plumbing: open/close renders and
// lock-state banners. All modal state lives on the shared state object.

import { icon } from '../core/icons.js';
import { state } from '../domain/state.js';

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
