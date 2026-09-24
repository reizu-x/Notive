// js/ui/feedback.js — status/label feedback helpers (save indicator,
// sync-ago line, view labels, note glyphs, strip scroll buttons).

import { icon } from '../core/icons.js';
import { stripBoxEl, tabBarEl, saveLabel } from '../core/elements.js';
import { BIN_RETENTION_MS } from '../core/dates.js';
import { preferredTimezone, formatTime } from '../core/dates.js';
import { state } from '../domain/state.js';

export function setSaveLabel(text, mode = 'green') {
  if (saveLabel) saveLabel.textContent = text;
  const dot = document.querySelector('.save-state .save-dot');
  if (dot) {
    dot.classList.toggle('is-offline', mode === 'gray');
    dot.classList.toggle('is-error', mode === 'red');
  }
  // Sidebar footer mirror: drives the Settings/Help-area indicator too so
  // the two can never show different states.
  const syncDot = document.querySelector('.sync-status .sync-dot');
  const syncText = document.querySelector('.sync-status .sync-text');
  if (syncDot) {
    syncDot.classList.toggle('is-offline', mode === 'gray');
    syncDot.classList.toggle('is-error', mode === 'red');
  }
  if (syncText) syncText.textContent = text;
}

export function syncAgoText() {
  const ts = state.lastSyncedAt || 0;
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (seconds < 15) return 'Synced just now';
  if (seconds < 120) return 'Synced 1 min ago';
  if (seconds < 3600) return `Synced ${Math.floor(seconds / 60)} min ago`;
  return `Synced at ${formatTime(ts, preferredTimezone())}`;
}

export function viewLabel(view) {
  if (view === 'favorites') return 'Favourites';
  if (view === 'archive') return 'Archive';
  if (view === 'bin') return 'Bin';
  if (view === 'vault') return 'Vault';
  return 'All Notes';
}

export function binRemainingText(note) {
  if (!note.deleted || typeof note.deletedAt !== 'number') return '';
  const remaining = BIN_RETENTION_MS - (Date.now() - note.deletedAt);
  if (remaining <= 0) return 'Expires soon';
  const days = Math.floor(remaining / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d left`;
  const hours = Math.floor(remaining / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h left`;
  return 'Expires soon';
}

export function noteGlyphFor(note) {
  if (note && note.template === 'recipe') return 'cooking';
  if (note && note.template === 'todo') return 'todo';
  const ext = note && note.ext;
  if (ext === 'txt') return 'type-txt';
  if (ext === 'json') return 'type-json';
  if (ext === 'yaml') return 'type-yaml';
  return 'type-md';
}

export function makeStripScrollButton(id, dir, glyphName, label) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `strip-scroll-btn strip-scroll-${dir}`;
  btn.id = id;
  btn.setAttribute('aria-label', label);
  btn.setAttribute('title', label);
  btn.innerHTML = icon(glyphName);
  return btn;
}

export function updateStripScrollButton() {
  if (!stripBoxEl) return;
  const collapsible = document.querySelector('.app-shell.workspace-collapsed:not(.workspace-focus)');
  const canUp = stripBoxEl.scrollTop > 1;
  const canDown = stripBoxEl.scrollTop + stripBoxEl.clientHeight < stripBoxEl.scrollHeight - 1;
  if (stripScrollUp) stripScrollUp.classList.toggle('is-visible', Boolean(collapsible && canUp));
  if (stripScrollDown) stripScrollDown.classList.toggle('is-visible', Boolean(collapsible && canDown));
}

// Settings scroll arrows (workspace-strip style): the visible settings pane
// scrolls via up/down buttons instead of a native scrollbar.
export function updateSettingsScrollButtons() {
  const overlay = document.getElementById('settings-overlay');
  const pane = overlay && !overlay.hidden ? overlay.querySelector('.settings-pane:not([hidden])') : null;
  const canUp = !!pane && pane.scrollTop > 1;
  const canDown = !!pane && pane.scrollTop + pane.clientHeight < pane.scrollHeight - 1;
  if (settingsScrollUp) settingsScrollUp.classList.toggle('is-visible', canUp);
  if (settingsScrollDown) settingsScrollDown.classList.toggle('is-visible', canDown);
}

function scrollSettingsPane(dir) {
  const overlay = document.getElementById('settings-overlay');
  const pane = overlay && !overlay.hidden ? overlay.querySelector('.settings-pane:not([hidden])') : null;
  if (!pane) return;
  pane.scrollBy({ top: dir * Math.max(120, pane.clientHeight - 40), behavior: 'smooth' });
  setTimeout(updateSettingsScrollButtons, 250);
}

export function clearTabDropMarks() {
  if (!tabBarEl) return;
  tabBarEl.querySelectorAll('.tab-drop-before, .tab-drop-after').forEach((el) => el.classList.remove('tab-drop-before', 'tab-drop-after'));
}

// Strip scroll buttons: created once and inserted around the strip container.
const stripScrollUp = makeStripScrollButton('strip-scroll-up', 'up', 'chevron-up', 'Scroll up');
const stripScrollDown = makeStripScrollButton('strip-scroll-down', 'down', 'chevron-down', 'Scroll down');
if (stripBoxEl && stripBoxEl.parentElement) {
  stripBoxEl.insertAdjacentElement('beforebegin', stripScrollUp);
  stripBoxEl.insertAdjacentElement('afterend', stripScrollDown);
  stripScrollUp.addEventListener('click', () => {
    stripBoxEl.scrollBy({ top: -stripBoxEl.clientHeight, behavior: 'smooth' });
  });
  stripScrollDown.addEventListener('click', () => {
    stripBoxEl.scrollBy({ top: stripBoxEl.clientHeight, behavior: 'smooth' });
  });
}

// Settings scroll buttons: created once inside the settings modal; the
// visible pane scrolls beneath them. Scroll position refreshes the arrows.
const settingsScrollUp = makeStripScrollButton('settings-scroll-up', 'up', 'chevron-up', 'Scroll up');
const settingsScrollDown = makeStripScrollButton('settings-scroll-down', 'down', 'chevron-down', 'Scroll down');
settingsScrollUp.className = 'settings-scroll-btn settings-scroll-up';
settingsScrollDown.className = 'settings-scroll-btn settings-scroll-down';
{
  const settingsModal = document.querySelector('#settings-overlay .modal-wide');
  if (settingsModal) {
    settingsModal.appendChild(settingsScrollUp);
    settingsModal.appendChild(settingsScrollDown);
  }
  settingsScrollUp.addEventListener('click', () => scrollSettingsPane(-1));
  settingsScrollDown.addEventListener('click', () => scrollSettingsPane(1));
  document.querySelectorAll('#settings-overlay .settings-pane').forEach((pane) => {
    pane.addEventListener('scroll', () => updateSettingsScrollButtons(), { passive: true });
  });
}
