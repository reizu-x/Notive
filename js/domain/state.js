// js/domain/state.js — single owner of Dafnote's shared mutable app state.
// Every changing global lives here as a property (imports are read-only
// bindings, so state is mutated via this object, never reassigned as a bare
// variable). app.js initializes the fields in place; this module owns the
// container.
//
// Fields: notes, vault, collab, sharing, cachedProfile, customSections,
// deletedCustomSections, collapsedFolders, openTabs, currentId, activeView,
// activeFilter, searchQuery.
export const state = {
  notes: [],
  collab: {},
  vault: {},
  sharing: {},
  vaultId: 1, // currently selected vault (1-3)
  vaultList: [], // [{id, name}] from the server — shown in the sidebar
  vaultKeys: {}, // {vaultId: CryptoKey} — unwrapped on unlock (shared password)
  vaultBlobMap: {}, // {vaultId: [ciphertext blobs]} — all vaults' stored notes
  vaultFolderMap: {}, // {vaultId: [folder paths]} — all vaults' folder lists
  cachedProfile: null,
  customSections: [],
  deletedCustomSections: [],
  collapsedFolders: new Set(),
  openTabs: [],
  currentId: null,
  activeView: "notes",
  activeFilter: "all",
  searchQuery: "",
  collabCaretMirror: null,
  collabPresenceLocalTimer: null,
  collabTypingTimer: null,
  pendingSharedTemplate: null,
  // Lazy import of Yjs from the local vendor bundle (collab sync).
  yjsPromise: null,
  // Resolve fn of the open prompt modal (js/ui/modal.js); null when closed.
  askInputPending: null,
  // Open vault modal mode: 'setup' | 'unlock' | 'reset-confirm' | null.
  vaultModalMode: null,
  // Signer.username -> signing-key fingerprint pin cache (localStorage-backed).
  sharingPins: new Map(),
  sharingPinsLoaded: false,
  notesLoaded: false,
  serverNotesVersion: 0,
  serverUiLoaded: false,
  syncTimer: null,
  knownTags: [],
  uiVaultTimer: null,
  activeCustom: null, // { section: id, folder: path | null } | null — section/folder filter,
  lastMarkedSectionId: (() => { try { return localStorage.getItem('dafnote-last-section') || null; } catch (error) { return null; } })(), // last section the user marked — survives view switches and reloads so the strip keeps reflecting it,
  sharedFolder: null, // { groupId, folder } | null — folder filter inside the Shared view (folder '' = section root),
  sharedPerson: null, // username — person filter inside the Shared view (sidebar person rows),
  vaultFolder: null, // folder path — folder filter inside the Vault view (sidebar vault rows),
  syncInFlight: null, // promise while a PUT is running — serializes syncs so no baseVersion race
  syncBusy: false, // true while syncNow() is in progress (shared across sync paths)
  vaultSwitching: null, // promise while a vault switch runs — serializes rapid switches
  sectionMenuTarget: null, // section id,
  sectionIconTarget: null,
  vaultMenuTarget: null, // vault id for context menu
  folderMenuTarget: null, // { ns: 'custom', path, section },
  writeMode: 'edit',
  idleTimer: null,
  lastOverflowTabs: [],
  tabOverflowOpen: false,
  dragTabEl: null,
  dragTabIndex: null,
  tabClickSuppressed: false,
  coverDragging: false,
  coverRepositioning: false,
  coverReposStart: 50,
  contextMenuNoteId: null,
  tagEditorNoteId: null,
  tagEditorShared: false,
  sharingKeyPromise: null,
  sectionSettingsGroupId: null,
  sharedMenuTarget: null,
  pendingDeleteId: null,
  pendingDeleteMode: 'soft',
  pendingDeleteSection: null, // custom section id for folder/section deletes,
  pendingDeleteTag: null, // tag name for tag deletes,
  currentVaultId: null,
  pendingVaultFolder: null, // folder name | null (null = Vault root),
  vaultTemplatePending: false,
  pendingSectionFolder: null, // { ns: 'custom', section: id, folder } | null,
  pendingTemplate: null, // template key | null,
  profileAvatar: '',
  authBusy: false,
  acctRecShownCodes: [],
  verifiedRecovery: null,
  savedTheme: 'light',
  savedFont: 'default',
  emailRecoveryToken: null,
  pendingRewrap: null,
  saveTimer: null,
  // Timestamp of the last successful server sync (drives the "Synced ago" label).
  lastSyncedAt: 0,
};
