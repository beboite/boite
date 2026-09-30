/**
 * Frame rate and main-thread cost of the UI on the in-memory fake client, in
 * headless Chrome with software compositing only: no GPU and no SwiftShader,
 * the worst case a WebView2 without acceleration meets, where a cost that a
 * GPU hides shows. docs/performance.md, "What a frame costs".
 *
 * Run: bun bench/ui-frames.ts [--cpu 4] [--size 1920x1080@1.5] [--runs 2]
 *        [--only "palette over stream,long thread scroll"] [--noblur]
 *        [--ui <other checkout>/packages/ui] [--bundle <dir>] [--browser <chrome>]
 *        [--trace] [--profile <dir>]
 *
 * Without --bundle it builds the UI once, in a child process and into a
 * temporary directory (`--build <dir>` alone builds and exits), from this
 * checkout or from the `packages/ui` that --ui names, to compare two. `--noblur`
 * also measures every scenario with backdrop filters switched off, which is
 * how a blur's own share of a frame is told apart.
 *
 * The typing scenarios press a key every 40 ms in the composer and report each
 * key's latency, from its keydown to the task after the next frame. `--trace`
 * adds the layouts each window ran and how many a script forced, counts that
 * hold whatever else the machine runs; `BENCH_FORCED=1` names the scripts and
 * `BENCH_INVALIDATIONS=1` what invalidated layout and style. `--profile` writes
 * a CPU profile per scenario; `BENCH_MINIFY=0` keeps the function names.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION } from '../packages/ui/src/lib/onboarding.ts';
import { findBrowser, freePort } from '../tests/e2e/lib/cdp.ts';

const argv = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`);
  return at < 0 ? undefined : argv[at + 1];
};
const CPU = Number(option('cpu') ?? 1);
const RUNS = Number(option('runs') ?? 1);
/** `--profile <dir>` writes a CPU profile of each measured window there, one per scenario. */
const PROFILE = option('profile');
/** `--trace` prints the main thread's time by trace event for each measured window. */
const TRACE = argv.includes('--trace');
let current = '';
const ONLY = option('only')?.split(',').map((name) => name.trim());
const size = /^(\d+)x(\d+)(?:@([\d.]+))?$/.exec(option('size') ?? '1280x890@1');
if (!size) throw new Error('--size must read <width>x<height>[@<device pixel ratio>]');
const W = Number(size[1]), H = Number(size[2]), DPR = Number(size[3] ?? 1);
const VARIANTS: Record<string, string> = argv.includes('--noblur')
  ? { base: '', noblur: '*, *::before, *::after { backdrop-filter: none !important; }' }
  : { base: '' };

const UI = resolve(option('ui') ?? join(import.meta.dir, '../packages/ui'));

/** The fake-client build, with the store and the fake client reachable from the page. */
async function buildBundle(outDir: string): Promise<void> {
  const { build } = await import(createRequire(join(UI, 'package.json')).resolve('vite'));
  const bridge = {
    name: 'bench-ui-frames-bridge',
    transform(code: string, id: string) {
      if (id.replaceAll('\\', '/') !== join(UI, 'src/main.ts').replaceAll('\\', '/')) return;
      return `${code}\nimport { store as __store } from './lib/store.svelte.ts';\nglobalThis.__bench = { store: __store };\n`;
    },
  };
  await build({ root: UI, plugins: [bridge], define: { 'import.meta.env.DEV': 'true' }, build: { outDir, emptyOutDir: true, ...(process.env.BENCH_MINIFY === '0' ? { minify: false } : {}) }, logLevel: 'warn' });
}

type Metrics = { name: string; value: number }[];
/** What `--trace` reads from Chrome's trace events. */
interface TraceEvent {
  name: string; ph: string; ts: number; dur?: number; tid: number; pid: number;
  args?: { name?: string; beginData?: { stackTrace?: { functionName: string }[] }; data?: { reason?: string; nodeName?: string } };
}
interface Measure { fps: number; p95: number; worst: number; longTasks: number; longMs: number; mainMs: number; scriptMs: number; layoutMs: number; styleMs: number; scrolled: number; keys: number[] }

