// js/data/collab-crypto.js — shared-section crypto: account-key wrap/unwrap,
// signature signing/verification + pin cache, raw group-key wrap/unwrap,
// AES-GCM envelope (note + group meta), plain text-diff helpers, and the
// base64url/sha256 utilities used by the recovery + MFA flows.
// Yjs itself is loaded lazily; notes content streams through collabEncrypt.

import { e2ee, e2eeRandomBytes, e2eeBytesToB64, e2eeB64ToBytes, e2eeKekFromPassword, e2eePasswordBase } from './crypto.js';
import { apiFetch } from './api.js';
import { state } from '../domain/state.js';

export async function sharingFingerprint(pubRawBytes) {
  const digest = new Uint8Array(await window.crypto.subtle.digest('SHA-256', pubRawBytes));
  return [...digest.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function sharingPinsLoad() {
  if (state.sharingPinsLoaded) return;
  state.sharingPinsLoaded = true;
  try {
    const obj = JSON.parse(localStorage.getItem('notely-keypins') || '{}');
    Object.keys(obj).forEach((k) => state.sharingPins.set(k, String(obj[k])));
  } catch (error) {}
}

export function sharingPinsSave() {
  try { localStorage.setItem('notely-keypins', JSON.stringify(Object.fromEntries(state.sharingPins))); } catch (error) {}
}

export function wrapSigMessage(groupId, recipient, keyVersion, w) {
  return `notely-wrap-v1|${groupId || ''}|${recipient}|${Number(keyVersion) || 1}|${w.wrappedKey}|${w.ephPub}|${w.wrapIv}`;
}

export async function signWrap(groupId, recipient, keyVersion, w) {
  if (!state.sharing.signingKey) return '';
  const data = new TextEncoder().encode(wrapSigMessage(groupId, recipient, keyVersion, w));
  const sig = new Uint8Array(await window.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, state.sharing.signingKey, data));
  return e2eeBytesToB64(sig);
}

export async function verifyWrap(groupId, recipient, keyVersion, w) {
  if (!w || !w.sig || !w.signer) return;
  if (w.signer === recipient) return; // our own wrap
  const pub = await sharingSignerPublicKey(w.signer);
  const data = new TextEncoder().encode(wrapSigMessage(groupId, recipient, keyVersion, w));
  const ok = await window.crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, e2eeB64ToBytes(w.sig), data);
  if (!ok) throw new Error(`The section key from ${w.signer} failed verification.`);
}

export async function sharingSignerPublicKey(signer) {
  const res = await apiFetch(`/api/keys/lookup?username=${encodeURIComponent(signer)}`);
  if (!res.ok) throw new Error('Could not load the sender\'s signing key.');
  const data = await res.json();
  if (!data.sigPubkey) throw new Error(`${signer} has no signing key published.`);
  const raw = e2eeB64ToBytes(data.sigPubkey);
  const fp = await sharingFingerprint(raw);
  sharingPinsLoad();
  const pinned = state.sharingPins.get(signer);
  if (pinned && pinned !== fp) {
    throw new Error(`Signing key for ${signer} changed (${pinned} → ${fp}). Refusing to trust it.`);
  }
  if (!pinned) { state.sharingPins.set(signer, fp); sharingPinsSave(); }
  return window.crypto.subtle.importKey('raw', raw, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

export async function sharingUnwrapAccountKey(encPrivB64, kind) {
  const wrapped = e2eeB64ToBytes(encPrivB64);
  const priv = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: wrapped.slice(0, 12) }, e2ee.masterKey, wrapped.slice(12));
  if (kind === 'ECDSA') {
    return window.crypto.subtle.importKey('pkcs8', priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  }
  return window.crypto.subtle.importKey('pkcs8', priv, { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveKey']);
}

export async function sharingWrapAccountKey(pkcs8) {
  const iv = e2eeRandomBytes(12);
  const ct = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, e2ee.masterKey, pkcs8));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv); out.set(ct, iv.length);
  return e2eeBytesToB64(out);
}

export async function sharingRecipientPublicKey(username) {
  const res = await apiFetch(`/api/keys/lookup?username=${encodeURIComponent(username)}`);
  if (!res.ok) {
    let message = 'Could not find a sharing key for that account.';
    try { const data = await res.json(); if (data && data.error) message = data.error; } catch (error) {}
    throw new Error(message);
  }
  const data = await res.json();
  return window.crypto.subtle.importKey('raw', e2eeB64ToBytes(data.pubkey),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
}

export async function wrapRawKeyFor(recipientPub, rawKey) {
  const eph = await window.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
  const shared = await window.crypto.subtle.deriveKey(
    { name: 'ECDH', public: recipientPub }, eph.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const wrapIv = e2eeRandomBytes(12);
  const wrapped = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv: wrapIv }, shared, rawKey));
  const ephPub = new Uint8Array(await window.crypto.subtle.exportKey('raw', eph.publicKey));
  return { wrappedKey: e2eeBytesToB64(wrapped), ephPub: e2eeBytesToB64(ephPub), wrapIv: e2eeBytesToB64(wrapIv) };
}

