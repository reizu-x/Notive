// js/ui/shell.js — shell preferences & profile: theme/font application, sidebar
// and workspace collapse, panel widths, avatar paint helpers, session-storage
// pass-through, and login-screen theme menu.

import { loginThemeMenu, loginThemeToggle, notesPanel, profileOverlay, settingsOverlay, sidebar, sidebarToggle, workspaceToggle } from '../core/elements.js';
import { e2ee, e2eeB64ToBytes, e2eeBytesToB64 } from '../data/crypto.js';
import { NOTE_TEMPLATES, PANEL_MAX_WIDTH, PANEL_MIN_WIDTH, WELCOME_FOLDERS, WELCOME_SECTION_ID } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { accountScopeKey, cleanAvatarSrc, fullNameOf, initialsFor } from './auth.js';
import { updateStripScrollButton } from './feedback.js';
import { showToast } from './modal.js';
import { renderStripItems, setSettingsTab } from './tabs.js';
import { FONTS } from './theme.js';
import { isImageFile } from '../core/schema.js';
import { refreshSharedNavCount } from '../data/collab-crypto.js';
import { clearEditor, loadNotesFromServer, persistNotes, purgeExpiredBin, selectNote } from './notes.js';
import { renderCustomSections, syncCustomSections } from './sections.js';
import { THEMES, THEME_LABELS, THEME_META_COLORS } from './theme.js';
import { loadUiVault, persistUiVault, writeUiVaultLocal } from './vault.js';
import { sharingEnsureKeys } from '../data/collab-crypto.js';
import { refreshEditorLock } from './auth.js';
import { readFileAsDataUrl } from './editor.js';

export function setLoginThemeMenu(open) {
  if (!loginThemeToggle || !loginThemeMenu) return;
  loginThemeMenu.hidden = !open;
  loginThemeToggle.setAttribute('aria-expanded', String(open));
}

// Reading font (Settings → Appearance). Device-local like the sidebar prefs
// (not part of the per-account envelope): one line, no sync conflicts.
export function applyFont(font, announce = false) {
  const normalized = FONTS.includes(font) ? font : 'default';
  document.documentElement.dataset.font = normalized;
  try { localStorage.setItem('notive-font', normalized); } catch (error) {}
  const fontSelectEl = document.getElementById('font-select');
  if (fontSelectEl) fontSelectEl.value = normalized;
  if (announce) showToast(`${normalized.charAt(0).toUpperCase() + normalized.slice(1)} font on`);
}

// Hide the settings modal.
export function closeSettings() {
  if (!settingsOverlay) return;
  settingsOverlay.hidden = true;
}

// Keep Side Menu settings in sync (unified custom sections have no hide toggles).
export function syncSideMenuSettings() {}

// Show the settings modal and close the mobile sidebar.
export function openSettings() {
  if (!settingsOverlay) return;
  setSettingsTab('appearance');
  const startBox = document.getElementById('start-collapsed');
  if (startBox) startBox.checked = startCollapsedPref();
  syncSideMenuSettings();
  settingsOverlay.hidden = false;
  document.getElementById('sidebar').classList.remove('open');
}

// Center-crop to a square 256px JPEG for a compact avatar.
export function downscaleAvatar(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('decode'));
    img.onload = () => {
      try {
        const size = 256;
        const w = img.naturalWidth || size;
        const h = img.naturalHeight || size;
        const side = Math.min(w, h);
        const canvas = document.createElement('canvas');
        canvas.width = size; canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas')); return; }
        ctx.drawImage(img, (w - side) / 2, (h - side) / 2, side, side, 0, 0, size, size);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('encode')); return; }
          const reader = new FileReader();
          reader.onerror = () => reject(new Error('read'));
          reader.onload = () => resolve(String(reader.result || ''));
          reader.readAsDataURL(blob);
        }, 'image/jpeg', 0.85);
      } catch (error) { reject(error); }
    };
    img.src = dataUrl;
  });
}

export function refreshProfilePopup() {
  const name = state.cachedProfile ? fullNameOf(state.cachedProfile) : '';
  const nameEl = document.getElementById('profile-modal-name');
  if (nameEl) nameEl.textContent = name || 'Not signed in';
  const userEl = document.getElementById('profile-view-username');
  if (userEl) userEl.textContent = state.cachedProfile ? `@${state.cachedProfile.username}` : '';
  const emailEl = document.getElementById('profile-view-email');
  if (emailEl) emailEl.textContent = state.cachedProfile && state.cachedProfile.email ? state.cachedProfile.email : 'No recovery email set';
  paintAvatar(document.getElementById('profile-avatar-large'), initialsFor(name));
  const removeBtn = document.getElementById('profile-photo-remove');
  if (removeBtn) removeBtn.hidden = !cleanAvatarSrc(state.profileAvatar);
}

