

// --- Password-loss recovery codes (E2EE-safe wraps, server stores hashes only) ---
export const REC_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export const PANEL_MAX_WIDTH = 560;

// Panel resizing: drag the handle between the expanded notes panel and the
// editor to change the panel width. Bounds: 220px–560px (min keeps search +
// chips usable; max keeps the editor readable). The collapsed strip (55px)
// is never affected — the handle is hidden in strip/focus modes. Width is
// persisted per device and re-applied on boot.
export const PANEL_MIN_WIDTH = 220;

export const NOTE_TEMPLATES = {
  standard: {
    label: 'Standard note',
    caption: 'Standard',
    icon: 'file-text',
    titleBase: 'New Standard Note',
    tags: [],
    body: (title) => `# ${title}\n\nStart writing here...`
  },
  recipe: {
    label: 'Recipe',
    caption: 'Recipe',
    icon: 'cooking',
    titleBase: 'New Recipe',
    tags: ['recipe'],
    body: () => '',
    recipe: { ingredients: ['Ingredient one', 'Ingredient two'], steps: ['Step one', 'Step two'] }
  },
  todo: {
    label: 'To-do list',
    caption: 'To-do',
    icon: 'check-square',
    titleBase: 'New To-Do Note',
    tags: ['todo'],
    body: (title) => `# ${title}\n\n## Today\n\n- [ ] Most important task\n- [ ] Second task\n\n## Later\n\n- [ ] Someday task`
  }
};

export const sharedCollapsed = new Set();

export const sharedBodyCache = new Map();

export const sharedNoteMeta = new Map();

export const sharedGroupOwners = new Map();

export const sharedGroupTags = new Map();

export const sharedGroupFolders = new Map();

// Snapshot of fetched groups for the sidebar person list: [{id, owner, name, members}].
export const sharedGroupsCache = [];

// The Shared view: one section per person, each holding automatically-shared notes.
export const sharedGroupKeys = new Map();

export const rekeyInFlight = new Set();

// ---- Presence: who is here, where their cursor is (ephemeral, encrypted) ----
export const COLLAB_PRESENCE_TTL_MS = 15000;

export const IMPORTANT_TAG = 'important';

export const MAX_OPEN_TABS = 20;

// Section icon picker set (order shown in the picker). First entry is the
// default for sections without a chosen icon.
export const SECTION_ICONS = ['layers', 'folder', 'book', 'briefcase', 'tag', 'bookmark',
  'star', 'flag', 'bulb', 'flask', 'leaf', 'code', 'globe', 'calendar', 'palette',
  'rocket', 'home', 'heart', 'hash', 'archive'];

// Per-account UI state (sidebar folders, custom sections, hidden
// sections, Bin entries, collapsed state). Source of truth is the server E2EE
// envelope (`ui` field, v2) so every account keeps its own sidebar across
// relogs and devices. A per-account encrypted localStorage copy is only a
// fast offline cache — never plaintext, never shared between accounts.
export const UI_VAULT_KEY = 'drafnote-ui-vault';

export const SECTION_DATA_KEY = 'drafnote-section-data';

export const COLLAPSED_FOLDERS_KEY = 'drafnote-tree-collapsed';

export const FOLDER_COLORS = ['coral', 'yellow', 'blue', 'mint', 'violet', 'rose'];

export const COLLECTION_COLORS = FOLDER_COLORS;

export const WELCOME_FOLDERS = ['General', 'Personal'];

// Onboarding workspace for brand-new accounts: a "Notes" section with
// General/Personal folders plus welcome notes that explain the app. Ids are
// stable (`welcome-*`) so this runs at most once per account — any saved
// envelope (even an empty one) means the server row exists and this never fires.
export const WELCOME_SECTION_ID = 'section-notes';


export const IDLE_PREVIEW_MS = 10000;

// Default folders carried over from the removed built-in Collections section.
// New custom sections share the same folder palette/behavior (same value).
export const DEFAULT_CUSTOM_FOLDERS = ['Work', 'Personal', 'Reading list'];
