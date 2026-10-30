import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RemoteBrowserFrame, RemoteBrowserUnchanged } from '@boite/contracts';
import { connect, type CoreClient } from '../../src/client.ts';
import { chromiumArgs, findChromium, waitForEndpoint } from '../../src/browser/chromium.ts';
import { echoThread, startTestCore, type TestCore } from '../harness.ts';
import { TextSocket } from '../../src/ws-client.ts';

const PAGE = `<!doctype html><title>Fixture</title>
<style>body{margin:0;font:16px sans-serif} button{position:absolute;left:100px;top:100px;width:200px;height:80px}</style>
<button id="go" onclick="document.title='clicked'">Go</button>
<input id="name" style="position:absolute;left:100px;top:220px">
<a id="pop" href="#" style="position:absolute;left:100px;top:300px" onclick="window.open('/popup','x','width=400,height=300');return false">Popup</a>
<p id="words" style="position:absolute;left:100px;top:360px;margin:0;width:400px">Select these words</p>
<select id="day" style="position:absolute;left:100px;top:420px;width:120px;height:32px"><option>1</option><option selected>20</option><option disabled>21</option><option hidden>22</option><optgroup label="Late"><option value="30">Thirty</option></optgroup></select>
<script>console.error('boom'); fetch('/missing?token=secret'); window.messages = []; addEventListener('message', event => messages.push(event.data));</script>`;

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

// A page that loads its data from an API with a credential, as most sites do: `browser network` finds the call.
const APP = `<!doctype html><title>App</title>
<button id="load" onclick="fetch('/api/items?page=2&token=abc123', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer s3cret-value' }, body: JSON.stringify({ query: 'shoes', password: 'hunter2' }) }).then(r => r.json()).then(d => document.title = 'loaded ' + d.items.length)">Load</button>`;

/**
 * How long a sleeping tab's step that missed its time is still listened to
 * (`LATE_MS` in `browser/sleep.ts`): its late answer, or the timeout that says
 * none came, is heard within it.
 */
const SLEEP_LATE_MS = 30_000;
/** A call a stalled sleep step failed: its probe and its late answer arrive after the call's own failure. */
const STALLED_CALL = / failed: the browser did not answer \S+ within \d+ seconds/;

/**
 * The causes of the calls that failed unexpectedly: a client only gets "Something went wrong".
 * A stalled sleep step says what it was only after its call failed, so the
 * core stays up until each one did, for `SLEEP_LATE_MS` at most.
 */
