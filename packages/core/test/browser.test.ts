import { expect } from 'bun:test';
import type { BrowserAction } from '@boite/contracts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { echoThread, startTestCore } from './harness.ts';
import { createBrowserFixture } from './browser/fixture.ts';

const browserFixture = createBrowserFixture();
const { real, url, evaluate } = browserFixture;

real('an agent opens, reads and drives a page in the browser of its own machine', async () => {
  const { harness, owner, agent, threadId } = browserFixture;
  const open = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
  expect(open.tabId).toMatch(/^browser:/);
  expect(open.profile).toBe('default');
  expect(open.title).toBe('Fixture');
  const status = (await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as { available: boolean; tabs: Array<{ tabId: string; url: string; title: string; active: boolean }> };
  expect(status.available).toBe(true);
  expect(status.tabs).toMatchObject([{ tabId: open.tabId, url: url(), title: 'Fixture', active: true }]);
  const snapshot = (await agent.call('browser.command', { threadId, action: { kind: 'snapshot', interactive: true } })).value as { title: string; text: string };
  expect(snapshot.title).toBe('Fixture');
  expect(snapshot.text).toContain('- button "Go" [ref=e1]');
  const diagnostics = (await agent.call('browser.command', { threadId, action: { kind: 'diagnostics' } })).value as { entries: Array<{ kind: string; text: string; url?: string }> };
  expect(diagnostics.entries).toContainEqual(expect.objectContaining({ kind: 'console', text: 'boom' }));
  // The query string carried a token: diagnostics keep the address without it.
  expect(diagnostics.entries).toContainEqual(expect.objectContaining({ kind: 'network', url: url('/missing') }));
  await agent.call('browser.command', { threadId, action: { kind: 'click', selector: '#go' } });
  expect(await evaluate('document.title')).toBe('clicked');
  await agent.call('browser.command', { threadId, action: { kind: 'type', selector: '#name', text: 'hello' } });
  expect(await evaluate('document.querySelector("#name").value')).toBe('hello');
  await expect(agent.call('browser.command', { threadId, action: { kind: 'click', selector: 'nothing' } })).rejects.toThrow('matched 0');
  await agent.call('browser.command', { threadId, action: { kind: 'preset', preset: 'iphone-15-pro' } });
  expect(await evaluate('innerWidth')).toBe(393);
  await agent.call('browser.command', { threadId, action: { kind: 'appearance', colorScheme: 'dark' } });
  expect(await evaluate('matchMedia("(prefers-color-scheme: dark)").matches')).toBe(true);
  const shot = await agent.call('browser.command', { threadId, action: { kind: 'screenshot' } });
  expect(Buffer.from(shot.screenshot!.base64, 'base64').subarray(1, 4).toString()).toBe('PNG');
  const history = ((await agent.call('browser.command', { threadId, action: { kind: 'diagnostics' } })).value as { history: Array<{ action: string; ok: boolean }> }).history;
  expect(history.map(entry => entry.action)).toEqual(['open', 'click', 'evaluate', 'type', 'evaluate', 'click', 'preset', 'evaluate', 'appearance', 'evaluate', 'screenshot']);
  expect(history[5]!.ok).toBe(false);
  // Its token reaches its own conversation only, and only http(s) pages open.
  await expect(agent.call('browser.command', { threadId: 'another-thread', action: { kind: 'status' } })).rejects.toThrow('not thread');
  await expect(agent.call('browser.command', { threadId, action: { kind: 'open', url: 'file:///etc/passwd' } })).rejects.toThrow('HTTP');
  const other = (await echoThread(harness, owner, 'other')).threadId;
  expect(((await owner.call('browser.command', { threadId: other, action: { kind: 'status' } })).value as { tabs: unknown[] }).tabs).toEqual([]);
  await expect(owner.call('browser.command', { threadId: other, tabId: open.tabId, action: { kind: 'snapshot' } })).rejects.toThrow('no browser tab');
  await agent.call('browser.command', { threadId, action: { kind: 'close' } });
  expect(((await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as { tabs: unknown[] }).tabs).toEqual([]);
}, 150_000);

real('boite browse opens its page as a new tab of the conversation browser, not in a panel of its own', async () => {
  const { owner, agent, threadId } = browserFixture;
  const mine = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
  await owner.call('threads.subscribe', { threadId });
  const panels: unknown[] = [];
  owner.on('panel.requested', (event) => { if (event.threadId === threadId) panels.push(event); });
  expect(await agent.call('panel.open', { threadId, surface: { kind: 'browser', url: url('/shop') } })).toEqual({ shown: true });
  const status = (await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as { tabs: Array<{ tabId: string; url: string; active: boolean }> };
  // The agent's own page stays where it was; the new tab is the active one.
  expect(status.tabs).toMatchObject([{ tabId: mine.tabId, url: url(), active: false }, { url: url('/shop'), active: true }]);
  await Bun.sleep(100);
  expect(panels).toEqual([]);
}, 150_000);

real('an agent drives a page with agent-browser commands: refs, forms, dialogs and covered elements', async () => {
  const { agent, threadId } = browserFixture;
  const command = async (action: BrowserAction): Promise<unknown> => (await agent.call('browser.command', { threadId, action })).value;
  const opened = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url('/shop'), reuse: true } });
  const { text } = await command({ kind: 'snapshot', interactive: true }) as { text: string };
  expect(text.split('\n')).toEqual([
    '- heading "Shop" [ref=e1] [level=1]',
    '- textbox "Name" [ref=e2]',
    '- button "Send" [ref=e3]',
    '- combobox [ref=e4]: "Small" [options=["Small","Large"]]',
    '- checkbox "Gift" [ref=e5] [checked]',
    '- button "Ask" [ref=e6]',
    '- button "Later" [ref=e7]',
    '- button "Under" [ref=e8]',
  ]);
  await command({ kind: 'fill', selector: '@e2', text: 'Ada' });
  await command({ kind: 'type', selector: '@e2', text: ' L' });
  expect(await command({ kind: 'get', what: 'value', selector: '@e2' })).toBe('Ada L');
  expect(await command({ kind: 'select', selector: '@e4', values: ['Large'] })).toMatchObject({ value: ['Large'] });
  expect(await evaluate('document.querySelector("#size").value')).toBe('l');
  await command({ kind: 'uncheck', selector: '@e5' });
  expect(await command({ kind: 'get', what: 'checked', selector: '#gift' })).toBe(false);
  // A dialog the command raised is answered by the policy and reported with it.
  expect(await command({ kind: 'click', selector: '@e6' })).toMatchObject({ dialogs: [{ type: 'confirm', message: 'Sure?', accepted: true }] });
  expect(await command({ kind: 'get', what: 'text', selector: '#ask' })).toBe('yes');
  await command({ kind: 'dialog', decision: 'dismiss' });
  expect(await command({ kind: 'click', selector: '@e6' })).toMatchObject({ dialogs: [{ type: 'confirm', accepted: false }] });
  await command({ kind: 'dialog', decision: 'accept' });
  // One raised after the command ended, as a person's tap would, is declined and not the agent's.
  const later = await command({ kind: 'click', selector: '@e7' }) as { dialogs?: unknown };
  expect(later.dialogs).toBeUndefined();
  await command({ kind: 'wait', text: 'Free', timeoutMs: 1000 });
  browserFixture.releaseLaterDialog();
  await browserFixture.laterDialogDone();
  expect(await command({ kind: 'get', what: 'title' })).toBe('later no');
  // A covered element is reached through the DOM, and the agent hears what covered it.
  expect(await command({ kind: 'click', selector: '@e8' })).toMatchObject({ note: expect.stringContaining('covered by div#cover') });
  await expect(command({ kind: 'click', selector: '@e70' })).rejects.toThrow('unknown ref @e70');
  await expect(command({ kind: 'click', selector: 'button' })).rejects.toThrow('matched 4');
  // Enter submits the form natively; the command waits for the next page and says where it went.
  await command({ kind: 'focus', selector: '@e2' });
  expect(await command({ kind: 'press', key: 'Enter' })).toMatchObject({ navigated: true, title: 'Sent', url: url('/sent?name=Ada+L') });
  await expect(command({ kind: 'click', selector: '@e3' })).rejects.toThrow('belongs to an earlier page');
  // open drives the current tab, as agent-browser's does.
  const again = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url('/shop'), reuse: true } });
  expect(again.tabId).toBe(opened.tabId);
  expect(await command({ kind: 'history', direction: 'back' })).toMatchObject({ navigated: true, title: 'Sent' });
  await expect(command({ kind: 'wait', selector: '#never', timeoutMs: 300 })).rejects.toThrow('wait timed out after 300 ms');
}, 150_000);

