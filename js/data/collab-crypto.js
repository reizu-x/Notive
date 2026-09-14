// js/data/collab-crypto.js — shared-section crypto: account-key wrap/unwrap,
// signature signing/verification + pin cache, raw group-key wrap/unwrap,
// AES-GCM envelope (note + group meta), plain text-diff helpers, and the
// base64url/sha256 utilities used by the recovery + MFA flows.
// Yjs itself is loaded lazily; notes content streams through collabEncrypt.

import { e2ee, e2eeRandomBytes, e2eeBytesToB64, e2eeB64ToBytes, e2eeKekFromPassword, e2eePasswordBase } from './crypto.js';
import { apiFetch } from './api.js';
import { state } from '../domain/state.js';
import { markdownInput, preview, titleInput } from '../core/elements.js';
import { icon } from '../core/icons.js';
import { renderMarkdown } from '../core/markdown.js';
import { folderDepth } from '../core/paths.js';
import { cleanCoverSrc } from '../core/schema.js';
import { escapeHtml } from '../core/strings.js';
import { COLLAB_PRESENCE_TTL_MS, NOTE_TEMPLATES, sharedBodyCache, sharedGroupOwners, sharedNoteMeta } from '../domain/constants.js';
import { renderRecipeHero } from '../ui/editor.js';
import { askInput, showToast } from '../ui/modal.js';
import { collabRotateSectionKey } from '../ui/sections.js';


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


export function showSharedContextMenu(kind, payload, x, y) {
  const menu = document.getElementById('shared-context-menu');
  if (!menu) return;
  state.sharedMenuTarget = { kind, ...payload };
  const items = kind === 'note'
    ? [['open', 'file-text', 'Open'], ['move', 'folder-plus', 'Move to folder'], ['delete', 'trash', 'Delete note']]
    : [['folder-note', 'file-text', 'New note here'], ['folder-sub', 'folder-plus', 'New subfolder'],
       ['folder-rename', 'pencil', 'Rename folder'], ['folder-delete', 'trash', 'Delete folder']];
  menu.innerHTML = items.map(([action, glyph, label]) =>
    `<button type="button" class="context-item${action.includes('delete') ? ' danger' : ''}" data-shared-action="${action}" role="menuitem"><span data-icon="${glyph}"></span><span>${label}</span></button>`).join('');
  menu.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
  menu.hidden = false;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  const pad = 8;
  if (rect.right > window.innerWidth - pad) menu.style.left = `${Math.max(pad, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight - pad) menu.style.top = `${Math.max(pad, y - rect.height)}px`;
}

// Right-click menu for shared notes and folders.
export function closeSharedContextMenu() {
  const menu = document.getElementById('shared-context-menu');
  if (menu) menu.hidden = true;
  state.sharedMenuTarget = null;
}

export async function updateSharedNoteMeta(key, noteId, meta) {
  try {
    // Callers rename/move notes and don't carry tags; preserve them from the
    // last decode so the encrypted meta mirror isn't wiped.
    let tags = meta.tags;
    if (tags === undefined) {
      const existing = sharedNoteMeta.get(String(noteId));
      tags = existing && Array.isArray(existing.tags) ? existing.tags : [];
    }
    const encMeta = await collabEncryptMeta(key, { ...meta, tags });
    await apiFetch(`/api/collab/notes/${noteId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
  } catch (error) {}
}

export async function refreshSharedNavCount() {
  if (!state.cachedProfile) { setSharedNavCount(0); return; }
  try {
    const res = await apiFetch('/api/collab/groups');
    if (!res.ok) return;
    const data = await res.json();
    const groups = Array.isArray(data.groups) ? data.groups.length : 0;
    const invites = Array.isArray(data.invites) ? data.invites.length : 0;
    setSharedNavCount(groups + invites);
  } catch (error) {}
}

