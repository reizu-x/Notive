// js/ui/auth.js — authentication & E2EE session UI helpers: login/register
// tabs, password policy, MFA status, session refresh, profile identity
// (name/initials/avatar) sanitization. The unlock/KDF rewrap logic stays
// colocated with its password-form wiring.

// AVATAR_MAX_CHARS is a shared data cap (avatar uploads + stored srcs).
export const AVATAR_MAX_CHARS = 400000;

import { apiFetch } from '../data/api.js';
import { state } from '../domain/state.js';
import { E2EE_KDF_ARGON2ID, argon2id32, e2ee, e2eeB64ToBytes, e2eeBytesToB64, e2eeDeriveBits, e2eeRandomBytes, e2eeUnwrapMasterKey, e2eeWrapMasterKeyArgon2id } from '../data/crypto.js';

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
