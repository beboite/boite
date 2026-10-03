import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp';
import { startUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let port = 0;
const pages: BrowserPage[] = [];

beforeAll(async () => {
  port = await freePort();
  server = await startUi(port);
}, 90_000);
afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.close()));
}, 15_000);
afterAll(async () => {
  await server?.close();
}, 15_000);

const STORE = `globalThis.__boiteTest.workspace.active`;
const settle = `Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))`;
const shot = (page: BrowserPage, name: string) => page.screenshot(join(import.meta.dir, '.artifacts', `${name}.png`));

/** A spare account with one idle conversation on it, the seeded ones being busy. */
async function withSpare(size: { width: number; height: number }): Promise<BrowserPage> {
  const page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&open=recent`, windowSize: size });
  pages.push(page);
  await page.waitFor(`document.querySelector('[data-testid="composer-picker"]')`);
  await page.evaluate(`(async () => {
    const store = ${STORE};
    const account = await store.addAccount({ providerId: 'echo', label: 'Spare' });
    const thread = await store.client.call('threads.create', { projectId: store.openThread.projectId, providerId: 'echo', accountId: account.id, title: 'Orphan' });
    window.__account = account.id; window.__thread = thread.id;
  })()`);
  return page;
}

async function openOrphan(page: BrowserPage, name: string): Promise<void> {
  await page.evaluate(`${STORE}.open(window.__thread)`);
  await page.waitFor(`document.querySelector('[data-testid="composer-account-removed"]')`);
  await page.evaluate(settle);
  await shot(page, name);
  await page.click('[data-testid="composer-account-removed"]');
  await page.waitFor(`document.querySelector('[data-testid="composer-picker-menu"]')`);
}

test('removing an account warns about its conversations, which then ask for another account', async () => {
  const page = await withSpare({ width: 1300, height: 850 });
  await page.evaluate(`${STORE}.showSettings('accounts')`);
  const remove = `document.querySelector('[data-testid="account-remove"][data-account-id="' + window.__account + '"]')`;
  await page.waitFor(`document.querySelector('[data-provider-id="echo"] [data-testid="provider-details-toggle"]')`);
  await page.click('[data-provider-id="echo"] [data-testid="provider-details-toggle"]');
  await page.waitFor(remove);
  await page.evaluate(`${remove}.click()`);
  await page.waitFor(`document.querySelector('[data-testid="confirm-dialog"]')`);
  expect(await page.text('[data-testid="confirm-dialog"]')).toContain('1 conversation still uses this account');
  await page.evaluate(settle);
  await shot(page, 'account-removal-warning-desktop');
  await page.click('[data-testid="confirm-ok"]');
  await page.waitFor(`${STORE}.accounts.every(account => account.id !== window.__account)`);
  await openOrphan(page, 'account-removal-chip-desktop');
}, 60_000);

test('a phone shows the removed account on the conversation', async () => {
  const page = await withSpare({ width: 390, height: 844 });
  // Account administration is on desktop; the phone sees the result.
  await page.evaluate(`${STORE}.removeAccount(window.__account)`);
  await openOrphan(page, 'account-removal-chip-phone');
}, 60_000);