// Sidebar Shared badge: number of connections (plus pending invitations).
export function setSharedNavCount(n) {
  const el = document.getElementById('nav-shared-count');
  if (el) el.textContent = String(Math.max(0, Number(n) || 0));
}

export function sharedNoteRow(n, groupId, canDelete) {
  const title = (n.title && n.title.trim()) ? n.title.trim() : 'Untitled note';
  // Align the note's icon under its folder's icon (folder rows carry a chevron).
  const indent = n.folder ? 8 + folderDepth(n.folder) * 14 + 23 : 8;
  const glyph = (n.template && NOTE_TEMPLATES[n.template] && NOTE_TEMPLATES[n.template].icon) ? NOTE_TEMPLATES[n.template].icon : 'file';
  const deleteAction = canDelete
    ? `<span class="tree-action danger" data-collab-note-delete="${n.id}" role="button" title="Delete note" aria-label="Delete ${escapeHtml(title)}">${icon('trash')}</span>`
    : '';
  return `<button class="tree-file shared-view-row" draggable="true" data-collab-open="${n.id}" data-collab-group="${groupId}" style="padding-left:${indent}px" title="${escapeHtml(title)}">
      <span class="tree-file-icon">${icon(glyph)}</span>
      <span class="tree-file-name">${escapeHtml(title)}</span>
      <span class="tree-action" data-note-folder="${n.id}" data-note-group="${groupId}" role="button" title="Move to folder" aria-label="Move ${escapeHtml(title)} to a folder">${icon('folder-plus')}</span>
      ${deleteAction}
    </button>`;
}

export function sharedGroupOwnerOf(groupId) {
  return sharedGroupOwners.get(groupId) || sharedGroupOwners.get(Number(groupId)) || null;
}

// Bottom "+ New note" opens the same popup (a new person = a new section).
export function collabCreate() { openCollabNewDialog(); }

export function setCollabNewStatus(message) {
  const status = document.getElementById('collab-new-status');
  if (status) { status.textContent = message; status.hidden = false; }
}

export function closeCollabNewDialog() {
  const overlay = document.getElementById('collab-new-overlay');
  if (overlay) overlay.hidden = true;
}

export function openCollabNewDialog() {
  const overlay = document.getElementById('collab-new-overlay');
  if (!overlay) return;
  const input = document.getElementById('collab-new-members');
  if (input) input.value = '';
  const status = document.getElementById('collab-new-status');
  if (status) { status.hidden = true; status.textContent = ''; }
  overlay.hidden = false;
  if (input) { try { input.focus(); } catch (error) {} }
}

export async function collabRemoveMember(name) {
  if (!state.collab.groupId) return;
  const me = state.cachedProfile && state.cachedProfile.username;
  if (state.collab.owner === me && state.collab.key) {
    // Owner removing a peer: the server rotates the section key in the same
    // request, so a removal can never leave the old key live for the person just
    // cut off. Keys never leave the members' devices.
    setCollabStatus('Rotating section key…', false);
    const ok = await collabRotateSectionKey(name);
    renderCollabMembersModal();
    showToast(ok ? `Removed ${name} — section key rotated` : `Could not remove ${name}`);
    return;
  }
  const res = await apiFetch(`/api/collab/groups/${state.collab.groupId}/members/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Could not remove member'); return; }
  state.collab.members = state.collab.members.filter((m) => m !== name);
  renderCollabMembersModal();
  showToast(`Removed ${name}`);
}

export async function collabInvite() {
  if (!state.collab.groupId || !state.collab.key) return;
  const me = state.cachedProfile && state.cachedProfile.username;
  if (state.collab.owner !== me) { showToast('Only the owner can add members'); return; }
  const value = await askInput({ eyebrow: 'Invite', title: 'Add a member', desc: 'They need a Notely account and must have logged in once.', label: 'Username', password: false, placeholder: 'their-username', okText: 'Invite' });
  if (value == null) return;
  const target = String(value).trim();
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(target)) { showToast('Invalid username'); return; }
  try {
    await collabAddGroupMember(state.collab.groupId, state.collab.key, target, state.collab.keyVersion);
    state.collab.pending = state.collab.pending || [];
    if (!state.collab.pending.includes(target)) state.collab.pending.push(target);
    renderCollabMembersModal();
    showToast(`Invited ${target}`);
  } catch (error) { showToast(error && error.message ? error.message : 'Could not add member'); }
}

export function sharedUniqueTitle(base, groupId) {
  const used = new Set();
  sharedNoteMeta.forEach((m) => {
    if (String(m.groupId) === String(groupId)) {
      const t = (m.title || '').trim().toLowerCase();
      if (t) used.add(t);
    }
  });
  if (!used.has(base.toLowerCase())) return base;
  let i = 2;
  while (used.has(`${base} ${i}`.toLowerCase())) i += 1;
  return `${base} ${i}`;
}

export async function collabAddGroupMember(groupId, keyRaw, name, keyVersion) {
  const pub = await sharingRecipientPublicKey(name);
  const wrap = await wrapRawKeyFor(pub, keyRaw);
  wrap.sig = await signWrap(groupId, name, keyVersion, wrap);
  const res = await apiFetch(`/api/collab/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ username: name, ...wrap }) });
  if (!res.ok) {
    let message = 'Could not add member';
    try { const d = await res.json(); if (d && d.error) message = d.error; } catch (error) {}
    throw new Error(message);
  }
}

