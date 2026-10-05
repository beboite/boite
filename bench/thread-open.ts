/**
 * What opening a large conversation costs, from the click to the first
 * message on screen. The fixture is shaped like the long threads people keep
 * (measured 2026-10-05 on a working journal: the text of a 97-message thread
 * was 0.14 MB, its attached files 130 MB and its tool outputs 25 MB), scaled
 * down to a thread of 200 messages and about 48 MB, written straight into the
 * journal of a fresh temporary data directory.
 *
 *   bun run build:ui
 *   bun run bench/thread-open.ts [--runs 5] [--rtt 150] [--kbps 10000] [--core path/to/main.ts] [--base] [--json out.json]
 *
 * Three measures, each the median of `--runs`:
 * - `threads.get`, whole and as the UI asks for its first page, on loopback: milliseconds and JSON bytes.
 * - The same call through a relay that holds each direction for half of `--rtt`,
 *   as a phone that dialled the core by name: milliseconds and bytes on the wire.
 * - The real UI in headless Chrome at 1280x900, from the click on the row to
 *   the first message in the timeline, on loopback, then with Chrome's network
 *   throttled to `--rtt` and `--kbps` (a phone on 4G).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../packages/core/src/client.ts';
import { BrowserPage } from '../tests/e2e/lib/cdp.ts';
import { pairingUrlOf, removeDirectory } from '../tests/e2e/lib/core.ts';
import { startCoreWithLongThread } from '../tests/e2e/lib/long-thread.ts';
import { startWire } from './lib/wire.ts';

function flag(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : (process.argv[at + 1] ?? fallback);
}

const RUNS = Number(flag('runs', '5'));
const RTT_MS = Number(flag('rtt', '150'));
const KBPS = Number(flag('kbps', '10000'));
const CORE_MAIN = flag('core', '');
const JSON_OUT = flag('json', '');
/**
 * The whole last page; the first page main's UI asked for (40 messages, compact
 * tool outputs and files); the same with large pictures left on the core; and
 * that page opened around a message far up, as a reader who left it there.
 * `--base` skips the last two, for a core that does not take them.
 */
const FIRST_PAGE = { limit: 40, compactTools: true, compactFiles: true };
const PARAMS: Record<string, unknown>[] = [{}, FIRST_PAGE, ...(process.argv.includes('--base') ? [] : [
  { ...FIRST_PAGE, compactImages: true },
  { ...FIRST_PAGE, compactImages: true, around: 'msg_fixture0050u' },
])];
const REMOTE = { client: { name: 'bench', version: '2.0.0-beta.1' }, timeoutMs: 120_000, headers: { host: 'phone.bench.test' } };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

