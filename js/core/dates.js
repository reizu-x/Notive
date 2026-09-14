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
  return `Edited ${new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}