export function closeProfilePopup() {
  if (profileOverlay) profileOverlay.hidden = true;
}

export function openProfilePopup() {
  if (!profileOverlay) return;
  refreshProfilePopup();
  profileOverlay.hidden = false;
  document.getElementById('sidebar').classList.remove('open');
  const btn = document.getElementById('profile-edit-btn');
  if (btn) { try { btn.focus(); } catch (error) {} }
}

// Paint the sidebar profile card and avatar from the session profile.
export function applyProfile() {
  const profile = currentProfile();
  if (!profile) return;
  const nameEl = document.querySelector('.profile-copy strong');
  const subEl = document.querySelector('.profile-copy span');
  paintAvatar(document.querySelector('.profile-card .avatar'), initialsFor(profile.name));
  if (nameEl) nameEl.textContent = profile.name;
  if (subEl) subEl.textContent = profile.subtitle;
  refreshProfilePopup();
}

// Display profile (name + subtitle) or null when signed out.
export function currentProfile() {
  const sessionUser = getSessionUser();
  if (sessionUser) return { name: sessionUser.name, subtitle: sessionUser.subtitle };
  return null;
}

// --- Profile avatar --------------------------------------------------------
// Optional user picture. Stored inside the E2EE UI vault (never plaintext on
// disk/server), rendered as an image in place of the initials.
// Paint a round avatar element with the picture when set, else its initials.
export function paintAvatar(el, fallbackInitials) {
  if (!el) return;
  el.textContent = '';
  const src = cleanAvatarSrc(state.profileAvatar);
  if (src) {
    const img = document.createElement('img');
    img.alt = '';
    img.src = src;
    el.appendChild(img);
  } else {
    el.textContent = fallbackInitials;
  }
}

// Synchronous view of the in-memory session for render code (null when signed out).
export function getSessionUser() {
  if (!state.cachedProfile) return null;
  return { username: state.cachedProfile.username, name: fullNameOf(state.cachedProfile), subtitle: state.cachedProfile.subtitle || 'Notive User' };
}

export async function restoreSessionUnlock() {
  if (!state.cachedProfile) return false;
  let blob;
  try { blob = JSON.parse(sessionStorage.getItem(sessionUnlockKey()) || 'null'); } catch (error) { blob = null; }
  if (!blob || blob.u !== state.cachedProfile.username || !blob.k) return false;
  try {
    let raw;
    if (blob.k && typeof blob.k === 'object' && blob.k.iv && blob.k.data) {
      // Wrapped format (pentest F-2): unwrap under the per-session KEK.
      const rawBytes = await unwrapSessionKey(blob.k);
      raw = rawBytes;
    } else {
      // Legacy raw base64 blob from before the wrap upgrade: accept once,
      // then immediately re-save in wrapped form.
      raw = e2eeB64ToBytes(blob.k);
      saveSessionUnlock();
    }
    const masterKey = await window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    e2ee.masterKey = masterKey;
    e2ee.kdf = blob.kdf || 'pbkdf2';
    e2ee.saltAuth = blob.saltAuth ? e2eeB64ToBytes(blob.saltAuth) : null;
    e2ee.saltEnc = blob.saltEnc ? e2eeB64ToBytes(blob.saltEnc) : null;
    e2ee.iterations = blob.iterations || 0;
    return true;
  } catch (error) { clearSessionUnlock(); return false; }
}

export async function saveSessionUnlock() {
  if (!e2ee.masterKey || !state.cachedProfile) return;
  try {
    const raw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
    const wrapped = await wrapSessionKey(raw);
    sessionStorage.setItem(sessionUnlockKey(), JSON.stringify({
      u: state.cachedProfile.username,
      k: wrapped,
      kdf: e2ee.kdf || 'pbkdf2',
      saltAuth: e2ee.saltAuth ? e2eeBytesToB64(e2ee.saltAuth) : '',
      saltEnc: e2ee.saltEnc ? e2eeBytesToB64(e2ee.saltEnc) : '',
      iterations: e2ee.iterations || 0,
    }));
  } catch (error) {}
}

