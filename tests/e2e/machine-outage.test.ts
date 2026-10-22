import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer, connect as tcpConnect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { startCore, type RunningCore } from './lib/core.ts';
import { connect } from '../../packages/core/src/client.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
let url: string;
const cores: RunningCore[] = [];
const DESKTOP_VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const id = (name: string) => `[data-testid="${name}"]`;
async function capture(name: string) {
  await page.settleAnimations();
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

/**
 * Another loopback address: the page holds only 127.0.0.1, localhost and ::1 for
 * this computer's own core, so a core behind this one is a remote machine to it.
 */
const REMOTE_HOST = '127.0.0.2';

/**
 * A TCP relay in front of a core that can go silent the way a dropped VPN does:
 * frozen, it keeps every socket open and delivers nothing either way, and a new
 * connection is accepted and never answered. Thawed, the stale sockets are reset.
 */
async function blackhole(target: number) {
  const pairs = new Set<{ client: Socket; upstream: Socket | null }>();
  let frozen = false;
  const relay: Server = createServer(client => {
    const pair: { client: Socket; upstream: Socket | null } = { client, upstream: null };
    pairs.add(pair);
    client.on('error', () => undefined);
    client.on('close', () => { pair.upstream?.destroy(); pairs.delete(pair); });
    if (frozen) return;
    const upstream = tcpConnect(target, '127.0.0.1');
    pair.upstream = upstream;
    upstream.on('error', () => undefined);
    upstream.on('close', () => client.destroy());
    client.on('data', chunk => { if (!frozen) upstream.write(chunk); });
    upstream.on('data', chunk => { if (!frozen) client.write(chunk); });
  });
  const host = REMOTE_HOST;
  await new Promise<void>(resolve => relay.listen(0, host, resolve));
  const port = (relay.address() as { port: number }).port;
  return {
    url: `http://${host}:${port}`,
    freeze() { frozen = true; },
    thaw() {
      frozen = false;
      for (const pair of [...pairs]) { pair.client.destroy(); pair.upstream?.destroy(); }
    },
    close: () => new Promise<void>(resolve => { for (const pair of pairs) { pair.client.destroy(); pair.upstream?.destroy(); } relay.close(() => resolve()); })
  };
}

beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  url = `http://127.0.0.1:${port}`;
  // Windows can clamp the native headless window below the desktop breakpoint.
  // Keep it narrow on every platform so viewport restoration exercises that case.
  page = await BrowserPage.launch({ url: `${url}/?fake=1`, windowSize: { width: 390, height: 844 }, args: [`--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost, EXCLUDE ${REMOTE_HOST}`] });
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP_VIEWPORT);
}, 30_000);
afterAll(async () => {
  await page?.close();
  await server?.close();
  for (const core of cores) await core.stop();
}, 30_000);

/**
 * The desktop of 2026-10-22: the VPN to the server dropped under an open
 * conversation. Every call the window made there waited its two minutes while
 * the machine still read as connected, a red "connection lost" stayed on
 * screen, and a new conversation on that machine could not be sent at all.
 */
