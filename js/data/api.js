// js/data/api.js — the single place that talks to the backend over HTTP.
// Same-origin JSON fetch wrapper used by every backend call. Extracted from
// the monolith so all network policy lives in one module.

export async function apiFetch(path, options) {
  return fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
}
