import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import { BrowserPage, freePort } from './lib/cdp.ts';
import { startUi } from './lib/ui.ts';

let page: BrowserPage;
let server: { close(): Promise<void> };
let base = '';
beforeAll(async () => {
  const port = await freePort();
  server = await startUi(port);
  base = `http://127.0.0.1:${port}`;
  // The Agents page is an experiment; the rest of this file drives it.
  page = await BrowserPage.launch({ url: `${base}/?fake=1`, experiments: ['resident-agents'] });
  await page.waitFor(`document.querySelector('[data-testid="view-agents"]')`);
}, 60000);

/** A conversation is the page; its other panes wait in the header's menu. */
async function openPane(pane: string) {
  await page.click('[data-testid="agent-panes"]');
  await page.click(`[data-value="${pane}"]`);
}

async function missionJourney() {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`document.querySelector('[data-testid="agent-entry-' + window.__agentsFixture.first.id + '"]').click()`);
  await openPane('memory');
  await page.click('[data-testid="agent-memory-add"]');
  await page.type('.agent-knowledge form input', 'Prototype preference');
  await page.type('.agent-knowledge form textarea', 'Prefer small offline prototypes.');
  await page.click('.agent-knowledge form button.primary');
  await page.waitFor(`document.querySelector('.agent-knowledge summary')?.textContent.includes('Prototype preference')`);
  await page.click('.agent-knowledge summary');
  await page.evaluate(`Array.from(document.querySelectorAll('.agent-knowledge button')).find(b => b.textContent === 'Edit').click()`);
  await page.type('.agent-knowledge form textarea', 'Keep the prototype playable in five minutes.');
  await page.click('.agent-knowledge form button.primary');
  await page.waitFor(`document.querySelector('.agent-knowledge').textContent.includes('Keep the prototype playable')`);
  await capture('agents-memory-desktop.png');

  // A mission starts inside the conversation it belongs to, with that conversation's team and members.
  await page.evaluate(`document.querySelector('[data-testid="agent-entry-' + window.__agentsFixture.group.id + '"]').click()`);
  await openPane('missions');
  await page.click('[data-testid="agent-mission-new"]');
  await page.type('[data-testid="agent-name"]', 'Prototype review');
  await page.type('[data-testid="agent-editor"] textarea', 'Describe a small playable prototype.');
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="agent-editor"] input[type="checkbox"]')).filter(c => c.checked).length`)).toBe(3);
  await page.click('[data-testid="agent-save"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-mission-finish"]')`);
  await page.evaluate(`Array.from(document.querySelectorAll('.agents-main button')).find(b => b.textContent === 'Add task').click()`);
  await page.type('[data-testid="agent-task-title"]', 'Present the proposal');
  await page.click('.agents-main form button.primary');
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
  await page.waitFor(`document.querySelector('.agents-main [data-status="done"]')`);

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
  // The thread list shows the agent waiting on the user; its thread says whose it is and leads back to it.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`window.__boiteTest.workspace.active.showChat()`);
  await page.waitFor(`document.querySelector('[data-testid="agents-at-work"]')?.textContent.includes('Mira')`);
  await page.waitFor(`document.querySelector('[data-testid="agents-at-work"]').textContent.includes('Needs you')`);
  await capture('agents-at-work-desktop.png');
  await page.evaluate(`(async () => { const { workspace } = window.__boiteTest; const snap = await workspace.active.client.call('agents.snapshot', {}); const work = snap.work.find(w => w.id === snap.decisions.at(-1).workId); await workspace.active.open(snap.runs.find(r => r.id === work.runId).threadId); })()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-owner-bar"]')?.textContent.includes('Mira runs this thread')`);
  expect(await page.evaluate(`!!document.querySelector('[data-testid="composer"]')`)).toBe(false);
  await capture('agents-owned-thread-desktop.png');
  await page.click('[data-testid="agent-owner-open"]');
  await page.waitFor(`document.querySelector('.agent-ask [data-testid="agent-decision"]')?.textContent.includes('Puzzle')`);
  expect(await page.evaluate(`document.querySelector('.agent-ask').textContent`)).toContain('Which prototype should I explore?');
  await capture('agents-decision-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  // The question stands in the conversation where it was asked, on a phone too.
  await page.waitFor(`document.querySelector('.agents-main [data-testid="agent-decision"]')`);
  await capture('agents-decision-phone.png');
  await page.evaluate(`Array.from(document.querySelectorAll('.agents-main [data-testid="agent-decision"] button')).find(b => b.textContent === 'Puzzle').click()`);
  await page.waitFor(`!document.querySelector('[data-testid="agent-decision"]')`);
  expect(await page.evaluate(`(async () => { const { workspace } = window.__boiteTest; return (await workspace.active.client.call('agents.snapshot', {})).decisions.at(-1).answer; })()`)).toBe('Puzzle');
}
afterAll(async () => { await page?.close(); await server?.close(); }, 15000);

