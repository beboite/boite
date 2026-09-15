import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { BrowserPage, freePort } from './lib/cdp.ts';
const uiRequire = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(uiRequire.resolve('vite'));
let server: { listen(): Promise<unknown>; close(): Promise<void> };
let page: BrowserPage;
async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true }, clearScreen: false });
  await server.listen();
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1` });
  await page.waitFor(`document.querySelector('[data-testid=composer-picker]')`);
}, 30_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 15_000);
test('project picker browses folders, opens a draft, and fits a phone', async () => {
  expect(await page.evaluate(`document.body.textContent.includes('Enter to send')`)).toBe(false);
  await capture('polish-desktop.png');
  await page.click('[data-testid=add-project]');
  await page.waitFor(`document.querySelector('[data-testid=project-path]')?.value === '/workspace'`);
  await capture('polish-project-picker.png');
  await page.evaluate(`Array.from(document.querySelectorAll('.folder')).find(e => e.textContent.includes('notes')).click()`);
  await page.waitFor(`document.querySelector('[data-testid=project-path]')?.value === '/workspace/notes'`);
  await page.click('[data-testid=project-add]');
  await page.waitFor(`!document.querySelector('[data-testid=project-picker]') && document.querySelector('[data-testid=draft-row]')`);
  await page.click('[data-testid=add-project]');
  await page.waitFor(`document.querySelector('[data-testid=project-path]')?.value === '/workspace'`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('polish-project-phone.png');
  const bounds = await page.evaluate<{left:number;right:number}>(`(() => { const r = document.querySelector('[data-testid=project-picker]').getBoundingClientRect(); return {left:r.left,right:r.right}; })()`);
  expect(bounds.left).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(390);
  await page.click('[data-testid=project-cancel]');
  await page.send('Emulation.clearDeviceMetricsOverride', {});
}, 30_000);
test('an unreachable remembered machine appears as a problem without counting as connected', async () => {
  const port = await freePort();
  await page.evaluate(`import('/src/lib/workspace.svelte.ts').then(({workspace}) => { void workspace.add({url:'http://127.0.0.1:${port}',token:'test-only',paired:false}, 'Build server'); })`);
  await page.waitFor(`document.querySelector('[data-testid=status-connection]')?.classList.contains('problem')`, 15_000);
  expect(await page.evaluate(`document.querySelector('[data-testid=status-connection]').textContent`)).toContain('1 machine connected');
  await page.click('[data-testid=machine-status]');
  await page.waitFor(`document.querySelector('[data-testid=status-connection]')?.textContent.includes('Build server')`);
  await capture('polish-machine-problem.png');
  await page.evaluate(`import('/src/lib/workspace.svelte.ts').then(({workspace}) => workspace.remove('http://127.0.0.1:${port}'))`);
}, 20_000);