class Page {
  #id = 0;
  #pending = new Map<number, (value: Record<string, unknown>) => void>();
  readonly events = new Map<string, (params: Record<string, unknown>) => void>();
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', (event) => {
      const message: unknown = JSON.parse(String(event.data));
      if (typeof message !== 'object' || message === null) return;
      const { id, result, method, params } = message as { id?: unknown; result?: Record<string, unknown>; method?: string; params?: Record<string, unknown> };
      if (method) this.events.get(method)?.(params ?? {});
      if (typeof id !== 'number') return;
      const settle = this.#pending.get(id);
      if (typeof settle !== 'function') return;
      this.#pending.delete(id);
      settle(result ?? (message as Record<string, unknown>));
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = ++this.#id;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveCall, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error(`${method} got no answer in 30 s`)); }, 30_000);
      this.#pending.set(id, (value) => { clearTimeout(timer); resolveCall(value); });
    });
  }
  async evaluate<T>(expression: string): Promise<T> {
    const answer = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }) as { result?: { value?: T }; exceptionDetails?: unknown };
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails).slice(0, 400));
    return answer.result?.value as T;
  }
  /** Runs a function in the page with its arguments passed as values, never spliced into code. */
  async call(functionDeclaration: string, ...args: unknown[]): Promise<void> {
    const global = await this.send('Runtime.evaluate', { expression: 'globalThis' }) as { result?: { objectId?: string } };
    const answer = await this.send('Runtime.callFunctionOn', {
      objectId: global.result?.objectId, functionDeclaration, arguments: args.map((value) => ({ value })), awaitPromise: true, returnByValue: true,
    }) as { exceptionDetails?: unknown };
    if (answer.exceptionDetails) throw new Error(JSON.stringify(answer.exceptionDetails).slice(0, 400));
  }
  async waitFor(expression: string, ms = 30_000): Promise<void> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await this.evaluate<boolean>(`!!(${expression})`)) return;
      await Bun.sleep(100);
    }
    throw new Error(`timed out waiting for ${expression}`);
  }
  async metrics(): Promise<Record<string, number>> {
    const { metrics } = await this.send('Performance.getMetrics') as { metrics: Metrics };
    return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]));
  }
}

const SCROLLER = `(() => { let best = null; for (const el of document.querySelectorAll('*')) { const s = getComputedStyle(el); if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 200 && (!best || el.scrollHeight > best.scrollHeight)) best = el; } return best; })()`;
/**
 * The fake agent reasons over the whole prompt, then echoes it back sixteen
 * characters a delta, and a streaming answer shows whole paragraphs: short
 * paragraphs keep text arriving on screen through the measured window.
 */
const PROMPT = 'Streaming bench paragraph with enough words to wrap across the column.\n\n'.repeat(60);
const SETUP = `
  window.__long = [];
  // Each key's latency: from the keydown's own timestamp to the task after the
  // next frame, which is when what the key changed has been painted.
  window.__keys = [];
  document.addEventListener('keydown', (event) => {
    const start = event.timeStamp;
    requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = () => window.__keys.push(performance.now() - start); channel.port2.postMessage(0); });
  }, true);
  try { new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
  try { if (location.search.includes('tour=1')) localStorage.removeItem(${JSON.stringify(ONBOARDING_STORAGE_KEY)}); else localStorage.setItem(${JSON.stringify(ONBOARDING_STORAGE_KEY)}, ${JSON.stringify(JSON.stringify({ version: ONBOARDING_VERSION, at: 0 }))}); } catch {}
`;

