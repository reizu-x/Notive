// js/data/sync.js — ground-up sync engine (Phase 2.1: storage choice + warn state).
import { e2ee, e2eeEncryptNotes, e2eeDecryptPayload } from './crypto.js';
import { apiFetch } from './api.js';
import { state } from '../domain/state.js';
import { escapeHtml } from '../core/strings.js';

let lastSyncedAt = 0;
let serverVersion = 0;
let syncBusy = false;
export function isSyncing() { return syncBusy; }

function scope(base) {
  const me = state.cachedProfile && state.cachedProfile.username ? String(state.cachedProfile.username).toLowerCase() : '';
  return `${base}:${me}`;
}

// Storage choice: cloud-only (local mode retired).
export function storageChoice() { return 'cloud'; }
export function setStorageChoice() { return 'cloud'; }

// Storage picker + footer button states (cloud-only since local retired).
export function paintStoragePicker() {
  const picker = document.getElementById('storage-picker');
  if (picker) picker.querySelectorAll('button[data-storage]').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.storage === 'cloud'));
  const syncBtn = document.getElementById('sync-now-btn');
  if (syncBtn) { syncBtn.dataset.mode = 'cloud'; syncBtn.classList.remove('is-local'); syncBtn.textContent = '⟳ Sync now'; }
}

function paint(text, mode) {
  const dot = document.querySelector('.sync-status .sync-dot');
  const txt = document.querySelector('.sync-status .sync-text');
  if (dot) {
    dot.classList.toggle('is-error', mode === 'red');
    dot.classList.toggle('is-offline', mode === 'gray');
    dot.classList.toggle('is-warn', mode === 'warn');
  }
  if (txt) txt.textContent = text;
}

export function syncClock(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let dirtyTimer = null;
export function markDirty() {
  state.syncDirty = true;
  paint('Unsynced edits', 'warn');
  scheduleSync();
}

export function scheduleSync(delay = 1500) {
  if (dirtyTimer) return;           // already scheduled
  if (!state.syncDirty) return;     // nothing to push
  dirtyTimer = setTimeout(async () => {
    dirtyTimer = null;
    if (state.syncDirty) await syncNow().catch(() => {});
  }, delay);
}

// Legacy shim used by ~80 call sites.
export function persistNotes() { markDirty(); }

export function isDirty() { return Boolean(state.syncDirty); }

export async function syncNow() {
  if (syncBusy) return false; // an autosync is already in flight — skip this tick
  if (!state.cachedProfile || !e2ee.masterKey) { paint('Locked', 'gray'); return false; }
  syncBusy = true;
  const choice = storageChoice();
  paint('Syncing…', 'gray');
  try {
    let base = 0;
    let serverPayload = null;
    if (choice === 'cloud') {
      const res = await apiFetch('/api/notes');
      if (!res.ok) throw new Error(`GET failed (HTTP ${res.status})`);
      const data = await res.json();
      if (data && typeof data.updated_at === 'number') { base = data.updated_at; serverVersion = base; }
      if (data && data.payload) {
        const parsed = await e2eeDecryptPayload(data.payload);
        if (parsed && Array.isArray(parsed.notes)) {
          try { const notesMod = await import('../ui/notes.js'); await notesMod.adoptNotesEnvelope(parsed); } catch (error) {}
        }
      }
    }
    const envelope = {
      v: 2,
      notes: state.notes,
      vault: await currentVaultOrEmpty(),
      vaultFolders: [...(state.vault && state.vault.folders ? state.vault.folders : [])],
      ui: uiSnapshot(),
    };
    const gen = syncGeneration;
    // ... existing sync logic ...
    const put = await apiFetch('/api/notes', { method: 'PUT', body: JSON.stringify({ payload: await e2eeEncryptNotes(envelope), baseVersion: base }) });
    if (!put.ok) {
      let bodyText = '';
      try { bodyText = (await put.text()).slice(0, 120); } catch (error) {}
      if (put.status === 409) throw new Error(`Conflict (server changed, client ${state.serverNotesVersion})`);
      throw new Error(`PUT failed (HTTP ${put.status}) ${bodyText}`);
    }
    const putData = await put.json().catch(() => null);
    if (putData && typeof putData.updated_at === 'number') serverVersion = putData.updated_at;
    lastSyncedAt = Date.now();
    state.syncDirty = false;
    paint(`🟢 Synced to Server ${syncClock(lastSyncedAt)}`, 'green');
    return true;
  } catch (error) {
    const msg = error && error.message ? error.message : 'unknown error';
    paint(`Sync problem — ${msg}`, 'warn');
    scheduleSync(5000); // back off and retry
    return false;
  } finally {
    syncBusy = false;
  }

  async function currentVaultOrEmpty() {
    try { return state.vault && state.vault.blobs ? state.vault.blobs.slice(0) : []; }
    catch (error) { return []; }
  }
  function uiSnapshot() {
    try {
      return state.customSections ? {
        customSections: state.customSections.map((s) => ({ id: s.id, name: s.name, folders: [...s.folders], icon: s.icon })),
        collapsed: [...state.collapsedFolders],
        deletedCustomSections: [...(state.deletedCustomSections || [])],
      } : {};
    } catch (error) { return {}; }
  }
  function localKeyFor() { return scope('notely-local-notes'); }
}

export function lastSynced() { return lastSyncedAt; }
