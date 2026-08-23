/**
 * A small, safe Markdown renderer for chat replies.
 *
 * ## Why hand-built
 *
 * The app already builds its charts by hand rather than taking a charting
 * dependency; the same reasoning applies here. A full Markdown library brings a
 * parser, a sanitiser, and their combined CVE surface, to render the handful of
 * constructs an LLM actually emits in chat: emphasis, code, headings, lists,
 * blockquotes, tables and links.
 *
 * ## Why this cannot inject HTML
 *
 * **Every input is HTML-escaped before any markup is produced.** Angles, quotes
 * and ampersands are gone by the time a single tag is written, so no input —
 * hostile, malformed, or merely unlucky — can close a tag or open a new one. The
 * only `<` characters in the output are ones this file wrote itself.
 *
 * That ordering is the whole security model, so it must not be reversed: never
 * insert raw input after markup generation, and never add a rule that emits
 * caller-supplied text without passing it through {@link escapeHtml} first.
 *
 * Link `href`s are additionally restricted to http/https/mailto, because escaping
 * alone would still permit `javascript:` in an attribute position.
 */

/** Replace every character with HTML meaning. Runs before any markup is written. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only these schemes may appear in an href. Anything else renders as plain text. */
const SAFE_SCHEME = /^(https?:|mailto:)/i;

/**
 * Inline constructs, applied to already-escaped text.
 *
 * Code spans are extracted first and restored last, so `**not bold**` inside
 * backticks stays literal — the usual Markdown precedence.
 */
function inline(escaped: string): string {
  const codes: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(code);
    return `\u0000${codes.length - 1}\u0000`;
  });

  // [label](url) — href restricted to safe schemes; anything else stays as text.
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) =>
    SAFE_SCHEME.test(href)
      ? `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
      : whole,
  );

  out = out
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/~~([^~]+)~~/g, '<del>$1</del>');

  return out.replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<code>${codes[Number(i)]}</code>`);
}

/** True for a `| --- | :--: |` style table separator row. */
function isTableRule(line: string): boolean {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-');
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim());
}

/**
 * Render Markdown to a safe HTML string.
 *
 * Block-level parsing is a single pass over lines; there is no nesting beyond
 * one list level, which is all chat replies need.
 */
export function renderMarkdown(source: string): string {
  const lines = escapeHtml(String(source ?? '')).split('\n');
  const html: string[] = [];

  let listType: 'ul' | 'ol' | null = null;
  let inCodeBlock = false;
  let codeLines: string[] = [];
  let paragraph: string[] = [];

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };
  const closeParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };
  const closeAll = () => {
    closeParagraph();
    closeList();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fenced code — verbatim until the closing fence.
    if (/^\s*```/.test(line)) {
      if (inCodeBlock) {
        html.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        closeAll();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      closeAll();
      continue;
    }

    // Table: a header row followed by a separator row.
    if (line.includes('|') && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      closeAll();
      const head = splitRow(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        body.push(splitRow(lines[i]));
        i++;
      }
      i--;
      html.push(
        '<table><thead><tr>' +
          head.map((c) => `<th>${inline(c)}</th>`).join('') +
          '</tr></thead><tbody>' +
          body
            .map((row) => `<tr>${row.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
            .join('') +
          '</tbody></table>',
      );
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeAll();
      const level = heading[1].length + 1; // h1 is the page's, not the reply's
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      continue;
    }

    // Matches `&gt;`, not `>`: escaping runs before block parsing (that ordering
    // is the security model), so by here a blockquote marker is already escaped.
    if (/^\s*&gt;\s?/.test(line)) {
      closeAll();
      html.push(`<blockquote>${inline(line.replace(/^\s*&gt;\s?/, ''))}</blockquote>`);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      closeAll();
      html.push('<hr />');
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      closeParagraph();
      const wanted = bullet ? 'ul' : 'ol';
      if (listType !== wanted) {
        closeList();
        html.push(`<${wanted}>`);
        listType = wanted;
      }
      html.push(`<li>${inline((bullet ?? numbered)![1])}</li>`);
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  if (inCodeBlock && codeLines.length) html.push(`<pre><code>${codeLines.join('\n')}</code></pre>`);
  closeAll();

  return html.join('');
}