export function closeCollabNote() {
  if (state.collab.reconnect) { clearTimeout(state.collab.reconnect); state.collab.reconnect = null; }
  // Tell peers we left (best-effort; reads current key/note before clearing).
  try { collabSendPresence(true); } catch (error) {}
  const statusEl = document.getElementById('collab-status');
  const statusSep = document.getElementById('collab-status-sep');
  if (statusEl) statusEl.hidden = true;
  if (statusSep) statusSep.hidden = true;
  const collabTop = document.getElementById('collab-top');
  if (collabTop) collabTop.hidden = true;
  const editorPanel = document.querySelector('.editor-panel');
  if (editorPanel) editorPanel.classList.remove('collab-mode');
  if (state.collab.es) { try { state.collab.es.close(); } catch (error) {} }
  if (state.collab.doc) { try { state.collab.doc.destroy(); } catch (error) {} }
  state.collab.noteId = null; state.collab.groupId = null; state.collab.doc = null; state.collab.title = null; state.collab.body = null;
  state.collab.desc = null; state.collab.assets = null; state.collab.recipe = null; state.collab.cover = ''; state.collab.description = '';
  state.collab.es = null; state.collab.key = null; state.collab.keyVersion = 1; state.collab.keys = new Map();
  state.collab.members = []; state.collab.owner = null; state.collab.groupName = ''; state.collab.template = '';
  if (state.collab.flushTimer) { clearTimeout(state.collab.flushTimer); state.collab.flushTimer = null; }
  if (state.collab.presenceTimer) { clearTimeout(state.collab.presenceTimer); state.collab.presenceTimer = null; }
  state.collab.outbox = []; state.collab.flushing = false;
  state.collab.presence.clear(); state.collab.clientId = null; state.collab.color = null;
  renderCollabPresence();
  try { renderRecipeHero(null); } catch (error) {}
}

// Fetch and unlock the new epoch key after the owner rotates, and switch to it.
export async function collabAdoptRekey(version) {
  if (!state.collab.groupId) return;
  try {
    const res = await apiFetch(`/api/collab/groups/${state.collab.groupId}`);
    if (!res.ok) return;
    const g = await res.json();
    const key = await unwrapMyKey(g.myKey, state.collab.groupId, state.cachedProfile && state.cachedProfile.username, g.myKeyVersion);
    const v = Number(g.keyVersion || g.myKeyVersion || version || (state.collab.keyVersion + 1));
    state.collab.keys.set(v, key);
    state.collab.keyVersion = v;
    state.collab.key = key;
    setCollabStatus(`Rekeyed · v${v}`, false);
  } catch (error) {}
}

