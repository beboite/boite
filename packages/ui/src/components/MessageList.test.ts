import { afterEach, expect, onTestFinished, vi } from 'vitest';
import { test } from '../test/fake-client';
import { flushSync, mount, unmount } from 'svelte';
import { DEFAULT_DELEGATION_CONFIG, type AgentLetter, type Message } from '@boite/contracts';
import MessageList from './MessageList.svelte';
import { windowStats } from '../lib/message-window';
import { TurnFileCache } from '../lib/turn-files';
import { turnProgressStats } from '../lib/turn-progress.svelte';
import { findHits } from '../lib/find';
import type { Store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import { RightPanelStore } from '../lib/right-panel.svelte';
import AgentMessagesSurface from './AgentMessagesSurface.svelte';
import { AgentsView, openAgent } from '../lib/agents.svelte';
import { setExperiment } from '../lib/experiments';

/**
 * jsdom has no layout, so the three numbers the window is computed from are
 * stubbed on the prototype: a 600 px viewport, a scroll height of the whole
 * estimated list, and a scrollTop that actually keeps what is written to it.
 * There is no ResizeObserver either, which is exactly the case where every
 * message is still worth its 80 px estimate.
 */
const VIEW_HEIGHT = 600;
const ESTIMATE = 80;

const tops = new WeakMap<Element, number>();
let scrollHeight = 0;

/**
 * What the component asked the layout for. The pin effect is the one thing that
 * reads `scrollHeight` and writes `scrollTop`, so these two count its runs, and
 * the bench below asserts a streaming answer does not run it once per token.
 */
const layout = { reads: 0, writes: 0 };

const original = {
  clientHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight'),
  scrollHeight: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight'),
  scrollTop: Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')
};

function stubLayout(total: number): void {
  scrollHeight = total;
  layout.reads = 0;
  layout.writes = 0;
  Object.defineProperty(Element.prototype, 'clientHeight', {
    configurable: true,
    get: () => VIEW_HEIGHT
  });
  Object.defineProperty(Element.prototype, 'scrollHeight', {
    configurable: true,
    get: () => {
      layout.reads += 1;
      return scrollHeight;
    }
  });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      return tops.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      layout.writes += 1;
      tops.set(this, value);
    }
  });
}

function restoreLayout(): void {
  for (const [name, descriptor] of Object.entries(original)) {
    if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
    else Reflect.deleteProperty(Element.prototype, name);
  }
}

let running: Record<string, unknown> | null = null;

test('the parent timeline retains one team row, updates completion counts and opens the whole team', async ({ createStore }) => {
  const { store: owner, client } = createStore({ delayMs: 0, delegationDemo: true });
  owner.attach(client);
  await owner.connect();
  await owner.open('t-trace');
  await owner.loadDelegation();
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: 't-trace', messages: owner.openThread!.messages } });
  flushSync();
  const row = document.querySelector<HTMLButtonElement>('[data-testid=delegation-activity]')!;
  expect(row.textContent).toContain('Started 4 subagents');
  // The one waiting on its own background work is not completed; the interrupted one says so.
  expect(row.textContent).toContain('1/4 completed');
  expect(row.textContent).toContain('1 interrupted');
  await owner.selectDelegatedAgent('t-team-running');
  // A workflow graph left open in the agents tab gives way to the team, the way the dock opens it.
  const graph = owner.panel.openWorkflow('run-left-open');
  row.click();
  flushSync();
  expect(owner.panel.isOpen).toBe(true);
  expect(owner.delegationSelectedAgentId).toBeNull();
  expect(owner.panel.state.surfaces.find(surface => surface.id === graph.id)?.runId).toBeUndefined();
  const agent = owner.delegation!.agents.find(agent => agent.thread.id === 't-team-running')!;
  agent.thread.status = 'idle';
  agent.lastTurn!.status = 'done';
  agent.lastTurn!.finishedAt = agent.thread.createdAt + 60_000;
  flushSync();
  expect(document.querySelectorAll('[data-testid=delegation-activity]')).toHaveLength(1);
  expect(row.textContent).toContain('2/4 completed');
  expect(row.querySelector('[data-testid=agent-elapsed]')?.textContent).toContain('1');
  // A child transcript must not claim that it launched its siblings.
  await unmount(running); running = null;
  await owner.open('t-team-done');
  await owner.loadDelegation();
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: 't-team-done', messages: owner.openThread!.messages } });
  flushSync();
  expect(document.querySelector('[data-testid=delegation-activity]')).toBeNull();
});

afterEach(async () => {
  if (running) await unmount(running, { outro: false });
  running = null;
  restoreLayout();
  document.body.innerHTML = '';
});

test('one model label covers a turn split across text and separate attachments, which close the finished turn, and the next turn names its own model', async ({ createStore }) => {
  const { store: owner, client } = createStore({ delayMs: 0 });
  owner.attach(client);
  await owner.connect();
  await owner.open('t-trace');
  const thread = owner.openThread!;
  const first = thread.turns[0]!;
  first.execution = { ...thread, providerId: 'codex', accountId: 'a-codex', model: 'gpt-6.1-sol', sessionGeneration: 0, selectionVersion: 0 };
  thread.turns.push({ ...first, id: 'turn-next', execution: { ...first.execution, model: 'gpt-6-astra' } });
  const files = ['README.md', 'review-small.mp4', 'NOTES.md'].map((name, index): Message => ({
    id: `m-file-${index}`, threadId: thread.id, turnId: first.id, role: 'assistant', state: 'complete', createdAt: index * 2 + 1,
    parts: [{ type: 'file', name, mimeType: name.endsWith('.mp4') ? 'video/mp4' : 'text/markdown', data: 'ZmlsZQ==' }]
  }));
  // Published before, between and after what the agent wrote: the finished turn shows them under its last words.
  thread.messages = [
    files[0]!,
    { id: 'm-intro', threadId: thread.id, turnId: first.id, role: 'assistant', state: 'complete', createdAt: 2, parts: [{ type: 'text', text: 'Here are the files.' }] },
    files[1]!,
    { id: 'm-outro', threadId: thread.id, turnId: first.id, role: 'assistant', state: 'complete', createdAt: 4, parts: [{ type: 'text', text: 'That is all.' }] },
    files[2]!,
    { id: 'm-next', threadId: thread.id, turnId: 'turn-next', role: 'assistant', state: 'streaming', createdAt: 7, parts: [{ type: 'text', text: 'Next answer.\n\n' }] }
  ];
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: thread.id, messages: thread.messages } });
  flushSync();
  const labels = [...document.querySelectorAll('[data-testid=message-model]')];
  expect(labels).toHaveLength(2);
  expect(labels[0]!.closest('[data-mid]')?.getAttribute('data-mid')).toBe('m-intro');
  expect(labels[1]!.textContent).toContain('gpt-6-astra');
  expect([...document.querySelectorAll('[data-mid^=m-]')].map(node => node.getAttribute('data-mid')))
    .toEqual(['m-intro', 'm-outro', 'm-file-0', 'm-file-1', 'm-file-2', 'm-next']);
  expect(document.querySelector('[data-mid=m-file-2]')?.querySelector('[data-testid=turn-summary]')).not.toBeNull();
});

/**
 * Nothing in this component touches the store unless a permission part is
 * rendered or the list is paged: `messagesBefore` null is a thread whose first
 * message is already loaded, which is every test but the paging ones.
 */
const store = {
  permissionRequests: {},
  answer: async () => {},
  messagesBefore: null,
  loadingOlder: false,
  loadOlder: async () => 0,
  releaseOlder: () => 0,
  workflowsOf: () => []
} as unknown as Store;

test('a workflow the thread started is one card that opens its graph, and a step shows none', async ({ createStore }) => {
  const { store: owner, client } = createStore({ delayMs: 0, delegationDemo: true });
  owner.attach(client);
  try {
    await owner.connect();
    await owner.open('t-trace');
    await owner.loadWorkflows('t-trace');
    running = mount(MessageList, { target: document.body, props: { store: owner, threadId: 't-trace', messages: owner.openThread!.messages } });
    flushSync();
    const cards = document.querySelectorAll<HTMLButtonElement>('[data-testid=workflow-activity]');
    expect(cards).toHaveLength(1);
    const run = owner.workflowsOf('t-trace')[0]!;
    expect(cards[0]!.textContent).toContain('Review the parser');
    expect(cards[0]!.textContent).toContain('1/5 steps');
    expect(cards[0]!.querySelectorAll('.phases i')).toHaveLength(4);
    cards[0]!.click();
    flushSync();
    expect(owner.panel.active).toMatchObject({ kind: 'agents', runId: run.id });
    await unmount(running); running = null;
    const step = run.nodes.find(node => node.id === 'review')!.instances[1]!.threadId!;
    await owner.open(step);
    await owner.loadWorkflows(step);
    running = mount(MessageList, { target: document.body, props: { store: owner, threadId: step, messages: owner.openThread!.messages } });
    flushSync();
    expect(document.querySelector('[data-testid=workflow-activity]')).toBeNull();
  } finally { window.localStorage.clear(); }
});

test('system coordination messages show their display text outside the user bubble', () => {
  stubLayout(200);
  const messages: Message[] = [{
    id: 'm-system', threadId: 't-short', turnId: 'turn-system', role: 'system', state: 'complete', createdAt: 1,
    parts: [{ type: 'text', text: 'Boite agent coordination. Internal delivery envelope', displayText: 'Agent coordination' }]
  }];
  running = mount(MessageList, { target: document.body, props: { store, threadId: 't-short', messages } });
  flushSync();
  expect(document.querySelector('[data-testid="message-system"]')?.getAttribute('aria-label')).toBe('System');
  expect(document.querySelector('[data-testid="message-system"]')?.textContent?.trim()).toBe('Agent coordination');
  expect(document.querySelector('[data-testid="message"]')?.textContent).toContain('Agent coordination');
  expect(document.querySelector('[data-testid="message"]')?.textContent).not.toContain('Internal delivery envelope');
  expect(document.querySelector('.bubble')).toBeNull();
});

