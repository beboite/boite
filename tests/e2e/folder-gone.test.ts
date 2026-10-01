import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

/*
 * A project whose folder was deleted outside the app, on the fake client: the
 * sidebar marks it, the composer says why nothing can start there and offers
 * the ways out as buttons, at desktop and phone widths.
 */

let server: { close(): Promise<void> };
let page: BrowserPage;

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}

beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent` });
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
}, 60_000);

afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);

test('a project whose folder is gone is marked, explained above the composer and removable', async () => {
  expect(await page.evaluate(`document.querySelector('[data-testid=folder-gone]') === null && document.querySelector('[data-testid=project-missing]') === null`)).toBe(true);
  const projectId = await page.evaluate<string>(`import('/src/lib/workspace.svelte.ts').then(async ({ workspace }) => {
    const store = workspace.active;
    const project = store.openProject;
    store.client.loseFolder(project.path);
    await store.refreshProjects();
    return project.id;
  })`);
  await page.waitFor(`document.querySelector('[data-testid=folder-gone]') && document.querySelector('[data-project-id="${projectId}"] [data-testid=project-missing]')`);
  expect(await page.evaluate(`document.querySelectorAll('[data-testid=project-missing]').length`)).toBe(1);
  expect(await page.evaluate(`document.querySelector('[data-testid=folder-gone]').textContent`)).toContain('does not exist any more');
  await capture('folder-gone-desktop.png');

  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor(`document.querySelector('[data-testid=folder-gone]')?.getBoundingClientRect().width > 0`);
  const bounds = await page.evaluate<{ left: number; right: number }>(`(() => { const r = document.querySelector('[data-testid=folder-gone]').getBoundingClientRect(); return { left: r.left, right: r.right }; })()`);
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.right).toBeLessThanOrEqual(390);
  await capture('folder-gone-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  // Checking again asks the core: the folder is still gone, so the notice stays.
  await page.click('[data-testid=folder-gone-check]');
  await page.waitFor(`document.querySelector('[data-testid=folder-gone-check]')?.disabled === false`);
  expect(await page.evaluate(`document.querySelector('[data-testid=folder-gone]') !== null`)).toBe(true);

  await page.click('[data-testid=folder-gone-remove]');
  await page.waitFor(`document.querySelector('[data-testid=confirm-ok]')`);
  await page.click('[data-testid=confirm-ok]');
  await page.waitFor(`!document.querySelector('[data-project-id="${projectId}"]') && !document.querySelector('[data-testid=folder-gone]')`);
}, 30_000);
