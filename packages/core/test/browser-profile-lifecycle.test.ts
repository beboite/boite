import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentBrowser } from '../src/browser.ts';
import { chromiumArgs, drawsWithGpu, findChromium, trimProfile } from '../src/browser/chromium.ts';
import { BrowserEngines } from '../src/browser/engines.ts';
import { BrowserHost } from '../src/browser/host.ts';
import type { Cdp } from '../src/browser/cdp.ts';
import type { Connection } from '../src/router.ts';
import type { Engine } from '../src/browser/types.ts';
import { createBrowserFixture } from './browser/fixture.ts';
import { thrown } from './settle.ts';

const browserFixture = createBrowserFixture();
const { real, url } = browserFixture;

test('without a Chromium-based browser the status says why and nothing opens', async () => {
  const { owner, agent, threadId } = browserFixture;
  const previous = process.env.BOITE_BROWSER;
  process.env.BOITE_BROWSER = '/nonexistent/chrome';
  try {
    await owner.call('threads.subscribe', { threadId });
    const status = await owner.call('browser.remoteStatus', { threadId });
    expect(status).toMatchObject({ live: false, available: false });
    expect(status.reason).toContain('/nonexistent/chrome');
    expect(await thrown(agent.call('browser.command', { threadId, action: { kind: 'open', url: 'http://127.0.0.1:1/' } }))).toThrow('cannot start');
  } finally {
    if (previous === undefined) delete process.env.BOITE_BROWSER; else process.env.BOITE_BROWSER = previous;
  }
});

test('the browser is found where each OS installs it, and BOITE_BROWSER alone when set', () => {
  const { agent } = browserFixture;
  const root = mkdtempSync(join(tmpdir(), 'boite-chromium-'));
  try {
    const edge = join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe');
    mkdirSync(dirname(edge), { recursive: true }); writeFileSync(edge, '');
    const none = () => null;
    expect(findChromium({ ProgramFiles: root }, 'win32', none)).toEqual({ path: edge });
    expect(findChromium({}, 'linux', name => name === 'chromium' ? '/usr/bin/chromium' : null)).toEqual({ path: '/usr/bin/chromium' });
    expect(findChromium({ BOITE_BROWSER: edge }, 'linux', () => '/usr/bin/chromium')).toEqual({ path: edge });
    expect(findChromium({ BOITE_BROWSER: join(root, 'gone') }, 'win32', () => '/usr/bin/chromium').path).toBeNull();
    expect(findChromium({}, 'linux', none)).toMatchObject({ path: null, reason: expect.stringContaining('BOITE_BROWSER') });
    expect(chromiumArgs('/profile', 'linux')).toEqual(expect.arrayContaining(['--headless=new', '--disable-software-rasterizer', '--use-angle=gl-egl', '--user-data-dir=/profile']));
    expect(chromiumArgs('/profile', 'win32')).not.toContain('--use-angle=gl-egl');
    expect(chromiumArgs('/profile', 'linux', 'Agent/1')).toEqual(expect.arrayContaining(['--disable-blink-features=AutomationControlled', '--user-agent=Agent/1']));
    expect(chromiumArgs('/profile', 'linux').some(arg => arg.startsWith('--user-agent'))).toBe(false);
    // The DevTools protocol goes over the browser's own pipes: no port for another process to reach.
    for (const platform of ['linux', 'darwin'] as const) {
      expect(chromiumArgs('/profile', platform)).toContain('--remote-debugging-pipe');
      expect(chromiumArgs('/profile', platform).some(arg => arg.startsWith('--remote-debugging-port'))).toBe(false);
    }
    // Bun cannot open the pipe descriptors on Windows: a random port there, on loopback only.
    expect(chromiumArgs('/profile', 'win32')).toEqual(expect.arrayContaining(['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1']));
    // No component downloads and a bounded HTTP cache in the agent's profile.
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(chromiumArgs('/profile', platform)).toEqual(expect.arrayContaining(['--disable-component-update', '--disk-cache-size=67108864']));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a browser in a macOS virtual machine draws without the GPU, and SwiftShader stays off everywhere', async () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    expect(chromiumArgs('/profile', platform)).toEqual(expect.arrayContaining(['--enable-gpu', '--disable-software-rasterizer']));
    expect(chromiumArgs('/profile', platform)).not.toContain('--disable-gpu');
  }
  const virtual = chromiumArgs('/profile', 'darwin', undefined, false);
  expect(virtual).toEqual(expect.arrayContaining(['--disable-gpu', '--disable-software-rasterizer']));
  expect(virtual).not.toContain('--enable-gpu');
  expect(await drawsWithGpu('linux')).toBe(true);
  expect(await drawsWithGpu('win32')).toBe(true);
});

