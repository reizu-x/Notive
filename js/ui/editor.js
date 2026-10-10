// js/ui/editor.js — editor-experience helpers: live preview, syntax layer,
// beautify, cover upload/reposition, recipe fields.

import { beautifyBtn, editorToolbar, markdownInput, modeLabel, modeToggle, noteList, preview, syntaxLayer, typeBadge } from '../core/elements.js';
import { renderMarkdown } from '../core/markdown.js';
import { inlineMarkdown } from '../core/markdown.js';
import { COVER_MAX_DIM, EXT_LABELS, cleanCoverSrc, isImageFile, sanitizeIngredients, sanitizeSteps } from '../core/schema.js';
import { escapeHtml } from '../core/strings.js';
import { highlightJson, highlightYaml } from '../core/syntax.js';
import { e2ee, e2eeB64ToBytes, e2eeBytesToB64, e2eeRandomBytes } from '../data/crypto.js';
import { REC_ALPHABET } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { acctRecCacheKey } from './auth.js';
import { showToast } from './modal.js';
import { currentNote } from './notes.js';
import { coverDragNote } from './tabs.js';
import { beautifyJsonText, beautifyYamlText } from '../core/syntax.js';
import { renderCollabPresence } from '../data/collab-crypto.js';
import { IDLE_PREVIEW_MS } from '../domain/constants.js';
import { setSaveLabel } from './feedback.js';
import { activeEditorNote, isPlainTextNote, persistNotes, renderNoteList, saveCurrentNote } from './notes.js';
import { icon } from '../core/icons.js';
import { NOTE_TEMPLATES } from '../domain/constants.js';
import { addNote } from './notes.js';
import { isUnlocked } from './auth.js';
import { updateMeta } from './notes.js';

export function closeRecoverModal() {
  const modal = document.getElementById('recover-modal');
  if (modal) modal.hidden = true;
  state.verifiedRecovery = null;
  const block = document.getElementById('recover-newpw-block');
  if (block) block.hidden = true;
}

// Recover popup: one method per view (email / code / email-link token).
export function openRecoverModal(kind) {
  const blockId = kind === 'email' ? 'recover-email-block'
    : kind === 'token' ? 'recover-token-block' : 'recover-code-block';
  const modal = document.getElementById('recover-modal');
  if (!modal) {
    // Fallback for mixed cached layouts: toggle the form inline.
    ['recover-email-block', 'recover-code-block', 'recover-token-block'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.hidden = id !== blockId;
    });
    return;
  }
  const title = document.getElementById('recover-modal-title');
  // Code flow always restarts at the verify view; a verified match swaps the
  // popup to the new-password view (see verify handler).
  if (kind === 'code') {
    const vv = document.getElementById('recover-verify-view');
    if (vv) vv.hidden = false;
    const np = document.getElementById('recover-newpw-block');
    if (np) np.hidden = true;
    if (title) title.textContent = 'Recover with code';
  } else if (title) title.textContent = kind === 'email' ? 'Recover with email'
    : kind === 'token' ? 'Set a new password' : 'Recover with code';
  ['recover-email-block', 'recover-code-block', 'recover-token-block'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
  const show = document.getElementById(blockId);
  if (show) show.hidden = false;
  modal.hidden = false;
}

export function clearRecoveryCodesLocal() {
  try {
    const key = acctRecCacheKey();
    if (key) localStorage.removeItem(key);
  } catch (error) {}
}

export async function loadRecoveryCodesLocal() {
  if (!e2ee.masterKey) return null;
  const key = acctRecCacheKey();
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const plain = await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: e2eeB64ToBytes(obj.iv) }, e2ee.masterKey, e2eeB64ToBytes(obj.data));
    const codes = JSON.parse(new TextDecoder().decode(plain));
    return Array.isArray(codes) && codes.length ? codes : null;
  } catch (error) {
    return null;
  }
}

export async function saveRecoveryCodesLocal(codes) {
  if (!e2ee.masterKey) return;
  const key = acctRecCacheKey();
  if (!key) return;
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, e2ee.masterKey, new TextEncoder().encode(JSON.stringify(codes)));
  try {
    localStorage.setItem(key, JSON.stringify({ iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) }));
  } catch (error) {}
}

export function newRecoveryCode() {
  const bytes = e2eeRandomBytes(20);
  let s = '';
  for (let i = 0; i < 20; i += 1) s += REC_ALPHABET[bytes[i] % REC_ALPHABET.length];
  return `${s.slice(0, 5)}-${s.slice(5, 10)}-${s.slice(10, 15)}-${s.slice(15, 20)}`;
}

// F-23: KEK from the PRF output via HKDF with a per-credential salt, not a
// bare SHA-256. Adds domain separation so two credentials of one account no
// longer share a KEK, and hardens against low-entropy PRF input.
async function prfKekRawHKDF(prfSecretBytes, credentialIdB64) {
  const base = await window.crypto.subtle.importKey('raw', prfSecretBytes, 'HKDF', false, ['deriveBits']);
  const bits = await window.crypto.subtle.deriveBits(
    {
      name: 'HKDF', hash: 'SHA-256',
      salt: new TextEncoder().encode('notive-prf-kek-v1:' + String(credentialIdB64 || '')),
      info: new TextEncoder().encode('notive master-key KEK'),
    }, base, 256);
  return new Uint8Array(bits);
}

