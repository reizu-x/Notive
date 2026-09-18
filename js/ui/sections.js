// js/ui/sections.js — custom sections & folders: data hygiene, palette
// mapping, unique ids, rename/delete flows, tree helpers, context menus.

import { foldToggle } from '../core/elements.js';
import { icon } from '../core/icons.js';
import { FOLDER_SEP, MAX_SUBFOLDER_PARENT_DEPTH, folderDepth, folderLeaf, folderParent, isFolderOrSub } from '../core/paths.js';
import { escapeHtml } from '../core/strings.js';
import { apiFetch } from '../data/api.js';
import { collabDecrypt, collabDecryptGroupMeta, collabDecryptMeta, collabEncrypt, collabEncryptGroupMeta, collabEncryptMeta, collabKeyFor, loadYjs, sharedGroupOwnerOf, sharedNoteRow, sharingRecipientPublicKey, signWrap, wrapRawKeyFor } from '../data/collab-crypto.js';
import { e2eeRandomBytes } from '../data/crypto.js';
import { COLLECTION_COLORS, SECTION_ICONS, sharedCollapsed, sharedGroupFolders, sharedGroupKeys, sharedGroupTags, sharedGroupsCache, sharedNoteMeta } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { showToast } from './modal.js';
import { setDeleteDialog } from './notes.js';
import { normalizeTagName, sharedGroupTagList } from './tags.js';
import { BIN_RETENTION_MS } from '../core/dates.js';
import { noteList } from '../core/elements.js';
import { cleanFolderPath, folderIconForDepth, joinLeafRename } from '../core/paths.js';
import { MIGRATED_COLLECTIONS_SECTION_ID } from '../core/schema.js';
import { collabAddGroupMember, collabCreate, renderSharedView, updateSharedNoteMeta } from '../data/collab-crypto.js';
import { e2ee } from '../data/crypto.js';
import { cleanVaultFolderInput } from '../data/vault.js';
import { DEFAULT_CUSTOM_FOLDERS } from '../domain/constants.js';
import { askInput } from './modal.js';
import { clearEditor, clearSearch, closeNoteContextMenu, createNoteFromTemplate, firstFilingOf, persistNotes, renderNoteList, selectNote } from './notes.js';
import { slideMenuCollapsed } from './shell.js';
import { persistUiVault } from './vault.js';
import { findTreeWrap } from './editor.js';
import { openTemplatePicker } from './editor.js';
import { updateListHeading } from './notes.js';

// Clear section/folder filters and sidebar highlights (unified custom implementation).
export function clearSectionSelection() {
  state.activeCustom = null;
  document.querySelectorAll('#custom-sections .collection-item').forEach((item) => item.classList.remove('active'));
}

// Display name of a sidebar section (all sections share the custom implementation).
export function sectionDisplayName(kind, id) {
  const sectionId = kind === 'custom' ? id : kind;
  const section = state.customSections.find((entry) => entry.id === sectionId);
  return section ? section.name : 'Section';
}

// Display name of a sidebar section.
// True in Starred view, whether reached via the nav item (activeView) or
// the Starred chip (notes view + favorites filter).
export function isFavoritesView() {
  return state.activeView === 'favorites'
    || (state.activeView === 'notes' && state.activeFilter === 'favorites');
}

// Display folder of a note inside one custom section (null when unassigned).
export function customNoteFolder(note, sectionId) {
  if (!note || !note.sections || typeof note.sections !== 'object') return null;
  const folder = note.sections[sectionId];
  return typeof folder === 'string' && folder.trim() ? folder : null;
}

export function updateFoldToggle() {
  if (!foldToggle) return;
  const inShared = state.activeView === 'shared';
  const paths = inShared ? sharedAllFolderKeys() : visibleFolderPaths();
  const collapsed = inShared ? sharedCollapsed : state.collapsedFolders;
  const anyOpen = paths.some((folder) => !collapsed.has(folder));
  foldToggle.classList.toggle('is-expanded', anyOpen);
  const label = anyOpen ? 'Collapse all folders' : 'Expand all folders';
  foldToggle.setAttribute('aria-label', label);
  foldToggle.setAttribute('title', label);
}

export function visibleFolderPaths() {
  const paths = new Set();
  state.notes.forEach((note) => {
    if (note.deleted || note.archived) return;
    if (note.sections && typeof note.sections === 'object') {
      Object.values(note.sections).forEach((folder) => {
        if (typeof folder === 'string' && folder.trim()) paths.add(folder);
      });
    }
  });
  state.customSections.forEach((section) => section.folders.forEach((folder) => paths.add(folder)));
  return [...paths];
}

export function closeFolderPicker() {
  const overlay = document.getElementById('folder-pick-overlay');
  if (overlay) overlay.hidden = true;
}

// Order picker entries like the expanded workspace note list: a parent is
// followed immediately by all its children (recursively), matching the
// strip's tree grouping. Roots/orphans keep the section's list order.
export function orderFoldersLikeWorkspace(folders) {
  const childrenOf = new Map();
  const roots = [];
  folders.forEach((name) => {
    const parent = folderParent(name);
    if (parent && folders.includes(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(name);
    } else roots.push(name);
  });
  const out = [];
  const emit = (name) => {
    if (out.includes(name)) return;
    out.push(name);
    (childrenOf.get(name) || []).forEach(emit);
  };
  roots.forEach(emit);
  folders.forEach(emit);
  return out;
}

export function openVaultFolderDeleteConfirm(folder) {
  const count = state.vault.notes.filter((note) => note.folder === folder).length;
  state.pendingDeleteId = folder;
  state.pendingDeleteMode = 'vault-folder';
  setDeleteDialog({
    eyebrow: 'Delete vault folder',
    title: 'Delete this folder?',
    name: folder,
    message: count
      ? `” holds ${count} secret note${count === 1 ? '' : 's'}. The notes stay in the Vault. Are you sure?`
      : '” is empty. Are you sure you want to delete it?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

export function confirmDeleteSharedFolder(groupId, folder) {
  state.pendingDeleteId = String(groupId);
  state.pendingDeleteMode = 'shared-folder';
  state.pendingDeleteSection = folder;
  setDeleteDialog({ eyebrow: 'Delete folder', title: 'Delete this folder?', name: folderLeaf(folder), message: '” will be removed from the shared section; its notes move to the section root.' });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) { overlay.hidden = false; const b = document.getElementById('confirm-delete'); if (b) b.focus(); }
}

export function sectionTagRemove(name) {
  if (state.sectionSettingsGroupId == null) return;
  const tags = sharedGroupTagList(state.sectionSettingsGroupId);
  const next = tags.filter((t) => String(t).toLowerCase() !== String(name).toLowerCase());
  if (next.length === tags.length) return;
  sharedGroupTags.set(state.sectionSettingsGroupId, next);
  renderSectionSettingsTags();
  saveSectionTags(state.sectionSettingsGroupId, next).then((ok) => { if (!ok) showToast('Could not save section tags'); });
}

export function sectionTagAdd(raw) {
  if (state.sectionSettingsGroupId == null) return;
  const tag = normalizeTagName(raw);
  if (!tag) return;
  const tags = sharedGroupTagList(state.sectionSettingsGroupId);
  if (tags.some((t) => String(t).toLowerCase() === tag.toLowerCase())) return;
  if (tags.length >= 100) { showToast('Section tag limit reached (100)'); return; }
  const next = [...tags, tag];
  sharedGroupTags.set(state.sectionSettingsGroupId, next);
  renderSectionSettingsTags();
  saveSectionTags(state.sectionSettingsGroupId, next).then((ok) => { if (!ok) showToast('Could not save section tags'); });
}

export function closeSectionSettings() {
  const overlay = document.getElementById('section-settings-overlay');
  if (overlay) overlay.hidden = true;
  state.sectionSettingsGroupId = null;
}

export function openSectionSettings(groupId) {
  const me = state.cachedProfile && state.cachedProfile.username;
  // Owner-only; the cog is only rendered for owners, this is the safety net.
  if (!me || sharedGroupOwnerOf(groupId) !== me) { showToast('Only the owner can change section settings'); return; }
  const overlay = document.getElementById('section-settings-overlay');
  if (!overlay) return;
  state.sectionSettingsGroupId = Number(groupId) || groupId;
  renderSectionSettingsTags();
  renderSectionMembers();
  overlay.hidden = false;
  const input = document.getElementById('section-invite-input');
  if (input) input.value = '';
  const err1 = document.getElementById('section-invite-error');
  if (err1) { err1.hidden = true; err1.textContent = ''; }
  const err2 = document.getElementById('section-invite-status');
  if (err2) { err2.hidden = true; err2.textContent = ''; }
  const tagInput = document.getElementById('section-tags-input');
  if (tagInput) { tagInput.value = ''; }
}

export async function renderSectionMembers() {
  const box = document.getElementById('section-members-list');
  if (!box || state.sectionSettingsGroupId == null) return;
  const me = state.cachedProfile && state.cachedProfile.username;
  box.innerHTML = '<p class="modal-desc">Loading members…</p>';
  try {
    const res = await apiFetch(`/api/collab/groups/${state.sectionSettingsGroupId}`);
    if (!res.ok) { box.innerHTML = '<p class="modal-desc">Could not load members.</p>'; return; }
    const g = await res.json();
    const members = Array.isArray(g.members) ? g.members : [];
    const pending = Array.isArray(g.pending) ? g.pending : [];
    const isOwner = g.owner === me;
    const memberRows = members.map((name) => {
      const tags = `${name === me ? ' (you)' : ''}${name === g.owner ? ' · owner' : ''}`;
      return `<div class="collab-pending-row"><span class="collab-pending-name">${escapeHtml(name)}${tags}</span></div>`;
    }).join('');
    let html = `${memberRows || '<p class="modal-desc">No members yet.</p>'}`;
    if (isOwner && pending.length) {
      const pendingRows = pending.map((name) => `<div class="collab-pending-row"><span class="collab-pending-name">${escapeHtml(name)} (invited)</span></div>`).join('');
      html += `<p class="collab-members-section">Invited</p>${pendingRows}`;
    }
    box.innerHTML = html;
    const whole = document.getElementById('section-invite-whole');
    const inviteBtn = document.getElementById('section-invite-btn');
    const inviteInput = document.getElementById('section-invite-input');
    const canInvite = isOwner;
    if (whole) whole.disabled = !canInvite;
    if (inviteBtn) inviteBtn.disabled = !canInvite;
    if (inviteInput) inviteInput.disabled = !canInvite;
  } catch (error) {
    box.innerHTML = '<p class="modal-desc">Could not load members.</p>';
  }
}

export async function sectionInviteMember() {
  const groupId = state.sectionSettingsGroupId;
  const errEl = document.getElementById('section-invite-error');
  const statusEl = document.getElementById('section-invite-status');
  const input = document.getElementById('section-invite-input');
  const whole = document.getElementById('section-invite-whole');
  const username = String(input ? input.value : '').trim();
  const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } if (statusEl) statusEl.hidden = true; };
  const showOk = (msg) => { if (statusEl) { statusEl.textContent = msg; statusEl.hidden = false; statusEl.style.color = 'var(--ink)'; } if (errEl) errEl.hidden = true; };
  if (!groupId) { showErr('Open section settings again.'); return; }
  if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { showErr('Enter a valid username (3-32 chars: letters, numbers, _ or -).'); return; }
  const me = state.cachedProfile && state.cachedProfile.username;
  if (!me || sharedGroupOwnerOf(groupId) !== me) { showErr('Only the owner can add members.'); return; }
  if (whole && !whole.checked) { showErr('Check “Whole section” to give access to the entire section.'); return; }
  if (username === me) { showErr('You are already a member.'); return; }
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showErr('Reload the Shared list and try again'); return; }
  let keyVersion = 1;
  try {
    const res = await apiFetch(`/api/collab/groups/${groupId}`);
    if (!res.ok) { showErr('Could not load section key.'); return; }
    const g = await res.json();
    keyVersion = Number(g.keyVersion || g.myKeyVersion || 1);
  } catch (error) { showErr('Could not load section key.'); return; }
  const btn = document.getElementById('section-invite-btn');
  if (btn) btn.disabled = true;
  try {
    await collabAddGroupMember(groupId, key, username, keyVersion);
    showOk(`Invited ${username} — they will see the whole section once they accept.`);
    if (input) input.value = '';
    await renderSectionMembers();
    try { renderSharedView(); } catch (error) {}
  } catch (error) {
    showErr(error && error.message ? error.message : 'Could not add member');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function saveSectionTags(groupId, tags) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return false; }
  const folders = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  try {
    const encMeta = await collabEncryptGroupMeta(key, folders, tags);
    const res = await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    return res.ok;
  } catch (error) { return false; }
}

// ---- Owner-only section settings: a section-level tag list -----------------
export function renderSectionSettingsTags() {
  const box = document.getElementById('section-tags-current');
  if (!box) return;
  const tags = sharedGroupTagList(state.sectionSettingsGroupId);
  box.innerHTML = tags.length
    ? tags.map((tag) => `<button type="button" class="tag-chip" data-section-tag-remove="${escapeHtml(tag)}" title="Remove ${escapeHtml(tag)}">${escapeHtml(tag)}<span aria-hidden="true">×</span></button>`).join('')
    : '<span class="tag-editor-empty">No section tags yet — add one below.</span>';
}

