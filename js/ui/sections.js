// js/ui/sections.js — custom sections & folders: data hygiene, palette
// mapping, unique ids, rename/delete flows, tree helpers, context menus.

import { foldToggle } from '../core/elements.js';
import { icon } from '../core/icons.js';
import { FOLDER_SEP, MAX_SUBFOLDER_PARENT_DEPTH, folderDepth, folderLeaf, folderParent, isFolderOrSub } from '../core/paths.js';
import { escapeHtml } from '../core/strings.js';
import { apiFetch } from '../data/api.js';
import { collabDecrypt, collabDecryptGroupMeta, collabDecryptMeta, collabEncrypt, collabEncryptGroupMeta, collabEncryptMeta, collabKeyFor, loadYjs, sharedGroupOwnerOf, sharedNoteRow, sharingRecipientPublicKey, signWrap, wrapRawKeyFor } from '../data/collab-crypto.js';
import { e2eeRandomBytes } from '../data/crypto.js';
import { COLLECTION_COLORS, SECTION_ICONS, sharedCollapsed, sharedGroupFolders, sharedGroupKeys, sharedGroupTags, sharedNoteMeta } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { showToast } from './modal.js';
import { setDeleteDialog } from './notes.js';
import { normalizeTagName, sharedGroupTagList } from './tags.js';
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
  overlay.hidden = false;
  const input = document.getElementById('section-tags-input');
  if (input) { input.value = ''; try { input.focus(); } catch (error) {} }
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
  roots.sort((a, b) => a.localeCompare(b));
  childrenOf.forEach((arr) => arr.sort((a, b) => a.localeCompare(b)));
  const parts = [];
  const emit = (folder) => {
    const depth = folderDepth(folder);
    const leaf = folderLeaf(folder);
    const collapsed = sharedCollapsed.has(sharedFolderKey(groupId, folder));
    parts.push(`<div class="shared-folder" draggable="true" data-shared-folder="${escapeHtml(folder)}" data-shared-group="${groupId}" style="padding-left:${8 + depth * 14}px">
        <button type="button" class="shared-folder-toggle${collapsed ? ' is-collapsed' : ''}" data-shared-toggle="${escapeHtml(folder)}" data-shared-group="${groupId}" title="${collapsed ? 'Expand' : 'Collapse'}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(leaf)}">${icon('chevron-right')}</button>
        ${icon('folder')}<span class="shared-folder-name">${escapeHtml(leaf)}</span>
        <span class="shared-folder-actions">
          <button type="button" class="shared-folder-action" data-folder-note="${escapeHtml(folder)}" data-folder-group="${groupId}" title="New note in ${escapeHtml(leaf)}" aria-label="New note in ${escapeHtml(leaf)}">${icon('file-text')}</button>
          <button type="button" class="shared-folder-action" data-folder-sub="${escapeHtml(folder)}" data-folder-group="${groupId}" title="New subfolder in ${escapeHtml(leaf)}" aria-label="New subfolder in ${escapeHtml(leaf)}">${icon('folder-plus')}</button>
        </span>
      </div>`);
    if (collapsed) return;
    // A folder's own notes come first, directly under it, then its subfolders.
    notesDec.filter((n) => n.folder === folder).forEach((n) => parts.push(sharedNoteRow(n, groupId, canDelete)));
    (childrenOf.get(folder) || []).forEach(emit);
  };
  roots.forEach(emit);
  notesDec.filter((n) => !n.folder).forEach((n) => parts.push(sharedNoteRow(n, groupId, canDelete)));
  return parts.join('') || '<p class="modal-desc" style="padding:2px 10px 6px">No notes yet — use + New note in this section.</p>';
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

export function uniqueSectionName() {
  const taken = new Set(takenSectionNames(null));
  let counter = 1;
  while (taken.has(`section ${counter}`)) counter += 1;
  return `Section ${counter}`;
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

// Paint section headers (all sections share the same custom implementation).
export function updateSectionHeaders() {
  document.querySelectorAll('#custom-sections .sidebar-section').forEach((wrap) => {
    const id = wrap.dataset.customSection;
    wrap.classList.toggle('active-section', Boolean(state.activeCustom && !state.activeCustom.folder && state.activeCustom.section === id));
    wrap.classList.toggle('is-empty', isSectionEmpty('custom', id));
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
  container.innerHTML = state.customSections.map((section) => `
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
