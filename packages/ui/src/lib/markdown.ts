/**
 * The little markdown an agent answer needs: paragraphs, headings, lists,
 * fenced and inline code, bold, italic, links. Everything is escaped first,
 * so the output is safe to put in the page.
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
  out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return out;
}

const FENCE = /^```([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.+)$/;
const BULLET = /^\s*[-*]\s+(.+)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.+)$/;

export function renderMarkdown(source: string): string {
  const lines = source.replaceAll('\r\n', '\n').split('\n');
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map(inline).join('\n')}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (!list) return;
    html.push(`<${list.kind}>${list.items.map((item) => `<li>${inline(item)}</li>`).join('')}</${list.kind}>`);
    list = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const fence = FENCE.exec(line);
    if (fence) {
      flushParagraph();
      flushList();
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
      flushParagraph();
      flushList();
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, (heading[1]?.length ?? 1) + 2);
      html.push(`<h${level}>${inline(heading[2] ?? '')}</h${level}>`);
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? 'ul' : 'ol';
      const item = (bullet ?? numbered)?.[1] ?? '';
      if (list && list.kind !== kind) flushList();
      if (!list) list = { kind, items: [] };
      list.items.push(item);
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return html.join('');
}

/** Where the caret goes when the text ends on a list or a fenced block. */
const TAILS = ['</li></ul>', '</li></ol>', '</code></pre>'];

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
  const close = html.lastIndexOf('</');
  if (close < 0) return `${html}${caret}`;
  return `${html.slice(0, close)}${caret}${html.slice(close)}`;
}