async function main(): Promise<void> {
  const own = option('bundle') === undefined;
  const bundle = option('bundle') ?? mkdtempSync(join(tmpdir(), 'boite-ui-frames-'));
  if (own) {
    // The build runs in a process of its own: Vite keeps over a gigabyte this
    // one would otherwise carry through every measurement.
    const ui = option('ui');
    const builder = Bun.spawn({ cmd: [process.execPath, import.meta.path, '--build', bundle, ...(ui === undefined ? [] : ['--ui', ui])], stdout: 'inherit', stderr: 'inherit' });
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
  const profile = mkdtempSync(join(tmpdir(), 'boite-ui-frames-profile-'));
  const chrome = Bun.spawn({
    cmd: [option('browser') ?? findBrowser(), '--headless=new', '--disable-gpu', '--disable-software-rasterizer', '--disable-3d-apis', '--mute-audio',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--lang=en-US',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', '--remote-allow-origins=*',
      `--window-size=${W},${H}`, `--user-data-dir=${profile}`, `--remote-debugging-port=${debugPort}`, 'about:blank'],
    stdout: 'ignore', stderr: 'ignore', windowsHide: true,
  });
  let socket: WebSocket | undefined;
  try {
    let target: { type: string; webSocketDebuggerUrl: string } | undefined;
    for (let attempt = 0; attempt < 100 && !target; attempt++) {
      try { target = ((await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()) as { type: string; webSocketDebuggerUrl: string }[]).find((entry) => entry.type === 'page'); } catch { /* not up yet */ }
      if (!target) await Bun.sleep(100);
    }
    if (!target) throw new Error('Chrome opened no page');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((ready) => socket!.addEventListener('open', ready));
    const page = new Page(socket);
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Performance.enable', { timeDomain: 'timeTicks' });
    await page.send('Page.addScriptToEvaluateOnNewDocument', { source: SETUP });
    if (CPU > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: CPU });

    const open = async (query: string, width = W, height = H, mobile = false): Promise<void> => {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : DPR, mobile });
      // Each scenario starts on empty storage: a draft journal one scenario
      // wrote, an image included, would otherwise be restored into the next.
      await page.send('Storage.clearDataForOrigin', { origin: `http://127.0.0.1:${uiPort}`, storageTypes: 'local_storage,indexeddb' });
      await page.send('Page.navigate', { url: `http://127.0.0.1:${uiPort}/?fake=1&${query}` });
      await Bun.sleep(300);
      await page.waitFor(`document.readyState === 'complete' && globalThis.__bench?.store?.booted`);
      await Bun.sleep(800);
    };
    const stream = async (): Promise<void> => {
      // The recent thread of the fake may already run a turn, which would only queue this prompt.
      await page.evaluate(`(async () => { const s = globalThis.__bench.store; if (s.busy) await s.open('t-trace'); })()`);
      await page.waitFor(`document.querySelector('[data-testid=composer-input]') && !globalThis.__bench.store.busy`);
      await page.call(`function (text) { const input = document.querySelector('[data-testid=composer-input]'); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); }`, PROMPT);
      await Bun.sleep(100);
      await page.evaluate(`document.querySelector('[data-testid=composer-send]').click()`);
      // Measured once the answer itself is on screen, past the folded reasoning.
      await page.waitFor(`document.querySelectorAll('.prose.live .paragraph').length >= 2`);
    };
    // A wheel up the conversation through the compositor at 2400 px/s, not awaited.
    const wheel = (width = W, height = H): void => {
      void page.send('Input.synthesizeScrollGesture', { x: Math.round(width * 0.55), y: Math.round(height * 0.4), yDistance: 9000, speed: 2400, gestureSourceType: 'mouse' }).catch(() => {});
    };
    // Typing into the composer at 25 keys a second, a fast typist, not awaited:
    // each key goes through the renderer as a real keydown, keypress and input.
    let typing = 0;
    const type = (seconds = 3.6): void => {
      const run = ++typing;
      const words = 'the quick brown fox jumps over the lazy dog while the agent writes back ';
      void (async () => {
        const end = Date.now() + seconds * 1000;
        for (let index = 0; Date.now() < end && run === typing; index += 1) {
          const key = words[index % words.length]!;
          const code = key === ' ' ? 'Space' : `Key${key.toUpperCase()}`;
          await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, text: key, unmodifiedText: key }).catch(() => {});
          await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code }).catch(() => {});
          await Bun.sleep(40);
        }
      })();
    };
    const focusComposer = async (draft = ''): Promise<void> => {
      await page.waitFor(`document.querySelector('[data-testid=composer-input]')`);
      await page.call(`function (text) { const input = document.querySelector('[data-testid=composer-input]'); input.focus(); if (text) { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); } input.setSelectionRange(input.value.length, input.value.length); }`, draft);
      await Bun.sleep(300);
    };
    /** A pasted screenshot's worth of base64 on the draft, what every save of it carries. */
    const attachImage = async (): Promise<void> => {
      await page.evaluate(`(() => { const s = globalThis.__bench.store; const key = s.openThread?.id ?? 'draft'; const state = s.composerStates[key]; state.attachments = [{ kind: 'image', mimeType: 'image/png', name: 'bench.png', data: 'iVBORw0KGgo'.repeat(140000) }]; })()`);
      await Bun.sleep(300);
    };
    const activity = `(() => { const t = globalThis.__bench.store.openThread; t.activity = { goal: { objective: 'Verify the bench', status: 'running', iterations: 1, error: null }, loop: null, tasks: Array.from({ length: 12 }, (_, i) => ({ id: 't' + i, text: 'Bench task number ' + i + ' with a line long enough to wrap', status: i < 4 ? 'completed' : i === 4 ? 'in_progress' : 'pending' })) }; })()`;
    const openActivity = async (): Promise<void> => {
      await page.evaluate(activity);
      await page.waitFor(`document.querySelector('[data-testid=activity-tasks-toggle]')`);
      await page.evaluate(`document.querySelector('[data-testid=activity-tasks-toggle]').click()`);
      await Bun.sleep(400);
    };
    const scenarios: Record<string, () => Promise<void>> = {
      'idle thread': () => open('open=recent'),
      'streaming answer': async () => { await open('open=recent&stream=tokens'); await stream(); },
      'palette over stream': async () => {
        await open('open=recent&stream=tokens'); await stream();
        await page.evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', ctrlKey: true, bubbles: true, cancelable: true }))`);
        await Bun.sleep(300);
      },
      'activity panel over stream': async () => { await open('open=recent&stream=tokens'); await stream(); await openActivity(); },
      'long thread scroll': async () => { await open('open=recent&long=1'); wheel(); },
      'scroll while streaming': async () => { await open('open=recent&stream=tokens&long=1'); await stream(); wheel(); },
      'scroll under activity': async () => { await open('open=recent&stream=tokens&long=1'); await stream(); await openActivity(); wheel(); },
      'onboarding tour': async () => {
        await page.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: DPR, mobile: false });
        await page.send('Page.navigate', { url: `http://127.0.0.1:${uiPort}/?fake=1&open=recent&tour=1` });
        await page.waitFor(`document.querySelector('[data-testid=onboarding-step]')?.dataset.step === 'welcome'`);
        await Bun.sleep(500);
        await page.evaluate(`document.querySelector('[data-testid=onboarding-animation-replay]')?.click()`);
      },
      'phone streaming': async () => { await open('open=recent&stream=tokens', 390, 844, true); await stream(); },
      'phone long scroll': async () => { await open('open=recent&long=1', 390, 844, true); wheel(390, 844); },
      'typing': async () => { await open('open=recent'); await focusComposer(); type(); },
      'typing in a long draft': async () => { await open('open=recent'); await focusComposer(PROMPT.repeat(2)); type(); },
      'typing with an image': async () => { await open('open=recent'); await focusComposer(); await attachImage(); type(); },
      'typing while streaming': async () => { await open('open=recent&stream=tokens&long=1'); await stream(); await focusComposer(); type(); },
      'phone typing': async () => { await open('open=recent', 390, 844, true); await focusComposer(); type(); },
    };

    const measure = async (): Promise<Measure> => {
      await page.evaluate(`(() => { window.__sc = ${SCROLLER}; window.__sc0 = window.__sc ? window.__sc.scrollTop : 0; window.__keys0 = window.__keys.length; })()`);
      const traced: TraceEvent[] = [];
      let traceDone: Promise<void> | undefined;
      if (TRACE) {
        page.events.set('Tracing.dataCollected', (params) => { traced.push(...(params['value'] as TraceEvent[])); });
        traceDone = new Promise((done) => page.events.set('Tracing.tracingComplete', () => done()));
        await page.send('Tracing.start', { transferMode: 'ReportEvents', traceConfig: { includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.stack', ...(process.env.BENCH_INVALIDATIONS ? ['disabled-by-default-devtools.timeline.invalidationTracking'] : []), 'blink', 'cc', 'v8.execute'] } });
      }
      if (PROFILE) { await page.send('Profiler.enable'); await page.send('Profiler.setSamplingInterval', { interval: 200 }); await page.send('Profiler.start'); }
      const before = await page.metrics();
      const run = await page.evaluate<{ times: number[]; long: number[] }>(`new Promise((done) => {
        const times = [];
        const from = window.__long.length;
        const start = performance.now();
        function frame(now) { times.push(now); if (now - start < 3000) requestAnimationFrame(frame); else done({ times, long: window.__long.slice(from) }); }
        requestAnimationFrame(frame);
      })`);
      const after = await page.metrics();
      const scrolled = await page.evaluate<number>(`window.__sc ? Math.round(Math.abs(window.__sc.scrollTop - window.__sc0)) : 0`);
      const keys = await page.evaluate<number[]>(`window.__keys.slice(window.__keys0)`);
      if (TRACE) {
        await page.send('Tracing.end');
        await traceDone;
        // Main-thread time by event name, each event's own duration minus its children's.
        const main = traced.find((event) => event.name === 'thread_name' && event.args?.name === 'CrRendererMain');
        const onMain = (event: TraceEvent) => main !== undefined && event.pid === main.pid && event.tid === main.tid && event.ph === 'X';
        const own = traced.filter((event) => onMain(event) && typeof event.dur === 'number');
        own.sort((a, b) => a.ts - b.ts || b.dur! - a.dur!);
        const stack: { end: number; name: string; child: number; dur: number }[] = [];
        const selfBy = new Map<string, number>();
        const close = (upTo: number) => { while (stack.length && stack.at(-1)!.end <= upTo) { const done = stack.pop()!; selfBy.set(done.name, (selfBy.get(done.name) ?? 0) + done.dur - done.child); if (stack.length) stack.at(-1)!.child += done.dur; } };
        for (const event of own) { close(event.ts); stack.push({ end: event.ts + event.dur!, name: event.name, child: 0, dur: event.dur! }); }
        close(Infinity);
        const top = [...selfBy].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([name, us]) => `${name} ${(us / 1000).toFixed(0)}`).join(', ');
        // Layouts counted, and those a script forced: the counts hold whatever else the machine runs.
        const layouts = traced.filter((event) => onMain(event) && event.name === 'Layout');
        const forcedLayouts = layouts.filter((event) => event.args?.beginData?.stackTrace);
        const forced = forcedLayouts.length;
        if (process.env.BENCH_INVALIDATIONS) {
          const by = new Map<string, number>();
          for (const event of traced) {
            if (event.name !== 'LayoutInvalidationTracking' && event.name !== 'StyleRecalcInvalidationTracking' && event.name !== 'ScheduleStyleInvalidationTracking') continue;
            const key = `${event.name.replace('InvalidationTracking', '')}: ${event.args?.data?.reason ?? '?'} @ ${(event.args?.data?.nodeName ?? '?').slice(0, 60)}`;
            by.set(key, (by.get(key) ?? 0) + 1);
          }
          for (const [key, n] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 14)) console.log(`    ${n}x ${key}`);
        }
        if (process.env.BENCH_FORCED) {
          const by = new Map<string, [number, number]>();
          for (const event of forcedLayouts) { const name = (event.args?.beginData?.stackTrace ?? []).slice(0, 3).map((frame) => frame.functionName || '(anon)').join(' < '); const [n, ms] = by.get(name) ?? [0, 0]; by.set(name, [n + 1, ms + (event.dur ?? 0) / 1000]); }
          for (const [name, [n, ms]] of [...by].sort((a, b) => b[1][1] - a[1][1]).slice(0, 8)) console.log(`    forced ${n}x ${ms.toFixed(0)} ms: ${name}`);
        }
        console.log(`  trace ${current}: layouts ${layouts.length}, forced by script ${forced}, keys ${keys.length}; ${top}`);
      }
      if (PROFILE) { const { profile } = await page.send('Profiler.stop') as { profile: unknown }; await Bun.write(join(PROFILE, `${current.replaceAll(' ', '-')}.cpuprofile`), JSON.stringify(profile)); }
      // The typist stops with the measured window.
      typing += 1;
      const gaps = run.times.slice(1).map((time, index) => time - run.times[index]!).sort((a, b) => a - b);
      const seconds = (run.times.at(-1)! - run.times[0]!) / 1000;
      return {
        fps: (run.times.length - 1) / seconds,
        p95: gaps[Math.floor(gaps.length * 0.95)] ?? 0,
        worst: gaps.at(-1) ?? 0,
        longTasks: run.long.length,
        longMs: run.long.reduce((sum, duration) => sum + duration, 0),
        mainMs: ((after['TaskDuration']! - before['TaskDuration']!) * 1000) / seconds,
        scriptMs: ((after['ScriptDuration']! - before['ScriptDuration']!) * 1000) / seconds,
        layoutMs: ((after['LayoutDuration']! - before['LayoutDuration']!) * 1000) / seconds,
        styleMs: ((after['RecalcStyleDuration']! - before['RecalcStyleDuration']!) * 1000) / seconds,
        scrolled,
        keys: keys.sort((a, b) => a - b),
      };
    };

    console.log(`# ${W}x${H}@${DPR}, CPU x${CPU}, ${new Date().toISOString().slice(0, 10)}, software compositing`);
    console.log('scenario | variant | fps | p95 ms | worst ms | long tasks | main ms/s (script, layout, style) | main ms per 1000 px | keys: count, median, p95, worst ms');
    for (const [name, setup] of Object.entries(scenarios)) {
      if (ONLY && !ONLY.includes(name)) continue;
      for (let run = 0; run < RUNS; run++) {
        for (const [variant, css] of Object.entries(VARIANTS)) {
          try {
            current = `${name}-${variant}`;
            await setup();
            await page.call(`function (css) { let s = document.getElementById('bench-variant'); if (!s) { s = document.createElement('style'); s.id = 'bench-variant'; document.head.append(s); } s.textContent = css; }`, css);
            const m = await measure();
            // Only a wheel's distance: a list following its answer, or a draft scrolling to its caret, is no scroll cost.
            const perPixel = name.includes('scroll') && m.scrolled > 0 ? ((m.mainMs * 3) / m.scrolled * 1000).toFixed(0) : '-';
            const at = (share: number) => (m.keys[Math.min(m.keys.length - 1, Math.floor(m.keys.length * share))] ?? 0).toFixed(1);
            const keys = m.keys.length ? `${m.keys.length}, ${at(0.5)}, ${at(0.95)}, ${at(1)}` : '-';
            console.log(`${name} | ${variant} | ${m.fps.toFixed(1)} | ${m.p95.toFixed(0)} | ${m.worst.toFixed(0)} | ${m.longTasks} (${m.longMs.toFixed(0)} ms) | ${m.mainMs.toFixed(0)} (${m.scriptMs.toFixed(0)}, ${m.layoutMs.toFixed(0)}, ${m.styleMs.toFixed(0)}) | ${perPixel} | ${keys}`);
          } catch (error) {
            console.log(`${name} | ${variant} | failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
  } finally {
    socket?.close();
    chrome.kill();
    await chrome.exited;
    server.stop(true);
    rmSync(profile, { recursive: true, force: true });
    if (own) rmSync(bundle, { recursive: true, force: true });
  }
}

const buildOnly = option('build');
if (buildOnly !== undefined) await buildBundle(buildOnly);
else await main();
