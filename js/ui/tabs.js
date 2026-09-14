// js/ui/tabs.js — open-note tabs: track/close, overflow menu, tab bar
// fit logic, drop marks; workspace strip reordering and breadcrumbs.

import { noteList } from '../core/elements.js';
import { icon } from '../core/icons.js';
import { isValidNoteId } from '../core/ids.js';
import { folderDepth, folderIconForDepth, folderLeaf, folderParent, isFolderOrSub } from '../core/paths.js';
import { escapeHtml } from '../core/strings.js';
import { MAX_OPEN_TABS, sharedNoteMeta } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { canEditCoverNote, moveCoverOnNote } from './editor.js';
import { clearTabDropMarks, noteGlyphFor, updateStripScrollButton, viewLabel } from './feedback.js';
import { visibleNotes } from './notes.js';
import { customFolderColor, customNoteFolder, sectionDisplayName } from './sections.js';
import { renderSettingsTags } from './tags.js';
// Switch the settings left-nav tab and its right-side pane.
export function setSettingsTab(name) {
  document.querySelectorAll('.settings-nav-item').forEach((item) => item.classList.toggle('active', item.dataset.settingsTab === name));
  document.querySelectorAll('.settings-pane').forEach((pane) => {
    pane.hidden = pane.dataset.settingsPane !== name;
  });
  if (name === 'tags') { try { renderSettingsTags(); } catch (error) {} }
}

// Reposition by dragging the banner on the note itself (buttons opt out).
export function coverDragStart(event, clientY) {
  if (event.target && event.target.closest && event.target.closest('button')) return;
  if (!coverDragNote()) return;
  state.coverDragging = true;
  const wrap = document.getElementById('cover-wrap');
  if (wrap) wrap.classList.add('dragging');
  moveCoverOnNote(clientY);
  event.preventDefault();
}

// Drag-and-drop in the Shared tree: move notes into folders, reparent folders.
export function clearSharedDropTargets() {
  noteList.querySelectorAll('.drop-target, .drop-before').forEach((el) => el.classList.remove('drop-target', 'drop-before'));
}

export function endCoverDrag() {
  if (!state.coverDragging) return;
  state.coverDragging = false;
  const wrap = document.getElementById('cover-wrap');
  if (wrap) wrap.classList.remove('dragging');
}

export function coverDragNote() {
  if (!state.coverRepositioning) return null;
  return canEditCoverNote();
}

export function updateBreadcrumbs() {
  const trail = document.getElementById('breadcrumb-trail');
  if (!trail) return;
  trail.innerHTML = '';
  const root = document.createElement('button');
  root.type = 'button';
  root.className = 'crumb-link';
  root.dataset.crumb = 'root';
  root.textContent = viewLabel(state.activeView);
  root.title = 'Back to All Notes';
  trail.appendChild(root);
  const activeFolderPath = (state.activeCustom ? state.activeCustom.folder : null);
  const activeFolder = activeFolderPath
    || (state.activeCustom ? sectionDisplayName('custom', state.activeCustom.section) : null);
  if (activeFolder) {
    const sep = document.createElement('span');
    sep.className = 'crumb-separator';
    sep.textContent = '/';
    trail.appendChild(sep);
    const folder = document.createElement('button');
    folder.type = 'button';
    folder.className = 'crumb-link';
    folder.dataset.crumb = 'folder';
    folder.textContent = activeFolderPath ? folderLeaf(activeFolder) : activeFolder;
    folder.title = `Show ${activeFolder}`;
    trail.appendChild(folder);
  }
}