export async function unwrapRawKey(wrappedB64, ephPubB64, wrapIvB64) {
  if (!state.sharing.privateKey) throw new Error('locked');
  const ephPub = await window.crypto.subtle.importKey('raw', e2eeB64ToBytes(ephPubB64),
    { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = await window.crypto.subtle.deriveKey(
    { name: 'ECDH', public: ephPub }, state.sharing.privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  return new Uint8Array(await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapIvB64) }, shared, e2eeB64ToBytes(wrappedB64)));
}

export async function unwrapMyKey(myKey, groupId, recipient, keyVersion) {
  await verifyWrap(groupId, recipient, keyVersion, myKey);
  return unwrapRawKey(myKey.wrappedKey, myKey.ephPub, myKey.wrapIv);
}

export async function collabGroupKey(groupId) {
  const res = await apiFetch(`/api/collab/groups/${groupId}`);
  if (!res.ok) throw new Error('No access');
  const g = await res.json();
  const key = await unwrapMyKey(g.myKey, groupId, state.cachedProfile && state.cachedProfile.username, g.myKeyVersion);
  return { key, group: g };
}

export function collabKeyFor(version) {
  const v = Number(version);
  if (Number.isFinite(v) && state.collab.keys.has(v)) return state.collab.keys.get(v);
  return state.collab.key;
}

export async function collabEncrypt(keyRaw, bytes) {
  const key = await window.crypto.subtle.importKey('raw', keyRaw, { name: 'AES-GCM' }, false, ['encrypt']);
  const iv = e2eeRandomBytes(12);
  const ct = new Uint8Array(await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  const packed = new Uint8Array(iv.length + ct.length);
  packed.set(iv); packed.set(ct, iv.length);
  return e2eeBytesToB64(packed);
}

export async function collabDecrypt(keyRaw, packedB64) {
  const key = await window.crypto.subtle.importKey('raw', keyRaw, { name: 'AES-GCM' }, false, ['decrypt']);
  const packed = e2eeB64ToBytes(packedB64);
  return new Uint8Array(await window.crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.slice(0, 12) }, key, packed.slice(12)));
}

export async function collabEncryptMeta(keyRaw, meta) {
  return collabEncrypt(keyRaw, new TextEncoder().encode(JSON.stringify({
    t: meta.title || '', f: meta.folder || '', tp: meta.template || '',
    tg: Array.isArray(meta.tags) ? meta.tags.filter((x) => typeof x === 'string').slice(0, 20) : [],
  })));
}

export async function collabDecryptMeta(keyRaw, encB64) {
  if (!encB64) return { title: '', folder: '', template: '', tags: [] };
  try {
    const obj = JSON.parse(new TextDecoder().decode(await collabDecrypt(keyRaw, encB64)));
    return {
      title: typeof obj.t === 'string' ? obj.t : '',
      folder: typeof obj.f === 'string' ? obj.f : '',
      template: typeof obj.tp === 'string' ? obj.tp : '',
      tags: Array.isArray(obj.tg) ? obj.tg.filter((x) => typeof x === 'string').slice(0, 20) : []
    };
  } catch (error) { return { title: '', folder: '', template: '', tags: [] }; }
}

export async function collabEncryptGroupMeta(keyRaw, folders, tags) {
  return collabEncrypt(keyRaw, new TextEncoder().encode(JSON.stringify({
    folders: Array.isArray(folders) ? folders : [],
    tags: Array.isArray(tags) ? tags.filter((x) => typeof x === 'string').slice(0, 100) : [],
  })));
}

export async function collabDecryptGroupMeta(keyRaw, encB64) {
  if (!encB64) return { folders: [], tags: [] };
  try {
    const obj = JSON.parse(new TextDecoder().decode(await collabDecrypt(keyRaw, encB64)));
    return {
      folders: Array.isArray(obj.folders) ? obj.folders.filter((f) => typeof f === 'string') : [],
      tags: Array.isArray(obj.tags) ? obj.tags.filter((t) => typeof t === 'string') : [],
    };
  } catch (error) { return { folders: [], tags: [] }; }
}

export function commonPrefixLen(a, b) { const n = Math.min(a.length, b.length); let i = 0; while (i < n && a[i] === b[i]) i += 1; return i; }

export function commonSuffixLen(a, b, max) { let i = 0; while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i += 1; return i; }

export function applyTextDiff(ytext, oldStr, newStr) {
  if (oldStr === newStr) return;
  const p = commonPrefixLen(oldStr, newStr);
  const suffix = commonSuffixLen(oldStr, newStr, Math.min(oldStr.length - p, newStr.length - p));
  const delCount = oldStr.length - p - suffix;
  const insert = newStr.slice(p, newStr.length - suffix);
  if (delCount > 0) ytext.delete(p, delCount);
  if (insert) ytext.insert(p, insert);
}

export function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBuf(b64url) {
  let s = String(b64url || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(text) {
  const digest = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
