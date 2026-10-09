// js/core/strings.js — pure text/URL helpers (no DOM, no app state, no imports).
// Extracted from the monolith. The XSS boundary for all rendered strings lives here.

// Escape the five HTML metacharacters; null-safe. Every dynamic string in
// templates must pass through this.
export function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
}

// Allowlist-based URL sanitizer for Markdown links/images.
// Blocks javascript:, data:, vbscript:, file:, blob: etc. Only http/https
// (and mailto: for links) are rendered as clickable. Anything else renders
// as plain text so it can never become an XSS sink.
export function sanitizeUrl(raw, { allowMailto = false } = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  // Reject whitespace, markup delimiters and ALL control chars (including
  // NUL placeholders used internally) to block obfuscation and mXSS. Also
  // reject encoded quotes (&quot; &#39; ...) — a literal quote is never valid
  // unencoded in a URL, and this keeps quotes out of emitted attributes even
  // after entity decoding.
  if (/[\s<>"\x00-\x1F\x7F]/.test(text)) return null;
  if (/&(?:quot|apos|#39|#x27|#34|#x22);?/i.test(text)) return null;
  const lower = text.toLowerCase();
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    try {
      const parsed = new URL(text);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return text;
    } catch (error) {}
    return null;
  }
  if (allowMailto && lower.startsWith('mailto:')) {
    if (/^mailto:[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(text)) return text;
    return null;
  }
  return null;
}