function prfKekRawLegacy(prfSecretBytes) {
  return window.crypto.subtle.digest('SHA-256', prfSecretBytes);
}

export async function prfWrapMasterKey(prfSecretBytes, credentialIdB64, masterKeyRaw) {
  const kekRaw = await prfKekRawHKDF(prfSecretBytes, credentialIdB64);
  const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, masterKeyRaw);
  return { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) };
}

// --- Passkeys (option-1 login factor; password still unlocks E2EE notes) ---
// PRF passwordless unlock. Dual-read: try per-credential HKDF first, then
// fall back to the legacy SHA-256 KEK for wraps created before this change.
export async function prfUnwrapMasterKey(prfSecretBytes, credentialIdB64, wrapped) {
  const attempts = [await prfKekRawHKDF(prfSecretBytes, credentialIdB64), await prfKekRawLegacy(prfSecretBytes)];
  let lastError = null;
  for (const kekRaw of attempts) {
    try {
      const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      const raw = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapped.iv) }, kek, e2eeB64ToBytes(wrapped.data));
      return window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
    } catch (error) { lastError = error; }
  }
  throw (lastError || new Error('prf-unwrap'));
}

export function moveCoverOnNote(clientY) {
  const note = coverDragNote();
  const wrap = document.getElementById('cover-wrap');
  const badge = document.getElementById('cover-pos');
  if (!note || !wrap) return;
  const rect = wrap.getBoundingClientRect();
  const ratio = rect.height > 0 ? (clientY - rect.top) / rect.height : 0.5;
  note.coverPos = Math.min(100, Math.max(0, Math.round(ratio * 100)));
  const img = document.getElementById('cover-img');
  if (img) img.style.objectPosition = `50% ${note.coverPos}%`;
  if (badge) {
    badge.hidden = false;
    badge.textContent = `${note.coverPos}%`;
  }
}

export function enterCoverRepos() {
  const note = canEditCoverNote();
  if (!note || state.coverRepositioning) return;
  state.coverRepositioning = true;
  state.coverReposStart = coverFocalPos(note);
  setCoverReposUI();
  showToast('Drag the cover to reposition — Done to lock');
}

export function setCoverReposUI() {
  const wrap = document.getElementById('cover-wrap');
  const badge = document.getElementById('cover-pos');
  const reposBtn = document.getElementById('cover-repos');
  const doneBtn = document.getElementById('cover-done');
  const changeBtn = document.getElementById('cover-change');
  const removeBtn = document.getElementById('cover-remove');
  if (wrap) wrap.classList.toggle('repositioning', state.coverRepositioning);
  if (reposBtn) reposBtn.hidden = state.coverRepositioning;
  if (doneBtn) doneBtn.hidden = !state.coverRepositioning;
  if (changeBtn) changeBtn.hidden = state.coverRepositioning;
  if (removeBtn) removeBtn.hidden = state.coverRepositioning;
  if (badge) {
    if (state.coverRepositioning) {
      const note = currentNote();
      badge.hidden = false;
      badge.textContent = `${note ? coverFocalPos(note) : 50}%`;
    } else {
      badge.hidden = true;
    }
  }
}

export function canEditCoverNote() {
  const note = currentNote();
  if (!note || state.activeView === 'vault' || !isUnlocked() || note.deleted || note.archived) return null;
  if (!cleanCoverSrc(note.cover)) return null;
  return note;
}

export async function handleCollabCoverFile(file) {
  if (!state.collab.noteId || !state.collab.assets) return;
  if (!file) return;
  if (!isImageFile(file)) { showToast('Use a PNG, JPEG, WebP, GIF, AVIF or BMP image'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('Image too large (5 MB max)'); return; }
  const wasOptimized = file.size > 300000;
  showToast('Loading picture…');
  try {
    const raw = await readFileAsDataUrl(file);
    const dataUrl = wasOptimized ? await downscaleCover(raw) : raw;
    const clean = cleanCoverSrc(dataUrl) || (!wasOptimized ? await downscaleCover(raw).then(cleanCoverSrc) : null);
    if (!clean) { showToast('Could not use that image — try a smaller file'); return; }
    if (!state.collab.noteId || !state.collab.assets) return; // moved on mid-upload
    state.collab.assets.set('cover', clean);
    state.collab.cover = clean;
    renderRecipeHero(null);
    showToast(wasOptimized ? 'Meal photo added (optimized)' : 'Meal photo added');
  } catch (error) {
    showToast('Could not read that image');
  }
}

// Downscale to a JPEG banner (max 1200px side, quality 0.82).
export function downscaleCover(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('decode'));
    img.onload = () => {
      try {
        const naturalW = img.naturalWidth || 800;
        const naturalH = img.naturalHeight || 600;
        const scale = Math.min(1, COVER_MAX_DIM / Math.max(naturalW, naturalH));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(naturalW * scale));
        canvas.height = Math.max(1, Math.round(naturalH * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) { reject(new Error('canvas')); return; }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob((blob) => {
          if (!blob) { reject(new Error('encode')); return; }
          readFileAsDataUrl(blob).then(resolve, reject);
        }, 'image/jpeg', 0.82);
      } catch (error) { reject(error); }
    };
    img.src = dataUrl;
  });
}

