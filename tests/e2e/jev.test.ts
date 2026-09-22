import { afterEach, expect, spyOn, test } from 'bun:test';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestCore, echoThread, waitFor, type TestCore } from '../../packages/core/test/harness.ts';
import { RECOMMENDED, verifyPluginDownload } from '../../packages/core/src/plugins.ts';
import { platformKey } from '../../packages/core/src/plugins/manifest.ts';
import { findBrowser } from './lib/cdp.ts';

// Opt-in: a pinned native binary and paid Jev requests. Fresh core and browser
// profiles, synthetic local pages, no provider login or personal browser state.
const live = process.env.BOITE_E2E_JEV === '1' && Boolean(process.env.BOITE_BROWSER_TEST_BINARY);
let harness: TestCore | undefined;
let fetchSpy: { mockRestore(): void } | undefined;
afterEach(async () => { await harness?.stop(); harness = undefined; fetchSpy?.mockRestore(); fetchSpy = undefined; });

async function setup() {
  if (process.env.BOITE_E2E_JEV_TRACE === '1') {
    const realFetch = globalThis.fetch;
    fetchSpy = spyOn(globalThis, 'fetch').mockImplementation((async (input, options) => {
      const response = await realFetch(input, options);
      if (String(input).startsWith('https://api.typesafe.ai/')) {
        const result = await response.clone().json() as { answers?: unknown };
        const request = JSON.parse(String(options?.body)) as { state: unknown };
        console.log(JSON.stringify({ fixtureDecision: result.answers, fixtureState: request.state }));
      }
      return response;
    }) as typeof fetch);
  }
  harness = await startTestCore();
  const client = await harness.connect();
  const { threadId } = await echoThread(harness, client);
  const manifest = RECOMMENDED.find(item => item.id === 'jev-browser')!;
  verifyPluginDownload(new Uint8Array(await Bun.file(process.env.BOITE_BROWSER_TEST_BINARY!).arrayBuffer()), manifest.artifacts[platformKey() as keyof typeof manifest.artifacts]!.sha256);
  const directory = join(harness.dataDir, 'plugins', manifest.id);
  mkdirSync(directory, { recursive: true });
  copyFileSync(process.env.BOITE_BROWSER_TEST_BINARY!, join(directory, process.platform === 'win32' ? 'agent-browser.exe' : 'agent-browser'));
  writeFileSync(join(directory, 'installed.json'), JSON.stringify({ schema: 1, origin: 'recommended', source: null, installedAt: Date.now(), manifest }));
  await client.call('browser.configure', { enabled: true, executablePath: findBrowser() });
  return { client, threadId };
}

const scenarios = [
  { name: 'English form', goal: 'Set Customer name to Ada, choose Weekly, enable Email updates and save once.', values: { customer: 'Ada', frequency: 'Weekly' }, expected: { customer: 'Ada', frequency: 'Weekly', email: true }, checked: false },
  { name: 'French form with a checked box', goal: 'Saisis Alice dans Customer name, sélectionne Mensuel pour Frequency, désactive Email updates, puis sauvegarde une seule fois.', values: { customer: 'Alice', frequency: 'Mensuel' }, expected: { customer: 'Alice', frequency: 'Mensuel', email: false }, checked: true },
];
for (const scenario of scenarios) test.skipIf(!live)(`Jev native plugin: ${scenario.name}`, async () => {
  const { client, threadId } = await setup();
  const records: unknown[] = [];
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'POST') { records.push(await request.json()); return new Response('ok'); }
    return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Subscription fixture</title>
      <h1>Subscription preferences</h1><form>
      <label>Customer name <input name="customer" autocomplete="off"></label>
      <label>Frequency <select name="frequency"><option>Daily</option><option>Weekly</option><option>Mensuel</option></select></label>
      <label><input name="email" type="checkbox" ${scenario.checked ? 'checked' : ''}>Email updates</label>
      <button>Save preferences</button></form><div id="result"></div>
      <script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();const f=e.target;const data={customer:f.customer.value,frequency:f.frequency.value,email:f.email.checked};await fetch('/save',{method:'POST',body:JSON.stringify(data)});document.querySelector('#result').textContent='Saved preferences: '+JSON.stringify(data);};</script></html>`, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } });
  try {
    const start = performance.now();
    const task = await client.call('browser.start', { threadId, pluginId: 'jev-browser', url: `http://127.0.0.1:${site.port}`, goal: scenario.goal, values: scenario.values, completion: { text: 'Saved preferences: ' + JSON.stringify(scenario.expected) }, maxSteps: 16, timeoutMs: 90_000 });
    await waitFor(() => harness!.core.browser.list(threadId)[0]?.finishedAt !== null, 105_000);
    const done = (await client.call('browser.list', { threadId }))[0]!;
    console.log(JSON.stringify({ browserTask: done.status, steps: done.step, inputTokens: done.inputTokens, ms: Math.round(performance.now() - start), message: done.message }));
    expect(done.status).toBe('succeeded');
    expect(records).toEqual([scenario.expected]);
    await waitFor(() => harness!.core.procs.liveCount(`browser:${task.id}`) === 0);
    expect(harness!.core.procs.liveCount(`browser:${task.id}`)).toBe(0);
  } finally { site.stop(true); }
}, 120_000);

