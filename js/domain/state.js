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
};