test('cache pings are one quiet line between the turns they sit in, with no answer, summary or bubble', () => {
  stubLayout(400);
  const ping = (n: number) => ({ id: `turn-ping-${n}`, threadId: 't-short', status: 'done', queuedAt: n, startedAt: n, finishedAt: n, usage: null, error: null, execution: { operation: 'keepalive', automatic: true } });
  const messages: Message[] = [
    { id: 'm-answer', threadId: 't-short', turnId: 'turn-real', role: 'assistant', state: 'complete', createdAt: 1, parts: [{ type: 'text', text: 'Agents started' }] },
    ...[2, 3].flatMap((n): Message[] => [
      { id: `m-ping-${n}`, threadId: 't-short', turnId: `turn-ping-${n}`, role: 'system', state: 'complete', createdAt: n * 10, parts: [{ type: 'text', text: 'Reply with the single word ok.', displayText: 'Prompt cache kept warm' }] },
      { id: `m-ok-${n}`, threadId: 't-short', turnId: `turn-ping-${n}`, role: 'assistant', state: 'complete', createdAt: n * 10 + 1, parts: [{ type: 'text', text: 'ok' }] },
    ]),
  ];
  const pinged = { ...store, openThread: { id: 't-short', turns: [ping(2), ping(3)], messages } } as unknown as Store;
  running = mount(MessageList, { target: document.body, props: { store: pinged, threadId: 't-short', messages } });
  flushSync();
  const markers = document.querySelectorAll('[data-testid="keepalive-marker"]');
  expect(markers).toHaveLength(1);
  expect(markers[0]!.textContent).toContain('Prompt cache kept warm 2 times');
  expect(document.querySelectorAll('[data-testid="message"]')).toHaveLength(2);
  expect(document.querySelector('[data-testid="timeline"]')?.textContent).not.toContain('ok');
  expect(document.querySelector('[data-testid="message-system"]')).toBeNull();
});

test('an agent thread folds a finished turn\'s steps behind the count on its summary line and a quiet wake to one line, each opening on a click', async ({ ready }) => {
  setExperiment('resident-agents', true);
  onTestFinished(() => setExperiment('resident-agents', false));
  const { store: owner } = await ready({ delayMs: 0, agentsDemo: true });
  const view = AgentsView.of(owner);
  await view.refresh();
  const mira = view.snapshot!.profiles.find(p => p.name === 'Mira')!;
  await openAgent(owner, mira.id);
  stubLayout(1200);
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: owner.openThread!.id, messages: owner.openThread!.messages } });
  flushSync();
  const timeline = () => document.querySelector('[data-testid="timeline"]')!.textContent ?? '';
  const folds = () => [...document.querySelectorAll<HTMLElement>('[data-testid="turn-fold"]')];
  // Its evening routine had nothing to report: one line, its opening and its two calls folded inside.
  const quiet = folds().find(fold => fold.dataset.kind === 'quiet')!;
  expect(quiet.textContent).toContain('Nothing to report · 4 issues, 2 pull requests, nothing new · 2 steps');
  expect(document.querySelector('[data-testid="wake-marker"]')).toBeNull();
  expect(timeline()).not.toContain('Nothing needs you tonight');
  expect(document.querySelectorAll('[data-testid="tool-group"], [data-testid="tool-card"]')).toHaveLength(0);
  // Its last memory pass is a mark on the summary line of the answer it followed, its summary in the tooltip.
  const pass = document.querySelector<HTMLElement>('[data-testid="memory-pass"]')!;
  expect(pass.title).toBe('Memory updated · Noted that the welcome screen fits in three lines on a phone.');
  expect(pass.closest('article')?.textContent).toContain('Noted in my memory');
  quiet.querySelector('button')!.click();
  flushSync();
  expect(document.querySelector('[data-testid="wake-marker"]')?.textContent).toContain('Routine · Evening review');
  expect(timeline()).toContain('Nothing needs you tonight');
  expect(document.querySelectorAll('[data-testid="tool-group"], [data-testid="tool-card"]').length).toBeGreaterThan(0);
  quiet.querySelector('button')!.click();
  flushSync();
  await unmount(running);

  // Nova's event turn: its four calls and the narration between them behind "Worked", its answer as its message.
  const nova = view.snapshot!.profiles.find(p => p.name === 'Nova')!;
  await openAgent(owner, nova.id);
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: owner.openThread!.id, messages: owner.openThread!.messages } });
  flushSync();
  // No row above the answer: the summary line under it counts the steps, with the time it worked and when it finished.
  expect(folds().filter(fold => fold.dataset.kind === 'worked')).toHaveLength(0);
  const worked = [...document.querySelectorAll<HTMLElement>('[data-testid="turn-steps"]')];
  // Its answers are signed with its name, not the provider's.
  expect([...document.querySelectorAll('[data-testid="message-model"]')].map(node => node.textContent?.trim())).toContain('Nova');
  expect(timeline()).not.toMatch(/^Echo|\bEcho\b/);
  expect(worked.map(button => button.textContent?.trim())).toEqual(['2 steps', '4 steps']);
  expect(worked[1]!.closest('[data-testid="turn-summary"]')?.textContent).toMatch(/Worked for 2m 0\ds.*done/);
  expect(timeline()).toContain('The login fix opened PR #482');
  expect(timeline()).not.toContain('The e2e job fails; its log names the redirect test.');
  // The running turn keeps its steps open and live.
  expect(timeline()).toContain('Checking the release branch first');
  expect(document.querySelectorAll('[data-testid="tool-group"], [data-testid="tool-card"]').length).toBeGreaterThan(0);
  worked[1]!.click();
  flushSync();
  expect(timeline()).toContain('The e2e job fails; its log names the redirect test.');
  expect(document.querySelectorAll<HTMLElement>('[data-testid="turn-steps"]')[1]?.getAttribute('aria-expanded')).toBe('true');
  document.querySelectorAll<HTMLElement>('[data-testid="turn-steps"]')[1]!.click();
  flushSync();
  expect(timeline()).not.toContain('The e2e job fails; its log names the redirect test.');
});

test('a line Boite writes on a wake turn stays a line of its own: only the prompt that opened the turn is its wake row', async ({ ready }) => {
  setExperiment('resident-agents', true);
  onTestFinished(() => setExperiment('resident-agents', false));
  const { store: owner } = await ready({ delayMs: 0, agentsDemo: true });
  const view = AgentsView.of(owner);
  await view.refresh();
  const nova = view.snapshot!.profiles.find(p => p.name === 'Nova')!;
  await openAgent(owner, nova.id);
  stubLayout(1200);
  const thread = owner.openThread!;
  const wake = thread.turns.findLast(turn => turn.execution?.operation === 'event' || turn.execution?.operation === 'routine')!;
  const opening = thread.messages.find(message => message.turnId === wake.id)!;
  // The runtime's notice lands on the thread's latest turn, here the wake turn.
  const notice: Message = { id: 'msg_budget_notice', threadId: thread.id, turnId: wake.id, role: 'system', parts: [{ type: 'text', text: 'Skipped routine: past the daily budget.' }], state: 'complete', createdAt: opening.createdAt + 1 };
  const messages = [...thread.messages.filter(message => message.turnId !== wake.id), opening, notice, ...thread.messages.filter(message => message.turnId === wake.id && message.id !== opening.id)];
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: thread.id, messages } });
  flushSync();
  const markers = [...document.querySelectorAll<HTMLElement>('[data-testid="wake-marker"]')];
  // The opening prompt is the wake row; the notice under it is not a second one.
  expect(markers.map(marker => marker.textContent?.includes('Skipped routine'))).toEqual([false]);
  expect(document.querySelector('[data-testid="timeline"]')!.textContent).toContain('Skipped routine: past the daily budget.');
});

test.for([false, true])('the outline rail is left of the bubbles on a desktop and not drawn on a phone (phone: %s)', async (phone, { createStore }) => {
  const { store: owner, client } = createStore({ delayMs: 0 });
  owner.attach(client);
  await owner.connect();
  stubLayout(400);
  const query = vi.spyOn(window, 'matchMedia').mockImplementation(media => Object.assign(new EventTarget(), {
    media, matches: phone && media === '(max-width: 720px)', onchange: null, addListener() {}, removeListener() {}
  }));
  onTestFinished(() => query.mockRestore());
  const messages: Message[] = ['first', 'second'].map((text, index) => ({
    id: `m-${text}`, threadId: 't-trace', turnId: `turn-${index}`, role: 'user', state: 'complete', createdAt: index,
    parts: [{ type: 'text', text }]
  }));
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: 't-trace', messages } });
  flushSync();
  expect(document.querySelectorAll('[data-testid=message]')).toHaveLength(2);
  expect(document.querySelector('[data-testid=message-outline]') !== null).toBe(!phone);
});

