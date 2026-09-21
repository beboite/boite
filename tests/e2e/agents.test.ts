import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let page: BrowserPage;
let server: { close(): Promise<void> };
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  page = await BrowserPage.launch({ url: `http://127.0.0.1:${port}/?fake=1` });
  await page.waitFor(`document.querySelector('[data-testid="nav-agents"]')`);
}, 60000);

async function missionJourney() {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid="agents-category-profile"]');
  await page.evaluate(`document.querySelector('[data-testid="agent-entry-' + window.__agentsFixture.first.id + '"]').click()`);
  await page.evaluate(`Array.from(document.querySelectorAll('.agent-detail-tabs button')).find(b => b.textContent === 'Memory').click()`);
  await page.click('[data-testid="agent-memory-add"]');
  await page.type('.agent-knowledge form input', 'Prototype preference');
  await page.type('.agent-knowledge form textarea', 'Prefer small offline prototypes.');
  await page.click('.agent-knowledge form button.primary');
  await page.waitFor(`document.querySelector('.agent-knowledge summary')?.textContent.includes('Prototype preference')`);
  await page.click('.agent-knowledge summary');
  await page.evaluate(`Array.from(document.querySelectorAll('.agent-knowledge button')).find(b => b.textContent === 'Configure').click()`);
  await page.type('.agent-knowledge form textarea', 'Keep the prototype playable in five minutes.');
  await page.click('.agent-knowledge form button.primary');
  await page.waitFor(`document.querySelector('.agent-knowledge').textContent.includes('Keep the prototype playable')`);
  await capture('agents-memory-desktop.png');

  await page.click('[data-testid="agents-create"]');
  await page.click('[data-value="mission"]');
  await page.type('[data-testid="agent-name"]', 'Prototype review');
  await page.type('[data-testid="agent-editor"] textarea', 'Describe a small playable prototype.');
  await page.evaluate(`Array.from(document.querySelectorAll('#app input[type="checkbox"], [data-testid="agent-editor"] input[type="checkbox"]')).find(c => c.closest('label')?.textContent.includes('Atlas')).click()`);
  await page.click('[data-testid="agent-save"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-mission-finish"]')`);
  await page.evaluate(`Array.from(document.querySelectorAll('.agents-content button')).find(b => b.textContent === 'Add task').click()`);
  await page.type('[data-testid="agent-task-title"]', 'Present the proposal');
  await page.click('.agents-content form button.primary');
  await page.waitFor(`document.querySelector('.agent-task button[aria-label="Assign"]')`);
  await page.click('.agent-task button[aria-label="Assign"]');
  await page.evaluate(`document.querySelector('[data-value="' + window.__agentsFixture.second.id + '"]').click()`);
  await page.waitFor(`document.querySelector('.agent-task [data-status="review"]')`);
  await capture('agents-mission-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('agents-mission-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.evaluate(`Array.from(document.querySelectorAll('.agent-task button')).find(b => b.textContent === 'Accept result').click()`);
  await page.waitFor(`!document.querySelector('[data-testid="agent-mission-finish"]').disabled`);
  await page.click('[data-testid="agent-mission-finish"]');
  await page.waitFor(`document.querySelector('.agents-content [data-status="done"]')`);

  await page.evaluate(`(async () => {
    const { workspace } = window.__boiteTest;
    const c = workspace.active.client, agent = window.__agentsFixture.first;
    await c.call('agents.message.send', { scope: { kind: 'agent', id: agent.id }, text: 'Consider a new prototype and ask for a direction.', recipientIds: [], requestId: 'e2e_decision_start' });
  })()`);
  await page.waitFor(`(async () => { const { workspace } = window.__boiteTest; return (await workspace.active.client.call('agents.snapshot', {})).runs.some(r => r.status === 'running'); })()`);
  await page.evaluate(`(async () => {
    const { workspace } = window.__boiteTest; const c = workspace.active.client;
    const run = (await c.call('agents.snapshot', {})).runs.find(r => r.status === 'running');
    await c.call('agents.decision.request', { threadId: run.threadId, prompt: 'Which prototype should I explore?', options: ['Puzzle', 'Simulation'], requestId: 'e2e_decision_request' });
  })()`);
  await page.evaluate(`Array.from(document.querySelectorAll('.agents-overview button')).find(b => b.textContent.includes('needs attention')).click()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-decision"]')`);
  await capture('agents-attention-phone.png');
  await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="agent-decision"] button')).find(b => b.textContent === 'Puzzle').click()`);
  await page.waitFor(`!document.querySelector('[data-testid="agent-decision"]')`);
  expect(await page.evaluate(`(async () => { const { workspace } = window.__boiteTest; return (await workspace.active.client.call('agents.snapshot', {})).decisions.at(-1).answer; })()`)).toBe('Puzzle');
}
afterAll(async () => { await page?.close(); await server?.close(); }, 15000);

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}
async function capture(name: string) { await settled(); await page.screenshot(join(import.meta.dir, '.artifacts', name)); }

