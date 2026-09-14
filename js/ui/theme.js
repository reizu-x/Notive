// js/ui/theme.js — theme and reading-font catalogues (device-side appearance
// data; applying a theme/font stays in app.js because it touches shell state).
// Themes available in Settings and on the login screen.
export const THEMES = ['light', 'dark', 'dracula', 'nord', 'tokyo', 'gruvbox'];

// <meta name="theme-color"> value per theme: matches the browser chrome to the
// active palette on mobile.
export const THEME_META_COLORS = { light: '#f4f0e9', dark: '#1f1d1b', dracula: '#282a36', nord: '#2e3440', tokyo: '#1a1b26', gruvbox: '#282828' };

// Human-readable theme names for toast announcements.
export const THEME_LABELS = { light: 'Light', dark: 'Dark', dracula: 'Dracula', nord: 'Nord', tokyo: 'Tokyo Night', gruvbox: 'Gruvbox' };

// Reading fonts (Settings → Appearance).
export const FONTS = ['default', 'serif', 'palatino', 'sans', 'verdana', 'mono'];
