/*
 * `boite view`: an HTML page of the thread's working directory becomes an
 * inline view of the conversation. The page is made self-contained (its local
 * files embedded, nothing remote), given the theme bootstrap, stored as an
 * artifact snapshot and loaded once in a headless browser. Whatever is wrong
 * with it goes back to the agent as the refusal's sentence, so the user is
 * only ever shown a page that loaded cleanly. docs/chat-files.md has the rest.
 */
import { mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzip, type InputType, type ZlibOptions } from 'node:zlib';
import {
  RPC_MAX_FRAME_BYTES, VIEW_BLEED, VIEW_DEFAULT_HEIGHT, VIEW_MAX_BYTES, VIEW_NARROW_WIDTH, VIEW_ROUTE, VIEW_TITLE_MAX, VIEW_WIDTH,
  clampViewHeight, viewDocument, viewTitleOf,
  type InlineView, type Message, type RpcParams, type RpcResult,
} from '@boite/contracts';
import type { Core } from './core.ts';
import { existingInside, openChecked } from './workdir.ts';
import { messageOf, refused } from './errors.ts';
import { newId } from './ids.ts';

const VIEW_MIME = 'text/html';
/**
 * The snapshot gzipped once at publication, beside it: the view route sends it
 * to a client that reads gzip, about five times fewer bytes on every mount.
 * gzip rather than br because a phone on plain http is offered no br.
 */
export const VIEW_GZIP_SUFFIX = '.gz';
// Not `promisify`: importing `node:util` costs every core start (startup-imports.test.ts).
const gzipped = (data: InputType, options: ZlibOptions): Promise<Buffer> =>
  new Promise((done, fail) => gzip(data, options, (error, result) => (error ? fail(error) : done(result))));

/** What a page may embed from the disk, by extension. Anything else is refused by name. */
const EMBEDDED: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json',
};

/**
 * The rest of a tag up to its `>`: a quoted value after `=` is one piece, so
 * a `>` inside it does not end the tag, and a quote anywhere else is a letter.
 * Each character has one reading, and a `<` outside quotes gives up on the
 * tag, so a page full of tags left open is still read in one pass.
 */