export function clearSessionUnlock() {
  const kekKey = sessionKekKey();
  try { sessionStorage.removeItem(sessionUnlockKey()); } catch (error) {}
  try { sessionStorage.removeItem(kekKey); } catch (error) {}
}

// --- Per-browser-session unlock -------------------------------------------
// The master key never touches persistent storage. To survive a page refresh
// without re-typing the password we keep it in sessionStorage (wrapped, see
// below), which the browser wipes when the tab/window closes. Clearing it
// (logout) or closing the browser locks the vault again.
export function sessionUnlockKey() { return accountScopeKey('notive-session-unlock'); }

// Session-wrap KEK. The master key is stored wrapped under this random
// per-tab AES-GCM key (pentest finding F-2) instead of as raw base64 text:
// a naive exfil via sessionStorage.getItem() no longer yields the key bytes.
// The KEK seed also lives in sessionStorage — same-origin script can still
// reach it, so this raises the bar rather than being a full guarantee; the
// accepted design tradeoff (refresh without re-typing the password) is kept.
export function sessionKekKey() { return accountScopeKey('notive-session-unlock-kek'); }

function loadSessionKek() {
  try { return e2eeB64ToBytes(sessionStorage.getItem(sessionKekKey()) || ''); }
  catch (error) { return null; }
}

async function wrapSessionKey(raw) {
  let kek = loadSessionKek();
  if (!kek || kek.length !== 32) {
    kek = window.crypto.getRandomValues(new Uint8Array(32));
    sessionStorage.setItem(sessionKekKey(), e2eeBytesToB64(kek));
  }
  const kekKey = await window.crypto.subtle.importKey('raw', kek, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kekKey, raw);
  return { iv: e2eeBytesToB64(new Uint8Array(iv)), data: e2eeBytesToB64(new Uint8Array(ct)) };
}

async function unwrapSessionKey(wrapped) {
  const kek = loadSessionKek();
  if (!kek || kek.length !== 32) throw new Error('session-kek');
  const kekKey = await window.crypto.subtle.importKey('raw', kek, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return new Uint8Array(await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapped.iv) }, kekKey, e2eeB64ToBytes(wrapped.data)));
}

// Re-apply the persisted collapse choice (login, register, boot all land here
// after their first selection, so the workspace returns as the user left it).
export function restoreWorkspaceCollapsed() {
  try {
    setWorkspaceCollapsed(localStorage.getItem('notive-workspace-collapsed') === '1');
  } catch (error) { setWorkspaceCollapsed(false); }
}

// Collapse/expand the workspace (notes panel) and persist the choice,
// mirroring the sidebar collapse. Starts expanded.
export function setWorkspaceCollapsed(collapsed) {
  const shell = document.querySelector('.app-shell');
  if (shell) shell.classList.toggle('workspace-collapsed', collapsed);
  try { localStorage.setItem('notive-workspace-collapsed', collapsed ? '1' : '0'); } catch (error) {}
  if (workspaceToggle) {
    const label = collapsed ? 'Expand workspace' : 'Collapse workspace';
    workspaceToggle.setAttribute('aria-label', label);
    workspaceToggle.setAttribute('title', label);
  }
  // Expanding clears a Shared folder filter (strip click) so the full section
  // shows again — matches "clear on expand".
  if (!collapsed && state.activeView === 'shared' && state.sharedFolder) {
    state.sharedFolder = null;
    try { import('../data/collab-crypto.js').then((m) => { try { m.renderSharedView(); } catch (error) {} }); } catch (error) {}
    try { renderStripItems(); } catch (error) {}
    try { import('./tabs.js').then((m) => { try { m.updateBreadcrumbs(); } catch (error) {} }); } catch (error) {}
    try { import('./sections.js').then((m) => { try { m.updateFoldToggle(); } catch (error) {} }); } catch (error) {}
  }
  // The strip is only measurable while collapsed: repaint it and re-evaluate
  // the scroll arrows after the layout switches.
  try { renderStripItems(); } catch (error) {}
  try { requestAnimationFrame(updateStripScrollButton); } catch (error) {}
  try { setTimeout(updateStripScrollButton, 60); } catch (error) {}
}

// Whether the sidebar starts collapsed on load (Settings → Side Menu; device-local).
export function startCollapsedPref() {
  try { return localStorage.getItem('notive-sidebar-start-collapsed') !== '0'; }
  catch (error) { return true; }
}

