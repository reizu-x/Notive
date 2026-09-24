// js/ui/vault.js — private-vault modal plumbing: open/close renders and
// lock-state banners. All modal state lives on the shared state object.

import { icon } from '../core/icons.js';
import { state } from '../domain/state.js';
import { apiFetch } from '../data/api.js';
import { e2ee, e2eeB64ToBytes, e2eeBytesToB64, e2eeRandomBytes } from '../data/crypto.js';
import { COLLAPSED_FOLDERS_KEY, UI_VAULT_KEY } from '../domain/constants.js';
import { askInput, showToast } from './modal.js';
import { setDeleteDialog } from './notes.js';
import { THEMES } from './theme.js';
import { isRecentNote } from '../core/dates.js';
import { allCount, breadcrumbTitle, listEmpty, markdownInput, noteList, recentCountEl, starredCountEl, titleInput, totalCount } from '../core/elements.js';
import { newNoteId } from '../core/ids.js';
import { folderDepth, folderIconForDepth, isFolderOrSub } from '../core/paths.js';
import { normalizeExt } from '../core/schema.js';
import { escapeHtml } from '../core/strings.js';
import { argon2id32 } from '../data/crypto.js';
import { currentVaultBlobs, decryptAllVaultBlobs, timingSafeEqualStr, uniqueVaultTitle } from '../data/vault.js';
import { NOTE_TEMPLATES } from '../domain/constants.js';
import { passwordPolicyCheck } from './auth.js';
import { exitCoverRepos, renderCover, renderPreview } from './editor.js';
import { setSaveLabel } from './feedback.js';
import { clearEditor, clearSearch, goAllNotes, persistNotes, renderNoteList, updateBinUI } from './notes.js';
import { addVaultFolder, ensureMigratedCollectionsSection, openVaultFolderDeleteConfirm, openVaultFolderPicker, persistCollapsedFolders, renameVaultFolder, renderCustomSections } from './sections.js';
import { welcomeSeedUi } from './shell.js';
import { renderStripItems, renderTabs, trackTab, updateBreadcrumbs } from './tabs.js';
import { SECTION_DATA_KEY } from '../domain/constants.js';
import { cleanAvatarSrc } from './auth.js';
import { cleanCustomSections, sectionIconName } from './sections.js';
import { applyProfile, applyTheme } from './shell.js';
import { cleanTagList } from './tags.js';
import { refreshEditorLock } from './auth.js';
import { openTemplatePicker } from './editor.js';
import { updateListHeading, updateMeta } from './notes.js';


// Which account the cached vault metadata belongs to (per-session unlimited
// opens reuse it; creation/deletion/reset clear it back to null).
let vaultMetasUser = null;
// When the cache was taken: entries older than this revalidate once, so a
// vault created in another tab appears within minutes (worst-case fetch rate
// stays far under the server throttle).
let vaultMetasAt = 0;
const VAULT_METAS_TTL_MS = 30 * 60 * 1000;

// sessionStorage twin of the memory cache: survives reloads within the tab
// (hard-refreshes no longer cost fetches). Same sensitivity as the session
// cookie already stored there — tab-scoped, dies with the tab.
function vaultMetasCacheKey(user) {
  return 'dafnote-vault-meta:' + String(user || '').toLowerCase();
}

function readCachedVaultMetas(user) {
  const fresh = (at) => Date.now() - at < VAULT_METAS_TTL_MS;
  if (vaultMetasUser === user && Array.isArray(state.vaultMetas) && fresh(vaultMetasAt)) {
    return state.vaultMetas;
  }
  try {
    const raw = sessionStorage.getItem(vaultMetasCacheKey(user));
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const rows = Array.isArray(obj) ? obj : obj.rows;
    const at = Array.isArray(obj) ? 0 : Number(obj.at) || 0;
    if (!Array.isArray(rows) || !fresh(at)) return null;
    state.vaultMetas = rows;
    vaultMetasUser = user;
    vaultMetasAt = at;
    return rows;
  } catch (error) { return null; }
}

function writeCachedVaultMetas(user, rows) {
  state.vaultMetas = rows;
  vaultMetasUser = user;
  vaultMetasAt = Date.now();
  try { sessionStorage.setItem(vaultMetasCacheKey(user), JSON.stringify({ rows, at: vaultMetasAt })); } catch (error) {}
}

function clearCachedVaultMetas() {
  vaultMetasUser = null;
  vaultMetasAt = 0;
  state.vaultMetas = [];
  try {
    const keys = [];
    for (let i = 0; i < sessionStorage.length; i += 1) {
      const key = sessionStorage.key(i);
      if (key && key.startsWith('dafnote-vault-meta:')) keys.push(key);
    }
    keys.forEach((key) => sessionStorage.removeItem(key));
  } catch (error) {}
}

export function updateVaultUI() {  const inVault = state.activeView === 'vault';
  const showVaultTools = inVault && state.vault.unlocked;
  const newVaultBtn = document.getElementById('new-vault-note');
  const lockVaultBtn = document.getElementById('lock-vault');
  if (newVaultBtn) newVaultBtn.hidden = !showVaultTools;
  if (lockVaultBtn) lockVaultBtn.hidden = !showVaultTools;
  if (inVault) {
    // The vault has its own actions; never show the normal ones here.
    const newNoteBtn = document.getElementById('new-note');
    const importBtn = document.getElementById('import-notes');
    if (newNoteBtn) newNoteBtn.hidden = true;
    if (importBtn) importBtn.hidden = true;
  }
  if (inVault) {
    // The vault has its own actions; never show the normal ones here.
    const newNoteBtn = document.getElementById('new-note');
    const importBtn = document.getElementById('import-notes');
    if (newNoteBtn) newNoteBtn.hidden = true;
    if (importBtn) importBtn.hidden = true;
  }
  const vaultNavIcon = document.querySelector('.nav-item[data-view="vault"] .nav-icon');
  if (vaultNavIcon) vaultNavIcon.innerHTML = icon(state.vault.unlocked ? 'unlock' : 'lock');
}

