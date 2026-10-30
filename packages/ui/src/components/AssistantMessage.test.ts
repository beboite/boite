import { afterEach, expect, test, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import type { Message } from '@boite/contracts';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { workspace } from '../lib/workspace.svelte';
import AssistantMessage from './AssistantMessage.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

test('live paragraphs update without rebuilding completed prose when tools and reasoning arrive', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const message = store.openThread!.messages.at(-1)!;
    message.state = 'streaming';
    message.parts = [
      { type: 'text', text: 'A complete paragraph.\n\nStill writing' },
      { type: 'tool', toolId: 'read', name: 'Read', input: {}, output: null, status: 'running' },
      { type: 'thinking', text: 'Checking files' }
    ];
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, signedOut: null, showModel: false } });
    flushSync();
    expect(document.querySelectorAll('[data-testid=paragraph]')).toHaveLength(1);
    expect(document.querySelector('[data-testid=paragraph-pending]')?.textContent).toBe('Still writing');
    const first = document.querySelector('[data-testid=paragraph]');
    if (message.parts[0]?.type !== 'text') throw new Error('missing text');
    message.parts[0].text += ' this paragraph';
    flushSync();
    expect(document.querySelector('[data-testid=paragraph-pending]')?.textContent).toBe('Still writing this paragraph');
    message.parts[0].text += '.\n\n';
    flushSync();
    expect(document.querySelectorAll('[data-testid=paragraph]')).toHaveLength(2);
    expect(document.querySelector('[data-testid=paragraph]')).toBe(first);
  } finally { store.detach(); client.close(); }
});

test('a view block being written shows a placeholder, never its half-written HTML, until it closes', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const message = store.openThread!.messages.at(-1)!;
    message.state = 'streaming';
    message.parts = [{ type: 'text', text: 'Here it is.\n\nA card:\n```view\n<svg width="40" height="40"><circle' }];
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, signedOut: null, showModel: false } });
    flushSync();
    const part = () => document.querySelector('[data-testid=text-part]')!;
    expect(document.querySelectorAll('[data-testid=paragraph]')).toHaveLength(1);
    expect(document.querySelector('[data-testid=paragraph-pending]')?.textContent).toBe('A card:');
    expect(document.querySelector('[data-testid=drawing-pending]')).not.toBeNull();
    expect(part().textContent).not.toContain('<svg');
    if (message.parts[0]?.type !== 'text') throw new Error('missing text');
    message.parts[0].text += ' r="20"/></svg>\n```\n\nDone';
    flushSync();
    expect(document.querySelector('[data-testid=drawing-pending]')).toBeNull();
    expect(document.querySelector<HTMLElement>('.md-view')?.dataset.source).toBe('<svg width="40" height="40"><circle r="20"/></svg>');
    expect(document.querySelector('[data-testid=paragraph-pending]')?.textContent).toBe('Done');
  } finally { store.detach(); client.close(); }
});

test('a compaction a background copy made says so beside its counts', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const last = store.openThread!.messages.at(-1)!;
    const message: Message = { ...last, id: 'm-background', role: 'system', parts: [{ type: 'compaction', trigger: 'auto', preTokens: 184_000, postTokens: 31_000, background: true }] };
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, signedOut: null, showModel: false } });
    flushSync();
    expect(document.querySelector('[data-testid=compaction-part]')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Context compacted, 184K to 31K tokens (in the background)');
  } finally { store.detach(); client.close(); }
});

test('a line naming a page the turn published cuts the answer there, without drawing again what is above it', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const message = store.openThread!.messages.at(-1)!;
    const view: Message = { id: 'm-orbit', threadId: message.threadId, turnId: message.turnId, role: 'assistant', state: 'complete', createdAt: message.createdAt, parts: [
      { type: 'artifact', id: 'a-orbit', name: 'orbit.html', mimeType: 'text/html', bytes: 10, view: { title: 'Orbit', height: 300, source: '.boite/views/orbit.html' } },
    ] };
    message.state = 'streaming';
    message.parts = [{ type: 'text', text: 'The orbit first.\n\n![Orbit](.boite/views/orbit.html)' }];
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, signedOut: null, showModel: false, views: [view] } });
    flushSync();
    const order = () => Array.from(document.querySelectorAll('[data-testid=text-run], [data-testid=inline-view], [data-testid=chat-file]')).map(node => node.getAttribute('data-testid') === 'text-run' ? 'text' : 'page');
    // The line being written is not shown as a raw link: the page takes its place once the line is complete.
    expect(document.querySelector('[data-testid=paragraph-pending]')).toBeNull();
    expect(order()).toEqual(['text']);
    const first = document.querySelector('[data-testid=paragraph]');
    if (message.parts[0]?.type !== 'text') throw new Error('missing text');
    message.parts[0].text += '\n\nThen the bars.';
    flushSync();
    expect(order()).toEqual(['text', 'page', 'text']);
    expect(document.querySelector('[data-testid=paragraph]')).toBe(first);
    expect(document.querySelector('[data-testid=paragraph-pending]')?.textContent).toBe('Then the bars.');
    expect(document.querySelector('[data-testid=text-part]')!.textContent).not.toContain('orbit.html');
    // A line naming no page of the turn stays text where it is.
    message.parts[0].text += '\n\n![Gone](gone.html)\n\nThe end.';
    message.state = 'complete';
    flushSync();
    expect(order()).toEqual(['text', 'page', 'text']);
    expect(document.querySelector('[data-testid=text-part]')!.textContent).toContain('GoneThe end.');
  } finally { store.detach(); client.close(); }
});

