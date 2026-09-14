// js/ui/misc.js — remaining leaf helpers pending a better home;
// candidates for later re-grouping as the core splits.

import { relativeEditedLabel } from '../core/dates.js';
import { listHeading, markdownInput, tagList, titleInput, wordCount } from '../core/elements.js';
import { icon } from '../core/icons.js';
import { FOLDER_SEP, folderLeaf } from '../core/paths.js';
import { sanitizeIngredients, sanitizeSteps } from '../core/schema.js';
import { escapeHtml } from '../core/strings.js';
import { apiFetch } from '../data/api.js';
import { sharingPublishSigningKey, sharingUnwrapAccountKey, sharingWrapAccountKey } from '../data/collab-crypto.js';
import { e2ee, e2eeBytesToB64 } from '../data/crypto.js';
import { COLLAPSED_FOLDERS_KEY, NOTE_TEMPLATES, SECTION_DATA_KEY, rekeyInFlight } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { cleanAvatarSrc } from './auth.js';
import { renderRecipeHero, setCoverAddHidden } from './editor.js';
import { showToast } from './modal.js';
import { setDeleteDialog } from './notes.js';
import { cleanCustomSections, rotateGroupSection, sectionDisplayName, sectionIconName } from './sections.js';
import { cleanTagList, renderSharedTags } from './tags.js';
import { THEMES } from './theme.js';
// Hide the template chooser popup.
export function closeTemplatePicker() {
  state.vaultTemplatePending = false;
  state.pendingSharedTemplate = null;
  const overlay = document.getElementById('template-overlay');
  if (overlay) overlay.hidden = true;
}

// Single source of truth for the New-note chooser, shared by All Notes and the
// Shared view so the two pickers are always identical.
export function renderTemplateOptions() {
  const box = document.getElementById('template-options');
  if (!box) return;
  box.innerHTML = Object.keys(NOTE_TEMPLATES).map((key) => {
    const template = NOTE_TEMPLATES[key];
    const label = template.label || template.caption || key;
    return `<button class="template-option template-square" data-template="${escapeHtml(key)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
        <span class="template-icon">${icon(template.icon || 'file-text')}</span>
        <span class="template-caption">${escapeHtml(template.caption || key)}</span>
      </button>`;
  }).join('');
}

