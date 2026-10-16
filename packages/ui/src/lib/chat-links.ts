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

// Ratios and dates can have path separators without naming a file.
const NUMERIC_PATH = /^[\\/]?\d[\d.,\\/]*$/;

export function fileLike(text: string): boolean {
  if (NUMERIC_PATH.test(text)) return false;
  // Not a file, but `chatLink` makes it a web link, so a code span is still linked.
  if (HOST_PORT.test(text)) return true;
  return /^(?:\.{0,2}[\\/]|[a-z]:[\\/]|file:\/\/)/i.test(text) || /^[\w@.-]+[\\/][^\s]+$/.test(text) || /^[\w.-]+\.[a-z\d]{1,8}(?::\d+)?$/i.test(text);
}

export function linkHtml(label: string, raw: string): string {
  const link = chatLink(raw);
  if (!link) return escapeHtml(label);
  const title = escapeHtml(label);
  if (link.kind === 'file') return `<a href="#file" data-file-path="${escapeHtml(link.target)}"${link.line ? ` data-file-line="${link.line}"` : ''}>${title}</a>`;
  return `<a href="${escapeHtml(link.target)}"${link.kind === 'web' ? ' target="_blank" rel="noopener noreferrer"' : ''}>${title}</a>`;
}

const ABSOLUTE_PATH = String.raw`(?:[A-Za-z]:[\\/]|\.\.?[\\/]|\/)[^\s<>]+`;
const RELATIVE_PATH = String.raw`((?:[\w@.-]+[\\/])+[\w@.-]+\.[\w.-]+(?::\d+)?)`;
const LINK_TOKENS = String.raw`!?\[([^\]\n]+)\]\(\s*(?:<([^>\n]+)>|((?:[^\s()]|\([^()]*\))+))\s*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>|https?:\/\/[^\s<>]+|` + `${RELATIVE_PATH}|${ABSOLUTE_PATH}`;

/**
 * The link tokens of `text`, in order. A relative path (group 5) must not
 * follow a word character or a colon; that check is made here instead of in a
 * lookbehind, which Safari before 16.4 cannot parse. A path refused at one
 * position falls through to the absolute path there, as the next alternative of
 * one regex would, and the scan then moves on by one character.
 */
function* linkTokens(text: string): Generator<RegExpExecArray> {
  const tokens = new RegExp(LINK_TOKENS, 'g');
  const absoluteAt = new RegExp(ABSOLUTE_PATH, 'y');
  for (let match = tokens.exec(text); match; match = tokens.exec(text)) {
    if (match[5] !== undefined && match.index > 0 && /[\w:]/.test(text[match.index - 1]!)) {
      absoluteAt.lastIndex = match.index;
      const absolute = absoluteAt.exec(text);
      if (!absolute) {
        tokens.lastIndex = match.index + 1;
        continue;
      }
      match = absolute;
      tokens.lastIndex = match.index + match[0].length;
    }
    // A numeric denominator can end on markdown delimiters, not just punctuation.
    if (match[0].startsWith('/') && /\d/.test(text[match.index - 1] ?? '')) continue;
    yield match;
  }
}

/** Tokenize links before emphasis, keeping URL punctuation and escaped attributes intact. */
export function richInline(text: string, format: (text: string) => string): string {
  let out = '', start = 0;
  for (const match of linkTokens(text)) {
    let raw = match[2] ?? match[3] ?? match[4] ?? match[0];
    let suffix = '';
    if (!match[1] && !match[4]) {
      const clean = raw.replace(/[.,;!?]+$/, '');
      suffix = raw.slice(clean.length); raw = clean;
      while (raw.endsWith(')') && (raw.match(/\)/g)?.length ?? 0) > (raw.match(/\(/g)?.length ?? 0)) { raw = raw.slice(0, -1); suffix = ')' + suffix; }
    }
    if (match[1] === undefined && match[4] === undefined && NUMERIC_PATH.test(raw)) continue;
    out += format(text.slice(start, match.index));
    out += linkHtml(match[1] ?? raw, raw) + escapeHtml(suffix);
    start = match.index + match[0].length;
  }
  return out + format(text.slice(start));
}
