// js/data/vault.js — private-vault blob layer: validation + AES-GCM envelope
// of vault notes, folder-name hygiene, and staged ciphertext for sync.

import { e2eeRandomBytes, e2eeBytesToB64, e2eeB64ToBytes } from './crypto.js';
import { normalizeExt } from '../core/schema.js';
import { state } from '../domain/state.js';

export function validVaultBlob(item) {
  return Boolean(item && typeof item.id === 'string' && item.payload
    && typeof item.payload.iv === 'string' && typeof item.payload.data === 'string');
}

export function cleanVaultFolders(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((name) => typeof name === 'string' && name.trim() && !/[/\\]/.test(name))
    .map((name) => name.trim().replace(/\s+/g, ' ').slice(0, 60))
    .filter(Boolean)
    .slice(0, 200);
}

export function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function vaultEncryptNote(note) {
  const iv = e2eeRandomBytes(12);
  const folder = (note && typeof note.folder === 'string' && note.folder.trim())
    ? note.folder.trim().slice(0, 60) : null;
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, state.vault.dek,
    new TextEncoder().encode(    JSON.stringify({
      id: note.id, title: note.title, body: note.body,
      tags: Array.isArray(note.tags) ? note.tags : [],
      ext: normalizeExt(note.ext),
      date: note.date, favorite: !!note.favorite, folder,
    })));
  return { id: note.id, payload: { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) } };
}

export async function vaultDecryptItem(item) {
  const plain = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(item.payload.iv) }, state.vault.dek,
    e2eeB64ToBytes(item.payload.data));
  const obj = JSON.parse(new TextDecoder().decode(plain));
  if (!obj || typeof obj !== 'object') throw new Error('bad vault note');
  return {
    id: String(item.id),
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.slice(0, 200) : 'Untitled note',
    body: typeof obj.body === 'string' ? obj.body.slice(0, 500000) : '',
    tags: Array.isArray(obj.tags) ? obj.tags.filter((tag) => typeof tag === 'string').slice(0, 20) : [],
    ext: normalizeExt(obj.ext),
    date: typeof obj.date === 'string' ? obj.date.slice(0, 40) : 'Now',
    favorite: false,
    folder: (typeof obj.folder === 'string' && obj.folder.trim()) ? obj.folder.trim().slice(0, 60) : null,
  };
}

export async function decryptAllVaultBlobs() {
  const out = [];
  for (const item of state.vault.blobs) {
    try { out.push(await vaultDecryptItem(item)); }
    catch (error) { /* skip corrupt items */ }
  }
  return out;
}

export async function currentVaultBlobs() {
  if (!state.vault.unlocked) return state.vault.blobs;
  const out = [];
  for (const note of state.vault.notes) out.push(await vaultEncryptNote(note));
  state.vault.blobs = out;
  return out;
}

export function uniqueVaultTitle(base) {
  const clean = (typeof base === 'string' ? base : 'Untitled note').trim().slice(0, 180) || 'Untitled note';
  const taken = new Set(state.vault.notes.map((note) => String(note.title || '').toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  let counter = 2;
  while (taken.has(`${clean} ${counter}`.toLowerCase())) counter += 1;
  return `${clean} ${counter}`;
}

export function cleanVaultFolderInput(raw, exceptFolder) {
  const clean = String(raw == null ? '' : raw).trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!clean) return { error: 'Give the folder a name' };
  if (/[/\\]/.test(raw)) return { error: 'Use a plain name without slashes' };
  if (state.vault.folders.some((entry) => entry !== exceptFolder && entry.toLowerCase() === clean.toLowerCase())) {
    return { error: 'A folder with that name already exists' };
  }
  return { name: clean };
}
