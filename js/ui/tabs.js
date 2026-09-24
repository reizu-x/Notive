// js/ui/tabs.js — open-note tabs: track/close, overflow menu, tab bar
// fit logic, drop marks; workspace strip reordering and breadcrumbs.

import { noteList } from '../core/elements.js';
import { icon } from '../core/icons.js';
import { isValidNoteId } from '../core/ids.js';
import { folderDepth, folderIconForDepth, folderLeaf, folderParent, isFolderOrSub } from '../core/paths.js';
import { escapeHtml } from '../core/strings.js';
import { MAX_OPEN_TABS, NOTE_TEMPLATES, sharedGroupFolders, sharedGroupOwners, sharedGroupsCache, sharedNoteMeta } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { canEditCoverNote, moveCoverOnNote } from './editor.js';
import { clearTabDropMarks, noteGlyphFor, updateSettingsScrollButtons, updateStripScrollButton, viewLabel } from './feedback.js';
import { visibleNotes } from './notes.js';
import { customFolderColor, customNoteFolder, isFavoritesView, sectionDisplayName } from './sections.js';
import { renderSettingsTags } from './tags.js';
import { closeCollabNote, openCollabNote } from '../data/collab-crypto.js';
import { e2ee } from '../data/crypto.js';
import { showToast } from './modal.js';
import { clearEditor, closeNoteContextMenu, persistNotes, renderNoteList, selectNote } from './notes.js';
import { closeFolderContextMenu, dropNoteOnFolder, folderListOf, isFolderDrag, persistFolderList, renderCustomSections, reorderFolderBlock, reparentFolder, resolveListFolderTarget } from './sections.js';
import { selectVaultNote } from './vault.js';

