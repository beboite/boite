/**
 * What the UI costs while nothing asks it for a frame: a machine with many
 * agents at work, the user watching one answer stream or looking at another
 * window beside Boite. No `requestAnimationFrame` loop runs in the page, which
 * would itself make a frame every vsync; the figures are the CPU time Chrome's
 * renderer and GPU processes spent and the frames the page's compositor drew.
 * docs/performance.md, "What the UI costs at rest".
 *
 * Run: bun bench/ui-at-rest.ts [--working 16] [--seconds 6] [--runs 1]
 *        [--only "working,working blurred"] [--bundle <dir>] [--ui <checkout>/packages/ui]
 *        [--software] [--css "<rules>"] [--profile <dir>] [--shots <dir>]
 *
 * It composites on the machine's GPU through ANGLE on Direct3D 11, as WebView2
 * does, and stops if Chrome finds only a software renderer; `--software` uses
 * none. Headless Chrome follows no monitor: a smooth loop drew 150 to 340
 * frames a second here, what a fast monitor asks for. The figures hold
 * whatever else the machine runs.
 *
 * "Blurred" scenarios are a window left visible while another application has
 * the focus: the page gets its `blur` and `document.hasFocus()` turns false.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from '../packages/ui/src/lib/onboarding.ts';
import { findBrowser, freePort } from '../tests/e2e/lib/cdp.ts';

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const WORKING = Number(option('working') ?? 16);
const SECONDS = Number(option('seconds') ?? 6);
const RUNS = Number(option('runs') ?? 1);
const SOFTWARE = argv.includes('--software');
const ONLY = option('only')?.split(',').map((name) => name.trim());
/** `--css "<rules>"` adds these rules to the page before each measure: what one declaration costs or saves. */
const CSS = option('css');
/** `--profile <dir>` writes a CPU profile of the page's main thread per scenario. */
const PROFILE = option('profile');
/** A PNG of each scenario as it was measured. */
const SHOTS = option('shots');

/** Long enough that the answer still streams through the measured window. */
const PROMPT = 'Streaming bench paragraph with enough words to wrap across the column.\n\n'.repeat(300);
const SETUP = `try { localStorage.setItem(${JSON.stringify(ONBOARDING_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify({ version: ONBOARDING_VERSION, at: 0 }))}); } catch {}`;

