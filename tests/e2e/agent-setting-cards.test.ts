import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

const ARTIFACTS = join(import.meta.dir, '.artifacts', 'agent-setting-cards');
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

const DOCKED = '[data-testid="activity-question"] [data-testid="agent-setting-card"][data-state="pending"]';

test('a thread asks to entrust a project to an agent; Apply entrusts it and the card reads applied', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  // An agent with no project, and a thread of boite whose agent asks for it to be entrusted.
  const ids = await page.evaluate(`(async () => {
    const store = window.__boiteTest.workspace.active;
    const agent = await store.client.call('agents.profile.save', { value: { name: 'Scout', domain: 'Follows projects', instructions: '', avatar: '', status: 'active', tools: [], projectIds: [],
      selection: { providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null, permissionMode: 'default' } } });
    const thread = await store.client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
    await window.__boiteTest.workspace.select(store, thread.id);
    await store.client.call('turns.start', { threadId: thread.id, prompt: 'follow this project [agent-settings]' });
    return { agent: agent.id, thread: thread.id };
  })()`) as { agent: string; thread: string };

  // The card waits in the dock above the composer, with the project ticked.
  await page.waitFor(`document.querySelector('${DOCKED} [data-testid="agent-setting-project"][data-project="p-boite"]')?.checked === true`);
  expect(await page.text('[data-testid="activity-question-toggle"]')).toContain('Suggested change to Scout');
  expect(await page.text(`${DOCKED} [data-testid="agent-setting-reason"]`)).toContain('Entrusting it to Scout');
  await capture('thread-desktop.png');

  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  await page.waitFor(`document.querySelector('${DOCKED}')?.getBoundingClientRect().width > 0`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect(await page.evaluate(`(() => { const card = document.querySelector('${DOCKED}').getBoundingClientRect(); return card.left >= 0 && card.right <= innerWidth; })()`)).toBe(true);
  await capture('thread-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);

  // Open its settings leads to the agent's settings, where boite is not ticked yet.
  await page.waitFor(`document.querySelector('${DOCKED} [data-testid="agent-setting-show"]')?.getBoundingClientRect().width > 0`);
  await page.click(`${DOCKED} [data-testid="agent-setting-show"]`);
  await page.waitFor(`window.__boiteTest.workspace.active.page === 'agents' && document.querySelector('[data-testid="agent-project-p-boite"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="agent-project-p-boite"]').checked`)).toBe(false);

  await page.evaluate(`window.__boiteTest.workspace.select(window.__boiteTest.workspace.active, ${JSON.stringify(ids.thread)})`);
  await page.waitFor(`document.querySelector('${DOCKED} [data-testid="agent-setting-apply"]')?.getBoundingClientRect().width > 0`);
  await page.click(`${DOCKED} [data-testid="agent-setting-apply"]`);

  // The timeline keeps one row saying it was applied, and the thread hears it.
  await page.waitFor(`document.querySelector('[data-testid="agent-setting-card"][data-outcome="applied"]')`);
  expect(await page.text('[data-testid="agent-setting-card"][data-outcome="applied"] [data-testid="agent-setting-subject"]')).toBe('Scout · Projects: boite');
  await page.waitFor(`window.__boiteTest.workspace.active.openThread?.messages.some(m => m.role === 'user' && m.parts.some(p => p.type === 'text' && p.text.includes("applied: Scout's projects are now")))`);
  await capture('thread-applied-desktop.png');

  // The agent's settings now show the project.
  await page.evaluate(`window.__boiteTest.workspace.active.showAgents(${JSON.stringify(ids.agent)}, 'settings')`);
  await page.waitFor(`document.querySelector('[data-testid="agent-project-p-boite"]')?.checked === true`);
}, 60000);

test('a persistent agent\'s card stands in its conversation', async () => {
  await page.navigate(`http://127.0.0.1:${port}/?fake=1&agents=1`);
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  await page.waitFor(`document.querySelector('[data-testid="view-agents"]')`);
  await page.evaluate(`window.__boiteTest.workspace.active.showAgents()`);
  const card = '[data-testid="agent-transcript"] [data-testid="agent-setting-card"][data-state="pending"]';
  await page.waitFor(`document.querySelector('${card} [data-testid="agent-setting-project"][data-project="p-notes"]')?.checked === true`);
  expect(await page.text(`${card} [data-testid="agent-setting-heading"]`)).toBe('Suggested change to Mira');
  await page.evaluate(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`);
  await capture('agent-desktop.png');

  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  // A phone opens on the list of conversations.
  await page.waitFor(`document.querySelector('[data-testid^="agent-entry-"]')?.getBoundingClientRect().width > 0 || document.querySelector('${card}')?.getBoundingClientRect().width > 0`);
  await page.evaluate(`document.querySelector('${card}')?.getBoundingClientRect().width > 0 || document.querySelector('[data-testid^="agent-entry-"]').click()`);
  await page.waitFor(`document.querySelector('${card}')?.getBoundingClientRect().width > 0`);
  await page.evaluate(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`);
  expect(await page.evaluate(`(() => { const box = document.querySelector('${card}').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })()`)).toBe(true);
  await capture('agent-phone.png');

  // Refuse answers it from the conversation, and the card leaves it.
  await page.click(`${card} [data-testid="agent-setting-refuse"]`);
  await page.waitFor(`!document.querySelector('${card}')`);
}, 60000);
