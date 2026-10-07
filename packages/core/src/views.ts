/*
 * `boite view`: an HTML page of the thread's working directory becomes an
 * inline view of the conversation. The page is made self-contained (its local
 * files embedded, nothing remote), given the theme bootstrap, stored as an
 * artifact snapshot and loaded once in a headless browser. Whatever is wrong
 * with it goes back to the agent as the refusal's sentence, so the user is
 * only ever shown a page that loaded cleanly. docs/chat-files.md has the rest.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  VIEW_DEFAULT_HEIGHT, VIEW_MAX_BYTES, VIEW_NARROW_WIDTH, VIEW_ROUTE, VIEW_TITLE_MAX, VIEW_WIDTH,
  clampViewHeight, viewDocument, viewTitleOf,
  type InlineView, type Message, type RpcParams, type RpcResult,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { existingInside } from './workdir.ts';
import { messageOf, refused } from './errors.ts';
import { newId } from './ids.ts';

const VIEW_MIME = 'text/html';

/** What a page may embed from the disk, by extension. Anything else is refused by name. */
const EMBEDDED: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
};

/** Tags whose address is fetched when the page loads. An `<a>` is not one: its link opens in the user's browser on a click. */
const LOADING_TAG = /<(img|image|source|video|audio|track|script|link|use|input|iframe|embed|object)\b[^>]*>/gi;
const ADDRESS = /\s(src|href|xlink:href|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi;

interface Edit { start: number; end: number; text: string }

export interface BuiltView { html: string; problems: string[] }

const remote = (address: string) => /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(address);
const kept = (address: string) => address === '' || /^(?:data:|blob:|#|javascript:|about:|mailto:)/i.test(address);

/**
 * The page with every local file it names embedded, and what stops it from
 * being shown: a remote address, which the content policy would refuse in
 * front of the user, or a local file that is missing, outside the working
 * directory or of a kind a page has no use for. Each problem names its line.
 */
export function buildView(source: string, directory: string, cwd: string): BuiltView {
  const problems: string[] = [];
  const edits: Edit[] = [];
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const problem = (offset: number, text: string) => { if (problems.length < 12) problems.push(`line ${lineOf(offset)}: ${text}`); };
  const cache = new Map<string, { mime: string; data: Buffer } | string>();
  const load = (address: string): { mime: string; data: Buffer } | string => {
    const cached = cache.get(address);
    if (cached !== undefined) return cached;
    let path = address.split(/[?#]/, 1)[0] ?? '';
    try { path = decodeURIComponent(path); } catch { /* a stray percent sign: the name as written */ }
    const mime = EMBEDDED[extname(path).toLowerCase()];
    let loaded: { mime: string; data: Buffer } | string;
    if (!mime) loaded = `${address} is not a file a view can embed (images, fonts, audio, video, .css, .js)`;
    else {
      try {
        const found = existingInside(cwd, isAbsolute(path) ? path : resolve(directory, path), 'file', 'local file');
        loaded = found.stats.size > VIEW_MAX_BYTES ? `${address} is over 4 MB` : { mime, data: readFileSync(found.real) };
      } catch (error) { loaded = `${address}: ${messageOf(error)}`; }
    }
    cache.set(address, loaded);
    return loaded;
  };
  const dataUrl = (file: { mime: string; data: Buffer }) => `data:${file.mime};base64,${file.data.toString('base64')}`;

  // Comments and element bodies blanked to the same length: a tag written in a string is not the page's.
  const blank = (tags: string) => source.replace(new RegExp(`<!--[\\s\\S]*?(?:-->|$)|(<(${tags})\\b[^>]*>)([\\s\\S]*?)(?=<\\/\\2\\s*>|$)`, 'gi'),
    (match: string, open?: string, _tag?: string, body?: string) => open === undefined ? ' '.repeat(match.length) : open + ' '.repeat(body?.length ?? 0));
  const markup = blank('script|style');
  /** The page without its scripts: where a `url(` or an `@import` is a rule and not a string. */
  const styled = blank('script');
  for (const tag of markup.matchAll(LOADING_TAG)) {
    const name = tag[1]!.toLowerCase();
    const at = tag.index;
    for (const attribute of tag[0].matchAll(ADDRESS)) {
      const address = (attribute[2] ?? attribute[3] ?? attribute[4] ?? '').trim();
      if (kept(address)) continue;
      const offset = at + attribute.index;
      if (remote(address)) { problem(offset, `${address} is remote, and a view loads nothing remote. Embed the file from disk, or draw it in the page.`); continue; }
      if (name === 'iframe' || name === 'embed' || name === 'object') { problem(offset, `<${name}> cannot load ${address}: a view is one page.`); continue; }
      if (name === 'use') { problem(offset, `<use> cannot reach into ${address}: put the symbol in the page and name it by its #id.`); continue; }
      const file = load(address);
      if (typeof file === 'string') { problem(offset, file); continue; }
      const closing = name === 'script' ? /<\/script\s*>/i.exec(source.slice(at + tag[0].length)) : null;
      if (name === 'script' && closing) {
        // The file becomes the element's own text; a closing tag inside it would end the element early.
        edits.push({ start: at, end: at + tag[0].length + closing.index + closing[0].length, text: `<script>${file.data.toString('utf8').replace(/<\/script/gi, '<\\/script')}</script>` });
      } else if (name === 'link' && /\srel\s*=\s*["']?stylesheet/i.test(tag[0])) {
        edits.push({ start: at, end: at + tag[0].length, text: `<style>${file.data.toString('utf8').replace(/<\/style/gi, '<\\/style')}</style>` });
      } else {
        const value = attribute[0].slice(attribute[0].indexOf('=') + 1).trim();
        const start = offset + attribute[0].lastIndexOf(value);
        edits.push({ start, end: start + value.length, text: `"${dataUrl(file)}"` });
      }
    }
  }
  for (const found of source.matchAll(CSS_URL)) {
    const address = (found[1] ?? found[2] ?? found[3] ?? '').trim();
    // An import is refused below, whatever it names.
    if (kept(address) || /@import\s+$/i.test(source.slice(Math.max(0, found.index - 16), found.index))) continue;
    // Inside a script a `url(` is often no address at all: it is embedded when it names a file, and left as written otherwise.
    const rule = styled.slice(found.index, found.index + 4).toLowerCase() === 'url(';
    if (remote(address)) { if (rule) problem(found.index, `url(${address}) is remote, and a view loads nothing remote. Embed the file from disk.`); continue; }
    const file = load(address);
    if (typeof file === 'string') { if (rule) problem(found.index, file); continue; }
    edits.push({ start: found.index, end: found.index + found[0].length, text: `url("${dataUrl(file)}")` });
  }
  for (const found of styled.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
    problem(found.index, remote(found[1] ?? '')
      ? `@import of ${found[1]} is remote, and a view loads nothing remote.`
      : `@import of ${found[1]} is not followed: name the stylesheet with <link rel="stylesheet" href="${found[1]}">.`);
  }

  let html = '';
  let from = 0;
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    if (edit.start < from) continue;
    html += source.slice(from, edit.start) + edit.text;
    from = edit.end;
  }
  return { html: html + source.slice(from), problems };
}

function titleOf(asked: string | undefined, source: string, file: string): string {
  const title = (asked?.replace(/\s+/g, ' ').trim() || viewTitleOf(source) || basename(file).replace(/\.html?$/i, '')).slice(0, VIEW_TITLE_MAX);
  return title || 'View';
}

const notReady = (problems: string[]) => refused(`artifacts.view page is not ready to show. Fix the file and run the command again:\n${problems.map(problem => `- ${problem}`).join('\n')}`, { problems });

/**
 * Publish a page as a view. The message is journalled where the command ran;
 * a client draws it at the end of the turn. Unlike a published file, it does
 * not cut the running answer in two: the answer reads as one text above it.
 */
export async function publishView(core: Core, params: RpcParams<'artifacts.view'>): Promise<RpcResult<'artifacts.view'>> {
  const thread = core.threads.require(params.threadId);
  if (thread.archived) throw refused('artifacts.view needs an active thread', { threadId: thread.id });
  const turn = core.journal.listTurns(thread.id).at(-1);
  if (!turn) throw refused('artifacts.view needs a thread with a turn', { threadId: thread.id });
  const found = existingInside(thread.cwd, params.path, 'file', 'artifacts.view path');
  if (!/\.html?$/i.test(found.relative)) throw refused('artifacts.view path must be an HTML file', { path: params.path });
  if (found.stats.size > VIEW_MAX_BYTES) throw refused('artifacts.view page must be at most 4 MB', { path: params.path });
  const source = await readFile(found.real, 'utf8');
  if (!source.trim()) throw refused('artifacts.view page is empty', { path: params.path });
  const built = buildView(source, dirname(found.absolute), thread.cwd);
  if (built.problems.length) throw notReady(built.problems);
  const data = Buffer.from(viewDocument(built.html), 'utf8');
  if (data.length > VIEW_MAX_BYTES) throw refused(`artifacts.view page is ${(data.length / 1024 / 1024).toFixed(1)} MB with its files embedded; the limit is 4 MB. Use smaller images.`, { path: params.path });

  const id = randomUUID();
  const directory = join(core.dataDir, 'artifacts');
  const destination = join(directory, id);
  await mkdir(directory, { recursive: true });
  await writeFile(`${destination}.partial`, data, { flag: 'wx' });
  await rename(`${destination}.partial`, destination).catch(async (error: unknown) => { await unlink(`${destination}.partial`).catch(() => {}); throw error; });
  let committed = false;
  try {
    const name = basename(found.absolute);
    // The check loads the page exactly as a client will: from the view route, under its sandbox and policy.
    const ticket = core.fileTickets.mint(destination, VIEW_MIME, Date.now(), name, undefined, true);
    const probe = await core.browser.probe(`${core.baseUrl()}${VIEW_ROUTE}/${ticket}`, [VIEW_WIDTH, VIEW_NARROW_WIDTH]);
    if (probe?.errors.length) throw notReady(probe.errors);
    const [height, narrowHeight] = probe?.heights ?? [];
    const view: InlineView = {
      title: titleOf(params.title, source, name),
      height: clampViewHeight(height || VIEW_DEFAULT_HEIGHT),
      ...(narrowHeight ? { narrowHeight: clampViewHeight(narrowHeight) } : {}),
      source: found.relative,
    };
    if (core.threads.require(thread.id).archived) throw refused('artifacts.view needs an active thread', { threadId: thread.id });
    const message: Message = {
      id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', state: 'complete', createdAt: Date.now(),
      parts: [{ type: 'artifact', id, name, mimeType: VIEW_MIME, bytes: data.length, view }],
    };
    core.journal.append({ type: 'artifact.published', threadId: thread.id, version: 1, payload: message }, () => core.journal.putMessage(message));
    committed = true;
    core.bus.emit('message.started', message);
    core.bus.emit('message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
    return { message, checked: probe !== null };
  } finally {
    if (!committed) await unlink(destination).catch(() => {});
  }
}
