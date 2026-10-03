import { expect, test } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp.ts';

test('CDP attachment skips startup blank pages unless the caller explicitly asks for one', async () => {
  const app = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>CDP fixture</title><p>Ready</p>', { headers: { 'content-type': 'text/html' } }) });
  const port = await freePort();
  let owner: BrowserPage | undefined;
  let attached: BrowserPage | undefined;
  let blank: BrowserPage | undefined;
  const discovery = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch() {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { url: string }[];
    // Discovery order is unspecified. Reproduce a startup target preceding the app.
    targets.sort((a, b) => Number(b.url === 'about:blank') - Number(a.url === 'about:blank'));
    return Response.json(targets);
  } });
  try {
    owner = await BrowserPage.launch({ url: app.url.href, debugPort: port });
    await owner.send('Target.createTarget', { url: 'about:blank' });
    attached = await BrowserPage.attach(discovery.port!);
    expect(await attached.evaluate('location.href')).toBe(app.url.href);
    blank = await BrowserPage.attach(discovery.port!, 'about:blank');
    expect(await blank.evaluate('location.href')).toBe('about:blank');
    expect(owner.errors()).toEqual([]);
  } finally {
    await blank?.close();
    await attached?.close();
    await owner?.close();
    discovery.stop(true);
    app.stop(true);
  }
}, 60_000);
