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
    const agent = await store.client.call('agents.profile.save', { value: { name: 'Scout', domain: 'Follows projects', instructions: '', avatar: '', status: 'active', projectIds: [],
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
  // Mira, at rest in the demo, asks from its own thread for a project it lacks.
  const ids = await page.evaluate<{ agent: string; project: string }>(`(async () => {
    const store = window.__boiteTest.workspace.active;
    const snapshot = await store.client.call('agents.snapshot', {});
    const mira = snapshot.profiles.find(p => p.name === 'Mira');
    const threadId = snapshot.sessions.find(s => s.agentId === mira.id).threadId;
    const project = store.projects.find(p => !(mira.projectIds ?? []).includes(p.id));
    await store.client.call('agents.settings.request', { threadId, key: 'projects', value: [...(mira.projectIds ?? []), project.id], reason: 'I can follow its releases too.' });
    store.showAgents(mira.id);
    return { agent: mira.id, project: project.id };
  })()`);
  const card = '.agents-main [data-testid="agent-setting-card"][data-state="pending"]';
  await page.waitFor(`document.querySelector('${card} [data-testid="agent-setting-project"][data-project="${ids.project}"]')?.checked === true`);
  expect(await page.text(`${card} [data-testid="agent-setting-reason"]`)).toContain('I can follow its releases too.');
  await page.evaluate(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`);
  await capture('agent-desktop.png');

  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  // A phone keeps the conversation open full screen, or shows the list first.
  await page.waitFor(`document.querySelector('[data-testid="agent-entry-${ids.agent}"]')?.getBoundingClientRect().width > 0 || document.querySelector('${card}')?.getBoundingClientRect().width > 0`);
  await page.evaluate(`document.querySelector('${card}')?.getBoundingClientRect().width > 0 || document.querySelector('[data-testid="agent-entry-${ids.agent}"]').click()`);
  await page.waitFor(`document.querySelector('${card}')?.getBoundingClientRect().width > 0`);
  await page.evaluate(`document.querySelector('${card}').scrollIntoView({ block: 'center' })`);
  expect(await page.evaluate(`(() => { const box = document.querySelector('${card}').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })()`)).toBe(true);
  await capture('agent-phone.png');

  // Refuse answers it from the conversation, and the card leaves it.
  await page.click(`${card} [data-testid="agent-setting-refuse"]`);
  await page.waitFor(`!document.querySelector('${card}')`);
}, 60000);

test('a bot asks to change its name, picture and instructions; Apply renames it', async () => {
  await page.navigate(`http://127.0.0.1:${port}/?fake=1&agents=1`);
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  await page.waitFor(`document.querySelector('[data-testid="view-agents"]')`);
  const agent = await page.evaluate<string>(`(async () => {
    const store = window.__boiteTest.workspace.active;
    const snapshot = await store.client.call('agents.snapshot', {});
    const mira = snapshot.profiles.find(p => p.name === 'Mira');
    const threadId = snapshot.sessions.find(s => s.agentId === mira.id).threadId;
    const ask = (key, value, reason) => store.client.call('agents.settings.request', { threadId, key, value, reason });
    await ask('name', 'Gargouille (Sécurité)', 'You asked me to take this name.');
    await ask('avatar', 'bot:b.3.1.4.2', 'A face that matches the new name.');
    await ask('instructions', 'Watch the security of every project.\\nReport each finding with its proof.\\n\\nNever push a fix without asking.', 'My role changed with my name.');
    store.showAgents(mira.id);
    return mira.id;
  })()`);
  // The three cards wait in the dock, one page each.
  const card = (key: string) => `[data-testid="activity-question"] [data-testid="agent-setting-card"][data-state="pending"][data-key="${key}"]`;
  const shows = (key: string) => `document.querySelector('${card(key)}')?.getBoundingClientRect().width > 0`;
  await page.waitFor(shows('name'));
  await capture('identity-name-desktop.png');
  await page.click('[data-testid="activity-question-next"]');
  await page.waitFor(shows('avatar'));
  await capture('identity-avatar-desktop.png');
  await page.click('[data-testid="activity-question-next"]');
  await page.waitFor(shows('instructions'));
  expect(await page.text(`${card('instructions')} [data-testid="agent-setting-text"]`)).toContain('Never push a fix without asking.');
  await capture('identity-instructions-desktop.png');

  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  await page.waitFor(`document.querySelector('[data-testid="agent-entry-${agent}"]')?.getBoundingClientRect().width > 0 || ${shows('instructions')}`);
  await page.evaluate(`${shows('instructions')} || document.querySelector('[data-testid="agent-entry-${agent}"]').click()`);
  await page.waitFor(shows('instructions'));
  // A desk the wide layout opened beside the chat covers it on a phone.
  await page.evaluate(`document.querySelector('[data-testid="panel-close"]')?.click()`);
  await page.waitFor(`!document.querySelector('[data-testid="panel-close"]')?.getBoundingClientRect().width`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect(await page.evaluate(`(() => { const box = document.querySelector('${card('instructions')}').getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; })()`)).toBe(true);
  await capture('identity-instructions-phone.png');
  await page.click('[data-testid="activity-question-prev"]');
  await page.waitFor(shows('avatar'));
  await capture('identity-avatar-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);

  await page.click('[data-testid="activity-question-prev"]');
  await page.waitFor(`document.querySelector('${card('name')} [data-testid="agent-setting-apply"]')?.getBoundingClientRect().width > 0`);
  await page.click(`${card('name')} [data-testid="agent-setting-apply"]`);
  await page.waitFor(`document.querySelector('[data-testid="agent-setting-card"][data-outcome="applied"][data-key="name"]')`);
  expect(await page.evaluate(`window.__boiteTest.workspace.active.client.call('agents.snapshot', {}).then(s => s.profiles.find(p => p.id === ${JSON.stringify(agent)}).name)`)).toBe('Gargouille (Sécurité)');
}, 60000);

test('a native event wake setting card works at desktop and phone widths', async () => {
  await page.navigate(`http://127.0.0.1:${port}/?fake=1`);
  await page.waitFor(`document.querySelector('[data-testid="view-agents"]')`);
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  const agentId = await page.evaluate(`(async () => {
    const store = window.__boiteTest.workspace.active;
    const agent = await store.client.call('agents.profile.save', { value: { name: 'Scheduled scout', domain: '', instructions: '', avatar: '', status: 'active', projectIds: [], selection: { providerId: 'echo', accountId: 'a-echo', model: 'echo-1', effort: null, permissionMode: 'default' } } });
    const thread = await store.client.call('threads.create', { projectId: 'p-boite', providerId: 'echo', accountId: 'a-echo' });
    await window.__boiteTest.workspace.select(store, thread.id);
    await store.client.call('turns.start', { threadId: thread.id, prompt: 'Configure the bot.' });
    await store.client.settled();
    await store.client.call('agents.settings.request', { threadId: thread.id, agent: agent.id, key: 'eventWakes', value: false, reason: 'Review project news with the morning and evening routines.' });
    return agent.id;
  })()`) as string;
  const card = '[data-testid="agent-setting-card"][data-key="eventWakes"][data-state="pending"]';
  await page.waitFor(`document.querySelector('${card} [data-testid="agent-setting-apply"]')?.getBoundingClientRect().width > 0`);
  expect(await page.text(card)).toContain('Wake automatically for project and desk events');
  await capture('event-wakes-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await capture('event-wakes-phone.png');
  await page.click(`${card} [data-testid="agent-setting-show"]`);
  await page.waitFor(`document.querySelector('[data-testid="agent-event-wakes"]')`);
  await page.evaluate(`document.querySelector('[data-testid="agent-event-wakes"]').scrollIntoView({ block: 'center' })`);
  await capture('event-wakes-settings-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  await page.evaluate(`document.querySelector('[data-testid="agent-event-wakes"]').scrollIntoView({ block: 'center' })`);
  await capture('event-wakes-settings-desktop.png');
  await page.click('[data-testid="agent-event-wakes"]');
  await page.waitFor(`window.__boiteTest.workspace.active.client.call('agents.runtime.get', { agentId: ${JSON.stringify(agentId)} }).then(c => c.eventWakes === false)`);
  expect(await page.evaluate(`window.__boiteTest.workspace.active.client.call('agents.snapshot', {}).then(s => s.profiles.find(p => p.id === ${JSON.stringify(agentId)}).status)`)).toBe('active');
}, 60_000);