// The GPU process of a CI runner lost its Metal device and the browser answered nothing for 10 to 30 seconds.
test.skipIf(process.platform !== 'darwin')('a Mac draws with the GPU only on its own hardware, as sysctl reads it', async () => {
  const hypervisor = Bun.spawnSync({ cmd: ['sysctl', '-n', 'kern.hv_vmm_present'], stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim();
  expect(['0', '1']).toContain(hypervisor);
  expect(await drawsWithGpu()).toBe(hypervisor === '0');
});

test('a profile loses its downloaded components and caches once, never its cookies, logins or Local State', () => {
  const profile = mkdtempSync(join(tmpdir(), 'boite-profile-'));
  try {
    const leftovers = ['component_crx_cache', 'ProvenanceData', 'Edge Wallet', 'Edge Entity Extraction', 'Edge Shopping', join('Default', 'Cache'), join('Default', 'Code Cache')];
    const kept = ['Local State', 'boite-cookies.json', join('Default', 'Network', 'Cookies'), join('Default', 'Login Data'), join('Default', 'Preferences')];
    for (const folder of leftovers) { mkdirSync(join(profile, folder), { recursive: true }); writeFileSync(join(profile, folder, 'data'), 'x'); }
    for (const file of kept) { mkdirSync(dirname(join(profile, file)), { recursive: true }); writeFileSync(join(profile, file), 'kept'); }
    trimProfile(profile);
    for (const folder of leftovers) expect(existsSync(join(profile, folder))).toBe(false);
    for (const file of kept) expect(readFileSync(join(profile, file), 'utf8')).toBe('kept');
    // Once: what the browser writes back later stays.
    mkdirSync(join(profile, 'Default', 'Cache'));
    trimProfile(profile);
    expect(existsSync(join(profile, 'Default', 'Cache'))).toBe(true);
  } finally { rmSync(profile, { recursive: true, force: true }); }
});

test('a profile whose browser dropped its connection opens again only once that browser exited', async () => {
  const { harness } = browserFixture;
  const engines = new BrowserEngines(harness.core, { attached: false } as BrowserHost, () => ({ path: 'chromium' }), 'test', 'browser:test', () => {}, () => {}, { prepare: () => harness.dataDir, lost() {} });
  const gate = () => { let open!: () => void; return { promise: new Promise<void>((resolve) => { open = resolve; }), open: () => open() }; };
  const started: { exit(): void; disconnect(): void }[] = [];
  engines.launch = async (profile) => {
    const exited = gate(), closed = gate();
    started.push({ exit: exited.open, disconnect: closed.open });
    return { key: profile, profile, hosted: false, dir: '', cdp: { closed: closed.promise, close() {}, send: async () => ({}) } as unknown as Cdp, kill() {}, exited: exited.promise, tabs: new Set(), throwaway: false, identity: null } satisfies Engine;
  };
  const first = await engines.get('default');
  // The connection drops; the process still holds the profile's folder.
  started[0]!.disconnect();
  let reopened: Engine | null = null;
  const reopening = engines.get('default').then((engine) => { reopened = engine; return engine; });
  await Bun.sleep(50);
  expect(started).toHaveLength(1);
  expect(reopened).toBeNull();
  started[0]!.exit();
  expect(await reopening).not.toBe(first);
  expect(started).toHaveLength(2);
});

test('a profile whose browser failed while starting opens again only once that browser exited', async () => {
  const { harness } = browserFixture;
  const engines = new BrowserEngines(harness.core, { attached: false } as BrowserHost, () => ({ path: 'chromium' }), 'test', 'browser:test', () => {}, () => {}, { prepare: () => harness.dataDir, lost() {} });
  const launch = engines.launch.bind(engines);
  engines.launch = (profile) => launch(profile, false);
  const gate = () => { let open!: () => void; return { promise: new Promise<void>((resolve) => { open = resolve; }), open: () => open() }; };
  const exits: (() => void)[] = [];
  engines.start = async () => {
    const exited = gate();
    const first = exits.length === 0;
    exits.push(exited.open);
    // The first browser answers, then its connection fails while it is set up.
    const send = async (method: string) => { if (first && method === 'Target.setDiscoverTargets') throw new Error('connection lost'); return {}; };
    return { cdp: { closed: new Promise(() => {}), close() {}, send } as unknown as Cdp, kill: () => exited.promise, exited: exited.promise };
  };
  const failing = engines.get('default').catch((error: Error) => error);
  await Bun.sleep(50);
  const during = engines.get('default').catch((error: Error) => error);
  await Bun.sleep(50);
  expect(exits).toHaveLength(1);
  exits[0]!();
  expect(String(await failing)).toContain('connection lost');
  expect(String(await during)).toContain('connection lost');
  await engines.get('default');
  expect(exits).toHaveLength(2);
});

test('a profile the desktop app hosted opens again after its idle browser closed', async () => {
  const { harness } = browserFixture;
  const host = new BrowserHost();
  // The app answers every DevTools message, and keeps its webviews when told Browser.close (`packages/ui/src/lib/browser-host.ts`).
  const app = {
    identity: { principal: 'owner' }, sentFrom: { client: 'shell' }, remote: false, onClose: () => () => {},
    sendEvent(_name: string, { profile, message }: { profile: string; message: string }) {
      const { id } = JSON.parse(message) as { id: number };
      queueMicrotask(() => host.reply(app, profile, [JSON.stringify({ id, result: { cookies: [] } })]));
    },
  } as unknown as Connection;
  host.attach(app);
  const engines = new BrowserEngines(harness.core, host, () => ({ path: 'chromium' }), 'test', 'browser:test', () => {}, () => {}, { prepare: () => harness.dataDir, lost() {} });
  const first = await engines.get('default');
  expect(first.hosted).toBe(true);
  // What the idle timer does once the profile's last tab closed.
  await engines.shut(first);
  const again = await Promise.race([engines.get('default'), Bun.sleep(2000).then(() => null)]);
  expect(again).not.toBeNull();
  expect(again).not.toBe(first);
  await engines.shut(again!);
}, 20_000);

test('a deleted profile loses its folder even when its browser had already closed', async () => {
  const { harness, owner, agent, threadId } = browserFixture;
  const root = join(harness.dataDir, 'browser');
  for (const name of ['default', 'p-keep', 'p-gone', 'private-00000000-0000-0000-0000-000000000000', 'Not A Profile']) mkdirSync(join(root, name), { recursive: true });
  await owner.call('settings.set', { browserProfiles: [{ id: 'p-keep', name: 'Keep' }] });
  // The first use of the agent browser looks at what is on disk.
  await agent.call('browser.command', { threadId, action: { kind: 'status' } });
  let names: string[] = [];
  for (let i = 0; i < 50; i++) { names = readdirSync(root).sort(); if (!names.includes('p-gone')) break; await Bun.sleep(50); }
  expect(names).toEqual(['Not A Profile', 'default', 'p-keep']);
  // Deleting one in Settings later takes its folder too.
  await owner.call('settings.set', { browserProfiles: [] });
  for (let i = 0; i < 50 && readdirSync(root).includes('p-keep'); i++) await Bun.sleep(50);
  expect(readdirSync(root).sort()).toEqual(['Not A Profile', 'default']);
});

real('each profile keeps its own cookies, across a restart of the browser; a private tab keeps none', async () => {
  const { harness, owner, threadId } = browserFixture;
  await owner.call('settings.set', { browserProfiles: [{ id: 'p-pro', name: 'Pro' }] });
  const visit = async (browser: AgentBrowser, profile: string, write?: string) => {
    const { tabId } = await browser.command({ threadId, action: { kind: 'open', url: url(), profile } });
    if (write) await browser.command({ threadId, tabId, action: { kind: 'evaluate', expression: `document.cookie = 'login=${write}; max-age=3600'` } });
    const cookie = (await browser.command({ threadId, tabId, action: { kind: 'evaluate', expression: 'document.cookie' } })).value;
    await browser.command({ threadId, tabId, action: { kind: 'close' } });
    return cookie;
  };
  expect(await visit(harness.core.browser, 'default', 'nuno')).toBe('login=nuno');
  expect(await visit(harness.core.browser, 'Pro', 'work')).toBe('login=work');
  expect(await visit(harness.core.browser, 'private', 'ghost')).toBe('login=ghost');
  // Every browser process ends, as when the core stops; the next ones read the same folders.
  await harness.core.browser.close();
  const again = new AgentBrowser(harness.core);
  try {
    expect(await visit(again, 'default')).toBe('login=nuno');
    expect(await visit(again, 'Pro')).toBe('login=work');
    expect(await visit(again, 'private')).toBe('');
  } finally { await again.close(); }
}, 150_000);

real('a sign-in is on disk while its tab is still open: a core killed there keeps it', async () => {
  const { harness, threadId } = browserFixture;
  const { tabId } = await harness.core.browser.command({ threadId, action: { kind: 'open', url: url() } });
  await harness.core.browser.command({ threadId, tabId, action: { kind: 'evaluate', expression: "document.cookie = 'login=kept; max-age=3600'" } });
  // A sign-in ends on a page change; nothing closes the tab or the browser here.
  await harness.core.browser.command({ threadId, tabId, action: { kind: 'navigate', url: url() } });
  const file = join(harness.core.dataDir, 'browser', 'default', 'boite-cookies.json');
  const names = () => { try { return (JSON.parse(readFileSync(file, 'utf8')) as { name: string; value: string }[]).map(cookie => `${cookie.name}=${cookie.value}`); } catch { return []; } };
  for (let i = 0; i < 100 && !names().includes('login=kept'); i++) await Bun.sleep(50);
  expect(names()).toContain('login=kept');
  await harness.core.browser.command({ threadId, tabId, action: { kind: 'close' } });
}, 150_000);

real('the owner copies a desktop profile into the agent browser: the profile is made here, its sign-ins open with it and outlive a restart', async () => {
  const { harness, owner, agent, threadId } = browserFixture;
  const cookies = [
    { name: 'session', value: 'no-expiry', domain: '127.0.0.1', path: '/' },
    { name: 'kept', value: 'a-month', domain: '127.0.0.1', path: '/', expires: Math.floor(Date.now() / 1000) + 30 * 86400, sameSite: 'Lax' as const },
  ];
  // Sign-ins are the owner's to hand over: never an agent's, never into a private tab, never malformed.
  expect(await thrown(agent.call('browser.importCookies', { profile: { id: 'p-work', name: 'Work' }, cookies }))).toThrow("agent's methods");
  expect(await thrown(owner.call('browser.importCookies', { profile: { id: 'private' }, cookies }))).toThrow('private');
  expect(await thrown(owner.call('browser.importCookies', { profile: { id: 'p-work' }, cookies: [{ ...cookies[0]!, path: 'nope' }] }))).toThrow('path');
  expect(await owner.call('browser.importCookies', { profile: { id: 'p-work', name: 'Work' }, cookies })).toEqual({ imported: 2, profile: 'p-work' });
  expect((await owner.call('settings.get', {})).browserProfiles).toEqual([{ id: 'p-work', name: 'Work' }]);
  const read = async (browser: AgentBrowser, profile: string) => {
    const { tabId } = await browser.command({ threadId, action: { kind: 'open', url: url(), profile } });
    const value = (await browser.command({ threadId, tabId, action: { kind: 'evaluate', expression: 'document.cookie.split("; ").sort().join("; ")' } })).value;
    await browser.command({ threadId, tabId, action: { kind: 'close' } });
    return value;
  };
  expect(await read(harness.core.browser, 'Work')).toBe('kept=a-month; session=no-expiry');
  expect(await read(harness.core.browser, 'default')).toBe('');
  // A cookie without an expiry date is a sign-in too: it is still there after every browser process ended.
  await harness.core.browser.close();
  const again = new AgentBrowser(harness.core);
  try {
    expect(await read(again, 'Work')).toBe('kept=a-month; session=no-expiry');
    expect(((await again.command({ threadId, action: { kind: 'status' } })).value as { tabs: unknown[] }).tabs).toEqual([]);
  } finally { await again.close(); }
}, 150_000);
