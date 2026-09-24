// js/data/crypto.js — Dafnote account E2EE primitives. This is the security core:
// base64/random helpers, the password KDF (Argon2id + PBKDF2), master-key
// wrap/unwrap, the Argon2 vendor loader (SRI-verified), and workspace encrypt/
// decrypt. Nothing here touches DOM or app state beyond the exported `e2ee`
// state object (master key + KDF params).

export const E2EE_KDF_ARGON2ID = { kdf: 'argon2id', t: 3, m: 65536, p: 1 };

// Legacy PBKDF2 accounts: never derive a KEK weaker than the platform default.
// Enforced with a dual-read attempt (floored first, stored count fallback).
export const PBKDF2_ITERATIONS_FLOOR = 210_000;

export const e2ee = { masterKey: null, kdf: null, saltAuth: null, saltEnc: null, iterations: 0 };

export const ARGON2_VENDOR = {
  wrapperUrl: 'vendor/argon2/argon2-wrapper.js',
  wrapperSri: 'sha384-M0v+643vWImGSGCZxDlAOQ/Ca2ShlvWHrOSQizBcd/mtr40Ho/ErB/mrWLxlQ366',
  distUrl: 'vendor/argon2/argon2.js',
  distSri: 'sha384-am7P6S/HiklM8ZO8Ihrv1tCPTFPGfEnKfUn8cqws88YeMDJAx8PJ3gCTdcS1XBuz',
  wasmUrl: 'vendor/argon2/argon2.wasm',
  wasmSha384: '8d844225e9c10f9c576bd8380b2c3428082dff0a2db88b325b93e12eadf72b3b192327083f8ff26d70e2d207ee22b9e3',
};

export let argon2LoadPromise = null;

// SHA-384 hex digest — used to verify the vendored Argon2 bytes (SRI).
async function sha384Hex(bytes) {
  const digest = await window.crypto.subtle.digest('SHA-384', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function fetchVerifiedBytes(url, expectedHex) {
  const response = await fetch(url, { credentials: 'same-origin' });
  if (!response.ok) throw new Error('argon2-fetch');
  const buf = new Uint8Array(await response.arrayBuffer());
  if (await sha384Hex(buf) !== expectedHex) throw new Error('argon2-integrity');
  return buf;
}

export function injectVerifiedScript(url, integrity) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = url;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.onload = () => resolve();
    script.onerror = () => { script.remove(); reject(new Error('argon2-load')); };
    document.head.appendChild(script);
  });
}

export async function loadArgon2() {
  if (!argon2LoadPromise) {
    argon2LoadPromise = (async () => {
      // Verify first, execute never-before-checked bytes never.
      const wasmBytes = await fetchVerifiedBytes(ARGON2_VENDOR.wasmUrl, ARGON2_VENDOR.wasmSha384);
      self.loadArgon2WasmBinary = async () => wasmBytes.slice(0);
      self.loadArgon2WasmModule = () => injectVerifiedScript(ARGON2_VENDOR.distUrl, ARGON2_VENDOR.distSri);
      await injectVerifiedScript(ARGON2_VENDOR.wrapperUrl, ARGON2_VENDOR.wrapperSri);
      if (!self.argon2 || typeof self.argon2.hash !== 'function') throw new Error('argon2-api');
      return self.argon2;
    })().catch((error) => { argon2LoadPromise = null; throw error; });
  }
  return argon2LoadPromise;
}

export function assertArgon2Params(params) {
  if (!params || params.t !== E2EE_KDF_ARGON2ID.t || params.m !== E2EE_KDF_ARGON2ID.m || params.p !== E2EE_KDF_ARGON2ID.p) {
    throw new Error('e2ee-kdf');
  }
}

export async function argon2id32(password, saltBytes) {
  const lib = await loadArgon2();
  const result = await lib.hash({
    pass: password,
    salt: saltBytes instanceof Uint8Array ? saltBytes : new Uint8Array(saltBytes),
    time: E2EE_KDF_ARGON2ID.t,
    mem: E2EE_KDF_ARGON2ID.m,
    hashLen: 32,
    parallelism: E2EE_KDF_ARGON2ID.p,
    type: lib.ArgonType.Argon2id,
  });
  return new Uint8Array(result.hash);
}

export async function e2eeWrapMasterKeyArgon2id(password, saltEncBytes, masterKeyRaw) {
  const rawKek = await argon2id32(password, saltEncBytes);
  const kek = await window.crypto.subtle.importKey('raw', rawKek, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, masterKeyRaw);
  return { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) };
}

export async function e2eeTrialUnwrapArgon2id(password, saltEncBytes, wrapped) {
  try {
    const rawKek = await argon2id32(password, saltEncBytes);
    const kek = await window.crypto.subtle.importKey('raw', rawKek, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const raw = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapped.iv) }, kek, e2eeB64ToBytes(wrapped.data));
    return raw instanceof ArrayBuffer ? raw.byteLength === 32 : new Uint8Array(raw).length === 32;
  } catch (error) {
    return false;
  }
}

export function e2eeBytesToB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i += 1) binary += String.fromCharCode(arr[i]);
  return btoa(binary);
}

export function e2eeB64ToBytes(b64) {
  const binary = atob(String(b64));
  const arr = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) arr[i] = binary.charCodeAt(i);
  return arr;
}

export function e2eeRandomBytes(length) {
  const arr = new Uint8Array(length);
  window.crypto.getRandomValues(arr);
  return arr;
}

export async function e2eePasswordBase(password) {
  return window.crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
}

export async function e2eeDeriveBits(password, saltBytes, iterations) {
  const base = await e2eePasswordBase(password);
  const bits = await window.crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' }, base, 256);
  return new Uint8Array(bits);
}

export async function e2eeKekFromPassword(password, saltBytes, iterations) {
  const base = await e2eePasswordBase(password);
  return window.crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function e2eeUnwrapMasterKey(password, saltEncBytes, iterations, wrapped) {
  const kek = await e2eeKekFromPassword(password, saltEncBytes, iterations);
  const raw = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapped.iv) }, kek, e2eeB64ToBytes(wrapped.data));
  // Extractable WITHIN this page so the key can be re-wrapped on rotation or
  // KDF upgrade. Page JS could use it while unlocked regardless (hence the
  // strict CSP + output sanitizers); it is still never persisted or sent.
  return window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

// AAD context binding: envelopes are crypto-bound to the account so a
// server/DB-write attacker cannot swap blobs between accounts undetected.
// Dual-read: legacy unbound blobs still decrypt (staged rollout).
function workspaceAad(aadContext) {
  return aadContext ? new TextEncoder().encode(String(aadContext)) : null;
}

export async function e2eeEncryptNotes(noteArray, aadContext) {
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: workspaceAad(aadContext) }, e2ee.masterKey,
    new TextEncoder().encode(JSON.stringify(noteArray)));
  return { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) };
}

export async function e2eeDecryptPayload(payload, aadContext) {
  if (!e2ee.masterKey) throw new Error('locked');
  const key = e2ee.masterKey;
  const raw = e2eeB64ToBytes(payload.data);
  const iv = e2eeB64ToBytes(payload.iv);
  let plain;
  try {
    plain = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: workspaceAad(aadContext) }, key, raw);
  } catch (error) {
    if (!aadContext) throw error;
    plain = await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, raw);
  }
  const parsed = JSON.parse(new TextDecoder().decode(plain));
  if (Array.isArray(parsed) || (parsed && typeof parsed === 'object')) return parsed;
  throw new Error('bad payload');
}
