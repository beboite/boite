import { expect, test } from 'bun:test';
import { BrowserPage } from './lib/cdp.ts';

test('a browser that exits before opening CDP reports its exit and stderr promptly', async () => {
  const started = performance.now();
  // Bun rejects Chromium's switches and exits without opening the debugging port.
  await expect(BrowserPage.launch({ executable: process.execPath, url: 'about:blank' }))
    .rejects.toThrow(/browser exited.*code 1[\s\S]*stderr:/);
  expect(performance.now() - started).toBeLessThan(5_000);
}, 45_000);

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
    if (process.env.CI === 'true') {
      // CPU compositing must still paint while software GL stays unavailable.
      expect(await page.evaluate(`(() => {
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        context.fillStyle = 'rgb(19, 43, 71)';
        context.fillRect(0, 0, 1, 1);
        return { pixel: Array.from(context.getImageData(0, 0, 1, 1).data), webgl: document.createElement('canvas').getContext('webgl') !== null };
      })()`)).toEqual({ pixel: [19, 43, 71, 255], webgl: false });
    }
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
