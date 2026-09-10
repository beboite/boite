/**
 * The markdown an agent answer needs: paragraphs, headings, nested and task
 * lists, block quotes, tables, rules, fenced and inline code, bold, italic,
 * strikethrough, links. Everything is escaped first, so the output is safe to
 * put in the page. No images: a `data:` picture arrives as a tool document,
 * and an answer never fetches a remote one.
 */

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function inline(text: string): string {
  let out = escape(text);
  out = out.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

const FENCE = /^```([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const BULLET_MARK = /^\s*[-*+]\s/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

interface ListItem {
  indent: number;
  kind: 'ul' | 'ol';
  text: string;
  task: 'open' | 'done' | null;
  children: ListItem[];
}

function renderItems(items: ListItem[]): string {
  const kind = items[0]?.kind ?? 'ul';
  const rows = items.map((item) => {
    const nested = item.children.length > 0 ? renderItems(item.children) : '';
    if (item.task === null) return `<li>${inline(item.text)}${nested}</li>`;
    const checked = item.task === 'done' ? ' checked' : '';
    return `<li class="task"><input type="checkbox" disabled${checked}> ${inline(item.text)}${nested}</li>`;
  });
  return `<${kind}>${rows.join('')}</${kind}>`;
}

/** Cells of one table row, the outer pipes optional, a `\|` kept as a pipe. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.replaceAll('\\|', '|').trim());
}

function alignments(line: string): (string | null)[] {
  return cells(line).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });
}

function renderTable(head: string, delimiter: string, body: string[]): string {
  const aligns = alignments(delimiter);
  const cell = (text: string, index: number, tag: 'th' | 'td'): string => {
    const align = aligns[index];
    return `<${tag}${align ? ` style="text-align:${align}"` : ''}>${inline(text)}</${tag}>`;
  };
  const width = Math.max(cells(head).length, aligns.length);
  const row = (line: string, tag: 'th' | 'td'): string => {
    const values = cells(line);
    while (values.length < width) values.push('');
    return `<tr>${values.slice(0, width).map((value, index) => cell(value, index, tag)).join('')}</tr>`;
  };
  const rows = body.map((line) => row(line, 'td')).join('');
  return `<table><thead>${row(head, 'th')}</thead><tbody>${rows}</tbody></table>`;
}

export function renderMarkdown(source: string): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: ListItem[] | null = null;
  /** The items open at each indent, innermost last: where the next line nests. */
  let stack: ListItem[] = [];

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map(inline).join('\n')}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    html.push(renderItems(list));
    list = null;
    stack = [];
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      flushAll();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      const language = fence[1] ? ` data-language="${escape(fence[1])}"` : '';
      html.push(`<pre${language}><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }

    if (line.trim() === '') {
      flushAll();
      continue;
    }

    if (RULE.test(line)) {
      flushAll();
      html.push('<hr>');
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushAll();
      const level = Math.min(6, (heading[1]?.length ?? 1) + 2);
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    if (QUOTE.test(line)) {
      flushAll();
      const quoted: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index] ?? '');
        if (!match) break;
        quoted.push(match[1] ?? '');
        index += 1;
      }
      index -= 1;
      html.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`);
      continue;
    }

    // A table is a row, a delimiter row, then rows until a blank or a line with no pipe.
    const next = lines[index + 1] ?? '';
    if (line.includes('|') && TABLE_DELIMITER.test(next) && cells(next).length >= 1 && !ITEM.test(line)) {
      flushAll();
      const body: string[] = [];
      let cursor = index + 2;
      while (cursor < lines.length) {
        const candidate = lines[cursor] ?? '';
        if (candidate.trim() === '' || !candidate.includes('|')) break;
        body.push(candidate);
        cursor += 1;
      }
      html.push(renderTable(line, next, body));
      index = cursor - 1;
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      flushParagraph();
      const indent = (item[1] ?? '').length;
      const kind: 'ul' | 'ol' = BULLET_MARK.test(line) ? 'ul' : 'ol';
      const task = TASK.exec(item[2] ?? '');
      const entry: ListItem = {
        indent,
        kind,
        text: task ? (task[2] ?? '') : (item[2] ?? ''),
        task: task ? ((task[1] ?? ' ') === ' ' ? 'open' : 'done') : null,
        children: []
      };
      // Pop every open item at this depth or deeper: the new one is their sibling or an uncle.
      while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
      const parent = stack[stack.length - 1];
      if (!parent) {
        if (list && list[0]?.kind !== kind && list[0]?.indent === indent) flushList();
        if (!list) list = [];
        list.push(entry);
      } else {
        parent.children.push(entry);
      }
      stack.push(entry);
      continue;
    }

    // Indented text under an item continues that item.
    const open = stack[stack.length - 1];
    if (open && /^\s{2,}\S/.test(line)) {
      open.text += ` ${line.trim()}`;
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushAll();
  return html.join('');
}

/** Where the caret goes when the text ends on a block that closes in several tags. */
const TAILS = ['</li></ul>', '</li></ol>', '</code></pre>', '</td></tr></tbody></table>', '</p></blockquote>'];

/**
 * Puts a caret inside the last block `renderMarkdown` produced, so it blinks at
 * the end of the text instead of on a line of its own under it: a sibling of a
 * `<p>` would start a new line. A part with no text yet gets a paragraph to
 * carry it. Escaped content can hold no `</`, so the last one closes the block.
 */
export function withCaret(html: string, caret: string): string {
  if (html.length === 0) return `<p>${caret}</p>`;
  for (const tail of TAILS) {
    if (html.endsWith(tail)) return `${html.slice(0, -tail.length)}${caret}${tail}`;
  }
  if (html.endsWith('<hr>')) return `${html}<p>${caret}</p>`;
  const close = html.lastIndexOf('</');
  if (close < 0) return `${html}${caret}`;
  return `${html.slice(0, close)}${caret}${html.slice(close)}`;
}
