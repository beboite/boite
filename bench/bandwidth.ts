/**
 * What a phone on a weak link pays: bytes on the wire and time under a
 * simulated round trip, for the page load, the boot calls, opening a long
 * thread, one streamed turn and a reconnect. Everything runs on the echo
 * driver in a fresh data directory, through the counting relay of `lib/wire.ts`.
 *
 *   bun run bench/bandwidth.ts [--rtt 150] [--sequence sequential|pipelined] [--core path/to/main.ts] [--locale en|fr] [--only page] [--json out.json]
 *
 * `--sequence` is which client the calls imitate: `sequential` is the UI before
 * 2026-09-19 (one call awaited after the other on a thread open), `pipelined`
 * the UI after it. `--locale` is the device's language: the page load adds the
 * catalogue chunk index.html's head script preloads for it. `--only page`
 * stops after the three page-load rows.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { connect, type CoreClient } from '../packages/core/src/client.ts';
import { removeDirectory, startCore } from '../tests/e2e/lib/core.ts';
import { startWire } from './lib/wire.ts';


const SEED_TURNS = 40;
const SEED_WORDS = 250;

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const RTT_MS = Number(flag('rtt', '150'));
const SEQUENCE = flag('sequence', 'pipelined') as 'sequential' | 'pipelined';
const JSON_OUT = flag('json', '');
/** The core deflates and paces for a client that dialled anything but loopback; the relay is on loopback, so the name is said here. */
const REMOTE = { client: { name: 'bench', version: '2.0.0-beta.1' }, timeoutMs: 20_000, headers: { host: 'phone.bench.test' } };

const CORE_MAIN = flag('core', '');
const LOCALE = flag('locale', 'en');
const ONLY_PAGE = flag('only', '') === 'page';
/** What a browser opens to one host over HTTP/1.1, which is all Bun.serve speaks. */
const CONNECTIONS = 6;

/**
 * Text that deflates like prose rather than like `word0 word1 word2`: a fixed
 * seed, a vocabulary of 1800 made-up words on a Zipf-like draw, sentences and
 * the odd code span. The same seed gives the same bytes on every run, so two
 * cores are compared on the same conversation.
 */
function proseSource(seed: number): (count: number) => string {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
  const letters = 'etaoinshrdlcumwfgypbvkjxqz';
  const vocabulary = Array.from({ length: 1800 }, () => {
    const length = 2 + Math.floor(next() * next() * 12);
    return Array.from({ length }, () => letters[Math.floor(next() * next() * letters.length)]).join('');
  });
  return (count) => {
    const out: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const word = vocabulary[Math.floor(next() ** 2.2 * vocabulary.length)] as string;
      const roll = next();
      out.push(roll < 0.08 ? `${word}.` : roll < 0.14 ? `${word},` : roll < 0.17 ? `\`${word}_${Math.floor(next() * 900)}()\`` : word);
    }
    return out.join(' ');
  };
}
const words = proseSource(20260919);

interface Row {
  name: string;
  downBytes: number;
  upBytes: number;
  chunksDown: number;
  ms: number;
}

async function settle(): Promise<void> {
  await Bun.sleep(RTT_MS + 120);
}

/** The ten calls of `Connection.#load` (`packages/ui/src/lib/store/connection.svelte.ts`), all in flight at once, as the UI sends them. */
async function boot(client: CoreClient): Promise<void> {
  await Promise.all([
    client.call('projects.list', {}),
    client.call('threads.list', {}),
    client.call('providers.list', {}),
    client.call('accounts.list', {}),
    client.call('settings.get', {}),
    client.call('scheduler.get', {}),
    client.call('permissions.list', {}),
    client.call('questions.list', {}),
    client.call('accounts.logins', {}),
    client.call('keybindings.get', {}),
  ]);
}

/** `Store.open`, up to the moment the messages are in hand, then to the end. */
async function openThread(client: CoreClient, threadId: string, after?: string): Promise<{ firstMessagesMs: number; lastMessageId: string | undefined }> {
  const startedAt = performance.now();
  if (SEQUENCE === 'sequential') {
    await client.call('threads.subscribe', { threadId });
    const whole = await client.call('threads.get', { threadId });
    const firstMessagesMs = performance.now() - startedAt;
    await client.call('trace.get', { threadId });
    await client.call('permissions.list', { threadId });
    await client.call('questions.list', { threadId });
    return { firstMessagesMs, lastMessageId: whole.messages.at(-1)?.id };
  }
  const subscribed = client.call('threads.subscribe', { threadId });
  // `after` is what `resumeAnchor` names in the UI once every known turn is over: the last message held.
  const thread = client.call('threads.get', after === undefined ? { threadId } : { threadId, after });
  const permissions = client.call('permissions.list', { threadId });
  const questions = client.call('questions.list', { threadId });
  await Promise.all([subscribed, thread]);
  const firstMessagesMs = performance.now() - startedAt;
  await Promise.all([permissions, questions]);
  return { firstMessagesMs, lastMessageId: (await thread).messages.at(-1)?.id };
}