// Switch the settings left-nav tab and its right-side pane.
export function setSettingsTab(name) {
  document.querySelectorAll('.settings-nav-item').forEach((item) => item.classList.toggle('active', item.dataset.settingsTab === name));
  document.querySelectorAll('.settings-pane').forEach((pane) => {
    pane.hidden = pane.dataset.settingsPane !== name;
  });
  if (name === 'tags') { try { renderSettingsTags(); } catch (error) {} }
  try { updateSettingsScrollButtons(); } catch (error) {}
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
  // Shared folder scope: read-only crumb naming the scoped folder.
  if (state.activeView === 'shared' && state.sharedFolder) {
    const sep = document.createElement('span');
    sep.className = 'crumb-separator';
    sep.textContent = '/';
    trail.appendChild(sep);
    const folderLabel = document.createElement('span');
    folderLabel.className = 'crumb-link';
    folderLabel.textContent = state.sharedFolder.folder ? folderLeaf(state.sharedFolder.folder) : 'Notes';
    folderLabel.title = state.sharedFolder.folder ? `Scoped to ${state.sharedFolder.folder}` : 'Section root notes';
    trail.appendChild(folderLabel);
  }
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
// Strip note-icon button shared by direct notes and subfolder notes.
function stripNoteBtn(note) {
  return `<button type="button" class="strip-btn${note.id === state.currentId ? ' is-note-active' : ''}" data-strip-note="${escapeHtml(String(note.id))}" title="${escapeHtml(note.title || 'Untitled note')}" aria-label="Open ${escapeHtml(note.title || 'Untitled note')}">${icon(noteGlyphFor(note))}</button>`;
}

// Set of folders holding visible notes, plus their ancestors — reflective
// views (Starred/Archive/Bin) show only these, hiding empty folders.
function stripFolderKeepSet(section, pool) {
  const set = new Set();
  (pool || []).forEach((note) => {
    const f = customNoteFolder(note, section.id);
    let cur = (typeof f === 'string' && f.trim()) ? f : null;
    while (cur) {
      set.add(cur);
      cur = folderParent(cur);
    }
  });
  return set;
}

// Collect a folder subtree into navigation buttons, level by level.
// `rel` tracks nesting for icon sizing (parent 18px, sub 14px, sub-sub 10px).
// `keep` (null = show all): folders outside the set are skipped.
// `pool` (null = folders only): with a pool, each folder's matching notes are
// collected into groups that render after ALL folder buttons. Used in search
// mode so `tag:`/`body:`/text results appear in the strip; otherwise the strip
// stays folders-only. Notes are never included here otherwise: a folder's
// notes appear only once that folder itself is marked, never before.
function collectStripFolders(section, parent, levels, rel, keep, pool) {
  let f = '';
  const groups = [];
  if (levels > 0 && section) {
    (section.folders || []).filter((fl) => folderParent(fl) === parent && (!keep || keep.has(fl))).forEach((kid) => {
      const leaf = folderLeaf(kid);
      f += `<button type="button" class="strip-btn" data-strip-section="${escapeHtml(section.id)}" data-strip-folder="${escapeHtml(kid)}" title="${escapeHtml(leaf)}" aria-label="${escapeHtml(leaf)}"><span class="strip-folder-glyph strip-lvl${rel} ${customFolderColor(section, kid)}">${icon(folderIconForDepth(folderDepth(kid)))}</span></button>`;
      if (pool) {
        const notes = pool.filter((note) => customNoteFolder(note, section.id) === kid);
        if (notes.length) groups.push(notes.map(stripNoteBtn).join(''));
      }
      const sub = collectStripFolders(section, kid, levels - 1, rel + 1, keep, pool);
      f += sub.f;
      groups.push(...sub.groups);
    });
  }
  return { f, groups };
}

// Render child subfolders of `parent` (up to `levels` deep) into the strip
// as navigation buttons, then — only for the currently marked folder — its
// own direct notes (`ownNotesHtml`) under a separator.
// Folder buttons reuse the strip navigation (click + right-click menu) via
// data-strip-section/data-strip-folder.
function renderStripSubfolders(section, parent, levels, ownNotesHtml, pool) {
  const sep = `<span class="strip-separator" aria-hidden="true"></span>`;
  // True in Starred/Archive/Bin: the strip reflects the view by hiding
  // folders (and sections) with no visible notes under them.
  const reflectiveStrip = isFavoritesView() || state.activeView === 'archive' || state.activeView === 'bin';
  const keep = (section && reflectiveStrip) ? stripFolderKeepSet(section, visibleNotes()) : null;
  const { f, groups } = collectStripFolders(section, parent, levels, 0, keep, pool || null);
  const all = ownNotesHtml ? [ownNotesHtml, ...groups] : groups;
  if (!f && !all.length) return '';
  return f + (all.length ? sep + all.join(sep) : '');
}

export function renderStripItems() {
  const box = document.getElementById('workspace-strip-items');
  if (!box) return;
  const section = state.activeCustom ? state.customSections.find((entry) => entry.id === state.activeCustom.section) : null;
  const folder = state.activeCustom ? state.activeCustom.folder : null;
  // Back button sits under the collapse toggle, over the folder name —
  // visible only inside a subfolder.
  const backBtn = document.getElementById('workspace-strip-back');
  // The section the strip reflects: the live selection, else the last section
  // the user marked (view switches clear the selection but not the memory).
  const markedSectionId = (state.activeCustom && state.activeCustom.section)
    || state.lastMarkedSectionId || null;
  if (state.activeView === 'vault') {
    // Vault keeps its notes out of the strip, but still reflects the marked section.
    const marked = markedSectionId ? state.customSections.find((entry) => entry.id === markedSectionId) : null;
    let html = '';
    if (marked) {
      html += `<span class="strip-section-tag" data-strip-section="${escapeHtml(marked.id)}" title="${escapeHtml(marked.name)}" aria-hidden="true">${escapeHtml(marked.name.charAt(0).toUpperCase() || '?')}</span>`;
      html += `<button type="button" class="strip-btn is-section-active" data-strip-section="${escapeHtml(marked.id)}" data-strip-folder="" title="Open section ${escapeHtml(marked.name)}" aria-label="Open section ${escapeHtml(marked.name)}"><span class="strip-folder-glyph ${customFolderColor(marked, '')}">${icon('folder-solid')}</span></button>`;
    }
    box.innerHTML = html;
    if (backBtn) {
      backBtn.hidden = true;
      delete backBtn.dataset.stripSection;
      delete backBtn.dataset.stripTarget;
    }
    updateStripScrollButton();
    return;
  }
  if (state.activeView === 'shared') {
    // Shared strip: one initial tag per shared section (sections only — never
    // folders), plus the direct notes of the selected folder after a real
    // separator, mirroring the All Notes strip.
    const sel = state.sharedFolder;
    const personFilter = state.sharedPerson ? String(state.sharedPerson).toLowerCase() : '';
    const entries = [...sharedGroupFolders.entries()].filter(([groupId]) => {
      if (!personFilter) return true;
      const cached = sharedGroupsCache.find((grp) => String(grp.id) === String(groupId));
      if (!cached) return true;
      if (String(cached.owner || '').toLowerCase() === personFilter) return true;
      return (Array.isArray(cached.members) ? cached.members : []).some((m) => String(m || '').toLowerCase() === personFilter);
    });
    let html = '';
    entries.forEach(([groupId, folders]) => {
      const owner = sharedGroupOwners.get(groupId) || '?';
      html += `<span class="strip-section-tag is-shared" title="Shared with ${escapeHtml(owner)}" aria-hidden="true">${escapeHtml(owner.charAt(0).toUpperCase() || '?')}</span>`;
      const activeGroup = sel && String(sel.groupId) === String(groupId);
      // Full folder universe for this shared section: group meta + any folder
      // that appears on a note (same as sharedFolderTree) so note-created
      // subfolders are visible and correctly parented.
      const folderSet = new Set((folders || []).filter(Boolean));
      sharedNoteMeta.forEach((m) => { if (String(m.groupId) === String(groupId) && m.folder) folderSet.add(m.folder); });
      // Direct notes of the selected folder: a real separator, then the notes.
      if (activeGroup && sel.folder) {
        const direct = [...sharedNoteMeta.values()].filter((m) => String(m.groupId) === String(groupId) && (m.folder || '') === sel.folder);
        if (direct.length) {
          html += `<span class="strip-separator" aria-hidden="true"></span>`;
          html += direct.map((m) => {
            const glyph = (m.template && NOTE_TEMPLATES[m.template] && NOTE_TEMPLATES[m.template].icon) ? NOTE_TEMPLATES[m.template].icon : 'file';
            const activeNote = String(state.collab.noteId) === String(m.id);
            return `<button type="button" class="strip-btn${activeNote ? ' is-note-active' : ''}" data-shared-strip-note="${escapeHtml(String(m.id))}" data-shared-strip-group="${escapeHtml(String(groupId))}" title="${escapeHtml(m.title || 'Untitled note')}" aria-label="Open ${escapeHtml(m.title || 'Untitled note')}">${icon(glyph)}</button>`;
          }).join('');
        }
      }
    });
    box.innerHTML = html;
    if (backBtn) {
      if (sel) {
        const parent = folderParent(sel.folder);
        backBtn.hidden = false;
        backBtn.dataset.stripShared = '1';
        backBtn.dataset.sharedGroup = String(sel.groupId);
        backBtn.dataset.stripTarget = parent || '';
        if (parent) {
          backBtn.title = `${parent} — back to shared parent folder`;
          backBtn.setAttribute('aria-label', `Back to ${folderLeaf(parent)}`);
        } else {
          backBtn.title = 'Back to all shared notes';
          backBtn.setAttribute('aria-label', 'Back to all shared notes');
        }
      } else {
        backBtn.hidden = true;
        delete backBtn.dataset.stripShared;
        delete backBtn.dataset.sharedGroup;
        delete backBtn.dataset.stripTarget;
      }
    }
    updateStripScrollButton();
    return;
  }
  // The main strip lists sections like the expanded list does; the marked
  // section (live selection, else the last one the user marked) is highlighted.
  const sections = section ? [section] : state.customSections.slice();
  const searching = state.searchQuery.trim() !== '';
  let html = '';
  sections.forEach((sec) => {
    if (!sec.folders.length) return;
    // Reflective views skip sections with no visible notes (mirrors the list).
    if ((isFavoritesView() || state.activeView === 'archive' || state.activeView === 'bin')
      && !visibleNotes().some((n) => customNoteFolder(n, sec.id))) return;
    const isMarked = markedSectionId != null && sec.id === markedSectionId;
    html += `<span class="strip-section-tag" data-strip-section="${escapeHtml(sec.id)}" title="${escapeHtml(sec.name)}" aria-hidden="true">${escapeHtml(sec.name.charAt(0).toUpperCase() || '?')}</span>`;
    html += `<button type="button" class="strip-btn${isMarked ? ' is-section-active' : ''}" data-strip-section="${escapeHtml(sec.id)}" data-strip-folder="" title="Open section ${escapeHtml(sec.name)}" aria-label="Open section ${escapeHtml(sec.name)}"><span class="strip-folder-glyph ${customFolderColor(sec, '')}">${icon('folder-solid')}</span></button>`;
    if (!section) {
      // Search mode renders matching note icons under the folders so `tag:`,
      // `body:` and text results appear in the strip; otherwise folders only.
      html += renderStripSubfolders(sec, null, 3, '', searching ? visibleNotes() : null);
    }
  });
  // Inside a section or folder: the folder tree for navigation plus the
  // marked folder's own notes under a separator. In search mode the pool
  // covers the whole subtree (own notes included, so own is folded in).
  if (section) {
    const pool = visibleNotes();
    const own = (!searching && folder) ? pool.filter((note) => customNoteFolder(note, section.id) === folder) : [];
    html += renderStripSubfolders(section, folder, folder ? 2 : 3,
      own.length ? own.map(stripNoteBtn).join('') : '', searching ? pool : null);
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
      delete backBtn.dataset.stripAll;
      if (parent) {
        backBtn.title = `${parent} — back to parent folder`;
        backBtn.setAttribute('aria-label', `Back to ${folderLeaf(parent)}`);
      } else {
        backBtn.title = `${section.name} — back to section`;
        backBtn.setAttribute('aria-label', `Back to ${section.name}`);
      }
    } else if (section && state.activeView !== 'bin') {
      // Section root (e.g. Work with no folder picked): back returns to All Notes.
      backBtn.hidden = false;
      backBtn.dataset.stripSection = section.id;
      backBtn.dataset.stripTarget = '';
      backBtn.dataset.stripAll = '1';
      backBtn.title = 'Back to All Notes';
      backBtn.setAttribute('aria-label', 'Back to All Notes');
    } else {
      backBtn.hidden = true;
      delete backBtn.dataset.stripSection;
      delete backBtn.dataset.stripTarget;
      delete backBtn.dataset.stripAll;
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


export function enableNoteDragDrop() {
  const canDrag = state.activeView !== 'bin' && state.activeView !== 'vault';
  const clearIndicators = () => {
    noteList.querySelectorAll('.drop-before,.drop-after,.drop-target').forEach((el) => el.classList.remove('drop-before', 'drop-after', 'drop-target'));
  };
  noteList.querySelectorAll('[data-note-id]').forEach((row) => {
    const id = row.dataset.noteId;
    row.draggable = canDrag;
    if (!canDrag) return;
    row.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', id);
      event.dataTransfer.effectAllowed = 'move';
      row.classList.add('dragging');
      closeNoteContextMenu();
      closeFolderContextMenu();
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      clearIndicators();
    });
    row.addEventListener('dragover', (event) => {
      if (!event.dataTransfer || isFolderDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const rect = row.getBoundingClientRect();
      const after = (event.clientY - rect.top) > rect.height / 2;
      row.classList.toggle('drop-after', after);
      row.classList.toggle('drop-before', !after);
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (event) => {
      if (isFolderDrag(event)) return;
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      dropNoteOnNote(event.dataTransfer.getData('text/plain'), id, (event.clientY - rect.top) > rect.height / 2);
    });
  });
  if (!canDrag) return;
  noteList.querySelectorAll('[data-folder]').forEach((header) => {
    header.addEventListener('dragover', (event) => {
      if (isFolderDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      header.classList.add('drop-target');
    });
    header.addEventListener('dragleave', () => header.classList.remove('drop-target'));
    header.addEventListener('drop', (event) => {
      if (isFolderDrag(event)) return;
      event.preventDefault();
      const wrap = header.closest('[data-folder-wrap]');
      const shell = header.closest('[data-list-section]');
      const shellKind = shell ? shell.dataset.listSection : null;
      let sectionId = state.activeCustom ? state.activeCustom.section : null;
      if (shellKind === 'custom') {
        const secBtn = shell.querySelector('[data-section-id]');
        if (secBtn && secBtn.dataset.sectionId) sectionId = secBtn.dataset.sectionId;
      }
      // Resolve section from wrap when possible (flat view has no shell context).
      if (!sectionId && wrap) {
        const folder = wrap.dataset.folderWrap;
        const owner = state.customSections.find((section) => section.folders.some((entry) => entry === folder || isFolderOrSub(folder, entry) || isFolderOrSub(entry, folder)));
        if (owner) sectionId = owner.id;
      }
      dropNoteOnFolder(event.dataTransfer.getData('text/plain'), header.dataset.folder, sectionId);
    });
  });
  // Folder headers drag to re-sort or nest (same payload and rules as the
  // slide menu): top/bottom quarter reorders, middle nests inside.
  noteList.querySelectorAll('[data-folder-wrap]').forEach((wrap) => {
    const header = wrap.querySelector('[data-folder]');
    if (!header) return;
    header.draggable = true;
    const rowEl = header.closest('.tree-folder-row') || header;
    header.addEventListener('dragstart', (event) => {
      const target = resolveListFolderTarget(header);
      const fromList = target ? folderListOf(target.ns, target.section) : null;
      // Intermediate headers are not real folders: they cannot be dragged.
      if (!target || !fromList || !fromList.includes(target.path) || !e2ee.masterKey) { event.preventDefault(); return; }
      event.dataTransfer.setData('application/x-dafnote-folder', JSON.stringify(target));
      event.dataTransfer.effectAllowed = 'move';
      header.classList.add('dragging');
      closeFolderContextMenu();
      closeNoteContextMenu();
    });
    header.addEventListener('dragend', () => {
      header.classList.remove('dragging');
      clearIndicators();
    });
    header.addEventListener('dragover', (event) => {
      if (!isFolderDrag(event) || !e2ee.masterKey) return;
      const rect = header.getBoundingClientRect();
      const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      clearIndicators();
      if (ratio < 0.25) rowEl.classList.add('drop-before');
      else if (ratio > 0.75) rowEl.classList.add('drop-after');
      else rowEl.classList.add('drop-target');
    });
    header.addEventListener('dragleave', (event) => {
      if (!header.contains(event.relatedTarget)) {
        rowEl.classList.remove('drop-before', 'drop-after', 'drop-target');
      }
    });
    header.addEventListener('drop', (event) => {
      if (!isFolderDrag(event) || !e2ee.masterKey) return;
      let dragged = null;
      try { dragged = JSON.parse(event.dataTransfer.getData('application/x-dafnote-folder')); } catch (error) { dragged = null; }
      if (!dragged || !dragged.path) return;
      const target = resolveListFolderTarget(header);
      if (!target || target.ns !== dragged.ns || target.section !== dragged.section) return;
      if (target.path === dragged.path) return;
      if (isFolderOrSub(target.path, dragged.path)) {
        event.preventDefault();
        showToast("Can't move a folder into itself");
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const rect = header.getBoundingClientRect();
      const ratio = rect.height ? (event.clientY - rect.top) / rect.height : 0.5;
      const list = folderListOf(dragged.ns, dragged.section);
      if (!list) return;
      // Intermediate headers are not real folders: order around their subtree
      // instead (never nest into them).
      let anchor = target.path;
      let after = ratio > 0.75;
      let nest = ratio >= 0.25 && ratio <= 0.75;
      if (!list.includes(target.path)) {
        const under = list.filter((entry) => isFolderOrSub(entry, target.path));
        if (!under.length) return;
        nest = false;
        if (ratio < 0.5) { anchor = under[0]; after = false; }
        else { anchor = under[under.length - 1]; after = true; }
      }
      if (anchor === dragged.path || isFolderOrSub(anchor, dragged.path)) return;
      if (nest) {
        // Nest inside the target folder.
        const newPath = reparentFolder(dragged.ns, dragged.section, dragged.path, target.path);
        if (!newPath) return;
        const movedHome = newPath !== dragged.path;
        const moved = folderListOf(dragged.ns, dragged.section).filter((entry) => isFolderOrSub(entry, newPath));
        const rest = folderListOf(dragged.ns, dragged.section).filter((entry) => !isFolderOrSub(entry, newPath));
        let index = rest.length;
        for (let i = rest.length - 1; i >= 0; i -= 1) {
          if (isFolderOrSub(rest[i], target.path)) { index = i + 1; break; }
        }
        const reordered = [...rest.slice(0, index), ...moved, ...rest.slice(index)];
        const section = state.customSections.find((entry) => entry.id === dragged.section);
        if (section) section.folders = reordered;
        persistFolderList(dragged.ns);
        renderCustomSections();
        renderNoteList();
        if (movedHome) showToast(`Moved to “${folderLeaf(target.path)}”`);
      } else {
        // Reorder around the anchor (reparenting across levels when needed).
        const refParent = folderParent(anchor);
        let movedRoot = dragged.path;
        if ((refParent || null) !== (folderParent(dragged.path) || null)) {
          const newPath = reparentFolder(dragged.ns, dragged.section, dragged.path, refParent);
          if (!newPath) return;
          movedRoot = newPath;
        }
        if (reorderFolderBlock(dragged.ns, dragged.section, movedRoot, anchor, after)) {
          renderCustomSections();
          renderNoteList();
        }
      }
    });
  });
}

// Drag-and-drop note sorting: drag a row onto another note to reorder (top /
// bottom half picks the side); dropping onto a folder header moves the note
// into that folder. Disabled in Bin and Vault, where order is meaningless.
export function dropNoteOnNote(draggedId, targetId, after) {
  if (!draggedId || !targetId || draggedId === targetId) return;
  const from = state.notes.findIndex((note) => note.id === draggedId);
  const target = state.notes.find((note) => note.id === targetId);
  if (from === -1 || !target) return;
  const [moved] = state.notes.splice(from, 1);
  // Adopt the target's folder when inside a specific folder view (same section only).
  if (state.activeCustom && state.activeCustom.folder) {
    const folder = customNoteFolder(target, state.activeCustom.section);
    if (folder) {
      if (!moved.sections || typeof moved.sections !== 'object') moved.sections = {};
      moved.sections[state.activeCustom.section] = folder;
    }
  }
  let to = state.notes.findIndex((note) => note.id === targetId);
  if (after) to += 1;
  state.notes.splice(to, 0, moved);
  persistNotes();
  renderNoteList();
}

// Paint the strip; drop tabs whose notes are gone (purged, vault locked) or
// binned — a deleted note leaves the tabs at once.
export function renderTabs() {
  const bar = document.getElementById('tab-bar');
  if (!bar) return;
  state.openTabs = state.openTabs.filter((tab) => {
    const note = findTabbedNote(tab.id, tab.vault, tab.shared);
    return note && !note.deleted;
  });
  // No tabs, no collapse toggle.
  try {
    const collapseBtn = document.getElementById('toggle-workspace');
    if (collapseBtn) collapseBtn.hidden = state.openTabs.length === 0;
  } catch (error) {}
  const activeAlive = (state.currentId && state.notes.some((entry) => entry.id === state.currentId))
    || (state.currentVaultId && state.vault.unlocked && state.vault.notes.some((entry) => entry.id === state.currentVaultId))
    || (state.collab.noteId != null && state.openTabs.some((tab) => tab.shared && String(tab.id) === String(state.collab.noteId)));
  if ((state.currentId || state.currentVaultId || state.collab.noteId != null) && !activeAlive) {
    const fallback = [...state.openTabs].reverse().find((tab) => findTabbedNote(tab.id, tab.vault, tab.shared));
    if (fallback) {
      if (fallback.shared) openCollabNote(fallback.id);
      else if (fallback.vault) selectVaultNote(fallback.id);
      else selectNote(fallback.id);
      return; // selecting re-renders the strip
    }
    state.currentId = null;
    state.currentVaultId = null;
    if (state.collab.noteId != null) closeCollabNote();
    clearEditor();
    return; // clearing re-renders the strip
  }
  bar.innerHTML = `<button type="button" class="tab-home" data-tab-home title="All Notes" aria-label="All Notes">${icon('inbox')}</button>`
    + state.openTabs.map((tab) => {
      const note = findTabbedNote(tab.id, tab.vault, tab.shared);
      const title = (note && note.title) || 'Untitled note';
      const active = tab.shared
        ? (state.collab.noteId != null && String(tab.id) === String(state.collab.noteId))
        : ((!tab.vault && tab.id === state.currentId) || (tab.vault && tab.id === state.currentVaultId));
      return `<button type="button" class="tab-item${active ? ' active' : ''}" draggable="true" data-tab-id="${escapeHtml(String(tab.id))}" data-tab-vault="${tab.vault ? '1' : ''}" data-tab-shared="${tab.shared ? '1' : ''}" title="${escapeHtml(title)}">`
        + `<span class="tab-glyph">${icon(tab.shared ? 'share' : noteGlyphFor(note))}</span>`
        + `<span class="tab-label">${escapeHtml(title)}</span>`
        + `<span class="tab-close" data-tab-close="${escapeHtml(String(tab.id))}" data-tab-close-vault="${tab.vault ? '1' : ''}" data-tab-close-shared="${tab.shared ? '1' : ''}" role="button" aria-label="Close ${escapeHtml(title)}">×</span>`
        + `</button>`;
    }).join('')
    + `<button type="button" class="tab-overflow" data-tab-overflow title="More tabs" aria-label="More tabs" hidden><span data-overflow-count></span>${icon('chevron-down')}</button>`;
  fitTabStrip(bar);
}

// Close one tab; when it was active, fall back to the nearest surviving
// neighbor (next, then previous, then outward) so selection stays put.
export function closeTab(id, isVault, isShared) {
  const wasVault = Boolean(isVault);
  const wasShared = Boolean(isShared);
  const wasActive = wasShared
    ? (state.collab.noteId != null && String(state.collab.noteId) === String(id))
    : (!wasVault && id === state.currentId) || (wasVault && id === state.currentVaultId);
  const closedAt = state.openTabs.findIndex((tab) => String(tab.id) === String(id) && tab.vault === wasVault && Boolean(tab.shared) === wasShared);
  state.openTabs = state.openTabs.filter((tab) => !(String(tab.id) === String(id) && tab.vault === wasVault && Boolean(tab.shared) === wasShared));
  if (wasActive) {
    const order = [];
    const at = closedAt === -1 ? state.openTabs.length : closedAt;
    if (at < state.openTabs.length) order.push(at);
    for (let d = 1; d < state.openTabs.length; d += 1) {
      if (at - d >= 0) order.push(at - d);
      if (at + d < state.openTabs.length) order.push(at + d);
    }
    for (const i of order) {
      if (findTabbedNote(state.openTabs[i].id, state.openTabs[i].vault, state.openTabs[i].shared)) {
        if (state.openTabs[i].shared) openCollabNote(state.openTabs[i].id);
        else if (state.openTabs[i].vault) selectVaultNote(state.openTabs[i].id);
        else selectNote(state.openTabs[i].id);
        renderTabs();
        return;
      }
    }
    if (state.collab.noteId != null) closeCollabNote();
    state.currentId = null;
    state.currentVaultId = null;
    clearEditor();
  }
  renderTabs();
}
