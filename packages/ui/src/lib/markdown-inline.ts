import MarkdownIt, { type MarkdownIt as MarkdownParser, type StateInline } from 'markdown-it';
import { chatLink, codeLinkHtml, escapeHtml, fileLike, linkHtml, linkTokens, richInline, threadAddress, threadLinkHtml, type LinkToken } from './chat-links';

/** Only an emphasis run still open before this path can own its trailing marks. */
function pathLength(state: StateInline, path: string): number {
  const opens = new Map<number, number>();
  for (const delimiter of state.delimiters) {
    const weight = delimiter.marker === 126 ? 2 : 1;
    let open = opens.get(delimiter.marker) ?? 0;
    if (delimiter.close) open = Math.max(0, open - weight);
    if (delimiter.open) open += weight;
    opens.set(delimiter.marker, open);
  }
  let end = path.length;
  while (end > 0) {
    const marker = path.charCodeAt(end - 1);
    if (marker !== 42 && marker !== 95 && marker !== 126) break;
    const open = opens.get(marker) ?? 0;
    if (!open) break;
    end--;
    opens.set(marker, open - 1);
  }
  return end;
}

/** Preserve path delimiters before CommonMark can turn __tests__ into emphasis. */
function protectPaths(md: MarkdownParser): void {
  const text = md.inline.ruler.getRules('')[0]!; // The built-in text rule is first.
  const paths = new WeakMap<StateInline, LinkToken[]>();
  md.inline.ruler.at('text', (state, silent) => {
    if (state.linkLevel) return text(state, silent);
    let tokens = paths.get(state);
    if (!tokens) {
      tokens = [...linkTokens(state.src)].filter(token => token.label === undefined && !token.auto && !token.thread).map(token => {
        const opening = /^_+/.exec(token.text)?.[0];
        if (opening && token.text.endsWith(opening) && token.text.length > opening.length * 2) {
          return { ...token, index: token.index + opening.length, text: token.text.slice(opening.length, -opening.length) };
        }
        return token;
      }).filter(token => fileLike(token.text) && chatLink(token.text)?.kind === 'file');
      paths.set(state, tokens);
    }
    // Link-label lookahead can move back: select by position instead of consuming an iterator.
    let from = 0, to = tokens.length;
    while (from < to) {
      const middle = (from + to) >>> 1;
      if (tokens[middle]!.index < state.pos) from = middle + 1;
      else to = middle;
    }
    const path = tokens[from];
    if (path?.index === state.pos && state.pos + path.text.length <= state.posMax) {
      const length = pathLength(state, path.text);
      if (!silent) state.push('boite_file', '', 0).content = path.text.slice(0, length);
      state.pos += length;
      return true;
    }
    const matched = text(state, silent);
    if (matched && path && path.index < state.pos) {
      if (!silent) state.pending = state.pending.slice(0, -(state.pos - path.index));
      state.pos = path.index;
    }
    return matched;
  });
  md.renderer.rules.boite_file = (tokens, index) => richInline(tokens[index]!.content, escapeHtml);
}