test('create, converse, leave background work and inspect the studio on desktop and phone', async () => {
  await page.click('[data-testid="nav-agents"]');
  await page.waitFor(`document.querySelector('[data-testid="agents-page"]')`);
  await page.click('[data-testid="agents-create"]');
  await page.click('[data-value="profile"]');
  await page.type('[data-testid="agent-name"]', 'Mira');
  await page.type('textarea', 'Explore ideas and report useful findings.');
  await capture('agents-editor-desktop.png');
  await page.click('[data-testid="agent-save"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-message-input"]')`);
  await page.type('[data-testid="agent-message-input"]', 'Suggest a small local prototype.');
  await page.click('[data-testid="agent-message-send"]');
  await page.waitFor(`document.querySelectorAll('.agent-message').length >= 2`);
  expect(await page.evaluate(`document.querySelector('[data-testid="agent-transcript"]').textContent`)).toContain('Mira');
  await capture('agents-conversation-desktop.png');

  await page.evaluate(`(async () => {
    const { workspace } = window.__boiteTest;
    const c = workspace.active.client;
    const first = (await c.call('agents.snapshot', {})).profiles[0];
    const second = await c.call('agents.profile.save', { value: { ...first, name: 'Atlas', domain: 'Implementation' } });
    const third = await c.call('agents.profile.save', { value: { ...first, name: 'Lin', domain: 'Review' } });
    const group = await c.call('agents.group.save', { value: { name: 'Ideas table', memberIds: [first.id, second.id, third.id], mode: 'round', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    const team = await c.call('agents.team.save', { value: { name: 'Prototype studio', description: 'Private experiments and small prototypes.', members: [{ agentId: first.id, responsibility: 'Explore' }, { agentId: second.id, responsibility: 'Build' }, { agentId: third.id, responsibility: 'Review' }], projectIds: [], groupId: group.id, paused: false } });
    window.__agentsFixture = { group, team, first, second, third };
    await c.call('agents.message.send', { scope: { kind: 'group', id: group.id }, text: 'Compare two prototype ideas.', recipientIds: [], requestId: 'e2e_background_001' });
    workspace.active.showChat();
  })()`);
  await page.waitFor(`!document.querySelector('[data-testid="agents-page"]')`);
  await page.waitFor(`(async () => { const { workspace } = window.__boiteTest; return (await workspace.active.client.call('agents.snapshot', {})).work.every(w => w.status === 'done'); })()`);
  await page.click('[data-testid="nav-agents"]');
  await page.waitFor(`document.querySelector('[data-testid="agents-scene-toggle"]')`);
  await page.click('[data-testid="agents-scene-toggle"]');
  await page.waitFor(`document.querySelectorAll('.agent-scene-hit').length === 5 && document.querySelector('canvas')?.width > 100`);
  await capture('agents-studio-desktop.png');
  await page.evaluate(`window.__boiteTest.setTheme('light')`);
  await page.waitFor(`document.documentElement.dataset.theme === 'light'`);
  await capture('agents-studio-light.png');
  await page.evaluate(`window.__boiteTest.setTheme('dark')`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.evaluate(`Array.from(document.querySelectorAll('.agent-scene-hit')).find(b => b.textContent.includes('Ideas table')).click()`);
  await page.waitFor(`document.querySelectorAll('.agent-message').length === 4`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('agents-group-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-testid="mobile-agents"]')).display`)).not.toBe('none');
  await page.click('[data-testid="agents-scene-toggle"]');
  await page.waitFor(`document.querySelector('[data-testid="agents-scene"]')`);
  await capture('agents-studio-phone.png');
  await missionJourney();
}, 60000);