export function focusRecipeField(selector, index) {
  const fields = document.querySelectorAll(`.recipe-body-fixed ${selector}`);
  if (!fields.length) return;
  const at = (index === 'last') ? fields.length - 1 : Math.max(0, Math.min(fields.length - 1, Number(index) || 0));
  const el = fields[at];
  if (!el) return;
  el.focus();
  if (typeof el.setSelectionRange === 'function') {
    const n = el.value.length;
    try { el.setSelectionRange(n, n); } catch (error) {}
  }
}

export function renderRecipeBody(note) {
  const wrap = document.getElementById('recipe-body');
  const panel = document.querySelector('.editor-panel');
  if (!wrap) return;
  const target = note || (state.collab.noteId ? null : currentNote());
  const isRecipe = state.activeView !== 'vault' && (state.collab.noteId ? state.collab.template === 'recipe' : Boolean(target && target.template === 'recipe'));
  if (panel) panel.classList.toggle('recipe-mode', isRecipe);
  wrap.hidden = !isRecipe;
  if (!isRecipe) return;
  const data = recipeDataForActive(target);
  renderRecipeIngredients(data.ingredients);
  renderRecipeSteps(data.steps);
}

export function renderRecipeSteps(list) {
  const box = document.getElementById('recipe-steps');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<p class="recipe-empty">No steps yet.</p>'; return; }
  box.innerHTML = list.map((step, i) => `
    <div class="recipe-row">
      <span class="recipe-num">${i + 1}.</span>
      <textarea class="recipe-input" data-recipe-step="${i}" rows="1" placeholder="Describe this step" aria-label="Step ${i + 1}">${escapeHtml(step)}</textarea>
      <button type="button" class="recipe-remove" data-recipe-remove-step="${i}" aria-label="Remove step">&times;</button>
    </div>`).join('');
  box.querySelectorAll('textarea').forEach((area) => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; });
}

export function renderRecipeIngredients(list) {
  const box = document.getElementById('recipe-ingredients');
  if (!box) return;
  if (!list.length) { box.innerHTML = '<p class="recipe-empty">No ingredients yet.</p>'; return; }
  box.innerHTML = list.map((item, i) => `
    <div class="recipe-row">
      <button type="button" class="recipe-check${item.d ? ' checked' : ''}" data-recipe-toggle="${i}" role="checkbox" aria-checked="${item.d ? 'true' : 'false'}" aria-label="Toggle ingredient"></button>
      <textarea class="recipe-input" data-recipe-ing="${i}" rows="1" placeholder="Ingredient" aria-label="Ingredient">${escapeHtml(item.t)}</textarea>
      <button type="button" class="recipe-remove" data-recipe-remove-ing="${i}" aria-label="Remove ingredient">&times;</button>
    </div>`).join('');
  box.querySelectorAll('textarea').forEach((area) => { area.style.height = 'auto'; area.style.height = `${area.scrollHeight}px`; });
}

// ---- Structured recipe body (Ingredients / Method) -----------------------
// Recipe notes never show their Markdown body; instead these editable fields
// are rendered as a two-column table. Local recipes store the lists on the
// note; shared recipes keep them in a Y.Map('recipe') in the collaborative doc.
export function recipeDataForActive(note) {
  if (state.collab.noteId) {
    const data = { ingredients: [], steps: [] };
    if (!state.collab.recipe) return data;
    try { data.ingredients = sanitizeIngredients(JSON.parse(state.collab.recipe.get('ingredients') || '[]')); } catch (error) {}
    try { data.steps = sanitizeSteps(JSON.parse(state.collab.recipe.get('steps') || '[]')); } catch (error) {}
    return data;
  }
  if (note && note.template === 'recipe') {
    return { ingredients: sanitizeIngredients(note.ingredients), steps: sanitizeSteps(note.steps) };
  }
  return { ingredients: [], steps: [] };
}

