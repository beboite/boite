import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { TurnProgress } from '../lib/turn-progress.svelte';
import AssistantMessage from './AssistantMessage.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; document.body.innerHTML = ''; });

test('tools and reasoning arriving beside a text delta keep its unfinished paragraph hidden', async () => {
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
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, progress: new TurnProgress(() => store.openThread!.messages), signedOut: null, showModel: false } });
    flushSync();
    expect(document.querySelectorAll('[data-testid=paragraph]')).toHaveLength(1);
    expect(document.body.textContent).not.toContain('Still writing');
    const first = document.querySelector('[data-testid=paragraph]');
    if (message.parts[0]?.type !== 'text') throw new Error('missing text');
    message.parts[0].text += ' this paragraph';
    flushSync();
    expect(document.body.textContent).not.toContain('Still writing');
    message.parts[0].text += '.\n\n';
    flushSync();
    expect(document.querySelectorAll('[data-testid=paragraph]')).toHaveLength(2);
    expect(document.querySelector('[data-testid=paragraph]')).toBe(first);
  } finally { store.detach(); client.close(); }
});

test('a reasoning that never got any text disappears once the agent moves on', async () => {
  const client = new FakeClient({ delayMs: 0 });
  const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const message = store.openThread!.messages.at(-1)!;
    message.state = 'streaming';
    message.parts = [{ type: 'thinking', text: '' }];
    mounted = mount(AssistantMessage, { target: document.body, props: { store, threadId: message.threadId, message, progress: new TurnProgress(() => store.openThread!.messages), signedOut: null, showModel: false } });
    flushSync();
    expect(document.querySelector('[data-testid=thinking-part]')).not.toBeNull();
    message.parts.push({ type: 'tool', toolId: 'read', name: 'Read', input: {}, output: null, status: 'running' });
    flushSync();
    expect(document.querySelector('[data-testid=thinking-part]')).toBeNull();
  } finally { store.detach(); client.close(); }
});
