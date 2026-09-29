export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export type ChatLink = { kind: 'web' | 'file' | 'anchor' | 'email'; target: string; line?: number };

/** Local links are handled by the owning core, never resolved against the UI's origin. */
export function chatLink(raw: string): ChatLink | null {
  let target = raw.trim();
  if (!target || /[\u0000-\u001f]/.test(target)) return null;
  if (/^https?:\/\//i.test(target)) {
    try { return { kind: 'web', target: new URL(target).href }; } catch { return null; }
  }
  if (/^mailto:[^\s]+$/i.test(target)) return { kind: 'email', target };
  if (target.startsWith('#')) return { kind: 'anchor', target };
  if (/^file:\/\//i.test(target)) {
    try {
      const url = new URL(target);
      if (url.hostname && url.hostname !== 'localhost') return null;
      target = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:\/)/, '$1');
    } catch { return null; }
  } else {
    // Accept drive letters, reject executable and unknown URI schemes.
    if (/^[a-z][a-z\d+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return null;
    try { target = decodeURIComponent(target); } catch { return null; }
  }
  if (/^[\\/]{2}/.test(target)) return null;
  const line = /(?::(\d+)(?::\d+)?|#L(\d+)(?:C\d+)?(?:-L?\d+)?)$/.exec(target);
  if (line) target = target.slice(0, line.index);
  return { kind: 'file', target: target.replaceAll('\\', '/'), ...(line ? { line: Number(line[1] ?? line[2]) } : {}) };
}

export function fileLike(text: string): boolean {
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
    yield match;
  }
}

/** Tokenize links before emphasis, keeping URL punctuation and escaped attributes intact. */
export function richInline(text: string, format: (text: string) => string): string {
  let out = '', start = 0;
  for (const match of linkTokens(text)) {
    out += format(text.slice(start, match.index));
    let raw = match[2] ?? match[3] ?? match[4] ?? match[0];
    let suffix = '';
    if (!match[1] && !match[4]) {
      const clean = raw.replace(/[.,;!?]+$/, '');
      suffix = raw.slice(clean.length); raw = clean;
      while (raw.endsWith(')') && (raw.match(/\)/g)?.length ?? 0) > (raw.match(/\(/g)?.length ?? 0)) { raw = raw.slice(0, -1); suffix = ')' + suffix; }
    }
    out += linkHtml(match[1] ?? raw, raw) + escapeHtml(suffix);
    start = match.index + match[0].length;
  }
  return out + format(text.slice(start));
}
