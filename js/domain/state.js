// js/domain/state.js — single owner of Notely's shared mutable app state.
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
};
