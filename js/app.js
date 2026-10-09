// ============================================================================
// Notive frontend (app.js) — single IIFE, 'use strict'.
// WHAT IT DOES: sidebar navigation, custom sections/folders, note list tree,
// Markdown editor with live preview, templates, import/export, Bin (3-day
// soft-delete), Archive, right-click menus, themes, and the login gate.
// HOW DATA FLOWS: notes live in memory (`notes`) and sync encrypted to the
// server (PUT/GET /api/notes). Auth/session/profile live in the "Auth & E2EE"
// section near the end. localStorage holds ONLY non-secret UI state:
// section/folder order, collapsed folders, theme,
// sidebar state. Rendering rule: every dynamic string goes through
// escapeHtml(); every rendered link/image URL through sanitizeUrl().
// SECTIONS (in order): Icons · Notes data + E2EE vault · Sections & Bin ·
// Note list tree · Editor · Context menu + delete dialogs · Templates ·
// Shell wiring (search/filters/nav/import/sidebar) · Auth & E2EE session ·
// Themes/settings · Boot.
// ============================================================================
// ---- Module imports (extracted layers) -------------------------------------
// The front-end is migrating to ES modules under js/. Pure helpers and I/O live
// in their own layers; everything still in this file stays inside the IIFE and
// closes over these imports.
import { escapeHtml, sanitizeUrl } from './core/strings.js';
import { apiFetch } from './data/api.js';
import { E2EE_KDF_ARGON2ID, e2ee, e2eeBytesToB64, e2eeB64ToBytes, e2eeRandomBytes, e2eePasswordBase, e2eeDeriveBits, e2eeKekFromPassword, argon2id32, assertArgon2Params, loadArgon2, e2eeWrapMasterKeyArgon2id, e2eeTrialUnwrapArgon2id, e2eeUnwrapMasterKey, e2eeEncryptNotes, e2eeDecryptPayload } from './data/crypto.js';
import { icon, iconPaths } from './core/icons.js';
import { renderMarkdown, inlineMarkdown, splitTableRow, tableAligns, renderTable, splitRecipeColumns, stripMarkdown } from './core/markdown.js';
import { highlightJson, yamlCommentAt, highlightYamlValue, highlightYaml, beautifyJsonText, beautifyYamlText } from './core/syntax.js';
import {NOTE_EXTS, COVER_ACCEPT, COVER_MAX_CHARS, MIGRATED_COLLECTIONS_SECTION_ID, normalizeExt, isImageFile, parseRecipeBody, migrateNote, sanitizeIngredients, sanitizeSteps, cleanCoverSrc, sanitizeFilename, parseTitleExtension, EXT_LABELS, EXT_MIME, COVER_MAX_DIM, parseMarkdownFrontMatter} from './core/schema.js';
import { THEMES, THEME_META_COLORS, THEME_LABELS, FONTS } from './ui/theme.js';
import { showToast, askInput } from './ui/modal.js';
import { sharingFingerprint, sharingPinsLoad, sharingPinsSave, wrapSigMessage, signWrap, verifyWrap, sharingSignerPublicKey, sharingUnwrapAccountKey, sharingWrapAccountKey, sharingRecipientPublicKey, wrapRawKeyFor, unwrapRawKey, unwrapMyKey, collabGroupKey, collabKeyFor, collabEncrypt, collabDecrypt, collabEncryptMeta, collabDecryptMeta, collabEncryptGroupMeta, collabDecryptGroupMeta, commonPrefixLen, commonSuffixLen, applyTextDiff, bufToB64url, b64urlToBuf, sha256Hex } from './data/collab-crypto.js';
import { updateVaultUI, setVaultModal, closeVaultModal, vaultFail } from './ui/vault.js';
import { setSaveLabel, syncAgoText, viewLabel, binRemainingText, noteGlyphFor, makeStripScrollButton, updateStripScrollButton, clearTabDropMarks } from './ui/feedback.js';
import { e2eeUnlockWithPassword, e2eeUpgradeKdf, refreshMfaStatus, passwordPolicyCheck, setAuthTab, loginFail, showLogin, hideLogin, refreshSession, fullNameOf, initialsFor, cleanAvatarSrc, AVATAR_MAX_CHARS } from './ui/auth.js';
import { validVaultBlob, cleanVaultFolders, timingSafeEqualStr, vaultEncryptNote, vaultDecryptItem, decryptAllVaultBlobs, currentVaultBlobs, uniqueVaultTitle, cleanVaultFolderInput } from './data/vault.js';
import { state } from './domain/state.js';
import { noteList, listEmpty, listHeading, titleInput, markdownInput, preview, breadcrumbTitle, wordCount, tagList, saveLabel, typeBadge, editorToolbar, allCount, recentCountEl, starredCountEl, totalCount, importInput, modeLabel, modeToggle, beautifyBtn, tabBarEl, tabOverflowMenuEl, stripBoxEl, stripBackEl, syntaxLayer, recipeBodyEl, foldToggle, importNotesBtn, panelResizer, notesPanel, sidebar, sidebarToggle, workspaceToggle, settingsOverlay, tabRegister, registerForm, passkeyLoginBtn, changeBtn, mfaSetupBtn, closeMfaQrBtn, mfaQrOverlay, mfaConfirmBtn, mfaDisableBtn, passkeyAddBtn, accountSaveBtn, accountDeleteBtn, accountSaveNameBtn, profileOverlay, profileCardEl, closeProfileBtn, profileEditBtn, profilePhotoBtn, profilePhotoRemove, avatarInputEl, acctRecBtn, acctRecDownloadBtn, acctRecDoneBtn, acctRecViewBtn, recoverLink, recoverBack, closeRecoverModalBtn, recoverModalOverlay, recoverOptEmail, recoverOptCode, recoverEmailBtn, recoverVerifyBtn, recoverBtn, settingsNewTagBtn, deviceOnlyBox, themeSelect, fontSelect, loginThemeToggle, loginThemeMenu, recoverTokenBtn } from './core/elements.js';
import { newNoteId, isValidNoteId } from './core/ids.js';
import { FOLDER_SEP, MAX_SUBFOLDER_PARENT_DEPTH, CONTROL_CHARS, splitFolderPath, folderParent, folderLeaf,
  folderDepth, folderIconForDepth, isFolderOrSub, cleanFolderPath, joinLeafRename } from './core/paths.js';
import { isRecentNote, relativeEditedLabel } from './core/dates.js';
import { cancelCollabInvite, closeCollabNewDialog, closeCollabNote, closeCollabPending, closeSharedContextMenu, collabAddGroupMember, collabAdoptRekey, collabAssetsChanged, collabCompact, collabCreate, collabInvite, collabPresenceColor, collabPresenceHeartbeat, collabPresenceLocal, collabPresenceReceive, collabRemoveMember, collabSyncDom, loadYjs, openCollabPending, refreshSharedNavCount, renderCollabMembersModal, renderCollabPresence, scheduleCollabMeta, setCollabNewStatus, setCollabStatus, setSharedNavCount, sharedNoteMatchesSearch, sharedUniqueTitle, showSharedContextMenu, updateSharedNoteMeta } from './data/collab-crypto.js';
import { COLLAPSED_FOLDERS_KEY, NOTE_TEMPLATES, SECTION_DATA_KEY, SECTION_ICONS, UI_VAULT_KEY, sharedBodyCache, sharedCollapsed, sharedGroupFolders, sharedGroupKeys, sharedGroupOwners, sharedGroupTags, sharedNoteMeta } from './domain/constants.js';
import { closeAcctRecModal, closeMfaQrModal, openAcctRecModal, openMfaQrModal, prfFirstResult, prfSecretViaAssertion, refreshAccountPane, refreshAcctRecStatus, renderAcctRecCodes, saveAccountName } from './ui/auth.js';
import { clearRecoveryCodesLocal, closeRecoverModal, downscaleCover, enterCoverRepos, findTreeWrap, focusRecipeField, handleCollabCoverFile, loadRecoveryCodesLocal, moveCoverOnNote, newRecoveryCode, openRecoverModal, prfUnwrapMasterKey, prfWrapMasterKey, recipeDataForActive, renderCover, renderPreview, renderRecipeBody, renderRecipeHero, saveRecoveryCodesLocal, setCoverReposUI } from './ui/editor.js';
import {activeEditorNote, buildNotesEnvelope, clearSearch, closeNoteContextMenu, currentNote, deviceOnlyPref, downloadNoteById, ensureNoteFiled, exportAllNotes, firstFilingOf, getNoteContextMenu, isImportant, isPlainTextNote, localNotesKey, markSynced, openEmptyBinConfirm, openNoteContextMenu, readLegacyLocalNotes, saveNotesToDevice, scopeNotes, setDeleteDialog, setDeviceOnlyPref, updateBinUI, visibleNotes, wipeLegacyLocalNotes, exportAllNotesMdZip, importFromClipboard} from './ui/notes.js';
import { clearSectionSelection, closeFolderContextMenu, closeFolderPicker, closeSectionContextMenu, closeSectionIconPicker, closeSectionSettings, confirmDeleteSharedFolder, customFolderColor, customNoteFolder, folderListOf, getFolderContextMenu, insertFolderAfterParent, isFolderDrag, isSectionEmpty, openCustomFolderDeleteConfirm, openCustomSectionDeleteConfirm, openFolderContextMenu, openSectionContextMenu, openSectionIconPicker, openSectionSettings, openVaultFolderDeleteConfirm, orderFoldersLikeWorkspace, renderCustomSections, renderSectionMembers, resolveListFolderTarget, saveGroupFolders, sectionDisplayName, sectionInviteMember, sectionTagAdd, sectionTagRemove, sharedAllFolderKeys, sharedFolderKey, sharedFolderTree, sidebarFolderTarget, takenSectionNames, uniqueCustomFolderName, uniqueSectionId, uniqueSectionName, updateFoldToggle, visibleFolderPaths } from './ui/sections.js';
import { applyFont, applyPanelWidth, applyProfile, clearSessionUnlock, closeProfilePopup, closeSettings, downscaleAvatar, openProfilePopup, openSettings, paintAvatar, refreshProfilePopup, restorePanelWidth, restoreSessionUnlock, restoreWorkspaceCollapsed, saveSessionUnlock, seedFromTemplate, setLoginThemeMenu, setSidebarCollapsed, setWorkspaceCollapsed, slideMenuCollapsed, startCollapsedPref, welcomeSeedNotes, welcomeSeedUi } from './ui/shell.js';
import { clearSharedDropTargets, closeTabOverflow, coverDragStart, endCoverDrag, endTabDrag, findTabbedNote, fitTabStrip, renderStripItems, setSettingsTab, toggleTabOverflow, trackTab, updateBreadcrumbs } from './ui/tabs.js';
import { addNoteTag, cleanTagList, closeTagEditor, normalizeTagName, openSharedTagEditor, openTagEditor, removeNoteTag, renderSettingsTags, renderSharedTags, renderTagEditor, sharedGroupTagList, sharedTagList } from './ui/tags.js';
import { applyUiSnapshot, decryptUiVaultRaw, openVaultModal, openVaultNoteDeleteConfirm, uiVaultKey, writeUiVaultLocal } from './ui/vault.js';
import { acceptInvite, collabDeleteNote, confirmCollabNew, createSharedNoteWithTemplate, declineInvite, moveSharedNote, openCollabNote, openSharedNewNote, renderSharedView } from './data/collab-crypto.js';
import { refreshPasskeys } from './ui/auth.js';
import { applyBeautify, exitCoverRepos, handleCoverFile, initCheckboxOverlay, initTodoEditor, isTodoRenderedActive, linePrefix, recipeMutate, removeCover, requestCollabCoverUpload, requestCoverUpload, resetIdleTimer, setWriteMode, wrapSelection } from './ui/editor.js';
import { bindNoteContextMenu, clearEditor, createNoteFromTemplate, goAllNotes, goAllNotesKeepNote, loadNotesFromServer, onNewNoteClick, persistNotes, purgeExpiredBin, renderNoteList, requestDeleteNoteById, saveCurrentNote, selectNote, stepListBack, syncNotesToServer } from './ui/notes.js';
import { addSharedFolder, addSubfolder, applyStripFolderFilter, bindCustomSectionsEvents, bindFolderContextMenu, bindFolderDragDrop, bindSectionContextMenu, bindVaultContextMenu, bindSectionHeaderEvents, chooseSectionIcon, deleteCustomSection, isFavoritesView, leaveSharedSection, moveSharedNoteToFolder, persistCollapsedFolders, renameSharedFolder, reparentSharedFolder, selectCustomFolder, selectCustomSection, syncCustomSections } from './ui/sections.js';
import { applyTheme, enterWorkspace, handleAvatarFile } from './ui/shell.js';
import { closeTab, renderTabs } from './ui/tabs.js';
import { addKnownTag, renameTagEverywhere, tagEditorAdd, tagEditorRemove } from './ui/tags.js';
import { createVaultNoteFromTemplate, loadUiVault, lockVault, onNewVaultNoteClick, persistUiVault, resetVault, selectVaultNote, setupVaultFromModal, unlockVaultFromModal } from './ui/vault.js';
import { confirmDeleteGroup, parseUsernames, rekeyGroupIfNeeded, sharingEnsureKeys } from './data/collab-crypto.js';
import { e2eeLock, isUnlocked, logout, refreshEditorLock } from './ui/auth.js';
import { closeTemplatePicker, readFileAsDataUrl, renderTemplateOptions, uniqueTitle } from './ui/editor.js';
import { closeDeleteConfirm, confirmPendingDelete, openDeleteConfirm, openPermanentDeleteConfirm, refreshCurrent, updateListHeading, updateMeta } from './ui/notes.js';
import { findCustomItem, repathList } from './ui/sections.js';
import { cleanUiSnapshot, readLegacyUiKeys } from './ui/vault.js';

