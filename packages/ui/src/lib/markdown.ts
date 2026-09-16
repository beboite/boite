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
  const code: string[] = [];
  let marker = '\0';
  while (text.includes(marker)) marker += '\0';
  const protectedText = text.replace(/(?<!`)(`+)(.+?)\1(?!`)/g, (_match, _ticks: string, value: string) => {
    code.push(`<code>${escape(value)}</code>`);
    return `${marker}${code.length - 1}${marker}`;
  });
  // Format around opaque spans, then restore them without parsing their contents.
  return inlineFormatting(protectedText).split(marker).map((part, index) => index % 2 ? code[Number(part)]! : part).join('');
}

function inlineFormatting(text: string): string {
  let out = escape(text);
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
  const list = new MarkdownList();

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map(inline).join('\n')}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    html.push(list.flush());
  };
  const flushAll = (): void => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = readFence(lines, index);
    if (fence) {
      flushAll();
      html.push(fence.html);
      index = fence.end;
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

    const quote = readQuote(lines, index);
    if (quote) {
      flushAll();
      html.push(quote.html);
      index = quote.end;
      continue;
    }

    // A table is a row, a delimiter row, then rows until a blank or a line with no pipe.
    const table = readTable(lines, index);
    if (table) {
      flushAll();
      html.push(table.html);
      index = table.end;
      continue;
    }

    const item = parseListItem(line);
    if (item) {
      flushParagraph();
      html.push(list.add(item));
      continue;
    }

    // Indented text under an item continues that item.
    if (list.continue(line)) continue;

    flushList();
    paragraph.push(line);
  }

  flushAll();
  return html.join('');
}

interface Block { html: string; end: number }

function readFence(lines: string[], start: number): Block | null {
  const fence = FENCE.exec(lines[start] ?? '');
  if (!fence) return null;
  const code: string[] = [];
  let end = start + 1;
  while (end < lines.length && !FENCE.test(lines[end] ?? '')) code.push(lines[end++] ?? '');
  const language = fence[1] ? ` data-language="${escape(fence[1])}"` : '';
  return { html: `<pre${language}><code>${escape(code.join('\n'))}</code></pre>`, end };
}

function readQuote(lines: string[], start: number): Block | null {
  const quoted: string[] = [];
  let cursor = start;
  while (cursor < lines.length) {
    const match = QUOTE.exec(lines[cursor] ?? '');
    if (!match) break;
    quoted.push(match[1] ?? '');
    cursor++;
  }
  return quoted.length ? { html: `<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`, end: cursor - 1 } : null;
}

function readTable(lines: string[], start: number): Block | null {
  const head = lines[start] ?? '';
  const delimiter = lines[start + 1] ?? '';
  if (!head.includes('|') || !TABLE_DELIMITER.test(delimiter) || ITEM.test(head)) return null;
  const body: string[] = [];
  let cursor = start + 2;
  while (cursor < lines.length) {
    const line = lines[cursor] ?? '';
    if (!line.trim() || !line.includes('|')) break;
    body.push(line);
    cursor++;
  }
  return { html: renderTable(head, delimiter, body), end: cursor - 1 };
}

function parseListItem(line: string): ListItem | null {
  const item = ITEM.exec(line);
  if (!item) return null;
  const text = item[2] ?? '';
  const task = TASK.exec(text);
  return {
    indent: (item[1] ?? '').length,
    kind: BULLET_MARK.test(line) ? 'ul' : 'ol',
    text: task ? task[2] ?? '' : text,
    task: task ? (task[1] === ' ' ? 'open' : 'done') : null,
    children: []
  };
}

/** Open ancestors retain the list nesting while blocks consume source lines. */
class MarkdownList {
  private items: ListItem[] = [];
  private stack: ListItem[] = [];

  add(entry: ListItem): string {
    while (this.stack.length && this.stack[this.stack.length - 1]!.indent >= entry.indent) this.stack.pop();
    const parent = this.stack[this.stack.length - 1];
    let previous = '';
    if (parent) parent.children.push(entry);
    else {
      const first = this.items[0];
      if (first && first.kind !== entry.kind && first.indent === entry.indent) previous = this.flush();
      this.items.push(entry);
    }
    this.stack.push(entry);
    return previous;
  }

  continue(line: string): boolean {
    const open = this.stack[this.stack.length - 1];
    if (!open || !/^\s{2,}\S/.test(line)) return false;
    open.text += ` ${line.trim()}`;
    return true;
  }

  flush(): string {
    const html = this.items.length ? renderItems(this.items) : '';
    this.items = [];
    this.stack = [];
    return html;
  }
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