// Collapse/expand the icon-strip sidebar and persist the choice.
export function setSidebarCollapsed(collapsed) {
  sidebar.classList.toggle('collapsed', collapsed);
  try { localStorage.setItem('notive-sidebar-collapsed', collapsed ? '1' : '0'); } catch (error) {}
  if (sidebarToggle) {
    const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';
    sidebarToggle.setAttribute('aria-label', label);
    sidebarToggle.setAttribute('title', label);
  }
  // Folder dots migrate between slide menu and workspace strip on toggle.
  try { renderStripItems(); } catch (error) {}
}

export function restorePanelWidth() {
  if (!notesPanel) return;
  try {
    const saved = parseInt(localStorage.getItem('notive-panel-width') || '', 10);
    if (Number.isFinite(saved)) notesPanel.style.flexBasis = `${Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, saved))}px`;
  } catch (error) {}
}

export function applyPanelWidth(px) {
  if (!notesPanel) return;
  const width = Math.min(PANEL_MAX_WIDTH, Math.max(PANEL_MIN_WIDTH, Math.round(px)));
  notesPanel.style.flexBasis = `${width}px`;
  try { localStorage.setItem('notive-panel-width', String(width)); } catch (error) {}
}

// One seed used by both All Notes and the Shared view, so editing a template's
// title/body is mirrored everywhere a new note is created from it.
export function seedFromTemplate(templateKey, title) {
  const template = NOTE_TEMPLATES[templateKey] || NOTE_TEMPLATES.standard;
  return {
    template,
    title,
    body: typeof template.body === 'function' ? template.body(title) : '',
  };
}

export function slideMenuCollapsed() {
  try { return document.getElementById('sidebar').classList.contains('collapsed'); } catch (error) { return false; }
}

// The sidebar section that ships with new accounts. Only applied when the
// account has no sidebar state of its own (server or device cache).
export function welcomeSeedUi() {
  return {
    collapsed: [],
    customSections: [{ id: WELCOME_SECTION_ID, name: 'Notes', folders: [...WELCOME_FOLDERS], icon: 'book' }],
    deletedCustomSections: [],
  };
}

export function welcomeSeedNotes() {
  const generalWelcome = `# Welcome to Notive

This is your private, end-to-end encrypted notebook. Everything you write is
encrypted on this device before it ever reaches the server — nobody else can
read it, not even the server itself.

## The basics

- **New note** — the button at the top of the list creates a note.
- **Write, then Preview** — the editor opens in Write mode; flip to Preview
  with the button at the top to see your formatted note.
- **Organise** — every note can live in a folder. This workspace starts with
  two: **General** and **Personal**, inside the **Notes** section.
- **Search** — the search bar finds note titles, contents and folders. To find a
  tag, type \`tag: <name>\` (for example, \`tag: recipe\`).

## Sections and folders

The sidebar holds **sections** (think of them as shelves). Each section contains
**folders**, and folders can nest — type \`Work / Projects\` to create a folder
inside a folder. Create new sections with **+ Add section**, and add folders
by right-clicking a section and choosing **New folder**.

## Note types

When creating a note you can pick a template:

- **Note** — free-form markdown, the default. To-do checkboxes use `- [ ]`
  items (clickable in the editor).
- **Recipe** — ingredients and steps with a tidy layout.

## Safety net

- **Favorite** notes (right-click) to pin them for quick access.
- **Mark as important** (right-click) to collect notes under the **Important** tab.
- **Archive** notes you want out of the way but not gone.
- **Delete** moves a note to the **Bin**, where it waits for a grace period
  before being removed for good — mistakes are recoverable.

## More to explore

- **Vault** — password-protected secret notes, separate from your login.
- **Appearance** — six themes and reading fonts under Settings.
- **Diagrams** — fenced \`\`\`mermaid blocks render as flowcharts in Preview.
- **Import / Export** — bring notes in or take them with you as
  JSON, YAML, Markdown or plain text.

> Everything here is yours alone. Change these notes, rename the folders, or
> delete them — this workspace is yours to shape.`;

  const personalWelcome = `# Your personal space

This folder is for the everyday things: journal entries, ideas, lists, plans,
drafts, anything that is yours.

## Ideas to get you started

- A **daily journal** — one note per day, or one running note.
- **Lists** — books to read, films to watch, places to go.
- **Projects** — plan something you care about, one step at a time.
- **Recipes** — switch the template to *Recipe* for ingredients and steps.

## Tips

1. **Tags** — add tags like \`ideas\` or \`todo\` to find notes across folders.
2. **Markdown** — \`#\` makes headings, \`-\` makes lists, \`>\` makes quotes.
3. **Drag notes** onto a folder in the sidebar to file them.

> There is no wrong way to take notes. Start messy, organise later.`;

  return [
    {
      id: 'welcome-general', title: 'Welcome to Notive', date: 'Today',
      tags: ['welcome'], favorite: true, ext: 'md',
      sections: { [WELCOME_SECTION_ID]: 'General' },
      body: generalWelcome,
    },
    {
      id: 'welcome-personal', title: 'Your personal space', date: 'Today',
      tags: ['welcome'], favorite: false, ext: 'md',
      sections: { [WELCOME_SECTION_ID]: 'Personal' },
      body: personalWelcome,
    },
  ];
}