// The UI the measured core serves: the one beside it.
const UI_DIST = CORE_MAIN === ''
  ? join(import.meta.dir, '..', 'packages', 'ui', 'dist')
  : join(dirname(CORE_MAIN), '..', '..', 'ui', 'dist');
const UI_INDEX = join(UI_DIST, 'index.html');

/** The faces index.html preloads when Appearance was never touched (`--font-sans` and `--font-mono` in app.css): its script builds their URLs from names, so the mono one is read by its name. */
function defaultFonts(html: string): string[] {
  const mono = /['"`](GeistMono-[\w-]+)['"`]/.exec(html)?.[1] ?? 'GeistMono-latin';
  return ['/fonts/Inter-latin.woff2', `/fonts/${mono}.woff2`];
}

/** What a browser keeps of one answer to decide the next load: its freshness and its validators. */
interface Cached { path: string; cacheControl: string; etag: string | null; lastModified: string | null }

/** The catalogue chunk the head script preloads for `locale` (`lib/locale-preload.ts`), if the build has one. */
function catalogueOf(html: string, locale: string): string[] {
  const map = /var c=(\{[^}]*\})/.exec(html)?.[1];
  const chunk = map === undefined ? undefined : (JSON.parse(map) as Record<string, string>)[locale];
  return chunk === undefined ? [] : [chunk.replace(/^\./, '')];
}

/** Runs `tasks` with at most `limit` in flight, in their order, as a browser queues requests to one host. */
async function pooled<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < tasks.length) {
      const at = next++;
      results[at] = await (tasks[at] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, lane));
  return results;
}

