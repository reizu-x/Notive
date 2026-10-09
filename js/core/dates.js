// js/core/dates.js — note date helpers (pure; input is a note object).

export function isRecentNote(note) {
  return ['Now', 'Today', 'Yesterday'].includes(note.date);
}

export function relativeEditedLabel(note) {
  const ts = note && typeof note.updatedAt === 'number' && Number.isFinite(note.updatedAt) ? note.updatedAt : null;
  if (!ts) {
    const fallback = note && typeof note.date === 'string' && note.date.trim() ? note.date.trim() : 'recently';
    return `Edited ${fallback}`;
  }
  const diff = Math.max(0, Date.now() - ts);
  const minute = 60000, hour = 3600000, day = 86400000;
  if (diff < minute) return 'Edited just now';
  if (diff < hour) return `Edited ${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `Edited ${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'Edited yesterday';
  if (diff < 7 * day) return `Edited ${Math.floor(diff / day)}d ago`;
  return `Edited ${new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: preferredTimezone() === 'auto' ? undefined : preferredTimezone() })}`;
}
export const BIN_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

// Return the user's preferred timezone from localStorage, or 'auto' (browser local).
export function preferredTimezone() {
  try { return localStorage.getItem('notive-timezone') || 'auto'; } catch (error) { return 'auto'; }
}

// Format a timestamp in the given timezone using Intl.DateTimeFormat.
// Falls back to browser local if the timezone is invalid or 'auto'.
export function formatTime(ts, timezone) {
  const tz = (!timezone || timezone === 'auto') ? undefined : timezone;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZone: tz,
    }).format(new Date(ts));
  } catch (error) {
    return new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).format(new Date(ts));
  }
}

// Format a date (no time) in the given timezone.
export function formatDate(ts, timezone) {
  const tz = (!timezone || timezone === 'auto') ? undefined : timezone;
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'short', timeZone: tz,
    }).format(new Date(ts));
  } catch (error) {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric', month: 'short',
    }).format(new Date(ts));
  }
}
