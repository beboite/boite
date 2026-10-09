import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { NO_DESKTOP_BROWSER_NOTE, type BrowserAction, type DesktopBrowserRequest, type DesktopBrowserTab } from '@boite/contracts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type CoreClient } from '../src/client.ts';
import { BROWSER_SCOPE } from '../src/browser.ts';
import { Cdp } from '../src/browser/cdp.ts';
import { chromiumArgs, clearActivePort, findChromium, pipesDevTools, waitForEndpoint } from '../src/browser/chromium.ts';
import { echoThread, removeDir, startTestCore, waitFor, type TestCore } from './harness.ts';

/*
 * The desktop app's browser, lent to the agents of this machine. A fake shell
 * stands in for the desktop: it lends its panel's tabs and runs what the core
 * relays. With a Chromium-based browser on the machine, its tab is a real page
 * the agent opens, reads and clicks, and the "user" takes over.
 */
const real = findChromium().path ? test : test.skip;

const PAGE = `<!doctype html><title>Fixture</title>
<button id="go" style="position:absolute;left:100px;top:100px;width:200px;height:80px" onclick="document.title='clicked'">Go</button>`;
let site: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  site = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    if (path === '/signed-in') return new Response('<title>Signed in</title><p>Welcome back', { headers: { 'content-type': 'text/html' } });
    return new Response('missing', { status: 404 });
  } });
});
afterAll(() => site.stop(true));
const url = (path = '/') => `http://127.0.0.1:${site.port}${path}`;

let harness: TestCore, agent: CoreClient, threadId: string;
let opened: { harness?: TestCore; clients: CoreClient[] } = { clients: [] };
beforeEach(async () => {
  opened = { clients: [] };
  opened.harness = harness = await startTestCore();
  const owner = await harness.connect();
  opened.clients.push(owner);
  ({ threadId } = await echoThread(harness, owner));
  agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
  opened.clients.push(agent);
});
afterEach(async () => { for (const client of opened.clients) client.close(); await opened.harness?.stop(); });

const command = (action: BrowserAction, tabId?: string) => agent.call('browser.command', { threadId, ...(tabId ? { tabId } : {}), action });

/** The owner's desktop app on this machine, as the core sees it: `answer` runs each relayed request. */
async function desktop(answer: (request: DesktopBrowserRequest) => Promise<unknown>) {
  const shell = await connect(harness.url, harness.token, { client: { name: 'shell', version: 'test' } });
  opened.clients.push(shell);
  const requests: DesktopBrowserRequest[] = [];
  shell.on('browser.desktopRequest', ({ requestId, request }) => {
    requests.push(request);
    void answer(request).then(
      result => shell.call('browser.desktopReply', { requestId, result: result ?? null }),
      error => shell.call('browser.desktopReply', { requestId, error: error instanceof Error ? error.message : String(error) }),
    ).catch(() => {});
  });
  const lend = (tabs: DesktopBrowserTab[]) => shell.call('browser.desktopTabs', { host: true, tabs });
  return { shell, requests, lend };
}

const tab = (tabId: string, extra: Partial<DesktopBrowserTab> = {}): DesktopBrowserTab =>
  ({ threadId, tabId, url: 'https://example.test/', title: 'Example', profile: 'default', ...extra });

test('the desktop that lends its panel\'s tab runs the agent\'s commands on it, and only that desktop answers', async () => {
  const owner = opened.clients[0]!;
  // Only the owner's shell lends: a browser tab or the CLI has no WebView2 views.
  await expect(owner.call('browser.desktopTabs', { host: true, tabs: [tab('browser:desk-1')] })).rejects.toThrow('the owner\'s shell');

  let release: () => void = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  const { shell, requests, lend } = await desktop(async request => {
    if (request.kind !== 'protocol' || request.method !== 'Runtime.evaluate') throw new Error(`unexpected ${request.kind}`);
    const expression = String(request.params.expression);
    if (expression === 'hold') await held;
    return { result: { value: expression === '6*7' ? 42 : expression } };
  });
  await lend([tab('browser:desk-1', { active: true })]);

  const status = (await command({ kind: 'status' })).value as { desktop: boolean; tabs: Array<Record<string, unknown>> };
  expect(status.desktop).toBe(true);
  expect(status.tabs).toEqual([expect.objectContaining({ tabId: 'browser:desk-1', url: 'https://example.test/', desktop: true, active: true, profileName: 'Default' })]);

  // No tab of its own: the agent continues on the page its panel shows.
  expect(await command({ kind: 'evaluate', expression: '6*7' })).toMatchObject({ tabId: 'browser:desk-1', desktop: true, value: 42 });
  expect(requests).toEqual([expect.objectContaining({ kind: 'protocol', tabId: 'browser:desk-1', method: 'Runtime.evaluate' })]);
  await expect(command({ kind: 'dialog', decision: 'accept' })).rejects.toThrow('person at the desktop');

  // Two tabs, neither shown nor used: the agent chooses rather than guessing.
  await lend([tab('browser:desk-1'), tab('browser:desk-2')]);
  expect((await command({ kind: 'evaluate', expression: 'again' })).value).toBe('again');
  harness.core.browserCommands.release(threadId);
  await expect(command({ kind: 'evaluate', expression: 'which' })).rejects.toThrow('several desktop browser tabs');
  expect((await command({ kind: 'evaluate', expression: 'two' }, 'browser:desk-2')).tabId).toBe('browser:desk-2');

  // A reply comes from the desktop the request went to, and a desktop that leaves fails what waits on it.
  const waiting = command({ kind: 'evaluate', expression: 'hold' });
  await waitFor(() => requests.some(request => request.kind === 'protocol' && request.params.expression === 'hold'));
  await expect(owner.call('browser.desktopReply', { requestId: 'not-yours', result: null })).rejects.toThrow('no browser.desktopRequest');
  shell.close();
  await expect(waiting).rejects.toThrow('the desktop app closed its connection');
  release();
  const after = (await command({ kind: 'status' })).value as { desktop: boolean; tabs: unknown[] };
  expect(after).toMatchObject({ desktop: false, tabs: [] });
});