export function setVaultModal(mode, message) {
  state.vaultModalMode = mode;
  document.getElementById('vault-title').textContent = mode === 'setup' ? 'Set Vault Password' : mode === 'reset-confirm' ? 'Reset Vault?' : 'Unlock Vault';
  document.getElementById('vault-desc').textContent = mode === 'setup'
    ? 'Choose a password just for your vault. It is separate from your login and cannot be recovered.'
    : mode === 'reset-confirm'
      ? 'Enter your LOGIN password to confirm. This permanently deletes every note inside the vault. This cannot be undone.'
      : 'Enter your vault password to reveal your secret notes.';
  document.getElementById('vault-setup-block').hidden = mode !== 'setup';
  document.getElementById('vault-unlock-block').hidden = (mode !== 'unlock' && mode !== 'reset-confirm');
  const confirmBtn = document.getElementById('vault-confirm');
  confirmBtn.textContent = mode === 'setup' ? 'Set password' : mode === 'reset-confirm' ? 'Reset vault' : 'Unlock';
  confirmBtn.className = mode === 'unlock' ? 'btn btn-primary' : 'btn btn-danger';
  const errorEl = document.getElementById('vault-error');
  if (errorEl) {
    if (message) { errorEl.textContent = message; errorEl.hidden = false; }
    else errorEl.hidden = true;
  }
}

export function closeVaultModal() {
  document.getElementById('vault-overlay').hidden = true;
  state.vaultModalMode = null;
  ['vault-password', 'vault-new-password', 'vault-confirm-password'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.value = '';
  });
}

export function vaultFail(message) {  const errorEl = document.getElementById('vault-error');
  const card = document.querySelector('#vault-overlay .modal');
  if (errorEl) { errorEl.textContent = message; errorEl.hidden = false; }
  if (card) {
    card.classList.remove('shake');
    void card.offsetWidth;
    card.classList.add('shake');
  }
}

// Wrong-vault-password throttle: 3 consecutive misses lock the vault UI for
// 15 minutes; a correct password restarts the counter to 3. Per account,
// persisted so refreshes don't reset it (the server throttle stays as the
// network-side backstop).
const VAULT_MAX_TRIES = 3;
const VAULT_LOCKOUT_MS = 15 * 60 * 1000;
const VAULT_FAILS_PREFIX = 'dafnote-vault-fails:';

function vaultFailKey() {
  try {
    const name = state.cachedProfile && state.cachedProfile.username
      ? String(state.cachedProfile.username).toLowerCase() : '';
    return name ? VAULT_FAILS_PREFIX + name : null;
  } catch (error) { return null; }
}

function vaultFailState() {
  try {
    const raw = vaultFailKey() ? localStorage.getItem(vaultFailKey()) : null;
    if (!raw) return { fails: 0, lockedUntil: 0 };
    const obj = JSON.parse(raw);
    return { fails: Number(obj.fails) || 0, lockedUntil: Number(obj.lockedUntil) || 0 };
  } catch (error) { return { fails: 0, lockedUntil: 0 }; }
}

// Record one wrong password. Returns {locked, triesLeft, retryMs}.
function vaultFailRecord() {
  const cur = vaultFailState();
  const fails = cur.fails + 1;
  let lockedUntil = cur.lockedUntil;
  if (fails >= VAULT_MAX_TRIES) lockedUntil = Date.now() + VAULT_LOCKOUT_MS;
  try {
    const key = vaultFailKey();
    if (key) localStorage.setItem(key, JSON.stringify({ fails, lockedUntil }));
  } catch (error) {}
  return { locked: lockedUntil > Date.now(), triesLeft: Math.max(0, VAULT_MAX_TRIES - fails), retryMs: Math.max(0, lockedUntil - Date.now()) };
}

function vaultFailClear() {
  try {
    const key = vaultFailKey();
    if (key) localStorage.removeItem(key);
  } catch (error) {}
}

function vaultLockMessage(retryMs) {
  const mins = Math.max(1, Math.ceil(retryMs / 60000));
  return `Vault locked — too many wrong passwords. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`;
}


export async function openVaultModal() {
  if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to open the Vault'); return; }
  // Unlock as often as wanted without re-fetching: reuse this session's
  // metadata for the same account (server fetches stay throttled for
  // brute-force protection). Creation/deletion/reset clear the cache below.
  const me = state.cachedProfile.username ? String(state.cachedProfile.username).toLowerCase() : '';
  let meta = null;
  const cached = readCachedVaultMetas(me);
  if (cached) {
    meta = { exists: cached.length > 0, vaults: cached };
  } else {
    try {
      const response = await apiFetch('/api/vault-meta');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      meta = await response.json();
    } catch (error) {
      showToast('Cannot reach the Dafnote server');
      return;
    }
    writeCachedVaultMetas(me, meta && Array.isArray(meta.vaults) ? meta.vaults : []);
  }
  // Multi-vault shape: {exists, vaults: [{id, name, ...}]}. Keep the rows for
  // unlock-all plus the current vault's row where the old code expects it.
  // The name list is stored too so the sidebar shows every vault locked or not.
  const rows = meta && Array.isArray(meta.vaults) ? meta.vaults : [];
  state.vaultMetas = rows;
  if (rows.length) {
    state.vaultList = rows.map((row) => ({ id: row.id == null ? 1 : row.id, name: row.name || `Vault ${row.id}` }));
  }
  if (rows.length) {
    state.vaultList = rows.map((row) => ({ id: row.id == null ? 1 : row.id, name: row.name || `Vault ${row.id}` }));
  }
  if (rows.length) {
    const current = rows.find((row) => String(row.id) === String(state.vaultId || 1)) || rows[0];
    state.vault.meta = current;
    if (!state.vaultId) state.vaultId = current.id;
  } else {
    state.vault.meta = meta;
  }
  setVaultModal(meta && meta.exists && rows.length ? 'unlock' : 'setup');
  document.getElementById('vault-overlay').hidden = false;
  try { renderCustomSections(); } catch (error) {}
  const focusInput = document.querySelector(state.vaultModalMode === 'setup' ? '#vault-new-password' : '#vault-password');
  if (focusInput) focusInput.focus();
}