// Fixed recipe hero (meal photo + description) between the meta row and the
// writing area. Editor chrome, not body text, so it cannot be deleted. The
// photo reuses the note cover (same picker, validation and E2EE storage);
// the src is re-validated on every render and assigned as a property.
export function renderRecipeHero(note) {
  const hero = document.getElementById('recipe-hero');
  if (!hero) return;
  // A shared recipe note keeps its meal photo (Y.Map 'assets') and description
  // (Y.Text 'desc') in the collaborative doc; a local note uses its own fields.
  let template;
  let cover;
  let description;
  if (state.collab.noteId) {
    template = state.collab.template;
    cover = state.collab.cover;
    description = state.collab.desc ? state.collab.desc.toString() : '';
  } else {
    template = note && note.template;
    cover = note && note.cover;
    description = note && note.description;
  }
  const show = Boolean(template === 'recipe' && state.activeView !== 'vault');
  hero.hidden = !show;
  if (!show) { renderRecipeBody(note); return; }
  const usable = cleanCoverSrc(cover);
  const img = document.getElementById('recipe-photo-img');
  const empty = document.getElementById('recipe-photo-empty');
  if (img) {
    if (usable) {
      if (img.getAttribute('src') !== usable) img.setAttribute('src', usable);
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }
  if (empty) empty.hidden = Boolean(usable);
  const descEl = document.getElementById('recipe-desc');
  if (descEl) {
    const next = typeof description === 'string' ? description : '';
    if (document.activeElement !== descEl && descEl.value !== next) descEl.value = next;
  }
  renderRecipeBody(note);
}

// Paint the cover banner for the open note (null hides it). The src is
// re-validated on every render and assigned as a property, never via HTML.
export function renderCover(note) {
  const wrap = document.getElementById('cover-wrap');
  const img = document.getElementById('cover-img');
  const addBtn = document.getElementById('cover-add');
  if (!wrap || !img) return;
  // Cover pictures are retired for per-account standard notes — the Add
  // cover button and the banner never show. Shared (collab) notes keep
  // their cover flows; recipe notes show the photo in the fixed hero.
  const collabOpen = Boolean(state.collab.noteId);
  const usable = collabOpen && note && state.activeView !== 'vault' ? cleanCoverSrc(note.cover) : null;
  // Recipe notes show the photo in the fixed hero below the meta row instead
  // of the banner above the title.
  const bannerUsable = usable && !(note && note.template === 'recipe');
  const heading = document.querySelector('.editor-heading');
  if (heading) heading.classList.toggle('has-cover', Boolean(bannerUsable));
  if (bannerUsable) {
    if (img.getAttribute('src') !== usable) img.setAttribute('src', usable);
    img.style.objectPosition = `50% ${coverFocalPos(note)}%`;
    wrap.hidden = false;
    if (addBtn) setCoverAddHidden(true);
  } else {
    wrap.hidden = true;
    img.removeAttribute('src');
    if (addBtn) {
      if (!collabOpen) { setCoverAddHidden(true); }
      else {
        const editable = Boolean(note) && state.activeView !== 'vault' && isUnlocked()
          && !note.deleted && !note.archived;
        // Recipe notes add their photo from the fixed hero, never the banner row.
        setCoverAddHidden(!editable || (note && note.template === 'recipe'));
      }
    }
  }
  renderRecipeHero(note);
}

// The Add-cover row lives under the topbar line; hiding the button must
// hide the row too, or its margin leaves a gap.
export function setCoverAddHidden(hide) {
  const addBtn = document.getElementById('cover-add');
  if (addBtn) addBtn.hidden = hide;
  const row = document.querySelector('.cover-add-row');
  if (row) row.style.display = hide ? 'none' : '';
}

// ---- Note cover pictures ------------------------------------------------
// Covers ride on the note (inside the E2EE envelope) as validated data URLs.
export function coverFocalPos(note) {
  if (note && typeof note.coverPos === 'number' && Number.isFinite(note.coverPos)) {
    return Math.min(100, Math.max(0, note.coverPos));
  }
  return 50;
}

// Swap the writing area between Markdown source and rendered preview; non-Markdown notes never preview.
export function renderPreview(note) {
  if (state.collab.noteId && state.collab.body) {
    note = { id: state.collab.noteId, title: state.collab.title ? state.collab.title.toString() : '',
             body: state.collab.body.toString(), ext: 'md', tags: [], favorite: false,
             archived: false, deleted: false, template: state.collab.template || '' };
  }
  if (!note) return;
  const bottomHint = document.querySelector('.editor-bottom-fixed span:first-child');
  const isMd = note.ext === 'md';
  // Detect template: explicit field > hidden tag (legacy notes). The To-Do
  // rendered template is retired: any legacy todo note or todo tag degrades
  // to a standard Markdown note — its `- [x]` checkboxes stay clickable
  // through the textarea checkbox overlay.
  const tags = Array.isArray(note.tags) ? note.tags : [];
  const body = typeof note.body === 'string' ? note.body : '';
  const template = (note.template || (tags.includes('_recipe') ? 'recipe' : '')) === 'recipe' ? 'recipe' : '';
  const plainLabel = note.ext === 'txt' ? 'Plain text' : (EXT_LABELS[note.ext] || 'MD');
  const showPreview = isMd && state.writeMode === 'preview' && template !== 'recipe';
  try { modeLabel.closest('.write-head').hidden = false; } catch (error) {}

  if (showPreview) {
    preview.innerHTML = renderMarkdown(note.body);
    // Render mermaid diagrams if the library is loaded
    try {
      if (window.mermaid && preview.querySelector('.mermaid')) {
        window.mermaid.run({ nodes: preview.querySelectorAll('.mermaid') });
      }
    } catch (error) {}
  }
  markdownInput.hidden = showPreview;
  preview.hidden = !showPreview;
  if (modeLabel) modeLabel.textContent = isMd ? (showPreview ? 'Preview' : 'Write') : plainLabel;
  // Preview toggle: standard Markdown notes and recipes (recipe has its own
  // structured body, so Write/Preview stays hidden there).
  const showLivePreview = isMd && (!template || template === 'recipe');
  if (modeToggle) {
    modeToggle.hidden = !showLivePreview;
    modeToggle.textContent = showPreview ? 'Write' : 'Preview';
  }
  if (bottomHint) bottomHint.textContent = isMd ? 'Markdown' : plainLabel;
  if (typeBadge) typeBadge.textContent = EXT_LABELS[note.ext] || 'MD';
  if (beautifyBtn) beautifyBtn.hidden = !(note.ext === 'json' || note.ext === 'yaml');
  // Formatting toolbar: every markdown note gets it (recipe notes use the
  // structured body instead, so their source toolbar stays hidden).
  if (editorToolbar) editorToolbar.hidden = !(isMd && template !== 'recipe');
  if (!showPreview) autogrow();
  updateSyntaxLayer(note, showPreview);
}

const TASK_RE = /^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/;

// ---- Preview task toggles: the rendered `li.task` boxes ARE the checkboxes --
// Clicking one flips its `- [ ]`/`- [x]` marker in the note body and
// re-renders the preview. Write mode stays pure Markdown text — no painted
// overlay, no font-metric alignment.

export function togglePreviewTask(li) {
  const note = activeEditorNote();
  if (!note || !li) { showToast('Log in to edit notes'); return; }
  // Which rendered task is this? Count its position among ALL preview tasks.
  const all = [...preview.querySelectorAll('li.task')];
  const index = all.indexOf(li);
  if (index === -1) return;
  const lines = String(note.body || '').split('\n');
  let seen = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(TASK_RE);
    if (!m) continue;
    seen += 1;
    if (seen !== index) continue;
    const checked = m[2].toLowerCase() === 'x';
    lines[i] = `${m[1]}- [${checked ? ' ' : 'x'}] ${m[3]}`;
    note.body = lines.join('\n');
    markdownInput.value = note.body;
    note.date = 'Now';
    note.updatedAt = Date.now();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 450);
    renderPreview(note);
    return;
  }
  showToast('Task not found in this note');
}

