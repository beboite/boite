import { afterEach, expect, test } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { FakeClient } from '../lib/fake-client';
import { Store } from '../lib/store.svelte';
import { strings } from '../lib/strings';
import { setLocaleSetting } from '../lib/i18n.svelte';
import MemoryRow from './MemoryRow.svelte';
import MessageList from './MessageList.svelte';

let mounted: ReturnType<typeof mount> | undefined;
afterEach(async () => { if (mounted) await unmount(mounted); mounted = undefined; await setLocaleSetting('en'); document.body.innerHTML = ''; localStorage.clear(); });

test.each([['en', 'thread-quota'], ['en', 'budget'], ['en', 'machine'], ['fr', 'thread-quota'], ['fr', 'budget'], ['fr', 'machine']] as const)('renders a %s %s kill with its process, size and crossed limit', async (locale, reason) => {
  await setLocaleSetting(locale);
  mounted = mount(MemoryRow, { target: document.body, props: { event: { threadId: 't', kind: 'killed', reason, limitBytes: 9728 * 1048576, state: 'critical', exe: 'C:\\bin\\cargo.exe', bytes: 2147483648, at: 1 } } });
  flushSync();
  const row = document.querySelector('[data-testid=memory-row]')!;
  expect(row.querySelector('.title')?.textContent).toBe(strings.resources.killTitle);
  expect(row.querySelector('p')?.textContent).toBe(strings.resources.killReason[reason](locale === 'fr' ? '9,5 Go' : '9.5 GB'));
  expect(row.querySelector('.process')?.textContent).toBe('cargo.exe');
  expect(row.querySelector('.size')?.textContent).toBe(locale === 'fr' ? '2,0 Go' : '2.0 GB');
  expect(row.textContent).not.toContain('C:\\bin');
});

test('unknown process and size are omitted', () => {
  mounted = mount(MemoryRow, { target: document.body, props: { event: { threadId: 't', kind: 'thread-cap', state: 'ok', at: 1 } } });
  flushSync(); expect(document.querySelector('.details')).toBeNull();
});

test.each(['en', 'fr'] as const)('renders a %s throttling notice with its limit and no stopped process', async (locale) => {
  await setLocaleSetting(locale);
  mounted = mount(MemoryRow, { target: document.body, props: { event: { threadId: 't', kind: 'throttled', limitBytes: 5120 * 1048576, bytes: 6144 * 1048576, state: 'ok', at: 1 } } });
  flushSync();
  const row = document.querySelector('[data-testid=memory-row]')!;
  expect(row.getAttribute('data-kind')).toBe('throttled');
  expect(row.querySelector('p')?.textContent).toBe(strings.resources.throttled(locale === 'fr' ? '5,0 Go' : '5.0 GB'));
  expect(row.querySelector('.title')).toBeNull();
  expect(row.querySelector('.details')).toBeNull();
});

test('a memory notice stays between the interrupted tool and later output in the same message', async () => {
  const client = new FakeClient({ delayMs: 0 }); const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const thread = store.openThread!;
    thread.memoryEvents = [{ threadId: thread.id, kind: 'killed', reason: 'machine', limitBytes: 3072 * 1048576, state: 'critical', exe: 'cargo.exe', at: 20 }];
    thread.messages = [{ id: 'interrupted', threadId: thread.id, turnId: 'turn', role: 'assistant', state: 'complete', createdAt: 10, parts: [
      { type: 'text', text: 'Before the interruption' },
      { type: 'tool', toolId: 'build', name: 'Bash', input: { command: 'cargo build' }, output: 'Stopped', status: 'error', startedAt: 15, finishedAt: 21 },
      { type: 'text', text: 'After the interruption' },
      { type: 'tool', toolId: 'retry', name: 'Bash', input: { command: 'cargo build -j 2' }, output: 'Done', status: 'done', startedAt: 30, finishedAt: 40 },
    ] }];
    mounted = mount(MessageList, { target: document.body, props: { store, threadId: thread.id, messages: thread.messages } });
    flushSync();
    const text = document.querySelector('[data-testid=timeline]')!.textContent!;
    expect(text.indexOf(strings.resources.killTitle)).toBeGreaterThan(text.indexOf('Before the interruption'));
    expect(text.indexOf(strings.resources.killTitle)).toBeLessThan(text.indexOf('After the interruption'));
  } finally { store.detach(); client.close(); }
});