export function openVaultNoteDeleteConfirm(id) {
  const note = state.vault.notes.find((item) => item.id === id);
  if (!note) return;
  state.pendingDeleteId = id;
  state.pendingDeleteMode = 'vault-note';
  setDeleteDialog({
    eyebrow: 'Delete secret note',
    title: 'Delete this note?',
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

export async function decryptUiVaultRaw(raw) {
  const obj = JSON.parse(raw);
  const plain = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(obj.iv) }, e2ee.masterKey, e2eeB64ToBytes(obj.data));
  return JSON.parse(new TextDecoder().decode(plain));
}

// Immediate encrypted write of the per-account local cache. Used by the
// debounced persistUiVault() and by the logout/pagehide flush path.
export async function writeUiVaultLocal() {
  if (!e2ee.masterKey) return; // locked: never write (and never plaintext)
  let theme = 'light';
  try {
    const current = document.documentElement.dataset.theme
      || localStorage.getItem('dafnote-theme') || 'light';
    if (THEMES.includes(current)) theme = current;
  } catch (error) {}
  const snapshot = JSON.stringify({
    collapsed: [...state.collapsedFolders],
    customSections: state.customSections, deletedCustomSections: state.deletedCustomSections, theme,
    avatar: state.profileAvatar || '',
    tags: state.knownTags,
  });
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, e2ee.masterKey, new TextEncoder().encode(snapshot));
  try {
    localStorage.setItem(uiVaultKey(), JSON.stringify({ iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) }));
    // One-time migration: a legacy shared key decryptable with this account's
    // master key moves to the per-account key, then the shared slot is freed
    // so the next account starts clean instead of failing to decrypt it.
    try {
      if (uiVaultKey() !== UI_VAULT_KEY) {
        const rawLegacy = localStorage.getItem(UI_VAULT_KEY);
        if (rawLegacy) {
          const obj = JSON.parse(rawLegacy);
          const plain = await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: e2eeB64ToBytes(obj.iv) }, e2ee.masterKey, e2eeB64ToBytes(obj.data));
          JSON.parse(new TextDecoder().decode(plain));
          localStorage.removeItem(UI_VAULT_KEY);
        }
      }
    } catch (error) {}
    localStorage.removeItem('dafnote-collections');
    localStorage.removeItem('dafnote-deleted-collections');
    localStorage.removeItem(COLLAPSED_FOLDERS_KEY);
  } catch (error) {}
}

// Device-local cache key, namespaced per account so two logins on one device
// can never decrypt (or overwrite) each other's sidebar.
export function uiVaultKey() {
  try {
    const name = state.cachedProfile && state.cachedProfile.username ? String(state.cachedProfile.username).toLowerCase() : '';
    if (name) return `${UI_VAULT_KEY}:${name}`;
  } catch (error) {}
  return UI_VAULT_KEY;
}


