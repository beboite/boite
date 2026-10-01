import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui';

test('queued prompts sit above the activity dock attached to the input', async () => {
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
      await page.waitFor(`(() => { const dock = document.querySelector('[data-testid="thread-activity"]'); return dock?.offsetHeight > 0 && parseFloat(document.querySelector('.queue-region').style.paddingBottom) === dock.offsetHeight; })()`);
      await page.evaluate(`(() => { const timeline = document.querySelector('[data-testid="timeline"]'); timeline.scrollTop = timeline.scrollHeight; })()`);
      await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
      const gap = await page.evaluate<number>(`document.querySelector('[data-testid="composer-queued"]').getBoundingClientRect().top - [...document.querySelectorAll('[data-testid="message"]')].at(-1).getBoundingClientRect().bottom`);
      expect(gap).toBeGreaterThanOrEqual(12);
      expect(gap).toBeLessThanOrEqual(40);
      await page.screenshot(join(import.meta.dir, '.artifacts', `queued-spacing-dock-${process.env.BOITE_QUEUE_CAPTURE ?? 'after'}-${width}.png`));
      const placement = await page.evaluate<{ gap: number; queueBottom: number; dockTop: number }>(`(() => {
        const dock = document.querySelector('[data-testid="thread-activity"]').getBoundingClientRect();
        const composer = document.querySelector('[data-testid="composer"]').getBoundingClientRect();
        return { gap: composer.top - dock.bottom, queueBottom: document.querySelector('[data-testid="composer-queued"]').getBoundingClientRect().bottom, dockTop: dock.top };
      })()`);
      expect(placement.gap).toBeGreaterThanOrEqual(0);
      expect(placement.gap).toBeLessThanOrEqual(4);
      expect(placement.queueBottom).toBeLessThanOrEqual(placement.dockTop);
      await page.click('[data-testid="activity-tasks-toggle"]');
      await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
      await page.waitFor(`document.querySelector('[data-testid="composer-queued"]').getBoundingClientRect().bottom <= document.querySelector('[data-testid="thread-activity"]').getBoundingClientRect().top`);
      await page.click('[data-testid="activity-tasks-toggle"]');
      await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
    }
    // A short pinned history starts at zero, but a new dock can make it overflow.
    await page.evaluate(`(() => {
      const store = globalThis.__boiteTest.workspace.active;
      store.openThread.activity = null;
      store.composerStates['t-trace'].queued = [];
    })()`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: 850, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`parseFloat(getComputedStyle(document.querySelector('[data-testid="timeline"]')).paddingBottom) === 20`);
    const fittedHeight = await page.evaluate<number>(`(() => { const t = document.querySelector('[data-testid="timeline"]'); return innerHeight + t.scrollHeight - t.clientHeight + 20; })()`);
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1300, height: fittedHeight, deviceScaleFactor: 1, mobile: false });
    await page.waitFor(`document.querySelector('[data-testid="timeline"]').scrollTop === 0`);
    await page.evaluate(`globalThis.__boiteTest.workspace.active.openThread.activity = { goal: null, loop: null, tasks: [{ id: 'short', text: 'Keep this short reply visible', status: 'in_progress' }] }`);
    await page.waitFor(`(() => {
      const last = [...document.querySelectorAll('[data-testid="message"]')].at(-1);
      const dock = document.querySelector('[data-testid="thread-activity"]');
      return dock && last.getBoundingClientRect().bottom <= dock.getBoundingClientRect().top;
    })()`);
    expect(await page.evaluate(`document.querySelector('[data-testid="timeline"]').scrollTop`)).toBeGreaterThan(0);
  } finally { await page?.close(); await server.close(); }
}, 90_000);
