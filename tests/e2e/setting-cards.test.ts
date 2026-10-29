import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

const ARTIFACTS = join(import.meta.dir, '.artifacts', 'setting-cards');
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };

let page: BrowserPage;
let server: { close(): Promise<void> };
beforeAll(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1`, experiments: [] });
  await page.evaluate(`localStorage.setItem('boite.locale', 'fr')`);
  await page.navigate(`http://127.0.0.1:${port}/?fake=1`);
  await page.waitFor(`document.documentElement.lang === 'fr' && window.__boiteTest?.workspace.active.connection === 'ready'`);
}, 60000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(ARTIFACTS, name));
}

const DOCKED = '[data-testid="activity-question"] [data-testid="setting-card"][data-state="pending"]';

test('an agent reads the app\'s language and experiments, and its card turns an experiment on in the chat', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  const thread = await page.evaluate(`(async () => {
    const store = window.__boiteTest.workspace.active;
    const thread = await store.client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
    await window.__boiteTest.workspace.select(store, thread.id);
    return thread.id;
  })()`) as string;
  // What \`boite settings\` reads: French, the experiment off, under the name the French page gives it.
  const read = await page.evaluate(`window.__boiteTest.workspace.active.client.call('agent.settings', { threadId: ${JSON.stringify(thread)} })`) as { app: { language: string }; settings: { key: string; value: unknown; label?: string }[] };
  expect(read.app.language).toBe('fr');
  expect(read.settings.find(reading => reading.key === 'experiment.resident-agents')).toMatchObject({ value: false, label: 'Bots' });
  expect(read.settings.find(reading => reading.key === 'experiments')).toBeUndefined();

  await page.evaluate(`window.__boiteTest.workspace.active.client.call('turns.start', { threadId: ${JSON.stringify(thread)}, prompt: 'show me the agents [settings-experiment]' })`);
  await page.waitFor(`document.querySelector('${DOCKED} [data-testid="setting-switch"]')?.getBoundingClientRect().width > 0`);
  expect(await page.evaluate(`document.querySelector('${DOCKED} [data-testid="setting-switch"]').checked`)).toBe(false);
  expect(await page.evaluate(`document.querySelector('${DOCKED} [data-testid="setting-apply"]')`)).toBeNull();
  await capture('experiment-desktop.png');

  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  await page.waitFor(`document.querySelector('${DOCKED}')?.getBoundingClientRect().width > 0`);
  expect(await page.evaluate(`(() => { const card = document.querySelector('${DOCKED}').getBoundingClientRect(); return card.left >= 0 && card.right <= innerWidth; })()`)).toBe(true);
  await capture('experiment-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);

  // The switch in the card flips this device's experiment; the app's report settles the card.
  await page.waitFor(`document.querySelector('${DOCKED} [data-testid="setting-switch"]')?.getBoundingClientRect().width > 0`);
  await page.click(`${DOCKED} [data-testid="setting-switch"]`);
  await page.waitFor(`document.querySelector('[data-testid="setting-card"][data-outcome="applied"]')`);
  expect(await page.evaluate(`JSON.parse(localStorage.getItem('boite.experiments'))`)).toEqual(['resident-agents']);
  await page.waitFor(`window.__boiteTest.workspace.active.openThread?.messages.some(m => m.role === 'user' && m.parts.some(p => p.type === 'text' && p.text.includes('applied: experiment.resident-agents is now true')))`);
  await page.waitFor(`document.querySelector('[data-testid="view-agents"]')`);
  await capture('experiment-applied-desktop.png');

  // A sensitive switch shows in the card too, beside its warning, once the agent has read the card's report.
  await page.waitFor(`window.__boiteTest.workspace.active.openThread.status === 'idle'`);
  await page.evaluate(`window.__boiteTest.workspace.active.client.call('turns.start', { threadId: ${JSON.stringify(thread)}, prompt: 'pair my phone [settings-lan]' })`);
  await page.waitFor(`document.querySelector('${DOCKED} [data-testid="setting-sensitive-hint"]') && document.querySelector('${DOCKED} [data-testid="setting-switch"]')`);
  await capture('sensitive-desktop.png');
}, 60000);