async function main(): Promise<void> {
  const directory = mkdtempSync(join(tmpdir(), 'boite-bench-open-'));
  const seeded = await startCoreWithLongThread(CORE_MAIN === '' ? {} : { command: ['bun', 'run', CORE_MAIN] }, directory);
  const live = seeded.core;
  const thread = { id: seeded.long };
  const other = { id: seeded.short };
  const direct = await connect(live.url, live.token, { client: { name: 'bench', version: '2.0.0-beta.1' }, timeoutMs: 30_000 });
  const rows: { name: string; ms: number; bytes: number }[] = [];
  let page: BrowserPage | undefined;
  let wire: ReturnType<typeof startWire> | undefined;
  try {
    console.log(`fixture: ${seeded.messages} messages, ${(seeded.bytes / 1048576).toFixed(1)} MB of parts`);

    wire = startWire(live.port, RTT_MS / 2);
    const remote = await connect(wire.url, live.token, REMOTE);
    for (const params of process.argv.includes('--ui-only') ? [] : PARAMS) {
      const shown = JSON.stringify({ ...params, threadId: undefined });
      const loopback: number[] = [];
      let loopbackBytes = 0;
      for (let run = 0; run < RUNS; run += 1) {
        const startedAt = performance.now();
        const result = await direct.call('threads.get', { ...params, threadId: thread.id } as never);
        loopback.push(performance.now() - startedAt);
        loopbackBytes = Buffer.byteLength(JSON.stringify(result));
      }
      rows.push({ name: `threads.get ${shown}, loopback (JSON bytes)`, ms: median(loopback), bytes: loopbackBytes });
      console.log(rows.at(-1));
      const relayed: number[] = [];
      let relayedBytes = 0;
      for (let run = 0; run < RUNS; run += 1) {
        wire.reset();
        const startedAt = performance.now();
        await remote.call('threads.get', { ...params, threadId: thread.id } as never);
        relayed.push(performance.now() - startedAt);
        relayedBytes = wire.read().down;
      }
      rows.push({ name: `threads.get ${shown}, relay ${RTT_MS} ms RTT, deflated (wire bytes)`, ms: median(relayed), bytes: relayedBytes });
      console.log(rows.at(-1));
    }
    remote.close();

    for (const throttled of [false, true]) {
      const times: number[] = [];
      let never = 0;
      for (let run = 0; run < RUNS; run += 1) {
        // A fresh profile per run: a reload would reopen the last thread on boot, and that open races the click.
        page = await BrowserPage.launch({ url: pairingUrlOf(live), windowSize: { width: 1280, height: 900 } });
        // What left and came back for threads.get, so a lost open can say which half went missing.
        await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
          window.__gets = [];
          const Native = WebSocket;
          window.WebSocket = class extends Native {
            constructor(...args) {
              super(...args);
              const send = this.send.bind(this);
              this.send = (data) => { if (String(data).includes('"threads.get"')) window.__gets.push('sent ' + String(data).slice(0, 140)); return send(data); };
              this.addEventListener('message', (event) => { const head = String(event.data).slice(0, 40); if (String(event.data).length > 100000) window.__gets.push('received ' + String(event.data).length + ' ' + head); });
            }
          };
        })()` });
        await page.reload();
        await page.waitFor('document.querySelector("[data-testid=status-connection]")?.dataset.state === "ready"', 60_000);
        await page.waitFor(`document.querySelector('[data-thread-id="${thread.id}"]')`, 60_000);
        await Bun.sleep(1_500);
        await page.click(`[data-thread-id="${other.id}"]`);
        await page.waitFor(`document.querySelector('[data-testid=timeline]') && !document.querySelector('[data-mid^="msg_fixture"]') && !document.querySelector('[data-testid=thread-loading]')`, 60_000);
        // The network domain copies every WebSocket frame to the DevTools client: on only where throttling needs it.
        if (throttled) {
          await page.send('Network.enable', {});
          await page.send('Network.emulateNetworkConditions', { offline: false, latency: RTT_MS, downloadThroughput: (KBPS * 1000) / 8, uploadThroughput: (KBPS * 1000) / 8 / 4 });
        }
        // Stored on the page and polled: a slow open outlasts one CDP evaluate.
        await page.evaluate(`(() => {
          window.__opened = undefined;
          const startedAt = performance.now();
          document.querySelector('[data-thread-id="${thread.id}"]').click();
          // Headless Chrome without a compositor runs no animation frame: a DOM observer sees the list land.
          const seen = () => document.querySelector('[data-testid=timeline] [data-mid^="msg_fixture"]');
          const observer = new MutationObserver(() => {
            if (!seen()) return;
            window.__opened = performance.now() - startedAt;
            observer.disconnect();
          });
          observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-mid'] });
        })()`);
        const lost = await page.waitFor('window.__opened !== undefined', 180_000).then(() => false, () => true);
        if (lost) console.log(await page.evaluate<string>('JSON.stringify({ gets: window.__gets, header: document.querySelector("[data-testid=thread-header]")?.textContent?.trim().slice(0, 40) })'));
        const ms = lost ? 0 : await page.evaluate<number>('window.__opened');
        await page.close();
        page = undefined;
        if (lost) {
          // Said and measured again rather than waited on forever.
          console.log(`${throttled ? 'throttled' : 'loopback'} run ${run + 1}: the thread never opened, run again`);
          never += 1;
          // Two lost opens per run asked is enough to say the open is broken.
          if (never < 2 * RUNS) run -= 1;
          continue;
        }
        console.log(`${throttled ? 'throttled' : 'loopback'} run ${run + 1}: ${Math.round(ms)} ms`);
        times.push(ms);
      }
      const where = throttled ? `Chrome throttled ${RTT_MS} ms / ${KBPS / 1000} Mbit/s` : 'loopback';
      rows.push({ name: `UI click to first message, ${where}, ${times.length} landed, ${never} never opened`, ms: times.length === 0 ? Number.NaN : median(times), bytes: 0 });
    }
  } finally {
    await page?.close();
    wire?.stop();
    direct.close();
    await live.stop();
    await removeDirectory(directory);
  }

  console.log(`\n${new Date().toISOString().slice(0, 10)}, median of ${RUNS}\n`);
  console.log('| measure | ms | KB |');
  console.log('| --- | ---: | ---: |');
  for (const row of rows) console.log(`| ${row.name} | ${Math.round(row.ms)} | ${row.bytes === 0 ? '' : (row.bytes / 1024).toFixed(0)} |`);
  if (JSON_OUT !== '') writeFileSync(JSON_OUT, `${JSON.stringify({ runs: RUNS, rttMs: RTT_MS, kbps: KBPS, rows }, null, 2)}\n`);
}

await main();