test('live stops share a compact disclosure and stay at their boundary as the answer grows and reopens', async () => {
  const client = new FakeClient({ delayMs: 0 }); const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    const thread = store.openThread!;
    thread.memoryEvents = [];
    const message = thread.messages.at(-1)!;
    message.state = 'streaming'; message.parts = [{ type: 'text', text: 'Build started' }];
    mounted = mount(MessageList, { target: document.body, props: { store, threadId: thread.id, messages: thread.messages } });
    const at = Date.now();
    for (const [index, exe] of ['cargo.exe', 'rustc.exe', 'node.exe'].entries()) client.emitMemory({ threadId: thread.id, kind: 'killed', reason: 'machine', limitBytes: 3072 * 1048576, bytes: 100 * 1048576, exe, state: 'critical', at: at + index * 3000, anchor: { messageId: message.id, partIndex: 1 } });
    store.openThread!.messages.at(-1)!.parts = [...message.parts, { type: 'text', text: 'Build retried with fewer workers\n\n' }];
    flushSync();
    const row = document.querySelector('[data-testid=memory-row]')!;
    expect(document.querySelectorAll('[data-testid=memory-row]')).toHaveLength(1);
    expect(row.textContent).toContain(strings.resources.killCount(3));
    expect(row.querySelector('details')!.open).toBe(false);
    expect([...row.querySelectorAll('.process')].map(node => node.textContent)).toEqual(['cargo.exe', 'rustc.exe', 'node.exe']);
    const text = document.querySelector('[data-testid=timeline]')!.textContent!;
    expect(text.indexOf(strings.resources.killCount(3))).toBeLessThan(text.indexOf('Build retried'));
    row.querySelector<HTMLButtonElement>('.configure')!.click();
    expect(store.settingsTab).toBe('resources');
    expect(store.settingsSection?.id).toBe('limits');
    await store.open('t-trace'); flushSync();
    expect(document.body.textContent).toContain(strings.resources.killCount(3));
    expect(store.openThread!.memoryEvents?.find(event => event.at === at)?.anchor).toEqual({ messageId: message.id, partIndex: 1 });
  } finally { store.detach(); client.close(); }
});

test('thread history and live notices appear in the timeline and survive reopening', async () => {
  const client = new FakeClient({ delayMs: 0 }); const store = new Store(); store.attach(client);
  try {
    await store.connect(); await store.open('t-trace');
    expect((await client.call('threads.list', {})).find(thread => thread.id === 't-trace')).not.toHaveProperty('memoryEvents');
    mounted = mount(MessageList, { target: document.body, props: { store, threadId: 't-trace', messages: store.openThread!.messages } });
    flushSync();
    expect(document.querySelectorAll('[data-testid=memory-row]')).toHaveLength(1);
    client.emitMemory({ threadId: 't-trace', kind: 'budget', state: 'critical', at: Date.now() });
    flushSync(); expect(document.querySelectorAll('[data-testid=memory-row]')).toHaveLength(2);
    store.openThread!.messages.push({ id: 'after-memory', threadId: 't-trace', turnId: 'after-memory', role: 'user', parts: [{ type: 'text', text: 'Continue after the memory warning' }], state: 'complete', createdAt: Date.now() + 1 });
    flushSync();
    const notice = [...document.querySelectorAll('[data-testid=memory-row]')].at(-1)!;
    expect(notice.closest('[data-testid=timeline]')).not.toBeNull();
    expect(notice.closest('article')?.nextElementSibling?.textContent).toContain('Continue after the memory warning');
    await store.open('t-trace'); flushSync();
    expect(document.querySelectorAll('[data-testid=memory-row]')).toHaveLength(2);
  } finally { store.detach(); client.close(); }
});