test('agent exchange summaries retain chronology without exposing their letters or delivery envelopes', () => {
  stubLayout(400);
  const messages: Message[] = [
    { id: 'm-before', threadId: 't-short', turnId: 'turn-before', role: 'assistant', state: 'complete', createdAt: 10, parts: [{ type: 'text', text: 'Before coordination' }] },
    { id: 'm-envelope', threadId: 't-short', turnId: 'turn-envelope', role: 'system', state: 'complete', createdAt: 21, parts: [{ type: 'text', text: 'Boite agent coordination. Agent messages (JSON data):\n[{"id":"letter-in"}]', displayText: 'Agent coordination' }] },
    { id: 'm-after', threadId: 't-short', turnId: 'turn-after', role: 'assistant', state: 'complete', createdAt: 30, parts: [{ type: 'text', text: 'After coordination' }] }
  ];
  const letters: AgentLetter[] = [
    {
      id: 'letter-in',
      from: { coreId: 'core-build', threadId: 't-deploy', title: 'Deployment agent', machine: 'Build PC', resources: '', status: 'idle', mode: 'team' },
      to: { coreId: 'core-local', threadId: 't-short' }, toTitle: 'Current agent', text: 'Wait before restart.', replyTo: null,
      createdAt: 20, expiresAt: 1000, status: 'received', error: 'Awaiting provider turn trn_internal'
    },
    {
      id: 'letter-out',
      from: { coreId: 'core-local', threadId: 't-short', title: 'Current agent', machine: 'This PC', resources: '', status: 'idle', mode: 'team' },
      to: { coreId: 'core-build', threadId: 't-deploy' }, toTitle: 'Deployment agent', text: 'Restart postponed.', replyTo: 'letter-in',
      createdAt: 40, expiresAt: 1000, status: 'delivered', error: null
    }
  ];
  const coordinated = {
    ...store,
    coordination: {
      self: { coreId: 'core-local', threadId: 't-short' },
      config: { mode: 'team', resources: '', remote: true, paused: false },
      messages: letters, sent: 1, sendLimit: null, wakes: 0, wakeLimit: null
    }
  } as unknown as Store;

  running = mount(MessageList, { target: document.body, props: { store: coordinated, threadId: 't-short', messages } });
  flushSync();

  const rows = articles().map(node => node.textContent ?? '');
  expect(rows).toHaveLength(4);
  expect(rows[0]).toContain('Before coordination');
  // Each exchange stays where it happened, as a row of the discussion with its last words.
  expect(rows[1]).toContain('Deployment agent');
  expect(rows[1]).toContain('Wait before restart.');
  expect(rows[2]).toContain('After coordination');
  expect(rows[3]).toContain('Deployment agent');
  expect(rows[3]).toContain('Restart postponed.');
  const exchanges = [...document.querySelectorAll<HTMLElement>('[data-testid=agent-discussion-row]')];
  expect(exchanges.map(node => node.dataset.peer)).toEqual(['core-build/t-deploy', 'core-build/t-deploy']);
  // Each row says which way it went: received on the right in the accent, sent on this agent's side.
  expect(exchanges.map(node => [node.dataset.way, node.querySelector('[data-testid=agent-discussion-way]')?.textContent?.trim()]))
    .toEqual([['in', 'Received from'], ['out', 'Sent to']]);
  expect(document.body.textContent).not.toContain('Boite agent coordination');
  expect(document.body.textContent).not.toContain('Awaiting provider turn');
});

test('a completed mail-only turn keeps its footer below received and forwarded messages', async ({ createStore }) => {
  const { store: owner, client } = createStore({ delayMs: 0 });
  owner.attach(client); await owner.connect(); await owner.open('t-trace');
  const thread = owner.openThread!;
  const first = { ...thread.turns[0]!, startedAt: 1, finishedAt: 15, status: 'done' as const };
  const next = { ...first, id: 'turn-mail-only', startedAt: 20, finishedAt: 30 };
  const last = { ...first, id: 'turn-next-mail-only', startedAt: 40, finishedAt: 50 };
  thread.memoryEvents = [];
  thread.turns = [first, next, last];
  thread.messages = [
    { id: 'before-mail', threadId: thread.id, turnId: first.id, role: 'assistant', state: 'complete', createdAt: 10, parts: [{ type: 'text', text: 'Previous answer' }] },
    { id: 'hidden-mail', threadId: thread.id, turnId: next.id, role: 'system', state: 'complete', createdAt: 20,
      parts: [{ type: 'text', text: 'Boite agent coordination. Agent messages (JSON data):\n[{"id":"received-mail"},{"id":"received-batch-mail"}]' }] },
    { id: 'hidden-next-mail', threadId: thread.id, turnId: last.id, role: 'system', state: 'complete', createdAt: 40,
      parts: [{ type: 'text', text: 'Boite agent coordination. Agent messages (JSON data):\n[{"id":"next-received-mail"}]' }] }
  ];
  const self = { coreId: 'core-local', threadId: thread.id };
  const peer = { coreId: 'core-peer', threadId: 'peer' };
  const incoming: AgentLetter = { id: 'received-mail', from: { ...peer, title: 'Peer', machine: 'Peer PC', resources: '', status: 'idle', mode: 'brief' },
    to: self, toTitle: thread.title, text: 'Update', replyTo: null, createdAt: 19, expiresAt: 1000, status: 'delivered', error: null };
  owner.coordination = { self, config: { mode: 'brief', resources: '', remote: true, paused: false },
    messages: [incoming, { ...incoming, id: 'received-batch-mail', createdAt: 19 },
      { ...incoming, id: 'forwarded-mail', from: { ...incoming.from, ...self }, to: peer, createdAt: 25 },
      { ...incoming, id: 'next-received-mail', createdAt: 35 }], sent: 1, sendLimit: null, wakes: 0, wakeLimit: null };
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: thread.id, messages: thread.messages } });
  flushSync();
  const footers = [...document.querySelectorAll('[data-testid=turn-summary]')];
  expect(footers).toHaveLength(3);
  expect(footers[1]!.getAttribute('data-status')).toBe('done');
  const groups = [...document.querySelectorAll('[data-testid=agent-message-group]')];
  expect(groups).toHaveLength(2);
  const group = groups[0]!;
  const discussion = group.querySelector<HTMLElement>('[data-testid=agent-discussion-row]')!;
  expect(group.querySelectorAll('[data-testid=agent-discussion-row]')).toHaveLength(1);
  expect(discussion.dataset).toMatchObject({ peer: 'core-peer/peer', count: '3', way: 'both' });
  expect(discussion.querySelector('[data-testid=agent-discussion-title]')?.textContent).toBe('Peer');
  expect(discussion.querySelector('.counts')?.textContent?.replace(/\s/g, '')).toBe('12');
  expect(group.compareDocumentPosition(footers[1]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(groups[1]!.compareDocumentPosition(footers[2]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(document.body.textContent).not.toContain('Boite agent coordination');
});

test('the footer follows outgoing mail at the end of an ordinary answer', async ({ createStore }) => {
  const { store: owner, client } = createStore({ delayMs: 0 });
  owner.attach(client); await owner.connect(); await owner.open('t-trace');
  const thread = owner.openThread!;
  const turn = { ...thread.turns[0]!, startedAt: 1, finishedAt: 30, status: 'done' as const };
  thread.turns = [turn];
  thread.memoryEvents = [];
  thread.messages = [{ id: 'msg-answer-with-mail', threadId: thread.id, turnId: turn.id, role: 'assistant', state: 'complete', createdAt: 20, parts: [{ type: 'text', text: 'Answer before sending' }] }];
  const self = { coreId: 'core-local', threadId: thread.id };
  owner.coordination = { self, config: { mode: 'brief', resources: '', remote: true, paused: false }, messages: [{
    id: 'tail-mail', from: { ...self, title: thread.title, machine: 'This PC', resources: '', status: 'idle', mode: 'brief' },
    to: { coreId: 'core-peer', threadId: 'peer' }, toTitle: 'Peer', text: 'Result forwarded', replyTo: null,
    createdAt: 20, expiresAt: 1000, status: 'delivered', error: null
  }], sent: 1, sendLimit: null, wakes: 0, wakeLimit: null };
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: thread.id, messages: thread.messages } });
  flushSync();
  const footer = document.querySelector('[data-testid=turn-summary]')!;
  const group = document.querySelector('[data-testid=agent-message-group]')!;
  expect(articles().map(node => node.getAttribute('data-mid'))).toEqual(['msg-answer-with-mail', 'coordination:tail-mail']);
  expect(document.querySelectorAll('[data-testid=turn-summary]')).toHaveLength(1);
  expect(group.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

test('a call finished in the running turn rereads only that turn files, never a finished one', async ({ createStore }) => {
  window.localStorage.clear();
  const { store: owner, client } = createStore({ delayMs: 0 });
  owner.attach(client); await owner.connect(); await owner.open('t-trace');
  const thread = owner.openThread!;
  const done = { ...thread.turns[0]!, startedAt: 1, finishedAt: 15, status: 'done' as const };
  const live = { ...done, id: 'turn-live', startedAt: 20, finishedAt: null, status: 'running' as const };
  const write = (path: string) => ({ type: 'tool' as const, toolId: path, name: 'Write', input: { file_path: path, content: 'x' }, output: null, status: 'done' as const });
  thread.memoryEvents = [];
  thread.turns = [done, live];
  thread.messages = [
    { id: 'answer-done', threadId: thread.id, turnId: done.id, role: 'assistant', state: 'complete', createdAt: 10, parts: [write('a.ts')] },
    { id: 'answer-live', threadId: thread.id, turnId: live.id, role: 'assistant', state: 'streaming', createdAt: 20, parts: [write('b.ts')] }
  ];
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: thread.id, messages: thread.messages } });
  flushSync();
  await vi.waitFor(() => expect(document.querySelectorAll('[data-testid=turn-files]')).toHaveLength(2));
  const read = vi.spyOn(TurnFileCache.prototype, 'read');
  onTestFinished(() => read.mockRestore());
  thread.messages[1]!.parts.push(write('c.ts'));
  flushSync();
  expect(read.mock.calls.map(call => call[0])).toEqual([live.id]);
});

