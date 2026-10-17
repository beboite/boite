/**
 * What the UI's page holds after a long stretch of busy agents: the JS heap,
 * the DOM and the renderer's private memory, sampled with garbage collected,
 * while the fake client streams what a machine with many agents at work sends
 * (`?fake=1&load=<n>`, `lib/fake-client/load.ts`) and the user moves from one
 * busy thread to the next. docs/performance.md, "What a long day holds".
 *
 * Run: bun bench/ui-heap.ts [--load 16] [--minutes 6] [--sample 60] [--switch 20]
 *        [--tick 100] [--open <thread>] [--core] [--steps 30] [--machines] [--hidden] [--bundle <dir>] [--ui <checkout>/packages/ui] [--snapshots <dir>]
 *
 * `--core` runs the same page on a real core instead (sources, echo agents,
 * a fresh data directory): `--load` threads whose turns stream text, run a
 * tool and spawn a traced process every second or so, one turn after the
 * other, over the real socket and the core's own projections.
 *
 * `--switch` opens the next busy thread every that many seconds (0 stays on the
 * first). `--snapshots <dir>` writes a heap snapshot at the first and the last
 * sample and prints the constructors whose retained count and size grew most;
 * build with `BENCH_MINIFY=0` to keep their names. The page runs the fake core
 * too: what it holds is bounded (`load.ts` keeps forty messages a thread, its
 * logs 4096 records), so growth past the first minutes is the UI's.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from '../packages/ui/src/lib/onboarding.ts';
import { findBrowser, freePort } from '../tests/e2e/lib/cdp.ts';
import { pairingUrlOf, startCore, type RunningCore } from '../tests/e2e/lib/core.ts';
import { connect, type CoreClient } from '../packages/core/src/client.ts';

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const LOAD = Number(option('load') ?? 16);
const MINUTES = Number(option('minutes') ?? 6);
const SAMPLE = Number(option('sample') ?? 60);
const SWITCH = Number(option('switch') ?? 20);
const TICK = Number(option('tick') ?? 100);
const SNAPSHOTS = option('snapshots');
/** `--open <thread>` stays on that thread instead of a busy one: what the other threads' events alone cost. */
const OPEN = option('open');
const CORE = argv.includes('--core');
/** `--machines` adds the fake's second machine, at the same load: its store takes its own stream. */
const MACHINES = argv.includes('--machines');
/** `--hidden` hides the page once the thread is open, as the app's minimized window is: headless Chrome cannot, so the page is told it is hidden and its frames are held. */
const HIDDEN = argv.includes('--hidden');
/** `--steps` per echo turn, a second each: text, a pause, a tool call and a traced process. 30 by default. */
const STEPS = Number(option('steps') ?? 30);
const PROMPT = Array.from({ length: STEPS }, (_, step) => `Step ${step}: the agent reads the module, runs the checks and writes down what it found before the next one. [sleep:450] [tool:300] [spawn:echo traced-${step}]`).join(' ');
const SETUP = `try { localStorage.setItem(${JSON.stringify(ONBOARDING_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify({ version: ONBOARDING_VERSION, at: 0 }))}); } catch {}`;

