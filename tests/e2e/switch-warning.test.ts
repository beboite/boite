import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';

const req = createRequire(join(import.meta.dir, '../../packages/ui/package.json'));
const { createServer } = await import(req.resolve('vite'));
let server: { close(): Promise<void> };
let port = 0;
const pages: BrowserPage[] = [];

beforeAll(async () => {
  port = await freePort();
  const vite = await createServer({ root: join(import.meta.dir, '../../packages/ui'), server: { host: '127.0.0.1', port, strictPort: true } });
  server = vite;
  await vite.listen();
}, 90_000);
afterAll(async () => {
  for (const page of pages) await page.close();
  await server?.close();
});

const STORE = `(await import('/src/lib/workspace.svelte.ts')).workspace.active`;

/** Opens the recent thread with a long context and picks a Claude model, the seeded thread being echo's. */
async function switchAway(size: { width: number; height: number }, name: string): Promise<BrowserPage> {
  const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: size });
  pages.push(page);
  await page.waitFor(`document.querySelector('[data-testid="composer-picker"]')`);
  await page.evaluate(`(async () => { const store = ${STORE}; store.openThread.context = { tokens: 240000, window: 1000000, at: Date.now() }; window.__account = store.openThread.accountId; window.__provider = store.openThread.providerId; })()`);
  await page.click('[data-testid="composer-picker"]');
  await page.waitFor(`document.querySelector('[data-testid="composer-picker-menu"] [data-provider]')`);
  await page.click('[data-testid="composer-picker-menu"] [data-provider="claude"]');
  await page.waitFor(`document.querySelector('[data-testid="composer-picker-menu"] [data-model]')`);
  await page.evaluate(`document.querySelector('[data-testid="composer-picker-menu"] [data-model]').click()`);
  await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')`);
  await page.evaluate(`Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`);
  await page.screenshot(join(import.meta.dir, '.artifacts', `${name}.png`));
  return page;
}

const account = (page: BrowserPage) => page.evaluate<boolean>(`(async () => (${STORE}).openThread.accountId === window.__account)()`);

test('a long thread asks before it moves to another account, and Cancel leaves it where it was', async () => {
  const page = await switchAway({ width: 1300, height: 850 }, 'switch-warning-desktop');
  expect(await page.text('[data-testid="confirm-dialog"]')).toContain('240');
  await page.click('[data-testid="confirm-cancel"]');
  await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
  expect(await account(page)).toBe(true);
}, 90_000);

test('the same question on a phone, and Switch moves the thread', async () => {
  const page = await switchAway({ width: 390, height: 844 }, 'switch-warning-phone');
  await page.click('[data-testid="confirm-ok"]');
  await page.waitFor(`!document.querySelector('[data-testid="confirm-dialog"]')`);
  await page.waitFor(`(async () => (${STORE}).openThread.accountId !== window.__account)()`);
  expect(await account(page)).toBe(false);
}, 90_000);
