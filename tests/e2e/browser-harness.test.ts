import { expect, test } from 'bun:test';
import { BrowserPage } from './lib/cdp.ts';

test('browser waits for asynchronous conditions and the requested navigation', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/next') await Bun.sleep(150);
      return new Response(`<title>${path}</title><main>${path}</main>`, {
        headers: { 'content-type': 'text/html' },
      });
    },
  });
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `${server.url}first`, windowSize: { width: 1310, height: 820 } });
    expect(await page.evaluate('[innerWidth, innerHeight]')).toEqual([1310, 820]);
    await expect(page.waitFor('Promise.resolve(false)', 100)).rejects.toThrow('waitFor timed out');
    await page.waitFor('Promise.resolve(true)', 100);
    await page.navigate(`${server.url}next`);
    expect(await page.evaluate('document.title')).toBe('/next');
    expect(await page.evaluate('[innerWidth, innerHeight]')).toEqual([1310, 820]);
  } finally {
    await page?.close();
    server.stop(true);
  }
}, 30_000);
