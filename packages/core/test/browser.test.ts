import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { connect, type CoreClient } from '../src/client.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromiumArgs, findChromium } from '../src/browser/chromium.ts';
import { echoThread, startTestCore, type TestCore } from './harness.ts';

/*
 * The agent browser against a real headless Chromium. A machine without one
 * skips the tests that need it; the one that checks that case runs everywhere.
 */
const real = findChromium().path ? test : test.skip;

const PAGE = `<!doctype html><title>Fixture</title>
<style>body{margin:0;font:16px sans-serif} button{position:absolute;left:100px;top:100px;width:200px;height:80px}</style>
<button id="go" onclick="document.title='clicked'">Go</button>
<input id="name" style="position:absolute;left:100px;top:220px">
<a id="pop" href="#" style="position:absolute;left:100px;top:300px" onclick="window.open('/popup','x','width=400,height=300');return false">Popup</a>
<script>console.error('boom'); fetch('/missing?token=secret');</script>`;

let site: ReturnType<typeof Bun.serve>;
beforeAll(() => {
  site = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => {
    const path = new URL(request.url).pathname;
    if (path === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
    if (path === '/popup') return new Response('<title>Popup</title>popup', { headers: { 'content-type': 'text/html' } });
    if (path === '/moving') return new Response('<title>Moving</title><div id=box style="width:80px;height:80px;background:red;position:absolute"></div><script>let x=0;setInterval(()=>{x=(x+7)%600;box.style.left=x+"px"},16)</script>', { headers: { 'content-type': 'text/html' } });
    return new Response('missing', { status: 404 });
  } });
});
afterAll(() => site.stop(true));
const url = (path = '/') => `http://127.0.0.1:${site.port}${path}`;

let harness: TestCore, owner: CoreClient, agent: CoreClient, threadId: string;
let opened: { harness?: TestCore; owner?: CoreClient; agent?: CoreClient } = {};
beforeEach(async () => {
  opened = {};
  opened.harness = harness = await startTestCore();
  opened.owner = owner = await harness.connect();
  ({ threadId } = await echoThread(harness, owner));
  opened.agent = agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
});
afterEach(async () => { opened.agent?.close(); opened.owner?.close(); await opened.harness?.stop(); });

const evaluate = async (expression: string, tabId?: string) =>
  (await agent.call('browser.command', { threadId, ...(tabId ? { tabId } : {}), action: { kind: 'evaluate', expression } })).value;

/** The pixel size a JPEG declares in its start-of-frame segment. */
function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  for (let at = 2; at < bytes.length;) {
    const marker = bytes[at + 1]!, length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  throw new Error('no JPEG frame header');
}

