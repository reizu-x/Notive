// js/core/syntax.js — JSON/YAML highlighting + beautify (pure text -> HTML).
import { escapeHtml } from './strings.js';

const JSON_NUMBER_RE = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const JSON_WORD_RE = /^[a-zA-Z]+/;

// String tokens are scanned character-by-character (linear, no regex): a
// greedy alternating regex suffers catastrophic backtracking on unterminated
// escape runs (pentest F-9: a 500 KB note froze the tab for ~66 s on every
// keystroke). This scanner is O(n) worst case.
function scanJsonString(src, i) {
  const n = src.length;
  let j = i + 1;
  while (j < n) {
    const ch = src[j];
    if (ch === '\\') j += 2;
    else if (ch === '"') return j + 1;
    else j += 1;
  }
  return -1;
}

export function highlightJson(text) {
  const src = String(text);
  const n = src.length;
  let out = '';
  let i = 0;
  let last = 0;
  const flushTo = (end) => { out += escapeHtml(src.slice(last, end)); };
  while (i < n) {
    const ch = src[i];
    if (ch === '"') {
      const end = scanJsonString(src, i);
      if (end === -1) {
        flushTo(i);
        out += escapeHtml(src.slice(i));
        return out;
      }
      flushTo(i);
      let k = end;
      while (k < n && (src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r')) k += 1;
      const key = k < n && src[k] === ':';
      out += `<span class="tok-${key ? 'key' : 'string'}">${escapeHtml(src.slice(i, end))}</span>`;
      if (key) {
        out += `<span class="tok-punct">${escapeHtml(src.slice(end, k + 1))}</span>`;
        last = i = k + 1;
      } else {
        last = i = end;
      }
    } else if (ch === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j += 1;
      flushTo(i);
      out += `<span class="tok-comment">${escapeHtml(src.slice(i, j))}</span>`;
      last = i = j;
    } else if (ch === '/' && src[i + 1] === '*') {
      const close = src.indexOf('*/', i + 2);
      const j = close === -1 ? n : close + 2;
      flushTo(i);
      out += `<span class="tok-comment">${escapeHtml(src.slice(i, j))}</span>`;
      last = i = j;
    } else if (/[0-9]/.test(ch) || (ch === '-' && /[0-9]/.test(src[i + 1] || ''))) {
      const wm = JSON_NUMBER_RE.exec(src.slice(i, i + 40));
      const word = wm[0];
      const j = i + word.length;
      flushTo(i);
      out += `<span class="tok-number">${escapeHtml(word)}</span>`;
      last = i = j;
    } else if (/[a-zA-Z]/.test(ch)) {
      const wm = JSON_WORD_RE.exec(src.slice(i, i + 8));
      const j = i + wm[0].length;
      const word = wm[0];
      if (word === 'true' || word === 'false' || word === 'null') {
        flushTo(i);
        out += `<span class="tok-bool">${escapeHtml(word)}</span>`;
        last = i = j;
      } else {
        i = j;
      }
    } else if ('{}[],:'.includes(ch)) {
      flushTo(i);
      out += `<span class="tok-punct">${escapeHtml(ch)}</span>`;
      last = i = i + 1;
    } else {
      i += 1;
    }
  }
  flushTo(n);
  return out;
}

export function yamlCommentAt(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return i;
    }
  }
  return -1;
}

export function highlightYamlValue(text) {
  const re = /("(?:\\.|[^"\\])*"|'(?:''|[^'])*')|(-?\d+(?:\.\d+)?)|\b(true|false|null|yes|no|on|off|~)\b|(&\w+|\*\w+)/gi;
  let out = '';
  let last = 0;
  let match;
  while ((match = re.exec(text))) {
    out += escapeHtml(text.slice(last, match.index));
    if (match[1] !== undefined) out += `<span class="tok-string">${escapeHtml(match[1])}</span>`;
    else if (match[2] !== undefined) out += `<span class="tok-number">${escapeHtml(match[2])}</span>`;
    else if (match[3] !== undefined) out += `<span class="tok-bool">${escapeHtml(match[3])}</span>`;
    else out += `<span class="tok-anchor">${escapeHtml(match[4])}</span>`;
    last = re.lastIndex;
  }
  return out + escapeHtml(text.slice(last));
}

export function highlightYaml(text) {
  return String(text).split('\n').map((line) => {
    let content = line;
    let comment = '';
    const commentAt = yamlCommentAt(content);
    if (commentAt >= 0) { comment = content.slice(commentAt); content = content.slice(0, commentAt); }
    let html = '';
    // key: optional indent, optional "- ", a name, then ":".
    const keyMatch = content.match(/^(\s*)(-\s+)?([^\s:#][^:\n]*?)(\s*:\s*|:\s*$|:$)/);
    if (keyMatch) {
      html += escapeHtml(keyMatch[1]);
      if (keyMatch[2]) html += `<span class="tok-punct">${escapeHtml(keyMatch[2])}</span>`;
      html += `<span class="tok-key">${escapeHtml(keyMatch[3])}</span>`;
      html += `<span class="tok-punct">${escapeHtml(keyMatch[4])}</span>`;
      content = content.slice(keyMatch[0].length);
    } else {
      const dash = content.match(/^(\s*)(-\s+)/);
      if (dash) {
        html += escapeHtml(dash[1]) + `<span class="tok-punct">${escapeHtml(dash[2])}</span>`;
        content = content.slice(dash[0].length);
      }
    }
    html += highlightYamlValue(content);
    if (comment) html += `<span class="tok-comment">${escapeHtml(comment)}</span>`;
    return html;
  }).join('\n');
}

export function beautifyJsonText(text) {
  return `${JSON.stringify(JSON.parse(text), null, 2)}\n`;
}

export function beautifyYamlText(text) {
  const rawLines = String(text == null ? '' : text).replace(/\t/g, '  ').split('\n');
  const depths = [];
  rawLines.forEach((line) => {
    if (!line.trim()) return;
    const indent = (line.match(/^ */) || [''])[0].length;
    if (!depths.includes(indent)) depths.push(indent);
  });
  depths.sort((a, b) => a - b);
  const levelOf = new Map(depths.map((n, index) => [n, index]));
  const staged = rawLines.map((line) => {
    if (!line.trim()) return '';
    const match = line.match(/^( *)([\s\S]*)$/);
    const level = levelOf.get(match[1].length) || 0;
    let content = match[2].replace(/\s+$/, '');
    content = content.replace(/^-\s+/, '- ').replace(/^-$/, '-');
    // Collapse 2+ spaces after a simple "key:" into one (never touches URLs or
    // values with no gap, and unquoted leading spaces are insignificant).
    content = content.replace(/^((?:-\s+)?[A-Za-z_][\w .-]*?):[ \t]{2,}(\S)/, '$1: $2');
    return '  '.repeat(level) + content;
  });
  const cleaned = [];
  staged.forEach((line) => {
    if (!line) {
      if (cleaned.length && cleaned[cleaned.length - 1] !== '') cleaned.push('');
      return;
    }
    cleaned.push(line);
  });
  while (cleaned.length && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return `${cleaned.join('\n')}\n`;
}
