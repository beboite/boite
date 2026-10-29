import { afterAll, beforeAll, expect, test } from 'bun:test';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { mobileAction } from './lib/mobile.ts';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let port: number;
const id = (value: string) => `[data-testid="${value}"]`;
beforeAll(async () => { port = await freePort(); server = await startUi(port); }, 60_000);
afterAll(async () => { await server?.close(); }, 30_000);

for (const width of [1280, 390]) {
  test(`opening the idle projects at the bottom of a scrolled list brings them into view at ${width}px`, async () => {
    const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width, height: width < 720 ? 844 : 900 } });
    try {
      await page.waitFor('globalThis.__boiteTest?.workspace.active.booted');
      await page.evaluate(`(async () => {
        const store = globalThis.__boiteTest.workspace.machines[0].store;
        for (let i = 0; i < 9; i++) await store.client.call('projects.add', { path: '/workspace/idle-' + i, name: 'idle-' + i });
      })()`);
      if (width < 720) await mobileAction(page, 'mobile-conversations');
      const root = width < 720 ? id('mobile-list') : id('sidebar');
      const toggle = `${root} ${id('project-shelf-toggle')}`;
      await page.waitFor(`document.querySelector('${toggle}')`);
      const scroller = `(() => { let e = document.querySelector('${toggle}'); while (e && !['auto','scroll'].includes(getComputedStyle(e).overflowY)) e = e.parentElement; return e; })()`;
      // A short list, anchored at its end: the fold opens below the visible edge.
      await page.evaluate(`(() => { const s = ${scroller}; s.style.maxHeight = '300px'; s.scrollTop = s.scrollHeight; })()`);
      await page.waitFor(`(() => { const s = ${scroller}; return s.scrollHeight > s.clientHeight && s.scrollTop + s.clientHeight >= s.scrollHeight - 1; })()`);
      const before = await page.evaluate<number>(`${scroller}.scrollTop`);
      await page.click(toggle);
      await page.waitFor(`document.querySelectorAll('${root} ${id('idle-project')}').length > 0`);
      // The list follows the fold until its header reaches the top, and the first rows are in view.
      await page.waitFor(`(() => {
        const s = ${scroller}, box = s.getBoundingClientRect();
        const header = document.querySelector('${toggle}').getBoundingClientRect();
        const row = document.querySelector('${root} ${id('idle-project')}').getBoundingClientRect();
        return s.scrollTop > ${before} + 40 && header.top >= box.top && header.top < box.top + 20 && row.bottom <= box.bottom;
      })()`, 5_000);
      expect(page.errors()).toEqual([]);
    } finally { await page.close(); }
  }, 30_000);
}
