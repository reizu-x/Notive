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
import { allCount, listEmpty, noteList, recentCountEl, starredCountEl, totalCount } from '../core/elements.js';
import { FOLDER_SEP, isFolderOrSub } from '../core/paths.js';
import { sanitizeIngredients, sanitizeSteps } from '../core/schema.js';
import { sharedGroupFolders, sharedGroupKeys, sharedGroupTags } from '../domain/constants.js';
import { renderPreview, renderRecipeBody } from '../ui/editor.js';
import { updateBinUI } from '../ui/notes.js';
import { collabCreateSection, sharedFolderTree, updateFoldToggle } from '../ui/sections.js';
import { seedFromTemplate } from '../ui/shell.js';
import { renderStripItems, renderTabs, trackTab, updateBreadcrumbs } from '../ui/tabs.js';
import { renderSharedTags } from '../ui/tags.js';
import { updateVaultUI } from '../ui/vault.js';
import { rekeyInFlight } from '../domain/constants.js';
import { setDeleteDialog } from '../ui/notes.js';
import { rotateGroupSection } from '../ui/sections.js';
import { refreshEditorLock } from '../ui/auth.js';
import { openTemplatePicker } from '../ui/editor.js';



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
  // Align the note's icon under its folder's icon (folder rows carry a
  // chevron). Depth-driven padding is applied post-insertion (strict CSP).
  const glyph = (n.template && NOTE_TEMPLATES[n.template] && NOTE_TEMPLATES[n.template].icon) ? NOTE_TEMPLATES[n.template].icon : 'file';
  const deleteAction = canDelete
    ? `<span class="tree-action danger" data-collab-note-delete="${n.id}" role="button" title="Delete note" aria-label="Delete ${escapeHtml(title)}">${icon('trash')}</span>`
    : '';
  return `<button class="tree-file shared-view-row${String(state.collab.noteId) === String(n.id) ? ' selected' : ''}" draggable="true" data-collab-open="${n.id}" data-collab-group="${groupId}" title="${escapeHtml(title)}">
      <span class="tree-file-icon">${icon(glyph)}</span>
      <span class="tree-file-name">${highlightShared(title)}</span>
      <span class="tree-action" data-note-folder="${n.id}" data-note-group="${groupId}" role="button" title="Move to folder" aria-label="Move ${escapeHtml(title)} to a folder">${icon('folder-plus')}</span>
      ${deleteAction}
    </button>`;
}

function highlightShared(text) {
  const raw = String(text || '');
  const q = String(state.searchQuery || '').trim();
  if (!q) return escapeHtml(raw);
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean).filter((t) => !t.startsWith('tag:') && !t.startsWith('body:') && t !== 'tag:' && t !== 'body:');
  if (!tokens.length) return escapeHtml(raw);
  let html = escapeHtml(raw);
  tokens.forEach((tok) => {
    const esc = tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { html = html.replace(new RegExp(`(${esc})`, 'gi'), '<mark>$1</mark>'); } catch (error) {}
  });
  return html;
}