async function settled() {
  await page.evaluate(`Promise.all([document.fonts.ready, ...document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))])`);
}
async function capture(name: string) { await settled(); await page.screenshot(join(import.meta.dir, '.artifacts', name)); }

test('create, converse, configure the resident engine and follow background work on desktop and phone', async () => {
  // The Agents list is the thread list's column: same place, same width, same
  // card beside it, and the title bar's fold button stays.
  const layout = `(() => { const r = s => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && [b.left, b.top, b.width, b.height].map(Math.round); };
    return { rail: r('[data-testid="sidebar"]') ?? r('.agents-rail'), card: r('.body main'), fold: !!document.querySelector('[data-testid="sidebar-toggle"]') }; })()`;
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.waitFor(`document.querySelector('[data-testid="sidebar"]') && document.querySelector('.body main')`);
  await settled();
  const threads = await page.evaluate<{ rail?: number[]; card?: number[]; fold: boolean }>(layout);
  expect(threads.rail?.[2]).toBeGreaterThan(0);
  await page.click('[data-testid="view-agents"]');
  await page.waitFor(`document.querySelector('[data-testid="agents-page"]')`);
  await settled();
  expect(await page.evaluate(layout)).toEqual(threads);
  // Folding from the title bar hides the Agents list as it hides the thread list.
  await page.click('[data-testid="sidebar-toggle"]');
  await page.waitFor(`getComputedStyle(document.querySelector('.agents-rail')).display === 'none'`);
  // One fold for both lists: the thread list comes back folded too.
  expect(await page.evaluate(`window.__boiteTest.workspace.active.sidebarCollapsed`)).toBe(true);
  await page.click('[data-testid="sidebar-toggle"]');
  await page.waitFor(`getComputedStyle(document.querySelector('.agents-rail')).display !== 'none'`);
  await settled();
  expect(await page.evaluate(layout)).toEqual(threads);
  // Closing the search unmounts the field under the focus: it lands back on the toggle.
  await page.click('[data-testid="agents-search-toggle"]');
  await page.waitFor(`document.activeElement?.matches('.agents-rail .agents-search input')`);
  await page.evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.waitFor(`!document.querySelector('.agents-rail .agents-search')`);
  expect(await page.evaluate(`document.activeElement?.dataset.testid`)).toBe('agents-search-toggle');
  await capture('agents-welcome-desktop.png');
  await page.click('[data-testid="agents-create"]');
  await page.waitFor(`document.querySelector('[data-testid="agents-create-menu"]')`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="agents-create-menu"] [data-value]')).map(i => i.dataset.value)`)).toEqual(['profile', 'group']);
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
  await openPane('memory');
  await page.waitFor(`document.querySelector('[data-testid="agent-brain-memory"]')`);
  await page.type('[data-testid="agent-brain-memory"]', 'Keep prototypes private until reviewed.');
  await page.click('[data-testid="agent-brain"] button.primary');
  await page.waitFor(`!document.querySelector('[data-testid="agent-brain"] button.primary').disabled`);
  await capture('agents-brain-desktop.png');
  await page.click('[data-testid="agent-tab-routines"]');
  await page.type('[data-testid="routine-prompt"]', 'Morning review of current ideas, then one proposal.');
  await page.click('[data-testid="schedule-mode-days"]');
  await page.click('[data-testid="schedule-day-6"]');
  expect(await page.evaluate(`document.querySelector('[data-testid="schedule-summary"]').textContent`)).toMatch(/^ ?Every Monday, .*Friday,? and Saturday at 9:00 AM · Next: /);
  await page.click('[data-testid="routine-save"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-routines"] article')?.textContent.includes('Morning review')`);
  await capture('agents-routines-desktop.png');
  await openPane('settings');
  await page.waitFor(`document.querySelector('[data-testid="agent-runtime"]')`);
  await capture('agents-runtime-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('agents-runtime-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

  await page.evaluate(`(async () => {
    const { workspace } = window.__boiteTest;
    const c = workspace.active.client;
    const first = (await c.call('agents.snapshot', {})).profiles[0];
    const second = await c.call('agents.profile.save', { value: { ...first, name: 'Atlas', domain: 'Implementation', avatar: '' } });
    const third = await c.call('agents.profile.save', { value: { ...first, name: 'Lin', domain: 'Review', avatar: '' } });
    const group = await c.call('agents.group.save', { value: { name: 'Ideas table', memberIds: [first.id, second.id, third.id], mode: 'round', maxTurns: 6, maxTurnsPerAgent: 2, paused: false } });
    const team = await c.call('agents.team.save', { value: { name: 'Prototype studio', description: 'Private experiments and small prototypes.', members: [{ agentId: first.id, responsibility: 'Explore' }, { agentId: second.id, responsibility: 'Build' }, { agentId: third.id, responsibility: 'Review' }], projectIds: [], groupId: group.id, paused: false } });
    window.__agentsFixture = { group, team, first, second, third };
    await c.call('agents.message.send', { scope: { kind: 'group', id: group.id }, text: 'Compare two prototype ideas.', recipientIds: [], requestId: 'e2e_background_001' });
    workspace.active.showChat();
  })()`);
  await page.waitFor(`!document.querySelector('[data-testid="agents-page"]')`);
  await page.waitFor(`(async () => { const { workspace } = window.__boiteTest; return (await workspace.active.client.call('agents.snapshot', {})).work.every(w => w.status === 'done'); })()`);
  await page.click('[data-testid="view-agents"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-entry-' + window.__agentsFixture.group.id + '"]')`);
  await capture('agents-directory-desktop.png');
  await page.evaluate(`window.__boiteTest.setTheme('light')`);
  await page.waitFor(`document.documentElement.dataset.theme === 'light'`);
  await capture('agents-directory-light.png');
  await page.evaluate(`window.__boiteTest.setTheme('dark')`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.evaluate(`document.querySelector('[data-testid="agent-entry-' + window.__agentsFixture.group.id + '"]').click()`);
  await page.waitFor(`document.querySelectorAll('.agent-message').length === 4`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('agents-group-phone.png');
  await page.click('.agents-main .agent-mobile-back');
  await capture('agents-list-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.click('[data-testid=mobile-menu]');
  expect(await page.evaluate(`getComputedStyle(document.querySelector('[data-testid="mobile-agents"]')).display`)).not.toBe('none');
  await page.click('[data-testid=mobile-agents]');
  await missionJourney();
}, 60000);

test('memory past the snapshot window stays reachable through Load earlier', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`(async () => {
    const c = window.__boiteTest.workspace.active.client, agent = window.__agentsFixture.first;
    const scope = { kind: 'agent', id: agent.id };
    for (let i = 0; i < 55; i++) await c.call('agents.memory.save', { value: { scope, title: 'Bulk note ' + i, text: 'Filler', sourceScopes: [scope], sourceRunId: null, expiresAt: null } });
    window.__boiteTest.workspace.active.showChat();
  })()`);
  // A new agents page starts from one bounded snapshot, not from what this page saw being created.
  await page.waitFor(`!document.querySelector('[data-testid="agents-page"]')`);
  await page.click('[data-testid="view-agents"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-entry-' + window.__agentsFixture.first.id + '"]')`);
  await page.evaluate(`document.querySelector('[data-testid="agent-entry-' + window.__agentsFixture.first.id + '"]').click()`);
  await openPane('memory');
  await page.waitFor(`document.querySelector('[data-testid="agent-memories-older"]')`);
  const bulk = `Array.from(document.querySelectorAll('.agent-knowledge summary')).filter(s => s.textContent.includes('Bulk note')).length`;
  expect(await page.evaluate(bulk)).toBe(50);
  expect(await page.evaluate(`document.querySelector('.agent-knowledge').textContent`)).not.toContain('Prototype preference');
  await page.evaluate(`document.querySelector('[data-testid="agent-memories-older"]').scrollIntoView({ block: 'center' })`);
  await capture('agents-history-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('[data-testid="agent-memories-older"]').scrollIntoView({ block: 'center' })`);
  await capture('agents-history-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.click('[data-testid="agent-memories-older"]');
  await page.waitFor(`!document.querySelector('[data-testid="agent-memories-older"]')`);
  expect(await page.evaluate(bulk)).toBe(55);
  await page.evaluate(`document.querySelector('.agent-knowledge summary').scrollIntoView({ block: 'center' })`);
  await capture('agents-history-loaded-phone.png');
  expect(await page.evaluate(`document.querySelector('.agent-knowledge').textContent`)).toContain('Prototype preference');
}, 60000);