export function initPreviewTaskToggles() {
  if (!preview || preview.dataset.taskToggles === '1') return;
  preview.dataset.taskToggles = '1';
  // Capture phase: the generic "click preview -> back to Write" handler is
  // bound earlier in the bubble phase and re-renders the panel synchronously
  // (detaching the clicked li before this listener could read it). Running
  // first in capture keeps the toggle working. The focus listener is fed by
  // mousedown's default focus behavior — preventing that stops the panel
  // from bouncing back to Write before the click lands.
  preview.addEventListener('mousedown', (event) => {
    if (event.target.closest('li.task')) event.preventDefault();
  }, true);
  preview.addEventListener('click', (event) => {
    const li = event.target.closest('li.task');
    if (!li) return;
    event.stopPropagation();
    event.preventDefault();
    togglePreviewTask(li);
  }, true);
}

// Paint (or clear) the overlay for the open note. Only JSON/YAML are colored.
export function updateSyntaxLayer(note, showPreview) {
  if (!syntaxLayer) return;
  const ext = note && note.ext;
  const lang = ext === 'json' ? 'json' : (ext === 'yaml' ? 'yaml' : null);
  if (!lang || showPreview) {
    syntaxLayer.hidden = true;
    syntaxLayer.innerHTML = '';
    markdownInput.classList.remove('is-highlighted');
    return;
  }
  const source = typeof note.body === 'string' ? note.body : markdownInput.value;
  const html = lang === 'json' ? highlightJson(source) : highlightYaml(source);
  syntaxLayer.className = `syntax-layer lang-${lang}`;
  // Trailing newline keeps the last line's height in sync with the textarea.
  syntaxLayer.innerHTML = `${html}\n`;
  syntaxLayer.hidden = false;
  markdownInput.classList.add('is-highlighted');
}

// Resize the Markdown textarea to its content (skipped in preview mode).
export function autogrow() {
  if (markdownInput.hidden) return;
  markdownInput.style.height = 'auto';
  markdownInput.style.height = `${markdownInput.scrollHeight}px`;
}

// Restore a binned folder: drops its Bin entry and unbans (undeletes) all its notes, then re-syncs the sidebar.
// Erase a binned folder and all its binned notes at once; repairs the current selection.
// Find a sidebar row by exact dataset value (avoids CSS-escaping pitfalls of quoted selectors).
// Find an All-Notes folder group by exact dataset value (avoids CSS-escaping pitfalls).
export function findTreeWrap(folder) {
  return [...noteList.querySelectorAll('[data-folder-wrap]')].find((wrap) => wrap.dataset.folderWrap === folder) || null;
}



// Focus the editor without the browser scrolling the caret into view
// (toolbar clicks used to yank the whole writing area upward).
function focusEditor() {
  try { markdownInput.focus({ preventScroll: true }); }
  catch (error) { markdownInput.focus(); }
}

// Run a text edit while pinning the scroll container in place: caret updates
// (setRangeText / setSelectionRange) make the browser scroll the caret into
// view, which jumps the pane back to the caret — undo that in the same tick.
function withScrollLocked(fn) {
  const sc = markdownInput.closest('.editor-scroll') || document.querySelector('.editor-scroll');
  const top = sc ? sc.scrollTop : 0;
  fn();
  if (sc) sc.scrollTop = top;
}