export async function resetVault() {
  // Re-auth fix: stolen cookie alone cannot wipe the vault. Read the LOGIN
  // password from the masked modal field (shown in reset-confirm mode),
  // derive the account verifier, and send as proof.
  let proof = null;
  try {
    const input = document.getElementById('vault-password');
    const pwd = String((input && input.value) || '');
    if (!pwd) { vaultFail('Enter your login password to confirm reset.'); return; }
    if (!e2ee.saltAuth) { vaultFail('Log in again, then retry reset.'); return; }
    const saltBytes = (e2ee.saltAuth instanceof Uint8Array) ? e2ee.saltAuth : e2eeB64ToBytes(e2ee.saltAuth);
    const raw = await argon2id32(pwd, saltBytes);
    proof = e2eeBytesToB64(raw);
  } catch (error) {
    vaultFail('Could not confirm password.');
    return;
  }
  try {
    const response = await apiFetch('/api/vault-meta', { method: 'DELETE', body: JSON.stringify({ currentAccountAuth: proof }) });
    if (response.status === 401) {
      vaultFail('Incorrect login password — vault not reset.');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    vaultFail('Could not reset the vault. Try again.');
    return;
  }
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
  state.currentVaultId = null;
  persistNotes();
  closeVaultModal();
  goAllNotes();
  renderNoteList();
  clearCachedVaultMetas();
  showToast('Vault reset');
}

// Delete a single vault immediately: calls the server, clears local state,
// switches to another vault or locks if none remain. No password prompt —
// the session itself is the proof.
export async function deleteVault(vaultId) {
  const id = vaultId == null ? 1 : vaultId;
  // Pentest F-52 password pixels: the server now requires a password proof on
  // every vault DELETE (not just full reset). Ask the user for the vault or
  // login password and prove with the current verifier. Falls back to
  // 'could not delete' on cancellation (no silent wipe).
  let proof = {};
  try {
    const challenge = await askInput({
      eyebrow: 'Confirm delete', title: 'Enter your vault password',
      desc: 'Deleting a vault requires password confirmation. This cannot be undone.',
      label: 'Password', password: true, placeholder: '•••••', okText: 'Delete',
    });
    if (!challenge) { showToast('Delete cancelled'); return; }
    proof.currentVaultAuth = challenge;
  } catch (err) { showToast('Delete cancelled'); return; }
  try {
    // Prove with the vault password using vault-1's salt_auth (shared).
    // F-56 fix: read from vaultMetas (carries saltAuth), not vaultList
    // (which maps name-only projections and never carries salts — the old
    // read made single-vault deletion permanently unavailable).
    const metas = state.vaultMetas || [];
    const first = metas.length ? metas[0] : null;
    if (!first || !first.saltAuth) {
      showToast('Open the vault first, then delete it');
      return;
    }
    const verifier = await argon2id32(proof.currentVaultAuth, e2eeB64ToBytes(first.saltAuth));
    const proofPayload = { currentVaultAuth: e2eeBytesToB64(verifier) };
    const res = await apiFetch('/api/vault-meta', {
      method: 'DELETE',
      body: JSON.stringify({ vaultId: id, ...proofPayload }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Could not delete vault.');
      return;
    }
  } catch (error) {
    showToast('Could not delete vault.');
    return;
  }
  // Remove from local state
  state.vaultList = (state.vaultList || []).filter((v) => String(v.id) !== String(id));
  state.vaultMetas = (state.vaultMetas || []).filter((r) => String(r.id) !== String(id));
  delete state.vaultKeys[id];
  delete state.vaultBlobMap[id];
  delete state.vaultFolderMap[id];
  clearCachedVaultMetas();
  // If we deleted the active vault, switch to another or lock
  if (String(state.vaultId || 1) === String(id)) {
    if (state.vaultList.length) {
      const nextId = state.vaultList[0].id;
      try {
        await switchVault(nextId);
      } catch (error) {
        lockVault();
      }
    } else {
      lockVault();
    }
  }
  renderCustomSections();
  showToast('Vault deleted');
}

export async function unlockVaultFromModal() {
  const password = String(document.getElementById('vault-password').value || '');
  const meta = state.vault.meta;
  // Usable meta is either the envelope ({exists:true}) or a vault row
  // ({verifier, saltAuth, ...}) — rows carry no `exists` flag.
  const usable = meta && (meta.exists || (meta.verifier && meta.saltAuth));
  if (!usable) { setVaultModal('setup'); return; }
  if (state.vault.unlocking) return;
  state.vault.unlocking = true;
  try {
    await unlockVaultInner(password, meta);
  } finally {
    state.vault.unlocking = false;
  }
}
async function unlockVaultInner(password, meta) {
  try {
    // Unwrap from the FULL vault list, never the single current row:
    // unlocking must not clobber the other vaults out of the sidebar.
    const rows = Array.isArray(state.vaultMetas) && state.vaultMetas.length
      ? state.vaultMetas
      : (meta && Array.isArray(meta.vaults) && meta.vaults.length ? meta.vaults : [meta]);
    const first = rows[0];
    const lock = vaultFailState();
    if (lock.lockedUntil > Date.now()) {
      vaultFail(vaultLockMessage(lock.lockedUntil - Date.now()));
      return;
    }
    const verifier = await argon2id32(password, e2eeB64ToBytes(first.saltAuth));
    if (!timingSafeEqualStr(e2eeBytesToB64(verifier), first.verifier)) {
      const rec = vaultFailRecord();
      vaultFail(rec.locked ? vaultLockMessage(rec.retryMs)
        : `Incorrect vault password (${rec.triesLeft} ${rec.triesLeft === 1 ? 'try' : 'tries'} left).`);
      return;
    }
    // One shared password: a single KEK unwraps every vault's DEK.
    const kekRaw = await argon2id32(password, e2eeB64ToBytes(first.saltEnc));
    const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    state.vaultKeys = {};
    state.vaultList = [];
    for (const row of rows) {
      try {
        const dekRaw = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: e2eeB64ToBytes(row.encDek.iv) }, kek, e2eeB64ToBytes(row.encDek.data));
        const id = row.id == null ? 1 : row.id;
        state.vaultKeys[id] = await window.crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
        state.vaultList.push({ id, name: row.name || `Vault ${id}` });
      } catch (error) { /* skip unreadable vault rows */ }
    }
    if (!state.vaultList.length) {
      const rec = vaultFailRecord();
      vaultFail(rec.locked ? vaultLockMessage(rec.retryMs) : 'Incorrect vault password.');
      return;
    }
    if (!state.vaultList.some((entry) => String(entry.id) === String(state.vaultId || 1))) {
      state.vaultId = state.vaultList[0].id;
    }
    loadVaultWorkingSet();
    state.vault.notes = await decryptAllVaultBlobs();
    state.vault.unlocked = true;
    vaultFailClear();
    closeVaultModal();
    enterVaultView();
    try { renderCustomSections(); } catch (error) {}
    showToast('Vault unlocked');
  } catch (error) {
    const rec = vaultFailRecord();
    vaultFail(rec.locked ? vaultLockMessage(rec.retryMs) : 'Incorrect vault password.');
  }
}

// Point the working set (dek/notes/blobs/folders) at one vault. Blob and
// folder maps hold every vault; the working arrays reference the current
// vault's entries so other vaults are never disturbed.
export function loadVaultWorkingSet() {
  const current = state.vaultId || 1;
  if (!state.vaultBlobMap || typeof state.vaultBlobMap !== 'object') state.vaultBlobMap = {};
  if (!state.vaultFolderMap || typeof state.vaultFolderMap !== 'object') state.vaultFolderMap = {};
  if (!Array.isArray(state.vaultBlobMap[current])) state.vaultBlobMap[current] = [];
  if (!Array.isArray(state.vaultFolderMap[current])) state.vaultFolderMap[current] = [];
  state.vault.blobs = state.vaultBlobMap[current];
  state.vault.folders = state.vaultFolderMap[current];
  state.vault.dek = (state.vaultKeys && state.vaultKeys[current]) || null;
  const metas = Array.isArray(state.vaultMetas) ? state.vaultMetas : [];
  state.vault.meta = metas.find((row) => String(row.id) === String(current)) || metas[0] || null;
}

// Switch to another unlocked vault, flushing the current one's edits first.
// Serialized: rapid back-and-forth clicks queue behind the in-flight switch
// instead of interleaving mid-await (which once encrypted one vault's notes
// with another vault's key into the wrong slot, destroying both).
export async function switchVault(id) {
  const target = id == null ? 1 : id;
  if (!state.vault.unlocked) { openVaultModal(); return; }
  if (!state.vaultList.some((entry) => String(entry.id) === String(target))) return;
  if (state.vaultSwitching) {
    try { await state.vaultSwitching; } catch (error) {}
    if (String(state.vaultId || 1) === String(target)) return;
    return switchVault(target);
  }
  state.vaultSwitching = (async () => {
    try { saveVaultNote(); } catch (error) {}
    try { await currentVaultBlobs(); } catch (error) {}
    state.vaultId = target;
    state.currentVaultId = null;
    state.vaultFolder = null;
    loadVaultWorkingSet();
    try { state.vault.notes = await decryptAllVaultBlobs(); } catch (error) { state.vault.notes = []; }
    persistNotes();
    renderNoteList();
    try { renderCustomSections(); } catch (error) {}
    try { renderStripItems(); } catch (error) {}
  })();
  try { await state.vaultSwitching; } finally { state.vaultSwitching = null; }
}

// Create an additional vault (max 3) under the shared password: prove the
// current password, wrap a fresh DEK with its KEK, and store only the wrap
// (salts/verifier are copied server-side from vault 1).
export async function createAdditionalVault() {
  if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in first'); return; }
  const existing = Array.isArray(state.vaultList) ? state.vaultList : [];
  if (existing.length >= 3) { showToast('Maximum of 3 vaults'); return; }
  // Salts come from the cached rows when present (the modal just fetched
  // them) — a fresh GET only when the cache is empty.
  let rows = Array.isArray(state.vaultMetas) && state.vaultMetas.length ? state.vaultMetas : null;
  if (!rows) {
    let meta = null;
    try {
      const response = await apiFetch('/api/vault-meta');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      meta = await response.json();
    } catch (error) {
      showToast('Cannot reach the Dafnote server');
      return;
    }
    rows = meta && Array.isArray(meta.vaults) ? meta.vaults : [];
    state.vaultMetas = rows;
  }
  if (!rows.length) { openVaultModal(); return; }
  const preLock = vaultFailState();
  if (preLock.lockedUntil > Date.now()) { showToast(vaultLockMessage(preLock.lockedUntil - Date.now())); return; }
  const password = await askInput({ eyebrow: 'Vault', title: `New vault (${existing.length + 1} of 3)`, desc: 'Enter your vault password — the new vault shares it.', label: 'Vault password', password: true, placeholder: '', okText: 'Create vault' });
  if (password == null || !String(password)) return;
  try {
    const first = rows[0];
    const verifier = await argon2id32(String(password), e2eeB64ToBytes(first.saltAuth));
    const kekRaw = await argon2id32(String(password), e2eeB64ToBytes(first.saltEnc));
    const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const dekRaw = e2eeRandomBytes(32);
    const iv = e2eeRandomBytes(12);
    const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, dekRaw);
    const response = await apiFetch('/api/vault-meta', {
      method: 'POST',
      body: JSON.stringify({
        currentVaultAuth: e2eeBytesToB64(verifier),
        encDek: { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) },
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 409) { showToast('Maximum of 3 vaults'); return; }
    if (response.status === 401) {
      const rec = vaultFailRecord();
      showToast(rec.locked ? vaultLockMessage(rec.retryMs) : 'Wrong vault password.');
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    vaultFailClear();
    const newId = data && data.id != null ? data.id : (existing.length + 1);
    state.vaultKeys[newId] = await window.crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    try {
      await openVaultModalRefresh(newId, {
        id: newId,
        name: `Vault ${newId}`,
        saltAuth: first.saltAuth,
        verifier: first.verifier,
        saltEnc: first.saltEnc,
        encDek: { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) },
      });
    } catch (error) {}
    clearCachedVaultMetas();
    showToast('Vault created — syncing…');
    persistNotes();
    try { const syncMod = await import('../data/sync.js'); syncMod.syncNow().catch(() => {}); } catch (error) {}
  } catch (error) {
    showToast('Could not create the vault. Wrong password?');
  }
}

// Refresh the vault list after creating one, then switch to it.
async function openVaultModalRefresh(newId, fullRow) {
  // No fetch: the id comes from the create response; salts/verifier match
  // vault 1 and the wrap was just created locally. A salts-less placeholder
  // row would silently fail to unwrap at the next unlock, hiding the vault.
  try {
    const entry = fullRow && fullRow.saltAuth ? fullRow : { id: newId, name: `Vault ${newId}` };
    const list = Array.isArray(state.vaultMetas) ? state.vaultMetas : [];
    if (!list.some((row) => String(row.id) === String(newId))) list.push(entry);
    state.vaultMetas = list;
    state.vaultList = list.map((row) => ({ id: row.id == null ? 1 : row.id, name: row.name || `Vault ${row.id}` }));
    try {
      const me = state.cachedProfile && state.cachedProfile.username ? String(state.cachedProfile.username).toLowerCase() : '';
      writeCachedVaultMetas(me, list);
    } catch (error) {}
  } catch (error) {}
  if (state.vault.unlocked) {
    await switchVault(newId);
  } else {
    state.vaultId = newId;
    openVaultModal();
  }
}

// Rename a vault: prompts for the new name, validates, and persists to server.
export async function renameVault(vaultId) {
  const id = vaultId == null ? 1 : vaultId;
  const entry = (state.vaultList || []).find((v) => String(v.id) === String(id));
  const currentName = (entry && entry.name) || 'Vault';
  const name = await askInput({
    eyebrow: 'Vault',
    title: 'Rename vault',
    desc: '',
    label: 'Vault name',
    password: false,
    placeholder: currentName,
    okText: 'Rename',
  });
  if (name == null) return;
  const clean = String(name).trim().slice(0, 40);
  if (!clean) { showToast('Vault name cannot be empty.'); return; }
  if (clean === currentName) return;
  try {
    const res = await apiFetch('/api/vault-meta', {
      method: 'PATCH',
      body: JSON.stringify({ vaultId: id, name: clean }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || 'Could not rename vault.');
      return;
    }
    // Update local state
    if (entry) entry.name = clean;
    // Update vaultMetas cache
    const metaEntry = (state.vaultMetas || []).find((r) => String(r.id) === String(id));
    if (metaEntry) metaEntry.name = clean;
    // Update vaultFolderMap key name if stored
    clearCachedVaultMetas();
    renderCustomSections();
    renderStripItems();
    showToast('Vault renamed');
  } catch (error) {
    showToast('Could not rename vault.');
  }
}

export async function setupVaultFromModal() {
  const password = String(document.getElementById('vault-new-password').value || '');
  const confirm = String(document.getElementById('vault-confirm-password').value || '');
  if (password !== confirm) { vaultFail('Passwords do not match.'); return; }
  const missing = passwordPolicyCheck(password);
  if (missing.length) { vaultFail(`Vault password needs ${missing.join(', ')}.`); return; }
  // Note: no pre-POST existence check here — the POST itself is the check
  // (saves a fetch every setup). A 401 below means a vault appeared since
  // the modal opened; flip to unlock with the typed password carried over.
  try {
    const saltAuthBytes = e2eeRandomBytes(16);
    const saltEncBytes = e2eeRandomBytes(16);
    const verifier = await argon2id32(password, saltAuthBytes);
    const dekRaw = e2eeRandomBytes(32);
    const kekRaw = await argon2id32(password, saltEncBytes);
    const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = e2eeRandomBytes(12);
    const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, dekRaw);
    const response = await apiFetch('/api/vault-meta', {
      method: 'POST',
      body: JSON.stringify({
        verifier: e2eeBytesToB64(verifier),
        saltAuth: e2eeBytesToB64(saltAuthBytes),
        saltEnc: e2eeBytesToB64(saltEncBytes),
        encDek: { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) },
      }),
    });
    if (response.status === 401) {
      try {
        const refresh = await apiFetch('/api/vault-meta');
        if (refresh.ok) {
          const fresh = await refresh.json();
          const rows = fresh && Array.isArray(fresh.vaults) ? fresh.vaults : [];
          if (fresh && fresh.exists && rows.length) {
            state.vaultMetas = rows;
            const current = rows.find((row) => String(row.id) === String(state.vaultId || 1)) || rows[0];
            state.vault.meta = current;
            if (!state.vaultId) state.vaultId = current.id;
            try {
              const typed = document.getElementById('vault-new-password');
              const unlockInput = document.getElementById('vault-password');
              if (typed && unlockInput) unlockInput.value = typed.value || '';
            } catch (error) {}
            setVaultModal('unlock');
            unlockVaultFromModal();
            return;
          }
        }
      } catch (error) { /* fall through to the generic failure below */ }
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    state.vaultId = 1;
    state.vaultList = [{ id: 1, name: 'Vault' }];
    state.vaultKeys = { 1: await window.crypto.subtle.importKey('raw', dekRaw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']) };
    state.vault.dek = state.vaultKeys[1];
    state.vaultBlobMap = { 1: [] };
    state.vaultFolderMap = { 1: [] };
    state.vault.blobs = state.vaultBlobMap[1];
    state.vault.folders = state.vaultFolderMap[1];
    state.vault.notes = [];
    state.vault.unlocked = true;
    closeVaultModal();
    enterVaultView();
    try { renderCustomSections(); } catch (error) {}
    clearCachedVaultMetas();
    showToast('Vault ready');
  } catch (error) {
    vaultFail('Could not set up the vault. Try again.');
  }
}

// Wipe vault plaintext (keeping ciphertext blobs AND the folder list) and
// leave the view. Folders stay so a background sync while locked can never
// strand or erase them from the envelope.
export async function lockVault() {
  if (state.activeView === 'vault' && state.currentVaultId) saveVaultNote();
  try { await currentVaultBlobs(); } catch (error) {}
  persistNotes();
  state.vault.unlocked = false;
  state.vault.dek = null;
  state.vault.notes = [];
  state.vaultKeys = {};
  state.vault.meta = null;
  state.currentVaultId = null;
  goAllNotes();
  renderNoteList();
  try { renderCustomSections(); } catch (error) {}
  showToast('Vault locked');
}

export function enterVaultView() {
  if (!state.vault.unlocked) { openVaultModal(); return; }
  state.activeView = 'vault';
  state.activeCustom = null;
  state.activeFilter = 'all';
  document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav.dataset.view === 'vault'));
  document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
  clearSearch();
  updateListHeading();
  renderCustomSections();
  renderNoteList();
}

// Render the Vault view: lock notice when locked, otherwise one Vault folder
// with the decrypted notes. Counts/footer mirror the normal list shape.
// Toggle the sidebar vault-folder filter: narrows the Vault view to one
// folder subtree (clears the selection when toggled off).
export function toggleVaultFolderFilter(folder) {
  const f = String(folder || '');
  state.vaultFolder = (f && state.vaultFolder !== f && state.vault.folders.includes(f)) ? f : null;
  renderVaultList();
  try { renderStripItems(); } catch (error) {}
  try { updateBreadcrumbs(); } catch (error) {}
  try { renderCustomSections(); } catch (error) {}
}

export function renderVaultList() {
  updateBinUI(); // Vault never shows Empty Bin; this also clears stale visibility.
  updateVaultUI();
  updateBreadcrumbs();
  const emptyTitle = listEmpty.querySelector('strong');
  const emptySub = listEmpty.querySelector('span:last-child');
  if (!state.vault.unlocked) {
    noteList.innerHTML = `
    <div class="vault-locked">
      <span class="empty-icon" data-icon="lock"></span>
      <strong>Vault is locked</strong>
      <span>Unlock to see your secret notes.</span>
      <button class="btn btn-primary" id="vault-lock-open">Unlock Vault</button>
    </div>`;
    const lockIcon = noteList.querySelector('[data-icon="lock"]');
    if (lockIcon) lockIcon.innerHTML = icon('lock');
    listEmpty.hidden = true;
    noteList.hidden = false;
    if (allCount) allCount.textContent = '0';
    if (recentCountEl) recentCountEl.textContent = '0';
    if (starredCountEl) starredCountEl.textContent = '0';
    if (totalCount) totalCount.textContent = '0 in vault';
    const openBtn = document.getElementById('vault-lock-open');
    if (openBtn) openBtn.addEventListener('click', openVaultModal);
    renderTabs();
    renderStripItems();
    return;
  }
  if (!state.vault.notes.length && !state.vault.folders.length) {
    noteList.innerHTML = '';
    listEmpty.hidden = false;
    noteList.hidden = true;
    if (emptyTitle) emptyTitle.textContent = 'Vault is empty';
    if (emptySub) emptySub.textContent = 'Create your first secret note.';
  } else {
    listEmpty.hidden = true;
    noteList.hidden = false;
    const knownVaultFolders = new Set(state.vault.folders);
    // Sidebar folder filter: narrow to one subtree (a deleted folder clears it).
    if (state.vaultFolder && !state.vault.folders.includes(state.vaultFolder)) state.vaultFolder = null;
    const vaultFilter = state.vaultFolder || null;
    const inFilter = (folder) => !vaultFilter || folder === vaultFilter || isFolderOrSub(folder, vaultFilter);
    const rootNotes = state.vault.notes.filter((note) => (!note.folder || !knownVaultFolders.has(note.folder)) && !vaultFilter);
    const renderVaultNoteRow = (note) => `
        <button class="tree-file${note.id === state.currentVaultId ? ' selected' : ''}" data-vault-id="${escapeHtml(note.id)}" title="${escapeHtml(note.title || 'Untitled note')}" draggable="true">
          <span class="tree-file-icon tree-file-icon-md">${icon('file')}</span>
          <span class="tree-file-name">${escapeHtml(note.title || 'Untitled note')}</span>
          <span class="tree-action danger" data-vault-delete="${escapeHtml(note.id)}" title="Delete secret note" role="button" aria-label="Delete ${escapeHtml(note.title || 'Untitled note')}">${icon('trash')}</span>
        </button>`;
    noteList.innerHTML = `
    <div class="tree-folder-wrap" data-folder-wrap="Vault">
      <div class="tree-folder-row">
        <button class="tree-folder" data-folder="Vault" aria-expanded="true" title="Vault">
          <span class="tree-chevron">${icon('chevron-right')}</span>
          <span class="tree-folder-icon">${icon('lock')}</span>
          <span class="tree-folder-name">Vault</span>
          <span class="tree-count">${state.vault.notes.length}</span>
        </button>
        <button type="button" class="strip-btn" data-vault-folder-add title="New vault folder" aria-label="New vault folder">${icon('folder-plus')}</button>
      </div>
      <div class="tree-children">
        ${state.vault.folders.filter(inFilter).map((folder) => {
          const files = state.vault.notes.filter((note) => note.folder === folder);
          const isCollapsed = state.collapsedFolders.has(folder);
          return `
        <div class="tree-folder-wrap${isCollapsed ? ' closed' : ''}" data-vault-folder-wrap="${escapeHtml(folder)}">
          <div class="tree-folder-row">
            <button class="tree-folder" data-vault-folder="${escapeHtml(folder)}" aria-expanded="${isCollapsed ? 'false' : 'true'}" title="${escapeHtml(folder)}">
              <span class="tree-chevron">${icon('chevron-right')}</span>
          <span class="tree-folder-icon">${icon(folderIconForDepth(folderDepth(folder)))}</span>
              <span class="tree-folder-name vault-folder-name">${escapeHtml(folder)}</span>
              <span class="tree-count">${files.length}</span>
            </button>
            <button type="button" class="section-delete" data-vault-folder-delete="${escapeHtml(folder)}" title="Delete folder" aria-label="Delete folder ${escapeHtml(folder)}">×</button>
          </div>
          <div class="tree-children">
            ${files.map(renderVaultNoteRow).join('')}
          </div>
        </div>`;
        }).join('')}
        ${rootNotes.map(renderVaultNoteRow).join('')}
      </div>
    </div>`;
  }
  if (allCount) allCount.textContent = state.vault.notes.length;
  if (recentCountEl) recentCountEl.textContent = state.vault.notes.filter((note) => isRecentNote(note)).length;
  if (starredCountEl) starredCountEl.textContent = state.vault.notes.filter((note) => note.favorite).length;
  if (totalCount) totalCount.textContent = `${state.vault.notes.length} in vault`;
  noteList.querySelectorAll('[data-vault-id]').forEach((item) => item.addEventListener('click', (event) => {
    if (event.target.closest('[data-vault-delete]')) return;
    selectVaultNote(item.dataset.vaultId);
  }));
  noteList.querySelectorAll('[data-vault-delete]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    openVaultNoteDeleteConfirm(item.dataset.vaultDelete);
  }));
  const vaultAddBtn = noteList.querySelector('[data-vault-folder-add]');
  if (vaultAddBtn) vaultAddBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    addVaultFolder();
  });
  noteList.querySelectorAll('[data-vault-folder]').forEach((header) => {
    header.addEventListener('click', () => {
      const folder = header.dataset.vaultFolder;
      if (state.collapsedFolders.has(folder)) state.collapsedFolders.delete(folder);
      else state.collapsedFolders.add(folder);
      persistCollapsedFolders();
      renderNoteList();
    });
  });
  noteList.querySelectorAll('[data-vault-folder] .vault-folder-name').forEach((label) => label.addEventListener('dblclick', (event) => {
    event.preventDefault();
    event.stopPropagation();
    const header = label.closest('[data-vault-folder]');
    if (header) renameVaultFolder(header.dataset.vaultFolder);
  }));
  noteList.querySelectorAll('[data-vault-folder-delete]').forEach((item) => item.addEventListener('click', (event) => {
    event.stopPropagation();
    openVaultFolderDeleteConfirm(item.dataset.vaultFolderDelete);
  }));
  // Vault note sorting: drag a secret note onto a vault folder to file it.
  noteList.querySelectorAll('[data-vault-id]').forEach((row) => {
    row.addEventListener('dragstart', (event) => {
      if (!state.vault.unlocked) { event.preventDefault(); return; }
      event.dataTransfer.setData('text/plain', row.dataset.vaultId);
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
  });
  noteList.querySelectorAll('[data-vault-folder]').forEach((header) => {
    header.addEventListener('dragover', (event) => {
      if (!state.vault.unlocked) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      header.classList.add('drop-target');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drop-target'));
    header.addEventListener('drop', (event) => {
      event.preventDefault();
      const folder = header.dataset.vaultFolder;
      const note = state.vault.unlocked ? state.vault.notes.find((entry) => entry.id === event.dataTransfer.getData('text/plain')) : null;
      if (!note || !state.vault.folders.includes(folder)) return;
      note.folder = folder;
      note.date = 'Now';
      persistNotes();
      renderNoteList();
      showToast(`Moved to “${folder}”`);
    });
  });
  renderTabs();
  renderStripItems();
}

export function deleteVaultNote(id) {
  const index = state.vault.notes.findIndex((item) => item.id === id);
  if (index === -1) return;
  state.vault.notes.splice(index, 1);
  state.vault.blobs = state.vault.blobs.filter((item) => item.id !== id);
  if (state.currentVaultId === id) {
    if (state.vault.notes.length) selectVaultNote(state.vault.notes[Math.min(index, state.vault.notes.length - 1)].id);
    else { state.currentVaultId = null; clearEditor(); }
  }
  persistNotes();
  renderNoteList();
  showToast('Secret note deleted');
}

// Create a vault note from a template into the picked folder (or Vault root).
export function createVaultNoteFromTemplate(templateKey) {
  if (!state.vault.unlocked) { showToast('Unlock the Vault first'); return null; }
  const template = NOTE_TEMPLATES[templateKey] || NOTE_TEMPLATES.standard;
  const folder = (state.pendingVaultFolder && state.vault.folders.includes(state.pendingVaultFolder)) ? state.pendingVaultFolder : null;
  state.pendingVaultFolder = null;
  const title = uniqueVaultTitle(template.titleBase);
  const note = {
    id: newNoteId(), title, body: template.body(title),
    tags: [...template.tags, ...(templateKey === 'recipe' || templateKey === 'todo' ? [`_${templateKey}`] : [])], ext: normalizeExt(template.ext),
    date: 'Now', favorite: false, folder, template: templateKey,
  };
  state.vault.notes.unshift(note);
  state.currentVaultId = note.id;
  selectVaultNote(note.id);
  persistNotes();
  showToast(folder ? `${template.label} created in ${folder}` : `${template.label} created`);
  return note;
}

// + New secret note entry: like + New Note outside the Vault — asks for the
// folder first (only when folders exist), then the template.
export function onNewVaultNoteClick() {
  if (!state.vault.unlocked) { showToast('Unlock the Vault first'); return; }
  state.pendingVaultFolder = null;
  state.vaultTemplatePending = false;
  if (state.vault.folders.length && openVaultFolderPicker()) return;
  state.vaultTemplatePending = true;
  openTemplatePicker();
}

// Save the open vault note into memory; the debounced envelope sync persists it.
export function saveVaultNote() {
  if (!state.vault.unlocked || !state.currentVaultId) return;
  const note = state.vault.notes.find((item) => item.id === state.currentVaultId);
  if (!note) return;
  note.title = (typeof titleInput.value === 'string' ? titleInput.value : '').trim().slice(0, 200) || 'Untitled note';
  note.body = typeof markdownInput.value === 'string' ? markdownInput.value.slice(0, 500000) : '';
  note.date = 'Now';
  note.updatedAt = Date.now();
  breadcrumbTitle.textContent = note.title;
  renderPreview(note);
  updateMeta(note);
  renderTabs();
  setSaveLabel('Saving...', 'green');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 450);
}

// Open a vault note in the editor (preview-first, like normal notes).
export function selectVaultNote(id) {
  exitCoverRepos(true);
  const note = state.vault.unlocked ? state.vault.notes.find((item) => item.id === id) : null;
  if (!note) return;
  trackTab(id, true);
  state.currentVaultId = id;
  state.currentId = null;
  document.querySelector('.app-shell').classList.remove('workspace-focus');
  state.writeMode = 'preview';
  clearTimeout(state.idleTimer);
  titleInput.value = note.title;
  markdownInput.value = note.body;
  breadcrumbTitle.textContent = note.title;
  renderCover(null); // vault notes have no covers; clear any stale banner
  renderPreview(note);
  updateMeta(note);
  renderNoteList();
  refreshEditorLock();
}

export async function loadUiVault() {
  // Server envelope (v2) already won: keep it, just refresh the per-account
  // local cache. Never let a stale device copy from another account clobber it.
  if (state.serverUiLoaded) {
    try { await writeUiVaultLocal(); } catch (error) {}
    return true;
  }
  // Per-account encrypted cache first; then the legacy shared slot (pre
  // per-account migration) when it decrypts with this account's key; else
  // adopt legacy plaintext keys once (then re-saved encrypted + uploaded).
  const keysToTry = [];
  try {
    const perUser = uiVaultKey();
    if (perUser) keysToTry.push(perUser);
    if (perUser !== UI_VAULT_KEY) keysToTry.push(UI_VAULT_KEY);
  } catch (error) { keysToTry.push(UI_VAULT_KEY); }
  for (const key of keysToTry) {
    try {
      const raw = localStorage.getItem(key);
      if (raw && e2ee.masterKey) {
        const vault = await decryptUiVaultRaw(raw);
        if (applyUiSnapshot(vault)) {
          // Promote a legacy shared-slot hit to the per-account key.
          try { await writeUiVaultLocal(); } catch (error) {}
          // This device knew more than the (v1) server row: push it up so the
          // next relog/device sees the same sidebar.
          try { persistNotes(); } catch (error) {}
          return true;
        }
      }
    } catch (error) { /* try next key, then legacy adopt */ }
  }
  const legacy = readLegacyUiKeys();
  let adopted = false;
  if (legacy.collapsed) { state.collapsedFolders = new Set(legacy.collapsed); adopted = true; }
  if (legacy.sections) {
    state.customSections = legacy.sections.sections;
    adopted = true;
  }
  if (legacy.cols || legacy.colsName) {
    try { ensureMigratedCollectionsSection(legacy.cols || [], legacy.colsName || null); adopted = true; } catch (error) {}
  }
  if (!adopted && state.customSections.length === 0) {
    // Fresh device + fresh account: adopt the onboarding sidebar (Notes
    // section with General/Personal). Any real sidebar state wins over it.
    applyUiSnapshot(welcomeSeedUi());
    adopted = true;
  }
  if (adopted) {
    persistUiVault();
    try { persistNotes(); } catch (error) {}
  }
  return adopted;
}

export function persistUiVault() {
  clearTimeout(state.uiVaultTimer);
  state.uiVaultTimer = setTimeout(() => {
    (async () => {
      if (!e2ee.masterKey) return; // locked: never write (and never plaintext)
      try { await writeUiVaultLocal(); } catch (error) {}
      // The server envelope is the source of truth per account: schedule an
      // upload so sidebar changes survive relogs and follow the account.
      try { persistNotes(); } catch (error) {}
    })();
  }, 150);
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
    const stored = JSON.parse(localStorage.getItem('dafnote-collections') || 'null');
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
      || localStorage.getItem('dafnote-theme') || 'light';
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

// Apply a server/UI-vault snapshot to memory. Returns true when anything was adopted.
export function applyUiSnapshot(value) {
  const clean = cleanUiSnapshot(value);
  if (!clean) return false;
  let adopted = false;
  if (clean.collapsed !== null) { state.collapsedFolders = new Set(clean.collapsed); adopted = true; }
  if (clean.customSections) { state.customSections = clean.customSections; adopted = true; }
  if (clean.deletedCustomSections) { state.deletedCustomSections = clean.deletedCustomSections; adopted = true; }
  // One-time migration of legacy built-in Collections into the default custom
  // section (same folders/value, unified implementation).
  if (clean.legacyCollections || clean.legacyCollectionsName) {
    try { ensureMigratedCollectionsSection(clean.legacyCollections || [], clean.legacyCollectionsName || null); adopted = true; } catch (error) {}
  }
  if (clean.theme) {
    try { applyTheme(clean.theme, false); } catch (error) {}
    adopted = true;
  }
  if (typeof clean.avatar === 'string') {
    state.profileAvatar = clean.avatar;
    adopted = true;
    try { applyProfile(); } catch (error) {}
  }
  if (Array.isArray(clean.tags)) {
    state.knownTags = cleanTagList(clean.tags);
    adopted = true;
  }
  return adopted;
}
