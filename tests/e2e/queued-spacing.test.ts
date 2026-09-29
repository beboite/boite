import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

test('queued prompts sit below the latest reply without reserving an empty activity dock', async () => {
  const port = await freePort();
  const server = await startUi(port);
  let page: BrowserPage | undefined;
  try {
    page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent&machines=1`, windowSize: { width: 1300, height: 850 } });
    await page.click('[data-thread-id="t-trace"]');
    await page.waitFor(`globalThis.__boiteTest.workspace.active.openThread?.id === 't-trace'`);
    await page.evaluate(`(() => {
      const store = globalThis.__boiteTest.workspace.active;
      store.openThread.activity = null;
      store.composerStates['t-trace'] = { text: '', attachments: [], queued: [
        { text: 'First follow-up waiting for the current reply', attachments: [] },
        { text: 'Second follow-up', attachments: [] }
      ], paused: true, sending: false };
    })()`);
    await page.waitFor(`document.querySelector('[data-testid="composer-queued"]')`);
    for (const width of [1300, 390]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width === 390 });
      await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
      await page.evaluate(`(() => { const timeline = document.querySelector('[data-testid="timeline"]'); timeline.scrollTop = timeline.scrollHeight; })()`);
      const gap = await page.evaluate<number>(`(() => {
        const last = [...document.querySelectorAll('[data-testid="message"]')].at(-1);
        return document.querySelector('[data-testid="composer-queued"]').getBoundingClientRect().top - last.getBoundingClientRect().bottom;
      })()`);
      await page.screenshot(join(import.meta.dir, '.artifacts', `queued-spacing-${process.env.BOITE_QUEUE_CAPTURE ?? 'after'}-${width}.png`));
      expect(gap).toBeGreaterThanOrEqual(16);
      expect(gap).toBeLessThanOrEqual(40);
      expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
    }
    await page.evaluate(`globalThis.__boiteTest.workspace.active.openThread.activity = { goal: null, loop: null, tasks: [{ id: 'work', text: 'Keep the latest answer visible', status: 'in_progress' }] }`);
    for (const width of [1300, 390]) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height: 850, deviceScaleFactor: 1, mobile: width === 390 });
      await page.waitFor(`parseFloat(getComputedStyle(document.querySelector('[data-testid="timeline"]')).paddingBottom) >= document.querySelector('[data-testid="thread-activity"]').offsetHeight + 19`);
      await page.evaluate(`(() => { const timeline = document.querySelector('[data-testid="timeline"]'); timeline.scrollTop = timeline.scrollHeight; })()`);
      await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
      const gap = await page.evaluate<number>(`document.querySelector('[data-testid="thread-activity"]').getBoundingClientRect().top - [...document.querySelectorAll('[data-testid="message"]')].at(-1).getBoundingClientRect().bottom`);
      expect(gap).toBeGreaterThanOrEqual(12);
      expect(gap).toBeLessThanOrEqual(40);
      await page.screenshot(join(import.meta.dir, '.artifacts', `queued-spacing-dock-${width}.png`));
    }
  } finally { await page?.close(); await server.close(); }
}, 90_000);