/** One DevTools connection. */
class Session {
  #id = 0;
  #pending = new Map<number, { settle: (value: Record<string, unknown>) => void; fail: (error: Error) => void }>();
  readonly listeners = new Map<string, (params: Record<string, unknown>) => void>();
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; result?: Record<string, unknown>; error?: { message: string }; method?: string; params?: Record<string, unknown> };
      const listener = typeof message.method === 'string' ? this.listeners.get(message.method) : undefined;
      if (typeof listener === 'function') listener(message.params ?? {});
      if (typeof message.id !== 'number') return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.fail(new Error(message.error.message));
      else pending.settle(message.result ?? {});
    });
  }
  static async open(url: string): Promise<Session> {
    const socket = new WebSocket(url);
    await new Promise((ready, fail) => { socket.addEventListener('open', ready); socket.addEventListener('error', fail); });
    return new Session(socket);
  }
  send(method: string, params: Record<string, unknown> = {}, ms = 120_000): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((settle, fail) => {
      const timer = setTimeout(() => { this.#pending.delete(id); fail(new Error(`${method} got no answer in ${ms / 1000} s`)); }, ms);
      this.#pending.set(id, { settle: (value) => { clearTimeout(timer); settle(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }) as { result?: { value?: T }; exceptionDetails?: unknown };
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails).slice(0, 400));
    return answer.result?.value as T;
  }
  async waitFor(expression: string, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.evaluate<boolean>(`!!(${expression})`)) return;
      await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${expression}`);
  }
  close(): void { this.socket.close(); }
}

/** Count and self size by constructor, from a `.heapsnapshot`. */
function census(snapshot: { snapshot: { meta: { node_fields: string[]; node_types: (string[] | string)[] } }; nodes: number[]; strings: string[] }): Map<string, { count: number; size: number }> {
  const fields = snapshot.snapshot.meta.node_fields;
  const types = snapshot.snapshot.meta.node_types[0] as string[];
  const width = fields.length;
  const typeAt = fields.indexOf('type'), nameAt = fields.indexOf('name'), sizeAt = fields.indexOf('self_size');
  const by = new Map<string, { count: number; size: number }>();
  for (let index = 0; index < snapshot.nodes.length; index += width) {
    const type = types[snapshot.nodes[index + typeAt]!]!;
    const name = type === 'object' || type === 'closure' || type === 'native' ? `${type}:${snapshot.strings[snapshot.nodes[index + nameAt]!]}` : type;
    const entry = by.get(name) ?? { count: 0, size: 0 };
    entry.count += 1;
    entry.size += snapshot.nodes[index + sizeAt]!;
    by.set(name, entry);
  }
  return by;
}

async function main(): Promise<void> {
  const own = option('bundle') === undefined;
  const bundle = option('bundle') ?? mkdtempSync(join(tmpdir(), 'boite-ui-heap-'));
  if (own) {
    const ui = option('ui');
    const builder = Bun.spawn({ cmd: [process.execPath, join(import.meta.dir, 'ui-frames.ts'), '--build', bundle, ...(ui === undefined ? [] : ['--ui', ui])], stdout: 'inherit', stderr: 'inherit' });
    if ((await builder.exited) !== 0) throw new Error('the UI build failed');
  }
  const uiPort = await freePort();
  const server = Bun.serve({
    port: uiPort,
    hostname: '127.0.0.1',
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const file = Bun.file(join(bundle, path === '/' ? 'index.html' : path));
      return (await file.exists()) ? new Response(file) : new Response(Bun.file(join(bundle, 'index.html')));
    },
  });
  const debugPort = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'boite-ui-heap-profile-'));
  const chrome = Bun.spawn({
    cmd: [findBrowser(), '--headless=new', '--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--disable-software-rasterizer',
      '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--lang=en-US',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-allow-origins=*',
      '--window-size=1280,890', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'],
    stdout: 'ignore', stderr: 'ignore', windowsHide: true,
  });
  const sessions: Session[] = [];
  let core: RunningCore | null = null;
  let owner: CoreClient | null = null;
  let stopped = false;
  try {
    let url = `http://127.0.0.1:${uiPort}/?fake=1&load=${LOAD}&loadtick=${TICK}${MACHINES ? '&machines=1' : ''}`;
    let ids = Array.from({ length: LOAD }, (_, index) => `t-load-${index + 1}`);
    if (CORE) {
      // The core serves this bundle itself: one origin, as the shell's window has.
      core = await startCore({ env: { BOITE_UI_DIR: bundle } });
      owner = await connect(core.url, core.token);
      const cwd = join(core.dataDir, 'project');
      mkdirSync(cwd);
      const project = await owner.call('projects.add', { path: cwd, name: 'UI heap' });
      const account = (await owner.call('accounts.list', {})).find((entry) => entry.providerId === 'echo')!;
      ids = [];
      for (let index = 0; index < LOAD; index += 1) ids.push((await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId: account.id, title: `Busy agent ${index + 1}` })).id);
      const client = owner;
      // Each thread starts its next turn as soon as the last one ends.
      client.on('turn.finished', (turn) => { if (!stopped && ids.includes(turn.threadId)) void client.call('turns.start', { threadId: turn.threadId, prompt: PROMPT }).catch(() => undefined); });
      for (const threadId of ids) await client.call('turns.start', { threadId, prompt: PROMPT });
      url = pairingUrlOf(core);
    }
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let attempt = 0; attempt < 100 && !version; attempt++) {
      try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json() as { webSocketDebuggerUrl: string }; } catch { /* not up yet */ }
      if (!version) await Bun.sleep(100);
    }
    if (!version) throw new Error('Chrome did not answer');
    const browser = await Session.open(version.webSocketDebuggerUrl);
    sessions.push(browser);
    const target = ((await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((entry) => entry.type === 'page')!;
    const page = await Session.open(target.webSocketDebuggerUrl);
    sessions.push(page);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Performance.enable');
    await page.send('HeapProfiler.enable');
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SETUP });
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await page.send('Page.navigate', { url });
    await page.waitFor(`document.readyState === 'complete' && globalThis.__bench?.store?.booted`);
    const open = async (index: number): Promise<void> => {
      const id = OPEN ?? ids[index % ids.length]!;
      await page.evaluate(`globalThis.__bench.store.open(${JSON.stringify(id)})`);
      await page.waitFor(`globalThis.__bench.store.openThread?.id === ${JSON.stringify(id)}`);
    };
    await open(0);
    if (HIDDEN) {
      // Headless Chrome never hides a page, minimized or not. What a hidden page
      // changes for the app is emulated: it reads hidden, and a frame callback
      // waits for the page to be shown again, as Chromium holds it.
      await page.evaluate(`(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        const held = globalThis.__benchFrames = new Map();
        let next = 0;
        window.requestAnimationFrame = (callback) => { held.set(++next, callback); return next; };
        window.cancelAnimationFrame = (id) => { held.delete(id); };
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('blur'));
      })()`);
    }
    // `BENCH_CALLS=1` counts the calls the page makes between two samples.
    if (process.env.BENCH_CALLS) await page.evaluate(`(() => { const client = globalThis.__bench.store.client; const call = client.call.bind(client); client.call = (method, ...rest) => { const calls = globalThis.__benchCalls ??= {}; calls[method] = (calls[method] ?? 0) + 1; return call(method, ...rest); }; })()`);

    /** The private bytes of the largest renderer: the page's, a spare one holds a few MiB. */
    const privateBytes = async (): Promise<number | null> => {
      if (process.platform !== 'win32') return null;
      const { processInfo } = await browser.send('SystemInfo.getProcessInfo') as { processInfo: { type: string; id: number }[] };
      const pids = processInfo.filter((entry) => entry.type === 'renderer').map((entry) => entry.id);
      if (pids.length === 0) return null;
      const answer = Bun.spawnSync({ cmd: ['powershell', '-NoProfile', '-Command', `(Get-Process -Id ${pids.join(',')} | Measure-Object PrivateMemorySize64 -Maximum).Maximum`], stdout: 'pipe', stderr: 'ignore', windowsHide: true });
      const value = Number(answer.stdout.toString().trim());
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    const snapshot = async (): Promise<ReturnType<typeof census>> => {
      const chunks: string[] = [];
      page.listeners.set('HeapProfiler.addHeapSnapshotChunk', (params) => { chunks.push(params['chunk'] as string); });
      await page.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false, captureNumericValue: false }, 600_000);
      page.listeners.delete('HeapProfiler.addHeapSnapshotChunk');
      const text = chunks.join('');
      await Bun.write(join(SNAPSHOTS!, `ui-heap-${Date.now()}.heapsnapshot`), text);
      return census(JSON.parse(text));
    };
    const sample = async () => {
      await page.send('HeapProfiler.collectGarbage');
      await page.send('HeapProfiler.collectGarbage');
      const { usedSize } = await page.send('Runtime.getHeapUsage') as { usedSize: number };
      const metrics = Object.fromEntries(((await page.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((metric) => [metric.name, metric.value]));
      const store = await page.evaluate<{ messages: number; parts: number; trace: number; rows: number; calls: string }>(`(() => { const s = globalThis.__bench.store; const calls = globalThis.__benchCalls ?? {}; globalThis.__benchCalls = {}; return { messages: s.openThread?.messages.length ?? 0, parts: s.openThread?.messages.reduce((sum, m) => sum + m.parts.length, 0) ?? 0, trace: s.trace.length, rows: s.threads.length, calls: Object.entries(calls).map(([k, v]) => k + ' ' + v).join(', ') + (globalThis.__benchFrames ? 'frames held ' + globalThis.__benchFrames.size : '') }; })()`);
      return { usedSize, nodes: metrics['Nodes']!, listeners: metrics['JSEventListeners']!, privateBytes: await privateBytes(), ...store };
    };
    const mib = (bytes: number | null) => bytes === null ? 'n/a' : (bytes / 1048576).toFixed(1);

    console.log(`# ui-heap, ${CORE ? 'real core, echo agents' : 'fake client'}${MACHINES ? ', two machines' : ''}${HIDDEN ? ', page hidden' : ''}, ${LOAD} busy threads, tick ${TICK} ms, switch every ${SWITCH || 'never'} s, ${new Date().toISOString().slice(0, 10)}`);
    console.log('minute | JS heap MiB | renderer private MiB | DOM nodes | listeners | open thread messages | trace rows | sidebar rows');
    const started = Date.now();
    let first: ReturnType<typeof census> | null = null;
    let switched = 0;
    let nextSwitch = started + SWITCH * 1000;
    let nextSample = started;
    const end = started + MINUTES * 60_000;
    while (true) {
      const now = Date.now();
      if (now >= nextSample) {
        const row = await sample();
        console.log(`${((now - started) / 60_000).toFixed(1)} | ${mib(row.usedSize)} | ${mib(row.privateBytes)} | ${row.nodes} | ${row.listeners} | ${row.messages} (${row.parts} parts) | ${row.trace} | ${row.rows}${process.env.BENCH_CALLS || HIDDEN ? ` | ${row.calls}` : ''}`);
        if (SNAPSHOTS && first === null) first = await snapshot();
        nextSample += SAMPLE * 1000;
      }
      if (now >= end) break;
      if (SWITCH > 0 && now >= nextSwitch) { await open(++switched); nextSwitch += SWITCH * 1000; }
      await Bun.sleep(Math.max(50, Math.min(nextSample, nextSwitch, end) - Date.now()));
    }
    if (SNAPSHOTS && first) {
      await page.send('HeapProfiler.collectGarbage');
      const last = await snapshot();
      const growth = [...last].map(([name, entry]) => ({ name, count: entry.count - (first!.get(name)?.count ?? 0), size: entry.size - (first!.get(name)?.size ?? 0) }))
        .sort((a, b) => b.size - a.size).slice(0, 25);
      console.log('\nconstructor | count growth | self size growth KiB');
      for (const entry of growth) console.log(`${entry.name.slice(0, 80)} | ${entry.count} | ${(entry.size / 1024).toFixed(0)}`);
    }
  } finally {
    stopped = true;
    for (const session of sessions) session.close();
    owner?.close();
    await core?.stop();
    chrome.kill();
    await chrome.exited;
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
    if (own) rmSync(bundle, { recursive: true, force: true });
  }
}

await main();