/** CommonMark parses the structure before Boite adds automatic file and thread links. */
function parser(rich: boolean): MarkdownParser {
  const md = new MarkdownIt({ html: false, linkify: rich });
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });
  const label = md.helpers.parseLinkLabel;
  const lastBracket = new WeakMap<StateInline, number>();
  md.helpers = { ...md.helpers, parseLinkLabel(state, start, disableNested) {
    // Inline links need ] and ); reference links only need ]. Skip impossible lookahead.
    let last = lastBracket.get(state);
    if (last === undefined) {
      last = state.src.lastIndexOf(']');
      if (!state.env.references) last = Math.min(last, state.src.lastIndexOf(')'));
      lastBracket.set(state, last);
    }
    return last <= start ? -1 : label(state, start, disableNested);
  } };
  if (rich) {
    protectPaths(md);
    const destination = md.helpers.parseLinkDestination;
    md.helpers = { ...md.helpers, parseLinkDestination(source, start, max) {
      const result = destination(source, start, max);
      const raw = source[start] === '<' ? source.slice(start + 1, result.pos - 1) : source.slice(start, result.pos);
      // CommonMark unescapes \_ before normalizeLink; Windows separators must survive that step.
      const relativeWindows = !raw.includes('/') && raw.split('\\').slice(1).some(part =>
        part.length > 0 && !md.utils.isMdAsciiPunct(part.charCodeAt(0)) && !/^\s/.test(part));
      if (result.ok && (relativeWindows || /^(?:[a-z]:[\\/]|\\|\.{1,2}\\)/i.test(raw))) {
        result.str = md.utils.unescapeAll(raw.replaceAll('\\', '\\\\'));
      }
      return result;
    } };
  }
  // Keep paths intact for the owning core, including Windows separators and line numbers.
  md.normalizeLink = value => value;
  md.validateLink = value => {
    const link = chatLink(value);
    return link !== null && (rich || link.kind === 'web' || link.kind === 'email');
  };
  md.renderer.rules.text = (tokens, index, _options, env) => {
    const text = tokens[index]!.content;
    return rich && !env?.inLink ? richInline(text, escapeHtml, false) : escapeHtml(text);
  };
  md.renderer.rules.code_inline = (tokens, index, _options, env) => {
    const value = tokens[index]!.content;
    const link = env?.inLink ? null : rich ? codeLinkHtml(value) : threadAddress(value) ? threadLinkHtml(value, value) : null;
    return `<code>${link ?? escapeHtml(value)}</code>`;
  };
  md.renderer.rules.link_open = (tokens, index, _options, env = {}) => {
    env.inLink = true;
    const token = tokens[index]!;
    const link = linkHtml('', String(token.attrGet('href') ?? ''));
    const title = token.attrGet('title');
    return link.slice(0, -4).replace(/>$/, `${title === null ? '' : ` title="${escapeHtml(String(title))}"`}>`);
  };
  md.renderer.rules.link_close = (_tokens, _index, _options, env = {}) => {
    env.inLink = false;
    return '</a>';
  };
  // Remote images remain links: an answer never fetches a tracking pixel.
  md.renderer.rules.image = (tokens, index, _options, env) => env?.inLink
    ? escapeHtml(tokens[index]!.content)
    : linkHtml(tokens[index]!.content, String(tokens[index]!.attrGet('src') ?? ''));
  // Prose preserves whitespace, so a newline after <br> would add a second break.
  md.renderer.rules.hardbreak = () => '<br>';
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  md.inline.ruler.before('escape', 'boite_math', (state, silent) => {
    const marker = state.src.charCodeAt(state.pos);
    if (marker !== 36 && marker !== 92) return false;
    const source = state.src.slice(state.pos);
    const match = /^(?:\$\$(.+?)\$\$|\\\[(.+?)\\\]|\\\((.+?)\\\))/.exec(source);
    const tex = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
    if (!match || !tex) return false;
    if (!silent) {
      const token = state.push('boite_math', '', 0);
      token.content = tex;
      token.meta = { source: match[0], display: match[3] === undefined };
    }
    state.pos += match[0].length;
    return true;
  });
  md.renderer.rules.boite_math = (tokens, index) => {
    const token = tokens[index]!;
    return mathHtml('span', token.content, String(token.meta!.source), token.meta!.display === true);
  };
  return md;
}

const plain = parser(false);
const rich = parser(true);

export function inline(source: string, links: boolean): string {
  return (links ? rich : plain).renderInline(source, {});
}

/** Escaped source remains visible until the lazy formula renderer runs. */
export function mathHtml(tag: 'span' | 'div', tex: string, source: string, display: boolean): string {
  return `<${tag} class="md-math"${display ? ' data-display' : ''} data-tex="${escapeHtml(tex)}" data-source="${escapeHtml(source)}">${escapeHtml(source)}</${tag}>`;
}