test('a machine whose link goes silent reads offline within seconds, and a conversation started there waits for it', async () => {
  const first = await startCore(), second = await startCore();
  cores.push(first, second);
  const hole = await blackhole(second.port);
  const a = await connect(first.url, first.token), b = await connect(second.url, second.token);
  try {
    await Promise.all([a.call('settings.set', { browserOrigins: [url] }), b.call('settings.set', { browserOrigins: [url] })]);
    const create = async (client: typeof a, path: string, name: string) => {
      const project = await client.call('projects.add', { path, name });
      const account = (await client.call('accounts.list', {})).find(entry => entry.providerId === 'echo')!;
      return client.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: name });
    };
    const ta = await create(a, first.dataDir, 'Desk project');
    const tb = await create(b, second.dataDir, 'Server project');
    await page.navigate(`${url}/?core=${encodeURIComponent(first.url)}&token=${encodeURIComponent(first.token)}`);
    await page.waitFor(`document.querySelector('${id('confirm-ok')}')`);
    await page.click(id('confirm-ok'));
    await page.waitFor(`document.querySelector('[data-thread-id="${ta.id}"]')`);
    await page.evaluate(`globalThis.__boiteTest.workspace.add({ url: ${JSON.stringify(hole.url)}, token: ${JSON.stringify(second.token)} }, 'Server')`);
    await page.waitFor(`document.querySelector('[data-thread-id="${tb.id}"]')`);
    await page.click(`[data-thread-id="${ta.id}"]`);
    await page.waitFor(`document.querySelector('${id('thread-title')}')?.textContent === 'Desk project'`);
    const server = `globalThis.__boiteTest.workspace.machines.find(machine => machine.id === ${JSON.stringify(hole.url)}).store`;

    // The link goes silent the moment before the user opens a conversation there.
    hole.freeze();
    const clicked = Date.now();
    await page.click(`[data-thread-id="${tb.id}"]`);
    await page.waitFor(`${server}.connection !== 'ready'`, 16_000);
    expect(Date.now() - clicked).toBeLessThan(16_000);
    await page.waitFor(`document.querySelector('${id('composer-input')}')?.getAttribute('placeholder')?.startsWith('Server is offline')`);
    // Its status says it: no error shows over the window, now or in the seconds after.
    await page.evaluate(`(() => {
      globalThis.__toasts = [];
      const seen = () => { const toast = document.querySelector('${id('error-toast')}'); if (toast) globalThis.__toasts.push(toast.textContent); };
      seen();
      globalThis.__toastWatch = new MutationObserver(seen);
      globalThis.__toastWatch.observe(document.body, { childList: true, subtree: true });
    })()`);
    await Bun.sleep(6_000);
    expect(await page.evaluate<string[]>(`(() => { globalThis.__toastWatch.disconnect(); return globalThis.__toasts; })()`)).toEqual([]);
    await capture('outage-offline-thread-desktop.png');

    // The other machine is untouched.
    await page.click(`[data-thread-id="${ta.id}"]`);
    await page.waitFor(`document.querySelector('${id('thread-title')}')?.textContent === 'Desk project'`);
    await page.type(id('composer-input'), 'Local while the server is away');
    await page.click(id('composer-send'));
    await page.waitFor(`document.querySelector('${id('chat')}')?.textContent.includes('Local while the server is away')`);

    // A new conversation on the server: Send queues it as a draft that waits for the machine.
    await page.evaluate(`globalThis.__boiteTest.workspace.select(${server}, undefined, ${JSON.stringify(tb.projectId)}, { fresh: true })`);
    await page.waitFor(`document.querySelector('${id('composer-input')}')?.getAttribute('placeholder') === 'Server is offline: the conversation starts when it reconnects'`);
    await page.type(id('composer-input'), 'Start this when the server is back');
    await page.waitFor(`document.querySelector('${id('composer-send')}')?.disabled === false`);
    await page.click(id('composer-send'));
    const row = `[data-testid="draft-row"][data-queued="waiting"]`;
    await page.waitFor(`document.querySelector('${row}')?.textContent.includes('Start this when the server is back')`);
    await page.waitFor(`document.querySelector('${id('composer-outbox-pending')}')?.textContent.includes('Waiting for Server')`);
    expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('');
    await capture('outage-queued-draft-desktop.png');
    await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await capture('outage-queued-draft-phone.png');
    expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    await page.send('Emulation.setDeviceMetricsOverride', DESKTOP_VIEWPORT);
    await page.waitFor(`innerWidth === ${DESKTOP_VIEWPORT.width} && document.querySelector('${row}')`);

    // Its row's menu takes the start back: the words return to the box and nothing waits any more.
    await page.evaluate(`document.querySelector('${row}').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 180 }))`);
    const cancel = `${id('context-menu')} [data-value=unqueue]`;
    await page.waitFor(`document.querySelector('${cancel}')`);
    await capture('outage-queued-draft-menu.png');
    await page.click(cancel);
    await page.waitFor(`!document.querySelector('${row}') && document.querySelector('[data-testid="draft-row"]')?.textContent.includes('Start this when the server is back')`);
    expect(await page.evaluate(`document.querySelector('${id('composer-input')}').value`)).toBe('Start this when the server is back');
    await page.click(id('composer-send'));
    await page.waitFor(`document.querySelector('${row}')`);

    // The machine returns: the conversation starts there once, with its prompt, and takes the draft's place.
    hole.thaw();
    // The echo agent may retitle it from the start of the prompt ("Echo: Start this when the server").
    await page.waitFor(`document.querySelector('${id('thread-title')}')?.textContent.includes('Start this when the server')`, 30_000);
    await page.waitFor(`document.querySelector('${id('chat')}')?.textContent.includes('Start this when the server is back') && !document.querySelector('${id('composer-queued')}')`);
    expect(await page.evaluate(`document.querySelector('[data-testid="draft-row"]')`)).toBe(null);
    const started = (await b.call('threads.list', {})).filter(thread => thread.projectId === tb.projectId && thread.id !== tb.id);
    expect(started).toHaveLength(1);
    const thread = await b.call('threads.get', { threadId: started[0]!.id });
    expect(thread.messages.filter(message => message.role === 'user')).toHaveLength(1);
    await capture('outage-started-desktop.png');
  } finally {
    a.close(); b.close(); await hole.close();
  }
}, 120_000);