export async function collabCompact() {
  if (!state.collab.doc || !state.collab.key || !state.collab.noteId) return;
  try {
    const Y = await loadYjs();
    const state = Y.encodeStateAsUpdate(state.collab.doc);
    const payload = await collabEncrypt(state.collab.key, state);
    const res = await apiFetch(`/api/collab/notes/${state.collab.noteId}/compact`, { method: 'POST', body: JSON.stringify({ state: payload, keyVersion: state.collab.keyVersion }) });
    if (res && res.ok) state.collab.outbox.length = 0; // full state covers every queued update
  } catch (error) {}
}

export function collabPresenceHeartbeat() {
  if (!state.collab.noteId) return;
  collabSendPresence(false);
  renderCollabPresence();
  state.collab.presenceTimer = setTimeout(collabPresenceHeartbeat, 5000);
}

export async function collabPresenceReceive(msg) {
  if (!state.collab.noteId) return;
  const key = collabKeyFor(msg.version);
  if (!key) return;
  let data;
  try { data = JSON.parse(new TextDecoder().decode(await collabDecrypt(key, msg.payload))); } catch (error) { return; }
  const id = String(data.id || '');
  if (!id || id === state.collab.clientId) return;
  if (data.leave) { state.collab.presence.delete(id); renderCollabPresence(); return; }
  state.collab.presence.set(id, {
    user: String(data.u || ''),
    color: typeof data.c === 'string' ? data.c : '#888',
    s: Number(data.s) || 0,
    e: Number(data.e) || 0,
    typing: Boolean(data.typing),
    ts: Date.now(),
  });
  renderCollabPresence();
}

export async function collabSendPresence(leave) {
  if (!state.collab.noteId || !state.collab.key || !state.collab.clientId) return;
  const noteId = state.collab.noteId;
  const key = state.collab.key;
  const keyVersion = state.collab.keyVersion;
  const ta = markdownInput;
  const body = JSON.stringify({
    id: state.collab.clientId,
    u: (state.cachedProfile && state.cachedProfile.username) || '',
    c: state.collab.color,
    s: ta ? ta.selectionStart : 0,
    e: ta ? ta.selectionEnd : 0,
    typing: !leave && state.collab.typing === true,
    leave: Boolean(leave),
  });
  try {
    const payload = await collabEncrypt(key, new TextEncoder().encode(body));
    if (!leave && state.collab.noteId !== noteId) return; // note changed while encrypting
    await apiFetch(`/api/collab/notes/${noteId}/presence`, { method: 'POST', body: JSON.stringify({ payload, keyVersion }) });
  } catch (error) {}
}

export function collabPresenceLocal(typing) {
  if (!state.collab.noteId) return;
  if (typing) {
    state.collab.typing = true;
    clearTimeout(state.collabTypingTimer);
    state.collabTypingTimer = setTimeout(() => { state.collab.typing = false; }, 1500);
  }
  if (state.collabPresenceLocalTimer) return;
  state.collabPresenceLocalTimer = setTimeout(() => { state.collabPresenceLocalTimer = null; collabSendPresence(false); }, 120);
}

