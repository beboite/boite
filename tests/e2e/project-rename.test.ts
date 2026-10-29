import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';
import { screensSettled, toMobileList } from './lib/mobile.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: { width: 1300, height: 850 } });
  await page.waitFor(`document.querySelector('[data-testid=project-row][data-project-id="p-boite"]')`);
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test('the project menu renames on desktop and phone and keeps the folder', async () => {
  const folder = await page.evaluate<string>(`globalThis.__boiteTest.workspace.active.projects.find(p => p.id === 'p-boite').path`);
  for (const mobile of [false, true]) {
    if (mobile) {
      await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await page.waitFor(`document.querySelector('[data-testid=mobile-back], [data-testid=mobile-tabs]')`);
      await toMobileList(page);
      await page.waitFor(screensSettled);
    }
    const row = mobile ? '[data-testid=mobile-project-group]' : '[data-testid=project-row]';
    const menu = mobile ? '[data-testid=mobile-project-menu]' : '[data-testid=project-menu]';
    await page.click(`${row}[data-project-id="p-boite"] ${mobile ? '' : '~ '}${menu}`);
    await page.waitFor(`document.querySelector('[data-testid=context-menu] [data-value=rename]')`);
    await page.click('[data-testid=context-menu] [data-value=rename]');
    await page.waitFor(`document.activeElement?.getAttribute('data-testid') === 'confirm-name'`);
    const name = mobile ? 'Project on phone' : 'My project';
    await page.type('[data-testid=confirm-name]', name);
    await page.settleAnimations();
    await page.screenshot(join(import.meta.dir, '.artifacts', `project-rename-${mobile ? 'phone' : 'desktop'}.png`));
    expect(await page.evaluate(`(() => { const r = document.querySelector('[data-testid=confirm-dialog]').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()`)).toBe(true);
    await page.click('[data-testid=confirm-ok]');
    await page.waitFor(`globalThis.__boiteTest.workspace.active.projects.find(p => p.id === 'p-boite').name === ${JSON.stringify(name)}`);
    await page.waitFor(`!document.querySelector('[data-testid=confirm-dialog]')`);
    expect(await page.evaluate(`document.querySelector('${row}[data-project-id="p-boite"]').textContent.includes(${JSON.stringify(name)})`)).toBe(true);
    expect(await page.evaluate(`globalThis.__boiteTest.workspace.active.projects.find(p => p.id === 'p-boite').path`)).toBe(folder);
    await page.screenshot(join(import.meta.dir, '.artifacts', `project-renamed-${mobile ? 'phone' : 'desktop'}.png`));
  }
}, 30_000);
