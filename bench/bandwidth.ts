/**
 * What a phone on a weak link pays: bytes on the wire and time under a
 * simulated round trip, for the page load, the boot calls, opening a long
 * thread, one streamed turn and a reconnect. Everything runs on the echo
 * driver in a fresh data directory, through the counting relay of `lib/wire.ts`.
 *
 *   bun run bench/bandwidth.ts [--rtt 150] [--sequence sequential|pipelined] [--core path/to/main.ts] [--json out.json]
 *
 * `--sequence` is which client the calls imitate: `sequential` is the UI before
 * 2026-09-19 (one call awaited after the other on a thread open), `pipelined`
 * the UI after it.
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

/** The ten calls of `Store.#load`, all in flight at once, as the UI sends them. */
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

async function staticLoad(base: string): Promise<{ files: number }> {
  const html = readFileSync(UI_INDEX, 'utf8');
  const referenced = [...new Set(html.match(/\.\/(?:assets|fonts)\/[^\s"'<>]+/g) ?? [])].map((path) => path.slice(1));
  const paths = ['/', ...referenced, '/manifest.webmanifest', '/sw.js'];
  // A browser opens six connections to one host; the order is the document's.
  const headers = { 'accept-encoding': 'gzip, deflate, br, zstd' };
  await fetch(`${base}/`, { headers }).then((response) => response.arrayBuffer());
  await Promise.all(paths.slice(1).map((path) => fetch(`${base}${path}`, { headers }).then((response) => response.arrayBuffer())));
  return { files: paths.length };
}

/** Every script and stylesheet the document does not name: what the idle prefetch and the first visit to Settings bring in. */
async function lazyLoad(base: string): Promise<void> {
  const html = readFileSync(UI_INDEX, 'utf8');
  const headers = { 'accept-encoding': 'gzip, deflate, br, zstd' };
  const rest = readdirSync(join(UI_DIST, 'assets')).filter((name) => /\.(?:js|css)$/.test(name) && !html.includes(name));
  await Promise.all(rest.map((name) => fetch(`${base}/assets/${name}`, { headers }).then((response) => response.arrayBuffer())));
}

async function main(): Promise<void> {
  if (!existsSync(UI_INDEX)) throw new Error('packages/ui/dist is missing: bun run build:ui first');
  const core = await startCore(CORE_MAIN === '' ? {} : { command: ['bun', 'run', CORE_MAIN] });
  const direct = await connect(core.url, core.token, { client: { name: 'bench', version: '2.0.0-beta.1' } });
  const directory = mkdtempSync(join(tmpdir(), 'boite-bench-project-'));
  const rows: Row[] = [];

  try {
    await direct.call('settings.set', { maxConcurrentTurns: 8, perAccountConcurrency: 8 });
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

    const wire = startWire(core.port, RTT_MS / 2);
    const measure = async (name: string, run: () => Promise<number | void>): Promise<void> => {
      wire.reset();
      const startedAt = performance.now();
      const reported = await run();
      const ms = typeof reported === 'number' ? reported : performance.now() - startedAt;
      await settle();
      const { up, down, chunksDown } = wire.read();
      rows.push({ name, downBytes: down, upBytes: up, chunksDown, ms });
    };

    await measure('page load, cold cache (html, js, css, fonts, manifest, worker)', async () => {
      await staticLoad(wire.url);
    });
    await measure('every other script and stylesheet (idle prefetch, settings, highlighters)', async () => {
      await lazyLoad(wire.url);
    });

    let client!: CoreClient;
    await measure('connect, hello and the boot calls', async () => {
      client = await connect(wire.url, core.token, REMOTE);
      await boot(client);
    });

    let firstMessagesMs = 0;
    await measure(`open a ${SEED_TURNS} turn thread, whole sequence`, async () => {
      firstMessagesMs = (await openThread(client, long.id)).firstMessagesMs;
    });
    rows.push({ name: `open a ${SEED_TURNS} turn thread, until the messages are in hand`, downBytes: 0, upBytes: 0, chunksDown: 0, ms: firstMessagesMs });

    await measure(`one streamed turn of ${SEED_WORDS} words, subscribed`, async () => {
      const done = client.next('turn.finished', (event) => event.threadId === long.id, 60_000);
      await client.call('turns.start', { threadId: long.id, prompt: words(SEED_WORDS) });
      await done;
    });
    // What the UI holds when the link drops: the thread as of now.
    const held = (await direct.call('threads.get', { threadId: long.id })).messages.at(-1)?.id;

    await measure('a turn streaming on another thread, not subscribed', async () => {
      const other = await direct.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'other' });
      wire.reset();
      const done = direct.next('turn.finished', (event) => event.threadId === other.id, 60_000);
      await direct.call('turns.start', { threadId: other.id, prompt: words(SEED_WORDS) });
      await done;
    });

    await measure('thirty seconds idle, connected', async () => {
      await Bun.sleep(30_000);
    });

    client.close();
    await measure('reconnect: hello, boot calls and the open thread again', async () => {
      client = await connect(wire.url, core.token, REMOTE);
      await boot(client);
      await openThread(client, long.id, held);
    });
    client.close();
    wire.stop();
  } finally {
    direct.close();
    await core.stop();
    await removeDirectory(directory);
  }

  const kb = (bytes: number): string => (bytes / 1024).toFixed(1);
  console.log(`\nround trip ${RTT_MS} ms, ${SEQUENCE} client, ${new Date().toISOString().slice(0, 10)}\n`);
  console.log('| scenario | down KB | up KB | chunks down | ms |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const row of rows) {
    console.log(`| ${row.name} | ${row.downBytes === 0 && row.upBytes === 0 ? '' : kb(row.downBytes)} | ${row.downBytes === 0 && row.upBytes === 0 ? '' : kb(row.upBytes)} | ${row.chunksDown === 0 ? '' : row.chunksDown} | ${Math.round(row.ms)} |`);
  }
  if (JSON_OUT !== '') writeFileSync(JSON_OUT, `${JSON.stringify({ rttMs: RTT_MS, sequence: SEQUENCE, rows }, null, 2)}\n`);
}

await main();
