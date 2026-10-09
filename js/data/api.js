// js/data/api.js — the single place that talks to the backend over HTTP.
// Same-origin JSON fetch wrapper used by every backend call. Extracted from
// the monolith so all network policy lives in one module.

import { showToast } from '../ui/modal.js';
import { state } from '../domain/state.js';

// Pentest F-46: device-only mode opts accounts out of cloud traffic. While
// the per-account opt-out is set, collab/keys egress is refused here — the
// single network-policy choke point — instead of at each call site.
const DEVICE_ONLY_KEY = 'drafnote-device-only';

function deviceOnlyActive() {
  try {
    const name = state.cachedProfile && state.cachedProfile.username
      ? String(state.cachedProfile.username).toLowerCase() : '';
    return localStorage.getItem(`${DEVICE_ONLY_KEY}:${name}`) === '1';
  } catch (error) { return false; }
}

export function collabEgressBlocked(path) {
  if (!deviceOnlyActive()) return false;
  return path.startsWith('/api/collab') || path.startsWith('/api/keys');
}

export async function apiFetch(path, options) {
  if (collabEgressBlocked(String(path || ''))) {
    showToast('Device-only mode is on — shared sections need sync re-enabled');
    throw new Error('device-only');
  }
  return fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options && options.headers) },
  });
}