/** Where a tag's name ends: `<title-card>` is not a `<title>`. */
const NAME_END = String.raw`(?=[\s/>])`;
const TAG_REST = String.raw`(?:[^<>"'=]|=(?!\s*["'])|=\s*"[^"]*"|=\s*'[^']*'|(?<!=\s*)["'])*>`;
/** Tags whose address is fetched when the page loads. An `<a>` is not one: its link opens in the user's browser on a click. */
const LOADING_TAG = new RegExp(`<(img|image|source|video|audio|track|script|link|use|input|iframe|embed|object)${NAME_END}${TAG_REST}`, 'gi');
const ADDRESS = new Set(['src', 'href', 'xlink:href', 'poster', 'data']);
/** The attributes whose value is CSS: `style` and SVG's presentation attributes that take a `url(`. */
const CSS_ATTRIBUTE = new Set(['style', 'fill', 'stroke', 'mask', 'clip-path', 'filter', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi;
const TAG = new RegExp(`<[a-z]${TAG_REST}`, 'gi');
/** Each attribute of a tag in turn, so a name written inside another's quoted value is never read. */
const ATTRIBUTE = /\s([^\s=>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/dg;

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
export function buildView(source: string, directory: string, cwd: string, guard?: (path: string) => import('./contacts/access-policy.ts').SharedFilePermit | undefined): BuiltView {
  const problems: string[] = [];
  const edits: Edit[] = [];
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;
  const problem = (offset: number, text: string) => { if (problems.length < 12) problems.push(`line ${lineOf(offset)}: ${text}`); };
  const cache = new Map<string, { mime: string; data: Buffer } | string>();
  /** A file named from `folder`: the page's own, or the folder of the stylesheet that names it. */
  const load = (address: string, folder = directory): { mime: string; data: Buffer } | string => {
    const key = `${folder}\0${address}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let path = address.split(/[?#]/, 1)[0] ?? '';
    try { path = decodeURIComponent(path); } catch { /* a stray percent sign: the name as written */ }
    const mime = EMBEDDED[extname(path).toLowerCase()];
    let loaded: { mime: string; data: Buffer } | string;
    if (!mime) loaded = `${address} is not a file a view can embed (images, fonts, audio, video, .css, .js)`;
    else {
      try {
        const permit = guard?.(isAbsolute(path) ? path : resolve(folder, path));
        const found = existingInside(cwd, isAbsolute(path) ? path : resolve(folder, path), 'file', 'local file');
        // Read through the descriptor of the file that was checked: a link swapped in since is not followed.
        const fd = openSync(found.real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
          const stats = fstatSync(fd, { bigint: true });
          permit?.opened?.(found.real, stats);
          if (!stats.isFile() || stats.dev !== found.stats.dev || stats.ino !== found.stats.ino) loaded = `${address} changed while it was opened`;
          else {
            loaded = stats.size > BigInt(VIEW_MAX_BYTES) ? `${address} is over 4 MB` : { mime, data: readFileSync(fd) };
            if (typeof loaded !== 'string') permit?.inspect(loaded.data);
          }
        } finally { closeSync(fd); }
      } catch (error) { loaded = `${address}: ${messageOf(error)}`; }
    }
    cache.set(key, loaded);
    return loaded;
  };
  const dataUrl = (file: { mime: string; data: Buffer }) => `data:${file.mime};base64,${file.data.toString('base64')}`;

  /**
   * A stylesheet file as the text of a `<style>`: what its rules name is found
   * from its own folder, and embedded here, since nothing of it is in `source`.
   */
  const stylesheet = (css: string, folder: string, at: number): string => {
    if (/@import\b/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ''))) problem(at, 'the stylesheet uses @import, which is not followed: link each stylesheet from the page.');
    return css.replace(CSS_URL, (rule: string, double?: string, single?: string, bare?: string) => {
      const address = (double ?? single ?? bare ?? '').trim();
      if (kept(address)) return rule;
      if (remote(address)) { problem(at, `url(${address}) in the stylesheet is remote, and a view loads nothing remote. Embed the file from disk.`); return rule; }
      const file = load(address, folder);
      if (typeof file === 'string') { problem(at, file); return rule; }
      return `url("${dataUrl(file)}")`;
    }).replace(/<\/style/gi, '<\\/style');
  };

  // Comments and element bodies blanked to the same length: a tag written in a string is not the page's.
  // Every other tag is read whole, and a `<` in its quoted values blanked, so a tag spelled there starts nothing.
  // A script's, style's, textarea's or title's body is text, not tags: what it spells is never loaded.
  const inert = (tag: string) => tag[0] + tag.slice(1).replace(/</g, ' ');
  /** Where each style body is: its rules are CSS, read from `source`. */
  const styles: [number, number][] = [];
  /** The page in one pass without its comments and element bodies: where a tag is the page's. */
  const markup = source.replace(new RegExp(`<!--[\\s\\S]*?(?:-->|$)|(<(script|style|textarea|title)${NAME_END}${TAG_REST})([\\s\\S]*?)(?=<\\/\\2\\s*>|$)|<\\/?[a-z]${TAG_REST}`, 'gi'),
    (match: string, open: string | undefined, element: string | undefined, body: string | undefined, at: number) => {
      if (match.startsWith('<!--')) return ' '.repeat(match.length);
      if (open === undefined) return inert(match);
      if (element!.toLowerCase() === 'style') styles.push([at + open.length, at + match.length]);
      return inert(open) + ' '.repeat(body!.length);
    });
  for (const tag of markup.matchAll(LOADING_TAG)) {
    const name = tag[1]!.toLowerCase();
    const at = tag.index;
    for (const attribute of tag[0].matchAll(ATTRIBUTE)) {
      if (!ADDRESS.has(attribute[1]!.toLowerCase())) continue;
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
        const sheet = address.split(/[?#]/, 1)[0] ?? '';
        edits.push({ start: at, end: at + tag[0].length, text: `<style>${stylesheet(file.data.toString('utf8'), dirname(isAbsolute(sheet) ? sheet : resolve(directory, sheet)), offset)}</style>` });
      } else {
        const value = attribute[0].slice(attribute[0].indexOf('=') + 1).trim();
        const start = offset + attribute[0].lastIndexOf(value);
        edits.push({ start, end: start + value.length, text: `"${dataUrl(file)}"` });
      }
    }
  }
  /**
   * Where a `url(` is CSS: the bodies of `<style>` elements and the values of
   * CSS attributes (`style`, SVG's `fill` or `mask`). Script text, prose, a
   * `title` or an `onclick` keep theirs as written. The data URL goes
   * unquoted, which no attribute's quotes can end early.
   */
  const css: [number, number][] = [...styles];
  for (const tag of markup.matchAll(TAG)) {
    for (const value of tag[0].matchAll(ATTRIBUTE)) {
      if (!CSS_ATTRIBUTE.has(value[1]!.toLowerCase())) continue;
      const [start, end] = (value.indices![2] ?? value.indices![3] ?? value.indices![4])!;
      css.push([tag.index + start, tag.index + end]);
    }
  }
  for (const [start, end] of css) {
    for (const found of source.slice(start, end).matchAll(CSS_URL)) {
      const at = start + found.index;
      const address = (found[1] ?? found[2] ?? found[3] ?? '').trim();
      // An import is refused below, whatever it names.
      if (kept(address) || /@import\s+$/i.test(source.slice(Math.max(start, at - 16), at))) continue;
      if (remote(address)) { problem(at, `url(${address}) is remote, and a view loads nothing remote. Embed the file from disk.`); continue; }
      const file = load(address);
      if (typeof file === 'string') { problem(at, file); continue; }
      edits.push({ start: at, end: at + found[0].length, text: `url(${dataUrl(file)})` });
    }
  }
  // An import in prose is no rule either: only the same CSS regions are read.
  for (const [start, end] of css) {
    for (const found of source.slice(start, end).matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s;]+)/gi)) {
      problem(start + found.index, remote(found[1] ?? '')
        ? `@import of ${found[1]} is remote, and a view loads nothing remote.`
        : `@import of ${found[1]} is not followed: name the stylesheet with <link rel="stylesheet" href="${found[1]}">.`);
    }
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

const NAMED_COLORS = 'black|white|red|green|blue|yellow|orange|purple|pink|gray|grey|brown|cyan|magenta|navy|teal|lime|gold|silver|maroon|olive';

/**
 * What would make a page look more like the app, said to the agent and never
 * held against the publish: a color written as a value does not follow the
 * user's theme or accent, and a font of its own is not the app's face. A mock
 * of somebody else's screen has reasons for both, which is why this advises.
 */
export function viewAdvice(source: string): string[] {
  // Embedded files and comments say nothing about the page's own look.
  const text = source.replace(/<!--[\s\S]*?(?:-->|$)|\/\*[\s\S]*?\*\//g, ' ').replace(/data:[a-z0-9.+-]+\/[a-z0-9.+-]+[;,][^"')\s]*/gi, 'data:');
  const colors = new Set<string>();
  // A hash that names an element (href="#id", url(#id), a CSS id selector) is not a color.
  for (const found of text.matchAll(/(?<![\w&/])#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b(?![\w-])/gi)) {
    const before = text.slice(Math.max(0, found.index - 24), found.index);
    if (/(?:href|for|id|list|aria-[\w-]+|data-[\w-]+)\s*=\s*["']?$/i.test(before) || /url\(\s*["']?$/i.test(before) || /(?:^|[{};,>+~\s])$/.test(before) && /^\s*[^;{}]*\{/.test(text.slice(found.index + found[0].length, found.index + found[0].length + 80))) continue;
    colors.add(found[0].toLowerCase());
  }
  for (const found of text.matchAll(/\b(?:rgb|hsl)a?\(\s*\d[^)]*\)/gi)) colors.add(found[0].replace(/\s+/g, ''));
  for (const found of text.matchAll(new RegExp(`(?:fill|stroke|color|stop-color|background(?:-color)?|border(?:-color)?)\\s*[:=]\\s*["']?\\s*(${NAMED_COLORS})\\b`, 'gi'))) colors.add(found[1]!.toLowerCase());
  const advice: string[] = [];
  if (colors.size) {
    const shown = [...colors].slice(0, 4).join(', ');
    advice.push(`${colors.size} fixed color${colors.size === 1 ? '' : 's'} (${shown}${colors.size > 4 ? ', and more' : ''}) will not follow the user's theme or accent: use the variables (var(--color-foreground), var(--color-accent), var(--series-1)) or the classes of boite view help.`);
  }
  const fonts = new Set<string>();
  for (const found of text.matchAll(/font(?:-family)?\s*[:=]\s*["']?([^;}"<>]+)/gi)) {
    const value = found[1]!.trim();
    // The shorthand without a family (bold 12px) and the app's own faces are fine.
    if (/var\(--font-|inherit|^\d|^(?:bold|normal|italic|[1-9]00)\b[^,]*$/i.test(value) && !/,/.test(value.replace(/var\([^)]*\)/g, ''))) continue;
    if (/[a-z]/i.test(value) && /,|serif|mono|system-ui|arial|helvetica|inter|roboto/i.test(value)) fonts.add(value.slice(0, 60));
  }
  if (fonts.size) advice.push(`a font of its own (${[...fonts][0]}) replaces the app's face: use var(--font-sans) or var(--font-mono), which the page already has.`);
  return advice;
}

function titleOf(asked: string | undefined, source: string, file: string): string {
  const title = (asked?.replace(/\s+/g, ' ').trim() || viewTitleOf(source) || basename(file).replace(/\.html?$/i, '')).slice(0, VIEW_TITLE_MAX);
  return title || 'View';
}

const notReady = (problems: string[], method = 'artifacts.view') => refused(`${method} page is not ready to show. Fix the file and run the command again:\n${problems.map(problem => `- ${problem}`).join('\n')}`, { problems });

/** The same checked input and embedded document for publication and private checks. */
async function prepareView(core: Core, params: { threadId: string; path: string }, method: string) {
  const thread = core.threads.require(params.threadId);
  const permit = core.sharedAccess.file(thread.id, params.path, 'publish');
  const permits = permit ? [permit] : [];
  if (thread.archived) throw refused(`${method} needs an active thread`, { threadId: thread.id });
  const turn = core.journal.lastTurn(thread.id);
  if (!turn) throw refused(`${method} needs a thread with a turn`, { threadId: thread.id });
  const found = existingInside(thread.cwd, params.path, 'file', `${method} path`);
  if (!/\.html?$/i.test(found.relative)) throw refused(`${method} path must be an HTML file`, { path: params.path });
  if (found.stats.size > VIEW_MAX_BYTES) throw refused(`${method} page must be at most 4 MB`, { path: params.path });
  const handle = await openChecked(found.real, constants.O_RDONLY, found.stats.dev, found.stats.ino, `${method} path`, params.path);
  let source: string;
  try {
    if (permit) permit.opened?.(found.real, await handle.stat({bigint: true}));
    source = await handle.readFile('utf8');
  } finally { await handle.close(); }
  permit?.inspect(source);
  if (!source.trim()) throw refused(`${method} page is empty`, { path: params.path });
  const built = buildView(source, dirname(found.absolute), thread.cwd, permit ? path => {
    const logical = relative(thread.cwd, path).split(sep).join('/');
    const dependency = core.sharedAccess.file(thread.id, logical, 'publish')!;
    permits.push(dependency); return dependency;
  } : undefined);
  if (built.problems.length) throw notReady(built.problems, method);
  const data = Buffer.from(viewDocument(built.html), 'utf8');
  if (data.length > VIEW_MAX_BYTES) throw refused(`${method} page is ${(data.length / 1024 / 1024).toFixed(1)} MB with its files embedded; the limit is 4 MB. Use smaller images.`, { path: params.path });
  return { thread, turn, found, source, data, permit, permits };
}

/** Render a disposable draft. No journal entry, panel request or browser tab is created. */
export async function checkView(core: Core, params: RpcParams<'artifacts.viewCheck'>): Promise<RpcResult<'artifacts.viewCheck'>> {
  if (params.script !== undefined && typeof params.script !== 'string') throw refused('artifacts.viewCheck script must be JavaScript text');
  if (params.scheme !== undefined && params.scheme !== 'dark' && params.scheme !== 'light') throw refused('artifacts.viewCheck scheme must be dark or light');
  const { found, source, data, permits } = await prepareView(core, params, 'artifacts.viewCheck');
  const root = join(core.dataDir, 'view-checks');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, 'draft-'));
  let ticket: string | undefined;
  try {
    const destination = join(directory, 'page.html');
    await writeFile(destination, data, { flag: 'wx' });
    ticket = core.fileTickets.mint(destination, VIEW_MIME, Date.now(), basename(found.absolute), undefined, true,
      permits.length ? {check: () => {for (const p of permits) p.check();}, inspect: () => {for (const p of permits) p.check();}} : undefined);
    const probe = await core.browser.checkView(`${core.baseUrl()}${VIEW_ROUTE}/${ticket}`, { script: params.script, scheme: params.scheme });
    for (const p of permits) p.check();
    const result: RpcResult<'artifacts.viewCheck'> = {
      checked: probe !== null,
      errors: probe?.errors ?? ['the draft could not be checked: this machine has no available browser, or the browser did not answer in time'],
      advice: viewAdvice(source),
      captures: probe?.captures ?? [],
    };
    // Captures and a script return share one RPC frame. Keep room for its envelope.
    if (Buffer.byteLength(JSON.stringify(result)) > RPC_MAX_FRAME_BYTES - 64 * 1024) {
      result.captures = [];
      result.errors.push('the draft captures and script results exceed the 16 MB RPC response limit; reduce image detail or return a smaller script result');
    }
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
    // Resolving the deleted file also drops its ticket from memory.
    if (ticket) core.fileTickets.resolve(ticket);
  }
}

/**
 * Publish a page as a view. The message is journalled where the command ran;
 * a client draws it where a line of the turn's answer places it, else at the
 * end of the turn. Unlike a published file, it does not cut the running answer
 * in two where the command ran: only the answer's own line places it.
 */
export async function publishView(core: Core, params: RpcParams<'artifacts.view'>): Promise<RpcResult<'artifacts.view'>> {
  const { thread, turn, found, source, data, permit, permits } = await prepareView(core, params, 'artifacts.view');

  const id = randomUUID();
  const directory = join(core.dataDir, 'artifacts');
  const destination = join(directory, id);
  await mkdir(directory, { recursive: true });
  await writeFile(`${destination}.partial`, data, { flag: 'wx' });
  await rename(`${destination}.partial`, destination).catch(async (error: unknown) => { await unlink(`${destination}.partial`).catch(() => {}); throw error; });
  let committed = false;
  try {
    // Written before the probe, so the headless check loads the copy clients will get.
    await writeFile(`${destination}${VIEW_GZIP_SUFFIX}`, await gzipped(data, { level: 9 }), { flag: 'wx' });
    const name = basename(found.absolute);
    // The check loads the page exactly as a client will: from the view route, under its sandbox and policy, in a frame as wide as the client's.
    const ticket = core.fileTickets.mint(destination, VIEW_MIME, Date.now(), name, undefined, true, permit ? {check: () => {for (const p of permits) p.check();}, inspect: () => {for (const p of permits) p.check();}} : undefined);
    const probe = await core.browser.probe(`${core.baseUrl()}${VIEW_ROUTE}/${ticket}`, [VIEW_WIDTH, VIEW_NARROW_WIDTH].map(width => width + 2 * VIEW_BLEED));
    if (probe?.errors.length) throw notReady(probe.errors);
    const [height, narrowHeight] = probe?.heights ?? [];
    const view: InlineView = {
      title: titleOf(params.title, source, name),
      height: clampViewHeight(height || VIEW_DEFAULT_HEIGHT),
      ...(narrowHeight ? { narrowHeight: clampViewHeight(narrowHeight) } : {}),
      source: found.relative,
    };
    if (core.threads.require(thread.id).archived) throw refused('artifacts.view needs an active thread', { threadId: thread.id });
    for (const p of permits) p.check();
    const message: Message = {
      id: newId('msg_'), threadId: thread.id, turnId: turn.id, role: 'assistant', state: 'complete', createdAt: Date.now(),
      parts: [{ type: 'artifact', id, name, mimeType: VIEW_MIME, bytes: data.length, view }],
    };
    core.sharedAccess.published(thread.id, message.id, permits);
    core.journal.append({ type: 'artifact.published', threadId: thread.id, version: 1, payload: message }, () => core.journal.putMessage(message));
    committed = true;
    core.bus.emit('message.started', message);
    core.bus.emit('message.completed', { threadId: thread.id, messageId: message.id, state: 'complete' });
    return { message, checked: probe !== null, advice: viewAdvice(source) };
  } finally {
    if (!committed) await Promise.all([unlink(destination), unlink(`${destination}${VIEW_GZIP_SUFFIX}`)].map(removal => removal.catch(() => {})));
  }
}
