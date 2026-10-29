import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

test('summary instructions keep their label above a full-width editor on desktop and phone', async () => {
  const port = await freePort();
  const server = await startDevUi(port);
  const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1400, height: 1000 } });
  try {
    await page.waitFor('document.querySelector("[data-testid=nav-settings]")');
    await page.click('[data-testid=nav-settings]');
    await page.click('[data-testid=settings-tab-advanced]');
    for (const [width, height, mobile] of [[1400, 1000, false], [390, 844, true]] as const) {
      await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
      if (mobile) await page.evaluate(`[...document.querySelectorAll('button')].find(button => button.textContent.trim() === 'Automatic compaction').click()`);
      await page.waitFor('document.querySelector("[data-testid=compaction-summary]")');
      await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
      const layout = await page.evaluate<{ labelAbove: boolean; fullWidth: boolean; fits: boolean }>(`(() => {
        const editor = document.querySelector('[data-testid=compaction-summary]');
        const box = editor.getBoundingClientRect();
        const label = document.querySelector('label[for="' + editor.id + '"]').getBoundingClientRect();
        const parent = editor.parentElement.getBoundingClientRect();
        return { labelAbove: label.bottom <= box.top, fullWidth: Math.abs(parent.width - box.width) <= 2, fits: document.documentElement.scrollWidth <= innerWidth };
      })()`);
      expect(layout).toEqual({ labelAbove: true, fullWidth: true, fits: true });
      await page.screenshot(join(import.meta.dir, '.artifacts', `compaction-summary-${mobile ? 'phone' : 'desktop'}-verified.png`));
    }
  } finally { await page.close(); await server.close(); }
}, 60_000);
