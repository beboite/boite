import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

const ARTIFACTS = join(import.meta.dir, '.artifacts', 'agent-create-cards');
const DESKTOP = { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };

let page: BrowserPage;
let server: { close(): Promise<void> };
let port: number;
beforeAll(async () => {
  mkdirSync(ARTIFACTS, { recursive: true });
  port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1`, experiments: ['resident-agents'] });
  await page.waitFor(`document.querySelector('[data-testid="view-agents"]')`);
}, 60000);
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

async function capture(name: string) {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
  await page.screenshot(join(ARTIFACTS, name));
}

const DOCKED = '[data-testid="activity-question"] [data-testid="agent-create-card"][data-state="pending"]';

test('a thread asked to set up a bot proposes it; Create makes it and Open leads to it', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  await page.evaluate(`(async () => {
    const store = window.__boiteTest.workspace.active;
    const thread = await store.client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
    await window.__boiteTest.workspace.select(store, thread.id);
    await store.client.call('turns.start', { threadId: thread.id, prompt: 'set up a communication bot' });
    await store.client.call('agents.settings.create', { threadId: thread.id, name: 'Communication', domain: 'Posts, newsletters and release notes',
      instructions: 'Write the weekly post every Friday from the merged pull requests.\\nKeep it under 300 words.\\nAsk before publishing anything.',
      projects: ['boite'], effort: 'high', reason: 'You asked me to set up a bot for the project\\'s communication.' });
  })()`);

  // The card waits in the dock above the composer, the bot spelled out.
  await page.waitFor(`document.querySelector('${DOCKED} [data-testid="agent-create-name"]')?.textContent === 'Communication'`);
  expect(await page.text('[data-testid="activity-question-toggle"]')).toContain('Suggested new bot');
  expect(await page.text(`${DOCKED} [data-testid="agent-create-projects"]`)).toBe('boite');
  await capture('thread-desktop.png');

  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  await page.waitFor(`document.querySelector('${DOCKED}')?.getBoundingClientRect().width > 0`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect(await page.evaluate(`(() => { const card = document.querySelector('${DOCKED}').getBoundingClientRect(); return card.left >= 0 && card.right <= innerWidth; })()`)).toBe(true);
  await capture('thread-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);

  await page.waitFor(`document.querySelector('${DOCKED} [data-testid="agent-create-apply"]')?.getBoundingClientRect().width > 0`);
  await page.click(`${DOCKED} [data-testid="agent-create-apply"]`);

  // The timeline keeps one row saying it was created, and the thread hears where the bot lives.
  await page.waitFor(`document.querySelector('[data-testid="agent-create-card"][data-outcome="created"]')`);
  await page.waitFor(`window.__boiteTest.workspace.active.openThread?.messages.some(m => m.role === 'user' && m.parts.some(p => p.type === 'text' && p.text.includes('created: the bot Communication')))`);
  await capture('thread-created-desktop.png');

  await page.click('[data-testid="agent-create-card"][data-outcome="created"] [data-testid="agent-create-show"]');
  await page.waitFor(`window.__boiteTest.workspace.active.page === 'agents'`);
  const bot = await page.evaluate<{ projectIds: string[]; effort: string | null; permissionMode: string }>(`(async () => {
    const snapshot = await window.__boiteTest.workspace.active.client.call('agents.snapshot', {});
    const bot = snapshot.profiles.find(p => p.name === 'Communication');
    return { projectIds: bot.projectIds, effort: bot.selection.effort, permissionMode: bot.selection.permissionMode };
  })()`);
  expect(bot).toEqual({ projectIds: ['p-boite'], effort: 'high', permissionMode: 'bypassPermissions' });
}, 60000);