test('delegation mail opens its messages tab with local family identity, without duplicating coordination mail', async () => {
  stubLayout(200);
  const letter: AgentLetter = {
    id: 'delegation-user', origin: 'user',
    from: { coreId: 'local', threadId: 't-short', title: 'Parent', machine: 'Boite', resources: '', status: 'idle', mode: 'team' },
    to: { coreId: 'local', threadId: 't-child' }, toTitle: 'Reviewer', text: 'Check the parser.', replyTo: null,
    createdAt: 20, expiresAt: 1000, status: 'received', error: null
  };
  const coordinated = {
    ...store,
    openThread: { id: 't-short', turns: [] },
    accountOf: () => undefined,
    panel: new RightPanelStore().for('t-short'),
    loadCoordination: vi.fn(),
    threads: [{ id: 't-child', projectId: 'p-team' }],
    projects: [{ id: 'p-team', name: 'Review project' }],
    coordination: {
      self: { coreId: 'real-core-id', threadId: 't-short' },
      config: { mode: 'off', resources: '', remote: false, paused: false }, messages: [letter], sent: 0, sendLimit: 0, wakes: 0, wakeLimit: 0
    },
    delegation: {
      rootThreadId: 't-short', config: DEFAULT_DELEGATION_CONFIG, agents: [], messages: [letter], turnsUsed: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsdEquivalent: 0 }
    }
  } as unknown as Store;

  running = mount(MessageList, { target: document.body, props: { store: coordinated, threadId: 't-short', messages: [] } });
  flushSync();
  expect(document.querySelectorAll('[data-testid=agent-discussion-row]')).toHaveLength(1);
  const discussion = document.querySelector<HTMLButtonElement>('[data-testid=agent-discussion-row]')!;
  expect(discussion.dataset.peer).toBe('here/t-child');
  expect(discussion.querySelector('[data-testid=agent-discussion-title]')?.textContent).toBe('Reviewer');
  expect(discussion.querySelector('[data-testid=agent-discussion-preview]')?.textContent).toContain('Check the parser.');
  discussion.click();
  expect(coordinated.panel.active).toMatchObject({ kind: 'messages', peer: 'here/t-child', letterId: letter.id });
  await unmount(running); running = null;
  running = mount(AgentMessagesSurface, { target: document.body, props: { store: coordinated, surface: coordinated.panel.active!, panel: coordinated.panel } });
  flushSync();
  const row = document.querySelector('[data-letter-id="delegation-user"]');
  expect(row?.getAttribute('data-direction')).toBe('outgoing');
  // The user typed it: the user's side, under the user's name.
  expect(row?.classList.contains('right')).toBe(true);
  expect(row?.querySelector('.label')?.textContent).toBe('You');
  expect(document.querySelector('[data-testid=agent-discussion-where]')?.textContent).toBe('Review project');
  expect(row?.querySelector('[data-testid=agent-letter-status] svg.lucide-check-check')).not.toBeNull();
  const open = vi.spyOn(workspace, 'openAgentThread').mockResolvedValue();
  try {
    document.querySelector<HTMLButtonElement>('[data-testid=agent-letter-open]')?.click();
    expect(open).toHaveBeenCalledWith(coordinated, { coreId: 'local', threadId: 't-short' }, letter.to);
  } finally { open.mockRestore(); }
});

test('a burst of 33 agent messages stays in two counters as new mail arrives, and user messages split bursts', async ({ ready }) => {
  stubLayout(400);
  const { store: owner } = await ready({ delayMs: 0 });
  await owner.open('t-trace');
  const thread = owner.openThread!;
  thread.memoryEvents = [];
  thread.messages = [
    { id: 'before', threadId: thread.id, turnId: 'before', role: 'assistant', state: 'complete', createdAt: 10, parts: [{ type: 'text', text: 'Work begins.' }] },
    { id: 'divider', threadId: thread.id, turnId: 'divider', role: 'user', state: 'complete', createdAt: 50, parts: [{ type: 'text', text: 'Continue with the deployment.' }] }
  ];
  const self = { coreId: 'core-local', threadId: thread.id };
  const peer = { coreId: 'core-remote', threadId: 'remote-agent' };
  const letters: AgentLetter[] = Array.from({ length: 33 }, (_, index) => ({
    id: `burst-${index}`, from: { ...(index < 13 ? self : peer), title: 'Agent', machine: 'PC', resources: '', status: 'idle', mode: 'brief' },
    to: index < 13 ? peer : self, toTitle: 'Agent', text: `Private exchange ${index}`, replyTo: null,
    createdAt: 20 + index / 10, expiresAt: 1000, status: index === 0 ? 'rejected' : 'delivered', error: index === 0 ? 'Recipient unavailable' : null
  }));
  owner.coordination = { self, config: { mode: 'brief', resources: '', remote: true, paused: false }, messages: letters, sent: 13, sendLimit: null, wakes: 0, wakeLimit: null };
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: thread.id, messages: thread.messages } });
  flushSync();
  const group = document.querySelector('[data-testid=agent-message-group]')!;
  // Both directions with one agent are one discussion: its counts, its last words.
  const row = () => group.querySelector<HTMLElement>('[data-testid=agent-discussion-row]')!;
  expect(group.querySelectorAll('[data-testid=agent-discussion-row]')).toHaveLength(1);
  expect(row().dataset).toMatchObject({ peer: 'core-remote/remote-agent', count: '33' });
  expect(row().querySelector('.counts')?.textContent?.replace(/\s/g, '')).toBe('1320');
  expect(row().querySelector('[data-testid=agent-discussion-title]')?.textContent).toBe('Agent');
  expect(row().querySelector('[data-testid=agent-discussion-preview]')?.textContent).toContain('Private exchange 32');
  expect(group.textContent).not.toContain('attention');
  expect(document.body.textContent).not.toContain('Private exchange 31');
  expect(document.querySelectorAll('[data-testid=agent-message-group]')).toHaveLength(1);
  expect(articles()).toHaveLength(3);
  owner.coordination!.messages.push({ ...letters[32]!, id: 'extra', createdAt: 24 });
  flushSync();
  expect(document.querySelector('[data-testid=agent-message-group]')).toBe(group);
  expect(row().dataset.count).toBe('34');
  expect(row().querySelector('.counts')?.textContent?.replace(/\s/g, '')).toBe('1321');
  row().click();
  expect(owner.panel.active).toMatchObject({ kind: 'messages', peer: 'core-remote/remote-agent', letterId: 'burst-0' });
  owner.coordination!.messages.push({ ...letters[32]!, id: 'after-prompt', createdAt: 60 });
  flushSync();
  expect(document.querySelectorAll('[data-testid=agent-message-group]')).toHaveLength(2);
  expect(articles().map(article => article.textContent)).toEqual([
    expect.stringContaining('Work begins.'), expect.stringContaining('Agent'),
    expect.stringContaining('Continue with the deployment.'), expect.stringContaining('Agent')
  ]);
  expect([...document.querySelectorAll<HTMLElement>('[data-testid=agent-discussion-row]')].map(node => node.dataset.count)).toEqual(['34', '1']);
});

/** A store whose thread still has older messages behind the window. */
function pagedStore(overrides: Partial<Record<string, unknown>> = {}): {
  store: Store;
  calls: () => number;
} {
  let calls = 0;
  // The real store flips `loadingOlder` for the length of the call and never
  // starts a second one; a page that never resolves is what holds it open here.
  const paged: Record<string, unknown> = {
    permissionRequests: {},
    answer: async () => {},
    messagesBefore: 'm-before',
    loadingOlder: false,
    loadOlder: (): Promise<number> => {
      calls += 1;
      paged['loadingOlder'] = true;
      return new Promise<number>(() => {});
    },
    releaseOlder: () => 0,
    workflowsOf: () => [],
    ...overrides
  };
  return { store: paged as unknown as Store, calls: () => calls };
}

function thread(count: number): Message[] {
  const messages: Message[] = [];
  for (let index = 0; index < count; index += 1) {
    messages.push({
      id: `m-${index}`,
      threadId: 't-long',
      turnId: 'turn-1',
      role: 'assistant',
      parts: [{ type: 'text', text: `answer number ${index}` }],
      state: 'complete',
      createdAt: index
    });
  }
  return messages;
}

async function settle(): Promise<void> {
  for (let round = 0; round < 6; round += 1) {
    flushSync();
    await Promise.resolve();
  }
  flushSync();
}

function articles(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid=message]'));
}

function shownIds(): string[] {
  return articles().map((node) => node.dataset['mid'] ?? '');
}

