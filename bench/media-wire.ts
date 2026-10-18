/**
 * What opening a thread of ten screenshots costs the client: bytes on the
 * wire and the client's work to turn the answers into pictures, for the
 * copies sent as base64 in JSON frames (every client before 2026-10-17 and
 * any that leaves `ticket` out) and as file route addresses, at the large
 * size and at the thumbnail's. The copies are made first, so only their
 * transport is measured. Runs on the echo driver in a fresh data directory,
 * through the counting relay of `lib/wire.ts`.
 *
 *   bun run bench/media-wire.ts [--rtt 150] [--rate 1000000] [--remote] [--rounds 5] [--browser]
 *
 * `--remote` names the core by a host that is not loopback, so it deflates
 * and paces as for a phone; without it the link is loopback, as for the
 * desktop app beside its core. `--rate` caps what the core sends, in bytes
 * per second (1,000,000 is an 8 Mbit/s phone link). `--browser` hands the answers to a headless
 * Chromium, as the UI does: base64 becomes a `data:` URL, a ticket an
 * address the page fetches itself, and the time runs until every picture
 * decoded. Without it Bun fetches the addresses and the time ends with the
 * bytes in hand. Either way the time starts with the calls.
 */
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { connect, type CoreClient } from '../packages/core/src/client.ts';
import { BrowserPage } from '../tests/e2e/lib/cdp.ts';
import { removeDirectory, startCore } from '../tests/e2e/lib/core.ts';
import { startWire } from './lib/wire.ts';

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const RTT_MS = Number(flag('rtt', '0'));
const RATE = Number(flag('rate', 'Infinity'));
const REMOTE = process.argv.includes('--remote');
const ROUNDS = Number(flag('rounds', '5'));
const BROWSER = process.argv.includes('--browser');

/** In the page, from the answers to every picture decoded: what `DisplayImages` and an `<img>` do. */
const DECODE = (frames: string[] | null, urls: string[] | null): string => `(async () => {
  const frames = ${JSON.stringify(frames)}, urls = ${JSON.stringify(urls)};
  const started = performance.now();
  const sources = frames ? frames.map((frame) => { const { result } = JSON.parse(frame); return 'data:' + result.mimeType + ';base64,' + result.data; }) : urls;
  await Promise.all(sources.map((src) => { const img = new Image(); img.src = src; return img.decode(); }));
  return performance.now() - started;
})()`;
const PICTURES = 10;
const WIDTH = 1920;
const HEIGHT = 1080;

/**
 * A screenshot-like PNG of about 1.8 MB: lines of glyphs on the left, a
 * grainy picture on the right. Its 1,280 px WebP copy weighs about 130 KB,
 * the top of the 51 to 130 KB real screenshots measured on 2026-10-07.
 */