// Toggle the highlight on the currently open shared note without re-rendering
// the whole list (rows carry data-collab-open ids).
function updateSharedSelection() {
  const box = document.getElementById('shared-view-list');
  if (!box) return;
  box.querySelectorAll('[data-collab-open]').forEach((row) => {
    const open = String(state.collab.noteId) === String(row.dataset.collabOpen);
    row.classList.toggle('selected', open);
  });
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
  updateSharedSelection();
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

const PRESENCE_COLOR_RE = /^hsl\(\d{1,3}(?:\.\d+)?, ?\d{1,3}%, ?\d{1,3}%\)$/;

// Peer-supplied presence colors are interpolated into style attributes below;
// validate them (XSS boundary: an accepted collaborator can send arbitrary
// content inside the E2EE channel, so the value can never be trusted).
function safePresenceColor(color) {
  return (typeof color === 'string' && PRESENCE_COLOR_RE.test(color.trim())) ? color.trim() : '#888';
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
    color: safePresenceColor(data.c),
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
    const self = `<span class="collab-presence-chip${state.collab.typing ? ' is-typing' : ''}"><span class="collab-presence-dot" data-dot-color="${state.collab.color || '#888'}"></span>${escapeHtml(meName)} (you)${state.collab.typing ? ' · typing…' : ''}</span>`;
    box.innerHTML = self + entries.map((p) => `<span class="collab-presence-chip${p.typing ? ' is-typing' : ''}"><span class="collab-presence-dot" data-dot-color="${safePresenceColor(p.color)}"></span>${escapeHtml(p.user || 'Someone')}${p.typing ? ' · typing…' : ''}</span>`).join('');
    // CSP (style-src has no 'unsafe-inline'): colors applied as element styles.
    box.querySelectorAll('[data-dot-color]').forEach((el) => {
      try { el.style.background = safePresenceColor(el.dataset.dotColor); } catch (error) {}
    });
  }
  if (layer) {
    if (state.writeMode !== 'edit') { layer.innerHTML = ''; }
    else {
      layer.innerHTML = entries.map((p) => {
        const c = collabCaretCoords(p.s);
        if (!c) return '';
        const pc = safePresenceColor(p.color);
        return `<div class="collab-caret" data-caret-color="${pc}" data-caret-top="${c.top}" data-caret-left="${c.left}" data-caret-height="${c.height}"><span class="collab-caret-label">${escapeHtml(p.user || '')}</span></div>`;
      }).join('');
    }
    // CSP (style-src has no 'unsafe-inline'): geometry/colors applied after.
    layer.querySelectorAll('.collab-caret').forEach((el) => {
      const n = (k) => `${Number(el.dataset[k] || 0)}px`;
      try {
        el.style.top = n('caretTop');
        el.style.left = n('caretLeft');
        el.style.height = n('caretHeight');
        el.style.background = safePresenceColor(el.dataset.caretColor);
        const label = el.querySelector('.collab-caret-label');
        if (label) label.style.background = safePresenceColor(el.dataset.caretColor);
      } catch (error) {}
    });
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


export async function declineInvite(id) {
  const me = state.cachedProfile && state.cachedProfile.username;
  const res = await apiFetch(`/api/collab/groups/${encodeURIComponent(id)}/members/${encodeURIComponent(me)}`, { method: 'DELETE' });
  if (res.ok) { showToast('Invitation declined'); renderSharedView(); }
  else showToast('Could not decline the invitation');
}

export async function acceptInvite(id) {
  const res = await apiFetch(`/api/collab/groups/${encodeURIComponent(id)}/accept`, { method: 'POST', body: '{}' });
  if (res.ok) { showToast('Invitation accepted'); renderSharedView(); }
  else showToast('Could not accept the invitation');
}

export async function moveSharedNote(noteId, groupId) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  const entry = sharedNoteMeta.get(String(noteId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const value = await askInput({ eyebrow: 'Folder', title: 'Move to folder', desc: 'Type a folder name, or "Parent / Child" to nest.', label: 'Folder', password: false, placeholder: 'e.g. Ideas / 2026', okText: 'Move' });
  if (value == null) return;
  const folder = String(value).trim().replace(/\s*\/\s*/g, FOLDER_SEP).replace(/^\/+|\/+$/g, '').slice(0, 180);
  try {
    const encMeta = await collabEncryptMeta(key, { title: (entry && entry.title) || '', folder });
    const res = await apiFetch(`/api/collab/notes/${noteId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    if (!res.ok) { showToast('Could not move the note'); return; }
    if (state.collab.noteId === Number(noteId) || String(state.collab.noteId) === String(noteId)) state.collab.folder = folder;
    showToast(folder ? `Moved to ${folder}` : 'Moved to the section root');
    renderSharedView();
  } catch (error) { showToast('Could not move the note'); }
}

export async function renderSharedView() {
  updateBinUI();
  updateVaultUI();
  updateBreadcrumbs();
  const emptyTitle = listEmpty.querySelector('strong');
  const emptySub = listEmpty.querySelector('span:last-child');
  noteList.hidden = false;
  listEmpty.hidden = true;
  if (totalCount) totalCount.textContent = 'Shared notes';
  if (allCount) allCount.textContent = '0';
  if (recentCountEl) recentCountEl.textContent = '0';
  if (starredCountEl) starredCountEl.textContent = '0';
  const headerNew = document.getElementById('shared-new');
  if (headerNew) headerNew.hidden = false;
  const headerRefresh = document.getElementById('refresh-view');
  if (headerRefresh) headerRefresh.hidden = false;
  noteList.innerHTML = `<div class="list-section">
      <div class="list-section-head">
        <span class="list-section-title">People</span>
      </div>
      <div id="shared-view-list"><p class="modal-desc shared-pad">Loading…</p></div>
    </div>`;
  const box = document.getElementById('shared-view-list');
  if (!e2ee.masterKey) { if (box) box.innerHTML = '<p class="modal-desc shared-pad">Log in and unlock your notes first.</p>'; return; }
  let res;
  try { res = await apiFetch('/api/collab/groups'); } catch (error) { res = null; }
  if (!res || !res.ok) { if (box) box.innerHTML = '<p class="modal-desc shared-pad">Could not load shared sections.</p>'; return; }
  const data = await res.json();
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const invites = Array.isArray(data.invites) ? data.invites : [];
  setSharedNavCount(groups.length + invites.length);
  const me = state.cachedProfile && state.cachedProfile.username;
  const query = state.searchQuery.trim();
  const searching = query !== '';
  // Invitations render first and independently of key handling (hidden while searching).
  const invitesHtml = (!searching && invites.length) ? `<div class="list-section">
      <div class="list-section-head"><span class="list-section-title">Invitations</span><span class="shared-group-count">${invites.length}</span></div>
      ${invites.map((inv) => `<div class="shared-invite">
        <span class="shared-invite-text"><strong>${escapeHtml(inv.owner)}</strong> wants to connect with you</span>
        <button type="button" class="btn btn-primary shared-action" data-invite-accept="${inv.id}">Accept</button>
        <button type="button" class="btn btn-secondary shared-action" data-invite-decline="${inv.id}">Decline</button>
      </div>`).join('')}
    </div>` : '';
  if (!groups.length) {
    sharedGroupFolders.clear();
    sharedNoteMeta.clear();
    box.innerHTML = invitesHtml || '<p class="modal-desc shared-pad">No connections yet. Click + New connection and enter a username to start.</p>';
    updateFoldToggle();
    return;
  }
  if (!(await sharingEnsureKeys())) {
    box.innerHTML = invitesHtml + '<p class="modal-desc shared-pad">Could not unlock your sharing keys — reopen Shared to retry.</p>';
    updateFoldToggle();
    return;
  }
  sharedGroupKeys.clear();
  sharedGroupFolders.clear();
  sharedNoteMeta.clear();

  const groupBlocks = [];
  let totalMatches = 0;
  for (const g of groups) {
    const isOwner = g.owner === me;
    const displayName = isOwner ? (g.name || 'Shared') : g.owner;
    let key = null;
    try { key = (await collabGroupKey(g.id)).key; sharedGroupKeys.set(g.id, key); }
    catch (error) { /* cannot decrypt (rare) */ }
    let groupFolders = [];
    let groupTags = [];
    if (key) { try { const gm = await collabDecryptGroupMeta(key, g.encMeta || ''); groupFolders = gm.folders; groupTags = gm.tags; } catch (error) {} }
    sharedGroupFolders.set(g.id, groupFolders);
    sharedGroupTags.set(g.id, groupTags);
    sharedGroupOwners.set(g.id, g.owner);
    const rawNotes = Array.isArray(g.notes) ? g.notes : [];
    const decoded = [];
    for (const n of rawNotes) {
      let meta = { title: '', folder: '', template: '' };
      if (key) { try { meta = await collabDecryptMeta(key, n.encMeta || ''); } catch (error) {} }
      const entry = { id: n.id, title: meta.title, folder: meta.folder, template: meta.template, tags: meta.tags || [], groupId: g.id };
      sharedNoteMeta.set(String(n.id), entry);
      decoded.push(entry);
    }
    // After decoding this render, a flagged section (member left / account
    // deleted) is re-keyed in the background by a remaining member.
    if (key && g.rekeyNeeded) rekeyGroupIfNeeded(g, key);
    let visible = searching ? decoded.filter((entry) => sharedNoteMatchesSearch(entry, query)) : decoded;
    // Strip folder scope: show this section's folder subtree only (folder ''
    // = root-level notes). Sections outside the selection stay visible.
    if (!searching && state.sharedFolder && String(state.sharedFolder.groupId) === String(g.id)) {
      const f = state.sharedFolder.folder;
      visible = f
        ? visible.filter((n) => (n.folder || '') === f || isFolderOrSub(n.folder || '', f))
        : visible.filter((n) => !(n.folder));
    }
    if ((searching || state.sharedFolder) && !visible.length) {
      if (searching) continue;
      if (String(state.sharedFolder.groupId) === String(g.id)) {
        groupBlocks.push(`<div class="shared-group">
          <div class="shared-group-head">
            <span class="shared-group-name">${escapeHtml(displayName)}</span>
          </div>
          <p class="modal-desc shared-folder-empty">No notes in this folder yet.</p>
        </div>`);
        continue;
      }
      continue;
    }
    totalMatches += visible.length;
    groupBlocks.push(`<div class="shared-group">
      <div class="shared-group-head">
        <span class="shared-group-name">${escapeHtml(displayName)}</span>
        <span class="shared-group-count">${searching ? visible.length : decoded.length}</span>
        <button type="button" class="shared-group-add" data-group-addfolder="${g.id}" title="Add a folder to ${escapeHtml(displayName)}" aria-label="Add a folder to ${escapeHtml(displayName)}">${icon('folder-plus')}</button>
        ${isOwner
          ? `<button type="button" class="shared-icon" data-group-settings="${g.id}" title="Section settings" aria-label="Section settings for ${escapeHtml(displayName)}">${icon('settings')}</button>`
            + `<button type="button" class="shared-icon danger" data-group-delete="${g.id}" title="Delete section" aria-label="Delete section">${icon('trash')}</button>`
          : `<button type="button" class="shared-icon" data-group-leave="${g.id}" title="Leave section" aria-label="Leave section">${icon('logout')}</button>`}
      </div>
      ${sharedFolderTree(visible, g.id, searching ? [] : groupFolders, isOwner)}
    </div>`);
  }
  let html = invitesHtml + groupBlocks.join('');
  if (searching && totalMatches === 0) html = `<p class="modal-desc shared-search-empty">No shared notes match “${escapeHtml(query)}”.</p>`;
  box.innerHTML = html;
  updateFoldToggle();
  try { renderTabs(); } catch (error) {}
  // The strip + breadcrumb read sharedGroupFolders, which was just repopulated
  // — refresh them here so they never race ahead of the decrypted metadata.
  try { renderStripItems(); } catch (error) {}
  try { updateBreadcrumbs(); } catch (error) {}
}

export async function confirmCollabNew() {
  const input = document.getElementById('collab-new-members');
  const me = state.cachedProfile && state.cachedProfile.username;
  const names = parseUsernames(input ? input.value : '').filter((n) => /^[A-Za-z0-9_-]{3,32}$/.test(n) && n !== me);
  if (!names.length) { setCollabNewStatus('Enter at least one valid username (not your own).'); return; }
  if (!(await sharingEnsureKeys())) { setCollabNewStatus('Could not set up sharing keys.'); return; }
  const btn = document.getElementById('collab-new-create');
  if (btn) btn.disabled = true;
  setCollabNewStatus('Sending…');
  try {
    await collabCreateSection(names);
    closeCollabNewDialog();
  } catch (error) {
    setCollabNewStatus(error && error.message ? error.message : 'Could not create the section.');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function collabDeleteGroup(groupId) {
  const res = await apiFetch(`/api/collab/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
  if (res.ok) { if (String(state.collab.groupId) === String(groupId)) closeCollabNote(); showToast('Shared section deleted'); if (state.activeView === 'shared') renderSharedView(); }
  else showToast('Could not delete the section');
}

export async function collabDeleteNote(noteId) {
  const me = state.cachedProfile && state.cachedProfile.username;
  if (state.collab.noteId != null && String(state.collab.noteId) === String(noteId) && state.collab.owner !== me) {
    showToast('Only the owner can delete a shared note');
    return;
  }
  const res = await apiFetch(`/api/collab/notes/${encodeURIComponent(noteId)}`, { method: 'DELETE' });
  if (res.ok) {
    if (state.collab.noteId === Number(noteId) || String(state.collab.noteId) === String(noteId)) closeCollabNote();
    state.openTabs = state.openTabs.filter((tab) => !(tab.shared && String(tab.id) === String(noteId)));
    try { renderTabs(); } catch (error) {}
    if (state.activeView === 'shared') renderSharedView();
  } else {
    let msg = 'Could not delete the note';
    try { const d = await res.json(); if (d && d.error) msg = d.error; } catch (error) {}
    showToast(msg);
  }
}

// Start a shared note from the same templates used by All Notes.
export async function createSharedNoteWithTemplate(groupId, folder, templateKey) {
  const key0 = NOTE_TEMPLATES[templateKey] ? templateKey : 'standard';
  if (!e2ee.masterKey) { showToast('Log in and unlock your notes first'); return; }
  if (!(await sharingEnsureKeys())) { showToast('Could not unlock your sharing keys'); return; }
  let key;
  try { key = (await collabGroupKey(groupId)).key; }
  catch (error) { showToast('You no longer have access to this section'); return; }
  const seed = seedFromTemplate(key0, sharedUniqueTitle(NOTE_TEMPLATES[key0].titleBase, groupId));
  const encMeta = await collabEncryptMeta(key, { title: seed.title, folder: folder || '', template: key0 });
  const res = await apiFetch(`/api/collab/groups/${groupId}/notes`, { method: 'POST', body: JSON.stringify({ encMeta }) });
  if (!res.ok) { showToast('Could not create the note'); return; }
  const note = await res.json();
  // Seed the template title + body as the note's first CRDT update, so the
  // editor and every member joining later start from the (possibly edited)
  // template instead of racing a post-connect insert.
  try {
    const Y = await loadYjs();
    const doc = new Y.Doc();
    doc.getText('title').insert(0, seed.title);
    if (seed.body) doc.getText('body').insert(0, seed.body);
    const template = NOTE_TEMPLATES[key0];
    if (key0 === 'recipe' && template.recipe) {
      doc.getMap('recipe').set('ingredients', JSON.stringify(sanitizeIngredients(template.recipe.ingredients)));
      doc.getMap('recipe').set('steps', JSON.stringify(sanitizeSteps(template.recipe.steps)));
    }
    const update = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    const payload = await collabEncrypt(key, update);
    await apiFetch(`/api/collab/notes/${note.id}/updates`, { method: 'POST', body: JSON.stringify({ payload, keyVersion: 1 }) });
  } catch (error) {}
  await openCollabNote(note.id);
  if (state.activeView === 'shared') renderSharedView();
}

// New-note entry in the Shared tree: ask which template to start from first.
export function openSharedNewNote(groupId, folder) {
  state.pendingSharedTemplate = { groupId, folder: folder || '' };
  openTemplatePicker();
}

export async function openCollabNote(noteId) {
  if (!e2ee.masterKey) { showToast('Log in and unlock your notes first'); return; }
  if (!(await sharingEnsureKeys())) { showToast('Could not unlock your sharing keys'); return; }
  let res;
  try { res = await apiFetch(`/api/collab/notes/${noteId}`); } catch (error) { res = null; }
  if (!res || !res.ok) { showToast('Cannot open that shared note'); return; }
  const meta = await res.json();
  let keyRaw;
  try { keyRaw = await unwrapMyKey(meta.myKey, meta.groupId, state.cachedProfile && state.cachedProfile.username, meta.myKeyVersion); }
  catch (error) { showToast(error && error.message ? error.message : 'You no longer have access to this note'); return; }
  // Group metadata gives the section name + members.
  let group = { name: '', members: [] };
  try { const g = await apiFetch(`/api/collab/groups/${meta.groupId}`); if (g.ok) group = await g.json(); } catch (error) {}
  // Section-level tags/folders (owner-curated) so the tag editor can suggest them.
  if (group.encMeta) {
    try {
      const gm = await collabDecryptGroupMeta(keyRaw, group.encMeta);
      sharedGroupTags.set(meta.groupId, gm.tags || []);
      if (!sharedGroupFolders.has(meta.groupId)) sharedGroupFolders.set(meta.groupId, gm.folders || []);
      sharedGroupOwners.set(meta.groupId, meta.owner);
    } catch (error) {}
  }
  const Y = await loadYjs();
  closeCollabNote();
  const doc = new Y.Doc();
  let noteMeta = { title: '', folder: '', template: '', tags: [] };
  try { noteMeta = await collabDecryptMeta(keyRaw, meta.encMeta || ''); } catch (error) {}
  Object.assign(state.collab, {
    noteId, groupId: meta.groupId, doc,
    title: doc.getText('title'), body: doc.getText('body'), desc: doc.getText('desc'),
    assets: doc.getMap('assets'), recipe: doc.getMap('recipe'), tags: doc.getArray('tags'), cover: '', description: '',
    es: null, key: keyRaw, keyVersion: Number(meta.keyVersion) || 1,
    keys: new Map([[Number(meta.keyVersion) || 1, keyRaw]]),
    members: group.members || [], pending: group.pending || [], owner: meta.owner, groupName: group.name || '',
    folder: noteMeta.folder || '', template: noteMeta.template || '', updates: 0,
  });
  doc.on('update', (update, origin) => {
    if (origin === 'remote') return;
    state.collab.updates += 1;
    collabBroadcast(update);
    if (state.collab.updates % 40 === 0) collabCompact();
  });
  state.collab.title.observe(collabSyncDom);
  state.collab.body.observe(collabSyncDom);
  state.collab.desc.observe(collabSyncDom);
  state.collab.assets.observe(collabAssetsChanged);
  state.collab.recipe.observe((event, transaction) => { if (transaction && transaction.origin === 'remote') renderRecipeBody(null); });
  state.collab.tags.observe(() => { renderSharedTags(); scheduleCollabMeta(); });
  state.collab.body.observe(() => { if (state.collab.noteId != null) sharedBodyCache.set(String(state.collab.noteId), state.collab.body.toString()); });
  sharedBodyCache.set(String(noteId), state.collab.body.toString());
  renderSharedTags();
  const delBtn = document.getElementById('collab-delete');
  if (delBtn) delBtn.hidden = !(state.collab.owner === (state.cachedProfile && state.cachedProfile.username));
  // Bind the standard editor to the shared doc (title + Markdown body).
  state.writeMode = 'edit';
  if (titleInput) titleInput.value = state.collab.title.toString();
  if (markdownInput) markdownInput.value = state.collab.body.toString();
  try { refreshEditorLock(); } catch (error) {}
  // refreshEditorLock bails out for shared notes, so enable the recipe hero
  // controls here (a shared recipe is always editable while it is open).
  const recipeDesc = document.getElementById('recipe-desc');
  if (recipeDesc) recipeDesc.disabled = false;
  const recipePhotoBtn = document.getElementById('recipe-photo-btn');
  if (recipePhotoBtn) recipePhotoBtn.disabled = false;
  try { renderRecipeHero(null); } catch (error) {}
  try { collabAssetsChanged(); } catch (error) {}
  try { renderPreview(null); } catch (error) {}
  try { markdownInput.focus({ preventScroll: true }); } catch (error) {}
  renderCollabMembersModal();
  // Presence: a stable per-open client id + colour, then a heartbeat loop that
  // broadcasts our cursor and prunes stale peers.
  state.collab.clientId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `c${Date.now()}${Math.random()}`;
  state.collab.color = collabPresenceColor(state.cachedProfile && state.cachedProfile.username);
  state.collab.typing = false;
  state.collab.presence.clear();
  if (state.collab.presenceTimer) { clearTimeout(state.collab.presenceTimer); state.collab.presenceTimer = null; }
  collabPresenceHeartbeat();
  // Only the owner may invite members.
  const inviteBtn = document.getElementById('collab-invite');
  if (inviteBtn) inviteBtn.hidden = !(state.collab.owner === (state.cachedProfile && state.cachedProfile.username));
  setCollabStatus('Connecting…', false);
  const collabTop = document.getElementById('collab-top');
  if (collabTop) collabTop.hidden = false;
  const editorPanel = document.querySelector('.editor-panel');
  if (editorPanel) editorPanel.classList.add('collab-mode');
  trackTab(noteId, false, true);
  updateSharedSelection();
  try { renderTabs(); } catch (error) {}
  collabConnect(noteId, keyRaw, Y, doc);
}

export function collabConnect(noteId, keyRaw, Y, doc) {
  if (state.collab.es) { try { state.collab.es.close(); } catch (error) {} state.collab.es = null; }
  let es;
  try { es = new EventSource(`/api/collab/notes/${noteId}/stream`); }
  catch (error) { setCollabStatus('Could not connect', true); return; }
  state.collab.es = es;
  es.onopen = () => { setCollabStatus('Live · connected', false); flushCollabOutbox(); };
  es.onmessage = async (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch (error) { return; }
    if (msg.type === 'closed') { setCollabStatus('This note was closed', true); return; }
    if (msg.type === 'rekey') {
      // Owner rotated the section key: adopt the new epoch so our edits are
      // encrypted under the key the removed member does not have.
      await collabAdoptRekey(msg.version);
      return;
    }
    if (msg.type === 'presence') { collabPresenceReceive(msg); return; }
    if (msg.type !== 'state' && msg.type !== 'update') return;
    const key = collabKeyFor(msg.version);
    if (!key) return;
    try { Y.applyUpdate(doc, await collabDecrypt(key, msg.payload), 'remote'); } catch (error) {}
  };
  // EventSource auto-reconnects; the stream replays state + backlog on reconnect.
  es.onerror = () => { if (state.collab.noteId === noteId) setCollabStatus('Offline — retrying…', true); };
}

export async function flushCollabOutbox() {
  if (state.collab.flushing || !state.collab.outbox.length || !state.collab.key || !state.collab.noteId) return;
  state.collab.flushing = true;
  try {
    while (state.collab.outbox.length) {
      const update = state.collab.outbox[0];
      let res;
      try {
        const payload = await collabEncrypt(state.collab.key, update);
        res = await apiFetch(`/api/collab/notes/${state.collab.noteId}/updates`, {
          method: 'POST', body: JSON.stringify({ payload, keyVersion: state.collab.keyVersion }) });
      } catch (error) {
        setCollabStatus(`Offline — ${state.collab.outbox.length} unsent`, true);
        scheduleCollabFlush();
        return;
      }
      if (res.ok) { state.collab.outbox.shift(); continue; }
      if (res.status === 409) {
        // Epoch changed under us: drop the stale queue and push the full state.
        state.collab.outbox.length = 0;
        await collabCompact();
        return;
      }
      setCollabStatus(`Offline — ${state.collab.outbox.length} unsent`, true);
      scheduleCollabFlush();
      return;
    }
    setCollabStatus('Live · connected', false);
  } finally {
    state.collab.flushing = false;
  }
}

export function scheduleCollabFlush() {
  if (state.collab.flushTimer || !state.collab.noteId) return;
  state.collab.flushTimer = setTimeout(() => { state.collab.flushTimer = null; flushCollabOutbox(); }, 5000);
}

// Local edits go through an outbox so nothing is lost while offline or when a
// POST fails: queued Yjs updates are retried until the server acks them. A 409
// means the section key moved under us, so the full local state is compacted
// instead (which also clears the queue).
export async function collabBroadcast(update) {
  if (!state.collab.key || !state.collab.noteId) return;
  state.collab.outbox.push(update);
  if (state.collab.outbox.length >= 200) { state.collab.outbox.length = 0; collabCompact(); return; }
  flushCollabOutbox();
}


// Popup: ask who the new shared section is for.
export function parseUsernames(raw) {
  // Owner + invitees must stay within the 4-member section cap.
  return String(raw || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 3);
}

export function confirmDeleteGroup(groupId) {
  state.pendingDeleteId = String(groupId);
  state.pendingDeleteMode = 'collab-group';
  state.pendingDeleteTag = null;
  setDeleteDialog({ eyebrow: 'Delete section', title: 'Delete this shared section?', name: 'This section', message: '” and all its notes will be deleted for everyone. This cannot be undone.' });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

export async function rekeyGroupIfNeeded(group, key) {
  if (!group || !key || !group.rekeyNeeded || rekeyInFlight.has(group.id)) return;
  // Only a member holding the current epoch may rotate. A stale wrap (e.g. an
  // invite accepted after a rekey) must not rotate — it would re-encrypt with an
  // old key and lose content. Another member rotates and re-wraps us instead.
  if (Number(group.myKeyVersion) !== Number(group.keyVersion)) return;
  rekeyInFlight.add(group.id);
  try {
    const ok = await rotateGroupSection({
      groupId: group.id, key, version: group.keyVersion,
      members: group.members || [], notes: group.notes || [], folderMeta: group.encMeta || '' });
    if (ok) showToast('Section key rotated after a member left');
  } finally {
    rekeyInFlight.delete(group.id);
  }
}

export async function sharingEnsureKeysOnce() {
  if (state.sharing.ready && state.sharing.privateKey && state.sharing.signingKey) return true;
  if (!e2ee.masterKey) return false;
  try {
    const res = await apiFetch('/api/keys/me');
    if (res.ok) {
      const data = await res.json();
      if (data && data.exists && data.encPriv && data.pubkey) {
        state.sharing.privateKey = await sharingUnwrapAccountKey(data.encPriv, 'ECDH');
        if (data.sigEncPriv && data.sigPubkey) {
          state.sharing.signingKey = await sharingUnwrapAccountKey(data.sigEncPriv, 'ECDSA');
          state.sharing.ready = true;
          return true;
        }
        return await sharingPublishSigningKey(data.pubkey, data.encPriv);
      }
    }
  } catch (error) { /* fall through and (re)generate */ }
  return sharingGenerateKeys();
}

export async function sharingGenerateKeys() {
  try {
    const ecdh = await window.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey']);
    const sig = await window.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = new Uint8Array(await window.crypto.subtle.exportKey('raw', ecdh.publicKey));
    const ecdhPkcs8 = new Uint8Array(await window.crypto.subtle.exportKey('pkcs8', ecdh.privateKey));
    const sigPub = new Uint8Array(await window.crypto.subtle.exportKey('raw', sig.publicKey));
    const sigPkcs8 = new Uint8Array(await window.crypto.subtle.exportKey('pkcs8', sig.privateKey));
    const pubRes = await apiFetch('/api/keys', { method: 'POST', body: JSON.stringify({
      algo: 'ECDH-P256',
      pubkey: e2eeBytesToB64(pub),
      encPriv: await sharingWrapAccountKey(ecdhPkcs8),
      sigPubkey: e2eeBytesToB64(sigPub),
      sigEncPriv: await sharingWrapAccountKey(sigPkcs8),
    }) });
    if (!pubRes.ok) return false;
    state.sharing.privateKey = ecdh.privateKey;
    state.sharing.signingKey = sig.privateKey;
    state.sharing.ready = true;
    return true;
  } catch (error) { return false; }
}

export function sharingEnsureKeys() {
  // Single-flight: concurrent callers must never generate two different
  // keypairs (the published public key could stop matching the in-memory key).
  if (state.sharing.ready && state.sharing.privateKey && state.sharing.signingKey) return Promise.resolve(true);
  if (state.sharingKeyPromise) return state.sharingKeyPromise;
  state.sharingKeyPromise = sharingEnsureKeysOnce().finally(() => { state.sharingKeyPromise = null; });
  return state.sharingKeyPromise;
}
