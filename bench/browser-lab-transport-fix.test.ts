import { expect, test } from 'bun:test';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserDaemon } from '../packages/core/src/browser/daemon.ts';
import { BrowserLabNativeTransport, createBrowserLabEngine } from './browser-lab-engine.ts';
import { connectIndependentNativeTransport, createBrowserLabEngineTransportFix } from './browser-lab-transport-fix.ts';

async function fixture(pathEndpoint = false) {
  const accepted = new Set<Socket>();
  const server = createServer(socket => {
    accepted.add(socket); socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const command = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        const data = command.action === 'snapshot' ? { snapshot: 'x'.repeat(1_100_000) } : { result: 'next command works' };
        socket.write(JSON.stringify({ id: command.id, success: true, data }) + '\n');
      }
    });
  });
  const path = process.platform === 'win32' ? `\\\\.\\pipe\\boite-native-${crypto.randomUUID()}` : join(tmpdir(), `boite-native-${crypto.randomUUID()}.sock`);
  await new Promise<void>(resolve => pathEndpoint ? server.listen(path, resolve) : server.listen(0, '127.0.0.1', resolve));
  const endpoint = pathEndpoint ? { path } : { host: '127.0.0.1', port: (server.address() as { port: number }).port };
  const socket = connect(endpoint); socket.setEncoding('utf8');
  await new Promise<void>(resolve => socket.once('connect', resolve));
  // Use the actual production receiver, not a duplicate of its 1 MB check.
  const daemon = new (BrowserDaemon as any)(async () => {}, new AbortController().signal);
  daemon.endpoint = endpoint;
  daemon.socket = socket;
  socket.on('data', chunk => daemon.receive(chunk));
  return { daemon, socket, close: async () => {
    socket.destroy(); for (const client of accepted) client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}

test('borrowed daemon socket reproduces production receiver closing a reply above 1 MB', async () => {
  const f = await fixture(), native = new BrowserLabNativeTransport(f.socket, 1000);
  try {
    await native.command('snapshot').catch(() => {});
    expect(f.socket.destroyed).toBe(true);
    await expect(native.command('evaluate')).rejects.toThrow('connection closed');
  } finally { native.dispose(); await f.close(); }
});

for (const pathEndpoint of [false, true]) test(`independent native connection uses owned ${pathEndpoint ? 'path' : 'TCP'} endpoint and survives a large reply`, async () => {
  const f = await fixture(pathEndpoint);
  let native: Awaited<ReturnType<typeof connectIndependentNativeTransport>> | undefined;
  try {
    native = await connectIndependentNativeTransport(f.daemon, 1000);
    expect((await native.command('snapshot')).snapshot).toHaveLength(1_100_000);
    expect(await native.command('evaluate')).toEqual({ result: 'next command works' });
    expect(f.socket.destroyed).toBe(false);
  } finally { native?.dispose(); await f.close(); }
});

test('compatibility factory is the corrected default factory', () => {
  expect(createBrowserLabEngineTransportFix).toBe(createBrowserLabEngine);
});

test('daemon refuses independent clients without an endpoint or after close/abort', async () => {
  const controller = new AbortController();
  const daemon = new (BrowserDaemon as any)(async () => {}, controller.signal);
  expect(() => daemon.openClientSocket()).toThrow('endpoint');
  daemon.endpoint = { host: '127.0.0.1', port: 1 };
  controller.abort();
  expect(() => daemon.openClientSocket()).toThrow();
  const closed = new (BrowserDaemon as any)(async () => {}, new AbortController().signal);
  closed.endpoint = { host: '127.0.0.1', port: 1 };
  await closed.close();
  expect(() => closed.openClientSocket()).toThrow('closed');
});

const live = process.env.BOITE_BENCH_TRANSPORT_FIX === '1' ? test : test.skip;
live('native French Apollo 11 observation survives its large snapshot and cleans its owned group', async () => {
  const { startTestCore } = await import('../packages/core/test/harness.ts');
  const { findBrowser } = await import('../tests/e2e/lib/cdp.ts');
  const { LabPage } = await import('./browser-lab-page.ts');
  const { useDirectCapture } = await import('./browser-lab-capture.ts');
  const { mkdirSync, readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const output = process.env.BOITE_BENCH_ENGINE_OUTPUT, binary = process.env.BOITE_BROWSER_TEST_BINARY;
  if (!output || !binary) throw new Error('Expected output directory and native binary.');
  mkdirSync(output, { recursive: true });
  const harness = await startTestCore(), commands: unknown[] = [], summary: Record<string, any> = {};
  let engine: Awaited<ReturnType<typeof createBrowserLabEngineTransportFix>> | undefined;
  try {
    engine = await createBrowserLabEngine('agent-browser', { core: harness.core, taskId: 'transport-fix-smoke', binary, executablePath: findBrowser(), log: entry => commands.push(entry) });
    await engine.command('viewport', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await engine.command('navigate', { url: 'https://fr.wikipedia.org/wiki/Apollo_11' });
    const page = new LabPage(engine, { id: 'transport-fix', url: 'https://fr.wikipedia.org/wiki/Apollo_11', hosts: ['wikipedia.org'], goal: 'Observe the article.', rubric: ['', '', ''] }, false, output, performance.now() + 60_000);
    await page.observe();
    summary.snapshotReplyChars = JSON.stringify(page.history[0].snapshot).length;
    summary.observationErrors = page.history[0].errors;
    // Public article size varies while scripts hydrate. Exercise the native
    // protocol threshold deterministically as well as the real observation.
    const largeReply = await engine.command('evaluate', { script: '"x".repeat(1100000)' });
    summary.largeReplyChars = String(largeReply.result).length;
    summary.nextCommand = await engine.command('evaluate', { script: 'document.title' });
    summary.ownerSocketOpen = !(engine.daemon as any).socket.destroyed;
    expect(summary.snapshotReplyChars).toBeGreaterThan(800_000);
    expect(summary.largeReplyChars).toBe(1_100_000);
    expect(summary.observationErrors).toEqual([]);
    expect(summary.nextCommand.result).toContain('Apollo 11');
    expect(summary.ownerSocketOpen).toBe(true);
    // Deliberately invalid capture target verifies read-only fallback; no page
    // action is replayed and this is not a separate website success claim.
    const activeTargetId = engine.activeTargetId;
    try {
      await useDirectCapture(engine, entry => commands.push(entry));
      engine.activeTargetId = async () => '00000000000000000000000000000000';
      const capture = join(output, 'capture-fallback.png');
      await engine.command('screenshot', { path: capture });
      const png = readFileSync(capture);
      summary.captureFallback = engine.metadata.directCaptureFallback;
      summary.captureDimensions = [png.readUInt32BE(16), png.readUInt32BE(20)];
      expect(String(summary.captureFallback)).toContain('Capture CDP');
      expect(summary.captureDimensions).toEqual([1280, 800]);
    } finally { engine.activeTargetId = activeTargetId; }
  } finally {
    if (engine) { await engine.close(); summary.processesAfter = harness.core.procs.liveCount(engine.processGroup); }
    writeFileSync(join(output, 'commands.json'), JSON.stringify(commands, null, 2));
    writeFileSync(join(output, 'summary.json'), JSON.stringify(summary, null, 2));
    await harness.stop();
    console.log(JSON.stringify(summary));
    expect(summary.processesAfter).toBe(0);
  }
}, 90_000);
