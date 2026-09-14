// js/core/markdown.js — custom Markdown renderer (XSS boundary via strings.js).
import { escapeHtml, sanitizeUrl } from './strings.js';

export function renderMarkdown(markdown) {
  const source = typeof markdown === 'string' ? markdown : String(markdown == null ? '' : markdown);
  const lines = source.replace(/\r/g, '').split('\n');
  let html = '';
  let inList = false;
  let listType = '';
  let inCode = false;
  let code = [];

  const closeList = () => {
    if (inList) {
      html += `</${listType}>`;
      inList = false;
      listType = '';
    }
  };

  for (let li = 0; li < lines.length; li += 1) {
    const line = lines[li];
    if (line.trim().startsWith('```')) {
      closeList();
      if (inCode) {
        html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
        code = [];
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
      closeList();
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
        closeList();
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
    if (/^###\s+/.test(line)) { closeList(); html += `<h3>${inlineMarkdown(line.replace(/^###\s+/, ''))}</h3>`; continue; }
    if (/^##\s+/.test(line)) { closeList(); html += `<h2>${inlineMarkdown(line.replace(/^##\s+/, ''))}</h2>`; continue; }
    if (/^#\s+/.test(line)) { closeList(); html += `<h1>${inlineMarkdown(line.replace(/^#\s+/, ''))}</h1>`; continue; }
    if (/^[-*_]{3,}\s*$/.test(line)) { closeList(); html += '<hr>'; continue; }
    const taskMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    if (taskMatch) {
      if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
      const checked = taskMatch[1].toLowerCase() === 'x';
      html += `<li class="task"><span class="task-box${checked ? ' checked' : ''}" aria-hidden="true"></span>${inlineMarkdown(taskMatch[2])}</li>`;
      continue;
    }
    const unorderedMatch = line.match(/^[-*]\s+(.*)$/);
    if (unorderedMatch) {
      if (!inList || listType !== 'ul') { closeList(); html += '<ul>'; inList = true; listType = 'ul'; }
      html += `<li>${inlineMarkdown(unorderedMatch[1])}</li>`;
      continue;
    }
    const orderedMatch = line.match(/^\d+\.\s+(.*)$/);
    if (orderedMatch) {
      if (!inList || listType !== 'ol') { closeList(); html += '<ol>'; inList = true; listType = 'ol'; }
      html += `<li>${inlineMarkdown(orderedMatch[1])}</li>`;
      continue;
    }
    if (/^>\s?/.test(line)) { closeList(); html += `<blockquote>${inlineMarkdown(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    html += `<p>${inlineMarkdown(line)}</p>`;
  }
  closeList();
  if (inCode) html += `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`;
  return html || '<p class="preview-placeholder">Start writing to see your note here.</p>';
}

export function inlineMarkdown(value) {
  // Extract code spans FIRST so backtick content can never be reinterpreted
  // inside a link/image URL emitted below (sanitizer-ordering hardening).
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
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
  const safe = escapeHtml(value)
    .replace(/`([^`]+)`/g, (match, code) => {
      codeSpans.push(`<code>${code}</code>`);
      return `\u0000CODESPAN${codeSpans.length - 1}\u0000`;
    })
    .replace(/!\[([^\]]*)\]\(([^\s)]+)\)/g, (match, alt, src) => {
      const clean = sanitizeUrl(src, { allowMailto: false });
      if (!clean) return alt;
      return stashTag(`<img alt="${applyEmphasis(alt)}" src="${clean}" loading="lazy" referrerpolicy="no-referrer">`);
    })
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (match, label, href) => {
      const clean = sanitizeUrl(href, { allowMailto: true });
      if (!clean) return label;
      return stashTag(`<a href="${clean}" target="_blank" rel="noopener noreferrer nofollow">${applyEmphasis(label)}</a>`);
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>')
    .replace(/\u0000GENTAG(\d+)\u0000/g, (match, index) => genTags[Number(index)] ?? '')
    .replace(/\u0000CODESPAN(\d+)\u0000/g, (match, index) => codeSpans[Number(index)] ?? '');
  return safe;
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
  const alignAttr = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
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
