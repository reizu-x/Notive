// js/data/sync.js — ground-up sync engine (Phase 2.1: storage choice + warn state).
import { e2ee, e2eeEncryptNotes, e2eeDecryptPayload } from './crypto.js';
import { allVaultBlobs, allVaultFolders } from './vault.js';
import { apiFetch } from './api.js';
import { state } from '../domain/state.js';
import { escapeHtml } from '../core/strings.js';

let lastSyncedAt = 0;
let serverVersion = 0;
export function isSyncing() { return Boolean(state.syncBusy); }

// AAD context binding for workspace notes encryption (mirrors notes.js).
function syncAadContext() {
  const name = state.cachedProfile && state.cachedProfile.username;
  return 'notely-notes-v1:' + (name ? String(name) : '');
}

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
  if (state.syncBusy || state.syncInFlight) return false; // another sync path is already in flight
  if (!state.cachedProfile || !e2ee.masterKey) { paint('Locked', 'gray'); return false; }
  state.syncBusy = true;
  const choice = storageChoice();
  paint('Syncing…', 'gray');
  try {
    let base = 0;
    if (choice === 'cloud') {
      const res = await apiFetch('/api/notes');
      if (!res.ok) throw new Error(`GET failed (HTTP ${res.status})`);
      const data = await res.json();
      const serverTs = (data && typeof data.updated_at === 'number') ? data.updated_at : 0;
      // Adopt the server copy ONLY when it is actually newer (another device
      // wrote since our last sync). Blindly adopting here destroyed unsynced
      // local edits: state was reset to the server version and the PUT below
      // then uploaded that stale copy — typed text never persisted.
      if (data && data.payload && serverTs > (serverVersion || 0)) {
        const parsed = await e2eeDecryptPayload(data.payload, syncAadContext());
        const incoming = Array.isArray(parsed) ? parsed : (parsed && parsed.notes);
        if (Array.isArray(incoming)) {
          if (state.syncDirty) {
            // Local edits pending: merge by id, locally-touched notes win by
            // updatedAt, so in-flight typing survives a concurrent server write.
            const merged = new Map();
            for (const n of incoming) { if (n && n.id) merged.set(n.id, n); }
            for (const n of state.notes) {
              if (!n || !n.id) continue;
              const cur = merged.get(n.id);
              if (!cur || (n.updatedAt || 0) >= (cur.updatedAt || 0)) merged.set(n.id, n);
            }
            state.notes = [...merged.values()].slice(0, 2000);
          } else {
            try { const notesMod = await import('../ui/notes.js'); await notesMod.adoptNotesEnvelope(parsed); } catch (error) { console.error('syncNow: adoptNotesEnvelope failed:', error); }
          }
        }
      }
      base = serverTs;
      serverVersion = serverTs;
    }
    const envelope = {
      v: 2,
      notes: state.notes,
      vault: await allVaultBlobs(),
      vaultFolders: allVaultFolders(),
      ui: uiSnapshot(),
    };
    const put = await apiFetch('/api/notes', { method: 'PUT', body: JSON.stringify({ payload: await e2eeEncryptNotes(envelope, syncAadContext()), baseVersion: base }) });
    if (!put.ok) {
      let bodyText = '';
      try { bodyText = (await put.text()).slice(0, 120); } catch (error) {}
      if (put.status === 409) throw new Error(`Conflict (server changed, client ${state.serverNotesVersion})`);
      throw new Error(`PUT failed (HTTP ${put.status}) ${bodyText}`);
    }
    const putData = await put.json().catch(() => null);
    if (putData && typeof putData.updated_at === 'number') {
      serverVersion = putData.updated_at;
      // Keep the shared tracker in sync: the notes.js save path uses
      // state.serverNotesVersion as its baseVersion, and the "Synced X ago"
      // ticker reads state.lastSyncedAt (not the module locals here).
      try { state.serverNotesVersion = serverVersion; } catch (error) {}
    }
    lastSyncedAt = Date.now();
    try { state.lastSyncedAt = lastSyncedAt; } catch (error) {}
    state.syncDirty = false;
    paint(`Synced to Server ${syncClock(lastSyncedAt)}`, 'green');
    return true;
  } catch (error) {
    const msg = error && error.message ? error.message : 'unknown error';
    console.error('syncNow failed:', error);
    paint(`Sync problem — ${msg}`, 'warn');
    scheduleSync(5000); // back off and retry
    return false;
  } finally {
    state.syncBusy = false;
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
}

export function lastSynced() { return lastSyncedAt; }
export function lastServerVersion() { return serverVersion; }

export async function buildAndEncryptEnvelope() {
  const envelope = {
    v: 2,
    notes: state.notes,
    vault: await allVaultBlobs(),
    vaultFolders: allVaultFolders(),
    ui: (() => {
      try {
        return state.customSections ? {
          customSections: state.customSections.map((s) => ({ id: s.id, name: s.name, folders: [...s.folders], icon: s.icon })),
          collapsed: [...state.collapsedFolders],
          deletedCustomSections: [...(state.deletedCustomSections || [])],
        } : {};
      } catch (error) { return {}; }
    })(),
  };
  return e2eeEncryptNotes(envelope, syncAadContext());
}