test('a thread entrusted from its menu carries on, and its agent reports in its conversation', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // The thread's id stays in the page: the expressions below read it there rather than splicing it into code.
  await page.evaluate(`(async () => {
    const store = window.__boiteTest.workspace.active;
    const thread = store.threads.find(t => t.title === 'Finish the trace tab');
    window.__entrustThreadId = thread.id;
    await store.open(thread.id);
  })()`);
  await page.waitFor(`window.__boiteTest.workspace.active.openThread?.id === window.__entrustThreadId`);
  // The title's menu offers the agents once the directory has read them.
  await page.waitFor(`(() => { const store = window.__boiteTest.workspace.active; return store.page === 'chat'; })()`);
  await page.click('[data-testid="thread-menu-trigger"]');
  await page.waitFor(`document.querySelector('[data-value="entrust"]')`);
  await page.click('[data-value="entrust"]');
  await page.waitFor(`document.querySelector('[data-value="' + window.__agentsFixture.first.id + '"]')`);
  await page.evaluate(`document.querySelector('[data-value="' + window.__agentsFixture.first.id + '"]').click()`);
  await page.waitFor(`(async () => { const s = await window.__boiteTest.workspace.active.client.call('agents.snapshot', {}); return s.messages.filter(m => m.thread?.id === window.__entrustThreadId).map(m => m.thread.event).join() === 'entrusted,done'; })()`);
  await page.evaluate(`window.__boiteTest.workspace.active.showAgents(window.__agentsFixture.first.id)`);
  await page.waitFor(`document.querySelectorAll('[data-testid="agent-thread-event"]').length === 2`);
  expect(await page.evaluate(`Array.from(document.querySelectorAll('[data-testid="agent-thread-event"]')).map(e => e.dataset.event)`)).toEqual(['entrusted', 'done']);
  expect(await page.evaluate(`document.querySelector('[data-testid="agent-thread-event"][data-event="entrusted"]').textContent`)).toContain('took over "Finish the trace tab"');
  await page.evaluate(`document.querySelector('[data-testid="agent-thread-event"][data-event="done"]').scrollIntoView({ block: 'center' })`);
  await capture('agents-entrusted-desktop.png');
  await page.click('[data-testid="agent-thread-event"][data-event="done"] [data-testid="agent-thread-event-open"]');
  await page.waitFor(`window.__boiteTest.workspace.active.page === 'chat' && window.__boiteTest.workspace.active.openThread?.id === window.__entrustThreadId`);
}, 60000);

