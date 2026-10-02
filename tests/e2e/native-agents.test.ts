import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { mobileAction } from './lib/mobile.ts';
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
  await page.waitFor('!!document.querySelector("[data-testid=native-agents]")');
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
  await mobileAction(page, 'mobile-conversations');
  await page.click('[data-testid="mobile-thread-t-native"]');
  await page.click('[data-testid=thread-menu-trigger]');
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=agents]');
  await page.waitFor('document.querySelectorAll("[data-testid=native-agent]").length === 2');
  expect(page.errors()).toEqual([]);
}, 40_000);

test('running native agents contribute to one count without becoming Boite subagents', async () => {
  await onStore('store.delegation.nativeAgents[1].status = "running";');
  await page.waitFor('!!document.querySelector("[data-testid=active-subagents]")');
  expect(await page.text('[data-testid="active-subagents"]')).toContain('1 active subagent');
  await onStore('store.delegation.nativeAgents[0].status = "running";');
  await page.waitFor('document.querySelector("[data-testid=active-subagents]")?.textContent.includes("2 active subagents")');
  expect(await page.evaluate('document.querySelectorAll("[data-testid=agent-dock] button").length')).toBe(1);
  await page.click('[data-testid="panel-close"]');
  await page.click('[data-testid="active-subagents"]');
  await page.waitFor('!!document.querySelector("[data-testid=native-agents]")');
  expect(await page.evaluate('document.querySelectorAll("[data-testid=delegation-member]").length')).toBe(0);
}, 15_000);

test('a detached CLI agent keeps the count and timer visible until its own exit on desktop and phone', async () => {
  await page.evaluate('globalThis.__boiteTest.setTheme("dark")');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1310, height: 820, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid="panel-close"]');
  await onStore('await store.open("t-cli");');
  await page.waitFor('!!document.querySelector("[data-testid=active-subagents]")');
  expect(await page.text('[data-testid="active-subagents"]')).toContain('1 active subagent');
  expect(await page.text('[data-testid="active-subagents"]')).not.toContain('claude-opus-5-5');
  const elapsed = await page.text('[data-testid="active-subagents"] [data-testid="agent-elapsed"]');
  await page.waitFor(`document.querySelector('[data-testid=active-subagents] [data-testid=agent-elapsed]')?.textContent !== ${JSON.stringify(elapsed)}`);
  await capture('cli-agent-dock-desktop.png');
  await page.click('[data-testid="active-subagents"]');
  await page.waitFor('!!document.querySelector("[data-testid=process-agents]")');
  await page.click('[data-testid="process-agent"] > summary');
  expect(await page.text('[data-testid="process-agents"]')).toContain('Started from a command');
  expect(await page.text('[data-testid="process-agents"]')).toContain('Working');
  expect(await page.text('[data-testid="process-agents"]')).toContain('xhigh');
  expect(await page.text('[data-testid="process-agents"]')).toContain('claude-opus-5-5');
  expect(await page.evaluate('document.querySelectorAll("[data-testid=native-agent]").length')).toBe(0);
  expect(await page.evaluate('document.querySelectorAll("[data-testid=delegation-member]").length')).toBe(0);
  await capture('cli-agent-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.waitFor('innerWidth === 390');
  await capture('cli-agent-phone.png');
  await onStore('store.delegation.nativeAgents.find(agent => agent.source === "process").model = undefined;');
  await page.waitFor('!document.querySelector("[data-testid=process-agent] .identity small")?.textContent.includes("claude-opus")');
  expect(await page.text('[data-testid="process-agent"] .identity small')).toBe('xhigh');
  await capture('cli-agent-effort-only-phone.png');
  expect(await page.evaluate('document.documentElement.scrollWidth <= innerWidth')).toBe(true);
  expect(await page.evaluate('(e => e.scrollWidth <= e.clientWidth)(document.querySelector("[data-testid=delegation-surface]"))')).toBe(true);
  await page.click('[data-testid="panel-close"]');
  await capture('cli-agent-dock-phone.png');
  await onStore('await store.client.call("resources.killTree", { threadId: "t-cli" });');
  await page.waitFor('!document.querySelector("[data-testid=active-subagents]")');
  await page.click('[data-testid=thread-menu-trigger]');
  await page.click('[data-testid=thread-menu-trigger-menu] [data-value=agents]');
  await page.waitFor('document.querySelector("[data-testid=process-agent] [data-status=error]") !== null');
  expect(page.errors()).toEqual([]);
}, 25_000);