/** A page of a real headless browser, standing in for one WebView2 view of the desktop's panel. */
async function view() {
  const dir = mkdtempSync(join(tmpdir(), 'boite-desktop-view-'));
  const piped = pipesDevTools();
  if (!piped) clearActivePort(dir);
  const spawned = harness.core.procs.spawn(BROWSER_SCOPE, findChromium().path!, chromiumArgs(dir), { agentRoot: false, ...(piped ? { extraPipes: 2 } : {}) });
  void spawned.proc.stdout.pipeTo(new WritableStream()).catch(() => {});
  void spawned.proc.stderr.pipeTo(new WritableStream()).catch(() => {});
  const [commands, replies] = spawned.fds ?? [];
  const cdp = piped && commands !== undefined && replies !== undefined ? Cdp.pipe(commands, replies) : await Cdp.connect(await waitForEndpoint(dir, spawned.exited));
  const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
  return {
    send: (method: string, params: Record<string, unknown>) => cdp.send(method, params, sessionId, 15_000),
    async close() {
      await cdp.send('Browser.close', {}, undefined, 3000).catch(() => {});
      cdp.close();
      try { spawned.proc.kill(); } catch { /* already gone */ }
      await spawned.exited;
      await removeDir(dir);
    },
  };
}

real('the agent opens a page in the desktop panel, reads and clicks it, and goes on after the user takes over', async () => {
  // No desktop lends its browser yet: the page opens in the agent browser, and the agent hears why.
  const alone = await command({ kind: 'open', url: url('/signed-in'), desktop: true });
  expect(alone.desktop).toBeUndefined();
  expect(alone.value).toMatchObject({ note: NO_DESKTOP_BROWSER_NOTE });
  const own = alone.tabId!;

  const page = await view();
  try {
    let lent: DesktopBrowserTab | null = null;
    const { requests, lend } = await desktop(async request => {
      switch (request.kind) {
        case 'open':
          lent = tab('browser:desk-1', { url: request.url, title: '', profile: request.profile, active: true });
          await page.send('Page.navigate', { url: request.url });
          await lend([lent]);
          return lent;
        case 'navigate': await page.send('Page.navigate', { url: request.url }); return { ok: true };
        case 'close': return { closed: true };
        case 'protocol': return request.method === 'Boite.diagnostics' ? { entries: [], dropped: 0 } : page.send(request.method, request.params);
      }
    });
    await lend([]);

    const open = await command({ kind: 'open', url: url(), desktop: true });
    expect(open).toMatchObject({ tabId: 'browser:desk-1', desktop: true, title: 'Fixture', profile: 'default' });
    expect(requests[0]).toEqual({ kind: 'open', url: url(), profile: 'default' });
    expect((await command({ kind: 'get', what: 'title' })).value).toBe('Fixture');
    await command({ kind: 'click', selector: '#go' });
    expect((await command({ kind: 'evaluate', expression: 'document.title' })).value).toBe('clicked');
    const shot = await command({ kind: 'screenshot' });
    expect(shot.screenshot?.mime).toBe('image/png');
    expect(Buffer.from(shot.screenshot!.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');

    // The user signs in on that page; the agent reads what they left.
    await page.send('Page.navigate', { url: url('/signed-in') });
    let title: unknown = null;
    for (const deadline = Date.now() + 10_000; title !== 'Signed in' && Date.now() < deadline; await Bun.sleep(100)) {
      title = await command({ kind: 'get', what: 'title' }).then(reply => reply.value, () => null);
    }
    expect(title).toBe('Signed in');

    // `open` drives the tab in use, as agent-browser does; the panel brings it forward.
    const again = await command({ kind: 'open', url: url(), reuse: true, desktop: true });
    expect(again).toMatchObject({ tabId: 'browser:desk-1', desktop: true, title: 'Fixture' });
    expect(requests).toContainEqual({ kind: 'navigate', tabId: 'browser:desk-1', url: url(), show: true });

    // Its own tab stays reachable by id, and the list marks which one is the desktop's.
    expect((await command({ kind: 'get', what: 'title' }, own)).value).toBe('Signed in');
    const status = (await command({ kind: 'status' })).value as { tabs: Array<{ tabId: string; desktop?: boolean; active: boolean }> };
    expect(status.tabs.map(({ tabId, desktop, active }) => ({ tabId, desktop: desktop ?? false, active }))).toEqual([
      { tabId: own, desktop: false, active: true },
      { tabId: 'browser:desk-1', desktop: true, active: false },
    ]);
    await expect(command({ kind: 'recording-start' }, 'browser:desk-1')).rejects.toThrow('recordings are made in the agent browser');
    expect((await command({ kind: 'close' }, 'browser:desk-1')).value).toEqual({ closed: true });
    expect(requests).toContainEqual({ kind: 'close', tabId: 'browser:desk-1' });
  } finally {
    await page.close();
  }
}, 60_000);