// Collapsed workspace strip. With the sidebar expanded it behaves as before:
// inside a folder it lists that folder's notes plus immediate subfolders.
// With the sidebar COLLAPSED the slide menu shows sections only, so this
// strip becomes the folder navigator: every folder of the active section (or
// of all sections when no section is selected) renders as its colored dot;
// clicking one opens it. Gold folder glyphs stay distinct from note glyphs.
export function renderStripItems() {
  const box = document.getElementById('workspace-strip-items');
  if (!box) return;
  const section = state.activeCustom ? state.customSections.find((entry) => entry.id === state.activeCustom.section) : null;
  const folder = state.activeCustom ? state.activeCustom.folder : null;
  // Back button sits under the collapse toggle, over the folder name —
  // visible only inside a subfolder.
  const backBtn = document.getElementById('workspace-strip-back');
  if (state.activeView === 'vault' || state.activeView === 'shared') {
    box.innerHTML = '';
    if (backBtn) {
      backBtn.hidden = true;
      delete backBtn.dataset.stripSection;
      delete backBtn.dataset.stripTarget;
    }
    updateStripScrollButton();
    return;
  }
  // Folder navigation is always on in the strip (folders no longer live in
  // the slide menu in any state). Folders render as a tree: each subfolder
  // sits indented under its parent, preserving the section's list order.
  // Notes join the strip only while inside a folder, after the tree.
  const sections = section ? [section] : state.customSections.slice();
  let html = '';
  sections.forEach((sec) => {
    if (!sec.folders.length) return;
    if (!section && sections.length > 1) {
      html += `<span class="strip-section-tag" title="${escapeHtml(sec.name)}" aria-hidden="true">${escapeHtml(sec.name.charAt(0).toUpperCase() || '?')}</span>`;
    }
    // When a folder is selected the strip is scoped to that folder's branch:
    // it shows only the folder and its contents (its subfolders). Otherwise
    // the whole section tree is shown for navigation.
    const pool = (section && folder)
      ? [folder, ...sec.folders.filter((name) => name !== folder && isFolderOrSub(name, folder))]
      : sec.folders;
    const childrenOf = new Map();
    const roots = [];
    pool.forEach((name) => {
      const parent = folderParent(name);
      if (parent && pool.includes(parent)) {
        if (!childrenOf.has(parent)) childrenOf.set(parent, []);
        childrenOf.get(parent).push(name);
      } else roots.push(name);
    });
    const emitted = new Set();
    const emitFolder = (name) => {
      if (emitted.has(name)) return;
      emitted.add(name);
      const depth = folderDepth(name);
      const activeDot = section && folder === name;
      const glyph = `<span class="strip-folder-glyph ${customFolderColor(sec, name)}">${icon(folderIconForDepth(depth))}</span>`;
      html += `<button type="button" class="strip-btn is-folder${depth > 0 ? ' is-subfolder' : ''}${depth > 1 ? ' is-deep' : ''}${activeDot ? ' is-dot-active' : ''}" data-strip-section="${escapeHtml(sec.id)}" data-strip-folder="${escapeHtml(name)}" title="${escapeHtml(sec.name)} / ${escapeHtml(name)}" aria-label="Open ${escapeHtml(folderLeaf(name))}">${glyph}</button>`;
      (childrenOf.get(name) || []).forEach(emitFolder);
    };
    roots.forEach(emitFolder);
    pool.forEach(emitFolder);
  });
  // Inside a folder: append its direct notes beneath the folder icons.
  if (section && folder && state.activeView !== 'bin') {
    const pool = visibleNotes().filter((note) => !note.deleted);
    const direct = pool.filter((note) => customNoteFolder(note, section.id) === folder);
    if (direct.length) html += `<span class="strip-section-tag" title="Notes in ${escapeHtml(folderLeaf(folder))}" aria-hidden="true">·</span>`;
    html += direct.map((note) => `<button type="button" class="strip-btn${note.id === state.currentId ? ' is-note-active' : ''}" data-strip-note="${escapeHtml(String(note.id))}" title="${escapeHtml(note.title || 'Untitled note')}" aria-label="Open ${escapeHtml(note.title || 'Untitled note')}">${icon(noteGlyphFor(note))}</button>`).join('');
  }
  box.innerHTML = html;
  if (backBtn) {
    // Back is available anywhere inside a folder: up to the parent folder
    // when nested, otherwise back to the section root (no folder selected).
    if (section && folder) {
      const parent = folderParent(folder);
      backBtn.hidden = false;
      backBtn.dataset.stripSection = section.id;
      backBtn.dataset.stripTarget = parent || '';
      if (parent) {
        backBtn.title = `${parent} — back to parent folder`;
        backBtn.setAttribute('aria-label', `Back to ${folderLeaf(parent)}`);
      } else {
        backBtn.title = `${section.name} — back to section`;
        backBtn.setAttribute('aria-label', `Back to ${section.name}`);
      }
    } else {
      backBtn.hidden = true;
      delete backBtn.dataset.stripSection;
      delete backBtn.dataset.stripTarget;
    }
  }
  updateStripScrollButton();
}

// Drag-and-drop reordering of tabs (order is otherwise fixed by opening time).
export function endTabDrag() {
  if (state.dragTabEl) state.dragTabEl.classList.remove('dragging');
  clearTabDropMarks();
  state.dragTabEl = null;
  state.dragTabIndex = null;
  state.tabClickSuppressed = true;
  setTimeout(() => { state.tabClickSuppressed = false; }, 250);
}

export function toggleTabOverflow() {
  const menu = document.getElementById('tab-overflow-menu');
  if (!menu) return;
  if (state.tabOverflowOpen) { closeTabOverflow(); return; }
  if (!state.lastOverflowTabs.length) return;
  state.tabOverflowOpen = true;
  paintTabOverflow();
  menu.hidden = false;
  placeTabOverflow();
}