// Insert a Markdown line prefix (heading/list/quote) at the start of the current line and save.
export function linePrefix(prefix) {  withScrollLocked(() => {

    if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
    if (isPlainTextNote()) { showToast('Formatting needs a Markdown note'); return; }
    const start = markdownInput.selectionStart;
    const lineStart = markdownInput.value.lastIndexOf('\n', start - 1) + 1;
    markdownInput.setRangeText(prefix, lineStart, lineStart, 'end');
    focusEditor();
    saveCurrentNote();
  });
}
// Cycle the current line's heading level: none → H1 → H2 → … → H6 → none.
// Replaces whatever "#" prefix the line already has, so a single button
// walks through the Markdown heading scale.
export function cycleHeading() {  withScrollLocked(() => {

    if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
    if (isPlainTextNote()) { showToast('Formatting needs a Markdown note'); return; }
    const value = markdownInput.value;
    const start = markdownInput.selectionStart;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', start);
    if (lineEnd === -1) lineEnd = value.length;
    const line = value.slice(lineStart, lineEnd);
    const at = (line.match(/^#+(?=\s|$)/) || [''])[0].length;
    const nextLevel = { 0: 1, 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 0 }[at] ?? 0;
    const body = line.slice(at === 0 ? 0 : at).replace(/^\s+/, '') || line.slice(at) || line.trim();
    const replaced = nextLevel === 0 ? body : `${'#'.repeat(nextLevel)} ${body}`;
    markdownInput.setRangeText(replaced, lineStart, lineEnd, 'end');
    focusEditor();
    saveCurrentNote();
  });
}
// Indent / outdent the current line or selection (shared with the Tab key
// path; exported so the toolbar can drive the same behavior).
export function indentSelection(outdent) {
  withScrollLocked(() => {
    if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
    if (isPlainTextNote()) { showToast('Formatting needs a Markdown note'); return; }
    const value = markdownInput.value;
    const start = markdownInput.selectionStart;
    const end = markdownInput.selectionEnd;
    const multiline = value.slice(start, end).includes('\n');
    if (!multiline && !outdent && start === end) {
      // Caret collapse (no selection): plain two-space insert, like the Tab key.
      markdownInput.setRangeText('  ', start, end, 'end');
      focusEditor();
      saveCurrentNote();
      return;
    }
    const blockStart = start === 0 ? 0 : value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    const lines = value.slice(blockStart, lineEnd).split('\n');
    const mapped = outdent
      ? lines.map((l) => l.replace(/^\t/, '').replace(/^ {1,2}/, ''))
      : lines.map((l) => '  ' + l);
    const replacement = mapped.join('\n');
    markdownInput.setRangeText(replacement, blockStart, lineEnd, 'end');
    markdownInput.setSelectionRange(blockStart, blockStart + replacement.length);
    focusEditor();
    saveCurrentNote();
  });
}
// Fence the selection (or an empty block) as a Markdown code block.
export function codeBlockSelection(lang = '') {
  withScrollLocked(() => {
    if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
    const start = markdownInput.selectionStart;
    const end = markdownInput.selectionEnd;
    const selected = markdownInput.value.slice(start, end);
    fenceSelection(lang, selected);
    focusEditor();
    saveCurrentNote();
  });
}
function fenceSelection(lang, selected) {
  const pad = (needs) => (needs ? '\n' : '');
  const before = markdownInput.value.slice(0, markdownInput.selectionStart);
  const needsLead = before && !before.endsWith('\n') ? '\n' : '';
  const body = selected || 'code';
  markdownInput.setRangeText(
    `${needsLead}\`\`\`${lang}\n${body}\n\`\`\`\n`,
    markdownInput.selectionStart, markdownInput.selectionEnd, 'end');
}

// Hard line break for the Markdown Guide "line break" syntax (two trailing
// spaces) — inserts the marker + newline at the caret.
export function insertLineBreak() {
  withScrollLocked(() => {
    if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
    markdownInput.setRangeText('  \n', markdownInput.selectionStart, markdownInput.selectionEnd, 'end');
    focusEditor();
    saveCurrentNote();
  });
}
// Insert a GFM table skeleton sized by [rows, cols].
export function insertTable(rows = 2, cols = 2) {  withScrollLocked(() => {

    if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
    const header = `| ${Array.from({ length: cols }, (_, i) => `Col ${i + 1}`).join(' | ')} |`;
    const align = `| ${Array.from({ length: cols }, () => '---').join(' | ')} |`;
    const body = Array.from({ length: rows }, () => `| ${Array.from({ length: cols }, () => '').join(' | ')} |`).join('\n');
    const start = markdownInput.selectionStart;
    const before = markdownInput.value.slice(0, start);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    markdownInput.setRangeText(`${lead}${header}\n${align}\n${body}\n`, start, markdownInput.selectionEnd, 'end');
    focusEditor();
    saveCurrentNote();
  });
}
// Insert a horizontal rule on its own line.
export function insertHr() {
  withScrollLocked(() => {
    if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
    const start = markdownInput.selectionStart;
    const before = markdownInput.value.slice(0, start);
    const lead = before && !before.endsWith('\n') ? '\n' : '';
    markdownInput.setRangeText(`${lead}---\n`, start, markdownInput.selectionEnd, 'end');
    focusEditor();
    saveCurrentNote();
  });
}
// Wrap the editor selection (or placeholder word) with a Markdown marker and save.
export function wrapSelection(before, after = before) {
  withScrollLocked(() => {
    if (!state.cachedProfile || !e2ee.masterKey) { showToast('Log in to edit notes'); return; }
    if (isPlainTextNote()) { showToast('Formatting needs a Markdown note'); return; }
    const start = markdownInput.selectionStart;
    const end = markdownInput.selectionEnd;
    const selected = markdownInput.value.slice(start, end) || 'text';
    markdownInput.setRangeText(`${before}${selected}${after}`, start, end, 'select');
    focusEditor();
    saveCurrentNote();
  });
}
// Tab in the Markdown editor indents instead of leaving the textarea.
// Tab — insert two spaces at the caret; with a selection, indent every line.
// Shift+Tab — remove up to two spaces (or one tab) from the line start.
// Each step ends with a save so the note syncs like a normal edit.
const MD_INDENT_UNIT = '  ';

function markdownIndent(outdent) {
  withScrollLocked(() => {
    const value = markdownInput.value;
    const start = markdownInput.selectionStart;
    const end = markdownInput.selectionEnd;
    const multiline = value.slice(start, end).includes('\n');
    if (!outdent && start === end && !multiline) {
      markdownInput.setRangeText(MD_INDENT_UNIT, start, end, 'end');
      markdownInput.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;
    const mapped = value.slice(lineStart, lineEnd).split('\n').map((line) =>
      outdent ? line.replace(/^\t/, '').replace(/^ {1,2}/, '') : MD_INDENT_UNIT + line);
    const replacement = mapped.join('\n');
    markdownInput.setRangeText(replacement, lineStart, lineEnd, 'end');
    markdownInput.setSelectionRange(lineStart + replacement.length, lineStart + replacement.length);
    markdownInput.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
export function initMarkdownTabbing() {
  if (!markdownInput || markdownInput.dataset.tabbing === '1') return;
  markdownInput.dataset.tabbing = '1';
  markdownInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Tab' || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    markdownIndent(event.shiftKey);
  });
}

// "More Markdown" dropdown on the formatting toolbar: toggles the panel,
// closes on outside click / Escape; the menu buttons reuse the shared
// [data-action] handlers above the trick no separate wiring needed.
export function initToolbarMenu() {
  const btn = document.getElementById('toolbar-more-btn');
  const menu = document.getElementById('toolbar-menu');
  if (!btn || !menu || btn.dataset.menu === '1') return;
  btn.dataset.menu = '1';
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.addEventListener('click', (event) => {
    event.stopPropagation();
    const open = menu.hidden;
    menu.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (event) => {
    if (menu.hidden) return;
    if (event.target.closest('#toolbar-more')) return;
    close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      close();
      btn.focus();
    }
  });
  // Any menu action closes the dropdown after its edit runs.
  menu.addEventListener('click', close);
}

// Switch write/preview mode and refocus the editor when returning to edit.
export function setWriteMode(mode, { focus = false } = {}) {
  state.writeMode = mode;
  clearTimeout(state.idleTimer);
  renderPreview(activeEditorNote());
  try { renderCollabPresence(); } catch (error) {}
  if (mode === 'edit') {
    resetIdleTimer();
    if (focus) {
      // Focus without jumping the caret to the end: setSelectionRange(end)
      // used to scroll the whole editor to the bottom on every Write click.
      try { markdownInput.focus({ preventScroll: true }); }
      catch (error) { focusEditor(); }
    }
  }
}

// After 10s idle, auto-switch a non-empty Markdown note to preview.
export function resetIdleTimer() {
  clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    const note = currentNote();
    if (note && note.ext === 'md' && state.writeMode === 'edit' && markdownInput.value.trim()) {
      setWriteMode('preview');
    }
  }, IDLE_PREVIEW_MS);
}

export function removeCover() {
  exitCoverRepos(false);
  const note = currentNote();
  if (!note || state.activeView === 'vault' || !isUnlocked() || note.deleted || note.archived) return;
  if (!note.cover) return;
  note.cover = null;
  note.coverPos = null;
  note.date = 'Now';
  renderCover(note);
  persistNotes();
  showToast('Cover removed');
}

// Leave reposition mode; save persists the staged position, cancel restores it.
export function exitCoverRepos(save) {
  if (!state.coverRepositioning) return;
  state.coverRepositioning = false;
  state.coverDragging = false;
  const wrap = document.getElementById('cover-wrap');
  if (wrap) wrap.classList.remove('dragging');
  const note = currentNote();
  if (save && note && note.cover) {
    note.date = 'Now';
    if (state.currentId === note.id) renderCover(note);
    persistNotes();
    showToast('Cover position locked');
  } else if (!save && note && note.cover) {
    note.coverPos = state.coverReposStart;
    if (state.currentId === note.id) renderCover(note);
  }
  setCoverReposUI();
}

// Shared recipe notes keep their meal photo in the collaborative doc
// (Y.Map 'assets'), so every member sees the same picture.
export function requestCollabCoverUpload() {
  exitCoverRepos(true);
  if (!state.collab.noteId || !isUnlocked()) return;
  const input = document.getElementById('cover-input');
  if (input) { input.value = ''; input.click(); }
}

export async function handleCoverFile(file) {
  const note = currentNote();
  if (!note || state.activeView === 'vault' || !isUnlocked() || note.deleted || note.archived) return;
  if (!file) return;
  if (!isImageFile(file)) { showToast('Use a PNG, JPEG, WebP, GIF, AVIF or BMP image'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('Image too large (5 MB max)'); return; }
  const wasOptimized = file.size > 300000;
  showToast('Loading picture…');
  try {
    const raw = await readFileAsDataUrl(file);
    const dataUrl = wasOptimized ? await downscaleCover(raw) : raw;
    const clean = cleanCoverSrc(dataUrl) || (!wasOptimized ? await downscaleCover(raw).then(cleanCoverSrc) : null);
    if (!clean) { showToast('Could not use that image — try a smaller file'); return; }
    if (!currentNote() || currentNote().id !== note.id) return; // moved on mid-upload
    note.cover = clean;
    if (typeof note.coverPos !== 'number' || !Number.isFinite(note.coverPos)) note.coverPos = 50;
    note.date = 'Now';
    renderCover(note);
    persistNotes();
    showToast(wasOptimized ? 'Cover added (optimized) — Reposition to adjust' : 'Cover added — Reposition to adjust');
  } catch (error) {
    showToast('Could not read that image');
  }
}

export function requestCoverUpload() {
  exitCoverRepos(true);
  const note = currentNote();
  if (state.activeView === 'vault') return;
  if (!note) { showToast('Open a note first'); return; }
  if (!isUnlocked()) { showToast('Log in to edit notes'); return; }
  if (note.deleted) { showToast('Restore this note to edit it'); return; }
  if (note.archived) { showToast('Unarchive this note to edit it'); return; }
  const input = document.getElementById('cover-input');
  if (input) { input.value = ''; input.click(); }
}

// Edit the recipe lists for whichever source is open (local note or shared doc).
export function recipeMutate(mutator) {
  if (state.collab.noteId) {
    if (!state.collab.recipe) return;
    const data = recipeDataForActive(null);
    mutator(data);
    state.collab.recipe.set('ingredients', JSON.stringify(sanitizeIngredients(data.ingredients)));
    state.collab.recipe.set('steps', JSON.stringify(sanitizeSteps(data.steps)));
    return;
  }
  const note = currentNote();
  if (!note || note.template !== 'recipe') return;
  const data = { ingredients: sanitizeIngredients(note.ingredients), steps: sanitizeSteps(note.steps) };
  mutator(data);
  note.ingredients = sanitizeIngredients(data.ingredients);
  note.steps = sanitizeSteps(data.steps);
  note.date = 'Now';
  note.updatedAt = Date.now();
  persistNotes();
}

// Apply the formatter to the open note (button is visible for json/yaml only).
export function applyBeautify() {
  const note = activeEditorNote();
  if (!note || note.deleted || note.archived) return;
  if (note.ext !== 'json' && note.ext !== 'yaml') return;
  const source = typeof markdownInput.value === 'string' && markdownInput.value ? markdownInput.value : (note.body || '');
  let formatted;
  try {
    formatted = note.ext === 'json' ? beautifyJsonText(source) : beautifyYamlText(source);
  } catch (error) {
    showToast(note.ext === 'json' ? 'Invalid JSON — fix the syntax first' : 'Could not format this YAML');
    return;
  }
  if (formatted === source) { showToast('Already tidy'); return; }
  note.body = formatted;
  markdownInput.value = formatted;
  renderPreview(note);
  updateMeta(note);
  setSaveLabel('Saving...', 'green');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => { persistNotes(); renderNoteList(); }, 200);
  showToast(`${note.ext === 'json' ? 'JSON' : 'YAML'} beautified`);
}


// Hide the template chooser popup.
export function closeTemplatePicker() {
  state.vaultTemplatePending = false;
  state.pendingSharedTemplate = null;
  const overlay = document.getElementById('template-overlay');
  if (overlay) overlay.hidden = true;
}

// Single source of truth for the New-note chooser, shared by All Notes and the
// Shared view so the two pickers are always identical.
export function renderTemplateOptions() {
  const box = document.getElementById('template-options');
  if (!box) return;
  box.innerHTML = Object.keys(NOTE_TEMPLATES).map((key) => {
    const template = NOTE_TEMPLATES[key];
    const label = template.label || template.caption || key;
    return `<button class="template-option template-square" data-template="${escapeHtml(key)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
        <span class="template-icon">${icon(template.icon || 'file-text')}</span>
        <span class="template-caption">${escapeHtml(template.caption || key)}</span>
      </button>`;
  }).join('');
}

// De-duplicate a note title (case-insensitive) by appending a counter.
// Binned notes don't squat names — only live ones count.
export function uniqueTitle(base) {
  const clean = (typeof base === 'string' ? base : 'Untitled note').trim().slice(0, 180) || 'Untitled note';
  const taken = new Set(state.notes.filter((note) => !note.deleted).map((note) => String(note.title || '').toLowerCase()));
  if (!taken.has(clean.toLowerCase())) return clean;
  let counter = 2;
  while (taken.has(`${clean} ${counter}`.toLowerCase())) counter += 1;
  return `${clean} ${counter}`;
}

export function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read'));
    reader.onload = () => resolve(String(reader.result || ''));
    reader.readAsDataURL(file);
  });
}

// Show the New-note template chooser popup.
export function openTemplatePicker() {
  const overlay = document.getElementById('template-overlay');
  if (!overlay) { addNote(); return; }
  renderTemplateOptions();
  overlay.hidden = false;
  const first = overlay.querySelector('.template-option');
  if (first) first.focus();
}