export function renderCollabPresence() {
  const box = document.getElementById('collab-presence');
  const layer = document.getElementById('collab-caret-layer');
  if (!state.collab.noteId) {
    if (box) box.innerHTML = '';
    if (layer) layer.innerHTML = '';
    return;
  }
  const now = Date.now();
  const entries = [];
  state.collab.presence.forEach((p, id) => {
    if (now - p.ts < COLLAB_PRESENCE_TTL_MS) entries.push({ id, ...p });
    else state.collab.presence.delete(id);
  });
  entries.sort((a, b) => String(a.user).localeCompare(String(b.user)));
  if (box) {
    // Always show a "you" chip so the row is visible even when alone; remote
    // peers are appended after it.
    const meName = (state.cachedProfile && state.cachedProfile.username) || 'You';
    const self = `<span class="collab-presence-chip${state.collab.typing ? ' is-typing' : ''}"><span class="collab-presence-dot" style="background:${state.collab.color || '#888'}"></span>${escapeHtml(meName)} (you)${state.collab.typing ? ' · typing…' : ''}</span>`;
    box.innerHTML = self + entries.map((p) => `<span class="collab-presence-chip${p.typing ? ' is-typing' : ''}"><span class="collab-presence-dot" style="background:${p.color}"></span>${escapeHtml(p.user || 'Someone')}${p.typing ? ' · typing…' : ''}</span>`).join('');
  }
  if (layer) {
    if (state.writeMode !== 'edit') { layer.innerHTML = ''; }
    else {
      layer.innerHTML = entries.map((p) => {
        const c = collabCaretCoords(p.s);
        if (!c) return '';
        return `<div class="collab-caret" style="top:${c.top}px;left:${c.left}px;height:${c.height}px;background:${p.color}"><span class="collab-caret-label" style="background:${p.color}">${escapeHtml(p.user || '')}</span></div>`;
      }).join('');
    }
  }
}

// Textarea caret coordinates via an offscreen mirror with identical metrics.
export function collabCaretCoords(index) {
  const ta = markdownInput;
  if (!ta) return null;
  if (!state.collabCaretMirror) {
    state.collabCaretMirror = document.createElement('div');
    state.collabCaretMirror.setAttribute('aria-hidden', 'true');
    document.body.appendChild(state.collabCaretMirror);
  }
  const mirror = state.collabCaretMirror;
  const cs = window.getComputedStyle(ta);
  const st = mirror.style;
  st.position = 'absolute';
  st.visibility = 'hidden';
  st.top = '-9999px';
  st.left = '-9999px';
  st.whiteSpace = 'pre-wrap';
  st.overflowWrap = 'break-word';
  st.width = `${ta.clientWidth}px`;
  st.boxSizing = cs.boxSizing;
  st.fontFamily = cs.fontFamily;
  st.fontSize = cs.fontSize;
  st.fontWeight = cs.fontWeight;
  st.lineHeight = cs.lineHeight;
  st.letterSpacing = cs.letterSpacing;
  st.padding = cs.padding;
  st.border = cs.border;
  st.tabSize = cs.tabSize;
  const value = ta.value || '';
  const clamped = Math.max(0, Math.min(Number(index) || 0, value.length));
  mirror.textContent = value.slice(0, clamped);
  const marker = document.createElement('span');
  marker.textContent = '\u200b';
  mirror.appendChild(marker);
  return { top: marker.offsetTop, left: marker.offsetLeft,
           height: marker.offsetHeight || parseFloat(cs.lineHeight) || 16 };
}

