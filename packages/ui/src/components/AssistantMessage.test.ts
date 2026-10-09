import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
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
