export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export type ChatLink = { kind: 'web' | 'file' | 'anchor' | 'email'; target: string; line?: number };

/**
 * A bare local address with its port, `192.168.1.117:7337` or `localhost:3000/admin`:
 * a server to open in the browser, not `192.168.1.117` at line 7337. The port is
 * required, so a dotted version number is never taken for an address.
 */
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;
const HOST_PORT = new RegExp(String.raw`^(?:localhost|${OCTET}(?:\.${OCTET}){3}|\[[\da-f:.]+\]):\d{1,5}(?:[/?#][^\s]*)?$`, 'i');

/** Local links are handled by the owning core, never resolved against the UI's origin. */
export function chatLink(raw: string): ChatLink | null {
  let target = raw.trim();
  if (!target || /[\u0000-\u001f]/.test(target)) return null;
  if (HOST_PORT.test(target)) target = `http://${target}`;
  if (/^https?:\/\//i.test(target)) {
    try { return { kind: 'web', target: new URL(target).href }; } catch { return null; }
  }
  if (/^mailto:[^\s]+$/i.test(target)) return { kind: 'email', target };
  if (target.startsWith('#')) return { kind: 'anchor', target };
  if (/^file:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (url.hostname && url.hostname !== 'localhost') return null;
      target = decodeURIComponent(url.pathname);
    } catch { return null; }
  } else {
    // Accept drive letters, reject executable and unknown URI schemes.
    if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return null;
    try { target = decodeURIComponent(target); } catch { return null; }
  }
  if (/[\u0000-\u001f]/.test(target) || /^[\\/]{2}/.test(target)) return null;
  // Markdown links can use the same leading slash as a Windows file URI.
  target = target.replaceAll('\\', '/').replace(/^\/([A-Za-z]:\/)/, '$1');
  const line = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+)?)$/.exec(target);
  if (line) target = target.slice(0, line.index);
  return { kind: 'file', target, ...(line ? { line: Number(line[1] ?? line[2]) } : {}) };
}

/**
 * The path a file link names, whole, as it goes on the clipboard: a relative
 * one joined to the thread's folder, `.` and `..` resolved, written with
 * Windows separators when it is a Windows path, since `chatLink` turned them
 * all into `/`.
 */
export function fullPath(path: string, cwd: string | null | undefined): string {
  const inFolder = !cwd || /^(?:[a-z]:)?[\\/]/i.test(path) ? null : `${cwd}/${path}`;
  const whole = (inFolder ?? path).replaceAll('\\', '/');
  // The root stays whole: a share's `//server/share`, a drive's `C:/` or `/`. Nothing climbs above it.
  const root = /^\/\/[^/]+\/[^/]+\/?|^[a-z]:\/?|^\//i.exec(whole)?.[0] ?? '';
  const parts: string[] = [];
  for (const part of whole.slice(root.length).split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..' && parts.length > 0 && parts.at(-1) !== '..') parts.pop();
    else if (part !== '..' || !root) parts.push(part);
  }
  const base = root && !root.endsWith('/') ? `${root}/` : root;
  const joined = base + parts.join('/') + (parts.length > 0 && whole.endsWith('/') ? '/' : '') || '.';
  // An absolute POSIX path keeps its `/` even beside a Windows folder; only a path joined to that folder takes its `\\`.
  return /^(?:\/\/|[a-z]:\/)/i.test(joined) || (inFolder !== null && cwd!.includes('\\')) ? joined.replaceAll('/', '\\') : joined;
}

// Ratios and dates can have path separators without naming a file.
const NUMERIC_PATH = /^[\\/]?\d[\d.,\\/]*$/;

export function fileLike(text: string): boolean {
  if (NUMERIC_PATH.test(text)) return false;
  // Not a file, but `chatLink` makes it a web link, so a code span is still linked.
  if (HOST_PORT.test(text)) return true;
  return /^(?:\.{0,2}[\\/]|[a-z]:[\\/]|file:\/\/)/i.test(text) || /^[\w@.-]+[\\/][^\s]+$/.test(text) || /^[\w.-]+\.[a-z\d]{1,8}(?::\d+)?$/i.test(text);
}