real('a window a page opens joins the conversation as a tab of its own', async () => {
  const { agent, threadId } = browserFixture;
  await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
  await agent.call('browser.command', { threadId, action: { kind: 'click', selector: '#pop' } });
  let tabs: Array<{ url: string; title: string }> = [];
  for (let i = 0; i < 50 && tabs.length < 2; i++) {
    await Bun.sleep(100);
    tabs = ((await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as { tabs: typeof tabs }).tabs;
  }
  expect(tabs.map(tab => tab.url)).toEqual([url(), url('/popup')]);
  // Its first request leaves before the core attaches to it: the browser's own flag names it.
  expect(browserFixture.agents.get('/popup')).toMatch(/ Chrome\/\d+/);
}, 150_000);

real('a site sees the browser a person runs with a window, not headless Chrome', async () => {
  const { agent, threadId } = browserFixture;
  await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
  const seen = JSON.parse(String(await evaluate(`(async () => JSON.stringify({
    page: navigator.userAgent,
    webdriver: navigator.webdriver,
    versions: (await navigator.userAgentData.getHighEntropyValues(['fullVersionList'])).fullVersionList.length,
    screen: [screen.width, screen.height],
    window: [outerWidth, outerHeight],
    worker: await new Promise(resolve => { new Worker(URL.createObjectURL(new Blob(['postMessage(navigator.userAgent)']))).onmessage = event => resolve(event.data); }),
    request: await fetch('/missing').then(() => 'sent'),
  }))()`)));
  expect(seen.page).toMatch(/ Chrome\/\d+/);
  expect(seen.page).not.toContain('Headless');
  expect([seen.worker, browserFixture.agents.get('/'), browserFixture.agents.get('/missing')]).toEqual([seen.page, seen.page, seen.page]);
  expect(seen.webdriver).toBe(false);
  // `--user-agent` alone leaves the high-entropy client hints empty; the tab's override restores them.
  expect(seen.versions).toBeGreaterThan(1);
  expect(seen.screen[0]).toBeGreaterThanOrEqual(seen.window[0]);
  expect(seen.screen[1]).toBeGreaterThanOrEqual(seen.window[1]);
}, 150_000);

real('a click right after the viewport changes size lands on its element, and what the page then logs is kept', async () => {
  const { agent, threadId } = browserFixture;
  const fixture = readFileSync(join(import.meta.dir, '../../../tests/e2e/fixtures/browser-parity.html'), 'utf8');
  const page = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => new URL(request.url).pathname === '/'
    ? new Response(fixture, { headers: { 'content-type': 'text/html;charset=utf-8' } }) : new Response('missing', { status: 404 }) });
  try {
    const command = (action: BrowserAction) => agent.call('browser.command', { threadId, action });
    await command({ kind: 'open', url: page.url.href });
    await command({ kind: 'preset', preset: 'iphone-15-pro' });
    expect(await evaluate('[innerWidth,innerHeight]')).toEqual([393, 852]);
    await command({ kind: 'preset', preset: 'iphone-15-pro', orientation: 'landscape' });
    expect(await evaluate('[innerWidth,innerHeight]')).toEqual([852, 393]);
    await command({ kind: 'reset-viewport' });
    // The button sits elsewhere at each size: aimed at the old layout, the click missed it.
    await command({ kind: 'click', selector: '#diagnostic' });
    await Bun.sleep(150);
    const { entries } = (await command({ kind: 'diagnostics' })).value as { entries: Array<{ kind: string; text: string }> };
    expect(entries.some(entry => entry.kind === 'console' && entry.text.includes('Diagnostic volontaire'))).toBe(true);
    expect(entries.some(entry => entry.kind === 'exception' && entry.text.includes('Erreur volontaire'))).toBe(true);
    expect(entries.some(entry => entry.kind === 'network' && entry.text.includes('404'))).toBe(true);
  } finally { page.stop(true); }
}, 150_000);

real('an open agent tab does not hold back an update of the core', async () => {
  const { agent, threadId } = browserFixture;
  let stopping = 0;
  const updating = await startTestCore({ onShutdown: () => { stopping += 1; } });
  const client = await updating.connect();
  try {
    const thread = (await echoThread(updating, client)).threadId;
    await client.call('browser.command', { threadId: thread, action: { kind: 'open', url: url() } });
    // The browser process is alive with its tab, and nothing is running: the core may stop for an update.
    expect(updating.core.procs.liveThreads()).toContain('system:browser');
    expect(updating.core.requestIdleShutdown()).toBe('accepted');
  } finally { client.close(); await updating.stop(); }
  expect(stopping).toBeLessThanOrEqual(1);
}, 150_000);
