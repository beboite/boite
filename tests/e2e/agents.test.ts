import { afterAll, beforeAll, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { AgentProfile, AgentsSnapshot, Turn } from '../../packages/contracts/src/index.ts';
import type { CoreClient } from '../../packages/core/src/client.ts';
import { findChromium } from '../../packages/core/src/browser/chromium.ts';
import { quietAgent, startTestCore, testProject, waitFor, type TestCore } from '../../packages/core/test/harness.ts';
import { BrowserPage } from './lib/cdp.ts';
import { ensureProductionUi } from './lib/prod-ui.ts';

/**
 * The Agents page over a real core: the echo agent answers, the production UI
 * runs in a hidden Chromium. An agent's conversation is its thread, so what
 * a thread does (queue, Stop, the panel's browser) is checked on it, and what
 * an agent adds (its introduction, routines, events, its live step in the
 * list) is checked beside it. The tests run in order on one core and one page.
 */
const ARTIFACTS = join(import.meta.dir, '.artifacts', 'agents');
const DESKTOP = { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false };
const PHONE = { width: 390, height: 844, deviceScaleFactor: 1, mobile: true };
const real = findChromium().path ? test : test.skip;
const id = (name: string) => `[data-testid="${name}"]`;

let harness: TestCore;
let owner: CoreClient;
let page: BrowserPage;
let accountId = '';
let projectThread = '';
let mira: { agent: AgentProfile; threadId: string };
/** The page a sign-in card opens, served for the whole file: the phone opens it again. */
let site: ReturnType<typeof Bun.serve>;

const turns = (threadId: string): Turn[] => harness.core.journal.listTurns(threadId);
const free = (threadId: string) => turns(threadId).every(t => t.status !== 'queued' && t.status !== 'running') && !harness.core.threads.runner.handles.has(threadId);
const snapshot = () => owner.call('agents.snapshot', {}) as Promise<AgentsSnapshot>;

/** `waitFor` on the core, failing with the thread's turns so a timeout says where they stood. */
async function until(threadId: string, predicate: () => boolean, timeoutMs: number) {
  await waitFor(predicate, timeoutMs).catch(error => {
    throw new Error(`${String(error)}; turns: ${JSON.stringify(turns(threadId).map(t => [t.execution?.operation ?? 'user', t.status]))}, thread ${harness.core.journal.getThread(threadId)?.status}`);
  });
}

async function capture(name: string) {
  await page.settleAnimations();
  await page.screenshot(join(ARTIFACTS, name));
}

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

/** A frame of the agent's browser drawn on screen, in the tab shown. */
const shownFrame = `[...document.querySelectorAll('${id('remote-browser-frame')}')].some(image => image.complete && image.naturalWidth > 100 && image.getBoundingClientRect().width > 100)`;

/** Writes in the open conversation's composer and sends it. */
async function send(text: string) {
  await page.type('.agents-main [data-testid="composer-input"]', text);
  await page.click('.agents-main [data-testid="composer-send"]');
}

/** An agent saved by the owner, with its introduction ended. */
async function agentOf(name: string, domain: string): Promise<{ agent: AgentProfile; threadId: string }> {
  let agent = await owner.call('agents.profile.save', { value: { name, domain, instructions: domain, avatar: '', status: 'active', projectIds: [],
    selection: { providerId: 'echo', accountId, model: 'echo', effort: null, permissionMode: 'default' } } });
  agent = await quietAgent(owner, agent);
  const { threadId } = await owner.call('agents.open', { agentId: agent.id });
  await waitFor(() => turns(threadId).length > 0 && free(threadId), 15_000);
  return { agent, threadId };
}

beforeAll(async () => {
  ensureProductionUi();
  harness = await startTestCore();
  owner = await harness.connect();
  accountId = (await owner.call('accounts.list', {})).find(a => a.providerId === 'echo')!.id;
  const project = await testProject(harness, owner);
  projectThread = (await owner.call('threads.create', { projectId: project.id, providerId: 'echo', accountId, title: 'Build the landing page' })).id;
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>Dashboard</title><h1>Sign in to the dashboard</h1><form><input placeholder="Email"><button>Continue</button></form>', { headers: { 'content-type': 'text/html' } }) });
  page = await BrowserPage.launch({ url: `${harness.url}/?token=${harness.token}`, experiments: ['resident-agents'], windowSize: { width: DESKTOP.width, height: DESKTOP.height } });
  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  await page.waitFor(`document.querySelector('[data-testid=status-connection]')?.dataset.state === 'ready'`, 30_000);
}, 90_000);
afterAll(async () => {
  await page?.close();
  await harness?.stop();
  await site?.stop(true);
}, 30_000);

test('the Agents list takes the thread list\'s place without moving it, and folds with it', async () => {
  const layout = `(() => { const r = s => { const b = document.querySelector(s)?.getBoundingClientRect(); return b && [b.left, b.top, b.width, b.height].map(Math.round); };
    return { rail: r('[data-testid="sidebar"]') ?? r('.agents-rail'), card: r('.body main'), fold: !!document.querySelector('[data-testid="sidebar-toggle"]') }; })()`;
  await page.waitFor(`document.querySelector('[data-testid="sidebar"]') && document.querySelector('.body main') && document.querySelector('[data-testid="view-agents"]')`);
  await page.settleAnimations();
  const threads = await page.evaluate<{ rail?: number[]; card?: number[]; fold: boolean }>(layout);
  expect(threads.rail?.[2]).toBeGreaterThan(0);
  // The switch changes the rows and the card's content, nothing else.
  const switching = await framesAfter(id('view-agents'), '.agents-rail');
  expect(switching.length).toBeGreaterThan(2);
  expect([...new Set(switching.map(f => `${f.rail} ${f.card}`))]).toEqual([`${threads.rail![0]} ${threads.card![0]}`]);
  await page.settleAnimations();
  expect(await page.evaluate(layout)).toEqual(threads);
  // The title bar's fold hides the Agents list as it hides the thread list; unfolding slides it in from the window's edge.
  await page.click(id('sidebar-toggle'));
  await page.waitFor(`getComputedStyle(document.querySelector('.agents-rail')).display === 'none'`);
  const unfolding = await framesAfter(id('sidebar-toggle'), '.agents-rail');
  expect(Math.min(...unfolding.map(f => f.rail))).toBeLessThan(threads.rail![0]!);
  await page.waitFor(`getComputedStyle(document.querySelector('.agents-rail')).display !== 'none'`);
  await page.settleAnimations();
  expect(await page.evaluate(layout)).toEqual(threads);
}, 60_000);

test('a new agent opens its own thread, where its introduction runs', async () => {
  await page.waitFor(`document.querySelector('${id('agents-empty')}')`);
  await page.click(id('agents-first'));
  await page.type(id('agent-name'), 'Mira');
  await page.type(id('agent-instructions'), 'Look after the landing page and tell me when its build breaks.');
  await page.waitFor(`!document.querySelector('${id('agent-save')}').disabled`);
  await page.click(id('agent-save'));
  // Its thread is on screen, under its header, and the introduction is its first turn.
  await page.waitFor(`document.querySelector('${id('agent-header')}')?.textContent.includes('Mira')`);
  const { profiles, sessions } = await snapshot();
  const agent = profiles.find(p => p.name === 'Mira')!;
  const threadId = sessions.find(s => s.agentId === agent.id)!.threadId;
  mira = { agent: await quietAgent(owner, agent), threadId };
  await page.waitFor(`[...document.querySelectorAll('${id('wake-marker')}')].some(m => m.textContent.includes('Just created'))`);
  await waitFor(() => free(threadId), 15_000);
  const intro = turns(threadId);
  expect(intro.map(t => [t.execution?.operation, t.status])).toEqual([['event', 'done']]);
  // Still on the Agents page, with the introduction's answer in the conversation.
  await page.waitFor(`document.querySelector('${id('agents-page')}') && document.querySelector('.agents-main [data-role="assistant"][data-turn="${intro[0]!.id}"]')`);
  await page.waitFor(`document.querySelector('${id(`agent-entry-${agent.id}`)}')`);
}, 60_000);

test('a message runs as a turn: the list and the header show its step, the next one queues, Stop ends one', async () => {
  const { agent, threadId } = mira;
  const row = id(`agent-entry-${agent.id}`);
  await send('[tool:8000] Check the build of the landing page.');
  // While it works, the row and the header say what it is doing this second.
  await page.waitFor(`document.querySelector('${row}')?.closest('.agent-row')?.dataset.tone === 'working'`);
  await page.waitFor(`document.querySelector('${row} ${id('agent-row-detail')}')?.textContent.includes('fake_tool')`);
  await page.waitFor(`document.querySelector('${id('agent-live')}')?.dataset.state === 'working' && document.querySelector('${id('agent-live')}').textContent.includes('fake_tool')`);
  await capture('working-desktop.png');
  await until(threadId, () => turns(threadId).length === 2 && free(threadId), 20_000);
  await page.waitFor(`document.querySelector('${row}')?.closest('.agent-row')?.dataset.tone !== 'working'`);

  // A message sent while it works waits in the composer's queue, then runs as the next turn.
  await send('[sleep:8000] Read the deploy logs.');
  await until(threadId, () => turns(threadId).at(-1)?.status === 'running', 10_000);
  await send('Then tell me what you found.');
  await page.waitFor(`[...document.querySelectorAll('.agents-main ${id('composer-queued-item')}')].some(i => i.textContent.includes('Then tell me what you found.'))`);
  expect(turns(threadId)).toHaveLength(3);
  await until(threadId, () => turns(threadId).length === 4 && free(threadId), 30_000);
  expect(turns(threadId).map(t => t.status)).toEqual(['done', 'done', 'done', 'done']);
  const opening = harness.core.journal.listMessages(threadId).find(m => m.turnId === turns(threadId)[3]!.id && m.role === 'user');
  expect(opening?.parts).toEqual([expect.objectContaining({ type: 'text', text: 'Then tell me what you found.' })]);
  await page.waitFor(`!document.querySelector('.agents-main ${id('composer-queued-item')}')`);

  // Stop ends a long turn, as in any thread.
  await send('[sleep:60000] Watch the deploy.');
  await until(threadId, () => turns(threadId).at(-1)?.status === 'running', 10_000);
  await page.click(`.agents-main ${id('composer-stop')}`);
  await until(threadId, () => turns(threadId).length === 5 && free(threadId), 10_000);
  expect(turns(threadId).at(-1)!.status).toBe('stopped');
  await page.waitFor(`document.querySelector('${id('agent-live')}')?.dataset.state !== 'working'`);
}, 120_000);

test('Run now on a routine opens a "Routine · <name>" turn, and the list shows the next wake', async () => {
  const { agent, threadId } = mira;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const routine = await owner.call('agents.routine.save', { value: { agentId: agent.id, name: 'Morning check', prompt: 'Look at the landing page build.',
    schedule: { kind: 'daily', time: '09:00', timezone }, enabled: true, nextAt: null, lastTurnId: null, lastScheduledAt: null } });
  await page.waitFor(`document.querySelector('${id(`agent-entry-${agent.id}`)} ${id('agent-row-wake')}')`);
  await page.click(id('agent-menu'));
  await page.click('[data-value="settings"]');
  await page.waitFor(`document.querySelector('${id(`routine-${routine.id}`)} ${id('routine-run')}')?.disabled === false`);
  await page.click(`${id(`routine-${routine.id}`)} ${id('routine-run')}`);
  await until(threadId, () => free(threadId) && turns(threadId).at(-1)?.execution?.operation === 'routine', 15_000).catch(async error => {
    await page.screenshot(join(ARTIFACTS, 'debug-routine.png'));
    throw error;
  });
  await page.waitFor(`[...document.querySelectorAll('${id('wake-marker')}')].some(m => m.textContent.includes('Routine · Morning check'))`, 15_000);
  const ran = turns(threadId).at(-1)!;
  expect(ran.status).toBe('done');
  await waitFor(() => harness.core.workforce.records.get('routine', routine.id)?.lastTurnId === ran.id, 5_000);
  // The settings stayed open through the run and its snapshot updates; a real Escape, sent where the focus is, closes them.
  expect(await page.evaluate(`!!document.querySelector('.agent-sheet:not(.closing)')`)).toBe(true);
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await page.waitFor(`!document.querySelector('.agent-sheet')`);
}, 60_000);

test('a question in a thread on its desk wakes the agent with an event turn', async () => {
  const { agent, threadId } = mira;
  await owner.call('agents.watch', { agentId: agent.id, watchThreadId: projectThread, watched: true });
  const before = turns(threadId).length;
  // The echo agent asks whenever its prompt says question; the card waits for the user.
  await owner.call('turns.start', { threadId: projectThread, prompt: 'Which hero picture do you want? question' });
  await waitFor(() => harness.core.threads.listQuestions(projectThread).length === 1, 10_000);
  // Facts gather for 30 s before one event turn starts.
  await waitFor(() => turns(threadId).length > before && free(threadId), 60_000);
  const event = turns(threadId).at(-1)!;
  expect(event.execution?.operation).toBe('event');
  expect(event.status).toBe('done');
  await page.waitFor(`[...document.querySelectorAll('${id('wake-marker')}')].some(m => /project event/.test(m.textContent))`, 10_000);
  const { watches } = await snapshot();
  expect(watches.find(w => w.threadId === projectThread)).toMatchObject({ agentId: agent.id, state: 'needs-you', question: expect.objectContaining({ options: ['Short', 'Long'] }) });
}, 90_000);

real('Open on a sign-in card shows the browser in the panel beside the conversation, on the Agents page', async () => {
  // What `boite ask --open` asks from the agent's thread.
  await owner.call('questions.ask', { threadId: mira.threadId, text: 'Sign in to the dashboard so I can read the deploy logs.', options: ['Signed in', 'Skip'], open: `${site.url.href}login` });
  await page.waitFor(`document.querySelector('.agents-main ${id('question-open')}')`, 10_000);
  await page.click(`.agents-main ${id('question-open')}`);
  await page.waitFor(`document.querySelector('${id('right-panel')}')?.getBoundingClientRect().width > 0`, 15_000);
  await page.waitFor(shownFrame, 30_000);
  const last = turns(mira.threadId).at(-1)!.id;
  expect(await page.evaluate(`!!document.querySelector('${id('agents-page')}') && !!document.querySelector('.agents-main [data-turn="${last}"]')`)).toBe(true);
  // The conversation stays beside the panel.
  const boxes = await page.evaluate<{ chat: number; panel: number; chatRight: number; panelLeft: number }>(`(() => {
    const chat = document.querySelector('.agents-chat').getBoundingClientRect(), panel = document.querySelector('${id('right-panel')}').getBoundingClientRect();
    return { chat: chat.width, panel: panel.width, chatRight: chat.right, panelLeft: panel.left };
  })()`);
  expect(boxes.chat).toBeGreaterThan(300);
  expect(boxes.panel).toBeGreaterThan(300);
  expect(boxes.chatRight).toBeLessThanOrEqual(boxes.panelLeft + 1);
  await capture('browser-open-desktop.png');
}, 90_000);

real('three agents in the list; a phone shows the list, then the conversation full screen, then its browser', async () => {
  const nova = await agentOf('Nova', 'Runs the UI tests');
  const iris = await agentOf('Iris', 'Watches the deploys');
  // An agent whose introduction ended rests in the list: its last answer, no live dot.
  const started = Date.now();
  await page.waitFor(`document.querySelector('${id(`agent-entry-${iris.agent.id}`)}')?.closest('.agent-row')?.dataset.tone === 'idle'`, 20_000);
  console.log(`[agents] Iris read idle ${Date.now() - started} ms after its introduction ended`);
  await owner.call('turns.start', { threadId: nova.threadId, prompt: '[tool:60000] Run the UI tests.' });
  const row = id(`agent-entry-${nova.agent.id}`);
  await page.waitFor(`document.querySelectorAll('.agents-rail [data-testid^="agent-entry-"]').length === 3`);
  await page.waitFor(`document.querySelector('${row} ${id('agent-row-detail')}')?.textContent.includes('fake_tool')`);
  // The panel left open beside the open agent (Mira's browser, or a desk) closes for the rail's capture.
  await page.evaluate(`document.querySelector('${id('right-panel')} ${id('panel-close')}')?.click()`);
  await page.waitFor(`!(document.querySelector('${id('right-panel')}')?.getBoundingClientRect().width > 0)`);
  await capture('rail-three-desktop.png');

  await page.send('Emulation.setDeviceMetricsOverride', PHONE);
  await page.waitFor(`document.querySelector('.agents-main')?.getBoundingClientRect().width > 0`);
  // The open conversation fills the phone; its back arrow shows the list.
  await page.waitFor(`document.querySelector('${id('agent-back')}')?.getBoundingClientRect().width > 0`);
  expect(await page.evaluate(`document.querySelector('.agents-main').getBoundingClientRect().width`)).toBe(PHONE.width);
  await page.click(id('agent-back'));
  await page.waitFor(`document.querySelector('.agents-rail')?.getBoundingClientRect().width === ${PHONE.width} && !(document.querySelector('.agents-main')?.getBoundingClientRect().width > 0)`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await capture('rail-three-phone.png');
  await page.click(row);
  await page.waitFor(`document.querySelector('.agents-main')?.getBoundingClientRect().width === ${PHONE.width} && document.querySelector('${id('agent-header')}')?.textContent.includes('Nova')`);
  await page.waitFor(`document.querySelector('${id('agent-live')}')?.textContent.includes('fake_tool')`);
  expect(await page.evaluate(`document.documentElement.scrollWidth <= innerWidth`)).toBe(true);
  await capture('working-phone.png');

  // Mira's sign-in card still waits; Open on the phone shows the browser full screen.
  await page.click(id('agent-back'));
  await page.click(id(`agent-entry-${mira.agent.id}`));
  await page.waitFor(`document.querySelector('${id('agent-header')}')?.textContent.includes('Mira') && document.querySelector('.agents-main ${id('question-open')}')?.getBoundingClientRect().width > 0`);
  await page.click(`.agents-main ${id('question-open')}`);
  await page.waitFor(`document.querySelector('${id('right-panel')}')?.getBoundingClientRect().width === ${PHONE.width}`, 15_000);
  await page.waitFor(shownFrame, 30_000);
  expect(await page.evaluate(`!!document.querySelector('${id('agents-page')}')`)).toBe(true);
  await capture('browser-open-phone.png');

  await page.send('Emulation.setDeviceMetricsOverride', DESKTOP);
  await owner.call('turns.stop', { threadId: nova.threadId });
  expect(page.errors()).toEqual([]);
}, 120_000);