/**
 * A thread as `boite threads` names it: `thr_x`, `<machine>/thr_x` or
 * `<core-id>/thr_x`.
 */
const THREAD_ID = 'thr_[0-9a-z]{12,32}';
const THREAD_TOKEN = String.raw`(?:[\w.-]+\/)?${THREAD_ID}`;
const THREAD_ADDRESS = new RegExp(String.raw`^(?:([\w.-]+)\/)?(${THREAD_ID})$`);

export function threadAddress(text: string): { where: string | null; threadId: string } | null {
  const match = THREAD_ADDRESS.exec(text);
  return match ? { where: match[1] ?? null, threadId: match[2]! } : null;
}

export function threadLinkHtml(label: string, address: string): string {
  return `<a href="#thread" data-thread-address="${escapeHtml(address)}">${escapeHtml(label)}</a>`;
}

/** A code span's link: a thread first, since `machine/thr_x` also reads as a relative path. */
export function codeLinkHtml(value: string): string | null {
  if (threadAddress(value)) return threadLinkHtml(value, value);
  return fileLike(value) ? linkHtml(value, value) : null;
}

export function linkHtml(label: string, raw: string): string {
  if (threadAddress(raw)) return threadLinkHtml(label, raw);
  const link = chatLink(raw);
  if (!link) return escapeHtml(label);
  const title = escapeHtml(label);
  if (link.kind === 'file') return `<a href="#file" data-file-path="${escapeHtml(link.target)}"${link.line ? ` data-file-line="${link.line}"` : ''}>${title}</a>`;
  return `<a href="${escapeHtml(link.target)}"${link.kind === 'web' ? ' target="_blank" rel="noopener noreferrer"' : ''}>${title}</a>`;
}

const ABSOLUTE_PATH = String.raw`(?:[A-Za-z]:[\\/]|\.\.?[\\/]|\/)[^\s<>]+`;
const RELATIVE_PATH = String.raw`((?:[\w@.-]+[\\/])+[\w@.-]+\.[\w.-]+(?::\d+)?)`;
/**
 * The tokens other than `[label](destination)`: group 1 an autolink's address,
 * group 2 a relative path, group 3 a thread. The thread comes before the
 * absolute path, which would otherwise take `/thr_x` out of `machine/thr_x`,
 * and is no thread where a path goes on around it (`thr_x.ts`, `src\thr_x`).
 */
const OTHER_TOKENS = String.raw`<((?:https?:\/\/|mailto:)[^>\s]+)>|https?:\/\/[^\s<>]+|` + `${RELATIVE_PATH}|(${THREAD_TOKEN})(?![\\w/\\\\-]|\\.\\w)|${ABSOLUTE_PATH}`;

const SPACE = /\s/;

/** `\s` for one UTF-16 unit, without a regex for ASCII. */
function isSpace(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13) || (code > 127 && SPACE.test(String.fromCharCode(code)));
}

const LABEL_STOP = (code: number) => code === 93 || code === 10; // ] \n
const WORD_STOP = (code: number) => !isSpace(code);
const ANGLE_STOP = (code: number) => code === 62 || code === 10; // > \n
const WEB_RUN_STOP = (code: number) => code === 41 || isSpace(code); // )
const RUN_STOP = (code: number) => code === 40 || code === 41 || isSpace(code); // ( )
const GROUP_STOP = (code: number) => code === 40 || code === 41;

/**
 * The first index at or after a position whose character `stop` accepts, the
 * text's length when none does. It remembers its last search, so a search that
 * starts inside the stretch already read costs nothing.
 */
class Forward {
  #from = -1;
  #at = 0;

  constructor(private readonly text: string, private readonly stop: (code: number) => boolean) {}