// De-duplicate a note title (case-insensitive) by appending a counter.
// Binned notes don't squat names — only live ones count.
export function uniqueTitle(base) {
  const clean = (typeof base === 'string' ? base : 'Untitled note').trim().slice(0, 180) || 'Untitled note';
  const taken = new Set(state.notes.filter((note) => !note.deleted).map((note) => String(note.title || '').toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  let counter = 2;
  while (taken.has(`${clean} ${counter}`.toLowerCase())) counter += 1;
  return `${clean} ${counter}`;
}

// Hide the confirm popup and clear the pending action.
export function closeDeleteConfirm() {
  const overlay = document.getElementById('delete-overlay');
  if (overlay) overlay.hidden = true;
  state.pendingDeleteId = null;
  state.pendingDeleteMode = 'soft';
  state.pendingDeleteSection = null;
}

// Popup: permanently erase one binned note (no recovery).
export function openPermanentDeleteConfirm(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  state.pendingDeleteId = id;
  state.pendingDeleteMode = 'permanent';
  setDeleteDialog({
    eyebrow: 'Permanently delete',
    title: 'Delete forever?',
    name: note.title || 'Untitled note',
    message: '” will be permanently deleted and cannot be recovered. Are you sure?'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
}

// Popup: delete an important-tagged note (moves to Bin, restorable for 3 days).
export function openDeleteConfirm(id) {
  const note = state.notes.find((item) => item.id === id);
  if (!note) return;
  state.pendingDeleteId = id;
  state.pendingDeleteMode = 'soft';
  setDeleteDialog({
    eyebrow: 'Delete note',
    title: 'Delete this note?',
    name: note.title || 'Untitled note',
    message: '” is marked as important. Move it to Bin anyway? You can restore it within 3 days.'
  });
  const overlay = document.getElementById('delete-overlay');
  if (overlay) {
    overlay.hidden = false;
    const confirmBtn = document.getElementById('confirm-delete');
    if (confirmBtn) confirmBtn.focus();
  }
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

export function updateMeta(note) {
  // Shared notes render their tags from the Yjs doc instead of note.tags.
  if (state.collab.noteId) { renderSharedTags(); return; }
  renderRecipeHero(note);
  let body = typeof note.body === 'string' ? note.body : '';
  if (note.template === 'recipe') {
    body = `${sanitizeIngredients(note.ingredients).map((item) => item.t).join(' ')} ${sanitizeSteps(note.steps).join(' ')}`;
  }
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  wordCount.textContent = `${words} word${words === 1 ? '' : 's'}`;
  const editedEl = document.getElementById('edited-label');
  if (editedEl) editedEl.textContent = relativeEditedLabel(note);
  const tags = Array.isArray(note.tags) ? note.tags.filter((tag) => typeof tag === 'string').slice(0, 20) : [];
  // "+" affordance sits inline after the tags and opens the tag editor for THIS
  // note (the note id is bound to the button). It only appears for the user's
  // own regular notes: vault and shared/collab notes have no editable tag list,
  // and showing it there used to tag whichever regular note was last active.
  const taggable = !state.collab.noteId && state.activeView !== 'vault' && state.activeView !== 'shared'
    && state.notes.some((item) => item.id === note.id);
  const addTagButton = taggable
    ? `<button type="button" class="tag-add" data-note-id="${escapeHtml(String(note.id))}" title="Add tag" aria-label="Add tag">+</button>`
    : '';
  tagList.innerHTML = tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join('') + addTagButton;
  document.getElementById('favorite-button').classList.toggle('is-favorite', Boolean(note.favorite));
  document.getElementById('favorite-button').style.color = note.favorite ? '#b79b54' : '';
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

// Single place that computes the list heading from view + collection + chip filter (e.g. "Work · Starred").
export function updateListHeading() {
  const suffix = state.activeFilter === 'favorites' ? ' · Starred' : state.activeFilter === 'recent' ? ' · Recent' : '';
  if (state.activeView === 'bin') listHeading.textContent = `Bin${suffix}`;
  else if (state.activeView === 'vault') listHeading.textContent = `Vault${suffix}`;
  else if (state.activeView === 'shared') listHeading.textContent = 'Shared';
  else if (state.activeView === 'archive') listHeading.textContent = `Archive${suffix}`;
  else if (state.activeView === 'favorites') listHeading.textContent = 'Starred notes';
  else if (state.activeCustom) listHeading.textContent = `${state.activeCustom.folder ? folderLeaf(state.activeCustom.folder) : sectionDisplayName('custom', state.activeCustom.section)}${suffix}`;
  else listHeading.textContent = state.activeFilter === 'favorites' ? 'Starred notes' : state.activeFilter === 'recent' ? 'Recent notes' : 'All Notes';
  // Collapsed-strip name mirrors the heading (dev), rendered vertically.
  try {
    const viewIcon = document.getElementById('workspace-view-icon');
    if (viewIcon) {
      const name = listHeading.textContent || '';
      viewIcon.textContent = name.trim() || '?';
      viewIcon.title = listHeading.textContent;
    }
  } catch (error) {}
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

export function readLegacyUiKeys() {
  const out = { cols: null, colsName: null, collapsed: null, sections: null };
  try {
    const storedSections = JSON.parse(localStorage.getItem(SECTION_DATA_KEY) || 'null');
    if (storedSections && typeof storedSections === 'object') {
      const clean = cleanCustomSections(storedSections.sections);
      if (clean && clean.length) {
        out.sections = { sections: clean };
      }
      if (storedSections.names && typeof storedSections.names.collections === 'string' && storedSections.names.collections.trim()) {
        out.colsName = storedSections.names.collections.trim().slice(0, 40);
      }
    }
  } catch (error) {}
  try {
    const stored = JSON.parse(localStorage.getItem('notely-collections') || 'null');
    if (Array.isArray(stored)) {
      const cols = stored.filter((name) => typeof name === 'string' && name.trim()).slice(0, 200);
      if (cols.length) out.cols = cols;
    }
  } catch (error) {}
  try {
    const storedCollapsed = JSON.parse(localStorage.getItem(COLLAPSED_FOLDERS_KEY) || 'null');
    if (Array.isArray(storedCollapsed)) {
      const collapsed = storedCollapsed.filter((name) => typeof name === 'string').slice(0, 500);
      out.collapsed = collapsed;
    }
  } catch (error) {}
  return out;
}

// Validate + normalize a UI snapshot from the server (never throws). Returns
// the cleaned object or null when unusable.
export function cleanUiSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  out.collapsed = Array.isArray(value.collapsed)
    ? value.collapsed.filter((name) => typeof name === 'string').slice(0, 500) : null;
  const cleanCustom = cleanCustomSections(value.customSections);
  if (cleanCustom) out.customSections = cleanCustom;
  // Legacy built-in Collections data (pre-unification): carried for migration
  // in applyUiSnapshot into the default custom section.
  if (Array.isArray(value.collections)) {
    const legacyCols = value.collections.filter((name) => typeof name === 'string' && name.trim()).slice(0, 200);
    if (legacyCols.length) out.legacyCollections = legacyCols;
  }
  if (value.sectionNames && typeof value.sectionNames.collections === 'string' && value.sectionNames.collections.trim()) {
    out.legacyCollectionsName = value.sectionNames.collections.trim().slice(0, 40);
  }
  if (Array.isArray(value.deletedCustomSections)) {
    const cleanSections = value.deletedCustomSections.filter((entry) => (
      entry && typeof entry.id === 'string' && entry.id.trim()
      && typeof entry.name === 'string' && entry.name.trim()
      && typeof entry.deletedAt === 'number'
    )).map((entry) => ({
      id: entry.id.slice(0, 80), name: entry.name.trim().slice(0, 40),
      folders: Array.isArray(entry.folders)
        ? entry.folders.filter((name) => typeof name === 'string' && name.trim())
          .map((name) => name.trim().slice(0, 180)).slice(0, 200)
        : [],
      deletedAt: entry.deletedAt,
    })).slice(0, 20);
    if (cleanSections.length) out.deletedCustomSections = cleanSections;
  }
  if (typeof value.theme === 'string' && THEMES.includes(value.theme)) {
    out.theme = value.theme;
  }
  if (typeof value.avatar === 'string' && cleanAvatarSrc(value.avatar)) {
    out.avatar = value.avatar.trim();
  }
  if (Array.isArray(value.tags)) {
    const tags = cleanTagList(value.tags);
    if (tags.length) out.tags = tags;
  }
  if (out.collapsed === null
    && !out.customSections && !out.legacyCollections && !out.legacyCollectionsName && !out.deletedCustomSections && !out.theme && !out.avatar && !out.tags) return null;
  return out;
}

// Plain-object snapshot of the whole sidebar state for the server envelope.
export function uiSnapshot() {
  let theme = 'light';
  try {
    const current = document.documentElement.dataset.theme
      || localStorage.getItem('notely-theme') || 'light';
    if (THEMES.includes(current)) theme = current;
  } catch (error) {}
  return {
    collapsed: [...state.collapsedFolders],
    customSections: state.customSections.map((section) => ({ id: section.id, name: section.name, folders: [...section.folders], icon: sectionIconName(section) })),
    deletedCustomSections: (state.deletedCustomSections || []).map((entry) => ({
      id: entry.id, name: entry.name,
      folders: [...(entry.folders || [])], deletedAt: entry.deletedAt,
    })),
    theme,
    avatar: state.profileAvatar || '',
    tags: state.knownTags,
  };
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
