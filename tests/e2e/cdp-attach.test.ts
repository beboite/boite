import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer, type AddressInfo, type Socket } from 'node:net';
import type { ServerWebSocket } from 'bun';
import { expect, test } from 'bun:test';
import { BrowserPage, freePort, probeDebuggingPort } from './lib/cdp.ts';
import { requestLog } from './lib/ui-requests.ts';

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

test('requests in flight and failed requests retain what Chrome and each UI server reported', async () => {
  let middleware: ((request: IncomingMessage, response: ServerResponse, next: () => void) => void) | undefined;
  requestLog.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  const ui = createHttpServer((request, response) => middleware!(request, response, () => response.end('export {}')));
  await new Promise<void>((resolve) => ui.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(ui.address() as AddressInfo).port}`;
  // A second UI server that never gets its request: known from the moment it listens.
  const idle = createHttpServer((request, response) => middleware!(request, response, () => response.end()));
  requestLog.configurePreviewServer({ middlewares: { use() {} }, httpServer: idle });
  await new Promise<void>((resolve) => idle.listen(0, '127.0.0.1', resolve));
  const idleBase = `http://127.0.0.1:${(idle.address() as AddressInfo).port}`;
  let devtools: ServerWebSocket<unknown> | undefined;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, self) {
      if (new URL(request.url).pathname === '/json/list') return Response.json([{ type: 'page', url: 'http://tauri.localhost/', webSocketDebuggerUrl: `ws://127.0.0.1:${self.port}/app` }]);
      return self.upgrade(request) ? undefined : new Response('upgrade required');
    }, websocket: {
      open(socket) { devtools = socket; },
      message(socket, raw) {
        const frame = JSON.parse(String(raw)) as { id: number; method: string };
        socket.send(JSON.stringify({ id: frame.id, result: frame.method === 'Runtime.evaluate' ? { result: { value: false } } : {} }));
      },
    },
  });
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.attach(server.port!);
    const sent = Date.now();
    for (const chunk of ['RightPanel.js', 'CommandPalette.js']) expect(await (await fetch(`${base}/assets/${chunk}`)).text()).toBe('export {}');
    // A loaded runner: the server answered both before devtools reported them.
    await Bun.sleep(30);
    const willBeSent = (requestId: string, url: string, wallTime?: number) => JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId, loaderId: 'l', frameId: 'f', wallTime, request: { url } } });
    devtools!.send(willBeSent('1', `${base}/assets/RightPanel.js`, sent / 1_000));
    devtools!.send(willBeSent('2', `${base}/assets/CommandPalette.js`));
    devtools!.send(willBeSent('3', `${idleBase}/assets/SettingsShell.js`, sent / 1_000));
    const failure = await page.waitFor('false', 1_300).then(() => 'answered', (error: unknown) => String(error));
    const line = (chunk: string) => failure.split('","').find((entry) => entry.includes(chunk)) ?? `no line for ${chunk} in ${failure}`;
    expect(line('RightPanel.js')).toMatch(/; the UI server answered 200 \d+ ms after it was sent/);
    expect(line('CommandPalette.js')).toMatch(/; no send time; newest record: the UI server answered 200 \d+ ms before devtools reported it/);
    expect(line('SettingsShell.js')).toMatch(/; the UI server never got it/);

    // Once loadingFailed removes a request, its network/server evidence must
    // survive. Query strings and fragments must not reach the failure report.
    const failedSent = Date.now();
    expect(await (await fetch(`${base}/assets/RightPanel.js?ticket=private`)).text()).toBe('export {}');
    devtools!.send(willBeSent('1', `${base}/assets/RightPanel.js?ticket=private#pairing`, failedSent / 1_000));
    devtools!.send(JSON.stringify({ method: 'Network.responseReceivedExtraInfo', params: { requestId: '1' } }));
    devtools!.send(JSON.stringify({ method: 'Network.responseReceived', params: { requestId: '1', response: { status: 200 } } }));
    devtools!.send(JSON.stringify({ method: 'Network.requestWillBeSentExtraInfo', params: { requestId: '2' } }));
    for (const requestId of ['1', '2', '3']) devtools!.send(JSON.stringify({ method: 'Network.loadingFailed', params: { requestId, errorText: 'net::ERR_NO_BUFFER_SPACE' } }));
    // This call is a protocol barrier: all preceding events have been consumed.
    await page.evaluate('false');
    // A later response must not rewrite the server state captured at failure.
    expect(await (await fetch(`${idleBase}/assets/SettingsShell.js`)).text()).toBe('');
    const afterFailure = await page.waitFor('false', 1_300).then(() => 'answered', (error: unknown) => String(error));
    expect(afterFailure).toContain('In flight: []');
    const failed = JSON.parse(afterFailure.split('Failed requests: ')[1]!) as string[];
    expect(failed).toHaveLength(3);
    expect(failed[0]).toMatch(/RightPanel\.js net::ERR_NO_BUFFER_SPACE; at failure: answered, body pending for \d+ ms: the network service had its headers by \d+ ms after it was sent; the UI server answered 200 \d+ ms after it was sent/);
    expect(failed[1]).toMatch(/CommandPalette\.js net::ERR_NO_BUFFER_SPACE; at failure: no response for \d+ ms: the network service sent it and has no headers; no send time; newest record: the UI server answered 200 \d+ ms before devtools reported it/);
    expect(failed[2]).toMatch(/SettingsShell\.js net::ERR_NO_BUFFER_SPACE; at failure: no response for \d+ ms: nothing from the network service .*; the UI server never got it/);
    expect(afterFailure).not.toContain('private');
    expect(afterFailure).not.toContain('pairing');
  } finally { await page?.close(); await server.stop(true); ui.close(); idle.close(); }
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
