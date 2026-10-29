import { expect, test } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp';
import { startDevUi } from './lib/ui';

/** Where the typed text is clipped against the bar under it, the box scrolled halfway. */
const clip = `(() => {
  const box = document.querySelector('[data-testid=composer-input]');
  box.scrollTop = (box.scrollHeight - box.clientHeight) / 2;
  const bar = box.closest('[data-testid=composer]').querySelector('.bar');
  return { scrolls: box.scrollHeight > box.clientHeight, gap: bar.getBoundingClientRect().top - box.getBoundingClientRect().bottom };
})()`;

test('a long prompt scrolls inside its box and stops above the bar, on desktop and phone, in a thread and a draft', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1280, height: 900 } });
    for (const [phone, draft] of [[false, false], [true, false], [false, true], [true, true]] as const) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: phone ? 390 : 1280, height: phone ? 844 : 900, deviceScaleFactor: 1, mobile: phone });
      await page.evaluate(`import('/src/lib/store.svelte.ts').then(async ({ store }) => { ${draft ? 'store.startDraft(store.projects[0].id);' : "await store.open('t-trace');"} })`);
      await page.waitFor('document.querySelector("[data-testid=composer-input]")');
      await page.type('[data-testid=composer-input]', 'Long brief: ' + 'the list jumps when the next page loads and the header moves. '.repeat(12));
      const measured = await page.evaluate<{ scrolls: boolean; gap: number }>(clip);
      expect(measured.scrolls).toBe(true);
      // A line cut by the box's edge must not touch the bar's controls.
      expect(measured.gap).toBeGreaterThanOrEqual(6);
      await page.evaluate(`(() => { const box = document.querySelector('[data-testid=composer-input]'); box.value = ''; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    }
    expect(page.errors()).toEqual([]);
  } finally { await page?.close(); await server.close(); }
}, 120_000);