'use strict';
// Build guard: index.html carries <meta name="notive-build">. If this script
// is older/newer than the page (stale cache mix), reload once for a matching
// pair instead of running half-bound handlers that silently do nothing.
// EXPECTED_BUILD must be bumped together with the meta + cache busters.
// The only early-return construct left in the file, kept as a tiny wrapper:
// on mismatch we reload once and leave the page inert.
const BUILD_NOTE_OK = (() => {
  try {
    const tag = document.querySelector('meta[name="notive-build"]');
    const build = tag ? tag.getAttribute('content') : null;
    if (build !== 'dev89') {
      if (!sessionStorage.getItem('notive-build-reloaded')) {
        sessionStorage.setItem('notive-build-reloaded', '1');
        window.location.reload();
        return false;
      }
      return false;
    }
    sessionStorage.removeItem('notive-build-reloaded');
    const buildTag = document.getElementById('build-tag');
    if (buildTag) buildTag.textContent = `dev build ${build}`;
    return true;
  } catch (error) { return false; }
})();
// Frame-busting: refuse to run inside a foreign iframe (clickjacking defense).
// The server also sends frame-ancestors 'self'.
try {
  if (window.top !== window.self) {
    window.top.location.href = window.self.location.href;
  }
} catch (error) {}
if (BUILD_NOTE_OK) {


  // Look up an SVG path by name and wrap it in a standard 24px icon element. Unknown names render empty.


  document.querySelectorAll('[data-icon]').forEach((element) => {
    element.innerHTML = icon(element.dataset.icon);
  });

  // Create a collision-proof note id: crypto.randomUUID when available, else 16 random bytes, else timestamp+random fallback.


  // Allowlist for note ids (letters, digits, _ and -, max 80 chars) so ids stay safe in DOM lookups and downloads.


  // Canonicalize a stored/typed extension (accepts yml/markdown/text aliases).


  // Note cover pictures: uploaded images stored as data URLs on the note
  // (inside the E2EE envelope like everything else). Strictly validated on
  // every read: image MIME only, base64 payload only, hard length cap.


  // Accept by MIME, falling back to the file extension (some systems report
  // generic or missing MIME types for camera/gallery files).


  // Pull Ingredients / Method lists out of a recipe note's legacy Markdown body
  // so old recipes can be migrated into the structured recipe fields.


  // Clamp/normalize one stored note into the current schema (id, ext, sections, tags/title/body caps, deleted/archived flags, sane bin timestamps). Never throws on hostile input.


  // Notes are the signed-in user's server-side data (GET/PUT /api/notes,
  // AES-GCM encrypted at rest). Nothing note-shaped is written to localStorage:
  // legacy plaintext keys are migrated once, then wiped (CWE-312 fix).
  // Last server updated_at seen (optimistic concurrency: sent as baseVersion on
  // PUT; server rejects 409 on stale overwrites so hijacked/racing writes fail
  // instead of silently destroying newer data).
  // True when the server E2EE envelope already supplied per-account UI state
  // (v2 `ui`). loadUiVault() respects it and never overwrites it with a stale
  // device-local copy from another account.

  // One-time read of pre-server localStorage note keys. Returns null when absent or invalid.


  // Delete legacy plaintext note keys after server migration (CWE-312: no plaintext notes lingering on disk).


  // Onboarding workspace for brand-new accounts: a "Notes" section with
  // General/Personal folders plus welcome notes that explain the app. Ids are
  // stable (`welcome-*`) so this runs at most once per account — any saved
  // envelope (even an empty one) means the server row exists and this never fires.





  // The sidebar section that ships with new accounts. Only applied when the
  // account has no sidebar state of its own (server or device cache).



  // --- End-to-end encryption -------------------------------------------------
  // Note bodies/titles/tags/sections are encrypted on this device with the
  // account master key (AES-GCM-256). The server only stores opaque blobs.
  // The master key lives in memory only: it is created at registration (or
  // unwrapped at login) and wiped on logout. Reloading with a valid session
  // cookie still requires the password to unlock notes (locked vault).
  // Must match the server's ARGON2_DESCRIPTOR exactly; both sides reject
  // anything else (downgrade protection). PBKDF2 survives only for verifying
  // pre-Argon2id logins, which auto-upgrade (see e2eeUpgradeKdf).


  // argon2-browser 1.18.0 vendored locally (dual-CDN byte-verified at vendor
  // time). Every byte is hash-checked before execution: the scripts via SRI,
  // the WASM blob via SubtleCrypto before the runtime ever sees it.


  // sha384Hex() moved to js/data/crypto.js (SRI verification helper).


  // Memory-hard password KDF shared bit-for-bit with the server (argon2-cffi,
  // same t/m/p). ~0.5-2s per call; login/register/change show busy state.


  // Preflight (anti-brick): trial-decrypt a fresh wrap with the same password
  // before uploading. Honest clients never send an undecryptable wrap; without
  // this a client bug (or test script) bricks the account into login-200 yet
  // unlock-impossible. Returns true when the wrap round-trips to 32 bytes.


  // Uint8Array -> base64 string (for JSON-safe key material).

  // Base64 string -> Uint8Array. Throws on malformed input.

  // Cryptographically random bytes (salts, IVs, master keys).

  // Import a password as a PBKDF2 base key (derive-only, never extractable).

  // Stretch a password into 256 raw bits (auth verifiers). Salt + iteration count come from the server.

  // Derive the non-extractable AES-GCM key-encryption key that wraps/unwraps the account master key.

  // Unwrap the account master key with the password KEK. Throws (locked vault) on wrong password or corrupt wrap.

  // Encrypt the whole workspace JSON with the in-memory master key. Returns an {iv, data} packet; server stores it opaquely.

  // Decrypt a server payload with the in-memory master key and parse it. Returns
  // the raw envelope: a legacy bare array, or {v, notes, vault} (vault items stay
  // encrypted blobs until the vault password unlocks them). Throws otherwise.

  // Wipe all key material from memory (logout, failed unlock). Display/session state is cleared separately.

  // True when a session exists AND the master key is in memory (vault unlocked, notes readable).

  // The note the editor is bound to, whether it lives in the workspace or the
  // unlocked Vault. Editor chrome (favorite/share/type/download/preview) goes
  // through this so vault notes behave like normal ones.

  // Central lock switch: disables editor inputs and hides New/Import while logged out or locked; otherwise defers to the note deleted/archived state. Runs after every list/selection render.


  // ---- Desktop copy / cloud opt-out ----
  // "This device only" mode: server sync is off and the E2EE envelope is saved
  // to a per-account encrypted localStorage slot instead. Same key-zeroing
  // rules as the UI vault — never plaintext, never shared between accounts.






  // Build the outgoing workspace envelope (notes + vault ciphertext + UI state)
  // shared by server sync and device-only saves.


  // Encrypted local save in device-only mode: same E2EE payload the server
  // would get, parked in this browser's per-account slot.


  // Apply a decrypted {v,notes,vault,vaultFolders,ui} envelope (or legacy array)
  // to live state. Shared by the server blob path and the device-only local path.


  // Device-only boot: load from the encrypted local slot (onboarding workspace
  // when the device copy is missing) without touching the server either way.


  // Debounced encrypted upload of the workspace (notes + vault ciphertext +
  // per-account UI state). No-ops without a session; reports Locked when the
  // vault is locked. The server stores the blob opaquely — UI folders/sections
  // ride along so every account keeps its own sidebar across relogs/devices.
  // Device-only mode redirects the same save into local storage instead.


  // Immediate (non-debounced) upload used by logout/unload so the last edits
  // are never stranded in a cancelled timer.


  // Boot/load path: decrypts the server E2EE blob; adopts a legacy plaintext-shape row once; brand-new accounts start empty (updated_at distinguishes); offline falls back to the legacy local copy.
  // The envelope is a bare array (very old), {v:1, notes, vault} (E2EE notes
  // only) or {v:2, notes, vault, ui} (notes + per-account sidebar state). When
  // the server carries UI state it wins over any device-local copy.


  // Default folders carried over from the removed built-in Collections section.
  // New custom sections share the same folder palette/behavior (same value).





  // Built-in Collections section removed: all sections are custom sections.
  // The former Collections folders/notes migrate into MIGRATED_COLLECTIONS_SECTION_ID.

  // Per-account UI state (sidebar folders, custom sections, hidden
  // sections, Bin entries, collapsed state). Source of truth is the server E2EE
  // envelope (`ui` field, v2) so every account keeps its own sidebar across
  // relogs and devices. A per-account encrypted localStorage copy is only a
  // fast offline cache — never plaintext, never shared between accounts.


  // Locked-boot defaults: folder names stay unreadable until the vault unlocks.
  state.collapsedFolders = new Set();
  // User-created tags that may not be attached to any note yet (Settings → Tags).

  // Sidebar sections: [{ id, name, folders: [...] }]. Notes point at
  // them via note.sections = { sectionId: folderPath }. All sections (including
  // the migrated former Collections) share the same implementation/value.
  state.customSections = [];
  // Custom sections moved to Bin: [{ id, name, folders, deletedAt }]. Binned
  // notes keep their section tags, so restoring a note revives its section.
  state.deletedCustomSections = [];

  // Device-local cache key, namespaced per account so two logins on one device
  // can never decrypt (or overwrite) each other's sidebar.


  // Plain-object snapshot of the whole sidebar state for the server envelope.


  // Validate + normalize a UI snapshot from the server (never throws). Returns
  // the cleaned object or null when unusable.


  // Apply a server/UI-vault snapshot to memory. Returns true when anything was adopted.


  // Immediate encrypted write of the per-account local cache. Used by the
  // debounced persistUiVault() and by the logout/pagehide flush path.




  // Section icon picker set (order shown in the picker). First entry is the
  // default for sections without a chosen icon.


  // Resolve a section's icon, falling back to the default when unset/invalid.




  // Ensure the migrated former-Collections custom section exists and carries
  // the same folders/value. All new sections share this implementation.







  // Persist binned custom-section records {id, name, folders, deletedAt}.

  // Drop section Bin records with no binned notes left (or past retention).

  // Permanently drop notes/sections past the 3-day retention; repairs tampered timestamps; drops section entries with no binned notes left.

  purgeExpiredBin();

  state.currentId = null;
  state.activeView = 'notes';
  state.activeFilter = 'all';
  state.searchQuery = '';
  // Persist collapsed tree-folder state into the encrypted UI vault.

  // ---- Sidebar sections & Bin: folder CRUD, sidebar render, sync with note data ----

  // Rewrite exact + descendant paths in a folder list (sidebar, collapsed keys).


  // Revive binned custom sections a (newly live) note belongs to, so it has
  // a home. Custom folders inside live sections are re-adopted by the
  // sidebar sync that callers run afterwards.


  // Restore a binned folder: drops its Bin entry and unbans (undeletes) all its notes, then re-syncs the sidebar.
  // Erase a binned folder and all its binned notes at once; repairs the current selection.
  // Find a sidebar row by exact dataset value (avoids CSS-escaping pitfalls of quoted selectors).
  // Find an All-Notes folder group by exact dataset value (avoids CSS-escaping pitfalls).


  // Inline sidebar rename: swaps the label for an input; Enter commits, Escape cancels, blur commits.
  // Create a uniquely-named folder, reset view/filters, and immediately open inline rename.
  // Delegated sidebar clicks (rename/delete/select) plus double-click to rename. Delegation survives innerHTML re-renders.
  // Recipes section removed.

  // Delete every folder in a built-in section and hide the section header;
  // notes keep everything else. Restore via Settings → Side Menu.
  // (Custom sections have deleteCustomSection; single folders use their own confirms.)


  // Render user-built sections: header (editable name, add/delete) + folders.




  // Paint section headers (all sections share the same custom implementation).


  // A sidebar section header filters the list — pointless when the section
  // holds nothing, so empty sections are unclickable (rename still works).


  // All taken section display names (lowercased), optionally skipping one entry.








  // Inline rename for a section header (built-in or custom); Enter commits.


  // Validate and apply a section display-name edit (all sections share the same implementation).


  // Delete a custom section: the section is removed from the sidebar, stashed
  // in Bin, and every live note inside moves to Bin for 3 days (section tags
  // are kept, so restoring a note revives its section).


  // De-duplicate a folder name inside one custom section.






  // Add a folder to one section from its All-Notes header (folder-plus beside
  // the edit pencil). Keeps the current view. When the slide menu is collapsed
  // the inline rename row is hidden, so the name is asked in a popup instead.


  // Inline rename for a custom-section folder row.


  // Validate and rename a custom folder on the section and matching notes.




  // Delete a custom folder and its nested subfolders: the folder is removed
  // from the sidebar and every live note inside moves to Bin for 3 days (tags
  // are kept, so restoring a note revives its folder via the sidebar sync).


  // Adopt custom folders found on live notes that the sidebar does not list
  // yet (imports, older data), normalizing case onto the sidebar spelling.






  // Clicking a section header filters the list to every folder under it.
  // ---- Section context menu (right-click on a slide-menu section header):
  // New folder / Rename section / Delete section. Replaces the old header +
  // and × buttons. Rename/add fall back to popups while the slide menu is
  // collapsed, where the inline rows are hidden.









  // ---- Section icon picker -------------------------------------------------
  // Opens a grid of line icons; picking one stores it on the section (persisted
  // in the E2EE UI envelope) and repaints the sidebar.









  // ---- Folder context menu (right-click): Open / Rename / New subfolder /
  // Delete. One shared menu for sidebar rows and All-Notes folder headers;
  // the target carries its section so folders stay separate.









  // Insert a folder path directly after its parent's block (the parent plus any
  // existing descendants) so a new subfolder renders under its parent instead
  // of at the end of the list. Appends when the parent is missing.


  // Create a nested folder under a parent path and jump straight into naming
  // it. Without a parent, a top-level folder is created.




  // ---- Folder drag-and-drop: reorder siblings, or drop onto a folder to nest
  // inside it (top/bottom quarter = before/after, middle = nest). Unified custom
  // sections implementation (same value for all new sections); reparenting
  // reuses the rename functions so notes, collapse state and selection follow.






  // Move a folder block (path + descendants) within its list.


  // Reparent a folder under a new parent (null = top level). Returns the new
  // full path, or null when blocked. Shows toasts itself.















  // ---- Save-state light ----
  // One helper drives the topbar indicator: dot colour (green synced / gray
  // offline / red error) plus label text. Sync timestamps feed the
  // "Synced X min ago" wording and a ticker keeps it current.

  setInterval(() => {
    if (state.lastSyncedAt && saveLabel && saveLabel.textContent.startsWith('Synced')) {
      setSaveLabel(syncAgoText(), 'green');
    }
  }, 30000);












  // ---- Rendering helpers: HTML escaping + allowlisted Markdown (XSS boundary) ----
  // escapeHtml() and sanitizeUrl() now live in js/core/strings.js (imported above).

  // Render inline Markdown on already-escaped text: code spans and link/image tags are stashed in placeholders so later emphasis passes can never reach inside href/src attributes.


  // Split a Markdown table row into trimmed cells. Handles optional leading/
  // trailing pipes and escaped (\|) pipes inside a cell.


  // Recognise a GFM delimiter row ("| --- | :--: |") and return per-column
  // alignment ('left'|'center'|'right'|''), or null when it is not one.


  // Split a `::: recipe` block into its two columns at the first `---` rule.


  // Line-based block renderer (headings, lists, tasks, quotes, code fences, hr) built only from escaped/sanitized pieces.


  // First folder filing of a note across sections, or null when unfiled.
  // ---- Note list: filtering, grouping, counts, tree rendering ----




  // ---- Folder-required invariant: a note never lives outside the sections ----
  // Every entry path funnels through here. A note with no valid filing is
  // placed into the first folder of the first section (creating the default
  // "Notes" section when the workspace has none), so unfiled notes cannot
  // exist. Returns true when the note was refiled.


  // Sweep every live note through the invariant (boot, import, restore, sync).


  // ---- Nested folders: a folder path is segments joined with FOLDER_SEP
  // ("Work / Projects"). All folder namespaces share
  // these helpers; matching is always exact-path or proper-descendant.

  // Folders may nest twice (top-level -> sub -> sub-sub); a third level is not
  // allowed. folderDepth() returns 0 for top-level, 1 for a sub, 2 for the
  // deepest allowed sub-sub, so depth >= 2 cannot host another subfolder.


  // Icon name by nesting depth: parent (solid) -> subfolder (outline) ->
  // sub-subfolder and deeper (bold nested outline).


  // True for the folder itself and anything nested under it ("Work" matches
  // "Work" and "Work / Projects", but not "Workout").


  // C0 control characters as a plain string (built, not escaped).


  // Normalize a raw path: clean each segment (no slashes survive), cap
  // segments at 60 chars and the whole path at 180. Returns '' when empty.


  // Rename UX edits the leaf segment only: the parent prefix is re-attached on
  // commit, so renaming a folder can never detach it from its parent (and a
  // renamed parent keeps its children via the usual subtree repath).
  // Returns '' when nothing usable was typed (callers treat it as cancel).


  // True for notes dated Now/Today/Yesterday (drives the Recent chip).


  // Single place that computes the list heading from view + collection + chip filter (e.g. "Work · Starred").


  // Clear the search box and its in-memory query.


  // ---- Open-note tabs (dev): many notes open at once, replacing breadcrumbs ----
  state.openTabs = []; // [{ id, vault }] in opening order, capped

  // List glyph shared by the note list, tabs and strip. Recipes and to-dos keep
  // their distinctive glyphs; everything else gets its file-type icon.

  // Remember an opened note; selecting a tab never moves it — order is fixed
  // by opening time. Evict oldest non-active past the cap.

  // Close one tab; when it was active, fall back to the nearest surviving
  // neighbor (next, then previous, then outward) so selection stays put.

  // Paint the strip; drop tabs whose notes are gone (purged, vault locked) or
  // binned — a deleted note leaves the tabs at once.

  // Overflowed tabs (id/vault/title) from the last fit; powers the dropdown.

  // Hide whatever does not fit; the active tab always stays, earliest others
  // fill the rest, and the remainder goes to the dropdown button. No scrollbar.





  if (tabBarEl) tabBarEl.addEventListener('click', (event) => {
    if (state.tabClickSuppressed) return;
    const closer = event.target.closest('[data-tab-close]');
    if (closer) {
      event.stopPropagation();
      closeTab(closer.dataset.tabClose, closer.dataset.tabCloseVault === '1', closer.dataset.tabCloseShared === '1');
      return;
    }
    if (event.target.closest('[data-tab-overflow]')) { toggleTabOverflow(); return; }
    if (event.target.closest('[data-tab-home]')) { state.openTabs = []; goAllNotes(); return; }
    const tab = event.target.closest('[data-tab-id]');
    if (!tab) return;
    if (tab.dataset.tabShared === '1') openCollabNote(tab.dataset.tabId);
    else if (tab.dataset.tabVault === '1') selectVaultNote(tab.dataset.tabId);
    else selectNote(tab.dataset.tabId);
  });
  // Drag-and-drop reordering of tabs (order is otherwise fixed by opening time).

  if (tabBarEl) tabBarEl.addEventListener('dragstart', (event) => {
    const tab = event.target.closest('[data-tab-id]');
    if (!tab) return;
    state.dragTabEl = tab;
    state.dragTabIndex = [...tabBarEl.querySelectorAll('[data-tab-id]')].indexOf(tab);
    tab.classList.add('dragging');
    try { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', tab.dataset.tabId || ''); } catch (error) {}
  });
  if (tabBarEl) tabBarEl.addEventListener('dragover', (event) => {
    if (state.dragTabIndex == null) return;
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'move'; } catch (error) {}
    const over = event.target.closest('[data-tab-id]');
    clearTabDropMarks();
    if (!over || over === state.dragTabEl) return;
    const rect = over.getBoundingClientRect();
    over.classList.add(event.clientX > rect.left + rect.width / 2 ? 'tab-drop-after' : 'tab-drop-before');
  });
  if (tabBarEl) tabBarEl.addEventListener('drop', (event) => {
    if (state.dragTabIndex == null) return;
    event.preventDefault();
    const over = event.target.closest('[data-tab-id]');
    if (over && over !== state.dragTabEl) {
      const tabs = [...tabBarEl.querySelectorAll('[data-tab-id]')];
      let to = tabs.indexOf(over);
      const rect = over.getBoundingClientRect();
      if (event.clientX > rect.left + rect.width / 2) to += 1;
      if (state.dragTabIndex < to) to -= 1;
      const [moved] = state.openTabs.splice(state.dragTabIndex, 1);
      if (moved) {
        state.openTabs.splice(Math.max(0, Math.min(state.openTabs.length, to)), 0, moved);
        renderTabs();
      }
    }
    endTabDrag();
  });
  if (tabBarEl) tabBarEl.addEventListener('dragend', endTabDrag);


  if (tabOverflowMenuEl) tabOverflowMenuEl.addEventListener('click', (event) => {
    const closer = event.target.closest('[data-otab-close]');
    if (closer) {
      event.stopPropagation();
      closeTab(closer.dataset.otabClose, closer.dataset.otabCloseVault === '1', closer.dataset.otabCloseShared === '1');
      return;
    }
    const row = event.target.closest('[data-otab-id]');
    if (!row) return;
    if (row.dataset.otabShared === '1') openCollabNote(row.dataset.otabId);
    else if (row.dataset.otabVault === '1') selectVaultNote(row.dataset.otabId);
    else selectNote(row.dataset.otabId);
    closeTabOverflow();
  });
  document.addEventListener('click', (event) => {
    if (state.tabOverflowOpen && !event.target.closest('#tab-overflow-menu') && !event.target.closest('[data-tab-overflow]')) closeTabOverflow();
  });
  window.addEventListener('resize', () => {
    closeTabOverflow();
    try { renderTabs(); } catch (error) {}
    try { updateStripScrollButton(); } catch (error) {}
  });

  // Collapsed workspace strip. With the sidebar expanded it behaves as before:
  // inside a folder it lists that folder's notes plus immediate subfolders.
  // With the sidebar COLLAPSED the slide menu shows sections only, so this
  // strip becomes the folder navigator: every folder of the active section (or
  // of all sections when no section is selected) renders as its colored dot;
  // clicking one opens it. Gold folder glyphs stay distinct from note glyphs.


  if (stripBoxEl) {
    stripBoxEl.addEventListener('scroll', updateStripScrollButton, { passive: true });
    stripBoxEl.addEventListener('click', (event) => {
      const snote = event.target.closest('[data-shared-strip-note]');
      if (snote && state.activeView === 'shared') { openCollabNote(snote.dataset.sharedStripNote); return; }
      const ssub = event.target.closest('[data-shared-strip-folder]');
      if (ssub && state.activeView === 'shared') {
        const groupId = ssub.dataset.sharedStripGroup;
        const folderPath = ssub.dataset.sharedStripFolder || '';
        // Same folder re-click clears the scope (whole section shows again).
        const same = state.sharedFolder && String(state.sharedFolder.groupId) === String(groupId) && (state.sharedFolder.folder || '') === folderPath;
        state.sharedFolder = same ? null : { groupId, folder: folderPath };
        renderSharedView();
        renderStripItems();
        updateBreadcrumbs();
        updateFoldToggle();
        return;
      }
      const sub = event.target.closest('[data-strip-folder]');
      if (sub) {
        // In Starred/Archive/Bin the strip filters within the view instead of
        // hopping back to All Notes.
        const inView = isFavoritesView() || state.activeView === 'archive' || state.activeView === 'bin';
        if (inView) { applyStripFolderFilter(sub.dataset.stripSection, sub.dataset.stripFolder || null); return; }
        // Empty folder path = section glyph → open the whole section.
        if (!sub.dataset.stripFolder) { selectCustomSection(sub.dataset.stripSection); return; }
        selectCustomFolder(sub.dataset.stripSection, sub.dataset.stripFolder); return;
      }
      // Section letter tag above the glyph is also clickable → same as the glyph.
      const tag = event.target.closest('.strip-section-tag[data-strip-section]');
      if (tag) {
        const inView = isFavoritesView() || state.activeView === 'archive' || state.activeView === 'bin';
        if (inView) { applyStripFolderFilter(tag.dataset.stripSection, null); return; }
        selectCustomSection(tag.dataset.stripSection); return;
      }
      const item = event.target.closest('[data-strip-note]');
      if (item) selectNote(item.dataset.stripNote);
    });
    // Right-click a strip folder: same menu as everywhere else (Open / New note
    // / Rename / New subfolder / Delete).
    stripBoxEl.addEventListener('contextmenu', (event) => {
      const sub = event.target.closest('[data-strip-folder]');
      if (!sub) return;
      event.preventDefault();
      event.stopPropagation();
      openFolderContextMenu('custom', sub.dataset.stripFolder, event.clientX, event.clientY, sub.dataset.stripSection);
    });
  }

  if (stripBackEl) stripBackEl.addEventListener('click', (event) => {
    event.preventDefault();
    if (stripBackEl.dataset.stripShared === '1' && state.sharedFolder) {
      const parent = stripBackEl.dataset.stripTarget || '';
      if (parent) state.sharedFolder = { groupId: stripBackEl.dataset.sharedGroup, folder: parent };
      else state.sharedFolder = null;
      renderSharedView();
      renderStripItems();
      updateBreadcrumbs();
      updateFoldToggle();
      return;
    }
    const sectionId = stripBackEl.dataset.stripSection;
    if (!sectionId) return;
    if (stripBackEl.dataset.stripAll === '1') { goAllNotesKeepNote(); return; }
    const target = stripBackEl.dataset.stripTarget;
    const inView = isFavoritesView() || state.activeView === 'archive' || state.activeView === 'bin';
    if (inView) { applyStripFolderFilter(sectionId, target || null); return; }
    if (target) selectCustomFolder(sectionId, target);
    else selectCustomSection(sectionId);
  });

  // Strip overflow: when the dots/notes do not fit the strip height, a
  // scroll buttons appear above/below the strip (never a scrollbar): a down
  // arrow when there is more below, and an up arrow once scrolled down. Clicking
  // pages one viewport of items; both hide automatically at their ends.

  // Rebuild the clickable breadcrumb trail: [view] [/ folder] / [note title].
  // The title element itself is persistent (editor writes to it directly); only
  // the trail prefix is re-rendered here.



  // Breadcrumb home: reset to All notes with nothing open and an enlarged
  // workspace (editor hidden). Selecting any note exits the enlarged mode.


  document.getElementById('breadcrumbs').addEventListener('click', (event) => {
    const crumb = event.target.closest('[data-crumb]');
    if (!crumb) return;
    event.preventDefault();
    if (crumb.dataset.crumb === 'root') goAllNotes();
    else if (crumb.dataset.crumb === 'folder') {
      if (state.activeCustom && state.activeCustom.folder) selectCustomFolder(state.activeCustom.section, state.activeCustom.folder);
      else if (state.activeCustom) selectCustomSection(state.activeCustom.section);
    }
  });

  // Master list filter: Bin vs live, archive rules, search text, chip filter, selected collection.


  // Sidebar search. Plain terms match file text (title + contents) and folder
  // names only — tags are excluded. `tag: <name>` matches tags and `body: <text>`
  // matches the note body. Terms are AND-ed.


  // Search a shared-note inbox entry. Title/folder/tags are in the decrypted meta;
  // `body:` matches against a session cache of note bodies (populated whenever a
  // shared note is opened — bodies live in the CRDT and aren't loaded for the list).


  // Notes in the current view + selected folder, ignoring the search box and
  // the All/Recent/Starred chip — so the chips mirror the selected folder.


  // Human countdown ("2d left") until a binned note is purged.

  // Resize the Markdown textarea to its content (skipped in preview mode).


  // ---- JSON/YAML syntax highlighting ---------------------------------------
  // The editing textarea cannot render colors, so a pre overlay behind it paints
  // colored tokens while the textarea text runs transparent. Both share font,
  // padding and line-height so the glyphs sit exactly on top of each other.



  // Index of a # comment start, ignoring # inside quotes.


  // Paint (or clear) the overlay for the open note. Only JSON/YAML are colored.


  // ---- Beautify (JSON / YAML) ----------------------------------------------
  // JSON: strict parse + 2-space re-emit (throws on invalid, surfaced as toast).


  // YAML: safe normalization — tabs to spaces, trailing whitespace stripped,
  // blank runs collapsed, and distinct indent depths remapped to 2-space steps
  // (relative nesting preserved). Comments and values are left intact.


  // Apply the formatter to the open note (button is visible for json/yaml only).


  // Swap the writing area between Markdown source and rendered preview; non-Markdown notes never preview.


  // ---- Note cover pictures ------------------------------------------------
  // Covers ride on the note (inside the E2EE envelope) as validated data URLs.


  // The Add-cover row lives under the topbar line; hiding the button must
  // hide the row too, or its margin leaves a gap.


  // Paint the cover banner for the open note (null hides it). The src is
  // re-validated on every render and assigned as a property, never via HTML.


  // Fixed recipe hero (meal photo + description) between the meta row and the
  // writing area. Editor chrome, not body text, so it cannot be deleted. The
  // photo reuses the note cover (same picker, validation and E2EE storage);
  // the src is re-validated on every render and assigned as a property.


  // ---- Structured recipe body (Ingredients / Method) -----------------------
  // Recipe notes never show their Markdown body; instead these editable fields
  // are rendered as a two-column table. Local recipes store the lists on the
  // note; shared recipes keep them in a Y.Map('recipe') in the collaborative doc.




  // Edit the recipe lists for whichever source is open (local note or shared doc).







  // Downscale to a JPEG banner (max 1200px side, quality 0.82).




  // Shared recipe notes keep their meal photo in the collaborative doc
  // (Y.Map 'assets'), so every member sees the same picture.




  // Drag the banner on the note itself to reposition the cover (Notion-style).
  // Repositioning is a locked mode: Reposition unlocks, Done saves + locks.







  // Leave reposition mode; save persists the staged position, cancel restores it.










  // After 10s idle, auto-switch a non-empty Markdown note to preview.


  // Switch write/preview mode and refocus the editor when returning to edit.


  // Inline rename for All-Notes folder headers; refused in Bin.


  // Swap New/Import vs Empty-Bin buttons per view, then refresh the lock state.


  // Drag-and-drop note sorting: drag a row onto another note to reorder (top /
  // bottom half picks the side); dropping onto a folder header moves the note
  // into that folder. Disabled in Bin and Vault, where order is meaningless.




  // True when a drag event carries a Notive folder (slide-menu/workspace shared
  // payload), as opposed to a note drag (text/plain) or a file hover.


  // Resolve a workspace folder header to its section (same precedence as the
  // folder context menu: active custom filter, then the list-section shell,
  // then the folder owner).




  // Render the grouped note tree: folder ordering, collapse, Bin actions vs rename pencil, scoped counters, and per-row event wiring.


  // Selected note, falling back to the first note (may be undefined when empty — callers must guard).


  // Refresh word count, tag chips and the favorite button for the open note.
  // Human "last edited" label from a note's timestamp (falls back to its date text).




  // Open a note in the editor and re-render the list; lock state is reapplied afterwards.
  // Every note opens in PREVIEW mode (edit mode never carries over between
  // notes); clicking/focusing the preview switches that note to edit mode.


  // Debounced save: refuses (with a warning, never truncates) past 2000 notes, then syncs encrypted to the server.




  // True when a note carries the important tag (case-insensitive).


  // Add/remove the important tag; important notes require popup confirmation before deletion.


  // Return the shared right-click menu element.
  // ---- Context menu, delete dialogs, note lifecycle (Bin/Archive/restore) ----



  // Hide the right-click menu and forget its target note.


  // Show the right-click menu at the cursor: per-state item visibility (deleted/archived/live) with viewport clamping.


  // Download one note with a sanitized filename and matching MIME type.




  // Copy a note (fresh id, unique title, reset dates/flags) right after the original and open it.


  // Flip the star flag and refresh badges, counts and list.


  // Empty the editor for the no-notes state and re-render.


  // Soft-delete one note into Bin (sets deletedAt); repairs the selection to a neighbor.


  // Restore one binned note; revives its folder too when the folder itself was binned.


  // Move one live note to Archive; repairs the selection from the still-visible list.


  // Return one archived note to All notes (refuses deleted notes) and re-sync the sidebar.


  // Erase one binned note immediately; repairs the selection.


  // Permanently erase everything in Bin (notes + folder entries) after popup confirmation.


  // Dispatch a validated context-menu action; unknown ids/actions are ignored.


  // ---- Tags -----------------------------------------------------------------
  // Tags live on each note as freeform strings (<=40 chars, max 20 per note).
  // The account-wide view (settings) aggregates them for rename/delete.





  // Aggregate every tag with a note count (case-insensitive; first casing wins).
  // User-created tags with no notes yet are included with a count of 0.


  // Rename a tag on every note (folds duplicates created by the rename).

  // Delete a tag from every note.

  // Create a standalone tag (available to every note's tag editor and to search).


  // ---- Note tag editor (opened from the note right-click menu) --------------

  // Shared-note tags live in the Yjs doc (a Y.Array) so they sync live to every
  // member; the encrypted note meta mirrors them for the Shared list.










  // ---- Settings → Customization → Tags --------------------------------------


  // ---- E2EE note sharing ----------------------------------------------------
  // Each account publishes an ECDH P-256 keypair: the public key in the clear,
  // the private key wrapped under the account master key. To share, a random
  // content key encrypts the note and is wrapped for the recipient's public key
  // (ECIES). The server relays only ciphertext and can never read a note.
  state.sharing = { privateKey: null, signingKey: null, ready: false };






  // ---- Signed wraps: a member signs the key they hand a peer, so the recipient
  // can detect a server that substitutes a wrap it controls. ------------------------------------------------------------------
  // Throws if a wrap we did not make fails verification (legacy unsigned wraps are
  // allowed through so existing sections keep working).


  // ---- Live collaborative notes (E2EE via Yjs) ------------------------------
  // Shared sections: a group has a random key wrapped to each member. Notes live
  // under the group; any note added there is automatically shared with everyone
  // in the group. Edits are Yjs CRDT updates encrypted with the group key and
  // relayed over a WebSocket. The server only relays ciphertext.


  // Note "meta" (title + folder) is encrypted under the group key so the server
  // still sees nothing. It powers the Shared inbox list without loading the doc.
  // Unwrap a group's key from my membership (used by the inbox + note creation).
  // Push the current title/folder (debounced) so the inbox list stays current.


  state.collab = { noteId: null, groupId: null, doc: null, title: null, body: null, desc: null, assets: null,
    cover: '', description: '', es: null, key: null, keyVersion: 1, keys: new Map(),
    members: [], owner: null, groupName: '', folder: '', template: '', updates: 0, reconnect: null, metaTimer: null,
    outbox: [], flushing: false, flushTimer: null,
    presence: new Map(), presenceTimer: null, clientId: null, color: null, typing: false, pending: [], tags: null };

  // Raw group key for a given epoch (falls back to the current key). After a
  // rotation the section's content is always fully under the current epoch, but a
  // frame posted just before the switch may still carry the previous version.



  // Keep the shared recipe hero in step with the collaborative cover asset.

  // The Members popup: accepted members, plus invites for the owner.





  // ---- Presence: who is here, where their cursor is (ephemeral, encrypted) ----



  // Textarea caret coordinates via an offscreen mirror with identical metrics.






  // Local edits go through an outbox so nothing is lost while offline or when a
  // POST fails: queued Yjs updates are retried until the server acks them. A 409
  // means the section key moved under us, so the full local state is compacted
  // instead (which also clears the queue).






  // Fetch and unlock the new epoch key after the owner rotates, and switch to it.




  // Start a connection: create a shared section for the person (no note yet).
  // They receive a "<you> wants to connect with you" request to accept.

  // New-note entry in the Shared tree: ask which template to start from first.


  // Start a shared note from the same templates used by All Notes.

  // Add a subfolder under an existing shared folder (persisted in group meta).




  // Owner-side key rotation: generate a new epoch key, re-encrypt every note in
  // the section under it, publish a wrap per remaining member, then commit the new
  // version. Reusing the server only as blob storage; the key itself is never sent.
  // When `remove` names a member, the server removes them and bumps the epoch in a
  // single transaction, so the two can never diverge.

  // Section-scoped rotation used when a section is flagged rekey_needed: a member
  // left or deleted their account. Any remaining member holding the key can rotate
  // — new epoch, re-wrap for everyone still in the section, re-encrypt the notes.



  // A member leaves a shared section: remove ourselves. The server flags the
  // section so a remaining member rotates the key on next open (the server holds
  // no key to rotate with).




  // Popup: ask who the new shared section is for.





  // Bottom "+ New note" opens the same popup (a new person = a new section).


  // The Shared view: one section per person, each holding automatically-shared notes.
   // groupId -> unwrapped group key
   // groupId -> [folder, ...]
   // groupId -> [tag, ...] (owner-curated, section-level)
   // groupId -> owner username


    // noteId -> { title, folder, tags, groupId }
   // noteId -> plaintext body (session cache for body: search)



   // `${groupId}::${folder}` collapsed folders

  // Every folder key (including ancestors) across all shared sections, for the
  // sidebar's collapse-all/expand-all control in the Shared view.




  // Sidebar Shared badge: number of connections (plus pending invitations).








  // Drag-and-drop: move a note into a folder (no prompt).

  // Drag-and-drop: reparent a folder (with its subfolders and notes).




  // ---- Owner-only section settings: a section-level tag list -----------------











  // Right-click menu for shared notes and folders.






  // Keyboard-accessible delete: mirrors the context-menu rules exactly —
  // binned notes ask for permanent-confirm, important-tagged notes ask for
  // confirm, everything else soft-deletes straight into Bin.



  // Fill the shared in-app confirm popup (eyebrow/title/name/message). Name is set via textContent — never HTML.


  // Popup: delete an important-tagged note (moves to Bin, restorable for 3 days).


  // Popup: permanently erase one binned note (no recovery).


  // Popup: permanently erase the whole Bin (shows the doomed count).


  // Hide the confirm popup and clear the pending action.


  // Run the pending popup action: soft/permanent/empty/folder/folder-permanent.


  // Delegated right-click handling on the note list; closes on outside click, resize, scroll and Escape.


  // ---- Private Vault (user-facing feature) ----------------------------------
  // Password-locked secret notes behind the single Vault menu button. This is
  // separate from the login AND from the E2EE key vault above: vault items live
  // inside the E2EE notes blob as per-item AES-GCM ciphertexts under the vault
  // key, so the server sees nothing. Only a verifier + wrapped vault key persist
  // server-side (vault_meta table). Locked state keeps ciphertext (`blobs`) so
  // a background sync can never wipe secrets; plaintext exists in memory only
  // while unlocked (wiped on lock/logout/reload).
  state.vault = { unlocked: false, dek: null, notes: [], blobs: [], meta: null, folders: [] };


  // Vault folder names: flat, trimmed, no slashes, capped. Shared by envelope
  // reads and the add/rename dialogs.





  // Ciphertext staged for upload: freshly encrypted while unlocked, retained
  // blobs while locked (a background sync can never erase secrets).


  // Open a vault note in the editor (preview-first, like normal notes).


  // Save the open vault note into memory; the debounced envelope sync persists it.


  // + New secret note entry: like + New Note outside the Vault — asks for the
  // folder first (only when folders exist), then the template.


  // Folder destination picker for new vault notes. Reuses the shared
  // folder-pick overlay with vault entries (root first).


  // Create a vault note from a template into the picked folder (or Vault root).






  // ---- Vault folders (flat, dev): explicit list in the envelope so empty
  // folders survive. Notes carry folder (or null for Vault root).







  // Delete a vault folder immediately (no Bin in the vault): its notes move to
  // the Vault root and everything syncs encrypted as usual.


  // Render the Vault view: lock notice when locked, otherwise one Vault folder
  // with the decrypted notes. Counts/footer mirror the normal list shape.


  // Toggle the vault-only action buttons and the nav lock icon.



  // Wipe vault plaintext (keeping ciphertext blobs AND the folder list) and
  // leave the view. Folders stay so a background sync while locked can never
  // strand or erase them from the envelope.


  // Vault password modal: 'setup' (first run), 'unlock', or 'reset-confirm'.
  // reset-confirm reuses the masked unlock password field for the LOGIN
  // password proof (no window.prompt plaintext shoulder-surfing).











  document.getElementById('vault-confirm').addEventListener('click', async () => {
    if (state.vaultModalMode === 'setup') await setupVaultFromModal();
    else if (state.vaultModalMode === 'reset-confirm') await resetVault();
    else await unlockVaultFromModal();
  });
  document.getElementById('vault-cancel').addEventListener('click', closeVaultModal);
  document.getElementById('close-vault').addEventListener('click', closeVaultModal);
  document.getElementById('vault-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'vault-overlay') closeVaultModal();
  });
  document.getElementById('vault-overlay').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
      event.preventDefault();
      document.getElementById('vault-confirm').click();
    }
  });
  document.getElementById('vault-reset-link').addEventListener('click', () => setVaultModal('reset-confirm'));
  document.getElementById('new-vault-note').addEventListener('click', onNewVaultNoteClick);
  document.getElementById('lock-vault').addEventListener('click', lockVault);

  // Detect a trailing file extension typed in the title and switch the note type instead.
  // Persist title/body from the editor (debounced server sync); refuses deleted/archived notes.


  // De-duplicate a note title (case-insensitive) by appending a counter.
  // Binned notes don't squat names — only live ones count.


  // ---- Templates, toasts, editor formatting commands ----


  // Single source of truth for the New-note chooser, shared by All Notes and the
  // Shared view so the two pickers are always identical.


  // One seed used by both All Notes and the Shared view, so editing a template's
  // title/body is mirrored everywhere a new note is created from it.


  // Create a note from a template (Standard/Recipe/To-Do) into the current view+collection and open it.


  // Shortcut for a blank Standard note.


  // Show the New-note template chooser popup.


  // Hide the template chooser popup.


  // Folder picked in a bare section view, awaiting template choice.
  // Template picked while unfiled, awaiting a folder choice (folder-required rule).

  // + New note entry: a bare section view (no folder picked) asks for the
  // destination folder first, so the note lands where the user wants. A section
  // with no folders yet cannot file anything — say so instead of silently
  // creating an invisible note.


  // Order picker entries like the expanded workspace note list: a parent is
  // followed immediately by all its children (recursively), matching the
  // strip's tree grouping. Roots/orphans keep the section's list order.


  // Fill + show the folder chooser. With (ns, sectionId) it lists one section
  // (bare-section flow, resumes at the template picker). With no args it lists
  // every folder in the workspace (folder-required gate, resumes a parked
  // template choice). Returns false when there is nothing to choose.




  // Show a transient bottom-right status message (single timer, latest wins).
  // In-app input prompt (replaces window.prompt everywhere: native prompts are
  // unmasked plaintext, unstyled, and block automation/testing). One-shot
  // promise: resolves the typed string, or null on cancel/Esc/overlay click.
  // A second call while open resolves the first waiter with null.
  // True when the open note is not Markdown (formatting tools stay disabled).


  // Wrap the editor selection (or placeholder word) with a Markdown marker and save.


  // Insert a Markdown line prefix (heading/list/quote) at the start of the current line and save.


  document.getElementById('new-note').addEventListener('click', onNewNoteClick);
  document.getElementById('close-templates').addEventListener('click', closeTemplatePicker);
  document.getElementById('template-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'template-overlay') closeTemplatePicker();
  });
  document.getElementById('close-folder-pick').addEventListener('click', closeFolderPicker);
  document.getElementById('folder-pick-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'folder-pick-overlay') closeFolderPicker();
  });
  // Section icon picker: close button, backdrop click, and icon choice.
  document.getElementById('close-section-icon').addEventListener('click', closeSectionIconPicker);
  document.getElementById('section-icon-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'section-icon-overlay') closeSectionIconPicker();
  });
  document.getElementById('section-icon-grid').addEventListener('click', (event) => {
    const choice = event.target.closest('[data-icon-choice]');
    if (choice) chooseSectionIcon(choice.dataset.iconChoice);
  });
  // Note tag editor wiring.
  document.getElementById('close-tag-editor').addEventListener('click', closeTagEditor);
  document.getElementById('tag-editor-done').addEventListener('click', closeTagEditor);
  document.getElementById('tag-editor-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'tag-editor-overlay') closeTagEditor();
  });
  document.getElementById('tag-editor-current').addEventListener('click', (event) => {
    const remove = event.target.closest('[data-tag-remove]');
    if (remove) tagEditorRemove(remove.dataset.tagRemove);
  });
  document.getElementById('tag-editor-suggest').addEventListener('click', (event) => {
    const add = event.target.closest('[data-tag-add]');
    if (add) tagEditorAdd(add.dataset.tagAdd);
  });
  document.getElementById('tag-editor-add-btn').addEventListener('click', () => {
    const input = document.getElementById('tag-editor-input');
    if (input) { tagEditorAdd(input.value); input.value = ''; input.focus(); }
  });
  document.getElementById('tag-editor-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      event.stopPropagation();
      tagEditorAdd(event.target.value);
      event.target.value = '';
    }
  });
  // Note view: the inline "+" next to a note's tags opens the tag editor for the
  // exact note the button was rendered for (same modal as the note menu's
  // "Tags…"). Binding by id means a stale/other view can never tag a wrong note.
  if (tagList) tagList.addEventListener('click', (event) => {
    const btn = event.target.closest('.tag-add');
    if (!btn) return;
    if (btn.dataset.sharedTagAdd || state.collab.noteId) { openSharedTagEditor(); return; }
    const id = btn.dataset.noteId;
    if (id) openTagEditor(id);
  });
  // Shared view wiring: sections create notes; rows open the live editor.
  noteList.addEventListener('click', (event) => {
    const iacc = event.target.closest('[data-invite-accept]');
    if (iacc) { event.preventDefault(); acceptInvite(iacc.dataset.inviteAccept); return; }
    const idec = event.target.closest('[data-invite-decline]');
    if (idec) { event.preventDefault(); declineInvite(idec.dataset.inviteDecline); return; }
    const stog = event.target.closest('[data-shared-toggle]');
    if (stog) {
      event.preventDefault(); event.stopPropagation();
      const k = sharedFolderKey(stog.dataset.sharedGroup, stog.dataset.sharedToggle);
      if (sharedCollapsed.has(k)) sharedCollapsed.delete(k); else sharedCollapsed.add(k);
      renderSharedView();
      updateFoldToggle();
      return;
    }
    const ndel = event.target.closest('[data-collab-note-delete]');
    if (ndel) { event.preventDefault(); event.stopPropagation(); collabDeleteNote(ndel.dataset.collabNoteDelete); return; }
    const nfol = event.target.closest('[data-note-folder]');
    if (nfol) { event.preventDefault(); event.stopPropagation(); moveSharedNote(nfol.dataset.noteFolder, nfol.dataset.noteGroup); return; }
    const gdel = event.target.closest('[data-group-delete]');
    if (gdel) { event.preventDefault(); event.stopPropagation(); confirmDeleteGroup(gdel.dataset.groupDelete); return; }
    const gadd = event.target.closest('[data-group-addfolder]');
    if (gadd) { event.preventDefault(); event.stopPropagation(); addSharedFolder(gadd.dataset.groupAddfolder); return; }
    const gleave = event.target.closest('[data-group-leave]');
    if (gleave) { event.preventDefault(); event.stopPropagation(); leaveSharedSection(gleave.dataset.groupLeave); return; }
    const gset = event.target.closest('[data-group-settings]');
    if (gset) { event.preventDefault(); event.stopPropagation(); openSectionSettings(gset.dataset.groupSettings); return; }
    const fnote = event.target.closest('[data-folder-note]');
    if (fnote) { event.preventDefault(); event.stopPropagation(); openSharedNewNote(fnote.dataset.folderGroup, fnote.dataset.folderNote); return; }
    const fsub = event.target.closest('[data-folder-sub]');
    if (fsub) { event.preventDefault(); event.stopPropagation(); addSubfolder(fsub.dataset.folderGroup, fsub.dataset.folderSub); return; }
    const open = event.target.closest('[data-collab-open]');
    if (open) { event.preventDefault(); openCollabNote(open.dataset.collabOpen); return; }
    const newBtn = event.target.closest('#shared-new');
    if (newBtn) { event.preventDefault(); collabCreate(); }
  });
  // Right-click a shared note or folder to act on it.
  noteList.addEventListener('contextmenu', (event) => {
    if (state.activeView !== 'shared') return;
    const folderRow = event.target.closest('.shared-folder');
    if (folderRow) {
      const ref = folderRow.querySelector('[data-folder-note]');
      if (ref) {
        event.preventDefault(); event.stopPropagation();
        showSharedContextMenu('folder', { groupId: ref.dataset.folderGroup, folder: ref.dataset.folderNote }, event.clientX, event.clientY);
        return;
      }
    }
    const noteRow = event.target.closest('[data-collab-open]');
    if (noteRow) {
      event.preventDefault(); event.stopPropagation();
      showSharedContextMenu('note', { noteId: noteRow.dataset.collabOpen, groupId: noteRow.dataset.collabGroup }, event.clientX, event.clientY);
    }
  });
  {
    const menu = document.getElementById('shared-context-menu');
    if (menu) menu.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-shared-action]');
      if (!btn || !state.sharedMenuTarget) return;
      const action = btn.dataset.sharedAction;
      const t = state.sharedMenuTarget;
      closeSharedContextMenu();
      if (action === 'open') openCollabNote(t.noteId);
      else if (action === 'move') moveSharedNote(t.noteId, t.groupId);
      else if (action === 'delete') {
        state.pendingDeleteId = String(t.noteId); state.pendingDeleteMode = 'collab-note'; state.pendingDeleteTag = null;
        setDeleteDialog({ eyebrow: 'Delete note', title: 'Delete this shared note?', name: `Note #${t.noteId}`, message: '\u201d will be deleted for everyone. This cannot be undone.' });
        const overlay = document.getElementById('delete-overlay');
        if (overlay) { overlay.hidden = false; const b = document.getElementById('confirm-delete'); if (b) b.focus(); }
      }
      else if (action === 'folder-note') openSharedNewNote(t.groupId, t.folder);
      else if (action === 'folder-sub') addSubfolder(t.groupId, t.folder);
      else if (action === 'folder-rename') renameSharedFolder(t.groupId, t.folder);
      else if (action === 'folder-delete') confirmDeleteSharedFolder(t.groupId, t.folder);
    });
    document.addEventListener('click', (event) => { if (state.sharedMenuTarget && !event.target.closest('#shared-context-menu')) closeSharedContextMenu(); });
    document.addEventListener('contextmenu', (event) => { if (state.sharedMenuTarget && !event.target.closest('#shared-context-menu')) closeSharedContextMenu(); }, true);
    window.addEventListener('resize', closeSharedContextMenu);
    noteList.addEventListener('scroll', closeSharedContextMenu, true);
  }
  // Drag-and-drop in the Shared tree: move notes into folders, reparent folders.

  noteList.addEventListener('dragstart', (event) => {
    if (state.activeView !== 'shared') return;
    const folderRow = event.target.closest('.shared-folder');
    const noteRow = event.target.closest('[data-collab-open]');
    let payload = null;
    if (folderRow && folderRow.dataset.sharedFolder != null) {
      payload = { kind: 'folder', folder: folderRow.dataset.sharedFolder, groupId: folderRow.dataset.sharedGroup };
    } else if (noteRow) {
      payload = { kind: 'note', id: noteRow.dataset.collabOpen, groupId: noteRow.dataset.collabGroup };
    }
    if (!payload) return;
    try { event.dataTransfer.setData('application/x-notive-shared', JSON.stringify(payload)); } catch (error) {}
    event.dataTransfer.effectAllowed = 'move';
  });
  noteList.addEventListener('dragover', (event) => {
    if (state.activeView !== 'shared') return;
    const folderRow = event.target.closest('.shared-folder');
    const noteRow = event.target.closest('[data-collab-open]');
    const groupBlock = event.target.closest('.shared-group');
    if (!folderRow && !noteRow && !groupBlock) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    clearSharedDropTargets();
    if (folderRow) folderRow.classList.add('drop-target');
    else if (noteRow) noteRow.classList.add('drop-before');
    else groupBlock.classList.add('drop-target');
  });
  noteList.addEventListener('dragleave', (event) => {
    if (!event.relatedTarget || !noteList.contains(event.relatedTarget)) clearSharedDropTargets();
  });
  noteList.addEventListener('drop', (event) => {
    if (state.activeView !== 'shared') return;
    let payload = null;
    try { payload = JSON.parse(event.dataTransfer.getData('application/x-notive-shared') || 'null'); } catch (error) { payload = null; }
    if (!payload || !payload.kind) return;
    event.preventDefault();
    const folderRow = event.target.closest('.shared-folder');
    const noteRow = event.target.closest('[data-collab-open]');
    let targetFolder = '';
    if (folderRow) targetFolder = folderRow.dataset.sharedFolder || '';
    else if (noteRow) targetFolder = (sharedNoteMeta.get(String(noteRow.dataset.collabOpen)) || {}).folder || '';
    clearSharedDropTargets();
    if (payload.kind === 'note') moveSharedNoteToFolder(payload.id, payload.groupId, targetFolder);
    else if (payload.kind === 'folder') reparentSharedFolder(payload.groupId, payload.folder, targetFolder);
  });
  noteList.addEventListener('dragend', () => clearSharedDropTargets());


  {
    const sharedNewBtn = document.getElementById('shared-new');
    if (sharedNewBtn) sharedNewBtn.addEventListener('click', collabCreate);
    const refreshBtn = document.getElementById('refresh-view');
    if (refreshBtn) refreshBtn.addEventListener('click', () => { try { refreshCurrent(); } catch (error) {} });
  }
  document.getElementById('close-collab-new').addEventListener('click', closeCollabNewDialog);
  document.getElementById('collab-new-cancel').addEventListener('click', closeCollabNewDialog);
  document.getElementById('collab-new-create').addEventListener('click', confirmCollabNew);
  document.getElementById('collab-new-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'collab-new-overlay') closeCollabNewDialog();
  });
  document.getElementById('collab-pending').addEventListener('click', openCollabPending);
  document.getElementById('close-collab-pending').addEventListener('click', closeCollabPending);
  document.getElementById('collab-pending-done').addEventListener('click', closeCollabPending);
  document.getElementById('collab-pending-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'collab-pending-overlay') closeCollabPending();
  });
  document.getElementById('collab-pending-list').addEventListener('click', (event) => {
    const cancel = event.target.closest('[data-cancel-invite]');
    if (cancel) { event.preventDefault(); cancelCollabInvite(cancel.dataset.cancelInvite); return; }
    const remove = event.target.closest('[data-remove-member]');
    if (remove) { event.preventDefault(); collabRemoveMember(remove.dataset.removeMember); }
  });
  document.getElementById('close-section-settings').addEventListener('click', closeSectionSettings);
  document.getElementById('section-settings-done').addEventListener('click', closeSectionSettings);
  document.getElementById('section-settings-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'section-settings-overlay') closeSectionSettings();
  });
  document.getElementById('section-tags-current').addEventListener('click', (event) => {
    const rm = event.target.closest('[data-section-tag-remove]');
    if (rm) sectionTagRemove(rm.dataset.sectionTagRemove);
  });
  document.getElementById('section-tags-add-btn').addEventListener('click', () => {
    const input = document.getElementById('section-tags-input');
    if (input) { sectionTagAdd(input.value); input.value = ''; input.focus(); }
  });
  document.getElementById('section-invite-btn').addEventListener('click', sectionInviteMember);
  document.getElementById('section-invite-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); sectionInviteMember(); }
  });
  document.getElementById('section-tags-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      event.stopPropagation();
      sectionTagAdd(event.target.value);
      event.target.value = '';
    }
  });
  document.getElementById('collab-new-members').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); confirmCollabNew(); }
  });
  document.getElementById('collab-invite').addEventListener('click', collabInvite);
  document.getElementById('collab-delete').addEventListener('click', () => {
    if (!state.collab.noteId) return;
    const id = state.collab.noteId;
    state.pendingDeleteId = String(id);
    state.pendingDeleteMode = 'collab-note';
    state.pendingDeleteTag = null;
    setDeleteDialog({ eyebrow: 'Delete note', title: 'Delete this shared note?', name: `Note #${id}`, message: '” will be deleted for everyone in this section. This cannot be undone.' });
    const overlay = document.getElementById('delete-overlay');
    if (overlay) {
      overlay.hidden = false;
      const confirmBtn = document.getElementById('confirm-delete');
      if (confirmBtn) confirmBtn.focus();
    }
  });
  // Settings → Tags: rename / delete across all notes.
  document.getElementById('settings-tag-list').addEventListener('click', (event) => {
    const rename = event.target.closest('[data-tag-rename]');
    if (rename) {
      const oldName = rename.dataset.tagRename;
      askInput({ eyebrow: 'Rename tag', title: oldName, desc: 'Renames this tag on every note.', label: 'Tag name', password: false, placeholder: oldName, okText: 'Rename' }).then((value) => {
        if (value == null) return;
        if (!renameTagEverywhere(oldName, value)) showToast('Tag not changed');
        renderSettingsTags();
      });
      return;
    }
    const del = event.target.closest('[data-tag-delete]');
    if (del) {
      const name = del.dataset.tagDelete;
      state.pendingDeleteId = '__TAG__';
      state.pendingDeleteMode = 'tag';
      state.pendingDeleteTag = name;
      setDeleteDialog({ eyebrow: 'Delete tag', title: 'Delete this tag?', name, message: '” will be removed from every note. This cannot be undone.' });
      const overlay = document.getElementById('delete-overlay');
      if (overlay) {
        overlay.hidden = false;
        const confirmBtn = document.getElementById('confirm-delete');
        if (confirmBtn) confirmBtn.focus();
      }
    }
  });
  document.getElementById('template-overlay').addEventListener('click', (event) => {
    const option = event.target.closest('#template-options .template-option[data-template]');
    if (!option) return;
    const shared = state.pendingSharedTemplate;
    state.pendingSharedTemplate = null;
    const forVault = state.vaultTemplatePending;
    state.vaultTemplatePending = false;
    closeTemplatePicker();
    if (shared) { createSharedNoteWithTemplate(shared.groupId, shared.folder, option.dataset.template); return; }
    if (forVault) { createVaultNoteFromTemplate(option.dataset.template); return; }
    createNoteFromTemplate(option.dataset.template);
  });
  document.getElementById('close-delete').addEventListener('click', closeDeleteConfirm);
  document.getElementById('cancel-delete').addEventListener('click', closeDeleteConfirm);
  document.getElementById('confirm-delete').addEventListener('click', confirmPendingDelete);
  // Delete removes the marked workspace note (same rules as the menu:
  // Bin confirm for binned/important notes, direct soft-delete otherwise).
  // Backspace never deletes: too easy to hit while focus sits outside the
  // editor. Ignored while typing, while logged out, inside any popup, or in
  // the Vault view (vault notes keep their own delete UI).
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Delete') return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target;
    if (target && (target.isContentEditable
      || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''))) return;
    if (!state.cachedProfile || !e2ee.masterKey) return;
    if (!document.getElementById('login-overlay').hidden) return;
    if (document.querySelector('.modal-overlay:not([hidden])')) return;
    if (document.querySelector('.context-menu:not([hidden])')) return;
    if (state.activeView === 'vault') return;
    if (!state.currentId) return;
    event.preventDefault();
    requestDeleteNoteById(state.currentId);
  });
  document.getElementById('delete-overlay').addEventListener('click', (event) => {
    if (event.target.id === 'delete-overlay') closeDeleteConfirm();
  });
  titleInput.addEventListener('input', saveCurrentNote);
  markdownInput.addEventListener('input', saveCurrentNote);
  markdownInput.addEventListener('input', () => collabPresenceLocal(true));
  markdownInput.addEventListener('keyup', () => collabPresenceLocal(true));
  markdownInput.addEventListener('click', () => collabPresenceLocal(false));
  markdownInput.addEventListener('select', () => collabPresenceLocal(false));
  initCheckboxOverlay();
  initTodoEditor();
  document.getElementById('recipe-desc').addEventListener('input', saveCurrentNote);
  document.getElementById('recipe-photo-btn').addEventListener('click', () => { if (state.collab.noteId) requestCollabCoverUpload(); else requestCoverUpload(); });
  // Structured recipe body: toggle, edit, add and remove Ingredients / Method.

  if (recipeBodyEl) {
    recipeBodyEl.addEventListener('click', (event) => {
      const toggle = event.target.closest('[data-recipe-toggle]');
      if (toggle) {
        const i = Number(toggle.dataset.recipeToggle);
        recipeMutate((data) => { if (data.ingredients[i]) data.ingredients[i].d = !data.ingredients[i].d; });
        renderRecipeBody(null);
        return;
      }
      const remIng = event.target.closest('[data-recipe-remove-ing]');
      if (remIng) {
        const i = Number(remIng.dataset.recipeRemoveIng);
        recipeMutate((data) => { data.ingredients.splice(i, 1); });
        renderRecipeBody(null);
        return;
      }
      const remStep = event.target.closest('[data-recipe-remove-step]');
      if (remStep) {
        const i = Number(remStep.dataset.recipeRemoveStep);
        recipeMutate((data) => { data.steps.splice(i, 1); });
        renderRecipeBody(null);
        return;
      }
      if (event.target.closest('#recipe-add-ingredient')) {
        recipeMutate((data) => { data.ingredients.push({ t: '', d: false }); });
        renderRecipeBody(null);
        focusRecipeField('[data-recipe-ing]', 'last');
        return;
      }
      if (event.target.closest('#recipe-add-step')) {
        recipeMutate((data) => { data.steps.push(''); });
        renderRecipeBody(null);
        focusRecipeField('[data-recipe-step]', 'last');
      }
    });
    recipeBodyEl.addEventListener('input', (event) => {
      const ing = event.target.closest('[data-recipe-ing]');
      if (ing) {
        ing.style.height = 'auto';
        ing.style.height = `${ing.scrollHeight}px`;
        const i = Number(ing.dataset.recipeIng);
        recipeMutate((data) => { if (data.ingredients[i]) data.ingredients[i].t = ing.value; });
        return;
      }
      const step = event.target.closest('[data-recipe-step]');
      if (step) {
        step.style.height = 'auto';
        step.style.height = `${step.scrollHeight}px`;
        const i = Number(step.dataset.recipeStep);
        recipeMutate((data) => { data.steps[i] = step.value; });
      }
    });
    recipeBodyEl.addEventListener('keydown', (event) => {
      const el = event.target.closest('[data-recipe-step], [data-recipe-ing]');
      if (!el || event.key !== 'Enter' || event.shiftKey) return;
      event.preventDefault();
      if (el.dataset.recipeStep != null) {
        const i = Number(el.dataset.recipeStep);
        recipeMutate((data) => { data.steps.splice(i + 1, 0, ''); });
        renderRecipeBody(null);
        focusRecipeField('[data-recipe-step]', i + 1);
      } else {
        const i = Number(el.dataset.recipeIng);
        recipeMutate((data) => { data.ingredients.splice(i + 1, 0, { t: '', d: false }); });
        renderRecipeBody(null);
        focusRecipeField('[data-recipe-ing]', i + 1);
      }
    });
  }

  let searchDebounce = null;
  let lastSearchQuery = '';
  document.getElementById('search-input').addEventListener('input', (event) => {
    const q = String(event.target.value || '').slice(0, 200);
    if (q === lastSearchQuery) return;
    lastSearchQuery = q;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      state.searchQuery = q;
      renderNoteList();
    }, 150);
  });

  document.querySelectorAll('.filter-chip').forEach((chip) => chip.addEventListener('click', () => {
    state.activeFilter = chip.dataset.filter;
    document.querySelectorAll('.filter-chip').forEach((item) => item.classList.toggle('active', item === chip));
    updateListHeading();
    renderNoteList();
  }));

  // Expand/shrink all folder contents (button at the right end of the filter
  // row, beside "Starred"). State is inferred: any collapsible folder still
  // open -> collapse everything; otherwise expand everything. The chevron
  // points down when folders are expanded (click = collapse) and flips when
  // everything is already collapsed.



  const listBackBtn = document.getElementById('list-back');
  if (listBackBtn) listBackBtn.addEventListener('click', () => stepListBack());

  if (foldToggle) {
    foldToggle.addEventListener('click', () => {
      if (state.activeView === 'shared') {
        const keys = sharedAllFolderKeys();
        const anyOpen = keys.some((key) => !sharedCollapsed.has(key));
        if (anyOpen) keys.forEach((key) => sharedCollapsed.add(key));
        else keys.forEach((key) => sharedCollapsed.delete(key));
        renderSharedView();
        updateFoldToggle();
        return;
      }
      const anyOpen = visibleFolderPaths().some((folder) => !state.collapsedFolders.has(folder));
      if (anyOpen) visibleFolderPaths().forEach((folder) => state.collapsedFolders.add(folder));
      else visibleFolderPaths().forEach((folder) => state.collapsedFolders.delete(folder));
      persistCollapsedFolders();
      renderNoteList();
    });
  }

  // Display name of a sidebar section.
  // Display folder of a note inside one custom section (null when unassigned).


  // Display name of a sidebar section (all sections share the custom implementation).


  // Persist custom sections + section display names into the encrypted UI vault.


  // Filter the list to a custom section (folder null) or one of its folders.
  // Clears every other filter, like its built-in counterparts.




  // Clear section/folder filters and sidebar highlights (unified custom implementation).


  document.querySelectorAll('.nav-item').forEach((item) => item.addEventListener('click', (event) => {
    event.preventDefault();
    const view = item.dataset.view;
    if (typeof view !== 'string' || !/^(notes|favorites|archive|bin|vault|shared)$/.test(view)) return;
    if (view === 'vault' && !state.vault.unlocked) { openVaultModal(); return; }
    if (state.collab.noteId) closeCollabNote();
    document.querySelectorAll('.nav-item').forEach((nav) => nav.classList.toggle('active', nav === item));
    clearSectionSelection();
    state.activeView = view;
    state.sharedFolder = state.activeView === 'shared' ? state.sharedFolder : null;
    if (state.activeView !== 'shared') state.sharedPerson = null;
    if (state.activeView !== 'vault') state.vaultFolder = null;
    state.searchQuery = '';
    document.getElementById('search-input').value = '';
    // Pick the chip filter, then let updateListHeading() own the heading text so
    // the collapsed workspace-strip name (#workspace-view-icon) always stays in
    // sync (previously favorites/bin/archive set the heading directly, leaving
    // the strip showing the last view that called updateListHeading, e.g. Shared).
    state.activeFilter = view === 'favorites' ? 'favorites' : 'all';
    updateListHeading();
    document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === state.activeFilter));
    renderCustomSections();
    renderNoteList();
  }));

  document.getElementById('empty-bin').addEventListener('click', (event) => {
    event.preventDefault();
    openEmptyBinConfirm();
  });

  preview.addEventListener('click', () => {
    if (state.writeMode === 'preview' && activeEditorNote()) setWriteMode('edit', { focus: true });
  });
  preview.addEventListener('focus', () => {
    if (state.writeMode === 'preview' && activeEditorNote()) setWriteMode('edit', { focus: true });
  });
  if (modeToggle) modeToggle.addEventListener('click', () => {
    const note = activeEditorNote();
    if (!note || note.ext !== 'md') return;
    if (state.writeMode === 'preview') setWriteMode('edit', { focus: true });
    else if (markdownInput.value.trim()) setWriteMode('preview');
    else showToast('Nothing to preview yet');
  });

  document.querySelectorAll('[data-action]').forEach((button) => button.addEventListener('click', () => {
    if (state.writeMode === 'preview') setWriteMode('edit');
    const action = button.dataset.action;
    if (action === 'bold') wrapSelection('**');
    if (action === 'italic') wrapSelection('*');
    if (action === 'code') wrapSelection('`');
    if (action === 'heading') linePrefix('## ');
    if (action === 'bullet') linePrefix('- ');
    if (action === 'check') linePrefix('- [ ] ');
    if (action === 'quote') linePrefix('> ');
    if (action === 'link') wrapSelection('[', '](https://)');
  }));

  document.getElementById('favorite-button').addEventListener('click', () => {
    const note = activeEditorNote();
    if (!note) return;
    if (note.deleted) { showToast('Restore this note to edit it'); return; }
    if (note.archived) { showToast('Unarchive this note to edit it'); return; }
    note.favorite = !note.favorite;
    updateMeta(note);
    persistNotes();
    renderNoteList();
    showToast(note.favorite ? 'Added to favorites' : 'Removed from favorites');
  });

  // Strip Markdown syntax from a body, keeping the raw text: headings lose #,
  // emphasis loses markers, lists keep a dash, blockquotes lose >, code fences
  // lose backticks, images become their alt text, links become label (url).


  if (typeBadge) typeBadge.addEventListener('click', () => {
    if (state.collab.noteId) return; // shared notes are always Markdown
    const note = activeEditorNote();
    if (!note) return;
    if (note.deleted) { showToast('Restore this note to edit it'); return; }
    if (note.archived) { showToast('Unarchive this note to edit it'); return; }
    const order = ['md', 'txt', 'json', 'yaml'];
    const next = order[(order.indexOf(note.ext) + 1) % order.length];
    // Markdown never survives a switch to plain text: the syntax markers are
    // stripped from this note's body (raw text kept).
    if (next === 'txt' && note.ext === 'md' && typeof note.body === 'string' && note.body) {
      const stripped = stripMarkdown(note.body);
      if (stripped !== note.body) {
        note.body = stripped;
        markdownInput.value = note.body;
        showToast('Markdown formatting removed');
      }
    }
    note.ext = next;
    state.writeMode = 'edit';
    clearTimeout(state.idleTimer);
    renderPreview(note);
    resetIdleTimer();
    persistNotes();
    renderNoteList();
    const typeNames = { md: 'Markdown (.md)', txt: 'plain text (.txt)', json: 'JSON (.json)', yaml: 'YAML (.yaml)' };
    showToast(`Switched to ${typeNames[note.ext]}`);
  });

  if (beautifyBtn) beautifyBtn.addEventListener('click', applyBeautify);


  if (importNotesBtn) importNotesBtn.addEventListener('click', () => importInput.click());
  document.getElementById('cover-add').addEventListener('click', requestCoverUpload);
  document.getElementById('cover-change').addEventListener('click', requestCoverUpload);
  document.getElementById('cover-remove').addEventListener('click', removeCover);
  document.getElementById('cover-repos').addEventListener('click', enterCoverRepos);
  document.getElementById('cover-done').addEventListener('click', () => exitCoverRepos(true));
  document.getElementById('cover-input').addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) { if (state.collab.noteId) handleCollabCoverFile(file); else handleCoverFile(file); }
  });
  // Reposition by dragging the banner on the note itself (buttons opt out).

  document.getElementById('cover-wrap').addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    coverDragStart(event, event.clientY);
  });
  document.getElementById('cover-wrap').addEventListener('pointermove', (event) => {
    if (state.coverDragging) moveCoverOnNote(event.clientY);
  });
  document.getElementById('cover-wrap').addEventListener('pointerup', () => endCoverDrag());
  document.getElementById('cover-wrap').addEventListener('pointercancel', () => endCoverDrag());
  document.getElementById('cover-wrap').addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    coverDragStart(event, event.clientY);
  });
  document.addEventListener('mousemove', (event) => {
    if (state.coverDragging) moveCoverOnNote(event.clientY);
  });
  document.addEventListener('mouseup', () => endCoverDrag());
  const MAX_IMPORT_FILES = 20;
  const MAX_IMPORT_BYTES_PER_FILE = 1024 * 1024;
  const MAX_IMPORT_BYTES_TOTAL = 5 * 1024 * 1024;
  importInput.addEventListener('change', async (event) => {
    const picked = [...(event.target.files || [])].filter((file) => /\.(md|markdown|txt|text|json|yaml|yml)$/i.test(file.name || ''));
    if (!picked.length) { showToast('Choose .md, .txt, .json or .yaml files to import'); return; }
    if (picked.length > MAX_IMPORT_FILES) { showToast(`Choose up to ${MAX_IMPORT_FILES} files at once`); importInput.value = ''; return; }
    let imported = 0;
    let totalBytes = 0;
    for (const file of picked) {
      try {
        if (typeof file.size === 'number' && file.size > MAX_IMPORT_BYTES_PER_FILE) { showToast(`Skipped ${file.name}: over 1 MB`); continue; }
        const text = await file.text();
        if (text.length > MAX_IMPORT_BYTES_PER_FILE) { showToast(`Skipped ${file.name}: over 1 MB`); continue; }
        totalBytes += text.length;
        if (totalBytes > MAX_IMPORT_BYTES_TOTAL) { showToast('Import stopped: 5 MB total limit'); break; }
        const rawBase = String(file.name || 'Untitled note').replace(/\.[^.]+$/, '').trim().slice(0, 180) || 'Untitled note';
        const base = rawBase.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
        const ext = /\.json$/i.test(file.name) ? 'json'
          : (/\.(yaml|yml)$/i.test(file.name) ? 'yaml'
          : (/\.(txt|text)$/i.test(file.name) ? 'txt' : 'md'));
        // F-41: recognize our own .json backup export and restore it (tags,
        // recipe structures, etc. round-trip via migrateNote) instead of
        // importing the backup as one opaque text note.
        if (ext === 'json' && text.trim().startsWith('{') && text.length < MAX_IMPORT_BYTES_PER_FILE) {
          try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.app === 'Notive' && Array.isArray(parsed.notes)) {
              await adoptNotesEnvelope({
                v: 2,
                notes: parsed.notes.filter((note) => note && !note.deleted).slice(0, 2000),
                vault: [],
                vaultFolders: [],
              });
              state.currentId = state.notes.length ? state.notes[0].id : state.currentId;
              imported += 1;
              continue;
            }
          } catch (error) { /* not a Notive backup: import as note below */ }
        }
        // F-41: .md/.txt imports round-trip front-matter (title + tags).
        let importBody = text || (ext === 'md' ? `# ${base}\n` : '');
        let importTags = [];
        if (ext === 'md' || ext === 'txt') {
          const fm = parseMarkdownFrontMatter(importBody);
          if (fm.meta) {
            importTags = fm.meta.tags;
            importBody = fm.body;
          }
        }
        const note = {
          id: newNoteId(),
          title: uniqueTitle(base),
          date: 'Now',
          updatedAt: Date.now(),
          tags: importTags,
          favorite: false,
          archived: false,
          deleted: false,
          ext,
          sections: (state.activeCustom && state.activeCustom.folder) ? { [state.activeCustom.section]: state.activeCustom.folder } : {},
          body: importBody.slice(0, 500000)
        };
        ensureNoteFiled(note);
        state.notes.unshift(note);
        if (imported === 0) state.currentId = note.id;
        imported += 1;
      } catch (error) { /* skip unreadable files */ }
    }
    importInput.value = '';
    if (imported) {
      state.activeFilter = 'all';
      document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
      syncCustomSections();
      renderCustomSections();
      selectNote(state.currentId);
      persistNotes();
      try { import('./data/sync.js').then((m) => { try { m.syncNow().catch(() => {}); } catch (error) {} }); } catch (error) {}
      showToast(`Imported ${imported} file${imported === 1 ? '' : 's'}`);
    }
  });

  const importJsonBtn = document.getElementById('import-json-btn');
  const importJsonInput = document.getElementById('import-json-input');
  if (importJsonBtn && importJsonInput) {
    importJsonBtn.addEventListener('click', () => importJsonInput.click());
    importJsonInput.addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0];
      event.target.value = '';
      if (!file) return;
      if (!/\.json$/i.test(file.name || '')) { showToast('Choose a .json file'); return; }
      try {
        const text = await file.text();
        if (text.length > 5 * 1024 * 1024) { showToast('JSON too large (5 MB max)'); return; }
        let data;
        try { data = JSON.parse(text); } catch (e) { showToast('Invalid JSON'); return; }
        // Support envelope {v, notes, ui} (bulk seed), raw array, and single note object
        let notesToImport = [];
        let incomingSections = null;
        if (Array.isArray(data)) notesToImport = data;
        else if (data && Array.isArray(data.notes)) { notesToImport = data.notes; incomingSections = data.ui && Array.isArray(data.ui.customSections) ? data.ui.customSections : null; }
        else if (data && typeof data === 'object' && data.id && data.title !== undefined) notesToImport = [data];
        else { showToast('JSON must contain notes array or a note object'); return; }
        // Adopt the bundle's folders/sections so seeded notes have homes.
        if (incomingSections && typeof applyUiSnapshot === 'function') {
          try { applyUiSnapshot({ customSections: incomingSections, collapsed: [], deletedCustomSections: [] }); } catch (error) {}
        }
        let imported = 0;
        for (const raw of notesToImport) {
          try {
            const base = String(raw.title || raw.name || 'Untitled note').slice(0, 180) || 'Untitled note';
            const note = {
              id: newNoteId(),
              title: uniqueTitle(base),
              date: 'Now',
              updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
              tags: Array.isArray(raw.tags) ? raw.tags.slice(0,20) : [],
              favorite: !!raw.favorite,
              archived: !!raw.archived,
              deleted: !!raw.deleted,
              deletedAt: typeof raw.deletedAt === 'number' ? raw.deletedAt : undefined,
              ext: normalizeExt(raw.ext || 'md'),
              sections: raw.sections && typeof raw.sections === 'object' ? raw.sections : (state.activeCustom && state.activeCustom.folder ? { [state.activeCustom.section]: state.activeCustom.folder } : {}),
              body: String(raw.body || raw.content || raw.text || '').slice(0, 500000)
            };
            ensureNoteFiled(note);
            state.notes.unshift(note);
            if (imported === 0) state.currentId = note.id;
            imported += 1;
            if (state.notes.length > 2000) break;
          } catch (e) {}
        }
        if (imported) {
          state.activeFilter = 'all';
          document.querySelectorAll('.filter-chip').forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === 'all'));
          syncCustomSections();
          renderCustomSections();
          selectNote(state.currentId);
          persistNotes();
          // Phase 2: sync is automatic but also trigger an immediate push so
          // imported notes land on the cloud before any refresh/logout.
          try { import('./data/sync.js').then((m) => { try { m.syncNow().catch(() => {}); } catch (error) {} }); } catch (error) {}
          showToast(`Imported ${imported} note${imported===1?'':'s'} from JSON — syncing…`);
        } else {
          showToast('No notes found in JSON');
        }
      } catch (e) { showToast('Could not read JSON'); }
    });
  }

  document.getElementById('focus-editor').addEventListener('click', () => {
    document.querySelector('.editor-panel').classList.toggle('focus-mode');
    showToast(document.querySelector('.editor-panel').classList.contains('focus-mode') ? 'Focus mode on' : 'Focus mode off');
  });
  document.getElementById('open-sidebar').addEventListener('click', () => document.getElementById('sidebar').classList.add('open'));
  document.getElementById('close-sidebar').addEventListener('click', () => document.getElementById('sidebar').classList.remove('open'));

  // ---- App shell wiring: search, filters, nav, import/export, sidebar collapse ----

  // Panel resizing: drag the handle between the expanded notes panel and the
  // editor to change the panel width. Bounds: 220px–560px (min keeps search +
  // chips usable; max keeps the editor readable). The collapsed strip (55px)
  // is never affected — the handle is hidden in strip/focus modes. Width is
  // persisted per device and re-applied on boot.






  if (panelResizer && notesPanel) {
    let dragging = false;
    panelResizer.addEventListener('pointerdown', (event) => {
      if (document.querySelector('.app-shell.workspace-collapsed')) return;
      dragging = true;
      panelResizer.classList.add('is-dragging');
      document.body.classList.add('is-panel-resizing');
      panelResizer.setPointerCapture(event.pointerId);
    });
    panelResizer.addEventListener('pointermove', (event) => {
      if (!dragging) return;
      applyPanelWidth(event.clientX - notesPanel.getBoundingClientRect().left);
    });
    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      panelResizer.classList.remove('is-dragging');
      document.body.classList.remove('is-panel-resizing');
    };
    panelResizer.addEventListener('pointerup', endDrag);
    panelResizer.addEventListener('pointercancel', endDrag);
    // Double-click resets to the default width (325px) and clears the override.
    panelResizer.addEventListener('dblclick', () => {
      notesPanel.style.flexBasis = '';
      try { localStorage.removeItem('notive-panel-width'); } catch (error) {}
    });
    restorePanelWidth();
  }



  // Collapse/expand the icon-strip sidebar and persist the choice.

  // Whether the sidebar starts collapsed on load (Settings → Side Menu; device-local).

  if (sidebarToggle) {
    setSidebarCollapsed(startCollapsedPref());
    sidebarToggle.addEventListener('click', () => {
      setSidebarCollapsed(!sidebar.classList.contains('collapsed'));
    });
  }


  // Collapse/expand the workspace (notes panel) and persist the choice,
  // mirroring the sidebar collapse. Starts expanded.

  if (workspaceToggle) {
    restoreWorkspaceCollapsed();
    workspaceToggle.addEventListener('click', () => {
      const shell = document.querySelector('.app-shell');
      setWorkspaceCollapsed(shell ? !shell.classList.contains('workspace-collapsed') : false);
    });
  }
  // Re-apply the persisted collapse choice (login, register, boot all land here
  // after their first selection, so the workspace returns as the user left it).


  // ---- Auth & E2EE session, themes, settings, boot ----


  // Auth is handled by the Notive server (server.py) backed by the encrypted
  // SQLite database (notive.db). The browser stores no credentials: the session
  // lives in an HttpOnly cookie and the profile below is in-memory only.
  state.cachedProfile = null;

  // apiFetch() now lives in js/data/api.js (imported above).

  // Ask the server who holds the cookie; caches the profile in memory (null when signed out).

  // --- Per-browser-session unlock -------------------------------------------
  // The master key never touches persistent storage. To survive a page refresh
  // without re-typing the password we keep it in sessionStorage, which the
  // browser wipes when the tab/window closes. Clearing it (logout) or closing
  // the browser locks the vault again.




  // Load the decrypted workspace after an unlock (login or session restore).


  // Display name from an E2EE profile (first + last, falls back to username).

  // Synchronous view of the in-memory session for render code (null when signed out).


  // Avatar initials: first letters of the first two name words, uppercased.

  // --- Profile avatar --------------------------------------------------------
  // Optional user picture. Stored inside the E2EE UI vault (never plaintext on
  // disk/server), rendered as an image in place of the initials.
  // Paint a round avatar element with the picture when set, else its initials.


  // Display profile (name + subtitle) or null when signed out.


  // Paint the sidebar profile card and avatar from the session profile.


  // Show the login gate and focus the username field.

  // Hide the login gate.

  // Server logout, then wipe keys/notes/editor/selection from memory and reset the UI to the gate.
  // Pending edits are flushed to the server FIRST so nothing made in this
  // session is lost by the relog. The per-account encrypted local cache is kept
  // (it needs the master key to read); only legacy plaintext keys are removed.


  // Show the login error message with a shake; defaults to the generic (non-enumerating) text.

  // Client-side password rules (12+ chars, upper, lower, digit, special). The server never sees passwords, so this is the enforcement point for new ones.

  // Switch the gate between Log in and Create account forms. The single tab
  // below the submit button doubles as the way back: it reads "Create account"
  // on the login form and "Log in" on the register form.



  if (tabRegister) tabRegister.addEventListener('click', () => {
    const onRegister = !document.getElementById('register-form').hidden;
    setAuthTab(onRegister ? 'login' : 'register');
  });

  // Derive the KEK and unwrap the account master key into memory (extractable
  // within this page so it can be re-wrapped on rotation/upgrade). Throws on
  // wrong password (vault stays locked). Bundle shape: {kdf, saltAuth,
  // saltEnc, iterations?, encMasterKey} with base64 salts/wrap.

  // One-shot PBKDF2 -> Argon2id lift: re-wraps the SAME master key (exported
  // while unlocked) under a fresh Argon2id KEK. Notes are untouched, so this
  // cannot strand data; failures simply retry on the next login.

  // Password reveal: any .password-eye button toggles its target input between
  // masked and visible. Delegated so it works for every field that opts in.
  document.addEventListener('click', (event) => {
    const eye = event.target.closest && event.target.closest('.password-eye');
    if (!eye) return;
    event.preventDefault();
    const input = document.getElementById(eye.dataset.eye || '');
    if (!input) return;
    const reveal = input.type === 'password';
    input.type = reveal ? 'text' : 'password';
    eye.setAttribute('aria-pressed', reveal ? 'true' : 'false');
    eye.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
    eye.innerHTML = icon(reveal ? 'eye-off' : 'eye');
    try { input.focus({ preventScroll: true }); } catch (error) { input.focus(); }
  });

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.authBusy) return;
    const usernameEl = document.getElementById('login-username');
    const passwordEl = document.getElementById('login-password');
    const submitBtn = event.target.querySelector('button[type="submit"]');
    const username = String(usernameEl.value || '').trim().slice(0, 32);
    const password = String(passwordEl.value || '');
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username) || !password) { loginFail(); return; }
    state.authBusy = true;
    if (submitBtn) submitBtn.disabled = true;
    const done = () => { state.authBusy = false; if (submitBtn) submitBtn.disabled = false; };
    try {
      // Step 1: fetch KDF parameters (identical shape for unknown names, so
      // this reveals nothing beyond what login itself would).
      const kdfResponse = await apiFetch(`/api/kdf-params?username=${encodeURIComponent(username)}`);
      if (!kdfResponse.ok) throw new Error(`HTTP ${kdfResponse.status}`);
      const kdf = await kdfResponse.json();
      let data;
      if (kdf && kdf.e2ee && kdf.saltAuth) {
        // Step 2a: E2EE login — only the auth verifier travels the wire.
        // Argon2id (~1s) or legacy PBKDF2 per the account descriptor; anything
        // else is refused (downgrade protection).
        let authBits;
        if (kdf.kdf === 'argon2id') {
          assertArgon2Params(kdf.params);
          authBits = await argon2id32(password, e2eeB64ToBytes(kdf.saltAuth));
        } else {
          authBits = await e2eeDeriveBits(password, e2eeB64ToBytes(kdf.saltAuth), (kdf.params && kdf.params.i) || 0);
        }
        const loginResponse = await apiFetch('/api/login', {
          method: 'POST',
          body: JSON.stringify({ username, authHash: e2eeBytesToB64(authBits) })
        });
        if (loginResponse.status === 202) {
          // MFA enrolled: password verifier passed, TOTP still required.
          // Unlock the vault now (keys already in 202 body), then prove TOTP
          // to mint the session cookie. Old non-MFA logins never hit this.
          data = await loginResponse.json();
          try {
            await e2eeUnlockWithPassword(username, password, {
              kdf: data.kdf || kdf.kdf || 'pbkdf2',
              saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
              iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
              encMasterKey: data.encMasterKey,
            });
          } catch (error) { done(); loginFail('Could not unlock notes with this password.'); return; }
          const ticket = data.mfaTicket;
          const codeInput = await askInput({
            eyebrow: 'Two-factor authentication', title: 'Enter your code',
            desc: '6-digit code from your authenticator app.',
            label: 'Code', password: false, placeholder: '123456', okText: 'Verify',
          });
          if (!codeInput) { e2eeLock(); done(); loginFail('MFA code required.'); return; }
          const challenge = await apiFetch('/api/mfa/challenge', {
            method: 'POST', body: JSON.stringify({ ticket, code: String(codeInput).trim() }),
          });
          if (!challenge.ok) { e2eeLock(); done(); loginFail('Incorrect MFA code.'); return; }
          data = await challenge.json();
          // data is the profile; keys already unlocked above from the 202 body.
          data.kdf = data.kdf || kdf.kdf;
          data.saltEnc = data.saltEnc || null;
          data.iterations = data.iterations || 0;
          data.encMasterKey = data.encMasterKey || null;
        } else {
          if (!loginResponse.ok) {
            done();
            if (loginResponse.status === 429) loginFail('Too many attempts — try again in a few minutes.');
            else loginFail();
            return;
          }
          data = await loginResponse.json();
          try {
            await e2eeUnlockWithPassword(username, password, {
              kdf: data.kdf || kdf.kdf || 'pbkdf2',
              saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
              iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
              encMasterKey: data.encMasterKey,
            });
          } catch (error) {
            // Email-reset rewrap: verifier is new but the wrapped key still
            // answers to the OLD password. Unlock with it once, then re-wrap
            // under the new password via the normal rotation endpoint.
            if (!state.pendingRewrap || !state.pendingRewrap.password) throw error;
            const oldPw = await askInput({
              eyebrow: 'Recover account', title: 'One last step',
              desc: 'Enter your OLD password once to re-encrypt notes under the new one. It stays on this device.',
              label: 'Old password', password: true, placeholder: '•••••', okText: 'Re-encrypt',
            });
            if (!oldPw) throw error;
            await e2eeUnlockWithPassword(username, oldPw, {
              kdf: data.kdf || kdf.kdf || 'pbkdf2',
              saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
              iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
              encMasterKey: data.encMasterKey,
            });
            const freshSaltAuth = e2eeRandomBytes(16);
            const freshSaltEnc = e2eeRandomBytes(16);
            const freshAuth = await argon2id32(state.pendingRewrap.password, freshSaltAuth);
            const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
            const freshWrap = await e2eeWrapMasterKeyArgon2id(state.pendingRewrap.password, freshSaltEnc, masterRaw);
            const curBits = await argon2id32(state.pendingRewrap.password, state.pendingRewrap.saltAuth);
            await apiFetch('/api/change-password', {
              method: 'POST',
              body: JSON.stringify({
                currentAuth: e2eeBytesToB64(curBits),
                kdf: 'argon2id',
                params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
                authHash: e2eeBytesToB64(freshAuth),
                saltAuth: e2eeBytesToB64(freshSaltAuth),
                saltEnc: e2eeBytesToB64(freshSaltEnc),
                encMasterKey: freshWrap,
              }),
            });
            e2ee.kdf = 'argon2id';
            e2ee.saltAuth = freshSaltAuth;
            e2ee.saltEnc = freshSaltEnc;
            e2ee.iterations = 0;
            state.pendingRewrap = null;
          }
        }
        if (e2ee.kdf !== 'argon2id') {
          try {
            await e2eeUpgradeKdf(username, password);
          } catch (error) { /* vault still works on PBKDF2; retry next login */ }
        }
      } else {
        // Step 2b: legacy account — password login upgrades it to E2EE
        // transparently and returns the fresh wrapped key in one round trip.
        const loginResponse = await apiFetch('/api/login', {
          method: 'POST',
          body: JSON.stringify({ username, password })
        });
        if (!loginResponse.ok) {
          done();
          if (loginResponse.status === 429) loginFail('Too many attempts — try again in a few minutes.');
          else loginFail();
          return;
        }
        data = await loginResponse.json();
        if (data && data.encMasterKey) {
          await e2eeUnlockWithPassword(username, password, data);
        }
      }
      state.cachedProfile = { username: data.username, firstName: data.firstName, lastName: data.lastName, subtitle: data.subtitle, email: data.email || '' };
      const errorEl = document.getElementById('login-error');
      if (errorEl) errorEl.hidden = true;
      passwordEl.value = '';
      hideLogin();
      applyProfile();
      await enterWorkspace();
      await saveSessionUnlock();
      showToast(`Welcome back, ${fullNameOf(state.cachedProfile)}`);
    } catch (error) {
      e2eeLock();
      const message = error && error.message;
      loginFail(message === 'e2ee-unwrap' ? 'Could not unlock notes with this password.'
        : (message && message.indexOf('argon2') === 0) ? 'Security libraries failed integrity check. Hard-refresh and retry.'
        : 'Cannot reach the Notive server. Is it running?');
    }
    done();
  });


  if (registerForm) registerForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (state.authBusy) return;
    const username = String(document.getElementById('register-username').value || '').trim();
    const email = String(document.getElementById('register-email').value || '').trim().slice(0, 254);
    const first = String(document.getElementById('register-first').value || '').trim().slice(0, 40);
    const last = String(document.getElementById('register-last').value || '').trim().slice(0, 40);
    const password = String(document.getElementById('register-password').value || '');
    const confirm = String(document.getElementById('register-confirm').value || '');
    const errorEl = document.getElementById('register-error');
    const fail = (msg) => { if (errorEl) { errorEl.textContent = msg; errorEl.hidden = false; } };
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { fail('Username must be 3-32 chars: letters, numbers, _ or -.'); return; }
    if (!/^[^@\s<>\"]+@[^@\s<>\"]+\.[^@\s<>\"]+$/.test(email)) { fail('A valid email address is required.'); return; }
    if (!first || !last) { fail('First and last name are required.'); return; }
    if (password !== confirm) { fail('Passwords do not match.'); return; }
    const missing = passwordPolicyCheck(password);
    if (missing.length) { fail(`Password needs ${missing.join(', ')}.`); return; }
    state.authBusy = true;
    // Busy state: the server-side weak-password screen can take seconds, so the
    // button must show it (mirrors the login handler's disabled button).
    const regBtn = registerForm ? registerForm.querySelector('button[type="submit"]') : null;
    const regBtnLabel = regBtn ? regBtn.textContent : '';
    if (regBtn) { regBtn.disabled = true; regBtn.textContent = 'Creating account…'; }
    const regDone = () => {
      state.authBusy = false;
      if (regBtn) { regBtn.disabled = false; regBtn.textContent = regBtnLabel; }
    };
    let response;
    try {
      // E2EE+Argon2id registration: brand-new random master key, wrapped
      // locally. The password never leaves this device — only the verifier,
      // salts, descriptor and wrapped key do.
      const saltAuthBytes = e2eeRandomBytes(16);
      const saltEncBytes = e2eeRandomBytes(16);
      const authBits = await argon2id32(password, saltAuthBytes);
      const masterRaw = e2eeRandomBytes(32);
      const wrapped = await e2eeWrapMasterKeyArgon2id(password, saltEncBytes, masterRaw);
      if (!await e2eeTrialUnwrapArgon2id(password, saltEncBytes, wrapped)) {
        fail('Key setup failed locally — not uploaded. Retry.');
        regDone();
        return;
      }
      response = await apiFetch('/api/register', {
        method: 'POST',
        body: JSON.stringify({
          username,
          email,
          kdf: 'argon2id',
          params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
          authHash: e2eeBytesToB64(authBits),
          saltAuth: e2eeBytesToB64(saltAuthBytes),
          saltEnc: e2eeBytesToB64(saltEncBytes),
          encMasterKey: wrapped,
          firstName: first,
          lastName: last
        })
      });
    } catch (error) {
      fail('Cannot reach the Notive server. Is it running?');
      regDone();
      return;
    }
    regDone();
    if (response.status === 202) {
      // Uniform response: the server answers identically whether the name was
      // free or taken, so this message must not distinguish the two cases.
      let message = 'If the username is available, the account was created — please log in';
      try {
        const data = await response.json();
        if (data && typeof data.message === 'string' && data.message) message = data.message;
      } catch (error) {}
      if (errorEl) errorEl.hidden = true;
      // Show Registered Successfully popup before redirecting to login.
      // Toast + tab switch fire in all cases so feedback is guaranteed even if
      // extension overlays (e.g. password managers) suppress the modal.
      showToast('Account created — please log in');
      const createdOverlay = document.getElementById('account-created-overlay');
      if (createdOverlay) {
        try {
          createdOverlay.hidden = false;
          const dismiss = () => {
            createdOverlay.hidden = true;
            showToast('Please log in with your new account');
          };
          const okBtn = document.getElementById('account-created-ok');
          const closeBtn = document.getElementById('close-account-created');
          if (okBtn) okBtn.onclick = dismiss;
          if (closeBtn) closeBtn.onclick = dismiss;
          createdOverlay.onclick = (e) => { if (e.target === createdOverlay) dismiss(); };
        } catch (error) {
          // Extension overlays can break modal wiring; the toast + tab switch
          // still guarantee visible feedback.
          console.error('register-complete:', error);
        }
      }
      setAuthTab('login');
      document.getElementById('login-username').value = username;
      document.getElementById('register-password').value = '';
      document.getElementById('register-confirm').value = '';
    } else if (response.status === 429) {
      fail('Too many attempts — try again in a few minutes.');
    } else {
      try {
        const data = await response.json();
        fail(data.error || 'Could not create account.');
      } catch (error) {
        fail('Could not create account.');
      }
    }
  });
  // Passkey login (option-1): assertion replaces the password verifier for the
  // session; the password is still asked locally afterwards to unwrap the E2EE
  // master key and is never sent. Old password logins are untouched.

  if (passkeyLoginBtn) passkeyLoginBtn.addEventListener('click', async () => {
    const usernameEl = document.getElementById('login-username');
    const passwordEl = document.getElementById('login-password');
    const username = String(usernameEl.value || '').trim().slice(0, 32);
    // Username first: the server can only look up passkeys for a named
    // account, so an empty field gets guidance — never a ceremony attempt.
    if (!username) { loginFail('Enter your username first.'); return; }
    if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) { loginFail(); return; }
    if (state.authBusy) return;
    state.authBusy = true;
    try {
      if (!window.PublicKeyCredential) throw new Error('passkeys unsupported');
      const begin = await apiFetch('/api/passkey/login-begin', {
        method: 'POST', body: JSON.stringify({ username }),
      });
      const opts = await begin.json();
      // Deliberately vague: unknown names and accounts without any passkey
      // all read as a plain login failure (no enrolment oracle).
      if (!begin.ok) {
        state.authBusy = false;
        if (begin.status === 429) {
          loginFail(opts.error || 'Too many attempts — try again in a few minutes.');
        } else {
          loginFail('Login Failed');
        }
        return;
      }
      const cred = await navigator.credentials.get({
        publicKey: {
          challenge: b64urlToBuf(opts.challenge),
          rpId: opts.rpId,
          allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
          timeout: opts.timeout,
          userVerification: opts.userVerification,
          // Ask for the PRF evaluation when the server offers a salt. No salt
          // (or no PRF support) simply yields no secret — password fallback.
          ...(opts.prfSalt ? { extensions: { prf: { eval: { first: b64urlToBuf(opts.prfSalt) } } } } : {}),
        },
      });
      const prfSecret = prfFirstResult(cred);
      const finish = await apiFetch('/api/passkey/login-finish', {
        method: 'POST',
        body: JSON.stringify({
          username,
          id: cred.id,
          rawId: bufToB64url(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: bufToB64url(cred.response.clientDataJSON),
            authenticatorData: bufToB64url(cred.response.authenticatorData),
            signature: bufToB64url(cred.response.signature),
            userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
          },
        }),
      });
      let data;
      let passkeyKeys = null;
      if (finish.status === 202) {
        // MFA still required on top of passkey.
        data = await finish.json();
        passkeyKeys = {
          kdf: data.kdf, saltEnc: data.saltEnc,
          iterations: data.iterations, encMasterKey: data.encMasterKey,
          prfWrap: data.prfWrap || null,
        };
        const codeInput = await askInput({
          eyebrow: 'Two-factor authentication', title: 'Enter your code',
          desc: '6-digit code from your authenticator app.',
          label: 'Code', password: false, placeholder: '123456', okText: 'Verify',
        });
        if (!codeInput) throw new Error('mfa required');
        const ch = await apiFetch('/api/mfa/challenge', {
          method: 'POST',
          body: JSON.stringify({ ticket: data.mfaTicket, code: String(codeInput).trim() }),
        });
        if (!ch.ok) throw new Error('mfa failed');
        const profile = await ch.json();
        data = { ...profile, ...passkeyKeys };
      } else {
        if (!finish.ok) {
          const d = await finish.json().catch(() => ({}));
          throw new Error(d.error || 'Passkey failed.');
        }
        data = await finish.json();
      }
      // Unlock: prefer the PRF secret (no password involved). The PRF wrap is
      // bound to THIS credential — only its authenticator yields the secret.
      // Anything missing (old enrolment, no PRF support) falls back to the
      // password prompt, which never leaves the device.
      let unlocked = false;
      if (prfSecret && data.prfWrap) {
        try {
          e2ee.masterKey = await prfUnwrapMasterKey(prfSecret, cred.id, data.prfWrap);
          e2ee.kdf = data.kdf || 'argon2id';
          unlocked = true;
        } catch (error) { /* fall through to password */ }
      }
      if (!unlocked) {
        let password = String(passwordEl.value || '');
        if (!password) {
          const asked = await askInput({
            eyebrow: 'Unlock notes', title: 'Your password',
            desc: 'Needed once on this device to decrypt notes. It stays local.',
            label: 'Password', password: true, placeholder: '•••••', okText: 'Unlock',
          });
          if (!asked) throw new Error('password required');
          password = asked;
        }
      const kdfR = await apiFetch(`/api/kdf-params?username=${encodeURIComponent(username)}`);
      const kdf = await kdfR.json();
      const unlockBundle = {
        kdf: data.kdf || kdf.kdf || 'pbkdf2',
        saltAuth: kdf.saltAuth, saltEnc: data.saltEnc,
        iterations: data.iterations || (kdf.params && kdf.params.i) || 0,
        encMasterKey: data.encMasterKey,
      };
      try {
        await e2eeUnlockWithPassword(username, password, unlockBundle);
      } catch (error) {
        // Same email-reset rewrap as password login: the verifier is new but
        // the wrapped key still answers to the OLD password. Unlock once with
        // it, then re-wrap under the new password (see password-login path).
        if (!state.pendingRewrap || !state.pendingRewrap.password) throw error;
        const oldPw = await askInput({
          eyebrow: 'Recover account', title: 'One last step',
          desc: 'Enter your OLD password once to re-encrypt notes under the new one. It stays on this device.',
          label: 'Old password', password: true, placeholder: '•••••', okText: 'Re-encrypt',
        });
        if (!oldPw) throw error;
        await e2eeUnlockWithPassword(username, oldPw, unlockBundle);
        const freshSaltAuth = e2eeRandomBytes(16);
        const freshSaltEnc = e2eeRandomBytes(16);
        const freshAuth = await argon2id32(state.pendingRewrap.password, freshSaltAuth);
        const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
        const freshWrap = await e2eeWrapMasterKeyArgon2id(state.pendingRewrap.password, freshSaltEnc, masterRaw);
        const curBits = await argon2id32(state.pendingRewrap.password, state.pendingRewrap.saltAuth);
        await apiFetch('/api/change-password', {
          method: 'POST',
          body: JSON.stringify({
            currentAuth: e2eeBytesToB64(curBits),
            kdf: 'argon2id',
            params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
            authHash: e2eeBytesToB64(freshAuth),
            saltAuth: e2eeBytesToB64(freshSaltAuth),
            saltEnc: e2eeBytesToB64(freshSaltEnc),
            encMasterKey: freshWrap,
          }),
        });
        e2ee.kdf = 'argon2id';
        e2ee.saltAuth = freshSaltAuth;
        e2ee.saltEnc = freshSaltEnc;
        e2ee.iterations = 0;
        state.pendingRewrap = null;
      }
      } // end password fallback (skipped entirely after PRF unlock)
      // Auto-enable passwordless: this login's assertion already produced the
      // passkey's PRF secret, and we now hold the master key (PRF or password).
      // If no wrap is stored yet, store one so future logins need no password.
      if (prfSecret && !data.prfWrap && e2ee.masterKey) {
        try {
          const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
          const prfWrap = await prfWrapMasterKey(prfSecret, cred.id, masterRaw);
          await apiFetch('/api/passkey/prf-wrap', { method: 'POST', body: JSON.stringify({ id: cred.id, prfWrap }) });
        } catch (error) {}
      }
      state.cachedProfile = { username: data.username, firstName: data.firstName, lastName: data.lastName, subtitle: data.subtitle, email: data.email || '' };
      passwordEl.value = '';
      hideLogin();
      applyProfile();
      await enterWorkspace();
      await saveSessionUnlock();
      showToast(`Welcome back, ${fullNameOf(state.cachedProfile)}`);
    } catch (error) {
      e2eeLock();
      const name = error && error.name;
      const msg = error && error.message;
      if (msg === 'mfa required') loginFail('MFA code required.');
      else if (msg === 'e2ee-unwrap') loginFail('Could not unlock notes with this password.');
      else if (msg === 'password required') loginFail('Enter your password to unlock notes.');
      else if (name === 'NotAllowedError' || name === 'AbortError') loginFail('Passkey sign-in was cancelled or timed out.');
      else if (name === 'SecurityError' || (msg && /rp\.?id|origin|relying party/i.test(msg))) loginFail('This passkey can’t be used on this address — open Notive at the exact address you registered it (e.g. https://localhost:5001).');
      else if (name === 'TypeError' || (msg && /failed to fetch|network|load failed/i.test(msg))) loginFail('Cannot reach the Notive server. Is it running?');
      else loginFail(msg || 'Passkey sign-in failed.');
    }
    state.authBusy = false;
  });


  if (changeBtn) changeBtn.addEventListener('click', async () => {
    const current = String(document.getElementById('change-current').value || '');
    const next = String(document.getElementById('change-new').value || '');
    const errorEl = document.getElementById('change-error');
    const missing = passwordPolicyCheck(next);
    if (missing.length) {
      if (errorEl) { errorEl.textContent = `New password needs ${missing.join(', ')}.`; errorEl.hidden = false; }
      return;
    }
    if (!e2ee.masterKey || !e2ee.saltAuth || !e2ee.saltEnc || !state.cachedProfile) {
      if (errorEl) { errorEl.textContent = 'Please log in again, then retry.'; errorEl.hidden = false; }
      return;
    }
    let response;
    let newSaltAuthBytes = null;
    let newSaltEncBytes = null;
    try {
      // Rotation binds to the CURRENT password too: derive its verifier under
      // the account's registered KDF for the proof, then wrap under a fresh
      // Argon2id KEK — all without revealing either password or any key.
      const currentAuthBits = e2ee.kdf === 'argon2id'
        ? await argon2id32(current, e2ee.saltAuth)
        : await e2eeDeriveBits(current, e2ee.saltAuth, e2ee.iterations);
      newSaltAuthBytes = e2eeRandomBytes(16);
      newSaltEncBytes = e2eeRandomBytes(16);
      const newAuthBits = await argon2id32(next, newSaltAuthBytes);
      const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
      const newWrapped = await e2eeWrapMasterKeyArgon2id(next, newSaltEncBytes, masterRaw);
      response = await apiFetch('/api/change-password', {
        method: 'POST',
        body: JSON.stringify({
          currentAuth: e2eeBytesToB64(currentAuthBits),
          kdf: 'argon2id',
          params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
          authHash: e2eeBytesToB64(newAuthBits),
          saltAuth: e2eeBytesToB64(newSaltAuthBytes),
          saltEnc: e2eeBytesToB64(newSaltEncBytes),
          encMasterKey: newWrapped
        })
      });
    } catch (error) {
      if (errorEl) { errorEl.textContent = 'Cannot reach the server.'; errorEl.hidden = false; }
      return;
    }
    if (response.ok) {
      e2ee.kdf = 'argon2id';
      e2ee.saltAuth = newSaltAuthBytes;
      e2ee.saltEnc = newSaltEncBytes;
      e2ee.iterations = 0;
      if (errorEl) errorEl.hidden = true;
      document.getElementById('change-current').value = '';
      document.getElementById('change-new').value = '';
      showToast('Password updated');
    } else {
      try {
        const data = await response.json();
        if (errorEl) { errorEl.textContent = data.error || 'Could not update password.'; errorEl.hidden = false; }
      } catch (error) {
        if (errorEl) { errorEl.textContent = 'Could not update password.'; errorEl.hidden = false; }
      }
    }
  });
  document.getElementById('logout-button').addEventListener('click', logout);
  // --- MFA settings (Two-Factor pane) ---
  // Lost the authenticator? Recover the account (email/recovery code) — that
  // clears MFA, so no separate MFA bypass codes exist by design.




  if (closeMfaQrBtn) closeMfaQrBtn.addEventListener('click', closeMfaQrModal);

  if (mfaQrOverlay) mfaQrOverlay.addEventListener('click', (event) => {
    if (event.target === mfaQrOverlay) closeMfaQrModal();
  });
  if (mfaSetupBtn) mfaSetupBtn.addEventListener('click', async () => {
    const err = document.getElementById('mfa-error');
    try {
      const r = await apiFetch('/api/mfa/setup', { method: 'POST' });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'setup failed');
      document.getElementById('mfa-secret').textContent = data.secret;
      document.getElementById('mfa-otpauth').textContent = data.otpauth;
      // QR first, secret under it (local-only render; secret never fetched remotely).
      try {
        const qrEl = document.getElementById('mfa-qr');
        if (qrEl) {
          qrEl.innerHTML = '';
          if (typeof QRCode !== 'undefined') {
            new QRCode(qrEl, { text: data.otpauth, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.M });
          }
        }
      } catch (error) { /* text secret still usable */ }
      if (err) err.hidden = true;
      document.getElementById('mfa-confirm-code').value = '';
      openMfaQrModal();
    } catch (error) {
      if (err) { err.textContent = error.message || 'Could not start setup.'; err.hidden = false; }
    }
  });

  if (mfaConfirmBtn) mfaConfirmBtn.addEventListener('click', async () => {
    const err = document.getElementById('mfa-error');
    const code = String(document.getElementById('mfa-confirm-code').value || '').trim();
    try {
      const r = await apiFetch('/api/mfa/confirm', { method: 'POST', body: JSON.stringify({ code }) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Incorrect code.');
      }
      document.getElementById('mfa-confirm-code').value = '';
      closeMfaQrModal();
      showToast('MFA enabled');
      await refreshMfaStatus();
    } catch (error) {
      if (err) { err.textContent = error.message; err.hidden = false; }
    }
  });

  if (mfaDisableBtn) mfaDisableBtn.addEventListener('click', async () => {
    const code = await askInput({
      eyebrow: 'Two-factor authentication', title: 'Disable MFA',
      desc: 'Confirm with a 6-digit authenticator code. Lost your device? Recover the account instead.',
      label: 'Code', password: false, placeholder: '123456', okText: 'Disable',
    });
    if (!code) return;
    const r = await apiFetch('/api/mfa/disable', { method: 'POST', body: JSON.stringify({ code: String(code).trim() }) });
    showToast(r.ok ? 'MFA disabled' : 'Incorrect code.');
    await refreshMfaStatus();
  });
  // --- Passkeys (option-1 login factor; password still unlocks E2EE notes) ---
  // PRF passwordless unlock: KEK = SHA-256(authenticator PRF output), used to
  // wrap/unwrap the account master key. MUST match on register (wrap) and login
  // (unwrap) — both sides call this one function.



  // Many authenticators evaluate the PRF only during an assertion (get), not
  // during creation. Run a throwaway get() against the just-created credential to
  // obtain its PRF output, so passwordless unlock works on far more devices. The
  // challenge is local — nothing is sent to the server; only the PRF output is
  // used, to wrap the master key under SHA-256(PRF).

  // Attach a PRF wrap to an existing passkey (no remove/re-add needed), so it can
  // unlock notes without the password. Requires an unlocked session (master key
  // is in memory) and a PRF-capable authenticator.



  if (passkeyAddBtn) passkeyAddBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('passkey-error');
    try {
      if (!window.PublicKeyCredential) throw new Error('Passkeys not supported in this browser.');
      const begin = await apiFetch('/api/passkey/register-begin', { method: 'POST' });
      const opts = await begin.json();
      if (!begin.ok) throw new Error(opts.error || 'Could not start enrolment.');
      const cred = await navigator.credentials.create({
        publicKey: {
          challenge: b64urlToBuf(opts.challenge),
          rp: opts.rp,
          user: { id: b64urlToBuf(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
          pubKeyCredParams: opts.pubKeyCredParams,
          timeout: opts.timeout,
          attestation: opts.attestation,
          authenticatorSelection: opts.authenticatorSelection,
          excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
          // Ask for a PRF evaluation so this device can later unlock notes with
          // NO password. Unsupported authenticators simply omit the result.
          ...(opts.prfSalt ? { extensions: { prf: { eval: { first: b64urlToBuf(opts.prfSalt) } } } } : {}),
        },
      });
      // Wrap the live master key under the PRF secret (when offered). The wrap
      // lets THIS credential unlock notes later; the secret itself is never
      // stored or sent anywhere.
      let prfWrap = null;
      try {
        if (e2ee.masterKey && opts.prfSalt) {
          // Prefer the PRF from the create ceremony; fall back to a follow-up
          // assertion for authenticators that only evaluate PRF on get().
          let prfSecret = prfFirstResult(cred);
          if (!prfSecret) {
            prfSecret = await prfSecretViaAssertion(cred.rawId, opts.rp && opts.rp.id, opts.prfSalt);
          }
          if (prfSecret) {
            const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
            prfWrap = await prfWrapMasterKey(prfSecret, cred.id, masterRaw);
          }
        }
      } catch (error) { prfWrap = null; }
      const finish = await apiFetch('/api/passkey/register-finish', {
        method: 'POST',
        body: JSON.stringify({
          id: cred.id,
          rawId: bufToB64url(cred.rawId),
          type: cred.type,
          response: {
            clientDataJSON: bufToB64url(cred.response.clientDataJSON),
            attestationObject: bufToB64url(cred.response.attestationObject),
          },
          transports: (cred.response.getTransports && cred.response.getTransports()) || [],
          ...(prfWrap ? { prfWrap } : {}),
        }),
      });
      if (!finish.ok) {
        const d = await finish.json().catch(() => ({}));
        throw new Error(d.error || 'Enrolment failed.');
      }
      const fd = await finish.json().catch(() => ({}));
      showToast(fd.prf ? 'Passkey added — passwordless unlock on' : 'Passkey added — it turns passwordless after your next passkey sign-in');
      await refreshPasskeys();
    } catch (error) {
      // Cancelled browser ceremony (NotAllowedError/AbortError) is deliberate,
      // not a failure: stay silent instead of flashing an error.
      if (error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
        if (errEl) errEl.hidden = true;
        return;
      }
      if (errEl) { errEl.textContent = error.message || 'Could not add passkey.'; errEl.hidden = false; }
    }
  });
  // --- Account pane (username/email/delete) ---


  if (accountSaveBtn) accountSaveBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('account-error');
    const email = String(document.getElementById('account-email').value || '').trim().slice(0, 254);
    try {
      // Changing the recovery email is credential-adjacent (it is the reset
      // channel), so prove password knowledge before the session can repoint it.
      const current = await askInput({
        eyebrow: 'Save email', title: 'Confirm password',
        desc: 'Enter your current password to change your recovery email. It stays on this device; only a proof is sent.',
        label: 'Current password', password: true, placeholder: '•••••', okText: 'Save email',
      });
      if (!current) return;
      if (!e2ee.saltAuth) throw new Error('Please log in again, then retry.');
      const saltBytes = (e2ee.saltAuth instanceof Uint8Array) ? e2ee.saltAuth : e2eeB64ToBytes(e2ee.saltAuth);
      const raw = e2ee.kdf === 'argon2id'
        ? await argon2id32(current, saltBytes)
        : await e2eeDeriveBits(current, saltBytes, e2ee.iterations);
      const r = await apiFetch('/api/account/email', { method: 'POST', body: JSON.stringify({ email, currentAuth: e2eeBytesToB64(raw) }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || 'Could not save email.');
      if (state.cachedProfile) state.cachedProfile.email = data.email || email;
      if (errEl) errEl.hidden = true;
      try { applyProfile(); } catch (error) {}
      showToast('Email saved');
    } catch (error) {
      if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
    }
  });

  if (accountDeleteBtn) accountDeleteBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('account-error');
    try {
      const uname = (state.cachedProfile && state.cachedProfile.username) || '';
      const typed = await askInput({
        eyebrow: 'Delete account', title: 'Are you sure?',
        desc: `Type your username (${uname}) to confirm permanent deletion of your account, notes, vault and keys.`,
        label: 'Username', password: false, placeholder: uname, okText: 'Continue',
      });
      if (typed !== uname) { showToast('Deletion cancelled.'); return; }
      const current = await askInput({
        eyebrow: 'Delete account', title: 'Confirm password',
        desc: 'Enter your current password. It stays on this device; only a proof is sent.',
        label: 'Current password', password: true, placeholder: '•••••', okText: 'Delete my account',
      });
      if (!current) return;
      if (!e2ee.saltAuth) throw new Error('Please log in again, then retry.');
      const saltBytes = (e2ee.saltAuth instanceof Uint8Array) ? e2ee.saltAuth : e2eeB64ToBytes(e2ee.saltAuth);
      const raw = e2ee.kdf === 'argon2id'
        ? await argon2id32(current, saltBytes)
        : await e2eeDeriveBits(current, saltBytes, e2ee.iterations);
      const r = await apiFetch('/api/account', {
        method: 'DELETE', body: JSON.stringify({ confirmUsername: uname, currentAuth: e2eeBytesToB64(raw) }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Could not delete account.');
      }
      try { clearRecoveryCodesLocal(); } catch (error) {}
      await logout();
      showToast('Account deleted');
    } catch (error) {
      if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
    }
  });
  // --- Name editing (stored inside the server-encrypted profile) ---


  if (accountSaveNameBtn) accountSaveNameBtn.addEventListener('click', saveAccountName);

  // --- Profile popup + avatar picture ---------------------------------------




  // Center-crop to a square 256px JPEG for a compact avatar.



  if (profileCardEl) profileCardEl.addEventListener('click', (event) => {
    if (event.target.closest('#logout-button')) return;
    openProfilePopup();
  });

  if (closeProfileBtn) closeProfileBtn.addEventListener('click', closeProfilePopup);
  if (profileOverlay) profileOverlay.addEventListener('click', (event) => { if (event.target === profileOverlay) closeProfilePopup(); });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && profileOverlay && !profileOverlay.hidden) closeProfilePopup(); });

  if (profileEditBtn) profileEditBtn.addEventListener('click', () => {
    closeProfilePopup();
    openSettings();
    setSettingsTab('profile');
    refreshAccountPane();
  });

  if (profilePhotoBtn) profilePhotoBtn.addEventListener('click', () => {
    const input = document.getElementById('avatar-input');
    if (input) { input.value = ''; input.click(); }
  });

  if (profilePhotoRemove) profilePhotoRemove.addEventListener('click', () => {
    state.profileAvatar = '';
    paintAvatar(document.querySelector('.profile-card .avatar'), initialsFor(state.cachedProfile ? fullNameOf(state.cachedProfile) : ''));
    refreshProfilePopup();
    persistUiVault();
    showToast('Profile photo removed');
  });

  if (avatarInputEl) avatarInputEl.addEventListener('change', (event) => {
    const file = event.target.files && event.target.files[0];
    event.target.value = '';
    if (file) handleAvatarFile(file);
  });

  // --- Password-loss recovery codes (E2EE-safe wraps, server stores hashes only) ---



  // Plaintext codes live ONLY here (memory) and in one encrypted on-device
  // cache below. The server keeps hashes + wraps, so a second device can never
  // re-display them — it must replace the set (invalidating the old codes).








  if (acctRecDownloadBtn) acctRecDownloadBtn.addEventListener('click', () => {
    try {
      const body = ['Notive password recovery codes', `Account: ${(state.cachedProfile && state.cachedProfile.username) || ''}`,
        `Generated: ${new Date().toISOString()}`, '',
        ...state.acctRecShownCodes, '',
        'Each code works once. Store them offline.'].join('\n');
      const url = URL.createObjectURL(new Blob([body], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'notive-recovery-codes.txt';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      const err = document.getElementById('acct-rec-modal-error');
      if (err) { err.textContent = 'Download failed — copy the codes manually.'; err.hidden = false; }
    }
  });

  if (acctRecDoneBtn) acctRecDoneBtn.addEventListener('click', async () => {
    closeAcctRecModal();
    showToast('Recovery codes saved.');
    try { await refreshAcctRecStatus(); } catch (error) {}
  });


  if (acctRecViewBtn) acctRecViewBtn.addEventListener('click', async () => {
    const codes = await loadRecoveryCodesLocal();
    if (!codes) {
      showToast('Codes are on the device where they were generated.');
      await refreshAcctRecStatus();
      return;
    }
    state.acctRecShownCodes = codes;
    renderAcctRecCodes();
    const modal = document.getElementById('acct-rec-modal');
    if (modal) modal.hidden = false;
  });
  if (acctRecBtn) acctRecBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('acct-rec-error');
    // 8 sequential Argon2id wraps take several seconds: show progress so the
    // click feels alive. Yields between rounds let the label actually paint.
    const paint = () => new Promise((resolve) => setTimeout(resolve, 30));
    try {
      if (!state.cachedProfile || !e2ee.masterKey) throw new Error('Log in and unlock notes first.');
      acctRecBtn.disabled = true;
      acctRecBtn.textContent = 'Starting…';
      await paint();
      // Replacement guard: never silently invalidate an existing unused set.
      // (The button is hidden while this device holds the codes, so reaching
      // here means another device made them — demand explicit confirmation.)
      try {
        const pre = await apiFetch('/api/recovery/account/count');
        if (pre.ok && ((await pre.json()).count || 0) > 0 && !(await loadRecoveryCodesLocal())) {
          const typed = await askInput({
            eyebrow: 'Password recovery', title: 'Replace codes?',
            desc: 'This invalidates the existing unused codes (e.g. made on another device). Type REPLACE to continue.',
            label: 'Confirmation', password: false, placeholder: 'REPLACE', okText: 'Replace',
          });
          if (String(typed || '').trim().toUpperCase() !== 'REPLACE') {
            acctRecBtn.disabled = false;
            acctRecBtn.textContent = 'Replace codes…';
            return;
          }
        }
      } catch (error) {
        if (error && error.message === 'Log in and unlock notes first.') throw error;
        // Count check is advisory only; a failed check must not block generate.
      }
      const masterRaw = await window.crypto.subtle.exportKey('raw', e2ee.masterKey);
      const wraps = [];
      const plain = [];
      for (let i = 0; i < 8; i += 1) {
        acctRecBtn.textContent = `Generating ${i + 1} of 8…`;
        await paint();
        const code = newRecoveryCode();
        const salt = e2eeRandomBytes(16);
        const kekRaw = await argon2id32(code, salt);
        const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
        const iv = e2eeRandomBytes(12);
        const ct = await window.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, masterRaw);
        wraps.push({
          codeHash: await sha256Hex(code),
          salt: e2eeBytesToB64(salt),
          wrappedKey: { iv: e2eeBytesToB64(iv), data: e2eeBytesToB64(ct) },
        });
        plain.push(code);
      }
      acctRecBtn.textContent = 'Saving…';
      const r = await apiFetch('/api/recovery/account/generate', { method: 'POST', body: JSON.stringify({ wraps }) });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Could not store codes.');
      }
      state.acctRecShownCodes = plain;
      try { await saveRecoveryCodesLocal(plain); } catch (error) {}
      if (errEl) errEl.hidden = true;
      openAcctRecModal();
      await refreshAcctRecStatus();
    } catch (error) {
      if (errEl) { errEl.textContent = error.message; errEl.hidden = false; }
    } finally {
      try {
        acctRecBtn.disabled = false;
        await refreshAcctRecStatus();
      } catch (error) {
        try { acctRecBtn.textContent = 'Generate recovery codes'; } catch {}
      }
    }
  });
  // --- Login-overlay forgot-password flow (lookup by hash, unwrap locally) ---

  if (recoverLink) recoverLink.addEventListener('click', () => {
    setAuthTab('recover');
  });

  if (recoverBack) recoverBack.addEventListener('click', () => setAuthTab('login'));
  // Recover popup: one method per view (email / code / email-link token).



  if (closeRecoverModalBtn) closeRecoverModalBtn.addEventListener('click', closeRecoverModal);

  if (recoverModalOverlay) recoverModalOverlay.addEventListener('click', (event) => {
    if (event.target === recoverModalOverlay) closeRecoverModal();
  });

  if (recoverOptEmail) recoverOptEmail.addEventListener('click', () => openRecoverModal('email'));

  if (recoverOptCode) recoverOptCode.addEventListener('click', () => openRecoverModal('code'));

  if (recoverEmailBtn) recoverEmailBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('recover-email-error');
    const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
    try {
      const email = String(document.getElementById('recover-email-address').value || '').trim().slice(0, 254);
      if (!/^[^@\s<>\"]+@[^@\s<>\"]+\.[^@\s<>\"]+$/.test(email)) throw new Error('Enter your email address first.');
      const r = await apiFetch('/api/recovery/email/start', {
        method: 'POST', body: JSON.stringify({ email }),
      });
      if (!r.ok) throw new Error('Could not send email. Try again later.');
      if (errEl) errEl.hidden = true;
      const note = document.getElementById('recover-email-note');
      if (note) note.textContent = 'If the account exists, a reset link is on its way. It expires in 15 minutes.';
      showToast('Reset email sent if the account exists.');
    } catch (error) {
      fail(error.message || 'Could not send email.');
    }
  });

  if (recoverVerifyBtn) recoverVerifyBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('recover-error');
    const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
    try {
      const username = String(document.getElementById('recover-code-username').value || '').trim();
      const code = String(document.getElementById('recover-code').value || '').trim().toUpperCase();
      if (!/^[A-Za-z0-9_-]{3,32}$/.test(username)) throw new Error('Enter your username first.');
      if (!code) throw new Error('Enter a recovery code.');
      const codeHash = await sha256Hex(code);
      // Cross-search: the code must belong to this username before the
      // new-password fields are revealed.
      const lookup = await apiFetch('/api/recovery/account/lookup', {
        method: 'POST', body: JSON.stringify({ username, codeHash }),
      });
      if (lookup.status === 429) {
        const d = await lookup.json().catch(() => ({}));
        throw new Error((d && d.error) || 'Too many attempts — try again later.');
      }
      if (!lookup.ok) throw new Error('Username and recovery code do not match an account.');
      const wrap = await lookup.json();
      const kekRaw = await argon2id32(code, e2eeB64ToBytes(wrap.salt));
      const kek = await window.crypto.subtle.importKey('raw', kekRaw, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
      let masterRaw;
      try {
        masterRaw = await window.crypto.subtle.decrypt(
          { name: 'AES-GCM', iv: e2eeB64ToBytes(wrap.wrappedKey.iv) },
          kek, e2eeB64ToBytes(wrap.wrappedKey.data));
      } catch (error) { throw new Error('Username and recovery code do not match an account.'); }
      state.verifiedRecovery = { username, code, codeHash, masterRaw };
      if (errEl) errEl.hidden = true;
      // Swap the popup: verify view out, new-password view in.
      document.getElementById('recover-verify-view').hidden = true;
      document.getElementById('recover-newpw-block').hidden = false;
      document.getElementById('recover-modal-title').textContent = 'Set a new password';
      showToast('Code verified — set a new password.');
    } catch (error) {
      state.verifiedRecovery = null;
      document.getElementById('recover-newpw-block').hidden = true;
      fail(error.message || 'Verification failed.');
    }
  });

  if (recoverBtn) recoverBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('recover-error');
    const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
    try {
      if (!state.verifiedRecovery) throw new Error('Verify your username and code first.');
      const next = String(document.getElementById('recover-new').value || '');
      const confirm = String(document.getElementById('recover-confirm').value || '');
      const missing = passwordPolicyCheck(next);
      if (missing.length) throw new Error(`New password needs ${missing.join(', ')}.`);
      if (next !== confirm) throw new Error('New passwords do not match.');
      const { username, codeHash, masterRaw } = state.verifiedRecovery;
      const newSaltAuth = e2eeRandomBytes(16);
      const newSaltEnc = e2eeRandomBytes(16);
      const newAuthBits = await argon2id32(next, newSaltAuth);
      const newWrapped = await e2eeWrapMasterKeyArgon2id(next, newSaltEnc, masterRaw);
      const reset = await apiFetch('/api/recovery/account/reset', {
        method: 'POST',
        body: JSON.stringify({
          username, codeHash,
          authHash: e2eeBytesToB64(newAuthBits),
          saltAuth: e2eeBytesToB64(newSaltAuth),
          saltEnc: e2eeBytesToB64(newSaltEnc),
          encMasterKey: newWrapped,
          kdf: 'argon2id',
          params: { t: E2EE_KDF_ARGON2ID.t, m: E2EE_KDF_ARGON2ID.m, p: E2EE_KDF_ARGON2ID.p },
        }),
      });
      if (!reset.ok) {
        const d = await reset.json().catch(() => ({}));
        throw new Error(d.error || 'Could not reset password.');
      }
      if (errEl) errEl.hidden = true;
      const loginName = document.getElementById('login-username');
      if (loginName) loginName.value = username;
      state.verifiedRecovery = null;
      document.getElementById('recover-code-username').value = '';
      document.getElementById('recover-code').value = '';
      document.getElementById('recover-new').value = '';
      document.getElementById('recover-confirm').value = '';
      document.getElementById('recover-newpw-block').hidden = true;
      closeRecoverModal();
      setAuthTab('login');
      showToast('Password reset — log in with the new password.');
    } catch (error) {
      fail(error.message || 'Recovery failed.');
    }
  });
  document.getElementById('open-settings').addEventListener('click', () => {
    try { refreshMfaStatus(); } catch (error) {}
    try { refreshPasskeys(); } catch (error) {}
    try { refreshAccountPane(); } catch (error) {}
    try { refreshAcctRecStatus(); } catch (error) {}
  });
  // Apply a theme, persist the choice and update the meta theme-color.

  // Show the settings modal and close the mobile sidebar.

  // Keep Side Menu settings in sync (unified custom sections have no hide toggles).

  // Switch the settings left-nav tab and its right-side pane.


  if (settingsNewTagBtn) settingsNewTagBtn.addEventListener('click', async () => {
    const value = await askInput({
      eyebrow: 'New tag', title: 'Create a tag',
      desc: 'It becomes available in every note’s tag editor, and you can search it with “tag: <name>”.',
      label: 'Tag name', password: false, placeholder: 'e.g. project', okText: 'Create tag',
    });
    if (value == null) return;
    addKnownTag(value);
  });
  document.querySelectorAll('.settings-nav-item').forEach((item) => item.addEventListener('click', () => setSettingsTab(item.dataset.settingsTab)));
  document.getElementById('start-collapsed').addEventListener('change', (event) => {
    const collapsed = event.target.checked;
    try { localStorage.setItem('notive-sidebar-start-collapsed', collapsed ? '1' : '0'); } catch (error) {}
    setSidebarCollapsed(collapsed);
    showToast(collapsed ? 'Sidebar will start collapsed' : 'Sidebar will start expanded');
  });

  // ---- Device copy / cloud opt-out wiring ----

  // Export every plainWorkspace note (and unlocked Vault notes) as one JSON
  // backup file in the browser's download folder — the "desktop copy".

  // Export buttons were removed from Settings (section redo) — bindings kept
  // guarded so a re-added button wires up without code changes.
  const exportAllBtn = document.getElementById('export-all-btn');
  if (exportAllBtn) exportAllBtn.addEventListener('click', exportAllNotes);
  const exportMdBtn = document.getElementById('export-md-btn');
  if (exportMdBtn) exportMdBtn.addEventListener('click', exportAllNotesMdZip);
  const clipBtn = document.getElementById('import-clipboard-btn');
  if (clipBtn) clipBtn.addEventListener('click', importFromClipboard);
  // Import/Export section: one format picker driving export; import
  // auto-detects Markdown/JSON/YAML/TXT from the file extension.
  const exchangeFormatEl = document.getElementById('exchange-format');
  const exchangeExportBtn = document.getElementById('exchange-export-btn');
  if (exchangeExportBtn) exchangeExportBtn.addEventListener('click', async () => {
    const fmt = exchangeFormatEl ? exchangeFormatEl.value : 'json';
    try {
      const exchange = await import('./data/exchange.js');
      await exchange.exportWorkspace(fmt);
    } catch (error) { showToast('Export failed'); }
  });
  const exchangeImportBtn = document.getElementById('exchange-import-btn');
  const exchangeImportInput = document.getElementById('exchange-import-input');
  if (exchangeImportBtn && exchangeImportInput) {
    exchangeImportBtn.addEventListener('click', () => exchangeImportInput.click());
    exchangeImportInput.addEventListener('change', async (event) => {
      const files = [...(event.target.files || [])];
      event.target.value = '';
      if (!files.length) return;
      try {
        const exchange = await import('./data/exchange.js');
        await exchange.importExchangeFiles(files);
      } catch (error) { showToast('Import failed'); }
    });
  }
  // Turning sync OFF is single-click (toast warns). Turning it back ON opens
  // the resync dialog so the local copy is uploaded or discarded deliberately.
  deviceOnlyBox.addEventListener('change', (event) => {
    const on = event.target.checked;
    if (!state.cachedProfile) {
      event.target.checked = false;
      showToast('Log in first');
      return;
    }
    if (on) {
      setDeviceOnlyPref(true);
      clearTimeout(state.syncTimer);
      syncNotesToServer();
      showToast('This device only — notes no longer sync to the cloud');
      return;
    }
    const overlay = document.getElementById('resync-overlay');
    if (!overlay) { // No dialog available: keep server notes, drop the local copy
      setDeviceOnlyPref(false);
      showToast('Sync re-enabled');
      return;
    }
    overlay.hidden = false;
  });
  document.getElementById('resync-close').addEventListener('click', () => {
    deviceOnlyBox.checked = true;
    document.getElementById('resync-overlay').hidden = true;
  });
  document.getElementById('resync-cancel').addEventListener('click', () => {
    deviceOnlyBox.checked = true;
    document.getElementById('resync-overlay').hidden = true;
  });
  document.getElementById('resync-overlay').addEventListener('click', (event) => {
    if (event.target === document.getElementById('resync-overlay')) {
      deviceOnlyBox.checked = true;
      document.getElementById('resync-overlay').hidden = true;
    }
  });
  // Upload local copy: refresh state.serverNotesVersion from the server's current
  // blob (empty for fresh accounts), push so the device copy wins, and clear
  // the local slot so a later device-only session starts fresh.
  document.getElementById('resync-upload').addEventListener('click', async () => {
    setDeviceOnlyPref(false);
    try { localStorage.removeItem(localNotesKey()); } catch (error) {}
    document.getElementById('resync-overlay').hidden = true;
    try {
      const response = await apiFetch('/api/notes');
      if (response.ok) {
        const data = await response.json();
        if (data && typeof data.updated_at === 'number') state.serverNotesVersion = data.updated_at;
      }
    } catch (error) {}
    await syncNotesToServer();
    showToast('Local notes uploaded — sync is back on');
  });
  // Keep server copy (local is cleared) and reload it onto this device.
  document.getElementById('resync-keep').addEventListener('click', async () => {
    setDeviceOnlyPref(false);
    try { localStorage.removeItem(localNotesKey()); } catch (error) {}
    document.getElementById('resync-overlay').hidden = true;
    await loadNotesFromServer();
    renderNoteList();
    showToast('Sync re-enabled — server notes kept');
  });
  // Reflect the device-only checkbox when settings open.
  if (deviceOnlyBox) {
    const openSettingsDeviceOnly = () => {
      deviceOnlyBox.checked = deviceOnlyPref();
    };
    document.getElementById('open-settings').addEventListener('click', openSettingsDeviceOnly);
  }
  // Hide the settings modal.

  try { state.savedTheme = localStorage.getItem('notive-theme') || 'light'; } catch (error) {}
  applyTheme(state.savedTheme);
  document.getElementById('open-settings').addEventListener('click', (event) => {
    event.preventDefault();
    openSettings();
  });
  document.getElementById('close-settings').addEventListener('click', closeSettings);
  if (settingsOverlay) settingsOverlay.addEventListener('click', (event) => {
    if (event.target === settingsOverlay) closeSettings();
  });

  if (themeSelect) themeSelect.addEventListener('change', () => applyTheme(themeSelect.value, true));
  // Reading font (Settings → Appearance). Device-local like the sidebar prefs
  // (not part of the per-account envelope): one line, no sync conflicts.

  try { state.savedFont = localStorage.getItem('notive-font') || 'default'; } catch (error) {}
  applyFont(state.savedFont);

  if (fontSelect) fontSelect.addEventListener('change', () => applyFont(fontSelect.value, true));
  // Compact picker on the login card. No toast: it would render behind the overlay.



  if (loginThemeToggle) loginThemeToggle.addEventListener('click', (event) => {
    event.stopPropagation();
    setLoginThemeMenu(loginThemeMenu.hidden);
  });
  document.querySelectorAll('.login-theme-item').forEach((option) => option.addEventListener('click', (event) => {
    event.stopPropagation();
    applyTheme(option.dataset.themeValue, false);
    setLoginThemeMenu(false);
  }));
  document.addEventListener('click', (event) => {
    if (loginThemeMenu && !loginThemeMenu.hidden && !event.target.closest('.login-theme-float')) setLoginThemeMenu(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (state.coverRepositioning) { exitCoverRepos(false); return; }
      if (typeof loginThemeMenu !== 'undefined' && loginThemeMenu && !loginThemeMenu.hidden) { setLoginThemeMenu(false); return; }
      if (state.folderMenuTarget) { closeFolderContextMenu(); return; }
      if (typeof state.sharedMenuTarget !== 'undefined' && state.sharedMenuTarget) { closeSharedContextMenu(); return; }
      if (state.contextMenuNoteId) { closeNoteContextMenu(); return; }
      const vaultOverlay = document.getElementById('vault-overlay');
      if (vaultOverlay && !vaultOverlay.hidden) { closeVaultModal(); return; }
      const deleteOverlay = document.getElementById('delete-overlay');
      if (deleteOverlay && !deleteOverlay.hidden) { closeDeleteConfirm(); return; }
      const templateOverlay = document.getElementById('template-overlay');
      if (templateOverlay && !templateOverlay.hidden) { closeTemplatePicker(); return; }
      const folderPickOverlay = document.getElementById('folder-pick-overlay');
      if (folderPickOverlay && !folderPickOverlay.hidden) { closeFolderPicker(); return; }
      const sectionIconOverlay = document.getElementById('section-icon-overlay');
      if (sectionIconOverlay && !sectionIconOverlay.hidden) { closeSectionIconPicker(); return; }
      const tagEditorOverlay = document.getElementById('tag-editor-overlay');
      if (tagEditorOverlay && !tagEditorOverlay.hidden) { closeTagEditor(); return; }
      const collabNewOverlay = document.getElementById('collab-new-overlay');
      if (collabNewOverlay && !collabNewOverlay.hidden) { closeCollabNewDialog(); return; }
      if (state.collab.noteId) { closeCollabNote(); return; }
      if (settingsOverlay && !settingsOverlay.hidden) { closeSettings(); return; }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      if (!state.cachedProfile) return;
      event.preventDefault();
      persistNotes();
      showToast('Note saved');
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
      // Inside the To-Do rendered editor the browser formats the live
      // selection natively; the todo sync serializes it back to markdown.
      // wrapSelection would write to the hidden textarea and be wiped.
      if (isTodoRenderedActive()) return;
      event.preventDefault();
      wrapSelection('**');
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'i') {
      if (isTodoRenderedActive()) return;
      event.preventDefault();
      wrapSelection('*');
    }
    if (event.key === '/' && document.getElementById('login-overlay').hidden && document.activeElement !== markdownInput && document.activeElement !== titleInput && !(document.activeElement && (document.activeElement.classList.contains('collection-rename-input') || document.activeElement.classList.contains('tree-rename-input')))) {
      event.preventDefault();
      document.getElementById('search-input').focus();
    }
  });

  bindSectionHeaderEvents();
  bindCustomSectionsEvents();
  bindNoteContextMenu();
  bindFolderContextMenu();
  bindSectionContextMenu();
  bindVaultContextMenu();
  bindFolderDragDrop();
  // --- Ground-up sync (automatic) ------------------------------------------
  // No button. Changing anything (editor typing, tags, folders, sections)
  // auto-syncs after a short settle; plus a startup sync and a best-effort
  // flush on pagehide/logout so nothing is ever stranded.
  import('./data/sync.js').then((mod) => {
    mod.paintStoragePicker();
    // Don't auto-sync until we're actually unlocked — otherwise the first
    // call paints 'Locked' gray AFTER the boot sync's green.
    const bootTimer = setInterval(() => {
      const ready = (() => { try { return Boolean(state.cachedProfile && e2ee.masterKey); } catch (e) { return false; } })();
      if (ready) { clearInterval(bootTimer); mod.syncNow().catch(() => {}); }
    }, 300);
    // Debounced auto-sync: markDirty() → scheduleSync() pushes after 1.5s idle.
    // No polling interval — sync fires only when something actually changed.
  });
  window.addEventListener('pagehide', () => {
    try {
      if (state.cachedProfile && e2ee.masterKey && state.syncDirty) {
        import('./data/sync.js').then(async (m) => {
          try {
            const payload = await m.buildAndEncryptEnvelope();
            // keepalive: true lets the browser hold this request open after
            // the page closes. No GET first — too slow for pagehide. Uses the
            // last known serverVersion as baseVersion; 409 conflicts resolve
            // on next normal sync.
            fetch('/api/notes', {
              method: 'PUT',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ payload, baseVersion: m.lastServerVersion() }),
              keepalive: true,
            });
          } catch (error) {}
        });
      }
    } catch (error) {}
  });
  boot();
  // --- Email-link password reset (?emailToken=...) ---
  // The link proves email ownership; the new verifier is derived locally and
  // the wrapped master key is untouched server-side. After reset the user logs
  // in with the new password, then enters the OLD password once to re-wrap.
  try {
    const params = new URLSearchParams(window.location.search || '');
    const tok = params.get('emailToken');
    if (tok && tok.length <= 256) state.emailRecoveryToken = tok;
  } catch (error) {}

  if (recoverTokenBtn) recoverTokenBtn.addEventListener('click', async () => {
    const errEl = document.getElementById('recover-token-error');
    const fail = (m) => { if (errEl) { errEl.textContent = m; errEl.hidden = false; } };
    try {
      if (!state.emailRecoveryToken) throw new Error('This link is invalid. Request a new email.');
      const next = String(document.getElementById('recover-token-new').value || '');
      const confirm = String(document.getElementById('recover-token-confirm').value || '');
      const missing = passwordPolicyCheck(next);
      if (missing.length) throw new Error(`New password needs ${missing.join(', ')}.`);
      if (next !== confirm) throw new Error('New passwords do not match.');
      const newSaltAuth = e2eeRandomBytes(16);
      const newAuthBits = await argon2id32(next, newSaltAuth);
      const r = await apiFetch('/api/recovery/email/complete', {
        method: 'POST',
        body: JSON.stringify({
          token: state.emailRecoveryToken,
          authHash: e2eeBytesToB64(newAuthBits),
          saltAuth: e2eeBytesToB64(newSaltAuth),
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || 'Link invalid or expired.');
      }
      state.pendingRewrap = { password: next, saltAuth: newSaltAuth };
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('emailToken');
        window.history.replaceState({}, '', url.toString());
      } catch (error) {}
      state.emailRecoveryToken = null;
      if (errEl) errEl.hidden = true;
      closeRecoverModal();
      setAuthTab('login');
      showToast('Password reset — log in with the new password, then enter the old one once.');
    } catch (error) {
      fail(error.message || 'Recovery failed.');
    }
  });
  // Startup: session check (vault stays locked, so the password gate always shows), empty locked workspace, folder sync, first-note selection, purge timer.
  async function boot() {
    await refreshSession();
    applyProfile();
    // A valid session plus a per-browser-session key (sessionStorage) restores the
    // workspace on refresh; otherwise the vault stays locked and the password gate
    // shows. The key is wiped when the tab/browser closes or on logout.
    const unlocked = await restoreSessionUnlock();
    if (unlocked) {
      hideLogin();
      try {
        await enterWorkspace();
        // Ground-up autosync: one pull+push right after the workspace restores
        // so the light flips off 'Not synced yet' within a second of boot.
        try {
          const mod = await import('./data/sync.js');
          if (typeof mod.syncNow === 'function') mod.syncNow().catch(() => {});
        } catch (error) {}
      }
      catch (error) { e2eeLock(); clearSessionUnlock(); state.notes = []; clearEditor(); showLogin(); }
    } else {
      state.notes = [];
      clearEditor();
      showLogin();
      refreshEditorLock();
      syncCustomSections();
      renderCustomSections();
      clearEditor();
      refreshEditorLock();
    }
    // Email-reset landing: open recovery with only the token popup visible.
    try {
      if (state.emailRecoveryToken) {
        setAuthTab('recover');
        openRecoverModal('token');
      }
    } catch {}
    // Session/workspace state is rendered — reveal the real page (boot gate).
    // Initialize mermaid for diagram rendering in preview.
    try {
      if (window.mermaid) {
        window.mermaid.initialize({
          startOnLoad: false,
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'default',
          securityLevel: 'strict',
        });
      }
    } catch (error) {}
    document.documentElement.classList.remove('app-boot');
    document.querySelectorAll('.sync-dot,.save-dot').forEach((d) => d.classList.remove('is-error','is-offline'));
  }
  setInterval(() => {
    const hadBin = state.notes.some((note) => note.deleted);
    if (purgeExpiredBin()) {
      if (state.currentId && !state.notes.some((note) => note.id === state.currentId)) {
        const live = state.notes.filter((note) => !note.deleted);
        if (live.length) selectNote(live[0].id);
        else clearEditor();
      } else {
        renderNoteList();
      }
      if (hadBin) showToast('Bin auto-emptied expired notes');
    }
  }, 60000);
}