test.skipIf(!live)('Jev native plugin follows a delayed control in an open shadow root', async () => {
  const { client, threadId } = await setup(); let submissions = 0;
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (request.method === 'POST') { submissions++; return new Response('ok'); }
    return new Response(`<h1>Documents</h1><button id="open">Open archives</button><div id="host"></div><p id="result"></p><script>
      document.querySelector('#open').onclick=()=>{document.querySelector('#open').remove();document.querySelector('#result').textContent='Loading archives';setTimeout(()=>{const root=document.querySelector('#host').attachShadow({mode:'open'});root.innerHTML='<button>Open invoices</button>';root.querySelector('button').onclick=async()=>{await fetch('/save',{method:'POST'});document.querySelector('#result').textContent='Invoices opened';};document.querySelector('#result').textContent='Choose an archive';},500);};
      </script>`, { headers: { 'Content-Type': 'text/html' } });
  } });
  try {
    const task = await client.call('browser.start', { threadId, pluginId: 'jev-browser', url: `http://127.0.0.1:${site.port}`, goal: 'Open archives, wait for the archive list, then open invoices once.', completion: { text: 'Invoices opened' }, maxSteps: 12 });
    await waitFor(() => harness!.core.browser.list(threadId)[0]?.finishedAt !== null, 130_000);
    const done = (await client.call('browser.list', { threadId }))[0]!;
    console.log(JSON.stringify({ browserTask: 'shadow', status: done.status, steps: done.step, inputTokens: done.inputTokens, message: done.message }));
    expect(done.status).toBe('succeeded'); expect(submissions).toBe(1);
    await waitFor(() => harness!.core.procs.liveCount(`browser:${task.id}`) === 0);
  } finally { site.stop(true); }
}, 140_000);

test.skipIf(!live)('cancelling a real native task closes its browser process tree', async () => {
  const { client, threadId } = await setup();
  const site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<h1>Loading</h1>', { headers: { 'Content-Type': 'text/html' } }) });
  try {
    const task = await client.call('browser.start', { threadId, pluginId: 'jev-browser', url: `http://127.0.0.1:${site.port}`, goal: 'Wait for the report to finish loading.', completion: { text: 'Report ready' } });
    await waitFor(() => harness!.core.procs.liveCount(`browser:${task.id}`) >= (process.platform === 'win32' ? 2 : 1), 20_000);
    const done = await client.call('browser.cancel', { threadId, id: task.id });
    expect(done.status).toBe('cancelled');
    await waitFor(() => harness!.core.procs.liveCount(`browser:${task.id}`) === 0, 15_000);
    expect(harness!.core.procs.liveCount(`browser:${task.id}`)).toBe(0);
  } finally { site.stop(true); }
}, 45_000);