function spacer(testid: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-testid=${testid}]`);
}

test('a long thread renders a window of messages and carries the rest in the spacers', async () => {
  const messages = thread(500);
  stubLayout(messages.length * ESTIMATE);

  running = mount(MessageList, {
    target: document.body,
    props: { store, threadId: 't-long', messages }
  });
  await settle();

  // Pinned to the bottom: a viewport's worth of messages plus the overscan.
  expect(articles().length).toBeGreaterThan(0);
  expect(articles().length).toBeLessThan(60);
  expect(shownIds().at(-1)).toBe('m-499');

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]');
  expect(timeline).not.toBeNull();

  // Halfway down: 20000 px is 250 messages of 80 px each.
  if (timeline) timeline.scrollTop = 20_000;
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();

  const middle = shownIds();
  expect(middle.length).toBeLessThan(60);
  expect(middle).toContain('m-250');
  expect(middle[0]).toBe('m-246');
  expect(middle.at(-1)).toBe('m-261');

  const above = spacer('timeline-above');
  const below = spacer('timeline-below');
  expect(above?.style.height).toBe(`${246 * ESTIMATE}px`);
  expect(below?.style.height).toBe(`${(500 - 262) * ESTIMATE}px`);
});

test('a prompt not measured yet counts its one row of thumbnails', async () => {
  const messages = thread(500);
  messages[10] = {
    ...messages[10]!,
    role: 'user',
    parts: [
      { type: 'text', text: 'two screenshots' },
      { type: 'image', mimeType: 'image/png', data: '', alt: null, dataDeferred: true, bytes: 1, width: 1280, height: 720 },
      { type: 'image', mimeType: 'image/png', data: '', alt: null, dataDeferred: true, bytes: 1, width: 300, height: 100 }
    ]
  };
  stubLayout(messages.length * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store, threadId: 't-long', messages } });
  await settle();
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  timeline.scrollTop = 20_000;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();

  // One 88 px row and its frame for both pictures: 98 px more above, so
  // 20000 px is message 248, not 250, and the window starts 4 rows earlier.
  expect(articles()[0]?.dataset['mid']).toBe('m-244');
  expect(spacer('timeline-above')?.style.height).toBe(`${244 * ESTIMATE + 98}px`);
});

test('a viewer opened from a row stays open, its files readable, once the rows leave the window', async () => {
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  onTestFinished(() => { URL.createObjectURL = create; URL.revokeObjectURL = revoke; });
  const revoked: string[] = [];
  URL.createObjectURL = () => 'blob:capture';
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  const messages = thread(500);
  // One turn of their own: a published file goes after the rest of its turn, which would part the two.
  messages[250] = { id: 'm-250', threadId: 't-long', turnId: 'turn-250', role: 'user', parts: [{ type: 'image', mimeType: 'image/png', data: btoa('png'), alt: 'shot.png' }], state: 'complete', createdAt: 250 };
  messages[251] = { ...messages[251]!, turnId: 'turn-250', parts: [{ type: 'file', name: 'capture.png', mimeType: 'image/png', data: btoa('png bytes') }] };
  stubLayout(messages.length * ESTIMATE);
  const owner = { ...store, openThread: null, composerStates: {}, busy: false } as unknown as Store;
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: 't-long', messages } });
  await settle();
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  timeline.scrollTop = 20_000;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  document.querySelector<HTMLButtonElement>('[data-testid=image-open]')!.click();
  flushSync();
  const shown = () => document.querySelector<HTMLImageElement>('[data-testid=image-viewer] img')?.getAttribute('src');
  expect(shown()).toMatch(/^data:image\/png/);
  // Both rows leave the window, as they do above a running turn.
  timeline.scrollTop = 0;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  expect(shownIds()).not.toContain('m-250');
  expect(shownIds()).not.toContain('m-251');
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  flushSync();
  expect(shown()).toBe('blob:capture');
  expect(revoked).toEqual([]);
  document.querySelector<HTMLButtonElement>('[data-testid=image-viewer-close]')!.click();
  flushSync();
  expect(document.querySelector('[data-testid=image-viewer]')).toBeNull();
  expect(revoked).toEqual(['blob:capture']);
});
test('scrolled up, the way to the bottom shows with nothing new below, and takes the reader there', async () => {
  const messages = thread(200);
  stubLayout(messages.length * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store, threadId: 't-long', messages } });
  await settle();
  const jumpButton = () => document.querySelector<HTMLButtonElement>('[data-testid=jump-to-latest]');
  expect(jumpButton()).toBeNull();

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  timeline.scrollTop = 4_000;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  expect(jumpButton()).not.toBeNull();

  jumpButton()!.click();
  await settle();
  // The button goes at once; the list glides the last screen and a half down and lands at the bottom.
  expect(jumpButton()).toBeNull();
  await vi.waitFor(() => expect(timeline.scrollTop).toBe(messages.length * ESTIMATE), { timeout: 2_000 });
  expect(jumpButton()).toBeNull();
});

test('a viewport clamp keeps the list pinned but a reader scroll during growth releases it', async () => {
  const messages = thread(20);
  stubLayout(messages.length * ESTIMATE);
  let height = VIEW_HEIGHT;
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => height });
  Object.defineProperty(Element.prototype, 'scrollTop', {
    configurable: true,
    get(this: Element) {
      const top = Math.min(tops.get(this) ?? 0, Math.max(0, scrollHeight - height));
      tops.set(this, top);
      return top;
    },
    set(this: Element, value: number) { tops.set(this, Math.max(0, Math.min(value, scrollHeight - height))); }
  });
  const observers: Array<{ callback: ResizeObserverCallback }> = [];
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  onTestFinished(() => { vi.unstubAllGlobals(); });
  running = mount(MessageList, { target: document.body, props: { store, threadId: 't-resize-clamp', messages } });
  await settle();
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  expect(timeline.scrollTop).toBe(1000);

  // Layout first clamps the old bottom, then narrower text grows before that scroll event is delivered.
  height = 900;
  expect(timeline.scrollTop).toBe(700);
  scrollHeight += 400;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  expect(document.querySelector('[data-testid=jump-to-latest]')).toBeNull();
  const observer = observers.at(-1)!;
  const entries = [{ target: timeline, contentRect: timeline.getBoundingClientRect(), borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [] }];
  observer.callback(entries, observer as unknown as ResizeObserver);
  expect(timeline.scrollTop).toBe(1100);

  // Growth alone cannot clamp the scroll upward: the reader moved before the busy phone delivered touchstart.
  scrollHeight += 40;
  timeline.scrollTop -= 20;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  expect(document.querySelector('[data-testid=jump-to-latest]')).not.toBeNull();
  observer.callback(entries, observer as unknown as ResizeObserver);
  expect(timeline.scrollTop).toBe(1080);
});

test('a window opened around the reader pages down as they reach its bottom, and "Jump to latest" reads the last page', async ({ ready }) => {
  window.localStorage.clear();
  const { store: live } = await ready({ delayMs: 0, long: true });
  live.readingPositions.set('t-long', { top: 0, pinned: false, heights: new Map(), anchor: { id: 'm-long-100', offset: 0 } });
  await live.open('t-long');
  expect(live.messagesAfter).toBe('m-long-119');
  const thread = live.openThread!;
  // The 80 messages above the window are sized too, so the list is that much taller.
  stubLayout((thread.messages.length + 80) * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', get messages() { return thread.messages; } } });
  await settle();
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  const jumpButton = () => document.querySelector<HTMLButtonElement>('[data-testid=jump-to-latest]');

  // The bottom of this window is not the end of the thread: the list does not pin, and the next page comes.
  timeline.scrollTop = scrollHeight - VIEW_HEIGHT;
  timeline.dispatchEvent(new Event('scroll'));
  await vi.waitFor(() => expect(thread.messages.length).toBeGreaterThan(40));
  expect(thread.messages.at(40)?.id).toBe('m-long-120');
  expect(jumpButton()).not.toBeNull();

  // The last page holds the end of the thread: the list spans all 400 messages from then on.
  scrollHeight = 400 * ESTIMATE;
  jumpButton()!.click();
  await vi.waitFor(() => expect(live.messagesAfter).toBeNull());
  expect(thread.messages.at(-1)?.id).toBe('m-long-399');
  expect(thread.messages.some((message) => message.id === 'm-long-100')).toBe(false);
});

test('what arrives while the reader is scrolled up is counted on the way back, and the count clears at the bottom', async ({ ready }) => {
  window.localStorage.clear();
  const { store: live, client } = await ready({ delayMs: 0, long: true });
  await live.open('t-long');
  const messages = live.openThread?.messages ?? [];
  stubLayout(messages.length * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', messages } });
  await settle();
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  timeline.scrollTop = 0;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  const jumpButton = () => document.querySelector<HTMLButtonElement>('[data-testid=jump-to-latest]');
  expect(jumpButton()?.textContent?.trim()).toBe('Jump to latest');

  const last = messages.at(-1)!;
  messages.push({ ...JSON.parse(JSON.stringify(last)), id: 'm-new-1' }, { ...JSON.parse(JSON.stringify(last)), id: 'm-new-2' });
  scrollHeight = messages.length * ESTIMATE;
  await settle();
  expect(jumpButton()?.textContent?.trim()).toBe('2 new messages');

  jumpButton()!.click();
  await settle();
  expect(jumpButton()).toBeNull();
});

test('a thread reopened where the reader left it, above the bottom, counts what arrives after', async ({ ready }) => {
  window.localStorage.clear();
  const { store: live, client } = await ready({ delayMs: 0, long: true });
  await live.open('t-long');
  const messages = live.openThread?.messages ?? [];
  stubLayout(messages.length * ESTIMATE);
  live.readingPositions.set('t-long', { top: 0, pinned: false, heights: new Map() });
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', messages } });
  await settle();
  const jumpButton = () => document.querySelector<HTMLButtonElement>('[data-testid=jump-to-latest]');
  expect(jumpButton()?.textContent?.trim()).toBe('Jump to latest');

  messages.push({ ...JSON.parse(JSON.stringify(messages.at(-1)!)), id: 'm-new-1' });
  scrollHeight = messages.length * ESTIMATE;
  await settle();
  expect(jumpButton()?.textContent?.trim()).toBe('1 new message');
});

test('a saved message anchor is rendered even when the old scroll offset points elsewhere', () => {
  const messages = thread(500);
  stubLayout(messages.length * ESTIMATE);
  const reading = { ...store, readingPositions: new Map([['t-long', { top: 80, pinned: false, heights: new Map(), anchor: { id: 'm-250', offset: 0 }, height: VIEW_HEIGHT }]]) } as unknown as Store;
  running = mount(MessageList, { target: document.body, props: { store: reading, threadId: 't-long', messages } });
  flushSync();
  expect(shownIds()).toContain('m-250');
  expect(document.querySelector<HTMLElement>('[data-testid=timeline]')!.scrollTop).toBe(250 * ESTIMATE);
});

test('Ctrl+F counts matches in messages the window has not drawn, walks to them, and Escape closes it', async ({ ready }) => {
  window.localStorage.clear();
  // jsdom measures no range; the bar only reads one to decide whether to scroll.
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);
  const { store: live, client } = await ready({ delayMs: 0, long: true });
  await live.open('t-long');
  const messages = live.openThread?.messages ?? [];
  stubLayout(messages.length * ESTIMATE);
  live.findOpen = true;
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', messages } });
  // The bar's first-use import can take longer than the default one-second wait on CI.
  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('[data-testid=find-input]');
    if (!found) throw new Error('the find bar is not drawn yet');
    return found;
  }, { timeout: 8_000 });
  await settle();
  expect(document.activeElement).toBe(input);

  // The oldest message is far above the drawn window.
  const first = messages[0]!;
  expect(document.querySelector(`[data-mid="${first.id}"]`)).toBeNull();
  const word = first.parts.flatMap((part) => (part.type === 'text' ? part.text.split(/\s+/) : [])).find((w) => /^[a-z]{6,}$/i.test(w))!;
  const total = findHits(messages, word).length;
  expect(total).toBeGreaterThan(0);
  input.value = word;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await settle();
  const count = () => document.querySelector('[data-testid=find-count]')!.textContent?.trim();
  expect(count()).toBe(`${total} of ${total}`);

  // One past the newest wraps to the oldest, which the window then draws.
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await settle();
  expect(count()).toBe(`1 of ${total}`);
  expect(document.querySelector(`[data-mid="${findHits(messages, word)[0]!.messageId}"]`)).not.toBeNull();

  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  await settle();
  expect(live.findOpen).toBe(false);
  expect(document.querySelector('[data-testid=find-bar]')).toBeNull();
});

test('a short thread renders whole, with no spacer at all', async () => {
  const messages = thread(20);
  stubLayout(messages.length * ESTIMATE);

  running = mount(MessageList, {
    target: document.body,
    props: { store, threadId: 't-short', messages }
  });
  await settle();

  expect(articles().length).toBe(20);
  expect(shownIds()[0]).toBe('m-0');
  expect(shownIds().at(-1)).toBe('m-19');
  expect(spacer('timeline-above')).toBeNull();
  expect(spacer('timeline-below')).toBeNull();
});

test('the top of a paged list asks the store for the page above it, once', async () => {
  const messages = thread(200);
  stubLayout(messages.length * ESTIMATE);
  const paged = pagedStore();

  running = mount(MessageList, {
    target: document.body,
    props: { store: paged.store, threadId: 't-paged', messages }
  });
  await settle();

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]');
  // Well above the top: nothing is asked for.
  if (timeline) timeline.scrollTop = 5_000;
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();
  expect(paged.calls()).toBe(0);

  // Under the 400 px trigger: one call, and one only while it is in flight.
  if (timeline) timeline.scrollTop = 120;
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();
  expect(paged.calls()).toBe(1);
});

test('a first page too short to scroll asks for the page above it at once; a list past the screen waits for the reader', async () => {
  // A first page holds about one screen: with nothing to scroll, no scroll event would ever ask.
  const short = thread(3);
  stubLayout(short.length * ESTIMATE);
  const paged = pagedStore({ openThread: { id: 't-short', turns: [], messages: [] } });
  running = mount(MessageList, { target: document.body, props: { store: paged.store, threadId: 't-short', messages: short } });
  await settle();
  expect(paged.calls()).toBe(1);
  await unmount(running); running = null;

  const long = thread(200);
  stubLayout(long.length * ESTIMATE);
  const tall = pagedStore({ openThread: { id: 't-tall', turns: [], messages: [] } });
  running = mount(MessageList, { target: document.body, props: { store: tall.store, threadId: 't-tall', messages: long } });
  await settle();
  expect(tall.calls()).toBe(0);
  await unmount(running); running = null;

  // A list laid out with no height is hidden: it waits until it is shown.
  stubLayout(short.length * ESTIMATE);
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get: () => 0 });
  const hidden = pagedStore({ openThread: { id: 't-hidden', turns: [], messages: [] } });
  running = mount(MessageList, { target: document.body, props: { store: hidden.store, threadId: 't-hidden', messages: short } });
  await settle();
  expect(hidden.calls()).toBe(0);
});

test('the scrollbar spans the whole thread, and a drag to the top reads the first page directly', async ({ createStore }) => {
  const { store: live, client } = createStore({ delayMs: 0, long: true });
  live.attach(client);
  await live.connect();
  await live.open('t-long');
  const asked = vi.spyOn(live, 'loadRange');
  const older = vi.spyOn(live, 'loadOlder');
  stubLayout(400 * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', messages: live.openThread!.messages } });
  await settle();

  // Pinned to the first page, the 360 messages above it already worth their place.
  expect(shownIds().at(-1)).toBe('m-long-399');
  expect(Number.parseFloat(document.querySelector<HTMLElement>('[data-testid=timeline-above]')?.style.height ?? '0')).toBeGreaterThanOrEqual(360 * ESTIMATE);
  expect(asked).not.toHaveBeenCalled();

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  timeline.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
  timeline.scrollTop = 0;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  // What is on screen is a gap row, and the page asked for starts at the first message.
  expect(document.querySelector<HTMLElement>('[data-testid=timeline-gap]')?.dataset['from']).toBe('0');
  await vi.waitFor(() => expect(asked).toHaveBeenCalledWith(0, 120, expect.any(Function), undefined));
  await vi.waitFor(() => expect(live.openThread!.messages[0]?.id).toBe('m-long-0'));
  // No walk down the cursor: the pages between were never read.
  expect(older).not.toHaveBeenCalled();
  expect(live.openThread!.messages).toHaveLength(160);
});

test('a reader scrolling up without a pause gets the page above before its gap reaches the screen', async ({ createStore }) => {
  const { store: live, client } = createStore({ delayMs: 0, long: true });
  live.attach(client);
  await live.connect();
  await live.open('t-long');
  const asked = vi.spyOn(live, 'loadRange');
  stubLayout(400 * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', messages: live.openThread!.messages } });
  await settle();

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  timeline.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
  // A wheel moves the view more often than frames are drawn. An ask put off by every move was never
  // sent: the reader crossed the 360 unread messages on their estimate and landed at the top.
  const gapBottom = 360 * ESTIMATE;
  for (let top = timeline.scrollTop; top > gapBottom + 2 * VIEW_HEIGHT && asked.mock.calls.length === 0; top -= 40) {
    timeline.scrollTop = top;
    timeline.dispatchEvent(new Event('scroll'));
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
  expect(asked).toHaveBeenCalled();
  expect(timeline.scrollTop).toBeGreaterThan(gapBottom + 2 * VIEW_HEIGHT);
});

test('with history still missing above, a streamed token rebuilds neither the rows nor the window', async ({ createStore }) => {
  const { store: live, client } = createStore({ delayMs: 0, long: true });
  live.attach(client);
  await live.connect();
  await live.open('t-long');
  const thread = live.openThread!;
  stubLayout(400 * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', get messages() { return thread.messages; } } });
  await settle();
  const last = thread.messages.at(-1)!;
  const part = last.parts[0];
  if (part?.type !== 'text') throw new Error('the long thread ends on a text part');
  last.state = 'streaming';
  await settle();
  const before = { ...windowStats };
  for (let delta = 0; delta < 100; delta += 1) { part.text += ' token'; flushSync(); }
  await settle();
  // The gap row in front of the 40 messages is the same row: a delta reads no slot and moves no window.
  expect(windowStats.recomputes - before.recomputes).toBeLessThan(20);
  expect(windowStats.slots - before.slots).toBeLessThan(20);
});

test('a thread whose first message is loaded asks for nothing at the top', async () => {
  const messages = thread(200);
  stubLayout(messages.length * ESTIMATE);
  const paged = pagedStore({ messagesBefore: null });

  running = mount(MessageList, {
    target: document.body,
    props: { store: paged.store, threadId: 't-whole', messages }
  });
  await settle();

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]');
  if (timeline) timeline.scrollTop = 0;
  timeline?.dispatchEvent(new Event('scroll'));
  await settle();

  expect(paged.calls()).toBe(0);
});

/**
 * The bench. Four hundred messages, two hundred deltas into the last one, then
 * ten scroll steps, on the real store over the in-memory client: the timeline
 * has to stream into a `$state` proxy the way it does in the app, and a plain
 * array mutated in a test moves nothing at all.
 *
 * What it holds: the DOM keeps the window and its overscan, never the four
 * hundred articles; a token of a streaming answer recomputes neither the window
 * nor the pin; and a scroll reads no slot height, because the spacers come off
 * the running totals instead of a walk over the list.
 */
test.for([false, true])('four hundred messages, two hundred deltas: the window and the pin stay put (inline view: %s)', { timeout: 20_000 }, async (withView, { ready }) => {
  window.localStorage.clear();
  const { store, client } = await ready({ delayMs: 0, long: true });
  await store.open('t-long');
  // `threads.get` hands back the last page: the bench wants the whole thread in
  // the list, so the pages above it are pulled in before anything is mounted.
  while (store.messagesBefore !== null) await store.loadOlder();
  const messages = store.openThread?.messages ?? [];
  expect(messages).toHaveLength(400);

  if (withView) {
    const previous = messages.at(-3)!;
    previous.turnId = messages.at(-1)!.turnId;
    previous.parts = [{ type: 'artifact', id: 'stream-view', name: 'chart.html', mimeType: 'text/html', bytes: 10, view: { title: 'Chart', height: 300, source: 'chart.html' } }];
  }

  stubLayout(messages.length * ESTIMATE);
  const mountedAt = performance.now();
  running = mount(MessageList, {
    target: document.body,
    props: { store, threadId: 't-long', messages }
  });
  await settle();
  const mounted = performance.now() - mountedAt;

  // The window and its overscan, not the four hundred articles.
  expect(articles().length).toBeGreaterThan(0);
  expect(articles().length).toBeLessThan(40);
  expect(shownIds()).toContain('m-long-399');
  expect(shownIds().at(-1)).toBe(withView ? 'm-long-397' : 'm-long-399');

  const last = messages.at(-1);
  const part = last?.parts[0];
  if (!last || part?.type !== 'text') throw new Error('the long thread ends on a text part');
  last.state = 'streaming';
  await settle();

  const beforeDeltas = { ...windowStats, ...layout, ...turnProgressStats };
  expect(turnProgressStats.finishedScans).toBeGreaterThan(0);
  const streamedAt = performance.now();
  for (let delta = 0; delta < 200; delta += 1) {
    part.text += ' token';
    flushSync();
  }
  await settle();
  const streamed = performance.now() - streamedAt;
  const deltas = {
    recomputes: windowStats.recomputes - beforeDeltas.recomputes,
    slots: windowStats.slots - beforeDeltas.slots,
    reads: layout.reads - beforeDeltas.reads,
    writes: layout.writes - beforeDeltas.writes,
    finishedScans: turnProgressStats.finishedScans - beforeDeltas.finishedScans
  };

  expect(articles().length).toBeLessThan(40);
  expect(deltas.recomputes).toBeLessThan(40);
  expect(deltas.slots).toBeLessThan(40);
  // The pin ran on the character count before this: two hundred of each.
  expect(deltas.reads).toBeLessThan(40);
  expect(deltas.writes).toBeLessThan(40);
  // The receipts and reasoning of the other 399 messages are not rebuilt per token.
  expect(deltas.finishedScans).toBe(0);

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]');
  const beforeScroll = { ...windowStats };
  const scrolledAt = performance.now();
  for (let step = 10; step > 0; step -= 1) {
    if (timeline) timeline.scrollTop = step * 3_000;
    timeline?.dispatchEvent(new Event('scroll'));
    await settle();
    expect(articles().length).toBeLessThan(40);
  }
  const scrolled = performance.now() - scrolledAt;
  const scrolls = {
    recomputes: windowStats.recomputes - beforeScroll.recomputes,
    slots: windowStats.slots - beforeScroll.slots
  };

  // Ten windows found by bisection off the totals, and not one slot read: the
  // walk this replaced was two spacers over four hundred messages a time.
  expect(scrolls.recomputes).toBeLessThan(40);
  expect(scrolls.slots).toBeLessThan(100);

  console.log(
    `[bench] 400 messages (inline view: ${withView}): mount ${mounted.toFixed(1)} ms, ` +
      `200 deltas ${streamed.toFixed(1)} ms (${deltas.recomputes} recomputes, ` +
      `${deltas.slots} slot reads, ${deltas.reads} height reads, ${deltas.writes} scroll writes), ` +
      `10 scroll steps ${scrolled.toFixed(1)} ms (${scrolls.recomputes} recomputes, ` +
      `${scrolls.slots} slot reads), ${articles().length} articles in the DOM`
  );
});

test('the second receipt waits for the first streamed character of the answer', async ({ ready }) => {
  window.localStorage.clear();
  const { store, client } = await ready({ delayMs: 0, long: true });
  await store.open('t-long');
  const messages = store.openThread?.messages ?? [];
  stubLayout(messages.length * ESTIMATE);
  messages.push({ id: 'm-ask', threadId: 't-long', turnId: 'turn-ask', role: 'user', parts: [{ type: 'text', text: 'go' }], state: 'complete', createdAt: Date.now() });
  messages.push({ id: 'm-reply', threadId: 't-long', turnId: 'turn-ask', role: 'assistant', parts: [{ type: 'text', text: '' }], state: 'streaming', createdAt: Date.now() });
  running = mount(MessageList, { target: document.body, props: { store, threadId: 't-long', messages } });
  await settle();
  const second = () => document.querySelector('[data-mid=m-ask] [data-testid=receipt-responded]');
  expect(second()?.classList.contains('received')).toBe(false);
  const part = messages.at(-1)?.parts[0];
  if (part?.type !== 'text') throw new Error('the reply is a text part');
  part.text += 'H';
  await settle();
  expect(second()?.classList.contains('received')).toBe(true);
});

test('a page in flight shows one line at the top of the list', async () => {
  const messages = thread(200);
  stubLayout(messages.length * ESTIMATE);
  const paged = pagedStore({ loadingOlder: true });

  running = mount(MessageList, {
    target: document.body,
    props: { store: paged.store, threadId: 't-loading', messages }
  });
  await settle();

  const row = document.querySelector<HTMLElement>('[data-testid=loading-older]');
  expect(row?.textContent).toBe('Loading earlier messages');
});

test('a press holds the pinned list, and a release the window never saw still frees it', async ({ ready }) => {
  window.localStorage.clear();
  const { store: live, client } = await ready({ delayMs: 0, long: true });
  await live.open('t-long');
  const messages = live.openThread?.messages ?? [];
  stubLayout(messages.length * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', messages } });
  await settle();
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  expect(timeline.scrollTop).toBe(scrollHeight);

  let added = 0;
  const arrive = async () => {
    messages.push({ ...JSON.parse(JSON.stringify(messages.at(-1)!)), id: `m-held-${added++}` });
    scrollHeight = messages.length * ESTIMATE;
    await settle();
  };
  const press = () => timeline.dispatchEvent(Object.assign(new Event('pointerdown', { bubbles: true }), { pointerType: 'mouse', buttons: 1 }));

  // Held under the pointer, the list stays where it is while the answer grows below.
  press();
  await arrive();
  expect(timeline.scrollTop).toBe(scrollHeight - ESTIMATE);
  // The button was let go outside the window, so no pointerup came: the pointer back with no button frees the list.
  window.dispatchEvent(Object.assign(new Event('pointermove'), { buttons: 0 }));
  await arrive();
  expect(timeline.scrollTop).toBe(scrollHeight);

  // The same when the window loses focus mid-press.
  press();
  await arrive();
  expect(timeline.scrollTop).toBe(scrollHeight - ESTIMATE);
  window.dispatchEvent(new Event('blur'));
  await arrive();
  expect(timeline.scrollTop).toBe(scrollHeight);
  expect(document.querySelector('[data-testid=jump-to-latest]')).toBeNull();
});

test('a keyboard step up leaves bottom-following even within its 80 pixel tolerance', async ({ createStore }) => {
  window.localStorage.clear();
  const { store: live, client } = createStore({ delayMs: 0, long: true });
  live.attach(client);
  await live.connect(); await live.open('t-long');
  const messages = live.openThread!.messages;
  stubLayout(messages.length * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', messages } });
  await settle();
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  timeline.scrollTop = scrollHeight - VIEW_HEIGHT;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  timeline.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  timeline.scrollTop -= 30;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  expect(document.querySelector('[data-testid=jump-to-latest]')).not.toBeNull();
  const left = timeline.scrollTop;
  messages.push({ ...JSON.parse(JSON.stringify(messages.at(-1)!)), id: 'm-keyboard-arrival' });
  scrollHeight += ESTIMATE;
  await settle();
  expect(timeline.scrollTop).toBe(left);
  timeline.scrollTop = scrollHeight - VIEW_HEIGHT;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  expect(document.querySelector('[data-testid=jump-to-latest]')).toBeNull();
});

test('the timeline watches the wheel passively, so a notch never waits for the main thread', async () => {
  const messages = thread(30);
  stubLayout(messages.length * ESTIMATE);
  const listen = vi.spyOn(EventTarget.prototype, 'addEventListener');
  try {
    running = mount(MessageList, { target: document.body, props: { store, threadId: 't-short', messages } });
    await settle();
    const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
    const wheels = listen.mock.calls.filter((call, index) => listen.mock.contexts[index] === timeline && call[0] === 'wheel');
    // One listener, and it cannot cancel the scroll: a cancellable one makes the compositor ask this thread first.
    expect(wheels.map((call) => call[2])).toEqual([expect.objectContaining({ passive: true })]);
  } finally {
    listen.mockRestore();
  }
});

/** Every row on the page: a message, or one of the rows a long message is cut in. */
function rowsDrawn(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid=message], [data-testid=message-rest]'));
}

/** The heavy thread whole: its first page holds about one screen, and the tests below walk rows, not pages. */
async function openWhole(live: Store, threadId: string): Promise<void> {
  await live.open(threadId);
  while (live.messagesBefore !== null) if (await live.loadOlder() === 0) throw new Error(`${threadId} stopped paging`);
}

test('a turn of a thousand calls is drawn as a window of rows, and only its first row names the model', async ({ ready }) => {
  window.localStorage.clear();
  const { store: live } = await ready({ delayMs: 0, heavy: true });
  await openWhole(live, 't-heavy');
  const messages = live.openThread?.messages ?? [];
  // Paged in whole: nothing is left to load above it.
  expect(messages).toHaveLength(40);
  expect(live.messagesBefore).toBeNull();
  const giant = messages.reduce((a, b) => (b.parts.length > a.parts.length ? b : a));
  expect(giant.parts.length).toBeGreaterThan(1000);

  stubLayout(60_000);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-heavy', messages } });
  await settle();

  // Pinned to the bottom: the last rows, not the thread, and none of the giant message above them.
  expect(rowsDrawn().length).toBeGreaterThan(0);
  expect(rowsDrawn().length).toBeLessThan(24);
  expect(rowsDrawn().at(-1)!.dataset['mid']).toBe(messages.at(-1)!.id);
  expect(spacer('timeline-above')).not.toBeNull();
  expect(document.querySelector(`[data-mid="${giant.id}"]`)).toBeNull();

  // Walk the thread to its top: the giant message is only ever on the page a few rows at a time.
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  const seen = new Set<string>();
  let most = 0;
  let labels = 0;
  const top = Number.parseFloat(spacer('timeline-above')!.style.height);
  // One screen per step: every part of the thread passes through the view once.
  for (let at = top; at >= 0; at -= VIEW_HEIGHT) {
    timeline.scrollTop = at;
    timeline.dispatchEvent(new Event('scroll'));
    await settle();
    const mine = rowsDrawn().filter(node => node.dataset['mid'] === giant.id || node.dataset['mid']!.startsWith(`${giant.id}#`));
    for (const node of mine) seen.add(node.dataset['mid']!);
    most = Math.max(most, mine.length);
    labels = Math.max(labels, mine.filter(node => node.querySelector('[data-testid=message-model]')).length);
    expect(document.querySelectorAll('[data-testid=tool-group], [data-testid=tool-card]').length).toBeLessThan(120);
    // The rest of a message is the same message going on: no second label.
    for (const node of mine) {
      if (node.dataset['testid'] === 'message-rest') expect(node.querySelector('[data-testid=message-model]')).toBeNull();
    }
  }
  expect(seen.size).toBeGreaterThan(20);
  expect(most).toBeGreaterThan(1);
  expect(most).toBeLessThan(14);
  expect(labels).toBeLessThanOrEqual(1);
  // About 90 redraws of an 11.5 MiB thread: 4 s alone, over 15 s beside the other suites on a CI runner.
}, 60_000);

