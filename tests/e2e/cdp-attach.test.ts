import { createServer, type Socket } from 'node:net';
import { expect, test } from 'bun:test';
import { BrowserPage, freePort, probeDebuggingPort } from './lib/cdp.ts';

test.each(['ready', 'delayed', 'explicit-blank'] as const)('attach chooses the requested committed target (%s)', async mode => {
  let lists = 0;
  const attached: string[] = [];
  const server = Bun.serve<{ path: string }>({ hostname: '127.0.0.1', port: 0,
    fetch(request, self) {
      const path = new URL(request.url).pathname;
      if (path === '/json/list') {
        const targets = [{ type: 'page', url: 'about:blank', webSocketDebuggerUrl: `ws://127.0.0.1:${self.port}/blank` }];
        if (mode !== 'delayed' || lists++ > 0) targets.push({ type: 'page', url: 'http://tauri.localhost/', webSocketDebuggerUrl: `ws://127.0.0.1:${self.port}/app` });
        return Response.json(targets);
      }
      return self.upgrade(request, { data: { path } }) ? undefined : new Response('upgrade required');
    }, websocket: {
      open(socket) { attached.push(socket.data.path); },
      message(socket, raw) {
        const frame = JSON.parse(String(raw));
        socket.send(JSON.stringify({ id: frame.id, result: frame.method === 'Runtime.evaluate' ? { result: { value: false } } : {} }));
      },
    },
  });
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.attach(server.port!, mode === 'explicit-blank' ? 'about:blank' : '');
    expect(attached).toEqual([mode === 'explicit-blank' ? '/blank' : '/app']);
  } finally { await page?.close(); await server.stop(true); }
});

test('a devtools message that is not JSON fails the waiting call at once and every later one, naming it', async () => {
  // What Bun's WebSocket client handed over once it lost frame alignment: a
  // piece of a frame. Dropped in silence, the reply inside it never came and
  // the call waited out its 20 s like a page with a busy main thread.
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, self) {
      if (new URL(request.url).pathname === '/json/list') return Response.json([{ type: 'page', url: 'http://tauri.localhost/', webSocketDebuggerUrl: `ws://127.0.0.1:${self.port}/app` }]);
      return self.upgrade(request) ? undefined : new Response('upgrade required');
    }, websocket: {
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as { id: number; method: string; params?: { expression?: string } };
        if (frame.params?.expression === 'garbled') socket.send(`{"id":${frame.id},"result":{"res`);
        else socket.send(JSON.stringify({ id: frame.id, result: frame.method === 'Runtime.evaluate' ? { result: { value: false } } : {} }));
      },
    },
  });
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.attach(server.port!);
    const started = performance.now();
    const failure = await page.evaluate('garbled').then(() => 'answered', (error: unknown) => String(error));
    expect(failure).toContain('devtools sent a message that is not JSON (');
    expect(failure).toContain('{\\"res');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(await page.evaluate('1').then(() => 'answered', (error: unknown) => String(error))).toContain('not JSON');
  } finally { await page?.close(); await server.stop(true); }
}, 10_000);

test('the failure probe tells a closed port at once from one that accepts and never answers', async () => {
  const closed = await freePort();
  let startedAt = Date.now();
  expect(await probeDebuggingPort(closed)).toBe('TCP ECONNREFUSED');
  expect(Date.now() - startedAt).toBeLessThan(2_000);

  const held: Socket[] = [];
  const silent = createServer(socket => { held.push(socket); });
  await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve));
  try {
    startedAt = Date.now();
    const answer = await probeDebuggingPort((silent.address() as { port: number }).port);
    expect(answer).toStartWith('accepts TCP; /json/list gave nothing in');
    expect(Date.now() - startedAt).toBeLessThan(8_000);
  } finally {
    for (const socket of held) socket.destroy();
    await new Promise(resolve => silent.close(resolve));
  }
}, 15_000);
