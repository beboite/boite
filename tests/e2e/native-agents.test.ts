import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startDevUi } from './lib/ui.ts';

let server: { close(): Promise<void> };
let page: BrowserPage;
const onStore = (code: string) => page.evaluate(`import('/src/lib/store.svelte.ts').then(async ({ store }) => { ${code} })`);
async function capture(name: string) {
  await page.evaluate('document.querySelector("[data-testid=delegation-surface]")?.scrollTo(0, 0)');
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(import.meta.dir, '.artifacts', name));
}
beforeAll(async () => {
  const port = await freePort();
  server = await startDevUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1&team=1`, windowSize: { width: 1310, height: 820 } });
  await page.click('[data-testid="thread-row"][data-thread-id="t-native"]');
  await page.click('[data-testid=thread-menu-trigger]');
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=agents]');
  await page.waitFor('!!document.querySelector("[data-testid=delegation-settings]")');
}, 60_000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

test('native agents remain visible beside Boite subagents on desktop and phone', async () => {
  await page.click('[data-testid="native-agent"] > summary');
  await capture('native-agents-desktop.png');
  expect(await page.text('[data-testid="delegation-surface"]')).toContain('Started by the provider');
  expect(await page.evaluate('document.querySelectorAll("[data-testid=native-agent]").length')).toBe(2);
  expect(await page.text('[data-testid="native-agents"]')).toContain('Parser checked');
  expect(await page.text('[data-testid="native-agents"]')).toContain('Status unknown');
  expect(await page.text('[data-testid="native-agents"]')).toContain('fake-smart');
  // Only native agents exist, so the tab must stay reachable after the panel closes.
  await page.click('[data-testid="panel-close"]');
  await page.click('[data-testid=thread-menu-trigger]');
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=agents]');
  await page.waitFor('document.querySelectorAll("[data-testid=native-agent]").length === 2');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('innerWidth === 390');
  await capture('native-agents-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.evaluate('(e => e.scrollWidth <= e.clientWidth)(document.querySelector("[data-testid=delegation-surface]"))')).toBe(true);
  await page.reload();
  await page.click('[data-testid="thread-row"][data-thread-id="t-native"]');
  await page.click('[data-testid=thread-menu-trigger]');
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=agents]');
  await page.waitFor('document.querySelectorAll("[data-testid=native-agent]").length === 2');
  expect(page.errors()).toEqual([]);
}, 40_000);

test('a running native agent has a dock entry without changing Boite team usage', async () => {
  await onStore('store.delegation.nativeAgents[1].status = "running";');
  await page.waitFor('!!document.querySelector("[data-testid=native-agent-dock-member]")');
  await page.click('[data-testid="panel-close"]');
  await page.click('[data-testid="native-agent-dock-member"]');
  await page.waitFor('!!document.querySelector("[data-testid=native-agents]")');
  expect((await page.text('[data-testid="delegation-usage"]')).replace(/\s+/g, ' ')).toContain('0 subagents');
}, 15_000);