function screenshot(index: number): string {
  const chunk = (type: string, data: Buffer): Buffer => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header[8] = 8;
  header[9] = 2;
  const rows = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  let seed = index * 7919 + 1;
  const hue = (index * 47) % 255;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const at = y * (WIDTH * 3 + 1) + 1 + x * 3;
      if (x < WIDTH * 0.6) {
        // A glyph is a 9 by 25 cell; one cell in six and one line in eight stay blank.
        const line = Math.floor(y / 25), inLine = y % 25, cell = Math.floor(x / 9), inCell = x % 9;
        const cellSeed = (line * 7919 + cell * 104729 + index * 31) >>> 0;
        const word = ((cellSeed * 2654435761) >>> 0) % 6 !== 0 && line % 8 !== 7;
        const ink = word && inLine >= 5 && inLine <= 16 && inCell < 7 && (((cellSeed ^ (inLine * 131) ^ (inCell * 17)) * 2654435761) >>> 0) % 3 === 0;
        rows[at] = ink ? 40 : 245;
        rows[at + 1] = ink ? 40 : 245;
        rows[at + 2] = ink ? 60 : 250;
      } else {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const grain = (seed >> 16) % 12;
        rows[at] = Math.min(255, Math.round((x / WIDTH) * 200) + grain + Math.round(30 * Math.sin(y / 37)));
        rows[at + 1] = Math.min(255, hue + grain);
        rows[at + 2] = Math.min(255, Math.round((y / HEIGHT) * 200) + grain);
      }
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

interface Mode { name: string; thumb: boolean; ticket: boolean }
const MODES: Mode[] = [
  { name: 'base64, large copies (before)', thumb: false, ticket: false },
  { name: 'ticket, large copies', thumb: false, ticket: true },
  { name: 'ticket, thumbnail copies (prompt thumbnails after)', thumb: true, ticket: true },
];

const median = (values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;

async function main(): Promise<void> {
  const core = await startCore();
  const direct = await connect(core.url, core.token, { client: { name: 'bench', version: '2.0.0-beta.1' } });
  const directory = mkdtempSync(join(tmpdir(), 'boite-bench-media-'));
  const wire = startWire(core.port, RTT_MS / 2, RATE);
  let client: CoreClient | undefined;
  let page: BrowserPage | null = null;
  const rows: string[] = [];
  try {
    const project = await direct.call('projects.add', { path: directory, name: 'bench' });
    const account = (await direct.call('accounts.list', {})).find((entry) => entry.providerId === 'echo');
    if (account === undefined) throw new Error('the core has no echo account');
    const thread = await direct.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: 'ten screenshots' });
    let originals = 0;
    for (let index = 0; index < PICTURES; index += 1) {
      const data = screenshot(index);
      originals += Buffer.byteLength(data, 'base64');
      const done = direct.next('turn.finished', (event) => event.threadId === thread.id, 60_000);
      await direct.call('turns.start', { threadId: thread.id, prompt: `Screenshot ${index + 1}`, attachments: [{ kind: 'image', mimeType: 'image/png', data, name: `shot-${index + 1}.png` }] });
      await done;
    }
    const listed = await direct.call('threads.get', { threadId: thread.id, compactImages: true });
    const pictures = listed.messages.flatMap((message) => message.parts.flatMap((part, partIndex) => part.type === 'image' ? [{ messageId: message.id, partIndex }] : []));
    if (pictures.length !== PICTURES) throw new Error(`expected ${PICTURES} pictures, found ${pictures.length}`);
    // Every copy made before anything is measured.
    for (const picture of pictures) {
      await direct.call('messages.attachment', { threadId: thread.id, ...picture, display: true });
      await direct.call('messages.attachment', { threadId: thread.id, ...picture, display: true, thumb: true });
    }

    page = BROWSER ? await BrowserPage.launch({ url: 'about:blank', windowSize: { width: 1280, height: 800 } }) : null;
    if (page !== null) {
      await page.send('Network.enable', {});
      await page.send('Network.setCacheDisabled', { cacheDisabled: true });
    }
    client = await connect(wire.url, core.token, { client: { name: 'bench', version: '2.0.0-beta.1' }, timeoutMs: 30_000, ...(REMOTE ? { headers: { host: 'phone.bench.test' } } : {}) });
    const base = wire.url;
    for (const mode of MODES) {
      const bytes: number[] = [], times: number[] = [], decodes: number[] = [], browser: number[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        await Bun.sleep(RTT_MS + 100);
        wire.reset();
        const started = performance.now();
        const answers = await Promise.all(pictures.map((picture) => client!.call('messages.attachment', { threadId: thread.id, ...picture, display: true, ...(mode.thumb ? { thumb: true } : {}), ...(mode.ticket ? { ticket: true } : {}) })));
        const answered = performance.now() - started;
        const frames = answers.map((answer) => JSON.stringify({ jsonrpc: '2.0', id: 1, result: answer }));
        let fetched: Uint8Array[] = [];
        if (page !== null) {
          // A fresh document each round, with the HTTP cache off: a first opening. On the core's
          // own address, as the UI is: Chromium refuses a blank page's loads from loopback.
          await page.navigate(`${core.url}/health`);
          const decoded = await page.evaluate<number>(DECODE(mode.ticket ? null : frames, mode.ticket ? answers.map((answer) => `${base}${answer.url}`) : null), 60_000);
          browser.push(decoded);
          times.push(answered + decoded);
        } else {
          // A browser fetches each address once; its cache keeps it after that, which this does not count.
          const fetchStarted = performance.now();
          fetched = mode.ticket ? await Promise.all(answers.map(async (answer) => new Uint8Array(await (await fetch(`${base}${answer.url}`)).arrayBuffer()))) : [];
          times.push(answered + performance.now() - fetchStarted);
        }
        await Bun.sleep(RTT_MS + 100);
        bytes.push(wire.read().down);
        // What the client does with the answers before an <img> can decode them: parse each frame, then decode its base64.
        const decodeStarted = performance.now();
        let total = 0;
        for (const frame of frames) {
          const { result } = JSON.parse(frame) as { result: { data: string } };
          if (result.data !== '') total += Buffer.from(result.data, 'base64').length;
        }
        for (const body of fetched) total += body.length;
        decodes.push(performance.now() - decodeStarted);
        if (total === 0 && page === null) throw new Error(`${mode.name}: no bytes`);
      }
      rows.push(`| ${mode.name} | ${(median(bytes) / 1024).toFixed(1)} | ${median(times).toFixed(0)} | ${median(decodes).toFixed(2)} | ${page === null ? '' : median(browser).toFixed(1)} |`);
    }
    console.log(`\n${PICTURES} ${WIDTH} by ${HEIGHT} PNG screenshots, ${(originals / 1024).toFixed(0)} KB of originals; ${REMOTE ? 'remote (deflate, pacing)' : 'loopback'}, round trip ${RTT_MS} ms${Number.isFinite(RATE) ? `, ${RATE} bytes/s` : ''}; medians of ${ROUNDS}; ${new Date().toISOString().slice(0, 10)}\n`);
    console.log('| answers | down KB | ms to pictures | Bun parse + base64 decode ms | Chromium answers to decoded ms |');
    console.log('| --- | ---: | ---: | ---: | ---: |');
    for (const row of rows) console.log(row);
  } finally {
    await page?.close();
    client?.close();
    wire.stop();
    direct.close();
    await core.stop();
    await removeDirectory(directory);
  }
}

await main();