/** The files a first load fetches: what the document loads by `src` or `href`, the device's catalogue, the default fonts, the manifest and the worker. */
async function staticLoad(base: string): Promise<Cached[]> {
  const html = readFileSync(UI_INDEX, 'utf8');
  // Attributes, as the worker precaches, and the one catalogue of the locale map this device fetches.
  const named = [...html.matchAll(/(?:src|href)="\.?(\/assets\/[^"]+)"/g)].map((found) => found[1] as string);
  const referenced = [...new Set([...named, ...catalogueOf(html, LOCALE)])];
  const paths = ['/', ...referenced, ...defaultFonts(html), '/manifest.webmanifest', '/sw.js'];
  // A browser opens six connections to one host; the order is the document's.
  const headers = { 'accept-encoding': 'gzip, deflate, br, zstd' };
  const get = async (path: string): Promise<Cached> => {
    const response = await fetch(`${base}${path}`, { headers });
    await response.arrayBuffer();
    return { path, cacheControl: response.headers.get('cache-control') ?? '', etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
  };
  const first = await get('/');
  return [first, ...await pooled(paths.slice(1).map((path) => () => get(path)), CONNECTIONS)];
}

/**
 * The same files on the next open with the HTTP cache warm and no service
 * worker, as a phone on plain http: a file still fresh is not asked for, one
 * with a validator is revalidated, and one with neither is fetched whole.
 */
async function warmLoad(base: string, cached: Cached[]): Promise<void> {
  const fresh = (entry: Cached): boolean => !/no-cache|no-store/.test(entry.cacheControl) && /max-age=[1-9]/.test(entry.cacheControl);
  const conditional = (entry: Cached): Record<string, string> => ({
    'accept-encoding': 'gzip, deflate, br, zstd',
    ...(entry.etag === null ? {} : { 'if-none-match': entry.etag }),
    ...(entry.lastModified === null ? {} : { 'if-modified-since': entry.lastModified }),
  });
  const [shell, ...rest] = cached;
  if (shell === undefined) return;
  const get = (entry: Cached): Promise<ArrayBuffer> => fetch(`${base}${entry.path}`, { headers: conditional(entry) }).then((response) => response.arrayBuffer());
  await get(shell);
  await pooled(rest.filter((entry) => !fresh(entry)).map((entry) => () => get(entry)), CONNECTIONS);
}

/** Every script and stylesheet the document does not name: what the idle prefetch and the first visit to Settings bring in. */
async function lazyLoad(base: string): Promise<void> {
  const html = readFileSync(UI_INDEX, 'utf8');
  const headers = { 'accept-encoding': 'gzip, deflate, br, zstd' };
  const rest = readdirSync(join(UI_DIST, 'assets')).filter((name) => /\.(?:js|css)$/.test(name) && !html.includes(name));
  await Promise.all(rest.map((name) => fetch(`${base}/assets/${name}`, { headers }).then((response) => response.arrayBuffer())));
}

function report(rows: Row[]): void {
  const kb = (bytes: number): string => (bytes / 1024).toFixed(1);
  console.log(`\nround trip ${RTT_MS} ms, ${SEQUENCE} client, ${LOCALE} device, ${new Date().toISOString().slice(0, 10)}\n`);
  console.log('| scenario | down KB | up KB | relay reads down | ms |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    console.log(`| ${row.name} | ${row.downBytes === 0 && row.upBytes === 0 ? '' : kb(row.downBytes)} | ${row.downBytes === 0 && row.upBytes === 0 ? '' : kb(row.upBytes)} | ${row.chunksDown === 0 ? '' : row.chunksDown} | ${Math.round(row.ms)} |`);
  }
  if (JSON_OUT !== '') writeFileSync(JSON_OUT, `${JSON.stringify({ rttMs: RTT_MS, sequence: SEQUENCE, locale: LOCALE, rows }, null, 2)}\n`);
}

async function main(): Promise<void> {
  if (!existsSync(UI_INDEX)) throw new Error('packages/ui/dist is missing: bun run build:ui first');
  const core = await startCore(CORE_MAIN === '' ? {} : { command: ['bun', 'run', CORE_MAIN] });
  const direct = await connect(core.url, core.token, { client: { name: 'bench', version: '2.0.0-beta.1' } });
  const directory = mkdtempSync(join(tmpdir(), 'boite-bench-project-'));
  const rows: Row[] = [];
  let wire: ReturnType<typeof startWire> | undefined;
  let client: CoreClient | undefined;

  try {
    const project = await direct.call('projects.add', { path: directory, name: 'bench' });
    const account = (await direct.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
    if (account === undefined) throw new Error('the core has no echo account');

    // A sidebar worth of threads, and one long conversation to open.
    for (let index = 0; index < 60; index += 1) {
      await direct.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: `side thread number ${index}` });
    }
    const long = await direct.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'long' });
    for (let turn = 0; turn < SEED_TURNS; turn += 1) {
      const done = direct.next('turn.finished', (event) => event.threadId === long.id, 60_000);
      await direct.call('turns.start', { threadId: long.id, prompt: `${turn % 5 === 0 ? '[tool] ' : ''}${words(SEED_WORDS)}` });
      await done;
    }

    const relay = startWire(core.port, RTT_MS / 2);
    wire = relay;
    const measure = async (name: string, run: () => Promise<number | void>): Promise<void> => {
      relay.reset();
      const startedAt = performance.now();
      const reported = await run();
      const ms = typeof reported === 'number' ? reported : performance.now() - startedAt;
      await settle();
      const { up, down, chunksDown } = relay.read();
      rows.push({ name, downBytes: down, upBytes: up, chunksDown, ms });
    };

    let cached: Cached[] = [];
    await measure('page load, cold cache (html, js, css, fonts, manifest, worker)', async () => {
      cached = await staticLoad(relay.url);
    });
    await measure('page load again, warm HTTP cache, no service worker', async () => {
      await warmLoad(relay.url, cached);
    });
    await measure('every other script and stylesheet (idle prefetch, settings, highlighters)', async () => {
      await lazyLoad(relay.url);
    });
    if (ONLY_PAGE) return report(rows);

    await measure('connect, hello and the boot calls', async () => {
      client = await connect(relay.url, core.token, REMOTE);
      await boot(client);
    });
    const remote = (): CoreClient => {
      if (client === undefined) throw new Error('the remote client is not connected');
      return client;
    };

    let firstMessagesMs = 0;
    await measure(`open a ${SEED_TURNS} turn thread, whole sequence`, async () => {
      firstMessagesMs = (await openThread(remote(), long.id)).firstMessagesMs;
    });
    rows.push({ name: `open a ${SEED_TURNS} turn thread, until the messages are in hand`, downBytes: 0, upBytes: 0, chunksDown: 0, ms: firstMessagesMs });

    await measure(`one streamed turn of ${SEED_WORDS} words, subscribed`, async () => {
      const done = remote().next('turn.finished', (event) => event.threadId === long.id, 60_000);
      await remote().call('turns.start', { threadId: long.id, prompt: words(SEED_WORDS) });
      await done;
    });
    // What the UI holds when the link drops: the thread as of now.
    const held = (await direct.call('threads.get', { threadId: long.id })).messages.at(-1)?.id;

    await measure('a turn streaming on another thread, not subscribed', async () => {
      const other = await direct.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'other' });
      relay.reset();
      const done = direct.next('turn.finished', (event) => event.threadId === other.id, 60_000);
      await direct.call('turns.start', { threadId: other.id, prompt: words(SEED_WORDS) });
      await done;
    });

    await measure('thirty seconds idle, connected', async () => {
      await Bun.sleep(30_000);
    });

    remote().close();
    await measure('reconnect: hello, boot calls and the open thread again', async () => {
      client = await connect(relay.url, core.token, REMOTE);
      await boot(client);
      await openThread(remote(), long.id, held);
    });
  } finally {
    client?.close();
    wire?.stop();
    direct.close();
    await core.stop();
    await removeDirectory(directory);
  }

  report(rows);
}

await main();