test('a scroll inside the rows already drawn redraws nothing and reads no tool call again', async ({ ready }) => {
  window.localStorage.clear();
  const { store: live } = await ready({ delayMs: 0, heavy: true });
  await openWhole(live, 't-heavy');
  const messages = live.openThread?.messages ?? [];
  stubLayout(60_000);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-heavy', messages } });
  await settle();

  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  const top = Number.parseFloat(spacer('timeline-above')!.style.height);
  // Into the last finished turn, whose files card is on the page and was read from its calls.
  timeline.scrollTop = top + 40;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  const drawn = rowsDrawn();
  const before = { ...windowStats };

  // Sixty wheel notches that never leave the first row on screen.
  for (let notch = 1; notch <= 60; notch += 1) {
    timeline.scrollTop = top + 40 + notch;
    timeline.dispatchEvent(new Event('scroll'));
    await settle();
  }
  expect(windowStats.turnFiles).toBe(before.turnFiles);
  const after = rowsDrawn();
  expect(after).toHaveLength(drawn.length);
  after.forEach((node, index) => expect(node).toBe(drawn[index]));
});

test('Ctrl+F opens the row of a long message that holds the match, not its first row', async ({ ready }) => {
  window.localStorage.clear();
  Range.prototype.getBoundingClientRect ??= () => new DOMRect(0, 0, 0, 0);
  const { store: live } = await ready({ delayMs: 0, heavy: true });
  await openWhole(live, 't-heavy');
  const messages = live.openThread?.messages ?? [];
  const giant = messages.reduce((a, b) => (b.parts.length > a.parts.length ? b : a));
  // A word no other part holds, in a paragraph deep inside the giant message.
  const at = giant.parts.findIndex((part, index) => index > giant.parts.length / 2 && part.type === 'text');
  const paragraph = giant.parts[at];
  if (paragraph?.type !== 'text') throw new Error('the giant message holds paragraphs');
  paragraph.text = `${paragraph.text} xylophone`;
  expect(findHits(messages, 'xylophone')).toEqual([{ messageId: giant.id, nth: 0, part: at }]);

  stubLayout(60_000);
  live.findOpen = true;
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-heavy', messages } });
  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('[data-testid=find-input]');
    if (!found) throw new Error('the find bar is not drawn yet');
    return found;
  }, { timeout: 8_000 });
  await settle();
  expect(document.body.textContent).not.toContain('xylophone');

  input.value = 'xylophone';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await vi.waitFor(() => {
    const row = rowsDrawn().find(node => node.textContent?.includes('xylophone'));
    if (!row) throw new Error('the row holding the match is not drawn yet');
    expect(row.dataset['testid']).toBe('message-rest');
    expect(row.dataset['mid']!.startsWith(`${giant.id}#`)).toBe(true);
  }, { timeout: 4_000 });
  expect(document.querySelector('[data-testid=find-count]')!.textContent?.trim()).toBe('1 of 1');
});