export async function saveGroupFolders(groupId, key, folders) {
  try {
    const encMeta = await collabEncryptGroupMeta(key, folders, sharedGroupTagList(groupId));
    await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
  } catch (error) {}
}

export function sharedFolderTree(notesDec, groupId, folderList, canDelete) {
  const set = new Set((folderList || []).filter(Boolean));
  notesDec.forEach((n) => { if (n.folder) set.add(n.folder); });
  const folders = new Set();
  set.forEach((f) => { let cur = f; while (cur) { folders.add(cur); cur = folderParent(cur); } });
  const childrenOf = new Map();
  const roots = [];
  folders.forEach((f) => {
    const parent = folderParent(f);
    if (parent && folders.has(parent)) {
      if (!childrenOf.has(parent)) childrenOf.set(parent, []);
      childrenOf.get(parent).push(f);
    } else roots.push(f);
  });
  // Keep the user's drag-sorted order (folderList order) — no alphabetical sort.
  // Subtree note counts mirror the All Notes tree's per-folder counters.
  const subtreeCount = (folder) => {
    const own = notesDec.filter((n) => n.folder === folder).length;
    return (childrenOf.get(folder) || []).reduce((sum, child) => sum + subtreeCount(child), own);
  };
  const emit = (folder) => {
    const depth = folderDepth(folder);
    const leaf = folderLeaf(folder);
    const collapsed = sharedCollapsed.has(sharedFolderKey(groupId, folder));
    const childHtml = (childrenOf.get(folder) || []).map(emit).join('');
    const notesHtml = notesDec.filter((n) => n.folder === folder).map((n) => sharedNoteRow(n, groupId, canDelete)).join('');
    // Same nesting the All Notes tree uses (tree-folder-wrap > tree-children):
    // the children containers carry the vertical guide lines and indentation,
    // so the hierarchy reads exactly like the personal workspace.
    return `
    <div class="tree-folder-wrap${collapsed ? ' closed' : ''} shared-folder" draggable="true" data-shared-folder="${escapeHtml(folder)}" data-shared-group="${groupId}" data-depth="${depth}">
      <div class="tree-folder-row">
        <button type="button" class="tree-folder" data-shared-toggle="${escapeHtml(folder)}" data-shared-group="${groupId}" aria-expanded="${collapsed ? 'false' : 'true'}" title="${escapeHtml(folder)}">
          <span class="tree-chevron">${icon('chevron-right')}</span>
          <span class="tree-folder-icon">${icon(folderIconForDepth(depth))}</span>
          <span class="tree-folder-name">${escapeHtml(leaf)}</span>
          <span class="tree-count">${subtreeCount(folder)}</span>
        </button>
        <span class="shared-folder-actions">
          <button type="button" class="shared-folder-action" data-folder-note="${escapeHtml(folder)}" data-folder-group="${groupId}" title="New note in ${escapeHtml(leaf)}" aria-label="New note in ${escapeHtml(leaf)}">${icon('file-text')}</button>
          <button type="button" class="shared-folder-action" data-folder-sub="${escapeHtml(folder)}" data-folder-group="${groupId}" title="New subfolder in ${escapeHtml(leaf)}" aria-label="New subfolder in ${escapeHtml(leaf)}">${icon('folder-plus')}</button>
        </span>
      </div>
      <div class="tree-children">${notesHtml}${childHtml}</div>
    </div>`;
  };
  const parts = roots.map(emit);
  notesDec.filter((n) => !n.folder).forEach((n) => parts.push(sharedNoteRow(n, groupId, canDelete)));
  return parts.join('') || '<p class="modal-desc shared-folder-empty">No notes yet — use + New note in this section.</p>';
}

// Every folder key (including ancestors) across all shared sections, for the
// sidebar's collapse-all/expand-all control in the Shared view.
export function sharedAllFolderKeys() {
  const keys = new Set();
  const addPath = (groupId, path) => {
    let cur = path;
    while (cur) { keys.add(sharedFolderKey(groupId, cur)); cur = folderParent(cur); }
  };
  sharedGroupFolders.forEach((folders, groupId) => {
    (folders || []).forEach((folder) => { if (folder) addPath(groupId, folder); });
  });
  sharedNoteMeta.forEach((meta) => { if (meta && meta.folder) addPath(meta.groupId, meta.folder); });
  return [...keys];
}

export function sharedFolderKey(groupId, folder) { return `${groupId}::${folder}`; }

// Section-scoped rotation used when a section is flagged rekey_needed: a member
// left or deleted their account. Any remaining member holding the key can rotate
// — new epoch, re-wrap for everyone still in the section, re-encrypt the notes.
export async function rotateGroupSection({ groupId, key, version, members, notes, folderMeta, remove }) {
  const Y = await loadYjs();
  const newVersion = (Number(version) || 1) + 1;
  const newKey = e2eeRandomBytes(32);
  const remaining = (members || []).filter((m) => m !== remove);
  const keys = [];
  for (const member of [...new Set(remaining)]) {
    try {
      const pub = await sharingRecipientPublicKey(member);
      const w = await wrapRawKeyFor(pub, newKey);
      w.sig = await signWrap(groupId, member, newVersion, w);
      keys.push({ username: member, ...w });
    } catch (error) {}
  }
  const url = remove
    ? `/api/collab/groups/${groupId}/members/${encodeURIComponent(remove)}`
    : `/api/collab/groups/${groupId}/rotate`;
  const rr = await apiFetch(url, {
    method: remove ? 'DELETE' : 'POST', body: JSON.stringify({ keyVersion: newVersion, keys }) });
  if (!rr.ok) return false;
  for (const n of (notes || [])) {
    try {
      const res = await apiFetch(`/api/collab/notes/${n.id}/state`);
      if (res.ok) {
        const data = await res.json();
        const doc = new Y.Doc();
        if (data.encState) { try { Y.applyUpdate(doc, await collabDecrypt(key, data.encState), 'rotate'); } catch (error) {} }
        for (const u of (data.updates || [])) { try { Y.applyUpdate(doc, await collabDecrypt(key, u.payload), 'rotate'); } catch (error) {} }
        const packed = await collabEncrypt(newKey, Y.encodeStateAsUpdate(doc));
        await apiFetch(`/api/collab/notes/${n.id}/compact`, { method: 'POST', body: JSON.stringify({ state: packed, keyVersion: newVersion }) });
        doc.destroy();
      }
      if (n.encMeta) {
        const meta = await collabDecryptMeta(key, n.encMeta);
        await apiFetch(`/api/collab/notes/${n.id}/meta`, { method: 'POST', body: JSON.stringify({ encMeta: await collabEncryptMeta(newKey, meta) }) });
      }
    } catch (error) {}
  }
  if (folderMeta) {
    try {
      const gf = await collabDecryptGroupMeta(key, folderMeta);
      await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta: await collabEncryptGroupMeta(newKey, gf.folders || [], gf.tags || []) }) });
    } catch (error) {}
  }
  return true;
}

