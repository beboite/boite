import { expect, test } from 'bun:test';
import { Cdp } from '../src/browser/cdp.ts';
import { connect } from '../src/client.ts';

// Bun's client with permessage-deflate on sometimes closes a sound stream with
// 1002 (see SOCKET_OPTIONS): no socket this code opens may offer it.
test('the core client and the DevTools socket never offer permessage-deflate', async () => {
  const offers: Array<string | null> = [];
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request, self) {
      offers.push(request.headers.get('sec-websocket-extensions'));
      return self.upgrade(request) ? undefined : new Response('upgrade required');
    },
    websocket: { perMessageDeflate: true, message() {} },
  });
  try {
    const url = `http://127.0.0.1:${server.port}`;
    for (const headers of [undefined, { origin: url }]) {
      await expect(connect(url, 'token', { timeoutMs: 200, headers })).rejects.toThrow();
    }
    const cdp = await Cdp.connect(`ws://127.0.0.1:${server.port}/devtools/browser/test`);
    cdp.close();
    expect(offers).toEqual([null, null, null]);
  } finally {
    server.stop(true);
  }
});