test('reasoning folds with the calls into one line and empty reasoning under a second is not drawn', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const message = store.openThread!.messages.at(-1)!;
    message.state = 'streaming';
    message.parts = [{ type: 'thinking', text: '' }];
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, signedOut: null, showModel: false } });
    flushSync();
    expect(document.querySelector('[data-testid=thinking-part]')).not.toBeNull();
    message.parts.push({ type: 'tool', toolId: 'read', name: 'Read', input: {}, output: null, status: 'running' });
    flushSync();
    expect(document.querySelector('[data-testid=thinking-part]')).toBeNull();
    expect(document.querySelector('[data-kind=thinking]')).toBeNull();
    message.parts[0] = { type: 'thinking', text: '', startedAt: 1000, finishedAt: 1400 };
    flushSync();
    expect(document.querySelector('[data-testid=thinking-part]')).toBeNull();
    expect(document.querySelector('[data-testid=tool-group]')).toBeNull();
    message.parts[0] = { type: 'thinking', text: '', startedAt: 1000, finishedAt: 4500 };
    message.parts[1] = { type: 'tool', toolId: 'read', name: 'Read', input: {}, output: '', status: 'done', startedAt: 4600, finishedAt: 9000 };
    message.state = 'complete';
    flushSync();
    expect(document.querySelectorAll('.parts > .part')).toHaveLength(1);
    expect(document.querySelector('[data-testid=tool-group-elapsed]')?.textContent).toBe('8s');
    expect(document.querySelector('[data-testid=thinking-part]')).toBeNull();
    document.querySelector<HTMLButtonElement>('[data-testid=tool-group-toggle]')!.click();
    flushSync();
    expect(document.querySelector('[data-testid=thinking-elapsed]')?.textContent).toBe('3s');
    expect(document.querySelector('[data-testid=thinking-toggle] .caret')).toBeNull();
  } finally { store.detach(); client.close(); }
});

test('a running tool in an earlier message suppresses typing on the latest text', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const thread = store.openThread!;
    const previous = thread.messages.at(-1)!;
    previous.parts = [{ type: 'tool', toolId: 'read', name: 'Read', input: {}, output: null, status: 'running' }];
    thread.status = 'running';
    thread.messages.push({ ...previous, id: 'latest-text', state: 'streaming', parts: [{ type: 'text', text: 'Checking the result' }] });
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: thread.id,
      message: thread.messages.at(-1)!, signedOut: null, showModel: false, latestInTurn: true } });
    flushSync();
    expect(document.querySelector('[data-testid=paragraph-pending]')?.textContent).toBe('Checking the result');
    expect(document.querySelector('[data-testid=typing-indicator]')).toBeNull();
    if (previous.parts[0]?.type !== 'tool') throw new Error('missing tool');
    previous.parts[0].status = 'done';
    flushSync();
    expect(document.querySelector('[data-testid=typing-indicator]')).not.toBeNull();
  } finally { store.detach(); client.close(); }
});

test('hidden protocol text reserves no row and gains its row when visible text arrives', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const message = store.openThread!.messages.at(-1)!;
    message.state = 'complete';
    message.parts = [
      { type: 'thinking', text: '', startedAt: 1000, finishedAt: 2000 },
      { type: 'text', text: '[BOITE_GOAL_COMPLETE]' },
      { type: 'tool', toolId: 'read', name: 'Read', input: {}, output: '', status: 'done' }
    ];
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, signedOut: null, showModel: false } });
    flushSync();
    expect(document.querySelectorAll('.parts > .part')).toHaveLength(2);
    expect(document.querySelector('[data-kind=text]')).toBeNull();
    message.parts[1] = { type: 'text', text: 'Found the file.' };
    flushSync();
    expect(document.querySelectorAll('.parts > .part')).toHaveLength(3);
    expect(document.querySelector('[data-kind=text]')?.textContent).toContain('Found the file.');
  } finally { store.detach(); client.close(); }
});