  find(from: number): number {
    if (this.#from >= 0 && from >= this.#from && from <= this.#at) return this.#at;
    let at = from;
    while (at < this.text.length && !this.stop(this.text.charCodeAt(at))) at += 1;
    this.#from = from;
    this.#at = at;
    return at;
  }
}

export type BracketLink = { index: number; end: number; label: string; target: string; angle: boolean };

/**
 * The `[label](destination)` links of a text, read in linear time. A regex
 * retries from every `[` and reads to the end of the label each time, so a
 * line of 32,000 `[` took seconds. Every `[` before a label's `]` shares that
 * `]` and what follows it, so when one fails they all do and the scan jumps to
 * the `]`. `web` reads the plain renderer's links, `[label](http://...)` only;
 * otherwise a destination is `<...>` or a run of characters and balanced
 * parentheses, and a `!` before the `[` belongs to the link, as
 * `!?\[([^\]\n]+)\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]|\([^()]*\))+))\s*\)` reads.
 */
export class BracketLinks {
  readonly #label: Forward;
  readonly #word: Forward;
  readonly #angle: Forward;
  readonly #run: Forward;
  readonly #group: Forward;
  #from = -1;
  #found: BracketLink | null = null;

  constructor(private readonly text: string, private readonly web: boolean) {
    this.#label = new Forward(text, LABEL_STOP);
    this.#word = new Forward(text, WORD_STOP);
    this.#angle = new Forward(text, ANGLE_STOP);
    this.#run = new Forward(text, web ? WEB_RUN_STOP : RUN_STOP);
    this.#group = new Forward(text, GROUP_STOP);
  }

  /** The first link that starts at or after `at`, null when none does. */
  next(at: number): BracketLink | null {
    // No link starts between the last search and what it found, so that answer holds from here too.
    if (this.#from >= 0 && at >= this.#from && (this.#found === null || this.#found.index >= at)) return this.#found;
    this.#from = at;
    this.#found = this.#scan(at);
    return this.#found;
  }

  #scan(at: number): BracketLink | null {
    const text = this.text;
    for (let open = text.indexOf('[', at); open !== -1;) {
      const close = this.#label.find(open + 1);
      // No `]` or newline left: no `[` after this one closes either.
      if (close === text.length) return null;
      if (text[close] === ']' && close > open + 1 && text[close + 1] === '(') {
        const target = this.web ? this.#webTarget(close + 2) : this.#target(close + 2);
        if (target) {
          const index = !this.web && open > at && text[open - 1] === '!' ? open - 1 : open;
          return { index, label: text.slice(open + 1, close), ...target };
        }
      }
      open = text.indexOf('[', close + 1);
    }
    return null;
  }

  /** `https?:\/\/[^)\s]+\)` at `at`. */
  #webTarget(at: number): Omit<BracketLink, 'index' | 'label'> | null {
    const scheme = this.text.startsWith('https://', at) ? 8 : this.text.startsWith('http://', at) ? 7 : 0;
    if (scheme === 0) return null;
    const stop = this.#run.find(at + scheme);
    if (stop === at + scheme || this.text[stop] !== ')') return null;
    return { end: stop + 1, target: this.text.slice(at, stop), angle: false };
  }

  /** `\s*(?:<([^>\n]+)>|((?:[^\s()]|\([^()]*\))+))\s*\)` at `at`: the regex backtracks into neither part. */
  #target(at: number): Omit<BracketLink, 'index' | 'label'> | null {
    const text = this.text;
    const start = this.#word.find(at);
    if (text[start] === '<') {
      const close = this.#angle.find(start + 1);
      const end = text[close] === '>' && close > start + 1 ? this.#closing(close + 1) : -1;
      if (end >= 0) return { end, target: text.slice(start + 1, close), angle: true };
    }
    let stop = start;
    for (;;) {
      stop = this.#run.find(stop);
      if (text[stop] !== '(') break;
      const close = this.#group.find(stop + 1);
      if (text[close] !== ')') break;
      stop = close + 1;
    }
    const end = stop === start ? -1 : this.#closing(stop);
    return end < 0 ? null : { end, target: text.slice(start, stop), angle: false };
  }

  /** Past `\s*\)` at `at`, -1 when the next word is not `)`. */
  #closing(at: number): number {
    const close = this.#word.find(at);
    return this.text[close] === ')' ? close + 1 : -1;
  }
}

