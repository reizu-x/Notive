// js/ui/editor.js — editor-experience helpers: live preview, syntax layer,
// beautify, cover upload/reposition, recipe fields.

import { beautifyBtn, editorToolbar, markdownInput, modeLabel, modeToggle, noteList, preview, syntaxLayer, typeBadge } from '../core/elements.js';
import { renderMarkdown } from '../core/markdown.js';
import { COVER_MAX_DIM, EXT_LABELS, cleanCoverSrc, isImageFile, sanitizeIngredients, sanitizeSteps } from '../core/schema.js';
import { escapeHtml } from '../core/strings.js';
import { highlightJson, highlightYaml } from '../core/syntax.js';
import { e2ee, e2eeB64ToBytes, e2eeBytesToB64, e2eeRandomBytes } from '../data/crypto.js';
import { REC_ALPHABET } from '../domain/constants.js';
import { state } from '../domain/state.js';
import { acctRecCacheKey } from './auth.js';
import { isUnlocked, readFileAsDataUrl } from './misc.js';
import { showToast } from './modal.js';
import { currentNote } from './notes.js';
import { coverDragNote } from './tabs.js';
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

export async function prfWrapMasterKey(prfSecretBytes, masterKeyRaw) {
  const kekRaw = new Uint8Array(await window.crypto.subtle.digest('SHA-256', prfSecretBytes));
  const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
  const iv = e2eeRandomBytes(12);
  const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, masterKeyRaw);
  return { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) };
}

// --- Passkeys (option-1 login factor; password still unlocks E2EE notes) ---
// PRF passwordless unlock: KEK = SHA-256(authenticator PRF output), used to
// wrap/unwrap the account master key. MUST match on register (wrap) and login
// (unwrap) — both sides call this one function.
export async function prfUnwrapMasterKey(prfSecretBytes, wrapped) {
  const kekRaw = new Uint8Array(await window.crypto.subtle.digest('SHA-256', prfSecretBytes));
  const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const raw = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: e2eeB64ToBytes(wrapped.iv) }, kek, e2eeB64ToBytes(wrapped.data));
  return window.crypto.subtle.importKey('raw', raw, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
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
  const usable = note && state.activeView !== 'vault' ? cleanCoverSrc(note.cover) : null;
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
      const editable = Boolean(note) && state.activeView !== 'vault' && isUnlocked()
        && !note.deleted && !note.archived;
      // Recipe notes add their photo from the fixed hero, never the banner row.
      setCoverAddHidden(!editable || (note && note.template === 'recipe'));
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
             archived: false, deleted: false };
  }
  const bottomHint = document.querySelector('.editor-bottom-fixed span:first-child');
  const isMd = note.ext === 'md';
  const plainLabel = note.ext === 'txt' ? 'Plain text' : (EXT_LABELS[note.ext] || 'MD');
  const showPreview = isMd && state.writeMode === 'preview';
  if (showPreview) preview.innerHTML = renderMarkdown(note.body);
  markdownInput.hidden = showPreview;
  preview.hidden = !showPreview;
  if (modeLabel) modeLabel.textContent = isMd ? (showPreview ? 'Preview' : 'Write') : plainLabel;
  // Preview toggle is for standard Markdown notes and recipes; to-dos and
  // every other file type have no preview.
  const showLivePreview = isMd && (!note.template || note.template === 'recipe');
  if (modeToggle) {
    modeToggle.hidden = !showLivePreview;
    modeToggle.textContent = showPreview ? 'Write' : 'Preview';
  }
  if (bottomHint) bottomHint.textContent = isMd ? 'Markdown' : plainLabel;
  if (typeBadge) typeBadge.textContent = EXT_LABELS[note.ext] || 'MD';
  if (beautifyBtn) beautifyBtn.hidden = !(note.ext === 'json' || note.ext === 'yaml');
  // Formatting toolbar returns only for notes carrying the "md" tag.
  const mdTagged = Array.isArray(note.tags) && note.tags.some((tag) => String(tag).toLowerCase() === 'md');
  if (editorToolbar) editorToolbar.hidden = !mdTagged;
  if (!showPreview) autogrow();
  updateSyntaxLayer(note, showPreview);
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
