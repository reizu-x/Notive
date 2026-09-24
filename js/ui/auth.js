// js/ui/auth.js — authentication & E2EE session UI helpers: login/register
// tabs, password policy, MFA status, session refresh, profile identity
// (name/initials/avatar) sanitization. The unlock/KDF rewrap logic stays
// colocated with its password-form wiring.

// AVATAR_MAX_CHARS is a shared data cap (avatar uploads + stored srcs).
export const AVATAR_MAX_CHARS = 400000;

import { apiFetch } from '../data/api.js';
import { state } from '../domain/state.js';
import {E2EE_KDF_ARGON2ID, argon2id32, e2ee, e2eeB64ToBytes, e2eeBytesToB64, e2eeDeriveBits, e2eeRandomBytes, e2eeUnwrapMasterKey, e2eeWrapMasterKeyArgon2id , PBKDF2_ITERATIONS_FLOOR} from '../data/crypto.js';
import { b64urlToBuf } from '../data/collab-crypto.js';
import { clearRecoveryCodesLocal, loadRecoveryCodesLocal } from './editor.js';
import { showToast } from './modal.js';
import { applyProfile } from './shell.js';
import { prfWrapMasterKey } from './editor.js';
import { breadcrumbTitle, markdownInput, tagList, titleInput, wordCount } from '../core/elements.js';
import { setSharedNavCount } from '../data/collab-crypto.js';
import { COLLAPSED_FOLDERS_KEY, SECTION_DATA_KEY } from '../domain/constants.js';
import { setCoverAddHidden } from './editor.js';
import { clearEditor, flushNotesToServer, wipeLegacyLocalNotes } from './notes.js';
import { renderCustomSections } from './sections.js';
import { clearSessionUnlock } from './shell.js';
import { writeUiVaultLocal } from './vault.js';



export async function e2eeUnlockWithPassword(username, password, bundle) {
  const saltEncBytes = e2eeB64ToBytes(bundle.saltEnc);
  let masterKey;
  if (bundle.kdf === 'argon2id') {
    const rawKek = await argon2id32(password, saltEncBytes);
    const kek = await window.crypto.subtle.importKey('raw', rawKek, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const rawMk = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: e2eeB64ToBytes(bundle.encMasterKey.iv) }, kek, e2eeB64ToBytes(bundle.encMasterKey.data));
    masterKey = await window.crypto.subtle.importKey('raw', rawMk, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  } else {
    // Legacy unwrap: clamp to the platform floor first (blocks attacker-served
    // weak counts); historical rows fall back to their stored count.
    const stored = Number(bundle.iterations) || 0;
    const floor = Math.max(stored, PBKDF2_ITERATIONS_FLOOR);
    try {
      masterKey = await e2eeUnwrapMasterKey(password, saltEncBytes, floor, bundle.encMasterKey);
    } catch (error) {
      if (floor === stored) throw error;
      masterKey = await e2eeUnwrapMasterKey(password, saltEncBytes, stored, bundle.encMasterKey);
    }
    bundle.iterations = floor;
  }
  const saltAuthBytes = e2eeB64ToBytes(bundle.saltAuth);
  e2ee.masterKey = masterKey;
  e2ee.kdf = bundle.kdf || 'pbkdf2';
  e2ee.saltAuth = saltAuthBytes;
  e2ee.saltEnc = saltEncBytes;
  e2ee.iterations = bundle.iterations || 0;
}