export function placeTabOverflow() {
  const menu = document.getElementById('tab-overflow-menu');
  const bar = document.getElementById('tab-bar');
  if (!menu || !bar) return;
  const btn = bar.querySelector('[data-tab-overflow]');
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  menu.style.top = `${rect.bottom + 6}px`;
  menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - menu.offsetWidth - 8))}px`;
}

export function paintTabOverflow() {
  const menu = document.getElementById('tab-overflow-menu');
  if (!menu) return;
  menu.innerHTML = state.lastOverflowTabs.map((tab) => {
    const note = findTabbedNote(tab.id, tab.vault, tab.shared);
    const title = (note && note.title) || tab.title || 'Untitled note';
    return `<button type="button" class="context-item" data-otab-id="${escapeHtml(String(tab.id))}" data-otab-vault="${tab.vault ? '1' : ''}" data-otab-shared="${tab.shared ? '1' : ''}" title="${escapeHtml(title)}">`
      + `<span class="tab-glyph">${icon(tab.shared ? 'share' : noteGlyphFor(note))}</span>`
      + `<span class="tab-label">${escapeHtml(title)}</span>`
      + `<span class="tab-close" data-otab-close="${escapeHtml(String(tab.id))}" data-otab-close-vault="${tab.vault ? '1' : ''}" data-otab-close-shared="${tab.shared ? '1' : ''}" role="button" aria-label="Close ${escapeHtml(title)}">×</span>`
      + `</button>`;
  }).join('');
}

// Hide whatever does not fit; the active tab always stays, earliest others
// fill the rest, and the remainder goes to the dropdown button. No scrollbar.
export function fitTabStrip(bar) {
  const btn = bar.querySelector('[data-tab-overflow]');
  const tabs = [...bar.querySelectorAll('[data-tab-id]')];
  if (!btn || !bar.clientWidth) {
    if (btn) btn.hidden = true;
    state.lastOverflowTabs = [];
    closeTabOverflow();
    return;
  }
  const gap = 6;
  const home = bar.querySelector('[data-tab-home]');
  const homeW = home ? home.offsetWidth : 0;
  const widths = new Map(tabs.map((tab) => [tab, tab.offsetWidth]));
  const totalTabs = tabs.reduce((sum, tab) => sum + widths.get(tab) + gap, 0);
  if (homeW + gap + totalTabs <= bar.clientWidth) {
    btn.hidden = true;
    tabs.forEach((tab) => { tab.hidden = false; });
    state.lastOverflowTabs = [];
    closeTabOverflow();
    return;
  }
  btn.hidden = false;
  const btnW = btn.offsetWidth;
  const activeEl = bar.querySelector('.tab-item.active');
  const visible = new Set();
  let used = homeW + gap + btnW + gap;
  if (activeEl) { visible.add(activeEl); used += widths.get(activeEl) + gap; }
  for (const tab of tabs) {
    if (visible.has(tab)) continue;
    if (used + widths.get(tab) <= bar.clientWidth) { visible.add(tab); used += widths.get(tab) + gap; }
  }
  const hidden = [];
  tabs.forEach((tab) => {
    const hide = !visible.has(tab);
    tab.hidden = hide;
    if (hide) hidden.push({ id: tab.dataset.tabId, vault: tab.dataset.tabVault === '1', shared: tab.dataset.tabShared === '1', title: tab.title });
  });
  state.lastOverflowTabs = hidden;
  const countEl = btn.querySelector('[data-overflow-count]');
  if (countEl) countEl.textContent = hidden.length ? `+${hidden.length}` : '';
  btn.setAttribute('aria-label', `${hidden.length} more tabs`);
  if (!hidden.length) { closeTabOverflow(); return; }
  if (state.tabOverflowOpen) { paintTabOverflow(); placeTabOverflow(); }
}

// Overflowed tabs (id/vault/title) from the last fit; powers the dropdown.
export function closeTabOverflow() {
  state.tabOverflowOpen = false;
  const menu = document.getElementById('tab-overflow-menu');
  if (menu) menu.hidden = true;
}

// Remember an opened note; selecting a tab never moves it — order is fixed
// by opening time. Evict oldest non-active past the cap.
export function trackTab(id, isVault, isShared) {
  const shared = Boolean(isShared);
  let tabId = id;
  if (shared) {
    tabId = Number(id);
    if (!Number.isInteger(tabId) || tabId <= 0) return;
  } else if (!isValidNoteId(id)) return;
  const wasVault = Boolean(isVault);
  if (!state.openTabs.some((tab) => String(tab.id) === String(tabId) && tab.vault === wasVault && Boolean(tab.shared) === shared)) {
    state.openTabs.push({ id: tabId, vault: wasVault, shared });
  }
  while (state.openTabs.length > MAX_OPEN_TABS) {
    const dropAt = state.openTabs.findIndex((tab) => !(tab.id === state.currentId && !tab.vault)
      && !(tab.id === state.currentVaultId && tab.vault)
      && !(tab.shared && state.collab.noteId != null && String(tab.id) === String(state.collab.noteId)));
    state.openTabs.splice(dropAt === -1 ? 0 : dropAt, 1);
  }
}

// List glyph shared by the note list, tabs and strip. Recipes and to-dos keep
// their distinctive glyphs; everything else gets its file-type icon.
export function findTabbedNote(id, isVault, isShared) {
  if (isShared) {
    const meta = sharedNoteMeta.get(String(id)) || sharedNoteMeta.get(id);
    return { id, title: (meta && meta.title) || 'Shared note', template: (meta && meta.template) || '', shared: true, deleted: false };
  }
  if (isVault) return state.vault.unlocked ? state.vault.notes.find((entry) => entry.id === id) || null : null;
  return state.notes.find((entry) => entry.id === id) || null;
}