test('a place read inside a long message is saved by message with its row, and opened again on that row', async ({ ready }) => {
  window.localStorage.clear();
  const { store: live } = await ready({ delayMs: 0, heavy: true });
  await openWhole(live, 't-heavy');
  const messages = live.openThread?.messages ?? [];
  const giant = messages.reduce((a, b) => (b.parts.length > a.parts.length ? b : a));
  stubLayout(60_000);
  // jsdom lays nothing out: every row reports a box that reaches the viewport, so the first one drawn is the anchor.
  const measured = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return this instanceof HTMLElement && this.dataset['mid'] ? new DOMRect(0, -30, 800, 400) : new DOMRect(0, 0, 800, VIEW_HEIGHT);
  };
  onTestFinished(() => { Element.prototype.getBoundingClientRect = measured; });

  // Opened on a row deep in the giant message: the page draws it, at the place its offset says.
  const row = `${giant.id}#6`;
  live.readingPositions.set('t-heavy', { top: 0, pinned: false, heights: new Map(), anchor: { id: giant.id, offset: -30, row }, height: VIEW_HEIGHT });
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-heavy', messages } });
  await settle();
  expect(document.querySelector(`[data-mid="${CSS.escape(row)}"]`)).not.toBeNull();
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  expect(timeline.scrollTop).toBeGreaterThan(1000);

  // Left as it was opened, the place saved is the one restored.
  await unmount(running!); running = null;
  expect(live.readingPositions.get('t-heavy')?.anchor).toEqual({ id: giant.id, offset: -30, row });

  // A press takes the list back from the restore; from then on the anchor is read from the rows on the page.
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-heavy', messages } });
  await settle();
  for (let press = 0; press < 2; press += 1) document.querySelector<HTMLElement>('[data-testid=timeline]')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  const first = rowsDrawn()[0]!.dataset['mid']!;
  expect(first).not.toBe(row);
  expect(first.startsWith(`${giant.id}#`)).toBe(true);
  await unmount(running!); running = null;
  // The store asks the core for the page around a message: the anchor names it, never a row.
  expect(live.readingPositions.get('t-heavy')?.anchor).toEqual({ id: giant.id, offset: -30, row: first });
});