export type LinkToken = { index: number; text: string; label?: string; target?: string; auto?: string; thread?: boolean };

/**
 * The link tokens of `text`, in order: the leftmost of the next bracket link
 * and the next other token, as one regex of both would find. They never start
 * on the same character: a bracket link starts on `[` or `!`, no other token
 * does. A relative path must not follow a word character or a colon; that check
 * is made here instead of in a lookbehind, which Safari before 16.4 cannot
 * parse. A path refused at one position falls through to the absolute path
 * there, as the next alternative of one regex would, and the scan then moves
 * on by one character.
 */
export function* linkTokens(text: string): Generator<LinkToken> {
  const tokens = new RegExp(OTHER_TOKENS, 'g');
  const absoluteAt = new RegExp(ABSOLUTE_PATH, 'y');
  // Every bracket link holds `](`: a text without one never builds the scanner.
  const links = text.includes('](') ? new BracketLinks(text, false) : null;
  const nextOther = (from: number): LinkToken | null => {
    tokens.lastIndex = from;
    for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
      if (match[3] !== undefined) {
        if (match.index === 0 || !/[\w:/\\.-]/.test(text[match.index - 1]!)) return { index: match.index, text: match[0], thread: true };
        tokens.lastIndex = match.index + 1;
        continue;
      }
      if (match[2] === undefined || match.index === 0 || !/[\w:]/.test(text[match.index - 1]!)) return { index: match.index, text: match[0], auto: match[1] };
      absoluteAt.lastIndex = match.index;
      const absolute = absoluteAt.exec(text);
      if (absolute) return { index: absolute.index, text: absolute[0] };
      tokens.lastIndex = match.index + 1;
    }
    return null;
  };
  // The next other token from where the last search started: it holds while it lies ahead.
  let other: LinkToken | null | undefined;
  for (let at = 0; ;) {
    if (other === undefined || (other !== null && other.index < at)) other = nextOther(at);
    const link = links?.next(at) ?? null;
    const token: LinkToken | null = link && (!other || link.index < other.index)
      ? { index: link.index, text: text.slice(link.index, link.end), label: link.label, target: link.target }
      : other;
    if (!token) return;
    at = token.index + token.text.length;
    // A numeric denominator can end on markdown delimiters, not just punctuation.
    if (token.text.startsWith('/') && /\d/.test(text[token.index - 1] ?? '')) continue;
    yield token;
  }
}

/** Tokenize links before emphasis, keeping URL punctuation and escaped attributes intact. */
export function richInline(text: string, format: (text: string) => string, explicit = true): string {
  let out = '', start = 0;
  for (const token of linkTokens(text)) {
    // A Markdown parser already rejected this link; do not retry its decoded destination.
    if (!explicit && token.label !== undefined) {
      out += format(text.slice(start, token.index)) + escapeHtml(token.text);
      start = token.index + token.text.length;
      continue;
    }
    if (token.thread) {
      out += format(text.slice(start, token.index)) + threadLinkHtml(token.text, token.text);
      start = token.index + token.text.length;
      continue;
    }
    let raw = token.target ?? token.auto ?? token.text;
    let suffix = '';
    if (token.label === undefined && token.auto === undefined) {
      const clean = raw.replace(/[.,;!?]+$/, '');
      suffix = raw.slice(clean.length); raw = clean;
      while (raw.endsWith(')') && (raw.match(/\)/g)?.length ?? 0) > (raw.match(/\(/g)?.length ?? 0)) { raw = raw.slice(0, -1); suffix = ')' + suffix; }
    }
    if (token.label === undefined && token.auto === undefined && NUMERIC_PATH.test(raw)) continue;
    out += format(text.slice(start, token.index));
    out += linkHtml(token.label ?? raw, raw) + escapeHtml(suffix);
    start = token.index + token.text.length;
  }
  return out + format(text.slice(start));
}
