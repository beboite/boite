/** Measure click-to-painted messages, including a return to an older reading position.
 * Run: bun bench/thread-switch.ts [--delay 300] [--runs 7] [--cpu 4] [--phone] [--ui <checkout>/packages/ui]
 * The optimized fixture bundle uses the real UI and its in-memory transport.
 * Only thread RPC replies are delayed; painting must not wait for them on a cached visit.
 */
import { BrowserPage, freePort } from '../tests/e2e/lib/cdp';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const option = (name: string, fallback: number) => Number(args[args.indexOf(`--${name}`) + 1] ?? fallback);
const delay = args.includes('--delay') ? option('delay', 300) : 300;
const runs = args.includes('--runs') ? option('runs', 7) : 7;
const cpu = args.includes('--cpu') ? option('cpu', 1) : 1;
const phone = args.includes('--phone');
const port = await freePort();
const ui = resolve(args.includes('--ui') ? args[args.indexOf('--ui') + 1]! : join(import.meta.dir, '../packages/ui'));
const wire = { alias: { '@boite/contracts': join(ui, '../contracts/src/index.ts') } };
const { build, preview } = await import(createRequire(join(ui, 'package.json')).resolve('vite'));
const config = (await import(join(ui, 'vite.config.ts'))).default;
const bundle = mkdtempSync(join(tmpdir(), 'boite-switch-bench-'));
const bridge = { name: 'thread-switch-bench', transform(code: string, id: string) {
  if (id.replaceAll('\\', '/') !== join(ui, 'src/main.ts').replaceAll('\\', '/')) return;
  return `${code}\nimport { workspace } from './lib/workspace.svelte.ts';\nglobalThis.__boiteTest = { workspace };`;
} };
let server: { close(): Promise<void> } | undefined;
let page: BrowserPage | undefined;
try {
  // Import the checkout's config once: Bun cannot reimport Vite's deleted
  // temporary config module when build() and preview() share a process.
  await build({ ...config, configFile: false, root: ui, resolve: wire, plugins: [...config.plugins, bridge], define: { 'import.meta.env.DEV': 'true' }, build: { ...config.build, outDir: bundle, emptyOutDir: true }, logLevel: 'warn' });
  server = await preview({ ...config, configFile: false, root: ui, build: { ...config.build, outDir: bundle }, preview: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&long=1`, windowSize: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  const renderer = await page.evaluate<string | null>(`(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null;
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer;
  })()`);
  if ((process.env.CI !== 'true' && !renderer) || /swiftshader|llvmpipe|softpipe/i.test(renderer ?? '')) throw new Error(`Expected native browser rendering, received ${renderer}`);
  await page.waitFor('globalThis.__boiteTest?.workspace.active.connection === "ready"');
  await page.evaluate(`__boiteTest.workspace.active.open('t-bench')`);
  await page.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await page.evaluate(`(async () => {
    const store = __boiteTest.workspace.active;
    const call = store.client.call.bind(store.client);
    globalThis.switchBench = { store, asked: [], pending: Promise.resolve() };
    store.client.call = async (method, params) => {
      if (method.startsWith('threads.') || method === 'permissions.list' || method === 'questions.list') {
        switchBench.asked.push({ method, ...params });
        await new Promise(resolve => setTimeout(resolve, ${delay}));
      }
      return call(method, params);
    };
    switchBench.frame = () => new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
    switchBench.measure = async (target) => {
      switchBench.asked = [];
      const started = performance.now();
      switchBench.pending = store.open(target);
      const deadline = started + 15000;
      while (store.openThread?.id !== target || !document.querySelector('[data-mid="' + store.openThread.messages.at(-1)?.id + '"]')) {
        if (performance.now() > deadline) throw new Error('thread never rendered: ' + target);
        await switchBench.frame();
      }
      await switchBench.frame();
      return { paintMs: performance.now() - started, rendered: document.querySelectorAll('[data-mid]').length, after: switchBench.asked.find(call => call.method === 'threads.get')?.after ?? null };
    };
  })()`);
  const results: Record<string, unknown> = { date: new Date().toISOString(), delayMs: delay, cpu, phone, renderer };
  results.cold = await page.evaluate(`switchBench.measure('t-long')`);
  await page.evaluate('switchBench.pending');
  await page.evaluate(`(async () => { while (switchBench.store.messagesBefore !== null) await switchBench.store.loadOlder(); await switchBench.frame(); })()`);
  const samples = [];
  for (let i = 0; i < runs; i++) {
    await page.evaluate(`switchBench.store.open('t-bench')`);
    samples.push(await page.evaluate(`switchBench.measure('t-long')`));
    await page.evaluate('switchBench.pending');
  }
  results.warm = samples;
  // Scroll and leave in the same task, the navigation that used to lose the anchor.
  const reading = await page.evaluate(`(async () => {
    const box = document.querySelector('[data-testid="timeline"]');
    box.dispatchEvent(new WheelEvent('wheel', { deltaY: -800 }));
    box.scrollTop = box.scrollHeight / 2;
    box.dispatchEvent(new Event('scroll'));
    await switchBench.frame(); await switchBench.frame();
    const top = box.getBoundingClientRect().top;
    const node = [...box.querySelectorAll('[data-mid]')].find(node => node.getBoundingClientRect().bottom > top);
    const anchor = { id: node.dataset.mid, offset: node.getBoundingClientRect().top - top };
    await switchBench.store.open('t-bench');
    const started = performance.now();
    switchBench.pending = switchBench.store.open('t-long');
    while (!document.querySelector('[data-mid="' + anchor.id + '"]')) {
      if (performance.now() - started > 15000) throw new Error('reading anchor never rendered: ' + anchor.id);
      await switchBench.frame();
    }
    await switchBench.frame();
    const paintMs = performance.now() - started;
    await switchBench.pending;
    await switchBench.frame(); await switchBench.frame();
    const restored = document.querySelector('[data-mid="' + anchor.id + '"]');
    return { paintMs, anchor: anchor.id, driftPx: restored.getBoundingClientRect().top - document.querySelector('[data-testid="timeline"]').getBoundingClientRect().top - anchor.offset };
  })()`);
  results.reading = reading;
  results.errors = page.errors();
  console.log(JSON.stringify(results, null, 2));
} finally {
  await page?.close();
  await server?.close();
  rmSync(bundle, { recursive: true, force: true });
}
