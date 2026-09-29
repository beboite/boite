import { expect, test } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserLabEngine } from './browser-lab-engine.ts';
import { useDirectCapture } from './browser-lab-capture.ts';

test('a failed CDP attachment falls back to engine capture without replaying page actions', async () => {
  let attaches = 0, closed = false;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response('', { status: 400 }); },
    websocket: { message(socket, data) {
      const request = JSON.parse(String(data));
      if (request.method === 'Target.attachToTarget') attaches++;
      socket.send(JSON.stringify({ id: request.id, error: { message: 'Target attach failed' } }));
    } },
  });
  const calls: string[] = [], logs: any[] = [];
  const engine: any = { kind: 'agent-browser', cdpUrl: `ws://127.0.0.1:${server.port}`, metadata: {},
    activeTargetId: async () => 'current-target',
    command: async (action: string) => { calls.push(action); return { source: 'engine', action }; },
    close: async () => { closed = true; },
  };
  try {
    await useDirectCapture(engine, entry => logs.push(entry));
    expect(await engine.command('click', { selector: '@e1' })).toEqual({ source: 'engine', action: 'click' });
    expect(await engine.command('screenshot', { path: 'first.png' })).toEqual({ source: 'engine', action: 'screenshot' });
    expect(await engine.command('screenshot', { path: 'second.png' })).toEqual({ source: 'engine', action: 'screenshot' });
    expect(attaches).toBe(1);
    expect(calls).toEqual(['click', 'prepare_observation', 'screenshot', 'screenshot']);
    expect(engine.metadata.directCaptureFallback).toContain('Target attach failed');
    expect(logs.some(entry => entry.success === false)).toBe(true);
  } finally { await engine.close(); server.stop(true); }
  expect(closed).toBe(true);
});

const live = process.env.BOITE_BENCH_FAST_CAPTURE === '1' ? test : test.skip;
live('direct capture records rendered pixels while a page font remains pending', async () => {
  const { startTestCore } = await import('../packages/core/test/harness.ts');
  const { findBrowser } = await import('../tests/e2e/lib/cdp.ts');
  const binary = process.env.BOITE_BROWSER_TEST_BINARY, output = process.env.BOITE_BENCH_ENGINE_OUTPUT;
  if (!binary || !output) throw new Error('Browser binary and output directory required.');
  mkdirSync(output, { recursive: true });
  const font = Promise.withResolvers<Response>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: req => new URL(req.url).pathname === '/font.woff2' ? font.promise
    : new Response('<style>@font-face{font-family:pending;src:url(/font.woff2);font-display:swap}body{font-family:pending,Arial;background:white;color:black;font-size:40px}</style><h1>Rendered while font waits</h1>', { headers: { 'content-type': 'text/html' } }) });
  const harness = await startTestCore();
  let engine: Awaited<ReturnType<typeof createBrowserLabEngine>> | undefined;
  const summary: any = {};
  try {
    engine = await createBrowserLabEngine('playwright', { core: harness.core, taskId: 'direct-capture-probe', binary, executablePath: findBrowser() });
    await engine.command('viewport', { width: 1280, height: 800 });
    await engine.command('navigate', { url: `http://127.0.0.1:${server.port}`, waitUntil: 'domcontentloaded' });
    expect((await engine.command('evaluate', { script: 'document.fonts.status' })).result).toBe('loading');
    const standardStarted = performance.now();
    try { await engine.command('screenshot', { path: join(output, 'standard.png') }); }
    catch (error) { summary.standardError = String(error); }
    summary.standardMs = performance.now() - standardStarted;
    expect(summary.standardError).toContain('Timeout');
    await useDirectCapture(engine, () => {});
    const directStarted = performance.now();
    await engine.command('screenshot', { path: join(output, 'direct.png') });
    summary.directMs = performance.now() - directStarted;
    const png = readFileSync(join(output, 'direct.png'));
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1280, 800]);
    expect(png.length).toBeGreaterThan(1000);
    expect((await engine.command('evaluate', { script: '[innerWidth,innerHeight]' })).result).toEqual([1280, 800]);
    expect((await engine.command('evaluate', { script: 'document.fonts.status' })).result).toBe('loading');
    summary.pngBytes = png.length;
  } finally {
    font.resolve(new Response('', { status: 404 })); server.stop(true);
    try { await engine?.close(); }
    finally { summary.processesAfter = harness.core.procs.liveCount('browser:direct-capture-probe'); await harness.stop(); }
    writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary));
  }
  expect(summary.processesAfter).toBe(0);
}, 30000);