test('a thread link in reasoning or a tool document starts from the machine and thread of the message, not the page hash', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  const opened = vi.spyOn(workspace, 'openThreadLink').mockResolvedValue();
  try {
    await store.connect(); await store.open('t-trace');
    const message = store.openThread!.messages.at(-1)!;
    message.parts = [
      { type: 'tool', toolId: 'plan', name: 'Plan', input: {}, output: 'ok', status: 'done', documents: [{ kind: 'markdown', title: null, text: 'Ask `boite/thr_tkw9n9qt4100rvq2jmg1`' }] },
      { type: 'text', text: 'Between.' },
      { type: 'thinking', text: 'Ask `thr_tkw9n9qt4100rvq2jmg2` first', startedAt: 0, finishedAt: 2000 },
    ];
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, signedOut: null, showModel: false } });
    flushSync();
    document.querySelector<HTMLButtonElement>('[data-testid=tool-toggle]')!.click();
    document.querySelector<HTMLButtonElement>('[data-testid=thinking-toggle]')!.click();
    flushSync();
    const links = document.querySelectorAll<HTMLAnchorElement>('[data-thread-address]');
    expect(links).toHaveLength(2);
    for (const link of links) {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
    }
    expect(opened.mock.calls).toEqual([[store, message.threadId, 'boite', 'thr_tkw9n9qt4100rvq2jmg1'], [store, message.threadId, null, 'thr_tkw9n9qt4100rvq2jmg2']]);
  } finally { opened.mockRestore(); store.detach(); client.close(); }
});

test('a permission is one element with its call: the card stands for the call while it waits, a shield on its line once answered', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const message = store.openThread!.messages.at(-1)!;
    message.state = 'streaming';
    message.parts = [
      { type: 'tool', toolId: 'ls', name: 'Bash', input: { command: 'ls -la' }, output: null, status: 'running', startedAt: 1000 },
      { type: 'permission', requestId: 'req-ls', toolName: 'Bash', decision: null }
    ];
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, signedOut: null, showModel: false } });
    flushSync();
    expect(document.querySelectorAll('.parts > .part')).toHaveLength(1);
    expect(document.querySelector('[data-testid=permission-card]')?.getAttribute('data-decision')).toBe('pending');
    expect(document.querySelector('[data-testid=tool-card]')).toBeNull();

    message.parts = [
      { type: 'tool', toolId: 'ls', name: 'Bash', input: { command: 'ls -la' }, output: 'total 0', status: 'done', startedAt: 1000, finishedAt: 7000 },
      { type: 'permission', requestId: 'req-ls', toolName: 'Bash', decision: 'allow' }
    ];
    flushSync();
    expect(document.querySelectorAll('.parts > .part')).toHaveLength(1);
    expect(document.querySelector('[data-testid=permission-card]')).toBeNull();
    expect(document.querySelectorAll('[data-testid=tool-card]')).toHaveLength(1);
    const shield = document.querySelector('[data-testid=tool-card] [data-testid=tool-permission]');
    expect(shield?.getAttribute('data-decision')).toBe('allow');
    expect(shield?.getAttribute('title')).toBe('Allowed by you');
  } finally { store.detach(); client.close(); }
});

test('a permission with no call of its name stays its own line inside the run', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const message = store.openThread!.messages.at(-1)!;
    message.state = 'complete';
    message.parts = [
      { type: 'tool', toolId: 'read', name: 'Read', input: { file_path: 'a.ts' }, output: '', status: 'done' },
      { type: 'permission', requestId: 'req-x', toolName: 'fake_tool', decision: 'deny' }
    ];
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, signedOut: null, showModel: false } });
    flushSync();
    expect(document.querySelectorAll('.parts > .part')).toHaveLength(1);
    document.querySelector<HTMLButtonElement>('[data-testid=tool-group-toggle]')!.click();
    flushSync();
    expect(document.querySelector('[data-testid=permission-card]')?.getAttribute('data-decision')).toBe('deny');
    expect(document.querySelector('[data-testid=tool-permission]')).toBeNull();
  } finally { store.detach(); client.close(); }
});
