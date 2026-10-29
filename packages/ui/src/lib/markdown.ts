import { inline, mathHtml } from './markdown-inline';
import { closesFence, fenceLanguage, openFence } from './fences';
/**
 * The markdown an agent answer needs: paragraphs, headings, nested and task
 * lists, block quotes, tables, rules, fenced and inline code, bold, italic,
 * strikethrough, links. Inline structure follows CommonMark; rendered text and
 * attributes are escaped. No images: a `data:` picture arrives as a tool document,
 * and an answer never fetches a remote one.
 *
 * A closed ```` ```mermaid ```` or ```` ```view ```` block and math between
 * `$$…$$`, `\[…\]`, `\(…\)` or in a ```` ```math ```` block become marked
 * elements that hold their source (`md-mermaid`, `md-view`, `md-math`);
 * `lib/rich-markdown.ts` draws them once they are in the page. A ```` ```html ````
 * block stays code. A single `$` is never math: prices and `$PATH` stay text.
 */

function escape(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}


const HEADING = /^(#{1,6})\s+(.+)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const ITEM = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/;
const BULLET_MARK = /^\s*[-*+]\s/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
/** A quoted line: its text is a document of its own once the mark is off (`readQuote`). */
export const QUOTE = /^\s*>\s?(.*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

interface ListItem {
  indent: number;
  kind: 'ul' | 'ol';
  text: string;
  task: 'open' | 'done' | null;
  children: ListItem[];
}

function renderItems(items: ListItem[], rich = false): string {
  const kind = items[0]?.kind ?? 'ul';
  const rows = items.map((item) => {
    const nested = item.children.length > 0 ? renderItems(item.children, rich) : '';
    if (item.task === null) return `<li>${inline(item.text, rich)}${nested}</li>`;
    const checked = item.task === 'done' ? ' checked' : '';
    return `<li class="task"><input type="checkbox" disabled${checked}> ${inline(item.text, rich)}${nested}</li>`;
  });
  return `<${kind}>${rows.join('')}</${kind}>`;
}

/** Cells of one table row, the outer pipes optional, a `\|` kept as a pipe. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  const split: string[] = [];
  let start = 0;
  for (let index = trimmed.indexOf('|'); index !== -1; index = trimmed.indexOf('|', index + 1)) {
    if (trimmed[index - 1] === '\\') continue;
    split.push(trimmed.slice(start, index));
    start = index + 1;
  }
  split.push(trimmed.slice(start));
  return split.map((cell) => cell.replaceAll('\\|', '|').trim());
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

function renderTable(head: string, delimiter: string, body: string[], rich = false): string {
  const aligns = alignments(delimiter);
  const cell = (text: string, index: number, tag: 'th' | 'td'): string => {
    const align = aligns[index];
    return `<${tag}${align ? ` style="text-align:${align}"` : ''}>${inline(text, rich)}</${tag}>`;
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

/**
 * Finished blocks by source. A message the window mounts again as a scroll
 * brings it back, or a paragraph above the one an answer is still writing, is
 * not parsed a second time. Bounded by the characters it holds, oldest first.
 */
const rendered = new Map<string, string>();
const RENDERED_CHARS = 4_000_000;
let renderedChars = 0;

/** `renderMarkdown` for a block that will not change again. */
export function renderBlock(source: string, rich = false): string {
  const key = (rich ? 'r' : 'p') + source;
  const known = rendered.get(key);
  if (known !== undefined) {
    rendered.delete(key);
    rendered.set(key, known);
    return known;
  }
  const html = renderMarkdown(source, rich);
  rendered.set(key, html);
  renderedChars += key.length + html.length;
  for (const [oldest, value] of rendered) {
    if (renderedChars <= RENDERED_CHARS || rendered.size === 1) break;
    rendered.delete(oldest);
    renderedChars -= oldest.length + value.length;
  }
  return html;
}

export function renderMarkdown(source: string, rich = false): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  const list = new MarkdownList(rich);

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inline(paragraph.join('\n'), rich)}</p>`);
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
    // An indented line under an open item belongs to the item, a fence included, as it always has.
    const fence = list.takes(line) ? null : readFence(lines, index);
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

    const math = readDisplayMath(lines, index);
    if (math) {
      flushAll();
      html.push(math.html);
      index = math.end;
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
      const title = heading[2] ?? '';
      const id = rich ? ` id="${escape(title.toLowerCase().replace(/[^\p{L}\p{N}_ -]/gu, '').trim().replace(/\s+/g, '-'))}"` : '';
      html.push(`<h${level}${id}>${inline(title, rich)}</h${level}>`);
      continue;
    }

    const quote = readQuote(lines, index, rich);
    if (quote) {
      flushAll();
      html.push(quote.html);
      index = quote.end;
      continue;
    }

    // A table is a row, a delimiter row, then rows until a blank or a line with no pipe.
    const table = readTable(lines, index, rich);
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

/** A fenced block under the grammar of `lib/fences.ts`, its code shifted left by the opening line's indent. */
function readFence(lines: string[], start: number): Block | null {
  const fence = openFence(lines[start] ?? '');
  if (!fence) return null;
  const outdent = new RegExp(`^ {0,${fence.indent}}`);
  const code: string[] = [];
  let end = start + 1;
  while (end < lines.length && !closesFence(lines[end] ?? '', fence)) code.push((lines[end++] ?? '').replace(outdent, ''));
  const source = code.join('\n');
  // Only a closed block is drawn: one still being written stays code.
  const closed = end < lines.length;
  const name = fenceLanguage(fence);
  const kind = name.toLowerCase();
  if (closed && kind === 'math' && source.trim()) {
    return { html: mathHtml('div', source.trim(), lines.slice(start, end + 1).join('\n'), true), end };
  }
  const language = name ? ` data-language="${escape(name)}"` : '';
  const pre = `<pre${language}><code>${escape(source)}</code></pre>`;
  if (closed && (kind === 'mermaid' || kind === 'view') && source.trim()) return { html: `<div class="md-${kind}" data-source="${escape(source)}">${pre}</div>`, end };
  return { html: pre, end };
}

/**
 * A formula on lines of its own: `$$` or `\[` opens it at the start of a
 * line and its closing mark ends a line, the same one or a later one. With no
 * closing mark, the lines stay text.
 */
function readDisplayMath(lines: string[], start: number): Block | null {
  const first = (lines[start] ?? '').trim();
  const close = first.startsWith('$$') ? '$$' : first.startsWith('\\[') ? '\\]' : null;
  if (!close) return null;
  for (let end = start; end < lines.length; end++) {
    const line = (lines[end] ?? '').trim();
    if (!line.endsWith(close) || (end === start && line.length < 4)) continue;
    const source = lines.slice(start, end + 1).map(text => text.trim()).join('\n');
    const tex = source.slice(2, -2).trim();
    // `$$a$$ and $$b$$` on one line is two formulas in a paragraph, not one from `a` to `b`.
    if (!tex || tex.includes(close === '$$' ? '$$' : '\\]')) return null;
    return { html: mathHtml('div', tex, source, true), end };
  }
  return null;
}

function readQuote(lines: string[], start: number, rich: boolean): Block | null {
  const quoted: string[] = [];
  let cursor = start;
  while (cursor < lines.length) {
    const match = QUOTE.exec(lines[cursor] ?? '');
    if (!match) break;
    quoted.push(match[1] ?? '');
    cursor++;
  }
  return quoted.length ? { html: `<blockquote>${renderMarkdown(quoted.join('\n'), rich)}</blockquote>`, end: cursor - 1 } : null;
}

function readTable(lines: string[], start: number, rich: boolean): Block | null {
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
  return { html: renderTable(head, delimiter, body, rich), end: cursor - 1 };
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
  constructor(private readonly rich: boolean) {}
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

  /** Whether `continue` would add this line to the open item. */
  takes(line: string): boolean {
    return this.stack.length > 0 && /^\s{2,}\S/.test(line);
  }

  continue(line: string): boolean {
    if (!this.takes(line)) return false;
    this.stack[this.stack.length - 1]!.text += ` ${line.trim()}`;
    return true;
  }

  flush(): string {
    const html = this.items.length ? renderItems(this.items, this.rich) : '';
    this.items = [];
    this.stack = [];
    return html;
  }
}
