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
  // The switch over the thread list counts the agent at work and turns to the waiting colour; its thread says whose it is and leads back to it.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`window.__boiteTest.workspace.active.showChat()`);
  await page.waitFor(`document.querySelector('[data-testid="agents-at-work"]')?.dataset.waiting === 'true'`);
  expect(Number(await page.evaluate(`document.querySelector('[data-testid="agents-at-work"]').dataset.count`))).toBeGreaterThan(0);
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
afterAll(async () => { await page?.close(); await server?.close(); }, 30_000);

async function settled() {
  await page.settleAnimations();
}
async function capture(name: string) { await settled(); await page.screenshot(join(import.meta.dir, '.artifacts', name)); }
/**
 * Clicks `target`, then reads where the list and the card beside it stand on
 * every frame, for 400 ms from the first frame that draws `rail` (longer than
 * the fold's slide), so a motion that settles back in place still shows.
 */
async function framesAfter(target: string, rail: string) {
  return page.evaluate<{ rail: number; card: number }[]>(`new Promise((resolve) => {
    const rows = []; let start; const t0 = performance.now();
    const read = () => {
      const now = performance.now(); const list = document.querySelector('${rail}'); const card = document.querySelector('.body main');
      if (list && card) { start ??= now; rows.push({ rail: Math.round(list.getBoundingClientRect().left), card: Math.round(card.getBoundingClientRect().left) }); }
      if (now - t0 < 5000 && (start === undefined || now - start < 400)) requestAnimationFrame(read); else resolve(rows);
    };
    document.querySelector('${target}').click(); requestAnimationFrame(read);
  })`);
}

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
  // The switch changes the rows and the card's content, nothing else: the new
  // list does not slide in from the window's edge with the card in tow.
  const switching = await framesAfter('[data-testid="view-agents"]', '.agents-rail');
  expect(switching.length).toBeGreaterThan(2);
  expect([...new Set(switching.map(f => `${f.rail} ${f.card}`))]).toEqual([`${threads.rail![0]} ${threads.card![0]}`]);
  await settled();
  expect(await page.evaluate(layout)).toEqual(threads);
  // Folding from the title bar hides the Agents list as it hides the thread list.
  await page.click('[data-testid="sidebar-toggle"]');
  await page.waitFor(`getComputedStyle(document.querySelector('.agents-rail')).display === 'none'`);
  // One fold for both lists: the thread list comes back folded too.
  expect(await page.evaluate(`window.__boiteTest.workspace.active.sidebarCollapsed`)).toBe(true);
  // Unfolding still slides the list in from the window's edge.
  const unfolding = await framesAfter('[data-testid="sidebar-toggle"]', '.agents-rail');
  expect(Math.min(...unfolding.map(f => f.rail))).toBeLessThan(threads.rail![0]!);
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
  // A permission picked in the runtime card saves by itself, with no Save button, and reads back after leaving the tab.
  const runtimeButton = (label: string) => `Array.from(document.querySelectorAll('[data-testid="agent-runtime"] button')).find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
  expect(await page.evaluate(`!!document.querySelector('[data-testid="agent-runtime-save"]')`)).toBe(false);
  await page.evaluate(`${runtimeButton('Ask before actions')}.click()`);
  await page.waitFor(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(i => i.textContent.trim() === 'Allow edits')`);
  await page.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(i => i.textContent.trim() === 'Allow edits').click()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-runtime"] [data-testid="save-status"]')?.dataset.state === 'saved'`);
  await page.evaluate(`document.querySelector('[data-testid="agent-runtime"]').scrollIntoView()`);
  await capture('agents-runtime-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('[data-testid="agent-runtime"]').scrollIntoView()`);
  await capture('agents-runtime-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await openPane('memory');
  await openPane('settings');
  await page.waitFor(`!!${runtimeButton('Allow edits')}`);
  // A refused save says so beside the card and the agent keeps its saved permission.
  await page.evaluate(`(() => {
    const c = window.__boiteTest.workspace.active.client, call = c.call.bind(c);
    c.call = (method, params) => method === 'agents.runtime.configure' ? Promise.reject(new Error('The core refused this change.')) : call(method, params);
    window.__restoreRuntime = () => { c.call = call; };
  })()`);
  await page.evaluate(`${runtimeButton('Allow edits')}.click()`);
  await page.waitFor(`Array.from(document.querySelectorAll('[role="menuitem"]')).some(i => i.textContent.trim() === 'Plan only')`);
  await page.evaluate(`Array.from(document.querySelectorAll('[role="menuitem"]')).find(i => i.textContent.trim() === 'Plan only').click()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-runtime"] [data-testid="save-status"]')?.dataset.state === 'error'`);
  expect(await page.evaluate(`(async () => (await window.__boiteTest.workspace.active.client.call('agents.snapshot', {})).profiles.find(p => p.name === 'Mira').selection.permissionMode)()`)).toBe('acceptEdits');
  await page.evaluate(`document.querySelector('[data-testid="agent-runtime"]').scrollIntoView()`);
  await capture('agents-runtime-error-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('[data-testid="agent-runtime"]').scrollIntoView()`);
  await capture('agents-runtime-error-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`window.__restoreRuntime()`);
  await page.evaluate(`document.querySelector('[data-testid="agent-runtime"] [data-testid="save-status"] button').click()`);
  await page.waitFor(`document.querySelector('[data-testid="agent-runtime"] [data-testid="save-status"]')?.dataset.state === 'saved'`);

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

test('archiving an experimental agent requires its exact name on desktop and phone', async () => {
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(`(async () => {
    const store = window.__boiteTest.workspace.active;
    const first = (await store.client.call('agents.snapshot', {})).profiles[0];
    window.__archiveAgent = await store.client.call('agents.profile.save', { value: { ...first, name: 'Pixel', domain: 'Review prototypes', status: 'active' } });
    store.showAgents(window.__archiveAgent.id);
  })()`);
  await page.waitFor(`document.querySelector('.agents-identity')?.textContent.includes('Pixel')`);
  await openPane('settings');
  await page.waitFor(`document.querySelector('[data-testid="agent-editor"]')`);
  await capture('agent-archive-before-desktop.png');
  // Settings save by themselves, but archiving still asks before anything is saved.
  expect(await page.evaluate(`!!document.querySelector('[data-testid="agent-save"]')`)).toBe(false);
  await page.click('[data-testid="agent-editor"] button[aria-label="Status"]');
  await page.click('[data-value="archived"]');
  await page.waitFor(`document.activeElement?.matches('[data-testid="confirm-name"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="confirm-ok"]').disabled`)).toBe(true);
  await page.type('[data-testid="confirm-name"]', 'pixel');
  expect(await page.evaluate(`document.querySelector('[data-testid="confirm-ok"]').disabled`)).toBe(true);
  const status = `(async () => (await window.__boiteTest.workspace.active.client.call('agents.snapshot', {})).profiles.find(a => a.id === window.__archiveAgent.id).status)()`;
  expect(await page.evaluate(status)).toBe('active');
  await capture('agent-archive-desktop.png');
  await page.click('[data-testid="confirm-cancel"]');
  await page.waitFor(`!document.querySelector('[data-testid="confirm-name"]')`);
  expect(await page.evaluate(status)).toBe('active');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.click('[data-testid="agent-editor"] button[aria-label="Status"]');
  await page.click('[data-value="archived"]');
  await page.waitFor(`document.querySelector('[data-testid="confirm-name"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="confirm-name"]').value`)).toBe('');
  await capture('agent-archive-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.type('[data-testid="confirm-name"]', 'Pixel');
  await page.click('[data-testid="confirm-ok"]');
  await page.waitFor(`(async () => (await window.__boiteTest.workspace.active.client.call('agents.snapshot', {})).profiles.find(a => a.id === window.__archiveAgent.id).status === 'archived')()`);
  expect(await page.evaluate(`!!document.querySelector('[data-testid="agent-entry-' + window.__archiveAgent.id + '"]')`)).toBe(false);
  await page.click('.agents-main .agent-mobile-back');
  await page.click('[data-testid="agents-search-toggle"]');
  await page.type('.agents-search input', 'Pixel');
  await page.waitFor(`document.querySelector('[data-testid="agent-entry-' + window.__archiveAgent.id + '"]')?.textContent.includes('Archived')`);
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

  // The list holds every machine's agents, the way the thread list holds every machine's threads.
  const scout = await page.evaluate<string>(`(async () => (await window.__boiteTest.workspace.active.client.call('agents.snapshot', {})).profiles.find(a => a.name === 'Scout').id)()`);
  const local = await page.evaluate<string>(`(async () => {
    const [builder, primary] = ['http://builder.test', null].map(id => window.__boiteTest.workspace.machines.find(m => id ? m.id === id : m.id !== 'http://builder.test').store);
    const { id, revision, createdAt, updatedAt, ...value } = (await builder.client.call('agents.snapshot', {})).profiles.find(a => a.name === 'Scout');
    const saved = await primary.client.call('agents.profile.save', { value: { ...value, name: 'Keeper', projectIds: [] } });
    await window.__boiteTest.workspace.select(primary);
    primary.showAgents();
    return saved.id;
  })()`);
  const onBuilder = `[data-machine-id="http://builder.test"] [data-testid="agent-entry-${scout}"]`;
  const onLocal = `[data-machine-id]:not([data-machine-id="http://builder.test"]) [data-testid="agent-entry-${local}"]`;
  await page.waitFor(`window.__boiteTest.workspace.active.machineId !== 'http://builder.test' && document.querySelector('${onLocal}') && document.querySelector('${onBuilder}')`);
  expect(await page.evaluate(`document.querySelector('[data-machine-id="http://builder.test"] .machine')?.getAttribute('aria-label')`)).toBe('Builder');
  await capture('agents-all-machines-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await capture('agents-all-machines-phone.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  // A row of another machine opens its conversation there.
  await page.click(onBuilder);
  await page.waitFor(`window.__boiteTest.workspace.active.machineId === 'http://builder.test' && document.querySelector('${onBuilder}')?.getAttribute('aria-current') === 'page'`);
  // The machine button narrows the list to one machine, and "All machines" brings the others back.
  await page.click('[data-testid="agents-machine"]');
  await page.click('[data-testid="agents-machine-menu"] [data-value="http://builder.test"]');
  await page.waitFor(`!document.querySelector('${onLocal}') && document.querySelector('[data-testid="agent-entry-${scout}"]')`);
  await page.click('[data-testid="agents-machine"]');
  await page.click('[data-testid="agents-machine-menu"] [data-value="all"]');
  await page.waitFor(`document.querySelector('${onLocal}')`);
}, 60000);

test('an agent answers with pictures, keeps its memory, looks after projects, and its work opens from the menu', async () => {
  await page.navigate(`${base}/?fake=1&agents=1`);
  await page.waitFor(`window.__boiteTest?.workspace.active.connection === 'ready' && document.querySelector('[data-testid="view-agents"]')`);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.click('[data-testid="view-agents"]');
  const mira = `(async () => (await window.__boiteTest.workspace.active.client.call('agents.snapshot', {})).profiles.find(a => a.name === 'Mira'))()`;
  const agent = await page.evaluate<{ id: string; projectIds: string[] }>(mira);
  expect(agent.projectIds).toHaveLength(1);
  await page.waitFor(`document.querySelector('[data-testid="agent-entry-${agent.id}"]')`);
  await page.click(`[data-testid="agent-entry-${agent.id}"]`);
  // The reply carries its picture, drawn inline, and the quiet memory chip under it; the notice wears its own label.
  await page.waitFor(`document.querySelector('[data-testid="agent-files"] img')?.complete && document.querySelector('[data-testid="agent-files"] img').naturalWidth > 0`);
  await page.waitFor(`document.querySelector('[data-testid="agent-memory"]')?.dataset.status === 'done'`);
  expect(await page.evaluate(`document.querySelector('[data-testid="agent-notice"]').textContent`)).toContain('About your projects');
  expect(await page.evaluate(`!!document.querySelector('[data-testid="agent-planned-result"]')`)).toBe(false);
  expect(await page.evaluate(`document.querySelector('.agents-identity small').textContent`)).toContain('Looks after');
  await page.click('[data-testid="agent-memory"] button');
  await page.waitFor(`document.querySelector('[data-testid="agent-memory-summary"]')?.textContent.includes('three lines')`);
  await page.evaluate(`document.querySelector('[data-testid="agent-memory"]').scrollIntoView({ block: 'center' })`);
  await capture('agents-files-memory-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('[data-testid="agent-files"]').scrollIntoView({ block: 'center' })`);
  await capture('agents-files-memory-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  // The picture opens in the zoom viewer, on a phone too.
  await page.click('[data-testid="agent-files"] [data-testid="artifact-enlarge"]');
  await page.waitFor(`document.querySelector('[data-testid="image-viewer"]')`);
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.waitFor(`!document.querySelector('[data-testid="image-viewer"]')`);

  // Its settings: the projects it looks after, among the main options.
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await openPane('settings');
  await page.waitFor(`document.querySelector('[data-testid="agent-projects"]')`);
  expect(await page.evaluate(`document.querySelector('[data-testid="agent-project-${agent.projectIds[0]}"]').checked`)).toBe(true);
  expect(await page.evaluate(`!!document.querySelector('[data-testid="agent-projects"]').closest('details')`)).toBe(false);
  await page.evaluate(`document.querySelector('[data-testid="agent-projects"]').scrollIntoView({ block: 'center' })`);
  await capture('agents-editor-projects-desktop.png');
  await page.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await page.evaluate(`document.querySelector('[data-testid="agent-projects"]').scrollIntoView({ block: 'center' })`);
  await capture('agents-editor-projects-phone.png');
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

  // The brain folder: a relative path is refused with the core's sentence, an absolute one takes every brain.
  await page.click('[data-testid="agents-engine"]');
  await page.waitFor(`document.querySelector('[data-testid="agents-brain-root-path"]')`);
  await page.click('[data-testid="agents-brain-root-change"]');
  await page.type('[data-testid="agents-brain-root-input"]', 'agent-brains');
  await page.click('[data-testid="agents-brain-root-save"]');
  await page.waitFor(`document.querySelector('[data-testid="agents-brain-root-error"]')?.textContent.includes('expected an absolute folder')`);
  await page.evaluate(`document.querySelector('[data-testid="agents-brain-root"]').scrollIntoView({ block: 'center' })`);
  await capture('agents-brain-root-desktop.png');
  await page.evaluate(`(() => { const input = document.querySelector('[data-testid="agents-brain-root-input"]'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await page.type('[data-testid="agents-brain-root-input"]', '/srv/agent-brains');
  await page.click('[data-testid="agents-brain-root-save"]');
  await page.waitFor(`document.querySelector('[data-testid="agents-brain-root-path"]').textContent === '/srv/agent-brains' && document.querySelector('[data-testid="agents-brain-root-default"]')`);
  expect(await page.evaluate(`(async () => (await window.__boiteTest.workspace.active.client.call('agents.brain.get', { agentId: '${agent.id}' })).path)()`)).toBe('/srv/agent-brains/mira');

  // Its work opens from the header's menu: the thread it works in, code and all.
  await page.click(`[data-testid="agent-entry-${agent.id}"]`);
  await page.waitFor(`document.querySelector('[data-testid="agent-panes"]')`);
  await page.click('[data-testid="agent-panes"]');
  await page.click('[data-value="see-work"]');
  const session = `(async () => (await window.__boiteTest.workspace.active.client.call('agents.snapshot', {})).sessions.find(s => s.agentId === '${agent.id}' && s.scope.kind === 'agent').threadId)()`;
  const threadId = await page.evaluate<string>(session);
  await page.waitFor(`window.__boiteTest.workspace.active.page === 'chat' && window.__boiteTest.workspace.active.openThread?.id === '${threadId}'`);
}, 60000);
