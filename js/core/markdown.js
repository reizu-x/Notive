// js/core/markdown.js — custom Markdown renderer (XSS boundary via strings.js).
import { escapeHtml, sanitizeUrl } from './strings.js';

export function renderMarkdown(markdown) {
  const source = typeof markdown === 'string' ? markdown : String(markdown == null ? '' : markdown);
  const lines = source.replace(/\r/g, '').split('\n');
  let html = '';
  let inCode = false;
  let codeLang = '';
  let code = [];

  // Nested list engine: one stack entry per open list level, in depth order.
  // Each level: { indent, type: 'ul'|'ol', openItem } — openItem marks an
  // unclosed <li> that a deeper list (or the level itself) still lives inside.
  const listStack = [];

  function closeListLevel() {
    const top = listStack.pop();
    if (top.openItem) html += '</li>';
    html += `</${top.type}>`;
  }

  // Full teardown: called by every non-list block (headings, tables, blanks…)
  // and at stream end, so lists can nest before any interlude.
  function closeAllLists() {
    while (listStack.length) closeListLevel();
    flushParagraph();
  }

  // Open/close levels for one list line at a given indent/type; `startNum`
  // seeds an ordered list's first marker number (GFM `start` attribute).
  let paraOpen = false;
  let paraBreak = false;
  function flushParagraph() {
    if (paraOpen) html += '</p>';
    paraOpen = false;
    paraBreak = false;
  }
  function enterListLevel(indent, type, startNum) {
    while (listStack.length && listStack[listStack.length - 1].indent > indent) closeListLevel();
    const top = listStack[listStack.length - 1];
    if (top && top.indent === indent && top.type !== type) closeListLevel();
    if (!listStack.length || listStack[listStack.length - 1].indent < indent) {
      listStack.push({ indent, type, openItem: false });
      html += type === 'ol' && startNum && startNum !== 1 ? `<ol start="${startNum}">` : `<${type}>`;
    } else if (listStack[listStack.length - 1].openItem) {
      listStack[listStack.length - 1].openItem = false;
      html += '</li>';
    }
  }

  function emitListItem(content) {
    const top = listStack[listStack.length - 1];
    html += content;
    top.openItem = true;
  }

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    if (line.trim().startsWith('```')) {
      closeAllLists();
      if (inCode) {
        if (codeLang === 'mermaid') {
          html += `<div class="mermaid">${escapeHtml(code.join('\n'))}</div>`;
        } else {
          html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
        }
        code = [];
        codeLang = '';
      } else {
        codeLang = line.trim().slice(3).trim().toLowerCase();
      }
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    // Two-column recipe block: `::: recipe` ... `:::`. The first `---` rule
    // splits the left (Ingredients) and right (Method) columns.
    if (/^:::\s*(recipe|columns)\s*$/i.test(line)) {
      closeAllLists();
      const block = [];
      let r = li + 1;
      while (r < lines.length && !/^:::\s*$/.test(lines[r])) { block.push(lines[r]); r += 1; }
      const [left, right] = splitRecipeColumns(block);
      const renderCol = (text) => (text.trim() ? renderMarkdown(text) : '');
      html += `<table class="recipe-table"><tbody><tr><td class="recipe-col">${renderCol(left)}</td><td class="recipe-col">${renderCol(right)}</td></tr></tbody></table>`;
      li = r;
      continue;
    }
    // GFM table: a header row immediately followed by a |---|---| delimiter row.
    if (line.includes('|') && li + 1 < lines.length) {
      const aligns = tableAligns(lines[li + 1]);
      const header = aligns ? splitTableRow(line) : null;
      if (aligns && header && header.length === aligns.length) {
        closeAllLists();
        const rows = [];
        let r = li + 2;
        while (r < lines.length && lines[r].trim() !== '' && lines[r].includes('|')) {
          rows.push(splitTableRow(lines[r]));
          r += 1;
        }
        html += renderTable(header, aligns, rows);
        li = r - 1;
        continue;
      }
    }
    // Task first: `- [x]` (and `* [x]`) with any indent level is a Checklist task.
    const listMatch = line.match(/^(\s*)([-*]\s+\[[ xX]\]|[-*]|\d+\.)(\s+)(.*)$/);
    if (listMatch) {
      flushParagraph();
      const spaces = (listMatch[1].match(/ /g) || []).length
        + 4 * (listMatch[1].match(/\t/g) || []).length;
      const task = /^([-*])\s+\[[ xX]\]/.test(listMatch[2]);
      const startNum = /^\d+\./.test(listMatch[2]) ? parseInt(listMatch[2], 10) : 1;
      const type = /^\d+\./.test(listMatch[2]) ? 'ol' : 'ul';
      const content = listMatch[4];
      enterListLevel(spaces, type, startNum);
      if (task) {
        const checked = /\[([ xX])\]/.exec(listMatch[2])[1].toLowerCase() === 'x';
        emitListItem(`<li class="task"><span class="task-box${checked ? ' checked' : ''}" aria-hidden="true"></span>${inlineMarkdown(content)}`);
      } else {
        emitListItem(`<li>${inlineMarkdown(content)}`);
      }
      continue;
    }
    if (/^#{4,6}\s+/.test(line)) {
      const level = (line.match(/^#+/) || ['#'])[0].length;
      closeAllLists();
      html += `<h${level}>${inlineMarkdown(line.replace(/^#+\s+/, ''))}</h${level}>`;
      continue;
    }
    if (/^###\s+/.test(line)) { closeAllLists(); html += `<h3>${inlineMarkdown(line.replace(/^###\s+/, ''))}</h3>`; continue; }
    if (/^##\s+/.test(line)) { closeAllLists(); html += `<h2>${inlineMarkdown(line.replace(/^##\s+/, ''))}</h2>`; continue; }
    if (/^#\s+/.test(line)) { closeAllLists(); html += `<h1>${inlineMarkdown(line.replace(/^#\s+/, ''))}</h1>`; continue; }
    if (/^[-*_]{3,}\s*$/.test(line)) { closeAllLists(); html += '<hr>'; continue; }
    // Blockquote: consecutive `>` lines form ONE quote block; nesting comes
    // from recursive rendering (inner `> >` lines keep their extra level).
    if (/^>/.test(line)) {
      flushParagraph();
      closeAllLists();
      const inner = [];
      let r = li;
      while (r < lines.length && /^>/.test(lines[r])) {
        inner.push(lines[r].replace(/^>\s?>\s?/, '').replace(/^>\s?/, ''));
        r += 1;
      }
      li = r - 1;
      const quoted = inner.join('\n').trim() ? renderMarkdown(inner.join('\n')) : '';
      html += `<blockquote>${quoted}</blockquote>`;
      continue;
    }
    if (!line.trim()) { flushParagraph(); closeAllLists(); continue; }

    // Paragraph + GFM hard break: a line ending with two+ trailing spaces
    // breaks (<br>) instead of starting a new <p>. A plain continuation line
    // stays in the same paragraph with a single-space join (GFM soft break).
    const softBreak = /\s{2,}$/.test(line);
    if (!paraOpen) { html += '<p>'; paraOpen = true; }
    else if (paraBreak) html += '<br>';
    else html += ' ';
    paraBreak = softBreak;
    html += inlineMarkdown(line.replace(/\s{2,}$/, ''));
  }
  flushParagraph();
  closeAllLists();
  if (inCode) {
    if (codeLang === 'mermaid') {
      html += `<div class="mermaid">${escapeHtml(code.join('\n'))}</div>`;
    } else {
      html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
    }
  }
  return html || '<p class="preview-placeholder">Start writing to see your note here.</p>';
}

export function inlineMarkdown(value) {
  // Backslash escapes run FIRST: `\\<char>` placeholders travel through the
  // whole pipeline so escaped markers never form syntax; revealed (HTML-)
  // escaped at the very end, outside any stash.
  const escaped = [];
  const escPrefixed = String(value == null ? '' : value).replace(
    /\\([\\`*_{}\[\]()#+\-.!>|~<>])/g, (match, ch) => {
      escaped.push(ch);
      return `\u0000ESC${escaped.length - 1}\u0000`;
    });

  const codeSpans = [];
  const genTags = [];
  const stashTag = (tag) => {
    genTags.push(tag);
    return `\u0000GENTAG${genTags.length - 1}\u0000`;
  };
  // Emphasis for link/image labels: applied before the tag is stashed so that
  // later emphasis passes cannot reach inside generated href/src attributes
  // (URLs legitimately contain * and _ characters).
  const applyEmphasis = (text) => text
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
  const safe = escapeHtml(escPrefixed)
    .replace(/`([^`]+)`/g, (match, code) => {
      codeSpans.push(`<code>${code}</code>`);
      return `\u0000CODESPAN${codeSpans.length - 1}\u0000`;
    })
    .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*"|\s+&quot;[^&]*&quot;)?\)/g, (match, alt, src) => {
      const clean = sanitizeUrl(src, { allowMailto: false });
      if (!clean) return alt;
      return stashTag(`<img alt="${applyEmphasis(alt)}" src="${clean}" loading="lazy" referrerpolicy="no-referrer">`);
    })
    .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)"|\s+&quot;([^&]*)&quot;)?\)/g, (match, label, href, title, title2) => {
      const t = title || title2;
      const clean = sanitizeUrl(href, { allowMailto: true });
      if (!clean) return label;
      return stashTag(`<a href="${clean}"${t ? ` title="${t}"` : ''} target="_blank" rel="noopener noreferrer nofollow">${applyEmphasis(label)}</a>`);
    })
    // Angle autolinks: <https://…> and <user@host.tld> (emails → mailto).
    .replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, (match, href) => {
      const clean = sanitizeUrl(href, { allowMailto: false });
      return clean ? stashTag(`<a href="${clean}" target="_blank" rel="noopener noreferrer nofollow">${clean}</a>`) : match;
    })
    .replace(/&lt;([^\s@&]+@[^\s@&]+\.[^\s@&]+)&gt;/g, (match, addr) =>
      stashTag(`<a href="mailto:${addr}">${addr}</a>`))
    .replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/___([^_]+)___/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    // GFM strikethrough (after code spans, before placeholder restore).
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  // Placeholder restore, looped: a stashed tag can itself contain a stash
  // (image inside a link), so all three token families must be resolved one
  // depth-layer per pass until the string is clean. Bounded (no runs-away).
  let html = safe;
  for (let pass = 0; pass < 8; pass += 1) {
    const next = html
      .replace(/\u0000GENTAG(\d+)\u0000/g, (m, idx) => genTags[Number(idx)] ?? '')
      .replace(/\u0000CODESPAN(\d+)\u0000/g, (m, idx) => codeSpans[Number(idx)] ?? '')
      .replace(/\u0000ESC(\d+)\u0000/g, (m, idx) => escapeHtml(escaped[Number(idx)] ?? ''));
    if (next === html) break;
    html = next;
  }
  return html;
}

export function splitTableRow(line) {
  let s = String(line == null ? '' : line).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

export function tableAligns(line) {
  const cells = splitTableRow(line);
  if (!cells.length) return null;
  const aligns = [];
  for (const cell of cells) {
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    aligns.push(left && right ? 'center' : right ? 'right' : left ? 'left' : '');
  }
  return aligns;
}

export function renderTable(header, aligns, rows) {
  // Alignment via data-align + CSS (CSP: style-src has no 'unsafe-inline').
  const alignAttr = (i) => (aligns[i] ? ` data-align="${aligns[i]}"` : '');
  const head = header.map((cell, i) => `<th${alignAttr(i)}>${inlineMarkdown(cell)}</th>`).join('');
  const body = rows.map((row) => `<tr>${header
    .map((_, i) => `<td${alignAttr(i)}>${inlineMarkdown(row[i] == null ? '' : row[i])}</td>`)
    .join('')}</tr>`).join('');
  return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

export function splitRecipeColumns(lines) {
  const at = lines.findIndex((line) => /^\s*---\s*$/.test(line));
  if (at === -1) return [lines.join('\n'), ''];
  return [lines.slice(0, at).join('\n'), lines.slice(at + 1).join('\n')];
}

export function stripMarkdown(text) {
  let out = String(text || '');
  out = out.replace(/```[\s\S]*?```/g, (m) => m.replace(/^```[a-zA-Z0-9_-]*\n?/, '').replace(/```$/gm, ''));
  out = out.replace(/`([^`]*)`/g, '$1');
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)');
  out = out.replace(/^\s{0,3}#{1,6}\s+/gm, '');
  out = out.replace(/^\s{0,3}>\s?/gm, '');
  out = out.replace(/^(\s*)([-*+]|\d+\.)\s+/gm, '$1');
  out = out.replace(/^(\s*)-\s+\[[ xX]\]\s+/gm, '$1');
  out = out.replace(/(\*\*\*|\*\*|__|\*|_|~~)([^*_~]+)\1/g, '$2');
  out = out.replace(/^\s{0,3}([-*_])\s*\1\s*\1[\s\S]*$/gm, '');
  out = out.replace(/\|/g, ' ');
  return out;
}