// Apply a theme, persist the choice and update the meta theme-color.
export function applyTheme(theme, announce = false) {
  const normalized = THEMES.includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = normalized;
  try { localStorage.setItem('notive-theme', normalized); } catch (error) {}
  // Sync to the per-account envelope so the choice survives logout, restart
  // and other devices. No-op while logged out/locked (localStorage still keeps
  // the login screen on the picked theme).
  try {
    if (typeof persistUiVault === 'function' && state.cachedProfile && e2ee.masterKey) persistUiVault();
  } catch (error) {}
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.setAttribute('content', THEME_META_COLORS[normalized]);
  const themeSelectEl = document.getElementById('theme-select');
  if (themeSelectEl) themeSelectEl.value = normalized;
  document.querySelectorAll('.login-theme-item').forEach((option) => {
    const selected = option.dataset.themeValue === normalized;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  if (announce) showToast(`${THEME_LABELS[normalized] || normalized} theme on`);
  // Update mermaid theme to match
  try {
    if (window.mermaid) {
      window.mermaid.initialize({ theme: normalized === 'dark' ? 'dark' : 'default' });
    }
  } catch (error) {}
}

export async function handleAvatarFile(file) {
  if (!file) return;
  if (!e2ee.masterKey) { showToast('Log in and unlock your notes to change your photo'); return; }
  if (!isImageFile(file)) { showToast('Use a PNG, JPEG, WebP, GIF, AVIF or BMP image'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('Image too large (5 MB max)'); return; }
  showToast('Loading picture…');
  try {
    const raw = await readFileAsDataUrl(file);
    const scaled = await downscaleAvatar(raw).catch(() => raw);
    const clean = cleanAvatarSrc(scaled) || cleanAvatarSrc(raw);
    if (!clean) { showToast('Could not use that image — try a smaller one'); return; }
    state.profileAvatar = clean;
    paintAvatar(document.querySelector('.profile-card .avatar'), initialsFor(state.cachedProfile ? fullNameOf(state.cachedProfile) : ''));
    refreshProfilePopup();
    persistUiVault();
    showToast('Profile photo updated');
  } catch (error) { showToast('Could not read that image'); }
}

// Load the decrypted workspace after an unlock (login or session restore).
export async function enterWorkspace() {
  // Fresh account context: never leak the previous login's sidebar into this one.
  state.serverUiLoaded = false;
  state.collapsedFolders = new Set();
  state.customSections = [];
  state.deletedCustomSections = [];
  state.activeCustom = null;
  state.knownTags = [];
  await loadNotesFromServer();
  if (purgeExpiredBin()) persistNotes();
  await loadUiVault();
  // No default section/folder seeding: new accounts start with an empty
  // sidebar. ensureMigratedCollectionsSection only runs for genuine legacy data.
  syncCustomSections();
  // First login on a v1 row (or a device that knew more than the server):
  // push the merged sidebar up so the next relog/device sees it.
  if (!state.serverUiLoaded) {
    try { await writeUiVaultLocal(); } catch (error) {}
    persistNotes();
  }
  renderCustomSections();
  const firstActiveNote = state.notes.find((note) => !note.deleted && !note.archived)
    || state.notes.find((note) => !note.deleted)
    || state.notes[0];
  state.currentId = firstActiveNote ? firstActiveNote.id : null;
  if (state.currentId) selectNote(state.currentId);
  else clearEditor();
  refreshEditorLock();
  restoreWorkspaceCollapsed();
  try { sharingEnsureKeys(); } catch (error) {}
  try { refreshSharedNavCount(); } catch (error) {}
  // Ground-up sync: paint the storage choice buttons (cloud/local).
  try { const mod = await import('../data/sync.js'); mod.paintStoragePicker(); } catch (error) {}
}
