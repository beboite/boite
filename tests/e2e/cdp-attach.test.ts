import { expect, test } from 'bun:test';
import { BrowserPage } from './lib/cdp.ts';

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