real('an agent opens, reads and drives a page in the browser of its own machine', async () => {
  const open = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
  expect(open.tabId).toMatch(/^browser:/);
  expect(open.profile).toBe('default');
  expect(open.title).toBe('Fixture');
  const status = (await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as { available: boolean; tabs: Array<{ tabId: string; url: string; title: string; active: boolean }> };
  expect(status.available).toBe(true);
  expect(status.tabs).toMatchObject([{ tabId: open.tabId, url: url(), title: 'Fixture', active: true }]);
  const snapshot = (await agent.call('browser.command', { threadId, action: { kind: 'snapshot' } })).value as { title: string; elements: Array<{ selector: string }>; diagnostics: { entries: Array<{ kind: string; text: string; url?: string }> } };
  expect(snapshot.title).toBe('Fixture');
  expect(snapshot.elements.map(element => element.selector)).toContain('#go');
  expect(snapshot.diagnostics.entries).toContainEqual(expect.objectContaining({ kind: 'console', text: 'boom' }));
  // The query string carried a token: diagnostics keep the address without it.
  expect(snapshot.diagnostics.entries).toContainEqual(expect.objectContaining({ kind: 'network', url: url('/missing') }));
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
}, 60_000);

real('a viewer on another device watches and drives the tab, and hears it come and go', async () => {
  const { grant } = await owner.call('pairing.grant', {});
  const phone = await connect(harness.url, '', { grant, client: { name: 'pwa', version: 'test' } });
  try {
    await expect(phone.call('browser.remoteStatus', { threadId })).rejects.toThrow('subscribe');
    await phone.call('threads.subscribe', { threadId });
    expect(await phone.call('browser.remoteStatus', { threadId })).toEqual({ live: false, tabs: [], available: true });
    const shown = phone.next('browser.remoteChanged', event => event.threadId === threadId && event.live);
    const { tabId } = await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
    expect((await shown).tabs[0]).toMatchObject({ tabId, profile: 'default', active: true });
    const frame = await phone.call('browser.remoteFrame', { threadId });
    expect(frame).toMatchObject({ tabId, title: 'Fixture', url: url() });
    expect(jpegSize(frame.base64)).toEqual({ width: frame.width, height: frame.height });
    await Bun.sleep(150);
    // A narrow viewer gets a frame no wider than it shows, of the same page.
    const small = await phone.call('browser.remoteFrame', { threadId, tabId, maxWidth: 400, quality: 40 });
    expect(jpegSize(small.base64).width).toBe(400);
    expect([small.width, small.height]).toEqual([frame.width, frame.height]);
    await expect(phone.call('browser.remoteInput', { threadId, frameId: 'unknown', input: { kind: 'key', key: 'Enter' } })).rejects.toThrow('refresh');
    await expect(phone.call('browser.remoteInput', { threadId, frameId: small.id, input: { kind: 'tap', x: .5, y: .5, width: small.width + 1, height: small.height } })).rejects.toThrow('viewport');
    // The button spans 100..300 × 100..180 CSS pixels.
    await phone.call('browser.remoteInput', { threadId, frameId: small.id, input: { kind: 'tap', x: 200 / small.width, y: 140 / small.height, width: small.width, height: small.height } });
    expect(await evaluate('document.title')).toBe('clicked');
    await expect(phone.call('browser.remoteInput', { threadId, frameId: small.id, input: { kind: 'navigate', url: 'javascript:alert(1)' } })).rejects.toThrow('HTTP');
    // A viewer never gets the agent's own command, which can run scripts.
    await expect(phone.call('browser.command', { threadId, action: { kind: 'evaluate', expression: '1' } })).rejects.toThrow();
    const gone = phone.next('browser.remoteChanged', event => event.threadId === threadId && !event.live);
    await owner.call('threads.archive', { threadId });
    expect((await gone).tabs).toEqual([]);
  } finally { phone.close(); }
}, 60_000);

real('a window a page opens joins the conversation as a tab of its own', async () => {
  await agent.call('browser.command', { threadId, action: { kind: 'open', url: url() } });
  await agent.call('browser.command', { threadId, action: { kind: 'click', selector: '#pop' } });
  let tabs: Array<{ url: string; title: string }> = [];
  for (let i = 0; i < 50 && tabs.length < 2; i++) {
    await Bun.sleep(100);
    tabs = ((await agent.call('browser.command', { threadId, action: { kind: 'status' } })).value as { tabs: typeof tabs }).tabs;
  }
  expect(tabs.map(tab => tab.url)).toEqual([url(), url('/popup')]);
}, 60_000);

real('a recording is an MP4 made in the browser itself, and one left running when the turn ends is thrown away', async () => {
  await agent.call('browser.command', { threadId, action: { kind: 'open', url: url('/moving') } });
  await agent.call('browser.command', { threadId, action: { kind: 'recording-start' } });
  await expect(agent.call('browser.command', { threadId, action: { kind: 'recording-start' } })).rejects.toThrow('already running');
  await Bun.sleep(1500);
  const { recording, tabId } = await agent.call('browser.command', { threadId, action: { kind: 'recording-stop' } });
  expect(recording).toMatchObject({ mime: 'video/mp4', codec: 'h264', reason: 'stopped', frameRate: 30 });
  expect(recording!.bytes).toBeGreaterThan(1000);
  expect(recording!.frames).toBeGreaterThan(10);
  const chunk = (await agent.call('browser.command', { threadId, tabId, action: { kind: 'recording-read', recordingId: recording!.id, offset: 0, maxBytes: 1024 } })).value as { base64: string; nextOffset: number; done: boolean };
  expect(Buffer.from(chunk.base64, 'base64').subarray(4, 8).toString()).toBe('ftyp');
  expect(chunk).toMatchObject({ nextOffset: 1024, done: false });
  await agent.call('browser.command', { threadId, tabId, action: { kind: 'recording-discard', recordingId: recording!.id } });
  await agent.call('browser.command', { threadId, action: { kind: 'recording-start' } });
  const finished = owner.next('turn.finished', row => row.threadId === threadId, 10_000);
  await owner.call('turns.start', { threadId, prompt: 'hello' });
  await finished; await Bun.sleep(300);
  await expect(agent.call('browser.command', { threadId, action: { kind: 'recording-stop' } })).rejects.toThrow('discarded');
}, 60_000);

test('without a Chromium-based browser the status says why and nothing opens', async () => {
  const previous = process.env.BOITE_BROWSER;
  process.env.BOITE_BROWSER = '/nonexistent/chrome';
  try {
    await owner.call('threads.subscribe', { threadId });
    const status = await owner.call('browser.remoteStatus', { threadId });
    expect(status).toMatchObject({ live: false, available: false });
    expect(status.reason).toContain('/nonexistent/chrome');
    await expect(agent.call('browser.command', { threadId, action: { kind: 'open', url: 'http://127.0.0.1:1/' } })).rejects.toThrow('cannot start');
  } finally {
    if (previous === undefined) delete process.env.BOITE_BROWSER; else process.env.BOITE_BROWSER = previous;
  }
});

test('the browser is found where each OS installs it, and BOITE_BROWSER alone when set', () => {
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
  } finally { rmSync(root, { recursive: true, force: true }); }
});
