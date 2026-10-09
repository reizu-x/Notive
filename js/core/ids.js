// js/core/ids.js — note id generation + validation (pure, no DOM/state).

export function newNoteId() {
  try {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return `note-${window.crypto.randomUUID()}`;
    const bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    return 'note-' + [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch (error) {
    return `note-${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  }
}

export function isValidNoteId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
}