export function collabPresenceColor(username) {
  const name = String(username || '');
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 65%, 45%)`;
}

export async function cancelCollabInvite(name) {
  if (!state.collab.groupId || !name) return;
  const res = await apiFetch(`/api/collab/groups/${state.collab.groupId}/members/${encodeURIComponent(name)}`, { method: 'DELETE' });
  if (!res.ok) { showToast('Could not cancel the invitation'); return; }
  state.collab.pending = (state.collab.pending || []).filter((n) => n !== name);
  renderCollabMembersModal();
  showToast(`Invitation to ${name} cancelled`);
}

export function closeCollabPending() {
  const overlay = document.getElementById('collab-pending-overlay');
  if (overlay) overlay.hidden = true;
}

export function openCollabPending() {
  if (!state.collab.noteId) return;
  renderCollabMembersModal();
  const overlay = document.getElementById('collab-pending-overlay');
  if (overlay) overlay.hidden = false;
}

// The Members popup: accepted members, plus invites for the owner.
export function renderCollabMembersModal() {
  const btn = document.getElementById('collab-pending');
  const me = state.cachedProfile && state.cachedProfile.username;
  const isOwner = state.collab.owner === me;
  // Owner always first; stable sort keeps the rest in join order.
  const members = [...(state.collab.members || [])].sort((a, b) => {
    if (a === state.collab.owner) return -1;
    if (b === state.collab.owner) return 1;
    return 0;
  });
  const pending = state.collab.pending || [];
  if (btn) {
    btn.classList.toggle('has-pending', isOwner && pending.length > 0);
    const extra = (isOwner && pending.length) ? ` · ${pending.length} invited` : '';
    btn.title = `Members (${members.length}${extra})`;
  }
  const list = document.getElementById('collab-pending-list');
  if (!list) return;
  const memberRows = members.map((name) => {
    const tags = `${name === me ? ' (you)' : ''}${name === state.collab.owner ? ' · owner' : ''}`;
    const canRemove = isOwner && name !== me;
    return `<div class="collab-pending-row"><span class="collab-pending-name">${escapeHtml(name)}${tags}</span>${canRemove ? `<button type="button" class="btn btn-secondary" data-remove-member="${escapeHtml(name)}">Remove</button>` : ''}</div>`;
  }).join('');
  let html = `<p class="collab-members-section">Members</p>${memberRows || '<p class="collab-pending-empty">No members yet.</p>'}`;
  // Only the owner sees who has not accepted yet (and can cancel invites).
  if (isOwner) {
    const pendingRows = pending.map((name) => `<div class="collab-pending-row"><span class="collab-pending-name">${escapeHtml(name)}</span><button type="button" class="btn btn-secondary" data-cancel-invite="${escapeHtml(name)}">Cancel</button></div>`).join('');
    html += `<p class="collab-members-section">Invited</p>${pendingRows || '<p class="collab-pending-empty">No pending invitations.</p>'}`;
  }
  list.innerHTML = html;
}

// Keep the shared recipe hero in step with the collaborative cover asset.
export function collabAssetsChanged() {
  if (!state.collab.noteId) return;
  const raw = state.collab.assets ? state.collab.assets.get('cover') : '';
  state.collab.cover = cleanCoverSrc(raw) || '';
  state.collab.description = state.collab.desc ? state.collab.desc.toString() : '';
  renderRecipeHero(null);
}

export function collabSyncDom() {
  if (!state.collab.doc) return;
  const titleStr = state.collab.title ? state.collab.title.toString() : '';
  if (titleInput && titleInput.value !== titleStr && document.activeElement !== titleInput) titleInput.value = titleStr;
  const bodyStr = state.collab.body ? state.collab.body.toString() : '';
  if (markdownInput && markdownInput.value !== bodyStr) {
    const start = markdownInput.selectionStart;
    markdownInput.value = bodyStr;
    try { markdownInput.setSelectionRange(Math.min(start, bodyStr.length), Math.min(start, bodyStr.length)); } catch (error) {}
    if (state.writeMode === 'preview') { try { preview.innerHTML = renderMarkdown(bodyStr); } catch (error) {} }
  }
  const descEl = document.getElementById('recipe-desc');
  if (descEl && state.collab.desc) {
    const descStr = state.collab.desc.toString();
    if (document.activeElement !== descEl && descEl.value !== descStr) descEl.value = descStr;
  }
}

export function setCollabStatus(text, offline) {
  const el = document.getElementById('collab-status');
  const textEl = document.getElementById('collab-status-text');
  const sep = document.getElementById('collab-status-sep');
  if (textEl) textEl.textContent = text;
  if (el) { el.hidden = false; el.style.color = offline ? '#c0453e' : ''; }
  if (sep) sep.hidden = false;
}

// Note "meta" (title + folder) is encrypted under the group key so the server
// still sees nothing. It powers the Shared inbox list without loading the doc.
// Unwrap a group's key from my membership (used by the inbox + note creation).
// Push the current title/folder (debounced) so the inbox list stays current.
export function scheduleCollabMeta() {
  if (!state.collab.noteId || !state.collab.key) return;
  clearTimeout(state.collab.metaTimer);
  state.collab.metaTimer = setTimeout(async () => {
    if (!state.collab.noteId || !state.collab.key) return;
    try {
      const encMeta = await collabEncryptMeta(state.collab.key, {
        title: state.collab.title ? state.collab.title.toString().slice(0, 200) : '',
        folder: state.collab.folder || '',
        template: state.collab.template || '',
        tags: state.collab.tags ? state.collab.tags.toArray().filter((x) => typeof x === 'string').slice(0, 20) : [],
      });
      await apiFetch(`/api/collab/notes/${state.collab.noteId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    } catch (error) {}
  }, 700);
}