export async function e2eeUpgradeKdf(username, password) {
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

export async function refreshMfaStatus() {
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

export function passwordPolicyCheck(password) {
  // NIST SP 800-63B: length-based, no composition rules; long passwords allowed.
  const failures = [];
  if (typeof password !== 'string' || password.length < 15) failures.push('at least 15 characters');
  if (typeof password === 'string' && password.length > 256) failures.push('at most 256 characters');
  return failures;
}

export function setAuthTab(mode) {
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
  const tabRegisterEl = document.getElementById('tab-register');
  if (tabRegisterEl) {
    tabRegisterEl.classList.toggle('active', isRegister);
    tabRegisterEl.setAttribute('aria-selected', String(isRegister));
    tabRegisterEl.textContent = isRegister ? 'Log in' : 'Create account';
  }
  document.getElementById('login-title').textContent = isRecover ? 'Recover account' : isRegister ? 'Create account' : 'Log in';
}

export function loginFail(message) {
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

export function showLogin() {
  const overlay = document.getElementById('login-overlay');
  if (!overlay) return;
  overlay.hidden = false;
  const errorEl = document.getElementById('login-error');
  if (errorEl) errorEl.hidden = true;
  const userInput = document.getElementById('login-username');
  if (userInput) userInput.focus();
}

export function hideLogin() {
  const overlay = document.getElementById('login-overlay');
  if (overlay) overlay.hidden = true;
}

export async function refreshSession() {
  try {
    const response = await apiFetch('/api/me');
    if (!response.ok) {
      state.cachedProfile = null;
      return null;
    }
    state.cachedProfile = await response.json();
    return state.cachedProfile;
  } catch (error) {
    state.cachedProfile = null;
    return null;
  }
}

export function fullNameOf(profile) {
  return `${profile.firstName || ''} ${profile.lastName || ''}`.trim() || profile.username || '?';
}

export function initialsFor(name) {
  return String(name || '').trim().split(/\s+/).map((word) => word[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || '?';
}

export function cleanAvatarSrc(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length > AVATAR_MAX_CHARS) return null;
  return /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(s) ? s : null;
}


export async function refreshAcctRecStatus() {
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

export function closeAcctRecModal() {
  // One-shot display: wipe plaintext codes from memory and DOM on close.
  state.acctRecShownCodes = [];
  renderAcctRecCodes();
  const modal = document.getElementById('acct-rec-modal');
  if (modal) modal.hidden = true;
}

export function openAcctRecModal() {
  renderAcctRecCodes();
  const err = document.getElementById('acct-rec-modal-error');
  if (err) err.hidden = true;
  const modal = document.getElementById('acct-rec-modal');
  if (modal) modal.hidden = false;
}

export function renderAcctRecCodes() {
  const list = document.getElementById('acct-rec-codes');
  if (!list) return;
  list.innerHTML = '';
  state.acctRecShownCodes.forEach((code) => {
    const item = document.createElement('li');
    item.textContent = code;
    list.appendChild(item);
  });
}

// Plaintext codes live ONLY here (memory) and in one encrypted on-device
// cache below. The server keeps hashes + wraps, so a second device can never
// re-display them — it must replace the set (invalidating the old codes).
export function acctRecCacheKey() {
  try {
    const name = state.cachedProfile && state.cachedProfile.username ? String(state.cachedProfile.username).toLowerCase() : '';
    if (name) return `drafnote-recovery-codes:${name}`;
  } catch (error) {}
  return null;
}

// --- Name editing (stored inside the server-encrypted profile) ---
export async function saveAccountName() {
  const errEl = document.getElementById('account-error');
  const first = String(document.getElementById('account-first').value || '').trim().slice(0, 60);
  const last = String(document.getElementById('account-last').value || '').trim().slice(0, 60);
  try {
    const r = await apiFetch('/api/account/profile', { method: 'POST', body: JSON.stringify({ firstName: first, lastName: last }) });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Could not save name.');
    if (state.cachedProfile) { state.cachedProfile.firstName = data.firstName || first; state.cachedProfile.lastName = data.lastName || last; }
    if (errEl) errEl.hidden = true;
    applyProfile();
    showToast('Name saved');
  } catch (error) {
    if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
  }
}

// --- Account pane (username/email/delete) ---
export function refreshAccountPane() {
  try {
    const u = document.getElementById('account-username');
    if (u) u.value = (state.cachedProfile && state.cachedProfile.username) || '';
    const f = document.getElementById('account-first');
    if (f && document.activeElement !== f) f.value = (state.cachedProfile && state.cachedProfile.firstName) || '';
    const l = document.getElementById('account-last');
    if (l && document.activeElement !== l) l.value = (state.cachedProfile && state.cachedProfile.lastName) || '';
    const e = document.getElementById('account-email');
    if (e && document.activeElement !== e) e.value = (state.cachedProfile && state.cachedProfile.email) || '';
  } catch (error) {}
}

// Many authenticators evaluate the PRF only during an assertion (get), not
// during creation. Run a throwaway get() against the just-created credential to
// obtain its PRF output, so passwordless unlock works on far more devices. The
// challenge is local — nothing is sent to the server; only the PRF output is
// used, to wrap the master key under SHA-256(PRF).
export async function prfSecretViaAssertion(credentialId, rpId, prfSaltB64) {
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

export function prfFirstResult(cred) {
  try {
    const ext = cred.getClientExtensionResults ? cred.getClientExtensionResults() : null;
    const first = ext && ext.prf && ext.prf.results && ext.prf.results.first;
    return first ? new Uint8Array(first) : null;
  } catch (error) {
    return null;
  }
}

export function closeMfaQrModal() {
  const modal = document.getElementById('mfa-qr-modal');
  if (modal) modal.hidden = true;
}

export function openMfaQrModal() {
  const modal = document.getElementById('mfa-qr-modal');
  if (modal) modal.hidden = false;
}

// ---- Desktop copy / cloud opt-out ----
// "This device only" mode: server sync is off and the E2EE envelope is saved
// to a per-account encrypted localStorage slot instead. Same key-zeroing
// rules as the UI vault — never plaintext, never shared between accounts.
export function accountScopeKey(base) {
  try {
    const name = state.cachedProfile && state.cachedProfile.username ? String(state.cachedProfile.username).toLowerCase() : '';
    return `${base}:${name}`;
  } catch (error) { return base; }
}


export async function refreshPasskeys() {
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

// Attach a PRF wrap to an existing passkey (no remove/re-add needed), so it can
// unlock notes without the password. Requires an unlocked session (master key
// is in memory) and a PRF-capable authenticator.
export async function enablePasswordlessPasskey(credIdB64, prfSaltB64, btn) {
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


// Central lock switch: disables editor inputs and hides New/Import while logged out or locked; otherwise defers to the note deleted/archived state. Runs after every list/selection render.
export function refreshEditorLock() {
  // A shared note is always editable while it is open in the standard editor.
  if (state.collab.noteId) {
    titleInput.disabled = false;
    markdownInput.disabled = false;
    return;
  }
  let note = null;
  let locked = !isUnlocked();
  if (state.activeView === 'vault') {
    locked = locked || !state.vault.unlocked;
    if (!locked && state.currentVaultId) note = state.vault.notes.find((item) => item.id === state.currentVaultId) || null;
  } else if (state.currentId) {
    note = state.notes.find((item) => item.id === state.currentId) || null;
  }
  const readOnly = locked || !note || Boolean(note.deleted) || Boolean(note.archived);
  titleInput.disabled = readOnly;
  markdownInput.disabled = readOnly;
  const newNoteBtn = document.getElementById('new-note');
  const importBtn = document.getElementById('import-notes');
  if (newNoteBtn) newNoteBtn.hidden = locked || state.activeView === 'bin' || state.activeView === 'vault' || state.activeView === 'shared';
  if (importBtn) importBtn.hidden = locked || state.activeView === 'bin' || state.activeView === 'vault' || state.activeView === 'shared';
  const coverAddBtn = document.getElementById('cover-add');
  if (coverAddBtn) setCoverAddHidden(readOnly || state.activeView === 'vault' || !note || Boolean(note.cover) || note.template === 'recipe');
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

// True when a session exists AND the master key is in memory (vault unlocked, notes readable).
export function isUnlocked() {
  return Boolean(state.cachedProfile && e2ee.masterKey);
}

// Wipe all key material from memory (logout, failed unlock). Display/session state is cleared separately.
export function e2eeLock() {
  e2ee.masterKey = null;
  e2ee.kdf = null;
  e2ee.saltAuth = null;
  e2ee.saltEnc = null;
  e2ee.iterations = 0;
}

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
  state.vaultMetas = [];
  state.vaultList = [];
  state.vaultKeys = {};
  state.vaultBlobMap = {};
  state.vaultFolderMap = {};
  state.vaultId = 1;
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
    // (`drafnote-ui-vault:<user>`) stay so the next login boots fast offline —
    // the server envelope remains the source of truth.
    localStorage.removeItem('drafnote-collections');
    localStorage.removeItem('drafnote-deleted-collections');
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