export class CoreFailures {
  readonly lines: string[] = [];
  /** Failed calls whose stalled step has not reported yet: only a report heard after the call answers it. */
  #calls = 0;
  /** Stalled steps still owed a late answer. */
  #owed = 0;
  /** Late answers heard before their step's probe reported, which can take 1 s more than the answer. */
  #early = 0;
  #heard = () => {};
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private windowMs = SLEEP_LATE_MS, private wait = (ms: number) => new Promise<void>(resolve => { this.#timer = setTimeout(resolve, ms); })) {}

  record(message: string, event: unknown): void {
    // What a sleeping tab's stalled step turned out to be explains a wake that failed (`browser/sleep.ts`).
    // A step's call fails before its probe and its late answer report, and a freeze that stalled fails no call.
    if (event === 'rpc.failed') { if (STALLED_CALL.test(message)) this.#calls++; }
    else if (event === 'browser.sleep-stalled') {
      if (this.#calls > 0) this.#calls--;
      if (this.#early > 0) this.#early--; else this.#owed++;
    } else if (event === 'browser.sleep-late') {
      if (this.#owed > 0) this.#owed--; else this.#early++;
    } else return;
    this.lines.push(message);
    this.#heard();
  }

  /** False when the window ended before every stalled step's probe and late answer arrived. */
  async settle(): Promise<boolean> {
    const waiting = () => this.#calls > 0 || this.#owed > 0 || this.#early > 0;
    if (!waiting()) return true;
    let ended = false;
    const end = this.wait(this.windowMs).then(() => { ended = true; });
    try {
      while (waiting() && !ended) await Promise.race([end, new Promise<void>(resolve => { this.#heard = resolve; })]);
    } finally {
      clearTimeout(this.#timer);
      this.#heard = () => {};
    }
    return !waiting();
  }
}

export const DOWNLOAD_SCRIPT = '#!/bin/sh\necho downloaded\n';
export const DOWNLOAD_PROGRAM = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(126)]);

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
  /** How many freezes of an `/animated` page have landed: the page says so from its `freeze` event. */
  let freezes = 0;
  beforeAll(() => {
    site = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: request => {
      const path = new URL(request.url).pathname;
      agents.set(path, request.headers.get('user-agent'));
      if (path === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html' } });
      if (path === '/shop') return new Response(SHOP, { headers: { 'content-type': 'text/html' } });
      if (path === '/app') return new Response(APP, { headers: { 'content-type': 'text/html' } });
      if (path === '/api/items') return (request.method === 'POST' ? request.json() as Promise<{ query?: string }> : Promise.resolve({ query: undefined }))
        .then(body => Response.json({ items: ['red', 'blue'], query: body.query ?? null, next: 'cursor-2', sessionToken: 'tok-999' }));
      if (path === '/go') return Response.redirect(`http://127.0.0.1:${site.port}/shop`, 302);
      if (path === '/sign-in') return new Response(null, { status: 302, headers: { location: '/app?access_token=tok-777&page=2' } });
      if (path === '/api/fail') return Response.json({ error: 'the shelf is empty' }, { status: 500 });
      // A reply longer than network detail shows, sent as text after a space.
      if (path === '/api/huge') return new Response('z'.repeat(3_000_000), { headers: { 'content-type': 'text/plain' } });
      if (path === '/api/big') return new Response(` ${JSON.stringify({ sessionToken: 'tok-big', rows: 'y'.repeat(60_000) })}`, { headers: { 'content-type': 'text/plain' } });
      if (path === '/later') return later.response.then(() => new Response('released'));
      if (path === '/later/done') { later.complete(); return new Response('done'); }
      if (path === '/sent') return new Response(`<title>Sent</title><h1>Thanks ${new URL(request.url).searchParams.get('name')}</h1>`, { headers: { 'content-type': 'text/html' } });
      // A sign-in popup: it answers its opener, and closes itself on a click.
      if (path === '/popup') return new Response('<title>Popup</title>popup<button id="shut" onclick="if(event.isTrusted)window.close()">Done</button><script>if (opener) opener.postMessage("hello from " + location.search, "*")</script>', { headers: { 'content-type': 'text/html' } });
      // Files a page offers for download: a script, and a program that names itself a picture.
      if (path === '/files') return new Response('<title>Files</title><a id="script" href="/download/tool.sh?token=secret">Script</a> <a id="saved" href="/download/notes.txt" download>Notes</a>', { headers: { 'content-type': 'text/html' } });
      // A frame of another site, so in another process, that downloads as soon as it loads.
      if (path === '/framed') return new Response(`<title>Framed</title><iframe src="http://localhost:${new URL(request.url).port}/autoload"></iframe>`, { headers: { 'content-type': 'text/html' } });
      if (path === '/autoload') return new Response('<a id="s" href="/download/tool.sh">Script</a><script>setTimeout(() => s.click(), 300)</script>', { headers: { 'content-type': 'text/html' } });
      if (path === '/download/tool.sh') return new Response(DOWNLOAD_SCRIPT, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="tool.sh"' } });
      if (path === '/download/notes.txt') return new Response('plain notes\n', { headers: { 'content-type': 'text/plain' } });
      if (path === '/download/report.png') return new Response(DOWNLOAD_PROGRAM, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="../report.png"' } });
      // Draws `hz` times a second, like a video or an animation slower than the screen.
      if (path === '/ticking') return new Response(`<title>Ticking</title><div id=box style="width:80px;height:80px;background:red;position:absolute"></div><script>let x=0;setInterval(()=>{x=(x+7)%600;box.style.left=x+"px"},${1000 / Number(new URL(request.url).searchParams.get('hz') ?? 10)})</script>`, { headers: { 'content-type': 'text/html' } });
      // Animates every frame and every 16 ms; `gaps()` returns the longest pause of each since it was last called, the one still running included: a read right after a wake can run before the next frame.
      // It tells `/animated/frozen` when its freeze lands. With `busy`, it works that many ms as it is hidden, the way a loaded runner's renderer was still running it after the browser had answered the freeze.
      if (path === '/animated/frozen') { freezes++; return new Response(null, { status: 204 }); }
      if (path === '/animated') return new Response(`<title>Animated</title><script>let last=performance.now(),gap=0,tick=Date.now(),tickGap=0;const busy=${Number(new URL(request.url).searchParams.get('busy') ?? 0)};function draw(t){gap=Math.max(gap,t-last);last=t;requestAnimationFrame(draw)}requestAnimationFrame(draw);const ticked=()=>{const now=Date.now();tickGap=Math.max(tickGap,now-tick);tick=now};setInterval(ticked,16);document.addEventListener('visibilitychange',()=>{if(document.visibilityState!=='hidden'||!busy)return;for(const end=Date.now()+busy;Date.now()<end;);ticked()});document.addEventListener('freeze',()=>navigator.sendBeacon('/animated/frozen'));window.gaps=()=>{const r=[Math.round(Math.max(gap,performance.now()-last)),Math.max(tickGap,Date.now()-tick)];gap=0;tickGap=0;return r}</script>`, { headers: { 'content-type': 'text/html' } });
      if (path === '/moving') return new Response('<title>Moving</title><div id=box style="width:80px;height:80px;background:red;position:absolute"></div><script>let x=0;setInterval(()=>{x=(x+7)%600;box.style.left=x+"px"},16)</script>', { headers: { 'content-type': 'text/html' } });
      return new Response('missing', { status: 404 });
    } });
  });
  afterAll(() => site.stop(true));
  const url = (path = '/') => `http://127.0.0.1:${site.port}${path}`;

  let harness: TestCore, owner: CoreClient, agent: CoreClient, threadId: string;
  let opened: { harness?: TestCore; owner?: CoreClient; agent?: CoreClient } = {};
  const hosts = new Set<() => Promise<void>>();
  let failures = new CoreFailures();
  beforeEach(async () => {
    later.release();
    later = laterGate();
    opened = {};
    failures = new CoreFailures();
    opened.harness = harness = await startTestCore();
    const record = harness.core.logs.record.bind(harness.core.logs);
    harness.core.logs.record = (level, message, context = {}, at) => {
      failures.record(message, context.event);
      record(level, message, context, at);
    };
    opened.owner = owner = await harness.connect();
    ({ threadId } = await echoThread(harness, owner));
    opened.agent = agent = await connect(harness.url, harness.core.agents.tokenFor(threadId), { client: { name: 'boite-cli', version: 'test' } });
  });
  // The 60 s a browser shutdown hook gets (docs/development.md), after up to `SLEEP_LATE_MS` for a stalled sleep step's late answer.
  afterEach(async () => {
    later.release();
    const errors: unknown[] = [];
    try {
      if (!await failures.settle()) failures.lines.push(`a stalled sleep step's page did not answer within ${SLEEP_LATE_MS / 1000} s of the test's end`);
    } catch (error) { errors.push(error); }
    for (const failure of failures.lines) console.error(`core: ${failure}`);
    for (const close of hosts) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    try { opened.agent?.close(); } catch (error) { errors.push(error); }
    try { opened.owner?.close(); } catch (error) { errors.push(error); }
    try { await opened.harness?.stop(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'browser fixture cleanup failed');
  }, 60_000 + SLEEP_LATE_MS);

  const evaluate = async (expression: string, tabId?: string) =>
    (await agent.call('browser.command', { threadId, ...(tabId ? { tabId } : {}), action: { kind: 'evaluate', expression } })).value;

  /**
   * A stand-in for the desktop app hosting the agent's tabs: it relays every
   * DevTools message verbatim to a Chromium of its own over a WebSocket, which
   * answers as the app's webviews would. The app's own translation (one webview
   * per target) is tested in the UI; this is the core's side of the relay.
   * With `hold`, the core's messages reach Chromium, in order, only once it settles.
   */
  async function fakeHost(name = 'shell', extraArgs: string[] = [], hold?: Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'boite-host-'));
    let browser: Bun.Subprocess | undefined, socket: TextSocket | undefined, app: CoreClient | undefined;
    let closing: Promise<void> | undefined;
    const close = () => closing ??= (async () => {
      const errors: unknown[] = [];
      const attempt = (action: () => void) => { try { action(); } catch (error) { errors.push(error); } };
      let stuck: ReturnType<typeof setTimeout> | undefined;
      try {
        attempt(() => app?.close());
        if (browser) {
          if (browser.exitCode === null) {
            // Browser.close lets Chromium's helpers release the profile before removal.
            stuck = setTimeout(() => attempt(() => browser!.kill()), 10_000);
            attempt(() => {
              if (socket?.open) socket.send(JSON.stringify({ id: 2 ** 31 - 1, method: 'Browser.close', params: {} }));
              else browser!.kill();
            });
          }
          try { await browser.exited; } catch (error) { errors.push(error); }
        }
      } finally {
        clearTimeout(stuck);
        attempt(() => socket?.close());
        attempt(() => rmSync(dir, { recursive: true, force: true }));
        hosts.delete(close);
      }
      if (errors.length) throw new AggregateError(errors, 'desktop browser host cleanup failed');
    })();
    // Register from the first allocation: setup and a caller failing before its try both own cleanup.
    hosts.add(close);
    try {
      const args = chromiumArgs(dir, 'linux').filter(arg => arg !== '--remote-debugging-pipe');
      browser = Bun.spawn([findChromium().path!, ...args, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', ...extraArgs], { stdout: 'ignore', stderr: 'ignore' });
      // Bun's own WebSocket client closes sound devtools streams with 1002 (src/ws-client.ts).
      const connectedSocket = socket = await TextSocket.connect(await waitForEndpoint(dir, browser.exited), 10_000)
        .catch((error: unknown) => { throw new Error(`could not open the desktop browser DevTools socket: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); });
      const connectedApp = app = await connect(harness.url, harness.token, { client: { name, version: 'test' } });
      const relayed: string[] = [];
      connectedApp.on('browser.hostMessage', ({ profile, message }) => {
        relayed.push(profile);
        if (hold) void hold.then(() => connectedSocket.send(message));
        else connectedSocket.send(message);
      });
      connectedSocket.onMessage(text => void connectedApp.call('browser.hostReply', { profile: 'default', messages: [text] }).catch(() => {}));
      return { app: connectedApp, relayed, close };
    } catch (error) {
      try { await close(); }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'desktop browser host setup and cleanup failed', { cause: error }); }
      throw error;
    }
  }

  return {
    real, url, evaluate, fakeHost, agents,
    releaseLaterDialog() { later.release(); },
    laterDialogDone() { return later.done; },
    frozen() { return freezes; },
    get harness() { return harness; },
    get owner() { return owner; },
    get agent() { return agent; },
    get threadId() { return threadId; },
  };
}

/** A frame answer that carries a picture: a request without `after` never gets `unchanged`. */
export async function picture(answer: Promise<RemoteBrowserFrame | RemoteBrowserUnchanged>): Promise<RemoteBrowserFrame> {
  const frame = await answer;
  if ('unchanged' in frame) throw new Error(`expected a frame, got unchanged ${frame.id}`);
  return frame;
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