test('a phone keeps the buttons under the last prompt and answer, shows another prompt\'s on a tap and offers no fork', async ({ ready }) => {
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', (media: string) => Object.assign(new EventTarget(), { media, matches: media.includes('max-width: 720px'), onchange: null, addListener() {}, removeListener() {} }));
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const { store: live } = await ready({ delayMs: 0, long: true });
  await live.open('t-long');
  const messages = live.openThread?.messages ?? [];
  stubLayout(messages.length * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', messages } });
  await settle();

  const prompts = () => [...document.querySelectorAll<HTMLElement>('article.message.user')];
  const last = prompts().at(-1)!, earlier = prompts().at(-2)!;
  expect(last.hasAttribute('data-latest')).toBe(true);
  expect(earlier.hasAttribute('data-latest')).toBe(false);
  expect(document.querySelector('article.message.assistant[data-latest] [data-testid=message-actions]')).not.toBeNull();
  expect(document.querySelector('[data-testid=message-fork]')).toBeNull();

  const bubble = () => earlier.querySelector<HTMLElement>('.bubble')!;
  bubble().click(); flushSync();
  expect(earlier.hasAttribute('data-revealed')).toBe(true);
  // Its own buttons keep the row; a second tap on the bubble, or one anywhere else, puts it away.
  earlier.querySelector<HTMLButtonElement>('[data-testid=message-copy]')!.click(); flushSync();
  expect(earlier.hasAttribute('data-revealed')).toBe(true);
  bubble().click(); flushSync();
  expect(earlier.hasAttribute('data-revealed')).toBe(false);
  bubble().click(); flushSync();
  document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })); flushSync();
  expect(earlier.hasAttribute('data-revealed')).toBe(false);
});

test('a prompt queued behind a finished turn keeps the buttons of the answer before it on a phone', async ({ ready }) => {
  window.localStorage.clear();
  vi.stubGlobal('matchMedia', (media: string) => Object.assign(new EventTarget(), { media, matches: media.includes('max-width: 720px'), onchange: null, addListener() {}, removeListener() {} }));
  onTestFinished(() => { vi.unstubAllGlobals(); });
  const { store: live } = await ready({ delayMs: 0, long: true });
  await live.open('t-long');
  const thread = live.openThread!;
  const messages = thread.messages;
  const answer = messages.findLast((message) => message.role === 'assistant')!;
  // Its turn is queued and nothing answers it yet: the newest turn has no answer row.
  thread.turns.push({ id: 'turn-queued', threadId: 't-long', status: 'queued', queuedAt: Date.now(), startedAt: null, finishedAt: null, usage: null, error: null });
  messages.push({ id: 'm-queued', threadId: 't-long', turnId: 'turn-queued', role: 'user', parts: [{ type: 'text', text: 'and then?' }], state: 'complete', createdAt: Date.now() });
  stubLayout(messages.length * ESTIMATE);
  running = mount(MessageList, { target: document.body, props: { store: live, threadId: 't-long', messages } });
  await settle();

  expect(document.querySelector('[data-mid="m-queued"]')?.closest('article')?.hasAttribute('data-latest')).toBe(true);
  expect(document.querySelector(`[data-mid="${answer.id}"]`)?.closest('article')?.hasAttribute('data-latest')).toBe(true);
});

test('a row counts at the height it is drawn, fractions included, so rows measured above the reader move the view by what they weigh', async () => {
  const messages = thread(200);
  stubLayout(messages.length * ESTIMATE);
  const observers: Array<{ callback: ResizeObserverCallback }> = [];
  vi.stubGlobal('ResizeObserver', class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) { this.callback = callback; observers.push(this); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  onTestFinished(() => { vi.unstubAllGlobals(); });
  running = mount(MessageList, { target: document.body, props: { store, threadId: 't-long', messages } });
  await settle();
  const timeline = document.querySelector<HTMLElement>('[data-testid=timeline]')!;
  timeline.scrollTop = 4_000;
  timeline.dispatchEvent(new Event('scroll'));
  await settle();
  const before = timeline.scrollTop;
  // Each drawn row is 0.37 px taller than a whole pixel, as text lays out on some screens and font metrics.
  const observer = observers.at(-1)!;
  observer.callback(articles().map((target) => ({ target, borderBoxSize: [{ blockSize: 100.37, inlineSize: 300 }] }) as unknown as ResizeObserverEntry), observer as unknown as ResizeObserver);
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  await settle();
  const moved = timeline.scrollTop - before;
  expect(moved).toBeGreaterThan(0);
  // Rounded heights would move it by whole pixels and leave the reader's text a fraction off per row.
  expect(Math.abs(moved - Math.round(moved))).toBeGreaterThan(0.01);
});
