import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, type CoreClient } from '../../src/client.ts';
import { chromiumArgs, findChromium, waitForEndpoint } from '../../src/browser/chromium.ts';
import { echoThread, startTestCore, type TestCore } from '../harness.ts';

const PAGE = `<!doctype html><title>Fixture</title>
<style>body{margin:0;font:16px sans-serif} button{position:absolute;left:100px;top:100px;width:200px;height:80px}</style>
<button id="go" onclick="document.title='clicked'">Go</button>
<input id="name" style="position:absolute;left:100px;top:220px">
<a id="pop" href="#" style="position:absolute;left:100px;top:300px" onclick="window.open('/popup','x','width=400,height=300');return false">Popup</a>
<p id="words" style="position:absolute;left:100px;top:360px;margin:0;width:400px">Select these words</p>
<script>console.error('boom'); fetch('/missing?token=secret');</script>`;

// agent-browser's commands: refs, a form that navigates, dialogs, a covered element.
const SHOP = `<!doctype html><title>Shop</title>
<h1>Shop</h1>
<form action="/sent"><label>Name <input name="name"></label><button>Send</button></form>
<select id="size"><option>Small</option><option value="l">Large</option></select>
<label><input type="checkbox" id="gift" checked> Gift</label>
<button id="ask" onclick="this.textContent = confirm('Sure?') ? 'yes' : 'no'">Ask</button>
<button id="later" onclick="fetch('/later').then(() => { document.title = confirm('Later?') ? 'later yes' : 'later no'; return fetch('/later/done') })">Later</button>
<button id="hidden-under" style="position:absolute;left:0;top:400px;width:120px;height:40px">Under</button>
<div id="cover" style="position:absolute;left:0;top:400px;width:200px;height:60px;background:#ccc">Cover</div>
<p id="note">Free delivery</p>`;

/** Register an independent loopback site and fresh core hooks for each browser test file. */
export function createBrowserFixture() {
  const real = findChromium().path ? test : test.skip;
  let site: ReturnType<typeof Bun.serve>;
  const laterGate = () => {
    let release!: () => void, complete!: () => void;
    const response = new Promise<void>(resolve => { release = resolve; });
    const done = new Promise<void>(resolve => { complete = resolve; });
    return { response, done, release, complete };
  };
  let later = laterGate();
  /** The user agent of the last request for each path: what a site sees. */
  const agents = new Map<string, string | null>();
  beforeAll(() => {
    site = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => {
      const path = new URL(request.url).pathname;
      agents.set(path, request.headers.get('user-agent'));
      if (path === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
      if (path === '/shop') return new Response(SHOP, { headers: { 'content-type': 'text/html' } });
      if (path === '/later') return later.response.then(() => new Response('released'));
      if (path === '/later/done') { later.complete(); return new Response('done'); }
      if (path === '/sent') return new Response(`<title>Sent</title><h1>Thanks ${new URL(request.url).searchParams.get('name')}</h1>`, { headers: { 'content-type': 'text/html' } });
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
    later.release();
    later = laterGate();
    opened = {};
    opened.harness = harness = await startTestCore();
    opened.owner = owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    opened.agent = agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
  });
  afterEach(async () => { later.release(); opened.agent?.close(); opened.owner?.close(); await opened.harness?.stop(); });

  const evaluate = async (expression: string, tabId?: string) =>
    (await agent.call('browser.command', { threadId, ...(tabId ? { tabId } : {}), action: { kind: 'evaluate', expression } })).value;

  /**
   * A stand-in for the desktop app hosting the agent's tabs: it relays every
   * DevTools message verbatim to a Chromium of its own over a WebSocket, which
   * answers as the app's webviews would. The app's own translation (one webview
   * per target) is tested in the UI; this is the core's side of the relay.
   */
  async function fakeHost(name = 'shell') {
    const dir = mkdtempSync(join(tmpdir(), 'boite-host-'));
    const args = chromiumArgs(dir, 'linux').filter(arg => arg !== '--remote-debugging-pipe');
    const browser = Bun.spawn([findChromium().path!, ...args, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'], { stdout: 'ignore', stderr: 'ignore' });
    const socket = new WebSocket(await waitForEndpoint(dir, browser.exited));
    await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }));
    const app = await connect(harness.url, harness.token, { client: { name, version: 'test' } });
    const relayed: string[] = [];
    app.on('browser.hostMessage', ({ profile, message }) => { relayed.push(profile); socket.send(message); });
    socket.addEventListener('message', event => void app.call('browser.hostReply', { profile: 'default', messages: [String(event.data)] }).catch(() => {}));
    return {
      app, relayed,
      async close() {
        app.close();
        // A kill ends the browser process alone: on Windows its helpers keep the
        // profile open a moment longer, and removing it then fails with EBUSY.
        // Browser.close ends them first, as the core closes its own browsers.
        const stuck = setTimeout(() => browser.kill(), 10_000);
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: 2 ** 31 - 1, method: 'Browser.close', params: {} }));
        else browser.kill();
        await browser.exited;
        clearTimeout(stuck);
        socket.close();
        rmSync(dir, { recursive: true, force: true });
      },
    };
  }

  return {
    real, url, evaluate, fakeHost, agents,
    releaseLaterDialog() { later.release(); },
    laterDialogDone() { return later.done; },
    get harness() { return harness; },
    get owner() { return owner; },
    get agent() { return agent; },
    get threadId() { return threadId; },
  };
}

/** The pixel size a JPEG declares in its start-of-frame segment. */
export function jpegSize(base64: string): { width: number; height: number } {
  const bytes = Buffer.from(base64, 'base64');
  expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  for (let at = 2; at < bytes.length;) {
    const marker = bytes[at + 1]!, length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xc2) return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    at += 2 + length;
  }
  throw new Error('no JPEG frame header');
}