/** One DevTools connection: the browser's, or a page's. */
class Session {
  #id = 0;
  #pending = new Map<number, { settle: (value: Record<string, unknown>) => void; fail: (error: Error) => void }>();
  /** DevTools events by name: only the ones the bench subscribes to are ever called. */
  readonly listeners = new Map<string, (params: Record<string, unknown>) => void>();
  /** Called once Chrome closes the socket, apart from the events a message names. */
  onClose: () => void = () => {};
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
    // A Chrome gone mid-run fails what waits on it instead of leaving Bun nothing to run.
    socket.addEventListener('close', () => {
      for (const pending of this.#pending.values()) pending.fail(new Error('Chrome closed the debugging socket'));
      this.#pending.clear();
      this.onClose();
    });
  }
  static async open(url: string): Promise<Session> {
    const socket = new WebSocket(url);
    await new Promise((ready, fail) => { socket.addEventListener('open', ready); socket.addEventListener('error', fail); });
    return new Session(socket);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((settle, fail) => {
      const timer = setTimeout(() => { this.#pending.delete(id); fail(new Error(`${method} got no answer in 30 s`)); }, 30_000);
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

interface Cost { renderer: number; gpu: number; browser: number; main: number; frames: number; fps: number }

async function main(): Promise<void> {
  const own = option('bundle') === undefined;
  const bundle = option('bundle') ?? mkdtempSync(join(tmpdir(), 'boite-ui-at-rest-'));
  if (own) {
    // ui-frames.ts builds the fake-client bundle, in a process of its own.
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
  const profile = mkdtempSync(join(tmpdir(), 'boite-ui-at-rest-profile-'));
  const chrome = Bun.spawn({
    cmd: [findBrowser(), '--headless=new',
      ...(SOFTWARE ? ['--disable-gpu', '--disable-software-rasterizer', '--disable-3d-apis'] : ['--enable-gpu', '--use-gl=angle', '--use-angle=d3d11', '--disable-software-rasterizer']),
      '--mute-audio', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--lang=en-US',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-allow-origins=*',
      '--window-size=1280,890', `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'],
    stdout: 'ignore', stderr: 'ignore', windowsHide: true,
  });
  const sessions: Session[] = [];
  try {
    let version: { webSocketDebuggerUrl: string } | undefined;
    for (let attempt = 0; attempt < 100 && !version; attempt++) {
      try { version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json() as { webSocketDebuggerUrl: string }; } catch { /* not up yet */ }
      if (!version) await Bun.sleep(100);
    }
    if (!version) throw new Error('Chrome did not answer');
    const browser = await Session.open(version.webSocketDebuggerUrl);
    sessions.push(browser);
    const targets = async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { id: string; type: string; url: string; webSocketDebuggerUrl: string }[];
    const target = (await targets()).find((entry) => entry.type === 'page')!;
    const page = await Session.open(target.webSocketDebuggerUrl);
    sessions.push(page);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Performance.enable', { timeDomain: 'threadTicks' });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SETUP });

    let compositing = 'software compositing';
    if (!SOFTWARE) {
      await page.send('Page.navigate', { url: `http://127.0.0.1:${uiPort}/?fake=1` });
      await Bun.sleep(500);
      const renderer = await page.evaluate<string | null>(`(() => { const gl = document.createElement('canvas').getContext('webgl2'); const debug = gl?.getExtension('WEBGL_debug_renderer_info'); return debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null; })()`);
      if (!renderer || /swiftshader|llvmpipe|softpipe/i.test(renderer)) throw new Error(`no hardware renderer: ${renderer}`);
      compositing = renderer;
    }

    // Headless Chrome moves no focus between its windows: the page is told it
    // has the focus, and a blurred one is told otherwise with the event a
    // switch to another application fires.
    await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    const focus = async (focused: boolean): Promise<void> => {
      await page.evaluate(focused
        ? `(() => { delete document.hasFocus; window.dispatchEvent(new Event('focus')); })()`
        : `(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); })()`);
      await Bun.sleep(300);
    };
    const open = async (query: string, width: number, height: number, mobile: boolean): Promise<void> => {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
      await page.send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${uiPort}`, storageTypes: 'local_storage,indexeddb' });
      await page.send('Page.navigate', { url: `http://127.0.0.1:${uiPort}/?fake=1&${query}` });
      await Bun.sleep(300);
      await page.waitFor(`document.readyState === 'complete' && globalThis.__bench?.store?.booted`);
      await page.evaluate(`globalThis.__bench.store.open('t-trace')`);
      await page.waitFor(`globalThis.__bench.store.openThread?.id === 't-trace' && document.querySelector('[data-testid=composer-input]')`);
      await Bun.sleep(800);
    };
    const stream = async (): Promise<void> => {
      await page.send('Runtime.callFunctionOn', {
        objectId: ((await page.send('Runtime.evaluate', { expression: 'globalThis' })) as { result: { objectId: string } }).result.objectId,
        functionDeclaration: `function (text) { const input = document.querySelector('[data-testid=composer-input]'); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); }`,
        arguments: [{ value: PROMPT }],
      });
      await Bun.sleep(100);
      await page.evaluate(`document.querySelector('[data-testid=composer-send]').click()`);
      // The fake agent reasons over the whole prompt before it answers.
      await page.waitFor(`document.querySelectorAll('.prose.live .paragraph').length >= 2`, 60_000);
    };
    const phone = { width: 390, height: 844, mobile: true };
    const desktop = { width: 1280, height: 890, mobile: false };
    const scenarios: Record<string, { query: string; size: typeof desktop; stream: boolean; focused: boolean; list?: boolean }> = {
      'nothing working': { query: '', size: desktop, stream: false, focused: true },
      'working': { query: `working=${WORKING}`, size: desktop, stream: false, focused: true },
      'working streaming': { query: `working=${WORKING}&stream=tokens`, size: desktop, stream: true, focused: true },
      'working blurred': { query: `working=${WORKING}`, size: desktop, stream: false, focused: false },
      'working blurred streaming': { query: `working=${WORKING}&stream=tokens`, size: desktop, stream: true, focused: false },
      'phone working streaming': { query: `working=${WORKING}&stream=tokens`, size: phone, stream: true, focused: true },
      'phone working list': { query: `working=${WORKING}`, size: phone, stream: false, focused: true, list: true },
    };

    type Process = { id: number; type: string; cpuTime: number };
    const processes = async (): Promise<Process[]> => ((await browser.send('SystemInfo.getProcessInfo')) as { processInfo: Process[] }).processInfo;
    const measure = async (): Promise<Cost> => {
      const frames: number[] = [];
      let done: () => void = () => undefined;
      const complete = new Promise<void>((resolve) => { done = resolve; });
      page.listeners.set('Tracing.dataCollected', (params) => {
        for (const event of params['value'] as { name: string; ph: string }[]) if (event.name === 'DrawFrame') frames.push(1);
      });
      page.listeners.set('Tracing.tracingComplete', () => done());
      page.onClose = () => done();
      await page.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['disabled-by-default-devtools.timeline.frame'] } });
      const metrics = async () => Object.fromEntries(((await page.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] }).metrics.map((metric) => [metric.name, metric.value]));
      const before = await processes();
      const mainBefore = (await metrics())['ThreadTime']!;
      const start = performance.now();
      await Bun.sleep(SECONDS * 1000);
      const seconds = (performance.now() - start) / 1000;
      const after = await processes();
      const mainAfter = (await metrics())['ThreadTime']!;
      await page.send('Tracing.end');
      const late = setTimeout(() => done(), 30_000);
      await complete;
      clearTimeout(late);
      if (frames.length === 0) throw new Error('the trace came back without a frame');
      // CPU seconds per wall second, in thousandths of a core.
      // Only processes alive at both ends: the last page's renderer can exit inside the window.
      const share = (type: string) => after.filter((entry) => entry.type === type).reduce((sum, entry) => {
        const was = before.find((old) => old.id === entry.id);
        return was ? sum + entry.cpuTime - was.cpuTime : sum;
      }, 0) / seconds * 1000;
      return { renderer: share('renderer'), gpu: share('GPU'), browser: share('browser'), main: (mainAfter - mainBefore) / seconds * 1000, frames: frames.length, fps: frames.length / seconds };
    };

    console.log(`# ui-at-rest, ${WORKING} working threads, ${SECONDS} s windows, ${new Date().toISOString().slice(0, 10)}, ${compositing}`);
    console.log('scenario | renderer ms/s | GPU ms/s | browser ms/s | renderer main ms/s | frames/s');
    for (const [name, scenario] of Object.entries(scenarios)) {
      if (ONLY && !ONLY.includes(name)) continue;
      for (let run = 0; run < RUNS; run++) {
        try {
          await open(scenario.query, scenario.size.width, scenario.size.height, scenario.size.mobile);
          if (scenario.stream) await stream();
          if (scenario.list) { await page.evaluate(`document.querySelector('[data-testid=mobile-back]')?.click()`); await Bun.sleep(600); }
          await focus(scenario.focused);
          const hasFocus = await page.evaluate<boolean>('document.hasFocus()');
          if (hasFocus !== scenario.focused) throw new Error(`document.hasFocus() is ${hasFocus}, wanted ${scenario.focused}`);
          if (CSS) await page.send('Runtime.callFunctionOn', {
            objectId: ((await page.send('Runtime.evaluate', { expression: 'globalThis' })) as { result: { objectId: string } }).result.objectId,
            functionDeclaration: `function (css) { const style = document.createElement('style'); style.textContent = css; document.head.append(style); }`,
            arguments: [{ value: CSS }],
          });
          await Bun.sleep(1000);
          if (PROFILE) { await page.send('Profiler.enable'); await page.send('Profiler.setSamplingInterval', { interval: 200 }); await page.send('Profiler.start'); }
          const written = () => page.evaluate<number>(`[...document.querySelectorAll('[data-testid=message]')].at(-1)?.textContent.length ?? 0`);
          const from = await written();
          const cost = await measure();
          const grew = (await written()) - from;
          if (SHOTS) await Bun.write(join(SHOTS, `${name.replaceAll(' ', '-')}-${run + 1}.png`), Buffer.from(((await page.send('Page.captureScreenshot', { format: 'png' })) as { data: string }).data, 'base64'));
          if (PROFILE) { const { profile: cpu } = await page.send('Profiler.stop') as { profile: unknown }; await Bun.write(join(PROFILE, `${name.replaceAll(/[ ,]+/g, '-')}.cpuprofile`), JSON.stringify(cpu)); }
          const live = scenario.stream ? await page.evaluate<boolean>(`!!document.querySelector('.prose.live')`) : null;
          console.log(`${name} | ${cost.renderer.toFixed(0)} | ${cost.gpu.toFixed(0)} | ${cost.browser.toFixed(0)} | ${cost.main.toFixed(0)} | ${cost.fps.toFixed(1)}${scenario.stream ? `, ${grew} characters streamed${live ? '' : ', the answer ended inside the window'}` : ''}`);
        } catch (error) {
          console.log(`${name} | failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  } finally {
    for (const session of sessions) session.close();
    chrome.kill();
    await chrome.exited;
    server.stop(true);
    // Chrome's helpers can still hold the profile a moment after it exits.
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    if (own) rmSync(bundle, { recursive: true, force: true });
  }
}

await main();
