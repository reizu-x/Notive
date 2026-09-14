// js/ui/auth.js — authentication & E2EE session UI helpers: login/register
// tabs, password policy, MFA status, session refresh, profile identity
// (name/initials/avatar) sanitization. The unlock/KDF rewrap logic stays
// colocated with its password-form wiring.

// AVATAR_MAX_CHARS is a shared data cap (avatar uploads + stored srcs).
export const AVATAR_MAX_CHARS = 400000;

import { apiFetch } from '../data/api.js';
import { state } from '../domain/state.js';
import { E2EE_KDF_ARGON2ID, argon2id32, e2ee, e2eeB64ToBytes, e2eeBytesToB64, e2eeDeriveBits, e2eeRandomBytes, e2eeUnwrapMasterKey, e2eeWrapMasterKeyArgon2id } from '../data/crypto.js';
import { b64urlToBuf } from '../data/collab-crypto.js';
import { clearRecoveryCodesLocal, loadRecoveryCodesLocal } from './editor.js';
import { showToast } from './modal.js';
import { applyProfile } from './shell.js';


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
    masterKey = await e2eeUnwrapMasterKey(password, saltEncBytes, bundle.iterations, bundle.encMasterKey);
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
  const tabLoginEl = document.getElementById('tab-login');
  if (tabLoginEl) {
    tabLoginEl.classList.toggle('active', !isRegister);
    tabLoginEl.setAttribute('aria-selected', String(!isRegister));
  }
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
    if (name) return `notely-recovery-codes:${name}`;
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