// ---- Live collaborative notes (E2EE via Yjs) ------------------------------
// Shared sections: a group has a random key wrapped to each member. Notes live
// under the group; any note added there is automatically shared with everyone
// in the group. Edits are Yjs CRDT updates encrypted with the group key and
// relayed over a WebSocket. The server only relays ciphertext.
export function loadYjs() {
  if (!state.yjsPromise) state.yjsPromise = import('/vendor/yjs/yjs.mjs');
  return state.yjsPromise;
}

export async function sharingPublishSigningKey(pubB64, encPrivB64) {
  // Additive backfill: keep the existing ECDH key, add a signing key.
  try {
    const sig = await window.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const sigPub = new Uint8Array(await window.crypto.subtle.exportKey('raw', sig.publicKey));
    const sigPkcs8 = new Uint8Array(await window.crypto.subtle.exportKey('pkcs8', sig.privateKey));
    const res = await apiFetch('/api/keys', { method: 'POST', body: JSON.stringify({
      algo: 'ECDH-P256', pubkey: pubB64, encPriv: encPrivB64,
      sigPubkey: e2eeBytesToB64(sigPub),
      sigEncPriv: await sharingWrapAccountKey(sigPkcs8),
    }) });
    if (!res.ok) return false;
    state.sharing.signingKey = sig.privateKey;
    state.sharing.ready = true;
    return true;
  } catch (error) { return false; }
}

// Search a shared-note inbox entry. Title/folder/tags are in the decrypted meta;
// `body:` matches against a session cache of note bodies (populated whenever a
// shared note is opened — bodies live in the CRDT and aren't loaded for the list).
export function sharedNoteMatchesSearch(entry, query) {
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (!q) return true;
  const title = typeof entry.title === 'string' ? entry.title : '';
  const folder = typeof entry.folder === 'string' ? entry.folder : '';
  const tags = (Array.isArray(entry.tags) ? entry.tags : []).filter((t) => typeof t === 'string').map((t) => t.toLowerCase());
  const body = sharedBodyCache.get(String(entry.id)) || '';
  const tokens = q.split(/\s+/).filter(Boolean);
  const tagTerms = [];
  const bodyTerms = [];
  const textTerms = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'tag:') {
      const name = tokens[i + 1];
      if (!name) return false;
      tagTerms.push(name);
      i += 1;
    } else if (token.startsWith('tag:') && token.length > 4) {
      tagTerms.push(token.slice(4));
    } else if (token === 'body:') {
      const text = tokens[i + 1];
      if (!text) return false;
      bodyTerms.push(text);
      i += 1;
    } else if (token.startsWith('body:') && token.length > 5) {
      bodyTerms.push(token.slice(5));
    } else {
      textTerms.push(token);
    }
  }
  if (tagTerms.length && !tags.length) return false;
  const tagMatch = tagTerms.every((term) => tags.some((tag) => tag.includes(term)));
  const bodyHay = body.toLowerCase();
  const bodyMatch = bodyTerms.every((term) => bodyHay.includes(term));
  const haystack = `${title} ${folder}`.toLowerCase();
  const textMatch = textTerms.every((term) => haystack.includes(term));
  return tagMatch && bodyMatch && textMatch;
}
