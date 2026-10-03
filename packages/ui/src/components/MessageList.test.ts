import { afterEach, expect, onTestFinished, vi } from 'vitest';
import { test } from '../test/fake-client';
import { flushSync, mount, unmount } from 'svelte';
import { DEFAULT_DELEGATION_CONFIG, type AgentLetter, type Message } from '@boite/contracts';
import MessageList from './MessageList.svelte';
import { windowStats } from '../lib/message-window';
import { turnProgressStats } from '../lib/turn-progress.svelte';
import { findHits } from '../lib/find';
import type { Store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import { RightPanelStore } from '../lib/right-panel.svelte';
import AgentMessagesSurface from './AgentMessagesSurface.svelte';

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
  expect(row.textContent).toContain('Started 2 subagents');
  expect(row.textContent).toContain('1/2 completed');
  await owner.selectDelegatedAgent('t-team-running');
  row.click();
  flushSync();
  expect(owner.panel.isOpen).toBe(true);
  expect(owner.delegationSelectedAgentId).toBeNull();
  const agent = owner.delegation!.agents.find(agent => agent.thread.id === 't-team-running')!;
  agent.thread.status = 'idle';
  agent.lastTurn!.status = 'done';
  agent.lastTurn!.finishedAt = agent.thread.createdAt + 60_000;
  flushSync();
  expect(document.querySelectorAll('[data-testid=delegation-activity]')).toHaveLength(1);
  expect(row.textContent).toContain('2/2 completed');
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

test('one model label covers a turn split across text and separate attachments, and the next turn names its own model', async ({ createStore }) => {
  const { store: owner, client } = createStore({ delayMs: 0 });
  owner.attach(client);
  await owner.connect();
  await owner.open('t-trace');
  const thread = owner.openThread!;
  const first = thread.turns[0]!;
  first.execution = { ...thread, providerId: 'codex', accountId: 'a-codex', model: 'gpt-6.1-sol', sessionGeneration: 0, selectionVersion: 0 };
  thread.turns.push({ ...first, id: 'turn-next', execution: { ...first.execution, model: 'gpt-6-astra' } });
  thread.messages = [
    { id: 'm-intro', threadId: thread.id, turnId: first.id, role: 'assistant', state: 'complete', createdAt: 1, parts: [{ type: 'text', text: 'Here are the files.' }] },
    ...['README.md', 'review-small.mp4', 'NOTES.md'].map((name, index): Message => ({
      id: `m-file-${index}`, threadId: thread.id, turnId: first.id, role: 'assistant', state: 'complete', createdAt: index + 2,
      parts: [{ type: 'file', name, mimeType: name.endsWith('.mp4') ? 'video/mp4' : 'text/markdown', data: 'ZmlsZQ==' }]
    })),
    { id: 'm-next', threadId: thread.id, turnId: 'turn-next', role: 'assistant', state: 'streaming', createdAt: 5, parts: [{ type: 'text', text: 'Next answer.\n\n' }] }
  ];
  running = mount(MessageList, { target: document.body, props: { store: owner, threadId: thread.id, messages: thread.messages } });
  flushSync();
  const labels = [...document.querySelectorAll('[data-testid=message-model]')];
  expect(labels).toHaveLength(2);
  expect(labels[0]!.closest('[data-mid]')?.getAttribute('data-mid')).toBe('m-intro');
  expect(labels[1]!.textContent).toContain('gpt-6-astra');
  expect(document.querySelectorAll('[data-mid^=m-file-]')).toHaveLength(3);
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
  expect(document.querySelector('[data-testid="message-system"]')?.textContent).toBe('System');
  expect(document.querySelector('[data-testid="message"]')?.textContent).toContain('Agent coordination');
  expect(document.querySelector('[data-testid="message"]')?.textContent).not.toContain('Internal delivery envelope');
  expect(document.querySelector('.bubble')).toBeNull();
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
  expect(rows[1]).toContain('Received 1 message');
  expect(rows[2]).toContain('After coordination');
  expect(rows[3]).toContain('Forwarded 1 message');
  expect(document.body.textContent).not.toContain('Boite agent coordination');
  expect(document.body.textContent).not.toContain('Awaiting provider turn');
  expect(document.body.textContent).not.toContain('Wait before restart.');
  expect(document.body.textContent).not.toContain('Restart postponed.');
  expect(document.querySelectorAll('[data-testid=forwarded-agent-message]')).toHaveLength(0);
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
  expect(document.querySelectorAll('[data-testid=agent-message-summary]')).toHaveLength(1);
  const summary = document.querySelector<HTMLButtonElement>('[data-testid=agent-message-summary]')!;
  expect(summary.textContent).toContain('Forwarded 1 message');
  summary.click();
  expect(coordinated.panel.active).toMatchObject({ kind: 'messages', mailDirection: 'outgoing', letterId: letter.id });
  await unmount(running); running = null;
  running = mount(AgentMessagesSurface, { target: document.body, props: { store: coordinated, surface: coordinated.panel.active!, panel: coordinated.panel } });
  flushSync();
  const row = document.querySelector('[data-letter-id="delegation-user"]');
  expect(row?.getAttribute('data-direction')).toBe('outgoing');
  expect(row?.textContent).toContain('You sent to');
  expect(row?.querySelector('[data-testid=agent-letter-project]')?.textContent).toBe('Review project');
  expect(row?.querySelector('[data-testid=agent-letter-status] svg.lucide-check-check')).not.toBeNull();
  const open = vi.spyOn(workspace, 'openAgentThread').mockResolvedValue();
  try {
    row?.querySelector<HTMLButtonElement>('[data-testid=agent-letter-open]')?.click();
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
  expect(group.textContent).toContain('Forwarded 13 messages');
  expect(group.textContent).toContain('Received 20 messages');
  expect(group.textContent).toContain('1 message needs attention');
  expect(document.body.textContent).not.toContain('Private exchange');
  expect(document.querySelectorAll('[data-testid=agent-message-group]')).toHaveLength(1);
  expect(articles()).toHaveLength(3);
  owner.coordination!.messages.push({ ...letters[32]!, id: 'extra', createdAt: 24 });
  flushSync();
  expect(document.querySelector('[data-testid=agent-message-group]')).toBe(group);
  expect(group.textContent).toContain('Received 21 messages');
  group.querySelector<HTMLButtonElement>('[data-direction=incoming]')!.click();
  expect(owner.panel.active).toMatchObject({ kind: 'messages', mailDirection: 'incoming', letterId: 'burst-13' });
  owner.coordination!.messages.push({ ...letters[32]!, id: 'after-prompt', createdAt: 60 });
  flushSync();
  expect(document.querySelectorAll('[data-testid=agent-message-group]')).toHaveLength(2);
  expect(articles().map(article => article.textContent)).toEqual([
    expect.stringContaining('Work begins.'), expect.stringContaining('Received 21 messages'),
    expect.stringContaining('Continue with the deployment.'), expect.stringContaining('Received 1 message')
  ]);
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

test('a viewer opened from a row stays open, its files readable, once the rows leave the window', async () => {
  const create = URL.createObjectURL, revoke = URL.revokeObjectURL;
  onTestFinished(() => { URL.createObjectURL = create; URL.revokeObjectURL = revoke; });
  const revoked: string[] = [];
  URL.createObjectURL = () => 'blob:capture';
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  const messages = thread(500);
  messages[250] = { id: 'm-250', threadId: 't-long', turnId: 'turn-1', role: 'user', parts: [{ type: 'image', mimeType: 'image/png', data: btoa('png'), alt: 'shot.png' }], state: 'complete', createdAt: 250 };
  messages[251] = { ...messages[251]!, parts: [{ type: 'file', name: 'capture.png', mimeType: 'image/png', data: btoa('png bytes') }] };
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
test('four hundred messages, two hundred deltas: the window and the pin stay put', async ({ ready }) => {
  window.localStorage.clear();
  const { store, client } = await ready({ delayMs: 0, long: true });
  await store.open('t-long');
  // `threads.get` hands back the last page: the bench wants the whole thread in
  // the list, so the pages above it are pulled in before anything is mounted.
  while (store.messagesBefore !== null) await store.loadOlder();
  const messages = store.openThread?.messages ?? [];
  expect(messages).toHaveLength(400);

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
  expect(shownIds().at(-1)).toBe('m-long-399');

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
    `[bench] 400 messages: mount ${mounted.toFixed(1)} ms, ` +
      `200 deltas ${streamed.toFixed(1)} ms (${deltas.recomputes} recomputes, ` +
      `${deltas.slots} slot reads, ${deltas.reads} height reads, ${deltas.writes} scroll writes), ` +
      `10 scroll steps ${scrolled.toFixed(1)} ms (${scrolls.recomputes} recomputes, ` +
      `${scrolls.slots} slot reads), ${articles().length} articles in the DOM`
  );
  // Shared CI runners need time for the full streaming and scrolling workload.
}, 20_000);

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