test('a new agent runs on the machine picked in its form, and opens there', async () => {
  await page.navigate(`${base}/?fake=1&machines=1`);
  await page.waitFor(`window.__boiteTest?.workspace.machines.length === 2 && window.__boiteTest.workspace.machines.every(m => m.store.connection === 'ready')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid="view-agents"]');
  await page.waitFor(`document.querySelector('[data-testid="agents-create"]')`);
  await page.click('[data-testid="agents-create"]');
  await page.click('[data-value="profile"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-machine"]')`);
  // The form opens on the machine the page shows; the other connected one is a choice.
  expect(await page.evaluate(`document.querySelector('[data-testid="agent-machine"]').textContent.trim()`)).not.toBe('Builder');
  await page.click('[data-testid="agent-machine"]');
  await page.waitFor(`document.querySelector('[data-value="http://builder.test"]')`);
  await capture('agents-editor-machines-desktop.png');
  await page.click('[data-value="http://builder.test"]');
  await page.waitFor(`document.querySelector('[data-testid="agent-machine"]').textContent.includes('Builder')`);
  await page.type('[data-testid="agent-name"]', 'Scout');
  await page.type('[data-testid="agent-instructions"]', 'Watch the build machine.');
  await capture('agents-editor-builder-desktop.png');
  // The robot's style opens under the identity, and the same button closes it.
  await page.click('[data-testid="robot-customize"]');
  await page.waitFor(`document.querySelector('.agent-dressing')`);
  await capture('agents-editor-robot-desktop.png');
  await page.click('[data-testid="robot-customize"]');
  await page.waitFor(`!document.querySelector('.agent-dressing')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('agents-editor-builder-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid="agent-save"]');
  // Created on Builder's core alone, and the page follows it there.
  await page.waitFor(`window.__boiteTest.workspace.active.machineId === 'http://builder.test' && document.querySelector('[data-testid="agent-message-input"]')`);
  const names = `(async () => Object.fromEntries(await Promise.all(window.__boiteTest.workspace.machines.map(async m => [m.label, (await m.store.client.call('agents.snapshot', {})).profiles.map(a => a.name)]))))()`;
  const byMachine = await page.evaluate<Record<string, string[]>>(names);
  expect(byMachine['Builder']).toContain('Scout');
  expect(Object.entries(byMachine).filter(([label]) => label !== 'Builder').flatMap(([, list]) => list)).not.toContain('Scout');
  await capture('agents-created-on-builder-desktop.png');
}, 60000);