// Owner-side key rotation: generate a new epoch key, re-encrypt every note in
// the section under it, publish a wrap per remaining member, then commit the new
// version. Reusing the server only as blob storage; the key itself is never sent.
// When `remove` names a member, the server removes them and bumps the epoch in a
// single transaction, so the two can never diverge.
export async function collabRotateSectionKey(remove) {
  if (!state.collab.groupId || !state.collab.key) return false;
  const Y = await loadYjs();
  const newVersion = (state.collab.keyVersion || 1) + 1;
  const newKey = e2eeRandomBytes(32);
  const oldKey = state.collab.key;
  // 1) Publish the new epoch: wrap the new key to every remaining accepted
  //    member (self included) and, when removing, do it in the same request.
  const remaining = (state.collab.members || []).filter((m) => m !== remove);
  const keys = [];
  for (const member of [...new Set(remaining)]) {
    try {
      const pub = await sharingRecipientPublicKey(member);
      const w = await wrapRawKeyFor(pub, newKey);
      w.sig = await signWrap(state.collab.groupId, member, newVersion, w);
      keys.push({ username: member, ...w });
    } catch (error) {}
  }
  const url = remove
    ? `/api/collab/groups/${state.collab.groupId}/members/${encodeURIComponent(remove)}`
    : `/api/collab/groups/${state.collab.groupId}/rotate`;
  const rr = await apiFetch(url, {
    method: remove ? 'DELETE' : 'POST', body: JSON.stringify({ keyVersion: newVersion, keys }) });
  if (!rr.ok) { showToast('Could not rotate the section key'); return false; }
  state.collab.keys.set(newVersion, newKey);
  state.collab.keyVersion = newVersion;
  state.collab.key = newKey;
  if (remove) state.collab.members = remaining;
  // 2) Re-encrypt every note in the section under the new key (the old key is
  //    still in collab.keys, so we can decrypt each note's existing ciphertext),
  //    including each note's title/folder meta and the section's folder list —
  //    otherwise meta stays locked to the old epoch. Compacting replaces the
  //    snapshot and drops the old update log.
  let groupNotes = [];
  let groupEncMeta = '';
  try {
    const res = await apiFetch('/api/collab/groups');
    if (res.ok) {
      const data = await res.json();
      const g = (data.groups || []).find((x) => String(x.id) === String(state.collab.groupId));
      groupNotes = g ? (g.notes || []) : [];
      groupEncMeta = g ? (g.encMeta || '') : '';
    }
  } catch (error) {}
  for (const n of groupNotes) {
    try {
      const res = await apiFetch(`/api/collab/notes/${n.id}/state`);
      if (res.ok) {
        const data = await res.json();
        const doc = new Y.Doc();
        if (data.encState) {
          try { Y.applyUpdate(doc, await collabDecrypt(collabKeyFor(data.keyVersion), data.encState), 'rotate'); } catch (error) {}
        }
        for (const u of (data.updates || [])) {
          try { Y.applyUpdate(doc, await collabDecrypt(collabKeyFor(u.version), u.payload), 'rotate'); } catch (error) {}
        }
        const packed = await collabEncrypt(newKey, Y.encodeStateAsUpdate(doc));
        await apiFetch(`/api/collab/notes/${n.id}/compact`, { method: 'POST', body: JSON.stringify({ state: packed, keyVersion: newVersion }) });
        doc.destroy();
      }
      if (n.encMeta) {
        const meta = await collabDecryptMeta(oldKey, n.encMeta);
        await apiFetch(`/api/collab/notes/${n.id}/meta`, { method: 'POST', body: JSON.stringify({ encMeta: await collabEncryptMeta(newKey, meta) }) });
      }
    } catch (error) {}
  }
  if (groupEncMeta) {
    try {
      const gf = await collabDecryptGroupMeta(oldKey, groupEncMeta);
      await apiFetch(`/api/collab/groups/${state.collab.groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta: await collabEncryptGroupMeta(newKey, gf.folders || [], gf.tags || []) }) });
    } catch (error) {}
  }
  return true;
}

// Resolve a workspace folder header to its section (same precedence as the
// folder context menu: active custom filter, then the list-section shell,
// then the folder owner).
export function resolveListFolderTarget(header) {
  if (!header || !header.dataset.folder) return null;
  const wrap = header.closest('[data-folder-wrap]');
  const shell = header.closest('[data-list-section]');
  const shellKind = shell ? shell.dataset.listSection : null;
  let sectionId = state.activeCustom ? state.activeCustom.section : null;
  if (shellKind === 'custom') {
    const secBtn = shell.querySelector('[data-section-id]');
    if (secBtn && secBtn.dataset.sectionId) sectionId = secBtn.dataset.sectionId;
  }
  if (!sectionId && wrap) {
    const folder = wrap.dataset.folderWrap;
    const owner = state.customSections.find((section) => section.folders.some((entry) => entry === folder || isFolderOrSub(folder, entry) || isFolderOrSub(entry, folder)));
    if (owner) sectionId = owner.id;
  }
  if (!sectionId) return null;
  return { ns: 'custom', section: sectionId, path: header.dataset.folder };
}

// True when a drag event carries a Notely folder (slide-menu/workspace shared
// payload), as opposed to a note drag (text/plain) or a file hover.
export function isFolderDrag(event) {
  try {
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types || []) : [];
    return types.includes('application/x-notely-folder');
  } catch (error) { return false; }
}

export function sidebarFolderTarget(event) {
  if (event.target.closest('.collection-rename-input')) return null;
  const customRow = event.target.closest('#custom-sections .collection-item');
  if (customRow && customRow.dataset.cfolder) {
    return { ns: 'custom', section: customRow.dataset.csection, path: customRow.dataset.cfolder };
  }
  return null;
}

// ---- Folder drag-and-drop: reorder siblings, or drop onto a folder to nest
// inside it (top/bottom quarter = before/after, middle = nest). Unified custom
// sections implementation (same value for all new sections); reparenting
// reuses the rename functions so notes, collapse state and selection follow.
export function folderListOf(ns, sectionId) {
  const section = state.customSections.find((entry) => entry.id === sectionId);
  return section ? section.folders : null;
}

// Insert a folder path directly after its parent's block (the parent plus any
// existing descendants) so a new subfolder renders under its parent instead
// of at the end of the list. Appends when the parent is missing.
export function insertFolderAfterParent(list, parentPath, newPath) {
  if (parentPath) {
    const prefix = `${parentPath}${FOLDER_SEP}`;
    let at = -1;
    list.forEach((entry, index) => {
      if (entry === parentPath || entry.startsWith(prefix)) at = index;
    });
    if (at !== -1) {
      list.splice(at + 1, 0, newPath);
      return list;
    }
  }
  list.push(newPath);
  return list;
}

export function openFolderContextMenu(ns, path, x, y, sectionId) {
  const menu = getFolderContextMenu();
  if (!menu || !path || !sectionId) return;
  state.folderMenuTarget = { ns: 'custom', path, section: sectionId };
  // Subfolders nest up to two levels: "New subfolder" is offered on top-level
  // folders and on first-level subfolders, but not on the deepest ones.
  const atMaxDepth = folderDepth(path) >= MAX_SUBFOLDER_PARENT_DEPTH;
  menu.querySelectorAll('[data-folder-action]').forEach((btn) => {
    const actionName = btn.dataset.folderAction;
    btn.hidden = actionName === 'restore'
      || (actionName === 'new-note' && state.activeView === 'bin')
      || (actionName === 'subfolder' && atMaxDepth);
  });
  const deleteLabel = document.getElementById('folder-delete-label');
  if (deleteLabel) deleteLabel.textContent = 'Delete';
  menu.hidden = false;
  const padding = 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - padding) menu.style.left = `${Math.max(padding, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight - padding) menu.style.top = `${Math.max(padding, y - rect.height)}px`;
}

export function closeFolderContextMenu() {
  const menu = getFolderContextMenu();
  if (menu) menu.hidden = true;
  state.folderMenuTarget = null;
}

export function getFolderContextMenu() {
  return document.getElementById('folder-context-menu');
}

export function closeSectionIconPicker() {
  const overlay = document.getElementById('section-icon-overlay');
  if (overlay) overlay.hidden = true;
  state.sectionIconTarget = null;
}

export function openSectionIconPicker(sectionId) {
  const overlay = document.getElementById('section-icon-overlay');
  const grid = document.getElementById('section-icon-grid');
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!overlay || !grid || !section) return;
  state.sectionIconTarget = sectionId;
  const current = sectionIconName(section);
  grid.innerHTML = SECTION_ICONS.map((name) =>
    `<button type="button" class="section-icon-option${name === current ? ' is-selected' : ''}" data-icon-choice="${name}" title="${name}" aria-label="${name}">${icon(name)}</button>`).join('');
  const desc = document.getElementById('section-icon-desc');
  if (desc) desc.textContent = `Pick the icon shown beside “${section.name}”.`;
  overlay.hidden = false;
  const first = grid.querySelector('.section-icon-option');
  if (first) first.focus();
}

export function openSectionContextMenu(sectionId, x, y) {
  const menu = document.getElementById('section-context-menu');
  if (!menu || !sectionId) return;
  if (!state.customSections.some((entry) => entry.id === sectionId)) return;
  state.sectionMenuTarget = sectionId;
  menu.hidden = false;
  const padding = 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - padding) menu.style.left = `${Math.max(padding, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight - padding) menu.style.top = `${Math.max(padding, y - rect.height)}px`;
}

export function closeSectionContextMenu() {
  const menu = document.getElementById('section-context-menu');
  if (menu) menu.hidden = true;
  state.sectionMenuTarget = null;
}

// Vault context menu: open/close/handle actions
export function openVaultContextMenu(vaultId, x, y) {
  const menu = document.getElementById('vault-context-menu');
  if (!menu || !vaultId) return;
  state.vaultMenuTarget = vaultId;
  menu.hidden = false;
  const padding = 8;
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth - padding) menu.style.left = `${Math.max(padding, x - rect.width)}px`;
  if (rect.bottom > window.innerHeight - padding) menu.style.top = `${Math.max(padding, y - rect.height)}px`;
}

export function closeVaultContextMenu() {
  const menu = document.getElementById('vault-context-menu');
  if (menu) menu.hidden = true;
  state.vaultMenuTarget = null;
}

export function handleVaultMenuAction(action, vaultId) {
  if (!vaultId || typeof action !== 'string') return;
  const id = vaultId == null ? 1 : vaultId;
  if (action === 'rename') {
    try {
      import('./vault.js').then((m) => {
        try { m.renameVault(id); } catch (error) {}
      });
    } catch (error) {}
  } else if (action === 'delete') {
    try {
      import('./vault.js').then((m) => {
        try { m.deleteVault(id); } catch (error) {}
      });
    } catch (error) {}
  }
}

export function openCustomSectionDeleteConfirm(id) {
  const section = state.customSections.find((entry) => entry.id === id);
  if (!section) return;
  const count = state.notes.filter((note) => !note.deleted && customNoteFolder(note, id) !== null).length;
  state.pendingDeleteId = id;
  state.pendingDeleteMode = 'custom-section';
  state.pendingDeleteSection = null;
  setDeleteDialog({
    eyebrow: 'Delete section',
    title: 'Delete this section?',
    name: section.name,
    message: count
      ? `” organizes ${count} note${count === 1 ? '' : 's'}. The section and its notes will move to Bin for 3 days (restoring a note revives the section). Are you sure?`
      : '” is empty. Are you sure you want to delete it?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

export function openCustomFolderDeleteConfirm(sectionId, folder) {
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section || !section.folders.includes(folder)) return;
  const count = state.notes.filter((note) => {
    if (note.deleted) return false;
    const current = customNoteFolder(note, sectionId);
    return current !== null && isFolderOrSub(current, folder);
  }).length;
  state.pendingDeleteId = folder;
  state.pendingDeleteMode = 'custom-folder';
  state.pendingDeleteSection = sectionId;
  setDeleteDialog({
    eyebrow: 'Delete folder',
    title: 'Delete this folder?',
    name: folder,
    message: count
      ? `” holds ${count} note${count === 1 ? '' : 's'}. The folder and its notes will move to Bin for 3 days. Are you sure?`
      : '” is empty. Are you sure you want to delete it?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// De-duplicate a folder name inside one custom section.
export function uniqueCustomFolderName(sectionId, base) {
  const section = state.customSections.find((entry) => entry.id === sectionId);
  const taken = new Set((section ? section.folders : []).map((name) => name.toLowerCase()));
  const cleanBase = String(base == null ? 'New folder' : base).trim() || 'New folder';
  if (!taken.has(cleanBase.toLowerCase())) return cleanBase;
  let counter = 2;
  while (taken.has(`${cleanBase} ${counter}`.toLowerCase())) counter += 1;
  return `${cleanBase} ${counter}`;
}

export function uniqueSectionId() {
  let id = `section-${Date.now()}`;
  while (state.customSections.some((section) => section.id === id)) id += '-x';
  return id;
}

export function uniqueSectionName(base) {
  const taken = new Set(takenSectionNames(null));
  if (base && !taken.has(base.toLowerCase())) return base;
  let counter = 1;
  const prefix = base || 'Section';
  while (taken.has(`${prefix} ${counter}`.toLowerCase())) counter += 1;
  return base ? `${prefix} ${counter}` : `Section ${counter}`;
}

// All taken section display names (lowercased), optionally skipping one entry.
export function takenSectionNames(exceptId) {
  const names = [];
  state.customSections.forEach((section) => {
    if (!(exceptId && exceptId === section.id)) names.push(section.name);
  });
  return names.map((name) => name.toLowerCase());
}

// A sidebar section header filters the list — pointless when the section
// holds nothing, so empty sections are unclickable (rename still works).
export function isSectionEmpty(kind, id) {
  const sectionId = kind === 'custom' ? id : kind;
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (section) return !section.folders.length;
  return true;
}

// Vault entries for the Vault view (see renderCustomSections): one row per
// known vault, locked or not (names only — contents stay encrypted until
// unlock). Clicking a locked row opens the unlock modal; unlocked switches.
function renderVaultFolderRows(container) {
  const unlocked = !!(state.vault && state.vault.unlocked);
  const known = Array.isArray(state.vaultList) && state.vaultList.length
    ? state.vaultList
    : [{ id: state.vaultId || 1, name: 'Vault' }];
  // Render each vault as a section matching the custom sections UI:
  // section header with lock icon + folder list with colored dots, rename, drag.
  container.innerHTML = known.map((entry) => {
    const active = unlocked && String(state.vaultId || 1) === String(entry.id);
    const vaultId = entry.id == null ? 1 : entry.id;
    const folders = (state.vaultFolderMap && Array.isArray(state.vaultFolderMap[vaultId]))
      ? state.vaultFolderMap[vaultId] : [];
    const vaultSection = { id: `vault-${vaultId}`, name: entry.name || 'Vault', folders, icon: 'lock' };
    return `
    <div class="sidebar-section${active ? ' active-section' : ''}" data-vault-section="${escapeHtml(String(vaultId))}" data-section="vault">
      <div class="section-label">
        <span class="section-initial" title="${escapeHtml(entry.name || 'Vault')}" aria-hidden="true">${icon('lock')}</span>
        <span class="section-icon" title="${escapeHtml(entry.name || 'Vault')}" aria-hidden="true">${icon('lock')}</span>
        <span class="section-label-text" data-vault-name="${escapeHtml(String(vaultId))}">${escapeHtml(entry.name || 'Vault')}</span>
      </div>
      <div class="collection-list">
        ${folders.map((name) => `
        <a href="#" draggable="true" class="collection-item${state.activeView === 'vault' && state.vaultFolder === name ? ' active' : ''}" data-vault-section="${escapeHtml(String(vaultId))}" data-vault-cfolder="${escapeHtml(name)}" data-depth="${folderDepth(name)}" title="${escapeHtml(name)}">
          <span class="collection-dot ${customFolderColor(vaultSection, name)}"></span>
          <span class="collection-label">${escapeHtml(folderLeaf(name))}</span>
          <span class="collection-actions">
            <button type="button" class="collection-action" data-vault-cf-rename="${escapeHtml(name)}" data-vault-cf-section="${escapeHtml(String(vaultId))}" title="Rename folder" aria-label="Rename ${escapeHtml(name)}">${icon('pencil')}</button>
          </span>
          <input class="collection-rename-input" value="${escapeHtml(folderLeaf(name))}" hidden maxlength="180" aria-label="Folder name" />
        </a>`).join('')}
      </div>
    </div>`;
  }).join('');
}

// Connected-person rows for the Shared view (see renderCustomSections).
// Local derivation (no collab-crypto import: that module imports this one).
function sharedPersonNames() {
  const me = state.cachedProfile && state.cachedProfile.username
    ? String(state.cachedProfile.username).toLowerCase() : '';
  const out = [];
  const seen = new Set();
  for (const grp of sharedGroupsCache) {
    const candidates = [grp.owner, ...(Array.isArray(grp.members) ? grp.members : [])];
    for (const name of candidates) {
      const clean = String(name || '').trim();
      if (!clean || clean.toLowerCase() === me || seen.has(clean.toLowerCase())) continue;
      seen.add(clean.toLowerCase());
      out.push(clean);
    }
  }
  return out;
}

function renderSharedPersonRows(container) {
  const persons = sharedPersonNames();
  container.innerHTML = persons.length
    ? `<div class="sidebar-section" data-shared-persons>`
      + `<div class="collection-list">`
      + persons.map((name) => `
        <a href="#" class="person-row${state.sharedPerson === name ? ' active' : ''}" data-shared-person="${escapeHtml(name)}" title="${escapeHtml(name)}">
          <span class="collection-dot violet"></span>
          <span class="collection-label">${escapeHtml(name)}</span>
        </a>`).join('')
      + `</div></div>`
    : '';
}

// Paint section headers (all sections share the same custom implementation).
export function updateSectionHeaders() {
  // Custom sections
  document.querySelectorAll('#custom-sections .sidebar-section[data-custom-section]').forEach((wrap) => {
    const id = wrap.dataset.customSection;
    wrap.classList.toggle('active-section', Boolean(state.activeCustom && !state.activeCustom.folder && state.activeCustom.section === id));
    wrap.classList.toggle('is-empty', isSectionEmpty('custom', id));
  });
  // Vault sections: highlight the currently active vault
  document.querySelectorAll('#custom-sections .sidebar-section[data-vault-section]').forEach((wrap) => {
    const vaultId = wrap.dataset.vaultSection;
    const isActive = state.activeView === 'vault' && String(state.vaultId || 1) === String(vaultId);
    wrap.classList.toggle('active-section', isActive);
  });
}

export function customFolderColor(section, name) {
  // Same value as removed Collections had: fixed brand colors for defaults.
  const known = { Work: 'coral', Personal: 'yellow', 'Reading list': 'blue' };
  if (known[name]) return known[name];
  const index = section.folders.findIndex((entry) => entry === name);
  if (index >= 0) return COLLECTION_COLORS[(index + 4) % COLLECTION_COLORS.length];
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return COLLECTION_COLORS[Math.abs(hash) % COLLECTION_COLORS.length];
}

// Render user-built sections: header (editable name, add/delete) + folders.
export function renderCustomSections() {
  const container = document.getElementById('custom-sections');
  if (!container) return;
  // The add button reads "+ Add Vault" inside the Vault view, "+ Add section"
  // everywhere else (it creates a vault there — max 3, shared password).
  try {
    const addBtn = document.getElementById('new-section');
    if (addBtn) {
      const inVault = state.activeView === 'vault';
      const inShared = state.activeView === 'shared';
      if (inShared) {
        addBtn.innerHTML = '<span>+</span><span class="btn-label"> New Connection</span>';
        addBtn.title = 'New Connection';
        addBtn.setAttribute('aria-label', 'New Connection');
      } else if (inVault) {
        addBtn.innerHTML = '<span>+</span><span class="btn-label"> Add Vault</span>';
        addBtn.title = 'Add vault (max 3)';
        addBtn.setAttribute('aria-label', 'Add vault');
      } else {
        addBtn.innerHTML = '<span>+</span><span class="btn-label"> Add section</span>';
        addBtn.title = 'Add section';
        addBtn.setAttribute('aria-label', 'Add section');
      }
    }
  } catch (error) {}
  // In shared view, keep the button visible when collapsed (shows just "+").
  const addSectionWrap = document.querySelector('.add-section-wrap');
  if (addSectionWrap) addSectionWrap.classList.toggle('shared-active', state.activeView === 'shared');
  // Shared view: Main Sub Sections mirrors the connected accounts instead
  // of your own sections (click a person to filter their sections).
  if (state.activeView === 'shared') {
    renderSharedPersonRows(container);
    updateSectionHeaders();
    return;
  }
  // Vault view: Main Sub Sections mirrors the vault list (names only when
  // locked — contents stay encrypted until unlock).
  if (state.activeView === 'vault') {
    renderVaultFolderRows(container);
    updateSectionHeaders();
    return;
  }
  // Favourites/Archive view: only show sections that have matching notes.
  const isFav = state.activeView === 'favorites' || (state.activeView === 'notes' && state.activeFilter === 'favorites');
  const isArchive = state.activeView === 'archive';
  let sections = state.customSections;
  if (isFav || isArchive) {
    const matchSections = new Set();
    for (const note of state.notes) {
      if (note.deleted) continue;
      if (isFav && !note.favorite) continue;
      if (isArchive && !note.archived) continue;
      if (note.sections && typeof note.sections === 'object') {
        for (const secId of Object.keys(note.sections)) matchSections.add(secId);
      }
    }
    sections = state.customSections.filter((s) => matchSections.has(s.id));
  }
  container.innerHTML = sections.map((section) => `
    <div class="sidebar-section" data-custom-section="${escapeHtml(section.id)}" data-section="custom">
      <div class="section-label">
        <span class="section-initial" title="${escapeHtml(section.name)}" aria-hidden="true">${icon(sectionIconName(section))}</span>
        <span class="section-icon" title="${escapeHtml(section.name)}" aria-hidden="true">${icon(sectionIconName(section))}</span>
        <span class="section-label-text" data-section-name="${escapeHtml(section.id)}">${escapeHtml(section.name)}</span>
      </div>
      <div class="collection-list">
        ${section.folders.map((name) => `
        <a href="#" draggable="true" class="collection-item${state.activeCustom && state.activeCustom.section === section.id && state.activeCustom.folder === name ? ' active' : ''}" data-csection="${escapeHtml(section.id)}" data-cfolder="${escapeHtml(name)}" data-depth="${folderDepth(name)}" title="${escapeHtml(name)}">
          <span class="collection-dot ${customFolderColor(section, name)}"></span>
          <span class="collection-label">${escapeHtml(folderLeaf(name))}</span>
          <span class="collection-actions">
            <button type="button" class="collection-action" data-cf-rename="${escapeHtml(name)}" data-cf-section="${escapeHtml(section.id)}" title="Rename folder" aria-label="Rename ${escapeHtml(name)}">${icon('pencil')}</button>
          </span>
          <input class="collection-rename-input" value="${escapeHtml(folderLeaf(name))}" hidden maxlength="180" aria-label="Folder name" />
        </a>`).join('')}
      </div>
    </div>`).join('');
  updateSectionHeaders();
}

export function cleanCustomSections(value) {
  if (!Array.isArray(value)) return null;
  const out = [];
  value.slice(0, 20).forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const id = typeof entry.id === 'string' ? entry.id.trim().slice(0, 80) : '';
    const name = typeof entry.name === 'string' ? entry.name.trim().slice(0, 40) : '';
    const folders = Array.isArray(entry.folders)
      ? entry.folders.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim().slice(0, 180)).slice(0, 200)
      : [];
    const icon = typeof entry.icon === 'string' && SECTION_ICONS.includes(entry.icon) ? entry.icon : undefined;
    if (id && name) out.push(icon ? { id, name, folders, icon } : { id, name, folders });
  });
  return out;
}

// Resolve a section's icon, falling back to the default when unset/invalid.
export function sectionIconName(section) {
  const name = section && typeof section.icon === 'string' ? section.icon : '';
  return SECTION_ICONS.includes(name) ? name : SECTION_ICONS[0];
}


export function selectCustomFolder(sectionId, folder) {
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section || !folder) return;
  // Intermediate parents are not always stored in the folder list (a note can
  // be filed three levels deep without its ancestors listed). Accept any
  // ancestor of a known folder, registering it so it stays navigable.
  if (!section.folders.includes(folder)) {
    const isAncestor = section.folders.some((entry) => isFolderOrSub(entry, folder));
    if (!isAncestor) return;
    section.folders.push(folder);
    persistCustomSections();
    renderCustomSections();
  }
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes' && !state.activeCustom));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  state.activeView = 'notes';
  state.activeFilter = 'all';
  state.activeCustom = { section: sectionId, folder };
  state.lastMarkedSectionId = sectionId;
  try { localStorage.setItem('notely-last-section', sectionId); } catch (error) {}
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
}

// Filter the list to a custom section (folder null) or one of its folders.
// Clears every other filter, like its built-in counterparts.
export function selectCustomSection(sectionId) {
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes' && !state.activeCustom));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  state.activeView = 'notes';
  state.activeFilter = 'all';
  state.activeCustom = { section: sectionId, folder: null };
  state.lastMarkedSectionId = sectionId;
  try { localStorage.setItem('notely-last-section', sectionId); } catch (error) {}
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
}

// Strip-only folder filter: narrows the CURRENT view (Starred/Archive/Bin)
// to a section/folder without hopping back to All Notes. Null folder =
// whole section.
export function applyStripFolderFilter(sectionId, folder) {
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  if (folder && !section.folders.includes(folder)) {
    const isAncestor = section.folders.some((entry) => isFolderOrSub(entry, folder));
    if (!isAncestor) return;
    section.folders.push(folder);
    persistCustomSections();
    renderCustomSections();
  }
  state.activeCustom = { section: sectionId, folder: folder || null };
  state.lastMarkedSectionId = sectionId;
  try { localStorage.setItem('notely-last-section', sectionId); } catch (error) {}
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
}

// Persist custom sections + section display names into the encrypted UI vault.
export function persistCustomSections() {
  persistUiVault();
}

// Fill + show the folder chooser. With (ns, sectionId) it lists one section
// (bare-section flow, resumes at the template picker). With no args it lists
// every folder in the workspace (folder-required gate, resumes a parked
// template choice). Returns false when there is nothing to choose.
export function openFolderPicker(ns, sectionId) {
  const box = document.getElementById('folder-pick-options');
  const overlay = document.getElementById('folder-pick-overlay');
  if (!box || !overlay) return false;
  let entries = [];
  let heading;
  if (ns === 'custom') {
    const section = state.customSections.find((entry) => entry.id === sectionId);
    if (!section || !section.folders.length) return false;
    entries = orderFoldersLikeWorkspace(section.folders).map((folder) => ({ ns, section: sectionId, folder, context: section.name }));
    heading = `Where in ${entries[0].context} should this note land?`;
  } else {
    (state.customSections || []).forEach((section) => {
      orderFoldersLikeWorkspace(section.folders || []).forEach((folder) => {
        entries.push({ ns: 'custom', section: section.id, folder, context: section.name });
      });
    });
    if (!entries.length) return false;
    heading = 'Every note needs a folder — where should this one land?';
  }
  document.getElementById('folder-pick-desc').textContent = heading;
  box.innerHTML = entries.map((entry) => {
    const leaf = folderLeaf(entry.folder);
    const sub = leaf === entry.folder ? entry.context : entry.folder;
    // Indent icon + label text (not the button) one notch per depth level.
    // Icons mirror the workspace strip: colored folder, nested glyph for subs.
    const section = state.customSections.find((sec) => sec.id === entry.section);
    const depth = folderDepth(entry.folder);
    const glyphClass = `strip-folder-glyph ${section ? customFolderColor(section, entry.folder) : 'blue'}`;
    const glyph = `<span class="${glyphClass}">${icon(folderIconForDepth(depth))}</span>`;
    return `
    <button class="template-option" data-pick-ns="${entry.ns}" data-pick-section="${escapeHtml(entry.section || '')}" data-pick-folder="${escapeHtml(entry.folder)}">
      <span class="template-icon template-icon-bare" data-indent-depth="${depth}">${glyph}</span>
      <span class="theme-option-text"><strong>${escapeHtml(leaf)}</strong><span>${escapeHtml(sub)}</span></span>
    </button>`;
  }).join('');
  // CSP (styles-src has no 'unsafe-inline'): apply depth indents via element
  // styles after insertion instead of inline style attributes.
  box.querySelectorAll('[data-indent-depth]').forEach((el) => {
    try { el.style.marginLeft = `${Number(el.dataset.indentDepth || 0) * 14}px`; } catch (error) {}
  });
  box.querySelectorAll('[data-pick-folder]').forEach((btn) => btn.addEventListener('click', () => {
    state.pendingSectionFolder = { ns: btn.dataset.pickNs, section: btn.dataset.pickSection || null, folder: btn.dataset.pickFolder };
    closeFolderPicker();
    // Folder-required gate resumes here: a parked template choice goes
    // straight to creation; the bare-section flow picks a template next.
    if (state.pendingTemplate) {
      const templateKey = state.pendingTemplate;
      state.pendingTemplate = null;
      createNoteFromTemplate(templateKey);
    } else {
      openTemplatePicker();
    }
  }));
  overlay.hidden = false;
  const first = box.querySelector('[data-pick-folder]');
  if (first) first.focus();
  return true;
}

// Delete a vault folder immediately (no Bin in the vault): its notes move to
// the Vault root and everything syncs encrypted as usual.
export function deleteVaultFolder(folder) {
  if (!state.vault.unlocked) return;
  state.vault.folders = state.vault.folders.filter((entry) => entry !== folder);
  state.vault.notes.forEach((note) => { if (note.folder === folder) { note.folder = null; note.date = 'Now'; } });
  persistNotes();
  renderNoteList();
  showToast('Vault folder deleted');
}

export function renameVaultFolder(folder) {
  if (!state.vault.unlocked || !state.vault.folders.includes(folder)) return;
  askInput({ eyebrow: 'Vault', title: 'Rename vault folder', desc: '', label: 'Folder name', password: false, placeholder: folder, okText: 'Rename' }).then((value) => {
    if (value == null) return;
    const checked = cleanVaultFolderInput(value, folder);
    if (checked.error) { showToast(checked.error); return; }
    if (checked.name === folder) return;
    state.vault.folders = state.vault.folders.map((entry) => (entry === folder ? checked.name : entry));
    state.vault.notes.forEach((note) => { if (note.folder === folder) note.folder = checked.name; });
    persistNotes();
    renderNoteList();
    showToast('Vault folder renamed');
  });
}

export function addVaultFolder() {
  if (!state.vault.unlocked) { showToast('Unlock the Vault first'); return; }
  askInput({ eyebrow: 'Vault', title: 'New vault folder', desc: '', label: 'Folder name', password: false, placeholder: 'e.g. Receipts', okText: 'Create' }).then((value) => {
    if (value == null) return;
    const checked = cleanVaultFolderInput(value, null);
    if (checked.error) { showToast(checked.error); return; }
    state.vault.folders.push(checked.name);
    persistNotes();
    renderNoteList();
    renderCustomSections();
    showToast('Vault folder added');
  });
}

// Folder destination picker for new vault notes. Reuses the shared
// folder-pick overlay with vault entries (root first).
export function openVaultFolderPicker() {
  const box = document.getElementById('folder-pick-options');
  const overlay = document.getElementById('folder-pick-overlay');
  if (!box || !overlay) return false;
  document.getElementById('folder-pick-desc').textContent = 'Where in the Vault should this note land?';
  const rows = [{ name: '', label: 'Vault', sub: 'Top level' }]
    .concat(state.vault.folders.map((folder) => ({ name: folder, label: folderLeaf(folder), sub: folder })));
  box.innerHTML = rows.map((entry) => `
    <button class="template-option" data-vault-pick="${escapeHtml(entry.name)}">
      <span class="template-icon">${icon('folder')}</span>
      <span class="theme-option-text"><strong>${escapeHtml(entry.label)}</strong><span>${escapeHtml(entry.sub)}</span></span>
    </button>`).join('');
  box.querySelectorAll('[data-vault-pick]').forEach((btn) => btn.addEventListener('click', () => {
    state.pendingVaultFolder = btn.dataset.vaultPick || null;
    closeFolderPicker();
    state.vaultTemplatePending = true;
    openTemplatePicker();
  }));
  overlay.hidden = false;
  const first = box.querySelector('[data-vault-pick]');
  if (first) first.focus();
  return true;
}

export async function deleteSharedFolderNow(groupId, folder) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const prefix = `${folder}${FOLDER_SEP}`;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  const nextFolders = existing.filter((f) => f !== folder && !f.startsWith(prefix));
  for (const e of [...sharedNoteMeta.values()]) {
    if (String(e.groupId) !== String(groupId) || !e.folder) continue;
    if (e.folder === folder || e.folder.startsWith(prefix)) await updateSharedNoteMeta(key, e.id, { title: e.title || '', folder: '' });
  }
  await saveGroupFolders(groupId, key, nextFolders);
  showToast('Folder deleted');
  renderSharedView();
}

export async function renameSharedFolder(groupId, folder) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const value = await askInput({ eyebrow: 'Rename folder', title: folderLeaf(folder), desc: 'Rename this folder in the shared section.', label: 'Name', password: false, placeholder: folderLeaf(folder), okText: 'Rename' });
  if (value == null) return;
  const leaf = String(value).trim().replace(/[\/\\]+/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
  if (!leaf) return;
  const parent = folderParent(folder);
  const newPath = parent ? `${parent}${FOLDER_SEP}${leaf}` : leaf;
  if (newPath.toLowerCase() === folder.toLowerCase()) return;
  const prefix = `${folder}${FOLDER_SEP}`;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  const nextFolders = existing.map((f) => (f === folder ? newPath : (f.startsWith(prefix) ? newPath + f.slice(folder.length) : f)));
  for (const e of [...sharedNoteMeta.values()]) {
    if (String(e.groupId) !== String(groupId) || !e.folder) continue;
    if (e.folder === folder || e.folder.startsWith(prefix)) {
      const nf = e.folder === folder ? newPath : newPath + e.folder.slice(folder.length);
      await updateSharedNoteMeta(key, e.id, { title: e.title || '', folder: nf });
    }
  }
  await saveGroupFolders(groupId, key, nextFolders);
  showToast('Folder renamed');
  renderSharedView();
}

// Drag-and-drop: reparent a folder (with its subfolders and notes).
export async function reparentSharedFolder(groupId, folder, newParent) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const parent = newParent || '';
  if (parent && (parent === folder || isFolderOrSub(parent, folder))) { showToast("Can't move a folder into itself"); return; }
  const leaf = folderLeaf(folder);
  const newPath = parent ? `${parent}${FOLDER_SEP}${leaf}` : leaf;
  if (newPath === folder) return;
  const prefix = `${folder}${FOLDER_SEP}`;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  const nextFolders = existing.map((f) => (f === folder ? newPath : (f.startsWith(prefix) ? newPath + f.slice(folder.length) : f)));
  for (const e of [...sharedNoteMeta.values()]) {
    if (String(e.groupId) !== String(groupId) || !e.folder) continue;
    if (e.folder === folder || e.folder.startsWith(prefix)) {
      const nf = e.folder === folder ? newPath : newPath + e.folder.slice(folder.length);
      await updateSharedNoteMeta(key, e.id, { title: e.title || '', folder: nf });
    }
  }
  await saveGroupFolders(groupId, key, nextFolders);
  renderSharedView();
  showToast('Folder moved');
}

// Drag-and-drop: move a note into a folder (no prompt).
export async function moveSharedNoteToFolder(noteId, groupId, folder) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  const entry = sharedNoteMeta.get(String(noteId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const target = folder || '';
  if ((entry && entry.folder) === target) return;
  await updateSharedNoteMeta(key, noteId, { title: (entry && entry.title) || '', folder: target });
  if (String(state.collab.noteId) === String(noteId)) state.collab.folder = target;
  renderSharedView();
  showToast(target ? `Moved to ${target}` : 'Moved to the section root');
}

export async function addSharedFolder(groupId) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const value = await askInput({ eyebrow: 'Folder', title: 'Add a folder', desc: 'Type a name, or "Parent / Child" to nest.', label: 'Folder name', password: false, placeholder: 'e.g. Ideas / 2026', okText: 'Add' });
  if (value == null) return;
  const folder = String(value).trim().replace(/\s*\/\s*/g, FOLDER_SEP).replace(/^\/+|\/+$/g, '').slice(0, 180);
  if (!folder) return;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  if (existing.some((f) => f.toLowerCase() === folder.toLowerCase())) { showToast('That folder already exists'); return; }
  try {
    const encMeta = await collabEncryptGroupMeta(key, [...existing, folder], sharedGroupTagList(groupId));
    const res = await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    if (!res.ok) { showToast('Could not add the folder'); return; }
    showToast(`Folder \u201c${folder}\u201d added`);
    renderSharedView();
  } catch (error) { showToast('Could not add the folder'); }
}

// A member leaves a shared section: remove ourselves. The server flags the
// section so a remaining member rotates the key on next open (the server holds
// no key to rotate with).
export async function leaveSharedSection(groupId) {
  const me = state.cachedProfile && state.cachedProfile.username;
  if (!me) return;
  const res = await apiFetch(`/api/collab/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(me)}`, { method: 'DELETE' });
  if (res.ok) { showToast('Left the section'); renderSharedView(); }
  else showToast('Could not leave the section');
}

// Add a subfolder under an existing shared folder (persisted in group meta).
export async function addSubfolder(groupId, parentFolder) {
  const key = sharedGroupKeys.get(groupId) || sharedGroupKeys.get(Number(groupId));
  if (!key) { showToast('Reload the Shared list and try again'); return; }
  const value = await askInput({ eyebrow: 'Subfolder', title: 'Add a subfolder', desc: `Under ${parentFolder}`, label: 'Name', password: false, placeholder: 'e.g. Notes', okText: 'Add' });
  if (value == null) return;
  const name = String(value).trim().replace(/[\/\\]+/g, ' ').replace(/\s+/g, ' ').slice(0, 120);
  if (!name) return;
  const folder = `${parentFolder}${FOLDER_SEP}${name}`;
  const existing = sharedGroupFolders.get(groupId) || sharedGroupFolders.get(Number(groupId)) || [];
  if (existing.some((f) => f.toLowerCase() === folder.toLowerCase())) { showToast('That subfolder already exists'); return; }
  try {
    const encMeta = await collabEncryptGroupMeta(key, [...existing, folder], sharedGroupTagList(groupId));
    const res = await apiFetch(`/api/collab/groups/${groupId}/meta`, { method: 'POST', body: JSON.stringify({ encMeta }) });
    if (!res.ok) { showToast('Could not add the subfolder'); return; }
    showToast(`Subfolder \u201c${name}\u201d added`);
    renderSharedView();
  } catch (error) { showToast('Could not add the subfolder'); }
}

// Start a connection: create a shared section for the person (no note yet).
// They receive a "<you> wants to connect with you" request to accept.
export async function collabCreateSection(members) {
  const names = Array.isArray(members) ? members : [];
  const keyRaw = e2eeRandomBytes(32);
  let selfPub;
  try { selfPub = await sharingRecipientPublicKey(state.cachedProfile.username); }
  catch (error) { showToast('Could not load your public key'); return null; }
  const wrap = await wrapRawKeyFor(selfPub, keyRaw);
  // Self-wrap: signed over an empty group id (the group does not exist yet);
  // verification is skipped for one's own wrap.
  wrap.sig = await signWrap('', state.cachedProfile.username, 1, wrap);
  const name = names[0] || 'Connection';
  const res = await apiFetch('/api/collab/groups', { method: 'POST', body: JSON.stringify({ name, ...wrap }) });
  if (!res.ok) { showToast('Could not start the connection'); return null; }
  const data = await res.json();
  const failed = [];
  for (const who of names) {
    try { await collabAddGroupMember(data.id, keyRaw, who, 1); }
    catch (error) { failed.push(`${who}: ${error && error.message ? error.message : 'failed'}`); }
  }
  if (state.activeView === 'shared') renderSharedView();
  if (failed.length) showToast(`Connection started, but some requests failed — ${failed[0]}`);
  else showToast(`Connection request sent to ${names.join(', ')}`);
  return data.id;
}

export function dropNoteOnFolder(draggedId, folder, sectionId) {
  const index = state.notes.findIndex((note) => note.id === draggedId);
  if (index === -1 || typeof folder !== 'string') return;
  const [moved] = state.notes.splice(index, 1);
  // Resolve target section: explicit sectionId wins, else active custom section.
  const targetSection = sectionId || (state.activeCustom ? state.activeCustom.section : null);
  if (!moved.sections || typeof moved.sections !== 'object') moved.sections = {};
  if (targetSection) {
    moved.sections[targetSection] = folder;
  } else {
    // No section context (should not happen in unified UI): keep filing unchanged.
    state.notes.splice(index, 0, moved);
    persistNotes();
    renderNoteList();
    return;
  }
  // Append after the folder's last note in global order (empty folders: end).
  const keyOf = (note) => {
    if (targetSection) return customNoteFolder(note, targetSection);
    if (state.activeCustom) return customNoteFolder(note, state.activeCustom.section);
    return firstFilingOf(note);
  };
  let to = state.notes.length;
  for (let i = state.notes.length - 1; i >= 0; i -= 1) {
    if (keyOf(state.notes[i]) === folder) { to = i + 1; break; }
  }
  state.notes.splice(to, 0, moved);
  persistNotes();
  renderNoteList();
}

export function bindFolderDragDrop() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const clearIndicators = () => {
    sidebar.querySelectorAll('.drop-before,.drop-after,.drop-target').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));
  };
  sidebar.addEventListener('dragstart', (event) => {
    const row = event.target.closest('.collection-item');
    if (!row) return;
    const target = sidebarFolderTarget(event);
    if (!target || !e2ee.masterKey) { event.preventDefault(); return; }
    event.dataTransfer.setData('application/x-notely-folder', JSON.stringify(target));
    event.dataTransfer.effectAllowed = 'move';
    row.classList.add('dragging');
    closeFolderContextMenu();
    closeNoteContextMenu();
  });
  sidebar.addEventListener('dragend', () => {
    sidebar.querySelectorAll('.dragging').forEach((el) => el.classList.remove('dragging'));
    clearIndicators();
  });
  sidebar.addEventListener('dragover', (event) => {
    const row = event.target.closest('.collection-item');
    if (!row || !e2ee.masterKey) return;
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types || []).includes('application/x-notely-folder')) return;
    const rect = row.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearIndicators();
    if (ratio < 0.25) row.classList.add('drop-before');
    else if (ratio > 0.75) row.classList.add('drop-after');
    else row.classList.add('drop-target');
  });
  sidebar.addEventListener('dragleave', (event) => {
    const row = event.target.closest('.collection-item');
    if (row && !row.contains(event.relatedTarget)) {
      row.classList.remove('drop-before', 'drop-after', 'drop-target');
    }
  });
  sidebar.addEventListener('drop', (event) => {
    const row = event.target.closest('.collection-item');
    if (!row || !e2ee.masterKey) return;
    let dragged = null;
    try { dragged = JSON.parse(event.dataTransfer.getData('application/x-notely-folder')); } catch (error) { dragged = null; }
    if (!dragged || !dragged.path) return;
    const target = sidebarFolderTarget(event);
    if (!target || target.ns !== dragged.ns || target.section !== dragged.section) return;
    if (target.path === dragged.path) return;
    if (isFolderOrSub(target.path, dragged.path)) {
      event.preventDefault();
      showToast("Can't move a folder into itself");
      return;
    }
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
    const list = folderListOf(dragged.ns, dragged.section);
    if (!list) return;
    if (ratio >= 0.25 && ratio <= 0.75) {
      // Nest inside the target folder.
      const newPath = reparentFolder(dragged.ns, dragged.section, dragged.path, target.path);
      if (!newPath) return;
      const movedHome = newPath !== dragged.path;
      // Group visually right after the new parent's subtree.
      const moved = folderListOf(dragged.ns, dragged.section).filter((entry) => isFolderOrSub(entry, newPath));
      const rest = folderListOf(dragged.ns, dragged.section).filter((entry) => !isFolderOrSub(entry, newPath));
      let index = rest.length;
      for (let i = rest.length - 1; i >= 0; i -= 1) {
        if (isFolderOrSub(rest[i], target.path)) { index = i + 1; break; }
      }
      const reordered = [...rest.slice(0, index), ...moved, ...rest.slice(index)];
      const section = state.customSections.find((entry) => entry.id === dragged.section);
      if (section) section.folders = reordered;
      persistFolderList(dragged.ns);
      renderCustomSections();
      renderNoteList();
      if (movedHome) showToast(`Moved to “${folderLeaf(target.path)}”`);
    } else {
      // Reorder among siblings (reparenting across levels when needed).
      const newParent = folderParent(target.path);
      let movedRoot = dragged.path;
      if ((newParent || null) !== (folderParent(dragged.path) || null)) {
        const newPath = reparentFolder(dragged.ns, dragged.section, dragged.path, newParent);
        if (!newPath) return;
        movedRoot = newPath;
      }
      // Anchor may have been renamed if it sat inside the moved subtree —
      // guarded above, so it is stable here.
      if (reorderFolderBlock(dragged.ns, dragged.section, movedRoot, target.path, ratio > 0.75)) {
        renderCustomSections();
        renderNoteList();
      }
    }
  });
}

// Reparent a folder under a new parent (null = top level). Returns the new
// full path, or null when blocked. Shows toasts itself.
export function reparentFolder(ns, sectionId, oldPath, newParent) {
  if (newParent && (newParent === oldPath || isFolderOrSub(newParent, oldPath))) {
    showToast("Can't move a folder into itself");
    return null;
  }
  const list = folderListOf(ns, sectionId);
  if (!list || !list.includes(oldPath)) return null;
  if (newParent && !list.includes(newParent)) return null;
  const leaf = folderLeaf(oldPath);
  let newPath = newParent ? `${newParent}${FOLDER_SEP}${leaf}` : leaf;
  if (newPath !== oldPath) {
    const others = list.filter((entry) => !isFolderOrSub(entry, oldPath)).map((entry) => entry.toLowerCase());
    if (others.includes(newPath.toLowerCase())) {
      let counter = 2;
      const stem = (suffix) => (newParent ? `${newParent}${FOLDER_SEP}${leaf} ${suffix}` : `${leaf} ${suffix}`);
      while (others.includes(stem(counter).toLowerCase())) counter += 1;
      newPath = stem(counter);
    }
    const ok = renameFolderPath(ns, sectionId, oldPath, newPath, { silent: true });
    if (!ok) return null;
  }
  return newPath;
}

// Move a folder block (path + descendants) within its list.
export function reorderFolderBlock(ns, sectionId, movedRoot, anchorPath, after) {
  const list = folderListOf(ns, sectionId);
  if (!list) return false;
  const block = list.filter((entry) => isFolderOrSub(entry, movedRoot));
  if (!block.length) return false;
  const rest = list.filter((entry) => !isFolderOrSub(entry, movedRoot));
  let index = rest.indexOf(anchorPath);
  if (index === -1) index = rest.length;
  else if (after) index += 1;
  const reordered = [...rest.slice(0, index), ...block, ...rest.slice(index)];
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section) return false;
  section.folders = reordered;
  persistFolderList(ns);
  return true;
}

export function renameFolderPath(ns, sectionId, oldPath, newPath, opts) {
  return renameCustomFolder(sectionId, oldPath, newPath, opts);
}

export function persistFolderList(ns) {
  persistCustomSections();
}

export function bindFolderContextMenu() {
  const menu = getFolderContextMenu();
  if (!menu) return;
  if (noteList) noteList.addEventListener('contextmenu', (event) => {
    // The Vault header is not a workspace folder: no folder menu there.
    if (state.activeView === 'vault') return;
    const row = event.target.closest('.tree-folder-row');
    if (!row || event.target.closest('.tree-rename-input')) return;
    const wrap = row.closest('[data-folder-wrap]');
    if (!wrap) return;
    event.preventDefault();
    event.stopPropagation();
    // Resolve the row's namespace so "New subfolder" becomes a child of the
    // right-clicked folder: the active custom filter wins, otherwise
    // the enclosing list-section shell (home view shows all namespaces).
    const shell = wrap.closest('[data-list-section]');
    const shellKind = shell ? shell.dataset.listSection : null;
    if (state.activeCustom) {
      openFolderContextMenu('custom', wrap.dataset.folderWrap, event.clientX, event.clientY, state.activeCustom.section);
      return;
    }
    if (shellKind === 'custom') {
      const secBtn = shell.querySelector('[data-section-id]');
      const secId = secBtn ? secBtn.dataset.sectionId : null;
      if (secId) {
        openFolderContextMenu('custom', wrap.dataset.folderWrap, event.clientX, event.clientY, secId);
        return;
      }
    }
    // Unknown shell: no folder menu.
    return;
  });
  menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-folder-action]');
    if (!item) return;
    const action = item.dataset.folderAction;
    const target = state.folderMenuTarget;
    closeFolderContextMenu();
    handleFolderMenuAction(action, target);
  });
  document.addEventListener('click', (event) => {
    if (state.folderMenuTarget && !event.target.closest('#folder-context-menu')) closeFolderContextMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    if (state.folderMenuTarget && !event.target.closest('#folder-context-menu')) closeFolderContextMenu();
  });
  window.addEventListener('resize', closeFolderContextMenu);
}

// Create a nested folder under a parent path and jump straight into naming
// it. Without a parent, a top-level folder is created.
export function createSubfolder(ns, parentPath, sectionId) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  // Depth limit: top-level -> sub -> sub-sub, but no deeper.
  if (folderDepth(parentPath) >= MAX_SUBFOLDER_PARENT_DEPTH) {
    showToast('Subfolders can only nest two levels deep');
    return;
  }
  let slideCollapsed = false;
  try { slideCollapsed = document.getElementById('sidebar').classList.contains('collapsed'); } catch (error) {}
  if (slideCollapsed) {
    // The inline rename row lives in the slide menu and is hidden while it
    // is collapsed: ask for the name in a popup instead.
    askInput({ eyebrow: 'New subfolder', title: 'Name the subfolder', desc: `Under ${parentPath}`, label: 'Subfolder name', password: false, placeholder: 'e.g. Projects', okText: 'Create' }).then((value) => {
      if (value == null) return;
      const leaf = String(value).trim().slice(0, 60);
      if (!leaf) { showToast('Give the subfolder a name'); return; }
      if (/[/\\]/.test(leaf)) { showToast('Use a plain name without slashes'); return; }
      const section = state.customSections.find((entry) => entry.id === sectionId);
      if (!section) return;
      const name = `${parentPath}${FOLDER_SEP}${leaf}`;
      if (section.folders.some((entry) => entry.toLowerCase() === name.toLowerCase())) {
        showToast('A folder with that name already exists');
        return;
      }
      insertFolderAfterParent(section.folders, parentPath, name);
      persistCustomSections();
      renderCustomSections();
      renderNoteList();
      showToast('Subfolder created');
    });
    return;
  }
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  const name = uniqueCustomFolderName(sectionId, `${parentPath}${FOLDER_SEP}New folder`);
  insertFolderAfterParent(section.folders, parentPath, name);
  persistCustomSections();
  renderCustomSections();
  renderNoteList();
  showToast('Folder added — name it');
  startCustomFolderRename(sectionId, name);
  return;
}

export function handleFolderMenuAction(action, target) {
  const resolved = target || state.folderMenuTarget;
  if (!resolved || typeof action !== 'string') return;
  const { path, section: sectionId } = resolved;
  if (action === 'open') {
    selectCustomFolder(sectionId, path);
  } else if (action === 'new-note') {
    // File the new note straight into the right-clicked folder.
    state.pendingSectionFolder = { ns: 'custom', section: sectionId, folder: path };
    state.pendingTemplate = null;
    openTemplatePicker();
  } else if (action === 'rename') {
    startCustomFolderRename(sectionId, path);
  } else if (action === 'subfolder') {
    if (folderDepth(path) >= MAX_SUBFOLDER_PARENT_DEPTH) return; // depth limit
    createSubfolder('custom', path, sectionId);
  } else if (action === 'restore') {
    return;
  } else if (action === 'delete') {
    openCustomFolderDeleteConfirm(sectionId, path);
  }
}

export function bindSectionContextMenu() {
  const menu = document.getElementById('section-context-menu');
  if (menu) menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-section-action]');
    if (!item) return;
    const target = state.sectionMenuTarget;
    closeSectionContextMenu();
    handleSectionMenuAction(item.dataset.sectionAction, target);
  });
  document.addEventListener('click', (event) => {
    if (state.sectionMenuTarget && !event.target.closest('#section-context-menu')) closeSectionContextMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    if (state.sectionMenuTarget && !event.target.closest('#section-context-menu')) closeSectionContextMenu();
  });
  window.addEventListener('resize', closeSectionContextMenu);
}

export function bindVaultContextMenu() {
  const menu = document.getElementById('vault-context-menu');
  if (menu) menu.addEventListener('click', (event) => {
    const item = event.target.closest('[data-vault-action]');
    if (!item) return;
    const target = state.vaultMenuTarget;
    closeVaultContextMenu();
    handleVaultMenuAction(item.dataset.vaultAction, target);
  });
  document.addEventListener('click', (event) => {
    if (state.vaultMenuTarget && !event.target.closest('#vault-context-menu')) closeVaultContextMenu();
  });
  document.addEventListener('contextmenu', (event) => {
    if (state.vaultMenuTarget && !event.target.closest('#vault-context-menu')) closeVaultContextMenu();
  });
  window.addEventListener('resize', closeVaultContextMenu);
}

export function chooseSectionIcon(name) {
  const section = state.customSections.find((entry) => entry.id === state.sectionIconTarget);
  if (!section || !SECTION_ICONS.includes(name)) { closeSectionIconPicker(); return; }
  section.icon = name;
  closeSectionIconPicker();
  persistCustomSections();
  renderCustomSections();
  renderNoteList();
  showToast(`Icon set to “${name}”`);
}

export function handleSectionMenuAction(action, sectionId) {
  if (!sectionId || typeof action !== 'string') return;
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  if (action === 'add') {
    addCustomFolder(sectionId);
  } else if (action === 'icon') {
    openSectionIconPicker(sectionId);
  } else if (action === 'rename') {
    if (slideMenuCollapsed()) {
      askInput({ eyebrow: 'Rename section', title: section.name, desc: '', label: 'Section name', password: false, placeholder: section.name, okText: 'Rename' }).then((value) => {
        if (value == null) return;
        renameSectionDisplay(sectionId, value);
      });
    } else {
      startSectionRename({ kind: 'custom', id: sectionId });
    }
  } else if (action === 'delete') {
    openCustomSectionDeleteConfirm(sectionId);
  }
}

export function bindCustomSectionsEvents() {
  const container = document.getElementById('custom-sections');
  if (container) {
    container.addEventListener('click', (event) => {
      // Shared-view person rows: filter the Shared view to that account.
      const person = event.target.closest('[data-shared-person]');
      if (person && state.activeView === 'shared') {
        event.preventDefault();
        try {
          import('../data/collab-crypto.js').then((m) => {
            try { m.toggleSharedPersonFilter(person.dataset.sharedPerson); } catch (error) {}
          });
        } catch (error) {}
        return;
      }
      // Vault-view rows: locked vault opens the unlock modal, unlocked
      // switches between vaults. Also handles the new vault section headers.
      const vaultRow = event.target.closest('[data-vault-row]');
      const vaultSection = event.target.closest('[data-vault-section]');
      const vaultTarget = vaultRow || (vaultSection && vaultSection.dataset.vaultSection ? vaultSection : null);
      if (vaultTarget && state.activeView === 'vault') {
        event.preventDefault();
        const vaultId = vaultTarget.dataset.vaultRow || vaultTarget.dataset.vaultSection;
        try {
          import('./vault.js').then((m) => {
            try {
              if (state.vault.unlocked) m.switchVault(vaultId);
              else if (typeof m.openVaultModal === 'function') m.openVaultModal();
            } catch (error) {}
          });
        } catch (error) {}
        return;
      }
      if (event.target.closest('.collection-rename-input') || event.target.closest('.section-rename-input')) return;
      const addBtn = event.target.closest('[data-custom-add]');
      if (addBtn) {
        event.preventDefault();
        event.stopPropagation();
        addCustomFolder(addBtn.dataset.customAdd);
        return;
      }
      const delSectionBtn = event.target.closest('[data-custom-del-section]');
      if (delSectionBtn) {
        event.preventDefault();
        event.stopPropagation();
        openCustomSectionDeleteConfirm(delSectionBtn.dataset.customDelSection);
        return;
      }
      const renameBtn = event.target.closest('[data-cf-rename]');
      if (renameBtn) {
        event.preventDefault();
        event.stopPropagation();
        startCustomFolderRename(renameBtn.dataset.cfSection, renameBtn.dataset.cfRename);
        return;
      }
      // Vault folder rename button
      const vaultRenameBtn = event.target.closest('[data-vault-cf-rename]');
      if (vaultRenameBtn) {
        event.preventDefault();
        event.stopPropagation();
        try {
          import('./vault.js').then((m) => {
            try { m.renameVaultFolder(vaultRenameBtn.dataset.vaultCfRename); } catch (error) {}
          });
        } catch (error) {}
        return;
      }
      const item = event.target.closest('.collection-item');
      if (item && item.dataset.cfolder) {
        event.preventDefault();
        selectCustomFolder(item.dataset.csection, item.dataset.cfolder);
        return;
      }
      // Vault folder click: filter vault view to this folder
      const vaultItem = event.target.closest('[data-vault-cfolder]');
      if (vaultItem && state.activeView === 'vault') {
        event.preventDefault();
        const vaultId = vaultItem.dataset.vaultSection;
        const folder = vaultItem.dataset.vaultCfolder;
        try {
          import('./vault.js').then((m) => {
            try {
              // Switch to the vault if not already active
              if (String(state.vaultId || 1) !== String(vaultId)) {
                m.switchVault(vaultId).then(() => { m.toggleVaultFolderFilter(folder); });
              } else {
                m.toggleVaultFolderFilter(folder);
              }
            } catch (error) {}
          });
        } catch (error) {}
        return;
      }
    });
    container.addEventListener('dblclick', (event) => {
      if (event.target.closest('.collection-rename-input') || event.target.closest('.section-rename-input')
        || event.target.closest('.collection-action') || event.target.closest('button')) return;
      const label = event.target.closest('.section-label-text');
      if (label) {
        const wrap = label.closest('[data-custom-section]');
        if (wrap) {
          event.preventDefault();
          startSectionRename({ kind: 'custom', id: wrap.dataset.customSection });
        }
        return;
      }
      const item = event.target.closest('.collection-item');
      if (item && item.dataset.cfolder) {
        event.preventDefault();
        startCustomFolderRename(item.dataset.csection, item.dataset.cfolder);
        return;
      }
      // Vault section label double-click to rename vault
      const vaultLabel = event.target.closest('.section-label-text[data-vault-name]');
      if (vaultLabel && state.activeView === 'vault') {
        event.preventDefault();
        const vaultId = vaultLabel.dataset.vaultName;
        try {
          import('./vault.js').then((m) => {
            try { m.renameVault(vaultId); } catch (error) {}
          });
        } catch (error) {}
        return;
      }
      // Vault folder double-click to rename
      const vaultItem = event.target.closest('[data-vault-cfolder]');
      if (vaultItem && state.activeView === 'vault') {
        event.preventDefault();
        try {
          import('./vault.js').then((m) => {
            try { m.renameVaultFolder(vaultItem.dataset.vaultCfolder); } catch (error) {}
          });
        } catch (error) {}
      }
    });
    container.addEventListener('contextmenu', (event) => {
      const head = event.target.closest('.section-label');
      const headWrap = event.target.closest('[data-custom-section]');
      if (head && headWrap && !event.target.closest('input')) {
        event.preventDefault();
        event.stopPropagation();
        closeFolderContextMenu();
        openSectionContextMenu(headWrap.dataset.customSection, event.clientX, event.clientY);
        return;
      }
      // Vault section right-click: open vault context menu
      const vaultHeadWrap = event.target.closest('[data-vault-section]');
      if (head && vaultHeadWrap && state.activeView === 'vault' && !event.target.closest('input')) {
        event.preventDefault();
        event.stopPropagation();
        closeFolderContextMenu();
        openVaultContextMenu(vaultHeadWrap.dataset.vaultSection, event.clientX, event.clientY);
        return;
      }
      const item = event.target.closest('.collection-item');
      if (!item || !item.dataset.cfolder || event.target.closest('.collection-rename-input')) return;
      event.preventDefault();
      event.stopPropagation();
      closeSectionContextMenu();
      openFolderContextMenu('custom', item.dataset.cfolder, event.clientX, event.clientY, item.dataset.csection);
    });
  }
  const newSectionBtn = document.getElementById('new-section');
  if (newSectionBtn) newSectionBtn.addEventListener('click', (event) => {
    event.preventDefault();
    if (state.activeView === 'shared') {
      try { collabCreate(); } catch (error) {}
    } else {
      addCustomSection();
    }
  });
}

// Adopt custom folders found on live notes that the sidebar does not list
// yet (imports, older data), normalizing case onto the sidebar spelling.
export function syncCustomSections() {
  let notesDirty = false;
  let sectionsDirty = false;
  state.customSections.forEach((section) => {
    state.notes.forEach((note) => {
      if (note.deleted) return;
      const folder = customNoteFolder(note, section.id);
      if (!folder) return;
      const canonical = section.folders.find((entry) => entry.toLowerCase() === folder.toLowerCase());
      if (canonical) {
        if (note.sections[section.id] !== canonical) { note.sections[section.id] = canonical; notesDirty = true; }
      } else {
        section.folders.push(folder);
        sectionsDirty = true;
      }
    });
  });
  if (notesDirty) persistNotes();
  if (sectionsDirty) persistCustomSections();
}

// Delete a custom folder and its nested subfolders: the folder is removed
// from the sidebar and every live note inside moves to Bin for 3 days (tags
// are kept, so restoring a note revives its folder via the sidebar sync).
export function deleteCustomFolder(sectionId, folder) {
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  const movedAt = Date.now();
  let count = 0;
  state.notes.forEach((note) => {
    if (note.deleted || !note.sections || typeof note.sections !== 'object') return;
    const current = customNoteFolder(note, sectionId);
    if (current !== null && isFolderOrSub(current, folder)) {
      note.deleted = true;
      note.deletedAt = movedAt;
      count += 1;
    }
  });
  section.folders = section.folders.filter((entry) => !isFolderOrSub(entry, folder));
  if (state.activeCustom && state.activeCustom.section === sectionId && state.activeCustom.folder && isFolderOrSub(state.activeCustom.folder, folder)) {
    state.activeCustom = null;
    state.activeFilter = 'all';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes' && !state.activeCustom));
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
    updateListHeading();
  }
  const current = state.currentId ? state.notes.find((item) => item.id === state.currentId) : null;
  if (!current || current.deleted) {
    state.activeView = 'notes';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes' && !state.activeCustom));
    const live = state.notes.filter((item) => !item.deleted && !item.archived);
    if (live.length) selectNote(live[0].id);
    else clearEditor();
  }
  persistCustomSections();
  persistNotes();
  renderCustomSections();
  renderNoteList();
  showToast(count
    ? `Folder “${folderLeaf(folder)}” moved to Bin — ${count} note${count === 1 ? '' : 's'} kept for 3 days`
    : `Folder “${folderLeaf(folder)}” deleted`);
}

// Validate and rename a custom folder on the section and matching notes.
export function renameCustomFolder(sectionId, oldName, rawNewName, opts) {
  const newName = cleanFolderPath(rawNewName);
  if (!newName) { renderCustomSections(); renderNoteList(); return false; }
  if (newName === oldName) { renderCustomSections(); renderNoteList(); return true; }
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section) return false;
  if (section.folders.some((entry) => entry !== oldName && entry.toLowerCase() === newName.toLowerCase())) {
    showToast('A folder with that name already exists');
    renderCustomSections(); renderNoteList();
    return false;
  }
  section.folders = repathList(section.folders, oldName, newName);
  state.notes.forEach((note) => {
    const current = customNoteFolder(note, sectionId);
    if (current !== null && isFolderOrSub(current, oldName)) {
      note.sections[sectionId] = current === oldName ? newName : newName + current.slice(oldName.length);
    }
  });
  // Keep collapsed state following the rename (same value as Collections had).
  if (state.collapsedFolders.size) {
    const oldPrefix = `${oldName}${FOLDER_SEP}`;
    const next = new Set();
    state.collapsedFolders.forEach((entry) => {
      next.add(entry === oldName ? newName : (entry.startsWith(oldPrefix) ? newName + entry.slice(oldName.length) : entry));
    });
    state.collapsedFolders = next;
    persistCollapsedFolders();
  }
  if (state.activeCustom && state.activeCustom.section === sectionId && state.activeCustom.folder && isFolderOrSub(state.activeCustom.folder, oldName)) {
    state.activeCustom.folder = state.activeCustom.folder === oldName ? newName : newName + state.activeCustom.folder.slice(oldName.length);
    updateListHeading();
  }
  persistCustomSections();
  persistNotes();
  renderCustomSections();
  renderNoteList();
  if (!opts || !opts.silent) showToast(`Folder renamed to “${folderLeaf(newName)}”`);
  return true;
}

// Inline rename for a custom-section folder row.
export function startCustomFolderRename(sectionId, folder) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  renderCustomSections();
  const item = findCustomItem(sectionId, folder);
  if (!item) return;
  const input = item.querySelector('.collection-rename-input');
  const label = item.querySelector('.collection-label');
  const actions = item.querySelector('.collection-actions');
  if (!input) return;
  input.hidden = false;
  if (label) label.hidden = true;
  if (actions) actions.hidden = true;
  input.value = folderLeaf(folder);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    // Leaf-only commit: the parent prefix is re-attached so the folder (and
    // its children) cannot slip out of place.
    if (commit) renameCustomFolder(sectionId, folder, joinLeafRename(folder, input.value));
    else { renderCustomSections(); renderNoteList(); }
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  };
  input.onclick = (event) => event.stopPropagation();
  input.onblur = () => finish(true);
}

// Add a folder to one section from its All-Notes header (folder-plus beside
// the edit pencil). Keeps the current view. When the slide menu is collapsed
// the inline rename row is hidden, so the name is asked in a popup instead.
export function addFolderToSection(sectionId) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  let slideCollapsed = false;
  try { slideCollapsed = document.getElementById('sidebar').classList.contains('collapsed'); } catch (error) {}
  const commit = (leaf) => {
    const clean = String(leaf == null ? '' : leaf).trim().slice(0, 60);
    if (!clean) { showToast('Give the folder a name'); return; }
    if (/[/\\]/.test(clean)) { showToast('Use a plain name without slashes'); return; }
    if (section.folders.some((entry) => entry.toLowerCase() === clean.toLowerCase())) {
      showToast('A folder with that name already exists');
      return;
    }
    section.folders.push(clean);
    persistCustomSections();
    renderCustomSections();
    renderNoteList();
    showToast('Folder added');
  };
  if (slideCollapsed) {
    askInput({ eyebrow: 'New folder', title: 'Name the folder', desc: `In ${section.name}`, label: 'Folder name', password: false, placeholder: 'e.g. Projects', okText: 'Create' }).then((value) => {
      if (value != null) commit(value);
    });
    return;
  }
  const name = uniqueCustomFolderName(sectionId, 'New folder');
  section.folders.push(name);
  persistCustomSections();
  renderCustomSections();
  renderNoteList();
  showToast('Folder added — name it');
  startCustomFolderRename(sectionId, name);
}

export function addCustomFolder(sectionId) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  const section = state.customSections.find((entry) => entry.id === sectionId);
  if (!section) return;
  if (slideMenuCollapsed()) {
    // Inline naming lives in the slide menu and is hidden while collapsed.
    askInput({ eyebrow: 'New folder', title: 'Name the folder', desc: `In ${section.name}`, label: 'Folder name', password: false, placeholder: 'e.g. Projects', okText: 'Create' }).then((value) => {
      if (value == null) return;
      const leaf = String(value).trim().slice(0, 60);
      if (!leaf) { showToast('Give the folder a name'); return; }
      if (/[/\\]/.test(leaf)) { showToast('Use a plain name without slashes'); return; }
      if (section.folders.some((entry) => entry.toLowerCase() === leaf.toLowerCase())) {
        showToast('A folder with that name already exists');
        return;
      }
      section.folders.push(leaf);
      persistCustomSections();
      state.activeView = 'notes';
      state.activeCustom = null;
      state.activeFilter = 'all';
      document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes' && !state.activeCustom));
      document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
      clearSearch();
      updateListHeading();
      renderCustomSections();
      renderNoteList();
      showToast('Folder added');
    });
    return;
  }
  const name = uniqueCustomFolderName(sectionId, 'New folder');
  section.folders.push(name);
  persistCustomSections();
  state.activeView = 'notes';
  state.activeCustom = null;
  state.activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes' && !state.activeCustom));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
  showToast('Folder added — name it');
  startCustomFolderRename(sectionId, name);
}

// Delete a custom section: the section is removed from the sidebar, stashed
// in Bin, and every live note inside moves to Bin for 3 days (section tags
// are kept, so restoring a note revives its section).
export function deleteCustomSection(id) {
  const index = state.customSections.findIndex((entry) => entry.id === id);
  if (index === -1) return;
  const removed = state.customSections[index];
  const name = removed.name;
  const movedAt = Date.now();
  let count = 0;
  state.notes.forEach((note) => {
    if (!note.deleted && customNoteFolder(note, id) !== null) {
      note.deleted = true;
      note.deletedAt = movedAt;
      count += 1;
    }
  });
  state.customSections.splice(index, 1);
  if (count) {
    state.deletedCustomSections = (state.deletedCustomSections || []).filter((entry) => entry.id !== id);
    state.deletedCustomSections.push({
      id, name, folders: [...(removed.folders || [])], deletedAt: movedAt,
    });
    persistDeletedCustomSections();
  }
  if (state.activeCustom && state.activeCustom.section === id) {
    state.activeCustom = null;
    state.activeFilter = 'all';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes' && !state.activeCustom));
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
    updateListHeading();
  }
  const current = state.currentId ? state.notes.find((item) => item.id === state.currentId) : null;
  if (!current || current.deleted) {
    state.activeView = 'notes';
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes' && !state.activeCustom));
    const live = state.notes.filter((item) => !item.deleted && !item.archived);
    if (live.length) selectNote(live[0].id);
    else clearEditor();
  }
  persistCustomSections();
  persistNotes();
  renderCustomSections();
  renderNoteList();
  showToast(count
    ? `Section “${name}” moved to Bin — ${count} note${count === 1 ? '' : 's'} kept for 3 days`
    : `Section “${name}” deleted`);
}

// Validate and apply a section display-name edit (all sections share the same implementation).
export function renameSectionDisplay(id, rawNewName) {
  const newName = String(rawNewName == null ? '' : rawNewName).replace(/[\x00-\x1F<>"]/g, '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!newName) { renderCustomSections(); renderNoteList(); return false; }
  const section = state.customSections.find((entry) => entry.id === id);
  if (!section) { renderCustomSections(); renderNoteList(); return false; }
  const current = section.name || '';
  if (newName === current) { renderCustomSections(); renderNoteList(); return true; }
  if (takenSectionNames(id).includes(newName.toLowerCase())) {
    showToast('A section with that name already exists');
    renderCustomSections(); renderNoteList();
    return false;
  }
  section.name = newName;
  persistCustomSections();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
  showToast('Section renamed');
  return true;
}

// Inline rename for a section header (built-in or custom); Enter commits.
export function startSectionRename(target, anchorEl) {
  // Workspace-anchored rename (pencil/dblclick in the note list): edit inline
  // in the list header where clicked — never in the slide menu.
  if (anchorEl && anchorEl.isConnected && anchorEl.closest('#note-list')) {
    const head = anchorEl.closest('.list-section-head');
    if (head && !head.querySelector('.section-rename-input')) {
      const section = state.customSections.find((entry) => entry.id === target.id);
      const input = document.createElement('input');
      input.className = 'section-rename-input';
      input.value = (section || {}).name || '';
      input.maxLength = 40;
      input.setAttribute('aria-label', 'Section name');
      anchorEl.hidden = true;
      anchorEl.after(input);
      input.focus();
      input.select();
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        input.remove();
        anchorEl.hidden = false;
        if (commit) renameSectionDisplay(target.id, input.value);
        else renderNoteList();
      };
      input.onkeydown = (event) => {
        if (event.key === 'Enter') { event.preventDefault(); finish(true); }
        if (event.key === 'Escape') { event.preventDefault(); finish(false); }
        event.stopPropagation();
      };
      input.onclick = (event) => event.stopPropagation();
      input.onblur = () => finish(true);
      return;
    }
    if (head) {
      const pending = head.querySelector('.section-rename-input');
      if (pending) { pending.focus(); pending.select(); return; }
    }
  }
  renderCustomSections();
  let label = null;
  if (target.kind === 'custom') {
    const wrap = [...document.querySelectorAll('#custom-sections [data-custom-section]')]
      .find((el) => el.dataset.customSection === target.id);
    label = wrap ? wrap.querySelector('.section-label-text') : null;
  }
  if (!label) return;
  // The label is hidden (not replaced): built-in headers are static markup
  // that no render rebuilds, so removing it would lose the label forever.
  // A second double-click while open just refocuses the pending input.
  const pending = label.parentElement ? label.parentElement.querySelector('.section-rename-input') : null;
  if (pending) { pending.focus(); pending.select(); return; }
  const input = document.createElement('input');
  input.className = 'section-rename-input';
  input.value = (state.customSections.find((section) => section.id === target.id) || {}).name || '';
  input.maxLength = 40;
  input.setAttribute('aria-label', 'Section name');
  label.hidden = true;
  label.after(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    input.remove();
    label.hidden = false;
    if (commit) renameSectionDisplay(target.id, input.value);
    else { renderCustomSections(); renderNoteList(); }
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  };
  input.onclick = (event) => event.stopPropagation();
  input.onblur = () => finish(true);
}

export async function addCustomSection() {
  if (!e2ee.masterKey) { showToast('Log in to manage sections'); return; }
  // Inside the Vault, "+ Add section" creates another vault (max 3) under
  // the shared password — and stays in context.
  if (state.activeView === 'vault') {
    try {
      import('./vault.js').then((m) => {
        try { m.createAdditionalVault(); } catch (error) {}
      });
    } catch (error) {}
    return;
  }
  const name = await askInput({
    eyebrow: 'Section',
    title: 'New Section',
    desc: 'Give your section a name.',
    label: 'Section name',
    password: false,
    placeholder: 'My section',
    okText: 'Create',
  });
  if (!name || !name.trim()) return;
  const section = { id: uniqueSectionId(), name: uniqueSectionName(name.trim()), folders: [], icon: SECTION_ICONS[0] };
  state.customSections.push(section);
  persistCustomSections();
  state.activeView = 'notes';
  state.activeFilter = 'all';
  state.activeCustom = null;
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'notes' && !state.activeCustom));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
  showToast(`Section "${section.name}" created`);
  startSectionRename({ kind: 'custom', id: section.id });
}

// Delete every folder in a built-in section and hide the section header;
// notes keep everything else. Restore via Settings → Side Menu.
// (Custom sections have deleteCustomSection; single folders use their own confirms.)
export function bindSectionHeaderEvents() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  sidebar.addEventListener('click', (event) => {
    if (event.target.closest('button') || event.target.closest('input')) return;
    // The section name and its icon both select (mark) the section.
    const label = event.target.closest('.section-label-text, .section-icon');
    if (!label) return;
    const section = label.closest('.sidebar-section');
    if (!section) return;
    event.preventDefault();
    if (section.dataset.customSection) {
      if (!isSectionEmpty('custom', section.dataset.customSection)) selectCustomSection(section.dataset.customSection);
    }
  });
  sidebar.addEventListener('dblclick', (event) => {
    if (event.target.closest('button') || event.target.closest('input')) return;
    const label = event.target.closest('.section-label-text');
    if (!label) return;
    const section = label.closest('.sidebar-section');
    if (!section) return;
    event.preventDefault();
    if (section.dataset.customSection) startSectionRename({ kind: 'custom', id: section.dataset.customSection });
  });
  // Collapsed slide menu shows section initials: clicking one opens the
  // section in the workspace (empty sections stay put, like labels).
  sidebar.addEventListener('click', (event) => {
    const initial = event.target.closest('.section-initial');
    if (!initial) return;
    const section = initial.closest('.sidebar-section');
    if (!section || !section.dataset.customSection) return;
    event.preventDefault();
    if (!isSectionEmpty('custom', section.dataset.customSection)) selectCustomSection(section.dataset.customSection);
  });
}

// Revive binned custom sections a (newly live) note belongs to, so it has
// a home. Custom folders inside live sections are re-adopted by the
// sidebar sync that callers run afterwards.
export function reviveSectionsForNote(note) {
  if (!note || !note.sections || typeof note.sections !== 'object') return false;
  let revived = false;
  Object.keys(note.sections).forEach((sectionId) => {
    if (customNoteFolder(note, sectionId) === null) return;
    if (state.customSections.some((entry) => entry.id === sectionId)) return;
    const stashed = (state.deletedCustomSections || []).find((entry) => entry.id === sectionId);
    if (stashed) {
      const folders = [...(stashed.folders || [])];
      if (!folders.some((entry) => entry === note.sections[sectionId])) folders.push(note.sections[sectionId]);
      state.customSections.push({ id: stashed.id, name: stashed.name, folders });
    } else {
      state.customSections.push({ id: sectionId, name: 'Restored section', folders: [note.sections[sectionId]] });
    }
    revived = true;
  });
  if (revived) {
    persistCustomSections();
    pruneDeletedCustomSections();
  }
  return revived;
}

// Persist collapsed tree-folder state into the encrypted UI vault.
export function persistCollapsedFolders() {
  persistUiVault();
}

// Drop section Bin records with no binned notes left (or past retention).
export function pruneDeletedCustomSections() {
  const now = Date.now();
  const before = (state.deletedCustomSections || []).length;
  state.deletedCustomSections = (state.deletedCustomSections || []).filter((entry) => (
    now - entry.deletedAt <= BIN_RETENTION_MS
    && state.notes.some((note) => note.deleted && note.sections
      && typeof note.sections === 'object' && customNoteFolder(note, entry.id) !== null)
  ));
  if (state.deletedCustomSections.length !== before) persistDeletedCustomSections();
}

// Persist binned custom-section records {id, name, folders, deletedAt}.
export function persistDeletedCustomSections() {
  persistUiVault();
}

// Ensure the migrated former-Collections custom section exists and carries
// the same folders/value. All new sections share this implementation.
export function ensureMigratedCollectionsSection(legacyFolders, legacyName) {
  const folders = Array.isArray(legacyFolders)
    ? legacyFolders.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim().slice(0, 180)).slice(0, 200)
    : [];
  let section = state.customSections.find((entry) => entry.id === MIGRATED_COLLECTIONS_SECTION_ID);
  if (!section) {
    const baseName = (typeof legacyName === 'string' && legacyName.trim() ? legacyName.trim().slice(0, 40) : 'Collections');
    const taken = new Set(state.customSections.map((entry) => entry.name.toLowerCase()));
    let name = baseName;
    if (taken.has(name.toLowerCase())) {
      let counter = 2;
      while (taken.has(`${baseName} ${counter}`.toLowerCase())) counter += 1;
      name = `${baseName} ${counter}`;
    }
    const merged = [...folders];
    if (!merged.length) DEFAULT_CUSTOM_FOLDERS.forEach((name) => { if (!merged.some((entry) => entry.toLowerCase() === name.toLowerCase())) merged.push(name); });
    section = { id: MIGRATED_COLLECTIONS_SECTION_ID, name, folders: merged };
    state.customSections.unshift(section);
  } else {
    folders.forEach((name) => {
      if (!section.folders.some((entry) => entry.toLowerCase() === name.toLowerCase())) section.folders.push(name);
    });
    if (typeof legacyName === 'string' && legacyName.trim() && section.name !== legacyName.trim()) {
      const taken = new Set(state.customSections.filter((entry) => entry.id !== section.id).map((entry) => entry.name.toLowerCase()));
      if (!taken.has(legacyName.trim().toLowerCase())) section.name = legacyName.trim().slice(0, 40);
    }
  }
  // Migrate note.collection -> note.sections[migratedId] (same value, new home).
  let notesDirty = false;
  state.notes.forEach((note) => {
    if (typeof note.collection === 'string' && note.collection.trim()) {
      const folder = note.collection.trim().slice(0, 180);
      if (!note.sections || typeof note.sections !== 'object' || Array.isArray(note.sections)) note.sections = {};
      if (typeof note.sections[section.id] !== 'string' || !note.sections[section.id]) {
        note.sections[section.id] = folder;
        notesDirty = true;
      }
      if (!section.folders.some((entry) => entry.toLowerCase() === folder.toLowerCase())) {
        section.folders.push(folder);
      }
    }
    if ('collection' in note) { delete note.collection; notesDirty = true; }
  });
  if (notesDirty) persistNotes();
  persistCustomSections();
  return section;
}


export function findCustomItem(sectionId, folder) {
  return [...document.querySelectorAll('#custom-sections .collection-item')]
    .find((item) => item.dataset.csection === sectionId && item.dataset.cfolder === folder) || null;
}

// Rewrite exact + descendant paths in a folder list (sidebar, collapsed keys).
export function repathList(list, oldPath, newPath) {
  const prefix = `${oldPath}${FOLDER_SEP}`;
  return list.map((entry) => {
    if (entry === oldPath) return newPath;
    if (entry.startsWith(prefix)) return newPath + entry.slice(oldPath.length);
    return entry;
  });
}

// Inline rename for All-Notes folder headers; refused in Bin.
export function startTreeRename(folder) {
  if (!e2ee.masterKey) { showToast('Log in to manage folders'); return; }
  if (state.activeView === 'bin') return;
  const wrap = findTreeWrap(folder);
  if (!wrap) return;
  const row = wrap.querySelector('.tree-folder-row');
  const folderBtn = wrap.querySelector('[data-folder]');
  const renameBtn = wrap.querySelector('[data-folder-rename]');
  let input = wrap.querySelector('.tree-rename-input');
  if (!input) {
    input = document.createElement('input');
    input.className = 'tree-rename-input';
    input.maxLength = 60;
    input.setAttribute('aria-label', 'Folder name');
    row.appendChild(input);
  }
  input.value = folderLeaf(folder);
  input.hidden = false;
  if (folderBtn) folderBtn.hidden = true;
  if (renameBtn) renameBtn.hidden = true;
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    if (commit) {
      // Namespace follows the row; fall back to whichever custom section owns the folder.
      let sectionId = null;
      if (state.activeCustom) sectionId = state.activeCustom.section;
      else {
        const shell = wrap.closest('[data-list-section]');
        const kind = shell ? shell.dataset.listSection : null;
        if (kind === 'custom') {
          const secBtn = shell.querySelector('[data-section-id]');
          if (secBtn && secBtn.dataset.sectionId) sectionId = secBtn.dataset.sectionId;
        }
      }
      if (!sectionId) {
        const owner = state.customSections.find((section) => section.folders.some((entry) => entry === folder || isFolderOrSub(entry, folder) || isFolderOrSub(folder, entry)));
        if (owner) sectionId = owner.id;
      }
      if (!sectionId) { renderNoteList(); return; }
      renameFolderPath('custom', sectionId, folder, joinLeafRename(folder, input.value));
    }
    else renderNoteList();
  };
  input.onkeydown = (event) => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
    event.stopPropagation();
  };
  input.onclick = (event) => event.stopPropagation();
  input.ondblclick = (event) => event.stopPropagation();
  input.onblur = () => finish(true);
}
